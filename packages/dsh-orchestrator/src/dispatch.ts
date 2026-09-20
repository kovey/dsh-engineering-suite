/**
 * Autonomous stage dispatch: entering a stage hands the work to a child agent.
 *
 * `orchestrate start|advance|rerun|resume` normally end with "now do the work" —
 * the model then either works in its own context or calls `team_delegate`. With
 * `autoDispatch.enabled`, the orchestrator dispatches the child ITSELF on stage
 * entry, so a pipeline runs without the model having to remember to delegate.
 *
 * What this module refuses to do is as important as what it does:
 *
 *  - **Dispatch is not settlement.** A child finishing says nothing about the
 *    gate. The stage stays `entered`, `advance` still needs its verdict, and
 *    `autoAdvance` still decides automatic transitions.
 *  - **Least privilege comes from the role.** When the stage declares a role and
 *    `dsh-role-guard` exposes its service, the role's tool filter and persona are
 *    used — the same resolver `team_delegate` uses. The configured `toolFilter`
 *    is only the fallback for deployments without role files.
 *  - **Failure is reported, never fatal.** A child that fails, times out or gets
 *    cancelled leaves the stage entered with the reason recorded in the artifact
 *    and in the tool result; the model can still do the work itself.
 *
 * @module dsh-orchestrator/dispatch
 */

import path from 'node:path'
import { formatTime, writeTextAtomic, type AgentLike, type MissionRecord } from 'dsh-eng-core'
import type { OrchestratorConfig } from './config.js'
import { describeStageRoute, resolveStageRoute, type StageConfig, type StageRoute } from './pipeline.js'

/** The role-guard service, as much of it as this module uses. */
export interface RoleGuardLike {
    plan(request: { role: string; cwd?: string; agent?: AgentLike }): {
        persona: string
        mode?: string
        toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
        dropped?: readonly string[]
        tools?: readonly string[]
        skills?: readonly string[]
        route?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
    }
    /**
     * Record the role for the child's session.
     *
     * Not optional in practice: the skill whitelist is enforced by looking this
     * record up for the child, so skipping it would let an auto-dispatched child
     * load skills its role forbids. A missing service means no skill
     * enforcement at all, which is reported.
     */
    bind?(request: { role: string; sessionId: string; cwd?: string; agent?: AgentLike }): unknown
}

/** Everything the dispatcher needs from the plugin. */
export interface DispatchDeps {
    config: OrchestratorConfig
    subagents: () => SubagentsLike | undefined
    roleGuard: () => RoleGuardLike | undefined
    /** Where a stage artifact lives, for the child's transcript file. */
    stagesDir: (cwd: string, missionId: string) => string
}

/** What happened, for the artifact and the tool result. */
export interface DispatchOutcome {
    /** `false` when this stage is not dispatched at all. */
    dispatched: boolean
    /** One-line summary for the caller's report. */
    note?: string
    /** Set when the child ran and produced text. */
    runId?: string
    outputFile?: string
    stopReason?: string
    /** Set when the dispatch failed (child error, timeout, cancellation). */
    error?: string
    /** The attempt this dispatch belongs to (for the transcript name). */
    attempt?: number
    /** The route the child actually ran on (the same value the ledger stores). */
    route?: StageRoute
    /**
     * Who decided the child's rights (its role), and what the deployment could
     * not give it. Shown in the report: "the child had these tools" is exactly
     * the kind of thing that should not be inferred from configuration.
     */
    roleNote?: string
}

/**
 * Whether this stage is dispatched on entry.
 *
 * A stage's own declaration wins over the configured id list, so a pipeline can
 * opt a stage in (`autoDispatch: true`) or out (`false`) regardless of the list.
 */
export function shouldDispatch(config: OrchestratorConfig, stage: StageConfig): boolean {
    if (!config.autoDispatch.enabled) return false
    if (stage.autoDispatch === true) return true
    if (stage.autoDispatch === false) return false
    return config.autoDispatch.stages.includes(stage.id)
}

/** The child's instructions: the stage's task, the mission context, the rules. */
export function dispatchPrompt(
    stage: StageConfig,
    mission: MissionRecord,
    context: { specPath?: string; gate: string; rollback?: string; extra?: string },
): string {
    return [
        `你是「${mission.title}」这个任务在阶段 \`${stage.id}\` 的执行者。`,
        '',
        `## 本阶段要做什么`,
        stage.prompt,
        '',
        '## 上下文',
        `- mission：${mission.id}（工作区 ${mission.cwd}）`,
        `- 状态：${mission.status}；本阶段是 ${stage.id}`,
        ...(context.specPath === undefined ? [] : [`- 已批准的规格：${context.specPath}（先读它，验收标准与文件边界都在里面）`]),
        `- 本阶段的**离开门禁**：${context.gate}`,
        ...(context.rollback === undefined ? [] : [`- 门禁不通过会回退到：${context.rollback}`]),
        ...(context.extra === undefined ? [] : ['', context.extra]),
        '',
        '## 规则',
        '1. **只做本阶段的事**：不要跳到别的阶段，不要为了"看起来完成"而伪造产物。',
        '2. **不要调用 orchestrate**：阶段推进由父会话按门禁决定；你完成了就如实汇报。',
        '3. **不确定就说不确定**：做不到、被拒绝、缺依赖，直接讲清楚，并给出你试过什么。',
        '4. 结束时用简短条目汇报：做了什么、产物在哪（文件路径）、验证命令与结果、遗留问题。',
    ].join('\n')
}

/** Bound one child run so a stuck stage cannot wedge the tool call. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), Math.max(1_000, timeoutMs))
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/**
 * Dispatch the stage's work to a child agent.
 *
 * @param deps - config plus the subagent and role-guard seams.
 * @param input - the stage, the mission, the workspace and the caller's signal.
 * @returns what happened; never throws, so a failing child cannot break entry.
 */
export async function dispatchStage(
    deps: DispatchDeps,
    input: {
        stage: StageConfig
        mission: MissionRecord
        cwd: string
        agent?: AgentLike
        signal?: AbortSignal
        /** Stage attempt, used to name the transcript without collisions. */
        attempt?: number
        /** Extra context for the prompt (e.g. the spec path). */
        extra?: string
    },
): Promise<DispatchOutcome> {
    const { stage, mission, cwd } = input
    if (!shouldDispatch(deps.config, stage)) return { dispatched: false }

    // BUG-5: `toolFilter: { allow: [] }` used to be dropped by the config parser
    // and then handed to the provider as NO filter — the child would inherit the
    // parent's entire tool surface. An empty whitelist is a whitelist of nothing;
    // an empty DENY list, on the other hand, is meaningful (deny nothing) and is
    // merged with the role's own deny list by the role-guard service.
    const dispatchFilter = deps.config.autoDispatch.toolFilter
    if (dispatchFilter?.allow !== undefined && dispatchFilter.allow.length === 0) {
        return {
            dispatched: false,
            note: '自动派发未执行：autoDispatch.toolFilter.allow 为空数组（等于"不给任何工具"）。请删掉 allow（用 deny 表达减法），或列出工具名。',
        }
    }

    if (input.signal?.aborted === true) {
        return { dispatched: false, note: '自动派发未执行：调用方已取消（signal 已 abort）' }
    }

    const subagents = deps.subagents()
    if (subagents === undefined) {
        return {
            dispatched: false,
            note: `自动派发未执行：宿主没有装配子代理服务（ctx.subagents）。下一步：手动执行本阶段，或装配 subagents provider。`,
        }
    }

    // The role decides rights; the config is the fallback for role-less setups.
    let persona: string | undefined
    let toolFilter = dispatchFilter
    /**
     * The child must not be able to re-enter the pipeline.
     *
     * `orchestrate` in a child's hands means recursion: the child calls
     * `orchestrate start`, that re-enters the stage, and my own auto-dispatch
     * spawns a grandchild — measured live as ~800 sessions from ONE entry. The
     * stage prompt says "don't call orchestrate", but prose is not a permission
     * model, so the tool is removed structurally.
     */
    const withoutOrchestrate = (filter: { allow?: readonly string[]; deny?: readonly string[] } | undefined) => {
        if (filter?.allow !== undefined) {
            return { allow: filter.allow.filter((name) => name !== 'orchestrate'), deny: [...(filter.deny ?? []), 'orchestrate'] }
        }
        return { deny: [...new Set([...(filter?.deny ?? []), 'orchestrate'])] }
    }
    let route = resolveStageRoute(stage, deps.config.routing)
    // Never empty: "who decided the child's rights" must be answerable from the
    // report alone, including on the role-less path.
    let roleNote = [
        `已强制排除 orchestrate、maxDepth=${deps.config.autoDispatch.maxDepth}`,
        '无角色声明',
        toolFilter === undefined
            ? '未设工具过滤（子代理继承父会话工具面）'
            : `沿用宿主 autoDispatch.toolFilter${toolFilter.allow === undefined ? '（仅 deny）' : `（allow ${toolFilter.allow.join('/')}）`}`,
    ].join('；')
    let roleGuardService: RoleGuardLike | undefined
    if (stage.role !== undefined) {
        const service = deps.roleGuard()
        roleGuardService = service
        if (service === undefined) {
            roleNote = `（阶段声明了角色 ${stage.role}，但 dsh-role-guard 没有提供 service：本次用配置的工具过滤/路由）`
        } else {
            try {
                const plan = service.plan({ role: stage.role, cwd, ...(input.agent === undefined ? {} : { agent: input.agent }) })
                persona = plan.persona === '' ? undefined : plan.persona
                // A role that declares a filter decides the child's rights. A role
                // that declares NOTHING keeps the deployment's dispatch filter —
                // otherwise `tools: []` (documented as "no restriction") would
                // silently widen an auto-dispatched child past the host's ceiling.
                const declared = plan.toolFilter
                const meaningful = declared !== undefined && ((declared.allow?.length ?? 0) > 0 || (declared.deny?.length ?? 0) > 0)
                if (meaningful) toolFilter = declared
                // Merge field by field: a role that only sets reasoningEffort or
                // maxTokens must not lose them just because it names no model.
                if (plan.route !== undefined) {
                    const planned = plan.route
                    const hasPlanned = ['provider', 'model', 'reasoningEffort', 'maxTokens'].some(
                        (key) => (planned as Record<string, unknown>)[key] !== undefined,
                    )
                    if (hasPlanned) {
                        // `source: 'role'`: the label must name where the route
                        // came from, and the ledger (not only the report) has to
                        // record the route the child actually ran on.
                        route = {
                            ...route,
                            ...(planned.provider === undefined ? {} : { provider: planned.provider }),
                            ...(planned.model === undefined ? {} : { model: planned.model }),
                            ...(planned.reasoningEffort === undefined ? {} : { reasoningEffort: planned.reasoningEffort }),
                            ...(planned.maxTokens === undefined ? {} : { maxTokens: planned.maxTokens }),
                            source: 'role',
                        }
                    }
                }
                const dropped = plan.dropped ?? []
                const skills = plan.skills ?? []
                roleNote = [
                    `角色 ${stage.role}`,
                    meaningful
                        ? `工具白名单 ${declared?.allow?.join('/') ?? '(仅 deny)'}`
                        : plan.toolFilter === undefined
                          ? '角色未声明工具过滤，沿用宿主 autoDispatch.toolFilter'
                          : '角色的过滤为空（等同不过滤），沿用宿主 autoDispatch.toolFilter',
                    ...(dropped.length === 0 ? [] : [`本部署缺少 ${dropped.join('/')}，已从白名单剔除`]),
                    skills.length === 0 ? '技能不限' : `技能白名单 ${skills.join('/')}`,
                ].join('；')
            } catch (error) {
                return {
                    dispatched: false,
                    note: `自动派发未执行：角色 ${stage.role} 无法解析（${(error as Error).message}）`,
                }
            }
        }
    }

    const prompt = dispatchPrompt(stage, mission, {
        ...(mission.specPath === undefined ? {} : { specPath: path.isAbsolute(mission.specPath) ? mission.specPath : path.join(cwd, mission.specPath) }),
        gate: describeGateText(stage),
        ...(input.extra === undefined ? {} : { extra: input.extra }),
    })

    let child: Awaited<ReturnType<SubagentsLike['start']>>
    try {
        child = await subagents.start(deps.config.autoDispatch.provider, {
            label: `${stage.id} · ${mission.title}`,
            prompt: [{ type: 'text', text: prompt }],
            parent: input.agent as never,
            signal: input.signal ?? new AbortController().signal,
            toolFilter: withoutOrchestrate(toolFilter),
            ...(persona === undefined ? {} : { persona }),
            maxDepth: deps.config.autoDispatch.maxDepth,
            ...(route.model === undefined && route.provider === undefined
                ? {}
                : {
                      agentOptions: {
                          ...(route.provider === undefined ? {} : { provider: route.provider }),
                          ...(route.model === undefined ? {} : { model: route.model }),
                          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
                          ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
                      },
                  }),
        })
    } catch (error) {
        return {
            dispatched: true,
            error: `派发失败（provider ${deps.config.autoDispatch.provider}）：${(error as Error).message}`,
        }
    }
    // A provider that resolves to nothing usable must not take the tool call
    // down with a TypeError (BUG-6).
    const runId = typeof (child as { id?: unknown } | null)?.id === 'string' ? (child as { id: string }).id : undefined
    if (runId === undefined || child === null || child === undefined) {
        return { dispatched: true, error: '派发失败：provider 返回了不可用的运行句柄（没有 id）' }
    }

    // The child exists now: bind its role BEFORE it can load a skill. Without
    // this record the skill gate has no oracle and the child's skill whitelist
    // is silently unlimited.
    let bindNote: string | undefined
    if (stage.role !== undefined && roleGuardService?.bind !== undefined) {
        try {
            const binding = roleGuardService.bind({
                role: stage.role,
                sessionId: runId,
                cwd,
                ...(input.agent === undefined ? {} : { agent: input.agent }),
            })
            bindNote = binding === undefined ? '⚠️ 角色绑定未写入：该子会话没有技能白名单约束' : undefined
        } catch (error) {
            bindNote = `⚠️ 角色绑定失败（${(error as Error).message}）：该子会话没有技能白名单约束`
        }
    } else if (stage.role !== undefined) {
        bindNote = '⚠️ role-guard 服务没有 bind 能力：该子会话没有技能白名单约束'
    }

    const header = [
        `# 阶段 ${stage.id} 的自动派发记录`,
        '',
        `- mission：${mission.id}（${mission.title}）`,
        `- 子代理运行：${runId}`,
        `- 角色：${stage.role ?? '(未声明)'}${roleNote}`,
        `- 模型：${describeStageRoute(route)}`,
        `- 开始：${formatTime(Date.now())}`,
        '',
        '> 派发不等于结算：本阶段的门禁仍需通过，`advance` 仍由父会话或 autoAdvance 决定。',
        '',
        '## 子代理输出',
        '',
    ].join('\n')

    let text = ''
    let stopReason = 'unknown'
    let error: string | undefined
    try {
        const settled = await withDeadline(
            child.result,
            deps.config.autoDispatch.timeoutMs,
            `阶段 ${stage.id} 的子代理`,
        )
        stopReason = typeof settled.stopReason === 'string' ? settled.stopReason : 'unknown'
        text = (settled.output ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('\n')
            .trim()
        if (text === '') {
            error = `子代理没有返回文本${typeof settled.diagnostic === 'string' ? `（${settled.diagnostic}）` : ''}`
        }
    } catch (cause) {
        error = (cause as Error).message
    } finally {
        try {
            await child.dispose?.()
        } catch {
            // disposal must never mask the dispatch outcome
        }
    }

    // GAP-7: the file name carries the attempt AND the run id, so a re-dispatch
    // (resume/rerun) can never destroy an earlier child's transcript.
    let dir = ''
    try {
        dir = deps.stagesDir(cwd, mission.id)
    } catch {
        dir = ''
    }
    const outputFile =
        dir === ''
            ? ''
            : path.join(dir, `${stage.id}-dispatch-a${input.attempt ?? 0}-${runId}.md`)
    let written: string | undefined
    try {
        if (outputFile === '') throw new Error('阶段目录不可用（stores.for(cwd) 失败）')
        writeTextAtomic(outputFile, `${header}${text === '' ? '(空)' : text}\n\n${error === undefined ? `- 结束：${formatTime(Date.now())}（stopReason=${stopReason}）` : `- 失败：${error}`}\n`)
        written = outputFile
    } catch (cause) {
        error = `${error === undefined ? '' : `${error}；`}记录落盘失败（${(cause as Error).message}）`
    }
    return {
        dispatched: true,
        runId,
        attempt: input.attempt,
        // The route the child ACTUALLY ran on (BUG-4: the artifact must not
        // disagree with the child).
        route: { ...route },
        ...(written === undefined ? {} : { outputFile: written }),
        stopReason,
        ...(roleNote === '' ? {} : { roleNote }),
        ...(bindNote === undefined ? {} : { error: error === undefined ? bindNote : `${error}；${bindNote}` }),
        ...(error === undefined ? {} : { error }),
        note: error === undefined ? undefined : `自动派发未产出可用结果：${error}`,
    }
}

/** Render the stage's gate requirement as text (kept local: no gate evaluation here). */
function describeGateText(stage: StageConfig): string {
    const phase = stage.gate.phase === 'entry' ? '进入时' : '离开时'
    return `${phase}要求：${stage.gate.label}${stage.gate.verdict === 'pass-or-warn' ? '（软门禁：警告也放行）' : ''}`
}

/** Minimal structural view of `ctx.subagents` (mirrors role-guard's). */
export interface SubagentsLike {
    start: (
        provider: string,
        request: {
            label?: string
            prompt: { type: 'text'; text: string }[]
            parent: never
            signal: AbortSignal
            toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
            persona?: string
            agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
            maxDepth?: number
        },
    ) => Promise<{
        id: string
        result: Promise<{ stopReason?: string; output?: { type?: string; text?: string }[]; diagnostic?: string }>
        dispose?: () => Promise<void>
    }>
}

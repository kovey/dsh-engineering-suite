/**
 * The orchestration sequence: `orchestrate` and the six actions behind it
 * (docs.md §4.2 — 路径一 配置驱动流水线 + 路径二 条件边/回退/熔断).
 *
 * Every decision here reads durable facts from the mission store: which
 * plugins are mounted (probes), what the mission record says (spec approval,
 * test design, gate records, receipts) and how many attempts a stage already
 * burned. Model prose only ever *enters* the record as a `summary`/`verdict`;
 * it never decides a transition.
 *
 * @module dsh-orchestrator/sequence
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    formatTime,
    sessionIdOf,
    type AgentLike,
    type MissionRecord,
    type MissionStore,
    type MissionStoreRegistry,
    type StageResult,
} from 'dsh-eng-core'
import type { OrchestratorConfig } from './config.js'
import { dispatchStage, shouldDispatch, type DispatchDeps, type DispatchOutcome } from './dispatch.js'
import { evaluateGate, type Verdict } from './gates.js'
import {
    describeGate,
    describeStageRoute,
    isGated,
    resolveStageRoute,
    roleInstruction,
    rollbackTargetOf,
    stageById,
    successorOf,
} from './pipeline.js'
import { buildRetrospective, ledgerPath, persistRetrospective, readLedger, renderHistory, type Retrospective } from './retrospective.js'
import type { StageConfig } from './pipeline.js'
import { describeMount, refusalForMissingPlugins, requiredPluginStates, type PluginProbe } from './probes.js'

const TEXT_OUTPUT = { type: 'string' } as const

/**
 * One stage result plus the role the stage declares.
 *
 * `dsh-eng-core`'s `StageResult` is the shared contract and stays untouched
 * (other plugins read it); the role is written as an extra field of the same
 * JSON artifact, so `stages/<id>.json` is self-describing for the auditor
 * without changing the shared type.
 */
type StageResultWithRole = StageResult & { role?: string }

/** The optional `role` field of a stage result (spreadable, so a role-less stage adds nothing). */
function roleField(stage: StageConfig): { role?: string } {
    return stage.role === undefined ? {} : { role: stage.role }
}

/**
 * The model route this stage declares, resolved through the host's routing
 * table. Recorded in every stage artifact so "which model ran this step" is
 * answerable from the ledger, not from the config of the day.
 */
function routeField(deps: SequenceDeps, stage: StageConfig): { difficulty?: StageConfig['difficulty']; route?: StageResult['route'] } {
    const route = resolveStageRoute(stage, deps.config.routing)
    return {
        ...(stage.difficulty === undefined ? {} : { difficulty: stage.difficulty }),
        ...(route.source === 'none' ? {} : { route: { ...route } }),
    }
}


/** The attempt budget of one stage (`config.defaultMaxAttempts` when unset). */
function budgetOf(deps: SequenceDeps, stage: StageConfig): number {
    return stage.maxAttempts ?? deps.config.defaultMaxAttempts
}

/** Every action the single tool exposes. */
export type OrchestrateAction = 'start' | 'status' | 'advance' | 'rerun' | 'resume' | 'stages' | 'retro' | 'unblock'

const ACTIONS: readonly OrchestrateAction[] = ['start', 'status', 'advance', 'rerun', 'resume', 'stages', 'retro', 'unblock']

/** Arguments of `orchestrate`. */
export interface OrchestrateArgs {
    action: OrchestrateAction
    missionId?: string
    stageId?: string
    summary?: string
    verdict?: Verdict
}

/** Everything the handlers read at call time. */
export interface SequenceDeps {
    config: OrchestratorConfig
    /** Autonomous stage dispatch (see `dispatch.ts`); absent = never dispatch. */
    dispatch?: DispatchDeps
    stores: MissionStoreRegistry
    /**
     * Build the probe table for one call. The tool registry is scope-aware, so
     * the probes are resolved against the calling agent every time instead of
     * once at assembly.
     */
    probesFor: (agent: AgentLike | undefined) => Record<string, PluginProbe>
}

/** The resolved call context (mission, store, workspace). */
interface CallContext {
    store: MissionStore
    agent: AgentLike | undefined
    cwd: string
    sessionId: string | undefined
    mission: MissionRecord | undefined
    /**
     * The caller's cancellation signal (BUG-3).
     *
     * Without it an auto-dispatched child cannot be cancelled: the orchestrator
     * used to hand the provider a fresh `AbortController`, so a cancelled turn
     * kept a child running (and spending tokens) to completion.
     */
    signal?: AbortSignal
}

/** The english model-facing description of `orchestrate`. */
export const ORCHESTRATE_DESCRIPTION =
    'Drive the engineering stage pipeline of the current mission (dsh-orchestrator): list stages, start, report status, advance, rerun or resume. Stage gates are deterministic — a stage cannot be entered while a plugin it requires is not mounted, a stage whose exit gate fails rolls back to its onFail stage instead of advancing, and a stage that exceeds maxAttempts blocks the mission (circuit breaker). Always call this tool to move between stages instead of assuming the next step.'

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/**
 * Resolve the mission a call applies to.
 *
 * `explicitId` wins, then the session (or delegating parent) binding. There is
 * deliberately no "newest mission in the workspace" fallback: driving another
 * session's mission from here would be a silent cross-session action, so an
 * unbound session is told to pass `missionId` (or start its own mission).
 */
function callContext(deps: SequenceDeps, exec: unknown, explicitId?: string): CallContext {
    const agent = agentOf(exec)
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    const store = deps.stores.for(cwd)
    const mission = store.resolveForAgent(agent, {
        ...(explicitId === undefined ? {} : { explicitId }),
    })
    const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
    return { store, agent, cwd, sessionId: sessionIdOf(agent), mission, ...(signal === undefined ? {} : { signal }) }
}

/** The mission id arg object, only when the caller supplied one. */
function missionArg(args: OrchestrateArgs): { explicitId?: string } {
    return args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }
}

/** `(mission <id>)` for the report header. */
function missionTag(mission: MissionRecord | undefined): string {
    return mission === undefined ? '(当前工作区没有 mission)' : `mission ${mission.id}（${mission.title}）`
}

/** Truncate a cell for the status table. */
function short(value: string | undefined, max = 46): string {
    if (value === undefined || value === '') return '-'
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** The stage the mission currently sits on, when the record agrees. */
function currentStageId(deps: SequenceDeps, mission: MissionRecord | undefined): string | undefined {
    if (mission?.stage !== undefined && stageById(deps.config.stages, mission.stage) !== undefined) return mission.stage
    return undefined
}

/** The persisted result of a stage, when any. */
function stageResultOf(store: MissionStore, missionId: string, stageId: string): StageResult | undefined {
    try {
        return store.readStageResult(missionId, stageId)
    } catch {
        return undefined
    }
}

/** Every persisted result, never throwing (a corrupt artifact is no results). */
function stageResultsOf(store: MissionStore, missionId: string): StageResult[] {
    try {
        return store.listStageResults(missionId)
    } catch {
        return []
    }
}

/**
 * The entry time a stage keeps: re-entering an already-`entered` record is a
 * resume (断点恢复), so the original `enteredAt` — and therefore the freshness
 * window the exit gates compare against — must not be reset.
 */
function entryTimeOf(current: StageResult | undefined): number | undefined {
    return current !== undefined && current.state === 'entered' ? current.enteredAt : undefined
}

/** The next attempt number for a stage: an in-flight stage keeps its number. */
function nextAttempt(current: StageResult | undefined): number {
    if (current !== undefined && current.state === 'entered') return current.attempt
    return (current?.attempt ?? 0) + 1
}

/**
 * Record a stage entry, then dispatch its work when the configuration says so.
 *
 * Keeping the dispatch inside the entry path is the point of the feature: with
 * `autoDispatch` on, a pipeline no longer depends on the model remembering to
 * call `team_delegate`. The dispatch NEVER settles the stage — the gate and
 * `autoAdvance` are untouched — and a failed dispatch is reported, not fatal.
 */
async function recordAndDispatch(
    deps: SequenceDeps,
    ctx: CallContext,
    stage: StageConfig,
    attempt: number,
    summary?: string,
    keepEntryTime?: number,
    /** Why this entry must not dispatch (e.g. its entry gate is unmet). */
    skipReason?: string,
): Promise<{ recorded: ReturnType<typeof recordEntered>; dispatch?: DispatchOutcome }> {
    // The record as the LEDGER has it: `recordEntered` builds a fresh object, so
    // the dispatch recorded by an earlier entry of the same attempt is only
    // visible here (that is what makes `resume` idempotent).
    let persisted: StageResult | undefined
    try {
        persisted = ctx.store.readStageResult(ctx.mission?.id ?? '', stage.id)
    } catch {
        persisted = undefined
    }
    const recorded = recordEntered(deps, ctx, stage, attempt, summary, keepEntryTime)
    // Re-recording an entry must not erase what the entry already produced: the
    // artifact is the ledger, and `dispatch`/`route` belong to it.
    if (persisted !== undefined && persisted.enteredAt === recorded.result.enteredAt) {
        recorded.result.dispatch = persisted.dispatch ?? recorded.result.dispatch
        recorded.result.route = persisted.route ?? recorded.result.route
        try {
            ctx.store.writeStageResult(ctx.mission?.id ?? '', recorded.result)
        } catch {
            // best effort: the entry record itself is already on disk
        }
    }
    if (deps.dispatch === undefined) return { recorded }
    if (skipReason !== undefined) {
        return { recorded, dispatch: { dispatched: false, note: `自动派发未执行：${skipReason}` } }
    }
    // GAP-7: re-entering the SAME attempt (that is what `resume` does) must not
    // spawn a second child — that would double the token spend and overwrite the
    // first child's transcript. A settlement starts a new attempt, so it is not
    // affected.
    // Identity of an entry = its `enteredAt` (kept across `resume`, fresh for
    // `rerun`/`advance`). Comparing attempts was not enough: a repeated `start`
    // bumps the attempt counter, which let it dispatch again and again.
    const sameEntry = persisted !== undefined && persisted.enteredAt === recorded.result.enteredAt
    const already = sameEntry ? persisted?.dispatch : undefined
    if (already !== undefined) {
        return {
            recorded,
            dispatch: {
                dispatched: false,
                note: `本阶段第 ${attempt} 次进入已经派发过（run ${already.runId ?? '(未知)'}）：resume 不会重复派发。需要重跑请用 orchestrate({ action: "rerun" })。`,
            },
        }
    }
    const dispatch = await dispatchStage(deps.dispatch, {
        stage,
        mission: recorded.mission,
        cwd: ctx.cwd,
        ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        attempt,
    })
    if (dispatch.dispatched) {
        // Record it in the ledger, not only in the report: "what worked this
        // stage, on which model, and did it produce anything" must be readable
        // from `.dsh/missions/<id>/stages/<stage>.json` alone.
        try {
            const current = ctx.store.readStageResult(recorded.mission.id, stage.id) ?? recorded.result
            ctx.store.writeStageResult(recorded.mission.id, {
                ...current,
                dispatch: {
                    ...(dispatch.runId === undefined ? {} : { runId: dispatch.runId }),
                    ...(dispatch.stopReason === undefined ? {} : { stopReason: dispatch.stopReason }),
                    ...(dispatch.outputFile === undefined ? {} : { outputFile: dispatch.outputFile }),
                    ...(dispatch.error === undefined ? {} : { error: dispatch.error }),
                    ...(stage.role === undefined ? {} : { role: stage.role }),
                    ...(dispatch.attempt === undefined ? {} : { attempt: dispatch.attempt }),
                    at: Date.now(),
                },
                // BUG-4: the artifact must name the route the child actually ran
                // on (the role's route can differ from the stage's difficulty map).
                ...(dispatch.route === undefined ? {} : { route: dispatch.route }),
            })
        } catch (error) {
            dispatch.note = `${dispatch.note === undefined ? '' : `${dispatch.note}；`}阶段工件未写入派发记录（${(error as Error).message}）`
        }
    }
    return { recorded, dispatch }
}

/** The dispatch lines appended to an entry report (`[]` when nothing happened). */
function dispatchLines(outcome: DispatchOutcome | undefined): string[] {
    if (outcome === undefined || !outcome.dispatched) {
        return outcome?.note === undefined ? [] : ['', `⚠️ ${outcome.note}`]
    }
    return [
        '',
        '### 已自动派发本阶段',
        '',
        ...(outcome.runId === undefined ? [] : [`- 子代理运行：${outcome.runId}（stopReason=${outcome.stopReason ?? 'unknown'}）`]),
        ...(outcome.roleNote === undefined ? [] : [`- 权限来源：${outcome.roleNote}`]),
        ...(outcome.outputFile === undefined ? [] : [`- 完整输出：${outcome.outputFile}`]),
        ...(outcome.error === undefined ? ['- 结果：子代理已返回，请阅读其汇报'] : [`- ⚠️ 未产出可用结果：${outcome.error}`]),
        '- 派发**不结算**本阶段：门禁仍需通过，推进仍用 `orchestrate({ action: "advance" })`。',
    ]
}

/**
 * Write one entry record and point the mission at the stage.
 * @returns the persisted record (with the attempt number) and the file path.
 */
function recordEntered(
    deps: SequenceDeps,
    ctx: CallContext,
    stage: StageConfig,
    attempt: number,
    summary?: string,
    /** Re-entering an already-`entered` record (resume): keep its entry time. */
    keepEntryTime?: number,
): { result: StageResult; file: string; mission: MissionRecord } {
    const now = keepEntryTime ?? Date.now()
    const missionId = ctx.mission?.id ?? ''
    const result: StageResultWithRole = {
        stageId: stage.id,
        attempt,
        state: 'entered',
        enteredAt: now,
        ...(summary === undefined || summary === '' ? {} : { summary }),
        ...roleField(stage),
        ...routeField(deps, stage),
    }
    const file = ctx.store.writeStageResult(missionId, result)
    const implied = missionStatusFor(stage.id)
    // Roles are recorded as a SET of the roles this mission has used (the record
    // the reviewer reads afterwards); the *current* stage's role is what the
    // stage artifact and the stage prompt carry. `dsh-role-guard` decides what a
    // role may do — this is a declaration, not a grant.
    const roles = stage.role === undefined ? undefined : [...new Set([...(ctx.mission?.roles ?? []), stage.role])]
    const mission =
        ctx.store.update(missionId, () => ({
            stage: stage.id,
            ...(implied === undefined ? {} : { status: implied }),
            ...(roles === undefined ? {} : { roles }),
        })) ?? (ctx.mission as MissionRecord)
    if (ctx.sessionId !== undefined) ctx.store.bindSession(ctx.sessionId, missionId, stage.id)
    return { result, file, mission }
}

/**
 * The mission status a stage entry implies.
 *
 * Deliberately state-based rather than id-based so a user pipeline still gets
 * a meaningful status: the delivery stage is the only one that implies a
 * finished mission (`delivered` is set when it *passes*, in `advance`), and a
 * stage guarded by a quality/evidence gate is the verification stage.
 */
function missionStatusFor(stageId: string): MissionRecord['status'] | undefined {
    if (stageId === 'implement') return 'implementing'
    if (stageId === 'quality-verify') return 'verified'
    if (stageId === 'spec-approve') return 'spec-approved'
    return undefined
}

/** The standard stage header every entry response starts with. */
function stageHeader(
    deps: SequenceDeps,
    probes: Record<string, PluginProbe>,
    mission: MissionRecord,
    stage: StageConfig,
    attempt: number,
    enteredAt: number,
): string[] {
    const states = requiredPluginStates(stage.requiredPlugins, probes)
    const lines = [
        `阶段：${stage.id}（第 ${attempt} 次进入，最多 ${budgetOf(deps, stage)} 次；进入时间 ${formatTime(enteredAt)}）`,
        `任务：${stage.prompt}`,
        `门禁：${describeGate(stage.gate)}`,
        `回退目标：${rollbackTargetOf(deps.config.stages, stage) ?? '(无：首阶段，失败即停)'}`,
    ]
    const role = roleInstruction(stage)
    if (role !== undefined) {
        // The orchestrator declares the role; dsh-role-guard is what makes it
        // real (persona + tool whitelist), so the text names the exact call.
        lines.push(`角色：${stage.role} —— ${role}（角色定义与工具白名单由 dsh-role-guard 执行）`)
    }
    const route = resolveStageRoute(stage, deps.config.routing)
    if (route.source !== 'none' || stage.difficulty !== undefined) {
        // Declaration, like the role: the orchestrator cannot change the
        // session's model, so it names the route and the call that applies it.
        const target =
            route.model === undefined
                ? undefined
                : `${route.provider === undefined ? '' : `${route.provider}/`}${route.model}`
        const hint =
            target === undefined
                ? '（宿主还没有为这个难度配置 routing 映射，沿用会话默认模型）'
                : `请通过 team_delegate({ role: "${stage.role ?? '<角色>'}", model: "${target}"${route.reasoningEffort === undefined ? '' : `, reasoningEffort: "${route.reasoningEffort}"`}, ... }) 派发本阶段工作（dsh-role-guard 按调用覆盖模型）。`
        lines.push(`模型：${describeStageRoute(route)}${hint === '' ? '' : ` —— ${hint}`}`)
    }
    if (stage.autoAdvance === true && isGated(stage.gate)) {
        lines.push(`自动推进：已启用（宿主声明 autoAdvance；本阶段门禁通过时，本轮结束会自动结算并进入下一阶段）`)
    }
    if (states.length === 0) {
        lines.push('所需插件：无')
    } else {
        lines.push('所需插件：')
        for (const state of states) {
            lines.push(`- ${state.plugin}：${describeMount(probes[state.plugin], state.plugin)}`)
        }
    }
    lines.push(`阶段结果落盘：.dsh/missions/${mission.id}/stages/${stage.id}.json`)
    return lines
}

/** Render an entry response (fresh start, rolled-back entry, resume, rerun). */
function entryReport(
    deps: SequenceDeps,
    probes: Record<string, PluginProbe>,
    mission: MissionRecord,
    stage: StageConfig,
    attempt: number,
    enteredAt: number,
    opening: string,
    closing: string,
): string {
    return [...[opening], ...stageHeader(deps, probes, mission, stage, attempt, enteredAt), '', `下一步：${closing}`].join('\n')
}

/** The "what to do now" line for a stage that is in flight. */
function nextActionFor(deps: SequenceDeps, stage: StageConfig): string {
    if (stage.gate.phase === 'exit' && isGated(stage.gate)) {
        return `完成阶段 ${stage.id} 的任务（${stage.gate.label}）后调用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" })；门禁不通过时会回退到 ${rollbackTargetOf(deps.config.stages, stage) ?? '(无)'}。`
    }
    return `按上面的任务描述执行阶段 ${stage.id}，完成后调用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" })。`
}

/** The Chinese circuit-breaker report. */
function breakerReport(deps: SequenceDeps, mission: MissionRecord, stage: StageConfig, attempts: number, reason: string, fix: string): string {
    return [
        `熔断（迭代上限）：阶段 ${stage.id} 在 mission ${mission.id} 上已经尝试 ${attempts} 次，上限 maxAttempts=${budgetOf(deps, stage)}。`,
        `原因：${reason}`,
        `mission 状态已置为 blocked，阶段结果记为 failed（.dsh/missions/${mission.id}/stages/${stage.id}.json）。`,
        '需要人工介入后才能继续：',
        `1. 查看 .dsh/missions/${mission.id}/stages/ 下各阶段的 failed/passed 记录与 summary；`,
        `2. 查看门禁与证据：.dsh/missions/${mission.id}/gates/、evidence.jsonl、receipts/；`,
        `3. 修复根因（改代码 / 改规格 / 补证据）后，用 orchestrate({ action: "rerun", stageId: "${stage.id}" }) 重开该阶段；`,
        `4. 若是流程配置不合理（阶段拆分过粗、上限过低），调整 profile 的 config.stages / defaultMaxAttempts 后重启会话。`,
        `自动修复建议：${fix}`,
        '',
        `下一步：${fix}`,
    ].join('\n')
}

// --- actions --------------------------------------------------------------

/** `stages` — the configured pipeline with the mounted/missing column. */
function stagesReport(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext): string {
    const lines = ['流水线（按顺序）：', '']
    deps.config.stages.forEach((stage, index) => {
        const states = requiredPluginStates(stage.requiredPlugins, probes)
        lines.push(`${index + 1}. ${stage.id} — ${stage.prompt}`)
        lines.push(`   门禁：${describeGate(stage.gate)}`)
        lines.push(`   回退：${rollbackTargetOf(deps.config.stages, stage) ?? '(无)'}　上限：${budgetOf(deps, stage)} 次`)
        lines.push(`   角色：${stage.role === undefined ? '无' : `${stage.role}（${roleInstruction(stage)}）`}`)
        lines.push(`   难度/模型：${describeStageRoute(resolveStageRoute(stage, deps.config.routing))}`)
        lines.push(
            `   自动派发：${shouldDispatch(deps.config, stage) ? '已开启（进入本阶段时自动派子代理执行）' : deps.config.autoDispatch.enabled ? '未开启（本阶段不在派发范围）' : '未开启（宿主未启用 autoDispatch）'}`,
        )
        lines.push(`   自动推进：${stage.autoAdvance === true ? '已启用（autoAdvance: true）' : '未启用（默认，由 orchestrate({ action: "advance" }) 推进）'}`)
        lines.push(`   要求插件：`)
        if (states.length === 0) lines.push('   - 无')
        for (const state of states) lines.push(`   - ${state.plugin}：${describeMount(probes[state.plugin], state.plugin)}`)
    })
    lines.push('', `当前 mission：${missionTag(ctx.mission)}；当前阶段：${currentStageId(deps, ctx.mission) ?? '(未开始，用 action: "start")'}`)
    return [...lines, '', '下一步：调用 orchestrate({ action: "start" }) 创建或绑定 mission 并从第一阶段开始；已开始则用 action: "advance"。'].join('\n')
}

/** `status` — the pipeline view. */
function statusReport(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext): string {
    const mission = ctx.mission
    if (mission === undefined) {
        return [
            '当前工作区没有 mission。',
            '',
            '下一步：调用 orchestrate({ action: "start", summary: "<一句话任务名>" }) 创建 mission 并从第一个阶段开始。',
        ].join('\n')
    }
    const results = new Map(stageResultsOf(ctx.store, mission.id).map((result) => [result.stageId, result]))
    const lines = [
        `mission：${mission.id}（${mission.title}）`,
        `状态：${mission.status}　当前阶段：${currentStageId(deps, mission) ?? '(未知)'}　更新：${formatTime(mission.updatedAt)}`,
        mission.roles === undefined || mission.roles.length === 0
            ? '已使用角色：无（阶段未声明 role）'
            : `已使用角色：${mission.roles.join('、')}`,
        '',
        '阶段 | 状态 | 次数 | 进入时间 | 完成时间 | 门禁裁决 | 角色 | 所需插件',
        '-----|------|------|----------|----------|----------|------|----------',
    ]
    for (const stage of deps.config.stages) {
        const result = results.get(stage.id)
        const states = requiredPluginStates(stage.requiredPlugins, probes)
        const plugins = states.length === 0 ? '无' : states.map((state) => `${state.plugin} ${state.mounted ? '✅' : '❌'}`).join('，')
        lines.push(
            [
                stage.id,
                result?.state ?? '未开始',
                result === undefined ? '-' : `${result.attempt}/${budgetOf(deps, stage)}`,
                result === undefined ? '-' : formatTime(result.enteredAt),
                result?.settledAt === undefined ? '-' : formatTime(result.settledAt),
                result?.gateState ?? '-',
                stage.role ?? '-',
                plugins,
            ].join(' | '),
        )
    }
    // Extra stages: a pipeline edit after the mission started left these behind.
    for (const [stageId, result] of results) {
        if (stageById(deps.config.stages, stageId) !== undefined) continue
        lines.push([`${stageId}（不在当前流水线）`, result.state, String(result.attempt), formatTime(result.enteredAt), result.settledAt === undefined ? '-' : formatTime(result.settledAt), result.gateState ?? '-', '-', '-'].join(' | '))
    }
    const missing = new Set<string>()
    for (const stage of deps.config.stages) {
        for (const state of requiredPluginStates(stage.requiredPlugins, probes)) {
            if (!state.mounted) missing.add(state.plugin)
        }
    }
    lines.push('')
    lines.push(missing.size === 0 ? '未挂载插件：无（所有阶段的插件探测均已通过）' : `未挂载插件：${[...missing].join('、')}（这些阶段无法进入）`)
    lines.push(`阶段工件目录：.dsh/missions/${mission.id}/stages/`)
    const stage = stageById(deps.config.stages, currentStageId(deps, mission))
    const closing =
        stage === undefined
            ? '调用 orchestrate({ action: "start" }) 从第一个阶段开始。'
            : `当前阶段 ${stage.id}：${isGated(stage.gate) && stage.gate.phase === 'entry' ? `先满足进入门禁（${stage.gate.label}），再` : ''}调用 orchestrate({ action: "advance" }) 推进；需要重跑或恢复用 action: "rerun" / "resume"。`
    return [...lines, '', `下一步：${closing}`].join('\n')
}

/** `start` — resolve or create the mission and enter the first stage. */
async function startAction(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext, args: OrchestrateArgs): Promise<string> {
    const blocked = ctx.mission === undefined ? undefined : blockedRefusal(ctx.mission, args.action)
    if (blocked !== undefined) return blocked

    const first = deps.config.stages[0]
    if (first === undefined) {
        return '流水线为空：没有可进入的阶段。请检查 config.stages。\n\n下一步：在 profile 中配置至少一个阶段后重启会话。'
    }
    const states = requiredPluginStates(first.requiredPlugins, probes)
    if (states.some((state) => !state.mounted)) {
        return [
            `${missionTag(ctx.mission)}：阶段 ${first.id} 不能开始，所需插件未挂载。`,
            `任务：${first.prompt}`,
            '',
            refusalForMissingPlugins(first.id, states.filter((state) => !state.mounted)),
            '',
            `下一步：补齐插件（见上）后重新调用 orchestrate({ action: "start" })。`,
        ].join('\n')
    }

    let mission = ctx.mission
    if (mission === undefined) {
        const title = args.summary !== undefined && args.summary.trim() !== '' ? args.summary.trim() : '未命名任务（orchestrate start）'
        mission = ctx.store.create({
            title,
            cwd: ctx.cwd,
            ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
        })
    }
    if (ctx.sessionId !== undefined) ctx.store.bindSession(ctx.sessionId, mission.id, first.id)

    const existing = stageResultOf(ctx.store, mission.id, first.id)
    // A live (entered) record means the stage is IN PROGRESS — possibly with an
    // auto-dispatched child working right now. Re-entering it would re-dispatch
    // (one child per call) and overwrite the artifact, so `start` is idempotent
    // for a live entry: a model that repeats the call must not multiply the work.
    // Only the SAME session repeating the call is refused: a different session
    // (or a resumed one) may legitimately pick up an unfinished mission, and the
    // guard must not lock a workspace out of its own pipeline.
    const sameSession = ctx.sessionId !== undefined && mission.sessionId === ctx.sessionId
    if (sameSession && existing !== undefined && existing.state === 'entered') {
        return [
            `mission ${mission.id}（${mission.title}）已经在阶段 ${first.id} 中（第 ${existing.attempt} 次进入，尚未结算）。`,
            `start 不会重新进入正在进行的阶段，也不会再派发一次：这只会重复消耗 token。`,
            '',
            `下一步：继续完成该阶段后用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" }) 推进；` +
                `要重开会先结算/放弃当前尝试（action: "rerun"），查看现状用 action: "status"。`,
            // The history is still worth showing: the caller asked to start, and
            // the cross-run ledger is exactly what a fresh attempt should see.
            ...(renderHistory(readLedger(ctx.store)) === '' ? [] : ['', renderHistory(readLedger(ctx.store))]),
        ].join('\n')
    }
    if (existing !== undefined && existing.state !== 'entered') {
        return [
            `mission ${mission.id}（${mission.title}）已经开始过：阶段 ${first.id} 的最近结果是 ${existing.state}（第 ${existing.attempt} 次）。`,
            `start 不会清空已落盘的阶段结果（那是审计轨迹）。`,
            '',
            `下一步：用 orchestrate({ action: "status" }) 查看流水线；要重开某阶段用 action: "rerun"，要从上次阶段继续用 action: "resume"。`,
        ].join('\n')
    }
    if (mission.stage !== undefined && mission.stage !== first.id) {
        return [
            `mission ${mission.id}（${mission.title}）已经进行到阶段 ${mission.stage}，start 只负责从第一阶段开始。`,
            '',
            `下一步：用 orchestrate({ action: "status" }) 查看流水线，再用 action: "advance" 推进当前阶段。`,
        ].join('\n')
    }

    const entry = evaluateGate(first.gate, { store: ctx.store, mission, current: existing })
    if (!entry.ok) {
        return [
            `mission ${mission.id}（${mission.title}）已绑定，但阶段 ${first.id} 的进入门禁未通过。`,
            `- ${entry.detail}`,
            entry.fix === undefined ? '' : `修复：${entry.fix}`,
            '',
            `下一步：${entry.fix ?? '满足门禁后重新调用 orchestrate({ action: "start" })。'}`,
        ].join('\n')
    }

    const attempt = nextAttempt(existing)
    const { recorded, dispatch } = await recordAndDispatch(deps, { ...ctx, mission }, first, attempt, args.summary)
    const history = renderHistory(readLedger(ctx.store))
    return [
        entryReport(
            deps,
            probes,
            recorded.mission,
            first,
            attempt,
            recorded.result.enteredAt,
            `mission ${recorded.mission.id}（${recorded.mission.title}）已开始，状态 ${recorded.mission.status}。`,
            `按上面的任务描述执行阶段 ${first.id}，完成后调用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" })。`,
        ),
        ...(history === '' ? [] : ['', history]),
        ...dispatchLines(dispatch),
    ].join('\n')
}

/**
 * The circuit breaker's latch: a `blocked` mission stays blocked until a human
 * explicitly releases it. Without this, `resume`/`advance` would quietly turn
 * the breaker's verdict into ordinary progress.
 */
function blockedRefusal(mission: MissionRecord, action: string): string | undefined {
    if (mission.status !== 'blocked') return undefined
    return [
        `mission ${mission.id} 处于熔断状态（blocked），拒绝执行 ${action}。`,
        '熔断是给人看的结论：继续推进只会重复同一轮失败。',
        '',
        '下一步（人工决定）：',
        '1. 修复根因后，用 orchestrate({ action: "unblock", summary: "<为什么可以继续>" }) 解除熔断；',
        '2. 或新建 mission（spec_create）重来；',
        '3. 若是流程配置不合理（阶段过粗、上限过低），调整 config.stages / defaultMaxAttempts 后重启会话。',
    ].join('\n')
}

/** `unblock` — the human's explicit release of a circuit breaker. */
function unblockAction(deps: SequenceDeps, ctx: CallContext, args: OrchestrateArgs): string {
    const mission = ctx.mission
    if (mission === undefined) return '当前会话没有 mission。\n\n下一步：orchestrate({ action: "start" })。'
    if (mission.status !== 'blocked') {
        return `mission ${mission.id} 的状态是 ${mission.status}，不需要解除熔断。\n\n下一步：orchestrate({ action: "status" })。`
    }
    const restored: MissionRecord['status'] = mission.spec?.approvedAt === undefined ? 'draft' : 'spec-approved'
    ctx.store.setStatus(mission.id, restored)
    ctx.store.appendEvidence(mission.id, {
        kind: 'manual',
        summary: `人工解除熔断：${args.summary ?? '(未填写原因)'}`,
        recordedBy: 'dsh-orchestrator',
        data: { action: 'unblock', from: 'blocked', to: restored },
    })
    return [
        `mission ${mission.id} 的熔断已解除（blocked → ${restored}），本次解除已记入证据账本。`,
        `原因：${args.summary ?? '(未填写)'}`,
        '',
        `下一步：orchestrate({ action: "resume" }) 回到阶段 ${mission.stage ?? '(空)'}，或 orchestrate({ action: "status" }) 先看状态。`,
    ].join('\n')
}

/** `advance` — settle the current stage and enter the next one. */
async function advanceAction(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext, args: OrchestrateArgs): Promise<string> {
    const blocked = ctx.mission === undefined ? undefined : blockedRefusal(ctx.mission, args.action)
    if (blocked !== undefined) return blocked

    const mission = ctx.mission
    if (mission === undefined) {
        return [
            '当前工作区没有 mission，无法推进阶段。',
            '',
            '下一步：先调用 orchestrate({ action: "start", summary: "<一句话任务名>" })。',
        ].join('\n')
    }
    const pipeline = deps.config.stages
    const currentStage = currentStageId(deps, mission)
    // `advance` settles the stage the mission is IN. Naming another stage is how
    // a caller could otherwise settle a stage that was never entered (skipping
    // both its work and its gate); re-entering a stage is `rerun`'s job.
    if (args.stageId !== undefined && args.stageId !== currentStage) {
        return [
            `mission ${mission.id} 当前阶段是 ${currentStage ?? '(空)'}，不是 ${args.stageId}：advance 只能结算当前阶段。`,
            '',
            `下一步：要重开某个阶段请用 orchestrate({ action: "rerun", stageId: "${args.stageId}" })；要推进当前阶段请省略 stageId。`,
        ].join('\n')
    }
    const stageId = currentStage
    const stage = stageById(pipeline, stageId)
    if (stage === undefined || stageId === undefined) {
        return [
            `mission ${mission.id} 没有可推进的阶段（mission.stage=${mission.stage ?? '(空)'}，参数 stageId=${args.stageId ?? '(空)'}）。`,
            '',
            '下一步：调用 orchestrate({ action: "status" }) 查看已落盘的阶段结果，用 action: "start" 或 action: "resume" 重新进入某个阶段。',
        ].join('\n')
    }

    // 1. capability check — a stage is never advanced while its plugin is missing.
    const states = requiredPluginStates(stage.requiredPlugins, probes)
    const missing = states.filter((state) => !state.mounted)
    if (missing.length > 0) {
        return [
            `mission ${mission.id}（${mission.title}）阶段 ${stage.id} 无法推进：所需插件未挂载。`,
            ...stageHeader(deps, probes, mission, stage, stageResultOf(ctx.store, mission.id, stage.id)?.attempt ?? 1, stageResultOf(ctx.store, mission.id, stage.id)?.enteredAt ?? Date.now()),
            '',
            refusalForMissingPlugins(stage.id, missing),
            '',
            `下一步：补齐插件（见上）后重新调用 orchestrate({ action: "advance" })。`,
        ].join('\n')
    }

    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const verdict: Verdict = args.verdict ?? 'PASS'
    const outcome = evaluateGate(stage.gate, { store: ctx.store, mission, current }, args.verdict)
    const leavesStage = stage.gate.phase === 'exit'

    // 2. entry gate — refuse without touching the record (retrying must be free).
    if (!leavesStage && !outcome.ok) {
        return [
            `mission ${mission.id}（${mission.title}）阶段 ${stage.id} 不能进入：门禁未通过。`,
            `- ${outcome.detail}`,
            `修复：${outcome.fix ?? '满足门禁后重试。'}`,
            '',
            `下一步：${outcome.fix ?? '满足门禁后重新调用 orchestrate({ action: "advance" }) 。'}`,
        ].join('\n')
    }

    // 3. exit gate — a failure rolls back instead of advancing (docs.md §4.2).
    if (!outcome.ok) {
        return await rollback(deps, probes, ctx, mission, stage, args, outcome.state ?? verdict, outcome.detail, outcome.fix)
    }
    // 4. the successor must be enterable before this stage is recorded as
    //    passed: no settled progress into a stage that cannot start.
    const target = successorOf(pipeline, stage)
    if (target !== undefined) {
        const blockedNext = entryBlockedBy(deps, probes, ctx, target, mission)
        if (blockedNext !== undefined) {
            const inFlight = stageResultOf(ctx.store, mission.id, stage.id)
            return [
                `阶段 ${stage.id} 的门禁已通过（${outcome.detail}），但下一阶段无法进入，因此本阶段暂不记为 passed。`,
                `当前阶段保持 entered（第 ${inFlight?.attempt ?? 1} 次）：重试不会消耗额外的尝试次数。`,
                '',
                blockedNext,
            ].join('\n')
        }
    }

    // 5. pass: settle the stage and enter the next one.
    const settled: StageResultWithRole = {
        stageId: stage.id,
        attempt: current?.attempt ?? 1,
        state: 'passed',
        enteredAt: current?.enteredAt ?? Date.now(),
        settledAt: Date.now(),
        ...(args.summary === undefined || args.summary === '' ? {} : { summary: args.summary }),
        gateState: isGated(stage.gate) ? (outcome.state ?? verdict) : verdict,
        ...roleField(stage),
        // BUG-2: the settled record must keep what the ENTRY recorded, or the
        // ledger can no longer answer "which model ran this stage" the moment it
        // is settled (and the dispatch record would vanish with it).
        ...routeField(deps, stage),
        ...(current?.route === undefined ? {} : { route: current.route }),
        ...(current?.dispatch === undefined ? {} : { dispatch: current.dispatch }),
    }
    ctx.store.writeStageResult(mission.id, settled)

    const next = target
    if (next === undefined) {
        const finished = ctx.store.setStatus(mission.id, 'delivered') ?? mission
        // docs.md §8 第四阶段：mission 结束即沉淀（规则式折叠，无需模型）。
        const retro = safeRetrospective(deps, ctx, finished)
        return [
            `阶段 ${stage.id} 已通过（第 ${settled.attempt} 次，门禁裁决 ${settled.gateState}，${outcome.detail}）。`,
            `${missionTag(finished)} 已是最后一个阶段，流水线结束，状态 ${finished.status}。`,
            `阶段结果：.dsh/missions/${mission.id}/stages/${stage.id}.json`,
            '交付物：.dsh/missions/' + mission.id + '/receipts/ 与 audit/ 下的审计记录。',
            ...(retro === undefined ? [] : ['', ...renderRetrospectiveTail(retro)]),
            '',
            `下一步：任务已交付。需要新的迭代时调用 orchestrate({ action: "rerun", stageId: "<要重开的阶段>" })；新的需求用 action: "start" 开新 mission。`,
        ].join('\n')
    }
    return [
        `阶段 ${stage.id} 已通过（第 ${settled.attempt} 次，门禁裁决 ${settled.gateState}，${outcome.detail}）→ 下一阶段 ${next.id}。`,
        '',
        ...(await enterStage(deps, probes, ctx, next, args.summary)),
    ].join('\n')
}

/** Record a failed stage and move back to its rollback target (or break). */
async function rollback(
    deps: SequenceDeps,
    probes: Record<string, PluginProbe>,
    ctx: CallContext,
    mission: MissionRecord,
    stage: StageConfig,
    args: OrchestrateArgs,
    verdict: Verdict,
    detail: string,
    fix: string | undefined,
): Promise<string> {
    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const attempt = current?.attempt ?? 1
    const target = rollbackTargetOf(deps.config.stages, stage)
    const targetStage = stageById(deps.config.stages, target)

    // The circuit breaker protects the ROLLBACK TARGET's attempt budget: rolling
    // back is re-entering that stage, so it must fit inside its maxAttempts.
    if (targetStage !== undefined) {
        const targetCurrent = stageResultOf(ctx.store, mission.id, targetStage.id)
        const targetAttempt = nextAttempt(targetCurrent)
        if (targetAttempt > budgetOf(deps, targetStage)) {
            ctx.store.writeStageResult(mission.id, {
                stageId: stage.id,
                attempt,
                state: 'failed',
                enteredAt: current?.enteredAt ?? Date.now(),
                settledAt: Date.now(),
                ...(args.summary === undefined || args.summary === '' ? {} : { summary: args.summary }),
                gateState: verdict === 'PASS' ? 'BLOCK' : verdict,
                ...roleField(stage),
                ...routeField(deps, stage),
                ...(current?.dispatch === undefined ? {} : { dispatch: current.dispatch }),
            })
            ctx.store.setStatus(mission.id, 'blocked')
            return breakerReport(deps, mission, targetStage, targetAttempt - 1, `阶段 ${stage.id} 门禁未通过（${detail}），而回退目标 ${targetStage.id} 已用满 ${budgetOf(deps, targetStage)} 次尝试`, fix ?? '人工检查失败原因并修复根因。')
        }
    }

    ctx.store.writeStageResult(mission.id, {
        stageId: stage.id,
        attempt,
        state: 'failed',
        enteredAt: current?.enteredAt ?? Date.now(),
        settledAt: Date.now(),
        ...(args.summary === undefined || args.summary === '' ? {} : { summary: args.summary }),
        gateState: verdict === 'PASS' ? 'BLOCK' : verdict,
        ...routeField(deps, stage),
        ...(current?.dispatch === undefined ? {} : { dispatch: current.dispatch }),
        ...(target === undefined ? {} : { next: target }),
        ...roleField(stage),
    })

    if (targetStage === undefined) {
        ctx.store.setStatus(mission.id, 'blocked')
        return [
            `阶段 ${stage.id} 门禁未通过：${detail}`,
            `该阶段没有回退目标（onFail 未配置且是首阶段），流程无法继续，mission 状态置为 blocked。`,
            `修复：${fix ?? '人工检查后重试。'}`,
            '',
            `下一步：${fix ?? '修复后调用 orchestrate({ action: "rerun", stageId: "' + stage.id + '" }) 重开该阶段。'}`,
        ].join('\n')
    }

    const entered = await enterStage(deps, probes, ctx, targetStage, args.summary, `回退：阶段 ${stage.id} 门禁未通过（${detail}），已回退到 ${targetStage.id}。`)
    return [
        `阶段 ${stage.id} 未通过（第 ${attempt} 次，裁决 ${verdict === 'PASS' ? 'BLOCK' : verdict}）：${detail}`,
        `回退目标：${targetStage.id}（onFail）`,
        `阶段结果：.dsh/missions/${mission.id}/stages/${stage.id}.json（state: failed）`,
        `修复：${fix ?? '按门禁要求修复后重新推进。'}`,
        '',
        ...entered,
    ].join('\n')
}

/**
 * Can this stage be entered at all? (capability + attempt budget)
 *
 * `advance` asks this about its successor BEFORE settling the current stage:
 * a stage must not be recorded as `passed` on the way into a stage that cannot
 * start — that would claim progress the pipeline does not have, and the retry
 * would burn attempt counters it never used.
 *
 * @returns `undefined` when the stage may be entered, else the refusal report.
 */
function entryBlockedBy(
    deps: SequenceDeps,
    probes: Record<string, PluginProbe>,
    ctx: CallContext,
    stage: StageConfig,
    mission: MissionRecord,
): string | undefined {
    const missing = requiredPluginStates(stage.requiredPlugins, probes).filter((state) => !state.mounted)
    if (missing.length > 0) {
        return [
            `阶段 ${stage.id} 不能进入：所需插件未挂载。`,
            `- ${missing.map((state) => `${state.plugin}（探测 ${state.probe}）`).join('；')}`,
            '',
            refusalForMissingPlugins(stage.id, missing).split('\n').slice(2).join('\n'),
            '',
            `下一步：补齐插件后重新调用 orchestrate({ action: "advance" })。`,
        ].join('\n')
    }
    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const attempt = nextAttempt(current)
    if (attempt > budgetOf(deps, stage)) {
        ctx.store.setStatus(mission.id, 'blocked')
        return breakerReport(deps, mission, stage, attempt - 1, `阶段 ${stage.id} 已达到尝试上限，无法再次进入`, '人工检查失败原因并修复根因，或调整 config.stages 的 maxAttempts / config.defaultMaxAttempts 后重启会话，再用 orchestrate({ action: "rerun", stageId: "' + stage.id + '" }) 重开该阶段。')
    }
    return undefined
}

/**
 * Enter a stage: capability and attempt budget first, then record and report.
 * @param reason - extra first line (rollback/resume context), when any.
 */
async function enterStage(
    deps: SequenceDeps,
    probes: Record<string, PluginProbe>,
    ctx: CallContext,
    stage: StageConfig,
    summary?: string,
    reason?: string,
): Promise<string[]> {
    const mission = ctx.mission
    if (mission === undefined) return ['没有 mission，无法进入阶段。', '', '下一步：调用 orchestrate({ action: "start", summary: "<一句话任务名>" })。']
    const states = requiredPluginStates(stage.requiredPlugins, probes)
    const missing = states.filter((state) => !state.mounted)
    if (missing.length > 0) {
        return [...refusalForMissingPlugins(stage.id, missing).split('\n'), '', `下一步：补齐插件后重新调用 orchestrate({ action: "resume" })（或 action: "advance"）继续阶段 ${stage.id}。`]
    }
    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const attempt = nextAttempt(current)
    if (attempt > budgetOf(deps, stage)) {
        ctx.store.setStatus(mission.id, 'blocked')
        return breakerReport(deps, mission, stage, attempt - 1, `阶段 ${stage.id} 的尝试次数已达上限，拒绝再次进入`, '人工检查失败原因并修复根因，或调整 config.stages 的 maxAttempts / config.defaultMaxAttempts 后重启会话，再用 orchestrate({ action: "rerun", stageId: "' + stage.id + '" }) 重开该阶段。').split('\n')
    }
    // GAP-9: the entry gate is checked BEFORE a child is dispatched. Dispatching
    // into a stage whose entry gate is unmet would spend tokens on work the
    // pipeline has explicitly said must not start yet.
    const entryProbe = evaluateGate(stage.gate, { store: ctx.store, mission, current })
    const entryBlocked = stage.gate.phase === 'entry' && isGated(stage.gate) && !entryProbe.ok
    const { recorded, dispatch } = await recordAndDispatch(
        deps,
        { ...ctx, mission },
        stage,
        attempt,
        summary,
        entryTimeOf(current),
        entryBlocked ? `进入门禁未满足（${entryProbe.detail}）：本次不自动派发` : undefined,
    )
    const history = renderHistory(readLedger(ctx.store))
    const entry = evaluateGate(stage.gate, { store: ctx.store, mission: recorded.mission, current })
    const entryNote =
        stage.gate.phase === 'entry' && isGated(stage.gate)
            ? entry.ok
                ? `进入门禁已满足：${entry.detail}`
                : `进入门禁待满足：${entry.detail}（修复：${entry.fix ?? '见门禁要求'}）`
            : undefined
    const lines = [
        ...(reason === undefined ? [] : [reason, '']),
        ...stageHeader(deps, probes, recorded.mission, stage, attempt, recorded.result.enteredAt),
    ]
    if (entryNote !== undefined) lines.push(`门禁现状：${entryNote}`)
    if (history !== '') lines.push('', history)
    lines.push(...dispatchLines(dispatch))
    lines.push('', `下一步：${nextActionFor(deps, stage)}`)
    return lines
}

/** `rerun` — re-enter a stage (attempt += 1) with the circuit breaker armed. */
async function rerunAction(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext, args: OrchestrateArgs): Promise<string> {
    const blocked = ctx.mission === undefined ? undefined : blockedRefusal(ctx.mission, args.action)
    if (blocked !== undefined) return blocked

    const mission = ctx.mission
    if (mission === undefined) {
        return ['当前工作区没有 mission，无法重跑。', '', '下一步：先调用 orchestrate({ action: "start" })。'].join('\n')
    }
    const stageId = args.stageId ?? currentStageId(deps, mission)
    const stage = stageById(deps.config.stages, stageId)
    if (stage === undefined || stageId === undefined) {
        return [
            `找不到要重跑的阶段（stageId=${args.stageId ?? '(空)'}，mission.stage=${mission.stage ?? '(空)'}）。`,
            '',
            '下一步：调用 orchestrate({ action: "status" }) 查看可用阶段 id 后重试。',
        ].join('\n')
    }
    const states = requiredPluginStates(stage.requiredPlugins, probes)
    const missing = states.filter((state) => !state.mounted)
    if (missing.length > 0) {
        return [refusalForMissingPlugins(stage.id, missing), '', `下一步：补齐插件后重新调用 orchestrate({ action: "rerun", stageId: "${stage.id}" })。`].join('\n')
    }
    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const attempt = (current?.attempt ?? 0) + 1
    if (attempt > budgetOf(deps, stage)) {
        ctx.store.setStatus(mission.id, 'blocked')
        return breakerReport(deps, mission, stage, attempt - 1, `阶段 ${stage.id} 的尝试次数已达上限，拒绝重跑`, '人工检查失败原因并修复根因，或调整 config.stages 的 maxAttempts 后重启会话。')
    }
    const { recorded, dispatch } = await recordAndDispatch(deps, { ...ctx, mission }, stage, attempt, args.summary)
    return [
        `重跑阶段 ${stage.id}（第 ${attempt} 次，上限 ${budgetOf(deps, stage)} 次）。重跑会覆盖上一次的阶段结果文件，历史仍可从 mission 的 evidence/audit 追溯。`,
        '',
        ...stageHeader(deps, probes, recorded.mission, stage, attempt, recorded.result.enteredAt),
        ...dispatchLines(dispatch),
        '',
        `下一步：执行阶段 ${stage.id}，完成后调用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" })。`,
    ].join('\n')
}

/** `resume` — re-enter the persisted `mission.stage` (断点恢复). */
async function resumeAction(deps: SequenceDeps, probes: Record<string, PluginProbe>, ctx: CallContext, args: OrchestrateArgs): Promise<string> {
    const blocked = ctx.mission === undefined ? undefined : blockedRefusal(ctx.mission, args.action)
    if (blocked !== undefined) return blocked

    const mission = ctx.mission
    if (mission === undefined) {
        return [
            '当前工作区没有 mission，没有可恢复的断点。',
            '',
            '下一步：调用 orchestrate({ action: "start", summary: "<一句话任务名>" })。',
        ].join('\n')
    }
    const stageId = currentStageId(deps, mission)
    const stage = stageById(deps.config.stages, stageId)
    if (stage === undefined || stageId === undefined) {
        return [
            `mission ${mission.id} 没有已落盘的当前阶段（mission.stage=${mission.stage ?? '(空)'}）。`,
            '',
            '下一步：调用 orchestrate({ action: "status" }) 查看流水线，再用 action: "rerun", stageId: "<阶段>" 指定要进入的阶段。',
        ].join('\n')
    }
    const current = stageResultOf(ctx.store, mission.id, stage.id)
    const lines = [
        `断点恢复：mission ${mission.id} 上次停在阶段 ${stage.id}（持久化结果：${current?.state ?? '(无记录)'}，第 ${current?.attempt ?? 1} 次，进入于 ${current === undefined ? '(未知)' : formatTime(current.enteredAt)}）。`,
        '恢复不会重置尝试计数（熔断上限仍然有效），也不会清空已落盘的阶段结果。',
        '',
    ]
    const states = requiredPluginStates(stage.requiredPlugins, probes)
    const missing = states.filter((state) => !state.mounted)
    if (missing.length > 0) {
        lines.push(...refusalForMissingPlugins(stage.id, missing).split('\n'), '', `下一步：补齐插件后重新调用 orchestrate({ action: "resume" })。`)
        return lines.join('\n')
    }
    const entry = evaluateGate(stage.gate, { store: ctx.store, mission, current })
    if (!entry.ok && stage.gate.phase === 'entry') {
        lines.push(`进入门禁待满足：${entry.detail}`, `修复：${entry.fix ?? '满足门禁后重试。'}`, '', `下一步：${entry.fix ?? '满足门禁后重新调用 orchestrate({ action: "resume" })。'}`)
        return lines.join('\n')
    }
    const attempt = nextAttempt(current)
    if (attempt > budgetOf(deps, stage)) {
        ctx.store.setStatus(mission.id, 'blocked')
        return breakerReport(deps, mission, stage, attempt - 1, `阶段 ${stage.id} 的尝试次数已达上限，拒绝恢复`, '人工检查失败原因并修复根因，或调整 config.stages 的 maxAttempts 后重启会话。')
    }
    const { recorded, dispatch } = await recordAndDispatch(deps, { ...ctx, mission }, stage, attempt, args.summary ?? current?.summary, entryTimeOf(current))
    lines.push(...stageHeader(deps, probes, recorded.mission, stage, attempt, recorded.result.enteredAt))
    lines.push(...dispatchLines(dispatch))
    lines.push('', `下一步：继续执行阶段 ${stage.id}，完成后调用 orchestrate({ action: "advance", verdict: "PASS", summary: "<做了什么>" })。`)
    return lines.join('\n')
}

/**
 * Run one `orchestrate` call.
 * @param deps - config, store registry and probes.
 * @param args - the tool arguments.
 * @param exec - the tool execution context (agent, signal).
 * @returns the Chinese report; the last line is always the next action.
 */
export async function runOrchestrate(deps: SequenceDeps, args: OrchestrateArgs, exec: unknown): Promise<string> {
    const action = ACTIONS.includes(args.action) ? args.action : undefined
    if (action === undefined) {
        return [
            `未知的 action "${String(args.action)}"。`,
            `可用 action：${ACTIONS.join(' / ')}。`,
            '',
            '下一步：调用 orchestrate({ action: "status" }) 查看当前流水线。',
        ].join('\n')
    }
    const ctx = callContext(deps, exec, args.missionId)
    const probes = deps.probesFor(ctx.agent)
    switch (action) {
        case 'stages':
            return stagesReport(deps, probes, ctx)
        case 'status':
            return statusReport(deps, probes, ctx)
        case 'start':
            return await startAction(deps, probes, ctx, args)
        case 'advance':
            return await advanceAction(deps, probes, ctx, args)
        case 'rerun':
            return await rerunAction(deps, probes, ctx, args)
        case 'resume':
            return await resumeAction(deps, probes, ctx, args)
        case 'retro':
            return retroAction(deps, ctx)
        case 'unblock':
            return unblockAction(deps, ctx, args)
        default:
            return '未知的 action。\n\n下一步：调用 orchestrate({ action: "status" })。'
    }
}

/** `retro` — fold the finished mission into a retrospective (docs.md §8 phase 4). */
function retroAction(deps: SequenceDeps, ctx: CallContext): string {
    const mission = ctx.mission
    if (mission === undefined) {
        return [
            '当前会话没有 mission 可以复盘。',
            '',
            '下一步：先用 orchestrate({ action: "start" }) 开始一条流水线，或在有 mission 的会话里调用 state action: "retro"。',
        ].join('\n')
    }
    const retro = buildRetrospective(ctx.store, mission, deps.config.stages)
    const files = persistRetrospective(ctx.store, retro)
    return [
        `## 复盘（mission ${mission.id}，状态 ${mission.status}）`,
        '',
        `- 规格 revision：${retro.specRevisions}　门禁：PASS ${retro.gates.pass} / WARN ${retro.gates.warn} / BLOCK ${retro.gates.block}　回执：${retro.receipts}`,
        `- 失败命令：${retro.failingCommands.map((entry) => `${entry.id}×${entry.count}`).join('、') || '无'}`,
        `- 阶段回退：${retro.rollbacks.map((entry) => `${entry.stage}→${entry.to}×${entry.count}`).join('、') || '无'}`,
        `- 重复尝试：${retro.reworkStages.map((entry) => `${entry.stage}×${entry.attempts}`).join('、') || '无'}　熔断：${retro.blocked ? '是' : '否'}`,
        '',
        '### 候选经验',
        ...retro.lessons.map((lesson) => `- ${lesson}`),
        '',
        `工件：${path.relative(ctx.store.layout.cwd, files.markdown)}（+ .json）`,
        `跨 run 台账：${path.relative(ctx.store.layout.cwd, files.ledger)}（只追加，下次开工前可 grep 历史模式）`,
        '',
        '下一步：用 memory_save 把其中真正可复用的 1–3 条写成 lesson（项目级；工具链事实才写 global），',
        '下次同类任务开工时它们会被自动召回；其余条目留在 retrospective.md 里备查。',
    ].join('\n')
}

/** Build + persist quietly; a retrospective must never break the transition. */
function safeRetrospective(deps: SequenceDeps, ctx: CallContext, mission: MissionRecord): Retrospective | undefined {
    try {
        const retro = buildRetrospective(ctx.store, mission, deps.config.stages)
        persistRetrospective(ctx.store, retro)
        return retro
    } catch {
        return undefined
    }
}

function renderRetrospectiveTail(retro: Retrospective): string[] {
    return [
        `复盘已生成：规格 revision ${retro.specRevisions}，门禁 BLOCK ${retro.gates.block} 次，回退 ${retro.rollbacks.length} 次。`,
        ...retro.lessons.slice(0, 2).map((lesson) => `- ${lesson}`),
        `完整复盘：.dsh/missions/${retro.missionId}/retrospective.md；跨 run 台账：${'.dsh/retrospectives.jsonl'}`,
    ]
}

/** Register `orchestrate` (the plugin's single responsibility). */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: SequenceDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, toolName: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(toolName)
        } catch (error) {
            failed.push(toolName)
            void error
        }
    }

    register(
        defineTool({
            name: 'orchestrate',
            description: ORCHESTRATE_DESCRIPTION,
            parameters: {
                action: {
                    type: 'string',
                    required: true,
                    enum: [...ACTIONS],
                    description:
                        'start = create/bind the mission and enter the first stage; status = pipeline view; advance = settle the current stage and enter the next one (only the current stage); rerun = re-enter a stage (attempt + 1); resume = re-enter the persisted mission.stage; stages = list the configured pipeline with capability probing; retro = fold the finished mission into a retrospective (返工信号 + 候选经验) and append it to the cross-run ledger; unblock = the human release of a blocked (熔断) mission.',
                },
                missionId: { type: 'string', description: 'Mission to act on (default: the mission bound to this session or its delegating parent; pass an explicit id to drive another one).' },
                stageId: { type: 'string', description: 'Stage to act on for rerun (default: the current stage).' },
                summary: { type: 'string', description: 'One-line summary of what the stage did; recorded with the stage result.' },
                verdict: {
                    type: 'string',
                    enum: ['PASS', 'WARN', 'BLOCK'],
                    description: 'Explicit verdict recorded with the stage result. BLOCK forces the rollback path even when the gate would pass.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: OrchestrateArgs, exec) {
                return runOrchestrate(deps, args ?? ({ action: 'status' } as OrchestrateArgs), exec)
            },
        }),
        'orchestrate',
    )

    return { disposers, registered, failed }
}

export type { StageConfig }

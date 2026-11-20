/**
 * dsh-orchestrator — the top-level coordinator of the engineering pipeline
 * (docs.md §4).
 *
 * Responsibilities:
 *  - define the stage pipeline (路径一: 配置驱动的固定流水线) and, for the
 *    stages whose deterministic fact *is* the transition, the conditional
 *    edges with rollback and the iteration circuit breaker (路径二);
 *  - refuse to enter a stage while one of its `requiredPlugins` is not mounted,
 *    probing only `ctx.tools.get(tool, agent)` and `ctx.get(service)`;
 *  - persist every stage result to `.dsh/missions/<id>/stages/<stageId>.json`
 *    so a run can be resumed (断点恢复) or a stage rerun;
 *  - contribute the pipeline contract to the system prompt.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.tools.get(name, agent)            @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.get(service)                      cordis service registry
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-orchestrator
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createDelegationPresets, createLogger, expandHome, sessionIdOf } from 'dsh-eng-core'
import type { AgentLike, ApprovalLike, Logger } from 'dsh-eng-core'
import { resolveConfig, type OrchestratorConfig } from './config.js'
import { ORCHESTRATOR_SERVICE, createOrchestratorService } from './enter-implement.js'
import { AutoAdvanceSessions, autoAdvanceStages, createAutoAdvanceHook } from './hooks.js'
import { createProbes, mergeProbes } from './probes.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type SequenceDeps } from './sequence.js'
import { registerSplitPlanTool } from './split-plan-tool.js'

export const name = 'dsh-orchestrator'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
    get: (name: string, scope?: unknown) => unknown
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: () => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    get: (name: string) => unknown
    effect: (execute: () => (() => void) | void) => void
    /** cordis service registration (optional: an older runtime may not have it). */
    provide?: (name: string, value: unknown) => unknown
}

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    const { config: resolved, issues } = resolveConfig(config)
    if (!resolved.enabled) return
    const logger = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    try {
        if (issues.length > 0) {
            logger.warn(
                `config.stages 无效，已回退到默认流水线（${resolved.stages.map((stage) => stage.id).join(' → ')}）：\n- ${issues.join('\n- ')}`,
            )
        }
        // GAP-10: report autoDispatch configuration problems too. Silently
        // dispatching the DEFAULT stage list — or silently switching the feature
        // off — is exactly the kind of surprise a host cannot debug.
        if (resolved.autoDispatch.issues.length > 0) {
            logger.warn(`config.autoDispatch 有问题（已按说明处理）：\n- ${resolved.autoDispatch.issues.join('\n- ')}`)
        }
        // GAP-10 applies to the metrics keys too: `windowDays: "90"` must not look
        // like it changed the window.
        if (resolved.metrics.issues.length > 0) {
            logger.warn(`config.metrics 有问题（已按说明处理）：\n- ${resolved.metrics.issues.join('\n- ')}`)
        }
        if (resolved.autoDispatch.enabled) {
            logger.info(
                `autoDispatch：已启用（provider=${resolved.autoDispatch.provider}；阶段 ${resolved.autoDispatch.stages.join(', ') || '(空：不会派发)'}；上限 ${Math.round(resolved.autoDispatch.timeoutMs / 1000)}s）`,
            )
        }
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger })
        logger.info(`probes: ${Object.entries(mergeProbes(resolved.probes)).map(([plugin, probe]) => `${plugin}(${probe.tool ?? probe.service ?? '-'})`).join(', ')}`)

        // Autonomous dispatch: entering a stage can hand the work to a child
        // agent instead of waiting for the model to call team_delegate.
        // Off unless config.autoDispatch.enabled; never settles a stage.
        //
        // The dispatch presets are registered lazily on the first dispatch (the
        // stage role's persona/filter is only known then). `agentPresets` is read
        // per call, so a service that appears after assembly still works; the
        // registry itself never throws into `apply` — a missing service becomes a
        // refusal at dispatch time, which is where the model can act on it.
        // The seam is dsh-eng-core's (`delegation.ts`); this registry remembers
        // only which preset ids THIS plugin registered, so a preset somebody else
        // declared under `orchestrator:<role>` is refused instead of trusted.
        const dispatchPresets = createDelegationPresets({
            presets: () => {
                try {
                    return context.get('agentPresets') as never
                } catch {
                    return undefined
                }
            },
            logger,
        })
        const dispatchDeps = {
            config: resolved,
            subagents: () => context.get('subagents') as never,
            roleGuard: () => context.get('role-guard') as never,
            presets: dispatchPresets,
            stagesDir: (cwd: string, missionId: string) => {
                try {
                    return path.join(stores.for(cwd).layout.missionsDir, missionId, 'stages')
                } catch (error) {
                    throw new Error(`无法确定阶段工件目录（${(error as Error).message}）`)
                }
            },
        }

        const clockService = clockFrom(context)
        const approvalSeam = approvalSeamOf(context)

        const sequenceDeps: SequenceDeps = {
            config: resolved,
            stores,
            // Probes are scope-aware, so they are rebuilt per call: the registry
            // view of a delegated child may differ from the root's.
            probesFor: (agent) => createProbes(context, resolved.probes, agent),
            dispatch: dispatchDeps,
            approval: approvalSeam,
            nvimTui: () => context.get('nvim-tui'), // split-review 的菜单 + 只读预览；无 TUI 时走 approval 接缝
            // split-review 先读本会话审批策略；读失败只是日志（AC-002），不是拒绝。
            log: (message) => logger.info(message),
            // A host MAY provide a `clock`; tests freeze it so two runs are byte-identical.
            ...(clockService === undefined ? {} : { now: clockService }),
        }
        const tools = registerTools(context as never, sequenceDeps)
        // AC-001: the CHECKED write entry of the split plan, into the same sink.
        registerSplitPlanTool(context as never, sequenceDeps, tools)

        const disposers: (() => void)[] = [...tools.disposers]
        disposers.push(registerOrchestratorService(context, resolved, stores, approvalSeam, logger))
        // The automatic transition (docs.md §4.2 自动触发下一阶段): opt-in per
        // stage, gate-driven, and a no-op — one array check — when no stage
        // declares `autoAdvance: true`.
        const sessions = new AutoAdvanceSessions()
        const autoStages = autoAdvanceStages(resolved.stages)
        disposers.push(
            context.on(
                'agent/turn-stopping',
                createAutoAdvanceHook({
                    config: resolved,
                    stores,
                    probesFor: (agent) => createProbes(context, resolved.probes, agent),
                    // BUG-1: the automatic transition enters stages through the
                    // same code path as `advance`, so it needs the dispatch deps
                    // too — otherwise the one path with NO model in the loop was
                    // exactly the one that never dispatched.
                    dispatch: dispatchDeps,
                    sessions,
                    autoStages,
                    logger,
                }) as never,
            ),
        )
        disposers.push(
            context.on('agent/disposed', ((payload: { agent?: AgentLike }) => {
                const sessionId = sessionIdOf(payload?.agent)
                if (sessionId !== undefined) sessions.clear(sessionId)
            }) as never),
        )
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    text: () => sectionText(resolved),
                }),
            )
        }

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    logger.warn('disposer failed:', error)
                }
            }
            // Release the presets this plugin registered: a reloaded plugin must
            // not find its own ids taken by the previous instance.
            dispatchPresets.clear()
            sessions.clearAll()
        })

        logger.info(
            `applied (tool: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; stages: ${resolved.stages.map((stage) => stage.id).join(' → ')}; autoAdvance: ${autoStages.map((stage) => stage.id).join(', ') || 'none'})`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

/**
 * The host approval seam, read per call.
 *
 * The split review asks a HUMAN through it. It is an accessor, not a captured
 * value: a host that withdraws the service mid-session must make the next review
 * refuse (「宿主没有 approval 接缝」), not keep using a stale reference. That is
 * the same seam `spec_approve` asks through: TUI / desktop / web TUI natively,
 * IM when it is configured — never an extra switch of this plugin.
 * @param context - host context.
 */
function approvalSeamOf(context: ContextLike): () => ApprovalLike | undefined {
    return (): ApprovalLike | undefined => context.get('approval') as ApprovalLike | undefined
}

/**
 * Register the optional `orchestrator` service (`spec_approve` asks it to walk
 * the mission up to `implement`, AC-001).
 *
 * It is provided, never injected, so a runtime without `provide` — or a sibling
 * plugin that never asks — is not an error; `enterImplement` reuses the `advance`
 * code path and never dispatches a child.
 */
function registerOrchestratorService(
    context: ContextLike,
    config: OrchestratorConfig,
    stores: MissionStoreRegistry,
    approval: () => ApprovalLike | undefined,
    logger: Logger,
): () => void {
    const service = createOrchestratorService({
        config,
        stores,
        probesFor: () => createProbes(context, config.probes, undefined),
        approval,
        // `spec_approve` may walk an approved mission into `split-review`; that
        // review asks in the SAME shape as the spec review on the TUI.
        nvimTui: () => context.get('nvim-tui'),
        log: (message) => logger.info(message),
    })
    return provideOptionalService(context, ORCHESTRATOR_SERVICE, service, logger)
}

/**
 * The host clock, when it provides one (see `SequenceDeps.now`).
 *
 * Extracted from `apply` so the assembly function keeps its accepted size; the
 * behaviour is unchanged (absent/failing clock = undefined = wall clock).
 * @param context - host context (`ctx.get('clock')`).
 * @returns a millisecond clock, or `undefined` when the host has none.
 */
function clockFrom(context: ContextLike): (() => number) | undefined {
    const host = context.get('clock') as { now?: () => number } | undefined
    if (host === undefined || typeof host.now !== 'function') return undefined
    return (): number => (host.now as () => number).call(host)
}

/**
 * Provide an OPTIONAL service; never a reason to fail the assembly.
 *
 * A runtime without `ctx.provide` is reported once and skipped: the consumer
 * (spec-gate) treats the service as optional and a missing one only means
 * "no automatic advance", not "approval failed".
 * @param context - host context.
 * @param serviceName - cordis service name.
 * @param service - the value to register.
 * @param logger - diagnostics sink.
 * @returns the disposer (never throws).
 */
function provideOptionalService(context: ContextLike, serviceName: string, service: unknown, logger: Logger): () => void {
    if (typeof context.provide !== 'function') {
        logger.info(`service ${serviceName}: unavailable (no ctx.provide) — enterImplement 不可用`)
        return () => undefined
    }
    try {
        const dispose = context.provide(serviceName, service)
        logger.info(`service ${serviceName}: on (enterImplement 可用)`)
        return typeof dispose === 'function' ? (dispose as () => void) : () => undefined
    } catch (error) {
        logger.warn(`service ${serviceName}: registration failed (${(error as Error).message}) — enterImplement 不可用`)
        return () => undefined
    }
}

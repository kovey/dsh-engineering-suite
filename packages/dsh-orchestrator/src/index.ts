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
import { MissionStoreRegistry, createLogger, expandHome, sessionIdOf } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import { resolveConfig } from './config.js'
import { AutoAdvanceSessions, autoAdvanceStages, createAutoAdvanceHook } from './hooks.js'
import { createProbes, mergeProbes } from './probes.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools } from './sequence.js'

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
        const dispatchDeps = {
            config: resolved,
            subagents: () => context.get('subagents') as never,
            roleGuard: () => context.get('role-guard') as never,
            stagesDir: (cwd: string, missionId: string) => {
                try {
                    return path.join(stores.for(cwd).layout.missionsDir, missionId, 'stages')
                } catch (error) {
                    throw new Error(`无法确定阶段工件目录（${(error as Error).message}）`)
                }
            },
        }

        const tools = registerTools(context as never, {
            config: resolved,
            stores,
            // Probes are scope-aware, so they are rebuilt per call: the registry
            // view of a delegated child may differ from the root's.
            probesFor: (agent) => createProbes(context, resolved.probes, agent),
            dispatch: dispatchDeps,
        })

        const disposers: (() => void)[] = [...tools.disposers]
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
            sessions.clearAll()
        })

        logger.info(
            `applied (tool: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; stages: ${resolved.stages.map((stage) => stage.id).join(' → ')}; autoAdvance: ${autoStages.map((stage) => stage.id).join(', ') || 'none'})`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

/**
 * dsh-quality-gate — the deterministic quality gate (docs.md §3.4).
 *
 * Responsibilities:
 *  - run the **host-configured** commands (tests, typecheck, lint) and turn
 *    their exit facts into `PASS` / `WARN` / `BLOCK`;
 *  - trigger at the two boundaries that matter: after a successful write-class
 *    tool (the lint feedback loop) and when the turn is about to stop (the
 *    "agent claims completion" boundary), where a `BLOCK` steers the agent back
 *    with the failure output instead of letting the turn close;
 *  - record every verdict on the mission as a gate row plus an evidence entry,
 *    which is what `dsh-evidence-gate` consumes before it will issue a receipt.
 *
 * Loop safety: a gate only runs when something was written since the last run,
 * an identical failure is reported once, and corrective steers are capped per
 * turn (`trigger.turnStop.maxBlocksPerTurn`, `trigger.afterWrite.maxPerTurn`).
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))                 @deepseek-ai/dsh-tools
 *  - ctx.on('tools/post-execute', (exec, result, next))  waterfall (dsh-tools)
 *  - ctx.on('agent/turn-stopping', (payload))            serial (dsh-agent)
 *  - ctx.get('subprocess')                               @deepseek-ai/dsh-subprocess
 *  - ctx.systemPrompt.section({...})                     @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)                           cordis v4 fiber teardown
 *
 * @module dsh-quality-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, sessionIdOf } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig } from './config.js'
import { createAfterWriteHook, createTurnStopHook, GateSessions } from './hooks.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools } from './tools.js'

export const name = 'dsh-quality-gate'

/** Only the services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ContextLike {
    tools: { register: (definition: never) => () => void }
    systemPrompt: { section: (section: { name: string; order: number; text: (assemble?: unknown) => string }) => () => void }
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    get: (name: string) => unknown
    effect: (execute: () => (() => void) | void) => void
}

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    // Config problems are collected before the logger exists, then replayed.
    const problems: string[] = []
    const resolved = resolveConfig(config, (message) => problems.push(message))
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        // Per-workspace files keep several repositories' lines from interleaving
        // (host-only setting; see docs/ARCHITECTURE.md §5.3).
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    for (const problem of problems) log.warn(`config: ${problem}`)
    if (!resolved.enabled) {
        log.info('disabled by config')
        return
    }
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const sessions = new GateSessions()
        const deps = {
            config: resolved,
            sessions,
            stores,
            logger: log,
            subprocess: () => context.get('subprocess'),
            // Profile config is the ceiling; a workspace may refine it through
            // its own .dsh/quality-gate.json (see resolveEffectiveConfig).
            configFor: (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, log),
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) log.warn(`tools that failed to register: ${tools.failed.join(', ')}`)

        const disposers: (() => void)[] = [...tools.disposers]
        disposers.push(context.on('tools/post-execute', createAfterWriteHook(deps) as never))
        disposers.push(context.on('agent/turn-stopping', createTurnStopHook(deps) as never))
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
                    // Per assembly: the model must be told THIS workspace's
                    // effective commands, not the profile's defaults.
                    text: (assemble?: unknown) => {
                        try {
                            const scope = (assemble as { scope?: AgentLike } | undefined)?.scope
                            const cwd = scope?.session?.header?.cwd
                            if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                            const effective = deps.configFor(cwd)
                            return sectionText(effective.config, effective.source === 'project' ? effective.file : undefined)
                        } catch {
                            return sectionText(resolved)
                        }
                    },
                }),
            )
        }

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    log.warn('disposer failed:', error)
                }
            }
            sessions.clearAll()
        })

        log.info(
            `applied (commands: ${resolved.commands.map((command) => command.id).join(', ') || 'none'}; turnStop=${resolved.turnStop.enabled}; afterWrite=${resolved.afterWrite.enabled})`,
        )
        if (resolved.commands.length === 0) {
            log.warn('no gate commands configured — the gate can only report WARN until config.commands is filled in')
        }
    } catch (error) {
        log.error('apply failed:', error)
    }
}

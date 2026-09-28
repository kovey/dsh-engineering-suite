/**
 * dsh-interaction-gate — the suite's own interaction layer.
 *
 * Every "a human must decide" moment in the suite currently goes through the
 * HOST's approval seam (`ctx.get('approval')`), which works in a terminal and
 * not on a phone or in a headless session. This plugin gives the suite its own
 * seam: **ask / notify / progress**, with pluggable channels, one-shot tokens,
 * a decision ledger and fail-closed timeouts.
 *
 * Responsibilities:
 *  - provide the `interaction` service (registry) so a channel plugin — an IM
 *    bridge, a web UI, a test double — can register itself:
 *    `register({ name, send, wait, describe })`;
 *  - register `interaction_ask` / `interaction_notify` / `interaction_progress`
 *    / `interaction_status`: the four model-facing tools, fail closed, Chinese
 *    reports, each ending with a 下一步 line;
 *  - keep the append-only ledger (`<repo>/.dsh/interaction/decisions.jsonl`) and
 *    the project approver list (`<repo>/.dsh/interaction-approvers.txt`) — both
 *    inside `dsh-spec-gate`'s trust root, so the model cannot edit either;
 *  - state the honest limits in the prompt section: a channel that cannot answer
 *    makes `interaction_ask` REFUSE, and a ledger row records what happened
 *    without granting anything.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.provide('interaction', registry)  cordis v4 service registration
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-interaction-gate
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, type AgentLike } from 'dsh-eng-core'
import { createInteractionRegistry } from './channels.js'
import { resolveConfig, resolveEffectiveConfig, type EffectiveConfig, type InteractionGateConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'
import type { InteractionRegistry } from './channels.js'

export const name = 'dsh-interaction-gate'

/** Only the two services this plugin actually touches (`interaction` is provided, not injected). */
export const inject = ['tools', 'systemPrompt']

/** The service name channel plugins consume. */
export const PROVIDED_SERVICE = 'interaction'

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assembly?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    get: (name: string) => unknown
    provide?: (name: string, value: unknown) => unknown
    effect: (execute: () => (() => void) | void) => void
}

export { resolveConfig, resolveEffectiveConfig, createInteractionRegistry }
export type { EffectiveConfig, InteractionGateConfig, InteractionRegistry }

/** The log file the raw row names, before validation (so config problems have a sink). */
function rawLogFile(config: unknown): string {
    const value = (config as { logFile?: unknown } | undefined)?.logFile
    return typeof value === 'string' && value.trim() !== '' ? value : '~/.dsh/interaction-gate.log'
}

/**
 * Register the plugin.
 * @param ctx - the cordis context.
 * @param config - the loader row's `config` value (untrusted).
 */
export function apply(ctx: Context, config: unknown = {}): void {
    const log = createLogger({
        tag: name,
        file: expandHome(rawLogFile(config)),
        ...(typeof (config as { logFileTemplate?: unknown } | undefined)?.logFileTemplate === 'string'
            ? { template: (config as { logFileTemplate: string }).logFileTemplate }
            : {}),
    })
    let resolved: InteractionGateConfig
    try {
        resolved = resolveConfig(config, (message) => log.warn(message))
    } catch (error) {
        log.error('cannot resolve the plugin configuration:', error)
        return
    }
    if (!resolved.enabled) {
        log.info('disabled by the host (enabled=false)')
        return
    }
    try {
        const context = ctx as unknown as ContextLike
        const logger = createLogger({
            tag: name,
            file: expandHome(resolved.logFile),
            ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
        })
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger })
        const registry = createInteractionRegistry({ logger })
        // A workspace-independent ledger (an absolute profile path) can be read
        // without a session context, so `interaction.pending()` reports asks
        // that are still waiting even before any tool of this process ran.
        const absoluteLedger = expandHome(resolved.ledgerFile)
        if (path.isAbsolute(absoluteLedger)) registry.trackLedger(absoluteLedger)

        // The profile row is the ceiling; a workspace refines it through its own
        // `.dsh/interaction-gate.json`, resolved per call (a profile serves many
        // repositories at once).
        const configFor = (agent: AgentLike | undefined): EffectiveConfig => {
            const cwd = agent?.session?.header?.cwd
            if (typeof cwd !== 'string' || cwd === '') return { config: resolved, source: 'profile', file: '', problems: [] }
            try {
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)
            } catch (error) {
                logger.warn('cannot resolve the project configuration:', error)
                return { config: resolved, source: 'profile', file: '', problems: [] }
            }
        }

        const deps: ToolDeps = {
            config: resolved,
            configFor,
            stores,
            registry,
            logger,
            now: () => Date.now(),
        }

        const disposers: (() => void)[] = []

        // --- the service channel plugins register with -------------------------
        let serviceState: string
        if (typeof context.provide !== 'function') {
            serviceState = 'unavailable(no ctx.provide)'
            logger.warn('the runtime exposes no ctx.provide: channel plugins cannot register (only pre-registered channels would work)')
        } else {
            try {
                const dispose = context.provide(PROVIDED_SERVICE, registry)
                if (typeof dispose === 'function') disposers.push(dispose as () => void)
                serviceState = 'on'
            } catch (error) {
                serviceState = 'failed'
                logger.error('cannot provide the interaction service:', error)
            }
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) logger.warn(`tools that failed to register: ${tools.failed.join(', ')}`)
        disposers.push(...tools.disposers)

        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Rendered per assembly: it carries the provenance of THIS
                    // workspace's configuration and the LIVE channel
                    // capabilities, not a process-wide guess.
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            const effective = configFor(scope)
                            return sectionText(effective, registry.list(), effective.problems)
                        } catch {
                            return sectionText({ config: resolved, source: 'profile', file: '', problems: [] }, registry.list())
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
                    logger.warn('disposer failed:', error)
                }
            }
        })

        logger.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}${tools.failed.length === 0 ? '' : `; failed: ${tools.failed.join(', ')}`}; ` +
                `service=${serviceState}; ledger=${resolved.ledgerFile}; approvers=${resolved.approversFile}${resolved.requireApproverList ? '(required)' : ''}; ` +
                `askTimeout=${resolved.askTimeoutMs}ms; notifyLevels=${resolved.notifyLevels.join(',')}; prompt=${resolved.prompt.enabled})`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

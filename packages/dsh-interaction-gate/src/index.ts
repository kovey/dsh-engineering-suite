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
 *  - keep the ask OUTBOX (`<repo>/.dsh/interaction/outbox.jsonl`): the intent of
 *    a question is written BEFORE the channel is touched, every later transition
 *    is its own row, and a replay settles what can never be asked again instead
 *    of asking a second time (see `outbox.ts` for the exact rules);
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
import { createAttentionSource, missionFactsOf, type AttentionSource } from './attention.js'
import { createInteractionRegistry } from './channels.js'
import { resolveConfig, resolveEffectiveConfig, type EffectiveConfig, type InteractionGateConfig } from './config.js'
import { installImChannel, type ImBinding, type ImInject } from './im-binding.js'
import { createOutbox, describeReplay, type Outbox } from './outbox.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { artifactPathOf, registerTools, type ToolDeps } from './tools.js'
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
    /** cordis's reactive dependency mechanism (see `im-binding.ts`). */
    inject?: ImInject
}

export { resolveConfig, resolveEffectiveConfig, createInteractionRegistry }
export { describeIm, imLogLine } from './channels.js'
export { CHAT_CHANNEL_NAME, CHAT_API_MIN_VERSION, CHAT_SERVICE, createChatChannel, imRequiredHint, probeChatInteraction } from './chat-channel.js'
export { installImChannel } from './im-binding.js'
export type { EffectiveConfig, InteractionGateConfig, InteractionRegistry }
export type { ImChannelMode, ImChannelReport, ImPhase } from './channels.js'
export type { ChatApiLike, ChatChannelHandle, ChatChannelOptions, ChatProbe } from './chat-channel.js'
export type { ImBinding, ImBindingLogger, ImBindingOptions, ImInjectionContext, ImInjectionHost, ImInject, ImTimerControl } from './im-binding.js'
export type { ImConfig } from './config.js'
export type { Attention, AttentionRecord, AttentionSource, AttentionState, WhyYou } from './attention.js'
export type { Outbox, OutboxRecord, OutboxReplayReport, OutboxRow, OutboxState, OutboxSummary } from './outbox.js'
export {
    DEFAULT_ATTENTION_FILE,
    DEFAULT_ATTENTION_MAX_AGE_MS,
    DEFAULT_WHY_YOU,
    WHY_YOU_VALUES,
    createAttentionSource,
    deriveRecords,
    describeWhyYou,
    missionFactsOf,
    readAttention,
} from './attention.js'
export { BACKOFF_BASE_MS, BACKOFF_MAX_MS, DEFAULT_OUTBOX_FILE, ORDER_FAILURE_LIMIT, createOutbox, describeReplay, outboxIdOf, readOutbox } from './outbox.js'

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

    // --- the optional IM channel: a FAST PATH + a reactive binding -----------
    // Bundle order does NOT decide apply order, and `dsh-chat-interaction`
    // provides its service at the end of its own apply. A one-shot probe here
    // used to freeze "local only" forever; the binding below (`installImChannel`)
    // probes now AND subscribes to the service via `ctx.inject`, so an
    // appearance after our apply still registers the channel. `off` never
    // touches the service at all (`installImChannel` returns before any lookup).
    const imMode = resolved.im.channel

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

        // --- the optional IM channel: fast path + reactive upgrade ------------
        // The binding owns BOTH directions: register when the service appears
        // (now or later, via ctx.inject) and unregister when it goes away.
        // Nothing in `apply` freezes the startup observation.
        const imBinding: ImBinding = installImChannel(ctx as unknown as { get: (name: string) => unknown; inject?: ImInject }, {
            mode: imMode,
            ...(resolved.im.channelId === undefined ? {} : { channelId: resolved.im.channelId }),
            requiredWaitMs: resolved.im.requiredWaitMs,
            askTimeoutMs: resolved.askTimeoutMs,
            redactPatterns: resolved.redactPatterns,
            registry,
            logger,
        })

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

        // One outbox handle per outbox FILE, for the lifetime of this plugin
        // instance: the file is the truth, the handle only carries the live
        // payloads of questions that are being asked right now.
        const outboxes = new Map<string, Outbox>()
        const outboxFor = (cwd: string, config: InteractionGateConfig): Outbox => {
            const file = artifactPathOf(cwd, config.outboxFile)
            const cached = outboxes.get(file)
            if (cached !== undefined) return cached
            const created = createOutbox({
                file,
                now: () => Date.now(),
                note: (message) => registry.reportProblem(message),
            })
            outboxes.set(file, created)
            return created
        }

        // One attention sidecar per (ledger, file) pair, for the lifetime of this
        // plugin instance: the files are the truth, the cache only keeps two tool
        // calls from parsing the same rows twice. Everything an attention IS
        // (open / answered / superseded / withdrawn) stays derived on read; the
        // sidecar carries only `whyYou`, the closing transitions and the pause
        // interval.
        const attentionSources = new Map<string, AttentionSource>()
        const attentionFor = (cwd: string, config: InteractionGateConfig): AttentionSource => {
            const ledgerFile = artifactPathOf(cwd, config.ledgerFile)
            const file = artifactPathOf(cwd, config.attentionFile)
            const key = `${ledgerFile}\u0000${file}`
            const cached = attentionSources.get(key)
            if (cached !== undefined) return cached
            const created = createAttentionSource({
                file,
                ledgerFile,
                now: () => Date.now(),
                defaultWindowMs: config.askTimeoutMs,
                maxAgeMs: config.attentionMaxAgeMs,
                mission: (missionId) => {
                    try {
                        return missionFactsOf(stores.for(cwd), missionId)
                    } catch (error) {
                        logger.warn(`attention：读取 mission ${missionId} 的状态失败：${error instanceof Error ? error.message : String(error)}`)
                        return undefined
                    }
                },
                note: (message) => registry.reportProblem(message),
            })
            attentionSources.set(key, created)
            return created
        }

        const deps: ToolDeps = {
            config: resolved,
            configFor,
            stores,
            registry,
            outboxFor,
            attentionFor,
            logger,
            now: () => Date.now(),
        }

        const disposers: (() => void)[] = []
        // The reactive binding is torn down with the plugin: the channel is
        // unregistered, the bounded window cleared, the subscription dropped.
        disposers.push(() => imBinding.dispose())

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

        // Replay on plugin apply — possible only when the outbox path is
        // ABSOLUTE (a profile that names one workspace). Otherwise the plugin
        // does not know a workspace at apply time (one profile serves many
        // repositories: guessing one would settle another repo's questions), and
        // the first tool call that knows a workspace replays instead. An idle
        // session therefore does not retry until something runs — the honest
        // boundary of a session-scoped plugin that is not a daemon.
        // The attention sidecar is attachable without a session context only when
        // BOTH paths are absolute (a profile that names one workspace); otherwise
        // the first tool call that knows a workspace attaches it, and
        // `attentions()` honestly reports nothing until then (the doctor renders
        // that as `unknown`, never as "nobody is waiting").
        const absoluteAttention = expandHome(resolved.attentionFile)
        if (path.isAbsolute(absoluteLedger) && path.isAbsolute(absoluteAttention)) {
            try {
                registry.attachAttention(attentionFor('', resolved))
            } catch (error) {
                logger.warn('cannot attach the attention sidecar:', error)
            }
        }

        const absoluteOutbox = expandHome(resolved.outboxFile)
        if (path.isAbsolute(absoluteOutbox)) {
            void outboxFor('', { ...resolved, outboxFile: absoluteOutbox })
                .replay('apply')
                .then((report) => {
                    if (report.considered > 0) logger.info(describeReplay(report))
                })
                .catch((error: unknown) => logger.warn('outbox 重放失败：', error))
        }

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

        const imFinal = imBinding.report()
        logger.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}${tools.failed.length === 0 ? '' : `; failed: ${tools.failed.join(', ')}`}; ` +
                `service=${serviceState}; ledger=${resolved.ledgerFile}; outbox=${resolved.outboxFile}; approvers=${resolved.approversFile}${resolved.requireApproverList ? '(required)' : ''}; ` +
                `askTimeout=${resolved.askTimeoutMs}ms; notifyLevels=${resolved.notifyLevels.join(',')}; prompt=${resolved.prompt.enabled}; ` +
                `im=${imFinal.registered ? `chat-interaction(api v${imFinal.apiVersion})` : imFinal.phase}(im.channel=${imMode}${imMode === 'required' ? `; requiredWaitMs=${resolved.im.requiredWaitMs}` : ''}))`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

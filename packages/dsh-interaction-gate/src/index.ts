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
import { createInteractionRegistry, imLogLine, type ImChannelReport } from './channels.js'
import { CHAT_CHANNEL_NAME, createChatChannel, imRequiredHint, probeChatInteraction, type ChatProbe } from './chat-channel.js'
import { resolveConfig, resolveEffectiveConfig, type EffectiveConfig, type InteractionGateConfig } from './config.js'
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
}

export { resolveConfig, resolveEffectiveConfig, createInteractionRegistry }
export { describeIm, imLogLine } from './channels.js'
export { CHAT_CHANNEL_NAME, CHAT_API_MIN_VERSION, CHAT_SERVICE, createChatChannel, imRequiredHint, probeChatInteraction } from './chat-channel.js'
export type { EffectiveConfig, InteractionGateConfig, InteractionRegistry }
export type { ImChannelMode, ImChannelReport } from './channels.js'
export type { ChatApiLike, ChatChannelHandle, ChatChannelOptions, ChatProbe } from './chat-channel.js'
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

    // --- the optional IM channel: probe BEFORE anything is registered ---------
    // `off` never touches the service at all (today's behaviour, byte for byte):
    // no lookup, no property read, no method call. `auto` and `required` probe
    // through the same total function — a throwing accessor, an old apiVersion
    // and a partial object all mean "no IM channel", never a crash.
    const imMode = resolved.im.channel
    let imProbe: ChatProbe | undefined
    if (imMode !== 'off') {
        const getter = (ctx as unknown as Partial<ContextLike>).get
        imProbe =
            typeof getter === 'function'
                ? probeChatInteraction((service) => getter.call(ctx, service))
                : { ok: false, reason: '运行时没有 ctx.get（无法查找 chatInteraction 服务）' }
    }
    if (imMode === 'required' && imProbe !== undefined && !imProbe.ok) {
        // Refusing to run is the point of `required`: silently falling back to
        // "no IM" would let every gate ask a human nobody can reach.
        log.error(imRequiredHint(imProbe.reason))
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

        // --- the optional IM channel: register it over the verified api --------
        let imReport: ImChannelReport
        if (imMode === 'off') {
            imReport = { mode: 'off', registered: false, reason: '宿主未启用（im.channel=off）' }
        } else if (imProbe === undefined || !imProbe.ok) {
            imReport = { mode: imMode, registered: false, reason: imProbe === undefined ? '未探测' : imProbe.reason }
            // "Not installed" is a fact the doctor must state, not an absence:
            // `im()` is the authoritative line, and the bounded problem list
            // carries the same reason for anyone reading only `problems()`.
            registry.reportProblem(`IM 通道不可用（im.channel=${imMode}）：${imReport.reason}（本次仅本地通道）`)
        } else {
            try {
                const handle = createChatChannel({
                    api: imProbe.api,
                    ...(resolved.im.channelId === undefined ? {} : { channelId: resolved.im.channelId }),
                    // The IM api gets the host ceiling as its own deadline; a tool
                    // that asks for less still ends earlier, because `wait()` uses
                    // the registry's remaining budget and aborts this ask.
                    askTimeoutMs: resolved.askTimeoutMs,
                    redactPatterns: resolved.redactPatterns,
                    logger,
                    note: (message) => registry.reportProblem(message),
                })
                const unregister = registry.register(handle.channel)
                if (registry.get(CHAT_CHANNEL_NAME) !== handle.channel) {
                    handle.dispose()
                    imReport = { mode: imMode, registered: false, reason: '注册被拒绝（同名通道已存在或通道形状非法）' }
                    registry.reportProblem(`IM 通道注册被拒绝：${imReport.reason}`)
                } else {
                    disposers.push(() => {
                        unregister()
                        handle.dispose()
                    })
                    imReport = {
                        mode: imMode,
                        registered: true,
                        name: CHAT_CHANNEL_NAME,
                        apiVersion: imProbe.apiVersion,
                        ...(imProbe.pluginVersion === undefined ? {} : { pluginVersion: imProbe.pluginVersion }),
                        ...(resolved.im.channelId === undefined ? {} : { channelId: resolved.im.channelId }),
                        reason: `chat-interaction api v${imProbe.apiVersion} 可用`,
                    }
                }
            } catch (error) {
                imReport = { mode: imMode, registered: false, reason: `创建 IM 通道适配器失败：${error instanceof Error ? error.message : String(error)}` }
                registry.reportProblem(`IM 通道不可用：${imReport.reason}`)
            }
        }
        if (imMode === 'required' && !imReport.registered) {
            logger.error(imRequiredHint(imReport.reason))
            return
        }
        registry.setIm(imReport)
        logger.info(imLogLine(imReport))

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

        logger.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}${tools.failed.length === 0 ? '' : `; failed: ${tools.failed.join(', ')}`}; ` +
                `service=${serviceState}; ledger=${resolved.ledgerFile}; outbox=${resolved.outboxFile}; approvers=${resolved.approversFile}${resolved.requireApproverList ? '(required)' : ''}; ` +
                `askTimeout=${resolved.askTimeoutMs}ms; notifyLevels=${resolved.notifyLevels.join(',')}; prompt=${resolved.prompt.enabled}; ` +
                `im=${imReport.registered ? `chat-interaction(api v${imReport.apiVersion})` : 'local'}(im.channel=${imMode}))`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

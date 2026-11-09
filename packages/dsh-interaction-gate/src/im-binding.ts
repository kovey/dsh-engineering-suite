/**
 * The optional IM channel, bound to the `chatInteraction` service REACTIVELY.
 *
 * Why this file exists
 * --------------------
 * Bundle order does not decide apply order: the suite's bundles may be applied
 * BEFORE `dsh-chat-interaction`, and that plugin `provide`s its service at the
 * END of its own `apply`. A startup probe therefore observes "no IM plugin" in a
 * perfectly valid deployment. The previous version FROZE that observation and
 * registered "local only" forever — deterministic, not flaky: whoever applies
 * first lost the IM channel for the life of the process.
 *
 * So the probe is only the FAST PATH. The authority is cordis's reactive
 * dependency mechanism: `ctx.inject(['chatInteraction'], cb)` runs `cb` when the
 * service appears — however long after our `apply` — and runs the callback's
 * disposer when the service goes away (unloaded, or replaced by another
 * provider). The callback registers/unregisters this plugin's
 * `chat-interaction` channel; nothing here freezes the startup observation.
 *
 * The `im.channel` modes keep their meaning:
 *
 *  - `auto` (default): use the channel whenever it becomes available, local
 *    otherwise; the transition is logged once.
 *  - `off`: NEVER touch the service — no `ctx.get`, no property read, no
 *    subscription at all. This module does not even call `host.get`/`host.inject`
 *    for `off`; the Proxy-based test proves zero touches.
 *  - `required`: the service must end up present. Refusing at `apply` would
 *    reject a correctly configured deployment under the ordering bug, so a
 *    BOUNDED window (config `im.requiredWaitMs`, default 5 s) is observed. When
 *    it closes without the service the plugin refuses loudly: the reason goes
 *    to `problems()`, `interaction_ask` refuses with the install hint, and a
 *    local channel is never silently used as a substitute. A late arrival still
 *    wins: the hook registers and clears the refusal.
 *
 * Fail-closed boundaries kept from the old probe: only `api.apiVersion >= 1`
 * with an `ask()` is usable; an older/invalid/throwing service is treated as
 * absent (and logged), and is picked up when it is replaced by a valid one. If
 * the service is withdrawn, the channel is unregistered, its in-flight waits are
 * aborted (the ask ends as a recorded refusal, never a hang), `auto` falls back
 * to local and `required` refuses asks; a re-provide registers again.
 *
 * @module dsh-interaction-gate/im-binding
 */

import type { ImChannelMode, ImChannelReport, ImPhase, InteractionRegistry } from './channels.js'
import { imLogLine } from './channels.js'
import {
    CHAT_CHANNEL_NAME,
    CHAT_SERVICE,
    createChatChannel,
    imRequiredHint,
    probeChatInteraction,
    type ChatApiLike,
    type ChatChannelHandle,
    type ChatProbe,
} from './chat-channel.js'
import { DEFAULT_IM_REQUIRED_WAIT_MS } from './config.js'

/** The slice of the plugin logger this module needs. */
export interface ImBindingLogger {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string) => void
}

/** What an injected context must expose (the runtime's service accessor). */
export interface ImInjectionContext {
    get: (name: string) => unknown
}

/**
 * The reactive mechanism: cordis's `ctx.inject(deps, callback)`.
 *
 * Structural on purpose — the plugin is assembled with a small structural view
 * of the host in tests, and the callback is invoked by the host (never by this
 * module). The returned value is the host's subscription handle: a disposer
 * function, or an object with `dispose()`.
 */
export type ImInject = (deps: string[], callback: (ctx: ImInjectionContext) => unknown) => unknown

/** The narrow host view the binding needs (`ctx.get` + optional `ctx.inject`). */
export interface ImInjectionHost {
    get: (name: string) => unknown
    inject?: ImInject
}

/** Injected timer controls (tests fire the bounded window deterministically). */
export interface ImTimerControl {
    setTimeout: (callback: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
}

/** Options for {@link installImChannel}. */
export interface ImBindingOptions {
    /** The host's `im.channel` mode. */
    mode: ImChannelMode
    /** Pinned IM channel (`im.channelId`), when configured. */
    channelId?: string
    /** The `required` bounded window in ms (default {@link DEFAULT_IM_REQUIRED_WAIT_MS}). */
    requiredWaitMs?: number
    /**
     * The host's `im.approvalChatId` (P0): the ONE conversation approvals go to.
     * `''` = not configured = today's behaviour (the api resolves its target).
     */
    approvalChatId?: string
    /** The host's `im.p2pOnly` (reporting only; the per-answer check is in `tools.ts`). */
    p2pOnly?: boolean
    /** The host's ask deadline handed to the adapter. */
    askTimeoutMs: number
    /** Host `redactPatterns` (built-in credential rules always apply too). */
    redactPatterns?: readonly string[]
    /** The registry this channel registers with. */
    registry: InteractionRegistry
    logger: ImBindingLogger
    /** Injected timers (no clock/timer in unit tests). */
    timers?: ImTimerControl
}

/** The handle `apply` owns: read the live verdict, tear the binding down. */
export interface ImBinding {
    /** The CURRENT verdict (updated on every phase transition). */
    report: () => ImChannelReport
    /** Unregister the channel, clear the window and drop the subscription. */
    dispose: () => void
    /**
     * Lazy fallback for a provider whose `provide` never makes the service
     * available to `inject` (see the implementation comment). Safe to call often;
     * `interaction_status` and `interaction_ask` call it before deciding.
     * @returns whether the channel is (now) registered.
     */
    refresh: () => boolean
}

const REAL_TIMERS: ImTimerControl = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
}

/** A timer that must not keep the process alive on its own. */
function unrefTimer(handle: unknown): void {
    if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return
    const unref = (handle as { unref?: unknown }).unref
    if (typeof unref !== 'function') return
    try {
        ;(unref as () => void).call(handle)
    } catch {
        // A timer implementation without a working unref changes nothing here.
    }
}

/** Parse a promise-like subscription handle, if the host returned one. */
function runSubscription(handle: unknown): void {
    if (typeof handle === 'function') {
        ;(handle as () => void)()
        return
    }
    if (typeof handle !== 'object' || handle === null) return
    const dispose = (handle as { dispose?: unknown }).dispose
    if (typeof dispose === 'function') void (dispose as () => unknown).call(handle)
}

/**
 * Bind the optional IM channel to `chatInteraction`, reactively.
 *
 * @param host - the runtime (`ctx.get`, and `ctx.inject` when available).
 * @param options - mode, pinned channel, window, registry and timers.
 * @returns the binding (live report + teardown); never throws into `apply`.
 */
export function installImChannel(host: ImInjectionHost, options: ImBindingOptions): ImBinding {
    const mode = options.mode
    const waitMs = Math.max(0, Math.floor(options.requiredWaitMs ?? DEFAULT_IM_REQUIRED_WAIT_MS))
    const logger = options.logger
    const registry = options.registry
    const timers = options.timers ?? REAL_TIMERS
    const channelId = options.channelId

    let phase: ImPhase = mode === 'off' ? 'off' : 'absent'
    let appeared = false
    let reason = mode === 'off' ? '宿主未启用（im.channel=off）' : 'chatInteraction 尚未出现'
    let handle: ChatChannelHandle | undefined
    let unregister: (() => void) | undefined
    let registeredApi: ChatApiLike | undefined
    let apiVersion: number | undefined
    let pluginVersion: string | undefined
    let windowHandle: unknown
    let subscription: unknown
    let lastLog = ''
    let disposed = false
    const reported = new Set<string>()

    const report = (): ImChannelReport => {
        const base: ImChannelReport = {
            mode,
            phase,
            registered: phase === 'registered',
            ...(appeared ? { appeared: true } : {}),
            ...(mode === 'required' ? { requiredWaitMs: waitMs } : {}),
            // The approval target is stated whether or not the channel is
            // registered: "IM 未注册 + 目标已配置" is a different fact from
            // "IM 未注册、也没配目标", and the doctor may show either.
            approvalChatId: options.approvalChatId ?? '',
            p2pOnly: options.p2pOnly === true,
            reason,
        }
        if (phase !== 'registered') return base
        return {
            ...base,
            name: CHAT_CHANNEL_NAME,
            ...(apiVersion === undefined ? {} : { apiVersion }),
            ...(pluginVersion === undefined ? {} : { pluginVersion }),
            ...(channelId === undefined ? {} : { channelId }),
            // What we observed about REFUSED answer attempts. `upstream` says
            // whether this deployment can see them at all — an empty list from a
            // 'hooked' channel means "nobody tried", from 'unavailable' it means
            // "not observable", and the two must never read the same.
            ...(handle === undefined ? {} : { ignoredAnswers: handle.ignored() }),
        }
    }

    /** Publish the verdict on the registry (the doctor reads it live). */
    const publish = (): ImChannelReport => {
        const current = report()
        registry.setIm(current)
        return current
    }

    /** Log the active path, once per transition (identical lines are deduped). */
    const logTransition = (): void => {
        const line = imLogLine(report())
        if (line === lastLog) return
        lastLog = line
        logger.info(line)
    }

    /** Record one defect, once per distinct message (bounded by the registry). */
    const note = (message: string): void => {
        if (reported.has(message)) return
        reported.add(message)
        registry.reportProblem(message)
    }

    const clearWindow = (): void => {
        if (windowHandle === undefined) return
        const scheduled = windowHandle
        windowHandle = undefined
        try {
            timers.clearTimeout(scheduled)
        } catch (error) {
            logger.warn(`清除 im.channel=required 的等待定时器失败：${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /** Close a `required` window that ended without a usable service. */
    const refuseWindow = (): void => {
        clearWindow()
        phase = 'refused'
        reason = `等待窗口 ${waitMs}ms 内 chatInteraction 没有出现（需要 dsh-chat-interaction@>=0.3.0，apiVersion>=1）`
        note(`IM 通道不可用（im.channel=required）：${reason}——interaction_ask 将拒绝（不会静默走本地通道）`)
        publish()
        logTransition()
        // The full install/upgrade hint, once, in the log: the operator should
        // not have to read the source to learn what is missing.
        logger.error(imRequiredHint(reason))
    }

    /** Start the bounded window of `im.channel=required` (idempotent). */
    const startWindow = (): void => {
        if (disposed || phase !== 'waiting' || windowHandle !== undefined) return
        if (waitMs === 0) {
            refuseWindow()
            return
        }
        const scheduled = timers.setTimeout(() => {
            windowHandle = undefined
            if (disposed || phase !== 'waiting') return
            refuseWindow()
        }, waitMs)
        windowHandle = scheduled
        unrefTimer(scheduled)
    }

    /** Unregister the current channel, if any. Aborts its in-flight waits. */
    const detach = (announce: boolean): void => {
        const old = handle
        const off = unregister
        handle = undefined
        unregister = undefined
        registeredApi = undefined
        apiVersion = undefined
        pluginVersion = undefined
        if (off !== undefined) {
            try {
                off()
            } catch (error) {
                logger.warn(`注销 chat-interaction 通道失败：${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (old !== undefined) {
            try {
                // Aborts every live wait: the ask records a refusal instead of
                // hanging on a channel that no longer exists.
                old.dispose()
            } catch (error) {
                logger.warn(`释放 chat-interaction 通道失败：${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (!announce || disposed) return
        phase = mode === 'required' ? 'refused' : 'absent'
        reason =
            mode === 'required'
                ? 'chatInteraction 服务在注册后消失（im.channel=required）'
                : 'chatInteraction 服务已撤销（提供者卸载/重启）'
        if (mode === 'required') {
            note(`IM 通道不可用（im.channel=required）：${reason}——interaction_ask 将拒绝（不会静默走本地通道）`)
        }
        publish()
        logTransition()
    }

    /** Register the channel over a verified api (replacing an older one). */
    const attach = (probe: Extract<ChatProbe, { ok: true }>): void => {
        if (disposed) return
        if (phase === 'registered' && registeredApi === probe.api) return
        const wasRefused = phase === 'refused'
        if (handle !== undefined) detach(false)
        let created: ChatChannelHandle
        try {
            created = createChatChannel({
                api: probe.api,
                ...(channelId === undefined ? {} : { channelId }),
                ...(options.approvalChatId === undefined ? {} : { approvalChatId: options.approvalChatId }),
                ...(options.p2pOnly === undefined ? {} : { p2pOnly: options.p2pOnly }),
                askTimeoutMs: options.askTimeoutMs,
                ...(options.redactPatterns === undefined ? {} : { redactPatterns: options.redactPatterns }),
                logger,
                note: (message) => note(message),
                // Re-publish the verdict when a refused attempt is recorded, so
                // `interaction_status` shows it without waiting for a phase
                // change. `publish` does not log, so this cannot spam the log.
                onIgnored: () => {
                    if (!disposed) publish()
                },
            })
        } catch (error) {
            phase = mode === 'required' ? 'refused' : 'absent'
            reason = `创建 IM 通道适配器失败：${error instanceof Error ? error.message : String(error)}`
            note(`IM 通道不可用（im.channel=${mode}）：${reason}`)
            publish()
            logTransition()
            return
        }
        const off = registry.register(created.channel)
        if (registry.get(CHAT_CHANNEL_NAME) !== created.channel) {
            // A same-name channel exists (another owner): never silently replace
            // it, and never claim to be the registered one.
            created.dispose()
            off()
            phase = mode === 'required' ? 'refused' : 'absent'
            reason = '注册被拒绝（同名通道已存在或通道形状非法）'
            note(`IM 通道注册被拒绝：${reason}`)
            publish()
            logTransition()
            return
        }
        handle = created
        unregister = off
        registeredApi = probe.api
        apiVersion = probe.apiVersion
        pluginVersion = probe.pluginVersion
        phase = 'registered'
        reason = `chat-interaction api v${probe.apiVersion} 可用`
        clearWindow()
        if (wasRefused) {
            // A late arrival clears the refusal: state the recovery next to the
            // refusal it supersedes, so `problems()` is readable as a timeline.
            note(`IM 通道已恢复：chatInteraction api v${probe.apiVersion} 已在迟到出现后注册（im.channel=required 的拒绝已清除）`)
        }
        publish()
        logTransition()
    }

    /** Handle one callback of the reactive hook (service appeared / replaced). */
    const onAvailable = (injected: ImInjectionContext | undefined): (() => void) => {
        if (disposed) return () => undefined
        // Prefer the INJECTED context's accessor: it is the value the host just
        // made available, and it keeps a test's outer `ctx.get` spy at one call.
        const read =
            injected !== undefined && injected !== null && typeof injected.get === 'function'
                ? (name: string): unknown => injected.get.call(injected, name)
                : (name: string): unknown => host.get(name)
        let probe: ChatProbe
        try {
            probe = probeChatInteraction(read)
        } catch (error) {
            // probeChatInteraction is total; this is the belt for a hostile host.
            probe = { ok: false, reason: `探测 chatInteraction 抛错：${error instanceof Error ? error.message : String(error)}`, appeared: true }
        }
        if (probe.ok) {
            appeared = true
            attach(probe)
            const owned = probe.api
            return () => {
                if (disposed) return
                if (registeredApi === owned) detach(true)
            }
        }
        if (probe.appeared === true) appeared = true
        if (phase !== 'registered' && phase !== 'refused') {
            // The service is there but unusable (older/partial/throwing): keep
            // waiting/log the fact; it is NOT a permanent verdict.
            phase = mode === 'required' ? 'waiting' : 'absent'
            reason = probe.reason
            note(
                `IM 通道不可用（im.channel=${mode}）：chatInteraction ${probe.appeared === true ? '已出现但不可用' : '尚不可用'}：${probe.reason}——` +
                    (mode === 'required'
                        ? `等待窗口 ${waitMs}ms 内若变成可用会自动注册`
                        : '本次仅本地通道；服务一旦可用会自动注册'),
            )
            publish()
            logTransition()
        }
        return () => {
            // An unusable service went away: nothing was registered.
        }
    }

    /**
     * Lazy fallback: register NOW if the service is readable but the reactive
     * hook never fired.
     *
     * `ctx.inject` is the correct mechanism, but it can be starved by the
     * provider: passing `true` as `ctx.provide`'s third argument makes cordis
     * treat it as the availability predicate, the call throws, and cordis then
     * deletes the dependency from the consumer store — so the hook never runs
     * while `ctx.get` still returns the value (dsh-chat-interaction 0.3.1 does
     * exactly this, verified against cordis 4.0.5). Reading the same value on
     * demand turns that half-broken state into a working channel without waiting
     * for the provider to be fixed.
     *
     * Deliberately narrow: it never runs when `im.channel` is `off`, it only
     * adopts a service that passes the same apiVersion guard, and it registers
     * nothing when the service is genuinely absent. A fallback, not a
     * replacement: the reactive hook stays the primary path.
     * @returns whether the channel is (now) registered.
     */
    const refresh = (): boolean => {
        if (disposed) return false
        if (mode === 'off') return false
        if (phase === 'registered') return true
        function readService(name: string): unknown {
            return host.get(name)
        }
        let probe: ChatProbe
        try {
            probe = probeChatInteraction(readService)
        } catch (error) {
            probe = { ok: false, reason: `探测 chatInteraction 抛错：${error instanceof Error ? error.message : String(error)}`, appeared: true }
        }
        if (probe.ok) {
            appeared = true
            attach(probe)
            // Read through a call: `attach` mutates `phase`, which the compiler
            // cannot see after the early `return` narrowed the union above.
            const phaseNow = (): ImPhase => phase
            return phaseNow() === 'registered'
        }
        if (probe.appeared === true) appeared = true
        return false
    }

    /**
     * Subscribe to the service. `off` NEVER reaches this function (the caller
     * returns before it), so it neither looks the service up nor subscribes.
     */
    const subscribe = (): void => {
        if (typeof host.inject !== 'function') {
            if (phase !== 'registered') {
                logger.warn(
                    '运行时没有 ctx.inject：chatInteraction 在 apply 之后出现时无法自动注册（只有 apply 时已存在的服务会被接管）',
                )
            }
            return
        }
        try {
            subscription = host.inject([CHAT_SERVICE], (injected) => onAvailable(injected as ImInjectionContext | undefined))
        } catch (error) {
            logger.warn(`订阅 chatInteraction 服务失败：${error instanceof Error ? error.message : String(error)}`)
        }
    }

    // --- the fast path: the service may already be there ---------------------
    if (mode !== 'off') {
        let initial: ChatProbe
        try {
            initial = probeChatInteraction((name) => host.get(name))
        } catch (error) {
            initial = { ok: false, reason: `探测 chatInteraction 抛错：${error instanceof Error ? error.message : String(error)}` }
        }
        if (initial.ok) {
            appeared = true
            attach(initial)
        } else {
            if (initial.appeared === true) appeared = true
            phase = mode === 'required' ? 'waiting' : 'absent'
            reason = initial.reason
            // "Not usable right now" is a STATED fact, never a permanent verdict:
            // the reactive hook is what upgrades it when the service appears.
            note(
                `IM 通道不可用（im.channel=${mode}）：${initial.appeared === true ? 'chatInteraction 已出现但不可用：' : ''}${initial.reason}——` +
                    (mode === 'required'
                        ? `本次仅本地通道，等待窗口 ${waitMs}ms 内若出现会自动注册`
                        : '本次仅本地通道；服务一旦可用会自动注册'),
            )
            publish()
            logTransition()
        }
        subscribe()
        if (phase === 'waiting') startWindow()
    } else {
        publish()
        logTransition()
    }

    return {
        report,
        refresh,
        dispose: (): void => {
            if (disposed) return
            disposed = true
            clearWindow()
            const current = subscription
            subscription = undefined
            if (current !== undefined) {
                try {
                    runSubscription(current)
                } catch (error) {
                    logger.warn(`取消 chatInteraction 订阅失败：${error instanceof Error ? error.message : String(error)}`)
                }
            }
            detach(false)
        },
    }
}

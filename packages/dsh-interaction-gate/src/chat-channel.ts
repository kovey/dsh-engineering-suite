/**
 * The IM channel: the installed `dsh-chat-interaction` plugin's public API,
 * presented as a channel of THIS suite's `interaction` registry.
 *
 * Why this file exists
 * --------------------
 * The suite's gates already ask humans through `register/send/wait` (see
 * `channels.ts`), but until now every deployment had to write its own bridge to
 * an IM plugin — connection, dedupe, cards, waiting and one-shot button tokens
 * are exactly the things a gate plugin must not re-implement. The installed
 * `dsh-chat-interaction` (0.3.0+) exposes that infrastructure as a versioned
 * contract (`ctx.get('chatInteraction').api`, `apiVersion = 1`); this adapter
 * turns it into ONE `InteractionChannel` named `chat-interaction`, so every
 * `interaction_ask` in the suite routes through IM **without a single caller
 * changing**.
 *
 * The mapping (and why it is this way)
 * ------------------------------------
 *  - `send({kind:'ask'})` → `api.ask({channel?, title, body, options, timeoutMs})`.
 *    The IM plugin renders a card whose buttons are the declared option
 *    VALUES (it falls back to a numbered text menu when the channel has no
 *    cards) and binds them to a one-shot `ask:<nonce>:<value>` token, so a
 *    stale/forwarded/other-request card can never resolve this wait.
 *  - `wait(questionId)` → the answer of the ask that was started for that
 *    token. THIS suite's ledger token stays the identity of the question: the
 *    answer is handed back to `registry.awaitAnswer()`, which records it
 *    exactly like an answer from a local channel (`channel:
 *    "chat-interaction"`, the same decision vocabulary, the same approver
 *    checks, the same one-answer-per-token rule).
 *  - `describe()` → `canAsk: true`, `canNotify: false`. This channel carries
 *    QUESTIONS. Notifications and progress are the IM plugin's own job (and
 *    the suite keeps pushing them through its existing channels), so claiming
 *    `canNotify` would silently reroute them.
 *
 * Fail-closed rules (the reason the adapter exists instead of a raw call)
 * ----------------------------------------------------------------------
 *  1. A missing/older/partial/throwing service is "no IM channel", never a
 *     crash: {@link probeChatInteraction} answers with a Chinese reason and
 *     `apply` keeps working exactly as before (or refuses, in `required` mode).
 *  2. `api.ask` returning `{ok:false, code}` (timeout, channel-unsupported,
 *     no-target, send-failed, aborted, internal…) or any shape this file does
 *     not recognise resolves the wait with NO answer — the registry then ends
 *     the ask as `timeout`/`cancelled`/`unknown-token` and `interaction_ask`
 *     writes a `refused:<reason>` row and throws. Timeout is NOT consent:
 *     there is no path here that turns a non-answer into a decision.
 *  3. An answer that is not one of the declared option values is AMBIGUOUS: it
 *     is dropped (recorded as a problem) rather than guessed. The suite would
 *     reject it anyway; not returning it at all keeps "this channel never
 *     reports a decision it did not get" true even for a buggy/hostile api.
 *  4. One answer per suite token: the first terminal outcome consumes the
 *     token; a second wait on the same token (a replayed click, a duplicate
 *     answer) gets `null`, and `registry.awaitAnswer()` reports `unknown-token`.
 *  5. The payload is re-checked against the credential rules (built-ins +
 *     host `redactPatterns`) before it leaves the process; a hit REFUSES the
 *     send and records only the redacted rule/field/excerpt, never the value.
 *
 * Not done here on purpose: no inbound observation (`onInbound`), no `/command`
 * registration, no channel connection control, no `permission.bridgeHarnessApproval`.
 * Those belong to the IM plugin (it owns connection/dedupe/cards/waits) and to
 * the host; this file only routes questions through the documented `api`.
 *
 * @module dsh-interaction-gate/chat-channel
 */

import type { ImAskTarget, ImChannelReport, ImIgnoredAttempt, ImIgnoredReport, InteractionChannel, InteractionAnswer } from './channels.js'
import { checkOutgoing, compileRedactPatterns, describeHits, truncate, type SecretRule } from './redact.js'

/** The service the IM plugin provides. */
export const CHAT_SERVICE = 'chatInteraction'

/** The channel name this adapter registers under. */
export const CHAT_CHANNEL_NAME = 'chat-interaction'

/**
 * The contract version this adapter knows how to drive.
 *
 * `apiVersion` is the IM plugin's contract version (independent of its semver);
 * `< 1` means the version has no ask/send API at all.
 */
export const CHAT_API_MIN_VERSION = 1

/**
 * Structural view of `chatInteraction.api` (v1).
 *
 * Deliberately small and `unknown`-heavy: the api lives in another package
 * with its own release cadence, so every call is validated at runtime here.
 * Only `ask` is required — `channels`/`capabilities`/`authState`/`info` are
 * used for a preflight when present and skipped when a (still v1-compatible)
 * implementation does not expose them.
 */
export interface ChatApiLike {
    readonly apiVersion: number
    ask: (request: Record<string, unknown>) => unknown
    info?: () => unknown
    channels?: () => unknown
    capabilities?: (channel: string) => unknown
    authState?: (channel: string) => unknown
    /**
     * Optional (0.3.4+): observe answer attempts the plugin refused (a sender
     * outside `from`, a reply matching no option). Absent on an older upstream,
     * which is a LIMITATION to report — never a crash and never an error.
     */
    onAnswerIgnored?: (handler: (event: unknown) => void) => unknown
}

/** A usable service, or the reason there is none (never both). */
export type ChatProbe =
    | { ok: true; api: ChatApiLike; apiVersion: number; pluginVersion?: string }
    | {
          ok: false
          reason: string
          /**
           * `true` when a `chatInteraction` service EXISTS but is not usable
           * (older/invalid api, throwing accessor, partial object). The doctor
           * distinguishes "it never showed up" from "it showed up broken".
           */
          appeared?: boolean
      }

/** Render any thrown value as one short Chinese report line. */
function reasonOf(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Look up `ctx.get('chatInteraction')?.api` and decide whether it is the v1
 * contract this adapter can drive.
 *
 * Total by design: a throwing accessor, a non-object service, a partial object
 * and a too-old `apiVersion` are all `{ ok: false, reason }`. The reason names
 * what is missing so `interaction_status`/the log can state the fact instead of
 * leaving an absence to be interpreted.
 *
 * @param get - the runtime's service accessor (`(name) => ctx.get(name)`; a
 *   closure, so the caller's `this` is preserved).
 */
export function probeChatInteraction(get: (name: string) => unknown): ChatProbe {
    if (typeof get !== 'function') return { ok: false, reason: '运行时没有可用的服务访问器（ctx.get），无法查找 chatInteraction' }

    let layer: unknown
    try {
        layer = get(CHAT_SERVICE)
    } catch (error) {
        return { ok: false, reason: `读取服务 ctx.get("${CHAT_SERVICE}") 抛错：${reasonOf(error)}` }
    }
    if (layer === undefined || layer === null) {
        return { ok: false, reason: 'chat-interaction 未安装（服务 chatInteraction 不存在）' }
    }
    if (typeof layer !== 'object') {
        return { ok: false, reason: `chatInteraction 服务不是对象（收到 ${typeof layer}）`, appeared: true }
    }

    let api: unknown
    try {
        api = (layer as { api?: unknown }).api
    } catch (error) {
        return { ok: false, reason: `chatInteraction.api 的访问器抛错：${reasonOf(error)}`, appeared: true }
    }
    if (api === undefined || api === null) {
        return { ok: false, reason: 'chat-interaction 没有暴露 api（需要 0.3.0+：服务形状是 { api: { apiVersion, ask, … } }）', appeared: true }
    }
    if (typeof api !== 'object') {
        return { ok: false, reason: `chatInteraction.api 不是对象（收到 ${typeof api}）`, appeared: true }
    }

    let version: unknown
    try {
        version = (api as { apiVersion?: unknown }).apiVersion
    } catch (error) {
        return { ok: false, reason: `api.apiVersion 的访问器抛错：${reasonOf(error)}`, appeared: true }
    }
    if (typeof version !== 'number' || !Number.isFinite(version)) {
        return { ok: false, reason: `api.apiVersion 不是数字（收到 ${JSON.stringify(version)}），无法判断契约版本`, appeared: true }
    }
    if (version < CHAT_API_MIN_VERSION) {
        return { ok: false, reason: `chat-interaction 的 apiVersion=${version} 低于 ${CHAT_API_MIN_VERSION}（旧版本没有给其他插件用的问答 API）`, appeared: true }
    }

    let ask: unknown
    try {
        ask = (api as { ask?: unknown }).ask
    } catch (error) {
        return { ok: false, reason: `api.ask 的访问器抛错：${reasonOf(error)}`, appeared: true }
    }
    if (typeof ask !== 'function') {
        return { ok: false, reason: 'api 不完整：缺少 ask()（无法把提问发出去并等一个对得上令牌的回答）', appeared: true }
    }

    let pluginVersion: string | undefined
    try {
        if (typeof (api as { info?: unknown }).info === 'function') {
            const info = (api as { info: () => unknown }).info()
            if (isRecord(info) && typeof info['pluginVersion'] === 'string' && info['pluginVersion'] !== '') pluginVersion = info['pluginVersion']
        }
    } catch {
        // Informational only: a throwing info() must not cost us the channel.
    }

    return { ok: true, api: api as ChatApiLike, apiVersion: version, ...(pluginVersion === undefined ? {} : { pluginVersion }) }
}

/**
 * The refusal `apply` must produce when `im.channel = 'required'` and no usable
 * IM channel exists: what to install, which version, and that this run will not
 * silently degrade.
 * @param reason - the probe's reason (already Chinese).
 */
export function imRequiredHint(reason: string): string {
    return (
        `im.channel=required 但 IM 通道不可用：${reason}。` +
        '安装/升级：`npm i -g dsh-chat-interaction@>=0.3.0`（该版本起它通过服务 chatInteraction 暴露 apiVersion>=1 的 api），' +
        '并让宿主装配 dsh-chat-interaction 插件（渠道连接/去重/卡片/等待由它负责）；' +
        '参考 dsh-chat-interaction 的 UPGRADE.md 与本包 README 的「IM 通道」一节。' +
        '装好之前本插件**拒绝**以"没有 IM 通道"的方式运行（不会静默降级成纯本地）。'
    )
}

/** One live ask, keyed by THIS suite's one-shot token. */
interface LiveAsk {
    questionId: string
    /** The declared option values/labels this ask offered (empty = free text). */
    declared: { value: string; label: string }[]
    state: 'live' | 'settled' | 'abandoned'
    /** The terminal answer (null = no answer); set once, never rewritten. */
    result?: InteractionAnswer | null
    /** Why the ask produced no answer (the API's own reason, Chinese). */
    failure?: string
    /** Set while `registry.awaitAnswer()` is waiting; the first settle calls it. */
    settle?: (answer: InteractionAnswer | null) => void
    /** Epoch ms after which this ask can no longer produce an answer. */
    deadlineAt: number
    /** Aborts the IM plugin's own waiter on timeout/abort/dispose. */
    controller: AbortController
}

/** What the IM api's `ask` resolved to, normalised. */
interface AskOutcome {
    answer: InteractionAnswer | null
    /** Why there is no answer (Chinese, shown in `problems()`/the log). */
    reason?: string
}

/** The adapter handle: the channel plus the teardown `apply` owns. */
export interface ChatChannelHandle {
    channel: InteractionChannel
    dispose: () => void
    /**
     * What this process observed about REFUSED answer attempts (the upstream's
     * `onAnswerIgnored` hook). Always readable: `upstream: 'unavailable'` means
     * "not observable here", which the doctor states instead of implying
     * "nobody tried".
     */
    ignored: () => ImIgnoredReport
}

/** How many refused attempts the report keeps verbatim. */
export const MAX_IGNORED_RECENT = 5

/** Options for {@link createChatChannel}. */
export interface ChatChannelOptions {
    /** The verified `chatInteraction.api` (v1+). */
    api: ChatApiLike
    /**
     * Pin the IM channel name (`feishu`/`wecom`/…): config `im.channelId`.
     * Omitted = the api resolves its own active chat across channels.
     */
    channelId?: string
    /**
     * The configured approval target (`im.approvalChatId`), or `''`/absent.
     *
     * Two jobs: it is the CONVERSATION this channel reports (`chatId`, so the
     * outbox serializes the right chat instead of the channel NAME), and it is
     * what makes the adapter fail closed when an ask arrives without an explicit
     * target — a configured target must never be silently replaced by the api's
     * own `p2pChat || activeChat`.
     */
    approvalChatId?: string
    /** `im.p2pOnly`: only carried into the report (the check is per answer). */
    p2pOnly?: boolean
    /** The host's `askTimeoutMs` — the deadline the IM api is given. */
    askTimeoutMs: number
    /** Host `redactPatterns` (built-in credential rules always apply too). */
    redactPatterns?: readonly string[]
    /** Per-ask defects: the registry's `problems()` sink. */
    note?: (message: string) => void
    logger?: { warn: (message: string) => void }
    /** Called after one refused attempt was recorded (the report is re-published). */
    onIgnored?: () => void
    /** Injected clock (tests); no clock in the mapping itself. */
    now?: () => number
}

/** Tolerant parse of whatever `api.channels()` returned. */
function connectedChannels(list: unknown): { name: string; inbound: boolean }[] {
    if (!Array.isArray(list)) return []
    const out: { name: string; inbound: boolean }[] = []
    for (const entry of list) {
        if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['name'] === '') continue
        if (entry['connected'] !== true) continue
        const capabilities = isRecord(entry['capabilities']) ? entry['capabilities'] : {}
        out.push({ name: entry['name'], inbound: capabilities['inbound'] !== false })
    }
    return out
}

/**
 * Create the `chat-interaction` channel over a verified api.
 *
 * Every failure path is total: `send` returns `{ ok: false, error }` (the
 * registry/the ask tool record it) and `wait` resolves `null` (no answer). No
 * path invents a decision.
 */
export function createChatChannel(options: ChatChannelOptions): ChatChannelHandle {
    const now = options.now ?? ((): number => Date.now())
    const compiled = compileRedactPatterns([...(options.redactPatterns ?? [])])
    const rules: SecretRule[] = compiled.rules
    const asks = new Map<string, LiveAsk>()
    let disposed = false

    const note = (message: string): void => {
        options.note?.(message)
        options.logger?.warn(message)
    }
    for (const problem of compiled.problems) note(problem)

    // --- refused answer attempts (the upstream's onAnswerIgnored) ------------
    // "Someone tried to answer for the approver" must not look like a plain
    // timeout. The counts and the last few attempts go into the IM report that
    // `interaction_status` renders; the attempt's TEXT is not kept (it is not
    // needed to act on the event, and a refused message can still carry a
    // credential — the outgoing redaction layer takes the same position).
    const ignored: {
        upstream: 'hooked' | 'unavailable'
        total: number
        bySender: number
        byOptions: number
        recent: ImIgnoredAttempt[]
    } = { upstream: 'unavailable', total: 0, bySender: 0, byOptions: 0, recent: [] }

    const recordIgnored = (event: unknown): void => {
        if (disposed) return
        if (!isRecord(event)) {
            note('IM 报告了一条形状不可识别的"被拒绝的回答尝试"：无法读出原因/发起者，已忽略该事件（它不是决定）')
            return
        }
        const reason = typeof event['reason'] === 'string' && event['reason'] !== '' ? event['reason'] : 'unknown'
        const by = typeof event['by'] === 'string' && event['by'].trim() !== '' ? event['by'].trim() : undefined
        const chatId = typeof event['chatId'] === 'string' && event['chatId'] !== '' ? event['chatId'] : undefined
        const messageId = typeof event['messageId'] === 'string' && event['messageId'] !== '' ? event['messageId'] : undefined
        const at = typeof event['at'] === 'number' && Number.isFinite(event['at']) ? event['at'] : now()
        ignored.total += 1
        if (reason === 'sender-not-allowed') ignored.bySender += 1
        else if (reason === 'option-mismatch') ignored.byOptions += 1
        ignored.recent.push({
            at,
            reason,
            ...(chatId === undefined ? {} : { chatId }),
            ...(by === undefined ? {} : { by }),
            ...(messageId === undefined ? {} : { messageId }),
        })
        if (ignored.recent.length > MAX_IGNORED_RECENT) ignored.recent.shift()
        note(
            `IM 上有一条回答尝试被拒绝（${reason}）：发起者 ${by ?? '未提供身份'}，会话 ${chatId ?? '未提供'}——` +
                '它没有成为决定，提问仍在等待（这是"有人试过"，不是"没人回答"）',
        )
        options.onIgnored?.()
    }

    /** Parse a subscription handle into a disposer, when the api gives none. */
    const disposerOf = (handle: unknown): (() => void) | undefined => {
        const invoke = (call: () => unknown): (() => void) => () => {
            try {
                const result = call()
                if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
                    void (result as Promise<unknown>).catch(() => undefined)
                }
            } catch {
                // The subscription is being torn down anyway.
            }
        }
        if (typeof handle === 'function') return invoke(handle as () => unknown)
        if (isRecord(handle) && typeof handle['dispose'] === 'function') {
            const dispose = handle['dispose']
            return invoke(() => (dispose as () => unknown).call(handle))
        }
        return undefined
    }

    let unsubscribeIgnored: (() => void) | undefined
    if (typeof options.api.onAnswerIgnored === 'function') {
        try {
            unsubscribeIgnored = disposerOf(options.api.onAnswerIgnored((event: unknown) => recordIgnored(event)))
            // Subscribed is not the same as honoured: an unusable handler is
            // detected when the event arrives (recordIgnored above), not here.
            ignored.upstream = 'hooked'
        } catch (error) {
            note(
                `订阅 IM 的"被忽略回答"事件失败（api.onAnswerIgnored 抛错）：${reasonOf(error)}——` +
                    '本部署看不到"有人试过回答"，只能看到最终结果（不会因此崩溃，也不会因此放行）',
            )
        }
    }

    /** Forget asks whose deadline has passed and that nobody is waiting on. */
    const prune = (): void => {
        for (const [token, entry] of asks) {
            if (entry.state !== 'live' || entry.settle !== undefined) continue
            if (now() <= entry.deadlineAt + 1_000) continue
            entry.state = 'abandoned'
            try {
                entry.controller.abort()
            } catch {
                // The api's controller is not ours to trust; nothing to do.
            }
            asks.delete(token)
        }
    }

    /**
     * Preflight the api's own view of the channel. Cheap, synchronous and
     * fail-closed: asking a channel that is not connected (or cannot receive
     * replies, or has no active chat) wastes the human's deadline and would
     * end as an opaque timeout, so it is refused up front with the exact fix.
     *
     * @param explicitTarget - the ask names its own conversation (`im.approvalChatId`).
     *   The "no active chat" requirement then does NOT apply: it exists because
     *   the api would otherwise have to resolve a chat from traffic, and the
     *   whole point of an explicit target is that no inbound message is needed
     *   for the bot to know where to ask (upstream `resolve()` returns the given
     *   `chatId` directly). Demanding a DM first would make the hardening
     *   unusable exactly where it matters — a fresh deployment.
     * @returns the channel name the ask should target (pinned, so the api
     *   resolves the same chat this check verified) or the exact refusal.
     */
    const preflight = (explicitTarget: boolean): { ok: true; target?: string } | { ok: false; reason: string } => {
        const api = options.api
        const failures: string[] = []
        let candidates: { name: string; inbound: boolean }[] | undefined

        if (typeof api.channels === 'function') {
            let list: unknown
            try {
                list = api.channels()
            } catch (error) {
                return { ok: false, reason: `api.channels() 抛错：${reasonOf(error)}` }
            }
            if (!Array.isArray(list)) return { ok: false, reason: 'api.channels() 没有返回数组，无法确认哪个渠道可用' }
            const connected = connectedChannels(list)
            if (options.channelId !== undefined) {
                const found = connected.find((entry) => entry.name === options.channelId)
                if (found === undefined) {
                    return {
                        ok: false,
                        reason:
                            `im.channelId="${options.channelId}" 指向的渠道未连接或未装配` +
                            `（已连接：${connected.map((entry) => entry.name).join(', ') || '无'}）`,
                    }
                }
                candidates = [found]
            } else {
                candidates = connected.filter((entry) => entry.inbound)
                if (candidates.length === 0) {
                    return {
                        ok: false,
                        reason:
                            connected.length === 0
                                ? 'chat-interaction 没有已连接的渠道（先 connect 一个渠道再提问）'
                                : `渠道 ${connected.map((entry) => entry.name).join(', ')} 不支持入站（capabilities.inbound=false）：问出去也收不回答案`,
                    }
                }
            }
            const noInbound = candidates.filter((entry) => !entry.inbound)
            if (noInbound.length === candidates.length) {
                return { ok: false, reason: `渠道 ${candidates.map((entry) => entry.name).join(', ')} 不支持入站（capabilities.inbound=false）：问出去也收不回答案` }
            }
        } else if (options.channelId !== undefined) {
            // A partial-but-v1 api may not expose channel discovery; the pinned
            // name is then the only candidate we can check.
            candidates = [{ name: options.channelId, inbound: true }]
        }

        if (candidates === undefined || candidates.length === 0) {
            // No discovery and no pin: the api resolves its own active chat.
            return { ok: true }
        }

        for (const candidate of candidates) {
            if (!candidate.inbound) {
                failures.push(`渠道 "${candidate.name}" 不支持入站（capabilities.inbound=false）：问出去也收不回答案`)
                continue
            }
            if (typeof api.capabilities === 'function') {
                let caps: unknown
                try {
                    caps = api.capabilities(candidate.name)
                } catch (error) {
                    failures.push(`api.capabilities("${candidate.name}") 抛错：${reasonOf(error)}`)
                    continue
                }
                if (isRecord(caps) && caps['ok'] === false) {
                    failures.push(
                        `渠道 "${candidate.name}" 的能力查询失败（${String(caps['code'] ?? 'unknown')}）：${String(caps['message'] ?? '未说明原因')}`,
                    )
                    continue
                }
                const value = isRecord(caps) ? caps['value'] : undefined
                if (isRecord(value) && value['inbound'] === false) {
                    failures.push(`渠道 "${candidate.name}" 不支持入站（capabilities.inbound=false）：问出去也收不回答案`)
                    continue
                }
            }
            let hasChat: boolean | undefined
            if (typeof api.authState === 'function') {
                let state: unknown
                try {
                    state = api.authState(candidate.name)
                } catch (error) {
                    failures.push(`api.authState("${candidate.name}") 抛错：${reasonOf(error)}`)
                    continue
                }
                if (isRecord(state)) {
                    if (state['ok'] === false) {
                        failures.push(`渠道 "${candidate.name}" 的权限状态不可读（${String(state['error'] ?? '未说明原因')}）`)
                        continue
                    }
                    if (state['listenerConnected'] === false) {
                        failures.push(`渠道 "${candidate.name}" 的监听器未连接：先连接它（api.connect("${candidate.name}")）再提问`)
                        continue
                    }
                    const active = state['activeChat']
                    hasChat = typeof active === 'string' && active.trim() !== ''
                }
            }
            if (hasChat !== false || explicitTarget) return { ok: true, target: candidate.name }
            failures.push(`渠道 "${candidate.name}" 没有 active chat：先在 IM 里给它发一条消息建立会话，再提问`)
        }
        return { ok: false, reason: failures.join('；') || '没有可用的 IM 渠道' }
    }

    /**
     * The explicit IM target of ONE ask, or the exact refusal.
     *
     * The target comes from the MESSAGE (computed where the workspace and its
     * approver list are known, see `tools.ts`), never from the api's own state:
     * `p2pChat` is just "the last chat that messaged the bot", so letting the
     * plugin pick would let anyone who DMs the bot redirect this card.
     *
     * Fail closed: with `im.approvalChatId` configured, an ask that arrives
     * without a target is REFUSED rather than sent to whatever chat the api
     * would have resolved. Without a configured target the adapter behaves
     * exactly as before (no `chatId`, no `from`).
     */
    const targetOf = (message: { im?: ImAskTarget }): { ok: true; im?: ImAskTarget } | { ok: false; error: string } => {
        const requested: unknown = message.im
        if (requested !== undefined) {
            if (!isRecord(requested)) return { ok: false, error: '提问携带的 IM 审批目标不是一个对象：拒绝发送（不猜目标会话）' }
            const chatId = typeof requested['chatId'] === 'string' ? requested['chatId'].trim() : ''
            const rawFrom = requested['from']
            const from: string[] = []
            if (Array.isArray(rawFrom)) {
                for (const entry of rawFrom) {
                    if (typeof entry !== 'string') continue
                    const trimmed = entry.trim()
                    if (trimmed !== '' && !from.includes(trimmed)) from.push(trimmed)
                }
            }
            if (chatId === '') return { ok: false, error: '提问携带的 IM 审批目标缺少 chatId：拒绝发送（目标不明就不发卡片）' }
            if (from.length === 0) {
                return {
                    ok: false,
                    error:
                        '提问携带的 IM 审批目标没有白名单（from 为空）：拒绝发送——没有名单就没有"谁可以回答"，' +
                        '而一张谁都能答的卡片不是审批',
                }
            }
            return { ok: true, im: { chatId, from, p2pOnly: requested['p2pOnly'] === true } }
        }
        if (options.approvalChatId !== undefined && options.approvalChatId !== '') {
            return {
                ok: false,
                error:
                    `本通道配置了 im.approvalChatId=${options.approvalChatId}，但这个提问没有携带显式审批目标（chatId/from）：` +
                    '拒绝发送——绝不退回"由 IM 插件的 p2pChat/activeChat 决定目标"',
            }
        }
        return { ok: true }
    }

    /** Normalise one `api.ask` resolution. Never invents an approval. */
    const normalizeResult = (raw: unknown, declared: { value: string; label: string }[]): AskOutcome => {
        if (!isRecord(raw)) {
            return { answer: null, reason: 'chat-interaction 的 ask() 返回了非对象：按"没有答案"处理（不猜）' }
        }
        if (raw['ok'] !== true) {
            const code = typeof raw['code'] === 'string' && raw['code'] !== '' ? raw['code'] : 'unknown'
            const message = typeof raw['message'] === 'string' && raw['message'] !== '' ? raw['message'] : '未说明原因'
            return { answer: null, reason: `chat-interaction 没有给出答案（${code}）：${message}` }
        }
        const value = raw['value']
        if (!isRecord(value) || typeof value['value'] !== 'string' || value['value'].trim() === '') {
            return { answer: null, reason: 'chat-interaction 的 ask() 声称成功，但结果里没有非空的答案文本（value.value）：按"没有答案"处理' }
        }
        const rawValue = value['value']
        let mapped = rawValue
        if (declared.length > 0) {
            const folded = rawValue.trim().toLowerCase()
            const hit = declared.filter((entry) => entry.value.toLowerCase() === folded)
            if (hit.length !== 1) {
                return {
                    answer: null,
                    reason:
                        `回答 ${JSON.stringify(truncate(rawValue, 80).text)} 不是本次声明的选项之一：按"答非所问"处理` +
                        '（歧义的答案不是决定，也绝不默认通过）',
                }
            }
            mapped = (hit[0] as { value: string }).value
        }
        const by = typeof value['by'] === 'string' && value['by'].trim() !== '' ? value['by'].trim() : undefined
        const messageId = typeof value['messageId'] === 'string' && value['messageId'] !== '' ? value['messageId'] : undefined
        // Provenance (0.3.4+): the chat the answer came from, and its kind when
        // the platform reported one. Forwarded AS REPORTED — the adapter never
        // invents a `chatKind`, because "not proven" must stay distinguishable
        // from "proven p2p" for the post-answer check.
        const answerChatId = typeof value['chatId'] === 'string' && value['chatId'] !== '' ? value['chatId'] : undefined
        const rawKind = value['chatKind']
        const answerKind = rawKind === 'p2p' || rawKind === 'group' ? rawKind : undefined
        return {
            answer: {
                value: mapped,
                ...(by === undefined ? {} : { by }),
                ...(messageId === undefined ? {} : { messageId }),
                ...(answerChatId === undefined ? {} : { chatId: answerChatId }),
                ...(answerKind === undefined ? {} : { chatKind: answerKind }),
            },
        }
    }

    /** Apply one terminal outcome exactly once (a hostile api may resolve twice). */
    const settleEntry = (entry: LiveAsk, outcome: AskOutcome): void => {
        if (entry.state !== 'live') return
        entry.state = 'settled'
        entry.result = outcome.answer
        if (outcome.reason !== undefined) {
            entry.failure = outcome.reason
            note(outcome.reason)
        }
        const settle = entry.settle
        entry.settle = undefined
        if (settle !== undefined) {
            asks.delete(entry.questionId)
            settle(outcome.answer)
        }
        // Otherwise the result is buffered for the `wait()` that has not
        // attached yet (a human can click before the ask tool starts waiting).
    }

    const channel: InteractionChannel = {
        name: CHAT_CHANNEL_NAME,
        // The conversation this channel reports, so the outbox serializes the
        // right one. With P0 the conversation is KNOWN (im.approvalChatId); the
        // pinned channel NAME is only a fallback for a deployment that has not
        // configured a target yet (then the api still resolves its active chat
        // per send, so every ask shares one implicit conversation — at most one
        // outstanding question, conservative on purpose).
        ...(options.approvalChatId !== undefined && options.approvalChatId !== ''
            ? { chatId: options.approvalChatId }
            : options.channelId === undefined
              ? {}
              : { chatId: options.channelId }),

        async send(message): Promise<{ ok: boolean; messageId?: string; error?: string; permanent?: boolean; defer?: boolean }> {
            // Permanent in the outbox's sense: this adapter will never deliver
            // anything again in this process, so a replayed question must not be
            // re-sent through it.
            if (disposed) return { ok: false, error: 'IM 通道已释放（插件已卸载）', permanent: true }
            if (message.kind !== 'ask') {
                return {
                    ok: false,
                    error: `本通道只转发"需要人决定"的提问（kind=ask）：${message.kind} 不经过 IM 通道（通知/进度由宿主 IM 插件自己负责）`,
                    permanent: true,
                }
            }
            const questionId = (message.questionId ?? '').trim()
            if (questionId === '') {
                return { ok: false, error: '提问缺少一次性令牌（questionId）：拒绝发出一张无法归属答案的卡片', permanent: true }
            }
            prune()
            const live = [...asks.values()].find((entry) => entry.state === 'live')
            if (live !== undefined) {
                // "No free slot" is a DEFERRAL, not a channel failure: the ask
                // must not burn its retry budget on a chat that is simply busy.
                return {
                    ok: false,
                    error:
                        `同一 IM 渠道已有一次待回答的提问（令牌 ${live.questionId}）：并发提问的答案无法区分归属，` +
                        '因此拒绝再发一张卡（等这次有结果或超时后重试）',
                    defer: true,
                }
            }

            // Redaction: the payload must not leave the process with a credential
            // in it. Refuse (never mask-and-send), and record only the redacted
            // rule/field/excerpt — the value itself never reaches a log.
            const fields: { name: string; text: string }[] = [
                { name: 'title', text: message.title },
                { name: 'body', text: message.body },
            ]
            for (const button of message.buttons ?? []) {
                fields.push({ name: 'options', text: `${button.value}\n${button.label}` })
            }
            const verdict = checkOutgoing(fields, rules)
            if (!verdict.ok) {
                const details = describeHits(verdict.hits, rules).map((line) => line.replace(/^-\s*/, '')).join('；')
                note(`IM 卡片载荷疑似含凭据，已拒绝发送：${details}`)
                return {
                    ok: false,
                    error: `载荷疑似含凭据，已拒绝发送（绝不"打码后照发"）：命中 ${verdict.hits.map((hit) => hit.rule).join(', ')}`,
                    // A credential does not disappear on a retry: never re-send it.
                    permanent: true,
                }
            }

            // The target must be settled BEFORE the api is touched: with a
            // configured approval chat there is no such thing as "the api will
            // figure out where to put it".
            const resolvedTarget = targetOf(message)
            if (!resolvedTarget.ok) {
                note(`IM 通道拒绝发送（目标未确定）：${resolvedTarget.error}`)
                // Permanent: the target comes from configuration/an ask, and no
                // retry of THIS message will acquire one.
                return { ok: false, error: resolvedTarget.error, permanent: true }
            }
            const imTarget = resolvedTarget.im

            const ready = preflight(imTarget !== undefined)
            if (!ready.ok) {
                // Temporarily unavailable (not connected / no active chat yet):
                // the human can fix it without changing anything here, so this is
                // a deferral — retry later, do not count it as a send failure.
                note(`IM 通道不可用：${ready.reason}`)
                return { ok: false, error: `IM 通道不可用：${ready.reason}`, defer: true }
            }
            const target = ready.target
            // The upstream only honours an explicit `chatId` when `channel` is
            // given TOGETHER with it (`resolve()` in the installed 0.3.4:
            // `if (target?.channel && target.chatId) …`). A `chatId` alone falls
            // through to `resolveActive()` — i.e. straight back to the
            // `p2pChat || activeChat` hole this P0 exists to close, silently. So
            // when we cannot NAME the channel (no discovery, no `im.channelId`)
            // the explicit target is refused instead of sent half-applied.
            if (imTarget !== undefined && target === undefined) {
                const error =
                    '显式审批目标需要同时确定 IM 渠道名（channel），但本部署既没有渠道发现能力（api.channels）也没有配置 im.channelId：' +
                    '拒绝发送——上游在只有 chatId、没有 channel 时会忽略 chatId 并从 active chat 解析目标（正是要关掉的那条路）'
                note(`IM 通道拒绝发送：${error}`)
                return { ok: false, error, permanent: true }
            }

            const declared = (message.buttons ?? []).map((button) => ({ value: button.value, label: button.label }))
            const controller = new AbortController()
            const entry: LiveAsk = {
                questionId,
                declared,
                state: 'live',
                deadlineAt: now() + Math.max(1, Math.floor(options.askTimeoutMs)),
                controller,
            }
            asks.set(questionId, entry)

            let started: unknown
            try {
                started = options.api.ask({
                    ...(target === undefined ? {} : { channel: target }),
                    // P0: the conversation and the answer whitelist are EXPLICIT.
                    // `from` makes the upstream ignore a reply from anybody else
                    // (and keeps waiting), so the whitelist is enforced twice:
                    // here (who MAY answer) and after the answer (who DID).
                    ...(imTarget === undefined ? {} : { chatId: imTarget.chatId, from: [...imTarget.from] }),
                    title: message.title,
                    body: message.body,
                    ...(declared.length === 0 ? {} : { options: declared }),
                    timeoutMs: Math.max(1, Math.floor(options.askTimeoutMs)),
                    signal: controller.signal,
                })
            } catch (error) {
                asks.delete(questionId)
                const reason = `chat-interaction 的 ask() 抛错：${reasonOf(error)}`
                note(reason)
                return { ok: false, error: reason }
            }

            // Handle rejection and (mis)resolution here, so a late or double
            // settlement can never become an unhandled rejection or a decision.
            void Promise.resolve(started).then(
                (raw) => settleEntry(entry, normalizeResult(raw, declared)),
                (error: unknown) => settleEntry(entry, { answer: null, reason: `chat-interaction 的 ask() 失败：${reasonOf(error)}` }),
            )
            // Give the IM api ONE microtask to report a failure it already knows
            // (no-target / channel-unsupported / api disposed — all returned
            // before its first await). Surfacing it HERE means the ask is
            // recorded as `refused:send-failed` with the real reason instead of
            // an opaque `refused:timeout` later. A human's answer cannot arrive
            // within a microtask, so this never delays a real ask.
            await Promise.resolve()
            if (entry.state === 'settled' && entry.result === null) {
                asks.delete(questionId)
                return { ok: false, error: `IM 通道没有把提问发出去：${entry.failure ?? '未说明原因'}` }
            }
            return { ok: true }
        },

        async wait(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<InteractionAnswer | null> {
            if (disposed) return null
            const entry = asks.get(questionId)
            if (entry === undefined) {
                note(`没有与令牌 ${questionId} 对应的提问（可能已结束或从未发出）：按"没有答案"处理`)
                return null
            }
            if (entry.state === 'abandoned') {
                asks.delete(questionId)
                return null
            }
            if (entry.settle !== undefined) {
                note(`令牌 ${questionId} 已有等待者：一次提问只能有一个回答者，拒绝重复等待`)
                return null
            }
            if (entry.state === 'settled') {
                asks.delete(questionId)
                return entry.result ?? null
            }
            return await new Promise<InteractionAnswer | null>((resolve) => {
                let finished = false
                const finish = (answer: InteractionAnswer | null): void => {
                    if (finished) return
                    finished = true
                    clearTimeout(timer)
                    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
                    entry.settle = undefined
                    asks.delete(questionId)
                    resolve(answer)
                }
                const onAbort = (): void => {
                    entry.state = 'abandoned'
                    try {
                        entry.controller.abort()
                    } catch {
                        // See prune(): the api owns its own abort plumbing.
                    }
                    finish(null)
                }
                // Fire one millisecond before the registry's own deadline: this
                // wait must REPORT "no answer" itself (and record why), instead
                // of being cut off by the caller's timer and counted as a
                // dropped answer. Both end the ask the same way — as a refusal.
                const budget = Math.max(1, Math.floor(timeoutMs) - 1)
                const timer = setTimeout(() => {
                    if (entry.state === 'live') entry.state = 'abandoned'
                    try {
                        entry.controller.abort()
                    } catch {
                        // As above.
                    }
                    note(
                        `等待回答超时（${Math.max(1, Math.floor(timeoutMs))}ms）：超时不是同意，也不是拒绝——这次提问没有决定` +
                            '（需要决定就重新提问）',
                    )
                    finish(null)
                }, budget)
                // A long timer must not keep the process alive on its own.
                if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
                if (signal !== undefined) {
                    if (signal.aborted) {
                        onAbort()
                        return
                    }
                    signal.addEventListener('abort', onAbort, { once: true })
                }
                entry.settle = (answer) => finish(answer)
            })
        },

        describe(): { canAsk: boolean; canNotify: boolean } {
            // Ask only: notifications/progress stay on the suite's own channels.
            return { canAsk: true, canNotify: false }
        },
    }

    return {
        channel,
        ignored: (): ImIgnoredReport => ({
            upstream: ignored.upstream,
            total: ignored.total,
            bySender: ignored.bySender,
            byOptions: ignored.byOptions,
            recent: ignored.recent.map((attempt) => ({ ...attempt })),
        }),
        dispose(): void {
            if (disposed) return
            disposed = true
            const unsubscribe = unsubscribeIgnored
            unsubscribeIgnored = undefined
            if (unsubscribe !== undefined) unsubscribe()
            for (const entry of asks.values()) {
                entry.state = 'abandoned'
                try {
                    entry.controller.abort()
                } catch {
                    // Nothing to salvage.
                }
                const settle = entry.settle
                entry.settle = undefined
                if (settle !== undefined) settle(null)
            }
            asks.clear()
        },
    }
}

/** Re-exported so `index.ts` can type the report it records. */
export type { ImChannelReport }

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

import type { ImChannelReport, InteractionChannel, InteractionAnswer } from './channels.js'
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
}

/** A usable service, or the reason there is none (never both). */
export type ChatProbe =
    | { ok: true; api: ChatApiLike; apiVersion: number; pluginVersion?: string }
    | { ok: false; reason: string }

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
        return { ok: false, reason: `chatInteraction 服务不是对象（收到 ${typeof layer}）` }
    }

    let api: unknown
    try {
        api = (layer as { api?: unknown }).api
    } catch (error) {
        return { ok: false, reason: `chatInteraction.api 的访问器抛错：${reasonOf(error)}` }
    }
    if (api === undefined || api === null) {
        return { ok: false, reason: 'chat-interaction 没有暴露 api（需要 0.3.0+：服务形状是 { api: { apiVersion, ask, … } }）' }
    }
    if (typeof api !== 'object') {
        return { ok: false, reason: `chatInteraction.api 不是对象（收到 ${typeof api}）` }
    }

    let version: unknown
    try {
        version = (api as { apiVersion?: unknown }).apiVersion
    } catch (error) {
        return { ok: false, reason: `api.apiVersion 的访问器抛错：${reasonOf(error)}` }
    }
    if (typeof version !== 'number' || !Number.isFinite(version)) {
        return { ok: false, reason: `api.apiVersion 不是数字（收到 ${JSON.stringify(version)}），无法判断契约版本` }
    }
    if (version < CHAT_API_MIN_VERSION) {
        return { ok: false, reason: `chat-interaction 的 apiVersion=${version} 低于 ${CHAT_API_MIN_VERSION}（旧版本没有给其他插件用的问答 API）` }
    }

    let ask: unknown
    try {
        ask = (api as { ask?: unknown }).ask
    } catch (error) {
        return { ok: false, reason: `api.ask 的访问器抛错：${reasonOf(error)}` }
    }
    if (typeof ask !== 'function') {
        return { ok: false, reason: 'api 不完整：缺少 ask()（无法把提问发出去并等一个对得上令牌的回答）' }
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
}

/** Options for {@link createChatChannel}. */
export interface ChatChannelOptions {
    /** The verified `chatInteraction.api` (v1+). */
    api: ChatApiLike
    /**
     * Pin the IM channel name (`feishu`/`wecom`/…): config `im.channelId`.
     * Omitted = the api resolves its own active chat across channels.
     */
    channelId?: string
    /** The host's `askTimeoutMs` — the deadline the IM api is given. */
    askTimeoutMs: number
    /** Host `redactPatterns` (built-in credential rules always apply too). */
    redactPatterns?: readonly string[]
    /** Per-ask defects: the registry's `problems()` sink. */
    note?: (message: string) => void
    logger?: { warn: (message: string) => void }
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
     * @returns the channel name the ask should target (pinned, so the api
     *   resolves the same chat this check verified) or the exact refusal.
     */
    const preflight = (): { ok: true; target?: string } | { ok: false; reason: string } => {
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
            if (hasChat !== false) return { ok: true, target: candidate.name }
            failures.push(`渠道 "${candidate.name}" 没有 active chat：先在 IM 里给它发一条消息建立会话，再提问`)
        }
        return { ok: false, reason: failures.join('；') || '没有可用的 IM 渠道' }
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
        return { answer: { value: mapped, ...(by === undefined ? {} : { by }), ...(messageId === undefined ? {} : { messageId }) } }
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

        async send(message): Promise<{ ok: boolean; messageId?: string; error?: string }> {
            if (disposed) return { ok: false, error: 'IM 通道已释放（插件已卸载）' }
            if (message.kind !== 'ask') {
                return {
                    ok: false,
                    error: `本通道只转发"需要人决定"的提问（kind=ask）：${message.kind} 不经过 IM 通道（通知/进度由宿主 IM 插件自己负责）`,
                }
            }
            const questionId = (message.questionId ?? '').trim()
            if (questionId === '') {
                return { ok: false, error: '提问缺少一次性令牌（questionId）：拒绝发出一张无法归属答案的卡片' }
            }
            prune()
            const live = [...asks.values()].find((entry) => entry.state === 'live')
            if (live !== undefined) {
                return {
                    ok: false,
                    error:
                        `同一 IM 渠道已有一次待回答的提问（令牌 ${live.questionId}）：并发提问的答案无法区分归属，` +
                        '因此拒绝再发一张卡（等这次有结果或超时后重试）',
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
                }
            }

            const ready = preflight()
            if (!ready.ok) {
                note(`IM 通道不可用：${ready.reason}`)
                return { ok: false, error: `IM 通道不可用：${ready.reason}` }
            }
            const target = ready.target

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
        dispose(): void {
            if (disposed) return
            disposed = true
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

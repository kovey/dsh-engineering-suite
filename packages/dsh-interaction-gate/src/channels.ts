/**
 * The channel registry: how a surface (IM, terminal, webhook…) becomes an
 * answerer for the engineering suite.
 *
 * The suite's gates currently hand every "a human must decide" moment to the
 * HOST's approval seam, which works in a terminal and not on a phone or in a
 * headless session. This module is the suite's own seam: a plugin (an IM
 * plugin, a web UI, a test double) registers a channel here, and the four
 * `interaction_*` tools route ask / notify / progress through it.
 *
 * Three properties are non-negotiable, because the alternative is a decision
 * layer that lies:
 *
 *  1. **A channel never breaks the caller.** `send`, `wait` and `describe` are
 *     called through this registry, every call is wrapped, and a throw becomes
 *     `{ ok: false, error }` plus a recorded problem — never an exception
 *     inside a gate.
 *  2. **Unusable is said out loud.** `list()` reports `canAsk` / `canNotify`
 *     AND the reason: a channel without `wait()` cannot be asked, and
 *     `interaction_ask` refuses rather than pretending it asked.
 *  3. **Answers are routed by one-shot token.** An ask arms an unpredictable
 *     `questionId`; an answer is accepted only while that token is pending, for
 *     exactly one answer, and only if the token it claims matches. An answer
 *     for an unknown, retired or different token is DROPPED and counted — it
 *     can never resolve somebody else's question.
 *
 * `wait` is the pull path; `submit` is the push path for a channel whose
 * transport delivers answers out of band (an IM webhook). A channel may
 * implement either or both.
 *
 * @module dsh-interaction-gate/channels
 */

import { randomBytes } from 'node:crypto'
import type { Attention, AttentionSource } from './attention.js'
import { readLedger, summarizeLedger } from './ledger.js'

/** What the suite is sending. */
export type InteractionKind = 'ask' | 'notify' | 'progress'

/**
 * The explicit IM target of ONE ask (P0: never "whoever DMs the bot").
 *
 * Computed where the workspace is known (`tools.ts`, from `im.approvalChatId`
 * plus that repository's approver list), then carried on the message so:
 *
 *  - the channel adapter sends the card to exactly this conversation and tells
 *    the IM plugin which platform user ids may answer it (`chatId` / `from`);
 *  - a REPLAY of the same question re-sends it to the same conversation (the
 *    message, not a process-global "active chat", is the target);
 *  - the post-answer check in `tools.ts` compares the answer's provenance
 *    against the very target this ask was sent with.
 *
 * Absent = today's behaviour (the IM plugin resolves its own active chat).
 */
export interface ImAskTarget {
    /** The one conversation this card may go to. */
    chatId: string
    /** Platform user ids allowed to answer (`from`); non-empty by construction. */
    from: string[]
    /** Whether the answer chat must be proven p2p (`im.p2pOnly`). */
    p2pOnly: boolean
}

/** One outgoing message. */
export interface InteractionMessage {
    kind: InteractionKind
    /** Short headline; a channel may render it as a card title. */
    title: string
    /** Body text; may embed an ```approval-context``` block (dsh-eng-core). */
    body: string
    /** The one-shot token, present for `ask` (and echoed by the channel). */
    questionId?: string
    /** Declared options, for a channel that can render buttons. */
    buttons?: { value: string; label: string }[]
    /**
     * The explicit IM target + answer whitelist of this ask, when the host
     * configured one (see {@link ImAskTarget}). Channels that do not speak IM
     * ignore it; the IM adapter refuses to send without it once
     * `im.approvalChatId` is configured.
     */
    im?: ImAskTarget
}

/** What a channel reports about one send. */
export interface ChannelSendResult {
    ok: boolean
    /** Channel-side id of the delivered message (card), for the ledger. */
    messageId?: string
    /** Why it failed, in Chinese, when `ok` is false. */
    error?: string
    /**
     * `true` when retrying can never help: the channel is gone/not found, it
     * does not support this payload (a notify on an ask-only channel), or the
     * request expired before delivery. The outbox settles such a question as
     * `dropped` instead of retrying it (see `outbox.ts`).
     *
     * Absent = "unknown, treat as transient": the safe direction, because a
     * transient failure is retried and a wrong `dropped` would lose a question.
     */
    permanent?: boolean
    /**
     * `true` when the card was NOT sent and that is not a FAILURE: the channel
     * is temporarily unavailable (not connected, no active chat yet, one
     * question already outstanding). The outbox records a `deferred` row and
     * does NOT increment `attempts` — a busy channel must not exhaust the retry
     * budget of a question.
     */
    defer?: boolean
}

/** One answer. */
export interface InteractionAnswer {
    /** The answer text: a declared option, or free text when none were declared. */
    value: string
    /** Who answered — the channel's own identity claim (never verified here). */
    by?: string
    /** Channel-side id of the message/card the answer came from. */
    messageId?: string
    /**
     * The conversation the answer came FROM (the IM plugin's own report).
     *
     * This is provenance, not decoration: with `im.approvalChatId` configured,
     * an answer whose `chatId` is not the configured target is not a decision
     * (`refused:wrong-chat`). Absent = the channel cannot prove where it came
     * from, which is exactly what the check must be able to see.
     */
    chatId?: string
    /**
     * The kind of chat the answer came from, WHEN the platform reported it.
     *
     * Absent is deliberately "not proven" rather than "probably fine": with
     * `im.p2pOnly` on, an unproven kind is refused (`refused:not-p2p`), because
     * a group is a room the approver does not control.
     */
    chatKind?: 'p2p' | 'group'
}

/**
 * The contract every channel implements.
 *
 * `send` is fire-and-forget: it must never throw (the registry tolerates a
 * throw anyway) and it must not wait for a human. `wait` is optional — a
 * channel without it can notify but cannot be asked. `describe` is the
 * capability report the doctor (`interaction_status`) shows.
 */
export interface InteractionChannel {
    readonly name: string
    /**
     * The CONVERSATION this channel sends into (an IM chat id), when it can name
     * one, so the outbox can keep one outstanding question per conversation.
     * Absent = the channel has one implicit conversation and all its asks
     * serialize (conservative: never two questions racing in one chat).
     */
    readonly chatId?: string
    /** fire-and-forget; must never throw */
    send(message: {
        kind: 'ask' | 'notify' | 'progress'
        title: string
        body: string
        questionId?: string
        buttons?: { value: string; label: string }[]
        /** Explicit IM target + answer whitelist (see {@link ImAskTarget}); ignored by non-IM channels. */
        im?: ImAskTarget
    }): Promise<{ ok: boolean; messageId?: string; error?: string; permanent?: boolean; defer?: boolean }>
    /** wait for the answer to `questionId`; resolve null on timeout/abort */
    wait?(
        questionId: string,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<{ value: string; by?: string; messageId?: string; chatId?: string; chatKind?: 'p2p' | 'group' } | null>
    /** per-channel capability report for the doctor */
    describe(): { canAsk: boolean; canNotify: boolean }
}

/** What the doctor shows about one registered channel. */
export interface ChannelInfo {
    name: string
    canAsk: boolean
    canNotify: boolean
    /** Why something is not possible (Chinese); empty when the channel is fully usable. */
    reason: string
    /** Registration order, 0-based (the tie-break after `preferredChannels`). */
    order: number
}

/** The host's `im.channel` mode (see `config.ts`). */
export type ImChannelMode = 'auto' | 'off' | 'required'

/**
 * The lifecycle phase of the optional IM channel.
 *
 * The startup probe is only a FAST PATH. The authority is the reactive binding
 * on the `chatInteraction` service (`ctx.inject`, see `im-binding.ts`): bundle
 * order does not decide apply order, and `dsh-chat-interaction` provides its
 * service at the END of its own `apply`, so "absent at startup" is not a
 * verdict — it is a state that a later appearance upgrades.
 *
 *  - `off`: the host disabled the integration; the service is never touched.
 *  - `absent`: no USABLE service has appeared (yet). An old/invalid service is
 *    treated as absent and logged; when it is replaced by a valid one the phase
 *    moves to `registered`.
 *  - `waiting`: `im.channel=required`, the service has not appeared and the
 *    configured bounded window is still open.
 *  - `registered`: a `chatInteraction` service with `apiVersion >= 1` is
 *    registered as the `chat-interaction` channel.
 *  - `refused`: `im.channel=required` and the bounded window closed without the
 *    service. `interaction_ask` refuses from here on (it never silently falls
 *    back to a local channel) until a late arrival clears the refusal.
 */
export type ImPhase = 'off' | 'absent' | 'waiting' | 'registered' | 'refused'

/**
 * One answer attempt the IM plugin REFUSED on our behalf (a sender outside
 * `from`, or a reply matching no offered option).
 *
 * Recorded so "someone tried to answer for the approver" cannot look like a
 * plain timeout in the audit trail. The attempt's raw TEXT is deliberately not
 * kept: it is not needed to act on the event, and a refused message can still
 * contain a credential (the same rule the outgoing redaction layer follows).
 */
export interface ImIgnoredAttempt {
    /** Epoch ms reported by the IM plugin. */
    at: number
    /** `sender-not-allowed` / `option-mismatch`, or whatever the plugin named. */
    reason: string
    /** The conversation the attempt came from, when reported. */
    chatId?: string
    /** Platform user id of the sender, when known. */
    by?: string
    /** Channel-side message id, when known. */
    messageId?: string
}

/** What this process could observe about ignored answer attempts. */
export interface ImIgnoredReport {
    /**
     * `hooked`: the upstream offers `onAnswerIgnored` and we are subscribed.
     * `unavailable`: it does not (older upstream), so an empty list here means
     * "not observable", NOT "nobody tried" — the doctor says exactly that.
     */
    upstream: 'hooked' | 'unavailable'
    total: number
    /** Rejected because the sender was outside the `from` whitelist. */
    bySender: number
    /** Rejected because the reply matched no offered option. */
    byOptions: number
    /** The last few attempts, newest last (bounded). */
    recent: ImIgnoredAttempt[]
}

/**
 * The optional IM channel's verdict: registered or not, and WHY.
 *
 * This exists so "the IM channel is not registered" is a STATED fact on the
 * doctor instead of an absence a reader has to interpret: `off` means the host
 * disabled it, `auto` + absent means no usable IM plugin has appeared (yet),
 * `waiting`/`refused` say how a `required` deployment is doing inside its
 * bounded window, and a broken/old service says which part was missing.
 * `reason` is never empty.
 */
export interface ImChannelReport {
    /** The configured mode this report is about. */
    mode: ImChannelMode
    /**
     * The lifecycle phase (see {@link ImPhase}). `registered` is the only phase
     * in which the channel exists; `refused` is the only phase that makes
     * `interaction_ask` refuse for a missing IM channel.
     */
    phase: ImPhase
    registered: boolean
    /**
     * Whether a `chatInteraction` service has EVER been observed, even when it
     * was unusable (older/invalid api, throwing accessor). `phase=absent` +
     * `appeared=true` says "it is there but not usable", which is a different
     * fact from "it never showed up".
     */
    appeared?: boolean
    /** How long `im.channel=required` waits for the service (ms). */
    requiredWaitMs?: number
    /** The registered channel name (present when `registered`). */
    name?: string
    /** `chatInteraction.api.apiVersion` that was accepted. */
    apiVersion?: number
    /** The IM plugin's own version, when it reported one. */
    pluginVersion?: string
    /** The IM channel name pinned by `im.channelId`, when configured. */
    channelId?: string
    /**
     * The configured approval target (`im.approvalChatId`); `''` = not
     * configured (today's behaviour). Stated here so the doctor can show the
     * target even while the channel itself is absent.
     */
    approvalChatId?: string
    /** Whether an answer must be proven to come from a p2p chat (`im.p2pOnly`). */
    p2pOnly?: boolean
    /**
     * Ignored answer attempts observed through the upstream's
     * `onAnswerIgnored` hook. Absent = nothing was observed (either no ask ran
     * yet or the upstream is too old — see `upstream`).
     */
    ignoredAnswers?: ImIgnoredReport
    /** Why it is (or is not) registered — always non-empty. */
    reason: string
}

/**
 * One line the doctor shows for the IM channel.
 *
 * The phase is named literally (`phase=absent|waiting|registered|refused`) so a
 * reader never has to infer from prose whether the IM plugin never appeared, is
 * still being waited for, or has been given up on.
 * @param report - the current verdict.
 */
export function describeIm(report: ImChannelReport): string {
    if (report.registered) {
        const version = report.apiVersion === undefined ? 'api v?' : `api v${report.apiVersion}`
        const plugin = report.pluginVersion === undefined ? '' : `，插件 v${report.pluginVersion}`
        const target = report.channelId === undefined ? '' : `，渠道 ${report.channelId}`
        const approval =
            report.approvalChatId === undefined || report.approvalChatId === ''
                ? '；审批目标：未配置（目标由 IM 插件的 p2pChat/activeChat 决定）'
                : `；审批目标：${report.approvalChatId}（p2pOnly=${report.p2pOnly === true}，from=项目审批人名单）`
        return `${report.name ?? 'chat-interaction'}（${version}${plugin}${target}）：需要人决定的提问走 IM，通知/进度仍走本进程通道（phase=registered）${approval}`
    }
    if (report.mode === 'off' || report.phase === 'off') {
        return '未注册（im.channel=off：宿主未启用）：仅本地通道，行为与未集成时一致（phase=off）'
    }
    const window = report.requiredWaitMs === undefined ? '' : `，等待窗口 ${report.requiredWaitMs}ms`
    if (report.phase === 'waiting') {
        return (
            `未注册（phase=waiting：im.channel=required${window}，正在等 chatInteraction 提供：${report.reason}）：` +
            '窗口内提问仍走本地通道；窗口结束仍未出现则 `interaction_ask` **拒绝**（不会静默走本地）'
        )
    }
    if (report.phase === 'refused') {
        return (
            `未注册（phase=refused：im.channel=required${window}：${report.reason}）：` +
            '`interaction_ask` 会**拒绝**（不会静默走本地通道）；服务迟到出现会自动恢复'
        )
    }
    const appeared = report.appeared === true ? '服务已出现但不可用' : '从未出现'
    return `未注册（phase=absent：${appeared}；im.channel=${report.mode}：${report.reason}）：仅本地通道，行为与未集成时一致`
}

/**
 * The log line that states which path is active, and every transition into it.
 *
 * Exactly one of these is logged on every `apply` and again at every phase
 * change (the service appears, is replaced, goes away, or a `required` window
 * closes), so "did questions go to IM or not" is answerable from the log
 * without inspecting the host.
 * @param report - the current verdict.
 */
export function imLogLine(report: ImChannelReport): string {
    if (report.registered) return `interaction channel: chat-interaction(api v${report.apiVersion ?? '?'})`
    if (report.mode === 'off' || report.phase === 'off') return 'interaction channel: local only (im.channel=off)'
    if (report.phase === 'refused') {
        // The reason says WHICH refusal it is (bounded window expired, or the
        // service was withdrawn after it had been registered) — never a generic
        // "unavailable" that hides the difference.
        return `interaction channel: 不可用（im.channel=required：${report.reason}；interaction_ask 将拒绝）`
    }
    if (report.phase === 'waiting') {
        return `interaction channel: 等待 chatInteraction 提供（当前进程内尚未出现；im.channel=required，窗口 ${report.requiredWaitMs ?? '?'}ms）`
    }
    if (report.appeared === true) {
        return `interaction channel: local only (chat-interaction 出现但不可用：${report.reason}；可用后会自动注册)`
    }
    return 'interaction channel: 等待 chatInteraction 提供（当前进程内尚未出现；出现后自动注册）'
}

/** How an ask ended. */
export type AwaitOutcome = 'answered' | 'timeout' | 'cancelled' | 'unknown-token'

/** The result of waiting for one token. */
export interface AwaitResult {
    outcome: AwaitOutcome
    answer: InteractionAnswer | null
    /**
     * How much a paused mission EXTENDED this wait (ms). Absent/0 = the wait ran
     * on its own clock. A timeout that was extended must say so: "we waited 15
     * minutes" and "we waited 15 minutes plus the 40 minutes the mission was
     * blocked" are different statements.
     */
    extensionMs?: number
}

/**
 * How a wait learns that it must not burn its deadline.
 *
 * While the mission behind a question is blocked/paused the deadline does not
 * run. The waiter therefore re-reads the accumulated paused time from the
 * recorded pause interval (`pausedFrom`/`pausedTo` rows) instead of trusting a
 * single `setTimeout`: every time the timer fires, `pausedMs()` may return MORE
 * than it did before, which moves the deadline further out.
 */
export interface AwaitExtension {
    /** Injected clock (the same one the pause interval is recorded with). */
    now: () => number
    /** Accumulated paused ms of this question at the current clock. May record a pause it observes. */
    pausedMs: () => number
    /** Whether the mission is paused RIGHT NOW (a paused wait must not expire at all). */
    paused?: () => boolean
}

/** How often an extended (paused) wait re-checks its deadline. */
export const EXTENSION_POLL_MS = 200

/** How many times one wait may re-arm itself (a bound on a pathological clock). */
export const MAX_EXTENSION_POLLS = 100_000

/** How many times an extended wait may re-issue a channel's own `wait`. */
export const MAX_EXTENSION_ATTEMPTS = 64

/**
 * How much later than the deadline the REGISTRY's own timer fires.
 *
 * A channel's `wait` reports its own timeout a hair before the deadline (the IM
 * channel fires 1 ms early so it can record WHY there was no answer). Without a
 * small grace the registry's timer wins that race under load and the ask ends
 * with no channel-side reason recorded at all — the timeout would still be a
 * refusal, but the "who was asked and why it ended" fact would be lost. The
 * grace only ever ADDS a few milliseconds to a wait that is already failing.
 */
export const TIMEOUT_GRACE_MS = 5

/** Options for {@link InteractionRegistry.awaitAnswer}. */
export interface AwaitOptions {
    /** The chosen channel's own `wait`, when it has one (the pull path). */
    wait?: (questionId: string, timeoutMs: number, signal?: AbortSignal) => Promise<InteractionAnswer | null>
    signal?: AbortSignal
    /**
     * Make a paused mission EXTEND the wait instead of burning it (see
     * {@link AwaitExtension}). Absent = today's behaviour, byte for byte.
     */
    extension?: AwaitExtension
}

/** One ask that is still waiting for a human (derived from the ledger). */
export interface PendingInteraction {
    /** The one-shot token; also exposed as `questionId` so both callers agree. */
    id: string
    questionId: string
    title: string
    /** Epoch ms the card was sent. */
    at: number
    channel?: string
    missionId?: string
}

/**
 * The service this plugin provides as `interaction` (see `ctx.provide`).
 *
 * `register` / `unregister` / `list` / `describeAll` / `pending` are the surface
 * other plugins use (the doctor calls `describeAll()` and `pending()`); `send`,
 * `arm`, `submit`, `awaitAnswer` and `problems` are what the four tools use (and
 * what a push-based channel needs to hand an answer over).
 *
 * NO method throws into the caller: a broken channel, a duplicate name and an
 * unreadable ledger all degrade to a recorded problem plus a safe value (an
 * empty list, a `false` submit). A doctor that crashes while reporting reality
 * reports nothing, so the registry is deliberately total.
 */
export interface InteractionRegistry {
    /**
     * Register one channel. Never throws: a duplicate name or an invalid shape
     * is REJECTED (the returned disposer does nothing) and recorded in
     * `problems()`, because two channels under one name would make "who
     * answered" unanswerable.
     */
    register(channel: InteractionChannel): () => void
    /** Unregister by name; `true` when one was removed. */
    unregister(name: string): boolean
    /** The registered channel, when it still is. */
    get(name: string): InteractionChannel | undefined
    /** Every registered channel with its capability report, registration order. */
    list(): ChannelInfo[]
    /** Same report, named for the doctor (`ctx.get('interaction').describeAll()`). */
    describeAll(): ChannelInfo[]
    /** Remember a ledger this process has touched, so `pending()` can read it. */
    trackLedger(file: string): void
    /** The ledgers `pending()` would read (what this process has observed). */
    ledgers(): string[]
    /**
     * Asks still waiting for a human: ledger rows with a token and no decision
     * (superseded rows excluded), oldest first. Never throws: an unreadable
     * ledger contributes nothing and is recorded in `problems()`.
     */
    pending(): PendingInteraction[]
    /** Send through ONE registered channel; a throwing channel is reported, never propagated. */
    send(name: string, message: InteractionMessage): Promise<ChannelSendResult>
    /** Arm the one-shot token an ask is about to wait on. `false` = the token could not be armed. */
    arm(questionId: string): boolean
    /** Retire a token that will never be waited on (its card was never delivered). */
    retire(questionId: string): void
    /** Push an answer for a token (the out-of-band path). `false` = dropped. */
    submit(questionId: string, answer: InteractionAnswer): boolean
    /**
     * Await the answer for an armed token. Resolves `timeout` at the deadline,
     * `cancelled` when the signal aborts, and retires the token either way.
     */
    awaitAnswer(questionId: string, timeoutMs: number, options?: AwaitOptions): Promise<AwaitResult>
    /** Answers dropped because the token was unknown, retired, or not the one asked. */
    droppedAnswers(): number
    /**
     * Attach one workspace's attention sidecar, so `attentions()` can read it.
     *
     * Idempotent per ledger file: a process that serves several repositories
     * keeps one source per workspace and never mixes their questions.
     */
    attachAttention(source: AttentionSource): void
    /**
     * Every question that is STILL waiting for a person, oldest first.
     *
     * Derived (a ledger `ask` row with no decision yet, minus the questions the
     * sidecar recorded as superseded/withdrawn) — this never stores an answer and
     * writes nothing. Only workspaces this process has attached are read, exactly
     * like `pending()`.
     */
    attentions(): Attention[]
    /** Record a pause interval for a mission (the hook a host/orchestrator can call). */
    pauseMission(missionId: string, reason?: string): boolean
    /** Close the pause interval of a mission. */
    resumeMission(missionId: string): boolean
    /**
     * Supersede every unanswered question of a mission (it ended, was stopped, or
     * its mandate was withdrawn). Returns how many questions it closed.
     */
    supersedeMission(missionId: string, reason: string): number
    /**
     * Record that one question's answer is no longer needed (the asker gave up).
     * Not an answer, not an approval: a late answer stays refused.
     */
    withdrawQuestion(questionId: string, reason: string): boolean
    /** Channel defects observed so far (bounded), for the doctor. */
    problems(): string[]
    /**
     * The optional IM channel's verdict (registered or not, and why).
     *
     * Always available — "not registered" is a fact with a reason, not an
     * absence. `setIm()` is the plugin's report; consumers only read.
     */
    im(): ImChannelReport
    /** Record the IM channel verdict (the plugin, during/after `apply`). */
    setIm(report: ImChannelReport): void
    /** Record one channel-layer defect in the bounded `problems()` list. */
    reportProblem(message: string): void
}

/** An unpredictable one-shot token. 128 bits, hex — never derived from a clock or a counter. */
export function newQuestionToken(): string {
    return `q-${randomBytes(16).toString('hex')}`
}

interface Pending {
    questionId: string
    armedAt: number
    settle: ((result: AwaitResult) => void) | undefined
    /**
     * An answer that arrived between `arm()` and `awaitAnswer()`.
     *
     * A push-based channel may deliver while the ask is still sending the card
     * (a scripted channel in a test, or a webhook that beats the HTTP response).
     * Buffering it keeps "the token is armed" the only requirement, instead of
     * "the token is armed AND the waiter attached in time".
     */
    early: AwaitResult | undefined
}

const MAX_PROBLEMS = 20

/**
 * How many times one wait may be re-issued after a wrong-token/invalid answer.
 * A channel that only ever answers somebody else's token must not spin us; the
 * ask's own deadline is still what ends it.
 */
const MAX_WAIT_ATTEMPTS = 8

/** Tolerant parse of whatever a channel returned from `wait`/`submit`. */
function normalizeAnswer(raw: unknown): InteractionAnswer | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    const value = record['value']
    if (typeof value !== 'string' || value.trim() === '') return undefined
    const by = typeof record['by'] === 'string' ? record['by'] : undefined
    const messageId = typeof record['messageId'] === 'string' ? record['messageId'] : undefined
    // Provenance travels with the answer, but only in the shapes the IM contract
    // defines: an unknown `chatKind` is dropped (NOT guessed as 'p2p'), because
    // the post-answer check treats a missing kind as "not proven".
    const chatId = typeof record['chatId'] === 'string' && record['chatId'] !== '' ? record['chatId'] : undefined
    const rawKind = record['chatKind']
    const chatKind = rawKind === 'p2p' || rawKind === 'group' ? rawKind : undefined
    return {
        value,
        ...(by === undefined ? {} : { by }),
        ...(messageId === undefined ? {} : { messageId }),
        ...(chatId === undefined ? {} : { chatId }),
        ...(chatKind === undefined ? {} : { chatKind }),
    }
}

/**
 * The token a channel CLAIMS its answer belongs to, when it says so.
 *
 * Not part of the contract (`questionId` is echoed by convention, not required):
 * a channel that serves several concurrent asks may include it, and when it does
 * and it does not match the token being awaited, the answer is dropped. A
 * mismatch is never resolved against the ask it was not meant for.
 */
function claimedToken(raw: unknown): string | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const claimed = (raw as Record<string, unknown>)['questionId']
    return typeof claimed === 'string' && claimed !== '' ? claimed : undefined
}

/**
 * Create the registry.
 * @param options - `now` (injectable clock) and a logger for defects.
 * @returns the registry (the value provided as `interaction`).
 */
export function createInteractionRegistry(options: {
    now?: () => number
    logger?: { warn: (message: string) => void }
} = {}): InteractionRegistry {
    const now = options.now ?? ((): number => Date.now())
    const channels = new Map<string, InteractionChannel>()
    const pending = new Map<string, Pending>()
    const problems: string[] = []
    let dropped = 0

    // The IM channel's verdict starts as "not probed yet" rather than as an
    // absence: a doctor that runs before/without the probe still states that
    // fact, and the plugin replaces it in `apply`.
    let imReport: ImChannelReport = { mode: 'auto', phase: 'absent', registered: false, reason: '尚未探测：插件还没有执行 IM 通道探测' }

    const note = (message: string): void => {
        problems.push(message)
        if (problems.length > MAX_PROBLEMS) problems.shift()
        options.logger?.warn(message)
    }

    const inspect = (channel: InteractionChannel): { name: string } => {
        if (typeof channel !== 'object' || channel === null) {
            throw new Error('interaction 通道必须是对象（实现 send/describe）')
        }
        const name = (channel as { name?: unknown }).name
        if (typeof name !== 'string' || name.trim() === '') {
            throw new Error('interaction 通道必须有非空的 name')
        }
        if (typeof (channel as { send?: unknown }).send !== 'function') {
            throw new Error(`interaction 通道 "${name}" 没有 send()：注册被拒绝（一个不能推送的通道不是通道）`)
        }
        return { name }
    }

    const describeOf = (channel: InteractionChannel): { canAsk: boolean; canNotify: boolean; reason: string } => {
        const hasWait = typeof channel.wait === 'function'
        let reported = { canAsk: true, canNotify: true }
        let reason = ''
        try {
            const described = channel.describe()
            if (typeof described !== 'object' || described === null) {
                reason = 'describe() 返回了非对象（按结构能力判定）'
            } else {
                reported = { canAsk: described.canAsk === true, canNotify: described.canNotify === true }
            }
        } catch (error) {
            // A channel that cannot describe itself is still usable: fall back to
            // what it structurally has, and say that this is what happened.
            reason = `describe() 抛错：${error instanceof Error ? error.message : String(error)}（按结构能力判定）`
        }
        const canAsk = hasWait && reported.canAsk
        const canNotify = reported.canNotify
        const notes: string[] = []
        if (!hasWait) notes.push('未实现 wait()，只能推送不能收答案')
        else if (!reported.canAsk) notes.push('通道自报 canAsk=false')
        if (!reported.canNotify) notes.push('通道自报 canNotify=false')
        if (reason !== '') notes.push(reason)
        return { canAsk, canNotify, reason: notes.join('；') }
    }

    const ledgers = new Set<string>()
    /** One attention sidecar per workspace, keyed by the ledger it derives from. */
    const attentionSources = new Map<string, AttentionSource>()
    /** The sources that actually know a mission (the only ones a pause may write to). */
    const sourcesFor = (missionId: string): AttentionSource[] => {
        const out: AttentionSource[] = []
        for (const source of attentionSources.values()) {
            try {
                if (source.records().some((record) => record.missionId === missionId)) out.push(source)
            } catch (error) {
                note(`读取 attention 失败（${source.file}）：${error instanceof Error ? error.message : String(error)}（该工作区不参与暂停记录）`)
            }
        }
        return out
    }

    const registry: InteractionRegistry = {
        // Total by contract: a rejected registration is RECORDED (problems() +
        // the plugin log) and returns a no-op disposer, so a channel plugin can
        // never crash the process by registering twice.
        register(channel: InteractionChannel): () => void {
            let name: string
            try {
                name = inspect(channel).name
            } catch (error) {
                note(`拒绝注册一个非法的 interaction 通道：${error instanceof Error ? error.message : String(error)}`)
                return () => undefined
            }
            if (channels.has(name)) {
                note(
                    `拒绝重复注册通道 "${name}"：同名通道会让"这个答案是谁给的"变得无法回答；` +
                        '先 unregister（或用上一次返回的 disposer）再重新注册',
                )
                return () => undefined
            }
            channels.set(name, channel)
            return () => {
                if (channels.get(name) === channel) channels.delete(name)
            }
        },

        unregister(name: string): boolean {
            return channels.delete(name)
        },

        get(name: string): InteractionChannel | undefined {
            return channels.get(name)
        },

        list(): ChannelInfo[] {
            const out: ChannelInfo[] = []
            let order = 0
            for (const channel of channels.values()) {
                try {
                    const described = describeOf(channel)
                    out.push({ name: channel.name, canAsk: described.canAsk, canNotify: described.canNotify, reason: described.reason, order })
                } catch (error) {
                    // describeOf already swallows a throwing describe(); this is
                    // the belt for anything else (a hostile proxy, say).
                    note(`通道能力报告失败：${error instanceof Error ? error.message : String(error)}`)
                    out.push({ name: channel.name, canAsk: false, canNotify: false, reason: '能力报告失败（见通道缺陷）', order })
                }
                order += 1
            }
            return out
        },

        describeAll(): ChannelInfo[] {
            return registry.list()
        },

        trackLedger(file: string): void {
            if (typeof file === 'string' && file !== '') ledgers.add(file)
        },

        ledgers(): string[] {
            return [...ledgers]
        },

        // Derived from the ledger, exactly like `interaction_status`: a row with
        // a token and no decision, minus the ones a later decision row superseded.
        pending(): PendingInteraction[] {
            const out: PendingInteraction[] = []
            for (const file of ledgers) {
                try {
                    const read = readLedger(file)
                    const summary = summarizeLedger(read.rows, now(), read.skipped)
                    for (const entry of summary.pending) {
                        out.push({
                            id: entry.questionId,
                            questionId: entry.questionId,
                            title: entry.title,
                            at: entry.at,
                            ...(entry.channel === undefined ? {} : { channel: entry.channel }),
                            ...(entry.missionId === undefined ? {} : { missionId: entry.missionId }),
                        })
                    }
                } catch (error) {
                    note(`读取台账失败（${file}）：${error instanceof Error ? error.message : String(error)}（该台账不参与 pending 统计）`)
                }
            }
            out.sort((a, b) => a.at - b.at)
            return out
        },

        async send(name: string, message: InteractionMessage): Promise<ChannelSendResult> {
            const channel = channels.get(name)
            // "Not registered" is permanent: no later replay can make a channel
            // exist, so the outbox must not keep retrying the question.
            if (channel === undefined) return { ok: false, error: `通道 "${name}" 未注册`, permanent: true }
            try {
                const result = await channel.send(message)
                if (typeof result !== 'object' || result === null) {
                    const error = `通道 "${name}" 的 send() 返回了非对象（按失败处理）`
                    note(error)
                    return { ok: false, error }
                }
                if (result.ok !== true) {
                    return {
                        ok: false,
                        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
                        error: result.error ?? '通道未说明失败原因',
                        ...(result.permanent === true ? { permanent: true } : {}),
                        ...(result.defer === true ? { defer: true } : {}),
                    }
                }
                return { ok: true, ...(result.messageId === undefined ? {} : { messageId: result.messageId }) }
            } catch (error) {
                const message2 = `通道 "${name}" 的 send() 抛错：${error instanceof Error ? error.message : String(error)}`
                note(message2)
                return { ok: false, error: message2 }
            }
        },

        arm(questionId: string): boolean {
            if (questionId === '') {
                note('拒绝 arm 一个空令牌')
                return false
            }
            if (pending.has(questionId)) {
                note(`拒绝重复 arm 的令牌 ${questionId}（令牌必须不可预测且一次性）`)
                return false
            }
            pending.set(questionId, { questionId, armedAt: now(), settle: undefined, early: undefined })
            return true
        },

        retire(questionId: string): void {
            const entry = pending.get(questionId)
            if (entry === undefined) return
            pending.delete(questionId)
            entry.settle = undefined
        },

        submit(questionId: string, answer: InteractionAnswer): boolean {
            const entry = pending.get(questionId)
            const normalized = normalizeAnswer(answer)
            if (entry === undefined || normalized === undefined) {
                dropped += 1
                return false
            }
            const settled: AwaitResult = { outcome: 'answered', answer: normalized }
            if (entry.settle === undefined) {
                // Armed but nobody is listening yet: hold it for the waiter.
                if (entry.early !== undefined) {
                    dropped += 1
                    return false
                }
                entry.early = settled
                return true
            }
            entry.settle(settled)
            return true
        },

        async awaitAnswer(questionId: string, timeoutMs: number, awaitOptions: AwaitOptions = {}): Promise<AwaitResult> {
            const entry = pending.get(questionId)
            if (entry === undefined) return { outcome: 'unknown-token', answer: null }
            const buffered = entry.early
            if (buffered !== undefined) {
                pending.delete(questionId)
                return buffered
            }
            const signal = awaitOptions.signal
            const extension = awaitOptions.extension
            return await new Promise<AwaitResult>((resolve) => {
                let settled = false
                let timer: ReturnType<typeof setTimeout> | undefined
                const clock = (): number => (extension === undefined ? Date.now() : extension.now())
                const startedAt = clock()
                /** How much the pause interval added so far (re-read on every deadline check). */
                let extensionMs = 0
                let pausedNow = false
                let polls = 0
                let lastClock = startedAt
                const deadlineAt = (): number => startedAt + timeoutMs + extensionMs
                const finish = (result: AwaitResult): void => {
                    if (settled) return
                    settled = true
                    if (timer !== undefined) clearTimeout(timer)
                    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
                    pending.delete(questionId)
                    entry.settle = undefined
                    resolve(extensionMs === 0 ? result : { ...result, extensionMs })
                }
                const onAbort = (): void => finish({ outcome: 'cancelled', answer: null })
                /**
                 * Re-read the pause interval. A throw is "no extension" (never a
                 * silently longer wait): the recorded rows are the only source.
                 */
                const sample = (): void => {
                    if (extension === undefined) return
                    try {
                        extensionMs = Math.max(0, Math.floor(extension.pausedMs()))
                    } catch (error) {
                        note(`读取暂停区间失败：${error instanceof Error ? error.message : String(error)}（本次等待按原期限计）`)
                        extensionMs = 0
                    }
                    try {
                        pausedNow = extension.paused?.() === true
                    } catch {
                        pausedNow = false
                    }
                }
                /** Arm (or re-arm) the deadline timer against the EXTENDED deadline. */
                const arm = (): void => {
                    if (timer !== undefined) clearTimeout(timer)
                    const remaining = Math.max(0, deadlineAt() - clock())
                    // While the mission is paused the deadline does not run, so
                    // the timer only ever asks again — it never expires the wait.
                    // Otherwise the grace lets a channel report its own timeout
                    // first (see TIMEOUT_GRACE_MS).
                    const delay = pausedNow ? Math.max(EXTENSION_POLL_MS, remaining) : remaining + TIMEOUT_GRACE_MS
                    timer = setTimeout(onDeadline, delay)
                    // A long timer must not keep the process alive on its own.
                    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
                }
                /**
                 * The deadline check. A pause MOVES the deadline, so the answer is
                 * "re-arm" whenever the clock says there is time left or the
                 * mission is paused; a clock that does not move cannot extend
                 * anything and fails closed instead of spinning.
                 */
                const onDeadline = (): void => {
                    if (settled) return
                    const nowMs = clock()
                    sample()
                    const deadline = deadlineAt()
                    const mustWait = pausedNow || nowMs < deadline
                    if (!mustWait) {
                        finish({ outcome: 'timeout', answer: null })
                        return
                    }
                    if (nowMs <= lastClock || polls >= MAX_EXTENSION_POLLS) {
                        // No progress is possible: report the timeout we DO know
                        // about rather than waiting on a clock that will not move.
                        if (pausedNow) {
                            note(`等待已延长 ${extensionMs}ms（mission 处于暂停），但时钟没有前进：按超时结束，避免永久挂起`)
                        }
                        finish({ outcome: 'timeout', answer: null })
                        return
                    }
                    lastClock = nowMs
                    polls += 1
                    arm()
                }
                pausedNow = false
                arm()
                if (signal !== undefined) {
                    if (signal.aborted) {
                        finish({ outcome: 'cancelled', answer: null })
                        return
                    }
                    signal.addEventListener('abort', onAbort, { once: true })
                }
                entry.settle = finish
                const wait = awaitOptions.wait
                if (wait === undefined) return
                let attempts = 0
                // Pull in a loop: an answer that belongs to ANOTHER token is
                // dropped and the ask keeps waiting (the deadline, not the
                // channel, decides when to stop). The attempt cap keeps a
                // channel that only ever answers the wrong token from spinning
                // us — the outer timer still ends the ask.
                const pull = (): void => {
                    attempts += 1
                    const remaining = Math.max(1, deadlineAt() - clock())
                    void (async (): Promise<void> => {
                        let raw: unknown
                        try {
                            raw = await wait(questionId, remaining, signal)
                        } catch (error) {
                            note(`通道的 wait() 抛错：${error instanceof Error ? error.message : String(error)}（按"没有答案"处理，等待继续到截止时间）`)
                            return
                        }
                        if (settled) {
                            dropped += 1
                            return
                        }
                        if (raw === null || raw === undefined) {
                            // The channel gave up (its own timeout/abort). That is
                            // only the END of the ask when the (possibly extended)
                            // deadline has really passed: a channel that gave up
                            // inside a pause must be re-pulled, not obeyed.
                            sample()
                            const canContinue = pausedNow || clock() < deadlineAt()
                            if (canContinue && attempts < MAX_WAIT_ATTEMPTS + MAX_EXTENSION_ATTEMPTS) {
                                pull()
                                return
                            }
                            finish({ outcome: 'timeout', answer: null })
                            return
                        }
                        const claimed = claimedToken(raw)
                        if (claimed !== undefined && claimed !== questionId) {
                            dropped += 1
                            note(`丢弃一个声称回答令牌 ${claimed} 的答案（本次提问的令牌是 ${questionId}），继续等待`)
                            if (attempts < MAX_WAIT_ATTEMPTS) pull()
                            return
                        }
                        const answer = normalizeAnswer(raw)
                        if (answer === undefined) {
                            dropped += 1
                            note('丢弃一个没有 value 的答案（通道必须返回 { value }）')
                            if (attempts < MAX_WAIT_ATTEMPTS) pull()
                            return
                        }
                        finish({ outcome: 'answered', answer })
                    })()
                }
                pull()
            })
        },

        droppedAnswers(): number {
            return dropped
        },

        attachAttention(source: AttentionSource): void {
            if (typeof source !== 'object' || source === null || typeof source.attentions !== 'function') {
                note('拒绝挂载一个非法的 attention 来源（必须实现 attentions()）')
                return
            }
            attentionSources.set(source.ledgerFile, source)
        },

        attentions(): Attention[] {
            const out: Attention[] = []
            for (const source of attentionSources.values()) {
                try {
                    out.push(...source.attentions())
                } catch (error) {
                    note(`读取 attention 失败（${source.file}）：${error instanceof Error ? error.message : String(error)}（该工作区不参与注意力统计）`)
                }
            }
            out.sort((left, right) => left.askedAt - right.askedAt || left.questionId.localeCompare(right.questionId))
            return out
        },

        pauseMission(missionId: string, reason?: string): boolean {
            if (missionId === '') return false
            let changed = false
            for (const source of sourcesFor(missionId)) {
                if (source.pauseMission(missionId, reason)) changed = true
            }
            return changed
        },

        resumeMission(missionId: string): boolean {
            if (missionId === '') return false
            let changed = false
            for (const source of sourcesFor(missionId)) {
                if (source.resumeMission(missionId)) changed = true
            }
            return changed
        },

        supersedeMission(missionId: string, reason: string): number {
            if (missionId === '') return 0
            let closed = 0
            for (const source of sourcesFor(missionId)) closed += source.supersede({ missionId, reason })
            return closed
        },

        withdrawQuestion(questionId: string, reason: string): boolean {
            if (questionId === '') return false
            let changed = false
            for (const source of attentionSources.values()) {
                if (source.withdraw(questionId, reason)) changed = true
            }
            return changed
        },

        problems(): string[] {
            return [...problems]
        },

        im(): ImChannelReport {
            return { ...imReport }
        },

        setIm(report: ImChannelReport): void {
            imReport = { ...report }
        },

        reportProblem(message: string): void {
            note(message)
        },
    }
    return registry
}

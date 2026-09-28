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
import { readLedger, summarizeLedger } from './ledger.js'

/** What the suite is sending. */
export type InteractionKind = 'ask' | 'notify' | 'progress'

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
}

/** What a channel reports about one send. */
export interface ChannelSendResult {
    ok: boolean
    /** Channel-side id of the delivered message (card), for the ledger. */
    messageId?: string
    /** Why it failed, in Chinese, when `ok` is false. */
    error?: string
}

/** One answer. */
export interface InteractionAnswer {
    /** The answer text: a declared option, or free text when none were declared. */
    value: string
    /** Who answered — the channel's own identity claim (never verified here). */
    by?: string
    /** Channel-side id of the message/card the answer came from. */
    messageId?: string
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
    /** fire-and-forget; must never throw */
    send(message: {
        kind: 'ask' | 'notify' | 'progress'
        title: string
        body: string
        questionId?: string
        buttons?: { value: string; label: string }[]
    }): Promise<{ ok: boolean; messageId?: string; error?: string }>
    /** wait for the answer to `questionId`; resolve null on timeout/abort */
    wait?(
        questionId: string,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<{ value: string; by?: string; messageId?: string } | null>
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

/** How an ask ended. */
export type AwaitOutcome = 'answered' | 'timeout' | 'cancelled' | 'unknown-token'

/** The result of waiting for one token. */
export interface AwaitResult {
    outcome: AwaitOutcome
    answer: InteractionAnswer | null
}

/** Options for {@link InteractionRegistry.awaitAnswer}. */
export interface AwaitOptions {
    /** The chosen channel's own `wait`, when it has one (the pull path). */
    wait?: (questionId: string, timeoutMs: number, signal?: AbortSignal) => Promise<InteractionAnswer | null>
    signal?: AbortSignal
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
    /** Channel defects observed so far (bounded), for the doctor. */
    problems(): string[]
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
    return {
        value,
        ...(by === undefined ? {} : { by }),
        ...(messageId === undefined ? {} : { messageId }),
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
            if (channel === undefined) return { ok: false, error: `通道 "${name}" 未注册` }
            try {
                const result = await channel.send(message)
                if (typeof result !== 'object' || result === null) {
                    const error = `通道 "${name}" 的 send() 返回了非对象（按失败处理）`
                    note(error)
                    return { ok: false, error }
                }
                if (result.ok !== true) {
                    return { ok: false, ...(result.messageId === undefined ? {} : { messageId: result.messageId }), error: result.error ?? '通道未说明失败原因' }
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
            return await new Promise<AwaitResult>((resolve) => {
                let settled = false
                const finish = (result: AwaitResult): void => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
                    pending.delete(questionId)
                    entry.settle = undefined
                    resolve(result)
                }
                const onAbort = (): void => finish({ outcome: 'cancelled', answer: null })
                const timer = setTimeout(() => finish({ outcome: 'timeout', answer: null }), Math.max(0, timeoutMs))
                // A long timer must not keep the process alive on its own.
                if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
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
                const realStart = Date.now()
                let attempts = 0
                // Pull in a loop: an answer that belongs to ANOTHER token is
                // dropped and the ask keeps waiting (the deadline, not the
                // channel, decides when to stop). The attempt cap keeps a
                // channel that only ever answers the wrong token from spinning
                // us — the outer timer still ends the ask.
                const pull = (): void => {
                    attempts += 1
                    const remaining = Math.max(1, timeoutMs - (Date.now() - realStart))
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
                            // The channel gave up (its own timeout/abort): no answer arrived.
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

        problems(): string[] {
            return [...problems]
        },
    }
    return registry
}

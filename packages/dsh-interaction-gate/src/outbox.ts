/**
 * The ask outbox: a question is written down BEFORE anybody is paged.
 *
 * Today an ask is sent and awaited inline. If the process dies, the host
 * restarts, or a channel flaps between "we decided to ask" and "the card left
 * the process", the question vanishes silently while the gate only ever sees
 * "no answer". This module is the durability layer around that send: the
 * INTENT is a row on disk, every later transition is another row, and a reader
 * derives the state of each question by "last row wins per id".
 *
 * The rules, and why they are these rules
 * ---------------------------------------
 *  1. **Intent before the network.** {@link Outbox.begin} appends an `intent`
 *     row and only then may the caller hand the card to a channel. A torn tail
 *     line (a crash mid-write) is tolerated by the reader and COUNTED — "0 rows"
 *     and "a file we could not read" must never look the same.
 *  2. **Content-addressed id.** {@link outboxIdOf} hashes
 *     `(channel, chatId, questionId)`: replaying the same question produces the
 *     same id, so a replay can never enqueue a second question — the id is the
 *     question's identity, not a counter.
 *  3. **One conversation, one outstanding question.** For a `(channel, chatId)`
 *     pair, a later send waits while an EARLIER record of the same pair is
 *     unsettled and has not yet failed {@link ORDER_FAILURE_LIMIT} times. A
 *     record that keeps failing stops blocking its conversation (otherwise one
 *     poisoned question would block that chat for ever) and becomes a system
 *     problem in the doctor instead. Different conversations never wait for
 *     each other.
 *  4. **A deferral is not a failure.** "No free slot" / "the host is paused" /
 *     "the channel is temporarily unavailable" are recorded as their own
 *     `deferred` row and do NOT increment `attempts`; only a real send failure
 *     does, and a failure sets `nextAttemptAt` with exponential backoff
 *     ({@link BACKOFF_BASE_MS} doubling to {@link BACKOFF_MAX_MS}).
 *  5. **Permanent failures are `dropped` with a reason, once.** A channel that
 *     is gone/not found/does not support this payload, or a question that
 *     expires before delivery, can never succeed: it is settled `dropped`, it
 *     keeps `at` + `settleReason`, and no later replay re-enqueues it.
 *  6. **Replay is opportunistic, never a timer.** The suite's plugins are
 *     session-scoped, not daemons: replay runs when something runs (the plugin
 *     is applied, or a new ask is about to send). An idle session does not
 *     retry — that is the boundary of this design, stated instead of hidden.
 *  7. **An outbox row is never an answer.** `intent` / `sent` / `send-failed` /
 *     `deferred` / `dropped` all mean "no human decision". Nothing here is read
 *     to grant anything: the decision ledger stays the only record of what a
 *     human decided, and the one-shot token stays the only way to answer.
 *
 * Everything in this module is deterministic: the clock is injected, the sleep
 * used by the ordering gate is injectable, and no function reads `Date.now()`
 * or performs a network call of its own.
 *
 * @module dsh-interaction-gate/outbox
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, formatTime, readText } from 'dsh-eng-core'

/** Every state a record may be in. Append-only, last-wins per id. */
export type OutboxState = 'intent' | 'sent' | 'deferred' | 'send-failed' | 'answered' | 'timeout' | 'dropped' | 'withdrawn'

/** The states, in the order the doctor reports them. */
export const OUTBOX_STATES: readonly OutboxState[] = ['intent', 'sent', 'deferred', 'send-failed', 'answered', 'timeout', 'dropped', 'withdrawn']

/** States after which a record never moves again. */
export const TERMINAL_OUTBOX_STATES: readonly OutboxState[] = ['answered', 'timeout', 'dropped', 'withdrawn']

/** States a replay may act on (`intent` / `send-failed` per the contract, plus the explicit `deferred`). */
export const RETRYABLE_OUTBOX_STATES: readonly OutboxState[] = ['intent', 'deferred', 'send-failed']

/** How many send failures a record may have before it stops blocking its conversation. */
export const ORDER_FAILURE_LIMIT = 3

/** First retry delay (5 s), doubling… */
export const BACKOFF_BASE_MS = 5_000

/** …up to this ceiling. */
export const BACKOFF_MAX_MS = 300_000

/** How often the ordering gate re-reads the outbox while it waits (ms). */
export const SLOT_POLL_MS = 10

/** How many defect lines one class contributes (a bounded doctor section). */
const MAX_PROBLEMS_PER_CLASS = 5

/** The kind of every outbox record (asks are the only durable interaction today). */
export const OUTBOX_KIND = 'ask' as const

/** The default outbox path, relative to the workspace (a runtime dir the doctor already ignores). */
export const DEFAULT_OUTBOX_FILE = '.dsh/interaction/outbox.jsonl'

/** What a channel may say about a failed send (see `ChannelSendResult.permanent`). */
export interface OutboxDelivery {
    ok: boolean
    /** Channel-side message id, when one was returned. */
    messageId?: string
    /** Why it failed (Chinese), recorded as `settleReason` / shown in the report. */
    error?: string
    /**
     * `true` = never retry (the channel is gone, does not support this payload,
     * or the request expired). `false`/absent = a transient failure.
     */
    permanent?: boolean
    /**
     * `true` = nothing was sent and that is NOT a failure (the channel is
     * temporarily unavailable / has no free slot): the record becomes
     * `deferred` and `attempts` is left alone.
     */
    deferred?: boolean
    /** The decision-ledger row a FIRST delivery wrote (absent on a replay that found one). */
    ledgerRowId?: string
    /** The ledger refused the row: the ask must fail closed exactly as before. */
    ledgerProblem?: string
    /** The ledger already had a row for this question+channel (a replay must not add a second). */
    ledgerReused?: boolean
}

/** One delivery attempt, injected by the caller (a tool or a test). */
export type OutboxDeliver = (record: OutboxRecord) => Promise<OutboxDelivery>

/**
 * One row of `<repo>/.dsh/interaction/outbox.jsonl`.
 *
 * Deliberately small and self-describing: every row repeats the identity of the
 * question (`id`, `questionId`, `channel`, `chatId`, `kind`, `createdAt`) and
 * carries the whole of its own transition (`state`, `attempts`,
 * `nextAttemptAt?`, `settleReason?`, `at`). Last row per `id` is the truth, so a
 * reader never has to replay a diff — and a torn tail line loses at most one
 * transition, not the question.
 */
export interface OutboxRow {
    /** Content-addressed id (see {@link outboxIdOf}): a replay reuses it. */
    id: string
    /** The one-shot token of the ask. */
    questionId: string
    /** The channel the question goes to. */
    channel: string
    /** The conversation on that channel (absent = the channel's single implicit one). */
    chatId?: string
    kind: 'ask'
    /** Epoch ms the question was first recorded (stable across rows). */
    createdAt: number
    state: OutboxState
    /** How many times DELIVERY FAILED (a deferral never counts). */
    attempts: number
    /** When the next retry is allowed (set by a failure; absent = now). */
    nextAttemptAt?: number
    /** Why the record was deferred or dropped (never an answer, never a credential). */
    settleReason?: string
    /** Epoch ms this row was appended. */
    at: number
}

/** A derived record: the last row appended for one id. */
export type OutboxRecord = OutboxRow

/** What one outbox read produced. */
export interface OutboxRead {
    file: string
    present: boolean
    rows: OutboxRow[]
    /** Lines that were not a usable row (a truncated tail line is the normal case). */
    skipped: number
    /** Why, bounded (never the raw line: a payload may carry a credential). */
    problems: string[]
    /** Total non-empty lines seen (including skipped ones). */
    lines: number
}

/** Whether a state is settled (nothing will move it again). */
export function isOutboxSettled(state: OutboxState): boolean {
    return TERMINAL_OUTBOX_STATES.includes(state)
}

/** Whether a state means "no human decision yet" (every non-terminal one does). */
export function isOutboxUnsettled(state: OutboxState): boolean {
    return !isOutboxSettled(state)
}

/** Whether a replay may act on a state. */
export function isOutboxRetryable(state: OutboxState): boolean {
    return RETRYABLE_OUTBOX_STATES.includes(state)
}

/**
 * Backoff for the n-th delivery failure: 5 s, 10 s, 20 s… capped at 300 s.
 * @param failures - how many failures the record has (1 = the first).
 */
export function backoffMs(failures: number): number {
    if (!Number.isFinite(failures) || failures <= 0) return 0
    let delay = BACKOFF_BASE_MS
    for (let index = 1; index < Math.floor(failures) && delay < BACKOFF_MAX_MS; index += 1) delay *= 2
    return Math.min(BACKOFF_MAX_MS, delay)
}

/**
 * The content-addressed id of one question on one conversation.
 * @param input - the question's identity (token + channel + optional chat).
 * @returns `ob-<16 hex chars>`: stable for the same question, distinct otherwise.
 */
export function outboxIdOf(input: { questionId: string; channel: string; chatId?: string }): string {
    const material = `${input.channel}\u0000${input.chatId ?? ''}\u0000${input.questionId}`
    return `ob-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16)}`
}

/** The conversation key of a record (channel + chat, `\0`-joined so it cannot collide). */
export function conversationKeyOf(row: { channel: string; chatId?: string }): string {
    return `${row.channel}\u0000${row.chatId ?? ''}`
}

/** A short, human-facing name for a conversation (`im` or `im/chat-7`). */
export function describeConversation(row: { channel: string; chatId?: string }): string {
    return row.chatId === undefined || row.chatId === '' ? row.channel : `${row.channel}/${row.chatId}`
}

/** Parse one untrusted value into a row; `undefined` when it is not one. */
export function parseOutboxRow(value: unknown): OutboxRow | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const id = raw['id']
    const questionId = raw['questionId']
    const channel = raw['channel']
    const kind = raw['kind']
    const createdAt = raw['createdAt']
    const state = raw['state']
    const attempts = raw['attempts']
    const at = raw['at']
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof questionId !== 'string' || questionId === '') return undefined
    if (typeof channel !== 'string' || channel === '') return undefined
    if (kind !== OUTBOX_KIND) return undefined
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
    if (typeof state !== 'string' || !(OUTBOX_STATES as readonly string[]).includes(state)) return undefined
    if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts < 0) return undefined
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    const chatId = raw['chatId']
    const nextAttemptAt = raw['nextAttemptAt']
    const settleReason = raw['settleReason']
    return {
        id,
        questionId,
        channel,
        ...(typeof chatId === 'string' && chatId !== '' ? { chatId } : {}),
        kind: OUTBOX_KIND,
        createdAt,
        state: state as OutboxState,
        attempts: Math.floor(attempts),
        ...(typeof nextAttemptAt === 'number' && Number.isFinite(nextAttemptAt) ? { nextAttemptAt } : {}),
        ...(typeof settleReason === 'string' && settleReason !== '' ? { settleReason } : {}),
        at,
    }
}

/**
 * Whether the file ends with a newline (`true` for a missing/empty file).
 *
 * A crash can leave a torn last line WITHOUT a trailing newline. Appending to
 * such a file would concatenate the next row onto the broken line and corrupt
 * it too — so an append first terminates the torn line, and the reader keeps
 * counting it as ONE skipped line instead of losing the row we just wrote.
 */
function endsWithNewline(file: string): boolean {
    try {
        const stat = fs.statSync(file)
        if (stat.size === 0) return true
        const fd = fs.openSync(file, 'r')
        try {
            const buffer = Buffer.alloc(1)
            fs.readSync(fd, buffer, 0, 1, stat.size - 1)
            return buffer[0] === 0x0a
        } finally {
            fs.closeSync(fd)
        }
    } catch {
        return true
    }
}

/** Append one row. Never throws: a failure is returned so the caller can report it. */
export function appendOutboxRow(file: string, row: OutboxRow): { ok: boolean; problem?: string } {
    try {
        ensureDir(path.dirname(file))
        // Terminate a torn tail line before writing, so the row we are adding
        // is readable even after a crash mid-write (see {@link readOutbox}).
        fs.appendFileSync(file, `${endsWithNewline(file) ? '' : '\n'}${JSON.stringify(row)}\n`)
        return { ok: true }
    } catch (error) {
        return { ok: false, problem: `outbox 写入失败（${file}）：${error instanceof Error ? error.message : String(error)}` }
    }
}

/**
 * Read the outbox.
 *
 * A truncated last line (a crash mid-write) is skipped and counted — it is not
 * a corrupt outbox. A line that parses but is not a row is also skipped.
 * @param file - absolute outbox path.
 */
export function readOutbox(file: string): OutboxRead {
    const text = readText(file)
    if (text === undefined) return { file, present: false, rows: [], skipped: 0, problems: [], lines: 0 }
    const rows: OutboxRow[] = []
    const problems: string[] = []
    let skipped = 0
    let lines = 0
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
        const line = (parts[index] as string).trim()
        if (line === '') continue
        lines += 1
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            skipped += 1
            if (problems.length < 5) problems.push(`第 ${index + 1} 行不是合法 JSON（截断的尾行属正常，已跳过）`)
            continue
        }
        const row = parseOutboxRow(parsed)
        if (row === undefined) {
            skipped += 1
            if (problems.length < 5) problems.push(`第 ${index + 1} 行不是合法的 outbox 行（缺 id/questionId/channel/createdAt/state/attempts/at 之一），已跳过`)
            continue
        }
        rows.push(row)
    }
    return { file, present: true, rows, skipped, problems, lines }
}

/**
 * Derive one record per id: the last row appended wins.
 * @param rows - rows in file order.
 * @returns the records, oldest `createdAt` first (ties broken by id, so the
 *   order of two questions recorded in the same millisecond is still stable).
 */
export function outboxRecords(rows: readonly OutboxRow[]): OutboxRecord[] {
    const byId = new Map<string, OutboxRecord>()
    for (const row of rows) byId.set(row.id, row)
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * The earlier record that makes `record` wait, if any.
 *
 * "Earlier" is `(createdAt, id)`: two records created in the same millisecond
 * still have one definite order. A record that already failed
 * {@link ORDER_FAILURE_LIMIT} times no longer blocks — one poisoned question
 * must not stop a conversation for ever (it is a system problem instead).
 * @param record - the record about to send.
 * @param records - every derived record (any order).
 */
export function blockingRecordFor(record: OutboxRecord, records: readonly OutboxRecord[]): OutboxRecord | undefined {
    const key = conversationKeyOf(record)
    for (const other of records) {
        if (other.id === record.id || other.questionId === record.questionId) continue
        if (conversationKeyOf(other) !== key) continue
        if (isOutboxSettled(other.state)) continue
        if (other.attempts >= ORDER_FAILURE_LIMIT) continue
        const earlier = other.createdAt < record.createdAt || (other.createdAt === record.createdAt && other.id < record.id)
        if (earlier) return other
    }
    return undefined
}

/** Whether any OTHER record of the same question has already delivered it (or settled it). */
export function deliveredElsewhere(record: OutboxRecord, records: readonly OutboxRecord[]): OutboxRecord | undefined {
    for (const other of records) {
        if (other.id === record.id || other.questionId !== record.questionId) continue
        if (other.state === 'sent' || isOutboxSettled(other.state)) return other
    }
    return undefined
}

/** What the doctor counts (deterministic: `now` is injected). */
export interface OutboxSummary {
    file: string
    present: boolean
    /** Derived records (one per id). */
    total: number
    byState: Record<OutboxState, number>
    /** Unsettled records that are currently waiting for an earlier one of the same conversation. */
    behind: number
    /** The oldest unsettled record and its age. */
    oldestUnsettled?: OutboxRecord
    oldestUnsettledAgeMs?: number
    /** Unsettled records that failed {@link ORDER_FAILURE_LIMIT} times in a row (a system problem). */
    tripped: OutboxRecord[]
    /** Records settled `dropped`, with their reasons. */
    dropped: OutboxRecord[]
    /** Lines the reader skipped (torn tails, foreign rows). */
    skipped: number
    /** Why the reader skipped them (bounded). */
    problems: string[]
}

/**
 * Summarise derived records for the doctor.
 * @param records - derived records ({@link outboxRecords}).
 * @param now - epoch ms to compute ages against (injected).
 * @param file - the outbox path the records came from.
 * @param read - the reader's `skipped`/`problems` (optional).
 */
export function summarizeOutbox(
    records: readonly OutboxRecord[],
    now: number,
    file = '',
    read?: { present?: boolean; skipped?: number; problems?: string[] },
): OutboxSummary {
    const byState: Record<OutboxState, number> = { intent: 0, sent: 0, deferred: 0, 'send-failed': 0, answered: 0, timeout: 0, dropped: 0, withdrawn: 0 }
    let behind = 0
    let oldest: OutboxRecord | undefined
    const tripped: OutboxRecord[] = []
    const dropped: OutboxRecord[] = []
    for (const record of records) {
        byState[record.state] += 1
        if (record.state === 'dropped') dropped.push(record)
        if (isOutboxUnsettled(record.state)) {
            if (oldest === undefined || record.createdAt < oldest.createdAt) oldest = record
            if (record.attempts >= ORDER_FAILURE_LIMIT) tripped.push(record)
            if (blockingRecordFor(record, records) !== undefined) behind += 1
        }
    }
    return {
        file,
        present: read?.present ?? false,
        total: records.length,
        byState,
        behind,
        ...(oldest === undefined ? {} : { oldestUnsettled: oldest, oldestUnsettledAgeMs: Math.max(0, now - oldest.createdAt) }),
        tripped,
        dropped,
        skipped: read?.skipped ?? 0,
        problems: read?.problems ?? [],
    }
}

/** What one replay did (the log line and the report read this). */
export interface OutboxReplayReport {
    trigger: 'apply' | 'ask' | 'manual'
    /** Retryable records the replay looked at. */
    considered: number
    /** Records actually re-sent (a live payload + an armed token still existed). */
    resent: number
    /** Records that were retried and failed again (a new backoff was set). */
    failed: number
    /** Records settled terminally because they can never be asked again. */
    dropped: number
    /** Records whose backoff has not elapsed yet. */
    notDue: number
    /** Records still waiting for an earlier question of the same conversation. */
    behind: number
    /** Records skipped because the same question was already delivered/settled elsewhere. */
    superseded: number
}

/** One-line Chinese summary of a replay (the log must state what it did). */
export function describeReplay(report: OutboxReplayReport): string {
    return (
        `outbox 重放（${report.trigger}）：检查 ${report.considered}，重发 ${report.resent}，再次失败 ${report.failed}，` +
        `丢弃 ${report.dropped}，未到期 ${report.notDue}，排队 ${report.behind}，已投递过 ${report.superseded}`
    )
}

/** A payload attached to a record: the only thing a replay may re-send. */
interface Attachment {
    deliver: OutboxDeliver
    /** Epoch ms after which the attached question must not be sent any more. */
    deadlineAt?: number
}

/** Options for {@link createOutbox}. */
export interface OutboxOptions {
    /** Absolute path of the JSONL file. */
    file: string
    /** Injected clock (no `Date.now()` in this module). */
    now: () => number
    /** Sink for outbox defects (the registry's bounded `problems()` list). */
    note?: (message: string) => void
    /** Injected wait used by the ordering gate (tests drive this deterministically). */
    sleep?: (ms: number) => Promise<void>
}

/** What `begin` reports. */
export interface OutboxBegin {
    record: OutboxRecord
    /** `true` when this call appended the `intent` row; `false` = nothing was appended (see `problem`, or the id already existed). */
    created: boolean
    /** Set when the intent row could NOT be written: the caller must not send anything. */
    problem?: string
}

/** What `awaitSlot` reports. */
export interface OutboxSlot {
    ok: boolean
    /** How many deferral rows were recorded (0 or 1: a deferral is recorded once, not per poll). */
    deferrals: number
    waitedMs: number
    blockedBy?: OutboxRecord
    /** `true` = the budget ran out while an earlier record was still unsettled. */
    timedOut?: boolean
}

/** What `deliver` reports. */
export interface OutboxDeliveryResult {
    ok: boolean
    /** The record after the attempt (absent only when the id is unknown). */
    record?: OutboxRecord
    delivery?: OutboxDelivery
    /** Why nothing was attempted (no payload, already settled, expired…). */
    problem?: string
    /** `true` = the question expired before delivery and was settled `dropped`. */
    expired?: boolean
}

/** The outbox handle one workspace (one file) gets. */
export interface Outbox {
    readonly file: string
    /** Append the `intent` row; idempotent per content-addressed id. */
    begin(input: { questionId: string; channel: string; chatId?: string }): OutboxBegin
    /** Derive the record for one id (`undefined` when the file has none). */
    get(id: string): OutboxRecord | undefined
    /** Every derived record, oldest first. */
    records(): OutboxRecord[]
    /** The earlier record that currently blocks `id` (the `behind` rule). */
    blockedBy(id: string): OutboxRecord | undefined
    /** Attach the live payload of a question (the only thing a replay may re-send). */
    attach(id: string, deliver: OutboxDeliver, options?: { deadlineAt?: number }): void
    /** Forget the payload (the ask is over: a replay must never re-ask it). */
    detach(id: string): void
    /** Wait (bounded by `deadlineAt`) until no earlier record of the conversation blocks. */
    awaitSlot(id: string, deadlineAt: number): Promise<OutboxSlot>
    /** Record a deferral that is NOT a failure (no `attempts` change). */
    defer(id: string, reason: string): OutboxRecord | undefined
    /** Send through the attached payload, recording `sent` / `send-failed` / `dropped`. */
    deliver(id: string): Promise<OutboxDeliveryResult>
    /** Settle ONE record (a decision or a terminal outcome the ledger already holds). */
    settle(id: string, state: OutboxState, reason?: string): OutboxRecord | undefined
    /** Settle every unsettled record of one question (fallback channels included). */
    settleQuestion(questionId: string, state: OutboxState, reason?: string): void
    /** Replay: retry what a live payload can still deliver, settle what can never be asked again. */
    replay(trigger: OutboxReplayReport['trigger']): Promise<OutboxReplayReport>
    /** The doctor's counts. */
    summary(): OutboxSummary
    /** Outbox defects (bounded), derived from the file: system problems and dropped rows. */
    problems(): string[]
    /** Feed the derived defects into `note()` once each (never as a recurring defect). */
    sync(): void
    /** Short Chinese lines describing one question's records (for a tool report). */
    linesFor(questionId: string): string[]
}

/** Bound a free-text reason for a report line. */
function bounded(text: string, maxChars: number): string {
    const trimmed = text.trim()
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Create the outbox for one file.
 *
 * The file is the truth: every read re-parses it, so two handles over the same
 * file (or a replay after another write) can never disagree. The in-memory map
 * holds only what a file cannot: the live payload of a question that is still
 * being asked in THIS process.
 * @param options - path, clock, defect sink and the ordering gate's sleep.
 */
export function createOutbox(options: OutboxOptions): Outbox {
    const file = options.file
    const now = options.now
    const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))))
    const attachments = new Map<string, Attachment>()
    const noted = new Set<string>()

    const note = (message: string): void => {
        options.note?.(message)
    }

    const read = (): OutboxRead => readOutbox(file)

    const append = (row: OutboxRow): { ok: boolean; problem?: string } => {
        const appended = appendOutboxRow(file, row)
        if (!appended.ok && appended.problem !== undefined) note(appended.problem)
        return appended
    }

    /** Build the full row for one transition (leaving out what the transition clears). */
    const transition = (
        record: OutboxRecord,
        state: OutboxState,
        at: number,
        extra: { attempts?: number; nextAttemptAt?: number; settleReason?: string } = {},
    ): OutboxRow => ({
        id: record.id,
        questionId: record.questionId,
        channel: record.channel,
        ...(record.chatId === undefined ? {} : { chatId: record.chatId }),
        kind: OUTBOX_KIND,
        createdAt: record.createdAt,
        state,
        attempts: extra.attempts ?? record.attempts,
        ...(extra.nextAttemptAt === undefined ? {} : { nextAttemptAt: extra.nextAttemptAt }),
        ...(extra.settleReason === undefined ? {} : { settleReason: bounded(extra.settleReason, 400) }),
        at,
    })

    const find = (id: string): OutboxRecord | undefined => outboxRecords(read().rows).find((record) => record.id === id)

    const outbox: Outbox = {
        file,

        begin(input) {
            const id = outboxIdOf(input)
            const existing = find(id)
            if (existing !== undefined) return { record: existing, created: false }
            const at = now()
            const row: OutboxRow = {
                id,
                questionId: input.questionId,
                channel: input.channel,
                ...(input.chatId === undefined || input.chatId === '' ? {} : { chatId: input.chatId }),
                kind: OUTBOX_KIND,
                createdAt: at,
                state: 'intent',
                attempts: 0,
                at,
            }
            const appended = append(row)
            return { record: row, created: appended.ok, ...(appended.ok ? {} : { problem: appended.problem ?? 'outbox 写入失败' }) }
        },

        get(id) {
            return find(id)
        },

        records() {
            return outboxRecords(read().rows)
        },

        blockedBy(id) {
            const records = outboxRecords(read().rows)
            const record = records.find((entry) => entry.id === id)
            return record === undefined ? undefined : blockingRecordFor(record, records)
        },

        attach(id, deliver, attachOptions) {
            attachments.set(id, { deliver, ...(attachOptions?.deadlineAt === undefined ? {} : { deadlineAt: attachOptions.deadlineAt }) })
        },

        detach(id) {
            attachments.delete(id)
        },

        async awaitSlot(id, deadlineAt) {
            const start = now()
            const record = find(id)
            if (record === undefined) return { ok: true, deferrals: 0, waitedMs: 0 }
            let blocker = outbox.blockedBy(id)
            if (blocker === undefined) return { ok: true, deferrals: 0, waitedMs: 0 }
            // The deferral is recorded ONCE (it is a state, not a failure) and it
            // never increments `attempts`: "there was no free slot" must not be
            // able to exhaust the retry budget of a question.
            outbox.defer(
                id,
                `${describeConversation(record)} 里更早的提问 ${blocker.id} 还没落定（已失败 ${blocker.attempts} 次）：同一会话按顺序发送，本次先排队`,
            )
            const budget = Math.max(0, deadlineAt - start)
            const maxPolls = Math.max(1, Math.ceil(budget / SLOT_POLL_MS) + 2)
            for (let poll = 0; poll < maxPolls; poll += 1) {
                if (now() >= deadlineAt) break
                await sleep(SLOT_POLL_MS)
                blocker = outbox.blockedBy(id)
                if (blocker === undefined) {
                    return { ok: true, deferrals: 1, waitedMs: Math.max(0, now() - start) }
                }
            }
            return {
                ok: false,
                deferrals: 1,
                waitedMs: Math.max(0, now() - start),
                ...(blocker === undefined ? {} : { blockedBy: blocker }),
                timedOut: true,
            }
        },

        defer(id, reason) {
            const record = find(id)
            if (record === undefined || isOutboxSettled(record.state)) return undefined
            const row = transition(record, 'deferred', now(), {
                settleReason: reason,
                // A deferral does not clear a backoff a real failure already set.
                ...(record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt }),
            })
            append(row)
            return row
        },

        async deliver(id) {
            const record = find(id)
            if (record === undefined) return { ok: false, problem: `outbox 里没有 id=${id} 的记录：拒绝发送一道没有意图记录的提问` }
            if (isOutboxSettled(record.state)) {
                return { ok: false, record, problem: `这条记录已经结案（state=${record.state}）：不会再次发送，也不会授予任何东西` }
            }
            const attachment = attachments.get(id)
            if (attachment === undefined) {
                return { ok: false, record, problem: '没有可投递的载荷（一次性令牌不在本进程）：重放不会重新提问' }
            }
            const at = now()
            if (attachment.deadlineAt !== undefined && at > attachment.deadlineAt) {
                // #5: the request expiring before delivery is a PERMANENT failure.
                outbox.settle(id, 'dropped', `提问在投递前已过期（截止 ${formatTime(attachment.deadlineAt)}）：不再重试，也不授予任何东西`)
                return { ok: false, record: outbox.get(id) ?? record, expired: true, problem: '提问在投递前已过期' }
            }
            let delivery: OutboxDelivery
            try {
                delivery = await attachment.deliver(record)
            } catch (error) {
                delivery = { ok: false, error: `投递载荷抛错：${error instanceof Error ? error.message : String(error)}` }
            }
            const at2 = now()
            if (delivery.ok) {
                const row = transition(record, 'sent', at2)
                append(row)
                return { ok: true, record: row, delivery }
            }
            if (delivery.permanent === true) {
                const row = transition(record, 'dropped', at2, { settleReason: delivery.error ?? '永久失败（通道不在了，或该通道不支持这个载荷）' })
                append(row)
                return { ok: false, record: row, delivery }
            }
            if (delivery.deferred === true) {
                // Not a failure: `deferred` is its own state and `attempts` is
                // untouched, so a busy/unavailable channel cannot exhaust the
                // retry budget of the question it could not take.
                const row = transition(record, 'deferred', at2, {
                    settleReason: delivery.error ?? '通道暂时不可用（不是失败）',
                    ...(record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt }),
                })
                append(row)
                return { ok: false, record: row, delivery }
            }
            const attempts = record.attempts + 1
            const row = transition(record, 'send-failed', at2, {
                attempts,
                nextAttemptAt: at2 + backoffMs(attempts),
                settleReason: delivery.error ?? '发送失败（通道未说明原因）',
            })
            append(row)
            return { ok: false, record: row, delivery }
        },

        settle(id, state, reason) {
            const record = find(id)
            if (record === undefined || isOutboxSettled(record.state)) return undefined
            if (!isOutboxSettled(state)) return undefined
            const row = transition(record, state, now(), reason === undefined ? {} : { settleReason: reason })
            append(row)
            return row
        },

        settleQuestion(questionId, state, reason) {
            if (!isOutboxSettled(state)) return
            for (const record of outbox.records()) {
                if (record.questionId !== questionId || isOutboxSettled(record.state)) continue
                outbox.settle(record.id, state, reason)
            }
        },

        async replay(trigger) {
            const report: OutboxReplayReport = { trigger, considered: 0, resent: 0, failed: 0, dropped: 0, notDue: 0, behind: 0, superseded: 0 }
            const snapshot = (): OutboxRecord[] => outbox.records()
            for (const queued of snapshot()) {
                // The record may have been settled by an earlier iteration (its
                // sibling answers one question, not two), so re-derive it.
                const record = outbox.get(queued.id)
                if (record === undefined || !isOutboxRetryable(record.state)) continue
                report.considered += 1
                // One question, one card: if another record of the same question
                // already delivered it (or settled it), this one is withdrawn —
                // a replay must never create a second question.
                const sibling = deliveredElsewhere(record, snapshot())
                if (sibling !== undefined) {
                    outbox.settle(record.id, 'withdrawn', `同一提问已由 ${sibling.id}（${describeConversation(sibling)}，state=${sibling.state}）投递或结案：不重复提问`)
                    report.superseded += 1
                    continue
                }
                if (blockingRecordFor(record, snapshot()) !== undefined) {
                    // Order is kept across replays too, and it is a deferral, not a failure.
                    report.behind += 1
                    continue
                }
                const attachment = attachments.get(record.id)
                if (attachment === undefined) {
                    // #7: without a live one-shot token the question can never be
                    // answered, so the retry ends here — recorded, with a reason.
                    outbox.settle(
                        record.id,
                        'dropped',
                        `重放：本进程已没有这道提问的可投递载荷（会话重启、令牌已被消费，或这次提问已经结束）——不再提问，也不授予任何东西；如需决定请重新提问`,
                    )
                    report.dropped += 1
                    continue
                }
                if (record.nextAttemptAt !== undefined && record.nextAttemptAt > now()) {
                    report.notDue += 1
                    continue
                }
                const delivered = await outbox.deliver(record.id)
                if (delivered.ok) report.resent += 1
                else if (delivered.expired === true || delivered.record?.state === 'dropped') report.dropped += 1
                else report.failed += 1
            }
            outbox.sync()
            return report
        },

        summary() {
            const read2 = read()
            return summarizeOutbox(outboxRecords(read2.rows), now(), file, read2)
        },

        problems() {
            const records = outbox.records()
            const dropped: string[] = []
            const tripped: string[] = []
            for (const record of records) {
                if (record.state === 'dropped') {
                    dropped.push(
                        `outbox 行 ${record.id}（提问 ${record.questionId}，${describeConversation(record)}）已丢弃：` +
                            `${bounded(record.settleReason ?? '未说明原因', 200)}——不会再重试，这**不是**一道还在等回答的提问`,
                    )
                    continue
                }
                if (!isOutboxUnsettled(record.state) || record.attempts < ORDER_FAILURE_LIMIT) continue
                tripped.push(
                    `outbox 行 ${record.id}（${describeConversation(record)}）连续失败 ${record.attempts} 次（系统问题）：` +
                        `${bounded(record.settleReason ?? '未说明原因', 200)}；该会话的后续提问不再为它排队，先修通道`,
                )
            }
            return [...dropped.slice(-MAX_PROBLEMS_PER_CLASS), ...tripped.slice(-MAX_PROBLEMS_PER_CLASS)]
        },

        sync() {
            const records = outbox.records()
            for (const record of records) {
                if (record.state === 'dropped') {
                    const key = `${record.id}|dropped`
                    if (noted.has(key)) continue
                    noted.add(key)
                    note(
                        `outbox：行 ${record.id}（提问 ${record.questionId}，${describeConversation(record)}）已丢弃——` +
                            `${bounded(record.settleReason ?? '未说明原因', 160)}`,
                    )
                    continue
                }
                if (!isOutboxUnsettled(record.state) || record.attempts < ORDER_FAILURE_LIMIT) continue
                const key = `${record.id}|tripped`
                if (noted.has(key)) continue
                noted.add(key)
                note(
                    `outbox：行 ${record.id}（提问 ${record.questionId}，${describeConversation(record)}）连续失败 ${record.attempts} 次（系统问题）——` +
                        `${bounded(record.settleReason ?? '未说明原因', 160)}`,
                )
            }
        },

        linesFor(questionId) {
            const out: string[] = []
            for (const record of outbox.records()) {
                if (record.questionId !== questionId) continue
                const next = record.nextAttemptAt === undefined ? '' : `，下次重试 ${formatTime(record.nextAttemptAt)}`
                const reason = record.settleReason === undefined ? '' : `：${bounded(record.settleReason, 160)}`
                out.push(`- outbox ${describeConversation(record)}：${record.id}（${record.state}，失败 ${record.attempts} 次${next}）${reason}`)
                if (out.length >= 3) break
            }
            return out
        },
    }
    return outbox
}

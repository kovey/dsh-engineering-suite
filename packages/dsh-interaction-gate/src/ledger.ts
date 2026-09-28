/**
 * The decision ledger: one append-only JSONL row per interaction event.
 *
 * This is the audit trail of the interaction LAYER, and it is written to be
 * readable by a human with `grep` and by a script with `JSON.parse`:
 *
 *  - an `ask` produces a **pending** row when the card is sent (no `decision`)
 *    and a **decided** row when it resolves, correlated by `questionId`. A
 *    crash mid-ask therefore leaves a visible pending row instead of silence —
 *    which is the whole point of "we asked somebody";
 *  - `notify` and `progress` produce one row per channel attempt, so
 *    `channel` + `messageId` always identify a concrete delivered message;
 *  - a refusal writes `decision: "refused:<reason>"`. The closed vocabulary in
 *    {@link LedgerRow.decision} is the contract `interaction_status` counts by.
 *
 * Appends are a single `appendFileSync` line (atomic enough for a line on one
 * machine, and the same primitive the rest of the suite uses) and can never
 * throw into a tool: a failure is returned so the caller can report it. Reads
 * tolerate a truncated tail line — a crash mid-write is NOT a corrupt ledger —
 * and count what they skipped, because "0 rows" and "a file we could not parse"
 * must not look the same.
 *
 * The ledger records WHAT HAPPENED. It grants nothing: no permission is derived
 * from a row (see the README's limits).
 *
 * @module dsh-interaction-gate/ledger
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readText } from 'dsh-eng-core'

/** The three kinds of interaction. */
export type LedgerKind = 'ask' | 'notify' | 'progress'

/** Every kind, for counting. */
export const LEDGER_KINDS: readonly LedgerKind[] = ['ask', 'notify', 'progress']

/** Prefix of a refusal decision. */
export const REFUSAL_PREFIX = 'refused:'

/** Decision values that are NOT a refusal and not an answer. */
export const NOTIFIED = 'notified'
export const NOTIFY_FAILED = 'notify-failed'
export const PROGRESS = 'progress'
export const FILTERED = 'filtered'

/** One ledger row. Exactly these fields; `at` is epoch ms (the suite's convention). */
export interface LedgerRow {
    at: number
    id: string
    kind: LedgerKind
    /** The one-shot token of an `ask` (present on `ask` rows). */
    questionId?: string
    /** The channel that carried it. */
    channel?: string
    /** Who answered (the channel's identity claim). */
    userId?: string
    /**
     * The decision. One of:
     *  - the suite's approved vocabulary (`allowed-once` / `rejected` /
     *    `cancelled` / `unavailable`) when the answer normalised to one;
     *  - the declared option the answerer chose (or the free-text answer, when
     *    the ask declared none);
     *  - `refused:<reason>` when the ask produced NO decision;
     *  - `notified` / `notify-failed` / `progress` / `filtered` for the other tools.
     * Absent = an ask that has not been decided yet (pending).
     */
    decision?: string
    title: string
    missionId?: string
    /** Channel-side id of the delivered message. */
    messageId?: string
    /** How long the ask waited (ask rows only). */
    durationMs?: number
}

/** A refusal decision for one reason. */
export function refusalOf(reason: string): string {
    return `${REFUSAL_PREFIX}${reason}`
}

/** Whether a decision means "no decision was made". */
export function isRefusal(decision: string | undefined): boolean {
    return typeof decision === 'string' && decision.startsWith(REFUSAL_PREFIX)
}

/** The reason part of a refusal decision (`''` for a non-refusal). */
export function refusalReason(decision: string | undefined): string {
    return isRefusal(decision) ? (decision as string).slice(REFUSAL_PREFIX.length) : ''
}

/** An unpredictable ledger row id. */
export function newRowId(): string {
    return `il-${randomBytes(8).toString('hex')}`
}

/** SHA-256 (hex) of a value: the only form a detected secret is ever recorded in. */
export function fingerprintOf(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Parse one untrusted JSONL value into a row; `undefined` when it is not one. */
export function parseLedgerRow(value: unknown): LedgerRow | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const at = raw['at']
    const id = raw['id']
    const kind = raw['kind']
    const title = raw['title']
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    if (typeof id !== 'string' || id === '') return undefined
    if (kind !== 'ask' && kind !== 'notify' && kind !== 'progress') return undefined
    if (typeof title !== 'string') return undefined
    const optional = (key: keyof LedgerRow): string | undefined => {
        const entry = raw[key]
        return typeof entry === 'string' && entry !== '' ? entry : undefined
    }
    const durationMs = raw['durationMs']
    return {
        at,
        id,
        kind,
        title,
        ...(optional('questionId') === undefined ? {} : { questionId: optional('questionId') as string }),
        ...(optional('channel') === undefined ? {} : { channel: optional('channel') as string }),
        ...(optional('userId') === undefined ? {} : { userId: optional('userId') as string }),
        ...(optional('decision') === undefined ? {} : { decision: optional('decision') as string }),
        ...(optional('missionId') === undefined ? {} : { missionId: optional('missionId') as string }),
        ...(optional('messageId') === undefined ? {} : { messageId: optional('messageId') as string }),
        ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs: Math.max(0, Math.floor(durationMs)) } : {}),
    }
}

/** Append one row. Never throws: a failure is returned so the tool can report it. */
export function appendLedgerRow(file: string, row: LedgerRow): { ok: boolean; problem?: string } {
    try {
        ensureDir(path.dirname(file))
        fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
        return { ok: true }
    } catch (error) {
        return { ok: false, problem: `台账写入失败（${file}）：${error instanceof Error ? error.message : String(error)}` }
    }
}

/** What a ledger read produced. */
export interface LedgerRead {
    file: string
    present: boolean
    rows: LedgerRow[]
    /** Lines that were not a usable row (a truncated tail line is the normal case). */
    skipped: number
    /** Why, bounded (never the raw line: it may hold a secret). */
    problems: string[]
    /** Total lines seen (including skipped ones). */
    lines: number
}

/**
 * Read a ledger file.
 *
 * A truncated last line (crash mid-write) is skipped and counted — it is not a
 * corrupt ledger. A line that parses but is not a row is also skipped.
 * @param file - absolute ledger path.
 */
export function readLedger(file: string): LedgerRead {
    const text = readText(file)
    if (text === undefined) return { file, present: false, rows: [], skipped: 0, problems: [], lines: 0 }
    const rows: LedgerRow[] = []
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
        const row = parseLedgerRow(parsed)
        if (row === undefined) {
            skipped += 1
            if (problems.length < 5) problems.push(`第 ${index + 1} 行不是合法的台账行（缺 at/id/kind/title 之一），已跳过`)
            continue
        }
        rows.push(row)
    }
    return { file, present: true, rows, skipped, problems, lines }
}

/** One ask that has not been decided yet. */
export interface PendingAsk {
    questionId: string
    at: number
    ageMs: number
    title: string
    channel?: string
    missionId?: string
    messageId?: string
}

/** What `interaction_status` counts (deterministic: `now` is injected). */
export interface LedgerSummary {
    total: number
    byKind: Record<LedgerKind, number>
    /** Decision value → row count (rows without a decision are not counted here). */
    byDecision: Record<string, number>
    /** `ask` rows with an accepted decision (not a refusal). */
    answered: number
    refused: number
    /** Refusal reason → count (`refused:<reason>` rows). */
    refusedReasons: Record<string, number>
    /** Rows whose decision is `notify-failed`. */
    notifyFailed: number
    /** Rows with no decision at all. */
    undecided: number
    /** Asks with no decision and no later decision row for the same token. */
    pending: PendingAsk[]
    last?: LedgerRow
    /** Rows the reader skipped (truncated tail lines, foreign rows). */
    skipped: number
}

/**
 * Summarise rows for the status tool.
 * @param rows - ledger rows (already read).
 * @param now - epoch ms to compute pending ages against (injected: no clock here).
 * @param skipped - how many lines the reader skipped.
 */
export function summarizeLedger(rows: readonly LedgerRow[], now: number, skipped = 0): LedgerSummary {
    const byKind: Record<LedgerKind, number> = { ask: 0, notify: 0, progress: 0 }
    const byDecision: Record<string, number> = {}
    const refusedReasons: Record<string, number> = {}
    const decidedTokens = new Set<string>()
    let answered = 0
    let refused = 0
    let notifyFailed = 0
    let undecided = 0

    for (const row of rows) {
        byKind[row.kind] += 1
        if (row.questionId !== undefined && row.decision !== undefined) decidedTokens.add(row.questionId)
    }
    for (const row of rows) {
        const decision = row.decision
        if (decision === undefined) {
            undecided += 1
            continue
        }
        byDecision[decision] = (byDecision[decision] ?? 0) + 1
        if (isRefusal(decision)) {
            refused += 1
            const reason = refusalReason(decision)
            refusedReasons[reason] = (refusedReasons[reason] ?? 0) + 1
            continue
        }
        if (row.kind === 'ask') answered += 1
        if (decision === NOTIFY_FAILED) notifyFailed += 1
    }

    const pending: PendingAsk[] = []
    for (const row of rows) {
        if (row.kind !== 'ask' || row.decision !== undefined) continue
        const token = row.questionId
        // A pending row is superseded by the decision row carrying the same token.
        if (token !== undefined && decidedTokens.has(token)) continue
        pending.push({
            questionId: token ?? '(无令牌)',
            at: row.at,
            ageMs: Math.max(0, now - row.at),
            title: row.title,
            ...(row.channel === undefined ? {} : { channel: row.channel }),
            ...(row.missionId === undefined ? {} : { missionId: row.missionId }),
            ...(row.messageId === undefined ? {} : { messageId: row.messageId }),
        })
    }
    pending.sort((a, b) => a.at - b.at)

    const last = rows.length === 0 ? undefined : rows[rows.length - 1]
    return {
        total: rows.length,
        byKind,
        byDecision,
        answered,
        refused,
        refusedReasons,
        notifyFailed,
        undecided,
        pending,
        skipped,
        ...(last === undefined ? {} : { last }),
    }
}

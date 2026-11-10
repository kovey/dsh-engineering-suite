/**
 * Attention: a question that is waiting for a person.
 *
 * A question to a human already has a ledger (one-shot tokens, append-only rows)
 * and a durable outbox (the intent is written before the channel is touched).
 * Neither can answer the OPERATOR's questions: *why* is a person being asked, is
 * this still current, and how long may it wait while the mission behind it is
 * blocked? Attention is that first-class notion — and it is **derived**.
 *
 * The split, and it is deliberate:
 *
 *  - **derived on read** — "this is an attention" means: a ledger `ask` row
 *    exists and no decision row for its token does. Age, answer, answerer and
 *    channel come from the ledger too. Decisions still come only from the
 *    one-shot token plus the ledger; this module never stores an answer and
 *    never grants anything;
 *  - **stored** — only what no ledger row can carry:
 *    - `why` — which of exactly two things a person must do (`whyYou`), because
 *      a question that does not say what it wants from you is a bad question;
 *    - `superseded` / `withdrawn` — a question that has become moot (the mission
 *      ended/was stopped, or the asker no longer needs the answer). Both are
 *      transitions, not answers, and neither can ever become an approval;
 *    - `pausedFrom` / `pausedTo` — the pause interval. A blocked mission's
 *      questions must NOT burn their deadline, so the reported deadline is
 *      `askedAt + window + pausedMs`.
 *
 * Rows are append-only JSONL (`<repo>/.dsh/interaction/attention.jsonl`), one
 * row per transition, last row wins per kind+question. A reader tolerates a torn
 * tail line and COUNTS it: "no rows" and "a file we could not read" must never
 * look the same.
 *
 * Everything is deterministic: the clock is injected, no `Date.now()`, no
 * network, and every derived number is a pure function of rows + clock.
 *
 * @module dsh-interaction-gate/attention
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, formatTime, mandateState, policyVersion, readText, type MissionStore } from 'dsh-eng-core'
import { isRefusal, readLedger, type LedgerRow } from './ledger.js'

/** The only two things a person may be asked to do. */
export type WhyYou = 'decision-required' | 'result-usable'

/** Every legal `whyYou` value, in the order a report names them. */
export const WHY_YOU_VALUES: readonly WhyYou[] = ['decision-required', 'result-usable']

/**
 * What an attention says when nothing recorded why it exists.
 *
 * "A gate cannot proceed" is the conservative reading: it is the case where
 * silence costs the most, and inventing a third value is exactly what this
 * package must not do.
 */
export const DEFAULT_WHY_YOU: WhyYou = 'decision-required'

/** One-line Chinese gloss of a `whyYou` value (for reports; never a new value). */
export function describeWhyYou(whyYou: WhyYou): string {
    return whyYou === 'result-usable' ? '有一个结果等你去用' : '有一个门禁在等你的决定'
}

/** Why an attention is stale (computed on read, never stored). */
export type StaleReason = 'policy-version' | 'too-old' | 'mission-ended'

/** A stale mark: the stable reason plus the sentence a human reads. */
export interface StaleMark {
    reason: StaleReason
    detail: string
}

/** Every row kind this sidecar keeps. Append-only, last row wins per target. */
export type AttentionKind = 'why' | 'superseded' | 'withdrawn' | 'pausedFrom' | 'pausedTo'

/** Every kind, in the order the doctor names them. */
export const ATTENTION_KINDS: readonly AttentionKind[] = ['why', 'superseded', 'withdrawn', 'pausedFrom', 'pausedTo']

/** The kinds that end a question (recorded once, with a reason). */
export const CLOSING_KINDS: readonly AttentionKind[] = ['superseded', 'withdrawn']

/** Default sidecar path, relative to the workspace (a runtime dir the doctor ignores). */
export const DEFAULT_ATTENTION_FILE = '.dsh/interaction/attention.jsonl'

/** Default bound after which an unanswered question is stale (24 h). */
export const DEFAULT_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000

/**
 * Every state a derived question can be in.
 *
 * `answered` is a real DECISION (the suite's vocabulary or the chosen option);
 * `refused` means an ask ended without one (a timeout, a lost token, an
 * unauthorized answerer) — a refusal is not an answer and never becomes an
 * approval, so it gets its own state. `superseded` / `withdrawn` are the
 * recorded transitions (the question became moot), and they win over `refused`
 * because they say WHY nothing was decided.
 */
export type AttentionState = 'open' | 'answered' | 'refused' | 'superseded' | 'withdrawn'

/** One row of `.dsh/interaction/attention.jsonl`. */
export interface AttentionRow {
    /** Epoch ms the row was appended. */
    at: number
    /** Unpredictable row id (`ar-<16 hex>`). */
    id: string
    kind: AttentionKind
    /** The question this row is about (`why` / `withdrawn` / question-scoped `superseded`). */
    questionId?: string
    /** The mission this row is about (`pausedFrom` / `pausedTo` / mission-scoped `superseded`). */
    missionId?: string
    /** Only on `why`: what a person must do. */
    whyYou?: WhyYou
    /** Why the question was closed / the mission paused (never a credential). */
    reason?: string
    /** `pausedFrom`: when the pause started. `pausedTo`: when it started (echoed). */
    from?: number
    /** `pausedTo`: when the pause ended. */
    to?: number
}

/** An unpredictable row id. */
export function newAttentionRowId(): string {
    return `ar-${randomBytes(8).toString('hex')}`
}

/** Whether a value is one of the two legal `whyYou` values. */
export function isWhyYou(value: unknown): value is WhyYou {
    return typeof value === 'string' && (WHY_YOU_VALUES as readonly string[]).includes(value)
}

/** Parse one untrusted JSONL value into a row; `undefined` when it is not one. */
export function parseAttentionRow(value: unknown): AttentionRow | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const at = raw['at']
    const id = raw['id']
    const kind = raw['kind']
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    if (typeof id !== 'string' || id === '') return undefined
    if (typeof kind !== 'string' || !(ATTENTION_KINDS as readonly string[]).includes(kind)) return undefined
    const rowKind = kind as AttentionKind
    const text = (key: 'questionId' | 'missionId' | 'reason'): string | undefined => {
        const entry = raw[key]
        return typeof entry === 'string' && entry !== '' ? entry : undefined
    }
    const number = (key: 'from' | 'to'): number | undefined => {
        const entry = raw[key]
        return typeof entry === 'number' && Number.isFinite(entry) ? entry : undefined
    }
    const questionId = text('questionId')
    const missionId = text('missionId')
    const reason = text('reason')
    const whyYou = raw['whyYou']
    // A row that identifies neither a question nor a mission can never be used.
    if (questionId === undefined && missionId === undefined) return undefined
    const pause = rowKind === 'pausedFrom' || rowKind === 'pausedTo'
    if (pause && missionId === undefined) return undefined
    if (rowKind === 'pausedFrom' && number('from') === undefined) return undefined
    if (rowKind === 'pausedTo' && (number('from') === undefined || number('to') === undefined)) return undefined
    // A `why` row without one of the two legal values is not a why row.
    if (rowKind === 'why' && !isWhyYou(whyYou)) return undefined
    // A closing row without a reason is not usable: the reason IS the payload.
    if ((rowKind === 'superseded' || rowKind === 'withdrawn') && reason === undefined) return undefined
    return {
        at,
        id,
        kind: rowKind,
        ...(questionId === undefined ? {} : { questionId }),
        ...(missionId === undefined ? {} : { missionId }),
        ...(isWhyYou(whyYou) ? { whyYou } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...(number('from') === undefined ? {} : { from: number('from') }),
        ...(number('to') === undefined ? {} : { to: number('to') }),
    }
}

/** What one sidecar read produced. */
export interface AttentionRead {
    file: string
    present: boolean
    rows: AttentionRow[]
    /** Lines that were not a usable row (a truncated tail line is the normal case). */
    skipped: number
    /** Why, bounded (never the raw line: a reason may quote a payload). */
    problems: string[]
    /** Total non-empty lines seen (including skipped ones). */
    lines: number
}

/** Append one row. Never throws: a failure is returned so the caller can report it. */
export function appendAttentionRow(file: string, row: AttentionRow): { ok: boolean; problem?: string } {
    try {
        ensureDir(path.dirname(file))
        fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
        return { ok: true }
    } catch (error) {
        return { ok: false, problem: `attention 写入失败（${file}）：${error instanceof Error ? error.message : String(error)}` }
    }
}

/**
 * Read the sidecar.
 *
 * A truncated last line (a crash mid-write) is skipped and counted — it is not a
 * corrupt file. A line that parses but is not a row is skipped too.
 * @param file - absolute sidecar path.
 */
export function readAttention(file: string): AttentionRead {
    const text = readText(file)
    if (text === undefined) return { file, present: false, rows: [], skipped: 0, problems: [], lines: 0 }
    const rows: AttentionRow[] = []
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
        const row = parseAttentionRow(parsed)
        if (row === undefined) {
            skipped += 1
            if (problems.length < 5) problems.push(`第 ${index + 1} 行不是合法的 attention 行（缺 at/id/kind，或少了目标/原因），已跳过`)
            continue
        }
        rows.push(row)
    }
    return { file, present: true, rows, skipped, problems, lines }
}

/** One pause interval: `to` absent = the pause is still running. */
export interface PauseInterval {
    missionId?: string
    questionId?: string
    from: number
    to?: number
}

/**
 * Pair the pause rows into intervals.
 *
 * `pausedFrom` opens one, `pausedTo` closes the most recent matching open one.
 * A `pausedTo` with nothing open is reported (never silently dropped): it would
 * otherwise shorten a deadline nobody asked to shorten.
 * @param rows - sidecar rows in file order.
 * @returns the intervals (chronological) and the unpaired closing rows.
 */
export function pauseIntervals(rows: readonly AttentionRow[]): { intervals: PauseInterval[]; unpaired: AttentionRow[] } {
    const intervals: PauseInterval[] = []
    const unpaired: AttentionRow[] = []
    for (const row of rows) {
        if (row.kind === 'pausedFrom') {
            intervals.push({
                ...(row.missionId === undefined ? {} : { missionId: row.missionId }),
                ...(row.questionId === undefined ? {} : { questionId: row.questionId }),
                from: row.from ?? row.at,
            })
            continue
        }
        if (row.kind !== 'pausedTo') continue
        const open = [...intervals]
            .reverse()
            .find(
                (interval) =>
                    interval.to === undefined &&
                    interval.missionId === row.missionId &&
                    interval.questionId === row.questionId,
            )
        if (open === undefined) {
            unpaired.push(row)
            continue
        }
        open.to = Math.max(open.from, row.to ?? row.at)
    }
    intervals.sort((left, right) => left.from - right.from)
    return { intervals, unpaired }
}

/** Whether an interval applies to one question (question-scoped wins over mission-scoped). */
function appliesTo(interval: PauseInterval, target: { missionId?: string; questionId?: string }): boolean {
    if (interval.questionId !== undefined) return target.questionId !== undefined && interval.questionId === target.questionId
    if (interval.missionId !== undefined) return target.missionId !== undefined && interval.missionId === target.missionId
    return false
}

/**
 * Accumulated paused time inside `[from, to)`.
 *
 * Intervals are clipped to the window, so a pause that started before the
 * question was asked only counts from the moment the question existed.
 * @param intervals - {@link pauseIntervals}.
 * @param target - the question (or its mission) and the window.
 */
export function pausedMsWithin(
    intervals: readonly PauseInterval[],
    target: { missionId?: string; questionId?: string; from: number; to: number },
): number {
    let total = 0
    for (const interval of intervals) {
        if (!appliesTo(interval, target)) continue
        const start = Math.max(target.from, interval.from)
        const end = Math.min(target.to, interval.to ?? target.to)
        if (end > start) total += end - start
    }
    return total
}

/** The pause interval still running at `at`, when one is. */
export function openPauseAt(
    intervals: readonly PauseInterval[],
    target: { missionId?: string; questionId?: string; at: number },
): PauseInterval | undefined {
    for (const interval of [...intervals].reverse()) {
        if (interval.to !== undefined) continue
        if (interval.from > target.at) continue
        if (!appliesTo(interval, target)) continue
        return interval
    }
    return undefined
}

/** The recorded `whyYou` of one question, with where it came from. */
export function whyYouOf(rows: readonly AttentionRow[], questionId: string): { whyYou: WhyYou; source: 'recorded' | 'default' } {
    let recorded: WhyYou | undefined
    for (const row of rows) {
        if (row.kind !== 'why' || row.questionId !== questionId) continue
        if (row.whyYou !== undefined) recorded = row.whyYou
    }
    return recorded === undefined ? { whyYou: DEFAULT_WHY_YOU, source: 'default' } : { whyYou: recorded, source: 'recorded' }
}

/** One recorded closure: the question stopped being a question. */
export interface AttentionClosure {
    kind: 'superseded' | 'withdrawn'
    at: number
    reason: string
    /** Set when the closure came from the mission (one row closes every question of it). */
    missionId?: string
}

/**
 * The recorded closure of one question, when one exists.
 *
 * A `superseded` row may name the mission instead of the question: one mission
 * that ended makes every one of its questions moot, and recording that once is
 * the whole point. A `withdrawn` row always names the question (the asker gave
 * up on THAT answer).
 * @param rows - sidecar rows in file order.
 * @param target - the question and the mission behind it.
 */
export function closureOf(
    rows: readonly AttentionRow[],
    target: { questionId: string; missionId?: string; askedAt: number },
): AttentionClosure | undefined {
    let found: AttentionClosure | undefined
    for (const row of rows) {
        if (row.kind !== 'superseded' && row.kind !== 'withdrawn') continue
        const matchesQuestion = row.questionId !== undefined && row.questionId === target.questionId
        const matchesMission =
            row.kind === 'superseded' && row.questionId === undefined && row.missionId !== undefined && row.missionId === target.missionId
        if (!matchesQuestion && !matchesMission) continue
        found = {
            kind: row.kind,
            at: row.at,
            reason: row.reason ?? '(未记录原因)',
            ...(row.missionId === undefined ? {} : { missionId: row.missionId }),
        }
    }
    return found
}

/** What this process knows about the mission behind a question. */
export interface AttentionMission {
    id: string
    /** The mission's status (`draft` … `blocked` … `delivered`). */
    status: string
    /** Terminal: delivered, or stopped (its mandate was withdrawn, which is a person's stop). */
    ended: boolean
    /** Blocked/paused right now: the deadline does not run. */
    paused: boolean
    /** The mandate's policy version at approval time (absent when nothing was recorded). */
    policyVersion?: string
    /** The workspace trust root's version right now. */
    currentPolicyVersion?: string
    /** Why it ended, in the sentence a superseded row records. */
    endedReason?: string
    /**
     * HOW it ended. The two terminal shapes are not equivalent for approvals:
     * a DELIVERED mission still legitimately needs decisions (deploy/verify/
     * rollback approvals exist only after delivery), while a mission whose
     * mandate a person WITHDREW must void every pending question — including
     * approvals, because the work itself was stopped.
     */
    endedBy?: 'delivered' | 'withdrawn'
}

/**
 * Compute the stale mark of one attention.
 *
 * Exactly three reasons, in this order of precedence: the mission ended, the
 * mandate was approved against a different policy version, or the question is
 * older than the bound. A stale attention is still LISTED (labelled, never
 * hidden): hiding it would make the suite look calm while a person is not being
 * told something they were asked.
 * @param input - the question, the clock and the mission facts.
 */
export function staleOf(input: {
    askedAt: number
    ageMs: number
    maxAgeMs: number
    mission?: AttentionMission | undefined
    /** `LedgerRow.source` of the question (see {@link AttentionRecord.source}). */
    source?: string | undefined
}): StaleMark | undefined {
    const mission = input.mission
    // A DELIVERED mission does not void an approval: deployment go/no-go requires
    // the mission to be delivered, so its verify/rollback approval necessarily
    // lives AFTER that point. Voiding it there is a contradiction, not a policy
    // (the card is superseded the instant it is sent). A WITHDRAWN mandate is a
    // person stopping the work, so it still voids everything.
    const approvalSurvivesDelivery = input.source === 'approval-request' && mission?.endedBy !== 'withdrawn'
    if (mission !== undefined && mission.ended && !approvalSurvivesDelivery) {
        return {
            reason: 'mission-ended',
            detail: mission.endedReason ?? `mission ${mission.id} 已结束（状态 ${mission.status}）：这道提问已不再有意义`,
        }
    }
    if (
        mission !== undefined &&
        mission.policyVersion !== undefined &&
        mission.policyVersion !== '' &&
        mission.currentPolicyVersion !== undefined &&
        mission.currentPolicyVersion !== '' &&
        mission.policyVersion !== mission.currentPolicyVersion
    ) {
        return {
            reason: 'policy-version',
            detail:
                `mission ${mission.id} 的授权是针对策略版本 ${shortDigest(mission.policyVersion)} 作出的，` +
                `而当前信任根是 ${shortDigest(mission.currentPolicyVersion)}：规则集变了，这道提问的授权基础也变了`,
        }
    }
    if (input.ageMs > input.maxAgeMs) {
        return {
            reason: 'too-old',
            detail: `这道提问已经等了 ${hours(input.ageMs)} 小时，超过上限 ${hours(input.maxAgeMs)} 小时：先确认还要不要这个答案`,
        }
    }
    return undefined
}

function shortDigest(value: string): string {
    return value.length <= 12 ? value : `${value.slice(0, 12)}…`
}

function hours(ms: number): string {
    const value = Math.max(0, ms) / 3_600_000
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

/** One question's derived state: an attention when `state === 'open'`. */
export interface AttentionRecord {
    questionId: string
    missionId?: string
    title: string
    /** Epoch ms the card was sent (the ledger `ask` row). */
    askedAt: number
    ageMs: number
    channel?: string
    /** The wait window this question was allowed (`windowMs` on the row, else the config ceiling). */
    windowMs: number
    /**
     * Who asked (`LedgerRow.source`). `'approval-request'` = the host's approval
     * seam, i.e. a gate asking a person to authorise an action; absent = the
     * model's own question (`interaction_ask`). The distinction decides whether a
     * delivered mission ends the question (see {@link staleOf}).
     */
    source?: string
    state: AttentionState
    /** The ledger decision row that ended it (a real decision, or a `refused:<reason>`). */
    decision?: string
    /** The stored transition that closed it (`superseded` / `withdrawn`). */
    closure?: AttentionClosure
    whyYou: WhyYou
    whyYouSource: 'recorded' | 'default'
    /** Paused time inside `[askedAt, now]`. */
    pausedMs: number
    /** `askedAt + windowMs + pausedMs` — pauses MOVE the deadline, they never burn it. */
    deadlineAt: number
    /** The pause still running right now, when one is. */
    paused?: { from: number; ms: number }
    /** Present when the attention is stale; it is still listed. */
    stale?: StaleMark
}

/** An attention: a question that is still waiting for a person. */
export type Attention = AttentionRecord & { state: 'open' }

/** Everything the derivation reads: the two files, the clock and the mission lookup. */
export interface AttentionInput {
    ledgerRows: readonly LedgerRow[]
    attentionRows: readonly AttentionRow[]
    now: number
    /** Upper bound on how old a question may get before it is stale. */
    maxAgeMs: number
    /** Used when the ledger row carries no `windowMs` (rows written before it existed). */
    defaultWindowMs: number
    /** The mission behind a question, when this process can read it. */
    mission?: (missionId: string) => AttentionMission | undefined
}

/**
 * Derive every question the ledger knows, with its state and labels.
 *
 * "An attention" is exactly: a ledger `ask` row whose token has no decision row.
 * The ledger stays the only record of answers; this function reads it and adds
 * only what the sidecar recorded (why / closure / pause).
 * @param input - ledger rows, sidecar rows, clock, bounds and the mission lookup.
 * @returns one record per question, oldest first.
 */
export function deriveRecords(input: AttentionInput): AttentionRecord[] {
    /** token → the row that first asked it (the pending one) */
    const pending = new Map<string, LedgerRow>()
    /** token → the row that decided it (last wins) */
    const decided = new Map<string, LedgerRow>()
    for (const row of input.ledgerRows) {
        if (row.kind !== 'ask') continue
        const token = row.questionId
        if (token === undefined) continue
        if (row.decision === undefined) {
            if (!pending.has(token)) pending.set(token, row)
            continue
        }
        decided.set(token, row)
    }

    const { intervals } = pauseIntervals(input.attentionRows)
    const missionCache = new Map<string, AttentionMission | undefined>()
    const missionOf = (missionId: string | undefined): AttentionMission | undefined => {
        if (missionId === undefined) return undefined
        if (missionCache.has(missionId)) return missionCache.get(missionId)
        let facts: AttentionMission | undefined
        try {
            facts = input.mission?.(missionId)
        } catch {
            facts = undefined
        }
        missionCache.set(missionId, facts)
        return facts
    }

    const out: AttentionRecord[] = []
    const tokens = new Set<string>([...pending.keys(), ...decided.keys()])
    for (const token of tokens) {
        const asked = pending.get(token) ?? decided.get(token)
        if (asked === undefined) continue
        const answer = decided.get(token)
        const askedAt = asked.at
        const windowMs =
            typeof asked.windowMs === 'number' && Number.isFinite(asked.windowMs) && asked.windowMs >= 0
                ? asked.windowMs
                : input.defaultWindowMs
        const missionId = asked.missionId
        const closure = closureOf(input.attentionRows, { questionId: token, ...(missionId === undefined ? {} : { missionId }), askedAt })
        // A real decision wins (an answered question is never superseded); a
        // refusal does NOT win over a recorded transition, and it is not an
        // answer in the first place.
        const state: AttentionState =
            answer !== undefined && !isRefusal(answer.decision)
                ? 'answered'
                : closure !== undefined
                  ? closure.kind
                  : answer !== undefined
                    ? 'refused'
                    : 'open'
        const why = whyYouOf(input.attentionRows, token)
        const pausedMs = state !== 'open' ? 0 : pausedMsWithin(intervals, { ...(missionId === undefined ? {} : { missionId }), questionId: token, from: askedAt, to: input.now })
        const openPause = state !== 'open' ? undefined : openPauseAt(intervals, { ...(missionId === undefined ? {} : { missionId }), questionId: token, at: input.now })
        const ageMs = Math.max(0, input.now - askedAt)
        const facts = missionOf(missionId)
        const askedSource = typeof asked.source === 'string' && asked.source !== '' ? asked.source : undefined
        const stale =
            state === 'open'
                ? staleOf({
                      askedAt,
                      ageMs,
                      maxAgeMs: input.maxAgeMs,
                      mission: facts,
                      ...(askedSource === undefined ? {} : { source: askedSource }),
                  })
                : undefined
        out.push({
            questionId: token,
            ...(missionId === undefined ? {} : { missionId }),
            title: asked.title,
            askedAt,
            ageMs,
            ...(asked.channel === undefined ? {} : { channel: asked.channel }),
            windowMs,
            ...(askedSource === undefined ? {} : { source: askedSource }),
            state,
            ...(answer?.decision === undefined ? {} : { decision: answer.decision }),
            ...(closure === undefined ? {} : { closure }),
            whyYou: why.whyYou,
            whyYouSource: why.source,
            pausedMs,
            deadlineAt: askedAt + windowMs + pausedMs,
            ...(openPause === undefined ? {} : { paused: { from: openPause.from, ms: Math.max(0, input.now - openPause.from) } }),
            ...(stale === undefined ? {} : { stale }),
        })
    }
    out.sort((left, right) => left.askedAt - right.askedAt || left.questionId.localeCompare(right.questionId))
    return out
}

/** Keep only the open records (the attentions), oldest first. */
export function derivationsToAttentions(records: readonly AttentionRecord[]): Attention[] {
    return records.filter((record): record is Attention => record.state === 'open')
}

/**
 * Read one mission's facts for the attention derivation.
 *
 * `ended` is the two terminal shapes this suite has: a delivered mission, and a
 * mission a person STOPPED (a blocked mission whose mandate was withdrawn). A
 * plain `blocked` mission is the circuit breaker — paused, not ended, so its
 * questions keep waiting (their deadlines just stop running).
 * @param store - the mission store of one workspace.
 * @param missionId - the mission id.
 * @returns the facts, or `undefined` when this process cannot read that mission.
 */
export function missionFactsOf(store: MissionStore, missionId: string): AttentionMission | undefined {
    const record = store.read(missionId)
    if (record === undefined) return undefined
    const mandate = mandateState(record)
    const withdrawn = mandate.kind === 'present' || mandate.kind === 'legacy' ? mandate.mandate.withdrawn : undefined
    // "Ended" is exactly the two terminal shapes this suite has: a delivered
    // mission, and a mission whose MANDATE was withdrawn (a person's stop — the
    // status is `blocked` too, but the withdrawal is what makes it final).
    // A plain `blocked` mission is the circuit breaker: paused, not ended.
    const ended = record.status === 'delivered' || withdrawn !== undefined
    let current: string | undefined
    try {
        current = policyVersion(store.layout.cwd, { rootDir: store.layout.rootDir })
    } catch {
        current = undefined
    }
    return {
        id: record.id,
        status: record.status,
        ended,
        paused: record.status === 'blocked' && !ended,
        ...(mandate.kind === 'present' ? { policyVersion: mandate.mandate.policyVersion } : {}),
        ...(current === undefined ? {} : { currentPolicyVersion: current }),
        ...(ended ? { endedBy: withdrawn !== undefined ? ('withdrawn' as const) : ('delivered' as const) } : {}),
        ...(ended
            ? {
                  endedReason:
                      withdrawn !== undefined
                          ? `mission ${record.id} 的授权已由 ${withdrawn.by} 于 ${formatTime(withdrawn.at)} 撤回（${withdrawn.reason}）：这道提问已不再有意义`
                          : `mission ${record.id} 已交付（delivered）：这道提问已不再有意义`,
              }
            : {}),
    }
}

/** What one pause/supersede sweep changed. */
export interface AttentionSync {
    superseded: number
    paused: number
    resumed: number
}

/** How many defect lines one class contributes (a bounded problem list). */
const MAX_PROBLEMS = 12

/** Options of {@link createAttentionSource}. */
export interface AttentionSourceOptions {
    /** Absolute sidecar path. */
    file: string
    /** Absolute ledger path of the same workspace (the questions live there). */
    ledgerFile: string
    /** Injected clock (no `Date.now()` here). */
    now: () => number
    /** The wait window used when a ledger row does not carry one. */
    defaultWindowMs: number
    /** How old a question may get before it is stale. */
    maxAgeMs: number
    /** The mission behind a question, when this process can read it. */
    mission?: (missionId: string) => AttentionMission | undefined
    /** Sink for sidecar defects (the registry's bounded `problems()` list). */
    note?: (message: string) => void
}

/** The sidecar handle one workspace (one file) gets. */
export interface AttentionSource {
    readonly file: string
    readonly ledgerFile: string
    /** The open attentions, oldest first. Derived; writes nothing. */
    attentions(): Attention[]
    /** Every question the ledger knows with its state (open / answered / superseded / withdrawn). */
    records(): AttentionRecord[]
    /** The state of one question (`undefined` = this ledger never asked it). */
    stateOf(questionId: string): AttentionState | undefined
    /** Consecutive Chinese lines for one question (why / state / deadline), for a report. */
    linesFor(questionId: string): string[]
    /** Record WHY a person is being asked (once per question). */
    recordWhy(questionId: string, whyYou: WhyYou): boolean
    /** Supersede one question, or every question of one mission. Returns how many it closed. */
    supersede(input: { missionId?: string; questionId?: string; reason: string; endedBy?: 'delivered' | 'withdrawn' }): number
    /** Record that the asker no longer needs the answer. Never an answer, never an approval. */
    withdraw(questionId: string, reason: string): boolean
    /** Open a pause interval for a mission. */
    pauseMission(missionId: string, reason?: string): boolean
    /** Close the open pause interval of a mission. */
    resumeMission(missionId: string): boolean
    /** Accumulated paused ms of a mission/question inside `[from, to)`. */
    pausedMsFor(target: { missionId?: string; questionId?: string; from: number; to: number }): number
    /** Whether a pause is running for a mission/question at `at`. */
    pausedNow(target: { missionId?: string; questionId?: string; at: number }): boolean
    /** Sample the mission store for ONE mission and record what it shows. */
    syncMission(missionId: string): AttentionSync
    /** Sample every mission that has an open question or an open pause. */
    sweep(): AttentionSync
    /** Sidecar defects (bounded), read from the file. */
    problems(): string[]
}

/** Bound a free-text reason for a report line. */
function bounded(text: string, maxChars: number): string {
    const trimmed = text.trim()
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Create the attention sidecar handle for one workspace.
 *
 * The files are the truth: every read re-parses them, so two handles over the
 * same workspace (or a reader after another writer) can never disagree. Nothing
 * is cached in memory — the only writable state is the append-only file.
 * @param options - paths, clock, bounds, mission lookup and a defect sink.
 */
export function createAttentionSource(options: AttentionSourceOptions): AttentionSource {
    const problems: string[] = []
    const note = (message: string): void => {
        problems.push(message)
        if (problems.length > MAX_PROBLEMS) problems.shift()
        options.note?.(message)
    }

    const read = (): AttentionRead => readAttention(options.file)

    const append = (row: AttentionRow): boolean => {
        const appended = appendAttentionRow(options.file, row)
        if (!appended.ok && appended.problem !== undefined) note(appended.problem)
        return appended.ok
    }

    const derive = (): AttentionRecord[] => {
        const read2 = read()
        if (read2.skipped > 0) {
            for (const problem of read2.problems.slice(0, 1)) note(`${options.file}：${problem}`)
        }
        const { unpaired } = pauseIntervals(read2.rows)
        if (unpaired.length > 0) {
            note(
                `attention：${unpaired.length} 条 pausedTo 行找不到对应的 pausedFrom（${unpaired[0]?.id ?? '?'}）：` +
                    '忽略它们（否则会凭空缩短某个提问的期限），下一次暂停会重新记一条 pausedFrom',
            )
        }
        return deriveRecords({
            ledgerRows: readLedger(options.ledgerFile).rows,
            attentionRows: read2.rows,
            now: options.now(),
            maxAgeMs: options.maxAgeMs,
            defaultWindowMs: options.defaultWindowMs,
            ...(options.mission === undefined ? {} : { mission: options.mission }),
        })
    }

    const source: AttentionSource = {
        file: options.file,
        ledgerFile: options.ledgerFile,

        attentions() {
            return derivationsToAttentions(derive())
        },

        records() {
            return derive()
        },

        stateOf(questionId) {
            return derive().find((record) => record.questionId === questionId)?.state
        },

        linesFor(questionId) {
            const record = derive().find((entry) => entry.questionId === questionId)
            if (record === undefined) return []
            const lines = [
                `- 注意力：${record.questionId}（${record.state}，whyYou=${record.whyYou}` +
                    `${record.whyYouSource === 'recorded' ? '' : '（默认：没有记录为什么）'}）`,
            ]
            if (record.state === 'open') {
                lines.push(
                    `  等待 ${Math.round(record.ageMs / 1000)}s，截止 ${formatTime(record.deadlineAt)}` +
                        `${record.pausedMs === 0 ? '' : `（其中暂停 ${Math.round(record.pausedMs / 1000)}s 不计入）`}` +
                        `${record.stale === undefined ? '' : `；⚠️ stale(${record.stale.reason})：${bounded(record.stale.detail, 140)}`}`,
                )
            }
            if (record.closure !== undefined) {
                lines.push(`  已${record.closure.kind === 'superseded' ? '作废（superseded）' : '撤回（withdrawn）'}：${bounded(record.closure.reason, 160)}`)
            }
            return lines
        },

        recordWhy(questionId, whyYou) {
            if (!isWhyYou(whyYou)) {
                note(`attention：拒绝记录非法的 whyYou=${JSON.stringify(whyYou)}（只有 ${WHY_YOU_VALUES.join(' / ')} 两个值）`)
                return false
            }
            const rows = read().rows
            if (rows.some((row) => row.kind === 'why' && row.questionId === questionId)) return false
            return append({ at: options.now(), id: newAttentionRowId(), kind: 'why', questionId, whyYou })
        },

        supersede(input) {
            const at = options.now()
            const rows = read().rows
            const records = source.records()
            if (input.questionId !== undefined) {
                const record = records.find((entry) => entry.questionId === input.questionId)
                if (record === undefined || record.state !== 'open') return 0
                if (rows.some((row) => row.kind === 'superseded' && row.questionId === input.questionId)) return 0
                append({
                    at,
                    id: newAttentionRowId(),
                    kind: 'superseded',
                    questionId: input.questionId,
                    ...(record.missionId === undefined ? {} : { missionId: record.missionId }),
                    reason: input.reason,
                })
                return 1
            }
            if (input.missionId === undefined) return 0
            // A DELIVERED mission still needs its approvals decided: deployment
            // requires delivery first, so "delivered ⇒ every question is moot"
            // makes the verify/rollback approval impossible (it is superseded the
            // moment the card leaves). Withdrawn mandates keep voiding everything.
            const survivors =
                input.endedBy === 'withdrawn'
                    ? records.filter((entry) => entry.state === 'open' && entry.missionId === input.missionId)
                    : records.filter((entry) => entry.state === 'open' && entry.missionId === input.missionId && entry.source !== 'approval-request')
            const open = survivors
            if (open.length === 0) {
                // Nothing to close under the exemption, but the mission DID end:
                // do not record a mission-wide row that would close approvals by
                // accident later (the row is deliberately not written).
                return 0
            }
            // Recorded ONCE per mission: one row closes every question of it, and
            // a second sweep must not add a second row.
            if (rows.some((row) => row.kind === 'superseded' && row.questionId === undefined && row.missionId === input.missionId)) return 0
            append({ at, id: newAttentionRowId(), kind: 'superseded', missionId: input.missionId, reason: input.reason })
            return open.length
        },

        withdraw(questionId, reason) {
            const record = source.records().find((entry) => entry.questionId === questionId)
            if (record === undefined || record.state !== 'open') return false
            return append({ at: options.now(), id: newAttentionRowId(), kind: 'withdrawn', questionId, reason })
        },

        pauseMission(missionId, reason) {
            const at = options.now()
            if (source.pausedNow({ missionId, at })) return false
            return append({
                at,
                id: newAttentionRowId(),
                kind: 'pausedFrom',
                missionId,
                from: at,
                ...(reason === undefined ? {} : { reason }),
            })
        },

        resumeMission(missionId) {
            const at = options.now()
            const open = [...pauseIntervals(read().rows).intervals]
                .reverse()
                .find((interval) => interval.to === undefined && interval.missionId === missionId && interval.questionId === undefined)
            if (open === undefined) return false
            return append({ at, id: newAttentionRowId(), kind: 'pausedTo', missionId, from: open.from, to: Math.max(open.from, at) })
        },

        pausedMsFor(target) {
            return pausedMsWithin(pauseIntervals(read().rows).intervals, target)
        },

        pausedNow(target) {
            return openPauseAt(pauseIntervals(read().rows).intervals, target) !== undefined
        },

        syncMission(missionId) {
            const out: AttentionSync = { superseded: 0, paused: 0, resumed: 0 }
            let facts: AttentionMission | undefined
            try {
                facts = options.mission?.(missionId)
            } catch (error) {
                note(`attention：读取 mission ${missionId} 的状态失败：${error instanceof Error ? error.message : String(error)}（不推断暂停状态）`)
                return out
            }
            if (facts === undefined) return out
            if (facts.ended) {
                out.superseded = source.supersede({
                    missionId,
                    endedBy: facts.endedBy,
                    reason: facts.endedReason ?? `mission ${missionId} 已结束：这道提问已不再有意义`,
                })
                return out
            }
            if (facts.paused) {
                if (source.pauseMission(missionId, `mission ${missionId} 处于 blocked：暂停期间提问的期限不流逝`)) out.paused = 1
                return out
            }
            if (source.resumeMission(missionId)) out.resumed = 1
            return out
        },

        sweep() {
            const out: AttentionSync = { superseded: 0, paused: 0, resumed: 0 }
            const { intervals } = pauseIntervals(read().rows)
            const missions = new Set<string>()
            for (const record of source.attentions()) if (record.missionId !== undefined) missions.add(record.missionId)
            // An interval left open after its last question was answered would
            // extend every FUTURE question of that mission for ever, so the sweep
            // closes them too — a pause must end when the mission is not paused.
            for (const interval of intervals) {
                if (interval.to === undefined && interval.missionId !== undefined && interval.questionId === undefined) missions.add(interval.missionId)
            }
            for (const missionId of missions) {
                const synced = source.syncMission(missionId)
                out.superseded += synced.superseded
                out.paused += synced.paused
                out.resumed += synced.resumed
            }
            return out
        },

        problems() {
            const out = [...problems]
            const read2 = read()
            for (const problem of read2.problems) out.push(`${options.file}：${problem}`)
            return out.slice(-MAX_PROBLEMS)
        },
    }
    return source
}

/**
 * The delegation ledger: which child session worked on which mission, as which
 * role, in which stage (docs.md §4.3).
 *
 * A stage's `role` used to be a **declaration**: the orchestrator recorded it,
 * the prompt advertised it, and nothing checked it. The missing fact was
 * "which session is the developer for THIS stage" — the role-guard binding
 * (`state/roles/<session>.json`) answers what role a child holds, but not
 * whether the main session delegated the stage's work at all. This ledger is
 * that second fact:
 *
 * - `dsh-role-guard` appends one row **after** `team_delegate` started a child
 *   successfully, and after its service `bind()` recorded an auto-dispatched
 *   child — the two delegation paths share this single writer (a failed append
 *   warns, it never blocks the delegation);
 * - `dsh-spec-gate`'s write guard reads it to answer "is the caller the child
 *   this stage was delegated to?" (a read is never gated);
 * - `dsh-orchestrator`'s `advance` reads it to refuse leaving a role-declaring
 *   stage that no child was ever delegated for.
 *
 * The file lives at `<layout>/state/delegations.jsonl` — runtime state, not
 * policy: it is append-only, never read as an authorisation for anything else,
 * and a truncated tail line is skipped rather than repaired (the next append
 * starts on a fresh line, see `appendJsonl`).
 *
 * De-duplication (`appendDelegationOnce`) is **atomic across processes**: the
 * read that decides "already recorded?" happens inside a `<ledger>.lock`
 * directory held via `mkdir` (see `file-lock.ts`). A lock that cannot be taken
 * degrades to an unlocked append and says so, because a duplicate row means the
 * same thing to every reader while a missing row is a delegation the role gates
 * cannot see.
 *
 * @module dsh-eng-core/delegations
 */

import path from 'node:path'
import { acquireDirLock, releaseDirLock, type DirLockLogger } from './file-lock.js'
import { appendJsonl, readJsonl } from './io.js'
import { resolveLayout, type LayoutOptions } from './paths.js'
import type { MissionRecord, StageResult } from './types.js'

/** File name under `<layout>/state/`. */
export const DELEGATION_LEDGER = 'delegations.jsonl'

/** One recorded delegation (append-only; later rows never rewrite it). */
export interface DelegationRecord {
    missionId: string
    /** Role id the child was started as (`developer`, `qa`, …). */
    role: string
    /** The child session id (`team_delegate`'s `run.id`). */
    childSessionId: string
    /** The stage the mission was in when the child started, when it had one. */
    stage?: string
    /** When the child started (epoch ms). */
    at: number
}

/** What a caller supplies; `at` defaults to "now". */
export interface DelegationInput {
    missionId: string
    role: string
    childSessionId: string
    stage?: string
    at?: number
}

/** Which recorded delegation satisfies a stage's role requirement. */
export interface DelegationQuery {
    stage: string
    role: string
    /** When set, only the delegation of THIS child session matches. */
    childSessionId?: string
}

/**
 * The stage-record lookup {@link stageRoleOf} reads.
 *
 * A `MissionStore` satisfies it structurally. It is passed in (instead of the
 * function building its own store from `mission.cwd`) so the caller's layout
 * overrides — the same ones that resolved the mission — decide where the
 * `stages/<id>.json` artifact is read from.
 */
export interface StageRoleLookup {
    readStageResult(missionId: string, stageId: string): StageResult | undefined
}

/** Absolute path of the delegation ledger for one workspace. */
export function delegationLedgerFile(cwd: string, options: LayoutOptions = {}): string {
    return path.join(resolveLayout(cwd, options).stateDir, DELEGATION_LEDGER)
}

/**
 * Absolute path of the directory lock guarding that ledger (`<ledger>.lock`).
 *
 * One path, one owner: the lock sits next to the file it protects so a moved
 * layout cannot leave writers locking one directory while appending to another.
 */
export function delegationLockDir(cwd: string, options: LayoutOptions = {}): string {
    return `${delegationLedgerFile(cwd, options)}.lock`
}

/**
 * Append one delegation row (single line, one `appendFileSync`).
 *
 * "Always append" is the whole contract — no de-duplication, no lock. The write
 * itself is still one line with the missing-newline repair handled by
 * `appendJsonl`, so a row can never be glued onto a crash-truncated tail; callers
 * that want "at most one row per delegation" use {@link appendDelegationOnce}.
 *
 * Letting the error escape is deliberate: the caller decides whether an
 * unwritten record blocks it. `team_delegate` reports it as a warning and lets
 * the child work — an unwritable ledger must not fail a delegation that the
 * host already authorised.
 * @param cwd - workspace root.
 * @param input - who was delegated, as what, for which stage.
 * @param options - layout overrides (the plugin's `layout` config).
 * @returns the file the row was written to.
 */
export function appendDelegation(cwd: string, input: DelegationInput, options: LayoutOptions = {}): string {
    const file = delegationLedgerFile(cwd, options)
    appendDelegationRow(file, input)
    return file
}

/** The single write both append paths share: one row, one JSONL line. */
function appendDelegationRow(file: string, input: DelegationInput): void {
    appendJsonl(file, {
        missionId: input.missionId,
        role: input.role,
        childSessionId: input.childSessionId,
        ...(input.stage === undefined || input.stage === '' ? {} : { stage: input.stage }),
        at: input.at ?? Date.now(),
    })
}

/**
 * What {@link appendDelegationOnce} did: where the row belongs, and whether one
 * was written (as opposed to already being there).
 */
export interface AppendDelegationResult {
    /** The ledger file the row belongs to. */
    file: string
    /** `false` when an identical delegation was already recorded (nothing written). */
    appended: boolean
    /**
     * `false` only when the row was appended **without** the lock (`appended` is
     * then `true`): an identical delegation may already have a row. Absent on a
     * normal append and on a de-duplicated call, so existing callers see the same
     * shape they always did.
     */
    deduped?: false
    /** Present exactly when `deduped` is `false`: why de-duplication was skipped. */
    warning?: string
}

/**
 * Append one delegation row unless the same delegation is already recorded —
 * atomically, across processes.
 *
 * Two writers reach this ledger — `team_delegate` (the model-facing path) and
 * the role-guard service's `bind` (an autonomous dispatcher such as
 * `autoDispatch`) — and a retried call must not add noise: the key is the exact
 * tuple every reader matches on (`missionId + stage + role + childSessionId`).
 * `at` is deliberately NOT part of the key: it says when a row was written, not
 * which delegation it describes.
 *
 * The critical section is "read the ledger, decide, append" and it runs while
 * holding `<ledger>.lock` (a `mkdir` directory, see `file-lock.ts`). The read is
 * **inside** the lock on purpose: a read taken before acquiring it describes a
 * ledger another process may append to before this one does.
 *
 * When the lock cannot be taken (a live holder past the wait budget, or a stale
 * lock directory that cannot be removed), this **degrades to an unlocked
 * append** and returns `{ appended: true, deduped: false, warning }` (also
 * logged): a duplicate row means the same delegation to every reader, while
 * dropping the row would hide the delegation from the role gates. The lock is
 * released in a `finally`, so a throwing append cannot leave it behind.
 * @param cwd - workspace root.
 * @param input - who was delegated, as what, for which stage.
 * @param options - layout overrides (the plugin's `layout` config).
 * @param logger - optional logger for the degraded/lock warnings.
 * @returns the file, whether a row was appended, and — when de-duplication had
 *   to be skipped — `deduped: false` plus the warning text.
 */
export function appendDelegationOnce(
    cwd: string,
    input: DelegationInput,
    options: LayoutOptions = {},
    logger?: DirLockLogger,
): AppendDelegationResult {
    const stage = input.stage === undefined || input.stage === '' ? undefined : input.stage
    const file = delegationLedgerFile(cwd, options)
    const lockDir = delegationLockDir(cwd, options)
    const lock = acquireDirLock(lockDir, logger)
    if (!lock.acquired) {
        const warning = `未能获取委派台账锁（${lock.reason ?? lockDir}）。已降级为不加锁追加：并发写入同一元组时可能留下重复行（读者仍把它当成同一次委派）；不降级就会丢记录。`
        logger?.warn(warning)
        appendDelegationRow(file, input)
        return { file, appended: true, deduped: false, warning }
    }
    try {
        // Inside the lock — see the note above; this read is the whole point.
        const existing = readDelegations(cwd, input.missionId, options).some(
            (record) => record.role === input.role && record.childSessionId === input.childSessionId && record.stage === stage,
        )
        if (existing) return { file, appended: false }
        appendDelegationRow(file, input)
        return { file, appended: true }
    } finally {
        releaseDirLock(lockDir, logger)
    }
}

/**
 * Read one mission's delegation rows, preserving append order.
 *
 * A malformed line (a crash-truncated tail) is skipped by `readJsonl`; a row
 * whose shape is wrong is dropped here rather than trusted. A ledger that does
 * not exist reads as "no delegations" — the caller decides what that means.
 * @param cwd - workspace root.
 * @param missionId - only rows of this mission are returned.
 * @param options - layout overrides.
 */
export function readDelegations(cwd: string, missionId: string, options: LayoutOptions = {}): DelegationRecord[] {
    const rows: DelegationRecord[] = []
    for (const value of readJsonl<unknown>(delegationLedgerFile(cwd, options))) {
        const row = asDelegationRecord(value)
        if (row !== undefined && row.missionId === missionId) rows.push(row)
    }
    return rows
}

/** Whether one of these rows satisfies the query (first match). */
export function matchesDelegation(records: readonly DelegationRecord[], query: DelegationQuery): DelegationRecord | undefined {
    return records.find(
        (record) =>
            record.stage === query.stage &&
            record.role === query.role &&
            (query.childSessionId === undefined || record.childSessionId === query.childSessionId),
    )
}

/**
 * The role the mission's **current** stage declares, when it declares one.
 *
 * The role lives in the persisted stage artifact (`stages/<id>.json`), not in
 * `mission.json`: that is what makes "which role did this mission run this
 * stage as" answerable after a reload. A missing/unreadable artifact reads as
 * "no role" — the caller must not turn a storage accident into an enforcement
 * decision by inventing one.
 * @param mission - the mission record (its `stage` names the artifact).
 * @param lookup - stage-record reader (a `MissionStore`).
 */
export function stageRoleOf(mission: MissionRecord | undefined, lookup: StageRoleLookup): string | undefined {
    if (mission === undefined || mission.stage === undefined || mission.stage === '') return undefined
    let result: StageResult | undefined
    try {
        result = lookup.readStageResult(mission.id, mission.stage)
    } catch {
        return undefined
    }
    return typeof result?.role === 'string' && result.role !== '' ? result.role : undefined
}

/** Validate one parsed JSONL row; `undefined` when it is not a delegation. */
function asDelegationRecord(value: unknown): DelegationRecord | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const row = value as Record<string, unknown>
    if (typeof row['missionId'] !== 'string' || typeof row['role'] !== 'string' || typeof row['childSessionId'] !== 'string') return undefined
    const at = row['at']
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    return {
        missionId: row['missionId'],
        role: row['role'],
        childSessionId: row['childSessionId'],
        ...(typeof row['stage'] === 'string' && row['stage'] !== '' ? { stage: row['stage'] } : {}),
        at,
    }
}

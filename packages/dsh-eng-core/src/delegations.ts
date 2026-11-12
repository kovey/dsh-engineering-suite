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
 * @module dsh-eng-core/delegations
 */

import path from 'node:path'
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
 * Append one delegation row (single line, atomic-ish append).
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
    appendJsonl(file, {
        missionId: input.missionId,
        role: input.role,
        childSessionId: input.childSessionId,
        ...(input.stage === undefined || input.stage === '' ? {} : { stage: input.stage }),
        at: input.at ?? Date.now(),
    })
    return file
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
}

/**
 * Append one delegation row unless the same delegation is already recorded.
 *
 * Two writers reach this ledger — `team_delegate` (the model-facing path) and
 * the role-guard service's `bind` (an autonomous dispatcher such as
 * `autoDispatch`) — and a retried call must not add noise: the key is the exact
 * tuple every reader matches on (`missionId + stage + role + childSessionId`).
 * `at` is deliberately NOT part of the key: it says when a row was written, not
 * which delegation it describes.
 *
 * The read-then-append is not atomic. One process owns the ledger in practice,
 * and two identical rows would still mean the same thing to every reader, so a
 * rare race degrades to a duplicate line rather than a wrong decision.
 * @param cwd - workspace root.
 * @param input - who was delegated, as what, for which stage.
 * @param options - layout overrides (the plugin's `layout` config).
 * @returns the file and whether a row was appended.
 */
export function appendDelegationOnce(cwd: string, input: DelegationInput, options: LayoutOptions = {}): AppendDelegationResult {
    const stage = input.stage === undefined || input.stage === '' ? undefined : input.stage
    const file = delegationLedgerFile(cwd, options)
    const existing = readDelegations(cwd, input.missionId, options).some(
        (record) => record.role === input.role && record.childSessionId === input.childSessionId && record.stage === stage,
    )
    if (existing) return { file, appended: false }
    appendDelegation(cwd, input, options)
    return { file, appended: true }
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

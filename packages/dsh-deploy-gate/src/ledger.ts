/**
 * The deployment ledger: append-only JSONL, one row per action taken.
 *
 * Deployment is the one phase where "what actually happened" is not in the
 * repository: the commands ran somewhere else. So the ledger is deliberately
 * **small and factual** — when, what environment, which revision, who approved
 * it, which gate authorised it, how it ended — and deliberately **not** a
 * narrative: a row that could be rewritten to look better is not evidence.
 *
 * Two rules make it survivable:
 *
 *  - **append-only**, one `JSON.stringify` line per write (`appendJsonl`), so a
 *    crash mid-write can only damage the LAST line;
 *  - **reading tolerates the truncated tail** and reports how many lines it
 *    could not use, instead of throwing or silently dropping them. A ledger that
 *    quietly forgets a deployment is worse than one that says "2 行无法解析".
 *
 * @module dsh-deploy-gate/ledger
 */

import { appendJsonl, readText, shortDigest, stamp } from 'dsh-eng-core'

/**
 * How one deployment attempt ended.
 *
 * `refused` is the attempt that never touched the environment: the go/no-go
 * checklist said no, or the human said no. It is recorded on purpose — "someone
 * tried to deploy this and was stopped, here is why" is exactly what an audit
 * asks for, and an attempt that leaves no trace is indistinguishable from an
 * attempt that never happened.
 */
export type DeployState = 'deployed' | 'failed' | 'verified' | 'verify-failed' | 'rolled-back' | 'rollback-failed' | 'refused'

/** Every state a row may carry (used for validation and for the histogram). */
export const DEPLOY_STATES: readonly DeployState[] = [
    'deployed',
    'failed',
    'verified',
    'verify-failed',
    'rolled-back',
    'rollback-failed',
    'refused',
]

/** One row of the deployment ledger. */
export interface LedgerRow {
    /** When the action finished (epoch ms). */
    at: number
    /** Stable id (`DPL-<stamp>-<digest>`), quoted by `rollbackOf`. */
    id: string
    environment: string
    /** The revision that was shipped (or the rollback target). */
    revision: string
    /** Who ran it (session id, or the agent that called the tool). */
    deployer: string
    /** Who authorised it, when the environment required approval. */
    approvedBy?: string
    /** Channel-side message id of the approval that authorised it. */
    approvalMessageId?: string
    /** The deploy/verify gate this row belongs to. */
    gateId?: string
    state: DeployState
    /** Free note the caller supplied (a rollback reason, an incident link). */
    note?: string
    /** How many go/no-go checks the plan evaluated. */
    plan?: { checks: number }
    /** Verification outcome, on verify rows. */
    verify?: { attempts: number; ok: boolean }
    /** How many canary steps ran, when the environment declared them. */
    canary?: { steps: number }
    /** The deployment this row rolls back, when the target is known. */
    rollbackOf?: string
}

/** What reading a ledger produced. */
export interface LedgerRead {
    file: string
    rows: LedgerRow[]
    /** Lines that could not be used (a truncated tail, a foreign row) — never silent. */
    problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a parsed line is a usable ledger row. */
export function isLedgerRow(value: unknown): value is LedgerRow {
    if (!isRecord(value)) return false
    if (typeof value['id'] !== 'string' || value['id'] === '') return false
    if (typeof value['environment'] !== 'string' || value['environment'] === '') return false
    if (typeof value['state'] !== 'string' || !(DEPLOY_STATES as readonly string[]).includes(value['state'])) return false
    if (typeof value['at'] !== 'number' || !Number.isFinite(value['at'])) return false
    if (typeof value['revision'] !== 'string') return false
    if (typeof value['deployer'] !== 'string') return false
    return true
}

/**
 * Read a ledger, tolerating a truncated last line.
 * @param file - absolute ledger path.
 * @returns every usable row (oldest first) plus one problem per unusable line.
 */
export function readLedger(file: string): LedgerRead {
    const text = readText(file)
    if (text === undefined) return { file, rows: [], problems: [] }
    const rows: LedgerRow[] = []
    const problems: string[] = []
    const lines = text.split('\n')
    lines.forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed === '') return
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            // A truncated tail is the expected shape of a crash: report it, keep
            // every row before it.
            const last = index === lines.length - 1 || lines.slice(index + 1).every((rest) => rest.trim() === '')
            problems.push(
                last
                    ? `第 ${index + 1} 行无法解析（JSON 不完整，通常是一次写入被中断留下的截断末行）：已跳过，不影响前面的 ${rows.length} 行`
                    : `第 ${index + 1} 行无法解析：已跳过`,
            )
            return
        }
        if (!isLedgerRow(parsed)) {
            problems.push(`第 ${index + 1} 行不是一条部署记录（缺少 id/environment/state/at/revision/deployer）：已跳过`)
            return
        }
        rows.push(parsed)
    })
    return { file, rows, problems }
}

/** Append one row (single line, create the file when missing). */
export function appendLedgerRow(file: string, row: LedgerRow): void {
    appendJsonl(file, row)
}

/** A readable, collision-free deployment id. */
export function deploymentId(at: number, environment: string, revision: string, nonce: number): string {
    return `DPL-${stamp(at)}-${shortDigest(`${at}:${environment}:${revision}:${nonce}`, 6)}`
}

/** Rows of one environment, oldest first (ties broken by id). */
export function rowsOf(rows: readonly LedgerRow[], environment: string): LedgerRow[] {
    return rows
        .filter((row) => row.environment === environment)
        .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
}

/**
 * The deployment the ledger believes is currently live in one environment.
 *
 * The state machine is deliberately pessimistic: a failure or a rollback leaves
 * the environment in a state the ledger cannot observe, so it says "unknown"
 * (returns `undefined`) instead of guessing that the previous row is still live.
 * @param rows - every ledger row.
 * @param environment - the environment to inspect.
 */
export function liveDeployment(rows: readonly LedgerRow[], environment: string): LedgerRow | undefined {
    let live: LedgerRow | undefined
    for (const row of rowsOf(rows, environment)) {
        switch (row.state) {
            case 'deployed':
                live = row
                break
            case 'verified':
                // A verify row describes the deployment it verified; only when the
                // deploy row itself is missing does it become the best evidence.
                if (live === undefined) live = row
                break
            case 'failed':
            case 'rolled-back':
            case 'rollback-failed':
                // Partial rollout, or a rollback whose target the ledger cannot
                // resolve: what is live now is not something this ledger knows.
                live = undefined
                break
            case 'refused':
                // Nothing ran, so whatever was live before is still live.
                break
            case 'verify-failed':
                // The deployment is live but failing verification — rolling it
                // back is exactly the expected next action, so it stays the target.
                break
        }
    }
    return live
}

/** The newest row of one environment, whatever its state. */
export function lastRowOf(rows: readonly LedgerRow[], environment: string): LedgerRow | undefined {
    return rowsOf(rows, environment).at(-1)
}

/**
 * The deployment a rollback would target: the live one when the ledger knows it,
 * else the newest attempt (a failed rollout is still the thing to undo).
 */
export function rollbackTargetOf(rows: readonly LedgerRow[], environment: string): LedgerRow | undefined {
    return liveDeployment(rows, environment) ?? lastRowOf(rows, environment)
}

/** Find one deployment by id, or by the revision it shipped (newest wins). */
export function findDeployment(rows: readonly LedgerRow[], environment: string, needle: string): LedgerRow | undefined {
    const candidates = rowsOf(rows, environment)
    const byId = [...candidates].reverse().find((row) => row.id === needle)
    if (byId !== undefined) return byId
    return [...candidates].reverse().find((row) => row.revision === needle || row.revision.startsWith(needle))
}

/** Per-environment summary of a ledger. */
export interface EnvironmentLedgerSummary {
    environment: string
    count: number
    /** When the last action happened. */
    lastAt?: number
    /** The revision of the last action. */
    revision?: string
    /** The state of the last action. */
    state?: DeployState
    /** How many rows of each state (a compact history). */
    states: Partial<Record<DeployState, number>>
    /** The deployment a rollback would target, when the ledger knows one. */
    rollbackTarget?: { id: string; at: number; revision: string; state: DeployState }
}

/** Whole-ledger summary. */
export interface LedgerSummary {
    rows: number
    environments: EnvironmentLedgerSummary[]
}

/**
 * Summarise a ledger: per environment, the last action and the rollback target.
 * @param rows - every ledger row (any order).
 */
export function summarize(rows: readonly LedgerRow[]): LedgerSummary {
    const names: string[] = []
    for (const row of rows) if (!names.includes(row.environment)) names.push(row.environment)
    const environments = names.sort().map((environment) => {
        const own = rowsOf(rows, environment)
        const last = own.at(-1)
        const states: Partial<Record<DeployState, number>> = {}
        for (const row of own) states[row.state] = (states[row.state] ?? 0) + 1
        const target = liveDeployment(rows, environment)
        return {
            environment,
            count: own.length,
            ...(last === undefined ? {} : { lastAt: last.at, revision: last.revision, state: last.state }),
            states,
            ...(target === undefined
                ? {}
                : { rollbackTarget: { id: target.id, at: target.at, revision: target.revision, state: target.state } }),
        }
    })
    return { rows: rows.length, environments }
}

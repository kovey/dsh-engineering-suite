/**
 * The row shape a worker writes into its OWN evidence ledger.
 *
 * A worker in a worktree may not touch the main mission (`mission.json`, gate
 * records, receipts — AC-007). What it may write is its local evidence, and the
 * importer later decides which of those rows are allowed into the main ledger
 * (AC-008). This module is the single description of that row: the fields a
 * worker must provide (including the `taskId` and `commit` the verification
 * needs) and the canonical `(taskId, at, id)` identity used for de-duplication.
 *
 * It lives apart from the importer so the pending-import scan can read the same
 * rows without importing the writer.
 *
 * @module dsh-eng-core/evidence-rows
 */

import type { EvidenceKind, EvidenceRecord, JsonValue } from './types.js'

/** Every evidence kind the delivery gate knows (mirrors `EvidenceKind`). */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['command', 'test', 'gate', 'artifact', 'diff', 'manual']

/** One evidence row produced inside a task worktree. */
export interface WorkerEvidenceRow {
    /** Row id, unique within the task's local ledger. */
    id: string
    /** Evidence kind (the same set the main ledger accepts). */
    kind: EvidenceKind
    /** When the worker recorded it (epoch ms). Part of the dedupe identity. */
    at: number
    /** One-line description. */
    summary: string
    /** Task that produced the row; must exist in the reviewed plan. */
    taskId: string
    /** Commit on the task's branch that carries the work (verified as merged). */
    commit: string
    /** Absolute path of the worktree, when the worker recorded it. */
    worktree?: string
    /** Branch the commit lives on, when the worker recorded it. */
    branch?: string
    /** Exact command line, for `command`/`test` rows. */
    command?: string
    /** Exit code of that command. */
    exitCode?: number | null
    /** SHA-256 of the captured output. */
    outputDigest?: string
    /** Bounded tail of the captured output. */
    outputTail?: string
    /** Free-form structured payload (kept as-is inside the imported record). */
    data?: JsonValue
}

/** A commit id: hex only, so it can never be read as a `git` option. */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i

function roundTrips(value: unknown): value is JsonValue {
    try {
        return JSON.stringify(value) !== undefined
    } catch {
        return false
    }
}

/** Read an optional string, reporting a wrong type. */
function optionalString(record: Record<string, unknown>, key: string, where: string, problems: string[]): string | undefined {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${where} 的 ${key} 必须是非空字符串（收到 ${JSON.stringify(value)}）`)
        return undefined
    }
    return value
}

/** Read an optional exit code (`null` is a real value: no exit code). */
function optionalExitCode(record: Record<string, unknown>, where: string, problems: string[]): number | null | undefined {
    const value = record['exitCode']
    if (value === undefined) return undefined
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${where} 的 exitCode 必须是数字或 null（收到 ${JSON.stringify(value)}）`)
        return undefined
    }
    return value
}

/**
 * Validate one worker evidence row.
 *
 * Rejecting is the whole point (AC-008: "绝不尽力而为"): a row without a
 * `taskId`, a `commit`, a known `kind` or a numeric `at` cannot be verified, so
 * it is reported and the batch will not be written.
 * @param raw - the untrusted row.
 * @param index - its position, used in the problem text.
 * @returns the parsed row or the problems found.
 */
export function parseWorkerEvidenceRow(raw: unknown, index: number): { row?: WorkerEvidenceRow; problems: string[] } {
    const problems: string[] = []
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { problems: [`rows[${index}] 必须是对象（收到 ${JSON.stringify(raw)}）`] }
    }
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    const where = `rows[${index}]${id === '' ? '' : `（id=${id}）`}`
    if (id === '') problems.push(`${where} 缺少 id（既有 evidence 行要求非空 id）`)
    const kind = record['kind']
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
        problems.push(`${where} 的 kind 必须是 ${EVIDENCE_KINDS.join(' / ')} 之一（收到 ${JSON.stringify(kind)}）`)
    }
    const at = record['at']
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
        problems.push(`${where} 的 at 必须是正数毫秒时间戳（收到 ${JSON.stringify(at)}）`)
    }
    const summary = record['summary']
    if (typeof summary !== 'string' || summary.trim() === '') problems.push(`${where} 的 summary 必须是非空字符串`)
    const taskId = typeof record['taskId'] === 'string' ? record['taskId'].trim() : ''
    if (taskId === '') problems.push(`${where} 缺少 taskId：无法证明这条证据属于哪个子任务`)
    const commit = typeof record['commit'] === 'string' ? record['commit'].trim() : ''
    if (!COMMIT_PATTERN.test(commit)) {
        problems.push(`${where} 的 commit 必须是 7-64 位十六进制 git 提交（收到 ${JSON.stringify(record['commit'])}）`)
    }
    const worktree = optionalString(record, 'worktree', where, problems)
    const branch = optionalString(record, 'branch', where, problems)
    const command = optionalString(record, 'command', where, problems)
    const outputDigest = optionalString(record, 'outputDigest', where, problems)
    const outputTail = optionalString(record, 'outputTail', where, problems)
    const exitCode = optionalExitCode(record, where, problems)
    if (record['data'] !== undefined && !roundTrips(record['data'])) {
        problems.push(`${where} 的 data 必须是可 JSON 序列化的值`)
    }
    if (problems.length > 0) return { problems }
    return {
        problems,
        row: {
            id,
            kind: kind as EvidenceKind,
            at: at as number,
            summary: summary as string,
            taskId,
            commit,
            ...(worktree === undefined ? {} : { worktree }),
            ...(branch === undefined ? {} : { branch }),
            ...(command === undefined ? {} : { command }),
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(outputDigest === undefined ? {} : { outputDigest }),
            ...(outputTail === undefined ? {} : { outputTail }),
            ...(record['data'] === undefined ? {} : { data: record['data'] as JsonValue }),
        },
    }
}

/** The `(taskId, at, id)` identity of one row: what "already imported" means. */
export function workerEvidenceKey(taskId: string, at: number, id: string): string {
    return `${taskId}\u0000${at}\u0000${id}`
}

/**
 * The identity an already-imported evidence record carries.
 *
 * Imported rows keep their worker-side identity inside
 * `data.import`; a record without it was recorded natively (not imported) and
 * can never collide with a worker row.
 * @param record - one row of the main evidence ledger.
 * @returns the key, or `undefined` for a natively recorded row.
 */
export function importedEvidenceKey(record: EvidenceRecord): string | undefined {
    const data = record.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
    const imported = (data as { import?: unknown }).import
    if (typeof imported !== 'object' || imported === null || Array.isArray(imported)) return undefined
    const { taskId, at, id } = imported as { taskId?: unknown; at?: unknown; id?: unknown }
    if (typeof taskId !== 'string' || typeof at !== 'number' || typeof id !== 'string') return undefined
    return workerEvidenceKey(taskId, at, id)
}

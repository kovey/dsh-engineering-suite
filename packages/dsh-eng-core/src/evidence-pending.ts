/**
 * "Which worker evidence has not been imported yet?" — the question the
 * worktree cleaner must ask before it deletes anything (AC-009).
 *
 * A task's evidence lives inside its own worktree, and a worktree is a
 * directory: removing it removes the only copy. So the cleaner cannot use
 * "did the merge succeed" as its condition — it has to compare the worker's
 * local ledger with what the main mission already imported, and refuse while
 * anything is still missing.
 *
 * This module only READS. The importer (`evidence-import.ts`) is what writes;
 * keeping the scan read-only means a cleaner can ask the question without
 * changing the answer.
 *
 * @module dsh-eng-core/evidence-pending
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { importedEvidenceKey, parseWorkerEvidenceRow, workerEvidenceKey, type WorkerEvidenceRow } from './evidence-rows.js'
import { existsSync } from 'node:fs'
import { listDir, readJsonl } from './io.js'
import { missionDir, resolveLayout, type Layout } from './paths.js'
import { splitTaskBranch, worktreeRoot } from './split-plan.js'
import type { EvidenceRecord } from './types.js'

/** Input of {@link pendingImports}. */
export interface PendingImportsInput {
    /** Absolute path of the main work tree (the workspace root). */
    mainTree: string
    /** Mission whose task worktrees to scan. */
    missionId: string
    /** Layout override (tests / a host that relocated the trail). */
    layout?: Layout
}

/** One task whose local evidence is not fully imported. */
export interface PendingWorkerImport {
    taskId: string
    /** Absolute path of the task's worktree. */
    worktree: string
    /** Branch the task commits on (read from git when the worktree still exists). */
    branch: string
    /** Absolute path of the worker's local evidence ledger. */
    file: string
    /** The rows the main mission does not have yet. */
    rows: WorkerEvidenceRow[]
    /** `rows.length` — what the cleaner prints. */
    pending: number
    /** Rows the main mission already imported from this task. */
    alreadyImported: number
}

/**
 * The worker's local evidence ledger inside one worktree.
 *
 * The worker writes through the same layout it checked out, so the trail root is
 * the SAME workspace-relative directory as the main tree's (`.dsh/…`), resolved
 * against the worktree instead of the main tree.
 */
export function workerEvidenceFile(worktree: string, mainTree: string, layout: Layout, missionId: string): string {
    const relativeRoot = path.relative(mainTree, layout.rootDir)
    return path.join(worktree, relativeRoot, 'missions', missionId, 'evidence.jsonl')
}

/** The branch a task's worktree is on (falls back to the documented name). */
function branchOf(worktree: string, missionId: string, taskId: string): string {
    // `git -C <dir>` resolves the ENCLOSING repository for a plain directory, and
    // the worktrees root lives inside the main tree — so without the `.git` entry
    // a `git worktree add` leaves behind, "the branch of this directory" would
    // silently be the branch of the main tree. Only a real worktree is asked.
    if (!existsSync(path.join(worktree, '.git'))) return splitTaskBranch(missionId, taskId)
    const result = spawnSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 10_000 })
    const name = result.status === 0 ? (result.stdout ?? '').trim() : ''
    return name === '' || name === 'HEAD' ? splitTaskBranch(missionId, taskId) : name
}

/** Keys of the rows the main mission already holds from task imports. */
function importedKeys(layout: Layout, missionId: string): Set<string> {
    const rows = readJsonl<EvidenceRecord>(path.join(missionDir(layout, missionId), 'evidence.jsonl'))
    const keys = new Set<string>()
    for (const row of rows) {
        const key = importedEvidenceKey(row)
        if (key !== undefined) keys.add(key)
    }
    return keys
}

/** Every syntactically valid row of one worker ledger. */
function workerRows(file: string): WorkerEvidenceRow[] {
    const rows: WorkerEvidenceRow[] = []
    readJsonl<unknown>(file).forEach((raw, index) => {
        const parsed = parseWorkerEvidenceRow(raw, index)
        if (parsed.row !== undefined) rows.push(parsed.row)
    })
    return rows
}

/**
 * Scan the mission's task worktrees for evidence that is not in the main ledger.
 *
 * @param input - main tree, mission id and optional layout override.
 * @returns one entry per task that still has unimported rows, sorted by task id.
 */
export function pendingImports(input: PendingImportsInput): PendingWorkerImport[] {
    // Absolute: the layout (and the git answer below) must be about THIS tree.
    const mainTree = path.resolve(input.mainTree)
    const layout = input.layout ?? resolveLayout(mainTree)
    const imported = importedKeys(layout, input.missionId)
    const root = path.join(worktreeRoot(layout), input.missionId)
    const pending: PendingWorkerImport[] = []
    for (const taskId of listDir(root).sort()) {
        const worktree = path.join(root, taskId)
        const file = workerEvidenceFile(worktree, mainTree, layout, input.missionId)
        const rows = workerRows(file)
        if (rows.length === 0) continue
        const missing = rows.filter((row) => !imported.has(workerEvidenceKey(row.taskId, row.at, row.id)))
        if (missing.length === 0) continue
        pending.push({
            taskId,
            worktree,
            branch: branchOf(worktree, input.missionId, taskId),
            file,
            rows: missing,
            pending: missing.length,
            alreadyImported: rows.length - missing.length,
        })
    }
    return pending
}

/** One-line rendering of a pending entry (the cleaner's "print the list"). */
export function describePendingImport(entry: PendingWorkerImport): string {
    return `- ${entry.taskId}：${entry.pending} 条待导入（已导入 ${entry.alreadyImported} 条；worktree ${entry.worktree}，分支 ${entry.branch}，台账 ${entry.file}）`
}

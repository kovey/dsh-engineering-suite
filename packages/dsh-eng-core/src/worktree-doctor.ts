/**
 * The read-only crash-recovery view of a mission's task worktrees (AC-003 of P3).
 *
 * A run can die between "the worktree exists" and "the run record was written":
 * the process is killed, the host restarts, the tool call is cancelled. What is
 * left behind is a directory under `worktrees/<missionId>/` that nothing in the
 * mission's own artifacts mentions. The questions an operator then has are
 * exactly three, in this order:
 *
 *  1. **Is there evidence in here that never landed in the main ledger?**
 *     (`needs-import` — the ONE category that must never be deleted, because the
 *     worktree is the only copy of those rows.)
 *  2. **Does the run record say this task finished?** (`safe-to-clean` — the
 *     evidence landed and the run says `done`; only the directory was left.)
 *  3. **Otherwise: nobody's artifact explains this directory** (`orphan` — no
 *     `run.json` row at all, or a row whose state is not `done`).
 *
 * Three properties are deliberate:
 *
 *  - **it only READS.** No function here creates, moves or removes anything, so
 *    a "doctor" call can never be the reason a worktree disappeared. The removal
 *    path stays `cleanupTaskWorktree` (which refuses while anything is still
 *    unimported) and is only reachable from an explicit `--apply` command;
 *  - **"safe" is about the ARTIFACTS, not about git.** `safe-to-clean` says the
 *    run recorded the task as done and nothing is unimported. It does not claim
 *    the directory is empty of work: `git worktree remove` still refuses a dirty
 *    tree, and a removed worktree never deletes its branch — the commits stay
 *    reachable on `split/<missionId>/<taskId>`;
 *  - **an unreadable run record is reported, not guessed.** A corrupt
 *    `run.json` makes every directory an `orphan` (nobody's record explains it)
 *    and adds a problem naming the file, so "could not read" never silently
 *    becomes "no record says it matters".
 *
 * @module dsh-eng-core/worktree-doctor
 */

import fs from 'node:fs'
import path from 'node:path'
import { pendingImports } from './evidence-pending.js'
import { listDir, readJson } from './io.js'
import { assertSafeId, resolveLayout, type Layout } from './paths.js'
import { splitTaskBranch, worktreeRoot } from './split-plan.js'

/** What one leftover directory is, from the mission's own artifacts. */
export type OrphanWorktreeKind =
    /** Unimported local evidence: deleting it loses the only copy (`clean` refuses). */
    | 'needs-import'
    /** The run record says `done` and nothing is pending: only the directory is left. */
    | 'safe-to-clean'
    /** No run-record row, or a row whose state is not `done`: unexplained leftover. */
    | 'orphan'

/** One directory the doctor found under `worktrees/<missionId>/`. */
export interface OrphanWorktree {
    taskId: string
    /** Absolute path of the directory. */
    worktree: string
    kind: OrphanWorktreeKind
    /** The branch the task commits on (always known; removal never deletes it). */
    branch: string
    /** `run.json`'s state for this task (`undefined` = the record has no row). */
    runState?: string
    /** `run.json`'s commit for this task, first 12 chars (`undefined` = none). */
    commit?: string
    /** Unimported local evidence rows for this task (`0` = nothing to import). */
    pendingRows: number
    /** `true` while the directory is still a live git worktree (has its `.git` file). */
    live: boolean
    /** Why this kind was chosen, and what the operator should do next. */
    notes: string[]
}

/** Input of {@link findOrphanWorktrees}. */
export interface OrphanWorktreeInput {
    /** Absolute path of the main work tree (the workspace root). */
    mainTree: string
    missionId: string
    /** Layout override (tests / a host that relocated the trail). */
    layout?: Layout
}

/** The whole doctor view of one mission. */
export interface OrphanWorktreeReport {
    missionId: string
    /** Directory scanned (`worktrees/<missionId>`). */
    root: string
    /** `true` when `split/run.json` exists and parsed. */
    runRecordRead: boolean
    /** One entry per directory on disk, in task-id order. */
    entries: OrphanWorktree[]
    /** Task ids the run record mentions whose directory is gone (informational). */
    missingDirs: string[]
    /** The pending-import entries of this mission (the reason a clean must refuse). */
    pending: { taskId: string; rows: number; worktree: string }[]
    problems: string[]
}

/** The part of `split/run.json` this module reads (everything is untrusted JSON). */
interface RunRecord {
    tasks?: unknown
}

/** One row of the run record, as far as the doctor trusts it. */
interface RunRow {
    state?: string
    commit?: string
}

/** `split/run.json` of one mission (the same path `splitRunFile` names). */
function runFileOf(layout: Layout, missionId: string): string {
    return path.join(layout.missionsDir, missionId, 'split', 'run.json')
}

/** Rows of the run record keyed by task id (malformed rows are skipped, never guessed). */
function runRowsOf(file: string, problems: string[]): { rows: Map<string, RunRow>; read: boolean } {
    if (!fs.existsSync(file)) return { rows: new Map(), read: false }
    const record = readJson<RunRecord>(file)
    if (record === undefined || typeof record !== 'object' || record === null) {
        problems.push(`${file} 无法解析：按"没有运行记录"处理（目录全部按孤儿列出，不猜状态）`)
        return { rows: new Map(), read: false }
    }
    const rows = new Map<string, RunRow>()
    if (!Array.isArray(record.tasks)) {
        problems.push(`${file} 没有 tasks 数组：按"没有运行记录"处理（目录全部按孤儿列出）`)
        return { rows, read: false }
    }
    for (const row of record.tasks) {
        if (typeof row !== 'object' || row === null) continue
        const entry = row as { id?: unknown; state?: unknown; commit?: unknown }
        if (typeof entry.id !== 'string') continue
        rows.set(entry.id, {
            ...(typeof entry.state === 'string' ? { state: entry.state } : {}),
            ...(typeof entry.commit === 'string' ? { commit: entry.commit.slice(0, 12) } : {}),
        })
    }
    return { rows, read: true }
}

/** Whether `dir` is a live git worktree (a `.git` FILE, not a directory). */
function isLiveWorktree(dir: string): boolean {
    try {
        return fs.statSync(path.join(dir, '.git')).isFile()
    } catch {
        return false
    }
}

/** The recommended command (one line, never executed by this module). */
function cleanCommand(missionId: string): string {
    return `bash scripts/split-clean.sh --orphans --mission ${missionId}`
}

/** The classification plus the notes that explain it. */
function classify(input: { taskId: string; row: RunRow | undefined; pendingRows: number; missionId: string }): { kind: OrphanWorktreeKind; notes: string[] } {
    if (input.pendingRows > 0) {
        return {
            kind: 'needs-import',
            notes: [
                `有 ${input.pendingRows} 条本地 evidence 没有导入主 mission：删除目录就再也找不回来，clean 会拒绝。`,
                `先导入（split 导入器 / 完成一次 runSplitPlan 收尾），再执行 ${cleanCommand(input.missionId)}。`,
            ],
        }
    }
    if (input.row?.state === 'done') {
        return {
            kind: 'safe-to-clean',
            notes: [`run.json 记录该任务 done 且没有待导入行：目录可以清理（${cleanCommand(input.missionId)} --apply）。`],
        }
    }
    const state = input.row === undefined ? 'run.json 里没有这个任务' : `run.json 的状态是 ${input.row.state ?? '(未知)'}`
    return {
        kind: 'orphan',
        notes: [
            `${state}：没有产物解释这个目录（崩溃或未写入记录）。`,
            `分支仍在 ${splitTaskBranch(input.missionId, input.taskId)}：删 worktree 不会删分支，但未提交的文件会随目录消失。`,
            `先看 ${cleanCommand(input.missionId)} 的 dry-run 输出，确认后再加 --apply。`,
        ],
    }
}

/**
 * List the leftover worktrees of one mission, classified (AC-003).
 *
 * @param input - the main tree, the mission and an optional layout override.
 * @returns every directory on disk under `worktrees/<missionId>/`, one
 *   classification each, the pending-import summary and every problem found.
 *   Never throws and never writes.
 */
export function findOrphanWorktrees(input: OrphanWorktreeInput): OrphanWorktreeReport {
    const mainTree = path.resolve(input.mainTree)
    const missionId = assertSafeId(input.missionId, 'mission id')
    const layout = input.layout ?? resolveLayout(mainTree)
    const root = path.join(worktreeRoot(layout), missionId)
    const problems: string[] = []
    const run = runRowsOf(runFileOf(layout, missionId), problems)
    const pending = pendingImports({ mainTree, missionId, layout })
    const pendingByTask = new Map(pending.map((entry) => [entry.taskId, entry.rows.length]))
    const entries: OrphanWorktree[] = []
    for (const taskId of listDir(root).sort()) {
        let safe = true
        try {
            assertSafeId(taskId, 'task id')
        } catch {
            // A directory whose name cannot be a task id is never treated as one:
            // no branch, no cleanup command — just a problem an operator can read.
            safe = false
            problems.push(`${path.join(root, taskId)} 的目录名不是合法子任务 id：不分类、不建议清理（请人工确认）`)
        }
        if (!safe) continue
        const worktree = path.join(root, taskId)
        const pendingRows = pendingByTask.get(taskId) ?? 0
        const row = run.rows.get(taskId)
        const verdict = classify({ taskId, row, pendingRows, missionId })
        entries.push({
            taskId,
            worktree,
            kind: verdict.kind,
            branch: splitTaskBranch(missionId, taskId),
            ...(row?.state === undefined ? {} : { runState: row.state }),
            ...(row?.commit === undefined ? {} : { commit: row.commit }),
            pendingRows,
            live: isLiveWorktree(worktree),
            notes: verdict.notes,
        })
    }
    const onDisk = new Set(entries.map((entry) => entry.taskId))
    const missingDirs = [...run.rows.keys()].filter((taskId) => !onDisk.has(taskId)).sort()
    return {
        missionId,
        root,
        runRecordRead: run.read,
        entries,
        missingDirs,
        pending: pending.map((entry) => ({ taskId: entry.taskId, rows: entry.rows.length, worktree: entry.worktree })),
        problems,
    }
}

/** Count one kind (the status line asks "how many orphans"). */
export function orphanCount(report: OrphanWorktreeReport, kind: OrphanWorktreeKind): number {
    return report.entries.filter((entry) => entry.kind === kind).length
}

/**
 * One line per entry, bounded (the status view prints the first few).
 * @param report - the doctor view.
 * @param limit - how many entries to render (the rest is summarised by the caller).
 */
export function describeOrphanWorktrees(report: OrphanWorktreeReport, limit: number): string[] {
    return report.entries.slice(0, Math.max(0, limit)).map((entry) => {
        const state = entry.runState === undefined ? '无记录' : entry.runState
        const pendingText = entry.pendingRows > 0 ? `，${entry.pendingRows} 条待导入` : ''
        return `- ${entry.taskId}：${entry.kind}（run=${state}${pendingText}，目录 ${entry.live ? '是活 worktree' : '不是活 worktree'}）`
    })
}

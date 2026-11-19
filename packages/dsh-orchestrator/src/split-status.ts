/**
 * The read-only split section of `orchestrate({ action: "status" })` (AC-004).
 *
 * It answers, from artifacts alone: which plan is on disk (digest), whether a
 * person approved THAT version, what each task's run did (state, commit, imported
 * rows, whether its worktree is gone), the rework ratio and whether the model was
 * escalated, and how many evidence rows are still unimported. Since P3 it also
 * lists the leftover/orphan worktrees with their cleanup command (AC-003), still
 * read-only.
 *
 * Two rules shape it:
 *
 *  - **read-only, no gate record.** This module has no write path at all: a status
 *    view that mutated the mission (or recorded a gate) would be a second,
 *    unversioned state machine next to the artifacts;
 *  - **absent when there is no plan.** A mission that never split keeps the old
 *    status output byte-for-byte — the section appears only when a
 *    `split/plan.json` exists, so the P1 report does not change for everyone else.
 *
 * Missing pieces are NAMED (`尚未派发`, `缺失`, `-`), never rendered as zeroes: a
 * `commit -` must not be mistaken for "committed nothing", and an unimported row
 * count of 0 only means "nothing pending" when a run record says so.
 *
 * @module dsh-orchestrator/split-status
 */

import { readJson, type Layout } from 'dsh-eng-core'
import {
    describeOrphanWorktrees,
    findOrphanWorktrees,
    orphanCount,
    pendingImports,
    readSplitPlan,
    splitReviewStatus,
    type SplitReviewStatus,
} from 'dsh-eng-core/split'
import { splitRunFile } from './split-run-types.js'

/** One task as `split/run.json` recorded it (absent for a never-dispatched task). */
interface RunTask {
    id?: unknown
    state?: unknown
    commit?: unknown
    imported?: unknown
    cleanedUp?: unknown
}

/** The part of `split/run.json` the status reads (everything is untrusted JSON). */
interface SplitRunRecord {
    state?: unknown
    tasks?: unknown
    rework?: { ratio?: unknown; threshold?: unknown; escalate?: unknown; started?: unknown; reworked?: unknown }
}

/** The review state as one word plus its detail (a person reads both). */
function reviewText(status: SplitReviewStatus): string {
    switch (status.state) {
        case 'approved':
            return `approved（${status.detail}）`
        case 'rejected':
            return `rejected（${status.detail}）`
        case 'stale':
            return `已失效（stale：${status.detail}）`
        case 'missing-review':
            return `缺失（未审核：${status.detail}）`
        default:
            return `缺失（${status.detail}）`
    }
}

/** The run record, or `undefined` when the mission was never dispatched. */
function readRun(layout: Layout, missionId: string): SplitRunRecord | undefined {
    const record = readJson<SplitRunRecord>(splitRunFile(layout, missionId))
    if (record === undefined || typeof record !== 'object' || record === null) return undefined
    return record
}

/** Rows of the run record, keyed by task id (malformed rows are skipped). */
function runRowsOf(run: SplitRunRecord | undefined): Map<string, RunTask> {
    const rows = new Map<string, RunTask>()
    if (run === undefined || !Array.isArray(run.tasks)) return rows
    for (const row of run.tasks) {
        if (typeof row !== 'object' || row === null) continue
        const record = row as RunTask
        if (typeof record.id === 'string') rows.set(record.id, record)
    }
    return rows
}

/** `commit` in eight characters, or `-` (never an empty cell that reads as "none"). */
function commitCell(row: RunTask | undefined): string {
    return typeof row?.commit === 'string' && row.commit !== '' ? row.commit.slice(0, 8) : '-'
}

/** One table row per plan task, joined with its run record. */
function taskLine(taskId: string, row: RunTask | undefined): string {
    const state = typeof row?.state === 'string' ? row.state : '未派发'
    const imported = typeof row?.imported === 'number' ? String(row.imported) : '-'
    const cleanedUp = row === undefined ? '-' : row.cleanedUp === true ? '✅' : '—'
    return `${taskId} | ${state} | ${commitCell(row)} | ${imported} | ${cleanedUp}`
}

/** The ratio line, from the run's own numbers (no recomputation, no guessing). */
function reworkLine(run: SplitRunRecord | undefined): string {
    const rework = run?.rework
    if (rework === undefined || typeof rework.ratio !== 'number') return '返工率：尚无派发记录'
    const started = typeof rework.started === 'number' ? rework.started : 0
    const reworked = typeof rework.reworked === 'number' ? rework.reworked : 0
    const threshold = typeof rework.threshold === 'number' ? rework.threshold : 0
    const escalated = rework.escalate === true ? '已升级 planner 模型' : '未升级（不超过阈值）'
    return `返工率：${reworked}/${started} = ${rework.ratio.toFixed(3)}（阈值 ${threshold}，${escalated}）`
}

/**
 * The crash-recovery lines of the split section (P3 AC-003).
 *
 * `findOrphanWorktrees` only READS: this view lists the leftovers, the one
 * category that must be imported before anything is deleted, and the exact
 * command an operator can run. It never removes a directory and never writes a
 * gate record — AC-005 says a measurement may not change a delivery verdict.
 */
function orphanLines(layout: Layout, missionId: string): string[] {
    const report = findOrphanWorktrees({ mainTree: layout.cwd, missionId, layout })
    const orphans = orphanCount(report, 'orphan')
    const needsImport = orphanCount(report, 'needs-import')
    const cleanable = orphanCount(report, 'safe-to-clean')
    const runText = report.runRecordRead ? '已读' : '缺失/无法解析（全部按孤儿列出）'
    return [
        `- 孤儿：${orphans} 个 / 待导入残留：${needsImport} 个 / 可安全清理：${cleanable} 个（磁盘共 ${report.entries.length} 个目录；run.json ${runText}）`,
        ...describeOrphanWorktrees(report, 5),
        ...(report.entries.length > 5 ? [`- （另有 ${report.entries.length - 5} 个目录未逐条列出）`] : []),
        ...(needsImport > 0 ? ['- 待导入的目录**不能删**：先导入这些证据，clean 会拒绝（未导入的本地证据随目录删除就再也找不回来了）'] : []),
        ...report.problems.map((problem) => `- doctor：${problem}`),
        `- 清理命令：bash scripts/split-clean.sh --orphans --mission ${missionId}（默认 dry-run 只打印；--apply 才逐个走"先导入再删"）`,
    ]
}

/**
 * Render the split section of the status report.
 * @param layout - the workspace layout.
 * @param missionId - the mission whose split artifacts to read.
 * @returns the lines to append, or `[]` when the mission has no plan (old output).
 */
export function renderSplitStatus(layout: Layout, missionId: string): string[] {
    const stored = readSplitPlan(layout, missionId)
    if (stored === undefined) return []
    const review = splitReviewStatus(layout, missionId)
    const run = readRun(layout, missionId)
    const rows = runRowsOf(run)
    const pending = pendingImports({ mainTree: layout.cwd, missionId, layout })
    const pendingRows = pending.reduce((sum, entry) => sum + entry.rows.length, 0)
    const tasks = stored.plan.tasks ?? []
    const lines = [
        '',
        '## 拆分',
        `- plan：摘要 ${stored.digest.slice(0, 12)}（${tasks.length} 个子任务，${(stored.plan.parallelGroups ?? []).length} 个并行组）`,
        `- 审核：${reviewText(review)}`,
        `- 运行：${run === undefined ? '尚未派发（split/run.json 缺失）' : typeof run.state === 'string' ? run.state : '(未知)'}`,
        '',
        '子任务 | 状态 | commit | 导入 | 清理',
        '-------|------|--------|------|------',
        ...tasks.map((task) => taskLine(task.id, rows.get(task.id))),
        '',
        `- ${reworkLine(run)}`,
        `- 待导入：${pendingRows} 条（${pending.length} 个子任务）${cleanableText(run, tasks.length, pendingRows)}`,
        ...orphanLines(layout, missionId),
    ]
    return lines
}

/** Whether the mission can be cleaned up now (all tasks done and nothing unimported). */
function cleanableText(run: SplitRunRecord | undefined, taskCount: number, pendingRows: number): string {
    if (pendingRows > 0) return '；可清理：否（先导入这些证据，cleanup 会拒绝）'
    if (run === undefined) return '；可清理：不适用（没有派发记录）'
    const rows = runRowsOf(run)
    const done = [...rows.values()].filter((row) => row.state === 'done').length
    return done > 0 && done === taskCount ? `；可清理：是（${done}/${taskCount} 个子任务已完成，剩余未导入为 0）` : `；可清理：否（${done}/${taskCount} 个子任务完成）`
}

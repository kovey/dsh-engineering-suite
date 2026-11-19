/**
 * The steps AFTER the workers ran: merge, import, cleanup, rework report, record.
 *
 * The order is the contract, and each step refuses rather than "does its best":
 *
 *  1. **merge** (AC-008's precondition) — the importer only accepts a commit that
 *     is in the main tree's history, so a branch that is not merged cannot have
 *     its evidence imported. A failed merge is a `merge-conflict` rework signal
 *     and says nothing about the other tasks.
 *  2. **import** — per task, through the existing importer, which re-verifies the
 *     reviewed digest, the task membership, the merge state and the row shape.
 *  3. **cleanup** — only after the import step, and only for tasks whose rows
 *     landed; the worktree library itself refuses while anything is still
 *     unimported (AC-009) and never deletes a directory git could not remove.
 *  4. **rework report** (AC-011) — the ratio and the threshold go into
 *     `split/rework.json` (and an evidence row when the threshold is exceeded).
 *  5. **run.json** — one record of every task, its state and commit.
 *
 * @module dsh-orchestrator/split-run-finish
 */

import { writeJsonAtomic } from 'dsh-eng-core'
import { importTaskEvidence, pendingImports, splitTaskBranch, type ReworkReport, type ReworkSignal } from 'dsh-eng-core/split'
import { writeSplitRunReport } from './split-run-report.js'
import { planNextSplitTask } from './split-rework.js'
import { splitRunFile, type SplitRunBook, type SplitRunResult, type SplitRunState, type SplitTaskRun } from './split-run-types.js'

/** The record of one task inside this run. */
export function taskRecordOf(book: SplitRunBook, taskId: string): SplitTaskRun | undefined {
    return book.tasks.find((task) => task.id === taskId)
}

/** Add one problem line and pass it to the progress log. */
function note(book: SplitRunBook, line: string): void {
    book.problems.push(line)
    book.log(line)
}

/** Mark one task failed with the rework signal its failure means. */
export function failTask(book: SplitRunBook, record: SplitTaskRun, problems: readonly string[], signal: ReworkSignal): void {
    record.state = 'failed'
    for (const problem of problems) {
        record.problems.push(problem)
        note(book, `子任务 ${record.id}：${problem}`)
    }
    if (!record.signals.includes(signal)) record.signals.push(signal)
}

/** Merge every done task's branch into the main tree (AC-008's precondition). */
function mergeTasks(book: SplitRunBook): void {
    for (const record of book.tasks) {
        if (record.state !== 'done' || record.commit === undefined) continue
        const merge = book.seam.merge({
            mainTree: book.mainTree,
            branch: record.branch ?? splitTaskBranch(book.missionId, record.id),
            taskId: record.id,
        })
        if (merge.ok) continue
        failTask(book, record, merge.problems, 'merge-conflict')
    }
}

/** Import one done task's pending rows; the importer refuses the whole batch or nothing. */
function importTask(book: SplitRunBook, record: SplitTaskRun, rows: readonly unknown[]): void {
    const result = importTaskEvidence({
        mainTree: book.mainTree,
        missionId: book.missionId,
        planDigest: book.planDigest,
        rows: [...rows],
        layout: book.layout,
        at: book.at,
    })
    record.imported = result.imported.length
    if (result.ok) return
    // The commit is verified as landed, so a refusal here is about the ROWS: the
    // importer found something it cannot prove (AC-008 = "绝不尽力而为").
    record.imported = 0
    failTask(book, record, result.problems, 'acceptance-failed')
}

/** Import the local evidence of every task whose merge landed. */
function importTasks(book: SplitRunBook): void {
    const pending = pendingImports({ mainTree: book.mainTree, missionId: book.missionId, layout: book.layout })
    for (const record of book.tasks) {
        if (record.state !== 'done') continue
        const rows = pending.find((entry) => entry.taskId === record.id)?.rows
        if (rows === undefined) {
            book.log(`子任务 ${record.id}：worktree 里没有待导入的本地 evidence`)
            continue
        }
        importTask(book, record, rows)
    }
}

/**
 * Remove every worktree — only after the import, and a refusal is reported as-is.
 *
 * A task stopped by `split.taskTimeoutMs` is SKIPPED (AC-003): its worktree is
 * the only copy of whatever the worker had written when the deadline fired, and
 * the mission's rule is that a timeout keeps the worktree and the local ledger
 * for the import/cleanup flow to handle later — not that it quietly deletes
 * them because "no rows were imported yet".
 */
function cleanupTasks(book: SplitRunBook): void {
    for (const record of book.tasks) {
        if (record.worktree === undefined) continue
        if (record.signals.includes('timeout')) {
            book.log(`子任务 ${record.id}：派发超时，worktree 与本地台账保留（本次不清理）：${record.worktree}`)
            continue
        }
        const result = book.seam.cleanup({ mainTree: book.mainTree, missionId: book.missionId, taskId: record.id })
        record.cleanedUp = result.removed || result.alreadyGone
        for (const problem of result.problems) note(book, `子任务 ${record.id}：${problem}`)
    }
}

/** The per-task input of the rework computation (`started` = had a dispatch attempt). */
function reworkInputs(book: SplitRunBook): Record<string, unknown>[] {
    return book.tasks.map((record) => ({ id: record.id, started: record.attempts > 0, signals: [...record.signals] }))
}

/** AC-011: the ratio, the threshold and the escalation — recorded, never a stop. */
function recordRework(book: SplitRunBook): ReworkReport {
    const plan = planNextSplitTask({ layout: book.layout, missionId: book.missionId, models: book.models, tasks: reworkInputs(book), at: book.at })
    // `lines` already ends with the escalation warning when the ratio is over the
    // threshold: pushing `plan.warning` as well recorded the same sentence twice.
    book.warnings.push(...plan.lines)
    book.problems.push(...plan.problems)
    book.problems.push(...plan.report.problems)
    return plan.report
}

/** The result object for one state (no artifacts written). */
function resultOf(book: SplitRunBook, state: SplitRunState, rework: ReworkReport): SplitRunResult {
    return {
        ok: state === 'ran' && book.tasks.every((record) => record.state === 'done') && book.problems.length === 0,
        state,
        planDigest: book.planDigest,
        tasks: book.tasks,
        imported: book.tasks.reduce((sum, record) => sum + record.imported, 0),
        rework,
        problems: book.problems,
        warnings: book.warnings,
    }
}

/** Write `split/run.json` and `split/report.json` (one shape for every outcome) and return it with `file`. */
function writeRunRecord(book: SplitRunBook, result: SplitRunResult): SplitRunResult {
    const file = splitRunFile(book.layout, book.missionId)
    writeJsonAtomic(file, {
        missionId: book.missionId,
        at: book.at,
        state: result.state,
        ok: result.ok,
        planDigest: result.planDigest,
        maxParallel: book.maxParallel,
        modelClasses: { worker: book.models.worker, planner: book.models.planner },
        tasks: result.tasks,
        imported: result.imported,
        rework: result.rework,
        problems: result.problems,
        warnings: result.warnings,
    })
    // AC-005: written WITH the run record, from the same book. Nothing reads it —
    // the report is a projection, never delivery evidence.
    return { ...result, file, reportFile: writeSplitRunReport(book, result) }
}

/**
 * The steps after the task loop, then `split/run.json`.
 *
 * @param book - the run state (tasks already dispatched).
 * @returns the result, with `file` naming the written record.
 */
export function finishDispatchedRun(book: SplitRunBook): SplitRunResult {
    mergeTasks(book)
    importTasks(book)
    cleanupTasks(book)
    const rework = recordRework(book)
    return writeRunRecord(book, resultOf(book, 'ran', rework))
}

/**
 * Record a run that never dispatched (not worth splitting / too large / refused).
 *
 * The record is written on purpose: "why did no worker run" must be answerable
 * from the mission's own artifacts, not from a log line that is already gone.
 * @param book - the run state (every task still `pending`).
 * @param state - the verdict.
 * @param rework - an empty-but-valid report.
 * @param problems - why the run stopped before dispatching.
 */
export function finishSkippedRun(book: SplitRunBook, state: SplitRunState, rework: ReworkReport, problems: readonly string[]): SplitRunResult {
    book.problems.push(...problems)
    return writeRunRecord(book, resultOf(book, state, rework))
}

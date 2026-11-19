/**
 * `split/report.json` — what one run cost and how it went, per task (AC-005).
 *
 * The report is a PROJECTION of `run.json` plus the per-task timing: it adds no
 * decision and no new fact. It exists because the questions an operator actually
 * asks afterwards are per-task ("which model ran T-003, how long did it take, why
 * was it reworked?") and answering them from `run.json` means re-deriving them by
 * hand from a state machine.
 *
 * Two properties are deliberate:
 *
 *  - **it is written with `run.json`, from the same book**, so the two artifacts
 *    cannot describe different runs;
 *  - **nothing reads it.** No gate, no importer, no receipt consults the report:
 *    a missing or edited `report.json` changes no verdict (the negative
 *    constraint of the mission: the report never becomes delivery evidence).
 *
 * @module dsh-orchestrator/split-run-report
 */

import { writeJsonAtomic } from 'dsh-eng-core'
import { splitReportFile, type SplitRunBook, type SplitRunResult } from './split-run-types.js'

/** One task's row of the report (the shape an operator reads). */
export interface SplitTaskReport {
    id: string
    /** `planner` = escalated by the rework ratio; `null` = never routed. */
    modelClass: 'worker' | 'planner' | null
    /** The routed model, without the provider prefix (`null` = never routed). */
    model: string | null
    /** Wall time of the dispatch in ms (0 when it never started). */
    durationMs: number
    attempts: number
    /** The rework signals observed for this task (`timeout`, `acceptance-failed`, …). */
    reworkReasons: string[]
    /** Evidence rows imported from this task. */
    imported: number
}

/** The whole report. */
export interface SplitRunReport {
    missionId: string
    at: number
    state: string
    ok: boolean
    planDigest: string
    tasks: SplitTaskReport[]
    /** The same numbers `rework.json` carries, repeated so one file answers "how did it go". */
    rework: { ratio: number; threshold: number; escalate: boolean }
    /** The concurrency the scheduler really used. */
    parallelism: { maxParallel: number; groups: string[][] }
}

/** One task's duration from the book's clock (`0` when it never ran). */
function durationOf(task: SplitRunResult['tasks'][number]): number {
    if (task.startedAt === undefined || task.finishedAt === undefined) return 0
    return Math.max(0, task.finishedAt - task.startedAt)
}

/**
 * Build the report from a finished run.
 * @param book - the run state (its clock, its maxParallel and its real groups).
 * @param result - what the run reported (tasks, rework, digest).
 */
export function buildSplitRunReport(book: SplitRunBook, result: SplitRunResult): SplitRunReport {
    return {
        missionId: book.missionId,
        at: book.at,
        state: result.state,
        ok: result.ok,
        planDigest: result.planDigest ?? book.planDigest,
        tasks: result.tasks.map((task) => ({
            id: task.id,
            modelClass: task.modelClass ?? null,
            model: task.model ?? null,
            durationMs: durationOf(task),
            attempts: task.attempts,
            reworkReasons: [...task.signals],
            imported: task.imported,
        })),
        rework: { ratio: result.rework.ratio, threshold: result.rework.threshold, escalate: result.rework.escalate },
        parallelism: { maxParallel: book.maxParallel, groups: book.groups.map((group) => [...group]) },
    }
}

/**
 * Write `missions/<id>/split/report.json`.
 * @returns the absolute path written.
 */
export function writeSplitRunReport(book: SplitRunBook, result: SplitRunResult): string {
    const file = splitReportFile(book.layout, book.missionId)
    writeJsonAtomic(file, buildSplitRunReport(book, result))
    return file
}

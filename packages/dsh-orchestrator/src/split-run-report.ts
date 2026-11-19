/**
 * `split/report.json` — what one run cost and how it went, per task (AC-005 of
 * P2; the economics segment is AC-001 of P3).
 *
 * The report is a PROJECTION of `run.json` plus the per-task timing: it adds no
 * decision and no new fact. It exists because the questions an operator actually
 * asks afterwards are per-task ("which model ran T-003, how long did it take, why
 * was it reworked?") and answering them from `run.json` means re-deriving them by
 * hand from a state machine.
 *
 * Three properties are deliberate:
 *
 *  - **it is written with `run.json`, from the same book**, so the two artifacts
 *    cannot describe different runs;
 *  - **nothing reads it.** No gate, no importer, no receipt consults the report:
 *    a missing or edited `report.json` changes no verdict (the negative
 *    constraint of the mission: the report never becomes delivery evidence);
 *  - **`tokens` is never invented.** The host's subagent seam exposes no `usage`
 *    (`dsh-subagent` has no token fields at all), so the report says so with a
 *    fixed sentence. Estimating tokens from duration, or writing 0, would be a
 *    number nobody can check — the one thing a cost report must not do.
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

/** One task's entry in the economics segment (AC-001 of P3). */
export interface SplitEconomicsTask {
    id: string
    /** The task's wall time (includes its one-time worktree preparation). */
    durationMs: number
    /** The first (and only) preparation of this task's worktree, in ms. */
    prepareMs: number
    attempts: number
}

/** What the run's timing means (AC-001's three names, no others). */
export type SplitEconomicsVerdict = 'worth-parallel' | 'slower-than-serial' | 'unknown'

/**
 * The one sentence the report is allowed to say about tokens.
 *
 * Frozen on purpose: it is the answer to "how many tokens did this run cost",
 * and the honest answer is that the seam does not carry it.
 */
export const SPLIT_TOKENS_UNAVAILABLE = {
    state: 'unavailable' as const,
    reason: '宿主 subagent 接缝不暴露 usage',
}

/** The whole economics segment. */
export interface SplitEconomics {
    tasks: SplitEconomicsTask[]
    /** Σ each task's `durationMs` — what running the same work one-at-a-time costs. */
    serialEstimateMs: number
    /** Run start → finish (dispatch + merge/import/cleanup), from the run's clock. */
    wallClockMs: number
    /** `serialEstimateMs / wallClockMs`, two decimals (`null` = no wall clock to divide by). */
    speedup: number | null
    verdict: SplitEconomicsVerdict
    /** The numbers behind the verdict, in words (never a bare label). */
    reasons: string[]
    /** Never estimated, never zero: the host seam exposes no usage. */
    tokens: { state: 'unavailable'; reason: string }
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
    /** AC-001 of P3: whether the parallelism actually paid off (and what is unknown). */
    economics: SplitEconomics
}

/** Below this fraction of the serial estimate the parallel run is worth it. */
const WORTH_PARALLEL_RATIO = 0.9

/** Above this fraction of the serial estimate the parallel run was slower. */
const SLOWER_THAN_SERIAL_RATIO = 1.1

/** One task's duration from the book's clock (`0` when it never ran). */
function durationOf(task: SplitRunResult['tasks'][number]): number {
    if (task.startedAt === undefined || task.finishedAt === undefined) return 0
    return Math.max(0, task.finishedAt - task.startedAt)
}

/** `serial / wall` to two decimals (the report's own rounding rule). */
function speedupOf(serialMs: number, wallMs: number): number | null {
    if (wallMs <= 0) return null
    return Math.round((serialMs / wallMs) * 100) / 100
}

/** The verdict rule of AC-001, with its reasons. */
function verdictOf(input: { taskCount: number; started: number; serialMs: number; wallMs: number }): { verdict: SplitEconomicsVerdict; reasons: string[] } {
    if (input.taskCount === 0) return { verdict: 'unknown', reasons: ['plan 里没有子任务：没有可比较的耗时'] }
    if (input.started < 2) {
        return {
            verdict: 'unknown',
            reasons: [`实际执行 ${input.started} 个子任务（不到 2 个）：串行执行本来就没有并行收益，无法比较`],
        }
    }
    if (input.serialMs <= 0) return { verdict: 'unknown', reasons: ['串行估算为 0ms：没有可比较的耗时（时钟冻结或任务瞬时完成）'] }
    if (input.wallMs <= 0) return { verdict: 'unknown', reasons: ['墙钟为 0ms：无法计算 speedup'] }
    const worth = Math.round(input.serialMs * WORTH_PARALLEL_RATIO)
    const slower = Math.round(input.serialMs * SLOWER_THAN_SERIAL_RATIO)
    if (input.wallMs < worth) {
        return {
            verdict: 'worth-parallel',
            reasons: [`墙钟 ${input.wallMs}ms < 串行估算 ${input.serialMs}ms 的 90%（${worth}ms）：并行值得`],
        }
    }
    if (input.wallMs > slower) {
        return {
            verdict: 'slower-than-serial',
            reasons: [`墙钟 ${input.wallMs}ms > 串行估算 ${input.serialMs}ms 的 110%（${slower}ms）：并行反而更慢（准备/合并/导入开销吃掉了并行收益）`],
        }
    }
    return {
        verdict: 'unknown',
        reasons: [`墙钟 ${input.wallMs}ms 与串行估算 ${input.serialMs}ms 相差不到 10%/110%（${worth}..${slower}ms）：判定不了并行是否值得`],
    }
}

/**
 * Build the economics segment from the finished run.
 *
 * Per-task `durationMs`/`prepareMs`/`attempts` are repeated here (they also sit
 * in `tasks[]` for the P2 readers) so the segment answers "did parallel pay off"
 * on its own — and so adding it did not change the shape `tasks[]` already had.
 * @param book - the run state (its clock, its start and its end).
 * @param result - what the run reported.
 */
function buildEconomics(book: SplitRunBook, result: SplitRunResult): SplitEconomics {
    const tasks = result.tasks.map((task) => ({
        id: task.id,
        durationMs: durationOf(task),
        prepareMs: Math.max(0, task.prepareMs ?? 0),
        attempts: task.attempts,
    }))
    const serialEstimateMs = tasks.reduce((sum, task) => sum + task.durationMs, 0)
    const wallClockMs = Math.max(0, (book.finishedAt ?? book.now()) - book.at)
    const started = tasks.filter((task) => task.attempts > 0).length
    const verdict = verdictOf({ taskCount: tasks.length, started, serialMs: serialEstimateMs, wallMs: wallClockMs })
    const prepareTotalMs = tasks.reduce((sum, task) => sum + task.prepareMs, 0)
    return {
        tasks,
        serialEstimateMs,
        wallClockMs,
        speedup: speedupOf(serialEstimateMs, wallClockMs),
        verdict: verdict.verdict,
        reasons: [
            ...verdict.reasons,
            `串行估算 = 各子任务 durationMs 之和（其中 worktree prepare 合计 ${prepareTotalMs}ms）；墙钟 = run 开始到收尾（合并/导入/清理）结束`,
        ],
        tokens: { ...SPLIT_TOKENS_UNAVAILABLE },
    }
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
        economics: buildEconomics(book, result),
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

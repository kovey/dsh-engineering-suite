/**
 * Rework escalation at dispatch time (AC-011).
 *
 * The orchestrator dispatches one task at a time, so this is where the ratio
 * becomes a route: before the next child starts, the mission's rework ratio is
 * computed from the tasks the runner reported, written into
 * `split/rework.json` (the ratio and the threshold belong in the split report),
 * and the next task's model class is decided — worker normally, PLANNER above
 * `quality.maxReworkRatio`.
 *
 * It never stops the mission. A high rework ratio means the decomposition was
 * probably wrong, not that the work should be abandoned; the warning goes into
 * the mission's evidence ledger and the caller keeps dispatching. The same is
 * true of a MISSING planner model (P4 AC-002): the escalation degrades to the
 * worker class or the host default, and `split/rework.json` records the route
 * with the note 「无法升级到 planner：未配置，继续使用 …」.
 *
 * Per-task dispatch has no dedicated runner yet: this module IS the seam such a
 * runner (or the next round's task loop) calls, and its test pins the three
 * facts a dispatcher depends on — the ratio, the escalation, and the recorded
 * warning.
 *
 * @module dsh-orchestrator/split-rework
 */

import { MissionStore, type Layout } from 'dsh-eng-core'
import {
    computeRework,
    ratioText,
    renderReworkReport,
    routeForNextTask,
    writeSplitReworkReport,
    type ModelsConfig,
    type NextTaskRoute,
    type ReworkReport,
    type ReworkTaskInput,
} from 'dsh-eng-core/split'

/** What the dispatcher closes over. */
export interface NextSplitTaskInput {
    layout: Layout
    missionId: string
    /** The effective `models.json` (project file over profile over defaults). */
    models: ModelsConfig
    /** Each started task and the rework facts the runner observed. */
    tasks: readonly unknown[]
    /** Timestamp override (tests). */
    at?: number
}

/** The answer a dispatcher uses for the next task. */
export interface NextSplitTaskPlan {
    report: ReworkReport
    route: NextTaskRoute
    /** Absolute path of `split/rework.json`. */
    file: string
    /** Report lines (ratio, threshold, chosen model, missing configuration). */
    lines: string[]
    /** The escalation warning, when the threshold was exceeded. */
    warning?: string
    /** Problems recording the warning (never fatal: dispatch is not stopped). */
    problems: string[]
}

/** The model a route actually runs on, as one phrase (`provider/model` or the host default). */
function modelText(route: NextTaskRoute): string {
    if (route.model === undefined) return '宿主默认（请求省略 model/provider）'
    const model = `${route.provider === undefined ? '' : `${route.provider}/`}${route.model}`
    return route.fallback === 'worker' ? `${model}（worker 段，无法升级）` : model
}

/** The warning paragraph (also written to the mission's evidence ledger). */
function warningText(report: ReworkReport, route: NextTaskRoute): string {
    const head = `⚠️ 返工率 ${ratioText(report)} 超过阈值 ${report.threshold}`
    // P4 AC-002: "escalate, but there is no planner model" is a DEGRADATION, not a
    // stop — the note (from `routeForNextTask`) is the sentence an operator needs.
    if (route.note !== undefined) return `${head}：${route.note}（不中止，继续派发）`
    return `${head}：后续子任务升级到 planner 模型 ${modelText(route)}（不中止，继续派发）`
}

/** The numbers a later reader compares against the threshold. */
function reworkPayload(report: ReworkReport): Record<string, number | boolean> {
    return { started: report.started, reworked: report.reworked, ratio: report.ratio, threshold: report.threshold, escalate: report.escalate }
}

/** Record the warning as mission evidence; a failure is reported, never thrown. */
function recordWarning(store: MissionStore, missionId: string, warning: string, file: string, report: ReworkReport): string[] {
    try {
        store.appendEvidence(missionId, {
            kind: 'manual',
            summary: warning,
            recordedBy: 'dsh-orchestrator',
            artifactPath: file,
            data: { rework: reworkPayload(report) },
        })
        return []
    } catch (error) {
        return [`告警未能写入 mission ${missionId} 的证据账本（${(error as Error).message}）：拆分报告已落盘 ${file}`]
    }
}

/**
 * Decide the next task's model and record the ratio.
 *
 * @param input - layout, mission, effective models and the per-task outcomes.
 * @returns the report, the route, the artifact path and the lines to show.
 */
export function planNextSplitTask(input: NextSplitTaskInput): NextSplitTaskPlan {
    const report = computeRework({ tasks: input.tasks as readonly ReworkTaskInput[], threshold: input.models.quality.maxReworkRatio })
    // The route is decided BEFORE the file is written: "escalation without a
    // planner model" belongs in `split/rework.json`, not only in the report lines.
    const route = routeForNextTask(report, input.models)
    const { file } = writeSplitReworkReport(input.layout, input.missionId, report, input.at, route)
    const problems: string[] = []
    const lines = [
        renderReworkReport(report),
        `下一个子任务模型：${route.modelClass} → ${modelText(route)}`,
        ...route.problems.map((problem) => `- ${problem}`),
    ]
    if (!report.escalate) return { report, route, file, lines, problems }
    const warning = warningText(report, route)
    problems.push(...recordWarning(new MissionStore({ layout: input.layout }), input.missionId, warning, file, report))
    return { report, route, file, lines: [...lines, warning], warning, problems }
}

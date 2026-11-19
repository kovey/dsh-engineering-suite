/**
 * The rework ratio and the escalation it triggers (AC-011).
 *
 * 返工率 = 需要重做的子任务数 ÷ 已开始子任务数. A task counts as reworked when the
 * caller marks it — a merge conflict, a failed acceptance check, a gate that
 * rolled the work back, or a worker stopped at `split.taskTimeoutMs` (AC-003)
 * are the facts that mean "this task was done twice / never finished". The
 * caller supplies them because only the runner sees them; this module does not
 * guess from commit messages.
 *
 * Above `quality.maxReworkRatio` the mission is NOT stopped: the remaining tasks
 * are dispatched on the PLANNER model instead, because the failures are usually a
 * sign that the decomposition was wrong rather than that the workers were lazy.
 * That decision is {@link routeForNextTask} — pure, so the orchestrator can show
 * the exact route before starting a child.
 *
 * `split/rework.json` is the durable record of the ratio and the threshold
 * (AC-011 asks for them in the mission's split report), written by
 * {@link writeSplitReworkReport}.
 *
 * @module dsh-eng-core/rework
 */

import path from 'node:path'
import { writeJsonAtomic } from './io.js'
import { DEFAULT_MODELS_CONFIG, type ModelClassConfig } from './models.js'
import { missionDir, type Layout } from './paths.js'

/** The four facts that mean "this task had to be done again". */
export type ReworkSignal = 'merge-conflict' | 'acceptance-failed' | 'gate-rollback' | 'timeout'

/** Every signal, in report order. */
export const REWORK_SIGNALS: readonly ReworkSignal[] = ['merge-conflict', 'acceptance-failed', 'gate-rollback', 'timeout']

/** One-line label per signal (Chinese, for reports). */
export const REWORK_SIGNAL_LABEL: Record<ReworkSignal, string> = {
    'merge-conflict': '合并冲突',
    'acceptance-failed': '验收不过',
    'gate-rollback': '门禁回退',
    // AC-003: a worker that ran past `split.taskTimeoutMs` was stopped, not
    // finished — the worktree and its local ledger stay behind for the import
    // and cleanup steps, and the ratio counts it as rework.
    timeout: '派发超时',
}

/** One task's outcome as the caller observed it. */
export interface ReworkTaskInput {
    id: string
    /** `false` = never started; such a task is in neither side of the ratio. */
    started?: boolean
    /** Explicit "this one was redone" marker. */
    reworked?: boolean
    /** Signals observed for this task (any of them implies reworked). */
    signals?: readonly string[]
}

/** One task's verdict inside the report. */
export interface ReworkTaskVerdict {
    id: string
    reworked: boolean
    signals: ReworkSignal[]
}

/** The computed ratio plus the escalation decision. */
export interface ReworkReport {
    started: number
    reworked: number
    /** `reworked / started`, or 0 when nothing started. */
    ratio: number
    threshold: number
    /** `ratio > threshold` — equality does NOT exceed. */
    exceeded: boolean
    /** Same as {@link exceeded}: above the threshold later tasks use planner. */
    escalate: boolean
    tasks: ReworkTaskVerdict[]
    /** Malformed input (named, never guessed). */
    problems: string[]
}

/** The model one next task should run on. */
export interface NextTaskRoute {
    modelClass: 'planner' | 'worker'
    provider?: string
    model?: string
    reasoningEffort?: string
    /** `true` when the rework ratio switched this task to the planner model. */
    escalated: boolean
    /** Missing class configuration — reported, never replaced by a host default. */
    problems: string[]
}

/** The known signals of one task (unknown names are reported as problems). */
function signalsOf(raw: readonly string[] | undefined, taskId: string, problems: string[]): ReworkSignal[] {
    const out: ReworkSignal[] = []
    for (const entry of raw ?? []) {
        const signal = REWORK_SIGNALS.find((known) => known === entry)
        if (signal === undefined) problems.push(`子任务 ${taskId} 的重做标记 ${JSON.stringify(entry)} 不是已知信号（可用：${REWORK_SIGNALS.join(' / ')}），已忽略`)
        else if (!out.includes(signal)) out.push(signal)
    }
    return out
}

/** Read one task entry (a bad entry is named and skipped, never guessed). */
function verdictOf(raw: unknown, index: number, problems: string[]): ReworkTaskVerdict | undefined {
    if (typeof raw !== 'object' || raw === null) {
        problems.push(`tasks[${index}] 必须是对象（收到 ${JSON.stringify(raw)}），已跳过`)
        return undefined
    }
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    if (id === '') {
        problems.push(`tasks[${index}].id 必须是非空字符串，已跳过`)
        return undefined
    }
    if (record['started'] !== undefined && typeof record['started'] !== 'boolean') {
        problems.push(`子任务 ${id} 的 started 必须是布尔值（收到 ${JSON.stringify(record['started'])}），按已开始处理`)
    }
    if (record['reworked'] !== undefined && typeof record['reworked'] !== 'boolean') {
        problems.push(`子任务 ${id} 的 reworked 必须是布尔值（收到 ${JSON.stringify(record['reworked'])}），按未重做处理`)
    }
    const rawSignals = record['signals']
    if (rawSignals !== undefined && !Array.isArray(rawSignals)) problems.push(`子任务 ${id} 的 signals 必须是字符串数组，已忽略`)
    const signalList = Array.isArray(rawSignals) ? rawSignals : []
    const notStrings = signalList.filter((entry) => typeof entry !== 'string')
    if (notStrings.length > 0) problems.push(`子任务 ${id} 的 signals 里有非字符串项 ${JSON.stringify(notStrings)}，已忽略`)
    const signals = signalsOf(
        signalList.filter((entry): entry is string => typeof entry === 'string'),
        id,
        problems,
    )
    return { id, reworked: record['reworked'] === true || signals.length > 0, signals }
}

/**
 * Compute the rework ratio and whether it exceeds the threshold.
 *
 * @param input - the started tasks with their rework markers; `threshold`
 *   defaults to the documented built-in `quality.maxReworkRatio` (0.3) when the
 *   caller does not have the project's `models.json` at hand.
 * @returns the counts, the exact ratio, the verdict, and every malformed entry.
 */
export function computeRework(input: { tasks: readonly unknown[]; threshold?: number }): ReworkReport {
    const problems: string[] = []
    let threshold = input.threshold ?? DEFAULT_MODELS_CONFIG.quality.maxReworkRatio
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
        problems.push(`maxReworkRatio=${JSON.stringify(input.threshold)} 不是非负数字：无法判定是否超阈值（按 0 处理，任何返工都会升级）`)
        threshold = 0
    }
    const entries: { verdict: ReworkTaskVerdict; started: boolean }[] = []
    input.tasks.forEach((task, index) => {
        const verdict = verdictOf(task, index, problems)
        if (verdict === undefined) return
        entries.push({ verdict, started: (task as { started?: unknown }).started !== false })
    })
    const startedEntries = entries.filter((entry) => entry.started)
    const reworked = startedEntries.filter((entry) => entry.verdict.reworked).length
    const ratio = startedEntries.length === 0 ? 0 : reworked / startedEntries.length
    const exceeded = ratio > threshold
    return {
        started: startedEntries.length,
        reworked,
        ratio,
        threshold,
        exceeded,
        escalate: exceeded,
        tasks: entries.map((entry) => entry.verdict),
        problems,
    }
}

/** The route one model class declares, or the reasons it declares none. */
function classRoute(config: ModelClassConfig | undefined): { provider?: string; model?: string; reasoningEffort?: string } {
    const model = config?.model
    if (model === undefined || model === '') return {}
    const slash = model.indexOf('/')
    return {
        ...(slash > 0 ? { provider: model.slice(0, slash) } : (config?.provider === undefined ? {} : { provider: config.provider })),
        model: slash > 0 ? model.slice(slash + 1) : model,
        ...(config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
}

/**
 * Which model the NEXT task runs on (AC-011's "switch to planner, do not stop").
 *
 * @param report - the computed rework report.
 * @param models - the effective `models.json` (planner/worker classes).
 * @returns the chosen class, its route, and the problems that made it
 *   unroutable (a missing panel is named, never replaced by a host default).
 */
export function routeForNextTask(
    report: Pick<ReworkReport, 'escalate'>,
    models: { planner?: ModelClassConfig; worker?: ModelClassConfig },
): NextTaskRoute {
    const modelClass = report.escalate ? ('planner' as const) : ('worker' as const)
    const route = classRoute(models[modelClass])
    const problems: string[] = []
    if (route.model === undefined) problems.push(`${modelClass} 段没有配置 model：${report.escalate ? '无法把后续子任务升级到 planner 模型' : '后续子任务没有可用的 worker 模型'}（不会回退宿主默认）`)
    return { modelClass, escalated: report.escalate, ...route, problems }
}

/** `missions/<id>/split/rework.json` — the durable ratio record. */
export function splitReworkFile(layout: Layout, missionId: string): string {
    return path.join(missionDir(layout, missionId), 'split', 'rework.json')
}

/**
 * Write the rework report into the mission's split artifacts.
 * @param layout - workspace layout.
 * @param missionId - the mission the tasks belong to.
 * @param report - the computed report.
 * @param at - timestamp override (tests).
 * @returns the file written.
 */
export function writeSplitReworkReport(layout: Layout, missionId: string, report: ReworkReport, at: number = Date.now()): { file: string } {
    const file = splitReworkFile(layout, missionId)
    writeJsonAtomic(file, { missionId, at, ...report })
    return { file }
}

/** One-line ratio text (`1/3 = 0.333`). */
export function ratioText(report: Pick<ReworkReport, 'started' | 'reworked' | 'ratio'>): string {
    return `${report.reworked}/${report.started} = ${report.ratio.toFixed(3)}`
}

/**
 * The human summary of one report (used by the orchestrator's report lines).
 * @param report - the computed report.
 */
export function renderReworkReport(report: ReworkReport): string {
    const verdict = report.exceeded
        ? `超过阈值 ${report.threshold}：后续子任务升级到 planner 模型（不中止）`
        : `未超过阈值 ${report.threshold}（等于阈值也不算超）`
    return [`返工率 ${ratioText(report)}，${verdict}`, ...report.problems.map((problem) => `- ${problem}`)].join('\n')
}

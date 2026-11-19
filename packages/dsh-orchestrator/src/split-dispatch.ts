/**
 * Where the split workflow becomes PRODUCTION: entering `implement` RUNS the plan.
 *
 * The runner (`split-runner.ts`) is a library; this module is the one call site
 * that makes it happen without a model in the loop. It answers four questions
 * before delegating anything, and every "no" has its own outcome:
 *
 *  - Is the split workflow enabled (`config.split.enabled`)? No → plain
 *    `implement`, exactly as before (returns `undefined`, so the ordinary stage
 *    dispatch runs).
 *  - Is this the stage whose entry gate is `split-reviewed` (i.e. `implement`)?
 *    No → plain dispatch.
 *  - Is there a plan on disk, and is it STILL the reviewed one? A stale/rejected/
 *    missing review is a refusal — never a fallthrough, because falling through
 *    would let the plain `implement` path do work the plan was supposed to split
 *    (and the negative constraint says no worker runs on an unreviewed split).
 *  - Is splitting worth it (AC-005)? `not-worth-splitting` / `too-large` → plain
 *    `implement`; the split gate already recorded that verdict.
 *
 * Not gated by `autoDispatch.enabled` on purpose: enabling `split` IS the
 * deployment decision to dispatch workers, and requiring a second switch would
 * leave the feature dead by default. It is still "dispatch ≠ settlement": the
 * `implement` stage remains `entered` until its exit gate passes, and the receipt
 * is the lead's (AC-010).
 *
 * @module dsh-orchestrator/split-dispatch
 */

import { resolveLayout, type AgentLike, type MissionRecord } from 'dsh-eng-core'
import { decideSplit, loadModelsConfig, readSplitPlan, splitMaxAttempts, splitReviewStatus } from 'dsh-eng-core/split'
import type { DispatchDeps, DispatchOutcome } from './dispatch.js'
import type { StageConfig } from './pipeline.js'
import { runSplitPlan } from './split-runner.js'
import type { SplitRunResult } from './split-run-types.js'

/** What the dispatcher already knows about the stage it is entering. */
export interface SplitDispatchInput {
    stage: StageConfig
    mission: MissionRecord
    cwd: string
    agent?: AgentLike
    signal?: AbortSignal
    attempt?: number
}

/** The model classes the run actually used, as one report phrase. */
function describeRoutes(result: SplitRunResult): string {
    const used = result.tasks
        .filter((task) => task.attempts > 0)
        .map((task) => (task.model === undefined ? `${task.modelClass ?? 'worker'}=宿主默认` : `${task.modelClass}=${task.provider === undefined ? '' : `${task.provider}/`}${task.model}`))
    return used.length === 0 ? '(没有启动 worker)' : [...new Set(used)].join('、')
}

/** One line per task (`T-001 done`), so the report says who did what. */
function describeTasks(result: SplitRunResult): string {
    return result.tasks.map((task) => `${task.id} ${task.state}`).join('、') || '(没有子任务)'
}

/**
 * The per-worker deadline of this run (AC-003).
 *
 * Precedence: the project's `models.json` (`split.taskTimeoutMs`), then the
 * host's `autoDispatch.timeoutMs`, then the documented 600000. The chain lives
 * HERE because only this module sees both configurations; `models.ts` cannot
 * express "follow the host" without pinning a value.
 */
export function splitTaskTimeoutMs(config: DispatchDeps['config'], models: { split: { taskTimeoutMs?: number } }): number {
    const usable = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
    // An unusable project value falls to the NEXT layer (the host), not straight
    // to the built-in default: a hand-wired `0` must not discard a configured
    // 90s deadline just because the project layer said something wrong.
    return usable(models.split.taskTimeoutMs) ?? usable(config.autoDispatch?.timeoutMs) ?? 600_000
}

/**
 * Turn a run result into the stage dispatcher's outcome (never a settlement).
 *
 * The per-task detail and the rework numbers live in `split/run.json`
 * (`outputFile`); the report carries one compact line so a stage entry does not
 * turn into a wall of text.
 */
function outcomeOf(result: SplitRunResult, modelProblems: readonly string[], deadline: { timeoutMs: number; maxAttempts: number }): DispatchOutcome {
    const modelNotes = modelProblems.length === 0 ? '' : `；models.json 有 ${modelProblems.length} 条回退/忽略（首条：${modelProblems[0] ?? ''}）`
    if (result.state === 'refused') {
        return {
            dispatched: false,
            note: [`拆分派发未执行：${result.problems[0] ?? '派发前提不成立'}`, ...(result.file === undefined ? [] : [`记录：${result.file}`])].join('\n'),
        }
    }
    const headline = `拆分派发：${result.tasks.length} 个子任务（${describeTasks(result)}），导入 ${result.imported} 条证据，返工率 ${result.rework.reworked}/${result.rework.started} = ${result.rework.ratio.toFixed(3)}（阈值 ${result.rework.threshold}${result.rework.escalate ? '，已超阈值：后续子任务按 planner 模型路由' : ''}）`
    // P4 AC-001: a missing model class rides along as a note, not as an error —
    // the summary a person reads must say "host default" instead of nothing.
    const fallbackNotes = result.modelNotes.length === 0 ? '' : `；模型回退：${result.modelNotes.join('；')}`
    return {
        dispatched: true,
        runId: `split-${(result.planDigest ?? '').slice(0, 12) || 'plan'}`,
        ...(result.file === undefined ? {} : { outputFile: result.file }),
        stopReason: result.ok ? 'completed' : 'error',
        roleNote: `${headline}；每个子任务一个 worktree + worker 角色（模型 ${describeRoutes(result)}；单任务超时 ${deadline.timeoutMs}ms、重试上限 ${deadline.maxAttempts} 次；orchestrate 已从 worker 作用域剔除）${modelNotes}${fallbackNotes}`,
        ...(result.ok ? {} : { error: result.problems.length === 0 ? '部分子任务未完成（见 run.json）' : result.problems.join('；') }),
    }
}

/**
 * Run the reviewed split plan when this stage entry is the one that should.
 *
 * @param deps - the dispatcher's deps (config, subagents, role-guard, presets).
 * @param input - the stage being entered, the mission and the caller's context.
 * @returns the outcome to report, or `undefined` to let the ordinary stage
 *   dispatch run (plain `implement`).
 */
export async function splitDispatch(deps: DispatchDeps, input: SplitDispatchInput): Promise<DispatchOutcome | undefined> {
    // `?.` on purpose: a hand-wired dispatch deps (a unit test, an older
    // embedding that predates the split workflow) has no `split` section at all,
    // and that must mean "not enabled", never a crash in the dispatcher.
    if (deps.config.split?.enabled !== true) return undefined
    if (input.stage.gate.kind !== 'split-reviewed') return undefined
    const layout = resolveLayout(input.cwd, deps.config.layout)
    const stored = readSplitPlan(layout, input.mission.id)
    if (stored === undefined) return undefined
    const review = splitReviewStatus(layout, input.mission.id)
    if (!review.ok) {
        return { dispatched: false, note: `拆分派发未执行：${review.detail}（未经审核的拆分不允许派发 worker）` }
    }
    const models = loadModelsConfig(layout, { profile: deps.config.split.models })
    if (decideSplit(stored.plan, models.config.split).decision !== 'split') return undefined
    const taskTimeoutMs = splitTaskTimeoutMs(deps.config, models.config)
    const result = await runSplitPlan({
        layout,
        missionId: input.mission.id,
        cwd: input.cwd,
        plan: stored.plan,
        models: models.config,
        maxParallel: models.config.split.maxParallel,
        ...(deps.subagents() === undefined ? {} : { subagents: deps.subagents() }),
        ...(deps.presets === undefined ? {} : { presets: deps.presets }),
        ...(deps.roleGuard === undefined ? {} : { roleGuard: deps.roleGuard }),
        provider: deps.config.autoDispatch.provider,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        maxDepth: deps.config.autoDispatch.maxDepth,
        taskTimeoutMs,
    })
    const outcome = outcomeOf(result, models.problems, { timeoutMs: taskTimeoutMs, maxAttempts: splitMaxAttempts(models.config.split) })
    // The attempt rides along like it does for the ordinary stage dispatch, so the
    // stage artifact names which entry produced this run.
    return input.attempt === undefined ? outcome : { ...outcome, attempt: input.attempt }
}

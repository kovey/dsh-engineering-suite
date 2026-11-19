/**
 * The AC-005 threshold: is this plan worth splitting at all, or is it too big
 * for one mission?
 *
 * Two exits, and both are answers rather than errors: `not-worth-splitting`
 * sends the work down the plain `implement` path (no worktrees, no workers),
 * while `too-large` refuses and says the real fix out loud — split the work into
 * several missions. The numbers come from `models.json` (`split.maxTasks`,
 * `split.maxParallel`), so "too big" is a statement about this repository.
 *
 * @module dsh-eng-core/split-threshold
 */

import type { SplitSettings } from './models.js'
import type { SplitPlan, SplitTask } from './split-plan.js'

/** Whether splitting is worth doing, or has to be refused. */
export type SplitDecision = 'split' | 'not-worth-splitting' | 'too-large'

/** The threshold verdict plus every reason that produced it. */
export interface SplitDecisionResult {
    decision: SplitDecision
    reasons: string[]
}

/** Whether every task owns exactly the same (normalised) set of paths. */
function allPathsIdentical(tasks: readonly SplitTask[]): boolean {
    const signatures = tasks.map((task) =>
        [...new Set(task.paths.map((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '')))].sort().join('\n'),
    )
    return signatures.every((signature) => signature === signatures[0])
}

/**
 * The AC-005 threshold.
 *
 * Order matters: a plan nobody should split at all gets that answer before the
 * size limit, because "split it into missions" is the wrong advice for nine
 * tasks that all touch the same files.
 * @param plan - the plan (its three checks are validated separately).
 * @param settings - `models.json` split settings (`maxTasks`, `maxParallel`).
 */
export function decideSplit(plan: SplitPlan, settings: SplitSettings): SplitDecisionResult {
    const tasks = plan.tasks
    if (tasks.length < 2) {
        return { decision: 'not-worth-splitting', reasons: [`只有 ${tasks.length} 条子任务（少于 2 条）：不值得拆分成并行任务`] }
    }
    if (allPathsIdentical(tasks)) {
        return {
            decision: 'not-worth-splitting',
            reasons: [`全部 ${tasks.length} 条子任务的路径完全相同（${tasks[0]?.paths.join('、') ?? '(空)'}）：拆开也会互相冲突，不值得拆`],
        }
    }
    if (tasks.length > settings.maxTasks) {
        return {
            decision: 'too-large',
            reasons: [`子任务数 ${tasks.length} 超过 maxTasks=${settings.maxTasks}：这项任务太大，应当拆成多个 mission`],
        }
    }
    const oversized = plan.parallelGroups.find((group) => group.length > settings.maxParallel)
    if (oversized !== undefined) {
        return {
            decision: 'too-large',
            reasons: [`并行组 [${oversized.join('、')}] 的规模 ${oversized.length} 超过 maxParallel=${settings.maxParallel}：应当拆成多个 mission`],
        }
    }
    return { decision: 'split', reasons: [`${tasks.length} 条子任务、${plan.parallelGroups.length} 个并行组：可拆分`] }
}

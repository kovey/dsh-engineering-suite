/**
 * Check 2 of a split plan: no two tasks of one parallel group may own the same
 * path (AC-004).
 *
 * Split out of `split-validate.ts` for the repository's `maxFileLines` ratchet —
 * that module was exactly at its ceiling when the per-task AC budget landed, and
 * the overlap family is the one self-contained part of it (a pure comparison of
 * path patterns). It is deliberately dependency-free: the functions take the
 * minimal task shape and return `{ code: 'paths-overlap', … }` objects instead
 * of importing `SplitProblem` from the validator, so the two modules never form
 * an import cycle.
 *
 * @module dsh-eng-core/split-overlap
 */

import { pathMatchesPattern } from './paths.js'

/** The only fields of a plan task this check reads. */
export interface OverlapTask {
    id: string
    paths: string[]
}

/** One overlapping pair, shaped like the validator's `SplitProblem`. */
export interface OverlapProblem {
    code: 'paths-overlap'
    taskId: string
    detail: string
}

/**
 * Whether two path patterns can address the same file.
 *
 * Both directions are tried, plus directory containment. NECESSARY, not a proof:
 * globs that intersect without either matching the other's literal text are not
 * provably disjoint (and not provably overlapping either), so they are allowed.
 */
export function pathsOverlap(left: string, right: string): boolean {
    const a = left.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const b = right.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (a === '' || b === '') return false
    if (a === b) return true
    return pathMatchesPattern(a, b) || pathMatchesPattern(b, a)
}

/** Every overlapping path pair between two tasks (`a ↔ b` strings). */
function conflictsOf(first: OverlapTask, second: OverlapTask): string[] {
    const conflicts: string[] = []
    for (const one of first.paths) {
        for (const other of second.paths) {
            if (pathsOverlap(one, other)) conflicts.push(`${one} ↔ ${other}`)
        }
    }
    return conflicts
}

/** The check-2 problems of one pair of tasks. */
function overlapProblems(first: OverlapTask, second: OverlapTask, groupIndex: number): OverlapProblem[] {
    return conflictsOf(first, second).map((conflict) => ({
        code: 'paths-overlap' as const,
        taskId: first.id,
        detail: `并行组 ${groupIndex} 内子任务 ${first.id} 与 ${second.id} 的路径重叠：${conflict}`,
    }))
}

/** Check-2 problems of one parallel group. */
function groupConflicts(group: readonly string[], index: number, byId: ReadonlyMap<string, OverlapTask>): OverlapProblem[] {
    const problems: OverlapProblem[] = []
    const tasks = group.map((id) => byId.get(id)).filter((task): task is OverlapTask => task !== undefined)
    for (let left = 0; left < tasks.length; left += 1) {
        const first = tasks[left] as OverlapTask
        for (let right = left + 1; right < tasks.length; right += 1) {
            problems.push(...overlapProblems(first, tasks[right] as OverlapTask, index))
        }
    }
    return problems
}

/**
 * Check 2: no two tasks of one parallel group own the same path.
 * @param groups - the plan's parallel groups (task ids).
 * @param byId - every task of the plan, by id.
 * @returns one problem per overlapping pair, naming both tasks and both paths.
 */
export function groupOverlapProblems(groups: readonly (readonly string[])[], byId: ReadonlyMap<string, OverlapTask>): OverlapProblem[] {
    return groups.flatMap((group, index) => groupConflicts(group, index, byId))
}

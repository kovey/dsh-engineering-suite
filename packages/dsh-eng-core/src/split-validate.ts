/**
 * The three automatic checks of a split plan (AC-004).
 *
 * They are the gate in front of the HUMAN review: a plan that does not map every
 * task to a real acceptance criterion, that puts overlapping paths in one
 * parallel group, or that leaves a criterion uncovered is never shown to a
 * reviewer. They are structural on purpose — "is this a good decomposition" is
 * the reviewer's question, not this module's. The threshold decision lives in
 * `split-threshold.ts`; every function here is pure.
 *
 * @module dsh-eng-core/split-validate
 */

import { pathMatchesPattern } from './paths.js'
import type { SplitPlan, SplitTask } from './split-plan.js'

/** Why one plan is not sendable for review. */
export type SplitProblemCode =
    | 'shape'
    | 'task-without-ac'
    | 'unknown-ac'
    | 'paths-overlap'
    | 'ac-uncovered'
    | 'unknown-task'
    | 'dependency'
/** One concrete problem, addressed at the task or criterion it concerns. */
export interface SplitProblem {
    code: SplitProblemCode
    /** Task this problem belongs to, when it belongs to one. */
    taskId?: string
    /** Chinese, one line, naming ids and paths (never "invalid plan"). */
    detail: string
}

/** The verdict of {@link validateSplitPlan}. */
export interface SplitValidation {
    ok: boolean
    problems: SplitProblem[]
    /** Acceptance criteria some task covers, sorted. */
    covered: string[]
    /** Specification criteria nothing covers, sorted. */
    uncovered: string[]
}

/** Acceptance criterion ids of a specification (objects or plain strings). */
function specCriteriaOf(spec: unknown): string[] {
    if (typeof spec !== 'object' || spec === null) return []
    const raw = (spec as { acceptanceCriteria?: unknown }).acceptanceCriteria
    if (!Array.isArray(raw)) return []
    const ids: string[] = []
    for (const entry of raw) {
        if (typeof entry === 'string' && entry.trim() !== '') ids.push(entry.trim())
        else if (typeof entry === 'object' && entry !== null) {
            const id = (entry as { id?: unknown }).id
            if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim())
        }
    }
    return [...new Set(ids)].sort()
}
/** A string array, or `undefined` when the value is not one. */
function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const out: string[] = []
    for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim() === '') return undefined
        out.push(entry.trim())
    }
    return out
}

/** Read one task; `undefined` when its shape is unusable (reported by the caller). */
function readTask(raw: unknown, index: number, problems: SplitProblem[]): SplitTask | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        problems.push({ code: 'shape', detail: `tasks[${index}] 必须是对象` })
        return undefined
    }
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    if (id === '') {
        problems.push({ code: 'shape', detail: `tasks[${index}].id 必须是非空字符串` })
        return undefined
    }
    const paths = stringArray(record['paths'])
    const acceptance = stringArray(record['acceptance'])
    const dependsOn = stringArray(record['dependsOn'])
    if (paths === undefined) problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 的 paths 必须是非空字符串数组` })
    if (acceptance === undefined) problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 的 acceptance 必须是字符串数组` })
    if (dependsOn === undefined) problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 的 dependsOn 必须是字符串数组` })
    const parallel = record['parallel']
    if (typeof parallel !== 'boolean') problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 的 parallel 必须是布尔值` })
    return {
        id,
        goal: typeof record['goal'] === 'string' ? record['goal'] : '',
        paths: paths ?? [],
        acceptance: acceptance ?? [],
        dependsOn: dependsOn ?? [],
        parallel: parallel === true,
    }
}

/** Read the task list (invalid entries are reported and skipped). */
function readTasks(raw: unknown, problems: SplitProblem[]): SplitTask[] {
    if (!Array.isArray(raw)) {
        problems.push({ code: 'shape', detail: 'plan.tasks 必须是数组' })
        return []
    }
    const tasks: SplitTask[] = []
    const seen = new Set<string>()
    for (let index = 0; index < raw.length; index += 1) {
        const task = readTask(raw[index], index, problems)
        if (task === undefined) continue
        if (seen.has(task.id)) {
            problems.push({ code: 'shape', taskId: task.id, detail: `子任务 id 重复：${task.id}` })
            continue
        }
        seen.add(task.id)
        tasks.push(task)
    }
    return tasks
}

/** Read the parallel groups; unknown/duplicated task ids are shape problems. */
function readGroups(raw: unknown, taskIds: ReadonlySet<string>, problems: SplitProblem[]): string[][] {
    if (!Array.isArray(raw)) {
        problems.push({ code: 'shape', detail: 'plan.parallelGroups 必须是二维数组' })
        return []
    }
    const groups: string[][] = []
    const placed = new Set<string>()
    raw.forEach((group, index) => {
        const ids = stringArray(group)
        if (ids === undefined) {
            problems.push({ code: 'shape', detail: `parallelGroups[${index}] 必须是任务 id 数组` })
            return
        }
        for (const id of ids) {
            if (!taskIds.has(id)) problems.push({ code: 'unknown-task', detail: `并行组 ${index} 引用了不存在的子任务 ${id}` })
            if (placed.has(id)) problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 出现在多个并行组里（同一时刻只能属于一组）` })
            placed.add(id)
        }
        groups.push(ids)
    })
    for (const id of taskIds) {
        if (!placed.has(id)) problems.push({ code: 'shape', taskId: id, detail: `子任务 ${id} 没有出现在任何并行组里` })
    }
    return groups
}

/** Read the coverage map; references are checked against tasks and criteria. */
function readCoverage(
    raw: unknown,
    taskIds: ReadonlySet<string>,
    criteria: readonly string[],
    problems: SplitProblem[],
): Record<string, string[]> {
    if (raw === undefined) return {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        problems.push({ code: 'shape', detail: 'plan.coverage 必须是 { 验收标准: [任务 id] } 对象' })
        return {}
    }
    const coverage: Record<string, string[]> = {}
    for (const [criterion, value] of Object.entries(raw as Record<string, unknown>)) {
        const ids = stringArray(value)
        if (ids === undefined) {
            problems.push({ code: 'shape', detail: `coverage["${criterion}"] 必须是任务 id 数组` })
            continue
        }
        if (!criteria.includes(criterion)) problems.push({ code: 'unknown-ac', detail: `coverage 引用了规格里不存在的验收标准 ${criterion}` })
        for (const id of ids) {
            if (!taskIds.has(id)) problems.push({ code: 'unknown-task', detail: `coverage["${criterion}"] 引用了不存在的子任务 ${id}` })
        }
        coverage[criterion] = ids
    }
    return coverage
}

/** AC-004 check 1 for one task: at least one criterion, all of them real. */
function checkTaskCriteria(task: SplitTask, criteria: readonly string[], problems: SplitProblem[]): void {
    if (task.acceptance.length === 0) {
        problems.push({ code: 'task-without-ac', taskId: task.id, detail: `子任务 ${task.id} 没有映射任何验收标准（acceptance 为空）` })
    }
    for (const criterion of task.acceptance) {
        if (!criteria.includes(criterion)) {
            problems.push({ code: 'unknown-ac', taskId: task.id, detail: `子任务 ${task.id} 映射了规格里不存在的验收标准 ${criterion}` })
        }
    }
}

/** One task's `dependsOn` must name tasks of the same plan. */
function checkDependencies(task: SplitTask, ids: ReadonlySet<string>, problems: SplitProblem[]): void {
    for (const dependency of task.dependsOn) {
        if (!ids.has(dependency)) {
            problems.push({ code: 'dependency', taskId: task.id, detail: `子任务 ${task.id} 的 dependsOn 引用了不存在的子任务 ${dependency}` })
        }
    }
}
/** AC-004 check 1: every task maps at least one criterion that really exists. */
function checkTaskAcceptance(tasks: readonly SplitTask[], criteria: readonly string[], problems: SplitProblem[]): void {
    const ids = new Set(tasks.map((task) => task.id))
    for (const task of tasks) {
        checkTaskCriteria(task, criteria, problems)
        checkDependencies(task, ids, problems)
    }
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
function conflictsOf(first: SplitTask, second: SplitTask): string[] {
    const conflicts: string[] = []
    for (const one of first.paths) {
        for (const other of second.paths) {
            if (pathsOverlap(one, other)) conflicts.push(`${one} ↔ ${other}`)
        }
    }
    return conflicts
}

/** The AC-004 check-2 problems of one pair of tasks. */
function overlapProblems(first: SplitTask, second: SplitTask, groupIndex: number): SplitProblem[] {
    return conflictsOf(first, second).map((conflict) => ({
        code: 'paths-overlap' as const,
        taskId: first.id,
        detail: `并行组 ${groupIndex} 内子任务 ${first.id} 与 ${second.id} 的路径重叠：${conflict}`,
    }))
}

/** AC-004 check 2 problems of one parallel group. */
function groupConflicts(group: readonly string[], index: number, byId: ReadonlyMap<string, SplitTask>): SplitProblem[] {
    const problems: SplitProblem[] = []
    const tasks = group.map((id) => byId.get(id)).filter((task): task is SplitTask => task !== undefined)
    for (let left = 0; left < tasks.length; left += 1) {
        const first = tasks[left] as SplitTask
        for (let right = left + 1; right < tasks.length; right += 1) {
            problems.push(...overlapProblems(first, tasks[right] as SplitTask, index))
        }
    }
    return problems
}

/** AC-004 check 2: no two tasks of one parallel group own the same path. */
function checkGroupPaths(groups: readonly (readonly string[])[], byId: ReadonlyMap<string, SplitTask>, problems: SplitProblem[]): void {
    groups.forEach((group, index) => problems.push(...groupConflicts(group, index, byId)))
}

/** AC-004 check 3: every specification criterion is covered by some task. */
function checkCoverage(
    tasks: readonly SplitTask[],
    coverage: Readonly<Record<string, string[]>>,
    criteria: readonly string[],
    problems: SplitProblem[],
): { covered: string[]; uncovered: string[] } {
    const covered = new Set<string>()
    for (const task of tasks) for (const criterion of task.acceptance) if (criteria.includes(criterion)) covered.add(criterion)
    for (const [criterion, ids] of Object.entries(coverage)) {
        if (criteria.includes(criterion) && ids.length > 0) covered.add(criterion)
    }
    const uncovered = criteria.filter((criterion) => !covered.has(criterion))
    for (const criterion of uncovered) {
        problems.push({ code: 'ac-uncovered', detail: `规格中的验收标准 ${criterion} 没有被任何子任务覆盖` })
    }
    return { covered: [...covered].sort(), uncovered }
}

/**
 * Run the three automatic checks of AC-004.
 *
 * @param plan - the plan as read from disk (untrusted).
 * @param spec - the mission specification (`{ acceptanceCriteria }`).
 * @returns `ok` only when all three checks pass, plus every problem found.
 */
export function validateSplitPlan(plan: unknown, spec: unknown): SplitValidation {
    const problems: SplitProblem[] = []
    const criteria = specCriteriaOf(spec)
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
        return { ok: false, problems: [{ code: 'shape', detail: 'plan 必须是对象' }], covered: [], uncovered: criteria }
    }
    const record = plan as Record<string, unknown>
    const tasks = readTasks(record['tasks'], problems)
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const groups = readGroups(record['parallelGroups'], new Set(byId.keys()), problems)
    const coverage = readCoverage(record['coverage'], new Set(byId.keys()), criteria, problems)
    checkTaskAcceptance(tasks, criteria, problems)
    checkGroupPaths(groups, byId, problems)
    const { covered, uncovered } = checkCoverage(tasks, coverage, criteria, problems)
    return { ok: problems.length === 0, problems, covered, uncovered }
}

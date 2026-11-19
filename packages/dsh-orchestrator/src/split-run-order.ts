/**
 * The ORDER a split plan runs in (AC-006: "dependsOn 未完成的子任务不得启动").
 *
 * Two questions, both answered from the plan alone — no model, no gate:
 *
 *  1. **May this plan be dispatched at all?** Duplicate/blank task ids, a
 *     `dependsOn` entry that names no task, and a dependency cycle all make the
 *     order undefined. They are REPORTED (every one, not the first) and the
 *     caller refuses; guessing an order for a cyclic graph is how two workers end
 *     up on the same task, or none.
 *  2. **In what order do the groups run?** `parallelGroups` is a ceiling on
 *     concurrency, not a schedule: a group whose tasks depend on an earlier
 *     group's tasks must come after it. Groups are topologically sorted here, and
 *     tasks that appear in no group become singleton groups at the end (leaving
 *     them out would silently skip work the plan declared).
 *
 * Within one group the plan's own task order is kept, so a report is reproducible.
 *
 * @module dsh-orchestrator/split-run-order
 */

import type { SplitPlan, SplitTask } from 'dsh-eng-core/split'

/** The plan as a runnable graph. */
export interface SplitOrder {
    /** Tasks by id (only well-formed ones; problems name the rest). */
    byId: Map<string, SplitTask>
    /** Dependency-ordered groups of tasks (never empty when `problems` is empty). */
    groups: SplitTask[][]
    /** Every reason the plan cannot be scheduled; non-empty = refuse to dispatch. */
    problems: string[]
}

/** The id of one task (`''` when the plan carries something unusable). */
function idOf(task: SplitTask): string {
    return typeof task.id === 'string' ? task.id.trim() : ''
}

/** `dependsOn` as a clean list (a non-array value is reported by the caller). */
function depsOf(task: SplitTask): string[] {
    return Array.isArray(task.dependsOn) ? task.dependsOn.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()) : []
}

/** Duplicate and blank ids: neither a dependency nor a group can address them. */
function collectIds(tasks: readonly SplitTask[], problems: string[]): Map<string, SplitTask> {
    const byId = new Map<string, SplitTask>()
    for (const task of tasks) {
        const id = idOf(task)
        if (id === '') {
            problems.push(`plan 里有子任务没有可用 id（收到 ${JSON.stringify(task.id)}）：依赖与分组无法定位它`)
            continue
        }
        if (byId.has(id)) problems.push(`子任务 id ${id} 重复：依赖与分组无法唯一定位`)
        else byId.set(id, task)
    }
    return byId
}

/** Unknown dependencies: refused, because "wait for a task that never exists" never ends. */
function checkDeps(tasks: readonly SplitTask[], byId: Map<string, SplitTask>, problems: string[]): Map<string, string[]> {
    const deps = new Map<string, string[]>()
    for (const task of tasks) {
        const id = idOf(task)
        if (id === '' || !byId.has(id)) continue
        const declared = depsOf(task)
        const unknown = declared.filter((dep) => !byId.has(dep))
        if (unknown.length > 0) problems.push(`子任务 ${id} 的 dependsOn 指向不存在的子任务：${unknown.join('、')}`)
        // A self-dependency is kept ON PURPOSE: it is a cycle, and keeping it makes
        // the cycle check name the task instead of silently treating it as "no
        // dependency" (which would start a task that waits for itself).
        deps.set(id, declared.filter((dep) => byId.has(dep)))
    }
    return deps
}

/** Kahn's algorithm over task ids; leftover ids mean a cycle. */
function checkCycle(byId: Map<string, SplitTask>, deps: Map<string, string[]>, problems: string[]): void {
    const indegree = new Map<string, number>()
    const dependants = new Map<string, string[]>()
    for (const id of byId.keys()) indegree.set(id, 0)
    for (const [id, list] of deps) {
        indegree.set(id, list.filter((dep) => byId.has(dep)).length)
        for (const dep of list) dependants.set(dep, [...(dependants.get(dep) ?? []), id])
    }
    const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
    let seen = 0
    while (queue.length > 0) {
        const id = queue.shift() ?? ''
        seen += 1
        for (const next of dependants.get(id) ?? []) {
            const left = (indegree.get(next) ?? 1) - 1
            indegree.set(next, left)
            if (left === 0) queue.push(next)
        }
    }
    if (seen === indegree.size) return
    const stuck = [...indegree].filter(([, count]) => count > 0).map(([id]) => id)
    problems.push(`dependsOn 有环（${stuck.join('、')} 互相依赖）：无法排出启动顺序`)
}

/** One group while it is being ordered: its tasks and its position in the plan. */
interface GroupNode {
    index: number
    tasks: SplitTask[]
}

/** The declared groups, with unknown ids reported and unlisted tasks added. */
function declaredGroups(plan: SplitPlan, tasks: readonly SplitTask[], byId: Map<string, SplitTask>, problems: string[]): GroupNode[] {
    const listed = new Map<string, number>()
    const groups: GroupNode[] = []
    const declared = Array.isArray(plan.parallelGroups) ? plan.parallelGroups : []
    for (const raw of declared) {
        if (!Array.isArray(raw)) {
            problems.push(`parallelGroups 的条目必须是子任务 id 数组（收到 ${JSON.stringify(raw)}）`)
            continue
        }
        const members: SplitTask[] = []
        for (const entry of raw) {
            const id = typeof entry === 'string' ? entry.trim() : ''
            const task = byId.get(id)
            if (task === undefined) {
                problems.push(`parallelGroups 里的 ${JSON.stringify(entry)} 不是已知子任务 id`)
                continue
            }
            const seen = listed.get(id)
            if (seen === groups.length) problems.push(`子任务 ${id} 在同一个并行组里重复出现：并发上限无法判定`)
            else if (seen !== undefined) problems.push(`子任务 ${id} 同时出现在多个并行组里（第 ${seen + 1} 与第 ${groups.length + 1} 组）：并发上限无法判定`)
            listed.set(id, groups.length)
            members.push(task)
        }
        if (members.length > 0) groups.push({ index: groups.length, tasks: members })
    }
    for (const task of tasks) {
        const id = idOf(task)
        if (id !== '' && !listed.has(id)) groups.push({ index: groups.length, tasks: [task] })
    }
    return groups
}

/** Which group a task id belongs to. */
function groupIndexOf(groups: readonly GroupNode[]): Map<string, number> {
    const index = new Map<string, number>()
    groups.forEach((group, position) => {
        for (const task of group.tasks) index.set(idOf(task), position)
    })
    return index
}

/** Group-level topological order (stable: ties keep the plan's order). */
function orderGroups(groups: readonly GroupNode[], deps: Map<string, string[]>, problems: string[]): GroupNode[] {
    const position = groupIndexOf(groups)
    const edges = groups.map(() => new Set<number>())
    const indegree = groups.map(() => 0)
    for (const [id, list] of deps) {
        const to = position.get(id)
        if (to === undefined) continue
        for (const dep of list) {
            const from = position.get(dep)
            if (from === undefined || from === to || edges[from]?.has(to) === true) continue
            edges[from]?.add(to)
            indegree[to] = (indegree[to] ?? 0) + 1
        }
    }
    const ready = groups.filter((_group, at) => (indegree[at] ?? 0) === 0).map((group) => group.index)
    const out: GroupNode[] = []
    while (ready.length > 0) {
        const next = ready.shift() ?? 0
        const group = groups[next]
        if (group !== undefined) out.push(group)
        for (const target of edges[next] ?? []) {
            indegree[target] = (indegree[target] ?? 1) - 1
            if (indegree[target] === 0) ready.push(target)
        }
    }
    if (out.length === groups.length) return out
    // Only a task-level cycle (already reported) can leave a group undecided:
    // keep the plan's order for the remainder instead of dropping the group.
    problems.push('并行组之间的依赖排不出顺序（任务依赖有环）：按 plan 里的组顺序执行剩下的组')
    return [...out, ...groups.filter((group) => !out.includes(group))]
}

/**
 * Turn a plan into a runnable order.
 * @param plan - the reviewed plan.
 * @returns the dependency-ordered groups plus every reason dispatch must refuse.
 */
export function planOrder(plan: SplitPlan): SplitOrder {
    const problems: string[] = []
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
    if (tasks.length === 0) problems.push('plan 没有子任务（tasks 为空）：没有可派发的工作')
    const byId = collectIds(tasks, problems)
    const deps = checkDeps(tasks, byId, problems)
    checkCycle(byId, deps, problems)
    const groups = orderGroups(declaredGroups(plan, tasks, byId, problems), deps, problems)
    return { byId, groups: groups.map((group) => group.tasks), problems }
}

/** The dependencies of one task that are not in `done` yet. */
export function unmetDeps(task: SplitTask, done: ReadonlySet<string>): string[] {
    return depsOf(task).filter((dep) => !done.has(dep))
}

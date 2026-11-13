/**
 * Import cycles — the graph half of the structural metrics.
 *
 * `forbidCycles: true` turns "module A imports B which imports A" into a gate
 * violation. Two properties make the answer usable:
 *
 *  - **Deterministic**: nodes are sorted, each cycle is rotated to its
 *    lexicographically smallest path, and duplicates collapse — so two runs over
 *    the same workspace produce the same list.
 *  - **Bounded**: at most {@link MAX_CYCLES} cycles and {@link MAX_CYCLE_STEPS}
 *    traversal steps, so a pathological graph degrades to "the first N cycles"
 *    instead of hanging the gate. The truncation is logged, never silent.
 *
 * It lives in its own module because the search is three separate algorithms
 * (finish order, components, cycle enumeration) and because `metrics.ts` is on
 * its file-size ratchet; nothing here knows about files, violations or baselines.
 *
 * @module dsh-eng-core/metrics-cycles
 */

import type { Logger } from './log.js'

const MAX_CYCLES = 200
const MAX_CYCLE_STEPS = 200_000

function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/** Rotate a cycle so the lexicographically smallest path comes first. */
function normaliseCycle(cycle: readonly string[]): string[] {
    let pivot = 0
    for (let index = 1; index < cycle.length; index += 1) {
        if (compareText(cycle[index] ?? '', cycle[pivot] ?? '') < 0) pivot = index
    }
    return [...cycle.slice(pivot), ...cycle.slice(0, pivot)]
}

/** One frame of the iterative depth-first walk (a recursive one could overflow). */
interface FinishFrame {
    node: string
    cursor: number
}

/** Kosaraju's first pass: depth-first finish order over the graph. */
function finishOrder(adjacency: Map<string, string[]>, nodes: readonly string[]): string[] {
    const order: string[] = []
    const visited = new Set<string>()
    for (const start of nodes) {
        if (visited.has(start)) continue
        const stack: FinishFrame[] = [{ node: start, cursor: 0 }]
        visited.add(start)
        while (stack.length > 0) {
            const frame = stack[stack.length - 1] as FinishFrame
            const neighbours = adjacency.get(frame.node) ?? []
            if (frame.cursor >= neighbours.length) {
                order.push(frame.node)
                stack.pop()
                continue
            }
            const next = neighbours[frame.cursor] as string
            frame.cursor += 1
            if (visited.has(next)) continue
            visited.add(next)
            stack.push({ node: next, cursor: 0 })
        }
    }
    return order
}

/** Fill one strongly connected component by walking the reversed graph from `start`. */
function fillComponent(reverse: Map<string, string[]>, start: string, id: number, componentOf: Map<string, number>): void {
    const stack: string[] = [start]
    componentOf.set(start, id)
    while (stack.length > 0) {
        const node = stack.pop() as string
        for (const next of reverse.get(node) ?? []) {
            if (componentOf.has(next)) continue
            componentOf.set(next, id)
            stack.push(next)
        }
    }
}

/** Bucket nodes by component id, keeping the input order (determinism). */
function bucketsOf(nodes: readonly string[], componentOf: Map<string, number>): Map<number, string[]> {
    const components = new Map<number, string[]>()
    for (const node of nodes) {
        const id = componentOf.get(node) ?? -1
        if (id < 0) continue
        const bucket = components.get(id) ?? []
        bucket.push(node)
        components.set(id, bucket)
    }
    return components
}

/** Kosaraju's second pass: components over the reversed graph. */
function componentsOf(reverse: Map<string, string[]>, order: readonly string[], nodes: readonly string[]): Map<number, string[]> {
    const componentOf = new Map<string, number>()
    let count = 0
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const start = order[index] as string
        if (componentOf.has(start)) continue
        const id = count
        count += 1
        fillComponent(reverse, start, id, componentOf)
    }
    return bucketsOf(nodes, componentOf)
}

/** The state one cycle enumeration mutates. */
interface CycleSearch {
    adjacency: Map<string, string[]>
    /** Nodes of the component being searched (a cycle never leaves it). */
    members: ReadonlySet<string>
    found: Map<string, string[]>
    /** Shared step budget (a mutable counter, not a number, so the bound is global). */
    steps: { count: number }
}

/**
 * Enumerate the simple cycles through `start` that continue from `node`.
 *
 * `path`/`onPath` are the current trail; `start` closes the cycle. The step
 * budget is charged on every edge examined, so a dense component cannot turn
 * this into an exponential walk.
 */
function walkCycles(search: CycleSearch, start: string, node: string, path: string[], onPath: Set<string>): void {
    if (search.found.size >= MAX_CYCLES || search.steps.count >= MAX_CYCLE_STEPS) return
    for (const next of search.adjacency.get(node) ?? []) {
        search.steps.count += 1
        if (search.steps.count >= MAX_CYCLE_STEPS || search.found.size >= MAX_CYCLES) return
        if (!search.members.has(next)) continue
        if (next === start) {
            if (path.length < 2) continue
            const cycle = normaliseCycle(path)
            search.found.set(cycle.join('\u0000'), cycle)
            continue
        }
        if (onPath.has(next)) continue
        onPath.add(next)
        path.push(next)
        walkCycles(search, start, next, path, onPath)
        path.pop()
        onPath.delete(next)
    }
}

/**
 * Every simple import cycle of the graph, normalised and deduplicated.
 *
 * Only strongly connected components are searched; the result is capped
 * ({@link MAX_CYCLES}) and so is the traversal ({@link MAX_CYCLE_STEPS}), so a
 * pathological graph degrades to "the first N cycles" instead of hanging.
 * @param edges - adjacency (`node` → the nodes it imports).
 * @param logger - diagnostic sink for the truncation notice.
 */
export function findCycles(edges: Map<string, string[]>, logger: Logger): string[][] {
    const nodes = [...edges.keys()].sort(compareText)
    const adjacency = new Map<string, string[]>()
    const reverse = new Map<string, string[]>()
    for (const node of nodes) {
        adjacency.set(node, [...new Set(edges.get(node) ?? [])].filter((target) => target !== node).sort(compareText))
        reverse.set(node, [])
    }
    for (const node of nodes) {
        for (const target of adjacency.get(node) ?? []) reverse.get(target)?.push(node)
    }
    for (const node of nodes) reverse.get(node)?.sort(compareText)

    const components = componentsOf(reverse, finishOrder(adjacency, nodes), nodes)
    const found = new Map<string, string[]>()
    const steps = { count: 0 }
    for (const id of [...components.keys()].sort((left, right) => left - right)) {
        const component = components.get(id) ?? []
        if (component.length < 2) continue
        const search: CycleSearch = { adjacency, members: new Set(component), found, steps }
        for (const start of [...component].sort(compareText)) {
            if (found.size >= MAX_CYCLES || steps.count >= MAX_CYCLE_STEPS) break
            walkCycles(search, start, start, [start], new Set([start]))
        }
    }
    if (found.size >= MAX_CYCLES || steps.count >= MAX_CYCLE_STEPS) {
        logger.debug(`metrics: 导入环枚举达到上限（${MAX_CYCLES} 个 / ${MAX_CYCLE_STEPS} 步），已截断`)
    }
    return [...found.values()].sort((left, right) => compareText(left.join('\n'), right.join('\n')))
}

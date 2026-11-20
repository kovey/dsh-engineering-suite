/**
 * `split_plan` — the write entry of the split workflow (AC-001).
 *
 * Before this tool the only writer of `split/plan.json` was a caller holding the
 * library (`saveSplitPlan`), which meant the three automatic checks could be
 * skipped by writing the file by hand. The tool makes the checked path the easy
 * path: read the mission's specification (its criteria are the oracle), run the
 * three checks (`validateSplitPlan`), and write `plan.json` + the readable
 * `plan.md` only when all three pass — returning the digest a review must quote.
 *
 * The one refusal that is NOT about validity: a mission whose plan already exists
 * and whose content would change (different digest) must say `force: true`.
 * Editing a reviewed plan is a legitimate action, but it invalidates the review
 * that was bound to the old digest — so it needs a deliberate "yes, re-plan".
 * The review record is not rewritten here (it stays as history); the dispatcher
 * and the `split-review` stage both refuse a stale digest, which is what makes
 * the invalidation real rather than a sentence in a report.
 *
 * @module dsh-orchestrator/split-plan-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOf, type AgentLike, type Layout, type MissionRecord, type MissionStoreRegistry } from 'dsh-eng-core'
import { readSplitPlan, saveSplitPlan, splitPlanDigest, validateSplitPlan, type SplitPlan, type SplitValidation } from 'dsh-eng-core/split'

/** Arguments of `split_plan` (untrusted: validated by `validateSplitPlan`). */
export interface SplitPlanToolArgs {
    /** The tasks to plan (`{id, goal, paths, acceptance, dependsOn, parallel}`). */
    tasks?: unknown
    /** Optional parallel groups; omitted = one group per task in plan order. */
    parallelGroups?: unknown
    /** Write a plan whose digest differs from the one on disk (re-review later). */
    force?: boolean
}

/** Everything the checked write needs (one object: no dependency on the host). */
export interface ApplySplitPlanInput {
    layout: Layout
    missionId: string
    /** The mission's specification (the AC oracle). */
    spec: unknown
    /** Mission title, rendered into the readable `plan.md`. */
    title?: string
    tasks: unknown
    parallelGroups?: unknown
    force?: boolean
}

/** What one checked write did. */
export interface ApplySplitPlanResult {
    ok: boolean
    /** Absolute path written (only when `ok`). */
    file?: string
    /** Absolute path of the readable `plan.md` written with it (only when `ok`). */
    markdownFile?: string
    /** The digest a review must quote (only when `ok`). */
    digest?: string
    validation: SplitValidation
    /** Human-readable reasons (`ok: false`) — never "invalid plan". */
    problems: string[]
    /** How many tasks the plan holds (0 when `tasks` was not an array). */
    taskCount: number
    /** How many parallel groups were written. */
    groupCount: number
    /** A plan already existed with the same content (rewritten byte-identically). */
    replaced: boolean
    /** The content changed: any review of the old digest is stale now. */
    reviewInvalidated: boolean
}

/** The sink the plugin's tool registration shares with `registerTools`. */
export interface ToolRegistrationSink {
    disposers: (() => void)[]
    registered: string[]
    failed: string[]
}

/** The part of `SequenceDeps` this tool needs (structural: no import cycle). */
export interface SplitPlanToolDeps {
    stores: MissionStoreRegistry
}

/**
 * One group per task, in plan order — the conservative default on purpose: a
 * plan that does not SAY which tasks may run together runs them one at a time.
 * Grouping everything would turn "the planner forgot parallelGroups" into
 * overlapping worktrees.
 */
function defaultGroups(tasks: unknown): string[][] {
    if (!Array.isArray(tasks)) return []
    return tasks
        .map((task) => (typeof task === 'object' && task !== null ? (task as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        .map((id) => [id])
}

/** AC → task ids, derived from the tasks' own `acceptance` (the plan stays self-describing). */
function coverageOf(tasks: unknown): Record<string, string[]> {
    const coverage: Record<string, string[]> = {}
    if (!Array.isArray(tasks)) return coverage
    for (const task of tasks) {
        if (typeof task !== 'object' || task === null) continue
        const record = task as { id?: unknown; acceptance?: unknown }
        if (typeof record.id !== 'string' || !Array.isArray(record.acceptance)) continue
        for (const criterion of record.acceptance) {
            if (typeof criterion !== 'string' || criterion.trim() === '') continue
            coverage[criterion] = [...(coverage[criterion] ?? []), record.id]
        }
    }
    return coverage
}

/** The refusal for a changed digest (the one case that needs `force`). */
function digestChangeProblems(from: string, to: string): string[] {
    return [
        `plan 内容变化：摘要 ${from.slice(0, 12)} → ${to.slice(0, 12)}，改动需要重新审核`,
        '审核记录绑定的是旧摘要：写入后 split-review 会判定"计划已改动"，派发与导入都会拒绝，直到重新审核。',
        '确认这次改动（而不是手滑）请带 force: true 重试；旧审核记录不会被删除，它只是不再对应当前 plan。',
    ]
}

/**
 * Validate and (when valid) write one plan.
 *
 * @param input - the layout, mission, the mission's spec and the untrusted args.
 * @returns whether it wrote, the digest, and every reason it did not.
 */
export function applySplitPlan(input: ApplySplitPlanInput): ApplySplitPlanResult {
    const groups = input.parallelGroups ?? defaultGroups(input.tasks)
    const draft = { tasks: input.tasks, parallelGroups: groups, coverage: coverageOf(input.tasks) } as unknown as SplitPlan
    const taskCount = Array.isArray(input.tasks) ? input.tasks.length : 0
    const groupCount = Array.isArray(groups) ? groups.length : 0
    const validation = validateSplitPlan(draft, input.spec)
    if (!validation.ok) {
        return { ok: false, validation, problems: validation.problems.map((problem) => problem.detail), taskCount, groupCount, replaced: false, reviewInvalidated: false }
    }
    const existing = readSplitPlan(input.layout, input.missionId)
    const digest = splitPlanDigest({ ...draft, missionId: input.missionId })
    if (existing !== undefined && existing.digest !== digest && input.force !== true) {
        return { ok: false, validation, problems: digestChangeProblems(existing.digest, digest), taskCount, groupCount, replaced: true, reviewInvalidated: true }
    }
    const saved = saveSplitPlan(input.layout, input.missionId, draft, {
        validation,
        ...(input.title === undefined ? {} : { title: input.title }),
    })
    return {
        ok: true,
        file: saved.file,
        markdownFile: saved.markdownFile,
        digest: saved.digest,
        validation,
        problems: [],
        taskCount,
        groupCount,
        replaced: existing !== undefined,
        reviewInvalidated: existing !== undefined && existing.digest !== saved.digest,
    }
}

/** The report of a refused write (validation problems, or the force requirement). */
function refusalLines(result: ApplySplitPlanResult): string[] {
    const heading = result.reviewInvalidated ? '拆分计划未写入：内容变化需要显式 force' : `拆分计划未写入：三道自动校验未通过（${result.problems.length} 条）`
    return [
        heading,
        ...result.problems.map((problem) => `- ${problem}`),
        '',
        result.reviewInvalidated
            ? '下一步：确认要改这份计划后，带 force: true 重新调用 split_plan；然后重新审核（split-review 阶段/人工审批）。'
            : '下一步：按上面的问题修好 tasks / parallelGroups，再调用一次 split_plan（校验不过不会写入任何文件）。',
    ]
}

/** The report of a written plan (digest, groups and the review consequence). */
function successLines(mission: MissionRecord, result: ApplySplitPlanResult): string[] {
    const digest = result.digest ?? ''
    const review = result.reviewInvalidated
        ? '旧审核记录已失效（摘要变了）：必须重新审核，split-review 之前不会派发任何 worker。'
        : result.replaced
          ? 'plan 内容未变（摘要相同）：现有审核记录仍然有效。'
          : '还没有审核记录：下一步是人工审核（split-review），审核前不会派发 worker。'
    return [
        `拆分计划已写入：${result.file ?? '(未知路径)'}（mission ${mission.id}）`,
        `- 可读版本：${result.markdownFile ?? '(未知路径)'}（人工审核打开的就是它；plan.json 变了就同步重写）`,
        `- 摘要：${digest.slice(0, 12)}（审核必须引用这个摘要）`,
        `- 子任务：${result.taskCount} 个；并行组：${result.groupCount} 个`,
        `- 覆盖验收标准：${result.validation.covered.join('、') || '(无)'}`,
        `- 审核状态：${review}`,
        '',
        '下一步：走 split-review 阶段完成人工审核；未审核的 plan 不会被派发（runner 与 implement 入口都会拒绝）。',
    ]
}

/**
 * Run one `split_plan` call.
 * @param deps - the mission store registry (the workspace is resolved per call).
 * @param args - the untrusted tool arguments.
 * @param exec - the tool execution context (agent, so the mission can be resolved).
 * @returns the Chinese report; the last line is always the next action.
 */
export function runSplitPlanTool(deps: SplitPlanToolDeps, args: SplitPlanToolArgs, exec: unknown): string {
    const agent = (exec as { agent?: AgentLike }).agent
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    const store = deps.stores.for(cwd)
    const mission = store.resolveForAgent(agent)
    if (mission === undefined) {
        return [
            `当前会话没有绑定 mission（session=${sessionIdOf(agent) ?? '(未知)'}）：split_plan 不能替一个不存在的 mission 写计划。`,
            '',
            '下一步：先调用 orchestrate({ action: "start", summary: "<一句话任务名>" })，或用 action: "status" 确认当前 mission。',
        ].join('\n')
    }
    if (mission.spec === undefined) {
        return [
            `mission ${mission.id} 还没有规格（spec 缺失）：没有验收标准就无法校验"每任务映射真实 AC / AC 全覆盖"。`,
            '',
            '下一步：先用 spec_create 写规格并通过 spec_approve，再调用 split_plan。',
        ].join('\n')
    }
    const result = applySplitPlan({
        layout: store.layout,
        missionId: mission.id,
        spec: mission.spec,
        title: mission.title,
        tasks: args.tasks,
        ...(args.parallelGroups === undefined ? {} : { parallelGroups: args.parallelGroups }),
        ...(args.force === true ? { force: true } : {}),
    })
    return [...(result.ok ? successLines(mission, result) : refusalLines(result))].join('\n')
}

/** One task's schema fields (a separate const: the nesting is data, and the file depth rule counts braces). */
const SPLIT_TASK_PROPERTIES = {
    id: { type: 'string', description: 'Stable task id (`T-001`); also the worktree/branch suffix and the required commit prefix.' },
    goal: { type: 'string', description: 'What this task must achieve.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this task owns (globs allowed).' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria ids (`AC-001`) this task satisfies — they must exist in the mission spec.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish before this one starts.' },
    parallel: { type: 'boolean', description: 'Whether this task may run next to its group\'s other tasks.' },
} as const

/** One task of the plan, as the tool transports it. */
const SPLIT_TASK_SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: SPLIT_TASK_PROPERTIES,
    description: 'One task: at least one real acceptance criterion and at least one path.',
} as const

/** The parameter schema of `split_plan` (module scope: the nesting is data, not logic). */
const SPLIT_PLAN_PARAMETERS = {
    tasks: {
        type: 'array',
        required: true,
        items: SPLIT_TASK_SCHEMA,
        description: 'The tasks of the plan. Each one needs at least one real acceptance criterion and at least one path.',
    },
    parallelGroups: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description: 'Groups of task ids that may run at the same time. Every task must appear in exactly one group; no two tasks of a group may own overlapping paths. Omitted = one group per task (serial execution).',
    },
    force: {
        type: 'boolean',
        description: 'Write a plan whose digest differs from the one on disk. Refused without it ("改动需要重新审核"); the existing review record then no longer matches, so a new review is required before any dispatch.',
    },
} as const

/** The `defineTool` definition of `split_plan` (one place: the tool IS its schema). */
function splitPlanDefinition(deps: SplitPlanToolDeps): unknown {
    return defineTool({
        name: 'split_plan',
        description:
            'Write the split plan of the current mission (dsh-orchestrator): validate the tasks against the mission\'s acceptance criteria (every task maps a REAL criterion, no overlapping paths inside one parallel group, every criterion covered) and only then write .dsh/…/missions/<id>/split/plan.json. A plan that fails a check is NOT written and the problems are listed. When a plan already exists with a different digest, the write is refused unless force: true — editing a reviewed plan invalidates its review, so it needs a deliberate re-plan. Returns the digest a review must quote. Omitted parallelGroups = one group per task (serial); no worker runs until a person approves the plan.',
        parameters: SPLIT_PLAN_PARAMETERS,
        output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
        async execute(args: SplitPlanToolArgs, exec: unknown) {
            return runSplitPlanTool(deps, args ?? {}, exec)
        },
    })
}

/**
 * Register `split_plan` on the host (same shape as the plugin's other tool).
 * @param ctx - the tool registry.
 * @param deps - the mission store registry.
 * @param sink - where the disposer/registration outcome is collected, so `apply`
 *   reports both tools in one line and tears both down on dispose.
 */
export function registerSplitPlanTool(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: SplitPlanToolDeps,
    sink: ToolRegistrationSink,
): void {
    try {
        sink.disposers.push(ctx.tools.register(splitPlanDefinition(deps) as never))
        sink.registered.push('split_plan')
    } catch {
        sink.failed.push('split_plan')
    }
}

/**
 * The parameter schema of `split_plan` (the data half of the tool).
 *
 * Split out of `split-plan-tool.ts` for the repository's `maxFileLines` ratchet:
 * the tool file was exactly at its ceiling when the per-task AC budget landed.
 * The schema is pure data — `defineTool` reads it, nothing here executes — so
 * moving it cannot change behaviour. The descriptions are part of the tool's
 * contract: the model reads them, so they say what a task must contain (a real,
 * existing acceptance criterion and at least one path) and what `force` means.
 *
 * @module dsh-orchestrator/split-plan-tool-schema
 */

/** One task of the plan, as the tool transports it. */
const SPLIT_TASK_SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'Stable task id (`T-001`); also the worktree/branch suffix and the required commit prefix.' },
        goal: { type: 'string', description: 'What this task must achieve.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths this task owns (globs allowed).' },
        acceptance: {
            type: 'array',
            items: { type: 'string' },
            description: 'Acceptance criteria ids (`AC-001`) this task satisfies — they must exist in the mission spec, and there may be at most split.maxAcceptancePerTask of them per task.',
        },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish before this one starts.' },
        parallel: { type: 'boolean', description: "Whether this task may run next to its group's other tasks." },
    },
    description: 'One task: at least one real acceptance criterion (at most the per-task AC budget) and at least one path.',
} as const

/** The parameters of `split_plan` (module scope: the nesting is data, not logic). */
export const SPLIT_PLAN_PARAMETERS = {
    tasks: {
        type: 'array',
        required: true,
        items: SPLIT_TASK_SCHEMA,
        description: 'The tasks of the plan. Each one needs at least one real acceptance criterion (at most split.maxAcceptancePerTask, default 3) and at least one path.',
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

/**
 * The split stages of the pipeline (AC-002 / AC-003 placement).
 *
 * They are INSERTED between `spec-approve` and `implement` — same ids, same
 * order for every existing stage, nothing renamed — and only when the host
 * enables the split workflow (`config.split.enabled`). That default-off choice is
 * deliberate and documented in the report: the six-stage pipeline is a contract
 * the existing tests and profiles rely on, and turning splitting on is a
 * deployment decision (it needs the planner/worker models and an approval
 * channel), not a silent upgrade.
 *
 * No `role` is declared on these stages this round: `packages/dsh-role-guard`
 * now ships `planner` (read-only) and `worker` (write, no gate tools), but a
 * stage that declares a role also requires a recorded child delegation before it
 * can be settled (`stageRoleDelegation`). Wiring the stages to those roles is a
 * separate, behaviour-changing step; until then the review text names which role
 * does the work and `team_delegate` is what dispatches it.
 *
 * @module dsh-orchestrator/split-stages
 */

import { DEFAULT_GATE_LABEL } from './gate-kinds.js'
import type { Pipeline, StageConfig } from './pipeline.js'

/** The stage ids of the split segment, in order. */
export const SPLIT_STAGE_IDS: readonly string[] = ['split', 'split-review']

const SPLIT_STAGES: readonly StageConfig[] = [
    {
        id: 'split',
        difficulty: 'deep', // 拆任务是最需要推理的一步（planner 模型）
        prompt: '拆分任务：planner 产出拆分计划并通过四道自动校验（含每任务 AC 预算）',
        requiredPlugins: [],
        // `entry` phase on purpose: a plan that does not validate means the
        // stage's work is not done yet, so the advance is REFUSED and the stage
        // stays open for a re-plan (retry is free, no attempt is burned). An
        // exit-phase gate would roll back — and a rollback target of this same
        // stage would overwrite the `failed` record with the re-entry, losing
        // the BLOCK verdict the report just listed.
        gate: { kind: 'split-plan', phase: 'entry', label: DEFAULT_GATE_LABEL['split-plan'], verdict: 'pass-or-warn' },
        next: 'split-review',
    },
    {
        id: 'split-review',
        difficulty: 'cheap', // 送审与等待人工决定，几乎不消耗推理
        prompt: '人工审核拆分计划',
        requiredPlugins: [],
        gate: { kind: 'split-review', phase: 'exit', label: DEFAULT_GATE_LABEL['split-review'], verdict: 'pass-only' },
        onFail: 'split',
        next: 'implement',
    },
]

/** A copy of one stage, so two resolved pipelines never share mutable state. */
function cloneStage(stage: StageConfig): StageConfig {
    return { ...stage, requiredPlugins: [...stage.requiredPlugins], gate: { ...stage.gate } }
}

/** Whether a pipeline already carries the split segment. */
export function hasSplitStages(pipeline: Pipeline): boolean {
    return pipeline.some((stage) => SPLIT_STAGE_IDS.includes(stage.id))
}

/**
 * Splice the split segment in between `spec-approve` and `implement`.
 *
 * The predecessor's explicit `next` is rewritten when it pointed straight at
 * `implement` — otherwise the pipeline would DOCUMENT split stages that the
 * transition rules skip, and two sources of truth would disagree.
 * @param pipeline - the pipeline resolved from the host configuration.
 * @returns a new pipeline (unchanged when `implement` is absent or the segment
 *   is already present).
 */
export function withSplitStages(pipeline: Pipeline): Pipeline {
    if (hasSplitStages(pipeline)) return pipeline
    const index = pipeline.findIndex((stage) => stage.id === 'implement')
    if (index < 0) return pipeline
    const head = pipeline.slice(0, index).map((stage) => (stage.next === 'implement' ? { ...stage, next: 'split' } : stage))
    return [...head, ...SPLIT_STAGES.map(cloneStage), ...pipeline.slice(index)]
}

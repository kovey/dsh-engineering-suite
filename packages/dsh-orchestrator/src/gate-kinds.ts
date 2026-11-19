/**
 * The gate kinds a stage can declare, and how each one is named.
 *
 * Split out of `pipeline.ts` (which is on the file-size ratchet) so that adding
 * a gate kind costs one list entry here instead of growing the pipeline model.
 * The kind is the ONLY thing a gate declares: what it means is implemented by
 * `gates.ts` (and its per-concern modules), never described here.
 *
 * @module dsh-orchestrator/gate-kinds
 */

/** One deterministic entry/exit condition, named by the fact it asserts. */
export type GateKind =
    | 'spec-approved'
    | 'test-design'
    | 'quality-pass'
    | 'standards-pass'
    | 'deploy-go'
    | 'deploy-verified'
    | 'receipt'
    | 'split-plan'
    | 'split-review'
    | 'split-reviewed'
    | 'none'

/** Every accepted kind, in the order the error message lists them. */
export const GATE_KINDS: readonly GateKind[] = [
    'spec-approved',
    'test-design',
    'quality-pass',
    'standards-pass',
    'deploy-go',
    'deploy-verified',
    'receipt',
    'split-plan',
    'split-review',
    'split-reviewed',
    'none',
]

/** The default human label of each kind. */
export const DEFAULT_GATE_LABEL: Record<GateKind, string> = {
    'spec-approved': '规格已审批（mission.spec.approvedAt）',
    'test-design': '测试设计已登记（mission.testDesign）',
    'quality-pass': '质量门禁 PASS 且晚于本阶段进入时间（store.lastGate）',
    'standards-pass': '规范门禁 PASS 且晚于本阶段进入时间（dsh-standards-gate 的门禁记录）',
    'deploy-go': '部署已执行且通过（dsh-deploy-gate 的门禁记录，晚于本阶段进入时间）',
    'deploy-verified': '上线后验证通过（dsh-deploy-gate 的门禁记录，晚于本阶段进入时间）',
    receipt: '已签发交付回执（store.readReceipts）',
    'split-plan': '拆分计划已落盘且三道自动校验通过（missions/<id>/split/plan.json）',
    'split-review': '拆分计划已人工审核且 plan 摘要匹配（missions/<id>/split/review.json）',
    'split-reviewed': '没有待审核的拆分计划，或已审核的摘要与当前 plan 一致',
    none: '无门禁',
}

/**
 * The phase a kind uses when the stage does not declare one.
 *
 * Exit means "the deterministic fact IS the transition" (the stage's work
 * produces the fact and failing it rolls back); everything else is an entry
 * condition, refused without touching the previous stage's record.
 * @param kind - the declared kind.
 */
export function defaultGatePhase(kind: GateKind): 'entry' | 'exit' {
    return kind === 'quality-pass' || kind === 'receipt' || kind === 'split-plan' || kind === 'split-review' ? 'exit' : 'entry'
}

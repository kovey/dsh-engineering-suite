/**
 * The split workflow's gates: `split-plan`, `split-review` and `split-reviewed`.
 *
 * Three deterministic facts, no model in the loop:
 *
 *  - `split-plan` (exit of `split`): the plan on disk passes the three automatic
 *    checks AND the AC-005 threshold. A `not-worth-splitting` verdict is a PASS
 *    with a skip instruction (plain implement); `too-large` is a refusal whose
 *    text says the real fix — several missions.
 *  - `split-review` (exit of `split-review`): a review record exists, it says
 *    `approved`, and its digest is the digest of the plan on disk. Everything
 *    else — missing, rejected, stale — blocks.
 *  - `split-reviewed` (entry of `implement`): "no plan, or a plan whose reviewed
 *    digest still matches". This is what makes "plan 改动必须重审" true at the
 *    moment work starts, not only at the review stage.
 *
 * `models.json` problems are appended to every detail: a fallback (a default
 * `maxTasks`, no planner model) is exactly the kind of thing a human must see
 * BEFORE approving the plan.
 *
 * @module dsh-orchestrator/split-gates
 */

import { decideSplit, loadModelsConfig, readSplitPlan, splitRejectionCount, splitReviewStatus, validateSplitPlan } from 'dsh-eng-core/split'
import type { GateFacts, GateOutcome } from './gate-facts.js'
import type { StageConfig } from './pipeline.js'

/** The effective models config of the mission's workspace (project > profile). */
function modelsOf(facts: GateFacts) {
    return loadModelsConfig(facts.store.layout, { profile: facts.models })
}

/** How often the human rejected this mission's plan, vs the rework allowance. */
interface ReworkLimit {
    rejected: number
    rounds: number
    /** `true` when the allowance is used up and the plan goes plain implement. */
    active: boolean
}

/** Where the plan stands against `split.maxReworkRounds` (AC-003's tail). */
function reworkLimit(facts: GateFacts): ReworkLimit {
    const rounds = modelsOf(facts).config.split.maxReworkRounds
    const rejected = splitRejectionCount(facts.store.layout, facts.mission.id)
    // `rejected > 0` matters for `maxReworkRounds: 0` ("no rework allowed"): it
    // must still require the FIRST review, and degrade only after a rejection.
    return { rejected, rounds, active: rejected > 0 && rejected >= rounds }
}

/** The PASS that degrades a repeatedly rejected plan to plain implement. */
function degradePass(facts: GateFacts, limit: ReworkLimit, extra: readonly string[]): GateOutcome {
    return {
        ok: true,
        state: 'PASS',
        detail: [
            `拆分已被人工审核拒绝 ${limit.rejected} 轮（上限 maxReworkRounds=${limit.rounds}）：降级为 plain implement——不建 worktree、不派 worker。`,
            ...extra,
            ...fallbackLines(facts),
        ].join('\n'),
        skip: [{ stageId: 'split-review', reason: '拆分多轮未通过审核，降级为 plain implement' }],
    }
}

/** The reported fallbacks, capped so one refusal stays readable. */
function fallbackLines(facts: GateFacts): string[] {
    const models = modelsOf(facts)
    if (models.problems.length === 0) return []
    const shown = models.problems.slice(0, 3).map((problem) => `- ${problem}`)
    if (models.problems.length > 3) shown.push(`- …（另有 ${models.problems.length - 3} 条，见 models.json 解析报告）`)
    return ['', `models.json（${models.file}）有 ${models.problems.length} 条回退/忽略，点名如下：`, ...shown]
}

/** Refuse a plan that cannot be sent for review, naming every problem. */
function planRefusal(detail: string, fix: string): GateOutcome {
    return { ok: false, state: 'BLOCK', detail, fix }
}

/**
 * The `split-plan` gate (exit of `split`).
 * @param facts - store, mission and the stage entry record.
 */
export function splitPlanOutcome(facts: GateFacts): GateOutcome {
    const missionId = facts.mission.id
    const stored = readSplitPlan(facts.store.layout, missionId)
    if (stored === undefined) {
        return planRefusal(
            `mission ${missionId} 还没有拆分计划（split/plan.json 缺失）：三道自动校验无从运行`,
            'planner 把拆分计划写到 missions/' + missionId + '/split/plan.json（tasks[{id,goal,paths,acceptance,dependsOn,parallel}]、coverage、parallelGroups），然后重新 advance 本阶段。',
        )
    }
    const validation = validateSplitPlan(stored.plan, facts.mission.spec ?? {})
    if (!validation.ok) {
        return planRefusal(
            [`三道自动校验未通过（${validation.problems.length} 项），本轮 plan 不予送审：`, ...validation.problems.map((problem) => `- ${problem.detail}`)].join('\n'),
            '按上面的 problem 修 plan.json：每条任务至少映射一条真实 AC；同一并行组内 paths 不相交；spec 的每条 AC 都被覆盖。修好后重新 advance。',
        )
    }
    const models = modelsOf(facts)
    const decision = decideSplit(stored.plan, models.config.split)
    const notes = fallbackLines(facts)
    if (decision.decision === 'too-large') {
        return planRefusal(
            [...decision.reasons, ...notes].join('\n'),
            `这项任务超出拆分上限（maxTasks=${models.config.split.maxTasks}、maxParallel=${models.config.split.maxParallel}，来自 ${models.file}）：应当拆成多个 mission 再分别执行。`,
        )
    }
    if (decision.decision === 'not-worth-splitting') {
        return {
            ok: true,
            state: 'PASS',
            detail: [...decision.reasons, '→ 跳过拆分（不建 worktree、不派 worker），直接 plain implement', ...notes].join('\n'),
            skip: [{ stageId: 'split-review', reason: decision.reasons[0] ?? '不值得拆分' }],
        }
    }
    const limit = reworkLimit(facts)
    if (limit.active) return degradePass(facts, limit, [`plan 摘要 ${stored.digest.slice(0, 12)}（${stored.plan.tasks.length} 条子任务）不再送审，也不建 worktree。`])
    return {
        ok: true,
        state: 'PASS',
        detail: [
            `拆分计划通过三道自动校验（${stored.plan.tasks.length} 条子任务、${stored.plan.parallelGroups.length} 个并行组），plan 摘要 ${stored.digest.slice(0, 12)}：等待 split-review 人工审核`,
            ...notes,
        ].join('\n'),
    }
}

/**
 * The `split-review` gate (exit of `split-review`).
 * @param facts - store, mission and the stage entry record.
 */
export function splitReviewOutcome(facts: GateFacts): GateOutcome {
    const status = splitReviewStatus(facts.store.layout, facts.mission.id)
    if (status.ok) return { ok: true, state: 'PASS', detail: status.detail }
    const models = modelsOf(facts)
    const rounds = models.config.split.maxReworkRounds
    const fix =
        status.state === 'missing-review'
            ? '重新调用 orchestrate({ action: "advance" }) 触发人工审核：审批通过后插件会写入审核记录；没有审批通道时会明确报"无审批通道"并 BLOCK，不会自动通过。'
            : status.state === 'rejected'
              ? `按审核意见重新拆分并再次送审（最多 ${rounds} 轮返工；用满 ${rounds} 轮后降级为 plain implement 并告警）。`
              : status.state === 'stale'
                ? 'plan 已改动：advance 会带着新摘要重新向人审核，通过后写入与新摘要匹配的审核记录（旧审核不算数）。'
                : '先在 split 阶段产出 missions/' + facts.mission.id + '/split/plan.json，再送审。'
    return planRefusal([status.detail, ...fallbackLines(facts)].join('\n'), fix)
}

/**
 * The `split-reviewed` gate (entry of `implement`).
 *
 * A mission without a plan is a plain implement and passes. With a plan, the
 * verdict is exactly "is this plan still the reviewed one" — a plan edited after
 * review blocks the dispatch, and the fix is a new review, never a bypass.
 * @param facts - store, mission and the stage entry record.
 */
export function splitReviewedOutcome(facts: GateFacts): GateOutcome {
    const stored = readSplitPlan(facts.store.layout, facts.mission.id)
    if (stored === undefined) {
        const notes = fallbackLines(facts)
        return { ok: true, state: 'PASS', detail: ['没有拆分计划：本 mission 走 plain implement（不建 worktree、不派 worker）', ...notes].join('\n') }
    }
    const decision = decideSplit(stored.plan, modelsOf(facts).config.split)
    if (decision.decision === 'not-worth-splitting') {
        return { ok: true, state: 'PASS', detail: `${decision.reasons[0] ?? '不值得拆分'}：走 plain implement，不要求拆分审核` }
    }
    // The allowance is used up: what the person rejected is not the plan draft
    // but the SPLIT itself, so the work continues plain — no worktree, no worker,
    // and therefore no unreviewed dispatch either.
    const limit = reworkLimit(facts)
    if (limit.active) {
        return {
            ok: true,
            state: 'PASS',
            detail: `拆分已被拒绝 ${limit.rejected} 轮（上限 maxReworkRounds=${limit.rounds}）：已降级为 plain implement——不建 worktree、不派 worker。`,
        }
    }
    const status = splitReviewStatus(facts.store.layout, facts.mission.id)
    if (status.ok) return { ok: true, state: 'PASS', detail: status.detail }
    return planRefusal(
        [status.detail, ...fallbackLines(facts)].join('\n'),
        'plan 改动后摘要会变：在 split-review 阶段重新审核（摘要必须与当前 plan 一致）后再进入 implement；未经审核的拆分不允许派发 worker。',
    )
}

/**
 * The transition guard for the stages whose entry condition is a split fact.
 *
 * The pipeline's entry gates are evaluated on the way OUT of a stage, so the
 * "may this stage be entered" question for `split-review` / `implement` is
 * answered here, BEFORE the predecessor is recorded as passed. That ordering is
 * the point: a stage must not be settled on the way into a stage it cannot
 * enter.
 * @param facts - store, mission and the stage entry record.
 * @param target - the stage the transition would enter.
 * @returns the refusal report, or `undefined` when the transition may happen.
 */
export function splitTransitionRefusal(facts: GateFacts, target: StageConfig): string | undefined {
    const outcome =
        target.gate.kind === 'split-review' ? splitPlanOutcome(facts) : target.gate.kind === 'split-reviewed' ? splitReviewedOutcome(facts) : undefined
    if (outcome === undefined || outcome.ok) return undefined
    return [
        `阶段 ${target.id} 不能进入：${outcome.detail}`,
        ...(outcome.fix === undefined ? [] : [`修复：${outcome.fix}`]),
        '',
        '下一步：处理上面的问题后重新调用 orchestrate({ action: "advance" })；前一个阶段不会被记为 passed。',
    ].join('\n')
}

/**
 * The split admission check of `team_delegate`.
 *
 * A repository that runs the split workflow (`split` → `split-review` →
 * `implement`) has already decided that implementation work is FIRST decomposed
 * and (when needed) reviewed. `team_delegate` used to ignore that decision: a
 * model could dispatch a `developer` child from ANY stage, so the two stages
 * could be skipped with one tool call while every gate downstream still reported
 * a green pipeline.
 *
 * The switch is read from the EFFECTIVE `models.json` (`split.enabled`, parsed
 * by `dsh-eng-core` — one parser, not a second copy of the section). Three
 * outcomes, and only the third is new behaviour:
 *
 *  - `split.enabled` is not `true` (absent, `false`, unreadable) → the check
 *    does nothing at all. Every deployment that never enabled splitting keeps
 *    its exact previous behaviour.
 *  - no bound mission → not blocked: a delegation outside a mission has no
 *    split stage to have skipped. One log line records that the gate stood
 *    aside (docs/ARCHITECTURE.md §5.38.5).
 *  - bound mission in any stage other than `implement` → REFUSED; and in
 *    `implement`, a `split/plan.json` on disk must carry an `approved`
 *    `split/review.json` whose `planDigest` is the CURRENT plan digest. A stale
 *    review (the plan changed after approval) is a refusal, not a warning.
 *
 * "No plan on disk" is admitted on purpose: `not-worth-splitting` / a rework
 * budget that ran out is the legitimate route to plain `implement`, and both are
 * decided — and recorded — by the split stage. Deleting a plan is therefore not
 * a bypass route the check needs to police; skipping the stage is, and that is
 * what the stage assertion rejects.
 *
 * @module dsh-role-guard/split-gate
 */

import type { AgentLike, Layout, MissionRecord, MissionStore, MissionStoreRegistry } from 'dsh-eng-core'
import { parentSessionIdOf, sessionIdOf } from 'dsh-eng-core'
import { loadModelsConfig, readSplitPlan, splitReviewStatus } from 'dsh-eng-core/split'

/** The slice of the tool deps this module needs. */
export interface SplitGateInput {
    /** The workspace layout of the CALLING agent (same one the mission store uses). */
    layout: Layout
    /** The delegating agent; its session owns the mission binding. */
    agent: AgentLike | undefined
    /** Mission store registry (the same one every other decision reads). */
    stores: MissionStoreRegistry
    /** A logger, for the stood-aside paths (never a gate decision). */
    logger?: { warn: (message: string, error?: unknown) => void; info?: (message: string) => void }
}

/** What the admission check decided. */
export interface SplitGateResult {
    /** `true` when the repository declares `split.enabled=true`. */
    enabled: boolean
    /** Why the dispatch is refused (absent = it may start a child). */
    refusal?: string
    /** A reported degradation (never a refusal). */
    warning?: string
    /** The bound mission, when the check found one. */
    missionId?: string
}

/** The project-level switch, as one phrase in every refusal. */
const SWITCH = 'models.json 的 split.enabled=true'

/** The standing of the switch plus any parse problem worth REPORTING. */
function switchStanding(layout: Layout, logger: SplitGateInput['logger']): { enabled: boolean; warning?: string } {
    try {
        const models = loadModelsConfig(layout)
        // A typo in the switch itself must be visible: `"enabled": "true"` is
        // reported by the parser and read as "off" (never guessed into `true`).
        const wrong = models.problems.find((problem) => problem.includes('.enabled'))
        if (wrong !== undefined) return { enabled: false, warning: `拆分准入检查：${wrong}（按未开启处理，本次未校验 split 阶段）` }
        return { enabled: models.config.split.enabled === true }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const message = `拆分准入检查读不到 models.json（${layout.configDir}）：${detail}（按未开启拆分处理，本次未校验 split 阶段）`
        try {
            logger?.warn(message, error)
        } catch {
            // A logger must never decide a gate.
        }
        return { enabled: false, warning: message }
    }
}

/** The mission id a session (or its parent) is still bound to. */
function danglingBinding(store: MissionStore, agent: AgentLike | undefined): string | undefined {
    const own = store.activeMissionId(sessionIdOf(agent))
    return own ?? store.activeMissionId(parentSessionIdOf(agent))
}

/**
 * The calling session's bound mission, or a fail-closed refusal when unreadable.
 *
 * `resolveForAgent` reports "no binding" and "bound to a record that cannot be
 * read" as the same `undefined`. Those are different facts for an admission
 * check: an UNBOUND session has no split stage to have skipped (admitted, see
 * {@link splitAdmission}), while a DANGLING binding is broken state — the
 * session was working on a mission and the record is gone. The second one is a
 * refusal, otherwise a corrupted `mission.json` would be a silent bypass.
 */
function boundMission(input: SplitGateInput): { mission?: MissionRecord; refusal?: string } {
    try {
        const store = input.stores.for(input.layout.cwd)
        const mission = store.resolveForAgent(input.agent)
        if (mission !== undefined) return { mission }
        const dangling = danglingBinding(store, input.agent)
        return dangling === undefined ? {} : { refusal: danglingRefusal(dangling) }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
            refusal: [
                `team_delegate 拒绝：本仓库开启了拆分（${SWITCH}），但读不出当前 mission，无法证明这次派发经过了 split 与 split-review。`,
                `- 问题：${detail}`,
                '- 下一步：修好 mission / session 状态（<布局根>/missions/、<布局根>/state/sessions/）后重试；读不到不等于没开拆分。',
            ].join('\n'),
        }
    }
}

/** The refusal for "the session is bound to a mission whose record cannot be read". */
function danglingRefusal(missionId: string): string {
    return [
        `team_delegate 拒绝：本仓库开启了拆分（${SWITCH}），但会话绑定的 mission ${missionId} 读不出来，无法证明这次派发经过了 split 与 split-review。`,
        '- 问题：<布局根>/state/sessions/ 的绑定指向了一个读不出的 mission 记录（mission.json 缺失或损坏）',
        '- 下一步：修好 <布局根>/missions/ 下该 mission 的记录（或解绑会话）后重试；读不到不等于没开拆分。',
    ].join('\n')
}

/** The refusal for "not in `implement` yet". */
function stageRefusal(mission: MissionRecord, planDigest: string | undefined): string {
    const stage = mission.stage === undefined || mission.stage === '' ? '(未记录)' : mission.stage
    const digest = planDigest === undefined ? '- 当前 plan 摘要：(还没有 split/plan.json)' : `- 当前 plan 摘要：${planDigest.slice(0, 12)}（split/plan.json）`
    return [
        `team_delegate 拒绝：本仓库开启了拆分（${SWITCH}），派发前必须先经过 split 的拆分与 split-review 的审核；当前阶段 ${stage} 不允许派单。`,
        `- 当前阶段：${stage}（mission ${mission.id}）—— 只有 implement 阶段才允许派单`,
        digest,
        '- 缺少的步骤：先走 split 阶段产出 split/plan.json（planner 拆分 + 四道自动校验），需要审核时再由人完成 split-review，然后才能进入 implement',
        '- 下一步：开启拆分后必须先 advance 到 split 完成拆分与审核（orchestrate({ action: "advance" }) 按流水线推进），再重试本次 team_delegate',
        '- 合法路径：拆分被判定"不值得拆"/轮数超限降级 plain implement 也是合法路径，但必须先经过 split 阶段的判定，不能跳过——跳过 split 直接派单就是这里拒绝的行为',
    ].join('\n')
}

/** The refusal for "a plan is on disk but no valid approval covers it". */
function reviewRefusal(mission: MissionRecord, planDigest: string, status: ReturnType<typeof splitReviewStatus>): string {
    const current = (status.planDigest ?? planDigest).slice(0, 12)
    const reviewed = status.record === undefined ? '' : `；审核记录引用的是 ${status.record.planDigest.slice(0, 12)}`
    return [
        `team_delegate 拒绝：split/plan.json 还没有通过审核（${status.state}），未审核的计划不能派发。`,
        `- 当前阶段：${mission.stage ?? '(未记录)'}（mission ${mission.id}）`,
        `- 当前 plan 摘要：${current}（split/plan.json${reviewed}）`,
        `- 缺少的步骤：split/review.json 必须 decision=approved 且 planDigest 等于当前 plan 摘要；当前：${status.detail}`,
        `- 下一步：把当前 plan 重新送审（进入 split-review 完成人工审核，或重新拆一次），让审核记录引用摘要 ${current}，再重试本次派发`,
        '- 合法路径：拆分被判定"不值得拆"/轮数超限降级 plain implement 也是合法路径，但必须先经过 split 阶段的判定（并由 split-review 记录），不能跳过；带着未审核或已过期的 plan 派单同样被拒绝',
    ].join('\n')
}

/** Stage + plan admission for ONE bound mission. */
function missionGate(input: SplitGateInput, mission: MissionRecord, switchWarning: string | undefined): SplitGateResult {
    const plan = readSplitPlan(input.layout, mission.id)
    const base: SplitGateResult = {
        enabled: true,
        missionId: mission.id,
        ...(switchWarning === undefined ? {} : { warning: switchWarning }),
    }
    if (mission.stage !== 'implement') return { ...base, refusal: stageRefusal(mission, plan?.digest) }
    if (plan === undefined) return base
    const status = splitReviewStatus(input.layout, mission.id)
    // `missing-plan` here can only be a race with a concurrent delete: the same
    // no-plan rule applies, so it stays admitted (`ok` covers the approved case).
    if (status.ok || status.state === 'missing-plan') return base
    return { ...base, refusal: reviewRefusal(mission, plan.digest, status) }
}

/**
 * Decide whether one `team_delegate` call may start a child.
 * @param input - layout, calling agent, mission store and logger.
 * @returns the decision; a `refusal` means "do not start any child".
 */
export function splitAdmission(input: SplitGateInput): SplitGateResult {
    const standing = switchStanding(input.layout, input.logger)
    if (!standing.enabled) return { enabled: false, ...(standing.warning === undefined ? {} : { warning: standing.warning }) }
    if (input.agent === undefined) return { enabled: true, ...(standing.warning === undefined ? {} : { warning: standing.warning }) }
    const bound = boundMission(input)
    if (bound.refusal !== undefined) return { enabled: true, refusal: bound.refusal }
    if (bound.mission === undefined) {
        // Documented stood-aside path: a delegation with no mission has no split
        // stage to have skipped, and stranding non-mission work is worse than the
        // (already impossible to express) bypass.
        try {
            input.logger?.info?.(
                'team_delegate：仓库开启了拆分，但调用方没有绑定 mission —— 按"未绑定"处理，本次派发未校验 split 阶段（docs/ARCHITECTURE.md §5.38.5）。',
            )
        } catch {
            // A logger must never decide a gate.
        }
        return { enabled: true, ...(standing.warning === undefined ? {} : { warning: standing.warning }) }
    }
    return missionGate(input, bound.mission, standing.warning)
}

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
 * The switch is READ FROM THE ORCHESTRATOR SERVICE (`effectiveSplit(cwd)`): the
 * project's `models.json` decides, the profile is only its default, and both
 * plugins decide with the SAME value — the old "两处都开" gap (role-guard parsed
 * `models.json` itself while the orchestrator used its profile) cannot reopen
 * from either side. A host without that service (old host / single-plugin
 * install) falls back to reading the project file here, and the fallback is
 * LOGGED with its reason (AC-003): the fallback still enforces the project's
 * switch, it is a degraded read, never a bypass.
 *
 * Three outcomes, and only the third is new behaviour:
 *
 *  - the effective switch is not `true` (absent, `false`, unreadable) → the check
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
    /**
     * The orchestrator service accessor (`ctx.get('orchestrator')`), read per
     * call. Its `effectiveSplit(cwd)` is the ONE effective switch; absent or
     * broken = the documented fallback below.
     */
    orchestrator?: () => unknown
    /** A logger, for the stood-aside paths (never a gate decision). */
    logger?: { warn: (message: string, error?: unknown) => void; info?: (message: string) => void }
}

/** What the admission check decided. */
export interface SplitGateResult {
    /** `true` when the repository's effective switch says it runs the split workflow. */
    enabled: boolean
    /** Where that switch was read from: the orchestrator service, or the fallback read of `models.json`. */
    source?: 'service' | 'project'
    /** Why the dispatch is refused (absent = it may start a child). */
    refusal?: string
    /** A reported degradation (never a refusal). */
    warning?: string
    /** The bound mission, when the check found one. */
    missionId?: string
}

/** The effective-split answer this check reads from the orchestrator service. */
export interface EffectiveSplitLike {
    enabled?: unknown
    /** Where the switch came from (`project` / `profile` / `default`), for the report. */
    source?: unknown
    /** Reported fallbacks, when the service exposes them. */
    problems?: unknown
}

/** The effective switch + where it was read + anything worth REPORTING. */
interface SwitchStanding {
    enabled: boolean
    source: 'service' | 'project'
    warning?: string
}

/** The switch, as one phrase in every refusal (the project decides, the profile is the default). */
const SWITCH = '本仓库的拆分已开启（项目 models.json 的 split.enabled 决定，profile 只作缺省）'

/** Why the orchestrator service could not be used (the fallback's logged reason). */
interface ServiceMiss {
    reason: string
}

/** Read the SERVICE's effective switch, or say why that was impossible. */
function serviceStanding(input: SplitGateInput): SwitchStanding | ServiceMiss {
    if (input.orchestrator === undefined) return { reason: '调用方没有接线 orchestrator 服务访问器' }
    try {
        const service = input.orchestrator() as { effectiveSplit?: (cwd?: string) => EffectiveSplitLike | undefined } | undefined
        if (service === undefined) return { reason: '宿主没有挂载 orchestrator 服务（旧宿主或单插件安装）' }
        if (typeof service.effectiveSplit !== 'function') return { reason: 'orchestrator 服务没有 effectiveSplit（旧版本插件）' }
        const resolved = service.effectiveSplit(input.layout.cwd)
        if (resolved === undefined || typeof resolved.enabled !== 'boolean') {
            return { reason: 'orchestrator.effectiveSplit 返回了不可用的结果（enabled 不是布尔值）' }
        }
        const problems = Array.isArray(resolved.problems) ? resolved.problems : []
        const wrong = problems.find((problem) => typeof problem === 'string' && problem.includes('.enabled'))
        const warning = typeof wrong === 'string' ? `拆分准入检查：${wrong}（按未开启处理，本次未校验 split 阶段）` : undefined
        return { enabled: resolved.enabled, source: 'service', ...(warning === undefined ? {} : { warning }) }
    } catch (error) {
        return { reason: `读取 orchestrator.effectiveSplit 抛错（${error instanceof Error ? error.message : String(error)}）` }
    }
}

/** The documented fallback (AC-003): read the PROJECT file here — still enforced, never a bypass. */
function projectStanding(input: SplitGateInput): SwitchStanding {
    try {
        const models = loadModelsConfig(input.layout)
        // A typo in the switch itself must be visible: `"enabled": "true"` is
        // reported by the parser and read as "off" (never guessed into `true`).
        const wrong = models.problems.find((problem) => problem.includes('.enabled'))
        if (wrong !== undefined) return { enabled: false, source: 'project', warning: `拆分准入检查：${wrong}（按未开启处理，本次未校验 split 阶段）` }
        return { enabled: models.config.split.enabled === true, source: 'project' }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const message = `拆分准入检查读不到 models.json（${input.layout.configDir}）：${detail}（按未开启拆分处理，本次未校验 split 阶段）`
        try {
            input.logger?.warn(message, error)
        } catch {
            // A logger must never decide a gate.
        }
        return { enabled: false, source: 'project', warning: message }
    }
}

/** The effective switch: the orchestrator SERVICE first, the project file as the logged fallback. */
function switchStanding(input: SplitGateInput): SwitchStanding {
    const read = serviceStanding(input)
    if ('enabled' in read) return read
    try {
        input.logger?.info?.(
            `拆分准入检查：读不到 orchestrator 的生效拆分配置（${read.reason}），回退自读项目 models.json（${input.layout.configDir}）——回退仍按项目文件拦截，不是"跳过拆分"。`,
        )
    } catch {
        // A logger must never decide a gate.
    }
    return projectStanding(input)
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
                `team_delegate 拒绝：${SWITCH}，但读不出当前 mission，无法证明这次派发经过了 split 与 split-review。`,
                `- 问题：${detail}`,
                '- 下一步：修好 mission / session 状态（<布局根>/missions/、<布局根>/state/sessions/）后重试；读不到不等于没开拆分。',
            ].join('\n'),
        }
    }
}

/** The refusal for "the session is bound to a mission whose record cannot be read". */
function danglingRefusal(missionId: string): string {
    return [
        `team_delegate 拒绝：${SWITCH}，但会话绑定的 mission ${missionId} 读不出来，无法证明这次派发经过了 split 与 split-review。`,
        '- 问题：<布局根>/state/sessions/ 的绑定指向了一个读不出的 mission 记录（mission.json 缺失或损坏）',
        '- 下一步：修好 <布局根>/missions/ 下该 mission 的记录（或解绑会话）后重试；读不到不等于没开拆分。',
    ].join('\n')
}

/** The refusal for "not in `implement` yet". */
function stageRefusal(mission: MissionRecord, planDigest: string | undefined): string {
    const stage = mission.stage === undefined || mission.stage === '' ? '(未记录)' : mission.stage
    const digest = planDigest === undefined ? '- 当前 plan 摘要：(还没有 split/plan.json)' : `- 当前 plan 摘要：${planDigest.slice(0, 12)}（split/plan.json）`
    return [
        `team_delegate 拒绝：${SWITCH}，派发前必须先经过 split 的拆分与 split-review 的审核；当前阶段 ${stage} 不允许派单。`,
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
function missionGate(input: SplitGateInput, mission: MissionRecord, standing: SwitchStanding): SplitGateResult {
    const plan = readSplitPlan(input.layout, mission.id)
    const base: SplitGateResult = {
        enabled: true,
        source: standing.source,
        missionId: mission.id,
        ...(standing.warning === undefined ? {} : { warning: standing.warning }),
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
    const standing = switchStanding(input)
    const base: SplitGateResult = {
        enabled: standing.enabled,
        source: standing.source,
        ...(standing.warning === undefined ? {} : { warning: standing.warning }),
    }
    if (!standing.enabled) return base
    if (input.agent === undefined) return base
    const bound = boundMission(input)
    if (bound.refusal !== undefined) return { ...base, refusal: bound.refusal }
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
        return base
    }
    return missionGate(input, bound.mission, standing)
}

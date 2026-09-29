/**
 * The composition boundary with the official Agent Teams capability
 * (`@deepseek-ai/dsh-experimental-agent-team`, service `agentTeams`, plus its
 * model-facing tools in `@deepseek-ai/dsh-experimental-tool-agent-team`, both
 * harness 0.2.0-rc.1).
 *
 * What the official surface actually is (read from `lib/types/*.d.ts` and
 * `lib/index.js` of the installed packages):
 *
 *  - `agentTeams.spawnTeammate(caller: Agent, request)` IS a programmatic spawn,
 *    callable from a plugin. But `SpawnTeammateRequest` is only
 *    `{ name, description, prompt, context: 'fresh' | 'fork', provider, signal }`:
 *    it carries **no delegation request**. The service forwards
 *    `{ prompt, parent }` to `ctx.subagents.startContinuable`, which composes the
 *    child with `resolveChildAgentOptions(parent, undefined, depth)` and
 *    `{ persona: undefined, toolFilter: undefined }`. The teammate therefore
 *    inherits the Lead's provider/model and its **entire** tool surface, and runs
 *    under the DEPLOYMENT persona.
 *  - `ctx.subagents.startContinuable` itself DOES accept `persona`, `toolFilter`,
 *    `agentOptions` and `maxDepth` — the official spawn simply cannot hand any of
 *    them over. That is the exact gap: the official request type would have to
 *    carry the delegation request (or the service would have to expose an
 *    "adopt this governed child" operation) before a role could survive it.
 *  - The service emits **no events of its own**. It writes four durable SESSION
 *    events into the Team Lead's log — `team/member`, `team/task`,
 *    `team/message/queued`, `team/message/delivered` — and it *listens* to
 *    `agent/created`, `agent/status` and `session/event`. A plugin therefore
 *    hooks the collaboration surface by observing `session/event` and filtering
 *    `event.type === 'team/member'` (see `teammates.ts`).
 *
 * Consequence, and why this module exists: the official spawn cannot carry any
 * guarantee `team_delegate` owns, so a team-style dispatch is **refused** and
 * served by our own `ctx.subagents.start()` path, naming the guarantees that
 * could not be expressed. The refusal list is data-driven, so a harness that
 * grows the fields shrinks it — but the persona entry is structural: both role
 * parsers REJECT a role without a persona (an empty persona is a parse error),
 * and `SpawnTeammateRequest` has no persona field. Today the list is never
 * empty, and `spawnTeammate` is therefore **probed but never invoked**.
 *
 * @module dsh-role-guard/agent-teams
 */

import type { RoleGuardConfig } from './config.js'
import type { EffectiveRoute } from './route.js'
import type { Role } from './roles.js'
import type { ToolFilterPlan } from './tools.js'

/** The slice of `agentTeams` this plugin probes. Presence only; it is never called. */
export interface AgentTeamsLike {
    /**
     * Harness 0.2.0-rc.1 exposes
     * `spawnTeammate(caller: Agent, request: SpawnTeammateRequest)`.
     *
     * Typed `unknown` on purpose: this plugin only answers "does a programmatic
     * spawn exist at all", and it must not encode a call shape it has decided
     * never to use.
     */
    spawnTeammate?: unknown
}

/** What the mounted service can do for a governed delegation. */
export type AgentTeamsAvailability =
    /** No service mounted. */
    | 'absent'
    /** Mounted, but with no programmatic spawn (only the model-facing tools' backing store). */
    | 'no-programmatic-spawn'
    /** Mounted and exposing `spawnTeammate` — still refused, see the module doc. */
    | 'programmatic-spawn'

/**
 * Probe what the mounted service exposes, without ever calling it.
 *
 * Total and defensive: a partial or hostile service object (a throwing getter,
 * a non-function, `null`) degrades to {@link AgentTeamsAvailability} instead of
 * breaking assembly or a delegation.
 * @param teams - `ctx.get('agentTeams')`, or anything else.
 */
export function agentTeamsAvailability(teams: unknown): AgentTeamsAvailability {
    if (teams === undefined || teams === null) return 'absent'
    try {
        return typeof (teams as AgentTeamsLike).spawnTeammate === 'function' ? 'programmatic-spawn' : 'no-programmatic-spawn'
    } catch {
        return 'no-programmatic-spawn'
    }
}

/**
 * The guarantees the official teammate spawn cannot express for one delegation.
 *
 * Each entry names the guarantee AND the missing API field, so the report tells
 * a reader what would have to change in the harness — not merely that
 * "something" was refused.
 * @param role - the resolved role.
 * @param plan - the planned provider tool filter.
 * @param route - the effective model route.
 * @returns the named guarantees; empty only if the harness learns to carry them.
 */
export function unexpressibleGuarantees(role: Role, plan: ToolFilterPlan, route: EffectiveRoute): string[] {
    const missing: string[] = []
    // Structural, and deliberately first: every role this plugin can load has a
    // non-empty persona (both `parseRole` and `roleFromConfig` reject an empty
    // one), a teammate's persona section is a SHADOWING section registered by
    // the host, and `SpawnTeammateRequest` has no persona field at all. Putting
    // the persona text into the prompt instead is not the same guarantee: the
    // deployment persona would still be in force beside it.
    missing.push('persona 影子段（`SpawnTeammateRequest` 没有 persona 字段；每个角色都必须有 persona，teammate 会跑在部署 persona 下）')
    if (plan.filter?.allow !== undefined || plan.filter?.deny !== undefined) {
        missing.push('工具白名单（`SpawnTeammateRequest` 没有 toolFilter 字段；teammate 会继承 Lead 的全部工具——只读模式的降权也靠这个白名单）')
    }
    if (Object.keys(route).length > 0) {
        missing.push('模型路由（`SpawnTeammateRequest` 没有 agentOptions 字段；teammate 会继承 Lead 的 provider/model）')
    }
    if (role.skills.length > 0) {
        missing.push(
            '技能白名单（绑定必须写在 teammate 第一轮之前，而官方 spawn 只在创建完成后才给出会话 id；用官方路径会让这条策略被赛跑）',
        )
    }
    return missing
}

/** Everything the report needs about one team-style dispatch request. */
export interface TeamDispatchRequest {
    /** `composeWithAgentTeams` as resolved. */
    compose: RoleGuardConfig['composeWithAgentTeams']
    /** `ctx.get('agentTeams')`, read per call. */
    teams: unknown
    role: Role
    plan: ToolFilterPlan
    route: EffectiveRoute
}

/**
 * The report `team_delegate` prints for a team-style dispatch request: which
 * creation path was used, and — when the official path was refused — which
 * guarantee it cannot express, plus what the harness would have to change.
 *
 * Pure and total: it never calls the service, and it returns a report for every
 * case (including `composeWithAgentTeams: 'off'`), because the caller asked a
 * question that must not be answered silently.
 * @param request - the composed request, its role, filter plan and route.
 * @returns the report block (one line plus the named guarantees).
 */
export function teamDispatchReport(request: TeamDispatchRequest): string {
    if (request.compose === 'off') {
        return 'dispatch path: subagents（请求 team：composeWithAgentTeams: off，官方 Agent Teams 路径未启用；本插件的路径不受影响）'
    }
    const availability = agentTeamsAvailability(request.teams)
    if (availability === 'absent') {
        return 'dispatch path: subagents（请求 team：宿主没有挂载 agentTeams 服务；官方路径不可用，改用本插件路径）'
    }
    if (availability === 'no-programmatic-spawn') {
        return 'dispatch path: subagents（请求 team：挂载的 agentTeams 服务没有 programmatic spawn（`spawnTeammate`），它只是模型工具的底座，插件无法经它创建 teammate；改用本插件路径）'
    }
    const missing = unexpressibleGuarantees(request.role, request.plan, request.route)
    return [
        'dispatch path: subagents（请求 team：**拒绝** `agentTeams.spawnTeammate`——它无法表达该角色的这些保证：',
        ...missing.map((entry) => `  - ${entry}`),
        '按最小权限改用本插件路径（未创建 teammate；persona/工具白名单/模型路由照常由宿主强制）。',
        '要让官方路径可用，`SpawnTeammateRequest` 必须带上委派请求（persona / toolFilter / agentOptions / maxDepth），',
        '或让服务提供"接管一个已按角色创建的子会话"的操作。',
    ].join('\n')
}

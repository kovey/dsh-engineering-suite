/**
 * The composition boundary with the host's Agent Teams capability.
 *
 * What the installed host actually exposes (read from
 * `dsh-agent-team/lib/types/index.d.ts` of the installed package, harness
 * 0.2.2-rc.2):
 *
 *  - The service is `agentTeams`, declared by `@deepseek-ai/dsh-agent-team`
 *    (`class TeamService extends TypertRemoteService`), and its whole public
 *    surface is `isEnabled` / `setEnabled` / `createTask` / `getTask` /
 *    `listTasks` / `updateTask`: an on/off Team selection per subagent tree plus
 *    a shared task board journaled into the Team Lead's session log. **No member
 *    creates a teammate** — every one of them either reads/writes team state or
 *    takes an already-live `Agent` as its caller. There is therefore no
 *    programmatic dispatch to compose with, and this module no longer probes for
 *    one (it used to probe a name the host does not declare, so the probe could
 *    only ever answer "absent").
 *  - Teammates are created by the model-facing tools of
 *    `@deepseek-ai/dsh-tool-agent-team` (`spawn_teammate` and friends), not by a
 *    service call a plugin could make. Those tools carry no persona, tool
 *    whitelist, model route or permission parameter, so a teammate they create
 *    inherits the Lead's provider/model and its **entire** tool surface, and
 *    runs under the DEPLOYMENT persona.
 *  - `ctx.subagents.startActivation` (0.2.2-rc.1) carries only `agentPreset` as
 *    a policy entry: `persona` and `toolFilter` are no longer request fields,
 *    they are enforced by plugins the selected preset mounts in the child's
 *    scope (see `presets.ts` / `scope.ts`). That is what this plugin's own
 *    dispatch path uses.
 *  - The service emits **no events of its own**. It writes four durable SESSION
 *    events into the Team Lead's log — `team/member`, `team/task`,
 *    `team/message/queued`, `team/message/delivered` — and it *listens* to
 *    `agent/created`, `agent/status` and `session/event`. A plugin therefore
 *    hooks the collaboration surface by observing `session/event` and filtering
 *    `event.type === 'team/member'` (see `teammates.ts`).
 *
 * Consequence, and why this module exists: `agentTeams` is a collaboration
 * surface (a selection and a task board), **not a dispatch channel**, so a
 * team-style dispatch is answered by naming that and is served by this plugin's
 * own `startActivation + Agent Preset` path. The guarantee list is data-driven,
 * so a host that grows a teammate-creation operation carrying the delegation
 * request shrinks it — but the persona entry is structural: both role parsers
 * REJECT a role without a persona (an empty persona is a parse error), and no
 * surface above takes a persona at all.
 *
 * @module dsh-role-guard/agent-teams
 */

import type { RoleGuardConfig } from './config.js'
import type { EffectiveRoute } from './route.js'
import type { Role } from './roles.js'
import type { ToolFilterPlan } from './tools.js'

/**
 * The documented members of the installed `agentTeams` service
 * (`@deepseek-ai/dsh-agent-team`), presence-only. Typed `unknown` on purpose:
 * this plugin asks whether the documented shape is there, and must not encode a
 * call shape it has decided never to use.
 */
export interface AgentTeamsLike {
    /** Read the Team selection shared by the caller's subagent tree. */
    isEnabled?: unknown
    /** Save a root Session's Team selection. */
    setEnabled?: unknown
    /** Create one unowned pending task in the Team Lead log. */
    createTask?: unknown
    /** Return one task, including a deleted tombstone. */
    getTask?: unknown
    /** List current non-deleted tasks in numeric creation order. */
    listTasks?: unknown
    /** Compare-and-set one authorized task transition. */
    updateTask?: unknown
}

/** The member set the installed `TeamService` declares. */
const TEAM_SERVICE_MEMBERS = ['isEnabled', 'setEnabled', 'createTask', 'getTask', 'listTasks', 'updateTask'] as const

/** What the mounted service is to a governed delegation. */
export type AgentTeamsAvailability =
    /** No service mounted. */
    | 'absent'
    /** Mounted with the documented shape: an on/off selection + a shared task board. */
    | 'task-graph'
    /** Mounted, but not the documented shape (a partial or foreign object). */
    | 'unrecognised'

/**
 * Classify what is mounted under `agentTeams`, without ever calling it.
 *
 * The dispatch verdict is the same for both mounted outcomes — neither creates a
 * teammate — so this only decides how much the report may claim to know: the
 * documented shape is named member by member, anything else is reported as
 * "not a dispatch path either, but I cannot name what it is".
 *
 * Total and defensive: a partial or hostile service object (a throwing getter,
 * a non-function, `null`) degrades to {@link AgentTeamsAvailability} instead of
 * breaking assembly or a delegation.
 * @param teams - `ctx.get('agentTeams')`, or anything else.
 */
export function agentTeamsAvailability(teams: unknown): AgentTeamsAvailability {
    if (teams === undefined || teams === null) return 'absent'
    try {
        const service = teams as AgentTeamsLike
        // Presence only: nothing is invoked, and no member's signature is encoded.
        return TEAM_SERVICE_MEMBERS.every((member) => typeof service[member] === 'function') ? 'task-graph' : 'unrecognised'
    } catch {
        return 'unrecognised'
    }
}

/**
 * The guarantees a role needs that the host's teammate surface cannot express
 * for one delegation.
 *
 * Each entry names the guarantee AND the missing surface, so the report tells a
 * reader what would have to change in the host — not merely that "something" was
 * refused.
 * @param role - the resolved role.
 * @param plan - the planned provider tool filter.
 * @param route - the effective model route.
 * @returns the named guarantees; empty only if the host learns to carry them.
 */
export function unexpressibleGuarantees(role: Role, plan: ToolFilterPlan, route: EffectiveRoute): string[] {
    const missing: string[] = []
    // Structural, and deliberately first: every role this plugin can load has a
    // non-empty persona (both `parseRole` and `roleFromConfig` reject an empty
    // one), a teammate's persona section is a SHADOWING section registered by
    // the host, and no host surface for creating a teammate takes a persona at
    // all. Putting the persona text into the prompt instead is not the same
    // guarantee: the deployment persona would still be in force beside it.
    missing.push('persona 影子段（宿主没有创建 teammate 的请求，自然也没有 persona 字段；每个角色都必须有 persona，宿主工具创建的 teammate 会跑在部署 persona 下）')
    if (plan.filter?.allow !== undefined || plan.filter?.deny !== undefined) {
        missing.push('工具白名单（宿主没有 toolFilter 入口；teammate 会继承 Lead 的全部工具——只读模式的降权也靠这个白名单）')
    }
    if (Object.keys(route).length > 0) {
        missing.push('模型路由（宿主没有 agentOptions 入口；teammate 会继承 Lead 的 provider/model）')
    }
    if (role.skills.length > 0) {
        missing.push(
            '技能白名单（本插件按派发绑定强制，绑定写在 team_delegate 拿到子会话 id 之后；宿主工具创建的 teammate 不经过这条派发路径、没有绑定，技能门禁按"无绑定 = 不归我管"放行）',
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
 * creation path was used, and — when the host path was not used — why
 * (`agentTeams` is not a dispatch channel) plus the guarantees a role needs and
 * what the host would have to change to carry them.
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
    if (availability === 'unrecognised') {
        return 'dispatch path: subagents（请求 team：挂载的 agentTeams 不是「开关 + 任务图」的服务形状，也没有创建 teammate 的操作；插件无法经它派发，改用本插件路径）'
    }
    const missing = unexpressibleGuarantees(request.role, request.plan, request.route)
    return [
        'dispatch path: subagents（请求 team：agentTeams 不是派发通道——它只提供 Team 开关与共享任务图（isEnabled/setEnabled/createTask/getTask/listTasks/updateTask），**没有创建 teammate 的 API**，所以这些保证无处施加：',
        ...missing.map((entry) => `  - ${entry}`),
        '按最小权限改用本插件路径（未创建 teammate；persona/工具白名单/模型路由照常由宿主强制）。',
        '要让官方路径可用，宿主必须提供一个创建 teammate 的操作，且该请求要能带上委派请求（persona / toolFilter / agentOptions / maxDepth），',
        '或提供"接管一个已按角色创建的子会话"的入口。',
    ].join('\n')
}

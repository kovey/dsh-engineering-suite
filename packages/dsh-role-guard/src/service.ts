/**
 * The `role-guard` service seam: let another plugin plan a delegation from a
 * role WITHOUT going through the model.
 *
 * `team_delegate` is the model-facing path. Autonomous dispatchers (the
 * orchestrator entering a stage, for example) need the same answer — persona,
 * host-enforced tool filter, model route — but there is no model in the loop to
 * call a tool. This service is that answer, and it enforces the SAME gates:
 *
 *  - a role whose definition file failed to parse is REFUSED (skipping this
 *    would silently fall back to the builtin role of the same id, turning a
 *    broken "demotion" file into an escalation);
 *  - a read-only role without a tool whitelist is REFUSED (a `deny` list can
 *    only subtract names it knows, so "read-only" would otherwise inherit every
 *    write tool this deployment has);
 *  - a whitelist that survives as empty is still a filter, never "no filter".
 *
 * It also exposes `bind`, because the skill whitelist is enforced from the
 * child's binding record: a child created without one escapes the skill gate.
 *
 * @module dsh-role-guard/service
 */

import fs from 'node:fs'
import type { AgentLike, Layout, LayoutOptions, MissionStoreRegistry } from 'dsh-eng-core'
import type { RoleBinding, RoleBindingStore } from './bindings.js'
import { roleRoute, resolveRoute, type EffectiveRoute } from './route.js'
import type { Role } from './roles.js'
import { recordStageDelegation } from './stage-delegations.js'
import { filterRefusal, planToolFilter, type FilterConfig, type ToolFilterPlan } from './tools.js'

/** One role resolved for another plugin. */
export interface RolePlan {
    role: string
    /** The role's persona text (empty when the role declares none). */
    persona: string
    mode: Role['mode']
    /** `undefined` = the role declares no filter at all (inherit the caller's). */
    toolFilter?: ToolFilterPlan['filter']
    /** Whitelist entries naming tools this deployment does not expose. */
    dropped: string[]
    /** The role's tool whitelist, as declared. */
    tools: readonly string[]
    /**
     * The role's skill whitelist (empty = unrestricted). Carried so a dispatcher
     * can see it; enforced through {@link RoleGuardService.bind}.
     */
    skills: readonly string[]
    /** The route this child should run on (role file; no call override here). */
    route: EffectiveRoute
    source: string
}

/** What a caller must tell the planner for the answer to be safe. */
export interface RolePlanRequest {
    /** Role id; unknown, broken and unsafe roles are refused. */
    role: string
    /** Workspace whose `.dsh/roles/` layer should be consulted. */
    cwd?: string
    /** The agent the delegation would happen for (used for tool visibility). */
    agent?: AgentLike
}

/** The service surface another plugin consumes. */
export interface RoleGuardService {
    /** Resolve one role into a delegation plan. Throws when it must be refused. */
    plan(request: RolePlanRequest): RolePlan
    /** Role ids currently defined for a workspace. */
    list(cwd?: string): string[]
    /**
     * Record the role that created one child session.
     *
     * Mandatory for an autonomous dispatcher: the skill whitelist is enforced by
     * looking this record up for the child's session, so a child created without
     * a binding can load any skill its tool surface allows.
     * @returns the written binding, or `undefined` when it could not be stored
     *   (the caller must report it: it means no skill enforcement for that child).
     */
    bind(request: { role: string; sessionId: string; cwd?: string; agent?: AgentLike }): RoleBinding | undefined
}

/** Collaborators the planner closes over (all owned by the plugin). */
export interface RolePlannerDeps {
    /** The role registry, already bound to the caller's workspace. */
    rolesFor: (layout: Layout) => {
        get: (id: string) => Role | undefined
        list: () => { id: string }[]
        brokenIds: () => readonly string[]
        problems: () => readonly string[]
    }
    /** Workspace layout for a request that names no workspace. */
    layoutFor: (agent: AgentLike | undefined) => Layout
    /** Workspace layout for an explicit workspace path. */
    layoutForCwd: (cwd: string) => Layout
    /** Tool visibility, so a whitelist entry this deployment lacks is reported. */
    visibleTool: (name: string, agent: AgentLike | undefined) => boolean
    /** The resolved plugin configuration (read-only deny set). */
    config: FilterConfig
    /** Where child bindings are recorded: the skill gate's oracle. */
    bindings: RoleBindingStore
    /**
     * Mission store registry: `bind` resolves the delegating agent's mission so
     * an auto-dispatched child leaves the same delegation row as `team_delegate`.
     */
    stores: MissionStoreRegistry
    /** The plugin's layout overrides, so the ledger lives where missions do. */
    layout: LayoutOptions
    /** A logger, for refusals and un-writable bindings. */
    logger?: { warn: (message: string, error?: unknown) => void }
}

/**
 * Build the planner.
 * @param deps - registry, layout resolver, tool visibility, config and bindings.
 * @returns the service another plugin can consume.
 */
export function createRolePlanner(deps: RolePlannerDeps): RoleGuardService {
    return {
        plan(request) {
            const registry = registryFor(deps, request)
            // The same two gates as `team_delegate`, in the same order: a broken
            // definition must never fall back to a wider builtin role.
            if (registry.brokenIds().includes(request.role)) {
                throw new Error(
                    `角色 "${request.role}" 的定义文件解析失败，按 fail closed 拒绝派发。` +
                        `问题：${registry.problems().join('；')}。` +
                        '（继续用同名内置角色，会让一个本意是"降权"的文件变成"提权"。）',
                )
            }
            const role = registry.get(request.role)
            if (role === undefined) {
                const available = registry
                    .list()
                    .map((entry) => entry.id)
                    .join(', ')
                throw new Error(
                    `未知角色 "${request.role}"：按 fail closed 拒绝派发。可用角色：${available || '(无)'}。` +
                        '下一步：用 role_list 查看，或修好角色定义文件。',
                )
            }
            const plan = planToolFilter(role, deps.config, (name) => deps.visibleTool(name, request.agent))
            const refusal = filterRefusal(role, plan)
            if (refusal !== undefined) {
                deps.logger?.warn(`service.plan 拒绝角色 ${role.id}：${refusal.split('\n')[0] ?? refusal}`)
                throw new Error(refusal)
            }
            return {
                role: role.id,
                persona: role.persona,
                mode: role.mode,
                ...(plan.filter === undefined ? {} : { toolFilter: plan.filter }),
                dropped: plan.dropped,
                tools: role.tools,
                skills: role.skills,
                // No call-level override through this seam: an autonomous
                // dispatcher must not be able to escalate a role's model.
                route: resolveRoute(roleRoute(role), {}, false).route,
                source: role.source,
            }
        },
        list(cwd) {
            return registryFor(deps, cwd === undefined ? {} : { cwd })
                .list()
                .map((entry) => entry.id)
        },
        bind(request) {
            const registry = registryFor(deps, request)
            const role = registry.get(request.role)
            if (role === undefined) {
                deps.logger?.warn(`service.bind 找不到角色 ${request.role}：未写绑定，该子会话没有技能白名单`)
                return undefined
            }
            // Same workspace resolution as `plan`: the request's cwd wins, so a
            // dispatcher's child is bound in the workspace it actually runs in.
            const layout =
                request.cwd === undefined || request.cwd === ''
                    ? deps.layoutFor(request.agent)
                    : deps.layoutForCwd(request.cwd)
            const binding = deps.bindings.bindAt(layout, request.sessionId, role, roleRoute(role))
            if (binding === undefined) {
                deps.logger?.warn(
                    `service.bind 写入失败（session ${request.sessionId}，角色 ${role.id}）：该子会话没有技能白名单`,
                )
                return undefined
            }
            // A successful bind IS a delegation: leave the same ledger row the
            // team_delegate path writes, so an auto-dispatched child satisfies
            // the stage-role write guard and `advance` (AC-001/AC-003).
            recordBindDelegation(deps, request, role.id)
            return binding
        },
    }
}

/**
 * The registry for one request: an explicit workspace wins over the agent's.
 *
 * Lives outside {@link createRolePlanner} so the factory's measured size stays
 * inside the structural ratchet; it closes over nothing but its arguments.
 * @param deps - registry resolver.
 * @param request - the caller's workspace/agent.
 * @throws when a named workspace does not exist (fail closed).
 */
function registryFor(deps: RolePlannerDeps, request: { cwd?: string; agent?: AgentLike }): ReturnType<RolePlannerDeps['rolesFor']> {
    if (request.cwd === undefined || request.cwd === '') return deps.rolesFor(deps.layoutFor(request.agent))
    // A named workspace that does not exist is a caller bug, and silently
    // using the builtin layer would drop that workspace's role overrides —
    // the layer a host most often uses to DEMOTE a role. Refuse instead.
    let stat: fs.Stats | undefined
    try {
        stat = fs.statSync(request.cwd)
    } catch {
        stat = undefined
    }
    if (stat === undefined || !stat.isDirectory()) {
        throw new Error(
            `工作区 "${request.cwd}" 不存在或不是目录：按 fail closed 拒绝解析角色。` +
                '（静默退回内置角色层会丢掉该工作区的角色覆盖，而降权覆盖正是它最常见的用途。）',
        )
    }
    return deps.rolesFor(deps.layoutForCwd(request.cwd))
}

/**
 * Record the delegation a successful `bind` implies.
 *
 * An autonomous dispatcher (the orchestrator's `autoDispatch`) turns a stage's
 * role into a child through this seam instead of `team_delegate`; without this
 * row the stage-role write guard and `advance` would keep refusing a child that
 * WAS delegated. Mission and stage come from the delegating agent's bound
 * mission (`resolveForAgent`), exactly like the tool path — the ledger keeps one
 * writer and the rows carry the same shape.
 *
 * Failure policy matches `team_delegate`: an unwritable ledger is a warning,
 * never a failed dispatch (the host already authorised the child). No bound
 * mission → no row and no warning; there is nothing to compare against.
 * @param deps - store registry, layout and logger.
 * @param request - the bind request (role, child session, workspace and agent).
 * @param role - resolved role id.
 */
function recordBindDelegation(
    deps: RolePlannerDeps,
    request: { role: string; sessionId: string; cwd?: string; agent?: AgentLike },
    role: string,
): void {
    try {
        // The returned warning is already logged by the shared writer; `bind`
        // must not turn it into a refusal, so only an UNEXPECTED throw is logged
        // here (and even that leaves the written role binding usable).
        recordStageDelegation({ stores: deps.stores, layout: deps.layout, logger: deps.logger }, request.agent, role, request.sessionId, request.cwd)
    } catch (error) {
        try {
            deps.logger?.warn(`service.bind 写入委派记录失败（session ${request.sessionId}，角色 ${role}）：本次派发照常执行。`, error)
        } catch {
            // A logger must never turn a bookkeeping failure into a dispatch failure.
        }
    }
}

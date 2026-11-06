/**
 * The delegation surface: `team_delegate` (least-privilege dispatch) and
 * `role_list`.
 *
 * Least privilege is enforced by the *host*, not by prompt text: a tool outside
 * the child's role whitelist is absent from the child's prompt and refuses to
 * execute (docs.md §9: "Host 半边的工具过滤是'不可见'而非'被拦截'").
 *
 * How that filter reaches the child changed in harness 0.2.2-rc.1. The two-arg
 * `subagents.start(provider, request)` this module used to call **no longer
 * exists**, and `SubagentStartRequest` no longer carries `persona` or
 * `toolFilter`. The replacement is `startActivation(spec)`, with the role's
 * persona and whitelist travelling as an Agent Preset the host mounts into the
 * child's scope (`presets.ts` says what is role-shaped, `scope.ts` is the row
 * the host mounts there). The old `start` path is kept for an old host — but
 * only as a fallback, never as the default — and every premise the new path
 * needs is checked **before** a child is started, so a missing API becomes an
 * actionable refusal instead of a `TypeError` from a host-internal call.
 *
 * The decision, the refusal texts and both start paths are NOT here: they are
 * `dsh-eng-core`'s `delegation.ts` (shared with dsh-orchestrator and
 * dsh-impact-gate, which hand-wrote the same seam until it broke a third time).
 * This module only says WHO is being delegated and WHICH preset carries it.
 *
 * @module dsh-role-guard/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    dispatchLine,
    head,
    planDelegation,
    sessionCwd,
    startDelegation,
    tail,
    type AgentLike,
    type DelegationFilter,
    type DelegationOwner,
    type DelegationPresets,
    type DelegationServices,
    type Layout,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { teamDispatchReport } from './agent-teams.js'
import type { RoleBindingStore } from './bindings.js'
import type { RoleGuardConfig } from './config.js'
import type { RoleRegistryCache } from './loader.js'
import { rolePresetInput } from './presets.js'
import { resolveRoute, routeLine } from './route.js'
import type { Role } from './roles.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools close over. */
export interface ToolDeps {
    config: RoleGuardConfig
    roles: RoleRegistryCache
    /** `ctx.get('subagents')`, read per call. */
    subagents: () => DelegationServices | undefined
    /**
     * The presets THIS plugin registered (`dsh-eng-core`'s delegation seam).
     *
     * The role's persona and tool whitelist travel through it: the host mounts
     * the preset into the child's scope. Absent on an old host, where the legacy
     * `start` request carries them instead.
     */
    presets: DelegationPresets
    /**
     * The role's tool filter as the PRESET must carry it.
     *
     * Computed against the global tool view (the one `tools.restrict`
     * validates), never against the calling agent's view: the registry refuses a
     * fingerprint that changed since registration, so a different computation
     * here would turn every delegation into a "stale preset" refusal.
     */
    presetFilter: (role: Role) => DelegationFilter | undefined
    /**
     * `ctx.get('agentTeams')`, read per call.
     *
     * Read-only on purpose: this plugin PROBES the official collaboration
     * service to refuse its spawn path by name (see `agent-teams.ts`) and never
     * calls it. A teammate's message or task-board entry is coordination state,
     * not an authorisation, so nothing here may consume it as one.
     */
    agentTeams: () => unknown
    /** `ctx.tools.get(name, agent)` — the tool surface visible to one agent. */
    visibleTool: (name: string, agent: AgentLike | undefined) => boolean
    /** Workspace layout for the calling agent. */
    layoutFor: (agent: AgentLike | undefined) => Layout
    /** Mission store registry (for injecting the mission contract). */
    stores: MissionStoreRegistry
    /** Durable session → role bindings, written when a child starts. */
    bindings: RoleBindingStore
    /** A logger, for refused dispatch paths and unwritable bindings. */
    logger?: { warn: (message: string, error?: unknown) => void; info?: (message: string) => void }
}

/** Caller-supplied delegation request. */
export interface DelegateArgs {
    role?: string
    task: string
    context?: string
    deliverable?: string
    /**
     * Per-call route override: `provider/model` or a bare model id.
     *
     * `unknown` on purpose — the parameter schema does not constrain the type,
     * so a malformed value reaches {@link resolveRoute}, which reports it and
     * falls back per field instead of failing the whole delegation.
     */
    model?: unknown
    /** Per-call reasoning-effort override (a non-empty string when well-formed). */
    reasoningEffort?: unknown
    /** Per-call output-token cap override (a positive integer when well-formed). */
    maxTokens?: unknown
    /**
     * Which dispatch style this delegation asks for.
     *
     * `'subagent'` (default) is this plugin's own `ctx.subagents.start()` path.
     * `'team'` asks for a durable teammate on the official Agent Teams roster;
     * it is answered with a named refusal today (see `agent-teams.ts`) and the
     * delegation is served by the plugin path instead.
     *
     * `unknown` on purpose, like the route overrides: the schema declares the
     * type, and an unrecognised VALUE falls back to `'subagent'` with a reported
     * warning instead of failing the whole delegation.
     */
    dispatch?: unknown
}

/** The filter actually handed to the provider, plus what was dropped. */
export interface ToolFilterPlan {
    filter?: { allow?: readonly string[]; deny?: readonly string[] }
    dropped: string[]
}

/**
 * Compute the provider tool filter for one role.
 *
 * Unknown tool names are dropped instead of forwarded: the harness rejects a
 * `toolFilter` that names a tool this deployment does not have, and a typo in a
 * role file must shrink the child's rights, never fail the delegation.
 * @param role - the resolved role.
 * @param config - resolved configuration.
 * @param visible - predicate answering whether a tool is visible to the parent agent.
 */
/** The configuration slice `planToolFilter` actually reads. */
export type FilterConfig = Pick<RoleGuardConfig, 'readonlyDeny'>

export function planToolFilter(role: Role, config: FilterConfig, visible: (name: string) => boolean): ToolFilterPlan {
    const dropped: string[] = []
    // Only the allow-list reports dropped names: a deny entry naming a tool
    // this deployment lacks merely removes nothing, while a whitelist entry
    // that silently vanished would be a real least-privilege surprise.
    const keepAllow = (names: readonly string[]): string[] => {
        const kept: string[] = []
        for (const name of names) {
            if (visible(name)) kept.push(name)
            else dropped.push(name)
        }
        return kept
    }
    const keepDeny = (names: readonly string[]): string[] => names.filter((name) => visible(name))
    const filter: ToolFilterPlan['filter'] = { deny: [] }

    if (role.tools.length > 0) {
        // A declared whitelist is ALWAYS enforced, even when it survives as an
        // empty list: falling back to "no filter" would hand the child the
        // parent's entire surface, which is the exact opposite of least
        // privilege (a typo, or a read-only role that only listed write tools,
        // would silently gain every right).
        const readonlyStripped = role.mode === 'read' ? config.readonlyDeny : []
        filter.allow = [...new Set(keepAllow(role.tools).filter((name) => !readonlyStripped.includes(name)))]
    }
    const denyCandidates = keepDeny([...role.deny, ...(role.mode === 'read' ? config.readonlyDeny : [])])
    // With an allow-list in place everything outside it is already gone, so the
    // deny list only needs the entries that subtract from the allow-list.
    const deny = filter.allow === undefined ? denyCandidates : denyCandidates.filter((name) => filter.allow?.includes(name))
    if (deny.length > 0) filter.deny = [...new Set(deny)]
    if (filter.deny !== undefined && filter.deny.length === 0) delete filter.deny
    return { filter, dropped: [...new Set(dropped)] }
}

/**
 * Why a delegation must be refused before it starts.
 * @param role - the resolved role.
 * @param plan - the planned filter.
 * @returns a Chinese refusal, or `undefined` when the delegation may proceed.
 */
export function filterRefusal(role: Role, plan: ToolFilterPlan): string | undefined {
    if (role.mode === 'read' && role.tools.length === 0) {
        return [
            `只读角色 "${role.id}" 没有声明 tools 白名单：无法保证它是只读的（deny 只能减去已知名字，挡不住未知的写工具）。`,
            '请在该角色文件里显式列出允许的工具（例如 read/glob/grep），或把它改成 mode: write。',
        ].join('\n')
    }
    if (role.tools.length > 0 && (plan.filter?.allow?.length ?? 0) === 0) {
        return [
            `角色 "${role.id}" 的工具白名单在当前部署里没有任何可用项（声明：${role.tools.join(', ')}${plan.dropped.length > 0 ? `；其中不存在的：${plan.dropped.join(', ')}` : ''}）。`,
            '按最小权限原则拒绝派发：白名单全空时"不加过滤"会让子 Agent 拿到父 Agent 的全部权限。',
            '请修正角色文件的 tools（对照 role_list 的可用工具）后重试。',
        ].join('\n')
    }
    return undefined
}

/** Render the child's prompt: role, task, contract and hard constraints. */
export function buildPrompt(
    role: Role,
    args: DelegateArgs,
    options: { cwd: string; filterPlan: ToolFilterPlan; specSection?: string; config: RoleGuardConfig },
): string {
    const lines: string[] = []
    lines.push(`# 角色：${role.name}（${role.id}）`)
    lines.push('')
    if (role.description !== '') {
        lines.push(role.description)
        lines.push('')
    }
    lines.push('## 任务')
    lines.push(args.task.trim())
    if (args.context !== undefined && args.context.trim() !== '') {
        lines.push('')
        lines.push('## 上下文')
        lines.push(args.context.trim())
    }
    if (args.deliverable !== undefined && args.deliverable.trim() !== '') {
        lines.push('')
        lines.push('## 交付要求')
        lines.push(args.deliverable.trim())
    }
    if (options.specSection !== undefined && options.specSection !== '') {
        lines.push('')
        lines.push(options.specSection)
    }
    lines.push('')
    lines.push('## 硬约束')
    lines.push(`- 工作目录：\`${options.cwd}\``)
    lines.push(
        options.filterPlan.filter?.allow === undefined
            ? '- 你的工具白名单由宿主强制：白名单外的工具对你的**不可见**，调用会失败。'
            : `- 你只能使用这些工具（宿主强制，不可绕过）：${options.filterPlan.filter.allow.join(', ')}`,
    )
    if (role.mode === 'read') {
        lines.push('- 你是**只读角色**：不要尝试写文件（包括用 bash 重定向写文件）；需要改动时把结论交回主 Agent。')
    }
    if (role.skills.length > 0) {
        lines.push(
            `- 允许使用的技能（宿主在调用时强制）：${role.skills.join(', ')}。加载其他技能会被宿主拒绝（技能目录里可能列出它们，但"目录里有" ≠ "你能用"）。`,
        )
    }
    lines.push('- 汇报要可复核：做了什么、命令与输出、结论与风险；不要用"应该可以"这类措辞。')
    return lines.join('\n')
}

/** The mission contract injected into a child prompt (spec + boundaries). */
export function specSectionFor(deps: ToolDeps, agent: AgentLike | undefined): string {
    if (!deps.config.injectSpec) return ''
    const store = deps.stores.for(sessionCwd(agent))
    const mission = store.resolveForAgent(agent)
    if (mission?.spec === undefined) return ''
    const spec = mission.spec
    const lines = [
        '## 当前任务的规格（已审批，逐条对齐）',
        `- mission: \`${mission.id}\`（${spec.approvedAt === undefined ? '未审批' : '已审批'}）`,
        `- 规格文件：\`${mission.specPath ?? '.dsh/specs/<id>.md'}\``,
        '- 验收标准：',
        ...spec.acceptanceCriteria.map((criterion) => `  - ${criterion.id}: ${criterion.text}`),
        `- 文件边界：${spec.fileBoundaries.join('、') || '(未声明)'}`,
        `- 负面约束：${spec.negativeConstraints.join('；') || '(未声明)'}`,
    ]
    return lines.join('\n')
}

// --- dispatch: the shared seam in dsh-eng-core -------------------------------
//
// Everything that used to live here — the four premises, the five refusal
// texts, the two start paths and the normalisation — is one implementation in
// `dsh-eng-core`'s `delegation.ts`, shared with dsh-orchestrator and
// dsh-impact-gate. What stays local is only what is ROLE shaped: who is being
// delegated (the refusal subject) and which preset carries the role.

/** The refusal subject for one role (the texts name what the human can fix). */
export function roleOwner(role: Role): DelegationOwner {
    return { plugin: 'dsh-role-guard', subject: `角色 "${role.id}"` }
}

/**
 * Read the official Agent Teams service without ever letting it throw.
 *
 * The service is only PROBED (see `agent-teams.ts`): a missing, partial or
 * hostile object reads as "absent" and the delegation proceeds on our own path.
 * @param read - `ctx.get('agentTeams')`, deferred per call.
 */
function safeAgentTeams(read: () => unknown): unknown {
    try {
        return read()
    } catch {
        return undefined
    }
}

function stopReasonText(stopReason: string): string {
    switch (stopReason) {
        case 'completed':
            return '完成'
        case 'aborted':
            return '被取消'
        case 'error':
            return '模型/传输错误'
        case 'max-tokens':
            return '达到 token 上限'
        case 'refusal':
            return '子代理拒绝执行'
        default:
            return stopReason
    }
}

function renderChildOutput(output: readonly { type: string; text?: string }[] | undefined): string {
    if (output === undefined || output.length === 0) return '(子代理没有产出文本)'
    return output
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`))
        .join('\n')
}

/** Register the role-guard tools. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    register(
        defineTool({
            name: 'team_delegate',
            description:
                'Delegate a task to a named agent role (developer / reviewer / qa / project-defined). The child agent is created with the role\'s persona, model and tool whitelist; tools outside the whitelist are invisible to it and cannot be called. Use this instead of subagent when the work must respect role separation.',
            parameters: {
                role: { type: 'string', description: 'Role id from role_list (default: the configured default role).' },
                task: { type: 'string', required: true, description: 'What the child must do, stated as an outcome.' },
                context: { type: 'string', description: 'Facts the child needs: files, current state, prior findings.' },
                deliverable: { type: 'string', description: 'The exact form of the answer you expect back.' },
                // Types are declared, not "validated later": a wrong TYPE is a
                // caller mistake the schema rejects immediately (the model sees
                // `must be a string` and retries), while a value that is
                // well-typed but cannot form a route (empty string, a bare model
                // with no provider anywhere, a non-positive cap) falls back to
                // the role's route with a reported problem — see resolveRoute.
                model: {
                    type: 'string',
                    description:
                        'Optional per-call model override: "provider/model" (same shorthand as a role file) or a bare model id, which keeps the role\'s provider. Takes precedence over the role file\'s model; the host may forbid overriding (allowModelOverride: false).',
                },
                reasoningEffort: {
                    type: 'string',
                    description:
                        'Optional per-call reasoning-effort override (e.g. low/medium/high). Takes precedence over the role file; the host may forbid overriding.',
                },
                maxTokens: {
                    type: 'integer',
                    description:
                        'Optional per-call output-token cap (positive). Takes precedence over the role file; the host may forbid overriding.',
                },
                dispatch: {
                    type: 'string',
                    description:
                        "Optional dispatch style: 'subagent' (default) creates a one-shot child through this plugin's own path; 'team' asks for a durable teammate on the official Agent Teams roster. A 'team' request is refused when the official spawn cannot carry the role's persona / tool whitelist / model route (it cannot, on harness 0.2.0-rc.1) — the result then names the guarantee and the child is created through this plugin's path instead.",
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: DelegateArgs, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const roleId = args.role === undefined || args.role === '' ? deps.config.defaultRole : args.role
                const layout = deps.layoutFor(agent)
                const registry = deps.roles.for(layout)
                const broken = registry.brokenIds()
                if (broken.includes(roleId)) {
                    throw new Error(
                        [
                            `角色 "${roleId}" 的定义文件解析失败，按 fail closed 拒绝派发。`,
                            '（如果继续用内置/上一层的同名角色，一个本意是"降权"的文件反而会变成"提权"。）',
                            `问题：${registry.problems().join('；')}`,
                            '下一步：修好该角色文件（或删掉它）后用 role_list 确认。',
                        ].join('\n'),
                    )
                }
                const role = registry.get(roleId)
                if (role === undefined) {
                    const available = registry.list().map((entry) => entry.id).join(', ')
                    throw new Error(`未知角色 "${roleId}"。可用角色：${available || '(无)'}。先用 role_list 查看。`)
                }
                if (agent === undefined) throw new Error('team_delegate 需要调用方 agent。')
                const subagents = deps.subagents()
                if (subagents === undefined) {
                    throw new Error(
                        '宿主没有装配子代理服务（ctx.subagents）：请挂载 @deepseek-ai/dsh-subagent 与具体的 provider（如 @deepseek-ai/dsh-subagent-spawn-in-process）。',
                    )
                }
                const plan = planToolFilter(role, deps.config, (name) => deps.visibleTool(name, agent))
                const refusal = filterRefusal(role, plan)
                if (refusal !== undefined) throw new Error(refusal)
                const cwd = sessionCwd(agent)
                const prompt = buildPrompt(role, args, {
                    cwd,
                    filterPlan: plan,
                    specSection: specSectionFor(deps, agent),
                    config: deps.config,
                })
                // The child's LLM route: explicit call parameters merged over the
                // role's own route (call > role > host default). Malformed
                // parameters fall back per field and are reported below.
                const route = resolveRoute(
                    role,
                    { model: args.model, reasoningEffort: args.reasoningEffort, maxTokens: args.maxTokens },
                    deps.config.allowModelOverride,
                )
                const agentOptions = route.route
                // --- dispatch path: the official Agent Teams spawn is refused ----
                // Computed BEFORE the child starts and answered explicitly, so a
                // caller that asked for a durable teammate is never left
                // believing it got one. Every authorisation gate above has
                // already run, in the same order as before this parameter
                // existed: the collaboration surface can neither widen nor
                // narrow a role decision, it can only be reported on.
                const dispatchProblems: string[] = []
                let requestedTeam = false
                if (args.dispatch !== undefined && args.dispatch !== 'subagent') {
                    if (args.dispatch === 'team') requestedTeam = true
                    else {
                        dispatchProblems.push(
                            `未知的 dispatch 值（${JSON.stringify(args.dispatch)}）：只接受 'subagent' | 'team'，已按 'subagent' 处理。`,
                        )
                    }
                }
                const dispatchReport = requestedTeam
                    ? teamDispatchReport({
                          compose: deps.config.composeWithAgentTeams,
                          teams: safeAgentTeams(deps.agentTeams),
                          role,
                          plan,
                          route: route.route,
                      })
                    : undefined
                // How this delegation starts its child, decided BEFORE anything
                // starts: on a 0.2.2-rc.1 host the role's persona and tool whitelist
                // can only travel as an Agent Preset, so a missing premise is a
                // refusal, never a prompt-only fallback. The decision itself is
                // dsh-eng-core's (one seam for all three delegating plugins).
                const owner = roleOwner(role)
                const dispatchPlan = await planDelegation({
                    owner,
                    provider: deps.config.provider,
                    subagents,
                    presets: deps.presets,
                    // The filter MUST come from the global view, not from this
                    // call's agent-scoped plan: the registry compares it with what
                    // was registered at assembly time (see ToolDeps.presetFilter).
                    preset: rolePresetInput(role, deps.presetFilter(role)),
                })
                if (dispatchPlan.kind === 'refused') throw new Error(dispatchPlan.reason)
                const label = `${role.name} · ${head(args.task, 60)}`
                const allowNames = plan.filter?.allow?.join(', ') ?? plan.filter?.deny?.join(', ') ?? '(空)'
                const run = await startDelegation(subagents, {
                    owner,
                    provider: deps.config.provider,
                    plan: dispatchPlan,
                    label,
                    prompt,
                    parent: agent,
                    signal: exec.signal,
                    ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
                    // The legacy request still carries the role; the activation
                    // path carries the preset instead (the seam sets agentPreset).
                    legacy: { persona: role.persona, ...(plan.filter === undefined ? {} : { filter: plan.filter }) },
                    detail: `角色白名单：${allowNames}`,
                })
                if (dispatchReport !== undefined) {
                    // The durable half of the report (the tool output is the
                    // other half): a refused team dispatch is an audit fact, not
                    // a silent substitution.
                    deps.logger?.warn(`team_delegate 请求 team 派发（角色 ${role.id}，子会话 ${run.id}）：\n${dispatchReport}`)
                }
                // A `SubagentRun`'s id IS the child session id, which is the key the
                // invocation-time gates look the role up by. Recorded before the
                // first result is awaited; the file is what survives a reload.
                // The effective route travels with it, so an audit can see which
                // model the child actually ran on; so does the dispatch path.
                const binding = deps.bindings.bind(agent, run.id, role, route.route, 'subagents')
                let result: Awaited<typeof run.result>
                try {
                    result = await run.result
                } finally {
                    // The seam requires every consumer to dispose the published
                    // run so an aborted delegation cannot leak the child.
                    try {
                        await run.dispose()
                    } catch {
                        // disposal failures must not mask the child's result
                    }
                }
                const warnings: string[] = []
                // Route warnings come first: they explain why the child ran where
                // it did, which is what a cost/audit reader looks for.
                if (route.ignored.length > 0) {
                    warnings.push(
                        `宿主禁用了按调用覆盖模型：沿用角色路由（被忽略的调用参数：${route.ignored.join('、')}）。` +
                            '模型覆盖是成本决策，是否允许由宿主的 allowModelOverride 决定。',
                    )
                }
                for (const problem of route.problems) warnings.push(problem)
                for (const problem of dispatchProblems) warnings.push(problem)
                if (plan.dropped.length > 0) {
                    warnings.push(`角色文件里这些工具在当前部署不存在，已从白名单剔除：${plan.dropped.join(', ')}`)
                }
                if (binding === undefined) {
                    warnings.push(
                        `未能记录角色绑定（${run.id} → ${role.id}）：技能白名单对这个子 Agent 不生效（详见 role-guard 日志）。工具白名单不受影响，仍由宿主强制。`,
                    )
                }
                for (const problem of registry.problems()) warnings.push(`角色文件问题：${problem}`)
                // A preset that failed to register stays visible on every
                // delegation: another role's dispatch must not hide it.
                for (const problem of deps.presets.problems()) warnings.push(`Agent Preset：${problem}`)
                const header = [
                    `role: ${role.id}（${role.name}，mode=${role.mode}）`,
                    `child session: ${run.id}`,
                    `stop reason: ${stopReasonText(result.stopReason)}`,
                    `tool whitelist: ${plan.filter?.allow?.join(', ') ?? '(继承全部，deny: ' + (plan.filter?.deny?.join(', ') ?? '无') + ')'}`,
                    `skill whitelist: ${role.skills.join(', ') || '(未声明 = 不限制)'}（调用时强制）`,
                    routeLine(route),
                    // Which seam started the child. Named on every path so an
                    // audit can tell a host-enforced preset from the legacy
                    // request-carried filter without reading the source.
                    dispatchLine(dispatchPlan),
                    // Only a team-style request adds a line here: the default
                    // path's output stays exactly what it was, so 'off' (and an
                    // unchanged deployment) reads identically to before.
                    ...(dispatchReport === undefined ? [] : [dispatchReport]),
                ]
                const body = tail(renderChildOutput(result.output), deps.config.maxOutputChars)
                const diagnostic = result.diagnostic === undefined ? '' : `\ndiagnostic: ${result.diagnostic}`
                return [...header, ...warnings.map((warning) => `warning: ${warning}`), '', '--- 子代理产出 ---', body + diagnostic].join('\n')
            },
        }),
        'team_delegate',
    )

    register(
        defineTool({
            name: 'role_list',
            description:
                'List the agent roles available for team_delegate: id, name, read/write mode, tool whitelist, model route and provenance.',
            parameters: {
                role: { type: 'string', description: 'Show one role in full, including its persona.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: { role?: string }, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const registry = deps.roles.for(deps.layoutFor(agent))
                if (args.role !== undefined && args.role !== '') {
                    const role = registry.get(args.role)
                    if (role === undefined) throw new Error(`未知角色 "${args.role}"。`)
                    return [
                        `id: ${role.id}`,
                        `name: ${role.name}`,
                        `mode: ${role.mode}`,
                        `tools: ${role.tools.join(', ') || '(继承全部，deny: ' + role.deny.join(', ') + ')'}`,
                        `skills: ${role.skills.length > 0 ? `${role.skills.join(', ')}（宿主在调用时强制）` : '(未声明 = 不限制)'}`,
                        `model: ${role.provider === undefined && role.model === undefined ? '(继承父 Agent)' : `${role.provider ?? ''}${role.model === undefined ? '' : `/${role.model}`}`}`,
                        `source: ${role.source}`,
                        '',
                        '--- persona ---',
                        role.persona,
                    ].join('\n')
                }
                const rows = registry.list().map((role) => {
                    const tools = role.tools.length > 0 ? role.tools.join(' ') : `* -${role.deny.join(' -')}`
                    return `| ${role.id} | ${role.name} | ${role.mode} | ${tools} | ${role.skills.join(' ') || '-'} | ${role.model ?? '(继承)'} | ${role.source} |`
                })
                const problems = registry.problems()
                return [
                    '| id | 名称 | 模式 | 工具白名单 | 技能白名单 | 模型 | 来源 |',
                    '|----|------|------|------------|------------|------|------|',
                    ...rows,
                    '',
                    problems.length === 0 ? '所有角色文件解析正常。' : `角色文件问题：\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
                ].join('\n')
            },
        }),
        'role_list',
    )

    return { disposers, registered, failed }
}

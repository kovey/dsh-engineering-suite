/**
 * The delegation surface: `team_delegate` (least-privilege dispatch) and
 * `role_list`.
 *
 * Least privilege is enforced by the *host*, not by prompt text: the delegated
 * child is created with a `toolFilter`, so a tool outside its role's whitelist
 * is absent from the child's prompt and refuses to execute (docs.md §9:
 * "Host 半边的工具过滤是'不可见'而非'被拦截'").
 *
 * @module dsh-role-guard/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { head, sessionCwd, tail, type Layout, type MissionStoreRegistry } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import type { RoleBindingStore } from './bindings.js'
import type { RoleGuardConfig } from './config.js'
import type { RoleRegistryCache } from './loader.js'
import type { Role } from './roles.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Structural view of `ctx.subagents`. */
export interface SubagentsLike {
    start(
        provider: string,
        request: {
            label?: string
            prompt: { type: 'text'; text: string }[]
            parent: AgentLike
            signal: AbortSignal
            agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
            toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
            persona?: string
            maxDepth?: number
        },
    ): Promise<{
        id: string
        result: Promise<{ stopReason: string; output: { type: string; text?: string }[]; diagnostic?: string }>
        dispose?: () => Promise<void>
    }>
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: RoleGuardConfig
    roles: RoleRegistryCache
    /** `ctx.get('subagents')`, read per call. */
    subagents: () => SubagentsLike | undefined
    /** `ctx.tools.get(name, agent)` — the tool surface visible to one agent. */
    visibleTool: (name: string, agent: AgentLike | undefined) => boolean
    /** Workspace layout for the calling agent. */
    layoutFor: (agent: AgentLike | undefined) => Layout
    /** Mission store registry (for injecting the mission contract). */
    stores: MissionStoreRegistry
    /** Durable session → role bindings, written when a child starts. */
    bindings: RoleBindingStore
}

/** Caller-supplied delegation request. */
export interface DelegateArgs {
    role?: string
    task: string
    context?: string
    deliverable?: string
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
export function planToolFilter(role: Role, config: RoleGuardConfig, visible: (name: string) => boolean): ToolFilterPlan {
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

/**
 * Start a child run, translating the provider's unknown-tool rejection into an
 * actionable message.
 *
 * The harness validates a `toolFilter` against the GLOBAL restrictable tool set:
 * a role file that whitelists a scope-local (preset/agent-local) tool makes the
 * whole filter invalid, and the provider refuses the start. That is a role-file
 * bug worth explaining, not a crash.
 */
async function startWithDiagnostics(
    subagents: SubagentsLike,
    provider: string,
    request: Parameters<SubagentsLike['start']>[1],
): Promise<Awaited<ReturnType<SubagentsLike['start']>>> {
    try {
        return await subagents.start(provider, request)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const names = request.toolFilter?.allow?.join(', ') ?? request.toolFilter?.deny?.join(', ') ?? '(空)'
        throw new Error(
            [
                `子代理启动失败（provider ${provider}）：${message}`,
                `角色白名单：${names}`,
                '常见原因：白名单里写了当前部署不存在的全局工具名（scope-local 的工具不能进 toolFilter）。',
                '下一步：用 role_list 对照可用工具修正角色文件，或让宿主在 role-guard 的 config 里覆盖该角色。',
            ].join('\n'),
        )
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
                const agentOptions = {
                    ...(role.provider === undefined ? {} : { provider: role.provider }),
                    ...(role.model === undefined ? {} : { model: role.model }),
                    ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
                    ...(role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens }),
                }
                const run = await startWithDiagnostics(subagents, deps.config.provider, {
                    label: `${role.name} · ${head(args.task, 60)}`,
                    prompt: [{ type: 'text', text: prompt }],
                    parent: agent,
                    signal: exec.signal,
                    ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
                    ...(plan.filter === undefined ? {} : { toolFilter: plan.filter }),
                    persona: role.persona,
                })
                // A `SubagentRun`'s id IS the child session id, which is the key the
                // invocation-time gates look the role up by. Recorded before the
                // first result is awaited; the file is what survives a reload.
                const binding = deps.bindings.bind(agent, run.id, role)
                let result: Awaited<typeof run.result>
                try {
                    result = await run.result
                } finally {
                    // The seam requires every consumer to dispose the published
                    // run so an aborted delegation cannot leak the child.
                    try {
                        await run.dispose?.()
                    } catch {
                        // disposal failures must not mask the child's result
                    }
                }
                const warnings: string[] = []
                if (plan.dropped.length > 0) {
                    warnings.push(`角色文件里这些工具在当前部署不存在，已从白名单剔除：${plan.dropped.join(', ')}`)
                }
                if (binding === undefined) {
                    warnings.push(
                        `未能记录角色绑定（${run.id} → ${role.id}）：技能白名单对这个子 Agent 不生效（详见 role-guard 日志）。工具白名单不受影响，仍由宿主强制。`,
                    )
                }
                for (const problem of registry.problems()) warnings.push(`角色文件问题：${problem}`)
                const header = [
                    `role: ${role.id}（${role.name}，mode=${role.mode}）`,
                    `child session: ${run.id}`,
                    `stop reason: ${stopReasonText(result.stopReason)}`,
                    `tool whitelist: ${plan.filter?.allow?.join(', ') ?? '(继承全部，deny: ' + (plan.filter?.deny?.join(', ') ?? '无') + ')'}`,
                    `skill whitelist: ${role.skills.join(', ') || '(未声明 = 不限制)'}（调用时强制）`,
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

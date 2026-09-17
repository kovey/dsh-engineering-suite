/**
 * The model-facing tool surface: `spec_create`, `spec_approve`, `spec_status`.
 * @module dsh-spec-gate/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    formatTime,
    parentSessionIdOf,
    sessionIdOf,
    sha256,
    specReviewDigest,
    type AgentLike,
    type MissionRecord,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import type { Logger } from 'dsh-eng-core'
import type { SpecGateConfig } from './config.js'
import type { WriteGuard } from './guard.js'
import { describeConstraints } from './constraints.js'
import { buildSpec, describeMission, parseDraftTestDesign, renderSpec, validateDraft, type SpecDraft } from './spec.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Minimal structural view of `ctx.approval`. */
export interface ApprovalLike {
    request(request: {
        agent?: AgentLike
        toolName: string
        reason?: string
        signal?: AbortSignal
    }): Promise<'allowed-once' | 'rejected' | 'unavailable' | 'cancelled' | string>
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: SpecGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (cwd: string) => { config: SpecGateConfig; source: 'profile' | 'project'; file?: string; problems: string[] }
    stores: MissionStoreRegistry
    guard: WriteGuard
    /** Whether `dsh-test-design-gate` is mounted right now. */
    testDesignMounted: () => boolean
    /** The approval seam, read at call time (`ctx.get('approval')`). */
    approval: () => ApprovalLike | undefined
    /** Plugin logger; `deps.logger.for(cwd)` routes a line to that workspace's file. */
    logger: Logger
}

interface CreateArgs {
    title: string
    background?: string
    requirements: string[]
    acceptanceCriteria: string[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    testDesign?: string
    missionId?: string
}

interface ApproveArgs {
    missionId?: string
    note?: string
}

interface StatusArgs {
    missionId?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/**
 * The workspace a tool call applies to.
 *
 * A tool must never guess: with no declared `header.cwd` the mission store
 * would resolve against the harness's own directory — i.e. against a DIFFERENT
 * project — so the call is refused with an actionable message instead.
 */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：规格与 mission 会被写到错误的目录，因此本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    return cwd
}

function storeFor(deps: ToolDeps, exec: unknown) {
    const agent = agentOf(exec)
    const cwd = declaredCwdOf(agent)
    return { store: deps.stores.for(cwd), agent, cwd }
}

/**
 * Resolve the mission a tool call applies to.
 *
 * Resolution is deliberately strict: an explicit id, else the session's bound
 * mission (a subagent inherits its parent's). There is NO "newest mission in
 * the workspace" fallback — approving or reporting on a mission another session
 * happens to own is exactly the kind of silent cross-session action a gate must
 * never take.
 * @throws when the explicit id does not exist, or when a bound mission's state
 *   file cannot be read (corrupt state is worse than missing state).
 */
function resolveStrict(deps: ToolDeps, exec: unknown, explicitId?: string): MissionRecord | undefined {
    const agent = agentOf(exec)
    const store = deps.stores.for(declaredCwdOf(agent))
    if (explicitId !== undefined) {
        const explicit = store.read(explicitId)
        if (explicit === undefined) {
            throw new Error(`mission "${explicitId}" 不存在，或它的 mission.json 已损坏（fail closed，不会退回到其它 mission）。`)
        }
        return explicit
    }
    const candidates = [sessionIdOf(agent), parentSessionIdOf(agent)]
    for (const sessionId of candidates) {
        if (sessionId === undefined) continue
        const boundId = store.activeMissionId(sessionId)
        if (boundId === undefined) continue
        const record = store.read(boundId)
        if (record === undefined) {
            throw new Error(
                [
                    `会话 ${sessionId} 绑定的 mission "${boundId}" 状态文件损坏，无法确认规格状态（fail closed）。`,
                    '下一步：检查 .dsh/missions/<id>/mission.json，或重新调用 spec_create 建立规格。',
                ].join('\n'),
            )
        }
        return record
    }
    return undefined
}

function needsTestDesign(deps: ToolDeps, config: SpecGateConfig = deps.config): boolean {
    if (config.requireTestDesign === true) return true
    if (config.requireTestDesign === false) return false
    return deps.testDesignMounted()
}

/** The effective configuration for the calling agent's workspace. */
function effectiveFor(deps: ToolDeps, agent: AgentLike | undefined): SpecGateConfig {
    const cwd = agent?.session?.header?.cwd
    return cwd === undefined ? deps.config : deps.configFor(cwd).config
}

/** Register every spec-gate tool. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[]; lastError?: string } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    let registrationError: string | undefined

    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch (error) {
            failed.push(name)
            registrationError = error instanceof Error ? error.message : String(error)
        }
    }

    register(
        defineTool({
            name: 'spec_create',
            description:
                'Create or revise the structured specification of the current mission: acceptance criteria, file boundaries, negative constraints and the test design chapter. Writes .dsh/specs/<mission-id>.md. A mission whose specification is not approved blocks every write tool (dsh-spec-gate).',
            parameters: {
                title: { type: 'string', required: true, description: 'One-line mission title.' },
                background: { type: 'string', description: 'Why this work exists, and the constraints behind it.' },
                requirements: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: 'What must be built, one requirement per entry.',
                },
                acceptanceCriteria: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: 'Verifiable acceptance criteria; ids AC-001… are assigned in order.',
                },
                fileBoundaries: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: 'Files/directories this mission may touch.',
                },
                negativeConstraints: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: 'Explicitly forbidden actions (e.g. 不得修改 dsh 核心代码).',
                },
                testDesign: {
                    type: 'string',
                    description:
                        'The body of the `## 测试设计` chapter: `### 正向场景` / `### 异常场景` / `### 边界场景`, each a Markdown table with columns 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准.',
                },
                missionId: { type: 'string', description: 'Revise an existing mission instead of creating one.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: CreateArgs = {} as CreateArgs, exec) {
                const { store, agent, cwd } = storeFor(deps, exec)
                const draft: SpecDraft = {
                    title: args.title ?? '',
                    background: args.background ?? '',
                    requirements: args.requirements ?? [],
                    acceptanceCriteria: args.acceptanceCriteria ?? [],
                    fileBoundaries: args.fileBoundaries ?? [],
                    negativeConstraints: args.negativeConstraints ?? [],
                    testDesignMarkdown: args.testDesign ?? '',
                }
                const issues = validateDraft(draft)
                if (issues.length > 0) {
                    throw new Error(
                        [
                            '规格草稿不完整，未写入任何文件：',
                            ...issues.map((issue) => `- ${issue.field}: ${issue.message}`),
                            '修正后重新调用 spec_create。',
                        ].join('\n'),
                    )
                }
                const sessionId = sessionIdOf(agent)
                if (args.missionId !== undefined) {
                    const explicit = store.read(args.missionId)
                    if (explicit === undefined) {
                        throw new Error(`mission "${args.missionId}" 不存在：改规格请传已存在的 missionId，新建请省略该参数。`)
                    }
                }
                const existing = store.resolveForAgent(agent, { ...(args.missionId === undefined ? {} : { explicitId: args.missionId }) })
                const mission =
                    existing ??
                    store.create({
                        title: draft.title.trim(),
                        cwd,
                        ...(sessionId === undefined ? {} : { sessionId }),
                    })
                const design = parseDraftTestDesign(draft)
                const spec = buildSpec(draft, mission.spec)
                const revised = mission.spec !== undefined
                const updated = store.update(mission.id, () => ({
                    title: draft.title.trim(),
                    // A revision always revokes the previous approval, and a
                    // revision that does not carry a fresh test design also
                    // drops the previous one: it was reviewed against
                    // acceptance criteria that no longer exist, so keeping it
                    // would let an unreviewed criterion ride on an old PASS.
                    status: 'draft',
                    spec,
                    testDesign: design ?? (revised ? undefined : mission.testDesign),
                }))
                if (updated === undefined) throw new Error(`mission ${mission.id} disappeared while writing the specification`)
                const markdown = renderSpec(updated)
                const file = store.writeSpec(mission.id, markdown)
                if (sessionId !== undefined) store.bindSession(sessionId, mission.id)
                const designNote =
                    design === undefined
                        ? '测试设计章节为空：spec_approve 之前需要补齐并运行 test_design_review。'
                        : `已解析测试用例 ${design.cases.length} 条，未覆盖验收标准 ${design.uncovered.length} 条。`
                const constraintNote = `负面约束：${describeConstraints(spec.negativeConstraints)}`
                return [
                    `规格已写入：${file}`,
                    `mission: ${mission.id}（revision ${spec.revision}，状态 draft）`,
                    `验收标准：${spec.acceptanceCriteria.map((criterion) => criterion.id).join(', ')}`,
                    designNote,
                    constraintNote,
                    needsTestDesign(deps, effectiveFor(deps, agent))
                        ? '下一步：调用 test_design_review 通过测试设计门禁，然后调用 spec_approve 取人工审批。'
                        : '下一步：调用 spec_approve 取人工审批。',
                ].join('\n')
            },
        }),
        'spec_create',
    )

    register(
        defineTool({
            name: 'spec_approve',
            description:
                'Request approval of the current mission specification. When the harness has an approval channel the human is asked; the mission only becomes writable after the approval is granted.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to approve (default: the session mission).' },
                note: { type: 'string', description: 'Why this specification is ready for approval.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ApproveArgs = {} as ApproveArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                const mission = resolveStrict(deps, exec, args.missionId)
                if (mission === undefined) {
                    throw new Error(
                        '当前会话没有绑定任何 mission：请先调用 spec_create 建立规格；' +
                            '如果要审批别的 mission，显式传 missionId（本工具不会退回到"工作区里最新的那个 mission"）。',
                    )
                }
                if (mission.spec === undefined) throw new Error(`mission ${mission.id} 还没有规格：请先调用 spec_create。`)
                // The artifact a human is asked to approve must still be the
                // record this tool gates on: an out-of-band edit (by hand, by
                // another plugin, by an older session) makes the approved
                // document a different one.
                const artifact = store.readSpec(mission.id)
                const artifactDigest = sha256(artifact)
                if (artifact.trim() === '') {
                    throw new Error(`mission ${mission.id} 的规格工件缺失（${mission.specPath ?? '.dsh/specs/<id>.md'}）：请重新调用 spec_create。`)
                }
                if (mission.specDigest !== undefined && artifactDigest !== mission.specDigest) {
                    throw new Error(
                        [
                            `mission ${mission.id} 的规格工件与记录不一致（工件摘要 ${artifactDigest.slice(0, 12)} ≠ 记录 ${mission.specDigest.slice(0, 12)}）。`,
                            '有人在 spec_create 之外改过 .dsh/specs 下的文件，审批会批准一份未经校验的文档。',
                            '下一步：重新调用 spec_create 让工件与记录一致，再审批。',
                        ].join('\n'),
                    )
                }
                const effective = effectiveFor(deps, agent)
                if (needsTestDesign(deps, effective)) {
                    const design = mission.testDesign
                    if (design === undefined) {
                        throw new Error(
                            `mission ${mission.id} 缺少测试设计：请先在 spec_create 的 testDesign 参数中补齐三类场景，再调用 test_design_review。`,
                        )
                    }
                    if (design.passed !== true) {
                        throw new Error(
                            `mission ${mission.id} 的测试设计尚未通过评审（用例 ${design.cases.length} 条，未覆盖 ${design.uncovered.join(', ') || '无'}）：请调用 test_design_review。`,
                        )
                    }
                    // The verdict must have been reached against THIS
                    // specification: a revision (or a hand-edited artifact)
                    // changes the digest and revokes the old PASS.
                    const current = specReviewDigest(mission.spec, design)
                    if (design.specDigest !== current) {
                        throw new Error(
                            [
                                `mission ${mission.id} 的测试设计评审针对的不是当前规格（规格 revision ${mission.spec.revision}）：`,
                                design.specDigest === undefined
                                    ? '该评审记录没有绑定规格摘要（可能来自旧版本插件），无法确认它覆盖了当前验收标准。'
                                    : `评审摘要 ${design.specDigest.slice(0, 12)} ≠ 当前摘要 ${current.slice(0, 12)}。`,
                                '下一步：对当前规格重新运行 test_design_review，通过后再调用 spec_approve。',
                            ].join('\n'),
                        )
                    }
                }
                const approvedBy = await requestApproval(deps, exec, mission, args.note, effective)
                const approved = store.update(mission.id, (record) => ({
                    status: 'spec-approved',
                    spec: record.spec === undefined ? undefined : { ...record.spec, approvedAt: Date.now(), approvedBy, updatedAt: Date.now() },
                }))
                if (approved === undefined) throw new Error(`mission ${mission.id} disappeared while approving`)
                // Re-render so the artifact carries the approval header.
                store.writeSpec(mission.id, renderSpec(approved))
                return [
                    `规格已审批（mission ${mission.id}，by ${approvedBy}，${formatTime(Date.now())}）。`,
                    '写操作现已放行。下一步：按规格实现 → evidence_record 登记验证输出 → quality_gate_run 跑门禁 → mission_complete 交付。',
                ].join('\n')
            },
        }),
        'spec_approve',
    )

    register(
        defineTool({
            name: 'spec_status',
            description:
                'Show the current mission, its specification status, test-design coverage, and the latest quality-gate verdict.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to inspect (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                // Configuration facts come first: they describe the WORKSPACE and
                // stay useful even when this session has no mission yet.
                const statusEffective = agent?.session?.header?.cwd === undefined ? undefined : deps.configFor(agent.session.header.cwd)
                const statusConfig = statusEffective?.config ?? deps.config
                const configLines = [
                    `写类工具：${statusConfig.writeTools.join(', ')}；shell 工具：${statusConfig.shellTools.join(', ')}（策略 ${statusConfig.shellPolicy}）` +
                        `；配置来源：${statusEffective?.source === 'project' ? `项目级 ${statusEffective.file ?? ''}` : 'profile'}`,
                    `门禁开关：enforce=${statusConfig.enforce}；文件边界=${statusConfig.enforceBoundaries}；审批模式=${statusConfig.approval}`,
                ]
                const mission = resolveStrict(deps, exec, args.missionId)
                if (mission === undefined) {
                    return [
                        '当前会话没有绑定 mission（本工具不会退回到工作区里最新的 mission）。先调用 spec_create 建立规格。',
                        '',
                        ...configLines,
                    ].join('\n')
                }
                const gate = store.lastGate(mission.id)
                const lines = [describeMission(mission)]
                lines.push(`spec digest: ${mission.specDigest?.slice(0, 16) ?? '(none)'}`)
                lines.push(`负面约束：${describeConstraints(mission.spec?.negativeConstraints ?? [])}`)
                lines.push(...configLines)
                lines.push(
                    `latest gate: ${gate === undefined ? '(none)' : `${gate.state} by ${gate.source} — ${gate.reason}`}`,
                )
                lines.push(
                    `spec-gate 拦截次数：本工作区 ${deps.guard.denialsFor(store.layout.rootDir)} 次` +
                        `（进程内全部工作区合计 ${deps.guard.denials()} 次）`,
                )
                return lines.join('\n')
            },
        }),
        'spec_status',
    )

    return { disposers, registered, failed, ...(registrationError === undefined ? {} : { lastError: registrationError }) }
}

/**
 * Ask the approval seam for a grant.
 * @returns the approver label recorded on the specification.
 * @throws when the approval is rejected, unavailable, or cancelled (fail closed).
 */
async function requestApproval(
    deps: ToolDeps,
    exec: unknown,
    mission: MissionRecord,
    note: string | undefined,
    config: SpecGateConfig,
): Promise<string> {
    if (config.approval === 'auto') return 'auto'
    const context = exec as { agent?: AgentLike; signal?: AbortSignal }
    const approval = deps.approval()
    if (approval === undefined) {
        throw new Error(
            '规格审批未通过：宿主没有装配审批通道（ctx.approval），而 spec-gate 的 approval 模式是 "seam"。' +
                `请让人类审批后把 approval 改为 auto，或装配审批插件。（mission ${mission.id}）`,
        )
    }
    const spec = mission.spec
    const detail = [
        `mission ${mission.id}：${mission.title}`,
        `规格 rev ${spec?.revision ?? '?'}，摘要 ${(mission.specDigest ?? '').slice(0, 12) || '?'}`,
        `验收标准 ${spec?.acceptanceCriteria.length ?? 0} 条，测试用例 ${mission.testDesign?.cases.length ?? 0} 条（未覆盖 ${mission.testDesign?.uncovered.length ?? 0}）`,
        `工件 ${mission.specPath ?? '.dsh/specs/<id>.md'}`,
    ].join('；')
    const outcome = await approval.request({
        ...(context.agent === undefined ? {} : { agent: context.agent }),
        toolName: 'spec_approve',
        reason: note === undefined ? `审批规格（${detail}）` : `${note}（${detail}）`,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    if (outcome === 'allowed-once') return 'approval'
    throw new Error(`规格审批被拒绝（outcome: ${outcome}）：mission ${mission.id} 仍不可写。`)
}

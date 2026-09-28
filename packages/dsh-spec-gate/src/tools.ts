/**
 * The model-facing tool surface: `spec_create`, `spec_approve`, `spec_status`,
 * `spec_bootstrap`.
 * @module dsh-spec-gate/tools
 */

import path from 'node:path'
import { tuiReview, type NvimTuiLike, type ReviewArtifacts } from './review.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    approverName,
    ensureDir,
    formatTime,
    normalizeApprovalReply,
    type ApprovalOutcome,
    renderApprovalContext,
    type ApprovalLike,
    parentSessionIdOf,
    nextStepsAfter,
    scanGaps,
    scanWorkspace,
    sessionIdOf,
    sha256,
    specReviewDigest,
    writeJsonAtomic,
    writeTextAtomic,
    type AgentLike,
    type AmendRequest,
    type GapReport,
    type Layout,
    type MissionRecord,
    type MissionStoreRegistry,
    type ScanResult,
    type SpecChange,
    type SpecRecord,
} from 'dsh-eng-core'
import type { Logger } from 'dsh-eng-core'
import { buildIndex, checkDraft, parseDraftAnswer, renderBrief, renderDraft } from './bootstrap.js'
import type { SpecGateConfig } from './config.js'
import type { WriteGuard } from './guard.js'
import { describeConstraints } from './constraints.js'
import {
    buildSpec,
    describeMission,
    labelsWithMilestone,
    milestoneOf,
    milestoneProblem,
    parseDraftTestDesign,
    renderSpec,
    validateDraft,
    type SpecDraft,
} from './spec.js'
import { amendMissionSpec } from './amend.js'
import {
    applyBudgetEdit,
    declareBudgets,
    defaultBudgetUnit,
    describeThreshold,
    readSpecBudgets,
    renderBudgetChangeLine,
    renderBudgetLine,
    specWithBudgetPlan,
    type BudgetPlan,
    type SpecBudgetInput,
    type SpecRecordWithBudgets,
} from './budgets.js'
import {
    appendPlanRows,
    budgetVerification,
    buildPlanReport,
    describeBudgetVerification,
    describePlanFile,
    logPlanAppend,
    NO_MILESTONE_LABEL,
    planLedgerFile,
    renderPlanReport,
    type PlanRow,
    type PlanRowKind,
} from './plan-ledger.js'
import { adrIndexPath, listAdr, recordAdr, renderAdrList } from './adr.js'

const TEXT_OUTPUT = { type: 'string' } as const

/**
 * The deterministic evidence report.
 *
 * A gap report is what makes bootstrapping honest: it says what the repository
 * HAS, what the specification would be missing, and where each finding came
 * from — no prose, no model, nothing to approve.
 */
function renderScanReport(scan: ScanResult, gaps: GapReport, notes?: string): string {
    const languages = Object.entries(scan.stats.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([language, files]) => `${language} ${files}`)
        .join('、')
    return [
        '## 工作区扫描（spec_bootstrap · scan）',
        '',
        `扫描文件 ${scan.stats.filesScanned} 个${scan.stats.truncated ? '（已达上限，结果被截断）' : ''}${languages === '' ? '' : `；语言：${languages}`}`,
        `构建文件：${scan.buildFiles.join(', ') || '(未识别)'}`,
        `需求文档 ${scan.requirements.length} 份、代码符号 ${scan.symbols.length} 个、测试文件 ${scan.tests.length} 个（用例名 ${scan.tests.reduce((total, file) => total + file.cases.length, 0)} 个）`,
        '',
        '### 识别到的验证命令',
        '',
        ...(scan.suggestedCommands.length === 0
            ? ['- (未识别：请在 `.dsh/quality-gate.json` 里声明门禁命令)']
            : scan.suggestedCommands.map(
                  (command) => `- \`${command.command}\`（${command.phase}${command.required ? '，必需' : ''}）`,
              )),
        '',
        '### 需求文档',
        '',
        ...(scan.requirements.length === 0
            ? ['- (没有找到需求类文档：验收标准只能从代码推断，会全部标 `[推断]`)']
            : scan.requirements.map((doc) => `- ${doc.path}${doc.title === undefined ? '' : ` — ${doc.title}`}（候选条目 ${doc.candidates.length}）`)),
        '',
        '### 缺口',
        '',
        `- 无用例的验收标准：${gaps.criteriaWithoutCases.length} 条`,
        ...gaps.criteriaWithoutCases.slice(0, 10).map((gap) => `  - ${gap.id} ${gap.text}`),
        `- 步骤/预期过短的用例：${gaps.casesWithThinSteps.length} 条`,
        ...gaps.casesWithThinSteps.slice(0, 10).map((gap) => `  - ${gap.id}（${gap.reason}）`),
        `- 覆盖了不存在验收标准的用例：${gaps.testsWithoutCriteria.length} 条`,
        `- 没有任何用例覆盖的代码面：${gaps.uncoveredSymbols.length} 个`,
        ...gaps.uncoveredSymbols.slice(0, 15).map((symbol) => `  - ${symbol.kind} ${symbol.name} — ${symbol.path}:${symbol.line}`),
        `- 缺失的工件：${gaps.missingArtifacts.join('、') || '(无)'}`,
        '',
        ...(notes === undefined || notes.trim() === '' ? [] : [`人工补充说明：${notes.trim()}`, '']),
        '下一步：`spec_bootstrap({ action: "draft" })` 依据这些证据生成规格草稿（草稿仍需 `spec_create` → `test_design_review` → `spec_approve`）。',
    ].join('\n')
}

/**
 * The approval seam. The type is shared with every other plugin now
 * (`dsh-eng-core`'s `ApprovalLike`): a channel answerer may return provenance
 * (who clicked, which card), and the ledger records it.
 */
export type { ApprovalLike }
export type ApprovalSeam = ApprovalLike

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
    /**
     * The host's structured-question channel (`ctx.get('userQuestions')`), used
     * to ask WHY a specification was rejected. Absent = rejections carry no note.
     */
    questions: () => QuestionsLike | undefined
    /**
     * The nvim-tui extension API (`ctx.get('nvim-tui')`), when the host is that
     * TUI: the review card lives there (open the artifacts, type the note).
     */
    nvimTui: () => NvimTuiLike | undefined
    /** `ctx.get('subagents')`, used to dispatch the READ-ONLY drafting child. */
    subagents: () => SubagentsLike | undefined
}

/** Structural view of `@deepseek-ai/dsh-user-questions`' service. */
interface QuestionsLike {
    ask: (request: {
        agent: AgentLike
        signal?: AbortSignal
        questions: {
            id: string
            question: string
            detail?: string
            header?: string
            multiSelect?: boolean
            options?: { label: string; description?: string }[]
        }[]
    }) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

interface CreateArgs {
    title: string
    background?: string
    requirements: string[]
    acceptanceCriteria: string[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    testDesign?: string
    /** Milestone the requirements belong to (required when `milestoneRequired`). */
    milestone?: string
    /**
     * 非功能预算（p95、包体积、迁移耗时…）。省略 = 不改动已有声明；`[]` = 明确删掉全部
     * （被删的编号进入 retired，永不复用）。
     */
    budgets?: SpecBudgetInput[]
    /** 变更理由（记进预算变更历史）。 */
    note?: string
    missionId?: string
}

interface ApproveArgs {
    missionId?: string
    note?: string
}

interface StatusArgs {
    missionId?: string
}

interface PlanStatusArgs {
    milestone?: string
    missionId?: string
    json?: boolean
}

interface AmendArgs {
    /** Which list the edit addresses. Omitted only when `budgets` declares the whole set. */
    part?: 'requirement' | 'criterion' | 'budget'
    /** `add` / `update` / `remove`; required whenever `part` is given. */
    action?: 'add' | 'update' | 'remove'
    target?: string
    text?: string
    /** `part: 'budget'` 的新定义（完整替换，不是补丁）。 */
    budget?: SpecBudgetInput
    /** 整组重声明非功能预算（声明即现状：不在列表里的活预算会被删除并作废编号）。 */
    budgets?: SpecBudgetInput[]
    note?: string
    cascade?: boolean
    /** Milestone to set/change along with this amendment. */
    milestone?: string
    missionId?: string
}

interface AdrRecordArgs {
    title: string
    decision: string
    alternatives?: string
    consequences?: string
    missionId?: string
    supersedes?: number
}

interface AdrListArgs {
    query?: string
    missionId?: string
}

interface BootstrapArgs {
    action?: 'brief' | 'draft' | 'check'
    acceptanceCriteria?: string[]
    testDesign?: string
    missionId?: string
    focus?: string
    maxCases?: number
}

/** Minimal structural view of `ctx.subagents`. */
interface SubagentsLike {
    start: (
        provider: string,
        request: {
            label?: string
            prompt: { type: 'text'; text: string }[]
            parent: never
            signal: AbortSignal
            toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
            persona?: string
            maxDepth?: number
        },
    ) => Promise<{
        id: string
        result: Promise<{ stopReason?: string; output?: { type?: string; text?: string }[]; diagnostic?: string }>
        dispose?: () => Promise<void>
    }>
}

/** Bound one child-agent run so a stuck draft cannot wedge the tool call. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), Math.max(1_000, timeoutMs))
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
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

/**
 * Validate the optional `milestone` argument of `spec_create` / `spec_amend`.
 *
 * Fail closed BEFORE anything is written: a rejected name must not leave a
 * half-updated mission behind, and the refusal names both the rule and the fix.
 * @throws when the value is not a usable milestone name.
 */
function milestoneArg(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') {
        throw new Error(`milestone 必须是字符串（收到 ${typeof value}）：例如 milestone: "v1.2"；省略该参数表示不设里程碑。`)
    }
    const problem = milestoneProblem(value)
    if (problem !== undefined) {
        throw new Error(`${problem}。下一步：改成 ≤64 字符、不含控制字符的短标签（如 "v1.2" / "M3"）后重试，或省略该参数。`)
    }
    return value.trim()
}

/**
 * One ledger row describing a mission's CURRENT specification revision.
 *
 * Every row carries the full id list, which is what makes "the newest row wins"
 * safe: a later `milestone-changed` row cannot lose the requirements an earlier
 * `spec-created` row had recorded. The same holds for the non-functional budgets:
 * `budgetIds` is the complete list of live budget ids after the transition (and is
 * always present, so a later row never drops an earlier row's declaration).
 */
function planRowFor(
    mission: MissionRecord,
    spec: SpecRecord,
    kind: PlanRowKind,
    at: number,
    summary: string,
    extra: {
        milestone?: string
        approvedBy?: string
        retired?: readonly string[]
        retiredBudgets?: readonly string[]
    } = {},
): PlanRow {
    const budgets = readSpecBudgets(spec).budgets.map((budget) => budget.id)
    return {
        at,
        kind,
        missionId: mission.id,
        // This suite keys the specification artifact by mission; the column
        // exists so the two can be decoupled later without rewriting the ledger.
        specId: mission.id,
        title: spec.title,
        ...(extra.milestone === undefined ? {} : { milestone: extra.milestone }),
        requirementIds: spec.requirements.map((entry) => entry.id),
        criteriaIds: spec.acceptanceCriteria.map((entry) => entry.id),
        budgetIds: budgets,
        ...(extra.retired === undefined || extra.retired.length === 0 ? {} : { retiredRequirementIds: [...extra.retired] }),
        ...(extra.retiredBudgets === undefined || extra.retiredBudgets.length === 0
            ? {}
            : { retiredBudgetIds: [...extra.retiredBudgets] }),
        ...(extra.approvedBy === undefined ? {} : { approvedBy: extra.approvedBy }),
        summary,
    }
}

/** The budget ids a transition retired (the difference between two retired lists). */
function newlyRetiredBudgets(before: readonly string[], after: readonly string[]): string[] {
    return after.filter((id) => !before.some((entry) => entry.toLowerCase() === id.toLowerCase()))
}

/** One line naming the budgets a specification revision carries. */
function describeBudgetsOf(spec: SpecRecord | undefined): string {
    const read = readSpecBudgets(spec)
    const declared =
        read.budgets.length === 0
            ? '未声明'
            : `${read.budgets.length} 条 —— ${read.budgets
                  .map((budget) => `${budget.id}（${describeThreshold(budget.threshold, budget.unit ?? defaultBudgetUnit(budget.metric))}）`)
                  .join('、')}`
    const retired = read.retired.length === 0 ? '' : `；已作废预算编号（不会复用）：${read.retired.join('、')}`
    return `非功能预算：${declared}${retired}`
}

/**
 * Append the plan ledger's rows for one transition.
 *
 * The specification is the authority and the ledger is an index, so this never
 * throws: a failure is logged and returned as lines the tool appends to its
 * output, where the model can see that `plan_status` will not know about the
 * change.
 */
function recordPlan(deps: ToolDeps, layout: Layout, config: SpecGateConfig, rows: readonly PlanRow[]): string[] {
    if (rows.length === 0) return []
    const file = planLedgerFile(layout, config)
    const logger = deps.logger.for(layout.cwd)
    const result = appendPlanRows(file, rows, logger)
    logPlanAppend(logger, result, file)
    if (result.warning === undefined) return []
    return ['', result.warning, `台账文件：${describePlanFile(layout, file)}`]
}

/** One line of the change history a report shows. */
function renderChangeLine(change: SpecChange): string {
    const body = change.kind.startsWith('add-')
        ? `新增 → ${change.after ?? ''}`
        : change.kind.startsWith('update-')
          ? `修改：${change.before ?? ''} → ${change.after ?? ''}`
          : `删除（原内容：${change.before ?? ''}）${
                change.coveredBy === undefined ? '' : `，同时移除用例 ${change.coveredBy.join('、')}`
            }`
    return `- ${formatTime(change.at)} [${change.kind}] ${change.target} ${body}${
        change.note === undefined ? '' : `（理由：${change.note}）`
    }`
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
                milestone: {
                    type: 'string',
                    description:
                        'Optional planning milestone these requirements belong to (`v1.2`, `M3`; ≤64 chars, no control characters). `plan_status` groups every mission\'s requirements by it. Omitted = keep the mission\'s current milestone unchanged; a mission without one is REFUSED when the workspace sets milestoneRequired.',
                },
                budgets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            id: { type: 'string', description: 'Stable id (`p95-health`; letters/digits/-/_ only) — also the baseline key in the quality gate, so it is never reused.' },
                            name: { type: 'string', description: 'Human-readable name shown in reports (e.g. 健康检查 p95).' },
                            metric: { type: 'string', enum: ['durationMs', 'number', 'bytes'], description: 'durationMs = the command\'s wall time; number/bytes = a number extracted from its output via regex.' },
                            unit: { type: 'string', description: 'Display unit; defaults to ms / bytes / count by metric.' },
                            command: { type: 'string', description: 'The exact command line to measure (argv, no shell).' },
                            regex: { type: 'string', description: 'Required for number/bytes, refused for durationMs: the FIRST CAPTURING GROUP must be a plain number.' },
                            threshold: {
                                type: 'object',
                                additionalProperties: true,
                                properties: {
                                    max: { type: 'number', description: 'Upper bound: the value must be ≤ max.' },
                                    min: { type: 'number', description: 'Lower bound: the value must be ≥ min.' },
                                    maxRegressionPercent: { type: 'number', description: 'Allowed regression against the best recorded value, in percent.' },
                                },
                                description: 'At least one bound is required: without a bound the budget can never be judged.',
                            },
                            requirementIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'The requirements/criteria this budget guards (`AC-003`); every id must exist in THIS specification (an unknown id is refused, never ignored).',
                            },
                        },
                    },
                    description:
                        'Non-functional requirements as measurable budgets (p95 < 50ms, bundle ≤ 200KiB, migration < 2s). They are part of the specification: approved with it, rendered in the 非功能预算 table, indexed in the plan ledger, and measured by the quality gate (which reports them as 来源：规格). Omitted = keep the mission\'s current declarations unchanged; `[]` = explicitly remove them all (the ids are RETIRED and never reused).',
                },
                note: { type: 'string', description: 'Why the budgets changed (recorded in the budget change history).' },
                missionId: { type: 'string', description: 'Revise an existing mission instead of creating one.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: CreateArgs = {} as CreateArgs, exec) {
                const { store, agent, cwd } = storeFor(deps, exec)
                const effective = effectiveFor(deps, agent)
                const milestone = milestoneArg(args.milestone)
                const draft: SpecDraft = {
                    title: args.title ?? '',
                    background: args.background ?? '',
                    requirements: args.requirements ?? [],
                    acceptanceCriteria: args.acceptanceCriteria ?? [],
                    fileBoundaries: args.fileBoundaries ?? [],
                    negativeConstraints: args.negativeConstraints ?? [],
                    ...(milestone === undefined ? {} : { milestone }),
                    ...(args.budgets === undefined ? {} : { budgets: args.budgets }),
                    ...(args.note === undefined ? {} : { note: args.note }),
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
                if (milestone === undefined && effective.milestoneRequired && milestoneOf(existing) === undefined) {
                    // A rewrite of a mission that already HAS a milestone inherits
                    // it (omitting the argument means "do not change it"), so the
                    // rule is about the resulting spec, not about the argument.
                    throw new Error(
                        [
                            'spec_create 未写入任何文件：本仓库要求每个规格声明里程碑（milestoneRequired=true），' +
                                '否则 plan_status 无法把需求归到任何迭代里。',
                            '下一步：给 spec_create 传 milestone（例如 milestone: "v1.2" / "M3"），' +
                                '或由宿主或 .dsh/spec-gate.json 把 milestoneRequired 改回 false。',
                        ].join('\n'),
                    )
                }
                // 预算校验与测试设计解析都在写任何文件之前完成：声明有问题就什么都不写
                //（否则会留下一个没有规格的 mission 目录）。
                const design = parseDraftTestDesign(draft)
                const spec = buildSpec(draft, existing?.spec)
                const mission =
                    existing ??
                    store.create({
                        title: draft.title.trim(),
                        cwd,
                        ...(sessionId === undefined ? {} : { sessionId }),
                    })
                const revised = existing !== undefined
                const previousMilestone = milestoneOf(existing)
                const updated = store.update(mission.id, (record) => ({
                    title: draft.title.trim(),
                    // A revision always revokes the previous approval, and a
                    // revision that does not carry a fresh test design also
                    // drops the previous one: it was reviewed against
                    // acceptance criteria that no longer exist, so keeping it
                    // would let an unreviewed criterion ride on an old PASS.
                    status: 'draft',
                    spec,
                    testDesign: design ?? (revised ? undefined : mission.testDesign),
                    // The milestone rides on the mission's labels (the shared
                    // record has no planning field, and this plugin does not
                    // extend the shared contract).
                    ...(milestone === undefined ? {} : { labels: labelsWithMilestone(record.labels, milestone) }),
                }))
                if (updated === undefined) throw new Error(`mission ${mission.id} disappeared while writing the specification`)
                const markdown = renderSpec(updated)
                const file = store.writeSpec(mission.id, markdown)
                if (sessionId !== undefined) store.bindSession(sessionId, mission.id)
                const now = Date.now()
                const retiredBudgets = newlyRetiredBudgets(readSpecBudgets(existing?.spec).retired, readSpecBudgets(spec).retired)
                const ledgerRows: PlanRow[] = [
                    planRowFor(
                        updated,
                        spec,
                        'spec-created',
                        now,
                        `${revised ? '重写' : '新建'}规格 revision ${spec.revision}：需求 ${spec.requirements.length} 条、验收标准 ${spec.acceptanceCriteria.length} 条` +
                            `、非功能预算 ${readSpecBudgets(spec).budgets.length} 条`,
                        {
                            ...(milestone === undefined ? {} : { milestone }),
                            ...(retiredBudgets.length === 0 ? {} : { retiredBudgets }),
                        },
                    ),
                ]
                if (retiredBudgets.length > 0) {
                    ledgerRows.push(
                        planRowFor(updated, spec, 'budget-retired', now, `作废预算 ${retiredBudgets.join('、')}（编号不复用）`, {
                            ...(milestone === undefined ? {} : { milestone }),
                            retiredBudgets,
                        }),
                    )
                }
                if (milestone !== undefined && milestone !== previousMilestone) {
                    // Only the transitions that actually happened are recorded.
                    ledgerRows.push(
                        planRowFor(updated, spec, 'milestone-changed', now, `里程碑：${previousMilestone ?? '(无)'} → ${milestone}`, {
                            milestone,
                        }),
                    )
                }
                const designNote =
                    design === undefined
                        ? '测试设计章节为空：spec_approve 之前需要补齐并运行 test_design_review。'
                        : `已解析测试用例 ${design.cases.length} 条，未覆盖验收标准 ${design.uncovered.length} 条。`
                const constraintNote = `负面约束：${describeConstraints(spec.negativeConstraints)}`
                return [
                    `规格已写入：${file}`,
                    `mission: ${mission.id}（revision ${spec.revision}，状态 draft）`,
                    `验收标准：${spec.acceptanceCriteria.map((criterion) => criterion.id).join(', ')}`,
                    ...(milestone === undefined ? [] : [`里程碑：${milestone}`]),
                    describeBudgetsOf(spec),
                    designNote,
                    constraintNote,
                    ...recordPlan(deps, store.layout, effective, ledgerRows),
                    needsTestDesign(deps, effective)
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
                const decision = await requestApproval(deps, exec, mission, args.note, effective)
                if ('outcome' in decision) {
                    // Rejected (or cancelled): record the round, keep the human's
                    // note when the review card already collected one, and send the
                    // model back to `spec_create`.
                    return await handleRejection(deps, exec, mission, decision.outcome, decision.note ?? args.note)
                }
                // WHO approved matters: an IM click carries a user id and the card
                // it came from, and the ledger keeps both. A terminal answerer that
                // reports no identity still records `approval`.
                const approvedBy = approverName(decision)
                const approved = store.update(mission.id, (record) => ({
                    status: 'spec-approved',
                    spec:
                        record.spec === undefined
                            ? undefined
                            : {
                                  ...record.spec,
                                  approvedAt: Date.now(),
                                  approvedBy,
                                  // Provenance rides on the revision that was approved:
                                  // a card click must name the surface (and the message)
                                  // without touching the rejection bookkeeping in
                                  // `mission.approval`.
                                  ...(decision.source === '' ? {} : { approvedSource: decision.source }),
                                  ...(decision.messageId === '' ? {} : { approvalMessageId: decision.messageId }),
                                  updatedAt: Date.now(),
                              },
                }))
                if (approved === undefined) throw new Error(`mission ${mission.id} disappeared while approving`)
                // Re-render so the artifact carries the approval header.
                store.writeSpec(mission.id, renderSpec(approved))
                const approvedMilestone = milestoneOf(approved)
                const approvalRows: PlanRow[] =
                    approved.spec === undefined
                        ? []
                        : [
                              planRowFor(
                                  approved,
                                  approved.spec,
                                  'spec-approved',
                                  Date.now(),
                                  `规格已审批（by ${approvedBy}${decision.source === '' ? '' : ` via ${decision.source}`}）`,
                                  { ...(approvedMilestone === undefined ? {} : { milestone: approvedMilestone }), approvedBy },
                              ),
                          ]
                return [
                    `规格已审批（mission ${mission.id}，by ${approvedBy}${decision.source === '' ? '' : ` via ${decision.source}`}${decision.messageId === '' ? '' : ` #${decision.messageId}`}，${formatTime(Date.now())}）。`,
                    ...recordPlan(deps, store.layout, effective, approvalRows),
                    '写操作现已放行。下一步：按规格实现 → evidence_record 登记验证输出 → quality_gate_run 跑门禁 → mission_complete 交付。',
                ].join('\n')
            },
        }),
        'spec_approve',
    )

    register(
        defineTool({
            name: 'spec_amend',
            description:
                'Add, reword or remove ONE requirement, acceptance criterion or non-functional budget of an existing specification, without losing the standard process — or re-declare the whole budget set at once with `budgets`. Ids are stable: an edit keeps them attached to their text (a test case citing AC-003 keeps meaning the same statement), a removed id is RETIRED and never reused (a retired budget id is refused even in a later declaration), and the change is recorded (who/when/before→after) in the specification a human approves. The revision invalidates the approval, so the mission goes back to the specification stage: update the affected test cases, run test_design_review again, then spec_approve. Removing a criterion that test cases cover is REFUSED unless `cascade: true`, which also drops those cases (and forces a re-review) — a deletion must never leave coverage pointing at nothing.',
            parameters: {
                part: {
                    type: 'string',
                    enum: ['requirement', 'criterion', 'budget'],
                    description:
                        'requirement = the 需求 list (R-00n); criterion = the 验收标准 table (AC-00n); budget = the 非功能预算 table (a declared budget id). Required together with `action`, unless `budgets` re-declares the whole budget set.',
                },
                action: {
                    type: 'string',
                    enum: ['add', 'update', 'remove'],
                    description:
                        'add (needs text, or a full `budget`) / update (needs target + text or `budget`) / remove (needs target). Required together with `part`.',
                },
                target: { type: 'string', description: 'The id to change, e.g. `AC-003` or a budget id; omitted for add (a budget may also carry its id in `budget.id`).' },
                text: { type: 'string', description: 'The new statement; required for add and update of a requirement/criterion.' },
                budget: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        id: { type: 'string', description: 'Budget id (letters/digits/-/_); must match `target` when both are given, and can never reuse a retired id.' },
                        name: { type: 'string', description: 'Human-readable name shown in reports.' },
                        metric: { type: 'string', enum: ['durationMs', 'number', 'bytes'], description: 'What is measured.' },
                        unit: { type: 'string', description: 'Display unit; defaults to ms / bytes / count by metric.' },
                        command: { type: 'string', description: 'The exact command line to measure (argv, no shell).' },
                        regex: { type: 'string', description: 'Required for number/bytes, refused for durationMs; first capturing group = the number.' },
                        threshold: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                max: { type: 'number', description: 'Upper bound (≤ max).' },
                                min: { type: 'number', description: 'Lower bound (≥ min).' },
                                maxRegressionPercent: { type: 'number', description: 'Allowed regression vs the best recorded value, in percent.' },
                            },
                            description: 'At least one bound is required.',
                        },
                        requirementIds: { type: 'array', items: { type: 'string' }, description: 'The requirements/criteria this budget guards; every id must exist in this specification.' },
                    },
                    description: 'part:"budget" 的新定义（完整替换，不是补丁）：id/name/metric/command/threshold 都要写全。',
                },
                budgets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            id: { type: 'string', description: 'Stable budget id; never a retired one.' },
                            name: { type: 'string', description: 'Human-readable name.' },
                            metric: { type: 'string', enum: ['durationMs', 'number', 'bytes'], description: 'What is measured.' },
                            unit: { type: 'string', description: 'Display unit.' },
                            command: { type: 'string', description: 'The exact command line to measure.' },
                            regex: { type: 'string', description: 'Required for number/bytes; first capturing group = the number.' },
                            threshold: {
                                type: 'object',
                                additionalProperties: true,
                                properties: {
                                    max: { type: 'number', description: 'Upper bound (≤ max).' },
                                    min: { type: 'number', description: 'Lower bound (≥ min).' },
                                    maxRegressionPercent: { type: 'number', description: 'Allowed regression vs the best recorded value, in percent.' },
                                },
                                description: 'At least one bound is required.',
                            },
                            requirementIds: { type: 'array', items: { type: 'string' }, description: 'The requirements/criteria this budget guards.' },
                        },
                    },
                    description:
                        'Re-declare the WHOLE budget set: what is listed is live (same id = same budget, changed content = update), every live budget that is NOT listed is removed and its id RETIRED. `[]` removes them all; omitted = leave the budgets untouched. Cannot be combined with part/action in one call.',
                },
                note: { type: 'string', description: 'Why the change; recorded in the change history (requirements and budgets alike).' },
                cascade: {
                    type: 'boolean',
                    description: 'Allow removing a criterion that test cases cover (the cases are dropped too and must be re-reviewed).',
                },
                milestone: {
                    type: 'string',
                    description:
                        'Set or change the mission\'s milestone along with this edit (`v1.2`, `M3`; ≤64 chars, no control characters). Omitted = keep the current milestone. A real change is recorded as a `milestone-changed` transition in the plan ledger.',
                },
                missionId: { type: 'string', description: 'Mission whose specification is edited (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: AmendArgs = {} as AmendArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                // Validated before anything is written: a rejected name must not
                // leave a half-edited specification behind.
                const requestedMilestone = milestoneArg(args.milestone)
                const mission = resolveStrict(deps, exec, args.missionId)
                if (mission === undefined) {
                    return [
                        '当前会话没有绑定 mission：没有可增删改的规格。',
                        '',
                        '下一步：先 `spec_create` 建立规格；已有规格的 mission 请显式传 missionId。',
                    ].join('\n')
                }
                const by = sessionIdOf(agent) ?? 'spec_amend'
                const spec = mission.spec
                if (spec === undefined) {
                    return [
                        `## 未改动（mission ${mission.id} 还没有规格）`,
                        '',
                        '下一步：先调用 `spec_create` 建立规格（增删改是在已有规格上做的编辑）。',
                    ].join('\n')
                }
                const hasEdit = args.part !== undefined || args.action !== undefined
                if (args.budgets !== undefined && hasEdit) {
                    return [
                        '## 未改动（budgets 与 part/action 同时给出）',
                        '',
                        '一次调用只做一件事：要么用 part + action 改一条（requirement / criterion / budget），要么用 budgets 整组重声明非功能预算。',
                        '同时给出会写出两段语义不同的变更，无法在一次修订里讲清楚。',
                        '',
                        '### 下一步',
                        '',
                        '分两次调用：先改那一条，再整组重声明预算（或反过来）。',
                    ].join('\n')
                }
                if (args.budgets === undefined && (args.part === undefined || args.action === undefined)) {
                    return [
                        '## 未改动（缺少 part/action）',
                        '',
                        'spec_amend 需要二选一：`part`（requirement / criterion / budget）+ `action`（add / update / remove）改一条，',
                        '或者 `budgets` 整组重声明非功能预算（声明即现状，未列出的会被删除并作废编号）。',
                        '',
                        '### 下一步',
                        '',
                        '例：`spec_amend({ part: "criterion", action: "update", target: "AC-002", text: "…" })`，',
                        '或 `spec_amend({ budgets: [{ id: "p95-health", … }] })`。',
                    ].join('\n')
                }

                // --- 预算：整组重声明或单条编辑（都不经过 core 的 planAmendment） -----
                if (args.budgets !== undefined || args.part === 'budget') {
                    const read = readSpecBudgets(spec)
                    const context = {
                        requirementIds: spec.requirements.map((requirement) => requirement.id),
                        criterionIds: spec.acceptanceCriteria.map((criterion) => criterion.id),
                        retiredBudgets: read.retired,
                        retiredSpecIds: spec.retired ?? [],
                    }
                    let plan: BudgetPlan
                    let summary: string
                    if (args.budgets !== undefined) {
                        const declared = declareBudgets(read.budgets, args.budgets, {
                            ...context,
                            by,
                            ...(args.note === undefined ? {} : { note: args.note }),
                        })
                        if (!declared.ok) {
                            return [
                                '## 未改动（重声明非功能预算）',
                                '',
                                ...declared.problems.map((problem) => `- ${problem}`),
                                '',
                                '预算声明没有任何改动，规格也没有升版本（失败不会留下半份文档）。',
                            ].join('\n')
                        }
                        plan = declared.plan
                        summary = declared.plan.summary
                    } else {
                        const edited = applyBudgetEdit(
                            read.budgets,
                            { ...context, by },
                            {
                                action: args.action as 'add' | 'update' | 'remove',
                                ...(args.target === undefined || args.target === '' ? {} : { target: args.target }),
                                ...(args.budget === undefined ? {} : { budget: args.budget }),
                                ...(args.note === undefined ? {} : { note: args.note }),
                            },
                        )
                        if (!edited.ok) {
                            return [
                                `## 未改动（${args.action} budget${args.target === undefined ? '' : ` ${args.target}`}）`,
                                '',
                                edited.problem,
                                ...(edited.nextSteps === undefined ? [] : ['', '### 下一步', '', edited.nextSteps]),
                                '',
                                '预算声明没有任何改动，规格也没有升版本（失败不会留下半份文档）。',
                            ].join('\n')
                        }
                        plan = edited.plan
                        summary = edited.summary
                    }
                    const now = Date.now()
                    // The milestone is applied FIRST, so every row below records the
                    // state after this call.
                    let milestoneNote: string | undefined
                    if (requestedMilestone !== undefined) {
                        const before = milestoneOf(mission)
                        if (before !== requestedMilestone) {
                            store.update(mission.id, (record) => ({ labels: labelsWithMilestone(record.labels, requestedMilestone) }))
                            milestoneNote = `里程碑：${before ?? '(无)'} → ${requestedMilestone}`
                        }
                    }
                    const updated = store.update(mission.id, (record) => {
                        const current = record.spec ?? spec
                        const next: SpecRecordWithBudgets = specWithBudgetPlan(current, plan)
                        return {
                            // A budget is part of the document a human approved: the
                            // revision revokes the approval (and only the approval —
                            // the test design still covers the same criteria/cases).
                            status: 'draft',
                            spec: {
                                ...next,
                                revision: current.revision + 1,
                                updatedAt: now,
                                approvedAt: undefined,
                                approvedBy: undefined,
                                approvedSource: undefined,
                                approvalMessageId: undefined,
                            },
                        }
                    })
                    if (updated === undefined) return `mission ${mission.id} 在写入时消失。`
                    const file = store.writeSpec(mission.id, renderSpec(updated))
                    const amended = store.read(mission.id) ?? updated
                    const amendedSpec = amended.spec ?? spec
                    const retiredNow = newlyRetiredBudgets(read.retired, readSpecBudgets(amendedSpec).retired)
                    const milestoneRow = milestoneOf(amended)
                    const milestoneField = milestoneRow === undefined ? {} : { milestone: milestoneRow }
                    const ledgerRows: PlanRow[] = []
                    if (plan.changes.length > 0 || args.budgets !== undefined) {
                        ledgerRows.push(planRowFor(amended, amendedSpec, 'spec-amended', now, summary, milestoneField))
                    }
                    if (milestoneNote !== undefined) {
                        ledgerRows.push(planRowFor(amended, amendedSpec, 'milestone-changed', now, milestoneNote, milestoneField))
                    }
                    if (retiredNow.length > 0) {
                        ledgerRows.push(
                            planRowFor(amended, amendedSpec, 'budget-retired', now, `作废预算 ${retiredNow.join('、')}（编号不复用）`, {
                                ...milestoneField,
                                retiredBudgets: retiredNow,
                            }),
                        )
                    }
                    const budgetHistory = readSpecBudgets(amendedSpec).changes.slice(-5)
                    return [
                        `## 已改动规格（revision ${amendedSpec.revision}）`,
                        '',
                        summary,
                        `需求文档：${path.relative(mission.cwd, path.join(store.layout.missionsDir, mission.id, 'spec.md'))}（已重新渲染）`,
                        describeBudgetsOf(amendedSpec),
                        ...(milestoneNote === undefined ? [] : [`里程碑：${milestoneRow ?? requestedMilestone}`]),
                        ...recordPlan(deps, store.layout, effectiveFor(deps, agent), ledgerRows),
                        '',
                        '### 预算变更历史（最近 5 条，无变更时为空）',
                        '',
                        ...(budgetHistory.length === 0 ? ['(无)'] : budgetHistory.map(renderBudgetChangeLine)),
                        '',
                        '### 下一步（标准流程）',
                        '',
                        nextStepsAfter(amendedSpec, [summary]),
                    ].join('\n')
                }

                const request: AmendRequest = {
                    part: args.part as 'requirement' | 'criterion',
                    action: args.action as 'add' | 'update' | 'remove',
                    ...(args.target === undefined || args.target === '' ? {} : { target: args.target }),
                    ...(args.text === undefined ? {} : { text: args.text }),
                    ...(args.note === undefined ? {} : { note: args.note }),
                    ...(args.cascade === true ? { cascade: true } : {}),
                }
                const outcome = amendMissionSpec(
                    { store, ...(args.missionId === undefined ? {} : {}) },
                    mission.id,
                    request,
                    by,
                )
                if (!outcome.ok) {
                    return [
                        `## 未改动（${args.action} ${args.part}${args.target === undefined ? '' : ` ${args.target}`}）`,
                        '',
                        outcome.problem,
                        ...(outcome.coveredBy === undefined ? [] : ['', `涉及用例：${outcome.coveredBy.join('、')}`]),
                        ...(outcome.nextSteps === undefined ? [] : ['', '### 下一步', '', outcome.nextSteps]),
                    ].join('\n')
                }
                const now = Date.now()
                // The milestone is applied FIRST, so every row below records the
                // state after this call: the ledger is an index of what happened,
                // not a plan.
                let milestoneNote: string | undefined
                if (requestedMilestone !== undefined) {
                    const before = milestoneOf(mission)
                    if (before !== requestedMilestone) {
                        store.update(mission.id, (record) => ({ labels: labelsWithMilestone(record.labels, requestedMilestone) }))
                        milestoneNote = `里程碑：${before ?? '(无)'} → ${requestedMilestone}`
                    }
                }
                const amended = store.read(mission.id) ?? mission
                const amendedSpec = amended.spec ?? mission.spec
                const ledgerRows: PlanRow[] = []
                if (amendedSpec !== undefined) {
                    const milestone = milestoneOf(amended)
                    const milestoneField = milestone === undefined ? {} : { milestone }
                    // Order matters: the later row wins a same-millisecond tie,
                    // and the retirement must be the newest mention of the id it
                    // retires (the rows after it no longer list that id).
                    ledgerRows.push(planRowFor(amended, amendedSpec, 'spec-amended', now, outcome.summary, milestoneField))
                    if (milestoneNote !== undefined) {
                        ledgerRows.push(planRowFor(amended, amendedSpec, 'milestone-changed', now, milestoneNote, milestoneField))
                    }
                    if (outcome.change.kind.startsWith('remove-')) {
                        ledgerRows.push(
                            planRowFor(
                                amended,
                                amendedSpec,
                                'requirement-retired',
                                now,
                                `作废 ${outcome.change.target}（原内容：${outcome.change.before ?? ''}），编号不复用`,
                                { ...milestoneField, retired: [outcome.change.target] },
                            ),
                        )
                    }
                }
                const history = (store.read(mission.id)?.spec?.changes ?? []).slice(-5)
                return [
                    `## 已改动规格（revision ${outcome.revision}）`,
                    '',
                    outcome.summary,
                    `需求文档：${path.relative(mission.cwd, path.join(store.layout.missionsDir, mission.id, 'spec.md'))}（已重新渲染）`,
                    ...(outcome.removedCases.length === 0 ? [] : [`已移除用例：${outcome.removedCases.join('、')}`]),
                    ...(requestedMilestone === undefined ? [] : [`里程碑：${requestedMilestone}`]),
                    ...recordPlan(deps, store.layout, effectiveFor(deps, agent), ledgerRows),
                    '',
                    '### 变更历史（最近 5 条）',
                    '',
                    ...history.map(renderChangeLine),
                    '',
                    '### 下一步（标准流程）',
                    '',
                    nextStepsAfter(store.read(mission.id)?.spec ?? mission.spec!, [outcome.summary]),
                ].join('\n')
            },
        }),
        'spec_amend',
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
                lines.push(
                    `里程碑: ${milestoneOf(mission) ?? '(未设置——plan_status 会把它归入「无里程碑」)'}` +
                        `；规划台账: ${describePlanFile(store.layout, planLedgerFile(store.layout, statusConfig))}`,
                )
                lines.push(`负面约束：${describeConstraints(mission.spec?.negativeConstraints ?? [])}`)
                // 非功能预算：声明 + 验证状态。未验证要写清楚含义 —— 一个预算旁边空着，
                // 看起来像"通过了"。
                const declaredBudgets = readSpecBudgets(mission.spec)
                lines.push(
                    declaredBudgets.budgets.length === 0
                        ? `非功能预算: 未声明${declaredBudgets.retired.length === 0 ? '（spec_create / spec_amend 的 budgets 参数可声明 p95、包体积这类要求）' : `；已作废编号（不会复用）：${declaredBudgets.retired.join('、')}`}`
                        : `非功能预算: ${declaredBudgets.budgets.length} 条（未验证 ${declaredBudgets.budgets.filter((budget) => !budgetVerification(store, mission.id, budget.id).verified).length} 条 —— 未验证 ≠ 通过）`,
                )
                for (const budget of declaredBudgets.budgets) {
                    const unit = budget.unit ?? defaultBudgetUnit(budget.metric)
                    lines.push(
                        `  · ${renderBudgetLine(budget)}；验证：${describeBudgetVerification(budgetVerification(store, mission.id, budget.id))}`,
                    )
                }
                if (declaredBudgets.budgets.length > 0 && declaredBudgets.retired.length > 0) {
                    lines.push(`  已作废预算编号（不会复用）：${declaredBudgets.retired.join('、')}`)
                }
                for (const problem of declaredBudgets.problems) lines.push(`  ⚠️ ${problem}`)
                lines.push(...configLines)
                lines.push(
                    `latest gate: ${gate === undefined ? '(none)' : `${gate.state} by ${gate.source} — ${gate.reason}`}`,
                )
                // The two artifacts a human reviews, and how the review has gone
                // so far: the approval is a loop, so its history is status.
                const missionsDir = store.layout.missionsDir
                lines.push(`需求文档: ${mission.specPath ?? `(未生成)`}`)
                lines.push(`测试用例: ${path.relative(mission.cwd, path.join(missionsDir, mission.id, 'test-design-review.md'))}`)
                lines.push(
                    mission.approval === undefined
                        ? '审批记录: 尚无（第 1 次送审还未决定）'
                        : `审批记录: 第 ${mission.approval.round} 次 → ${
                              mission.approval.state === 'approved' ? '通过' : '打回'
                          }（by ${mission.approval.by}，${formatTime(mission.approval.at)}）${
                              mission.approval.note === undefined ? '' : `；人工意见：${mission.approval.note}`
                          }`,
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

    register(
        defineTool({
            name: 'spec_bootstrap',
            description:
                'Bootstrap a specification for a repository that already exists. The MODEL reads the code: `action:"brief"` returns the authoring contract (acceptance criteria + the test-design table with 前置条件/操作步骤/预期结果) plus a read-only index of where to look and the known gaps — then you read the repository with your own read/grep/glob and write the draft. `action:"draft"` does the same through a READ-ONLY CHILD agent (its tool filter has no write/edit/bash), returning the draft it produced. `action:"check"` validates an authored draft before you submit it: unparsable rows, acceptance criteria without cases, steps shorter than the minimum, leftover placeholders. A draft is never an approval — it still goes through spec_create → test_design_review → spec_approve.',
            parameters: {
                action: {
                    type: 'string',
                    enum: ['brief', 'draft', 'check'],
                    required: true,
                    description: 'brief = contract + index for you to write; draft = the same task handed to a read-only child agent; check = validate a draft.',
                },
                acceptanceCriteria: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'check: the criteria lines (`AC-001 …`).',
                },
                testDesign: { type: 'string', description: 'check: the `## 测试设计` markdown (three scenario sections, five columns).' },
                missionId: { type: 'string', description: 'Compare against this mission (default: the session mission, if any).' },
                focus: { type: 'string', description: 'Extra focus for the drafting child (e.g. "重点补 HTTP 层").' },
                maxCases: { type: 'integer', description: 'Upper bound on cases (default: host config).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: BootstrapArgs = {} as BootstrapArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = effectiveFor(deps, agent)
                if (!config.bootstrap.enabled) {
                    throw new Error('spec_bootstrap 已被宿主禁用（bootstrap.enabled=false）')
                }
                const store = deps.stores.for(cwd)
                const mission = resolveStrict(deps, exec, args.missionId)

                // `check` needs no scan: it validates what the caller wrote.
                if (args.action === 'check') {
                    const criteria = args.acceptanceCriteria ?? []
                    const design = args.testDesign ?? ''
                    if (criteria.length === 0 || design.trim() === '') {
                        throw new Error('check 需要同时给出 acceptanceCriteria（`AC-001 …` 行数组）与 testDesign（`## 测试设计` Markdown）')
                    }
                    const check = checkDraft({ acceptanceCriteria: criteria, testDesign: design, minTextLength: config.bootstrap.minTextLength })
                    return [
                        check.ok
                            ? `✅ 草稿通过自查：验收标准 ${check.criteria.length} 条、用例 ${check.cases} 条，每个 AC 都有用例覆盖，步骤/预期长度达标。`
                            : `❌ 草稿还有 ${check.findings.length} 个问题（改完再 spec_create）：`,
                        '',
                        ...check.findings.map((finding) => `- [${finding.kind}] ${finding.detail}`),
                        ...(check.ok ? ['', '下一步：`spec_create`（把两段内容原样填入）→ `test_design_review` → `spec_approve`。'] : []),
                    ].join('\n')
                }

                const scan = scanWorkspace({ cwd, ...(deps.logger === undefined ? {} : { logger: deps.logger }) })
                const gaps = scanGaps({
                    scan,
                    ...(mission?.spec === undefined ? {} : { spec: mission.spec }),
                    ...(mission?.testDesign === undefined ? {} : { testDesign: mission.testDesign }),
                })
                const { brief } = buildIndex(scan, gaps, config.bootstrap.maxIndexEntries)
                const briefText = renderBrief(brief, cwd)

                if (args.action === 'brief') {
                    return briefText
                }

                // `draft`: hand the SAME task to a read-only child agent, so the
                // repository is read by a model with full tool agency instead of
                // being pre-digested into a summary here.
                const subagents = deps.subagents()
                if (subagents === undefined) {
                    throw new Error(
                        '宿主没有装配子代理服务（ctx.subagents）：无法派发只读草稿代理。\n' +
                            '下一步：改用 `spec_bootstrap({ action: "brief" })` 自己读代码写草稿，或在宿主里装配子代理 provider。',
                    )
                }
                const signal = (exec as { signal?: AbortSignal }).signal
                const prompt = [
                    `为下面这个已有代码、缺规格的仓库写一份**规格草稿**（验收标准 + 测试设计）。`,
                    `工作目录：${cwd}`,
                    '',
                    briefText,
                    ...(args.focus === undefined || args.focus.trim() === '' ? [] : ['', `额外关注：${args.focus.trim()}`]),
                    '',
                    '严格要求：**只读**——你可以读文件、搜索、列目录，但绝不能修改任何文件；',
                    '最终回答只包含 DRAFT 的两段 Markdown（验收标准表 + 测试设计三场景表），不要解释过程。',
                ].join('\n')
                let child
                try {
                    child = await subagents.start(config.bootstrap.provider, {
                        label: `规格草稿 · ${path.basename(cwd)}`,
                        prompt: [{ type: 'text', text: prompt }],
                        parent: agent as never,
                        signal: signal ?? new AbortController().signal,
                        toolFilter: { allow: [...config.bootstrap.readTools] },
                        // The host decides which model reads the repository: the
                        // bulk reading is exactly the work a cheap model can do.
                        ...(config.bootstrap.model === undefined
                            ? {}
                            : {
                                  agentOptions: {
                                      ...(config.bootstrap.model.includes('/')
                                          ? { provider: config.bootstrap.model.split('/', 1)[0] as string }
                                          : {}),
                                      model: config.bootstrap.model.includes('/')
                                          ? (config.bootstrap.model.split('/').slice(1).join('/') as string)
                                          : config.bootstrap.model,
                                      ...(config.bootstrap.reasoningEffort === undefined
                                          ? {}
                                          : { reasoningEffort: config.bootstrap.reasoningEffort }),
                                      ...(config.bootstrap.maxTokens === undefined
                                          ? {}
                                          : { maxTokens: config.bootstrap.maxTokens }),
                                  },
                              }),
                        persona: [
                            '你是规格草稿员：读代码、写可验证的验收标准与可执行的测试用例步骤。',
                            '你只有只读工具：绝不修改文件，也不要尝试。',
                            '证据不足就标注 [推断] 或 [待确认]，禁止发明行为。',
                        ].join('\n'),
                    })
                } catch (error) {
                    throw new Error(
                        `派发只读草稿代理失败（provider ${config.bootstrap.provider}）：${(error as Error).message}\n` +
                            '常见原因：白名单里写了当前部署不存在的全局工具名（scope-local 工具不能进 toolFilter）。\n' +
                            '下一步：用 `spec_bootstrap({ action: "brief" })` 自己写，或修正 bootstrap.readTools/provider。',
                    )
                }
                let answer = ''
                let stopReason = 'unknown'
                try {
                    const settled = (await withDeadline(child.result, config.bootstrap.timeoutMs, '草稿代理')) as {
                        stopReason?: unknown
                        output?: { type?: unknown; text?: unknown }[]
                        diagnostic?: unknown
                    }
                    stopReason = typeof settled.stopReason === 'string' ? settled.stopReason : 'unknown'
                    answer = (settled.output ?? [])
                        .filter((block) => block.type === 'text' && typeof block.text === 'string')
                        .map((block) => block.text as string)
                        .join('\n')
                    if (answer.trim() === '') {
                        const diagnostic = typeof settled.diagnostic === 'string' ? `（${settled.diagnostic}）` : ''
                        throw new Error(`只读草稿代理没有返回文本${diagnostic}`)
                    }
                } finally {
                    try {
                        await child.dispose?.()
                    } catch {
                        // disposal must never mask the draft result
                    }
                }

                const parsed = parseDraftAnswer(answer, { maxCases: args.maxCases ?? config.bootstrap.maxCases })
                if ('problem' in parsed) {
                    return [
                        `❌ 只读草稿代理的输出不可用：${parsed.problem}`,
                        '',
                        '（没有退化成脚手架：草稿必须由读代码得出，不能由插件猜。）',
                        '下一步：`spec_bootstrap({ action: "brief" })` 拿到契约后自己读代码写，或用 focus 参数再派一次。',
                        '',
                        '--- 代理原始输出（供排查）---',
                        answer.slice(0, 4_000),
                    ].join('\n')
                }

                const check = checkDraft({
                    acceptanceCriteria: parsed.criteria.map((criterion) => `${criterion.id} ${criterion.text}`),
                    testDesign: parsed.designMarkdown,
                    minTextLength: config.bootstrap.minTextLength,
                })

                const draft: SpecDraft = {
                    title: `补齐规格：${path.basename(cwd)}`,
                    background: [
                        '由只读草稿代理读代码后生成（spec_bootstrap）。',
                        `需求文档 ${scan.requirements.length} 份；代码符号索引 ${scan.symbols.length} 个；已有测试文件 ${scan.tests.length} 个。`,
                        ...(scan.requirements.length === 0 ? ['仓库里没有需求文档：条目由代码推断，请人工确认带 [推断] 的部分。'] : []),
                    ].join('\n'),
                    requirements: [],
                    acceptanceCriteria: parsed.criteria.map((criterion) => `${criterion.id} ${criterion.text}`),
                    fileBoundaries: [],
                    negativeConstraints: [],
                    testDesignMarkdown: parsed.designMarkdown,
                }

                const stamp = new Date().toISOString().replace(/[:.]/g, '-')
                const dir = path.join(store.layout.rootDir, 'bootstrap', stamp)
                const markdown = renderDraft(draft, {
                    source: `只读草稿代理（${config.bootstrap.provider}，stopReason=${stopReason}）`,
                    findings: check.findings.map((finding) => `[${finding.kind}] ${finding.detail}`),
                })
                let written: string | undefined
                try {
                    ensureDir(dir)
                    writeTextAtomic(path.join(dir, 'spec-draft.md'), markdown)
                    writeJsonAtomic(path.join(dir, 'spec-draft.json'), { source: 'subagent', stopReason, draft, findings: check.findings })
                    written = path.join(dir, 'spec-draft.md')
                    deps.logger?.for(cwd).info(`spec_bootstrap: 草稿已写入 ${written}（子代理 ${stopReason}）`)
                } catch (error) {
                    check.findings.push({ kind: 'shape', detail: `草稿落盘失败（${(error as Error).message}）：内容仍在下面的输出里` })
                }

                return [
                    `## 规格草稿（只读子代理读代码生成 · ${config.bootstrap.provider} · ${stopReason}）`,
                    ...(written === undefined ? [] : [`落盘：${written}（同目录还有 spec-draft.json）`]),
                    '',
                    ...(check.ok
                        ? ['✅ 自查通过：每个 AC 都有用例覆盖，步骤/预期长度达标。']
                        : [`⚠️ 自查还有 ${check.findings.length} 个问题：`, '', ...check.findings.map((finding) => `- [${finding.kind}] ${finding.detail}`)]),
                    '',
                    '⚠️ 这是草稿、没有任何审批效力。下一步：按上面问题修正 → `spec_create` → `test_design_review` → `spec_approve`。',
                    '',
                    '### 验收标准',
                    '',
                    '| 编号 | 验收标准 |',
                    '|------|----------|',
                    ...parsed.criteria.map((criterion) => `| ${criterion.id} | ${criterion.text} |`),
                    '',
                    '### 测试设计',
                    '',
                    parsed.designMarkdown,
                ].join('\n')
            },
        }),
        'spec_bootstrap',
    )

    register(
        defineTool({
            name: 'plan_status',
            description:
                'READ-ONLY repository-wide plan view, for the 规划 phase: every requirement the plan ledger has ever recorded, grouped by milestone (with an explicit 无里程碑 group), each with its owner mission, spec status (draft/approved) and delivery state (a delivery receipt exists). It also lists 未交付 and 已作废 (retired ids are never reused) and answers "which mission owns this requirement id" — an id in two missions is reported as a CONFLICT, never merged. Use it BEFORE spec_create to see what already exists in this repository; the specification stays the authority (the ledger is an index that can be rebuilt from specs).',
            parameters: {
                milestone: { type: 'string', description: `Only this milestone; pass "${NO_MILESTONE_LABEL}" for the group without one.` },
                missionId: { type: 'string', description: 'Only requirements this mission mentioned (including conflicting ones).' },
                json: { type: 'boolean', description: 'Return the report as JSON instead of Markdown (for tooling).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: PlanStatusArgs = {} as PlanStatusArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                const config = effectiveFor(deps, agent)
                const report = buildPlanReport({
                    store,
                    file: planLedgerFile(store.layout, config),
                    ...(args.milestone === undefined || args.milestone === '' ? {} : { milestone: args.milestone }),
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { missionId: args.missionId }),
                })
                if (args.json === true) return JSON.stringify(report, undefined, 2)
                return renderPlanReport(report)
            },
        }),
        'plan_status',
    )

    register(
        defineTool({
            name: 'adr_record',
            description:
                'Record an architecture decision (ADR) as a durable artifact: `.dsh/adr/<NNNN>-<slug>.md` plus one index row. Use it when the ALTERNATIVES matter — "we chose X over Y because Z" — not as a diary: a decision that no future reader would question does not need a record. The file is append-only (the next number is max+1, an existing path is refused, never overwritten); `supersedes` names an existing ADR number and appends a `supersededBy` row instead of rewriting the old file. Recording changes no gate verdict: the specification stays the authority. Read them back with adr_list.',
            parameters: {
                title: { type: 'string', required: true, description: 'One-line title of the decision (CJK is fine; the filename falls back to a short hash).' },
                decision: { type: 'string', required: true, description: 'What was decided, in a sentence or two.' },
                alternatives: {
                    type: 'string',
                    description: 'Which alternatives were on the table and why they were not chosen (the part that is lost first).',
                },
                consequences: { type: 'string', description: 'What this decision costs, what it makes harder, what must be revisited when.' },
                missionId: { type: 'string', description: 'Mission this decision belongs to (links the ADR to the spec and evidence).' },
                supersedes: { type: 'integer', description: 'Number of the ADR this one replaces; must be an existing ADR (adr_list shows numbers).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: AdrRecordArgs = {} as AdrRecordArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                const config = effectiveFor(deps, agent)
                const outcome = recordAdr(
                    { layout: store.layout, config },
                    {
                        title: args.title ?? '',
                        decision: args.decision ?? '',
                        ...(args.alternatives === undefined ? {} : { alternatives: args.alternatives }),
                        ...(args.consequences === undefined ? {} : { consequences: args.consequences }),
                        ...(args.missionId === undefined ? {} : { missionId: args.missionId }),
                        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
                    },
                )
                if (!outcome.ok) {
                    return [
                        `## 未记录（${(args.title ?? '').trim() || 'adr_record'}）`,
                        '',
                        outcome.problem,
                        ...(outcome.nextSteps === undefined ? [] : ['', '### 下一步', '', outcome.nextSteps]),
                    ].join('\n')
                }
                return [
                    `## 已记录 ADR ${String(outcome.number).padStart(4, '0')}`,
                    '',
                    `文件：${outcome.relativePath}（编号只增不改：下一条是 ${String(outcome.number + 1).padStart(4, '0')}）`,
                    `标题：${outcome.title}`,
                    ...(outcome.superseded === undefined ? [] : [`取代：${String(outcome.superseded).padStart(4, '0')}（它的文件不改写，index.jsonl 追加了一行 supersededBy）`]),
                    `索引：${path.relative(store.layout.cwd, adrIndexPath(store.layout, config)) || adrIndexPath(store.layout, config)}`,
                    ...outcome.warnings.flatMap((warning) => ['', warning]),
                    '',
                    'ADR 是记录、不是门禁：它不改变任何放行判定（规格才是权威）。',
                    `下一步：\`adr_list\` 查看；要改这条决定时用 \`adr_record({ supersedes: ${outcome.number} })\` 记一条新的，不要改旧文件。`,
                ].join('\n')
            },
        }),
        'adr_record',
    )

    register(
        defineTool({
            name: 'adr_list',
            description:
                'READ-ONLY list of the recorded architecture decisions, newest first, optionally filtered by a case-insensitive query (matched against the title and the 决定 text) or by mission. Shows which records have been superseded. Use it before re-deciding something that was already decided, and to find out why the current shape is what it is.',
            parameters: {
                query: { type: 'string', description: 'Case-insensitive substring matched against the title and the decision text.' },
                missionId: { type: 'string', description: 'Only decisions recorded for this mission.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: AdrListArgs = {} as AdrListArgs, exec) {
                const { store, agent } = storeFor(deps, exec)
                const config = effectiveFor(deps, agent)
                return renderAdrList(
                    listAdr(store.layout, config, {
                        ...(args.query === undefined ? {} : { query: args.query }),
                        ...(args.missionId === undefined ? {} : { missionId: args.missionId }),
                    }),
                    store.layout,
                )
            },
        }),
        'adr_list',
    )

    return { disposers, registered, failed, ...(registrationError === undefined ? {} : { lastError: registrationError }) }
}

/**
 * Ask the approval seam for a grant.
 * @returns the approver label recorded on the specification.
 * @throws when the approval is rejected, unavailable, or cancelled (fail closed).
 */
/**
 * What happens when the human rejects the specification.
 *
 * The review is a loop, so a rejection is a first-class outcome, not an error
 * to swallow: the round is recorded (visible in `spec_status`), the human is
 * asked what to change when the host has a question channel, and the model gets
 * a result that names the exact next steps. Nothing here can approve anything —
 * the mission simply stays unapproved until a later round passes.
 */
async function handleRejection(
    deps: ToolDeps,
    exec: unknown,
    mission: MissionRecord,
    outcome: string,
    note?: string,
): Promise<string> {
    const store = deps.stores.for(mission.cwd)
    const round = store.nextApprovalRound(mission.id)
    const context = exec as { agent?: AgentLike; signal?: AbortSignal }
    // The note may already exist (typed into the review card's input box); only
    // ask again when the rejection arrived without one.
    const reason = note ?? (await askWhatToChange(deps, context, mission))
    const recorded = store.recordApproval(mission.id, {
        state: 'rejected',
        round,
        at: Date.now(),
        by: outcome === 'cancelled' ? 'cancelled' : 'approval',
        ...(reason ?? note) === undefined ? {} : { note: (reason ?? note) as string },
    })
    const problems = deps.configFor(mission.cwd).problems ?? []
    void problems
    return [
        outcome === 'cancelled'
            ? `⏸️ 第 ${round} 次送审被取消（没有人给出决定）：mission ${mission.id} 仍未审批，写操作保持关闭。`
            : `🛑 第 ${round} 次送审被人工打回：mission ${mission.id} 回到未审批状态（旧审批已作废）。`,
        ...(reason === undefined ? [] : ['', `人工意见：${reason}`]),
        '',
        '下一步（必须走完才能再写代码）：',
        '1. 按人工意见修改规格——重新调用 `spec_create`（带上修订后的验收标准/边界/负面约束/测试设计），旧审批与旧测试设计评审都会失效；',
        '2. 调用 `test_design_review` 让测试设计重新通过；',
        '3. 再调用 `spec_approve` 送审（第 ' + String(round + 1) + ' 次）。',
        '如果人工意见不清楚，先用一问一答的方式问清楚要点，不要猜测后直接重写。',
        ...(recorded === undefined ? [`（注意：mission ${mission.id} 的记录未找到）`] : []),
    ].join('\n')
}

/**
 * Ask the human what made them reject, through the host's question channel.
 * @returns their note, or `undefined` when there is no channel / they skipped.
 */
async function askWhatToChange(
    deps: ToolDeps,
    context: { agent?: AgentLike; signal?: AbortSignal },
    mission: MissionRecord,
): Promise<string | undefined> {
    const questions = deps.questions()
    if (questions === undefined || context.agent === undefined) return undefined
    try {
        const answer = await questions.ask({
            agent: context.agent,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            questions: [
                {
                    id: `spec-reject-${mission.id}`,
                    header: '打回重写',
                    question: `第 ${mission.id} 号规格要改什么？（可多选；也可直接在对话里说明）`,
                    detail: '选完/输入后，模型会据此重写规格并重新送审。',
                    multiSelect: true,
                    options: [
                        { label: '验收标准不全或不准确', description: '补充/修正「验收标准」条目' },
                        { label: '测试用例不合格', description: '覆盖、步骤或预期结果需要重写' },
                        { label: '文件边界/负面约束不对', description: '允许改动的范围需要调整' },
                        { label: '方案本身要换', description: '实现思路或范围需要重新设计' },
                        { label: '暂时不批，先别改', description: '保持草稿，等进一步指示' },
                    ],
                },
            ],
        })
        const item = answer.answers.find((entry) => entry.id === `spec-reject-${mission.id}`)
        if (item === undefined) return undefined
        const parts = [...item.selected]
        if (item.custom !== undefined && item.custom.trim() !== '') parts.push(item.custom.trim())
        return parts.length === 0 ? undefined : parts.join('；')
    } catch {
        // A question channel that fails must never turn a rejection into an
        // approval: fall through with no note.
        return undefined
    }
}

/** The workspace-relative spelling of a path (for prompts). */
function relativePathOf(mission: MissionRecord, candidate: string): string {
    return path.isAbsolute(candidate) ? path.relative(mission.cwd, candidate) || candidate : candidate
}

/** Absolute paths of everything a reviewer may want to open. */
function reviewArtifactsOf(mission: MissionRecord, missionsDir: string): ReviewArtifacts {
    const specAbs = path.isAbsolute(mission.specPath ?? '')
        ? (mission.specPath as string)
        : path.join(mission.cwd, mission.specPath ?? path.join('.dsh', 'specs', `${mission.id}.md`))
    return {
        specFile: specAbs,
        designFile: path.join(missionsDir, mission.id, 'test-design-review.md'),
        specsDir: path.dirname(specAbs),
        missionDir: path.join(missionsDir, mission.id),
    }
}

/**
 * The text the human reads in the approval prompt.
 *
 * Two directories and two files, so a reviewer can open them (a UI may render
 * the `需求文档:` / `测试用例:` lines as openable paths), the numbers that
 * matter, and what rejection means — the review is a loop, not a one-shot.
 */
export function renderApprovalPrompt(mission: MissionRecord, round: number, missionsDir: string, note?: string): string {
    const spec = mission.spec
    const criteria = spec?.acceptanceCriteria ?? []
    const cases = mission.testDesign?.cases ?? []
    const uncovered = mission.testDesign?.uncovered ?? []
    const budgets = readSpecBudgets(spec)
    const relativeMissions = path.relative(mission.cwd, missionsDir) || missionsDir
    const specFile = relativePathOf(mission, mission.specPath ?? `.dsh/specs/${mission.id}.md`)
    const designFile = `${relativeMissions}/${mission.id}/test-design-review.md`
    const lines = [
        note === undefined ? `规格审批（第 ${round} 次送审）：${mission.title}` : `${note}（第 ${round} 次送审）`,
        `mission ${mission.id} · rev ${spec?.revision ?? '?'} · 摘要 ${(mission.specDigest ?? '').slice(0, 12) || '?'}`,
        '',
        '需求文档目录: .dsh/specs/',
        `需求文档: ${specFile}（验收标准 ${criteria.length} 条）`,
        ...criteria.slice(0, 6).map((criterion) => `  · ${criterion.id} ${criterion.text}`),
        ...(criteria.length > 6 ? [`  · …另有 ${criteria.length - 6} 条`] : []),
        '',
        // 非功能要求也在被审批的文档里：审的人必须看见它们，否则"预算"又变成了事后补的口径。
        `非功能预算: ${budgets.budgets.length} 条${budgets.retired.length === 0 ? '' : `（已作废编号：${budgets.retired.join('、')}，不会复用）`}`,
        ...budgets.budgets.slice(0, 6).map((budget) => {
            const unit = budget.unit ?? defaultBudgetUnit(budget.metric)
            return `  · ${budget.id} ${budget.name}：${budget.metric} ${describeThreshold(budget.threshold, unit)}（命令 \`${budget.command}\`，关联 ${(budget.requirementIds ?? []).join('、') || '(未关联)'}）`
        }),
        ...(budgets.budgets.length > 6 ? [`  · …另有 ${budgets.budgets.length - 6} 条`] : []),
        '',
        `测试用例目录: ${relativeMissions}/${mission.id}/`,
        `测试用例: ${designFile}（用例 ${cases.length} 条${uncovered.length === 0 ? '，覆盖全部验收标准' : `，未覆盖 ${uncovered.join('、')}`}）`,
        ...cases.slice(0, 6).map((entry) => `  · ${entry.id} → ${entry.covers.join('、') || '(未标注)'}：${entry.expected.slice(0, 40)}`),
        ...(cases.length > 6 ? [`  · …另有 ${cases.length - 6} 条`] : []),
        '',
        '通过：写操作放行。',
        '不合格：拒绝并在对话里说明要改什么——规格会回到草稿，模型据此重写后再次送审（可反复多轮）。',
    ]
    return lines.join('\n')
}

async function requestApproval(
    deps: ToolDeps,
    exec: unknown,
    mission: MissionRecord,
    note: string | undefined,
    config: SpecGateConfig,
): Promise<ApprovalOutcome | { outcome: string; note?: string; normalized?: ApprovalOutcome }> {
    if (config.approval === 'auto') {
        return { decision: 'allowed-once', by: 'auto', messageId: '', source: 'auto', allowed: true }
    }
    const context = exec as { agent?: AgentLike; signal?: AbortSignal }
    const missionsDir = deps.stores.for(mission.cwd).layout.missionsDir
    const roundForReview = deps.stores.for(mission.cwd).nextApprovalRound(mission.id)

    // Preferred channel: the host TUI's own card UI (nvim-tui's public ext API),
    // which can OPEN the artifacts and take the rejection note in its input box.
    const tui = deps.nvimTui()
    if (config.reviewChannel !== 'approval' && tui !== undefined) {
        const outcome = await tuiReview({
            api: tui,
            ...(sessionIdOf(context.agent) === undefined ? {} : { sessionId: sessionIdOf(context.agent) as string }),
            title: `规格审批（第 ${roundForReview} 次送审）：${mission.title}`,
            body: renderApprovalPrompt(mission, roundForReview, missionsDir, note),
            artifacts: reviewArtifactsOf(mission, missionsDir),
            cwd: mission.cwd,
            log: (message: string) => deps.logger.for(mission.cwd).info(`[review] ${message}`),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            timeoutMs: config.reviewTimeoutMs,
        })
        if (outcome.decision === 'approved') {
            // The TUI review card is a channel too: record it as the surface.
            return { decision: 'allowed-once', by: 'approval', messageId: '', source: 'tui', allowed: true }
        }
        if (outcome.decision === 'rejected') return { outcome: 'rejected', ...(outcome.note === undefined ? {} : { note: outcome.note }) }
        if (outcome.decision === 'cancelled') return { outcome: 'cancelled' }
        // `unavailable`: fall through to the generic seam below.
    }
    if (config.reviewChannel === 'tui') {
        throw new Error(
            '规格审批未进行：reviewChannel=tui，但宿主没有可用的 nvim-tui 扩展 API（ctx.get("nvim-tui")）。' +
                '请把 reviewChannel 改回 auto/approval，或在 TUI 里运行。（mission ' + mission.id + '）',
        )
    }
    const approval = deps.approval()
    if (approval === undefined) {
        throw new Error(
            '规格审批未通过：宿主没有装配审批通道（ctx.approval），而 spec-gate 的 approval 模式是 "seam"。' +
                `请让人类审批后把 approval 改为 auto，或装配审批插件。（mission ${mission.id}）`,
        )
    }
    const store = deps.stores.for(mission.cwd)
    const round = store.nextApprovalRound(mission.id)
    const outcome = await approval.request({
        ...(context.agent === undefined ? {} : { agent: context.agent }),
        toolName: 'spec_approve',
        // Multi-line on purpose: the human must be able to READ the two
        // artifacts (and open them) before deciding, not approve blind. The
        // fenced context block lets a channel render fields (mission, revision,
        // artifacts) instead of parsing this prose.
        reason: renderApprovalContext(renderApprovalPrompt(mission, round, store.layout.missionsDir, note), {
            kind: 'spec',
            missionId: mission.id,
            title: mission.spec?.title ?? mission.title,
            revision: mission.spec?.revision ?? 0,
            artifacts: approvalArtifacts(mission, store.layout.missionsDir),
            facts: {
                验收标准: mission.spec?.acceptanceCriteria.length ?? 0,
                测试用例: mission.testDesign?.cases.length ?? 0,
                未覆盖: mission.testDesign?.uncovered?.length ?? 0,
                非功能预算: readSpecBudgets(mission.spec).budgets.length,
                送审轮次: round,
            },
            channelHints: { buttons: ['通过', '打回'], requiresReason: true },
        }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    const normalized = normalizeApprovalReply(outcome)
    if (normalized.allowed) return normalized
    return { outcome: normalized.decision, normalized } as never
}

/** The artifacts a reviewer should be able to open before deciding. */
function approvalArtifacts(mission: MissionRecord, missionsDir: string): string[] {
    return [
        ...(mission.specPath === undefined ? [] : [mission.specPath]),
        path.relative(mission.cwd, path.join(missionsDir, mission.id, 'test-design-review.md')),
    ]
}

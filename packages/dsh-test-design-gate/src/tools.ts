/**
 * The model-facing tool surface: `test_design_review` and `test_design_template`.
 *
 * The artifact on disk is the source of truth: the review re-reads
 * `.dsh/specs/<mission-id>.md`, parses it, persists the verdict on the mission
 * record (which `dsh-spec-gate` reads before approving) and writes the two
 * review artifacts. A failing review is data, never an exception — the gate
 * refuses at approval time.
 *
 * @module dsh-test-design-gate/tools
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    SPEC_FORMAT_HINT,
    cell,
    formatTime,
    sha256,
    specReviewDigest,
    type AgentLike,
    type MissionRecord,
    type MissionStoreRegistry,
    type TestCase,
    type TestDesign,
} from 'dsh-eng-core'
import type { EffectiveTestDesignGateConfig, TestDesignGateConfig } from './config.js'
import { reviewTestDesign, SCENARIOS } from './review.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Machine-readable review artifact (relative to the mission directory). */
export const REVIEW_JSON = 'test-design-review.json'
/** Human-readable review artifact (relative to the mission directory). */
export const REVIEW_MD = 'test-design-review.md'

/**
 * Refusal shown when the calling session declares no workspace.
 *
 * `session.header.cwd` is the only durable answer to "which repository is this
 * review about". Falling back to `process.cwd()` would silently review — and
 * write the review artifacts into — the harness's own directory, i.e. the wrong
 * project; `dsh-audit-trail` refuses the same way.
 */
export const NO_WORKSPACE_MESSAGE =
    '无法确定本会话的工作区（session.header.cwd 缺失），为避免把评审写到错误的项目，本工具拒绝执行。下一步：在带 cwd 的会话里工作。'

/** Everything the tools close over. */
export interface ToolDeps {
    /** The profile configuration (the ceiling for every workspace). */
    config: TestDesignGateConfig
    /** The configuration of one workspace (profile + its own `.dsh/test-design-gate.json`). */
    configFor: (cwd: string) => EffectiveTestDesignGateConfig
    stores: MissionStoreRegistry
    /** Plugin name, recorded as the author of the review evidence. */
    source: string
}

interface ReviewArgs {
    missionId?: string
    strict?: boolean
}

/** The machine-readable report shape (`test-design-review.json`). */
interface ReviewReport {
    missionId: string
    passed: boolean
    reviewedAt: number
    cases: { id: string; kind: TestCase['kind']; covers: string[] }[]
    covered: string[]
    uncovered: string[]
    findings: string[]
    specDigest: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/**
 * The workspace the calling session declared, or a refusal.
 *
 * No `process.cwd()` fallback: with no declared workspace the review would read
 * and write mission artifacts under the harness's own directory — the wrong
 * project — so the tool fails closed with the concrete next step instead.
 */
function requireCwd(exec: unknown): { agent: AgentLike | undefined; cwd: string } {
    const agent = agentOf(exec)
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') throw new Error(NO_WORKSPACE_MESSAGE)
    return { agent, cwd }
}

/**
 * The effective configuration of one workspace.
 *
 * Never throws: a broken project file degrades to the profile configuration
 * (never to "no review"), so the tool can always answer.
 */
function effectiveFor(deps: ToolDeps, cwd: string): EffectiveTestDesignGateConfig {
    try {
        return deps.configFor(cwd)
    } catch {
        return { config: deps.config, source: 'profile', problems: [] }
    }
}

/** Resolve the calling session's store plus the review policy in force there. */
function storeFor(deps: ToolDeps, exec: unknown) {
    const { agent, cwd } = requireCwd(exec)
    return { store: deps.stores.for(cwd), agent, cwd, effective: effectiveFor(deps, cwd) }
}

/** The one line that says which policy the review actually applied, and why. */
function describePolicy(effective: EffectiveTestDesignGateConfig): string {
    const config = effective.config
    const source = effective.source === 'project' ? `项目级 ${effective.file ?? '(未知路径)'}` : 'profile'
    const notes = effective.problems.length === 0 ? '' : `；项目级配置问题 ${effective.problems.length} 条（涉及的值一律回退到 profile，详见插件日志）`
    return `${source}（minTextLength=${config.minTextLength}；strict=${config.strict}；allowDanglingCase=${config.allowDanglingCase}；requireAllScenarios=${config.requireAllScenarios}）${notes}`
}

function countByKind(cases: readonly { kind: TestCase['kind'] }[]): string {
    return SCENARIOS.map((scenario) => `${scenario.label} ${cases.filter((testCase) => testCase.kind === scenario.kind).length}`).join(' / ')
}

/** Resolve a mission or throw with the concrete next step (fail closed). */
function requireMission(
    deps: ToolDeps,
    exec: unknown,
    explicitId?: string,
): { store: ReturnType<MissionStoreRegistry['for']>; mission: MissionRecord; effective: EffectiveTestDesignGateConfig } {
    const { store, effective } = storeFor(deps, exec)
    const mission = store.resolveForAgent(agentOf(exec), {
        ...(explicitId === undefined ? {} : { explicitId }),
        fallbackLatest: true,
    })
    if (mission === undefined) {
        throw new Error(
            '这个工作区还没有 mission，无法评审测试设计：请先调用 spec_create 建立规格（包含 `## 验收标准` 与 `## 测试设计` 章节），再运行 test_design_review。',
        )
    }
    return { store, mission, effective }
}

function renderReviewMarkdown(input: {
    mission: MissionRecord
    report: ReviewReport
    specPath: string
    strict: boolean
    effective: EffectiveTestDesignGateConfig
}): string {
    const { mission, report, specPath, strict, effective } = input
    const lines: string[] = [
        '# 测试设计评审报告',
        '',
        `- Mission: \`${mission.id}\``,
        `- 标题: ${mission.title}`,
        `- 结论: ${report.passed ? '✅ 通过' : '❌ 未通过'}`,
        `- 评审时间: ${formatTime(report.reviewedAt)}`,
        `- 规格工件: \`${specPath}\``,
        `- 规格摘要: \`${report.specDigest}\``,
        `- 生效评审策略: ${describePolicy(effective)}`,
        `- 严格模式: ${strict ? '是（每条验收标准需有异常或边界用例）' : '否'}`,
        `- 用例数: ${report.cases.length}（${countByKind(report.cases)}）`,
        `- 已覆盖验收标准: ${report.covered.join(', ') || '（无）'}`,
        `- 未覆盖验收标准: ${report.uncovered.join(', ') || '（无）'}`,
        '',
        '## 用例清单',
        '',
        '| 用例ID | 场景 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
        '|--------|------|----------|----------|--------------|',
    ]
    for (const testCase of report.cases) {
        const full = (mission.testDesign?.cases ?? []).find((entry) => entry.id === testCase.id)
        lines.push(
            `| ${cell(testCase.id)} | ${cell(kindLabel(testCase.kind))} | ${cell(full?.steps ?? '')} | ${cell(full?.expected ?? '')} | ${cell(testCase.covers.join(', ') || '—')} |`,
        )
    }
    if (report.cases.length === 0) lines.push('| （无） | — | — | — | — |')
    lines.push('', '## 评审意见', '')
    if (report.findings.length === 0) {
        lines.push('无：每条验收标准都有可执行用例覆盖，正向 / 异常 / 边界三类场景齐全。')
    } else {
        for (const [index, finding] of report.findings.entries()) lines.push(`${index + 1}. ${finding}`)
    }
    lines.push(
        '',
        '## 结论',
        '',
        report.passed
            ? '✅ 测试设计评审通过：该设计已作为证据与规格绑定，可以进入 `spec_approve`。'
            : `❌ 测试设计评审未通过（共 ${report.findings.length} 条问题）：按上面的意见修改规格后重新运行 \`test_design_review\`，通过之前 \`spec_approve\` 会被拒绝。`,
        '',
    )
    return lines.join('\n')
}

function kindLabel(kind: TestCase['kind']): string {
    return SCENARIOS.find((scenario) => scenario.kind === kind)?.label ?? kind
}

/** The `test_design_template` payload: the canonical shape plus one filled row per class. */
export const TEMPLATE_TEXT = [
    SPEC_FORMAT_HINT,
    '',
    '填好的示例（照抄表头，逐列替换内容）：',
    '',
    '### 正向场景',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动且端口空闲 | 请求 GET /health | 返回 200，body 为 {"status":"ok"} | AC-001 |',
    '',
    '### 异常场景',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口 8080 已被占用 | 启动服务 | 退出码非 0，stderr 含 EADDRINUSE，且无残留子进程 | AC-002 |',
    '',
    '### 边界场景',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 请求体长度恰好等于上限 | 发送最大长度的请求 | 返回 200 且 body 完整回显，无截断 | AC-003 |',
    '',
    '注意：用例ID必须唯一（TC-001…），「覆盖验收标准」列必须写规格里真实存在的 AC 编号；不要写 `...` / `TBD` / `待补充`。',
].join('\n')

/** Register every test-design-gate tool. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []

    const register = (definition: unknown, toolName: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(toolName)
        } catch (error) {
            failed.push(toolName)
            void error
        }
    }

    register(
        defineTool({
            name: 'test_design_review',
            description:
                "Review the current mission's test design as it exists in the specification artifact (.dsh/specs/<mission-id>.md): acceptance-criteria coverage, positive/negative/boundary scenario completeness, executability of every case, and dangling cases. Persists the verdict on the mission and writes test-design-review.json/.md; spec_approve refuses while the review has not passed.",
            parameters: {
                missionId: { type: 'string', description: 'Mission to review (default: the session mission).' },
                strict: {
                    type: 'boolean',
                    description: 'Also require at least one negative or boundary case per acceptance criterion.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ReviewArgs = {} as ReviewArgs, exec) {
                const { store, mission, effective } = requireMission(deps, exec, args.missionId)
                // The policy of THIS workspace: one dsh process serves several
                // repositories, each with its own .dsh/test-design-gate.json.
                const config = effective.config
                const markdown = store.readSpec(mission.id)
                const strict = args.strict === true || config.strict
                const outcome = reviewTestDesign(markdown, {
                    minTextLength: config.minTextLength,
                    strict,
                    allowDanglingCase: config.allowDanglingCase,
                    requireAllScenarios: config.requireAllScenarios,
                })

                const reviewedAt = Date.now()
                const report: ReviewReport = {
                    missionId: mission.id,
                    passed: outcome.passed,
                    reviewedAt,
                    cases: outcome.design.cases.map((testCase) => ({ id: testCase.id, kind: testCase.kind, covers: testCase.covers })),
                    covered: outcome.design.covered,
                    uncovered: outcome.design.uncovered,
                    findings: outcome.findings,
                    specDigest: sha256(markdown),
                }
                const design: TestDesign = {
                    ...outcome.design,
                    passed: report.passed,
                    findings: report.findings,
                    reviewedAt,
                    // Bind the verdict to the criteria/cases it actually saw:
                    // a later specification revision changes this digest and
                    // therefore invalidates `passed` (see dsh-spec-gate).
                    specDigest: specReviewDigest({ acceptanceCriteria: outcome.criteria }, outcome.design),
                }
                store.setTestDesign(mission.id, design)

                const reportJson = `${JSON.stringify(report, undefined, 2)}\n`
                const jsonFile = store.writeArtifact(mission.id, REVIEW_JSON, reportJson)
                const relative = (file: string): string => path.relative(store.layout.cwd, file)
                const mdFile = store.writeArtifact(
                    mission.id,
                    REVIEW_MD,
                    renderReviewMarkdown({
                        mission: { ...mission, testDesign: design },
                        report,
                        specPath: relative(store.specPath(mission.id)),
                        strict,
                        effective,
                    }),
                )

                if (report.passed) {
                    store.appendEvidence(mission.id, {
                        kind: 'artifact',
                        summary: `测试设计评审通过：${design.cases.length} 条用例覆盖 ${design.covered.length} 条验收标准`,
                        recordedBy: deps.source,
                        artifactPath: REVIEW_JSON,
                        outputDigest: sha256(reportJson),
                        data: {
                            passed: true,
                            strict,
                            cases: design.cases.length,
                            covered: design.covered,
                            uncovered: design.uncovered,
                            specDigest: report.specDigest,
                            reviewedAt,
                        },
                    })
                }

                const head = report.passed
                    ? `✅ 测试设计评审通过（mission ${mission.id}）`
                    : `❌ 测试设计评审未通过（mission ${mission.id}，${report.findings.length} 条问题）`
                const lines: string[] = [head, `配置：${describePolicy(effective)}`]
                if (report.passed) {
                    lines.push(
                        `用例：${design.cases.length} 条（${countByKind(design.cases)}）；覆盖验收标准 ${report.covered.join(', ') || '（无）'}（共 ${report.covered.length + report.uncovered.length} 条，未覆盖 0 条）。`,
                        `工件：${relative(jsonFile)} / ${relative(mdFile)}`,
                        `证据：已登记 artifact 证据并与规格摘要 ${report.specDigest.slice(0, 16)} 绑定。`,
                        '',
                        '下一步：调用 spec_approve 取得人工审批——测试设计已通过，审批不会再被测试设计门禁拒绝。',
                    )
                } else {
                    for (const [index, finding] of report.findings.entries()) lines.push(`${index + 1}. ${finding}`)
                    lines.push(
                        '',
                        `工件：${relative(jsonFile)} / ${relative(mdFile)}（可直接查看）`,
                        '下一步：按上面的意见修改规格——用 spec_create 重新提交规格与测试设计' +
                            `（或直接改 \`.dsh/specs/${mission.id}.md\`），然后重新运行 test_design_review；未通过之前 spec_approve 会被拒绝。`,
                    )
                }
                return lines.join('\n')
            },
        }),
        'test_design_review',
    )

    register(
        defineTool({
            name: 'test_design_template',
            description:
                'Return the canonical `## 测试设计` table shape (one filled example row for each of the positive/negative/boundary scenario classes) to copy into the specification.',
            parameters: {},
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute() {
                return TEMPLATE_TEXT
            },
        }),
        'test_design_template',
    )

    return { disposers, registered, failed }
}

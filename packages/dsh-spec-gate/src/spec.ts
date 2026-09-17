/**
 * Specification drafting: validation, id allocation and the markdown artifact.
 * @module dsh-spec-gate/spec
 */

import {
    designRowCounts,
    parseTestDesign,
    renderSpecMarkdown,
    type AcceptanceCriterion,
    type MissionRecord,
    type SpecRecord,
    type TestCase,
    type TestDesign,
} from 'dsh-eng-core'

/** What the model supplies when creating a specification. */
export interface SpecDraft {
    title: string
    background: string
    requirements: string[]
    acceptanceCriteria: string[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    /** The `## 测试设计` chapter body, written as Markdown tables. */
    testDesignMarkdown: string
}

/** One validation finding. */
export interface SpecIssue {
    field: string
    message: string
}

const PLACEHOLDERS = /^(\.\.\.|…|tbd|todo|待定|待补充|-+)$/i

function isPlaceholder(value: string): boolean {
    return value.trim() === '' || PLACEHOLDERS.test(value.trim())
}

/**
 * Validate a draft against the spec contract (docs.md §1.2: a specification
 * must be structured and acceptable, so an empty or placeholder-only field is
 * a hard error rather than a warning).
 * @param draft - the model-supplied draft.
 * @returns every issue found; an empty array means the draft is acceptable.
 */
export function validateDraft(draft: SpecDraft): SpecIssue[] {
    const issues: SpecIssue[] = []
    if (isPlaceholder(draft.title)) issues.push({ field: 'title', message: 'title must state the mission in one line' })
    if (draft.acceptanceCriteria.length === 0) {
        issues.push({ field: 'acceptanceCriteria', message: 'at least one acceptance criterion is required' })
    }
    for (const [index, criterion] of draft.acceptanceCriteria.entries()) {
        if (isPlaceholder(criterion)) {
            issues.push({ field: `acceptanceCriteria[${index}]`, message: 'acceptance criteria must be verifiable statements' })
        }
    }
    if (draft.requirements.length === 0) {
        issues.push({ field: 'requirements', message: 'at least one requirement is required' })
    }
    if (draft.fileBoundaries.length === 0) {
        issues.push({ field: 'fileBoundaries', message: 'declare the files/directories this mission may touch' })
    }
    if (draft.negativeConstraints.length === 0) {
        issues.push({
            field: 'negativeConstraints',
            message: 'declare what must NOT be done (e.g. 不得修改 dsh 核心代码)',
        })
    }
    return issues
}

/** Assign `AC-00n` ids in declaration order. */
export function allocateCriteria(texts: readonly string[]): AcceptanceCriterion[] {
    return texts.map((text, index) => ({ id: `AC-${String(index + 1).padStart(3, '0')}`, text: text.trim() }))
}

/**
 * Build (or revise) the structured specification record.
 * @param draft - the validated draft.
 * @param previous - the existing record, when this is a revision.
 */
export function buildSpec(draft: SpecDraft, previous?: SpecRecord): SpecRecord {
    const now = Date.now()
    return {
        title: draft.title.trim(),
        background: draft.background.trim(),
        requirements: draft.requirements.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        acceptanceCriteria: allocateCriteria(draft.acceptanceCriteria),
        fileBoundaries: draft.fileBoundaries.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        negativeConstraints: draft.negativeConstraints.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        // A revision invalidates a previous approval: the human approved a
        // different document.
    }
}

const SCENARIO_LABEL: Record<TestCase['kind'], string> = {
    positive: '正向场景',
    negative: '异常场景',
    boundary: '边界场景',
}

/**
 * Parse the test-design chapter the model wrote.
 *
 * The parse is a *derived* document: the artifact a human approves is rendered
 * from it, so anything the parser did not understand would silently vanish from
 * the approved specification. The row counts are therefore compared with the
 * parsed cases and any discrepancy is a hard error (fail closed) instead of a
 * quietly shorter document.
 * @param draft - the validated draft.
 * @throws when a submitted row was not understood.
 */
export function parseDraftTestDesign(draft: SpecDraft): TestDesign | undefined {
    if (draft.testDesignMarkdown.trim() === '') return undefined
    const wrapped = `## 验收标准\n\n| 编号 | 验收标准 |\n|------|----------|\n${draft.acceptanceCriteria
        .map((text, index) => `| AC-${String(index + 1).padStart(3, '0')} | ${text.replace(/\|/g, '\\|')} |`)
        .join('\n')}\n\n## 测试设计\n\n${draft.testDesignMarkdown}\n`
    const design = parseTestDesign(wrapped)
    const counts = designRowCounts(draft.testDesignMarkdown)
    const problems: string[] = []
    if (counts.unknown > 0) {
        problems.push(
            `${counts.unknown} 行位于无法识别的场景标题下：只认「正向场景 / 异常场景 / 边界场景」（### 或 #### 层级都可以），其余标题下的表格无法进入规格。`,
        )
    }
    for (const kind of ['positive', 'negative', 'boundary'] as const) {
        const expected = counts[kind]
        const parsed = design.cases.filter((testCase) => testCase.kind === kind).length
        if (expected !== parsed) {
            problems.push(`${SCENARIO_LABEL[kind]}：提交了 ${expected} 行用例，实际解析出 ${parsed} 条（列数/表头不符合规格模板的行会被丢弃）。`)
        }
    }
    if (problems.length > 0) {
        throw new Error(
            [
                '测试设计表格没有被完整解析，拒绝写入（否则人工审批的会是另一份文档）：',
                ...problems.map((problem) => `- ${problem}`),
                '表格模板见 test_design_template；每行需要 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 五列。',
            ].join('\n'),
        )
    }
    return design
}

/** Render the mission's specification artifact. */
export function renderSpec(mission: MissionRecord): string {
    return renderSpecMarkdown(mission)
}

/** One-line status of a mission for tool output. */
export function describeMission(mission: MissionRecord): string {
    const spec = mission.spec
    const design = mission.testDesign
    const lines = [
        `mission: ${mission.id}`,
        `title: ${mission.title}`,
        `status: ${mission.status}`,
        `spec: ${mission.specPath ?? '(none)'}${spec === undefined ? '' : ` (revision ${spec.revision})`}`,
        `acceptance criteria: ${spec?.acceptanceCriteria.length ?? 0}`,
        `approved: ${spec?.approvedAt === undefined ? 'no' : `yes (${spec.approvedBy ?? 'unknown'})`}`,
        `test design: ${design === undefined ? 'absent' : `${design.cases.length} case(s), ${design.uncovered.length} uncovered${design.passed === true ? ', passed' : design.passed === false ? ', NOT passed' : ', not reviewed'}`}`,
    ]
    return lines.join('\n')
}

/**
 * Specification drafting: validation, id allocation and the markdown artifact.
 * @module dsh-spec-gate/spec
 */

import {
    allocateCriteriaStable,
    allocateRequirements,
    designRowCounts,
    parseTestDesign,
    renderSpecMarkdown,
    type AcceptanceCriterion,
    type MissionRecord,
    type SpecRecord,
    type TestCase,
    type TestDesign,
} from 'dsh-eng-core'
import {
    declareBudgets,
    readSpecBudgets,
    renderBudgetSection,
    specWithBudgetPlan,
    type SpecBudgetInput,
    type SpecRecordWithBudgets,
} from './budgets.js'

/** What the model supplies when creating a specification. */
export interface SpecDraft {
    title: string
    background: string
    requirements: string[]
    acceptanceCriteria: string[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    /**
     * Optional milestone the requirements belong to (`v1.2`, `M3`…).
     *
     * A milestone is planning metadata, not a property of the document, so it is
     * persisted as a mission label (`milestone:<名称>`): `MissionRecord` is the
     * suite's shared contract and this plugin does not extend it. It is what
     * groups requirements across missions in `plan_status`.
     */
    milestone?: string
    /**
     * 非功能预算（p95、包体积、迁移耗时…）。
     *
     * 省略表示「不改动已有声明」——重写一次规格不会悄悄删掉一条已审批的非功能要求；
     * 传 `[]` 才是明确地删掉全部（被删的编号进入 retired，永不复用）。
     */
    budgets?: readonly SpecBudgetInput[]
    /** 变更理由（记进预算/需求变更历史）。 */
    note?: string
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

/** Longest accepted milestone name. */
export const MILESTONE_MAX_LENGTH = 64

/** Reserved mission label carrying the milestone (`milestone:<名称>`). */
export const MILESTONE_LABEL_PREFIX = 'milestone:'

/**
 * Why a milestone name is unusable, or `undefined` when it is fine.
 *
 * Kept next to the draft contract so `spec_create` and `spec_amend` cannot
 * disagree about what a milestone is; the limit exists because the name is a
 * single line in a report and in a mission label, not a place for prose.
 * @param value - the submitted name (already known to be a string).
 */
export function milestoneProblem(value: string): string | undefined {
    const trimmed = value.trim()
    if (trimmed === '') return 'milestone 不能是空白字符串：省略该参数表示不设里程碑'
    if (trimmed.length > MILESTONE_MAX_LENGTH) {
        return `milestone 最长 ${MILESTONE_MAX_LENGTH} 个字符（当前 ${trimmed.length} 个）：请用版本号/迭代名这类短标签`
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return 'milestone 不能包含控制字符（换行 / 制表符等）'
    return undefined
}

/** The milestone recorded on a mission, or `undefined` when it has none. */
export function milestoneOf(mission: MissionRecord | undefined): string | undefined {
    for (const label of mission?.labels ?? []) {
        if (label.startsWith(MILESTONE_LABEL_PREFIX)) {
            const name = label.slice(MILESTONE_LABEL_PREFIX.length).trim()
            if (name !== '') return name
        }
    }
    return undefined
}

/**
 * The label list with exactly one milestone label.
 *
 * Other labels are preserved (they are the host's, not ours): only the reserved
 * `milestone:` prefix is rewritten, so setting a milestone cannot drop a label
 * somebody else put there.
 * @param labels - current labels.
 * @param milestone - the new name; `undefined` clears the milestone.
 */
export function labelsWithMilestone(labels: readonly string[] | undefined, milestone: string | undefined): string[] {
    const kept = (labels ?? []).filter((label) => !label.startsWith(MILESTONE_LABEL_PREFIX))
    const name = milestone?.trim() ?? ''
    return name === '' ? kept : [...kept, `${MILESTONE_LABEL_PREFIX}${name}`]
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
    if (draft.milestone !== undefined) {
        const problem = milestoneProblem(draft.milestone)
        if (problem !== undefined) issues.push({ field: 'milestone', message: problem })
    }
    return issues
}

/**
 * Assign ids to a freshly submitted draft, PRESERVING the previous ones.
 *
 * The first version numbered the criteria from 1 on every rewrite, so inserting
 * one in the middle renumbered everything after it — and every test case that
 * cited `AC-003` silently started pointing at a different requirement. Ids are
 * now matched by text and kept; new ones are allocated after the highest live or
 * RETIRED number, so a removed id is never handed out again.
 * @param texts - the submitted criteria, in document order.
 * @param previous - the previous revision, when this is a rewrite.
 */
export function allocateCriteria(texts: readonly string[], previous?: SpecRecord): AcceptanceCriterion[] {
    return allocateCriteriaStable(
        texts,
        previous?.acceptanceCriteria ?? [],
        previous?.retired ?? [],
    )
}

/**
 * Build (or revise) the structured specification record.
 *
 * 预算随规格走：`draft.budgets` 省略时沿用上一版的声明（重写规格不等于删掉非功能
 * 要求），给了就按「声明即现状」对账（新增 / 修改 / 删除并作废编号）。声明有任何问题
 * 都在这里抛出 —— 调用方必须在写任何文件之前调用本函数。
 * @param draft - the validated draft.
 * @param previous - the existing record, when this is a revision.
 * @throws when a budget declaration cannot be used (the message carries the fix).
 */
export function buildSpec(draft: SpecDraft, previous?: SpecRecord): SpecRecordWithBudgets {
    const now = Date.now()
    const requirements = allocateRequirements(
        draft.requirements.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        previous?.requirements ?? [],
        previous?.retired ?? [],
    )
    const acceptanceCriteria = allocateCriteria(draft.acceptanceCriteria, previous)
    const previousWithBudgets = previous as SpecRecordWithBudgets | undefined
    const base: SpecRecordWithBudgets = {
        title: draft.title.trim(),
        background: draft.background.trim(),
        requirements,
        acceptanceCriteria,
        fileBoundaries: draft.fileBoundaries.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        negativeConstraints: draft.negativeConstraints.map((entry) => entry.trim()).filter((entry) => entry !== ''),
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        // History and retirement survive a rewrite: a re-created document that
        // forgot them would let a retired id come back (and lose the audit trail).
        ...(previous?.retired === undefined ? {} : { retired: previous.retired }),
        ...(previous?.changes === undefined ? {} : { changes: previous.changes }),
        // 预算同样随修订保留：删掉一条已声明的非功能要求只能通过显式的声明（并作废编号），
        // 不能因为「这次重写没提它」而消失。
        ...(previousWithBudgets?.budgets === undefined ? {} : { budgets: previousWithBudgets.budgets }),
        ...(previousWithBudgets?.retiredBudgets === undefined ? {} : { retiredBudgets: previousWithBudgets.retiredBudgets }),
        ...(previousWithBudgets?.budgetChanges === undefined ? {} : { budgetChanges: previousWithBudgets.budgetChanges }),
        // A revision invalidates a previous approval: the human approved a
        // different document.
    }
    if (draft.budgets === undefined) return base
    const prior = readSpecBudgets(previous)
    const declared = declareBudgets(prior.budgets, draft.budgets, {
        requirementIds: requirements.map((requirement) => requirement.id),
        criterionIds: acceptanceCriteria.map((criterion) => criterion.id),
        retiredBudgets: prior.retired,
        retiredSpecIds: previous?.retired ?? [],
        by: 'spec_create',
        now,
        ...(draft.note === undefined ? {} : { note: draft.note }),
    })
    if (!declared.ok) {
        throw new Error(
            [
                '非功能预算声明无法使用，未写入任何文件：',
                ...declared.problems.map((problem) => `- ${problem}`),
                '修正后重新调用 spec_create（省略 budgets 参数表示不改动已有预算）。',
            ].join('\n'),
        )
    }
    return specWithBudgetPlan(base, declared.plan)
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

/**
 * Render the mission's specification artifact.
 *
 * `dsh-eng-core` renders the canonical chapters; the `## 非功能预算` table is
 * appended here because `SpecRecord` (the shared contract) has no budget field —
 * see the module docs of `./budgets.js`. A spec without budgets renders exactly
 * as before (no empty section).
 */
export function renderSpec(mission: MissionRecord): string {
    const canonical = renderSpecMarkdown(mission)
    const section = renderBudgetSection(mission.spec)
    return section === '' ? canonical : `${canonical}\n${section}\n`
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

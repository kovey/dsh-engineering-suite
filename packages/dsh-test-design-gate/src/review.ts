/**
 * The test-design review itself (docs.md §3.3, §6): coverage, scenario
 * completeness, executability, dangling cases and the optional strict rule.
 *
 * Pure function — markdown in, verdict out — so the checks are unit-testable
 * without a host, and the same text is what the tool, the artifacts and the
 * mission record all quote.
 *
 * @module dsh-test-design-gate/review
 */

import {
    parseAcceptanceCriteria,
    parseSections,
    parseTestDesign,
    type AcceptanceCriterion,
    type TestCase,
    type TestDesign,
} from 'dsh-eng-core'

/** The three scenario classes a specification must design, with their headings. */
export const SCENARIOS: readonly { kind: TestCase['kind']; label: string; heading: string }[] = [
    { kind: 'positive', label: '正向场景', heading: '### 正向场景' },
    { kind: 'negative', label: '异常场景', heading: '### 异常场景' },
    { kind: 'boundary', label: '边界场景', heading: '### 边界场景' },
]

/** Case ids must look like `TC-001` (separator and zero padding optional). */
const CASE_ID = /^TC[-_ ]?\d+$/i

/** Values that say "not written yet" rather than describing a test. */
const PLACEHOLDERS = /^(\.\.\.|…|tbd|todo|待补充|待定|-+)$/i

/** Options the review needs (a subset of the plugin configuration). */
export interface ReviewOptions {
    minTextLength: number
    strict: boolean
    allowDanglingCase: boolean
    requireAllScenarios: boolean
}

/** The outcome of one review pass. */
export interface ReviewOutcome {
    /** True only when no finding was raised. */
    passed: boolean
    /** Chinese, actionable sentences — one per problem found. */
    findings: string[]
    /** The design as parsed from the artifact (no verdict fields yet). */
    design: TestDesign
    /** Acceptance criteria declared by the specification (parsed from disk). */
    criteria: AcceptanceCriterion[]
}

function isPlaceholder(value: string): boolean {
    return PLACEHOLDERS.test(value.trim())
}

/**
 * Normalize a case id for duplicate detection, so `TC-1` and `TC-001` (and
 * `TC_1`) collide as they should.
 */
function duplicateKey(id: string): string {
    const match = /^TC[-_ ]?(\d+)$/i.exec(id.trim())
    return match === null ? id.trim().toUpperCase() : `TC-${String(Number(match[1]))}`
}

function checkField(
    findings: string[],
    testCase: TestCase,
    field: '操作步骤' | '预期结果',
    value: string,
    minTextLength: number,
): void {
    const hint =
        field === '操作步骤'
            ? '请写出具体可执行的操作，例如「请求 GET /health」「运行 node --test test/x.test.ts」。'
            : '请写出可断言的预期结果，例如「返回 200 且 body.status === "ok"」「退出码非 0 且 stderr 含 EADDRINUSE」。'
    const text = value.trim()
    if (text === '') {
        findings.push(`用例 ${testCase.id} 缺少「${field}」：${hint}`)
        return
    }
    if (isPlaceholder(text)) {
        findings.push(`用例 ${testCase.id} 的「${field}」是占位符「${text}」：${hint}`)
        return
    }
    if (text.length < minTextLength) {
        findings.push(`用例 ${testCase.id} 的「${field}」只有 ${text.length} 个字符（至少 ${minTextLength} 个）：描述过短，无法转化为可执行断言。${hint}`)
    }
}

/**
 * Review one specification's test design.
 * @param markdown - the specification artifact as it exists on disk.
 * @param options - resolved gate configuration.
 * @returns the verdict, the findings and the parsed design.
 */
export function reviewTestDesign(markdown: string, options: ReviewOptions): ReviewOutcome {
    const design = parseTestDesign(markdown)
    const criteria = parseAcceptanceCriteria(parseSections(markdown))
    const findings: string[] = []

    // 0. The artifact itself must exist and declare something to cover.
    if (markdown.trim() === '') {
        findings.push('规格工件为空或不存在：请先调用 spec_create 写入规格（必须包含 `## 验收标准` 与 `## 测试设计` 章节）。')
    } else if (criteria.length === 0) {
        findings.push('规格的 `## 验收标准` 章节为空：请补上至少一条可验证的标准（编号形如 AC-001），测试设计才有覆盖对象。')
    }

    // 1. 覆盖度：每条验收标准至少一条用例（docs.md §3.3）。
    if (design.uncovered.length > 0) {
        findings.push(
            `验收标准 ${design.uncovered.join(', ')} 没有任何测试用例覆盖：请在 ` +
                `${SCENARIOS.map((scenario) => `\`${scenario.heading}\``).join(' / ')} 的「覆盖验收标准」列填上对应编号（每条标准至少一条用例）。`,
        )
    }

    // 2. 场景完整性：正向 / 异常 / 边界三类都要有。
    if (options.requireAllScenarios) {
        const kinds = new Set(design.cases.map((testCase) => testCase.kind))
        for (const scenario of SCENARIOS) {
            if (kinds.has(scenario.kind)) continue
            findings.push(
                `测试设计缺少「${scenario.label}」用例（\`${scenario.heading}\`）：三类场景必须各至少一条用例，请补齐该章节表格。`,
            )
        }
    }

    // 3. 可执行性：id 形式与唯一性 + 步骤/预期足够具体。
    const seen = new Map<string, string>()
    for (const testCase of design.cases) {
        if (!CASE_ID.test(testCase.id.trim())) {
            findings.push(`用例「${testCase.id}」的用例ID不符合 TC-001 形式：请改成 \`TC-<数字>\`（例如 TC-004）。`)
        }
        const key = duplicateKey(testCase.id)
        const first = seen.get(key)
        if (first === undefined) {
            seen.set(key, testCase.id)
        } else {
            findings.push(`用例ID ${testCase.id} 与 ${first} 重复：每个用例必须有唯一ID，请改成未占用的编号。`)
        }
        checkField(findings, testCase, '操作步骤', testCase.steps, options.minTextLength)
        checkField(findings, testCase, '预期结果', testCase.expected, options.minTextLength)
    }

    // 4. 悬挂用例：必须声明它覆盖的验收标准，且编号必须存在。
    if (!options.allowDanglingCase) {
        const known = new Set(criteria.map((criterion) => criterion.id))
        const available = criteria.map((criterion) => criterion.id).join(', ')
        for (const testCase of design.cases) {
            if (testCase.covers.length === 0) {
                findings.push(
                    `用例 ${testCase.id} 没有声明覆盖的验收标准（悬挂用例）：请在「覆盖验收标准」列填上它验证的编号（可用：${available || '（规格里没有验收标准）'}）。`,
                )
                continue
            }
            const unknown = testCase.covers.filter((ref) => !known.has(ref))
            if (unknown.length > 0) {
                findings.push(
                    `用例 ${testCase.id} 覆盖了不存在的验收标准 ${unknown.join(', ')}：规格里可用的编号是 ${available || '（无）'}，请改名或改覆盖列。`,
                )
            }
        }
    }

    // 5. 严格模式：每条验收标准还要有异常或边界用例。
    if (options.strict) {
        for (const criterion of criteria) {
            if (design.uncovered.includes(criterion.id)) continue
            const strong = design.cases.some((testCase) => testCase.kind !== 'positive' && testCase.covers.includes(criterion.id))
            if (!strong) {
                findings.push(
                    `严格模式（strict）：验收标准 ${criterion.id} 只有正向用例覆盖，缺少异常场景或边界场景的用例——失败路径同样需要可验证。`,
                )
            }
        }
    }

    return { passed: findings.length === 0, findings, design, criteria }
}

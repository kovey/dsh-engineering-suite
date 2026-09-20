/**
 * Bootstrapping a specification for a repository that already exists.
 *
 * The intelligence here is the MODEL'S, not this module's: a draft is written by
 * a model that actually reads the code with `read`/`grep`/`glob` — not by
 * pre-chewing the repository into a regex digest and asking one question. What
 * the plugin owns is the part a model should not be trusted with:
 *
 *  - the **contract**: what a specification must contain, what a test case must
 *    say (前置条件 / 操作步骤 / 预期结果), and which next steps follow;
 *  - the **gate**: a draft that does not parse, leaves placeholders, or leaves
 *    acceptance criteria without cases is reported before it reaches
 *    `spec_create`;
 *  - the **bounds**: a read-only child agent, a bounded index of where to look,
 *    and a deadline.
 *
 * Drafting is offered two ways, both model-driven:
 *
 *  - `brief` hands the contract to the CALLING agent, which already has the read
 *    tools and the repository in front of it;
 *  - `draft` dispatches a read-only CHILD agent (no write/edit/bash in its tool
 *    filter) that reads the repository itself and returns the draft, validated
 *    here exactly like a hand-written one.
 *
 * A draft is never an approval: it still goes through `spec_create` →
 * `test_design_review` → `spec_approve`, and nothing in this module can approve,
 * deliver or record a gate.
 *
 * @module dsh-spec-gate/bootstrap
 */

import {
    designRowCounts,
    parseAcceptanceCriteria,
    parseSections,
    parseTestDesign,
    type GapReport,
    type ScanResult,
    type TestDesign,
} from 'dsh-eng-core'
import type { SpecDraft } from './spec.js'

/** The output contract every drafting path must satisfy. */
export const DRAFT_CONTRACT = [
    '## 交付物（只有这两段 Markdown：不要解释、不要代码块围栏）',
    '',
    '### 1) 验收标准',
    '| 编号 | 验收标准 |',
    '|------|----------|',
    '| AC-001 | … |',
    '',
    '### 2) 测试设计（三个场景小节 + 五列表格，表头原样）',
    '### 正向场景',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | … | … | … | AC-001 |',
    '### 异常场景',
    '（同表头）',
    '### 边界场景',
    '（同表头）',
    '',
    '## 写法要求',
    '1. **必须真的读代码**：用 read/grep/glob 打开源码、测试、构建文件与文档之后再写；不要凭仓库名或目录名猜行为。',
    '2. **每条验收标准都要可被确定性验证**（命令、输入、可判定的输出），不要写"体验良好"这类验证不了的话。',
    '3. **操作步骤要具体到能照着做**：写清调用的命令/入口、输入数据、前置状态；预期结果写清状态码/输出片段/错误信息/文件变化。',
    '4. **每个 AC 至少被一条用例覆盖**，三个场景小节都要有用例。',
    '5. **不确定就标注**：从代码推断（仓库里没有需求文档依据）的条目加 `[推断]`；确实无法确定的写 `[待确认]` 并说明缺什么。',
    '6. **禁止发明**：宁少勿假——伪造的验收标准会被人工审批放行，然后变成永远无法满足的门禁。',
].join('\n')

/** What a caller gets for `action: 'brief'`. */
export interface BootstrapBrief {
    /** Where to look, in reading order — pointers, never a conclusion. */
    index: {
        documents: string[]
        tests: string[]
        buildFiles: string[]
        suggestedCommands: { id: string; command: string; phase: string; required: boolean }[]
    }
    /** Gaps the draft should close. */
    gaps: GapReport
    truncated: boolean
}

/** One problem found in a draft, with what to do about it. */
export interface DraftFinding {
    kind: 'parse' | 'coverage' | 'steps' | 'placeholder' | 'shape'
    detail: string
}

/** Result of validating an authored draft. */
export interface DraftCheck {
    ok: boolean
    criteria: { id: string; text: string }[]
    cases: number
    findings: DraftFinding[]
}

/** Reduce a scan to the pointers a reader should start from. */
export function buildIndex(
    scan: ScanResult,
    gaps: GapReport,
    maxEntries: number,
): { brief: BootstrapBrief; truncated: boolean } {
    const truncated = scan.stats.truncated || scan.requirements.length > maxEntries || scan.tests.length > maxEntries
    return {
        brief: {
            index: {
                documents: scan.requirements.slice(0, maxEntries).map((doc) => doc.path),
                tests: scan.tests.slice(0, maxEntries).map((file) => file.path),
                buildFiles: scan.buildFiles.slice(0, maxEntries),
                suggestedCommands: scan.suggestedCommands.map((command) => ({
                    id: command.id,
                    command: command.command,
                    phase: command.phase,
                    required: command.required,
                })),
            },
            gaps,
            truncated,
        },
        truncated,
    }
}

/** Render the authoring brief: contract + where to look + known gaps. */
export function renderBrief(brief: BootstrapBrief, cwd: string): string {
    return [
        '## 存量项目接入：写一份规格草稿（**由模型读代码得出**）',
        '',
        `仓库：${cwd}`,
        '',
        DRAFT_CONTRACT,
        '',
        '## 从哪里看起（索引，不是结论——结论必须来自你自己读到的代码）',
        '',
        `- 需求类文档（${brief.index.documents.length}）：${brief.index.documents.join('、') || '(没有：所有条目都要标 [推断])'}`,
        `- 已有测试（${brief.index.tests.length}）：${brief.index.tests.join('、') || '(无)'}`,
        `- 构建文件：${brief.index.buildFiles.join('、') || '(未识别)'}`,
        `- 已识别的验证命令：${brief.index.suggestedCommands.map((command) => `\`${command.command}\``).join('、') || '(无：需要写 .dsh/quality-gate.json)'}`,
        ...(brief.truncated ? ['- ⚠️ 索引已截断：仓库里还有更多文件，用 glob/grep 自己继续找'] : []),
        '',
        '## 已知缺口（草稿优先补这些）',
        '',
        `- 无用例的验收标准：${brief.gaps.criteriaWithoutCases.length} 条`,
        ...brief.gaps.criteriaWithoutCases.slice(0, 10).map((gap) => `  - ${gap.id} ${gap.text}`),
        `- 步骤/预期过短的用例：${brief.gaps.casesWithThinSteps.length} 条`,
        ...brief.gaps.casesWithThinSteps.slice(0, 10).map((gap) => `  - ${gap.id}（${gap.reason}）`),
        `- 缺的工件：${brief.gaps.missingArtifacts.join('、') || '(无)'}`,
        '',
        '## 写完以后',
        '',
        '1. `spec_bootstrap({ action: "check", acceptanceCriteria: [...], testDesign: "…" })` 自查（覆盖度、步骤是否够具体、占位是否清干净）；',
        '2. `spec_create`（把两段内容原样填入）→ `test_design_review` → `spec_approve`；',
        '3. 仓库里没有需求文档时，从代码推断的条目**必须在草稿与对话里标明 `[推断]`**，让审批人知道哪些需要确认。',
    ].join('\n')
}

/**
 * Parse a drafted answer into criteria + test design.
 * @returns the parsed pieces, or the reason they are unusable.
 */
export function parseDraftAnswer(
    answer: string,
    limits: { maxCases: number },
): { criteria: { id: string; text: string }[]; design: TestDesign; designMarkdown: string } | { problem: string } {
    const trimmed = answer
        .trim()
        .replace(/^```(?:markdown|md)?\n?/i, '')
        .replace(/\n?```$/, '')
    const sections = parseSections(trimmed, [2])
    const criteria = parseAcceptanceCriteria(sections)
    if (criteria.length === 0) return { problem: '没有解析出验收标准（需要 `## 验收标准` 表格）' }
    const designStart = trimmed.search(/^##\s*测试设计\s*$/m)
    if (designStart === -1) return { problem: '没有 `## 测试设计` 章节' }
    const designMarkdown = trimmed.slice(designStart)
    const counts = designRowCounts(designMarkdown)
    const rows = counts.positive + counts.negative + counts.boundary
    if (rows === 0) return { problem: '测试设计里没有用例行（需要三个场景小节 + 五列表格）' }
    if (counts.unknown > 0) return { problem: `测试设计里有 ${counts.unknown} 行在无法识别的场景标题下` }
    const design = parseTestDesign(designMarkdown)
    if (design.cases.length === 0) return { problem: '测试设计解析出的用例数为 0' }
    if (rows !== design.cases.length) {
        return { problem: `用例行数 ${rows} 与解析出的用例数 ${design.cases.length} 不一致（有行会被静默丢弃）` }
    }
    if (design.cases.length > limits.maxCases) {
        return { problem: `用例数 ${design.cases.length} 超过上限 ${limits.maxCases}` }
    }
    return { criteria, design, designMarkdown }
}

/**
 * Validate an authored draft against the contract.
 *
 * This is the deterministic half of "be intelligent": the model reads the code
 * and writes the prose, and this refuses to let invented coverage, placeholder
 * steps or unparsable rows reach `spec_create`.
 * @param input - the two authored sections plus the minimum step length.
 */
export function checkDraft(input: {
    acceptanceCriteria: readonly string[]
    testDesign: string
    minTextLength: number
}): DraftCheck {
    const findings: DraftFinding[] = []
    const criteria = input.acceptanceCriteria
        .map((line) => /^\s*(AC-\d+)\s+(.+)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ id: match[1] as string, text: (match[2] as string).trim() }))
    const nonEmpty = input.acceptanceCriteria.filter((line) => line.trim() !== '').length
    if (criteria.length !== nonEmpty) {
        findings.push({
            kind: 'shape',
            detail: '验收标准必须写成 `AC-001 具体标准`（编号 + 空格 + 文本）；有行不符合',
        })
    }
    if (criteria.length === 0) {
        findings.push({ kind: 'parse', detail: '没有可解析的验收标准' })
        return { ok: false, criteria, cases: 0, findings }
    }

    const ids = new Set(criteria.map((criterion) => criterion.id))
    const counts = designRowCounts(input.testDesign)
    if (counts.positive + counts.negative + counts.boundary === 0) {
        findings.push({ kind: 'parse', detail: '测试设计里没有用例行（需要三个场景小节 + 五列表格）' })
    }
    if (counts.unknown > 0) findings.push({ kind: 'parse', detail: `${counts.unknown} 行在无法识别的场景标题下` })
    const design = parseTestDesign(input.testDesign)

    const covered = new Set<string>()
    for (const testCase of design.cases) for (const id of testCase.covers) covered.add(id)

    for (const criterion of criteria) {
        if (!covered.has(criterion.id)) {
            findings.push({ kind: 'coverage', detail: `${criterion.id} 没有任何用例覆盖：${criterion.text.slice(0, 60)}` })
        }
    }
    for (const testCase of design.cases) {
        for (const id of testCase.covers) {
            if (!ids.has(id)) findings.push({ kind: 'coverage', detail: `${testCase.id} 覆盖了不存在的验收标准 ${id}` })
        }
        if (testCase.steps.trim().length < input.minTextLength || testCase.expected.trim().length < input.minTextLength) {
            findings.push({
                kind: 'steps',
                detail: `${testCase.id} 的操作步骤或预期结果过短（< ${input.minTextLength} 字符）：写清命令/输入与可判定的结果`,
            })
        }
        if (/\[待确认\]|\[TODO\]|待补充/i.test(`${testCase.precondition}${testCase.steps}${testCase.expected}`)) {
            findings.push({ kind: 'placeholder', detail: `${testCase.id} 还留着占位符（[待确认]/待补充）` })
        }
    }
    for (const entry of design.uncovered) {
        findings.push({ kind: 'coverage', detail: `验收标准 ${entry} 没有被任何用例覆盖` })
    }
    return { ok: findings.length === 0, criteria, cases: design.cases.length, findings }
}

/** Render a validated draft as the markdown a human reviews. */
export function renderDraft(draft: SpecDraft, meta: { source: string; findings: string[] }): string {
    return [
        `# ${draft.title}`,
        '',
        '> ⚠️ 这是**草稿**，没有任何审批效力。',
        `> 来源：${meta.source}`,
        '> 下一步：核对 → `spec_create` → `test_design_review` → `spec_approve`。',
        '',
        '## 背景',
        '',
        draft.background,
        '',
        '## 需求',
        '',
        ...(draft.requirements.length === 0 ? ['- (未单独列出)'] : draft.requirements.map((item) => `- ${item}`)),
        '',
        '## 验收标准',
        '',
        '| 编号 | 验收标准 |',
        '|------|----------|',
        ...draft.acceptanceCriteria.map((item) => {
            const match = /^(AC-\d+)\s+(.*)$/.exec(item)
            return match === null ? `| AC-??? | ${item} |` : `| ${match[1]} | ${match[2]} |`
        }),
        '',
        '## 文件边界',
        '',
        ...(draft.fileBoundaries.length === 0 ? ['- [待确认]'] : draft.fileBoundaries.map((item) => `- \`${item}\``)),
        '',
        '## 负面约束（禁止）',
        '',
        ...(draft.negativeConstraints.length === 0
            ? ['- （未声明：可写 `path:` / `tool:` / `cmd:` / `argv:` 前缀的条目，由门禁强制）']
            : draft.negativeConstraints.map((item) => `- ${item}`)),
        '',
        '## 测试设计',
        '',
        draft.testDesignMarkdown,
        '',
        ...(meta.findings.length === 0 ? [] : ['## 自查发现的问题', '', ...meta.findings.map((finding) => `- ${finding}`), '']),
    ].join('\n')
}

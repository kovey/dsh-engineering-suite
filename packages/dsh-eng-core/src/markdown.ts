/**
 * The specification artifact format.
 *
 * The specification is the shared contract between the gates (docs.md §1.2:
 * "规格即程序"), so its rendering and parsing live in one place. The layout is
 * exactly the one docs.md prescribes — acceptance criteria, file boundaries,
 * negative constraints and a structured test-design chapter:
 *
 * ```markdown
 * ## 验收标准
 * | 编号 | 验收标准 |
 * |------|----------|
 * | AC-001 | ... |
 *
 * ## 测试设计
 * ### 正向场景
 * | 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |
 * ```
 *
 * Both the Chinese headings from docs.md and their English aliases parse, so a
 * team can write either language without the gates losing the structure.
 *
 * @module dsh-eng-core/markdown
 */

import { cell, formatTime, sha256 } from './digest.js'
import type { AcceptanceCriterion, MissionRecord, SpecRecord, TestCase, TestDesign } from './types.js'

/** One Markdown heading with its body. */
export interface MdSection {
    level: number
    title: string
    body: string
}

/** Heading aliases: canonical key → accepted titles (case-insensitive). */
const HEADINGS = {
    background: ['背景', 'background'],
    requirements: ['需求', 'requirements'],
    acceptance: ['验收标准', 'acceptance criteria'],
    boundaries: ['文件边界', 'file boundaries'],
    negative: ['负面约束', '负面约束（禁止）', 'negative constraints', 'forbidden'],
    testDesign: ['测试设计', 'test design'],
    positive: ['正向场景', 'positive scenarios', 'positive'],
    negativeScenarios: ['异常场景', 'negative scenarios', 'negative'],
    boundaryScenarios: ['边界场景', 'boundary scenarios', 'boundary'],
} as const

type HeadingKey = keyof typeof HEADINGS

/**
 * Split Markdown into sections at the requested heading levels.
 *
 * Only the listed levels split: parsing a specification at level 2 keeps the
 * `### 正向场景` / `### 异常场景` / `### 边界场景` headings *inside* the
 * `## 测试设计` body, and the nested parse then splits that body at level 3.
 * @param markdown - the document.
 * @param levels - heading levels that start a new section (default `[2]`).
 */
export function parseSections(markdown: string, levels: readonly number[] = [2]): MdSection[] {
    const sections: MdSection[] = []
    let current: MdSection | undefined
    for (const line of markdown.split(/\r?\n/)) {
        const match = /^(#{1,6})\s+(.*)$/.exec(line)
        if (match !== null && levels.includes(match[1]?.length ?? 0)) {
            current = { level: match[1]?.length ?? 2, title: (match[2] ?? '').trim(), body: '' }
            sections.push(current)
            continue
        }
        if (current !== undefined) current.body += `${line}\n`
    }
    return sections
}

/** Find one section by any of its accepted titles. */
export function findSection(sections: readonly MdSection[], key: HeadingKey): MdSection | undefined {
    const titles = HEADINGS[key] as readonly string[]
    return sections.find((section) => titles.some((title) => title.toLowerCase() === section.title.toLowerCase()))
}

/** Parse a Markdown table body into a header plus rows. */
export function parseTable(body: string): { header: string[]; rows: string[][] } {
    const lines: string[] = []
    for (const raw of body.split(/\r?\n/)) {
        const line = normalizeRow(raw.trim())
        // A table ends where the next heading begins: without this, a `###`
        // subsection's table (test cases) bleeds into its parent's table
        // (acceptance criteria) and invents criteria named after the columns.
        if (/^#{1,6}\s/.test(line)) break
        if (line.startsWith('|')) lines.push(line)
    }
    const parsed: string[][] = []
    const separators = new Set<number>()
    for (const [index, line] of lines.entries()) {
        const cells = splitRow(line)
        if (cells.length === 0) continue
        if (cells.every((value) => /^:?-{2,}:?$/.test(value.replace(/[\s\uFF0D\u2013\u2014]/g, '-')))) {
            separators.add(parsed.length)
            continue
        }
        parsed.push(cells)
        void index
    }
    // The first row is a header only when the table says so — a separator line
    // right after it, or cells that name known columns. A GFM table written
    // without a header must keep ALL of its rows as data, otherwise the first
    // submitted case silently becomes a column title.
    const first = parsed[0]
    const second = parsed[1]
    const hasHeader =
        first !== undefined &&
        ((second !== undefined && separators.has(1)) || first.some((cell) => KNOWN_COLUMN_TITLES.test(cell.trim())))
    return {
        header: hasHeader ? (first ?? []) : [],
        rows: hasHeader ? parsed.slice(1) : parsed,
    }
}

/** Column titles that identify a real table header (never a data row). */
const KNOWN_COLUMN_TITLES =
    /^(编号|id|用例id|用例编号|用例|前置条件|操作步骤|步骤|预期结果|覆盖验收标准|覆盖|验收标准|验收|场景|备注|名称|命令|name|command|steps?|expected|precondition|covers?)$/i

/**
 * Normalise one table row.
 *
 * Models write tables with full-width separators (`｜`) and GFM allows rows
 * without the leading/trailing pipe (`a | b`); both must parse, because a row
 * that silently disappears turns the approved artifact into a different
 * document than the one that was submitted.
 */
function normalizeRow(line: string): string {
    const unified = line.replace(/｜/g, '|')
    if (unified === '') return unified
    if (unified.startsWith('|')) return unified
    // A row without a leading pipe is only a table row when it has separators.
    return unified.includes('|') ? `| ${unified}` : unified
}

function splitRow(line: string): string[] {
    const inner = line.replace(/^\|/, '').replace(/\|$/, '')
    const cells: string[] = []
    let current = ''
    for (let index = 0; index < inner.length; index += 1) {
        const character = inner[index]
        if (character === '\\' && inner[index + 1] === '|') {
            current += '|'
            index += 1
            continue
        }
        if (character === '|') {
            cells.push(current.trim())
            current = ''
            continue
        }
        current += character
    }
    cells.push(current.trim())
    return cells
}

function columnIndex(header: readonly string[], names: readonly string[], fallback: number): number {
    const index = header.findIndex((title) => names.some((name) => title.toLowerCase().includes(name.toLowerCase())))
    return index >= 0 ? index : fallback
}

/** Extract `AC-xxx` references from free text. */
export function criterionRefs(text: string): string[] {
    const refs = new Set<string>()
    for (const match of text.matchAll(/AC[-_ ]?(\d{1,4})/gi)) {
        refs.add(`AC-${(match[1] ?? '').padStart(3, '0')}`)
    }
    return [...refs]
}

/** Parse the spec's acceptance-criteria table. */
export function parseAcceptanceCriteria(sections: readonly MdSection[]): AcceptanceCriterion[] {
    const section = findSection(sections, 'acceptance')
    if (section === undefined) return []
    const { header, rows } = parseTable(section.body)
    const idIndex = columnIndex(header, ['编号', 'id'], 0)
    const textIndex = columnIndex(header, ['验收标准', 'criterion', '标准'], 1)
    const criteria: AcceptanceCriterion[] = []
    for (const row of rows) {
        const id = (row[idIndex] ?? '').trim()
        const text = (row[textIndex] ?? '').trim()
        if (id === '' || text === '') continue
        criteria.push({ id: normalizeCriterionId(id), text })
    }
    return criteria
}

function normalizeCriterionId(raw: string): string {
    const match = /AC[-_ ]?(\d{1,4})/i.exec(raw)
    return match === null ? raw : `AC-${(match[1] ?? '').padStart(3, '0')}`
}

function bulletLines(body: string): string[] {
    const cut = body.search(/^#{3,6}\s/m)
    const scoped = cut < 0 ? body : body.slice(0, cut)
    return scoped
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^([-*+]|\d+[.)])\s+/.test(line))
        .map((line) => line.replace(/^([-*+]|\d+[.)])\s+/, '').trim())
        .filter((line) => line !== '')
}

/** Parse the spec's requirement, boundary and constraint lists. */
export function parseLists(sections: readonly MdSection[]): {
    requirements: string[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    background: string
} {
    const background = (findSection(sections, 'background')?.body ?? '').trim()
    return {
        background,
        requirements: bulletLines(findSection(sections, 'requirements')?.body ?? ''),
        fileBoundaries: bulletLines(findSection(sections, 'boundaries')?.body ?? ''),
        negativeConstraints: bulletLines(findSection(sections, 'negative')?.body ?? ''),
    }
}

function parseScenario(section: MdSection | undefined, kind: TestCase['kind']): TestCase[] {
    if (section === undefined) return []
    const { header, rows } = parseTable(section.body)
    const idIndex = columnIndex(header, ['用例id', '用例', 'id', 'case'], 0)
    const preconditionIndex = columnIndex(header, ['前置条件', 'precondition'], 1)
    const stepsIndex = columnIndex(header, ['操作步骤', '步骤', 'steps'], 2)
    const expectedIndex = columnIndex(header, ['预期结果', 'expected'], 3)
    const coversIndex = columnIndex(header, ['覆盖', 'covers', '验收标准'], 4)
    const cases: TestCase[] = []
    for (const row of rows) {
        const id = (row[idIndex] ?? '').trim()
        if (id === '' || /^-+$/.test(id)) continue
        const steps = (row[stepsIndex] ?? '').trim()
        const expected = (row[expectedIndex] ?? '').trim()
        const coversRaw = (row[coversIndex] ?? '').trim()
        cases.push({
            id,
            kind,
            precondition: (row[preconditionIndex] ?? '').trim(),
            steps,
            expected,
            covers: coversRaw === '' ? [] : criterionRefs(coversRaw),
        })
    }
    return cases
}

/**
 * Extract one chapter (heading + everything under it, at any heading level).
 *
 * A heading's body ends at the next heading of the same or a higher level, so
 * the chapter is complete whether it was written as `## 测试设计` or (the common
 * mistake) `### 测试设计`.
 * @param markdown - the document.
 * @returns the chapter body, or `undefined` when no such heading exists.
 */
function chapterBodyOf(markdown: string): string | undefined {
    const aliases = HEADINGS.testDesign as readonly string[]
    const lines = markdown.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^(#{1,6})\s+(.*)$/.exec(lines[index] ?? '')
        if (match === null) continue
        const level = (match[1] ?? '').length
        const title = (match[2] ?? '').trim().toLowerCase()
        if (!aliases.some((alias) => alias.toLowerCase() === title)) continue
        const body: string[] = []
        for (let next = index + 1; next < lines.length; next += 1) {
            const heading = /^(#{1,6})\s+/.exec(lines[next] ?? '')
            if (heading !== null && (heading[1] ?? '').length <= level) break
            body.push(lines[next] ?? '')
        }
        return body.join('\n')
    }
    return undefined
}

/**
 * Count the table data rows the SUBMITTED design chapter contains, per scenario
 * class, plus any scenario rows under an unrecognised heading.
 *
 * This is the guard against silent document loss: `spec_create` re-renders the
 * artifact from its parse, so a row the parser did not understand would simply
 * disappear from the document a human approves. Callers compare these counts
 * with the parsed cases and refuse the write on any mismatch.
 * @param markdown - the submitted design chapter (or a whole specification).
 */
export function designRowCounts(markdown: string): { positive: number; negative: number; boundary: number; unknown: number } {
    const body = chapterBodyOf(markdown) ?? markdown
    const sections = parseSections(body, [3, 4])
    const counts = { positive: 0, negative: 0, boundary: 0, unknown: 0 }
    const classify = (title: string): keyof typeof counts | undefined => {
        const normalized = title.trim().toLowerCase()
        for (const scenario of SCENARIOS) {
            const aliases = HEADINGS[scenario.key] as readonly string[]
            if (aliases.some((alias) => alias.toLowerCase() === normalized)) return scenarioKind(scenario.key)
        }
        return undefined
    }
    for (const section of sections) {
        const kind = classify(section.title)
        const { rows } = parseTable(section.body)
        if (kind === undefined) {
            // Rows under a heading we do not understand are exactly the silent
            // loss this function exists to catch.
            if (rows.length > 0) counts.unknown += rows.length
            continue
        }
        counts[kind] += rows.length
    }
    // A chapter written without any nested heading at all: count its rows as unknown.
    if (sections.length === 0) {
        counts.unknown += parseTable(body).rows.length
    }
    return counts
}

/**
 * Parse the structured test-design chapter of a specification.
 * @param markdown - the specification markdown.
 * @returns the design with coverage computed against the spec's criteria.
 */
export function parseTestDesign(markdown: string): TestDesign {
    const sections = parseSections(markdown)
    // The chapter may be written as `## 测试设计` (canonical) or `### 测试设计`
    // (a common mistake); looking at both levels means the design is still
    // reviewed instead of silently vanishing.
    const designBody = chapterBodyOf(markdown)
    const criteria = parseAcceptanceCriteria(sections)
    const cases: TestCase[] = []
    if (designBody !== undefined) {
        const nested = parseSections(designBody, [3, 4])
        cases.push(...parseScenario(findSection(nested, 'positive'), 'positive'))
        cases.push(...parseScenario(findSection(nested, 'negativeScenarios'), 'negative'))
        cases.push(...parseScenario(findSection(nested, 'boundaryScenarios'), 'boundary'))
    }
    const covered = new Set(cases.flatMap((testCase) => testCase.covers))
    return {
        cases,
        covered: [...covered].sort(),
        uncovered: criteria.filter((criterion) => !covered.has(criterion.id)).map((criterion) => criterion.id),
    }
}

/**
 * Canonical digest of everything a test-design review actually validates:
 * the acceptance criteria and the designed cases.
 *
 * Deliberately NOT a digest of the whole specification file: `spec-gate`
 * re-renders the artifact when it records an approval (the header changes),
 * and a hand-edit of prose must not invalidate a legitimate review either. What
 * must invalidate it is a change of criteria or cases — which is exactly what
 * this projection covers.
 * @param spec - the specification record (or just its criteria).
 * @param design - the design being bound (or just its cases).
 */
export function specReviewDigest(
    spec: { acceptanceCriteria?: readonly AcceptanceCriterion[] } | undefined,
    design: { cases?: readonly TestCase[] } | undefined,
): string {
    const criteria = (spec?.acceptanceCriteria ?? []).map((criterion) => [criterion.id, criterion.text.trim()])
    const cases = (design?.cases ?? []).map((testCase) => [
        testCase.id,
        testCase.kind,
        testCase.steps.trim(),
        testCase.expected.trim(),
        [...testCase.covers].sort(),
    ])
    return sha256(JSON.stringify({ criteria, cases }))
}

/** Render the canonical specification markdown for a mission. */
export function renderSpecMarkdown(mission: MissionRecord): string {
    const spec: SpecRecord | undefined = mission.spec
    if (spec === undefined) return `# ${mission.title}\n\n(no specification recorded)\n`
    const lines: string[] = []
    lines.push(`# ${spec.title}`)
    lines.push('')
    lines.push(`- Mission: \`${mission.id}\``)
    lines.push(`- Status: \`${mission.status}\``)
    lines.push(`- Revision: ${spec.revision}`)
    lines.push(`- Created: ${formatTime(spec.createdAt)}`)
    lines.push(`- Updated: ${formatTime(spec.updatedAt)}`)
    if (spec.approvedAt !== undefined) {
        lines.push(`- Approved: ${formatTime(spec.approvedAt)} by \`${spec.approvedBy ?? 'unknown'}\``)
    }
    lines.push('')
    lines.push('## 背景')
    lines.push('')
    lines.push(spec.background === '' ? '(未填写)' : spec.background)
    lines.push('')
    lines.push('## 需求')
    lines.push('')
    pushList(lines, spec.requirements)
    lines.push('')
    lines.push('## 验收标准')
    lines.push('')
    lines.push('| 编号 | 验收标准 |')
    lines.push('|------|----------|')
    for (const criterion of spec.acceptanceCriteria) {
        lines.push(`| ${cell(criterion.id)} | ${cell(criterion.text)} |`)
    }
    lines.push('')
    lines.push('## 文件边界')
    lines.push('')
    pushList(lines, spec.fileBoundaries)
    lines.push('')
    lines.push('## 负面约束（禁止）')
    lines.push('')
    pushList(lines, spec.negativeConstraints)
    lines.push('')
    lines.push('## 测试设计')
    lines.push('')
    lines.push(renderTestDesignBody(mission.testDesign))
    lines.push('')
    return lines.join('\n')
}

function pushList(lines: string[], items: readonly string[]): void {
    if (items.length === 0) {
        lines.push('(未填写)')
        return
    }
    for (const item of items) lines.push(`- ${item}`)
}

const SCENARIOS: readonly { key: HeadingKey; heading: string }[] = [
    { key: 'positive', heading: '正向场景' },
    { key: 'negativeScenarios', heading: '异常场景' },
    { key: 'boundaryScenarios', heading: '边界场景' },
]

/** Render just the test-design chapter body. */
export function renderTestDesignBody(design: TestDesign | undefined): string {
    const lines: string[] = []
    for (const scenario of SCENARIOS) {
        lines.push(`### ${scenario.heading}`)
        lines.push('')
        lines.push('| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |')
        lines.push('|--------|----------|----------|----------|--------------|')
        const cases = (design?.cases ?? []).filter((testCase) => testCase.kind === scenarioKind(scenario.key))
        for (const testCase of cases) {
            lines.push(
                `| ${cell(testCase.id)} | ${cell(testCase.precondition)} | ${cell(testCase.steps)} | ${cell(testCase.expected)} | ${cell(testCase.covers.join(', '))} |`,
            )
        }
        lines.push('')
    }
    return lines.join('\n').trimEnd()
}

function scenarioKind(key: HeadingKey): TestCase['kind'] {
    if (key === 'positive') return 'positive'
    if (key === 'negativeScenarios') return 'negative'
    return 'boundary'
}

/**
 * The prompt fragment advertising the canonical spec/test-design table shapes,
 * injected into the system prompt so the model writes parseable tables.
 */
export const SPEC_FORMAT_HINT = [
    '规格工件必须包含以下章节（Markdown 表格逐列填写，不要改写表头）：',
    '',
    '## 验收标准',
    '| 编号 | 验收标准 |',
    '|------|----------|',
    '| AC-001 | ... |',
    '',
    '## 测试设计',
    '### 正向场景 / ### 异常场景 / ### 边界场景',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | ... | ... | ... | AC-001 |',
].join('\n')

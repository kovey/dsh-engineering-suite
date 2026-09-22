/**
 * Coverage reports: pure parsers, and the incremental judgement that follows.
 *
 * Four formats cover the practical field: **lcov** (`SF:`/`DA:`/`LF:`/`LH:`),
 * **cobertura XML** (`<class filename=…><line number=… hits=…>`), the **Go cover
 * profile** (`mode: …` + `path:startLine.startCol,endLine.endCol numStmt count`)
 * and **istanbul JSON** (`{"/abs/path": {statementMap, s}}`).
 *
 * Three rules, all of them learned from what a coverage number does NOT say:
 *
 *  1. **Unknown is not empty.** Text that no parser recognises returns a
 *     *problem*, never a report with zero files — "0 files" is indistinguishable
 *     from "nothing is covered", and a gate would read it as the latter.
 *  2. **Instrumentation is not coverage.** Only lines the report actually
 *     instruments can be judged. The lines a change added that the report does
 *     not instrument are reported separately and excluded from every ratio —
 *     counting them as 0% would be as wrong as counting them as 100%.
 *  3. **A unit is not a line.** Go and istanbul instrument blocks/statements, so
 *     their metric is named `statements` and a report says which metric it used;
 *     the numbers from two metrics are not comparable and the module never
 *     pretends they are.
 *
 * Everything here is pure: no clocks, no I/O, sorted output.
 *
 * @module dsh-coverage-gate/coverage
 */

import path from 'node:path'
import type { ChangedFile } from 'dsh-eng-core'
import type { ReportFormat } from './config.js'

/** A format a report can actually be in (no `auto` — that is resolved first). */
export type CoverageFormat = 'lcov' | 'cobertura' | 'go-cover' | 'istanbul-json'

/** What one instrumented unit is. */
export type CoverageMetric = 'lines' | 'statements'

/** One instrumented unit and how often it ran. */
export interface CoveredSpan {
    /** First line of the unit (1-based, inclusive). */
    start: number
    /** Last line of the unit (inclusive); equals `start` for line-based reports. */
    end: number
    /** Execution count (`> 0` = hit). */
    hits: number
}

/** One file's coverage. */
export interface FileCoverage {
    /** Workspace-relative path when it could be resolved, else the reported path. */
    path: string
    /** The path exactly as the report wrote it (for diagnosing a mismatch). */
    reportedPath: string
    /** Instrumented units, sorted by `(start, end)`, duplicates merged. */
    spans: CoveredSpan[]
    /** Instrumented units the report counted (`LF`-style aggregate). */
    linesFound: number
    /** Units that ran at least once (`LH`-style aggregate). */
    linesHit: number
    /** What `linesFound`/`linesHit` count. */
    metric: CoverageMetric
    /** The reported path resolves outside the workspace. */
    outsideWorkspace?: boolean
    /** The report listed the file but instruments nothing in it. */
    empty?: boolean
}

/** Aggregate of one report. */
export interface CoverageTotals {
    linesFound: number
    linesHit: number
}

/** A parsed report. */
export interface CoverageReport {
    format: CoverageFormat
    metric: CoverageMetric
    /** Files, sorted by path. */
    files: FileCoverage[]
    totals: CoverageTotals
    /** Files the report listed with no instrumented unit (they cannot be judged). */
    emptyFiles: string[]
    /** Honest caveats the parser wants on the record. */
    notes: string[]
}

/**
 * The result of {@link parseCoverage}: the report itself (flattened, so
 * `result.files` / `result.totals` read the way the caller expects), or why
 * there is none.
 */
export type CoverageParseResult = ({ ok: true } & CoverageReport) | { ok: false; problem: string }

/** Options for {@link parseCoverage}. */
export interface ParseCoverageOptions {
    /** Workspace root, used to make reported paths workspace-relative. */
    cwd?: string
    /** Requested format (`auto` sniffs; an unknown value is refused). */
    format?: string
}

/** Normalise a reported path: POSIX separators, no leading `./`. */
function toPosix(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Resolve one reported path against the workspace. */
export function resolveReportedPath(
    raw: string,
    cwd?: string,
): { path: string; outsideWorkspace: boolean } {
    const cleaned = toPosix(raw.trim().replace(/^["']|["']$/g, ''))
    if (cleaned === '' || cleaned === '/dev/null') return { path: cleaned, outsideWorkspace: false }
    if (!path.isAbsolute(cleaned)) {
        const normalised = path.posix.normalize(cleaned)
        return { path: normalised, outsideWorkspace: normalised.startsWith('../') }
    }
    if (cwd === undefined) return { path: cleaned, outsideWorkspace: true }
    const relative = path.relative(cwd, cleaned).split(path.sep).join('/')
    if (relative === '' || relative.startsWith('..')) return { path: cleaned, outsideWorkspace: true }
    return { path: relative, outsideWorkspace: false }
}

/** Merge spans of one file into a deterministic, duplicate-free list. */
export function mergeSpans(spans: readonly CoveredSpan[]): CoveredSpan[] {
    const byKey = new Map<string, CoveredSpan>()
    for (const span of spans) {
        const start = Math.min(span.start, span.end)
        const end = Math.max(span.start, span.end)
        const key = `${start}:${end}`
        const existing = byKey.get(key)
        // A line hit by two records (merged lcov reports) ran at least the sum;
        // `max` keeps the value bounded and deterministic.
        if (existing === undefined || span.hits > existing.hits) byKey.set(key, { start, end, hits: span.hits })
    }
    return [...byKey.values()].sort((left, right) => left.start - right.start || left.end - right.end)
}

/** Whether a span covers a line. */
function covers(span: CoveredSpan, line: number): boolean {
    return line >= span.start && line <= span.end
}

/** Percentage, or `undefined` when the denominator is zero (never 0%, never 100%). */
export function percentOf(hit: number, found: number): number | undefined {
    if (found <= 0) return undefined
    return (hit / found) * 100
}

/** One file entry under construction inside a parser. */
interface FileDraft {
    reportedPath: string
    spans: CoveredSpan[]
    /** `LF`/`LH` aggregates when the format carries them. */
    declaredFound?: number
    declaredHit?: number
}

/**
 * Turn drafts into sorted {@link FileCoverage} entries, merging duplicates.
 *
 * `aggregate` picks what the per-file totals mean, and it differs per format on
 * purpose: a line-based report (lcov/cobertura) is judged from its `DA`/`<line>`
 * detail, while a statement-based one (go-cover/istanbul) carries its own
 * aggregate (`numStmt` sum / statement count) that the detail must not override —
 * counting blocks as lines would silently change the metric.
 */
function finalise(
    drafts: Map<string, FileDraft>,
    cwd: string | undefined,
    metric: CoverageMetric,
    aggregate: 'detail' | 'declared',
): {
    files: FileCoverage[]
    totals: CoverageTotals
    notes: string[]
} {
    const files: FileCoverage[] = []
    const notes: string[] = []
    for (const draft of [...drafts.values()].sort((left, right) =>
        left.reportedPath.localeCompare(right.reportedPath),
    )) {
        const resolved = resolveReportedPath(draft.reportedPath, cwd)
        const spans = mergeSpans(draft.spans)
        const detailFound = spans.length
        const detailHit = spans.filter((span) => span.hits > 0).length
        const found =
            aggregate === 'detail' && detailFound > 0 ? detailFound : (draft.declaredFound ?? detailFound)
        const hit = aggregate === 'detail' && detailFound > 0 ? detailHit : (draft.declaredHit ?? detailHit)
        if (draft.declaredFound !== undefined && detailFound > 0 && draft.declaredFound !== detailFound) {
            notes.push(
                `${draft.reportedPath}: 报告的合计 ${draft.declaredFound} 与明细条数 ${detailFound} 不一致（逐行判定用明细，汇总用报告的合计）`,
            )
        }
        if (draft.declaredFound === undefined && detailFound === 0) {
            notes.push(`${draft.reportedPath}: 报告里没有任何被插桩的单元，该文件无法判定`)
        }
        files.push({
            path: resolved.path,
            reportedPath: draft.reportedPath,
            spans,
            linesFound: found,
            linesHit: Math.min(hit, found),
            metric,
            ...(resolved.outsideWorkspace ? { outsideWorkspace: true } : {}),
            ...(spans.length === 0 && found === 0 ? { empty: true } : {}),
        })
    }
    files.sort((left, right) => left.path.localeCompare(right.path) || left.reportedPath.localeCompare(right.reportedPath))
    const totals = files.reduce<CoverageTotals>(
        (sum, file) => ({ linesFound: sum.linesFound + file.linesFound, linesHit: sum.linesHit + file.linesHit }),
        { linesFound: 0, linesHit: 0 },
    )
    return { files, totals, notes }
}

// --- lcov -------------------------------------------------------------------

/**
 * Parse an lcov tracefile.
 *
 * `LF:`/`LH:` win when present (they are the tool's own aggregate); otherwise the
 * `DA:` rows are counted. A record with neither is not silently skipped — it is a
 * file with zero instrumented units, listed in `emptyFiles`.
 * @param text - the tracefile.
 * @param cwd - workspace root for path resolution.
 */
export function parseLcov(text: string, cwd?: string): CoverageReport | { problem: string } {
    const drafts = new Map<string, FileDraft>()
    const notes: string[] = []
    let current: FileDraft | undefined
    let sawRecord = false
    const flush = (): void => {
        if (current === undefined) return
        const existing = drafts.get(current.reportedPath)
        if (existing === undefined) {
            drafts.set(current.reportedPath, current)
        } else {
            existing.spans.push(...current.spans)
            existing.declaredFound = sumDefined(existing.declaredFound, current.declaredFound)
            existing.declaredHit = sumDefined(existing.declaredHit, current.declaredHit)
        }
        current = undefined
    }
    const lines = text.split('\n')
    for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.trim()
        if (line === '') continue
        if (line.startsWith('SF:')) {
            flush()
            const target = line.slice(3).trim()
            if (target === '') return { problem: `lcov: 第 ${index + 1} 行的 SF: 后面没有文件路径` }
            sawRecord = true
            current = { reportedPath: target, spans: [] }
            continue
        }
        if (line === 'end_of_record') {
            flush()
            continue
        }
        if (line.startsWith('DA:')) {
            if (current === undefined) return { problem: `lcov: 第 ${index + 1} 行的 DA: 出现在任何 SF: 之前` }
            const parts = line.slice(3).split(',')
            const lineNumber = Number.parseInt((parts[0] ?? '').trim(), 10)
            const hits = Number.parseInt((parts[1] ?? '').trim(), 10)
            if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !Number.isInteger(hits) || hits < 0) {
                return { problem: `lcov: 第 ${index + 1} 行的 DA: 格式非法（应为 "DA:<行号>,<命中次数>"）：${line}` }
            }
            current.spans.push({ start: lineNumber, end: lineNumber, hits })
            continue
        }
        if (line.startsWith('LF:') || line.startsWith('LH:')) {
            if (current === undefined) return { problem: `lcov: 第 ${index + 1} 行的 ${line.slice(0, 2)} 出现在任何 SF: 之前` }
            const value = Number.parseInt(line.slice(3).trim(), 10)
            if (!Number.isInteger(value) || value < 0) {
                return { problem: `lcov: 第 ${index + 1} 行的 ${line.slice(0, 2)} 不是非负整数：${line}` }
            }
            if (line.startsWith('LF:')) current.declaredFound = value
            else current.declaredHit = value
            continue
        }
        // TN/FN/FNDA/BRDA/BRF/BRH/FNF/FNH/VER: not needed for line coverage.
    }
    flush()
    if (!sawRecord) {
        return { problem: 'lcov: 报告里没有任何 "SF:" 记录（是不是把别的格式按 lcov 解析了？）' }
    }
    const { files, totals } = finalise(drafts, cwd, 'lines', 'detail')
    return {
        format: 'lcov',
        metric: 'lines',
        files,
        totals,
        emptyFiles: files.filter((file) => file.empty === true).map((file) => file.path),
        notes,
    }
}

/** Sum two optional numbers, keeping `undefined` when both are absent. */
function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return left + right
}

// --- cobertura --------------------------------------------------------------

/** Parse the attributes of one XML start tag. */
function attributesOf(tag: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
        attributes[match[1] as string] = match[2] as string
    }
    return attributes
}

/**
 * Parse a cobertura XML report.
 * @param text - the XML.
 * @param cwd - workspace root for path resolution.
 */
export function parseCobertura(text: string, cwd?: string): CoverageReport | { problem: string } {
    const drafts = new Map<string, FileDraft>()
    const classPattern = /<class\b([^>]*)>([\s\S]*?)<\/class>/g
    let sawClass = false
    for (const match of text.matchAll(classPattern)) {
        const attributes = attributesOf(match[1] as string)
        const filename = attributes['filename'] ?? attributes['name']
        if (filename === undefined || filename.trim() === '') {
            return { problem: 'cobertura: <class> 缺少 filename 属性（无法知道覆盖的是哪个文件）' }
        }
        sawClass = true
        const draft = drafts.get(filename) ?? { reportedPath: filename, spans: [] }
        drafts.set(filename, draft)
        const body = match[2] as string
        for (const lineMatch of body.matchAll(/<line\b([^>]*?)\/?>/g)) {
            const lineAttributes = attributesOf(lineMatch[1] as string)
            const number = Number.parseInt(lineAttributes['number'] ?? '', 10)
            const hits = Number.parseInt(lineAttributes['hits'] ?? '', 10)
            if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(hits) || hits < 0) {
                return {
                    problem: `cobertura: ${filename} 的 <line> 缺少合法的 number/hits 属性：<line${lineMatch[1] ?? ''}>`,
                }
            }
            draft.spans.push({ start: number, end: number, hits })
        }
    }
    if (!sawClass) {
        if (/<line\b/.test(text)) {
            return { problem: 'cobertura: 找到了 <line> 但没有 <class filename=…> 包裹（本插件按 class 归属文件，无法归属的行不会猜）' }
        }
        return { problem: 'cobertura: 报告里没有任何 <class filename=…> 元素（是不是把别的格式按 cobertura 解析了？）' }
    }
    const { files, totals, notes } = finalise(drafts, cwd, 'lines', 'detail')
    if (files.length > 0 && files.every((file) => file.spans.length === 0)) {
        return { problem: 'cobertura: 所有 <class> 都没有 <line> 明细（只有汇总数字的报告无法做逐行判定）' }
    }
    return {
        format: 'cobertura',
        metric: 'lines',
        files,
        totals,
        emptyFiles: files.filter((file) => file.empty === true).map((file) => file.path),
        notes,
    }
}

// --- go cover profile -------------------------------------------------------

/** `path:startLine.startCol,endLine.endCol numStmt count`. */
const GO_COVER_ROW = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/

/**
 * Parse a Go cover profile.
 *
 * The metric is `statements` (the format counts statement blocks, `numStmt`),
 * and `spans` carry the block ranges so incremental coverage can still tell
 * which ADDED lines are instrumented. Row order is irrelevant (and sorted here),
 * so a merge of several profiles parses the same way.
 * @param text - the profile.
 * @param cwd - workspace root for path resolution.
 */
export function parseGoCover(text: string, cwd?: string): CoverageReport | { problem: string } {
    const lines = text.split('\n')
    const first = lines.find((line) => line.trim() !== '')
    if (first === undefined) return { problem: 'go-cover: 报告为空' }
    if (!first.trim().startsWith('mode:')) {
        return { problem: `go-cover: 第一行必须是 "mode: set|count|atomic"（收到 ${JSON.stringify(first.trim())}）` }
    }
    const mode = first.trim().slice('mode:'.length).trim()
    if (!['set', 'count', 'atomic'].includes(mode)) {
        return { problem: `go-cover: 不认识的 mode "${mode}"（应为 set / count / atomic）` }
    }
    const drafts = new Map<string, FileDraft>()
    const notes: string[] = []
    const declared = new Map<string, { found: number; hit: number }>()
    for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.trim()
        if (line === '' || line.startsWith('mode:')) continue
        const match = GO_COVER_ROW.exec(line)
        if (match === null) {
            return { problem: `go-cover: 第 ${index + 1} 行的数据格式非法（应为 "path:startLine.startCol,endLine.endCol numStmt count"）：${line}` }
        }
        const reportedPath = match[1] as string
        const startLine = Number.parseInt(match[2] as string, 10)
        const endLine = Number.parseInt(match[4] as string, 10)
        const statements = Number.parseInt(match[6] as string, 10)
        const count = Number.parseInt(match[7] as string, 10)
        if (startLine <= 0 || endLine < startLine) {
            return { problem: `go-cover: 第 ${index + 1} 行的行号区间非法：${line}` }
        }
        const draft = drafts.get(reportedPath) ?? { reportedPath, spans: [] }
        drafts.set(reportedPath, draft)
        draft.spans.push({ start: startLine, end: endLine, hits: count })
        const totals = declared.get(reportedPath) ?? { found: 0, hit: 0 }
        totals.found += statements
        if (count > 0) totals.hit += statements
        declared.set(reportedPath, totals)
    }
    if (drafts.size === 0) return { problem: 'go-cover: 只有 mode 行，没有任何覆盖率数据行' }
    for (const [reportedPath, draft] of drafts) {
        const totals = declared.get(reportedPath)
        if (totals !== undefined) {
            draft.declaredFound = totals.found
            draft.declaredHit = totals.hit
        }
    }
    const { files, totals, notes: parseNotes } = finalise(drafts, cwd, 'statements', 'declared')
    notes.push(
        `go-cover: 覆盖率单位是语句块（numStmt，${mode} 模式），不是行；与逐行插桩的工具（lcov/cobertura）的数字不可直接比较`,
        ...parseNotes,
    )
    return {
        format: 'go-cover',
        metric: 'statements',
        files,
        totals,
        emptyFiles: files.filter((file) => file.empty === true).map((file) => file.path),
        notes,
    }
}

// --- istanbul JSON ----------------------------------------------------------

/**
 * Parse an istanbul `coverage-final.json` report.
 *
 * The metric is `statements` (`statementMap` + `s`); a report that only carries
 * the line-hit map (`l`) is accepted with a note, because its per-line spans are
 * unavailable and incremental coverage must then say "cannot judge" instead of
 * inventing ranges.
 * @param text - the JSON.
 * @param cwd - workspace root for path resolution.
 */
export function parseIstanbulJson(text: string, cwd?: string): CoverageReport | { problem: string } {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        return { problem: `istanbul-json: JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { problem: 'istanbul-json: 顶层必须是对象（形如 {"/abs/path": {statementMap, s}}）' }
    }
    const drafts = new Map<string, FileDraft>()
    const notes: string[] = []
    let lineOnlyFiles = 0
    const entries = Object.entries(parsed as Record<string, unknown>).sort((left, right) => left[0].localeCompare(right[0]))
    if (entries.length === 0) return { problem: 'istanbul-json: 报告里没有任何文件条目' }
    for (const [reportedPath, value] of entries) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return { problem: `istanbul-json: "${reportedPath}" 的值不是对象（无法读出 statementMap/s）` }
        }
        const entry = value as Record<string, unknown>
        const statementMap = entry['statementMap']
        const hits = entry['s']
        const draft: FileDraft = { reportedPath, spans: [] }
        if (statementMap !== undefined) {
            if (typeof statementMap !== 'object' || statementMap === null || Array.isArray(statementMap)) {
                return { problem: `istanbul-json: "${reportedPath}" 的 statementMap 不是对象` }
            }
            if (typeof hits !== 'object' || hits === null || Array.isArray(hits)) {
                return { problem: `istanbul-json: "${reportedPath}" 有 statementMap 但缺少命中表 s` }
            }
            const hitMap = hits as Record<string, unknown>
            let found = 0
            let hit = 0
            for (const [key, location] of Object.entries(statementMap as Record<string, unknown>)) {
                if (typeof location !== 'object' || location === null) {
                    return { problem: `istanbul-json: "${reportedPath}" 的 statementMap["${key}"] 不是对象` }
                }
                const start = (location as { start?: { line?: unknown } }).start
                const end = (location as { end?: { line?: unknown } }).end
                const startLine = typeof start?.line === 'number' ? start.line : Number.NaN
                const endLine = typeof end?.line === 'number' ? end.line : startLine
                if (!Number.isFinite(startLine) || startLine <= 0) {
                    return { problem: `istanbul-json: "${reportedPath}" 的 statementMap["${key}"] 缺少 start.line` }
                }
                if (!Object.prototype.hasOwnProperty.call(hitMap, key)) {
                    return { problem: `istanbul-json: "${reportedPath}" 的 s 缺少语句 "${key}" 的命中次数（无法判定它是否被执行）` }
                }
                const count = hitMap[key]
                if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
                    return { problem: `istanbul-json: "${reportedPath}" 的 s["${key}"] 不是非负数字（收到 ${JSON.stringify(count)}）` }
                }
                draft.spans.push({ start: startLine, end: Number.isFinite(endLine) ? endLine : startLine, hits: count })
                found += 1
                if (count > 0) hit += 1
            }
            draft.declaredFound = found
            draft.declaredHit = hit
            drafts.set(reportedPath, draft)
            continue
        }
        const lineHits = entry['l']
        if (typeof lineHits === 'object' && lineHits !== null && !Array.isArray(lineHits)) {
            const values = Object.values(lineHits as Record<string, unknown>)
            if (values.some((count) => typeof count !== 'number' || !Number.isFinite(count))) {
                return { problem: `istanbul-json: "${reportedPath}" 的 l 含非数字命中次数` }
            }
            lineOnlyFiles += 1
            draft.declaredFound = values.length
            draft.declaredHit = values.filter((count) => (count as number) > 0).length
            drafts.set(reportedPath, draft)
            continue
        }
        return { problem: `istanbul-json: "${reportedPath}" 既没有 statementMap/s 也没有 l（无法解析）` }
    }
    if (lineOnlyFiles > 0) {
        notes.push(
            `${lineOnlyFiles} 个文件只有行命中数（l）而没有 statementMap：汇总数字可用，但逐行范围不可知，增量覆盖率对这些文件会给出"无法判定"`,
        )
    }
    const { files, totals, notes: parseNotes } = finalise(drafts, cwd, 'statements', 'declared')
    return {
        format: 'istanbul-json',
        metric: 'statements',
        files,
        totals,
        emptyFiles: files.filter((file) => file.empty === true).map((file) => file.path),
        notes: [...notes, ...parseNotes],
    }
}

// --- dispatch ---------------------------------------------------------------

/**
 * Sniff the format of a report.
 * @param text - the report text.
 * @returns the detected format, or `undefined`.
 */
export function detectFormat(text: string): CoverageFormat | undefined {
    const trimmed = text.trimStart()
    if (trimmed === '') return undefined
    if (trimmed.startsWith('{')) return 'istanbul-json'
    const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
    if (firstLine.startsWith('mode:')) return 'go-cover'
    if (/<class\b/.test(text) || /<coverage\b/.test(text)) return 'cobertura'
    if (/^\s*SF:/m.test(text)) return 'lcov'
    return undefined
}

/**
 * Parse a coverage report.
 *
 * An unknown format, an empty report or a malformed row returns `{ok:false}` with
 * the parser's complaint — never an empty success, because "0 files parsed" and
 * "0% covered" must not be the same verdict.
 * @param text - the report text.
 * @param options - requested format (`auto` by default) and the workspace root.
 */
export function parseCoverage(
    text: string,
    formatOrOptions: ReportFormat | ParseCoverageOptions = {},
): CoverageParseResult {
    // `parseCoverage(text, 'lcov')` and `parseCoverage(text, { format, cwd })` are
    // both accepted: the second argument is the format in the common case.
    const options: ParseCoverageOptions = typeof formatOrOptions === 'string' ? { format: formatOrOptions } : formatOrOptions
    const requested = options.format ?? 'auto'
    if (!['auto', 'lcov', 'cobertura', 'go-cover', 'istanbul-json'].includes(requested)) {
        return { ok: false, problem: `未知的报告格式 "${requested}"（可用：auto, lcov, cobertura, go-cover, istanbul-json）` }
    }
    if (text.trim() === '') return { ok: false, problem: '覆盖率报告为空（0 字节或只有空白）' }
    let format: CoverageFormat
    if (requested === 'auto') {
        const detected = detectFormat(text)
        if (detected === undefined) {
            return {
                ok: false,
                problem:
                    'auto 无法识别报告格式：支持 lcov（SF:/DA:）、cobertura（<class filename=…><line …>）、go-cover（mode: + 数据行）、istanbul-json（{"/path": {statementMap, s}}）。请在配置里显式设置 reportFormat。',
            }
        }
        format = detected
    } else {
        format = requested as CoverageFormat
    }
    const parsed =
        format === 'lcov'
            ? parseLcov(text, options.cwd)
            : format === 'cobertura'
              ? parseCobertura(text, options.cwd)
              : format === 'go-cover'
                ? parseGoCover(text, options.cwd)
                : parseIstanbulJson(text, options.cwd)
    if ('problem' in parsed) return { ok: false, problem: parsed.problem }
    return { ok: true, ...parsed }
}

// --- incremental judgement --------------------------------------------------

/** One added-line range, kept as `[start, end]` inclusive. */
export type LineRange = [number, number]

/** The per-file outcome of the incremental judgement. */
export interface ChangedFileCoverage {
    /** Workspace-relative path from the diff. */
    path: string
    /** How the diff classified the file. */
    status: ChangedFile['status']
    /** Lines the change added to this file. */
    addedLines: number
    /** Added lines the report instruments. */
    instrumented: number
    /** Instrumented added lines that ran at least once. */
    hit: number
    /** Instrumented added lines that never ran. */
    missed: number
    /** The missed line numbers, sorted. */
    missedLines: number[]
    /** Added line ranges the report does not instrument (they cannot be judged). */
    uninstrumentedRanges: LineRange[]
    /** Why this file could not be judged at all, when it could not. */
    problem?: string
}

/** The aggregate of {@link incrementalCoverage}. */
export interface IncrementalCoverage {
    /** Per-file outcomes, sorted by path. */
    files: ChangedFileCoverage[]
    totals: {
        addedLines: number
        instrumented: number
        hit: number
        missed: number
        /** Added lines no report instruments (`addedLines - instrumented`). */
        uninstrumented: number
    }
    /** Changed files the report never mentions. */
    missing: string[]
    /** Files present in the report but without per-line detail. */
    withoutDetail: string[]
    /** `complete` only when every changed file with added lines was judged. */
    judgement: 'complete' | 'partial'
    /** `true` when the diff had no added lines at all. */
    empty: boolean
    /** Honest caveats. */
    notes: string[]
}

/** Expand inclusive ranges into a sorted, duplicate-free line list (bounded). */
export function expandRanges(ranges: readonly LineRange[], limit = 200_000): { lines: number[]; truncated: boolean } {
    const set = new Set<number>()
    let truncated = false
    for (const [start, end] of ranges) {
        for (let line = Math.max(1, start); line <= end; line += 1) {
            if (set.size >= limit) {
                truncated = true
                break
            }
            set.add(line)
        }
        if (truncated) break
    }
    return { lines: [...set].sort((left, right) => left - right), truncated }
}

/** Compress a sorted line list into inclusive ranges. */
export function compressLines(lines: readonly number[]): LineRange[] {
    const ranges: LineRange[] = []
    for (const line of [...lines].sort((left, right) => left - right)) {
        const last = ranges[ranges.length - 1]
        if (last !== undefined && line === last[1] + 1) last[1] = line
        else ranges.push([line, line])
    }
    return ranges
}

/**
 * Find the coverage entry for one changed file.
 *
 * Exact workspace-relative match first. When that misses, a **unique** suffix
 * match is tried, because Go cover profiles name files by import path
 * (`example.com/mod/internal/a.go`) while the diff names them relative to the
 * repository (`internal/a.go`). An ambiguous match is reported, never guessed.
 */
export function matchReportedFile(
    report: CoverageReport,
    changedPath: string,
): { file?: FileCoverage; via?: 'exact' | 'suffix'; ambiguous?: string[] } {
    const exact = report.files.filter((file) => file.path === changedPath)
    if (exact.length > 0) return { file: exact[0] as FileCoverage, via: 'exact' }
    const suffix = `/${changedPath}`
    const candidates = report.files.filter(
        (file) => file.path.endsWith(suffix) || file.reportedPath.endsWith(suffix) || file.path === changedPath,
    )
    if (candidates.length === 1) return { file: candidates[0] as FileCoverage, via: 'suffix' }
    if (candidates.length > 1) return { ambiguous: candidates.map((file) => file.reportedPath).sort() }
    return {}
}

/**
 * Judge the lines this change added.
 *
 * Only lines the report instruments are counted; everything else is reported as
 * unjudgeable. A file the report never mentions, a report without per-line
 * detail and an ambiguous path match all end up in `missing`/`withoutDetail` or
 * in the file's `problem`, and the aggregate `judgement` becomes `partial` — the
 * caller may not read a partial judgement as a pass.
 * @param report - a parsed coverage report.
 * @param changed - the diff's changed files (see `dsh-eng-core`'s `changedRanges`).
 */
export function incrementalCoverage(report: CoverageReport, changed: readonly ChangedFile[]): IncrementalCoverage {
    const files: ChangedFileCoverage[] = []
    const missing: string[] = []
    const withoutDetail: string[] = []
    const notes: string[] = []
    let addedLines = 0
    let instrumented = 0
    let hit = 0
    let missed = 0

    for (const entry of [...changed].sort((left, right) => left.path.localeCompare(right.path))) {
        if (entry.status === 'deleted') {
            files.push({
                path: entry.path,
                status: entry.status,
                addedLines: 0,
                instrumented: 0,
                hit: 0,
                missed: 0,
                missedLines: [],
                uninstrumentedRanges: [],
                problem: '文件已删除：没有可判定的新增行（删除本身由 diff/评审看，不由覆盖率看）',
            })
            continue
        }
        const { lines, truncated } = expandRanges(entry.added)
        if (truncated) notes.push(`${entry.path}: 新增行过多，判定在 200000 行处截断`)
        addedLines += lines.length
        const match = matchReportedFile(report, entry.path)
        if (match.ambiguous !== undefined) {
            files.push({
                path: entry.path,
                status: entry.status,
                addedLines: lines.length,
                instrumented: 0,
                hit: 0,
                missed: 0,
                missedLines: [],
                uninstrumentedRanges: compressLines(lines),
                problem: `报告里有多个文件路径以它结尾，无法确定是哪一个：${match.ambiguous.join(', ')}`,
            })
            continue
        }
        const file = match.file
        if (file === undefined) {
            missing.push(entry.path)
            files.push({
                path: entry.path,
                status: entry.status,
                addedLines: lines.length,
                instrumented: 0,
                hit: 0,
                missed: 0,
                missedLines: [],
                uninstrumentedRanges: compressLines(lines),
                problem: '报告里没有这个文件：它的新增行没有被插桩，无法判定（不是 0%，也不是 100%）',
            })
            continue
        }
        if (file.spans.length === 0) {
            withoutDetail.push(entry.path)
            files.push({
                path: entry.path,
                status: entry.status,
                addedLines: lines.length,
                instrumented: 0,
                hit: 0,
                missed: 0,
                missedLines: [],
                uninstrumentedRanges: compressLines(lines),
                problem: '报告只给了这个文件的汇总数字，没有逐行明细：无法判定新增行',
            })
            continue
        }
        if (match.via === 'suffix') {
            notes.push(`${entry.path}: 通过唯一后缀匹配到报告中的 ${file.reportedPath}`)
        }
        const instrumentedLines: number[] = []
        const hitLines: number[] = []
        const missedLines: number[] = []
        const uninstrumentedLines: number[] = []
        for (const line of lines) {
            const span = file.spans.find((candidate) => covers(candidate, line))
            if (span === undefined) uninstrumentedLines.push(line)
            else {
                instrumentedLines.push(line)
                if (span.hits > 0) hitLines.push(line)
                else missedLines.push(line)
            }
        }
        instrumented += instrumentedLines.length
        hit += hitLines.length
        missed += missedLines.length
        files.push({
            path: entry.path,
            status: entry.status,
            addedLines: lines.length,
            instrumented: instrumentedLines.length,
            hit: hitLines.length,
            missed: missedLines.length,
            missedLines,
            uninstrumentedRanges: compressLines(uninstrumentedLines),
            ...(instrumentedLines.length === 0 && lines.length > 0
                ? { problem: '这个文件在报告里，但本次新增的行没有任何一行被插桩：无法判定（可能是注释/文档/未插桩的分支）' }
                : {}),
        })
    }

    // Every added line the report does not instrument is unjudgeable, and the
    // ledger must balance: instrumented + uninstrumented === addedLines.
    const uninstrumented = addedLines - instrumented
    if (addedLines === 0) notes.push('本次改动没有任何新增行（空 diff）：增量覆盖率无从判定')
    if (uninstrumented > 0) {
        notes.push(`${uninstrumented} 个新增行没有被报告插桩（注释、文档、未插桩的分支等）：它们不计入增量覆盖率，也无法被判定`)
    }
    if (missing.length > 0) notes.push(`${missing.length} 个改动文件没有出现在报告里：它们的新增行无法判定`)
    const judged = files.filter((file) => file.status !== 'deleted' && file.addedLines > 0)
    const judgement: IncrementalCoverage['judgement'] =
        judged.length > 0 && judged.every((file) => file.instrumented > 0) ? 'complete' : 'partial'
    return {
        files,
        totals: { addedLines, instrumented, hit, missed, uninstrumented },
        missing,
        withoutDetail,
        judgement,
        empty: addedLines === 0,
        notes,
    }
}

/** One worst-offender row. */
export interface WorstFile {
    path: string
    percent: number
    linesFound: number
    linesHit: number
}

/**
 * The least-covered instrumented files (the actionable end of a report).
 * @param report - a parsed report.
 * @param limit - how many rows to return.
 */
export function worstFiles(report: CoverageReport, limit = 5): WorstFile[] {
    return report.files
        .filter((file) => file.linesFound > 0)
        .map((file) => ({
            path: file.path,
            percent: (file.linesHit / file.linesFound) * 100,
            linesFound: file.linesFound,
            linesHit: file.linesHit,
        }))
        .sort(
            (left, right) =>
                left.percent - right.percent || right.linesFound - left.linesFound || left.path.localeCompare(right.path),
        )
        .slice(0, Math.max(0, limit))
}

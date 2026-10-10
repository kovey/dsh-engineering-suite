/**
 * The collectors: turning a repository into documents with a stable identity.
 *
 * Six sources, each with one job, and one rule that binds them all: **what a
 * collector does not index, it reports**. A binary file, an oversized file, an
 * unreadable file, a language the extractors do not understand, a ledger row
 * that does not parse, a mission whose artifact is missing — every one of them
 * becomes a `skipped` entry with a reason, because "the index has nothing about
 * X" and "the index silently never looked at X" are different answers and only
 * one of them is honest.
 *
 * Two conventions matter for the citations the whole plugin exists to produce:
 *
 *  - **File documents keep their line numbers.** A `spec`, `adr`, `docs` or
 *    `code` document is the file's own text, so `path:from-to` is a real line
 *    range of a real file.
 *  - **Derived documents say so.** A mission summary, a release row, a plan
 *    aggregate and an ADR index row are written by this plugin from the
 *    mission store and the ledgers; their `path` names the authoritative
 *    artifact but `from`/`to` are the summary's own lines. Every fact in them
 *    carries the file a reader can check it against, and their `docId` carries
 *    a discriminator (`#<mission>`, `#<version>`, `#<line>`) so two derived
 *    documents of one ledger can never share a chunk id.
 *
 * Mission state is read through `MissionStore` — the suite's own API — never by
 * hand-parsing `mission.json`. The two JSONL ledgers (`plan.jsonl`,
 * `releases.jsonl`) have no core API of their own, so they are read here with a
 * tolerant line reader that keeps each row's line number (which is what makes
 * `releases.jsonl:7` a usable citation).
 *
 * @module dsh-knowledge-base/sources
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    DEFAULT_MAX_FILES,
    MissionStore,
    exists,
    formatTime,
    globToRegExp,
    head,
    languageOf,
    listDir,
    pathMatchesPattern,
    readText,
    resolvePath,
    scanWorkspace,
    walkWorkspace,
    type CodeSymbol,
    type GateRecord,
    type Layout,
    type Logger,
    type MissionRecord,
    type Receipt,
} from 'dsh-eng-core'
import type { KbKind, KbSourceConfig } from './config.js'

/** One symbol attached to a document (a subset of core's `CodeSymbol`). */
export interface KbSymbol {
    name: string
    kind: string
    line: number
}

/** One collected document: what the indexer chunks and the search cites. */
export interface KbDocument {
    /** Stable id: `kind:path`, plus `#<discriminator>` for derived documents. */
    id: string
    kind: KbKind
    /** Workspace-relative citation path (`.dsh/...`, `docs/...`, `src/...`). */
    path: string
    title: string
    /** Newline-joined text; for file documents these ARE the file's lines. */
    text: string
    symbols?: KbSymbol[]
    /** `true` for documents this plugin wrote from the store/ledgers. */
    derived?: boolean
    /** Extra docs of one ledger file share a path; this keeps chunk ids unique. */
    discriminator?: string
}

/** One file (or ledger row) the collector did not fully cover, and why. */
export interface KbSkipped {
    path: string
    reason: string
}

/** What one source collected (filled in by the index store with chunk counts). */
export interface SourceReport {
    id: string
    kind: KbKind
    enabled: boolean
    documents: number
    chunks: number
    skipped: KbSkipped[]
    /** Human-readable notes: missing artifacts, conventions, coverage limits. */
    notes: string[]
    /** Set when the source's coverage was cut short (the index's own gap). */
    incomplete?: string
}

/** Inputs of {@link collectDocuments}. */
export interface CollectInput {
    cwd: string
    layout: Layout
    sources: readonly KbSourceConfig[]
    maxFileBytes: number
    /** Absolute index directory: its own files are never indexed. */
    indexDir: string
    logger?: Logger
}

/** Result of one collection pass. */
export interface CollectResult {
    documents: KbDocument[]
    reports: SourceReport[]
    /** `true` when the walk hit its file budget (`maxFiles`). */
    truncated: boolean
}

/** How many receipts one mission summary lists before it says what it dropped. */
export const RECEIPT_SUMMARY_LIMIT = 20
/** Longest gate reason kept in a mission summary. */
const GATE_REASON_CHARS = 120

// --- small helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** POSIX, workspace-relative spelling of an absolute path. */
function relativeOf(cwd: string, target: string): string {
    return path.relative(cwd, target).split(path.sep).join('/')
}

/** Binary (locale-independent) compare. */
function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/** A lazily-computed value (the walk and the symbol scan run at most once). */
function lazy<T>(compute: () => T): () => T {
    let done = false
    let value: T
    return () => {
        if (!done) {
            value = compute()
            done = true
        }
        return value
    }
}

/** The layout-relative prefix a `.dsh/`-anchored pattern resolves to. */
function rootPrefixOf(cwd: string, layout: Layout): string {
    const relative = relativeOf(cwd, layout.rootDir)
    return relative === '' ? '' : relative
}

/**
 * Rewrite a configured pattern against the resolved layout.
 *
 * A pattern that starts with `.dsh/` follows `layout.rootDir`: the profile may
 * relocate the engineering trail, and an index that kept looking in the literal
 * `.dsh` directory would report "no specifications" for a repository that has
 * plenty.
 */
export function effectivePatterns(source: KbSourceConfig, cwd: string, layout: Layout): string[] {
    const prefix = rootPrefixOf(cwd, layout)
    return source.globs.map((pattern) =>
        pattern === '.dsh' ? prefix || '.' : pattern.startsWith('.dsh/') ? (prefix === '' ? pattern.slice(5) : `${prefix}/${pattern.slice(5)}`) : pattern,
    )
}

/** Whether one workspace-relative path is inside a source's declared coverage. */
function covered(source: KbSourceConfig, cwd: string, layout: Layout, relativePath: string): boolean {
    return effectivePatterns(source, cwd, layout).some((pattern) => pathMatchesPattern(pattern, relativePath))
}

/** Whether a path is inside a directory (or is it). */
function insideDir(target: string, relativePath: string): boolean {
    const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === '' || normalized === '.') return false
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`)
}

/** What reading one file for the index produced. */
type FileRead = { text: string } | { reason: string }

/**
 * Read a file that may be indexed, naming why it was not.
 *
 * The order matters: `stat` first (a 2 GiB file must never be read), then a NUL
 * scan on the raw bytes (a "markdown" file that is actually a JPEG decodes to
 * replacement characters and would otherwise be indexed as garbage), then the
 * UTF-8 decode.
 */
function readForIndex(absolute: string, maxFileBytes: number): FileRead {
    let size: number
    try {
        const stat = fs.statSync(absolute)
        if (!stat.isFile()) return { reason: 'not-a-file（不是普通文件）' }
        size = stat.size
    } catch (error) {
        return { reason: `unreadable（无法 stat：${error instanceof Error ? error.message : String(error)}）` }
    }
    if (size > maxFileBytes) return { reason: `oversized（${size} 字节 > 上限 ${maxFileBytes} 字节）` }
    let buffer: Buffer
    try {
        buffer = fs.readFileSync(absolute)
    } catch (error) {
        return { reason: `unreadable（读取失败：${error instanceof Error ? error.message : String(error)}）` }
    }
    if (buffer.includes(0)) return { reason: 'binary（含 NUL 字节）' }
    const text = buffer.toString('utf8')
    if (text.includes('\uFFFD')) return { reason: 'binary（不是合法 UTF-8）' }
    return { text }
}

/** One JSONL row plus the 1-based line it came from. */
interface LedgerRow {
    value: Record<string, unknown>
    line: number
}

/** What one tolerant JSONL read found. */
interface LedgerRead {
    file: string
    exists: boolean
    rows: LedgerRow[]
    /** Lines that did not become rows (a torn tail after a crash is expected). */
    unreadable: { line: number; reason: string }[]
}

/**
 * Read a JSONL ledger, keeping line numbers so a row stays citable.
 * @param file - absolute path of the ledger.
 */
function readLedger(file: string): LedgerRead {
    const text = readText(file)
    if (text === undefined) return { file, exists: false, rows: [], unreadable: [] }
    const rows: LedgerRow[] = []
    const unreadable: { line: number; reason: string }[] = []
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] as string).trim()
        if (line === '') continue
        try {
            const parsed: unknown = JSON.parse(line)
            if (isRecord(parsed)) rows.push({ value: parsed, line: index + 1 })
            else unreadable.push({ line: index + 1, reason: 'not-an-object（行不是 JSON 对象）' })
        } catch {
            unreadable.push({ line: index + 1, reason: 'unparsable（JSON 解析失败，可能是崩溃留下的半行）' })
        }
    }
    return { file, exists: true, rows, unreadable }
}

/** A string field of a ledger row, or `undefined`. */
function field(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined
}

/** A numeric field of a ledger row, or `undefined`. */
function numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A string list field of a ledger row. */
function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/**
 * Collapse a value that may contain newlines into one line.
 *
 * A derived summary is a list of facts, one per line: a gate reason or a ledger
 * note that carries newlines would otherwise split one fact across several
 * lines and make the summary's own line numbering impossible to follow.
 */
function oneLine(value: string, max: number): string {
    return head(value.replace(/\s*\n\s*/g, ' ').trim(), max)
}

/** The first Markdown heading of a document, when it has one. */
export function headingOf(text: string): string | undefined {
    for (const line of text.split('\n').slice(0, 40)) {
        const match = /^#\s+(.+?)\s*$/.exec(line)
        if (match !== null) return (match[1] as string).trim()
    }
    return undefined
}

// --- expansion --------------------------------------------------------------

/** A single directory listing matched against one glob's basename. */
function expandInDirectory(cwd: string, directory: string, basePattern: string): string[] {
    const regex = globToRegExp(basePattern)
    const names = listDir(path.join(cwd, directory))
    const out: string[] = []
    for (const name of names) {
        if (!regex.test(name)) continue
        const relative = directory === '.' ? name : `${directory}/${name}`
        try {
            if (!fs.statSync(path.join(cwd, relative)).isFile()) continue
        } catch {
            continue
        }
        out.push(relative)
    }
    return out.sort(compareText)
}

// --- the source context -----------------------------------------------------

interface Context {
    cwd: string
    layout: Layout
    maxFileBytes: number
    indexDirRelative: string
    logger?: Logger
    walk: () => { files: { rel: string }[]; truncated: boolean }
    symbols: () => Map<string, KbSymbol[]>
}

/**
 * Symbol extraction through core's existing extractors (go/ts/js/python only).
 *
 * This calls `scanWorkspace` rather than re-implementing the per-language
 * regexes: a second extractor would drift from the one the standards and impact
 * gates already measure with, and "the symbols come from the same place" is the
 * only claim this index can honestly make about code structure.
 */
function collectSymbols(cwd: string, logger: Logger | undefined, maxFileBytes: number): Map<string, KbSymbol[]> {
    const result = scanWorkspace({ cwd, maxFiles: DEFAULT_MAX_FILES, maxFileBytes, ...(logger === undefined ? {} : { logger }) })
    const byPath = new Map<string, KbSymbol[]>()
    for (const symbol of result.symbols as CodeSymbol[]) {
        const bucket = byPath.get(symbol.path) ?? []
        bucket.push({ name: symbol.name, kind: symbol.kind, line: symbol.line })
        byPath.set(symbol.path, bucket)
    }
    for (const bucket of byPath.values()) {
        bucket.sort((left, right) => left.line - right.line || compareText(left.name, right.name))
    }
    return byPath
}

/** Collect one file-backed source (spec, adr files, docs, code). */
function collectFiles(
    source: KbSourceConfig,
    context: Context,
    candidates: string[],
    options: { symbols: boolean },
): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[] } {
    const documents: KbDocument[] = []
    const skipped: KbSkipped[] = []
    const notes: string[] = []
    const symbolMap = options.symbols ? context.symbols() : new Map<string, KbSymbol[]>()
    let textOnly = 0
    for (const relative of candidates) {
        const read = readForIndex(path.join(context.cwd, relative), context.maxFileBytes)
        if ('reason' in read) {
            skipped.push({ path: relative, reason: read.reason })
            continue
        }
        const heading = headingOf(read.text)
        const base = path.posix.basename(relative)
        let symbols: KbSymbol[] | undefined
        if (options.symbols) {
            const language = languageOf(relative)
            if (language === undefined) {
                textOnly += 1
                skipped.push({
                    path: relative,
                    reason: 'unsupported-language（只做了文本索引，没有符号：现有提取器只支持 go/ts/js/python）',
                })
            } else {
                const extracted = symbolMap.get(relative)
                if (extracted !== undefined && extracted.length > 0) symbols = extracted
            }
        }
        documents.push({
            id: `${source.kind}:${relative}`,
            kind: source.kind,
            path: relative,
            title: options.symbols ? base : (heading ?? base),
            text: read.text,
            ...(symbols === undefined ? {} : { symbols }),
        })
    }
    if (textOnly > 0) notes.push(`${textOnly} 个文件的扩展名不在现有符号提取器支持的范围内：文本已索引，符号为空（见 skipped）`)
    return { documents, skipped, notes }
}

/** Resolve a source's file candidates from its patterns, reporting what nothing matched. */
function fileCandidates(source: KbSourceConfig, context: Context): { candidates: string[]; empty: string[] } {
    const candidates = new Set<string>()
    const empty: string[] = []
    for (const pattern of effectivePatterns(source, context.cwd, context.layout)) {
        if (!/[*?]/.test(pattern)) {
            if (exists(path.join(context.cwd, pattern)) && fs.statSync(path.join(context.cwd, pattern)).isFile()) candidates.add(pattern)
            else empty.push(pattern)
            continue
        }
        const directory = path.posix.dirname(pattern)
        const base = path.posix.basename(pattern)
        if (directory.includes('*')) {
            // A wildcard directory (a `docs/`-style recursive markdown pattern):
            // resolved from the
            // workspace walk, which is the only traversal that applies the
            // suite's ignore list (node_modules, .git, dist, …).
            let hit = false
            for (const file of context.walk().files) {
                if (!pathMatchesPattern(pattern, file.rel)) continue
                candidates.add(file.rel)
                hit = true
            }
            if (!hit) empty.push(pattern)
            continue
        }
        const found = expandInDirectory(context.cwd, directory, base)
        if (found.length === 0) empty.push(pattern)
        for (const relative of found) candidates.add(relative)
    }
    return { candidates: [...candidates].sort(compareText), empty }
}

// --- trail summaries --------------------------------------------------------

/** One line per source with its newest gate: the verdict a reader needs first. */
function gateLines(mission: MissionRecord, gates: readonly GateRecord[], cwd: string, layout: Layout): string[] {
    const newest = new Map<string, GateRecord>()
    for (const gate of gates) {
        const current = newest.get(gate.source)
        if (current === undefined || gate.checkedAt >= current.checkedAt) newest.set(gate.source, gate)
    }
    const lines: string[] = []
    for (const source of [...newest.keys()].sort(compareText)) {
        const gate = newest.get(source) as GateRecord
        const file = relativeOf(cwd, path.join(layout.missionsDir, mission.id, 'gates', `${gate.id}.json`))
        lines.push(`- ${gate.source} ${gate.id} ${gate.state} @ ${formatTime(gate.checkedAt)}：${oneLine(gate.reason, GATE_REASON_CHARS)}（${file}）`)
    }
    return lines
}

/** The receipt lines of one mission summary, plus what did not fit. */
function receiptLines(mission: MissionRecord, receipts: readonly Receipt[], cwd: string, layout: Layout): { lines: string[]; dropped: number } {
    const ordered = [...receipts].sort((left, right) => right.issuedAt - left.issuedAt || compareText(left.id, right.id))
    const kept = ordered.slice(0, RECEIPT_SUMMARY_LIMIT)
    const lines = kept.map((receipt) => {
        const file = receipt.path ?? relativeOf(cwd, path.join(layout.missionsDir, mission.id, 'receipts', `${receipt.id}.json`))
        return `- ${receipt.id} @ ${formatTime(receipt.issuedAt)} by ${receipt.issuedBy}；依据门禁 ${receipt.gateId}（${file}）`
    })
    return { lines, dropped: ordered.length - kept.length }
}

/** Render one mission's summary document. */
function missionSummary(mission: MissionRecord, gates: readonly GateRecord[], receipts: readonly Receipt[], cwd: string, layout: Layout, specText: string): string {
    const specPath = mission.specPath ?? relativeOf(cwd, path.join(layout.specsDir, `${mission.id}.md`))
    const lines: string[] = []
    lines.push(`mission ${mission.id}｜${mission.title}`)
    lines.push(`状态：${mission.status}；阶段：${mission.stage ?? '未进入'}；创建：${formatTime(mission.createdAt)}；更新：${formatTime(mission.updatedAt)}`)
    const spec = mission.spec
    if (spec === undefined) {
        // "No spec record" and "no specification" are different facts: the
        // artifact may exist (a hand-written file, or a record this summary
        // cannot see), and claiming it does not would be exactly the kind of
        // silent absence this plugin exists to prevent.
        lines.push(
            specText.trim() === ''
                ? `规格：未创建（没有 .dsh/specs/${mission.id}.md，mission 里也没有规格记录）`
                : `规格：mission 里没有规格记录，但 ${specPath} 存在（${specText.split('\n').length} 行）——正文以该文件为准，已由 spec 来源单独索引`,
        )
    } else {
        const approval =
            spec.approvedAt === undefined
                ? mission.approval === undefined
                    ? '未送审'
                    : `未通过（最近一次：${mission.approval.state === 'approved' ? '批准' : '拒绝'}，第 ${mission.approval.round} 轮）`
                : `已批准 @ ${formatTime(spec.approvedAt)} by ${spec.approvedBy ?? 'unknown'}`
        lines.push(`规格：${spec.title}｜revision ${spec.revision}｜审批：${approval}｜文件：${specPath}`)
        lines.push(`需求（${spec.requirements.length}）：${spec.requirements.map((requirement) => requirement.id).join(' ') || '（无）'}`)
        lines.push(`验收标准（${spec.acceptanceCriteria.length}）：${spec.acceptanceCriteria.map((criterion) => criterion.id).join(' ') || '（无）'}`)
        if (mission.specDigest !== undefined) lines.push(`规格指纹：${mission.specDigest}`)
    }
    const design = mission.testDesign
    if (design !== undefined) {
        lines.push(
            `测试设计：${design.cases.length} 条用例；未覆盖验收标准：${design.uncovered.length === 0 ? '无' : design.uncovered.join(' ')}；评审：${
                design.passed === true ? '通过' : design.passed === false ? '未通过' : '未评审'
            }`,
        )
    }
    const gateRows = gateLines(mission, gates, cwd, layout)
    if (gateRows.length > 0) {
        lines.push('门禁（每个来源最新一条）：')
        lines.push(...gateRows)
    } else {
        lines.push('门禁：无记录')
    }
    const receiptRows = receiptLines(mission, receipts, cwd, layout)
    if (receiptRows.lines.length > 0) {
        lines.push(`回执（最新 ${receiptRows.lines.length} 条）：`)
        lines.push(...receiptRows.lines)
    } else {
        lines.push('回执：无')
    }
    if (receiptRows.dropped > 0) lines.push(`另有 ${receiptRows.dropped} 条更早回执未列入（摘要上限 ${RECEIPT_SUMMARY_LIMIT} 条）`)
    return lines.join('\n')
}

/** Render one release row's summary document. */
function releaseSummary(row: Record<string, unknown>, line: number, file: string): string {
    const version = field(row['version']) ?? '（未记录版本）'
    const lines: string[] = []
    lines.push(`发布 ${version}（台账 ${file} 第 ${line} 行）`)
    lines.push(`标签：${field(row['tag']) ?? '未记录'}；记录于：${numberField(row['at']) === undefined ? '未记录' : formatTime(numberField(row['at']) as number)}`)
    const revision = isRecord(row['revision']) ? row['revision'] : undefined
    if (revision === undefined) {
        lines.push('revision：未记录（手工编辑或旧格式的行；不要把它当成"没有改动"）')
    } else if (revision['isRepo'] === false) {
        lines.push('revision：记录时不是 git 仓库')
    } else {
        const branch = field(revision['branch']) ?? 'detached'
        const head8 = (field(revision['head']) ?? 'no-commit').slice(0, 8)
        const changed = revision['dirty'] === true ? `+${String(revision['changedFiles'] ?? '?')} 改动` : 'clean'
        lines.push(`revision：${branch}@${head8} ${changed}`)
    }
    const missions = stringList(row['missionIds'])
    lines.push(`包含 mission（${missions.length}）：${missions.join(' ') || '（无）'}`)
    const receipts = stringList(row['receiptIds'])
    lines.push(`回执（${receipts.length}）：${receipts.join(' ') || '（无）'}`)
    if (field(row['notesPath']) !== undefined) lines.push(`发布说明：${field(row['notesPath']) as string}`)
    if (field(row['recordedBy']) !== undefined) lines.push(`记录人：${field(row['recordedBy']) as string}`)
    if (field(row['note']) !== undefined) lines.push(`备注：${oneLine(field(row['note']) as string, 400)}`)
    return lines.join('\n')
}

/** Render one mission's plan-ledger aggregate. */
function planSummary(missionId: string, rows: readonly LedgerRow[], file: string): string {
    const ordered = [...rows].sort((left, right) => (numberField(left.value['at']) ?? 0) - (numberField(right.value['at']) ?? 0) || left.line - right.line)
    const newest = ordered[ordered.length - 1] as LedgerRow
    const first = ordered[0] as LedgerRow
    const milestones = new Set<string>()
    const requirements = new Set<string>()
    const criteria = new Set<string>()
    const budgets = new Set<string>()
    const retired = new Set<string>()
    for (const row of ordered) {
        const milestone = field(row.value['milestone'])
        if (milestone !== undefined) milestones.add(milestone)
        for (const id of stringList(row.value['requirementIds'])) requirements.add(id)
        for (const id of stringList(row.value['criteriaIds'])) criteria.add(id)
        for (const id of stringList(row.value['budgetIds'])) budgets.add(id)
        for (const id of stringList(row.value['retiredRequirementIds'])) retired.add(id)
    }
    const lines: string[] = []
    lines.push(`规划台账：mission ${missionId}｜${field(newest.value['title']) ?? '（未记录标题）'}`)
    lines.push(`里程碑：${milestones.size === 0 ? '未记录' : [...milestones].sort(compareText).join(' ')}`)
    lines.push(`需求 id（${requirements.size}）：${[...requirements].sort(compareText).join(' ') || '（无）'}`)
    lines.push(`验收标准 id（${criteria.size}）：${[...criteria].sort(compareText).join(' ') || '（无）'}`)
    if (budgets.size > 0) lines.push(`非功能预算 id：${[...budgets].sort(compareText).join(' ')}`)
    if (retired.size > 0) lines.push(`已作废需求 id：${[...retired].sort(compareText).join(' ')}`)
    lines.push(`转换 ${ordered.length} 次；台账行：${first.line}-${newest.line}（${file}）`)
    lines.push(
        `最近转换：${field(newest.value['kind']) ?? '未记录'} @ ${
            numberField(newest.value['at']) === undefined ? '未记录时间' : formatTime(numberField(newest.value['at']) as number)
        }｜${oneLine(field(newest.value['summary']) ?? '（无摘要）', 400)}`,
    )
    if (field(newest.value['approvedBy']) !== undefined) lines.push(`最近批准人：${field(newest.value['approvedBy']) as string}`)
    return lines.join('\n')
}

// --- the collectors ---------------------------------------------------------

/** Collect one source. Returns the documents plus what it could not cover. */
function collectSource(source: KbSourceConfig, context: Context): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[]; incomplete?: string } {
    switch (source.kind) {
        case 'spec':
        case 'adr':
        case 'docs':
        case 'code':
            return collectPlainSource(source, context)
        case 'trail':
            return collectTrail(source, context)
        case 'plan':
            return collectPlan(source, context)
        default:
            return { documents: [], skipped: [], notes: [`未知来源类型 ${String(source.kind)}，未收集任何文档`], incomplete: `来源 ${source.id} 的 kind 不受支持` }
    }
}

/** spec / adr / docs / code: files selected by the source's patterns. */
function collectPlainSource(source: KbSourceConfig, context: Context): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[]; incomplete?: string } {
    const { candidates, empty } = fileCandidates(source, context)
    const kept: string[] = []
    const skipped: KbSkipped[] = []
    for (const relative of candidates) {
        if (insideDir(context.indexDirRelative, relative)) {
            skipped.push({ path: relative, reason: 'excluded-path（位于索引目录内，不能索引索引自己）' })
            continue
        }
        // A JSONL file under a markdown source (`adr/index.jsonl`) is not a
        // document of its own: its ROWS are, and indexing the raw file as well
        // would put a blob of JSON next to the facts derived from it.
        if (source.kind !== 'code' && !relative.endsWith('.md')) continue
        kept.push(relative)
    }
    const collected = collectFiles(source, context, kept, { symbols: source.kind === 'code' })
    const notes = [...collected.notes]
    if (empty.length > 0) {
        notes.push(
            `${empty.length} 个模式在本仓库没有匹配到文件：${empty.join(', ')}（如果这不是本意，检查 globs 或项目级覆盖是不是写错了）`,
        )
    }
    if (source.kind === 'adr') {
        const index = collectAdrIndex(source, context)
        collected.documents.push(...index.documents)
        skipped.push(...index.skipped)
        notes.push(...index.notes)
    }
    return {
        documents: collected.documents,
        skipped: [...skipped, ...collected.skipped],
        notes,
    }
}

/** The `adr/index.jsonl` rows: supersession state that the `.md` files never carry. */
function collectAdrIndex(source: KbSourceConfig, context: Context): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[] } {
    const documents: KbDocument[] = []
    const skipped: KbSkipped[] = []
    const notes: string[] = []
    const files = effectivePatterns(source, context.cwd, context.layout).filter((pattern) => pattern.endsWith('.jsonl'))
    for (const file of files) {
        const ledger = readLedger(path.join(context.cwd, file))
        if (!ledger.exists) continue
        for (const row of ledger.rows) {
            const number = numberField(row.value['number'])
            const target = field(row.value['path'])
            if (number === undefined || target === undefined) {
                skipped.push({ path: `${file}:${row.line}`, reason: 'incomplete-row（索引行缺少 number 或 path）' })
                continue
            }
            if (!exists(path.join(context.cwd, target))) {
                skipped.push({ path: target, reason: `missing-file（${file} 第 ${row.line} 行指向的决策文件不存在）` })
            }
            const lines: string[] = []
            lines.push(`ADR ${String(number).padStart(4, '0')}｜${field(row.value['title']) ?? '（未记录标题）'}（索引 ${file} 第 ${row.line} 行）`)
            lines.push(`文件：${target}`)
            if (field(row.value['missionId']) !== undefined) lines.push(`mission：${field(row.value['missionId']) as string}`)
            if (numberField(row.value['supersedes']) !== undefined) lines.push(`取代：ADR ${String(numberField(row.value['supersedes'])).padStart(4, '0')}`)
            lines.push(
                `状态：${
                    numberField(row.value['supersededBy']) === undefined
                        ? '未被取代（以索引行为准）'
                        : `已被 ADR ${String(numberField(row.value['supersededBy'])).padStart(4, '0')} 取代`
                }`,
            )
            if (numberField(row.value['at']) !== undefined) lines.push(`记录于：${formatTime(numberField(row.value['at']) as number)}`)
            documents.push({
                id: `adr:${file}#${number}`,
                kind: 'adr',
                path: file,
                title: `ADR ${String(number).padStart(4, '0')} ${field(row.value['title']) ?? ''}`.trim(),
                text: lines.join('\n'),
                derived: true,
                discriminator: `#${number}`,
            })
        }
        for (const bad of ledger.unreadable) skipped.push({ path: `${file}:${bad.line}`, reason: bad.reason })
        if (ledger.rows.length === 0 && ledger.unreadable.length === 0) notes.push(`${file} 为空：没有索引行可读（索引可从 adr/*.md 重建）`)
    }
    return { documents, skipped, notes }
}

/** trail: one summary per mission plus one per release, read through the store. */
function collectTrail(source: KbSourceConfig, context: Context): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[]; incomplete?: string } {
    const documents: KbDocument[] = []
    const skipped: KbSkipped[] = []
    const notes: string[] = []
    const store = new MissionStore({ layout: context.layout, ...(context.logger === undefined ? {} : { logger: context.logger }) })
    const missions = store.list().sort((left, right) => compareText(left.id, right.id))
    if (missions.length === 0) notes.push(`没有 mission 台账（${relativeOf(context.cwd, context.layout.missionsDir)} 下没有 mission.json）`)
    for (const mission of missions) {
        const file = relativeOf(context.cwd, path.join(context.layout.missionsDir, mission.id, 'mission.json'))
        if (!covered(source, context.cwd, context.layout, file)) continue
        const gates = store.readGates(mission.id)
        const receipts = store.readReceipts(mission.id)
        const text = missionSummary(mission, gates, receipts, context.cwd, context.layout, store.readSpec(mission.id))
        documents.push({
            id: `trail:${file}`,
            kind: 'trail',
            path: file,
            title: `mission ${mission.id}｜${mission.title}`,
            text,
            derived: true,
        })
        if (receipts.length > RECEIPT_SUMMARY_LIMIT) {
            skipped.push({
                path: file,
                reason: `summary-cap（${receipts.length} 条回执，摘要只列最新 ${RECEIPT_SUMMARY_LIMIT} 条；其余仍在 ${relativeOf(context.cwd, path.join(context.layout.missionsDir, mission.id, 'receipts'))}/ 下）`,
            })
        }
    }

    const releasePatterns = effectivePatterns(source, context.cwd, context.layout).filter((pattern) => pattern.endsWith('.jsonl'))
    for (const file of releasePatterns) {
        const ledger = readLedger(path.join(context.cwd, file))
        if (!ledger.exists) {
            notes.push(`${file} 不存在：发布台账还没有任何记录（由 dsh-evidence-gate 的 release_record 追加）`)
            continue
        }
        for (const row of ledger.rows) {
            const version = field(row.value['version']) ?? `line-${row.line}`
            documents.push({
                id: `trail:${file}#${row.line}`,
                kind: 'trail',
                path: file,
                title: `发布 ${version}`,
                text: releaseSummary(row.value, row.line, file),
                derived: true,
                discriminator: `#${row.line}`,
            })
        }
        for (const bad of ledger.unreadable) skipped.push({ path: `${file}:${bad.line}`, reason: bad.reason })
    }
    return { documents, skipped, notes }
}

/** plan: the planning ledger, aggregated per mission (ids → mission/milestone). */
function collectPlan(source: KbSourceConfig, context: Context): { documents: KbDocument[]; skipped: KbSkipped[]; notes: string[] } {
    const documents: KbDocument[] = []
    const skipped: KbSkipped[] = []
    const notes: string[] = []
    const files = effectivePatterns(source, context.cwd, context.layout).filter((pattern) => pattern.endsWith('.jsonl'))
    for (const file of files) {
        const ledger = readLedger(path.join(context.cwd, file))
        if (!ledger.exists) {
            notes.push(`${file} 不存在：没有规划台账（由 dsh-spec-gate 的 spec_create / spec_approve / spec_amend 追加）`)
            continue
        }
        const byMission = new Map<string, LedgerRow[]>()
        for (const row of ledger.rows) {
            const missionId = field(row.value['missionId'])
            if (missionId === undefined) {
                skipped.push({ path: `${file}:${row.line}`, reason: 'incomplete-row（规划行缺少 missionId）' })
                continue
            }
            const bucket = byMission.get(missionId) ?? []
            bucket.push(row)
            byMission.set(missionId, bucket)
        }
        for (const missionId of [...byMission.keys()].sort(compareText)) {
            const rows = byMission.get(missionId) as LedgerRow[]
            documents.push({
                id: `plan:${file}#${missionId}`,
                kind: 'plan',
                path: file,
                title: `规划台账 ${missionId}`,
                text: planSummary(missionId, rows, file),
                derived: true,
                discriminator: `#${missionId}`,
            })
        }
        for (const bad of ledger.unreadable) skipped.push({ path: `${file}:${bad.line}`, reason: bad.reason })
    }
    return { documents, skipped, notes }
}

/**
 * Collect every enabled source.
 *
 * The walk and the symbol scan are computed at most once per call, and only
 * when a source actually needs them — a build restricted to `spec` must not pay
 * for a repository-wide traversal.
 * @param input - workspace, layout, sources and bounds.
 * @returns the documents in (source, path) order plus one report per source.
 */
export function collectDocuments(input: CollectInput): CollectResult {
    const walk = lazy(() => {
        const result = walkWorkspace({
            cwd: input.cwd,
            maxFiles: DEFAULT_MAX_FILES,
            ...(input.logger === undefined ? {} : { logger: input.logger }),
        })
        return { files: result.files.map((file) => ({ rel: file.rel })), truncated: result.truncated }
    })
    const symbols = lazy(() => collectSymbols(input.cwd, input.logger, input.maxFileBytes))
    const indexDirRelative = relativeOf(input.cwd, input.indexDir)
    const context: Context = {
        cwd: input.cwd,
        layout: input.layout,
        maxFileBytes: input.maxFileBytes,
        indexDirRelative,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        walk,
        symbols,
    }

    const documents: KbDocument[] = []
    const reports: SourceReport[] = []
    for (const source of input.sources) {
        if (!source.enabled) {
            reports.push({ id: source.id, kind: source.kind, enabled: false, documents: 0, chunks: 0, skipped: [], notes: ['已在配置里停用（enabled=false），未索引任何文件'] })
            continue
        }
        const collected = collectSource(source, context)
        const skipped = [...collected.skipped].sort((left, right) => compareText(left.path, right.path) || compareText(left.reason, right.reason))
        reports.push({
            id: source.id,
            kind: source.kind,
            enabled: true,
            documents: collected.documents.length,
            chunks: 0,
            skipped,
            notes: collected.notes,
            ...(collected.incomplete === undefined ? {} : { incomplete: collected.incomplete }),
        })
        documents.push(...collected.documents)
    }
    // The walk's budget is a real coverage limit, but only a source that uses
    // the walk can be cut by it — a build restricted to `spec` must not force a
    // repository-wide traversal just to answer "were you truncated".
    const usesWalk = input.sources.some((source) => source.enabled && (source.kind === 'docs' || source.kind === 'code'))
    return { documents, reports, truncated: usesWalk ? walk().truncated : false }
}

/** Resolve a configured path (used by the tools for messages). */
export function resolveIndexPath(cwd: string, indexDir: string): string {
    return resolvePath(indexDir, cwd)
}

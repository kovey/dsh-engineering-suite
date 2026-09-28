/**
 * Architecture Decision Records: `adr_record` and `adr_list`.
 *
 * Decisions ("we chose X over Y because Z") used to live in chat logs and were
 * lost the moment the session ended — the alternatives, the reason, and the
 * person who could still explain it six months later. An ADR is the durable
 * form: one Markdown file per decision at `<rootDir>/adr/<NNNN>-<slug>.md`.
 *
 * Three rules, all of them the same fail-closed shape the rest of the suite uses:
 *
 *  - **append-only**: the next number is `max existing + 1` (never a gap filled,
 *    never an existing file rewritten), and a target path that already exists is
 *    a refusal, not an overwrite. A superseded ADR keeps its own text; the
 *    supersession is recorded as a NEW index row (`supersededBy`), so the file
 *    a human read last year still says what it said;
 *  - **the files are the record, the index is an index**: `index.jsonl` can be
 *    rebuilt from `adr/*.md`, so a failed index append is reported as a warning
 *    and never loses the decision itself;
 *  - **CJK titles are expected**: `slugify` drops everything non-ASCII, so a
 *    title with no usable characters falls back to a short hash instead of
 *    producing a nameless file.
 *
 * @module dsh-spec-gate/adr
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
    appendJsonl,
    ensureDir,
    exists,
    formatTime,
    listDir,
    readText,
    resolvePath,
    shortDigest,
    slugify,
    type Layout,
} from 'dsh-eng-core'
import type { SpecGateConfig } from './config.js'

/** Default ADR directory; the resolved path follows `layout.rootDir`. */
export const DEFAULT_ADR_DIR = '.dsh/adr'

/** Default ADR index; the resolved path follows `layout.rootDir`. */
export const DEFAULT_ADR_INDEX_FILE = '.dsh/adr/index.jsonl'

/** Longest slug kept from a title. */
export const ADR_SLUG_MAX = 48

/** One appended index row (the record is the `.md` file). */
export interface AdrIndexRow {
    at: number
    number: number
    slug: string
    /** Workspace-relative path of the ADR file. */
    path: string
    title: string
    missionId?: string
    supersedes?: number
    /**
     * Present only on the row appended when this number was superseded: the
     * superseded file is never rewritten, so the index carries the new state.
     */
    supersededBy?: number
}

/** One ADR read back from disk. */
export interface AdrRecord {
    number: number
    slug: string
    /** Absolute path. */
    file: string
    /** Workspace-relative path (what the index stores). */
    path: string
    title: string
    /** The `## 决定` chapter body (empty when the file has no such chapter). */
    decision: string
    missionId?: string
    supersedes?: number
    supersededBy?: number
    text: string
    /** `false` when the fenced JSON frontmatter was missing or unparsable. */
    metadataOk: boolean
}

/** The resolved ADR directory for one workspace. */
export function adrDirectory(layout: Layout, config: Pick<SpecGateConfig, 'adrDir'>): string {
    return config.adrDir === DEFAULT_ADR_DIR ? path.join(layout.rootDir, 'adr') : resolvePath(config.adrDir, layout.cwd)
}

/**
 * The resolved ADR index file for one workspace.
 *
 * The default lives INSIDE the resolved ADR directory, so overriding `adrDir`
 * does not leave the index behind in the default one.
 */
export function adrIndexPath(layout: Layout, config: Pick<SpecGateConfig, 'adrDir' | 'adrIndexFile'>): string {
    return config.adrIndexFile === DEFAULT_ADR_INDEX_FILE
        ? path.join(adrDirectory(layout, config), 'index.jsonl')
        : resolvePath(config.adrIndexFile, layout.cwd)
}

/**
 * A filename-safe slug for a title.
 *
 * `slugify` keeps ASCII letters/digits and collapses everything else, which
 * yields the empty string for a pure-CJK title — the common case here, not an
 * error case. Falling back to a short hash keeps the file addressable (and
 * stable for the same title) instead of producing `0001-.md`.
 * @param title - the submitted title.
 */
export function adrSlug(title: string): string {
    const slug = slugify(title, ADR_SLUG_MAX)
    return slug === '' ? `adr-${shortDigest(title, 8)}` : slug
}

/** 4-digit zero-padded number (`0007`). */
export function adrNumber(number: number): string {
    return String(number).padStart(4, '0')
}

/**
 * Create `file` with `text` only if nothing is there — EXCLUSIVELY.
 *
 * `existsSync` + temp + rename is not enough: `rename` overwrites, so two
 * `adr_record` calls that both computed `max(numbers) + 1` (the number is read
 * from the directory, then the file is written) would both "succeed" and the
 * second rename would silently replace the first decision document. The last
 * step here is `linkSync`, which fails with `EEXIST` when the target appeared in
 * between: the loser loses loudly and retries, and the retry recomputes the
 * number (the directory now has the winner's file).
 *
 * The temporary file is always removed; a hard link is only used inside the ADR
 * directory, so this needs nothing beyond a POSIX filesystem — the same
 * assumption `appendJsonl` already makes.
 * @param file - the target path (never overwritten).
 * @param text - the document body.
 * @returns `true` when this call created the file; `false` when it already existed.
 */
function writeAdrOnceExclusive(file: string, text: string): boolean {
    ensureDir(path.dirname(file))
    // The temp name must be unique per CALL, not per process-and-millisecond:
    // two concurrent calls in one process share both the pid and (often) the
    // millisecond, so a shared temp path lets one call's cleanup delete the
    // other's file — the loser then fails with a confusing ENOENT from link()
    // instead of the intended "number taken, retry" refusal. Caught by the
    // frozen verification run, not by the happy path.
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
    fs.writeFileSync(temporary, text)
    try {
        fs.linkSync(temporary, file)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
    } finally {
        try {
            fs.rmSync(temporary, { force: true })
        } catch {
            // The document is already in place; a leftover temp file is not worth
            // failing the call over.
        }
    }
}

/** Read the index; malformed/truncated lines are counted, never thrown. */
export function readAdrIndex(file: string): { file: string; exists: boolean; rows: AdrIndexRow[]; unparsable: number } {
    const text = readText(file)
    if (text === undefined) return { file, exists: false, rows: [], unparsable: 0 }
    const rows: AdrIndexRow[] = []
    let unparsable = 0
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            unparsable += 1
            continue
        }
        const value = parsed as Partial<AdrIndexRow>
        if (
            typeof value !== 'object' ||
            value === null ||
            typeof value.at !== 'number' ||
            typeof value.number !== 'number' ||
            typeof value.slug !== 'string' ||
            typeof value.path !== 'string' ||
            typeof value.title !== 'string'
        ) {
            unparsable += 1
            continue
        }
        rows.push(value as AdrIndexRow)
    }
    return { file, exists: true, rows, unparsable }
}

/** The `NNNN-slug.md` files present in the directory. */
export function listAdrFiles(dir: string): { number: number; slug: string; file: string }[] {
    const files: { number: number; slug: string; file: string }[] = []
    for (const name of listDir(dir)) {
        const match = /^(\d{4})-(\S+)\.md$/.exec(name)
        if (match === null) continue
        files.push({ number: Number.parseInt(match[1] as string, 10), slug: match[2] as string, file: path.join(dir, name) })
    }
    return files.sort((left, right) => left.number - right.number)
}

/** The first fenced ```json block of a document, parsed. */
function frontmatterOf(markdown: string): Record<string, unknown> | undefined {
    const match = /```json\s*\n([\s\S]*?)```/.exec(markdown)
    if (match === null) return undefined
    try {
        const parsed: unknown = JSON.parse(match[1] as string)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
    } catch {
        return undefined
    }
}

/** The body of one `## <heading>` chapter. */
function chapterOf(markdown: string, heading: string): string | undefined {
    const match = new RegExp(`^##\\s+${heading}\\s*$`, 'm').exec(markdown)
    if (match === null) return undefined
    const rest = markdown.slice(match.index + match[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next === null ? rest : rest.slice(0, next.index)).trim()
}

/**
 * Read every ADR of one workspace, newest number first.
 *
 * The supersession state is derived from BOTH signals on purpose: the
 * `supersededBy` index row (written when the superseding ADR was recorded) and
 * the superseding record's own `supersedes` field. The second one makes the
 * state survive a lost or hand-truncated index, which is the point of keeping
 * the files authoritative.
 */
export function listAdrRecords(layout: Layout, config: Pick<SpecGateConfig, 'adrDir' | 'adrIndexFile'>): {
    dir: string
    indexFile: string
    index: { exists: boolean; rows: AdrIndexRow[]; unparsable: number }
    records: AdrRecord[]
    /** Files the index mentions but the directory does not have. */
    missingFiles: number[]
} {
    const dir = adrDirectory(layout, config)
    const indexFile = adrIndexPath(layout, config)
    const index = readAdrIndex(indexFile)
    const files = listAdrFiles(dir)
    const records: AdrRecord[] = files.map((entry) => {
        const text = readText(entry.file) ?? ''
        const front = frontmatterOf(text)
        const row = [...index.rows].reverse().find((candidate) => candidate.number === entry.number)
        const title =
            typeof front?.['title'] === 'string' && front['title'] !== ''
                ? (front['title'] as string)
                : (/^#\s+\S+\s+(.*)$/m.exec(text)?.[1]?.trim() ?? row?.title ?? entry.slug)
        const missionId = typeof front?.['missionId'] === 'string' ? (front['missionId'] as string) : row?.missionId
        const supersedes = typeof front?.['supersedes'] === 'number' ? (front['supersedes'] as number) : row?.supersedes
        return {
            number: entry.number,
            slug: entry.slug,
            file: entry.file,
            path: path.relative(layout.cwd, entry.file) || entry.file,
            title,
            decision: chapterOf(text, '决定') ?? '',
            ...(missionId === undefined ? {} : { missionId }),
            ...(supersedes === undefined ? {} : { supersedes }),
            text,
            metadataOk: front !== undefined,
        }
    })
    // Supersession: the newest signal wins (a later ADR superseding the same one).
    for (const record of records) {
        const candidates: number[] = []
        for (const row of index.rows) {
            if (row.number === record.number && row.supersededBy !== undefined) candidates.push(row.supersededBy)
        }
        for (const candidate of records) {
            if (candidate.supersedes === record.number) candidates.push(candidate.number)
        }
        const newest = candidates.sort((left, right) => right - left)[0]
        if (newest !== undefined && newest !== record.number) record.supersededBy = newest
    }
    const known = new Set(records.map((record) => record.number))
    const missingFiles = [...new Set(index.rows.map((row) => row.number))].filter((number) => !known.has(number)).sort((left, right) => left - right)
    return { dir, indexFile, index, records: records.sort((left, right) => right.number - left.number), missingFiles }
}

/** What the model supplies when recording a decision. */
export interface AdrRequest {
    title: string
    decision: string
    alternatives?: string
    consequences?: string
    missionId?: string
    supersedes?: number
}

/** Everything `adr_record` needs. */
export interface AdrDeps {
    layout: Layout
    config: Pick<SpecGateConfig, 'adrDir' | 'adrIndexFile' | 'planFile'>
    now?: number
}

/** Outcome of one recorded decision. */
export type AdrOutcome =
    | {
          ok: true
          number: number
          slug: string
          file: string
          relativePath: string
          title: string
          superseded?: number
          warnings: string[]
          markdown: string
      }
    | { ok: false; problem: string; nextSteps?: string }

/** One `## <heading>` chapter with the suite's honesty conventions. */
function chapter(lines: string[], heading: string, body: string): void {
    lines.push(`## ${heading}`, '', body.trim() === '' ? '(未填写)' : body.trim(), '')
}

/** Render the ADR markdown (fenced-JSON frontmatter + the six chapters). */
export function renderAdr(input: {
    number: number
    slug: string
    title: string
    decision: string
    alternatives?: string
    consequences?: string
    missionId?: string
    supersedes?: number
    at: number
    planFile?: string
}): string {
    const frontmatter = {
        number: input.number,
        slug: input.slug,
        title: input.title,
        recordedAt: input.at,
        ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    }
    const lines: string[] = [
        `# ${adrNumber(input.number)} ${input.title}`,
        '',
        '```json',
        JSON.stringify(frontmatter, undefined, 2),
        '```',
        '',
    ]
    lines.push(
        '## 状态',
        '',
        `已接受（记录于 ${formatTime(input.at)}）。`,
        '本文件按「ADR 只增不改」原则不再修改：是否已被取代以 `adr_list` / `index.jsonl` 里的 `supersededBy` 为准，',
        '绝不回写这份文档——去年读过它的人看到的应该还是同一份内容。',
        '',
    )
    chapter(
        lines,
        '背景',
        input.missionId === undefined
            ? '未关联 mission：这条决策的背景不在工程台账里（如果它属于某次改动，记录时传 missionId）。'
            : `来自 mission \`${input.missionId}\`（规格 \`.dsh/specs/${input.missionId}.md\`，证据 \`.dsh/missions/${input.missionId}/evidence.jsonl\`）。`,
    )
    chapter(lines, '决定', input.decision)
    chapter(lines, '备选方案与为什么不选', input.alternatives ?? '')
    chapter(lines, '后果', input.consequences ?? '')
    const evidence = [
        '- 记录来源：`adr_record`（dsh-spec-gate）',
        ...(input.missionId === undefined
            ? ['- 未关联 mission：没有可引用的规格 / 证据 / 回执。']
            : [
                  `- 规格：\`.dsh/specs/${input.missionId}.md\``,
                  `- 证据：\`.dsh/missions/${input.missionId}/evidence.jsonl\``,
              ]),
        ...(input.planFile === undefined ? [] : [`- 规划台账：\`${input.planFile}\`（这次决策发生在哪次规格变更前后）`]),
        ...(input.supersedes === undefined ? [] : [`- 取代：\`${adrNumber(input.supersedes)}\``]),
    ]
    chapter(lines, '证据链接', evidence.join('\n'))
    return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Record one decision.
 *
 * Fail closed at every step that could destroy a record: an empty title or
 * decision, a `supersedes` that does not name an existing ADR, and a target path
 * that already exists are all refusals that name the fix.
 * @param deps - layout, config and clock.
 * @param request - the decision as submitted.
 */
export function recordAdr(deps: AdrDeps, request: AdrRequest): AdrOutcome {
    const dir = adrDirectory(deps.layout, deps.config)
    const indexFile = adrIndexPath(deps.layout, deps.config)
    const now = deps.now ?? Date.now()
    const title = (request.title ?? '').trim()
    if (title === '') {
        return {
            ok: false,
            problem: 'adr_record 需要 title（一句话说明这条决策是关于什么的）。',
            nextSteps: '补上 title 后重试；标题决定文件名里的 slug（标题没有 ASCII 字符时用短哈希兜底）。',
        }
    }
    if ((request.decision ?? '').trim() === '') {
        return {
            ok: false,
            problem: `adr_record 需要 decision（"决定了什么"），标题「${title}」不足以还原决策。`,
            nextSteps: '补上 decision（一句话即可）；alternatives / consequences 可选，但"决定了什么"是记录的主体。',
        }
    }

    const listed = listAdrRecords(deps.layout, deps.config)
    const { records, missingFiles } = listed
    const numbers = [...new Set([...records.map((record) => record.number), ...listed.index.rows.map((row) => row.number)])].sort(
        (left, right) => left - right,
    )
    if (request.supersedes !== undefined) {
        if (!Number.isInteger(request.supersedes) || request.supersedes < 1) {
            return {
                ok: false,
                problem: `supersedes 必须是已有 ADR 的编号（正整数 1、2、…），收到 ${JSON.stringify(request.supersedes)}。`,
                nextSteps: '先调用 adr_list 看现有编号，再带上正确的 supersedes 重试；新决策请省略该参数。',
            }
        }
        if (!records.some((record) => record.number === request.supersedes)) {
            return {
                ok: false,
                problem:
                    numbers.length === 0
                        ? `supersedes=${adrNumber(request.supersedes)} 不存在：本仓库还没有任何 ADR（新的第一条请省略 supersedes）。`
                        : `supersedes=${adrNumber(request.supersedes)} 不存在：现有编号 ${numbers.map(adrNumber).join('、')}${
                              missingFiles.includes(request.supersedes) ? `（编号 ${adrNumber(request.supersedes)} 只在 index.jsonl 里，文件已丢失——编号不会复用，请先修好文件）` : ''
                          }。`,
                nextSteps: '先调用 adr_list 核对编号；supersedes 只能指向已存在的 ADR 文件。',
            }
        }
    }

    const number = numbers.length === 0 ? 1 : Math.max(...numbers) + 1
    const slug = adrSlug(title)
    const file = path.join(dir, `${adrNumber(number)}-${slug}.md`)
    const relativePath = path.relative(deps.layout.cwd, file) || file
    const refuseExisting = (): AdrOutcome => ({
        ok: false,
        problem: `目标文件已存在：${relativePath}（ADR 只增不改，绝不覆盖）。`,
        nextSteps: '下一步：adr_list 看现有编号；要改决定就记一条新的并写 supersedes；确认编号被占用就删掉那个空文件或换个标题。',
    })
    /** The number was free when it was read and taken by a concurrent call. */
    const refuseTaken = (): AdrOutcome => ({
        ok: false,
        problem:
            `编号 ${adrNumber(number)} 在本次调用计算出来之后被另一条 adr_record 占用了（${relativePath} 已经存在）：` +
            'ADR 只增不改，绝不覆盖，因此本次没有写入任何决策。',
        nextSteps: '下一步：直接重试——重试会重新读取目录里的编号，用下一个空闲编号记录这条决策（不需要换标题）。',
    })
    if (exists(file)) return refuseExisting()

    const markdown = renderAdr({
        number,
        slug,
        title,
        decision: request.decision.trim(),
        ...(request.alternatives === undefined ? {} : { alternatives: request.alternatives }),
        ...(request.consequences === undefined ? {} : { consequences: request.consequences }),
        ...(request.missionId === undefined || request.missionId === '' ? {} : { missionId: request.missionId }),
        ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
        at: now,
        planFile: deps.config.planFile,
    })
    // The exclusive create is the write that actually decides: the existence
    // check above is only there to produce a better message, and two concurrent
    // calls that computed the same number must not clobber each other.
    if (!writeAdrOnceExclusive(file, markdown)) return refuseTaken()

    const warnings: string[] = []
    const missionId = request.missionId === undefined || request.missionId.trim() === '' ? undefined : request.missionId.trim()
    const appendRow = (row: AdrIndexRow, what: string): void => {
        try {
            appendJsonl(indexFile, row)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            warnings.push(
                `⚠️ ADR 索引写入失败（${indexFile}，${what}）：${message}。决策文件已保存（${relativePath}）；index.jsonl 只是索引，可从 adr/*.md 重建。`,
            )
        }
    }
    appendRow(
        {
            at: now,
            number,
            slug,
            path: relativePath,
            title,
            ...(missionId === undefined ? {} : { missionId }),
            ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
        },
        '本行',
    )
    if (request.supersedes !== undefined) {
        const superseded = records.find((record) => record.number === request.supersedes)
        // A NEW row, never a rewrite: the superseded ADR's file and its original
        // index row both stay exactly as they were.
        appendRow(
            {
                at: now,
                number: request.supersedes,
                slug: superseded?.slug ?? '',
                path: superseded?.path ?? '',
                title: superseded?.title ?? `${adrNumber(request.supersedes)}`,
                ...(superseded?.missionId === undefined ? {} : { missionId: superseded.missionId }),
                supersededBy: number,
            },
            '被取代行',
        )
    }

    return {
        ok: true,
        number,
        slug,
        file,
        relativePath,
        title,
        ...(request.supersedes === undefined ? {} : { superseded: request.supersedes }),
        warnings,
        markdown,
    }
}

/** Filter for {@link renderAdrList}. */
export interface AdrListFilter {
    query?: string
    missionId?: string
}

/** The records one `adr_list` call answers with. */
export interface AdrListResult {
    dir: string
    indexFile: string
    records: AdrRecord[]
    /** Records hidden by the query/mission filter. */
    filtered: number
    indexRows: number
    unparsable: number
    /** Numbers the index still mentions although the file is gone. */
    missingFiles: number[]
}

/**
 * Answer `adr_list`: newest first, matching title OR decision text,
 * case-insensitively.
 * @param layout - workspace layout.
 * @param config - resolved configuration.
 * @param filter - optional query and mission filter.
 */
export function listAdr(layout: Layout, config: Pick<SpecGateConfig, 'adrDir' | 'adrIndexFile'>, filter: AdrListFilter = {}): AdrListResult {
    const listed = listAdrRecords(layout, config)
    const query = (filter.query ?? '').trim().toLowerCase()
    const missionId = filter.missionId === undefined || filter.missionId.trim() === '' ? undefined : filter.missionId.trim()
    const matched = listed.records.filter((record) => {
        if (missionId !== undefined && record.missionId !== missionId) return false
        if (query === '') return true
        // The decision chapter is what a reader searches for; a file whose
        // chapter is missing (hand-written, or a foreign ADR) is searched whole
        // rather than skipped.
        const haystack = `${record.title}\n${record.decision === '' ? record.text : record.decision}`.toLowerCase()
        return haystack.includes(query)
    })
    return {
        dir: listed.dir,
        indexFile: listed.indexFile,
        records: matched,
        filtered: listed.records.length - matched.length,
        indexRows: listed.index.rows.length,
        unparsable: listed.index.unparsable,
        missingFiles: listed.missingFiles,
    }
}

/**
 * Render an `adr_list` answer.
 * @param result - what {@link listAdr} found.
 * @param layout - the workspace layout (for the relative paths).
 * @param filterNote - how the caller narrowed the list, when it did.
 */
export function renderAdrList(result: AdrListResult, layout: Layout, filterNote?: string): string {
    const relativeDir = path.relative(layout.cwd, result.dir) || result.dir
    if (result.records.length === 0) {
        return [
            `## 架构决策记录（${relativeDir}）`,
            '',
            result.filtered > 0
                ? `没有匹配的记录（已有 ${result.filtered} 条被过滤掉）。`
                : '本仓库还没有架构决策记录：用 adr_record 记录第一条（标题 + 决定；备选方案重要时一并写清为什么不选）。',
            ...(filterNote === undefined ? [] : ['', `过滤条件：${filterNote}`]),
            '',
            'ADR 只记录"为什么这么选"，不是门禁：改决定就记一条新的并写 supersedes，不要改旧文件。',
        ].join('\n')
    }
    const lines: string[] = [
        `## 架构决策记录（${relativeDir}，${result.records.length} 条${result.filtered === 0 ? '' : `，已过滤 ${result.filtered} 条`}）`,
        '',
    ]
    for (const record of result.records) {
        const state = record.supersededBy === undefined ? '已接受' : `⚠ 已被 ${adrNumber(record.supersededBy)} 取代`
        const links = [
            record.missionId === undefined ? '未关联 mission' : `mission \`${record.missionId}\``,
            ...(record.supersedes === undefined ? [] : [`取代 ${adrNumber(record.supersedes)}`]),
            record.metadataOk ? '' : 'frontmatter 无法解析（正文仍在）',
        ].filter((entry) => entry !== '')
        lines.push(`### ${adrNumber(record.number)} ${record.title}`, '', `- 状态：${state}`, `- ${links.join('；')}`, `- 文件：${record.path}`)
        if (record.decision !== '') {
            lines.push(`- 决定：${record.decision.split('\n')[0]?.trim() ?? ''}`)
        }
        lines.push('')
    }
    if (result.unparsable > 0) lines.push(`（index.jsonl 有 ${result.unparsable} 行无法解析，已跳过——索引可从 adr/*.md 重建）`, '')
    if (result.missingFiles.length > 0) {
        lines.push(
            `⚠ index.jsonl 里的编号 ${result.missingFiles.map(adrNumber).join('、')} 没有对应文件（编号不会复用：请修好文件，不要重新编号）。`,
            '',
        )
    }
    if (filterNote !== undefined) lines.push(`过滤条件：${filterNote}`, '')
    lines.push('记录的是"为什么选它"；旧决定被取代时不改写旧文件，取代关系在 index.jsonl 的 supersededBy 行里。')
    return lines.join('\n')
}

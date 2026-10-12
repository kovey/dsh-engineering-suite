/**
 * The index artifact: `.dsh/kb/{manifest.json,chunks.jsonl,postings.json}`.
 *
 * Three files, and the invariants that make them worth trusting:
 *
 *  - **Content-addressed ids.** A chunk's id is `<docId>:<from>-<to>` and a
 *    document's is `<kind>:<path>` — no timestamp, no counter, no clock. Two
 *    builds of an unchanged repository therefore produce byte-identical
 *    `chunks.jsonl`, and only `manifest.json`'s `builtAt` moves. That is what
 *    lets a reviewer diff a rebuild instead of re-reading it. A workspace whose
 *    fingerprint moved while its indexed content did not — or a build asked for
 *    a different set of sources than the manifest records — gets the manifest
 *    rewritten and those two files left alone.
 *  - **Nothing partial is ever visible.** Every file is written to a temporary
 *    sibling and renamed into place; `manifest.json` is written LAST, so a
 *    crash mid-build leaves the previous index (or no index) rather than a
 *    chunk list that does not match its postings. `postings.json` also carries
 *    the digest of the `chunks.jsonl` it was built from, so a torn pair is
 *    detected on load instead of silently answering from half an index.
 *  - **A torn tail is a number, not an exception.** `loadIndex` tolerates the
 *    truncated last line a crash leaves behind, drops it, and reports how many
 *    rows were dropped — a rebuild replaces the files together, so the next
 *    build cleans it up.
 *
 * The rebuild never merges with the previous index: whenever the content changed
 * it replaces all three files together. A merge would keep a chunk of a file
 * that no longer exists, which is exactly the stale-fact failure a knowledge base
 * must not have. TWO exceptions write `manifest.json` alone, and both are taken
 * only when the computed chunk list and postings are byte-identical to the ones
 * on disk — so neither of them weakens the rule above:
 *
 *  - a fingerprint-only refresh, which records the workspace's new fingerprint
 *    (`changeKind: 'fingerprint'`);
 *  - a coverage-only change: the sources this build was ASKED for are not the
 *    ones the manifest records (`changeKind: 'coverage'`), which happens when a
 *    partial (`only`) build is followed by a full one, or the other way round —
 *    see {@link buildIndex}.
 *
 * @module dsh-knowledge-base/index-store
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    ensureDir,
    nowIso,
    readText,
    resolvePath,
    sha256,
    writeTextAtomic,
    type GitFingerprint,
    type Layout,
    type Logger,
} from 'dsh-eng-core'
import type { KbKind, KnowledgeBaseConfig } from './config.js'
import { indexFingerprint, indexSpecPath } from './fingerprint.js'
import { collectDocuments, type KbDocument, type KbSkipped, type KbSymbol, type SourceReport } from './sources.js'
import { BM25_B, BM25_K1, tokenCounts, tokenize, type TokenizerOptions } from './search.js'

// Re-exported so every surface compares with the SAME function: the CLI entry
// point and any doctor read the manifest through this module, and a fingerprint
// computed differently from the one stored in the manifest is exactly how a
// false "过期" appears (see fingerprint.ts).
export { indexFingerprint, indexSpecPath }

/** Index format version; a mismatch is reported, never silently tolerated. */
export const KB_INDEX_VERSION = 1
/** File names inside the index directory. */
export const MANIFEST_FILE = 'manifest.json'
export const CHUNKS_FILE = 'chunks.jsonl'
export const POSTINGS_FILE = 'postings.json'
/**
 * Longest chunk text. A minified or generated file can hold a single line of
 * hundreds of kilobytes; indexing it whole would make one chunk swamp a query's
 * snippet and its length normalisation, so the line is cut and the cut is
 * labelled in the text itself.
 */
export const MAX_CHUNK_CHARS = 6_000

/** One indexed chunk (one row of `chunks.jsonl`). */
export interface KbChunk {
    /** `<docId>:<from>-<to>` — content-addressed, timestamp-free. */
    id: string
    /** `<kind>:<path>`, plus `#<discriminator>` for derived documents. */
    docId: string
    kind: KbKind
    /** Workspace-relative citation path. */
    path: string
    title: string
    /** First line of `text` (1-based; for derived documents, of the summary). */
    from: number
    /** Last line of `text` (inclusive). */
    to: number
    text: string
    /** Symbols declared inside `[from, to]`, when the extractors reported any. */
    symbols?: KbSymbol[]
}

/** One source row of the manifest. */
export interface KbManifestSource {
    id: string
    kind: KbKind
    documents: number
    chunks: number
    /** Files (or ledger rows) this source could not fully cover, with reasons. */
    skipped: KbSkipped[]
}

/** The manifest: what the index is, what it covered, and what it knows it missed. */
export interface KbManifest {
    version: number
    builtAt: string
    fingerprint: GitFingerprint
    sources: KbManifestSource[]
    totals: {
        documents: number
        chunks: number
        skipped: number
    }
    /**
     * Set when the index itself knows it is incomplete (a truncated walk, a
     * partial `only` build, a source that could not read its own artifact).
     * "Search found nothing" and "search never looked" must not look the same.
     */
    staleness?: { reason: string }
}

/** The inverted index plus the statistics BM25 needs. */
export interface KbPostings {
    version: number
    k1: number
    b: number
    /** SHA-256 of the `chunks.jsonl` this postings file was built from. */
    chunksDigest: string
    chunkCount: number
    totalTokens: number
    averageLength: number
    /** Token count per chunk (BM25's document length). */
    lengths: Record<string, number>
    /** Number of chunks a token occurs in (BM25's document frequency). */
    documentFrequency: Record<string, number>
    /** token → chunk id → term frequency in the body. */
    postings: Record<string, Record<string, number>>
    /** chunk id → title tokens (duplicates = term frequency). */
    titleTokens: Record<string, string[]>
    /** chunk id → symbol-name tokens (duplicates = term frequency). */
    symbolTokens: Record<string, string[]>
}

/** Inputs of {@link buildIndex}. */
export interface BuildInput {
    cwd: string
    layout: Layout
    config: KnowledgeBaseConfig
    /** Injected clock; the only non-deterministic input the artifact records. */
    now: number
    /** Rebuild even when nothing changed. */
    force?: boolean
    /** Build a PARTIAL index restricted to these source ids. */
    only?: readonly string[]
    logger?: Logger
}

/**
 * Why a build counted as "changed" (for the report).
 *
 * Each kind names ONE fact, and the facts are never merged. When several hold at
 * once the STRONGEST one is reported, and this is the order (documented in the
 * README's change-kind table, asserted by the tests, applied in {@link buildIndex}):
 *
 * 1. `'created'` — there is no manifest to compare with at all.
 * 2. `'coverage'` — the sources this build was ASKED for differ from the ones the
 *    manifest records. It outranks `'content'` because it explains the byte move
 *    (a narrower/wider source set collects a different document set) and because
 *    it is the fact the manifest had wrong; the coverage report states whether
 *    the chunk list was rewritten as well.
 * 3. `'content'` — the chunk list bytes differ: the indexed content moved.
 * 4. `'postings'` — the chunk list is byte-identical, the inverted index is not
 *    (the tokenizer/scoring configuration changed).
 * 5. `'forced'` — the caller asked for a rewrite (`force: true`) while nothing
 *    substantive was different; it outranks `'fingerprint'` because an explicit
 *    force is never a refresh on the build's own initiative.
 * 6. `'fingerprint'` — the indexed content did not change, but the workspace's
 *    recorded fingerprint had moved, so the manifest was refreshed on the build's
 *    own initiative.
 * 7. `'unchanged'` — nothing differs; nothing is written, not one byte.
 */
export type ChangeKind = 'unchanged' | 'created' | 'coverage' | 'content' | 'postings' | 'forced' | 'fingerprint'

/** What a build asked for versus what the previous manifest recorded. */
export interface CoverageChange {
    /** The source ids the previous manifest recorded (`undefined`: it could not be read). */
    recorded?: string[]
    /** The source ids THIS build was asked for (config `enabled` after `only`). */
    requested: string[]
}

/** Result of one build. */
export interface BuildResult {
    dir: string
    manifest: KbManifest
    chunks: KbChunk[]
    postings: KbPostings
    reports: SourceReport[]
    /** Whether anything was written. */
    changed: boolean
    changeKind: ChangeKind
    /**
     * Whether `chunks.jsonl` and `postings.json` were (re)written. `false` means
     * only `manifest.json` moved — the case for `'fingerprint'` and for a
     * `'coverage'` change whose computed bytes already match the ones on disk.
     */
    artifactsWritten: boolean
    /** Set when `changeKind` is `'coverage'`: the recorded and requested source ids. */
    coverageChange?: CoverageChange
    fingerprint: GitFingerprint
    /** Structural problems (a duplicate document id, a version bump…). */
    problems: string[]
    files: { manifest: string; chunks: string; postings: string }
}

/** One thing that went wrong while loading an index. */
export interface KbProblem {
    message: string
    /** `true` when the index cannot be answered from as it is. */
    fatal: boolean
}

/** The loaded index, plus what could not be read. */
export interface LoadedIndex {
    dir: string
    manifest?: KbManifest
    chunks: KbChunk[]
    postings?: KbPostings
    /** Chunk rows that were dropped (torn tail, invalid row). */
    droppedChunks: number
    /**
     * What could not be read, and whether answering around it is possible.
     *
     * A truncated last line explains a postings/chunks mismatch and is warned
     * about (`fatal: false`); a mismatch with no dropped row cannot be
     * explained that way — the chunk list was replaced or appended to — and is
     * fatal, because the inverted index then describes a different document set
     * than the one being searched.
     */
    problems: KbProblem[]
    /** Total size of the three files (0 when nothing exists). */
    totalBytes: number
}

/** Binary (locale-independent) compare. */
function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/** Absolute index directory of one workspace. */
export function indexDirOf(cwd: string, config: Pick<KnowledgeBaseConfig, 'indexDir'>): string {
    return resolvePath(config.indexDir, cwd)
}

/**
 * Split one document into chunks of at most `maxChunkLines` lines.
 *
 * Blank chunks are dropped, but the line cursor still advances, so `from`/`to`
 * stay the document's real line numbers (a dropped blank chunk must not shift
 * every later citation by three lines).
 * @param document - the collected document.
 * @param maxChunkLines - the configured line bound.
 * @returns the chunks, in document order.
 */
export function chunkDocument(document: KbDocument, maxChunkLines: number): KbChunk[] {
    const lines = document.text.split('\n')
    const chunks: KbChunk[] = []
    let start = 0
    while (start < lines.length) {
        let end = start
        let characters = 0
        while (end < lines.length && end - start < maxChunkLines) {
            const length = (lines[end] as string).length + 1
            if (end > start && characters + length > MAX_CHUNK_CHARS) break
            characters += length
            end += 1
        }
        const text = lines
            .slice(start, end)
            .map((line) =>
                line.length > MAX_CHUNK_CHARS ? `${line.slice(0, MAX_CHUNK_CHARS)}…[截断：本行共 ${line.length} 字符]` : line,
            )
            .join('\n')
        const from = start + 1
        const to = end
        if (text.trim() !== '') {
            const symbols = (document.symbols ?? []).filter((symbol) => symbol.line >= from && symbol.line <= to)
            chunks.push({
                id: `${document.id}:${from}-${to}`,
                docId: document.id,
                kind: document.kind,
                path: document.path,
                title: document.title,
                from,
                to,
                text,
                ...(symbols.length === 0 ? {} : { symbols }),
            })
        }
        start = end
    }
    return chunks
}

/**
 * Sorted keys as a plain object (deterministic JSON).
 *
 * The object is created with a NULL prototype on purpose: the keys are tokens
 * from the repository's own text, and a JavaScript file that contains the
 * literal `__proto__` would otherwise not get a postings entry at all — the
 * assignment would set the object's prototype instead of a key, the term would
 * vanish from the index, and nothing would report it.
 */
function sortedObject<T>(map: Map<string, T>): Record<string, T> {
    const out: Record<string, T> = Object.create(null) as Record<string, T>
    for (const [key, value] of [...map.entries()].sort((left, right) => compareText(left[0], right[0]))) out[key] = value
    return out
}

/**
 * Build the inverted index for a chunk list.
 * @param chunks - the chunks, in artifact order.
 * @param options - tokenisation options.
 * @returns the postings document (without its `chunksDigest`, filled by the caller).
 */
export function buildPostings(chunks: readonly KbChunk[], options: TokenizerOptions): KbPostings {
    const lengths = new Map<string, number>()
    const postings = new Map<string, Map<string, number>>()
    const documentFrequency = new Map<string, number>()
    const titleTokens = new Map<string, string[]>()
    const symbolTokens = new Map<string, string[]>()
    let totalTokens = 0
    for (const chunk of chunks) {
        const body = tokenCounts(chunk.text, options)
        let length = 0
        for (const [token, count] of body) {
            length += count
            const bucket = postings.get(token) ?? new Map<string, number>()
            bucket.set(chunk.id, count)
            postings.set(token, bucket)
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
        }
        lengths.set(chunk.id, length)
        totalTokens += length
        const title = tokenize(chunk.title, options).sort(compareText)
        if (title.length > 0) titleTokens.set(chunk.id, title)
        const symbols = (chunk.symbols ?? []).flatMap((symbol) => tokenize(symbol.name, options)).sort(compareText)
        if (symbols.length > 0) symbolTokens.set(chunk.id, symbols)
    }
    const emitted = new Map<string, Record<string, number>>()
    for (const [token, bucket] of postings) emitted.set(token, sortedObject(bucket))
    const chunkCount = chunks.length
    return {
        version: KB_INDEX_VERSION,
        k1: BM25_K1,
        b: BM25_B,
        chunksDigest: '',
        chunkCount,
        totalTokens,
        averageLength: chunkCount === 0 ? 0 : totalTokens / chunkCount,
        lengths: sortedObject(lengths),
        documentFrequency: sortedObject(documentFrequency),
        postings: sortedObject(emitted),
        titleTokens: sortedObject(titleTokens),
        symbolTokens: sortedObject(symbolTokens),
    }
}

/** Serialise `chunks.jsonl` (one row per line, fixed key order). */
export function serializeChunks(chunks: readonly KbChunk[]): string {
    if (chunks.length === 0) return ''
    return `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`
}

/** Serialise `postings.json` (compact, sorted keys, no clock). */
export function serializePostings(postings: KbPostings): string {
    return `${JSON.stringify(postings)}\n`
}

/** Whether a parsed value looks like a manifest. */
function isManifest(value: unknown): value is KbManifest {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return typeof record['version'] === 'number' && typeof record['builtAt'] === 'string' && Array.isArray(record['sources'])
}

/**
 * Whether a parsed value carries the facts a stored fingerprint is compared by.
 *
 * A manifest's `fingerprint` comes back through `JSON.parse`, so it must be
 * re-established as a `GitFingerprint` before anything compares it: an
 * unreadable or foreign shape must not be coerced into "looks the same".
 */
function isFingerprint(value: unknown): value is GitFingerprint {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        typeof record['isRepo'] === 'boolean' &&
        typeof record['dirty'] === 'boolean' &&
        typeof record['changedFiles'] === 'number' &&
        typeof record['diffDigest'] === 'string' &&
        (record['head'] === undefined || typeof record['head'] === 'string') &&
        (record['branch'] === undefined || typeof record['branch'] === 'string')
    )
}

/**
 * The fingerprint a previous manifest recorded, or `undefined` when it cannot
 * be read (no manifest text, unparsable JSON, a shape this build does not
 * recognise). `undefined` is never treated as "equal to the current one".
 */
function recordedFingerprint(manifestText: string | undefined): GitFingerprint | undefined {
    if (manifestText === undefined) return undefined
    try {
        const parsed: unknown = JSON.parse(manifestText)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const fingerprint = (parsed as Record<string, unknown>)['fingerprint']
        return isFingerprint(fingerprint) ? fingerprint : undefined
    } catch {
        return undefined
    }
}

/**
 * Whether a recorded fingerprint still describes the current workspace, judged
 * by exactly the fields `stalenessOf` compares (isRepo, HEAD, branch, dirty,
 * changedFiles, the diff digest).
 *
 * Comparing the same field set is the point: the build refreshes the recorded
 * fingerprint precisely when the freshness comparison would otherwise call the
 * index 陈旧, so the two can no longer disagree. A `JSON.stringify` comparison
 * would be wrong here — the recorded value has been through `JSON.parse`, and
 * the same facts in a different key order are not a change.
 */
function sameFingerprint(recorded: GitFingerprint | undefined, current: GitFingerprint): boolean {
    if (recorded === undefined) return false
    return (
        recorded.isRepo === current.isRepo &&
        recorded.head === current.head &&
        recorded.branch === current.branch &&
        recorded.dirty === current.dirty &&
        recorded.changedFiles === current.changedFiles &&
        recorded.diffDigest === current.diffDigest
    )
}

/**
 * The source ids a previous manifest recorded as covered, in the order it wrote
 * them, or `undefined` when they cannot be read (no manifest text, unparsable
 * JSON, a shape this build does not recognise). `undefined` is never treated as
 * "equal to what was requested": coverage that cannot be read must be rewritten,
 * not assumed.
 */
function recordedCoverage(manifestText: string | undefined): string[] | undefined {
    if (manifestText === undefined) return undefined
    try {
        const parsed: unknown = JSON.parse(manifestText)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const sources = (parsed as Record<string, unknown>)['sources']
        if (!Array.isArray(sources)) return undefined
        const ids: string[] = []
        for (const source of sources) {
            if (typeof source !== 'object' || source === null) return undefined
            const id = (source as Record<string, unknown>)['id']
            if (typeof id !== 'string') return undefined
            ids.push(id)
        }
        return ids
    } catch {
        return undefined
    }
}

/** Whether the coverage a manifest recorded is the coverage a build was asked for (as a set). */
function sameCoverage(recorded: string[] | undefined, requested: readonly string[]): boolean {
    if (recorded === undefined) return false
    const seen = [...recorded].sort(compareText)
    const wanted = [...requested].sort(compareText)
    return seen.length === wanted.length && seen.every((id, index) => id === wanted[index])
}

/** Whether a parsed value looks like a chunk row. */
function isChunk(value: unknown): value is KbChunk {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        typeof record['id'] === 'string' &&
        typeof record['docId'] === 'string' &&
        typeof record['kind'] === 'string' &&
        typeof record['path'] === 'string' &&
        typeof record['title'] === 'string' &&
        typeof record['from'] === 'number' &&
        typeof record['to'] === 'number' &&
        typeof record['text'] === 'string'
    )
}

/** Whether a parsed value looks like a postings document. */
function isPostings(value: unknown): value is KbPostings {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        typeof record['chunkCount'] === 'number' &&
        typeof record['averageLength'] === 'number' &&
        typeof record['chunksDigest'] === 'string' &&
        typeof record['lengths'] === 'object' &&
        record['lengths'] !== null &&
        typeof record['postings'] === 'object' &&
        record['postings'] !== null &&
        typeof record['documentFrequency'] === 'object' &&
        record['documentFrequency'] !== null
    )
}

/**
 * Load an index directory, tolerating a torn tail.
 * @param dir - absolute index directory.
 * @returns the manifest, chunks, postings and every problem found.
 */
export function loadIndex(dir: string): LoadedIndex {
    const problems: KbProblem[] = []
    const manifestFile = path.join(dir, MANIFEST_FILE)
    const chunksFile = path.join(dir, CHUNKS_FILE)
    const postingsFile = path.join(dir, POSTINGS_FILE)
    const manifestText = readText(manifestFile)
    const chunksText = readText(chunksFile)
    const postingsText = readText(postingsFile)

    let manifest: KbManifest | undefined
    if (manifestText === undefined) {
        problems.push({ message: `缺少 ${MANIFEST_FILE}`, fatal: true })
    } else {
        try {
            const parsed: unknown = JSON.parse(manifestText)
            if (isManifest(parsed)) manifest = parsed
            else problems.push({ message: `${MANIFEST_FILE} 结构不可识别（缺少 version/builtAt/sources）`, fatal: true })
        } catch {
            problems.push({ message: `${MANIFEST_FILE} 不是合法 JSON`, fatal: true })
        }
    }

    const chunks: KbChunk[] = []
    let droppedChunks = 0
    if (chunksText !== undefined) {
        for (const line of chunksText.split('\n')) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            try {
                const parsed: unknown = JSON.parse(trimmed)
                if (isChunk(parsed)) chunks.push(parsed)
                else droppedChunks += 1
            } catch {
                droppedChunks += 1
            }
        }
    } else {
        problems.push({ message: `缺少 ${CHUNKS_FILE}`, fatal: true })
    }

    let postings: KbPostings | undefined
    if (postingsText === undefined) {
        problems.push({ message: `缺少 ${POSTINGS_FILE}`, fatal: true })
    } else {
        try {
            const parsed: unknown = JSON.parse(postingsText)
            if (isPostings(parsed)) postings = parsed
            else problems.push({ message: `${POSTINGS_FILE} 结构不可识别`, fatal: true })
        } catch {
            problems.push({ message: `${POSTINGS_FILE} 不是合法 JSON`, fatal: true })
        }
    }
    if (droppedChunks > 0) {
        problems.push({
            message: `${CHUNKS_FILE} 有 ${droppedChunks} 行无法解析（崩溃留下的半行已被跳过）：这些块不在索引里`,
            fatal: false,
        })
    }
    if (postings !== undefined && chunksText !== undefined && postings.chunksDigest !== sha256(chunksText)) {
        // A torn tail explains the mismatch; anything else means the chunk list
        // was replaced or appended to and the inverted index is about a
        // different document set.
        problems.push({
            message:
                `${POSTINGS_FILE} 与 ${CHUNKS_FILE} 不一致（上一次重建可能中断）：倒排索引对应的不是当前的块列表` +
                (droppedChunks > 0 ? '——上面的半行就是原因' : ''),
            fatal: droppedChunks === 0,
        })
    }
    if (manifest !== undefined && manifest.version !== KB_INDEX_VERSION) {
        problems.push({ message: `${MANIFEST_FILE} 的版本是 ${manifest.version}，本插件是 ${KB_INDEX_VERSION}：请重建索引`, fatal: true })
    }
    let totalBytes = 0
    for (const file of [manifestFile, chunksFile, postingsFile]) {
        try {
            totalBytes += fs.statSync(file).size
        } catch {
            // absent: nothing to add
        }
    }
    return { dir, ...(manifest === undefined ? {} : { manifest }), chunks, ...(postings === undefined ? {} : { postings }), droppedChunks, problems, totalBytes }
}

/**
 * Build (or rebuild) the index.
 * @param input - workspace, layout, configuration, clock and options.
 * @returns the artifact, the per-source report and whether anything changed.
 */
export function buildIndex(input: BuildInput): BuildResult {
    const config = input.config
    const dir = indexDirOf(input.cwd, config)
    const only = (input.only ?? []).map((id) => id.trim()).filter((id) => id !== '')
    const known = new Set(config.sources.map((source) => source.id))
    const unknownSources = only.filter((id) => !known.has(id))
    if (unknownSources.length > 0) {
        // Fail closed BEFORE anything is written: an `only` naming a source this
        // host does not have is a typo, and the alternative reading — "build an
        // index with every source disabled" — would replace a good index with an
        // empty one and report success.
        throw new Error(
            `only 里出现了未配置的来源：${unknownSources.join('、')}。可用来源：${[...known].join('、')}。未写入任何文件，现有索引保持不变。`,
        )
    }
    const sources = config.sources.map((source) => ({
        ...source,
        globs: [...source.globs],
        enabled: source.enabled && (only.length === 0 || only.includes(source.id)),
    }))
    const partial = only.length > 0
    // The coverage THIS build was asked for. A source the host disabled is not
    // requested coverage (it is in no manifest either), and `only` narrows the
    // request exactly as `collectDocuments` will.
    const requestedCoverage = sources.filter((source) => source.enabled).map((source) => source.id)

    // The index directory is excluded from the fingerprint (status, diff digest
    // and the dirty flag): a build must not make the workspace dirty and then
    // report its own artifact as "a change".
    const fingerprint = indexFingerprint(input.cwd, dir)
    const collected = collectDocuments({
        cwd: input.cwd,
        layout: input.layout,
        sources,
        maxFileBytes: config.maxFileBytes,
        indexDir: dir,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
    })

    const problems: string[] = []
    const seen = new Set<string>()
    const chunks: KbChunk[] = []
    const perSource = new Map<string, number>()
    for (const document of collected.documents) {
        if (seen.has(document.id)) {
            problems.push(`文档 id 重复：${document.id}（同一来源产生了两个同 id 文档）——第二个已跳过`)
            continue
        }
        seen.add(document.id)
        const documentChunks = chunkDocument(document, config.maxChunkLines)
        perSource.set(document.kind, (perSource.get(document.kind) ?? 0) + documentChunks.length)
        chunks.push(...documentChunks)
    }
    const postings = buildPostings(chunks, config.tokenizer)
    const chunksText = serializeChunks(chunks)
    postings.chunksDigest = sha256(chunksText)
    const postingsText = serializePostings(postings)

    const reports: SourceReport[] = collected.reports.map((report) => ({
        ...report,
        chunks: perSource.get(report.kind) ?? 0,
    }))
    const manifestSources: KbManifestSource[] = reports
        .filter((report) => report.enabled)
        .map((report) => ({
            id: report.id,
            kind: report.kind,
            documents: report.documents,
            chunks: report.chunks,
            skipped: report.skipped,
        }))
    const totals = {
        documents: reports.filter((report) => report.enabled).reduce((sum, report) => sum + report.documents, 0),
        chunks: chunks.length,
        skipped: reports.filter((report) => report.enabled).reduce((sum, report) => sum + report.skipped.length, 0),
    }
    const stalenessReasons: string[] = []
    if (partial) stalenessReasons.push(`局部索引：kb_index 的 only 参数只构建了 ${only.join('、')}，其它来源的文档不在索引里`)
    if (collected.truncated) stalenessReasons.push(`工作区遍历达到 maxFiles 上限，docs/code 来源只覆盖了前一部分文件（提高 maxFiles 或收窄 globs 后重建）`)
    for (const report of reports) {
        if (report.incomplete !== undefined) stalenessReasons.push(`${report.id}：${report.incomplete}`)
    }
    const manifest: KbManifest = {
        version: KB_INDEX_VERSION,
        builtAt: nowIso(input.now),
        fingerprint,
        sources: manifestSources,
        totals,
        ...(stalenessReasons.length === 0 ? {} : { staleness: { reason: stalenessReasons.join('；') } }),
    }
    const manifestText = `${JSON.stringify(manifest, undefined, 2)}\n`

    const files = { manifest: path.join(dir, MANIFEST_FILE), chunks: path.join(dir, CHUNKS_FILE), postings: path.join(dir, POSTINGS_FILE) }
    const previousManifest = readText(files.manifest)
    const previousChunks = readText(files.chunks)
    const previousPostings = readText(files.postings)
    const contentChanged = previousChunks !== chunksText
    const postingsChanged = previousPostings !== postingsText
    const created = previousManifest === undefined
    // The change detection must agree with the freshness judgement every reader
    // makes (`stalenessOf` below, used by `kb_search` / `kb_status`). A tracked
    // file that no source covers (`.gitignore`), an added file outside the
    // sources, a commit or a branch switch move the workspace fingerprint while
    // leaving the indexed CONTENT byte-identical; comparing content alone then
    // answered "索引已是最新，未变" and wrote nothing, while `kb_search` still
    // reported 陈旧 — and the warning's own advice (`kb_index`) never cleared
    // it. So a moved fingerprint is a change of its own kind, and only the
    // manifest is rewritten for it.
    const fingerprintMoved = !created && !sameFingerprint(recordedFingerprint(previousManifest), fingerprint)
    // The third judgement of the same family: what the caller ASKED this build to
    // cover versus what the manifest records. Bytes alone cannot see it — a
    // partial build whose excluded sources happen to contribute no document
    // produces exactly the artifact a full build produces — so a manifest that
    // claimed partial coverage stayed partial forever (and a request for partial
    // coverage was never recorded at all), while `kb_status` kept describing the
    // index as narrower than what it actually held. Precedence (see
    // {@link ChangeKind}): created > coverage > content > postings > forced >
    // fingerprint > unchanged.
    const recorded = !created ? recordedCoverage(previousManifest) : undefined
    const coverageChanged = !created && !sameCoverage(recorded, requestedCoverage)
    const bytesMoved = contentChanged || postingsChanged
    let changeKind: ChangeKind = 'unchanged'
    if (created) changeKind = 'created'
    else if (coverageChanged) changeKind = 'coverage'
    else if (contentChanged) changeKind = 'content'
    else if (postingsChanged) changeKind = 'postings'
    else if (input.force === true) changeKind = 'forced'
    else if (fingerprintMoved) changeKind = 'fingerprint'
    const changed = changeKind !== 'unchanged'
    // Which files this build rewrites. The manifest always is (that is what makes
    // the recorded coverage and fingerprint true again); the two content artifacts
    // only when their computed bytes differ from the ones on disk, or when the
    // caller asked for a rewrite.
    //
    // A fingerprint-only or coverage-only change skips them on purpose: this
    // branch is taken exactly when the computed chunk list and postings are
    // byte-identical to the ones on disk, and leaving them untouched is what
    // keeps "two builds of an unchanged repository produce identical bytes" true
    // down to the file mtime.
    const writeArtifacts = changed && (created || bytesMoved || changeKind === 'forced')
    if (changed) {
        ensureDir(dir)
        // Order matters: the chunk list first, then the index that describes it,
        // then the manifest that commits to both. A crash in between leaves the
        // old manifest pointing at an index the digest check will flag.
        if (writeArtifacts) {
            writeTextAtomic(files.chunks, chunksText)
            writeTextAtomic(files.postings, postingsText)
        }
        writeTextAtomic(files.manifest, manifestText)
    }
    return {
        dir,
        manifest,
        chunks,
        postings,
        reports,
        changed,
        changeKind,
        artifactsWritten: writeArtifacts,
        ...(changeKind === 'coverage'
            ? { coverageChange: { ...(recorded === undefined ? {} : { recorded }), requested: requestedCoverage } }
            : {}),
        fingerprint,
        problems,
        files,
    }
}

/** Human label of a change kind (used by the report). */
export function describeChange(kind: ChangeKind): string {
    switch (kind) {
        case 'created':
            return '首次构建'
        case 'coverage':
            return '来源覆盖与 manifest 记录的不一致（本次请求的来源集合不同，manifest 已按请求改写）'
        case 'content':
            return '内容有变化（块列表已重写）'
        case 'postings':
            return '分词/索引配置有变化（倒排索引已重写，块列表字节未变）'
        case 'forced':
            return 'force=true：按请求重写'
        case 'fingerprint':
            return '内容未变，仅刷新了指纹（块列表与倒排索引的字节未动、未重写；manifest.json 的指纹与 builtAt 已更新）'
        default:
            return '未变'
    }
}

/** What a freshness comparison concluded. */
export interface Staleness {
    /** `true` only when the index is provably behind the workspace. */
    stale: boolean
    /** `true` when the comparison cannot be made (no git). */
    unknown?: boolean
    /** Why (a stale reason, or why it cannot be judged). */
    reason?: string
}

/**
 * Compare the fingerprint an index was built at with the workspace's current one.
 *
 * Deliberately conservative in both directions:
 *
 *  - anything that differs (HEAD, branch, dirty state, changed-file count, the
 *    diff digest) counts as stale, because each of them can mean a file the
 *    index describes no longer says that;
 *  - a workspace that is not a git repository makes the comparison UNKNOWN
 *    rather than fresh: the index cannot be shown to be current, and saying
 *    "fresh" there would be a claim with nothing behind it.
 *
 * Note the limit this shares with `git status`: an untracked file's *content*
 * change does not move the diff digest. `kb_index` therefore never trusts the
 * fingerprint for the CONTENT question — it compares the built bytes and reports
 * "未变" only when they really are identical — and for the FRESHNESS question it
 * does the opposite: a recorded fingerprint that no longer matches the workspace
 * is refreshed by the rebuild itself (`changeKind: 'fingerprint'`), so this
 * comparison and the build cannot end up disagreeing.
 * @param indexed - the fingerprint stored in the manifest.
 * @param current - the fingerprint captured now.
 */
export function stalenessOf(indexed: GitFingerprint, current: GitFingerprint): Staleness {
    if (!indexed.isRepo || !current.isRepo) {
        return { stale: false, unknown: true, reason: '工作区不是 git 仓库，无法用指纹判断索引新旧' }
    }
    const head = (value: string | undefined): string => (value === undefined ? 'no-commit' : value.slice(0, 8))
    if (indexed.head !== current.head) return { stale: true, reason: `HEAD 从 ${head(indexed.head)} 变成 ${head(current.head)}` }
    if (indexed.branch !== current.branch) return { stale: true, reason: `分支从 ${indexed.branch ?? 'detached'} 变成 ${current.branch ?? 'detached'}` }
    if (indexed.diffDigest !== current.diffDigest) {
        return {
            stale: true,
            reason: `工作区相对 HEAD 的改动变了（diff ${indexed.diffDigest.slice(0, 8)} → ${current.diffDigest.slice(0, 8)}）`,
        }
    }
    if (indexed.dirty !== current.dirty || indexed.changedFiles !== current.changedFiles) {
        return {
            stale: true,
            reason: `工作区改动数从 ${indexed.changedFiles} 变成 ${current.changedFiles}（可能是新增/删除的未跟踪文件）`,
        }
    }
    return { stale: false }
}

/** One-line reminder of the id bonus, reused by the status report. */
export const EXACT_ID_HINT =
    'id 形如 AC-003 / R-7 / ADR-0002 / TC-001 / GATE-… / RCP-… / <mission-id> 的查询按字面精确查找（大小写不敏感、边界校验），命中的块会得到固定加分。'


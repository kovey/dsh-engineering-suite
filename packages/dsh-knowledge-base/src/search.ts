/**
 * Deterministic retrieval: tokenisation, BM25 scoring, filters, reasons.
 *
 * Nothing here touches the filesystem, a clock or a model. The index is an
 * argument, the answer is a pure function of it, and two runs over the same
 * index and query return the same hits in the same order — which is what makes
 * an answer auditable after the fact.
 *
 * The choices, and their trade-offs:
 *
 *  - **Tokenisation.** ASCII/Latin words are case-folded and dropped when
 *    shorter than `minTokenLength`. CJK text is indexed as **overlapping
 *    bigrams** (`登录失败` → `登录`, `录失`, `失败`) when `cjkBigrams` is on:
 *    CJK has no spaces, and a whole-run token would mean a query only matches a
 *    document that contains the identical run — `登录` would miss `登录失败`.
 *    A one-character CJK run is kept as a one-character token (otherwise a
 *    single-character keyword could never be found). With `cjkBigrams` off, a
 *    CJK run is one token and only an identical run matches: the caller has
 *    chosen exactness over recall.
 *  - **Scoring: BM25** with `k1 = 1.2`, `b = 0.75`, IDF = `ln(1 + (N - df +
 *    0.5)/(df + 0.5))`, and field boosts folded into the term frequency
 *    (BM25F-style: `tf = 3·tf_title + 2·tf_symbols + 1·tf_body` by default)
 *    before the usual saturation. A separate BM25 per field and a linear
 *    combination was the alternative; folding keeps one length normalisation
 *    and one saturation, so a long file cannot win by repeating one word.
 *  - **Exact-id bonus.** `AC-003`, `R-7`, `ADR-0002`, `TC-001`, `GATE-…`,
 *    `RCP-…` and mission ids are how this suite addresses things. Such a token
 *    is looked up as a literal (case-insensitive, boundary-checked) and a chunk
 *    that contains it gets a fixed bonus, so the chunk that *defines* `AC-003`
 *    outranks the many chunks that merely contain `ac` and `003` separately. A
 *    chunk whose line says something about the id (prose after it, rather than a
 *    bare enumeration of ids) gets the bonus twice — otherwise the shortest
 *    list row would win on length normalisation and "what is AC-002?" would
 *    return the ledger line that lists it instead of the criterion itself.
 *  - **Filters run before ranking, corpus statistics stay global** (`N`,
 *    `avgLength`), so the same query scores the same under every filter and a
 *    filter only decides what is returned.
 *
 * The output of a hit is not just a number: `reasons` names the field each
 * query token hit, because "why did this come back" is the question an audit
 * asks and a score alone cannot answer it.
 *
 * @module dsh-knowledge-base/search
 */

import type { KbChunk, KbPostings } from './index-store.js'
import type { KbFieldBoosts } from './config.js'

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2
/** BM25 length-normalisation strength. */
export const BM25_B = 0.75
/** Fixed bonus for a chunk that literally contains an id-like query token. */
export const EXACT_ID_BONUS = 8
/** Longest line kept in an extracted snippet. */
export const SNIPPET_MAX_CHARS = 400
/** Lines kept around the first matching line of a snippet. */
export const SNIPPET_LINES = 3

/** Tokenisation options (a subset of the plugin configuration). */
export interface TokenizerOptions {
    cjkBigrams: boolean
    minTokenLength: number
}

/** Case-insensitive membership test for ASCII word characters. */
function isWordChar(character: string): boolean {
    return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character === '_'
}

/** Whether a character is a CJK ideograph or kana (BMP only). */
function isCjk(character: string): boolean {
    const code = character.codePointAt(0) ?? 0
    return (
        (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
        (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
        (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
        (code >= 0x3040 && code <= 0x30ff) // hiragana + katakana
    )
}

/**
 * Tokenise text into the tokens the index stores and queries use.
 * @param text - any text (title, symbols, body, query).
 * @param options - `cjkBigrams` and `minTokenLength`.
 * @returns the tokens, in reading order (duplicates preserved: they are term frequencies).
 */
export function tokenize(text: string, options: TokenizerOptions): string[] {
    const lower = text.toLowerCase()
    const tokens: string[] = []
    let index = 0
    while (index < lower.length) {
        const character = lower[index] as string
        if (isCjk(character)) {
            let end = index
            while (end < lower.length && isCjk(lower[end] as string)) end += 1
            const run = lower.slice(index, end)
            if (options.cjkBigrams) {
                if (run.length === 1) tokens.push(run)
                else for (let offset = 0; offset + 1 < run.length; offset += 1) tokens.push(run.slice(offset, offset + 2))
            } else if (run.length >= options.minTokenLength) {
                tokens.push(run)
            }
            index = end
            continue
        }
        if (isWordChar(character)) {
            let end = index
            while (end < lower.length && isWordChar(lower[end] as string)) end += 1
            const word = lower.slice(index, end)
            if (word.length >= options.minTokenLength) tokens.push(word)
            index = end
            continue
        }
        index += 1
    }
    return tokens
}

/** Token counts of one text (the postings' shape). */
export function tokenCounts(text: string, options: TokenizerOptions): Map<string, number> {
    const counts = new Map<string, number>()
    for (const token of tokenize(text, options)) counts.set(token, (counts.get(token) ?? 0) + 1)
    return counts
}

/**
 * Id-like tokens in a query (`AC-003`, `R-7`, `ADR-0002`, `TC-001`, `GATE-…`,
 * `RCP-…`, `add-health-endpoint-20260928-153000`).
 *
 * Deliberately broader than the suite's id vocabulary: the rule is "a run that
 * looks like `letters-digits…`", because a repository's own ids (`TC-12`,
 * `BUG-9`) deserve the same deterministic lookup as the suite's, and a false
 * positive only costs a scan (the bonus still requires a literal hit).
 * @param query - the raw query text.
 * @returns lowercased id-like tokens, in reading order, de-duplicated.
 */
export function idLikeTokens(query: string): string[] {
    const matches = query.match(/[A-Za-z][A-Za-z0-9_]*-\d[A-Za-z0-9_.-]*/g) ?? []
    const seen = new Set<string>()
    const out: string[] = []
    for (const match of matches) {
        const token = match.toLowerCase()
        if (seen.has(token)) continue
        seen.add(token)
        out.push(token)
    }
    return out
}

/** Binary (locale-independent) string compare, for deterministic ordering. */
function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/**
 * Whether `text` contains `literal` as a whole id (case-insensitive).
 *
 * The boundary rule is "not adjacent to an ASCII word character", so `AC-002`
 * matches `AC-002` and `AC-0021` does not, and `M-7` does not match `SEM-7`.
 */
export function containsId(text: string, literal: string): boolean {
    return occurrenceOf(text, literal) !== undefined
}

/** Id-like runs inside a line (`AC-002`, `RCP-2026…`, a mission id). */
const ID_RUN = /[A-Za-z][A-Za-z0-9_]*-\d[A-Za-z0-9_.-]*/g

/**
 * Whether one line SAYS something about the id (rather than listing it).
 *
 * `| AC-002 | 端口占用时启动失败 |` defines the criterion; `验收标准 id：
 * AC-001 AC-002` only enumerates ids. Both contain the literal, so a plain
 * "contains the id" bonus cannot tell them apart and the shorter list row would
 * win on length normalisation — which is exactly the wrong answer for "what is
 * AC-002". The rule therefore is: after the id on that line, is there prose left
 * once the other ids and separators are removed?
 * @param line - one line of a chunk.
 * @param literal - the lowercased id token.
 */
export function definesId(line: string, literal: string): boolean {
    const at = occurrenceOf(line, literal)
    if (at === undefined) return false
    const rest = line.slice(at + literal.length)
    const prose = rest.replace(ID_RUN, ' ').replace(/[^A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g, ' ').trim()
    return prose.length >= 2
}

/** Index of the first boundary-correct occurrence of `literal` (or `undefined`). */
function occurrenceOf(text: string, literal: string): number | undefined {
    const haystack = text.toLowerCase()
    let from = 0
    for (;;) {
        const at = haystack.indexOf(literal, from)
        if (at < 0) return undefined
        const before = at === 0 ? '' : (haystack[at - 1] as string)
        const afterIndex = at + literal.length
        const after = afterIndex >= haystack.length ? '' : (haystack[afterIndex] as string)
        if ((before === '' || !isWordChar(before)) && (after === '' || !isWordChar(after))) return at
        from = at + 1
    }
}

/** Which fields a query token hit. */
export interface MatchField {
    field: 'title' | 'symbols' | 'body'
    tokens: string[]
}

/** One ranked hit. */
export interface SearchHit {
    chunk: KbChunk
    score: number
    /** Per-field token hits, in the order title → symbols → body. */
    reasons: MatchField[]
    /** Id-like query tokens found literally in this chunk. */
    exactIds: string[]
    /** Bounded excerpt around the first matching line. */
    snippet: string
}

/** What one search observed (for the report). */
export interface SearchOutcome {
    query: string
    tokens: string[]
    idTokens: string[]
    hits: SearchHit[]
    /** Chunks that passed the filters and were scored. */
    scored: number
    /** Chunks that matched at least one query token or id. */
    candidates: number
    totalChunks: number
    limit: number
    limitClamped: boolean
    filters: {
        kinds?: string[]
        pathPrefix?: string
        missionId?: string
    }
}

/** Inputs of {@link searchIndex}. */
export interface SearchInput {
    chunks: readonly KbChunk[]
    postings: KbPostings
    query: string
    limit: number
    maxLimit: number
    boosts: KbFieldBoosts
    tokenizer: TokenizerOptions
    kinds?: readonly string[]
    pathPrefix?: string
    missionId?: string
}

/** Whether a chunk belongs to one mission (spec file, mission dir, or text). */
export function chunkBelongsToMission(chunk: KbChunk, missionId: string): boolean {
    if (chunk.path === `.dsh/specs/${missionId}.md`) return true
    if (chunk.path.startsWith(`.dsh/missions/${missionId}/`)) return true
    if (chunk.docId.includes(missionId)) return true
    return containsId(chunk.text, missionId)
}

/** Rank the index for one query. Pure: the same input always yields the same output. */
export function searchIndex(input: SearchInput): SearchOutcome {
    const tokens: string[] = []
    const seen = new Set<string>()
    for (const token of tokenize(input.query, input.tokenizer)) {
        if (seen.has(token)) continue
        seen.add(token)
        tokens.push(token)
    }
    const idTokens = idLikeTokens(input.query)
    const limit = Math.max(1, Math.min(Math.floor(input.limit), input.maxLimit))
    const limitClamped = Math.floor(input.limit) > input.maxLimit

    const matches = (chunk: KbChunk): boolean => {
        if (input.kinds !== undefined && input.kinds.length > 0 && !input.kinds.includes(chunk.kind)) return false
        if (input.pathPrefix !== undefined && input.pathPrefix !== '' && !chunk.path.startsWith(input.pathPrefix)) return false
        if (input.missionId !== undefined && input.missionId !== '' && !chunkBelongsToMission(chunk, input.missionId)) return false
        return true
    }

    const titleTokens = input.postings.titleTokens
    const symbolTokens = input.postings.symbolTokens
    const totalChunks = input.postings.chunkCount
    const averageLength = input.postings.averageLength > 0 ? input.postings.averageLength : 1

    interface Scored {
        chunk: KbChunk
        score: number
        reasons: MatchField[]
        exactIds: string[]
    }
    const scored: Scored[] = []
    let candidates = 0

    for (const chunk of input.chunks) {
        if (!matches(chunk)) continue
        const title = own(titleTokens, chunk.id) ?? []
        const symbols = own(symbolTokens, chunk.id) ?? []
        const titleHits: string[] = []
        const symbolHits: string[] = []
        const bodyHits: string[] = []
        let score = 0
        for (const token of tokens) {
            const inTitle = countOf(title, token)
            const inSymbols = countOf(symbols, token)
            const inBody = own(own(input.postings.postings, token), chunk.id) ?? 0
            if (inTitle === 0 && inSymbols === 0 && inBody === 0) continue
            if (inTitle > 0) titleHits.push(token)
            if (inSymbols > 0) symbolHits.push(token)
            if (inBody > 0) bodyHits.push(token)
            const weighted =
                input.boosts.title * inTitle + input.boosts.symbols * inSymbols + input.boosts.body * inBody
            const documentFrequency = own(input.postings.documentFrequency, token) ?? 0
            const idf = Math.log(1 + (totalChunks - documentFrequency + 0.5) / (documentFrequency + 0.5))
            const length = own(input.postings.lengths, chunk.id) ?? 0
            const normalisation = BM25_K1 * (1 - BM25_B + (BM25_B * length) / averageLength)
            score += (idf * (weighted * (BM25_K1 + 1))) / (weighted + normalisation)
        }
        const exactIds: string[] = []
        if (idTokens.length > 0) {
            const haystack = `${chunk.title}\n${(chunk.symbols ?? []).map((symbol) => symbol.name).join('\n')}\n${chunk.text}`
            for (const id of idTokens) {
                if (!containsId(haystack, id)) continue
                exactIds.push(id)
                // A chunk that DEFINES the id (the line carries prose about it)
                // outranks one that merely lists it: see `definesId`.
                if (chunk.text.split('\n').some((line) => definesId(line, id))) score += EXACT_ID_BONUS
            }
        }
        const reasons: MatchField[] = []
        if (titleHits.length > 0) reasons.push({ field: 'title', tokens: titleHits })
        if (symbolHits.length > 0) reasons.push({ field: 'symbols', tokens: symbolHits })
        if (bodyHits.length > 0) reasons.push({ field: 'body', tokens: bodyHits })
        if (reasons.length === 0 && exactIds.length === 0) continue
        candidates += 1
        score += EXACT_ID_BONUS * exactIds.length
        scored.push({ chunk, score, reasons, exactIds })
    }

    scored.sort((left, right) => right.score - left.score || compareText(left.chunk.id, right.chunk.id))
    const hits: SearchHit[] = scored.slice(0, limit).map((entry) => ({
        chunk: entry.chunk,
        score: entry.score,
        reasons: entry.reasons,
        exactIds: entry.exactIds,
        snippet: snippetOf(entry.chunk, tokens, idTokens, input.tokenizer),
    }))
    return {
        query: input.query,
        tokens,
        idTokens,
        hits,
        scored: scored.length,
        candidates,
        totalChunks,
        limit,
        limitClamped,
        filters: {
            ...(input.kinds === undefined || input.kinds.length === 0 ? {} : { kinds: [...input.kinds] }),
            ...(input.pathPrefix === undefined || input.pathPrefix === '' ? {} : { pathPrefix: input.pathPrefix }),
            ...(input.missionId === undefined || input.missionId === '' ? {} : { missionId: input.missionId }),
        },
    }
}

/**
 * Own-property lookup on a JSON-parsed map.
 *
 * `postings.json` and `chunks.jsonl` are read back with `JSON.parse`, so their
 * objects inherit `Object.prototype`: `postings['constructor']` is a FUNCTION,
 * not a term frequency, and `?? 0` does not rescue it — a document that really
 * contains `constructor` or `toString` would score `NaN` and sort nowhere. The
 * lookup therefore checks ownership instead of truthiness.
 */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
    if (record === undefined) return undefined
    return Object.hasOwn(record, key) ? record[key] : undefined
}

/** Occurrences of `token` in a token list (the term frequency). */
function countOf(list: readonly string[], token: string): number {
    let count = 0
    for (const entry of list) if (entry === token) count += 1
    return count
}

/**
 * A bounded excerpt around the first matching line.
 *
 * Bounding rule: at most {@link SNIPPET_LINES} lines and
 * {@link SNIPPET_MAX_CHARS} characters; `…` marks each end that was cut. When
 * no line matches (an id bonus can carry a chunk whose tokens are all outside
 * the body), the head of the chunk is shown, so a reader still sees what the
 * chunk is about.
 * @param chunk - the chunk to excerpt.
 * @param tokens - the query's tokens.
 * @param idTokens - the query's id-like tokens.
 * @param options - tokenisation options (for the per-line match test).
 */
export function snippetOf(chunk: KbChunk, tokens: readonly string[], idTokens: readonly string[], options: TokenizerOptions): string {
    const lines = chunk.text.split('\n')
    const wanted = new Set(tokens)
    let anchor = -1
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string
        const lineTokens = tokenize(line, options)
        if (lineTokens.some((token) => wanted.has(token))) {
            anchor = index
            break
        }
    }
    if (anchor < 0 && idTokens.length > 0) {
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] as string
            if (idTokens.some((id) => containsId(line, id))) {
                anchor = index
                break
            }
        }
    }
    if (anchor < 0) anchor = 0
    const start = Math.max(0, anchor - 1)
    const end = Math.min(lines.length, start + SNIPPET_LINES)
    const head = anchor > 1
    const tail = end < lines.length
    let text = lines.slice(start, end).join('\n').trim()
    if (text.length > SNIPPET_MAX_CHARS) text = `${text.slice(0, SNIPPET_MAX_CHARS)}…`
    if (head) text = `…${text}`
    if (tail) text = `${text}…`
    return text
}

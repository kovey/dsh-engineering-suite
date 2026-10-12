/**
 * The reports, rendered once for every surface that shows them.
 *
 * The knowledge base has two human surfaces now — the model's tools
 * (`kb_index` / `kb_search` / `kb_status` in `tools.ts`) and the human command
 * (`/kb …` in `command.ts`) — and a citation line that drifts between them is a
 * citation a reviewer cannot trust. So the rendering lives here, as pure
 * functions over already-computed values: no IO, no clock, no configuration
 * lookup, no logger. The operations (which do the IO) call these; the tool and
 * the command call the operations.
 *
 * Two reports are deliberately loud rather than convenient:
 *
 *  - **Staleness.** The freshness line is printed BEFORE the hits, because an
 *    answer drawn from a stale index may be wrong about the present, and a
 *    silently-omitted warning is exactly how that goes unnoticed. The line
 *    names the index directory the comparison ignores, so an audit can see what
 *    "一致" was measured against.
 *  - **Gaps.** Skipped files, truncated walks and partial builds are printed,
 *    because "the index has nothing about X" is only a useful answer when the
 *    reader can see whether the index ever looked at X.
 *
 * @module dsh-knowledge-base/report
 */

import path from 'node:path'
import { expandHome, type GitFingerprint } from 'dsh-eng-core'
import type { EffectiveConfig, KnowledgeBaseConfig } from './config.js'
import { EXACT_ID_HINT, describeChange, stalenessOf, type BuildResult, type KbManifest, type LoadedIndex } from './index-store.js'
import {
    BM25_B,
    BM25_K1,
    EXACT_ID_BONUS,
    SNIPPET_MAX_CHARS,
    SNIPPET_LINES,
    type SearchOutcome,
} from './search.js'

/** How many skipped entries one report details before it says "and N more". */
export const SKIP_DETAIL_LIMIT = 20

/** One freshness comparison as it will be printed. */
export interface Freshness {
    lines: string[]
    stale: boolean
}

/** Display path: workspace-relative when possible, `~`-shortened otherwise. */
export function displayPath(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/')
    const home = expandHome('~')
    return target.startsWith(home) ? `~${target.slice(home.length)}` : target
}

/** Human byte size. */
export function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** One-line fingerprint summary (the workspace's or the index's). */
export function fingerprintLine(fingerprint: GitFingerprint): string {
    if (!fingerprint.isRepo) return '不是 git 仓库（无法用指纹判新旧）'
    const head = fingerprint.head === undefined ? 'no-commit' : fingerprint.head.slice(0, 8)
    const branch = fingerprint.branch ?? 'detached'
    const state = fingerprint.dirty ? `+${fingerprint.changedFiles} 改动` : 'clean'
    return `${branch}@${head} ${state}（diff ${fingerprint.diffDigest.slice(0, 8)}）`
}

/**
 * The rendering of one freshness comparison.
 * @param indexed - the fingerprint stored in the manifest.
 * @param current - the fingerprint captured now.
 * @param ignored - display path of the directory both fingerprints exclude
 *   (`indexFingerprint`'s `indexDir`), named in the line so a reader can see
 *   what "一致" does not cover.
 * @returns the lines to print and whether the index is stale.
 */
export function freshnessLines(indexed: GitFingerprint, current: GitFingerprint, ignored: string): Freshness {
    const staleness = stalenessOf(indexed, current)
    if (staleness.unknown) {
        return {
            lines: [`新鲜度：无法判定——${staleness.reason ?? '工作区不是 git 仓库'}；索引构建时的指纹：${fingerprintLine(indexed)}`],
            stale: false,
        }
    }
    if (!staleness.stale) {
        return {
            lines: [
                `新鲜度：与当前工作区指纹一致（基于 git 指纹，比较时排除索引目录 ${ignored}——产物不会把自己判成过期；` +
                    '未跟踪文件的内容改动不在指纹里，见 kb_status）',
            ],
            stale: false,
        }
    }
    return { lines: [`⚠️ 索引可能过期：${staleness.reason ?? ''}——最近改动可能没进索引，引用前先 kb_index 重建。`], stale: true }
}

/** Per-source coverage table used by both `kb_index` and `kb_status`. */
export function sourceLines(manifest: KbManifest, config: KnowledgeBaseConfig): string[] {
    const lines: string[] = []
    const byId = new Map(manifest.sources.map((source) => [source.id, source]))
    for (const source of config.sources) {
        const pattern = source.globs.join('、')
        const row = byId.get(source.id)
        if (!source.enabled) {
            lines.push(`- ${source.id}（${source.kind}）：已停用（enabled=false），未索引｜${pattern}`)
            continue
        }
        if (row === undefined) {
            lines.push(`- ${source.id}（${source.kind}）：**不在本次索引里**（局部索引或未构建）｜${pattern}`)
            continue
        }
        const skipped = row.skipped.length === 0 ? '无跳过' : `跳过 ${row.skipped.length} 项`
        lines.push(`- ${source.id}（${source.kind}）：${row.documents} 篇文档 / ${row.chunks} 块；${skipped}｜${pattern}`)
    }
    return lines
}

/** Skipped entries with reasons, bounded. */
export function skippedLines(manifest: KbManifest, limit = SKIP_DETAIL_LIMIT): string[] {
    const rows: { source: string; path: string; reason: string }[] = []
    for (const source of manifest.sources) {
        for (const skipped of source.skipped) rows.push({ source: source.id, path: skipped.path, reason: skipped.reason })
    }
    if (rows.length === 0) return ['（无：所有被选中的文件都进了索引）']
    const lines = rows.slice(0, limit).map((row) => `- [${row.source}] ${row.path}：${row.reason}`)
    if (rows.length > limit) lines.push(`- …另有 ${rows.length - limit} 项，完整清单在 manifest.json 的 sources[].skipped 里`)
    return lines
}

/**
 * What makes an index unusable for answering.
 *
 * `loadIndex` decides: a missing/unparsable file, an unexplained
 * postings/chunks mismatch and a format version this build does not speak are
 * fatal — there is no honest answer to give from them. A torn tail the loader
 * could account for is NOT fatal: it is warned about in the report and fixed by
 * the next build (the postings entry of a dropped chunk is simply never
 * visited, because scoring walks the chunks that are there).
 */
export function unusableProblems(loaded: LoadedIndex): string[] {
    return loaded.problems.filter((problem) => problem.fatal).map((problem) => problem.message)
}

/** Non-fatal index problems (warned about, then answered around). */
export function warnedProblems(loaded: LoadedIndex): string[] {
    return loaded.problems.filter((problem) => !problem.fatal).map((problem) => problem.message)
}

/** The refusal every surface shares when there is no usable index. */
export function missingIndexMessage(dir: string, cwd: string, loaded?: LoadedIndex): string {
    const where = displayPath(cwd, dir)
    const detail = loaded === undefined ? '' : `\n发现的问题：\n${loaded.problems.map((problem) => `- ${problem.message}`).join('\n')}`
    return (
        `索引不存在或不可用（${where}）。知识库是**构建产物**：没有索引就没有检索，插件不会现场降级成"模糊搜索"，` +
        `也不会凭记忆回答。${detail}\n下一步：调用 \`kb_index\` 构建索引（首次构建会遍历下列来源：规格 / 决策 / 交付台账 / 规划台账 / 文档 / 代码），` +
        '然后重新 kb_search。'
    )
}

/** Render the ranked hits. */
export function hitLines(outcome: SearchOutcome): string[] {
    const lines: string[] = []
    outcome.hits.forEach((hit, index) => {
        const chunk = hit.chunk
        const derived = chunk.kind === 'trail' || chunk.kind === 'plan' || (chunk.kind === 'adr' && chunk.docId.includes('#'))
        lines.push(
            `[${index + 1}] ${chunk.path}:${chunk.from}-${chunk.to}  ${chunk.kind}  「${chunk.title}」${
                derived ? '（台账摘要：path 指向台账文件，行号是摘要行号）' : ''
            }`,
        )
        lines.push(`    摘要：${hit.snippet.replace(/\n/g, ' ⏎ ')}`)
        lines.push(`    分数：${hit.score.toFixed(4)}`)
        const reasons = hit.reasons.map((reason) => `${reason.field}[${reason.tokens.join(' ')}]`).join(' ')
        lines.push(`    命中：${reasons === '' ? '（只有 id 精确命中）' : reasons}${hit.exactIds.length === 0 ? '' : `；id 精确命中：${hit.exactIds.join(' ')}`}`)
        if (chunk.symbols !== undefined && chunk.symbols.length > 0) {
            lines.push(`    符号：${chunk.symbols.map((symbol) => `${symbol.name}（${symbol.kind}@${symbol.line}）`).join(' ')}`)
        }
    })
    if (outcome.hits.length < outcome.scored) {
        lines.push(`（共 ${outcome.scored} 条命中，按分数只显示前 ${outcome.hits.length} 条；提高 limit 可看更多，上限 ${outcome.limit}）`)
    }
    return lines
}

/** Everything `renderIndexReport` needs (all of it already computed). */
export interface IndexReportInput {
    cwd: string
    /** The effective configuration (profile row narrowed by the project file). */
    effective: EffectiveConfig
    /** The finished build. */
    result: BuildResult
}

/**
 * The `kb_index` report.
 * @param input - workspace, effective configuration and the build result.
 * @returns the report text (ends with a 下一步 line).
 */
export function renderIndexReport(input: IndexReportInput): string {
    const { cwd, effective, result } = input
    const config = effective.config
    const headline =
        result.changeKind === 'unchanged'
            ? '索引已是最新，未变（块列表与倒排索引的字节和现有产物一致；没有重写任何文件）'
            : `索引已重建：${describeChange(result.changeKind)}`
    const lines: string[] = []
    lines.push(`知识库索引：${headline}`)
    lines.push(`索引目录：${displayPath(cwd, result.dir)}（manifest.json / chunks.jsonl / postings.json）`)
    lines.push(`指纹：${fingerprintLine(result.fingerprint)}`)
    lines.push('来源覆盖：')
    lines.push(...sourceLines(result.manifest, config))
    lines.push(`合计：${result.manifest.totals.documents} 篇文档 / ${result.manifest.totals.chunks} 块；跳过 ${result.manifest.totals.skipped} 项（下面是原因）`)
    const notes = result.reports.flatMap((report) => report.notes.map((note) => `- [${report.id}] ${note}`))
    if (notes.length > 0) {
        lines.push('来源说明：')
        lines.push(...notes)
    }
    lines.push('跳过明细：')
    lines.push(...skippedLines(result.manifest))
    if (result.manifest.staleness !== undefined) lines.push(`索引自身声明的局限：${result.manifest.staleness.reason}`)
    if (effective.source === 'project') lines.push(`配置来源：项目级覆盖生效（${displayPath(cwd, effective.file)}）`)
    if (effective.problems.length > 0) {
        lines.push('配置问题（被拒绝的项目级覆盖）：')
        for (const problem of effective.problems) lines.push(`- ${problem}`)
    }
    if (result.problems.length > 0) {
        lines.push('构建问题：')
        for (const problem of result.problems) lines.push(`- ${problem}`)
    }
    lines.push(
        result.changed
            ? '下一步：用 `kb_search` 检索（引用时照抄 `path:from-to`）；改了规格/决策/文档/代码后再跑一次 `kb_index`。'
            : '下一步：直接 `kb_search` 检索；只有怀疑索引和文件不一致时才用 `kb_index({ force: true })` 强制重写。',
    )
    return lines.join('\n')
}

/** Everything `renderSearchReport` needs (all of it already computed). */
export interface SearchReportInput {
    config: KnowledgeBaseConfig
    query: string
    /** The loaded index; `manifest` must be present (the caller refused otherwise). */
    loaded: LoadedIndex & { manifest: KbManifest }
    outcome: SearchOutcome
    /** The freshness verdict the caller computed with `indexFingerprint`. */
    freshness: Freshness
}

/**
 * The `kb_search` report.
 * @param input - query, loaded index, search outcome and freshness.
 * @returns the report text (ends with a 下一步 line).
 */
export function renderSearchReport(input: SearchReportInput): string {
    const { config, query, loaded, outcome, freshness } = input
    const manifest = loaded.manifest
    const lines: string[] = []
    lines.push(`知识库检索：“${query}”`)
    lines.push(...freshness.lines)
    lines.push(`索引：${manifest.totals.documents} 篇文档 / ${manifest.totals.chunks} 块；构建于 ${manifest.builtAt}；指纹 ${fingerprintLine(manifest.fingerprint)}`)
    const filterRows: string[] = []
    if (outcome.filters.kinds !== undefined) filterRows.push(`kinds=${outcome.filters.kinds.join(',')}`)
    if (outcome.filters.pathPrefix !== undefined) filterRows.push(`pathPrefix=${outcome.filters.pathPrefix}`)
    if (outcome.filters.missionId !== undefined) filterRows.push(`missionId=${outcome.filters.missionId}`)
    if (filterRows.length > 0) lines.push(`过滤：${filterRows.join('；')}`)
    lines.push(
        `分词：${outcome.tokens.length === 0 ? '（无可检索 token）' : outcome.tokens.join(' ')}${outcome.idTokens.length === 0 ? '' : `；id 精确查找：${outcome.idTokens.join(' ')}`}`,
    )
    if (outcome.limitClamped) lines.push(`注意：limit 超过了上限 ${config.search.maxLimit}，已按 ${config.search.maxLimit} 处理。`)
    for (const warning of warnedProblems(loaded)) lines.push(`⚠️ ${warning}。这次的答案少了这些块，建议 kb_index 重建。`)
    if (manifest.staleness !== undefined) lines.push(`索引自身声明的局限：${manifest.staleness.reason}`)

    if (outcome.scored === 0) {
        lines.push('')
        lines.push(`索引里没有匹配 “${query}” 的块（候选 ${outcome.candidates} / 共 ${outcome.totalChunks} 块）。`)
        lines.push(
            '这不是"不存在"：这是**词法**索引（BM25 + CJK bigram），换个说法、换个关键词，或用 id 再搜一次可能就命中。' +
                '确认相关来源是否启用/是否被跳过，用 `kb_status`。',
        )
        lines.push(
            `下一步：改关键词或 id 重搜（如把“登录失败”拆成“登录”、“失败”）；若相关来源被停用或跳过，先修配置/范围再 \`kb_index\`；确认真没有就说“索引里没有”，不要凭记忆补。`,
        )
        return lines.join('\n')
    }
    lines.push(`命中 ${outcome.scored} 条（候选 ${outcome.candidates} / 共 ${outcome.totalChunks} 块；limit=${outcome.limit}），按分数排序：`)
    lines.push('')
    lines.push(...hitLines(outcome))
    lines.push('')
    lines.push(
        `下一步：引用照抄上面的 \`path:from-to\`（台账摘要命中的 path 指向台账文件、行号是摘要行号，用摘要里的 id 复核原文）；` +
            `要看覆盖范围/过期情况用 \`kb_status\`；${freshness.stale ? '先 `kb_index` 重建，再引用。' : '索引里没有的内容要说“索引里没有”。'}`,
    )
    return lines.join('\n')
}

/** Everything `renderStatusReport` needs (all of it already computed). */
export interface StatusReportInput {
    cwd: string
    /** The effective configuration (profile row narrowed by the project file). */
    effective: EffectiveConfig
    /** The index directory as configured (named even when nothing was built). */
    dir: string
    loaded: LoadedIndex
    /** The freshness verdict the caller computed with `indexFingerprint`. */
    freshness: Freshness
    /** The workspace fingerprint captured now (printed next to the index's). */
    current: GitFingerprint
}

/**
 * The `kb_status` report, in its two shapes: "never built" and "here is what
 * the artifact covers" (the second one carries the honest statement of what the
 * index is and is not).
 * @param input - configuration, loaded index and freshness.
 * @returns the report text (ends with a 下一步 line).
 */
export function renderStatusReport(input: StatusReportInput): string {
    const { cwd, effective, dir, loaded, freshness, current } = input
    const config = effective.config
    const lines: string[] = ['知识库状态（dsh-knowledge-base）']
    const ignored = displayPath(cwd, dir)
    if (loaded.manifest === undefined) {
        lines.push(`索引目录：${ignored}（**还没有构建**：没有 manifest.json）`)
        if (loaded.problems.length > 0) {
            lines.push('发现的问题：')
            for (const problem of loaded.problems) lines.push(`- ${problem.message}`)
        }
        lines.push(`配置里启用的来源：${config.sources.filter((source) => source.enabled).map((source) => source.id).join('、') || '（无）'}`)
        lines.push(
            '这个索引是什么：上述来源文件的**词法索引**（BM25 + 字段加权 + id 精确命中），每条命中都能回到 `path:line`；不是向量检索、不是聊天机器人、不含 git 历史。',
        )
        lines.push('下一步：调用 `kb_index` 构建索引（首次构建会遍历规格/决策/台账/文档/代码），然后用 `kb_search` 检索。')
        return lines.join('\n')
    }
    const manifest = loaded.manifest
    lines.push(`索引目录：${ignored}（${humanBytes(loaded.totalBytes)}；manifest.json / chunks.jsonl / postings.json）`)
    lines.push(`构建时间：${manifest.builtAt}；格式版本：${manifest.version}`)
    lines.push(`指纹（构建时）：${fingerprintLine(manifest.fingerprint)}`)
    lines.push(...freshness.lines)
    lines.push(`当前指纹：${fingerprintLine(current)}`)
    lines.push(
        `文档/块：${manifest.totals.documents} 篇 / ${manifest.totals.chunks} 块；跳过 ${manifest.totals.skipped} 项${
            loaded.droppedChunks > 0 ? `；⚠️ chunks.jsonl 有 ${loaded.droppedChunks} 行无法解析（建议 kb_index 重建）` : ''
        }`,
    )
    lines.push('按来源：')
    lines.push(...sourceLines(manifest, config))
    lines.push('跳过明细：')
    lines.push(...skippedLines(manifest))
    lines.push(`索引自身声明的局限：${manifest.staleness === undefined ? '无（构建时未发现被截断或不完整的覆盖）' : manifest.staleness.reason}`)
    lines.push(
        `分词与打分：CJK bigram ${config.tokenizer.cjkBigrams ? '开' : '关'}；minTokenLength=${config.tokenizer.minTokenLength}；` +
            `BM25 k1=${BM25_K1} b=${BM25_B}；字段加权 title=${config.search.fieldBoosts.title} symbols=${config.search.fieldBoosts.symbols} body=${config.search.fieldBoosts.body}；` +
            `id 精确命中加分 ${EXACT_ID_BONUS}；摘要上限 ${SNIPPET_LINES} 行 / ${SNIPPET_MAX_CHARS} 字符；limit 默认 ${config.search.limit}、上限 ${config.search.maxLimit}`,
    )
    if (effective.problems.length > 0) {
        lines.push('配置问题（被拒绝的项目级覆盖）：')
        for (const problem of effective.problems) lines.push(`- ${problem}`)
    }
    if (loaded.problems.length > 0) {
        lines.push('索引文件问题：')
        for (const problem of loaded.problems) {
            lines.push(`- ${problem.message}${problem.fatal ? '（致命：kb_search 会拒绝作答）' : '（警告：kb_search 会带警告继续作答）'}`)
        }
    }
    lines.push(
        '这个索引是什么：上述来源文件的**词法索引**（BM25 + 字段加权 + id 精确命中），引用可回到 `path:line`；' +
            'trail/plan 命中的是台账**摘要**（path 指向台账文件）。它不是：向量/语义检索（换个说法可能召回不到）、不是问答机器人（回答由模型给出，索引只提供带出处的片段）、' +
            `不是 git 历史（只看工作区当前内容与 .dsh 台账）、不含未列出的来源（node_modules、构建产物、.dsh/audit/** 等一律不在索引里）。${EXACT_ID_HINT}`,
    )
    lines.push(
        '新鲜度说明：上面的判定基于 git 指纹（HEAD/分支/diff 指纹/改动数），**未跟踪文件的内容改动不会改变指纹**，所以"一致"不等于"一定最新"；' +
            `比较时索引目录（${ignored}）被排除——重建产物不会把索引自己判成过期。要确定就跑 \`kb_index\`（它按内容比对，未变会明说"未变"且不重写文件）。`,
    )
    lines.push(
        freshness.stale
            ? '下一步：先 `kb_index` 重建索引（当前工作区已经和索引不一致），再用 `kb_search` 引用。'
            : '下一步：`kb_search` 检索；改了规格/决策/文档/代码后重新 `kb_index`；引用时照抄 `path:from-to`。',
    )
    return lines.join('\n')
}

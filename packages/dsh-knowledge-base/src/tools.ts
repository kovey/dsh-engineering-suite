/**
 * The model-facing tool surface: `kb_index`, `kb_search`, `kb_status`.
 *
 * The division of labour is the suite's usual one, applied to retrieval:
 *
 *  - the WORK is deterministic (`collectDocuments` + the index store + BM25);
 *  - the model's job is to ask a question, read the citations and say what the
 *    index does not contain — not to remember the repository;
 *  - every refusal names the fix (`kb_index` when the index is missing,
 *    `kb_index({ force: true })` when it is stale, the tokenizer when a query
 *    produced no usable token), and every report ends with a 下一步 line.
 *
 * Two reports are deliberately loud rather than convenient:
 *
 *  - **Staleness.** `kb_search` compares the fingerprint the index was built at
 *    with the workspace's current one and prints the difference BEFORE the
 *    hits. An answer drawn from a stale index may be wrong about the present,
 *    and a silently-omitted warning is exactly how that goes unnoticed.
 *  - **Gaps.** Skipped files, truncated walks and partial builds are printed,
 *    because "the index has nothing about X" is only a useful answer when the
 *    reader can see whether the index ever looked at X.
 *
 * @module dsh-knowledge-base/tools
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    expandHome,
    gitFingerprint,
    type AgentLike,
    type GitFingerprint,
    type Logger,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { KB_KINDS, type EffectiveConfig, type KnowledgeBaseConfig, type KbKind } from './config.js'
import { buildIndex, describeChange, indexDirOf, loadIndex, stalenessOf, EXACT_ID_HINT, type KbManifest, type LoadedIndex } from './index-store.js'
import {
    BM25_B,
    BM25_K1,
    EXACT_ID_BONUS,
    SNIPPET_MAX_CHARS,
    SNIPPET_LINES,
    idLikeTokens,
    searchIndex,
    tokenize,
    type SearchOutcome,
} from './search.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** How many skipped entries one report details before it says "and N more". */
const SKIP_DETAIL_LIMIT = 20

/** Everything the tools close over. */
export interface ToolDeps {
    config: KnowledgeBaseConfig
    /** Resolved per-call configuration (profile row + `<repo>/.dsh/knowledge-base.json`). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    logger: Logger
    /** Injected clock (the manifest's `builtAt`). */
    now: () => number
}

/** Arguments of `kb_index`. */
interface IndexArgs {
    force?: boolean
    only?: string[]
}

/** Arguments of `kb_search`. */
interface SearchArgs {
    query?: string
    limit?: number
    kinds?: string[]
    pathPrefix?: string
    missionId?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/** The workspace of the calling agent, refusing an unknown one. */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            '无法确定工作区：调用方 agent 没有会话目录（session.cwd）。知识库索引与检索都绑定一个具体仓库，' +
                '否则会把某个不相关的仓库当成查询对象。下一步：从有 cwd 的会话里调用，或让宿主补齐 session.header.cwd。',
        )
    }
    return cwd
}

/** Display path: workspace-relative when possible, `~`-shortened otherwise. */
function displayPath(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/')
    const home = expandHome('~')
    return target.startsWith(home) ? `~${target.slice(home.length)}` : target
}

/** Human byte size. */
function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** One-line fingerprint summary (the workspace's or the index's). */
function fingerprintLine(fingerprint: GitFingerprint): string {
    if (!fingerprint.isRepo) return '不是 git 仓库（无法用指纹判新旧）'
    const head = fingerprint.head === undefined ? 'no-commit' : fingerprint.head.slice(0, 8)
    const branch = fingerprint.branch ?? 'detached'
    const state = fingerprint.dirty ? `+${fingerprint.changedFiles} 改动` : 'clean'
    return `${branch}@${head} ${state}（diff ${fingerprint.diffDigest.slice(0, 8)}）`
}

/** The rendering of one freshness comparison. */
function freshnessLines(indexed: GitFingerprint, current: GitFingerprint): { lines: string[]; stale: boolean } {
    const staleness = stalenessOf(indexed, current)
    if (staleness.unknown) {
        return {
            lines: [`新鲜度：无法判定——${staleness.reason ?? '工作区不是 git 仓库'}；索引构建时的指纹：${fingerprintLine(indexed)}`],
            stale: false,
        }
    }
    if (!staleness.stale) return { lines: ['新鲜度：与当前工作区指纹一致（基于 git 指纹；未跟踪文件的内容改动不在指纹里，见 kb_status）'], stale: false }
    return { lines: [`⚠️ 索引可能过期：${staleness.reason ?? ''}——最近改动可能没进索引，引用前先 kb_index 重建。`], stale: true }
}

/** Per-source coverage table used by both `kb_index` and `kb_status`. */
function sourceLines(manifest: KbManifest, config: KnowledgeBaseConfig): string[] {
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
function skippedLines(manifest: KbManifest, limit = SKIP_DETAIL_LIMIT): string[] {
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
function unusableProblems(loaded: LoadedIndex): string[] {
    return loaded.problems.filter((problem) => problem.fatal).map((problem) => problem.message)
}

/** Non-fatal index problems (warned about, then answered around). */
function warnedProblems(loaded: LoadedIndex): string[] {
    return loaded.problems.filter((problem) => !problem.fatal).map((problem) => problem.message)
}

/** The refusal every `kb_search` path shares when there is no usable index. */
function refuseMissingIndex(dir: string, cwd: string, loaded?: LoadedIndex): never {
    const where = displayPath(cwd, dir)
    const detail = loaded === undefined ? '' : `\n发现的问题：\n${loaded.problems.map((problem) => `- ${problem.message}`).join('\n')}`
    throw new Error(
        `索引不存在或不可用（${where}）。知识库是**构建产物**：没有索引就没有检索，插件不会现场降级成"模糊搜索"，` +
            `也不会凭记忆回答。${detail}\n下一步：调用 \`kb_index\` 构建索引（首次构建会遍历下列来源：规格 / 决策 / 交付台账 / 规划台账 / 文档 / 代码），` +
            '然后重新 kb_search。',
    )
}

/** Render the ranked hits. */
function hitLines(outcome: SearchOutcome): string[] {
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

/**
 * Register the three knowledge-base tools.
 * @param ctx - the host context (only `tools.register` is used).
 * @param deps - configuration, stores, logger and clock.
 * @returns the registered names, the failed ones and the disposers.
 */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    register(
        defineTool({
            name: 'kb_index',
            description:
                'Build (or rebuild) the project knowledge base: a deterministic lexical index of this repository\'s own specifications (.dsh/specs), architecture decisions (.dsh/adr), delivery trail (missions and releases, summarised through the mission store), planning ledger (.dsh/plan.jsonl), repository markdown and source code (with symbols extracted by the existing go/ts/js/python extractors). Writes .dsh/kb/{manifest.json,chunks.jsonl,postings.json}; every write is atomic and ids are content-addressed, so rebuilding an unchanged repository produces byte-identical chunks and reports "unchanged" instead of pretending to have rebuilt. Reports per-source document/chunk counts, every file it skipped WITH the reason, the git fingerprint and what the index itself knows it is missing. No network, no embeddings, no model.',
            parameters: {
                force: { type: 'boolean', description: 'Rewrite the artifact even when nothing changed (default false: an unchanged repository is reported as unchanged and nothing is written).' },
                only: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Build a PARTIAL index restricted to these source ids (spec/adr/trail/plan/docs/code). The manifest then records that limitation, so kb_search says the other sources are not in the index. An unknown id is refused.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: IndexArgs = {} as IndexArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                if (!config.enabled) {
                    throw new Error(
                        'dsh-knowledge-base 已被宿主禁用（enabled=false）：不会索引也不会检索。下一步：由宿主在 profile 行里把 enabled 改回 true（项目级配置只能收紧，不能启用）。',
                    )
                }
                const only = Array.isArray(args.only) ? args.only.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()) : undefined
                if (only !== undefined && only.length > 0) {
                    const known = config.sources.map((source) => source.id)
                    const unknown = only.filter((id) => !known.includes(id))
                    if (unknown.length > 0) {
                        throw new Error(
                            `only 里出现了未配置的来源：${unknown.join('、')}。可用来源：${known.join('、')}。` +
                                '下一步：改用上列 id，或不带 only 构建完整索引（kb_index 不会把未知来源当成"没问题"跳过）。',
                        )
                    }
                }
                const store = deps.stores.for(cwd)
                const result = buildIndex({
                    cwd,
                    layout: store.layout,
                    config,
                    now: deps.now(),
                    ...(args.force === true ? { force: true } : {}),
                    ...(only === undefined || only.length === 0 ? {} : { only }),
                    logger: deps.logger.for(cwd),
                })

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
                lines.push(
                    `合计：${result.manifest.totals.documents} 篇文档 / ${result.manifest.totals.chunks} 块；跳过 ${result.manifest.totals.skipped} 项（下面是原因）`,
                )
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
                deps.logger.for(cwd).info(
                    `kb_index: ${result.changeKind}；${result.manifest.totals.documents} 篇 / ${result.manifest.totals.chunks} 块；跳过 ${result.manifest.totals.skipped} 项`,
                )
                return lines.join('\n')
            },
        }),
        'kb_index',
    )

    register(
        defineTool({
            name: 'kb_search',
            description:
                'Answer a project question from the built index: deterministic lexical retrieval (BM25 k1=1.2 b=0.75 with field boosts title>symbols>body, CJK bigrams, and an exact-id bonus so AC-003/R-7/ADR-0002/TC-001/GATE-…/RCP-… are found verbatim). Returns ranked hits with a `path:from-to` citation, a bounded snippet, the score and WHY each hit matched (which tokens hit which fields). READ-ONLY. Refuses when the index is missing (naming kb_index) and warns when the index is stale relative to the current git fingerprint — a stale answer may miss recent changes, so the warning is part of the answer, not a footnote. Filters: kinds, pathPrefix, missionId; limit is capped by the configured maxLimit.',
            parameters: {
                query: { type: 'string', required: true, description: 'What to look for: keywords, a phrase, or an id (AC-002, R-7, ADR-0001, TC-001, GATE-…, RCP-…, a mission id).' },
                limit: { type: 'number', description: 'Maximum hits (default from config; clamped to the configured maxLimit, which is stated in the report).' },
                kinds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Restrict to these kinds: spec, adr, trail, plan, docs, code. An unknown kind is refused.',
                },
                pathPrefix: { type: 'string', description: 'Restrict to chunks whose workspace-relative path starts with this prefix (e.g. "docs/" or ".dsh/specs/").' },
                missionId: { type: 'string', description: 'Restrict to one mission: its spec file, its mission directory, or documents that name it.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: SearchArgs = {} as SearchArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                if (!config.enabled) {
                    throw new Error('dsh-knowledge-base 已被宿主禁用（enabled=false）：没有可检索的索引。下一步：由宿主把 profile 的 enabled 改回 true 并 kb_index。')
                }
                const query = typeof args.query === 'string' ? args.query.trim() : ''
                if (query === '') {
                    throw new Error(
                        'kb_search 需要非空的 query。下一步：给出要查的关键词或 id，例如 `{ "query": "AC-003" }`、`{ "query": "发布流程" }`、`{ "query": "登录失败", "kinds": ["docs"] }`。',
                    )
                }
                const dir = indexDirOf(cwd, config)
                const loaded = loadIndex(dir)
                if (loaded.manifest === undefined || loaded.postings === undefined) refuseMissingIndex(dir, cwd, loaded)
                if (unusableProblems(loaded).length > 0) refuseMissingIndex(dir, cwd, loaded)

                let kinds: string[] | undefined
                if (args.kinds !== undefined) {
                    if (!Array.isArray(args.kinds)) {
                        throw new Error(`kinds 必须是字符串数组。可用值：${KB_KINDS.join('、')}。`)
                    }
                    const wanted = args.kinds.filter((kind): kind is string => typeof kind === 'string' && kind.trim() !== '').map((kind) => kind.trim())
                    const unknown = wanted.filter((kind) => !KB_KINDS.includes(kind as KbKind))
                    if (unknown.length > 0) {
                        throw new Error(`kinds 里有未知类型：${unknown.join('、')}。可用值：${KB_KINDS.join('、')}。下一步：改用上列类型，或去掉 kinds 查全部来源。`)
                    }
                    if (wanted.length > 0) kinds = wanted
                }
                let limit = config.search.limit
                if (args.limit !== undefined) {
                    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1) {
                        throw new Error(`limit 必须是不小于 1 的数（当前值 ${JSON.stringify(args.limit)}）。下一步：给一个 1..${config.search.maxLimit} 的整数，或去掉 limit 用默认 ${config.search.limit}。`)
                    }
                    limit = Math.floor(args.limit)
                }
                const current = gitFingerprint(cwd, { excludePaths: [dir] })
                const freshness = freshnessLines(loaded.manifest.fingerprint, current)
                if (tokenize(query, config.tokenizer).length === 0 && idLikeTokens(query).length === 0) {
                    throw new Error(
                        `query 里没有可检索的内容（分词后为空："${query}"）。当前分词设置：CJK bigram ${config.tokenizer.cjkBigrams ? '开' : '关'}、minTokenLength=${config.tokenizer.minTokenLength}，` +
                            '标点与长度不足 1 的片段会被丢弃。下一步：换成有实际内容的词或 id（如 "登录"、"AC-003"、"docs/"），或由宿主调低 tokenizer.minTokenLength 后重建索引。',
                    )
                }
                const outcome = searchIndex({
                    chunks: loaded.chunks,
                    postings: loaded.postings,
                    query,
                    limit,
                    maxLimit: config.search.maxLimit,
                    boosts: config.search.fieldBoosts,
                    tokenizer: config.tokenizer,
                    ...(kinds === undefined ? {} : { kinds }),
                    ...(typeof args.pathPrefix === 'string' && args.pathPrefix.trim() !== '' ? { pathPrefix: args.pathPrefix.trim() } : {}),
                    ...(typeof args.missionId === 'string' && args.missionId.trim() !== '' ? { missionId: args.missionId.trim() } : {}),
                })

                const lines: string[] = []
                lines.push(`知识库检索：“${query}”`)
                lines.push(...freshness.lines)
                lines.push(
                    `索引：${loaded.manifest.totals.documents} 篇文档 / ${loaded.manifest.totals.chunks} 块；构建于 ${loaded.manifest.builtAt}；指纹 ${fingerprintLine(loaded.manifest.fingerprint)}`,
                )
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
                if (loaded.manifest.staleness !== undefined) lines.push(`索引自身声明的局限：${loaded.manifest.staleness.reason}`)

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
                deps.logger.for(cwd).info(`kb_search: "${query}" → ${outcome.scored} 条命中（返回 ${outcome.hits.length}）${freshness.stale ? '；索引过期' : ''}`)
                return lines.join('\n')
            },
        }),
        'kb_search',
    )

    register(
        defineTool({
            name: 'kb_status',
            description:
                'READ-ONLY status of the project knowledge base: the manifest summary (builtAt, format version, git fingerprint), the artifact size, per-source document/chunk coverage with every skipped file and its reason, freshness against the CURRENT workspace fingerprint, the limitations the index recorded about itself, the tokenisation/scoring settings in force, and the honest statement of what this index is and is not (a lexical index of the listed sources with path:line citations — not embeddings, not a chatbot, not the git history). Use it before claiming the index "has nothing" about something.',
            parameters: {},
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(_args: unknown, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                const dir = indexDirOf(cwd, config)
                const loaded = loadIndex(dir)
                const lines: string[] = ['知识库状态（dsh-knowledge-base）']
                if (loaded.manifest === undefined) {
                    lines.push(`索引目录：${displayPath(cwd, dir)}（**还没有构建**：没有 manifest.json）`)
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
                lines.push(`索引目录：${displayPath(cwd, dir)}（${humanBytes(loaded.totalBytes)}；manifest.json / chunks.jsonl / postings.json）`)
                lines.push(`构建时间：${manifest.builtAt}；格式版本：${manifest.version}`)
                lines.push(`指纹（构建时）：${fingerprintLine(manifest.fingerprint)}`)
                const current = gitFingerprint(cwd, { excludePaths: [dir] })
                const freshness = freshnessLines(manifest.fingerprint, current)
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
                lines.push(
                    `索引自身声明的局限：${manifest.staleness === undefined ? '无（构建时未发现被截断或不完整的覆盖）' : manifest.staleness.reason}`,
                )
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
                        '要确定就跑 `kb_index`（它按内容比对，未变会明说"未变"且不重写文件）。',
                )
                lines.push(
                    freshness.stale
                        ? '下一步：先 `kb_index` 重建索引（当前工作区已经和索引不一致），再用 `kb_search` 引用。'
                        : '下一步：`kb_search` 检索；改了规格/决策/文档/代码后重新 `kb_index`；引用时照抄 `path:from-to`。',
                )
                return lines.join('\n')
            },
        }),
        'kb_status',
    )

    return { disposers, registered, failed }
}

/**
 * The model-facing tool surface (`kb_index`, `kb_search`, `kb_status`) and the
 * three operations behind it.
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
 * The three operations are exported because the human command (`/kb …`, see
 * `command.ts`) runs the SAME code: a citation line, a refusal or a skipped-file
 * reason cannot drift between the surface a model calls and the surface a person
 * types. The rendering itself lives in `report.ts`; nothing here formats a
 * report on its own.
 *
 * @module dsh-knowledge-base/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { type AgentLike, type Logger, type MissionStoreRegistry } from 'dsh-eng-core'
import { KB_KINDS, type EffectiveConfig, type KnowledgeBaseConfig, type KbKind } from './config.js'
import { buildIndex, indexDirOf, loadIndex, type LoadedIndex } from './index-store.js'
import { indexFingerprint } from './fingerprint.js'
import { displayPath, freshnessLines, missingIndexMessage, renderIndexReport, renderSearchReport, renderStatusReport, unusableProblems } from './report.js'
import { idLikeTokens, searchIndex, tokenize } from './search.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools and the command close over. */
export interface ToolDeps {
    config: KnowledgeBaseConfig
    /** Resolved per-call configuration (profile row + `<repo>/.dsh/knowledge-base.json`). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    logger: Logger
    /** Injected clock (the manifest's `builtAt`). */
    now: () => number
}

/** Arguments of `kb_index` (and of `/kb index`). */
export interface IndexArgs {
    force?: boolean
    only?: string[]
}

/** Arguments of `kb_search` (and of `/kb search`). */
export interface SearchArgs {
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

/** The refusal every `kb_search` path shares when there is no usable index. */
function refuseMissingIndex(dir: string, cwd: string, loaded?: LoadedIndex): never {
    throw new Error(missingIndexMessage(dir, cwd, loaded))
}

/**
 * Build (or rebuild) the index and render the report.
 * Shared by `kb_index` and `/kb index`.
 * @param deps - configuration, stores, logger and clock.
 * @param agent - the calling agent (its session workspace is the index subject).
 * @param args - `force` and the optional `only` source ids.
 * @returns the report text.
 */
export function runIndex(deps: ToolDeps, agent: AgentLike | undefined, args: IndexArgs = {}): string {
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
    deps.logger.for(cwd).info(
        `kb_index: ${result.changeKind}；${result.manifest.totals.documents} 篇 / ${result.manifest.totals.chunks} 块；跳过 ${result.manifest.totals.skipped} 项`,
    )
    return renderIndexReport({ cwd, effective, result })
}

/**
 * Search the index and render the report.
 * Shared by `kb_search` and `/kb search`.
 * @param deps - configuration, stores, logger and clock.
 * @param agent - the calling agent.
 * @param args - the query plus its filters.
 * @returns the report text.
 */
export function runSearch(deps: ToolDeps, agent: AgentLike | undefined, args: SearchArgs = {}): string {
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
    const current = indexFingerprint(cwd, dir)
    const freshness = freshnessLines(loaded.manifest.fingerprint, current, displayPath(cwd, dir))
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
    deps.logger.for(cwd).info(`kb_search: "${query}" → ${outcome.scored} 条命中（返回 ${outcome.hits.length}）${freshness.stale ? '；索引过期' : ''}`)
    return renderSearchReport({ config, query, loaded: { ...loaded, manifest: loaded.manifest }, outcome, freshness })
}

/**
 * Render the index's status.
 * Shared by `kb_status` and `/kb status`.
 * @param deps - configuration, stores, logger and clock.
 * @param agent - the calling agent.
 * @returns the report text.
 */
export function runStatus(deps: ToolDeps, agent: AgentLike | undefined): string {
    const cwd = declaredCwdOf(agent)
    const effective = deps.configFor(agent)
    const config = effective.config
    const dir = indexDirOf(cwd, config)
    const loaded = loadIndex(dir)
    const current = indexFingerprint(cwd, dir)
    // The "never built" branch has nothing to compare, so it prints no freshness
    // line — but a manifest that exists is always compared, and the comparison
    // names the directory it ignores.
    const freshness = loaded.manifest === undefined ? { lines: [], stale: false } : freshnessLines(loaded.manifest.fingerprint, current, displayPath(cwd, dir))
    return renderStatusReport({ cwd, effective, dir, loaded, freshness, current })
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
                return runIndex(deps, agentOf(exec), args)
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
                return runSearch(deps, agentOf(exec), args)
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
                return runStatus(deps, agentOf(exec))
            },
        }),
        'kb_status',
    )

    return { disposers, registered, failed }
}

/**
 * The workspace-bound operations behind every knowledge-base surface.
 *
 * Three surfaces exist — the model tools (`kb_index` / `kb_search`), the
 * person's TUI command (`/kb …`) and the optional `knowledge-base` service other
 * plugins reach through `ctx.get('knowledge-base')` — and they must all run the
 * SAME pipeline. What may differ is the rendering (`report.ts`) and the grammar
 * (`command.ts`); what must not differ is which configuration is read, which
 * refusals fire, how the artifact is built and how a query is ranked. That part
 * lives here so a citation, a refusal or a freshness warning cannot say one
 * thing to a model, another to a person and a third to a sibling plugin.
 *
 * Nothing here decides policy: the configuration is already resolved (profile
 * row narrowed by the workspace's own file) and the caller passes it in. These
 * functions refuse by throwing — the tools turn that into a tool error and the
 * IM command turns it into a readable reply.
 *
 * @module dsh-knowledge-base/operations
 */

import path from 'node:path'
import type { AgentLike, Logger, MissionStoreRegistry } from 'dsh-eng-core'
import { KB_KINDS, type EffectiveConfig, type KnowledgeBaseConfig, type KbKind } from './config.js'
import { buildIndex, indexDirOf, loadIndex, type BuildResult, type KbManifest, type LoadedIndex } from './index-store.js'
import { indexFingerprint } from './fingerprint.js'
import { displayPath, freshnessLines, missingIndexMessage, unusableProblems, type Freshness } from './report.js'
import { idLikeTokens, searchIndex, tokenize, type SearchOutcome } from './search.js'

/** What the operations need from the plugin (the tools add their clock). */
export interface OperationDeps {
    /** Resolved configuration for a calling agent's workspace. */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    logger: Logger
}

/** Arguments of one index build (the `kb_index` / `/kb index` surface). */
export interface IndexOptions {
    force?: boolean
    only?: string[]
}

/** Arguments of one query (the `kb_search` / `/kb search` / IM surface). */
export interface SearchOptions {
    query?: string
    limit?: number
    kinds?: string[]
    pathPrefix?: string
    missionId?: string
}

/** Everything a completed query observed, ready to be rendered. */
export interface SearchResult {
    config: KnowledgeBaseConfig
    loaded: LoadedIndex & { manifest: KbManifest }
    outcome: SearchOutcome
    freshness: Freshness
}

/** The work of one build: the workspace, its effective configuration and the clock. */
export interface IndexBuildInput {
    cwd: string
    effective: EffectiveConfig
    stores: MissionStoreRegistry
    logger: Logger
    now: number
    options?: IndexOptions
}

/** The work of one query: the workspace, its effective configuration and the arguments. */
export interface SearchInput extends Pick<IndexBuildInput, 'cwd' | 'effective' | 'stores'> {
    options?: SearchOptions
}

/** The refusal every surface shares when the host disabled the plugin. */
function disabledRefusal(what: 'index' | 'search'): never {
    throw new Error(
        what === 'index'
            ? 'dsh-knowledge-base 已被宿主禁用（enabled=false）：不会索引也不会检索。下一步：由宿主在 profile 行里把 enabled 改回 true（项目级配置只能收紧，不能启用）。'
            : 'dsh-knowledge-base 已被宿主禁用（enabled=false）：没有可检索的索引。下一步：由宿主把 profile 的 enabled 改回 true 并 kb_index。',
    )
}

/** The `only` list, validated against the configured source ids (empty = all). */
export function onlyOption(options: IndexOptions, config: KnowledgeBaseConfig): string[] | undefined {
    const only = Array.isArray(options.only)
        ? options.only.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
        : undefined
    if (only === undefined || only.length === 0) return undefined
    const known = config.sources.map((source) => source.id)
    const unknown = only.filter((id) => !known.includes(id))
    if (unknown.length > 0) {
        throw new Error(
            `only 里出现了未配置的来源：${unknown.join('、')}。可用来源：${known.join('、')}。` +
                '下一步：改用上列 id，或不带 only 构建完整索引（kb_index 不会把未知来源当成"没问题"跳过）。',
        )
    }
    return only
}

/**
 * Build (or refresh) the index of one workspace.
 * @param input - workspace, effective configuration, stores, clock and options.
 * @returns the finished build (reports and change kind included).
 */
export function buildWorkspaceIndex(input: IndexBuildInput): BuildResult {
    const { cwd, effective, stores, logger, now } = input
    const config = effective.config
    if (!config.enabled) disabledRefusal('index')
    const options = input.options ?? {}
    const only = onlyOption(options, config)
    return buildIndex({
        cwd,
        layout: stores.for(cwd).layout,
        config,
        now,
        ...(options.force === true ? { force: true } : {}),
        ...(only === undefined ? {} : { only }),
        logger: logger.for(cwd),
    })
}

/** The query, refusing an empty one with the fix (shared by every search surface). */
function requiredQuery(options: SearchOptions): string {
    const query = typeof options.query === 'string' ? options.query.trim() : ''
    if (query === '') {
        throw new Error(
            'kb_search 需要非空的 query。下一步：给出要查的关键词或 id，例如 `{ "query": "AC-003" }`、`{ "query": "发布流程" }`、`{ "query": "登录失败", "kinds": ["docs"] }`。',
        )
    }
    return query
}

/** The `kinds` filter, validated against the known kinds. */
function kindsOption(options: SearchOptions): string[] | undefined {
    if (options.kinds === undefined) return undefined
    if (!Array.isArray(options.kinds)) throw new Error(`kinds 必须是字符串数组。可用值：${KB_KINDS.join('、')}。`)
    const wanted = options.kinds.filter((kind): kind is string => typeof kind === 'string' && kind.trim() !== '').map((kind) => kind.trim())
    const unknown = wanted.filter((kind) => !KB_KINDS.includes(kind as KbKind))
    if (unknown.length > 0) {
        throw new Error(`kinds 里有未知类型：${unknown.join('、')}。可用值：${KB_KINDS.join('、')}。下一步：改用上列类型，或去掉 kinds 查全部来源。`)
    }
    return wanted.length === 0 ? undefined : wanted
}

/** The requested limit, floored and validated (a cap is applied by `searchIndex`). */
function limitOption(options: SearchOptions, config: KnowledgeBaseConfig): number {
    if (options.limit === undefined) return config.search.limit
    if (typeof options.limit !== 'number' || !Number.isFinite(options.limit) || options.limit < 1) {
        throw new Error(
            `limit 必须是不小于 1 的数（当前值 ${JSON.stringify(options.limit)}）。下一步：给一个 1..${config.search.maxLimit} 的整数，或去掉 limit 用默认 ${config.search.limit}。`,
        )
    }
    return Math.floor(options.limit)
}

/**
 * Load the workspace's index and rank one query against it.
 *
 * Refusals are the tool surface's own: a missing/unusable artifact names
 * `kb_index`, an unknown kind names the known ones, a limit below one names the
 * default, and a query with nothing tokenisable explains the tokenizer in force.
 * @param input - workspace, effective configuration, stores and query arguments.
 * @returns the loaded artifact, the ranked outcome and the freshness verdict.
 */
export function searchWorkspace(input: SearchInput): SearchResult {
    const { cwd, effective, stores } = input
    const config = effective.config
    if (!config.enabled) disabledRefusal('search')
    const options = input.options ?? {}
    const query = requiredQuery(options)
    const dir = indexDirOf(cwd, config)
    const loaded = loadIndex(dir)
    if (loaded.manifest === undefined || loaded.postings === undefined) throw new Error(missingIndexMessage(dir, cwd, loaded))
    if (unusableProblems(loaded).length > 0) throw new Error(missingIndexMessage(dir, cwd, loaded))
    const kinds = kindsOption(options)
    const limit = limitOption(options, config)
    const current = indexFingerprint(cwd, dir)
    const freshness = freshnessLines(loaded.manifest.fingerprint, current, displayPath(cwd, dir))
    if (tokenize(query, config.tokenizer).length === 0 && idLikeTokens(query).length === 0) {
        throw new Error(
            `query 里没有可检索的内容（分词后为空："${query}"）。当前分词设置：CJK bigram ${config.tokenizer.cjkBigrams ? '开' : '关'}、minTokenLength=${config.tokenizer.minTokenLength}，` +
                '标点与长度不足 1 的片段会被丢弃。下一步：换成有实际内容的词或 id（如 "登录"、"AC-003"、"docs/"），或由宿主调低 tokenizer.minTokenLength 后重建索引。',
        )
    }
    // The mission filter matches the specification and mission directory by
    // PATH, so it needs this workspace's trail root (namespace-first) rather
    // than a literal legacy prefix.
    const trailDir = path.relative(cwd, stores.for(cwd).layout.rootDir).split(path.sep).join('/')
    const outcome = searchIndex({
        chunks: loaded.chunks,
        postings: loaded.postings,
        query,
        limit,
        maxLimit: config.search.maxLimit,
        boosts: config.search.fieldBoosts,
        tokenizer: config.tokenizer,
        ...(kinds === undefined ? {} : { kinds }),
        ...(typeof options.pathPrefix === 'string' && options.pathPrefix.trim() !== '' ? { pathPrefix: options.pathPrefix.trim() } : {}),
        ...(typeof options.missionId === 'string' && options.missionId.trim() !== '' ? { missionId: options.missionId.trim() } : {}),
        trailDir,
    })
    return { config, loaded: { ...loaded, manifest: loaded.manifest }, outcome, freshness }
}

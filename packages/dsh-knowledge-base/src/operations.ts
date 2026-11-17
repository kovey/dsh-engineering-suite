/**
 * The workspace-bound operations behind every knowledge-base surface.
 *
 * The model tools (`kb_index` / `kb_search`), the person's TUI command (`/kb …`)
 * and the optional `knowledge-base` service all run the SAME pipeline: what may
 * differ is the rendering (`report.ts`) and the grammar (`command.ts`); what
 * must not differ is which configuration is read, which refusals fire, how the
 * artifact is built, how a stale index is healed and how a query is ranked. That
 * part lives here so a citation, a refusal or a freshness warning cannot say one
 * thing to a model, another to a person and a third to a sibling plugin. Nothing
 * here decides policy: the configuration is already resolved and the caller
 * passes it in; refusals throw, and each surface renders them its own way.
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
import { claimAutoRebuild, finishAutoRebuild, noteBuildCompleted, type SelfHealInfo } from './freshness.js'

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
    /** The automatic rebuild attempted before ranking (absent when fresh). */
    selfHeal?: SelfHealInfo
    /** The stale verdict that triggered it (names WHY the rebuild ran). */
    staleBefore?: Freshness
}

/** The work of one build: the workspace, its effective configuration and the clock. */
export interface IndexBuildInput {
    cwd: string
    effective: EffectiveConfig
    stores: MissionStoreRegistry
    /** Absent is a diagnostic sink-less build (the auto-rebuild path may have none). */
    logger?: Logger
    now: number
    options?: IndexOptions
}

/** The work of one query: the workspace, its effective configuration and the arguments. */
export interface SearchInput extends Pick<IndexBuildInput, 'cwd' | 'effective' | 'stores'> {
    options?: SearchOptions
    /** Diagnostic sink: a failed automatic rebuild is warned about here. */
    logger?: Logger
    /** Injected clock for the freshness/cooldown decision (defaults to `Date.now`). */
    now?: () => number
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
    const result = buildIndex({
        cwd,
        layout: stores.for(cwd).layout,
        config,
        now,
        ...(options.force === true ? { force: true } : {}),
        ...(only === undefined ? {} : { only }),
        ...(logger === undefined ? {} : { logger: logger.for(cwd) }),
    })
    // ANY real build restarts the self-heal cooldown: a search right after a full
    // build has nothing to heal, and must not rebuild again just to learn that.
    noteBuildCompleted(cwd, now)
    return result
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

/** The query and filters, validated BEFORE anything is read or written. */
function searchOptions(options: SearchOptions, config: KnowledgeBaseConfig): { query: string; kinds?: string[]; limit: number } {
    const query = requiredQuery(options)
    const kinds = kindsOption(options)
    const limit = limitOption(options, config)
    if (tokenize(query, config.tokenizer).length === 0 && idLikeTokens(query).length === 0) {
        throw new Error(
            `query 里没有可检索的内容（分词后为空："${query}"）。当前分词设置：CJK bigram ${config.tokenizer.cjkBigrams ? '开' : '关'}、minTokenLength=${config.tokenizer.minTokenLength}，` +
                '标点与长度不足 1 的片段会被丢弃。下一步：换成有实际内容的词或 id（如 "登录"、"AC-003"、"docs/"），或由宿主调低 tokenizer.minTokenLength 后重建索引。',
        )
    }
    return { query, limit, ...(kinds === undefined ? {} : { kinds }) }
}

/** A loaded index that is guaranteed answerable (manifest AND postings present). */
type UsableIndex = LoadedIndex & { manifest: KbManifest; postings: NonNullable<LoadedIndex['postings']> }

/** Load the workspace's index, refusing when it cannot be answered from. */
function usableIndex(cwd: string, dir: string): UsableIndex {
    const loaded = loadIndex(dir)
    if (loaded.manifest === undefined || loaded.postings === undefined) throw new Error(missingIndexMessage(dir, cwd, loaded))
    if (unusableProblems(loaded).length > 0) throw new Error(missingIndexMessage(dir, cwd, loaded))
    return { ...loaded, manifest: loaded.manifest, postings: loaded.postings }
}

/**
 * The ONE automatic rebuild (the `service.reindex` pipeline, incremental and
 * atomic), behind the cooldown/exclusivity claim. Failures are returned, never
 * thrown: a read must not fail because a maintenance step it did not ask for
 * failed.
 */
function autoRebuild(input: { cwd: string; effective: EffectiveConfig; stores: MissionStoreRegistry; logger?: Logger; now: number }): SelfHealInfo {
    const claim = claimAutoRebuild(input.cwd, input.effective.config.freshness.cooldownMs, input.now)
    if (!claim.ok) return { outcome: 'skipped', reason: claim.reason }
    let built: BuildResult
    try {
        built = buildWorkspaceIndex(input)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        try {
            input.logger?.for(input.cwd).warn(`kb_search: 索引过期且自动重建失败：${reason}；返回旧索引的结果（可能缺少最近改动）`)
        } catch {
            // A log sink that throws must not turn a readable answer into a tool error.
        }
        return { outcome: 'failed', error: reason }
    } finally {
        finishAutoRebuild(input.cwd, input.now)
    }
    try {
        input.logger?.for(input.cwd).info(`kb_search: 索引过期，已自动重建（${built.manifest.totals.chunks} 块；${built.changeKind}）`)
    } catch {
        // Same for the success line: the answer is what matters.
    }
    return { outcome: 'rebuilt', changeKind: built.changeKind, chunks: built.manifest.totals.chunks }
}

/** What one search path observed about the artifact's age (and what it did about it). */
interface IndexView {
    loaded: UsableIndex
    freshness: Freshness
    selfHeal?: SelfHealInfo
    staleBefore?: Freshness
}

/**
 * Compare the index with the workspace, REBUILDING once when it is stale.
 *
 * The rebuild happens before ranking, so a successful heal means the answer
 * includes the edit that made the index stale. A failed rebuild keeps the old
 * artifact (a warned answer beats a tool error) and names the reason.
 */
function viewOf(input: SearchInput, initial: UsableIndex, dir: string): IndexView {
    const ignored = displayPath(input.cwd, dir)
    const staleBefore = freshnessLines(initial.manifest.fingerprint, indexFingerprint(input.cwd, dir), ignored)
    if (!staleBefore.stale) return { loaded: initial, freshness: staleBefore }
    const now = (input.now ?? Date.now)()
    const logger = input.logger
    const selfHeal = autoRebuild({ cwd: input.cwd, effective: input.effective, stores: input.stores, ...(logger === undefined ? {} : { logger }), now })
    if (selfHeal.outcome !== 'rebuilt') return { loaded: initial, freshness: staleBefore, selfHeal, staleBefore }
    let rebuilt: UsableIndex
    try {
        rebuilt = usableIndex(input.cwd, dir)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { loaded: initial, freshness: staleBefore, selfHeal: { outcome: 'failed', error: `重建后索引仍不可用：${reason}` }, staleBefore }
    }
    const freshness = freshnessLines(rebuilt.manifest.fingerprint, indexFingerprint(input.cwd, dir), ignored)
    return { loaded: rebuilt, freshness, selfHeal, staleBefore }
}

/**
 * Load the workspace's index and rank one query against it.
 *
 * Refusals are the tool surface's own: a missing/unusable artifact names
 * `kb_index`, an unknown kind names the known ones, a limit below one names the
 * default, and a query with nothing tokenisable explains the tokenizer in force.
 * A stale index is rebuilt before ranking (see {@link viewOf}); the result says
 * which happened so every surface can print it.
 * @param input - workspace, effective configuration, stores, logger, clock and query arguments.
 * @returns the artifact, the ranked outcome, the freshness verdict and the self-heal report.
 */
export function searchWorkspace(input: SearchInput): SearchResult {
    const { cwd, effective, stores } = input
    const config = effective.config
    if (!config.enabled) disabledRefusal('search')
    const options = input.options ?? {}
    const { query, kinds, limit } = searchOptions(options, config)
    const dir = indexDirOf(cwd, config)
    const view = viewOf(input, usableIndex(cwd, dir), dir)
    // The mission filter matches the specification and mission directory by PATH,
    // so it needs this workspace's trail root (namespace-first).
    const trailDir = path.relative(cwd, stores.for(cwd).layout.rootDir).split(path.sep).join('/')
    const outcome = searchIndex({
        chunks: view.loaded.chunks,
        postings: view.loaded.postings,
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
    return {
        config,
        loaded: view.loaded,
        outcome,
        freshness: view.freshness,
        ...(view.selfHeal === undefined ? {} : { selfHeal: view.selfHeal }),
        ...(view.staleBefore === undefined ? {} : { staleBefore: view.staleBefore }),
    }
}

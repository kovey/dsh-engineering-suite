/**
 * The optional `knowledge-base` service.
 *
 * Why a service and not an import: the rest of the suite must answer "what does
 * this repository's trail say" without taking a dependency on this package
 * (a cross-package import would also make the knowledge base a hard requirement
 * of every plugin that merely wants to refresh it). So the plugin `provide`s one
 * small object through cordis — `ctx.get('knowledge-base')` — and every caller
 * treats it as OPTIONAL: a host that never mounted this plugin simply gets
 * `undefined`, and the caller carries on. That is the contract the delivery gate
 * relies on when it refreshes the index after a receipt: best effort, never a
 * reason to fail a delivery.
 *
 * The two methods are the SAME operations the tools run (`operations.ts`), not a
 * second implementation:
 *
 *  - `reindex(cwd, options?)` builds/refreshes that workspace's artifact and
 *    answers with what happened (`changeKind`, document/chunk counts) so a
 *    caller can say "索引已更新（N 块）" or "未变" truthfully;
 *  - `search(input)` runs one query — the workspace is part of the input
 *    because a single process serves several repositories — and answers with
 *    the same `SearchOutcome` the `kb_search` report is rendered from.
 *
 * Refusals are thrown (missing index, unknown kind, empty query): a caller with
 * a tool-error channel surfaces them as errors, and the IM command turns the
 * same message into a readable reply. The service never decides policy for the
 * caller and never touches the network, an embedding model or a vector store.
 *
 * @module dsh-knowledge-base/service
 */

import type { Logger, MissionStoreRegistry } from 'dsh-eng-core'
import { resolveEffectiveConfig, type EffectiveConfig, type KnowledgeBaseConfig } from './config.js'
import { buildWorkspaceIndex, searchWorkspace, type IndexOptions, type SearchOptions } from './operations.js'
import type { SearchOutcome } from './search.js'

/** The service name other plugins look up (`ctx.get('knowledge-base')`). */
export const KNOWLEDGE_BASE_SERVICE = 'knowledge-base'

/** What one `reindex` did, in the terms a caller can print. */
export interface KnowledgeBaseReindexResult {
    /**
     * `unchanged` / `created` / `content` / `coverage` / `fingerprint` … (the
     * build's own vocabulary), or `disabled` when the workspace's configuration
     * turns the plugin off — that is a configured state, NOT a failed rebuild.
     */
    changeKind: string
    /** Whether any artifact byte was written. */
    changed: boolean
    /** Absolute index directory (`''` when the workspace disabled the index). */
    dir: string
    documents: number
    chunks: number
    skipped: number
}

/** The one query shape: the workspace is explicit (one process, many repositories). */
export interface KnowledgeBaseSearchInput extends SearchOptions {
    /** Absolute workspace root whose index is queried. */
    cwd: string
}

/** The optional service surface. */
export interface KnowledgeBaseService {
    /** Build (or refresh) the index of `cwd`. Resolves with what happened. */
    reindex(cwd: string, options?: IndexOptions): Promise<KnowledgeBaseReindexResult>
    /** Rank one query against the index of `input.cwd`. Throws when there is no usable index. */
    search(input: KnowledgeBaseSearchInput): SearchOutcome
}

/** Everything the service closes over. */
export interface KnowledgeBaseServiceDeps {
    /** The resolved profile row (the ceiling for every workspace). */
    config: KnowledgeBaseConfig
    stores: MissionStoreRegistry
    logger: Logger
    /** Injected clock (defaults to `Date.now`). */
    now?: () => number
}

/** What providing the service managed to do. */
export interface KnowledgeBaseServiceRegistration {
    service: KnowledgeBaseService
    /** Cordis' withdraw function, when the host could provide the service. */
    dispose?: () => void
    /** Why it is not exposed (or not withdrawable), for the log. */
    problem?: string
}

/** The workspace, refusing a value that cannot name one. */
function requireCwd(cwd: unknown): string {
    if (typeof cwd !== 'string' || cwd.trim() === '') {
        throw new Error('knowledge-base 服务需要工作区路径（cwd）：索引与检索都绑定一个具体仓库，不会回退到 process.cwd()。')
    }
    return cwd.trim()
}

/** The effective configuration of one workspace (profile row narrowed by its own file). */
function configAt(deps: KnowledgeBaseServiceDeps, cwd: string): EffectiveConfig {
    return resolveEffectiveConfig(deps.config, deps.stores.for(cwd).layout, deps.logger)
}

/**
 * Build the service (without providing it — `provide...` is the host-facing half).
 * @param deps - profile configuration, stores, logger and optional clock.
 * @returns the service object a caller receives from `ctx.get('knowledge-base')`.
 */
export function createKnowledgeBaseService(deps: KnowledgeBaseServiceDeps): KnowledgeBaseService {
    const now = deps.now ?? (() => Date.now())
    return {
        async reindex(cwd: string, options: IndexOptions = {}): Promise<KnowledgeBaseReindexResult> {
            const workspace = requireCwd(cwd)
            const effective = configAt(deps, workspace)
            // A project may switch the knowledge base off; that is a decision, not
            // a failed rebuild, so it must never read as "更新失败" to a caller.
            if (!effective.config.enabled) return { changeKind: 'disabled', changed: false, dir: '', documents: 0, chunks: 0, skipped: 0 }
            const result = buildWorkspaceIndex({ cwd: workspace, effective, stores: deps.stores, logger: deps.logger, now: now(), options })
            deps.logger.for(workspace).info(
                `knowledge-base.reindex: ${result.changeKind}；${result.manifest.totals.documents} 篇 / ${result.manifest.totals.chunks} 块；跳过 ${result.manifest.totals.skipped} 项`,
            )
            return {
                changeKind: result.changeKind,
                changed: result.changed,
                dir: result.dir,
                documents: result.manifest.totals.documents,
                chunks: result.manifest.totals.chunks,
                skipped: result.manifest.totals.skipped,
            }
        },
        search(input: KnowledgeBaseSearchInput): SearchOutcome {
            const workspace = requireCwd(input?.cwd)
            const effective = configAt(deps, workspace)
            const { outcome, freshness } = searchWorkspace({ cwd: workspace, effective, stores: deps.stores, options: input })
            deps.logger
                .for(workspace)
                .info(`knowledge-base.search: "${outcome.query}" → ${outcome.scored} 条命中（返回 ${outcome.hits.length}）${freshness.stale ? '；索引过期' : ''}`)
            return outcome
        },
    }
}

/**
 * Expose the service through cordis, as an OPTIONAL service.
 *
 * `provide` is read off the context (never injected): a minimal host without the
 * reflection seam must still load this plugin, and a host that cannot provide is
 * a LOGGED limitation — the tools and the TUI command keep working, and a caller
 * that looked the service up simply gets `undefined`.
 * @param context - the host context (only `provide` is used).
 * @param deps - profile configuration, stores, logger and optional clock.
 * @returns the service, its withdraw function and any problem worth logging.
 */
export function provideKnowledgeBaseService(
    context: { provide?: unknown },
    deps: KnowledgeBaseServiceDeps,
): KnowledgeBaseServiceRegistration {
    const service = createKnowledgeBaseService(deps)
    const provide = context.provide
    if (typeof provide !== 'function') {
        return { service, problem: '宿主没有 ctx.provide：knowledge-base 服务未暴露（tools 与 /kb 命令不受影响，调用方按"服务不存在"处理）' }
    }
    try {
        const disposer = (provide as (name: string, value: unknown) => unknown).call(context, KNOWLEDGE_BASE_SERVICE, service)
        return typeof disposer === 'function'
            ? { service, dispose: disposer as () => void }
            : { service, problem: 'ctx.provide 没有返回 disposer：服务已暴露，但插件卸载时无法撤回它' }
    } catch (error) {
        return { service, problem: `暴露 knowledge-base 服务失败（调用方按"服务不存在"处理）：${error instanceof Error ? error.message : String(error)}` }
    }
}

/**
 * dsh-knowledge-base — the project knowledge base.
 *
 * The suite produces a lot of durable evidence about a repository: the
 * specification (`dsh-spec-gate`), the decisions (`adr_record`), the mission
 * trail and receipts (`dsh-evidence-gate`), the planning ledger, the
 * documentation and the code itself. This plugin turns them into an artifact
 * the model can actually retrieve from — `.dsh/kb/` — and gives it three tools:
 * `kb_index` builds it, `kb_search` answers with `path:line` citations,
 * `kb_status` says what it covers and what it knows it missed.
 *
 * What it is NOT, deliberately:
 *
 *  - **no embeddings, no network, no model call.** Retrieval is lexical
 *    (BM25 + field boosts + an exact-id bonus) and deterministic: the same
 *    index and the same query give the same hits, in the same order, so an
 *    answer can be re-checked after the fact;
 *  - **no vector database.** The artifact is three plain files a reviewer can
 *    read and diff, not an opaque store;
 *  - **no silent gaps.** Every file the collectors do not cover is reported
 *    with a reason, and a partial build records its own limitation in the
 *    manifest, because "the index has nothing about X" must never be
 *    indistinguishable from "the index never looked at X".
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-knowledge-base
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, type AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig, type EffectiveConfig, type KnowledgeBaseConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'

export const name = 'dsh-knowledge-base'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assembly?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    effect: (execute: () => (() => void) | void) => void
}

/** The session workspace of an agent, or `undefined` (never `process.cwd()`). */
function workspaceOf(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Register the plugin.
 * @param ctx - the cordis context.
 * @param config - the loader row's `config` (untrusted).
 */
export function apply(ctx: Context, config: unknown = {}): void {
    const resolved = resolveConfig(config)
    if (!resolved.enabled) return
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const deps: ToolDeps = {
            config: resolved,
            // Profile config is the ceiling; a workspace narrows it through its
            // own `.dsh/knowledge-base.json`. A session without a workspace gets
            // the profile row rather than a `process.cwd()` guess: indexing the
            // harness's own working directory is not what any caller meant.
            configFor: (agent: AgentLike | undefined): EffectiveConfig => {
                const cwd = workspaceOf(agent)
                if (cwd === undefined) return { config: resolved, source: 'profile', file: '', problems: [] }
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
            },
            stores,
            logger: log,
            now: () => Date.now(),
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) log.warn(`tools that failed to register: ${tools.failed.join(', ')}`)

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // The section is rendered per ASSEMBLY context: one profile
                    // serves several repositories, and a section that named one
                    // repository's index directory for all of them would be
                    // wrong in the way that matters (the model would cite an
                    // index that is not in front of it).
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            const cwd = workspaceOf(scope)
                            if (cwd === undefined) return sectionText(resolved)
                            const effective = resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
                            return sectionText(effective.config, effective.source === 'project' ? effective.file : undefined)
                        } catch {
                            return sectionText(resolved)
                        }
                    },
                }),
            )
        }

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    log.warn('disposer failed:', error)
                }
            }
        })

        log.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}; indexDir=${resolved.indexDir}; sources=${resolved.sources
                .filter((source) => source.enabled)
                .map((source) => source.id)
                .join(',')}; limit=${resolved.search.limit}/${resolved.search.maxLimit}; cjkBigrams=${resolved.tokenizer.cjkBigrams})`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

export type { KnowledgeBaseConfig, EffectiveConfig }

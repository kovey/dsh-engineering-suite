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
import { type AgentLike } from 'dsh-eng-core'
import { type KnowledgeBaseConfig } from './config.js'
import { indexDirOf, loadIndex } from './index-store.js'
import { indexFingerprint } from './fingerprint.js'
import { displayPath, freshnessLines, renderIndexReport, renderSearchReport, renderStatusReport } from './report.js'
import { buildWorkspaceIndex, searchWorkspace, type IndexOptions, type OperationDeps, type SearchOptions } from './operations.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools and the command close over. */
export interface ToolDeps extends OperationDeps {
    config: KnowledgeBaseConfig
    /** Injected clock (the manifest's `builtAt`). */
    now: () => number
}

/** Arguments of `kb_index` (and of `/kb index`). */
export type IndexArgs = IndexOptions

/** Arguments of `kb_search` (and of `/kb search`). */
export type SearchArgs = SearchOptions

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
    // The build itself lives in `operations.ts`: the service a sibling plugin
    // reaches through `ctx.get('knowledge-base')` runs the same function.
    const result = buildWorkspaceIndex({ cwd, effective, stores: deps.stores, logger: deps.logger, now: deps.now(), options: args })
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
    const { config, loaded, outcome, freshness } = searchWorkspace({ cwd, effective, stores: deps.stores, options: args })
    deps.logger.for(cwd).info(`kb_search: "${outcome.query}" → ${outcome.scored} 条命中（返回 ${outcome.hits.length}）${freshness.stale ? '；索引过期' : ''}`)
    return renderSearchReport({ config, query: outcome.query, loaded, outcome, freshness })
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
                'Build (or rebuild) the project knowledge base: a deterministic lexical index of this repository\'s own specifications (.dsh/specs), architecture decisions (.dsh/adr), delivery trail (missions and releases, summarised through the mission store), planning ledger (.dsh/plan.jsonl), repository markdown and source code (with symbols extracted by the existing go/ts/js/python extractors). Writes .dsh/kb/{manifest.json,chunks.jsonl,postings.json}; every write is atomic and ids are content-addressed, so rebuilding an unchanged repository produces byte-identical chunks and reports "unchanged" instead of pretending to have rebuilt. Three facts are judged separately and never merged, in this precedence: a missing manifest (first build); the COVERAGE the caller asked for (the enabled sources, `only`) differing from the coverage the manifest records — reported as 来源覆盖变了, which rewrites the manifest and, when the document set really differs, the two content artifacts (a partial → full transition can never be reported as "nothing changed", and the manifest always ends up recording what was just requested); a moved content/fingerprint (see below). When the indexed content is unchanged but the recorded git fingerprint no longer matches the workspace (a tracked file no source covers was edited, e.g. .gitignore), it refreshes ONLY manifest.json\'s fingerprint and builtAt — reported as its own change kind, never as "unchanged" and never as a forced rebuild — so kb_search/kb_status stop calling the index stale without pretending the content moved. Reports per-source document/chunk counts, every file it skipped WITH the reason, the git fingerprint and what the index itself knows it is missing. No network, no embeddings, no model.',
            parameters: {
                force: { type: 'boolean', description: 'Rewrite the artifact even when nothing changed (default false: an unchanged repository — same coverage, same content, same fingerprint — is reported as unchanged and nothing is written; a moved fingerprint is refreshed on its own, without force).' },
                only: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Build a PARTIAL index restricted to these source ids (spec/adr/trail/plan/docs/code). The manifest records that limitation, so kb_search says the other sources are not in the index. A later build whose requested coverage differs from what the manifest records reports it as its own change kind (来源覆盖变了) and rewrites the manifest — so the recorded coverage always matches the last request. An unknown id is refused before anything is written.',
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
                'READ-ONLY status of the project knowledge base: the manifest summary (builtAt, format version, git fingerprint), the artifact size, per-source document/chunk coverage with every skipped file and its reason, freshness against the CURRENT workspace fingerprint, the limitations the index recorded about itself, the tokenisation/scoring settings in force, and the honest statement of what this index is and is not (a lexical index of the listed sources with path:line citations — not embeddings, not a chatbot, not the git history). Coverage is read from what is ACTUALLY indexed: a source the manifest does not list whose documents are in chunks.jsonl is reported as a manifest/artifact disagreement (naming kb_index as the fix) instead of being called "not in this index" — and a partial build\'s own limitation is stated whenever the manifest really records one. Use it before claiming the index "has nothing" about something.',
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

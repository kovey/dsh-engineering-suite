/**
 * Best-effort knowledge-base refresh after a delivery.
 *
 * A receipt says "this mission was delivered from this tree". The project's
 * knowledge base is a *build artifact* over that tree, so a delivery is exactly
 * the moment it starts describing yesterday — and expecting every agent to
 * remember a second `kb_index` call after `mission_complete` is how an index
 * silently rots. So the delivery path asks the knowledge-base SERVICE
 * (`ctx.get('knowledge-base')`, optional: a host without that plugin simply has
 * none) to reindex the workspace, and appends one line to the delivery output
 * saying what happened.
 *
 * The hard rule, and the reason this file is defensive everywhere: **the refresh
 * can never change the verdict**. It runs AFTER `finalizeDelivery` wrote the
 * receipt and set `delivered`, it is not awaited by any check, and every failure
 * — a throwing accessor, an older service without `reindex`, a refusal, a
 * timeout — is a logged warning plus a `更新失败：…` note. There is no path here
 * that throws, blocks, retries a delivery or touches the mission state.
 *
 * @module dsh-evidence-gate/kb-sync
 */

import type { Logger } from 'dsh-eng-core'

/** The service name the knowledge-base plugin provides. */
export const KNOWLEDGE_BASE_SERVICE = 'knowledge-base'

/**
 * How long the refresh may take.
 *
 * A full build of a medium repository is seconds (measured ~1.6 s for ~1100
 * documents), so 30 s is generous; a build that takes longer is reported as a
 * timeout and keeps running on its own (its writes are atomic), which is still
 * better than a receipt that waits for it.
 */
export const KNOWLEDGE_BASE_REINDEX_TIMEOUT_MS = 30_000

/** Structural view of the `knowledge-base` service (deliberately not an import). */
export interface KnowledgeBaseServiceLike {
    /** Rebuild the index of `cwd`; resolves with what happened. */
    reindex?: (cwd: string, options?: { force?: boolean }) => unknown
}

/** What the delivery path needs to find the service and log the outcome. */
export interface KnowledgeBaseSyncDeps {
    /**
     * Read at call time (`ctx.get('knowledge-base')`), so a service mounted
     * after this plugin still gets used and a host without it is just `undefined`.
     */
    knowledgeBase?: () => KnowledgeBaseServiceLike | undefined
    /** Diagnostic sink: one line on success, a warning on failure. */
    logger?: Logger
    /** Override of {@link KNOWLEDGE_BASE_REINDEX_TIMEOUT_MS} (tests, and a host that knows better). */
    knowledgeBaseTimeoutMs?: number
}

/** The fields this file reads off whatever `reindex` resolved with. */
interface ReindexOutcome {
    changeKind?: string
    chunks?: number
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The service, when the host mounted a usable one (a throwing accessor is "none"). */
function serviceOf(deps: KnowledgeBaseSyncDeps): KnowledgeBaseServiceLike | undefined {
    try {
        const service = deps.knowledgeBase?.()
        if (typeof service !== 'object' || service === null) return undefined
        return typeof service.reindex === 'function' ? service : undefined
    } catch {
        return undefined
    }
}

/** The outcome fields, read defensively (the service lives in another package). */
function outcomeOf(value: unknown): ReindexOutcome {
    if (typeof value !== 'object' || value === null) return {}
    const raw = value as Record<string, unknown>
    return {
        ...(typeof raw['changeKind'] === 'string' ? { changeKind: raw['changeKind'] } : {}),
        ...(typeof raw['chunks'] === 'number' && Number.isFinite(raw['chunks']) ? { chunks: raw['chunks'] } : {}),
    }
}

/** Resolve with the promise's value, or reject after `ms` (the work keeps going). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`超时（${ms}ms 内未完成，索引重建仍在后台继续）`)), ms)
        timer.unref?.()
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
    })
}

/**
 * The one Chinese line reporting the refresh, using the build's own vocabulary.
 *
 * `unchanged` and `fingerprint` are deliberately NOT reported as "已更新": the
 * first wrote nothing and the second moved only the manifest's fingerprint, and
 * a delivery note that overstates what the index did is the same lie a report
 * would be.
 */
function noteOf(outcome: ReindexOutcome): string {
    const chunks = outcome.chunks === undefined ? '' : `（${outcome.chunks} 块）`
    if (outcome.changeKind === 'unchanged') return `知识库：索引未变${chunks}`
    if (outcome.changeKind === 'fingerprint') return '知识库：索引内容未变（仅刷新指纹）'
    return `知识库：索引已更新${chunks}`
}

/**
 * Refresh the index after a delivery, best effort.
 *
 * Returns the note to append to the delivery output: `[]` when the host mounted
 * no knowledge-base service (nothing to report — the feature is optional), one
 * line when it did (rebuilt / unchanged / failed with the reason). Never throws.
 * @param deps - the service accessor and the logger.
 * @param cwd - the delivered workspace (the receipt's workspace).
 * @returns zero or one line for the delivery report.
 */
export async function deliveryKnowledgeBaseNote(deps: KnowledgeBaseSyncDeps, cwd: string): Promise<string[]> {
    const service = serviceOf(deps)
    if (service === undefined) {
        deps.logger?.debug?.(`${KNOWLEDGE_BASE_SERVICE} 服务未装配：交付后跳过索引重建（工具与 /kb 不受影响）`)
        return []
    }
    const reindex = service.reindex as (workspace: string, options?: { force?: boolean }) => unknown
    const timeoutMs = deps.knowledgeBaseTimeoutMs ?? KNOWLEDGE_BASE_REINDEX_TIMEOUT_MS
    try {
        const outcome = outcomeOf(await withTimeout(Promise.resolve(reindex.call(service, cwd)), timeoutMs))
        // The project switched the knowledge base off: a decision, not a failure —
        // the delivery report says nothing about an index it was told not to build.
        if (outcome.changeKind === 'disabled') {
            deps.logger?.debug?.(`知识库已对该工作区禁用：交付后跳过索引重建（工作区 ${cwd}）`)
            return []
        }
        const note = noteOf(outcome)
        deps.logger?.info(`${note}（工作区 ${cwd}）`)
        return [note]
    } catch (error) {
        const note = `知识库：更新失败：${reasonOf(error)}`
        deps.logger?.warn(`${note}（工作区 ${cwd}；回执已签发，索引失败不影响交付）`)
        return [note]
    }
}

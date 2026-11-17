/**
 * Editor-time self-healing: the policy and the state machine behind
 * "a query found the index stale, rebuild it once".
 *
 * The knowledge base is a build artifact, and a build artifact is stale the
 * moment someone edits a file — which, during implementation, is all the time.
 * Reporting "索引可能过期，先 kb_index" is honest but leaves the reader holding a
 * different task; so `kb_search` and the IM `/kb` command rebuild a stale index
 * BEFORE ranking, and say so. Three rules keep that from becoming a surprise
 * writer:
 *
 *  - **one rebuild per workspace per cooldown window** (`freshness.cooldownMs`,
 *    default 10 s), and every real build — explicit (`kb_index`, `/kb index`,
 *    `service.reindex`) or automatic — restarts that window. Without this a
 *    burst of searches after a large edit would rebuild the repository once per
 *    query; with it the second search of a burst simply reads the index the
 *    first one just wrote.
 *  - **one rebuild at a time per workspace** (`rebuilding`): a second rebuild
 *    for the same workspace is refused while one is claimed. The build itself is
 *    synchronous (`buildIndex` + atomic rename), so a concurrent search cannot
 *    observe a half-written index; the flag is the belt to that brace, and it is
 *    what lets a future asynchronous caller share the same rule instead of
 *    writing a second artifact.
 *  - **failure is loud and does not throw**: the caller keeps the old index (an
 *    answer with a warning beats a tool error), and the reason is reported on
 *    the first line of the result plus a `logger.warn`.
 *
 * This module deliberately imports nothing from the rest of the package: the
 * configuration resolver and `operations.ts` both depend on it, and a reverse
 * edge would make a dependency cycle (which the structure gate forbids).
 *
 * @module dsh-knowledge-base/freshness
 */

/** Default window between two automatic rebuilds of one workspace. */
export const DEFAULT_FRESHNESS_COOLDOWN_MS = 10_000
/** Upper bound: a longer window only delays healing; it never widens anything. */
export const MAX_FRESHNESS_COOLDOWN_MS = 600_000

/** The resolved freshness policy (one block of the plugin configuration). */
export interface FreshnessControl {
    /** Minimum milliseconds between two automatic rebuilds of one workspace. */
    cooldownMs: number
}

/** How one automatic rebuild ended. */
export type SelfHealOutcome = 'rebuilt' | 'failed' | 'skipped'

/** What one automatic rebuild did (the first line of a result quotes it). */
export interface SelfHealInfo {
    outcome: SelfHealOutcome
    /** The build's own change kind, when it succeeded. */
    changeKind?: string
    /** Chunks in the rebuilt index, when it succeeded. */
    chunks?: number
    /** Why the rebuild threw, when it failed. */
    error?: string
    /** Why no rebuild ran (cooldown window, rebuild already in flight). */
    reason?: string
}

/** Untrusted configuration input (a value of the `freshness` block). */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the `freshness` block: the default cooldown, or a non-negative
 * millisecond count capped at {@link MAX_FRESHNESS_COOLDOWN_MS}. `0` is
 * deliberate: it turns the cooldown off (every stale query rebuilds), which is
 * what tests and small fixtures want.
 * @param value - the raw `freshness` block (untrusted).
 * @returns the resolved policy.
 */
export function resolveFreshness(value: unknown): FreshnessControl {
    const raw = isRecord(value) ? value : {}
    const cooldown = raw['cooldownMs']
    if (typeof cooldown === 'number' && Number.isFinite(cooldown) && cooldown >= 0) {
        return { cooldownMs: Math.min(MAX_FRESHNESS_COOLDOWN_MS, Math.floor(cooldown)) }
    }
    return { cooldownMs: DEFAULT_FRESHNESS_COOLDOWN_MS }
}

/**
 * Narrow the host's `freshness` block with a repository's own value.
 *
 * A project may only LENGTHEN the cooldown (fewer automatic writes from merely
 * reading), never shorten it — the host's window is the ceiling on how often a
 * read may turn into a write. An unusable value keeps the host's value and is
 * reported, like every other project override.
 * @param host - the profile value (the ceiling).
 * @param value - the project file's `freshness` block (untrusted).
 * @param file - the project file, for the report.
 * @param report - collects one line per refused override.
 * @returns the narrowed value, or `undefined` when nothing was applied.
 */
export function narrowFreshness(
    host: FreshnessControl,
    value: unknown,
    file: string,
    report: (message: string) => void,
): FreshnessControl | undefined {
    if (!isRecord(value) || value['cooldownMs'] === undefined) return undefined
    const raw = value['cooldownMs']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        report(`${file}: freshness.cooldownMs 必须是不小于 0 的数，已忽略（继续使用 profile 的 ${host.cooldownMs}）`)
        return undefined
    }
    const wanted = Math.floor(raw)
    if (wanted < host.cooldownMs) {
        report(
            `${file}: freshness.cooldownMs=${wanted} 低于 profile 的 ${host.cooldownMs}（会让每次过期检索都重建索引），已忽略（项目级只能拉长冷却窗口）`,
        )
        return undefined
    }
    if (wanted > MAX_FRESHNESS_COOLDOWN_MS) {
        report(`${file}: freshness.cooldownMs=${wanted} 超过上限 ${MAX_FRESHNESS_COOLDOWN_MS}，已按上限处理`)
    }
    return { cooldownMs: Math.min(MAX_FRESHNESS_COOLDOWN_MS, wanted) }
}

/** What one workspace's self-heal state remembers. */
interface WorkspaceState {
    /** When the last real build (explicit or automatic) finished, by the caller's clock. */
    lastBuildAt: number
    /** `true` while an automatic rebuild has claimed this workspace. */
    rebuilding: boolean
}

const states = new Map<string, WorkspaceState>()

/**
 * Record that a real build of `cwd` finished at `at`.
 *
 * Called by {@link buildWorkspaceIndex} for EVERY build (explicit `kb_index`,
 * `/kb index`, the delivery-time `reindex`, and the automatic one), because the
 * cooldown is "no automatic rebuild within N ms of the last build of any kind":
 * a search one millisecond after a full build has nothing to heal.
 * @param cwd - absolute workspace root.
 * @param at - the build clock (milliseconds).
 */
export function noteBuildCompleted(cwd: string, at: number): void {
    states.set(cwd, { lastBuildAt: at, rebuilding: false })
}

/** The result of asking to rebuild: allowed, or the reason it is not. */
export type RebuildClaim = { ok: true } | { ok: false; reason: string }

/**
 * Claim the right to rebuild one workspace, enforcing cooldown and exclusivity.
 *
 * The claim is recorded BEFORE the build runs (and the attempt time is recorded
 * even when the build fails): two searches in the same window, or a re-entrant
 * call, cannot both start a rebuild, and a failing rebuild cannot turn every
 * subsequent read into another expensive attempt.
 * @param cwd - absolute workspace root.
 * @param cooldownMs - the window in force.
 * @param now - current time, milliseconds.
 * @returns `{ ok: true }` when the caller may rebuild, or the refusal reason.
 */
export function claimAutoRebuild(cwd: string, cooldownMs: number, now: number): RebuildClaim {
    const entry = states.get(cwd)
    if (entry?.rebuilding === true) {
        return { ok: false, reason: '同一工作区已有一次自动重建在进行中（复用同一次重建，不写第二份索引）' }
    }
    if (entry !== undefined && now - entry.lastBuildAt < cooldownMs) {
        return {
            ok: false,
            reason: `冷却窗口内（上次构建于 ${new Date(entry.lastBuildAt).toISOString()}，冷却 ${cooldownMs}ms）`,
        }
    }
    states.set(cwd, { lastBuildAt: now, rebuilding: true })
    return { ok: true }
}

/**
 * Release a claim, recording the attempt time (success or failure).
 * @param cwd - absolute workspace root.
 * @param at - current time, milliseconds.
 */
export function finishAutoRebuild(cwd: string, at: number): void {
    states.set(cwd, { lastBuildAt: at, rebuilding: false })
}

/**
 * The first-line notice one surface prints for an automatic rebuild.
 *
 * Shared by the `kb_search` report and the IM `/kb` reply so the two cannot say
 * different things about the same event. A cooldown skip prints nothing: the
 * freshness line already carries the warning, and "did not rebuild because it
 * just did" is noise, not a fact about the answer.
 * @param selfHeal - what the search path attempted, when it attempted anything.
 * @returns zero lines (fresh, cooldown) or exactly one notice line.
 */
export function selfHealNotice(selfHeal: SelfHealInfo | undefined): string[] {
    if (selfHeal === undefined || selfHeal.outcome === 'skipped') return []
    if (selfHeal.outcome === 'failed') {
        return [`索引过期且自动重建失败：${selfHeal.error ?? '未知原因'}；结果可能缺少最近改动`]
    }
    const chunks = selfHeal.chunks ?? 0
    // A fingerprint-only refresh moved no content: saying "updated" without that
    // detail would suggest the answer gained documents it never lost.
    const detail = selfHeal.changeKind === 'fingerprint' ? '：内容未变，仅刷新了指纹' : ''
    return [`索引已自动更新（${chunks} 块）${detail}`]
}

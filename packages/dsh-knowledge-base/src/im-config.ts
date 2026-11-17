/**
 * The `im` configuration block: the optional `/kb` command inside an IM chat.
 *
 * The command is OFF by default — a plugin that indexes a whole repository must
 * not start answering strangers on a chat platform because it happened to load.
 * It is enabled by a fact this plugin does NOT own: the IM target that
 * `dsh-interaction-gate` already resolved from the host (`im.approvalChatId` /
 * `im.p2pOnly`, published read-only as `ctx.get('interaction').imTarget()`).
 * There is exactly ONE source for "which conversation may talk to the suite",
 * because two copies drift: an operator changes the approval chat in the profile
 * and the second copy keeps answering the old one. This module therefore holds
 * only what is genuinely the knowledge base's own: the command name, the reply
 * budget and the workspace to search.
 *
 * Two-layer model, like the rest of this package: the profile row is the ceiling
 * and a repository's own `.dsh/knowledge-base.json` may only NARROW it. Narrowing
 * means lowering `maxResults` or `maxChars` — never raising a bound, never
 * renaming the command and never pointing it at another workspace (which
 * workspace is searched is a host decision). The chat allow list is NOT here at
 * all: a project file that still writes `im.chatIds` / `im.p2pOnly` is reported
 * as removed and ignored, and the message names interaction-gate's keys.
 *
 * Every refused widening is REPORTED by the caller, never silently dropped.
 *
 * @module dsh-knowledge-base/im-config
 */

/** The IM command settings in force. */
export interface KbImConfig {
    /** Command name without the leading `/` (default `kb`). */
    command: string
    /** Hits returned to the chat (default 5, at most the search `maxLimit`). */
    maxResults: number
    /** Character cap of one reply (default 1800); longer results are truncated. */
    maxChars: number
    /** Absolute workspace the command searches. Empty = not configured (the handler refuses). */
    workspace: string
}

/** What the command registry accepts as a name (`[a-z0-9][a-z0-9_-]{0,31}`). */
export const IM_COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** The name used when the host does not choose one. */
export const IM_COMMAND_DEFAULT = 'kb'

/** Default number of hits sent to a chat. */
export const IM_MAX_RESULTS_DEFAULT = 5

/** Default reply budget, in characters. */
export const IM_MAX_CHARS_DEFAULT = 1800

/**
 * Keys this package used to read and no longer does.
 *
 * They are the duplicated half of "where may `/kb` answer": the IM target and
 * the p2p requirement now come from `dsh-interaction-gate` alone. Kept as a
 * named list so a stale profile row (or a project file) is REPORTED instead of
 * silently ignored — an operator who thinks their chat list is still in force
 * would otherwise believe the command is more restricted than it is.
 */
export const IM_REMOVED_KEYS = ['chatIds', 'p2pOnly'] as const

/** The settings in force when the host declares no `im` block at all. */
export function defaultImConfig(): KbImConfig {
    return {
        command: IM_COMMAND_DEFAULT,
        maxResults: IM_MAX_RESULTS_DEFAULT,
        maxChars: IM_MAX_CHARS_DEFAULT,
        workspace: '',
    }
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A positive integer inside `[min, max]`, or the fallback. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback
    return Math.min(Math.floor(value), max)
}

/**
 * One line naming the removed keys and where they went.
 * @param keys - the removed `im.*` keys found in a configuration file.
 * @returns the Chinese explanation (without a file prefix).
 */
export function removedImKeysProblem(keys: readonly string[]): string {
    return (
        `im.${keys.join(' / im.')} 已不再是知识库的配置（IM 目标只有一个来源：interaction-gate 的 im.approvalChatId 与 im.p2pOnly），` +
        '已忽略；要开放或收紧会话请改 interaction-gate 的配置'
    )
}

/**
 * The removed keys a raw `im` value still declares.
 * @param value - the raw `im` value (untrusted).
 * @returns the removed key names that are present (`[]` when none).
 */
export function removedImKeys(value: unknown): string[] {
    if (!isRecord(value)) return []
    return IM_REMOVED_KEYS.filter((key) => value[key] !== undefined)
}

/**
 * Resolve the profile row's `im` block.
 *
 * Unusable values keep the default (the profile row is the host's own file and
 * there is no log sink at resolution time); an invalid `command` is kept as
 * written so registration can refuse it out loud instead of silently answering
 * under a different name. `im.chatIds` / `im.p2pOnly` are not read at all —
 * {@link removedImKeys} lets the caller say so instead of dropping them silently.
 * @param value - the raw `im` value (untrusted).
 * @returns the resolved settings with every default applied.
 */
export function resolveImConfig(value: unknown): KbImConfig {
    const raw = isRecord(value) ? value : {}
    const command = typeof raw['command'] === 'string' && raw['command'].trim() !== '' ? raw['command'].trim() : IM_COMMAND_DEFAULT
    const workspace = typeof raw['workspace'] === 'string' && raw['workspace'].trim() !== '' ? raw['workspace'].trim() : ''
    return {
        command,
        maxResults: boundedInt(raw['maxResults'], IM_MAX_RESULTS_DEFAULT, 1, 50),
        maxChars: boundedInt(raw['maxChars'], IM_MAX_CHARS_DEFAULT, 100, 20_000),
        workspace,
    }
}

/**
 * Overlay a workspace's own `im` block, allowing it to NARROW the host's values.
 *
 * Only the reply budgets are narrowable: the command name and the searched
 * workspace are host decisions, and the chat allow list is no longer a
 * knowledge-base setting at all (it belongs to interaction-gate). Those keys are
 * reported, not applied.
 * @param host - the profile-resolved settings (the ceiling).
 * @param value - the project file's `im` value (untrusted).
 * @param file - the project file path, for the reports.
 * @param report - receives one line per refused/ignored override.
 * @returns the narrowed settings, or `undefined` when nothing was applied.
 */
export function narrowImConfig(host: KbImConfig, value: unknown, file: string, report: (message: string) => void): KbImConfig | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) {
        report(`${file}: im 必须是对象，已忽略（继续使用 profile 的 IM 设置）`)
        return undefined
    }
    const next: KbImConfig = { ...host }
    let applied = false
    for (const key of Object.keys(value)) {
        if (key === 'maxResults' || key === 'maxChars') continue
        if ((IM_REMOVED_KEYS as readonly string[]).includes(key)) {
            report(`${file}: ${removedImKeysProblem([key])}`)
            continue
        }
        report(`${file}: im.${key} 不允许在项目级配置里覆盖（命令名与检索工作区由宿主决定），已忽略`)
    }
    if (value['maxResults'] !== undefined) {
        const wanted = boundedInt(value['maxResults'], host.maxResults, 1, 50)
        if (wanted > host.maxResults) report(`${file}: im.maxResults=${wanted} 超过 profile 的 ${host.maxResults}，已忽略（项目级只能收紧）`)
        else if (wanted < host.maxResults) {
            next.maxResults = wanted
            applied = true
        }
    }
    if (value['maxChars'] !== undefined) {
        const wanted = boundedInt(value['maxChars'], host.maxChars, 100, 20_000)
        if (wanted > host.maxChars) report(`${file}: im.maxChars=${wanted} 超过 profile 的 ${host.maxChars}，已忽略（项目级只能收紧）`)
        else if (wanted < host.maxChars) {
            next.maxChars = wanted
            applied = true
        }
    }
    return applied ? next : undefined
}

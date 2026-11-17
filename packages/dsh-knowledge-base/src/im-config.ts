/**
 * The `im` configuration block: the optional `/kb` command inside an IM chat.
 *
 * The command is OFF by default — a plugin that indexes a whole repository must
 * not start answering strangers on a chat platform because it happened to load.
 * Enabling it takes an explicit allow list: without `im.chatIds` the command is
 * never registered at all, and `chatIds` is therefore both the switch and the
 * authorisation (`handler` re-checks the exact `chatId` of every invocation).
 *
 * Two-layer model, like the rest of this package: the profile row is the ceiling
 * and a repository's own `.dsh/knowledge-base.json` may only NARROW it. Narrowing
 * means removing an allowed chat, turning `p2pOnly` ON, lowering `maxResults` or
 * `maxChars` — never adding a chat the host did not authorise, never raising a
 * bound, never renaming the command and never pointing it at another workspace
 * (which workspace is searched is a host decision).
 *
 * Every refused widening is REPORTED by the caller, never silently dropped.
 *
 * @module dsh-knowledge-base/im-config
 */

/** The IM command settings in force. */
export interface KbImConfig {
    /** Command name without the leading `/` (default `kb`). */
    command: string
    /** Chat ids allowed to run the command. EMPTY = the command is not registered. */
    chatIds: string[]
    /** Restrict the command to person-to-person chats (default false). */
    p2pOnly: boolean
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

/** The settings in force when the host declares no `im` block at all. */
export function defaultImConfig(): KbImConfig {
    return {
        command: IM_COMMAND_DEFAULT,
        chatIds: [],
        p2pOnly: false,
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

/** A clean list of chat ids (trimmed, de-duplicated, non-strings dropped). */
function chatIdsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const ids: string[] = []
    for (const entry of value) {
        if (typeof entry !== 'string') continue
        const id = entry.trim()
        if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    return ids
}

/** A positive integer inside `[min, max]`, or the fallback. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback
    return Math.min(Math.floor(value), max)
}

/**
 * Resolve the profile row's `im` block.
 *
 * Unusable values keep the default (the profile row is the host's own file and
 * there is no log sink at resolution time); an invalid `command` is kept as
 * written so registration can refuse it out loud instead of silently answering
 * under a different name.
 * @param value - the raw `im` value (untrusted).
 * @returns the resolved settings with every default applied.
 */
export function resolveImConfig(value: unknown): KbImConfig {
    const raw = isRecord(value) ? value : {}
    const command = typeof raw['command'] === 'string' && raw['command'].trim() !== '' ? raw['command'].trim() : IM_COMMAND_DEFAULT
    const workspace = typeof raw['workspace'] === 'string' && raw['workspace'].trim() !== '' ? raw['workspace'].trim() : ''
    return {
        command,
        chatIds: chatIdsOf(raw['chatIds']),
        p2pOnly: raw['p2pOnly'] === true,
        maxResults: boundedInt(raw['maxResults'], IM_MAX_RESULTS_DEFAULT, 1, 50),
        maxChars: boundedInt(raw['maxChars'], IM_MAX_CHARS_DEFAULT, 100, 20_000),
        workspace,
    }
}

/**
 * Overlay a workspace's own `im` block, allowing it to NARROW the host's values.
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
    const next: KbImConfig = { ...host, chatIds: [...host.chatIds] }
    let applied = false
    for (const key of Object.keys(value)) {
        if (['chatIds', 'p2pOnly', 'maxResults', 'maxChars'].includes(key)) continue
        report(`${file}: im.${key} 不允许在项目级配置里覆盖（命令名与检索工作区由宿主决定），已忽略`)
    }
    if (value['chatIds'] !== undefined) {
        if (!Array.isArray(value['chatIds'])) {
            report(`${file}: im.chatIds 必须是字符串数组，已忽略`)
        } else {
            const wanted = chatIdsOf(value['chatIds'])
            const widened = wanted.filter((id) => !host.chatIds.includes(id))
            if (widened.length > 0) {
                report(`${file}: im.chatIds 新增了 profile 未授权的会话 ${widened.map((id) => JSON.stringify(id)).join(', ')}，已忽略（项目级只能收紧白名单）`)
            }
            const kept = host.chatIds.filter((id) => wanted.includes(id))
            if (kept.length !== host.chatIds.length) {
                next.chatIds = kept
                applied = true
            }
        }
    }
    if (value['p2pOnly'] !== undefined) {
        if (value['p2pOnly'] !== true) {
            if (host.p2pOnly) report(`${file}: im.p2pOnly 不能被项目级关闭（profile 只允许 p2p 会话），已忽略`)
        } else if (!host.p2pOnly) {
            next.p2pOnly = true
            applied = true
        }
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

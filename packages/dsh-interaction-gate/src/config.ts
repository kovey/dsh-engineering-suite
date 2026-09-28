/**
 * Plugin configuration: the profile ceiling and the keys a repository may refine.
 *
 * Two layers, the rule every plugin in this suite follows:
 *
 *  - the **profile row** decides whether the interaction layer exists at all,
 *    where its log lives, how long a turn may wait for a human, whether an
 *    approver list is mandatory, and how much text may leave the process;
 *  - `<repo>/.dsh/interaction-gate.json` may refine only where decisions are
 *    recorded, which channel this repository's cards go to, which notification
 *    levels are pushed, and which extra patterns are refused outright.
 *
 * Why the rest is host-owned:
 *
 *  - `askTimeoutMs` bounds how long a model turn may hang on a person. A
 *    repository that could raise it is extending its own leash, so it is a
 *    ceiling the tool may only SHORTEN (`interaction_ask({ timeoutMs })` is
 *    clamped to it, never above it).
 *  - `requireApproverList` is the difference between "anyone on the channel may
 *    answer" and "only the named people may answer". A repository that could
 *    clear it would be exempting itself from its own approver list (the same
 *    argument coverage-gate makes for `flakyPolicy`).
 *  - `enabled`, `logFile`, the layout and `prompt` are host concerns everywhere
 *    in the suite.
 *
 * Numbers and lists are validated, never guessed: an unusable value keeps the
 * profile's value (or the default for the profile row itself) and reports why.
 * A silently-defaulted ceiling is a silently-widened seam.
 *
 * @module dsh-interaction-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions } from 'dsh-eng-core'

/** Levels a notification may carry. `progress` is its own tool, not a level. */
export type NotifyLevel = 'info' | 'warn' | 'error'

/** Every level, weakest first. */
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['info', 'warn', 'error']

/** Default ask deadline (15 minutes): long enough for a phone, short enough to fail. */
export const DEFAULT_ASK_TIMEOUT_MS = 900_000

/** Shortest ask deadline a profile may set (a sub-second ask cannot reach a person). */
export const MIN_ASK_TIMEOUT_MS = 1_000

/** Longest ask deadline a profile may set (24h: a turn must eventually fail closed). */
export const MAX_ASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000

/** Default cap on one outgoing payload, in characters. */
export const DEFAULT_MAX_PAYLOAD_CHARS = 4_000

/** Bounds for {@link InteractionGateConfig.maxPayloadChars}. */
export const MIN_MAX_PAYLOAD_CHARS = 200
export const MAX_MAX_PAYLOAD_CHARS = 200_000

/** Most extra redaction patterns a profile/project may declare. */
export const MAX_REDACT_PATTERNS = 64

/** Resolved plugin configuration. */
export interface InteractionGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    prompt: {
        enabled: boolean
        order: number
    }
    /**
     * How long `interaction_ask` waits for an answer (default
     * {@link DEFAULT_ASK_TIMEOUT_MS}). A tool call may only ask for LESS.
     */
    askTimeoutMs: number
    /**
     * When true, an answer counts only if the answerer's id is in
     * `approversFile`. Default false: any participant of the channel may answer
     * (the channel's transport is then the only authentication — see the README).
     */
    requireApproverList: boolean
    /** Repository-owned approver list, relative to the workspace. */
    approversFile: string
    /** Append-only decision ledger, relative to the workspace. */
    ledgerFile: string
    /** Which `interaction_notify` levels are actually pushed. */
    notifyLevels: NotifyLevel[]
    /**
     * Channels this workspace prefers, in order. Empty = every registered
     * channel, in registration order. `interaction_ask` uses the FIRST usable
     * one; `interaction_notify` pushes to every usable one in the list.
     */
    preferredChannels: string[]
    /** Cap on one outgoing payload (title + body + declared options). */
    maxPayloadChars: number
    /** Extra regexes: a payload matching one of them is REFUSED, not sent. */
    redactPatterns: string[]
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/** Normalise a string list: trim, drop empties/duplicates, preserve order. */
export function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const out: string[] = []
    for (const entry of value) {
        if (typeof entry !== 'string') return undefined
        const trimmed = entry.trim()
        if (trimmed === '' || out.includes(trimmed)) continue
        out.push(trimmed)
    }
    return out
}

/** Normalise a notification level list; `undefined` when nothing valid remains. */
export function levelList(value: unknown): NotifyLevel[] | undefined {
    const list = stringList(value)
    if (list === undefined) return undefined
    const out: NotifyLevel[] = []
    for (const entry of list) {
        if ((NOTIFY_LEVELS as readonly string[]).includes(entry) && !out.includes(entry as NotifyLevel)) {
            out.push(entry as NotifyLevel)
        }
    }
    return out.length === 0 ? undefined : out
}

/**
 * Resolve the profile configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @param warn - optional sink for profile problems (an unusable value is
 *   reported and the default kept; the plugin still loads).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown, warn?: (message: string) => void): InteractionGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}

    const timeout = int(raw['askTimeoutMs'], DEFAULT_ASK_TIMEOUT_MS)
    if (timeout < MIN_ASK_TIMEOUT_MS || timeout > MAX_ASK_TIMEOUT_MS) {
        warn?.(
            `profile 配置: askTimeoutMs=${timeout} 超出 ${MIN_ASK_TIMEOUT_MS}…${MAX_ASK_TIMEOUT_MS}，已按默认值 ${DEFAULT_ASK_TIMEOUT_MS} 处理` +
                '（等待人的时长是宿主上限，不能由仓库或调用方抬高）',
        )
    }

    const payload = int(raw['maxPayloadChars'], DEFAULT_MAX_PAYLOAD_CHARS)
    if (payload < MIN_MAX_PAYLOAD_CHARS || payload > MAX_MAX_PAYLOAD_CHARS) {
        warn?.(
            `profile 配置: maxPayloadChars=${payload} 超出 ${MIN_MAX_PAYLOAD_CHARS}…${MAX_MAX_PAYLOAD_CHARS}，已按默认值 ${DEFAULT_MAX_PAYLOAD_CHARS} 处理`,
        )
    }

    const levels = raw['notifyLevels'] === undefined ? NOTIFY_LEVELS.filter((level) => level !== 'info') : levelList(raw['notifyLevels'])
    if (raw['notifyLevels'] !== undefined && levels === undefined) {
        warn?.(
            `profile 配置: notifyLevels 必须是 [${NOTIFY_LEVELS.join(', ')}] 的非空子集（收到 ${JSON.stringify(raw['notifyLevels'])}），已按默认值 [warn, error] 处理`,
        )
    }

    const preferred = raw['preferredChannels'] === undefined ? [] : stringList(raw['preferredChannels'])
    if (raw['preferredChannels'] !== undefined && preferred === undefined) {
        warn?.(`profile 配置: preferredChannels 必须是字符串数组，已按空（= 全部已注册通道）处理`)
    }

    const redact = raw['redactPatterns'] === undefined ? [] : stringList(raw['redactPatterns'])
    if (raw['redactPatterns'] !== undefined && redact === undefined) {
        warn?.('profile 配置: redactPatterns 必须是字符串数组，已按空处理')
    }

    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/interaction-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: int(prompt['order'], 600),
        },
        askTimeoutMs: timeout < MIN_ASK_TIMEOUT_MS || timeout > MAX_ASK_TIMEOUT_MS ? DEFAULT_ASK_TIMEOUT_MS : timeout,
        requireApproverList: bool(raw['requireApproverList'], false),
        approversFile: str(raw['approversFile'], '.dsh/interaction-approvers.txt'),
        ledgerFile: str(raw['ledgerFile'], '.dsh/interaction/decisions.jsonl'),
        notifyLevels: levels ?? (NOTIFY_LEVELS.filter((level) => level !== 'info') as NotifyLevel[]),
        preferredChannels: preferred ?? [],
        maxPayloadChars: payload < MIN_MAX_PAYLOAD_CHARS || payload > MAX_MAX_PAYLOAD_CHARS ? DEFAULT_MAX_PAYLOAD_CHARS : payload,
        redactPatterns: (redact ?? []).slice(0, MAX_REDACT_PATTERNS),
    }
}

/**
 * Keys a repository may refine through `<repo>/.dsh/interaction-gate.json`.
 *
 *  - `approversFile` / `ledgerFile`: where THIS repository's approvers and
 *    decisions live — repository knowledge, like `standardsFile`.
 *  - `preferredChannels`: which surface this repository's cards go to (an IM
 *    group per repository, say).
 *  - `notifyLevels`: how noisy this repository wants its channel to be.
 *  - `redactPatterns`: extra patterns to refuse. Adding them only TIGHTENS the
 *    seam (the built-in credential rules cannot be removed from here).
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'approversFile',
    'ledgerFile',
    'preferredChannels',
    'notifyLevels',
    'redactPatterns',
]

/**
 * Keys that stay host-owned, with the reason (shown by `interaction_status`).
 *
 * `askTimeoutMs` and `requireApproverList` are here because they are the two
 * keys that would let a repository widen its own seam.
 */
export const HOST_OWNED_KEYS: readonly { key: string; why: string }[] = [
    { key: 'enabled', why: '是否装载交互层是宿主的决定' },
    { key: 'logFile', why: '日志位置是宿主配置' },
    { key: 'layout', why: '工件布局是宿主配置' },
    { key: 'prompt', why: '提示词段是宿主配置' },
    { key: 'askTimeoutMs', why: '等待人的时长是宿主上限（调用方只能缩短），仓库不得抬高' },
    { key: 'requireApproverList', why: '审批人名单是否强制是宿主决定；由仓库关闭等于自我豁免' },
    { key: 'maxPayloadChars', why: '出站载荷上限按通道能力设定，属宿主' },
]

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: InteractionGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file: string
    /** Recoverable problems (forbidden keys, unusable values) — never silent. */
    problems: string[]
}

/** One-line provenance, the wording the rest of the suite uses. */
export function describeSource(effective: EffectiveConfig): string {
    return effective.source === 'project' ? `项目级 ${effective.file}` : 'profile'
}

/**
 * Overlay a workspace's own `<repo>/.dsh/interaction-gate.json` on the profile row.
 *
 * Key by key onto the HOST configuration (never re-resolved from the raw row):
 * a field this overlay forgets to copy cannot quietly fall back to a plugin
 * default. A refused key keeps the profile's value and says why.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 */
export function resolveEffectiveConfig(
    host: InteractionGateConfig,
    layout: Layout,
    logger?: { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'interaction-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }

    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE_KEYS.includes(key)) {
            const problem = `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
            problems.push(problem)
            logger?.warn(problem)
        }
    }

    const next: InteractionGateConfig = { ...host, prompt: host.prompt }
    let applied = 0
    const reject = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }
    const takePath = (key: 'approversFile' | 'ledgerFile'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value === 'string' && value.trim() !== '') {
            next[key] = value.trim()
            applied += 1
            return
        }
        reject(`${file.file}: ${key} 必须是非空字符串，已忽略（继续使用 profile 的值 ${host[key]}）`)
    }
    if (raw['preferredChannels'] !== undefined) {
        const list = stringList(raw['preferredChannels'])
        if (list === undefined) {
            reject(`${file.file}: preferredChannels 必须是字符串数组，已忽略（继续使用 profile 的值）`)
        } else {
            next.preferredChannels = list
            applied += 1
        }
    }
    if (raw['notifyLevels'] !== undefined) {
        const list = levelList(raw['notifyLevels'])
        if (list === undefined) {
            reject(
                `${file.file}: notifyLevels 必须是 [${NOTIFY_LEVELS.join(', ')}] 的非空子集，已忽略（继续使用 profile 的值 ${host.notifyLevels.join(', ')}）` +
                    '——空列表等于静默丢弃通知，属于关掉门禁而不是配置它',
            )
        } else {
            next.notifyLevels = list
            applied += 1
        }
    }
    if (raw['redactPatterns'] !== undefined) {
        const list = stringList(raw['redactPatterns'])
        if (list === undefined) {
            reject(`${file.file}: redactPatterns 必须是字符串数组，已忽略（继续使用 profile 的值）`)
        } else {
            const kept: string[] = []
            for (const pattern of list.slice(0, MAX_REDACT_PATTERNS)) {
                try {
                    new RegExp(pattern)
                    kept.push(pattern)
                } catch {
                    reject(`${file.file}: redactPatterns 里的 ${JSON.stringify(pattern)} 不是合法正则，已忽略该项（语法错误不能变成"少拦一条"）`)
                }
            }
            // UNION, never replacement: "extra rules only tighten" is the promise,
            // and replacing the host's list with a project one — even a valid,
            // non-empty one — would REMOVE rules the host declared. An all-invalid
            // project list must therefore leave the host's rules intact instead of
            // yielding an empty effective list.
            const merged = [...host.redactPatterns]
            for (const pattern of kept) if (!merged.includes(pattern)) merged.push(pattern)
            if (merged.length > MAX_REDACT_PATTERNS) {
                reject(
                    `${file.file}: redactPatterns 与 profile 的规则合计 ${merged.length} 条，超过上限 ${MAX_REDACT_PATTERNS}：` +
                        `已保留前 ${MAX_REDACT_PATTERNS} 条（profile 的规则在前，不会被项目的规则挤掉）`,
                )
                merged.length = MAX_REDACT_PATTERNS
            }
            // Only a real change counts as "the project file applied": a list that
            // adds nothing must not turn the provenance into "项目级" nor hide the
            // profile's value behind a no-op overlay.
            if (merged.length !== host.redactPatterns.length || merged.some((pattern, index) => pattern !== host.redactPatterns[index])) {
                next.redactPatterns = merged
                applied += 1
            }
        }
    }
    takePath('approversFile')
    takePath('ledgerFile')

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

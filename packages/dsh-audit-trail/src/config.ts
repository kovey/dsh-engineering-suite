/**
 * Plugin configuration (PLUGIN-CONVENTIONS.md §3: no schemastery, but every
 * default must still be applied, and every value must survive a hostile
 * `config` value from the loader row).
 *
 * The deterministic half of the audit trail — where rows are written, what is
 * tracked, what gets snapshotted and how large a snapshot may be — comes from
 * the host, never from the model.
 *
 * The profile is the *ceiling*: a workspace may refine what its own repository
 * records through `.dsh/audit-trail.json` (see {@link resolveEffectiveConfig}),
 * but it can neither relocate the trail nor switch the plugin off — an audit
 * trail whose location or on/off state the observed project can change is not
 * an audit trail.
 *
 * @module dsh-audit-trail/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Pre-write snapshot policy. */
export interface SnapshotConfig {
    /** Master switch for the pre-write snapshot chain (rewind needs it). */
    enabled: boolean
    /** Files larger than this are never copied (default 1 MiB). */
    maxFileBytes: number
    /** Hard cap on snapshots per session+turn (default 50). */
    maxFilesPerTurn: number
}

/** Resolved plugin configuration. */
export interface AuditTrailConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Tool names to record; empty = every tool. */
    trackTools: readonly string[]
    /** Tool names never recorded. */
    ignoreTools: readonly string[]
    /** Tool names whose file target is snapshotted before the call runs. */
    writeTools: readonly string[]
    /** Max characters of the redacted arguments summary kept in a row. */
    maxArgsSummary: number
    /** Max characters of the result tail kept in a row. */
    maxResultTail: number
    /**
     * Never store file bodies: `content` / `old_string` / `new_string` are
     * replaced by `<sha256-12>/<len>B`. Their digests stay available.
     */
    redactArgs: boolean
    snapshot: SnapshotConfig
    prompt: {
        enabled: boolean
        order: number
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function posInt(value: unknown, fallback: number): number {
    const parsed = num(value, fallback)
    return parsed > 0 ? Math.floor(parsed) : fallback
}

function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** The write-class tools the harness ships. */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['write', 'edit']

/**
 * Argument keys whose value is a file body and must never reach the trail.
 * Verified against `@deepseek-ai/dsh-tool-fs`: `write` takes `content`,
 * `edit` takes `old_string` / `new_string`.
 */
export const REDACTED_ARG_KEYS: readonly string[] = ['content', 'old_string', 'new_string']

/** File-target argument keys, probed in this order. */
export const PATH_ARG_KEYS: readonly string[] = ['file_path', 'filePath', 'path']

/** Default audit-trail log file (`$DSH_HOME`-shaped, `~` expanded at use). */
export const DEFAULT_LOG_FILE = '~/.dsh/audit-trail.log'

/** Default layout root: `.dsh` in the session workspace. */
export const DEFAULT_ROOT_DIR = '.dsh'

function readLayout(raw: Record<string, unknown>): LayoutOptions {
    // Both shapes are accepted: the nested `layout: { rootDir, auditDir, … }`
    // documented in this plugin's README, and the flat keys other suite
    // plugins use (`rootDir`, `auditDir`, …).
    const nested = isRecord(raw['layout']) ? raw['layout'] : {}
    const pick = (key: 'rootDir' | 'specsDir' | 'missionsDir' | 'auditDir' | 'stateDir' | 'rolesDir'): string | undefined => {
        const fromNested = nested[key]
        if (typeof fromNested === 'string' && fromNested !== '') return fromNested
        const flat = raw[key]
        return typeof flat === 'string' && flat !== '' ? flat : undefined
    }
    const layout: LayoutOptions = {}
    const rootDir = pick('rootDir')
    if (rootDir !== undefined) layout.rootDir = rootDir
    const auditDir = pick('auditDir')
    if (auditDir !== undefined) layout.auditDir = auditDir
    const stateDir = pick('stateDir')
    if (stateDir !== undefined) layout.stateDir = stateDir
    return layout
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): AuditTrailConfig {
    const raw = isRecord(input) ? input : {}
    const snapshot = isRecord(raw['snapshot']) ? raw['snapshot'] : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], DEFAULT_LOG_FILE),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        layout: readLayout(raw),
        trackTools: strList(raw['trackTools'], []),
        ignoreTools: strList(raw['ignoreTools'], []),
        writeTools: strList(raw['writeTools'], DEFAULT_WRITE_TOOLS),
        maxArgsSummary: posInt(raw['maxArgsSummary'], 200),
        maxResultTail: posInt(raw['maxResultTail'], 600),
        redactArgs: bool(raw['redactArgs'], true),
        snapshot: {
            enabled: bool(snapshot['enabled'], true),
            maxFileBytes: posInt(snapshot['maxFileBytes'], 1048576),
            maxFilesPerTurn: posInt(snapshot['maxFilesPerTurn'], 50),
        },
        prompt: {
            enabled: bool(prompt['enabled'], false),
            order: num(prompt['order'], 670),
        },
    }
}

/**
 * Keys a project file may override (`.dsh/audit-trail.json` in the workspace).
 *
 * A dsh profile serves many repositories at once, so a profile-global setting
 * (how large a snapshot may be before the chain skips it, which noisy tool is
 * not worth recording) cannot be right for every workspace. A project may
 * therefore refine *what its own repository records* — never where the trail
 * lives or whether it exists.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'snapshot',
    'writeTools',
    'trackTools',
    'ignoreTools',
    'maxArgsSummary',
    'maxResultTail',
    'redactArgs',
]

/** Keys of the nested `snapshot` section a project file may refine. */
export const PROJECT_OVERRIDABLE_SNAPSHOT_KEYS: readonly string[] = ['enabled', 'maxFileBytes', 'maxFilesPerTurn']

/**
 * Host-only keys, with the reason shown to the operator.
 *
 * The trail's *identity* is a deployment decision, not a workspace one: a
 * project that could relocate `auditDir`/`rootDir` (into a directory it then
 * deletes) or flip `enabled`/`logFile` could silence its own audit record.
 * Those keys are therefore refused with a problem and the profile's value is
 * kept.
 */
export const HOST_ONLY_KEYS: Readonly<Record<string, string>> = {
    enabled: '插件开关是部署决定：项目不能关掉对自己工作区的审计',
    logFile: '插件日志落点是部署决定：审计证据不能被项目改写或丢弃',
    rootDir: '审计工件位置是部署决定：审计轨迹不能自己搬家',
    auditDir: '审计工件位置是部署决定：审计轨迹不能自己搬家',
    stateDir: '会话状态位置是部署决定：审计轨迹不能自己搬家',
    layout: '审计工件位置是部署决定：审计轨迹不能自己搬家（扁平键同样被拒绝）',
    prompt: '系统提示词小节由 profile 决定',
}

/** The resolved configuration plus where it came from. */
export interface EffectiveAuditTrailConfig {
    config: AuditTrailConfig
    source: 'profile' | 'project'
    /** The project file consulted (the path is derived from the layout). */
    file?: string
    /** Recoverable problems (refused keys, malformed values) — never silent. */
    problems: string[]
}

/** One project value plus the reason it could not be used, when it could not. */
interface Overlay<T> {
    value: T
    problem?: string
}

function boolAt(raw: Record<string, unknown>, key: string, fallback: boolean): Overlay<boolean> {
    const value = raw[key]
    if (value === undefined) return { value: fallback }
    if (typeof value !== 'boolean') return { value: fallback, problem: '必须是布尔值' }
    return { value }
}

function posIntAt(raw: Record<string, unknown>, key: string, fallback: number): Overlay<number> {
    const value = raw[key]
    if (value === undefined) return { value: fallback }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { value: fallback, problem: '必须是正整数' }
    return { value: Math.floor(value) }
}

function strListAt(raw: Record<string, unknown>, key: string, fallback: readonly string[]): Overlay<string[]> {
    const value = raw[key]
    if (value === undefined) return { value: [...fallback] }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
        return { value: [...fallback], problem: '必须是字符串数组（元素为非空字符串）' }
    }
    return { value: value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') }
}

/**
 * Resolve the configuration of one workspace.
 *
 * Reads `<workspace>/.dsh/audit-trail.json` through `dsh-eng-core`'s cached
 * project-config reader (mtime+size, so the hot hooks pay one `stat` per call):
 * the allowed keys are shallow-merged onto the profile configuration and
 * anything else is refused with a logged problem. The reader caches a stat
 * signature, so repeated calls in one turn do not re-read the file.
 *
 * **Never fails open.** A missing file, a malformed one (bad JSON, non-object,
 * bad-typed value) or a refused key leaves the profile's configuration in
 * place, records a problem and still writes rows — an unusable project config
 * must never turn into a silent audit, and must never throw into a hook.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - diagnostics sink.
 */
export function resolveEffectiveConfig(host: AuditTrailConfig, layout: Layout, logger?: Logger): EffectiveAuditTrailConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'audit-trail')
    const problems: string[] = []
    const note = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }
    for (const problem of file.problems) note(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }

    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (PROJECT_OVERRIDABLE_KEYS.includes(key)) continue
        // `hasOwnProperty`, not `HOST_ONLY_KEYS[key]`: a hostile key such as
        // "__proto__" would otherwise resolve to `Object.prototype` and print a
        // nonsensical reason instead of being refused as an unknown key.
        const reason = Object.prototype.hasOwnProperty.call(HOST_ONLY_KEYS, key) ? HOST_ONLY_KEYS[key] : undefined
        note(
            reason === undefined
                ? `${file.file}: 键 "${key}" 不在项目级可覆盖清单内（profile 是上限），已忽略`
                : `${file.file}: 键 "${key}" 只能由 profile 决定（${reason}），已忽略`,
        )
    }

    // Reject an unusable value instead of coercing it: a silently coerced
    // `maxFileBytes: "tiny"` would look like an operator decision forever.
    const pick = <T>(at: string, result: Overlay<T>): T => {
        if (result.problem !== undefined) note(`${file.file}: 键 "${at}" ${result.problem}，已忽略该键（继续使用 profile 的值）`)
        return result.value
    }

    const snapshotRaw = raw['snapshot']
    let snapshot: Record<string, unknown> = {}
    if (snapshotRaw !== undefined) {
        if (isRecord(snapshotRaw)) {
            snapshot = snapshotRaw
            for (const key of Object.keys(snapshot)) {
                if (!PROJECT_OVERRIDABLE_SNAPSHOT_KEYS.includes(key)) {
                    note(`${file.file}: 键 "snapshot.${key}" 不在项目级可覆盖清单内（profile 是上限），已忽略`)
                }
            }
        } else {
            note(`${file.file}: 键 "snapshot" 必须是对象，已忽略项目级快照设置（继续使用 profile 的值）`)
        }
    }

    const config: AuditTrailConfig = {
        ...host,
        trackTools: pick('trackTools', strListAt(raw, 'trackTools', host.trackTools)),
        ignoreTools: pick('ignoreTools', strListAt(raw, 'ignoreTools', host.ignoreTools)),
        writeTools: pick('writeTools', strListAt(raw, 'writeTools', host.writeTools)),
        maxArgsSummary: pick('maxArgsSummary', posIntAt(raw, 'maxArgsSummary', host.maxArgsSummary)),
        maxResultTail: pick('maxResultTail', posIntAt(raw, 'maxResultTail', host.maxResultTail)),
        redactArgs: pick('redactArgs', boolAt(raw, 'redactArgs', host.redactArgs)),
        // Shallow merge: only the keys the project actually names are replaced,
        // so narrowing `maxFileBytes` keeps the profile's per-turn quota.
        snapshot: {
            enabled: pick('snapshot.enabled', boolAt(snapshot, 'enabled', host.snapshot.enabled)),
            maxFileBytes: pick('snapshot.maxFileBytes', posIntAt(snapshot, 'maxFileBytes', host.snapshot.maxFileBytes)),
            maxFilesPerTurn: pick('snapshot.maxFilesPerTurn', posIntAt(snapshot, 'maxFilesPerTurn', host.snapshot.maxFilesPerTurn)),
        },
    }
    logger?.info(
        `audit-trail: 使用项目级配置 ${file.file}（snapshot=${config.snapshot.enabled}; maxFileBytes=${config.snapshot.maxFileBytes}; maxFilesPerTurn=${config.snapshot.maxFilesPerTurn}; ignoreTools=${config.ignoreTools.join(',') || '无'}）`,
    )
    return { config, source: 'project', file: file.file, problems }
}

/** Whether one tool call must be recorded at all. */
export function shouldTrack(config: AuditTrailConfig, tool: string): boolean {
    if (config.ignoreTools.includes(tool)) return false
    if (config.trackTools.length === 0) return true
    return config.trackTools.includes(tool)
}

/** Whether one tool call carries a pre-write snapshot. */
export function shouldSnapshot(config: AuditTrailConfig, tool: string): boolean {
    return config.snapshot.enabled && config.writeTools.includes(tool)
}

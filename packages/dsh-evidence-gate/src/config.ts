/**
 * Plugin configuration.
 *
 * docs.md §9: the deterministic half of a gate always comes from the host,
 * never from the model — required evidence kinds, the gate source and the
 * freshness limits are host configuration, and the model cannot argue with
 * them. Parsing is defensive (no schemastery dependency): every field falls
 * back to a safe default, because a broken config must not weaken a gate.
 *
 * A profile serves many repositories, so each workspace may refine the
 * checklist through `.dsh/evidence-gate.json` — always under the profile, which
 * stays the ceiling ({@link resolveEffectiveConfig}).
 *
 * @module dsh-evidence-gate/config
 */

import { loadProjectConfig, type EvidenceKind, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Resolved plugin configuration. */
export interface EvidenceGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Require a `PASS` gate record before a mission may be delivered. */
    requireGate: boolean
    /**
     * Require a PASS from the code-standards gate as well.
     *
     * Structural quality is a separate concern from "the commands passed", so it
     * gets its own check rather than being folded into `gateSource`. Opt-in: a
     * repository that has not adopted code standards must still be able to
     * deliver (it simply stays ungated on this axis).
     */
    requireStandardsGate: boolean
    /** Which plugin's gate records satisfy {@link requireStandardsGate}. */
    standardsGateSource: string
    /** Plugin id whose gate records count as the delivery gate. */
    gateSource: string
    /** Evidence kinds a delivery must carry. */
    requiredEvidenceKinds: readonly EvidenceKind[]
    /** Characters of captured output kept on one evidence row. */
    maxOutputTail: number
    /**
     * Re-check the working tree against the fingerprint the gate observed.
     *
     * Default `true`: a receipt must bind the workspace state the gate actually
     * verified. The comparison ignores the engineering trail (`layout.rootDir`),
     * which changes on every tool call, and a workspace that is not a git
     * repository on both sides is reported as "无法核对" instead of blocking.
     */
    requireCleanTree: boolean
    /**
     * Whether `mission_complete({ force: true })` may downgrade the
     * required-evidence-kinds check. Off by default: an escape hatch that can
     * turn a red checklist green is only acceptable when the host asked for it.
     */
    allowForceOverride: boolean
    /** `0` = no age limit; otherwise a gate older than N minutes blocks. */
    maxGateAgeMinutes: number
    prompt: {
        enabled: boolean
        order: number
    }
}

/** Every evidence kind the ledger accepts (`dsh-eng-core` `EvidenceKind`). */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
    'command',
    'test',
    'gate',
    'artifact',
    'diff',
    'manual',
]

/**
 * Kinds a model may record itself: `gate` is deliberately absent, because a
 * gate row is the deterministic verdict of `dsh-quality-gate` (`recordGate`),
 * never something the model writes by hand.
 */
export const RECORDABLE_KINDS: readonly EvidenceKind[] = ['command', 'test', 'artifact', 'diff', 'manual']

/** Kinds a delivery must carry unless the host says otherwise. */
export const DEFAULT_REQUIRED_EVIDENCE_KINDS: readonly EvidenceKind[] = ['command', 'test']

/** The plugin whose gate verdicts authorize a delivery. */
export const DEFAULT_GATE_SOURCE = 'dsh-quality-gate'

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

/** Whether a value is one of the evidence kinds the ledger accepts. */
export function isEvidenceKind(value: unknown): value is EvidenceKind {
    return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value)
}

/**
 * Parse `requiredEvidenceKinds`.
 *
 * An absent list falls back to the default; an explicitly empty list means
 * "no required kind" (the host's escape hatch, the receipt is still gated by
 * the quality gate); a list that contains only unknown names is treated as a
 * misconfiguration and falls back to the default (fail closed).
 */
function kindList(value: unknown, fallback: readonly EvidenceKind[]): EvidenceKind[] {
    if (!Array.isArray(value)) return [...fallback]
    const named = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    if (named.length === 0) return []
    const kinds = named.filter(isEvidenceKind)
    return kinds.length > 0 ? [...new Set(kinds)] : [...fallback]
}

// --- project-level configuration (.dsh/evidence-gate.json) ------------------

/**
 * Keys a project file may override (`.dsh/evidence-gate.json` inside the
 * workspace).
 *
 * One dsh profile serves many repositories at once, so a profile-global
 * checklist cannot be right for every workspace: a repo whose deliverables are
 * documents can ask for `artifact`, a scratch repo can relax
 * `requireCleanTree`. What a project may NOT do is move the goalposts — see
 * {@link HOST_ONLY_KEYS}.
 *
 * The file lives inside the trust root: `dsh-spec-gate`'s guard closes
 * `.dsh/**` to the write tools (only the derived `specs/*.md` is writable), so
 * a model cannot rewrite its own delivery checklist with `write`/`edit`.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'requiredEvidenceKinds',
    'requireCleanTree',
    'requireGate',
    'requireStandardsGate',
    'standardsGateSource',
    'gateSource',
    'maxGateAgeMinutes',
    'maxOutputTail',
]

/**
 * Keys a project file may NOT override, with the reason stated to the user.
 *
 * The profile is the ceiling. `allowForceOverride` is the sharpest case: it
 * decides whether a *model-supplied* `force: true` may downgrade the checklist,
 * so it must stay a host decision — a file the model can reach (directly or
 * through a shell) may never open that escape hatch. The layout keys decide
 * where receipts live (relocating them would let a workspace hide its
 * artifacts), and `enabled`/`logFile`/`prompt` are deployment decisions.
 */
export const HOST_ONLY_KEYS: ReadonlyMap<string, string> = new Map([
    ['enabled', '是否加载插件是部署决策：项目文件不能把交付门禁关掉'],
    ['logFile', '日志落盘位置是部署决策，只能由 profile 决定'],
    ['layout', '工件（证据台账 / 门禁记录 / 回执）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['rootDir', '工件（证据台账 / 门禁记录 / 回执）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['missionsDir', '工件（证据台账 / 门禁记录 / 回执）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['specsDir', '工件（证据台账 / 门禁记录 / 回执）落在哪由宿主布局决定，项目文件不能迁移它们'],
    [
        'allowForceOverride',
        'allowForceOverride 决定模型传入的 force=true 能否放松检查表，只能由宿主显式开启（默认 false）；项目文件是模型可能经 shell 改写的路径，不得打开这个逃生舱',
    ],
    ['prompt', '系统提示词章节属于宿主装配决策，只能由 profile 决定'],
])

/** The resolved configuration plus where it came from. */
export interface EffectiveEvidenceGateConfig {
    config: EvidenceGateConfig
    /**
     * Where the effective values came from: `project` only when the project
     * file actually changed at least one allow-listed key, otherwise `profile`
     * (an absent, malformed or fully-refused file changes nothing).
     */
    source: 'profile' | 'project'
    /** The project file consulted (whether or not it exists or parsed). */
    file?: string
    /** Recoverable problems (unknown keys, malformed file, bad-typed values). */
    problems: string[]
}

/** Where problems are collected and replayed: the plugin log plus the report. */
interface ProblemSink {
    file: string
    problems: string[]
    logger?: Logger
}

/** Record one recoverable problem (never silently). */
function problem(sink: ProblemSink, message: string): void {
    const text = `${sink.file}: ${message}`
    sink.problems.push(text)
    sink.logger?.warn(text)
}

/** A short, safe description of an untrusted value, for problem messages. */
function describeValue(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return `数组(${value.length})`
    if (typeof value === 'object') return '对象'
    if (typeof value === 'string') return `字符串 "${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`
    return `${typeof value} ${String(value)}`
}

/** `true` when the project file mentions the key at all (even as `null`). */
function has(raw: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(raw, key)
}

/** Read a boolean override; a wrong type is a problem and keeps the profile value. */
function readBool(sink: ProblemSink, raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    if (!has(raw, key)) return fallback
    const value = raw[key]
    if (typeof value === 'boolean') return value
    problem(sink, `${key} 必须是布尔值（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
    return fallback
}

/** Read a non-empty string override; junk is a problem and keeps the profile value. */
function readNonEmptyString(sink: ProblemSink, raw: Record<string, unknown>, key: string, fallback: string): string {
    if (!has(raw, key)) return fallback
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    problem(sink, `${key} 必须是非空字符串（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
    return fallback
}

/**
 * Read a non-negative number override (`maxGateAgeMinutes`: `0` = no limit).
 * A negative, `NaN` or wrongly typed value is a problem, not a silent clamp.
 */
function readNonNegativeNumber(sink: ProblemSink, raw: Record<string, unknown>, key: string, fallback: number): number {
    if (!has(raw, key)) return fallback
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    problem(sink, `${key} 必须是 ≥ 0 的数字（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
    return fallback
}

/** Read a positive integer override (`maxOutputTail`). */
function readPositiveInteger(sink: ProblemSink, raw: Record<string, unknown>, key: string, fallback: number): number {
    if (!has(raw, key)) return fallback
    const value = raw[key]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    problem(sink, `${key} 必须是正整数（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
    return fallback
}

/**
 * Read `requiredEvidenceKinds` from a project file.
 *
 * Unknown names are dropped with a problem, and `gate` is never accepted: a
 * gate row is the deterministic verdict `dsh-quality-gate` writes, not
 * something a model may demand of itself. Dropping every entry would weaken
 * the checklist below the profile's, so that case (and a non-array value) falls
 * back to the profile instead of failing open. An explicitly empty list stays
 * meaningful: "this repository requires no evidence kind".
 */
function readKinds(sink: ProblemSink, raw: Record<string, unknown>, fallback: readonly EvidenceKind[]): readonly EvidenceKind[] {
    if (!has(raw, 'requiredEvidenceKinds')) return fallback
    const value = raw['requiredEvidenceKinds']
    if (!Array.isArray(value)) {
        problem(sink, `requiredEvidenceKinds 必须是数组（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
        return fallback
    }
    if (value.length === 0) {
        sink.logger?.info(`${sink.file}: requiredEvidenceKinds 为空数组 —— 该工作区不要求任何证据类型（仍受门禁与规格约束）`)
        return []
    }
    const kinds: EvidenceKind[] = []
    for (const entry of value) {
        if (typeof entry !== 'string' || entry === '') {
            problem(sink, `requiredEvidenceKinds 的元素必须是非空字符串（收到 ${describeValue(entry)}），已丢弃`)
            continue
        }
        if (entry === 'gate') {
            problem(sink, 'requiredEvidenceKinds 不接受 "gate"：gate 行由质量门禁自己写入（recordGate），模型无法登记，已丢弃')
            continue
        }
        if (!isEvidenceKind(entry) || !(RECORDABLE_KINDS as readonly string[]).includes(entry)) {
            problem(sink, `requiredEvidenceKinds 里的 "${entry}" 不是已知证据类型（可用：${RECORDABLE_KINDS.join(', ')}），已丢弃`)
            continue
        }
        if (!kinds.includes(entry)) kinds.push(entry)
    }
    if (kinds.length === 0) {
        problem(sink, 'requiredEvidenceKinds 里没有任何可用类型，已回退到 profile 的必填类型（fail closed，不放松检查表）')
        return fallback
    }
    return kinds
}

/**
 * Resolve the configuration that applies to one workspace.
 *
 * Reads `<workspace>/.dsh/evidence-gate.json` (see `dsh-eng-core`'s project
 * config helper) and overlays the allow-listed keys on the profile
 * configuration, which stays the ceiling: keys outside
 * {@link PROJECT_OVERRIDABLE_KEYS} are ignored with a logged problem, never
 * silently honoured. A malformed file (bad JSON, non-object top level,
 * bad-typed values) falls back to the profile configuration with a problem, so
 * a broken project file can never weaken a gate.
 *
 * `source` reports where the *effective* values came from: `project` only when
 * the file really changed an allow-listed key (a file whose keys were all
 * refused, or all ill-typed, leaves the profile configuration in force).
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - diagnostics sink.
 */
export function resolveEffectiveConfig(
    host: EvidenceGateConfig,
    layout: Layout,
    logger?: Logger,
): EffectiveEvidenceGateConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'evidence-gate')
    const problems = [...file.problems]
    for (const entry of problems) logger?.warn(entry)
    // No (or unparsable) file: the profile configuration is the answer.
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }

    const raw = file.value
    const sink: ProblemSink = { file: file.file, problems, ...(logger === undefined ? {} : { logger }) }
    for (const key of Object.keys(raw)) {
        if (PROJECT_OVERRIDABLE_KEYS.includes(key)) continue
        const reason = HOST_ONLY_KEYS.get(key)
        problem(
            sink,
            reason === undefined
                ? `键 "${key}" 不是 dsh-evidence-gate 的可覆盖键（profile 是上限），已忽略`
                : `键 "${key}" 不允许在项目级配置里覆盖（profile 是上限）：${reason}；已忽略`,
        )
    }

    const config: EvidenceGateConfig = {
        ...host,
        requiredEvidenceKinds: readKinds(sink, raw, host.requiredEvidenceKinds),
        requireCleanTree: readBool(sink, raw, 'requireCleanTree', host.requireCleanTree),
        requireStandardsGate: readBool(sink, raw, 'requireStandardsGate', host.requireStandardsGate),
        standardsGateSource: readNonEmptyString(sink, raw, 'standardsGateSource', host.standardsGateSource),
        requireGate: readBool(sink, raw, 'requireGate', host.requireGate),
        gateSource: readNonEmptyString(sink, raw, 'gateSource', host.gateSource),
        maxGateAgeMinutes: readNonNegativeNumber(sink, raw, 'maxGateAgeMinutes', host.maxGateAgeMinutes),
        maxOutputTail: readPositiveInteger(sink, raw, 'maxOutputTail', host.maxOutputTail),
    }
    // `source` says where the EFFECTIVE values came from: a file whose keys were
    // all refused (or all ill-typed) contributed nothing, so it is not the
    // source of the checklist the gate will enforce.
    const source = overrides(host, config) ? 'project' : 'profile'
    logger?.info(
        source === 'project'
            ? `evidence-gate: 使用项目级配置 ${file.file}（required=${config.requiredEvidenceKinds.join('+') || 'none'}; requireGate=${config.requireGate}; requireCleanTree=${config.requireCleanTree}; maxGateAgeMinutes=${config.maxGateAgeMinutes}）`
            : `evidence-gate: 项目级配置 ${file.file} 未改变任何可覆盖键（${problems.length} 条配置问题，继续使用 profile 配置）`,
    )
    return { config, source, file: file.file, problems }
}

/** Whether a project file actually changed one of the allow-listed values. */
function overrides(host: EvidenceGateConfig, config: EvidenceGateConfig): boolean {
    return (
        config.requireGate !== host.requireGate ||
        config.requireCleanTree !== host.requireCleanTree ||
        config.requireStandardsGate !== host.requireStandardsGate ||
        config.standardsGateSource !== host.standardsGateSource ||
        config.gateSource !== host.gateSource ||
        config.maxGateAgeMinutes !== host.maxGateAgeMinutes ||
        config.maxOutputTail !== host.maxOutputTail ||
        config.requiredEvidenceKinds.join('\u0000') !== host.requiredEvidenceKinds.join('\u0000')
    )
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): EvidenceGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const nested = isRecord(raw['layout']) ? raw['layout'] : {}
    // Layout overrides are accepted flat (like dsh-spec-gate) or nested under
    // `layout:`, so an existing profile keeps working either way.
    const pick = (key: string): string | undefined => {
        const flat = raw[key]
        if (typeof flat === 'string' && flat !== '') return flat
        const deep = nested[key]
        if (typeof deep === 'string' && deep !== '') return deep
        return undefined
    }
    const rootDir = pick('rootDir')
    const specsDir = pick('specsDir')
    const missionsDir = pick('missionsDir')
    const maxOutputTail = Math.trunc(num(raw['maxOutputTail'], 2000))
    const maxGateAgeMinutes = num(raw['maxGateAgeMinutes'], 0)
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/evidence-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        layout: {
            ...(rootDir === undefined ? {} : { rootDir }),
            ...(specsDir === undefined ? {} : { specsDir }),
            ...(missionsDir === undefined ? {} : { missionsDir }),
        },
        requireGate: bool(raw['requireGate'], true),
        // Opt-in: a repository that never adopted standards must still deliver.
        requireStandardsGate: bool(raw['requireStandardsGate'], false),
        standardsGateSource: str(raw['standardsGateSource'], 'dsh-standards-gate'),
        gateSource: str(raw['gateSource'], DEFAULT_GATE_SOURCE),
        requiredEvidenceKinds: kindList(raw['requiredEvidenceKinds'], DEFAULT_REQUIRED_EVIDENCE_KINDS),
        maxOutputTail: maxOutputTail < 0 ? 0 : maxOutputTail,
        requireCleanTree: bool(raw['requireCleanTree'], true),
        allowForceOverride: bool(raw['allowForceOverride'], false),
        maxGateAgeMinutes: maxGateAgeMinutes > 0 ? maxGateAgeMinutes : 0,
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 650),
        },
    }
}

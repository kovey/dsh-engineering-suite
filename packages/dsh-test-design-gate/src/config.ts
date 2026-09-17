/**
 * Plugin configuration (docs.md §9: the deterministic half of a gate always
 * comes from the host, never from the model).
 *
 * A profile serves many repositories at once (one Neovim, several projects), so
 * "how strict is the test-design review here" must be resolvable per session
 * workspace: each repository may refine the review through
 * `.dsh/test-design-gate.json` — always *under* the profile, which stays the
 * ceiling ({@link resolveEffectiveConfig}).
 *
 * @module dsh-test-design-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Resolved plugin configuration. */
export interface TestDesignGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Minimum length (after trimming) of a case's `操作步骤` / `预期结果`. */
    minTextLength: number
    /** Also require a `negative`/`boundary` case for every acceptance criterion. */
    strict: boolean
    /** Tolerate cases that declare no acceptance criterion (default false). */
    allowDanglingCase: boolean
    /** Require at least one case of each scenario class (default true). */
    requireAllScenarios: boolean
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

// --- project-level configuration (.dsh/test-design-gate.json) ---------------

/**
 * Keys a project file may override (`.dsh/test-design-gate.json` inside the
 * workspace).
 *
 * These four keys decide *how strict this repository's* test-design review is,
 * which is a property of the repository: a scratch repo can lower
 * `minTextLength`, a regulated one can raise it and switch `strict` on. The
 * profile stays the ceiling for everything else — see {@link HOST_ONLY_KEYS}.
 *
 * The file lives inside the trust root: `dsh-spec-gate`'s guard closes
 * `.dsh/**` to the write tools (only the derived `specs/*.md` is writable), so
 * a model cannot loosen its own review with `write`/`edit`.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'minTextLength',
    'strict',
    'allowDanglingCase',
    'requireAllScenarios',
]

/**
 * Keys a project file may NOT override, with the reason stated to the user.
 *
 * The profile is the ceiling. `enabled` decides whether the review runs at all
 * — a project that could switch it off would make `spec_approve`'s test-design
 * refusal disappear. The layout keys decide where the spec and the review
 * artifacts live (relocating them would let a workspace hide the artifact the
 * verdict is bound to), and `logFile`/`prompt` are deployment decisions.
 */
export const HOST_ONLY_KEYS: ReadonlyMap<string, string> = new Map([
    ['enabled', '是否加载插件是部署决策：项目文件不能把测试设计门禁关掉（关掉等于让 spec_approve 不再检查测试设计）'],
    ['logFile', '日志落盘位置是部署决策，只能由 profile 决定'],
    ['layout', '工件（规格 / mission / 评审报告）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['rootDir', '工件（规格 / mission / 评审报告）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['specsDir', '被评审的规格工件的落点由宿主布局决定，项目文件不能把它指向别处'],
    ['missionsDir', '工件（规格 / mission / 评审报告）落在哪由宿主布局决定，项目文件不能迁移它们'],
    ['prompt', '系统提示词章节属于宿主装配决策，只能由 profile 决定'],
])

/** The resolved configuration plus where it came from. */
export interface EffectiveTestDesignGateConfig {
    config: TestDesignGateConfig
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

/**
 * Read a positive integer override (`minTextLength`).
 *
 * A fractional, zero, negative or wrongly typed value is a problem, not a
 * silent clamp: `"20"` is not a number the reviewer measured, and coercing it
 * would let a typo change the review without anyone noticing.
 */
function readPositiveInteger(sink: ProblemSink, raw: Record<string, unknown>, key: string, fallback: number): number {
    if (!has(raw, key)) return fallback
    const value = raw[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
    problem(sink, `${key} 必须是 ≥ 1 的整数（收到 ${describeValue(value)}），已忽略该项目级取值（继续使用 profile 配置）`)
    return fallback
}

/**
 * Overlay one workspace's project file on the profile configuration.
 *
 * Split from {@link resolveEffectiveConfig} so the public entry point can wrap
 * it: a project file must never be able to make a tool throw.
 */
function overlay(host: TestDesignGateConfig, layout: Layout, logger?: Logger): EffectiveTestDesignGateConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'test-design-gate')
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
                ? `键 "${key}" 不是 dsh-test-design-gate 的可覆盖键（profile 是上限），已忽略`
                : `键 "${key}" 不允许在项目级配置里覆盖（profile 是上限）：${reason}；已忽略`,
        )
    }

    const config: TestDesignGateConfig = {
        ...host,
        minTextLength: readPositiveInteger(sink, raw, 'minTextLength', host.minTextLength),
        strict: readBool(sink, raw, 'strict', host.strict),
        allowDanglingCase: readBool(sink, raw, 'allowDanglingCase', host.allowDanglingCase),
        requireAllScenarios: readBool(sink, raw, 'requireAllScenarios', host.requireAllScenarios),
    }
    // `source` says where the EFFECTIVE values came from: a file whose keys were
    // all refused (or all ill-typed) contributed nothing, so it is not the
    // source of the review policy that will be enforced.
    const source = changed(host, config) ? 'project' : 'profile'
    logger?.info(
        source === 'project'
            ? `test-design-gate: 使用项目级配置 ${file.file}（minTextLength=${config.minTextLength}; strict=${config.strict}; allowDanglingCase=${config.allowDanglingCase}; requireAllScenarios=${config.requireAllScenarios}）`
            : `test-design-gate: 项目级配置 ${file.file} 未改变任何可覆盖键（${problems.length} 条配置问题，继续使用 profile 配置）`,
    )
    return { config, source, file: file.file, problems }
}

/**
 * Resolve the configuration that applies to one workspace.
 *
 * Reads `<workspace>/.dsh/test-design-gate.json` (see `dsh-eng-core`'s project
 * config helper) and overlays the allow-listed keys on the profile
 * configuration, which stays the ceiling: keys outside
 * {@link PROJECT_OVERRIDABLE_KEYS} are ignored with a logged problem, never
 * silently honoured. A malformed file (bad JSON, non-object top level,
 * bad-typed values) falls back to the profile configuration with a problem, so
 * a broken project file can never weaken the review.
 *
 * `source` reports where the *effective* values came from: `project` only when
 * the file really changed an allow-listed key (a file whose keys were all
 * refused, or all ill-typed, leaves the profile configuration in force).
 *
 * Never throws: a gate is evaluated on hot paths (every review, every prompt
 * assembly), so a failure to even read the file degrades to the profile
 * configuration with a problem instead of breaking the caller.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - diagnostics sink.
 */
export function resolveEffectiveConfig(
    host: TestDesignGateConfig,
    layout: Layout,
    logger?: Logger,
): EffectiveTestDesignGateConfig {
    try {
        return overlay(host, layout, logger)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const problem = `读取项目级配置失败（${reason}），已回退到 profile 配置`
        logger?.warn(problem)
        return { config: host, source: 'profile', problems: [problem] }
    }
}

/** Whether a project file actually changed one of the allow-listed values. */
function changed(host: TestDesignGateConfig, config: TestDesignGateConfig): boolean {
    return (
        config.minTextLength !== host.minTextLength ||
        config.strict !== host.strict ||
        config.allowDanglingCase !== host.allowDanglingCase ||
        config.requireAllScenarios !== host.requireAllScenarios
    )
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): TestDesignGateConfig {
    const raw = isRecord(input) ? input : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/test-design-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
        },
        minTextLength: Math.max(1, Math.trunc(num(raw['minTextLength'], 4))),
        strict: bool(raw['strict'], false),
        allowDanglingCase: bool(raw['allowDanglingCase'], false),
        requireAllScenarios: bool(raw['requireAllScenarios'], true),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 630),
        },
    }
}

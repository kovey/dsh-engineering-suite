/**
 * Plugin configuration: the thresholds, the host commands and the flaky policy.
 *
 * Two layers, the same rule every plugin in this suite follows (docs.md §9):
 *
 *  - the **profile row** is the ceiling — it decides whether the gate exists at
 *    all, where its log and artifacts live, and whether a flaky suite blocks;
 *  - `<repo>/.dsh/coverage-gate.json` may **refine** which command produces the
 *    report here, where that report is written, in which format it is, and how
 *    strict the numbers are. A repository is the only place that knows whether
 *    it runs `vitest --coverage` or `go test -coverprofile`.
 *
 * Percentages are the one thing this file refuses to guess: a threshold that is
 * not a number in `0…100` is **dropped with a message** (never replaced by a
 * default), because a silently-defaulted threshold is a silently-weakened gate.
 *
 * @module dsh-coverage-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Which report format the parser should expect (`auto` sniffs it). */
export type ReportFormat = 'auto' | 'lcov' | 'cobertura' | 'go-cover' | 'istanbul-json'

/** What happens when `flaky_check` finds an unstable test. */
export type FlakyPolicy = 'block' | 'warn' | 'off'

/**
 * Coverage thresholds, all percentages in `0…100`.
 *
 * `perFile` applies to every file the report instruments (a file with no
 * instrumented unit cannot be judged and is skipped). `changed` applies only to
 * the lines this change ADDED — and only to those the report actually
 * instruments; see {@link module:dsh-coverage-gate/coverage}.
 */
export interface CoverageThresholds {
    /** Whole-report line/statement coverage. */
    total?: number
    /** Coverage of the lines this change added. */
    changed?: number
    /** Every instrumented file must reach this. */
    perFile?: number
}

/** Resolved plugin configuration. */
export interface CoverageGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only), e.g. `~/.dsh/logs/{project}/coverage-gate.log`. */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Thresholds in force (see {@link CoverageThresholds}); may be empty → the gate refuses. */
    thresholds: CoverageThresholds
    /**
     * Host command template that (re)generates the coverage report, tokenised
     * without a shell. Placeholders: `{reportFile}`, `{workspace}`, `{base}`.
     */
    coverageCommand?: string
    /** Where the coverage report is written, relative to the workspace. */
    reportFile?: string
    /** Expected report format; `auto` sniffs it and refuses unknown text. */
    reportFormat: ReportFormat
    /** `block` records BLOCK, `warn` records WARN, `off` records nothing. */
    flakyPolicy: FlakyPolicy
    /** How many times `flaky_check` runs the command (1…{@link MAX_FLAKY_REPEATS}). */
    flakyRepeats: number
    /**
     * Command template the flaky check repeats. Placeholders: `{run}` (1-based),
     * `{run0}` (0-based), `{workspace}`.
     */
    flakyCommand?: string
    /** Deadline for one coverage/flaky command run. */
    commandTimeoutMs: number
    /** Per-stream capture cap for one run. */
    maxOutputBytes: number
    prompt: {
        enabled: boolean
        order: number
    }
}

/** Hard ceiling for `flakyRepeats`: flakiness detection must not become a load test. */
export const MAX_FLAKY_REPEATS = 10

/** Default repeats when the host names none. */
export const DEFAULT_FLAKY_REPEATS = 3

/** The shortest run count that can possibly prove flakiness. */
export const MIN_FLAKY_REPEATS = 2

/** Every format the parser understands, plus `auto`. */
export const REPORT_FORMATS: readonly ReportFormat[] = ['auto', 'lcov', 'cobertura', 'go-cover', 'istanbul-json']

/** Every flaky policy, most strict first. */
export const FLAKY_POLICIES: readonly FlakyPolicy[] = ['block', 'warn', 'off']

/**
 * Keys a repository may refine through `<repo>/.dsh/coverage-gate.json`.
 *
 * Which command produces the report, where it lands and how strict the numbers
 * are is repository knowledge. `flakyPolicy` is NOT here: it decides whether an
 * unstable suite still delivers, which is the host's call (a repository that
 * could set `off` would be exempting itself).
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'thresholds',
    'coverageCommand',
    'reportFile',
    'reportFormat',
    'flakyRepeats',
    'flakyCommand',
    'commandTimeoutMs',
    'maxOutputBytes',
]

/** Keys a project file may set to `null` to mean "this repository has none". */
export const PROJECT_CLEARABLE_KEYS: readonly string[] = ['coverageCommand', 'reportFile', 'flakyCommand']

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

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Whether a value is a usable percentage (a finite number in `0…100`). */
export function isPercent(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

/** Render a percentage for a report (one decimal, no trailing `.0` noise). */
export function formatPercent(value: number): string {
    return `${Math.round(value * 10) / 10}%`
}

/** The threshold keys, in the order a report lists them. */
export const THRESHOLD_KEYS = ['total', 'changed', 'perFile'] as const

/** One threshold key. */
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number]

/**
 * Validate one untrusted threshold value.
 * @param value - the raw value.
 * @param key - which threshold (for the message).
 * @param where - the provenance (for the message).
 * @returns the parsed percentage, or an error message.
 */
export function parsePercent(value: unknown, key: string, where: string): number | { error: string } {
    if (!isPercent(value)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return { error: `${where}: thresholds.${key} 必须在 0–100 之间（收到 ${value}）；已忽略该阈值（百分比不是比例、也不是千分比）` }
        }
        return {
            error: `${where}: thresholds.${key} 必须是 0–100 的数字（收到 ${JSON.stringify(value)}）；已忽略该阈值，不会用默认值替代——阈值被静默默认化等于门禁被静默放宽`,
        }
    }
    return value
}

/**
 * Validate a whole thresholds object (call arguments and project files share it).
 * @param input - the untrusted value.
 * @param where - the provenance (for the messages).
 * @returns the accepted thresholds plus one problem per refused key.
 */
export function parseThresholds(input: unknown, where: string): { thresholds: CoverageThresholds; problems: string[] } {
    const problems: string[] = []
    const thresholds: CoverageThresholds = {}
    if (input === undefined || input === null) return { thresholds, problems }
    if (!isRecord(input)) {
        problems.push(`${where}: thresholds 必须是对象（例如 { "total": 80, "changed": 80 }）`)
        return { thresholds, problems }
    }
    for (const key of THRESHOLD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue
        const parsed = parsePercent(input[key], key, where)
        if (typeof parsed === 'number') thresholds[key] = parsed
        else problems.push(parsed.error)
    }
    for (const key of Object.keys(input)) {
        if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) {
            problems.push(`${where}: 未知的阈值键 "${key}"（可用：${THRESHOLD_KEYS.join(', ')}）`)
        }
    }
    return { thresholds, problems }
}

/** Sort a threshold key list into the canonical order. */
export function thresholdKeys(thresholds: CoverageThresholds): ThresholdKey[] {
    return THRESHOLD_KEYS.filter((key) => thresholds[key] !== undefined)
}

/** Render a thresholds object as a compact one-line table. */
export function describeThresholds(thresholds: CoverageThresholds): string {
    const keys = thresholdKeys(thresholds)
    if (keys.length === 0) return '(未配置任何阈值)'
    return keys.map((key) => `${key} ≥ ${formatPercent(thresholds[key] as number)}`).join('，')
}

/**
 * Resolve the plugin configuration from the loader row.
 * @param input - the row's `config` value (untrusted).
 * @param warn - sink for recoverable configuration problems.
 */
export function resolveConfig(input: unknown, warn: (message: string) => void = () => undefined): CoverageGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const { thresholds, problems } = parseThresholds(raw['thresholds'], 'profile 配置')
    for (const problem of problems) warn(problem)

    const format = raw['reportFormat']
    let reportFormat: ReportFormat = 'auto'
    if (format !== undefined) {
        if (typeof format === 'string' && (REPORT_FORMATS as readonly string[]).includes(format)) {
            reportFormat = format as ReportFormat
        } else {
            warn(`profile 配置: reportFormat 只能是 ${REPORT_FORMATS.join(' / ')}（收到 ${JSON.stringify(format)}），已按 auto 处理（auto 识别不了会拒绝，不会当成 0 覆盖）`)
        }
    }

    const policy = raw['flakyPolicy']
    let flakyPolicy: FlakyPolicy = 'block'
    if (policy !== undefined) {
        if (typeof policy === 'string' && (FLAKY_POLICIES as readonly string[]).includes(policy)) {
            flakyPolicy = policy as FlakyPolicy
        } else {
            warn(`profile 配置: flakyPolicy 只能是 ${FLAKY_POLICIES.join(' / ')}（收到 ${JSON.stringify(policy)}），已按最严格的 block 处理`)
        }
    }

    const repeats = num(raw['flakyRepeats'], DEFAULT_FLAKY_REPEATS)
    if (repeats !== Math.floor(repeats) || repeats < 1) {
        warn(`profile 配置: flakyRepeats 必须是正整数（收到 ${repeats}），已按默认值 ${DEFAULT_FLAKY_REPEATS} 处理`)
    } else if (repeats > MAX_FLAKY_REPEATS) {
        warn(`profile 配置: flakyRepeats=${repeats} 超过上限 ${MAX_FLAKY_REPEATS}，已收敛到上限（重复运行不能变成压力测试）`)
    }

    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/coverage-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        thresholds,
        ...(typeof raw['coverageCommand'] === 'string' && raw['coverageCommand'].trim() !== ''
            ? { coverageCommand: raw['coverageCommand'].trim() }
            : {}),
        ...(typeof raw['reportFile'] === 'string' && raw['reportFile'].trim() !== ''
            ? { reportFile: raw['reportFile'].trim() }
            : {}),
        reportFormat,
        flakyPolicy,
        flakyRepeats: Math.min(MAX_FLAKY_REPEATS, Math.max(1, Math.floor(repeats))),
        ...(typeof raw['flakyCommand'] === 'string' && raw['flakyCommand'].trim() !== ''
            ? { flakyCommand: raw['flakyCommand'].trim() }
            : {}),
        commandTimeoutMs: Math.max(1_000, Math.floor(num(raw['commandTimeoutMs'], 300_000))),
        maxOutputBytes: Math.max(1_024, Math.floor(num(raw['maxOutputBytes'], 64_000))),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 645),
        },
    }
}

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: CoverageGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file: string
    /** Recoverable problems (unknown keys, unusable values). */
    problems: string[]
}

/**
 * Overlay a workspace's own `<repo>/.dsh/coverage-gate.json` on the profile row.
 *
 * Key-by-key onto the HOST configuration, so a field this overlay forgets to
 * copy can never be reset to a plugin default (the bug standards-gate's history
 * records). A refused key keeps the profile's value and says why.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 */
export function resolveEffectiveConfig(
    host: CoverageGateConfig,
    layout: Layout,
    logger?: Logger | { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'coverage-gate')
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

    const next: CoverageGateConfig = { ...host, thresholds: { ...host.thresholds }, prompt: host.prompt }
    let applied = 0
    const reject = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }

    // thresholds: a project may set any key the profile leaves open, and may
    // refine one the profile set (the repository knows its own legacy debt).
    if (raw['thresholds'] !== undefined) {
        const parsed = parseThresholds(raw['thresholds'], file.file)
        for (const problem of parsed.problems) reject(problem)
        if (Object.keys(parsed.thresholds).length > 0) {
            next.thresholds = { ...host.thresholds, ...parsed.thresholds }
            applied += 1
        }
    }

    // `null` is the explicit "this repository has none" (a Rust repo has no
    // `vitest --coverage`); an absent key inherits the profile's value.
    const takeCommand = (key: 'coverageCommand' | 'reportFile' | 'flakyCommand'): void => {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) return
        const value = raw[key]
        if (value === null) {
            delete next[key]
            applied += 1
            return
        }
        if (typeof value === 'string' && value.trim() !== '') {
            next[key] = value.trim()
            applied += 1
            return
        }
        reject(`${file.file}: ${key} 必须是非空字符串，或显式 null 表示本仓库没有（已忽略，继续使用 profile 的值）`)
    }
    takeCommand('coverageCommand')
    takeCommand('reportFile')
    takeCommand('flakyCommand')

    if (raw['reportFormat'] !== undefined) {
        const value = raw['reportFormat']
        if (typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value)) {
            next.reportFormat = value as ReportFormat
            applied += 1
        } else {
            reject(`${file.file}: reportFormat 只能是 ${REPORT_FORMATS.join(' / ')}，已忽略（继续使用 profile 的值）`)
        }
    }

    if (raw['flakyRepeats'] !== undefined) {
        const value = raw['flakyRepeats']
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
            next.flakyRepeats = Math.min(MAX_FLAKY_REPEATS, value)
            applied += 1
        } else {
            reject(`${file.file}: flakyRepeats 必须是正整数，已忽略（继续使用 profile 的值）`)
        }
    }

    const takePositiveInt = (key: 'commandTimeoutMs' | 'maxOutputBytes', floor: number): void => {
        if (raw[key] === undefined) return
        const value = raw[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= floor) {
            next[key] = Math.floor(value)
            applied += 1
            return
        }
        reject(`${file.file}: ${key} 必须是不小于 ${floor} 的数字，已忽略（继续使用 profile 的值）`)
    }
    takePositiveInt('commandTimeoutMs', 1_000)
    takePositiveInt('maxOutputBytes', 1_024)

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

/** One-line provenance for a report ("profile 配置" / "项目级配置 <file>"). */
export function describeSource(effective: EffectiveConfig): string {
    return effective.source === 'project' ? `项目级配置 ${effective.file}` : 'profile 配置'
}

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
import {
    MUTATION_OPERATOR_GROUPS,
    MUTATION_OPERATOR_IDS,
    type MutationThresholds,
} from './mutation.js'

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
    /**
     * Mutation testing: `coverage_check` says the line ran, `mutation_check` says
     * whether an assertion would have noticed it being wrong. Off by default —
     * it rewrites source files and runs the suite once per mutant.
     */
    mutation: MutationConfig
    prompt: {
        enabled: boolean
        order: number
    }
}

/**
 * Mutation-testing configuration (see {@link module:dsh-coverage-gate/mutation}).
 *
 * Every limit here exists because this gate spends real wall-clock time and real
 * CPU: it runs the FULL test command once per mutant, having first rewritten a
 * source file. `enabled` therefore defaults to `false`.
 */
export interface MutationConfig {
    /** Off unless the host turns it on (a repository may turn it ON, never off). */
    enabled: boolean
    /** Source globs to mutate; unset = detected from the workspace's languages. */
    sourceGlobs?: string[]
    /** Extra excludes, on top of the built-in `.dsh/**`, `.git/**`, vendor, build output list. */
    excludeGlobs: string[]
    /**
     * Command template that runs the tests, tokenised without a shell (argv only).
     * Placeholder: `{workspace}`.
     */
    testCommand?: string
    /** Operator ids or group names; empty = the whole set. */
    operators: string[]
    /** Hard cap on planned mutants (1…{@link MAX_MUTANTS_CEILING}). */
    maxMutants: number
    /** Wall-clock budget for one `mutation_check` run. */
    timeBudgetMs: number
    /** Thresholds in force; no score threshold → `mutation_check` refuses. */
    thresholds: MutationThresholds
    /** Diff base for `changed: true` (default `HEAD`). */
    baseRef: string
}

/**
 * Hard ceiling for `maxMutants`: running the whole suite once per mutant is a
 * real cost, and a gate that takes an hour is a gate people turn off.
 */
export const MAX_MUTANTS_CEILING = 200

/** Default mutant cap when the host names none. */
export const DEFAULT_MAX_MUTANTS = 20

/** Default wall-clock budget for one mutation run (10 minutes). */
export const DEFAULT_MUTATION_TIME_BUDGET_MS = 600_000

/** Shortest budget that can run anything at all. */
export const MIN_MUTATION_TIME_BUDGET_MS = 1_000

/** The keys of the `mutation` block, for messages and the project overlay. */
export const MUTATION_KEYS: readonly string[] = [
    'enabled',
    'sourceGlobs',
    'excludeGlobs',
    'testCommand',
    'operators',
    'maxMutants',
    'timeBudgetMs',
    'thresholds',
    'baseRef',
]

/** Threshold keys of the `mutation.thresholds` block. */
export const MUTATION_THRESHOLD_KEYS: readonly string[] = ['mutationScore', 'changedMutationScore', 'maxSurvived']

/** The configuration in force when the host says nothing about mutation. */
export function defaultMutationConfig(): MutationConfig {
    return {
        enabled: false,
        excludeGlobs: [],
        operators: [],
        maxMutants: DEFAULT_MAX_MUTANTS,
        timeBudgetMs: DEFAULT_MUTATION_TIME_BUDGET_MS,
        thresholds: {},
        baseRef: 'HEAD',
    }
}

/**
 * Validate a `mutation` block (profile and project files share this).
 * @param input - the untrusted value.
 * @param where - the provenance, for messages.
 * @param warn - sink for recoverable problems.
 * @param base - the values to start from (the profile's, for a project overlay).
 */
export function parseMutationConfig(
    input: unknown,
    where: string,
    warn: (message: string) => void,
    base: MutationConfig = defaultMutationConfig(),
): MutationConfig {
    const next: MutationConfig = { ...base, thresholds: { ...base.thresholds } }
    if (input === undefined || input === null) return next
    if (!isRecord(input)) {
        warn(`${where}: mutation 必须是对象（例如 { "enabled": true, "testCommand": "node --test test/*.test.ts" }）`)
        return next
    }
    for (const key of Object.keys(input)) {
        if (!MUTATION_KEYS.includes(key)) {
            warn(`${where}: 未知的 mutation 键 "${key}"（可用：${MUTATION_KEYS.join(', ')}）`)
        }
    }

    if (input['enabled'] !== undefined) {
        if (typeof input['enabled'] === 'boolean') next.enabled = input['enabled']
        else warn(`${where}: mutation.enabled 必须是布尔值（收到 ${JSON.stringify(input['enabled'])}），已忽略（保持 ${next.enabled}）`)
    }

    for (const key of ['sourceGlobs', 'excludeGlobs'] as const) {
        if (input[key] === undefined) continue
        const value = input[key]
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
            warn(`${where}: mutation.${key} 必须是非空字符串数组，已忽略（不会用默认值替代一个写错的 glob）`)
            continue
        }
        const globs = (value as string[]).map((entry) => entry.trim())
        const absolute = globs.filter((glob) => glob.startsWith('/') || /^[A-Za-z]:[\\/]/.test(glob))
        if (absolute.length > 0) {
            warn(`${where}: mutation.${key} 里的 ${absolute.join(', ')} 是绝对路径：glob 必须相对工作区（这些条目永不匹配，已按原样保留但请改掉）`)
        }
        next[key] = globs
    }
    if (next.sourceGlobs !== undefined && next.sourceGlobs.length === 0) delete next.sourceGlobs

    if (input['testCommand'] !== undefined) {
        if (typeof input['testCommand'] === 'string' && input['testCommand'].trim() !== '') {
            next.testCommand = input['testCommand'].trim()
        } else if (input['testCommand'] === null) {
            delete next.testCommand
        } else {
            warn(`${where}: mutation.testCommand 必须是非空字符串，或显式 null 表示"没有"（已忽略）`)
        }
    }

    if (input['operators'] !== undefined) {
        const value = input['operators']
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
            warn(`${where}: mutation.operators 必须是非空字符串数组（操作符 id 或组名），已忽略（按全部操作符处理）`)
        } else {
            const names = (value as string[]).map((entry) => entry.trim())
            const unknown = names.filter(
                (name) => !MUTATION_OPERATOR_IDS.includes(name) && !MUTATION_OPERATOR_GROUPS.includes(name as never),
            )
            if (unknown.length > 0) {
                // Dropping ONE operator out of a list would silently change the
                // gate's measurement; the whole key is refused instead.
                warn(
                    `${where}: mutation.operators 含未知操作符 ${unknown
                        .map((name) => `"${name}"`)
                        .join(', ')}：已忽略整个 operators 配置（不会只丢掉写错的那些，那等于静默改变门禁口径）；可用 id：${MUTATION_OPERATOR_IDS.join(
                        ', ',
                    )}；可用组名：${MUTATION_OPERATOR_GROUPS.join(', ')}`,
                )
            } else {
                next.operators = names
            }
        }
    }

    if (input['maxMutants'] !== undefined) {
        const value = input['maxMutants']
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
            if (value > MAX_MUTANTS_CEILING) {
                warn(`${where}: mutation.maxMutants=${value} 超过上限 ${MAX_MUTANTS_CEILING}，已收敛到上限（每个变异体都要跑一遍完整测试）`)
            }
            next.maxMutants = Math.min(MAX_MUTANTS_CEILING, value)
        } else {
            warn(`${where}: mutation.maxMutants 必须是正整数，已忽略（保持 ${next.maxMutants}）`)
        }
    }

    if (input['timeBudgetMs'] !== undefined) {
        const value = input['timeBudgetMs']
        if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_MUTATION_TIME_BUDGET_MS) {
            next.timeBudgetMs = Math.floor(value)
        } else {
            warn(`${where}: mutation.timeBudgetMs 必须是不小于 ${MIN_MUTATION_TIME_BUDGET_MS} 的数字，已忽略（保持 ${next.timeBudgetMs}）`)
        }
    }

    if (input['baseRef'] !== undefined) {
        const value = input['baseRef']
        if (typeof value === 'string' && value.trim() !== '') next.baseRef = value.trim()
        else warn(`${where}: mutation.baseRef 必须是非空字符串（例如 HEAD、origin/main），已忽略（保持 ${next.baseRef}）`)
    }

    if (input['thresholds'] !== undefined) {
        const parsed = parseMutationThresholds(input['thresholds'], `${where}: mutation.thresholds`)
        for (const problem of parsed.problems) warn(problem)
        // Merged onto the base, never substituted for it: a project file with a
        // typo in one key must not silently DROP the host's other thresholds.
        next.thresholds = { ...base.thresholds, ...parsed.thresholds }
    }
    return next
}

/**
 * Validate a `mutation.thresholds` block.
 *
 * Same rule as the coverage thresholds: a value that is not a number in its
 * domain is DROPPED WITH A MESSAGE, never replaced by a default — a silently
 * defaulted threshold is a silently weakened gate.
 * @param input - the untrusted value.
 * @param where - the provenance, for messages.
 */
export function parseMutationThresholds(
    input: unknown,
    where: string,
): { thresholds: MutationThresholds; problems: string[] } {
    const problems: string[] = []
    const thresholds: MutationThresholds = {}
    if (input === undefined || input === null) return { thresholds, problems }
    if (!isRecord(input)) {
        problems.push(`${where} 必须是对象（例如 { "mutationScore": 60, "maxSurvived": 5 }）`)
        return { thresholds, problems }
    }
    for (const key of MUTATION_THRESHOLD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue
        const value = input[key]
        if (key === 'maxSurvived') {
            if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
                thresholds.maxSurvived = value
            } else {
                problems.push(`${where}.maxSurvived 必须是不小于 0 的整数（收到 ${JSON.stringify(value)}）；已忽略该阈值，不会用默认值替代`)
            }
            continue
        }
        const parsed = parsePercent(value, key, where)
        if (typeof parsed === 'number') thresholds[key as 'mutationScore' | 'changedMutationScore'] = parsed
        else problems.push(parsed.error)
    }
    for (const key of Object.keys(input)) {
        if (!MUTATION_THRESHOLD_KEYS.includes(key)) {
            problems.push(`${where}: 未知的阈值键 "${key}"（可用：${MUTATION_THRESHOLD_KEYS.join(', ')}）`)
        }
    }
    return { thresholds, problems }
}

/** Render the mutation thresholds as a compact one-line table. */
export function describeMutationThresholds(thresholds: MutationThresholds): string {
    const parts: string[] = []
    if (thresholds.mutationScore !== undefined) parts.push(`mutationScore ≥ ${formatPercent(thresholds.mutationScore)}`)
    if (thresholds.changedMutationScore !== undefined) parts.push(`changedMutationScore ≥ ${formatPercent(thresholds.changedMutationScore)}`)
    if (thresholds.maxSurvived !== undefined) parts.push(`maxSurvived ≤ ${thresholds.maxSurvived}`)
    return parts.length === 0 ? '(未配置任何变异阈值)' : parts.join('，')
}

/** One-line description of the mutation block for prompts and status output. */
export function describeMutation(config: MutationConfig): string {
    if (!config.enabled) return '未启用（默认关闭：每个变异体都要跑一遍完整测试；把 mutation.enabled 设为 true 才会进入门禁）'
    return [
        `已启用：testCommand ${
            config.testCommand === undefined ? '（未配置：会尝试 flakyCommand / coverageCommand 的测试调用，都不行就拒绝）' : `\`${config.testCommand}\``
        }`,
        `sourceGlobs ${config.sourceGlobs === undefined ? '(按工作区语言探测)' : config.sourceGlobs.join(', ')}`,
        `operators ${config.operators.length === 0 ? '(全部)' : config.operators.join(', ')}`,
        `maxMutants ${config.maxMutants}`,
        `时间预算 ${Math.round(config.timeBudgetMs / 1000)}s`,
        `阈值 ${describeMutationThresholds(config.thresholds)}`,
    ].join('；')
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
    'mutation',
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
        mutation: parseMutationConfig(raw['mutation'], 'profile 配置', warn),
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

    const next: CoverageGateConfig = {
        ...host,
        thresholds: { ...host.thresholds },
        mutation: { ...host.mutation, thresholds: { ...host.mutation.thresholds } },
        prompt: host.prompt,
    }
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

    // mutation: the repository knows whether its suite can be run per mutant and
    // which globs hold its source. ONE asymmetry is deliberate — a project may
    // turn mutation testing ON for itself, but may not turn OFF a gate the host
    // enabled (self-exemption, the same rule as `enabled` and `flakyPolicy`).
    if (raw['mutation'] !== undefined) {
        const merged = parseMutationConfig(raw['mutation'], file.file, (message) => reject(message), host.mutation)
        if (isRecord(raw['mutation']) && raw['mutation']['enabled'] === false && host.mutation.enabled) {
            reject(`${file.file}: mutation.enabled 不能在项目级配置里关闭（profile 已启用）：仓库不能给自己关掉门禁；已保持 profile 的 true`)
            merged.enabled = true
        }
        if (JSON.stringify(merged) !== JSON.stringify(host.mutation)) applied += 1
        next.mutation = merged
    }

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

/** One-line provenance for a report ("profile 配置" / "项目级配置 <file>"). */
export function describeSource(effective: EffectiveConfig): string {
    return effective.source === 'project' ? `项目级配置 ${effective.file}` : 'profile 配置'
}

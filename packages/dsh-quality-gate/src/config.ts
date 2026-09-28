/**
 * Plugin configuration. The command list is the gate's deterministic core
 * (docs.md §3.4/§9): it comes from the host's loader row, never from the model.
 * @module dsh-quality-gate/config
 */

import { containedPath, loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'
import {
    DEFAULT_BASELINE_LOCK_RETRY_MS,
    DEFAULT_BASELINE_LOCK_STALE_MS,
    MAX_BASELINE_LOCK_RETRY_MS,
    parseBudget,
    type BudgetConfig,
} from './budget.js'
import { parseContract, type ContractConfig } from './contract.js'

/** Which phase a configured command belongs to. */
export type CommandPhase = 'gate' | 'lint'

/** One host-configured command. */
export interface GateCommandConfig {
    /** Stable id referenced by `quality_gate_run`'s `only` argument. */
    id: string
    /** Human-readable name shown in verdicts. */
    name: string
    /** The exact command line (tokenised without a shell). */
    command: string
    /** Working directory override, resolved against the workspace. */
    cwd?: string
    /** A failing required command turns the verdict into `BLOCK`. */
    required: boolean
    /** Cooperative deadline. */
    timeoutMs: number
    /** `gate` runs at turn end; `lint` also runs after every write. */
    phase: CommandPhase
    /** Extra environment entries. */
    env?: Record<string, string>
}

/** Resolved plugin configuration. */
export interface QualityGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only), e.g. `~/.dsh/logs/{project}/quality-gate.log`. */
    logFileTemplate?: string
    layout: LayoutOptions
    commands: readonly GateCommandConfig[]
    /**
     * Regression budgets (docs.md §3.4's missing half): numbers that must not
     * get worse, measured from host-configured commands.
     */
    budgets: readonly BudgetConfig[]
    /**
     * Host opt-in: refuse a `budget_check` that covers NONE of the budgets the
     * mission's specification declares (default `false`).
     *
     * A declared, approved non-functional requirement that nobody verified must
     * not pass silently into delivery — but the coupling is opt-in, because
     * turning it on changes what a run accepts. It is a HOST key on purpose
     * (like `enabled` / `logFile`): a workspace may declare its own budgets, yet
     * it may not switch the host's compliance requirement off.
     */
    requireSpecBudgets: boolean
    /** Smoke contracts: declared interface expectations, asserted one by one. */
    contracts: readonly ContractConfig[]
    readonly writeTools: readonly string[]
    /** Gate evaluation when the agent stops its turn. */
    turnStop: {
        enabled: boolean
        /** Maximum corrective steers per turn (loop breaker). */
        maxBlocksPerTurn: number
    }
    /** Lint feedback loop after a successful write tool. */
    afterWrite: {
        enabled: boolean
        /** Turn a failing lint into an error result carrying the findings. */
        blockOnFailure: boolean
        /** Maximum blocks per turn. */
        maxPerTurn: number
    }
    defaultTimeoutMs: number
    maxOutputBytes: number
    /**
     * Bounded retry budget (ms) for the exclusive lock around the baseline
     * read-modify-write (default {@link DEFAULT_BASELINE_LOCK_RETRY_MS}).
     *
     * Two `budget_check` runs on one workspace (two sessions, or a subagent) both
     * read and rewrite `<rootDir>/budgets.json`: without the lock the later write
     * silently drops the other's measurement, which is worse than a refused run.
     * HOST-only, like `enabled` / `logFile`: how long a gate waits is a host
     * scheduling decision, not repository knowledge — and an unusable value keeps
     * the host's value (it is reported, never silently defaulted).
     */
    baselineLockRetryMs: number
    /**
     * Age (ms, default {@link DEFAULT_BASELINE_LOCK_STALE_MS}) beyond which an
     * existing lock file is reported with its age and REFUSED with a manual
     * removal instruction, instead of being waited on or deleted automatically —
     * the process holding it may simply be slow.
     */
    baselineLockStaleMs: number
    limits: {
        /** `0` disables; otherwise a change budget the gate enforces (docs.md §9). */
        maxChangedFiles: number
    }
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

function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * Read one millisecond configuration value.
 *
 * The suite rule for an unusable value: it KEEPS the host's value and is
 * REPORTED — never silently replaced by a default (a typo in a lock bound must
 * not look like a deliberate choice), and never allowed past a ceiling that
 * would turn a gate into a hang.
 * @param value - the untrusted config value.
 * @param fallback - the host's value in force.
 * @param ceiling - hard maximum when the key has one.
 * @param key - the key name, for the message.
 * @param warn - problem sink.
 */
function clampLockMs(value: unknown, fallback: number, ceiling: number | undefined, key: string, warn: (message: string) => void): number {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        warn(`${key} 必须是 0 或正整数（收到 ${JSON.stringify(value)}），已忽略（保持 ${fallback}）`)
        return fallback
    }
    if (ceiling !== undefined && value > ceiling) {
        warn(`${key}=${value} 超过上限 ${ceiling}，已收敛到上限（等待锁不能变成挂死）`)
        return ceiling
    }
    return value
}

/** The default write-class tools (docs.md §3.4's lint loop triggers on these). */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['write', 'edit']

/** Example commands, shown when the host configures none. */
export const EXAMPLE_BUDGETS: string = [
    '# budgets:',
    '#   - id: bundle',
    '#     name: 前端包体积',
    '#     metric: bytes            # durationMs | number | bytes',
    '#     command: node scripts/bundle-size.mjs',
    "#     regex: 'size=(\\d+)'      # metric != durationMs 时必填：第一个捕获组是纯数字",
    '#     unit: bytes',
    '#     max: 200000              # 绝对上限',
    '#     min: 0                   # 绝对下限',
    '#     maxRegressionPercent: 10 # 相对"历史最佳值"允许的变差幅度',
    '#',
    '# 预算也可以声明在规格里（spec_create / spec_amend 的 budgets 参数）：两者同 id 时宿主配置优先，',
    '# 差别会作为冲突列在 budget_check 的报告里（绝不会静默取其一）。requireSpecBudgets: true 时，',
    '# 规格声明了预算而本次一条都没覆盖，budget_check 直接拒绝（默认 false，不改变既有行为）。',
].join('\n')

/** Example contracts, shown when the host configures none. */
export const EXAMPLE_CONTRACTS: string = [
    '# contracts:',
    '#   - id: api-smoke',
    '#     name: 接口冒烟',
    '#     kind: http               # cli | http | schema | command',
    '#     command: node scripts/smoke.mjs',
    '#     expect:',
    '#       exitCode: 0',
    '#       stdoutContains: [ok]',
    '#       stdoutNotContains: [stack trace]',
    "#       jsonPaths: [{ path: 'data.items[0].id', type: number }]",
].join('\n')

/** Example commands, shown when the host configures none. */
export const EXAMPLE_COMMANDS: string = [
    '# commands:',
    "#   - id: test",
    "#     name: 单元测试",
    "#     command: pnpm test",
    "#     required: true",
    "#     phase: gate",
    "#   - id: lint",
    '#     name: ESLint',
    '#     command: pnpm run lint',
    '#     required: false',
    "#     phase: lint",
].join('\n')

/**
 * Keys a project file may override, and why the rest are refused.
 *
 * The profile is the ceiling: a project may choose WHICH commands run here (a
 * Rust repo has no `pnpm test`) and tighten limits, but it may not switch the
 * gate off, relocate the log, change where artifacts live, or turn
 * `requireSpecBudgets` off — those are host decisions, and a model-writable
 * escape hatch is exactly what this suite exists to prevent.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'commands',
    'budgets',
    'contracts',
    'limits',
    'defaultTimeoutMs',
    'maxOutputBytes',
    'writeTools',
    'turnStop',
    'afterWrite',
]

/** The resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: QualityGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file?: string
    /** Recoverable problems (unknown keys, malformed entries). */
    problems: string[]
}

/**
 * Resolve the configuration that applies to one workspace.
 *
 * Reads `<workspace>/.dsh/quality-gate.json` (see `dsh-eng-core`'s project
 * config helper): `commands` REPLACES the profile's list for this workspace,
 * the other allowed keys are shallow-merged. A malformed file, or a `commands`
 * list whose entries cannot be parsed, falls back to the profile configuration
 * with a loud problem instead of silently running nothing.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - diagnostics sink.
 */
export function resolveEffectiveConfig(host: QualityGateConfig, layout: Layout, logger?: Logger): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'quality-gate')
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

    // Provenance must not lie: a file whose every key was refused (or whose
    // values were all unusable) leaves the profile configuration in force, so
    // the source stays 'profile' with the problems reported.
    const appliedKeys = Object.keys(raw).filter((key) => PROJECT_OVERRIDABLE_KEYS.includes(key))
    if (appliedKeys.length === 0) return { config: host, source: 'profile', file: file.file, problems }

    let budgets = host.budgets
    let contracts = host.contracts
    let commands = host.commands
    // The list keys are parsed before the scalar ones so that a project file
    // replacing `budgets`/`contracts` is reported in file order.
    if (Object.prototype.hasOwnProperty.call(raw, 'budgets')) {
        const parsed = parseBudgetList(raw['budgets'], {
            file: file.file,
            report: (problem) => {
                problems.push(problem)
                logger?.warn(problem)
            },
            // A project file may relocate a budget's baseline INSIDE the workspace
            // and never outside it (see `parseBudgetList`).
            cwd: layout.cwd,
        })
        if (parsed === undefined) {
            const problem = `${file.file}: budgets 必须是数组，已忽略项目级预算（继续使用 profile 的预算）`
            problems.push(problem)
            logger?.warn(problem)
        } else {
            budgets = parsed
            logger?.info(`quality-gate: 使用项目级预算集（${parsed.length} 条，来自 ${file.file}）`)
        }
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'contracts')) {
        const parsed = parseContractList(raw['contracts'], { file: file.file, report: (problem) => { problems.push(problem); logger?.warn(problem) } })
        if (parsed === undefined) {
            const problem = `${file.file}: contracts 必须是数组，已忽略项目级契约（继续使用 profile 的契约）`
            problems.push(problem)
            logger?.warn(problem)
        } else {
            contracts = parsed
            logger?.info(`quality-gate: 使用项目级契约集（${parsed.length} 条，来自 ${file.file}）`)
        }
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'commands')) {
        const entries = raw['commands']
        if (!Array.isArray(entries)) {
            const problem = `${file.file}: commands 必须是数组，已忽略项目级命令（继续使用 profile 的命令）`
            problems.push(problem)
            logger?.warn(problem)
        } else {
            const parsed: GateCommandConfig[] = []
            let failed = 0
            for (const [index, entry] of entries.entries()) {
                const command = parseCommand(entry, index, host.defaultTimeoutMs)
                if ('error' in command) {
                    failed += 1
                    const problem = `${file.file}: ${command.error}`
                    problems.push(problem)
                    logger?.warn(problem)
                    continue
                }
                parsed.push(command)
            }
            if (failed > 0 && parsed.length === 0 && entries.length > 0) {
                const problem = `${file.file}: 项目级 commands 全部无法解析，回退到 profile 的命令`
                problems.push(problem)
                logger?.warn(problem)
            } else {
                const seen = new Set<string>()
                commands = parsed.filter((command) => {
                    if (seen.has(command.id)) {
                        const problem = `${file.file}: 重复的命令 id "${command.id}" 已忽略`
                        problems.push(problem)
                        logger?.warn(problem)
                        return false
                    }
                    seen.add(command.id)
                    return true
                })
                logger?.info(`quality-gate: 使用项目级命令集（${commands.length} 条，来自 ${file.file}）`)
            }
        }
    }

    const limits = isRecord(raw['limits']) ? raw['limits'] : {}
    const turnStop = isRecord(raw['turnStop']) ? raw['turnStop'] : {}
    const afterWrite = isRecord(raw['afterWrite']) ? raw['afterWrite'] : {}
    const config: QualityGateConfig = {
        ...host,
        commands,
        budgets,
        contracts,
        defaultTimeoutMs: num(raw['defaultTimeoutMs'], host.defaultTimeoutMs),
        maxOutputBytes: num(raw['maxOutputBytes'], host.maxOutputBytes),
        writeTools: strList(raw['writeTools'], host.writeTools),
        limits: {
            maxChangedFiles: Math.max(0, Math.floor(num(limits['maxChangedFiles'], host.limits.maxChangedFiles))),
        },
        turnStop: {
            enabled: bool(turnStop['enabled'], host.turnStop.enabled),
            maxBlocksPerTurn: num(turnStop['maxBlocksPerTurn'], host.turnStop.maxBlocksPerTurn),
        },
        afterWrite: {
            enabled: bool(afterWrite['enabled'], host.afterWrite.enabled),
            blockOnFailure: bool(afterWrite['blockOnFailure'], host.afterWrite.blockOnFailure),
            maxPerTurn: num(afterWrite['maxPerTurn'], host.afterWrite.maxPerTurn),
        },
    }
    return { config, source: 'project', file: file.file, problems }
}

/**
 * Parse one configured command.
 * @param input - the untrusted config entry.
 * @param index - position, used to build a fallback id.
 * @param defaultTimeoutMs - deadline applied when the entry omits one.
 * @returns the parsed command, or an error message.
 */
export function parseCommand(
    input: unknown,
    index: number,
    defaultTimeoutMs: number,
): GateCommandConfig | { error: string } {
    if (!isRecord(input)) return { error: `commands[${index}]: must be an object` }
    const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
    if (command === '') return { error: `commands[${index}]: "command" is required` }
    const id = str(input['id'], `cmd-${index + 1}`)
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) return { error: `commands[${index}]: invalid id "${id}"` }
    const phase = input['phase'] === 'lint' ? 'lint' : 'gate'
    const env = isRecord(input['env'])
        ? Object.fromEntries(
              Object.entries(input['env']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined
    return {
        id,
        name: str(input['name'], id),
        command,
        ...(typeof input['cwd'] === 'string' && input['cwd'] !== '' ? { cwd: input['cwd'] } : {}),
        // A lint command is optional by nature; a gate command is required
        // unless the host explicitly says otherwise.
        required: bool(input['required'], phase === 'gate'),
        timeoutMs: num(input['timeoutMs'], defaultTimeoutMs),
        phase,
        ...(env === undefined ? {} : { env }),
    }
}

/**
 * Parse one configured list of budgets (profile row or project file).
 *
 * The list is REPLACED wholesale, like `commands`: a Rust repository's budgets
 * are not the host's. A malformed entry is reported AND kept — the check refuses
 * it later with its own message, which is better than a rule that quietly
 * stopped existing.
 *
 * `baselineFile` is the one entry that names a WRITE target, so when the caller
 * passes the workspace (`cwd`) the value must stay inside it: a project may keep
 * its baseline history somewhere else in the repository, never in another
 * repository or an absolute path of its choosing. A violating value is reported
 * and DROPPED, which keeps this budget on the default `<rootDir>/budgets.json`
 * (the same rule as every other project-overridable path in the suite: an
 * unusable value keeps the host's value and is never silent).
 * @param value - the untrusted list.
 * @param options - provenance label, problem sink and (for project files) the workspace.
 * @returns the parsed budgets, or `undefined` when the value is not an array.
 */
export function parseBudgetList(
    value: unknown,
    options: { file: string; report: (problem: string) => void; cwd?: string },
): BudgetConfig[] | undefined {
    if (!Array.isArray(value)) return undefined
    const parsed: BudgetConfig[] = []
    const seen = new Set<string>()
    for (const [index, entry] of value.entries()) {
        const result = parseBudget(entry, index)
        if (result.problem !== undefined) options.report(`${options.file}: ${result.problem}`)
        if (seen.has(result.budget.id)) {
            options.report(`${options.file}: 重复的预算 id "${result.budget.id}" 已忽略（同一 id 会共用一份基线历史）`)
            continue
        }
        seen.add(result.budget.id)
        if (options.cwd !== undefined && result.budget.baselineFile !== undefined) {
            const contained = containedPath(options.cwd, result.budget.baselineFile, `预算 "${result.budget.id}" 的 baselineFile`)
            if (!contained.ok) {
                options.report(`${options.file}: ${contained.problem}（这条预算改用默认的 <rootDir>/budgets.json）`)
                delete result.budget.baselineFile
            }
        }
        parsed.push(result.budget)
    }
    return parsed
}

/**
 * Parse one configured list of contracts (profile row or project file).
 * @param value - the untrusted list.
 * @param options - provenance label and problem sink.
 * @returns the parsed contracts, or `undefined` when the value is not an array.
 */
export function parseContractList(value: unknown, options: { file: string; report: (problem: string) => void }): ContractConfig[] | undefined {
    if (!Array.isArray(value)) return undefined
    const parsed: ContractConfig[] = []
    const seen = new Set<string>()
    for (const [index, entry] of value.entries()) {
        const result = parseContract(entry, index)
        for (const problem of result.problems) options.report(`${options.file}: ${problem}`)
        if (seen.has(result.contract.id)) {
            options.report(`${options.file}: 重复的契约 id "${result.contract.id}" 已忽略`)
            continue
        }
        seen.add(result.contract.id)
        parsed.push(result.contract)
    }
    return parsed
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @param warn - sink for recoverable configuration problems.
 */
export function resolveConfig(input: unknown, warn: (message: string) => void = () => undefined): QualityGateConfig {
    const raw = isRecord(input) ? input : {}
    const trigger = isRecord(raw['trigger']) ? raw['trigger'] : {}
    const turnStop = isRecord(trigger['turnStop']) ? trigger['turnStop'] : {}
    const afterWrite = isRecord(trigger['afterWrite']) ? trigger['afterWrite'] : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const defaultTimeoutMs = num(raw['defaultTimeoutMs'], 300_000)
    const commands: GateCommandConfig[] = []
    if (Array.isArray(raw['commands'])) {
        for (const [index, entry] of raw['commands'].entries()) {
            const parsed = parseCommand(entry, index, defaultTimeoutMs)
            if ('error' in parsed) {
                warn(parsed.error)
                continue
            }
            commands.push(parsed)
        }
    }
    const seen = new Set<string>()
    const unique = commands.filter((command) => {
        if (seen.has(command.id)) {
            warn(`duplicate command id "${command.id}" ignored`)
            return false
        }
        seen.add(command.id)
        return true
    })
    // Budgets and contracts are lists too, and a wrong type is reported rather
    // than silently treated as "none configured" (which would read as green).
    const budgets = parseBudgetList(raw['budgets'], { file: 'profile 配置', report: warn }) ?? []
    if (raw['budgets'] !== undefined && !Array.isArray(raw['budgets'])) warn('profile 配置: budgets 必须是数组，已忽略（预算门禁将没有可测的预算）')
    const contracts = parseContractList(raw['contracts'], { file: 'profile 配置', report: warn }) ?? []
    if (raw['contracts'] !== undefined && !Array.isArray(raw['contracts'])) warn('profile 配置: contracts 必须是数组，已忽略（契约门禁将没有可判定的契约）')
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/quality-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        layout: {
            ...(typeof raw['rootDir'] === 'string' ? { rootDir: raw['rootDir'] } : {}),
            ...(typeof raw['missionsDir'] === 'string' ? { missionsDir: raw['missionsDir'] } : {}),
            ...(typeof raw['specsDir'] === 'string' ? { specsDir: raw['specsDir'] } : {}),
        },
        commands: unique,
        budgets,
        requireSpecBudgets: bool(raw['requireSpecBudgets'], false),
        contracts,
        writeTools: strList(raw['writeTools'], DEFAULT_WRITE_TOOLS),
        turnStop: {
            enabled: bool(turnStop['enabled'], true),
            maxBlocksPerTurn: num(turnStop['maxBlocksPerTurn'], 2),
        },
        afterWrite: {
            enabled: bool(afterWrite['enabled'], true),
            blockOnFailure: bool(afterWrite['blockOnFailure'], true),
            maxPerTurn: num(afterWrite['maxPerTurn'], 2),
        },
        defaultTimeoutMs,
        maxOutputBytes: num(raw['maxOutputBytes'], 64_000),
        baselineLockRetryMs: clampLockMs(raw['baselineLockRetryMs'], DEFAULT_BASELINE_LOCK_RETRY_MS, MAX_BASELINE_LOCK_RETRY_MS, 'baselineLockRetryMs', warn),
        baselineLockStaleMs: clampLockMs(raw['baselineLockStaleMs'], DEFAULT_BASELINE_LOCK_STALE_MS, undefined, 'baselineLockStaleMs', warn),
        limits: {
            maxChangedFiles: (() => {
                const limits = isRecord(raw['limits']) ? raw['limits'] : {}
                return Math.max(0, Math.floor(num(limits['maxChangedFiles'], 0)))
            })(),
        },
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 640),
        },
    }
}

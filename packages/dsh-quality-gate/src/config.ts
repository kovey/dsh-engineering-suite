/**
 * Plugin configuration. The command list is the gate's deterministic core
 * (docs.md §3.4/§9): it comes from the host's loader row, never from the model.
 * @module dsh-quality-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

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

/** The default write-class tools (docs.md §3.4's lint loop triggers on these). */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['write', 'edit']

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
 * gate off, relocate the log, or change where artifacts live — those are host
 * decisions, and a model-writable escape hatch is exactly what this suite
 * exists to prevent.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'commands',
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

    let commands = host.commands
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

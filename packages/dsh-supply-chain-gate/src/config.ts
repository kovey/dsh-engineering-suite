/**
 * Plugin configuration.
 *
 * Two things are deliberately NOT configurable here:
 *
 *  - the secret RULES. They are code (`src/secrets.ts`), reviewable in the
 *    repository, so "the detector that ran" is a fact of the build and not a YAML
 *    line someone edited in a profile. Configuration only tunes the bounds
 *    (entropy threshold, file size, scan scope) and the allowlist location.
 *  - the audit COMMANDS' *results*: only the host knows which auditor a
 *    repository's ecosystem has installed (`govulncheck`, `npm audit`,
 *    `pip-audit`, …), so the commands themselves ARE configured — and an empty
 *    list is reported as "nothing was audited" (WARN), never as PASS.
 *
 * The host profile is the CEILING: a repository may refine the keys in
 * {@link PROJECT_OVERRIDABLE} through `<repo>/.dsh/supply-chain-gate.json`
 * (which lives inside `dsh-spec-gate`'s trust root, so the model cannot write
 * itself an exemption), but it may not switch the whole gate off, relocate the
 * artifacts, or disable the new-dependency approval requirement.
 *
 * @module dsh-supply-chain-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Secret-scanning settings. */
export interface SecretScanConfig {
    /** Host-level switch for the secret scanner. Never project-overridable. */
    enabled: boolean
    /** Shannon entropy (bits/char) above which a long literal is suspicious. */
    entropyThreshold: number
    /** Files larger than this are skipped (and reported as skipped). */
    maxFileBytes: number
    /** Repository-owned allowlist, relative to the workspace root. */
    allowlistFile: string
    /**
     * Which finding severities BLOCK; every other severity is reported and makes
     * the gate WARN at most. The default (`critical`, `high`) reflects
     * real-repository measurement: only known credential SHAPES block, because
     * 461 unqualified entropy hits in 120 files is a gate nobody keeps switched
     * on — and a switched-off gate protects nothing.
     */
    blockSeverities: readonly string[]
    /**
     * Default scope: `false` (default) scans only the lines this change ADDED
     * ("did this change introduce a secret"), `true` sweeps the bounded tree.
     * A `secret_scan({ wholeTree: true })` call overrides it per call.
     */
    scanWholeTree: boolean
}

/** Which parsed severities block and which only warn. */
export interface AuditSeverities {
    /** A finding whose severity is in here turns the gate into BLOCK. */
    block: string[]
    /** …in here: WARN. A severity in NEITHER list is reported and warns. */
    warn: string[]
}

/** Dependency settings. */
export interface DepsGateConfig {
    /** Host-level switch for the dependency gate. Never project-overridable. */
    enabled: boolean
    /**
     * New DECLARED dependencies need one human approval (all of them listed in
     * one prompt). Never project-overridable (see the module docblock).
     */
    requireApprovalForNewDeps: boolean
    /**
     * Watch list: declared manifests are diffed for new dependencies, lockfiles
     * are checked for orphan changes (a lockfile that changed while its
     * declaring manifest did not).
     */
    manifests: string[]
    /** Host-configured auditors, tokenised without a shell. Empty = nothing audited. */
    auditCommands: string[]
    auditSeverities: AuditSeverities
}

/** Resolved plugin configuration. */
export interface SupplyChainGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    secretScan: SecretScanConfig
    deps: DepsGateConfig
    /** Bound on files walked by a whole-tree scan. */
    maxFiles: number
    /** Bound on one manifest read. */
    maxManifestBytes: number
    /** Cooperative deadline for one audit command. */
    auditTimeoutMs: number
    /** Per-stream capture cap for one audit command. */
    maxOutputBytes: number
    prompt: {
        enabled: boolean
        order: number
    }
}

/** The manifests a repository of any of the supported ecosystems would have. */
export const DEFAULT_MANIFESTS: readonly string[] = [
    'go.mod',
    'go.sum',
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'requirements.txt',
    'pyproject.toml',
    'Cargo.toml',
    'Cargo.lock',
    'pom.xml',
    'build.gradle',
]

/** Severities that block by default (the spec's ceiling). */
export const DEFAULT_BLOCK_SEVERITIES: readonly string[] = ['high', 'critical']

/** Severities that warn by default. */
export const DEFAULT_WARN_SEVERITIES: readonly string[] = ['moderate', 'medium', 'low']

/** Severity names a `secretScan.blockSeverities` entry may use. */
const SECRET_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const

/**
 * Read the blocking severities.
 *
 * An unusable value keeps the default rather than silently widening the gate,
 * and an EMPTY list is refused: "block nothing" is a decision a host states with
 * `enabled: false`, not something a typo should produce.
 */
function readSeverities(value: unknown): readonly string[] {
    const fallback = ['critical', 'high']
    if (!Array.isArray(value)) return fallback
    const known = value.filter(
        (entry): entry is string => typeof entry === 'string' && (SECRET_SEVERITIES as readonly string[]).includes(entry),
    )
    return known.length === 0 ? fallback : [...new Set(known)]
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

/** Lower-case, de-duplicated, sorted severity tokens. */
function severityList(value: unknown, fallback: readonly string[]): string[] {
    const list = strList(value, fallback).map((entry) => entry.toLowerCase())
    return [...new Set(list)].sort((left, right) => left.localeCompare(right))
}

/**
 * Resolve the plugin configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): SupplyChainGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const secretScan = isRecord(raw['secretScan']) ? raw['secretScan'] : {}
    const deps = isRecord(raw['deps']) ? raw['deps'] : {}
    const severities = isRecord(deps['auditSeverities']) ? deps['auditSeverities'] : {}
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/supply-chain-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        secretScan: {
            enabled: bool(secretScan['enabled'], true),
            // Clamped: a threshold of 0 flags every long string, one of 8 flags
            // nothing at all. Both are "configured" but neither is a net.
            entropyThreshold: Math.min(8, Math.max(1, num(secretScan['entropyThreshold'], 4.0))),
            maxFileBytes: Math.max(1_024, Math.floor(num(secretScan['maxFileBytes'], 1024 * 1024))),
            allowlistFile: str(secretScan['allowlistFile'], '.dsh/secret-allow.json'),
            blockSeverities: readSeverities(secretScan['blockSeverities']),
            scanWholeTree: bool(secretScan['scanWholeTree'], false),
        },
        deps: {
            enabled: bool(deps['enabled'], true),
            requireApprovalForNewDeps: bool(deps['requireApprovalForNewDeps'], true),
            manifests: strList(deps['manifests'], DEFAULT_MANIFESTS),
            auditCommands: strList(deps['auditCommands'], []),
            auditSeverities: {
                block: severityList(severities['block'], DEFAULT_BLOCK_SEVERITIES),
                warn: severityList(severities['warn'], DEFAULT_WARN_SEVERITIES),
            },
        },
        maxFiles: Math.max(1, Math.floor(num(raw['maxFiles'], 4_000))),
        maxManifestBytes: Math.max(1_024, Math.floor(num(raw['maxManifestBytes'], 512 * 1_024))),
        auditTimeoutMs: Math.max(5_000, Math.floor(num(raw['auditTimeoutMs'], 5 * 60_000))),
        maxOutputBytes: Math.max(4_096, Math.floor(num(raw['maxOutputBytes'], 256 * 1_024))),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            // 640 quality · 645 supply-chain · 650 evidence · 660 orchestrator.
            order: num(prompt['order'], 645),
        },
    }
}

/**
 * Keys a target repository may override in `<repo>/.dsh/supply-chain-gate.json`.
 *
 * Deliberately absent from this list (and therefore refused with a logged
 * problem when a project file names them):
 *
 *  - `enabled`, `secretScan.enabled`, `deps.enabled`: turning a gate off is a
 *    host decision;
 *  - `logFile`, `logFileTemplate`, `layout`: where the trail lives is host
 *    infrastructure;
 *  - `deps.requireApprovalForNewDeps`: a repository cannot excuse itself from
 *    the human review of a new dependency (the same rule
 *    `dsh-standards-gate` applies to `requireApprovalForBaseline`);
 *  - `prompt`.
 */
export const PROJECT_OVERRIDABLE: readonly string[] = [
    'secretScan',
    'deps',
    'maxFiles',
    'maxManifestBytes',
    'auditTimeoutMs',
    'maxOutputBytes',
]

/** Fields of `secretScan` a project file may set. */
const SECRET_SCAN_OVERRIDABLE: readonly string[] = [
    'entropyThreshold',
    'maxFileBytes',
    'allowlistFile',
    'scanWholeTree',
]

/** Fields of `deps` a project file may set. */
const DEPS_OVERRIDABLE: readonly string[] = ['manifests', 'auditCommands', 'auditSeverities']

/** The resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: SupplyChainGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file?: string
    /** Recoverable problems (unknown keys, malformed values). */
    problems: string[]
}

/** Deep-ish copy so an overlay can never mutate the host configuration. */
function copyConfig(host: SupplyChainGateConfig): SupplyChainGateConfig {
    return {
        ...host,
        layout: { ...host.layout },
        secretScan: { ...host.secretScan },
        deps: {
            ...host.deps,
            manifests: [...host.deps.manifests],
            auditCommands: [...host.deps.auditCommands],
            auditSeverities: { block: [...host.deps.auditSeverities.block], warn: [...host.deps.auditSeverities.warn] },
        },
        prompt: { ...host.prompt },
    }
}

/**
 * Overlay a workspace's own `<repo>/.dsh/supply-chain-gate.json` on the profile row.
 *
 * The overlay is applied FIELD BY FIELD onto a copy of the host configuration
 * (never by re-resolving from the profile row): re-resolving silently resets
 * every field the overlay code forgets to copy, which is a bug this suite has
 * already paid for once. An unusable value keeps the profile's value and is
 * reported as a problem.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - optional diagnostics sink.
 * @returns the effective configuration and its provenance.
 */
export function resolveEffectiveConfig(
    host: SupplyChainGateConfig,
    layout: Layout,
    logger?: Pick<Logger, 'warn' | 'info'>,
): EffectiveConfig {
    const file = loadProjectConfig<Raw>(layout, 'supply-chain-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }
    const raw = file.value
    const next = copyConfig(host)
    let applied = 0
    const problem = (message: string): void => {
        const line = `${file.file}: ${message}`
        problems.push(line)
        logger?.warn(line)
    }

    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE.includes(key)) {
            problem(`键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`)
        }
    }

    if (raw['secretScan'] !== undefined) {
        if (!isRecord(raw['secretScan'])) {
            problem('secretScan 必须是对象，已忽略')
        } else {
            const section = raw['secretScan']
            for (const key of Object.keys(section)) {
                if (key === 'enabled') {
                    problem('secretScan.enabled 不允许由项目级配置关闭（关掉整个门禁是宿主决定），已忽略')
                } else if (!SECRET_SCAN_OVERRIDABLE.includes(key)) {
                    problem(`secretScan.${key} 不是可覆盖的键，已忽略`)
                }
            }
            if (section['entropyThreshold'] !== undefined) {
                const value = section['entropyThreshold']
                if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 8) {
                    next.secretScan.entropyThreshold = value
                    applied += 1
                } else {
                    problem('secretScan.entropyThreshold 必须是 1..8 的数字，已忽略（继续使用 profile 的值）')
                }
            }
            if (section['maxFileBytes'] !== undefined) {
                const value = section['maxFileBytes']
                if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                    next.secretScan.maxFileBytes = Math.floor(value)
                    applied += 1
                } else {
                    problem('secretScan.maxFileBytes 必须是正数，已忽略（继续使用 profile 的值）')
                }
            }
            if (section['allowlistFile'] !== undefined) {
                const value = section['allowlistFile']
                if (typeof value === 'string' && value.trim() !== '') {
                    next.secretScan.allowlistFile = value.trim()
                    applied += 1
                } else {
                    problem('secretScan.allowlistFile 必须是非空字符串，已忽略（继续使用 profile 的值）')
                }
            }
            if (section['scanWholeTree'] !== undefined) {
                const value = section['scanWholeTree']
                if (typeof value === 'boolean') {
                    next.secretScan.scanWholeTree = value
                    applied += 1
                } else {
                    problem('secretScan.scanWholeTree 必须是布尔值，已忽略（继续使用 profile 的值）')
                }
            }
        }
    }

    if (raw['deps'] !== undefined) {
        if (!isRecord(raw['deps'])) {
            problem('deps 必须是对象，已忽略')
        } else {
            const section = raw['deps']
            for (const key of Object.keys(section)) {
                if (key === 'enabled' || key === 'requireApprovalForNewDeps') {
                    problem(`deps.${key} 不允许由项目级配置覆盖（关掉门禁/豁免人工批准是宿主决定），已忽略`)
                } else if (!DEPS_OVERRIDABLE.includes(key)) {
                    problem(`deps.${key} 不是可覆盖的键，已忽略`)
                }
            }
            if (section['manifests'] !== undefined) {
                const value = section['manifests']
                if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
                    next.deps.manifests = (value as string[]).map((entry) => entry.trim())
                    applied += 1
                } else {
                    problem('deps.manifests 必须是"非空字符串"数组，已忽略（继续使用 profile 的值）')
                }
            }
            if (section['auditCommands'] !== undefined) {
                const value = section['auditCommands']
                if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
                    next.deps.auditCommands = (value as string[]).map((entry) => entry.trim())
                    applied += 1
                } else {
                    problem('deps.auditCommands 必须是"非空字符串"数组，已忽略（继续使用 profile 的值）')
                }
            }
            if (section['auditSeverities'] !== undefined) {
                const value = section['auditSeverities']
                if (!isRecord(value)) {
                    problem('deps.auditSeverities 必须是对象，已忽略（继续使用 profile 的值）')
                } else {
                    let touched = false
                    if (value['block'] !== undefined) {
                        if (Array.isArray(value['block'])) {
                            next.deps.auditSeverities.block = severityList(value['block'], next.deps.auditSeverities.block)
                            touched = true
                        } else {
                            problem('deps.auditSeverities.block 必须是数组，已忽略（继续使用 profile 的值）')
                        }
                    }
                    if (value['warn'] !== undefined) {
                        if (Array.isArray(value['warn'])) {
                            next.deps.auditSeverities.warn = severityList(value['warn'], next.deps.auditSeverities.warn)
                            touched = true
                        } else {
                            problem('deps.auditSeverities.warn 必须是数组，已忽略（继续使用 profile 的值）')
                        }
                    }
                    if (touched) applied += 1
                }
            }
        }
    }

    const takePositiveInt = (key: 'maxFiles' | 'maxManifestBytes' | 'auditTimeoutMs' | 'maxOutputBytes'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            next[key] = Math.floor(value)
            applied += 1
            return
        }
        problem(`${key} 必须是正数，已忽略（继续使用 profile 的值）`)
    }
    takePositiveInt('maxFiles')
    takePositiveInt('maxManifestBytes')
    takePositiveInt('auditTimeoutMs')
    takePositiveInt('maxOutputBytes')

    // Provenance must not lie: a file whose every key was refused (or whose
    // values were all unusable) leaves the profile configuration in force.
    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

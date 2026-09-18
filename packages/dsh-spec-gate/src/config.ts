/**
 * Plugin configuration (docs.md §9: the deterministic half of a gate always
 * comes from the host, never from the model).
 * @module dsh-spec-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** Whether an unapproved specification blocks writes. */
export type EnforceMode = boolean

/** How the approval of a specification is obtained. */
export type ApprovalMode = 'seam' | 'auto'

/** Resolved plugin configuration. */
export interface SpecGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only), e.g. `~/.dsh/logs/{project}/spec-gate.log`. */
    logFileTemplate?: string
    /**
     * Which channel asks the human to review a specification.
     *
     * `auto` (default) prefers the host TUI's review card — it can open the
     * requirement document and the test cases and take a rejection note in its
     * input box — and falls back to the generic approval seam (headless, web,
     * CI). `tui` refuses instead of falling back; `approval` always uses the seam.
     */
    reviewChannel: 'auto' | 'tui' | 'approval'
    /** How long a review card waits for a verdict before giving up (fail closed). */
    reviewTimeoutMs: number
    layout: LayoutOptions
    /** Deny write-class tools while the session's mission has no approved spec. */
    enforce: EnforceMode
    /** Deny writes whose target falls outside `spec.fileBoundaries`. */
    enforceBoundaries: boolean
    /** Extra allowed patterns, evaluated before the specification boundaries. */
    boundaryExemptPaths: readonly string[]
    /** Tool names treated as writes. */
    writeTools: readonly string[]
    /** Shell tools whose command string is analysed for write targets. */
    shellTools: readonly string[]
    /**
     * How to judge a shell command whose write targets could not be attributed:
     * `targets` checks what it can and allows the rest (documented blind spot),
     * `strict` denies, `off` skips shell analysis entirely.
     */
    shellPolicy: 'targets' | 'strict' | 'off'
    /** Tool names never inspected (escape hatch for host tooling). */
    exemptTools: readonly string[]
    /**
     * `auto` requires a passing test design only when `dsh-test-design-gate` is
     * mounted (probed through its `test_design_review` tool).
     */
    requireTestDesign: boolean | 'auto'
    /** `seam` asks the human through `ctx.approval`; `auto` approves on record. */
    approval: ApprovalMode
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
 * Keys a project file may override (`.dsh/spec-gate.json` inside the workspace).
 *
 * The profile stays the ceiling for *where* things live and whether the plugin
 * runs at all; a project may decide how strictly ITS repository is gated —
 * a scratch repo can set `enforce: false`, a controlled one can narrow the
 * write tools. The file lives in the trust root, so the model cannot rewrite it
 * with the write tools (only the derived `specs/*.md` is writable there).
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'enforce',
    'enforceBoundaries',
    'writeTools',
    'shellTools',
    'shellPolicy',
    'boundaryExemptPaths',
    'requireTestDesign',
    'approval',
    'reviewChannel',
    'reviewTimeoutMs',
]

/** The resolved configuration plus where it came from. */
export interface EffectiveSpecGateConfig {
    config: SpecGateConfig
    source: 'profile' | 'project'
    file?: string
    problems: string[]
}

/**
 * Resolve the configuration that applies to one workspace.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the session workspace layout.
 * @param logger - diagnostics sink.
 */
export function resolveEffectiveConfig(host: SpecGateConfig, layout: Layout, logger?: Logger): EffectiveSpecGateConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'spec-gate')
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
    // Same provenance rule as `dsh-quality-gate`/`dsh-evidence-gate`: report
    // 'project' only when the file really changed something.
    const appliedKeys = Object.keys(raw).filter((key) => PROJECT_OVERRIDABLE_KEYS.includes(key))
    if (appliedKeys.length === 0) return { config: host, source: 'profile', file: file.file, problems }

    const requireTestDesignRaw = raw['requireTestDesign']
    const config: SpecGateConfig = {
        ...host,
        enforce: bool(raw['enforce'], host.enforce),
        enforceBoundaries: bool(raw['enforceBoundaries'], host.enforceBoundaries),
        writeTools: strList(raw['writeTools'], host.writeTools),
        shellTools: strList(raw['shellTools'], host.shellTools),
        shellPolicy: raw['shellPolicy'] === 'strict' ? 'strict' : raw['shellPolicy'] === 'off' ? 'off' : raw['shellPolicy'] === 'targets' ? 'targets' : host.shellPolicy,
        boundaryExemptPaths: strList(raw['boundaryExemptPaths'], host.boundaryExemptPaths ?? []),
        requireTestDesign:
            typeof requireTestDesignRaw === 'boolean' ? requireTestDesignRaw : requireTestDesignRaw === 'auto' ? 'auto' : host.requireTestDesign,
        approval: raw['approval'] === 'seam' || raw['approval'] === 'auto' ? raw['approval'] : host.approval,
        reviewChannel:
            raw['reviewChannel'] === 'tui' || raw['reviewChannel'] === 'approval' || raw['reviewChannel'] === 'auto'
                ? raw['reviewChannel']
                : host.reviewChannel,
        reviewTimeoutMs: Math.max(1_000, Math.floor(num(raw['reviewTimeoutMs'], host.reviewTimeoutMs))),
    }
    logger?.info(
        `spec-gate: 使用项目级配置 ${file.file}（enforce=${config.enforce}; boundaries=${config.enforceBoundaries}; shellPolicy=${config.shellPolicy}; approval=${config.approval}）`,
    )
    return { config, source: 'project', file: file.file, problems }
}

/** The write-class tools the harness ships. */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['write', 'edit']

/** Shell tools inspected for write targets (see `shell.ts`). */
export const DEFAULT_SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): SpecGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/spec-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        reviewChannel: raw['reviewChannel'] === 'tui' ? 'tui' : raw['reviewChannel'] === 'approval' ? 'approval' : 'auto',
        reviewTimeoutMs: Math.max(1_000, Math.floor(num(raw['reviewTimeoutMs'], 15 * 60_000))),
        layout: {
            ...(typeof raw['rootDir'] === 'string' ? { rootDir: raw['rootDir'] } : {}),
            ...(typeof raw['specsDir'] === 'string' ? { specsDir: raw['specsDir'] } : {}),
            ...(typeof raw['missionsDir'] === 'string' ? { missionsDir: raw['missionsDir'] } : {}),
        },
        enforce: bool(raw['enforce'], true),
        enforceBoundaries: bool(raw['enforceBoundaries'], true),
        boundaryExemptPaths: strList(raw['boundaryExemptPaths'], []),
        writeTools: strList(raw['writeTools'], DEFAULT_WRITE_TOOLS),
        shellTools: strList(raw['shellTools'], DEFAULT_SHELL_TOOLS),
        shellPolicy: raw['shellPolicy'] === 'strict' ? 'strict' : raw['shellPolicy'] === 'off' ? 'off' : 'targets',
        exemptTools: strList(raw['exemptTools'], []),
        requireTestDesign:
            typeof raw['requireTestDesign'] === 'boolean' ? raw['requireTestDesign'] : 'auto',
        approval: raw['approval'] === 'auto' ? 'auto' : 'seam',
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 620),
        },
    }
}

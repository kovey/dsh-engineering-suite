/**
 * Plugin configuration (docs.md §9: the deterministic half of a gate always
 * comes from the host, never from the model).
 *
 * The value parsers, the two enum normalisers and the `bootstrap` section live
 * in `config-values.ts` / `config-bootstrap.ts`: this module only assembles the
 * resolved object, so a reader can see every default on one screen.
 * @module dsh-spec-gate/config
 */

import { containedPath, loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'
import {
    approvalModeOf,
    bool,
    isRecord,
    mergeShellAllowlist,
    num,
    projectShellPolicyOf,
    reviewChannelOf,
    shellAllowOf,
    shellPolicyOf,
    str,
    strList,
    type ApprovalMode,
    type ReviewChannel,
    type ShellPolicy,
} from './config-values.js'
import { mergeBootstrap, resolveBootstrap, type BootstrapConfig } from './config-bootstrap.js'
import { DEFAULT_SHELL_ALLOWLIST } from './shell-allowlist.js'

/** Whether an unapproved specification blocks writes. */
export type EnforceMode = boolean

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
    reviewChannel: ReviewChannel
    /** How long a review card waits for a verdict before giving up (fail closed). */
    reviewTimeoutMs: number
    /** Drafting specifications for repositories that already exist (`spec_bootstrap`). */
    bootstrap: BootstrapConfig
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
     * How to judge a shell command: `targets` checks what it can and allows the
     * rest (documented blind spot), `strict` denies what cannot be attributed,
     * `allowlist` is the positive list, `off` skips shell analysis. Default
     * `targets`; only the host picks the mode.
     */
    shellPolicy: ShellPolicy
    /**
     * Reviewed shell artifacts that may run even though their write targets are
     * unattributable (`bash scripts/**`). Host-only on purpose: a repository that
     * could widen this list would be excusing itself from the boundary check.
     * Consulted only under `shellPolicy: 'strict'`.
     */
    shellAllow: readonly string[]

    /**
     * The positive list of `shellPolicy: 'allowlist'`: a program name (`ls`), a
     * subcommand prefix (`git status`) or a path prefix/glob (`bash scripts/*.sh`).
     * Host default plus project additions (append only); adding an entry widens
     * what can run, so the docs state that risk next to the key.
     */
    shellAllowlist: readonly string[]
    /** Tool names never inspected (escape hatch for host tooling). */
    exemptTools: readonly string[]
    /** `auto` requires a passing test design only when `dsh-test-design-gate` is
     * mounted (probed through its `test_design_review` tool).
     */
    requireTestDesign: boolean | 'auto'
    /**
     * The cross-mission plan ledger (append-only JSONL).
     *
     * `spec_create` / `spec_approve` / `spec_amend` append one row per transition;
     * `plan_status` reads it. Default `.dsh/plan.jsonl` — the resolved path
     * follows `rootDir` (see `planLedgerFile`), and an explicit value is
     * workspace-relative.
     */
    planFile: string
    /** Architecture-decision directory (default `.dsh/adr`, following `rootDir`). */
    adrDir: string
    /** ADR index (append-only JSONL; default `<adrDir>/index.jsonl`). */
    adrIndexFile: string
    /**
     * When true, `spec_create` without a `milestone` is refused.
     *
     * Off by default: a milestone groups requirements across missions, which is
     * useful for a product repo and noise for a one-off script.
     */
    milestoneRequired: boolean
    /** Only `seam`: a specification approval must come from a person through the seam. */
    approval: ApprovalMode
    prompt: {
        enabled: boolean
        order: number
    }
}

/**
 * Keys a project file may override (`.dsh/spec-gate.json` inside the workspace).
 *
 * The profile stays the ceiling for *where the mission store lives* and whether
 * the plugin runs at all; a project may decide how strictly ITS repository is
 * gated — a scratch repo can set `enforce: false`, a controlled one can narrow
 * the write tools — and it may relocate the two artifacts that are records
 * *about that repository* (`planFile`, `adrDir`/`adrIndexFile`). The file lives
 * in the trust root, so the model cannot rewrite it
 * with the write tools (only the derived `specs/*.md` is writable there).
 */
const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'enforce',
    'enforceBoundaries',
    'writeTools',
    'shellTools',
    'shellPolicy',
    'shellAllowlist',
    'boundaryExemptPaths',
    'requireTestDesign',
    'approval',
    'reviewChannel',
    'reviewTimeoutMs',
    'bootstrap',
    'planFile',
    'adrDir',
    'adrIndexFile',
    'milestoneRequired',
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
 *
 * The three path keys are WRITE targets (the plan ledger, the ADR directory and
 * its index). A project may relocate those records INSIDE its own workspace and
 * never outside it: `adrDir: "/tmp/…"` (or `../../…`) would hide the record from
 * the people reviewing this repository and drop files into a directory the
 * workspace does not own. A violating value keeps the profile's value (never a
 * plugin default that silently widens the layout) and is reported as a problem;
 * a refused key is not "applied".
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
    const refusedKeys = new Set<string>()
    const projectPath = (key: 'planFile' | 'adrDir' | 'adrIndexFile'): string | undefined => {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined
        const value = raw[key]
        if (typeof value !== 'string' || value.trim() === '') {
            const problem = `${file.file}: ${key} 必须是非空字符串（收到 ${JSON.stringify(value)}），已忽略该项目级取值（继续使用 profile 配置）`
            problems.push(problem)
            logger?.warn(problem)
            refusedKeys.add(key)
            return undefined
        }
        const contained = containedPath(layout.cwd, value, key)
        if (!contained.ok) {
            const problem = `${file.file}: ${contained.problem}（继续使用 profile 配置的 ${key}=${host[key] === '' ? '布局根下的默认值' : host[key]}）`
            problems.push(problem)
            logger?.warn(problem)
            refusedKeys.add(key)
            return undefined
        }
        return value
    }
    const planFile = projectPath('planFile')
    const adrDir = projectPath('adrDir')
    const adrIndexFile = projectPath('adrIndexFile')
    const projectPolicy = projectShellPolicyOf(raw['shellPolicy'], host.shellPolicy, file.file)
    if (projectPolicy.problem !== undefined) {
        problems.push(projectPolicy.problem)
        logger?.warn(projectPolicy.problem)
        refusedKeys.add('shellPolicy')
    }

    // Same provenance rule as `dsh-quality-gate`/`dsh-evidence-gate`: report
    // 'project' only when the file really changed something.
    const appliedKeys = Object.keys(raw).filter((key) => PROJECT_OVERRIDABLE_KEYS.includes(key) && !refusedKeys.has(key))
    if (appliedKeys.length === 0) return { config: host, source: 'profile', file: file.file, problems }

    const requireTestDesignRaw = raw['requireTestDesign']
    const config: SpecGateConfig = {
        ...host,
        enforce: bool(raw['enforce'], host.enforce),
        enforceBoundaries: bool(raw['enforceBoundaries'], host.enforceBoundaries),
        writeTools: strList(raw['writeTools'], host.writeTools),
        shellTools: strList(raw['shellTools'], host.shellTools),
        shellPolicy: projectPolicy.policy ?? host.shellPolicy,
        shellAllow: shellAllowOf(raw['shellAllow'], host.shellAllow),
        shellAllowlist: mergeShellAllowlist(raw['shellAllowlist'], host.shellAllowlist),
        boundaryExemptPaths: strList(raw['boundaryExemptPaths'], host.boundaryExemptPaths ?? []),
        requireTestDesign:
            typeof requireTestDesignRaw === 'boolean' ? requireTestDesignRaw : requireTestDesignRaw === 'auto' ? 'auto' : host.requireTestDesign,
        approval: approvalModeOf(raw['approval'], host.approval),
        reviewChannel: reviewChannelOf(raw['reviewChannel'], host.reviewChannel),
        reviewTimeoutMs: Math.max(1_000, Math.floor(num(raw['reviewTimeoutMs'], host.reviewTimeoutMs))),
        bootstrap: mergeBootstrap(raw['bootstrap'], host.bootstrap),
        planFile: planFile ?? host.planFile,
        adrDir: adrDir ?? host.adrDir,
        adrIndexFile: adrIndexFile ?? host.adrIndexFile,
        milestoneRequired: bool(raw['milestoneRequired'], host.milestoneRequired),
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
        reviewChannel: reviewChannelOf(raw['reviewChannel'], 'auto'),
        reviewTimeoutMs: Math.max(1_000, Math.floor(num(raw['reviewTimeoutMs'], 15 * 60_000))),
        bootstrap: resolveBootstrap(raw['bootstrap']),
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
        shellPolicy: shellPolicyOf(raw['shellPolicy'], 'targets'),
        shellAllow: shellAllowOf(raw['shellAllow'], []),
        shellAllowlist: strList(raw['shellAllowlist'], DEFAULT_SHELL_ALLOWLIST),
        exemptTools: strList(raw['exemptTools'], []),
        requireTestDesign:
            typeof raw['requireTestDesign'] === 'boolean' ? raw['requireTestDesign'] : 'auto',
        // The empty string means "follow the layout root" (see planFileOf /
        // adrDirOf / adrIndexFileOf): a literal default recorded a migrated
        // repository's plan/ADRs where the readers never looked.
        planFile: str(raw['planFile'], ''),
        adrDir: str(raw['adrDir'], ''),
        adrIndexFile: str(raw['adrIndexFile'], ''),
        milestoneRequired: bool(raw['milestoneRequired'], false),
        approval: approvalModeOf(raw['approval'], 'seam'),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 620),
        },
    }
}

/**
 * Plugin configuration.
 *
 * The doctor has almost nothing to configure: it measures, it does not gate. The
 * two things it does need are deployment decisions and therefore host-owned —
 * **which plugins this suite build is expected to ship** (`expectedPlugins`) and
 * how long a live probe may take (`probeTimeoutMs`).
 *
 * Two layers, the same rule as the rest of the suite:
 *
 *  1. **The profile's loader row is the ceiling.** `<workspace>/.dsh/suite-doctor.json`
 *     may only refine the keys {@link PROJECT_OVERRIDABLE_KEYS} names, and only
 *     in the tightening direction: a repository may ADD a plugin it relies on
 *     (more visibility, never less), never remove one the host expects. Removing
 *     one would hide a missing capability — the exact failure this plugin exists
 *     to make visible.
 *  2. **A key that cannot be used keeps the profile's value and is reported.**
 *     Nothing falls back to a plugin default behind the operator's back, and a
 *     malformed project file never silently disables the check.
 *
 * @module dsh-suite-doctor/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions } from 'dsh-eng-core'

/**
 * The eleven plugins this suite ships (docs/PLUGIN-CONVENTIONS.md §7 plus the
 * gates added after it: impact, coverage, supply-chain).
 *
 * This list is the *suite build*, not a mount check: the runtime probe decides
 * what is actually mounted.
 */
export const SUITE_PLUGINS: readonly string[] = [
    'role-guard',
    'spec-gate',
    'test-design-gate',
    'quality-gate',
    'evidence-gate',
    'audit-trail',
    'orchestrator',
    'standards-gate',
    'impact-gate',
    'coverage-gate',
    'supply-chain-gate',
]

/** Default bound on the interaction probe, in milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000

/** Resolved plugin configuration. */
export interface SuiteDoctorConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Plugin ids this deployment expects to be mounted (default: the eleven). */
    expectedPlugins: string[]
    /**
     * Bound on the one probe that can block (the `interaction` service's
     * `describe()` / pending-ask accessors). A hung channel plugin must not hang
     * the doctor's answer.
     */
    probeTimeoutMs?: number
    prompt: {
        enabled: boolean
        order: number
    }
}

/**
 * Keys a target repository may override in `<repo>/.dsh/suite-doctor.json`.
 *
 * Both are refinements that can only make the report *more* complete:
 * `expectedPlugins` is unioned with the profile's list, and `probeTimeoutMs` is
 * a budget, not a verdict.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = ['expectedPlugins', 'probeTimeoutMs']

/**
 * Host-only keys, with the reason shown to the operator.
 *
 * A project that could relocate the ledger layout or switch the doctor off could
 * silence its own self-check; `prompt` decides what every session in this
 * profile is told.
 */
export const HOST_ONLY_KEYS: Readonly<Record<string, string>> = {
    enabled: '插件开关是部署决定：项目不能关掉对自己工作区的自检',
    logFile: '插件日志落点是部署决定',
    logFileTemplate: '插件日志落点是部署决定',
    layout: '台账位置是部署决定：自检必须读宿主认定的那一份台账',
    rootDir: '台账位置是部署决定：自检必须读宿主认定的那一份台账',
    missionsDir: '台账位置是部署决定：自检必须读宿主认定的那一份台账',
    specsDir: '台账位置是部署决定：自检必须读宿主认定的那一份台账',
    prompt: '系统提示词小节由 profile 决定',
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

/**
 * Validate a plugin-id list.
 * @param value - untrusted value.
 * @param fallback - the value to keep when `value` cannot be used at all.
 * @returns the ids (deduplicated, in order) and one problem per dropped entry.
 */
function pluginIds(value: unknown, fallback: readonly string[]): { ids: string[]; problems: string[] } {
    if (value === undefined) return { ids: [...fallback], problems: [] }
    if (!Array.isArray(value)) {
        return { ids: [...fallback], problems: ['expectedPlugins 必须是插件 id 组成的数组，已忽略（继续使用当前值）'] }
    }
    const ids: string[] = []
    const problems: string[] = []
    for (const entry of value) {
        if (typeof entry === 'string' && entry.trim() !== '') {
            ids.push(entry.trim())
            continue
        }
        problems.push(`expectedPlugins 里的项必须是插件 id 字符串，已忽略：${JSON.stringify(entry)}`)
    }
    if (ids.length === 0) {
        return { ids: [...fallback], problems: [...problems, 'expectedPlugins 为空：没有可探测的对象，已回退'] }
    }
    return { ids: [...new Set(ids)], problems }
}

/**
 * Resolve the plugin configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): SuiteDoctorConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const plugins = pluginIds(raw['expectedPlugins'], SUITE_PLUGINS)
    const timeout = raw['probeTimeoutMs']
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/suite-doctor.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        expectedPlugins: plugins.ids,
        ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? { probeTimeoutMs: Math.floor(timeout) } : {}),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 605),
        },
    }
}

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: SuiteDoctorConfig
    source: 'profile' | 'project'
    file: string
    problems: string[]
}

/**
 * Overlay a workspace's own `<repo>/.dsh/suite-doctor.json` on the profile row.
 *
 * Overlay key by key onto the HOST config (never re-resolve from scratch): a
 * field the overlay code forgets to copy would otherwise silently reset to a
 * plugin default. A refused or unusable value keeps the profile's value.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 * @returns the effective configuration and its provenance.
 */
export function resolveEffectiveConfig(
    host: SuiteDoctorConfig,
    layout: Layout,
    logger?: { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'suite-doctor')
    const problems = [...file.problems]
    const report = (problem: string): void => {
        problems.push(problem)
        logger?.warn(problem)
    }
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }
    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (PROJECT_OVERRIDABLE_KEYS.includes(key)) continue
        const reason = HOST_ONLY_KEYS[key]
        report(
            reason === undefined
                ? `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
                : `${file.file}: 键 "${key}" 是宿主键（${reason}），已忽略`,
        )
    }

    const next: SuiteDoctorConfig = { ...host, expectedPlugins: [...host.expectedPlugins], prompt: host.prompt }
    let applied = 0

    // expectedPlugins: UNION only. Adding a plugin the repository relies on makes
    // the report wider; removing one would hide a capability the host expects.
    if (raw['expectedPlugins'] !== undefined) {
        if (!Array.isArray(raw['expectedPlugins'])) {
            report(`${file.file}: expectedPlugins 必须是数组，已忽略（继续使用 profile 的值）`)
        } else {
            const parsed = pluginIds(raw['expectedPlugins'], [])
            for (const problem of parsed.problems) report(`${file.file}: ${problem}`)
            const added = parsed.ids.filter((id) => !next.expectedPlugins.includes(id))
            if (added.length > 0) {
                next.expectedPlugins = [...next.expectedPlugins, ...added]
                applied += 1
            }
            const dropped = host.expectedPlugins.filter((id) => !parsed.ids.includes(id))
            if (dropped.length > 0) {
                report(`${file.file}: expectedPlugins 只能做并集（收紧）：${dropped.join('、')} 仍按 profile 的期望保留（删掉它们等于隐藏一个缺失的能力）`)
            }
        }
    }

    // probeTimeoutMs: a budget, never a verdict.
    if (raw['probeTimeoutMs'] !== undefined) {
        const value = raw['probeTimeoutMs']
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            next.probeTimeoutMs = Math.floor(value)
            applied += 1
        } else {
            report(`${file.file}: probeTimeoutMs 必须是正数（毫秒），已忽略（继续使用 profile 的值）`)
        }
    }

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

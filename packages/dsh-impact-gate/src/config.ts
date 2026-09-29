/**
 * Plugin configuration: how far the analysis may walk, and which command runs
 * the selection.
 *
 * Three things are deliberately NOT configurable here:
 *
 *  1. **The risk thresholds.** They are `RISK_RULES` in `dsh-eng-core`, i.e. a
 *     code change — "改动风险口径" is not a per-host preference.
 *  2. **A default test command.** There is none. A plugin that guesses a runner
 *     (`go test {files}` in a pnpm repo, `vitest run {files}` in a Go repo)
 *     renders a plausible-looking command that tests nothing, and the failure
 *     mode looks like a green gate. The default is the empty string, meaning
 *     "the host must configure it", and `impact_tests` refuses instead of
 *     guessing.
 *  3. **Loosening.** This plugin records no gate verdict, so there is nothing a
 *     project file could ratchet; what a project MAY refine is the command that
 *     runs here and the analysis budget (see {@link PROJECT_OVERRIDABLE_KEYS}).
 *  4. **`changeSource`.** Which source supplies the change set (the host's
 *     `workspaceChanges` service or our own `git diff`) is a HOST decision: the
 *     two answer different questions, so a project able to pin one could change
 *     what the analysis means for everyone reading its output.
 *
 * @module dsh-impact-gate/config
 */

import { containedPath, loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'
import {
    compileSignatures,
    DEFAULT_QUARANTINE_MAX_DAYS,
    DEFAULT_UNSEEN_RUNS,
    type FlakySettings,
} from './flaky.js'

/** Where the change set may come from. */
export type ChangeSource = 'auto' | 'workspaceChanges' | 'git'

/** Resolved plugin configuration. */
export interface ImpactGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /**
     * Which source supplies the change set (host-only, default `auto`).
     *
     * `auto` prefers the host's `workspaceChanges` service and falls back to
     * `git diff` with a reported reason; the two explicit values pin one source,
     * and a pinned-but-unusable source is a loud refusal instead of a silent
     * fallback. It is host-only because the two sources answer DIFFERENT
     * questions (a turn snapshot vs a diff against a ref), so choosing between
     * them changes what the analysis means — that is a host decision, not a
     * repository preference.
     */
    changeSource: ChangeSource
    /** Reverse-import walk bound: how far a change is followed (default 6). */
    maxDistance: number
    /** Bound on files walked in one analysis (the same walk the standards gate uses). */
    maxFiles: number
    /** Bound on one file's size. */
    maxFileBytes: number
    /**
     * Host template for the selected tests. `''` (the default) means "not
     * configured": `impact_tests` then refuses. `{files}` is replaced with the
     * space-joined selection; a template without the placeholder gets the
     * selection appended (`go test <files>`), which is what `go test` and
     * `vitest run` both accept.
     */
    testCommandTemplate: string
    /**
     * The whole-suite command. Used ONLY to say how much a selection saves
     * ("少跑 N 个测试文件"); omitted means no comparison is available, which is
     * the honest state for a host that never configured one.
     */
    fullTestCommand?: string
    /** Diff base when the caller passes none (default `HEAD`). */
    defaultBase: string
    /**
     * Opt-in read-only reviewer over the riskiest files: the opinion layer for
     * what the import graph cannot see. Default OFF — it spends a subagent and a
     * model call, and it never changes the risk level or records a gate.
     */
    reviewDispatch: {
        enabled: boolean
        provider: string
        model?: string
        timeoutMs: number
        maxDepth: number
        targets: number
    }
    /**
     * Flakiness policy: the failure signatures that mean "the environment is
     * broken", and the rules a quarantine has to obey (an owner and a deadline).
     */
    flaky: FlakySettings
    prompt: {
        enabled: boolean
        order: number
    }
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

/** Sink for recoverable configuration problems. */
type Warn = (message: string) => void

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

/** A non-empty trimmed string, or `undefined`. */
function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An integer ≥ `min`, or the fallback plus a reported problem. */
function intAtLeast(value: unknown, fallback: number, min: number, key: string, warn: Warn): number {
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value) && value >= min) return Math.floor(value)
    warn(`config.${key} 必须是 ≥ ${min} 的数字，已忽略（继续用默认值 ${fallback}）`)
    return fallback
}

/**
 * Example templates shown when the host has not configured one.
 *
 * They are an INSTRUCTION to the host, not a guess by the plugin: the refusal
 * message names the ecosystem so the operator can paste the right one.
 */
export const TEMPLATE_EXAMPLES: readonly string[] = [
    'go test {files}',
    'node --test {files}',
    'npx vitest run {files}',
    'pytest {files}',
    'cargo test --test {files}',
]

/** Default reverse-import distance. */
export const DEFAULT_MAX_DISTANCE = 6

/**
 * Resolve the plugin configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @param warn - sink for recoverable problems (never throws on bad input: a
 *   plugin must still mount, and the defaults are the safe side here).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown, warn: Warn = () => undefined): ImpactGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    if (raw['prompt'] !== undefined && !isRecord(raw['prompt'])) warn('config.prompt 必须是对象，已忽略（继续用默认值）')
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const review = isRecord(raw['reviewDispatch']) ? raw['reviewDispatch'] : {}
    if (raw['reviewDispatch'] !== undefined && !isRecord(raw['reviewDispatch'])) {
        warn('config.reviewDispatch 必须是对象，已忽略（评审派发保持关闭）')
    }
    const model = optionalString(review['model'])
    const fullTestCommand = optionalString(raw['fullTestCommand'])
    const flaky = isRecord(raw['flaky']) ? raw['flaky'] : {}
    if (raw['flaky'] !== undefined && !isRecord(raw['flaky'])) warn('config.flaky 必须是对象，已忽略（flaky 策略继续用默认值）')
    for (const key of Object.keys(flaky)) {
        if (!FLAKY_KEYS.includes(key)) warn(`config.flaky 里不认识的键 "${key}"（支持：${FLAKY_KEYS.join(' / ')}），已忽略`)
    }
    // `flaky.signatures` is the documented place; the top-level
    // `flakySignatures` spelling is accepted as an alias so the older phrasing of
    // the same setting does not silently do nothing.
    const compiled = compileSignatures(flaky['signatures'] ?? raw['flakySignatures'])
    for (const problem of compiled.problems) warn(`config: ${problem}`)
    const flakyOwner = optionalString(flaky['owner'])
    const flakyQuarantineFile = optionalString(flaky['quarantineFile'])
    const changeSource = raw['changeSource']
    if (changeSource !== undefined && !CHANGE_SOURCES.includes(changeSource as ChangeSource)) {
        warn(`config.changeSource 必须是 ${CHANGE_SOURCES.join(' / ')} 之一，已忽略（继续用默认值 auto）`)
    }
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/impact-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        changeSource: CHANGE_SOURCES.includes(changeSource as ChangeSource) ? (changeSource as ChangeSource) : 'auto',
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        maxDistance: intAtLeast(raw['maxDistance'], DEFAULT_MAX_DISTANCE, 1, 'maxDistance', warn),
        maxFiles: intAtLeast(raw['maxFiles'], 4_000, 1, 'maxFiles', warn),
        maxFileBytes: intAtLeast(raw['maxFileBytes'], 256 * 1_024, 1_024, 'maxFileBytes', warn),
        // The empty default is the point: "not configured" must be a distinct,
        // visible state, never silently replaced by a runner this plugin guessed.
        testCommandTemplate: typeof raw['testCommandTemplate'] === 'string' ? raw['testCommandTemplate'].trim() : '',
        ...(fullTestCommand === undefined ? {} : { fullTestCommand }),
        defaultBase: str(raw['defaultBase'], 'HEAD'),
        reviewDispatch: {
            enabled: bool(review['enabled'], false),
            provider: str(review['provider'], 'spawn'),
            ...(model === undefined ? {} : { model }),
            timeoutMs: intAtLeast(review['timeoutMs'], 10 * 60_000, 1_000, 'reviewDispatch.timeoutMs', warn),
            maxDepth: intAtLeast(review['maxDepth'], 1, 1, 'reviewDispatch.maxDepth', warn),
            targets: intAtLeast(review['targets'], 5, 1, 'reviewDispatch.targets', warn),
        },
        flaky: {
            signatures: compiled.signatures,
            quarantineMaxDays: intAtLeast(flaky['quarantineMaxDays'], DEFAULT_QUARANTINE_MAX_DAYS, 1, 'flaky.quarantineMaxDays', warn),
            unseenRunsBeforeWarn: intAtLeast(flaky['unseenRunsBeforeWarn'], DEFAULT_UNSEEN_RUNS, 1, 'flaky.unseenRunsBeforeWarn', warn),
            ...(flakyQuarantineFile === undefined ? {} : { quarantineFile: flakyQuarantineFile }),
            ...(flakyOwner === undefined ? {} : { owner: flakyOwner }),
        },
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: typeof prompt['order'] === 'number' && Number.isFinite(prompt['order']) ? prompt['order'] : 670,
        },
    }
}

/** Keys `config.flaky` accepts (anything else is reported, never silently used). */
export const FLAKY_KEYS: readonly string[] = ['signatures', 'quarantineMaxDays', 'quarantineFile', 'unseenRunsBeforeWarn', 'owner']

/** Accepted values of `config.changeSource`, in the order the refusal message lists them. */
export const CHANGE_SOURCES: readonly ChangeSource[] = ['auto', 'workspaceChanges', 'git']

/**
 * Keys a target repository may override in `<repo>/.dsh/impact-gate.json`.
 *
 * The profile is the CEILING. A project may choose WHICH command runs here (a
 * Rust repo's regression command is not the host's), and it may refine the
 * analysis budget — those are facts about the repository. It may NOT switch the
 * plugin off, relocate logs/artifacts, turn `reviewDispatch` on (that spends a
 * subagent: escalation), or touch the prompt section.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'testCommandTemplate',
    'fullTestCommand',
    'defaultBase',
    'maxDistance',
    'maxFiles',
    'maxFileBytes',
    'flaky',
]

/** The resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: ImpactGateConfig
    source: 'profile' | 'project'
    /** The project file consulted (whether or not it existed). */
    file: string
    /** Whether that file exists and parsed — provenance must be exact, not guessed. */
    present: boolean
    /** Recoverable problems: unknown keys, unusable values. Never silent. */
    problems: string[]
}

/**
 * Overlay a workspace's own `<repo>/.dsh/impact-gate.json` on the profile row.
 *
 * Same rule as every other plugin in this suite: the profile is the ceiling, a
 * workspace may only refine the keys it is allowed to, and an unusable value
 * keeps the profile's value instead of falling back to a plugin default (which
 * would silently widen the budget the host chose).
 * @param host - the profile-resolved configuration.
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 * @returns the effective configuration and its provenance.
 */
export function resolveEffectiveConfig(
    host: ImpactGateConfig,
    layout: Layout,
    logger?: Pick<Logger, 'warn'>,
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'impact-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, present: file.present, problems }
    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE_KEYS.includes(key)) {
            const problem = `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
            problems.push(problem)
            logger?.warn(problem)
        }
    }

    // Overlay key by key onto the HOST config (never re-resolve from the raw
    // row): re-resolving silently resets every field the overlay forgot to copy.
    const next: ImpactGateConfig = { ...host, reviewDispatch: host.reviewDispatch, prompt: host.prompt }
    let applied = 0
    const note = (problem: string): void => {
        problems.push(problem)
        logger?.warn(problem)
    }
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key)

    if (has('testCommandTemplate')) {
        const value = raw['testCommandTemplate']
        // An EMPTY string is a legal value: it means "no runner here", which
        // makes `impact_tests` refuse. Tightening must stay expressible.
        if (typeof value === 'string') {
            next.testCommandTemplate = value.trim()
            applied += 1
        } else {
            note(`${file.file}: testCommandTemplate 必须是字符串，已忽略（继续使用 profile 的值）`)
        }
    }
    if (has('fullTestCommand')) {
        const value = raw['fullTestCommand']
        if (typeof value === 'string') {
            const trimmed = value.trim()
            if (trimmed === '') delete next.fullTestCommand
            else next.fullTestCommand = trimmed
            applied += 1
        } else {
            note(`${file.file}: fullTestCommand 必须是字符串（空串表示不配置），已忽略（继续使用 profile 的值）`)
        }
    }
    if (has('defaultBase')) {
        const value = optionalString(raw['defaultBase'])
        if (value === undefined) note(`${file.file}: defaultBase 必须是非空字符串，已忽略（继续使用 profile 的值）`)
        else {
            next.defaultBase = value
            applied += 1
        }
    }
    const takeInt = (key: 'maxDistance' | 'maxFiles' | 'maxFileBytes', min: number): void => {
        if (!has(key)) return
        const value = raw[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= min) {
            next[key] = Math.floor(value)
            applied += 1
            return
        }
        note(`${file.file}: ${key} 必须是 ≥ ${min} 的数字，已忽略（继续使用 profile 的值）`)
    }
    takeInt('maxDistance', 1)
    takeInt('maxFiles', 1)
    takeInt('maxFileBytes', 1_024)

    if (has('flaky')) {
        const rawFlaky = raw['flaky']
        if (!isRecord(rawFlaky)) {
            note(`${file.file}: flaky 必须是对象，已忽略（继续使用 profile 的 flaky 策略）`)
        } else {
            const nextFlaky: FlakySettings = { ...next.flaky }
            for (const key of Object.keys(rawFlaky)) {
                if (!FLAKY_KEYS.includes(key)) note(`${file.file}: flaky 里不认识的键 "${key}"（支持：${FLAKY_KEYS.join(' / ')}），已忽略`)
            }
            if (Object.prototype.hasOwnProperty.call(rawFlaky, 'signatures')) {
                const compiled = compileSignatures(rawFlaky['signatures'])
                for (const problem of compiled.problems) note(`${file.file}: ${problem}`)
                // A repository's failure vocabulary is repository knowledge, so the
                // list REPLACES the profile's (including with `[]`).
                nextFlaky.signatures = compiled.signatures
                applied += 1
            }
            // `owner` and `quarantineFile` are facts about the repository.
            if (Object.prototype.hasOwnProperty.call(rawFlaky, 'owner')) {
                const owner = optionalString(rawFlaky['owner'])
                if (owner === undefined) note(`${file.file}: flaky.owner 必须是非空字符串，已忽略（继续使用 profile 的值）`)
                else {
                    nextFlaky.owner = owner
                    applied += 1
                }
            }
            if (Object.prototype.hasOwnProperty.call(rawFlaky, 'quarantineFile')) {
                const quarantineFile = optionalString(rawFlaky['quarantineFile'])
                if (quarantineFile === undefined) note(`${file.file}: flaky.quarantineFile 必须是非空字符串，已忽略（继续使用 profile 的值）`)
                else {
                    // The quarantine ledger is a record about THIS repository and
                    // the printed command APPENDS to it: a project may keep it
                    // elsewhere in the workspace, never outside it (an absolute
                    // path or `../../` would write into a directory the workspace
                    // does not own). A violating value keeps the profile's value.
                    const contained = containedPath(layout.cwd, quarantineFile, 'flaky.quarantineFile')
                    if (!contained.ok) note(`${file.file}: ${contained.problem}（继续使用 profile 的值）`)
                    else {
                        nextFlaky.quarantineFile = quarantineFile
                        applied += 1
                    }
                }
            }
            // The two numbers are POLICY, and the profile is the ceiling: a
            // project may shorten a quarantine (or warn sooner) but may not
            // lengthen the deadline the host set.
            const takeTighter = (key: 'quarantineMaxDays' | 'unseenRunsBeforeWarn'): void => {
                if (!Object.prototype.hasOwnProperty.call(rawFlaky, key)) return
                const value = rawFlaky[key]
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
                    note(`${file.file}: flaky.${key} 必须是 ≥ 1 的数字，已忽略（继续使用 profile 的值 ${next.flaky[key]}）`)
                    return
                }
                const floor = Math.floor(value)
                if (floor > next.flaky[key]) {
                    note(
                        `${file.file}: flaky.${key}=${floor} 比 profile 的 ${next.flaky[key]} 更宽松，已忽略（profile 是上限：项目只能收紧）`,
                    )
                    return
                }
                nextFlaky[key] = floor
                applied += 1
            }
            takeTighter('quarantineMaxDays')
            takeTighter('unseenRunsBeforeWarn')
            next.flaky = nextFlaky
        }
    }

    if (applied === 0) return { config: host, source: 'profile', file: file.file, present: file.present, problems }
    return { config: next, source: 'project', file: file.file, present: file.present, problems }
}

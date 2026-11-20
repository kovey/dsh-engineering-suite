/**
 * The per-section parsers of `models.json` (`split` and `quality`).
 *
 * Split out of `models.ts` for two reasons that are both structural: the file is
 * on the repository's `maxFileLines` ratchet, and the two section parsers are the
 * part that keeps GROWING (every new split knob lands here). Keeping them apart
 * means a new field costs lines in this file and none in the resolver — the file
 * that owns precedence and provenance stays readable.
 *
 * Nothing here decides precedence: a bad value is REPORTED and left out, so the
 * next layer (profile, then the built-in default) supplies it. That rule is
 * `models.ts`'s, and this module never overrides it.
 *
 * @module dsh-eng-core/models-sections
 */

/** Splitting granularity and the review requirement (`models.json`'s `split` section). */
export interface SplitSettings {
    /** A human must review the plan before any worker is dispatched. */
    reviewRequired: boolean
    /** Upper bound on tasks in one plan; more than this is "split into missions". */
    maxTasks: number
    /** Upper bound on one parallel group; more than this is "split into missions". */
    maxParallel: number
    /** How many re-split rounds a rejected plan gets before the work goes plain. */
    maxReworkRounds: number
    /**
     * Deadline for ONE worker (ms), AC-003.
     *
     * Optional on purpose: absent means "follow the host's
     * `autoDispatch.timeoutMs`", and only when that is absent too does the
     * documented 600000 apply. A built-in value would pin the timeout and
     * silently stop following the host configuration.
     */
    taskTimeoutMs?: number
    /**
     * How many dispatch attempts ONE task gets before it is marked
     * `needs-resplit` (AC-002 of P3). Range 1..{@link MAX_SPLIT_ATTEMPTS}.
     *
     * Optional and WITHOUT a built-in default in {@link DEFAULT_MODELS_CONFIG},
     * for the same reason `taskTimeoutMs` has none: an absent value means the
     * documented 1 attempt (no retry), and putting 1 into the resolver's defaults
     * would report every project that ever declared `split` as "missing a field
     * it fell back on" — a noise line per mission for the unchanged behaviour.
     * The effective value is {@link splitMaxAttempts} at the point of use.
     */
    maxAttempts?: number
    /**
     * Upper bound on the acceptance criteria ONE task may map (缺省 3, 1..10).
     *
     * A hard budget, not an average: the plan is refused when any single task
     * carries more criteria than this. It is what stops "one task for the whole
     * mission" from being a legal decomposition — a task that satisfies eleven
     * criteria is a mission, and reviewing/dispatching it as one worker hides
     * that. The built-in default IS in {@link DEFAULT_MODELS_CONFIG} (unlike
     * `maxAttempts`): it changes behaviour, so a project that silently falls back
     * to 3 must be told exactly like a fallback `maxTasks` is.
     */
    maxAcceptancePerTask: number
}

/**
 * The hard ceiling of `split.maxAttempts` (AC-002: "允许 1..3").
 *
 * A CEILING, not a preference: retries are paid in wall-clock time and in
 * worktree lifetime, so an unbounded knob would turn "a bounded retry" into an
 * accidental loop. A value above it is refused by {@link parseSplitSection} and
 * clamped by {@link splitMaxAttempts}.
 */
export const MAX_SPLIT_ATTEMPTS = 3

/** The effective `split.maxAttempts` when nothing declares one (AC-002: 缺省 1). */
export const DEFAULT_SPLIT_MAX_ATTEMPTS = 1

/** The hard ceiling of `split.maxAcceptancePerTask` (1..10). */
export const MAX_ACCEPTANCE_PER_TASK = 10

/** The effective `split.maxAcceptancePerTask` when nothing declares one. */
export const DEFAULT_MAX_ACCEPTANCE_PER_TASK = 3

/** Quality thresholds of the split workflow (`models.json`'s `quality` section). */
export interface QualitySettings {
    /** Reworked tasks ÷ started tasks above this escalates later tasks to planner. */
    maxReworkRatio: number
}

/** A plain object (`models.json` sections are untrusted JSON). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a positive integer field (a rejected value is reported, never guessed). */
function positiveInt(value: unknown, where: string, minimum: number, problems: string[]): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
        problems.push(`${where} 必须是不小于 ${minimum} 的整数（收到 ${JSON.stringify(value)}），已忽略`)
        return undefined
    }
    return value
}

/** Read an integer inside `[minimum, maximum]` (a rejected value is named, never clamped silently). */
function boundedInt(value: unknown, where: string, minimum: number, maximum: number, problems: string[]): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        problems.push(`${where} 必须是 ${minimum}..${maximum} 之间的整数（收到 ${JSON.stringify(value)}），已忽略`)
        return undefined
    }
    return value
}

/**
 * The effective retry ceiling of one run (AC-002).
 *
 * The parser already refuses out-of-range values, so this clamp only matters for
 * a hand-built `ModelsConfig` (a test, an embedder): "bounded retries" is a
 * safety property, and the fail-closed direction is the CEILING, never "run it
 * as many times as the number says".
 * @param split - the resolved `split` section (absent = documented default 1).
 * @returns the attempt count in 1..{@link MAX_SPLIT_ATTEMPTS}.
 */
export function splitMaxAttempts(split: { maxAttempts?: number } | undefined): number {
    const declared = split?.maxAttempts
    if (typeof declared !== 'number' || !Number.isFinite(declared)) return DEFAULT_SPLIT_MAX_ATTEMPTS
    return Math.min(MAX_SPLIT_ATTEMPTS, Math.max(1, Math.floor(declared)))
}

/**
 * The effective per-task acceptance-criteria budget (AC-001).
 *
 * Resolved at the point of use like {@link splitMaxAttempts}, so a plan
 * validator that receives a hand-built settings object (a test, an embedder)
 * still enforces a bounded number: below 1 the budget would refuse every task
 * and above {@link MAX_ACCEPTANCE_PER_TASK} it would stop being a granularity
 * rule.
 * @param split - the resolved `split` section (absent = documented default 3).
 * @returns the budget in 1..{@link MAX_ACCEPTANCE_PER_TASK}.
 */
export function splitMaxAcceptancePerTask(split: { maxAcceptancePerTask?: number } | undefined): number {
    const declared = split?.maxAcceptancePerTask
    if (typeof declared !== 'number' || !Number.isFinite(declared)) return DEFAULT_MAX_ACCEPTANCE_PER_TASK
    return Math.min(MAX_ACCEPTANCE_PER_TASK, Math.max(1, Math.floor(declared)))
}

/**
 * Read the `split` section.
 *
 * `taskTimeoutMs` is deliberately OPTIONAL and has no built-in default here: an
 * absent value means "follow the host's `autoDispatch.timeoutMs`", a chain the
 * resolver cannot express (it does not read the host config). Filling in
 * 600000 here would silently pin the timeout and break that fallback.
 *
 * `maxAttempts` is optional for the same shape of reason (AC-002): absent means
 * the documented 1 attempt, resolved by {@link splitMaxAttempts}; a value outside
 * 1..{@link MAX_SPLIT_ATTEMPTS} is NAMED and left out so the default applies.
 *
 * `maxAcceptancePerTask` IS in the built-in defaults: falling back to 3 is a
 * behaviour change (a plan that used to pass may now be refused), so it is
 * reported like a fallback `maxTasks`; a value outside 1..10 is named and left
 * out so the built-in default supplies it.
 */
export function parseSplitSection(value: unknown, where: string, problems: string[]): Partial<SplitSettings> {
    const raw = isRecord(value) ? value : {}
    if (!isRecord(value)) problems.push(`${where} 必须是对象（收到 ${JSON.stringify(value)}），已忽略`)
    const reviewRequired = raw['reviewRequired']
    if (reviewRequired !== undefined && typeof reviewRequired !== 'boolean') {
        problems.push(`${where}.reviewRequired 必须是布尔值（收到 ${JSON.stringify(reviewRequired)}），已忽略`)
    }
    const maxTasks = positiveInt(raw['maxTasks'], `${where}.maxTasks`, 2, problems)
    const maxParallel = positiveInt(raw['maxParallel'], `${where}.maxParallel`, 1, problems)
    const maxReworkRounds = positiveInt(raw['maxReworkRounds'], `${where}.maxReworkRounds`, 0, problems)
    const taskTimeoutMs = positiveInt(raw['taskTimeoutMs'], `${where}.taskTimeoutMs`, 1, problems)
    const maxAttempts = boundedInt(raw['maxAttempts'], `${where}.maxAttempts`, 1, MAX_SPLIT_ATTEMPTS, problems)
    const maxAcceptancePerTask = boundedInt(raw['maxAcceptancePerTask'], `${where}.maxAcceptancePerTask`, 1, MAX_ACCEPTANCE_PER_TASK, problems)
    return {
        ...(typeof reviewRequired === 'boolean' ? { reviewRequired } : {}),
        ...(maxTasks === undefined ? {} : { maxTasks }),
        ...(maxParallel === undefined ? {} : { maxParallel }),
        ...(maxReworkRounds === undefined ? {} : { maxReworkRounds }),
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(maxAcceptancePerTask === undefined ? {} : { maxAcceptancePerTask }),
    }
}

/** Read the `quality` section. */
export function parseQualitySection(value: unknown, where: string, problems: string[]): Partial<QualitySettings> {
    const raw = isRecord(value) ? value : {}
    if (!isRecord(value)) problems.push(`${where} 必须是对象（收到 ${JSON.stringify(value)}），已忽略`)
    const ratio = raw['maxReworkRatio']
    if (ratio !== undefined && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
        problems.push(`${where}.maxReworkRatio 必须是 0..1 之间的数字（收到 ${JSON.stringify(ratio)}），已忽略`)
        return {}
    }
    return typeof ratio === 'number' ? { maxReworkRatio: ratio } : {}
}

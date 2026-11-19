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
}

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

/**
 * Read the `split` section.
 *
 * `taskTimeoutMs` is deliberately OPTIONAL and has no built-in default here: an
 * absent value means "follow the host's `autoDispatch.timeoutMs`", a chain the
 * resolver cannot express (it does not read the host config). Filling in
 * 600000 here would silently pin the timeout and break that fallback.
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
    return {
        ...(typeof reviewRequired === 'boolean' ? { reviewRequired } : {}),
        ...(maxTasks === undefined ? {} : { maxTasks }),
        ...(maxParallel === undefined ? {} : { maxParallel }),
        ...(maxReworkRounds === undefined ? {} : { maxReworkRounds }),
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
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

/**
 * Project-level model and granularity configuration (`<root>/models.json`).
 *
 * The split workflow needs two model classes (a planner that breaks the work
 * down, a worker that executes one task) and the numbers that decide whether
 * splitting is worth it at all. Those are properties of the REPOSITORY, not of
 * one profile: the same Neovim serves many projects, and "8 tasks maximum" is
 * only meaningful next to the code it protects.
 *
 * ```
 * <root>/models.json
 *   planner { model, reasoningEffort, provider }
 *   worker  { model, reasoningEffort, provider }
 *   split   { reviewRequired, maxTasks, maxParallel, maxReworkRounds }
 *   quality { maxReworkRatio }
 * ```
 *
 * Precedence — project file, then the profile's own defaults, then the built-in
 * ones. Every value that fell back is REPORTED, naming the class and the field:
 * a silently degraded planner model or a silently doubled `maxTasks` is a
 * decision nobody made. (`problems` is the report; it is never an exception —
 * a malformed file must not stop a gate from producing a verdict.)
 *
 * @module dsh-eng-core/models
 */

import type { Layout } from './paths.js'
import { loadProjectConfig } from './project-config.js'

/** One model class (`planner` / `worker`). */
export interface ModelClassConfig {
    /** `provider/model` shorthand, split by the caller that routes it. */
    model?: string
    provider?: string
    reasoningEffort?: string
}

/** Splitting granularity and the review requirement. */
export interface SplitSettings {
    /** A human must review the plan before any worker is dispatched. */
    reviewRequired: boolean
    /** Upper bound on tasks in one plan; more than this is "split into missions". */
    maxTasks: number
    /** Upper bound on one parallel group; more than this is "split into missions". */
    maxParallel: number
    /** How many re-split rounds a rejected plan gets before the work goes plain. */
    maxReworkRounds: number
}

/** Quality thresholds of the split workflow. */
export interface QualitySettings {
    /** Reworked tasks ÷ started tasks above this escalates later tasks to planner. */
    maxReworkRatio: number
}

/** The four sections of `models.json`. */
export interface ModelsConfig {
    planner: ModelClassConfig
    worker: ModelClassConfig
    split: SplitSettings
    quality: QualitySettings
}
/** A section name (also the key in {@link ModelsConfig}). */
export type ModelsClass = keyof ModelsConfig

/** Where one section's effective value came from. */
export type ModelsSource = 'project' | 'profile' | 'default'

/** The effective model configuration plus how it was resolved. */
export interface ModelsConfigResolution {
    /** Absolute path of the project file that was consulted. */
    file: string
    /** `true` when that file exists and parsed. */
    present: boolean
    /** The effective configuration (defaults filled in). */
    config: ModelsConfig
    /** Per-section provenance: the highest-priority layer that contributed. */
    sources: Record<ModelsClass, ModelsSource>
    /** Every fallback and every rejected value, in the order they were found. */
    problems: string[]
}

/** The built-in defaults of every section (AC-001 of the split mission). */
export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
    planner: {},
    worker: {},
    split: { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2 },
    quality: { maxReworkRatio: 0.3 },
}

/** One parsed layer of `models.json` (a partial, validated view). */
export interface ModelsLayer {
    planner?: ModelClassConfig
    worker?: ModelClassConfig
    split?: Partial<SplitSettings>
    quality?: Partial<QualitySettings>
    /** Rejected values of this layer, naming the path that was wrong. */
    problems: string[]
}

const SECTION_DEFAULTS: Record<ModelsClass, string> = {
    planner: 'planner{model,reasoningEffort}',
    worker: 'worker{model,reasoningEffort}',
    split: 'split{reviewRequired,maxTasks,maxParallel,maxReworkRounds}',
    quality: 'quality{maxReworkRatio}',
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an optional non-empty string, reporting a wrong type. */
function optionalString(value: unknown, where: string, problems: string[]): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${where} 必须是非空字符串（收到 ${JSON.stringify(value)}），已忽略`)
        return undefined
    }
    return value.trim()
}

/** Read one model class (`{ model, provider, reasoningEffort }`). */
function parseModelClass(value: unknown, where: string, problems: string[]): ModelClassConfig {
    const raw = isRecord(value) ? value : {}
    if (!isRecord(value)) problems.push(`${where} 必须是对象（收到 ${JSON.stringify(value)}），已忽略`)
    const model = optionalString(raw['model'], `${where} 的 model`, problems)
    const provider = optionalString(raw['provider'], `${where} 的 provider`, problems)
    const effort = optionalString(raw['reasoningEffort'], `${where} 的 reasoningEffort`, problems)
    return {
        ...(model === undefined ? {} : { model }),
        ...(provider === undefined ? {} : { provider }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
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

/** Read the `split` section. */
function parseSplit(value: unknown, where: string, problems: string[]): Partial<SplitSettings> {
    const raw = isRecord(value) ? value : {}
    if (!isRecord(value)) problems.push(`${where} 必须是对象（收到 ${JSON.stringify(value)}），已忽略`)
    const reviewRequired = raw['reviewRequired']
    if (reviewRequired !== undefined && typeof reviewRequired !== 'boolean') {
        problems.push(`${where}.reviewRequired 必须是布尔值（收到 ${JSON.stringify(reviewRequired)}），已忽略`)
    }
    const maxTasks = positiveInt(raw['maxTasks'], `${where}.maxTasks`, 2, problems)
    const maxParallel = positiveInt(raw['maxParallel'], `${where}.maxParallel`, 1, problems)
    const maxReworkRounds = positiveInt(raw['maxReworkRounds'], `${where}.maxReworkRounds`, 0, problems)
    return {
        ...(typeof reviewRequired === 'boolean' ? { reviewRequired } : {}),
        ...(maxTasks === undefined ? {} : { maxTasks }),
        ...(maxParallel === undefined ? {} : { maxParallel }),
        ...(maxReworkRounds === undefined ? {} : { maxReworkRounds }),
    }
}

/** Read the `quality` section. */
function parseQuality(value: unknown, where: string, problems: string[]): Partial<QualitySettings> {
    const raw = isRecord(value) ? value : {}
    if (!isRecord(value)) problems.push(`${where} 必须是对象（收到 ${JSON.stringify(value)}），已忽略`)
    const ratio = raw['maxReworkRatio']
    if (ratio !== undefined && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
        problems.push(`${where}.maxReworkRatio 必须是 0..1 之间的数字（收到 ${JSON.stringify(ratio)}），已忽略`)
        return {}
    }
    return typeof ratio === 'number' ? { maxReworkRatio: ratio } : {}
}

/**
 * Parse one configuration layer (`models.json` or the profile's defaults).
 *
 * Never throws: a wrong value is reported in `problems` and that field is left
 * out, so the next layer (or the built-in default) supplies it.
 * @param input - the untrusted value.
 * @param origin - label used in every problem (`models.json` / `profile 的 split.models`).
 */
export function parseModelsSection(input: unknown, origin: string): ModelsLayer {
    const problems: string[] = []
    if (input === undefined) return { problems }
    if (!isRecord(input)) {
        problems.push(`${origin} 必须是对象（收到 ${JSON.stringify(input)}），已忽略这一层`)
        return { problems }
    }
    const layer: ModelsLayer = { problems }
    const known: ModelsClass[] = ['planner', 'worker', 'split', 'quality']
    for (const key of Object.keys(input)) {
        if (!known.includes(key as ModelsClass)) problems.push(`${origin} 有未知的段 ${key}（可用：${known.join(' / ')}），已忽略`)
    }
    if (input['planner'] !== undefined) layer.planner = parseModelClass(input['planner'], `${origin} 的 planner 段`, problems)
    if (input['worker'] !== undefined) layer.worker = parseModelClass(input['worker'], `${origin} 的 worker 段`, problems)
    if (input['split'] !== undefined) layer.split = parseSplit(input['split'], `${origin} 的 split 段`, problems)
    if (input['quality'] !== undefined) layer.quality = parseQuality(input['quality'], `${origin} 的 quality 段`, problems)
    return layer
}

/** One layer as the merge sees it: the section the layer declared, if any. */
interface MergeLayer<C extends object> {
    section?: Partial<C>
}

/** Human description of one default value (empty object = "no model named"). */
function describeDefault(value: unknown): string {
    if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return '未指定模型'
    return JSON.stringify(value)
}

/**
 * Merge one section across the layers: project → profile → built-in.
 *
 * Reports — never silently applies — every field that came from the built-in
 * default, and one line per section that no layer declared at all.
 */
function mergeSection<C extends object>(
    name: ModelsClass,
    layers: readonly MergeLayer<C>[],
    defaults: C,
    problems: string[],
): { value: C; source: ModelsSource } {
    const declared = layers.filter((layer) => layer.section !== undefined)
    if (declared.length === 0) {
        problems.push(`models.json 与 profile 都没有 ${name} 段（${SECTION_DEFAULTS[name]}）：已回退宿主默认（${describeDefault(defaults)}）`)
        return { value: { ...defaults }, source: 'default' }
    }
    const out = { ...defaults } as unknown as Record<string, unknown>
    const missing: string[] = []
    const defaultsOf = defaults as unknown as Record<string, unknown>
    // The union matters: a model class has NO built-in fields (its defaults are
    // `{}`), so iterating only over the defaults would copy nothing and the
    // project's own `model` would silently disappear.
    const keys = new Set<string>([...Object.keys(defaultsOf), ...declared.flatMap((layer) => Object.keys(layer.section as object))])
    for (const key of keys) {
        const hit = declared.find((layer) => (layer.section as Record<string, unknown>)[key] !== undefined)
        if (hit === undefined) {
            // Only a field with a real built-in value is worth a problem: the
            // model classes have no defaults (an omitted `provider` is normal),
            // while a missing `maxParallel` IS a silent number change.
            if (key in defaultsOf) missing.push(`${name}.${key} 未配置（models.json 与 profile 都没有）：回退默认 ${describeDefault(defaultsOf[key])}`)
            continue
        }
        out[key] = (hit.section as Record<string, unknown>)[key]
    }
    problems.push(...missing)
    const source: ModelsSource = layers[0]?.section !== undefined ? 'project' : 'profile'
    return { value: out as C, source }
}

/**
 * Resolve the effective `models.json` for one workspace.
 *
 * @param layout - the workspace layout (`<root>/models.json`).
 * @param options - `profile` defaults (the host's `split.models`), `cache` (default true).
 * @returns the effective sections, their provenance and every reported fallback.
 */
export function loadModelsConfig(layout: Layout, options: { profile?: unknown; cache?: boolean } = {}): ModelsConfigResolution {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'models', { cache: options.cache !== false })
    const problems: string[] = [...file.problems]
    const project = file.present && file.value !== undefined ? parseModelsSection(file.value, 'models.json') : { problems: [] }
    const profile = options.profile === undefined ? { problems: [] } : parseModelsSection(options.profile, 'profile 的 split.models')
    problems.push(...project.problems, ...profile.problems)
    const layers = [{ section: project.planner }, { section: profile.planner }]
    const planner = mergeSection('planner', layers, DEFAULT_MODELS_CONFIG.planner, problems)
    const worker = mergeSection(
        'worker',
        [{ section: project.worker }, { section: profile.worker }],
        DEFAULT_MODELS_CONFIG.worker,
        problems,
    )
    const split = mergeSection(
        'split',
        [{ section: project.split }, { section: profile.split }],
        DEFAULT_MODELS_CONFIG.split,
        problems,
    )
    const quality = mergeSection(
        'quality',
        [{ section: project.quality }, { section: profile.quality }],
        DEFAULT_MODELS_CONFIG.quality,
        problems,
    )
    return {
        file: file.file,
        present: file.present,
        config: { planner: planner.value, worker: worker.value, split: split.value, quality: quality.value },
        sources: {
            planner: planner.source,
            worker: worker.source,
            split: split.source,
            quality: quality.source,
        },
        problems,
    }
}

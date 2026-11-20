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
 *   split   { reviewRequired, maxTasks, maxParallel, maxReworkRounds, taskTimeoutMs, maxAttempts,
 *             maxAcceptancePerTask }
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
import { isRecord, parseQualitySection, parseSplitSection, type QualitySettings, type SplitSettings } from './models-sections.js'

// The two section SHAPES live with their parsers (`models-sections.ts`): the
// resolver imports the parsers at runtime, so a type import in the other
// direction would still be a module edge (the standards lexer sees `import type`
// as an import) and therefore a cycle. Re-exported here so the public surface
// (`dsh-eng-core/split`) does not change.
export type { QualitySettings, SplitSettings } from './models-sections.js'
// AC-002 of P3: the retry ceiling lives with the section that declares it, and is
// resolved at the point of use (an absent `maxAttempts` means the documented 1).
// The per-task AC budget follows the same rule (absent = documented 3) and is
// resolved by `models-sections.ts`'s `splitMaxAcceptancePerTask`, next to its
// constants — the barrel stays inside the export-count ratchet.
export { DEFAULT_SPLIT_MAX_ATTEMPTS, MAX_SPLIT_ATTEMPTS, splitMaxAttempts } from './models-sections.js'

/** One model class (`planner` / `worker`). */
export interface ModelClassConfig {
    /** `provider/model` shorthand, split by the caller that routes it. */
    model?: string
    provider?: string
    reasoningEffort?: string
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
    split: { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2, maxAcceptancePerTask: 3 },
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
    split: 'split{reviewRequired,maxTasks,maxParallel,maxReworkRounds,taskTimeoutMs,maxAttempts,maxAcceptancePerTask}',
    quality: 'quality{maxReworkRatio}',
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
    if (input['split'] !== undefined) layer.split = parseSplitSection(input['split'], `${origin} 的 split 段`, problems)
    if (input['quality'] !== undefined) layer.quality = parseQualitySection(input['quality'], `${origin} 的 quality 段`, problems)
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

/**
 * The EFFECTIVE split workflow of ONE workspace (项目级单一来源).
 *
 * Splitting is a property of the REPOSITORY, not of a profile: one host serves
 * several projects (one Neovim, several repositories) and "this one runs the
 * split workflow" must be decided by the project itself. So the switch has
 * exactly one project-level source and the profile is only a default:
 *
 *   project `<布局根>/models.json` 的 `split.enabled`（显式）
 *   > profile `orchestrator.config.split.enabled`（缺省）
 *   > `false`
 *
 * The same precedence already holds for the thresholds (`maxTasks`,
 * `maxParallel`, `maxAcceptancePerTask`, `maxAttempts`, `maxReworkRatio`): the
 * resolver in `dsh-eng-core/models` merges project file → profile `split.models`
 * → built-in default. This module adds the one field that lives OUTSIDE the
 * project file's section shape: the host's own pipeline switch.
 *
 * `source` names the winning layer, so a report can say WHY splitting is on.
 * Nothing here guesses: an unreadable/typoed switch is reported by the parsers
 * and read as "off" — never turned on by a guess.
 *
 * @module dsh-orchestrator/effective-split
 */

import { loadProjectConfig, type Layout, type MissionStoreRegistry } from 'dsh-eng-core'
import { loadModelsConfig, type ModelsSource } from 'dsh-eng-core/split'
import type { OrchestratorConfig } from './config.js'
import type { Pipeline } from './pipeline.js'
import { withSplitStages } from './split-stages.js'

/** The layer whose declaration decided the switch (never a guess). */
export type SplitSwitchSource = 'project' | 'profile' | 'default'

/** The effective thresholds the split workflow runs with. */
export interface EffectiveSplitSettings {
    enabled: boolean
    reviewRequired: boolean
    maxTasks: number
    maxParallel: number
    maxAcceptancePerTask: number
    /** Absent = the documented 1 attempt (`splitMaxAttempts` at the point of use). */
    maxAttempts?: number
    /** Absent = follow `autoDispatch.timeoutMs`, then the documented 600000. */
    taskTimeoutMs?: number
    maxReworkRounds: number
    maxReworkRatio: number
}

/** What one workspace's split workflow is, and where every part came from. */
export interface EffectiveSplit {
    /** The ONE switch: `true` means this repository runs split/split-review. */
    enabled: boolean
    /** Where `enabled` came from: the project file wins, the profile is the default. */
    source: SplitSwitchSource
    /** Where the numeric/`reviewRequired` settings came from (same rule). */
    settingsSource: ModelsSource
    settings: EffectiveSplitSettings
    /** Absolute path of the project file that was consulted. */
    file: string
    /** Every fallback and every rejected value, in the order they were found. */
    problems: readonly string[]
}

/** A plain object (`models.json` is untrusted JSON). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The project file's own switch, when it is a real boolean (explicit wins). */
function projectSwitch(layout: Layout): boolean | undefined {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'models')
    const split = file.value?.['split']
    if (!isRecord(split)) return undefined
    const enabled = split['enabled']
    return typeof enabled === 'boolean' ? enabled : undefined
}

/** The profile's own switch, when the host declared one (`config.split.enabled`). */
function profileSwitch(config: OrchestratorConfig): boolean | undefined {
    return config.split.enabledDeclared ? config.split.enabled : undefined
}

/** A nested `split.models.split.enabled` is a second switch; name it instead of honouring it. */
function ignoredNestedSwitch(config: OrchestratorConfig): string | undefined {
    const models = config.split.models
    if (!isRecord(models)) return undefined
    const split = models['split']
    if (!isRecord(split) || typeof split['enabled'] !== 'boolean') return undefined
    return 'profile 的 split.models.split.enabled 不参与开关：唯一开关是项目 models.json 的 split.enabled（profile 侧缺省请写 config.split.enabled），split.models 这一层只提供阈值与模型缺省'
}

/**
 * Resolve the effective split workflow of one workspace.
 * @param config - the resolved host configuration (its `split` section is the default).
 * @param layout - the workspace layout (`<布局根>/models.json`).
 * @returns the switch, the settings, the winning layer and every reported problem.
 */
export function effectiveSplitFor(config: OrchestratorConfig, layout: Layout): EffectiveSplit {
    const models = loadModelsConfig(layout, { profile: config.split.models })
    const project = projectSwitch(layout)
    const profile = profileSwitch(config)
    const enabled = project ?? profile ?? false
    const source: SplitSwitchSource = project !== undefined ? 'project' : profile !== undefined ? 'profile' : 'default'
    const nested = ignoredNestedSwitch(config)
    const split = models.config.split
    return {
        enabled,
        source,
        settingsSource: models.sources.split,
        settings: {
            enabled,
            reviewRequired: split.reviewRequired,
            maxTasks: split.maxTasks,
            maxParallel: split.maxParallel,
            maxAcceptancePerTask: split.maxAcceptancePerTask,
            maxReworkRounds: split.maxReworkRounds,
            ...(split.maxAttempts === undefined ? {} : { maxAttempts: split.maxAttempts }),
            ...(split.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: split.taskTimeoutMs }),
            maxReworkRatio: models.config.quality.maxReworkRatio,
        },
        file: models.file,
        problems: nested === undefined ? [...models.problems] : [...models.problems, nested],
    }
}

/**
 * The pipeline of one workspace: the split segment exists iff THIS project
 * enabled it (AC-001). A host that declared its own `stages` list keeps it
 * untouched — it names its own stages, split included or not.
 */
export function pipelineFor(config: OrchestratorConfig, layout: Layout): Pipeline {
    if (config.stagesDeclared) return config.stages
    return effectiveSplitFor(config, layout).enabled ? withSplitStages(config.stages) : config.stages
}

/** Build the per-workspace pipeline resolver (`cwd` → pipeline). */
export function createStagesResolver(config: OrchestratorConfig, stores: MissionStoreRegistry): (cwd: string) => Pipeline {
    return (cwd: string): Pipeline => pipelineFor(config, stores.for(cwd).layout)
}

/** Everything {@link scopedDeps} needs from a deps object. */
export interface StagesScoped {
    config: OrchestratorConfig
    stagesFor: (cwd: string) => Pipeline
}

/**
 * The same deps, with the pipeline resolved for ONE workspace.
 *
 * One view instead of a second pipeline: `runOrchestrate`, the auto-advance
 * hook and `enterImplement` all call this before reading `config.stages`, so
 * the stage list they enforce is the one the project declared.
 */
export function scopedDeps<T extends StagesScoped>(deps: T, cwd: string): T {
    const stages = deps.stagesFor(cwd)
    // Identity-checked: a non-split workspace keeps the assembly-time object.
    return stages === deps.config.stages ? deps : ({ ...deps, config: { ...deps.config, stages } } as T)
}

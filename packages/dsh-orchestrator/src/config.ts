/**
 * Plugin configuration (docs.md §9: 门禁的确定性来源是宿主配置，不是模型输出).
 *
 * Everything the orchestrator decides with comes from here: which stages exist,
 * which plugin each stage needs, how many attempts a stage gets and how a
 * plugin is probed. A user-supplied `stages` array is validated before it is
 * used; when it is invalid the default pipeline is used and the reasons are
 * returned to the caller (which logs them) — configuration never crashes the
 * host.
 *
 * @module dsh-orchestrator/config
 */

import type { LayoutOptions } from 'dsh-eng-core'
import { DEFAULT_STAGES, resolvePipeline, type Pipeline } from './pipeline.js'

/** One capability probe: the tool and/or service a plugin registers. */
export interface ProbeConfig {
    tool?: string
    service?: string
}

/** Resolved plugin configuration. */
export interface OrchestratorConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /**
     * The effective pipeline (user-supplied when valid, else the default).
     * A stage without `maxAttempts` uses {@link OrchestratorConfig.defaultMaxAttempts}.
     */
    stages: Pipeline
    /** Per-plugin probe overrides, merged over the built-in map. */
    probes: Record<string, ProbeConfig>
    /** Attempt budget for stages that do not declare their own. */
    defaultMaxAttempts: number
    /**
     * Automatic transition budget (docs.md §4.2 自动触发下一阶段).
     *
     * Only stages with `autoAdvance: true` use it, and only the deterministic
     * turn-stop trigger does: `maxAutoAdvancesPerTurn` caps how many times one
     * session may auto-advance inside a single turn (a loop guard, not a knob
     * for correctness). `0` disables the automatic transition entirely while
     * leaving `autoAdvance` declarations in the pipeline documentation.
     */
    turnStop: {
        maxAutoAdvancesPerTurn: number
    }
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

/** One resolved configuration plus the reasons an override was rejected. */
export interface ResolvedConfig {
    config: OrchestratorConfig
    /** Non-empty when `config.stages` was rejected and replaced by the default. */
    issues: string[]
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the effective configuration and any pipeline-rejection reasons.
 */
export function resolveConfig(input: unknown): ResolvedConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const turnStop = isRecord(raw['turnStop']) ? raw['turnStop'] : {}
    const defaultMaxAttempts = Math.max(1, Math.floor(num(raw['defaultMaxAttempts'], 3)))
    const { stages, issues } = resolvePipeline(raw['stages'], defaultMaxAttempts)
    const probes: Record<string, ProbeConfig> = {}
    const rawProbes = raw['probes']
    if (isRecord(rawProbes)) {
        for (const [plugin, value] of Object.entries(rawProbes)) {
            if (!isRecord(value)) continue
            const tool = value['tool']
            const service = value['service']
            const probe: ProbeConfig = {
                ...(typeof tool === 'string' && tool !== '' ? { tool } : {}),
                ...(typeof service === 'string' && service !== '' ? { service } : {}),
            }
            if (probe.tool !== undefined || probe.service !== undefined) probes[plugin] = probe
        }
    }

    return {
        config: {
            enabled: bool(raw['enabled'], true),
            logFile: str(raw['logFile'], '~/.dsh/orchestrator.log'),
            ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
            layout: {
                ...(typeof raw['rootDir'] === 'string' ? { rootDir: raw['rootDir'] } : {}),
                ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
                ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
                ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
            },
            stages,
            probes,
            defaultMaxAttempts,
            turnStop: {
                // A negative or fractional budget is nonsense for a per-turn
                // counter; 0 is meaningful (the trigger is off).
                maxAutoAdvancesPerTurn: Math.max(0, Math.floor(num(turnStop['maxAutoAdvancesPerTurn'], 2))),
            },
            prompt: {
                enabled: bool(prompt['enabled'], true),
                order: num(prompt['order'], 660),
            },
        },
        issues,
    }
}

export { DEFAULT_STAGES }

/**
 * Plugin configuration.
 *
 * The standards THEMSELVES are not configured here: they belong to the target
 * repository (`.dsh/standards.json`), because the project being measured — not
 * the tooling — owns its structural rules. This file only resolves where those
 * artifacts live, how strictly a violation is treated, and the measurement
 * budget. Keeping the split explicit is the point: a model cannot relax a
 * threshold by editing plugin config, and an operator cannot silently change a
 * project's standards from outside the repository.
 *
 * @module dsh-standards-gate/config
 */

import type { LayoutOptions } from 'dsh-eng-core'

/** How a violation affects the gate. */
export type EnforceMode = 'gate' | 'warn' | 'off'

/** Resolved plugin configuration. */
export interface StandardsGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Repository-owned standards file, relative to the workspace. */
    standardsFile: string
    /** Repository-owned baseline (accepted violations), relative to the workspace. */
    baselineFile: string
    /**
     * `gate` (default) records a PASS/BLOCK verdict on the mission.
     * `warn` records at most a WARN — new violations are reported but never
     * block a delivery, which is what a host asking for "report only" means.
     * `off` records nothing at all.
     */
    enforce: EnforceMode
    /** Bound on files walked in one measurement. */
    maxFiles: number
    /** Bound on one file's size. */
    maxFileBytes: number
    /**
     * Whether accepting new violations into the baseline requires the human
     * approval seam. Default true — a ratchet the model can loosen by itself is
     * not a ratchet (the audit history of this suite has the receipts).
     */
    requireApprovalForBaseline: boolean
    /** `ctx.subagents` provider used for the read-only structural reviewer. */
    reviewProvider: string
    /** How many of the worst files one structural review reads. */
    reviewTargets: number
    /** Deadline for one structural review. */
    reviewTimeoutMs: number
    /** Delegation depth of the reviewer (1 = it may not fan out further). */
    reviewMaxDepth: number
    prompt: {
        enabled: boolean
        order: number
    }
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
 * Resolve the plugin configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): StandardsGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const enforce = raw['enforce']
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/standards-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        standardsFile: str(raw['standardsFile'], '.dsh/standards.json'),
        baselineFile: str(raw['baselineFile'], '.dsh/standards-baseline.json'),
        enforce: enforce === 'warn' || enforce === 'off' || enforce === 'gate' ? enforce : 'gate',
        maxFiles: Math.max(1, Math.floor(num(raw['maxFiles'], 4_000))),
        maxFileBytes: Math.max(1_024, Math.floor(num(raw['maxFileBytes'], 256 * 1_024))),
        reviewProvider: str(raw['reviewProvider'], 'spawn'),
        reviewTargets: Math.max(1, Math.floor(num(raw['reviewTargets'], 4))),
        reviewTimeoutMs: Math.max(30_000, Math.floor(num(raw['reviewTimeoutMs'], 10 * 60_000))),
        reviewMaxDepth: Math.max(1, Math.floor(num(raw['reviewMaxDepth'], 1))),
        requireApprovalForBaseline: bool(raw['requireApprovalForBaseline'], true),
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 665),
        },
    }
}

/** Keys a target repository may override in `<repo>/.dsh/standards-gate.json`. */
export const PROJECT_OVERRIDABLE: readonly string[] = ['enforce', 'standardsFile', 'baselineFile', 'maxFiles', 'maxFileBytes']

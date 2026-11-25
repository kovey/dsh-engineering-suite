/**
 * The split workflow's host configuration (`config.split`), parsed here so
 * `config.ts` stays inside its accepted size (the structural ratchet).
 *
 * `enabled` defaults to false and a typo is REPORTED rather than guessed: the
 * stage list is a contract, and "maybe they meant true" is not a safe reading of
 * `"enabled": "yes"`. `models` is the profile-level default layer of the
 * project's `models.json` (precedence: project file > this > built-in), passed
 * through untouched because the resolver in `dsh-eng-core/split` validates and
 * reports it — one parser, not two.
 *
 * @module dsh-orchestrator/config-split
 */

/** The split workflow's host configuration. */
export interface SplitWorkflowConfig {
    /**
     * The DEFAULT for the project's `models.json` `split.enabled` (缺省层): the
     * `split` / `split-review` stages exist iff THIS project enables them. A
     * project that declares the switch overrides this value, in both directions
     * (`false` beats a profile `true`) — one switch, decided by the repository.
     */
    enabled: boolean
    /** Whether the host DECLARED `enabled` (reported as `source: profile`; absent = the built-in `false`). */
    enabledDeclared: boolean
    /**
     * Profile-level defaults for the project's `models.json` (same four
     * sections). Every fallback the resolver performs is reported.
     */
    models?: unknown
    /** Rejected overrides, reported (never silently applied). */
    issues: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the `split` section.
 * @param value - `config.split` (untrusted).
 * @returns the effective section plus every rejected value.
 */
export function resolveSplitWorkflow(value: unknown): SplitWorkflowConfig {
    if (value === undefined) return { enabled: false, enabledDeclared: false, issues: [] }
    if (!isRecord(value)) return { enabled: false, enabledDeclared: false, issues: ['split 必须是对象（收到非对象，已按未启用处理）'] }
    const issues: string[] = []
    const enabled = value['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') issues.push('split.enabled 必须是布尔值（已按 false 处理：不信猜测）')
    const models = value['models']
    if (models !== undefined && !isRecord(models)) issues.push('split.models 必须是对象（与 models.json 同形，已忽略 profile 默认值）')
    return { enabled: enabled === true, enabledDeclared: typeof enabled === 'boolean', ...(isRecord(models) ? { models } : {}), issues }
}

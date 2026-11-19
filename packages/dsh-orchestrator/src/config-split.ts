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
     * Whether the `split` / `split-review` stages are inserted between
     * `spec-approve` and `implement`.
     *
     * Default `false`: splitting is a deployment decision (it needs planner and
     * worker models plus an approval channel), and the six-stage pipeline is a
     * contract existing profiles and tests rely on. Enabling it inserts the two
     * stages at their documented position — nothing is renamed or reordered.
     */
    enabled: boolean
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
    if (value === undefined) return { enabled: false, issues: [] }
    if (!isRecord(value)) return { enabled: false, issues: ['split 必须是对象（收到非对象，已按未启用处理）'] }
    const issues: string[] = []
    const enabled = value['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') issues.push('split.enabled 必须是布尔值（已按 false 处理：不信猜测）')
    const models = value['models']
    if (models !== undefined && !isRecord(models)) issues.push('split.models 必须是对象（与 models.json 同形，已忽略 profile 默认值）')
    return { enabled: enabled === true, ...(isRecord(models) ? { models } : {}), issues }
}

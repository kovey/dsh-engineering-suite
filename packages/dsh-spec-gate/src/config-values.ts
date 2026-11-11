/**
 * Scalar value parsers and the two small enum normalisers of the configuration.
 *
 * Every key of this plugin has exactly ONE reader: the profile loader and the
 * project-level overlay both call these, so the two files cannot disagree about
 * what a value means (they did when each site had its own copy of the enum).
 * @module dsh-spec-gate/config-values
 */

/** How the approval of a specification is obtained. */
export type ApprovalMode = 'seam'

/** The channels that can ask a human to review a specification. */
export type ReviewChannel = 'auto' | 'tui' | 'approval' | 'questions'

/** A plain object (arrays are values, never configuration sections). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or the fallback. */
export function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback
}

/** A boolean, or the fallback (any other type is not "false"). */
export function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

/** A finite number, or the fallback (`NaN` is not a configured limit). */
export function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A list of non-empty strings; a value of the wrong shape keeps the fallback. */
export function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** Host-only glob list; a value of the wrong shape keeps the host's list. */
export function shellAllowOf(raw: unknown, fallback: readonly string[]): readonly string[] {
    if (!Array.isArray(raw)) return fallback
    const kept: string[] = []
    for (const entry of raw) {
        if (typeof entry === 'string' && entry.trim() !== '') kept.push(entry.trim())
    }
    return kept
}

/**
 * Normalise `approval` in ONE place (two hand-written enums drifted apart).
 *
 * `approval` used to accept `auto`: the deployment could let the model approve
 * its own specification. A gate approval is an authorisation record, so that
 * value is RETIRED — a configuration that still asks for it is refused at load
 * with an explanation instead of silently approving (or silently refusing).
 * @param raw - the untrusted configured value.
 * @param host - the profile value, used when the key is absent or not `seam`.
 * @returns the only supported mode (`seam`).
 * @throws when the configuration still asks for the removed `auto` mode.
 */
export function approvalModeOf(raw: unknown, host: ApprovalMode): ApprovalMode {
    if (raw === 'auto') {
        throw new Error(
            'spec-gate: approval="auto" 已移除——门禁批准是授权记录，不能由配置自动放行。' +
                '请改为 approval="seam"（走人工审批接缝），并确保有可用的审批通道；' +
                '历史 by="auto" 的 mandate 仍可读取，但不会再产生新的。',
        )
    }
    return raw === 'seam' ? 'seam' : host
}

/** Normalise `reviewChannel` in ONE place (two hand-written enums drifted apart). */
export function reviewChannelOf(value: unknown, fallback: ReviewChannel): ReviewChannel {
    return value === 'auto' || value === 'tui' || value === 'approval' || value === 'questions' ? value : fallback
}

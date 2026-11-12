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

/**
 * How a shell command is judged.
 *
 * `targets` checks what it can see and allows the rest (the documented blind
 * spot); `strict` refuses what cannot be attributed; `allowlist` is the
 * positive list (only listed programs run); `off` skips shell analysis. The
 * default is `targets`, so adding the mode changes no existing behaviour.
 */
export type ShellPolicy = 'targets' | 'strict' | 'allowlist' | 'off'

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

/** Normalise `shellPolicy` in ONE place (the profile loader). */
export function shellPolicyOf(value: unknown, fallback: ShellPolicy): ShellPolicy {
    return value === 'targets' || value === 'strict' || value === 'allowlist' || value === 'off' ? value : fallback
}

/**
 * Read the PROJECT-level `shellPolicy`: it may tighten, never widen.
 *
 * `allowlist` is a host decision (it decides how much of the shell surface the
 * deployment is willing to keep), and `off` would let a repository switch the
 * shell checks off from inside itself. A project may still move between
 * `targets` and `strict` when that does not weaken the host value — a strict
 * deployment cannot be relaxed by the repository it watches.
 * @param value - the untrusted project value.
 * @param host - the profile value (the ceiling).
 * @param file - the project file, named in the problem.
 * @returns the accepted policy, or the problem that made it ignored.
 */
export function projectShellPolicyOf(
    value: unknown,
    host: ShellPolicy,
    file: string,
): { policy?: ShellPolicy; problem?: string } {
    if (value === undefined) return {}
    if (value === 'targets' || value === 'strict') {
        if (host === 'off' || host === 'targets' || host === value) return { policy: value }
    }
    return {
        problem:
            `${file}: shellPolicy 只能由宿主决定（项目级只能在不放宽宿主策略时取 targets/strict）；` +
            `"${String(value)}" 已忽略，继续使用 profile 的 ${host}。项目不能自行切到 allowlist 或关掉检查。`,
    }
}

/**
 * Host defaults plus the project's additions (append only, de-duplicated).
 *
 * A project may widen the list — that is the documented meaning of the key —
 * but it can never remove a host entry, so a host-built list cannot be narrowed
 * silently from inside a repository.
 */
export function mergeShellAllowlist(value: unknown, host: readonly string[]): string[] {
    return [...new Set([...host, ...strList(value, [])])]
}

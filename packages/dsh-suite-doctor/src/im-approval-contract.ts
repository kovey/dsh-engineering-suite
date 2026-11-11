/**
 * The vocabulary of the IM approval check: ids, host-owned keys and the facts
 * the gate reports.
 *
 * Split out of `im-approval.ts` so the check files share one definition of what
 * a fact IS without importing each other (a cycle would be reported by the
 * standards gate, and two copies of these shapes would drift).
 *
 * @module dsh-suite-doctor/im-approval-contract
 */

/** Every accepted value of `im.approvalVia`, most conservative first. */
export const APPROVAL_VIA_MODES = ['off', 'fallback', 'only'] as const

/** The mode of the host approval seam (`im.approvalVia`). */
export type ApprovalVia = (typeof APPROVAL_VIA_MODES)[number]

/** The HOST-side default the report names when it tells an operator where the list belongs. */
export const HOST_APPROVERS_FILE = '~/.dsh/interaction-approvers.txt'

/** The repository file the pre-P3.1 rule read — reported, never used. */
export const LEGACY_APPROVERS_FILE = '.dsh/interaction-approvers.txt'

/** The id the required check is reported under. */
export const IM_APPROVAL_CHECK_ID = 'runtime.im-approval'

/** The id of the ADVISORY check about `im.p2pOnly` and an upstream without `chatKind`. */
export const IM_APPROVAL_P2P_CHECK_ID = 'runtime.im-approval-p2p'

/** The id of the MIGRATION check: a repository list that no longer decides anything. */
export const IM_APPROVAL_LEGACY_CHECK_ID = 'runtime.im-approval-legacy-list'

/**
 * The id of the WORKSPACE-MAPPING check (P3.2): does THIS workspace have an
 * approval conversation at all?
 *
 * A separate id because it is a separate failure with a separate fix: the two
 * host keys of P1 can be perfect and this workspace still have no entry in
 * `im.approvals`, in which case every approval raised from here is refused
 * before a card (`refused:no-workspace-mapping`) — or lands in another
 * workspace's conversation under the `host-default` policy. Neither is visible
 * from the mode/target/allowlist facts, which are process-wide.
 */
export const IM_APPROVAL_WORKSPACE_CHECK_ID = 'runtime.im-approval-workspace'

/**
 * The workspace mapping, as the gate reported it for THIS workspace
 * (`im(workspace).workspaceMapping`, P3.2).
 *
 * Absent = the service does not implement the mapping (an older build) or was
 * not asked about a workspace. That is not a state the check can judge, so the
 * check stays silent instead of inventing "mapped" or "unmapped".
 */
export interface WorkspaceMappingFact {
    configured?: boolean
    declared?: number
    usable?: number
    policy?: 'refuse' | 'host-default' | 'local'
    workspace?: string
    resolved?: string
    realpathProblem?: string
    matched?: { index?: number; workspace?: string; chatId?: string; approvers?: number; approversFallback?: boolean }
    conflict?: { candidates?: { index?: number; workspace?: string; chatId?: string }[] }
    problems?: string[]
}

/**
 * The host-side approver facts, exactly as `dsh-interaction-gate` reports them.
 *
 * Every field is optional: the service is not part of this package and may be an
 * older build. `count: undefined` = "this service does not report approvers" —
 * `unknown`, never `0` (which would claim "the host has no list").
 */
export interface HostApproverFact {
    /** Deduplicated host ids (inline ∪ file), before any deny list. */
    count?: number
    /** Host ids declared inline (`im.approvers`). */
    inline?: number
    /** The host-side file (`im.approversFile`, `~` expanded); `''` = unusable path. */
    file?: string
    /** Whether that file was readable. */
    filePresent?: boolean
    /** Usable ids the file holds. */
    fileCount?: number
    /** Host-declared deny ids (`im.denyApprovers`). */
    deny?: number
}

/** The legacy repository list, as found on disk (its ids are NOT the whitelist). */
export interface LegacyApproverFact {
    /** `<repo>/.dsh/interaction-approvers.txt` (always named, present or not). */
    file: string
    present: boolean
    /** Usable ids in that file (so an operator knows what to migrate). */
    count: number
    /** The path a project config still declares via `approversFile` (ignored since P3.1). */
    declaredPath?: string
    /** Usable ids at that declared path, when it is readable. */
    declaredCount?: number
}

/** Everything the check judges (built by `probe.ts` from the service report + the project file). */
export interface ImApprovalFact {
    /** Whether this process mounts the `interaction` service at all. */
    service: boolean
    /**
     * The reported `im.approvalVia`.
     *
     * `undefined` = the service does not report it (an older build). That is
     * `unknown`, never `off`: "we could not read the mode" and "the mode is off"
     * are different facts.
     */
    mode?: ApprovalVia
    /** The configured approval conversation; `''`/absent = not configured. */
    target?: string
    /** `im.p2pOnly` (the gate's fail-closed default is `true`). */
    p2pOnly?: boolean
    /** Why the mode could not be read (a probe failure / an older service), when known. */
    modeProblem?: string
    /**
     * The workspace mapping for the workspace this report is about (P3.2), when
     * the service reports one. Absent = no mapping feature (an older build) or no
     * workspace was named: the mapping check then stays silent instead of
     * inventing "mapped"/"unmapped".
     */
    mapping?: WorkspaceMappingFact
    /** The HOST-side approver list (`from` whitelist): the only source that decides approvals. */
    approvers: HostApproverFact
    /** The legacy repository list: migration signal only. */
    legacy: LegacyApproverFact
}

/** A chat id shown whole only when it is too short to be an identity leak. */
export function maskTarget(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

/**
 * The `im.approvalVia` labels the report uses.
 * @param mode - the effective mode.
 */
export function modeLabel(mode: ApprovalVia): string {
    return `im.approvalVia=${mode}`
}

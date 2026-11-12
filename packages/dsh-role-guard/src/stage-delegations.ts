/**
 * Recording a successful `team_delegate` in the shared delegation ledger
 * (`dsh-eng-core/delegations`).
 *
 * Why this exists: a stage's role used to be a declaration nobody checked. The
 * write guard and `orchestrate({ action: "advance" })` now ask the ledger "was
 * this stage delegated to a child, as that role?" — so the delegation path must
 * leave that fact behind, durably, before the child starts writing.
 *
 * Failure policy: **an unwritable ledger never blocks a delegation**. The host
 * already authorised the child; failing it on a bookkeeping error would turn a
 * disk problem into an outage. The caller reports the failure as a `warning:`
 * line in the tool result (and logs it), so the fact that the role is not
 * recorded stays visible instead of silent.
 *
 * @module dsh-role-guard/stage-delegations
 */

import { sessionCwd, type AgentLike, type LayoutOptions, type MissionRecord, type MissionStoreRegistry } from 'dsh-eng-core'
import { appendDelegationOnce } from 'dsh-eng-core/delegations'

/** The slice of {@link import('./tools.js').ToolDeps} this module needs. */
export interface StageDelegationDeps {
    /** Mission store registry (the same one every other decision reads). */
    stores: MissionStoreRegistry
    /** The plugin's layout overrides, so the ledger lives where the mission does. */
    layout: LayoutOptions
    /** A logger, for the failure that the tool result also reports. */
    logger?: { warn: (message: string, error?: unknown) => void }
}

/**
 * Append one delegation row for the calling session's bound mission.
 *
 * The mission is resolved through {@link MissionStoreRegistry} with the same
 * `resolveForAgent` rule the gates use (a child delegating further inherits its
 * parent's mission), and the stage is the mission's current stage — the exact
 * pair the write guard and `advance` will compare against.
 *
 * This is the ledger's single writer for both delegation paths: `team_delegate`
 * (model-facing) and the role-guard service's `bind` (an autonomous dispatcher).
 * The append is de-duplicated on `missionId + stage + role + childSessionId`, so
 * a retry of either path cannot add a second identical row; the deduplication
 * happens under a directory lock, and when that lock is unavailable the row is
 * still written (without deduplication) and the reason comes back as a warning.
 * @param deps - store registry, layout and logger.
 * @param agent - the delegating agent (its session owns the mission binding).
 * @param role - role id the child was started as.
 * @param childSessionId - the child's session id (`team_delegate`'s `run.id`).
 * @param cwd - explicit workspace (an autonomous dispatcher knows it); omitted
 *   or empty means the delegating agent's session workspace.
 * @returns a warning text when the row could not be written — or was written
 *   without de-duplication because the ledger lock was unavailable — and
 *   `undefined` otherwise.
 */
export function recordStageDelegation(
    deps: StageDelegationDeps,
    agent: AgentLike | undefined,
    role: string,
    childSessionId: string,
    cwd?: string,
): string | undefined {
    const workspace = cwd === undefined || cwd === '' ? sessionCwd(agent) : cwd
    let mission: MissionRecord | undefined
    try {
        mission = deps.stores.for(workspace).resolveForAgent(agent)
    } catch (error) {
        return warn(deps, workspace, error)
    }
    // No bound mission → nothing the ledger could be compared against. The
    // delegation still runs; there is nothing to warn about (the role binding
    // and the tool list do not depend on a mission).
    if (mission === undefined) return undefined
    try {
        const result = appendDelegationOnce(
            workspace,
            {
                missionId: mission.id,
                role,
                childSessionId,
                ...(mission.stage === undefined || mission.stage === '' ? {} : { stage: mission.stage }),
            },
            deps.layout,
            deps.logger,
        )
        // `warning` is the degraded path: the row IS on disk, but without the
        // lock. Returning it keeps "de-duplication was skipped" visible in the
        // tool result instead of only in the log.
        return result.warning
    } catch (error) {
        return warn(deps, workspace, error)
    }
}

/** Log the failure and phrase it for the tool result (never throws). */
function warn(deps: StageDelegationDeps, cwd: string, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `未能写入委派记录（${cwd} 的 <布局根>/state/delegations.jsonl）：${reason}。本次派发照常执行；但该阶段没有委派记录，spec-gate 写守卫与 orchestrate advance 不会把这次派发当成已委派。`
    try {
        deps.logger?.warn(message, error)
    } catch {
        // A logger must never turn a bookkeeping failure into a delegation failure.
    }
    return message
}

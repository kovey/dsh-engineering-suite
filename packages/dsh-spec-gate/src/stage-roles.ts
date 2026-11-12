/**
 * The stage-role half of the write guard: a stage that declares a role may only
 * be written by the child that was delegated for it.
 *
 * Why the write guard and not the prompt: `implement` declares
 * `role: developer`, but that used to be a declaration — a lead could edit the
 * implementation itself and every gate stayed green, so role separation was
 * documentation. The delegation ledger (`<layout>/state/delegations.jsonl`,
 * written by `dsh-role-guard` after `team_delegate` starts a child) is the
 * durable fact that distinguishes "the delegated developer" from "the main
 * session".
 *
 * Three deliberate non-behaviours:
 *  - **reads are never gated** — this is only consulted for write-class calls;
 *  - a mission whose current stage declares no role is untouched;
 *  - an unreadable/absent ledger reads as "no delegation" (fail closed), but a
 *    failure to READ `state/` must not be confused with a rule: the caller sees
 *    the same refusal text either way, which is what a reviewer can verify.
 *
 * @module dsh-spec-gate/stage-roles
 */

import path from 'node:path'
import { sessionIdOf, type AgentLike, type LayoutOptions, type MissionRecord, type MissionStore } from 'dsh-eng-core'
import { DELEGATION_LEDGER, matchesDelegation, readDelegations, stageRoleOf } from 'dsh-eng-core/delegations'
import { stageRoleReason } from './guard-messages.js'

/** Everything the check reads (the caller has already resolved all of it). */
export interface StageRoleWriteCheck {
    /** The plugin's layout overrides (same ones the mission store resolved with). */
    layout: LayoutOptions
    /** Mission store of the workspace (also the stage-artifact reader). */
    store: MissionStore
    /** The mission the write is attributed to. */
    mission: MissionRecord
    /** The calling agent (its session id is what the ledger must contain). */
    agent: AgentLike | undefined
    /** Workspace root the write is resolved against. */
    cwd: string
}

/**
 * The denial text when the caller is not the stage's delegated child.
 * @param check - mission, caller, layout and cwd.
 * @returns the reason to refuse, or `undefined` when the write may proceed.
 */
export function stageRoleWriteRefusal(check: StageRoleWriteCheck): string | undefined {
    const stage = check.mission.stage
    const role = stageRoleOf(check.mission, check.store)
    if (stage === undefined || stage === '' || role === undefined) return undefined
    const sessionId = sessionIdOf(check.agent)
    if (sessionId !== undefined) {
        const records = readDelegations(check.cwd, check.mission.id, check.layout)
        if (matchesDelegation(records, { stage, role, childSessionId: sessionId }) !== undefined) return undefined
    }
    const ledger = path.relative(check.cwd, path.join(check.store.layout.stateDir, DELEGATION_LEDGER)).split(path.sep).join('/')
    return stageRoleReason({
        missionId: check.mission.id,
        stage,
        role,
        ...(sessionId === undefined ? {} : { sessionId }),
        ledger,
    })
}

/**
 * Which workspace a call belongs to.
 *
 * A session states its workspace in `session.header.cwd`. Nothing here ever
 * falls back to `process.cwd()`: with no declared workspace the mission store
 * would be resolved — and evidence, receipts and the delivery verdict would
 * land — inside the harness's own directory, i.e. inside a DIFFERENT project.
 * `dsh-spec-gate` refuses the same way, so both gates stay consistent.
 *
 * @module dsh-evidence-gate/workspace
 */

import type { AgentLike } from 'dsh-eng-core'

/**
 * The workspace a session declared, or `undefined` when it declared none
 * (missing, empty or non-string `session.header.cwd`).
 *
 * Deliberately returns `undefined` instead of a default: the caller decides
 * what to do without one (the tools refuse, the prompt section falls back to
 * the profile text) — guessing is what this helper exists to prevent.
 */
export function declaredCwd(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The refusal shown when a tool call's session declared no workspace.
 *
 * The store needs a layout, so there is nothing to resolve against — not even
 * an explicit `missionId` (which mission file a `missionId` names depends on
 * the workspace it is read from).
 */
export const NO_WORKSPACE_ERROR =
    '无法确定本会话的工作区（session.header.cwd 缺失），为避免把证据/回执写到错误的项目，本工具拒绝执行。下一步：在带 cwd 的会话里工作，显式传 missionId 也需要工作区才能定位台账，因此不能绕过这一步。'

/**
 * The workspace a session DECLARED, or `undefined`.
 *
 * Deliberately no `process.cwd()` fallback: a session that names no workspace
 * must never be attributed to the harness's own directory (a different
 * project). Callers refuse, or skip, instead of guessing.
 *
 * @module dsh-audit-trail/workspace
 */

import type { AgentLike } from 'dsh-eng-core'

/** The declared workspace root, or `undefined` when the session named none. */
export function declaredCwdOf(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

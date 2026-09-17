/**
 * Structural views of the harness objects the suite touches.
 *
 * The plugin code never imports `@deepseek-ai/dsh-agent` at runtime: it only
 * reads `agent.session.header`, `agent.session.id`, and `agent.id`. Declaring
 * those shapes here keeps every plugin loadable against a host that ships a
 * slightly different (but structurally compatible) harness build, and keeps
 * unit tests free of harness fixtures.
 *
 * @module dsh-eng-core/session
 */

/** Minimal structural view of an Agent (see `@deepseek-ai/dsh-agent`). */
export interface AgentLike {
    readonly id?: string
    readonly session?: {
        readonly id?: string
        readonly header?: {
            readonly id?: string
            readonly cwd?: string
            /** Session this one was delegated from, for subagent children. */
            readonly parentSession?: string
            readonly origin?: string
            readonly delegationDepth?: number
        }
    }
}

/** The session id of an agent, when it has a live session. */
export function sessionIdOf(agent: AgentLike | undefined): string | undefined {
    const fromHeader = agent?.session?.header?.id
    if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
    const direct = agent?.session?.id
    if (typeof direct === 'string' && direct !== '') return direct
    return undefined
}

/** The agent id (subagents have their own). */
export function agentIdOf(agent: AgentLike | undefined): string | undefined {
    return typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined
}

/**
 * The workspace root a session operates in.
 *
 * `header.cwd` is the only durable answer; a host that omits it (some SDK
 * embeddings) leaves the caller to decide, so the fallback is explicit rather
 * than a silent `process.cwd()`.
 */
export function sessionCwd(agent: AgentLike | undefined, fallback: string = process.cwd()): string {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : fallback
}

/** Whether a session is a delegated child (has a delegation depth). */
export function isSubagent(agent: AgentLike | undefined): boolean {
    return agent?.session?.header?.origin === 'subagent'
}

/**
 * The session this agent was delegated from, when it is a subagent child.
 *
 * Mission resolution uses it so a delegated developer works on its parent's
 * mission instead of being denied as "no specification" — the delegation
 * contract lives in the child's own session header, which is exactly the
 * durable fact we are allowed to read.
 */
export function parentSessionIdOf(agent: AgentLike | undefined): string | undefined {
    const parent = agent?.session?.header?.parentSession
    return typeof parent === 'string' && parent !== '' ? parent : undefined
}

/** Delegation depth (0 for a top-level session). */
export function delegationDepthOf(agent: AgentLike | undefined): number {
    const depth = agent?.session?.header?.delegationDepth
    return typeof depth === 'number' && Number.isFinite(depth) ? depth : 0
}

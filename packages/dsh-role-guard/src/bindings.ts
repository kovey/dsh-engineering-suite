/**
 * Durable session → role bindings.
 *
 * `team_delegate` records which role created a child, keyed by the child's
 * **session id** (`run.id` of a `SubagentRun`), at
 * `<root>/state/roles/<sessionId>.json`. The file — not the process — is the
 * source of truth, so the invocation-time gates keep working after a plugin
 * reload, a host restart, or when a resumed child runs in a later assembly.
 *
 * Lookup cost is bounded on purpose: an entry is cached per file and
 * revalidated with one `statSync` (mtime + size), so a warm call does a single
 * `stat` and no parse, and a cold call does one `readJson`. Binding files are
 * never deleted on disposal — a resumed child must keep its role — so only the
 * in-process cache is dropped (`forget`).
 *
 * @module dsh-role-guard/bindings
 */

import fs from 'node:fs'
import path from 'node:path'
import { assertSafeId, parentSessionIdOf, readJson, sessionIdOf, writeJsonAtomic } from 'dsh-eng-core'
import type { AgentLike, Layout, Logger } from 'dsh-eng-core'
import type { EffectiveRoute } from './route.js'
import type { Role, RoleMode } from './roles.js'

/** One durable session → role binding. */
export interface RoleBinding {
    /** The child session this binding belongs to. */
    sessionId: string
    /** Role id used for `team_delegate`. */
    roleId: string
    /** Role display name at bind time (for messages; the id is authoritative). */
    role: string
    /** `write` | `read` at bind time. */
    mode: RoleMode
    /** The role's skill whitelist; empty means "no restriction". */
    skills: readonly string[]
    /** The role's tool whitelist (recorded for diagnostics). */
    tools: readonly string[]
    /**
     * The LLM route the child actually ran on, so an audit can tell which
     * model a delegated session used. Absent when the child inherited the
     * host's own route (this plugin handed nothing over).
     */
    route?: EffectiveRoute
    updatedAt: number
}

/**
 * Path of one session's binding file.
 * @param layout - the workspace layout.
 * @param sessionId - the child session id (validated as a path segment).
 * @throws when the id could escape the state directory.
 */
export function bindingFile(layout: Layout, sessionId: string): string {
    return path.join(layout.stateDir, 'roles', `${assertSafeId(sessionId, 'session id')}.json`)
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/**
 * Read back the stored route.
 *
 * Additive and total: a file written before this field existed simply has no
 * route, and a hand-edited or corrupt route degrades to "the fields that are
 * usable" instead of making the whole binding unusable — losing the skill
 * whitelist because of a bad `maxTokens` would be a security regression.
 */
function asRoute(value: unknown): EffectiveRoute | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const field = (key: string): string | undefined => {
        const raw = record[key]
        return typeof raw === 'string' && raw !== '' ? raw : undefined
    }
    const provider = field('provider')
    const model = field('model')
    const reasoningEffort = field('reasoningEffort')
    const rawMaxTokens = record['maxTokens']
    const maxTokens = typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : undefined
    if (provider === undefined && model === undefined && reasoningEffort === undefined && maxTokens === undefined) return undefined
    return {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
    }
}

/** Keep only the fields that carry a value, so the file stays comparable. */
function compactRoute(route: EffectiveRoute | undefined): EffectiveRoute | undefined {
    if (route === undefined) return undefined
    return asRoute(route)
}

/** Validate a parsed file into a binding, or `undefined` when unusable. */
function asBinding(value: unknown, sessionId: string): RoleBinding | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const roleId = typeof record['roleId'] === 'string' && record['roleId'] !== '' ? record['roleId'] : undefined
    if (roleId === undefined) return undefined
    const stored = record['sessionId']
    const route = asRoute(record['route'])
    return {
        sessionId: typeof stored === 'string' && stored !== '' ? stored : sessionId,
        roleId,
        role: typeof record['role'] === 'string' && record['role'] !== '' ? record['role'] : roleId,
        mode: record['mode'] === 'read' ? 'read' : 'write',
        skills: stringList(record['skills']),
        tools: stringList(record['tools']),
        ...(route === undefined ? {} : { route }),
        updatedAt: typeof record['updatedAt'] === 'number' && Number.isFinite(record['updatedAt']) ? record['updatedAt'] : 0,
    }
}

/**
 * Session → role bindings for one plugin instance.
 *
 * The layout is resolved through a provider because it depends on the agent
 * whose session is being addressed: the delegating agent supplies it at bind
 * time, the executing agent at enforcement time.
 */
export class RoleBindingStore {
    private readonly cache = new Map<string, { mtimeMs: number; size: number; binding: RoleBinding | undefined }>()

    constructor(
        private readonly layoutFor: (agent: AgentLike | undefined) => Layout,
        private readonly logger?: Logger,
    ) {}

    /**
     * Record the role that created one child session.
     * @param agent - the delegating agent (supplies the workspace).
     * @param sessionId - the child session id.
     * @param role - the role the child was created with.
     * @param route - the effective model route the child ran on (optional and
     *   additive: a binding written without it stays readable).
     * @returns the recorded binding, or `undefined` when it could not be written
     *   (the caller must warn: an unwritten binding means no skill enforcement
     *   for that child).
     */
    bind(agent: AgentLike | undefined, sessionId: string, role: Role, route?: EffectiveRoute): RoleBinding | undefined {
        return this.bindAt(this.layoutFor(agent), sessionId, role, route)
    }

    /**
     * Record a binding for an explicitly known workspace.
     *
     * A caller that knows the workspace (an autonomous dispatcher acting on a
     * mission) must not go through `layoutFor(agent)`: with no agent that falls
     * back to the PROCESS directory, which would write the child's binding into
     * the wrong `.dsh/` — leaving the real child unbound and the skill gate blind.
     * @param layout - the workspace layout the child belongs to.
     * @param sessionId - the child session id.
     * @param role - the role the child was created with.
     * @param route - the effective route the child ran on.
     */
    bindAt(layout: Layout, sessionId: string, role: Role, route?: EffectiveRoute): RoleBinding | undefined {
        try {
            const file = bindingFile(layout, sessionId)
            const effective = compactRoute(route)
            const binding: RoleBinding = {
                sessionId,
                roleId: role.id,
                role: role.name,
                mode: role.mode,
                skills: [...role.skills],
                tools: [...role.tools],
                ...(effective === undefined ? {} : { route: effective }),
                updatedAt: Date.now(),
            }
            writeJsonAtomic(file, binding)
            this.remember(file, binding)
            return binding
        } catch (error) {
            this.logger?.warn(`cannot record the role binding for session "${sessionId}":`, error)
            return undefined
        }
    }

    /**
     * The binding stored for exactly this session (no inheritance).
     * @returns the binding, or `undefined` when the session was not delegated
     *   by a role, the file is unreadable/corrupt, or the id is unusable.
     */
    for(agent: AgentLike | undefined, sessionId: string): RoleBinding | undefined {
        try {
            return this.at(this.layoutFor(agent), sessionId)
        } catch (error) {
            this.logger?.debug('role binding lookup failed:', error)
            return undefined
        }
    }

    /**
     * The role that governs this agent: its own binding, else its direct
     * parent's (`parentSession` in the child's session header).
     *
     * Inheritance stops after that one hop on purpose: the header exposes only
     * the direct parent, so a chain beyond it cannot be reconstructed from
     * durable facts — and an unbound intermediate means the grandparent's role
     * was never recorded either. A session that was itself delegated by
     * `team_delegate` therefore always carries its own binding.
     */
    resolve(agent: AgentLike | undefined): RoleBinding | undefined {
        try {
            const layout = this.layoutFor(agent)
            const own = sessionIdOf(agent)
            if (own !== undefined) {
                const binding = this.at(layout, own)
                if (binding !== undefined) return binding
            }
            const parent = parentSessionIdOf(agent)
            return parent === undefined ? undefined : this.at(layout, parent)
        } catch (error) {
            this.logger?.debug('role inheritance failed:', error)
            return undefined
        }
    }

    /** Drop the cached entry of one session (its file stays: a resumed child keeps its role). */
    forget(sessionId: string | undefined): void {
        if (typeof sessionId !== 'string' || sessionId === '') return
        // Anchored on the separator so `run-1` never evicts a `xrun-1` entry.
        const suffix = `${path.sep}${sessionId}.json`
        for (const file of [...this.cache.keys()]) {
            if (file.endsWith(suffix)) this.cache.delete(file)
        }
    }

    /** Drop every cached entry (plugin teardown, tests). */
    clear(): void {
        this.cache.clear()
    }

    /** Cache the value just written, with the stat of the file that was written. */
    private remember(file: string, binding: RoleBinding): void {
        try {
            const stat = fs.statSync(file)
            this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, binding })
        } catch {
            this.cache.delete(file)
        }
    }

    /** The one cached read: one `stat` when warm, one small `readJson` when cold. */
    private at(layout: Layout, sessionId: string): RoleBinding | undefined {
        const file = bindingFile(layout, sessionId)
        let stat: fs.Stats
        try {
            stat = fs.statSync(file)
        } catch {
            // Never cache a miss: the binding may be written moments later by the
            // delegation that is still starting.
            this.cache.delete(file)
            return undefined
        }
        const cached = this.cache.get(file)
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.binding
        const binding = asBinding(readJson<unknown>(file), sessionId)
        this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, binding })
        return binding
    }
}

/** {@link RoleBindingStore.bind} as a free function. */
export function bindRole(
    store: RoleBindingStore,
    agent: AgentLike | undefined,
    sessionId: string,
    role: Role,
    route?: EffectiveRoute,
): RoleBinding | undefined {
    return store.bind(agent, sessionId, role, route)
}

/**
 * The role governing one session, without inheritance
 * ({@link RoleBindingStore.resolve} adds the ancestor walk).
 */
export function roleForSession(store: RoleBindingStore, agent: AgentLike | undefined, sessionId: string): RoleBinding | undefined {
    return store.for(agent, sessionId)
}

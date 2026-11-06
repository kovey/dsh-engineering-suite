/**
 * Role → Agent Preset registration.
 *
 * On harness 0.2.2-rc.1 a role's persona and tool whitelist can no longer ride
 * along in the subagent start request (`SubagentStartRequest` carries neither
 * `persona` nor `toolFilter`); they travel as a **composition**: the host
 * mounts a preset into the child's scope, and the preset's rows do the work.
 * This module declares one preset per role:
 *
 * ```
 * id: role:<roleId>            order: 100 + index
 * plugins:
 *   - id: role-guard-scope     name: dsh-eng-core/scope
 *     config: { persona, allow?, deny? }
 * ```
 *
 * The row's plugin is the scope plugin shared from `dsh-eng-core/scope`
 * (`packages/dsh-eng-core/src/scope.ts`), which runs in the child's scope and
 * calls `ctx.tools.restrict(...)` there — host-enforced, not prompt text. It is
 * shared rather than copied because `dsh-orchestrator` mounts the same row for
 * an auto-dispatched stage; one implementation, one place to fix.
 *
 * The specifier is IMPORTED, not spelled out: a rename that leaves a stale
 * string in a row is exactly the failure this suite keeps hitting (the preset
 * then fails to mount and the child starts with no restriction at all).
 *
 * Registration is deliberately defensive: `apply()` must never fail because the
 * preset service is absent, slow, or rejects one definition. Failures are
 * collected per id (`problems()`), reported to the plugin log, and surfaced to
 * the delegation path as a **refusal** (never as a silent fall back to a
 * prompt-only role).
 *
 * @module dsh-role-guard/presets
 */

import { name as SCOPE_NAME } from 'dsh-eng-core/scope'
import type { Role } from './roles.js'

/**
 * The scope plugin a preset row mounts (`dsh-eng-core/scope`).
 *
 * Imported from the implementation so the two can never drift.
 */
export const SCOPE_PLUGIN_NAME = SCOPE_NAME

/** Row id inside one preset; stable so a roster is readable in a diff. */
export const SCOPE_ROW_ID = 'role-guard-scope'

/** Preset ids are namespaced so they cannot collide with a deployment's own. */
export const PRESET_ID_PREFIX = 'role:'

/** Presets sort after a deployment's hand-written ones. */
export const PRESET_ORDER_BASE = 100

/** Longest preset description the roster renders well. */
export const DESCRIPTION_MAX = 120

/** The tool filter a role's preset enforces (a subset of `ToolRestriction`). */
export interface PresetFilter {
    allow?: readonly string[]
    deny?: readonly string[]
}

/** One cordis plugin row of a preset. */
export interface PresetRow {
    id: string
    name: string
    config: Record<string, unknown>
}

/** A `PresetDefinition` as `@deepseek-ai/dsh-agent-preset-registry` declares it. */
export interface PresetDefinitionLike {
    id: string
    name: string
    description: string
    order: number
    plugins: PresetRow[]
}

/** Structural view of `ctx.agentPresets`, read per call. */
export interface AgentPresetsLike {
    /** Register one definition. The real one is async and returns a disposer. */
    register: (definition: unknown) => unknown
    /** Optional "is this id in the roster" probe (the real registry has none). */
    has?: (id: string) => boolean
}

/** A logger, narrowed to what this module uses. */
export interface PresetLogger {
    warn: (message: string, error?: unknown) => void
    info?: (message: string) => void
}

/** Why a role's preset cannot be used for a dispatch. */
export type PresetRefusalReason = 'unavailable' | 'foreign' | 'stale' | 'failed'

/** The outcome of asking for one role's preset. */
export interface PresetStatus {
    id: string
    ok: boolean
    reason?: PresetRefusalReason
    /** Human-readable detail (the registration error, the differing filters). */
    detail?: string
}

/** The preset id for a role id. */
export function presetIdFor(roleId: string): string {
    return `${PRESET_ID_PREFIX}${roleId}`
}

/**
 * The roster description for a role's preset.
 * @param role - the resolved role.
 * @returns at most {@link DESCRIPTION_MAX} characters.
 */
export function presetDescription(role: Role): string {
    const text = role.description.trim() === '' ? `角色 ${role.name}（${role.id}，mode=${role.mode}）的 persona 与工具白名单，由宿主强制。` : role.description.trim()
    return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

/** The enforcement fingerprint of a filter (order-insensitive per side). */
function filterFingerprint(filter: PresetFilter | undefined): string {
    const allow = filter?.allow === undefined ? null : [...filter.allow].sort()
    const deny = filter?.deny === undefined ? null : [...filter.deny].sort()
    return JSON.stringify([allow, deny])
}

/**
 * Build one role's preset definition.
 * @param role - the resolved role.
 * @param order - roster position (`100 + index` of the role in its registry).
 * @param filter - the tool filter the child scope must enforce.
 * @returns the definition to register.
 */
export function presetDefinitionFor(role: Role, order: number, filter: PresetFilter | undefined): PresetDefinitionLike {
    return {
        id: presetIdFor(role.id),
        name: role.name,
        description: presetDescription(role),
        order,
        plugins: [
            {
                id: SCOPE_ROW_ID,
                name: SCOPE_PLUGIN_NAME,
                config: {
                    persona: role.persona,
                    ...(filter?.allow === undefined ? {} : { allow: filter.allow }),
                    ...(filter?.deny === undefined ? {} : { deny: filter.deny }),
                },
            },
        ],
    }
}

/** Dependencies of {@link RolePresetRegistry}. */
export interface RolePresetDeps {
    /** `ctx.get('agentPresets')`, read per call (the service may appear late). */
    presets: () => AgentPresetsLike | undefined
    /** The filter a role's child scope must enforce (host-visible tool names). */
    filterFor: (role: Role) => PresetFilter | undefined
    logger?: PresetLogger
}

/** One registration this plugin owns. */
interface TrackedPreset {
    definition: PresetDefinitionLike
    fingerprint: string
    disposer?: unknown
}

/**
 * The presets this plugin registered, keyed by role id.
 *
 * The ids are tracked so `team_delegate` can answer "we registered it" — a
 * preset somebody else declared under the same id is never used as if it were a
 * role (we cannot vouch for its persona or whitelist).
 */
export class RolePresetRegistry {
    private readonly tracked = new Map<string, TrackedPreset>()
    private readonly failures = new Map<string, string>()
    private readonly issues: string[] = []

    constructor(private readonly deps: RolePresetDeps) {}

    /** The live `agentPresets` service, or `undefined` when the host has none. */
    service(): AgentPresetsLike | undefined {
        try {
            return this.deps.presets()
        } catch {
            return undefined
        }
    }

    /** Registration problems observed so far (surfaced through `team_delegate`). */
    problems(): readonly string[] {
        return this.issues
    }

    /** The ids this plugin registered (role id → preset id projection). */
    registeredIds(): string[] {
        return [...this.tracked.values()].map((entry) => entry.definition.id)
    }

    /**
     * Register one role's preset if this plugin has not registered it yet.
     *
     * Idempotent by id, and it never throws: the caller decides whether a
     * non-`ok` status becomes a refusal.
     * @param role - the resolved role.
     * @returns whether the preset is usable for a dispatch of this role.
     */
    ensure(role: Role): PresetStatus {
        const id = presetIdFor(role.id)
        const service = this.service()
        if (service === undefined) return { id, ok: false, reason: 'unavailable' }
        const filter = this.deps.filterFor(role)
        const fingerprint = filterFingerprint(filter)
        const tracked = this.tracked.get(role.id)
        if (tracked !== undefined) {
            if (tracked.fingerprint === fingerprint) return { id, ok: true }
            // The preset is fixed at registration while role files hot-reload.
            // A changed filter means the child would run under the OLD rights —
            // refuse instead of enforcing something the role file no longer says.
            return {
                id,
                ok: false,
                reason: 'stale',
                detail: `注册时的过滤 ${tracked.fingerprint}，当前角色文件的过滤 ${fingerprint}`,
            }
        }
        const failed = this.failures.get(role.id)
        if (failed !== undefined) return { id, ok: false, reason: 'failed', detail: failed }
        if (typeof service.has === 'function' && service.has(id)) {
            const detail = `已被其他插件注册，不是 dsh-role-guard 注册的：无法保证它的 persona/工具白名单与角色文件一致`
            this.failures.set(role.id, detail)
            this.issue(`agent preset ${id}: ${detail}`)
            return { id, ok: false, reason: 'foreign', detail }
        }
        const definition = presetDefinitionFor(role, PRESET_ORDER_BASE + this.tracked.size, filter)
        try {
            const disposer = service.register(definition)
            this.tracked.set(role.id, { definition, fingerprint, disposer })
            // The real `register` is async and settles activation later; a
            // rejection must un-own the id rather than leave a "registered" lie.
            if (typeof (disposer as PromiseLike<unknown>)?.then === 'function') {
                void Promise.resolve(disposer as PromiseLike<unknown>).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error)
                    this.tracked.delete(role.id)
                    this.failures.set(role.id, message)
                    this.issue(`agent preset ${id} 注册失败：${message}`)
                })
            }
            return { id, ok: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.failures.set(role.id, message)
            this.issue(`agent preset ${id} 注册失败：${message}`)
            return { id, ok: false, reason: 'failed', detail: message }
        }
    }

    /**
     * Best-effort registration of a whole registry (assembly time).
     * @param roles - the roles of the workspace this host assembles for.
     * @returns how many presets this call registered, and the first refusal.
     */
    ensureAll(roles: readonly Role[]): { registered: number; refused: number } {
        let registered = 0
        let refused = 0
        for (const role of roles) {
            const status = this.ensure(role)
            if (status.ok) registered += 1
            else if (status.reason !== 'unavailable') refused += 1
        }
        return { registered, refused }
    }

    /** Report one registration problem through the plugin log. */
    private issue(message: string): void {
        this.issues.push(message)
        this.deps.logger?.warn(message)
    }

    /** Drop the tracked ids and release the host registrations they own. */
    clear(): void {
        for (const entry of this.tracked.values()) {
            const disposer = entry.disposer
            if (typeof disposer === 'function') {
                try {
                    void (disposer as () => unknown)()
                } catch (error) {
                    this.deps.logger?.warn(`agent preset ${entry.definition.id} disposer failed:`, error)
                }
                continue
            }
            if (typeof (disposer as PromiseLike<unknown>)?.then === 'function') {
                void Promise.resolve(disposer as PromiseLike<unknown>)
                    .then((release) => (typeof release === 'function' ? (release as () => unknown)() : undefined))
                    .catch(() => undefined)
            }
        }
        this.tracked.clear()
    }
}

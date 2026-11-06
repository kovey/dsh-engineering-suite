/**
 * Agent Presets for auto-dispatched stages.
 *
 * On harness 0.2.2-rc.1 the subagent start request carries neither `persona`
 * nor `toolFilter` (`SubagentStartRequest` has neither) and the two-argument
 * `subagents.start(provider, request)` no longer exists. A stage's identity and
 * its tool restriction can therefore only travel as a **composition**: the host
 * mounts a preset into the child's scope, and the preset's single row mounts the
 * scope plugin shared from `dsh-eng-core/scope`, which calls
 * `ctx.tools.restrict(...)` there. That is what keeps the anti-recursion guard
 * host-enforced rather than a sentence in a prompt:
 *
 * ```
 * id: orchestrator:<role>       order: 200 + index
 * plugins:
 *   - id: orchestrator-scope    name: dsh-eng-core/scope
 *     config: { persona?, allow?, deny: [..., 'orchestrate'] }
 * ```
 *
 * The row's specifier is IMPORTED from the implementation, never spelled out: a
 * rename that leaves a stale string behind is exactly the failure this suite
 * keeps hitting (the row fails to load, and the child starts with the parent's
 * whole tool surface — including `orchestrate`, which recursed into ~800
 * sessions once).
 *
 * Registration is defensive by construction: {@link DispatchPresetRegistry.ensure}
 * returns a status and never throws, so nothing here can take `apply()` down.
 * The ids are tracked, because a preset somebody else registered under our id is
 * NOT ours to vouch for — its persona and filter are unknown.
 *
 * @module dsh-orchestrator/presets
 */

import { name as SCOPE_NAME } from 'dsh-eng-core/scope'

/** The scope plugin a preset row mounts (`dsh-eng-core/scope`, shared). */
export const SCOPE_PLUGIN_NAME = SCOPE_NAME

/** Row id inside one preset; stable so a roster is readable in a diff. */
export const SCOPE_ROW_ID = 'orchestrator-scope'

/** Preset ids are namespaced so they cannot collide with a deployment's own. */
export const PRESET_ID_PREFIX = 'orchestrator:'

/** Presets sort after role-guard's role presets (order base 100). */
export const PRESET_ORDER_BASE = 200

/** Longest preset description the roster renders well. */
export const DESCRIPTION_MAX = 120

/** The tool restriction a dispatched child's scope enforces. */
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
    /** Register one definition. The real one is async and resolves to a disposer. */
    register: (definition: unknown) => unknown
    /** Optional "is this id in the roster" probe (the real registry has none). */
    has?: (id: string) => boolean
}

/** A logger, narrowed to what this module uses. */
export interface PresetLogger {
    warn: (message: string, error?: unknown) => void
}

/**
 * The anti-recursion guard: the child must not be able to re-enter the pipeline.
 *
 * `orchestrate` in a child's hands means recursion — the child calls
 * `orchestrate start`, that re-enters the stage, and my own auto-dispatch spawns
 * a grandchild (measured live as ~800 child sessions from ONE entry). The stage
 * prompt says "don't call orchestrate", but prose is not a permission model, so
 * the tool is removed **structurally** here and the result is what the preset
 * row (or, on an old host, the start request) carries.
 *
 * A declared whitelist is narrowed, never dropped: dropping `allow` would turn
 * "these tools only" into "everything except orchestrate" — the exact widening
 * this function exists to prevent.
 * @param filter - the effective filter (role or deployment), already merged.
 * @returns a filter that can never contain `orchestrate`.
 */
export function withoutOrchestrate(filter: PresetFilter | undefined): PresetFilter {
    if (filter?.allow !== undefined) {
        return {
            allow: filter.allow.filter((entry) => entry !== 'orchestrate'),
            deny: [...new Set([...(filter.deny ?? []), 'orchestrate'])],
        }
    }
    return { deny: [...new Set([...(filter?.deny ?? []), 'orchestrate'])] }
}

/**
 * The preset id for one stage role.
 * @param role - the stage's role id, or `undefined` for a role-less stage.
 */
export function presetIdFor(role: string | undefined): string {
    return `${PRESET_ID_PREFIX}${role === undefined || role === '' ? 'stage' : role}`
}

/** The roster description for a dispatch preset (at most {@link DESCRIPTION_MAX}). */
function presetDescription(role: string | undefined): string {
    const text =
        role === undefined
            ? '自动派发阶段（未声明角色）的 persona 与工具限制；orchestrate 已从子作用域剔除。'
            : `自动派发阶段角色 ${role} 的 persona 与工具限制；orchestrate 已从子作用域剔除。`
    return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

/** The enforcement fingerprint of a filter (order-insensitive per side). */
function filterFingerprint(filter: PresetFilter | undefined): string {
    const allow = filter?.allow === undefined ? null : [...filter.allow].sort()
    const deny = filter?.deny === undefined ? null : [...filter.deny].sort()
    return JSON.stringify([allow, deny])
}

/** One preset definition to register. */
export interface DispatchPresetInput {
    /** The stage's role id, or `undefined` for a role-less stage. */
    role?: string
    /** The role's persona (empty = no section). */
    persona?: string
    /** The effective filter, already passed through {@link withoutOrchestrate}. */
    filter: PresetFilter
    /** Roster position (`200 + index`). */
    order: number
}

/**
 * Build one dispatch preset's definition.
 * @param input - the role, its persona and the guarded filter.
 * @returns the definition to register.
 */
export function presetDefinitionFor(input: DispatchPresetInput): PresetDefinitionLike {
    return {
        id: presetIdFor(input.role),
        name: input.role === undefined ? '自动派发：无角色的阶段' : `自动派发：角色 ${input.role}`,
        description: presetDescription(input.role),
        order: input.order,
        plugins: [
            {
                id: SCOPE_ROW_ID,
                name: SCOPE_PLUGIN_NAME,
                config: {
                    ...(input.persona === undefined || input.persona === '' ? {} : { persona: input.persona }),
                    ...(input.filter.allow === undefined ? {} : { allow: input.filter.allow }),
                    ...(input.filter.deny === undefined ? {} : { deny: input.filter.deny }),
                },
            },
        ],
    }
}

/** Why a dispatch preset cannot be used. */
export type PresetRefusalReason = 'unavailable' | 'foreign' | 'failed' | 'stale'

/** The outcome of asking for one dispatch preset. */
export interface PresetStatus {
    id: string
    ok: boolean
    reason?: PresetRefusalReason
    /** Human-readable detail (the registration error, the differing filters). */
    detail?: string
}

/** Dependencies of {@link DispatchPresetRegistry}. */
export interface DispatchPresetDeps {
    /** `ctx.get('agentPresets')`, read per call (the service may appear late). */
    presets: () => AgentPresetsLike | undefined
    logger?: PresetLogger
}

/** One registration this plugin owns. */
interface TrackedPreset {
    definition: PresetDefinitionLike
    fingerprint: string
    disposer?: unknown
}

/**
 * The dispatch presets this plugin registered, keyed by preset id.
 *
 * Tracked so a dispatch can answer "we registered it": a preset somebody else
 * declared under the same id is never used as if it were ours (we cannot vouch
 * for its persona or its tool restriction).
 */
export class DispatchPresetRegistry {
    private readonly tracked = new Map<string, TrackedPreset>()
    private readonly failures = new Map<string, string>()

    constructor(private readonly deps: DispatchPresetDeps) {}

    /** The live `agentPresets` service, or `undefined` when the host has none. */
    service(): AgentPresetsLike | undefined {
        try {
            return this.deps.presets()
        } catch {
            return undefined
        }
    }

    /**
     * Register one stage role's preset if this plugin has not registered it yet.
     *
     * Idempotent by id, and it never throws: the caller decides whether a
     * non-`ok` status becomes a refusal.
     * @param input - the role, its persona and the guarded filter.
     * @returns whether the preset is usable for a dispatch of this role.
     */
    async ensure(input: Omit<DispatchPresetInput, 'order'>): Promise<PresetStatus> {
        const id = presetIdFor(input.role)
        const service = this.service()
        if (service === undefined) return { id, ok: false, reason: 'unavailable' }
        const fingerprint = filterFingerprint(input.filter)
        const tracked = this.tracked.get(id)
        if (tracked !== undefined) {
            if (tracked.fingerprint === fingerprint) return { id, ok: true }
            // A preset is fixed at registration while role files and config
            // hot-reload. A changed filter means the child would run under the
            // OLD restriction — refuse instead of enforcing something nobody
            // declared any more.
            return {
                id,
                ok: false,
                reason: 'stale',
                detail: `注册时的工具限制 ${tracked.fingerprint}，本次派发要用的限制 ${fingerprint}`,
            }
        }
        const failed = this.failures.get(id)
        if (failed !== undefined) return { id, ok: false, reason: 'failed', detail: failed }
        if (this.looksRegisteredElsewhere(service, id)) {
            const detail = '已被其他插件注册，不是 dsh-orchestrator 注册的：无法保证它的 persona 与工具限制'
            this.failures.set(id, detail)
            this.issue(`agent preset ${id}: ${detail}`)
            return { id, ok: false, reason: 'foreign', detail }
        }
        const definition = presetDefinitionFor({ ...input, order: PRESET_ORDER_BASE + this.tracked.size })
        try {
            // The real `register` is async and settles activation later; awaiting
            // it is what makes "the child is started only after its preset is
            // mountable" true rather than hopeful.
            const disposer = await Promise.resolve(service.register(definition))
            this.tracked.set(id, { definition, fingerprint, disposer })
            return { id, ok: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            // The registry has no `has`, so a preset that already exists under our
            // id surfaces as a duplicate-id rejection: that is somebody else's
            // registration, never something we may adopt.
            const foreign = /duplicate agent preset/i.test(message)
            if (!foreign) this.failures.set(id, message)
            this.issue(`agent preset ${id} 注册失败：${message}`)
            return { id, ok: false, reason: foreign ? 'foreign' : 'failed', detail: message }
        }
    }

    /** Report one registration problem through the plugin log (the refusal carries the detail). */
    private issue(message: string): void {
        this.deps.logger?.warn(message)
    }

    /**
     * Whether somebody else already owns this id.
     *
     * The real registry has no `has`; the probe exists for a host that does, and
     * a throwing probe is "unknown", never a crash in the middle of a stage
     * entry (a duplicate registration is caught separately, by its message).
     */
    private looksRegisteredElsewhere(service: AgentPresetsLike, id: string): boolean {
        if (typeof service.has !== 'function') return false
        try {
            return service.has(id) === true
        } catch {
            return false
        }
    }

    /** Drop the tracked ids and release the host registrations they own. */
    clear(): void {
        for (const entry of this.tracked.values()) {
            const disposer = entry.disposer
            try {
                if (typeof disposer === 'function') {
                    void (disposer as () => unknown)()
                    continue
                }
                if (typeof (disposer as PromiseLike<unknown>)?.then === 'function') {
                    // Never awaited here: teardown must not block on the host.
                    void Promise.resolve(disposer as PromiseLike<unknown>)
                        .then((release) => (typeof release === 'function' ? (release as () => unknown)() : undefined))
                        .catch(() => undefined)
                }
            } catch (error) {
                this.deps.logger?.warn(`agent preset ${entry.definition.id} disposer failed:`, error)
            }
        }
        this.tracked.clear()
    }
}

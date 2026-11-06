/**
 * The scope plugin a role's Agent Preset row mounts **inside the child scope**.
 *
 * Why this exists: on harness 0.2.2-rc.1 a subagent start request no longer
 * carries `persona` or `toolFilter` (`SubagentStartRequest` has neither), so a
 * role's identity and its tool whitelist can only travel as a *composition*.
 * The host mounts the selected preset into the child's scope and this plugin
 * runs there, where `ctx.tools.restrict(...)` and
 * `ctx.systemPrompt.section(...)` act on the child's own scope. That is what
 * makes the whitelist **host-enforced**: a tool outside it is not visible to
 * the child at all, rather than merely discouraged by prompt text.
 *
 * Mounted as `dsh-role-guard/scope` (see `presets.ts`), so it must stay a
 * plain cordis plugin: `name` + `apply(ctx, config)`, no `inject` (a required
 * service that the composition does not supply would leave the row pending
 * forever), and no runtime dependency outside this file.
 *
 * Enforcement order matters: the tool restriction is applied FIRST. If it is
 * rejected (an unknown tool name, an empty filter), this plugin throws — the
 * child then fails to start instead of running with the parent's whole tool
 * surface. Absent capabilities (a composition with no `tools` or
 * `systemPrompt` service) are logged and skipped: nothing can be enforced
 * there, and refusing to load would only hide the persona.
 *
 * @module dsh-role-guard/scope
 */

/** The plugin name a preset row references (`name: dsh-role-guard/scope`). */
export const name = 'dsh-role-guard/scope'

/**
 * Stable persona section name.
 *
 * Deliberately NOT `deployment:persona-prefix` (the name the old host used for
 * a request `persona`): a scoped section shadows the global one of the same
 * name, and silently replacing the deployment's persona for every delegated
 * child is a bigger change than adding the role's own line. With
 * `DEPLOYMENT_PERSONA_PREFIX` at order 0 and ties broken by name, ours reads
 * directly after it.
 */
export const PERSONA_SECTION = 'role-guard:persona'

/** Where the persona section sorts (the deployment persona prefix is 0). */
export const PERSONA_ORDER = 0

/** Preset-row configuration (untrusted: a row is YAML someone else wrote). */
export interface ScopeConfig {
    /** The role's persona; empty/absent means "no section". */
    persona?: string
    /** Global tool names that stay visible to the child. */
    allow?: readonly string[]
    /** Global tool names removed from the child's view. */
    deny?: readonly string[]
}

/** The structural slice of the child context this plugin touches. */
export interface ScopeContextLike {
    tools?: { restrict?: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => () => void }
    systemPrompt?: { section?: (section: { name: string; order: number; text: string | (() => string) }) => () => void }
    effect?: (execute: () => (() => void) | void) => void
}

/** The filter handed to `tools.restrict`, or `undefined` when nothing is declared. */
export interface ScopeFilter {
    allow?: readonly string[]
    deny?: readonly string[]
}

/** One resolved scope configuration. */
export interface ResolvedScope {
    persona: string
    filter: ScopeFilter | undefined
    /**
     * The row declared `allow` but its entries are unusable.
     *
     * That is an EMPTY whitelist, not "no whitelist": `tools.restrict` cannot
     * express it (it rejects empty filters), so this plugin refuses to mount
     * instead of running the child with the parent's entire tool surface.
     */
    emptyAllow: boolean
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * Resolve a preset row's config into what this plugin enforces.
 * @param input - the row's `config` value (untrusted).
 * @returns the persona text, the tool filter and whether an allow list was declared-but-empty.
 */
export function resolveScopeConfig(input: unknown): ResolvedScope {
    const raw = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    const persona = typeof raw['persona'] === 'string' ? raw['persona'].trim() : ''
    const allow = stringList(raw['allow'])
    const deny = stringList(raw['deny'])
    const emptyAllow = Array.isArray(raw['allow']) && allow.length === 0
    // A filter needs at least one entry: `tools.restrict` rejects an empty one,
    // and "no entries" is exactly the case where the role declared no list.
    const filter: ScopeFilter | undefined = allow.length === 0 && deny.length === 0 ? undefined : {
        ...(allow.length === 0 ? {} : { allow }),
        ...(deny.length === 0 ? {} : { deny }),
    }
    return { persona, filter, emptyAllow }
}

function warn(message: string): void {
    // The child's scope has no logging service of its own and this plugin must
    // not acquire one: a missing capability is a warning, never a crash.
    try {
        console.warn(`[${name}] ${message}`)
    } catch {
        // a host that cannot write stderr is not a reason to fail a child
    }
}

/**
 * Apply one role's persona and tool whitelist in the calling (child) scope.
 * @param ctx - the child scope the preset is mounted into.
 * @param config - the preset row's config (untrusted).
 */
export function apply(ctx: ScopeContextLike, config: unknown = {}): void {
    const resolved = resolveScopeConfig(config)
    const disposers: (() => void)[] = []

    // 0. A declared-but-empty whitelist is a broken role, not an unrestricted
    //    one: mounting it would hand the child everything the role excluded.
    if (resolved.emptyAllow) {
        throw new Error(`[${name}] the role declared an empty tool whitelist (allow: []): refusing to mount a child without its restriction`)
    }

    // 1. Enforcement first: a whitelist that could not be applied must fail the
    //    child's start, not leave it running with the parent's tool surface.
    if (resolved.filter !== undefined) {
        const restrict = ctx.tools?.restrict
        if (typeof restrict !== 'function') {
            warn('the child scope exposes no tools.restrict: the role tool whitelist cannot be enforced there')
        } else {
            // Deliberately NOT caught: `restrict` rejects unknown tool names and
            // empty filters, and swallowing that would grant the child every
            // tool the role excluded — the exact widening this plugin exists to
            // prevent.
            disposers.push(restrict.call(ctx.tools, resolved.filter))
        }
    }

    // 2. Identity second: a persona section never widens authority, so a
    //    capability-less or throwing prompt surface only costs the persona.
    if (resolved.persona !== '') {
        const section = ctx.systemPrompt?.section
        if (typeof section !== 'function') {
            warn('the child scope exposes no systemPrompt.section: the role persona was not installed')
        } else {
            try {
                disposers.push(
                    section.call(ctx.systemPrompt, { name: PERSONA_SECTION, order: PERSONA_ORDER, text: () => resolved.persona }),
                )
            } catch (error) {
                warn(`the role persona section was refused: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }

    if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    warn(`disposer failed: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        })
    }
}

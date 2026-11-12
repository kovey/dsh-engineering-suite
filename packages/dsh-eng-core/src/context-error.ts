/**
 * The harness's "this tool call lacks the context it needs" failure, resolved
 * once per process and never required.
 *
 * 0.2.2-rc.2's `@deepseek-ai/dsh-tools` exports `ToolContextUnavailableError`
 * (`extends HarnessError`, `code = 'TOOL_CONTEXT_UNAVAILABLE'`, `name =
 * 'ToolContextUnavailableError'`): a tool body throws it when its call lacks a
 * calling agent, an injected service or an open turn, and the host classifies
 * that failure as one the MODEL CANNOT FIX by changing arguments. 0.2.2-rc.1
 * has no such export — the same refusal is a plain `Error` there (the rc.1 →
 * rc.2 findings are recorded in `docs/ARCHITECTURE.md` §5.35).
 *
 * So every gate that refuses for a missing context calls
 * {@link toolContextUnavailableError} and gets one shape on both versions:
 *
 *  - the HOST class when the installed harness exports it (probed with a
 *    dynamic `import('@deepseek-ai/dsh-tools')`);
 *  - otherwise an ordinary `Error` carrying the SAME `name` and `code` —
 *    `code`, not the message, is what a `HarnessError` consumer routes on
 *    ("route on this, never by parsing message", `@deepseek-ai/dsh-error`).
 *
 * The probe is best-effort, not a dependency: this package imports nothing from
 * `@deepseek-ai/*` at load time (that is what keeps every plugin loadable
 * against a slightly different harness build), and a standalone install may not
 * have the peer resolvable from `dsh-eng-core`'s own directory. A probe that
 * fails — no export (rc.1) or no module (peer not linked) — is the SAME answer:
 * the named fallback, never a bare `Error`.
 *
 * @module dsh-eng-core/context-error
 */

/** Stable machine-routable code of the host's `ToolContextUnavailableError`. */
export const TOOL_CONTEXT_UNAVAILABLE = 'TOOL_CONTEXT_UNAVAILABLE'

/** What the host class looks like structurally (`(message, options?) => Error`). */
type ToolErrorConstructor = new (message: string) => Error

/**
 * How the host module is obtained.
 *
 * A seam, not a test hook: the probe result is the only thing this module
 * caches, so a caller that already holds the module may supply it instead of
 * paying a second dynamic import (and a test can exercise both harness versions
 * without installing one).
 */
export type HostModuleLoader = () => Promise<unknown>

/** The constructor to use when none was resolved. */
export interface ContextErrorOptions {
    /**
     * Use this constructor instead of the probed one.
     *
     * `undefined` = "whatever the probe found"; `null` = "no host class, give me
     * the named fallback" (a caller that resolved the host itself and found no
     * export — rc.1).
     */
    hostClass?: ToolErrorConstructor | null
}

/** The fallback: same `name` and `code` as the host class, ordinary `Error` otherwise. */
class FallbackToolContextUnavailableError extends Error {
    readonly code = TOOL_CONTEXT_UNAVAILABLE

    constructor(message: string) {
        super(message)
        this.name = 'ToolContextUnavailableError'
    }
}

/** The host constructor found by a probe (sticky: a later failure keeps it). */
let hostConstructor: ToolErrorConstructor | undefined

/** The default loader: the harness package the plugins already peer-depend on. */
function defaultHostLoader(): Promise<unknown> {
    return import('@deepseek-ai/dsh-tools')
}

/**
 * Resolve the installed harness's `ToolContextUnavailableError`.
 *
 * Never throws: a missing export (0.2.2-rc.1) and an unresolvable module (a
 * standalone install without the peer linked) both report "none found". A
 * successful probe is remembered, so a caller may call this repeatedly; a
 * FAILED probe never erases a class found earlier.
 * @param load - how to obtain the host module (defaults to the real import).
 * @returns the constructor THIS probe found, or `undefined` when it found none.
 */
export async function probeToolContextUnavailableErrorHost(
    load: HostModuleLoader = defaultHostLoader,
): Promise<ToolErrorConstructor | undefined> {
    try {
        const module = (await load()) as { ToolContextUnavailableError?: unknown } | undefined
        const candidate = module?.ToolContextUnavailableError
        if (typeof candidate !== 'function') return undefined
        hostConstructor = candidate as ToolErrorConstructor
        return hostConstructor
    } catch {
        // rc.1 has no such export; an unresolvable peer module is the same case.
        return undefined
    }
}

/**
 * Build the error a gate throws when a tool call lacks required context.
 *
 * Call it SYNCHRONOUSLY from a refusal site: the probe has been running since
 * this module was loaded, and a tool call cannot happen before the plugin that
 * owns it is loaded — so the host class is normally already in hand.
 * @param message - names the tool and the missing context, plus the next step.
 * @param options - which constructor to use (defaults to the probe's result).
 * @returns the host error when available, else the named fallback.
 */
export function toolContextUnavailableError(message: string, options: ContextErrorOptions = {}): Error {
    const hostClass = options.hostClass === undefined ? hostConstructor : options.hostClass
    return hostClass === undefined || hostClass === null ? new FallbackToolContextUnavailableError(message) : new hostClass(message)
}

// Start the probe once, without awaiting it: it is a capability check, not a
// startup dependency. `void` states that deliberately — no path may block plugin
// loading on the host package being importable.
void probeToolContextUnavailableErrorHost()

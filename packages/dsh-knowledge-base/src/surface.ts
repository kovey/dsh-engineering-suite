/**
 * The two optional surfaces this plugin exposes to the rest of the process.
 *
 *  - the `knowledge-base` SERVICE (`ctx.get('knowledge-base')`): siblings —
 *    today the evidence gate refreshing the index after a delivery — call
 *    `reindex`/`search` without importing this package, and a host that did not
 *    mount this plugin simply has no service (see `service.ts`);
 *  - the IM COMMAND `/kb`: a person in an authorised chat asks the same index
 *    from their phone (see `im.ts`).
 *
 * Both are OPTIONAL and both are wired here so `apply` stays a list of steps
 * rather than a pile of try/catch blocks: every failure is a returned problem
 * string, never a thrown error, and neither surface can stop the plugin's tools
 * or the TUI command from working.
 *
 * @module dsh-knowledge-base/surface
 */

import type { KnowledgeBaseService, KnowledgeBaseServiceDeps } from './service.js'
import { provideKnowledgeBaseService } from './service.js'
import { registerImCommand, type ImRegistration } from './im.js'

/** What {@link registerKnowledgeBaseSurfaces} wired, and how to undo it. */
export interface SurfaceRegistration {
    service: KnowledgeBaseService
    /** Withdraw functions, in registration order. */
    disposers: (() => void)[]
    /** The registered IM command name (no `/`), when one was registered. */
    imCommand?: string
    /** Joined warnings (one log line per apply), when anything needs saying. */
    problem?: string
}

/**
 * Provide the service and register the IM command.
 * @param context - the host context (only `get` and `provide` are used).
 * @param deps - profile configuration, stores, logger and optional clock.
 * @returns the service, its withdraw functions and any problem worth logging.
 */
export function registerKnowledgeBaseSurfaces(
    context: { get: (name: string) => unknown; provide?: unknown },
    deps: KnowledgeBaseServiceDeps,
): SurfaceRegistration {
    const provided = provideKnowledgeBaseService(context, deps)
    // The IM handler searches through the same object the rest of the process
    // gets; registering it does not depend on the service being reached by name.
    const im: ImRegistration = registerImCommand(context, deps, provided.service)
    const disposers: (() => void)[] = []
    if (provided.dispose !== undefined) disposers.push(provided.dispose)
    if (im.dispose !== undefined) disposers.push(im.dispose)
    const problems = [provided.problem, im.problem].filter((problem): problem is string => typeof problem === 'string' && problem !== '')
    return {
        service: provided.service,
        disposers,
        ...(im.registered && im.name !== undefined ? { imCommand: im.name } : {}),
        ...(problems.length === 0 ? {} : { problem: problems.join('；') }),
    }
}

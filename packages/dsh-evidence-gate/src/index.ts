/**
 * dsh-evidence-gate — the evidence and delivery gate (docs.md §3.5).
 *
 * Responsibilities:
 *  - register `evidence_record` / `evidence_status` / `mission_complete`;
 *  - keep the evidence ledger of a mission as an append-only JSONL artifact
 *    (`<root>/missions/<id>/evidence.jsonl`), every row bound to the Git
 *    fingerprint observed at recording time;
 *  - fail closed: a missing, WARN/BLOCK, stale or unapproved delivery is
 *    refused with a Chinese checklist and the exact next tool call;
 *  - issue one immutable receipt (`receipts/<receipt-id>.json`) only after a
 *    deterministic quality-gate `PASS`;
 *  - contribute the evidence contract to the system prompt.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-evidence-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, type AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools } from './tools.js'
import { declaredCwd } from './workspace.js'

export const name = 'dsh-evidence-gate'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
    guard: (guard: (exec: never) => string | undefined) => () => void
    get: (name: string) => unknown
}

interface PromptRuntimeLike {
    section: (section: {
        name: string
        order: number
        /** Evaluated at each assembly with that assembly's `AssembleContext`. */
        text: (context?: unknown) => string
    }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    get: (name: string) => unknown
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    effect: (execute: () => (() => void) | void) => void
}

/** The slice of `AssembleContext` this plugin reads (an agent may be absent). */
interface AssembleContextLike {
    /**
     * The scope of the assembly: for an agent-scoped assembly the harness sets
     * it to the **calling agent** itself (read structurally — see
     * {@link declaredCwd}).
     */
    scope?: unknown
}

/** The calling agent's declared workspace, read off one assembly's scope. */
function assemblyCwd(context: unknown): string | undefined {
    const scope = (context as AssembleContextLike | undefined)?.scope
    return declaredCwd(scope as AgentLike | undefined)
}

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    const resolved = resolveConfig(config)
    if (!resolved.enabled) return
    const logger = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger })

        const tools = registerTools(context as never, {
            // Profile config is the ceiling; each workspace may refine the
            // checklist through its own .dsh/evidence-gate.json.
            configFor: (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger),
            stores,
        })

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Resolved per assembly: one dsh process serves several
                    // workspaces, and the section must state the checklist the
                    // CALLING agent's workspace enforces (the profile config is
                    // only the default). A prompt section must never throw:
                    // without a workspace — or on any failure — the profile
                    // text is the safe answer.
                    text: (assembly?: unknown) => {
                        try {
                            const cwd = assemblyCwd(assembly)
                            if (cwd === undefined) return sectionText(resolved)
                            return sectionText(
                                resolved,
                                resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger),
                            )
                        } catch (error) {
                            logger.warn('prompt section fell back to the profile config:', error)
                            return sectionText(resolved)
                        }
                    },
                }),
            )
        }

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    logger.warn('disposer failed:', error)
                }
            }
        })

        logger.info(
            `applied (tools: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; requireGate=${resolved.requireGate}; gateSource=${resolved.gateSource}; required=${resolved.requiredEvidenceKinds.join('+') || 'none'}; requireCleanTree=${resolved.requireCleanTree}; projectConfig=.dsh/evidence-gate.json)`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

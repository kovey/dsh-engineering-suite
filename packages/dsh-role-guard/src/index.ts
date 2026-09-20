/**
 * dsh-role-guard — the role and permission layer (docs.md §3.1).
 *
 * Responsibilities:
 *  - one Markdown file per role: persona + model route + tool whitelist +
 *    skill list (`roles/*.md`, `<workspace>/.dsh/roles/*.md`, or inline config);
 *  - `team_delegate` for the main agent to dispatch work, creating each child
 *    with the role's persona, model and a host-enforced `toolFilter` — tools
 *    outside the whitelist are **invisible** to the child, not merely refused;
 *  - a strict write / read-only split: a `mode: read` role can never hold a
 *    write tool, whatever its file claims;
 *  - the skill whitelist, enforced at *invocation* time: the child's session →
 *    role binding is recorded durably when it starts, and a monotonic
 *    `ctx.tools.guard` denies loading a skill the role did not list (the skill
 *    registry is add-only, so the catalog cannot express it — see
 *    `skill-gate.ts`);
 *  - `role_list` for discovery, and a prompt section stating the contract.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))        @deepseek-ai/dsh-tools
 *  - ctx.tools.guard((exec) => reason|undefined) @deepseek-ai/dsh-tools
 *  - ctx.get('subagents').start(provider, req)  @deepseek-ai/dsh-subagent
 *  - ctx.tools.get(name, agent)                 visibility used to prune whitelists
 *  - ctx.on('agent/disposed' | 'session/disposed')  cache cleanup only
 *  - ctx.systemPrompt.section({...})            @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)                  cordis v4 fiber teardown
 *
 * @module dsh-role-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, resolveLayout, sessionCwd, sessionIdOf } from 'dsh-eng-core'
import type { AgentLike, Layout } from 'dsh-eng-core'
import { RoleBindingStore } from './bindings.js'
import { resolveConfig } from './config.js'
import { RoleRegistryCache } from './loader.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { createSkillGuard } from './skill-gate.js'
import { registerTools, type SubagentsLike } from './tools.js'
import { createRolePlanner } from './service.js'

export const name = 'dsh-role-guard'

/** `tools` and `systemPrompt` are required; `subagents` is read reflectively. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
    get: (name: string, agent?: AgentLike) => unknown
    /** Monotonic execution guard; optional so an older runtime still loads. */
    guard?: (guard: (execution: unknown) => string | undefined) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: () => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    /** Service registry: an older runtime may not expose `provide`. */
    provide?: (name: string, value: unknown) => () => void
    get: (name: string) => unknown
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    effect: (execute: () => (() => void) | void) => void
}

/**
 * Session id carried by a disposal payload.
 *
 * `agent/disposed` emits `{ agent }`, `session/disposed` emits the session (or
 * its id), and both are scoped dispatches, so the payload shape is read
 * defensively rather than assumed.
 */
function disposedSessionId(payload: unknown): string | undefined {
    if (typeof payload === 'string') return payload === '' ? undefined : payload
    if (typeof payload !== 'object' || payload === null) return undefined
    const record = payload as { agent?: AgentLike; id?: unknown; sessionId?: unknown; session?: { id?: unknown } }
    const fromAgent = sessionIdOf(record.agent)
    if (fromAgent !== undefined) return fromAgent
    if (typeof record.id === 'string' && record.id !== '') return record.id
    if (typeof record.sessionId === 'string' && record.sessionId !== '') return record.sessionId
    const nested = record.session?.id
    return typeof nested === 'string' && nested !== '' ? nested : undefined
}

/** Register the plugin. */
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
        const roles = new RoleRegistryCache(resolved, logger)
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger })
        const layoutFor = (agent: AgentLike | undefined): Layout =>
            resolveLayout(sessionCwd(agent), resolved.layout)
        const bindings = new RoleBindingStore(layoutFor, logger)

        const tools = registerTools(context as never, {
            config: resolved,
            roles,
            stores,
            layoutFor,
            bindings,
            subagents: () => context.get('subagents') as SubagentsLike | undefined,
            visibleTool: (toolName, agent) => {
                try {
                    return context.tools.get(toolName, agent) !== undefined
                } catch {
                    return false
                }
            },
        })

        const disposers: (() => void)[] = [...tools.disposers]

        // --- service seam: plan a delegation without a model in the loop ------
        // `team_delegate` is the model-facing path; an autonomous dispatcher
        // (e.g. the orchestrator acting on stage entry) consumes the SAME
        // resolver through this service, so an auto-dispatched child cannot end
        // up with rights a delegated one would not get. Optional: a runtime
        // without `provide` simply skips it, and orchestrator config covers the
        // no-role-guard case.
        let serviceState: string
        if (typeof context.provide !== 'function') {
            serviceState = 'unavailable(no ctx.provide)'
        } else {
            try {
                const service = createRolePlanner({
                    rolesFor: (layout) => roles.for(layout),
                    layoutFor,
                    layoutForCwd: (cwd) => resolveLayout(cwd, resolved.layout),
                    visibleTool: (toolName, agent) => {
                        try {
                            return context.tools.get(toolName, agent) !== undefined
                        } catch {
                            return false
                        }
                    },
                    config: { readonlyDeny: resolved.readonlyDeny },
                    bindings,
                    logger,
                })
                disposers.push(context.provide('role-guard', service))
                serviceState = 'on'
            } catch (error) {
                serviceState = 'failed'
                logger.error('cannot provide the role-guard service:', error)
            }
        }

        // --- skill gate (invocation time; monotonic, cannot be allowed back) ---
        const skillTools = [...resolved.skillTools]
        let skillGate: string
        if (!resolved.enforceSkillWhitelist) {
            skillGate = 'off(disabled)'
        } else if (typeof context.tools.guard !== 'function') {
            skillGate = 'unavailable(no ctx.tools.guard)'
            logger.warn('the runtime exposes no ctx.tools.guard: the skill whitelist cannot be enforced')
        } else {
            try {
                disposers.push(context.tools.guard(createSkillGuard({ config: resolved, bindings, logger }) as never))
                skillGate = `on(${skillTools.join(',') || 'none'})`
            } catch (error) {
                skillGate = 'failed'
                logger.error('cannot register the skill gate:', error)
            }
        }

        // --- binding cache cleanup (the files stay: a resumed child keeps its role) ---
        const forget = (event: string): void => {
            try {
                disposers.push(
                    context.on(event, ((payload: unknown) => {
                        try {
                            bindings.forget(disposedSessionId(payload))
                        } catch (error) {
                            logger.debug('binding cache cleanup failed:', error)
                        }
                    }) as never),
                )
            } catch (error) {
                logger.warn(`cannot subscribe to ${event}:`, error)
            }
        }
        forget('agent/disposed')
        forget('session/disposed')

        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Resolved per assembly; the registry revalidates role file
                    // mtimes, so an edit shows up without restarting the session.
                    text: () => {
                        try {
                            return sectionText(resolved, roles.for(resolveLayout(process.cwd(), resolved.layout)))
                        } catch {
                            return sectionText(resolved, undefined)
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
            roles.clear()
            bindings.clear()
        })

        logger.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}; provider=${resolved.provider}; defaultRole=${resolved.defaultRole}; skillGate=${skillGate}; service=${serviceState})`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

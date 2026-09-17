/**
 * dsh-test-design-gate — the test-design gate (docs.md §3.3, §6).
 *
 * Responsibilities:
 *  - register `test_design_review` (the automated review of the specification's
 *    `## 测试设计` chapter) and `test_design_template` (the table shape);
 *  - read the **artifact on disk** as the source of truth, so the verdict is a
 *    document-based review rather than a check of the in-memory record;
 *  - persist the verdict on the mission (`testDesign.passed`), which is exactly
 *    what `dsh-spec-gate` refuses approval on;
 *  - write `test-design-review.json` / `test-design-review.md` into the mission
 *    directory, and bind a passing design to the specification as evidence;
 *  - contribute the test-design contract to the system prompt.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-test-design-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools } from './tools.js'

export const name = 'dsh-test-design-gate'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

/**
 * Structural view of `@deepseek-ai/dsh-system-prompt`'s `AssembleContext`.
 *
 * `scope` is an opaque `ScopeKey`; for an assembly requested by a session it is
 * the calling agent, whose declared workspace we read through the same
 * structural view every other part of the suite uses (`AgentLike`).
 */
interface AssembleContextLike {
    scope?: AgentLike
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (context: AssembleContextLike) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    effect: (execute: () => (() => void) | void) => void
}

/**
 * The workspace an assembly's agent declared, when it declared one.
 *
 * Deliberately not `sessionCwd(agent, process.cwd())`: a session that names no
 * workspace has no project file to read, and inventing one from the harness's
 * own directory would let an unrelated repository change this session's prompt.
 */
function declaredCwdOf(scope: AgentLike | undefined): string | undefined {
    const cwd = scope?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
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
        // Profile config is the ceiling; each workspace may refine the review
        // through its own .dsh/test-design-gate.json (a scratch repo can lower
        // `minTextLength`, a regulated one can raise it and switch `strict` on).
        const configFor = (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)

        const tools = registerTools(context, { config: resolved, configFor, stores, source: name })

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Resolved per assembly: one dsh process serves several
                    // workspaces, each with its own review policy. An unknown
                    // workspace (or a broken project file) falls back to the
                    // profile text; the section never throws, because a prompt
                    // contribution must not break a turn.
                    text: (assembly) => {
                        try {
                            const cwd = declaredCwdOf(assembly?.scope)
                            if (cwd === undefined) return sectionText(resolved)
                            return sectionText(resolved, configFor(cwd))
                        } catch (error) {
                            logger.debug('project config lookup failed:', error)
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
            `applied (tools: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; prompt=${resolved.prompt.enabled}; strict=${resolved.strict}; minTextLength=${resolved.minTextLength}; projectConfig=.dsh/test-design-gate.json)`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

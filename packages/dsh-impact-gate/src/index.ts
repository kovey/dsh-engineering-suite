/**
 * dsh-impact-gate — the change-impact plugin.
 *
 * The other gates ask "does it work" (`dsh-quality-gate`), "is it the right
 * thing" (`dsh-spec-gate`, `dsh-test-design-gate`), "can we prove it"
 * (`dsh-evidence-gate`) and "is it still maintainable" (`dsh-standards-gate`).
 * This one answers two questions the suite used to leave to the model's own
 * reading of the code, both of which are actually decidable:
 *
 *  1. **"what does this change touch?"** — the reverse import graph the metrics
 *     walker already builds, reported as a transitive dependent closure;
 *  2. **"which tests must therefore run?"** — the impacted test files, plus the
 *     ones in the same package and the ones named after the change, rendered
 *     through the command template the HOST configured.
 *
 * Responsibilities:
 *  - register `impact_analyze` / `impact_tests` / `impact_status`;
 *  - record what the analysis produced (a JSON artifact plus an `artifact`
 *    evidence row) on the mission, so a reviewer and `dsh-evidence-gate` can both
 *    read it;
 *  - refuse, loudly, when the host has not configured a test command template —
 *    a guessed runner renders a plausible command that tests nothing;
 *  - name the blind spots in every report: this is file-level reachability, not a
 *    call graph.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.get('subagents')                  @deepseek-ai/dsh-subagent (reviewDispatch only)
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-impact-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, type AgentLike, type Logger } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'
import type { SubagentsLike } from './review.js'

export const name = 'dsh-impact-gate'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assembly?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    get: (name: string) => unknown
    effect: (execute: () => (() => void) | void) => void
}

/** Register the plugin. */
export function apply(ctx: Context, config: unknown = {}): void {
    // Config problems are collected before the logger exists, then replayed.
    const problems: string[] = []
    const resolved = resolveConfig(config, (message) => problems.push(message))
    const log: Logger = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    for (const problem of problems) log.warn(`config: ${problem}`)
    if (!resolved.enabled) {
        log.info('disabled by config')
        return
    }
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const deps: ToolDeps = {
            config: resolved,
            // Profile config is the ceiling; a workspace may refine it through its
            // own .dsh/impact-gate.json (see resolveEffectiveConfig).
            configFor: (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, log),
            stores,
            subagents: () => context.get('subagents') as SubagentsLike | undefined,
            logger: log,
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) log.warn(`tools that failed to register: ${tools.failed.join(', ')}`)

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Per assembly: the model must be told THIS workspace's
                    // effective template, not the profile's default.
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            const cwd = scope?.session?.header?.cwd
                            if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                            const effective = resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
                            return sectionText(effective.config, effective.source === 'project' ? effective.file : undefined)
                        } catch {
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
                    log.warn('disposer failed:', error)
                }
            }
        })

        log.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}; base=${resolved.defaultBase}; maxDistance=${resolved.maxDistance}; ` +
                `template=${resolved.testCommandTemplate === '' ? 'NOT CONFIGURED' : resolved.testCommandTemplate}; reviewDispatch=${resolved.reviewDispatch.enabled})`,
        )
        if (resolved.testCommandTemplate === '') {
            log.warn(
                'no testCommandTemplate configured — impact_tests will refuse until the host configures one ' +
                    '(a guessed runner would render a plausible command that tests nothing)',
            )
        }
    } catch (error) {
        log.error('apply failed:', error)
    }
}

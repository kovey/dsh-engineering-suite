/**
 * dsh-spec-gate — the specification and planning gate (docs.md §3.2).
 *
 * Responsibilities:
 *  - register `spec_create` / `spec_approve` / `spec_status`;
 *  - keep the specification artifact at `.dsh/specs/<mission-id>.md`, with the
 *    structured record in `.dsh/missions/<mission-id>/mission.json`;
 *  - deny every write-class tool call while the calling session's mission has
 *    no approved specification (a monotonic `ctx.tools.guard()`, not a
 *    suggestion in the prompt);
 *  - contribute the specification contract to the system prompt.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.tools.guard((exec) => reason?)    @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.get('approval')                   @deepseek-ai/dsh-user-approval
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-spec-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createDelegationPresets, createLogger, expandHome } from 'dsh-eng-core'
import type { AgentLike, Logger } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig, type SpecGateConfig } from './config.js'
import { createWriteGuard } from './guard.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ApprovalLike } from './tools.js'
import { mountTrustRootWatch } from './trust-root-events.js'

export const name = 'dsh-spec-gate'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
    guard: (guard: (exec: never) => string | undefined) => () => void
    get: (name: string) => unknown
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assemble?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    get: (name: string) => unknown
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    effect: (execute: () => (() => void) | void) => void
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
        // The presets THIS plugin registers (the seam itself is dsh-eng-core's
        // `delegation.ts`): the drafting child's persona and read-only allow-list
        // travel through a preset mounted into the CHILD scope, because the
        // 0.2.2-rc.1 start request has no `toolFilter`/`persona` field to carry them.
        const draftingPresets = createDelegationPresets({
            presets: () => context.get('agentPresets') as never,
            logger,
        })
        // Profile config is the ceiling; each workspace may refine it through
        // its own .dsh/spec-gate.json (a scratch repo can opt out of `enforce`).
        const configFor = (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)
        // Runtime trust-root fallback: it watches `tools/result` and flips the
        // guard to refuse writes once the trust root changed outside the suite.
        // The guard seeds the baseline of every workspace before its first tool
        // runs, so "before" is a real observation and not a post-hoc guess.
        const trustRoot = mountTrustRootWatch(context as never, {
            cwd: process.cwd(),
            ...(resolved.layout.rootDir === undefined ? {} : { rootDir: resolved.layout.rootDir }),
            logger,
            interaction: () => context.get('interaction'),
        })
        const guard = createWriteGuard({
            config: resolved,
            configFor,
            stores,
            testDesignMounted: () => context.tools.get('test_design_review') !== undefined,
            trustRoot: () => trustRoot.guard(),
        })

        const tools = registerTools(context as never, {
            config: resolved,
            configFor,
            stores,
            guard,
            testDesignMounted: () => context.tools.get('test_design_review') !== undefined,
            approval: () => context.get('approval') as ApprovalLike | undefined,
            questions: () => context.get('userQuestions') as never,
            nvimTui: () => context.get('nvim-tui') as never,
            // Drafting dispatches a READ-ONLY child agent (`spec_bootstrap`);
            // every gate decision in this plugin stays deterministic.
            subagents: () => context.get('subagents') as never,
            // The presets THIS plugin registered; the drafting child's confinement
            // travels in them (it cannot travel in the start request any more).
            presets: draftingPresets,
            logger,
        })

        const disposers: (() => void)[] = [...tools.disposers]
        disposers.push(trustRoot.dispose)
        if (resolved.enforce) disposers.push(context.tools.guard(guard.guard as never))
        const promptDisposer = mountPromptSection(context, resolved, stores, logger)
        if (promptDisposer !== undefined) disposers.push(promptDisposer)

        ctx.effect(() => () => {
            // Teardown releases the presets this plugin registered, so a reload does
            // not leave rows behind that no code enforces any more.
            try {
                draftingPresets.clear()
            } catch (error) {
                logger.warn('agent preset teardown failed:', error)
            }
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    logger.warn('disposer failed:', error)
                }
            }
        })

        logger.info(
            `applied (tools: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; enforce=${resolved.enforce}; boundaries=${resolved.enforceBoundaries}; approval=${resolved.approval}; projectConfig=.dsh/spec-gate.json)`,
        )
        for (const failedTool of tools.failed) {
            logger.warn(`tool ${failedTool} failed to register: ${tools.lastError ?? 'unknown error'}`)
        }
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

/**
 * The prompt section, resolved per assembly.
 *
 * The rules the model is told must be THIS workspace's effective ones: a
 * repository with `enforce: false` must not be told that writes are refused.
 * Extracted from `apply()` so the assembly function stays within the structural
 * thresholds; the behaviour is unchanged (same fallback on any resolution error).
 * @param context - host context (`systemPrompt.section`).
 * @param resolved - profile configuration (the ceiling).
 * @param stores - mission stores, for each workspace's project overlay.
 * @param logger - diagnostics sink for a bad project file.
 * @returns the section disposer, or `undefined` when the prompt is disabled.
 */
function mountPromptSection(
    context: ContextLike,
    resolved: SpecGateConfig,
    stores: MissionStoreRegistry,
    logger: Logger,
): (() => void) | undefined {
    if (!resolved.prompt.enabled) return undefined
    return context.systemPrompt.section({
        name: PROMPT_SECTION,
        order: resolved.prompt.order,
        text: (assemble?: unknown) => {
            try {
                const scope = (assemble as { scope?: AgentLike } | undefined)?.scope
                const cwd = scope?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                const effective = resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)
                return sectionText(effective.config, effective.source === 'project' ? effective.file : undefined, cwd)
            } catch {
                return sectionText(resolved)
            }
        },
    })
}

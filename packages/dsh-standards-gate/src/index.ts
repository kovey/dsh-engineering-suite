/**
 * dsh-standards-gate — the code-standards gate.
 *
 * The other gates ask "does it work" (`dsh-quality-gate`), "is it the right
 * thing" (`dsh-spec-gate`, `dsh-test-design-gate`) and "can we prove it"
 * (`dsh-evidence-gate`). This one asks **"is it still maintainable"**: file and
 * function size, nesting depth, branch size, parameter count, exported surface,
 * module dependency direction and import cycles.
 *
 * Responsibilities:
 *  - register `standards_check` / `standards_bootstrap` / `standards_status`;
 *  - read the thresholds from the TARGET repository (`.dsh/standards.json`) —
 *    the project owns its standards, the plugin only measures;
 *  - keep a baseline ratchet (`.dsh/standards-baseline.json`): legacy debt does
 *    not block, NEW violations do, and widening the baseline needs human
 *    approval (`.dsh/**` is inside `dsh-spec-gate`'s trust root, so the model
 *    cannot simply write itself an exemption);
 *  - record a gate (`source: dsh-standards-gate`) so a delivery can require it
 *    the same way it requires a quality gate.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.get('approval')                   @deepseek-ai/dsh-user-approval
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-standards-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, loadProjectConfig, type AgentLike, type Layout } from 'dsh-eng-core'
import { resolveConfig, PROJECT_OVERRIDABLE, type StandardsGateConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ApprovalLike, type ToolDeps } from './tools.js'

export const name = 'dsh-standards-gate'

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

/** One resolved configuration plus where it came from. */
interface EffectiveConfig {
    config: StandardsGateConfig
    source: 'profile' | 'project'
    file: string
    problems: string[]
}

/**
 * Overlay a workspace's own `<repo>/.dsh/standards-gate.json` on the profile row.
 *
 * Same rule as every other plugin in this suite: the profile is the CEILING, a
 * workspace may only refine the keys it is allowed to (a repository cannot grant
 * itself a weaker `enforce` than the host, nor point the gate at another file).
 * @param host - the profile-resolved configuration.
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 * @returns the effective configuration and its provenance.
 */
export function resolveEffectiveConfig(
    host: StandardsGateConfig,
    layout: Layout,
    logger?: { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'standards-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }
    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE.includes(key)) {
            const problem = `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
            problems.push(problem)
            logger?.warn(problem)
        }
    }

    // Overlay key by key onto the HOST config, validating each value.
    //
    // Re-resolving from the profile row instead (the first version) silently
    // reset every field the overlay code forgot to copy — adding the review*
    // settings later meant any accepted project key widened the profile's
    // 60s review timeout to the plugin default of 600s. Overlaying cannot forget
    // a field, and an unusable value keeps the profile's value rather than
    // falling back to a plugin default.
    const next: StandardsGateConfig = { ...host, prompt: host.prompt }
    let applied = 0
    const takeString = (key: 'standardsFile' | 'baselineFile'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value === 'string' && value.trim() !== '') {
            next[key] = value.trim()
            applied += 1
            return
        }
        const problem = `${file.file}: ${key} 必须是非空字符串，已忽略（继续使用 profile 的值）`
        problems.push(problem)
        logger?.warn(problem)
    }
    const takePositiveInt = (key: 'maxFiles' | 'maxFileBytes'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            next[key] = Math.floor(value)
            applied += 1
            return
        }
        const problem = `${file.file}: ${key} 必须是正数，已忽略（继续使用 profile 的值）`
        problems.push(problem)
        logger?.warn(problem)
    }
    if (raw['enforce'] !== undefined) {
        const value = raw['enforce']
        if (value === 'gate' || value === 'warn' || value === 'off') {
            next.enforce = value
            applied += 1
        } else {
            const problem = `${file.file}: enforce 只能是 gate / warn / off，已忽略（继续使用 profile 的值）`
            problems.push(problem)
            logger?.warn(problem)
        }
    }
    takeString('standardsFile')
    takeString('baselineFile')
    takePositiveInt('maxFiles')
    takePositiveInt('maxFileBytes')

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

/** Register the plugin. */
export function apply(ctx: Context, config: unknown = {}): void {
    const resolved = resolveConfig(config)
    if (!resolved.enabled) return
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const deps: ToolDeps = {
            config: resolved,
            // Profile config is the ceiling; a workspace may refine it through its
            // own .dsh/standards-gate.json.
            configFor: (agent: AgentLike | undefined) => {
                const cwd = agent?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') return resolved
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log).config
            },
            stores,
            approval: () => context.get('approval') as ApprovalLike | undefined,
            subagents: () => context.get('subagents') as never,
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
            `applied (tools: ${tools.registered.join(', ') || 'none'}; enforce=${resolved.enforce}; standards=${resolved.standardsFile}; baseline=${resolved.baselineFile}; approvalForBaseline=${resolved.requireApprovalForBaseline})`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

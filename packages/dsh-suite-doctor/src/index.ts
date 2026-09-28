/**
 * dsh-suite-doctor — the runtime half of the engineering suite's self-check.
 *
 * Eleven plugins each know their own corner, and until now no single entry point
 * answered "where is this project, what is configured, what is missing": every
 * onboarding step was a manual hunt through `.dsh/*.json`. `dsh-eng-core` already
 * owns the offline half (`checkWorkspace()` / `renderDoctor()`), and
 * `scripts/doctor.sh` exposes it without a host. This plugin adds what an offline
 * script cannot see and puts both halves behind one tool:
 *
 *  - which plugins are mounted (probed with orchestrator's own mechanism:
 *    `ctx.tools.get(tool, agent)` and `ctx.get(service)`), including plugins that
 *    are mounted but no longer expose their signature tool (`partial`);
 *  - the session's mission through the mission store's API;
 *  - whether the `interaction` service can reach a human, and whether anyone is
 *    waiting for an answer — `unknown` when the service is absent, never "no
 *    channels";
 *  - the phases this suite build does not implement at all.
 *
 * Responsibilities:
 *  - register `suite_status({ missionId?, json? })` — read-only;
 *  - contribute the short prompt section that says `unknown` is not a pass;
 *  - refuse to answer without a workspace and without a real mission id
 *    (fail closed), instead of reporting on whatever directory happens to be
 *    the process's cwd.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.tools.get(name, agent)            @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.get(service)                      cordis service registry
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-suite-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome, type AgentLike } from 'dsh-eng-core'
import { effectiveProbeTimeoutMs, resolveConfig, resolveEffectiveConfig, type SuiteDoctorConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'
import type { ProbeContext } from './probe.js'

export const name = 'dsh-suite-doctor'

/** Only the two services this plugin actually touches. */
export const inject = ['tools', 'systemPrompt']

export {
    PROJECT_OVERRIDABLE_KEYS,
    HOST_ONLY_KEYS,
    SUITE_PLUGINS,
    DEFAULT_PROBE_TIMEOUT_MS,
    DEFAULT_PROBE_TIMEOUT_MS_MAX,
    resolveConfig,
    resolveEffectiveConfig,
    effectiveProbeTimeoutMs,
} from './config.js'
export { PLUGIN_SIGNATURES, PHASE_PLUGINS, CORE_PLUGINS, probePlugin, probeRuntime } from './probe.js'
export { buildReport } from './tools.js'
export { PROMPT_SECTION, sectionText } from './prompt.js'
export type { SuiteDoctorConfig } from './config.js'

interface ToolRuntimeLike {
    register: (definition: never) => () => void
    get: (name: string, scope?: unknown) => unknown
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

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    // Configuration problems (an unusable value, a clamp to the host ceiling) are
    // collected before the logger exists and flushed into it right after: a value
    // the host wrote and the plugin did not use must never be silent.
    const startupProblems: string[] = []
    const resolved = resolveConfig(config, (message) => startupProblems.push(message))
    if (!resolved.enabled) return
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    for (const problem of startupProblems) log.warn(`配置：${problem}`)
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        /** Per-workspace configuration: the profile row is the ceiling. */
        const configFor = (agent: AgentLike | undefined): SuiteDoctorConfig => {
            const cwd = agent?.session?.header?.cwd
            if (typeof cwd !== 'string' || cwd === '') return resolved
            try {
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log).config
            } catch (error) {
                log.warn(`读取项目级配置失败，使用 profile 配置：${error instanceof Error ? error.message : String(error)}`)
                return resolved
            }
        }
        const deps: ToolDeps = {
            config: resolved,
            configFor,
            stores,
            // The probes read the live host at call time: the registry view of a
            // delegated child differs from the root's.
            ctx: () => context as unknown as ProbeContext,
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
                    // The section is resolved per assembly context (the workspace
                    // of the session being assembled), never from process.cwd():
                    // a profile serves several repositories at once.
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            return sectionText(configFor(scope))
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
            `applied (tool: suite_status; expectedPlugins=${resolved.expectedPlugins.join(', ')}; ` +
                `prompt=${resolved.prompt.enabled ? `on(order ${resolved.prompt.order})` : 'off'}; ` +
                `probeTimeoutMs=${effectiveProbeTimeoutMs(resolved)}（上限 probeTimeoutMsMax=${resolved.probeTimeoutMsMax}）)`,
        )
    } catch (error) {
        log.error('apply failed:', error)
    }
}

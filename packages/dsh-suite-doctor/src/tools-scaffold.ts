/**
 * The two model-facing tools that manage configuration: `suite_init` and
 * `suite_config`.
 *
 * They are the tool twins of `/suite init` and `/suite show`, and they call the
 * same functions the command does (`planSuiteInit`, `inspectSuiteConfig`) — a
 * model and a person at the keyboard must never be told different things about
 * the same repository.
 *
 * `suite_init` writes; `suite_config` is strictly read-only. The split is the
 * point: the write path is the ONLY one that creates files, is dry-run by default,
 * never overwrites without `force`, and takes the workspace from the calling
 * agent's session (never `process.cwd()`) so a profile serving several
 * repositories cannot scaffold the wrong one.
 *
 * @module dsh-suite-doctor/scaffold-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveLayout, type AgentLike } from 'dsh-eng-core'
import { inspectSuiteConfig, renderConfigInspection } from './inspect.js'
import { planSuiteInit, renderInitPlan, type InitInput } from './scaffold.js'
import { declaredCwdOf, type ToolDeps } from './tools.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Arguments of `suite_init`. */
interface InitArgs {
    apply?: boolean
    force?: boolean
    only?: string[]
}

/** Arguments of `suite_config`. */
interface ConfigArgs {
    plugin?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

function assertNotCancelled(signal: AbortSignal | undefined, tool: string): void {
    if (signal?.aborted === true) throw new Error(`${tool} 已被取消（exec.signal 已 abort）：不给出判定，避免报告与调用方的判断脱节`)
}

const INIT_DESCRIPTION =
    "Scaffold the engineering suite's gate configuration for THIS repository (the calling agent's workspace): ten files under the layout root — spec-gate, test-design-gate, quality-gate, standards (the repository-owned structural standard), evidence-gate, coverage-gate, impact-gate, supply-chain-gate, interaction-gate, deploy-gate. DRY RUN BY DEFAULT: the result lists every file with path / action (write | skip | overwrite) / bytes and writes nothing; only apply:true writes. An existing file is SKIPPED and reported, because these files are the trust root and a scaffold must not undo reviewed thresholds; force:true is the only path that overwrites. Content is generated from the detected ecosystem (ts/js/go/py) and is deterministic, so a second apply changes no byte (idempotent). `only` restricts the run to ids/aliases/file names (quality, spec, test-design, standards, evidence, coverage, impact, supply-chain, interaction, deploy); an unknown or empty `only` is refused before anything is written. The defaults are conservative starting points — review the commands and thresholds afterwards."

const INIT_PARAMETERS = {
    apply: { type: 'boolean' as const, description: 'Write the files (default false = dry run: print the plan, write nothing).' },
    force: { type: 'boolean' as const, description: 'Overwrite files that already exist (default false: an existing file is skipped and reported, never replaced).' },
    only: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Restrict to these config ids/aliases/file names. An unknown name is refused before anything is written.',
    },
}

const CONFIG_DESCRIPTION =
    "Read-only view of every gate configuration file for THIS repository plus this plugin's own config. For each file it reports: where the effective values come from (repo file applied / profile or built-in default because the file contributes nothing / no file at all), the top-level keys present, and every problem with FILE AND KEY NAMED — unparsable JSON, an unknown top-level key (a typo the owning plugin would silently ignore), a host-only key a project may not override (the profile is the ceiling), or a path value that resolves outside the workspace. An unknown `plugin` filter is refused instead of ignored. Writes no file, records no gate and changes no mission."

const CONFIG_PARAMETERS = {
    plugin: {
        type: 'string' as const,
        description:
            'Inspect only this plugin: a scaffolded id/alias/file name (quality, spec-gate, standards, …) or suite-doctor. An unknown name is refused with the available ids.',
    },
}

/** The `suite_init` definition (a factory so `deps` is captured per host). */
function initTool(deps: ToolDeps): unknown {
    return defineTool({
        name: 'suite_init',
        description: INIT_DESCRIPTION,
        parameters: INIT_PARAMETERS,
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args: InitArgs = {} as InitArgs, exec) {
            const signal = signalOf(exec)
            assertNotCancelled(signal, 'suite_init')
            const agent = agentOf(exec)
            const cwd = declaredCwdOf(agent)
            const layout = resolveLayout(cwd, deps.configFor(agent).layout)
            const input: InitInput = { cwd, rootDir: layout.configDir, apply: args.apply === true, force: args.force === true }
            if (args.only !== undefined) input.only = args.only
            const plan = planSuiteInit(input)
            assertNotCancelled(signal, 'suite_init')
            deps.logger?.info(`suite_init: ${plan.dryRun ? 'dry-run' : 'apply'} ${plan.entries.length} 份（language=${plan.language}）`)
            return renderInitPlan(plan)
        },
    })
}

/** The `suite_config` definition. */
function configTool(deps: ToolDeps): unknown {
    return defineTool({
        name: 'suite_config',
        description: CONFIG_DESCRIPTION,
        parameters: CONFIG_PARAMETERS,
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args: ConfigArgs = {} as ConfigArgs, exec) {
            const signal = signalOf(exec)
            assertNotCancelled(signal, 'suite_config')
            const agent = agentOf(exec)
            const cwd = declaredCwdOf(agent)
            const config = deps.configFor(agent)
            const layout = resolveLayout(cwd, config.layout)
            const inspection = inspectSuiteConfig({ cwd, layout, host: config }, args.plugin === undefined ? undefined : [args.plugin])
            assertNotCancelled(signal, 'suite_config')
            for (const problem of inspection.problems) deps.logger?.warn(`suite_config: ${problem}`)
            return renderConfigInspection(inspection)
        },
    })
}

/**
 * Register `suite_init` and `suite_config`.
 * @param ctx - structural tool registry.
 * @param deps - resolved configuration and host accessors.
 * @returns the disposers, the registered names and any name that failed.
 */
export function registerScaffoldTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const definitions: { name: string; definition: unknown }[] = [
        { name: 'suite_init', definition: initTool(deps) },
        { name: 'suite_config', definition: configTool(deps) },
    ]
    for (const entry of definitions) {
        try {
            disposers.push(ctx.tools.register(entry.definition as never))
            registered.push(entry.name)
        } catch {
            failed.push(entry.name)
        }
    }
    return { disposers, registered, failed }
}

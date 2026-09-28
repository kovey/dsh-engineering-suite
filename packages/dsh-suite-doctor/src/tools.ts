/**
 * The model-facing tool surface: ONE tool, `suite_status`.
 *
 * It is the composition point of the two halves of the self-check:
 *
 *  1. `dsh-eng-core`'s `checkWorkspace()` — offline, deterministic, already
 *     tested: config shape, ledger traps, footprint;
 *  2. {@link probeRuntime} — the facts only a live host has (mounted plugins, the
 *     session's mission, reachable channels, unimplemented phases);
 *  3. `withRuntime()` — eng-core's own merge, so the verdict vocabulary, the
 *     blocker/advice split and the renderer stay single-sourced.
 *
 * **Read-only, strictly.** The tool adds no gate record, writes no file and
 * mutates no mission; it does not grant permission either (see the README's
 * limits). A status tool that changed state would be unusable at exactly the
 * moment it is needed — before a delivery — and this suite's gates are the only
 * things allowed to record verdicts.
 *
 * @module dsh-suite-doctor/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    checkWorkspace,
    renderDoctor,
    resolveLayout,
    sessionCwd,
    withRuntime,
    type AgentLike,
    type DoctorReport,
    type Logger,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { DEFAULT_PROBE_TIMEOUT_MS, type SuiteDoctorConfig } from './config.js'
import { probeRuntime, type ProbeContext } from './probe.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tool closes over. */
export interface ToolDeps {
    config: SuiteDoctorConfig
    /** Resolved per-call configuration (host row + `<repo>/.dsh/suite-doctor.json`). */
    configFor: (agent: AgentLike | undefined) => SuiteDoctorConfig
    stores: MissionStoreRegistry
    /** The live host context, read per call (`ctx.tools.get` / `ctx.get`). */
    ctx: () => ProbeContext
    logger?: Logger
}

/** Arguments of `suite_status`. */
interface StatusArgs {
    /** Report one specific mission instead of the session's own. */
    missionId?: string
    /** Machine-readable output (the merged report as JSON). */
    json?: boolean
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

/**
 * Refuse to answer a call whose caller already gave up.
 *
 * The doctor has no side effect to roll back, but a cancelled call that still
 * reports "everything is ready" is worse than no answer: the caller has moved on
 * and the verdict is now unattached to any decision.
 */
function assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new Error('suite_status 已被取消（exec.signal 已 abort）：不给出判定，避免报告与调用方的判断脱节')
    }
}

/**
 * The workspace of the calling agent, refusing an unknown one.
 *
 * `sessionCwd(agent, '')` is deliberate: the helper's default fallback is
 * `process.cwd()`, and silently reporting on whatever directory the host process
 * happens to run in is worse than refusing. A self-check that describes the
 * wrong repository is a false statement about the right one.
 */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = sessionCwd(agent, '')
    if (cwd === '') {
        throw new Error(
            '无法确定工作区：调用方 agent 没有会话目录（session.header.cwd）。suite_status 必须在知道工作区的前提下运行，' +
                '否则会把某个不相关的仓库当成被测对象。',
        )
    }
    return cwd
}

/**
 * A workspace-scoped logger, tolerating a logger without the scoping method.
 *
 * `Logger.for` is how a multi-repository profile keeps its log files apart, but
 * it is optional in the suite's own logger contract: `dsh-eng-core`'s exported
 * `silentLogger` has no `for`, so calling it unguarded threw a TypeError AFTER
 * the whole report had been built — a self-check that crashes on its last line
 * reports nothing. Losing a log line must never break a verdict.
 */
function loggerFor(logger: Logger, workspace: string): Logger {
    try {
        const scoped = typeof logger.for === 'function' ? logger.for(workspace) : undefined
        return scoped ?? logger
    } catch {
        return logger
    }
}

/**
 * Build the merged report.
 *
 * Exported for tests and for callers that want the object instead of the text.
 * @param deps - resolved configuration and host accessors.
 * @param agent - the calling agent.
 * @param args - `missionId` / `json`.
 * @returns the merged report (offline checks + runtime facts).
 */
export async function buildReport(deps: ToolDeps, agent: AgentLike | undefined, args: StatusArgs = {}): Promise<DoctorReport> {
    const cwd = declaredCwdOf(agent)
    const config = deps.configFor(agent)
    if (!config.enabled) {
        throw new Error('dsh-suite-doctor 已被宿主禁用（enabled=false）：suite_status 不会给出任何判定')
    }
    const layout = resolveLayout(cwd, config.layout)
    const offline = checkWorkspace({ cwd, layout })
    const probe = await probeRuntime({
        ctx: deps.ctx(),
        agent,
        expectedPlugins: config.expectedPlugins,
        stores: deps.stores,
        cwd,
        probeTimeoutMs: config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        ...(args.missionId === undefined || args.missionId === '' ? {} : { missionId: args.missionId }),
    })
    for (const problem of probe.problems) deps.logger?.warn(problem)
    // The runtime-only checks are merged BEFORE withRuntime() so its
    // blocker/advice recomputation sees them: a runtime-only blocker (a mounted
    // but unusable core plugin) must reach the top of the report.
    const merged = withRuntime({ ...offline, checks: [...offline.checks, ...probe.checks] }, probe.facts)
    if (deps.logger !== undefined) {
        loggerFor(deps.logger, cwd).info(
            `suite_status: ${merged.blockers.length} blocker(s), ${merged.advice.length} advice, ` +
                `${probe.facts.mountedPlugins?.length ?? 0}/${config.expectedPlugins.length} plugin(s) usable`,
        )
    }
    return merged
}

/**
 * Register `suite_status`.
 * @param ctx - structural tool registry.
 * @param deps - resolved configuration and host accessors.
 * @returns the disposers, the registered names and any name that failed.
 */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    register(
        defineTool({
            name: 'suite_status',
            description:
                'One entry point for "where are we, what is configured, what is missing" in this workspace. It runs the offline self-check (gate configs, ledger/gitignore traps, mission footprint) and merges the facts only a live host has: which suite plugins are actually mounted (and which are mounted but not exposing their signature tool), the session mission (id/status/stage/blocked/spec-approved/last gate), whether an interaction channel can reach a human and whether anyone is waiting for an answer, and which of the six phases this build does not implement. Four states: ok / partial / missing / unknown — unknown means "could not be read" and is NOT a pass. Read-only: it records no gate, writes no file and changes no mission. Run it at session start and before claiming a delivery is ready.',
            parameters: {
                missionId: {
                    type: 'string',
                    description: 'Report this mission instead of the session\'s bound one (an unknown id is refused, not ignored).',
                },
                json: {
                    type: 'boolean',
                    description: 'Return the merged report as JSON (the same checks the text report renders) instead of Chinese text.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const signal = signalOf(exec)
                assertNotCancelled(signal)
                const report = await buildReport(deps, agentOf(exec), args)
                assertNotCancelled(signal)
                if (args.json === true) return `${JSON.stringify(report, null, 2)}\n`
                return renderDoctor(report)
            },
        }),
        'suite_status',
    )

    return { disposers, registered, failed }
}

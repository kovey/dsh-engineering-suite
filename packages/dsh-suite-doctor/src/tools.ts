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
    conformanceOverview,
    resolveLayout,
    sessionCwd,
    withRuntime,
    type AgentLike,
    type ConformanceOverview,
    type DoctorReport,
    type Logger,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { effectiveProbeTimeoutMs, type SuiteDoctorConfig } from './config.js'
import { renderOperatorView } from './operator.js'
import { probeRuntime, type AttentionProbe, type ProbeContext } from './probe.js'

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
    return (await buildOperatorReport(deps, agent, args)).report
}

/**
 * Build the operator's report: the merged doctor report PLUS the attention queue.
 *
 * The two travel together because they answer two different questions ("does
 * anything need me now?" / "is the system healthy?"), and the attention fact is
 * deliberately NOT a doctor check: a queue that could not be read is a gap in
 * this report, not a defect of the workspace.
 * @param deps - resolved configuration and host accessors.
 * @param agent - the calling agent.
 * @param args - `missionId` / `json`.
 * @returns the merged report and the attention probe.
 */
export async function buildOperatorReport(
    deps: ToolDeps,
    agent: AgentLike | undefined,
    args: StatusArgs = {},
): Promise<{ report: DoctorReport; attention: AttentionProbe; conformance: ConformanceOverview }> {
    const now = Date.now()
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
        // The layout the host declared (`config.layout`): the checks that read a
        // workspace artifact must look where the suite writes it, not at a
        // hard-coded `.dsh` — a profile may relocate the ledger.
        layout,
        now,
        // The effective budget, not the raw key: a project value is clamped to the
        // host ceiling in resolveConfig/resolveEffectiveConfig, and the DEFAULT is
        // clamped here too (a host may lower the ceiling below the default).
        probeTimeoutMs: effectiveProbeTimeoutMs(config),
        ...(args.missionId === undefined || args.missionId === '' ? {} : { missionId: args.missionId }),
    })
    for (const problem of probe.problems) deps.logger?.warn(problem)
    // The runtime-only checks are merged BEFORE withRuntime() so its
    // blocker/advice recomputation sees them: a runtime-only blocker (a mounted
    // but unusable core plugin) must reach the top of the report.
    const merged = withRuntime({ ...offline, checks: [...offline.checks, ...probe.checks] }, probe.facts)
    // Question 3: how far the CURRENT (or newest) mission is from what the rules
    // allow. The explicit id wins; the session's own mission is next; the newest
    // mission is the documented fallback. Read-only, derived, deterministic.
    const conformance = conformanceOverview({
        layout,
        now,
        ...(args.missionId === undefined || args.missionId === ''
            ? merged.runtime?.mission?.id === undefined
                ? {}
                : { missionId: merged.runtime.mission.id }
            : { missionId: args.missionId }),
    })
    if (deps.logger !== undefined) {
        loggerFor(deps.logger, cwd).info(
            `suite_status: ${merged.blockers.length} blocker(s), ${merged.advice.length} advice, ` +
                `${probe.facts.mountedPlugins?.length ?? 0}/${config.expectedPlugins.length} plugin(s) usable, ` +
                `${probe.attention.attentions?.length ?? 0} attention(s), ` +
                `conformance=${conformance.mission.headline}`,
        )
    }
    return { report: merged, attention: probe.attention, conformance }
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
                'The operator view of this workspace, answering four questions IN ORDER. 1) Does anything need a person now? — the attention queue (unanswered questions that wait for a human), oldest first, bounded to 10 with "另有 N 条" when truncated, each row carrying whyYou (decision-required | result-usable), its age, and a stale badge WITH its reason (policy version changed / too old / mission ended); a queue that could not be read is stated as unknown, never as "nothing to do". 2) Is the system healthy? — the existing self-check (gate configs, ledger/gitignore traps, mission footprint, mounted plugins, the session mission, reachable channels, unimplemented phases), unchanged: one line when everything is ready, the full report otherwise. Four states: ok / partial / missing / unknown — unknown means "could not be read" and is NOT a pass. 3) How far is this delivery from what the rules allow? — the conformance overview of the current (or newest) mission: a headline state computed from five dimensions (authorization, evidence, gates, freshness, consistency) as the WORST one, one line per dimension with its reason, and a blind-spot line naming what could not be checked. It never grants permission: mission_complete still decides from gate records + receipts alone, and no gate reads this section. 4) History — a pointer to the per-mission views (spec_status / audit_report / orchestrate retro), deliberately not repeated here. Read-only: it records no gate, writes no file, changes no mission and never sweeps the attention queue. Run it at session start and before claiming a delivery is ready.',
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
                const built = await buildOperatorReport(deps, agentOf(exec), args)
                assertNotCancelled(signal)
                if (args.json === true) return `${JSON.stringify(built.report, null, 2)}\n`
                return renderOperatorView({
                    report: built.report,
                    conformance: built.conformance,
                    ...(built.attention.attentions === undefined ? {} : { attentions: built.attention.attentions }),
                    ...(built.attention.problem === undefined ? {} : { attentionProblem: built.attention.problem }),
                    ...(built.attention.fix === undefined ? {} : { attentionFix: built.attention.fix }),
                })
            },
        }),
        'suite_status',
    )

    return { disposers, registered, failed }
}

/**
 * The runtime half of the self-check: the facts an offline script cannot see.
 *
 * `dsh-eng-core`'s `checkWorkspace()` answers "what is configured" by reading
 * `.dsh/*.json`. It cannot answer four questions, and this module is the only
 * place they are answered:
 *
 *  1. **which plugins are actually mounted** — by probing the SAME two harness
 *     facts `dsh-orchestrator` uses (`ctx.tools.get(toolName, agent)` and
 *     `ctx.get(serviceName)`); there is deliberately no third path. A probe that
 *     cannot be answered counts as **not usable**, never as "probably fine";
 *  2. **where the session's mission stands** — through the mission store's own
 *     API (`resolveForAgent` / `lastGate`), never by reading `mission.json` by
 *     hand;
 *  3. **whether a human can be reached** — through the `interaction` service,
 *     when the host mounts one;
 *  4. **which phases this suite build does not implement at all** — so a future
 *     gap is reported rather than silently "ok".
 *
 * Two rules, both from the doctor's own contract:
 *  - a plugin that is mounted but does not expose its signature tool is
 *    **partial**, not `ok` — "the plugin is loaded" and "the capability works"
 *    are different facts;
 *  - a fact that could not be read is **unknown** with the reason, never an
 *    empty list pretending to be "nothing there". "No interaction service" is
 *    not "no channels".
 *
 * @module dsh-suite-doctor/probe
 */

import { SUITE_PLUGINS } from './config.js'
import {
    PHASES,
    type AgentLike,
    type CheckState,
    type DoctorCheck,
    type DoctorRuntimeFacts,
    type MissionStore,
    type MissionStoreRegistry,
    type PhaseName,
} from 'dsh-eng-core'

/** The harness extension points the probes read (structurally, like orchestrator). */
export interface ProbeContext {
    tools: { get: (name: string, scope?: unknown) => unknown }
    get: (name: string) => unknown
}

/**
 * What proves one plugin is present and usable.
 *
 * `tool` is the signature tool: the capability the rest of the suite calls. The
 * sibling `tools` and the optional `service` are MOUNT evidence — they can prove
 * a plugin's `apply()` ran even when its signature tool is missing, which is
 * exactly the difference between `partial` and `missing`.
 *
 * Tool names come from docs/PLUGIN-CONVENTIONS.md §7 and each plugin's
 * `registerTools()`; they must not be renamed here (orchestrator probes the same
 * names).
 */
export interface PluginSignature {
    /** Tool that proves the plugin's capability is registered and usable. */
    tool: string
    /** Other tools the same plugin registers (mount evidence). */
    tools?: readonly string[]
    /** Service the plugin provides, when it provides one (`role-guard` today). */
    service?: string
}

/**
 * Signature tool per plugin of the suite.
 *
 * The eleven default plugins plus the two neighbours that may or may not be part
 * of a given deployment (`deploy-gate`, `interaction-gate`): they are not in the
 * default `expectedPlugins`, but when a deployment or a project file expects one
 * of them, it must be probed rather than reported as "no probe, unknown". Their
 * absence from a profile is not an error — the interaction FACTS are read from
 * the `interaction` service either way.
 */
export const PLUGIN_SIGNATURES: Readonly<Record<string, PluginSignature>> = {
    'role-guard': { tool: 'team_delegate', tools: ['role_list'], service: 'role-guard' },
    'spec-gate': { tool: 'spec_create', tools: ['spec_approve', 'spec_amend', 'spec_status', 'spec_bootstrap'] },
    'test-design-gate': { tool: 'test_design_review', tools: ['test_design_template'] },
    'quality-gate': { tool: 'quality_gate_run', tools: ['quality_gate_status'] },
    'evidence-gate': { tool: 'evidence_status', tools: ['evidence_record', 'mission_complete'] },
    'audit-trail': { tool: 'audit_report', tools: ['audit_rewind'] },
    orchestrator: { tool: 'orchestrate' },
    'deploy-gate': { tool: 'deploy_plan', tools: ['deploy_run', 'deploy_verify', 'deploy_rollback', 'deploy_status'] },
    'interaction-gate': { tool: 'interaction_ask', tools: ['interaction_notify', 'interaction_progress', 'interaction_status'] },
    // Its own entry, so `OPTIONAL_BUNDLES` can name a probe for it. While this
    // plugin runs, `suite_status` is visible to itself, so it never shows up as a
    // gap: a plugin cannot observe its own absence.
    'suite-doctor': { tool: 'suite_status' },
    'standards-gate': { tool: 'standards_check', tools: ['standards_bootstrap', 'standards_review', 'standards_status'] },
    'impact-gate': { tool: 'impact_analyze', tools: ['impact_tests', 'impact_status'] },
    'coverage-gate': { tool: 'coverage_check', tools: ['flaky_check', 'coverage_status'] },
    'supply-chain-gate': { tool: 'secret_scan', tools: ['dependency_audit', 'supply_chain_status'] },
}

/**
 * The plugins `dsh-eng-core`'s `withRuntime()` treats as required (its own
 * `runtime.mounts` list). A per-plugin finding on one of them is `required`, so a
 * mounted-but-unusable core capability can never be silently `ok`.
 */
export const CORE_PLUGINS: readonly string[] = ['role-guard', 'spec-gate', 'test-design-gate', 'quality-gate', 'evidence-gate', 'audit-trail', 'orchestrator']

/** One bundle that completes a phase without being part of the default eleven. */
export interface OptionalBundle {
    plugin: string
    /** Phase it would complete, as a phase name (used for the check's area). */
    phase: PhaseName
    /** Phase it would complete, as the label the report shows. */
    phaseLabel: string
    /** One line on why it matters. */
    reason: string
}

/**
 * Bundles that complete a phase but are NOT part of the suite's default eleven.
 *
 * Their absence is genuinely a deployment choice — a repository that never
 * deploys does not need a deploy gate — so they are reported as ONE advice check
 * (`runtime.mounts-optional`, severity `recommended`) and never as a blocker.
 * A profile (or a project file) that puts any of them into `expectedPlugins`
 * PROMOTES it: it is then probed as an expected plugin and its absence becomes a
 * per-plugin `required` finding, because that deployment declared it needs it.
 *
 * `dsh-suite-doctor` is listed for completeness: while this plugin runs, its own
 * `suite_status` is visible in the calling scope, so its entry cannot fire — you
 * cannot observe your own absence. It would fire only in a host where the tool is
 * invisible to the caller.
 */
export const OPTIONAL_BUNDLES: readonly OptionalBundle[] = [
    {
        plugin: 'interaction-gate',
        phase: 'interact',
        phaseLabel: '交互',
        reason: '没有它，审批只能走宿主 approval 接缝：终端可用，IM/无头场景下没有统一入口',
    },
    {
        plugin: 'deploy-gate',
        phase: 'deploy',
        phaseLabel: '部署',
        reason: '没有它，部署只能靠人敲命令，且不产生部署门禁记录',
    },
    {
        plugin: 'suite-doctor',
        phase: 'plan',
        phaseLabel: '入口自检',
        reason: '没有它，会话里没有统一的"我们在哪 / 缺什么"入口，只剩离线的 scripts/doctor.sh',
    },
]

/**
 * How strict a per-plugin finding is.
 *
 * The seven core plugins are required (eng-core's own list). A plugin outside the
 * suite's default eleven is only expected because a profile or a project file
 * asked for it — that expectation is a contract, so its absence is required too;
 * only the "no probe" case stays advice, because the fix there is to give it a
 * probe rather than to install something.
 * @param plugin - the plugin id.
 * @param state - the mount verdict (used to keep an unprobeable plugin as advice).
 * @returns the severity for that plugin's check.
 */
export function severityOf(plugin: string, state: CheckState): 'required' | 'recommended' {
    if (CORE_PLUGINS.includes(plugin)) return 'required'
    if (!SUITE_PLUGINS.includes(plugin) && state !== 'unknown') return 'required'
    return 'recommended'
}

/**
 * Which plugin gives each of the six phases its gate capability.
 *
 * Used for one question only: "does THIS build implement this phase at all?".
 * A phase whose plugins are all outside `expectedPlugins` is reported as
 * not implemented (`unknown` — a fact this report cannot decide), instead of
 * looking green because nothing was checked. Today all six are covered: deploy is
 * carried by `orchestrator`'s stage gates (`deploy-go` / `deploy-verified`) and,
 * in a build that ships it, by `deploy-gate`'s own tools.
 */
export const PHASE_PLUGINS: Readonly<Record<PhaseName, readonly string[]>> = {
    plan: ['spec-gate', 'test-design-gate'],
    build: ['quality-gate', 'standards-gate', 'supply-chain-gate'],
    test: ['coverage-gate', 'impact-gate'],
    interact: ['role-guard', 'interaction-gate'],
    deliver: ['evidence-gate', 'audit-trail'],
    deploy: ['orchestrator', 'deploy-gate'],
}

/** The phase a plugin is reported under (first phase whose row claims it). */
export function phaseOf(plugin: string): PhaseName {
    for (const phase of PHASES) {
        if (PHASE_PLUGINS[phase].includes(plugin)) return phase
    }
    return 'build'
}

/** One plugin's mount verdict. */
export interface PluginMount {
    plugin: string
    /** The probe that decided it, e.g. `tool:spec_create`. */
    probe: string
    state: CheckState
    /** What was observed, in Chinese. */
    detail: string
    /** The exact next step (only for non-ok states). */
    fix?: string
}

function toolVisible(ctx: ProbeContext, name: string, agent: AgentLike | undefined): boolean {
    try {
        return ctx.tools.get(name, agent ?? undefined) != null
    } catch {
        // A scope lookup that throws is "not visible", never "maybe".
        return false
    }
}

function serviceVisible(ctx: ProbeContext, name: string): boolean {
    try {
        return ctx.get(name) != null
    } catch {
        return false
    }
}

/**
 * Probe one plugin.
 *
 * Three answers, and the middle one is the point: `ok` (the signature tool is
 * there), `partial` (the plugin is demonstrably mounted — a service or a sibling
 * tool proves `apply()` ran — but the signature tool is not registered), and
 * `missing` (no evidence at all). A plugin without a known signature is `unknown`:
 * the doctor does not guess what tool to look for.
 * @param ctx - structural host context.
 * @param plugin - the plugin id to probe.
 * @param agent - the calling agent (the tool registry is scope-aware).
 * @returns the verdict, its probe and the fix when it is not `ok`.
 */
export function probePlugin(ctx: ProbeContext, plugin: string, agent: AgentLike | undefined): PluginMount {
    const signature = PLUGIN_SIGNATURES[plugin]
    if (signature === undefined) {
        return {
            plugin,
            probe: '(没有探测器)',
            state: 'unknown',
            detail: `suite-doctor 不知道 ${plugin} 的签名工具：无法判断它是否挂载（unknown 不是通过）`,
            fix: `在 src/probe.ts 的 PLUGIN_SIGNATURES 里给 ${plugin} 补一个探测器（它注册的工具名），或把它从 config.expectedPlugins 里移除`,
        }
    }
    const probe = `tool:${signature.tool}`
    if (toolVisible(ctx, signature.tool, agent)) {
        return { plugin, probe, state: 'ok', detail: `已挂载：探测到 ${probe}` }
    }
    const evidence: string[] = []
    const siblings = (signature.tools ?? []).filter((name) => toolVisible(ctx, name, agent))
    if (siblings.length > 0) evidence.push(`同插件的工具 ${siblings.map((name) => `tool:${name}`).join('、')}`)
    if (signature.service !== undefined && serviceVisible(ctx, signature.service)) evidence.push(`服务 ${signature.service}`)
    if (evidence.length > 0) {
        return {
            plugin,
            probe,
            state: 'partial',
            detail: `已挂载但不完整：${evidence.join('、')} 在线，而签名工具 ${probe} 没有注册——该能力现在不可用`,
            fix: `重启会话让 ${plugin} 重新注册工具（注册失败会被插件自己记进日志）；仍失败时按插件包名 dsh-${plugin} 查它的日志`,
        }
    }
    return {
        plugin,
        probe,
        state: 'missing',
        detail: `未挂载：探测不到 ${probe}，也没有它的服务或其它工具`,
        fix: `把 dsh-${plugin} 加进 profile 的 dsh.profile.bundles（dsh plugin --profile <名字> add dsh-${plugin}），重启会话后重新 suite_status`,
    }
}

/** One interaction channel, structurally what `interaction_status` lists. */
export interface InteractionChannel {
    name: string
    canAsk: boolean
    canNotify: boolean
    /**
     * WHY a channel cannot ask, when the service says so (e.g. "未实现 wait()，
     * 只能推送不能收答案"). Carried through to the report: a bare boolean tells the
     * reader what to do about it much less often than the reason does.
     */
    reason?: string
}

/** One ask still waiting for a human. */
export interface PendingAsk {
    id: string
    title: string
    at: number
    ageMs: number
}

/** What the interaction service could (not) answer. */
export interface InteractionProbe {
    /** `undefined` = could not be read; the report renders that as `unknown`. */
    channels?: InteractionChannel[]
    pendingAsks?: PendingAsk[]
    /** Why the channel fact is unknown. */
    channelsProblem?: string
    /** Why the pending-ask fact is unknown. */
    pendingProblem?: string
    /** The exact next step for the pending fact, when it is unknown. */
    pendingFix?: string
    /** Channel defects the service recorded (`problems()`); never a verdict. */
    serviceProblems?: string[]
    /** Ledgers the service has observed in this process (`ledgers()`). */
    observedLedgers?: string[]
}

/**
 * The channel accessors of the interaction service, in the order we try them.
 *
 * `describeAll()` first: that is the name the interaction gate documents for the
 * doctor (`ctx.get('interaction').describeAll()`); `describe()` alone is the
 * original wording and is still accepted, because this plugin must not depend on
 * one build of a service it does not own.
 */
const CHANNEL_ACCESSORS: readonly string[] = ['describeAll', 'describe', 'channels', 'list']

/**
 * The pending-ask accessors, in the order we try them.
 *
 * `pending()` is the interaction gate's name for it; the others are accepted so a
 * differently-built channel service still answers the question instead of
 * silently degrading to `unknown`.
 */
const ASK_ACCESSORS: readonly string[] = ['pending', 'pendingAsks', 'listPending', 'asks']

/** Await a probe with a deadline; a hung channel plugin must not hang the doctor. */
async function settled<T>(value: Promise<T>, timeoutMs: number): Promise<{ value?: T; problem?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const result = await Promise.race([
            value,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`探测超时（${timeoutMs}ms）`)), timeoutMs)
                // A pending timer must not keep a session (or a test run) alive.
                timer.unref?.()
            }),
        ])
        return { value: result }
    } catch (error) {
        return { problem: error instanceof Error ? error.message : String(error) }
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** Call one accessor (function or plain value) and await it under the deadline. */
async function readAccessor(service: Record<string, unknown>, key: string, timeoutMs: number): Promise<{ value?: unknown; problem?: string }> {
    const accessor = service[key]
    if (accessor === undefined) return {}
    if (typeof accessor !== 'function') return { value: accessor }
    try {
        const called = (accessor as (this: unknown) => unknown).call(service)
        return await settled(Promise.resolve(called), timeoutMs)
    } catch (error) {
        return { problem: error instanceof Error ? error.message : String(error) }
    }
}

/** A short, safe preview of an untrusted value (never throws). */
function preview(value: unknown): string {
    try {
        const text = JSON.stringify(value)
        return text === undefined ? String(value) : text.slice(0, 120)
    } catch {
        return '(无法序列化)'
    }
}

/** Parse a channel list; unrecognised shapes are a problem, never an empty list. */
function parseChannels(value: unknown): { channels?: InteractionChannel[]; problem?: string } {
    const list = Array.isArray(value)
        ? value
        : typeof value === 'object' && value !== null && Array.isArray((value as { channels?: unknown }).channels)
          ? ((value as { channels: unknown[] }).channels as unknown[])
          : undefined
    if (list === undefined) return { problem: `返回的不是通道列表（收到 ${preview(value)}）` }
    const channels: InteractionChannel[] = []
    for (const entry of list) {
        if (typeof entry === 'string' && entry !== '') {
            channels.push({ name: entry, canAsk: false, canNotify: false })
            continue
        }
        if (typeof entry !== 'object' || entry === null) return { problem: `通道列表里有无法识别的项：${preview(entry)}` }
        const record = entry as Record<string, unknown>
        const name = typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : undefined
        if (name === undefined) return { problem: `通道项没有 name：${preview(entry)}` }
        const reason = typeof record['reason'] === 'string' && record['reason'] !== '' ? record['reason'] : undefined
        channels.push({
            name,
            canAsk: record['canAsk'] === true,
            canNotify: record['canNotify'] === true,
            ...(reason === undefined ? {} : { reason }),
        })
    }
    return { channels }
}

/** Parse a pending-ask list; entries without an id are dropped with a problem. */
function parseAsks(value: unknown, now: number): { asks?: PendingAsk[]; problem?: string } {
    if (!Array.isArray(value)) return { problem: `待回答提问的返回不是列表（收到 ${preview(value)}）` }
    const asks: PendingAsk[] = []
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        const id = typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : undefined
        if (id === undefined) continue
        const at = [record['at'], record['since'], record['createdAt'], record['askedAt']].find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)) ?? now
        const ageMs = typeof record['ageMs'] === 'number' && Number.isFinite(record['ageMs']) ? Math.max(0, Math.floor(record['ageMs'])) : Math.max(0, now - at)
        const title = typeof record['title'] === 'string' && record['title'] !== '' ? record['title'] : id
        asks.push({ id, title, at, ageMs })
    }
    return { asks }
}

/**
 * Read the `interaction` service, when the host mounts one.
 *
 * The service is NOT part of this suite's default eleven plugins and its shape
 * is not versioned here, so every accessor is optional and structural:
 * `describeAll()` (or the older `describe()`) when present, and whichever
 * pending-ask accessor exists (`pending()` in the interaction gate). Anything the
 * service does not expose is reported as a problem — the caller renders it as
 * `unknown`, because "the service is absent" and "no channels are registered"
 * are different facts and conflating them would let a workspace look reachable
 * when it is not.
 * @param ctx - structural host context.
 * @param timeoutMs - deadline for one accessor.
 * @param now - clock used to derive an ask's age.
 * @returns channels / pending asks, each `undefined` when unreadable.
 */
export async function probeInteraction(ctx: ProbeContext, timeoutMs: number, now: number): Promise<InteractionProbe> {
    let service: unknown
    try {
        service = ctx.get('interaction')
    } catch (error) {
        service = undefined
        const problem = `读取 interaction 服务失败：${error instanceof Error ? error.message : String(error)}`
        return { channelsProblem: problem, pendingProblem: problem }
    }
    if (service === null || service === undefined || typeof service !== 'object') {
        const problem = '宿主没有挂载名为 interaction 的服务：无法判断有哪些通道、是否有人在等回答（**这不等于"没有通道"**）'
        return { channelsProblem: problem, pendingProblem: problem }
    }
    const record = service as Record<string, unknown>
    const out: InteractionProbe = {}

    const channelAccessor = CHANNEL_ACCESSORS.find((key) => typeof record[key] === 'function' || record[key] !== undefined)
    if (channelAccessor === undefined) {
        out.channelsProblem = `interaction 服务没有暴露通道（试过 ${CHANNEL_ACCESSORS.map((key) => `${key}()`).join(' / ')}）：无法列出通道`
    } else {
        const read = await readAccessor(record, channelAccessor, timeoutMs)
        if (read.problem !== undefined) out.channelsProblem = `interaction.${channelAccessor}() 失败：${read.problem}`
        else {
            const parsed = parseChannels(read.value)
            if (parsed.channels === undefined) out.channelsProblem = `interaction.${channelAccessor}(): ${parsed.problem ?? '无法解析通道列表'}`
            else out.channels = parsed.channels
        }
    }

    // `pending()` reads only the ledgers this PROCESS has observed, so an empty
    // list is ambiguous: "nobody is waiting" and "this process has not read that
    // workspace's ledger yet" produce the same `[]`. `ledgers()` is what tells
    // them apart; without it the honest answer is `unknown`, not "none".
    if (typeof record['ledgers'] === 'function') {
        const read = await readAccessor(record, 'ledgers', timeoutMs)
        if (read.problem === undefined && Array.isArray(read.value)) out.observedLedgers = read.value.map((entry) => String(entry))
    }

    const askAccessor = ASK_ACCESSORS.find((key) => record[key] !== undefined)
    if (askAccessor === undefined) {
        out.pendingProblem = `interaction 服务没有暴露待回答提问（试过 ${ASK_ACCESSORS.map((key) => `${key}()`).join(' / ')}）：无法判断是否有人在等回答`
        out.pendingFix = '部署/升级一个暴露待回答提问的 interaction 服务（pending()/pendingAsks()）后重启会话；"没有等待"和"读不到"不是一回事'
    } else {
        const read = await readAccessor(record, askAccessor, timeoutMs)
        if (read.problem !== undefined) {
            out.pendingProblem = `interaction.${askAccessor}() 失败：${read.problem}`
            out.pendingFix = `恢复 interaction.${askAccessor}()（服务自己的日志里有原始错误）后重新 suite_status`
        } else {
            const parsed = parseAsks(read.value, now)
            if (parsed.asks === undefined) {
                out.pendingProblem = `interaction.${askAccessor}(): ${parsed.problem ?? '无法解析待回答提问'}`
                out.pendingFix = `修好 interaction.${askAccessor}() 的返回（应为提问数组）后重新 suite_status`
            } else if (parsed.asks.length > 0) {
                out.pendingAsks = parsed.asks
            } else if (out.observedLedgers !== undefined && out.observedLedgers.length > 0) {
                // A real "nobody is waiting": the ledgers were read and were empty.
                out.pendingAsks = []
            } else {
                out.pendingProblem =
                    `interaction.${askAccessor}() 返回空列表，而本进程还没有观察到任何交互台账（无法区分"没有等待"与"还没读到台账"）：` +
                    `${askAccessor}() 只读它见过的台账，"[]"在这里**不等于"没有人在等回答"**`
                out.pendingFix = '先在本工作区跑一次 interaction_status（或任何会碰到台账的交互工具），让本进程观察到台账后重新 suite_status'
            }
        }
    }

    // `problems()` is the service's own defect log (a channel that failed to
    // register, an unreadable ledger). Reporting it here keeps a channel defect
    // from existing only inside the interaction gate's own files.
    if (typeof record['problems'] === 'function') {
        try {
            const raw = record['problems'] as () => unknown
            const list = raw.call(service)
            if (Array.isArray(list) && list.length > 0) out.serviceProblems = list.map((entry) => String(entry))
        } catch {
            // A diagnostic that throws is not worth failing the doctor over.
        }
    }
    return out
}

/** The mission fact, as the store reports it (never a hand-read `mission.json`). */
export type MissionFacts = NonNullable<DoctorRuntimeFacts['mission']>

function missionFactsOf(store: MissionStore, id: string): MissionFacts | undefined {
    const record = store.read(id)
    if (record === undefined) return undefined
    const gate = store.lastGate(record.id)
    return {
        id: record.id,
        title: record.title,
        status: record.status,
        ...(record.stage === undefined ? {} : { stage: record.stage }),
        blocked: record.status === 'blocked',
        specApproved: record.spec?.approvedAt !== undefined,
        ...(gate === undefined
            ? {}
            : { lastGate: { id: gate.id, state: gate.state, source: gate.source, reason: gate.reason, checkedAt: gate.checkedAt } }),
    }
}

/** Options of {@link probeRuntime}. */
export interface RuntimeProbeOptions {
    /** Structural host context (`ctx.tools.get` / `ctx.get`). */
    ctx: ProbeContext
    agent: AgentLike | undefined
    /** Plugin ids this build expects (config.expectedPlugins). */
    expectedPlugins: readonly string[]
    stores: MissionStoreRegistry
    /** The calling agent's workspace (already validated by the tool). */
    cwd: string
    probeTimeoutMs: number
    /** Explicit mission id; an unknown one is refused, never silently ignored. */
    missionId?: string
    now?: number
}

/** Everything the runtime can add to an offline report. */
export interface RuntimeProbe {
    /** Merged by `withRuntime()` (mounted plugins, mission, channels, phases). */
    facts: DoctorRuntimeFacts
    /**
     * Findings `withRuntime()` cannot express: one check per expected plugin
     * (`ok` / `partial` / `missing` / `unknown`) and the `unknown` states of facts
     * the live host could not answer.
     */
    checks: DoctorCheck[]
    /** Non-fatal notes for the log (never part of the report text). */
    problems: string[]
}

/**
 * Collect every runtime fact for one workspace.
 *
 * Read-only in the strict sense: it calls probes and the mission store's read
 * methods, and nothing else. No gate record, no artifact, no mission update.
 * @param options - probes, expectations and the mission to report on.
 * @returns the facts, the extra checks and any probe problems.
 */
export async function probeRuntime(options: RuntimeProbeOptions): Promise<RuntimeProbe> {
    const now = options.now ?? Date.now()
    const checks: DoctorCheck[] = []
    const problems: string[] = []

    const mounts = options.expectedPlugins.map((plugin) => probePlugin(options.ctx, plugin, options.agent))
    for (const mount of mounts) {
        checks.push({
            id: `runtime.plugin.${mount.plugin}`,
            area: phaseOf(mount.plugin),
            state: mount.state,
            severity: severityOf(mount.plugin, mount.state),
            label: `${mount.plugin}（${mount.probe}）`,
            detail: mount.detail,
            ...(mount.state === 'ok' || mount.fix === undefined ? {} : { fix: mount.fix }),
        })
    }
    // The bundles that would complete a phase but are not part of the default
    // eleven: one advice check, never a blocker (a repository that never deploys
    // must not be blocked by the absence of a deploy gate).
    const optionalGaps: { bundle: OptionalBundle; state: string }[] = []
    for (const bundle of OPTIONAL_BUNDLES) {
        if (options.expectedPlugins.includes(bundle.plugin)) continue
        const mount = probePlugin(options.ctx, bundle.plugin, options.agent)
        if (mount.state === 'ok') continue
        const state = mount.state === 'missing' ? '未装载' : mount.state === 'partial' ? '已挂载但能力不完整' : '无法判断（没有探测器）'
        optionalGaps.push({ bundle, state })
    }
    if (optionalGaps.length > 0) {
        checks.push({
            id: 'runtime.mounts-optional',
            area: optionalGaps[0]?.bundle.phase ?? 'interact',
            state: optionalGaps.length === OPTIONAL_BUNDLES.length ? 'missing' : 'partial',
            severity: 'recommended',
            label: `可选能力未装载（${optionalGaps.length}/${OPTIONAL_BUNDLES.length}）`,
            detail: optionalGaps
                .map((gap) => `${gap.bundle.plugin}（补全"${gap.bundle.phaseLabel}"阶段；${gap.state}）：${gap.bundle.reason}`)
                .join('；'),
            fix: '按需把它加入 profile 的 dsh.profile.bundles；不需要该能力的仓库可以把这条当建议忽略（recommended，不阻断交付）。把它写进 expectedPlugins 则升级为必需项',
        })
    }
    // Only the signature tools are enumerable: the registry offers `get(name)`
    // and no listing, so "registered tools" means "the tools the doctor knows to
    // look for and found" — never a guess about the rest.
    const registeredTools: string[] = []
    for (const mount of mounts) {
        const signature = PLUGIN_SIGNATURES[mount.plugin]
        if (signature === undefined) continue
        for (const name of [signature.tool, ...(signature.tools ?? [])]) {
            if (registeredTools.includes(name)) continue
            if (toolVisible(options.ctx, name, options.agent)) registeredTools.push(name)
        }
    }
    // A plugin whose capability is not usable must not count as mounted: that
    // verdict is what withRuntime()'s required "runtime.mounts" check reports.
    const mountedPlugins = mounts.filter((mount) => mount.state === 'ok').map((mount) => mount.plugin)

    const facts: DoctorRuntimeFacts = { mountedPlugins, registeredTools }

    // ---- mission ---------------------------------------------------------
    const store = options.stores.for(options.cwd)
    if (options.missionId !== undefined && options.missionId !== '') {
        const mission = missionFactsOf(store, options.missionId)
        if (mission === undefined) {
            const known = store.list().map((record) => record.id)
            throw new Error(
                `未知 mission "${options.missionId}"：按 fail closed 拒绝（否则这份报告会看起来在说某个任务，实际什么都没查到）。` +
                    `可用 mission：${known.join('、') || '(无)'}。`,
            )
        }
        facts.mission = mission
    } else {
        // The store's own resolution: explicit id → this session's binding →
        // the delegated parent's binding. There is no "newest mission in the
        // workspace" fallback, so an unbound session honestly has no mission.
        const record = store.resolveForAgent(options.agent)
        if (record === undefined) {
            checks.push({
                id: 'runtime.mission',
                area: 'plan',
                state: 'unknown',
                severity: 'recommended',
                label: '当前 mission（运行时）',
                detail: '本会话没有绑定 mission（mission store 不回退到"工作区里最新的一个"）：任务状态、阶段与最近门禁都无法判断',
                fix: 'spec_create 或 orchestrate({ action: "start" }) 建立/绑定 mission；已有 mission 时用 suite_status({ missionId: "…" }) 指定',
            })
        } else {
            const mission = missionFactsOf(store, record.id)
            if (mission !== undefined) facts.mission = mission
        }
    }

    // ---- interaction -----------------------------------------------------
    const interaction = await probeInteraction(options.ctx, options.probeTimeoutMs, now)
    if (interaction.channels === undefined) {
        problems.push(interaction.channelsProblem ?? '无法读取交互通道')
        checks.push({
            id: 'runtime.channels',
            area: 'interact',
            state: 'unknown',
            severity: 'recommended',
            label: '交互通道（运行时）',
            detail: interaction.channelsProblem ?? '无法读取交互通道',
            fix: '部署一个注册 ctx.provide("interaction", …) 的通道插件（例如 dsh-interaction-gate）后重启会话；在此之前"能不能问人"没有答案',
        })
    } else {
        facts.channels = interaction.channels
        // `withRuntime()` reports the counts and the names; a channel's own reason
        // ("未实现 wait()，只能推送不能收答案") is what tells the reader whether the
        // gap is actionable, so it gets its own line whenever any channel gave one.
        const explained = interaction.channels.filter((channel) => !channel.canAsk && channel.reason !== undefined)
        if (explained.length > 0) {
            checks.push({
                id: 'runtime.channel-capability',
                area: 'interact',
                state: 'partial',
                severity: 'recommended',
                label: `通道能力明细（${explained.length} 个通道不能问人）`,
                detail: explained.map((channel) => `${channel.name}：${channel.reason}`).join('；'),
                fix: '要让人能回答提问，通道必须实现 wait()（只能推送的通道不构成审批面）；在通道插件里补上，或改用能问人的通道',
            })
        }
    }
    if (interaction.pendingAsks === undefined) {
        problems.push(interaction.pendingProblem ?? '无法读取待回答提问')
        checks.push({
            id: 'runtime.pending-asks',
            area: 'interact',
            state: 'unknown',
            severity: 'recommended',
            label: '待回答提问（运行时）',
            detail: interaction.pendingProblem ?? '无法读取待回答提问',
            fix: interaction.pendingFix ?? '让 interaction 服务暴露待回答提问（pending()/pendingAsks()）后重启会话；"没有等待"和"读不到"不是一回事',
        })
    } else {
        // withRuntime() only adds a check when there IS something pending, so an
        // empty list stays quiet: no pending ask is a good state, not a gap.
        facts.pendingAsks = interaction.pendingAsks
    }
    // A defect the interaction service recorded itself (a channel rejected at
    // registration, an unreadable ledger). It is reported, never judged here: the
    // service is the authority on its own channels.
    if (interaction.serviceProblems !== undefined && interaction.serviceProblems.length > 0) {
        const detail = interaction.serviceProblems.join('；')
        problems.push(`interaction 服务记录了通道缺陷：${detail}`)
        checks.push({
            id: 'runtime.interaction-problems',
            area: 'interact',
            state: 'partial',
            severity: 'recommended',
            label: '交互通道自身报出的缺陷',
            detail,
            fix: 'interaction_status 查看通道详情；通道注册失败时它的 logger 里有原始错误',
        })
    }

    // ---- phases this build does not implement ----------------------------
    const notImplemented = PHASES.filter((phase) => PHASE_PLUGINS[phase].every((plugin) => !options.expectedPlugins.includes(plugin)))
    if (notImplemented.length > 0) facts.notImplementedPhases = [...notImplemented]

    return { facts, checks, problems }
}

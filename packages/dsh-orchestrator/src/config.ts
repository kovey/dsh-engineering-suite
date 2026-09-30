/**
 * Plugin configuration (docs.md §9: 门禁的确定性来源是宿主配置，不是模型输出).
 *
 * Everything the orchestrator decides with comes from here: which stages exist,
 * which plugin each stage needs, how many attempts a stage gets and how a
 * plugin is probed. A user-supplied `stages` array is validated before it is
 * used; when it is invalid the default pipeline is used and the reasons are
 * returned to the caller (which logs them) — configuration never crashes the
 * host.
 *
 * @module dsh-orchestrator/config
 */

import type { LayoutOptions } from 'dsh-eng-core'
import {
    DEFAULT_MAX_IN_FLIGHT,
    DEFAULT_METRICS_WINDOW_DAYS,
    MAX_MAX_IN_FLIGHT,
    MAX_METRICS_WINDOW_DAYS,
} from './metrics.js'
import { DEFAULT_STAGES, resolvePipeline, type Difficulty, type Pipeline, type RouteConfig } from './pipeline.js'

/** One capability probe: the tool and/or service a plugin registers. */
export interface ProbeConfig {
    tool?: string
    service?: string
}

/** Resolved plugin configuration. */
export interface OrchestratorConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /**
     * The effective pipeline (user-supplied when valid, else the default).
     * A stage without `maxAttempts` uses {@link OrchestratorConfig.defaultMaxAttempts}.
     */
    stages: Pipeline
    /** Per-plugin probe overrides, merged over the built-in map. */
    probes: Record<string, ProbeConfig>
    /** Attempt budget for stages that do not declare their own. */
    defaultMaxAttempts: number
    /**
     * Difficulty → model route, so one pipeline can run its cheap stages on a
     * cheap model and its hard ones on a strong model.
     *
     * A deployment that declares nothing keeps today's behaviour: stages run on
     * the session's own model and the orchestrator only says which difficulty
     * they are.
     */
    routing: Partial<Record<Difficulty, RouteConfig>>
    /**
     * Autonomous dispatch: on entering a stage, hand the work to a child agent
     * instead of waiting for the model to call `team_delegate`.
     *
     * Off by default — this is the one feature in this plugin that spends tokens
     * without a model asking for it. When `enabled`, a stage is dispatched if it
     * declares `autoDispatch: true` or (absent that) if its id appears in
     * `stages`. Dispatch NEVER settles a stage: the gate still decides the
     * transition, and `autoAdvance` still governs it.
     */
    autoDispatch: {
        enabled: boolean
        /** `ctx.subagents` provider used for the child. */
        provider: string
        /** Stage ids dispatched when the stage itself says nothing. */
        stages: readonly string[]
        /** Deadline for one stage child; the stage stays entered on timeout. */
        timeoutMs: number
        /**
         * Delegation depth the child may use (`maxDepth` handed to the provider).
         *
         * Default 1: a stage worker must not fan out further children on its own
         * initiative. Found live — a child that inherited `orchestrate` re-entered
         * the stage and dispatched a grandchild, recursively, until the harness
         * depth limit (~800 sessions) turned one stage entry into a runaway.
         */
        maxDepth: number
        /**
         * Configuration problems worth reporting (GAP-10).
         *
         * A silent default here is dangerous: `stages: "implement"` (a string)
         * would dispatch the DEFAULT stage list while the host believes it named
         * its own, and `stages: []` would switch the feature off without a word.
         */
        issues: readonly string[]
        /**
         * Tool filter for the child. When the stage declares a role and
         * `dsh-role-guard` provides its service, the role's own filter wins —
         * least privilege belongs to the role, not to this list.
         */
        toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    }
    /**
     * Automatic transition budget (docs.md §4.2 自动触发下一阶段).
     *
     * Only stages with `autoAdvance: true` use it, and only the deterministic
     * turn-stop trigger does: `maxAutoAdvancesPerTurn` caps how many times one
     * session may auto-advance inside a single turn (a loop guard, not a knob
     * for correctness). `0` disables the automatic transition entirely while
     * leaving `autoAdvance` declarations in the pipeline documentation.
     */
    turnStop: {
        maxAutoAdvancesPerTurn: number
    }
    /**
     * 交付度量的默认参数（`orchestrate({ action: 'metrics' })`，见 `metrics.ts`）。
     *
     * 只有两个键，因为报告的口径必须写死在代码里：这里能调的只是"看多长的窗口"
     * 与"在飞列表显示多少条"。两个值都会被校验，不可用的值**保留宿主值并报告**
     * （`issues`），不会静默生效。
     *
     * **不做项目级覆盖**：`docs/ARCHITECTURE.md` 明确 `dsh-orchestrator` 不需要项目级
     * 配置（流水线本身就是宿主策略），因此本包的键（含这两个）都是宿主级——与既有
     * 键策略一致；要按仓库调窗口，用 `action: 'metrics'` 的 `windowDays` 入参。
     */
    metrics: {
        /** 窗口天数（默认 90）：mission 创建时间 ≥ now - windowDays·86400s。 */
        windowDays: number
        /** 在飞列表最多显示多少条（默认 20，最老的在前）。 */
        maxInFlight: number
        /** 被拒绝的覆盖及其原因（GAP-10：不可用的配置必须被报告）。 */
        issues: readonly string[]
    }
    prompt: {
        enabled: boolean
        order: number
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** One resolved configuration plus the reasons an override was rejected. */
export interface ResolvedConfig {
    config: OrchestratorConfig
    /** Non-empty when `config.stages` was rejected and replaced by the default. */
    issues: string[]
}

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the effective configuration and any pipeline-rejection reasons.
 */
/**
 * Parse the `routing` table.
 *
 * Only the three known difficulty classes are accepted, and an entry that names
 * no model is dropped with a reported issue — a "route" that resolves to nothing
 * would advertise a model the stage will not actually use.
 */
/**
 * Parse the `autoDispatch` section.
 *
 * `enabled` is deliberately false by default: dispatching a child per stage is
 * the only thing in this plugin that spends tokens on its own initiative.
 * `stages` is the fallback list for pipelines that do not annotate stages
 * themselves; an empty effective list means nothing is ever dispatched, even
 * with `enabled: true` (a configuration that does nothing is better than one
 * that surprises).
 */
/** Read a string array, ignoring non-strings (configuration is untrusted). */
function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

export function resolveAutoDispatch(value: unknown, knownStageIds?: readonly string[]): OrchestratorConfig['autoDispatch'] {
    const raw = isRecord(value) ? value : {}
    const filter = isRecord(raw['toolFilter']) ? raw['toolFilter'] : undefined
    const declared = Array.isArray(raw['stages'])
    const stages = strList(raw['stages'], ['implement'])
    const allow = filter === undefined ? undefined : strList(filter['allow'], [])
    const deny = filter === undefined ? undefined : strList(filter['deny'], [])

    // GAP-10: an unusable configuration is REPORTED, never silently replaced.
    // `stages: "implement"` used to fall back to the default list (dispatching a
    // stage the host never named) and `stages: [1,2]` silently switched the
    // feature off; both are invisible without a line in the log.
    const issues: string[] = []
    if (raw['stages'] !== undefined && !declared) issues.push('autoDispatch.stages 必须是数组（收到非数组，已忽略并回退默认 [implement]）')
    if (declared && Array.isArray(raw['stages']) && raw['stages'].length > 0 && stages.length === 0) {
        issues.push('autoDispatch.stages 里没有任何有效字符串：自动派发实际上不会发生')
    }
    if (raw['timeoutMs'] !== undefined && typeof raw['timeoutMs'] !== 'number') {
        issues.push('autoDispatch.timeoutMs 必须是数字（收到非数字，已回退默认值）')
    }
    if (knownStageIds !== undefined) {
        const unknown = stages.filter((id) => !knownStageIds.includes(id))
        if (unknown.length > 0) issues.push(`autoDispatch.stages 指向未知阶段：${unknown.join('、')}（这些阶段永远不会被派发）`)
    }
    if (filter !== undefined && !Array.isArray(filter['allow']) && filter['allow'] !== undefined) {
        issues.push('autoDispatch.toolFilter.allow 必须是数组（收到非数组，已忽略）')
    }

    const hasAllow = Array.isArray(filter?.['allow'])
    const hasFilter = hasAllow && allow !== undefined ? true : (deny?.length ?? 0) > 0
    return {
        enabled: bool(raw['enabled'], false),
        provider: str(raw['provider'], 'spawn'),
        stages,
        timeoutMs: Math.max(30_000, Math.floor(num(raw['timeoutMs'], 10 * 60_000))),
        maxDepth: Math.max(1, Math.floor(num(raw['maxDepth'], 1))),
        issues,
        ...(hasFilter
            ? {
                  toolFilter: {
                      // An explicitly empty `allow` is NOT dropped: it means "no
                      // tools", and the dispatcher refuses rather than handing the
                      // child an unfiltered surface (BUG-5).
                      ...(hasAllow ? { allow: allow ?? [] } : {}),
                      ...((deny?.length ?? 0) > 0 ? { deny } : {}),
                  },
              }
            : {}),
    }
}

export function resolveRouting(value: unknown): Partial<Record<Difficulty, RouteConfig>> {
    if (!isRecord(value)) return {}
    const out: Partial<Record<Difficulty, RouteConfig>> = {}
    for (const difficulty of ['cheap', 'standard', 'deep'] as const) {
        const entry = value[difficulty]
        if (!isRecord(entry)) continue
        const provider = typeof entry['provider'] === 'string' && entry['provider'] !== '' ? entry['provider'] : undefined
        const model = typeof entry['model'] === 'string' && entry['model'] !== '' ? entry['model'] : undefined
        if (provider === undefined && model === undefined) continue
        out[difficulty] = {
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
            ...(typeof entry['reasoningEffort'] === 'string' && entry['reasoningEffort'] !== ''
                ? { reasoningEffort: entry['reasoningEffort'] }
                : {}),
            ...(typeof entry['maxTokens'] === 'number' && Number.isFinite(entry['maxTokens']) && entry['maxTokens'] > 0
                ? { maxTokens: Math.floor(entry['maxTokens']) }
                : {}),
        }
    }
    return out
}

/**
 * The `metrics` keys this package understands. Anything else is reported, never
 * silently ignored: `windowDay` (a typo) would otherwise leave a host believing
 * it had changed the window.
 */
const METRICS_KEYS: readonly string[] = ['windowDays', 'maxInFlight']

/**
 * One integer key with a host default, validated against a range.
 *
 * 不可用的值（非数字、非整数、越界）**保留宿主值并报告**：一个"看起来生效了"的
 * 配置比一个报错的配置危险得多（GAP-10 的同一条规则）。
 */
function intInRange(value: unknown, fallback: number, range: { min: number; max: number }, key: string, issues: string[]): number {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < range.min || value > range.max) {
        issues.push(`${key} 必须是 ${range.min}–${range.max} 的整数（收到 ${JSON.stringify(value) ?? String(value)}）：已保留宿主值 ${fallback}`)
        return fallback
    }
    return value
}

/**
 * Parse the `metrics` section (交付度量的默认参数)。
 *
 * Keys are **host-level**: `docs/ARCHITECTURE.md` states the orchestrator has no
 * project-level configuration (the pipeline itself is a host policy), so adding
 * a project override here would be a new policy rather than a local refinement.
 * A repository that wants a different window passes `windowDays` to the action.
 */
export function resolveMetrics(value: unknown): OrchestratorConfig['metrics'] {
    const raw = isRecord(value) ? value : {}
    const issues: string[] = []
    if (value !== undefined && !isRecord(value)) {
        issues.push('metrics 必须是对象（收到非对象）：已整体忽略，使用宿主默认值')
    } else if (isRecord(value)) {
        const unknown = Object.keys(raw).filter((key) => !METRICS_KEYS.includes(key))
        if (unknown.length > 0) issues.push(`metrics 里有未知键：${unknown.join('、')}（可用：${METRICS_KEYS.join('、')}）——未知键被忽略`)
    }
    return {
        windowDays: intInRange(raw['windowDays'], DEFAULT_METRICS_WINDOW_DAYS, { min: 1, max: MAX_METRICS_WINDOW_DAYS }, 'metrics.windowDays', issues),
        maxInFlight: intInRange(raw['maxInFlight'], DEFAULT_MAX_IN_FLIGHT, { min: 1, max: MAX_MAX_IN_FLIGHT }, 'metrics.maxInFlight', issues),
        issues,
    }
}

export function resolveConfig(input: unknown): ResolvedConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const turnStop = isRecord(raw['turnStop']) ? raw['turnStop'] : {}
    const defaultMaxAttempts = Math.max(1, Math.floor(num(raw['defaultMaxAttempts'], 3)))
    const { stages, issues } = resolvePipeline(raw['stages'], defaultMaxAttempts)
    const probes: Record<string, ProbeConfig> = {}
    const rawProbes = raw['probes']
    if (isRecord(rawProbes)) {
        for (const [plugin, value] of Object.entries(rawProbes)) {
            if (!isRecord(value)) continue
            const tool = value['tool']
            const service = value['service']
            const probe: ProbeConfig = {
                ...(typeof tool === 'string' && tool !== '' ? { tool } : {}),
                ...(typeof service === 'string' && service !== '' ? { service } : {}),
            }
            if (probe.tool !== undefined || probe.service !== undefined) probes[plugin] = probe
        }
    }

    return {
        config: {
            enabled: bool(raw['enabled'], true),
            logFile: str(raw['logFile'], '~/.dsh/orchestrator.log'),
            ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
            layout: {
                ...(typeof raw['rootDir'] === 'string' ? { rootDir: raw['rootDir'] } : {}),
                ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
                ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
                ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
            },
            stages,
            probes,
            defaultMaxAttempts,
            routing: resolveRouting(raw['routing']),
            autoDispatch: resolveAutoDispatch(raw['autoDispatch'], stages.map((stage) => stage.id)),
            turnStop: {
                // A negative or fractional budget is nonsense for a per-turn
                // counter; 0 is meaningful (the trigger is off).
                maxAutoAdvancesPerTurn: Math.max(0, Math.floor(num(turnStop['maxAutoAdvancesPerTurn'], 2))),
            },
            metrics: resolveMetrics(raw['metrics']),
            prompt: {
                enabled: bool(prompt['enabled'], true),
                order: num(prompt['order'], 660),
            },
        },
        issues,
    }
}

export { DEFAULT_STAGES }

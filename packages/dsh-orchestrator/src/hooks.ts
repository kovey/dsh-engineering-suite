/**
 * The one automatic trigger of the orchestrator (docs.md §4.2: 自动触发下一阶段，
 * 并激活对应插件).
 *
 * The trigger is **opt-in and gate-driven**, never model-driven:
 *
 *  - it only ever fires for a stage the host declared `autoAdvance: true`;
 *  - only when that stage's gate is gated *and* currently passes — the stage is
 *    settled because a durable fact says so, not because a turn ended;
 *  - only for the mission bound to **that agent's own session** (a delegated
 *    child's turn ending must never settle its parent's stage, and "the newest
 *    mission in the workspace" is never consulted);
 *  - never while the mission is `blocked` (the circuit breaker is a latch), nor
 *    on an already-aborted signal (that turn is being discarded);
 *  - never when the transition cannot actually happen: the successor's (and the
 *    stage's own) required plugins must be mounted, so the existing
 *    refuse-don't-settle order is preserved — nothing is recorded as `passed`
 *    on the way into a stage that cannot start.
 *
 * Loop safety is the point of the bookkeeping: one stage transition per stop
 * event, at most `config.turnStop.maxAutoAdvancesPerTurn` per turn, and never
 * twice for the same `(mission, stage, attempt)` entry. Every fire is visible:
 * the stage artifact, a log line and a `steer` notice to the model.
 *
 * An auto-advance failure never breaks the turn: the whole body is awaited
 * inside a try/catch, exactly like the harness boundary expects.
 *
 * @module dsh-orchestrator/hooks
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import './sources.js'
import { sessionIdOf, type AgentLike, type MissionRecord, type MissionStore, type StageResult } from 'dsh-eng-core'
import type { Logger } from 'dsh-eng-core'
import { evaluateGate } from './gates.js'
import { isGated, roleInstruction, stageById, successorOf, type StageConfig } from './pipeline.js'
import { requiredPluginStates, type PluginProbe } from './probes.js'
import { runOrchestrate, type SequenceDeps } from './sequence.js'

/** The slice of the turn-stopping payload the hook reads (see `@deepseek-ai/dsh-agent`). */
interface TurnStoppingPayload {
    agent?: AgentLike & { steer?: (message: unknown) => void }
    turn?: number
    signal?: AbortSignal
}

/** The per-turn bookkeeping of one session. */
export interface AutoAdvanceSessionState {
    /** The turn these counters belong to (`-1` before the first event). */
    turn: number
    /** Auto-advances already performed in this turn (bounded by config). */
    count: number
    /**
     * `<missionId>:<stageId>:<attempt>` entries already attempted in this turn.
     * Marked before the attempt, so a refusal is not retried in a loop either.
     */
    readonly attempted: Set<string>
}

/** Hard bound on the per-turn key set (a pathological turn cannot grow it). */
export const MAX_TRACKED_ENTRIES = 64

/** Session state registry (one entry per live session, dropped on disposal). */
export class AutoAdvanceSessions {
    private readonly states = new Map<string, AutoAdvanceSessionState>()

    /** Read (creating) the state of one session. */
    stateFor(sessionId: string): AutoAdvanceSessionState {
        const existing = this.states.get(sessionId)
        if (existing !== undefined) return existing
        const created: AutoAdvanceSessionState = { turn: -1, count: 0, attempted: new Set() }
        this.states.set(sessionId, created)
        return created
    }

    /**
     * Roll the counters when a new turn begins.
     *
     * A new turn re-arms both the budget and the dedupe keys: the guard is
     * "never twice for the same stage entry **in one turn**", and the stage
     * result itself (`state !== 'entered'`) is what makes it permanent.
     */
    noteTurn(sessionId: string, turn: number): AutoAdvanceSessionState {
        const state = this.stateFor(sessionId)
        if (state.turn !== turn) {
            state.turn = turn
            state.count = 0
            state.attempted.clear()
        }
        return state
    }

    /** Forget a session. */
    clear(sessionId: string): void {
        this.states.delete(sessionId)
    }

    /** Forget everything (plugin teardown). */
    clearAll(): void {
        this.states.clear()
    }
}

/** Everything the trigger reads. */
export interface AutoAdvanceDeps extends SequenceDeps {
    logger: Logger
    sessions: AutoAdvanceSessions
    /**
     * Stages that opted into automatic transition, resolved once at assembly.
     * A pipeline with none makes the listener a single array-length check.
     */
    autoStages: readonly StageConfig[]
}

/** The stage ids that opted in (`autoAdvance: true`). */
export function autoAdvanceStages(stages: readonly StageConfig[]): StageConfig[] {
    return stages.filter((stage) => stage.autoAdvance === true)
}

/**
 * The workspace root the session *declared*.
 *
 * An automatic trigger must never write into a directory nobody named, so the
 * `process.cwd()` fallback the explicit tool path uses is not applied here.
 */
function declaredCwdOf(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Read a stage result without ever throwing (a corrupt artifact is "no result"). */
function stageResultOf(store: MissionStore, missionId: string, stageId: string): StageResult | undefined {
    try {
        return store.readStageResult(missionId, stageId)
    } catch {
        return undefined
    }
}

/** The plugins a stage itself + its successor require that are not mounted. */
function missingCapability(deps: AutoAdvanceDeps, probes: Record<string, PluginProbe>, stage: StageConfig, successor: StageConfig | undefined): string[] {
    const required = [...stage.requiredPlugins, ...(successor?.requiredPlugins ?? [])]
    return requiredPluginStates([...new Set(required)], probes)
        .filter((state) => !state.mounted)
        .map((state) => state.plugin)
}

/** The model-facing notice for one automatic transition. */
function noticeText(mission: MissionRecord, stage: StageConfig, detail: string, successor: StageConfig | undefined): string {
    const role = successor === undefined ? undefined : roleInstruction(successor)
    return [
        `🔄 阶段自动推进：${stage.id} → ${successor?.id ?? '(流水线结束)'}`,
        `依据：宿主声明 autoAdvance=true 且本阶段门禁已通过（${detail}）。`,
        `阶段结果：.dsh/missions/${mission.id}/stages/${stage.id}.json（state: passed）`,
        successor === undefined
            ? 'mission 已完成最后一个阶段。'
            : `当前阶段：${successor.id} —— ${successor.prompt}${role === undefined ? '' : `；${role}`}`,
        '这不是模型判断的结果：门禁事实满足时由宿主结算，无需（也无法）由模型阻止；继续按当前阶段的任务执行。',
    ].join('\n')
}

/**
 * Build the `agent/turn-stopping` listener.
 *
 * The harness awaits serial listeners on this event (the same boundary
 * `dsh-quality-gate` uses), so the work happens *before* the turn closes: the
 * model is steered with the new stage instead of being left believing it is
 * still on the old one.
 */
export function createAutoAdvanceHook(deps: AutoAdvanceDeps): (payload: TurnStoppingPayload) => Promise<void> {
    return async (payload: TurnStoppingPayload): Promise<void> => {
        try {
            await evaluateAutoAdvance(deps, payload)
        } catch (error) {
            // An automatic transition must never break the turn.
            deps.logger.error('阶段自动推进失败（已忽略，不影响本轮收尾）:', error)
        }
    }
}

async function evaluateAutoAdvance(deps: AutoAdvanceDeps, payload: TurnStoppingPayload): Promise<void> {
    // The default path: no stage opted in, so this is one array check per stop.
    if (deps.autoStages.length === 0) return
    // A cancelled turn is discarded by the harness: acting on it would move the
    // pipeline for nobody (`addEventListener('abort')` never fires late).
    if (payload.signal?.aborted === true) return
    const agent = payload.agent
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const cwd = declaredCwdOf(agent)
    if (cwd === undefined) return
    const store = deps.stores.for(cwd)
    // This stage's lines belong to THIS workspace's log file.
    const logger = deps.logger.for(cwd)
    // The mission bound to THIS session only — never the newest mission, and
    // never a delegated parent's (a child's turn stop is not the parent's
    // stage completion).
    const mission = store.active(sessionId)
    if (mission === undefined) return
    if (mission.status === 'blocked') return
    const stage = stageById(deps.config.stages, mission.stage)
    if (stage === undefined || stage.autoAdvance !== true) return
    // An ungated stage has nothing to decide on: without a deterministic fact
    // there is no basis for a system-driven transition.
    if (!isGated(stage.gate)) return
    const current = stageResultOf(store, mission.id, stage.id)
    // Only an unsettled entry of exactly this stage is auto-settleable; a
    // settled stage (or a mission pointing at a stage it never entered) is not.
    if (current === undefined || current.state !== 'entered') return

    const state = deps.sessions.noteTurn(sessionId, payload.turn ?? -1)
    const key = `${mission.id}:${stage.id}:${current.attempt}`
    if (state.attempted.has(key)) return
    if (state.count >= deps.config.turnStop.maxAutoAdvancesPerTurn) {
        // `0` is a deliberate "declared but disabled" configuration, so it is
        // reported quietly; a spent budget inside a normal turn is a warning.
        const message = `阶段 ${stage.id}（mission ${mission.id}）门禁已通过，但本 turn ${state.turn} 的自动推进次数已达上限 ${deps.config.turnStop.maxAutoAdvancesPerTurn}：不再自动推进`
        if (deps.config.turnStop.maxAutoAdvancesPerTurn <= 0) logger.debug(message)
        else logger.warn(message)
        return
    }

    const successor = successorOf(deps.config.stages, stage)
    const missing = missingCapability(deps, deps.probesFor(agent), stage, successor)
    if (missing.length > 0) {
        // Refuse-don't-settle: the same order `advance` follows. Nothing is
        // recorded and no attempt is burned — a later turn may fire once the
        // plugins are mounted.
        logger.warn(`阶段 ${stage.id} 门禁已通过，但 ${missing.join('、')} 未挂载：不自动推进（不结算、不消耗尝试次数）`)
        return
    }
    const outcome = evaluateGate(stage.gate, { store, mission, current })
    if (!outcome.ok) {
        logger.debug(`阶段 ${stage.id} 的自动推进未触发：门禁未通过（${outcome.detail}）`)
        return
    }

    // Mark before acting: even a refused attempt must not repeat in this turn.
    if (state.attempted.size >= MAX_TRACKED_ENTRIES) {
        const oldest = state.attempted.values().next().value
        if (oldest !== undefined) state.attempted.delete(oldest)
    }
    state.attempted.add(key)

    // The one code path that moves a stage is `advance`; the trigger only
    // supplies the verdict the gate already proved.
    const report = await runOrchestrate(
        deps,
        {
            action: 'advance',
            // Pinning the stage id keeps the tool-level guard in play: if the
            // mission moved between the checks and the call, `advance` refuses
            // instead of settling whatever is current.
            stageId: stage.id,
            verdict: 'PASS',
            summary: `阶段 ${stage.id} 由宿主自动推进（autoAdvance；${outcome.detail}）`,
        },
        { agent, signal: payload.signal },
    )

    const settled = stageResultOf(store, mission.id, stage.id)
    if (settled?.state !== 'passed') {
        const head = report.trim().split('\n')[0] ?? ''
        logger.warn(`阶段 ${stage.id} 的自动推进未完成：${head}`)
        return
    }
    state.count += 1
    const after = store.read(mission.id)
    logger.info(
        `阶段自动推进：${stage.id} → ${after?.stage ?? '(流水线结束)'}（mission ${mission.id}，turn ${state.turn}，本 turn 第 ${state.count}/${deps.config.turnStop.maxAutoAdvancesPerTurn} 次；${outcome.detail}）`,
    )
    if (agent?.steer === undefined) return
    agent.steer(
        createUserMessage({
            content: [{ type: 'text', text: noticeText(mission, stage, outcome.detail, successor) }],
            // Our OWN source kind (0.1.7 dropped the shared `plugin` kind): the
            // log now says which gate spoke, not "some plugin".
            source: {
                kind: 'dsh-orchestrator',
                form: 'notice',
                summary: `阶段自动推进：${stage.id} → ${successor?.id ?? '(结束)'}`.slice(0, 120),
            },
        }),
    )
}

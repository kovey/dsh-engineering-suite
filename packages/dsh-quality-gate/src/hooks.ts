/**
 * The two automatic triggers of the quality gate (docs.md §3.4):
 *
 *  1. **after a write tool** — run the `lint` commands and, when they fail,
 *     turn the tool result into a corrective error carrying the findings, so
 *     the agent fixes the problem inside the same step instead of stacking more
 *     broken edits on top (the lint feedback loop);
 *  2. **when the turn stops** — the agent is about to declare itself done, so
 *     run every configured command; a `BLOCK` steers the agent back with the
 *     failure output instead of letting the turn close. The turn-stop trigger
 *     fires on either of two facts: a write-class tool call happened
 *     (`pendingWrites`), or the workspace changed since the newest recorded
 *     gate (`gitFingerprint(...).diffDigest`) — the latter catches shell edits,
 *     external editors and `git checkout`, which no write hook can see.
 *
 * Both paths are loop-broken by design: identical failures are reported once,
 * corrective steers are capped per (session, mission) turn, and a gate only
 * runs when something actually changed. A cancelled turn runs nothing at all:
 * `addEventListener('abort')` never fires on an already-aborted signal, so the
 * abort is checked up front, and a run whose command was cancelled is treated
 * as "not a verdict" (never recorded, never clears `pendingWrites`).
 *
 * @module dsh-quality-gate/hooks
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
    gitFingerprint,
    sessionIdOf,
    type AgentLike,
    type GitFingerprint,
    type MissionRecord,
    type MissionStore,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import type { QualityGateConfig } from './config.js'
import { failureSignature, renderVerdict, runGate, selectCommands, type GateVerdict } from './gate.js'
import type { Logger } from 'dsh-eng-core'

/** The per-turn counters of one (session, mission) pair. */
export interface MissionGateCounters {
    /** Corrective steers issued in the current turn. */
    blocksThisTurn: number
    /** Post-write lint blocks issued in the current turn. */
    lintBlocksThisTurn: number
    /** Signature of the last reported post-write failure. */
    lastLintSignature?: string
}

/** Per-session gate bookkeeping. */
export interface SessionGateState {
    turn: number
    /** Successful write-class calls since the last gate run. */
    pendingWrites: number
    /**
     * Session-level fallback baseline for the fingerprint trigger, used when the
     * session carries no mission (and therefore has no durable gate record).
     */
    lastGateDigest?: string
    /** The most recent verdict of this session. */
    lastVerdict?: GateVerdict
    /** Per-mission counters: one session may carry several missions. */
    readonly missions: Map<string, MissionGateCounters>
}

/** Counter bucket for a session whose gate runs carry no mission. */
export const NO_MISSION = '(no-mission)'

/** Session state registry (bounded: sessions are dropped on disposal). */
export class GateSessions {
    private readonly states = new Map<string, SessionGateState>()
    private readonly noCwdWarned = new Set<string>()

    /** Read (creating) the state of one session. */
    stateFor(sessionId: string): SessionGateState {
        const existing = this.states.get(sessionId)
        if (existing !== undefined) return existing
        const created: SessionGateState = { turn: -1, pendingWrites: 0, missions: new Map() }
        this.states.set(sessionId, created)
        return created
    }

    /** Read (creating) the per-turn counters of one (session, mission) pair. */
    countersFor(sessionId: string, missionId: string | undefined): MissionGateCounters {
        const state = this.stateFor(sessionId)
        const key = missionId ?? NO_MISSION
        const existing = state.missions.get(key)
        if (existing !== undefined) return existing
        const created: MissionGateCounters = { blocksThisTurn: 0, lintBlocksThisTurn: 0 }
        state.missions.set(key, created)
        return created
    }

    /**
     * Roll the per-turn counters when a new turn begins. A new turn re-arms the
     * counters of every mission the session carries (fresh repair chances).
     */
    noteTurn(sessionId: string, turn: number): SessionGateState {
        const state = this.stateFor(sessionId)
        if (state.turn !== turn) {
            state.turn = turn
            state.missions.clear()
        }
        return state
    }

    /** Claim the one-time "this session declared no cwd" warning. */
    claimMissingCwdWarning(sessionId: string): boolean {
        if (this.noCwdWarned.has(sessionId)) return false
        this.noCwdWarned.add(sessionId)
        return true
    }

    /** Forget a session. */
    clear(sessionId: string): void {
        this.states.delete(sessionId)
        this.noCwdWarned.delete(sessionId)
    }

    /** Forget everything (plugin teardown). */
    clearAll(): void {
        this.states.clear()
        this.noCwdWarned.clear()
    }
}

/** Dependencies shared by both hooks. */
export interface HookDeps {
    config: QualityGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (cwd: string) => { config: QualityGateConfig; source: 'profile' | 'project'; file?: string; problems: string[] }
    sessions: GateSessions
    stores: MissionStoreRegistry
    logger: Logger
    /** `ctx.get('subprocess')`, read per run. */
    subprocess: () => unknown
}

/** The slice of a tool execution the hooks read. */
interface ToolExecLike {
    name: string
    agent?: AgentLike
    signal?: AbortSignal
}

/** The slice of a tool result the hooks read. */
interface ToolResultLike {
    isError: boolean
}

/** Post-execute decision (structural mirror of `PostToolDecision`). */
type PostDecision =
    | { kind: 'accept'; content?: unknown; additionalContexts?: unknown }
    | { kind: 'block'; feedback: { type: 'text'; text: string }[]; additionalContexts?: unknown }

/** The slice of the turn-stopping payload the hook reads. */
interface TurnStoppingPayload {
    agent?: AgentLike & { steer?: (message: unknown) => void }
    turn?: number
    signal?: AbortSignal
}

/** Why the turn-stop gate ran (reported in the log and in the steering). */
export type GateTrigger = 'pendingWrites' | 'fingerprint'

/**
 * The workspace root the session *declared*.
 *
 * An automatic trigger must never execute host commands in a directory nobody
 * named, and neither may the explicit tool: both refuse an undeclared
 * workspace (only a tool call in a named workspace runs commands).
 */
export function declaredCwdOf(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Warn once per session that the automatic triggers are off (no declared cwd). */
function warnMissingCwd(deps: HookDeps, sessionId: string, where: string): void {
    if (!deps.sessions.claimMissingCwdWarning(sessionId)) return
    deps.logger.warn(
        `${where}: 会话 ${sessionId} 没有声明 header.cwd — 本会话的自动门禁已停用（绝不在未知目录里执行宿主命令）；请宿主补充 cwd，或显式调用 quality_gate_run。`,
    )
}

/** Record the verdict (with its coverage) on the mission, when there is one. */
function recordOnMission(
    store: MissionStore,
    mission: MissionRecord | undefined,
    verdict: GateVerdict,
    fingerprint: GitFingerprint | undefined,
): string | undefined {
    if (mission === undefined) return undefined
    const record = store.recordGate(mission.id, {
        source: 'dsh-quality-gate',
        state: verdict.state,
        reason: verdict.reason,
        results: verdict.results,
        scope: verdict.scope,
        ...(fingerprint === undefined ? {} : { fingerprint }),
    })
    return record.id
}

/**
 * Decide whether the turn-stop gate has work to verify.
 *
 * `pendingWrites` is the fast trigger; the fingerprint comparison is the
 * fallback that sees changes no write hook can see. It is skipped when the
 * workspace is not a git repository (there is no digest to compare).
 * @returns the trigger that fired, or `undefined` when the gate stays idle.
 */
function decideTrigger(
    state: SessionGateState,
    store: MissionStore,
    mission: MissionRecord | undefined,
    fingerprint: GitFingerprint,
): GateTrigger | undefined {
    if (state.pendingWrites > 0) return 'pendingWrites'
    if (!fingerprint.isRepo) return undefined
    const recorded = mission === undefined ? undefined : store.lastGate(mission.id, { source: 'dsh-quality-gate' })?.fingerprint
    const baseline = recorded !== undefined && recorded.isRepo ? recorded.diffDigest : state.lastGateDigest
    // No baseline yet: the current state has never been verified, so verify it.
    if (baseline === undefined) return 'fingerprint'
    return baseline === fingerprint.diffDigest ? undefined : 'fingerprint'
}

/**
 * Build the `tools/post-execute` listener.
 * @param deps - configuration, session state and mission stores.
 * @returns the waterfall listener; it always observes cancellation-safe flow.
 */
export function createAfterWriteHook(deps: HookDeps) {
    return async (
        exec: ToolExecLike,
        result: ToolResultLike,
        next: () => Promise<PostDecision>,
    ): Promise<PostDecision> => {
        const decision = await next()
        try {
            return await evaluateAfterWrite(deps, exec, result, decision)
        } catch (error) {
            // A gate failure must never break the tool pipeline.
            deps.logger.error('post-write lint failed:', error)
            return decision
        }
    }
}

async function evaluateAfterWrite(
    deps: HookDeps,
    exec: ToolExecLike,
    result: ToolResultLike,
    decision: PostDecision,
): Promise<PostDecision> {
    const sessionId = sessionIdOf(exec.agent)
    if (sessionId === undefined) return decision
    // A session without a declared workspace keeps the PROFILE configuration —
    // never one read out of `process.cwd()` (the harness's own directory, i.e.
    // a different project); the automatic triggers are skipped for it below.
    const declaredHere = declaredCwdOf(exec.agent)
    const config = declaredHere === undefined ? deps.config : deps.configFor(declaredHere).config
    // A cancelled turn is discarded by the harness: running the command set (and
    // steering) would be work for nobody. This is a pre-check, not an abort
    // listener: a signal aborted *before* the run never fires `abort`.
    if (exec.signal?.aborted === true) return decision
    if (!config.writeTools.includes(exec.name) || result.isError) return decision
    const state = deps.sessions.stateFor(sessionId)
    // Something changed: the turn-stop gate now has work to verify.
    state.pendingWrites += 1
    if (!config.afterWrite.enabled || !config.afterWrite.blockOnFailure) return decision
    // Never override another listener's block.
    if (decision.kind !== 'accept') return decision
    if (selectCommands(config, { phase: 'lint' }).length === 0) return decision

    const cwd = declaredCwdOf(exec.agent)
    if (cwd === undefined) {
        warnMissingCwd(deps, sessionId, '写后 lint')
        return decision
    }
    const store = deps.stores.for(cwd)
    const mission = store.resolveForAgent(exec.agent)
    const counters = deps.sessions.countersFor(sessionId, mission?.id)
    if (counters.lintBlocksThisTurn >= config.afterWrite.maxPerTurn) return decision

    const verdict = await runGate(config, {
        cwd,
        phase: 'lint',
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        service: deps.subprocess(),
        excludeChangedPaths: [store.layout.rootDir],
    })
    if (verdict.aborted) {
        deps.logger.warn(`写后 lint 已取消（session ${sessionId}，影响 ${verdict.scope.selected.length} 条命令）：不记录、不反馈`)
        return decision
    }
    state.lastVerdict = verdict
    if (verdict.state === 'PASS') {
        counters.lastLintSignature = undefined
        return decision
    }
    const signature = failureSignature(verdict)
    // The same failure twice means the agent did not fix it; repeating the
    // identical block would only burn the turn.
    if (signature === counters.lastLintSignature) return decision
    counters.lastLintSignature = signature
    counters.lintBlocksThisTurn += 1
    return {
        kind: 'block',
        feedback: [
            {
                type: 'text',
                text: [
                    `⛔ 写后 lint 未通过（${exec.name} 之后自动运行）：`,
                    renderVerdict(verdict, { heading: 'lint', outputBytes: 1_500 }),
                    '',
                    '接下来：修掉上面的问题再继续；重复提交同样的失败不会被执行（同一失败只反馈一次）。',
                ].join('\n'),
            },
        ],
    }
}

/**
 * Build the `agent/turn-stopping` listener.
 *
 * This is the "agent claims completion" boundary: the gate runs there, and a
 * `BLOCK` steers the agent instead of letting the turn close.
 * @param deps - configuration, session state and mission stores.
 */
export function createTurnStopHook(deps: HookDeps) {
    return async (payload: TurnStoppingPayload): Promise<void> => {
        try {
            await evaluateTurnStop(deps, payload)
        } catch (error) {
            deps.logger.error('turn-stop gate failed:', error)
        }
    }
}

async function evaluateTurnStop(deps: HookDeps, payload: TurnStoppingPayload): Promise<void> {
    const declared = declaredCwdOf(payload.agent)
    // Same rule as above: no workspace → profile config, never a guess.
    const config = declared === undefined ? deps.config : deps.configFor(declared).config
    // Verdicts are logged per workspace: one dsh process serves many repos.
    const logger = deps.logger.for(declared)
    if (!config.turnStop.enabled) return
    const cap = config.turnStop.maxBlocksPerTurn
    // Only a negative (no-op) cap skips the gate. `0` still runs and records the
    // verdict — the gate must stay honest about the workspace — it just never
    // steers the agent back.
    if (cap < 0) {
        logger.debug(`收尾门禁已停用（trigger.turnStop.maxBlocksPerTurn=${cap}）`)
        return
    }
    // A cancelled turn: the harness discards both the steering and the verdict,
    // and an already-aborted signal never fires an `abort` listener.
    if (payload.signal?.aborted === true) return
    const agent = payload.agent
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const cwd = declaredCwdOf(agent)
    if (cwd === undefined) {
        warnMissingCwd(deps, sessionId, '收尾门禁')
        return
    }
    const store = deps.stores.for(cwd)
    const mission = store.resolveForAgent(agent)
    const state = deps.sessions.noteTurn(sessionId, payload.turn ?? -1)
    const counters = deps.sessions.countersFor(sessionId, mission?.id)
    if (config.commands.length === 0) return
    const fingerprint = gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
    const trigger = decideTrigger(state, store, mission, fingerprint)
    if (trigger === undefined) return

    const verdict = await runGate(config, {
        cwd,
        ...(payload.signal === undefined ? {} : { signal: payload.signal }),
        service: deps.subprocess(),
        fingerprint,
        excludeChangedPaths: [store.layout.rootDir],
    })
    if (verdict.aborted) {
        logger.warn(`收尾门禁已取消（session ${sessionId}）：不记录、不清零 pendingWrites、不打断`)
        return
    }
    state.pendingWrites = 0
    state.lastVerdict = verdict
    if (verdict.scope.full && fingerprint.isRepo) state.lastGateDigest = fingerprint.diffDigest
    const gateId = recordOnMission(store, mission, verdict, fingerprint)
    const coverage = verdict.scope.full ? '完整' : `部分 ${verdict.scope.selected.length}/${verdict.scope.total}`
    logger.info(
        `收尾门禁 ${verdict.state}（触发：${trigger}；覆盖：${coverage}；${gateId ?? '无 mission'}）：${verdict.reason}`,
    )
    if (verdict.state !== 'BLOCK') return
    if (cap === 0) {
        logger.warn(`收尾门禁 BLOCK 但不打断（trigger.turnStop.maxBlocksPerTurn=0 只记录不纠正，${gateId ?? '无 mission'}）`)
        return
    }
    if (counters.blocksThisTurn >= cap) {
        logger.warn(
            `session ${sessionId}: turn ${state.turn} 已打断 ${counters.blocksThisTurn}/${cap} 次 — 不再打断`,
        )
        return
    }
    if (agent?.steer === undefined) return
    counters.blocksThisTurn += 1
    agent.steer(
        createUserMessage({
            content: [
                {
                    type: 'text',
                    text: [
                        '⛔ 质量门禁未通过，本轮不能收尾。',
                        `触发：${trigger === 'pendingWrites' ? '本轮有写类工具调用' : '工作区自上次门禁后发生变化（指纹不同）'}；覆盖：${coverage}。`,
                        renderVerdict(verdict, { heading: '质量门禁', outputBytes: 3_000 }),
                        '',
                        `下一步：修复上面的失败命令后重新运行 \`quality_gate_run\`（本轮的阻断次数 ${counters.blocksThisTurn}/${cap}）。`,
                        '不要通过删除/跳过测试或放宽断言来让门禁变绿。',
                    ].join('\n'),
                },
            ],
            source: { kind: 'plugin', plugin: 'dsh-quality-gate', form: 'notice', summary: `质量门禁 BLOCK：${verdict.reason}`.slice(0, 120) },
        }),
    )
    logger.warn(`收尾门禁 BLOCK（触发：${trigger}；${gateId ?? '无 mission'}）：${verdict.reason}`)
}

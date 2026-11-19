/**
 * The `orchestrator` service (AC-001 of 强制进入 implement): advance ONE mission
 * stage by stage up to `implement`, without a model in the loop.
 *
 * Why a service and not a tool: `spec_approve` lives in another plugin and has
 * no way to drive the pipeline. The gap it closes is real — an approved spec
 * used to leave the mission in `spec-clarify`, so the role guard (which only
 * enforces a role while the mission is IN that role's stage) never applied and
 * the lead could edit the implementation directly.
 *
 * The transition itself is NOT reimplemented here: every step goes through
 * `runOrchestrate`'s `advance`, so the existing entry gates, plugin probes,
 * attempt budgets and role-delegation checks decide. This module only decides
 * when to stop and how to say why.
 *
 * Deliberate non-behaviours:
 *  - never jumps: one call settles exactly ONE stage, then the record is
 *    re-read; the next iteration re-checks the freshly entered stage's gate;
 *  - never advances past an unmet entry gate: the refusal is the result
 *    (`ok: false`), not an exception, and nothing about the mission is edited by
 *    this module;
 *  - never dispatches a child (`dispatch` is not wired into the sequence deps):
 *    reaching `implement` tells the caller to use `team_delegate`, it does not
 *    spend tokens on its own;
 *  - a failure of any kind becomes `{ ok: false, stage, message }`.
 *
 * @module dsh-orchestrator/enter-implement
 */

import type { AgentLike, ApprovalLike, MissionRecord, MissionStore, MissionStoreRegistry } from 'dsh-eng-core'
import type { OrchestratorConfig } from './config.js'
import { evaluateGate } from './gates.js'
import { isGated, stageById, type StageConfig } from './pipeline.js'
import type { PluginProbe } from './probes.js'
import { runOrchestrate, type SequenceDeps } from './sequence.js'

/** The service name other plugins read with `ctx.get('orchestrator')`. */
export const ORCHESTRATOR_SERVICE = 'orchestrator'

/** The stage the pipeline must reach before code may be written. */
export const ENTER_IMPLEMENT_TARGET = 'implement'

/**
 * How many stage settlements one call may perform.
 *
 * The default pipeline reaches `implement` from its first stage in three
 * settlements; the fourth is slack for a custom pipeline. A bound (not a loop
 * until "it worked") is what makes "no skipping" provable.
 *
 * When the host enables the split workflow the pipeline grows by two stages
 * between `spec-approve` and `implement`, so the bound is derived from the
 * pipeline length — a fixed constant would strand an approved mission at
 * `split-review` with a message about the stage order.
 */
export const ENTER_IMPLEMENT_MAX_STEPS = 4

/** The step budget of one walk: the documented bound, or enough for THIS pipeline. */
function stepBudget(stages: readonly StageConfig[]): number {
    return Math.max(ENTER_IMPLEMENT_MAX_STEPS, stages.length + 1)
}

/** The answer of {@link OrchestratorService.enterImplement}. */
export interface EnterImplementResult {
    /** `true` only when the mission is at (or past) `implement`. */
    ok: boolean
    /** The stage the mission is in after the attempt (absent = no stage). */
    stage?: string
    /** One Chinese paragraph: what happened, or what is missing and how to fix it. */
    message: string
}

/** The optional service this plugin provides. */
export interface OrchestratorService {
    /**
     * Advance one mission up to `implement`, one stage per settlement.
     * @param missionId - the mission to advance.
     * @param cwd - the workspace root the mission lives in. Omitted = the
     *   process cwd, exactly like the `orchestrate` tool's own fallback. A
     *   caller that already knows the workspace (e.g. `mission.cwd`) should pass
     *   it: the service has no calling session to read it from.
     */
    enterImplement: (missionId: string, cwd?: string) => Promise<EnterImplementResult>
}

/** What the service reads from the plugin instance. */
export interface OrchestratorServiceDeps {
    config: OrchestratorConfig
    stores: MissionStoreRegistry
    /**
     * Probe table builder. Called with `undefined` on purpose: the service has
     * no real caller session, so "is this plugin mounted in the deployment" is
     * the honest question (a synthetic agent would answer a different one).
     */
    probesFor: (agent: AgentLike | undefined) => Record<string, PluginProbe>
    /**
     * The host approval seam. Forwarded to the shared sequence so a walk that
     * reaches the split workflow can ask a human (`split-review`) instead of
     * being unable to settle the stage; absent keeps the walk's old behaviour
     * for every non-split pipeline.
     */
    approval?: () => ApprovalLike | undefined
    /** Diagnostics sink (the split-review policy read); absent = no log line. */
    log?: (message: string) => void
}

/** Build the service object registered as `orchestrator`. */
export function createOrchestratorService(deps: OrchestratorServiceDeps): OrchestratorService {
    const sequence: SequenceDeps = {
        config: deps.config,
        stores: deps.stores,
        probesFor: deps.probesFor,
        ...(deps.approval === undefined ? {} : { approval: deps.approval }),
        ...(deps.log === undefined ? {} : { log: deps.log }),
    }
    return { enterImplement: (missionId, cwd) => safelyEnter(sequence, missionId, cwd ?? process.cwd()) }
}

/**
 * Run one walk; a failure is a result, not a throw.
 *
 * The caller (`spec_approve`) makes this a best-effort seam, so an exception
 * here would be a crash in an unrelated feature. Converting it to `ok: false`
 * keeps the "approval never fails because of the service" rule local.
 */
async function safelyEnter(sequence: SequenceDeps, missionId: string, cwd: string): Promise<EnterImplementResult> {
    try {
        return await enterImplement(sequence, missionId, cwd)
    } catch (error) {
        return { ok: false, message: `enterImplement 执行失败（${(error as Error).message}）：mission ${missionId} 的阶段未被改动。` }
    }
}

/**
 * Walk the pipeline from the mission's current stage up to `implement`.
 * @param sequence - the same deps the `orchestrate` tool uses (no dispatch).
 * @param missionId - mission to advance.
 * @param cwd - workspace root.
 */
async function enterImplement(sequence: SequenceDeps, missionId: string, cwd: string): Promise<EnterImplementResult> {
    const store = sequence.stores.for(cwd)
    const mission = store.read(missionId)
    if (mission === undefined) {
        return { ok: false, message: `mission ${missionId} 不在工作区 ${cwd} 里（没有 mission.json）：请确认传入的 workspace 与 mission.cwd 一致。` }
    }
    const target = stageById(sequence.config.stages, ENTER_IMPLEMENT_TARGET)
    if (target === undefined) {
        return {
            ok: false,
            ...(mission.stage === undefined ? {} : { stage: mission.stage }),
            message: `当前流水线没有 ${ENTER_IMPLEMENT_TARGET} 阶段（config.stages: ${sequence.config.stages.map((stage) => stage.id).join(' → ') || '(空)'}）：无法进入 implement。`,
        }
    }
    const budget = stepBudget(sequence.config.stages)
    for (let step = 0; step < budget; step += 1) {
        const latest = store.read(missionId) ?? mission
        const stage = stageById(sequence.config.stages, latest.stage)
        if (stage === undefined) return notInPipeline(latest, cwd)
        if (reached(sequence.config.stages, stage, target)) {
            return { ok: true, stage: stage.id, message: `mission ${missionId} 已在阶段 ${stage.id}（无需推进）。` }
        }
        const blocked = entryBlocked(sequence, store, latest, stage)
        if (blocked !== undefined) return stopped(latest, stage, blocked)
        const report = await runOrchestrate(
            sequence,
            { action: 'advance', missionId, summary: 'spec_approve 后自动推进（enterImplement）' },
            { agent: serviceAgent(cwd) },
        )
        const after = store.read(missionId)
        if (after !== undefined && after.stage !== stage.id) continue
        return { ok: false, ...(after?.stage === undefined ? {} : { stage: after.stage }), message: failureMessage(report) }
    }
    const latest = store.read(missionId)
    return {
        ok: false,
        ...(latest?.stage === undefined ? {} : { stage: latest.stage }),
        message: `已推进 ${budget} 步仍未到达 ${ENTER_IMPLEMENT_TARGET}（当前阶段 ${latest?.stage ?? '(未知)'}）：请检查 config.stages 的流水线顺序。`,
    }
}

/** Whether `stage` is at or past the target stage in the configured pipeline. */
function reached(stages: readonly StageConfig[], stage: StageConfig, target: StageConfig): boolean {
    const at = stages.findIndex((entry) => entry.id === stage.id)
    const goal = stages.findIndex((entry) => entry.id === target.id)
    return at >= 0 && goal >= 0 && at >= goal
}

/**
 * The CURRENT stage's own entry gate, before any settlement is attempted.
 *
 * `advance` checks the same fact, but its report is multi-line prose. Asking the
 * gate directly lets the service answer "what is missing" in one sentence.
 */
function entryBlocked(sequence: SequenceDeps, store: MissionStore, mission: MissionRecord, stage: StageConfig): string | undefined {
    if (stage.gate.phase !== 'entry' || !isGated(stage.gate)) return undefined
    const current = readStageResult(store, mission.id, stage.id)
    const outcome = evaluateGate(stage.gate, {
        store,
        mission,
        current,
        ...(sequence.config.split.models === undefined ? {} : { models: sequence.config.split.models }),
    })
    if (outcome.ok) return undefined
    return `${outcome.detail}${outcome.fix === undefined ? '' : `；修复：${outcome.fix}`}`
}

/** A stage result, never throwing (a corrupt artifact is treated as absent). */
function readStageResult(store: MissionStore, missionId: string, stageId: string) {
    try {
        return store.readStageResult(missionId, stageId)
    } catch {
        return undefined
    }
}

/**
 * The mission never entered the pipeline, so there is no stage to advance FROM.
 * Guessing `spec-clarify` here would settle a stage whose work nobody did.
 */
function notInPipeline(mission: MissionRecord, cwd: string): EnterImplementResult {
    return {
        ok: false,
        message: [
            `mission ${mission.id} 还没有进入流水线（mission.stage=${mission.stage ?? '(空)'}）：没有可逐级推进的阶段。`,
            `下一步：先调用 orchestrate({ action: "start", summary: "<一句话任务名>" }) 进入 spec-clarify（工作区 ${cwd}），再重新审批或推进。`,
        ].join('\n'),
    }
}

/** A refusal attributed to the stage the mission is currently in. */
function stopped(mission: MissionRecord, stage: StageConfig, reason: string): EnterImplementResult {
    return { ok: false, stage: stage.id, message: `停在 ${stage.id}（mission ${mission.id}）：${reason}` }
}

/**
 * The first section of an `advance` report, as one line.
 *
 * `advance` writes a blank line before its blocker-specific detail. The first
 * section is the verdict (missing plugin, blocked mission, attempt budget); the
 * stage whose gate failed is already handled by {@link entryBlocked}.
 */
function failureMessage(report: string): string {
    const lines: string[] = []
    for (const raw of report.split('\n')) {
        const line = raw.trim()
        if (line === '') break
        lines.push(line)
    }
    return lines.length === 0 ? '推进被拒绝（报告为空）' : lines.join('；')
}

/**
 * The agent shell `runOrchestrate` needs to resolve a workspace.
 *
 * It carries ONLY `header.cwd` and no session id: the service has no session,
 * and a made-up id would write a session binding that nothing owns.
 */
function serviceAgent(cwd: string): AgentLike {
    return { session: { header: { cwd } } }
}

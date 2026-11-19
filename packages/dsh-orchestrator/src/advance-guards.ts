/**
 * Small advance-time guards, extracted from `sequence.ts`'s `advanceAction` so
 * that function keeps its accepted size (the structural ratchet) while the
 * transition rules stay readable as one list.
 *
 * Each function is a pure decision over facts the caller already resolved: it
 * returns the refusal text (written for the model) or `undefined`. None of them
 * writes state — refusing an advance must leave the stage record untouched, so a
 * retry is free.
 *
 * @module dsh-orchestrator/advance-guards
 */

import { formatTime, mandateState, type MissionRecord } from 'dsh-eng-core'
import type { GateOutcome } from './gate-facts.js'
import type { StageConfig } from './pipeline.js'

/**
 * An entry gate that did not pass refuses the transition (docs.md §4.2).
 *
 * @param mission - the mission being advanced.
 * @param stage - the stage whose entry gate failed.
 * @param outcome - the gate evaluation (its `fix` is the actionable part).
 */
export function entryGateRefusal(mission: MissionRecord, stage: StageConfig, outcome: GateOutcome): string {
    return [
        `mission ${mission.id}（${mission.title}）阶段 ${stage.id} 不能进入：门禁未通过。`,
        `- ${outcome.detail}`,
        `修复：${outcome.fix ?? '满足门禁后重试。'}`,
        '',
        `下一步：${outcome.fix ?? '满足门禁后重新调用 orchestrate({ action: "advance" }) 。'}`,
    ].join('\n')
}

/**
 * The circuit breaker's latch: a `blocked` mission stays blocked until a human
 * explicitly releases it. Without this, `resume`/`advance` would quietly turn
 * the breaker's verdict into ordinary progress.
 *
 * A STOPPED mission is `blocked` too, but it is a stronger state: `unblock`
 * refuses it (the authorisation is gone), so the refusal must not send the
 * caller into that loop.
 * @param mission - the mission being asked to move.
 * @param action - the action name, quoted in the refusal.
 */
export function blockedRefusal(mission: MissionRecord, action: string): string | undefined {
    if (mission.status !== 'blocked') return undefined
    const mandate = mandateState(mission)
    const withdrawn = mandate.kind === 'present' ? mandate.mandate.withdrawn : undefined
    if (withdrawn !== undefined) {
        return [
            `mission ${mission.id} 已被人工停止（blocked；授权已由 ${withdrawn.by} 于 ${formatTime(withdrawn.at)} 撤回：${withdrawn.reason}），拒绝执行 ${action}。`,
            '撤回是一个人的停止决定：unblock 也会因"授权已撤回"被拒绝，这条 mission 不能再继续。',
            '',
            '下一步：需要继续这项工作就新建 mission（spec_create → spec_approve）；只需查看现状用 orchestrate({ action: "status" })。',
        ].join('\n')
    }
    return [
        `mission ${mission.id} 处于熔断状态（blocked），拒绝执行 ${action}。`,
        '熔断是给人看的结论：继续推进只会重复同一轮失败。',
        '',
        '下一步（人工决定）：',
        '1. 修复根因后，用 orchestrate({ action: "unblock", summary: "<为什么可以继续>" }) 解除熔断；',
        '2. 或新建 mission（spec_create）重来；',
        '3. 若是流程配置不合理（阶段过粗、上限过低），调整 config.stages / defaultMaxAttempts 后重启会话。',
    ].join('\n')
}

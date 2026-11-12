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

import type { MissionRecord } from 'dsh-eng-core'
import type { GateOutcome } from './gates.js'
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

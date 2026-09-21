/**
 * Stage entry/exit gates, computed from the mission store — never from model
 * prose (docs.md §9: 门禁的确定性来源是宿主配置/工件，不是模型输出).
 *
 * Every check reads one durable fact and returns either "satisfied" or the
 * concrete missing fact plus the tool that produces it, so a refusal is always
 * actionable.
 *
 * @module dsh-orchestrator/gates
 */

import { formatTime, type GateState, type MissionRecord, type MissionStore, type StageResult } from 'dsh-eng-core'
import type { GateSpec } from './pipeline.js'

/** Facts a gate evaluation needs beyond the stage itself. */
export interface GateFacts {
    store: MissionStore
    mission: MissionRecord
    /** The persisted `entered` result of the stage being gated. */
    current: StageResult | undefined
}

/** Outcome of one deterministic gate check. */
export interface GateOutcome {
    /** `true` when the transition may happen. */
    ok: boolean
    /** The recorded three-state verdict when the gate produced one. */
    state?: GateState
    /** Chinese explanation for the report (present in both directions). */
    detail: string
    /** The concrete missing fact + the tool that fixes it, when blocked. */
    fix?: string
}

/** The verdict a stage reports with `orchestrate({ verdict })`. */
export type Verdict = 'PASS' | 'WARN' | 'BLOCK'

/**
 * Evaluate one gate.
 *
 * Entry gates answer "may this stage start?"; exit gates answer "may this stage
 * finish?". The distinction is the whole reason `quality-verify` and `delivery`
 * exist: their deterministic fact is the transition, so it is checked on the
 * way out and a failure is a rollback, not a refusal to start.
 *
 * @param gate - the stage's resolved gate.
 * @param facts - store, mission and the stage's own persisted result.
 * @param verdict - the model-supplied verdict; a `BLOCK` is a declaration the
 *   stage did not really pass, so it forces the failure path (the reverse —
 *   `PASS` talking a failed deterministic gate into passing — is impossible).
 * @returns the outcome; `ok: false` carries the missing fact and its fix.
 */
export function evaluateGate(gate: GateSpec, facts: GateFacts, verdict?: Verdict): GateOutcome {
    const outcome = evaluateFacts(gate, facts)
    if (outcome.ok && verdict === 'BLOCK') {
        return {
            ok: false,
            state: 'BLOCK',
            detail: `${outcome.detail}；但调用方声明 verdict=BLOCK`,
            fix: '修复本阶段暴露的问题后，用 orchestrate({ action: "rerun" }) 重新进入当前阶段；若需先回退，用 orchestrate({ action: "rerun", stageId: "<目标阶段>" })。',
        }
    }
    return outcome
}

/** The pure deterministic half of {@link evaluateGate}. */
function evaluateFacts(gate: GateSpec, facts: GateFacts): GateOutcome {
    switch (gate.kind) {
        case 'none':
            return { ok: true, detail: '本阶段无门禁' }
        case 'spec-approved': {
            const approvedAt = facts.mission.spec?.approvedAt
            if (approvedAt === undefined) {
                return {
                    ok: false,
                    detail: `mission ${facts.mission.id} 的规格尚未审批（mission.spec.approvedAt 缺失）`,
                    fix: '先调用 spec_create 写规格，再调用 test_design_review（若已挂载）与 spec_approve 取人工审批，然后重新调用 orchestrate。',
                }
            }
            return { ok: true, state: 'PASS', detail: `规格已审批（approvedAt ${formatTime(approvedAt)}，by ${facts.mission.spec?.approvedBy ?? 'unknown'}）` }
        }
        case 'test-design': {
            const design = facts.mission.testDesign
            if (design === undefined) {
                return {
                    ok: false,
                    detail: `mission ${facts.mission.id} 尚未登记测试设计（mission.testDesign 缺失）`,
                    fix: '在 spec_create 的 testDesign 参数中补齐正向/异常/边界三类场景，然后调用 test_design_review，再重新调用 orchestrate。',
                }
            }
            const cases = design.cases?.length ?? 0
            if (design.passed !== true) {
                return {
                    ok: false,
                    state: 'WARN',
                    detail: `测试设计尚未通过评审（用例 ${cases} 条，未覆盖 ${design.uncovered?.join(', ') || '无'}）`,
                    fix: '调用 test_design_review 通过评审后重新调用 orchestrate。',
                }
            }
            return { ok: true, state: 'PASS', detail: `测试设计已通过评审（用例 ${cases} 条，未覆盖 ${design.uncovered?.join(', ') || '无'}）` }
        }
        case 'quality-pass': {
            // `pass-or-warn` is the host's declarative conditional edge: a WARN
            // verdict may still leave the stage (docs.md §3.4 "只有非必需命令
            // 失败 = WARN：可以带风险交付"), while the default stays pass-only.
            const latestRun = facts.store.lastGate(facts.mission.id)
            const gateRecord = facts.store.lastGate(facts.mission.id, { state: 'PASS' })
            if (gateRecord === undefined && !(gate.verdict === 'pass-or-warn' && latestRun?.state === 'WARN')) {
                const latest = facts.store.lastGate(facts.mission.id)
                return {
                    ok: false,
                    state: latest?.state ?? 'BLOCK',
                    detail:
                        latest === undefined
                            ? `mission ${facts.mission.id} 没有任何 PASS 的质量门禁记录（store.lastGate 为空）`
                            : `mission ${facts.mission.id} 最近一次门禁是 ${latest.state}（${latest.source}：${latest.reason}），没有 PASS 记录`,
                    fix: '调用 quality_gate_run 执行宿主配置的确定性命令，修到 PASS，再调用 evidence_record 登记证据，然后重新调用 orchestrate。',
                }
            }
            const accepted = gateRecord ?? latestRun
            if (accepted === undefined) {
                return {
                    ok: false,
                    state: 'BLOCK',
                    detail: `mission ${facts.mission.id} 没有任何门禁记录`,
                    fix: '调用 quality_gate_run 执行宿主配置的确定性命令后再调用 orchestrate。',
                }
            }
            const enteredAt = facts.current?.enteredAt
            if (enteredAt === undefined) {
                // Without a recorded entry time there is no way to prove the
                // verdict belongs to this pass — fail closed instead of
                // accepting a gate run from an earlier round.
                return {
                    ok: false,
                    state: accepted.state,
                    detail: `无法确认本阶段的进入时间（stages/${facts.mission.id} 缺少 entered 记录），因此无法证明门禁 ${accepted.id} 覆盖了这一轮`,
                    fix: '用 orchestrate({ action: "rerun", stageId: "<当前阶段>" }) 重新进入该阶段并重跑 quality_gate_run。',
                }
            }
            if (accepted.checkedAt <= enteredAt) {
                return {
                    ok: false,
                    state: accepted.state,
                    detail: `最近一次合格门禁发生在 ${formatTime(accepted.checkedAt)}，不晚于本阶段进入时间 ${formatTime(enteredAt)}：这一轮验证没有重新跑过门禁`,
                    fix: '修改代码后重新调用 quality_gate_run（必须晚于本阶段进入时间），然后重新调用 orchestrate。',
                }
            }
            return {
                ok: true,
                state: accepted.state,
                detail:
                    accepted.state === 'PASS'
                        ? `质量门禁 PASS（${accepted.id} @ ${formatTime(accepted.checkedAt)}，by ${accepted.source}）`
                        : `质量门禁 WARN 按配置放行（条件边 verdict=pass-or-warn；${accepted.id} @ ${formatTime(accepted.checkedAt)}，原因：${accepted.reason}）`,
            }
        }
        case 'standards-pass': {
            // Structural quality is a separate concern from "the commands pass",
            // so it is a separate gate: the newest `dsh-standards-gate` record
            // must be PASS and must not predate this stage entry (a verdict from
            // an earlier round proves nothing about the code as it stands now).
            const acceptable = facts.store.lastGate(facts.mission.id, { source: 'dsh-standards-gate', state: 'PASS' })
            const latest = facts.store.lastGate(facts.mission.id, { source: 'dsh-standards-gate' })
            if (acceptable === undefined) {
                return {
                    ok: false,
                    state: latest?.state ?? 'BLOCK',
                    detail:
                        latest === undefined
                            ? `mission ${facts.mission.id} 没有任何规范门禁记录（先跑 standards_check）`
                            : `最近一次规范门禁是 ${latest.state}（${latest.reason}）`,
                    fix: '调用 standards_check：新增违规要改代码消除；存量债务需要放宽时走人工批准（standards_check({ accept: true })）。',
                }
            }
            const enteredAt = facts.current?.enteredAt
            if (enteredAt === undefined) {
                return {
                    ok: false,
                    state: acceptable.state,
                    detail: `无法确认本阶段的进入时间，因此无法证明规范门禁 ${acceptable.id} 覆盖了这一轮的代码`,
                    fix: '用 orchestrate({ action: "rerun", stageId: "<当前阶段>" }) 重新进入该阶段并重跑 standards_check。',
                }
            }
            if (acceptable.checkedAt < enteredAt) {
                return {
                    ok: false,
                    state: acceptable.state,
                    detail: `规范门禁 ${acceptable.id}（${formatTime(acceptable.checkedAt)}）早于本阶段进入时间（${formatTime(enteredAt)}）：它证明的是上一轮的代码`,
                    fix: '重新调用 standards_check 后再推进本阶段。',
                }
            }
            return { ok: true, state: 'PASS', detail: `规范门禁 ${acceptable.id} PASS（${formatTime(acceptable.checkedAt)}，晚于本阶段进入时间）` }
        }
        case 'receipt': {
            const receipts = facts.store.readReceipts(facts.mission.id)
            const receipt = receipts[receipts.length - 1]
            if (receipt === undefined) {
                return {
                    ok: false,
                    detail: `mission ${facts.mission.id} 尚无交付回执（store.readReceipts 为空）`,
                    fix: '调用 evidence_record 登记证据（含测试报告与 git 指纹），再调用 mission_complete 签发回执，然后重新调用 orchestrate。',
                }
            }
            // A receipt from an earlier round must not stamp the current one:
            // "delivered" has to be earned by THIS pass.
            const enteredAt = facts.current?.enteredAt
            if (enteredAt !== undefined && receipt.issuedAt <= enteredAt) {
                return {
                    ok: false,
                    state: 'BLOCK',
                    detail: `最新回执 ${receipt.id} 签发于 ${formatTime(receipt.issuedAt)}，不晚于本阶段进入时间 ${formatTime(enteredAt)}：这是上一轮的回执`,
                    fix: '本轮重新走 evidence_record → quality_gate_run → mission_complete 签发新回执，然后重新调用 orchestrate。',
                }
            }
            return {
                ok: true,
                state: 'PASS',
                detail: `已签发交付回执 ${receipt.id}（${formatTime(receipt.issuedAt)}，by ${receipt.issuedBy}）`,
            }
        }
        default: {
            // Unreachable through the config validator; a hand-edited record is
            // treated as "no gate" rather than crashing the tool.
            const exhaustive: never = gate.kind
            return { ok: true, detail: `未知门禁 ${String(exhaustive)}：按无门禁处理` }
        }
    }
}

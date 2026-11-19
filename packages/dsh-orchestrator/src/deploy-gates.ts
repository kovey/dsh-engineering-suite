/**
 * The deployment gates (`deploy-go` / `deploy-verified`), extracted from
 * `gates.ts` so that file stays inside its accepted size while the split gates
 * were added next to it.
 *
 * Both kinds follow the same two fail-closed rules as the standards gate: the
 * NEWEST record of the source decides (a later failure closes the gate again),
 * and a verdict recorded at or before this stage's entry is stale — a deploy
 * that happened in an earlier round proves nothing about this one. They read one
 * source because `dsh-deploy-gate` records a PASS for the run and another for the
 * verification: on a deploy stage the newest record is the run, on a verify stage
 * it is the verification, so "newest + newer than entry" answers both questions
 * without a second source id.
 *
 * @module dsh-orchestrator/deploy-gates
 */

import { formatTime } from 'dsh-eng-core'
import type { GateFacts, GateOutcome } from './gate-facts.js'

/**
 * Evaluate one deployment gate.
 * @param deploying - `true` for `deploy-go`, `false` for `deploy-verified`.
 * @param facts - store, mission and the stage's entry record.
 */
export function deployGateOutcome(deploying: boolean, facts: GateFacts): GateOutcome {
    const latest = facts.store.lastGate(facts.mission.id, { source: 'dsh-deploy-gate' })
    if (latest === undefined) {
        return {
            ok: false,
            state: 'BLOCK',
            detail: `mission ${facts.mission.id} 没有任何部署门禁记录（${deploying ? 'deploy_run' : 'deploy_verify'} 尚未运行）`,
            fix: deploying
                ? '用 deploy_plan 看 go/no-go 清单，通过后调用 deploy_run（生产环境需要人工批准）。'
                : '调用 deploy_verify 执行上线后验证；失败时按环境声明的回滚命令处理。',
        }
    }
    if (latest.state !== 'PASS') {
        return {
            ok: false,
            state: latest.state,
            detail: `最近一次部署门禁是 ${latest.state}（${latest.id} @ ${formatTime(latest.checkedAt)}：${latest.reason}）`,
            fix: deploying
                ? '修掉失败原因后重新 deploy_run；已上线且验证失败时应先 deploy_rollback。'
                : '验证失败：按 REPORT 里的回滚命令执行 deploy_rollback（需人工批准），再重新部署。',
        }
    }
    const enteredAt = facts.current?.enteredAt
    if (enteredAt === undefined) {
        return {
            ok: false,
            state: latest.state,
            detail: `无法确认本阶段的进入时间，因此无法证明部署记录 ${latest.id} 覆盖了这一轮`,
            fix: '用 orchestrate({ action: "rerun", stageId: "<当前阶段>" }) 重新进入该阶段并重跑部署步骤。',
        }
    }
    if (latest.checkedAt <= enteredAt) {
        return {
            ok: false,
            state: latest.state,
            detail:
                latest.checkedAt === enteredAt
                    ? `部署记录 ${latest.id} 与本阶段进入时间记录在同一毫秒：无法证明它覆盖了这一轮，按陈旧处理`
                    : `部署记录 ${latest.id}（${formatTime(latest.checkedAt)}）早于本阶段进入时间（${formatTime(enteredAt)}）：它证明的是上一轮的部署`,
            fix: deploying ? '重新调用 deploy_run。' : '重新调用 deploy_verify。',
        }
    }
    return {
        ok: true,
        state: 'PASS',
        detail: deploying
            ? `部署已执行并通过（${latest.id} @ ${formatTime(latest.checkedAt)}：${latest.reason}）`
            : `上线后验证通过（${latest.id} @ ${formatTime(latest.checkedAt)}：${latest.reason}）`,
    }
}

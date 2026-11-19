/**
 * The mission retrospective: the `retro` action and the one-line tail a
 * delivered mission prints.
 *
 * docs.md §8's last stage is 沉淀: when a mission ends, the trail is folded into
 * rules (no model needed) so the next task starts from what actually happened.
 * The folding itself lives in `retrospective.ts`; this module is the REPORTING
 * around it, extracted from `sequence.ts` so that file stays inside its accepted
 * size (the structural ratchet).
 *
 * The context is structural on purpose: importing `CallContext` from
 * `sequence.ts` would point an edge back at a module that imports this one — a
 * cycle for the sake of a type.
 *
 * @module dsh-orchestrator/retro-report
 */

import path from 'node:path'
import type { MissionRecord, MissionStore } from 'dsh-eng-core'
import { buildRetrospective, persistRetrospective, type Retrospective } from './retrospective.js'
import type { Pipeline } from './pipeline.js'

/** What the retrospective needs from the caller's context. */
export interface RetroContext {
    store: MissionStore
    mission: MissionRecord | undefined
}

/** What the retrospective needs from the resolved configuration. */
export interface RetroDeps {
    config: { stages: Pipeline }
}

/**
 * `retro` — read the mission's trail back as a reviewable report.
 * @param deps - the configured pipeline (stage ids are the report's sections).
 * @param ctx - the store and the mission of this call.
 */
export function retroAction(deps: RetroDeps, ctx: RetroContext): string {
    const mission = ctx.mission
    if (mission === undefined) {
        return [
            '当前会话没有 mission 可以复盘。',
            '',
            '下一步：先用 orchestrate({ action: "start" }) 开始一条流水线，或在有 mission 的会话里调用 state action: "retro"。',
        ].join('\n')
    }
    const retro = buildRetrospective(ctx.store, mission, deps.config.stages)
    const files = persistRetrospective(ctx.store, retro)
    return [
        `## 复盘（mission ${mission.id}，状态 ${mission.status}）`,
        '',
        `- 规格 revision：${retro.specRevisions}　门禁：PASS ${retro.gates.pass} / WARN ${retro.gates.warn} / BLOCK ${retro.gates.block}　回执：${retro.receipts}`,
        `- 失败命令：${retro.failingCommands.map((entry) => `${entry.id}×${entry.count}`).join('、') || '无'}`,
        `- 阶段回退：${retro.rollbacks.map((entry) => `${entry.stage}→${entry.to}×${entry.count}`).join('、') || '无'}`,
        `- 重复尝试：${retro.reworkStages.map((entry) => `${entry.stage}×${entry.attempts}`).join('、') || '无'}　熔断：${retro.blocked ? '是' : '否'}`,
        '',
        '### 候选经验',
        ...retro.lessons.map((lesson) => `- ${lesson}`),
        '',
        `工件：${path.relative(ctx.store.layout.cwd, files.markdown)}（+ .json）`,
        `跨 run 台账：${path.relative(ctx.store.layout.cwd, files.ledger)}（只追加，下次开工前可 grep 历史模式）`,
        '',
        '下一步：用 memory_save 把其中真正可复用的 1–3 条写成 lesson（项目级；工具链事实才写 global），',
        '下次同类任务开工时它们会被自动召回；其余条目留在 retrospective.md 里备查。',
    ].join('\n')
}

/**
 * Fold the trail at the end of a mission; a failure never breaks the delivery.
 * @param deps - the configured pipeline.
 * @param ctx - the store and the finished mission.
 * @param mission - the record to fold (may be newer than `ctx.mission`).
 */
export function safeRetrospective(deps: RetroDeps, ctx: { store: MissionStore }, mission: MissionRecord): Retrospective | undefined {
    try {
        const retro = buildRetrospective(ctx.store, mission, deps.config.stages)
        persistRetrospective(ctx.store, retro)
        return retro
    } catch {
        return undefined
    }
}

/** The two-lesson tail a delivered mission prints (full report stays on disk). */
export function renderRetrospectiveTail(retro: Retrospective): string[] {
    return [
        `复盘已生成：规格 revision ${retro.specRevisions}，门禁 BLOCK ${retro.gates.block} 次，回退 ${retro.rollbacks.length} 次。`,
        ...retro.lessons.slice(0, 2).map((lesson) => `- ${lesson}`),
        `完整复盘：.dsh/missions/${retro.missionId}/retrospective.md；跨 run 台账：${'.dsh/retrospectives.jsonl'}`,
    ]
}

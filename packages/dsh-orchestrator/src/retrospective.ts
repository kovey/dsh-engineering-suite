/**
 * Cross-run distillation (docs.md §8 第四阶段：「每次 Mission 结束后，将规格质量、
 * 门禁违规模式、返工原因沉淀为知识条目，下次开工前回注上下文」).
 *
 * The orchestrator owns the end of a mission, so it is the natural place to
 * *collect* the evidence of how the mission went. It deliberately does NOT call
 * a model: the facts are folded deterministically into a structured record plus
 * a rule-derived list of candidate lessons, which the calling agent may then
 * distil into memory (through `dsh-memory`, when it is mounted) or hand to a
 * human. Two artifacts are written:
 *
 *  - `.dsh/missions/<id>/retrospective.{json,md}` — the per-mission record;
 *  - `.dsh/retrospectives.jsonl` — the append-only cross-run ledger, which is
 *    what "下一次开工前回注上下文" reads.
 *
 * @module dsh-orchestrator/retrospective
 */

import path from 'node:path'
import {
    appendJsonl,
    cell,
    formatTime,
    readJsonl,
    type EvidenceRecord,
    type GateRecord,
    type MissionRecord,
    type MissionStore,
    type StageResult,
} from 'dsh-eng-core'
import type { Pipeline } from './pipeline.js'

/** Why a mission needed rework, as counted by the deterministic facts. */
export interface ReworkFacts {
    /** Specification revisions (a revision always follows a change of contract). */
    specRevisions: number
    /** Test-design reviews that did not pass. */
    designRejections: number
    /** Gate runs per state. */
    gates: { total: number; pass: number; warn: number; block: number }
    /** Commands that failed at least once, worst first. */
    failingCommands: { id: string; count: number }[]
    /** Stage rollbacks observed in the stage artifacts. */
    rollbacks: { stage: string; to: string; count: number }[]
    /** Stage attempts above one. */
    reworkStages: { stage: string; attempts: number }[]
    /** Whether the circuit breaker fired. */
    blocked: boolean
    /** Evidence rows per kind. */
    evidence: Record<string, number>
    /** Issued receipts. */
    receipts: number
    /** Wall-clock duration of the mission. */
    durationMs: number
}

/** The persisted retrospective of one mission. */
export interface Retrospective extends ReworkFacts {
    missionId: string
    title: string
    status: string
    generatedAt: number
    /** Rule-derived candidate lessons (the agent distils the final wording). */
    lessons: string[]
}

/** Fold one mission's durable facts into a retrospective. */
export function buildRetrospective(store: MissionStore, mission: MissionRecord, stages: Pipeline): Retrospective {
    const gates: GateRecord[] = store.readGates(mission.id)
    const evidence: EvidenceRecord[] = store.readEvidence(mission.id)
    const stageResults: StageResult[] = store.listStageResults(mission.id)

    const failing = new Map<string, number>()
    for (const gate of gates) {
        for (const result of gate.results) {
            if (result.exitCode !== 0) failing.set(result.id, (failing.get(result.id) ?? 0) + 1)
        }
    }
    const rollbacks = new Map<string, { stage: string; to: string; count: number }>()
    const rework: { stage: string; attempts: number }[] = []
    for (const result of stageResults) {
        if (result.state === 'failed') {
            // A failed stage whose rollback was refused (no `next`) is the
            // circuit breaker firing — a rework signal in its own right.
            const target = result.next ?? '(熔断：无回退目标)'
            const key = `${result.stageId}->${target}`
            const entry = rollbacks.get(key) ?? { stage: result.stageId, to: target, count: 0 }
            entry.count += 1
            rollbacks.set(key, entry)
        }
        if (result.attempt > 1 && !rework.some((entry) => entry.stage === result.stageId)) {
            rework.push({ stage: result.stageId, attempts: result.attempt })
        }
    }
    const evidenceByKind: Record<string, number> = {}
    for (const row of evidence) evidenceByKind[row.kind] = (evidenceByKind[row.kind] ?? 0) + 1

    const facts: ReworkFacts = {
        specRevisions: mission.spec?.revision ?? 0,
        designRejections: mission.testDesign?.passed === false ? 1 : 0,
        gates: {
            total: gates.length,
            pass: gates.filter((gate) => gate.state === 'PASS').length,
            warn: gates.filter((gate) => gate.state === 'WARN').length,
            block: gates.filter((gate) => gate.state === 'BLOCK').length,
        },
        failingCommands: [...failing.entries()]
            .map(([id, count]) => ({ id, count }))
            .sort((left, right) => right.count - left.count),
        rollbacks: [...rollbacks.values()],
        reworkStages: rework,
        blocked: mission.status === 'blocked',
        evidence: evidenceByKind,
        receipts: store.readReceipts(mission.id).length,
        durationMs: Date.now() - mission.createdAt,
    }
    return {
        missionId: mission.id,
        title: mission.title,
        status: mission.status,
        generatedAt: Date.now(),
        ...facts,
        lessons: deriveLessons(facts, stages),
    }
}

/**
 * Turn the folded facts into candidate lessons.
 *
 * These are *prompts for distillation*, not conclusions: each one names the
 * observation an agent should check before writing it into memory.
 */
export function deriveLessons(facts: ReworkFacts, stages: Pipeline): string[] {
    const lessons: string[] = []
    if (facts.specRevisions > 1) {
        lessons.push(
            `规格返工 ${facts.specRevisions} 次：回顾第一次 spec_create 漏掉了什么（常见：文件边界不全、验收标准不可验证、负面约束缺失），下次在规格阶段一次性补齐。`,
        )
    }
    if (facts.designRejections > 0 || facts.rollbacks.some((entry) => entry.stage === 'test-design-review')) {
        lessons.push('测试设计评审曾不通过：把评审规则（三类场景齐备、每条验收标准都有用例、步骤可执行）写进第一次提交的规格里。')
    }
    if (facts.gates.block > 0) {
        const worst = facts.failingCommands.slice(0, 3).map((entry) => `${entry.id}×${entry.count}`).join('、')
        lessons.push(`门禁阻断 ${facts.gates.block} 次（失败命令：${worst || '未知'}）：确认是"写完才跑门禁"还是"命令本身不稳定"，必要时把 lint 前移到写后触发。`)
    }
    if (facts.gates.warn > 0) {
        lessons.push(`门禁 WARN ${facts.gates.warn} 次：非必需命令长期失败会训练出"忽略黄灯"的习惯，要么修掉，要么把它降级/删除。`)
    }
    for (const rollback of facts.rollbacks) {
        const stage = stages.find((entry) => entry.id === rollback.stage)
        lessons.push(
            `阶段 ${rollback.stage} 回退到 ${rollback.to} 共 ${rollback.count} 次${stage === undefined ? '' : `（门禁：${stage.gate.label}）`}：检查该阶段的进入条件是否太宽松。`,
        )
    }
    if (facts.blocked) {
        lessons.push('mission 被熔断标记为 blocked：说明反复回退没有收敛，记录触发条件并在下次把任务拆小。')
    }
    if (lessons.length === 0) {
        lessons.push('本次没有返工信号（无 BLOCK、无回退、规格未返工）：值得记录的是"一次通过"的做法本身。')
    }
    return lessons
}

/** Render the human-readable retrospective. */
export function renderRetrospective(retro: Retrospective): string {
    const lines: string[] = []
    lines.push(`# 复盘：${retro.title}`)
    lines.push('')
    lines.push(`- mission: \`${retro.missionId}\`（状态 ${retro.status}）`)
    lines.push(`- 生成时间：${formatTime(retro.generatedAt)}　耗时：${Math.round(retro.durationMs / 1000)}s`)
    lines.push(`- 规格 revision：${retro.specRevisions}　测试设计评审未通过：${retro.designRejections ? '是' : '否'}`)
    lines.push(
        `- 门禁：共 ${retro.gates.total} 次（PASS ${retro.gates.pass} / WARN ${retro.gates.warn} / BLOCK ${retro.gates.block}）　回执：${retro.receipts}`,
    )
    lines.push(`- 证据：${Object.entries(retro.evidence).map(([kind, count]) => `${kind}×${count}`).join('、') || '(无)'}`)
    lines.push('')
    lines.push('## 返工信号')
    lines.push('')
    lines.push('| 信号 | 明细 |')
    lines.push('|------|------|')
    lines.push(`| 失败命令 | ${retro.failingCommands.map((entry) => `${cell(entry.id)}×${entry.count}`).join('、') || '无'} |`)
    lines.push(`| 阶段回退 | ${retro.rollbacks.map((entry) => `${cell(entry.stage)}→${cell(entry.to)}×${entry.count}`).join('、') || '无'} |`)
    lines.push(`| 重复尝试 | ${retro.reworkStages.map((entry) => `${cell(entry.stage)}×${entry.attempts}`).join('、') || '无'} |`)
    lines.push(`| 熔断 | ${retro.blocked ? '是' : '否'} |`)
    lines.push('')
    lines.push('## 候选经验（交给 memory_save 或人工筛选）')
    lines.push('')
    for (const lesson of retro.lessons) lines.push(`- ${lesson}`)
    lines.push('')
    return `${lines.join('\n')}\n`
}

/** One row of the cross-run ledger (the shape {@link persistRetrospective} appends). */
export interface LedgerRow {
    missionId: string
    title: string
    generatedAt: number
    specRevisions: number
    gateBlocks: number
    gateWarns: number
    rollbacks: number
    blocked: boolean
    lessons: number
}

/** Read the newest rows of the cross-run ledger (oldest first). */
export function readLedger(store: MissionStore, limit = 5): LedgerRow[] {
    const rows = readJsonl<LedgerRow>(ledgerPath(store))
    return rows.slice(-limit)
}

/**
 * Render the recurring rework patterns of previous missions.
 *
 * docs.md §8 第四阶段 asks for the distilled experience to be fed back BEFORE
 * the next mission starts; this is that injection — a compact, deterministic
 * summary of the ledger, carried in the `start`/`resume` output so the agent
 * reads it while planning instead of having to remember to grep for it.
 * @param rows - ledger rows, oldest first.
 * @returns the Chinese summary, or `''` when there is nothing to feed back.
 */
export function renderHistory(rows: readonly LedgerRow[]): string {
    if (rows.length === 0) return ''
    const blocks = rows.reduce((total, row) => total + row.gateBlocks, 0)
    const warns = rows.reduce((total, row) => total + row.gateWarns, 0)
    const rollbacks = rows.reduce((total, row) => total + row.rollbacks, 0)
    const blocked = rows.filter((row) => row.blocked).length
    const churned = rows.filter((row) => row.specRevisions > 1).length
    const lines = [
        `## 历史返工模式（最近 ${rows.length} 个 mission，来自 .dsh/retrospectives.jsonl）`,
        '',
        `- 门禁：BLOCK ${blocks} 次、WARN ${warns} 次；阶段回退 ${rollbacks} 次；熔断 ${blocked} 次`,
        `- 规格返工（revision > 1）的 mission：${churned}/${rows.length}`,
    ]
    if (blocks > 0) lines.push('- 提醒：本项目历史上出现过门禁阻断，实现阶段先跑一次 `quality_gate_run` 再继续写。')
    if (churned > 0) lines.push('- 提醒：该项目规格容易返工——第一次 `spec_create` 就把文件边界与验收标准写全。')
    if (blocked > 0) lines.push('- 提醒：出现过熔断——任务粒度可能过大，先拆分再开工。')
    lines.push('', '（这些是历史统计，不是本轮结论；可用 `orchestrate({ action: "retro" })` 查看完整复盘。）')
    return lines.join('\n')
}

/** Absolute path of the cross-run ledger. */
export function ledgerPath(store: MissionStore): string {
    return path.join(store.layout.rootDir, 'retrospectives.jsonl')
}

/**
 * Persist one retrospective: the per-mission artifacts plus one ledger row.
 * @returns the artifact paths, for the tool's report.
 */
export function persistRetrospective(store: MissionStore, retro: Retrospective): { json: string; markdown: string; ledger: string } {
    const json = store.writeArtifact(retro.missionId, 'retrospective.json', `${JSON.stringify(retro, undefined, 2)}\n`)
    const markdown = store.writeArtifact(retro.missionId, 'retrospective.md', renderRetrospective(retro))
    const ledger = ledgerPath(store)
    appendJsonl(ledger, {
        missionId: retro.missionId,
        title: retro.title,
        generatedAt: retro.generatedAt,
        specRevisions: retro.specRevisions,
        gateBlocks: retro.gates.block,
        gateWarns: retro.gates.warn,
        rollbacks: retro.rollbacks.length,
        blocked: retro.blocked,
        lessons: retro.lessons.length,
    })
    return { json, markdown, ledger }
}

/**
 * The operator view: the three questions a person actually asks, in order.
 *
 * `renderDoctor()` answers "what is configured, what is missing" — the full
 * self-check. That is the right thing to READ when something is wrong, and the
 * wrong thing to read at a glance: it starts with configuration inventory and
 * buries the one thing an operator needs first ("does anything need me NOW?").
 * This module renders the same report in the operator's order:
 *
 *  1. **现在需要我做什么？** — the attention queue: unanswered questions that
 *     wait for a person, oldest first, bounded, each with `whyYou`, its age and
 *     the stale badge WITH the reason. A count always equals the length of the
 *     list it refers to (`shown + 另有 N 条 == total`), and a healthy state is
 *     ONE line;
 *  2. **系统是否健康？** — the existing checks, unchanged: the merged doctor
 *     report when there is something to say (a blocker or advice), one line when
 *     everything is ready;
 *  3. **历史** — a pointer to the existing per-mission views, never a copy of
 *     them: this report is about NOW, and duplicating history here would make two
 *     places where the past can disagree.
 *
 * Two honesty rules from the rest of the suite:
 *
 *  - a queue that could not be READ is stated as unknown with the reason and the
 *    next step — never as "nothing needs you", and never as a doctor check: one
 *    failed probe (a timed-out service call) is a gap in this report, not a
 *    defect of the workspace, so it does not become a blocker;
 *  - a stale attention is still LISTED and labelled. Hiding it would make the
 *    suite look calm while a question it asked stays unanswered.
 *
 * Pure: no clock (`now` is injected), no I/O, no writes.
 *
 * @module dsh-suite-doctor/operator
 */

import {
    CONFORMANCE_DIMENSION_LABEL,
    CONFORMANCE_DIMENSIONS,
    conformanceStateToken,
    renderDoctor,
    type ConformanceOverview,
    type DoctorReport,
    type MissionConformance,
} from 'dsh-eng-core'
import type { AttentionFact } from './probe.js'

/**
 * The four questions, in the order they are answered (and asserted in tests).
 *
 * The third is the conformance overview: **how far this delivery is from what
 * the rules allow** — never "may it be delivered".
 */
export const OPERATOR_QUESTIONS = ['现在需要我做什么？', '系统是否健康？', '一致性（这一项离规则允许的范围有多远）', '历史'] as const

/** How many attention rows the queue shows before it summarises the rest. */
export const MAX_ATTENTION_ROWS = 10

/** Where the past lives (the answer to question 3, without duplicating it). */
export const HISTORY_POINTER =
    '不在这里重复：每个 mission 的历史看 spec_status（规格）、audit_report（快照/回滚）、orchestrate({ action: "retro" })（复盘）'

/** What the operator view renders. */
export interface OperatorInput {
    /** The merged doctor report (`checkWorkspace` + runtime facts). */
    report: DoctorReport
    /**
     * The attention queue, oldest first. `undefined` = could not be read
     * (`attentionProblem` says why) — which is NOT the same as an empty list.
     */
    attentions?: readonly AttentionFact[]
    /** Why the queue is unknown. */
    attentionProblem?: string
    /** The exact next step for an unknown queue. */
    attentionFix?: string
    /** Row budget (default {@link MAX_ATTENTION_ROWS}). */
    maxRows?: number
    /**
     * The precomputed conformance overview (question 3).
     *
     * This module stays pure — it never reads a ledger itself — so the overview
     * is handed in already computed. Absent = "not computed", which is rendered
     * as unknown, never as "consistent".
     */
    conformance?: ConformanceOverview
}

/** The queue section, split into what a test (and a reader) needs. */
export interface AttentionQueueView {
    /** The header line: how many questions need a person. */
    header: string
    /** One line per shown attention. */
    rows: string[]
    /** `另有 N 条（共 M 条）…` when truncated; empty otherwise. */
    truncation: string
    /** Every line of the section, in order. */
    lines: string[]
}

/** Format an age for a human (seconds → minutes → hours), no locale. */
export function describeAge(ageMs: number): string {
    const seconds = Math.max(0, Math.round(ageMs / 1000))
    if (seconds < 90) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟`
    const hours = Math.round(minutes / 60)
    return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`
}

/**
 * Render the attention queue (question 1).
 *
 * The count in the header is ALWAYS `attentions.length`, and
 * `rows + hidden === length`: a truncated list says how many are hidden, so a
 * reader can never mistake "10 shown" for "10 waiting".
 * @param input - the queue, the problem (if unreadable) and the row budget.
 */
export function renderAttentionQueue(input: OperatorInput): AttentionQueueView {
    const budget = Math.max(1, Math.floor(input.maxRows ?? MAX_ATTENTION_ROWS))
    if (input.attentions === undefined) {
        // Unknown is not "nothing to do": say what could not be read and what to
        // do about it, in ONE line (a probe gap must not grow into a report).
        const reason = input.attentionProblem ?? '未知原因'
        const fix = input.attentionFix === undefined ? '' : `；下一步：${input.attentionFix}`
        const line = `- ⚠️ 待你处理的提问：未知（读取失败，**不是**"没有"）——${reason}${fix}`
        return { header: line, rows: [], truncation: '', lines: [line] }
    }
    const total = input.attentions.length
    if (total === 0) {
        const line = '- 没有需要你处理的提问（0 条：没有门禁在等决定，也没有结果等你去用）'
        return { header: line, rows: [], truncation: '', lines: [line] }
    }
    const shown = input.attentions.slice(0, budget)
    const hidden = total - shown.length
    const header = `- 需要你：${total} 条（最老在前，最多显示 ${budget} 条）`
    const rows = shown.map((attention) => {
        const mission = attention.missionId === undefined ? '无 mission' : `mission ${attention.missionId}`
        const stale = attention.stale === undefined ? '' : `；⚠️ stale(${attention.stale.reason})：${attention.stale.detail}`
        const paused = attention.pausedMs === undefined || attention.pausedMs <= 0 ? '' : `；已暂停 ${describeAge(attention.pausedMs)}（期限顺延）`
        return `- ${attention.questionId}（${mission}，whyYou=${attention.whyYou}）：已等 ${describeAge(attention.ageMs)}${paused}${stale}`
    })
    const truncation = hidden > 0 ? `- 另有 ${hidden} 条（共 ${total} 条；用 interaction_status 看全部）` : ''
    return { header, rows, truncation, lines: [header, ...rows, ...(truncation === '' ? [] : [truncation])] }
}

/**
 * Render the health section (question 2).
 *
 * "Healthy" is `no blockers and no advice` — the existing checks decide that,
 * never this module. A healthy state is ONE line; anything else is the existing
 * report, byte for byte, so a reader (and every existing assertion about the
 * report text) still sees the checks exactly as the suite renders them.
 * @param report - the merged doctor report.
 */
export function renderHealth(report: DoctorReport): string[] {
    if (report.blockers.length === 0 && report.advice.length === 0) {
        return [`- 健康：${report.checks.length} 项检查全部就绪（无必需项未就绪、无建议项待处理）`]
    }
    return renderDoctor(report).split('\n')
}

/** Collapse whitespace and bound a one-line detail (the reason is never lost). */
function shortDetail(value: string, max = 180): string {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/** Join blind spots with a bound, so the line stays one line. */
function shortBlind(entries: readonly string[], max = 6): string {
    const shown = entries.slice(0, max).join('；')
    return entries.length <= max ? shown : `${shown}；…另有 ${entries.length - max} 条（用 suite_status 指定该 mission 可看完整的五维结论）`
}

/**
 * The next step for the conformance section.
 *
 * It never says "healthy" and never says "may deliver": the section measures
 * DISTANCE, and delivery remains mission_complete's decision.
 */
export function conformanceNextStep(mission: MissionConformance): string {
    if (mission.missionId === undefined) {
        return '下一步：先建立 mission 并留下规格审批、门禁、证据与回执（spec_create → …）；空仓库的 unknown 不是"全部一致"。'
    }
    switch (mission.headline) {
        case 'divergent':
            return '下一步：先处理头行点名的最差维度（见上一行），再重新 suite_status；交付与否仍只由 mission_complete 读取门禁记录与回执决定（这一节不授予任何许可）。'
        case 'partial':
            return '下一步：把最差维度（见头行）推进到规则允许的状态——缺的记录先补齐，再重新 suite_status；unknown 不是通过。'
        case 'unknown':
            return '下一步：先补齐可核对的台账（mission.json、gates/、receipts/、evidence.jsonl），再重新 suite_status；unknown 不是通过。'
        default:
            return '下一步：一致性没有发现偏离（这是"离规则允许范围的远近"，不是交付许可）；交付仍需 mission_complete 的门禁记录与回执。'
    }
}

/**
 * Render the conformance section (question 3): the headline, one line per
 * dimension, the blind-spot line when anything could not be checked, and a next
 * step. Never a composite score, never "looks healthy".
 * @param input - the precomputed overview, or `undefined` when not computed.
 */
export function renderConformanceSection(input: ConformanceOverview | MissionConformance | undefined): string[] {
    if (input === undefined) {
        return [
            '- 头行：unknown（未计算：本次调用没有带入台账事实——这不是"一致"）',
            '- 下一步：重新运行 suite_status 以读取一致性台账；这一节不给出任何判定。',
        ]
    }
    const mission = 'mission' in input ? input.mission : input
    const lines: string[] = []
    if (mission.missionId === undefined) {
        lines.push('- mission：（本工作区还没有 mission）')
    } else if (mission.title === undefined) {
        lines.push(`- mission：${mission.missionId}（未记录）`)
    } else {
        lines.push(`- mission：${mission.missionId}《${mission.title}》（${mission.status ?? '状态未记录'}）`)
    }
    lines.push(`- 头行：${mission.headline} — ${shortDetail(mission.headlineReason)}`)
    for (const dimension of CONFORMANCE_DIMENSIONS) {
        const entry = mission.dimensions[dimension]
        lines.push(
            `- ${CONFORMANCE_DIMENSION_LABEL[dimension]}：${conformanceStateToken(entry.state)} — ${shortDetail(entry.detail)}`,
        )
    }
    if (mission.blind.length > 0) lines.push(`- 盲区：${shortBlind(mission.blind)}`)
    lines.push(`- ${conformanceNextStep(mission)}`)
    return lines
}

/**
 * Render the whole operator view: four questions, in order, and nothing else.
 * @param input - the report, the attention queue and the conformance overview.
 * @returns the text `suite_status` returns.
 */
export function renderOperatorView(input: OperatorInput): string {
    const queue = renderAttentionQueue(input)
    const lines: string[] = []
    lines.push('# suite_status — 操作者视图')
    lines.push('')
    lines.push(`工作区：${input.report.cwd}`)
    lines.push('')
    lines.push(`## 1. ${OPERATOR_QUESTIONS[0]}`)
    lines.push('')
    lines.push(...queue.lines)
    lines.push('')
    lines.push(`## 2. ${OPERATOR_QUESTIONS[1]}`)
    lines.push('')
    lines.push(...renderHealth(input.report))
    lines.push('')
    // The exact title is pinned by the design: `## 3 ` (no dot after the number).
    lines.push(`## 3 ${OPERATOR_QUESTIONS[2]}`)
    lines.push('')
    lines.push(...renderConformanceSection(input.conformance))
    lines.push('')
    lines.push(`## 4. ${OPERATOR_QUESTIONS[3]}`)
    lines.push('')
    lines.push(`- ${HISTORY_POINTER}`)
    return lines.join('\n')
}

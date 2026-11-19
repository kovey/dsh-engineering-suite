/**
 * The human review of a split plan, through the host approval seam (AC-003).
 *
 * The split workflow's second stage exists so that a PERSON — not the model that
 * wrote the plan — decides whether the decomposition may dispatch workers. The
 * seam is the host's own (`ctx.get('approval')`) — the SAME one `spec_approve`
 * asks through, so an IM card, a TUI popup or a terminal prompt all work without
 * this plugin knowing which one answered, and nothing extra has to be configured.
 *
 * Four answers, one mapping, fail closed:
 *
 *  - `allowed-once` → the review record is written for EXACTLY the digest the
 *    person saw, and the exit gate passes;
 *  - `rejected` → a rejection record is written (it is what bounds the rework
 *    rounds), and the stage rolls back to `split` for a re-plan;
 *  - `cancelled` / `unavailable` → NO record at all: nobody decided, so the
 *    stage stays entered and can be retried;
 *  - no seam mounted → refused by name (「宿主没有 approval 接缝」), never assumed;
 *  - session policy `never` → refused by name BEFORE asking, because the host's
 *    `request()` answers `rejected` without ever showing a card — counting that
 *    as a human rejection would degrade the plan without anyone judging it
 *    (see `split-approval-policy.ts`).
 *
 * A stale review (`plan 已改动`) re-asks and, when rejected, records why the old
 * decision no longer applied. Nothing here trusts the answerer's prose: the
 * decision word is the whole input, and the digest binding is re-checked when
 * the record is written.
 *
 * @module dsh-orchestrator/split-approval
 */

import path from 'node:path'
import { approverName, normalizeApprovalReply, renderApprovalContext, type ApprovalLike, type ApprovalOutcome } from 'dsh-eng-core'
import { readSplitPlan, recordSplitReview, splitReviewStatus, type SplitPlan, type SplitReviewRecord } from 'dsh-eng-core/split'
import type { GateFacts } from './gate-facts.js'
import { neverPolicyRefusal, readSessionApprovalPolicy } from './split-approval-policy.js'

/** What the ask decided for this advance. */
export type SplitReviewAskKind = 'skipped' | 'approved' | 'rejected' | 'blocked'

/** The answer of {@link askSplitReview}. */
export interface SplitReviewAskResult {
    /** `skipped`/`approved`/`rejected` let the caller continue; `blocked` refuses. */
    kind: SplitReviewAskKind
    /** Chinese explanation for the report. */
    detail: string
    /** The concrete next step, when blocked. */
    fix?: string
    /** The normalised decision, when a person answered. */
    answer?: ApprovalOutcome['decision']
    /** The written review record, when one was written. */
    record?: SplitReviewRecord
}

/** Input of {@link askSplitReview}. */
export interface SplitReviewAskInput {
    facts: GateFacts
    /** The host approval seam, read at call time. */
    approval?: ApprovalLike
    /** The calling agent (passed to the seam). */
    agent?: unknown
    /**
     * Diagnostics sink. Used ONLY for "the session policy could not be read":
     * that is a log line, never a refusal (AC-002).
     */
    log?: (message: string) => void
    signal?: AbortSignal
    /** Timestamp override (tests). */
    at?: number
}

/** The listed tasks of a plan, capped so one card stays readable. */
function taskLines(plan: SplitPlan): string[] {
    const shown = plan.tasks.slice(0, 12).map((task) => {
        const deps = task.dependsOn.length === 0 ? '' : `；依赖 ${task.dependsOn.join(',')}`
        return `- ${task.id}：${task.goal}（paths ${task.paths.join(' ') || '-'}；AC ${task.acceptance.join(',') || '-'}${deps}）`
    })
    if (plan.tasks.length > shown.length) shown.push(`- …（另有 ${plan.tasks.length - shown.length} 条，见 plan.json）`)
    return shown
}

/** The prose a human reads before deciding. */
function reviewPrompt(facts: GateFacts, plan: SplitPlan, digest: string, stale: string | undefined): string {
    return [
        `拆分计划审核（mission ${facts.mission.id} · ${facts.mission.title}）`,
        '',
        `plan 摘要：${digest}`,
        `子任务 ${plan.tasks.length} 条，并行组 ${plan.parallelGroups.length} 个。`,
        ...(stale === undefined ? [] : ['', `注意：${stale}`]),
        '',
        '任务：',
        ...taskLines(plan),
        '',
        '批准后才会派发第一个 worker；打回则重新拆分。',
    ].join('\n')
}

/** Relative path of the plan, for the card's artifact list. */
function planRelative(facts: GateFacts): string[] {
    return [path.relative(facts.store.layout.cwd, path.join(facts.store.layout.missionsDir, facts.mission.id, 'split', 'plan.json'))]
}

/** The refusal for "nobody could be asked": never an approval. */
function noSeam(): SplitReviewAskResult {
    return {
        kind: 'blocked',
        detail:
            '宿主没有 approval 接缝：ctx.get("approval") 为空，无法人工审核这份拆分；本轮未写任何审核记录。' +
            'split-review 与 spec_approve 使用同一条宿主接缝（跟随当前运行界面 tui/web/desktop；配置了 IM 即走 IM），不需要任何额外配置。',
        fix: '让宿主装配它本来就有的人工审批面（终端 / desktop / web TUI 的审批插件，或 IM 通道）后重试；拆分审核是硬门禁，没有"自动通过"这条路径（除非由人把 split.reviewRequired 关掉，那仍是宿主的决定）。',
    }
}

/** One decision to write: the seam's answer, and what the human was shown. */
interface RecordRequest {
    facts: GateFacts
    input: SplitReviewAskInput
    /** The digest the person SAW (re-checked against the plan on disk). */
    digest: string
    outcome: ApprovalOutcome
    decision: 'approved' | 'rejected'
    note?: string
}

/** Record one decision; a recording failure is a refusal, never a silent pass. */
function record(request: RecordRequest): { record?: SplitReviewRecord; problem?: string } {
    const { facts, input, digest, outcome, decision, note } = request
    const written = recordSplitReview(facts.store.layout, facts.mission.id, {
        approver: approverName(outcome),
        decision,
        // An edit made while the card was open refuses here, by digest.
        planDigest: digest,
        ...(note === undefined ? {} : { note }),
        at: input.at ?? outcome.at ?? Date.now(),
        ...(outcome.source === '' || outcome.source === 'unknown' ? {} : { source: outcome.source }),
    })
    if (written.ok) return { record: written.record }
    return { problem: written.problems.join('；') }
}

/** The written-approval branch. */
function approved(facts: GateFacts, input: SplitReviewAskInput, digest: string, outcome: ApprovalOutcome): SplitReviewAskResult {
    const written = record({ facts, input, digest, outcome, decision: 'approved' })
    if (written.record === undefined) {
        return {
            kind: 'blocked',
            answer: outcome.decision,
            detail: `人工批准了拆分，但审核记录写入失败：${written.problem ?? '未知原因'}。这通常意味着 plan 在等卡期间被改动（摘要不再匹配），那正是"必须重审"的情形。`,
            fix: '确认 plan 已定稿后重新 advance 并重新审核；未写进审核记录的批准不构成放行。',
        }
    }
    return { kind: 'approved', answer: outcome.decision, record: written.record, detail: `人工已批准拆分（第 ${written.record.round} 轮，by ${written.record.approver}）` }
}

/** The written-rejection branch (the rejection bounds the rework rounds). */
function rejected(facts: GateFacts, input: SplitReviewAskInput, digest: string, outcome: ApprovalOutcome, note: string | undefined): SplitReviewAskResult {
    const written = record({ facts, input, digest, outcome, decision: 'rejected', ...(note === undefined ? {} : { note }) })
    if (written.record === undefined) {
        return { kind: 'blocked', answer: outcome.decision, detail: `审核被拒，但审核记录写入失败：${written.problem ?? '未知原因'}`, fix: '修好 plan 目录后重新 advance。' }
    }
    return {
        kind: 'rejected',
        answer: outcome.decision,
        record: written.record,
        detail: `审核被拒（第 ${written.record.round} 轮，by ${written.record.approver}${note === undefined ? '' : `：${note}`}）：需要重新拆分`,
    }
}

/** Map the answerer's decision to the review record (the whole contract). */
function decide(facts: GateFacts, input: SplitReviewAskInput, digest: string, outcome: ApprovalOutcome, stale: string | undefined): SplitReviewAskResult {
    switch (outcome.decision) {
        case 'allowed-once':
            return approved(facts, input, digest, outcome)
        case 'rejected':
            return rejected(facts, input, digest, outcome, stale)
        case 'cancelled':
            return {
                kind: 'blocked',
                answer: outcome.decision,
                detail: '审核被取消（cancelled）：没有决定 = 不放行；本轮未写任何审核记录，拆分计划保持待审。',
                fix: '重新 advance 并再次审核；或先修好拆分计划再送审。',
            }
        default:
            return {
                kind: 'blocked',
                answer: outcome.decision,
                detail: '没有应答者（unavailable）：审批通道没有给出任何决定；本轮未写任何审核记录。',
                fix: '确认审批通道可达（IM 会话仍然有效 / 有人在看卡）后重新 advance。',
            }
    }
}

/**
 * Ask a human whether this plan may dispatch workers.
 *
 * An already-approved plan for the CURRENT digest is not asked again ("skipped"):
 * re-asking would let a second card undo a decision the first one already made.
 * @param input - gate facts, the seam and the caller's agent/signal.
 * @returns the decision; `blocked` means the caller must not settle the stage.
 */
export async function askSplitReview(input: SplitReviewAskInput): Promise<SplitReviewAskResult> {
    const { facts } = input
    const missionId = facts.mission.id
    const stored = readSplitPlan(facts.store.layout, missionId)
    if (stored === undefined) return { kind: 'skipped', detail: `mission ${missionId} 没有拆分计划：无需审核` }
    const status = splitReviewStatus(facts.store.layout, missionId)
    if (status.ok) return { kind: 'skipped', detail: status.detail }
    if (input.approval === undefined) return noSeam()
    // BEFORE asking: a `never` session gets no card, only an automatic
    // `rejected`. Recording that as a human rejection would burn a rework round
    // — so it is read here and refused by name instead (AC-001).
    const policy = readSessionApprovalPolicy(input.approval, input.agent)
    if (policy.problem !== undefined) input.log?.(`split-review：读不到本会话审批策略（${policy.problem}），按原逻辑照常提问`)
    if (policy.policy === 'never') {
        input.log?.('split-review：本会话审批策略为 never（提示被禁用）：不提问、不写审核记录，直接 BLOCK')
        return { kind: 'blocked', ...neverPolicyRefusal() }
    }
    const stale =
        status.state === 'stale'
            ? `plan 已改动（旧审核摘要 ${status.record?.planDigest.slice(0, 12) ?? '(无)'}，当前摘要 ${stored.digest.slice(0, 12)}），必须重新审核`
            : undefined
    const prompt = reviewPrompt(facts, stored.plan, stored.digest, stale)
    const reason = renderApprovalContext(prompt, {
        kind: 'split',
        missionId,
        title: facts.mission.title,
        revision: stored.digest,
        artifacts: planRelative(facts),
        facts: { 子任务: stored.plan.tasks.length, 并行组: stored.plan.parallelGroups.length, 审核轮次: status.record?.round ?? 0 },
        channelHints: { buttons: ['批准', '打回'], requiresReason: true },
    })
    const reply = await input.approval.request({
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        toolName: 'orchestrate',
        reason,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return decide(facts, input, stored.digest, normalizeApprovalReply(reply), stale)
}

/** Input of {@link splitReviewGateRefusal}: the stage plus the caller's context. */
export interface SplitReviewGateInput {
    facts: GateFacts
    stageId: string
    /** The host approval seam accessor (`SequenceDeps.approval`), read here. */
    approval?: () => ApprovalLike | undefined
    agent?: unknown
    /** Diagnostics sink forwarded to {@link askSplitReview} (policy read). */
    log?: (message: string) => void
    signal?: AbortSignal
}

/**
 * The advance-time gate for `split-review`: ask, then decide whether the stage
 * may be settled.
 *
 * Kept here (not in `sequence.ts`) so the refusal text and the mapping live next
 * to the decision they describe, and so the sequence module only sees "is there
 * a refusal to return". The stage stays `entered` on a refusal, which is what
 * makes retrying after fixing the channel free.
 * @param input - gate facts, the stage id, the seam accessor and the caller.
 * @returns the refusal report, or `undefined` when the advance may continue.
 */
export async function splitReviewGateRefusal(input: SplitReviewGateInput): Promise<string | undefined> {
    const asked = await askSplitReview({
        facts: input.facts,
        approval: input.approval?.(),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.log === undefined ? {} : { log: input.log }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (asked.kind !== 'blocked') return undefined
    return [
        `阶段 ${input.stageId} 未通过：${asked.detail}`,
        ...(asked.fix === undefined ? [] : [`修复：${asked.fix}`]),
        '',
        `下一步：处理好上面的问题后重新调用 orchestrate({ action: "advance" })；阶段 ${input.stageId} 保持 entered（重试不消耗尝试次数）。`,
    ].join('\n')
}

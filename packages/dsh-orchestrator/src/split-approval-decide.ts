/**
 * What a split-review answer MEANS: the four-answer mapping and the record.
 *
 * Split out from `split-approval.ts` so there is exactly ONE mapping, whether the
 * answer arrived through the TUI menu or the host approval seam: `allowed-once`
 * writes the approval for the digest the person saw, `rejected` writes a
 * rejection (it is what bounds the rework rounds) and rolls the stage back,
 * `cancelled`/`unavailable` write NOTHING and leave the stage entered — "nobody
 * decided" is never a pass. A route decides only which surface asked; it never
 * decides what the answer means.
 *
 * Nothing here trusts the answerer's prose: the decision word is the whole
 * input, and the digest binding is re-checked when the record is written (a plan
 * edited while the card was open refuses by digest).
 *
 * @module dsh-orchestrator/split-approval-decide
 */

import { approverName, type ApprovalLike, type ApprovalOutcome } from 'dsh-eng-core'
import { recordSplitReview, type SplitReviewRecord } from 'dsh-eng-core/split'
import type { GateFacts } from './gate-facts.js'

/** What the ask decided for this advance. */
export type SplitReviewAskKind = 'skipped' | 'approved' | 'rejected' | 'blocked'

/** The answer of `askSplitReview`. */
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

/** Input of the ask (whichever route asks). */
export interface SplitReviewAskInput {
    facts: GateFacts
    /** The host approval seam, read at call time. */
    approval?: ApprovalLike
    /**
     * The host's OPTIONAL `nvim-tui` extension API, read at call time
     * (`ctx.get('nvim-tui')`). Present = the review is asked with the SAME menu
     * + read-only preview `spec_approve` uses; absent = the approval seam.
     */
    nvimTui?: unknown
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

/** The refusal for "nobody could be asked": never an approval. */
export function noSeam(): SplitReviewAskResult {
    return {
        kind: 'blocked',
        detail:
            '宿主没有 approval 接缝：ctx.get("approval") 为空，无法人工审核这份拆分；本轮未写任何审核记录。' +
            'split-review 与 spec_approve 使用同一条宿主接缝（跟随当前运行界面 tui/web/desktop；配置了 IM 即走 IM），不需要任何额外配置。',
        fix: '让宿主装配它本来就有的人工审批面（终端 / desktop / web TUI 的审批插件，或 IM 通道）后重试；拆分审核是硬门禁，没有"自动通过"这条路径（除非由人把 split.reviewRequired 关掉，那仍是宿主的决定）。',
    }
}

/** One decision to write: the answerer's word, and what the human was shown. */
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

/**
 * Map the answerer's decision to the review record (the whole contract).
 * @param facts - gate facts (layout + mission).
 * @param input - the caller's context (timestamp override).
 * @param digest - the digest the person was shown.
 * @param outcome - the normalised answer.
 * @param note - the human's reason (a stale-plan warning on the seam route).
 */
export function decide(facts: GateFacts, input: SplitReviewAskInput, digest: string, outcome: ApprovalOutcome, note: string | undefined): SplitReviewAskResult {
    switch (outcome.decision) {
        case 'allowed-once':
            return approved(facts, input, digest, outcome)
        case 'rejected':
            return rejected(facts, input, digest, outcome, note)
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

/**
 * The human review of a split plan (AC-003).
 *
 * A plan is reviewed ONCE per version, and the version is its digest: the
 * review record stores that digest, so "approved" is a statement about exactly
 * the document a person saw. Edit the plan afterwards and the digest no longer
 * matches — the review is stale, and nothing may be dispatched or imported on
 * the strength of it.
 *
 * This round deliberately does NOT wire the host approval seam (that is the next
 * round's work): the review is recorded through {@link recordSplitReview}, which
 * refuses a digest that does not match the plan on disk. The gate in the
 * orchestrator only ever reads the record; it cannot be talked into an approval
 * by a model.
 *
 * @module dsh-eng-core/split-review
 */

import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from './io.js'
import type { Layout } from './paths.js'
import { readSplitPlan, splitReviewFile, splitReviewsFile } from './split-plan.js'

/** One human decision on one plan version. */
export type SplitReviewDecision = 'approved' | 'rejected'

/** The durable review record (`missions/<id>/split/review.json`). */
export interface SplitReviewRecord {
    missionId: string
    /** Who decided (an identity the caller could prove; `approval` when unnamed). */
    approver: string
    /** Decision time (epoch ms). */
    at: number
    /** Digest of the plan version that was reviewed. */
    planDigest: string
    decision: SplitReviewDecision
    /** 1-based review round (a rejection sends the planner back). */
    round: number
    /** The reviewer's note, when they gave one. */
    note?: string
    /** Which surface decided (`seam` / `im` / `tui`), when known. */
    source?: string
}

/** Input of {@link recordSplitReview}. */
export interface SplitReviewInput {
    approver: string
    decision: SplitReviewDecision
    /** Digest the reviewer saw; a mismatch with the plan on disk is refused. */
    planDigest?: string
    note?: string
    at?: number
    source?: string
}

/** Outcome of a review write. */
export interface SplitReviewWrite {
    ok: boolean
    record?: SplitReviewRecord
    problems: string[]
}

/** How a plan currently stands against its review. */
export type SplitReviewState = 'missing-plan' | 'missing-review' | 'rejected' | 'stale' | 'approved'

/** The composition of "plan on disk" and "review record". */
export interface SplitReviewStatus {
    state: SplitReviewState
    /** `true` only for `approved` (and only for the CURRENT plan digest). */
    ok: boolean
    detail: string
    planDigest?: string
    record?: SplitReviewRecord
}

/** The `reviews.jsonl` history (oldest first). */
export function readSplitReviews(layout: Layout, missionId: string): SplitReviewRecord[] {
    return readJsonl<SplitReviewRecord>(splitReviewsFile(layout, missionId))
}

/** The latest review record, or `undefined` when nobody reviewed the plan yet. */
export function readSplitReview(layout: Layout, missionId: string): SplitReviewRecord | undefined {
    return readJson<SplitReviewRecord>(splitReviewFile(layout, missionId))
}

/**
 * How many times a human REJECTED this mission's plan (all digits, every
 * version).
 *
 * The count is cumulative on purpose: `split.maxReworkRounds` bounds how many
 * re-plan rounds the workflow is willing to pay for, and re-planning produces a
 * new digest each time. Counting only the CURRENT digest would restart the
 * budget on every edit, which is exactly the loop the limit exists to stop.
 * @param layout - the workspace layout.
 * @param missionId - the mission whose review history to count.
 * @returns `0` when nobody rejected anything yet.
 */
export function splitRejectionCount(layout: Layout, missionId: string): number {
    return readSplitReviews(layout, missionId).filter((record) => record.decision === 'rejected').length
}

/**
 * Write one review decision.
 *
 * Refuses (without writing) when there is no plan, when the caller's digest does
 * not match the plan on disk, or when the input is incomplete: a review that
 * points at a plan nobody can find is not a review.
 * @param layout - the workspace layout.
 * @param missionId - the mission whose plan is reviewed.
 * @param input - decision, reviewer and (optionally) the digest that was seen.
 */
export function recordSplitReview(layout: Layout, missionId: string, input: SplitReviewInput): SplitReviewWrite {
    const problems: string[] = []
    const approver = typeof input.approver === 'string' ? input.approver.trim() : ''
    if (approver === '') problems.push('审核记录必须写明 approver（谁做的决定）')
    if (input.decision !== 'approved' && input.decision !== 'rejected') problems.push(`decision 只能是 approved / rejected（收到 ${JSON.stringify(input.decision)}）`)
    const plan = readSplitPlan(layout, missionId)
    if (plan === undefined) return { ok: false, problems: [...problems, `mission ${missionId} 还没有拆分计划（split/plan.json 缺失）：没有可审核的对象`] }
    if (input.planDigest !== undefined && input.planDigest !== plan.digest) {
        problems.push(
            `审核记录引用的 plan 摘要 ${input.planDigest.slice(0, 12)} 与当前 plan 摘要 ${plan.digest.slice(0, 12)} 不一致：plan 已改动，拒绝写入这次审核`,
        )
    }
    if (problems.length > 0) return { ok: false, problems }
    const record: SplitReviewRecord = {
        missionId,
        approver,
        at: input.at ?? Date.now(),
        planDigest: plan.digest,
        decision: input.decision,
        round: readSplitReviews(layout, missionId).length + 1,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.source === undefined ? {} : { source: input.source }),
    }
    writeJsonAtomic(splitReviewFile(layout, missionId), record)
    appendJsonl(splitReviewsFile(layout, missionId), record)
    return { ok: true, record, problems: [] }
}

/**
 * Compose the plan on disk with its latest review.
 * @param layout - the workspace layout.
 * @param missionId - the mission to inspect.
 */
export function splitReviewStatus(layout: Layout, missionId: string): SplitReviewStatus {
    const plan = readSplitPlan(layout, missionId)
    if (plan === undefined) {
        return { state: 'missing-plan', ok: false, detail: `mission ${missionId} 还没有拆分计划（split/plan.json 缺失）` }
    }
    const record = readSplitReview(layout, missionId)
    if (record === undefined) {
        return {
            state: 'missing-review',
            ok: false,
            planDigest: plan.digest,
            detail: `plan 摘要 ${plan.digest.slice(0, 12)} 还没有人工审核记录（split/review.json 缺失）`,
        }
    }
    if (record.planDigest !== plan.digest) {
        return {
            state: 'stale',
            ok: false,
            planDigest: plan.digest,
            record,
            detail: `审核针对的是 plan 摘要 ${record.planDigest.slice(0, 12)}，当前 plan 摘要 ${plan.digest.slice(0, 12)}：plan 已改动，必须重新审核`,
        }
    }
    if (record.decision === 'rejected') {
        return {
            state: 'rejected',
            ok: false,
            planDigest: plan.digest,
            record,
            detail: `审核被拒（第 ${record.round} 轮，by ${record.approver}${record.note === undefined ? '' : `：${record.note}`}）：需要重新拆分`,
        }
    }
    return {
        state: 'approved',
        ok: true,
        planDigest: plan.digest,
        record,
        detail: `plan 摘要 ${plan.digest.slice(0, 12)} 已由 ${record.approver} 于第 ${record.round} 轮通过`,
    }
}

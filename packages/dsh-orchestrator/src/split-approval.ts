/**
 * The human review of a split plan: WHICH surface asks, on both routes.
 *
 * The split workflow's second stage exists so that a PERSON — not the model that
 * wrote the plan — decides whether the decomposition may dispatch workers. Two
 * surfaces can ask, and they are the same ones `spec_approve` uses:
 *
 *  - **`nvim-tui`** (`ctx.get('nvim-tui')`): the menu + read-only preview of
 *    `split/plan.md` (`split-review-tui.ts`), so a reviewer can READ the plan;
 *  - **the host approval seam** (`ctx.get('approval')`): one blocking question
 *    whose reason is the same review sheet and whose artifacts name
 *    `split/plan.md` — desktop / web / headless / IM, nothing extra configured.
 *
 * This module decides the ROUTE and the policy guard; what an answer MEANS (the
 * four-answer mapping and the review record) lives in `split-approval-decide.ts`
 * and is shared by both routes, so they cannot drift apart.
 *
 * The policy guard exists because a `never` session gets an automatic `rejected`
 * with no card shown: recording that as a human rejection would burn a rework
 * round without anyone judging the plan (see `split-approval-policy.ts`). It is
 * read BEFORE either route asks — the TUI route bypasses the host prompt, so it
 * must not bypass the person's "do not ask me" setting either (AC-004).
 *
 * A stale review (`plan 已改动`) re-asks and, when rejected, records why the old
 * decision no longer applied.
 *
 * @module dsh-orchestrator/split-approval
 */

import path from 'node:path'
import { normalizeApprovalReply, renderApprovalContext, type ApprovalLike, type ApprovalOutcome } from 'dsh-eng-core'
import { readSplitPlan, splitReviewStatus, type StoredSplitPlan } from 'dsh-eng-core/split'
import type { GateFacts } from './gate-facts.js'
import { neverPolicyRefusal, readSessionApprovalPolicy } from './split-approval-policy.js'
import { decide, noSeam, type SplitReviewAskInput, type SplitReviewAskResult } from './split-approval-decide.js'
import { reviewPrompt, splitMenuTitle, splitPlanArtifacts } from './split-review-prompt.js'
import { nvimTuiMenuOf, splitReviewMenu, SPLIT_REVIEW_TIMEOUT_MS, type NvimTuiMenuApi } from './split-review-tui.js'

export type { SplitReviewAskInput, SplitReviewAskKind, SplitReviewAskResult } from './split-approval-decide.js'

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
    const tui = nvimTuiMenuOf(input.nvimTui)
    // Neither route mounted: refuse by name (a missing channel is never a pass).
    if (input.approval === undefined && tui === undefined) return noSeam()
    // BEFORE asking — on EITHER route: a `never` session gets no card, only an
    // automatic `rejected`. Recording that as a human rejection would burn a
    // rework round, so it is read here and refused by name instead (AC-004).
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
    // Same experience as spec_approve when the host is the TUI: menu + read-only
    // preview. A TUI that cannot ask hands over to the seam instead of failing.
    const viaTui = await askThroughTui(input, tui, stored, stale)
    if (viaTui !== undefined) return viaTui
    return askThroughSeam(facts, input, stored, stale)
}

/** Ask through the TUI menu (the spec review's shape), or hand over when it cannot ask. */
async function askThroughTui(
    input: SplitReviewAskInput,
    tui: NvimTuiMenuApi | undefined,
    stored: StoredSplitPlan,
    stale: string | undefined,
): Promise<SplitReviewAskResult | undefined> {
    if (tui === undefined) return undefined
    const layout = input.facts.store.layout
    const outcome = await splitReviewMenu({
        api: tui,
        title: splitMenuTitle(input.facts, stored),
        planFile: path.join(layout.missionsDir, input.facts.mission.id, 'split', 'plan.md'),
        cwd: layout.cwd,
        timeoutMs: SPLIT_REVIEW_TIMEOUT_MS,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.log === undefined ? {} : { log: input.log }),
    })
    if (outcome.decision === 'unavailable') {
        input.log?.('split-review：nvim-tui 的提问通道不可用（没有 picker）：回落到宿主 approval 接缝')
        return undefined
    }
    // The TUI's vocabulary is mapped ONCE, here, into the seam's: approve →
    // `allowed-once`, everything else keeps its word. The record write below
    // cannot tell which route asked (`source` does), so both routes cannot drift.
    const decision = outcome.decision === 'approved' ? 'allowed-once' : outcome.decision
    const normalized: ApprovalOutcome = {
        decision,
        by: 'approval',
        messageId: '',
        source: 'tui',
        allowed: decision === 'allowed-once',
        ...(input.at === undefined ? {} : { at: input.at }),
    }
    return decide(input.facts, input, stored.digest, normalized, outcome.note ?? stale)
}

/** Ask through the generic host seam (desktop / web / headless / IM). */
async function askThroughSeam(
    facts: GateFacts,
    input: SplitReviewAskInput,
    stored: StoredSplitPlan,
    stale: string | undefined,
): Promise<SplitReviewAskResult> {
    const approval = input.approval
    if (approval === undefined) return noSeam()
    const prompt = reviewPrompt(facts, stored.plan, stored.digest, stale)
    const reason = renderApprovalContext(prompt, {
        kind: 'split',
        missionId: facts.mission.id,
        title: facts.mission.title,
        revision: stored.digest,
        artifacts: splitPlanArtifacts(facts),
        facts: { 子任务: stored.plan.tasks.length, 并行组: stored.plan.parallelGroups.length, 审核轮次: splitReviewStatus(facts.store.layout, facts.mission.id).record?.round ?? 0 },
        channelHints: { buttons: ['批准', '打回'], requiresReason: true },
    })
    const reply = await approval.request({
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
    /** The host's OPTIONAL `nvim-tui` accessor (`SequenceDeps.nvimTui`). */
    nvimTui?: () => unknown
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
        ...(input.nvimTui === undefined ? {} : { nvimTui: input.nvimTui() }),
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

/**
 * The split review on the TUI: the SAME shape as `spec_approve`.
 *
 * `spec_approve` asks a person with a `ui.picker` menu plus a read-only preview
 * of the document they are being asked about. `split-review` used to ask through
 * the generic approval seam only — one text card, no document to open — so the
 * person who has to decide "may these workers run?" could not READ the plan they
 * were judging. AC-002 closes that gap: when the host provides the `nvim-tui`
 * extension API, the split review is the same menu:
 *
 *  - 「查看拆分计划（只读预览）」 opens `split/plan.md` with the SAME preview
 *    implementation `spec_approve` uses (`dsh-eng-core/preview`); `q` closes it
 *    and the menu comes back;
 *  - 「✅ 批准并派发」 / 「🛑 打回重写」 / 「取消」 are the four decisions, and
 *    nothing else — opening the document never decides anything.
 *
 * This module only ASKS. The mapping to a review record (approved / rejected /
 * no record) and the policy `never` refusal stay in `split-approval.ts`, so the
 * TUI route and the approval seam cannot drift apart. A host without nvim-tui
 * keeps the seam route; a TUI that cannot answer (`unavailable`) hands over to
 * the seam instead of failing the review.
 *
 * @module dsh-orchestrator/split-review-tui
 */

import fs from 'node:fs'
import path from 'node:path'
import { describePreview, previewArtifact, releasePreview, waitForPreview, type NvimTuiPreviewApi } from 'dsh-eng-core/preview'

/** Action values of the menu (prefixed so no typed note can collide with them). */
export const SPLIT_ACTION = {
    preview: 'split:preview',
    approve: 'split:approve',
    reject: 'split:reject',
    cancel: 'split:cancel',
} as const

/** The one preview surface the split review claims in the TUI layout. */
const SPLIT_PREVIEW_SLOT = 'dsh-orchestrator:split-review'

/** How many times the menu may come back before the review gives up. */
const MAX_MENU_STEPS = 20

/** Default give-up time for a menu nobody answers (the stage stays entered). */
export const SPLIT_REVIEW_TIMEOUT_MS = 15 * 60_000

/** Item value that leaves the rejection popup without deciding. */
const BACK_VALUE = 'split:back'

/** Marker value for "I will explain in chat". */
const REJECT_OTHER = 'split-reject:other'

/** Canned rejection reasons (the split review's own findings, not the spec's). */
const REJECT_REASONS: readonly string[] = [
    '任务粒度不合适（太粗或太碎）',
    '路径或依赖划分不对',
    '验收标准映射不对或有遗漏',
    '并行组划分有风险',
]

/** Structural view of the `nvim-tui` surface this menu needs. */
export interface NvimTuiMenuApi extends NvimTuiPreviewApi {
    ui: NvimTuiPreviewApi['ui'] & {
        picker?: (opts: { title: string; items: { label: string; value: string; active?: boolean }[] }) => Promise<string | null>
    }
}

/** What the menu was given to ask about. */
export interface SplitMenuInput {
    api: NvimTuiMenuApi
    /** Menu title: the mission and the plan identity. */
    title: string
    /** Absolute path of the reviewable document (`split/plan.md`). */
    planFile: string
    /** Workspace root, so the menu spells the artifact path relatively. */
    cwd: string
    /** Give up after this long (epoch-ms budget in `timeoutMs`). */
    timeoutMs: number
    signal?: AbortSignal
    log?: (message: string) => void
}

/** The menu's answer, in the same vocabulary the seam path uses. */
export interface SplitMenuOutcome {
    decision: 'approved' | 'rejected' | 'cancelled' | 'unavailable'
    /** The human's typed/canned reason, when they rejected with one. */
    note?: string
}

/** Outcome of the rejection-reason popup (`back` decides nothing). */
type RejectAnswer = { kind: 'reason'; note?: string } | { kind: 'back' }

/**
 * Read the host's optional `nvim-tui` service as a review menu.
 *
 * Structural on purpose (the same discipline as every other host surface in the
 * suite): an absent service is a normal desktop/web/headless host, an `nvim-tui`
 * without a `picker` cannot ask anything, and a throwing capability probe only
 * makes the answer unknown — never "the human said no".
 * @param service - whatever `ctx.get('nvim-tui')` returned (untrusted shape).
 * @returns the menu view, or `undefined` when this host cannot host the menu.
 */
export function nvimTuiMenuOf(service: unknown): NvimTuiMenuApi | undefined {
    if (typeof service !== 'object' || service === null) return undefined
    const candidate = service as Partial<NvimTuiMenuApi>
    if (typeof candidate.nvim !== 'object' || candidate.nvim === null) return undefined
    if (typeof candidate.ui !== 'object' || candidate.ui === null) return undefined
    if (typeof candidate.ui.picker !== 'function') return undefined
    try {
        if ((candidate.capabilities?.() ?? {})['picker'] === false) return undefined
    } catch {
        // A capability probe that throws does not delete the picker.
    }
    return candidate as NvimTuiMenuApi
}

/** The document the preview opens: `plan.md`, or `plan.json` when it is missing. */
function reviewableFile(planFile: string, log: ((message: string) => void) | undefined): string {
    if (fs.existsSync(planFile)) return planFile
    const fallback = path.join(path.dirname(planFile), 'plan.json')
    log?.(`拆分审核：${planFile} 不存在（旧版本写入的 plan？），只读预览改用 ${fallback}`)
    return fallback
}

/** The four menu entries (and never a fifth: one preview, three decisions). */
function menuItems(input: SplitMenuInput, target: string): { label: string; value: string }[] {
    const relative = path.relative(input.cwd, target) || target
    return [
        { label: `查看拆分计划（只读预览，q 关闭） — ${relative}`, value: SPLIT_ACTION.preview },
        { label: '✅ 批准并派发（写审核记录，进入 implement）', value: SPLIT_ACTION.approve },
        { label: '🛑 打回重写（说明要改什么，回到 split 重新拆）', value: SPLIT_ACTION.reject },
        { label: '取消（不写审核记录，阶段保持 entered）', value: SPLIT_ACTION.cancel },
    ]
}

/** Open the plan in the shared read-only preview, waiting for `q` when it owns the screen. */
async function previewPlan(input: SplitMenuInput, target: string, deadline: number): Promise<void> {
    const placement = await previewArtifact(input.api, target, '拆分计划', { slot: SPLIT_PREVIEW_SLOT })
    const described = describePreview(target, placement)
    input.api.ui.notice?.(described)
    input.log?.(described)
    if (placement !== 'viewer') return
    const closed = await waitForPreview(input.api, placement, deadline, input.signal)
    input.log?.(closed ? '预览已关闭，重新弹出拆分审核菜单' : '预览未关闭/超时，继续拆分审核')
}

/**
 * Second step of a rejection: why, in one more popup.
 * @param api - the menu view.
 * @returns the reason, or `back` when the human left the popup (never a silent rejection).
 */
async function askRejectReason(api: NvimTuiMenuApi): Promise<RejectAnswer> {
    const picker = api.ui.picker
    if (picker === undefined) return { kind: 'reason' }
    const items = [
        ...REJECT_REASONS.map((reason) => ({ label: reason, value: `split-reject:${reason}` })),
        { label: '其它（我直接在对话里说明）', value: REJECT_OTHER },
        { label: '↩︎ 返回拆分审核菜单（先不打回，Esc）', value: BACK_VALUE },
    ]
    const chosen = await picker({ title: '打回原因（拆分要改什么）', items })
    if (chosen === null || chosen === undefined || chosen === BACK_VALUE) return { kind: 'back' }
    if (chosen === REJECT_OTHER) return { kind: 'reason' }
    return { kind: 'reason', note: chosen.startsWith('split-reject:') ? chosen.slice('split-reject:'.length) : chosen }
}

/** The rejection branch: ask why, release the preview, and report the outcome. */
async function rejectOutcome(api: NvimTuiMenuApi): Promise<SplitMenuOutcome | undefined> {
    const answer = await askRejectReason(api)
    if (answer.kind === 'back') return undefined
    await releasePreview(api)
    return { decision: 'rejected', ...(answer.note === undefined ? {} : { note: answer.note }) }
}

/**
 * Ask for the split plan's review through the TUI menu.
 *
 * Opening the plan does NOT decide anything: the menu returns after every
 * preview so the human can read and then choose. Only approve/reject write a
 * review record (the caller does that); `cancel`, `Esc` and the step/time budget
 * are all "nobody decided" — never a pass.
 * @param input - the menu view, what to show, and the signals to honour.
 * @returns the decision in the seam's vocabulary (`unavailable` = this route could not ask).
 */
export async function splitReviewMenu(input: SplitMenuInput): Promise<SplitMenuOutcome> {
    const { api } = input
    if (api.ui.picker === undefined) return { decision: 'unavailable' }
    const deadline = Date.now() + Math.max(1_000, input.timeoutMs)
    const target = reviewableFile(input.planFile, input.log)
    const items = menuItems(input, target)
    for (let step = 0; step < MAX_MENU_STEPS; step += 1) {
        if (input.signal?.aborted === true || Date.now() > deadline) {
            await releasePreview(api)
            input.log?.(input.signal?.aborted === true ? '拆分审核被取消（本轮未做决定）' : '拆分审核超时未决定')
            return { decision: 'cancelled' }
        }
        const choice = await api.ui.picker({ title: input.title, items })
        if (choice === null || choice === undefined || choice === SPLIT_ACTION.cancel) {
            await releasePreview(api)
            return { decision: 'cancelled' }
        }
        if (choice === SPLIT_ACTION.approve) {
            await releasePreview(api)
            return { decision: 'approved' }
        }
        if (choice === SPLIT_ACTION.reject) {
            const answer = await rejectOutcome(api)
            if (answer === undefined) {
                input.log?.('打回已取消，返回拆分审核菜单')
                continue
            }
            return answer
        }
        // Anything else is the preview: open it, then show the menu again.
        await previewPlan(input, target, deadline)
    }
    await releasePreview(api)
    input.log?.(`拆分审核菜单已弹出 ${MAX_MENU_STEPS} 次仍未决定：本轮不做决定`)
    return { decision: 'cancelled' }
}

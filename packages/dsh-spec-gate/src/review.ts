/**
 * The human review channel for `spec_approve`.
 *
 * A specification is approved by a person who has to be able to READ it first.
 * Two channels implement that:
 *
 *  - **`nvim-tui`** (when the host provides its extension API, `ctx.get('nvim-tui')`):
 *    a card in the session feed lists the two directories and the two files,
 *    with actions to open them (`nvim.ex`) and two verdicts — approve, or
 *    reject with a typed note (`kind: 'input'`, which the TUI routes through
 *    the input box). Opening something never decides anything: the card stays
 *    until a verdict is chosen.
 *  - **`approval`** (the generic seam): one blocking question whose text is the
 *    same review sheet. Used on headless/web hosts and in tests.
 *
 * Both return the same {@link ReviewOutcome}, so the tool has exactly one
 * rejection path. A channel that cannot answer returns `unavailable` and the
 * caller moves on — never an approval.
 *
 * The read-only preview itself (the `q`-to-close viewer and its
 * viewer → panel → float → tab fallback chain) is NOT here: it lives in
 * `dsh-eng-core/preview`, because `split-review` asks a person to read the split
 * plan in exactly the same shape. One implementation, one behaviour.
 *
 * @module dsh-spec-gate/review
 */

import fs from 'node:fs'
import path from 'node:path'
import { describePreview, openPath, previewArtifact, releasePreview, waitForPreview, type NvimTuiPreviewApi, type PreviewPlacement } from 'dsh-eng-core/preview'

/** What the human decided. */
export interface ReviewOutcome {
    decision: 'approved' | 'rejected' | 'cancelled' | 'unavailable'
    /** Who/what decided (recorded on the mission). */
    by: string
    /** The human's note, when they typed one. */
    note?: string
}

/** The artifacts a reviewer is asked to read. */
export interface ReviewArtifacts {
    /** Absolute path of the rendered specification. */
    specFile: string
    /** Absolute path of the test-design review artifact. */
    designFile: string
    /** Absolute directory holding rendered specifications. */
    specsDir: string
    /** Absolute directory holding this mission's artifacts. */
    missionDir: string
}

/** One card action (`kind: 'input'` actions deliver the typed text instead). */
export interface ReviewAction {
    label: string
    value: string
    kind?: 'plain' | 'confirm' | 'input'
    inputPrompt?: string
}

/** Action values are prefixed so they can never collide with a typed note. */
export const ACTION = {
    openSpec: 'spec:open-spec',
    openDesign: 'spec:open-design',
    listSpecs: 'spec:list-specs',
    listDesign: 'spec:list-design',
    approve: 'spec:approve',
    reject: 'spec:reject',
    cancel: 'spec:cancel',
} as const

/** The panel slot this review's preview claims in the TUI layout. */
const SPEC_PREVIEW_SLOT = 'dsh-spec-gate:review'

/**
 * The card's actions — REVIEW ONLY, and never more than four.
 *
 * nvim-tui renders at most the first four actions on a card
 * (`feed.ts: actions.slice(0, 4)`), so a verdict placed after them would be
 * invisible. The verdict lives in the picker popup instead; the card is the
 * feed's record of what was reviewed, with shortcuts to open it.
 */
export function reviewCardActions(): ReviewAction[] {
    return [
        { label: '查看需求文档', value: ACTION.openSpec },
        { label: '查看测试用例', value: ACTION.openDesign },
        { label: '列出需求目录', value: ACTION.listSpecs },
        { label: '列出用例目录', value: ACTION.listDesign },
    ]
}

/** Canned rejection reasons (the picker's second step). */
export const REJECTION_REASONS: readonly string[] = [
    '验收标准不全或不准确',
    '测试用例不合格（覆盖/步骤/预期结果）',
    '文件边界或负面约束不对',
    '方案本身要换',
]

/** Marker value for "I will explain in chat". */
export const REJECT_OTHER = 'reject:other'

/**
 * Outcome of the rejection-reason popup.
 *
 * `back` exists so the secondary popup can be left without deciding: pressing
 * `Esc`/`q` there must return to the review menu, NOT record a rejection with
 * no reason (the first version made `Esc` mean "reject silently").
 */
export type RejectionAnswer = { kind: 'reason'; note?: string } | { kind: 'back' }

/** Structural view of the `nvim-tui` extension API (see its `kernel/ext-types.ts`). */
export interface NvimTuiLike extends NvimTuiPreviewApi {
    version: string
    ready?: Promise<void>
    /** Fill the input box without submitting (prefill for a chat explanation). */
    insertInput?: (text: string) => void
    ui: NvimTuiPreviewApi['ui'] & {
        card?: (opts: {
            sessionId?: string
            plugin: string
            title: string
            body: string
            actions?: { label: string; value: string; kind?: 'plain' | 'confirm' | 'input'; inputPrompt?: string }[]
            onAction?: (value: string) => void
            ttlMs?: number
        }) => { id: string; update: (next: { title?: string; body?: string }) => void; dismiss: () => void }
        picker?: (opts: { title: string; items: { label: string; value: string; active?: boolean }[] }) => Promise<string | null>
    }
}

/** Options for {@link tuiReview}. */
export interface TuiReviewOptions {
    api: NvimTuiLike
    /** Session whose feed receives the card. */
    sessionId?: string
    title: string
    /** The review sheet, rendered into the card body. */
    body: string
    artifacts: ReviewArtifacts
    /** The session workspace, used to spell the artifact paths in the menu. */
    cwd: string
    /** Diagnostic sink (the plugin's per-workspace log). */
    log?: (message: string) => void
    /** Abort (turn cancelled) withdraws the review. */
    signal?: AbortSignal
    /** Give up after this long; the mission simply stays unapproved. */
    timeoutMs: number
}

/** One pickable entry inside a directory. */
function listEntries(dir: string): { label: string; value: string; active?: boolean }[] {
    let names: string[]
    try {
        names = fs.readdirSync(dir).sort()
    } catch {
        return []
    }
    return names.map((name) => {
        const full = path.join(dir, name)
        let isDir = false
        try {
            isDir = fs.statSync(full).isDirectory()
        } catch {
            isDir = false
        }
        return { label: isDir ? `${name}/` : name, value: full }
    })
}

/** Item value that walks one level back out of a menu. */
export const BACK_VALUE = 'nav:back'

/**
 * Walk one directory through the TUI picker, opening the chosen file.
 *
 * Navigation is a stack, not a one-way trip: `Esc`/`q` (the picker's own cancel)
 * and an explicit 「↩︎ 返回」 item both walk back out — one level inside a
 * directory tree, or to the review menu at the top. A secondary popup must never
 * be a dead end.
 */
async function browse(api: NvimTuiLike, dir: string, label: string): Promise<void> {
    const picker = api.ui.picker
    if (picker === undefined) return
    const stack: string[] = []
    let current = dir
    for (let step = 0; step < 6; step += 1) {
        const entries = listEntries(current)
        const backLabel = stack.length === 0 ? `↩︎ 返回评审菜单（Esc）` : `↩︎ 返回上一级目录（Esc）`
        const items = [...entries, { label: backLabel, value: BACK_VALUE }]
        const chosen = await picker({ title: `${label} — ${current}`, items })
        if (chosen === null || chosen === undefined || chosen === BACK_VALUE) {
            const parent = stack.pop()
            if (parent === undefined) return
            current = parent
            continue
        }
        let isDir = false
        try {
            isDir = fs.statSync(chosen).isDirectory()
        } catch {
            isDir = false
        }
        if (isDir) {
            stack.push(current)
            current = chosen
            continue
        }
        const ok = await openPath(api, chosen)
        api.ui.notice?.(ok ? `已打开：${chosen}` : `⚠ 打开失败：${chosen}`)
        return
    }
}

/**
 * Show the review card and wait for a verdict.
 *
 * Opening an artifact keeps the card and the wait alive; only 通过 / 打回
 * resolve it, so a reviewer can read first and decide after.
 * @param options - card content, artifacts, abort signal and timeout.
 * @returns the human's decision (never `approved` unless they chose it).
 */
export async function tuiReview(options: TuiReviewOptions): Promise<ReviewOutcome> {
    const { api, artifacts } = options
    const capabilities = api.capabilities?.() ?? {}
    // The picker IS the review popup; without it there is nothing to select in.
    if (api.ui.picker === undefined || capabilities['picker'] === false) {
        return { decision: 'unavailable', by: 'tui' }
    }

    const deadline = Date.now() + Math.max(1_000, options.timeoutMs)
    const expired = (): boolean => Date.now() > deadline
    const relative = (target: string): string => path.relative(options.cwd, target) || target

    // A record in the feed: what is being reviewed, and how to open it. It never
    // carries a verdict (see reviewCardActions) and never decides anything.
    const card = api.ui.card?.({
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        plugin: 'dsh-spec-gate',
        title: options.title,
        body: options.body,
        actions: reviewCardActions(),
        onAction: (value: string) => {
            options.log?.(`卡片动作: ${value}`)
            void handleReviewAction(api, value, artifacts)
                .then((opened) => {
                    if (opened !== undefined) api.ui.notice?.(opened.ok ? `已打开：${opened.path}` : `⚠ 打开失败：${opened.path}`)
                })
                .catch((error: unknown) => {
                    options.log?.(`卡片动作失败: ${(error as Error).message}`)
                    api.ui.notice?.(`⚠ 操作失败：${(error as Error).message}`)
                })
        },
    })

    const items = [
        { label: `查看需求文档（只读预览，q 关闭） — ${relative(artifacts.specFile)}`, value: ACTION.openSpec },
        { label: `查看测试用例（只读预览，q 关闭） — ${relative(artifacts.designFile)}`, value: ACTION.openDesign },
        { label: `浏览需求文档目录 — ${relative(artifacts.specsDir)}/`, value: ACTION.listSpecs },
        { label: `浏览测试用例目录 — ${relative(artifacts.missionDir)}/`, value: ACTION.listDesign },
        { label: '✅ 通过并放行（之后的写操作放行）', value: ACTION.approve },
        { label: '🛑 打回重写（说明要改什么）', value: ACTION.reject },
        { label: '取消（保持未审批，稍后再审）', value: ACTION.cancel },
    ]

    for (let step = 0; step < 20; step += 1) {
        if (options.signal?.aborted === true) {
            card?.update({ title: `${options.title} → 已取消`, body: '本轮未做决定，规格仍未审批。' })
            await releasePreview(api)
            return { decision: 'cancelled', by: 'approval' }
        }
        if (expired()) {
            card?.update({ title: `${options.title} → 已超时未决定`, body: '规格仍未审批；需要时重新调用 spec_approve。' })
            await releasePreview(api)
            return { decision: 'cancelled', by: 'timeout' }
        }
        const choice = await api.ui.picker({ title: options.title, items })
        if (choice === null || choice === undefined) {
            // Esc / superseded picker: no decision. Fail closed, and say how to
            // come back instead of leaving a half-approved mission behind.
            card?.update({ title: `${options.title} → 未决定`, body: '规格仍未审批；重新调用 spec_approve 可以再次评审。' })
            await releasePreview(api)
            return { decision: 'cancelled', by: 'approval' }
        }
        if (choice === ACTION.approve) {
            card?.update({ title: `${options.title} → 已通过`, body: '规格已审批，写操作放行。' })
            await releasePreview(api)
            return { decision: 'approved', by: 'approval' }
        }
        if (choice === ACTION.cancel) {
            card?.update({ title: `${options.title} → 已取消`, body: '规格仍未审批；需要时重新调用 spec_approve。' })
            await releasePreview(api)
            return { decision: 'cancelled', by: 'approval' }
        }
        if (choice === ACTION.reject) {
            const answer = await askRejectionReason(api, options)
            if (answer.kind === 'back') {
                // A secondary popup is never a dead end: going back decides
                // nothing, so the mission stays exactly as it was.
                options.log?.('打回已取消，返回评审菜单')
                api.ui.notice?.('已返回评审菜单（未打回）')
                continue
            }
            await releasePreview(api)
            card?.update(rejectedCard(options.title, answer.note))
            return rejectedOutcome(answer.note)
        }
        // Anything else is a review action: open it, then show the menu again.
        // The result is reported on the card/notice so a failed open is visible
        // instead of looking like "nothing happened".
        options.log?.(`评审动作: ${choice}`)
        const opened = await handleReviewAction(api, choice, artifacts)
        if (opened !== undefined) {
            const described = describePreview(opened.path, opened.placement ?? 'failed')
            api.ui.notice?.(described)
            options.log?.(described)
            // A viewer owns the screen: come back to the menu only once the
            // human closes it (or the review's deadline passes).
            if (opened.placement === 'viewer') {
                const closed = await waitForPreview(api, opened.placement, deadline, options.signal)
                options.log?.(closed ? '预览已关闭，重新弹出评审菜单' : '预览未关闭/超时，继续评审')
            }
        }
    }
    card?.update({ title: `${options.title} → 仍未决定`, body: '评审菜单已重新弹出多次，仍未选择；规格保持未审批。' })
    await releasePreview(api)
    return { decision: 'cancelled', by: 'tui' }
}

/** The card/outcome of a rejection (kept out of the loop: one decision, one shape). */
function rejectedCard(title: string, note: string | undefined): { title: string; body: string } {
    return { title: `${title} → 已打回`, body: note === undefined ? '等待修订后重新送审。' : `人工意见：${note}` }
}

/** The rejection outcome every route returns (one object literal, one shape). */
function rejectedOutcome(note: string | undefined): ReviewOutcome {
    return { decision: 'rejected', by: 'approval', ...(note === undefined ? {} : { note }) }
}

/**
 * Open/browse one review target (never a verdict).
 * @returns what was opened, so the caller can tell the human (or `undefined`
 *   when the choice only opened a picker).
 */
async function handleReviewAction(
    api: NvimTuiLike,
    value: string,
    artifacts: ReviewArtifacts,
): Promise<{ ok: boolean; path: string; placement?: PreviewPlacement } | undefined> {
    if (value === ACTION.openSpec) {
        const placement = await previewArtifact(api, artifacts.specFile, '需求文档', { slot: SPEC_PREVIEW_SLOT })
        return { ok: placement !== 'failed', path: artifacts.specFile, placement }
    }
    if (value === ACTION.openDesign) {
        const placement = await previewArtifact(api, artifacts.designFile, '测试用例', { slot: SPEC_PREVIEW_SLOT })
        return { ok: placement !== 'failed', path: artifacts.designFile, placement }
    }
    if (value === ACTION.listSpecs) {
        await browse(api, artifacts.specsDir, '需求文档目录')
        return undefined
    }
    if (value === ACTION.listDesign) {
        await browse(api, artifacts.missionDir, '测试用例目录')
    }
    return undefined
}

/**
 * Second step of a rejection: why, in one more popup.
 *
 * The canned answers cover the usual review findings; "其它" hands the reason
 * back to the chat (the input box is prefilled so the human can just type).
 * @returns the note, or `undefined` when the human preferred to explain in chat.
 */
async function askRejectionReason(api: NvimTuiLike, options: TuiReviewOptions): Promise<RejectionAnswer> {
    const picker = api.ui.picker
    if (picker === undefined) return { kind: 'reason' }
    const items = [
        ...REJECTION_REASONS.map((reason) => ({ label: reason, value: `reject:${reason}` })),
        { label: '其它（我直接在对话里说明）', value: REJECT_OTHER },
        // The picker's own Esc/q cancels too — both mean "back to the menu",
        // never "reject without a reason".
        { label: '↩︎ 返回评审菜单（先不打回，Esc）', value: BACK_VALUE },
    ]
    const chosen = await picker({ title: '打回原因（要改什么）', items })
    if (chosen === null || chosen === undefined || chosen === BACK_VALUE) return { kind: 'back' }
    if (chosen === REJECT_OTHER) {
        // Prefill the input box so typing the details is one step away; the
        // model reads them as a normal message.
        try {
            api.insertInput?.('打回原因：')
        } catch {
            // An input box that refuses prefill changes nothing about the loop.
        }
        return { kind: 'reason' }
    }
    return { kind: 'reason', note: chosen.startsWith('reject:') ? chosen.slice('reject:'.length) : chosen }
}

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
 * @module dsh-spec-gate/review
 */

import fs from 'node:fs'
import path from 'node:path'

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

/** Action values are prefixed so a typed rejection note can never collide. */
export const ACTION = {
    openSpec: 'spec:open-spec',
    openDesign: 'spec:open-design',
    listSpecs: 'spec:list-specs',
    listDesign: 'spec:list-design',
    approve: 'spec:approve',
    reject: 'spec:reject',
} as const

/** The interactive actions offered on the review card. */
export function reviewActions(): ReviewAction[] {
    return [
        { label: '查看需求文档', value: ACTION.openSpec },
        { label: '查看测试用例', value: ACTION.openDesign },
        { label: '列出需求目录', value: ACTION.listSpecs },
        { label: '列出用例目录', value: ACTION.listDesign },
        { label: '通过并放行', value: ACTION.approve, kind: 'confirm', },
        { label: '打回重写（在输入框写明原因）', value: ACTION.reject, kind: 'input', inputPrompt: '打回原因（要改什么）：' },
    ]
}

/** Structural view of the `nvim-tui` extension API (see its `kernel/ext-types.ts`). */
export interface NvimTuiLike {
    version: string
    ready?: Promise<void>
    capabilities?: () => Record<string, boolean>
    nvim: {
        ex: (cmd: string) => Promise<void>
        call?: (fn: string, args?: unknown[]) => Promise<unknown>
        lua?: (code: string, args?: unknown[]) => Promise<unknown>
    }
    ui: {
        card: (opts: {
            sessionId?: string
            plugin: string
            title: string
            body: string
            actions?: { label: string; value: string; kind?: 'plain' | 'confirm' | 'input'; inputPrompt?: string }[]
            onAction?: (value: string) => void
            ttlMs?: number
        }) => { id: string; update: (next: { title?: string; body?: string }) => void; dismiss: () => void }
        picker?: (opts: { title: string; items: { label: string; value: string; active?: boolean }[] }) => Promise<string | null>
        notice?: (text: unknown) => void
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

/**
 * Open one path in a new tab through the TUI's `nvim` layer.
 *
 * Escaping is asked of nvim itself (`fnameescape`) instead of re-implementing
 * the rules for spaces, quotes and `%`; if the read-only `call` whitelist
 * refuses it, a conservative local escape keeps the command usable.
 */
async function openPath(api: NvimTuiLike, target: string): Promise<void> {
    let escaped = target
    if (api.nvim.call !== undefined) {
        try {
            const value = await api.nvim.call('fnameescape', [target])
            if (typeof value === 'string' && value !== '') escaped = value
        } catch {
            escaped = target.replace(/([ %#'"\\])/g, '\\$1')
        }
    } else {
        escaped = target.replace(/([ %#'"\\])/g, '\\$1')
    }
    await api.nvim.ex(`tabedit ${escaped}`)
}

/**
 * Walk one directory through the TUI picker, opening the chosen file.
 * Directories are navigable (one picker per level, bounded depth).
 */
async function browse(api: NvimTuiLike, dir: string, label: string, depth = 0): Promise<void> {
    if (api.ui.picker === undefined || depth > 3) return
    const items = listEntries(dir)
    if (items.length === 0) {
        api.ui.notice?.(`${label}：目录为空或无法读取（${dir}）`)
        return
    }
    const chosen = await api.ui.picker({ title: `${label} — ${dir}`, items })
    if (chosen === null || chosen === undefined) return
    let isDir = false
    try {
        isDir = fs.statSync(chosen).isDirectory()
    } catch {
        isDir = false
    }
    if (isDir) {
        await browse(api, chosen, label, depth + 1)
        return
    }
    await openPath(api, chosen)
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
    if (api.capabilities !== undefined && api.capabilities()['card'] === false) {
        return { decision: 'unavailable', by: 'tui' }
    }
    return await new Promise<ReviewOutcome>((resolve) => {
        let settled = false
        const finish = (outcome: ReviewOutcome): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            resolve(outcome)
        }
        const onAbort = (): void => finish({ decision: 'cancelled', by: 'approval' })
        const timer = setTimeout(() => {
            handle?.update({ title: `${options.title}（已超时未决定）` })
            finish({ decision: 'cancelled', by: 'timeout' })
        }, Math.max(1_000, options.timeoutMs))
        timer.unref?.()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted === true) {
            finish({ decision: 'cancelled', by: 'approval' })
            return
        }

        let handle: { update: (next: { title?: string; body?: string }) => void; dismiss: () => void } | undefined
        handle = api.ui.card({
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            plugin: 'dsh-spec-gate',
            title: options.title,
            body: options.body,
            actions: reviewActions(),
            onAction: (value: string) => {
                // `input` actions deliver the TYPED text, every other action its
                // own value — so anything unrecognised is the rejection note.
                void (async () => {
                    try {
                        if (value === ACTION.approve) {
                            handle?.update({ title: `${options.title} → 已通过`, body: '规格已审批，写操作放行。' })
                            finish({ decision: 'approved', by: 'approval' })
                            return
                        }
                        if (value === ACTION.openSpec) {
                            await openPath(api, artifacts.specFile)
                            return
                        }
                        if (value === ACTION.openDesign) {
                            await openPath(api, artifacts.designFile)
                            return
                        }
                        if (value === ACTION.listSpecs) {
                            await browse(api, artifacts.specsDir, '需求文档目录')
                            return
                        }
                        if (value === ACTION.listDesign) {
                            await browse(api, artifacts.missionDir, '测试用例目录')
                            return
                        }
                        if (value === ACTION.reject) {
                            // Confirm-gated without a note still counts as a rejection.
                            handle?.update({ title: `${options.title} → 已打回`, body: '等待修订后重新送审。' })
                            finish({ decision: 'rejected', by: 'approval' })
                            return
                        }
                        const note = value.trim()
                        if (note === '') return
                        handle?.update({ title: `${options.title} → 已打回`, body: `人工意见：${note}` })
                        finish({ decision: 'rejected', by: 'approval', note })
                    } catch {
                        // An action that fails must not decide anything.
                    }
                })()
            },
        })
    })
}

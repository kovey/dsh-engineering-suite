/**
 * The shared read-only preview (the ONE implementation two gates use).
 *
 * `spec_approve` and `split-review` both ask a person to READ a document before
 * deciding. Opening a tab is not enough in nvim-tui: a plugin-opened buffer is
 * relocated into a fresh tab and the TUI then refocuses its own window (the
 * input box lives in the main tab), so the file is open but off-screen. The
 * surfaces below live INSIDE the current layout and stay visible while the
 * review menu is open, in this order:
 *
 *  1. the TUI's OWN read-only lines float (`require('dsh_tui').show_lines_float`,
 *     the surface its settings/workflow views use): scrollable with nvim's own
 *     keys, `q`/`Esc` closes it and focus returns; `i`/`o` opens the file for
 *     real editing;
 *  2. a docked panel (`ui.panel`);
 *  3. a managed float (`ui.float`);
 *  4. a new tab (`openPath`) — the explicit "edit it properly" route;
 *  5. `failed` (with a notice), never a silent no-op.
 *
 * There is exactly ONE preview surface per process: the module remembers what it
 * opened, so a second review releases the first instead of stacking panels. That
 * is why the state is not per-caller — two plugins showing two documents at once
 * is exactly the state the human cannot see.
 *
 * @module dsh-eng-core/preview-surface
 */

import path from 'node:path'
import { openPath, readPreviewLines, withTimeout, type NvimTuiPreviewApi, type PreviewPlacement } from './preview-open.js'

/** Slot a docked panel claims when the caller names none. */
const DEFAULT_PREVIEW_SLOT = 'dsh-review:preview'

/** A read-only viewer float the human closes with `q`/`Esc`. */
interface ViewerHandle {
    /** Buffer id of the viewer (wiped on close, so it doubles as a liveness flag). */
    buf: number
    /**
     * Tabpage the review was running in.
     *
     * The viewer's `i`/`o` opens the artifact in a NEW tab: coming back to the
     * menu right away would steal focus from the buffer the human just asked
     * for, so the menu waits until they return to this tab.
     */
    originTab?: unknown
}

/** The panel/float this preview currently holds (released by {@link releasePreview}). */
let panelHandle: { release: () => Promise<void> } | undefined
let floatHandle: string | undefined
/** The read-only viewer float, when one is open. */
let viewer: ViewerHandle | undefined

/** Options of {@link previewArtifact}. */
export interface PreviewOptions {
    /** Docked-panel slot to claim (`dsh-spec-gate:review` for the spec review). */
    slot?: string
}

/**
 * Show an artifact where the human can actually SEE it.
 *
 * The order is the fallback chain documented at the top of this module; the tab
 * route is the last attempt and stays the explicit "edit it properly" option.
 * @param api - the host TUI's extension API.
 * @param target - absolute path of the file to preview.
 * @param label - what the file is ("需求文档" / "拆分计划"), used in the title.
 * @param options - the panel slot to claim, when the caller cares.
 * @returns where it ended up (`failed` = nowhere; the human was told).
 */
export async function previewArtifact(
    api: NvimTuiPreviewApi,
    target: string,
    label: string,
    options: PreviewOptions = {},
): Promise<PreviewPlacement> {
    const lines = readPreviewLines(target, 5_000)
    const title = `${label} — ${path.basename(target)}`
    if (await openViewer(api, target, title, lines)) return 'viewer'
    if (await openPanel(api, title, lines, options.slot ?? DEFAULT_PREVIEW_SLOT)) return 'panel'
    if (await openFloat(api, title, lines)) return 'float'
    return (await openPath(api, target)) ? 'tab' : 'failed'
}

/** Surface 1: the TUI's own read-only viewer float (closed with `q`/`Esc`). */
async function openViewer(api: NvimTuiPreviewApi, target: string, title: string, lines: string[]): Promise<boolean> {
    const lua = api.nvim.lua
    if (lua === undefined) return false
    try {
        // Which tab is the review running in? `i`/`o` inside the viewer jumps to a
        // NEW tab, and the menu must not follow the human there.
        const originTab = await originTabOf(lua)
        const opened = await withTimeout(
            lua('return require("dsh_tui").show_lines_float(...)', [title, lines, target]),
            5_000,
            'show_lines_float',
        )
        const buf = (opened as { buf?: unknown } | undefined)?.buf
        if (typeof buf !== 'number') return false
        viewer = { buf, ...(originTab === undefined ? {} : { originTab }) }
        return true
    } catch {
        return false
    }
}

/** The tabpage the caller is on, when the host can tell (a failed probe is "unknown"). */
async function originTabOf(lua: (code: string, args?: unknown[]) => Promise<unknown>): Promise<unknown> {
    try {
        return await withTimeout(lua('return vim.api.nvim_get_current_tabpage()', []), 2_000, 'tabpage')
    } catch {
        return undefined
    }
}

/** Surface 2: a docked panel (one preview surface at a time). */
async function openPanel(api: NvimTuiPreviewApi, title: string, lines: string[], slot: string): Promise<boolean> {
    const capabilities = api.capabilities?.() ?? {}
    if (api.ui.panel === undefined || capabilities['panel'] === false) return false
    try {
        const handles = await withTimeout(
            api.ui.panel({ slot, side: 'right', width: 84, title, footer: '审阅完成后自动关闭', lines }),
            4_000,
            'ui.panel',
        )
        if (handles === null || handles === undefined) return false
        await releasePreview(api)
        panelHandle = handles
        return true
    } catch {
        return false
    }
}

/** Surface 3: a managed float (survives the TUI's own float family closing). */
async function openFloat(api: NvimTuiPreviewApi, title: string, lines: string[]): Promise<boolean> {
    const capabilities = api.capabilities?.() ?? {}
    if (api.ui.float === undefined || capabilities['float'] === false) return false
    try {
        const opened = await withTimeout(
            api.ui.float({ lines, title, relative: 'editor', width: 96, height: 30, row: 2, col: 2 }),
            4_000,
            'ui.float',
        )
        if (opened === undefined || opened === null) return false
        floatHandle = opened.id
        return true
    } catch {
        return false
    }
}

/**
 * Wait until the human closes a viewer preview.
 *
 * The viewer and the verdict menu are both floats, so showing the menu on top of
 * the document would hide what the reviewer is reading. The viewer's buffer is
 * wiped on close (`bufhidden=wipe`), which makes it a reliable liveness flag.
 * @returns `true` when it closed, `false` on timeout/abort (never blocks forever).
 */
async function waitForViewerClose(
    api: NvimTuiPreviewApi,
    viewerHandle: ViewerHandle,
    deadline: number,
    signal?: AbortSignal,
): Promise<boolean> {
    const lua = api.nvim.lua
    if (lua === undefined) return false
    let elapsed = 0
    let closed = false
    for (;;) {
        if (signal?.aborted === true) return false
        if (Date.now() > deadline) return false
        try {
            if (!closed) {
                const alive = await withTimeout(
                    lua('return vim.api.nvim_buf_is_valid(...)', [viewerHandle.buf]),
                    2_000,
                    'viewer-liveness',
                )
                closed = alive === false
            }
            if (closed) {
                // The viewer is gone. If the human used `i`/`o` they are now in
                // the file's tab and must be left alone there; `q` keeps them in
                // the review tab, so the menu can come straight back.
                if (viewerHandle.originTab === undefined) return true
                const tab = await withTimeout(lua('return vim.api.nvim_get_current_tabpage()', []), 2_000, 'tabpage')
                if (tab === viewerHandle.originTab) return true
            }
        } catch {
            if (closed) return viewerHandle.originTab === undefined
        }
        // Poll briskly at first (the reviewer may close it immediately) and back
        // off afterwards: a long read must not turn into thousands of RPCs.
        elapsed += 400
        await new Promise((resolve) => setTimeout(resolve, elapsed > 30_000 ? 2_000 : 400))
    }
}

/**
 * Wait for the preview a caller just opened, when it owns the screen.
 *
 * A viewer float is modal in practice: the review menu must not appear on top of
 * the document the human is still reading. Every other placement returns `true`
 * immediately (nothing to wait for).
 * @param api - the host TUI's extension API.
 * @param placement - what {@link previewArtifact} returned.
 * @param deadline - epoch ms after which the wait gives up.
 * @param signal - the turn's signal, so a cancelled review stops waiting.
 * @returns whether the viewer is gone (an abandoned viewer stays closable).
 */
export async function waitForPreview(
    api: NvimTuiPreviewApi,
    placement: PreviewPlacement,
    deadline: number,
    signal?: AbortSignal,
): Promise<boolean> {
    if (placement !== 'viewer' || viewer === undefined) return true
    const handle = viewer
    const closed = await waitForViewerClose(api, handle, deadline, signal)
    // Only forget the handle when it really closed: an abandoned viewer must
    // still be closable on the way out, or it would sit on screen after the
    // review ended.
    if (closed) viewer = undefined
    return closed
}

/** Release whatever preview surface is open (a verdict must not leave it behind). */
export async function releasePreview(api: NvimTuiPreviewApi): Promise<void> {
    if (viewer !== undefined) {
        viewer = undefined
        try {
            await api.nvim.lua?.('return require("dsh_tui").close_lines_float()', [])
        } catch {
            // a viewer that refuses to close must not break the verdict
        }
        return
    }
    if (panelHandle !== undefined) {
        const handles = panelHandle
        panelHandle = undefined
        try {
            await handles.release()
        } catch {
            // a surface that refuses to close must not break the verdict
        }
        return
    }
    if (floatHandle === undefined) return
    const id = floatHandle
    floatHandle = undefined
    try {
        await api.ui.floatClose?.(id)
    } catch {
        // same
    }
}

/**
 * Human-readable result of an open action (the SAME wording in every gate).
 * @param target - the path that was opened (or attempted).
 * @param placement - where it ended up.
 */
export function describePreview(target: string, placement: PreviewPlacement): string {
    if (placement === 'failed') return `⚠ 打开失败：${target}`
    if (placement === 'viewer') {
        return `已打开只读预览：${target}（q 关闭回到评审菜单；i/o 打开文件编辑，回到评审标签页后菜单再出现）`
    }
    if (placement === 'panel') return `已在右侧面板显示：${target}`
    if (placement === 'float') return `已在浮窗显示：${target}`
    if (placement === 'tab') return `已在新标签页打开：${target}（按 gt 切换标签页）`
    return `已打开：${target}`
}

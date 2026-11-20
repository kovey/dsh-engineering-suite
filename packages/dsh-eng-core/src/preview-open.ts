/**
 * The shared read-only preview: the structural host surface and the file-level
 * primitives (see `preview-surface.ts` for the surfaces and their order).
 *
 * WHY THIS LIVES IN ENG-CORE: two gates ask a person to review a document — the
 * specification (`spec_approve`) and the split plan (`split-review`). Both must
 * show the SAME thing: a read-only view the reviewer closes with `q`, with the
 * same fallback chain when the TUI cannot host a float. Keeping one
 * implementation is what makes "拆分审核与需求审批同体验" a fact instead of a
 * promise: a fix to the panel/float fallback cannot land in one gate only.
 *
 * The types here are a STRUCTURAL view (hand-written, like every other host
 * surface in this suite): the preview must keep working with an nvim-tui that
 * gains members, and must never assume a member exists.
 *
 * @module dsh-eng-core/preview-open
 */

import fs from 'node:fs'

/** Where a preview ended up, for the caller's notice and for the wait loop. */
export type PreviewPlacement = 'viewer' | 'panel' | 'float' | 'tab' | 'failed'

/** Structural view of the `nvim-tui` extension API, limited to the preview. */
export interface NvimTuiPreviewApi {
    /** Capability flags the host reports (`picker` / `panel` / `float` …). */
    capabilities?: () => Record<string, boolean>
    nvim: {
        ex?: (cmd: string) => Promise<void>
        call?: (fn: string, args?: unknown[]) => Promise<unknown>
        lua?: (code: string, args?: unknown[]) => Promise<unknown>
    }
    ui: {
        /** Docked panel (always visible in the TUI layout) — the preview surface. */
        panel?: (opts: {
            slot?: string
            side?: 'right' | 'left'
            width?: number
            height?: number
            title?: string
            footer?: string
            lines?: string[]
        }) => Promise<{ win: number; buf: number; slot: string; release: () => Promise<void> } | null>
        /** Managed float (survives the TUI's own float family closing). */
        float?: (opts: {
            lines: string[]
            title?: string
            relative?: 'editor' | 'cursor'
            width?: number
            height?: number
            row?: number
            col?: number
        }) => Promise<{ id: string; win: number; buf: number }>
        floatClose?: (id: string) => Promise<void>
        notice?: (text: unknown) => void
    }
}

/** Read a file for previewing, bounded so a huge file cannot flood the UI. */
export function readPreviewLines(target: string, maxLines = 400): string[] {
    try {
        const lines = fs.readFileSync(target, 'utf8').split('\n')
        if (lines.length <= maxLines) return lines
        return [...lines.slice(0, maxLines), `…（已截断，共 ${lines.length} 行；完整内容请用"新标签页打开"）`]
    } catch (error) {
        return [`（读取失败：${(error as Error).message}）`]
    }
}

/**
 * Open one path in a new tab, reporting what happened either way.
 *
 * Three routes, in order of how well they are known to work:
 *
 *  1. the TUI's OWN public Lua entry (`require('dsh_tui').open_file_tab`, the
 *     one `gF` uses) through `nvim.lua` — executed inside nvim, no escaping to
 *     guess and it notifies `dsh-open-failed` itself;
 *  2. `nvim.ex('tabedit …')` with nvim's own `fnameescape`;
 *  3. `nvim.ex` with a conservative local escape.
 *
 * Every route is bounded by a timeout: a stuck RPC must never leave the review
 * waiting forever. A failure is surfaced with a notice and returned as `false`,
 * so the caller can tell the human instead of silently doing nothing.
 */
export async function openPath(api: NvimTuiPreviewApi, target: string, timeoutMs = 4_000): Promise<boolean> {
    const attempts = openAttempts(api, target)
    const failures: string[] = []
    for (const attempt of attempts) {
        try {
            const outcome = await withTimeout(attempt.run(), timeoutMs, attempt.name)
            // The Lua route returns false when nvim itself refused to open it.
            if (outcome === false) {
                failures.push(`${attempt.name}: nvim 拒绝打开`)
                continue
            }
            return true
        } catch (error) {
            failures.push(`${attempt.name}: ${(error as Error).message}`)
        }
    }
    api.ui.notice?.(`⚠ 打不开 ${target}（${failures.join('；') || '没有可用的打开方式'}）`)
    return false
}

/** The tab routes, in preference order (see {@link openPath}). */
function openAttempts(api: NvimTuiPreviewApi, target: string): { name: string; run: () => Promise<unknown> }[] {
    const attempts: { name: string; run: () => Promise<unknown> }[] = []
    const lua = api.nvim.lua
    if (lua !== undefined) {
        attempts.push({
            name: 'lua:open_file_tab',
            run: async () => await lua('return require("dsh_tui").open_file_tab(...)', [target]),
        })
    }
    const ex = api.nvim.ex
    if (ex === undefined) return attempts
    attempts.push({
        name: 'ex:tabedit(fnameescape)',
        run: async () => {
            let escaped = target
            if (api.nvim.call !== undefined) {
                const value = await api.nvim.call('fnameescape', [target])
                if (typeof value === 'string' && value !== '') escaped = value
            }
            await ex(`tabedit ${escaped}`)
        },
    })
    attempts.push({
        name: 'ex:tabedit(local-escape)',
        run: async () => await ex(`tabedit ${target.replace(/([ %#'"\\])/g, '\\$1')}`),
    })
    return attempts
}

/**
 * Bound one RPC attempt so a stuck channel cannot wedge the review.
 * @param work - the RPC promise.
 * @param timeoutMs - how long to wait for it.
 * @param label - what is being awaited (named in the timeout error).
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

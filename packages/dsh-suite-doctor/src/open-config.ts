/**
 * `/suite edit`: show a gate config in the CURRENT UI, degrading to its path.
 *
 * `/suite` is registered through the host command registry, not through
 * nvim-tui's extension API, so it exists on the TUI, desktop, web and headless
 * alike. `edit` must therefore never *require* the TUI:
 *
 *  1. **Optional integration.** The `nvim-tui` service is read with
 *     `ctx.get('nvim-tui')` (never `inject`): a host without it is a normal
 *     host, not a failure.
 *  2. **The TUI's own public entry, not hand-built RPC.** When the service is
 *     there, the tab is opened by executing
 *     `require("dsh_tui").open_file_tab(<absolute path>)` through the extension
 *     API's own Lua seam — the entry `/settings edit` and `gF` use — or, when
 *     the host only exposes the generic `luaExt.call` layer, through that. No
 *     `nvim_call_function` strings, no escaping to guess.
 *  3. **Degrade, never fail.** On desktop / web / headless, or when the TUI
 *     refuses to open the tab, the command prints the ABSOLUTE path plus
 *     "在你的编辑器里打开它" and still returns success: the file is the thing
 *     the person asked for, and the UI route is best-effort.
 *
 * Nothing here writes configuration — `edit` only shows what is already there.
 * A missing file is answered with the exact `/suite init` invocation that would
 * create it, not with an empty editor buffer.
 *
 * @module dsh-suite-doctor/open-config
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig, type Layout } from 'dsh-eng-core'
import { SUITE_CONFIGS, descriptorForName } from './scaffold-catalog.js'

/** Default bound on one UI round trip (a wedged nvim must not wedge the command). */
const OPEN_TIMEOUT_MS = 4_000

/**
 * Structural view of the OPTIONAL `nvim-tui` extension API.
 *
 * Only the two public entries this module uses are modelled; everything else
 * the TUI exposes is deliberately not touched (a wider structural type would
 * invite this plugin into TUI-only territory).
 */
export interface NvimTuiLike {
    /** Node → nvim Lua execution (`app.luaCall`'s public counterpart). */
    nvim?: { lua?: (code: string, args?: unknown[]) => Promise<unknown> }
    /** Generic extension layer: call a method registered by a Lua extension. */
    luaExt?: { call?: (extId: string, method: string, args?: unknown[], options?: { timeoutMs?: number }) => Promise<unknown> }
}

/** Inputs of {@link openConfigFile}. */
export interface EditConfigInput {
    /** Workspace root (for the relative path and the missing-file hint). */
    cwd: string
    layout: Layout
    /** A scaffolded id / alias / file name; omitted = the configuration directory. */
    plugin?: string
    /** The host service accessor (`ctx.get`); `nvim-tui` is optional. */
    getService: (name: string) => unknown
    /** Bound on the UI round trip (default {@link OPEN_TIMEOUT_MS}). */
    timeoutMs?: number
}

/** What `edit` managed to do. */
export interface EditConfigOutcome {
    /** The current UI really opened it in a tab. */
    opened: boolean
    /** Which route answered: the TUI, or the printed path. */
    route: 'nvim-tui' | 'path'
    /** Absolute path of the file (or directory) the person asked for. */
    file: string
    /** Workspace-relative path (POSIX separators). */
    relative: string
    /** The text the command returns (successful in both routes). */
    text: string
}

/** One selected target: the file the plugin consults, or the config dir. */
interface EditTarget {
    label: string
    file: string
    relative: string
    /** The `/suite init` invocation that would create it. */
    initHint: string
    exists: boolean
}

function relativeTo(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Pick what `/suite edit` should show.
 *
 * A plugin file is resolved through the same `loadProjectConfig` the plugins
 * read, so a repository still on the legacy `.dsh/<id>.json` location opens the
 * file that is actually in force. An unknown plugin is refused with the list of
 * valid spellings — "opened nothing" and "I misspelled it" must not look alike.
 */
function selectTarget(input: EditConfigInput): EditTarget {
    if (input.plugin === undefined || input.plugin.trim() === '') {
        return {
            label: '配置目录',
            file: input.layout.configDir,
            relative: relativeTo(input.cwd, input.layout.configDir),
            initHint: '/suite init --apply',
            exists: fs.existsSync(input.layout.configDir),
        }
    }
    const descriptor = descriptorForName(input.plugin)
    if (descriptor === undefined) {
        throw new Error(
            `不认识的配置名 ${JSON.stringify(input.plugin)}；可用：${SUITE_CONFIGS.map((entry) => entry.id).join('、')}` +
                '（suite-doctor 自身的项目级配置不在这里打开）',
        )
    }
    const loaded = loadProjectConfig<Record<string, unknown>>(input.layout, descriptor.id, { cache: false })
    return {
        label: descriptor.title,
        file: loaded.file,
        relative: relativeTo(input.cwd, loaded.file),
        initHint: `/suite init --apply --only ${descriptor.id}`,
        exists: loaded.present,
    }
}

function isNvimTui(value: unknown): value is NvimTuiLike {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as NvimTuiLike
    return typeof candidate.nvim?.lua === 'function' || typeof candidate.luaExt?.call === 'function'
}

/** Bound one UI round trip; a wedged editor must not hold the command open. */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
    })
    try {
        return await Promise.race([task, timeout])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** Try each public entry; report both the success and the reasons it failed. */
async function tryOpen(service: unknown, target: string, timeoutMs: number): Promise<{ opened: boolean; problem: string }> {
    if (!isNvimTui(service)) return { opened: false, problem: '当前宿主没有 nvim-tui（desktop / web / headless，或该插件未装载）' }
    const failures: string[] = []
    const lua = service.nvim?.lua
    if (lua !== undefined) {
        try {
            // The TUI's own public entry (`/settings edit` and `gF` use it); it
            // notifies `dsh-open-failed` itself when nvim refuses.
            const outcome = await withTimeout(lua('return require("dsh_tui").open_file_tab(...)', [target]), timeoutMs, 'open_file_tab')
            if (outcome !== false) return { opened: true, problem: '' }
            failures.push('nvim-tui 拒绝打开（open_file_tab 返回 false）')
        } catch (error) {
            failures.push(`nvim.lua: ${describeError(error)}`)
        }
    }
    const call = service.luaExt?.call
    if (call !== undefined) {
        try {
            const outcome = await withTimeout(call('dsh_tui', 'open_file_tab', [target], { timeoutMs }), timeoutMs, 'luaExt dsh_tui.open_file_tab')
            if (outcome !== false) return { opened: true, problem: '' }
            failures.push('luaExt dsh_tui.open_file_tab 返回 false')
        } catch (error) {
            failures.push(`luaExt.call: ${describeError(error)}`)
        }
    }
    if (lua === undefined && call === undefined) failures.push('nvim-tui 没有公开的打开入口（nvim.lua / luaExt.call）')
    return { opened: false, problem: failures.join('；') }
}

function openedText(target: EditTarget): string {
    return [
        `/suite edit ${target.label} —— 已在当前界面（nvim-tui）新标签页打开`,
        `文件：${target.file}`,
        `（工作区相对路径：${target.relative}）`,
    ].join('\n') + '\n'
}

function fallbackText(target: EditTarget, problem: string): string {
    return [
        `/suite edit ${target.label} —— 当前界面没有可用的标签页入口（这不影响配置内容）`,
        `原因：${problem}`,
        `文件（绝对路径）：${target.file}`,
        '在你的编辑器里打开它（这条命令本身仍然成功：没有改动任何配置）。',
    ].join('\n') + '\n'
}

function missingText(target: EditTarget): string {
    return [
        `/suite edit ${target.label} —— 还没有这个配置文件或目录`,
        `路径：${target.file}`,
        `先运行 ${target.initHint} 生成它，再重试 /suite edit。`,
    ].join('\n') + '\n'
}

/**
 * Open the selected config in the current UI, falling back to its absolute path.
 * @param input - workspace, layout, target plugin and the host accessor.
 * @returns the route that answered and the text to render.
 * @throws only for an unknown plugin name (never for a missing UI or file).
 */
export async function openConfigFile(input: EditConfigInput): Promise<EditConfigOutcome> {
    const target = selectTarget(input)
    const base = { file: target.file, relative: target.relative }
    if (!target.exists) return { ...base, opened: false, route: 'path', text: missingText(target) }
    const attempt = await tryOpen(input.getService('nvim-tui'), target.file, input.timeoutMs ?? OPEN_TIMEOUT_MS)
    if (attempt.opened) return { ...base, opened: true, route: 'nvim-tui', text: openedText(target) }
    return { ...base, opened: false, route: 'path', text: fallbackText(target, attempt.problem) }
}

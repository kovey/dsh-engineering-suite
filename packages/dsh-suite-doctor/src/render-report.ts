/**
 * `/suite`'s presentation layer: one report, two surfaces.
 *
 * The host renders a command result in the feed, where the TUI's `app.notice()`
 * keeps only ONE line — so a multi-line report (doctor checks, a config diff, a
 * scaffold plan) lost its structure the moment it arrived. The fix is not a
 * second, shorter report: lay the SAME report out once and hand it to whichever
 * surface can show it.
 *
 *  - **Float when the host can.** `ctx.get('nvim-tui')` is read as an OPTIONAL
 *    service (never `inject`) and `ui.float()` opens the managed float.
 *    `ui.card` is deliberately NOT used: it renders inside the feed and keeps
 *    only the first four actions, so a long report would be clipped there too.
 *  - **Text when it cannot.** No service, headless capabilities, no
 *    `ui.float`/`ui.floatClose`, or a rejected `float()` all fall back to the
 *    ORIGINAL text, and the command still succeeds.
 *  - **The feed keeps a line.** The float path returns the one-line summary;
 *    when the body was folded, the full text follows it, so `（完整文本见 feed）`
 *    is literally true.
 *
 * Layout (AC-003): lines ≤ {@link MAX_REPORT_WIDTH} code points, summary first,
 * blank lines between groups, and ≤ {@link MAX_REPORT_LINES} lines before the
 * rest folds to `…另有 N 行（完整文本见 feed）`.
 *
 * @module dsh-suite-doctor/render-report
 */

/** Hard bound on one rendered line (AC-003). */
export const MAX_REPORT_WIDTH = 100

/** Lines a rendered body may carry before the rest is folded. */
export const MAX_REPORT_LINES = 24

/** Float width: narrower than a typical editor, wide enough for a 100-char line. */
const FLOAT_WIDTH = 88

/** Continuation lines of a wrapped line are indented under the detail text. */
const CONTINUATION_INDENT = '    '

/** A status row opens a group (`✅`/`⚠️`/`➕` …), with or without a list bullet. */
const STATUS_START = /^(?:[-*]\s+)?(?:✅|⚠️?|❌|❔|ℹ️?|🧪|➕|⏭️?|♻️?|✏️?|🆕|📌|🔒)/

/** A metrics row (`汇总`/`合计`/`总计`) carries the numbers the summary needs. */
const METRIC_START = /^(?:汇总|合计|总计)[：:]/

/** A closing row (`汇总`/`合计`/`说明`/`下一步`) always gets its own group. */
const CLOSING_START = /^(?:汇总|合计|总计|说明|下一步)[：:]/

/** One report laid out for both surfaces. */
export interface ReportLayout {
    /** Float title derived from the report's own first line (`suite · doctor`). */
    title: string
    /** Body for the float: summary first, blank line between groups, ≤100 chars. */
    lines: string[]
    /** The single line the session feed keeps. */
    summary: string
    /** How many lines were folded into the `…另有 N 行` note (0 = none). */
    folded: number
}

/** The live host accessor (`ctx.get`); `nvim-tui` is optional. */
export interface ReportUiContext {
    get: (name: string) => unknown
}

/** Structural view of the OPTIONAL `nvim-tui` surface this module uses. */
interface FloatUiLike {
    float?: (options: { lines: string[]; title?: string; width?: number; height?: number }) => Promise<unknown>
    floatClose?: (id: string) => Promise<void>
}

interface NvimTuiFloatLike {
    ui?: FloatUiLike
    capabilities?: () => Record<string, boolean>
}

/** The one float this module opened last: `/suite` replaces it, never stacks. */
let openFloat: { service: NvimTuiFloatLike; id: string } | undefined

/** The `/suite` sub-command a report belongs to, for the float title. */
function titleOf(firstLine: string): string {
    const direct = /^\/suite\s+([A-Za-z]+)\b/.exec(firstLine)
    if (direct !== null) return `suite · ${(direct[1] as string).toLowerCase()}`
    if (/^suite_init\b/.test(firstLine)) return 'suite · init'
    if (/^suite_config\b/.test(firstLine)) return 'suite · show'
    return 'suite'
}

/** The text after a report's `——` headline, when it has one. */
function headlineOf(firstLine: string): string {
    const marker = firstLine.indexOf('——')
    return marker < 0 ? '' : firstLine.slice(marker + 2).trim()
}

/**
 * The report's own numbers, for the summary line: every branch reads the SAME
 * text the body shows — a projection of the report, never a second version.
 */
function metricOf(source: readonly string[]): string {
    const body = source.slice(1)
    for (const line of body) {
        const trimmed = line.trim()
        if (METRIC_START.test(trimmed)) return trimmed.replace(/[。；]\s*$/, '')
    }
    for (const line of body) {
        const changed = /变更\s*\d+\s*个键/.exec(line)
        if (changed !== null) return changed[0]
    }
    if (/dry-run/.test(source[0] ?? '')) return 'dry-run（未写盘）'
    const headline = headlineOf(source[0] ?? '')
    if (headline !== '') return headline
    const first = body.find((line) => line.trim() !== '')
    return first === undefined ? '' : first.trim()
}

/** Cut a single line to the width bound, marking the cut with `…`. */
function trimToWidth(text: string, width: number): string {
    const chars = Array.from(text)
    if (chars.length <= width) return text
    return `${chars.slice(0, width - 1).join('').trimEnd()}…`
}

/** Build the one-line feed summary: title + the report's numbers, ≤100 chars. */
function summaryLine(title: string, source: readonly string[]): string {
    const metric = metricOf(source)
    return trimToWidth(metric === '' ? title : `${title} · ${metric}`, MAX_REPORT_WIDTH)
}

/** Wrap one source line at a word boundary (or hard-split a long token). */
function wrapLine(raw: string): string[] {
    const chars = Array.from(raw.trimEnd())
    if (chars.length <= MAX_REPORT_WIDTH) return [chars.join('')]
    const out: string[] = []
    let rest = chars
    let indent = ''
    while (rest.length > MAX_REPORT_WIDTH - indent.length) {
        const room = MAX_REPORT_WIDTH - indent.length
        const window = rest.slice(0, room)
        const space = window.lastIndexOf(' ')
        const cut = space > Math.floor(room * 0.6) ? space : room
        out.push(`${indent}${rest.slice(0, cut).join('').trimEnd()}`)
        rest = rest.slice(cut)
        while (rest[0] === ' ') rest.shift()
        indent = CONTINUATION_INDENT
    }
    if (rest.length > 0) out.push(`${indent}${rest.join('')}`)
    return out
}

/**
 * Group the body under blank lines: status rows group (`⚠️`/`✅`), their
 * indented continuations stay with them, and the closing rows stand alone.
 */
function groupBody(source: readonly string[]): string[] {
    const blocks: string[][] = []
    let current: string[] = []
    let pendingBreak = false
    const flush = (): void => {
        if (current.length > 0) blocks.push(current)
        current = []
    }
    for (const raw of source) {
        const line = raw.trimEnd()
        if (line.trim() === '') {
            flush()
            pendingBreak = true
            continue
        }
        const previous = current[current.length - 1]
        const splits = STATUS_START.test(line) && (previous === undefined || !STATUS_START.test(previous))
        if (pendingBreak || splits || CLOSING_START.test(line)) flush()
        pendingBreak = false
        current.push(line)
    }
    flush()
    const out: string[] = []
    for (const block of blocks) {
        if (out.length > 0) out.push('')
        out.push(...block)
    }
    return out
}

/** Wrap every line and collapse the blank-line separators. */
function wrapAll(lines: readonly string[]): string[] {
    const out: string[] = []
    for (const line of lines) {
        if (line.trim() === '') {
            if (out.length > 0 && out[out.length - 1] !== '') out.push('')
            continue
        }
        out.push(...wrapLine(line))
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out
}

/** Fold everything past {@link MAX_REPORT_LINES} into the honest note line. */
function foldLines(lines: readonly string[]): { lines: string[]; folded: number } {
    if (lines.length <= MAX_REPORT_LINES) return { lines: [...lines], folded: 0 }
    const kept = lines.slice(0, MAX_REPORT_LINES - 1)
    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
    const folded = lines.length - kept.length
    return { lines: [...kept, `…另有 ${folded} 行（完整文本见 feed）`], folded }
}

/**
 * Lay one report out for the float and the feed.
 * @param text - the report `renderConfigInspection` / `renderSuiteHealth` /
 *   the init plan / a config edit produced.
 * @returns title, width/fold-bounded body, one-line summary and fold count.
 */
export function layoutReport(text: string): ReportLayout {
    const normalized = (typeof text === 'string' ? text : String(text)).replace(/\r\n?/g, '\n')
    const source = normalized.split('\n').map((line) => line.trimEnd())
    while (source.length > 0 && (source[source.length - 1] ?? '') === '') source.pop()
    const title = titleOf(source[0] ?? '')
    const summary = summaryLine(title, source)
    const body = groupBody(source.slice(1))
    const folded = foldLines(wrapAll([summary, '', ...body]))
    return { title, lines: folded.lines, summary, folded: folded.folded }
}

/** The optional float surface, only when it can actually render (AC-001). */
function floatServiceOf(value: unknown): NvimTuiFloatLike | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const service = value as NvimTuiFloatLike
    if (typeof service.ui?.float !== 'function' || typeof service.ui.floatClose !== 'function') return undefined
    if (typeof service.capabilities === 'function') {
        try {
            if (service.capabilities()['headless'] === true) return undefined
        } catch {
            return undefined
        }
    }
    return service
}

/** Read the service lazily and defensively: a broken host is a fallback, not an error. */
function serviceOf(context: ReportUiContext): NvimTuiFloatLike | undefined {
    try {
        return floatServiceOf(context.get('nvim-tui'))
    } catch {
        return undefined
    }
}

/** Close the previous report float; a stale window is not a failure. */
async function closeOpenFloat(): Promise<void> {
    const previous = openFloat
    openFloat = undefined
    if (previous === undefined) return
    try {
        await previous.service.ui?.floatClose?.(previous.id)
    } catch {
        // The old float is gone with its editor/session; nothing to report.
    }
}

/** Try the float; `true` only when the window really opened. */
async function tryShowFloat(service: NvimTuiFloatLike, title: string, lines: readonly string[]): Promise<boolean> {
    const ui = service.ui
    if (ui?.float === undefined) return false
    await closeOpenFloat()
    try {
        const opened = await ui.float({
            title,
            lines: [...lines],
            height: Math.min(lines.length + 2, MAX_REPORT_LINES),
            width: FLOAT_WIDTH,
        })
        const id = (opened as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') openFloat = { service, id }
        return true
    } catch {
        return false
    }
}

/**
 * Present one report on the best surface the host has.
 *
 * Both paths consume the same {@link layoutReport} output; the float path only
 * decides how much of it is shown where. The result is ALWAYS a success — the
 * report is a read-only answer, so a missing or broken UI must not fail it.
 * @param context - live host accessor (the optional `nvim-tui` service).
 * @param title - float title (`suite · show|doctor|init|set|edit`).
 * @param text - the complete report text.
 * @returns the feed record: the summary, plus the full text when it was folded.
 */
export async function showReport(context: ReportUiContext, title: string, text: string): Promise<{ kind: 'success'; text: string }> {
    const layout = layoutReport(text)
    const floatTitle = title.trim() === '' ? layout.title : title.trim()
    const service = serviceOf(context)
    if (service !== undefined && (await tryShowFloat(service, floatTitle, layout.lines))) {
        return { kind: 'success', text: layout.folded > 0 ? `${layout.summary}\n${text.trimEnd()}` : layout.summary }
    }
    return { kind: 'success', text }
}

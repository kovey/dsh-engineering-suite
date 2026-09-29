/**
 * Where the change set comes from, and who gets to say so.
 *
 * The harness may mount `workspaceChanges`
 * (`@deepseek-ai/dsh-workspace-changes`), a HOST service that records what each
 * top-level turn changed: `summary(sessionId, seq)` returns the changed files of
 * the turn announced by the `workspace/changes` event at `seq`, and
 * `diff(sessionId, seq, index, signal)` compares one listed file's turn-start and
 * turn-end contents (unified hunks, or a `binary` / `oversized` refusal).
 *
 * That is a FACT, and the host knows it better than our own `git diff` parsing
 * does — but it is a DIFFERENT fact from "what the working tree differs by
 * against `base`". So this module:
 *
 *  - reads the service defensively (a throwing method is a fallback REASON, never
 *    a crash) and never invents a change set it could not read;
 *  - prefers the service under `changeSource: 'auto'`, falls back to git with the
 *    reason printed in the report, and REFUSES loudly when the host pinned the
 *    service but it cannot answer;
 *  - reports provenance (`workspaceChanges` / `git` / `git（回退：…）`) in the
 *    report and in the recorded artifact, together with the limits of the source
 *    that answered — we cannot verify the service against the filesystem, so we
 *    say where the facts came from instead of claiming authority.
 *
 * @module dsh-impact-gate/changes
 */

import path from 'node:path'
import type { ChangedFile } from 'dsh-eng-core'
import { sessionIdOf, type AgentLike, type Logger } from 'dsh-eng-core'
import type { ChangeSource, ImpactGateConfig } from './config.js'

/** One entry of the host's summary (the fields this plugin reads). */
interface ServiceFileLike {
    path?: unknown
    display?: unknown
    added?: unknown
    deleted?: unknown
    binary?: unknown
    oversized?: unknown
}

/** The host summary this plugin reads (structural: the service is not a dependency). */
interface ServiceSummaryLike {
    turn?: unknown
    cwd?: unknown
    files?: unknown
    total?: unknown
}

/** One hunk of a service comparison. */
interface ServiceHunkLike {
    newStart?: unknown
    newLines?: unknown
    lines?: unknown
}

/** The host comparison this plugin reads. */
interface ServiceDiffLike {
    kind?: unknown
    before?: unknown
    after?: unknown
    hunks?: unknown
    coarse?: unknown
}

/** The `workspaceChanges` service, as this plugin uses it. */
export interface WorkspaceChangesLike {
    summary: (sessionId: string, seq: number) => ServiceSummaryLike | undefined
    diff: (sessionId: string, seq: number, index: number, signal: AbortSignal) => Promise<ServiceDiffLike | undefined>
}

/** The event name the host announces a turn's summary with. */
export const CHANGES_EVENT = 'workspace/changes'

// --- the ledger: which `workspace/changes` event belongs to which session -----

/** The announcing event of one session's newest recorded turn. */
export interface RecordedTurn {
    seq: number
    turn: number
}

/**
 * Remembers the newest `workspace/changes` event per session.
 *
 * The service is keyed by `(sessionId, seq)`, and the seq is not discoverable
 * from the service itself, so the event is observed as it is appended (the same
 * seam the service plugin itself uses). A session that recorded nothing — or one
 * whose event happened before this plugin was mounted — simply has no entry, and
 * that is a fallback reason, never a silent "nothing changed".
 */
export class ChangeLedger {
    private readonly turns = new Map<string, RecordedTurn>()

    /** Bound on remembered sessions: a long-lived host must not grow forever. */
    private readonly cap: number

    constructor(cap = 500) {
        this.cap = cap
    }

    /**
     * Observe one `session/event` payload.
     * @returns whether it was a `workspace/changes` event this ledger recorded.
     */
    observe(session: unknown, event: unknown): boolean {
        const id = sessionIdOfSession(session)
        const record = eventOf(event)
        if (id === undefined || record === undefined) return false
        // Re-insert so the insertion order is "least recently recorded first"
        // and the cap evicts the session that has been quiet longest.
        this.turns.delete(id)
        this.turns.set(id, record)
        while (this.turns.size > this.cap) {
            const oldest = this.turns.keys().next()
            if (oldest.done === true) break
            this.turns.delete(oldest.value)
        }
        return true
    }

    /** Forget one session (its summaries die with it). */
    forget(session: unknown): void {
        const id = sessionIdOfSession(session)
        if (id !== undefined) this.turns.delete(id)
    }

    /** The newest recorded turn of one session. */
    latestFor(sessionId: string): RecordedTurn | undefined {
        return this.turns.get(sessionId)
    }

    /** Sessions currently remembered (reported by `impact_status`). */
    get sessions(): number {
        return this.turns.size
    }
}

/** The id of a session-like object, either spelling the harness uses. */
function sessionIdOfSession(session: unknown): string | undefined {
    if (typeof session !== 'object' || session === null) return undefined
    const direct = (session as { id?: unknown }).id
    if (typeof direct === 'string' && direct !== '') return direct
    const header = (session as { header?: { id?: unknown } }).header
    return typeof header?.id === 'string' && header.id !== '' ? header.id : undefined
}

/** The `{type, seq, data.turn}` of a `workspace/changes` event, or `undefined`. */
function eventOf(event: unknown): RecordedTurn | undefined {
    if (typeof event !== 'object' || event === null) return undefined
    const typed = event as { type?: unknown; seq?: unknown; data?: { turn?: unknown } }
    if (typed.type !== CHANGES_EVENT) return undefined
    if (typeof typed.seq !== 'number' || !Number.isSafeInteger(typed.seq) || typed.seq < 0) return undefined
    const turn = typed.data?.turn
    return { seq: typed.seq, turn: typeof turn === 'number' && Number.isSafeInteger(turn) ? turn : -1 }
}

// --- provenance --------------------------------------------------------------

/** Which source answered, and what it could not tell us. */
export interface ChangeProvenance {
    /** The source that produced the change set. */
    source: 'workspaceChanges' | 'git' | 'paths'
    /**
     * Why the preferred source was not used. Set exactly when git answered in
     * place of the service — the case that must never look like a normal run.
     */
    fallbackReason?: string
    /** One line naming what the change set is relative to (the ref, or the turn). */
    detail: string
    /** `hunk` = added line ranges, `file` = paths and counts only. */
    granularity: 'hunk' | 'file' | 'none'
    /** The session and turn the service reported (service source only). */
    turn?: { session: string; turn: number; seq: number }
    /** Files the service listed that this analysis cannot use, with the reason. */
    skipped?: { path: string; reason: string }[]
    /** Files the service listed but refused to compare (binary / oversized). */
    noHunks?: string[]
    /** The service's own cap: `total` files changed, `files` carried. */
    capped?: { total: number; listed: number }
    /** What `git diff base` said, when git could answer (service source only). */
    crossCheck?: { base: string; gitFiles: number; onlyInGit: string[]; onlyInService: string[] }
    /** Source-specific limits, printed verbatim in the report. */
    limits: string[]
}

/** Where the caller's explicit paths came from. */
export function pathsProvenance(): ChangeProvenance {
    return {
        source: 'paths',
        detail: '显式 paths（调用方给定：没有 diff，新增行区间不可用）',
        granularity: 'none',
        limits: [],
    }
}

/** Where a `git diff` change set came from. */
export function gitProvenance(base: string, fallbackReason?: string): ChangeProvenance {
    return {
        source: 'git',
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
        detail: base,
        granularity: 'hunk',
        limits: [],
    }
}

/**
 * The exact source label an audit reads.
 *
 * `workspaceChanges` / `git` / `git（回退：<reason>）` — the fallback form names
 * the reason, so "git answered instead" is never mistaken for the normal path.
 */
export function sourceLabel(provenance: ChangeProvenance): string {
    if (provenance.source === 'workspaceChanges') return 'workspaceChanges'
    if (provenance.source === 'paths') return '显式 paths'
    return provenance.fallbackReason === undefined ? 'git' : `git（回退：${provenance.fallbackReason}）`
}

// --- the provider ------------------------------------------------------------

/** Everything the provider needs to reach the host service. */
export interface ChangeProviderDeps {
    /** `ctx.get('workspaceChanges')` — the service may not be mounted at all. */
    service: () => unknown
    /** The newest recorded turn per session. */
    ledger: ChangeLedger
    /** Whether the service is mounted and shaped like the service (read-only report). */
    mounted: () => boolean
    logger?: Logger
}

/** One resolution: the facts to analyse, and where they came from. */
export interface ResolvedChanges {
    /**
     * The change set core must use. `undefined` means "let core read the diff
     * itself" (the git path), which keeps that path byte-for-byte as it was.
     */
    adopted?: readonly ChangedFile[]
    /** The label core reports as `ImpactReport.base`. */
    base: string
    provenance: ChangeProvenance
}

/** Inputs of {@link resolveChangeSet}. */
export interface ResolveChangesInput {
    cwd: string
    /** The configured diff base (unused by the service, which has no ref). */
    base: string
    config: ImpactGateConfig
    /** Explicit paths: the caller's own facts win over both sources. */
    paths?: readonly string[]
    agent?: AgentLike
    signal?: AbortSignal
    /** The caller's own `changedRanges` read, reused for the cross-check. */
    gitRead?: { isRepo: boolean; problem?: string; files?: readonly { path: string }[] }
}

/** What one service read produced. */
type ServiceRead =
    | { ok: true; files: ChangedFile[]; provenance: ChangeProvenance }
    | { ok: false; reason: string }

/** Cancellation is not a source failure: it must not be turned into a fallback. */
function aborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true
}

function cancelledError(): Error {
    return new Error('调用方已取消（signal 已 abort）：未做分析。下一步：确认会话仍在运行后重试 impact_analyze。')
}

/**
 * Decide which source supplies the change set for one analysis.
 *
 * Never throws for an unusable source unless the host PINNED it: `auto` falls
 * back to git with the reason recorded, and the caller renders that reason.
 * @param deps - service access and the turn ledger.
 * @param input - workspace, config, caller arguments.
 * @returns the facts to analyse plus their provenance.
 */
export async function resolveChangeSet(deps: ChangeProviderDeps, input: ResolveChangesInput): Promise<ResolvedChanges> {
    if (aborted(input.signal)) throw cancelledError()
    if (input.paths !== undefined) return { base: input.base, provenance: pathsProvenance() }
    if (input.config.changeSource === 'git') {
        // Pinned to git: the service is not even consulted, so a broken service
        // cannot influence this run.
        return { base: input.base, provenance: gitProvenance(input.base) }
    }

    const read = await readFromService(deps, input)
    if (read.ok) return { adopted: read.files, base: read.provenance.detail, provenance: read.provenance }
    if (input.config.changeSource === 'workspaceChanges') throw new Error(refusalMessage(read.reason))
    if (aborted(input.signal)) throw cancelledError()
    deps.logger?.for(input.cwd).warn(`impact-gate: workspaceChanges 不可用，回退 git（${read.reason}）`)
    return { base: input.base, provenance: gitProvenance(input.base, read.reason) }
}

/** The refusal a pinned-but-unusable source produces: the key, the state, the fix. */
export function refusalMessage(reason: string): string {
    return [
        `changeSource 已固定为 'workspaceChanges'，但这次分析拿不到它的改动集：${reason}`,
        '',
        '宁可拒绝，也不静默回退：`workspaceChanges` 与 `git diff` 回答的是两个不同的问题（宿主记录的"这一轮改了什么" vs "相对 base 的差异"），' +
            '在宿主明确指定了来源之后改用另一个，等于让这次分析的结果与宿主的要求不一致，而报告看起来仍然是成功的。',
        '',
        '下一步三选一：',
        '- 挂载宿主服务：把 `@deepseek-ai/dsh-workspace-changes` 加进宿主插件行（它提供 `workspaceChanges`），重启后重试；',
        "- 改成 `auto`：`config.changeSource: 'auto'`（有服务就用它，没有就回退 git，并在报告里写明回退原因）；",
        "- 改成 `git`：`config.changeSource: 'git'`（明确只用 `git diff <base>`）。",
    ].join('\n')
}

/** Read the whole change set from the host service; never throws. */
async function readFromService(deps: ChangeProviderDeps, input: ResolveChangesInput): Promise<ServiceRead> {
    const service = deps.service()
    if (!isService(service)) {
        return { ok: false, reason: '宿主没有挂载 workspaceChanges 服务（ctx.get("workspaceChanges") 为空）' }
    }
    const sessionId = sessionIdOf(input.agent)
    if (sessionId === undefined) return { ok: false, reason: '调用方会话没有 id：无法按会话读取宿主记录的改动' }
    const recorded = deps.ledger.latestFor(sessionId)
    if (recorded === undefined) {
        return {
            ok: false,
            reason:
                '本会话没有 workspace/changes 记录（宿主这一轮没记录改动，或本插件在事件之后才装载）——' +
                '没有记录不等于没有改动，所以不回落到"无改动"',
        }
    }

    const summary = call(() => service.summary(sessionId, recorded.seq))
    if (!summary.ok) return { ok: false, reason: `workspaceChanges.summary() 抛错：${summary.problem}` }
    if (summary.value === undefined) {
        return { ok: false, reason: `workspaceChanges 没有 seq=${recorded.seq} 的摘要（会话可能已释放）` }
    }
    const listed = listedFiles(summary.value)
    if (!listed.ok) return { ok: false, reason: `workspaceChanges 返回的摘要结构不可用：${listed.problem}` }
    const { files, total } = listed
    // The summary's own `turn` is the record's field; the event's is the fallback
    // (they agree in the real service, and the report must name ONE of them).
    const turn = listed.turn ?? recorded.turn
    if (files.length === 0) {
        return {
            ok: false,
            reason: `workspaceChanges 报了第 ${turn < 0 ? '?' : turn} 轮 0 个改动文件（可能是宿主没记录到这一轮，或快照早于改动）`,
        }
    }

    const changed: ChangedFile[] = []
    const skipped: { path: string; reason: string }[] = []
    const noHunks: string[] = []
    let hunkFiles = 0
    for (const [index, file] of files.entries()) {
        const relative = relativeTo(input.cwd, file.path)
        if (relative === undefined) {
            // Outside the workspace: it cannot be in the import graph, and
            // silently dropping it would shrink the change set without a trace.
            // No comparison is requested either — a file this analysis cannot
            // use must not be able to fail the read.
            skipped.push({ path: file.path, reason: '不在工作区内：不参与导入图（按跳过处理）' })
            continue
        }
        const comparison = await callAsync(() => service.diff(sessionId, recorded.seq, index, input.signal ?? new AbortController().signal))
        if (!comparison.ok) {
            if (aborted(input.signal)) throw cancelledError()
            return { ok: false, reason: `workspaceChanges.diff() 抛错（第 ${index + 1} 个文件 ${file.path}）：${comparison.problem}` }
        }
        if (comparison.value === undefined) {
            return {
                ok: false,
                reason: `workspaceChanges 对第 ${index + 1} 个文件 ${file.path} 没有比较结果（会话已释放或索引失效）`,
            }
        }
        const kind = comparison.value.kind
        if (kind === 'text') {
            hunkFiles += 1
            changed.push({
                path: relative,
                added: addedRanges(comparison.value.hunks),
                removed: count(file.deleted),
                status: statusOf(comparison.value),
            })
            continue
        }
        if (kind === 'binary' || kind === 'oversized') {
            noHunks.push(relative)
            changed.push({ path: relative, added: [], removed: count(file.deleted), status: 'modified' })
            continue
        }
        return { ok: false, reason: `workspaceChanges 对 ${file.path} 返回了不认识的比较结果（kind=${JSON.stringify(kind ?? null)}）` }
    }

    changed.sort((left, right) => left.path.localeCompare(right.path))
    if (changed.length === 0) {
        // Every listed file was outside the workspace: the change set this
        // analysis can use is empty, and reporting that as "no changes" would be
        // the exact failure this provider exists to prevent.
        return {
            ok: false,
            reason: `workspaceChanges 的 ${files.length} 个改动文件全部不在工作区内（${skipped
                .slice(0, 5)
                .map((entry) => entry.path)
                .join('、')}${skipped.length > 5 ? ' 等' : ''}）：对这次分析等于空改动集`,
        }
    }
    const provenance: ChangeProvenance = {
        source: 'workspaceChanges',
        detail: `workspaceChanges（会话 ${sessionId} 第 ${turn < 0 ? '?' : turn} 轮，事件 seq=${recorded.seq}）`,
        granularity: hunkFiles > 0 ? 'hunk' : 'file',
        turn: { session: sessionId, turn, seq: recorded.seq },
        ...(skipped.length === 0 ? {} : { skipped }),
        ...(noHunks.length === 0 ? {} : { noHunks }),
        ...(total > files.length ? { capped: { total, listed: files.length } } : {}),
        limits: serviceLimits({ skipped, noHunks, total, listed: files.length }),
    }
    const crossCheck = crossCheckOf(input, changed)
    return {
        ok: true,
        files: changed,
        provenance: crossCheck === undefined ? provenance : { ...provenance, crossCheck },
    }
}

/** The limits of the service as a fact source, in the words the report prints. */
function serviceLimits(input: {
    skipped: readonly { path: string }[]
    noHunks: readonly string[]
    total: number
    listed: number
}): string[] {
    const limits: string[] = [
        '宿主服务报的是**某一轮的改动**（turn 快照：这一轮开始与结束时的差异），不是"工作区相对某个 base 的差异"：' +
            '在它之后（或之前）几轮里的改动不在这次改动集里。',
        '服务的摘要不提供重命名前的路径：旧路径的依赖者没有被跟踪，需要人工确认（`git` 来源才有 `previousPath`）。',
    ]
    if (input.listed < input.total) limits.push(`服务上限：共 ${input.total} 个改动文件，只列出了 ${input.listed} 个。`)
    if (input.noHunks.length > 0) {
        limits.push(`${input.noHunks.length} 个文件是二进制或超大：服务没有给出行数，这次也没有行区间（${input.noHunks.slice(0, 5).join('、')}${input.noHunks.length > 5 ? ' 等' : ''}）。`)
    }
    if (input.skipped.length > 0) {
        limits.push(`${input.skipped.length} 个改动文件不在工作区内，未参与导入图（${input.skipped.slice(0, 5).map((entry) => entry.path).join('、')}${input.skipped.length > 5 ? ' 等' : ''}）。`)
    }
    limits.push('这次分析无法把服务的结果与文件系统对账：宿主说它记了什么就是什么，报告只写明来源与轮次，不声称独立核实过。')
    return limits
}

/** Compare the service's change set with the caller's own git read (report only). */
function crossCheckOf(
    input: ResolveChangesInput,
    changed: readonly ChangedFile[],
): ChangeProvenance['crossCheck'] | undefined {
    const git = input.gitRead
    if (git === undefined || !git.isRepo || git.problem !== undefined || git.files === undefined) return undefined
    const gitPaths = new Set(git.files.map((file) => file.path))
    const servicePaths = new Set(changed.map((file) => file.path))
    return {
        base: input.base,
        gitFiles: gitPaths.size,
        // Capped for the report; the counts above are the complete truth.
        onlyInGit: [...gitPaths].filter((entry) => !servicePaths.has(entry)).sort().slice(0, 10),
        onlyInService: [...servicePaths].filter((entry) => !gitPaths.has(entry)).sort().slice(0, 10),
    }
}

/** Whether `value` looks like the host service (structure, not identity). */
function isService(value: unknown): value is WorkspaceChangesLike {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as { summary?: unknown; diff?: unknown }
    return typeof candidate.summary === 'function' && typeof candidate.diff === 'function'
}

/** The listed files of one summary, or why the shape is unusable. */
function listedFiles(
    summary: unknown,
): { ok: true; files: { path: string; deleted: number }[]; total: number; turn?: number } | { ok: false; problem: string } {
    if (typeof summary !== 'object' || summary === null) return { ok: false, problem: `摘要不是对象（${typeof summary}）` }
    const typed = summary as ServiceSummaryLike
    if (!Array.isArray(typed.files)) return { ok: false, problem: 'files 不是数组' }
    const files: { path: string; deleted: number }[] = []
    for (const [index, entry] of (typed.files as ServiceFileLike[]).entries()) {
        if (typeof entry !== 'object' || entry === null) return { ok: false, problem: `files[${index}] 不是对象` }
        if (typeof entry.path !== 'string' || entry.path.trim() === '') {
            return { ok: false, problem: `files[${index}].path 不是非空字符串` }
        }
        files.push({ path: entry.path.trim(), deleted: count(entry.deleted) })
    }
    const total = typeof typed.total === 'number' && Number.isFinite(typed.total) ? typed.total : files.length
    const turn = typeof typed.turn === 'number' && Number.isSafeInteger(typed.turn) && typed.turn >= 0 ? typed.turn : undefined
    return { ok: true, files, total, ...(turn === undefined ? {} : { turn }) }
}

/** A non-negative line count, `0` when the service did not report one. */
function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** `added` / `deleted` / `modified`, from the two existence flags the service reports. */
function statusOf(comparison: ServiceDiffLike): ChangedFile['status'] {
    if (comparison.before === false && comparison.after === true) return 'added'
    if (comparison.before === true && comparison.after === false) return 'deleted'
    return 'modified'
}

/**
 * The added line ranges of one comparison, in the NEW file's numbering.
 *
 * Every hunk line carries its `+`/`-`/space prefix, so a maximal run of `+` lines
 * is one added range — the same shape `git diff -U0` produces, computed from the
 * service's own hunks instead of from a second read of the workspace.
 */
function addedRanges(hunks: unknown): [number, number][] {
    if (!Array.isArray(hunks)) return []
    const ranges: [number, number][] = []
    for (const raw of hunks as ServiceHunkLike[]) {
        if (typeof raw !== 'object' || raw === null) continue
        const start = typeof raw.newStart === 'number' && Number.isFinite(raw.newStart) ? raw.newStart : undefined
        if (start === undefined || !Array.isArray(raw.lines)) continue
        let line = start
        let open: [number, number] | undefined
        for (const entry of raw.lines) {
            if (typeof entry !== 'string' || entry === '') continue
            const marker = entry[0]
            if (marker === '+') {
                if (open === undefined) open = [line, line]
                else open[1] = line
                line += 1
                continue
            }
            if (open !== undefined) {
                ranges.push(open)
                open = undefined
            }
            if (marker === ' ') line += 1
        }
        if (open !== undefined) ranges.push(open)
    }
    const sorted = ranges.sort((left, right) => left[0] - right[0])
    // Two runs the service's own hunk separated only by removed lines are
    // ADJACENT in the new file, which is exactly the range `git diff -U0`
    // reports as one: merging them keeps the two sources' `added` shapes equal,
    // so nothing downstream has to know which one answered.
    const merged: [number, number][] = []
    for (const range of sorted) {
        const previous = merged[merged.length - 1]
        if (previous !== undefined && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
        else merged.push([range[0], range[1]])
    }
    return merged
}

/**
 * A workspace-relative POSIX path, or `undefined` when the path is outside.
 *
 * The service reports `../…` for repository files above the working directory
 * and absolute paths for files outside it; neither can be reached by an import
 * graph rooted at the workspace, so they are reported as skipped instead of
 * being rewritten into a path that does not exist.
 */
function relativeTo(cwd: string, reported: string): string | undefined {
    const absolute = path.isAbsolute(reported) ? reported : path.resolve(cwd, reported)
    const relative = path.relative(cwd, absolute)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    return relative.split(path.sep).join('/')
}

/** Run a synchronous service method, turning a throw into a described failure. */
function call<T>(run: () => T): { ok: true; value: T } | { ok: false; problem: string } {
    try {
        return { ok: true, value: run() }
    } catch (error) {
        return { ok: false, problem: describe(error) }
    }
}

/** Run an asynchronous service method, turning a throw into a described failure. */
async function callAsync<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; problem: string }> {
    try {
        return { ok: true, value: await run() }
    } catch (error) {
        return { ok: false, problem: describe(error) }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The `changeSource` value, for messages that must name the key and its state. */
export function changeSourceLabel(source: ChangeSource): string {
    if (source === 'auto') return "auto（有 workspaceChanges 服务就用它，否则回退 git 并写明原因）"
    if (source === 'workspaceChanges') return "workspaceChanges（固定用宿主服务：服务不可用时拒绝执行）"
    return 'git（固定用 git diff：即使服务已挂载也不使用）'
}

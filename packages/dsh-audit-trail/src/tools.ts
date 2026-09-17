/**
 * The model-facing tool surface: `audit_report` and `audit_rewind`.
 *
 * Both tools are read-mostly: `audit_report` only reads the JSONL trail, and
 * `audit_rewind` writes to the workspace **only** when the caller explicitly
 * passes `dryRun: false` + `confirm: true`, and only for paths that live inside
 * the session workspace and outside the trail's own root.
 *
 * @module dsh-audit-trail/tools
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    auditFile,
    cell,
    exists,
    formatTime,
    isInside,
    listDir,
    sessionCwd,
    sessionIdOf,
    type AgentLike,
    type Layout,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { shouldSnapshot, type AuditTrailConfig, type EffectiveAuditTrailConfig } from './config.js'
import { readRows, type AuditRow, type PreRow, type ResultRow, type SnapshotRecord } from './journal.js'
import { declaredCwdOf } from './workspace.js'
import { applyRewind, captureFileState, type FileState, type RewindStep } from './snapshot.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools close over. */
export interface ToolDeps {
    /** The profile configuration (the ceiling for every workspace). */
    config: AuditTrailConfig
    stores: MissionStoreRegistry
    /** The configuration of one workspace (profile + its own `.dsh/audit-trail.json`). */
    configFor: (cwd: string) => EffectiveAuditTrailConfig
}

/**
 * The effective configuration of one workspace.
 *
 * Never throws: a broken project file degrades to the profile configuration
 * (never to "no audit trail"), so a report can always be printed.
 */
function effectiveFor(deps: ToolDeps, cwd: string): EffectiveAuditTrailConfig {
    try {
        return deps.configFor(cwd)
    } catch {
        return { config: deps.config, source: 'profile', problems: [] }
    }
}

/**
 * The two configuration lines every tool prints: where this workspace's
 * configuration came from, and the snapshot policy that is actually in force
 * here (a project-level file may have changed it).
 */
function configLines(effective: EffectiveAuditTrailConfig): string[] {
    const source = effective.source === 'project' ? `项目级 ${effective.file ?? '(未知路径)'}` : 'profile（该工作区没有 .dsh/audit-trail.json）'
    const snapshot = effective.config.snapshot
    return [
        `- 配置来源：${source}`,
        `- 生效快照策略：snapshot.enabled=${snapshot.enabled}，maxFileBytes=${snapshot.maxFileBytes}，maxFilesPerTurn=${snapshot.maxFilesPerTurn}；writeTools=${effective.config.writeTools.join(', ') || '(无)'}；redactArgs=${effective.config.redactArgs}`,
        ...(effective.problems.length === 0
            ? []
            : [`- 项目级配置问题：${effective.problems.length} 条（涉及的值一律回退到 profile，详见插件日志）`]),
    ]
}

/** Report arguments. */
interface ReportArgs {
    missionId?: string
    sessionId?: string
    tool?: string
    sinceMinutes?: number
    limit?: number
}

/** Rewind arguments. */
interface RewindArgs {
    turn?: number
    /** ISO-8601 timestamp: replay every snapshot recorded at or after it. */
    since?: string
    /** Minutes before now: shorthand for `since`. */
    sinceMinutes?: number
    sessionId?: string
    dryRun?: boolean
    confirm?: boolean
    /** Delete creation-compensations even when the file changed after the turn. */
    force?: boolean
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/** The session/workspace the call is about. */
interface Target {
    agent: AgentLike | undefined
    cwd: string
    layout: Layout
    /** `undefined` when the host exposed no session id. */
    sessionId: string | undefined
}

function targetOf(deps: ToolDeps, exec: unknown, explicitSessionId?: string): Target {
    const agent = agentOf(exec)
    const cwd = declaredCwdOf(agent)
    if (cwd === undefined) {
        // `sessionCwd()` would fall back to `process.cwd()`: `audit_rewind` would
        // then REPLAY SNAPSHOTS of the harness's own directory — a different
        // project. Refuse instead of guessing.
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：审计轨迹属于哪个项目无法判定，本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    const layout = deps.stores.for(cwd).layout
    const sessionId = explicitSessionId ?? sessionIdOf(agent)
    return { agent, cwd, layout, sessionId }
}

/** Sessions that actually own a trail file, newest first. */
function sessionsWithTrails(layout: Layout): string[] {
    return listDir(layout.auditDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.replace(/\.jsonl$/, ''))
        .sort()
}

function parseTime(ts: string): number {
    const parsed = Date.parse(ts)
    return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** Render one timestamp for a human (`2026-09-17 14:52:30Z`). */
function timeOf(ts: string): string {
    const parsed = parseTime(ts)
    return Number.isFinite(parsed) ? formatTime(parsed) : ts
}

/** `ok` column of the compact table. */
function okOf(row: AuditRow): string {
    if (row.phase === 'result') return (row as ResultRow).isError ? '✗失败' : '✓'
    return row.decision === 'allow' ? 'allow' : row.decision === 'ask' ? 'ask' : '✗deny'
}

function describePath(record: SnapshotRecord, layout: Layout): string {
    return isInside(layout.cwd, record.path) ? record.relPath : record.path
}

/** Human text for a record that carries no pre-state, so rewind can never use it. */
function reasonText(record: SnapshotRecord): string {
    if (record.reason === 'error') return `快照失败（不可回滚）：${record.error ?? '(无错误信息)'}`
    if (record.reason === 'outside-workspace') return '未快照（目标在工作区之外）'
    if (record.reason === 'internal') return '未快照（目标位于审计工件目录内）'
    if (record.reason === 'oversize') return '未快照（超过 snapshot.maxFileBytes）'
    if (record.reason === 'quota') return '未快照（超过 snapshot.maxFilesPerTurn）'
    if (record.reason === 'not-a-file') return '未快照（目标不是普通文件）'
    return `未快照（${record.reason ?? '未知原因'}）`
}

/**
 * Digest of the file as the audit saw it *after* one write, learned from the
 * next snapshot of the same path that actually recorded bytes (its pre-state
 * is the post-state of the earlier write). Used by `audit_rewind` as evidence
 * that an `existed: false` target was written again after the recorded turn.
 * @param rows - every row of the session, in journal order.
 * @returns absolute path → digest of the next recorded state (`''` when none).
 */
function postDigestsOf(rows: AuditRow[]): Map<string, string> {
    const pres = rows.filter(
        (row): row is PreRow => row.phase === 'pre' && row.snapshot !== undefined && row.snapshot.reason === undefined,
    )
    const result = new Map<string, string>()
    pres.forEach((row, index) => {
        const record = row.snapshot as SnapshotRecord
        for (const later of pres.slice(index + 1)) {
            if (later.snapshot?.path !== record.path) continue
            if (later.snapshot.digest !== '') {
                result.set(record.path, later.snapshot.digest)
                break
            }
        }
    })
    return result
}

/** Compact table of the newest rows. */
function renderTable(rows: AuditRow[], limit: number): string[] {
    const pres = new Map<string, PreRow>()
    for (const row of rows) if (row.phase === 'pre') pres.set(row.callId, row as PreRow)
    const newest = rows.slice(-limit)
    if (newest.length === 0) return ['（无匹配行）']
    const lines = ['| 时间 | 工具 | 轮次 | 结果 | 参数摘要 |', '|---|---|---|---|---|']
    for (const row of newest) {
        const summary = row.phase === 'pre' ? row.argsSummary : (pres.get(row.callId)?.argsSummary ?? '')
        lines.push(
            `| ${cell(timeOf(row.ts))} | ${cell(row.tool)} | ${cell(row.turn === undefined ? '-' : String(row.turn))} | ${cell(okOf(row))} | ${cell(summary.slice(0, 80))} |`,
        )
    }
    return lines
}

/** Register every audit-trail tool. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []

    const register = (definition: unknown, toolName: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(toolName)
        } catch {
            failed.push(toolName)
        }
    }

    register(
        defineTool({
            name: 'audit_report',
            description:
                'Summarize the audit trail of one session: total rows, per-tool counts, failed calls, write calls with their pre-write snapshot availability, and the newest rows as a compact table. Read-only; the trail lives in .dsh/audit/<sessionId>.jsonl (dsh-audit-trail).',
            parameters: {
                missionId: { type: 'string', description: 'Restrict the report to the session bound to this mission.' },
                sessionId: { type: 'string', description: 'Session whose trail is read (default: the calling session).' },
                tool: { type: 'string', description: 'Only rows of this tool name.' },
                sinceMinutes: { type: 'integer', description: 'Only rows newer than this many minutes.' },
                limit: { type: 'integer', description: 'How many of the newest rows the table shows (default 20).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ReportArgs = {} as ReportArgs, exec) {
                const target = targetOf(deps, exec, args.sessionId)
                const effective = effectiveFor(deps, target.cwd)
                const lines: string[] = []
                let sessionId = target.sessionId

                if (args.missionId !== undefined) {
                    const mission = deps.stores.for(target.cwd).read(args.missionId)
                    if (mission === undefined) return `未找到 mission ${args.missionId}（工作区 ${target.cwd}）。`
                    if (mission.sessionId === undefined) {
                        return `mission ${args.missionId} 没有绑定会话，无法定位审计日志。可改用 sessionId 参数。`
                    }
                    sessionId = mission.sessionId
                }

                if (sessionId === undefined) {
                    const known = sessionsWithTrails(target.layout)
                    lines.push('无法确定当前会话（宿主的 agent 没有暴露 session id），因此无法直接读取审计日志。')
                    lines.push(
                        known.length === 0
                            ? `工作区 ${target.cwd} 下还没有任何审计文件（${target.layout.auditDir}）。`
                            : `已有审计文件的会话（请用 sessionId 参数指定其一）：${known.join(', ')}`,
                    )
                    return lines.join('\n')
                }

                const file = auditFile(target.layout, sessionId)
                const all = readRows(file)
                const now = Date.now()
                const filtered = all.filter((row) => {
                    if (args.tool !== undefined && row.tool !== args.tool) return false
                    if (args.sinceMinutes !== undefined && args.sinceMinutes > 0) {
                        const at = parseTime(row.ts)
                        if (!Number.isFinite(at) || now - at > args.sinceMinutes * 60000) return false
                    }
                    return true
                })
                const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20) || 20, 1), 200)

                const pres = filtered.filter((row): row is PreRow => row.phase === 'pre')
                const results = filtered.filter((row): row is ResultRow => row.phase === 'result')
                const failures = results.filter((row) => row.isError)
                const perTool = new Map<string, number>()
                for (const row of pres) perTool.set(row.tool, (perTool.get(row.tool) ?? 0) + 1)
                const writePres = pres.filter((row) => shouldSnapshot(effective.config, row.tool))
                const withSnapshot = writePres.filter((row) => row.snapshot !== undefined && row.snapshot.reason === undefined)

                lines.push(`## 审计报告 — session ${sessionId}`)
                lines.push('')
                lines.push(`- 审计文件：${file}${exists(file) ? '' : '（不存在：该会话尚无记录）'}`)
                lines.push(`- 工作区：${target.cwd}`)
                lines.push(...configLines(effective))
                lines.push(`- 过滤：tool=${args.tool ?? '(不限)'}，sinceMinutes=${args.sinceMinutes ?? '(不限)'}`)
                lines.push(`- 总行数：${filtered.length}（pre ${pres.length} / result ${results.length}）${filtered.length === all.length ? '' : `，未过滤前 ${all.length}`}`)
                lines.push(`- 调用次数：${pres.length}，失败：${failures.length}`)
                lines.push(
                    `- 按工具：${perTool.size === 0 ? '(无)' : [...perTool.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => `${tool}×${count}`).join(', ')}`,
                )

                if (failures.length > 0) {
                    lines.push('')
                    lines.push(`失败调用（${failures.length}）：`)
                    for (const row of failures.slice(-10)) {
                        lines.push(`- ${row.tool} ${row.callId}（turn ${row.turn ?? '-'}，${timeOf(row.ts)}）：${cell(row.resultTail).slice(0, 160)}`)
                    }
                }

                lines.push('')
                lines.push(`写调用快照：${withSnapshot.length}/${writePres.length} 条可用`)
                for (const row of writePres.slice(-10)) {
                    const record = row.snapshot
                    if (record === undefined) {
                        lines.push(`- turn ${row.turn ?? '-'} ${row.tool} ${row.argsSummary.slice(0, 80)} → 无快照记录（该调用不是文件目标型写操作）`)
                        continue
                    }
                    const where = describePath(record, target.layout)
                    lines.push(
                        record.reason === undefined
                            ? `- turn ${row.turn ?? '-'} ${row.tool} ${where} → 快照 ${record.existed ? `已保存（digest ${record.digest.slice(0, 12)}，${record.bytes} 字节${record.mode === undefined ? '' : `，权限 ${record.mode.toString(8)}`}）` : '记录为“此前不存在”'}`
                            : `- turn ${row.turn ?? '-'} ${row.tool} ${where} → ${reasonText(record)}`,
                    )
                }

                lines.push('')
                lines.push(`最近 ${Math.min(limit, filtered.length)} 行：`)
                lines.push(...renderTable(filtered, limit))
                return lines.join('\n')
            },
        }),
        'audit_report',
    )

    register(
        defineTool({
            name: 'audit_rewind',
            description:
                'Roll the workspace back to the state it had before the end of a given turn, by replaying the pre-write snapshots recorded at or after that turn. Defaults to a dry run; writing requires dryRun=false together with confirm=true. Safety: a path that is now a symlink or not a regular file is refused; a creation-compensation deletes the file only when it was not modified after the recorded turn (pass force=true to override that single guard); a restore also puts the recorded file mode back. This is a workspace rollback only: it never touches git history (dsh-audit-trail).',
            parameters: {
                turn: {
                    type: 'integer',
                    description:
                        'Turn to rewind to: every snapshot of turn >= this value is replayed. Omit it (and use since/sinceMinutes) when the session never emitted agent/pre-step and therefore has no turn numbers.',
                },
                since: { type: 'string', description: 'ISO-8601 timestamp alternative to turn: replay every snapshot recorded at or after it.' },
                sinceMinutes: { type: 'integer', description: 'Relative alternative to turn (minutes before now).' },
                sessionId: { type: 'string', description: 'Session whose snapshots are replayed (default: the calling session).' },
                dryRun: { type: 'boolean', description: 'List the actions without touching disk (default true).' },
                confirm: { type: 'boolean', description: 'Must be true together with dryRun=false to actually write.' },
                force: {
                    type: 'boolean',
                    description:
                        'Delete creation-compensated files even when they were modified after the recorded turn (default false). Does not override the symlink refusal.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: RewindArgs = {} as RewindArgs, exec) {
                const requestedTurn = args.turn
                const sinceArg = typeof args.since === 'string' && args.since.trim() !== '' ? args.since.trim() : undefined
                const sinceMinutes =
                    typeof args.sinceMinutes === 'number' && Number.isFinite(args.sinceMinutes) ? args.sinceMinutes : undefined
                if (sinceMinutes !== undefined && sinceArg === undefined && requestedTurn === undefined) {
                    // handled below through `sinceMs`
                }
                const sinceMs =
                    sinceArg !== undefined
                        ? Date.parse(sinceArg)
                        : sinceMinutes !== undefined
                          ? Date.now() - sinceMinutes * 60_000
                          : undefined
                if (sinceArg !== undefined && Number.isNaN(sinceMs ?? Number.NaN)) {
                    throw new Error(`audit_rewind 的 since 不是可解析的时间戳：${sinceArg}（请用 ISO-8601，例如 2026-09-17T07:30:00Z）。`)
                }
                const byTime = sinceMs !== undefined
                if (!byTime && (typeof requestedTurn !== 'number' || !Number.isFinite(requestedTurn))) {
                    throw new Error(
                        'audit_rewind 需要 turn（按轮次回滚），或 since / sinceMinutes（按时间回滚；会话没有观测到 agent/pre-step 时用这个）。',
                    )
                }
                const target = targetOf(deps, exec, args.sessionId)
                if (target.sessionId === undefined) {
                    throw new Error(
                        `无法确定当前会话（宿主的 agent 没有暴露 session id），无法回滚。已有审计文件的会话：${sessionsWithTrails(target.layout).join(', ') || '(无)'}`,
                    )
                }
                const dryRun = args.dryRun !== false
                const force = args.force === true
                const file = auditFile(target.layout, target.sessionId)
                const rows = readRows(file)

                const candidates: { row: PreRow; index: number }[] = []
                let unusable = 0
                let failed = 0
                let untimed = 0
                let outOfRange = 0
                rows.forEach((row, index) => {
                    if (row.phase !== 'pre') return
                    const pre = row as PreRow
                    if (pre.snapshot === undefined) return
                    if (pre.snapshot.reason !== undefined) {
                        unusable += 1
                        if (pre.snapshot.reason === 'error') failed += 1
                        return
                    }
                    if (byTime) {
                        // Time-based selection does not need turn numbers at all,
                        // which is the only way to roll back a session whose turn
                        // was never observed.
                        const at = Date.parse(String(pre.ts))
                        if (Number.isFinite(at) && at < (sinceMs ?? 0)) {
                            outOfRange += 1
                            return
                        }
                        if (typeof pre.turn !== 'number') untimed += 1
                        candidates.push({ row: pre, index })
                        return
                    }
                    if (typeof pre.turn !== 'number') {
                        untimed += 1
                        return
                    }
                    if (pre.turn < (requestedTurn ?? 0)) {
                        outOfRange += 1
                        return
                    }
                    candidates.push({ row: pre, index })
                })
                // Newest first (journal position breaks the same-millisecond tie):
                // replaying backwards leaves the oldest pre-state in place.
                candidates.sort((a, b) => (a.row.ts === b.row.ts ? b.index - a.index : a.row.ts < b.row.ts ? 1 : -1))

                const postDigests = postDigestsOf(rows)

                const scopeLabel = byTime
                    ? `since >= ${new Date(sinceMs ?? 0).toISOString()}${sinceArg === undefined ? `（${sinceMinutes} 分钟前）` : ''}`
                    : `turn >= ${requestedTurn}`
                const lines: string[] = [`## 工作区回滚（audit_rewind）— session ${target.sessionId}，${scopeLabel}`]
                lines.push('')
                lines.push(`- 审计文件：${file}`)
                lines.push(...configLines(effectiveFor(deps, target.cwd)))
                lines.push(`- 模式：${dryRun ? 'dry-run（不写盘）' : '实际执行（dryRun=false + confirm=true）'}`)
                lines.push(`- force：${force ? 'true（创建补偿在文件被改动后仍会删除）' : 'false（创建补偿会被“回滚点之后又被修改”挡住）'}`)
                if (unusable > 0) {
                    lines.push(
                        `- 另有 ${unusable} 条记录不可回滚（没有可用快照${failed > 0 ? `，其中 ${failed} 条快照失败` : ''}），从未参与回滚。`,
                    )
                }
                if (untimed > 0) {
                    lines.push(
                        `- 另有 ${untimed} 条快照记录缺少轮次信息（本会话没有观测到 pre-step / inbox-claimed / turn-stopping）：按轮次回滚会漏掉它们，改用 since / sinceMinutes 可以纳入。`,
                    )
                }

                if (candidates.length === 0) {
                    const because =
                        untimed > 0
                            ? `本会话的 ${untimed} 条快照记录都没有轮次信息（未观测到 agent/pre-step），无法按轮次回滚。如需按轮次回滚：让会话发出 agent/pre-step 事件后重新执行写操作，或改用其他恢复手段（如 git）。`
                            : outOfRange > 0
                              ? `${scopeLabel} 之后没有写操作（范围外的 ${outOfRange} 条快照不参与回滚）。`
                              : unusable > 0
                                ? `本会话只有 ${unusable} 条无可用快照的记录（快照失败或被跳过）。`
                                : '本会话此前未开启快照（snapshot.enabled 或 writeTools 未覆盖这些写操作）。'
                    lines.push('')
                    lines.push(`没有可回滚项：${because}工作区未做任何改动。`)
                    return lines.join('\n')
                }

                if (!dryRun && args.confirm !== true) {
                    lines.push('')
                    lines.push(`检测到 ${candidates.length} 条可回滚记录，但 confirm 不是 true：**拒绝写盘**。`)
                    lines.push('确认无误后请以 dryRun=false 且 confirm=true 重新调用。工作区未做任何改动。')
                    return lines.join('\n')
                }

                const steps: RewindStep[] = []
                // Pre-flight: capture every target's state *before* the first
                // compensation, so the "changed since?" evidence is never the
                // result of an earlier replay step rewriting the same file.
                const states = new Map<string, FileState>()
                for (const { row } of candidates) {
                    const record = row.snapshot as SnapshotRecord
                    if (record.existed || states.has(record.path)) continue
                    states.set(record.path, captureFileState(record.path))
                }
                const rewindStartedAt = Date.now()
                for (const { row } of candidates) {
                    const record = row.snapshot as SnapshotRecord
                    const postDigest = postDigests.get(record.path)
                    const state = states.get(record.path)
                    steps.push(
                        applyRewind(record, {
                            cwd: target.cwd,
                            layout: target.layout,
                            dryRun,
                            force,
                            nowMs: rewindStartedAt,
                            ts: row.ts,
                            callId: row.callId,
                            tool: row.tool,
                            ...(row.turn === undefined ? {} : { turn: row.turn }),
                            ...(postDigest === undefined ? {} : { postDigest }),
                            ...(state === undefined ? {} : { state }),
                        }),
                    )
                }

                const done = steps.filter((step) => step.ok)
                const skipped = steps.filter((step) => !step.ok)
                const blocking = skipped.filter((step) => step.message.includes('需要 force 才删除'))
                const symlinked = skipped.filter((step) => step.message.includes('符号链接'))

                lines.push('')
                lines.push(
                    `${dryRun ? '将执行' : '已执行'} ${done.length} 项补偿${skipped.length > 0 ? `，跳过 ${skipped.length} 项` : ''}${unusable > 0 ? `（另有 ${unusable} 条记录不可回滚，已跳过）` : ''}：`,
                )
                for (const step of steps) {
                    const where = path.relative(target.cwd, step.path) || step.path
                    lines.push(
                        `- ${step.ok ? '✓' : '✗'} ${step.action === 'restore' ? '恢复' : '删除'} ${cell(where)}（turn ${step.turn ?? '-'}，${step.tool} ${step.callId}）：${step.message}`,
                    )
                }
                lines.push('')
                if (done.length === 0) {
                    const why =
                        symlinked.length > 0
                            ? `${symlinked.length} 项目标是符号链接（本插件拒绝写到链接目标）`
                            : blocking.length > 0
                              ? `${blocking.length} 项在回滚点之后又被修改（需要 force 才删除）`
                              : '每一项都被跳过'
                    lines.push(`没有可回滚项：${why}，工作区未做任何改动。`)
                } else {
                    lines.push(`结果：${done.length}/${steps.length} 项成功${skipped.length > 0 ? `，${skipped.length} 项被跳过` : ''}。`)
                }
                if (symlinked.length > 0) {
                    lines.push(`- 符号链接：${symlinked.length} 项被拒绝（${symlinked.map((step) => path.relative(target.cwd, step.path) || step.path).join(', ')}）。`)
                }
                if (blocking.length > 0) {
                    lines.push(
                        `- 被改动：${blocking.length} 项在回滚点之后又被修改，未删除以免破坏后来者的工作；确认要删除时以 force=true 重新调用。`,
                    )
                    lines.push(
                        '- 注意：跳过删除只保护“文件不被删掉”，同一文件若还有更新的快照被重放，其内容仍可能被那份快照覆盖（转储见上方每一步的消息）。',
                    )
                }
                if (force && blocking.length === 0) {
                    lines.push('- force=true 已生效：创建补偿不受“回滚点之后又被修改”的限制。')
                }
                lines.push('注意：这是**工作区文件回滚**，只依据本插件记录的写前快照；它不会修改 git 历史、不会执行 git 命令，也不会回滚快照未覆盖的改动（如 bash 命令产生的副作用）。')
                return lines.join('\n')
            },
        }),
        'audit_rewind',
    )

    return { disposers, registered, failed }
}

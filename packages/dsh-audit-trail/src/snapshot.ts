/**
 * The pre-write snapshot chain: capture → execute → compensate.
 *
 * Before a write-class tool touches a file, its **current bytes** are copied to
 * `<auditDir>/snapshots/<sessionId>/turn-<turn>/<n>-<digest>.snap`. The record
 * on the `pre` row is what `audit_rewind` replays later: `existed: true` means
 * "restore these bytes", `existed: false` means "this file was created, so the
 * compensation is a delete".
 *
 * The chain is best-effort by construction: a snapshot that cannot be taken is
 * *reported* (`reason`, plus `error` when the capture itself threw) and never
 * blocks the tool call. The four hard limits are enforced here, not in the
 * prompt:
 *  - only inside the session workspace (`isInside(sessionCwd(agent), target)`);
 *  - never inside the layout's own `rootDir` (the trail cannot shadow itself);
 *  - never larger than `snapshot.maxFileBytes`;
 *  - at most `snapshot.maxFilesPerTurn` captures per session+turn.
 *
 * Compensation is deliberately conservative: `applyRewind` never writes
 * *through* a symlink, never deletes a file that changed after the recorded
 * turn unless the caller forces it, and restores the recorded file mode.
 *
 * @module dsh-audit-trail/snapshot
 */

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, expandHome, isInside, sha256, shortDigest, snapshotDir, type Layout } from 'dsh-eng-core'
import { shouldSnapshot, type AuditTrailConfig } from './config.js'
import { targetPathOf, type SnapshotRecord } from './journal.js'

/** Everything one capture needs (all values already resolved by the caller). */
export interface CaptureContext {
    config: AuditTrailConfig
    layout: Layout
    /** Session workspace root (`sessionCwd(agent)`). */
    cwd: string
    sessionId: string
    /** Current turn, when known. */
    turn?: number
    /** 1-based ordinal inside this session+turn bucket (quota + file name). */
    ordinal: number
}

/** The snapshot directory of one session+turn bucket. */
export function bucketDir(layout: Layout, sessionId: string, turn: number | undefined): string {
    const turnKey = turn === undefined ? 'turn-unknown' : `turn-${turn}`
    return snapshotDir(layout, path.join(sessionId, turnKey))
}

/** Message of an arbitrary thrown value, without ever throwing itself. */
function errorText(error: unknown): string {
    try {
        return error instanceof Error ? error.message : String(error)
    } catch {
        return '[unprintable error]'
    }
}

/** Write bytes atomically (temp sibling + rename), byte-exact. */
function writeBytesAtomic(file: string, bytes: Buffer): void {
    ensureDir(path.dirname(file))
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporary, bytes)
    try {
        fs.renameSync(temporary, file)
    } catch (error) {
        try {
            fs.rmSync(temporary, { force: true })
        } catch {
            // A leftover temp sibling is harmless next to a failed restore.
        }
        throw error
    }
}

/**
 * Capture the pre-write state of one tool call's target file.
 * @param tool - tool name.
 * @param args - parsed arguments (untrusted).
 * @param context - resolved config, layout and identity of the call.
 * @returns the snapshot record, or `undefined` when the call is not a
 *   file-targeting write (nothing to record). Never throws: a capture that
 *   fails inside the plugin returns `reason: 'error'` instead.
 */
export function captureSnapshot(tool: string, args: unknown, context: CaptureContext): SnapshotRecord | undefined {
    /** Absolute path when it was resolved before the failure, for an honest report. */
    let resolved: string | undefined
    try {
        if (!shouldSnapshot(context.config, tool)) return undefined
        const target = targetPathOf(args)
        if (target === undefined) return undefined

        const cwd = path.resolve(context.cwd)
        resolved = path.resolve(cwd, expandHome(target))
        const relative = path.relative(cwd, resolved)
        const base = { path: resolved, relPath: relative === '' ? '.' : relative, bytes: 0 }

        // 1. Only inside the session workspace.
        if (!isInside(cwd, resolved)) {
            return { ...base, snapshotPath: '', existed: false, digest: '', reason: 'outside-workspace' }
        }
        // 2. Never inside the trail itself.
        if (isInside(context.layout.rootDir, resolved)) {
            return { ...base, snapshotPath: '', existed: false, digest: '', reason: 'internal' }
        }

        let stat: fs.Stats | undefined
        try {
            stat = fs.statSync(resolved)
        } catch {
            stat = undefined
        }
        if (stat !== undefined && !stat.isFile()) {
            return { ...base, snapshotPath: '', existed: stat.isDirectory(), digest: '', reason: 'not-a-file' }
        }
        // 3. Size limit.
        if (stat !== undefined && stat.size > context.config.snapshot.maxFileBytes) {
            return { ...base, snapshotPath: '', existed: true, digest: '', bytes: stat.size, reason: 'oversize' }
        }
        // 4. Per-turn quota.
        if (context.ordinal > context.config.snapshot.maxFilesPerTurn) {
            return { ...base, snapshotPath: '', existed: stat !== undefined, digest: '', bytes: stat?.size ?? 0, reason: 'quota' }
        }

        const name = `${context.ordinal}-${shortDigest(resolved, 12)}.snap`
        const file = path.join(bucketDir(context.layout, context.sessionId, context.turn), name)

        // A creation: no bytes to save, but the compensation (delete) is recorded.
        if (stat === undefined) {
            return { path: resolved, relPath: base.relPath, snapshotPath: '', existed: false, digest: '', bytes: 0 }
        }

        const mode = stat.mode & 0o7777
        const bytes = fs.readFileSync(resolved)
        writeBytesAtomic(file, bytes)
        return {
            path: resolved,
            relPath: base.relPath,
            snapshotPath: file,
            existed: true,
            digest: sha256(bytes),
            bytes: bytes.byteLength,
            mode,
        }
    } catch (error) {
        // A snapshot must never break a tool call — but it must be *visible*:
        // the row records why no pre-state exists, so rewind can say
        // "快照失败（不可回滚）" instead of blaming the path argument.
        const cwd = path.resolve(context.cwd)
        const where = resolved ?? cwd
        const relative = path.relative(cwd, where)
        return {
            path: where,
            relPath: relative === '' ? '.' : relative,
            snapshotPath: '',
            existed: false,
            digest: '',
            bytes: 0,
            reason: 'error',
            error: errorText(error),
        }
    }
}

/** What `audit_rewind` did (or would do) to one path. */
export interface RewindStep {
    action: 'restore' | 'delete'
    /** Absolute path the action targets. */
    path: string
    /** Turn of the write that produced the snapshot. */
    turn?: number
    /** Timestamp / call identity of the write, for the report. */
    ts: string
    callId: string
    tool: string
    ok: boolean
    /** Chinese description of the outcome. */
    message: string
}

/** Caller-supplied rewind policy (all optional; the defaults are the safe ones). */
export interface RewindOptions {
    cwd: string
    layout: Layout
    dryRun: boolean
    /** Timestamp of the journal row of this write (the rollback point). */
    ts: string
    /** Wall-clock time of this rewind run, read before any compensation ran. */
    nowMs: number
    callId: string
    tool: string
    turn?: number
    /**
     * The path's state captured **before** the first compensation of this run.
     * `undefined` means absent then, so a file that appeared during the replay
     * is treated as "not there to protect" — never as a live stat.
     */
    state?: FileState
    /**
     * State of the target as the audit observed it *after* the recorded write,
     * when a later snapshot of the same path recorded one. Used only as
     * evidence that a `existed: false` deletion target was written again.
     */
    postDigest?: string
    /**
     * Allow deleting a file that changed after the recorded turn
     * (`audit_rewind` `force: true`). Never overrides the symlink refusal.
     */
    force?: boolean
}

/**
 * What rewind knows about a path **before** it starts replaying, so the
 * "changed since?" guard cannot be confused by an earlier compensation that
 * already rewrote the same file (compensations replay newest-first).
 */
export interface FileState {
    /** Modification time, `undefined` when the file is absent. */
    mtimeMs?: number
    /** SHA-256 of the current bytes, `undefined` when unreadable. */
    digest?: string
}

/** Capture the pre-replay state of one path (never throws). */
export function captureFileState(target: string): FileState {
    try {
        const stat = fs.statSync(target)
        const state: FileState = { mtimeMs: stat.mtimeMs }
        try {
            state.digest = sha256(fs.readFileSync(target))
        } catch {
            // Unreadable bytes: the mtime evidence still stands.
        }
        return state
    } catch {
        return {}
    }
}

/**
 * Whether a file changed after the recorded write, so deleting it would destroy work.
 *
 * The snapshot row is written at `tools/pre-execute` — BEFORE the write it
 * records — so a file's mtime is always a little later than the row's timestamp.
 * How much later is scheduling jitter, which is why the tolerance below is
 * measured rather than guessed; the digest of a later snapshot of the same path
 * is the second, clock-independent piece of evidence.
 */
function changedSince(
    target: string,
    ts: string,
    postDigest: string | undefined,
    nowMs: number,
    state: FileState | undefined,
): { changed: boolean; why: string } {
    const mtime = state?.mtimeMs
    if (mtime === undefined) {
        // Vanished since the journal row: nothing to lose, the delete is a no-op.
        return { changed: false, why: '' }
    }
    const digest = state?.digest
    const recorded = Date.parse(ts)
    // The snapshot row is written at `tools/pre-execute`, i.e. BEFORE the write
    // it records, so the file's mtime is always a little later than `ts`. How
    // much later is scheduling jitter, not evidence: measured over 200 runs the
    // gap is p50 ≈ 0.6 ms, p95 ≈ 1 ms, worst ≈ 4.6 ms — which is why the old
    // 5 ms tolerance failed intermittently under a loaded test run. 100 ms covers
    // the jitter with margin while a genuinely later write (typically seconds
    // away, and caught by a later snapshot's digest anyway) still trips the guard.
    const slack = Number.isFinite(nowMs - recorded) && nowMs - recorded < 1000 ? 100 : 0
    if (Number.isFinite(recorded) && Number.isFinite(mtime) && mtime > recorded + slack) {
        return { changed: true, why: `mtime ${new Date(mtime).toISOString()} 晚于记录时间 ${ts}` }
    }
    if (postDigest !== undefined && postDigest !== '' && digest !== undefined && digest !== postDigest) {
        return { changed: true, why: `内容 digest ${digest.slice(0, 12)} 与审计记录的写后状态 ${postDigest.slice(0, 12)} 不一致` }
    }
    return { changed: false, why: '' }
}

/**
 * Apply (or preview) one compensation.
 *
 * Safety contract (all refusals are reported, never silent):
 *  - a target that is now a **symlink** is refused outright — rewind never
 *    writes through a link and never replaces one;
 *  - a target that is not a regular file is refused;
 *  - `existed: false` means the recorded write created the file: it is unlinked
 *    unless its mtime is clearly later than the recorded turn (see the measured
 *    tolerance in `changedSince`) or a later snapshot of the same path recorded
 *    a different digest. Both comparisons use the state
 *    captured **before** the first compensation of the run, so replaying one
 *    file never hides a change in another. `force: true` overrides exactly
 *    this guard;
 *  - a restore also puts the recorded file mode back (`chmod`).
 * @param record - the snapshot record of one write call.
 * @param context - workspace root, layout, policy and the progress identity.
 * @returns the outcome of this single compensation. Never throws.
 */
export function applyRewind(record: SnapshotRecord, context: RewindOptions): RewindStep {
    const step: RewindStep = {
        action: record.existed ? 'restore' : 'delete',
        path: record.path,
        ...(context.turn === undefined ? {} : { turn: context.turn }),
        ts: context.ts,
        callId: context.callId,
        tool: context.tool,
        ok: false,
        message: '',
    }
    try {
        const cwd = path.resolve(context.cwd)
        if (!isInside(cwd, record.path)) {
            return { ...step, message: '拒绝：路径不在当前工作区内，未做任何改动。' }
        }
        if (isInside(context.layout.rootDir, record.path)) {
            return { ...step, message: '拒绝：路径位于审计工件目录内，未做任何改动。' }
        }

        // `lstat`, never `stat`: the *link itself* is what rewind would touch.
        let link: fs.Stats | undefined
        try {
            link = fs.lstatSync(record.path)
        } catch {
            link = undefined
        }
        if (link !== undefined && link.isSymbolicLink()) {
            return { ...step, message: `${record.path} 是符号链接，跳过（避免写到链接目标）。` }
        }
        if (link !== undefined && !link.isFile()) {
            return { ...step, message: `拒绝：${record.path} 不是普通文件，未做任何改动。` }
        }

        if (record.existed) {
            const modeNote =
                record.mode === undefined
                    ? '（快照未记录文件模式，按默认权限恢复）'
                    : ''
            if (context.dryRun) {
                return {
                    ...step,
                    ok: true,
                    message: `将恢复为快照内容（${record.bytes} 字节，digest ${record.digest.slice(0, 12)}${record.mode === undefined ? '' : `，权限 ${record.mode.toString(8)}`}）。`,
                }
            }
            if (record.snapshotPath === '') return { ...step, message: '快照文件路径为空，跳过。' }
            if (!fs.existsSync(record.snapshotPath)) return { ...step, message: `快照文件缺失：${record.snapshotPath}` }
            const bytes = fs.readFileSync(record.snapshotPath)
            writeBytesAtomic(record.path, bytes)
            if (record.mode !== undefined) fs.chmodSync(record.path, record.mode)
            return {
                ...step,
                ok: true,
                message: `已恢复为 ${record.bytes} 字节（digest ${record.digest.slice(0, 12)}${record.mode === undefined ? '' : `，权限 ${record.mode.toString(8)}`}）。${modeNote}`,
            }
        }

        if (context.dryRun) {
            const guard = changedSince(record.path, context.ts, context.postDigest, context.nowMs, context.state)
            return {
                ...step,
                ok: !guard.changed,
                message: guard.changed
                    ? `将跳过删除：${record.path} 在回滚点之后又被修改，跳过删除（需要 force 才删除）——${guard.why}。`
                    : '将删除该文件（补偿此前的创建操作）。',
            }
        }
        if (link === undefined) return { ...step, ok: true, message: '文件已不存在，无需删除。' }

        const guard = changedSince(record.path, context.ts, context.postDigest, context.nowMs, context.state)
        if (guard.changed && context.force !== true) {
            return {
                ...step,
                message: `${record.path} 在回滚点之后又被修改，跳过删除（需要 force 才删除）——${guard.why}。`,
            }
        }
        fs.unlinkSync(record.path)
        return {
            ...step,
            ok: true,
            message: guard.changed
                ? '已删除该文件（force：尽管它在回滚点之后又被修改）。'
                : '已删除该文件（补偿此前的创建操作）。',
        }
    } catch (error) {
        return { ...step, message: `操作失败：${errorText(error)}` }
    }
}

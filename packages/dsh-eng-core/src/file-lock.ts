/**
 * A cross-process directory lock: `mkdir` as the mutex (docs §5.33).
 *
 * Two writers reach the delegation ledger (role-guard's `team_delegate` path and
 * its autonomous `bind()`), and a read-then-append only means "one row" if the
 * read and the append cannot interleave. `mkdir` is the smallest primitive that
 * gives that: it either creates the directory or fails with `EEXIST`, atomically,
 * on every filesystem the suite runs on. A lock *file* would need `O_EXCL` plus a
 * separate write, and the two can disagree; one directory cannot.
 *
 * The protocol, in three rules:
 * 1. **hold** — create `<target>.lock`, do the critical section, remove it in a
 *    `finally`. An exception must not leave the lock behind, or every later
 *    writer pays the full wait budget for nothing;
 * 2. **wait** — retry with backoff for a bounded time ({@link WAIT_BUDGET_MS}). A
 *    holder's critical section is one read plus one append, so waiting longer
 *    than that means the holder died, not that it is slow;
 * 3. **take over** — a lock directory whose mtime is older than
 *    {@link DIR_LOCK_STALE_MS} is abandoned by a dead holder: warn **first**, then
 *    remove it and retry. A lock that cannot be removed is never forced (no
 *    recursive delete) — the caller degrades instead of risking two writers.
 *
 * The module deliberately stops there: it reports a failure, it does not decide
 * what the failure MEANS. The writer of the artifact decides whether to fail or
 * to degrade (the delegation ledger appends anyway — a duplicate row is harmless
 * to every reader, a missing one is not).
 *
 * @module dsh-eng-core/file-lock
 */

import fs from 'node:fs'
import path from 'node:path'

/** A lock directory older than this (by mtime) is treated as abandoned. */
export const DIR_LOCK_STALE_MS = 10_000

/** Total time a caller spends trying to acquire before it degrades (ms). */
const WAIT_BUDGET_MS = 1_500

/** Hard cap on attempts, so a fast-failing filesystem cannot spin. */
const ATTEMPT_LIMIT = 40

/** First retry delay (ms); each retry multiplies it by 1.5 up to the ceiling. */
const RETRY_BASE_MS = 10

/** Retry delay ceiling (ms). */
const RETRY_MAX_MS = 100

/** The logger this module needs; a Cordis `logger` satisfies it structurally. */
export interface DirLockLogger {
    warn(message: string, error?: unknown): void
}

/** Whether the calling process now owns the lock directory. */
export interface DirLockAttempt {
    acquired: boolean
    /** Why not, phrased for the caller's warning (only when `acquired` is false). */
    reason?: string
}

/** One shared slot for {@link sleepSync}; allocated once, never used as data. */
const SLEEP = new Int32Array(new SharedArrayBuffer(4))

/** Block this thread for `ms`: the write paths that take a lock are synchronous. */
function sleepSync(ms: number): void {
    if (ms > 0) Atomics.wait(SLEEP, 0, 0, ms)
}

/** One-line reason out of an unknown thrown value. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Create the lock directory once: `acquired`, already `exists`, or why not.
 *
 * `mkdir` and "it already exists" are the same atomic operation, which is why
 * the lock is a directory and not a file.
 */
function createLockDir(lockDir: string): 'acquired' | 'exists' | { reason: string } {
    try {
        fs.mkdirSync(lockDir)
        return 'acquired'
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        return { reason: `无法创建锁目录 ${lockDir}：${messageOf(error)}` }
    }
}

/**
 * Take `lockDir` for the calling process, waiting up to {@link WAIT_BUDGET_MS}.
 *
 * Returning `acquired: false` is not an error: it says "another process is
 * holding it (or its stale directory could not be removed)" and the caller
 * decides what to do. Nothing is deleted that this call did not create.
 * @param lockDir - absolute path of the lock directory (e.g. `<ledger>.lock`).
 * @param logger - optional logger, always a warning (never a thrown error).
 * @returns whether the lock was acquired, and why not when it was not.
 */
export function acquireDirLock(lockDir: string, logger?: DirLockLogger): DirLockAttempt {
    // The lock must live next to the artifact it guards, whose directory the
    // caller may not have created yet (a first append).
    try {
        fs.mkdirSync(path.dirname(lockDir), { recursive: true })
    } catch {
        // Reported by the mkdir below: the lock cannot be taken either way.
    }
    const deadline = Date.now() + WAIT_BUDGET_MS
    let delay = RETRY_BASE_MS
    let takeoverRefused = false
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
        const outcome = createLockDir(lockDir)
        if (outcome === 'acquired') return { acquired: true }
        if (outcome !== 'exists') return { acquired: false, reason: outcome.reason }
        // `exists`: someone holds it. A stale one means that holder is gone.
        if (!takeoverRefused) {
            const takeover = takeOverStaleLock(lockDir, logger)
            if (takeover === 'removed') continue
            if (takeover === 'refused') takeoverRefused = true
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        sleepSync(Math.min(delay, remaining))
        delay = Math.min(Math.round(delay * 1.5), RETRY_MAX_MS)
    }
    const refused = takeoverRefused ? '；过期锁无法删除，已放弃接管' : ''
    return {
        acquired: false,
        reason: `等待锁目录 ${lockDir} 超时（${WAIT_BUDGET_MS}ms / ${ATTEMPT_LIMIT} 次重试${refused}）`,
    }
}

/**
 * Remove a lock directory that looks abandoned; `removed` means "retry now".
 *
 * The warning comes FIRST: a lock that vanished without a line of explanation is
 * a mystery the next operator has to debug. `refused` (it exists, is stale, and
 * still cannot be removed) makes the caller stop trying — retrying a removal that
 * keeps failing only floods the log while the director stays there.
 */
function takeOverStaleLock(lockDir: string, logger?: DirLockLogger): 'removed' | 'refused' | 'fresh' {
    let ageMs: number
    try {
        ageMs = Date.now() - fs.statSync(lockDir).mtimeMs
    } catch {
        // Already gone (a holder released it between mkdir and stat): retry.
        return 'fresh'
    }
    if (ageMs < DIR_LOCK_STALE_MS) return 'fresh'
    logger?.warn(`锁目录 ${lockDir} 已存在 ${Math.round(ageMs)}ms（超过 ${DIR_LOCK_STALE_MS}ms 阈值），按过期锁尝试接管。`)
    try {
        fs.rmdirSync(lockDir)
        return 'removed'
    } catch (error) {
        // Never force: deleting recursively could remove a live holder's lock.
        logger?.warn(`锁目录 ${lockDir} 无法接管（保留原样，继续等待）：${messageOf(error)}`, error)
        return 'refused'
    }
}

/**
 * Remove the lock this process created; a failure is a warning, never a throw.
 *
 * The caller already did its write by the time this runs (`finally`), so throwing
 * here would report a failed append that actually succeeded. A leftover lock is
 * recoverable by the stale-takeover rule — it costs the next writer time, not
 * correctness.
 * @param lockDir - the lock directory this process owns.
 * @param logger - optional logger for the leftover-lock warning.
 */
export function releaseDirLock(lockDir: string, logger?: DirLockLogger): void {
    try {
        fs.rmdirSync(lockDir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        logger?.warn(`释放锁目录 ${lockDir} 失败（后续写入将按过期锁接管）：${messageOf(error)}`, error)
    }
}

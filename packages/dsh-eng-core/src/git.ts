/**
 * Git fingerprinting for evidence binding (docs.md §3.5: "Git diff 的摘要指纹").
 *
 * Everything here is best-effort and synchronous: a workspace that is not a
 * git repository, or a `git` binary that is missing, yields
 * `{ isRepo: false }` instead of an exception, because a failing gate must be
 * a verdict rather than a crash.
 *
 * @module dsh-eng-core/git
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './digest.js'
import type { GitFingerprint } from './types.js'

interface GitResult {
    ok: boolean
    out: string
}

function git(cwd: string, args: readonly string[]): GitResult {
    try {
        const out = execFileSync('git', [...args], {
            cwd,
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 32 * 1024 * 1024,
        })
        return { ok: true, out }
    } catch {
        return { ok: false, out: '' }
    }
}

/**
 * Capture the workspace's git state.
 * @param cwd - workspace directory.
 * @param options - `excludePaths` are absolute or cwd-relative directories whose
 *   files never count as "changes" (the engineering trail itself: a mission's
 *   own artifacts must not consume the host's change budget).
 * @returns the fingerprint; `isRepo: false` when `git` cannot answer.
 */
export function gitFingerprint(cwd: string, options: { excludePaths?: readonly string[] } = {}): GitFingerprint {
    const inside = git(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.out.trim() !== 'true') {
        return { isRepo: false, dirty: false, changedFiles: 0, diffDigest: sha256('') }
    }
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const status = git(cwd, ['status', '--porcelain'])
    const diff = git(cwd, ['diff', 'HEAD'])
    const entries = status.ok ? status.out.split('\n').filter((line) => line.trim() !== '') : []
    const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
    // git reports realpath'd directories while a caller may hold a symlinked
    // one (/var vs /private/var on macOS), so both sides are normalised.
    const realRoot = safeRealpath(toplevel.ok ? toplevel.out.trim() : cwd)
    const realCwd = safeRealpath(cwd)
    const excludes = new Set<string>()
    for (const entry of options.excludePaths ?? []) {
        const target = path.resolve(realCwd, entry)
        for (const candidate of [target, safeRealpath(target)]) {
            const relative = path.relative(realRoot, candidate).replace(/\/+$/, '')
            if (relative !== '' && !relative.startsWith('..')) excludes.add(relative)
        }
    }
    const counted = entries.filter((line) => {
        const target = porcelainPath(line)
        if (target === undefined) return true
        return ![...excludes].some((exclude) => target === exclude || target.startsWith(`${exclude}/`))
    })
    return {
        isRepo: true,
        ...(head.ok ? { head: head.out.trim() } : {}),
        ...(branch.ok ? { branch: branch.out.trim() } : {}),
        dirty: entries.length > 0,
        changedFiles: counted.length,
        diffDigest: sha256(diff.ok ? diff.out : ''),
    }
}

/** `fs.realpathSync` that never throws (a path may not exist yet). */
function safeRealpath(target: string): string {
    try {
        return fs.realpathSync(target)
    } catch {
        return target
    }
}

/** The path a `git status --porcelain` line refers to (handles renames). */
function porcelainPath(line: string): string | undefined {
    const body = line.slice(3).trim()
    if (body === '') return undefined
    const arrow = body.lastIndexOf(' -> ')
    return arrow >= 0 ? body.slice(arrow + 4).trim() : body
}

/**
 * Human-readable one-line summary of a fingerprint for prompts and receipts.
 * @param fingerprint - the captured state.
 * @returns e.g. `main@1a2b3c4 +3 files (diff 8f2c1d…)`.
 */
export function describeFingerprint(fingerprint: GitFingerprint | undefined): string {
    if (fingerprint === undefined || !fingerprint.isRepo) return 'not a git repository'
    const head = fingerprint.head === undefined ? 'no-commit' : fingerprint.head.slice(0, 8)
    const branch = fingerprint.branch ?? 'detached'
    const dirty = fingerprint.dirty ? `+${fingerprint.changedFiles} changed` : 'clean'
    return `${branch}@${head} ${dirty} (diff ${fingerprint.diffDigest.slice(0, 8)})`
}

/**
 * Record the current state of the workspace files as a reviewable diff summary.
 * @param cwd - workspace directory.
 * @param maxBytes - cap for the captured text.
 * @returns `git diff --stat` output, or an explanatory line.
 */
export function gitDiffSummary(cwd: string, maxBytes = 4_000): string {
    const stat = git(cwd, ['diff', '--stat', 'HEAD'])
    if (!stat.ok) return '(git diff unavailable)'
    const text = stat.out.trim() === '' ? '(no changes against HEAD)' : stat.out.trim()
    return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}\n…[truncated]`
}

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

import { execFileSync, spawnSync } from 'node:child_process'
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

/**
 * The path a `git status --porcelain` line refers to (handles renames).
 *
 * Exported for the exclusion-aware fingerprinter, so both readers parse git's
 * porcelain format the same way instead of growing two subtly different ones.
 */
export function porcelainPath(line: string): string | undefined {
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

/**
 * One commit's merge state (AC-008: 证据的 commit 必须已被合并进主树).
 *
 * `git merge-base --is-ancestor <commit> <ref>` is the question "is that commit
 * part of this history", answered by git itself — never by a branch name the
 * caller typed. It is spawned with `-C <mainTree>` and an ABSOLUTE tree path so
 * the answer is about the tree named, not about the process cwd.
 *
 * A non-zero/unknown outcome is never "merged": exit code 1 means "not an
 * ancestor", anything else (128: bad object, missing repo) means "could not
 * check", and both keep the evidence out of the ledger.
 */
export interface AncestorCheck {
    /** `true` only when git exited 0 (the commit IS in the tree's history). */
    merged: boolean
    /** git's exit code, or `null` when git could not be started. */
    exitCode: number | null
    /** Why the check could not run (spawn failure only). */
    error?: string
}

/**
 * Whether `commit` is already part of `ref`'s history in `mainTree`.
 * @param mainTree - absolute path of the main work tree.
 * @param commit - the commit to look for (hex; validated by the caller).
 * @param ref - the ref to search from (default `HEAD`).
 */
export function isMergedInto(mainTree: string, commit: string, ref = 'HEAD'): AncestorCheck {
    const result = spawnSync('git', ['-C', mainTree, 'merge-base', '--is-ancestor', commit, ref], {
        encoding: 'utf8',
        timeout: 15_000,
    })
    if (result.error !== undefined) return { merged: false, exitCode: null, error: result.error.message }
    return { merged: result.status === 0, exitCode: result.status }
}

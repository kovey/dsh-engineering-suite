/**
 * Fingerprints with DECLARED exclusions, and the one field-set comparison.
 *
 * Why this module exists: a fingerprint is only comparable when both sides use
 * the same exclusions, and an exclusion that lives only in a writer's code is
 * not reproducible by any reader. The knowledge base hit exactly that: its
 * index directory (`.dsh/kb`) is excluded when the index is built, but
 * `dsh-eng-core`'s `gitFingerprint` had no way to apply that exclusion, so the
 * conformance freshness check could either compare with a DIFFERENT exclusion
 * set (a permanent false "stale", which teaches readers to ignore the warning)
 * or declare the question unanswerable forever.
 *
 * The mechanism therefore lives here, as an additive function: the artifact
 * records the exclusions it was built with, and every reader recomputes with
 * the recorded set. `gitFingerprint` itself is deliberately untouched — seven
 * other plugins have fingerprints recorded in their ledgers by that exact
 * function, and changing what it returns would rewrite history that is not
 * ours to rewrite.
 *
 * Two details are load-bearing:
 *
 *  - the exclusion is expressed to git as `:(top,exclude,literal)<path>` on the
 *    same command that produces the rest of the fingerprint (`status`, `diff`),
 *    so the count, the dirty flag and the digest all describe one set of files;
 *  - `-uall` is required. Without it git collapses an untracked directory into
 *    ONE `?? .dsh/` line, and the excluded artifact returns through its parent.
 *
 * @module dsh-eng-core/fingerprint
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { sha256 } from './digest.js'
import { gitFingerprint, porcelainPath } from './git.js'
import type { GitFingerprint } from './types.js'

/**
 * The algorithm token a fingerprint producer writes into its artifact when it
 * used {@link fingerprintWithExcludes}. A reader that sees this token may
 * recompute from the recorded `excludes`; any other token is unreadable.
 */
export const FINGERPRINT_ALGORITHM = 'git-status-v1'

/**
 * Repository-root-relative exclusions for a fingerprint.
 *
 * Paths are POSIX (`/`) and relative to the repository root, not to the
 * workspace directory — this is what makes them storable in an artifact and
 * usable by a reader whose cwd may be a subdirectory.
 */
export interface FingerprintExcludes {
    paths: readonly string[]
}

/** One git call; never throws (a missing binary is a verdict, not a crash). */
function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
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
 * Normalise declared exclusions to the form git can consume.
 *
 * An entry that cannot be named as a repository-relative path is DROPPED, i.e.
 * it excludes nothing. That is the fail-closed direction for a fingerprint: the
 * comparison then counts more files (possibly reporting stale), never fewer
 * (which would report fresh about files it never looked at). Readers that store
 * these paths in an artifact should refuse to recompute when their own input
 * contains such an entry rather than silently comparing with a smaller set.
 * @param paths - the declared exclusions.
 * @returns the usable paths, de-duplicated, in declaration order.
 */
export function usableFingerprintExcludes(paths: readonly string[]): string[] {
    const usable: string[] = []
    for (const raw of paths) {
        if (typeof raw !== 'string') continue
        if (raw.includes('\0')) continue
        const normalised = raw
            .replace(/^\.\/+/, '')
            .replace(/\/+$/, '')
        if (normalised === '' || normalised === '.') continue
        if (normalised.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalised)) continue
        if (normalised.split('/').includes('..')) continue
        if (!usable.includes(normalised)) usable.push(normalised)
    }
    return usable
}

/**
 * The git pathspecs that exclude exactly the usable declared paths.
 * @param paths - already-normalised repository-root-relative paths.
 */
function excludePathspecs(paths: readonly string[]): string[] {
    return paths.map((entry) => `:(top,exclude,literal)${entry}`)
}

/**
 * The declared exclusions as absolute paths, for the fallback fingerprint.
 *
 * `gitFingerprint` resolves its `excludePaths` against the workspace directory,
 * while the declaration is repository-root-relative; the repository root is what
 * bridges the two. When there is no usable root the fallback counts everything,
 * which is the safer direction.
 */
function absoluteExcludes(cwd: string, paths: readonly string[]): string[] {
    if (paths.length === 0) return []
    const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
    const root = toplevel.ok ? toplevel.out.trim() : ''
    if (root === '') return []
    return paths.map((entry) => path.join(root, entry))
}

/**
 * The workspace fingerprint computed with a DECLARED exclusion set.
 *
 * `head`/`branch`/`isRepo` come from `gitFingerprint` unchanged (an artifact's
 * fingerprint must stay comparable across builds and with the other plugins'
 * fingerprints); `changedFiles`, `dirty` and `diffDigest` are recomputed with
 * the exclusions applied by git itself.
 * @param cwd - workspace directory.
 * @param excludes - repository-root-relative POSIX paths to ignore.
 * @returns the fingerprint; `isRepo: false` when git cannot answer.
 */
export function fingerprintWithExcludes(cwd: string, excludes: FingerprintExcludes): GitFingerprint {
    const declared = usableFingerprintExcludes(excludes.paths)
    // The base supplies `head`/`branch`/`isRepo` and the degraded-status
    // fallback; passing the exclusions to it too keeps that fallback from
    // counting the artifact the exclusion exists for.
    const base = gitFingerprint(cwd, { excludePaths: absoluteExcludes(cwd, declared) })
    if (!base.isRepo) return base
    const pathspecs = excludePathspecs(declared)
    // `-uall` is load-bearing: without it an untracked directory is reported as
    // one `?? .dsh/` line, so excluding a file inside it excludes nothing.
    const status = git(cwd, ['status', '--porcelain', '-uall', '--', ...pathspecs])
    const diff = git(cwd, ['diff', 'HEAD', '--', ...pathspecs])
    const entries = status.ok ? status.out.split('\n').filter((line) => line.trim() !== '') : undefined
    return {
        ...base,
        ...(entries === undefined
            ? { dirty: base.changedFiles > 0 }
            : { dirty: entries.length > 0, changedFiles: entries.length }),
        ...(diff.ok ? { diffDigest: sha256(diff.out) } : {}),
    }
}

/**
 * The same exclusion set, applied to the list of changed paths.
 *
 * This is the readable half of the comparison: a stale verdict is only
 * actionable when it names what moved. It runs the exact same status command
 * (same exclusions, same `-uall`) as {@link fingerprintWithExcludes}, so the
 * names cannot describe a different file set than the fingerprint did.
 * @param cwd - workspace directory.
 * @param excludes - the same repository-root-relative paths the fingerprint used.
 * @returns the changed paths, in git's order; empty when not a repository or
 *   when git cannot answer.
 */
export function changedPathsWithExcludes(cwd: string, excludes: FingerprintExcludes): string[] {
    const pathspecs = excludePathspecs(usableFingerprintExcludes(excludes.paths))
    const status = git(cwd, ['status', '--porcelain', '-uall', '--', ...pathspecs])
    if (!status.ok) return []
    const paths: string[] = []
    for (const line of status.out.split('\n')) {
        if (line.trim() === '') continue
        const target = porcelainPath(line)
        if (target !== undefined) paths.push(target)
    }
    return paths
}

/**
 * Whether two fingerprints describe the same facts.
 *
 * This is the field set every freshness comparison uses — exactly these six
 * fields, no more and no less. Artifact metadata (an algorithm token, the
 * declared exclusions) is deliberately NOT part of it: two fingerprints that
 * differ only in how they were produced are not a workspace change. Keeping
 * the set in one function is what stops `kb_status`, `scripts/kb.mjs` and the
 * conformance view from drifting into three different answers.
 * @param a - one fingerprint (often the recorded one).
 * @param b - the other fingerprint (often the just-recomputed one).
 * @returns `true` when every compared field is equal.
 */
export function sameFingerprint(a: GitFingerprint, b: GitFingerprint): boolean {
    return (
        a.isRepo === b.isRepo &&
        a.head === b.head &&
        a.branch === b.branch &&
        a.dirty === b.dirty &&
        a.changedFiles === b.changedFiles &&
        a.diffDigest === b.diffDigest
    )
}

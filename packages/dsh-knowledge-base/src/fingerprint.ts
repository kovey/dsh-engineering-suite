/**
 * The git fingerprint the index is BUILT at and COMPARED against.
 *
 * Why this module exists (a real bug, found in a live repository): `kb_index`
 * wrote `.dsh/kb/`, and the very next `kb_search` reported the index as stale.
 * The artifact had changed the workspace's fingerprint between the build and
 * the comparison — a build product invalidating itself. The report even said
 * `工作区改动数从 0 变成 0`: the excluded files were not counted, but the
 * repository still counted as dirty, and `stalenessOf` compares both.
 *
 * The rule this module enforces, in one place, for both sides of the
 * comparison: **the effective index directory never appears in the
 * fingerprint.** Concretely, `.dsh/kb` is excluded from the status entries
 * (so a fresh, un-ignored artifact is not a change), from the diff digest (so
 * a repository that COMMITS its index — the README allows it — does not go
 * stale the moment `manifest.json`'s `builtAt` moves), and from the dirty flag
 * (which must mean what it says next to `changedFiles`).
 *
 * The exclusion is expressed ONCE, by git itself, as a pathspec
 * (`:(top,exclude,literal)<indexDir>`) rather than by filtering the output
 * here: git then decides what counts, including the case where an untracked
 * directory would otherwise be collapsed into a single `?? .dsh/` line that
 * carries the artifact back in through its parent.
 *
 * Why here and not in `dsh-eng-core`'s `gitFingerprint`: that function's
 * `excludePaths` option already filters `changedFiles`, but its `dirty` flag
 * still counts every status entry, and its diff digest has no pathspec at all.
 * Fixing that in `dsh-eng-core` would change the recorded fingerprint of seven
 * other plugins (quality/coverage/deploy/evidence/supply-chain/impact gates and
 * the release ledger), which is not an additive change. The suite's rule is
 * "narrow fixes stay narrow", so the knowledge base keeps its own fingerprint —
 * and exports it (see `index-store.ts`) so sibling surfaces such as
 * `scripts/kb.mjs` compare against the SAME function instead of raw
 * `gitFingerprint`, which is how the false "stale" reaches a human.
 *
 * @module dsh-knowledge-base/fingerprint
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gitFingerprint, sha256, type GitFingerprint } from 'dsh-eng-core'

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

/** `fs.realpathSync` that never throws (the index directory may not exist yet). */
function realpathOf(target: string): string {
    try {
        return fs.realpathSync(target)
    } catch {
        return target
    }
}

/**
 * The index directory as a repository-root-relative path, or `undefined` when it
 * cannot be named that way (the workspace is not inside a repository, or the
 * configured directory lies outside it).
 *
 * Both the literal and the realpath'd candidate are tried, mirroring the
 * normalisation `gitFingerprint` applies to its own `excludePaths`: git reports
 * realpath'd directories while a caller may hold a symlinked one (`/var` vs
 * `/private/var` on macOS).
 * @param cwd - workspace directory.
 * @param indexDir - absolute (or cwd-relative) index directory.
 * @returns the root-relative path, or `undefined`.
 */
export function indexSpecPath(cwd: string, indexDir: string): string | undefined {
    const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
    if (!toplevel.ok) return undefined
    const root = realpathOf(toplevel.out.trim())
    if (root === '') return undefined
    for (const candidate of [indexDir, realpathOf(indexDir)]) {
        const relative = path.relative(root, path.resolve(cwd, candidate)).replace(/\/+$/, '')
        // '' means the index directory IS the repository: excluding it would
        // exclude everything, which is not an exclusion but a blindfold.
        if (relative === '') return undefined
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue
        return relative
    }
    return undefined
}

/**
 * The workspace fingerprint used by `kb_index`, `kb_search` and `kb_status`.
 *
 * `head`/`branch`/`isRepo` come from `gitFingerprint` unchanged (a stored
 * manifest must stay comparable across builds and with the other plugins'
 * fingerprints); `changedFiles`, `dirty` and `diffDigest` are recomputed with
 * the index directory excluded.
 * @param cwd - workspace directory.
 * @param indexDir - the effective index directory (`indexDirOf(cwd, config)`).
 * @returns the fingerprint; `isRepo: false` when git cannot answer.
 */
export function indexFingerprint(cwd: string, indexDir: string): GitFingerprint {
    // The exclusion, in case the repository has other callers of it: a file
    // inside `.dsh/kb/` is never a workspace change, whatever this module's own
    // status call below reports.
    const base = gitFingerprint(cwd, { excludePaths: [indexDir] })
    if (!base.isRepo) return base
    const relative = indexSpecPath(cwd, indexDir)
    if (relative === undefined) return { ...base, dirty: base.changedFiles > 0 }
    const pathspec = `:(top,exclude,literal)${relative}`
    // `-uall` is load-bearing. Without it git collapses an untracked directory
    // into ONE `?? .dsh/` line, and a repository whose trail is untracked would
    // put the artifact back into the count through its parent directory.
    const status = git(cwd, ['status', '--porcelain', '-uall', '--', pathspec])
    const diff = git(cwd, ['diff', 'HEAD', '--', pathspec])
    const entries = status.ok ? status.out.split('\n').filter((line) => line.trim() !== '') : undefined
    return {
        ...base,
        ...(entries === undefined ? { dirty: base.changedFiles > 0 } : { dirty: entries.length > 0, changedFiles: entries.length }),
        ...(diff.ok ? { diffDigest: sha256(diff.out) } : {}),
    }
}

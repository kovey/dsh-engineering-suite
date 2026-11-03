/**
 * The knowledge-base fingerprint: the index directory as a declared exclusion.
 *
 * The mechanism itself lives in `dsh-eng-core` (`fingerprintWithExcludes`), so a
 * READER can reproduce it from the artifact instead of reimplementing this
 * module's rules. This file keeps only what is specific to the knowledge base:
 *
 *  - the effective index directory, named as a repository-root-relative path
 *    (`indexSpecPath`), including the symlink/realpath normalisation git
 *    requires (`/var` vs `/private/var` on macOS);
 *  - the two pieces of metadata the manifest stores NEXT TO the fingerprint
 *    (`algorithm`, `excludes`) so a later comparison does not have to guess;
 *  - the public `indexFingerprint`, kept as a thin wrapper so every existing
 *    surface (`kb_index`, `kb_search`, `kb_status`, `/kb`, `scripts/kb.mjs`)
 *    imports the same function it always did.
 *
 * Why the manifest must carry the exclusions: `dsh-eng-core` cannot import this
 * package (that would be a dependency cycle), and a reader comparing with its
 * own idea of what to exclude would either produce a permanent false "stale"
 * (excluding too little) or hide real changes (excluding too much). The artifact
 * declaring its own rule is the only shape both sides can honour.
 *
 * @module dsh-knowledge-base/fingerprint
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { FINGERPRINT_ALGORITHM, fingerprintWithExcludes, type GitFingerprint } from 'dsh-eng-core'

/**
 * A fingerprint as the knowledge-base manifest records it: the six compared
 * fields plus the metadata that makes the comparison reproducible.
 *
 * `algorithm`/`excludes` are OPTIONAL on read on purpose: manifests written
 * before they existed must still load here (this package knows its own index
 * directory, so its own freshness comparison keeps working), while the
 * cross-package freshness view — which does not — reports them as unknown
 * instead of guessing.
 */
export interface KbFingerprint extends GitFingerprint {
    /** `git-status-v1`; absent in manifests written by older versions. */
    algorithm?: string
    /** Repository-root-relative POSIX paths excluded when computing the fields. */
    excludes?: string[]
}

/** The algorithm token this package now writes into every manifest. */
export const KB_FINGERPRINT_ALGORITHM = FINGERPRINT_ALGORITHM

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
 * Canonicalise a path even when its leaf does not exist yet.
 *
 * `fs.realpathSync` fails on a missing leaf, which is exactly the first build:
 * git reports realpath'd directories (`/private/var/…` on macOS) while the
 * configured index directory is still `/var/…/.dsh/kb`. Failing to canonicalise
 * it would make `indexSpecPath` return `undefined` on the first build and a real
 * path on the second — the manifest would then declare a DIFFERENT exclusion set
 * on every other build, which is the permanent-false-stale trap this whole
 * mechanism exists to remove. The deepest existing ancestor is canonicalised and
 * the missing tail is appended verbatim.
 */
function canonicalPath(target: string): string {
    let current = path.resolve(target)
    const tail: string[] = []
    for (;;) {
        try {
            const real = fs.realpathSync(current)
            return tail.length === 0 ? real : path.join(real, ...[...tail].reverse())
        } catch {
            const parent = path.dirname(current)
            if (parent === current) return path.resolve(target)
            tail.push(path.basename(current))
            current = parent
        }
    }
}

/**
 * The index directory as a repository-root-relative POSIX path, or `undefined`
 * when it cannot be named that way (the workspace is not inside a repository, or
 * the configured directory lies outside it).
 *
 * Both the literal and the canonical candidate are tried, mirroring git's own
 * normalisation: git reports realpath'd directories while a caller may hold a
 * symlinked one.
 * @param cwd - workspace directory.
 * @param indexDir - absolute (or cwd-relative) index directory.
 * @returns the root-relative path, or `undefined`.
 */
export function indexSpecPath(cwd: string, indexDir: string): string | undefined {
    const toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
    if (!toplevel.ok) return undefined
    const root = realpathOf(toplevel.out.trim())
    if (root === '') return undefined
    for (const candidate of [indexDir, canonicalPath(indexDir)]) {
        const relative = path
            .relative(root, path.resolve(cwd, candidate))
            .split(path.sep)
            .join('/')
            .replace(/\/+$/, '')
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
 * Thin wrapper over the core mechanism: the effective index directory becomes
 * the ONE declared exclusion, and the result records that fact so a reader can
 * recompute it without this package's code.
 * @param cwd - workspace directory.
 * @param indexDir - the effective index directory (`indexDirOf(cwd, config)`).
 * @returns the fingerprint plus its `algorithm`/`excludes` declaration.
 */
export function indexFingerprint(cwd: string, indexDir: string): KbFingerprint {
    const relative = indexSpecPath(cwd, indexDir)
    const excludes = relative === undefined ? [] : [relative]
    return {
        ...fingerprintWithExcludes(cwd, { paths: excludes }),
        algorithm: FINGERPRINT_ALGORITHM,
        excludes,
    }
}

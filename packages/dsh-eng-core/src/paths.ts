/**
 * Path resolution for the engineering workspace layout.
 *
 * Every artifact the suite writes lives under one root (default `.dsh`) inside
 * the session workspace, so the whole engineering trail is versionable and
 * reviewable in the repository it belongs to:
 *
 * ```
 * .dsh/
 *   specs/<mission-id>.md          # the specification artifact (docs.md §3.2)
 *   missions/<mission-id>/
 *     mission.json                 # versioned mission state (the shared contract)
 *     evidence.jsonl               # append-only evidence ledger
 *     gates/<gate-id>.json         # recorded gate runs
 *     receipts/<receipt-id>.json   # immutable delivery receipts
 *     stages/<stage-id>.json       # orchestrator stage results
 *     artifacts/…                  # anything a stage wants to keep
 *   audit/<session-id>.jsonl       # tool-call audit trail (docs.md §3.6)
 *   audit/snapshots/…              # pre-write snapshots for rewindTo
 *   state/sessions/<session>.json  # session → mission binding
 *   roles/<role>.md                # role definitions (docs.md §3.1)
 * ```
 *
 * @module dsh-eng-core/paths
 */

import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` into the home directory (no other expansion). */
export function expandHome(input: string): string {
    if (input === '~') return os.homedir()
    if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
    return input
}

/** Expand a leading `~` and resolve relative paths against `base`. */
export function resolvePath(input: string, base: string): string {
    return path.resolve(base, expandHome(input))
}

/** Layout overrides accepted by every plugin config. */
export interface LayoutOptions {
    /** Root directory of the engineering trail (default `.dsh`). */
    rootDir?: string
    /** Specification artifacts (default `<root>/specs`). */
    specsDir?: string
    /** Mission state directories (default `<root>/missions`). */
    missionsDir?: string
    /** Audit trail (default `<root>/audit`). */
    auditDir?: string
    /** Session state (default `<root>/state`). */
    stateDir?: string
    /** Role definitions (default `<root>/roles`). */
    rolesDir?: string
}

/** Absolute directory layout for one workspace. */
export interface Layout {
    /** Workspace root the layout was resolved against. */
    cwd: string
    rootDir: string
    specsDir: string
    missionsDir: string
    auditDir: string
    stateDir: string
    rolesDir: string
}

/**
 * Resolve the absolute layout for one workspace root.
 * @param cwd - workspace directory (a session's `header.cwd`).
 * @param options - per-plugin overrides; `~` is expanded.
 * @returns absolute paths for every artifact directory.
 */
export function resolveLayout(cwd: string, options: LayoutOptions = {}): Layout {
    const rootDir = resolvePath(options.rootDir ?? '.dsh', cwd)
    return {
        cwd,
        rootDir,
        specsDir: resolvePath(options.specsDir ?? path.join(rootDir, 'specs'), cwd),
        missionsDir: resolvePath(options.missionsDir ?? path.join(rootDir, 'missions'), cwd),
        auditDir: resolvePath(options.auditDir ?? path.join(rootDir, 'audit'), cwd),
        stateDir: resolvePath(options.stateDir ?? path.join(rootDir, 'state'), cwd),
        rolesDir: resolvePath(options.rolesDir ?? path.join(rootDir, 'roles'), cwd),
    }
}

/**
 * Whether an id is safe to use as a single path segment.
 *
 * Ids reach the store from the model (`missionId` arguments) and from the
 * harness (session ids), so they are validated before they are ever joined
 * into a path: an id such as `../../etc/passwd` would otherwise let a tool
 * read or write outside the workspace.
 */
export function isSafeId(id: string): boolean {
    return (
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= 200 &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..' &&
        !id.startsWith('.') &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f]/.test(id)
    )
}

/**
 * Assert that an id is a safe single path segment.
 * @param id - the id to check.
 * @param what - label used in the error message.
 * @returns the id, for chaining.
 * @throws when the id could escape its directory (fail closed, never sanitise
 *   silently: a sanitised id would address a different artifact than asked).
 */
export function assertSafeId(id: string, what = 'id'): string {
    if (!isSafeId(id)) {
        throw new Error(`unsafe ${what}: ${JSON.stringify(String(id))} — ids must be a single path segment (no "/", no "..", no leading dot)`)
    }
    return id
}

/** Directory holding one mission's artifacts. */
export function missionDir(layout: Layout, missionId: string): string {
    return path.join(layout.missionsDir, assertSafeId(missionId, 'mission id'))
}

/** The specification artifact of one mission (docs.md §3.2 path). */
export function specFile(layout: Layout, missionId: string): string {
    return path.join(layout.specsDir, `${assertSafeId(missionId, 'mission id')}.md`)
}

/** Session → mission binding file. */
export function sessionStateFile(layout: Layout, sessionId: string): string {
    return path.join(layout.stateDir, 'sessions', `${assertSafeId(sessionId, 'session id')}.json`)
}

/** Audit JSONL file for one session. */
export function auditFile(layout: Layout, sessionId: string): string {
    return path.join(layout.auditDir, `${assertSafeId(sessionId, 'session id')}.jsonl`)
}

/** Snapshot root used by `audit_rewind`. */
export function snapshotDir(layout: Layout, turnKey: string): string {
    return path.join(layout.auditDir, 'snapshots', turnKey)
}

/** Whether `target` is inside `root` (or equal to it). */
export function isInside(root: string, target: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(target))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Normalise a path or pattern to POSIX form without a leading `./`. */
function toPosix(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Compile a path pattern to a regular expression.
 *
 * Supported syntax is the subset a specification boundary needs: `**` (any
 * depth), `*` (one path segment), `?` (one character). A pattern with no
 * wildcard is matched as an exact path *or* as a directory prefix by
 * {@link pathMatchesPattern} — `src` therefore covers `src/a/b.ts`, which is
 * what a human writing a boundary means.
 * @param pattern - the boundary pattern.
 */
export function globToRegExp(pattern: string): RegExp {
    const source = toPosix(pattern)
    let out = ''
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index] ?? ''
        if (character === '*') {
            if (source[index + 1] === '*') {
                index += 1
                // `**/` also matches zero directories, so `src/**/*.ts` covers `src/a.ts`.
                if (source[index + 1] === '/') {
                    index += 1
                    out += '(?:.*/)?'
                } else {
                    out += '.*'
                }
            } else {
                out += '[^/]*'
            }
            continue
        }
        if (character === '?') {
            out += '[^/]'
            continue
        }
        out += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${out}$`)
}

/**
 * Whether one workspace-relative path satisfies one boundary pattern.
 * @param pattern - boundary pattern (`src/**`, `docs`, `README.md`, `*.json`).
 * @param relativePath - path relative to the workspace root.
 */
export function pathMatchesPattern(pattern: string, relativePath: string): boolean {
    const target = toPosix(relativePath)
    const source = toPosix(pattern)
    if (source === '' ) return false
    if (!/[*?]/.test(source)) {
        return target === source || target.startsWith(`${source}/`)
    }
    return globToRegExp(source).test(target)
}

/** Whether a path satisfies at least one pattern (empty pattern list denies). */
export function pathMatchesAny(patterns: readonly string[], relativePath: string): boolean {
    return patterns.some((pattern) => pathMatchesPattern(pattern, relativePath))
}

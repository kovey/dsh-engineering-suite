/**
 * The positive-list shell policy (`shellPolicy: 'allowlist'`).
 *
 * `targets` asks "what would this command write?" and lets an unattributable
 * command run (the documented blind spot). The allowlist mode asks the opposite
 * question: "is this program on the reviewed list?" — a command that is not
 * listed is refused whatever it might write, so a command shape the analyser
 * does not model cannot become a way through.
 *
 * Matching is per segment (split exactly like the analyser: `|`, `||`, `&&`,
 * `;`, newline) and per first program: the entry's first token is compared with
 * the argv[0] BASENAME, extra entry tokens are matched against the following
 * argv positions (the last one may be a glob or a trailing-slash prefix, so
 * `bash scripts/*.sh` and `git status` both work). Execution is then judged by
 * the ordinary target/boundary checks, which still run.
 *
 * @module dsh-spec-gate/shell-allowlist
 */

import type { ShellPolicy } from './config-values.js'
import { shellAllowlistReason } from './guard-messages.js'
import { escapeRegExp, stripHeredocs, tokenize, withoutQuotedSpans } from './shell-lex.js'

/**
 * The conservative default: read-only inspection plus the repository's own
 * reviewed script entry point. `find` and `node --test` can write (a build
 * output, `-delete`), which is why they are listed here and why widening the
 * list stays a host/项目 decision with the risk documented.
 */
export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = [
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'rg',
    'grep',
    'find',
    'git status',
    'git diff',
    'git log',
    'git show',
    'node --test',
    'tsc',
    'bash scripts/*.sh',
]

/** Why one segment of a command could not be verified. */
export interface AllowlistDenial {
    /** The segment that failed (trimmed). */
    segment: string
    /** The first program's basename, or a marker when the segment hides one. */
    program: string
    /** Set when the segment contains a substitution the token pass cannot see. */
    hidden?: string
    /** The closest configured entry (shared prefix), for the denial text. */
    closest?: string
}

/** The verdict for one command line. */
export type AllowlistVerdict = { allowed: true } | { allowed: false; denial: AllowlistDenial }

/** Segment separators; kept identical to the analyser's split. */
const SEPARATORS = /\|\||&&|\||;|\n/

/**
 * A command substitution or process substitution runs a command the token walk
 * never sees. The allowlist refuses those instead of pretending the visible
 * argv is the whole story.
 */
const HIDDEN_COMMAND = /`|[<>]\(|\$\(/

/** Marker used as `program` when a segment hides its command. */
const UNVERIFIABLE = '(无法静态确认)'

/** The two configuration facts this mode needs (no `config.ts` import: no cycle). */
export interface AllowlistPolicy {
    shellPolicy: ShellPolicy
    shellAllowlist: readonly string[]
}

/**
 * Judge one shell command against the list.
 * @param command - the raw command string.
 * @param entries - configured entries (host defaults plus project additions).
 * @returns `allowed`, or the first refusing segment with its context.
 */
export function checkShellAllowlist(command: string, entries: readonly string[]): AllowlistVerdict {
    for (const raw of stripHeredocs(command).split(SEPARATORS)) {
        const denial = judgeSegment(raw.trim(), entries)
        if (denial !== undefined) return { allowed: false, denial }
    }
    return { allowed: true }
}

/** The denial for one segment, or `undefined` when an entry covers it. */
function judgeSegment(segment: string, entries: readonly string[]): AllowlistDenial | undefined {
    if (segment === '') return undefined
    const hidden = HIDDEN_COMMAND.exec(withoutQuotedSpans(segment))
    if (hidden !== null) return { segment, program: UNVERIFIABLE, hidden: hidden[0] }
    const tokens = tokenize(segment)
    const head = tokens[0]
    if (head === undefined || head === '') return undefined
    if (entries.some((entry) => matchesEntry(tokens, entry))) return undefined
    const program = head.split('/').pop() ?? head
    const closest = closestEntry(labelOf(tokens), entries)
    return closest === undefined ? { segment, program } : { segment, program, closest }
}

/**
 * The denial text for a command the allowlist does not cover, or `undefined`
 * when the policy is not `allowlist` (or there is no command to judge).
 * @param policy - effective `shellPolicy` plus the merged list.
 * @param command - the raw command string.
 * @param missionId - mission named in the denial text.
 */
export function shellAllowlistRefusal(
    policy: AllowlistPolicy,
    command: string | undefined,
    missionId: string,
): string | undefined {
    if (policy.shellPolicy !== 'allowlist' || command === undefined) return undefined
    const verdict = checkShellAllowlist(command, policy.shellAllowlist)
    return verdict.allowed ? undefined : shellAllowlistReason(missionId, verdict.denial)
}

/** Does one entry cover this argv? First token by basename, the rest by position. */
function matchesEntry(argv: readonly string[], entry: string): boolean {
    const want = entry.trim().split(/\s+/).filter((token) => token !== '')
    const first = want[0]
    const head = argv[0]
    if (first === undefined || head === undefined || !sameProgram(first, head)) return false
    for (let index = 1; index < want.length; index += 1) {
        const actual = argv[index]
        if (actual === undefined || !matchesArgument(want[index] ?? '', actual)) return false
    }
    return true
}

/** An entry's program token matches the basename, so `/bin/ls` and `ls` agree. */
function sameProgram(want: string, actual: string): boolean {
    return (want.split('/').pop() ?? want) === (actual.split('/').pop() ?? actual)
}

/** The command shape a suggestion compared against (`git apply`, `rsync`). */
function labelOf(tokens: readonly string[]): string {
    const head = tokens[0] ?? ''
    const next = tokens[1]
    if (next !== undefined && next !== '' && !next.startsWith('-')) return `${head} ${next}`
    return head
}

/**
 * One argument position: a trailing slash means "path prefix" (`bash scripts/`),
 * a `*` is a glob inside one segment and `**` crosses segments.
 */
function matchesArgument(want: string, actual: string): boolean {
    if (want.endsWith('/')) return actual.startsWith(want)
    if (!want.includes('*')) return want === actual
    return new RegExp(`^${globSource(want)}$`).test(actual)
}

function globSource(want: string): string {
    const parts: string[] = []
    for (const half of want.split('**')) {
        const pieces = half.split('*').map((piece) => escapeRegExp(piece))
        parts.push(pieces.join('[^/]*'))
    }
    return parts.join('.*')
}

/**
 * The configured entry sharing the longest prefix with the command, so the
 * denial can point at the near miss instead of a bare "no". A shared prefix of
 * one character (`rsync` vs `rg`) is not a suggestion: it would mislead.
 */
function closestEntry(label: string, entries: readonly string[]): string | undefined {
    let best: string | undefined
    let score = 0
    for (const entry of entries) {
        const shared = commonPrefix(label, entry)
        if (shared > score) {
            score = shared
            best = entry
        }
    }
    return score >= 2 ? best : undefined
}

function commonPrefix(left: string, right: string): number {
    const limit = Math.min(left.length, right.length)
    let index = 0
    while (index < limit && left[index] === right[index]) index += 1
    return index
}

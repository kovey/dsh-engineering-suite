/**
 * Where a TS/JS function's body is, and therefore how long the function is.
 *
 * A function's length has exactly one honest source: the `{ … }` pair that opens
 * and closes its body. Everything here exists to find THAT brace — not a brace
 * that belongs to a type, a literal or a neighbouring declaration — and to say
 * "cannot be determined" rather than guess when the pair is missing.
 *
 * Two shapes decide the strategy:
 *
 *  - a `function`/method declaration always has a braced body (when it has one),
 *    even when a return type sits between the parameter list and the brace;
 *  - an arrow may have an expression body (`=> expr`), which has no braces to
 *    pair and is bounded by the statement instead.
 *
 * @module dsh-eng-core/metrics-bodies
 */

import { lineOfOffset, skipSpace } from './metrics-text.js'
import type { Lexed, MeasuredFunction } from './metrics-text.js'
import { braceIndexAt, closerOf, statementEnded } from './metrics-braces.js'
import type { Braces } from './metrics-braces.js'

/**
 * What kind of thing an initializer is, which decides how its body is found.
 *
 * A `function`/method declaration ALWAYS has a braced body (when it has one at
 * all), so its body must be read as the paired `{ … }` — even when a return type
 * sits between the parameter list and the brace. An arrow may instead have an
 * expression body (`=> expr`), which has no braces to pair.
 */
export type FunctionForm = 'declaration' | 'arrow'

/** Where a function's span ends, or why it cannot be determined. */
export type BodySpan =
    /** A paired `{ … }` body; `opener` indexes {@link Braces.match}. */
    | { kind: 'braced'; opener: number }
    /** An arrow's expression body, starting at `from`. */
    | { kind: 'expression'; from: number }
    /** A body exists, but its braces (or brackets) do not pair: no honest length. */
    | { kind: 'unpairable' }
    /** Not a function after all (a bodyless signature, an overload, …). */
    | { kind: 'none' }

/** A recorded function, or the fact that it has no honest span. */
export type SpannedFunction = { kind: 'function'; metric: MeasuredFunction } | { kind: 'skipped' } | { kind: 'none' }

/** How far a declaration's return type may run before the file is treated as malformed. */
const DECLARATION_TYPE_MAX_CHARS = 2000

/** Tokens that can follow a type literal but can never follow a function body. */
const TYPE_CONTINUATION = new Set(['{', '|', '&', '[', '>', '.', '?', ':'])

/** The body of the function whose parameter list / `=>` ends before `from`. */
export function bodySpanOf(masked: string, from: number, braces: Braces, form: FunctionForm): BodySpan {
    return form === 'declaration' ? declarationBody(masked, from, braces) : arrowBody(masked, from, braces)
}

/**
 * Turn a {@link BodySpan} into a measured function.
 *
 * An `unpairable` body comes back as `skipped`, never as a length: a body without
 * a partner has no length, and the rest of the file is not it.
 */
export function spanToMetric(
    lexed: Lexed,
    braces: Braces,
    span: BodySpan,
    meta: { name: string; startLine: number; params: number },
): SpannedFunction {
    if (span.kind === 'none') return { kind: 'none' }
    if (span.kind === 'unpairable') return { kind: 'skipped' }
    if (span.kind === 'braced') {
        const closer = closerOf(braces, span.opener)
        if (closer < 0) return { kind: 'skipped' }
        const endLine = lineOfOffset(lexed, braces.offsets[closer] ?? 0)
        const depth = (braces.subtreeMax[span.opener] ?? 1) - (braces.depthBefore[span.opener] ?? 0)
        return {
            kind: 'function',
            metric: { ...meta, line: meta.startLine + 1, endLine: endLine + 1, lines: endLine - meta.startLine + 1, depth: Math.max(1, depth) },
        }
    }
    // An expression body (`=> expr`): its span is the line on which the
    // statement's bracket balance returns to zero — and it has to return. Running
    // out of file with brackets still open means the span is unknown; reporting
    // the rest of the file is exactly the fake number this module exists to stop.
    let balance = 0
    let cursor = span.from
    while (cursor < lexed.masked.length) {
        const char = lexed.masked[cursor] ?? ''
        if (char === '(' || char === '[' || char === '{') balance += 1
        else if (char === ')' || char === ']' || char === '}') {
            if (balance === 0) break
            balance -= 1
        } else if (balance === 0 && (char === ';' || char === '\n')) break
        cursor += 1
    }
    if (cursor >= lexed.masked.length && balance > 0) return { kind: 'skipped' }
    const endLine = Math.max(meta.startLine, lineOfOffset(lexed, cursor))
    let depth = 0
    for (let line = meta.startLine; line <= endLine; line += 1) {
        depth = Math.max(depth, (braces.maxDepthLine[line] ?? 0) - (braces.depthBeforeLine[meta.startLine] ?? 0))
    }
    return {
        kind: 'function',
        metric: { ...meta, line: meta.startLine + 1, endLine: endLine + 1, lines: endLine - meta.startLine + 1, depth: Math.max(1, depth) },
    }
}

/**
 * The body of a `function`/method declaration whose parameter list ends before `from`.
 *
 * A return type may sit between the parameter list and the body, and it may hold
 * braces of its own (`): { ok: boolean } {`) or an arrow (`): (x: T) => U {`).
 * Such a type's brace is skipped through its match instead of being mistaken for
 * the body — the difference matters, because the body is where the function's
 * length comes from.
 */
function declarationBody(masked: string, from: number, braces: Braces): BodySpan {
    const first = skipSpace(masked, from)
    if (first >= masked.length) return { kind: 'none' }
    if (masked[first] === '{') return bracedBody(masked, from, first, braces)
    if (masked[first] !== ':') return { kind: 'none' }
    let cursor = first + 1
    let depth = 0
    const limit = Math.min(masked.length, first + DECLARATION_TYPE_MAX_CHARS)
    while (cursor < limit) {
        const char = masked[cursor] ?? ''
        if (char === '(' || char === '[') {
            depth += 1
            cursor += 1
            continue
        }
        if (char === ')' || char === ']') {
            // A closer the return type never opened means the declaration ended
            // before any body: not a function, not a broken one either.
            if (depth === 0) return { kind: 'none' }
            depth -= 1
            cursor += 1
            continue
        }
        if (char === ';' && depth === 0) return { kind: 'none' }
        if (char === '{' && depth === 0) {
            const index = braceIndexAt(braces, cursor)
            if (index < 0 || (braces.offsets[index] ?? -1) !== cursor) return { kind: 'unpairable' }
            const closer = braces.match[index] ?? -1
            if (closer < 0) return { kind: 'unpairable' }
            // A type is never the last thing in a declaration: the body comes
            // after it. So a `{ … }` that is followed by more type syntax is the
            // type's own brace and is skipped; the first one that is not is the
            // body. Deciding by what FOLLOWS the closer (rather than by what
            // precedes the brace) is what keeps `value is { … }` and
            // `| 'recommended' {` — where the masked string literal hides the last
            // token of the type — from being read as bodies of 1 and 24 lines.
            if (!continuesType(masked, braces.offsets[closer] ?? cursor)) return bracedBody(masked, from, cursor, braces)
            cursor = (braces.offsets[closer] ?? cursor) + 1
            continue
        }
        cursor += 1
    }
    return { kind: 'none' }
}

/** The body of an arrow function whose `=>` ends right before `from`. */
function arrowBody(masked: string, from: number, braces: Braces): BodySpan {
    const body = skipSpace(masked, from)
    if (body >= masked.length) return { kind: 'none' }
    if (masked[body] !== '{') return { kind: 'expression', from: body }
    return bracedBody(masked, from, body, braces)
}

/**
 * The paired `{` at `at` as a body, or why it is not one.
 *
 * The brace is taken as-is: by the time a caller gets here the body brace is
 * already identified (a declaration's return type has been skipped, an arrow's
 * `=>` has been crossed), so "the brace right here" is the only honest answer.
 * `bodyOpener`'s signature heuristic — skip a brace whose match is followed by
 * `)` — must NOT be applied to an arrow body: `(() => { … })()` closes on `)` and
 * would send the search into the next brace in the file.
 */
function bracedBody(masked: string, from: number, at: number, braces: Braces): BodySpan {
    if (statementEnded(masked, from, at)) return { kind: 'none' }
    const opener = braceIndexAt(braces, at)
    if (opener < 0 || (braces.offsets[opener] ?? -1) !== at) return { kind: 'unpairable' }
    if (closerOf(braces, opener) < 0) return { kind: 'unpairable' }
    return { kind: 'braced', opener }
}

/**
 * Whether the token right after a `}` continues a type, which makes that brace a
 * type literal rather than a function body.
 *
 * Only tokens that cannot follow a finished body are listed: `,` `)` `]` `;` `}`
 * all can (`f(): T { … },` in an object literal closes the body there), so they
 * mean "body" — and `<` `(` are absent because a type literal is never followed
 * by them. `=>` is spelled out: it starts a function type whose return type may
 * itself be an object literal.
 */
function continuesType(masked: string, afterCloser: number): boolean {
    const next = skipSpace(masked, afterCloser + 1)
    const char = masked[next] ?? ''
    if (char === '=' && masked[next + 1] === '>') return true
    return TYPE_CONTINUATION.has(char)
}

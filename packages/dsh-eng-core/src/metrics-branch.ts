/**
 * `if`/`else` blocks of a brace-delimited language — the branch-size half of the
 * metrics.
 *
 * A branch's length is the number of lines the block it opens really spans, so
 * the only hard part is finding the `{` that belongs to THE header. The header is
 * parsed, never guessed: a brace-less one-liner (`if (!resolved.enabled) return`)
 * must not adopt an unrelated `{` further down the file, and a header that wraps
 * over two or three lines (`if err := alerter.AddRule(rule{…}); err != nil {`) is
 * still one block.
 *
 * It lives apart from `metrics.ts` because that file hit its file-size ratchet,
 * and the seam is real: nothing here knows about functions, violations or
 * baselines — only about `if`, `else` and where their braces pair.
 *
 * @module dsh-eng-core/metrics-branch
 */

import { lineOfOffset, skipSpace } from './metrics-text.js'
import type { Lexed } from './metrics-text.js'
import { braceIndexAt, closerOf } from './metrics-braces.js'
import type { Braces } from './metrics-braces.js'

/** One `if`/`else` block and its span in lines. */
export interface IfBlockMetric {
    line: number
    lines: number
    kind: 'if' | 'else'
}

/**
 * How many lines an `if` header may span (see {@link ifBlockOpener}).
 *
 * Real headers are one line, or two-three when a call's arguments wrap
 * (`if err := alerter.AddRule(observability.AlertRule{…}); err != nil {`).
 * Twenty is generous and still bounds the work one `if` can cause on a
 * pathological file — the old code used a 300-character window instead, which
 * was both too small (it lost real blocks whose `{` sat 307 characters away)
 * and unprincipled.
 */
const IF_HEADER_MAX_LINES = 20

/** Characters that cannot start an `if` condition: `if:`/`if,` are object keys. */
const NOT_A_CONDITION_START = ':,)]}=.'

/**
 * Whether the language writes its condition in parentheses.
 *
 * TS/JS/Java/Kotlin/C#/PHP do, so the header is consumed through its matching
 * `)` and the block exists only when a `{` follows. Go and Rust do not need
 * them, and Swift's parentheses are optional — those take the generic path,
 * which finds the `{` at bracket depth 0 on the logical line.
 */
function ifConditionUsesParens(language: Lexed['language']): boolean {
    return language === 'ts' || language === 'js' || language === 'java' || language === 'kotlin' || language === 'csharp' || language === 'php'
}

/** Whether the character can be part of an identifier. */
function isWordChar(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z0-9_$]/.test(char)
}

/** Index of the previous non-whitespace character, or -1. */
function previousNonSpace(masked: string, from: number): number {
    for (let index = from - 1; index >= 0; index -= 1) {
        if (!/\s/.test(masked[index] ?? '')) return index
    }
    return -1
}

/** Offset of the bracket matching the one at `open`, or -1 when it is not closed before `stop`. */
function matchParenBefore(masked: string, open: number, stop: number): number {
    let depth = 0
    for (let index = open; index < Math.min(stop, masked.length); index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') {
            depth -= 1
            if (depth === 0) return index
            if (depth < 0) return -1
        }
    }
    return -1
}

/**
 * The `{` that opens the block of an `if` header, or -1 when there is none.
 *
 * `from` is the offset just after the `if` keyword. The header is PARSED, never
 * guessed, so a brace-less one-liner (`if (!resolved.enabled) return`) can no
 * longer adopt an unrelated `{` further down the file:
 *
 * - Languages that require parentheses (TS/JS/Java/Kotlin/C#/PHP) consume the
 *   condition by matching its `)`; the block exists only when the next non-space
 *   character is `{` (`if (x)\n{` is still a block, `if (x)\n  return` is not).
 * - Go/Rust/Swift need none, so the condition runs to the first `{` at bracket
 *   depth 0 on the logical line, skipping a composite literal in the init
 *   statement (`if want := []any{1}; !ok {`), the header may start with any
 *   character (`if *flag {`, `if &x {`, `if 1 < 2 {`) and it may continue on the
 *   next line when the line ends with an operator (`&&`), which is exactly Go's
 *   automatic semicolon insertion rule.
 *
 * The scan is bounded to {@link IF_HEADER_MAX_LINES} lines — far more than any
 * real header (the longest one in the repositories measured is 3) and enough to
 * hold a composite literal inside the condition.
 */
function ifBlockOpener(lexed: Lexed, braces: Braces, from: number): number {
    const masked = lexed.masked
    const headerLine = lineOfOffset(lexed, from)
    const lastLine = Math.min(headerLine + IF_HEADER_MAX_LINES, lexed.lineStarts.length - 1)
    const stop = lexed.lineStarts[lastLine] ?? masked.length
    const open = skipSpace(masked, from)
    if (open >= stop) return -1
    if (ifConditionUsesParens(lexed.language) && masked[open] === '(') {
        const close = matchParenBefore(masked, open, stop)
        if (close < 0) return -1
        const next = skipSpace(masked, close + 1)
        if (next >= stop) return -1
        return masked[next] === '{' ? next : -1
    }
    if (NOT_A_CONDITION_START.includes(masked[open] ?? '')) return -1
    let depth = 0
    for (let index = open; index < stop; index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[') depth += 1
        else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
        else if (char === '{' && depth === 0) {
            // A composite literal in an `if` init statement (`if v := T{a}; …`)
            // is not the block: it is the only place where a `{` at depth 0 can
            // be followed by `;` instead of a statement body.
            const literal = compositeLiteralEnd(masked, braces, index)
            if (literal >= 0) {
                index = literal
                continue
            }
            return index
        } else if (char === '}' && depth === 0) return -1
        else if (char === '\n' && depth === 0 && !continuesOnNextLine(masked, index)) return -1
    }
    return -1
}

/** Offset of the `}` closing a composite literal at `offset`, or -1 when there is none. */
function compositeLiteralEnd(masked: string, braces: Braces, offset: number): number {
    const index = braceIndexAt(braces, offset)
    if (index < 0 || (braces.offsets[index] ?? -1) !== offset) return -1
    const closer = braces.match[index] ?? -1
    if (closer < 0) return -1
    const end = braces.offsets[closer] ?? -1
    if (end < 0) return -1
    return masked[skipSpace(masked, end + 1)] === ';' ? end : -1
}

/**
 * Whether a line ending at the `\n` at `newline` continues the statement.
 *
 * Go inserts a semicolon when a line ends with an identifier, a literal, `)`,
 * `]`, `}`, `++`/`--` or `return`; a line ending in an operator does not end the
 * statement, so an `if` condition may wrap (`… &&\n  other`).
 */
function continuesOnNextLine(masked: string, newline: number): boolean {
    const previous = previousNonSpace(masked, newline)
    if (previous < 0) return false
    return ',;:+-*/%&|^<>=!.(['.includes(masked[previous] ?? '')
}

/**
 * Every `if`/`else if`/`else` block of a brace-language file.
 *
 * A one-liner without a block (`if (x) return`, `if 1 < 2 return`) is skipped,
 * `} else if (y) {` counts as an `if` whose span starts at the `else`, and a
 * bare `} else {` counts as an `else`. A header whose condition spans several
 * lines is still one block, and the opener may sit far from the `if` (up to
 * {@link IF_HEADER_MAX_LINES} lines).
 */
export function braceIfBlocks(lexed: Lexed, braces: Braces): IfBlockMetric[] {
    const masked = lexed.masked
    const blocks: IfBlockMetric[] = []
    const seen = new Set<number>()

    const collect = (candidate: number, headerLine: number, kind: 'if' | 'else'): void => {
        if (candidate < 0 || masked[candidate] !== '{') return
        const index = braceIndexAt(braces, candidate)
        if (index < 0 || (braces.offsets[index] ?? -1) !== candidate) return
        const closer = closerOf(braces, index)
        if (closer < 0) return
        if (seen.has(candidate)) return
        seen.add(candidate)
        const endLine = lineOfOffset(lexed, braces.offsets[closer] ?? candidate)
        blocks.push({ line: headerLine + 1, lines: endLine - headerLine + 1, kind })
    }

    for (let index = 0; index < masked.length; index += 1) {
        if (masked[index] !== 'i' && masked[index] !== 'e') continue
        if (masked.startsWith('if', index)) {
            if (isWordChar(masked[index - 1]) || isWordChar(masked[index + 2])) continue
            const before = previousNonSpace(masked, index)
            const gap = before < 0 ? '' : masked.slice(before + 1, index)
            const previous = before < 0 ? '' : masked[before] ?? ''
            // `else if` is collected from its `else`, so it is not counted twice.
            if (!gap.includes('\n') && !';{}()'.includes(previous)) continue
            collect(ifBlockOpener(lexed, braces, index + 2), lineOfOffset(lexed, index), 'if')
            continue
        }
        if (!masked.startsWith('else', index)) continue
        if (isWordChar(masked[index - 1]) || isWordChar(masked[index + 4])) continue
        const before = previousNonSpace(masked, index)
        const gap = before < 0 ? '' : masked.slice(before + 1, index)
        const previous = before < 0 ? '' : masked[before] ?? ''
        if (!gap.includes('\n') && previous !== '}' && previous !== ';') continue
        const next = skipSpace(masked, index + 4)
        const headerLine = lineOfOffset(lexed, index)
        if (masked.startsWith('if', next) && !isWordChar(masked[next + 2])) collect(ifBlockOpener(lexed, braces, next + 2), headerLine, 'if')
        else collect(masked[next] === '{' ? next : -1, headerLine, 'else')
    }
    return blocks.sort((left, right) => left.line - right.line || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))
}

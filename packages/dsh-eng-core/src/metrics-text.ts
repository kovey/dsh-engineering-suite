/**
 * The text half of the code metrics: masking a source file, plus the offset and
 * bracket helpers every language analyzer needs.
 *
 * `metrics.ts` reads structure (`{}`, `if`, `def`) out of the MASKED text, so
 * everything that can hide a brace — comments, strings, template literals and
 * their `${…}` holes, regex literals — has to be blanked here, exactly once. A
 * brace that survives the mask where it should not (or the other way round) is
 * what makes a function measure to the end of the file.
 *
 * It lives in its own module because `metrics.ts` reached its file-size ratchet:
 * splitting is the sanctioned remedy, and the seam is real — nothing here knows
 * about functions, classes or violations, and nothing here writes anything.
 *
 * @module dsh-eng-core/metrics-text
 */

import type { Language } from './scan.js'

/** One string literal, kept because import specifiers live inside them. */
export interface StringLiteral {
    /** 1-based line of the opening quote. */
    line: number
    /** Raw content between the quotes (escapes left exactly as written). */
    value: string
    /** Offset of the first content character. */
    start: number
    /** Offset just past the closing quote (or the end of the file). */
    end: number
}

/** A source file lexed once: comments/strings blanked out, plus a line index. */
export interface Lexed {
    /** Language the file was lexed as (Go's `if` needs no parentheses, TS's does). */
    language: Language
    /** Same length as the source: comment and string bodies replaced by spaces (newlines kept). */
    masked: string
    /** Raw lines, `\r` stripped (0-based; a trailing newline adds no line). */
    lines: string[]
    /** Masked lines, `\r` stripped. */
    maskedLines: string[]
    /** Offset at which each line starts. */
    lineStarts: number[]
    /** Non-template string literals in source order. */
    strings: StringLiteral[]
}

/** One function with its end line kept for span queries. */
export interface MeasuredFunction {
    name: string
    /** 1-based first line. */
    line: number
    /** 1-based last line (inclusive). */
    endLine: number
    lines: number
    depth: number
    params: number
}

/**
 * Count the lines of a file.
 *
 * An empty file has 0 lines; a file whose last line has no trailing newline
 * still counts that line (the honest answer to "how long is this file").
 */
export function countLines(text: string): number {
    if (text === '') return 0
    let total = 1
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) total += 1
    return text.endsWith('\n') ? total - 1 : total
}

/**
 * Offset just past the closing backtick of the template literal starting at
 * `from` (or the end of the file when it never closes).
 *
 * Three things end a template literal early if they are not handled, and each of
 * them leaves real code outside the mask:
 *
 *  - `\`` — an escaped backtick is text, not a terminator;
 *  - `${ … }` — a hole is code, so its `}` does not belong to the literal;
 *  - a template nested inside a hole (`` `a${`b`}c` ``) — its backticks pair
 *    with each other, never with the outer literal's.
 *
 * Getting any of these wrong makes the rest of the literal look like code; a
 * block-comment opener in the prose then starts a real comment that blanks
 * everything up to the next comment terminator, including the enclosing
 * function's closing brace.
 */
export function scanTemplateEnd(text: string, from: number): number {
    let cursor = from + 1
    while (cursor < text.length) {
        const char = text[cursor] ?? ''
        if (char === '\\') {
            cursor += 2
            continue
        }
        if (char === '`') return cursor + 1
        if (char === '$' && text[cursor + 1] === '{') {
            cursor = scanTemplateHoleEnd(text, cursor + 2)
            continue
        }
        cursor += 1
    }
    return text.length
}

/**
 * Offset just past the `}` that closes a `${ … }` hole whose content starts at
 * `from`, or the end of the file.
 *
 * The braces are counted so a hole holding an object literal
 * (`${{ a: 1 }}`) ends at the right `}`. Everything that could hide a brace or a
 * backtick is skipped whole, in the same order the main loop uses: a nested
 * template, a quoted string, a comment and a regex literal. A regex matters here
 * for the same reason it matters in the main loop — `/[$`]/` puts a backtick in
 * a character class, and reading it as a nested template would lose the end of
 * the outer literal.
 */
export function scanTemplateHoleEnd(text: string, from: number): number {
    let depth = 1
    let cursor = from
    /** Last non-whitespace character seen in code context (for regex detection). */
    let lastCode = '{'
    while (cursor < text.length) {
        const char = text[cursor] ?? ''
        if (/\s/.test(char)) {
            cursor += 1
            continue
        }
        if (char === '\\') {
            cursor += 2
            continue
        }
        if (char === '`') {
            cursor = scanTemplateEnd(text, cursor)
            lastCode = '`'
            continue
        }
        if (char === '/' && text[cursor + 1] === '/') {
            const stop = text.indexOf('\n', cursor)
            cursor = stop < 0 ? text.length : stop
            continue
        }
        if (char === '/' && text[cursor + 1] === '*') {
            const stop = text.indexOf('*/', cursor + 2)
            cursor = stop < 0 ? text.length : stop + 2
            continue
        }
        if (char === '/' && regexCanStart(lastCode)) {
            const stop = scanRegexEnd(text, cursor)
            if (stop > 0) {
                cursor = stop
                lastCode = '/'
                continue
            }
        }
        if (char === '"' || char === "'") {
            let end = cursor + 1
            while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
            cursor = end + 1
            lastCode = char
            continue
        }
        if (char === '{') depth += 1
        else if (char === '}') {
            depth -= 1
            if (depth === 0) return cursor + 1
        }
        lastCode = char
        cursor += 1
    }
    return text.length
}

/**
 * Offset just past the regex literal starting with the `/` at `from`, or -1 when
 * it never closes on its line (which makes the `/` a division after all).
 */
export function scanRegexEnd(text: string, from: number): number {
    let cursor = from + 1
    let inClass = false
    while (cursor < text.length) {
        const current = text[cursor] ?? ''
        if (current === '\\') {
            cursor += 2
            continue
        }
        if (current === '\n') return -1
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) return cursor + 1
        cursor += 1
    }
    return -1
}

/**
 * Whether a `/` at this position starts a regex literal rather than a division.
 *
 * A regex may only follow an operator, an opening bracket, a comma or the start
 * of the file; after an identifier, a number or a closing bracket the `/` is a
 * division. This is the standard lexical heuristic, and it is what keeps a
 * quote inside a character class (`/['"]/`) from being read as a string.
 */
export function regexCanStart(previous: string): boolean {
    return previous === '' || '(,=:[!&|?{};+-*%~^<>'.includes(previous)
}

/** Line index (0-based) holding `offset`, clamped into the file. */
export function lineOfOffset(lexed: Lexed, offset: number): number {
    let low = 0
    let high = Math.max(0, lexed.lineStarts.length - 1)
    while (low < high) {
        const middle = (low + high + 1) >> 1
        if ((lexed.lineStarts[middle] ?? 0) <= offset) low = middle
        else high = middle - 1
    }
    return Math.min(low, Math.max(0, lexed.maskedLines.length - 1))
}

/** Offset of the bracket matching the one at `open`, or -1. */
export function matchParen(masked: string, open: number): number {
    let depth = 0
    for (let index = open; index < masked.length; index += 1) {
        const char = masked[index]
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') {
            depth -= 1
            if (depth === 0) return index
            if (depth < 0) return -1
        }
    }
    return -1
}

/** Offset of the first non-whitespace character at or after `from`. */
export function skipSpace(masked: string, from: number): number {
    let index = from
    while (index < masked.length && /\s/.test(masked[index] ?? '')) index += 1
    return index
}

/**
 * Brace structure of one Go/TS/JS file: every `{`/`}` in source order, its
 * partner, and the nesting depth per line.
 *
 * This is the layer that decides what a function's body IS. `metrics.ts` reads a
 * function's length from its body's paired braces, so a brace that pairs with the
 * wrong partner (or not at all) is not a rounding error: it is a length that
 * describes something else. The two rules that keep it honest are here:
 *
 *  1. A closer pairs with the most recent opener, and a brace with no partner
 *     keeps `-1` — nothing is invented for it.
 *  2. The mask (see `metrics-text.ts`) is what makes that pairing possible: a
 *     brace hidden by a comment/string/template is absent, a brace inside code
 *     is present.
 *
 * @module dsh-eng-core/metrics-braces
 */

import type { Lexed } from './metrics-text.js'

/** Brace nesting of one file: per-brace matching plus per-line depths. */
export interface Braces {
    /** Offsets of every `{`/`}` in source order. */
    offsets: number[]
    /** Matching brace index (into `offsets`), or -1 for an unmatched brace. */
    match: number[]
    /** Depth before that brace. */
    depthBefore: number[]
    /** For an opener: the deepest depth reached inside it (its own level included). */
    subtreeMax: number[]
    /** Brace depth at the start of each line. */
    depthBeforeLine: number[]
    /** Deepest depth reached while scanning each line. */
    maxDepthLine: number[]
    maxDepth: number
    /** 0-based first line reaching {@link maxDepth}. */
    maxDepthLineIndex: number
}

export function braceStructure(lexed: Lexed): Braces {
    const masked = lexed.masked
    const lineCount = lexed.maskedLines.length
    const offsets: number[] = []
    const match: number[] = []
    const depthBefore: number[] = []
    const subtreeMax: number[] = []
    const depthBeforeLine = new Array<number>(lineCount).fill(0)
    const maxDepthLine = new Array<number>(lineCount).fill(0)
    const stack: { index: number; max: number }[] = []
    let depth = 0
    let line = 0
    for (let index = 0; index < masked.length; index += 1) {
        while (line + 1 < lineCount && (lexed.lineStarts[line + 1] ?? Number.MAX_SAFE_INTEGER) <= index) {
            line += 1
            depthBeforeLine[line] = depth
            maxDepthLine[line] = depth
        }
        const char = masked[index]
        if (char !== '{' && char !== '}') continue
        offsets.push(index)
        depthBefore.push(depth)
        if (char === '{') {
            match.push(-1)
            subtreeMax.push(depth + 1)
            stack.push({ index: offsets.length - 1, max: depth + 1 })
            depth += 1
            maxDepthLine[line] = Math.max(maxDepthLine[line] ?? 0, depth)
        } else {
            const top = stack.pop()
            const index = offsets.length - 1
            if (top !== undefined) match[top.index] = index
            match.push(top === undefined ? -1 : top.index)
            subtreeMax.push(-1)
            const reached = depth
            depth = Math.max(0, depth - 1)
            maxDepthLine[line] = Math.max(maxDepthLine[line] ?? 0, depth)
            if (top !== undefined) {
                top.max = Math.max(top.max, reached)
                subtreeMax[top.index] = top.max
                const parent = stack[stack.length - 1]
                if (parent !== undefined) parent.max = Math.max(parent.max, top.max)
            }
        }
    }
    let maxDepth = 0
    let maxDepthLineIndex = 0
    for (let index = 0; index < lineCount; index += 1) {
        const value = maxDepthLine[index] ?? 0
        if (value > maxDepth) {
            maxDepth = value
            maxDepthLineIndex = index
        }
    }
    return { offsets, match, depthBefore, subtreeMax, depthBeforeLine, maxDepthLine, maxDepth, maxDepthLineIndex }
}

/** First brace index whose offset is at or after `from`, or -1. */
export function braceIndexAt(braces: Braces, from: number): number {
    let low = 0
    let high = braces.offsets.length - 1
    let found = -1
    while (low <= high) {
        const middle = (low + high) >> 1
        if ((braces.offsets[middle] ?? -1) >= from) {
            found = middle
            high = middle - 1
        } else low = middle + 1
    }
    return found
}

/**
 * The `{` that opens a declaration's body.
 *
 * Go and TS may put an inline type between the signature and the body
 * (`func f() struct{ A int } {`, `function f(): { a: number } {`); such a brace
 * is recognised because the text right after its match is `(`, `)`, `,` or `]`,
 * i.e. it is still inside the signature.
 */
export function bodyOpener(masked: string, from: number, braces: Braces): number {
    let index = braceIndexAt(braces, from)
    for (let step = 0; step < 24 && index >= 0 && index < braces.offsets.length; step += 1) {
        const closer = braces.match[index] ?? -1
        if (closer < 0) return -1
        let cursor = (braces.offsets[closer] ?? 0) + 1
        while (cursor < masked.length && /\s/.test(masked[cursor] ?? '')) cursor += 1
        const next = masked[cursor]
        if (next === '(' || next === ')' || next === ',' || next === ']') {
            index = closer + 1
            continue
        }
        return index
    }
    return -1
}

/** Matching closer index of an opener index, or -1. */
export function closerOf(braces: Braces, opener: number): number {
    return braces.match[opener] ?? -1
}

/** Whether a `;` at bracket depth 0 occurs in `[from, to)` — a statement ended. */
export function statementEnded(masked: string, from: number, to: number): boolean {
    let depth = 0
    for (let index = from; index < Math.min(to, masked.length); index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        else if (char === ';' && depth === 0) return true
    }
    return false
}

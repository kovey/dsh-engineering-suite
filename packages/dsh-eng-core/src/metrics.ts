/**
 * Code metrics — the deterministic measurement half of the standards gate.
 *
 * `dsh-standards-gate` turns the structural standards a repository declares
 * (file/function size, nesting, `if`/`else` block size, parameter count,
 * exported surface, module dependency direction) into a gate. The half that
 * must never be creative lives here: this module MEASURES a workspace and
 * reports what it found. It calls no model, opens no socket, reads no clock and
 * writes nothing; the `frozenAt` timestamp of a baseline is written by the
 * CALLER, never by this module.
 *
 * Four rules make the output safe to consume:
 *
 *  1. **Deterministic.** Identical bytes in, identical result out: files are
 *     sorted by path, functions by line, violations by `key`, cycles by their
 *     normalised rotation. No `Date`, no `Math.random`, and no `Set`/`Map`
 *     iteration order leaking into the result.
 *  2. **Bounded.** The walk is `scan.ts`'s walk (`walkWorkspace`) — the same
 *     `maxFiles` budget, the same per-file byte bound, no symlink following,
 *     the same default-ignored directories. An oversized, unreadable or
 *     malformed file is skipped and counted, never thrown.
 *  3. **Read-only.** Measuring is analysis of `cwd`; there is no write path in
 *     this file at all. `compareToBaseline` only classifies.
 *  4. **Honest about its limits.** These are lexical metrics, not a compiler:
 *     comments and string literals are masked out before structure is read, but
 *     no type is resolved and no expression is parsed. Every approximation is
 *     written down in the README (`## 代码度量（metrics）`).
 *
 * @module dsh-eng-core/metrics
 */

import fs from 'node:fs'
import path from 'node:path'
import { silentLogger, type Logger } from './log.js'
import { globToRegExp } from './paths.js'
import {
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_FILE_BYTES,
    languageOf,
    readCapped,
    walkWorkspace,
    type Language,
} from './scan.js'

// --- public types -----------------------------------------------------------

/** Per-language thresholds. A rule applies only while it is declared. */
export interface RuleSet {
    maxFileLines?: number
    maxFunctionLines?: number
    maxDepth?: number
    maxIfBlockLines?: number
    maxParams?: number
    maxExports?: number
}

/** One architectural layer and the layers it may import from. */
export interface LayerRule {
    /** Path prefix this rule constrains, e.g. `internal/domain`. */
    path: string
    /** Path prefixes this layer may import from (empty = may import nothing but its own layer). */
    mayImport: readonly string[]
}

/** Everything a repository declares about its own code standards. */
export interface StandardsConfig {
    /** Per-language rules; the `default` entry applies to a language without one. */
    languages: Record<string, RuleSet>
    layers?: readonly LayerRule[]
    /** Flag import cycles among workspace files. Default false. */
    forbidCycles?: boolean
    /** Glob-ish skips: `**\/*_test.go`, `**\/testdata/**`, `*.gen.go`. */
    exempt?: readonly string[]
}

/** One function/method declaration and its span. */
export interface FunctionMetric {
    name: string
    line: number
    lines: number
    depth: number
    params: number
}

/** One `if`/`else` block and its span in lines. */
export interface IfBlockMetric {
    line: number
    lines: number
    kind: 'if' | 'else'
}

/** Everything measured about one file. */
export interface FileMetrics {
    /** Workspace-relative. */
    path: string
    language: 'go' | 'ts' | 'js' | 'python' | 'other'
    lines: number
    functions: FunctionMetric[]
    maxDepth: number
    ifBlocks: IfBlockMetric[]
    exports: number
    /** Workspace-relative module paths this file imports (resolved when they point inside the workspace). */
    imports: string[]
}

/** One broken standard, with a stable identity for the baseline ratchet. */
export interface Violation {
    rule: 'maxFileLines' | 'maxFunctionLines' | 'maxDepth' | 'maxIfBlockLines' | 'maxParams' | 'maxExports' | 'layer' | 'cycle'
    path: string
    line?: number
    /** Stable identity for the baseline ratchet: `rule|path|label` (label = symbol name, cycle id, layer name…). */
    key: string
    actual: number
    limit: number
    /** Chinese, one line, includes the numbers: `crawler.go 有 610 行（上限 400）`. */
    detail: string
}

/** What one measurement observed. */
export interface MetricsResult {
    cwd: string
    files: FileMetrics[]
    violations: Violation[]
    /** Import cycles as sorted path lists (empty when `forbidCycles` is false). */
    cycles: string[][]
    stats: { filesScanned: number; truncated: boolean; languages: Record<string, number>; exempted: number }
}

/** Bounds and inputs of {@link measureWorkspace}. */
export interface MeasureOptions {
    cwd: string
    standards: StandardsConfig
    maxFiles?: number
    maxFileBytes?: number
    logger?: Logger
}

/** The violations a repository froze as accepted, so the gate only fails on new ones. */
export interface BaselineFile {
    version: 1
    frozenAt: string
    /** Why this baseline exists / who accepted it (free text). */
    note?: string
    /** Accepted violation keys. */
    accepted: readonly string[]
}

// --- text helpers -----------------------------------------------------------

function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/**
 * Count the lines of a file.
 *
 * An empty file has 0 lines; a file whose last line has no trailing newline
 * still counts that line (the honest answer to "how long is this file").
 */
function countLines(text: string): number {
    if (text === '') return 0
    let total = 1
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) total += 1
    return text.endsWith('\n') ? total - 1 : total
}

/** One string literal, kept because import specifiers live inside them. */
interface StringLiteral {
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
interface Lexed {
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

/**
 * Mask comments and string/char literals.
 *
 * Structure (`{}`, `if`, `def`) is then read from `masked`, so a brace inside a
 * comment or an `if` inside a docstring is never counted, while the literals
 * themselves are kept separately for import specifiers. The mask preserves
 * offsets and newlines, so every offset still maps to the original line.
 */
function lexSource(text: string, language: Language): Lexed {
    const python = language === 'python'
    const chars = text.split('')
    const blank = (from: number, to: number): void => {
        for (let index = from; index < to; index += 1) if (chars[index] !== '\n') chars[index] = ' '
    }
    const lineStarts: number[] = [0]
    for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') lineStarts.push(index + 1)
    const lineOf = (offset: number): number => {
        let low = 0
        let high = lineStarts.length - 1
        while (low < high) {
            const middle = (low + high + 1) >> 1
            if ((lineStarts[middle] ?? 0) <= offset) low = middle
            else high = middle - 1
        }
        return low
    }
    const strings: StringLiteral[] = []
    let index = 0
    /** Last non-whitespace character seen in code context (for regex detection). */
    let lastCode = ''
    while (index < text.length) {
        const char = text[index] ?? ''
        if (python && char === '#') {
            const stop = text.indexOf('\n', index)
            const end = stop < 0 ? text.length : stop
            blank(index, end)
            index = end
            continue
        }
        if (!python && char === '/' && text[index + 1] === '/') {
            const stop = text.indexOf('\n', index)
            const end = stop < 0 ? text.length : stop
            blank(index, end)
            index = end
            continue
        }
        if (!python && char === '/' && text[index + 1] === '*') {
            const stop = text.indexOf('*/', index + 2)
            const end = stop < 0 ? text.length : stop + 2
            blank(index, end)
            index = end
            continue
        }
        if ((language === 'ts' || language === 'js') && char === '/' && regexCanStart(lastCode)) {
            // A regex literal is NOT a division and must be masked whole: a
            // quote inside it (`/['"]/`) would otherwise open a "string" that
            // swallows the rest of the file and silently drops every symbol
            // after it — a real bug found by measuring this very module.
            let cursor = index + 1
            let inClass = false
            let closed = false
            while (cursor < text.length) {
                const current = text[cursor] ?? ''
                if (current === '\\') {
                    cursor += 2
                    continue
                }
                if (current === '\n') break
                if (current === '[') inClass = true
                else if (current === ']') inClass = false
                else if (current === '/' && !inClass) {
                    closed = true
                    break
                }
                cursor += 1
            }
            if (closed) {
                blank(index, cursor + 1)
                index = cursor + 1
                continue
            }
        }
        if (char === '"' || char === "'" || (!python && char === '`')) {
            const triple = python && text[index + 1] === char && text[index + 2] === char
            const raw = char === '`'
            const contentStart = index + (triple ? 3 : 1)
            let cursor = contentStart
            let closed = false
            while (cursor < text.length) {
                const current = text[cursor] ?? ''
                if (!raw && current === '\\') {
                    cursor += 2
                    continue
                }
                if (triple) {
                    if (current === char && text[cursor + 1] === char && text[cursor + 2] === char) {
                        closed = true
                        break
                    }
                } else if (current === char) {
                    closed = true
                    break
                }
                cursor += 1
            }
            const contentEnd = closed ? cursor : text.length
            const stop = closed ? cursor + (triple ? 3 : 1) : text.length
            // Template literals are excluded: their `${…}` holes are not
            // specifiers, and a backtick is never an import path.
            if (!raw) strings.push({ line: lineOf(index) + 1, value: text.slice(contentStart, contentEnd), start: contentStart, end: contentEnd })
            blank(index, stop)
            index = stop
            continue
        }
        if (!/\s/.test(char)) lastCode = char
        index += 1
    }

    const masked = chars.join('')
    const splitLines = (source: string): string[] => {
        const parts = source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
        return parts
    }
    const lines = text === '' ? [] : splitLines(text)
    const maskedLines = text === '' ? [] : splitLines(masked)
    return { masked, lines, maskedLines, lineStarts, strings }
}

/**
 * Whether a `/` at this position starts a regex literal rather than a division.
 *
 * A regex may only follow an operator, an opening bracket, a comma or the start
 * of the file; after an identifier, a number or a closing bracket the `/` is a
 * division. This is the standard lexical heuristic, and it is what keeps a
 * quote inside a character class (`/['"]/`) from being read as a string.
 */
function regexCanStart(previous: string): boolean {
    return previous === '' || '(,=:[!&|?{};+-*%~^<>'.includes(previous)
}

/** Line index (0-based) holding `offset`, clamped into the file. */
function lineOfOffset(lexed: Lexed, offset: number): number {
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
function matchParen(masked: string, open: number): number {
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
function skipSpace(masked: string, from: number): number {
    let index = from
    while (index < masked.length && /\s/.test(masked[index] ?? '')) index += 1
    return index
}

/** Whether the `<` at `index` looks like the start of a generic argument list. */
function looksGeneric(text: string, index: number): boolean {
    const before = text[index - 1]
    if (before === undefined || !/[A-Za-z0-9_$>]/.test(before)) return false
    const after = text[index + 1]
    if (after === undefined || !/[A-Za-z_$([{'"]/.test(after)) return false
    let depth = 0
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
        const char = text[cursor]
        if (char === '<') depth += 1
        else if (char === '>') {
            if (depth === 0) return true
            depth -= 1
        } else if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') {
            if (depth === 0) return false
            depth -= 1
        }
    }
    return false
}

/**
 * Count declared parameters.
 *
 * Top-level commas only: `(a, b string)` is 2, `(opts)` is 1, `()` is 0. A
 * trailing comma (legal in Go and TS) is not an extra parameter. In TS a `<`
 * that looks like a generic argument list counts as nesting, so
 * `(a: Map<string, number>)` is 1.
 */
function paramCount(text: string, generics: boolean): number {
    const trimmed = text.trim()
    if (trimmed === '') return 0
    let depth = 0
    let count = 1
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        else if (generics && char === '<' && looksGeneric(text, index)) depth += 1
        else if (generics && char === '>' && depth > 0) depth = Math.max(0, depth - 1)
        else if (char === ',' && depth === 0) count += 1
    }
    if (trimmed.endsWith(',')) count -= 1
    return Math.max(0, count)
}

/** Whether a `;` at bracket depth 0 occurs in `[from, to)` — a statement ended. */
function statementEnded(masked: string, from: number, to: number): boolean {
    let depth = 0
    for (let index = from; index < Math.min(to, masked.length); index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        else if (char === ';' && depth === 0) return true
    }
    return false
}

/**
 * Names declared by a declarator list (`a = 1, b: T = 2` → `['a', 'b']`).
 *
 * Commas at bracket depth 0 separate declarators; a comma inside a type,
 * a generic or a default value does not.
 */
function declaratorNames(text: string): string[] {
    const segments: string[] = []
    let depth = 0
    let current = ''
    for (const char of text) {
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        if (char === ',' && depth === 0) {
            segments.push(current)
            current = ''
            continue
        }
        current += char
    }
    segments.push(current)
    const names: string[] = []
    for (const segment of segments) {
        const match = /^\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?(?:=|$)/.exec(segment)
        if (match !== null) names.push(match[1] ?? '')
    }
    return names
}

// --- brace structure (Go / TS / JS) -----------------------------------------

/** Brace nesting of one file: per-brace matching plus per-line depths. */
interface Braces {
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

function braceStructure(lexed: Lexed): Braces {
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
function braceIndexAt(braces: Braces, from: number): number {
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
function bodyOpener(masked: string, from: number, braces: Braces): number {
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

// --- indentation structure (Python) -----------------------------------------

/** Indentation structure of one Python file. */
interface PyStructure {
    /** Indentation width per line (a tab counts 4). */
    width: number[]
    /** Whether the line is blank/comment-only/inside a string. */
    blank: boolean[]
    /** Whether the line continues a statement opened on an earlier line. */
    continuation: boolean[]
    /** Indentation unit: the smallest width step observed. */
    step: number
    /** Nesting level per line (`width / step`). */
    level: number[]
    maxDepth: number
    /** 0-based first line reaching {@link maxDepth}. */
    maxDepthLineIndex: number
}

function indentWidth(line: string): number {
    let width = 0
    for (const char of line) {
        if (char === ' ') width += 1
        else if (char === '\t') width += 4 - (width % 4)
        else break
    }
    return width
}

function pyStructure(lexed: Lexed): PyStructure {
    const width: number[] = []
    const blank: boolean[] = []
    const continuation: boolean[] = []
    let balance = 0
    let backslash = false
    for (const line of lexed.maskedLines) {
        const trimmed = line.trim()
        const isBlank = trimmed === ''
        blank.push(isBlank)
        continuation.push(!isBlank && (balance > 0 || backslash))
        width.push(indentWidth(line))
        for (const char of line) {
            if (char === '(' || char === '[' || char === '{') balance += 1
            else if (char === ')' || char === ']' || char === '}') balance = Math.max(0, balance - 1)
        }
        backslash = trimmed.endsWith('\\')
    }
    let step = 0
    for (let line = 0; line < width.length; line += 1) {
        if (blank[line] === true || continuation[line] === true) continue
        const value = width[line] ?? 0
        if (value > 0 && (step === 0 || value < step)) step = value
    }
    if (step === 0) step = 4
    const level = width.map((value) => Math.floor(value / step + 1e-9))
    let maxDepth = 0
    let maxDepthLineIndex = 0
    for (let line = 0; line < level.length; line += 1) {
        if (blank[line] === true || continuation[line] === true) continue
        const value = level[line] ?? 0
        if (value > maxDepth) {
            maxDepth = value
            maxDepthLineIndex = line
        }
    }
    return { width, blank, continuation, step, level, maxDepth, maxDepthLineIndex }
}

// --- analysis shapes --------------------------------------------------------

/** One function with its end line kept for span queries. */
interface MeasuredFunction {
    name: string
    /** 1-based first line. */
    line: number
    /** 1-based last line (inclusive). */
    endLine: number
    lines: number
    depth: number
    params: number
}

/** A raw import specifier as written in the source. */
interface RawImport {
    specifier: string
    /** 1-based line of the import statement. */
    line: number
    /** Python only: number of leading dots (0 = absolute). */
    level?: number
}

/** Rules-free result of analyzing one file. */
interface Analysis {
    functions: MeasuredFunction[]
    maxDepth: number
    /** 1-based line where `maxDepth` is first reached. */
    maxDepthLine: number
    ifBlocks: IfBlockMetric[]
    exports: number
}

// --- Go ---------------------------------------------------------------------

const GO_FUNC = /^\s*func\s+(?:\(\s*(?:([A-Za-z_]\w*)\s+)?\*?([A-Za-z_][\w.]*)\s*(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/
const GO_IMPORT_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"/
const GO_IMPORT_GROUP = /^\s*import\s*\(/

/** Functions of one Go file (methods are named `Type.Name`). */
function goFunctions(lexed: Lexed, braces: Braces): MeasuredFunction[] {
    const functions: MeasuredFunction[] = []
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const match = GO_FUNC.exec(lexed.maskedLines[line] ?? '')
        if (match === null) continue
        const receiver = match[2]
        const name = match[3] ?? ''
        if (name === '') continue
        const start = lexed.lineStarts[line] ?? 0
        const openParen = start + match[0].length - 1
        if (lexed.masked[openParen] !== '(') continue
        const closeParen = matchParen(lexed.masked, openParen)
        if (closeParen < 0) continue
        const opener = bodyOpener(lexed.masked, closeParen + 1, braces)
        if (opener < 0) continue
        const closer = braces.match[opener] ?? -1
        if (closer < 0) continue
        const endLine = lineOfOffset(lexed, braces.offsets[closer] ?? start)
        const depth = (braces.subtreeMax[opener] ?? 1) - (braces.depthBefore[opener] ?? 0)
        functions.push({
            name: receiver === undefined || receiver === '' ? name : `${receiver}.${name}`,
            line: line + 1,
            endLine: endLine + 1,
            lines: endLine - line + 1,
            depth: Math.max(1, depth),
            params: paramCount(lexed.masked.slice(openParen + 1, closeParen), false),
        })
    }
    return functions
}

/** Imports of one Go file, as written (the module prefix still included). */
function goImports(lexed: Lexed): RawImport[] {
    const raw: RawImport[] = []
    let group = false
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const maskedLine = lexed.maskedLines[line] ?? ''
        const source = lexed.lines[line] ?? ''
        const trimmed = source.trim()
        if (group) {
            if (/^\)/.test(trimmed)) {
                group = false
                continue
            }
            // The path itself is a string literal, so the masked line is blank
            // for a real import: comments have to be recognised in the raw text.
            if (trimmed === '' || /^(?:\/\/|\/\*|\*)/.test(trimmed)) continue
            const quoted = /"([^"]*)"/.exec(source)
            if (quoted !== null) raw.push({ specifier: quoted[1] ?? '', line: line + 1 })
            continue
        }
        if (maskedLine.trim() === '') continue
        if (GO_IMPORT_GROUP.test(maskedLine)) {
            group = true
            continue
        }
        if (!GO_IMPORT_SINGLE.test(source)) continue
        const quoted = /"([^"]*)"/.exec(source)
        if (quoted !== null) raw.push({ specifier: quoted[1] ?? '', line: line + 1 })
    }
    return raw
}

/** Exported top-level identifiers of one Go file. */
function goExports(lexed: Lexed, braces: Braces): number {
    const maskedLines = lexed.maskedLines
    let count = 0
    let group = false
    for (let line = 0; line < maskedLines.length; line += 1) {
        const maskedLine = maskedLines[line] ?? ''
        if ((braces.depthBeforeLine[line] ?? 0) !== 0) continue
        if (maskedLine.trim() === '') continue
        if (group) {
            if (/^\s*\)/.test(maskedLine)) {
                group = false
                continue
            }
            if (/^\s*[A-Z]/.test(maskedLine)) count += 1
            continue
        }
        if (/^\s*(?:var|const|type)\s*\(\s*$/.test(maskedLine)) {
            group = true
            continue
        }
        const value = /^\s*(?:var|const)\s+(.+)$/.exec(maskedLine)
        if (value !== null) {
            for (const name of ((value[1] ?? '').split('=')[0] ?? '').split(',')) {
                if (/^\s*[A-Z]\w*\s*$/.test(name)) count += 1
            }
            continue
        }
        const named = /^\s*(?:type|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(maskedLine)
        if (named !== null && /^[A-Z]/.test(named[1] ?? '')) count += 1
    }
    return count
}

// --- TS / JS ----------------------------------------------------------------

const TS_FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const TS_DECL = /^(\s*)(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*/
const TS_CLASS = /(?:^|[^\w$])class\s+([A-Za-z_$][\w$]*)/
const TS_METHOD = /^\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|declare)\s+)*(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/
const TS_PROPERTY = /^\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|declare)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/
const TS_RESERVED = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'await', 'delete', 'do', 'else',
    'function', 'class', 'super', 'throw', 'yield', 'case', 'default', 'in', 'instanceof', 'void', 'with',
])

/** One `class` body found in a TS/JS file. */
interface ClassScope {
    name: string
    openOffset: number
    closeOffset: number
    /** Brace depth of the members directly inside the body. */
    bodyDepth: number
}

function classScopes(lexed: Lexed, braces: Braces): ClassScope[] {
    const scopes: ClassScope[] = []
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const maskedLine = lexed.maskedLines[line] ?? ''
        const match = TS_CLASS.exec(maskedLine)
        if (match === null) continue
        const start = lexed.lineStarts[line] ?? 0
        const opener = bodyOpener(lexed.masked, start + (match.index ?? 0) + match[0].length, braces)
        if (opener < 0) continue
        const closer = braces.match[opener] ?? -1
        if (closer < 0) continue
        scopes.push({
            name: match[1] ?? '',
            openOffset: braces.offsets[opener] ?? 0,
            closeOffset: braces.offsets[closer] ?? 0,
            bodyDepth: (braces.depthBefore[opener] ?? 0) + 1,
        })
    }
    return scopes
}

/** Offset of the assignment `=` at depth 0 after `from`, or -1. */
function assignmentAt(masked: string, from: number, limit: number): number {
    let depth = 0
    for (let index = from; index < Math.min(limit, masked.length); index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        else if (char === ';' && depth === 0) return -1
        else if (char === '=' && depth === 0) {
            const before = masked[index - 1] ?? ''
            const after = masked[index + 1] ?? ''
            if (/[=!<>+\-*/%&|^?]/.test(before) || after === '=' || after === '>') continue
            return index
        }
    }
    return -1
}

/** Offset of `=>` at depth 0 after `from`, or -1. */
function arrowAt(masked: string, from: number, limit: number): number {
    let depth = 0
    for (let index = from; index < Math.min(limit, masked.length); index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '{') depth += 1
        else if (char === ')' || char === ']' || char === '}') {
            if (depth === 0) return -1
            depth -= 1
        } else if (char === ';' && depth === 0) return -1
        else if (char === '=' && masked[index + 1] === '>' && depth === 0) return index
    }
    return -1
}

/** Functions/classes/methods of one TS/JS file. */
function tsFunctions(lexed: Lexed, braces: Braces): MeasuredFunction[] {
    const functions: MeasuredFunction[] = []
    const masked = lexed.masked

    /** Record a function whose body starts at `from`; skip when there is none. */
    const record = (name: string, startLine: number, params: number, from: number): void => {
        const body = skipSpace(masked, from)
        if (body >= masked.length) return
        if (masked[body] === '{') {
            if (statementEnded(masked, from, body)) return
            const opener = bodyOpener(masked, body, braces)
            if (opener < 0) return
            const closer = closerOf(braces, opener)
            if (closer < 0) return
            const endLine = lineOfOffset(lexed, braces.offsets[closer] ?? body)
            const depth = (braces.subtreeMax[opener] ?? 1) - (braces.depthBefore[opener] ?? 0)
            functions.push({
                name,
                line: startLine + 1,
                endLine: endLine + 1,
                lines: endLine - startLine + 1,
                depth: Math.max(1, depth),
                params,
            })
            return
        }
        // An expression body (`=> expr`): its span is approximated by the line
        // on which the statement's bracket balance returns to zero.
        let balance = 0
        let cursor = body
        while (cursor < masked.length) {
            const char = masked[cursor] ?? ''
            if (char === '(' || char === '[' || char === '{') balance += 1
            else if (char === ')' || char === ']' || char === '}') {
                if (balance === 0) break
                balance -= 1
            } else if (balance === 0 && (char === ';' || char === '\n')) break
            cursor += 1
        }
        const endLine = Math.max(startLine, lineOfOffset(lexed, cursor))
        let depth = 0
        for (let line = startLine; line <= endLine; line += 1) {
            depth = Math.max(depth, (braces.maxDepthLine[line] ?? 0) - (braces.depthBeforeLine[startLine] ?? 0))
        }
        functions.push({
            name,
            line: startLine + 1,
            endLine: endLine + 1,
            lines: endLine - startLine + 1,
            depth: Math.max(1, depth),
            params,
        })
    }

    /** The `(params)` right after `at`, or -1. */
    const paramsAt = (at: number): { open: number; close: number } | undefined => {
        const open = skipSpace(masked, at)
        if (masked[open] !== '(') return undefined
        const close = matchParen(masked, open)
        if (close < 0) return undefined
        return { open, close }
    }

    // 1. `function name(…)` declarations, nested ones included.
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const match = TS_FUNCTION.exec(lexed.maskedLines[line] ?? '')
        if (match === null) continue
        const start = lexed.lineStarts[line] ?? 0
        const params = paramsAt(start + match[0].length)
        if (params === undefined) continue
        record(match[1] ?? '', line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1)
    }

    // 2. Class members: methods and arrow-valued properties.
    for (const scope of classScopes(lexed, braces)) {
        for (let line = 0; line < lexed.maskedLines.length; line += 1) {
            const start = lexed.lineStarts[line] ?? 0
            if (start <= scope.openOffset || start >= scope.closeOffset) continue
            if ((braces.depthBeforeLine[line] ?? 0) !== scope.bodyDepth) continue
            const maskedLine = lexed.maskedLines[line] ?? ''
            const method = TS_METHOD.exec(maskedLine)
            const name = (entry: string): string => (scope.name === '' ? entry : `${scope.name}.${entry}`)
            if (method !== null && !TS_RESERVED.has(method[1] ?? '')) {
                // `TS_METHOD` already consumed the `(`, so the offset points at it.
                const params = paramsAt(start + method[0].length - 1)
                if (params === undefined) continue
                record(name(method[1] ?? ''), line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1)
                continue
            }
            const property = TS_PROPERTY.exec(maskedLine)
            if (property === null || TS_RESERVED.has(property[1] ?? '')) continue
            const after = skipSpace(masked, start + property[0].length)
            if (/^function\b/.test(masked.slice(after, after + 9))) {
                const params = paramsAt(after + 8)
                if (params === undefined) continue
                record(name(property[1] ?? ''), line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1)
                continue
            }
            const arrow = arrowAt(masked, start + property[0].length, start + 400)
            if (arrow < 0) continue
            const params = paramsAt(start + property[0].length)
            if (params !== undefined && params.close < arrow) {
                record(name(property[1] ?? ''), line, paramCount(masked.slice(params.open + 1, params.close), true), arrow + 2)
                continue
            }
            record(name(property[1] ?? ''), line, 1, arrow + 2)
        }
    }

    // 3. `const name = (…) => …` and `const name = function (…) …`.
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const decl = TS_DECL.exec(lexed.maskedLines[line] ?? '')
        if (decl === null) continue
        const start = lexed.lineStarts[line] ?? 0
        const assign = assignmentAt(masked, start + decl[0].length, start + 400)
        if (assign < 0) continue
        const name = decl[2] ?? ''
        let cursor = skipSpace(masked, assign + 1)
        if (/^async\b/.test(masked.slice(cursor, cursor + 6))) cursor = skipSpace(masked, cursor + 5)
        if (/^function\b/.test(masked.slice(cursor, cursor + 9))) {
            const params = paramsAt(cursor + 8)
            if (params === undefined) continue
            record(name, line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1)
            continue
        }
        const arrow = arrowAt(masked, cursor, assign + 400)
        if (arrow < 0) continue
        const params = paramsAt(cursor)
        if (params !== undefined && params.close < arrow) {
            record(name, line, paramCount(masked.slice(params.open + 1, params.close), true), arrow + 2)
            continue
        }
        if (/^[A-Za-z_$][\w$]*$/.test(masked.slice(cursor, arrow).trim())) record(name, line, 1, arrow + 2)
    }

    return functions
}

/** Matching closer index of an opener index, or -1. */
function closerOf(braces: Braces, opener: number): number {
    return braces.match[opener] ?? -1
}

/** Import/require specifiers of one TS/JS file, read from its string literals. */
function tsImports(lexed: Lexed): RawImport[] {
    const raw: RawImport[] = []
    for (const literal of lexed.strings) {
        const specifier = literal.value
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
        let cursor = literal.start - 2
        while (cursor >= 0 && /\s/.test(lexed.masked[cursor] ?? '')) cursor -= 1
        const tail = lexed.masked.slice(Math.max(0, cursor - 12), cursor + 1)
        if (!/(?:^|[^\w$])(?:from|import|require)\s*\(?$/.test(tail)) continue
        raw.push({ specifier, line: literal.line })
    }
    return raw
}

/** Exported names of one TS/JS file. */
function tsExports(lexed: Lexed, braces: Braces): number {
    const maskedLines = lexed.maskedLines
    let count = 0
    let block = false
    for (let line = 0; line < maskedLines.length; line += 1) {
        const maskedLine = maskedLines[line] ?? ''
        if (block) {
            if (/^\s*\}\s*(?:from\b.*)?$/.test(maskedLine)) {
                block = false
                continue
            }
            const names = maskedLine.replace(/^\s+|\s+$/g, '')
            if (names !== '') count += names.split(',').filter((entry) => entry.trim() !== '').length
            continue
        }
        if ((braces.depthBeforeLine[line] ?? 0) !== 0) continue
        if (/^\s*export\s*\{\s*$/.test(maskedLine)) {
            block = true
            continue
        }
        const named = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/.exec(maskedLine)
        if (named !== null) {
            count += (named[1] ?? '').split(',').filter((entry) => entry.trim() !== '').length
            continue
        }
        if (/^\s*export\s+(?:type\s+)?\*\s*(?:as\s+[\w$]+\s*)?from\b/.test(maskedLine)) {
            count += 1
            continue
        }
        if (/^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b/.test(maskedLine)) {
            count += 1
            continue
        }
        const value = /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+(.+)$/.exec(maskedLine)
        if (value !== null) {
            count += declaratorNames(value[1] ?? '').length
            continue
        }
        if (/^\s*export\s+default\b/.test(maskedLine)) count += 1
    }
    return count
}

// --- Python -----------------------------------------------------------------

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/
const PY_IF = /^(\s*)(?:if|elif)\b/
const PY_ELSE = /^(\s*)else\s*:/
const PY_IMPORT_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\b/
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/

/** Last line (0-based) of the indented block that follows `line`. */
function pythonBlockEnd(lexed: Lexed, structure: PyStructure, line: number): number {
    const width = structure.width[line] ?? 0
    let end = line
    for (let cursor = line + 1; cursor < lexed.maskedLines.length; cursor += 1) {
        if (structure.blank[cursor] === true) continue
        if ((structure.width[cursor] ?? 0) <= width) break
        end = cursor
    }
    return end
}

/** Functions and `if` blocks of one Python file. */
function analyzePythonFunctions(lexed: Lexed, structure: PyStructure): { functions: MeasuredFunction[]; ifBlocks: IfBlockMetric[] } {
    const functions: MeasuredFunction[] = []
    const ifBlocks: IfBlockMetric[] = []
    const stack: { width: number; name: string }[] = []
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        if (structure.blank[line] === true || structure.continuation[line] === true) continue
        const maskedLine = lexed.maskedLines[line] ?? ''
        const width = structure.width[line] ?? 0
        while (stack.length > 0 && (stack[stack.length - 1]?.width ?? -1) >= width) stack.pop()

        const definition = PY_DEF.exec(maskedLine)
        if (definition !== null) {
            const name = definition[2] ?? ''
            const start = lexed.lineStarts[line] ?? 0
            const openParen = start + definition[0].length - 1
            const closeParen = matchParen(lexed.masked, openParen)
            // An unclosed parameter list means the file is malformed: report no
            // function rather than a span invented from the indentation.
            if (closeParen < 0) continue
            const end = pythonBlockEnd(lexed, structure, line)
            const defLevel = Math.floor(width / structure.step + 1e-9)
            let deepest = defLevel
            for (let cursor = line + 1; cursor <= end; cursor += 1) {
                if (structure.blank[cursor] === true || structure.continuation[cursor] === true) continue
                deepest = Math.max(deepest, structure.level[cursor] ?? defLevel)
            }
            functions.push({
                name: [...stack.map((scope) => scope.name), name].join('.'),
                line: line + 1,
                endLine: end + 1,
                lines: end - line + 1,
                depth: Math.max(1, deepest - defLevel),
                params: paramCount(lexed.masked.slice(openParen + 1, closeParen), false),
            })
            stack.push({ width, name })
            continue
        }

        const klass = PY_CLASS.exec(maskedLine)
        if (klass !== null) {
            stack.push({ width, name: klass[2] ?? '' })
            continue
        }

        const isIf = PY_IF.exec(maskedLine)
        const isElse = PY_ELSE.exec(maskedLine)
        if (isIf !== null || isElse !== null) {
            // A header only: `if x: return 1` is a one-liner without a block.
            if (!/:\s*$/.test(maskedLine)) continue
            const end = pythonBlockEnd(lexed, structure, line)
            if (end <= line) continue
            ifBlocks.push({ line: line + 1, lines: end - line + 1, kind: isIf !== null ? 'if' : 'else' })
        }
    }
    return { functions, ifBlocks }
}

/** Imports of one Python file (relative levels preserved). */
function pythonImports(lexed: Lexed, structure: PyStructure): RawImport[] {
    const raw: RawImport[] = []
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        if (structure.blank[line] === true || structure.continuation[line] === true) continue
        const maskedLine = lexed.maskedLines[line] ?? ''
        const relative = PY_IMPORT_FROM.exec(maskedLine)
        if (relative !== null) {
            raw.push({ specifier: relative[2] ?? '', line: line + 1, level: (relative[1] ?? '').length })
            continue
        }
        const plain = PY_IMPORT.exec(maskedLine)
        if (plain === null) continue
        for (const entry of (plain[1] ?? '').split(',')) {
            const specifier = entry.trim()
            if (specifier !== '') raw.push({ specifier, line: line + 1, level: 0 })
        }
    }
    return raw
}

/** Exported top-level names of one Python file, plus its `__all__` entries. */
function pythonExports(lexed: Lexed, structure: PyStructure): number {
    const maskedLines = lexed.maskedLines
    let count = 0
    let allLine = -1
    for (let line = 0; line < maskedLines.length; line += 1) {
        if (structure.blank[line] === true || structure.continuation[line] === true) continue
        if ((structure.width[line] ?? 0) !== 0) continue
        const maskedLine = maskedLines[line] ?? ''
        const named = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(maskedLine)
        if (named !== null) {
            if (!(named[1] ?? '').startsWith('_')) count += 1
            continue
        }
        if (/^__all__\s*(?::[^=]*)?=\s*\[/.test(maskedLine)) {
            if (allLine < 0) allLine = line
            continue
        }
        const assigned = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=/.exec(maskedLine)
        if (assigned !== null && !(assigned[1] ?? '').startsWith('_')) count += 1
    }
    if (allLine >= 0) {
        const open = (lexed.masked.indexOf('[', lexed.lineStarts[allLine] ?? 0) || 0)
        const close = open < 0 ? -1 : matchParen(lexed.masked, open)
        if (close > open) {
            for (const literal of lexed.strings) if (literal.start > open && literal.end <= close) count += 1
        }
    }
    return count
}

// --- if blocks (brace languages) --------------------------------------------

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

/**
 * Every `if`/`else if`/`else` block of a brace-language file.
 *
 * A one-liner without a block (`if (x) return`, `if err := f(); err != nil {…}`
 * is NOT one: its `;` and its `{` share a line) is skipped, `} else if (y) {`
 * counts as an `if` whose span starts at the `else`, and a bare `} else {`
 * counts as an `else`.
 */
function braceIfBlocks(lexed: Lexed, braces: Braces): IfBlockMetric[] {
    const masked = lexed.masked
    const blocks: IfBlockMetric[] = []
    const seen = new Set<number>()

    /** The `{` opening the block that follows `from`, or -1 for a one-liner. */
    const openerAfter = (from: number): number => {
        const stop = Math.min(masked.length, from + 300)
        let depth = 0
        let semicolon = -1
        for (let index = from; index < stop; index += 1) {
            const char = masked[index] ?? ''
            if (char === '(' || char === '[') depth += 1
            else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
            else if (char === '}' && depth === 0) return -1
            else if (char === ';' && depth === 0) {
                if (semicolon < 0) semicolon = index
            } else if (char === '{' && depth === 0) {
                if (semicolon >= 0 && lineOfOffset(lexed, semicolon) < lineOfOffset(lexed, index)) return -1
                return index
            }
        }
        return -1
    }

    const collect = (keyword: number, headerLine: number, kind: 'if' | 'else'): void => {
        const candidate = openerAfter(keyword)
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
            const first = masked[skipSpace(masked, index + 2)] ?? ''
            if (!/[A-Za-z_$([!]/.test(first)) continue
            collect(index, lineOfOffset(lexed, index), 'if')
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
        if (masked.startsWith('if', next) && !isWordChar(masked[next + 2])) collect(next, headerLine, 'if')
        else if (masked[next] === '{') collect(next, headerLine, 'else')
    }
    return blocks.sort((left, right) => left.line - right.line || compareText(left.kind, right.kind))
}

// --- workspace index & import resolution ------------------------------------

/** Facts about the workspace that import resolution needs. */
interface WorkspaceIndex {
    cwd: string
    /** Module path declared by the root `go.mod`, when there is one. */
    goModule?: string
    /** Code files the measurement actually visited (workspace-relative). */
    measured: Set<string>
    /** Package directories that contain at least one measured Go file. */
    goDirs: Set<string>
    /** `dir` → measured `.py` files directly inside it. */
    pythonInDir: Map<string, string[]>
    /** Memoised `fs.existsSync`/`statSync` answers. */
    exists: Map<string, boolean>
}

function existsIn(index: WorkspaceIndex, rel: string): boolean {
    const cached = index.exists.get(rel)
    if (cached !== undefined) return cached
    let value = false
    try {
        value = fs.existsSync(path.join(index.cwd, rel))
    } catch {
        value = false
    }
    index.exists.set(rel, value)
    return value
}

function isFileIn(index: WorkspaceIndex, rel: string): boolean {
    const cached = index.exists.get(rel)
    if (cached !== undefined) return cached
    let value = false
    try {
        value = fs.statSync(path.join(index.cwd, rel)).isFile()
    } catch {
        value = false
    }
    index.exists.set(rel, value)
    return value
}

function insideWorkspace(rel: string): boolean {
    return rel !== '' && !rel.startsWith('..') && !path.posix.isAbsolute(rel)
}

/** Collapse `a/../b`; `undefined` when the result leaves the workspace. */
function normaliseRel(rel: string): string | undefined {
    const normalised = path.posix.normalize(rel)
    if (normalised === '.') return ''
    if (!insideWorkspace(normalised)) return undefined
    return normalised
}

const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']
const TS_INDEX_FILES: readonly string[] = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs']

/** Resolve one TS/JS relative specifier to a workspace path. */
function resolveTs(index: WorkspaceIndex, from: string, specifier: string): string | undefined {
    const joined = normaliseRel(path.posix.join(path.posix.dirname(from), specifier))
    if (joined === undefined || joined === '') return undefined
    if (isFileIn(index, joined)) return joined
    for (const extension of TS_EXTENSIONS) {
        if (!joined.endsWith(extension)) continue
        const stem = joined.slice(0, -extension.length)
        for (const other of TS_EXTENSIONS) {
            if (other !== extension && isFileIn(index, `${stem}${other}`)) return `${stem}${other}`
        }
    }
    for (const extension of TS_EXTENSIONS) if (isFileIn(index, `${joined}${extension}`)) return `${joined}${extension}`
    for (const name of TS_INDEX_FILES) if (isFileIn(index, `${joined}/${name}`)) return `${joined}/${name}`
    return undefined
}

/** Resolve one Python import to a workspace package directory or module file. */
function resolvePython(index: WorkspaceIndex, from: string, raw: RawImport): string | undefined {
    const level = raw.level ?? 0
    const parts = raw.specifier.split('.').filter((part) => part !== '')
    let base = path.posix.dirname(from)
    if (base === '.') base = ''
    if (level > 0) {
        for (let step = 1; step < level; step += 1) base = path.posix.dirname(base) === '.' ? '' : path.posix.dirname(base)
    } else {
        const top = parts[0] ?? ''
        if (top === '') return undefined
        if (!isFileIn(index, `${top}.py`) && !existsIn(index, `${top}/__init__.py`)) return undefined
        base = ''
    }
    for (let take = parts.length; take > 0; take -= 1) {
        const joined = [base, ...parts.slice(0, take)].filter((part) => part !== '').join('/')
        if (joined === '') continue
        if (existsIn(index, `${joined}/__init__.py`)) return joined
        if (isFileIn(index, `${joined}.py`)) return `${joined}.py`
    }
    if (level > 0 && base !== '' && isFileIn(index, `${base}/__init__.py`)) return base
    return undefined
}

/** Resolve one Go import path to a workspace directory (`.` for the module root). */
function resolveGo(index: WorkspaceIndex, specifier: string): string | undefined {
    const module = index.goModule
    if (module === undefined || module === '') return undefined
    if (specifier === module) return '.'
    if (!specifier.startsWith(`${module}/`)) return undefined
    const target = specifier.slice(module.length + 1)
    if (target === '' || !existsIn(index, target)) return undefined
    return target
}

/** Read the root `go.mod` module path. */
function readGoModule(cwd: string, maxFileBytes: number, logger: Logger): string | undefined {
    const text = readCapped(path.join(cwd, 'go.mod'), maxFileBytes, logger)
    if (text === undefined) return undefined
    return /^\s*module\s+(\S+)\s*$/m.exec(text)?.[1]
}

// --- cycles -----------------------------------------------------------------

const MAX_CYCLES = 200
const MAX_CYCLE_STEPS = 200_000

/** Rotate a cycle so the lexicographically smallest path comes first. */
function normaliseCycle(cycle: readonly string[]): string[] {
    let pivot = 0
    for (let index = 1; index < cycle.length; index += 1) {
        if (compareText(cycle[index] ?? '', cycle[pivot] ?? '') < 0) pivot = index
    }
    return [...cycle.slice(pivot), ...cycle.slice(0, pivot)]
}

/**
 * Every simple import cycle of the graph, normalised and deduplicated.
 *
 * Only strongly connected components are searched; the result is capped
 * ({@link MAX_CYCLES}) and so is the traversal ({@link MAX_CYCLE_STEPS}), so a
 * pathological graph degrades to "the first N cycles" instead of hanging.
 */
function findCycles(edges: Map<string, string[]>, logger: Logger): string[][] {
    const nodes = [...edges.keys()].sort(compareText)
    const adjacency = new Map<string, string[]>()
    const reverse = new Map<string, string[]>()
    for (const node of nodes) {
        adjacency.set(node, [...new Set(edges.get(node) ?? [])].filter((target) => target !== node).sort(compareText))
        reverse.set(node, [])
    }
    for (const node of nodes) {
        for (const target of adjacency.get(node) ?? []) reverse.get(target)?.push(node)
    }
    for (const node of nodes) reverse.get(node)?.sort(compareText)

    // Kosaraju: a finish order over the graph, then components over its reverse.
    const order: string[] = []
    const visited = new Set<string>()
    for (const start of nodes) {
        if (visited.has(start)) continue
        const stack: { node: string; cursor: number }[] = [{ node: start, cursor: 0 }]
        visited.add(start)
        while (stack.length > 0) {
            const frame = stack[stack.length - 1] as { node: string; cursor: number }
            const neighbours = adjacency.get(frame.node) ?? []
            if (frame.cursor < neighbours.length) {
                const next = neighbours[frame.cursor] as string
                frame.cursor += 1
                if (!visited.has(next)) {
                    visited.add(next)
                    stack.push({ node: next, cursor: 0 })
                }
                continue
            }
            order.push(frame.node)
            stack.pop()
        }
    }
    const componentOf = new Map<string, number>()
    let componentCount = 0
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const start = order[index] as string
        if (componentOf.has(start)) continue
        const id = componentCount
        componentCount += 1
        const stack: string[] = [start]
        componentOf.set(start, id)
        while (stack.length > 0) {
            const node = stack.pop() as string
            for (const next of reverse.get(node) ?? []) {
                if (!componentOf.has(next)) {
                    componentOf.set(next, id)
                    stack.push(next)
                }
            }
        }
    }
    const components = new Map<number, string[]>()
    for (const node of nodes) {
        const id = componentOf.get(node) ?? -1
        if (id < 0) continue
        const bucket = components.get(id) ?? []
        bucket.push(node)
        components.set(id, bucket)
    }

    const found = new Map<string, string[]>()
    let steps = 0
    for (const id of [...components.keys()].sort((left, right) => left - right)) {
        const component = components.get(id) ?? []
        if (component.length < 2) continue
        const members = new Set(component)
        for (const start of [...component].sort(compareText)) {
            if (found.size >= MAX_CYCLES || steps >= MAX_CYCLE_STEPS) break
            const path: string[] = [start]
            const onPath = new Set<string>([start])
            const walk = (node: string): void => {
                if (found.size >= MAX_CYCLES || steps >= MAX_CYCLE_STEPS) return
                for (const next of adjacency.get(node) ?? []) {
                    steps += 1
                    if (steps >= MAX_CYCLE_STEPS || found.size >= MAX_CYCLES) return
                    if (!members.has(next)) continue
                    if (next === start) {
                        if (path.length < 2) continue
                        const cycle = normaliseCycle(path)
                        found.set(cycle.join('\u0000'), cycle)
                        continue
                    }
                    if (onPath.has(next)) continue
                    onPath.add(next)
                    path.push(next)
                    walk(next)
                    path.pop()
                    onPath.delete(next)
                }
            }
            walk(start)
        }
    }
    if (found.size >= MAX_CYCLES || steps >= MAX_CYCLE_STEPS) {
        logger.debug(`metrics: 导入环枚举达到上限（${MAX_CYCLES} 个 / ${MAX_CYCLE_STEPS} 步），已截断`)
    }
    return [...found.values()].sort((left, right) => compareText(left.join('\n'), right.join('\n')))
}

// --- rules ------------------------------------------------------------------

/** Whether `target` is `prefix` itself or sits under it. */
function under(target: string, prefix: string): boolean {
    const clean = prefix.replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean === '') return false
    return target === clean || target.startsWith(`${clean}/`)
}

/** The effective rule set of one language (`default` is the fallback). */
function rulesFor(standards: StandardsConfig, language: string): RuleSet | undefined {
    const languages = standards.languages ?? {}
    return languages[language] ?? languages['default']
}

/** A declared limit, or `undefined` when the rule is absent or invalid. */
function limitOf(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    return value
}

/** The innermost function containing `line`, when there is one. */
function enclosingFunction(functions: readonly MeasuredFunction[], line: number): MeasuredFunction | undefined {
    let best: MeasuredFunction | undefined
    for (const fn of functions) {
        if (line < fn.line || line > fn.endLine) continue
        if (best === undefined || fn.line > best.line) best = fn
    }
    return best
}

/** One measured file, plus the internals rules need (ends, import lines). */
interface MeasuredFile {
    metrics: FileMetrics
    functions: MeasuredFunction[]
    /** 1-based line of the deepest nesting. */
    depthLine: number
    /** Import target → line of its first import. */
    importLines: Map<string, number>
}

function violationOf(
    rule: Violation['rule'],
    path: string,
    label: string,
    line: number,
    actual: number,
    limit: number,
    detail: string,
): Violation {
    return { rule, path, line, key: `${rule}|${path}|${label}`, actual, limit, detail }
}

/** Every violation one file's measurements imply. */
function violationsFor(file: MeasuredFile, rules: RuleSet, standards: StandardsConfig): Violation[] {
    const violations: Violation[] = []
    const metrics = file.metrics
    const p = metrics.path

    const maxFileLines = limitOf(rules.maxFileLines)
    if (maxFileLines !== undefined && metrics.lines > maxFileLines) {
        violations.push(violationOf('maxFileLines', p, '(file)', 1, metrics.lines, maxFileLines, `${p} 有 ${metrics.lines} 行（上限 ${maxFileLines}）`))
    }

    const maxFunctionLines = limitOf(rules.maxFunctionLines)
    if (maxFunctionLines !== undefined) {
        for (const fn of file.functions) {
            if (fn.lines <= maxFunctionLines) continue
            violations.push(
                violationOf('maxFunctionLines', p, fn.name, fn.line, fn.lines, maxFunctionLines, `${p}:${fn.line} 函数 ${fn.name} 有 ${fn.lines} 行（上限 ${maxFunctionLines}）`),
            )
        }
    }

    const maxParams = limitOf(rules.maxParams)
    if (maxParams !== undefined) {
        for (const fn of file.functions) {
            if (fn.params <= maxParams) continue
            violations.push(
                violationOf('maxParams', p, fn.name, fn.line, fn.params, maxParams, `${p}:${fn.line} 函数 ${fn.name} 有 ${fn.params} 个参数（上限 ${maxParams}）`),
            )
        }
    }

    const maxDepth = limitOf(rules.maxDepth)
    if (maxDepth !== undefined && metrics.lines > 0 && metrics.maxDepth > maxDepth) {
        const owner = enclosingFunction(file.functions, file.depthLine)
        const label = owner === undefined ? '(file)' : owner.name
        const where = owner === undefined ? '文件级' : `函数 ${owner.name}`
        violations.push(
            violationOf('maxDepth', p, label, file.depthLine, metrics.maxDepth, maxDepth, `${p}:${file.depthLine} 嵌套深度 ${metrics.maxDepth}（上限 ${maxDepth}，位于${where}）`),
        )
    }

    const maxIfBlockLines = limitOf(rules.maxIfBlockLines)
    if (maxIfBlockLines !== undefined) {
        for (const block of metrics.ifBlocks) {
            if (block.lines <= maxIfBlockLines) continue
            const owner = enclosingFunction(file.functions, block.line)
            const label = owner === undefined ? '(file)' : owner.name
            violations.push(
                violationOf('maxIfBlockLines', p, label, block.line, block.lines, maxIfBlockLines, `${p}:${block.line} ${block.kind} 块有 ${block.lines} 行（上限 ${maxIfBlockLines}）`),
            )
        }
    }

    const maxExports = limitOf(rules.maxExports)
    if (maxExports !== undefined && metrics.exports > maxExports) {
        violations.push(
            violationOf('maxExports', p, '(file)', 1, metrics.exports, maxExports, `${p} 导出 ${metrics.exports} 个（上限 ${maxExports}）`),
        )
    }

    for (const layer of standards.layers ?? []) {
        if (layer === undefined || typeof layer.path !== 'string') continue
        if (!under(p, layer.path)) continue
        for (const target of metrics.imports) {
            if (under(target, layer.path)) continue
            if ((layer.mayImport ?? []).some((prefix) => under(target, prefix))) continue
            const line = file.importLines.get(target) ?? 1
            violations.push(
                violationOf('layer', p, target, line, 1, 0, `${p}:${line} 从层级 ${layer.path} 越界导入 ${target}（越界导入 1 处，上限 0）`),
            )
        }
    }

    // One rule can produce several violations that share a label — two over-long
    // `if` blocks in the SAME function, two same-named functions in one file.
    // Identical keys would let the baseline ratchet accept a violation it never
    // saw, so the later ones carry their line. The first keeps the plain
    // `rule|path|label` form, which is what the common case looks like.
    const used = new Set<string>()
    for (const violation of violations) {
        if (!used.has(violation.key)) {
            used.add(violation.key)
            continue
        }
        const label = violation.key.slice(violation.key.lastIndexOf('|') + 1)
        violation.key = `${violation.rule}|${violation.path}|${label}#L${violation.line ?? 1}`
        used.add(violation.key)
    }

    return violations
}

// --- measurement ------------------------------------------------------------

/**
 * Measure one workspace against its declared standards.
 *
 * Read-only, bounded and deterministic: see the module documentation. Files
 * matching an `exempt` pattern are counted in `stats.exempted`, keep their
 * `lines` (a report should still be able to show the size) and contribute no
 * functions, no imports and no violations. A file that cannot be read
 * (oversized, unreadable) is skipped entirely and still counted in
 * `stats.filesScanned`; a malformed one is measured as far as it parses.
 * @param options - workspace root, the standards and the walk bounds.
 * @returns per-file metrics, violations, cycles and statistics.
 */
export function measureWorkspace(options: MeasureOptions): MetricsResult {
    const cwd = path.resolve(options.cwd)
    const logger = options.logger ?? silentLogger
    const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_MAX_FILES)
    const maxFileBytes = Math.max(0, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    const standards: StandardsConfig = options.standards ?? { languages: {} }
    const exemptPatterns = (standards.exempt ?? []).filter((pattern) => typeof pattern === 'string' && pattern !== '')
    const exempt = exemptPatterns.map((pattern) => globToRegExp(pattern))

    const walk = walkWorkspace({ cwd, maxFiles, logger })
    const goModule = readGoModule(cwd, maxFileBytes, logger)
    const index: WorkspaceIndex = {
        cwd,
        ...(goModule === undefined ? {} : { goModule }),
        measured: new Set<string>(),
        goDirs: new Set<string>(),
        pythonInDir: new Map<string, string[]>(),
        exists: new Map<string, boolean>(),
    }

    const files: FileMetrics[] = []
    const measured: MeasuredFile[] = []
    const languages: Record<string, number> = {}
    let exempted = 0

    for (const entry of walk.files) {
        const language = languageOf(entry.rel)
        if (language === undefined) continue
        const text = readCapped(entry.abs, maxFileBytes, logger)
        if (text === undefined) continue
        const lines = countLines(text)
        if (exempt.some((pattern) => pattern.test(entry.rel))) {
            exempted += 1
            files.push({ path: entry.rel, language, lines, functions: [], maxDepth: 0, ifBlocks: [], exports: 0, imports: [] })
            continue
        }
        index.measured.add(entry.rel)
        if (language === 'go') index.goDirs.add(path.posix.dirname(entry.rel))
        if (language === 'python') {
            const dir = path.posix.dirname(entry.rel)
            const bucket = index.pythonInDir.get(dir) ?? []
            bucket.push(entry.rel)
            index.pythonInDir.set(dir, bucket)
        }
        try {
            const file = measureFile(entry.rel, text, language, index, standards)
            files.push(file.metrics)
            measured.push(file)
            languages[language] = (languages[language] ?? 0) + 1
        } catch (error) {
            // Belt and braces: a metrics bug must degrade to a missing file,
            // never to a failed gate.
            logger.debug(`metrics: 解析 ${entry.rel} 失败，已跳过`, error)
        }
    }

    const violations: Violation[] = []
    for (const file of measured) {
        const rules = rulesFor(standards, file.metrics.language)
        if (rules === undefined) continue
        violations.push(...violationsFor(file, rules, standards))
    }

    let cycles: string[][] = []
    if (standards.forbidCycles === true) {
        const edges = new Map<string, string[]>()
        const edgeLines = new Map<string, number>()
        const nodeOf = (file: MeasuredFile): string =>
            file.metrics.language === 'go' ? path.posix.dirname(file.metrics.path) : file.metrics.path
        for (const file of measured) {
            const from = nodeOf(file)
            const bucket = edges.get(from) ?? []
            for (const target of file.metrics.imports) {
                let targets: string[]
                if (file.metrics.language === 'go') targets = index.goDirs.has(target) ? [target] : []
                else if (index.measured.has(target)) targets = [target]
                else targets = index.pythonInDir.get(target) ?? []
                for (const node of targets) {
                    if (node === from) continue
                    bucket.push(node)
                    if (!edges.has(node)) edges.set(node, [])
                    const key = `${from}\u0000${node}`
                    if (!edgeLines.has(key)) edgeLines.set(key, file.importLines.get(target) ?? 1)
                }
            }
            edges.set(from, bucket)
        }
        cycles = findCycles(edges, logger)
        for (const cycle of cycles) {
            const first = cycle[0] ?? ''
            const second = cycle[1] ?? ''
            const line = edgeLines.get(`${first}\u0000${second}`) ?? 1
            const id = cycle.join(' -> ')
            violations.push(violationOf('cycle', first, id, line, cycle.length, 0, `导入环 ${id} -> ${first}（${cycle.length} 个模块，上限 0）`))
        }
    }

    violations.sort((left, right) => compareText(left.key, right.key))
    files.sort((left, right) => compareText(left.path, right.path))
    const sortedLanguages: Record<string, number> = {}
    for (const key of Object.keys(languages).sort(compareText)) sortedLanguages[key] = languages[key] as number

    return {
        cwd,
        files,
        violations,
        cycles,
        stats: { filesScanned: walk.visited, truncated: walk.truncated, languages: sortedLanguages, exempted },
    }
}

/** Measure one readable file; never throws (the caller degrades). */
function measureFile(rel: string, text: string, language: Language, index: WorkspaceIndex, standards: StandardsConfig): MeasuredFile {
    const lexed = lexSource(text, language)
    const lines = countLines(text)
    let functions: MeasuredFunction[] = []
    let ifBlocks: IfBlockMetric[] = []
    let exports = 0
    let maxDepth = 0
    let maxDepthLine = 1
    let raw: RawImport[] = []

    if (language === 'go') {
        const braces = braceStructure(lexed)
        functions = goFunctions(lexed, braces)
        raw = goImports(lexed)
        ifBlocks = braceIfBlocks(lexed, braces)
        exports = goExports(lexed, braces)
        maxDepth = braces.maxDepth
        maxDepthLine = braces.maxDepthLineIndex + 1
    } else if (language === 'ts' || language === 'js') {
        const braces = braceStructure(lexed)
        functions = tsFunctions(lexed, braces)
        raw = tsImports(lexed)
        ifBlocks = braceIfBlocks(lexed, braces)
        exports = tsExports(lexed, braces)
        maxDepth = braces.maxDepth
        maxDepthLine = braces.maxDepthLineIndex + 1
    } else {
        const structure = pyStructure(lexed)
        const python = analyzePythonFunctions(lexed, structure)
        functions = python.functions
        ifBlocks = python.ifBlocks
        raw = pythonImports(lexed, structure)
        exports = pythonExports(lexed, structure)
        maxDepth = structure.maxDepth
        maxDepthLine = structure.maxDepthLineIndex + 1
    }

    functions.sort((left, right) => left.line - right.line || left.endLine - right.endLine)

    const importLines = new Map<string, number>()
    for (const entry of raw) {
        let target: string | undefined
        if (language === 'go') target = resolveGo(index, entry.specifier)
        else if (language === 'ts' || language === 'js') target = resolveTs(index, rel, entry.specifier)
        else target = resolvePython(index, rel, entry)
        if (target === undefined || target === '') continue
        if (!importLines.has(target)) importLines.set(target, entry.line)
    }

    return {
        metrics: {
            path: rel,
            language,
            lines,
            functions: functions.map((fn) => ({ name: fn.name, line: fn.line, lines: fn.lines, depth: fn.depth, params: fn.params })),
            maxDepth,
            ifBlocks,
            exports,
            imports: [...importLines.keys()].sort(compareText),
        },
        functions,
        depthLine: maxDepthLine,
        importLines,
    }
}

// --- baseline ---------------------------------------------------------------

/**
 * Parse a frozen baseline.
 *
 * A malformed baseline reads as `undefined` ("no baseline"), never as an
 * exception, and never as "everything is accepted": the caller decides whether
 * that blocks. Duplicate keys collapse; the file's own order is preserved, so a
 * parse stays faithful to what the repository committed.
 * @param text - raw JSON.
 */
export function parseBaseline(text: string): BaselineFile | undefined {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return undefined
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as { version?: unknown; frozenAt?: unknown; note?: unknown; accepted?: unknown }
    if (record.version !== 1) return undefined
    if (typeof record.frozenAt !== 'string' || record.frozenAt === '') return undefined
    if (!Array.isArray(record.accepted)) return undefined
    const accepted: string[] = []
    for (const entry of record.accepted) {
        if (typeof entry !== 'string' || entry === '') continue
        if (!accepted.includes(entry)) accepted.push(entry)
    }
    return {
        version: 1,
        frozenAt: record.frozenAt,
        ...(typeof record.note === 'string' && record.note !== '' ? { note: record.note } : {}),
        accepted,
    }
}

/**
 * Split today's violations into "new" and "already accepted".
 *
 * The baseline exists so a repository that already violates its own standards
 * can still adopt the gate: only violations whose `key` is not accepted fail
 * it, and accepted keys that no longer occur come back as `fixed`, so the
 * baseline can shrink.
 * @param violations - today's measurement (any order; the input order is kept).
 * @param baseline - the frozen baseline, when one exists.
 */
export function compareToBaseline(
    violations: readonly Violation[],
    baseline: BaselineFile | undefined,
): { added: Violation[]; known: Violation[]; fixed: string[] } {
    const accepted = new Set(baseline?.accepted ?? [])
    const added: Violation[] = []
    const known: Violation[] = []
    for (const violation of violations) {
        if (accepted.has(violation.key)) known.push(violation)
        else added.push(violation)
    }
    const today = new Set(violations.map((violation) => violation.key))
    const fixed: string[] = []
    for (const key of baseline?.accepted ?? []) {
        if (!today.has(key) && !fixed.includes(key)) fixed.push(key)
    }
    return { added, known, fixed }
}

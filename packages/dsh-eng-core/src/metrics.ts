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
import { countLines, lineOfOffset, matchParen, regexCanStart, scanRegexEnd, scanTemplateEnd, skipSpace } from './metrics-text.js'
import type { Lexed, MeasuredFunction, StringLiteral } from './metrics-text.js'
import { bodyOpener, braceIndexAt, braceStructure, closerOf } from './metrics-braces.js'
import type { Braces } from './metrics-braces.js'
import { bodySpanOf, spanToMetric } from './metrics-bodies.js'
import type { FunctionForm } from './metrics-bodies.js'
import { braceIfBlocks, type IfBlockMetric } from './metrics-branch.js'
import { paramCount } from './metrics-params.js'
import type { LanguageAnalysis } from './metrics-analysis.js'
import { familyAnalysis, isBraceFamily } from './metrics-brace-languages.js'
import { rubyAnalysis } from './metrics-ruby.js'
import { findCycles } from './metrics-cycles.js'

/** One `if`/`else` block of a brace language (the measurement half lives in `metrics-branch.ts`). */
export type { IfBlockMetric }

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

/** Everything measured about one file. */
export interface FileMetrics {
    /** Workspace-relative. */
    path: string
    /** The analyser that measured it; `other` is the bucket for a file no analyser claims. */
    language: Language | 'other'
    lines: number
    functions: FunctionMetric[]
    maxDepth: number
    ifBlocks: IfBlockMetric[]
    exports: number
    /** Workspace-relative module paths this file imports (resolved when they point inside the workspace). */
    imports: string[]
    /**
     * Functions that were found but NOT reported because their span could not be
     * established (a body brace or bracket that does not pair). Absent when every
     * function paired.
     *
     * Such a function has no honest length, so the honest answer is to leave it
     * out and say how many were left out — not to run it to the end of the file
     * and report that number. That is exactly the bug this field exists for: a
     * 348-line function was reported as 1803 lines (its body closer had been
     * swallowed by a mis-lexed block comment, and the measurement fell back to
     * "the rest of the file").
     */
    skippedFunctions?: number
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
    /**
     * What each accepted key measured when it was accepted.
     *
     * Without this a ratchet is not a ratchet: `maxFileLines|a.go|(file)` accepted
     * at 420 lines would keep passing at 900. A baseline written before this
     * field existed simply has no magnitudes, and `compareToBaseline` then
     * accepts the key as-is (documented, and reported by the caller).
     */
    entries?: readonly { key: string; actual: number; limit: number }[]
}

// --- text helpers -----------------------------------------------------------

function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/** One quote-delimited literal: where its content is and where scanning resumes. */
interface QuotedLiteral {
    /** Offset of the first content character. */
    contentStart: number
    /** Offset just past the content (the closing quote, or the end of the file). */
    contentEnd: number
    /** Offset just past the closing quote (or the end of the file). */
    stop: number
}

/**
 * Scan the quote starting at `index`.
 *
 * Python triple quotes are recognised, and a backslash always escapes the next
 * character — so `'\''` and a line continuation inside a string both stay inside
 * the literal. This lives outside `lexSource` because that loop is at its depth
 * ratchet, and "where does this literal end" is a question with its own answer.
 * @param text - the whole source file.
 * @param index - offset of the opening quote.
 * @param python - whether triple-quoted strings apply.
 * @param char - the quote character (`"` or `'`).
 */
function scanQuotedLiteral(text: string, index: number, python: boolean, char: string): QuotedLiteral {
    const triple = python && text[index + 1] === char && text[index + 2] === char
    const contentStart = index + (triple ? 3 : 1)
    let cursor = contentStart
    let closed = false
    while (cursor < text.length) {
        const current = text[cursor] ?? ''
        if (current === '\\') {
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
    return { contentStart, contentEnd, stop }
}

/** Longest Rust escape this accepts (`'\u{1F600}'` is 10 characters). */
const RUST_ESCAPE_MAX_CHARS = 12

/**
 * Whether the `'` at `index` opens a Rust char literal rather than a lifetime.
 *
 * `'a'`, `'\n'` and `'\''` are char literals; the `'a` of `&'a str`, `Foo<'a>`
 * and `'static` is a lifetime. Lexically the difference is a closing quote
 * within one character (or one escape), which is exactly what this returns — so
 * a lifetime is never blanked as a string.
 * @param text - the whole source file.
 * @param index - offset of the quote.
 */
function rustCharLiteral(text: string, index: number): boolean {
    const next = text[index + 1]
    if (next === undefined) return false
    if (next !== '\\') return next !== "'" && text[index + 2] === "'"
    for (let cursor = index + 2; cursor < Math.min(text.length, index + RUST_ESCAPE_MAX_CHARS); cursor += 1) {
        const current = text[cursor]
        if (current === '\n') return false
        if (current === '\\') cursor += 1
        else if (current === "'") return true
    }
    return false
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
        // `#` comments: Python, Ruby, and PHP — where `#[` opens an ATTRIBUTE
        // (PHP 8), not a comment, so blanking it would delete the declaration it
        // decorates.
        const hashComment = python || language === 'ruby' || (language === 'php' && text[index + 1] !== '[')
        if (hashComment && char === '#') {
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
            const stop = scanRegexEnd(text, index)
            if (stop > 0) {
                blank(index, stop)
                index = stop
                continue
            }
        }
        if (!python && char === '`') {
            // A template literal is masked whole, holes included: its `${…}`
            // expressions are code, but no symbol is read out of them, and the
            // mask keeps every brace inside them out of the structure read below.
            //
            // Backslash escapes DO count, and this is load-bearing: `\`` is a
            // backtick INSIDE the literal, not its end. Reading it as the end left
            // the rest of the literal lying in "code", where a `/**` written in the
            // prose opened a block comment that ran to the next `*/` — swallowing
            // the real closing `}` of the enclosing function. That function then
            // measured to the end of the file: `askHuman` in
            // dsh-deploy-gate/src/tools.ts reported 1803 lines instead of 348.
            const stop = scanTemplateEnd(text, index)
            blank(index, stop)
            index = stop
            continue
        }
        if (char === '"' || char === "'") {
            if (language === 'rust' && char === "'" && !rustCharLiteral(text, index)) {
                // `'a` is a LIFETIME, not a string: reading it as one blanks the
                // rest of the signature (parameters included), and the function
                // then disappears from the measurement entirely.
                index += 1
                continue
            }
            const literal = scanQuotedLiteral(text, index, python, char)
            strings.push({ line: lineOf(index) + 1, value: text.slice(literal.contentStart, literal.contentEnd), start: literal.contentStart, end: literal.contentEnd })
            blank(index, literal.stop)
            index = literal.stop
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
    return { language, masked, lines, maskedLines, lineStarts, strings }
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

/** A raw import specifier as written in the source. */
interface RawImport {
    specifier: string
    /** 1-based line of the import statement. */
    line: number
    /** Python only: number of leading dots (0 = absolute). */
    level?: number
}

/** Rules-free result of analyzing one file: its language's measurement plus its imports. */
interface Analysis extends LanguageAnalysis {
    /** Import specifiers as written, before resolution. */
    raw: RawImport[]
}

// --- Go ---------------------------------------------------------------------

const GO_FUNC = /^\s*func\s+(?:\(\s*(?:([A-Za-z_]\w*)\s+)?\*?([A-Za-z_][\w.]*)\s*(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/
const GO_IMPORT_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"/
const GO_IMPORT_GROUP = /^\s*import\s*\(/

/** Functions of one Go file (methods are named `Type.Name`). */
function goFunctions(lexed: Lexed, braces: Braces): { functions: MeasuredFunction[]; skipped: number } {
    const functions: MeasuredFunction[] = []
    /** Functions whose body could not be paired, so no honest length exists. */
    let skipped = 0
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
        if (closeParen < 0) {
            // A declaration whose parameter list never closes cannot be measured.
            skipped += 1
            continue
        }
        const opener = bodyOpener(lexed.masked, closeParen + 1, braces)
        if (opener < 0) {
            // No body at all (an assembly stub) is not a measurement failure; a
            // body brace that does not pair is, and must not be invented.
            const candidate = braceIndexAt(braces, closeParen + 1)
            if (candidate >= 0 && closerOf(braces, candidate) < 0) skipped += 1
            continue
        }
        const closer = closerOf(braces, opener)
        if (closer < 0) {
            skipped += 1
            continue
        }
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
    return { functions, skipped }
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

/**
 * Exported top-level identifiers of one Go file.
 *
 * Every name a top-level `func`, `type`, `var` or `const` declares that starts
 * with an upper-case letter counts: methods too, both names of `var A, B = …`,
 * every spec of a grouped declaration (`var ( … )`, `const ( … )`, `type ( … )`)
 * and a spec whose names are separated from their type (`var FS embed.FS`,
 * `const Typed uint64 = 1`). Only DECLARED names count, so a continuation line
 * of a multi-line value is not a declaration of its own.
 */
function goExports(lexed: Lexed, braces: Braces): number {
    const maskedLines = lexed.maskedLines
    let count = 0
    let group = false
    let groupDepth = 0
    let parens = 0
    for (let line = 0; line < maskedLines.length; line += 1) {
        const maskedLine = maskedLines[line] ?? ''
        const lineDepth = parens
        parens += bracketDelta(maskedLine)
        if ((braces.depthBeforeLine[line] ?? 0) !== 0) continue
        if (maskedLine.trim() === '') continue
        if (group) {
            if (/^\s*\)/.test(maskedLine)) {
                group = false
                continue
            }
            // A spec that continues on an earlier line (`Value,` of a call) is
            // not a declaration, however upper-case its first word is.
            if (lineDepth > groupDepth) continue
            count += exportedNames(maskedLine)
            continue
        }
        if (/^\s*(?:var|const|type)\s*\(\s*$/.test(maskedLine)) {
            group = true
            groupDepth = parens
            continue
        }
        const value = /^\s*(?:var|const)\s+(.+)$/.exec(maskedLine)
        if (value !== null) {
            count += exportedNames(value[1] ?? '')
            continue
        }
        const named = /^\s*(?:type|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(maskedLine)
        if (named !== null && /^[A-Z]/.test(named[1] ?? '')) count += 1
    }
    return count
}

/** Net change of `(`/`[` nesting over one line. */
function bracketDelta(line: string): number {
    let delta = 0
    for (const char of line) {
        if (char === '(' || char === '[') delta += 1
        else if (char === ')' || char === ']') delta -= 1
    }
    return delta
}

/**
 * Uppercase-first names declared by one Go declaration (or grouped spec) line.
 *
 * The names are the leading identifier list — `A, B Type = …`, `C = 1`,
 * `FS embed.FS`, `Typed uint64 = 1` — so a comma-separated list counts once per
 * name and the type or value after it never contributes one.
 */
function exportedNames(text: string): number {
    const match = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(text)
    if (match === null) return 0
    let count = 0
    for (const name of (match[1] ?? '').split(',')) if (/^\s*[A-Z]/.test(name)) count += 1
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

/** Keywords that start a statement, so a declarator's `=` cannot lie past one. */
const STARTS_A_STATEMENT = /(?:^|[^\w$])(?:const|let|var|function|class|import|export|return|throw|if|for|while|switch|try)\b/

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

/** Bound on one `<…>` type-parameter list (longer than any real one, and finite). */
const TYPE_PARAMS_MAX_CHARS = 400

/**
 * Offset just past a `<…>` type-parameter list starting at `at`, or -1.
 *
 * `function identity<T>(…)` and `const pick = <T,>(…) => …` both hide their
 * parameter list behind one; a comparison (`a < b`) is rejected by the `(`
 * the caller requires right after the list.
 */
function skipTypeParams(masked: string, at: number): number {
    const stop = Math.min(masked.length, at + TYPE_PARAMS_MAX_CHARS)
    let depth = 0
    for (let index = at; index < stop; index += 1) {
        const char = masked[index] ?? ''
        if (char === '<') depth += 1
        else if (char === '>') {
            depth -= 1
            if (depth === 0) return index + 1
        } else if (char === ';') return -1
    }
    return -1
}

/**
 * Whether the `=>` at `arrow` belongs to a type annotation rather than to the
 * parameter list that ends at `from`.
 *
 * A return type may sit between a parameter list and its `=>` (`(a: T): T => a`)
 * and may itself contain an arrow (`: (x: T) => U`); a cast (`as (exec) => void`)
 * or a new statement (`… = (x) => x`) may not. Reading the next statement's
 * arrow as this function's body is what produced a phantom `listener` in a
 * real test file.
 */
function arrowIsInAType(masked: string, from: number, arrow: number): boolean {
    const between = maskGroups(masked.slice(from, arrow))
    // Only a return type may stand between the `)` and the `=>`: at the top
    // level a `;` ends the statement and an `=` starts another one, while the
    // `=` of an arrow (`: (x: T) => U`) does not.
    if (/(?:^|[^\w$])(?:as|satisfies)\s/.test(between)) return true
    return /[;]|=(?!>)/.test(between)
}

/** `text` with everything inside balanced `()`, `[]` and `{}` blanked out. */
function maskGroups(text: string): string {
    const chars = text.split('')
    let depth = 0
    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index]
        if (char === '(' || char === '[' || char === '{') {
            depth += 1
            chars[index] = ' '
        } else if (char === ')' || char === ']' || char === '}') {
            depth = Math.max(0, depth - 1)
            chars[index] = ' '
        } else if (depth > 0) chars[index] = ' '
    }
    return chars.join('')
}

/** Functions/classes/methods of one TS/JS file. */
function tsFunctions(lexed: Lexed, braces: Braces): { functions: MeasuredFunction[]; skipped: number } {
    const functions: MeasuredFunction[] = []
    const masked = lexed.masked
    /** Functions whose body could not be paired, so no honest length exists. */
    let skipped = 0

    /**
     * Record a function whose body starts at `from`; skip (and count) when its
     * span cannot be stated.
     *
     * The span itself is resolved in `metrics-bodies.ts`, because the rules there
     * (a declaration's return type must not be read as its body, an arrow may
     * have an expression body) are the difference between a length and a guess.
     */
    const record = (name: string, startLine: number, params: number, from: number, form: FunctionForm): void => {
        const span = bodySpanOf(masked, from, braces, form)
        const outcome = spanToMetric(lexed, braces, span, { name, startLine, params })
        if (outcome.kind === 'function') functions.push(outcome.metric)
        else if (outcome.kind === 'skipped') skipped += 1
    }

    /** The `(params)` right after `at` (an optional `<…>` type-parameter list may sit between), or undefined. */
    const paramsAt = (at: number): { open: number; close: number } | undefined => {
        let open = skipSpace(masked, at)
        if (masked[open] === '<') {
            const after = skipTypeParams(masked, open)
            if (after < 0) return undefined
            open = skipSpace(masked, after)
        }
        if (masked[open] !== '(') return undefined
        const close = matchParen(masked, open)
        if (close < 0) return undefined
        return { open, close }
    }

    /**
     * Record the arrow function an initializer starting at `from` declares.
     *
     * The initializer is unwrapped first, so `((a, b) => c) as T` reports the
     * arrow's own parameters (2, not 1) and the arrow's own body line instead of
     * running into the next statement's `=>`. Parentheses are a parameter list
     * when an `=>` follows them; otherwise they only wrap the function and the
     * search continues inside them (bounded by `limit`, the wrapper's closer).
     * @returns whether a function was recorded.
     */
    const recordArrow = (name: string, startLine: number, from: number, limit: number): boolean => {
        let cursor = from
        let bound = limit
        for (let step = 0; step < 8; step += 1) {
            if (masked[cursor] === '<') {
                const after = skipTypeParams(masked, cursor)
                if (after < 0) return false
                cursor = skipSpace(masked, after)
                continue
            }
            if (masked[cursor] !== '(') {
                const arrow = arrowAt(masked, cursor, bound)
                if (arrow < 0) return false
                if (!/^[A-Za-z_$][\w$]*$/.test(masked.slice(cursor, arrow).trim())) return false
                record(name, startLine, 1, arrow + 2, 'arrow')
                return true
            }
            const close = matchParen(masked, cursor)
            if (close < 0 || close > bound) return false
            const inner = skipSpace(masked, cursor + 1)
            // `((a, b) => c) as T`: parentheses that open with another `(`
            // and hold an arrow only WRAP the function, so the list inside
            // them is the real one. A parameter of function type
            // (`(event, listener: (…) => unknown)`) starts with a name and
            // is therefore read as the parameter list it is.
            if (inner < close && masked[inner] === '(' && arrowAt(masked, inner, close) >= 0) {
                cursor = inner
                bound = close
                continue
            }
            const arrow = arrowAt(masked, skipSpace(masked, close + 1), bound)
            if (arrow < 0 || arrowIsInAType(masked, close + 1, arrow)) return false
            record(name, startLine, paramCount(masked.slice(cursor + 1, close), true), arrow + 2, 'arrow')
            return true
        }
        return false
    }

    // 1. `function name(…)` declarations, nested ones included.
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const match = TS_FUNCTION.exec(lexed.maskedLines[line] ?? '')
        if (match === null) continue
        const start = lexed.lineStarts[line] ?? 0
        const params = paramsAt(start + match[0].length)
        if (params === undefined) continue
        record(match[1] ?? '', line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1, 'declaration')
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
                record(name(method[1] ?? ''), line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1, 'declaration')
                continue
            }
            const property = TS_PROPERTY.exec(maskedLine)
            if (property === null || TS_RESERVED.has(property[1] ?? '')) continue
            const after = skipSpace(masked, start + property[0].length)
            if (/^function\b/.test(masked.slice(after, after + 9))) {
                const params = paramsAt(after + 8)
                if (params === undefined) continue
                record(name(property[1] ?? ''), line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1, 'declaration')
                continue
            }
            recordArrow(name(property[1] ?? ''), line, start + property[0].length, start + 400)
        }
    }

    // 3. `const name = (…) => …` and `const name = function (…) …`.
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const decl = TS_DECL.exec(lexed.maskedLines[line] ?? '')
        if (decl === null) continue
        const start = lexed.lineStarts[line] ?? 0
        const assign = assignmentAt(masked, start + decl[0].length, start + 400)
        if (assign < 0) continue
        // `let x: T` with no initializer must not steal the NEXT statement's
        // `=` (that produced a phantom function named after the variable).
        if (STARTS_A_STATEMENT.test(maskGroups(masked.slice(start + decl[0].length, assign)))) continue
        const name = decl[2] ?? ''
        let cursor = skipSpace(masked, assign + 1)
        if (/^async\b/.test(masked.slice(cursor, cursor + 6))) cursor = skipSpace(masked, cursor + 5)
        if (/^function\b/.test(masked.slice(cursor, cursor + 9))) {
            const params = paramsAt(cursor + 8)
            if (params === undefined) continue
            record(name, line, paramCount(masked.slice(params.open + 1, params.close), true), params.close + 1, 'declaration')
            continue
        }
        recordArrow(name, line, cursor, Math.min(masked.length, assign + 400))
    }

    return { functions, skipped }
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

/** Deepest indentation level reached inside the block that follows `line`. */
function pythonDepth(structure: PyStructure, line: number, end: number, defLevel: number): number {
    let deepest = defLevel
    for (let cursor = line + 1; cursor <= end; cursor += 1) {
        if (structure.blank[cursor] === true || structure.continuation[cursor] === true) continue
        deepest = Math.max(deepest, structure.level[cursor] ?? defLevel)
    }
    return deepest
}

/** Functions and `if` blocks of one Python file. */
function analyzePythonFunctions(
    lexed: Lexed,
    structure: PyStructure,
): { functions: MeasuredFunction[]; ifBlocks: IfBlockMetric[]; skipped: number } {
    const functions: MeasuredFunction[] = []
    const ifBlocks: IfBlockMetric[] = []
    const stack: { width: number; name: string }[] = []
    /** Functions whose parameter list could not be paired, so no honest span exists. */
    let skipped = 0
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        if (structure.blank[line] === true || structure.continuation[line] === true) continue
        const maskedLine = lexed.maskedLines[line] ?? ''
        const width = structure.width[line] ?? 0
        while (stack.length > 0 && (stack[stack.length - 1]?.width ?? -1) >= width) stack.pop()

        const definition = PY_DEF.exec(maskedLine)
        if (definition !== null) {
            const name = definition[2] ?? ''
            const openParen = (lexed.lineStarts[line] ?? 0) + definition[0].length - 1
            const closeParen = matchParen(lexed.masked, openParen)
            // An unclosed parameter list means the file is malformed: no span, counted.
            if (closeParen < 0) {
                skipped += 1
                continue
            }
            const end = pythonBlockEnd(lexed, structure, line)
            const defLevel = Math.floor(width / structure.step + 1e-9)
            const deepest = pythonDepth(structure, line, end, defLevel)
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
    return { functions, ifBlocks, skipped }
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

/** The measured nodes one import points at (empty when the target is external or unmeasured). */
function targetsOf(index: WorkspaceIndex, file: MeasuredFile, target: string): string[] {
    if (file.metrics.language === 'go') return index.goDirs.has(target) ? [target] : []
    if (index.measured.has(target)) return [target]
    return index.pythonInDir.get(target) ?? []
}

/**
 * Build the import graph of the measured files: edges plus the line each edge
 * came from (so a cycle can name a place a person can open).
 *
 * Go nodes are package DIRECTORIES, every other language is file-grained — the
 * same convention the layer rules use.
 */
function buildEdges(index: WorkspaceIndex, measured: readonly MeasuredFile[]): { edges: Map<string, string[]>; edgeLines: Map<string, number> } {
    const edges = new Map<string, string[]>()
    const edgeLines = new Map<string, number>()
    const nodeOf = (file: MeasuredFile): string =>
        file.metrics.language === 'go' ? path.posix.dirname(file.metrics.path) : file.metrics.path
    for (const file of measured) {
        const from = nodeOf(file)
        const bucket = edges.get(from) ?? []
        for (const target of file.metrics.imports) {
            for (const node of targetsOf(index, file, target)) {
                if (node === from) continue
                bucket.push(node)
                if (!edges.has(node)) edges.set(node, [])
                const key = `${from}\u0000${node}`
                if (!edgeLines.has(key)) edgeLines.set(key, file.importLines.get(target) ?? 1)
            }
        }
        edges.set(from, bucket)
    }
    return { edges, edgeLines }
}


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
        const graph = buildEdges(index, measured)
        cycles = findCycles(graph.edges, logger)
        for (const cycle of cycles) {
            const first = cycle[0] ?? ''
            const second = cycle[1] ?? ''
            const line = graph.edgeLines.get(`${first}\u0000${second}`) ?? 1
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
/**
 * Everything language-specific about one lexed file, measured in one place.
 *
 * A file whose braces (or parameter list) do not pair still measures: the
 * functions that DO pair are reported, and the ones that do not are counted in
 * `skipped` instead of being given a length that runs to the end of the file.
 */
function analyzeSource(lexed: Lexed, language: Language): Analysis {
    if (language === 'go') {
        const braces = braceStructure(lexed)
        const go = goFunctions(lexed, braces)
        return {
            functions: go.functions,
            skipped: go.skipped,
            ifBlocks: braceIfBlocks(lexed, braces),
            exports: goExports(lexed, braces),
            raw: goImports(lexed),
            maxDepth: braces.maxDepth,
            maxDepthLine: braces.maxDepthLineIndex + 1,
        }
    }
    if (language === 'ts' || language === 'js') {
        const braces = braceStructure(lexed)
        const ts = tsFunctions(lexed, braces)
        return {
            functions: ts.functions,
            skipped: ts.skipped,
            ifBlocks: braceIfBlocks(lexed, braces),
            exports: tsExports(lexed, braces),
            raw: tsImports(lexed),
            maxDepth: braces.maxDepth,
            maxDepthLine: braces.maxDepthLineIndex + 1,
        }
    }
    if (language === 'ruby') return { ...rubyAnalysis(lexed), raw: [] }
    if (isBraceFamily(language)) return { ...familyAnalysis(lexed, language), raw: [] }
    const structure = pyStructure(lexed)
    const python = analyzePythonFunctions(lexed, structure)
    return {
        functions: python.functions,
        skipped: python.skipped,
        ifBlocks: python.ifBlocks,
        exports: pythonExports(lexed, structure),
        raw: pythonImports(lexed, structure),
        maxDepth: structure.maxDepth,
        maxDepthLine: structure.maxDepthLineIndex + 1,
    }
}

/** Measure one readable file; never throws (the caller degrades). */
function measureFile(rel: string, text: string, language: Language, index: WorkspaceIndex, standards: StandardsConfig): MeasuredFile {
    const lexed = lexSource(text, language)
    const lines = countLines(text)
    const analysis = analyzeSource(lexed, language)
    const { functions, ifBlocks, exports, maxDepth, raw } = analysis
    const maxDepthLine = analysis.maxDepthLine
    const skippedFunctions = analysis.skipped

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
            ...(skippedFunctions === 0 ? {} : { skippedFunctions }),
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
    const record = value as { version?: unknown; frozenAt?: unknown; note?: unknown; accepted?: unknown; entries?: unknown }
    if (record.version !== 1) return undefined
    if (typeof record.frozenAt !== 'string' || record.frozenAt === '') return undefined
    if (!Array.isArray(record.accepted)) return undefined
    const accepted: string[] = []
    for (const entry of record.accepted) {
        if (typeof entry !== 'string' || entry === '') continue
        if (!accepted.includes(entry)) accepted.push(entry)
    }
    // Magnitudes are optional (a baseline written before they existed has none),
    // but when present they are what makes a bigger violation fail.
    const entries: { key: string; actual: number; limit: number }[] = []
    if (Array.isArray(record.entries)) {
        for (const entry of record.entries as unknown[]) {
            if (typeof entry !== 'object' || entry === null) continue
            const record2 = entry as { key?: unknown; actual?: unknown; limit?: unknown }
            if (typeof record2.key !== 'string' || record2.key === '') continue
            if (typeof record2.actual !== 'number' || !Number.isFinite(record2.actual)) continue
            entries.push({
                key: record2.key,
                actual: record2.actual,
                limit: typeof record2.limit === 'number' && Number.isFinite(record2.limit) ? record2.limit : 0,
            })
        }
    }
    return {
        version: 1,
        frozenAt: record.frozenAt,
        ...(typeof record.note === 'string' && record.note !== '' ? { note: record.note } : {}),
        accepted,
        ...(entries.length === 0 ? {} : { entries }),
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
): { added: Violation[]; known: Violation[]; fixed: string[]; worsened: Violation[] } {
    const accepted = new Set(baseline?.accepted ?? [])
    const magnitude = new Map((baseline?.entries ?? []).map((entry) => [entry.key, entry.actual]))
    const added: Violation[] = []
    const known: Violation[] = []
    const worsened: Violation[] = []
    for (const violation of violations) {
        if (!accepted.has(violation.key)) {
            added.push(violation)
            continue
        }
        const acceptedAt = magnitude.get(violation.key)
        // Only "bigger than what we accepted" fails: shrinking is progress and is
        // never punished. A key with no recorded magnitude (an older baseline)
        // passes as before rather than inventing a limit.
        if (acceptedAt !== undefined && violation.actual > acceptedAt) worsened.push(violation)
        else known.push(violation)
    }
    const today = new Set(violations.map((violation) => violation.key))
    const fixed: string[] = []
    for (const key of baseline?.accepted ?? []) {
        if (!today.has(key) && !fixed.includes(key)) fixed.push(key)
    }
    return { added, known, fixed, worsened }
}

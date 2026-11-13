/**
 * Ruby — the language whose block ends with a KEYWORD, not a brace.
 *
 * Every other language in the suite pairs a visual delimiter (`{ … }`, an
 * indentation step); Ruby pairs `def`/`class`/`if`/… with `end`. Reading Ruby
 * with the brace lexer would give every function the same length (the rest of
 * the file), which is worse than not measuring it: a `maxFunctionLines`
 * threshold would then fire on every file, or — with a baseline — silently
 * accept one wrong number.
 *
 * The counting rules, and why each one exists:
 *
 *  - `def`, `class`, `module`, `case`, `begin`, `for` and `do` open a block.
 *  - `if`, `unless`, `while`, `until` open one only where a STATEMENT can start
 *    (line start, or after `=`, `(`, `,`, `;`, `then`, …). After a finished
 *    expression (`x if y`, `a += 1 while b`) they are MODIFIERS and open nothing
 *    — counting them was the way a one-line statement stole a later `end`.
 *  - `do` opens a block, EXCEPT on a line that already opened a `while`/`until`/
 *    `for` header (`while x do` is one block, not two).
 *  - `end` closes one. A one-line `if … then … end` therefore balances on its own
 *    line, and nesting is exactly the running balance.
 *  - A `def` whose header ends with `=` (Ruby 3's endless method) opens nothing:
 *    `def answer = 42` has no `end`, and assuming one would shift every later
 *    function by a block.
 *
 * Lexical limits, documented rather than hidden: `=begin`/`=end` block comments
 * and `__END__` data sections are not recognised, and a block opened inside a
 * string interpolation is already masked away (so it neither opens nor closes).
 *
 * @module dsh-eng-core/metrics-ruby
 */

import type { Lexed, MeasuredFunction } from './metrics-text.js'
import type { IfBlockMetric } from './metrics-branch.js'
import type { LanguageAnalysis } from './metrics-analysis.js'
import { rubyDefName, rubyEndless, rubyParams, rubyStatementStart, rubyTokens } from './metrics-ruby-lex.js'

/** Keywords that open a block. */
type RubyOpener = 'def' | 'class' | 'module' | 'if' | 'unless' | 'while' | 'until' | 'case' | 'begin' | 'do' | 'for'

const OPENERS: ReadonlySet<string> = new Set<RubyOpener>(['def', 'class', 'module', 'if', 'unless', 'while', 'until', 'case', 'begin', 'do', 'for'])

/** One block a Ruby file opened, with enough context to find its `end`. */
interface RubyScope {
    keyword: RubyOpener
    /** 0-based line of the opening keyword. */
    line: number
    /** Block depth BEFORE the opener. */
    depth: number
    /** `def`/`class`/`module` only. */
    name?: string
    /** `def name = expr` opens no block. */
    endless?: boolean
    /** Parameter count of a `def`, computed from its own tokens. */
    params?: number
}

/** Every block one line opens, plus how many `end`s it closes. */
function rubyLineScopes(maskedLine: string, line: number): { scopes: RubyScope[]; closed: number } {
    const tokens = rubyTokens(maskedLine)
    const scopes: RubyScope[] = []
    let closed = 0
    let previous = ''
    let loopHeader = false
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === 'end') {
            // `end` closes wherever it appears: `[…].map do |x| x end` leaves no
            // room for a statement boundary before it.
            closed += 1
            previous = token
            continue
        }
        // `do` is always a block opener when it is not part of a loop header on
        // this line (`items.each do |x|` follows a method call, so the
        // statement-start test does not apply); the other keywords need it
        // (otherwise `x.class` and `x if y` would open blocks).
        const modifier = token !== 'do' && !rubyStatementStart(previous)
        if (!OPENERS.has(token) || modifier || (token === 'do' && loopHeader)) {
            previous = token
            continue
        }
        const opener = token as RubyOpener
        if (opener === 'def') {
            scopes.push({ keyword: opener, line, depth: 0, name: rubyDefName(tokens, index), endless: rubyEndless(tokens, index), params: rubyParams(tokens, index) })
        } else if (opener === 'class' || opener === 'module') {
            const name = tokens[index + 1] ?? ''
            // `class << self` has no constant name; class/module names are constants.
            scopes.push({ keyword: opener, line, depth: 0, name: /^[A-Z]/.test(name) ? name : '' })
        } else {
            scopes.push({ keyword: opener, line, depth: 0 })
        }
        if (opener === 'while' || opener === 'until' || opener === 'for') loopHeader = true
        previous = token
    }
    return { scopes, closed }
}

/** Depth state of a Ruby file, one entry per line. */
interface RubyDepth {
    /** Depth before the line. */
    before: number[]
    /** Depth after the line. */
    after: number[]
    scopes: RubyScope[]
    maxDepth: number
    /** 0-based first line reaching `maxDepth`. */
    maxDepthLine: number
}

/** Walk a Ruby file once, recording block depth and every opened block. */
function rubyDepth(lexed: Lexed): RubyDepth {
    const before: number[] = []
    const after: number[] = []
    const scopes: RubyScope[] = []
    let depth = 0
    let maxDepth = 0
    let maxDepthLine = 0
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        before.push(depth)
        const result = rubyLineScopes(lexed.maskedLines[line] ?? '', line)
        for (const scope of result.scopes) {
            scope.depth = depth
            scopes.push(scope)
            if (scope.endless === true) continue
            depth += 1
            if (depth > maxDepth) {
                maxDepth = depth
                maxDepthLine = line
            }
        }
        depth = Math.max(0, depth - result.closed)
        after.push(depth)
    }
    return { before, after, scopes, maxDepth, maxDepthLine }
}

/** First line at or after `from` whose depth-after returns to `level`, or -1. */
function rubyEndOf(depth: RubyDepth, from: number, level: number): number {
    if ((depth.after[from] ?? level) === level) return from
    for (let line = from + 1; line < depth.after.length; line += 1) {
        if ((depth.after[line] ?? level) === level) return line
    }
    return -1
}

/**
 * Measure one Ruby file.
 * @param lexed - the masked file (comments and literals already blanked).
 */
export function rubyAnalysis(lexed: Lexed): LanguageAnalysis {
    const depth = rubyDepth(lexed)
    const functions: MeasuredFunction[] = []
    const ifBlocks: IfBlockMetric[] = []
    let skipped = 0
    let exports = 0
    for (const scope of depth.scopes) {
        const topLevel = (depth.before[scope.line] ?? 0) === 0
        if (scope.keyword === 'def') {
            const name = scope.name ?? ''
            if (topLevel && name !== '' && !name.startsWith('_')) exports += 1
            const end = scope.endless === true ? scope.line : rubyEndOf(depth, scope.line, scope.depth)
            if (end < 0) {
                skipped += 1
                continue
            }
            let deepest = 0
            for (let line = scope.line; line <= end; line += 1) deepest = Math.max(deepest, (depth.before[line] ?? 0) - scope.depth)
            functions.push({
                name,
                line: scope.line + 1,
                endLine: end + 1,
                lines: end - scope.line + 1,
                depth: Math.max(1, deepest),
                params: scope.params ?? 0,
            })
            continue
        }
        if (scope.keyword === 'if' || scope.keyword === 'unless') {
            const end = rubyEndOf(depth, scope.line, scope.depth)
            if (end > scope.line) ifBlocks.push({ line: scope.line + 1, lines: end - scope.line + 1, kind: 'if' })
            continue
        }
        if (topLevel && (scope.keyword === 'class' || scope.keyword === 'module') && /^[A-Z]/.test(scope.name ?? '')) exports += 1
    }
    return { functions, skipped, ifBlocks, exports, maxDepth: depth.maxDepth, maxDepthLine: depth.maxDepthLine + 1 }
}

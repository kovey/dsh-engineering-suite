/**
 * The brace-delimited languages: Rust, Java, Kotlin, C#, PHP and Swift.
 *
 * They share everything structural with Go/TS/JS — `{ … }` bodies, `if`/`else`
 * blocks, nesting depth — so the measurement reuses `metrics-braces.ts` and
 * `metrics-branch.ts` unchanged. What differs is only where a declaration
 * STARTS: `pub fn`, `public void`, `fun`, `func`, `function`.
 *
 * The one rule that keeps this honest is that a body is taken from the paired
 * `{` after the parameter list, and nothing is invented when there is none. A
 * bodyless declaration (a Java interface method, a Rust trait signature, a C#
 * expression-bodied member, a Kotlin expression body `fun f() = …`) is reported
 * as having no body rather than as a one-line function: "not measured" and
 * "one line long" are different facts, and only the first one is true.
 *
 * Known lexical limits (documented in the package README, not hidden here):
 * raw strings (`r#"…"#`), Swift multi-line `"""` strings, PHP heredocs and
 * nested block comments are read as ordinary literals/comments. The brace
 * pairing they could disturb is covered by the "unpairable → skipped" rule.
 *
 * @module dsh-eng-core/metrics-brace-languages
 */

import { braceStructure, braceIndexAt } from './metrics-braces.js'
import type { Braces } from './metrics-braces.js'
import { braceIfBlocks } from './metrics-branch.js'
import { spanToMetric } from './metrics-bodies.js'
import { lineOfOffset, matchParen } from './metrics-text.js'
import type { Lexed, MeasuredFunction } from './metrics-text.js'
import { paramCount } from './metrics-params.js'
import type { LanguageAnalysis } from './metrics-analysis.js'
import type { Language } from './languages.js'

/** The languages this module measures. */
export type BraceFamilyLanguage = 'rust' | 'java' | 'kotlin' | 'csharp' | 'php' | 'swift'

/** How one declaration head is recognised: the match ends at the `(` of its parameters. */
interface FunctionPattern {
    /** Anchored at the start of a line; ended by the parameter list's `(`. */
    pattern: RegExp
    /** Capture group holding the declared name. */
    name: number
    /** Capture group holding the text before the name (used to reject `new X()`). */
    prefix?: number
}

/**
 * Declaration heads per language.
 *
 * Every pattern ends with the `(` of the parameter list, so the parameter count
 * comes from the source text between real parentheses — never from a guess about
 * where the signature ends.
 */
const FUNCTION_PATTERNS: Record<BraceFamilyLanguage, readonly FunctionPattern[]> = {
    rust: [
        {
            pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^<>]*>\s*)?\(/,
            name: 1,
        },
    ],
    java: [
        {
            pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp|transient|volatile)\s+)*([A-Za-z_$][\w$.[\]<>,?\s]*\s+)?([A-Za-z_$][\w$]*)\s*\(/,
            name: 2,
            prefix: 1,
        },
    ],
    csharp: [
        {
            pattern: /^\s*(?:\[[^\]]*\]\s*)*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly|required)\s+)*([A-Za-z_$][\w$.[\]<>,?\s]*\s+)?([A-Za-z_$][\w$]*)\s*\(/,
            name: 2,
            prefix: 1,
        },
    ],
    kotlin: [
        {
            pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|final|abstract|override|suspend|inline|operator|infix|external|tailrec|data|sealed|enum|annotation|companion|value|lateinit|const|actual|expect)\s+)*fun\s+(?:<[^<>]*>\s*)?(?:(?:[A-Za-z_]\w*)\.)*([A-Za-z_]\w*)\s*\(/,
            name: 1,
        },
    ],
    php: [
        {
            pattern: /^\s*(?:(?:public|private|protected|static|abstract|final|readonly)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/,
            name: 1,
        },
    ],
    swift: [
        {
            pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate|open|static|class|final|override|mutating|nonmutating|convenience|required|dynamic|weak|unowned)\s+)*func\s+([A-Za-z_]\w*)\s*(?:<[^<>]*>\s*)?\(/,
            name: 1,
        },
        {
            pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate|open|static|class|final|override|convenience|required|dynamic)\s+)*init\s*(?:\?|!)?\s*\(/,
            name: 1,
        },
    ],
}

/** Names that look like a call but are keywords (compared as written). */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'else', 'do',
    'try', 'case', 'default', 'assert', 'super', 'this', 'await', 'yield', 'synchronized',
    'when', 'in', 'is', 'as', 'typeof', 'sizeof', 'delete', 'void', 'echo', 'print',
])

/**
 * Exported-declaration line patterns (one count per matching line).
 *
 * These are APPROXIMATIONS and are documented as such: Rust counts `pub` items,
 * Java/C# count `public` members, Swift counts `public`/`open`, PHP counts
 * `public function` and file-level `function`/`class`, Kotlin counts the
 * non-private top-level declarations it can recognise lexically. No language
 * here has a single "export" keyword the way TS does, so the number answers
 * "how big is the declared public surface", not "how many exports exist".
 */
const EXPORT_PATTERNS: Record<BraceFamilyLanguage, readonly RegExp[]> = {
    rust: [/^\s*pub(?:\([^)]*\))?\s+(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|const|static|type|mod|use)\b/],
    java: [/^\s*public\s+/],
    csharp: [/^\s*public\s+/],
    kotlin: [/^\s*(?!private\b|protected\b|internal\b)(?:fun|class|object|interface|typealias)\s+/],
    php: [/^\s*(?:public\s+)?(?:function|class|interface|trait|enum)\s+/],
    swift: [/^\s*(?:public|open)\s+/],
}

/** Longest signature region a body may sit behind (`throws`, `-> T`, `where`, `: base(...)`). */
const SIGNATURE_BODY_MAX_CHARS = 400
/** How many lines a signature may wrap before the file is treated as unmeasurable. */
const SIGNATURE_BODY_MAX_LINES = 12

/** Where the body of a declaration is, or why there is none. */
type SignatureBody = { kind: 'braced'; opener: number } | { kind: 'none' } | { kind: 'unpairable' }

/**
 * Find the body of a declaration from just past its parameter list.
 *
 * The region between `)` and `{` is the return type / `throws` / `where` clause,
 * and it is skipped by bracket depth instead of guessed: `<…>` is counted (Rust
 * and Kotlin put generics there), a `;` or a `}` means the declaration has no
 * body, and `=` (but not `=>`) means an expression body (C#/Kotlin) — which has
 * no braces to pair and is therefore not given a length.
 * @param lexed - the lexed file.
 * @param braces - its brace structure.
 * @param from - offset just past the parameter list's `)`.
 */
function signatureBody(lexed: Lexed, braces: Braces, from: number): SignatureBody {
    const masked = lexed.masked
    const startLine = lineOfOffset(lexed, from)
    const stopLine = Math.min(startLine + SIGNATURE_BODY_MAX_LINES, lexed.lineStarts.length - 1)
    const stop = Math.min(masked.length, Math.max(from + SIGNATURE_BODY_MAX_CHARS, lexed.lineStarts[stopLine] ?? masked.length))
    let depth = 0
    for (let index = from; index < stop; index += 1) {
        const char = masked[index] ?? ''
        if (char === '(' || char === '[' || char === '<') depth += 1
        else if (char === ')' || char === ']' || char === '>') depth = Math.max(0, depth - 1)
        else if (depth > 0) continue
        else if (char === '{') {
            const opener = braceIndexAt(braces, index)
            if (opener < 0 || (braces.offsets[opener] ?? -1) !== index) return { kind: 'unpairable' }
            return (braces.match[opener] ?? -1) < 0 ? { kind: 'unpairable' } : { kind: 'braced', opener }
        } else if (char === ';' || char === '}') return { kind: 'none' }
        else if (char === '=' && masked[index + 1] !== '>') return { kind: 'none' }
    }
    return { kind: 'none' }
}

/** What one declaration head produced. */
type HeadOutcome = { kind: 'none' } | { kind: 'skipped' } | { kind: 'measured'; metric: MeasuredFunction }

/**
 * Measure the declaration one pattern matched on one line, if any.
 *
 * The three outcomes are distinct on purpose: `none` (no declaration here, or a
 * bodyless one), `skipped` (a body exists but cannot be paired) and `measured`.
 * Collapsing them would turn "cannot be determined" into "one line long".
 */
function measureHead(lexed: Lexed, braces: Braces, line: number, maskedLine: string, rule: FunctionPattern): HeadOutcome {
    const match = rule.pattern.exec(maskedLine)
    if (match === null) return { kind: 'none' }
    const name = match[rule.name] ?? ''
    if (name === '' || RESERVED_NAMES.has(name)) return { kind: 'none' }
    const prefix = rule.prefix === undefined ? '' : match[rule.prefix] ?? ''
    // `new Foo() { … }` is an anonymous class body, not a method.
    if (/(?:^|[^\w$])new\s+$/.test(prefix)) return { kind: 'none' }
    const openParen = (lexed.lineStarts[line] ?? 0) + match[0].length - 1
    if (lexed.masked[openParen] !== '(') return { kind: 'none' }
    const closeParen = matchParen(lexed.masked, openParen)
    if (closeParen < 0) return { kind: 'skipped' }
    const body = signatureBody(lexed, braces, closeParen + 1)
    if (body.kind === 'unpairable') return { kind: 'skipped' }
    if (body.kind === 'none') return { kind: 'none' }
    const outcome = spanToMetric(lexed, braces, body, {
        name,
        startLine: line,
        params: paramCount(lexed.masked.slice(openParen + 1, closeParen), true),
    })
    if (outcome.kind === 'function') return { kind: 'measured', metric: outcome.metric }
    return outcome.kind === 'skipped' ? { kind: 'skipped' } : { kind: 'none' }
}

/** Functions of one brace-family file. */
function familyFunctions(lexed: Lexed, braces: Braces, language: BraceFamilyLanguage): { functions: MeasuredFunction[]; skipped: number } {
    const functions: MeasuredFunction[] = []
    let skipped = 0
    for (let line = 0; line < lexed.maskedLines.length; line += 1) {
        const maskedLine = lexed.maskedLines[line] ?? ''
        for (const rule of FUNCTION_PATTERNS[language]) {
            const outcome = measureHead(lexed, braces, line, maskedLine, rule)
            if (outcome.kind === 'measured') functions.push(outcome.metric)
            else if (outcome.kind === 'skipped') skipped += 1
            if (outcome.kind !== 'none') break
        }
    }
    return { functions, skipped }
}

/** Count of lines a language's declaration patterns recognise as public surface. */
function familyExports(lexed: Lexed, language: BraceFamilyLanguage): number {
    const patterns = EXPORT_PATTERNS[language]
    let count = 0
    for (const maskedLine of lexed.maskedLines) {
        if (patterns.some((pattern) => pattern.test(maskedLine))) count += 1
    }
    return count
}

/**
 * Measure one brace-family file.
 * @param lexed - the lexed file (its `language` must be one of this module's).
 * @param language - which member of the family it is.
 */
export function familyAnalysis(lexed: Lexed, language: BraceFamilyLanguage): LanguageAnalysis {
    const braces = braceStructure(lexed)
    const found = familyFunctions(lexed, braces, language)
    return {
        functions: found.functions,
        skipped: found.skipped,
        ifBlocks: braceIfBlocks(lexed, braces),
        exports: familyExports(lexed, language),
        maxDepth: braces.maxDepth,
        maxDepthLine: braces.maxDepthLineIndex + 1,
    }
}

/** Whether `language` is measured by this module (a type guard for the dispatcher). */
export function isBraceFamily(language: Language): language is BraceFamilyLanguage {
    return language === 'rust' || language === 'java' || language === 'kotlin' || language === 'csharp' || language === 'php' || language === 'swift'
}

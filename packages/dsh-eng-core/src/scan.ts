/**
 * Deterministic workspace scanning — the evidence half of bootstrapping.
 *
 * An EXISTING repository must be able to enter the engineering suite without
 * anybody hand-writing its specification and test design first. This module
 * walks the workspace and reports what is actually there: requirement
 * documents and the statements inside them, code symbols (functions, methods,
 * types, HTTP routes, CLI scripts), existing test cases, build files, and the
 * commands those files imply. A sibling module feeds the result into a model
 * call that drafts the specification and test design.
 *
 * Four rules make the output safe to consume:
 *
 *  1. **Read-only.** The scan never writes, never spawns a process and never
 *     touches the network; it is pure analysis of `cwd`.
 *  2. **Bounded.** At most `maxFiles` files are visited and files larger than
 *     `maxFileBytes` are skipped by `stat`, never read into memory, so a
 *     20 GB monorepo cannot hang or OOM the caller.
 *  3. **Never throwing.** A malformed file, an unreadable directory, a broken
 *     symlink or a symlink loop is skipped (logged at `debug`) and the scan
 *     still returns a result.
 *  4. **Deterministic.** Symbols, tests and documents are sorted by path
 *     (then by line), so two runs over the same workspace produce
 *     byte-identical results — which is what lets a reviewer diff a re-scan
 *     against the last one.
 *
 * It deliberately does NOT try to understand code: no parsing of expressions,
 * no type inference, no call graph. Symbols are the top-level declarations a
 * human would list, and the gap report compares *names* — the model call does
 * the judgement.
 *
 * @module dsh-eng-core/scan
 */

import fs from 'node:fs'
import path from 'node:path'
import { exists, listDir, readJson } from './io.js'
import { silentLogger, type Logger } from './log.js'
import type { SpecRecord, TestCase, TestDesign } from './types.js'

/** One requirement document found in the workspace. */
export interface RequirementDoc {
    /** Workspace-relative path. */
    path: string
    title?: string
    /** `readme` (README*), `docs` (docs/**), `spec` (an existing rendered spec), `other`. */
    kind: 'readme' | 'docs' | 'spec' | 'other'
    headings: { level: number; text: string; line: number }[]
    /** Candidate requirement statements: bullets/numbered items/short paragraphs under requirement-ish headings. */
    candidates: { text: string; line: number; heading?: string }[]
}

/** One declaration a human would name when describing the code. */
export interface CodeSymbol {
    path: string          // workspace-relative
    line: number
    kind: 'func' | 'method' | 'route' | 'cli' | 'main' | 'export' | 'type'
    name: string
    /** Route path, CLI command, receiver type, exported-ness, … — whatever the language offers. */
    detail?: string
}

/** One test file with the case names it declares. */
export interface TestEvidence {
    path: string
    cases: { name: string; line: number }[]
}

/** One command the workspace implies (mirrors `.dsh/quality-gate.json` entries). */
export interface SuggestedCommand {
    id: string; name: string; command: string; required: boolean; phase: 'gate' | 'lint'
}

/** Everything one scan observed. */
export interface ScanResult {
    cwd: string
    requirements: RequirementDoc[]
    symbols: CodeSymbol[]
    tests: TestEvidence[]
    buildFiles: string[]
    suggestedCommands: SuggestedCommand[]
    stats: { filesScanned: number; truncated: boolean; languages: Record<string, number> }
}

/** Bounds and inputs of {@link scanWorkspace}. */
export interface ScanOptions {
    cwd: string
    /** Default 4000. Stop the walk (and set `stats.truncated`) when exceeded. */
    maxFiles?: number
    /** Default 256 KiB: larger files are skipped, never read into memory. */
    maxFileBytes?: number
    /** Extra directory names to skip, on top of the defaults. */
    ignoreDirs?: readonly string[]
    logger?: Logger
}

/** What the scan misses that the suite needs. */
export interface GapReport {
    criteriaWithoutCases: { id: string; text: string }[]
    casesWithThinSteps: { id: string; reason: string }[]
    testsWithoutCriteria: { id: string; covers: string[] }[]
    uncoveredSymbols: { name: string; path: string; line: number; kind: CodeSymbol['kind'] }[]
    missingArtifacts: ('spec' | 'testDesign' | 'gateCommands')[]
}

// --- bounds -----------------------------------------------------------------

/** Directories never walked (plus `ScanOptions.ignoreDirs`). */
const DEFAULT_IGNORE_DIRS: readonly string[] = [
    'node_modules',
    '.git',
    '.dsh',
    'dist',
    'build',
    '.tmp',
    'vendor',
    '.venv',
    '__pycache__',
    'target',
    '.pnpm-store',
    // Toolchain caches and generated-output trees. Found on a real repository:
    // a Go module cache kept inside the workspace (`.gocache/mod/…`) held
    // 7800-line generated `.pb.go` files, so the standards distribution was
    // reporting the module cache instead of the project (p90 file length 1010
    // lines, max 7822) — a threshold set from that would gate nothing real.
    '.gocache',
    '.cache',
    '.gradle',
    '.m2',
    'coverage',
    '.next',
    '.nuxt',
    '.turbo',
    '.parcel-cache',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
]

/** Default bound on files visited by one walk (also used by `metrics.ts`). */
export const DEFAULT_MAX_FILES = 4000
/** Default per-file byte bound of one walk (also used by `metrics.ts`). */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024
/** More candidate statements than this per document is a dump, not a draft. */
const MAX_CANDIDATES_PER_DOC = 200
/** A paragraph longer than this is prose, not a requirement statement. */
const MAX_CANDIDATE_CHARS = 400
/** Statements shorter than this are headings-in-disguise ("TODO", "登录"). */
const MIN_CANDIDATE_CHARS = 8
/** `steps`/`expected` shorter than this cannot guide an implementer. */
const MIN_STEP_CHARS = 4
/** Bound of `GapReport.uncoveredSymbols` (the model gets the head, not a dump). */
const MAX_UNCOVERED_SYMBOLS = 100

// --- languages --------------------------------------------------------------

/** Languages the scanner understands (detected by extension). */
export type Language = 'go' | 'ts' | 'js' | 'python'

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
    '.go': 'go',
    '.ts': 'ts',
    '.tsx': 'ts',
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.py': 'python',
}

/** Root build/config files reported by a scan, in a stable (alphabetical) order. */
const BUILD_FILE_NAMES: readonly string[] = [
    'Cargo.toml',
    'Dockerfile',
    'Makefile',
    'go.mod',
    'go.sum',
    'package-lock.json',
    'package.json',
    'pnpm-lock.yaml',
    'pyproject.toml',
    'pytest.ini',
    'requirements.txt',
    'tsconfig.json',
    'yarn.lock',
]

// --- walk -------------------------------------------------------------------

function compareText(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

/** POSIX, workspace-relative form of `target` (the spelling every path uses). */
function relativeTo(cwd: string, target: string): string {
    return path.relative(cwd, target).split(path.sep).join('/')
}

/** The language of a workspace-relative path, or `undefined` when nothing analyzes it. */
export function languageOf(rel: string): Language | undefined {
    const base = path.posix.basename(rel).toLowerCase()
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return undefined
    return LANGUAGE_BY_EXTENSION[base.slice(dot)]
}

/**
 * Read a file only when it fits the byte bound.
 *
 * `stat` comes first on purpose: a 2 GB log named `x.go` must be skipped
 * without ever being read into memory. Exported because `metrics.ts` needs the
 * same bound with the same "never throw" contract.
 * @param file - absolute path.
 * @param maxFileBytes - files larger than this are skipped by `stat`.
 * @param logger - diagnostic sink for the skip.
 * @returns the text, or `undefined` when oversized/unreadable.
 */
export function readCapped(file: string, maxFileBytes: number, logger: Logger): string | undefined {
    try {
        const stat = fs.statSync(file)
        if (stat.size > maxFileBytes) {
            logger.debug(`scan: 跳过超大文件 ${file}（${stat.size} > ${maxFileBytes} 字节）`)
            return undefined
        }
        return fs.readFileSync(file, 'utf8')
    } catch (error) {
        logger.debug(`scan: 无法读取文件 ${file}`, error)
        return undefined
    }
}

/** The requirement-document role of a path, or `undefined` when it is not one. */
function requirementKindOf(rel: string): RequirementDoc['kind'] | undefined {
    const base = path.posix.basename(rel)
    if (!base.toLowerCase().endsWith('.md')) return undefined
    const dir = path.posix.dirname(rel)
    if (dir === '.dsh/specs') return 'spec'
    if (/^readme.*\.md$/i.test(base)) return 'readme'
    if (dir === 'docs' || dir.startsWith('docs/')) return 'docs'
    if (dir === '.') return 'other'
    return undefined
}

/** Whether a path is a test file for its language. */
function isTestPath(rel: string, language: Language): boolean {
    const base = path.posix.basename(rel)
    if (language === 'go') return base.endsWith('_test.go')
    const inTests = rel
        .split('/')
        .slice(0, -1)
        .some((part) => part === 'test' || part === 'tests' || part === '__tests__')
    if (language === 'python') {
        return inTests || /^test_.*\.py$/i.test(base) || /_test\.py$/i.test(base)
    }
    return inTests || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)
}

// --- requirement documents --------------------------------------------------

/**
 * Headings whose body is expected to state requirements.
 *
 * Both languages the suite is written in are covered: the Chinese words from
 * docs.md and their English aliases. ASCII terms are word-bounded so that
 * "mustard" is not a requirement heading.
 */
const REQUIREMENT_HEADING = /需求|功能|要求|目标|验收|\b(?:requirements?|features?|goals?|acceptance|must|should)\b/i

const HEADING_LINE = /^(#{1,6})\s+(.*)$/
const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const FENCE_LINE = /^\s*(```|~~~)/

/**
 * Parse one requirement document.
 *
 * Candidates are the list items and short paragraphs that sit under a
 * requirement-ish heading (an ancestor counts, so `### 子项` under `## 需求`
 * is scanned too). A document with no such heading at all falls back to its
 * list items: a README full of feature bullets but no `## 需求` still carries
 * requirements. Fenced code blocks are ignored, tables are not "paragraphs"
 * (a rendered spec's acceptance-criteria table belongs to the SpecRecord, not
 * to free text), and the result is trimmed, de-duplicated and capped.
 */
function parseRequirementDoc(rel: string, text: string, kind: RequirementDoc['kind']): RequirementDoc {
    const headings: RequirementDoc['headings'] = []
    const candidates: RequirementDoc['candidates'] = []
    const fallback: RequirementDoc['candidates'] = []
    // One de-duplication set per output list: the fallback list collects the
    // same items on the way past, and a shared set would mark them as seen
    // before the real list ever gets them.
    const seen = new Set<string>()
    const seenFallback = new Set<string>()
    const stack: { level: number; text: string; requirement: boolean }[] = []
    let paragraph: string[] = []
    let paragraphLine = 1
    let fence: string | undefined
    let matchedHeading = false

    const section = (): { heading?: string; requirement: boolean } => {
        const top = stack[stack.length - 1]
        if (top === undefined) return { requirement: false }
        return { heading: top.text, requirement: top.requirement }
    }

    const add = (
        raw: string,
        line: number,
        heading: string | undefined,
        into: RequirementDoc['candidates'],
        already: Set<string>,
    ): void => {
        const value = raw.replace(/\s+/g, ' ').trim()
        if (value.length < MIN_CANDIDATE_CHARS || value.length > MAX_CANDIDATE_CHARS) return
        if (into.length >= MAX_CANDIDATES_PER_DOC || already.has(value)) return
        already.add(value)
        into.push(heading === undefined ? { text: value, line } : { text: value, line, heading })
    }

    const flush = (): void => {
        if (paragraph.length === 0) return
        const joined = paragraph.join(' ')
        const line = paragraphLine
        paragraph = []
        const current = section()
        if (current.requirement) add(joined, line, current.heading, candidates, seen)
    }

    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').replace(/\s+$/, '')
        const lineNo = index + 1
        const fenceMatch = FENCE_LINE.exec(line)
        if (fenceMatch !== null) {
            if (fence === undefined) {
                flush()
                fence = fenceMatch[1]
            } else if (line.trim().startsWith(fence)) {
                fence = undefined
            }
            continue
        }
        if (fence !== undefined) continue

        const headingMatch = HEADING_LINE.exec(line)
        if (headingMatch !== null) {
            flush()
            const level = (headingMatch[1] ?? '#').length
            const headingText = (headingMatch[2] ?? '').trim()
            headings.push({ level, text: headingText, line: lineNo })
            while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop()
            const inherited = stack[stack.length - 1]?.requirement ?? false
            const requirement = REQUIREMENT_HEADING.test(headingText) || inherited
            if (requirement) matchedHeading = true
            stack.push({ level, text: headingText, requirement })
            continue
        }
        if (line.trim() === '') {
            flush()
            continue
        }

        const itemMatch = LIST_ITEM_LINE.exec(line)
        if (itemMatch !== null) {
            flush()
            const body = itemMatch[1] ?? ''
            const current = section()
            add(body, lineNo, current.heading, fallback, seenFallback)
            if (current.requirement) add(body, lineNo, current.heading, candidates, seen)
            continue
        }

        const trimmed = line.trim()
        // Tables and HTML comments are structure, not statements.
        if (trimmed.startsWith('|') || trimmed.startsWith('<!--')) {
            flush()
            continue
        }
        if (paragraph.length === 0) paragraphLine = lineNo
        paragraph.push(trimmed.replace(/^>\s?/, ''))
    }
    flush()

    const chosen = matchedHeading ? candidates : fallback
    const doc: RequirementDoc = { path: rel, kind, headings, candidates: chosen }
    const title = headings.find((heading) => heading.level === 1)?.text ?? headings[0]?.text
    if (title !== undefined) doc.title = title
    return doc
}

// --- Go ---------------------------------------------------------------------

const GO_METHOD = /^func\s*\(\s*(?:\w+\s+)?\*?([A-Za-z_][\w.]*)\s*(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*\(/
const GO_FUNC = /^func\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/
const GO_TYPE_STRUCT = /^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s+(struct|interface|func|map|chan)\b/
const GO_TYPE_ALIAS = /^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*=/
const GO_TYPE_DEFINED = /^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s+[A-Za-z_*\[]/
/**
 * `mux.HandleFunc("/x", handler)` — the path must be a literal starting with
 * `/` and must not contain whitespace. Both conditions matter in the wild:
 * a path literal is the only thing a regex can trust, and without the verb
 * allowlist a call such as `g.P("//go:build x")` in a code generator looks
 * exactly like a route registration.
 */
const GO_ROUTE = /^\s*([A-Za-z_]\w*)\.([A-Za-z]\w*)\s*\(\s*"(\/[^\s"]*)"\s*(?:,\s*([A-Za-z_][\w.]*)\s*)?/
/** Selector names that register an HTTP route (compared case-insensitively). */
const ROUTE_VERBS = new Set([
    'handle', 'handlefunc', 'handler', 'handlerfunc',
    'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'any', 'route',
])

function isRouteVerb(verb: string): boolean {
    return ROUTE_VERBS.has(verb.toLowerCase())
}
const GO_RUN = /\bt\.Run\(\s*"((?:[^"\\]|\\.)*)"/
const GO_TABLE_NAME = /^\s*\{?\s*(?:[A-Za-z_]\w*\.)?name:\s*"((?:[^"\\]|\\.)*)"/

function exportedOf(name: string): string {
    return /^[A-Z]/.test(name) ? 'exported' : 'unexported'
}

/** A route symbol is named after its handler when the handler is a plain name. */
function routeName(handler: string | undefined, fallback: string): string {
    if (handler === undefined) return fallback
    if (handler === 'func' || handler === 'function' || handler === 'async' || handler === 'new') return fallback
    return handler
}

function scanGoSymbols(rel: string, text: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const lineNo = index + 1
        const method = GO_METHOD.exec(line)
        if (method !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'method', name: method[2] ?? '', detail: method[1] ?? '' })
            continue
        }
        const func = GO_FUNC.exec(line)
        if (func !== null) {
            const name = func[1] ?? ''
            symbols.push(
                name === 'main'
                    ? { path: rel, line: lineNo, kind: 'main', name, detail: 'entrypoint' }
                    : { path: rel, line: lineNo, kind: 'func', name, detail: exportedOf(name) },
            )
            continue
        }
        const typed = GO_TYPE_STRUCT.exec(line)
        if (typed !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: typed[1] ?? '', detail: typed[2] ?? 'type' })
            continue
        }
        const alias = GO_TYPE_ALIAS.exec(line)
        if (alias !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: alias[1] ?? '', detail: 'alias' })
            continue
        }
        const defined = GO_TYPE_DEFINED.exec(line)
        if (defined !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: defined[1] ?? '', detail: 'defined' })
            continue
        }
        const route = GO_ROUTE.exec(line)
        if (route !== null && isRouteVerb(route[2] ?? '')) {
            symbols.push({
                path: rel,
                line: lineNo,
                kind: 'route',
                name: routeName(route[4], `${route[1]}.${route[2]}`),
                detail: route[3] ?? '',
            })
        }
    }
    return symbols
}

// --- TypeScript / JavaScript ------------------------------------------------

const JS_FUNCTION = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
const JS_CLASS = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const JS_TYPE = /^\s*export\s+(interface|type|enum)\s+([A-Za-z_$][\w$]*)/
const JS_VALUE = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
const JS_ROUTE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(\/[^\s'"`]*)\3\s*(?:,\s*([A-Za-z_$][\w$.]*)\s*)?/
const JS_TEST = /(?:^|[^\w$.])(?:test|it|describe)(?:\.\w+)*\s*\(\s*(['"`])((?:[^'"`\\]|\\.)*?)\1/

function scanJavaScriptSymbols(rel: string, text: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const lineNo = index + 1
        const func = JS_FUNCTION.exec(line)
        if (func !== null) {
            const name = func[1] ?? ''
            symbols.push({ path: rel, line: lineNo, kind: 'func', name, detail: exportedOf(name) })
            continue
        }
        const klass = JS_CLASS.exec(line)
        if (klass !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: klass[1] ?? '', detail: 'class' })
            continue
        }
        const typed = JS_TYPE.exec(line)
        if (typed !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: typed[2] ?? '', detail: typed[1] ?? 'type' })
            continue
        }
        const value = JS_VALUE.exec(line)
        if (value !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'export', name: value[1] ?? '', detail: 'exported' })
            continue
        }
        const route = JS_ROUTE.exec(line)
        if (route !== null) {
            symbols.push({
                path: rel,
                line: lineNo,
                kind: 'route',
                name: routeName(route[5], `${route[1]}.${route[2]}`),
                detail: route[4] ?? '',
            })
        }
    }
    return symbols
}

/** One `cli` symbol per `package.json` script, with the script's line number. */
function scanPackageScripts(file: string, rel: string, text: string): CodeSymbol[] {
    const parsed = readJson<{ scripts?: Record<string, unknown> }>(file)
    const scripts = parsed?.scripts
    if (scripts === undefined || typeof scripts !== 'object' || scripts === null) return []
    const symbols: CodeSymbol[] = []
    for (const name of Object.keys(scripts).sort(compareText)) {
        const command = scripts[name]
        const line = lineOfKey(text, name)
        symbols.push({
            path: rel,
            line,
            kind: 'cli',
            name,
            detail: typeof command === 'string' ? command : undefined,
        })
    }
    return symbols
}

/** 1-based line of `"key":` in a JSON text; 1 when it cannot be located. */
function lineOfKey(text: string, key: string): number {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`"${escaped}"\\s*:`).exec(text)
    if (match === null) return 1
    let line = 1
    for (let index = 0; index < match.index; index += 1) {
        if (text[index] === '\n') line += 1
    }
    return line
}

// --- Python -----------------------------------------------------------------

const PY_DEF = /^def\s+([A-Za-z_]\w*)\s*\(/
const PY_ASYNC_DEF = /^async\s+def\s+([A-Za-z_]\w*)\s*\(/
const PY_CLASS = /^class\s+([A-Za-z_]\w*)/
const PY_ROUTE = /^\s*@([\w.]+)\.(route|get|post|put|patch|delete|head|options)\s*\(\s*['"](\/[^\s'"]+)['"]/
const PY_HANDLER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
const PY_TEST = /^\s*(?:async\s+)?def\s+(test|test_\w*)\s*\(/

function scanPythonSymbols(rel: string, text: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const lineNo = index + 1
        const route = PY_ROUTE.exec(line)
        if (route !== null) {
            // A decorator sits directly above its handler: borrowing that name
            // gives the route a name a human recognises.
            let handler: string | undefined
            for (let look = index + 1; look < Math.min(index + 6, lines.length); look += 1) {
                const next = lines[look] ?? ''
                if (next.trim() === '' || next.trim().startsWith('@') || next.trim().startsWith('#')) continue
                handler = PY_HANDLER.exec(next)?.[1]
                break
            }
            symbols.push({
                path: rel,
                line: lineNo,
                kind: 'route',
                name: routeName(handler, `${route[1]}.${route[2]}`),
                detail: route[3] ?? '',
            })
            continue
        }
        const def = PY_ASYNC_DEF.exec(line) ?? PY_DEF.exec(line)
        if (def !== null) {
            const name = def[1] ?? ''
            symbols.push({ path: rel, line: lineNo, kind: 'func', name, detail: exportedOf(name) })
            continue
        }
        const klass = PY_CLASS.exec(line)
        if (klass !== null) {
            symbols.push({ path: rel, line: lineNo, kind: 'type', name: klass[1] ?? '', detail: 'class' })
        }
    }
    return symbols
}

// --- test cases -------------------------------------------------------------

/** Case names, de-duplicated, empty names dropped, in file order. */
function caseList(found: { name: string; line: number }[]): { name: string; line: number }[] {
    const seen = new Set<string>()
    const cases: { name: string; line: number }[] = []
    for (const entry of found) {
        const name = entry.name.trim()
        if (name === '' || seen.has(name)) continue
        seen.add(name)
        cases.push({ name, line: entry.line })
    }
    return cases.sort((left, right) => left.line - right.line)
}

function extractGoCases(text: string): { name: string; line: number }[] {
    const found: { name: string; line: number }[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const run = GO_RUN.exec(line)
        if (run !== null) found.push({ name: run[1] ?? '', line: index + 1 })
        const table = GO_TABLE_NAME.exec(line)
        if (table !== null) found.push({ name: table[1] ?? '', line: index + 1 })
    }
    return caseList(found)
}

function extractJavaScriptCases(text: string): { name: string; line: number }[] {
    const found: { name: string; line: number }[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const match = JS_TEST.exec(lines[index] ?? '')
        if (match !== null) found.push({ name: match[2] ?? '', line: index + 1 })
    }
    return caseList(found)
}

function extractPythonCases(text: string): { name: string; line: number }[] {
    const found: { name: string; line: number }[] = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const match = PY_TEST.exec(lines[index] ?? '')
        if (match !== null) found.push({ name: match[1] ?? '', line: index + 1 })
    }
    return caseList(found)
}

// --- suggested commands -----------------------------------------------------

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory()
    } catch {
        return false
    }
}

function command(id: string, name: string, text: string, required: boolean, phase: 'gate' | 'lint'): SuggestedCommand {
    return { id, name, command: text, required, phase }
}

/**
 * The commands this workspace implies, mirroring `scripts/project-config.sh`:
 * the same detection order, the same command lines and the same labels, so a
 * suggestion can be written into `.dsh/quality-gate.json` unchanged. Late
 * entries are unreachable in practice, but the order is what makes the pick
 * unambiguous when a repository carries several ecosystems.
 *
 * Two invariants: nothing is emitted that was not detected in the workspace,
 * and `lint` is never required (a missing lint script must not block delivery).
 */
function suggestCommands(cwd: string, logger: Logger): SuggestedCommand[] {
    const has = (name: string): boolean => exists(path.join(cwd, name))

    if (has('Cargo.toml')) {
        return [
            command('test', '单元测试', 'cargo test', true, 'gate'),
            command('lint', 'lint', 'cargo clippy -- -D warnings', false, 'lint'),
        ]
    }
    if (has('go.mod')) {
        return [
            command('test', '单元测试', 'go test ./...', true, 'gate'),
            command('lint', 'lint', 'go vet ./...', false, 'lint'),
        ]
    }
    if (has('pyproject.toml') || has('pytest.ini') || isDirectory(path.join(cwd, 'tests'))) {
        const commands = [command('test', '单元测试', 'pytest -q', true, 'gate')]
        const pyproject = has('pyproject.toml')
            ? readCapped(path.join(cwd, 'pyproject.toml'), DEFAULT_MAX_FILE_BYTES, logger)
            : undefined
        if (pyproject !== undefined && /ruff/i.test(pyproject)) {
            commands.push(command('lint', 'lint', 'ruff check .', false, 'lint'))
        }
        return commands
    }
    if (has('pnpm-lock.yaml')) {
        return [
            command('test', '单元测试', 'pnpm test', true, 'gate'),
            command('lint', 'lint', 'pnpm run lint', false, 'lint'),
        ]
    }
    if (has('yarn.lock')) {
        return [command('test', '单元测试', 'yarn test', true, 'gate')]
    }
    if (has('package.json')) {
        return [
            command('test', '单元测试', 'npm test', true, 'gate'),
            command('lint', 'lint', 'npm run lint', false, 'lint'),
        ]
    }
    if (has('Makefile')) {
        const makefile = readCapped(path.join(cwd, 'Makefile'), DEFAULT_MAX_FILE_BYTES, logger)
        if (makefile !== undefined && /^test:/m.test(makefile)) {
            return [command('test', '单元测试', 'make test', true, 'gate')]
        }
    }
    return []
}

// --- walk -------------------------------------------------------------------

/** One regular file a walk visited. */
export interface WalkedFile {
    /** Absolute path. */
    abs: string
    /** Workspace-relative POSIX path. */
    rel: string
}

/** What one {@link walkWorkspace} run visited. */
export interface WalkResult {
    /** Regular files in breadth-first, sorted-per-directory order. */
    files: WalkedFile[]
    /** Entries consumed from the budget: regular files plus broken symlinks. */
    visited: number
    /** Whether the `maxFiles` budget stopped the walk. */
    truncated: boolean
}

/** Bounds and inputs of {@link walkWorkspace}. */
export interface WalkOptions {
    cwd: string
    /** Default {@link DEFAULT_MAX_FILES}. */
    maxFiles?: number
    /** Extra directory names to skip, on top of the defaults. */
    ignoreDirs?: readonly string[]
    logger?: Logger
}

/**
 * Walk a workspace and return every regular file, without reading any of them.
 *
 * This is the ONE traversal of the package: `scanWorkspace` and
 * `measureWorkspace` both go through it, so a bound fixed here is fixed
 * everywhere. Breadth-first, each directory's entries sorted, symlinked
 * directories never followed (a loop is therefore harmless), broken symlinks
 * counted but skipped, unreadable directories skipped with a `debug` line.
 * @param options - workspace root, the `maxFiles` budget and extra ignore dirs.
 * @returns the files, how many entries the budget consumed, and whether it ran out.
 */
export function walkWorkspace(options: WalkOptions): WalkResult {
    const cwd = path.resolve(options.cwd)
    const logger = options.logger ?? silentLogger
    const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_MAX_FILES)
    const ignoreDirs = new Set<string>([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])])

    const files: WalkedFile[] = []
    let visited = 0
    let truncated = false

    // Breadth-first, deterministic: each directory's entries are sorted, and
    // every directory of one level is expanded before the next level — so the
    // budget lands on the structural files first (README, configs, entry
    // points, the shallow source tree) instead of being eaten by one deep data
    // directory. Symbolic links to directories are never followed, which is
    // what makes a loop harmless.
    const queue: string[] = [cwd]
    let cursor = 0
    let stopped = false
    while (cursor < queue.length && !stopped) {
        const dir = queue[cursor] as string
        cursor += 1
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch (error) {
            logger.debug(`scan: 无法读取目录 ${relativeTo(cwd, dir)}，已跳过`, error)
            continue
        }
        entries.sort((left, right) => compareText(left.name, right.name))
        for (const entry of entries) {
            if (visited >= maxFiles) {
                truncated = true
                stopped = true
                break
            }
            const abs = path.join(dir, entry.name)
            const rel = relativeTo(cwd, abs)
            let directory = false
            let file = false
            if (entry.isSymbolicLink()) {
                let target: fs.Stats
                try {
                    target = fs.statSync(abs)
                } catch (error) {
                    logger.debug(`scan: 断链符号链接 ${rel}，已跳过`, error)
                    visited += 1
                    continue
                }
                if (target.isDirectory()) {
                    logger.debug(`scan: 不跟随符号链接目录 ${rel}`)
                    continue
                }
                file = target.isFile()
            } else {
                directory = entry.isDirectory()
                file = entry.isFile()
            }
            if (directory) {
                if (!ignoreDirs.has(entry.name)) queue.push(abs)
                continue
            }
            if (!file) continue
            visited += 1
            files.push({ abs, rel })
        }
    }

    if (truncated) logger.debug(`scan: 达到 maxFiles=${maxFiles}，结果已截断`)
    return { files, visited, truncated }
}

// --- scan -------------------------------------------------------------------

/**
 * Scan one workspace for the evidence a bootstrapping run needs.
 *
 * The scan is read-only, bounded and never throws: every problem (unreadable
 * directory, broken symlink, oversized or malformed file) is skipped, logged
 * at `debug`, and reflected in `stats.filesScanned`.
 * @param options - workspace root plus the `maxFiles`/`maxFileBytes` bounds.
 * @returns requirements, symbols, tests, build files, implied commands and stats.
 */
export function scanWorkspace(options: ScanOptions): ScanResult {
    const cwd = path.resolve(options.cwd)
    const logger = options.logger ?? silentLogger
    const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_MAX_FILES)
    const maxFileBytes = Math.max(0, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)

    const requirements: RequirementDoc[] = []
    const symbols: CodeSymbol[] = []
    const tests: TestEvidence[] = []
    const languages: Record<string, number> = {}
    let truncated = false

    /** Classify and parse one regular file; never throws. */
    const visit = (abs: string, rel: string): void => {
        const language = languageOf(rel)
        if (language !== undefined) languages[language] = (languages[language] ?? 0) + 1
        try {
            const docKind = requirementKindOf(rel)
            if (docKind !== undefined) {
                const text = readCapped(abs, maxFileBytes, logger)
                if (text !== undefined) requirements.push(parseRequirementDoc(rel, text, docKind))
                return
            }
            if (language === undefined) return
            const text = readCapped(abs, maxFileBytes, logger)
            if (text === undefined) return

            if (language === 'go') {
                // A test file is evidence of coverage, not of the API surface.
                // It is listed even when no *named* case is found: "347 test
                // files, 292 named cases" is evidence, "45 test files" is a lie.
                if (isTestPath(rel, 'go')) {
                    tests.push({ path: rel, cases: extractGoCases(text) })
                    return
                }
                symbols.push(...scanGoSymbols(rel, text))
                return
            }

            if (isTestPath(rel, language)) {
                const cases = language === 'python' ? extractPythonCases(text) : extractJavaScriptCases(text)
                tests.push({ path: rel, cases })
            }
            if (language === 'python') symbols.push(...scanPythonSymbols(rel, text))
            else symbols.push(...scanJavaScriptSymbols(rel, text))
        } catch (error) {
            // Belt and braces: a scanner bug must degrade to a missing file,
            // never to a failed scan.
            logger.debug(`scan: 解析 ${rel} 失败，已跳过`, error)
        }
    }

    // The traversal itself lives in `walkWorkspace` so that `metrics.ts`
    // measures with the exact same bounds (and so there is only one place
    // where the sandbox/ignore rules can drift).
    const walk = walkWorkspace({
        cwd,
        maxFiles,
        ...(options.ignoreDirs === undefined ? {} : { ignoreDirs: options.ignoreDirs }),
        logger,
    })
    let filesScanned = walk.visited
    truncated = walk.truncated
    for (const entry of walk.files) visit(entry.abs, entry.rel)

    // `.dsh` is never walked (the whole engineering trail is off-limits to a
    // code scan), but an existing rendered spec IS the strongest requirement
    // evidence there is, so `.dsh/specs/*.md` is probed directly.
    const specsDir = path.join(cwd, '.dsh', 'specs')
    for (const name of [...listDir(specsDir)].sort(compareText)) {
        if (!name.toLowerCase().endsWith('.md')) continue
        if (filesScanned >= maxFiles) {
            truncated = true
            break
        }
        filesScanned += 1
        const abs = path.join(specsDir, name)
        const rel = relativeTo(cwd, abs)
        try {
            const text = readCapped(abs, maxFileBytes, logger)
            if (text !== undefined) requirements.push(parseRequirementDoc(rel, text, 'spec'))
        } catch (error) {
            logger.debug(`scan: 解析 ${rel} 失败，已跳过`, error)
        }
    }

    const packageJson = path.join(cwd, 'package.json')
    if (exists(packageJson)) {
        try {
            const text = readCapped(packageJson, maxFileBytes, logger)
            if (text !== undefined) symbols.push(...scanPackageScripts(packageJson, 'package.json', text))
        } catch (error) {
            logger.debug('scan: 解析 package.json 失败，已跳过', error)
        }
    }

    requirements.sort((left, right) => compareText(left.path, right.path))
    symbols.sort((left, right) => compareText(left.path, right.path) || left.line - right.line)
    tests.sort((left, right) => compareText(left.path, right.path))
    for (const evidence of tests) evidence.cases.sort((left, right) => left.line - right.line)

    const sortedLanguages: Record<string, number> = {}
    for (const key of Object.keys(languages).sort(compareText)) sortedLanguages[key] = languages[key] as number

    if (truncated) logger.debug(`scan: 达到 maxFiles=${maxFiles}，结果已截断`)

    return {
        cwd,
        requirements,
        symbols,
        tests,
        buildFiles: BUILD_FILE_NAMES.filter((name) => exists(path.join(cwd, name))),
        suggestedCommands: suggestCommands(cwd, logger),
        stats: { filesScanned, truncated, languages: sortedLanguages },
    }
}

// --- gap report -------------------------------------------------------------

/** Why one designed test case cannot guide an implementer, or `''`. */
function thinReason(testCase: TestCase): string {
    const steps = typeof testCase.steps === 'string' ? testCase.steps.trim() : ''
    const expected = typeof testCase.expected === 'string' ? testCase.expected.trim() : ''
    const reasons: string[] = []
    if (steps === '') reasons.push('steps 为空')
    else if (steps.length < MIN_STEP_CHARS) reasons.push(`steps 仅 ${steps.length} 字符（<${MIN_STEP_CHARS}）`)
    if (expected === '') reasons.push('expected 为空')
    else if (expected.length < MIN_STEP_CHARS) reasons.push(`expected 仅 ${expected.length} 字符（<${MIN_STEP_CHARS}）`)
    return reasons.join('；')
}

function coversOf(testCase: TestCase): string[] {
    return Array.isArray(testCase.covers) ? testCase.covers.filter((id): id is string => typeof id === 'string') : []
}

/**
 * Compare a scan against the current mission artifacts.
 *
 * Every branch answers one question the bootstrapping call has to resolve:
 * which acceptance criteria still need cases, which designed cases are too
 * thin to implement, which cases cover nothing the specification declares,
 * which code symbols no test or requirement statement mentions, and which
 * artifacts are missing entirely. Pure computation: the scan and the records
 * are inputs, nothing is written.
 *
 * Note the literal reading of "covers nothing the spec declares": with no
 * specification at all, no case covers anything declared, so every case is
 * listed (and `missingArtifacts` says why).
 * @param input - the scan plus the mission's spec and test design, when they exist.
 */
export function scanGaps(input: { scan: ScanResult; spec?: SpecRecord; testDesign?: TestDesign }): GapReport {
    const { scan, spec, testDesign } = input
    // Mission records come from JSON on disk, so a hand-edited artifact can
    // carry anything: shape is checked before it is iterated.
    const criteria = Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : []
    const declared = new Map<string, string>()
    for (const criterion of criteria) declared.set(criterion.id, criterion.text)
    const cases: readonly TestCase[] = Array.isArray(testDesign?.cases) ? testDesign.cases : []

    const covered = new Set<string>()
    for (const testCase of cases) for (const id of coversOf(testCase)) covered.add(id)

    const criteriaWithoutCases = [...declared.entries()]
        .filter(([id]) => !covered.has(id))
        .map(([id, text]) => ({ id, text }))

    const casesWithThinSteps = cases
        .map((testCase) => ({ id: testCase.id, reason: thinReason(testCase) }))
        .filter((entry) => entry.reason !== '')

    // "Covers a criterion that does not exist" is only meaningful once a
    // specification exists. On a legacy repository — the whole point of the
    // scan — listing every case here would bury the real gaps under hundreds of
    // rows; the missing `spec` is already reported on its own.
    const testsWithoutCriteria =
        declared.size === 0
            ? []
            : cases
                  .filter((testCase) => !coversOf(testCase).some((id) => declared.has(id)))
                  .map((testCase) => ({ id: testCase.id, covers: coversOf(testCase) }))

    // One lowercase haystack: every test-case name plus every candidate
    // statement. A symbol mentioned anywhere in it is not a blind spot.
    const haystack = [
        ...scan.tests.flatMap((evidence) => evidence.cases.map((entry) => entry.name)),
        ...scan.requirements.flatMap((doc) => doc.candidates.map((candidate) => candidate.text)),
    ]
        .join('\n')
        .toLowerCase()
    const uncoveredSymbols = scan.symbols
        .filter((symbol) => symbol.kind !== 'type' && symbol.kind !== 'main')
        .filter((symbol) => symbol.name !== '' && !haystack.includes(symbol.name.toLowerCase()))
        .slice(0, MAX_UNCOVERED_SYMBOLS)
        .map((symbol) => ({ name: symbol.name, path: symbol.path, line: symbol.line, kind: symbol.kind }))

    const missingArtifacts: GapReport['missingArtifacts'] = []
    if (spec === undefined) missingArtifacts.push('spec')
    if (testDesign === undefined || cases.length === 0) missingArtifacts.push('testDesign')
    if (scan.suggestedCommands.length === 0 && !exists(path.join(scan.cwd, '.dsh', 'quality-gate.json'))) {
        missingArtifacts.push('gateCommands')
    }

    return { criteriaWithoutCases, casesWithThinSteps, testsWithoutCriteria, uncoveredSymbols, missingArtifacts }
}

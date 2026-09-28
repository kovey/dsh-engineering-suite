/**
 * Mutation testing: does an assertion actually notice a change?
 *
 * `coverage_check` answers "was this line executed". That is not the same
 * question as "would a test have failed if this line were wrong" — a suite can
 * execute every line and assert nothing, and coverage cannot see the difference.
 * This module asks the second question the only way it can be answered
 * mechanically: **break the source on purpose, run the tests, and see whether
 * they notice.**
 *
 * Three invariants define the honesty of the answer:
 *
 *  1. **A run that could not happen is not a detection.** A spawn error, a
 *     deadline, a missing binary and an aborted turn are all `run-error`: the
 *     mutant is UNKNOWN, never "killed". Counting them as killed is how a
 *     mutation score is inflated into meaninglessness.
 *  2. **The workspace is byte-identical after the run.** Every mutation is
 *     written inside a `try`, restored in a `finally` (timeout, failure, abort —
 *     all of them), and verified against a pre-run byte snapshot afterwards. A
 *     file that does not match its snapshot is a refusal, not a warning: this
 *     gate writes to the source tree, so "it put it back" is a hard requirement.
 *  3. **The score covers exactly the mutants that ran.** No extrapolation, no
 *     "probably similar" — a bounded sample says it is a bounded sample.
 *
 * ## The operators are LEXICAL, not a parser
 *
 * Mutants are produced by a textual scan with a minimal string/comment state
 * machine per line (carried across lines for block comments and multi-line
 * strings). That is enough to keep `// "true"` in a comment and `"a == b"` in a
 * string out of the plan, and it is deliberately NOT enough to understand the
 * language: a `<` in a TypeScript type argument, a JSX element or a Rust
 * lifetime is just a `<`. The consequences are stated in the README and in every
 * report: a syntactically broken mutant that fails the build counts as killed,
 * so the score is a LOWER bound on suite weakness, and equivalent mutants
 * (semantically identical after the change) are not detected at all.
 *
 * Pure planning ({@link planMutants}) is separated from I/O
 * ({@link collectSourceFiles}, {@link runMutationPlan}) and from judging
 * ({@link judgeMutation}), so every rule above is unit-testable without a
 * filesystem or a clock.
 *
 * @module dsh-coverage-gate/mutation
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    changedRanges,
    isTestPath,
    languageOf,
    pathMatchesPattern,
    readCapped,
    runCommand,
    sha256,
    tail,
    walkWorkspace,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_FILES,
    type GateState,
    type Logger,
} from 'dsh-eng-core'

// --- operators --------------------------------------------------------------

/** Operator families; `operators` in the config/call may name a family. */
export type MutationOperatorGroup = 'relational' | 'equality' | 'boolean' | 'arithmetic' | 'literal'

/** One textual mutation rule. */
export interface MutationOperator {
    /** Stable id — printed in reports, written into the artifact, usable as a filter. */
    id: string
    group: MutationOperatorGroup
    /** Chinese one-liner for the report. */
    label: string
    /** Exact source token this rule matches. */
    token: string
    /** What that token becomes. */
    replacement: string
    /** `true` when the token is a word (`true`) and must not match inside `trueValue`. */
    word?: true
    /** Integer literals: the matched digits become `n ± 1` (never a fixed token). */
    numeric?: 'increment' | 'decrement'
}

/**
 * The operator set: small, language-agnostic and stable.
 *
 * Order is irrelevant (matching is longest-token-first); the ids are the
 * contract, so they are never renumbered or renamed.
 */
export const MUTATION_OPERATORS: readonly MutationOperator[] = [
    { id: 'REL_LT_TO_LE', group: 'relational', label: '< → <=', token: '<', replacement: '<=' },
    { id: 'REL_LE_TO_LT', group: 'relational', label: '<= → <', token: '<=', replacement: '<' },
    { id: 'REL_GT_TO_GE', group: 'relational', label: '> → >=', token: '>', replacement: '>=' },
    { id: 'REL_GE_TO_GT', group: 'relational', label: '>= → >', token: '>=', replacement: '>' },
    { id: 'EQ_TO_NE', group: 'equality', label: '== → !=', token: '==', replacement: '!=' },
    { id: 'NE_TO_EQ', group: 'equality', label: '!= → ==', token: '!=', replacement: '==' },
    { id: 'AND_TO_OR', group: 'boolean', label: '&& → ||', token: '&&', replacement: '||' },
    { id: 'OR_TO_AND', group: 'boolean', label: '|| → &&', token: '||', replacement: '&&' },
    { id: 'TRUE_TO_FALSE', group: 'boolean', label: 'true → false', token: 'true', replacement: 'false', word: true },
    { id: 'FALSE_TO_TRUE', group: 'boolean', label: 'false → true', token: 'false', replacement: 'true', word: true },
    { id: 'PLUS_TO_MINUS', group: 'arithmetic', label: '+ → -', token: '+', replacement: '-' },
    { id: 'MINUS_TO_PLUS', group: 'arithmetic', label: '- → +', token: '-', replacement: '+' },
    { id: 'MUL_TO_DIV', group: 'arithmetic', label: '* → /', token: '*', replacement: '/' },
    { id: 'DIV_TO_MUL', group: 'arithmetic', label: '/ → *', token: '/', replacement: '*' },
    { id: 'INT_INC', group: 'literal', label: 'n → n+1', token: '', replacement: '', numeric: 'increment' },
    { id: 'INT_DEC', group: 'literal', label: 'n → n-1', token: '', replacement: '', numeric: 'decrement' },
]

/** Every operator group, in table order. */
export const MUTATION_OPERATOR_GROUPS: readonly MutationOperatorGroup[] = [
    'relational',
    'equality',
    'boolean',
    'arithmetic',
    'literal',
]

/** Every operator id, for error messages and config validation. */
export const MUTATION_OPERATOR_IDS: readonly string[] = MUTATION_OPERATORS.map((operator) => operator.id)

/** Resolve operator ids / group names to a selection, refusing unknown names. */
export function resolveOperators(
    input: readonly string[] | undefined,
): { operators: MutationOperator[] } | { error: string } {
    if (input === undefined || input.length === 0) return { operators: [...MUTATION_OPERATORS] }
    const selected: MutationOperator[] = []
    const unknown: string[] = []
    for (const raw of input) {
        const name = raw.trim()
        if ((MUTATION_OPERATOR_GROUPS as readonly string[]).includes(name)) {
            for (const operator of MUTATION_OPERATORS) {
                if (operator.group === name && !selected.includes(operator)) selected.push(operator)
            }
            continue
        }
        const found = MUTATION_OPERATORS.find((operator) => operator.id === name)
        if (found === undefined) {
            unknown.push(raw)
            continue
        }
        if (!selected.includes(found)) selected.push(found)
    }
    if (unknown.length > 0) {
        return {
            error: `未知的变异操作符 ${unknown.map((name) => `"${name}"`).join(', ')}；可用操作符 id：${MUTATION_OPERATOR_IDS.join(
                ', ',
            )}；也可用组名：${MUTATION_OPERATOR_GROUPS.join(', ')}`,
        }
    }
    return { operators: selected }
}

// --- lexical scan (strings and comments) ------------------------------------

/** Carried between lines: an open block comment or an open (possibly multi-line) string. */
export interface LexicalState {
    blockComment: boolean
    quote?: string
}

/** A fresh lexical state. */
export function freshLexicalState(): LexicalState {
    return { blockComment: false }
}

/** Characters that extend a punctuation operator (`+=`, `->`, `<<`, `===` …). */
const OPERATOR_CONTINUATION = '+-*/<>=!&|^%~'

/**
 * Blank out every string and comment character on ONE line, keeping the length.
 *
 * Length-preserving is the whole trick: offsets and columns stay valid, so the
 * planner can find tokens on the masked line and cut them out of the original.
 * The cost is honesty about what this is — a state machine over quotes and
 * comment markers, not a lexer: regex literals, template interpolations,
 * heredocs and raw strings are approximated, and every approximation errs
 * towards NOT mutating.
 * @param line - one source line (no trailing newline).
 * @param state - carried lexical state; mutated in place.
 * @param options - `hashComments` for `#` line comments (Python and friends).
 * @returns the masked line, same length as `line`.
 */
export function maskLine(line: string, state: LexicalState, options: { hashComments?: boolean } = {}): string {
    const chars = [...line]
    // The ORIGINAL character, read before anything is masked: testing the masked
    // buffer instead of the source is how a string state machine stops ending its
    // strings (a bug this module's own tests pin down).
    const at = (index: number): string => line[index] ?? ''
    let index = 0
    while (index < chars.length) {
        if (state.blockComment) {
            if (at(index) === '*' && at(index + 1) === '/') {
                chars[index] = ' '
                chars[index + 1] = ' '
                index += 2
                state.blockComment = false
                continue
            }
            chars[index] = ' '
            index += 1
            continue
        }
        if (state.quote !== undefined) {
            const quote = state.quote
            if (quote.length === 3) {
                if (line.startsWith(quote, index)) {
                    for (let offset = 0; offset < 3; offset += 1) chars[index + offset] = ' '
                    index += 3
                    state.quote = undefined
                    continue
                }
                chars[index] = ' '
                index += 1
                continue
            }
            if (at(index) === '\\') {
                chars[index] = ' '
                if (index + 1 < chars.length) chars[index + 1] = ' '
                index += 2
                continue
            }
            if (at(index) === quote) {
                chars[index] = ' '
                state.quote = undefined
                index += 1
                continue
            }
            chars[index] = ' '
            index += 1
            continue
        }
        // --- in code ---
        if (at(index) === '/' && at(index + 1) === '/') {
            for (let blank = index; blank < chars.length; blank += 1) chars[blank] = ' '
            break
        }
        if (at(index) === '/' && at(index + 1) === '*') {
            chars[index] = ' '
            chars[index + 1] = ' '
            index += 2
            state.blockComment = true
            continue
        }
        if (options.hashComments === true && at(index) === '#') {
            for (let blank = index; blank < chars.length; blank += 1) chars[blank] = ' '
            break
        }
        if (at(index) === '"' || at(index) === "'" || at(index) === '`') {
            const character = at(index)
            const triple = character !== '`' && line.startsWith(character.repeat(3), index)
            const quote = triple ? character.repeat(3) : character
            for (let offset = 0; offset < quote.length; offset += 1) chars[index + offset] = ' '
            index += quote.length
            state.quote = quote
            continue
        }
        index += 1
    }
    return chars.join('')
}

/** Mask a whole document, one line at a time, carrying the lexical state. */
export function maskDocument(text: string, options: { hashComments?: boolean } = {}): string[] {
    const state = freshLexicalState()
    return text.split('\n').map((line) => maskLine(line, state, options))
}

// --- mutants ----------------------------------------------------------------

/** One planned mutation, positioned exactly in the original source. */
export interface Mutant {
    /** Stable id: `<file>:<line>:<column>:<operator>` (line 1-based, column 0-based). */
    id: string
    /** Workspace-relative POSIX path. */
    file: string
    /** 1-based line number. */
    line: number
    /** 0-based column of the token. */
    column: number
    /** Operator id ({@link MUTATION_OPERATORS}). */
    operator: string
    /** The exact source token that is replaced. */
    tokenBefore: string
    /** What it is replaced with. */
    tokenAfter: string
    /** Bounded window of the original line around the token. */
    snippetBefore: string
    /** The same window, mutated. */
    snippetAfter: string
    /** Offsets into the file text: `[start, end)` covers `tokenBefore`. */
    start: number
    end: number
}

/** A source file to plan mutants over. */
export interface SourceFile {
    /** Workspace-relative POSIX path. */
    path: string
    text: string
}

/** Bounds of {@link planMutants}. */
export interface PlanOptions {
    files: readonly SourceFile[]
    /** Operator ids or group names; unknown names are refused, never ignored. */
    operators?: readonly string[]
    /** Hard cap on the planned mutants. */
    maxMutants?: number
}

/** What {@link planMutants} decided. */
export interface MutationPlan {
    mutants: Mutant[]
    /** How many mutants the full operator set would produce over these files. */
    available: number
    /** The plan holds fewer mutants than `available` (deterministic sampling). */
    truncated: boolean
    /** Files the plan may mutate, sorted. */
    files: string[]
    /** Operator ids in force. */
    operatorIds: string[]
    /** Honest caveats (sampling, per-file mutants that could not be placed). */
    notes: string[]
}

/** Bounded width of a `snippetBefore`/`snippetAfter` window. */
export const SNIPPET_WIDTH = 120

/** The window of `line` around `[start, end)` used for the report snippet. */
function snippetOf(line: string, start: number, end: number): string {
    const padding = Math.max(0, Math.floor((SNIPPET_WIDTH - (end - start)) / 2))
    const from = Math.max(0, start - padding)
    const to = Math.min(line.length, from + SNIPPET_WIDTH)
    const text = line.slice(from, to).trim()
    return `${from > 0 ? '…' : ''}${text}${to < line.length ? '…' : ''}`
}

/** Whether a word token sits on identifier boundaries and is not a property access. */
function wordBoundaryOk(line: string, start: number, end: number): boolean {
    const before = (start > 0 ? line[start - 1] : '') ?? ''
    const after = (end < line.length ? line[end] : '') ?? ''
    if (before === '.' || after === '.') return false
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return false
    return true
}

/** Whether a punctuation operator is a standalone token rather than part of `+=`, `->`, `===`. */
function punctuationBoundaryOk(line: string, start: number, end: number): boolean {
    const before = (start > 0 ? line[start - 1] : '') ?? ''
    const after = (end < line.length ? line[end] : '') ?? ''
    return !OPERATOR_CONTINUATION.includes(before) && !OPERATOR_CONTINUATION.includes(after)
}

/** Whether a digit run is a bare decimal integer literal (`1`, `0` — not `1.5`, `0x1f`, `x1`). */
function integerBoundaryOk(line: string, start: number, end: number): boolean {
    const before = (start > 0 ? line[start - 1] : '') ?? ''
    const after = (end < line.length ? line[end] : '') ?? ''
    if (/[A-Za-z0-9_$.]/.test(before) || /[A-Za-z0-9_$.]/.test(after)) return false
    const digits = line.slice(start, end)
    // A leading zero is octal/legacy syntax, and a 16+ digit literal exceeds
    // exact float range: neither is a date/offset/version number we should nudge.
    if (digits.length > 1 && digits.startsWith('0')) return false
    if (digits.length > 15) return false
    return true
}

/** Apply one punctuation/word operator at one position, or `undefined` when the boundary rules reject it. */
function tokenAt(
    operator: MutationOperator,
    line: string,
    masked: string,
    start: number,
): { end: number; after: string } | undefined {
    if (!masked.startsWith(operator.token, start)) return undefined
    const end = start + operator.token.length
    if (operator.word === true) {
        if (!wordBoundaryOk(line, start, end)) return undefined
        return { end, after: operator.replacement }
    }
    if (!punctuationBoundaryOk(line, start, end)) return undefined
    return { end, after: operator.replacement }
}

/** One operator application, in document order. */
interface Span {
    start: number
    end: number
    operator: MutationOperator
    after: string
}

/**
 * Find every mutation the operator set produces in one document.
 *
 * Single pass, left to right, longest token first, and **no two mutants share a
 * character**: once a token matched, scanning resumes after it, so a plan can
 * never contain two overlapping edits (which would make the result depend on the
 * order they were applied in). Integer literals are the one exception to "one
 * mutant per position" — a literal gets both `n+1` and `n-1`, which are two
 * operators over the same span and never applied together.
 */
export function mutantsInFile(file: string, text: string, operators: readonly MutationOperator[]): Mutant[] {
    const hashComments = /\.py$/i.test(file)
    const lines = text.split('\n')
    const masked = maskDocument(text, { hashComments })
    // Longest token first so `<=` wins over `<` and `==` over `=`.
    const ordered = [...operators]
        .filter((operator) => operator.numeric === undefined)
        .sort((left, right) => right.token.length - left.token.length || left.id.localeCompare(right.id))
    const numeric = [...operators].filter((operator) => operator.numeric !== undefined).sort((left, right) => left.id.localeCompare(right.id))
    const mutants: Mutant[] = []
    let offset = 0
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string
        const maskedLine = masked[index] ?? ''
        const spans: Span[] = []
        let cursor = 0
        while (cursor < maskedLine.length) {
            if (/[0-9]/.test(maskedLine[cursor] as string)) {
                let end = cursor
                while (end < maskedLine.length && /[0-9]/.test(line[end] as string)) end += 1
                const digits = line.slice(cursor, end)
                const value = Number.parseInt(digits, 10)
                if (integerBoundaryOk(line, cursor, end) && Number.isSafeInteger(value)) {
                    for (const operator of numeric) {
                        spans.push({
                            start: cursor,
                            end,
                            operator,
                            after: String(operator.numeric === 'increment' ? value + 1 : value - 1),
                        })
                    }
                }
                // Either way the whole digit run is consumed: `1.5`, `0x1f` and
                // `007` must not have their digits mutated one by one.
                cursor = end
                continue
            }
            let matched = false
            for (const operator of ordered) {
                const application = tokenAt(operator, line, maskedLine, cursor)
                if (application === undefined) continue
                spans.push({ start: cursor, end: application.end, operator, after: application.after })
                cursor = application.end
                matched = true
                break
            }
            if (!matched) cursor += 1
        }
        for (const span of spans) {
            const tokenBefore = line.slice(span.start, span.end)
            const beforeText = snippetOf(line, span.start, span.end)
            const shifted = `${line.slice(0, span.start)}${span.after}${line.slice(span.end)}`
            const delta = span.after.length - tokenBefore.length
            mutants.push({
                id: `${file}:${index + 1}:${span.start}:${span.operator.id}`,
                file,
                line: index + 1,
                column: span.start,
                operator: span.operator.id,
                tokenBefore,
                tokenAfter: span.after,
                snippetBefore: beforeText,
                snippetAfter: snippetOf(shifted, span.start, span.end + delta),
                start: offset + span.start,
                end: offset + span.end,
            })
        }
        offset += line.length + 1
    }
    return mutants
}

/**
 * Plan mutants over source files: pure, deterministic, sorted.
 *
 * When more mutants exist than `maxMutants` allows, the sample is taken
 * **round-robin across files** (one from each file, in path order, until the cap)
 * instead of "the first N in file order": a deterministic sample that only ever
 * mutates the alphabetically first file would say nothing about the rest of the
 * workspace. The sample is reported as a sample — the score is never extrapolated
 * from it.
 * @param options - files, operator selection and the mutant cap.
 */
export function planMutants(options: PlanOptions): MutationPlan {
    const resolved = resolveOperators(options.operators)
    if ('error' in resolved) throw new Error(resolved.error)
    const operators = resolved.operators
    const notes: string[] = []
    const perFile = new Map<string, Mutant[]>()
    for (const file of [...options.files].sort((left, right) => left.path.localeCompare(right.path))) {
        const found = mutantsInFile(file.path, file.text, operators)
        if (found.length > 0) perFile.set(file.path, found)
    }
    const available = [...perFile.values()].reduce((total, list) => total + list.length, 0)
    const cap = options.maxMutants === undefined ? available : Math.max(0, Math.floor(options.maxMutants))
    const paths = [...perFile.keys()]
    const selected: Mutant[] = []
    if (cap < available) {
        const queues = paths.map((file) => [...(perFile.get(file) as Mutant[])])
        let progressed = true
        while (selected.length < cap && progressed) {
            progressed = false
            for (const queue of queues) {
                if (selected.length >= cap) break
                const next = queue.shift()
                if (next === undefined) continue
                selected.push(next)
                progressed = true
            }
        }
        notes.push(
            `变异体总数 ${available} 超过上限 ${cap}：本次是**抽样**（按文件轮转取前 ${cap} 个，顺序确定、不是随机），得分只覆盖实际跑过的变异体，不外推。`,
        )
    } else {
        selected.push(...paths.flatMap((file) => perFile.get(file) as Mutant[]))
    }
    selected.sort(
        (left, right) =>
            left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.operator.localeCompare(right.operator),
    )
    return {
        mutants: selected,
        available,
        truncated: selected.length < available,
        files: [...new Set(selected.map((mutant) => mutant.file))].sort(),
        operatorIds: operators.map((operator) => operator.id),
        notes,
    }
}

/**
 * Apply one mutant to the file text it was planned from.
 * @param text - the ORIGINAL file text.
 * @param mutant - the planned mutation.
 * @returns the mutated text; throws when the plan does not match the text (a
 *   stale plan must never silently mutate the wrong offset).
 */
export function applyMutant(text: string, mutant: Mutant): string {
    const found = text.slice(mutant.start, mutant.end)
    if (found !== mutant.tokenBefore) {
        throw new Error(
            `变异体 ${mutant.id} 与源文件不一致（期望 ${JSON.stringify(mutant.tokenBefore)}，实际 ${JSON.stringify(
                found,
            )}）：计划已过期（文件在计划之后被改动）。下一步：重新运行 mutation_check 生成新计划。`,
        )
    }
    return `${text.slice(0, mutant.start)}${mutant.tokenAfter}${text.slice(mutant.end)}`
}

// --- classification and score -----------------------------------------------

/** What one mutant's run means. */
export type MutantVerdict = 'killed' | 'survived' | 'run-error'

/** The outcome of one test command execution for one mutant. */
export interface MutantCommandOutcome {
    exitCode: number | null
    signal?: string | null
    timedOut?: boolean
    /** The process could not be started (ENOENT, EACCES…). */
    spawnError?: string
    /** The caller's signal was already aborted. */
    aborted?: boolean
    stdout?: string
    stderr?: string
    durationMs?: number
}

/** One mutant's recorded result. */
export interface MutantResult {
    id: string
    file: string
    line: number
    column: number
    operator: string
    tokenBefore: string
    tokenAfter: string
    snippetBefore: string
    snippetAfter: string
    verdict: MutantVerdict
    exitCode: number | null
    timedOut: boolean
    durationMs: number
    /** Chinese, and for `run-error` it says WHY it is not a kill. */
    reason: string
    /** Bounded tail of the command's output. */
    output: string
}

/**
 * Classify one command outcome — the one place the honesty rule lives.
 *
 * `killed` requires an actual non-zero exit **from a run that happened**: a
 * timeout is a hung suite (not a passing suite, and not a detection either), a
 * spawn error is a command that never ran, and an abort is the caller's own
 * cancellation. All three are `run-error` — unknown.
 * @param outcome - the normalised command outcome.
 */
export function classifyMutantOutcome(outcome: MutantCommandOutcome): { verdict: MutantVerdict; reason: string } {
    if (outcome.aborted === true) {
        return { verdict: 'run-error', reason: '调用已取消（signal abort）：测试命令没有跑完，变异体结果未知（不是被杀死）' }
    }
    if (outcome.spawnError !== undefined && outcome.spawnError !== '') {
        return {
            verdict: 'run-error',
            reason: `测试命令无法启动：${outcome.spawnError}。变异体未被检验（不是被杀死），请先确认 testCommand 可执行`,
        }
    }
    if (outcome.timedOut === true) {
        return {
            verdict: 'run-error',
            reason: '测试命令超时：卡住的测试套件既不算通过、也不算发现变异——变异体结果未知（不是被杀死）。请提高 commandTimeoutMs 或先修掉挂起的用例',
        }
    }
    if (outcome.exitCode === null) {
        return {
            verdict: 'run-error',
            reason: `测试命令没有给出退出码（signal=${outcome.signal ?? 'null'}）：结果未知（不是被杀死）`,
        }
    }
    if (outcome.exitCode === 0) {
        return { verdict: 'survived', reason: '测试命令通过：没有任何断言发现了这处改动（这就是"覆盖到但没测到"）' }
    }
    return { verdict: 'killed', reason: `测试命令失败（exit=${outcome.exitCode}）：测试套件发现了这处改动` }
}

/** The counts a score is computed from. */
export interface MutationCounts {
    executed: number
    killed: number
    survived: number
    /** Command could not run (spawn error, timeout, abort): NOT a kill, NOT a pass. */
    runError: number
}

/** One decimal place, without a trailing `.0`. */
export function formatMutationPercent(value: number): string {
    return `${Math.round(value * 10) / 10}%`
}

/**
 * The mutation score, with both numbers and the formula spelled out.
 *
 * The denominator is `killed + survived` — the mutants whose verdict is actually
 * known. `run-error` mutants are reported next to it and never folded in: an
 * unrunnable mutant is unknown, so counting it as killed would inflate the score
 * and counting it as survived would deflate it. Both are lies.
 * @param counts - killed / survived / run-error counts.
 */
export function mutationScoreOf(counts: MutationCounts): {
    score?: number
    denominator: number
    formula: string
} {
    const denominator = counts.killed + counts.survived
    const score = denominator === 0 ? undefined : (counts.killed / denominator) * 100
    const ratio = score === undefined ? '无法判定（分母为 0）' : formatMutationPercent(score)
    return {
        ...(score === undefined ? {} : { score }),
        denominator,
        formula: `score = killed ÷ (killed + survived) = ${counts.killed} ÷ (${counts.killed} + ${counts.survived}) = ${ratio}；run-error ${counts.runError} 个不计入分母（未跑到的变异体是未知，既不算杀死也不算存活）`,
    }
}

// --- verdict ----------------------------------------------------------------

/** One judged threshold, in the shape `coverage_check` records. */
export interface MutationCheck {
    id: string
    name: string
    expectation: string
    /** `true` passed, `false` failed, `null` could not be judged. */
    ok: boolean | null
    output: string
}

/** The verdict {@link judgeMutation} produces. */
export interface MutationJudgement {
    state: GateState
    reason: string
    checks: MutationCheck[]
    /** Threshold keys that were actually decided. */
    judged: string[]
    /** Threshold keys that could not be decided. */
    unjudged: string[]
    notes: string[]
}

/** Threshold configuration this gate enforces (all optional; the tool refuses without a score threshold). */
export interface MutationThresholds {
    /** Minimum score over all planned mutants, 0–100. */
    mutationScore?: number
    /** Minimum score when the plan is restricted to the changed files, 0–100. */
    changedMutationScore?: number
    /** Absolute cap on survived mutants. */
    maxSurvived?: number
}

/** Inputs of {@link judgeMutation}. */
export interface JudgeMutationInput {
    run: MutationRun
    thresholds: MutationThresholds
    /** The plan was restricted to the files this change touches. */
    changed: boolean
}

/** Which score threshold applies, and under which key. */
export function scoreThresholdFor(
    thresholds: MutationThresholds,
    changed: boolean,
): { key: 'mutationScore' | 'changedMutationScore'; value: number } | undefined {
    if (changed) {
        if (thresholds.changedMutationScore !== undefined) {
            return { key: 'changedMutationScore', value: thresholds.changedMutationScore }
        }
        return thresholds.mutationScore === undefined ? undefined : { key: 'mutationScore', value: thresholds.mutationScore }
    }
    return thresholds.mutationScore === undefined ? undefined : { key: 'mutationScore', value: thresholds.mutationScore }
}

/**
 * Turn a run into PASS / WARN / BLOCK.
 *
 * - **BLOCK** — a configured threshold was missed, or nothing could be judged at
 *   all (every mutant run-errored): fail closed, exactly like the coverage gate.
 * - **WARN** — the thresholds hold, but the run was incomplete: some mutants
 *   could not run, or the time budget stopped the plan. The score then covers
 *   only what ran.
 * - **PASS** — thresholds hold and every planned mutant produced a verdict.
 * @param input - the run, the thresholds and the mode.
 */
export function judgeMutation(input: JudgeMutationInput): MutationJudgement {
    const { run, thresholds, changed } = input
    const checks: MutationCheck[] = []
    const judged: string[] = []
    const unjudged: string[] = []
    const notes = [...run.notes]
    const scoreThreshold = scoreThresholdFor(thresholds, changed)

    if (scoreThreshold !== undefined) {
        const own = scoreThreshold.key === 'changedMutationScore' ? '增量变异得分' : '变异得分'
        const expectation = `mutation.score >= ${formatMutationPercent(scoreThreshold.value)}（${scoreThreshold.key}）`
        if (run.score === undefined) {
            unjudged.push(scoreThreshold.key)
            checks.push({
                id: 'mutation-score',
                name: own,
                expectation,
                ok: null,
                output: `没有可判定的变异体（killed 0、survived 0、run-error ${run.counts.runError}）：得分无法判定。这既不是 0% 也不是 100%——不可判定就是不可判定，不能当作通过。`,
            })
        } else {
            judged.push(scoreThreshold.key)
            const pass = run.score >= scoreThreshold.value
            checks.push({
                id: 'mutation-score',
                name: own,
                expectation,
                ok: pass,
                output: `${run.formula}；阈值 ${formatMutationPercent(scoreThreshold.value)} → ${pass ? '达标' : '不达标'}`,
            })
        }
    }

    if (thresholds.maxSurvived !== undefined) {
        const expectation = `mutation.survived <= ${thresholds.maxSurvived}`
        judged.push('maxSurvived')
        const pass = run.counts.survived <= thresholds.maxSurvived
        checks.push({
            id: 'mutation-survived',
            name: '存活变异体上限',
            expectation,
            ok: pass,
            output: `存活 ${run.counts.survived} 个（上限 ${thresholds.maxSurvived}）→ ${pass ? '达标' : '不达标'}${
                pass || run.survivors.length === 0 ? '' : `：${run.survivors.slice(0, 5).map((mutant) => `${mutant.file}:${mutant.line}`).join('，')}`
            }`,
        })
    }

    if (run.stopped === 'budget') {
        notes.push(
            `时间预算 ${run.timeBudgetMs}ms 用尽：计划 ${run.planned} 个变异体，实际跑完 ${run.counts.executed} 个。得分只覆盖跑过的部分，不外推。`,
        )
    }
    if (run.counts.runError > 0) {
        notes.push(`${run.counts.runError} 个变异体未能运行（run-error）：它们的结果未知，未计入得分。`)
    }

    const blocking = checks.some((check) => check.ok === false) || unjudged.length > 0
    const incomplete = run.counts.runError > 0 || run.stopped === 'budget'
    const state: GateState = blocking ? 'BLOCK' : incomplete ? 'WARN' : 'PASS'
    const failures = checks.filter((check) => check.ok === false)
    const reason =
        state === 'BLOCK'
            ? unjudged.length > 0 && failures.length === 0
                ? `变异得分无法判定：${checks
                      .filter((check) => check.ok === null)
                      .map((check) => check.output)
                      .join('；')}`
                : `变异测试不达标：${failures.map((check) => check.output).join('；')}`
            : state === 'WARN'
              ? `阈值达标，但这次跑得不完整：${[
                    run.counts.runError > 0 ? `${run.counts.runError} 个变异体未能运行（run-error，未计入得分）` : '',
                    run.stopped === 'budget' ? `时间预算用尽（跑了 ${run.counts.executed}/${run.planned}）` : '',
                ]
                    .filter((part) => part !== '')
                    .join('；')}`
              : `变异测试达标：${run.formula.split('；')[0] ?? run.formula}${
                    thresholds.maxSurvived === undefined ? '' : `；存活 ${run.counts.survived} ≤ 上限 ${thresholds.maxSurvived}`
                }`
    return { state, reason, checks, judged, unjudged, notes }
}

// --- file selection (I/O) ---------------------------------------------------

/** Source globs per language, reused from `dsh-eng-core`'s language detection. */
export const LANGUAGE_SOURCE_GLOBS: Readonly<Record<string, readonly string[]>> = {
    ts: ['**/*.ts', '**/*.tsx'],
    js: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    go: ['**/*.go'],
    python: ['**/*.py'],
}

/** Every source glob the detector may choose from. */
export const ALL_SOURCE_GLOBS: readonly string[] = Object.values(LANGUAGE_SOURCE_GLOBS).flat()

/**
 * Paths that are never mutated, whatever the host configures.
 *
 * Two families: the engineering trail (`.dsh/**` is the trust root — mutating it
 * would be a gate editing its own configuration) and the things no reviewer means
 * by "source": version control metadata, dependency trees, build output and
 * generated files. The list is a floor, not a ceiling: `excludeGlobs` adds to it.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
    '.dsh/**',
    '.git/**',
    'node_modules/**',
    'vendor/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    '.venv/**',
    'venv/**',
    '__pycache__/**',
    'coverage/**',
    '**/*.min.js',
    '**/*.d.ts',
    '**/*.pb.go',
    '**/*_generated.go',
    '**/*.gen.ts',
    '**/*.generated.*',
]

/** Inputs of {@link collectSourceFiles}. */
export interface CollectOptions {
    cwd: string
    /** Configured globs; when absent they are detected from the workspace's languages. */
    sourceGlobs?: readonly string[]
    /** Additional excludes, on top of {@link DEFAULT_EXCLUDE_GLOBS}. */
    excludeGlobs?: readonly string[]
    /** Restrict the plan to the files this change touches (`changedRanges`). */
    changed?: boolean
    /** Diff base for `changed` (default `HEAD`). */
    baseRef?: string
    maxFiles?: number
    maxFileBytes?: number
    logger?: Logger
}

/** What {@link collectSourceFiles} found. */
export interface CollectedSources {
    files: SourceFile[]
    /** Files that matched but were not planned, with the reason. */
    skipped: { path: string; reason: string }[]
    /** The globs actually used (detected when the host configured none). */
    sourceGlobs: string[]
    /** Honest caveats about the selection. */
    notes: string[]
    /** Set when the changed-file diff could not be read. */
    problem?: string
}

/** Whether a path is excluded by the hard list and the configured globs. */
export function isExcludedPath(file: string, excludeGlobs: readonly string[]): boolean {
    return excludeGlobs.some((pattern) => pathMatchesPattern(pattern, file))
}

/** Detect which source globs a workspace actually needs, from `dsh-eng-core`'s languages. */
export function detectSourceGlobs(cwd: string, maxFiles: number): { globs: string[]; languages: string[] } {
    const walk = walkWorkspace({ cwd, maxFiles })
    const languages = new Set<string>()
    for (const file of walk.files) {
        const language = languageOf(file.rel)
        if (language !== undefined) languages.add(language)
    }
    const globs = [...languages]
        .sort((left, right) => left.localeCompare(right))
        .flatMap((language) => LANGUAGE_SOURCE_GLOBS[language] ?? [])
    return { globs: globs.length === 0 ? [...ALL_SOURCE_GLOBS] : globs, languages: [...languages].sort() }
}

/**
 * Select the source files to mutate.
 *
 * In `changed` mode the file set comes from `dsh-eng-core`'s `changedRanges`
 * (the same diff `coverage_check` uses for incremental coverage), so "mutate what
 * this change touched" means the same thing in both tools. Test files are always
 * skipped — mutating a test file tests the test, not the product — and the
 * remaining files must match `sourceGlobs` and none of the excludes.
 * @param options - workspace, globs, mode and bounds.
 */
export async function collectSourceFiles(options: CollectOptions): Promise<CollectedSources> {
    const cwd = options.cwd
    const notes: string[] = []
    const skipped: { path: string; reason: string }[] = []
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...(options.excludeGlobs ?? [])]
    let sourceGlobs: string[]
    if (options.sourceGlobs !== undefined && options.sourceGlobs.length > 0) {
        sourceGlobs = [...options.sourceGlobs]
    } else {
        const detected = detectSourceGlobs(cwd, maxFiles)
        sourceGlobs = detected.globs
        notes.push(
            detected.languages.length === 0
                ? `sourceGlobs 未配置，且工作区里没有任何 ${Object.keys(LANGUAGE_SOURCE_GLOBS).join('/')} 语言的文件：已按全部默认源码 glob 处理（${sourceGlobs.join(', ')}）`
                : `sourceGlobs 未配置：按工作区实际语言探测（${detected.languages.join(', ')}）得到 ${sourceGlobs.join(', ')}`,
        )
    }

    const candidates: string[] = []
    let problem: string | undefined
    if (options.changed === true) {
        const diff = await changedRanges({
            cwd,
            ...(options.baseRef === undefined ? {} : { base: options.baseRef }),
        })
        if (!diff.isRepo) {
            problem = diff.problem ?? '工作区不是 git 仓库'
            return { files: [], skipped, sourceGlobs, notes, problem }
        }
        notes.push(`changed：只变异相对 ${diff.base} 改动的文件（${diff.files.length} 个改动文件）`)
        for (const file of diff.files) {
            if (file.status === 'deleted') continue
            candidates.push(file.path)
        }
    } else {
        const walk = walkWorkspace({ cwd, maxFiles })
        if (walk.truncated) {
            notes.push(`工作区文件数超过遍历上限 ${maxFiles}：只检查了前 ${walk.files.length} 个文件（结果不完整）`)
        }
        for (const file of walk.files) candidates.push(file.rel)
    }

    const files: SourceFile[] = []
    for (const file of [...new Set(candidates)].sort((left, right) => left.localeCompare(right))) {
        if (!sourceGlobs.some((pattern) => pathMatchesPattern(pattern, file))) {
            if (options.changed === true) skipped.push({ path: file, reason: '不匹配 sourceGlobs（不是源码文件）' })
            continue
        }
        if (isExcludedPath(file, excludeGlobs)) {
            skipped.push({ path: file, reason: '命中排除 glob（台账/依赖/构建产物/生成文件不参与变异）' })
            continue
        }
        if (isTestPath(file)) {
            skipped.push({ path: file, reason: '是测试文件：变异测试文件等于测试"测试自己"，不参与变异' })
            continue
        }
        const text = readCapped(path.join(cwd, file), maxFileBytes, options.logger ?? SILENT_LOGGER)
        if (text === undefined) {
            skipped.push({ path: file, reason: `文件超过 ${maxFileBytes} 字节或不可读` })
            continue
        }
        if (!Buffer.from(text, 'utf8').equals(fs.readFileSync(path.join(cwd, file)))) {
            skipped.push({ path: file, reason: '不是合法 UTF-8：文本变异会破坏字节，无法保证还原，已跳过' })
            continue
        }
        files.push({ path: file, text })
    }
    return { files, skipped, sourceGlobs, notes, ...(problem === undefined ? {} : { problem }) }
}

/** A logger that swallows everything (the walker wants one, callers often have none). */
const SILENT_LOGGER: Logger = Object.assign((): void => undefined, {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    // The walker never calls it; the type requires it.
    for: (): Logger => SILENT_LOGGER,
})

// --- execution (I/O) --------------------------------------------------------

/** One command execution for one mutant, as the runner sees it. */
export interface MutantCommandSpec {
    mutant: Mutant
    argv: readonly string[]
    cwd: string
    timeoutMs: number
    signal?: AbortSignal
}

/** Injectable command runner (tests stub it; production uses `runCommand`). */
export type MutantCommandRunner = (spec: MutantCommandSpec) => Promise<MutantCommandOutcome>

/** Inputs of {@link runMutationPlan}. */
export interface MutationRunOptions {
    cwd: string
    /** The test command, already tokenised (argv only, no shell). */
    argv: readonly string[]
    /** Deadline for ONE mutant's test run. */
    timeoutMs: number
    /** Wall-clock budget for the whole run. */
    timeBudgetMs: number
    maxOutputBytes?: number
    signal?: AbortSignal
    /** Injected command runner (default: `dsh-eng-core`'s `runCommand`). */
    run?: MutantCommandRunner
    /** `ctx.get('subprocess')`, read per run. */
    subprocess?: () => unknown
    /** Injected clock, so the budget is testable without waiting. */
    now?: () => number
    logger?: Logger
}

/** The whole run: every mutant's verdict plus how far the plan got. */
export interface MutationRun {
    results: MutantResult[]
    counts: MutationCounts
    /** `killed / (killed + survived)`, `undefined` when nothing could be judged. */
    score?: number
    /** Both numbers and the formula, always printable. */
    formula: string
    /** `complete`, stopped by the time budget, or cancelled. */
    stopped: 'complete' | 'budget' | 'aborted'
    planned: number
    available: number
    truncated: boolean
    timeBudgetMs: number
    elapsedMs: number
    /** Files whose bytes were actually mutated (they are all restored). */
    files: string[]
    /** Survived mutants, sorted — the deliverable of this gate. */
    survivors: MutantResult[]
    notes: string[]
}

/** Raised when the workspace could not be restored: a refusal, never a verdict. */
export class MutationRestoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'MutationRestoreError'
    }
}

/** The pre-run byte snapshot of one file, plus whether it differs from HEAD. */
interface Snapshot {
    file: string
    bytes: Buffer
    digest: string
    /** The file already differed from HEAD before the run (the current work). */
    dirtyVsHead: boolean
}

/** Files among `paths` that differ from HEAD (modified, staged or untracked). */
async function dirtyVsHead(cwd: string, paths: readonly string[]): Promise<Set<string>> {
    const dirty = new Set<string>()
    if (paths.length === 0) return dirty
    const modified = await runCommand(
        { argv: ['git', 'status', '--porcelain', '--', ...paths], cwd, timeoutMs: 20_000 },
        undefined,
    )
    if (modified.exitCode !== 0) return dirty
    for (const line of modified.stdout.split('\n')) {
        const body = line.slice(3).trim()
        if (body === '') continue
        const arrow = body.lastIndexOf(' -> ')
        dirty.add(arrow >= 0 ? body.slice(arrow + 4).trim() : body)
    }
    return dirty
}

/**
 * Execute a plan: mutate, run once, restore, classify — for every mutant.
 *
 * The restore is unconditional (`try/finally`, so a failing, timed-out or
 * aborted run all restore), and afterwards every mutated file is compared BYTE
 * FOR BYTE against the pre-run snapshot. A mismatch raises
 * {@link MutationRestoreError}: the one failure mode this gate must never
 * tolerate is leaving a mutated source file behind.
 * @param plan - the planned mutants.
 * @param options - the command, bounds and injected seams.
 */
export async function runMutationPlan(plan: MutationPlan, options: MutationRunOptions): Promise<MutationRun> {
    const now = options.now ?? (() => Date.now())
    const started = now()
    const logger = options.logger
    const results: MutantResult[] = []
    const notes = [...plan.notes]
    const paths = [...new Set(plan.mutants.map((mutant) => mutant.file))].sort()
    const snapshots = new Map<string, Snapshot>()
    for (const file of paths) {
        const absolute = path.join(options.cwd, file)
        const bytes = fs.readFileSync(absolute)
        snapshots.set(file, { file, bytes, digest: sha256(bytes), dirtyVsHead: false })
    }
    const dirty = await dirtyVsHead(options.cwd, paths)
    for (const file of dirty) {
        const snapshot = snapshots.get(file)
        if (snapshot !== undefined) snapshots.set(file, { ...snapshot, dirtyVsHead: true })
    }
    if (dirty.size > 0) {
        notes.push(
            `运行前就有未提交改动的文件（本次工作本身，已按快照还原）：${[...dirty].sort().join(', ')}`,
        )
    }

    /** Compare every snapshot against the disk; the invariant of this whole gate. */
    const verify = (): string | undefined => {
        const mismatched: string[] = []
        for (const snapshot of snapshots.values()) {
            try {
                const current = fs.readFileSync(path.join(options.cwd, snapshot.file))
                if (!current.equals(snapshot.bytes)) mismatched.push(snapshot.file)
            } catch {
                mismatched.push(`${snapshot.file}（无法读取）`)
            }
        }
        return mismatched.length === 0 ? undefined : mismatched.sort().join('，')
    }

    // A function, not an expression: TypeScript's control-flow analysis would
    // otherwise narrow `signal.aborted` to `false` after the first check and
    // report the second one as an impossible comparison.
    const cancelled = (): boolean => options.signal?.aborted === true

    let stopped: MutationRun['stopped'] = 'complete'
    try {
        for (const mutant of plan.mutants) {
            if (cancelled()) {
                stopped = 'aborted'
                break
            }
            if (now() - started >= options.timeBudgetMs) {
                stopped = 'budget'
                break
            }
            const snapshot = snapshots.get(mutant.file)
            if (snapshot === undefined) {
                stopped = 'aborted'
                notes.push(`内部不一致：${mutant.file} 没有快照，已停止（未变异任何文件）。`)
                break
            }
            const absolute = path.join(options.cwd, mutant.file)
            const current = fs.readFileSync(absolute)
            if (!current.equals(snapshot.bytes)) {
                throw new MutationRestoreError(
                    [
                        `${mutant.file} 在本次运行期间被外部改动（既不是运行前的快照，也不是本工具写下的内容）：为了避免覆盖别人的改动，变异测试已停止。`,
                        '下一步：确认没有别的进程/代理在写这个文件，恢复到你期望的版本后重跑 mutation_check。',
                    ].join('\n'),
                )
            }
            const text = current.toString('utf8')
            const mutated = applyMutant(text, mutant)
            const before = now()
            let outcome: MutantCommandOutcome
            /** Set when the file no longer holds what this tool wrote (external writer). */
            let interference: string | undefined
            try {
                fs.writeFileSync(absolute, mutated, 'utf8')
                if (options.run === undefined) {
                    const raw = await runCommand(
                        {
                            argv: options.argv,
                            cwd: options.cwd,
                            timeoutMs: options.timeoutMs,
                            maxOutputBytes: options.maxOutputBytes ?? 64_000,
                            ...(options.signal === undefined ? {} : { signal: options.signal }),
                        },
                        options.subprocess?.() as never,
                    )
                    outcome = raw
                } else {
                    outcome = await options.run({
                        mutant,
                        argv: options.argv,
                        cwd: options.cwd,
                        timeoutMs: options.timeoutMs,
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                    })
                }
            } finally {
                // The whole point: on failure, timeout and abort alike, the
                // ORIGINAL BYTES go back before anything else happens. Before
                // overwriting, note whether the file still holds what we wrote:
                // if it does not, someone else edited it mid-run, and silently
                // restoring over their work would be the wrong kind of tidy.
                let afterRun: Buffer | undefined
                try {
                    afterRun = fs.readFileSync(absolute)
                } catch {
                    afterRun = undefined
                }
                if (afterRun === undefined || !afterRun.equals(Buffer.from(mutated, 'utf8'))) interference = mutant.id
                fs.writeFileSync(absolute, snapshot.bytes)
            }
            if (interference !== undefined) {
                throw new MutationRestoreError(
                    [
                        `${mutant.file} 在变异体 ${interference} 运行期间被外部改动：它既不是本工具写下的内容，也不是运行前的快照。`,
                        '为避免覆盖别人的改动，变异测试已停止；该文件已按运行前的字节快照还原，其余文件不受影响。',
                        '下一步：确认没有别的进程/代理在写这个文件，取得期望的版本后重跑 mutation_check。',
                    ].join('\n'),
                )
            }
            const restored = fs.readFileSync(absolute)
            if (!restored.equals(snapshot.bytes)) {
                throw new MutationRestoreError(
                    [
                        `${mutant.file} 在变异体 ${mutant.id} 运行后没有还原成功（字节与运行前快照不一致）。`,
                        '下一步：git checkout -- ' + mutant.file + '（或手动恢复该文件），然后重跑 mutation_check。',
                    ].join('\n'),
                )
            }
            const aborted = outcome.aborted === true
            const timedOut = outcome.timedOut === true
            const classified = classifyMutantOutcome(outcome)
            const durationMs = outcome.durationMs ?? now() - before
            const output = [outcome.stdout ?? '', outcome.stderr ?? '']
                .filter((part) => part.trim() !== '')
                .join('\n--- stderr ---\n')
            results.push({
                id: mutant.id,
                file: mutant.file,
                line: mutant.line,
                column: mutant.column,
                operator: mutant.operator,
                tokenBefore: mutant.tokenBefore,
                tokenAfter: mutant.tokenAfter,
                snippetBefore: mutant.snippetBefore,
                snippetAfter: mutant.snippetAfter,
                verdict: classified.verdict,
                exitCode: outcome.exitCode ?? null,
                timedOut,
                durationMs,
                reason: classified.reason,
                output: tail(output, 2_000),
            })
            logger?.debug(
                `mutation: ${mutant.id} → ${classified.verdict}（exit=${outcome.exitCode ?? 'null'}${timedOut ? '，超时' : ''}）`,
            )
            if (aborted || cancelled()) {
                stopped = 'aborted'
                break
            }
        }
    } finally {
        // Never leave a mutated byte behind — including on an exception above.
        for (const snapshot of snapshots.values()) {
            const absolute = path.join(options.cwd, snapshot.file)
            try {
                if (!fs.readFileSync(absolute).equals(snapshot.bytes)) fs.writeFileSync(absolute, snapshot.bytes)
            } catch (error) {
                logger?.warn(`mutation: 还原 ${snapshot.file} 失败`, error)
            }
        }
    }

    const mismatch = verify()
    if (mismatch !== undefined) {
        throw new MutationRestoreError(
            [
                `变异测试结束后，这些文件与运行前的字节快照不一致：${mismatch}。`,
                '本门禁会改写源码文件，因此"结束后工作区与运行前逐字节一致"是硬性要求；不满足时不给出任何裁决。',
                `下一步：先恢复这些文件（git checkout -- ${mismatch.split(', ').join(' ')}），确认没有别的进程在写它们，再重跑 mutation_check。`,
            ].join('\n'),
        )
    }

    const counts: MutationCounts = {
        executed: results.length,
        killed: results.filter((result) => result.verdict === 'killed').length,
        survived: results.filter((result) => result.verdict === 'survived').length,
        runError: results.filter((result) => result.verdict === 'run-error').length,
    }
    const scored = mutationScoreOf(counts)
    return {
        results,
        counts,
        ...(scored.score === undefined ? {} : { score: scored.score }),
        formula: scored.formula,
        stopped,
        planned: plan.mutants.length,
        available: plan.available,
        truncated: plan.truncated,
        timeBudgetMs: options.timeBudgetMs,
        elapsedMs: now() - started,
        files: [...new Set(results.map((result) => result.file))].sort(),
        survivors: results.filter((result) => result.verdict === 'survived'),
        notes,
    }
}

// --- test command resolution ------------------------------------------------

/**
 * Coverage-only decorations, stripped when a test command is derived from the
 * configured coverage command (`npx vitest run --coverage` → `npx vitest run`).
 */
export const COVERAGE_MARKERS: readonly RegExp[] = [
    /^--?cov(erage)?$/i,
    /^--cov(erage)?[.=]/i,
    /^--cover(profile|mode)$/i,
    /^--cover(profile|mode)=/i,
    /^--coverage[.=]/i,
    /^--reporters?[.=]/i,
    /^-coverprofile(=|$)/i,
    /^-covermode(=|$)/i,
    /^-cover$/i,
]

/**
 * Remove coverage decorations from an already-tokenised command.
 *
 * Works on argv (not on text) so a quoted argument containing a space stays one
 * element. Nothing is stripped when no decoration is recognised, and the caller
 * must treat "nothing stripped" as "this is not a test invocation" — guessing
 * which part of an unknown command runs the tests is exactly the kind of guess
 * this suite refuses to make.
 * @param argv - the tokenised coverage command.
 */
export function stripCoverageDecorations(argv: readonly string[]): { argv: string[]; stripped: string[] } {
    const stripped: string[] = []
    const kept = argv.filter((token) => {
        if (!COVERAGE_MARKERS.some((marker) => marker.test(token))) return true
        stripped.push(token)
        return false
    })
    return { argv: kept, stripped }
}

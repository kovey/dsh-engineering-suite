/**
 * Ruby's lexical half: tokens, method names, endless-definition detection and
 * parameter counting.
 *
 * Ruby has no braces to pair and no fixed signature shape (`def f(a)`,
 * `def f a, b` and `def self.f` are all legal), so the analysis in
 * `metrics-ruby.ts` needs a small tokenizer more than it needs a regex per
 * declaration. Keeping it apart makes the seam visible: nothing here knows about
 * block depth or `end`, and nothing there knows how a name is spelled.
 *
 * @module dsh-eng-core/metrics-ruby-lex
 */

/** Tokens after which a statement can start. */
const STATEMENT_START_SYMBOLS: ReadonlySet<string> = new Set([
    '=', '(', '[', '{', ',', ';', '|', '&', '!', ':', '+', '-', '*', '/', '%', '<', '>', '^', '~', '\\',
])

/** Words after which a statement can start (`= begin`, `then if`, visibility prefixes). */
const STATEMENT_START_WORDS: ReadonlySet<string> = new Set([
    'then', 'else', 'elsif', 'do', 'begin', 'rescue', 'ensure', 'when', 'and', 'or', 'not',
    'private', 'protected', 'public', 'module_function',
])

/** One lexical token: a word/identifier, or a single punctuation character. */
export function rubyTokens(line: string): string[] {
    const tokens: string[] = []
    let word = ''
    for (const char of line) {
        if ((char === '?' || char === '!') && word !== '' && !/[?!]$/.test(word)) {
            // `valid?` / `save!` are one name; `!x` is an operator.
            word += char
            continue
        }
        if (/[A-Za-z0-9_@$]/.test(char)) {
            word += char
            continue
        }
        if (word !== '') {
            tokens.push(word)
            word = ''
        }
        if (/\s/.test(char)) continue
        tokens.push(char)
    }
    if (word !== '') tokens.push(word)
    return tokens
}

/** Whether a keyword at this position starts a statement (not a modifier / a method call). */
export function rubyStatementStart(previous: string): boolean {
    if (previous === '') return true
    return STATEMENT_START_SYMBOLS.has(previous) || STATEMENT_START_WORDS.has(previous)
}

/** Index of the token after a `def`'s name (`def self.foo` skips `self.`). */
function rubyNameAt(tokens: readonly string[], defIndex: number): number {
    let cursor = defIndex + 1
    if (tokens[cursor] === 'self' && tokens[cursor + 1] === '.') cursor += 2
    return cursor
}

/** The declared name of a `def`, or `''` when the line does not name one. */
export function rubyDefName(tokens: readonly string[], defIndex: number): string {
    const cursor = rubyNameAt(tokens, defIndex)
    const token = tokens[cursor] ?? ''
    if (/^[A-Za-z_]/.test(token)) {
        // A setter (`def name=(value)`) carries its `=` in the name.
        return tokens[cursor + 1] === '=' && tokens[cursor + 2] === '(' ? `${token}=` : token
    }
    if (token === '[') return tokens[cursor + 1] === ']' && tokens[cursor + 2] === '=' ? '[]=' : '[]'
    return /^[-+*/%<>=!~^&|]+$/.test(token) ? token : ''
}

/**
 * Index of the LAST token of a `def`'s name (`def f`, `def self.f`, `def f=`, `def []=(`).
 *
 * The name is where a parse must resume: an `=` after it is either part of a
 * setter's name or the start of an endless definition, and those two cases have
 * opposite consequences for block depth.
 */
function rubyNameEnd(tokens: readonly string[], defIndex: number): number {
    const cursor = rubyNameAt(tokens, defIndex)
    if (tokens[cursor] === '[') return tokens[cursor + 2] === '=' ? cursor + 2 : cursor + 1
    return tokens[cursor + 1] === '=' && tokens[cursor + 2] === '(' ? cursor + 1 : cursor
}

/**
 * Whether a `def` header continues into an expression body (`def answer = 42`).
 *
 * Only an `=` at parenthesis depth 0 after the NAME counts; the `=` of a setter
 * name and the start of `==`/`=>`/`=~` do not.
 */
export function rubyEndless(tokens: readonly string[], defIndex: number): boolean {
    let parens = 0
    for (let index = rubyNameEnd(tokens, defIndex) + 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '(' || token === '[' || token === '{') parens += 1
        else if (token === ')' || token === ']' || token === '}') parens = Math.max(0, parens - 1)
        else if (parens === 0 && token === '=') {
            const next = tokens[index + 1] ?? ''
            return next !== '=' && next !== '>' && next !== '~'
        }
    }
    return false
}

/** Top-level comma count inside the parameter list that starts at `openIndex`. */
function rubyParamCount(tokens: readonly string[], openIndex: number): number {
    let depth = 0
    let count = 0
    let seen = false
    for (let index = openIndex; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '(' || token === '[' || token === '{') {
            depth += 1
            continue
        }
        if (token === ')' || token === ']' || token === '}') {
            depth -= 1
            if (depth === 0) return seen ? count + 1 : 0
            continue
        }
        if (depth !== 1) continue
        if (token === ',') count += 1
        else seen = true
    }
    return seen ? count + 1 : 0
}

/** Parameters of a `def` from the tokens right after its name (`def f a, b` included). */
export function rubyParams(tokens: readonly string[], defIndex: number): number {
    const start = rubyNameEnd(tokens, defIndex) + 1
    if (tokens[start] === '(') return rubyParamCount(tokens, start)
    // Parenthesis-less form: `def f a, b` — as many top-level commas as words.
    let count = 0
    let seen = false
    for (let cursor = start; cursor < tokens.length; cursor += 1) {
        const token = tokens[cursor] ?? ''
        if (token === ';' || token === '=') break
        if (token === ',') count += 1
        else if (token !== '&' && token !== '*' && token !== '**') seen = true
    }
    return seen ? count + 1 : 0
}

/**
 * Parameter counting — the one number every language's function signature
 * reduces to.
 *
 * It lives in its own module because six more languages now share it (Rust,
 * Java, Kotlin, C#, PHP, Swift alongside Go, TS/JS and Python), and because
 * `metrics.ts` hit its file-size ratchet: the seam is real, nothing here knows
 * about functions, spans, violations or baselines.
 *
 * The rule is lexical, and deliberately the same for every language: commas at
 * bracket depth 0 separate parameters. A comma inside a generic (`Map<string,
 * number>`), an array, a call in a default value or a tuple does not — so the
 * number is a count of *declared* parameters, not of everything that looks like
 * one.
 *
 * @module dsh-eng-core/metrics-params
 */

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
 * trailing comma (legal in Go, TS, Rust and Swift) is not an extra parameter. A
 * `<` that looks like a generic argument list counts as nesting, so
 * `(a: Map<string, number>)` is 1 and `(items: Vec<(A, B)>)` is 1.
 * @param text - the text BETWEEN the parameter parentheses.
 * @param generics - whether `<…>` may be a generic argument list.
 */
export function paramCount(text: string, generics: boolean): number {
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

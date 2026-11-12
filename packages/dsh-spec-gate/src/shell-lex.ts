/**
 * The lexical layer of the shell analyser: tokenising and quote/heredoc aware
 * text handling.
 *
 * Split out of `shell.ts` so the analyser's decision table and this mechanical
 * layer can be read (and measured) separately. Nothing here decides whether a
 * command writes — it only turns a command string into tokens or removes text
 * that is DATA (`echo "a > b"`, a heredoc body) rather than shell syntax.
 *
 * @module dsh-spec-gate/shell-lex
 */

/** Split a command into tokens, keeping quotes/operators meaningful enough. */
export function tokenize(command: string): string[] {
    const tokens: string[] = []
    let current = ''
    let quote: '"' | "'" | undefined
    let started = false
    for (const character of command) {
        if (quote !== undefined) {
            if (character === quote) quote = undefined
            else current += character
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            started = true
            continue
        }
        if (/\s/.test(character)) {
            if (started || current !== '') {
                tokens.push(current)
                current = ''
                started = false
            }
            continue
        }
        current += character
    }
    if (started || current !== '') tokens.push(current)
    return tokens
}

/** Blank out single/double quoted spans so operators inside them are inert. */
export function withoutQuotedSpans(command: string): string {
    let out = ''
    let quote: '"' | "'" | undefined
    for (const character of command) {
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined
                out += ' '
                continue
            }
            out += ' '
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            out += ' '
            continue
        }
        out += character
    }
    return out
}

/** `<<EOF`, `<<-'EOF'`, `<< "EOF"`: the marker that opens a heredoc. */
const HEREDOC_START = /<<-?\s*(?:['"]?)([A-Za-z_][A-Za-z0-9_]*)/

/**
 * Drop heredoc BODIES, keeping the line that opens each one.
 *
 * A heredoc body is DATA, never shell syntax: a commit message, a markdown snippet
 * or a code sample that happens to contain `>=` or `> out.txt` is not a
 * redirection. Reading it as shell produced two false positives in the wild — a
 * `git commit -F -` whose message said `apiVersion >= 1` was refused for "writing
 * `=`". The opening line IS kept, because a real redirect may precede the marker
 * (`cat > notes.md <<'EOF'`). An unterminated heredoc removes the rest of the
 * command: nothing after it could be trusted as shell syntax either.
 * @param command - the raw command string.
 * @returns the command with every heredoc body removed.
 */
export function stripHeredocs(command: string): string {
    const lines = command.split('\n')
    const kept: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        kept.push(line)
        const delimiter = HEREDOC_START.exec(line)?.[1]
        if (delimiter === undefined) continue
        // Skip the body, stopping ON the delimiter line so the loop's increment
        // consumes it and whatever follows the heredoc survives.
        index += 1
        while (index < lines.length && (lines[index] ?? '').trim() !== delimiter) index += 1
    }
    return kept.join('\n')
}

export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

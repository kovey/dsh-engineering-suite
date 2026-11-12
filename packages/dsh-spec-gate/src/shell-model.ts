/**
 * Shared shapes and operand helpers of the shell command models.
 *
 * `shell-tools.ts` (archive/move commands) and `shell-git.ts` (`git apply`)
 * both need the same "handled / targets / undecidable" result and the same
 * option-aware operand reading. Keeping them here is what stops the two models
 * from drifting into two different answers for the same token list — and it
 * keeps the module graph acyclic (`shell.ts` → model → model).
 *
 * @module dsh-spec-gate/shell-model
 */

/** What one command family appears to write. */
export interface ModeledWrite {
    /** The family recognised this command; the caller must not guess operands. */
    handled: boolean
    targets: string[]
    undecidable: boolean
    reasons: string[]
}

/** A nested analysis (structurally `shell.ts`'s `ShellAnalysis`). */
export interface NestedAnalysis {
    targets: string[]
    undecidable: boolean
    reasons: string[]
}

/** Input of one command model. */
export interface ModelContext {
    /** Tokens of one command (quotes removed, split on unquoted whitespace). */
    tokens: readonly string[]
    /** The whole raw command line (heredoc bodies included — `git apply` reads them). */
    command: string
    /** Current recursion depth (`sh -c` / `xargs` payloads). */
    depth: number
    /** Re-analyse one nested command line with a bounded depth. */
    analyze: (command: string, depth: number) => NestedAnalysis
}

/** A recognised command that writes exactly these targets. */
export function ok(targets: string[]): ModeledWrite {
    return { handled: true, targets, undecidable: false, reasons: [] }
}

/** A recognised command whose write target cannot be attributed (fail closed). */
export function undecidable(reason: string): ModeledWrite {
    return { handled: true, targets: [], undecidable: true, reasons: [reason] }
}

/** This module does not know the command; the caller keeps its own rules. */
export function notModeled(): ModeledWrite {
    return { handled: false, targets: [], undecidable: false, reasons: [] }
}

const DYNAMIC_TARGET = /[$`{}*?]|^~/

/** A target containing a variable, placeholder, brace or glob names no file. */
export function looksDynamic(target: string): boolean {
    return DYNAMIC_TARGET.test(target)
}

/** The value of `--name=value` / `--name value` / `-s value`, first occurrence. */
export function valueAfter(tokens: readonly string[], names: readonly string[]): string | undefined {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        for (const name of names) {
            if (token === name) {
                const next = tokens[index + 1]
                if (next !== undefined && next !== '') return next
            } else if (token.startsWith(`${name}=`)) {
                const inline = token.slice(name.length + 1)
                if (inline !== '') return inline
            }
        }
    }
    return undefined
}

/** Non-option operands, with the values of `valueOptions` skipped. */
export function operandsOf(tokens: readonly string[], valueOptions: readonly string[]): string[] {
    const operands: string[] = []
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '--') {
            operands.push(...tokens.slice(index + 1))
            break
        }
        if (!token.startsWith('-') || token === '-') {
            operands.push(token)
            continue
        }
        if (!token.includes('=') && valueOptions.includes(token)) index += 1
    }
    return operands
}

/** `dir` + `path`, without letting one leading `./` survive or a `/` double. */
export function joinTarget(directory: string, target: string): string {
    if (directory === '' || target.startsWith('/')) return target
    return `${directory.replace(/\/+$/, '')}/${target.replace(/^\.\//, '')}`
}

/**
 * `git apply` write-target model (see `shell-tools.ts` for the family list).
 *
 * `git apply` writes the paths inside a patch. The patch is visible when it is
 * a heredoc (`git apply <<'PATCH' … PATCH`), which is how a model usually feeds
 * one; when it is a file or a pipe the analyser cannot read it (it has no
 * working directory), so the only honest answers are `--directory DIR` or
 * `undecidable` — never "no targets, therefore no write".
 *
 * The subcommand itself is also read here because `git` puts global options
 * BEFORE it: `git -C dir apply` used to be read as subcommand `-C`, which is in
 * no write set, so the command passed as read-only.
 *
 * @module dsh-spec-gate/shell-git
 */

import { joinTarget, notModeled, ok, undecidable, type ModelContext, type ModeledWrite } from './shell-model.js'

/** Options of `git` that appear BEFORE the subcommand and consume a value. */
const GIT_GLOBAL_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']

/** Index of the `git` subcommand token, skipping global options (`-1` when absent). */
function gitSubcommandIndex(tokens: readonly string[]): number {
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (!token.startsWith('-') || token === '-') return index
        if (!token.includes('=') && GIT_GLOBAL_VALUE.includes(token)) index += 1
    }
    return -1
}

/**
 * The `git` subcommand, skipping global options.
 * @param tokens - the command's tokens.
 * @returns the subcommand token, when there is one.
 */
export function gitSubcommandOf(tokens: readonly string[]): string | undefined {
    const index = gitSubcommandIndex(tokens)
    return index === -1 ? undefined : tokens[index]
}

/**
 * `--directory` (after `apply`) or the global `-C DIR` (before it).
 *
 * After `apply`, `-C1` is git's context-line option, not a directory: a numeric
 * token there is skipped on purpose.
 */
function gitApplyDirectory(tokens: readonly string[], subIndex: number): string | undefined {
    for (let index = 1; index < subIndex; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '-C') return tokens[index + 1]
        if (token.startsWith('-C') && token.length > 2) return token.slice(2)
    }
    for (let index = subIndex + 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '--directory') return tokens[index + 1]
        if (token.startsWith('--directory=')) return token.slice('--directory='.length)
        if (/^-C\d+$/.test(token)) continue
        if (token === '-C') {
            const next = tokens[index + 1] ?? ''
            if (/^\d+$/.test(next)) continue
            return next
        }
        if (token.startsWith('-C') && token.length > 2) return token.slice(2)
    }
    return undefined
}

/** Paths a unified diff under `git apply` would write (the `+++`/`---` sides). */
function patchTargets(command: string): string[] {
    const found: string[] = []
    for (const line of command.split('\n')) {
        const match = /^(?:\+\+\+|---)\s+(?:"([^"]+)"|(\S+))/.exec(line.trim())
        const path = match?.[1] ?? match?.[2]
        if (path === undefined || path === '/dev/null') continue
        const stripped = path.replace(/^[ab]\//, '')
        if (stripped !== '' && !found.includes(stripped)) found.push(stripped)
    }
    return found
}

/** `git apply` modes that inspect the patch without writing anything. */
const GIT_APPLY_READ_ONLY = ['--stat', '--numstat', '--summary', '--check', '--list-files']

/**
 * Model `git apply`; every other `git` subcommand stays with the caller's rules.
 * @param context - tokens, the raw command line (patch heredoc included), depth.
 */
export function gitWrite(context: ModelContext): ModeledWrite {
    const index = gitSubcommandIndex(context.tokens)
    if (index === -1 || context.tokens[index] !== 'apply') return notModeled()
    if (context.tokens.some((token) => GIT_APPLY_READ_ONLY.includes(token))) return ok([])
    const directory = gitApplyDirectory(context.tokens, index)
    const patched = patchTargets(context.command)
    if (patched.length > 0) return ok(directory === undefined ? patched : patched.map((target) => joinTarget(directory, target)))
    if (directory !== undefined) return ok([directory])
    return undecidable('git apply 的补丁内容不可见（补丁来自文件或网络），且未声明 --directory/-C：写入目标无法归属')
}

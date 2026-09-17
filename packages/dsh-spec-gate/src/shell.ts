/**
 * Shell write-target extraction (docs.md §9: a boundary the gate cannot see is
 * not a boundary).
 *
 * `write`/`edit` declare `file_path`, but a shell tool (`bash`, `pwsh`) hides
 * its writes inside a command string. This module extracts the targets a shell
 * command would obviously write to, so the write guard can apply the same trust
 * root, boundary and negative-constraint checks to `echo x > ../../etc/passwd`
 * and `sed -i … src/a.ts` as it does to a `write` call.
 *
 * It is deliberately conservative: what it cannot attribute is reported as
 * `undecidable` (with the reason) instead of being silently allowed or blanket
 * denied; the host chooses the policy (`shellPolicy: 'targets' | 'strict' | 'off'`).
 *
 * @module dsh-spec-gate/shell
 */

/** What one shell command appears to write, and what could not be attributed. */
export interface ShellAnalysis {
    /** Write targets exactly as written in the command (may be relative). */
    targets: string[]
    /** The command is write-like but not fully attributable. */
    undecidable: boolean
    /** Human-readable reasons for `undecidable`. */
    reasons: string[]
}

/** Tools whose command string is analysed. */
export const DEFAULT_SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/** Commands whose operands are (or include) write targets. */
const WRITE_COMMANDS: Record<string, { targets: 'all' | 'last' | 'except-first'; reason: string }> = {
    rm: { targets: 'all', reason: 'rm 删除文件' },
    rmdir: { targets: 'all', reason: 'rmdir 删除目录' },
    touch: { targets: 'all', reason: 'touch 创建/更新时间戳' },
    truncate: { targets: 'all', reason: 'truncate 截断文件' },
    mkdir: { targets: 'all', reason: 'mkdir 创建目录' },
    cp: { targets: 'last', reason: 'cp 写入目标文件' },
    install: { targets: 'last', reason: 'install 写入目标文件' },
    mv: { targets: 'all', reason: 'mv 移动/覆盖文件' },
    ln: { targets: 'all', reason: 'ln 创建链接' },
    chmod: { targets: 'except-first', reason: 'chmod 修改权限位' },
    chown: { targets: 'except-first', reason: 'chown 修改属主' },
    tee: { targets: 'all', reason: 'tee 写入文件' },
}

/** Commands that write but whose targets cannot be attributed reliably. */
const UNDECIDABLE_COMMANDS: Record<string, string> = {
    find: 'find 的 -delete/-exec 会改动文件',
    git: 'git 子命令可能改写工作区（checkout/restore/apply/stash/clean）',
    npm: 'npm/pnpm 会改写 node_modules 与 lockfile',
    pnpm: 'npm/pnpm 会改写 node_modules 与 lockfile',
    yarn: '包管理器会改写 node_modules 与 lockfile',
    docker: 'docker 可能写入挂载的目录',
    make: '构建命令通常会写出产物',
    tsc: '编译器会写出产物',
    python: 'python 脚本可能写文件',
    python3: 'python 脚本可能写文件',
    node: 'node 脚本可能写文件',
    sh: '嵌套 shell 无法静态归属',
    bash: '嵌套 shell 无法静态归属',
    zsh: '嵌套 shell 无法静态归属',
    env: 'env 后的命令无法静态归属',
    xargs: 'xargs 会按参数执行命令',
    sudo: 'sudo 后的命令无法静态归属',
}

/** Split a command into tokens, keeping quotes/operators meaningful enough. */
function tokenize(command: string): string[] {
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

const REDIRECT = /^(?:\d?|&)>>?$/

/** Blank out single/double quoted spans so operators inside them are inert. */
function withoutQuotedSpans(command: string): string {
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

/** Split `a >b` / `a >> b` / `a 2> b` into segments and record the targets. */
function redirectTargets(command: string): { targets: string[]; segments: string[] } {
    const targets: string[] = []
    // Operators inside quotes are text, not redirections (`echo "> not a file"`).
    const unquoted = withoutQuotedSpans(command)
    // A target ends at whitespace or a shell separator.
    const pattern = /(\d?|&)>>?\s*([^\s;&|<>]+)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(unquoted)) !== null) {
        const target = (match[2] ?? '').trim()
        if (target !== '') targets.push(target)
    }
    // Token-level pass catches `>` written as its own token.
    const tokens = tokenize(command)
    const segments: string[] = []
    let current: string[] = []
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '>' || token === '>>') {
            const next = tokens[index + 1]
            if (next !== undefined) targets.push(next)
            index += 1
            segments.push(current.join(' '))
            current = []
            continue
        }
        if (REDIRECT.test(token)) {
            // `>foo` or `2>foo` written without a space.
            const inline = token.replace(REDIRECT, '')
            if (inline !== '') targets.push(inline)
            const next = tokens[index + 1]
            if (inline === '' && next !== undefined) {
                targets.push(next)
                index += 1
            }
            segments.push(current.join(' '))
            current = []
            continue
        }
        current.push(token)
    }
    segments.push(current.join(' '))
    return { targets, segments }
}

/**
 * Why one command is write-like but not attributable, or `undefined` when it is
 * plainly read-only.
 *
 * `git status` and `npm test` must stay runnable (they are how an agent looks
 * around and how a project verifies itself); only the subcommands that actually
 * mutate state are treated as unattributable writes.
 */
function undecidableReason(base: string, tokens: readonly string[]): string | undefined {
    const sub = tokens[1]
    if (base === 'git') {
        const WRITE_SUBCOMMANDS = new Set([
            'checkout', 'restore', 'switch', 'apply', 'stash', 'clean', 'reset', 'merge', 'rebase',
            'pull', 'cherry-pick', 'revert', 'rm', 'mv', 'add', 'commit', 'am', 'gc', 'init', 'clone',
        ])
        if (sub !== undefined && WRITE_SUBCOMMANDS.has(sub)) {
            return `git ${sub} 会改写工作区或仓库状态`
        }
        return undefined
    }
    if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
        const WRITE_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'ci', 'link', 'publish', 'pack', 'dedupe', 'prune', 'rebuild'])
        if (sub !== undefined && WRITE_SUBCOMMANDS.has(sub)) {
            return `${base} ${sub} 会改写 node_modules 与 lockfile`
        }
        return undefined
    }
    return UNDECIDABLE_COMMANDS[base]
}

/** Operand selection for one recognised command. */
function operandsFor(tokens: readonly string[], mode: 'all' | 'last' | 'except-first'): string[] {
    const operands = tokens.slice(1).filter((token) => token !== '' && !token.startsWith('-'))
    if (mode === 'last') return operands.slice(-1)
    if (mode === 'except-first') return operands.slice(1)
    return operands
}

/**
 * Analyse one shell command for write targets.
 * @param command - the raw command string.
 * @returns the extracted targets plus whether anything stayed unattributed.
 */
export function analyzeShellCommand(command: string): ShellAnalysis {
    const { targets: redirected, segments } = redirectTargets(command)
    const targets = [...redirected]
    const reasons: string[] = []
    let undecidable = false

    for (const segment of segments) {
        if (segment.trim() === '') continue
        const tokens = tokenize(segment)
        // A pipeline step: every command in it is examined.
        for (const part of segment.split(/\|\||&&|\||;/)) {
            const partTokens = tokenize(part.trim())
            const head = partTokens[0]
            if (head === undefined) continue
            const base = head.split('/').pop() ?? head
            const known = WRITE_COMMANDS[base]
            if (known !== undefined) {
                const found = operandsFor(partTokens, known.targets)
                for (const target of found) targets.push(target)
                continue
            }
            if (base === 'sed' || base === 'perl' || base === 'ruby') {
                // In-place edits name the file last.
                if (partTokens.some((token) => token === '-i' || token.startsWith('-i'))) {
                    const file = operandsFor(partTokens, 'last')[0]
                    if (file !== undefined) targets.push(file)
                    else {
                        undecidable = true
                        reasons.push(`${base} -i 的写法无法识别目标文件`)
                    }
                }
                continue
            }
            if (base === 'dd') {
                const of = partTokens.find((token) => token.startsWith('of='))
                if (of !== undefined) targets.push(of.slice(3))
                else {
                    undecidable = true
                    reasons.push('dd 未声明 of=，目标不可归属')
                }
                continue
            }
            const why = undecidableReason(base, partTokens)
            if (why !== undefined) {
                undecidable = true
                reasons.push(why)
            }
        }
        void tokens
    }

    // Writing to a device/sink is not a workspace change.
    const meaningful = targets.filter((target) => target !== '' && !target.startsWith('/dev/'))
    return { targets: [...new Set(meaningful)], undecidable, reasons: [...new Set(reasons)] }
}

/**
 * Extract the command string of a shell tool call.
 * @param args - parsed tool arguments.
 * @returns the command, when the shape is recognised.
 */
export function shellCommandOf(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined
    const record = args as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script', 'input']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return value
    }
    return undefined
}

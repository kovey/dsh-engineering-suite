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
function stripHeredocs(command: string): string {
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

/**
 * Does an unattributable command name a reviewed artifact?
 *
 * `shellPolicy: 'strict'` refuses shell commands whose write targets cannot be
 * attributed. That is right for arbitrary code, but it also refuses the
 * repository's own reviewed scripts (`bash scripts/verify.sh`), which is how a
 * gate becomes unusable and then gets switched off. `shellAllow` names those
 * artifacts; a command that matches one of the patterns is allowed and
 * everything else stays refused. Patterns are globs over the whole normalised
 * command; a command containing `..` never matches, because the point is "this
 * file was reviewed", and a traversal is not that file.
 * @param command - the raw command string.
 * @param patterns - glob patterns from the host configuration.
 * @returns whether the command may run despite being unattributable.
 */
export function matchesShellAllow(command: string, patterns: readonly string[]): boolean {
    const normalised = command.trim().replace(/\s+/g, ' ')
    if (normalised === '') return false
    if (normalised.indexOf('..') !== -1) return false
    for (const pattern of patterns) {
        if (patternMatches(pattern.trim(), normalised)) return true
    }
    return false
}

/** `*` stays inside one path segment, `**` crosses segments. */
function patternMatches(pattern: string, command: string): boolean {
    if (pattern === '') return false
    const halves = pattern.split('**')
    const parts: string[] = []
    for (const half of halves) {
        const pieces = half.split('*')
        const escaped: string[] = []
        for (const piece of pieces) escaped.push(escapeRegExp(piece))
        parts.push(escaped.join('[^/]*'))
    }
    const source = parts.join('.*')
    return new RegExp('^' + source + '(\\s.*)?$').test(command)
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split `a >b` / `a >> b` / `a 2> b` into segments and record the targets. */
function redirectTargets(command: string): { targets: string[]; segments: string[] } {
    const targets: string[] = []
    // Heredoc bodies are data (see `stripHeredocs`): both passes must read the
    // stripped text, or one of them still scans the body as shell.
    const stripped = stripHeredocs(command)
    // Operators inside quotes are text, not redirections (`echo "> not a file"`).
    const unquoted = withoutQuotedSpans(stripped)
    // A target ends at whitespace or a shell separator, and never STARTS with `=`:
    // the `=` in `apiVersion >= 1` is the tail of the comparison operator, not a
    // file name.
    const pattern = /(\d?|&)>>?\s*([^=\s;&|<>][^\s;&|<>]*)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(unquoted)) !== null) {
        const target = (match[2] ?? '').trim()
        if (target !== '') targets.push(target)
    }
    // Token-level pass catches `>` written as its own token.
    const tokens = tokenize(stripped)
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

// --- interpreter payloads ---------------------------------------------------
//
// The analyser used to look at the OUTER shell only, so a write performed inside
// a payload was invisible: `python3 - <<'PY' ... open('../../x','w') ... PY`
// rewrote files outside the mission's boundary and the guard never saw a target
// (found the hard way — a real edit through a heredoc slipped past it while the
// equivalent `cat >> file` was refused). Payloads are now inspected: a detected
// write with a literal path becomes a target (boundary-checked as usual), and a
// write whose path cannot be located is `undecidable` — fail closed, never
// "assume it is harmless".

/** Interpreters whose `-c`/`-e` payload is single-line code. */
const CODE_FLAG_INTERPRETERS: Record<string, readonly string[]> = {
    python: ['-c'],
    python3: ['-c'],
    node: ['-e', '--eval', '-p'],
    bun: ['-e', '--eval'],
    deno: ['eval'],
    ruby: ['-e'],
    perl: ['-e', '-E'],
    php: ['-r'],
}

/** Shells whose `-c` payload is itself a command line. */
const SHELL_COMMAND_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash'])

/** Write APIs per language. A hit means "this payload intends to write". */
const WRITE_INTENT: readonly RegExp[] = [
    // python
    /\bopen\s*\([^)]*[,)]\s*['"](?:w|a|x|w\+|a\+|x\+|wb|ab|w+b)['"]/,
    /\.write_(?:text|bytes)\s*\(/,
    /\bshutil\.(?:copy|copyfile|copy2|move|rmtree)\s*\(/,
    /\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|truncate)\s*\(/,
    // node / bun / deno
    /\bwriteFile(?:Sync)?\s*\(/,
    /\bappendFile(?:Sync)?\s*\(/,
    /\bcreateWriteStream\s*\(/,
    /\b(?:rm|rmdir|unlink|rename|mkdir|copyFile|truncate)\w*Sync\s*\(/,
    // ruby / perl / php
    /\bFile\.(?:write|open|delete|rename)\s*\(/,
    /\bIO\.write\s*\(/,
    /\bfile_put_contents\s*\(/,
    /\bunlink\s*\(/,
]

/** Extract quoted string literals that look like filesystem paths. */
function literalPathsIn(payload: string): string[] {
    const found: string[] = []
    const pattern = /(['"])([^'"\n]{1,300})\1/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(payload)) !== null) {
        const text = match[2] ?? ''
        if (text === '' || text.includes('://')) continue
        // A path-ish literal: has a separator or a dot, and no format placeholders.
        if (!/[/.~]/.test(text)) continue
        if (/[{}%]/.test(text)) continue // f-strings / format templates
        if (/^\s*$/.test(text)) continue
        found.push(text)
    }
    return found
}

/** The payload of one code-flag occurrence, or `undefined`. */
function codeFlagPayload(tokens: readonly string[], flags: readonly string[]): string | undefined {
    for (const [index, token] of tokens.entries()) {
        if (!flags.includes(token)) continue
        const next = tokens[index + 1]
        if (next !== undefined && next !== '') return next
    }
    return undefined
}

/** One heredoc body that is being piped into an interpreter's stdin. */
function stdinHeredocBodies(command: string, base: string): string[] {
    // `python3 - <<'PY' … PY` / `node <<'JS' … JS`: `-` means "read the program
    // from stdin", so the heredoc body IS code, not data.
    //
    // The base is validated and escaped before it goes into a RegExp: splitting on
    // `|` cuts THROUGH code payloads too (a python heredoc containing `'|'.join(…)`
    // or a regex), and the garbage "command" that produced used to be interpolated
    // raw — `new RegExp` then threw `Unmatched ')'` and took the whole guard down
    // for every command with a pipe inside a heredoc or a `-c` string.
    if (!/^[A-Za-z0-9_.-]+$/.test(base)) return []
    const escaped = escapeRegExp(base)
    if (!new RegExp(`(^|[\\s;&])${escaped}\\s+(-|--)\\s*<<`).test(command)) return []
    const bodies: string[] = []
    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
    let match: RegExpExecArray | null
    while ((match = opener.exec(command)) !== null) {
        const marker = match[2] ?? ''
        if (marker === '') continue
        const rest = command.slice(match.index + match[0].length)
        const end = new RegExp(`(^|\\n)\\t*${marker}\\s*(\\n|$)`)
        const stop = end.exec(rest)
        if (stop !== null) bodies.push(rest.slice(0, stop.index))
    }
    return bodies
}

/**
 * Findings from one command's inline interpreter payloads.
 * @param command - the raw command line (heredoc bodies still present).
 * @param depth - recursion depth for `sh -c` payloads.
 */
function interpreterPayloadFindings(
    command: string,
    depth: number,
): { targets: string[]; undecidable: boolean; reasons: string[] } {
    const targets: string[] = []
    const reasons: string[] = []
    let undecidable = false
    if (depth > 2) return { targets, undecidable, reasons }

    // Split on the STRIPPED command: a heredoc BODY is code, and its pipes (`|`)
    // would otherwise be cut as if they were shell operators, producing garbage
    // "commands" whose first token was then interpolated into a RegExp. The raw
    // text is still needed below to find the heredoc bodies themselves.
    const stripped = stripHeredocs(command)
    for (const part of stripped.split(/\|\||&&|\||;/)) {
        const tokens = tokenize(part.trim())
        const head = tokens[0]
        if (head === undefined) continue
        const base = head.split('/').pop() ?? head

        if (SHELL_COMMAND_INTERPRETERS.has(base)) {
            const payload = codeFlagPayload(tokens, ['-c'])
            if (payload !== undefined) {
                // The payload is a command line of its own: analyse it the same way.
                const nested = analyzeShellCommandNested(payload, depth + 1)
                targets.push(...nested.targets)
                if (nested.undecidable) {
                    undecidable = true
                    reasons.push(`${base} -c 载荷中有无法定位目标的写操作`)
                }
            }
            continue
        }

        const flags = CODE_FLAG_INTERPRETERS[base]
        const sources: string[] = []
        if (flags !== undefined) {
            const payload = codeFlagPayload(tokens, flags)
            if (payload !== undefined) sources.push(payload)
        }
        sources.push(...stdinHeredocBodies(command, base))
        if (sources.length === 0) continue

        for (const source of sources) {
            if (!WRITE_INTENT.some((pattern) => pattern.test(source))) continue
            const paths = literalPathsIn(source)
            if (paths.length === 0) {
                undecidable = true
                reasons.push(`${base} 的内联载荷里有写操作，但目标路径不是字面量（变量/拼装/子进程），无法归属到文件边界`)
                continue
            }
            targets.push(...paths)
        }
    }
    return { targets, undecidable, reasons }
}

/**
 * Analyse a nested command line with a bounded depth (used for `sh -c` payloads).
 * @param command - the payload.
 * @param depth - recursion depth.
 */
function analyzeShellCommandNested(command: string, depth: number): ShellAnalysis {
    const inner = analyzeShellCommandInner(command, depth)
    return inner
}

export function analyzeShellCommand(command: string): ShellAnalysis {
    return analyzeShellCommandInner(command, 0)
}

function analyzeShellCommandInner(command: string, depth: number): ShellAnalysis {
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

    // Inline interpreter payloads: the blind spot this closes.
    const payload = interpreterPayloadFindings(command, depth)
    targets.push(...payload.targets)
    if (payload.undecidable) {
        undecidable = true
        reasons.push(...payload.reasons)
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

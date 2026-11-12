/**
 * Write-target modelling for shell commands whose operands are not a plain
 * "last argument" (docs/ARCHITECTURE.md §5.31).
 *
 * `shell.ts` reads an operand position (`cp` writes its last operand,
 * `chmod` every non-first one). That is exactly wrong for archive/directory
 * commands: `tar -x -C .dsh -f a.tar` writes the DIRECTORY, `xargs -I{} cp {}
 * .dsh/` writes whatever its downstream command writes, `rsync` writes its
 * destination and `install -t DIR` writes DIR. Those forms used to reach the
 * shell untouched while the equivalent `cat >> .dsh/...` was refused.
 *
 * Each model returns a `handled` result once it recognises its command family,
 * so the caller does NOT fall back to operand guessing (a `mv -t DIR src` read
 * as "last operand" would name the source and miss the directory). What cannot
 * be attributed is `undecidable` — fail closed, never "assume it is harmless".
 *
 * The nested analyser is injected as a callback instead of imported from
 * `shell.ts`: `shell.ts` imports this module, and a second import edge back
 * would be a cycle (`forbidCycles`) — and a cycle in an analyser is how a
 * recursive command becomes a stack overflow.
 *
 * @module dsh-spec-gate/shell-tools
 */

import {
    joinTarget,
    looksDynamic,
    ok,
    operandsOf,
    undecidable,
    valueAfter,
    type ModelContext,
    type ModeledWrite,
} from './shell-model.js'
import { gitWrite } from './shell-git.js'

/** `tar`: extract writes `-C DIR` (cwd when absent), create writes `-f FILE`. */
const TAR_MODE_FLAGS = 'xcrtuO'

function tarWrite(tokens: readonly string[]): ModeledWrite {
    const modes = new Set<string>()
    let directory: string | undefined
    let archive: string | undefined
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token.startsWith('--')) {
            const equals = token.indexOf('=')
            const name = equals === -1 ? token : token.slice(0, equals)
            const value = equals !== -1 ? token.slice(equals + 1) : tokens[index + 1]
            if (name === '--extract' || name === '--get') modes.add('x')
            else if (name === '--create') modes.add('c')
            else if (name === '--list') modes.add('t')
            else if (name === '--append') modes.add('r')
            else if (name === '--update') modes.add('u')
            else if (name === '--to-stdout') modes.add('O')
            else if (name === '--directory' && value !== undefined) {
                directory = value
                if (equals === -1) index += 1
            } else if (name === '--file' && value !== undefined) {
                archive = value
                if (equals === -1) index += 1
            }
            continue
        }
        if (!token.startsWith('-') || token === '-') continue
        for (let position = 1; position < token.length; position += 1) {
            const letter = token[position] ?? ''
            if (letter === 'C' || letter === 'f') {
                const attached = token.slice(position + 1)
                const value = attached !== '' ? attached : tokens[index + 1]
                if (letter === 'C') directory = value
                else archive = value
                if (attached === '') index += 1
                break
            }
            if (TAR_MODE_FLAGS.includes(letter)) modes.add(letter)
        }
    }
    if (modes.has('t') || modes.has('O')) return ok([])
    if (modes.has('x')) return archive === '-' ? ok([]) : ok([directory ?? '.'])
    if (modes.has('c') || modes.has('r') || modes.has('u')) {
        if (archive === undefined || archive === '-') return undecidable('tar 创建/追加归档时没有 -f 目标文件，写入目标无法归属')
        return ok([archive])
    }
    return undecidable('tar 的模式（-x/-c/-t/-r/-u）无法识别，写入目标无法归属')
}

/** Options of `xargs` that consume the following token as their value. */
const XARGS_VALUE = ['-I', '-n', '-P', '-d', '-L', '-s', '-a', '-E', '--arg-file', '--delimiter', '--eof', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--replace', '--process-slot-var']

/** Quote one token back into a command line (`cp {} x` must stay three words). */
function quoteToken(token: string): string {
    return /\s/.test(token) ? JSON.stringify(token) : token
}

/** `xargs`: re-analyse the command it will run, downstream and recursively. */
function xargsWrite(context: ModelContext): ModeledWrite {
    let start = context.tokens.length
    for (let index = 1; index < context.tokens.length; index += 1) {
        const token = context.tokens[index] ?? ''
        if (token === '--') {
            start = index + 1
            break
        }
        if (!token.startsWith('-') || token === '-') {
            start = index
            break
        }
        if (!token.includes('=') && XARGS_VALUE.includes(token)) index += 1
    }
    const downstream = context.tokens.slice(start)
    // No downstream command means `echo`: xargs reads stdin and writes nothing.
    if (downstream.length === 0) return ok([])
    const first = downstream[0] ?? ''
    const payloadAt = downstream.indexOf('-c')
    const payload = payloadAt === -1 ? undefined : downstream[payloadAt + 1] ?? ''
    // A variable in COMMAND position names no command (`xargs $COMMAND`,
    // `xargs sh -c "$RUN"`). A placeholder in an ARGUMENT position is fine here:
    // the recursion names the real target and filters dynamic ones itself.
    const payloadCommand = payload === undefined ? '' : payload.trim().split(/\s+/)[0] ?? ''
    if (looksDynamic(first) || (payload !== undefined && looksDynamic(payloadCommand))) {
        return undecidable(`xargs 的下游命令是变量/展开（${looksDynamic(first) ? first : payloadCommand}），无法静态归属写入目标`)
    }
    if (context.depth > 2) return undecidable('xargs 的下游命令嵌套过深，无法静态归属写入目标')
    const nested = context.analyze(downstream.map(quoteToken).join(' '), context.depth + 1)
    const placeholders = nested.targets.filter(looksDynamic)
    if (placeholders.length > 0) return undecidable(`xargs 下游写入目标是占位符/变量（${placeholders.slice(0, 3).join(', ')}），无法归属到具体文件`)
    return { handled: true, targets: nested.targets, undecidable: nested.undecidable, reasons: nested.reasons }
}

/** `rsync` options that consume a value (the destination is the last operand). */
const RSYNC_VALUE = ['-e', '--rsh', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--files-from', '--rsync-path', '--password-file', '--port', '--sockopts', '--timeout', '--contimeout', '--bwlimit', '--backup-dir', '--suffix', '--chmod', '--chown', '--usermap', '--groupmap', '--temp-dir', '-T', '--partial-dir', '--compare-dest', '--copy-dest', '--link-dest', '--log-file', '--out-format', '--log-file-format', '--remote-option', '-M']
const REMOTE_SPEC = /^(?:rsync:\/\/|[^/@\s]*@?[^/\s:]+:)/

function rsyncWrite(tokens: readonly string[]): ModeledWrite {
    const operands = operandsOf(tokens, RSYNC_VALUE)
    if (operands.length < 2) return undecidable('rsync 没有可识别的源/目标（或目标被选项吞掉），写入目标无法归属')
    const destination = operands[operands.length - 1] ?? ''
    if (REMOTE_SPEC.test(destination)) return undecidable(`rsync 的目标是远端（${destination}），远端写入无法用本地文件边界校验`)
    return ok([destination])
}

/** `unzip -d DIR` writes DIR; without `-d` it writes the current directory. */
function unzipWrite(tokens: readonly string[]): ModeledWrite {
    let directory: string | undefined
    let listed = false
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ''
        if (token === '-d' || token === '--directory') {
            const next = tokens[index + 1]
            if (next === undefined || next === '') return undecidable('unzip -d 缺少目录参数，写入目标无法归属')
            directory = next
            index += 1
            continue
        }
        if (token.startsWith('-d') && token.length > 2 && !token.startsWith('--')) {
            directory = token.slice(2)
            continue
        }
        if (/^-[ltpvZ]+$/.test(token)) listed = true
    }
    if (listed) return ok([])
    return ok([directory ?? '.'])
}

const MV_VALUE = ['-t', '--target-directory', '-S', '--suffix']
const INSTALL_VALUE = ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory', '-S', '--suffix', '--strip-program']

/** `mv`: the destination when known, and every source (a move removes it too). */
function mvWrite(tokens: readonly string[]): ModeledWrite {
    const directory = valueAfter(tokens, ['-t', '--target-directory'])
    const operands = operandsOf(tokens, MV_VALUE)
    if (directory !== undefined) return ok([directory, ...operands])
    if (operands.length < 2) return undecidable('mv 的源/目标数量不足（或目标被选项吞掉），写入目标无法归属')
    return ok(operands)
}

/** `install`: `-t DIR` / `-d` name directories, otherwise the destination is last. */
function installWrite(tokens: readonly string[]): ModeledWrite {
    const directory = valueAfter(tokens, ['-t', '--target-directory'])
    const operands = operandsOf(tokens, INSTALL_VALUE)
    const makeDirectories = tokens.some((token) => token === '--directory' || /^-[a-zA-Z]*d/.test(token))
    if (directory !== undefined) return ok([directory])
    if (makeDirectories) return operands.length === 0 ? undecidable('install -d 没有声明目录，写入目标无法归属') : ok(operands)
    if (operands.length < 2) return undecidable('install 的源/目标数量不足（或目标被选项吞掉），写入目标无法归属')
    return ok(operands.slice(-1))
}

/**
 * Model the command families `shell.ts` cannot read by operand position.
 * @param context - tokens, the raw command line, depth and the nested analyser.
 * @returns `handled: false` when no model knows the command.
 */
export function modelShellWrite(context: ModelContext): ModeledWrite {
    const head = context.tokens[0] ?? ''
    const base = head.split('/').pop() ?? head
    if (base === 'tar') return tarWrite(context.tokens)
    if (base === 'xargs') return xargsWrite(context)
    if (base === 'rsync') return rsyncWrite(context.tokens)
    if (base === 'unzip') return unzipWrite(context.tokens)
    if (base === 'mv') return mvWrite(context.tokens)
    if (base === 'install') return installWrite(context.tokens)
    if (base === 'git') return gitWrite(context)
    return { handled: false, targets: [], undecidable: false, reasons: [] }
}

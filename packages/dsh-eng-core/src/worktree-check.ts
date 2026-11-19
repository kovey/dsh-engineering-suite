/**
 * The checks one task worktree is allowed to run (AC-002).
 *
 * A worker's worktree is not the delivery tree: running the repository's full
 * acceptance run there would (a) pay the whole suite's cost per task, (b) report
 * a FAILURE for every other task's not-yet-existing file, and (c) tempt a future
 * reader into treating a partial-scope green as delivery evidence (AC-010 says it
 * never is). So this module narrows the run to the packages the task actually
 * touched, through the SAME scripts the full run uses:
 *
 *   `bash scripts/test-all.sh --quiet <pkg…>`  and
 *   `bash scripts/typecheck-all.sh <pkg…>`
 *
 * Two deliberate limits:
 *
 *  - **never** `scripts/verify.sh` and **never** `scripts/standards-check.sh`:
 *    both are repository-wide by contract (verify adds the cross-package test and
 *    the tooling self-test; standards scans every file). Using them here would
 *    make the "affected packages only" promise false;
 *  - the package list is the DEPENDENCY CLOSURE of the touched packages, built in
 *    dependency order: a worktree has no `dist/`, so testing `dsh-orchestrator`
 *    without building `dsh-eng-core` first fails for a reason that has nothing to
 *    do with the change.
 *
 * When the change set cannot be narrowed (the tooling itself, workspace root
 * configuration), the answer is the full package list and a note saying so —
 * another change set may not be silently treated as "nothing to check".
 *
 * @module dsh-eng-core/worktree-check
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Input of {@link runTaskChecks}. */
export interface TaskCheckInput {
    /** Absolute path of the task worktree. */
    worktree: string
    /** Workspace-relative paths the task changed (`.dsh/` excluded by the caller). */
    changedPaths: readonly string[]
    /** Environment of the child processes (tests; default `process.env`). */
    env?: NodeJS.ProcessEnv
    /** Per-command deadline in ms (default 600000; 0/absent = no deadline). */
    timeoutMs?: number
}

/** One command that ran, and what it said (the tail is bounded on purpose). */
export interface TaskCheckCommand {
    /** `bash scripts/test-all.sh` / `bash scripts/typecheck-all.sh`. */
    script: string
    args: string[]
    exitCode: number | null
    ok: boolean
    /** Last lines of stdout+stderr. */
    outputTail: string
}

/** Outcome of one check run. */
export interface TaskCheckResult {
    ok: boolean
    worktree: string
    /** The packages checked (dependency order). */
    packages: string[]
    /** `true` when the change set could not be narrowed, so every package ran. */
    full: boolean
    commands: TaskCheckCommand[]
    /** Non-fatal facts (why every package ran, why nothing ran). */
    notes: string[]
    problems: string[]
}

/** Workspace-relative, forward slashes, no leading `./`. */
function normalize(file: string): string {
    return file.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** The package a workspace path belongs to (`packages/<name>/…`). */
export function packageOfPath(file: string): string | undefined {
    const match = /^packages\/([^/]+)\//.exec(normalize(file))
    return match?.[1]
}

/** Root-level paths whose change affects every package (tooling / workspace config). */
function affectsEveryPackage(file: string): boolean {
    const normalized = normalize(file)
    if (normalized.startsWith('scripts/') || normalized.startsWith('test/')) return true
    return ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json'].includes(normalized)
}

/** Every workspace package present in the worktree, alphabetical. */
function workspacePackages(worktree: string): string[] {
    const dir = path.join(worktree, 'packages')
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'package.json')))
            .map((entry) => entry.name)
            .sort()
    } catch {
        return []
    }
}

/** Workspace packages one package depends on (its closure step, one edge). */
function workspaceDeps(worktree: string, name: string): string[] {
    const manifest = path.join(worktree, 'packages', name, 'package.json')
    try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>
        const deps = { ...(parsed['dependencies'] ?? {}), ...(parsed['devDependencies'] ?? {}) } as Record<string, unknown>
        const known = new Set(workspacePackages(worktree))
        return Object.keys(deps).filter((dep) => known.has(dep))
    } catch {
        return []
    }
}

/**
 * The dependency closure of `names`, in build order (dependencies first).
 *
 * Kahn with alphabetical tie-breaks, like `scripts/package-order.py` — the build
 * scripts this feeds are sensitive to order, so "a set" is not enough.
 */
export function closureInOrder(worktree: string, names: readonly string[]): string[] {
    const known = new Set(workspacePackages(worktree))
    const wanted = new Set<string>()
    const queue = [...names.filter((name) => known.has(name))]
    while (queue.length > 0) {
        const name = queue.pop() as string
        if (wanted.has(name)) continue
        wanted.add(name)
        for (const dep of workspaceDeps(worktree, name)) if (!wanted.has(dep)) queue.push(dep)
    }
    const pending = new Map([...wanted].map((name) => [name, new Set(workspaceDeps(worktree, name).filter((dep) => wanted.has(dep)))]))
    const ordered: string[] = []
    while (pending.size > 0) {
        const ready = [...pending.keys()].filter((name) => (pending.get(name) as Set<string>).size === 0).sort()
        if (ready.length === 0) {
            // A dependency cycle: emit the rest alphabetically (the build scripts
            // will report it) instead of hanging or dropping packages silently.
            ordered.push(...[...pending.keys()].sort())
            break
        }
        for (const name of ready) {
            ordered.push(name)
            pending.delete(name)
        }
        for (const deps of pending.values()) for (const name of ready) deps.delete(name)
    }
    return ordered
}

/** The packages a change set touches, plus why it might be all of them. */
export function affectedPackages(worktree: string, changedPaths: readonly string[]): { packages: string[]; full: boolean; notes: string[] } {
    const notes: string[] = []
    const full = changedPaths.some((file) => affectsEveryPackage(file))
    if (full) {
        const all = closureInOrder(worktree, workspacePackages(worktree))
        notes.push(`改动包含工具链/工作区根配置（${changedPaths.filter((file) => affectsEveryPackage(file)).join('、')}）：按全部 ${all.length} 个包检查`)
        return { packages: all, full: true, notes }
    }
    const direct = [...new Set(changedPaths.map((file) => packageOfPath(file)).filter((name): name is string => name !== undefined))]
    const packages = closureInOrder(worktree, direct)
    notes.push(direct.length === 0 ? '改动不涉及 packages/ 下任何包：没有受影响的包可检查' : `受影响包（含依赖闭包，按构建顺序）：${packages.join(', ')}`)
    return { packages, full: false, notes }
}

/** The last lines of one command's output. */
function tail(stdout: string, stderr: string, max = 1200): string {
    const text = [stdout, stderr].filter((part) => part.trim() !== '').join('\n').trim()
    return text.length <= max ? text : `…${text.slice(-max)}`
}

/** Run one package-scoped script; a missing script is a problem, not a skip. */
function runScript(input: { worktree: string; script: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }): TaskCheckCommand {
    const file = path.join(input.worktree, 'scripts', path.basename(input.script))
    if (!fs.existsSync(file)) {
        return { script: input.script, args: input.args, exitCode: null, ok: false, outputTail: `${file} 不存在：无法在 worktree 里跑 ${input.script}` }
    }
    const result = spawnSync('bash', [file, ...input.args], {
        cwd: input.worktree,
        encoding: 'utf8',
        env: input.env,
        ...(input.timeoutMs > 0 ? { timeout: input.timeoutMs } : {}),
    })
    const exitCode = result.error === undefined ? result.status : null
    const outputTail = result.error === undefined ? tail(result.stdout ?? '', result.stderr ?? '') : result.error.message
    return { script: input.script, args: input.args, exitCode, ok: exitCode === 0, outputTail }
}

/**
 * Run the affected packages' tests and type-check inside one task worktree.
 *
 * @param input - the worktree and the changed paths (workspace-relative).
 * @returns every command, the package list it used, and whether it all passed.
 *   Never throws: a missing script or a failing command is a result (`ok: false`).
 */
export function runTaskChecks(input: TaskCheckInput): TaskCheckResult {
    const worktree = path.resolve(input.worktree)
    const env = input.env ?? process.env
    const timeoutMs = input.timeoutMs ?? 600_000
    if (!fs.existsSync(worktree)) {
        return { ok: false, worktree, packages: [], full: false, commands: [], notes: [], problems: [`worktree ${worktree} 不存在：没有可检查的对象`] }
    }
    const affected = affectedPackages(worktree, input.changedPaths)
    if (affected.packages.length === 0) {
        return { ok: true, worktree, packages: [], full: affected.full, commands: [], notes: affected.notes, problems: [] }
    }
    const commands = [
        runScript({ worktree, script: 'scripts/test-all.sh', args: ['--quiet', ...affected.packages], env, timeoutMs }),
        runScript({ worktree, script: 'scripts/typecheck-all.sh', args: [...affected.packages], env, timeoutMs }),
    ]
    const problems = commands.filter((command) => !command.ok).map((command) => `${command.script} ${command.args.join(' ')} 未通过（exit ${String(command.exitCode)}）：${command.outputTail}`)
    return { ok: problems.length === 0, worktree, packages: affected.packages, full: affected.full, commands, notes: affected.notes, problems }
}

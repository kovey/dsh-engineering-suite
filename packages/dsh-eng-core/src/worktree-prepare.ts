/**
 * Preparing a task worktree so its worker can actually build and test (AC-002).
 *
 * A `git worktree` is a checkout, not an installation: `node_modules/` is
 * gitignored, so a freshly created worktree cannot run a script that needs
 * typescript, a test runner or the workspace links. This module is the ONE step
 * between "the worktree exists" and "the worker can run the checks":
 *
 *  - **the main tree's pnpm store is reused** (`pnpm store path`), so the
 *    install downloads nothing it already has; when the probe fails the main
 *    tree's own `node_modules/.pnpm-store` is used if it exists, and when even
 *    that is missing the store flag is dropped and SAID so (never silently
 *    pointing at a store nobody verified);
 *  - **it is idempotent** — a worktree that already has `node_modules` is
 *    reported as `skipped`, so a retried dispatch does not reinstall;
 *  - **a failure keeps the directory** — a half-installed worktree is the only
 *    copy of whatever the worker already wrote, and a "clean up after yourself"
 *    here would delete unimported evidence (AC-003/AC-009). The failure is a
 *    result with `ok: false` and the install output's tail, never an exception.
 *
 * The pnpm binary is injectable (`pnpm` + `env`) so the tests drive a fake
 * executable instead of the network: a smoke test that needs the registry is not
 * a test. Production passes nothing and gets `pnpm` from PATH.
 *
 * @module dsh-eng-core/worktree-prepare
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveLayout, type Layout } from './paths.js'
import { splitWorktreeDir } from './split-plan.js'

/** Input of {@link prepareTaskWorktree}. */
export interface PrepareWorktreeInput {
    /** Absolute path of the main work tree. */
    mainTree: string
    missionId: string
    taskId: string
    /** Layout override (tests / a relocated trail). */
    layout?: Layout
    /** pnpm executable (default `pnpm`; tests point at a fake one). */
    pnpm?: string
    /** Install deadline in ms (default 600000; 0/absent = no deadline). */
    timeoutMs?: number
    /** Environment of the child process (tests; default `process.env`). */
    env?: NodeJS.ProcessEnv
}

/** Outcome of one preparation. */
export interface PrepareWorktreeResult {
    ok: boolean
    /** Absolute worktree path (known even on failure). */
    worktree: string
    /** `true` when nothing was installed (`node_modules` already present, or no manifest). */
    skipped: boolean
    /** The store directory passed to pnpm, when one was resolved. */
    storeDir?: string
    /** Where the store directory came from (`probe` / `fallback`). */
    storeSource?: 'probe' | 'fallback'
    /** What ran (`['pnpm', 'install', '--prefer-offline']`), empty when skipped. */
    command: string[]
    /** Non-fatal notes (a dropped store flag, a skipped install). */
    notes: string[]
    problems: string[]
}

/** One child invocation; never throws (a spawn error is a result). */
function run(bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): { status: number | null; stdout: string; stderr: string; error?: string } {
    const options = {
        cwd,
        encoding: 'utf8' as const,
        env,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    }
    const result = spawnSync(bin, [...args], options)
    if (result.error !== undefined) return { status: null, stdout: '', stderr: '', error: result.error.message }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The last lines of a command's output (a gate must not forward a whole log). */
function tail(stdout: string, stderr: string, max = 1200): string {
    const text = [stdout, stderr].filter((part) => part.trim() !== '').join('\n').trim()
    return text.length <= max ? text : `…${text.slice(-max)}`
}

/** Everything a store probe needs (one parameter object: the rule is per function). */
interface StoreProbe {
    pnpm: string
    mainTree: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
}

/** The pnpm store directory of the main tree, and where that answer came from. */
function resolveStore(probe: StoreProbe): { storeDir?: string; source?: 'probe' | 'fallback'; notes: string[] } {
    const probed = run(probe.pnpm, ['store', 'path'], probe.mainTree, probe.env, probe.timeoutMs)
    const fromProbe = probed.status === 0 ? probed.stdout.trim() : ''
    if (fromProbe !== '') return { storeDir: fromProbe, source: 'probe', notes: [`复用主树 pnpm store：${fromProbe}`] }
    const reason = probed.error ?? tail(probed.stdout, probed.stderr) ?? `exit ${String(probed.status)}`
    const fallback = path.join(probe.mainTree, 'node_modules', '.pnpm-store')
    if (fs.existsSync(fallback)) {
        return { storeDir: fallback, source: 'fallback', notes: [`pnpm store path 不可用（${reason}）：改用主树的 ${fallback}`] }
    }
    return { notes: [`pnpm store path 不可用（${reason}）且主树没有 node_modules/.pnpm-store：不传 --store-dir，按 pnpm 自身默认 store 安装`] }
}

/** Whether the install is even needed (idempotence + a worktree without a manifest). */
function skipReasonOf(worktree: string): string | undefined {
    if (fs.existsSync(path.join(worktree, 'node_modules'))) return 'worktree 里已经有 node_modules：跳过安装（幂等）'
    if (!fs.existsSync(path.join(worktree, 'package.json'))) return 'worktree 里没有 package.json：没有依赖可安装'
    return undefined
}

/** The failure result of a prepare (never deletes anything). */
function failed(worktree: string, problems: string[], notes: string[], command: string[]): PrepareWorktreeResult {
    return { ok: false, worktree, skipped: false, command, notes, problems }
}

/**
 * Install the dependencies of one task worktree (AC-002).
 *
 * @param input - the main tree, the mission/task ids and the (test-injectable)
 *   pnpm binary/environment.
 * @returns `ok` plus the worktree, the resolved store and every problem found;
 *   a failed prepare KEEPS the directory and says so.
 */
export function prepareTaskWorktree(input: PrepareWorktreeInput): PrepareWorktreeResult {
    const mainTree = path.resolve(input.mainTree)
    const layout = input.layout ?? resolveLayout(mainTree)
    const worktree = splitWorktreeDir(layout, input.missionId, input.taskId)
    if (!fs.existsSync(worktree)) {
        return failed(worktree, [`worktree ${worktree} 不存在：先 createTaskWorktree，再 prepare（不会替调用方建目录）`], [], [])
    }
    const skipped = skipReasonOf(worktree)
    if (skipped !== undefined) return { ok: true, worktree, skipped: true, command: [], notes: [skipped], problems: [] }
    const pnpm = input.pnpm ?? 'pnpm'
    const env = input.env ?? process.env
    const timeoutMs = input.timeoutMs ?? 600_000
    const store = resolveStore({ pnpm, mainTree, env, timeoutMs })
    const args = ['install', '--prefer-offline', ...(store.storeDir === undefined ? [] : ['--store-dir', store.storeDir])]
    const installed = run(pnpm, args, worktree, env, timeoutMs)
    const command = [pnpm, ...args]
    if (installed.status !== 0) {
        return failed(
            worktree,
            [
                `${command.join(' ')} 失败（exit ${String(installed.status)}${installed.error === undefined ? '' : `，${installed.error}`}）：${tail(installed.stdout, installed.stderr)}`,
                `目录保持原样：${worktree}（失败的 worktree 可能是这个子任务唯一的证据副本，不会删除）`,
            ],
            store.notes,
            command,
        )
    }
    return {
        ok: true,
        worktree,
        skipped: false,
        command,
        ...(store.storeDir === undefined ? {} : { storeDir: store.storeDir }),
        ...(store.source === undefined ? {} : { storeSource: store.source }),
        notes: store.notes,
        problems: [],
    }
}

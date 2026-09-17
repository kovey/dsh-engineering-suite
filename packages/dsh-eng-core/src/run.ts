/**
 * Deterministic command execution for the gates.
 *
 * The gates execute **host-configured** commands (docs.md §9: "门禁的确定性
 * 来源是宿主配置，不是模型输出"), never a model-authored string. Two
 * transports exist and are tried in order:
 *
 *  1. `ctx.subprocess` — the harness seam. Preferred because the provider owns
 *     sandboxing, spill files, and process-range teardown.
 *  2. `node:child_process` — always available, used by unit tests and by hosts
 *     without the subprocess service.
 *
 * Both paths return the same normalised outcome, so a gate's verdict does not
 * depend on which transport served it.
 *
 * @module dsh-eng-core/run
 */

import { spawn } from 'node:child_process'
import { sha256, tail } from './digest.js'

/** Structural view of `ctx.subprocess` (no runtime dependency on the package). */
export interface SubprocessLike {
    spawn(spec: {
        argv: readonly string[]
        cwd: string
        stdio: {
            stdin: 'ignore'
            stdout: { maxBytes: number }
            stderr: { maxBytes: number }
        }
        graceMs: number
        signal?: AbortSignal
        env?: NodeJS.ProcessEnv
    }): {
        readonly done: Promise<{ exitCode: number | null; signal: string | null }>
        readonly collected: {
            readonly stdout?: { readFrom(offset: number): { text: string } }
            readonly stderr?: { readFrom(offset: number): { text: string } }
        }
        terminate(): void
    }
}

/** One command to execute. */
export interface RunSpec {
    /** Executable and arguments; `argv[0]` is the program. */
    argv: readonly string[]
    /** Working directory. */
    cwd: string
    /** Cooperative deadline; on expiry the process is terminated. */
    timeoutMs?: number
    /** Caller cancellation (turn abort). */
    signal?: AbortSignal
    /** Extra environment entries. */
    env?: Record<string, string | undefined>
    /** Per-stream capture cap in bytes (tail kept). */
    maxOutputBytes?: number
    /** TERM→KILL grace for the node transport. */
    graceMs?: number
}

/** Normalised outcome shared by both transports. */
export interface RunOutcome {
    argv: readonly string[]
    /** The command line as displayed (`argv` joined by spaces). */
    command: string
    cwd: string
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    /** The caller's signal was already aborted when the run was requested. */
    aborted?: boolean
    /** Set when the process could not be started at all (ENOENT, EACCES…). */
    spawnError?: string
}

/** Split a configured command line into argv without shell interpretation. */
export function splitCommand(command: string): string[] {
    const argv: string[] = []
    let current = ''
    let quote: '"' | "'" | undefined
    let escaped = false
    // An explicitly quoted empty token (`""`) is a real argv element, so the
    // token accumulator tracks "has content" separately from "was quoted".
    let tokenStarted = false
    for (const character of command.trim()) {
        if (escaped) {
            current += character
            escaped = false
            tokenStarted = true
            continue
        }
        if (character === '\\' && quote !== "'") {
            escaped = true
            tokenStarted = true
            continue
        }
        if (quote !== undefined) {
            if (character === quote) quote = undefined
            else current += character
            tokenStarted = true
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            tokenStarted = true
            continue
        }
        if (character === ' ' || character === '\t') {
            if (tokenStarted) {
                argv.push(current)
                current = ''
                tokenStarted = false
            }
            continue
        }
        current += character
        tokenStarted = true
    }
    if (tokenStarted) argv.push(current)
    return argv
}

/** The single source of truth for "this command produced evidence" hashing. */
export function outputDigestOf(stdout: string, stderr: string): string {
    return sha256(`${stdout}\u0000${stderr}`)
}

/**
 * Execute one configured command.
 * @param spec - argv, cwd, deadline, cancellation and environment.
 * @param service - optional `ctx.subprocess` seam (preferred when present).
 * @returns the normalised outcome; never rejects for a non-zero exit.
 */
export async function runCommand(spec: RunSpec, service?: SubprocessLike | undefined): Promise<RunOutcome> {
    // `addEventListener('abort')` never fires on an already-aborted signal, so a
    // cancelled turn would otherwise start the whole command set anyway.
    if (spec.signal?.aborted === true) {
        return {
            argv: spec.argv,
            command: spec.argv.join(' '),
            cwd: spec.cwd,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 0,
            timedOut: false,
            aborted: true,
            spawnError: 'aborted before start',
        }
    }
    return service === undefined ? runWithChildProcess(spec) : runWithService(spec, service)
}

async function runWithService(spec: RunSpec, service: SubprocessLike): Promise<RunOutcome> {
    const maxBytes = spec.maxOutputBytes ?? 64_000
    const graceMs = spec.graceMs ?? 2_000
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer =
        spec.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true
                  controller.abort()
              }, spec.timeoutMs)
    try {
        const handle = service.spawn({
            argv: spec.argv,
            cwd: spec.cwd,
            stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } },
            graceMs,
            signal: controller.signal,
            ...(spec.env === undefined ? {} : { env: spec.env as NodeJS.ProcessEnv }),
        })
        const outcome = await settleWithin(handle, spec.timeoutMs, graceMs, () => {
            timedOut = true
        })
        const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
        const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
        return {
            argv: spec.argv,
            command: spec.argv.join(' '),
            cwd: spec.cwd,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdout,
            stderr,
            durationMs: Date.now() - started,
            timedOut,
        }
    } catch (error) {
        return {
            argv: spec.argv,
            command: spec.argv.join(' '),
            cwd: spec.cwd,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: Date.now() - started,
            timedOut,
            spawnError: error instanceof Error ? error.message : String(error),
        }
    } finally {
        if (timer !== undefined) clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
    }
}

/**
 * Await one subprocess handle with a hard deadline.
 *
 * The seam's abort signal is cooperative: a provider (or a wedged binary) may
 * never settle `done`, and a gate that waits forever is worse than a gate that
 * reports `timedOut`. The deadline therefore settles the outcome itself, after
 * asking `terminate()` for the managed range.
 */
async function settleWithin(
    handle: { readonly done: Promise<{ exitCode: number | null; signal: string | null }>; terminate(): void },
    timeoutMs: number | undefined,
    graceMs: number,
    onTimeout: () => void,
): Promise<{ exitCode: number | null; signal: string | null }> {
    if (timeoutMs === undefined) return await handle.done
    const deadline = countdown(timeoutMs)
    try {
        const settled = await Promise.race([handle.done, deadline.promise])
        if (settled !== 'timeout') return settled
        onTimeout()
        handle.terminate()
        // Give the provider its documented grace to drain, then stop waiting:
        // reporting `timedOut` beats blocking a turn forever.
        const grace = countdown(Math.max(graceMs, 1_000))
        try {
            const drained = await Promise.race([handle.done, grace.promise])
            return drained === 'timeout' ? { exitCode: null, signal: 'SIGTERM' } : drained
        } finally {
            grace.clear()
        }
    } finally {
        deadline.clear()
    }
}

/** A cancellable `timeout` sentinel promise. */
function countdown(ms: number): { promise: Promise<'timeout'>; clear: () => void } {
    let timer: NodeJS.Timeout | undefined
    const promise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
    })
    return {
        promise,
        clear: () => {
            if (timer !== undefined) clearTimeout(timer)
        },
    }
}

async function runWithChildProcess(spec: RunSpec): Promise<RunOutcome> {
    const maxBytes = spec.maxOutputBytes ?? 64_000
    const graceMs = spec.graceMs ?? 2_000
    const started = Date.now()
    const executable = spec.argv[0]
    if (executable === undefined) {
        return {
            argv: spec.argv,
            command: '',
            cwd: spec.cwd,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 0,
            timedOut: false,
            spawnError: 'empty argv',
        }
    }
    return await new Promise<RunOutcome>((resolve) => {
        let settled = false
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let killTimer: NodeJS.Timeout | undefined
        const child = spawn(executable, spec.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Own process group: a timed-out command must not leave orphaned
            // grandchildren (a test runner's workers) behind.
            detached: process.platform !== 'win32',
        })
        const finish = (exitCode: number | null, signal: string | null, spawnError?: string): void => {
            if (settled) return
            settled = true
            if (timer !== undefined) clearTimeout(timer)
            if (killTimer !== undefined) clearTimeout(killTimer)
            spec.signal?.removeEventListener('abort', onAbort)
            resolve({
                argv: spec.argv,
                command: spec.argv.join(' '),
                cwd: spec.cwd,
                exitCode,
                signal,
                stdout: tail(stdout, maxBytes),
                stderr: tail(stderr, maxBytes),
                durationMs: Date.now() - started,
                timedOut,
                ...(spawnError === undefined ? {} : { spawnError }),
            })
        }
        const signalGroup = (signal: NodeJS.Signals): void => {
            const pid = child.pid
            try {
                if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, signal)
                else child.kill(signal)
            } catch {
                // already gone
            }
        }
        const terminate = (): void => {
            signalGroup('SIGTERM')
            killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
            killTimer.unref?.()
        }
        const onAbort = (): void => terminate()
        spec.signal?.addEventListener('abort', onAbort, { once: true })
        const timer =
            spec.timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      timedOut = true
                      terminate()
                  }, spec.timeoutMs)
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
            if (stdout.length > maxBytes * 4) stdout = tail(stdout, maxBytes * 2)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
            if (stderr.length > maxBytes * 4) stderr = tail(stderr, maxBytes * 2)
        })
        child.on('error', (error: Error) => finish(null, null, error.message))
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal))
    })
}

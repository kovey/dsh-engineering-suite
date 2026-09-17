/**
 * File logger shared by the suite.
 *
 * Plugins must never write to stdout: the TUI and the web server own their
 * streams, and a stray `console.log` corrupts both. Every plugin therefore
 * logs to its own file under `$DSH_HOME` (or a configured path) and only
 * mirrors to stderr when `DSH_ENG_DEBUG` is set.
 *
 * @module dsh-eng-core/log
 */

import fs from 'node:fs'
import path from 'node:path'
import { expandHome } from './paths.js'

/** Severity levels, ascending. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** The callable logger surface used across the suite. */
export interface Logger {
    (level: LogLevel, ...args: unknown[]): void
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    /** Absolute log file, when one is configured. */
    readonly file?: string
    /**
     * A logger bound to ONE workspace, when a template is configured.
     *
     * A dsh profile serves several repositories at once, so a single log file
     * interleaves their lines and makes a failure impossible to follow. With
     * `logFileTemplate` set (see {@link LoggerOptions.template}) callers pass the
     * workspace they are acting on and get a per-project file; an unbound call
     * still lands in the default file so nothing is ever lost.
     */
    for(workspace: string | undefined): Logger
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
    /** Tag printed on every line (usually the plugin id). */
    tag: string
    /** Log file; `~` is expanded. Omitted = memory only (stderr under debug). */
    file?: string
    /** Minimum level written (default `info`). */
    level?: LogLevel
    /**
     * Per-workspace file template, e.g. `~/.dsh/logs/{project}/quality-gate.log`.
     *
     * Placeholders: `{project}` (a readable, collision-free workspace id),
     * `{tag}`, `{home}`. When set, `logger.for(cwd)` writes into the rendered
     * path; the plain `logger.*` calls keep using `file`.
     */
    template?: string
}

function sanitize(segment: string): string {
    return segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Stable 32-bit digest of a path, as lowercase hex. */
function digestOf(value: string, length: number): string {
    let hash = 0
    for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
    return hash.toString(16).padStart(8, '0').slice(0, length)
}

/**
 * Readable, collision-free workspace id: the last two path segments plus a
 * short digest — `deepseek-dsh-project-a71c2a`.
 *
 * Two segments are what makes it recognisable (`api` alone says nothing); the
 * digest is what keeps `~/work/api` and `~/personal/api` apart. It is
 * deterministic across restarts, so a project's log file never moves.
 */
export function projectSlugOf(workspace: string): string {
    const resolved = path.resolve(workspace)
    const parts = resolved.split(path.sep).filter((part) => part !== '')
    const tail = parts.slice(-2).map(sanitize).filter((part) => part !== '')
    const name = tail.join('-').slice(0, 60) || 'workspace'
    return `${name}-${digestOf(resolved, 6)}`
}

/**
 * Fully readable workspace id without any digest: the whole path below `$HOME`
 * (or the whole path when outside it), joined with `-` —
 * `workspace-deepseek-dsh-project`. Longer, still unique.
 */
export function projectPathSlugOf(workspace: string): string {
    const resolved = path.resolve(workspace)
    const home = process.env['HOME']
    const relative = home !== undefined && home !== '' && resolved.startsWith(`${home}${path.sep}`) ? resolved.slice(home.length + 1) : resolved
    const slug = relative
        .split(path.sep)
        .map(sanitize)
        .filter((part) => part !== '')
        .join('-')
    return slug.slice(0, 120) || 'workspace'
}

/**
 * Render a log-file template for one workspace.
 *
 * Placeholders: `{project}` (readable + unique, see {@link projectSlugOf}),
 * `{projectPath}` (fully readable, no digest, see {@link projectPathSlugOf}),
 * `{basename}` (directory name only — readable, but equal names share a file),
 * `{tag}` and `{home}`.
 */
export function renderLogTemplate(template: string, tag: string, workspace: string): string {
    return template
        .replaceAll('{projectPath}', projectPathSlugOf(workspace))
        .replaceAll('{project}', projectSlugOf(workspace))
        .replaceAll('{basename}', sanitize(path.basename(path.resolve(workspace))) || 'workspace')
        .replaceAll('{tag}', tag)
        .replaceAll('{home}', process.env['HOME'] ?? '')
}

function render(args: unknown[]): string {
    return args
        .map((value) => {
            if (typeof value === 'string') return value
            if (value instanceof Error) return `${value.name}: ${value.message}${value.stack === undefined ? '' : `\n${value.stack}`}`
            try {
                return JSON.stringify(value)
            } catch {
                return String(value)
            }
        })
        .join(' ')
}

/**
 * Create one file-backed logger.
 * @param options - tag, file, and minimum level.
 * @returns the logger; its `file` is set when a target was configured.
 */
export function createLogger(options: LoggerOptions): Logger {
    const threshold = LEVEL_ORDER[options.level ?? 'info']
    const debugToStderr = process.env['DSH_ENG_DEBUG'] === '1'
    const template = options.template ?? ''
    const ensureDir = (file: string): void => {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
        } catch {
            // A logger must never break plugin assembly.
        }
    }
    if (options.file !== undefined) ensureDir(options.file)

    /** Append one rendered line to `file`, mirroring to stderr when asked. */
    const write = (file: string | undefined, level: LogLevel, workspace: string | undefined, args: unknown[]): void => {
        if (LEVEL_ORDER[level] < threshold) return
        // The workspace rides the line too, so even a shared file (no template)
        // can be grepped per project.
        const where = workspace === undefined ? '' : ` [${path.basename(workspace)}]`
        const line = `[${new Date().toISOString()}] [${level}] [${options.tag}]${where} ${render(args)}\n`
        if (file !== undefined) {
            try {
                fs.appendFileSync(file, line)
            } catch {
                // ignore: never break the session over a log line
            }
        }
        if (debugToStderr || file === undefined) {
            try {
                process.stderr.write(line)
            } catch {
                // ignore
            }
        }
    }

    const make = (workspace: string | undefined, file: string | undefined): Logger => {
        if (file !== undefined) ensureDir(file)
        const logger = ((level: LogLevel, ...args: unknown[]) => write(file, level, workspace, args)) as Logger
        logger.debug = (...args: unknown[]) => write(file, 'debug', workspace, args)
        logger.info = (...args: unknown[]) => write(file, 'info', workspace, args)
        logger.warn = (...args: unknown[]) => write(file, 'warn', workspace, args)
        logger.error = (...args: unknown[]) => write(file, 'error', workspace, args)
        if (file !== undefined) Object.defineProperty(logger, 'file', { value: file, enumerable: true })
        // `for` is filled in by the caller (it needs the memo map).
        logger.for = () => logger
        return logger
    }

    const base = make(undefined, options.file)
    /** One logger per workspace; templates are rendered once, not per line. */
    const scoped = new Map<string, Logger>()
    base.for = (workspace: string | undefined): Logger => {
        if (workspace === undefined || workspace === '') return base
        const hit = scoped.get(workspace)
        if (hit !== undefined) return hit
        const file =
            template === '' ? options.file : renderLogTemplate(expandHome(template), options.tag, workspace)
        const logger = make(workspace, file)
        scoped.set(workspace, logger)
        return logger
    }
    return base
}

/** A logger that discards everything; the default in unit tests. */
export const silentLogger: Logger = (() => {
    const logger = (() => undefined) as unknown as Logger
    logger.debug = () => undefined
    logger.info = () => undefined
    logger.warn = () => undefined
    logger.error = () => undefined
    return logger
})()

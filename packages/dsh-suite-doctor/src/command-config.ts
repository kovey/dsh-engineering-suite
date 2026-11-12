/**
 * The grammar and execution of `/suite set|unset|edit`.
 *
 * Split from `command.ts` for two reasons that are both about the boundary
 * rather than line count:
 *
 *  - `command.ts` owns the harness registry and the dispatch EVERY sub-command
 *    shares; the write/edit grammar plus its refusals live here, so the dispatch
 *    file stays readable and under the structural thresholds.
 *  - The human-only write path is visible in one place: `set`/`unset` call
 *    `applyConfigEdit` (the atomic writer), `edit` calls `openConfigFile` (the
 *    optional UI route). No tool imports this module.
 *
 * Errors are returned as `{ kind: 'error' }` from the parser (the caller appends
 * the usage text, which is owned by `command.ts`) and thrown by the executor
 * (which the command handler turns into an error result).
 *
 * @module dsh-suite-doctor/command-config
 */

import type { Layout } from 'dsh-eng-core'
import { applyConfigEdit, renderConfigEdit } from './config-edit.js'
import { openConfigFile } from './open-config.js'

/** The three config sub-commands this module owns. */
export type ConfigSubcommand = 'set' | 'unset' | 'edit'

/** One parsed `set` / `unset` / `edit` invocation. */
export type SuiteConfigInvocation =
    | { kind: 'set'; plugin: string; key: string; value: unknown; dryRun: boolean; allowUnknown: boolean }
    | { kind: 'unset'; plugin: string; key: string; dryRun: boolean; allowUnknown: boolean }
    | { kind: 'edit'; plugin?: string }

/** What running one invocation needs from the command layer. */
export interface ConfigRunContext {
    /** The calling session's workspace (never `process.cwd()`). */
    cwd: string
    /** The layout the suite reads configuration from. */
    layout: Layout
    /** The live host accessor (`ctx.get`), for the OPTIONAL nvim-tui service. */
    getService: (name: string) => unknown
}

const CONFIG_SUBCOMMANDS: readonly ConfigSubcommand[] = ['set', 'unset', 'edit']

/** The two flags `set` / `unset` accept. */
const WRITE_FLAGS = '--dry-run|--allow-unknown'

/**
 * Whether one command word belongs to this module.
 * @param word - the first word after `suite` (case-insensitive).
 * @returns `true` for `set` / `unset` / `edit`.
 */
export function isConfigSubcommand(word: string): word is ConfigSubcommand {
    return (CONFIG_SUBCOMMANDS as readonly string[]).includes(word.toLowerCase())
}

/**
 * Strip `set` / `unset` flags from the ends of the argument text.
 *
 * Flags are accepted at the start (`set --dry-run …`) or at the end
 * (`set … --dry-run`, the form the usage shows). Everything in between is left
 * byte-for-byte: the rest of a `set` line IS the JSON value, and re-joining
 * tokens would silently collapse whitespace inside a JSON string.
 */
function stripWriteFlags(raw: string): { body: string; flags: Set<string>; problem?: string } {
    const flags = new Set<string>()
    let body = raw.trim()
    for (;;) {
        const match = new RegExp(`^(.*?)\\s+(${WRITE_FLAGS})$`).exec(body)
        if (match === null) break
        flags.add(match[2] as string)
        body = (match[1] as string).trimEnd()
    }
    for (;;) {
        const match = new RegExp(`^(${WRITE_FLAGS})\\s+([\\s\\S]*)$`).exec(body)
        if (match === null) break
        flags.add(match[1] as string)
        body = (match[2] as string).trimStart()
    }
    const stray = new RegExp(`(^|\\s)(${WRITE_FLAGS})(\\s|$)`).exec(body)
    if (stray === null) return { body, flags }
    return { body, flags, problem: `${stray[2] as string} 只能放在参数开头或结尾（放中间时无法判断它是参数还是 JSON 值的一部分）` }
}

/** Parse a JSON fragment; a malformed value is a refused command, not a guess. */
function parseJsonFragment(raw: string): { ok: true; value: unknown } | { ok: false; problem: string } {
    try {
        return { ok: true, value: JSON.parse(raw) as unknown }
    } catch (error) {
        return {
            ok: false,
            problem: `值必须是合法的 JSON 片段（true / 123 / "x" / {...} / [...]）：${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

/** Parse `set <plugin> <key> <json-value>` / `unset <plugin> <key>` plus flags. */
function parseWrite(action: 'set' | 'unset', raw: string): SuiteConfigInvocation | { kind: 'error'; problem: string } {
    const stripped = stripWriteFlags(raw)
    if (stripped.problem !== undefined) return { kind: 'error', problem: stripped.problem }
    const dryRun = stripped.flags.has('--dry-run')
    const allowUnknown = stripped.flags.has('--allow-unknown')
    if (action === 'unset') {
        const match = /^(\S+)\s+(\S+)$/.exec(stripped.body)
        if (match === null) return { kind: 'error', problem: 'unset 需要 <plugin> <key>' }
        return { kind: 'unset', plugin: match[1] as string, key: match[2] as string, dryRun, allowUnknown }
    }
    const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(stripped.body)
    if (match === null) return { kind: 'error', problem: 'set 需要 <plugin> <key> <json-value>' }
    const parsed = parseJsonFragment(match[3] as string)
    if (!parsed.ok) return { kind: 'error', problem: parsed.problem }
    return { kind: 'set', plugin: match[1] as string, key: match[2] as string, value: parsed.value, dryRun, allowUnknown }
}

/**
 * Parse one config sub-command.
 * @param command - the first word (already known to be `set`/`unset`/`edit`).
 * @param raw - the text after the command word (inner whitespace preserved).
 * @returns the invocation, or an error carrying only the reason (the caller appends the usage).
 */
export function parseConfigInvocation(command: ConfigSubcommand, raw: string): SuiteConfigInvocation | { kind: 'error'; problem: string } {
    if (command === 'set' || command === 'unset') return parseWrite(command, raw)
    const tokens = raw.trim().split(/\s+/).filter((token) => token !== '')
    if (tokens.length > 1) return { kind: 'error', problem: `edit 最多接受一个 plugin（收到 ${tokens.map((token) => JSON.stringify(token)).join(' ')}）` }
    return { kind: 'edit', ...(tokens[0] === undefined ? {} : { plugin: tokens[0] }) }
}

/**
 * Execute one parsed invocation.
 * @param invocation - the parsed config sub-command.
 * @param context - workspace, layout and the optional UI probe.
 * @returns the text the command renders (successful for the path fallback too).
 * @throws on a refused key/value, an unreadable file, a failed write or an unknown plugin.
 */
export async function runConfigInvocation(invocation: SuiteConfigInvocation, context: ConfigRunContext): Promise<string> {
    if (invocation.kind === 'edit') {
        const outcome = await openConfigFile({
            cwd: context.cwd,
            layout: context.layout,
            ...(invocation.plugin === undefined ? {} : { plugin: invocation.plugin }),
            getService: context.getService,
        })
        return outcome.text
    }
    return renderConfigEdit(
        applyConfigEdit({
            cwd: context.cwd,
            layout: context.layout,
            plugin: invocation.plugin,
            action: invocation.kind,
            key: invocation.key,
            ...(invocation.kind === 'set' ? { value: invocation.value } : {}),
            dryRun: invocation.dryRun,
            allowUnknown: invocation.allowUnknown,
        }),
    )
}

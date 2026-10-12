/**
 * The human-facing `/kb` command.
 *
 * The harness's command registry (`@deepseek-ai/dsh-commands`) exists so a
 * PERSON can type something and have a plugin-owned handler run **against the
 * agent, with no model turn**: `/kb status` costs one line and no tokens. This
 * plugin is the natural candidate — its tools are read-only lookups with
 * `path:line` citations — so the same three operations the model calls are
 * exposed to the person at the keyboard.
 *
 * Three deliberate properties:
 *
 *  - **Optional integration.** The registry is reached through
 *    `ctx.get('commands')` and never through `inject`: a minimal host without
 *    that plugin must still load this one, and a registry that is absent, broken
 *    or only half there is a LOGGED note, never a failed `apply`.
 *  - **No duplicated rendering.** The handler calls `runIndex` / `runSearch` /
 *    `runStatus` — the same functions `kb_index` / `kb_search` / `kb_status`
 *    call — so a citation line, a skipped-file reason or a refusal cannot say
 *    one thing to a model and another to a person. The operations refuse by
 *    throwing (a tool error); here the same text becomes an `error` result.
 *  - **Fail closed on grammar.** Anything unrecognised is an error result
 *    carrying the usage: a mistyped sub-command must never look like a command
 *    that ran and had nothing to say.
 *
 * @module dsh-knowledge-base/command
 */

import type { AgentLike } from 'dsh-eng-core'
import { KB_KINDS, type KbKind, type KnowledgeBaseConfig } from './config.js'
import { runIndex, runSearch, runStatus, type ToolDeps } from './tools.js'

/** The registered command name (the `/` is the harness's, not ours). */
export const KB_COMMAND_NAME = 'kb'

/** Discovery text shown in the command UI. */
export const KB_COMMAND_DESCRIPTION = '项目知识库：构建/检索索引并给出 path:line 引用（index | search | status | help）'

/** Input hint advertised to capable composers. */
export const KB_COMMAND_HINT = 'index [--force] [--source <id>]… | search <关键词…> | status | help'

/** Expected command outcome, structurally what `@deepseek-ai/dsh-commands` returns. */
export type CommandResultLike = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** The invocation the registry hands the handler (only what this plugin reads). */
export interface CommandInvocationLike {
    /** The agent whose UI received the command; its session carries the workspace. */
    agent?: AgentLike
    /** Exact text after `kb`, including the separator whitespace. */
    rawInput?: unknown
}

/** Structural view of the registry (`ctx.get('commands')`), not an import. */
export interface CommandRuntimeLike {
    register: (definition: {
        name: string
        description: string
        input?: { hint: string }
        handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
    }) => () => void
}

/**
 * Whether a `ctx.get('commands')` value is the registry. Structure, not
 * identity: the plugin must work without the registry package being installed.
 * @param value - the service, if any.
 * @returns `true` when it can register a command.
 */
export function isCommandRuntime(value: unknown): value is CommandRuntimeLike {
    if (typeof value !== 'object' || value === null) return false
    return typeof (value as { register?: unknown }).register === 'function'
}

/** The usage text, built from the configuration in force (source ids and limits). */
export function usageText(config: KnowledgeBaseConfig): string {
    const ids = config.sources.map((source) => `${source.id}${source.enabled ? '' : '（已停用）'}`).join('、')
    return [
        '/kb —— 项目知识库（人直接敲的命令：不经过模型，报告与 kb_index / kb_search / kb_status 是同一份）',
        '用法：',
        `  /kb index [--force] [--source <id>]…                 构建/重建索引（唯一会写盘的子命令，写 ${config.indexDir}/）`,
        '  /kb search <关键词…> [--limit N] [--kind <kind>] [--prefix <path>]   检索（只读）',
        '  /kb status                                           索引状态与新鲜度（只读）',
        '  /kb help                                             这条用法',
        `来源 id：${ids}（--source 可重复；不带就是全部启用的来源）`,
        `kind：${KB_KINDS.join('、')}（--kind 可重复；不带就是全部来源）`,
        `limit：默认 ${config.search.limit}、上限 ${config.search.maxLimit}（超过上限按上限处理并在报告里说明）`,
        '说明：不认得的子命令/参数一律报错并显示这份用法，不会静默地"什么都不做"。',
    ].join('\n')
}

/** One parsed invocation, or the error result that replaces it. */
export type KbInvocation =
    | { kind: 'help' }
    | { kind: 'status' }
    | { kind: 'index'; force: boolean; only?: string[] }
    | { kind: 'search'; query: string; limit?: number; kinds?: string[]; pathPrefix?: string }

/** Result of parsing one `rawInput`. */
export type KbParseResult = KbInvocation | { kind: 'error'; text: string }

/** A refusal that carries the usage (grammar-level, never a silent no-op). */
function usageError(reason: string, config: KnowledgeBaseConfig): KbParseResult {
    return { kind: 'error', text: `${reason}。\n\n${usageText(config)}` }
}

/** A hint for `--flag=value`, the shape a shell-trained hand types first. */
function equalHint(token: string): string {
    const equals = token.indexOf('=')
    if (!token.startsWith('--') || equals < 0) return ''
    return `（本命令用空格分隔参数：${token.slice(0, equals)} ${token.slice(equals + 1)}）`
}

/** `--source` and `--force`, and nothing else. */
function parseIndex(tokens: readonly string[], config: KnowledgeBaseConfig): KbParseResult {
    const known = config.sources.map((source) => source.id)
    const only: string[] = []
    let force = false
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string
        if (token === '--force') {
            force = true
            continue
        }
        if (token === '--source') {
            const value = tokens[index + 1]
            if (value === undefined || value.startsWith('--')) return usageError('--source 后面要跟一个来源 id', config)
            if (!known.includes(value)) return usageError(`--source 里有未配置的来源 ${JSON.stringify(value)}（可用来源：${known.join('、')}）`, config)
            if (!only.includes(value)) only.push(value)
            index += 1
            continue
        }
        return usageError(`index 无法识别的参数 ${JSON.stringify(token)}${equalHint(token)}`, config)
    }
    return { kind: 'index', force, ...(only.length === 0 ? {} : { only }) }
}

/** `<query…>` plus `--limit` / `--kind` / `--prefix`. */
function parseSearch(tokens: readonly string[], config: KnowledgeBaseConfig): KbParseResult {
    const words: string[] = []
    const kinds: string[] = []
    let limit: number | undefined
    let pathPrefix: string | undefined
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string
        if (token === '--limit' || token === '--kind' || token === '--prefix') {
            const value = tokens[index + 1]
            if (value === undefined || value.startsWith('--')) return usageError(`${token} 后面要跟一个值`, config)
            if (token === '--limit') {
                if (!/^\d+$/.test(value) || Number(value) < 1) {
                    return usageError(`--limit 必须是不小于 1 的整数（收到 ${JSON.stringify(value)}；上限 ${config.search.maxLimit}）`, config)
                }
                limit = Number(value)
            } else if (token === '--kind') {
                if (!KB_KINDS.includes(value as KbKind)) return usageError(`--kind 里有未知类型 ${JSON.stringify(value)}（可用值：${KB_KINDS.join('、')}）`, config)
                if (!kinds.includes(value)) kinds.push(value)
            } else {
                pathPrefix = value
            }
            index += 1
            continue
        }
        if (token.startsWith('--')) return usageError(`search 无法识别的参数 ${JSON.stringify(token)}${equalHint(token)}`, config)
        words.push(token)
    }
    if (words.length === 0) return usageError('search 需要一个关键词（或 id）', config)
    return {
        kind: 'search',
        query: words.join(' '),
        ...(limit === undefined ? {} : { limit }),
        ...(kinds.length === 0 ? {} : { kinds }),
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
    }
}

/**
 * Parse one command line.
 *
 * `rawInput` is exactly what the human typed after `kb` (leading whitespace
 * included), so everything here is defensive: a non-string, an empty line and an
 * unknown word all end in a defined result, never in an exception.
 * @param rawInput - the text after the command name.
 * @param config - the configuration in force (for the usage text and the ids).
 * @returns the invocation to run, or an error result carrying the usage.
 */
export function parseKbInvocation(rawInput: unknown, config: KnowledgeBaseConfig): KbParseResult {
    const text = typeof rawInput === 'string' ? rawInput : ''
    const tokens = text.trim().split(/\s+/).filter((token) => token !== '')
    // `/kb` and `/kb help` ask the same question, and `/kb help …` is answered by
    // the usage itself: nothing a person typed is dropped silently either way.
    if (tokens.length === 0 || tokens[0]?.toLowerCase() === 'help') return { kind: 'help' }
    const rest = tokens.slice(1)
    switch (tokens[0]?.toLowerCase()) {
        case 'status':
            if (rest.length > 0) return usageError(`status 不接受参数（收到 ${rest.map((token) => JSON.stringify(token)).join(' ')}）`, config)
            return { kind: 'status' }
        case 'index':
            return parseIndex(rest, config)
        case 'search':
            return parseSearch(rest, config)
        default:
            return usageError(`未知子命令 ${JSON.stringify(tokens[0])}`, config)
    }
}

/** The configuration the invocation runs under (profile row, narrowed per workspace). */
function effectiveConfigOf(deps: ToolDeps, agent: AgentLike | undefined): KnowledgeBaseConfig {
    try {
        return deps.configFor(agent).config
    } catch {
        return deps.config
    }
}

/**
 * Run one invocation. Never throws: the operations refuse by throwing (the
 * tools turn that into a tool error), and a person typing `/kb` has no such
 * channel — the refusal becomes the error result, word for word.
 * @param deps - configuration, stores, logger and clock.
 * @param invocation - what the registry handed the handler.
 * @returns the result the UI renders.
 */
export function runKbCommand(deps: ToolDeps, invocation: CommandInvocationLike): CommandResultLike | Promise<CommandResultLike> {
    const agent = invocation?.agent
    const config = effectiveConfigOf(deps, agent)
    const parsed = parseKbInvocation(invocation?.rawInput, config)
    if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
    try {
        switch (parsed.kind) {
            case 'help':
                return { kind: 'success', text: usageText(config) }
            case 'status':
                return { kind: 'success', text: runStatus(deps, agent) }
            case 'index':
                return {
                    kind: 'success',
                    text: runIndex(deps, agent, { ...(parsed.force ? { force: true } : {}), ...(parsed.only === undefined ? {} : { only: parsed.only }) }),
                }
            default:
                return {
                    kind: 'success',
                    text: runSearch(deps, agent, {
                        query: parsed.query,
                        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
                        ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
                        ...(parsed.pathPrefix === undefined ? {} : { pathPrefix: parsed.pathPrefix }),
                    }),
                }
        }
    } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
}

/** What {@link registerKbCommand} managed to do. */
export interface CommandRegistration {
    registered: boolean
    /** The registry's own disposer, when registration succeeded. */
    dispose?: () => void
    /** Why it is not registered (or not disposable), for the log. */
    problem?: string
}

/**
 * Register `/kb` when — and only when — the host mounted the command registry.
 *
 * `definitionId` is deliberately omitted: it is optional in the registry's own
 * API, and supplying one would mean importing `@deepseek-ai/dsh-commands` (or
 * casting to a branded type) in a plugin that must load without it.
 *
 * `input.attachments` is deliberately NOT declared: this grammar cannot use an
 * image or a staged file, and an undeclared command makes the registry refuse
 * such an invocation before the handler runs — which is the honest outcome,
 * rather than accepting attachments and silently ignoring them.
 * @param context - the host context (only `get` is used).
 * @param deps - configuration, stores, logger and clock.
 * @returns whether it registered, its disposer, and any problem worth logging.
 */
export function registerKbCommand(context: { get: (name: string) => unknown }, deps: ToolDeps): CommandRegistration {
    const service = context.get('commands')
    if (!isCommandRuntime(service)) {
        return { registered: false, problem: '宿主没有装配 commands 服务（@deepseek-ai/dsh-commands）：/kb 未注册，工具与提示词段不受影响' }
    }
    try {
        const dispose = service.register({
            name: KB_COMMAND_NAME,
            description: KB_COMMAND_DESCRIPTION,
            input: { hint: KB_COMMAND_HINT },
            handler: (invocation) => runKbCommand(deps, invocation),
        })
        if (typeof dispose !== 'function') {
            return { registered: true, problem: 'commands.register() 没有返回 disposer：命令已注册，但插件卸载时无法注销它' }
        }
        return { registered: true, dispose }
    } catch (error) {
        return { registered: false, problem: `注册 /kb 失败（宿主不会因此失去知识库工具）：${error instanceof Error ? error.message : String(error)}` }
    }
}

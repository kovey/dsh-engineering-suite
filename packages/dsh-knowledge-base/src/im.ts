/**
 * The `/kb` command inside an IM chat.
 *
 * The person who configured the suite can already type `/kb search …` in the
 * TUI, but that surface belongs to the terminal. This file adds the same lookup
 * to the chat platform the host already bridged (`dsh-chat-interaction`), so a
 * question asked from a phone is answered from the project's own index instead
 * of from the model's memory — with the same `path:from-to` citations.
 *
 * Five deliberate properties:
 *
 *  - **ONE source for the IM target.** Which conversation may talk to the suite
 *    is `dsh-interaction-gate`'s decision (`im.approvalChatId` / `im.p2pOnly`),
 *    published read-only as `ctx.get('interaction').imTarget()`. This package
 *    keeps NO chat allow list of its own: two copies of "the allowed chat"
 *    drift the moment an operator changes one of them. No target = the command
 *    is never registered ("not configured" is the default, not a permissive
 *    fallback), and the handler re-reads the target on every invocation — a
 *    command name is not an authorisation.
 *  - **No agent turn.** The command is handled by the IM plugin's command
 *    registry, which runs a handler instead of waking the model: the reply costs
 *    one round trip and no tokens, and the suite's approval channels are not
 *    involved (nor bypassed) because no gate is asked anything here.
 *  - **The same retrieval as every other surface.** The handler calls the
 *    `knowledge-base` service, which runs `operations.ts` — the function the
 *    `kb_search` tool runs. It cannot invent hits, and it quotes the same
 *    citations.
 *  - **Readable failures.** A missing index, an unknown kind or a throwing
 *    upstream becomes `搜索失败：<原因>` in the chat. The handler never throws:
 *    an exception here would be reported by the IM plugin as a generic command
 *    failure, which says less than the actual reason. A refusal names the
 *    interaction-gate key to change, because that is where the target lives.
 *  - **`im.workspace` is explicit.** IM has no agent whose `session.cwd` could
 *    be read, and one process serves several repositories, so the searched
 *    workspace is a host decision — guessing it means indexing the wrong one.
 *
 * @module dsh-knowledge-base/im
 */

import path from 'node:path'
import { expandHome, type Logger, type MissionStoreRegistry } from 'dsh-eng-core'
import { resolveEffectiveConfig, type KnowledgeBaseConfig } from './config.js'
import { IM_COMMAND_PATTERN, type KbImConfig } from './im-config.js'
import { probeImCommandApi, type ImCommandApiLike, type ImCommandInvocationLike, type ImReplyLike } from './im-probe.js'
import { IM_NOT_P2P, IM_NOT_TARGET, IM_NO_TARGET, IM_NO_TARGET_PROBLEM, imTargetOf, type ImTargetResolver } from './im-target.js'
import type { KnowledgeBaseService } from './service.js'
import type { SearchOutcome } from './search.js'

/** Discovery text the IM plugin shows for the command. */
export const IM_COMMAND_DESCRIPTION = '项目知识库检索：/kb <关键词> 返回带 path:from-to 引用的前 N 条（不经过模型、不写盘）'

/** Appended when a reply had to be cut (so the cut is stated, not silent). */
export const IM_TRUNCATED_SUFFIX = '\n…（更多结果请在 TUI 用 kb_search）'

/** The refusal when the host configured no workspace to search. */
export const IM_NO_WORKSPACE =
    'IM 检索没有配置工作区：请在宿主 profile 的 dsh-knowledge-base 配置行里设置 im.workspace（要检索的仓库根目录，绝对路径或 ~/…），然后重试。'

/** What {@link registerImCommand} managed to do. */
export interface ImRegistration {
    registered: boolean
    /** The registered command name (without the `/`). */
    name?: string
    /** The plugin's withdraw function, when registration succeeded. */
    dispose?: () => void
    /** Why it is not registered (or why it will refuse every call), for the log. */
    problem?: string
}

/** What the command closes over. */
export interface ImDeps {
    /** The resolved profile row (the ceiling for every workspace). */
    config: KnowledgeBaseConfig
    stores: MissionStoreRegistry
    logger: Logger
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * The usage line shown for an empty argument list.
 * @param name - the registered command name (no `/`).
 * @returns the reply text.
 */
export function imUsageText(name: string): string {
    return [
        `/${name} <关键词…> —— 在项目知识库里检索（词法检索：BM25 + CJK 二元组，不经过模型、不写盘）`,
        '返回前 N 条结果，每条带 `path:from-to` 引用与一句摘要；结果超过长度上限时会被截断。',
        '要看完整报告（分数、命中原因、覆盖与跳过明细）请在 TUI 里用 `kb_search`。',
    ].join('\n')
}

/** One denial: the same text to the chat, the audited line to the logs. */
function deny(deps: ImDeps, invocation: ImCommandInvocationLike, chatId: string, why: string, reply: string): ImReplyLike {
    const line = `IM 命令 /${deps.config.im.command}：会话 ${chatId === '' ? '(空 chatId)' : chatId} ${why}，已拒绝`
    try {
        deps.logger.warn(line)
    } catch {
        // A log sink that throws must not turn a denial into an exception.
    }
    try {
        invocation.log?.('warn', line)
    } catch {
        // Same for the host's own sink.
    }
    return { text: reply }
}

/**
 * Render the ranked hits for a chat: citation first, one snippet line each.
 * @param query - the query as typed.
 * @param outcome - the ranking (the same object `kb_search` renders).
 * @param im - the settings in force (`maxResults`).
 * @returns the reply text (possibly still longer than `maxChars`).
 */
export function formatSearchReply(query: string, outcome: SearchOutcome, im: KbImConfig): string {
    const hits = outcome.hits.slice(0, im.maxResults)
    if (hits.length === 0) {
        return [
            `知识库检索“${query}”：索引里没有匹配的块（候选 ${outcome.candidates} / 共 ${outcome.totalChunks} 块）。`,
            '这是词法索引（BM25 + CJK 二元组），换个说法或 id 可能就命中；要看完整报告请在 TUI 用 kb_search。',
        ].join('\n')
    }
    const lines = [`知识库检索“${query}”（命中 ${outcome.scored} 条，返回前 ${hits.length} 条）`]
    hits.forEach((hit, index) => {
        const chunk = hit.chunk
        lines.push(`[${index + 1}] ${chunk.path}:${chunk.from}-${chunk.to} 「${chunk.title}」`)
        const snippet = hit.snippet.replace(/\s+/g, ' ').trim()
        if (snippet !== '') lines.push(`    摘要：${snippet}`)
    })
    return lines.join('\n')
}

/**
 * Cut a reply at a line boundary and say so.
 * @param text - the rendered reply.
 * @param maxChars - the budget in effect.
 * @returns text no longer than `maxChars`, ending with {@link IM_TRUNCATED_SUFFIX} when cut.
 */
export function truncateReply(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    const budget = maxChars - IM_TRUNCATED_SUFFIX.length
    if (budget <= 0) return IM_TRUNCATED_SUFFIX.slice(0, Math.max(0, maxChars))
    const cut = text.slice(0, budget)
    const lastBreak = cut.lastIndexOf('\n')
    const head = lastBreak > 0 ? cut.slice(0, lastBreak) : cut
    return `${head.replace(/[ \t]+$/, '')}${IM_TRUNCATED_SUFFIX}`
}

/** The workspace the command searches, expanded and resolved; `''` when unset. */
function workspaceOf(im: KbImConfig): string {
    return im.workspace === '' ? '' : path.resolve(expandHome(im.workspace))
}

/** The settings in force for the workspace being searched (project may only narrow). */
function effectiveIm(deps: ImDeps, cwd: string): KbImConfig {
    try {
        return resolveEffectiveConfig(deps.config, deps.stores.for(cwd).layout, deps.logger).config.im
    } catch {
        return deps.config.im
    }
}

/**
 * Run one `/kb` invocation. Never throws: every failure is a readable reply.
 *
 * The authorisation check re-reads the target on EVERY call (`imTarget`), so a
 * chat that is not the interaction-gate conversation is refused even if it
 * reached the handler by another path (a stale registration, a replayed card).
 * @param invocation - what the IM plugin hands the handler.
 * @param runtime - configuration, stores, logger, the index service, and the single IM target resolver.
 * @returns the reply to send to the chat.
 */
export async function runImQuery(
    invocation: ImCommandInvocationLike,
    runtime: { deps: ImDeps; service: KnowledgeBaseService; imTarget?: ImTargetResolver },
): Promise<ImReplyLike> {
    const { deps, service } = runtime
    const profile = deps.config.im
    const chatId = typeof invocation.chatId === 'string' ? invocation.chatId : ''
    const query = Array.isArray(invocation.args) ? invocation.args.join(' ').trim() : ''
    if (query === '') return { text: imUsageText(profile.command) }
    // The single source first: without an interaction-gate target there is no
    // conversation this command may answer at all.
    const target = runtime.imTarget?.()
    if (target === undefined || target.chatId === '') return deny(deps, invocation, chatId, '没有可用的 IM 目标（interaction-gate 的 im.approvalChatId 为空）', IM_NO_TARGET)
    if (target.chatId !== chatId) {
        return deny(deps, invocation, chatId, `不是 interaction-gate 配置的审批会话（im.approvalChatId=${target.chatId}）`, IM_NOT_TARGET)
    }
    if (target.p2pOnly && invocation.message?.chatType !== 'p2p') {
        return deny(deps, invocation, chatId, `所在会话不是 p2p（chatType=${invocation.message?.chatType ?? '未知'}），而 interaction-gate 配置了 im.p2pOnly`, IM_NOT_P2P)
    }
    const cwd = workspaceOf(profile)
    if (cwd === '') return { text: IM_NO_WORKSPACE }
    // The project file may only tighten the reply budgets; the target above is
    // the host's and is not narrowed per repository (there is nothing to narrow).
    const im = effectiveIm(deps, cwd)
    try {
        const outcome = service.search({ cwd, query, limit: im.maxResults })
        return { text: truncateReply(formatSearchReply(query, outcome, im), im.maxChars) }
    } catch (error) {
        const reason = reasonOf(error)
        try {
            deps.logger.for(cwd).warn(`IM 命令 /${profile.command} 检索失败：${reason}`)
        } catch {
            // The refusal below is the answer; a broken log sink is not.
        }
        return { text: `搜索失败：${reason}` }
    }
}

/**
 * Register one spec against a usable api.
 *
 * Split from {@link registerImCommand} on purpose: the guard clauses there read
 * as a list, and this function keeps the one `try/catch` (a registry that throws
 * must become a logged problem, never a failed `apply`) at a flat depth.
 * @param api - the IM plugin's command api (`api.registerCommand`).
 * @param im - the settings in force (name, workspace).
 * @param deps - profile configuration, stores and logger.
 * @param service - the knowledge-base service the handler searches through.
 * @param imTarget - reads the single IM target at call time (interaction-gate's `imTarget()`).
 * @returns the registration report.
 */
function registerWith(
    api: ImCommandApiLike,
    im: KbImConfig,
    deps: ImDeps,
    service: KnowledgeBaseService,
    imTarget: ImTargetResolver,
): ImRegistration {
    let registration: unknown
    try {
        registration = api.registerCommand({
            name: im.command,
            description: IM_COMMAND_DESCRIPTION,
            usage: imUsageText(im.command),
            handler: (invocation) => runImQuery(invocation, { deps, service, imTarget }),
        })
    } catch (error) {
        return { registered: false, problem: `注册 IM 命令 /${im.command} 失败（工具与 TUI 的 /kb 不受影响）：${reasonOf(error)}` }
    }
    const registered = registration as { dispose?: unknown } | undefined
    const dispose = registered?.dispose
    if (typeof dispose !== 'function') {
        return { registered: true, name: im.command, problem: `IM 命令 /${im.command} 已注册，但 registerCommand 没有返回 { dispose }：插件卸载时无法注销它` }
    }
    // Registered for real; an empty workspace is a startup warning, not a refusal:
    // the handler still answers every call with the configuration it needs.
    return {
        registered: true,
        name: im.command,
        dispose: dispose as () => void,
        ...(im.workspace === '' ? { problem: `IM 命令 /${im.command} 已注册，但 im.workspace 为空：每次调用都会拒绝并提示配置工作区` } : {}),
    }
}

/**
 * Register the IM command when — and only when — the host mounted the IM
 * service AND `dsh-interaction-gate` published an IM target.
 *
 * The target is re-read from `ctx.get('interaction')` here (not taken from a
 * caller) so no caller can register an ungated command, and the handler
 * re-reads it again on every invocation. The chat allow list is NOT a
 * knowledge-base setting: `im.chatIds` / `im.p2pOnly` were removed.
 * @param context - the host context (only `get` is used).
 * @param deps - profile configuration, stores and logger.
 * @param service - the knowledge-base service the handler searches through.
 * @returns whether it registered, its withdraw function and any problem worth logging.
 */
export function registerImCommand(
    context: { get: (name: string) => unknown },
    deps: ImDeps,
    service: KnowledgeBaseService,
): ImRegistration {
    const im = deps.config.im
    // Default off: the host never said which conversation may ask, and that is
    // not a problem. A host that DID configure a workspace clearly expects the
    // command, so the missing target is worth one line (it names the key).
    const imTarget: ImTargetResolver = () => imTargetOf(context.get)
    if (imTarget() === undefined) {
        return { registered: false, ...(im.workspace === '' ? {} : { problem: IM_NO_TARGET_PROBLEM }) }
    }
    if (!IM_COMMAND_PATTERN.test(im.command)) {
        return { registered: false, problem: `im.command=${JSON.stringify(im.command)} 不是合法命令名（${String(IM_COMMAND_PATTERN)}）：IM 命令未注册，工具与 TUI 的 /kb 不受影响` }
    }
    const probe = probeImCommandApi(context.get)
    if (probe.api === undefined) return { registered: false, problem: `${probe.reason}：IM 命令 /${im.command} 未注册（interaction-gate 已配置 IM 目标）` }
    return registerWith(probe.api, im, deps, service, imTarget)
}

/**
 * The structural view of the IM plugin's command API.
 *
 * `dsh-chat-interaction` is another package with its own release cadence, so
 * nothing here is imported from it: the shape is re-declared (verified against
 * 0.3.8's `CommandSpec` / `CommandContext`) and every lookup is validated at
 * runtime. `apply` must load on a host without that plugin at all, and a
 * service that is absent, older or broken is a Chinese REASON — never a crash
 * and never a silently registered command.
 *
 * @module dsh-knowledge-base/im-probe
 */

/** The invocation the IM plugin hands a command handler (only what this suite reads). */
export interface ImCommandInvocationLike {
    channel?: string
    chatId?: string
    /** Tokens after the command name (whitespace split by the host). */
    args?: unknown
    /** Full message text, for diagnostics only. */
    text?: unknown
    message?: { chatType?: string; isCardAction?: boolean }
    /** The host's own log sink (`LogFn`: level + message). */
    log?: (level: string, ...message: unknown[]) => void
}

/** What a command handler returns (`{ text }` is sent back to the chat). */
export interface ImReplyLike {
    text: string
}

/** Structural view of `chatInteraction.api` (dsh-chat-interaction ≥ 0.3.8). */
export interface ImCommandApiLike {
    registerCommand: (spec: {
        name: string
        description?: string
        usage?: string
        handler: (invocation: ImCommandInvocationLike) => ImReplyLike | Promise<ImReplyLike>
    }) => unknown
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Look up `ctx.get('chatInteraction')?.api` and decide whether it can register a
 * command. Total by design: a throwing accessor, a partial object or an old
 * upstream is `{ reason }`, never an exception.
 * @param get - the runtime's service accessor (a closure over `ctx.get`).
 * @returns the usable api, or the Chinese reason there is none.
 */
export function probeImCommandApi(get: (name: string) => unknown): { api?: ImCommandApiLike; reason?: string } {
    let layer: unknown
    try {
        layer = get('chatInteraction')
    } catch (error) {
        return { reason: `读取服务 ctx.get("chatInteraction") 抛错：${reasonOf(error)}` }
    }
    if (layer === undefined || layer === null) return { reason: 'IM 服务未装配（chatInteraction 不存在：需要 dsh-chat-interaction 0.3.8+ 并挂载到宿主）' }
    if (typeof layer !== 'object') return { reason: `chatInteraction 服务不是对象（收到 ${typeof layer}）` }
    let api: unknown
    try {
        api = (layer as { api?: unknown }).api
    } catch (error) {
        return { reason: `chatInteraction.api 的访问器抛错：${reasonOf(error)}` }
    }
    if (typeof api !== 'object' || api === null) return { reason: 'chatInteraction 没有暴露 api（需要 dsh-chat-interaction 0.3.8+）' }
    if (typeof (api as { registerCommand?: unknown }).registerCommand !== 'function') {
        return { reason: 'chatInteraction.api 缺少 registerCommand（需要 dsh-chat-interaction 0.3.8+）' }
    }
    return { api: api as ImCommandApiLike }
}

/**
 * The single IM target the knowledge base is allowed to answer in.
 *
 * Splitting this out of `im.ts` keeps the derivation, the structural view of
 * `dsh-interaction-gate`'s `imTarget()` accessor, and the refusals that name
 * its configuration keys in one place: wherever `/kb` decides "is this chat
 * allowed", it reads exactly these functions.
 *
 * The target itself is NOT a knowledge-base setting. `dsh-interaction-gate`
 * resolves `im.approvalChatId` / `im.p2pOnly` from the host's profile and
 * publishes the result read-only; this package consumes it and keeps no chat
 * allow list of its own (two copies drift the moment one is edited). No target
 * = the command is never registered, and the handler re-reads the target on
 * every call because a command name is not an authorisation.
 *
 * The shape is re-declared structurally (like `im-probe.ts`): this package must
 * load on a host without the interaction plugin, so nothing is imported from it.
 *
 * @module dsh-knowledge-base/im-target
 */

/** The IM target as `dsh-interaction-gate` publishes it (`registry.imTarget()`). */
export interface ImTargetLike {
    /** The resolved `im.channel` mode (`auto` / `off` / `required`). */
    channel: string
    /** The configured approval conversation (`im.approvalChatId`), non-empty. */
    chatId: string
    /** Whether the conversation must be proven p2p (`im.p2pOnly`). */
    p2pOnly: boolean
}

/** A resolver for the single IM target. `undefined` = no target configured. */
export type ImTargetResolver = () => ImTargetLike | undefined

/** The refusal when there is no usable IM target at call time. */
export const IM_NO_TARGET =
    'knowledge-base 没有可用的 IM 目标：/kb 只回答 interaction-gate 配置的审批会话（im.approvalChatId），而它当前为空或 interaction 服务不可用；' +
    '要开放请改 interaction-gate 的 im.approvalChatId。'

/** The refusal when the invocation comes from another conversation. */
export const IM_NOT_TARGET =
    '该会话不是 interaction-gate 配置的审批会话；要开放请改 interaction-gate 的 im.approvalChatId（知识库不再维护自己的会话白名单）。'

/** The refusal when the target requires a p2p conversation and this is not one. */
export const IM_NOT_P2P =
    '该会话是群聊，而 interaction-gate 配置了 im.p2pOnly=true（只接受私聊）；要开放请把 interaction-gate 的 im.p2pOnly 设为 false。'

/** Why `/kb` is not registered when the host asked for IM but has no target. */
export const IM_NO_TARGET_PROBLEM =
    'IM 命令未注册：interaction-gate 没有配置 IM 目标（im.approvalChatId 为空，或 interaction 服务未装配/版本过旧）；' +
    '要启用请在 interaction-gate 的配置里设置 im.approvalChatId（/kb 的会话来源只有它）'

/**
 * Read the ONE IM target off the `interaction` service.
 *
 * Total by design: an absent service, an older build without `imTarget()`, a
 * throwing accessor and a malformed answer are all `undefined` — "no target",
 * which registers nothing. A malformed answer is never repaired into a chat id,
 * because a guessed target is a wrong conversation.
 * @param get - the runtime's service accessor (`ctx.get`).
 * @returns the target, or `undefined` when there is none usable.
 */
export function imTargetOf(get: (name: string) => unknown): ImTargetLike | undefined {
    let service: unknown
    try {
        service = get('interaction')
    } catch {
        return undefined
    }
    if (typeof service !== 'object' || service === null) return undefined
    let resolve: unknown
    try {
        resolve = (service as { imTarget?: unknown }).imTarget
    } catch {
        return undefined
    }
    if (typeof resolve !== 'function') return undefined
    let raw: unknown
    try {
        raw = (resolve as () => unknown).call(service)
    } catch {
        return undefined
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const chatId = (raw as { chatId?: unknown }).chatId
    if (typeof chatId !== 'string' || chatId.trim() === '') return undefined
    const channel = (raw as { channel?: unknown }).channel
    return {
        channel: typeof channel === 'string' ? channel : '',
        chatId: chatId.trim(),
        p2pOnly: (raw as { p2pOnly?: unknown }).p2pOnly === true,
    }
}

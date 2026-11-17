/**
 * The two IM target shapes, and the derivation of the ONE this gate publishes.
 *
 * `ImAskTarget` is the per-question target carried on an outgoing message;
 * `ImTarget` is the host-level conversation the registry publishes. They live
 * together — and outside `channels.ts`, which is already the process's largest
 * module — so "which conversation is this?" has one definition and one
 * derivation rather than a copy per consumer.
 *
 * Nothing is imported from `config.ts` on purpose: the resolved `im` block is
 * consumed structurally, so this module adds no edge to the plugin's import
 * graph (`config` already depends on `channels`).
 *
 * @module dsh-interaction-gate/im-target
 */

/**
 * The ONE IM conversation this host talks to, as the plugin resolved it.
 *
 * Published by the registry (`imTarget()`) so a sibling plugin that wants to
 * answer inside that same conversation reads the host's decision instead of
 * declaring a second one. Two copies of "which chat are we allowed to talk in"
 * drift: an operator changes `im.approvalChatId` in the profile and the other
 * copy silently keeps answering the old conversation.
 *
 * - `channel` is the resolved `im.channel` mode (`auto` / `off` / `required`);
 * - `chatId` is `im.approvalChatId`, trimmed and non-empty BY CONSTRUCTION
 *   (`imTarget()` is `undefined` otherwise — absent, not `''`, so a consumer
 *   cannot treat "not configured" as a chat id);
 * - `p2pOnly` is `im.p2pOnly` (whether a conversation must be proven p2p).
 *
 * A READ-ONLY projection: nothing here writes a target or adds a config key —
 * `im.approvalChatId` stays the only source.
 */
export interface ImTarget {
    /** The resolved `im.channel` mode (`auto` / `off` / `required`). */
    channel: string
    /** The configured approval conversation (`im.approvalChatId`), non-empty. */
    chatId: string
    /** Whether the conversation must be proven p2p (`im.p2pOnly`). */
    p2pOnly: boolean
}

/**
 * The explicit IM target of ONE ask (P0: never "whoever DMs the bot").
 *
 * Computed where the workspace is known (`tools.ts`, from `im.approvalChatId`
 * plus that repository's approver list), then carried on the message so:
 *
 *  - the channel adapter sends the card to exactly this conversation and tells
 *    the IM plugin which platform user ids may answer it (`chatId` / `from`);
 *  - a REPLAY of the same question re-sends it to the same conversation (the
 *    message, not a process-global "active chat", is the target);
 *  - the post-answer check in `tools.ts` compares the answer's provenance
 *    against the very target this ask was sent with.
 *
 * Absent = today's behaviour (the IM plugin resolves its own active chat).
 */
export interface ImAskTarget {
    /** The one conversation this card may go to. */
    chatId: string
    /** Platform user ids allowed to answer (`from`); non-empty by construction. */
    from: string[]
    /** Whether the answer chat must be proven p2p (`im.p2pOnly`). */
    p2pOnly: boolean
}

/**
 * Project the resolved IM configuration onto the published target.
 * @param im - the resolved `im` block (the host's own decision).
 * @returns the target, or `undefined` when no conversation is configured.
 */
export function imTargetOf(im: { channel: string; approvalChatId: string; p2pOnly: boolean }): ImTarget | undefined {
    const chatId = im.approvalChatId.trim()
    if (chatId === '') return undefined
    return { channel: im.channel, chatId, p2pOnly: im.p2pOnly }
}

/**
 * Call the injected resolver without ever throwing into the caller.
 *
 * The registry is total by contract (`channels.ts`): a sibling plugin that asks
 * for the target during its own `apply` must get "no target" instead of an
 * exception, so a throwing resolver is recorded and answered with `undefined`.
 * @param resolve - the injected resolver (`undefined` = this build publishes none).
 * @param note - the registry's bounded defect list.
 * @returns the target, or `undefined`.
 */
export function safeImTarget(
    resolve: (() => ImTarget | undefined) | undefined,
    note: (message: string) => void,
): ImTarget | undefined {
    if (resolve === undefined) return undefined
    try {
        return resolve()
    } catch (error) {
        note(`IM 目标解析失败：${error instanceof Error ? error.message : String(error)}（按"未配置 IM 目标"处理）`)
        return undefined
    }
}

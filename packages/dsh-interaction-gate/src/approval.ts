/**
 * The answerer for the HOST's approval seam (stage P1 of the IM-approval work).
 *
 * Until now every "may I do this?" from the harness went to `ctx.approval`
 * (`@deepseek-ai/dsh-user-approval`), which dispatches the `approval/request`
 * waterfall and lets the composed answerers decide. In practice that answerer is
 * a terminal: a phone cannot answer it and a headless session cannot either. This
 * module registers an answerer for exactly that seam, on the very same path the
 * `interaction_ask` tool uses (`askThroughChannels`): one-shot token, ask outbox,
 * decision ledger, and stage P0's `from` whitelist + provenance checks. A second
 * implementation would be a second place to get a permission wrong.
 *
 * ## Where it sits in the chain (and what that costs)
 *
 * cordis's waterfall runs composed listeners outermost-first; a listener that
 * RETURNS a value short-circuits the rest and a listener that calls `next()`
 * delegates to the next one (the host's own last step resolves `'unavailable'`).
 * We register with `{ prepend: true }`, so this answerer runs BEFORE whatever
 * the deployment had before (the TUI). That is a real trade-off and it is stated
 * rather than hidden: a waterfall cannot express "the TUI first, IM only if the
 * TUI declines" — the first listener that returns wins. So:
 *
 *  - `fallback`: run first; when the question cannot even be ASKED over IM (no
 *    usable channel, no approval target, no approver list, no workspace) call
 *    `next()` and let the existing answerer decide. It never sends a card and
 *    then also delegates: one question, one prompt.
 *  - `only`: run first and never delegate. "Cannot ask" is `'unavailable'`, which
 *    the host fails closed on. A deployment that said "only IM" must not be
 *    silently answered in a terminal its policy author is not watching.
 *  - `off` (default): no listener at all. Zero behaviour change, byte for byte.
 *
 * ## What a refusal is NOT
 *
 * No channel, a deadline, an answerer outside the list, an answer from another
 * conversation, an unproven chat kind — none of those is a human saying no. They
 * are `'unavailable'`, never `'rejected'`: mapping "nobody decided" onto
 * "somebody refused" invents a decision that did not happen.
 *
 * @module dsh-interaction-gate/approval
 */

import { normalizeApprovalReply, sessionCwd, sessionIdOf, type AgentLike } from 'dsh-eng-core'
import { CHAT_CHANNEL_NAME } from './chat-channel.js'
import { APPROVAL_SOURCE } from './ledger.js'
import type { ApprovalVia } from './config.js'
import { AskRefusal, askThroughChannels, type AskDecision, type ToolDeps } from './tools.js'
import { approvalRoutingOf } from './workspace-mapping.js'

/** The host's closed outcome vocabulary (`@deepseek-ai/dsh-user-approval`). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Every outcome, for normalisation. */
export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * What the ledger calls a question that came from the host seam instead of the
 * model's own `interaction_ask` (defined with the ledger field it fills).
 */
export { APPROVAL_SOURCE } from './ledger.js'

/** The declared options of an approval card: exactly the two a human may choose. */
export const APPROVAL_OPTIONS: readonly string[] = ['allowed-once', 'rejected']

/**
 * The `approval/request` payload, as much of it as an answerer needs.
 *
 * Structurally the host's `ApprovalRequest` (verified against
 * `@deepseek-ai/dsh-user-approval` 0.2.2-rc.1 `lib/types/index.d.ts`): the agent
 * the question is about, the tool, the call id when the asker had one, the
 * asker's reason, an optional localized presentation string and the request's
 * cancellation signal. Everything is `unknown`-tolerant here because this value
 * crosses a plugin seam and a malformed one must degrade to `'unavailable'`, not
 * throw inside the host's dispatch.
 */
export interface ApprovalRequestLike {
    readonly agent?: unknown
    readonly toolName?: unknown
    readonly callId?: unknown
    readonly reason?: unknown
    readonly displayReason?: unknown
    readonly signal?: unknown
}

/** What the plugin did about the seam (reported in the log and by `interaction_status`). */
export interface ApprovalAnswererHandle {
    mode: ApprovalVia
    /** Whether a listener was actually registered. `false` = zero behaviour change. */
    registered: boolean
    /** One-line, human-readable description of the registration (never a guess). */
    describe: () => string
    /** Remove the listener (idempotent). */
    dispose: () => void
}

/** Just enough of a cordis context: an event seam and nothing else. */
interface EventContextLike {
    on?: (event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => unknown
}

function textOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The reason a human should read.
 *
 * `displayReason` is the asker's LOCALIZED presentation (`{ en, zh?, … }`, never
 * persisted in the audit log); `reason` is its own explanation. Prefer the
 * Chinese presentation when the asker provided one, then the English one, then
 * the raw reason — and say so when there is none, instead of inventing a reason.
 */
export function reasonTextOf(request: ApprovalRequestLike): { text: string; fromDisplay: boolean } {
    const display = request.displayReason
    if (typeof display === 'object' && display !== null) {
        const record = display as Record<string, unknown>
        const localized = textOf(record['zh']) ?? textOf(record['en'])
        if (localized !== undefined) return { text: localized, fromDisplay: true }
    }
    const raw = textOf(request.reason)
    return raw === undefined ? { text: '', fromDisplay: false } : { text: raw, fromDisplay: false }
}

/** The agent a request is about, when it looks like one. */
export function agentOfRequest(request: ApprovalRequestLike): AgentLike | undefined {
    const raw = request.agent
    return typeof raw === 'object' && raw !== null ? (raw as AgentLike) : undefined
}

/** The question a human can act on, built from what the request actually carries. */
export interface ApprovalQuestion {
    question: string
    context: Record<string, unknown>
}

/**
 * Turn one `approval/request` into a card a person can decide.
 *
 * What actually exists on the request is `toolName`, `callId?`, `reason?`,
 * `displayReason?` and the agent; there is no "action" description and no diff,
 * so the card says exactly that and points at the reason. An approval card that
 * invented a description of the operation would be worse than a terse one.
 * @param request - the host's request (untrusted shape).
 */
export function approvalQuestionOf(request: ApprovalRequestLike): ApprovalQuestion {
    const toolName = textOf(request.toolName) ?? '(未报告工具名)'
    const callId = textOf(request.callId)
    const agent = agentOfRequest(request)
    const session = sessionIdOf(agent) ?? agent?.id
    const cwd = sessionCwd(agent, '')
    const reason = reasonTextOf(request)

    const lines = [
        `工具 ${toolName} 请求一次性放行${callId === undefined ? '' : `（调用 ${callId}）`}。`,
        ...(session === undefined ? [] : [`- 会话：${session}${cwd === '' ? '' : `（工作区 ${cwd}）`}`]),
        reason.text === ''
            ? '- 原因：发起方没有给出原因（这本身是一条信息）'
            : `- 原因：${reason.text}`,
        '',
        '回答 allowed-once 只放行这一次（不是长期豁免）；回答 rejected 是拒绝；不回答、超时、或回答者不在名单内都表示"没有人决定"，' +
            '那既不是同意，也不是拒绝。',
    ]

    const facts: Record<string, string> = { 工具: toolName }
    if (callId !== undefined) facts['调用'] = callId
    if (session !== undefined) facts['会话'] = session
    if (cwd !== '') facts['工作区'] = cwd

    return {
        question: lines.join('\n'),
        context: { kind: APPROVAL_SOURCE, title: `工具 ${toolName} 请求放行`, facts },
    }
}

/**
 * Map a decision word onto the host's closed vocabulary.
 *
 * Only two answers are offered on the card, and anything else normalises to
 * `'unavailable'` through the shared normaliser — fail closed, never a guessed
 * "yes".
 * @param decision - the decision stored in the ledger.
 */
export function outcomeOfDecision(decision: string): ApprovalOutcome {
    return normalizeApprovalReply(decision).decision
}

/** Options of {@link installApprovalAnswerer}. */
export interface ApprovalAnswererOptions {
    /** The channel name the IM adapter registers under (default `CHAT_CHANNEL_NAME`). */
    channelName?: string
}

/**
 * Register the approval answerer, when the host asked for it.
 *
 * `im.approvalVia=off` (the default, and what an unusable value resolves to)
 * registers NOTHING: no listener, no channel lookup, no log line beyond the
 * report — the host's seam keeps behaving exactly as it did.
 * @param ctx - the cordis context (only `on` is used).
 * @param deps - the plugin's tool dependencies (registry, configuration, clock).
 * @param options - the IM channel name to ask through.
 * @returns what was registered, for the log and the doctor.
 */
/**
 * Whether THIS workspace routed its approvals to IM.
 *
 * `owned` is true when the calling workspace hits an `im.approvals` entry, or when
 * no mapping is declared at all (the P1 configuration: `im.approvalChatId` is the
 * only target, so the IM answerer is the intended one). An un-matched workspace
 * under `refuse`/`local` does NOT belong here: refusing would make the approval
 * undecidable even though the native surfaces (desktop, web TUI, terminal) are
 * perfectly able to answer it — the plugin must get out of their way instead.
 * @param deps - tool dependencies (config, stores, logger).
 * @param request - the approval request (its agent names the session).
 * @returns the decision plus a human-readable reason for the log.
 */
function approvalOwnershipOf(deps: ToolDeps, request: ApprovalRequestLike): { owned: boolean; reason: string } {
    const agent = (request as { agent?: AgentLike }).agent
    const cwd = sessionCwd(agent, '')
    if (cwd === '') return { owned: true, reason: '会话没有声明工作区：沿用 P1 行为（IM 是唯一配置目标）' }
    try {
        const routing = approvalRoutingOf(cwd, deps.config.im)
        if (!routing.configured) return { owned: true, reason: `工作区未声明 im.approvals：沿用 P1 行为（im.approvalChatId=${deps.config.im.approvalChatId || '(空)'}）` }
        if (routing.matched !== undefined) return { owned: true, reason: `工作区命中 im.approvals[${routing.matched.index}]` }
        return {
            owned: false,
            reason: `工作区未命中 im.approvals 且策略为 ${routing.policy}：这个工作区的审批不走 IM`,
        }
    } catch (error) {
        // Reading the routing is pure (no I/O beyond the workspace path); a throw
        // here is a defect, and the safe direction is to stay out of the way.
        deps.logger?.warn(`approval/request：无法判定工作区归属（${describeError(error)}）：交还原生面`)
        return { owned: false, reason: '归属无法判定' }
    }
}

export function installApprovalAnswerer(
    ctx: unknown,
    deps: ToolDeps,
    options: ApprovalAnswererOptions = {},
): ApprovalAnswererHandle {
    const mode = deps.config.im.approvalVia
    const channelName = options.channelName ?? CHAT_CHANNEL_NAME
    if (mode === 'off') {
        return {
            mode,
            registered: false,
            describe: () =>
                deps.config.im.approvalViaProblem === undefined
                    ? 'off（未注册：审批接缝由宿主原有的应答者回答，行为与今天完全一致）'
                    : `off（im.approvalVia 不可用，已按 off 处理：${deps.config.im.approvalViaProblem}）`,
            dispose: () => undefined,
        }
    }

    const on = (ctx as EventContextLike | undefined)?.on
    if (typeof on !== 'function') {
        return {
            mode,
            registered: false,
            describe: () => `未注册：宿主的 ctx 没有 on()，无法监听 approval/request（已配置 ${mode}，但做不到）`,
            dispose: () => undefined,
        }
    }

    /**
     * One approval question, decided (or not) over IM.
     *
     * `next()` is the delegation to the answerers registered behind us. It is
     * called on exactly one condition — the ask could not even START (no card
     * left the process) — because a card that may already be on somebody's phone
     * must never be followed by a second prompt in another surface.
     */
    const answer = async (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
        const relay = async (): Promise<ApprovalOutcome> => {
            try {
                const delegated = await next()
                return APPROVAL_OUTCOMES.includes(delegated) ? delegated : 'unavailable'
            } catch (error) {
                deps.logger?.warn(`approval/request：下游应答者抛错，按 unavailable 处理（fail closed）：${describeError(error)}`)
                return 'unavailable'
            }
        }

        // The host's own semantics, honoured first: an already-aborted request is
        // a withdrawal, not a question.
        const signal = request?.signal
        if (signal !== undefined && signal !== null && (signal as AbortSignal).aborted === true) {
            deps.logger?.info('approval/request：请求已被中止（signal.aborted），直接返回 cancelled，不发出任何卡片')
            return 'cancelled'
        }

        // --- ownership: only take over what this workspace routed to IM --------
        //
        // The official surfaces answer `approval/request` themselves: the TUI in
        // the terminal, and — through `dsh-api-remotes`, which exposes the same
        // waterfall to clients — the desktop app and the web TUI. A plugin that
        // `prepend`s an answerer for EVERY request hijacks those: the local UI
        // never gets to render the approval. So the takeover is scoped to the
        // workspaces the operator routed here (`im.approvals` hit), and an
        // un-migrated workspace with no mapping at all keeps the P1 behaviour
        // (IM is the only configured target, so it owns the seam).
        const ownership = approvalOwnershipOf(deps, request)
        if (!ownership.owned) {
            // `only` promised "IM or nobody decides": deferring to the native
            // surfaces would break that promise just as surely as answering here
            // would break `local`. Every other mode defers.
            if (mode === 'only') {
                deps.logger?.warn(`approval/request：${ownership.reason}，但 approvalVia=only（不回落）→ unavailable`)
                return 'unavailable'
            }
            deps.logger?.info(`approval/request：${ownership.reason} → 交还原生面（desktop / web TUI / 本地终端）`)
            return await relay()
        }

        const built = approvalQuestionOf(request)
        try {
            const decision: AskDecision = await askThroughChannels(
                deps,
                {
                    question: built.question,
                    options: [...APPROVAL_OPTIONS],
                    // `decision-required`: a host approval IS a gate waiting for a
                    // person. The card must say that, and the attention queue
                    // must show it that way.
                    whyYou: 'decision-required',
                    // The IM surface, specifically: this seam lives under `im.*`,
                    // and an approval card must not land on some other channel
                    // because it happened to be registered.
                    prefer: channelName,
                    source: APPROVAL_SOURCE,
                    // An approval is a permission: only a named approver may grant
                    // it, even when the deployment did not make the list mandatory
                    // for ordinary questions.
                    requireAllowlist: true,
                    context: built.context,
                },
                { agent: agentOfRequest(request), ...(signal === undefined || signal === null ? {} : { signal: signal as AbortSignal }) },
            )
            const outcome = outcomeOfDecision(decision.decision)
            deps.logger?.info(
                `approval/request：工具 ${textOf(request?.toolName) ?? '(未报告)'} → ${outcome}` +
                    `（回答者 ${decision.by === '' ? '通道未提供身份' : decision.by}，通道 ${decision.channel}，台账行 ${decision.rowId}，令牌 ${decision.questionId}）`,
            )
            return outcome
        } catch (error) {
            if (!(error instanceof AskRefusal)) {
                // Every refusal the ask engine produces is an `AskRefusal` (it
                // carries "could a card have been sent?"), so a bare error here is
                // a defect in a shared helper — NOT evidence that nobody was
                // asked. Fail closed and say so rather than guessing.
                deps.logger?.warn(`approval/request：提问路径抛出非拒绝错误，按 unavailable 处理（fail closed）：${describeError(error)}`)
                return 'unavailable'
            }
            const refusal = error
            if (refusal.reason === 'cancelled') {
                deps.logger?.info('approval/request：等待被中止（请求的 signal），返回 cancelled')
                return 'cancelled'
            }
            if (refusal.cardAttempted) {
                // A human may already be looking at a card: asking a second
                // surface now would be the double prompt the design forbids.
                deps.logger?.warn(
                    `approval/request：IM 已回答不了这次审批（refused:${refusal.reason}），但没有落回原通道` +
                        '（卡片可能已经发出：同一问题不能问第二遍）→ unavailable',
                )
                return 'unavailable'
            }
            if (mode === 'fallback') {
                deps.logger?.warn(
                    `approval/request：IM 连问都问不了（refused:${refusal.reason}，没有发过卡片）→ 交给下一个应答者（next()）`,
                )
                return await relay()
            }
            // `only`: the deployment said "IM, or nobody decides".
            deps.logger?.warn(`approval/request：approvalVia=only 且 IM 问不了（refused:${refusal.reason}）→ unavailable（不落回原通道）`)
            return 'unavailable'
        }
    }

    const dispose = on(
        'approval/request',
        answer as unknown as (...args: never[]) => unknown,
        // In FRONT of the chain: see the module comment for what that buys and
        // what it costs. Without `prepend` this answerer would only ever run
        // after the terminal answerer already decided — i.e. never.
        { prepend: true },
    )

    let disposed = false
    return {
        mode,
        registered: true,
        describe: () =>
            `${mode}（已注册 approval/request 应答者，prepend=true：本应答者先问 IM；` +
            (mode === 'fallback'
                ? '问不了（没发过卡片）就 next() 交还原通道；卡片发出后等不到答案 = unavailable，不再落回）'
                : '问不了一律 unavailable，绝不落回原通道）'),
        dispose: () => {
            if (disposed) return
            disposed = true
            if (typeof dispose === 'function') dispose()
        },
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

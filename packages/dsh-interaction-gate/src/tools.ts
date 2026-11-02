/**
 * The model-facing tool surface: `interaction_ask`, `interaction_notify`,
 * `interaction_progress`, `interaction_status`.
 *
 * Division of labour:
 *
 *  - the CHANNEL decides how a message travels (an IM card, a terminal, a
 *    webhook). The registry only decides which channel is usable and never lets
 *    one break the call;
 *  - the TOKEN decides which answer belongs to which question: unpredictable,
 *    one-shot, retired when the ask ends, and matched again on the way back;
 *  - the LEDGER records what happened — who answered, through which channel,
 *    after how long. It grants nothing;
 *  - the MODEL decides nothing on a human's behalf. No usable channel, a
 *    deadline, an unauthorized answerer and an answer that maps to no declared
 *    option are all REFUSALS with the exact reason, never a default "yes".
 *
 * `interaction_ask` throws on a refusal (a decision that did not happen must
 * stop the caller); `interaction_notify` / `interaction_progress` report
 * failures in their text (a notification is best-effort and must never block a
 * turn, and a failed push is not a decision either way).
 *
 * @module dsh-interaction-gate/tools
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    approverName,
    assertSafeId,
    formatTime,
    isSafeId,
    normalizeApprovalReply,
    parseApprovalContext,
    proseOf,
    readText,
    renderApprovalContext,
    sessionCwd,
    sessionIdOf,
    type AgentLike,
    type ApprovalContext,
    type Layout,
    type Logger,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import {
    describeIm,
    newQuestionToken,
    type AwaitResult,
    type ChannelInfo,
    type InteractionChannel,
    type InteractionMessage,
    type InteractionRegistry,
} from './channels.js'
import { DEFAULT_MAX_PAYLOAD_CHARS, describeSource, NOTIFY_LEVELS, type EffectiveConfig, type InteractionGateConfig, type NotifyLevel } from './config.js'
import {
    appendLedgerRow,
    newRowId,
    readLedger,
    refusalOf,
    summarizeLedger,
    FILTERED,
    NOTIFIED,
    NOTIFY_FAILED,
    PROGRESS,
    type LedgerRow,
} from './ledger.js'
import {
    describeConversation,
    describeReplay,
    isOutboxSettled,
    ORDER_FAILURE_LIMIT,
    OUTBOX_STATES,
    outboxRecords,
    readOutbox,
    summarizeOutbox,
    type Outbox,
    type OutboxDeliver,
} from './outbox.js'
import { checkOutgoing, compileRedactPatterns, describeHits, scanApprovalContext, truncate, type SecretRule } from './redact.js'

const TEXT_OUTPUT = { type: 'string' } as const

/**
 * Window in which an identical consecutive `interaction_progress` payload is
 * suppressed. Long enough that a tight loop cannot spam a chat, short enough
 * that a stage which genuinely reports the same thing every minute still lands.
 */
export const PROGRESS_DEDUPE_WINDOW_MS = 5_000

/** How many ledger rows `interaction_status` shows verbatim. */
export const STATUS_RECENT_ROWS = 10

/** Message ids: the suite's approved vocabulary, reused so a gate can route its own approval here. */
const SUITE_DECISIONS: readonly string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** Everything the tools close over. */
export interface ToolDeps {
    config: InteractionGateConfig
    /** Resolved per-call configuration (host row + `<repo>/.dsh/interaction-gate.json`). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    /** The channel registry this plugin provides as `interaction`. */
    registry: InteractionRegistry
    /**
     * The ask outbox of one workspace (one file). The plugin owns the cache, so
     * every tool call of a session sees the same records.
     */
    outboxFor: (cwd: string, config: InteractionGateConfig) => Outbox
    logger?: Logger
    /** Injected clock (no clock inside pure helpers). */
    now: () => number
}

/** Arguments of `interaction_ask`. */
interface AskArgs {
    question?: string
    options?: string[]
    timeoutMs?: number
    missionId?: string
    context?: Record<string, unknown>
    prefer?: string
}

/** Arguments of `interaction_notify`. */
interface NotifyArgs {
    level?: string
    title?: string
    body?: string
    missionId?: string
}

/** Arguments of `interaction_progress`. */
interface ProgressArgs {
    stage?: string
    elapsedMs?: number
    note?: string
    missionId?: string
}

/** Arguments of `interaction_status`. */
interface StatusArgs {
    missionId?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

/** The workspace of the calling agent, refusing an unknown one (never guess a project). */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = sessionCwd(agent, '')
    if (cwd === '') {
        throw new Error(
            '无法确定工作区：调用方 agent 没有会话目录（session.header.cwd）。交互层的台账与审批人名单都是按仓库落盘的，' +
                '在不知道工作区的前提下提问会把决定写进错误的仓库。下一步：在带 cwd 的会话里调用（宿主应给会话设置 header.cwd）。',
        )
    }
    return cwd
}

/**
 * The conversation a channel sends into, when the channel can name one.
 *
 * The outbox keys its ordering by `(channel, chatId)`: two questions in one IM
 * chat go out in order, two questions in different chats never wait for each
 * other. A channel without `chatId` has one implicit conversation (its asks
 * serialize), which is the conservative reading of "we cannot tell them apart".
 */
export function chatIdOf(channel: InteractionChannel): string | undefined {
    const raw = (channel as { chatId?: unknown }).chatId
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** Resolve a workspace-relative artifact path (an absolute value stays absolute). */
export function artifactPathOf(cwd: string, file: string): string {
    return path.isAbsolute(file) ? file : path.join(cwd, file)
}

/** Declared options: trimmed, non-empty, unique case-insensitively, order preserved. */
export function normalizeOptions(raw: unknown): { options: string[]; problem?: string } {
    if (raw === undefined || raw === null) return { options: [] }
    if (!Array.isArray(raw)) return { options: [], problem: `options 必须是字符串数组（收到 ${JSON.stringify(raw)}）` }
    const options: string[] = []
    for (const entry of raw) {
        if (typeof entry !== 'string') return { options: [], problem: 'options 里的每一项都必须是字符串' }
        const trimmed = entry.trim()
        if (trimmed === '') return { options: [], problem: 'options 里不能有空项' }
        if (options.some((option) => option.toLowerCase() === trimmed.toLowerCase())) {
            return { options: [], problem: `options 里有重复项（大小写不敏感）：${JSON.stringify(trimmed)}——重复选项会让"答的是哪一个"无法确定` }
        }
        options.push(trimmed)
    }
    return { options }
}

/**
 * Map an answer onto a declared option.
 *
 * Exact match first, then a case-insensitive match (answering `Yes` to `yes` is
 * the same decision). Anything else is `undefined`: an unknown answer is a
 * refusal, never the closest option.
 */
export function mapOption(answer: string, options: readonly string[]): string | undefined {
    if (options.length === 0) return answer.trim() === '' ? undefined : answer.trim()
    const trimmed = answer.trim()
    const exact = options.find((option) => option === trimmed)
    if (exact !== undefined) return exact
    const folded = options.filter((option) => option.toLowerCase() === trimmed.toLowerCase())
    return folded.length === 1 ? folded[0] : undefined
}

/** The suite's decision vocabulary, normalised through the shared normaliser. */
export function normalizeDecision(
    decision: string,
    by: string,
    messageId: string | undefined,
    channel: string,
): { decision: string; allowed: boolean; userId: string } {
    if (!SUITE_DECISIONS.includes(decision)) {
        return { decision, allowed: false, userId: by }
    }
    const outcome = normalizeApprovalReply({
        decision: decision as 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
        ...(by === '' ? {} : { by }),
        ...(messageId === undefined ? {} : { messageId }),
        source: channel,
    })
    return { decision: outcome.decision, allowed: outcome.allowed, userId: approverName(outcome, by) }
}

/** Approver-list state for one workspace. */
export interface ApproversState {
    file: string
    present: boolean
    ids: string[]
    problems: string[]
}

/** Read the project approver list (one id per line, `#` comments, blank lines ignored). */
export function approversOf(cwd: string, config: InteractionGateConfig): ApproversState {
    const file = artifactPathOf(cwd, config.approversFile)
    const text = readText(file)
    if (text === undefined) {
        return { file, present: false, ids: [], problems: config.requireApproverList ? [`审批人名单不存在：${file}`] : [] }
    }
    const ids: string[] = []
    const problems: string[] = []
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        if (!ids.includes(trimmed)) ids.push(trimmed)
    }
    if (config.requireApproverList && ids.length === 0) problems.push(`审批人名单为空（全是注释/空行）：${file}`)
    return { file, present: true, ids, problems }
}

/** Whether an answerer may answer, and why not. */
export function approveCheck(by: string, approvers: ApproversState, required: boolean): { ok: boolean; reason: string } {
    if (!required) return { ok: true, reason: '' }
    if (by === '') {
        return { ok: false, reason: '答案没有回答者身份（通道没有提供 by），而 requireApproverList=true：无法核对名单，按未授权处理（fail closed）' }
    }
    const exact = approvers.ids.includes(by)
    const folded = approvers.ids.some((id) => id.toLowerCase() === by.toLowerCase())
    if (!exact && !folded) {
        return { ok: false, reason: `${JSON.stringify(by)} 不在项目审批人名单里（${approvers.file}，共 ${approvers.ids.length} 个 id）` }
    }
    return { ok: true, reason: '' }
}

/** The `approval-context` fields a caller may pass, validated field by field. */
export function normalizeApprovalContextInput(raw: unknown): { context?: ApprovalContext; problems: string[] } {
    if (raw === undefined || raw === null) return { problems: [] }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { problems: [`context 必须是对象（收到 ${JSON.stringify(raw)}），已忽略`] }
    }
    const source = raw as Record<string, unknown>
    const problems: string[] = []
    const context: ApprovalContext = {}
    const takeString = (key: 'kind' | 'missionId' | 'title' | 'risk'): void => {
        const value = source[key]
        if (value === undefined) return
        if (typeof value === 'string' && value.trim() !== '') {
            context[key] = value.trim()
            return
        }
        problems.push(`context.${key} 必须是非空字符串，已忽略该字段`)
    }
    for (const key of ['kind', 'missionId', 'title', 'risk'] as const) takeString(key)
    const revision = source['revision']
    if (revision !== undefined) {
        if (typeof revision === 'string' || typeof revision === 'number') context.revision = revision
        else problems.push('context.revision 必须是字符串或数字，已忽略该字段')
    }
    const artifacts = source['artifacts']
    if (artifacts !== undefined) {
        if (Array.isArray(artifacts) && artifacts.every((entry) => typeof entry === 'string')) context.artifacts = artifacts as string[]
        else problems.push('context.artifacts 必须是字符串数组，已忽略该字段')
    }
    const facts = source['facts']
    if (facts !== undefined) {
        if (typeof facts === 'object' && facts !== null && !Array.isArray(facts)) {
            const kept: Record<string, string | number> = {}
            for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
                if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) kept[key] = value
                else problems.push(`context.facts.${key} 必须是字符串或数字，已忽略该字段`)
            }
            if (Object.keys(kept).length > 0) context.facts = kept
        } else {
            problems.push('context.facts 必须是对象，已忽略该字段')
        }
    }
    const hints = source['channelHints']
    if (hints !== undefined) {
        if (typeof hints === 'object' && hints !== null && !Array.isArray(hints)) {
            const record = hints as Record<string, unknown>
            const channelHints: { buttons?: string[]; requiresReason?: boolean } = {}
            if (Array.isArray(record['buttons']) && record['buttons'].every((entry) => typeof entry === 'string')) {
                channelHints.buttons = record['buttons'] as string[]
            } else if (record['buttons'] !== undefined) {
                problems.push('context.channelHints.buttons 必须是字符串数组，已忽略该字段')
            }
            if (typeof record['requiresReason'] === 'boolean') channelHints.requiresReason = record['requiresReason']
            else if (record['requiresReason'] !== undefined) problems.push('context.channelHints.requiresReason 必须是布尔值，已忽略该字段')
            if (Object.keys(channelHints).length > 0) context.channelHints = channelHints
        } else {
            problems.push('context.channelHints 必须是对象，已忽略该字段')
        }
    }
    for (const key of Object.keys(source)) {
        if (!['kind', 'missionId', 'title', 'revision', 'risk', 'artifacts', 'facts', 'channelHints'].includes(key)) {
            problems.push(`context.${key} 不是 approval-context 的已知字段，已忽略（不发明第二套约定）`)
        }
    }
    return Object.keys(context).length === 0 ? { problems } : { context, problems }
}

/**
 * Bounded rate for `interaction_progress`.
 *
 * Only an IDENTICAL CONSECUTIVE payload inside the window is suppressed: A, B, A
 * is three real reports ("stage A is running again"), A, A, A is one.
 */
export class ProgressGate {
    private last: { key: string; at: number } | undefined

    /**
     * @param key - the payload identity (kind + mission + title + body).
     * @param now - epoch ms (injected).
     * @returns whether this payload must be suppressed, and when the same one last went out.
     */
    check(key: string, now: number): { suppressed: boolean; lastAt?: number } {
        if (this.last === undefined || this.last.key !== key) return { suppressed: false }
        if (now - this.last.at >= PROGRESS_DEDUPE_WINDOW_MS) return { suppressed: false }
        return { suppressed: true, lastAt: this.last.at }
    }

    /** Record a payload that actually went out (a failed send does not count). */
    mark(key: string, now: number): void {
        this.last = { key, at: now }
    }
}

/** Pick the channels `interaction_ask` may use, in order. */
export function askCandidates(
    config: InteractionGateConfig,
    list: readonly ChannelInfo[],
    prefer?: string,
): { candidates: ChannelInfo[]; problem?: string } {
    if (prefer !== undefined && prefer !== '') {
        const named = list.find((info) => info.name === prefer)
        if (named === undefined) {
            return {
                candidates: [],
                problem: `prefer="${prefer}" 的通道没有注册（已注册：${list.map((info) => info.name).join(', ') || '无'}）——指定了通道就按指定来，绝不改发到别的通道`,
            }
        }
        if (!named.canAsk) {
            return { candidates: [], problem: `prefer="${prefer}" 的通道问不了人：${named.reason === '' ? '未实现 wait()' : named.reason}` }
        }
        return { candidates: [named] }
    }
    const ordered: ChannelInfo[] = []
    for (const name of config.preferredChannels) {
        const found = list.find((info) => info.name === name)
        if (found !== undefined && !ordered.includes(found)) ordered.push(found)
    }
    for (const info of list) if (!ordered.includes(info)) ordered.push(info)
    return { candidates: ordered.filter((info) => info.canAsk) }
}

/** The channels `interaction_notify` / `interaction_progress` push to. */
export function notifyTargets(config: InteractionGateConfig, list: readonly ChannelInfo[]): ChannelInfo[] {
    const selected =
        config.preferredChannels.length === 0 ? [...list] : list.filter((info) => config.preferredChannels.includes(info.name))
    return selected.filter((info) => info.canNotify)
}

/** Configured-but-unregistered channel names (reported, never silently ignored). */
export function missingPreferred(config: InteractionGateConfig, list: readonly ChannelInfo[]): string[] {
    return config.preferredChannels.filter((name) => !list.some((info) => info.name === name))
}

/** Resolve the mission a row is annotated with (explicit id, else the session binding). */
export function missionIdOf(deps: ToolDeps, cwd: string, agent: AgentLike | undefined, explicit?: string): string | undefined {
    if (explicit !== undefined && explicit !== '') return assertSafeId(explicit, 'mission id')
    try {
        return deps.stores.for(cwd).active(sessionIdOf(agent))?.id
    } catch {
        return undefined
    }
}

/** First non-empty line, bounded (a card title must not be a paragraph). */
function headline(text: string, maxChars = 80): string {
    const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry !== '') ?? ''
    return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`
}

/** Bounded text for a report line (a free-text answer may be megabytes long). */
function bounded(text: string, maxChars: number): string {
    return truncate(text, maxChars).text
}

/** Render one ledger row, bounded, for the status report. */
function describeRow(row: LedgerRow, maxChars: number = DEFAULT_MAX_PAYLOAD_CHARS): string {
    const parts = [
        formatTime(row.at),
        row.kind,
        row.decision === undefined ? '(未决定)' : bounded(row.decision, maxChars),
        row.channel ?? '(无通道)',
        ...(row.userId === undefined ? [] : [`回答者 ${row.userId}`]),
        ...(row.questionId === undefined ? [] : [row.questionId]),
        ...(row.durationMs === undefined ? [] : [`${row.durationMs}ms`]),
        headline(row.title, 60),
    ]
    return `- ${parts.join(' | ')}`
}

function countLines(counts: Record<string, number>, empty = '（无）', maxChars: number = DEFAULT_MAX_PAYLOAD_CHARS): string {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return entries.length === 0 ? empty : entries.map(([key, value]) => `${bounded(key, maxChars)}=${value}`).join('，')
}

/** What one ask's delivery path needs (built once per ask; a replay reuses it). */
export interface AskDelivererDeps {
    /** Only `send` is used: the delivery path must not arm, wait or decide anything. */
    registry: Pick<InteractionRegistry, 'send'>
    /** The workspace decision ledger: its `ask` row is the RECEIPT of a delivery. */
    ledgerFile: string
    /** The exact card payload (the same object for every attempt and every replay). */
    message: InteractionMessage
    questionId: string
    now: () => number
    missionId?: string
}

/**
 * Build the ONE delivery path of an ask: send, then write the ledger `ask` row
 * at most once per `(question, channel)`.
 *
 * The ledger row is the receipt — it is written only AFTER a successful send,
 * so finding one for the same question and channel means the card already left
 * the process. A replay then reuses that row instead of asking a human a second
 * time: a replayed question never becomes a second question in the ledger.
 *
 * @param deps - registry, ledger path, payload, token and clock.
 * @returns the deliverer the outbox calls for `intent`/`send-failed` records.
 */
export function createAskDeliverer(deps: AskDelivererDeps): OutboxDeliver {
    return async (record) => {
        const already = readLedger(deps.ledgerFile).rows.find(
            (row) => row.kind === 'ask' && row.questionId === deps.questionId && row.channel === record.channel,
        )
        if (already !== undefined) {
            return {
                ok: true,
                ...(already.messageId === undefined ? {} : { messageId: already.messageId }),
                ledgerRowId: already.id,
                ledgerReused: true,
            }
        }
        const sent = await deps.registry.send(record.channel, deps.message)
        if (!sent.ok) {
            return {
                ok: false,
                error: sent.error ?? '通道未说明失败原因',
                ...(sent.permanent === true ? { permanent: true } : {}),
                ...(sent.defer === true ? { deferred: true } : {}),
            }
        }
        const pending: LedgerRow = {
            at: deps.now(),
            id: newRowId(),
            kind: 'ask',
            title: deps.message.title,
            questionId: deps.questionId,
            channel: record.channel,
            ...(deps.missionId === undefined ? {} : { missionId: deps.missionId }),
            ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
        }
        const appended = appendLedgerRow(deps.ledgerFile, pending)
        if (!appended.ok) {
            return {
                ok: true,
                ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
                ledgerProblem: appended.problem ?? '台账写入失败',
            }
        }
        return { ok: true, ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }), ledgerRowId: pending.id }
    }
}

/**
 * Register the four tools.
 * @param ctx - the tool runtime (narrow structural view of `ctx.tools`).
 * @param deps - configuration, stores, the channel registry and a clock.
 */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const progressGate = new ProgressGate()
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    /** Append one row, returning the failure text instead of throwing. */
    const write = (file: string, row: LedgerRow): { ok: boolean; problem?: string } => appendLedgerRow(file, row)

    /**
     * Refuse an ask: write the refusal row, then throw with the exact reason.
     *
     * Nothing is guessed here. A refusal is a decision that did NOT happen, and
     * the caller must treat it as such (fail closed).
     */
    // A function DECLARATION on purpose: TypeScript's control-flow analysis only
    // treats a `never`-returning call as terminating for declarations and for
    // explicitly-typed consts. Written as an inferring arrow, every caller would
    // have to re-assert "we threw" — which is exactly the sort of thing that
    // silently turns a refusal into a fall-through.
    function refuseAsk(params: {
        ledgerFile: string
        reason: string
        detail: string
        title: string
        questionId: string
        durationMs: number
        next: string
        channel?: string
        userId?: string
        messageId?: string
        missionId?: string
        extraLines?: string[]
        /**
         * The outbox this ask wrote to (when one was touched). Its records are
         * settled with `settle` and their state is reported in the refusal: the
         * outbox must never be able to turn "no decision" into a decision, and
         * a refusal that leaves a question silently retryable would be a lie.
         */
        outbox?: Outbox
        settle?: { state: 'timeout' | 'withdrawn'; reason: string }
    }): never {
        const row: LedgerRow = {
            at: deps.now(),
            id: newRowId(),
            kind: 'ask',
            title: params.title,
            questionId: params.questionId,
            decision: refusalOf(params.reason),
            durationMs: Math.max(0, Math.round(params.durationMs)),
            ...(params.channel === undefined ? {} : { channel: params.channel }),
            ...(params.userId === undefined ? {} : { userId: params.userId }),
            ...(params.messageId === undefined ? {} : { messageId: params.messageId }),
            ...(params.missionId === undefined ? {} : { missionId: params.missionId }),
        }
        const appended = write(params.ledgerFile, row)
        const outboxLines: string[] = []
        if (params.outbox !== undefined) {
            if (params.settle !== undefined) {
                params.outbox.settleQuestion(params.questionId, params.settle.state, params.settle.reason)
            }
            outboxLines.push(...params.outbox.linesFor(params.questionId))
        }
        throw new Error(
            [
                `interaction_ask 拒绝（${refusalOf(params.reason)}）：${params.detail}`,
                ...(params.extraLines ?? []),
                `- 一次性令牌：${params.questionId}`,
                appended.ok
                    ? `- 台账：${params.ledgerFile}（行 ${row.id}，决定 ${refusalOf(params.reason)}）`
                    : `- ⚠️ 台账写入失败：${appended.problem ?? '未知原因'}`,
                ...outboxLines,
                `下一步：${params.next}`,
            ].join('\n'),
        )
    }

    register(
        defineTool({
            name: 'interaction_ask',
            description:
                'Ask a human a question that genuinely needs deciding (a specification, a delivery, loosening a gate, adding a dependency) through the suite\'s own interaction channels — one-shot token, project approver list when configured, decision ledger. Picks the first usable channel (declared preference, then registration order), sends the card/message and waits for the answer within the deadline. Returns the decision, WHO answered, through WHICH channel and the ledger row id. REFUSES with the exact reason when no channel can answer, when the deadline passes, when the answerer is not allowed to answer, or when the answer maps to no declared option — it never guesses and never defaults to yes. If only one option really means "go ahead", pass the suite vocabulary (allowed-once / rejected / cancelled / unavailable) as the options.',
            parameters: {
                question: { type: 'string', required: true, description: 'The question, in the language the human reads. May embed an approval-context block.' },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Declared options (rendered as buttons when the channel can). The answer must match one of them; omit them only for a genuinely free-text question.',
                },
                timeoutMs: { type: 'integer', description: 'Deadline in ms. Clamped DOWN to the host ceiling (askTimeoutMs); it can never extend it.' },
                missionId: { type: 'string', description: 'Mission the decision belongs to (default: the session mission, when there is one).' },
                context: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Optional approval-context fields for the card: kind / missionId / title / revision / risk / artifacts / facts / channelHints. Unknown fields are ignored and reported, not invented into the block.',
                },
                prefer: { type: 'string', description: 'Force one channel by name. If it is not registered or cannot answer, the ask is REFUSED rather than sent somewhere else.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: AskArgs = {} as AskArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                if (!config.enabled) throw new Error('dsh-interaction-gate 已被宿主禁用（enabled=false）')
                const startedAt = deps.now()
                const signal = signalOf(exec)

                const question = (args.question ?? '').trim()
                if (question === '') {
                    throw new Error('interaction_ask 拒绝（refused:bad-request）：question 不能为空。下一步：写清楚要人决定什么。')
                }
                const options = normalizeOptions(args.options)
                if (options.problem !== undefined) {
                    throw new Error(
                        `interaction_ask 拒绝（refused:bad-request）：${options.problem}。下一步：把选项写成互不重复的非空字符串（例如 ["deploy","hold"]）。`,
                    )
                }
                const declared = options.options
                const configuredTimeout = config.askTimeoutMs
                let timeoutMs = configuredTimeout
                if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
                    const wanted = args.timeoutMs
                    if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) {
                        throw new Error(
                            `interaction_ask 拒绝（refused:bad-request）：timeoutMs 必须是正整数（收到 ${JSON.stringify(wanted)}）。` +
                                `下一步：省略它使用宿主上限 ${configuredTimeout}ms，或给一个更短的毫秒数。`,
                        )
                    }
                    timeoutMs = Math.min(configuredTimeout, Math.floor(wanted))
                }

                const ledgerFile = artifactPathOf(cwd, config.ledgerFile)
                deps.registry.trackLedger(ledgerFile)
                const outbox = deps.outboxFor(cwd, config)
                // Replay happens on the next OPPORTUNITY, never on a timer: this
                // plugin is session-scoped, not a daemon. "Just before a new ask"
                // is that moment (the other one is `apply`, when a workspace is
                // knowable). An idle session does not retry — that is the boundary.
                const replayed = await outbox.replay('ask')
                if (replayed.considered > 0) deps.logger?.info(describeReplay(replayed))
                const missionId = missionIdOf(deps, cwd, agent, args.missionId)
                const questionId = newQuestionToken()
                const contextInput = normalizeApprovalContextInput(args.context)
                const embedded = parseApprovalContext(question)
                const context = contextInput.context ?? embedded
                const prose = proseOf(question)
                const title = `需要决定：${headline(prose, 64)}`
                const tokenLine = `一次性令牌：${questionId}（回答必须对得上本次提问；它只对这一次有效）`
                const optionLines =
                    declared.length === 0
                        ? ['选项：（自由文本回答；请直接回一句话）']
                        : [`选项（必须选一个，大小写不敏感）：${declared.join(' / ')}`]
                const rawBody =
                    context === undefined
                        ? [prose, '', ...optionLines, tokenLine].join('\n')
                        : [renderApprovalContext(prose, context), ...optionLines, tokenLine].join('\n')
                const body = truncate(rawBody, config.maxPayloadChars)
                const titleOut = truncate(title, 200)

                // --- redaction: a payload that would leak a credential is refused ---
                const compiled = compileRedactPatterns(config.redactPatterns)
                const verdict = checkOutgoing(
                    [
                        { name: 'title', text: titleOut.text },
                        { name: 'body', text: body.text },
                        ...(declared.length === 0 ? [] : [{ name: 'options', text: declared.join('\n') }]),
                    ],
                    compiled.rules,
                )
                const contextVerdict = context === undefined ? { ok: true, hits: [], problems: [] } : scanApprovalContext(context, compiled.rules)
                const hits = [...verdict.hits, ...contextVerdict.hits]
                if (hits.length > 0) {
                    refuseAsk({
                        ledgerFile,
                        reason: 'secret',
                        detail: '载荷里检测到疑似凭据，已拒绝发送（绝不"打码后照发"：卡片一旦发出去就收不回来了）',
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        extraLines: [`- 命中规则：`, ...describeHits(hits, compiled.rules)],
                        next: '把凭据从问题/上下文里去掉（只描述位置，例如"仓库根的 .env 里那把 key"），需要审批人看凭据就走带权限的通道，不要贴进卡片。',
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }

                // --- approver list: refuse BEFORE sending a card nobody may answer ---
                const approvers = approversOf(cwd, config)
                if (config.requireApproverList && approvers.ids.length === 0) {
                    refuseAsk({
                        ledgerFile,
                        reason: 'approvers-missing',
                        detail: `requireApproverList=true，但项目审批人名单不可用：${approvers.problems.join('；') || approvers.file}`,
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        extraLines: [`- 名单文件：${approvers.file}（存在=${approvers.present}，有效 id=${approvers.ids.length}）`],
                        next: `由人写 ${config.approversFile}（一行一个 id，# 开头为注释）；名单为空时问出去也没人能合法回答，所以这里不发卡片。`,
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }

                // --- channel selection ---
                const list = deps.registry.list()
                const selection = askCandidates(config, list, args.prefer)
                if (selection.problem !== undefined || selection.candidates.length === 0) {
                    const explicit = args.prefer !== undefined && args.prefer !== ''
                    refuseAsk({
                        ledgerFile,
                        reason: explicit ? 'channel-unusable' : 'no-channel',
                        detail: selection.problem ?? '没有可用的提问通道：注册的通道都不能收答案（没有 wait() 就没人能回答）',
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        extraLines: [
                            '- 已注册通道：',
                            ...(list.length === 0
                                ? ['  （无）']
                                : list.map((info) => `  ${info.name}：canAsk=${info.canAsk}，canNotify=${info.canNotify}${info.reason === '' ? '' : `（${info.reason}）`}`)),
                        ],
                        next:
                            list.length === 0
                                ? '让宿主/IM 插件向 `interaction` 服务注册一个通道（register({ name, send, wait, describe })）后重试；需要人决定的事不要自己拍板。'
                                : '换一个能收答案的通道（`prefer` 或配置 preferredChannels），或让该通道实现 wait()。',
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }

                if (!deps.registry.arm(questionId)) {
                    refuseAsk({
                        ledgerFile,
                        reason: 'token-lost',
                        detail: '一次性令牌无法登记（重复或为空）——这次提问没有可归属的令牌',
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        next: '重新提问（会生成新令牌）；重复出现说明令牌生成有问题，不要在令牌不可靠时接受任何答案。',
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }
                // One payload for every candidate AND every replay: a re-sent card
                // is byte-identical to the first attempt, so a human cannot tell
                // two questions apart that were meant to be one.
                const askMessage: InteractionMessage = {
                    kind: 'ask',
                    title: titleOut.text,
                    body: body.text,
                    questionId,
                    ...(declared.length === 0 ? {} : { buttons: declared.map((option) => ({ value: option, label: option })) }),
                }
                const deliverAsk = createAskDeliverer({
                    registry: deps.registry,
                    ledgerFile,
                    message: askMessage,
                    questionId,
                    now: deps.now,
                    ...(missionId === undefined ? {} : { missionId }),
                })

                const failures: string[] = []
                /** Deferrals and retry facts: stated in the report, never swallowed. */
                const outboxNotes: string[] = []
                /** Which kind of obstacle the candidates hit (the refusal names it). */
                let sawDeferral = false
                let sendFailed = false
                for (const candidate of selection.candidates) {
                    const channel = deps.registry.get(candidate.name)
                    if (channel === undefined) {
                        sendFailed = true
                        failures.push(`- ${candidate.name}：通道在发送前被注销`)
                        continue
                    }

                    // ① The intent row is on disk BEFORE the channel is touched.
                    const chatId = chatIdOf(channel)
                    const begun = outbox.begin({ questionId, channel: candidate.name, ...(chatId === undefined ? {} : { chatId }) })
                    if (begun.problem !== undefined) {
                        deps.registry.retire(questionId)
                        refuseAsk({
                            ledgerFile,
                            reason: 'outbox-unwritable',
                            detail:
                                `提问的意图记录写不进 outbox（${outbox.file}），崩溃/重启后就没人能说明"我们问过谁"，所以这里不发卡片：` +
                                begun.problem,
                            title: titleOut.text,
                            questionId,
                            durationMs: deps.now() - startedAt,
                            extraLines: ['- 说明：意图先落盘、再发卡片——没有那一行就不发。'],
                            next: `修好 ${outbox.file} 的写入（目录存在且可写）后重试；需要人决定的事不要因为写不进记录就自己拍板。`,
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }
                    const recordId = begun.record.id
                    if (!begun.created && isOutboxSettled(begun.record.state)) {
                        deps.registry.retire(questionId)
                        refuseAsk({
                            ledgerFile,
                            reason: 'outbox-settled',
                            detail:
                                `同一个内容寻址的 outbox 记录（${recordId}）已经结案（state=${begun.record.state}）：` +
                                '一次提问只有一条记录——重放不会再造第二道提问，旧的决定也不会被当成新的决定',
                            title: titleOut.text,
                            questionId,
                            durationMs: deps.now() - startedAt,
                            outbox,
                            next: '重新提问（会生成新令牌与新记录）；重复出现说明调用方在复用同一个令牌，检查调用方。',
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }

                    // ② Per-conversation order: a later send WAITS while an earlier
                    //    question of the same (channel, chatId) is unsettled. The
                    //    wait is a deferral — it never touches `attempts`.
                    const slot = await outbox.awaitSlot(recordId, startedAt + timeoutMs)
                    if (!slot.ok) {
                        const waiting = slot.blockedBy === undefined ? '更早的提问' : `${slot.blockedBy.id}（已失败 ${slot.blockedBy.attempts} 次）`
                        sawDeferral = true
                        failures.push(`- ${candidate.name}：同会话排队超时（等了 ${Math.round(slot.waitedMs)}ms，${waiting} 仍未落定）`)
                        outboxNotes.push(
                            `- ⚠️ 发送被延后（deferral，不是失败）：${describeConversation(begun.record)} 里 ${waiting} 还没落定，` +
                                '同一会话按顺序发送、attempts 没有增加；等它落定（或失败 3 次）后重试。',
                        )
                        continue
                    }
                    if (slot.deferrals > 0) {
                        outboxNotes.push(
                            `- 同会话排队：${describeConversation(begun.record)} 里更早的提问还没落定，等 ${Math.round(slot.waitedMs)}ms 才轮到这里` +
                                '（同一会话按顺序发送；排队不算失败，attempts 不变）',
                        )
                    }

                    // ③ The send goes through the outbox: `sent` / `send-failed` /
                    //    `dropped` are appended together with the attempt, never
                    //    inferred afterwards from an absence.
                    outbox.attach(recordId, deliverAsk, { deadlineAt: startedAt + timeoutMs })
                    const delivered = await outbox.deliver(recordId)
                    outbox.detach(recordId)
                    const sendResult = { messageId: delivered.delivery?.messageId }
                    if (!delivered.ok) {
                        const error = delivered.delivery?.error ?? delivered.problem ?? '发送失败'
                        if (delivered.delivery?.deferred === true) sawDeferral = true
                        else sendFailed = true
                        failures.push(`- ${candidate.name}：${error}`)
                        if (delivered.record?.state === 'send-failed') {
                            outboxNotes.push(
                                `- outbox ${recordId}：已记 send-failed（第 ${delivered.record.attempts} 次失败，退避到 ` +
                                    `${formatTime(delivered.record.nextAttemptAt ?? deps.now())}）；下一次机会只会重投仍然存活的提问，` +
                                    '令牌失效后按 dropped 结案——不会重新问一次，也不会因此放行任何东西。',
                            )
                        } else if (delivered.record?.state === 'dropped') {
                            outboxNotes.push(`- outbox ${recordId}：已记 dropped（${bounded(error, 160)}）——永久失败，不再重投。`)
                        } else if (delivered.record?.state === 'deferred') {
                            outboxNotes.push(
                                `- outbox ${recordId}：已记 deferred（${bounded(error, 160)}）——通道暂时不可用，这不是失败，` +
                                    'attempts 没有增加；等通道可用后重新提问即可。',
                            )
                        }
                        continue
                    }
                    if (delivered.delivery?.ledgerProblem !== undefined) {
                        deps.registry.retire(questionId)
                        refuseAsk({
                            ledgerFile,
                            reason: 'ledger-unwritable',
                            detail: `台账写不进去，这张卡片的提问就没有可审计的记录：${delivered.delivery.ledgerProblem}`,
                            title: titleOut.text,
                            questionId,
                            durationMs: deps.now() - startedAt,
                            channel: candidate.name,
                            ...(sendResult.messageId === undefined ? {} : { messageId: sendResult.messageId }),
                            outbox,
                            settle: { state: 'withdrawn', reason: '台账写不进去：这张卡片不算数，也不再等待决定' },
                            next: `修好台账路径（${ledgerFile}）后重试；卡片已发出但这次不算数，请让通道作废它（messageId ${sendResult.messageId ?? '未知'}）。`,
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }

                    const wait = typeof channel.wait === 'function' ? channel.wait.bind(channel) : undefined
                    const outcome: AwaitResult = await deps.registry.awaitAnswer(questionId, timeoutMs, {
                        ...(wait === undefined ? {} : { wait }),
                        ...(signal === undefined ? {} : { signal }),
                    })
                    const durationMs = deps.now() - startedAt

                    if (outcome.outcome !== 'answered' || outcome.answer === null) {
                        if (outcome.outcome === 'cancelled') {
                            refuseAsk({
                                ledgerFile,
                                reason: 'cancelled',
                                detail: `等待被取消（调用方中止，或通道报告中止），没有拿到任何答案`,
                                title: titleOut.text,
                                questionId,
                                durationMs,
                                channel: candidate.name,
                                ...(sendResult.messageId === undefined ? {} : { messageId: sendResult.messageId }),
                                outbox,
                                settle: { state: 'withdrawn', reason: 'refused:cancelled：等待被取消，这次提问不再等待决定' },
                                next: '在未被取消的轮次重新提问；不要因为"这次没等到"就自己决定。',
                                ...(missionId === undefined ? {} : { missionId }),
                            })
                        }
                        if (outcome.outcome === 'unknown-token') {
                            refuseAsk({
                                ledgerFile,
                                reason: 'token-lost',
                                detail: '一次性令牌在等待期间失效（同一令牌只能被回答一次），答案无处归属',
                                title: titleOut.text,
                                questionId,
                                durationMs,
                                channel: candidate.name,
                                outbox,
                                settle: { state: 'withdrawn', reason: 'refused:token-lost：一次性令牌在等待期间失效，答案无处归属' },
                                next: '重新提问（会生成新令牌）；如果重复出现，说明有通道在替这次提问作答，查通道实现。',
                                ...(missionId === undefined ? {} : { missionId }),
                            })
                        }
                        refuseAsk({
                            ledgerFile,
                            reason: 'timeout',
                            detail:
                                `等待超时：通道 "${candidate.name}" 在 ${timeoutMs}ms 内没有返回任何答案` +
                                `（截止 ${formatTime(startedAt + timeoutMs)}）`,
                            title: titleOut.text,
                            questionId,
                            durationMs,
                            channel: candidate.name,
                            ...(sendResult.messageId === undefined ? {} : { messageId: sendResult.messageId }),
                            extraLines: [`- 超时上限：${timeoutMs}ms（配置 askTimeoutMs=${configuredTimeout}ms；调用方只能缩短，不能延长）`],
                            outbox,
                            settle: { state: 'timeout', reason: 'refused:timeout：期限内没有回答（超时不是同意，也不是拒绝）' },
                            next: `确认人真的收到了卡片（messageId ${sendResult.messageId ?? '未知'}）；要么在 ${timeoutMs}ms 内回答重试，要么把问题拆小/换通道。超时**不是**拒绝，也**不是**同意：不要据此继续。`,
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }

                    const answer = outcome.answer
                    const by = (answer.by ?? '').trim()
                    const answerVerdict = checkOutgoing([{ name: 'answer', text: answer.value }], compiled.rules)
                    if (!answerVerdict.ok) {
                        refuseAsk({
                            ledgerFile,
                            reason: 'secret',
                            detail: '回答内容里检测到疑似凭据：既不落账也不回显（回答者可能误贴了密钥）',
                            title: titleOut.text,
                            questionId,
                            durationMs,
                            channel: candidate.name,
                            ...(by === '' ? {} : { userId: by }),
                            extraLines: ['- 命中规则：', ...describeHits(answerVerdict.hits, compiled.rules)],
                            outbox,
                            settle: { state: 'withdrawn', reason: 'refused:secret：回答疑似含凭据，未落账（无决定）' },
                            next: '请回答者把凭据从答案里去掉后重新回答（重新提问）；不要把疑似密钥写进台账。',
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }
                    const allowed = approveCheck(by, approvers, config.requireApproverList)
                    if (!allowed.ok) {
                        refuseAsk({
                            ledgerFile,
                            reason: 'unauthorized',
                            detail: `回答者未获授权：${allowed.reason}`,
                            title: titleOut.text,
                            questionId,
                            durationMs,
                            channel: candidate.name,
                            ...(by === '' ? {} : { userId: by }),
                            ...(answer.messageId === undefined ? {} : { messageId: answer.messageId }),
                            outbox,
                            settle: { state: 'withdrawn', reason: 'refused:unauthorized：回答者未获授权（无决定）' },
                            next: `让名单里的人回答（由人维护 ${config.approversFile}）；未授权的回答只算"发生了这件事"，不算决定。`,
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }
                    const mapped = mapOption(answer.value, declared)
                    if (mapped === undefined) {
                        const bounded = truncate(answer.value, 200)
                        refuseAsk({
                            ledgerFile,
                            reason: 'unknown-answer',
                            detail:
                                declared.length === 0
                                    ? '答案是空的：没有内容可以当作决定'
                                    : `答案 ${JSON.stringify(bounded.text)} 不是声明选项之一（${declared.join(' / ')}）`,
                            title: titleOut.text,
                            questionId,
                            durationMs,
                            channel: candidate.name,
                            ...(by === '' ? {} : { userId: by }),
                            ...(answer.messageId === undefined ? {} : { messageId: answer.messageId }),
                            outbox,
                            settle: { state: 'withdrawn', reason: 'refused:unknown-answer：答非所问，没有可用的决定' },
                            next: '按声明选项重新问一次（或把选项改成人真正会选的那几个）；答非所问不是"默认通过"。',
                            ...(missionId === undefined ? {} : { missionId }),
                        })
                    }
                    const normalized = normalizeDecision(mapped, by, answer.messageId ?? sendResult.messageId, candidate.name)
                    const carrier = answer.messageId ?? sendResult.messageId
                    // A free-text answer is stored verbatim as the decision, so it
                    // is bounded HERE: an unbounded answer would grow the ledger
                    // (and every report that renders it) without limit. The bound
                    // is the same host-owned `maxPayloadChars` an outgoing payload
                    // gets, and the truncation is stated, never silent.
                    const withinSuiteVocabulary = SUITE_DECISIONS.includes(normalized.decision)
                    const boundedDecision = truncate(normalized.decision, config.maxPayloadChars)
                    const storedDecision = withinSuiteVocabulary ? normalized.decision : boundedDecision.text
                    const decisionTruncated = !withinSuiteVocabulary && boundedDecision.truncated
                    const row: LedgerRow = {
                        at: deps.now(),
                        id: newRowId(),
                        kind: 'ask',
                        title: titleOut.text,
                        questionId,
                        channel: candidate.name,
                        decision: storedDecision,
                        durationMs,
                        ...(normalized.userId === '' ? {} : { userId: normalized.userId }),
                        ...(carrier === undefined ? {} : { messageId: carrier }),
                        ...(missionId === undefined ? {} : { missionId }),
                    }
                    const decided = write(ledgerFile, row)
                    if (!decided.ok) {
                        outbox.settle(recordId, 'withdrawn', '台账写入失败：回答没有被记录，这次提问没有可审计的决定')
                        throw new Error(
                            [
                                `interaction_ask 拒绝（${refusalOf('ledger-unwritable')}）：答案收到了（${JSON.stringify(truncate(answer.value, 200).text)}，回答者 ${by === '' ? '未提供身份' : by}，通道 ${candidate.name}），但台账写不进去，这次决定拿不到可审计的行 id：${decided.problem ?? '未知原因'}`,
                                `- 一次性令牌：${questionId}`,
                                `- 台账：${ledgerFile}`,
                                '下一步：修好台账路径后重新提问（人还得再答一次）；这次回答没有被当作决定，也没有被写进任何地方。',
                            ].join('\n'),
                        )
                    }

                    // The ledger decided; the outbox only RECORDS that it did. A
                    // terminal outbox row is never read as a decision anywhere.
                    outbox.settle(recordId, 'answered', `决定 ${bounded(storedDecision, 80)}（回答者 ${by === '' ? '通道未提供身份' : by}，通道 ${candidate.name}）`)
                    outbox.settleQuestion(questionId, 'withdrawn', `同一提问已由 ${candidate.name} 投递并落定：这条候选记录不再重放`)

                    const notes: string[] = []
                    if (contextInput.problems.length > 0) notes.push(...contextInput.problems.map((problem) => `- ⚠️ ${problem}`))
                    if (body.truncated) notes.push(`- ⚠️ 正文超过 maxPayloadChars=${config.maxPayloadChars}，已截断后发送`)
                    if (titleOut.truncated) notes.push('- ⚠️ 标题过长，已截断后发送')
                    if (decisionTruncated) {
                        notes.push(
                            `- ⚠️ 回答超过 maxPayloadChars=${config.maxPayloadChars} 字符，落账与回显都已截断（原文 ${answer.value.length} 字符）：` +
                                '台账是事实记录，不是聊天记录——需要完整内容就让人把长文本写进文件，卡片里只放链接。',
                        )
                    }
                    if (compiled.problems.length > 0) notes.push(...compiled.problems.map((problem) => `- ⚠️ ${problem}`))
                    if (outboxNotes.length > 0) notes.push(...outboxNotes)
                    if (failures.length > 0) notes.push('- 先尝试失败的通道：', ...failures)
                    if (missionId !== undefined) notes.push(`- mission：${missionId}`)
                    return [
                        'interaction_ask：已决定',
                        `- 问题：${headline(prose, 120)}`,
                        `- 决定：${storedDecision}${declared.length === 0 ? '（自由文本回答）' : '（声明选项之一）'}`,
                        `- 回答者：${by === '' ? '（通道未提供身份）' : by}${config.requireApproverList ? `（项目审批人名单：${approvers.ids.length} 个 id）` : '（未启用审批人名单：通道内的任何参与者都可回答）'}`,
                        `- 通道：${candidate.name}${(answer.messageId ?? sendResult.messageId) === undefined ? '' : `（消息 ${answer.messageId ?? sendResult.messageId}）`}`,
                        `- 一次性令牌：${questionId}（一次性，已作废）`,
                        `- 台账：${ledgerFile}（行 ${row.id}）`,
                        `- outbox：${recordId}（answered；${describeConversation({ channel: candidate.name, ...(chatId === undefined ? {} : { chatId }) })} 上的下一次提问不会再为它排队）`,
                        `- 耗时：${durationMs}ms（等待上限 ${timeoutMs}ms）`,
                        ...(SUITE_DECISIONS.includes(normalized.decision)
                            ? [
                                  normalized.allowed
                                      ? '- 门禁语义：`allowed-once` 只放行**这一次**——不是长期豁免，也不代表内容被验证过。'
                                      : `- 门禁语义：\`${normalized.decision}\` 没有放行（rejected=人拒绝；cancelled/unavailable=没有人作出决定）。`,
                              ]
                            : []),
                        ...notes,
                        '下一步：把这个决定用在你问的那一件事上（它只对那件事、那一次有效）；要长期豁免或放宽配置，由人改 `.dsh/**`（模型写不了）。',
                    ].join('\n')
                }

                // Every candidate refused to even deliver the card.
                deps.registry.retire(questionId)
                if (sawDeferral && !sendFailed) {
                    // Nothing failed — the question was DEFERRED (a busy chat, a
                    // channel that is temporarily unavailable). Say exactly that,
                    // and point at the fix that actually works.
                    refuseAsk({
                        ledgerFile,
                        reason: 'deferred',
                        detail: '所有候选通道都没有失败，但没有接单：同一会话里更早的提问还没落定，或通道暂时不可用（deferral，不是失败）',
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        extraLines: ['- 各通道的情况：', ...failures, ...outboxNotes],
                        outbox,
                        next: '先让同一会话里更早的提问落定（或让它失败 3 次，它就不再挡住后面的提问），或把通道恢复可用（连接/active chat），再重新提问；也可以换一个没人排队的会话（prefer 或项目级 preferredChannels）。排队等待不是失败，也不是同意。',
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }
                if (failures.length === 0) {
                    refuseAsk({
                        ledgerFile,
                        reason: 'no-channel',
                        detail: '没有可用的提问通道（候选通道都没能发出卡片，且没有记录到失败原因）',
                        title: titleOut.text,
                        questionId,
                        durationMs: deps.now() - startedAt,
                        next: '让宿主/IM 插件注册一个实现 wait() 的通道后重试。',
                        ...(missionId === undefined ? {} : { missionId }),
                    })
                }
                refuseAsk({
                    ledgerFile,
                    reason: 'send-failed',
                    detail: `所有候选通道都发不出这张卡片（${failures.length} 个）`,
                    title: titleOut.text,
                    questionId,
                    durationMs: deps.now() - startedAt,
                    extraLines: ['- 各通道的失败原因：', ...failures, ...outboxNotes],
                    outbox,
                    next: '修好通道（webhook/网络/凭据）后重试；卡片没发出去 = 没有人被问过，不要自己决定（outbox 里留下的是"没有投递成功"，不是答案）。',
                    ...(missionId === undefined ? {} : { missionId }),
                })
            },
        }),
        'interaction_ask',
    )

    register(
        defineTool({
            name: 'interaction_notify',
            description:
                'Push a state-change notification (a gate turned BLOCK, a stage finished, the environment changed) to the workspace\'s channels. Never waits for a human, never blocks the turn, and a failed push is REPORTED and counted — it never turns into a decision either way. Levels are filtered by the host\'s notifyLevels, so an `info` push may be deliberately suppressed (the report says so instead of going silent). The payload is refused when it looks like it carries a credential.',
            parameters: {
                level: { type: 'string', enum: ['info', 'warn', 'error'], required: true, description: 'Severity; filtered by the host notifyLevels list.' },
                title: { type: 'string', required: true, description: 'One-line headline.' },
                body: { type: 'string', required: true, description: 'What changed and what it means; may embed an approval-context block.' },
                missionId: { type: 'string', description: 'Mission the notification belongs to (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: NotifyArgs = {} as NotifyArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                if (!config.enabled) throw new Error('dsh-interaction-gate 已被宿主禁用（enabled=false）')
                const level = (args.level ?? 'info') as NotifyLevel
                if (!NOTIFY_LEVELS.includes(level)) {
                    throw new Error(
                        `interaction_notify 拒绝（refused:bad-request）：level 只能是 ${NOTIFY_LEVELS.join(' / ')}（收到 ${JSON.stringify(args.level)}）。` +
                            '下一步：改成受支持的等级（progress 用 interaction_progress）。',
                    )
                }
                const title = (args.title ?? '').trim()
                if (title === '') {
                    throw new Error('interaction_notify 拒绝（refused:bad-request）：title 不能为空。下一步：写一句人看得懂的标题。')
                }
                const body = args.body ?? ''
                const ledgerFile = artifactPathOf(cwd, config.ledgerFile)
                deps.registry.trackLedger(ledgerFile)
                const missionId = missionIdOf(deps, cwd, agent, args.missionId)
                const boundedTitle = truncate(title, 200)
                const boundedBody = truncate(body, config.maxPayloadChars)
                const base = { title: boundedTitle.text, ...(missionId === undefined ? {} : { missionId }) }

                if (!config.notifyLevels.includes(level)) {
                    const row: LedgerRow = { at: deps.now(), id: newRowId(), kind: 'notify', decision: FILTERED, ...base }
                    const appended = write(ledgerFile, row)
                    return [
                        `interaction_notify：未推送（按配置过滤）`,
                        `- 等级：${level}；配置 notifyLevels=[${config.notifyLevels.join(', ')}]`,
                        `- 内容：${boundedTitle.text}`,
                        appended.ok ? `- 台账：${ledgerFile}（行 ${row.id}，决定 ${FILTERED}）` : `- ⚠️ 台账写入失败：${appended.problem ?? ''}`,
                        '说明：这是**明确的过滤**，不是静默失败——要收到这个等级就让宿主把 notifyLevels 加上它（项目级可覆盖）。',
                        '下一步：需要人看到这条就直接说清楚它属于哪个等级；门禁结论用 gate 记录表达，不要靠通知表达。',
                    ].join('\n')
                }

                const compiled = compileRedactPatterns(config.redactPatterns)
                const verdict = checkOutgoing(
                    [
                        { name: 'title', text: boundedTitle.text },
                        { name: 'body', text: boundedBody.text },
                    ],
                    compiled.rules,
                )
                if (!verdict.ok) {
                    const row: LedgerRow = {
                        at: deps.now(),
                        id: newRowId(),
                        kind: 'notify',
                        decision: refusalOf('secret'),
                        ...base,
                    }
                    const appended = write(ledgerFile, row)
                    return [
                        'interaction_notify：拒绝发送（载荷疑似含凭据）',
                        ...describeHits(verdict.hits, compiled.rules),
                        appended.ok ? `- 台账：${ledgerFile}（行 ${row.id}，决定 ${refusalOf('secret')}）` : `- ⚠️ 台账写入失败：${appended.problem ?? ''}`,
                        '下一步：把凭据替换成位置描述（"仓库根的 .env"）后重发；不要把疑似密钥推送进聊天。',
                    ].join('\n')
                }

                const list = deps.registry.list()
                const targets = notifyTargets(config, list)
                const missing = missingPreferred(config, list)
                if (targets.length === 0) {
                    const row: LedgerRow = { at: deps.now(), id: newRowId(), kind: 'notify', decision: NOTIFY_FAILED, ...base }
                    const appended = write(ledgerFile, row)
                    return [
                        'interaction_notify：推送失败（没有可用通道）',
                        `- 等级：${level}；内容：${boundedTitle.text}`,
                        `- 已注册通道：${list.length === 0 ? '（无）' : list.map((info) => `${info.name}（canNotify=${info.canNotify}${info.reason === '' ? '' : `：${info.reason}`}）`).join('，')}`,
                        ...(config.preferredChannels.length === 0
                            ? ['- 配置 preferredChannels=[]（= 全部已注册通道）']
                            : [`- 配置 preferredChannels=[${config.preferredChannels.join(', ')}]${missing.length === 0 ? '' : `，其中未注册：${missing.join(', ')}`}`]),
                        appended.ok ? `- 台账：${ledgerFile}（行 ${row.id}，决定 ${NOTIFY_FAILED}）` : `- ⚠️ 台账写入失败：${appended.problem ?? ''}`,
                        '说明：通知失败**不等于**默认通过、也不等于失败——它只说明这条消息没人收到；门禁结论不读通知。',
                        '下一步：让宿主/IM 插件注册一个通道，或把 preferredChannels 改成真实存在的通道名后重发。',
                    ].join('\n')
                }

                const lines: string[] = []
                let okCount = 0
                for (const target of targets) {
                    const send = await deps.registry.send(target.name, { kind: 'notify', title: boundedTitle.text, body: boundedBody.text })
                    const row: LedgerRow = {
                        at: deps.now(),
                        id: newRowId(),
                        kind: 'notify',
                        channel: target.name,
                        decision: send.ok ? NOTIFIED : NOTIFY_FAILED,
                        ...base,
                        ...(send.messageId === undefined ? {} : { messageId: send.messageId }),
                    }
                    const appended = write(ledgerFile, row)
                    if (send.ok) {
                        okCount += 1
                        lines.push(`- ${target.name}：已推送（消息 ${send.messageId ?? '未知'}，台账行 ${row.id}${appended.ok ? '' : '，⚠️ 台账写入失败'}）`)
                    } else {
                        lines.push(`- ${target.name}：推送失败（${send.error ?? '未知原因'}，台账行 ${row.id}${appended.ok ? '' : '，⚠️ 台账写入失败'}）`)
                    }
                    if (!appended.ok) lines.push(`  ⚠️ ${appended.problem ?? '台账写入失败'}`)
                }
                return [
                    `interaction_notify：已推送 ${okCount}/${targets.length} 个通道`,
                    `- 等级：${level}；配置 notifyLevels=[${config.notifyLevels.join(', ')}]`,
                    `- 标题：${boundedTitle.text}`,
                    ...lines,
                    ...(missing.length === 0 ? [] : [`- ⚠️ 配置里偏好但未注册的通道：${missing.join(', ')}`]),
                    ...(boundedBody.truncated ? [`- ⚠️ 正文超过 maxPayloadChars=${config.maxPayloadChars}，已截断后发送`] : []),
                    ...(missionId === undefined ? [] : [`- mission：${missionId}`]),
                    '说明：通知不是决定——台账里的这一行不授予任何权限，门禁也不读它。',
                    '下一步：状态变化本身要在门禁/回执里说明白（通知只是让人知道）；推送失败的通道要修，别用"没通知到"当作结论。',
                ].join('\n')
            },
        }),
        'interaction_notify',
    )

    register(
        defineTool({
            name: 'interaction_progress',
            description:
                'Report that a long stage is still running, through the same channel pipeline at level `progress`. This is NOT a log: an identical consecutive payload inside a small window (5s) is suppressed, so a tight loop cannot spam a chat. Never waits for a human; a failed push is reported and counted.',
            parameters: {
                stage: { type: 'string', required: true, description: 'The stage that is running (e.g. "tests", "docker build").' },
                elapsedMs: { type: 'integer', description: 'How long the stage has been running, in ms.' },
                note: { type: 'string', description: 'Short, human-meaningful note (not a log line).' },
                missionId: { type: 'string', description: 'Mission the stage belongs to (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ProgressArgs = {} as ProgressArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                if (!config.enabled) throw new Error('dsh-interaction-gate 已被宿主禁用（enabled=false）')
                const stage = (args.stage ?? '').trim()
                if (stage === '') {
                    throw new Error('interaction_progress 拒绝（refused:bad-request）：stage 不能为空。下一步：写清楚哪个阶段在跑。')
                }
                const elapsedMs = args.elapsedMs
                if (elapsedMs !== undefined && (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0)) {
                    throw new Error(
                        `interaction_progress 拒绝（refused:bad-request）：elapsedMs 必须是 ≥0 的数（收到 ${JSON.stringify(elapsedMs)}）。下一步：省略它，或给一个非负毫秒数。`,
                    )
                }
                const ledgerFile = artifactPathOf(cwd, config.ledgerFile)
                deps.registry.trackLedger(ledgerFile)
                const missionId = missionIdOf(deps, cwd, agent, args.missionId)
                const title = `阶段进度：${headline(stage, 64)}`
                const note = (args.note ?? '').trim()
                const bodyLines = [
                    ...(elapsedMs === undefined ? [] : [`- 已用时：${Math.floor(elapsedMs)}ms`]),
                    ...(note === '' ? [] : [`- 备注：${note}`]),
                    ...(missionId === undefined ? [] : [`- mission：${missionId}`]),
                ]
                const body = truncate(bodyLines.length === 0 ? '（仍在进行）' : bodyLines.join('\n'), config.maxPayloadChars)
                // The dedupe key deliberately EXCLUDES elapsedMs: it changes on
                // every call by construction, so including it would disable the
                // window entirely. stage + note + mission is the payload's identity.
                const key = `progress|${missionId ?? ''}|${title}|${note}`
                const decidedAt = deps.now()
                const suppression = progressGate.check(key, decidedAt)
                if (suppression.suppressed) {
                    return [
                        'interaction_progress：已抑制（与上一次完全相同的内容）',
                        `- 阶段：${headline(stage, 64)}`,
                        `- 去重窗口：${PROGRESS_DEDUPE_WINDOW_MS}ms（上次推送 ${formatTime(suppression.lastAt ?? decidedAt)}）`,
                        '- 说明：进度是"状态变化"而不是日志；重复内容不会再次推送，也不会写台账。',
                        '下一步：内容真的变了再报（换了阶段/换了备注），或者用 interaction_notify 说明状态变化。',
                    ].join('\n')
                }

                const compiled = compileRedactPatterns(config.redactPatterns)
                const verdict = checkOutgoing(
                    [
                        { name: 'title', text: title },
                        { name: 'body', text: body.text },
                    ],
                    compiled.rules,
                )
                if (!verdict.ok) {
                    const row: LedgerRow = {
                        at: decidedAt,
                        id: newRowId(),
                        kind: 'progress',
                        decision: refusalOf('secret'),
                        title,
                        ...(missionId === undefined ? {} : { missionId }),
                    }
                    const appended = write(ledgerFile, row)
                    return [
                        'interaction_progress：拒绝发送（载荷疑似含凭据）',
                        ...describeHits(verdict.hits, compiled.rules),
                        appended.ok ? `- 台账：${ledgerFile}（行 ${row.id}，决定 ${refusalOf('secret')}）` : `- ⚠️ 台账写入失败：${appended.problem ?? ''}`,
                        '下一步：进度文本里不要带凭据/URL 里的密钥参数。',
                    ].join('\n')
                }

                const list = deps.registry.list()
                const targets = notifyTargets(config, list)
                if (targets.length === 0) {
                    const row: LedgerRow = {
                        at: decidedAt,
                        id: newRowId(),
                        kind: 'progress',
                        decision: refusalOf('no-channel'),
                        title,
                        ...(missionId === undefined ? {} : { missionId }),
                    }
                    const appended = write(ledgerFile, row)
                    return [
                        'interaction_progress：未推送（没有可用通道）',
                        `- 阶段：${headline(stage, 64)}`,
                        `- 已注册通道：${list.length === 0 ? '（无）' : list.map((info) => `${info.name}（canNotify=${info.canNotify}）`).join('，')}`,
                        appended.ok ? `- 台账：${ledgerFile}（行 ${row.id}，决定 ${refusalOf('no-channel')}）` : `- ⚠️ 台账写入失败：${appended.problem ?? ''}`,
                        '下一步：让宿主/IM 插件注册一个通道；进度没推送出去不影响门禁结论，别把它当成失败或成功信号。',
                    ].join('\n')
                }

                const lines: string[] = []
                let okCount = 0
                for (const target of targets) {
                    const send = await deps.registry.send(target.name, { kind: 'progress', title, body: body.text })
                    const row: LedgerRow = {
                        at: deps.now(),
                        id: newRowId(),
                        kind: 'progress',
                        channel: target.name,
                        decision: send.ok ? PROGRESS : refusalOf('send-failed'),
                        title,
                        ...(missionId === undefined ? {} : { missionId }),
                        ...(send.messageId === undefined ? {} : { messageId: send.messageId }),
                    }
                    const appended = write(ledgerFile, row)
                    if (send.ok) {
                        okCount += 1
                        lines.push(`- ${target.name}：已推送（消息 ${send.messageId ?? '未知'}，台账行 ${row.id}）`)
                    } else {
                        lines.push(`- ${target.name}：推送失败（${send.error ?? '未知原因'}，台账行 ${row.id}）`)
                    }
                    if (!appended.ok) lines.push(`  ⚠️ ${appended.problem ?? '台账写入失败'}`)
                }
                if (okCount > 0) progressGate.mark(key, deps.now())
                return [
                    `interaction_progress：已推送 ${okCount}/${targets.length} 个通道`,
                    `- 阶段：${headline(stage, 64)}${elapsedMs === undefined ? '' : `（已用时 ${Math.floor(elapsedMs)}ms）`}`,
                    ...lines,
                    '- 说明：进度不是日志，也不是决定；同样的内容在窗口内只会推送一次。',
                    '下一步：阶段结束时用 interaction_notify 报状态变化（成功/失败），别只发进度。',
                ].join('\n')
            },
        }),
        'interaction_progress',
    )

    register(
        defineTool({
            name: 'interaction_status',
            description:
                'Read-only doctor for the interaction layer: registered channels with their capability report (canAsk / canNotify and WHY not), the effective configuration and its provenance, the project approver-list state, ledger counts by decision, the asks that are still PENDING (rows with no decision, with their age), and the ask OUTBOX — how many questions are queued behind another of the same conversation, how old the oldest unsettled one is, which records failed three times (a system problem) and which were dropped with their reason. Writes nothing: an outbox row is never a decision.',
            parameters: {
                missionId: { type: 'string', description: 'Only count rows of one mission (default: the whole ledger).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                const only = args.missionId !== undefined && args.missionId !== '' ? assertSafeId(args.missionId, 'mission id') : undefined
                const ledgerFile = artifactPathOf(cwd, config.ledgerFile)
                deps.registry.trackLedger(ledgerFile)
                // The outbox is read, never replayed, from here: a doctor that
                // writes (or retries) is no longer a doctor. `sync()` only feeds
                // the derived defects into the bounded problem list, once each.
                const outbox = deps.outboxFor(cwd, config)
                outbox.sync()
                const outboxRead = readOutbox(outbox.file)
                const outboxSummary = summarizeOutbox(outboxRecords(outboxRead.rows), deps.now(), outbox.file, outboxRead)
                const read = readLedger(ledgerFile)
                const selected = only === undefined ? read.rows : read.rows.filter((row) => row.missionId === only)
                const summary = summarizeLedger(selected, deps.now(), read.skipped)
                const list = deps.registry.list()
                const missing = missingPreferred(config, list)
                const approvers = approversOf(cwd, config)
                const lines: string[] = []

                lines.push(`配置来源：${describeSource(effective)}${effective.problems.length === 0 ? '' : `（${effective.problems.length} 条配置问题，见插件日志）`}`)
                lines.push(`- 插件：dsh-interaction-gate（enabled=${config.enabled}）`)
                lines.push(`- 提问超时上限：${config.askTimeoutMs}ms（调用方只能缩短）`)
                lines.push(`- 通知级别：${config.notifyLevels.join(', ')}；通道偏好：${config.preferredChannels.length === 0 ? '[]（= 全部已注册通道）' : `[${config.preferredChannels.join(', ')}]`}`)
                lines.push(`- 载荷上限：${config.maxPayloadChars} 字符（默认 ${DEFAULT_MAX_PAYLOAD_CHARS}）；额外拒绝规则：${config.redactPatterns.length} 条`)
                lines.push(`- 审批人名单：${config.requireApproverList ? '**必须**' : '不强制'}；文件 ${approvers.file}（存在=${approvers.present}，有效 id=${approvers.ids.length}）`)
                for (const problem of approvers.problems) lines.push(`  ⚠️ ${problem}`)
                lines.push(
                    `- 台账：${ledgerFile}（存在=${read.present}，行数 ${read.lines}，可用行 ${read.rows.length}，跳过 ${read.skipped}）` +
                        (read.skipped === 0 ? '' : '——跳过的通常是崩溃时截断的尾行，不算台账损坏'),
                )
                for (const problem of read.problems) lines.push(`  ⚠️ ${problem}`)

                lines.push(`- IM 通道：${describeIm(deps.registry.im())}`)

                lines.push('', `通道（注册顺序，共 ${list.length} 个）：`)
                if (list.length === 0) lines.push('  （无：`interaction_ask` 会拒绝，`interaction_notify` 会报告推送失败）')
                for (const info of list) {
                    lines.push(`- ${info.name}：canAsk=${info.canAsk}，canNotify=${info.canNotify}${info.reason === '' ? '' : `（${info.reason}）`}`)
                }
                if (missing.length > 0) lines.push(`⚠️ 配置偏好但未注册的通道：${missing.join(', ')}`)
                const defects = deps.registry.problems()
                if (defects.length > 0) {
                    lines.push('通道缺陷（最近）：')
                    for (const defect of defects) lines.push(`- ${defect}`)
                }
                lines.push(`丢弃的答案（令牌未知/已作废/对不上）：${deps.registry.droppedAnswers()}`)
                lines.push(
                    `服务视角（ctx.get('interaction')）：已登记的台账 ${deps.registry.ledgers().length} 个，` +
                        `pending() ${deps.registry.pending().length} 个（与下面台账统计同一份事实）`,
                )

                lines.push('', `台账统计（${only === undefined ? '全部记录' : `mission ${only}`}，可用行 ${summary.total}）：`)
                lines.push(`- 分行数：提问 ${summary.byKind.ask}，通知 ${summary.byKind.notify}，进度 ${summary.byKind.progress}`)
                lines.push(`- 已决定的提问：${summary.answered}；被拒绝的交互：${summary.refused}；没有决定的行程：${summary.undecided}`)
                lines.push(`- 按决定计数：${countLines(summary.byDecision, '（无）', config.maxPayloadChars)}`)
                lines.push(`- 拒绝原因：${countLines(summary.refusedReasons, '（无）', config.maxPayloadChars)}`)
                lines.push(`- 通知失败行：${summary.notifyFailed}`)

                // The outbox: the durability layer around the send. Counts per
                // state, what is waiting (`behind`), how old the oldest unsettled
                // row is, and every dropped record WITH its reason — a dropped
                // question must never read as a sent one.
                lines.push('', `提问 outbox（意图先落盘、再发卡片）：${outbox.file}（存在=${outboxRead.present}，行数 ${outboxRead.lines}，可用记录 ${outboxSummary.total}，跳过 ${outboxSummary.skipped}）`)
                for (const problem of outboxSummary.problems) lines.push(`  ⚠️ ${problem}`)
                lines.push(`- 按状态：${OUTBOX_STATES.map((state) => `${state}=${outboxSummary.byState[state]}`).join('，')}`)
                lines.push(`- 排队中（behind：同一会话里更早的提问还没落定）：${outboxSummary.behind} 个`)
                if (outboxSummary.oldestUnsettled === undefined) {
                    lines.push('- 未落定的提问：0 个（没有在途提问）')
                } else {
                    lines.push(
                        `- 最老未落定：${Math.round((outboxSummary.oldestUnsettledAgeMs ?? 0) / 1000)}s（${outboxSummary.oldestUnsettled.id}，` +
                            `${describeConversation(outboxSummary.oldestUnsettled)}，state=${outboxSummary.oldestUnsettled.state}）`,
                    )
                }
                if (outboxSummary.dropped.length > 0) {
                    lines.push(`- 已丢弃（dropped，永久失败，不会再重试，也**不是**已发出的提问）：${outboxSummary.dropped.length} 个`)
                    for (const record of outboxSummary.dropped.slice(-3)) {
                        lines.push(`  ${record.id}（${describeConversation(record)}）：${bounded(record.settleReason ?? '未说明原因', 120)}`)
                    }
                }
                if (outboxSummary.tripped.length > 0) {
                    lines.push(`- ⚠️ 连续失败≥${ORDER_FAILURE_LIMIT} 次（系统问题，见上方通道缺陷）：${outboxSummary.tripped.length} 个`)
                    for (const record of outboxSummary.tripped.slice(-3)) {
                        lines.push(
                            `  ${record.id}（${describeConversation(record)}）：失败 ${record.attempts} 次，` +
                                `${bounded(record.settleReason ?? '未说明原因', 120)}——它不再阻塞该会话的后续提问`,
                        )
                    }
                }

                lines.push('', `未决定的提问（按年龄，共 ${summary.pending.length} 个）：`)
                if (summary.pending.length === 0) lines.push('  （无）')
                for (const pending of summary.pending) {
                    lines.push(
                        `- ${pending.questionId}：年龄 ${Math.round(pending.ageMs / 1000)}s（${formatTime(pending.at)}，通道 ${pending.channel ?? '无'}` +
                            `${pending.missionId === undefined ? '' : `，mission ${pending.missionId}`}，${headline(pending.title, 48)}）`,
                    )
                }
                if (summary.last !== undefined) {
                    lines.push('', `最近记录（最多 ${STATUS_RECENT_ROWS} 行，最新在前）：`)
                    for (const row of [...selected].reverse().slice(0, STATUS_RECENT_ROWS)) lines.push(describeRow(row, config.maxPayloadChars))
                }
                lines.push(
                    '',
                    '说明：台账记录发生过什么，**不授予任何权限**；`allowed-once` 这种决定只对当时问的那一件事有效。',
                    '说明：outbox 里 intent/sent/deferred/send-failed/dropped 都表示"还没有人的决定"——它们不是答案，门禁照旧拒绝。',
                    '下一步：没有可用通道就先注册通道；有未决定的提问就等人回答或重新提问（超时/越权都不是同意）；outbox 里 dropped/连续失败的记录要修通道或重新提问；审批人名单由人维护。',
                )
                return lines.join('\n')
            },
        }),
        'interaction_status',
    )

    return { disposers, registered, failed }
}

/** Re-exported for the module's consumers (the registry type lives in `channels.ts`). */
export type { InteractionChannel, InteractionRegistry }

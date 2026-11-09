/**
 * Plugin configuration: the profile ceiling and the keys a repository may refine.
 *
 * Two layers, the rule every plugin in this suite follows:
 *
 *  - the **profile row** decides whether the interaction layer exists at all,
 *    where its log lives, how long a turn may wait for a human, whether an
 *    approver list is mandatory, and how much text may leave the process;
 *  - `<repo>/.dsh/interaction-gate.json` may refine only where decisions are
 *    recorded, which channel this repository's cards go to, which notification
 *    levels are pushed, and which extra patterns are refused outright.
 *
 * Why the rest is host-owned:
 *
 *  - `askTimeoutMs` bounds how long a model turn may hang on a person. A
 *    repository that could raise it is extending its own leash, so it is a
 *    ceiling the tool may only SHORTEN (`interaction_ask({ timeoutMs })` is
 *    clamped to it, never above it).
 *  - `requireApproverList` is the difference between "anyone on the channel may
 *    answer" and "only the named people may answer". A repository that could
 *    clear it would be exempting itself from its own approver list (the same
 *    argument coverage-gate makes for `flakyPolicy`).
 *  - `enabled`, `logFile`, the layout and `prompt` are host concerns everywhere
 *    in the suite.
 *
 * Numbers and lists are validated, never guessed: an unusable value keeps the
 * profile's value (or the default for the profile row itself) and reports why.
 * A silently-defaulted ceiling is a silently-widened seam.
 *
 * @module dsh-interaction-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions } from 'dsh-eng-core'
import { DEFAULT_ATTENTION_FILE, DEFAULT_ATTENTION_MAX_AGE_MS } from './attention.js'
import type { ImChannelMode } from './channels.js'
import { DEFAULT_OUTBOX_FILE } from './outbox.js'

/** Levels a notification may carry. `progress` is its own tool, not a level. */
export type NotifyLevel = 'info' | 'warn' | 'error'

/** Every level, weakest first. */
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['info', 'warn', 'error']

/** Default ask deadline (15 minutes): long enough for a phone, short enough to fail. */
export const DEFAULT_ASK_TIMEOUT_MS = 900_000

/** Shortest ask deadline a profile may set (a sub-second ask cannot reach a person). */
export const MIN_ASK_TIMEOUT_MS = 1_000

/** Longest ask deadline a profile may set (24h: a turn must eventually fail closed). */
export const MAX_ASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000

/** Shortest staleness bound a profile may set (a question can always wait an hour). */
export const MIN_ATTENTION_MAX_AGE_MS = 60 * 60 * 1_000

/** Longest staleness bound a profile may set (30 days). */
export const MAX_ATTENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

/** Default cap on one outgoing payload, in characters. */
export const DEFAULT_MAX_PAYLOAD_CHARS = 4_000

/** Bounds for {@link InteractionGateConfig.maxPayloadChars}. */
export const MIN_MAX_PAYLOAD_CHARS = 200
export const MAX_MAX_PAYLOAD_CHARS = 200_000

/** Most extra redaction patterns a profile/project may declare. */
export const MAX_REDACT_PATTERNS = 64

/** Every accepted value of `im.channel` (the IM routing mode). */
export const IM_CHANNEL_MODES: readonly ImChannelMode[] = ['auto', 'off', 'required']

/**
 * How long `im.channel=required` waits for the `chatInteraction` service to
 * appear before refusing (default 5 s).
 *
 * The window exists because bundle order does not decide apply order: the IM
 * plugin may be applied AFTER this one and provides its service at the end of
 * its own `apply`. Refusing at our `apply` would therefore reject a correctly
 * configured deployment. The bound keeps "required" honest: after it, a
 * missing service is a fact, not a hope.
 */
export const DEFAULT_IM_REQUIRED_WAIT_MS = 5_000

/** `required` may refuse immediately (`0`): useful for deterministic tests/CI. */
export const MIN_IM_REQUIRED_WAIT_MS = 0

/** Upper bound for the `required` window (a minute: a turn must eventually fail closed). */
export const MAX_IM_REQUIRED_WAIT_MS = 60_000

/**
 * Default for `im.p2pOnly`: an approval must come from a PRIVATE chat.
 *
 * A group is a room the approver does not control: anyone in it can press the
 * button, and "who answered" would then be a fact about the room rather than
 * about the approver. The default is therefore the strict one, and the
 * strictness only ever applies to a deployment that named an approval target
 * (see the go-live guard in `tools.ts`): without a target there is nothing to
 * prove a chat against, and today's behaviour is kept byte for byte.
 */
export const DEFAULT_IM_P2P_ONLY = true

/** Longest `im.approvalChatId` a profile may declare (a platform chat id is short). */
export const MAX_APPROVAL_CHAT_ID_LENGTH = 512

/**
 * Whether the plugin answers the HOST's approval seam
 * (`'approval/request'`) itself, i.e. whether a tool that asks for permission
 * can be approved from a phone.
 *
 *  - `off` (default): nothing is registered — not a listener, not a channel
 *    lookup. The host keeps answering with whatever answerer it already has, so
 *    the behaviour is byte for byte what it is today.
 *  - `fallback`: registered in FRONT of the chain (`{ prepend: true }`); when a
 *    question cannot even be asked over IM (no usable channel, no approval
 *    target, no approver list, no workspace) the listener calls `next()` so the
 *    existing answerer (the TUI) still gets it. It never sends a card and then
 *    falls back — that would ask the same person twice.
 *  - `only`: same registration, but "cannot ask" resolves `'unavailable'`
 *    WITHOUT calling `next()`. The choice is deliberate: a deployment that says
 *    "only IM" must not silently be answered in a terminal that the person who
 *    wrote the policy is not looking at.
 *
 * An unusable value is reported and treated as `off` (never coerced upward):
 * `fallback`/`only` change who can grant a permission, so a typo must not be the
 * thing that turns the seam on.
 */
export type ApprovalVia = 'off' | 'fallback' | 'only'

/** Every accepted value of `im.approvalVia`, most conservative first. */
export const APPROVAL_VIA_MODES: readonly ApprovalVia[] = ['off', 'fallback', 'only']

/** Default for `im.approvalVia`: the approval seam is untouched. */
export const DEFAULT_APPROVAL_VIA: ApprovalVia = 'off'

/** The host-owned `im` block. */
export interface ImConfig {
    /**
     * `auto` (default): use the IM channel whenever the `chatInteraction`
     * service exposes `api.apiVersion >= 1` — at `apply` or whenever it
     * appears later — and keep today's local-only behaviour otherwise.
     * `off`: never touch the service at all (byte-for-byte today's behaviour).
     * `required`: the service must end up present; a bounded wait covers the
     * "not yet applied" ordering, and after it the plugin refuses loudly
     * (`problems()` + `interaction_ask`) instead of running silently without it.
     */
    channel: ImChannelMode
    /**
     * The IM plugin's channel name (`feishu`/`wecom`/…) to pin. Omitted = the
     * IM plugin resolves its own active chat across channels.
     */
    channelId?: string
    /**
     * How long `im.channel=required` waits for the service (ms). `0` refuses
     * immediately. Host-owned: a repository cannot widen or shorten it.
     */
    requiredWaitMs: number
    /**
     * The ONE conversation an approval card may be sent to (default `''` = not
     * configured).
     *
     * Why this exists: without it the IM plugin resolves the target from its own
     * state (`p2pChat || activeChat`), and `p2pChat` is simply "the last chat that
     * messaged the bot" — so anyone who DMs the bot could redirect our approval
     * card to themselves. Naming the chat here is what makes the target a
     * decision of the host instead of an observation of traffic.
     *
     * `''` = today's behaviour, exactly (the card goes wherever the IM plugin
     * resolves, with no `from` whitelist and no provenance check afterwards).
     */
    approvalChatId: string
    /**
     * When true (default) an answer must come from a **p2p** chat, proven by the
     * IM plugin's own report (`answer.chatKind`). Only meaningful next to
     * {@link approvalChatId}: without a target nothing can be proven and the
     * deployment keeps today's behaviour.
     */
    p2pOnly: boolean
    /**
     * Whether the profile set `im.p2pOnly` EXPLICITLY.
     *
     * It drives the go-live guard: an operator who turns the P2P requirement on
     * but forgets `im.approvalChatId` gets a refusal that says so, instead of a
     * gate that looks hardened and is not. The DEFAULT must never trigger that
     * guard — otherwise every existing deployment would stop being able to ask.
     */
    p2pOnlyConfigured: boolean
    /**
     * Why `im.approvalChatId` is unusable, when it was configured but invalid.
     *
     * An unusable target is NOT silently ignored: ignoring it would quietly
     * restore the pre-P0 hole (whoever DMs the bot decides where the card goes),
     * so the ask path refuses while this is set.
     */
    approvalChatIdProblem?: string
    /**
     * Whether the plugin answers the host's `approval/request` waterfall itself
     * (see {@link ApprovalVia}). `off` by default: the seam is untouched.
     */
    approvalVia: ApprovalVia
    /**
     * Why `im.approvalVia` was unusable, when it was configured but invalid.
     *
     * The effective value is then `off` — and it is reported, because "the
     * approval answerer silently did not register" is exactly the kind of quiet
     * miss this suite refuses to have.
     */
    approvalViaProblem?: string
}

/** Resolved plugin configuration. */
export interface InteractionGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    prompt: {
        enabled: boolean
        order: number
    }
    /**
     * How long `interaction_ask` waits for an answer (default
     * {@link DEFAULT_ASK_TIMEOUT_MS}). A tool call may only ask for LESS.
     */
    askTimeoutMs: number
    /**
     * When true, an answer counts only if the answerer's id is in
     * `approversFile`. Default false: any participant of the channel may answer
     * (the channel's transport is then the only authentication — see the README).
     */
    requireApproverList: boolean
    /** Repository-owned approver list, relative to the workspace. */
    approversFile: string
    /** Append-only decision ledger, relative to the workspace. */
    ledgerFile: string
    /**
     * Append-only ask outbox, relative to the workspace: the durability layer
     * around the send (`intent` → `sent`/`send-failed`/`dropped`). A runtime
     * file next to the ledger, so the doctor's ignore list already covers it.
     */
    outboxFile: string
    /**
     * Append-only attention sidecar, relative to the workspace: ONLY what a
     * ledger row cannot carry — `whyYou`, the `superseded`/`withdrawn`
     * transitions and the pause interval (`pausedFrom`/`pausedTo`). Whether a
     * question IS an attention stays derived from the ledger.
     */
    attentionFile: string
    /**
     * How old an unanswered question may get before it is reported STALE
     * (default {@link DEFAULT_ATTENTION_MAX_AGE_MS}). A stale attention is still
     * listed and labelled: it is never silently hidden.
     */
    attentionMaxAgeMs: number
    /** Which `interaction_notify` levels are actually pushed. */
    notifyLevels: NotifyLevel[]
    /**
     * Channels this workspace prefers, in order. Empty = every registered
     * channel, in registration order. `interaction_ask` uses the FIRST usable
     * one; `interaction_notify` pushes to every usable one in the list.
     */
    preferredChannels: string[]
    /** Cap on one outgoing payload (title + body + declared options). */
    maxPayloadChars: number
    /** Extra regexes: a payload matching one of them is REFUSED, not sent. */
    redactPatterns: string[]
    /**
     * The optional IM routing (host-owned): whether `interaction_ask` goes
     * through the installed IM plugin's `chatInteraction.api`.
     */
    im: ImConfig
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/** Normalise a string list: trim, drop empties/duplicates, preserve order. */
export function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const out: string[] = []
    for (const entry of value) {
        if (typeof entry !== 'string') return undefined
        const trimmed = entry.trim()
        if (trimmed === '' || out.includes(trimmed)) continue
        out.push(trimmed)
    }
    return out
}

/** Normalise a notification level list; `undefined` when nothing valid remains. */
export function levelList(value: unknown): NotifyLevel[] | undefined {
    const list = stringList(value)
    if (list === undefined) return undefined
    const out: NotifyLevel[] = []
    for (const entry of list) {
        if ((NOTIFY_LEVELS as readonly string[]).includes(entry) && !out.includes(entry as NotifyLevel)) {
            out.push(entry as NotifyLevel)
        }
    }
    return out.length === 0 ? undefined : out
}

/**
 * Resolve the profile configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @param warn - optional sink for profile problems (an unusable value is
 *   reported and the default kept; the plugin still loads).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown, warn?: (message: string) => void): InteractionGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}

    const timeout = int(raw['askTimeoutMs'], DEFAULT_ASK_TIMEOUT_MS)
    if (timeout < MIN_ASK_TIMEOUT_MS || timeout > MAX_ASK_TIMEOUT_MS) {
        warn?.(
            `profile 配置: askTimeoutMs=${timeout} 超出 ${MIN_ASK_TIMEOUT_MS}…${MAX_ASK_TIMEOUT_MS}，已按默认值 ${DEFAULT_ASK_TIMEOUT_MS} 处理` +
                '（等待人的时长是宿主上限，不能由仓库或调用方抬高）',
        )
    }

    const payload = int(raw['maxPayloadChars'], DEFAULT_MAX_PAYLOAD_CHARS)
    if (payload < MIN_MAX_PAYLOAD_CHARS || payload > MAX_MAX_PAYLOAD_CHARS) {
        warn?.(
            `profile 配置: maxPayloadChars=${payload} 超出 ${MIN_MAX_PAYLOAD_CHARS}…${MAX_MAX_PAYLOAD_CHARS}，已按默认值 ${DEFAULT_MAX_PAYLOAD_CHARS} 处理`,
        )
    }

    const levels = raw['notifyLevels'] === undefined ? NOTIFY_LEVELS.filter((level) => level !== 'info') : levelList(raw['notifyLevels'])
    if (raw['notifyLevels'] !== undefined && levels === undefined) {
        warn?.(
            `profile 配置: notifyLevels 必须是 [${NOTIFY_LEVELS.join(', ')}] 的非空子集（收到 ${JSON.stringify(raw['notifyLevels'])}），已按默认值 [warn, error] 处理`,
        )
    }

    const preferred = raw['preferredChannels'] === undefined ? [] : stringList(raw['preferredChannels'])
    if (raw['preferredChannels'] !== undefined && preferred === undefined) {
        warn?.(`profile 配置: preferredChannels 必须是字符串数组，已按空（= 全部已注册通道）处理`)
    }

    const maxAge = int(raw['attentionMaxAgeMs'], DEFAULT_ATTENTION_MAX_AGE_MS)
    if (maxAge < MIN_ATTENTION_MAX_AGE_MS || maxAge > MAX_ATTENTION_MAX_AGE_MS) {
        warn?.(
            `profile 配置: attentionMaxAgeMs=${maxAge} 超出 ${MIN_ATTENTION_MAX_AGE_MS}…${MAX_ATTENTION_MAX_AGE_MS}，已按默认值 ${DEFAULT_ATTENTION_MAX_AGE_MS} 处理` +
                '（把过期判定调得太宽会让"作废的提问"看起来还新鲜）',
        )
    }

    const redact = raw['redactPatterns'] === undefined ? [] : stringList(raw['redactPatterns'])
    if (raw['redactPatterns'] !== undefined && redact === undefined) {
        warn?.('profile 配置: redactPatterns 必须是字符串数组，已按空处理')
    }

    // `im.channel` decides whether questions may leave the process through the
    // IM plugin. An unknown value is NOT silently promoted to `required` (that
    // would refuse to boot on a typo) nor trusted as-is: it keeps the default
    // `auto` and says why, like every other unusable value in this suite.
    const rawIm = raw['im']
    if (rawIm !== undefined && !isRecord(rawIm)) {
        warn?.(`profile 配置: im 必须是对象（{ channel: 'auto' | 'off' | 'required', channelId?: string, approvalChatId?: string, p2pOnly?: boolean }），收到 ${JSON.stringify(rawIm)}，已按默认 im.channel=auto 处理`)
    }
    const imBlock = isRecord(rawIm) ? rawIm : {}
    const rawMode = imBlock['channel']
    let imMode: ImChannelMode = 'auto'
    if (rawMode !== undefined) {
        if (typeof rawMode === 'string' && (IM_CHANNEL_MODES as readonly string[]).includes(rawMode)) {
            imMode = rawMode as ImChannelMode
        } else {
            warn?.(`profile 配置: im.channel 只能是 ${IM_CHANNEL_MODES.map((mode) => `"${mode}"`).join(' / ')}（收到 ${JSON.stringify(rawMode)}），已按默认 "auto" 处理`)
        }
    }
    const rawChannelId = imBlock['channelId']
    let imChannelId: string | undefined
    if (rawChannelId !== undefined) {
        if (typeof rawChannelId === 'string' && rawChannelId.trim() !== '') imChannelId = rawChannelId.trim()
        else warn?.(`profile 配置: im.channelId 必须是非空字符串（IM 渠道名，如 "feishu"），收到 ${JSON.stringify(rawChannelId)}，已忽略（改由 IM 插件解析 active chat）`)
    }
    // The bounded window is what makes `required` compatible with the actual
    // apply order (the IM plugin may provide its service after us). An
    // unusable value keeps the documented DEFAULT and says so, like every other
    // value in this suite.
    const rawWait = imBlock['requiredWaitMs']
    let imRequiredWaitMs = DEFAULT_IM_REQUIRED_WAIT_MS
    if (rawWait !== undefined) {
        const usable = typeof rawWait === 'number' && Number.isFinite(rawWait) && rawWait >= MIN_IM_REQUIRED_WAIT_MS && rawWait <= MAX_IM_REQUIRED_WAIT_MS
        if (usable) imRequiredWaitMs = Math.floor(rawWait as number)
        else {
            warn?.(
                `profile 配置: im.requiredWaitMs 必须是 ${MIN_IM_REQUIRED_WAIT_MS}…${MAX_IM_REQUIRED_WAIT_MS} 的毫秒数（收到 ${JSON.stringify(rawWait)}），` +
                    `已按默认值 ${DEFAULT_IM_REQUIRED_WAIT_MS} 处理`,
            )
        }
    }

    // --- im.approvalChatId / im.p2pOnly: the approval TARGET and its proof ----
    // Both are validated, never coerced. An unusable target is remembered as a
    // problem (so the ask refuses instead of silently falling back to "whoever
    // DMs the bot"), and an unusable `p2pOnly` keeps the strict default `true`.
    const rawApprovalChatId = imBlock['approvalChatId']
    let imApprovalChatId = ''
    let imApprovalChatIdProblem: string | undefined
    if (rawApprovalChatId !== undefined) {
        if (typeof rawApprovalChatId !== 'string') {
            imApprovalChatIdProblem =
                `im.approvalChatId 必须是字符串（平台会话 id，如 "oc_..."），收到 ${JSON.stringify(rawApprovalChatId)}：` +
                '审批提问将被拒绝（不会退回"由 IM 插件的 p2pChat/activeChat 决定目标"）'
        } else {
            const trimmed = rawApprovalChatId.trim()
            if (trimmed !== '') {
                if (trimmed.length > MAX_APPROVAL_CHAT_ID_LENGTH) {
                    imApprovalChatIdProblem =
                        `im.approvalChatId 长度 ${trimmed.length} 超过上限 ${MAX_APPROVAL_CHAT_ID_LENGTH}：审批提问将被拒绝（不像是一个会话 id）`
                } else if (/\s|[\u0000-\u001f\u007f]/.test(trimmed)) {
                    imApprovalChatIdProblem =
                        'im.approvalChatId 含空白或控制字符（多半是从别处粘进来的多余内容）：审批提问将被拒绝（这样的 id 匹配不到任何会话）'
                } else {
                    imApprovalChatId = trimmed
                }
            }
        }
        if (imApprovalChatIdProblem !== undefined) warn?.(`profile 配置: ${imApprovalChatIdProblem}`)
    }
    const rawP2pOnly = imBlock['p2pOnly']
    let imP2pOnly = DEFAULT_IM_P2P_ONLY
    let imP2pOnlyConfigured = false
    if (rawP2pOnly !== undefined) {
        if (typeof rawP2pOnly === 'boolean') {
            imP2pOnly = rawP2pOnly
            imP2pOnlyConfigured = true
        } else {
            warn?.(
                `profile 配置: im.p2pOnly 必须是布尔值（收到 ${JSON.stringify(rawP2pOnly)}），已按 fail-closed 的默认值 ${DEFAULT_IM_P2P_ONLY} 处理` +
                    '（关闭它就等于允许群聊里的人替审批人回答，所以不可用的值不会放松要求）',
            )
        }
    }

    // --- im.approvalVia: who answers the HOST's approval seam ----------------
    // Never coerced upward. `fallback`/`only` decide who may grant a permission,
    // so a typo keeps `off` (the seam is untouched) and the problem is reported:
    // silently turning the answerer on would be a permission decision nobody made.
    const rawApprovalVia = imBlock['approvalVia']
    let imApprovalVia: ApprovalVia = DEFAULT_APPROVAL_VIA
    let imApprovalViaProblem: string | undefined
    if (rawApprovalVia !== undefined) {
        if (typeof rawApprovalVia === 'string' && (APPROVAL_VIA_MODES as readonly string[]).includes(rawApprovalVia)) {
            imApprovalVia = rawApprovalVia as ApprovalVia
        } else {
            imApprovalViaProblem =
                `im.approvalVia 只能是 ${APPROVAL_VIA_MODES.map((mode) => `"${mode}"`).join(' / ')}（收到 ${JSON.stringify(rawApprovalVia)}）：` +
                `已按 "off" 处理（审批应答者不会注册，审批接缝的行为与今天完全一致）`
            warn?.(`profile 配置: ${imApprovalViaProblem}`)
        }
    }

    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/interaction-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: int(prompt['order'], 600),
        },
        askTimeoutMs: timeout < MIN_ASK_TIMEOUT_MS || timeout > MAX_ASK_TIMEOUT_MS ? DEFAULT_ASK_TIMEOUT_MS : timeout,
        requireApproverList: bool(raw['requireApproverList'], false),
        approversFile: str(raw['approversFile'], '.dsh/interaction-approvers.txt'),
        ledgerFile: str(raw['ledgerFile'], '.dsh/interaction/decisions.jsonl'),
        outboxFile: str(raw['outboxFile'], DEFAULT_OUTBOX_FILE),
        attentionFile: str(raw['attentionFile'], DEFAULT_ATTENTION_FILE),
        attentionMaxAgeMs:
            maxAge < MIN_ATTENTION_MAX_AGE_MS || maxAge > MAX_ATTENTION_MAX_AGE_MS ? DEFAULT_ATTENTION_MAX_AGE_MS : maxAge,
        notifyLevels: levels ?? (NOTIFY_LEVELS.filter((level) => level !== 'info') as NotifyLevel[]),
        preferredChannels: preferred ?? [],
        maxPayloadChars: payload < MIN_MAX_PAYLOAD_CHARS || payload > MAX_MAX_PAYLOAD_CHARS ? DEFAULT_MAX_PAYLOAD_CHARS : payload,
        redactPatterns: (redact ?? []).slice(0, MAX_REDACT_PATTERNS),
        im: {
            channel: imMode,
            requiredWaitMs: imRequiredWaitMs,
            approvalChatId: imApprovalChatId,
            p2pOnly: imP2pOnly,
            p2pOnlyConfigured: imP2pOnlyConfigured,
            approvalVia: imApprovalVia,
            ...(imChannelId === undefined ? {} : { channelId: imChannelId }),
            ...(imApprovalChatIdProblem === undefined ? {} : { approvalChatIdProblem: imApprovalChatIdProblem }),
            ...(imApprovalViaProblem === undefined ? {} : { approvalViaProblem: imApprovalViaProblem }),
        },
    }
}

/**
 * Keys a repository may refine through `<repo>/.dsh/interaction-gate.json`.
 *
 *  - `approversFile` / `ledgerFile`: where THIS repository's approvers and
 *    decisions live — repository knowledge, like `standardsFile`.
 *  - `preferredChannels`: which surface this repository's cards go to (an IM
 *    group per repository, say).
 *  - `notifyLevels`: how noisy this repository wants its channel to be.
 *  - `redactPatterns`: extra patterns to refuse. Adding them only TIGHTENS the
 *    seam (the built-in credential rules cannot be removed from here).
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'approversFile',
    'ledgerFile',
    'preferredChannels',
    'notifyLevels',
    'redactPatterns',
]

/**
 * Keys that stay host-owned, with the reason (shown by `interaction_status`).
 *
 * `askTimeoutMs` and `requireApproverList` are here because they are the two
 * keys that would let a repository widen its own seam.
 */
export const HOST_OWNED_KEYS: readonly { key: string; why: string }[] = [
    { key: 'enabled', why: '是否装载交互层是宿主的决定' },
    { key: 'logFile', why: '日志位置是宿主配置' },
    { key: 'layout', why: '工件布局是宿主配置' },
    { key: 'prompt', why: '提示词段是宿主配置' },
    { key: 'askTimeoutMs', why: '等待人的时长是宿主上限（调用方只能缩短），仓库不得抬高' },
    { key: 'requireApproverList', why: '审批人名单是否强制是宿主决定；由仓库关闭等于自我豁免' },
    { key: 'maxPayloadChars', why: '出站载荷上限按通道能力设定，属宿主' },
    { key: 'outboxFile', why: '提问出站耐久记录的位置是宿主配置（与台账并列的运行时目录）' },
    { key: 'attentionFile', why: '注意力旁路记录（whyYou/作废/暂停）的位置是宿主配置（与台账并列的运行时目录）' },
    { key: 'attentionMaxAgeMs', why: '多久算"过期的提问"是宿主上限：仓库能放宽它就等于让作废的提问继续看起来新鲜' },
    {
        key: 'im',
        why:
            'IM 通道是否启用、审批卡片发到哪个会话（im.approvalChatId）、答案是否必须来自私聊（im.p2pOnly）、' +
            '是否由本插件回答宿主的审批接缝（im.approvalVia）都是宿主决定：' +
            '仓库能选自己的审批会话，就等于绕过审批边界把卡片发给自己；而 approvalVia=fallback/only 决定的是"谁能放行一次权限"',
    },
]

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: InteractionGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file: string
    /** Recoverable problems (forbidden keys, unusable values) — never silent. */
    problems: string[]
}

/** One-line provenance, the wording the rest of the suite uses. */
export function describeSource(effective: EffectiveConfig): string {
    return effective.source === 'project' ? `项目级 ${effective.file}` : 'profile'
}

/**
 * Overlay a workspace's own `<repo>/.dsh/interaction-gate.json` on the profile row.
 *
 * Key by key onto the HOST configuration (never re-resolved from the raw row):
 * a field this overlay forgets to copy cannot quietly fall back to a plugin
 * default. A refused key keeps the profile's value and says why.
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 */
export function resolveEffectiveConfig(
    host: InteractionGateConfig,
    layout: Layout,
    logger?: { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'interaction-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }

    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE_KEYS.includes(key)) {
            const problem = `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
            problems.push(problem)
            logger?.warn(problem)
        }
    }

    const next: InteractionGateConfig = { ...host, prompt: host.prompt }
    let applied = 0
    const reject = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }
    const takePath = (key: 'approversFile' | 'ledgerFile'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value === 'string' && value.trim() !== '') {
            next[key] = value.trim()
            applied += 1
            return
        }
        reject(`${file.file}: ${key} 必须是非空字符串，已忽略（继续使用 profile 的值 ${host[key]}）`)
    }
    if (raw['preferredChannels'] !== undefined) {
        const list = stringList(raw['preferredChannels'])
        if (list === undefined) {
            reject(`${file.file}: preferredChannels 必须是字符串数组，已忽略（继续使用 profile 的值）`)
        } else {
            next.preferredChannels = list
            applied += 1
        }
    }
    if (raw['notifyLevels'] !== undefined) {
        const list = levelList(raw['notifyLevels'])
        if (list === undefined) {
            reject(
                `${file.file}: notifyLevels 必须是 [${NOTIFY_LEVELS.join(', ')}] 的非空子集，已忽略（继续使用 profile 的值 ${host.notifyLevels.join(', ')}）` +
                    '——空列表等于静默丢弃通知，属于关掉门禁而不是配置它',
            )
        } else {
            next.notifyLevels = list
            applied += 1
        }
    }
    if (raw['redactPatterns'] !== undefined) {
        const list = stringList(raw['redactPatterns'])
        if (list === undefined) {
            reject(`${file.file}: redactPatterns 必须是字符串数组，已忽略（继续使用 profile 的值）`)
        } else {
            const kept: string[] = []
            for (const pattern of list.slice(0, MAX_REDACT_PATTERNS)) {
                try {
                    new RegExp(pattern)
                    kept.push(pattern)
                } catch {
                    reject(`${file.file}: redactPatterns 里的 ${JSON.stringify(pattern)} 不是合法正则，已忽略该项（语法错误不能变成"少拦一条"）`)
                }
            }
            // UNION, never replacement: "extra rules only tighten" is the promise,
            // and replacing the host's list with a project one — even a valid,
            // non-empty one — would REMOVE rules the host declared. An all-invalid
            // project list must therefore leave the host's rules intact instead of
            // yielding an empty effective list.
            const merged = [...host.redactPatterns]
            for (const pattern of kept) if (!merged.includes(pattern)) merged.push(pattern)
            if (merged.length > MAX_REDACT_PATTERNS) {
                reject(
                    `${file.file}: redactPatterns 与 profile 的规则合计 ${merged.length} 条，超过上限 ${MAX_REDACT_PATTERNS}：` +
                        `已保留前 ${MAX_REDACT_PATTERNS} 条（profile 的规则在前，不会被项目的规则挤掉）`,
                )
                merged.length = MAX_REDACT_PATTERNS
            }
            // Only a real change counts as "the project file applied": a list that
            // adds nothing must not turn the provenance into "项目级" nor hide the
            // profile's value behind a no-op overlay.
            if (merged.length !== host.redactPatterns.length || merged.some((pattern, index) => pattern !== host.redactPatterns[index])) {
                next.redactPatterns = merged
                applied += 1
            }
        }
    }
    takePath('approversFile')
    takePath('ledgerFile')

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

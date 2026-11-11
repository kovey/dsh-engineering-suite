/**
 * The gate-authorisation kernel: ONE place that decides "may a gate act?", and
 * TWO presentations of the same question.
 *
 * Before this module each gate had its own approval path. `spec_approve` asked
 * a rich review card (nvim-tui popup / `userQuestions` plan-review) and fell
 * back to the host's `approval/request` seam; `standards_check` and
 * `deploy_run` asked the host seam directly. That produced two defects that
 * this module exists to remove:
 *
 *  1. **The same "a human must decide" meant different things.** With the host
 *     policy `never`, the seam rejects WITHOUT dispatching (`dsh-user-approval`
 *     checks the policy before any answerer), so a gate that only knew the seam
 *     silently refused a decision that nobody was asked about — and reported it
 *     as "人工审批未通过（拒绝/取消/无审批通道）", one sentence for three
 *     different facts.
 *  2. **A rejection, a cancellation and "nobody answered" were merged.** The
 *     audit trail could not tell "the approver said no" from "the card timed
 *     out", which is exactly the difference that matters after an incident.
 *
 * So the contract here is:
 *
 *  - {@link requestGateApproval} is the single entry. It never reads the host's
 *    approval service or policy to DECIDE whether to ask — that would let
 *    `policy=never` answer a hard gate by itself. Whether a person is asked is
 *    decided by the surface the caller declares.
 *  - Two surfaces: `rich` (a review card that can show/preview/edit the material
 *    a decision is about) and `binary` (allow / deny: the host's approval popup
 *    or an IM card). The caller declares which one it needs and provides the
 *    adapters; a missing surface is `no-answerer`, never a silent pass or a
 *    silent rejection.
 *  - `rejected` / `cancelled` / `no-answerer` / `rejected-by-host-policy` stay
 *    five DISTINCT outcomes with five distinct sentences
 *    ({@link describeGateApproval}), so no caller can merge them again.
 *  - **Nothing here can auto-approve.** There is no `auto` branch, no default
 *    "yes", no path that turns an unreadable reply into `allowed-once`.
 *  - A rich approval is bound to a **digest** of the material the surface
 *    displayed; when the material moved between display and approval the
 *    decision is refused instead of authorising a document nobody read.
 *
 * The host policy is READ (never obeyed) for two purposes only: recording it
 * next to the decision (`hostPolicy`), and naming it when a seam rejection is
 * explained (`rejected-by-host-policy`). {@link readHostApprovalPolicy} is the
 * one structural reader; an unknown host shape yields `undefined` and the
 * outcome stays a plain `rejected`.
 *
 * @module dsh-eng-core/gate-approval
 */

/** The two presentations of a gate question. */
export type GateSurface = 'rich' | 'binary'

/** Every surface, for validation and reports. */
export const GATE_SURFACES: readonly GateSurface[] = ['rich', 'binary']

/**
 * What asking the gate produced.
 *
 * The five values never collapse into one another:
 *  - `allowed-once` — a named answerer said yes, once.
 *  - `rejected` — a person said no (or a surface's own policy refused the card).
 *  - `cancelled` — the question was withdrawn/aborted before an answer.
 *  - `no-answerer` — NOBODY was asked: no surface could carry the question.
 *  - `rejected-by-host-policy` — the host seam rejected without dispatching,
 *    because the session's approval policy is `never`.
 */
export type GateApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'no-answerer' | 'rejected-by-host-policy'

/** Every outcome, in the order a report should explain them. */
export const GATE_APPROVAL_OUTCOMES: readonly GateApprovalOutcome[] = [
    'allowed-once',
    'rejected',
    'cancelled',
    'no-answerer',
    'rejected-by-host-policy',
]

/**
 * Which surface carried the decision.
 *
 *  - `tui-card` — this suite's rich review card, rendered through the terminal's
 *    extension API (open/preview the artifacts before deciding).
 *  - `tui-approval` — a HOST-rendered approval/review surface: the
 *    `userQuestions` `plan-review` card on desktop / web TUI (the client renders
 *    the document itself).
 *  - `im` — a card on an instant-messaging channel (the suite's own registry).
 *  - `host-seam` — the host's `approval/request` seam answered directly, with no
 *    dedicated surface of ours in between.
 */
export type GateApprovalVia = 'im' | 'tui-card' | 'tui-approval' | 'host-seam'

/** Every via, for validation and reports. */
export const GATE_APPROVAL_VIAS: readonly GateApprovalVia[] = ['im', 'tui-card', 'tui-approval', 'host-seam']

/** Words a binary channel may answer with and mean "yes". */
export const GATE_ACCEPT_VALUES: readonly string[] = ['yes', 'y', 'ok', 'allow', 'approved', 'approve', 'allowed-once', '批准', '通过']

/** Words a binary channel may answer with and mean "no". */
export const GATE_REJECT_VALUES: readonly string[] = ['no', 'n', 'deny', 'denied', 'reject', 'rejected', '拒绝', '打回']

/** Words a binary channel may answer with and mean "the question was withdrawn". */
export const GATE_CANCEL_VALUES: readonly string[] = ['cancel', 'cancelled', 'canceled', '取消']

/**
 * Map one word a channel answered with onto a binary decision.
 *
 * Anything unrecognised yields `undefined` — a channel's free text is not a
 * decision, and guessing one is how "nobody answered" becomes "approved".
 * @param value - the channel's answer value (untrusted).
 */
export function gateDecisionOfWord(value: unknown): 'allowed-once' | 'rejected' | 'cancelled' | undefined {
    if (typeof value !== 'string') return undefined
    const word = value.trim().toLowerCase()
    if ((GATE_ACCEPT_VALUES as readonly string[]).includes(word)) return 'allowed-once'
    if ((GATE_REJECT_VALUES as readonly string[]).includes(word)) return 'rejected'
    if ((GATE_CANCEL_VALUES as readonly string[]).includes(word)) return 'cancelled'
    return undefined
}

/**
 * A machine-readable reason for a non-allow outcome.
 *
 * Callers key their next step off this instead of matching prose (the audit
 * that motivated this module found a gate whose message matched the wrong
 * branch because the wording had been reused).
 */
export type GateApprovalProblem =
    | 'surface-unavailable'
    | 'surface-threw'
    | 'seam-unavailable'
    | 'seam-threw'
    | 'unreadable-answer'
    | 'rejected-by-answerer'
    | 'cancelled'
    | 'host-policy'
    | 'digest-mismatch'

/** The question as the surface adapters receive it. */
export interface GateApprovalAsk {
    /** The agent the question is about, when the caller has one. */
    agent?: unknown
    /** The tool asking. */
    toolName: string
    /** The human-readable reason (may embed an approval-context block). */
    reason: string
    /** Which presentation this ask belongs to. */
    surface: GateSurface
    /** Digest of the material the surface is displaying (`rich` always has one). */
    digest?: string
    signal?: AbortSignal
}

/**
 * What a surface adapter answers.
 *
 * `unavailable` means "this surface could not carry the question". `cardAttempted`
 * distinguishes "nothing was sent" (another surface may still ask) from "a card
 * left the process" (a second prompt would be a double question — the design
 * forbids that).
 */
export type GateSurfaceAnswer =
    | {
          kind: 'answer'
          decision: 'allowed-once' | 'rejected' | 'cancelled'
          /** Who decided; empty when the surface reports no identity. */
          by?: string
          /** Channel-side message id (the card), for the ledger. */
          messageId?: string
          /** Which surface actually decided (defaults to the adapter's declared one). */
          via?: GateApprovalVia
          /** A note the answerer wrote (e.g. what made them reject). */
          note?: string
          /** The digest the surface DISPLAYED, when it knows it. */
          displayedDigest?: string
      }
    | { kind: 'unavailable'; reason?: string; cardAttempted?: boolean }

/**
 * One surface adapter. It is a function (not an object) so a caller decides per
 * call whether the surface exists — a plugin that gains a channel at runtime
 * needs no re-registration.
 */
export type GateSurfaceAdapter = (ask: GateApprovalAsk) => Promise<GateSurfaceAnswer> | GateSurfaceAnswer

/** The adapters a caller provides. */
export interface GateApprovalSurfaces {
    /** The rich review surface: a card that can show/preview the material. */
    rich?: GateSurfaceAdapter
    /** The binary suite surface (an IM card), tried before the host seam. */
    binary?: GateSurfaceAdapter
    /** The host's own approval seam — `binary` only, and only when the suite channel cannot ask. */
    hostSeam?: GateSurfaceAdapter
}

/** What a caller passes to {@link requestGateApproval}. */
export interface GateApprovalInput {
    agent?: unknown
    toolName: string
    reason: string
    /** The caller DECLARES the presentation; the kernel never infers one. */
    surface: GateSurface
    /**
     * Digest of the material the surface displays. REQUIRED for `rich`: an
     * approval that is not bound to the reviewed version is a blind approval.
     */
    digest?: string
    /**
     * Re-reads the same material at approval time. When it disagrees with
     * {@link digest}, the answer is refused with `digest-mismatch`.
     */
    readDigest?: () => string | undefined
    signal?: AbortSignal
    /**
     * The host's approval policy as the CALLER read it (see
     * {@link readHostApprovalPolicy}). Never consulted to decide whether to ask;
     * only recorded, and used to explain a seam rejection.
     */
    hostPolicy?: string
    /** The surface adapters. */
    surfaces: GateApprovalSurfaces
}

/** What the kernel reports. */
export interface GateApprovalResult {
    outcome: GateApprovalOutcome
    /** `true` only for `allowed-once`; a call site cannot misread the rest. */
    allowed: boolean
    /** Who decided; empty when nobody did or the surface reported no identity. */
    by: string
    /** Which surface decided (absent when nobody did). */
    via?: GateApprovalVia
    /** Channel-side message id, when the surface had one. */
    messageId?: string
    /** The host policy observed at request time, when the caller exposed it. */
    hostPolicy?: string
    /** The digest the decision is bound to (echo of the verified ask). */
    digest?: string
    /** The answerer's note, when one was given. */
    note?: string
    /** Why the outcome is not `allowed-once` (always present then). */
    problem?: string
    /** Machine-readable form of {@link problem}. */
    problemCode?: GateApprovalProblem
    /** When the decision was recorded (epoch ms). */
    at: number
}

/**
 * Read the host's approval policy from a service, structurally.
 *
 * The installed `@deepseek-ai/dsh-user-approval` keeps the effective policy out
 * of the public surface (`effectivePolicy` is private) but exposes its two
 * inputs: the session override (`overrideOf(session)`) and the deployment
 * default (`config.policy`). Both are read here, defensively — an older host
 * that has neither yields `undefined`, which a caller must treat as "unknown"
 * (the kernel then reports a plain `rejected`, never `rejected-by-host-policy`,
 * because naming a policy it did not read would be a guess).
 * @param approval - whatever `ctx.get('approval')` returned (untrusted shape).
 * @param agent - the agent whose session policy applies.
 * @returns the policy string, or `undefined` when it cannot be read.
 */
export function readHostApprovalPolicy(approval: unknown, agent: unknown): string | undefined {
    if (typeof approval !== 'object' || approval === null) return undefined
    const service = approval as Record<string, unknown>
    const session = (agent as { session?: unknown } | undefined)?.session
    const overrideOf = service['overrideOf']
    if (typeof overrideOf === 'function' && session !== undefined) {
        try {
            const value = (overrideOf as (session: unknown) => unknown).call(approval, session)
            if (typeof value === 'string' && value !== '') return value
        } catch {
            // A service that throws while reporting its policy has not told us
            // anything: fall through to the configured default.
        }
    }
    const config = service['config']
    if (typeof config === 'object' && config !== null) {
        const policy = (config as Record<string, unknown>)['policy']
        if (typeof policy === 'string' && policy !== '') return policy
    }
    const direct = service['policy']
    if (typeof direct === 'string' && direct !== '') return direct
    return undefined
}

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function viaOf(value: unknown): GateApprovalVia | undefined {
    return typeof value === 'string' && (GATE_APPROVAL_VIAS as readonly string[]).includes(value)
        ? (value as GateApprovalVia)
        : undefined
}

/**
 * Provenance the failure paths may carry (never the verdict itself).
 *
 * Deliberately NOT `Partial<GateApprovalResult>`: a failure helper that accepts
 * `outcome`/`allowed` is one refactor away from overriding the fail-closed
 * result, and this module's whole point is that it cannot.
 */
interface GateApprovalTrace {
    digest?: string
    hostPolicy?: string
}

function problem(code: GateApprovalProblem, message: string, trace: GateApprovalTrace = {}): GateApprovalResult {
    // Every failure path ends here, which is why `allowed` can never be set by
    // anything but the single success branch below.
    return { outcome: 'no-answerer', allowed: false, by: '', problem: message, problemCode: code, at: Date.now(), ...trace }
}

/** The result of one surface attempt, normalised (never throws out of the kernel). */
type Attempt =
    | { kind: 'answer'; decision: 'allowed-once' | 'rejected' | 'cancelled'; by: string; messageId: string; via?: GateApprovalVia; note?: string; displayedDigest?: string }
    | { kind: 'unavailable'; reason: string; cardAttempted: boolean; code: GateApprovalProblem }

/**
 * Normalise one adapter's return value.
 *
 * An unknown shape, a throwing adapter and an unrecognised decision word all
 * become `unavailable`: guessing a decision from an unreadable reply is exactly
 * how "nobody answered" becomes "approved".
 * @param adapter - the surface (undefined when the caller declared none).
 * @param ask - the question.
 * @param declared - the `via` this adapter stands for.
 */
async function attempt(
    adapter: GateSurfaceAdapter | undefined,
    ask: GateApprovalAsk,
    declared: GateApprovalVia,
): Promise<Attempt> {
    if (adapter === undefined) {
        return { kind: 'unavailable', reason: '调用方没有为这个面提供适配器', cardAttempted: false, code: 'surface-unavailable' }
    }
    let reply: unknown
    try {
        reply = await adapter(ask)
    } catch (error) {
        return {
            kind: 'unavailable',
            reason: `面的适配器抛出错误：${error instanceof Error ? error.message : String(error)}`,
            cardAttempted: false,
            code: 'surface-threw',
        }
    }
    if (typeof reply !== 'object' || reply === null) {
        return { kind: 'unavailable', reason: `面的适配器返回了无法识别的值（${typeof reply}）`, cardAttempted: false, code: 'unreadable-answer' }
    }
    const record = reply as Record<string, unknown>
    if (record['kind'] === 'answer') {
        const decision = record['decision']
        if (decision !== 'allowed-once' && decision !== 'rejected' && decision !== 'cancelled') {
            return {
                kind: 'unavailable',
                reason: `面报告了无法识别的决定（${JSON.stringify(decision)}）`,
                cardAttempted: false,
                code: 'unreadable-answer',
            }
        }
        const displayedDigest = textOf(record['displayedDigest'])
        return {
            kind: 'answer',
            decision,
            by: textOf(record['by']),
            messageId: textOf(record['messageId']),
            via: viaOf(record['via']) ?? declared,
            ...(textOf(record['note']) === '' ? {} : { note: textOf(record['note']) }),
            ...(displayedDigest === '' ? {} : { displayedDigest }),
        }
    }
    if (record['kind'] === 'unavailable') {
        return {
            kind: 'unavailable',
            reason: textOf(record['reason']) || '面报告不可用（没有说明原因）',
            cardAttempted: record['cardAttempted'] === true,
            code: 'surface-unavailable',
        }
    }
    return { kind: 'unavailable', reason: '面的适配器返回了无法识别的结构', cardAttempted: false, code: 'unreadable-answer' }
}

/**
 * Ask for a gate's authorisation. The single entry point of the kernel.
 *
 * Flow:
 *  - `rich`: the caller's `rich` adapter (nvim-tui card / `userQuestions`
 *    plan-review) is the ONLY callee. The host approval seam is never used for
 *    a rich decision — a popup cannot show the document, and silently
 *    downgrading to one is the "blind approval" the ADR rejected. A missing
 *    rich surface is `no-answerer` with the pinned message.
 *  - `binary`: the suite's channel adapter (IM card) is tried first; ONLY when
 *    it could not carry the question (nothing was sent) does the host seam get
 *    a chance. A seam `rejected` under the session policy `never` is reported
 *    as `rejected-by-host-policy` (naming the policy), because the seam rejected
 *    without dispatching — nobody was asked.
 *  - Any answered `allowed-once` on a rich ask is checked against the digest;
 *    drift turns it into a `rejected` with `digest-mismatch`.
 *
 * @throws when a rich request carries no digest (a caller defect: the approval
 *   could not be bound to anything) — never `allowed-once`.
 * @param input - the question, the declared surface and the adapters.
 * @returns the outcome with provenance; only `allowed-once` means "go".
 */
export async function requestGateApproval(input: GateApprovalInput): Promise<GateApprovalResult> {
    const surface = input.surface
    if (!(GATE_SURFACES as readonly string[]).includes(surface)) {
        return problem('surface-unavailable', `调用方声明了无法识别的呈现面 "${String(surface)}"（只支持 rich / binary）`, {
            ...(input.hostPolicy === undefined ? {} : { hostPolicy: input.hostPolicy }),
        })
    }
    if (input.toolName.trim() === '') {
        return problem('surface-unavailable', '调用方没有给出 toolName：这次请求无法归属到任何门禁', {
            ...(input.hostPolicy === undefined ? {} : { hostPolicy: input.hostPolicy }),
        })
    }
    const digest = input.digest === undefined ? undefined : textOf(input.digest)
    if (surface === 'rich' && (digest === undefined || digest === '')) {
        // Fail closed by THROWING: returning an outcome word would let a caller
        // that ignores `allowed` continue with a blind approval.
        throw new Error(
            `请求富审阅面授权时必须给出被审阅材料的 digest（toolName=${input.toolName}）：` +
                '否则"批准"无法绑定到人看到的那一版。',
        )
    }
    const ask: GateApprovalAsk = {
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        toolName: input.toolName,
        reason: input.reason,
        surface,
        ...(digest === undefined ? {} : { digest }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
    const base: GateApprovalTrace = {
        ...(digest === undefined ? {} : { digest }),
        ...(input.hostPolicy === undefined ? {} : { hostPolicy: input.hostPolicy }),
    }

    const answered = async (reply: Extract<Attempt, { kind: 'answer' }>): Promise<GateApprovalResult> => {
        const provenance: Partial<GateApprovalResult> = {
            ...base,
            by: reply.by,
            ...(reply.via === undefined ? {} : { via: reply.via }),
            ...(reply.messageId === '' ? {} : { messageId: reply.messageId }),
            ...(reply.note === undefined ? {} : { note: reply.note }),
        }
        if (reply.decision !== 'allowed-once') {
            // A seam rejection under `policy=never` is not a person's answer, on
            // ANY declared surface: the host checks that policy before it
            // dispatches, so nobody was asked. (A channel answerer that reports
            // its own surface — an IM click behind the seam says `via: 'im'` —
            // keeps its own provenance and is therefore NOT mislabelled.)
            if (reply.decision === 'rejected' && reply.via === 'host-seam' && input.hostPolicy === 'never') {
                return {
                    outcome: 'rejected-by-host-policy',
                    allowed: false,
                    ...provenance,
                    by: reply.by,
                    problem:
                        `宿主审批接缝返回 rejected，而会话的审批策略是 policy=${input.hostPolicy}：` +
                        '接缝在派发之前就按策略拒绝了，**没有问过任何人**。这不是审批人的拒绝。',
                    problemCode: 'host-policy',
                    at: Date.now(),
                }
            }
            return {
                outcome: reply.decision,
                allowed: false,
                ...provenance,
                by: reply.by,
                problem:
                    reply.decision === 'cancelled'
                        ? '等待人工裁决的过程中被取消：没有人作出决定。'
                        : '审批人否决了这次请求。',
                problemCode: reply.decision === 'cancelled' ? 'cancelled' : 'rejected-by-answerer',
                at: Date.now(),
            }
        }
        // ---- digest binding: the decision must be about what was displayed ----
        if (digest !== undefined) {
            if (reply.displayedDigest !== undefined && reply.displayedDigest !== digest) {
                return drift(digest, reply.displayedDigest)
            }
            let current: string | undefined
            try {
                current = input.readDigest?.()
            } catch (error) {
                return {
                    outcome: 'rejected',
                    allowed: false,
                    by: reply.by,
                    ...provenance,
                    problem: `批准时无法重新读取被审阅材料（${error instanceof Error ? error.message : String(error)}）：无法确认批准的是哪一版，按失败处理。`,
                    problemCode: 'digest-mismatch',
                    at: Date.now(),
                }
            }
            if (current !== undefined && current !== digest) {
                return drift(digest, current)
            }
        }
        return {
            outcome: 'allowed-once',
            allowed: true,
            by: reply.by,
            ...provenance,
            at: Date.now(),
        }
    }
    const drift = (shown: string, current: string): GateApprovalResult => ({
        outcome: 'rejected',
        allowed: false,
        by: '',
        ...base,
        problem:
            `被审阅材料在展示之后、批准之前发生了变化（展示摘要 ${shown.slice(0, 12)}，批准时摘要 ${current.slice(0, 12)}）：` +
            '这次批准绑定的是另一版材料，必须重新送审。',
        problemCode: 'digest-mismatch',
        at: Date.now(),
    })

    if (surface === 'rich') {
        const reply = await attempt(input.surfaces.rich, ask, 'tui-card')
        if (reply.kind === 'answer') return await answered(reply)
        return problem(reply.code, richNoAnswererText(reply.reason, input.toolName), base)
    }

    // ---- binary: suite channel first, the host seam only if it could not ask --
    const suite = await attempt(input.surfaces.binary, ask, 'im')
    if (suite.kind === 'answer') return await answered(suite)
    if (suite.cardAttempted) {
        // A card may already be on somebody's phone: a second prompt in another
        // surface would be two questions for one decision.
        return problem(
            suite.code,
            `二元面已经发出过卡片但没有得到可用答案（${suite.reason}）：同一问题不能再问第二个面，按"没有人决定"处理。`,
            base,
        )
    }
    const seam = await attempt(input.surfaces.hostSeam, ask, 'host-seam')
    if (seam.kind === 'answer') {
        // `answered()` owns the host-policy mapping, so it applies to every
        // surface that ends up answered through the seam.
        return await answered(seam)
    }
    return problem(
        seam.code === 'surface-unavailable' || seam.code === 'surface-threw' ? 'seam-unavailable' : seam.code,
        noAnswererText(suite.reason, seam.reason, input.hostPolicy),
        base,
    )
}

/** The rich surface could not carry the question: nobody was asked. */
function richNoAnswererText(reason: string, toolName: string): string {
    return (
        `没有可用的富审阅面（no-answerer）：这次请求（${toolName}）需要一份可阅读、可修改的评审材料，` +
        '所以不会降级成"只能点允许/拒绝"的审批浮窗——**没有人被问到**。' +
        `面的情况：${reason}。` +
        '建议：在 nvim-tui 里运行（扩展卡片可打开/预览工件），或在能渲染 userQuestions plan-review 的 desktop / web TUI 里运行；' +
        '并把 spec-gate 的 reviewChannel 设为 auto。'
    )
}

/** The binary surfaces could not carry the question: nobody was asked. */
function noAnswererText(suiteReason: string, seamReason: string, hostPolicy: string | undefined): string {
    return (
        '没有可用的审批面（no-answerer）：没有人被问到，所以这既不是拒绝，也不是取消。' +
        `套件通道：${suiteReason}；宿主审批接缝：${seamReason}。` +
        (hostPolicy === undefined
            ? '（宿主没有暴露审批策略，无法判断策略是否也参与其中。）'
            : `（宿主审批策略：policy=${hostPolicy}；策略只影响宿主接缝，不影响套件通道。）`) +
        '建议：装配 dsh-interaction-gate 的 IM 通道（它实现了 wait()，能收到答案），或让宿主装配审批插件（ctx.approval）；' +
        '然后重试。'
    )
}

/**
 * One sentence per outcome, deliberately distinct.
 *
 * Callers MUST report the sentence for the outcome they received: throwing all
 * non-allow outcomes into one "approval failed" line is the defect this module
 * exists to end.
 * @param result - the kernel's verdict.
 */
export function describeGateApproval(result: GateApprovalResult): string {
    const who = result.by === '' ? '' : `（by ${result.by}${result.via === undefined ? '' : ` via ${result.via}`}）`
    switch (result.outcome) {
        case 'allowed-once':
            return `已获一次性授权${who}：只放行这一次。`
        case 'rejected':
            return `审批人拒绝了这次请求${who}：不是"没人回答"，也不是"取消"。`
        case 'cancelled':
            return '等待人工裁决的过程被取消（cancelled）：没有人作出决定——取消不是拒绝，也不是同意。'
        case 'no-answerer':
            return '没有可用的审批面（no-answerer）：**没有人被问到**——既不是拒绝，也不是取消。'
        case 'rejected-by-host-policy':
            return `宿主会话的审批策略直接拒绝了这次请求（rejected-by-host-policy${result.hostPolicy === undefined ? '' : `，policy=${result.hostPolicy}`}）：接缝没有派发，**没有问过任何人**。`
    }
}

/** Whether a result authorises the action (the only predicate a caller should use). */
export function gateApprovalAllowed(result: GateApprovalResult): boolean {
    return result.outcome === 'allowed-once' && result.allowed === true
}

/**
 * Map a kernel `via` onto the vocabulary {@link approvalStrength} understands
 * (`tui` / `questions` / `im` / `seam`).
 *
 * The strength rule is a security decision (a local operator session vs a
 * remote channel), and it predates the kernel. Translating in ONE place keeps a
 * new surface from silently changing how strong an approval looks: `im` stays
 * `im` (and stays `inferred` without an allowlist), the TUI card stays `tui`,
 * the web/desktop plan-review card keeps its historical `questions` label, and
 * the generic seam stays `seam`.
 * @param via - the surface the kernel reported.
 * @returns the strength-vocabulary source (empty when nobody decided).
 */
export function approvalSourceOfVia(via: GateApprovalVia | undefined): string {
    switch (via) {
        case 'tui-card':
            return 'tui'
        case 'tui-approval':
            return 'questions'
        case 'host-seam':
            return 'seam'
        case 'im':
            return 'im'
        default:
            return ''
    }
}

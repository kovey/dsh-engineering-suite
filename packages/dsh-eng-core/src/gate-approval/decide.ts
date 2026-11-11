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
 *    ({@link module:dsh-eng-core/gate-approval/text describeGateApproval}), so no
 *    caller can merge them again.
 *  - **Nothing here can auto-approve.** There is no `auto` branch, no default
 *    "yes", no path that turns an unreadable reply into `allowed-once`.
 *  - A rich approval is bound to a **digest** of the material the surface
 *    displayed: {@link module:dsh-eng-core/gate-approval/verdict} refuses a
 *    decision whose material moved between display and approval.
 *
 * @module dsh-eng-core/gate-approval/decide
 */

import { attempt } from './surfaces.js'
import { cardSentText, noAnswererText, richNoAnswererText, textOf } from './text.js'
import { problem, traceOf, type Bound, type GateApprovalTrace } from './trace.js'
import {
    GATE_SURFACES,
    type GateApprovalAsk,
    type GateApprovalInput,
    type GateApprovalProblem,
    type GateApprovalResult,
    type GateSurface,
} from './types.js'
import { answered } from './verdict.js'

/**
 * Reject a caller defect before any surface is touched.
 * @param input - the request.
 * @returns the fail-closed result, or `undefined` when the request is well formed.
 */
function inputProblem(input: GateApprovalInput): GateApprovalResult | undefined {
    const surface = input.surface
    if (!(GATE_SURFACES as readonly string[]).includes(surface)) {
        return problem(
            'surface-unavailable',
            `调用方声明了无法识别的呈现面 "${String(surface)}"（只支持 rich / binary）`,
            traceOf(input),
        )
    }
    if (input.toolName.trim() === '') {
        return problem('surface-unavailable', '调用方没有给出 toolName：这次请求无法归属到任何门禁', traceOf(input))
    }
    return undefined
}

/**
 * Fail closed by THROWING when a rich request carries no digest: returning an
 * outcome word would let a caller that ignores `allowed` continue with a blind
 * approval.
 * @param surface - the declared presentation.
 * @param digest - the digested material, if the caller gave any.
 * @param toolName - the asking tool (for the message).
 */
function requireDigest(surface: GateSurface, digest: string | undefined, toolName: string): void {
    if (surface !== 'rich') return
    if (digest !== undefined && digest !== '') return
    throw new Error(
        `请求富审阅面授权时必须给出被审阅材料的 digest（toolName=${toolName}）：` +
            '否则"批准"无法绑定到人看到的那一版。',
    )
}

/** The question as the adapters receive it. */
function askOf(input: GateApprovalInput, digest: string | undefined): GateApprovalAsk {
    return {
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        toolName: input.toolName,
        reason: input.reason,
        surface: input.surface,
        ...(digest === undefined ? {} : { digest }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
}

/** The provenance every result of this request carries. */
function baseOf(input: GateApprovalInput, digest: string | undefined): GateApprovalTrace {
    return {
        ...(digest === undefined ? {} : { digest }),
        ...(input.hostPolicy === undefined ? {} : { hostPolicy: input.hostPolicy }),
    }
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
    const invalid = inputProblem(input)
    if (invalid !== undefined) return invalid
    const digest = input.digest === undefined ? undefined : textOf(input.digest)
    requireDigest(input.surface, digest, input.toolName)
    const ask = askOf(input, digest)
    const bound: Bound = { input, base: baseOf(input, digest), digest }
    if (input.surface === 'rich') return await askRich(bound, ask)
    return await askBinary(bound, ask)
}

/**
 * The rich path: the caller's rich adapter is the ONLY callee.
 * @param bound - the request and the digest the answer must stay bound to.
 * @param ask - the question, as the adapter receives it.
 */
async function askRich(bound: Bound, ask: GateApprovalAsk): Promise<GateApprovalResult> {
    const reply = await attempt(bound.input.surfaces.rich, ask, 'tui-card')
    if (reply.kind === 'answer') return answered(reply, bound)
    return problem(reply.code, richNoAnswererText(reply.reason, bound.input.toolName), bound.base)
}

/**
 * The binary path: the suite channel first, the host seam only if it could not ask.
 * @param bound - the request and the digest the answer must stay bound to.
 * @param ask - the question, as the adapter receives it.
 */
async function askBinary(bound: Bound, ask: GateApprovalAsk): Promise<GateApprovalResult> {
    const suite = await attempt(bound.input.surfaces.binary, ask, 'im')
    if (suite.kind === 'answer') return answered(suite, bound)
    if (suite.cardAttempted) {
        // A card may already be on somebody's phone: a second prompt in another
        // surface would be two questions for one decision.
        return problem(suite.code, cardSentText(suite.reason), bound.base)
    }
    const seam = await attempt(bound.input.surfaces.hostSeam, ask, 'host-seam')
    // `answered()` owns the host-policy mapping, so it applies to every surface
    // that ends up answered through the seam.
    if (seam.kind === 'answer') return answered(seam, bound)
    return problem(
        seamProblemCode(seam.code),
        noAnswererText(suite.reason, seam.reason, bound.input.hostPolicy),
        bound.base,
    )
}

/** A seam that could not be reached at all is named `seam-*`, not `surface-*`. */
function seamProblemCode(code: GateApprovalProblem): GateApprovalProblem {
    return code === 'surface-unavailable' || code === 'surface-threw' ? 'seam-unavailable' : code
}

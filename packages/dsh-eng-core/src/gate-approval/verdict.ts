/**
 * Turning ONE answer into a verdict: the only place `allowed` can become `true`.
 *
 * Everything a surface reported is normalised by
 * {@link module:dsh-eng-core/gate-approval/surfaces} before it arrives here, so
 * this module can assume a decision word it knows. The rules it enforces:
 *
 *  - `rejected` / `cancelled` are two sentences, never one;
 *  - a seam rejection under `policy=never` is `rejected-by-host-policy` (nobody
 *    was asked), on ANY declared surface — unless the answerer reported its own
 *    surface (an IM click behind the seam says `via: 'im'`), which keeps its own
 *    provenance;
 *  - an `allowed-once` is bound to the digest of the material the surface
 *    displayed: a surface-reported disagreement, a re-read disagreement or an
 *    unreadable re-read all refuse it with `digest-mismatch`.
 *
 * @module dsh-eng-core/gate-approval/verdict
 */

import { messageOf } from './text.js'
import type { Bound, GateApprovalTrace } from './trace.js'
import type { Attempt } from './surfaces.js'
import type { GateApprovalResult } from './types.js'

/** One normalised answer (what a surface actually decided). */
export type Answered = Extract<Attempt, { kind: 'answer' }>

/**
 * Turn one answer into a verdict. The only place `allowed` can become `true`.
 * @param reply - the normalised answer.
 * @param bound - the request and the digest the answer must stay bound to.
 */
export function answered(reply: Answered, bound: Bound): GateApprovalResult {
    const provenance = provenanceOf(bound.base, reply)
    if (reply.decision !== 'allowed-once') return notAllowed(reply, provenance, bound.input.hostPolicy)
    return allowedOnce(reply, bound, provenance)
}

/** Who/where/with which note the surface reported (plus the request provenance). */
function provenanceOf(base: GateApprovalTrace, reply: Answered): Partial<GateApprovalResult> {
    return {
        ...base,
        by: reply.by,
        ...(reply.via === undefined ? {} : { via: reply.via }),
        ...(reply.messageId === '' ? {} : { messageId: reply.messageId }),
        ...(reply.note === undefined ? {} : { note: reply.note }),
    }
}

/**
 * A surface said no, or the question was withdrawn: two different sentences.
 *
 * A seam rejection under `policy=never` is not a person's answer, on ANY
 * declared surface: the host checks that policy before it dispatches, so nobody
 * was asked.
 * @param reply - the normalised answer.
 * @param provenance - who/where.
 * @param hostPolicy - the policy the caller read (never obeyed).
 */
function notAllowed(
    reply: Answered,
    provenance: Partial<GateApprovalResult>,
    hostPolicy: string | undefined,
): GateApprovalResult {
    if (reply.decision === 'rejected' && reply.via === 'host-seam' && hostPolicy === 'never') {
        return refusedByHostPolicy(reply, provenance, hostPolicy)
    }
    const cancelled = reply.decision === 'cancelled'
    return {
        outcome: reply.decision,
        allowed: false,
        ...provenance,
        by: reply.by,
        problem: cancelled ? '等待人工裁决的过程中被取消：没有人作出决定。' : '审批人否决了这次请求。',
        problemCode: cancelled ? 'cancelled' : 'rejected-by-answerer',
        at: Date.now(),
    }
}

/** The seam rejected without dispatching because the session policy is `never`. */
function refusedByHostPolicy(
    reply: Answered,
    provenance: Partial<GateApprovalResult>,
    hostPolicy: string,
): GateApprovalResult {
    return {
        outcome: 'rejected-by-host-policy',
        allowed: false,
        ...provenance,
        by: reply.by,
        problem:
            `宿主审批接缝返回 rejected，而会话的审批策略是 policy=${hostPolicy}：` +
            '接缝在派发之前就按策略拒绝了，**没有问过任何人**。这不是审批人的拒绝。',
        problemCode: 'host-policy',
        at: Date.now(),
    }
}

/**
 * A person said yes: authorise ONE run, unless the material moved underneath the
 * decision.
 * @param reply - the normalised answer.
 * @param bound - the request and the digest the answer must stay bound to.
 * @param provenance - who/where.
 */
function allowedOnce(reply: Answered, bound: Bound, provenance: Partial<GateApprovalResult>): GateApprovalResult {
    return (
        digestRefusal(reply, bound, provenance) ?? {
            outcome: 'allowed-once',
            allowed: true,
            by: reply.by,
            ...provenance,
            at: Date.now(),
        }
    )
}

/**
 * The digest binding: the decision must be about what was displayed.
 *
 * Two independent checks — the digest the surface says it displayed, and the
 * digest re-read now. Either disagreement refuses the approval.
 * @param reply - the normalised answer.
 * @param bound - the request and the digest the answer must stay bound to.
 * @param provenance - who/where.
 * @returns the refusal, or `undefined` when the decision is still bound.
 */
function digestRefusal(
    reply: Answered,
    bound: Bound,
    provenance: Partial<GateApprovalResult>,
): GateApprovalResult | undefined {
    const digest = bound.digest
    if (digest === undefined) return undefined
    if (reply.displayedDigest !== undefined && reply.displayedDigest !== digest) {
        return drift(digest, reply.displayedDigest, bound.base)
    }
    let current: string | undefined
    try {
        current = bound.input.readDigest?.()
    } catch (error) {
        return unreadableMaterial(reply, error, provenance)
    }
    return current === undefined || current === digest ? undefined : drift(digest, current, bound.base)
}

/** The material changed between display and approval: this approval bound another version. */
function drift(shown: string, current: string, base: GateApprovalTrace): GateApprovalResult {
    return {
        outcome: 'rejected',
        allowed: false,
        by: '',
        ...base,
        problem:
            `被审阅材料在展示之后、批准之前发生了变化（展示摘要 ${shown.slice(0, 12)}，批准时摘要 ${current.slice(0, 12)}）：` +
            '这次批准绑定的是另一版材料，必须重新送审。',
        problemCode: 'digest-mismatch',
        at: Date.now(),
    }
}

/** The material could not be re-read at approval time: refuse rather than guess. */
function unreadableMaterial(
    reply: Answered,
    error: unknown,
    provenance: Partial<GateApprovalResult>,
): GateApprovalResult {
    return {
        outcome: 'rejected',
        allowed: false,
        by: reply.by,
        ...provenance,
        problem: `批准时无法重新读取被审阅材料（${messageOf(error)}）：无法确认批准的是哪一版，按失败处理。`,
        problemCode: 'digest-mismatch',
        at: Date.now(),
    }
}

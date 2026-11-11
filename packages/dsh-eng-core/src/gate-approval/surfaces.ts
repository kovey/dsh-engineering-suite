/**
 * Calling ONE declared surface and normalising whatever it answers.
 *
 * Nothing here decides anything: an unknown shape, a throwing adapter and an
 * unrecognised decision word all become `unavailable`, because guessing a
 * decision from an unreadable reply is exactly how "nobody answered" becomes
 * "approved". Only {@link module:dsh-eng-core/gate-approval/decide} turns an
 * answer into a verdict.
 *
 * @module dsh-eng-core/gate-approval/surfaces
 */

import { messageOf, textOf } from './text.js'
import { GATE_APPROVAL_VIAS, type GateApprovalAsk, type GateApprovalProblem, type GateApprovalVia, type GateSurfaceAdapter } from './types.js'

/** The result of one surface attempt, normalised (never throws out of the kernel). */
export type Attempt =
    | {
          kind: 'answer'
          decision: 'allowed-once' | 'rejected' | 'cancelled'
          by: string
          messageId: string
          via?: GateApprovalVia
          note?: string
          displayedDigest?: string
      }
    | { kind: 'unavailable'; reason: string; cardAttempted: boolean; code: GateApprovalProblem }

/** One `unavailable` attempt: the shape every non-answer path uses. */
function unavailable(reason: string, code: GateApprovalProblem, cardAttempted = false): Attempt {
    return { kind: 'unavailable', reason, cardAttempted, code }
}

/**
 * A `via` the surface reported, when it is one of the four we know.
 * @param value - the untrusted field.
 */
function viaOf(value: unknown): GateApprovalVia | undefined {
    return typeof value === 'string' && (GATE_APPROVAL_VIAS as readonly string[]).includes(value)
        ? (value as GateApprovalVia)
        : undefined
}

/**
 * Normalise a surface's `{ kind: 'answer' }` reply.
 *
 * A decision word outside the three accepted values is `unavailable`, not a
 * guess: the surface said something this kernel does not understand.
 * @param record - the reply, as an untrusted record.
 * @param declared - the `via` this adapter stands for (used when it reports none).
 */
function answerFrom(record: Record<string, unknown>, declared: GateApprovalVia): Attempt {
    const decision = record['decision']
    if (decision !== 'allowed-once' && decision !== 'rejected' && decision !== 'cancelled') {
        return unavailable(`面报告了无法识别的决定（${JSON.stringify(decision)}）`, 'unreadable-answer')
    }
    const note = textOf(record['note'])
    const displayedDigest = textOf(record['displayedDigest'])
    return {
        kind: 'answer',
        decision,
        by: textOf(record['by']),
        messageId: textOf(record['messageId']),
        via: viaOf(record['via']) ?? declared,
        ...(note === '' ? {} : { note }),
        ...(displayedDigest === '' ? {} : { displayedDigest }),
    }
}

/**
 * Normalise a surface's `{ kind: 'unavailable' }` reply.
 *
 * `cardAttempted` is load-bearing: "nothing was sent" lets another surface ask,
 * "a card left the process" forbids a second prompt for the same decision.
 * @param record - the reply, as an untrusted record.
 */
function unavailableFrom(record: Record<string, unknown>): Attempt {
    return unavailable(
        textOf(record['reason']) || '面报告不可用（没有说明原因）',
        'surface-unavailable',
        record['cardAttempted'] === true,
    )
}

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
export async function attempt(
    adapter: GateSurfaceAdapter | undefined,
    ask: GateApprovalAsk,
    declared: GateApprovalVia,
): Promise<Attempt> {
    if (adapter === undefined) {
        return unavailable('调用方没有为这个面提供适配器', 'surface-unavailable')
    }
    let reply: unknown
    try {
        reply = await adapter(ask)
    } catch (error) {
        return unavailable(`面的适配器抛出错误：${messageOf(error)}`, 'surface-threw')
    }
    if (typeof reply !== 'object' || reply === null) {
        return unavailable(`面的适配器返回了无法识别的值（${typeof reply}）`, 'unreadable-answer')
    }
    const record = reply as Record<string, unknown>
    if (record['kind'] === 'answer') return answerFrom(record, declared)
    if (record['kind'] === 'unavailable') return unavailableFrom(record)
    return unavailable('面的适配器返回了无法识别的结构', 'unreadable-answer')
}

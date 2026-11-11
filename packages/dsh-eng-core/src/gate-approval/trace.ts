/**
 * What every result of one request carries, and the ONE fail-closed builder.
 *
 * This module exists so `decide` and `verdict` share provenance without sharing
 * a verdict: {@link problem} cannot express `allowed`, and a helper that cannot
 * express "yes" cannot accidentally say it.
 *
 * @module dsh-eng-core/gate-approval/trace
 */

import type { GateApprovalInput, GateApprovalProblem, GateApprovalResult } from './types.js'

/**
 * Provenance the failure paths may carry (never the verdict itself).
 *
 * Deliberately NOT `Partial<GateApprovalResult>`: a failure helper that accepts
 * `outcome`/`allowed` is one refactor away from overriding the fail-closed
 * result, and this module's whole point is that it cannot.
 */
export interface GateApprovalTrace {
    digest?: string
    hostPolicy?: string
}

/** The request plus the digest the answer must stay bound to. */
export interface Bound {
    input: GateApprovalInput
    base: GateApprovalTrace
    digest: string | undefined
}

/** The host policy as failure-path provenance (absent when unknown). */
export function traceOf(input: GateApprovalInput): GateApprovalTrace {
    return input.hostPolicy === undefined ? {} : { hostPolicy: input.hostPolicy }
}

/**
 * The single fail-closed result builder.
 *
 * Every failure path ends here, which is why `allowed` can never be set by
 * anything but the one success branch in
 * {@link module:dsh-eng-core/gate-approval/verdict}.
 * @param code - the machine-readable reason.
 * @param message - the sentence a human reads.
 * @param trace - provenance (never the verdict).
 */
export function problem(code: GateApprovalProblem, message: string, trace: GateApprovalTrace = {}): GateApprovalResult {
    return { outcome: 'no-answerer', allowed: false, by: '', problem: message, problemCode: code, at: Date.now(), ...trace }
}

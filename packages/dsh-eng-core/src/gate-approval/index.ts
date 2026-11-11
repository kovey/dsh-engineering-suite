/**
 * The gate-authorisation kernel's public face.
 *
 * `dsh-eng-core` re-exports this module, so the names below are the package's
 * public gate-approval API. They are the SAME 22 names the single-file module
 * used to export — the split is structural only:
 *
 *  - {@link module:dsh-eng-core/gate-approval/types} — the vocabulary (five
 *    outcomes, the declared surface, the input/result shapes);
 *  - {@link module:dsh-eng-core/gate-approval/words} — the words a binary
 *    channel may answer with, and the one mapping from word to decision;
 *  - {@link module:dsh-eng-core/gate-approval/policy} — the structural reader of
 *    the host's approval policy (read, never obeyed);
 *  - {@link module:dsh-eng-core/gate-approval/decide} — {@link requestGateApproval},
 *    the single entry: one decision, two surfaces, no auto branch;
 *  - {@link module:dsh-eng-core/gate-approval/text} — one sentence per outcome
 *    plus the two predicates a caller should use.
 *
 * Internal helpers (the surface-attempt normaliser, the copy shared by the
 * fallback paths) stay out of this barrel: a caller must go through
 * {@link requestGateApproval} and {@link describeGateApproval}, not around them.
 *
 * @module dsh-eng-core/gate-approval
 */

export * from './types.js'
export * from './words.js'
export * from './policy.js'
export { describeGateApproval, gateApprovalAllowed, approvalSourceOfVia } from './text.js'
export { requestGateApproval } from './decide.js'

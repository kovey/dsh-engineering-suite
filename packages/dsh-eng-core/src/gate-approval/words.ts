/**
 * The words a binary channel may answer with, and the ONE mapping from a word to
 * a decision.
 *
 * A channel's free text is not a decision: anything unrecognised yields
 * `undefined`, and guessing one is how "nobody answered" becomes "approved".
 * Keeping the vocabulary in one module means a new surface cannot quietly widen
 * what counts as "yes".
 *
 * @module dsh-eng-core/gate-approval/words
 */

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

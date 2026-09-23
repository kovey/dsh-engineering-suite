/**
 * The approval seam, shared by every gate in the suite.
 *
 * Until now each plugin declared its own structural `ApprovalLike` and treated
 * the reply as one of four strings. That is enough for a terminal popup and not
 * enough for IM: when a decision arrives as a *card click* on someone's phone,
 * the ledger has to record **who** clicked, **which message** carried the card,
 * and **where** it happened — an audit trail that says `approvedBy: "approval"`
 * cannot answer "who let this through?".
 *
 * So the contract is extended, not broken:
 *
 *  - an answerer MAY return the old string (`'allowed-once'`), and nothing
 *    changes for it;
 *  - an answerer MAY return an object carrying provenance, and every consumer
 *    records it through {@link normalizeApprovalReply} — one normaliser, so no
 *    plugin can forget a field;
 *  - `cancelled`/`unavailable` stay fail-closed everywhere: "nobody decided" is
 *    never a pass.
 *
 * The second half of this module is the **approval context block**: the reason a
 * card shows is a string, but an IM card wants fields (mission, revision,
 * artifact paths, risk). The suite embeds a fenced JSON block inside its reason;
 * the channel layer may parse and render it, and a terminal answerer that does
 * not care simply shows the prose around it.
 *
 * @module dsh-eng-core/approval
 */

/** The four decisions an answerer can express. */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** A reply from an answerer: the legacy string, or a string plus provenance. */
export type ApprovalReply =
    | ApprovalDecision
    | {
          decision: ApprovalDecision
          /** Who decided — an IM user id, a terminal user, `auto`. */
          by?: string
          /** Channel-side message id (the card), for the audit trail. */
          messageId?: string
          /** When the decision was made (epoch ms; the channel's clock). */
          at?: number
          /** Which surface decided: `im` / `tui` / `auto` / `seam`. */
          source?: string
      }

/** What every gate passes to the seam. */
export interface ApprovalRequest {
    /** The agent the decision is about, when the host passes one. */
    agent?: unknown
    /** The tool that is asking. */
    toolName: string
    /** Human-readable reason; may embed an {@link APPROVAL_CONTEXT_FENCE} block. */
    reason: string
    signal?: AbortSignal
}

/** Minimal structural view of `ctx.get('approval')`, identical in every plugin. */
export interface ApprovalLike {
    request(request: ApprovalRequest): Promise<ApprovalReply>
}

/** The normalised form every consumer records. */
export interface ApprovalOutcome {
    decision: ApprovalDecision
    /** Empty when the answerer did not say who decided. */
    by: string
    messageId: string
    at?: number
    source: string
    /** `true` only for `allowed-once`; kept so call sites cannot misread it. */
    allowed: boolean
}

/** The fence a reason uses to carry machine-readable fields. */
export const APPROVAL_CONTEXT_FENCE = 'approval-context'

/** Fields an IM card can render. All optional: a caller sends what it has. */
export interface ApprovalContext {
    /** What kind of decision this is: `spec` / `delivery` / `standards` / `dependency` / `command`. */
    kind?: string
    missionId?: string
    title?: string
    /** Spec revision or digest the decision is bound to. */
    revision?: number | string
    /** Risk label the caller computed (`low`/`medium`/`high`). */
    risk?: string
    /** Artifacts a reviewer may want to read, workspace-relative. */
    artifacts?: string[]
    /** Short key/value lines the card shows verbatim. */
    facts?: Record<string, string | number>
    /** Anything the channel should NOT show (kept out of the rendered text). */
    channelHints?: { buttons?: string[]; requiresReason?: boolean }
}

const KNOWN_DECISIONS: readonly ApprovalDecision[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * Normalise whatever an answerer returned.
 *
 * An unknown shape is treated as `unavailable` — fail closed — because guessing a
 * decision from an unreadable reply is exactly how "nobody answered" becomes
 * "approved".
 * @param reply - the answerer's return value (untrusted: it crosses the plugin seam).
 */
export function normalizeApprovalReply(reply: unknown): ApprovalOutcome {
    if (typeof reply === 'string') {
        const decision = (KNOWN_DECISIONS as readonly string[]).includes(reply) ? (reply as ApprovalDecision) : 'unavailable'
        return {
            decision,
            by: '',
            messageId: '',
            source: decision === 'unavailable' ? 'unknown' : '',
            allowed: decision === 'allowed-once',
        }
    }
    if (typeof reply === 'object' && reply !== null) {
        const record = reply as Record<string, unknown>
        const raw = record['decision']
        const decision =
            typeof raw === 'string' && (KNOWN_DECISIONS as readonly string[]).includes(raw) ? (raw as ApprovalDecision) : 'unavailable'
        const by = typeof record['by'] === 'string' ? record['by'] : ''
        const messageId = typeof record['messageId'] === 'string' ? record['messageId'] : ''
        const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : undefined
        const source = typeof record['source'] === 'string' && record['source'] !== '' ? record['source'] : 'unknown'
        return { decision, by, messageId, ...(at === undefined ? {} : { at }), source, allowed: decision === 'allowed-once' }
    }
    return { decision: 'unavailable', by: '', messageId: '', source: 'unknown', allowed: false }
}

/**
 * Render the reason a card shows: prose plus an embedded context block.
 *
 * The block is fenced so the text stays readable for a plain answerer, and JSON
 * (not YAML or a bespoke format) so a parser cannot disagree with a writer about
 * whitespace.
 * @param prose - the human-readable reason.
 * @param context - the machine-readable fields.
 */
export function renderApprovalContext(prose: string, context: ApprovalContext): string {
    const block = JSON.stringify(context, null, 2)
    return `${prose.trimEnd()}\n\n\`\`\`${APPROVAL_CONTEXT_FENCE}\n${block}\n\`\`\`\n`
}

/**
 * Read the context block back out of a reason.
 *
 * A missing or unparsable block returns `undefined` rather than throwing: an
 * answerer that renders only the prose is a supported configuration, not a
 * failure.
 * @param reason - the reason a gate passed to the seam.
 */
export function parseApprovalContext(reason: string): ApprovalContext | undefined {
    const match = new RegExp('```' + APPROVAL_CONTEXT_FENCE + '\\s*\\n([\\s\\S]*?)\\n```').exec(reason)
    if (match === null) return undefined
    try {
        const parsed = JSON.parse(match[1] as string) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
        return parsed as ApprovalContext
    } catch {
        return undefined
    }
}

/**
 * The reason WITHOUT the context block: what a text-only answerer should show.
 * @param reason - the reason a gate passed to the seam.
 */
export function proseOf(reason: string): string {
    return reason.replace(new RegExp('\\n*```' + APPROVAL_CONTEXT_FENCE + '\\s*\\n[\\s\\S]*?\\n```\\n*'), '\n').trim()
}

/**
 * Who to record as the approver.
 *
 * The identity from the channel wins; without one the decision word itself is
 * recorded, so old answerers keep producing the ledger they always did.
 * @param outcome - the normalised reply.
 * @param fallback - what to record when the answerer gave no identity.
 */
export function approverName(outcome: ApprovalOutcome, fallback = 'approval'): string {
    return outcome.by !== '' ? outcome.by : fallback
}

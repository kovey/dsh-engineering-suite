/**
 * The gate-authorisation vocabulary and the shapes the kernel takes and returns.
 *
 * This module exists so the kernel's contract can be read in one place. The
 * rules it encodes are the ones the whole module exists for:
 *
 *  - Five outcomes stay five DISTINCT values ({@link GateApprovalOutcome}):
 *    `rejected` (a person said no), `cancelled` (the question was withdrawn),
 *    `no-answerer` (nobody was asked), `rejected-by-host-policy` (the host seam
 *    refused without dispatching) and `allowed-once` (one named answerer said
 *    yes, once). Merging them is the defect this kernel was written to end.
 *  - A caller DECLARES the presentation ({@link GateSurface}): `rich` (a card
 *    that can show/preview/edit the material) or `binary` (allow/deny). The
 *    kernel never infers one and never downgrades a rich ask to a binary popup.
 *  - The reported `via` ({@link GateApprovalVia}) names which surface actually
 *    carried the decision, so provenance survives every fallback.
 *
 * @module dsh-eng-core/gate-approval/types
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

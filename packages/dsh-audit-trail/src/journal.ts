/**
 * The audit journal: the row contract and the pure shaping helpers.
 *
 * One tool call produces two rows in `<auditDir>/<sessionId>.jsonl`:
 *
 * ```
 * {"phase":"pre",   ts,sessionId,agentId,turn,callId,rootCallId,tool,argsDigest,argsSummary,decision,snapshot?}
 * {"phase":"result",ts,sessionId,agentId,turn,callId,tool,isError,durationMs,resultDigest,resultTail}
 * ```
 *
 * A row carries **digests, never file bodies** (see `redactArgs`). Everything
 * in this module is pure and total: a value the model managed to smuggle in
 * must never be able to throw while the trail is being written.
 *
 * @module dsh-audit-trail/journal
 */

import { appendJsonl, head, readJsonl, sha256, tail } from 'dsh-eng-core'
import { PATH_ARG_KEYS, REDACTED_ARG_KEYS, type AuditTrailConfig } from './config.js'

/** Kind of `PreToolDecision` the call settled on. */
export type DecisionKind = 'allow' | 'deny' | 'ask'

/**
 * What a `pre` row records: the decision `next()` returned, or `error` when the
 * pre-execute chain itself threw (the row is then written from `finally`).
 */
export type RecordedDecision = DecisionKind | 'error'

/**
 * One pre-write snapshot record (attached to the `pre` row of a write call).
 *
 * `reason` is present **iff** no pre-state was captured: such a record is
 * informational only and `audit_rewind` never touches that path. `reason:
 * 'error'` additionally carries `error` — the capture itself threw, so the
 * write is **not** rollbackable and the report must say so instead of blaming
 * the arguments.
 */
export interface SnapshotRecord {
    /** Absolute path of the target file. */
    path: string
    /** Path relative to the session workspace (absolute when outside it). */
    relPath: string
    /** Absolute path of the `.snap` copy; `''` when nothing was saved. */
    snapshotPath: string
    /** Whether the file existed before the write (false ⇒ compensate by delete). */
    existed: boolean
    /** SHA-256 of the pre-write bytes; `''` when nothing was saved. */
    digest: string
    /** Pre-write size in bytes. */
    bytes: number
    /** Pre-write permission bits (`st.mode & 0o7777`); absent on old records. */
    mode?: number
    /** Why no snapshot was taken: `outside-workspace`/`internal`/`oversize`/`quota`/`not-a-file`/`error`. */
    reason?: string
    /** Failure message; present iff `reason === 'error'`. */
    error?: string
}

/** Fields every row carries. */
export interface AuditRowBase {
    /** ISO-8601 UTC timestamp. */
    ts: string
    /** Session that owns the trail (`'unknown'` when the host exposed none). */
    sessionId: string
    /** Agent id (subagents carry their own). */
    agentId?: string
    /** Turn number learned from `agent/pre-step`, when it was seen. */
    turn?: number
    /** Call id of this execution. */
    callId: string
    /** Root model-requested call id. */
    rootCallId?: string
    /** Tool name. */
    tool: string
}

/** The row written by `tools/pre-execute`. */
export interface PreRow extends AuditRowBase {
    phase: 'pre'
    /** SHA-256 of the lossless JSON of the arguments; `''` when unserializable. */
    argsDigest: string
    /** Redacted, truncated, one-line rendering of the arguments. */
    argsSummary: string
    decision: RecordedDecision
    /** Present for write-class calls that target a file. */
    snapshot?: SnapshotRecord
    /** Anomaly marker (`args-unserializable`, `snapshot-failed`, …). */
    note?: string
}

/** The row written by `tools/result`. */
export interface ResultRow extends AuditRowBase {
    phase: 'result'
    isError: boolean
    /** Wall-clock duration between the `pre` row and this row (0 when unknown). */
    durationMs: number
    /** SHA-256 of `JSON.stringify(result.content ?? '')`; `''` when unserializable. */
    resultDigest: string
    /** Bounded tail of the rendered result content. */
    resultTail: string
    /** Anomaly marker. */
    note?: string
}

/** One journal row. */
export type AuditRow = PreRow | ResultRow

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `JSON.stringify` that reports failure instead of throwing.
 * @param value - any value, including one with a hostile `toJSON`.
 * @returns the JSON text, or `undefined` when it cannot be produced.
 */
export function jsonText(value: unknown): string | undefined {
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

/** Digest of a value, or `''` when it cannot be serialized. */
export function digestOf(value: unknown): string {
    const text = jsonText(value)
    return text === undefined ? '' : sha256(text)
}

/** One-line, length-bounded text of a string, with a throwing-`toString` guard. */
function safeText(value: unknown): string {
    try {
        return typeof value === 'string' ? value : String(value)
    } catch {
        return '[unprintable]'
    }
}

/** Collapse a summary to one line so the row stays greppable. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/**
 * Replace one file-body argument value with `<sha256-12>/<len>B`.
 * @param value - the argument value to redact.
 * @returns the redacted marker (never the body).
 */
export function redactValue(value: unknown): string {
    const isText = typeof value === 'string'
    const text = isText ? value : jsonText(value)
    if (text === undefined) return '<unserializable>'
    return `<${sha256(text).slice(0, 12)}/${isText ? `${text.length} chars` : `${text.length} bytes`}>`
}

/**
 * Apply the redaction rule to one arguments object.
 * @param args - parsed tool arguments (untrusted).
 * @returns a shallow copy with the file-body keys replaced, or the input when
 *   it is not a plain record.
 */
export function redactArgs(args: unknown): unknown {
    if (!isRecord(args)) return args
    let touched = false
    const copy: Record<string, unknown> = { ...args }
    for (const key of REDACTED_ARG_KEYS) {
        if (!(key in copy)) continue
        copy[key] = redactValue(copy[key])
        touched = true
    }
    return touched ? copy : args
}

/**
 * Describe the arguments of one call for the `pre` row.
 * @param args - parsed arguments (untrusted; may be unserializable).
 * @param config - resolved configuration (`redactArgs`, `maxArgsSummary`).
 * @returns the digest of the raw arguments and the redacted summary.
 */
export function describeArgs(
    args: unknown,
    config: AuditTrailConfig,
): { digest: string; summary: string; unserializable: boolean } {
    const raw = jsonText(args)
    if (raw === undefined) {
        return { digest: '', summary: '[unserializable arguments]', unserializable: true }
    }
    const visible = config.redactArgs ? redactArgs(args) : args
    const rendered = jsonText(visible) ?? jsonText(safeText(visible)) ?? '[unserializable arguments]'
    return { digest: sha256(raw), summary: oneLine(head(rendered, config.maxArgsSummary)), unserializable: false }
}

/** Render tool-result content blocks to plain text (never throws). */
export function contentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === 'string') return block
                if (isRecord(block) && typeof block['text'] === 'string') return block['text']
                return jsonText(block) ?? '[unrenderable block]'
            })
            .join('\n')
    }
    if (content === undefined || content === null) return ''
    return jsonText(content) ?? safeText(content)
}

/**
 * Describe one settled tool result for the `result` row.
 * @param result - the `ToolExecutionResult` seen by `tools/result`.
 * @param config - resolved configuration (`maxResultTail`).
 * @returns the failure flag, the content digest and the bounded tail.
 */
export function describeResult(
    result: unknown,
    config: AuditTrailConfig,
): { isError: boolean; digest: string; tail: string } {
    const record = isRecord(result) ? result : {}
    const content = record['content']
    // Contract: sha256 over the lossless JSON of the content blocks.
    const digest = digestOf(content ?? '')
    return {
        isError: record['isError'] === true,
        digest,
        // Tail-shaped like a log line: the end of a long result is what matters.
        tail: tail(contentText(content), config.maxResultTail),
    }
}

/** Read a journal file, keeping only well-formed rows. */
export function readRows(file: string): AuditRow[] {
    const rows: AuditRow[] = []
    for (const entry of readJsonl<unknown>(file)) {
        if (!isRecord(entry)) continue
        const phase = entry['phase']
        if (phase !== 'pre' && phase !== 'result') continue
        rows.push(entry as unknown as AuditRow)
    }
    return rows
}

/** Append one row to a session's journal (never throws). */
export function appendRow(file: string, row: AuditRow): boolean {
    try {
        appendJsonl(file, row)
        return true
    } catch {
        return false
    }
}

/** Extract the first present file-target argument. */
export function targetPathOf(args: unknown): string | undefined {
    if (!isRecord(args)) return undefined
    for (const key of PATH_ARG_KEYS) {
        const value = args[key]
        if (typeof value === 'string' && value !== '') return value
    }
    return undefined
}

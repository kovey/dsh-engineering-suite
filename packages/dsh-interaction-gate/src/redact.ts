/**
 * Outgoing-payload redaction: a payload that would leak a credential is REFUSED.
 *
 * The suite's discipline (see `dsh-supply-chain-gate`) is that a discovered
 * secret is never echoed, never written, and never silently sent. This module
 * applies the same discipline to everything the interaction layer hands to a
 * channel, with three decisions worth stating:
 *
 *  1. **Refuse, never sanitise.** A `send` whose title/body/context matches a
 *     credential rule does not go out "with the secret masked": the ask fails
 *     and the model is told which rule matched where. A masked message still
 *     leaks the fact that a secret was there, and — worse — a human would answer
 *     a card the plugin never wanted to show them.
 *  2. **A local, small rule set.** The suite's full detector (11 rules + entropy
 *     scoring + an allowlist) lives in `dsh-supply-chain-gate` and is deliberately
 *     NOT imported: an interaction layer that ships a scanner must not depend on
 *     a plugin a profile may not have loaded. The subset below covers the
 *     credential SHAPES that must never reach a chat; it is a net, not a proof,
 *     and `redactPatterns` exists so a repository can add its own shapes.
 *  3. **Excerpts are redacted, fingerprints are not.** A report says which rule
 *     matched, at which character, with an excerpt of 4 + 2 characters and the
 *     SHA-256 of the value, so a human can correlate two reports without either
 *     one carrying the secret.
 *
 * `dsh-eng-core`'s approval-context helpers are reused rather than reinvented:
 * the outgoing card body is the ```approval-context``` block (see
 * {@link renderApprovalContext}), so the whole rendered block — facts, artifact
 * paths, title — is scanned, not just the prose.
 *
 * @module dsh-interaction-gate/redact
 */

import { renderApprovalContext, type ApprovalContext } from 'dsh-eng-core'
import { fingerprintOf } from './ledger.js'

/** How bad a match is. Refusal does not depend on it: every hit refuses. */
export type SecretSeverity = 'critical' | 'high' | 'medium'

/** One detection rule. */
export interface SecretRule {
    id: string
    severity: SecretSeverity
    /** Applied to the whole field text; `group` selects the secret inside the match. */
    pattern: RegExp
    /** Capture group holding the secret value (default: the whole match). */
    group?: number
    /** What the rule looks for, in Chinese (shown in reports). */
    description: string
}

/**
 * The local rule set.
 *
 * Order matters only for naming (the first rule that matches names the hit);
 * every rule in the list refuses the payload, so the order cannot change the
 * verdict — only the label a human reads.
 */
export const OUTGOING_SECRET_RULES: readonly SecretRule[] = [
    {
        id: 'aws-access-key-id',
        severity: 'critical',
        pattern: /\bAKIA[0-9A-Z]{16}\b/,
        description: 'AWS access key id（AKIA + 16 位）',
    },
    {
        id: 'github-token',
        severity: 'critical',
        pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
        description: 'GitHub token（ghp_/gho_/ghu_/ghs_/ghr_）',
    },
    {
        id: 'slack-token',
        severity: 'critical',
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/,
        description: 'Slack token（xox?-）',
    },
    {
        id: 'provider-api-key',
        severity: 'critical',
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
        description: 'API key（sk- [proj-] + 16 位以上）',
    },
    {
        id: 'google-api-key',
        severity: 'high',
        pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/,
        description: 'Google API key（AIza + 35 位）',
    },
    {
        id: 'private-key-block',
        severity: 'critical',
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        description: '私钥块开始标记（PEM）',
    },
    {
        id: 'jwt',
        severity: 'high',
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
        description: 'JWT（eyJ… 三段式）',
    },
    {
        id: 'bearer-token',
        severity: 'high',
        pattern: /\bBearer\s+([A-Za-z0-9._-]{20,})/,
        group: 1,
        description: 'Authorization: Bearer <token>',
    },
    {
        id: 'generic-secret-assignment',
        severity: 'medium',
        pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*:?=\s*["']([^"']{8,})["']/i,
        group: 1,
        description: '通用赋值（password/passwd/secret/token/api_key = "…"）',
    },
]

/**
 * Values that LOOK like the generic rule but are documentation.
 *
 * Narrow on purpose and applied ONLY to the medium rule: `PASSWORD="changeme"`
 * in a README is a documented shape, not a credential. A high-confidence shape
 * (an `AKIA…` id, a PEM header) is never exempted.
 */
const PLACEHOLDER_PATTERN =
    /^(?:<.*>|\$\{.*\}|\$[A-Za-z_][A-Za-z0-9_]*|x{3,}|\*{3,}|\.{3,}|(?:your|my)[-_]?.*|.*[-_](?:here|placeholder|example|dummy|sample|test|fake|redacted|changeme)|changeme|change[-_]?me|placeholder|example|dummy|sample|redacted|none|null|true|false|todo|fixme)$/i

/** Whether a low-confidence match is a documented placeholder rather than a secret. */
export function looksLikePlaceholder(value: string): boolean {
    const trimmed = value.trim()
    if (trimmed === '') return true
    if (PLACEHOLDER_PATTERN.test(trimmed)) return true
    // A single repeated character (`xxxxxxxx`) carries no information to leak.
    return new Set(trimmed).size <= 2
}

/** Redact a secret for display: first 4 + last 2 characters and the length. */
export function redactSecret(value: string): string {
    if (value.length <= 6) return `***（长度 ${value.length}，太短不展示）`
    return `${value.slice(0, 4)}…${value.slice(-2)}（长度 ${value.length}）`
}

/** One detection. `excerpt` is REDACTED; the raw value is never part of a hit. */
export interface SecretHit {
    rule: string
    severity: SecretSeverity
    /** The outgoing field it was found in (`title` / `body` / `options` / `context:facts.x`). */
    field: string
    /** Character offset inside that field. */
    index: number
    /** Redacted excerpt (never the raw value). */
    excerpt: string
    /** SHA-256 of the raw value, so two reports can be correlated without it. */
    fingerprint: string
}

/**
 * Scan one text with a rule set. Pure and deterministic.
 * @param text - the text to scan.
 * @param field - the field name recorded with each hit.
 * @param rules - the rules (defaults to the built-in set).
 */
export function scanText(text: string, field: string, rules: readonly SecretRule[] = OUTGOING_SECRET_RULES): SecretHit[] {
    const hits: SecretHit[] = []
    if (text === '') return hits
    for (const rule of rules) {
        // A rule with `g` is fine; we only need the first match per rule per field.
        const match = rule.pattern.exec(text)
        if (match === null) continue
        const value = (rule.group === undefined ? match[0] : match[rule.group]) ?? match[0]
        if (value === '' || value === undefined) continue
        if (rule.severity === 'medium' && looksLikePlaceholder(value)) continue
        hits.push({
            rule: rule.id,
            severity: rule.severity,
            field,
            index: match.index,
            excerpt: redactSecret(value),
            fingerprint: fingerprintOf(value),
        })
    }
    return hits
}

/**
 * Compile the `redactPatterns` config entries.
 *
 * A syntactically invalid pattern is dropped WITH a problem: an unusable pattern
 * must not become "one less thing we refuse".
 * @param patterns - raw sources from configuration.
 */
export function compileRedactPatterns(patterns: readonly string[]): { rules: SecretRule[]; problems: string[] } {
    const rules: SecretRule[] = []
    const problems: string[] = []
    for (let index = 0; index < patterns.length; index += 1) {
        const source = patterns[index] as string
        try {
            rules.push({
                id: `config:redactPatterns[${index}]`,
                severity: 'high',
                pattern: new RegExp(source),
                description: `配置的额外拒绝规则：${source}`,
            })
        } catch {
            problems.push(`配置的 redactPatterns[${index}] 不是合法正则，已忽略：${source}`)
        }
    }
    return { rules, problems }
}

/** One outgoing field (name + text) to check. */
export interface OutgoingField {
    name: string
    text: string
}

/** The verdict for one outgoing payload. */
export interface RedactionVerdict {
    ok: boolean
    hits: SecretHit[]
    problems: string[]
}

/**
 * Check an outgoing payload.
 * @param fields - every string that would leave the process.
 * @param extraRules - compiled `redactPatterns` (may be empty).
 */
export function checkOutgoing(fields: readonly OutgoingField[], extraRules: readonly SecretRule[] = []): RedactionVerdict {
    const rules = extraRules.length === 0 ? OUTGOING_SECRET_RULES : [...OUTGOING_SECRET_RULES, ...extraRules]
    const hits: SecretHit[] = []
    for (const field of fields) hits.push(...scanText(field.text, field.name, rules))
    return { ok: hits.length === 0, hits, problems: [] }
}

/**
 * Check the approval-context block a card renders.
 *
 * The block travels INSIDE the body, so it is scanned in the form the channel
 * receives it (rendered by `dsh-eng-core`), with each top-level field named
 * separately so a report can say where the hit was.
 * @param context - the context fields the caller supplied.
 * @param extraRules - compiled `redactPatterns`.
 */
export function scanApprovalContext(context: ApprovalContext, extraRules: readonly SecretRule[] = []): RedactionVerdict {
    const rules = extraRules.length === 0 ? OUTGOING_SECRET_RULES : [...OUTGOING_SECRET_RULES, ...extraRules]
    const hits: SecretHit[] = []
    const fields: [string, string][] = []
    if (context.kind !== undefined) fields.push(['context.kind', context.kind])
    if (context.missionId !== undefined) fields.push(['context.missionId', context.missionId])
    if (context.title !== undefined) fields.push(['context.title', context.title])
    if (context.revision !== undefined) fields.push(['context.revision', String(context.revision)])
    if (context.risk !== undefined) fields.push(['context.risk', context.risk])
    for (const artifact of context.artifacts ?? []) fields.push(['context.artifacts', artifact])
    for (const [key, value] of Object.entries(context.facts ?? {})) fields.push([`context.facts.${key}`, String(value)])
    if (context.channelHints !== undefined) fields.push(['context.channelHints', JSON.stringify(context.channelHints)])
    for (const [name, text] of fields) hits.push(...scanText(text, name, rules))
    // The rendered block itself, as a last net over separators/JSON framing.
    hits.push(...scanText(renderApprovalContext('', context), 'context', rules))
    const unique = new Map<string, SecretHit>()
    for (const hit of hits) unique.set(`${hit.rule}|${hit.field}|${hit.index}`, hit)
    return { ok: unique.size === 0, hits: [...unique.values()], problems: [] }
}

/** One Chinese line per hit: rule, where it hit, redacted excerpt, fingerprint. */
export function describeHits(hits: readonly SecretHit[], extraRules: readonly SecretRule[] = []): string[] {
    const descriptions = new Map<string, string>()
    for (const rule of [...OUTGOING_SECRET_RULES, ...extraRules]) descriptions.set(rule.id, rule.description)
    return hits.map((hit) => {
        const what = descriptions.get(hit.rule)
        return (
            `- ${hit.rule}${what === undefined ? '' : `（${what}）`} 命中字段 ${hit.field} 第 ${hit.index} 字符：` +
            `${hit.excerpt}，指纹 ${hit.fingerprint.slice(0, 16)}…`
        )
    })
}

/** Bounded text: the caller's payload must not be able to push an unbounded message. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false }
    return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
}

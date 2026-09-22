/**
 * The secret detector: PURE, no I/O, deterministic.
 *
 * Design rules this module follows, because a secret scanner that leaks or lies
 * is worse than none:
 *
 *  1. **A discovered secret is never echoed.** Every finding carries a REDACTED
 *     excerpt (first 4 + last 2 characters + the length) plus the SHA-256
 *     fingerprint of the value. The raw value lives only in the scanned buffer.
 *  2. **A hash is safe here, a raw value is not.** The fingerprint is an
 *     unsalted SHA-256 of a value the detector already decided is
 *     secret-shaped — typically ≥ 20 random-looking characters, so it is not
 *     brute-forceable — and its only job is to let a report, an artifact and an
 *     allowlist refer to the *same* secret without storing it. That is why
 *     allowlist `values` are hashes: a committed allowlist file that contained
 *     the raw secret would be the leak it is supposed to suppress.
 *  3. **Detection is a net, not a proof** (see the README's honest limits):
 *     regexes miss a secret that looks like ordinary text, and entropy flags a
 *     long random-looking identifier that is not a secret. A clean scan means
 *     "nothing matched", never "no secret exists".
 *  4. **Silence is never an outcome**: an unparseable allowlist, or an
 *     allowlist entry with no condition, is reported as a problem and does NOT
 *     suppress anything.
 *
 * @module dsh-supply-chain-gate/secrets
 */

import { createHash } from 'node:crypto'
import { globToRegExp } from 'dsh-eng-core'

/** How bad a match is. Redaction and the gate verdict do not depend on it. */
/**
 * `critical`/`high`: a known credential SHAPE — blocking by default.
 * `medium`: an assignment that looks like a secret — reported, not blocking by
 * default (test fixtures and config templates live here).
 * `low`/`info`: advisory. `low` is a high-entropy literal in a secret-ish
 * context, `info` one without any context — measured on a real repository, the
 * unqualified entropy rule produced 461 hits in 120 files (README base64 blobs),
 * and a gate that noisy gets switched off, which protects nothing.
 */
export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** One detection rule. */
export interface SecretRule {
    /** Stable id, used by the allowlist and by the report. */
    id: string
    severity: SecretSeverity
    /** Pattern applied per line; `group` selects the secret inside the match. */
    pattern: RegExp
    /** Capture group holding the secret value (default: the whole match). */
    group?: number
    /** What the rule looks for, in Chinese (shown in reports). */
    description: string
}

/**
 * The rule set.
 *
 * ORDER MATTERS, for one reason: when two rules match the same value on the
 * same line, the FIRST one names the finding and the rest are recorded as
 * `alsoMatched`. Specific rules therefore come before generic ones, and
 * `deepseek-api-key` (a `sk-` + 32 hex shape) before the looser `openai-api-key`.
 */
export const SECRET_RULES: readonly SecretRule[] = [
    {
        id: 'aws-access-key-id',
        severity: 'critical',
        pattern: /\bAKIA[0-9A-Z]{16}\b/,
        description: 'AWS access key id（AKIA + 16 位）',
    },
    {
        id: 'aws-secret-access-key',
        severity: 'critical',
        // The assignment form only: a bare 40-char base64 blob is far too common
        // to flag, and the entropy rule already covers the file-shaped case.
        pattern: /aws[a-z0-9_\-.]{0,20}?(?:secret|private)[a-z0-9_\-.]{0,20}?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/i,
        group: 1,
        description: 'AWS secret access key（赋值形式）',
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
        id: 'deepseek-api-key',
        severity: 'critical',
        pattern: /\bsk-[a-f0-9]{32}\b/,
        description: 'DeepSeek API key（sk- + 32 位十六进制）',
    },
    {
        id: 'openai-api-key',
        severity: 'critical',
        // The documented shape is `sk-[A-Za-z0-9]{20,}`; `proj-` is included
        // because that is the shape the live keys actually have today (a
        // superset of the documented pattern, never a narrower one).
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/,
        description: 'OpenAI API key（sk- [proj-] + 20 位以上）',
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
        description: '私钥块开始标记（PEM）——正文本身不会被读取或展示',
    },
    {
        id: 'jwt',
        severity: 'high',
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
        description: 'JWT（eyJ… 三段式）',
    },
    {
        id: 'generic-secret-assignment',
        severity: 'medium',
        // `:?=` accepts Go's `:=` and YAML's `:` alongside `=`: on a real Go
        // repository the short declaration is the common form, and a rule that
        // only understood `=` missed it.
        pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*:?=\s*["']([^"']{8,})["']/i,
        group: 1,
        description: '通用赋值（password/passwd/secret/token/api_key = "…"）',
    },
    {
        id: 'high-entropy-string',
        severity: 'low',
        pattern: /[A-Za-z0-9+/_=-]{20,}/,
        description: '长且高熵的字面量（熵阈值可配置）',
    },
]

/** The id of the entropy rule (tests and reports refer to it by name). */
export const ENTROPY_RULE_ID = 'high-entropy-string'

/** Shortest candidate the entropy rule considers. */
export const ENTROPY_MIN_LENGTH = 20

/**
 * Values that LOOK like secrets to the generic rule but are not.
 *
 * Narrow on purpose, and applied only to the low-confidence rules: a placeholder
 * that reaches a real secret scanner usually means the developer documented the
 * shape (`PASSWORD="changeme"`), and flagging it would train people to turn the
 * gate off. A high-confidence shape (an `AKIA…` id, a PEM header) is NEVER
 * exempted by this list.
 */
const PLACEHOLDER_PATTERN =
    /^(?:<.*>|\$\{.*\}|\$[A-Za-z_][A-Za-z0-9_]*|x{3,}|\*{3,}|\.{3,}|(?:your|my)[-_]?.*|.*[-_](?:here|placeholder|example|dummy|sample|test|fake|redacted|changeme)|changeme|change[-_]?me|placeholder|example|dummy|sample|redacted|none|null|true|false|todo|fixme|secret|password|token|apikey|api[-_]?key)$/i

/** Whether a low-confidence match is a documented placeholder rather than a secret. */
/**
 * Whether a candidate is a slash/dash-joined list of words rather than a token.
 *
 * Measured: `AWS/GitHub/Slack/OpenAI/DeepSeek/Google` scores 4.16 bits/char,
 * slightly ABOVE a real base64 image fragment (4.15) and below an English
 * sentence (4.39) — entropy alone does not separate secrets from prose, so the
 * shape check does the work: a path-ish list of purely alphabetic segments is
 * documentation, not a credential.
 */
export function looksLikeWordList(value: string): boolean {
    const segments = value.split(/[/_-]/).filter((segment) => segment !== '')
    if (segments.length < 3) return false
    return segments.every((segment) => /^[A-Za-z]{2,}$/.test(segment))
}

export function looksLikePlaceholder(value: string): boolean {
    const trimmed = value.trim()
    if (trimmed === '') return true
    if (PLACEHOLDER_PATTERN.test(trimmed)) return true
    // A single repeated character (`xxxxxxxx`) has no information to leak.
    return new Set(trimmed).size <= 2
}

/** Shannon entropy in bits per character (0 for an empty string). */
export function shannonEntropy(value: string): number {
    if (value === '') return 0
    const counts = new Map<string, number>()
    for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
    let entropy = 0
    for (const count of counts.values()) {
        const probability = count / value.length
        entropy -= probability * Math.log2(probability)
    }
    return entropy
}

/** SHA-256 (hex) of a secret value: the ONLY form in which a secret is stored. */
export function fingerprintOf(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Redact a secret for display: first 4 + last 2 characters and the length.
 * Values too short to redact meaningfully are shown as `***`.
 * @param value - the raw secret.
 */
export function redactSecret(value: string): string {
    const length = value.length
    if (length <= 6) return `***（长度 ${length}，太短不展示）`
    return `${value.slice(0, 4)}…${value.slice(-2)}（长度 ${length}）`
}

/** One line range that was ADDED by the change (1-based inclusive). */
export type AddedRange = readonly [number, number]

/** Whether a 1-based line number falls inside any added range. */
export function lineInRanges(line: number, ranges: readonly AddedRange[]): boolean {
    return ranges.some(([start, end]) => line >= start && line <= end)
}

/** One finding. `excerpt` is REDACTED; the raw value is never part of a finding. */
export interface SecretFinding {
    rule: string
    path: string
    /** 1-based line number. */
    line: number
    /** 1-based column of the match inside the line. */
    column: number
    severity: SecretSeverity
    /** Redacted excerpt — never the secret itself. */
    excerpt: string
    /** SHA-256 of the raw value (the allowlist's `values` form). */
    hash: string
    /** Present for `high-entropy-string` findings. */
    entropy?: number
    /** Other rules that matched the same value on the same line. */
    alsoMatched?: string[]
    /** What the naming rule looks for. */
    description: string
}

/** Input of {@link scanText}. */
export interface ScanTextInput {
    /** Workspace-relative path, copied into every finding. */
    path: string
    text: string
    /**
     * Scan ONLY these added line ranges (the "did this change introduce it"
     * question). Omitted = scan every line (whole-file scan).
     */
    addedRanges?: readonly AddedRange[]
    /** Rule set override (tests); defaults to {@link SECRET_RULES}. */
    rules?: readonly SecretRule[]
    /** Entropy threshold for `high-entropy-string` (default 4.0). */
    entropyThreshold?: number
    /**
     * Whether this path is a credential-ish file (`.env*`, `*.pem`, `*.key`,
     * `id_rsa*`, `credentials*`, `*.tfvars`, `secrets*`). An entropy hit there is
     * `low` (advisory) instead of `info`: the file's whole purpose is secrets.
     */
    credentialFile?: boolean
}

/** Paths whose entire purpose is holding a credential. */
export function isCredentialPath(file: string): boolean {
    const base = file.split('/').pop() ?? file
    return (
        /^\.env/.test(base) ||
        /\.(pem|key|p12|pfx|jks|keystore)$/i.test(base) ||
        /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
        /^credentials?(\.|$)/i.test(base) ||
        /\.tfvars$/i.test(base) ||
        /^secrets?(\.|$)/i.test(base)
    )
}

/**
 * Whether a literal sits in a secret-ish assignment.
 *
 * `token = "…"`, `"api_key": "…"`, `Authorization: Bearer …` — the context that
 * separates "a key someone pasted" from "a base64 blob in a document".
 * @param line - the full source line.
 * @param value - the literal, as matched.
 */
export function hasSecretContext(line: string, value: string): boolean {
    const index = line.indexOf(value)
    if (index <= 0) return false
    const before = line.slice(0, index)
    const assignment = /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|signature|salt)\s*:?=\s*["'`]?[^"'`]*$/i.test(
        before,
    )
    // `Authorization: Bearer <token>` has no `=`: the scheme IS the context.
    const scheme = /(?:^|[\s"'`])(?:bearer|basic)\s+[^\s"'`]*$/i.test(before)
    return assignment || scheme
}

/** One allowlist entry (see the README for the file format). */
export interface AllowlistEntry {
    /** Rule ids this entry covers; omitted = any rule. */
    rules?: string[]
    /** Path globs / directory prefixes this entry covers; omitted = any path. */
    paths?: string[]
    /** SHA-256 fingerprints (or, for convenience, raw values) covered. */
    values?: string[]
    /** ISO date (or `YYYY-MM-DD`) after which the entry no longer applies. */
    until?: string
    /** Why the entry exists (shown by `supply_chain_status`). */
    note?: string
    /** 1-based position in the file, for report/status lines. */
    index: number
}

/** A parsed allowlist plus the problems found while parsing it. */
export interface SecretAllowlist {
    entries: AllowlistEntry[]
    /** Malformed / refused entries. Never silent: a refused entry suppresses nothing. */
    problems: string[]
}

/** An expired or malformed entry is not an allowlist entry. */
export const EMPTY_ALLOWLIST: SecretAllowlist = { entries: [], problems: [] }

/** Local midnight-free `YYYY-MM-DD` handling: the whole day counts as "until". */
function deadlineOf(until: string): number | undefined {
    const text = until.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const end = Date.parse(`${text}T23:59:59.999Z`)
        return Number.isNaN(end) ? undefined : end
    }
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Parse an allowlist file body.
 *
 * Semantics (documented in the README): an entry applies when EVERY dimension it
 * names matches (rules AND paths AND values) and its `until` has not passed. An
 * entry that names no dimension at all is REFUSED — an unconditional entry would
 * switch the detector off from a file the model cannot write but a reviewer
 * might not notice.
 * @param input - the parsed JSON (untrusted).
 * @param now - epoch ms used for expiry (tests).
 * @returns the entries that apply and the problems encountered.
 */
export function parseAllowlist(input: unknown, now: number = Date.now()): SecretAllowlist {
    const problems: string[] = []
    if (input === undefined || input === null) return { entries: [], problems }
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { entries: [], problems: ['allowlist 顶层必须是对象（{ "entries": [...] }）'] }
    }
    const raw = input as Record<string, unknown>
    const list = raw['entries']
    if (list === undefined) {
        // A bare array is a common mistake worth naming precisely.
        if (Array.isArray(raw)) return { entries: [], problems: ['allowlist 顶层必须是对象而不是数组'] }
        return { entries: [], problems: ['allowlist 缺少 "entries" 数组'] }
    }
    if (!Array.isArray(list)) return { entries: [], problems: ['allowlist.entries 必须是数组'] }

    const entries: AllowlistEntry[] = []
    for (const [position, item] of list.entries()) {
        const index = position + 1
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            problems.push(`entries[${position}]: 必须是对象`)
            continue
        }
        const entry = item as Record<string, unknown>
        const rules = stringList(entry['rules'])
        const paths = stringList(entry['paths'])
        const values = stringList(entry['values'])
        if (entry['rules'] !== undefined && rules === undefined) {
            problems.push(`entries[${position}]: rules 必须是"非空字符串"数组`)
            continue
        }
        if (entry['paths'] !== undefined && paths === undefined) {
            problems.push(`entries[${position}]: paths 必须是"非空字符串"数组`)
            continue
        }
        if (entry['values'] !== undefined && values === undefined) {
            problems.push(`entries[${position}]: values 必须是"非空字符串"数组`)
            continue
        }
        if (rules === undefined && paths === undefined && values === undefined) {
            problems.push(
                `entries[${position}]: 没有任何 rules/paths/values 条件 —— 这样的条目等于关掉整个检测，已拒绝`,
            )
            continue
        }
        for (const value of values ?? []) {
            if (isRawAllowlistValue(value)) {
                // Never a refusal (the comparison still works, in memory), but the
                // file itself is where a raw secret would end up leaking — and a
                // committed allowlist is exactly what the detector protects.
                problems.push(
                    `entries[${position}]: values 里有一项看起来是明文而不是 sha256 指纹 —— 仍会按哈希比较（明文不会被本插件写入任何产物），但建议替换为报告里该 secret 的 hash 字段`,
                )
            }
        }
        let until: string | undefined
        if (entry['until'] !== undefined) {
            if (typeof entry['until'] !== 'string' || entry['until'].trim() === '') {
                problems.push(`entries[${position}]: until 必须是 ISO 日期字符串`)
                continue
            }
            until = entry['until'].trim()
            const deadline = deadlineOf(until)
            if (deadline === undefined) {
                // An unparseable expiry must not become a permanent exemption.
                problems.push(`entries[${position}]: until "${until}" 无法解析为日期，该条目已忽略（不会永久生效）`)
                continue
            }
            if (now > deadline) {
                problems.push(`entries[${position}]: 已于 ${until} 过期，已忽略（过期不等于永久豁免）`)
                continue
            }
        }
        entries.push({
            ...(rules === undefined ? {} : { rules }),
            ...(paths === undefined ? {} : { paths }),
            ...(values === undefined ? {} : { values }),
            ...(until === undefined ? {} : { until }),
            ...(typeof entry['note'] === 'string' && entry['note'].trim() !== '' ? { note: entry['note'].trim() } : {}),
            index,
        })
    }
    return { entries, problems }
}

function stringList(value: unknown): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) return undefined
    const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    return list.length === 0 ? undefined : list
}

/** Whether one allowlist entry covers a finding. */
export function entryCovers(entry: AllowlistEntry, finding: SecretFinding): boolean {
    if (entry.rules !== undefined && !entry.rules.includes(finding.rule)) return false
    if (entry.paths !== undefined && !entry.paths.some((pattern) => pathMatches(pattern, finding.path))) return false
    if (entry.values !== undefined) {
        // Hashed comparison only: a 64-hex entry is a fingerprint, anything else
        // is hashed in memory here (never stored, never echoed) so a human can
        // paste the value they see in their file and be told to replace it.
        const matched = entry.values.some((value) => {
            const candidate = /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : fingerprintOf(value)
            return candidate === finding.hash
        })
        if (!matched) return false
    }
    return true
}

/**
 * Path matching for allowlist entries: a glob (`globToRegExp`), an exact path, or
 * a directory prefix (`test/` covers `test/**`).
 */
export function pathMatches(pattern: string, path: string): boolean {
    const cleaned = pattern.trim().replace(/^\.\//, '')
    if (cleaned === '') return false
    if (cleaned === path) return true
    const directory = cleaned.replace(/\/+$/, '')
    if (directory !== '' && path.startsWith(`${directory}/`)) return true
    if (cleaned.includes('*') || cleaned.includes('?')) {
        try {
            return globToRegExp(cleaned).test(path)
        } catch {
            return false
        }
    }
    return false
}

/** The entry that allows a finding, when one does. */
export function allowlistedBy(entries: readonly AllowlistEntry[], finding: SecretFinding): AllowlistEntry | undefined {
    return entries.find((entry) => entryCovers(entry, finding))
}

/** Whether a `values` entry looks like a raw secret rather than a fingerprint. */
export function isRawAllowlistValue(value: string): boolean {
    return !/^[0-9a-f]{64}$/i.test(value.trim())
}

/** Compile a rule into a fresh global regex (never shares `lastIndex` state). */
function matcherFor(rule: SecretRule): RegExp {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
    return new RegExp(rule.pattern.source, flags)
}

/**
 * Scan one text (or the added lines of one text) for secrets.
 *
 * Deterministic: rules run in {@link SECRET_RULES} order, findings are sorted by
 * line then column then rule id, and a value matched by several rules produces
 * ONE finding naming the first rule (the others ride along in `alsoMatched`).
 * @param input - path, text, optional added ranges, optional overrides.
 * @returns the findings, redacted, sorted, never containing a raw secret.
 */
export function scanText(input: ScanTextInput): SecretFinding[] {
    const rules = input.rules ?? SECRET_RULES
    const threshold = input.entropyThreshold ?? 4.0
    const ranges = input.addedRanges
    const findings: SecretFinding[] = []
    const seen = new Map<string, SecretFinding>()
    // Raw values matched on each line, IN MEMORY ONLY: the entropy rule uses them
    // to avoid reporting the same secret twice under two names (`VAR=AKIA…` is one
    // candidate string that CONTAINS the value the specific rule already caught).
    // They never reach a finding, a report, an artifact or a log.
    const matched: { line: number; value: string }[] = []
    const lines = input.text.split('\n')

    for (const [position, text] of lines.entries()) {
        const line = position + 1
        if (ranges !== undefined && !lineInRanges(line, ranges)) continue
        for (const rule of rules) {
            const entropyRule = rule.id === ENTROPY_RULE_ID
            const matcher = matcherFor(rule)
            for (const match of text.matchAll(matcher)) {
                const value = match[rule.group ?? 0] ?? ''
                if (value === '') continue
                if (entropyRule) {
                    if (value.length < ENTROPY_MIN_LENGTH) continue
                    if (matched.some((entry) => entry.line === line && value.includes(entry.value))) continue
                    const entropy = shannonEntropy(value)
                    if (entropy < threshold) continue
                    if (looksLikePlaceholder(value)) continue
                    if (looksLikeWordList(value)) continue
                    // Context decides whether this is a finding or noise: a long
                    // random literal assigned to a secret-ish key (or living in a
                    // credential file) is worth attention; the same literal in a
                    // README is a base64 blob. Real-repo measurement is why this
                    // distinction exists.
                    const contextual = input.credentialFile === true || hasSecretContext(text, value)
                    record({
                        rule: { ...rule, severity: contextual ? 'low' : 'info' },
                        value,
                        line,
                        column: (match.index ?? 0) + 1,
                        entropy: Math.round(entropy * 1000) / 1000,
                    })
                    continue
                }
                // Low-confidence rules ignore documented placeholders; a
                // high-confidence shape is never exempted.
                if (rule.severity === 'medium' && looksLikePlaceholder(value)) continue
                record({ rule, value, line, column: (match.index ?? 0) + 1 })
            }
        }
    }

    function record(found: { rule: SecretRule; value: string; line: number; column: number; entropy?: number }): void {
        matched.push({ line: found.line, value: found.value })
        const hash = fingerprintOf(found.value)
        // The same value on the same line is ONE secret: a value that matches
        // both `deepseek-api-key` and `openai-api-key` must not be reported twice.
        const key = `${found.line}\u0000${hash}`
        const existing = seen.get(key)
        if (existing !== undefined) {
            if (existing.rule !== found.rule.id && existing.alsoMatched?.includes(found.rule.id) !== true) {
                existing.alsoMatched = [...(existing.alsoMatched ?? []), found.rule.id]
            }
            return
        }
        const finding: SecretFinding = {
            rule: found.rule.id,
            path: input.path,
            line: found.line,
            column: found.column,
            severity: found.rule.severity,
            excerpt: redactSecret(found.value),
            hash,
            ...(found.entropy === undefined ? {} : { entropy: found.entropy }),
            description: found.rule.description,
        }
        seen.set(key, finding)
        findings.push(finding)
    }

    findings.sort(
        (left, right) =>
            left.path.localeCompare(right.path) ||
            left.line - right.line ||
            left.column - right.column ||
            left.rule.localeCompare(right.rule),
    )
    return findings
}

/** Rule id → rule, for reports and status lines. */
export function ruleById(id: string): SecretRule | undefined {
    return SECRET_RULES.find((rule) => rule.id === id)
}

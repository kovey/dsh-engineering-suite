/**
 * The mission's **mandate**: a recorded, revalidatable authorisation.
 *
 * The suite could already prove "this delivery was allowed" (a receipt bound to
 * a gate and an approval). It could not prove "this work was allowed from the
 * start, under which rules, and whether those rules still hold" — `spec_approve`
 * recorded only *who* approved and *when*, which stops being answerable the day
 * someone edits `.dsh/quality-gate.json` or adds a role file.
 *
 * Three pieces fix that, and this module owns all three:
 *
 *  1. **{@link policyVersion}** — a deterministic fingerprint of the project's
 *     TRUST ROOT (`<cwd>/.dsh/`): every `*.json` file plus everything under
 *     `.dsh/roles/`, hashed as sha256 over `path\0content\0` pairs in sorted
 *     path order. Runtime directories (`missions/`, `audit/`, `state/`, `kb/`,
 *     `media/`, `interaction/`, `deploy/`) and every `*.jsonl` are excluded: they
 *     change on every run, so including them would make every mission
 *     permanently stale. A missing `.dsh/` is the stable version of an empty
 *     trust root ({@link EMPTY_POLICY_VERSION}) — documented, not an error.
 *     No git, no network: the same files always produce the same version, and
 *     {@link policyFingerprint} also returns the file list so a report can name
 *     WHAT changed instead of only saying "something did".
 *  2. **{@link approvalStrength}** — whether an approval is a person's grant
 *     (`explicit`) or merely a recorded decision (`inferred`). It is computed
 *     from durable facts (the allowlist, the deciding session, the channel), never
 *     taken from the model's or the caller's word. Anything the computation
 *     cannot prove is `inferred`, and an `inferred` mandate fails closed.
 *  3. **The mandate record** itself ({@link Mandate} in `types.ts`): written once
 *     by `spec_approve`, immutable, revalidated before any resume. A mission
 *     approved before this feature has no record; it is READ as
 *     `strength: 'legacy'` ({@link mandateState}) and treated like `explicit`
 *     for compatibility — a fact every report states.
 *
 * ## The approver allowlist
 *
 * The design calls it "role-guard's allowlist". This repository's identity
 * lists live in the trust root, so both are read (read-only — no plugin is
 * edited here):
 *
 *  - `<root>/role-guard.json` → `approvers: string[]` (also accepted:
 *    `allowlist`), the role/permission layer's own identity list;
 *  - `<root>/interaction-gate.json` → when `requireApproverList: true`, the
 *    `approversFile` it names (default `<root>/interaction-approvers.txt`), one
 *    id per line — the list that already decides who may answer a card.
 *
 * A configured list means "only these identities count as an explicit approval";
 * no configured list means a local operator session counts (and an IM click, a
 * subagent or an automatic approval does not). The two lists are unioned: each
 * file is a policy statement of permitted approvers, and a list that does not
 * exist cannot silently allow anyone through it.
 *
 * @module dsh-eng-core/mandate
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './digest.js'
import { readJson } from './io.js'
import { resolveLayout } from './paths.js'
import type { Layout } from './paths.js'
import { delegationDepthOf, isSubagent } from './session.js'
import type { AgentLike } from './session.js'
import type { Mandate, MandateScope, MandateStrength, MissionRecord, SpecRecord } from './types.js'

/** Schema version of the mandate record. */
export const MANDATE_VERSION = 1

/** The only basis a mandate can have today: a human's specification approval. */
export const MANDATE_BASIS = 'spec-approved' as const

/**
 * Runtime directories under the trust root: written on every run, therefore
 * never part of the policy fingerprint.
 */
export const TRUST_ROOT_RUNTIME_DIRS: readonly string[] = ['missions', 'audit', 'state', 'kb', 'media', 'interaction', 'deploy']

/**
 * The version of an EMPTY trust root (`sha256` of no bytes).
 *
 * A workspace without `.dsh/` is not an error and must not produce a random or
 * time-dependent value: "no configuration" is one stable policy.
 */
export const EMPTY_POLICY_VERSION: string = sha256('')

/** Digest recorded for a trust-root file that exists but cannot be read. */
export const UNREADABLE_POLICY_DIGEST: string = sha256('<unreadable>')

/**
 * Mission artifact holding the approval-time fingerprint, so a later
 * revalidation can name the files that changed (the mandate itself only carries
 * the version, and adding a file list to it would change the agreed shape).
 */
export const POLICY_SNAPSHOT_ARTIFACT = 'policy-fingerprint.json'

/** One hashed trust-root file (`path` is workspace-relative POSIX). */
export interface PolicyTrustFile {
    path: string
    sha256: string
}

/** The policy fingerprint: a version plus the files it was computed over. */
export interface PolicyFingerprint {
    version: string
    files: PolicyTrustFile[]
}

/** Options of {@link policyFingerprint} / {@link approverAllowlist}. */
export interface PolicyOptions {
    /** Trail root override (default `.dsh`, resolved against `cwd`). */
    rootDir?: string
}

/** How one path differs between two fingerprints. */
export interface PolicyChange {
    path: string
    change: 'added' | 'removed' | 'changed'
}

const configLayout = (cwd: string, options: PolicyOptions): Layout => resolveLayout(cwd, options.rootDir === undefined ? {} : { rootDir: options.rootDir })

/** Compare two digests without leaking timing (not a secret, but cheap and clear). */
function sameDigest(left: string, right: string): boolean {
    return left.length === right.length && left === right
}

/**
 * Whether one trust-root entry belongs to the policy.
 *
 * Rule (agreed design): a file whose name ends in `.json`, OR any file under
 * `.dsh/roles/`. Runtime directories are excluded at the root, and `*.jsonl` is
 * excluded everywhere (append-only ledgers change on every run).
 */
function isPolicyFile(relative: string): boolean {
    const name = relative.slice(relative.lastIndexOf('/') + 1)
    if (name.endsWith('.jsonl')) return false
    if (name.endsWith('.json')) return true
    return relative === 'roles' || relative.startsWith('roles/')
}

/**
 * Collect the trust-root files, sorted by POSIX relative path.
 *
 * Symlinks and other non-regular entries are skipped on purpose: following one
 * would make the fingerprint depend on bytes outside the repository (and a
 * symlink is not a configuration file a reviewer can read in the diff). A
 * directory that cannot be read contributes nothing rather than throwing — the
 * doctor must never fail because one subdirectory is unreadable.
 * @param rootDir - absolute trail root.
 * @returns absolute paths plus their workspace-relative POSIX form.
 */
function collectPolicyFiles(rootDir: string): { absolute: string; relative: string }[] {
    const out: { absolute: string; relative: string }[] = []
    const visit = (dir: string, relativeDir: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
            const absolute = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (relativeDir === '' && TRUST_ROOT_RUNTIME_DIRS.includes(entry.name)) continue
                visit(absolute, relative)
                continue
            }
            if (!entry.isFile()) continue
            if (!isPolicyFile(relative)) continue
            out.push({ absolute, relative })
        }
    }
    visit(rootDir, '')
    return out.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
}

/**
 * Fingerprint the workspace trust root.
 *
 * The version is sha256 over the concatenation of `path\0content\0` for every
 * selected file in sorted path order — deterministic for the same bytes, and
 * changed by adding, editing or removing one file. `files[]` carries each file's
 * own digest so a report can name the ones that differ.
 * @param cwd - workspace root (a session's `header.cwd`).
 * @param options - trail root override.
 */
export function policyFingerprint(cwd: string, options: PolicyOptions = {}): PolicyFingerprint {
    const layout = configLayout(cwd, options)
    const collected: { path: string; sha256: string; content?: Buffer }[] = []
    for (const entry of collectPolicyFiles(layout.rootDir)) {
        // The workspace-relative, POSIX path (`.dsh/quality-gate.json`) is the
        // identity: the same configuration in another checkout must hash the
        // same, and the trail root may be relocated.
        const relativeToCwd = path.relative(layout.cwd, entry.absolute).split(path.sep).join('/')
        let content: Buffer
        try {
            content = fs.readFileSync(entry.absolute)
        } catch {
            collected.push({ path: relativeToCwd, sha256: UNREADABLE_POLICY_DIGEST })
            continue
        }
        collected.push({ path: relativeToCwd, sha256: sha256(content), content })
    }
    const hash = createHash('sha256')
    for (const file of collected) {
        hash.update(`${file.path}\0`)
        hash.update(file.content ?? Buffer.alloc(0))
        hash.update('\0')
    }
    return {
        version: collected.length === 0 ? EMPTY_POLICY_VERSION : hash.digest('hex'),
        files: collected.map((file) => ({ path: file.path, sha256: file.sha256 })),
    }
}

/** The policy version alone (see {@link policyFingerprint}). */
export function policyVersion(cwd: string, options: PolicyOptions = {}): string {
    return policyFingerprint(cwd, options).version
}

/**
 * The paths that differ between two fingerprints (added / removed / changed),
 * sorted by path. Used to answer "WHAT changed" with names, not just versions.
 */
export function policyDifferences(before: PolicyFingerprint, after: PolicyFingerprint): PolicyChange[] {
    const previous = new Map(before.files.map((file) => [file.path, file.sha256]))
    const current = new Map(after.files.map((file) => [file.path, file.sha256]))
    const changes: PolicyChange[] = []
    for (const [file, digest] of current) {
        const old = previous.get(file)
        if (old === undefined) changes.push({ path: file, change: 'added' })
        else if (!sameDigest(old, digest)) changes.push({ path: file, change: 'changed' })
    }
    for (const file of previous.keys()) {
        if (!current.has(file)) changes.push({ path: file, change: 'removed' })
    }
    return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Read the approval-time fingerprint snapshot of one mission.
 * @param store - the mission's store.
 * @param missionId - mission id.
 * @returns the snapshot, or `undefined` when it is missing/unparsable.
 */
export function readPolicySnapshot(store: { readArtifact: (id: string, relative: string) => string | undefined }, missionId: string): PolicyFingerprint | undefined {
    const text = store.readArtifact(missionId, POLICY_SNAPSHOT_ARTIFACT)
    if (text === undefined) return undefined
    return parsePolicyFingerprint(text)
}

/** Parse a fingerprint snapshot (tolerant: unknown fields are ignored). */
export function parsePolicyFingerprint(text: string): PolicyFingerprint | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record['version'] !== 'string' || record['version'] === '') return undefined
    if (!Array.isArray(record['files'])) return undefined
    const files: PolicyTrustFile[] = []
    for (const entry of record['files']) {
        if (typeof entry !== 'object' || entry === null) return undefined
        const file = entry as Record<string, unknown>
        if (typeof file['path'] !== 'string' || file['path'] === '') return undefined
        if (typeof file['sha256'] !== 'string' || file['sha256'] === '') return undefined
        files.push({ path: file['path'], sha256: file['sha256'] })
    }
    return { version: record['version'], files }
}

/** Normalise an approver identity for comparison (case/space insensitive). */
export function normalizeApprover(value: string): string {
    return value.trim().toLowerCase()
}

/** A resolved approver allowlist. */
export interface ApproverAllowlist {
    /** `true` when at least one identity list was actually configured. */
    configured: boolean
    /** Permitted identities (union of the configured sources, de-duplicated). */
    approvers: string[]
    /** Files that contributed the list (absolute paths). */
    files: string[]
    /** Unreadable / malformed sources — reported, never silently ignored. */
    problems: string[]
}

function readJsonFile(file: string): { value?: Record<string, unknown>; problem?: string } {
    if (!fs.existsSync(file)) return {}
    const parsed = readJson<unknown>(file)
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { problem: `${file}: 不是合法的 JSON 对象，已忽略其中的审批人清单（继续看其它来源）` }
    }
    return { value: parsed as Record<string, unknown> }
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function readApproverFile(file: string): { approvers: string[]; problem?: string } {
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return { approvers: [], problem: `${file}: 审批人名单读不到（requireApproverList=true 时这份名单是必需的）` }
    }
    const approvers: string[] = []
    for (const line of text.split('\n')) {
        const entry = line.trim()
        if (entry === '' || entry.startsWith('#')) continue
        approvers.push(entry)
    }
    return { approvers }
}

/**
 * Resolve the approver allowlist for one workspace (see the module docs for the
 * two trust-root sources). A malformed source is reported and contributes
 * nothing: it must never turn into "nobody is allowed" (that would block every
 * explicit approval) nor into "everybody is allowed".
 * @param cwd - workspace root.
 * @param options - trail root override.
 */
export function approverAllowlist(cwd: string, options: PolicyOptions = {}): ApproverAllowlist {
    const layout = configLayout(cwd, options)
    const approvers: string[] = []
    const files: string[] = []
    const problems: string[] = []
    const add = (entries: readonly string[]): number => {
        let added = 0
        for (const entry of entries) {
            if (approvers.some((existing) => normalizeApprover(existing) === normalizeApprover(entry))) continue
            approvers.push(entry)
            added += 1
        }
        return added
    }

    // 1. role-guard's own identity list, in the trust root.
    const roleGuardFile = path.join(layout.rootDir, 'role-guard.json')
    const roleGuard = readJsonFile(roleGuardFile)
    if (roleGuard.problem !== undefined) problems.push(roleGuard.problem)
    if (roleGuard.value !== undefined) {
        const declared = stringList(roleGuard.value['approvers']) ?? stringList(roleGuard.value['allowlist'])
        if (declared !== undefined && declared.length > 0) {
            add(declared)
            files.push(roleGuardFile)
        }
    }

    // 2. The interaction gate's approver list: the suite's existing "who may
    //    answer a card" policy. Honoured only when the gate requires it (a list
    //    that is not enforced is not a configured allowlist).
    const interactionFile = path.join(layout.rootDir, 'interaction-gate.json')
    const interaction = readJsonFile(interactionFile)
    if (interaction.problem !== undefined) problems.push(interaction.problem)
    if (interaction.value !== undefined && interaction.value['requireApproverList'] === true) {
        const configured = interaction.value['approversFile']
        const declared = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : path.join(layout.rootDir, 'interaction-approvers.txt')
        const file = path.isAbsolute(declared) ? declared : path.resolve(layout.cwd, declared)
        const read = readApproverFile(file)
        if (read.problem !== undefined) problems.push(read.problem)
        if (read.approvers.length > 0) {
            add(read.approvers)
            files.push(file)
        }
    }

    return { configured: files.length > 0, approvers, files, problems }
}

/** What the strength computation was given. */
export interface ApprovalStrengthInput {
    /** Who the decision names (`approval` when the channel named nobody). */
    approvedBy: string
    /** Which surface decided (`tui` / `seam` / `im` / `auto` / …), when known. */
    source?: string
    /** The session that ran the tool call (subagent children are not operators). */
    agent?: AgentLike
    /** The resolved approver allowlist of the workspace. */
    allowlist: ApproverAllowlist
    /** `true` when the host approved automatically (`approval: 'auto'`). */
    automatic?: boolean
}

/** The computed strength plus the reason a report can quote. */
export interface ApprovalStrength {
    strength: 'explicit' | 'inferred'
    why: string
}

/**
 * Surfaces that are a local operator session.
 *
 * An EMPTY source counts as local: the approval seam runs in this process and
 * an answerer that reports no provenance is the terminal path that existed
 * before provenance. Every OTHER non-empty source is treated as remote (fail
 * closed): a channel this build does not know must not be able to claim
 * "explicit" by staying quiet about which surface it is.
 */
const LOCAL_APPROVAL_SOURCES: readonly string[] = ['tui', 'seam', 'terminal', 'cli', 'local', 'headless']

/**
 * Compute the strength of one approval — the rule is load-bearing, so it lives
 * in exactly one place:
 *
 *  - a **subagent** session is never explicit (a delegated child's approval is
 *    recorded, but it is not a person deciding);
 *  - an **automatic** approval (`approval: 'auto'`, or `by: 'auto'`) is never
 *    explicit: a configured switch is not a person;
 *  - **allowlist configured** → explicit iff the allowlist contains the
 *    approver (the list is the authority, whatever surface carried the answer);
 *  - **no allowlist** → explicit iff the decision came from the local operator
 *    session (not a subagent, not an IM/unknown channel, not a context text);
 *  - everything else is `inferred`.
 * @param input - approver, provenance, session and allowlist.
 * @returns the strength and the Chinese reason to record.
 */
export function approvalStrength(input: ApprovalStrengthInput): ApprovalStrength {
    const approvedBy = input.approvedBy.trim()
    const source = (input.source ?? '').trim().toLowerCase()
    const fromSubagent = input.agent !== undefined && (isSubagent(input.agent) || delegationDepthOf(input.agent) > 0)
    if (fromSubagent) {
        return { strength: 'inferred', why: '审批来自子代理会话：子代理的批准永远不算 explicit（即使它的名字在允许清单里）' }
    }
    if (input.automatic === true || source === 'auto' || approvedBy.toLowerCase() === 'auto') {
        // Auto-approval has no row in the agreed rule, and the two honest answers
        // are "a configured switch is not a person" and "the local operator
        // pre-decided it". It is treated as the LOCAL OPERATOR's standing
        // decision — the switch lives in the trust root (profile or
        // `.dsh/spec-gate.json`), is reviewed, and is covered by the policy
        // version — but it can never satisfy an allowlist that names PEOPLE: a
        // list of identities is not a switch, so `auto` stays `inferred` there.
        return input.allowlist.configured
            ? { strength: 'inferred', why: '自动审批（approval=auto）不能满足一份指名到人的允许清单' }
            : { strength: 'explicit', why: '宿主配置 approval=auto：这是本地操作员的常设决定（没有配置允许清单），理由随 mandate 记录' }
    }
    if (input.allowlist.configured) {
        const allowed = input.allowlist.approvers.some((entry) => normalizeApprover(entry) === normalizeApprover(approvedBy))
        const where = input.allowlist.files.join('、')
        return allowed
            ? { strength: 'explicit', why: `允许清单包含审批人 ${approvedBy}（${where}）` }
            : { strength: 'inferred', why: `允许清单已配置但不包含审批人 ${approvedBy}（${where}）` }
    }
    if (source !== '' && !LOCAL_APPROVAL_SOURCES.includes(source)) {
        return { strength: 'inferred', why: `审批来自 ${source} 通道，且没有配置允许清单：无法证明这是本地操作员会话` }
    }
    return {
        strength: 'explicit',
        why: source === '' ? '没有配置允许清单，审批来自本地操作员会话' : `没有配置允许清单，审批来自本地操作员会话（${source}）`,
    }
}

/** What a mission's approval state says about its mandate. */
export type MandateState =
    | { kind: 'absent' }
    | { kind: 'legacy'; mandate: Mandate }
    | { kind: 'present'; mandate: Mandate }
    | { kind: 'invalid'; reason: string }

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * Validate a stored mandate record (untrusted: `mission.json` is a file, and a
 * file can be edited by hand or by a bug).
 *
 * A record claiming `strength: 'legacy'` is invalid on purpose: `legacy` is a
 * READ-only view of "no record", so accepting it would let a written file claim
 * the compatibility exemption.
 */
export function validateMandate(value: unknown): Mandate | { reason: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: 'mandate 不是对象' }
    const record = value as Record<string, unknown>
    if (record['version'] !== MANDATE_VERSION) return { reason: `mandate.version 必须是 ${MANDATE_VERSION}（收到 ${JSON.stringify(record['version'])}）` }
    if (record['strength'] !== 'explicit' && record['strength'] !== 'inferred') {
        return { reason: 'mandate.strength 必须是 explicit 或 inferred（legacy 只用于"没有记录"的读取视图，不允许写进文件）' }
    }
    if (record['basis'] !== MANDATE_BASIS) return { reason: `mandate.basis 必须是 ${MANDATE_BASIS}` }
    if (typeof record['policyVersion'] !== 'string' || record['policyVersion'] === '') return { reason: 'mandate.policyVersion 必须是非空字符串' }
    if (typeof record['approvedBy'] !== 'string' || record['approvedBy'] === '') return { reason: 'mandate.approvedBy 必须是非空字符串' }
    if (typeof record['at'] !== 'number' || !Number.isFinite(record['at'])) return { reason: 'mandate.at 必须是毫秒时间戳' }
    const scope = record['scope']
    if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return { reason: 'mandate.scope 必须是对象' }
    const scopeRecord = scope as Record<string, unknown>
    if (!isStringArray(scopeRecord['phases'])) return { reason: 'mandate.scope.phases 必须是字符串数组' }
    if (!isStringArray(scopeRecord['paths'])) return { reason: 'mandate.scope.paths 必须是字符串数组' }
    const withdrawn = record['withdrawn']
    let withdrawal: Mandate['withdrawn']
    if (withdrawn !== undefined) {
        if (typeof withdrawn !== 'object' || withdrawn === null || Array.isArray(withdrawn)) return { reason: 'mandate.withdrawn 必须是对象' }
        const entry = withdrawn as Record<string, unknown>
        if (typeof entry['at'] !== 'number' || !Number.isFinite(entry['at'])) return { reason: 'mandate.withdrawn.at 必须是毫秒时间戳' }
        if (typeof entry['by'] !== 'string' || entry['by'] === '') return { reason: 'mandate.withdrawn.by 必须是非空字符串' }
        if (typeof entry['reason'] !== 'string' || entry['reason'] === '') return { reason: 'mandate.withdrawn.reason 必须是非空字符串（没有原因的"停止"不可审计）' }
        withdrawal = { at: entry['at'], by: entry['by'], reason: entry['reason'] }
    }
    return {
        version: MANDATE_VERSION,
        strength: record['strength'],
        basis: MANDATE_BASIS,
        scope: { phases: [...scopeRecord['phases']], paths: [...scopeRecord['paths']] },
        policyVersion: record['policyVersion'],
        approvedBy: record['approvedBy'],
        at: record['at'],
        ...(withdrawal === undefined ? {} : { withdrawn: withdrawal }),
    }
}

/**
 * A stored mandate exactly as recorded (no legacy synthesis).
 * @param mission - the mission record (may be undefined).
 */
export function storedMandate(mission: MissionRecord | undefined): Mandate | undefined {
    const state = mandateState(mission)
    return state.kind === 'present' ? state.mandate : undefined
}

/**
 * What the mission's approval implies about its mandate:
 *
 *  - no approval at all → `absent` (nothing was authorised; not a legacy case);
 *  - an approved mission with no mandate record → `legacy`, with a synthesised
 *    view (`strength: 'legacy'`, no policy version, no scope) that consumers
 *    treat like `explicit` for compatibility;
 *  - a record that does not validate → `invalid` (fail closed: a corrupt or
 *    forged mandate is not "no mandate").
 * @param mission - the mission record.
 */
export function mandateState(mission: MissionRecord | undefined): MandateState {
    if (mission === undefined) return { kind: 'absent' }
    if (mission.mandate !== undefined) {
        const validated = validateMandate(mission.mandate)
        return 'reason' in validated ? { kind: 'invalid', reason: validated.reason } : { kind: 'present', mandate: validated }
    }
    if (mission.spec?.approvedAt === undefined) return { kind: 'absent' }
    return {
        kind: 'legacy',
        mandate: {
            version: MANDATE_VERSION,
            strength: 'legacy',
            basis: MANDATE_BASIS,
            // Nothing was recorded about the scope or the rules: an empty scope
            // means "not narrowed", never "nothing allowed".
            scope: { phases: [], paths: [] },
            policyVersion: '',
            approvedBy: mission.spec.approvedBy ?? 'unknown',
            at: mission.spec.approvedAt,
        },
    }
}

/**
 * The mandate a consumer should reason about: the stored record, or the
 * `legacy` view of a mission approved before mandates existed.
 * @param mission - the mission record.
 */
export function effectiveMandate(mission: MissionRecord | undefined): Mandate | undefined {
    const state = mandateState(mission)
    return state.kind === 'present' || state.kind === 'legacy' ? state.mandate : undefined
}

/**
 * The scope a specification declares, as a mandate records it.
 *
 * `paths` is the specification's file boundaries (its declared paths). `phases`
 * is empty unless a specification declares phases: today's `SpecRecord` has no
 * such field, and inventing one here would be a claim about a document that does
 * not say it. Empty = **not narrowed**.
 * @param spec - the approved specification.
 */
export function mandateScopeOf(spec: SpecRecord | undefined): MandateScope {
    if (spec === undefined) return { phases: [], paths: [] }
    const declaredPhases = (spec as SpecRecord & { phases?: unknown }).phases
    return {
        phases: Array.isArray(declaredPhases) ? declaredPhases.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [],
        paths: [...spec.fileBoundaries],
    }
}

/**
 * Whether a new approval would WIDEN an existing mandate.
 *
 * An empty existing list is "not narrowed", so it cannot be widened — it already
 * covers everything. Comparison is on the declared strings (a specification
 * declares patterns, not concrete paths): anything not literally declared before
 * counts as wider, i.e. the uncertain case is refused, never allowed quietly.
 * @param existing - the immutable mandate's scope.
 * @param next - the scope the new approval would record.
 * @returns the entries that would be added (empty = no widening).
 */
export function scopeWidened(existing: MandateScope, next: MandateScope): string[] {
    const widened: string[] = []
    if (existing.paths.length > 0) {
        for (const entry of next.paths) if (!existing.paths.includes(entry)) widened.push(`path:${entry}`)
    }
    if (existing.phases.length > 0) {
        for (const entry of next.phases) if (!existing.phases.includes(entry)) widened.push(`phase:${entry}`)
    }
    return widened
}

/** Result of asking a mission to withdraw its mandate. */
export interface WithdrawalResult {
    /** The mandate to persist, when a withdrawal applies. */
    mandate?: Mandate
    /** Why it does not apply (a refusal the caller must report, not swallow). */
    refusal?: string
}

/**
 * Build the withdrawal patch for a mission.
 *
 * Only a person's stop withdraws a mandate, and a withdrawal is **not** a
 * rewrite of the grant: the recorded strength, scope, policy version, approver
 * and time stay exactly as approved. A `legacy` mission has no record to
 * withdraw (it is called out instead of being silently treated as stopped), and
 * a second stop keeps the first one (the first person's stop is the fact).
 * @param mission - the mission record.
 * @param input - who stopped it, when, and why.
 */
export function withdrawalOf(mission: MissionRecord | undefined, input: { at: number; by: string; reason: string }): WithdrawalResult {
    const state = mandateState(mission)
    if (state.kind === 'absent') return { refusal: 'mission 还没有已审批的规格：没有 mandate 可以撤回（写操作本来就被拒绝）' }
    if (state.kind === 'legacy') {
        return {
            refusal:
                '该 mission 是 legacy 审批（mandate 之前的历史记录），没有可撤回的对象：' +
                '停止这个工作要靠新建 mission（spec_create）并重新审批，本工具不会伪造一条历史授权。',
        }
    }
    if (state.kind === 'invalid') return { refusal: `mandate 记录损坏，无法撤回：${state.reason}` }
    if (state.mandate.withdrawn !== undefined) {
        return {
            mandate: state.mandate,
            refusal: `mandate 已于 ${new Date(state.mandate.withdrawn.at).toISOString()} 由 ${state.mandate.withdrawn.by} 撤回（${state.mandate.withdrawn.reason}）：保留第一次停止的记录`,
        }
    }
    return { mandate: { ...state.mandate, withdrawn: { at: input.at, by: input.by, reason: input.reason } } }
}

/** One Chinese line describing a mandate (for status/evidence reports). */
export function describeMandate(mandate: Mandate | undefined): string {
    if (mandate === undefined) return 'mandate: 尚无（规格未审批）'
    const strength: Record<MandateStrength, string> = {
        explicit: 'explicit（一个人的有效批准）',
        inferred: 'inferred（已记录，但不满足强制门禁）',
        legacy: 'legacy（mandate 之前的历史审批，按 explicit 兼容处理——事实，不是缺陷）',
    }
    const policy = mandate.policyVersion === '' ? '策略版本未记录' : `policy ${mandate.policyVersion.slice(0, 12)}`
    const scope =
        mandate.scope.paths.length === 0 && mandate.scope.phases.length === 0
            ? '范围未收窄'
            : `范围：paths ${mandate.scope.paths.join('、') || '(无)'}；phases ${mandate.scope.phases.join('、') || '(无)'}`
    const withdrawal =
        mandate.withdrawn === undefined
            ? ''
            : `；已撤回（${new Date(mandate.withdrawn.at).toISOString()} by ${mandate.withdrawn.by}：${mandate.withdrawn.reason}）`
    return `mandate: ${strength[mandate.strength]}，by ${mandate.approvedBy}，${new Date(mandate.at).toISOString()}，${policy}，${scope}${withdrawal}`
}

/** Whether a mandate is usable by an enforcing gate (inferred and invalid are not). */
export function mandateSatisfiesGate(mission: MissionRecord | undefined): boolean {
    const state = mandateState(mission)
    if (state.kind === 'absent' || state.kind === 'invalid') return false
    return state.mandate.strength !== 'inferred'
}

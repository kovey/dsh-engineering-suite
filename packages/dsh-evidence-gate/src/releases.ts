/**
 * The release ledger: the link between a receipt and a version.
 *
 * A receipt answers "mission X was delivered, from this tree, with this
 * evidence". It does NOT answer "which release contains this work": nothing
 * connected a delivery to a version or a tag, so reconstructing "what is in
 * v1.2.0" meant reading git history and guessing — and release notes were typed
 * by hand, from memory, so the requirements that were approved and the evidence
 * that justified them never appeared.
 *
 * This module closes that half of the chain with one append-only ledger
 * (`<layout.rootDir>/releases.jsonl`, config key `releasesFile`) plus a
 * generated notes artifact (`<layout.rootDir>/releases/<version>.md`, config key
 * `releasesDir`). Both are PROJECTIONS of artifacts that already exist — the
 * specification, the gate records, the evidence ledger and the receipts — so
 * nothing here is recalled, and nothing is claimed that the record does not
 * contain.
 *
 * Recording is fail-closed: a mission without a receipt, a version that already
 * exists, an empty mission set and a workspace that is not a git repository (a
 * release without a revision is not a release) are all refused, each with the
 * exact next tool call.
 *
 * @module dsh-evidence-gate/releases
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    appendJsonl,
    assertSafeId,
    gitFingerprint,
    isSafeId,
    readJsonl,
    readText,
    resolvePath,
    writeTextAtomic,
    type AcceptanceCriterion,
    type EvidenceRecord,
    type GateRecord,
    type GateState,
    type GitFingerprint,
    type Layout,
    type MissionRecord,
    type MissionStatus,
    type MissionStore,
    type Receipt,
    type Requirement,
    type SpecRecord,
} from 'dsh-eng-core'
import { DEFAULT_RELEASES_DIR, DEFAULT_RELEASES_FILE, type EvidenceGateConfig } from './config.js'

// --- where the artifacts live ------------------------------------------------

/**
 * Absolute path of the release ledger of one workspace.
 *
 * The default value is `<layout.rootDir>/releases.jsonl` (a host that relocates
 * `rootDir` keeps the ledger with the rest of the trail); any other value is
 * resolved against the workspace root, exactly like every `layout` option.
 */
export function releasesFileFor(layout: Layout, config: EvidenceGateConfig): string {
    return config.releasesFile === DEFAULT_RELEASES_FILE
        ? path.join(layout.rootDir, 'releases.jsonl')
        : resolvePath(config.releasesFile, layout.cwd)
}

/** Absolute directory the generated notes land in (default `<root>/releases`). */
export function releasesDirFor(layout: Layout, config: EvidenceGateConfig): string {
    return config.releasesDir === DEFAULT_RELEASES_DIR
        ? path.join(layout.rootDir, 'releases')
        : resolvePath(config.releasesDir, layout.cwd)
}

/**
 * Absolute path of one version's notes artifact.
 *
 * The version is model input and becomes a file name, so it must be a single
 * path segment: a version such as `../../etc/passwd` would otherwise write
 * outside the release directory. Callers refuse an unsafe version with a
 * Chinese message first; this assertion is the defensive second line.
 */
export function notesFileFor(layout: Layout, config: EvidenceGateConfig, version: string): string {
    return path.join(releasesDirFor(layout, config), `${assertSafeId(version, 'version')}.md`)
}

/** Whether a version can be used as one file name and one ledger key. */
export function isSafeVersion(version: string): boolean {
    return isSafeId(version)
}

// --- the ledger --------------------------------------------------------------

/** One row of the append-only release ledger. */
export interface ReleaseRow {
    /** When the release was recorded (epoch ms) — the cutoff for "delivered since". */
    at: number
    /** Version the release is known by (the ledger key, exact string match). */
    version: string
    /** Git tag the version is published under, when the caller named one. */
    tag?: string
    /**
     * Workspace fingerprint at recording time (the engineering trail excluded,
     * so recording does not dirty what it records — see `release_record`).
     * Absent only on a hand-edited row: it is then reported as 未记录, never
     * invented.
     */
    revision?: GitFingerprint
    /** Missions the release contains. */
    missionIds: string[]
    /** Receipts that delivered them (the proof each mission is in here). */
    receiptIds: string[]
    /** Notes artifact, relative to the workspace root. */
    notesPath?: string
    /** Who recorded it (agent/session id). */
    recordedBy?: string
    /** The caller's free-form note. */
    note?: string
}

/** The ledger, plus how much of it could not be read. */
export interface ReleaseLedger {
    rows: ReleaseRow[]
    /**
     * Non-empty lines that did not become a row. A truncated tail line is what a
     * crash leaves behind, so it must never make the whole ledger unreadable —
     * but it is reported instead of being silently swallowed.
     */
    unreadable: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A parsed line that carries at least the two keys the ledger is keyed by. */
function isReleaseRow(value: unknown): value is ReleaseRow {
    if (!isRecord(value)) return false
    return typeof value['at'] === 'number' && typeof value['version'] === 'string' && value['version'] !== ''
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/** Read the ledger; a missing file is an empty ledger, never an error. */
export function readReleaseLedger(file: string): ReleaseLedger {
    const text = readText(file)
    if (text === undefined) return { rows: [], unreadable: 0 }
    const rows = readJsonl<unknown>(file).filter(isReleaseRow).map(
        (row): ReleaseRow => ({
            at: row.at,
            version: row.version,
            ...(typeof row.tag === 'string' && row.tag !== '' ? { tag: row.tag } : {}),
            ...(isRecord(row.revision) && typeof row.revision['isRepo'] === 'boolean'
                ? { revision: row.revision as unknown as GitFingerprint }
                : {}),
            missionIds: strings(row.missionIds),
            receiptIds: strings(row.receiptIds),
            ...(typeof row.notesPath === 'string' && row.notesPath !== '' ? { notesPath: row.notesPath } : {}),
            ...(typeof row.recordedBy === 'string' && row.recordedBy !== '' ? { recordedBy: row.recordedBy } : {}),
            ...(typeof row.note === 'string' && row.note !== '' ? { note: row.note } : {}),
        }),
    )
    const lines = text.split('\n').filter((line) => line.trim() !== '').length
    return { rows, unreadable: Math.max(0, lines - rows.length) }
}

/** Ledger rows, newest first (`at`; a tie is broken by ledger position). */
export function releasesNewestFirst(rows: readonly ReleaseRow[]): ReleaseRow[] {
    return rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => right.row.at - left.row.at || right.index - left.index)
        .map((entry) => entry.row)
}

/**
 * The previous release row: the greatest `at` in the ledger (a tie is the later
 * line). "Newest" rather than "last line" so a hand-edited ledger cannot make
 * an old row decide what counts as already released.
 */
export function previousRelease(rows: readonly ReleaseRow[]): ReleaseRow | undefined {
    return releasesNewestFirst(rows)[0]
}

/** The recorded row of one version (exact string match), when it exists. */
export function findRelease(rows: readonly ReleaseRow[], version: string): ReleaseRow | undefined {
    return rows.find((row) => row.version === version)
}

// --- version patterns --------------------------------------------------------

/** The compiled `requireTagFormat`, or why it cannot be used. */
export type VersionPattern =
    | { kind: 'off' }
    | { kind: 'pattern'; source: string; regex: RegExp }
    | { kind: 'invalid'; source: string; reason: string }

/**
 * Compile `config.requireTagFormat`.
 *
 * A rule the host asked for is never skipped silently: a pattern that does not
 * compile makes `release_record` refuse (with the compiler's own message)
 * instead of recording an unchecked version.
 */
export function compileVersionPattern(value: string | undefined): VersionPattern {
    if (value === undefined || value.trim() === '') return { kind: 'off' }
    const source = value.trim()
    try {
        return { kind: 'pattern', source, regex: new RegExp(source) }
    } catch (error) {
        return { kind: 'invalid', source, reason: error instanceof Error ? error.message : String(error) }
    }
}

// --- missions of a release ---------------------------------------------------

/** One mission a release covers, with the receipts that prove it was delivered. */
export interface ReleaseMission {
    mission: MissionRecord
    receipts: Receipt[]
}

function firstIssuedAt(entry: ReleaseMission): number {
    return entry.receipts.reduce((oldest, receipt) => Math.min(oldest, receipt.issuedAt), Number.POSITIVE_INFINITY)
}

/** Every mission of the workspace that carries a receipt, oldest delivery first. */
export function deliveredMissions(store: MissionStore): ReleaseMission[] {
    const entries: ReleaseMission[] = []
    for (const mission of store.list()) {
        const receipts = store.readReceipts(mission.id)
        if (receipts.length > 0) entries.push({ mission, receipts })
    }
    return entries.sort(
        (left, right) => firstIssuedAt(left) - firstIssuedAt(right) || left.mission.id.localeCompare(right.mission.id),
    )
}

/**
 * The default mission set of a release.
 *
 * "Delivered since the previous release" is computed from the ledger, not from
 * the mission status: a mission counts when it has at least one receipt issued
 * **strictly after** the previous row's `at` (only those receipts are recorded
 * on the new row). With no previous row, every delivered mission counts. A
 * receipt recorded in the same millisecond as the previous row is therefore NOT
 * included — the `release_status` view exists so such a mission is visible as
 * delivered-but-unreleased instead of silently disappearing.
 */
export function missionsDeliveredSince(store: MissionStore, previous: ReleaseRow | undefined): ReleaseMission[] {
    const delivered = deliveredMissions(store)
    if (previous === undefined) return delivered
    return delivered
        .map((entry) => ({
            mission: entry.mission,
            receipts: entry.receipts.filter((receipt) => receipt.issuedAt > previous.at),
        }))
        .filter((entry) => entry.receipts.length > 0)
}

/**
 * Mission ids from the model, reduced to the unique ones that are safe to use
 * as one path segment.
 *
 * A junk or unsafe id (`../../x`, a number, an empty string) is reported as
 * missing — naming it — instead of being handed to the store, which would throw
 * an English error: every refusal must stay a Chinese verdict with a fix.
 */
function normalizeIds(ids: readonly string[]): { ids: string[]; missing: string[] } {
    const missing: string[] = []
    const safe: string[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
        const id = typeof raw === 'string' ? raw.trim() : ''
        if (id === '' || !isSafeId(id)) {
            missing.push(id === '' ? String(raw) : id)
            continue
        }
        if (seen.has(id)) continue
        seen.add(id)
        safe.push(id)
    }
    return { ids: safe, missing }
}

/** Explicit mission ids: which exist, and which have no receipt. */
export function missionsForRelease(
    store: MissionStore,
    ids: readonly string[],
): { missions: ReleaseMission[]; missing: string[]; undelivered: string[] } {
    const normalized = normalizeIds(ids)
    const missions: ReleaseMission[] = []
    const missing = [...normalized.missing]
    const undelivered: string[] = []
    for (const id of normalized.ids) {
        const mission = store.read(id)
        if (mission === undefined) {
            missing.push(id)
            continue
        }
        const receipts = store.readReceipts(id)
        if (receipts.length === 0) {
            undelivered.push(id)
            continue
        }
        missions.push({ mission, receipts })
    }
    return { missions, missing, undelivered }
}

/**
 * Missions a notes preview names.
 *
 * Like {@link missionsForRelease}, except a mission without a receipt is KEPT:
 * `release_notes` is read-only, so it shows what the record supports — marking
 * the undelivered mission as such — instead of hiding the part `release_record`
 * would refuse.
 */
export function previewMissions(
    store: MissionStore,
    ids: readonly string[],
): { entries: ReleaseMission[]; missing: string[]; undelivered: string[] } {
    const normalized = normalizeIds(ids)
    const entries: ReleaseMission[] = []
    const missing = [...normalized.missing]
    const undelivered: string[] = []
    for (const id of normalized.ids) {
        const mission = store.read(id)
        if (mission === undefined) {
            missing.push(id)
            continue
        }
        const receipts = store.readReceipts(id)
        if (receipts.length === 0) undelivered.push(id)
        entries.push({ mission, receipts })
    }
    return { entries, missing, undelivered }
}

/**
 * Missions whose receipts appear in no release row: the "what am I about to
 * ship" view. A mission that was released once and delivered again shows up
 * again — the new receipt is in no release yet.
 */
export function unreleasedMissions(store: MissionStore, rows: readonly ReleaseRow[]): ReleaseMission[] {
    const released = new Set<string>()
    for (const row of rows) for (const id of row.receiptIds) released.add(id)
    return deliveredMissions(store)
        .map((entry) => ({ mission: entry.mission, receipts: entry.receipts.filter((receipt) => !released.has(receipt.id)) }))
        .filter((entry) => entry.receipts.length > 0)
}

// --- the notes projection ----------------------------------------------------

/** One gate verdict that mattered: the newest record of one source. */
export interface MissionGateNote {
    source: string
    id: string
    state: GateState
    reason: string
    checkedAt: number
    /**
     * What the run covered, when the record carries a scope. Absent means the
     * record cannot say (a pre-`GateScope` record, or a hand-written gate) and
     * the notes say 未记录 instead of inventing a file list.
     */
    scope?: { selected: string[]; total: number; full: boolean }
}

/** One mission's section of the release notes. */
export interface MissionNotes {
    id: string
    title: string
    status: MissionStatus
    /** Whether a receipt exists — the notes render, `release_record` refuses. */
    delivered: boolean
    receiptIds: string[]
    spec?: {
        revision: number
        path?: string
        digest?: string
        approvedAt?: number
        approvedBy?: string
    }
    requirements: Requirement[]
    criteria: AcceptanceCriterion[]
    criteriaCount: number
    /** Newest gate per source, ordered by source. */
    gates: MissionGateNote[]
    /** Evidence kinds the receipts bind, with counts. */
    evidenceKinds: { kind: string; count: number }[]
    /** Rows the receipts bind (the evidence that justified the delivery). */
    evidenceCount: number
    /** Ledger rows no receipt of this mission binds (recorded after delivery). */
    unboundEvidence: number
    /** Files the bound evidence names (`artifactPath`). */
    files: string[]
    /** The delivery approver, when the receipt carries a human decision. */
    approver?: { by: string; source: string; messageId: string; receiptId: string }
}

/** Everything the notes document needs; `version` is absent on an unnamed draft. */
export interface ReleaseNotes {
    version?: string
    /**
     * Whether this document belongs to a recorded release (as opposed to a
     * read-only draft preview of what `release_record` would write).
     */
    recorded: boolean
    tag?: string
    revision?: GitFingerprint
    at: number
    missionIds: string[]
    receiptIds: string[]
    notesPath?: string
    missions: MissionNotes[]
    /** Everything the caller asked for that the record does not support. */
    warnings: string[]
}

/** Kind counts of an evidence set, ordered by kind name. */
function kindCounts(rows: readonly EvidenceRecord[]): { kind: string; count: number }[] {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((left, right) => left.kind.localeCompare(right.kind))
}

/**
 * The newest gate per source.
 *
 * Several independent axes record gates (`dsh-quality-gate`,
 * `dsh-standards-gate`, `dsh-deploy-gate`, …) and the newest record of each one
 * is what mattered; collapsing them to "the newest gate" would hide the axis
 * that did not run. Ties are broken by record id, exactly like
 * `MissionStore#lastGate`.
 */
export function gateNotes(gates: readonly GateRecord[]): MissionGateNote[] {
    const newest = new Map<string, GateRecord>()
    for (const gate of gates) {
        const current = newest.get(gate.source)
        if (current === undefined || gate.checkedAt > current.checkedAt || (gate.checkedAt === current.checkedAt && gate.id > current.id)) {
            newest.set(gate.source, gate)
        }
    }
    return [...newest.values()]
        .sort((left, right) => left.source.localeCompare(right.source))
        .map((gate) => ({
            source: gate.source,
            id: gate.id,
            state: gate.state,
            reason: gate.reason,
            checkedAt: gate.checkedAt,
            ...(gate.scope === undefined
                ? {}
                : { scope: { selected: [...gate.scope.selected], total: gate.scope.total, full: gate.scope.full } }),
        }))
}

/**
 * Requirements of a specification, tolerating a hand-written record.
 *
 * `dsh-spec-gate` writes `{id, text}` rows, but the mission record is a durable
 * file a human may edit, and a bare list of strings already occurs in the wild
 * (the test fixtures do it). The text is what the notes have to quote; a row
 * without an id is reported as 未记录 rather than being handed a number the
 * specification never assigned.
 */
function requirementRows(spec: SpecRecord | undefined): Requirement[] {
    const rows: Requirement[] = []
    for (const entry of spec?.requirements ?? []) {
        if (typeof entry === 'string') {
            if (entry !== '') rows.push({ id: '(未记录 id)', text: entry })
            continue
        }
        const row = entry as unknown as Record<string, unknown>
        if (typeof row['text'] === 'string' && row['text'] !== '') {
            rows.push({ id: typeof row['id'] === 'string' && row['id'] !== '' ? row['id'] : '(未记录 id)', text: row['text'] })
        }
    }
    return rows
}

/** Acceptance criteria of a specification, with the same tolerance. */
function criterionRows(spec: SpecRecord | undefined): AcceptanceCriterion[] {
    const rows: AcceptanceCriterion[] = []
    for (const entry of spec?.acceptanceCriteria ?? []) {
        if (typeof entry === 'string') {
            if (entry !== '') rows.push({ id: '(未记录 id)', text: entry })
            continue
        }
        const row = entry as unknown as Record<string, unknown>
        if (typeof row['text'] === 'string' && row['text'] !== '') {
            rows.push({ id: typeof row['id'] === 'string' && row['id'] !== '' ? row['id'] : '(未记录 id)', text: row['text'] })
        }
    }
    return rows
}

/** Project one mission onto its notes section. */
export function buildMissionNotes(store: MissionStore, entry: ReleaseMission): MissionNotes {
    const { mission, receipts } = entry
    const ledger = store.readEvidence(mission.id)
    const delivered = receipts.length > 0
    const bound = new Set<string>()
    for (const receipt of receipts) for (const id of receipt.evidenceIds) bound.add(id)
    // Only the rows a receipt binds are "the evidence that justified the
    // delivery": a row recorded after the receipt is reported as unbound rather
    // than folded into the release that never saw it.
    const evidence = delivered ? ledger.filter((row) => bound.has(row.id)) : ledger
    const newest = [...receipts].sort((left, right) => right.issuedAt - left.issuedAt)[0]
    const spec = mission.spec
    const requirements = requirementRows(spec)
    const criteria = criterionRows(spec)
    return {
        id: mission.id,
        title: mission.title,
        status: mission.status,
        delivered,
        receiptIds: receipts.map((receipt) => receipt.id),
        ...(spec === undefined
            ? {}
            : {
                  spec: {
                      revision: spec.revision,
                      ...(mission.specPath === undefined ? {} : { path: mission.specPath }),
                      ...(mission.specDigest === undefined ? {} : { digest: mission.specDigest }),
                      ...(spec.approvedAt === undefined ? {} : { approvedAt: spec.approvedAt }),
                      ...(spec.approvedBy === undefined ? {} : { approvedBy: spec.approvedBy }),
                  },
              }),
        requirements,
        criteria,
        criteriaCount: criteria.length,
        gates: gateNotes(store.readGates(mission.id)),
        evidenceKinds: kindCounts(evidence),
        evidenceCount: evidence.length,
        unboundEvidence: delivered ? ledger.length - evidence.length : 0,
        files: [
            ...new Set(
                evidence
                    .map((row) => row.artifactPath)
                    .filter((entry): entry is string => typeof entry === 'string' && entry !== ''),
            ),
        ].sort(),
        ...(newest?.approval === undefined ? {} : { approver: { ...newest.approval, receiptId: newest.id } }),
    }
}

/** Build the notes projection (the document itself is rendered from this). */
export function buildReleaseNotes(input: {
    store: MissionStore
    missions: readonly ReleaseMission[]
    at: number
    recorded: boolean
    version?: string
    tag?: string
    revision?: GitFingerprint
    receiptIds?: readonly string[]
    notesPath?: string
    warnings?: readonly string[]
}): ReleaseNotes {
    const missions = input.missions.map((entry) => buildMissionNotes(input.store, entry))
    return {
        ...(input.version === undefined ? {} : { version: input.version }),
        recorded: input.recorded,
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        at: input.at,
        missionIds: missions.map((note) => note.id),
        receiptIds:
            input.receiptIds === undefined
                ? [...new Set(missions.flatMap((note) => note.receiptIds))]
                : [...input.receiptIds],
        ...(input.notesPath === undefined ? {} : { notesPath: input.notesPath }),
        missions,
        warnings: [...(input.warnings ?? [])],
    }
}

// --- recording ---------------------------------------------------------------

/** Why `release_record` refused, as data (the Chinese message is rendered from it). */
export interface ReleaseRefusal {
    code:
        | 'no-version'
        | 'unsafe-version'
        | 'bad-tag'
        | 'bad-pattern'
        | 'version-format'
        | 'duplicate'
        | 'not-a-repo'
        | 'empty-mission-ids'
        | 'unknown-missions'
        | 'undelivered-missions'
        | 'nothing-to-release'
        | 'write-failed'
    /** Missions the refusal is about (`unknown-missions` / `undelivered-missions` / default set). */
    missions?: string[]
    /** The row that already carries this version (`duplicate`). */
    existing?: ReleaseRow
    /** The pattern that refused the version (`version-format` / `bad-pattern`). */
    pattern?: string
    /** Why the pattern could not be used, or why the write failed. */
    reason?: string
    /** Version the caller asked for, when it was readable. */
    version?: string
    /** Tag the caller asked for, when it was unreadable (`bad-tag`). */
    tag?: string
}

/** What `release_record` did. */
export type ReleaseOutcome =
    | {
          ok: true
          row: ReleaseRow
          /** Absolute path of the ledger. */
          file: string
          /** Absolute path of the written notes artifact. */
          notesFile: string
          notes: ReleaseNotes
          markdown: string
      }
    | { ok: false; refusal: ReleaseRefusal }

/**
 * Append one ledger row, first closing an unterminated tail line.
 *
 * `appendJsonl` writes a line as it is, so a crash that left a partial last line
 * (no trailing newline) would make the NEXT row glue onto the garbage — and both
 * would become unreadable, silently losing a release. Terminating the damaged
 * line first loses nothing (it stays a reported unreadable line, see
 * {@link readReleaseLedger}) and keeps every later append readable.
 */
function appendReleaseRow(file: string, row: ReleaseRow): void {
    const text = readText(file)
    if (text !== undefined && text !== '' && !text.endsWith('\n')) fs.appendFileSync(file, '\n')
    appendJsonl(file, row)
}

/** Input of {@link recordRelease} (the tool passes its arguments through). */
export interface RecordReleaseInput {
    store: MissionStore
    config: EvidenceGateConfig
    /** Workspace root the release is recorded for. */
    cwd: string
    /** Agent/session id recorded on the row. */
    recordedBy: string
    version?: string
    tag?: string
    missionIds?: readonly string[]
    note?: string
    /** Rendered notes, injected so the tool owns the Chinese document format. */
    renderNotes: (notes: ReleaseNotes) => string
    /** Clock, for tests. */
    now?: number
}

/**
 * Record one release: check the version, resolve the missions, write the notes
 * artifact, append the ledger row.
 *
 * Order matters: the notes are written first, so a ledger row never points at a
 * document that does not exist. A crash between the two leaves an orphan notes
 * file (harmless, overwritten by the next attempt at that version) instead of a
 * ledger row whose notes are missing.
 */
export function recordRelease(input: RecordReleaseInput): ReleaseOutcome {
    const { store, config, cwd } = input
    const layout = store.layout
    const file = releasesFileFor(layout, config)
    const ledger = readReleaseLedger(file)

    const rawVersion = input.version?.trim()
    if (rawVersion === undefined || rawVersion === '') return { ok: false, refusal: { code: 'no-version' } }
    if (!isSafeVersion(rawVersion)) return { ok: false, refusal: { code: 'unsafe-version', version: rawVersion } }

    const tag = input.tag?.trim()
    if (input.tag !== undefined && (tag === undefined || tag === '' || /[\s\u0000-\u001f]/.test(tag) || tag.includes('..'))) {
        return { ok: false, refusal: { code: 'bad-tag', version: rawVersion, tag: input.tag } }
    }

    const pattern = compileVersionPattern(config.requireTagFormat)
    if (pattern.kind === 'invalid') {
        return { ok: false, refusal: { code: 'bad-pattern', pattern: pattern.source, reason: pattern.reason, version: rawVersion } }
    }
    if (pattern.kind === 'pattern' && !pattern.regex.test(rawVersion)) {
        return { ok: false, refusal: { code: 'version-format', pattern: pattern.source, version: rawVersion } }
    }

    const existing = findRelease(ledger.rows, rawVersion)
    if (existing !== undefined) return { ok: false, refusal: { code: 'duplicate', existing, version: rawVersion } }

    // A release without a revision is not a release: the version has to name the
    // tree it points at. The engineering trail is excluded so recording does not
    // dirty the very revision it records (the receipt's fingerprint excludes it
    // too, which is what makes the two comparable).
    const revision = gitFingerprint(cwd, { excludePaths: [layout.rootDir] })
    if (!revision.isRepo) return { ok: false, refusal: { code: 'not-a-repo', version: rawVersion } }

    let selected: ReleaseMission[]
    if (input.missionIds !== undefined) {
        if (input.missionIds.length === 0) return { ok: false, refusal: { code: 'empty-mission-ids', version: rawVersion } }
        const resolved = missionsForRelease(store, input.missionIds)
        if (resolved.missing.length > 0 || resolved.undelivered.length > 0) {
            return {
                ok: false,
                refusal: {
                    code: resolved.missing.length > 0 ? 'unknown-missions' : 'undelivered-missions',
                    missions: [...resolved.missing, ...resolved.undelivered],
                    version: rawVersion,
                },
            }
        }
        selected = resolved.missions
    } else {
        selected = missionsDeliveredSince(store, previousRelease(ledger.rows))
        if (selected.length === 0) return { ok: false, refusal: { code: 'nothing-to-release', version: rawVersion } }
    }

    const at = input.now ?? Date.now()
    const notesFile = notesFileFor(layout, config, rawVersion)
    const notes = buildReleaseNotes({
        store,
        missions: selected,
        at,
        // The row is appended immediately after the document is written, so the
        // document is the record's own note (never a draft).
        recorded: true,
        version: rawVersion,
        ...(tag === undefined ? {} : { tag }),
        revision,
        notesPath: path.relative(layout.cwd, notesFile),
    })
    const markdown = input.renderNotes(notes)
    const row: ReleaseRow = {
        at,
        version: rawVersion,
        ...(tag === undefined ? {} : { tag }),
        revision,
        missionIds: notes.missionIds,
        receiptIds: notes.receiptIds,
        notesPath: path.relative(layout.cwd, notesFile),
        recordedBy: input.recordedBy,
        ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
    }
    try {
        writeTextAtomic(notesFile, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
        appendReleaseRow(file, row)
    } catch (error) {
        return {
            ok: false,
            refusal: {
                code: 'write-failed',
                version: rawVersion,
                reason: error instanceof Error ? error.message : String(error),
            },
        }
    }
    return { ok: true, row, file, notesFile, notes, markdown }
}

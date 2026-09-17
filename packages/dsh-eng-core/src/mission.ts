/**
 * The mission store: the durable contract every plugin in the suite shares.
 *
 * A *mission* is one unit of gated work. Its state lives in
 * `<root>/missions/<id>/mission.json`, its specification in
 * `<root>/specs/<id>.md`, and its evidence in an append-only JSONL ledger.
 * Plugins never talk to each other directly — spec-gate fills the spec,
 * test-design-gate the design, quality-gate the gate records, evidence-gate the
 * receipts — so any subset of the suite is independently mountable.
 *
 * Every mutation re-reads the file first (read-modify-write with an atomic
 * replace), which keeps several mounted plugins — each holding its own store
 * instance for the same root — coherent without a locking protocol.
 *
 * @module dsh-eng-core/mission
 */

import path from 'node:path'
import { missionId as buildMissionId, sha256, shortDigest, stamp } from './digest.js'
import { appendJsonl, ensureDir, listDir, readJson, readJsonl, readText, writeJsonAtomic, writeOnce, writeTextAtomic } from './io.js'
import { createLogger } from './log.js'
import type { Logger } from './log.js'
import { isInside, missionDir, resolveLayout, sessionStateFile, specFile } from './paths.js'
import type { Layout, LayoutOptions } from './paths.js'
import { parentSessionIdOf, sessionIdOf } from './session.js'
import type { AgentLike } from './session.js'
import type {
    EvidenceKind,
    EvidenceRecord,
    GateRecord,
    GateState,
    GitFingerprint,
    MissionRecord,
    MissionStatus,
    GateScope,
    Receipt,
    StageResult,
    TestDesign,
} from './types.js'

/** Structurally typed gate command result (mirrors `GateCommandResult`). */
export interface GateCommandLike {
    id: string
    name: string
    command: string
    required: boolean
    exitCode: number | null
    signal: string | null
    durationMs: number
    timedOut: boolean
    output: string
    outputDigest: string
}

/** Input for {@link MissionStore.create}. */
export interface CreateMissionInput {
    title: string
    cwd: string
    sessionId?: string
    /** Explicit id (tests and re-imports); default is derived from the title. */
    id?: string
    roles?: string[]
    labels?: string[]
}

/** Input for {@link MissionStore.appendEvidence}. */
export interface EvidenceInput {
    kind: EvidenceKind
    summary: string
    recordedBy: string
    command?: string
    exitCode?: number | null
    outputDigest?: string
    outputTail?: string
    git?: GitFingerprint
    artifactPath?: string
    data?: EvidenceRecord['data']
}

/** Input for {@link MissionStore.recordGate}. */
export interface GateInput {
    source: string
    state: GateState
    reason: string
    results: GateCommandLike[]
    fingerprint?: GitFingerprint
    /** Coverage of the run; omit when the caller cannot prove it covered everything. */
    scope?: GateScope
}

/** Input for {@link MissionStore.issueReceipt}. */
export interface ReceiptInput {
    issuedBy: string
    gateId: string
    evidenceIds: string[]
    git?: GitFingerprint
    specDigest?: string
}

/** Options for {@link MissionStore}. */
export interface MissionStoreOptions {
    layout: Layout
    logger?: Logger
}

/**
 * One mission store bound to a workspace layout.
 *
 * Instances are cheap: construct one per call site or reuse the registry.
 */
export class MissionStore {
    readonly layout: Layout
    private readonly logger: Logger

    constructor(options: MissionStoreOptions) {
        this.layout = options.layout
        this.logger = options.logger ?? createLogger({ tag: 'eng-core' })
    }

    // --- missions ---------------------------------------------------------

    /** Create and persist a new mission, or return the existing one for `input.id`. */
    create(input: CreateMissionInput): MissionRecord {
        const now = Date.now()
        // A caller-supplied id is authoritative (idempotent re-import). A
        // derived id is only second-accurate, so two intents in the same second
        // must not silently share one mission: the first free suffix wins.
        let id = input.id ?? buildMissionId(input.title, now)
        if (input.id === undefined) {
            let suffix = 2
            while (this.read(id) !== undefined) {
                id = `${buildMissionId(input.title, now)}-${suffix}`
                suffix += 1
            }
        }
        const existing = this.read(id)
        if (existing !== undefined) return existing
        const record: MissionRecord = {
            id,
            title: input.title,
            status: 'draft',
            cwd: input.cwd,
            createdAt: now,
            updatedAt: now,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.roles === undefined ? {} : { roles: input.roles }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
        }
        this.save(record)
        return record
    }

    /** Read one mission; `undefined` when absent or corrupt. */
    read(id: string): MissionRecord | undefined {
        return readJson<MissionRecord>(path.join(missionDir(this.layout, id), 'mission.json'))
    }

    /** Overwrite one mission record. */
    save(record: MissionRecord): void {
        writeJsonAtomic(path.join(missionDir(this.layout, record.id), 'mission.json'), { ...record, updatedAt: Date.now() })
    }

    /**
     * Read-modify-write one mission.
     * @param id - mission id.
     * @param mutate - applied to a copy of the current record; may return a patch.
     * @returns the stored record, or `undefined` when the mission does not exist.
     */
    update(id: string, mutate: (record: MissionRecord) => Partial<MissionRecord> | void): MissionRecord | undefined {
        const current = this.read(id)
        if (current === undefined) return undefined
        const patch = mutate(structuredClone(current)) ?? {}
        const next: MissionRecord = { ...current, ...patch, id: current.id, updatedAt: Date.now() }
        this.save(next)
        return next
    }

    /** All missions in the workspace, newest first. */
    list(): MissionRecord[] {
        const records: MissionRecord[] = []
        for (const entry of listDir(this.layout.missionsDir)) {
            const record = this.read(entry)
            if (record !== undefined) records.push(record)
        }
        return records.sort((left, right) => right.createdAt - left.createdAt)
    }

    /** The most recently updated mission, when any exists. */
    latest(): MissionRecord | undefined {
        return this.list().sort((left, right) => right.updatedAt - left.updatedAt)[0]
    }

    /** Set the mission status. */
    setStatus(id: string, status: MissionStatus): MissionRecord | undefined {
        return this.update(id, () => ({ status }))
    }

    // --- spec -------------------------------------------------------------

    /** Write the specification markdown and refresh `specPath`/`specDigest`. */
    writeSpec(id: string, markdown: string): string {
        const file = specFile(this.layout, id)
        writeTextAtomic(file, markdown)
        this.update(id, () => ({
            specPath: path.relative(this.layout.cwd, file),
            specDigest: sha256(markdown),
        }))
        return file
    }

    /** Read the specification markdown, or the empty string when absent. */
    readSpec(id: string): string {
        return readText(specFile(this.layout, id)) ?? ''
    }

    /** Absolute path of the specification artifact. */
    specPath(id: string): string {
        return specFile(this.layout, id)
    }

    /** Merge a test design into the mission record. */
    setTestDesign(id: string, design: TestDesign): MissionRecord | undefined {
        return this.update(id, () => ({ testDesign: design }))
    }

    // --- artifacts --------------------------------------------------------

    /** Absolute path of an artifact inside the mission directory. */
    artifactPath(id: string, relative: string): string {
        const dir = missionDir(this.layout, id)
        const target = path.join(dir, relative)
        // A relative artifact path is still caller input: keep it inside the
        // mission directory instead of letting `../` walk out of the workspace.
        if (!isInside(dir, target)) {
            throw new Error(`unsafe artifact path: ${JSON.stringify(relative)} escapes the mission directory`)
        }
        return target
    }

    /** Write a mission artifact (atomic) and return its absolute path. */
    writeArtifact(id: string, relative: string, text: string): string {
        const file = this.artifactPath(id, relative)
        writeTextAtomic(file, text)
        return file
    }

    /** Read a mission artifact. */
    readArtifact(id: string, relative: string): string | undefined {
        return readText(this.artifactPath(id, relative))
    }

    /** Write a mission artifact only if it does not exist yet (immutability). */
    writeArtifactOnce(id: string, relative: string, text: string): { path: string; created: boolean } {
        const file = this.artifactPath(id, relative)
        return { path: file, created: writeOnce(file, text) }
    }

    // --- evidence ---------------------------------------------------------

    /** Append one evidence record to the mission ledger. */
    appendEvidence(id: string, input: EvidenceInput): EvidenceRecord {
        const existing = this.readEvidence(id)
        // The sequence keeps ids readable; the process-local nonce keeps two
        // concurrent writers (or a pruned ledger) from minting the same id.
        const record: EvidenceRecord = {
            id: `EV-${stamp()}-${String(existing.length + 1).padStart(3, '0')}-${shortDigest(`${process.pid}:${Date.now()}:${Math.random()}`)}`,
            missionId: id,
            recordedAt: Date.now(),
            kind: input.kind,
            summary: input.summary,
            recordedBy: input.recordedBy,
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
            ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest }),
            ...(input.outputTail === undefined ? {} : { outputTail: input.outputTail }),
            ...(input.git === undefined ? {} : { git: input.git }),
            ...(input.artifactPath === undefined ? {} : { artifactPath: input.artifactPath }),
            ...(input.data === undefined ? {} : { data: input.data }),
        }
        appendJsonl(this.evidenceFile(id), record)
        this.update(id, () => ({}))
        return record
    }

    /** The mission's evidence ledger. */
    readEvidence(id: string): EvidenceRecord[] {
        return readJsonl<EvidenceRecord>(this.evidenceFile(id))
    }

    private evidenceFile(id: string): string {
        return this.artifactPath(id, 'evidence.jsonl')
    }

    // --- gates ------------------------------------------------------------

    /** Record one gate run (also appended to the evidence ledger). */
    recordGate(id: string, input: GateInput): GateRecord {
        const dir = this.artifactPath(id, 'gates')
        ensureDir(dir)
        const existing = this.readGates(id)
        const record: GateRecord = {
            id: `GATE-${stamp()}-${String(existing.length + 1).padStart(3, '0')}`,
            missionId: id,
            source: input.source,
            state: input.state,
            checkedAt: Date.now(),
            reason: input.reason,
            results: input.results,
            ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
        }
        writeJsonAtomic(path.join(dir, `${record.id}.json`), record)
        this.appendEvidence(id, {
            kind: 'gate',
            summary: `[${record.source}] ${record.state}: ${record.reason}`,
            recordedBy: record.source,
            ...(record.fingerprint === undefined ? {} : { git: record.fingerprint }),
            data: {
                gateId: record.id,
                state: record.state,
                commands: record.results.map((result) => ({
                    id: result.id,
                    exitCode: result.exitCode,
                    digest: result.outputDigest,
                })),
            },
        })
        return record
    }

    /** All recorded gate runs, oldest first. */
    readGates(id: string): GateRecord[] {
        const dir = this.artifactPath(id, 'gates')
        const records: GateRecord[] = []
        for (const entry of listDir(dir).filter((name) => name.endsWith('.json')).sort()) {
            const record = readJson<GateRecord>(path.join(dir, entry))
            if (record !== undefined) records.push(record)
        }
        return records
    }

    /**
     * The newest gate run, optionally filtered by source or state.
     *
     * "Newest" is the greatest `checkedAt` (tie-broken by record id), never the
     * last file name: a forged or re-ordered artifact must not be able to
     * shadow a newer BLOCK with an older PASS.
     */
    lastGate(id: string, filter: { source?: string; state?: GateState } = {}): GateRecord | undefined {
        const gates = this.readGates(id).filter((gate) => {
            if (filter.source !== undefined && gate.source !== filter.source) return false
            if (filter.state !== undefined && gate.state !== filter.state) return false
            return true
        })
        return gates.sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id)).at(-1)
    }

    // --- receipts ---------------------------------------------------------

    /** Issue an immutable receipt artifact and return it. */
    issueReceipt(id: string, input: ReceiptInput): Receipt {
        const body = {
            missionId: id,
            issuedAt: Date.now(),
            issuedBy: input.issuedBy,
            gateId: input.gateId,
            evidenceIds: [...input.evidenceIds].sort(),
            ...(input.git === undefined ? {} : { git: input.git }),
            ...(input.specDigest === undefined ? {} : { specDigest: input.specDigest }),
        }
        const digest = sha256(JSON.stringify(body))
        const receipt: Receipt = { id: `RCP-${stamp()}-${shortDigest(digest, 8)}`, digest, ...body }
        const relative = path.join('receipts', `${receipt.id}.json`)
        const { path: file, created } = this.writeArtifactOnce(id, relative, `${JSON.stringify(receipt, undefined, 2)}\n`)
        if (!created) this.logger.warn(`receipt ${receipt.id} already existed for ${id}`)
        return { ...receipt, path: path.relative(this.layout.cwd, file) }
    }

    /** All receipts of a mission, oldest first. */
    readReceipts(id: string): Receipt[] {
        const dir = this.artifactPath(id, 'receipts')
        const receipts: Receipt[] = []
        for (const entry of listDir(dir).filter((name) => name.endsWith('.json')).sort()) {
            const receipt = readJson<Receipt>(path.join(dir, entry))
            if (receipt !== undefined) receipts.push(receipt)
        }
        return receipts
    }

    // --- stages (orchestrator) -------------------------------------------

    /** Persist one stage result (`stages/<stageId>.json`, docs.md §4.2). */
    writeStageResult(id: string, result: StageResult): string {
        const file = this.artifactPath(id, path.join('stages', `${result.stageId}.json`))
        writeJsonAtomic(file, result)
        return file
    }

    /** Read one stage result. */
    readStageResult(id: string, stageId: string): StageResult | undefined {
        return readJson<StageResult>(this.artifactPath(id, path.join('stages', `${stageId}.json`)))
    }

    /** Every stage result, ordered by entry time. */
    listStageResults(id: string): StageResult[] {
        const dir = this.artifactPath(id, 'stages')
        const results: StageResult[] = []
        for (const entry of listDir(dir).filter((name) => name.endsWith('.json')).sort()) {
            const result = readJson<StageResult>(path.join(dir, entry))
            if (result !== undefined) results.push(result)
        }
        return results.sort((left, right) => left.enteredAt - right.enteredAt)
    }

    // --- session binding --------------------------------------------------

    /** Bind a session to a mission (the "current mission" of that session). */
    bindSession(sessionId: string, id: string, stage?: string): void {
        writeJsonAtomic(sessionStateFile(this.layout, sessionId), {
            sessionId,
            missionId: id,
            ...(stage === undefined ? {} : { stage }),
            updatedAt: Date.now(),
        })
    }

    /** Read a session's bound mission id. */
    activeMissionId(sessionId: string | undefined): string | undefined {
        if (sessionId === undefined) return undefined
        const state = readJson<{ missionId?: string }>(sessionStateFile(this.layout, sessionId))
        return state?.missionId
    }

    /** Read a session's bound mission record. */
    active(sessionId: string | undefined): MissionRecord | undefined {
        const id = this.activeMissionId(sessionId)
        return id === undefined ? undefined : this.read(id)
    }

    /**
     * The mission a call should apply to: the session's active mission, the
     * mission read back from the specification pass, or the newest mission.
     */
    resolve(sessionId: string | undefined, explicitId?: string): MissionRecord | undefined {
        if (explicitId !== undefined) return this.read(explicitId)
        const active = this.active(sessionId)
        if (active !== undefined) return active
        return this.latest()
    }

    /**
     * Resolve the mission for one live agent, honouring delegation.
     *
     * A subagent child inherits its parent's mission through the durable
     * `parentSession` in its own session header — without that, every delegated
     * writer would be denied as "no specification" the moment spec-gate is
     * mounted.
     * @param agent - the calling agent (structural view).
     * @param options - `explicitId` wins; `fallbackLatest` (off by default).
     */
    resolveForAgent(
        agent: AgentLike | undefined,
        options: { explicitId?: string; fallbackLatest?: boolean } = {},
    ): MissionRecord | undefined {
        if (options.explicitId !== undefined) return this.read(options.explicitId)
        const own = this.active(sessionIdOf(agent))
        if (own !== undefined) return own
        const parent = parentSessionIdOf(agent)
        if (parent !== undefined) {
            const inherited = this.active(parent)
            if (inherited !== undefined) return inherited
        }
        return options.fallbackLatest === true ? this.latest() : undefined
    }

    /** Drop a session binding. */
    unbindSession(sessionId: string): void {
        writeJsonAtomic(sessionStateFile(this.layout, sessionId), { sessionId, updatedAt: Date.now() })
    }
}

/** A store registry: one store per resolved workspace root. */
export class MissionStoreRegistry {
    private readonly stores = new Map<string, MissionStore>()

    constructor(private readonly options: LayoutOptions & { logger?: Logger } = {}) {}

    /**
     * Resolve (and cache) the store for one workspace.
     * @param cwd - workspace root (a session's `header.cwd`).
     */
    for(cwd: string): MissionStore {
        const layout = resolveLayout(cwd, this.options)
        const cached = this.stores.get(layout.rootDir)
        if (cached !== undefined) return cached
        const store = new MissionStore({
            layout,
            ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        })
        this.stores.set(layout.rootDir, store)
        return store
    }
}

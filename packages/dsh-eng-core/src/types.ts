/**
 * Value types shared by every plugin in the engineering suite.
 *
 * The mission record is the single source of truth that the gates read and
 * write: spec-gate fills `spec`, test-design-gate fills `testDesign`,
 * quality-gate appends `gates`, evidence-gate issues receipts, audit-trail
 * records tool history and orchestrator records stage results. Keeping the
 * shape here is what lets each plugin stay independently mountable.
 *
 * @module dsh-eng-core/types
 */

/** One lossless JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Lifecycle of one mission (a unit of work the suite gates). */
export type MissionStatus =
    | 'draft'
    | 'spec-approved'
    | 'implementing'
    | 'verified'
    | 'delivered'
    | 'blocked'

/** One acceptance criterion (`AC-001`) from the approved specification. */
export interface AcceptanceCriterion {
    /** Stable id quoted by test cases (`AC-001`). */
    id: string
    /** Unambiguous, verifiable statement. */
    text: string
}

/** One designed test case (`TC-001`). */
export interface TestCase {
    /** Stable id (`TC-001`). */
    id: string
    /** Scenario class the case belongs to. */
    kind: 'positive' | 'negative' | 'boundary'
    /** Preconditions. */
    precondition: string
    /** Operation steps. */
    steps: string
    /** Expected result. */
    expected: string
    /** Acceptance criteria this case covers (`AC-001`). */
    covers: string[]
}

/** Structured test design attached to a specification (docs.md §6). */
export interface TestDesign {
    cases: TestCase[]
    /** Ids of the acceptance criteria the design covers. */
    covered: string[]
    /** Acceptance criteria with no covering case. */
    uncovered: string[]
    /** Whether the automated review passed. */
    passed?: boolean
    /** Review findings, newest last. */
    findings?: string[]
    /** Epoch milliseconds of the last review. */
    reviewedAt?: number
    /**
     * {@link specReviewDigest} of the specification this verdict was reached
     * against. A specification revision (new/changed acceptance criteria or
     * test cases) changes the digest, which invalidates `passed` — a reviewed
     * design may never authorise a specification it has not seen.
     */
    specDigest?: string
}

/** The approved specification of one mission (docs.md §3.2). */
export interface SpecRecord {
    title: string
    background: string
    requirements: string[]
    acceptanceCriteria: AcceptanceCriterion[]
    /** Files/directories the agent may touch. */
    fileBoundaries: string[]
    /** Explicitly forbidden actions. */
    negativeConstraints: string[]
    /** Monotonic revision, bumped on every rewrite. */
    revision: number
    createdAt: number
    updatedAt: number
    approvedAt?: number
    /** Who approved it (`approval` = the harness approval seam, `auto` = configured). */
    approvedBy?: string
}

/** Evidence kinds the delivery gate accepts. */
export type EvidenceKind = 'command' | 'test' | 'gate' | 'artifact' | 'diff' | 'manual'

/** One piece of verifiable evidence bound to a mission (docs.md §3.5). */
export interface EvidenceRecord {
    id: string
    missionId: string
    kind: EvidenceKind
    summary: string
    recordedAt: number
    /** Agent/session that recorded it. */
    recordedBy: string
    /** Exact command line, for `command`/`test` evidence. */
    command?: string
    exitCode?: number | null
    /** SHA-256 of the captured output (the fingerprint a receipt binds). */
    outputDigest?: string
    /** Bounded tail of the captured output. */
    outputTail?: string
    /** Git state at recording time. */
    git?: GitFingerprint
    /** Path of the artifact, relative to the mission directory. */
    artifactPath?: string
    /** Free-form structured payload. */
    data?: JsonValue
}

/** Three-state gate outcome (docs.md §3.4). */
export type GateState = 'PASS' | 'WARN' | 'BLOCK'

/** One deterministic command registered by the host for a gate. */
export interface GateCommandResult {
    id: string
    name: string
    /** Exact command line as configured (never model-authored). */
    command: string
    required: boolean
    exitCode: number | null
    signal: string | null
    durationMs: number
    timedOut: boolean
    /** Bounded tail of stdout/stderr. */
    output: string
    outputDigest: string
}

/** What a gate run actually covered (a partial run may not authorise delivery). */
export interface GateScope {
    /** Command ids that were executed. */
    selected: string[]
    /** Command ids the host configured in total. */
    total: number
    /** `true` only when the run covered every configured command. */
    full: boolean
}

/** One gate run recorded against a mission. */
export interface GateRecord {
    id: string
    missionId: string
    /** Producing plugin id (`dsh-quality-gate`, `dsh-evidence-gate`, …). */
    source: string
    state: GateState
    checkedAt: number
    reason: string
    results: GateCommandResult[]
    /** Workspace fingerprint the gate observed. */
    fingerprint?: GitFingerprint
    /**
     * Coverage of the run. Absent on records written before this field existed;
     * consumers must treat an absent scope as "unknown", never as "full".
     */
    scope?: GateScope
}

/** Immutable delivery receipt (docs.md §3.5). */
export interface Receipt {
    id: string
    missionId: string
    issuedAt: number
    issuedBy: string
    /** SHA-256 over the receipt body (self-verifying). */
    digest: string
    /** The `PASS` gate this receipt depends on. */
    gateId: string
    evidenceIds: string[]
    git?: GitFingerprint
    specDigest?: string
    /** Relative path of the receipt file inside the mission directory. */
    path?: string
}

/** One recorded stage transition of the orchestrated pipeline (docs.md §4). */
export interface StageResult {
    stageId: string
    /** Monotonic attempt counter for this stage (retries/loops). */
    attempt: number
    state: 'entered' | 'passed' | 'failed' | 'skipped'
    enteredAt: number
    settledAt?: number
    summary?: string
    /** Gate state that decided the transition, when one applied. */
    gateState?: GateState
    /** Stage the run moved to next. */
    next?: string
}

/** Versioned workspace state of one mission. */
export interface MissionRecord {
    id: string
    title: string
    status: MissionStatus
    /** Workspace root the mission belongs to. */
    cwd: string
    createdAt: number
    updatedAt: number
    /** Session that owns the mission. */
    sessionId?: string
    /** Relative path of the specification artifact. */
    specPath?: string
    /** SHA-256 of the current spec markdown. */
    specDigest?: string
    spec?: SpecRecord
    testDesign?: TestDesign
    /** Current orchestrator stage id. */
    stage?: string
    /** Agent roles allowed to work on this mission (role-guard). */
    roles?: string[]
    /**
     * Human-review bookkeeping for the specification approval.
     *
     * The review is a LOOP: a rejection sends the model back to `spec_create`
     * with the human's note, so the round number and the last outcome are what
     * makes "第 2 次送审" visible to both sides.
     */
    approval?: MissionApproval
    /** Free-form labels. */
    labels?: string[]
}

/** Last human decision on a specification, plus the round it belongs to. */
export interface MissionApproval {
    /** `rejected` = 打回重写；`approved` = 本轮通过。 */
    state: 'rejected' | 'approved'
    /** 1-based submission round this decision closes. */
    round: number
    /** Decision time (epoch ms). */
    at: number
    /** Who decided (`approval` = the human through the seam, `auto` = configured auto). */
    by: string
    /** The human's note/reason, when they gave one. */
    note?: string
}

/** Git state captured alongside evidence. */
export interface GitFingerprint {
    /** Whether the workspace is inside a git work tree. */
    isRepo: boolean
    head?: string
    branch?: string
    /** Working tree has uncommitted changes. */
    dirty: boolean
    /** Number of changed paths (`git status --porcelain`). */
    changedFiles: number
    /** SHA-256 over `git diff HEAD` (empty diff → digest of the empty string). */
    diffDigest: string
}

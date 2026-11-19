/**
 * The shapes the split runner produces and the seams it reads.
 *
 * Kept apart from the runner so the wiring (`split-dispatch.ts`), the tests and a
 * later reader of `split/run.json` all describe the same record — and so the
 * runner file stays inside the structural size limits.
 *
 * The `worktrees` seam is the reason the runner is testable without spawning real
 * agents: every git side effect (create a worktree, read its HEAD, merge a task
 * branch, remove the worktree) goes through one object whose production value is
 * `split-run-git.ts` and whose test value is a plain in-memory fake. The DEFAULT
 * is the real one, so a caller that forgets the seam still runs on git; it is not
 * an "opt in to real git" switch that could make a deployment silently skip the
 * worktree step.
 *
 * @module dsh-orchestrator/split-run-types
 */

import path from 'node:path'
import type { AgentLike, DelegationPresets, DelegationServices, Layout } from 'dsh-eng-core'
import type { CleanupWorktreeResult, CreateWorktreeResult, ModelsConfig, ReworkReport, ReworkSignal, SplitPlan } from 'dsh-eng-core/split'

/**
 * How one task ended (a task that never started says so).
 *
 * `needs-resplit` (P3, AC-002) is the exhausted-retry outcome: every allowed
 * attempt failed, so the task must go back through a split/review round — it is
 * NOT `failed`, because the same plan re-dispatched unchanged would fail again,
 * and it is not `blocked`, because it did run. Its `dependsOn` successors are
 * `blocked` and name it.
 */
export type SplitTaskState = 'pending' | 'done' | 'failed' | 'blocked' | 'needs-resplit'

/** One task's outcome inside one run. */
export interface SplitTaskRun {
    id: string
    state: SplitTaskState
    /** The commit the task branch produced (absent when nothing was committed). */
    commit?: string
    /** Dispatch attempts (0 = never started; with retries this is 1..maxAttempts). */
    attempts: number
    /**
     * Wall time of this task's first (and only) worktree preparation, in ms
     * (P3 AC-001). Retries reuse the same worktree, so this is never re-counted
     * — and it is a PART of `startedAt..finishedAt`, not an extra cost: serial
     * execution would pay the same preparation.
     */
    prepareMs?: number
    /** When the dispatch of this task started (epoch ms, absent = never dispatched). */
    startedAt?: number
    /** When it stopped being in flight (epoch ms; filled even for a timeout). */
    finishedAt?: number
    /** Which model class the worker ran on (planner = escalated, AC-011). */
    modelClass?: 'worker' | 'planner'
    model?: string
    provider?: string
    /**
     * How this task's model was resolved when its class had no `model` (P4
     * AC-001): 「worker 模型未配置，使用宿主默认」, or the escalation's
     * 「无法升级到 planner：未配置，继续使用 …」. Absent = the class was configured.
     */
    modelNote?: string
    worktree?: string
    branch?: string
    /** Evidence rows imported into the main mission from this task. */
    imported: number
    /** Whether the worktree was removed (false when a pending import refused it). */
    cleanedUp: boolean
    /** Rework facts observed for this task (AC-011). */
    signals: ReworkSignal[]
    problems: string[]
}

/** Why the run produced the tasks it produced. */
export type SplitRunState =
    /** Workers were dispatched (the normal outcome). */
    | 'ran'
    /** AC-005: plain implement, no worktrees and no workers. */
    | 'not-worth-splitting'
    /** AC-005: too large — should be several missions. */
    | 'too-large'
    /** The plan is not the reviewed one, or the graph is unschedulable. */
    | 'refused'

/** Everything one {@link runSplitPlan} call reports (also written to `split/run.json`). */
export interface SplitRunResult {
    /** `true` only when every task finished and every one of its rows was imported. */
    ok: boolean
    state: SplitRunState
    planDigest?: string
    tasks: SplitTaskRun[]
    /** Total evidence rows imported into the main mission. */
    imported: number
    /** The rework ratio and the escalation decision (AC-011). */
    rework: ReworkReport
    /**
     * The DISTINCT model-fallback notes of this run (P4 AC-001/AC-002): a class
     * with no `model` means "host default", and this is the sentence that says so
     * in `run.json`/`report.json`/the dispatch summary. Empty = every class the
     * run needed was configured.
     */
    modelNotes: string[]
    problems: string[]
    warnings: string[]
    /** Absolute path of `split/run.json` (absent when nothing was written). */
    file?: string
    /** Absolute path of `split/report.json` (AC-005; written with `run.json`). */
    reportFile?: string
}

/** What one worktree's HEAD says. */
export interface TaskCommit {
    ok: boolean
    commit?: string
    /** The commit's subject line (the taskId prefix is checked against it). */
    subject?: string
    problems: string[]
}

/** What one branch merge did. */
export interface TaskMerge {
    ok: boolean
    /** `true` when this call merged something, `false` when it was already merged. */
    merged: boolean
    problems: string[]
}

/** The git side effects the runner performs, behind one testable seam. */
export interface SplitWorktrees {
    create(input: { mainTree: string; missionId: string; taskId: string; base?: string }): CreateWorktreeResult
    head(worktree: string): TaskCommit
    merge(input: { mainTree: string; branch: string; taskId: string }): TaskMerge
    cleanup(input: { mainTree: string; missionId: string; taskId: string }): CleanupWorktreeResult
}

/** The role-guard answer the runner needs (structural: no cross-package import). */
export interface SplitRolePlan {
    persona: string
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
}

/** The role-guard seam, narrowed to the one question the runner asks. */
export interface SplitRoleGuard {
    plan(request: { role: string; cwd?: string; agent?: AgentLike }): SplitRolePlan
    /** Record the child's role (the skill whitelist is enforced from this row). */
    bind?(request: { role: string; sessionId: string; cwd?: string; agent?: AgentLike }): unknown
}

/** Everything one run needs (one object: the runner takes exactly one parameter). */
export interface SplitRunnerDeps {
    layout: Layout
    missionId: string
    /** The main work tree (defaults to `layout.cwd`). */
    cwd?: string
    /** The plan to run; omitted = `split/plan.json`. A digest mismatch refuses. */
    plan?: SplitPlan
    /** The effective `models.json` of this workspace. */
    models: ModelsConfig
    /** Ceiling on one group's concurrency (defaults to `models.split.maxParallel`). */
    maxParallel?: number
    /** `ctx.subagents`; absent = refuse (fail closed, never "do it in prose"). */
    subagents?: DelegationServices
    /** The preset registry of the dispatching plugin (`agentPresets`). */
    presets?: DelegationPresets
    /** The role-guard service: the worker's identity and tool whitelist. */
    roleGuard?: () => SplitRoleGuard | undefined
    /** `ctx.subagents` provider name. */
    provider: string
    agent?: AgentLike
    signal?: AbortSignal
    maxDepth?: number
    /** Deadline for one worker; 0/absent = no deadline. */
    taskTimeoutMs?: number
    /** Worktree/merge seam (tests); production defaults to real git. */
    worktrees?: SplitWorktrees
    /** Where progress lines go (default: nowhere — the artifacts are the record). */
    log?: (line: string) => void
    /** Clock override (tests make `run.json` reproducible). */
    now?: () => number
}

/**
 * One run's mutable state, shared by the runner and its finishing steps.
 *
 * A plain record (not a class): the finish helpers are pure functions over it, so
 * "what happened" is exactly what `split/run.json` holds.
 */
export interface SplitRunBook {
    layout: Layout
    missionId: string
    /** Absolute workspace root (the main work tree). */
    mainTree: string
    planDigest: string
    models: ModelsConfig
    maxParallel: number
    seam: SplitWorktrees
    /** Run start (epoch ms). */
    at: number
    /**
     * When the run finished its dispatch+finish steps (epoch ms; filled by the
     * finishing step). `finishedAt - at` is the wall clock `report.json`'s
     * economics is built from (P3 AC-001).
     */
    finishedAt?: number
    /**
     * The clock used for `at` and for per-task durations (tests freeze it).
     *
     * Kept on the book because the report's `durationMs` must come from the same
     * clock as everything else in the run: mixing `Date.now()` into a run whose
     * `at` is frozen makes two identical runs differ by a few milliseconds.
     * @returns milliseconds since the epoch.
     */
    now: () => number
    /**
     * `dependsOn` per plan task id (the plan's graph).
     *
     * Kept on the book so a task that exhausts its retries can NAME the successors
     * it will block (AC-002) without the runner threading the plan through every
     * dispatch call.
     */
    taskDeps: Record<string, string[]>
    /**
     * The groups actually handed to the scheduler, in execution order (AC-005
     * asks the report's parallelism to be the REAL one, not the plan's text).
     */
    groups: string[][]
    /** One record per plan task, in plan order (even tasks that never started). */
    tasks: SplitTaskRun[]
    problems: string[]
    warnings: string[]
    log: (line: string) => void
}

/** `missions/<id>/split/run.json` — the durable record of one dispatch. */
export function splitRunFile(layout: Layout, missionId: string): string {
    return path.join(layout.missionsDir, missionId, 'split', 'run.json')
}

/** `missions/<id>/split/report.json` — the read-only cost/quality report (AC-005). */
export function splitReportFile(layout: Layout, missionId: string): string {
    return path.join(layout.missionsDir, missionId, 'split', 'report.json')
}

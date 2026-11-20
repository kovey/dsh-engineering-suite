/**
 * The split plan: the artifact a planner produces before any worker starts.
 *
 * One plan is a list of tasks (what to do, which paths it owns, which
 * acceptance criteria it satisfies, what it depends on), a coverage map from
 * acceptance criterion to tasks, and the parallel groups the orchestrator may
 * run at once. Its DIGEST is the identity a review binds to: edit the plan and
 * the digest changes, which is exactly what makes "reviewed" a statement about
 * THIS plan and not about a document that used to look like it.
 *
 * This module owns the shape, the digest and the files
 * (`missions/<id>/split/plan.json` and the worktree conventions of AC-006); the
 * three automatic checks live in `split-validate.ts`, the human review in
 * `split-review.ts`.
 *
 * @module dsh-eng-core/split-plan
 */

import path from 'node:path'
import { sha256 } from './digest.js'
import { readJson } from './io.js'
import { assertSafeId, missionDir, type Layout } from './paths.js'

/** One task of a split plan (AC-002). */
export interface SplitTask {
    /** Stable id inside the plan (`T-001`); also the worktree/branch suffix. */
    id: string
    /** What this task must achieve. */
    goal: string
    /** Workspace-relative paths/patterns this task owns. */
    paths: string[]
    /** Acceptance criteria (`AC-001`) this task satisfies. */
    acceptance: string[]
    /** Task ids that must be finished first. */
    dependsOn: string[]
    /** Whether this task may run next to its group's other tasks. */
    parallel: boolean
}

/** The whole plan for one mission. */
export interface SplitPlan {
    /** Mission the plan belongs to (checked by the writer, not by the shape). */
    missionId?: string
    tasks: SplitTask[]
    /** Acceptance criterion → task ids that cover it. */
    coverage: Record<string, string[]>
    /** Groups of task ids that may run at the same time. */
    parallelGroups: string[][]
    /** When the plan was produced (epoch ms). */
    createdAt?: number
    /** Who produced it (`planner`). */
    generatedBy?: string
}

/** A plan as read from disk, with the digest computed from its bytes-as-JSON. */
export interface StoredSplitPlan {
    /** Absolute path of `plan.json`. */
    file: string
    plan: SplitPlan
    /** Canonical SHA-256 of the plan (see {@link splitPlanDigest}). */
    digest: string
}

/** JSON with object keys sorted, so two equal plans always digest equally. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/** The identity of a plan: what a review approves and what an import verifies. */
export function splitPlanDigest(plan: unknown): string {
    return sha256(canonicalJson(plan))
}

/** Directory holding one mission's split artifacts (`missions/<id>/split`). */
export function splitDir(layout: Layout, missionId: string): string {
    return path.join(missionDir(layout, missionId), 'split')
}

/** `missions/<id>/split/plan.json`. */
export function splitPlanFile(layout: Layout, missionId: string): string {
    return path.join(splitDir(layout, missionId), 'plan.json')
}

/** `missions/<id>/split/review.json` (the latest human decision). */
export function splitReviewFile(layout: Layout, missionId: string): string {
    return path.join(splitDir(layout, missionId), 'review.json')
}

/** `missions/<id>/split/reviews.jsonl` (every decision, append-only). */
export function splitReviewsFile(layout: Layout, missionId: string): string {
    return path.join(splitDir(layout, missionId), 'reviews.jsonl')
}

/**
 * Read one plan and its digest.
 * @param layout - the workspace layout.
 * @param missionId - the mission whose plan to read.
 * @returns the plan, or `undefined` when it does not exist (or is corrupt).
 */
export function readSplitPlan(layout: Layout, missionId: string): StoredSplitPlan | undefined {
    const file = splitPlanFile(layout, missionId)
    const plan = readJson<SplitPlan>(file)
    if (plan === undefined || typeof plan !== 'object' || plan === null) return undefined
    return { file, plan, digest: splitPlanDigest(plan) }
}

/**
 * The plan digest of a mission, when a plan exists.
 *
 * Reads through {@link readSplitPlan} on purpose: a digest and the object it
 * describes must never come from two different reads.
 * @param layout - the workspace layout.
 * @param missionId - the mission.
 */
export function splitPlanDigestOf(layout: Layout, missionId: string): string | undefined {
    return readSplitPlan(layout, missionId)?.digest
}

/** Root of every task worktree (`<root>/worktrees`, gitignored). */
export function worktreeRoot(layout: Layout): string {
    return path.join(layout.rootDir, 'worktrees')
}

/** `.dsh/engineering-suite/worktrees/<missionId>/<taskId>` (AC-006 path). */
export function splitWorktreeDir(layout: Layout, missionId: string, taskId: string): string {
    return path.join(worktreeRoot(layout), assertSafeId(missionId, 'mission id'), assertSafeId(taskId, 'task id'))
}

/** The branch one task commits on (`split/<missionId>/<taskId>`). */
export function splitTaskBranch(missionId: string, taskId: string): string {
    return `split/${assertSafeId(missionId, 'mission id')}/${assertSafeId(taskId, 'task id')}`
}

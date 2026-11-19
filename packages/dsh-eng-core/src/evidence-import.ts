/**
 * The importer: after a task branch is merged, decide which of its local
 * evidence rows may enter the MAIN mission ledger (AC-008).
 *
 * The dangerous direction is "be helpful": appending the rows that look fine and
 * reporting the rest turns a partially landed merge into a delivery whose
 * evidence nobody can reconstruct. So the rule is inverted — every row is
 * verified against durable facts, and if ANY row fails the whole batch is
 * refused with the offending rows named. Nothing is written in that case, not
 * even the rows that passed.
 *
 * Four facts per row:
 *
 *  1. the row's shape is a legal evidence row (kind/at/id/…, `evidence-rows.ts`);
 *  2. its `taskId` exists in the REVIEWED plan — the review's digest must still
 *     match the plan on disk, or the plan changed after a human saw it;
 *  3. its `commit` is part of the main tree's history
 *     (`git merge-base --is-ancestor`, run against an absolute `-C` path);
 *  4. its `(taskId, at, id)` identity is not in the main ledger yet (duplicates
 *     are skipped, not an error: importing twice is a no-op).
 *
 * Accepted rows are appended through the mission store (so the ledger contract
 * is unchanged) and every accepted row leaves a source-mapping record
 * (`missions/<id>/evidence-sources.jsonl`) naming the task, worktree, branch and
 * commit it came from.
 *
 * @module dsh-eng-core/evidence-import
 */

import path from 'node:path'
import { importedEvidenceKey, parseWorkerEvidenceRow, workerEvidenceKey, type WorkerEvidenceRow } from './evidence-rows.js'
import { pendingImports } from './evidence-pending.js'
import { isMergedInto } from './git.js'
import { appendJsonl } from './io.js'
import { MissionStore, type EvidenceInput } from './mission.js'
import { missionDir, resolveLayout, type Layout } from './paths.js'
import { readSplitPlan, splitTaskBranch, splitWorktreeDir, type SplitPlan } from './split-plan.js'
import { readSplitReview } from './split-review.js'

/** Input of {@link importTaskEvidence}. */
export interface ImportTaskEvidenceInput {
    /** Absolute path of the main work tree (the workspace root). */
    mainTree: string
    /** Mission the rows are imported into. */
    missionId: string
    /** Digest the caller believes it reviewed; a mismatch refuses the batch. */
    planDigest?: string
    /** Candidate rows; omitted = every row still pending in the task worktrees. */
    rows?: unknown[]
    /** Layout override (tests / a host that relocated the trail). */
    layout?: Layout
    /** Who performed the import (default `split-import`). */
    recordedBy?: string
    /** Import timestamp override (default: now). */
    at?: number
}

/** One row accepted into the main ledger. */
export interface ImportedEvidence {
    taskId: string
    /** The worker-side row id (kept inside `data.import.id`). */
    workerId: string
    at: number
    /** Id of the appended main-ledger evidence record. */
    evidenceId: string
    commit: string
}

/** A row that was already imported (skipped, never duplicated). */
export interface SkippedEvidence {
    taskId: string
    workerId: string
    at: number
    reason: 'duplicate'
}

/** One source-mapping line: which task/worktree/branch/commit produced what. */
export interface EvidenceSourceRow {
    missionId: string
    taskId: string
    worktree: string
    branch: string
    commit: string
    importedAt: number
    evidenceIds: string[]
}

/** Verdict of one import run. */
export interface ImportTaskEvidenceResult {
    /** `true` only when every candidate row was accepted (or skipped as duplicate). */
    ok: boolean
    imported: ImportedEvidence[]
    skipped: SkippedEvidence[]
    sources: EvidenceSourceRow[]
    /** Named rejections; when non-empty NOTHING was written. */
    problems: string[]
}

/** The reviewed plan, or the reasons the batch may not be imported at all. */
function reviewedPlan(input: ImportTaskEvidenceInput, layout: Layout, store: MissionStore, problems: string[]): SplitPlan | undefined {
    if (store.read(input.missionId) === undefined) {
        problems.push(`mission ${input.missionId} 不存在（${missionDir(layout, input.missionId)} 下没有 mission.json）：无法导入证据`)
        return undefined
    }
    const plan = readSplitPlan(layout, input.missionId)
    if (plan === undefined) {
        problems.push(`mission ${input.missionId} 没有拆分计划（split/plan.json 缺失）：未审核的拆分不允许导入证据`)
        return undefined
    }
    const review = readSplitReview(layout, input.missionId)
    if (review === undefined) {
        problems.push('拆分计划还没有人工审核记录（split/review.json 缺失）：证据不予导入（AC-008 要求已审核 plan）')
    } else if (review.decision !== 'approved') {
        problems.push(`拆分计划审核未通过（decision=${review.decision}）：证据不予导入`)
    } else if (review.planDigest !== plan.digest) {
        problems.push(
            `审核记录绑定的 plan 摘要 ${review.planDigest.slice(0, 12)} 与当前 plan 摘要 ${plan.digest.slice(0, 12)} 不一致：plan 已改动，必须重新审核`,
        )
    }
    if (input.planDigest !== undefined && input.planDigest !== plan.digest) {
        problems.push(
            `传入的 planDigest ${input.planDigest.slice(0, 12)} 与当前 plan 摘要 ${plan.digest.slice(0, 12)} 不一致：拒绝导入（要求重新审核后再导入）`,
        )
    }
    // A third digest source: the caller may pass the reviewed digest while the
    // file was edited in between — that is the same refusal, answered by the
    // comparison above.
    return plan.plan
}

/** Parse every candidate row, collecting all shape problems. */
function parseRows(raw: readonly unknown[], problems: string[]): WorkerEvidenceRow[] {
    const rows: WorkerEvidenceRow[] = []
    raw.forEach((entry, index) => {
        const parsed = parseWorkerEvidenceRow(entry, index)
        problems.push(...parsed.problems)
        if (parsed.row !== undefined) rows.push(parsed.row)
    })
    return rows
}

/** The `(taskId, at, id)` identities already present in the main ledger. */
function existingKeys(store: MissionStore, missionId: string): Set<string> {
    const keys = new Set<string>()
    for (const record of store.readEvidence(missionId)) {
        const key = importedEvidenceKey(record)
        if (key !== undefined) keys.add(key)
    }
    return keys
}

/** Why one row's commit is not acceptable (AC-008 fact 3). */
function commitProblem(mainTree: string, row: WorkerEvidenceRow, index: number): string | undefined {
    const check = isMergedInto(mainTree, row.commit)
    if (check.merged) return undefined
    const where = `rows[${index}]（id=${row.id}，taskId=${row.taskId}，commit=${row.commit.slice(0, 12)}）`
    return check.exitCode === null
        ? `${where} 的 commit 无法核验：git 未能执行（${check.error ?? 'unknown'}）——按未合并处理`
        : `${where} 的 commit 尚未合并进主树（git merge-base --is-ancestor 退出码 ${check.exitCode}）：不接受未落地的证据`
}

/** Verify task membership, de-duplication and merge state (facts 2-4). */
function verifyRows(
    rows: readonly WorkerEvidenceRow[],
    plan: SplitPlan,
    mainTree: string,
    existing: ReadonlySet<string>,
    problems: string[],
): { ready: WorkerEvidenceRow[]; skipped: SkippedEvidence[] } {
    const taskIds = new Set(plan.tasks.map((task) => task.id))
    const ready: WorkerEvidenceRow[] = []
    const skipped: SkippedEvidence[] = []
    rows.forEach((row, index) => {
        if (!taskIds.has(row.taskId)) {
            problems.push(`rows[${index}]（id=${row.id}）的 taskId ${row.taskId} 不在已审核 plan 里（可用：${[...taskIds].join('、') || '(空)'}）`)
            return
        }
        if (existing.has(workerEvidenceKey(row.taskId, row.at, row.id))) {
            skipped.push({ taskId: row.taskId, workerId: row.id, at: row.at, reason: 'duplicate' })
            return
        }
        const problem = commitProblem(mainTree, row, index)
        if (problem !== undefined) problems.push(problem)
        else ready.push(row)
    })
    return { ready, skipped }
}

/** The main-ledger input for one accepted row (its worker identity is nested). */
function ledgerInputFor(row: WorkerEvidenceRow, importedAt: number, recordedBy: string): EvidenceInput {
    const imported = { taskId: row.taskId, at: row.at, id: row.id, commit: row.commit, importedAt }
    return {
        kind: row.kind,
        summary: row.summary,
        recordedBy,
        ...(row.command === undefined ? {} : { command: row.command }),
        ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
        ...(row.outputDigest === undefined ? {} : { outputDigest: row.outputDigest }),
        ...(row.outputTail === undefined ? {} : { outputTail: row.outputTail }),
        data: { import: imported, ...(row.data === undefined ? {} : { worker: row.data }) },
    }
}

/** Append the accepted rows to the main ledger, one evidence record each. */
function appendRows(
    store: MissionStore,
    missionId: string,
    rows: readonly WorkerEvidenceRow[],
    importedAt: number,
    recordedBy: string,
): ImportedEvidence[] {
    return rows.map((row) => {
        const record = store.appendEvidence(missionId, ledgerInputFor(row, importedAt, recordedBy))
        return { taskId: row.taskId, workerId: row.id, at: row.at, evidenceId: record.id, commit: row.commit }
    })
}

/** Group the accepted rows into source-mapping lines (task × commit). */
function sourceRowsOf(
    layout: Layout,
    missionId: string,
    imported: readonly ImportedEvidence[],
    rows: readonly WorkerEvidenceRow[],
    importedAt: number,
): EvidenceSourceRow[] {
    const groups = new Map<string, EvidenceSourceRow>()
    imported.forEach((entry, index) => {
        const row = rows[index]
        if (row === undefined) return
        const key = `${entry.taskId}\u0000${entry.commit}`
        const existing = groups.get(key)
        if (existing !== undefined) {
            existing.evidenceIds.push(entry.evidenceId)
            return
        }
        groups.set(key, {
            missionId,
            taskId: entry.taskId,
            worktree: row.worktree ?? splitWorktreeDir(layout, missionId, entry.taskId),
            branch: row.branch ?? splitTaskBranch(missionId, entry.taskId),
            commit: entry.commit,
            importedAt,
            evidenceIds: [entry.evidenceId],
        })
    })
    return [...groups.values()]
}

/**
 * Import a batch of worker evidence rows into the main mission.
 *
 * @param input - main tree, mission, the reviewed digest and the candidate rows.
 * @returns the accepted rows, the duplicates, the source mapping and every
 *   named rejection. When `problems` is non-empty NOTHING was written.
 */
export function importTaskEvidence(input: ImportTaskEvidenceInput): ImportTaskEvidenceResult {
    // Absolute on purpose: `git -C <mainTree>` must answer about THIS tree, never
    // about whatever the process cwd happens to be.
    const mainTree = path.resolve(input.mainTree)
    const layout = input.layout ?? resolveLayout(mainTree)
    const store = new MissionStore({ layout })
    const problems: string[] = []
    const plan = reviewedPlan(input, layout, store, problems)
    const candidate = input.rows ?? pendingImports({ mainTree, missionId: input.missionId, layout }).flatMap((entry) => entry.rows)
    const rows = parseRows(candidate, problems)
    if (plan === undefined) return { ok: false, imported: [], skipped: [], sources: [], problems }
    const { ready, skipped } = verifyRows(rows, plan, mainTree, existingKeys(store, input.missionId), problems)
    if (problems.length > 0) return { ok: false, imported: [], skipped, sources: [], problems }
    const importedAt = input.at ?? Date.now()
    const imported = appendRows(store, input.missionId, ready, importedAt, input.recordedBy ?? 'split-import')
    const sources = sourceRowsOf(layout, input.missionId, imported, ready, importedAt)
    const sourcesFile = path.join(missionDir(layout, input.missionId), 'evidence-sources.jsonl')
    for (const source of sources) appendJsonl(sourcesFile, source)
    return { ok: true, imported, skipped, sources, problems }
}

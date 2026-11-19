/**
 * The split runner: turn a REVIEWED plan into parallel work (AC-006 / AC-011).
 *
 * The contract in five sentences:
 *
 *  1. **No review, no dispatch.** The plan on disk must still be the one a human
 *     approved (the same digest the review recorded); an edited plan, a rejected
 *     plan or a plan the caller passed a different object for refuses the WHOLE
 *     run before a single worktree exists.
 *  2. **Groups are serial, tasks inside a group are parallel up to a ceiling.**
 *     `parallelGroups` is a ceiling, not a schedule: the groups are topologically
 *     ordered by `dependsOn` first, and a task whose dependencies have not
 *     FINISHED is never started (asserted at the start of every dispatch, not
 *     only in the scheduler).
 *  3. **One task = one worktree + one worker.** The worker starts INSIDE its own
 *     worktree with the `worker` role and the `models.json` route (see
 *     `split-worker.ts`), and must leave a commit whose subject starts with
 *     `<taskId>:`; anything else is rework.
 *  4. **Finish: merge → import → cleanup → report.** Merging is what AC-008's
 *     importer verifies, importing refuses to guess, cleanup is only allowed
 *     after the import landed (AC-009), and the ratio + threshold go into
 *     `split/rework.json` and `split/run.json`.
 *  5. **It never issues a receipt and never writes a gate record.** A worker's
 *     partial-scope gate is not delivery evidence (AC-010); the receipt belongs to
 *     the lead, after the merged main tree passes the full gate.
 *
 * Every git side effect is behind `deps.worktrees` (production: `split-run-git.ts`),
 * so the tests drive the real scheduler against a fake repository seam.
 *
 * @module dsh-orchestrator/split-runner
 */

import path from 'node:path'
import { computeRework, decideSplit, readSplitPlan, readSplitReview, splitPlanDigest, type ModelsConfig, type ReworkReport, type SplitPlan, type SplitTask } from 'dsh-eng-core/split'
import { failTask, finishDispatchedRun, finishSkippedRun, taskRecordOf } from './split-run-finish.js'
import { defaultSplitWorktrees } from './split-run-git.js'
import { planOrder, unmetDeps } from './split-run-order.js'
import type { SplitRunBook, SplitRunnerDeps, SplitRunResult, SplitTaskRun } from './split-run-types.js'
import { prepareDispatch, routeFor, startWorker, type WorkerDispatch } from './split-worker.js'

/** The plan to run, plus every reason it must not be dispatched. */
interface PlanTarget {
    plan?: SplitPlan
    digest: string
    problems: string[]
}

/** The concurrency ceiling of one group (never below 1, never NaN). */
function maxParallelOf(deps: SplitRunnerDeps): number {
    const declared = deps.maxParallel ?? deps.models.split.maxParallel
    if (typeof declared !== 'number' || !Number.isFinite(declared)) return 1
    return Math.max(1, Math.floor(declared))
}

/** The report of a run that started nothing. */
function emptyRework(models: ModelsConfig): ReworkReport {
    return computeRework({ tasks: [], threshold: models.quality.maxReworkRatio })
}

/**
 * The reviewed plan, or the reasons nothing may be dispatched.
 *
 * Three digest facts are compared: the plan on disk, the digest the reviewer
 * recorded, and (when the caller passes an object) the caller's own plan. Any
 * mismatch means the document being dispatched is not the document that was
 * approved.
 */
function resolvePlan(deps: SplitRunnerDeps): PlanTarget {
    const stored = readSplitPlan(deps.layout, deps.missionId)
    if (stored === undefined) {
        return { digest: '', problems: [`mission ${deps.missionId} 没有拆分计划（split/plan.json 缺失）：没有可派发的任务`] }
    }
    const problems: string[] = []
    if (deps.plan !== undefined) {
        const passed = splitPlanDigest({ ...deps.plan, missionId: deps.plan.missionId ?? deps.missionId })
        if (passed !== stored.digest) {
            problems.push(`传入的 plan 摘要 ${passed.slice(0, 12)} 与 split/plan.json 的摘要 ${stored.digest.slice(0, 12)} 不一致：plan 已改动，拒绝派发`)
        }
    }
    const review = readSplitReview(deps.layout, deps.missionId)
    if (review === undefined) {
        problems.push('拆分计划还没有人工审核记录（split/review.json 缺失）：未经审核的拆分不允许派发 worker')
    } else if (review.decision !== 'approved') {
        problems.push(`拆分计划审核未通过（decision=${review.decision}）：不允许派发 worker`)
    } else if (review.planDigest !== stored.digest) {
        problems.push(
            `审核记录绑定的 plan 摘要 ${review.planDigest.slice(0, 12)} 与当前 plan 摘要 ${stored.digest.slice(0, 12)} 不一致：plan 已改动，必须重新审核后才能派发`,
        )
    }
    return { plan: stored.plan, digest: stored.digest, problems }
}

/** The run's mutable state (one record per plan task, even ones that never start). */
function newBook(deps: SplitRunnerDeps, target: PlanTarget): SplitRunBook {
    return {
        layout: deps.layout,
        missionId: deps.missionId,
        mainTree: path.resolve(deps.cwd ?? deps.layout.cwd),
        planDigest: target.digest,
        models: deps.models,
        maxParallel: maxParallelOf(deps),
        seam: deps.worktrees ?? defaultSplitWorktrees(),
        at: (deps.now ?? Date.now)(),
        tasks: (target.plan?.tasks ?? []).map(
            (task): SplitTaskRun => ({ id: task.id, state: 'pending', attempts: 0, imported: 0, cleanedUp: false, signals: [], problems: [] }),
        ),
        problems: [],
        warnings: [],
        log: deps.log ?? (() => undefined),
    }
}

/** The tasks that finished successfully, as a set (the dependency oracle). */
function doneIds(book: SplitRunBook): Set<string> {
    return new Set(book.tasks.filter((record) => record.state === 'done').map((record) => record.id))
}

/** Mark one task as never started, naming why. */
function blockTask(book: SplitRunBook, task: SplitTask, reason: string): void {
    const record = taskRecordOf(book, task.id)
    if (record !== undefined) {
        record.state = 'blocked'
        record.problems.push(reason)
    }
    book.problems.push(`子任务 ${task.id} 未启动：${reason}`)
}

/** Run ONE task: worktree → worker → commit prefix → done/failed (AC-006). */
async function runTask(book: SplitRunBook, deps: SplitRunnerDeps, task: SplitTask, dispatch: WorkerDispatch): Promise<void> {
    const record = taskRecordOf(book, task.id)
    if (record === undefined) return
    const unmet = unmetDeps(task, doneIds(book))
    if (unmet.length > 0) {
        // The scheduler already ordered the groups; this is the per-dispatch
        // assertion AC-006 asks for ("dependsOn 未完成的子任务不得启动").
        blockTask(book, task, `依赖 ${unmet.join('、')} 尚未完成`)
        return
    }
    const route = routeFor(book)
    record.modelClass = route.modelClass
    record.model = route.model
    record.provider = route.provider
    if (route.model === undefined) {
        failTask(book, record, route.problems.length > 0 ? route.problems : [`模型类 ${route.modelClass} 没有配置 model`], 'acceptance-failed')
        return
    }
    const created = book.seam.create({ mainTree: book.mainTree, missionId: book.missionId, taskId: task.id })
    record.worktree = created.worktree
    record.branch = created.branch
    if (!created.ok) {
        failTask(book, record, created.problems, 'acceptance-failed')
        return
    }
    record.attempts = 1
    const failure = await startWorker(book, deps, { task, dispatch, worktree: created.worktree, route })
    if (failure !== undefined) {
        failTask(book, record, [failure], 'acceptance-failed')
        return
    }
    const head = book.seam.head(created.worktree)
    record.commit = head.commit
    if (!head.ok || head.commit === undefined) {
        failTask(book, record, head.problems.length > 0 ? head.problems : ['读不到 worktree 的 HEAD commit'], 'acceptance-failed')
        return
    }
    const prefix = `${task.id}:`
    if (!(head.subject ?? '').startsWith(prefix)) {
        failTask(
            book,
            record,
            [`commit ${head.commit.slice(0, 12)} 的标题 ${JSON.stringify(head.subject ?? '')} 不带前缀 "${prefix}"：无法证明它属于子任务 ${task.id}`],
            'acceptance-failed',
        )
        return
    }
    record.state = 'done'
    book.log(`子任务 ${task.id} 完成：commit ${head.commit.slice(0, 8)}（${route.modelClass} ${route.model}）`)
}

/** One group: chunks of at most `maxParallel` eligible tasks, chunks serial. */
async function runGroup(book: SplitRunBook, deps: SplitRunnerDeps, group: readonly SplitTask[], dispatch: WorkerDispatch): Promise<void> {
    let remaining = [...group]
    while (remaining.length > 0) {
        if (deps.signal?.aborted === true) {
            for (const task of remaining) blockTask(book, task, '调用方已取消（signal 已 abort）')
            return
        }
        const done = doneIds(book)
        const eligible = remaining.filter((task) => unmetDeps(task, done).length === 0)
        if (eligible.length === 0) {
            for (const task of remaining) blockTask(book, task, `依赖 ${unmetDeps(task, done).join('、')} 未完成（失败或阻塞）`)
            return
        }
        const chunk = eligible.slice(0, book.maxParallel)
        await Promise.all(chunk.map((task) => runTask(book, deps, task, dispatch)))
        remaining = remaining.filter((task) => !chunk.includes(task))
    }
}

/**
 * Run one reviewed plan.
 *
 * @param deps - layout, mission, plan, models, the subagents/role-guard seams and
 *   the worktree seam (production default = real git).
 * @returns what happened per task, how many rows were imported, the rework report
 *   and the path of `split/run.json`. Never throws for a refusal: a refusal is a
 *   result with `state` naming it.
 */
export async function runSplitPlan(deps: SplitRunnerDeps): Promise<SplitRunResult> {
    const target = resolvePlan(deps)
    const book = newBook(deps, target)
    if (target.plan === undefined || target.problems.length > 0) return finishSkippedRun(book, 'refused', emptyRework(deps.models), target.problems)
    const decision = decideSplit(target.plan, deps.models.split)
    if (decision.decision !== 'split') {
        book.warnings.push(...decision.reasons)
        return finishSkippedRun(book, decision.decision, emptyRework(deps.models), [])
    }
    const order = planOrder(target.plan)
    if (order.problems.length > 0) return finishSkippedRun(book, 'refused', emptyRework(deps.models), order.problems)
    const ready = await prepareDispatch(book, deps)
    if (ready.dispatch === undefined) return finishSkippedRun(book, 'refused', emptyRework(deps.models), [ready.refusal ?? '派发前提不成立'])
    for (const group of order.groups) await runGroup(book, deps, group, ready.dispatch)
    return finishDispatchedRun(book)
}

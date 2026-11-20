/**
 * How ONE task is attempted, retried WITHIN BOUNDS, and what an exhausted task
 * leaves behind (AC-002 of P3).
 *
 * The rules in five sentences:
 *
 *  1. **One worktree, several attempts.** The worktree is created once, before
 *     the first attempt, at a recorded BASE commit; a retry re-dispatches a
 *     worker into the SAME directory (so a worker's local `.dsh/` ledger
 *     accumulates across attempts and the import/cleanup discipline is untouched
 *     — nothing here deletes anything).
 *  2. **A task's commits are `base..HEAD`, never bare `HEAD`.** A worker that
 *     committed nothing leaves HEAD on the base commit; that commit may be
 *     somebody else's (a dsh-memory session-end auto-commit is the real case),
 *     and its subject takes part in NO judgment. `0` new commits is its own
 *     failure ("no commit"), distinct from "committed with a wrong subject" —
 *     with ONE exception: a DIRTY worktree means "changed but forgot to commit",
 *     so the runner commits it and judges again (`split-run-autocommit.ts`).
 *     A CLEAN worktree still fails as "no commit".
 *  3. **Retries are bounded by `split.maxAttempts`** (default 1, hard ceiling 3,
 *     see `splitMaxAttempts`). Every attempt increments `attempts`.
 *  4. **Each failed attempt counts as rework.** The signal (`acceptance-failed`,
 *     `timeout`) stays on the task even when a later attempt succeeds: the task
 *     really was worked on twice, and the rework ratio exists to show that. A
 *     model class nobody configured is NOT a failure and never enters this
 *     signal (P4 AC-001) — the task runs on the host default instead.
 *  5. **Exhausted is not `failed`.** A task that used every allowed attempt is
 *     `needs-resplit`: re-dispatching the same plan unchanged would fail again,
 *     so it must go back through split/review. Its `dependsOn` successors are
 *     `blocked` and name it. A NON-retryable cause (the worktree could not be
 *     created) stays `failed`, because a new plan would not fix a configuration
 *     mistake.
 *
 * @module dsh-orchestrator/split-run-attempt
 */

import { splitMaxAttempts, type NextTaskRoute, type ReworkSignal, type SplitTask } from 'dsh-eng-core/split'
import { shortCommit, verifyTaskCommit } from './split-run-autocommit.js'
import { failTask, note, taskRecordOf } from './split-run-finish.js'
import type { SplitRunBook, SplitRunnerDeps, SplitTaskRun } from './split-run-types.js'
import { routeFor, startWorker, type WorkerDispatch } from './split-worker.js'

/** What one attempt produced (an attempt that finished returns `undefined`). */
interface AttemptFailure {
    problems: string[]
    /** The rework signal this failure means. */
    signal: ReworkSignal
    /** `false` = re-dispatching the same thing cannot help (configuration/worktree). */
    retryable: boolean
}

/** Everything one task's attempts share: one worktree, one route, one worker role. */
interface AttemptTarget {
    task: SplitTask
    record: SplitTaskRun
    dispatch: WorkerDispatch
    worktree: string
    /** The base recorded at creation (full commit id): the task's commits are `base..HEAD`. */
    base: string
    route: NextTaskRoute
}

/** AC-003: a commit the RUNNER made is recorded on the task, and is never silent. */
function recordAutocommit(book: SplitRunBook, record: SplitTaskRun, noteText: string | undefined): void {
    record.autocommit = true
    if (noteText === undefined) return
    record.problems.push(noteText)
    book.warnings.push(noteText)
    book.log(noteText)
}

/**
 * Dispatch the worker once and verify the commit contract.
 *
 * The commit judgment (`base..HEAD`, the prefix, and the fallback that commits for
 * a worker that forgot) lives in `split-run-autocommit.ts`; this function only
 * decides what a non-ok verdict means for the attempt.
 *
 * @returns `undefined` when the task is done (the commit is on its branch), else
 *   the failure with its rework signal.
 */
async function attemptOnce(book: SplitRunBook, deps: SplitRunnerDeps, target: AttemptTarget): Promise<AttemptFailure | undefined> {
    const failure = await startWorker(book, deps, {
        task: target.task,
        dispatch: target.dispatch,
        worktree: target.worktree,
        route: target.route,
    })
    if (failure !== undefined) {
        // AC-003: a deadline stop is a `timeout` rework signal. The worktree and
        // its local ledger are KEPT (nothing here removes them) so the import and
        // cleanup steps can still consume what the worker wrote.
        return { problems: [failure.detail], signal: failure.timeout === true ? 'timeout' : 'acceptance-failed', retryable: true }
    }
    const verdict = verifyTaskCommit(book, { task: target.task, worktree: target.worktree, base: target.base })
    // Recorded even when the verdict is "wrong prefix": `run.json` must be able to
    // name the commit the worker actually pushed. Absent = no commit at all.
    target.record.commit = verdict.commit
    if (!verdict.ok) return { problems: verdict.problems, signal: 'acceptance-failed', retryable: true }
    // AC-002: the record names the commit AND who made it (autocommit is absent
    // when the worker committed itself — TC-2901's "缺省").
    if (verdict.autocommit === true) recordAutocommit(book, target.record, verdict.note)
    return undefined
}

/** Record one attempt's failure WITHOUT deciding the task's fate (it may retry). */
function recordAttemptFailure(book: SplitRunBook, record: SplitTaskRun, failure: AttemptFailure): void {
    for (const problem of failure.problems) {
        record.problems.push(problem)
        book.log(`子任务 ${record.id}：第 ${record.attempts} 次尝试失败：${problem}`)
    }
    if (!record.signals.includes(failure.signal)) record.signals.push(failure.signal)
}

/**
 * The task's LAST allowed attempt failed: mark `needs-resplit` and name the
 * successors that will be blocked.
 *
 * `needs-resplit` (not `failed`) is the verdict AC-002 asks for: the plan needs
 * another split/review round, not another identical dispatch. The last attempt's
 * detail goes into the RUN-level problems as well (the per-attempt trail stays on
 * the task), so `run.json` answers "why did this end here" without the reader
 * correlating two arrays.
 */
function finishExhausted(book: SplitRunBook, record: SplitTaskRun, failure: AttemptFailure, maxAttempts: number): void {
    record.state = 'needs-resplit'
    note(book, `子任务 ${record.id} 用尽 ${maxAttempts} 次尝试仍失败（每次失败见该任务的 problems）：标记 needs-resplit，必须重新拆分/审核后才能再派发`)
    for (const problem of failure.problems) book.problems.push(`子任务 ${record.id} 最后一次尝试：${problem}`)
    const successors = successorIds(book, record.id)
    if (successors.length === 0) {
        book.log(`子任务 ${record.id}：没有 dependsOn 后继被阻塞`)
        return
    }
    note(book, `子任务 ${record.id} 的 dependsOn 后继 ${successors.join('、')} 一律 blocked（不会启动，等重新拆分）`)
}

/** The tasks whose `dependsOn` names `taskId` (the ones this failure blocks). */
export function successorIds(book: SplitRunBook, taskId: string): string[] {
    return Object.entries(book.taskDeps)
        .filter(([, deps]) => deps.includes(taskId))
        .map(([id]) => id)
        .sort()
}

/**
 * The block reason for tasks whose dependencies did not finish.
 *
 * A dependency that exhausted its retries is NAMED as needing a new split, so
 * "blocked" does not read like "still running" (AC-002: 点名该任务).
 */
export function unmetReason(book: SplitRunBook, unmet: readonly string[]): string {
    const named = unmet.map((id) => (taskRecordOf(book, id)?.state === 'needs-resplit' ? `${id}（需要重新拆分）` : id))
    return `依赖 ${named.join('、')} 未完成（失败或阻塞）`
}

/** Run the attempts of one task (bounded by `split.maxAttempts`). */
async function runAttempts(book: SplitRunBook, deps: SplitRunnerDeps, target: AttemptTarget): Promise<void> {
    const { task, record } = target
    const maxAttempts = splitMaxAttempts(book.models.split)
    for (;;) {
        record.attempts += 1
        const failure = await attemptOnce(book, deps, target)
        if (failure === undefined) {
            record.state = 'done'
            book.log(`子任务 ${task.id} 完成：commit ${(record.commit ?? '').slice(0, 8)}（${record.modelClass} ${record.model ?? '宿主默认'}；第 ${record.attempts} 次尝试）`)
            return
        }
        if (!failure.retryable) {
            failTask(book, record, failure.problems, failure.signal)
            return
        }
        recordAttemptFailure(book, record, failure)
        if (record.attempts >= maxAttempts) {
            finishExhausted(book, record, failure, maxAttempts)
            return
        }
        book.log(`子任务 ${task.id}：第 ${record.attempts}/${maxAttempts} 次尝试失败，复用同一 worktree 重新派发：${target.worktree}`)
    }
}

/**
 * Record how an unconfigured model class continued (P4 AC-001/AC-002).
 *
 * `models.json` is an OVERRIDE layer: "nobody pinned a model" means "use the host
 * default" (`agentOptionsOf` already omits `model`/`provider`), never "this task
 * failed". The note goes on the task record so `run.json`, `report.json` and the
 * dispatch summary all carry the same sentence.
 */
function recordModelNote(book: SplitRunBook, record: SplitTaskRun, route: NextTaskRoute): void {
    if (route.note === undefined) return
    record.modelNote = route.note
    book.log(`子任务 ${record.id}：${route.note}`)
}

/**
 * Prepare ONE task (route → worktree) and run its bounded attempts.
 *
 * @param book - the run state (problems/warnings/log and the worktree seam).
 * @param deps - the delegation seams and the caller's agent/signal.
 * @param task - the plan task to dispatch.
 * @param dispatch - the resolved worker delegation of this run.
 */
export async function dispatchTask(book: SplitRunBook, deps: SplitRunnerDeps, task: SplitTask, dispatch: WorkerDispatch): Promise<void> {
    const record = taskRecordOf(book, task.id)
    if (record === undefined) return
    const route = routeFor(book)
    record.modelClass = route.modelClass
    record.model = route.model
    record.provider = route.provider
    recordModelNote(book, record, route)
    // AC-001: the FIRST preparation is timed (retries reuse the worktree and are
    // not preparation). It is a part of the task's duration, not an extra cost.
    const prepareStart = book.now()
    // AC-001: the base is the main tree's HEAD read BEFORE the worktree exists,
    // and it is pinned as the branch's start point. Recording it is what makes
    // "the worker's commits" a diff set later (`base..HEAD`) instead of "whatever
    // HEAD happens to be" — which is how another plugin's commit got judged as
    // this task's output.
    const baseHead = book.seam.head(book.mainTree)
    if (!baseHead.ok || baseHead.commit === undefined) {
        record.prepareMs = Math.max(0, book.now() - prepareStart)
        failTask(book, record, baseHead.problems.length > 0 ? baseHead.problems : ['读不到主树 HEAD：无法记录子任务的 base'], 'acceptance-failed')
        return
    }
    const created = book.seam.create({ mainTree: book.mainTree, missionId: book.missionId, taskId: task.id, base: baseHead.commit })
    record.prepareMs = Math.max(0, book.now() - prepareStart)
    record.worktree = created.worktree
    record.branch = created.branch
    if (!created.ok) {
        failTask(book, record, created.problems, 'acceptance-failed')
        return
    }
    record.base = shortCommit(baseHead.commit)
    await runAttempts(book, deps, { task, record, dispatch, worktree: created.worktree, base: baseHead.commit, route })
}

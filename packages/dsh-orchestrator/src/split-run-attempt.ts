/**
 * How ONE task is attempted, retried WITHIN BOUNDS, and what an exhausted task
 * leaves behind (AC-002 of P3).
 *
 * The rules in four sentences:
 *
 *  1. **One worktree, several attempts.** The worktree is created once, before
 *     the first attempt; a retry re-dispatches a worker into the SAME directory
 *     (so a worker's local `.dsh/` ledger accumulates across attempts and the
 *     import/cleanup discipline is untouched — nothing here deletes anything).
 *  2. **Retries are bounded by `split.maxAttempts`** (default 1, hard ceiling 3,
 *     see `splitMaxAttempts`). Every attempt increments `attempts`.
 *  3. **Each failed attempt counts as rework.** The signal (`acceptance-failed`,
 *     `timeout`) stays on the task even when a later attempt succeeds: the task
 *     really was worked on twice, and the rework ratio exists to show that.
 *  4. **Exhausted is not `failed`.** A task that used every allowed attempt is
 *     `needs-resplit`: re-dispatching the same plan unchanged would fail again,
 *     so it must go back through split/review. Its `dependsOn` successors are
 *     `blocked` and name it. A NON-retryable cause (no model configured, the
 *     worktree could not be created) stays `failed`, because a new plan would not
 *     fix a configuration mistake.
 *
 * @module dsh-orchestrator/split-run-attempt
 */

import { splitMaxAttempts, type NextTaskRoute, type ReworkSignal, type SplitTask } from 'dsh-eng-core/split'
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
    route: NextTaskRoute
}

/**
 * Dispatch the worker once and verify the commit contract.
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
    const head = book.seam.head(target.worktree)
    target.record.commit = head.commit
    if (!head.ok || head.commit === undefined) {
        return { problems: head.problems.length > 0 ? head.problems : ['读不到 worktree 的 HEAD commit'], signal: 'acceptance-failed', retryable: true }
    }
    const prefix = `${target.task.id}:`
    if (!(head.subject ?? '').startsWith(prefix)) {
        return {
            problems: [`commit ${head.commit.slice(0, 12)} 的标题 ${JSON.stringify(head.subject ?? '')} 不带前缀 "${prefix}"：无法证明它属于子任务 ${target.task.id}`],
            signal: 'acceptance-failed',
            retryable: true,
        }
    }
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
            book.log(`子任务 ${task.id} 完成：commit ${(record.commit ?? '').slice(0, 8)}（${record.modelClass} ${record.model}；第 ${record.attempts} 次尝试）`)
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
    if (route.model === undefined) {
        // Not retryable and not a re-split problem: a missing model class is a
        // deployment mistake, so it stays `failed` (the P1 meaning).
        failTask(book, record, route.problems.length > 0 ? route.problems : [`模型类 ${route.modelClass} 没有配置 model`], 'acceptance-failed')
        return
    }
    // AC-001: the FIRST preparation is timed (retries reuse the worktree and are
    // not preparation). It is a part of the task's duration, not an extra cost.
    const prepareStart = book.now()
    const created = book.seam.create({ mainTree: book.mainTree, missionId: book.missionId, taskId: task.id })
    record.prepareMs = Math.max(0, book.now() - prepareStart)
    record.worktree = created.worktree
    record.branch = created.branch
    if (!created.ok) {
        failTask(book, record, created.problems, 'acceptance-failed')
        return
    }
    await runAttempts(book, deps, { task, record, dispatch, worktree: created.worktree, route })
}

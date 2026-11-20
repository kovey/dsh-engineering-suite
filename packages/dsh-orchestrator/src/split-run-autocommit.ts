/**
 * What a task's commits prove (`base..HEAD`), and the runner's ONE fallback when
 * the worker changed files but forgot to commit (AC-001/AC-002/AC-003 of "worker
 * 必须提交").
 *
 * The rules in three sentences:
 *
 *  1. **The judgment is the diff set `base..HEAD`, never bare `HEAD`.** A worker
 *     that committed nothing leaves HEAD on the base commit, and that commit may
 *     belong to another plugin (a dsh-memory session-end auto-commit is the real
 *     case), so its subject takes part in NO judgment.
 *  2. **`0` new commits is ambiguous, and the worktree resolves it.** A dirty
 *     worktree means "changed but did not commit" → the runner runs
 *     `git add -A && git commit -m "<taskId>: <summary>（run 由 runner 代提交）"`
 *     and judges again; a CLEAN worktree means "produced nothing at all" → the
 *     task still fails with 「worker 没有产生提交」. The fallback must never mask
 *     that second case (the negative constraint of this mission).
 *  3. **A fallback commit is never silent.** `run.json` records
 *     `tasks[].autocommit: true` and the same sentence goes into that task's
 *     `problems` (and the run's `warnings`), so "who made this commit" is
 *     answerable from the artifacts. It is NOT a rework signal: the rework ratio
 *     still answers "how often was this task worked on", not "who fixed the
 *     commit".
 *
 * This module owns the commit TEXT and the judgment, not the seam: it reads git
 * through `book.seam` so the tests keep driving the real scheduler against a fake
 * repository when they want to.
 *
 * @module dsh-orchestrator/split-run-autocommit
 */

import type { SplitTask } from 'dsh-eng-core/split'
import type { SplitRunBook, TaskCommits } from './split-run-types.js'

/** What one worktree's uncommitted changes look like (`git status --porcelain`). */
export interface TaskDirty {
    ok: boolean
    /** `true` when at least one path is changed (tracked or untracked). */
    dirty: boolean
    problems: string[]
}

/** What the runner's fallback commit did (AC-002/AC-003). */
export interface TaskAutocommit {
    ok: boolean
    /** The commit it created (absent when git refused). */
    commit?: string
    problems: string[]
}

/** One task whose commit contract is being judged. */
export interface CommitTarget {
    task: SplitTask
    worktree: string
    /** The commit the worktree started on (full id): the task's commits are `base..HEAD`. */
    base: string
}

/**
 * The verdict on one task's commits (AC-002's three-way judgment).
 *
 * `ok` is "a NEW commit whose subject carries `<taskId>:` exists" — never "HEAD
 * looks right". `autocommit`/`note` are present only when the runner created that
 * commit itself (AC-003: the record must say so).
 */
export interface CommitVerdict {
    ok: boolean
    /** The commit to record in `run.json` (only when a new commit exists). */
    commit?: string
    /** `true` when the runner created the commit (AC-002/AC-003). */
    autocommit?: true
    /** AC-003's sentence, present whenever `autocommit` is true. */
    note?: string
    problems: string[]
}

/** The first 8 characters of a commit id (the short hash reports use). */
export function shortCommit(commit: string): string {
    return commit.slice(0, 8)
}

/**
 * Whether one commit subject carries THIS task's id: `T-001:` at the start.
 *
 * A full-width colon (`T-001：`) counts too: it is the same prefix typed with an
 * IME on, and rejecting it would rework a worker for punctuation.
 */
export function carriesTaskPrefix(subject: string, taskId: string): boolean {
    return subject.startsWith(`${taskId}:`) || subject.startsWith(`${taskId}：`)
}

/** AC-002/AC-003: zero NEW commits — a different fact from a wrong prefix. */
export function noCommitProblem(base: string): string {
    return `worker 没有产生提交（HEAD 仍是基线 ${shortCommit(base)}）：无法证明这次任务做过任何事`
}

/**
 * AC-002: the task committed, but none of its new subjects carries its id.
 *
 * The base commit's subject is NOT quoted anywhere: it belongs to whatever the
 * branch started on, and naming it as the task's commit is the bug this text
 * replaces. The list is the subjects of `base..HEAD`, capped at three.
 */
export function missingPrefixProblem(input: { taskId: string; count: number; base: string; head: string; subjects: readonly string[] }): string {
    const listed = input.subjects
        .slice(0, 3)
        .map((subject) => JSON.stringify(subject))
        .join('、')
    const more = input.subjects.length > 3 ? `（共 ${input.count} 个，只列前 3 个）` : ''
    return `本次 ${input.count} 个新提交里没有一个带 "${input.taskId}:" 前缀（base ${shortCommit(input.base)} → HEAD ${shortCommit(input.head)}）：无法证明它属于子任务 ${input.taskId}。新提交标题${more}：${listed}`
}

/**
 * The message the runner uses when it commits on the worker's behalf.
 *
 * The `<taskId>:` prefix is not decoration: the judgment below (and the reviewer's
 * `git log`) reads it, so a fallback commit is attributable exactly like a
 * worker's own one, plus the parenthetical that says who actually made it.
 */
export function autocommitMessage(task: SplitTask): string {
    return `${task.id}: ${task.goal}（run 由 runner 代提交）`
}

/** AC-003's sentence: durable proof in `run.json` that the runner, not the worker, committed. */
export function autocommitNote(taskId: string, commit: string): string {
    return `runner 代提交：${taskId} 的 worker 没有提交，但 worktree 有未提交改动，已由 runner 代提交 ${shortCommit(commit)}（run.json 的 tasks[].autocommit=true）`
}

/** One read of a worktree's HEAD + `base..HEAD` (a refusal is a result, never a throw). */
type CommitRead = { ok: true; head: string; own: TaskCommits } | { ok: false; problems: string[] }

/** Read the worktree's HEAD and its commits on top of `base`, naming why a read failed. */
function readCommits(book: SplitRunBook, target: CommitTarget): CommitRead {
    const head = book.seam.head(target.worktree)
    if (!head.ok || head.commit === undefined) {
        return { ok: false, problems: head.problems.length > 0 ? head.problems : ['读不到 worktree 的 HEAD commit'] }
    }
    const own = book.seam.commits(target.worktree, target.base)
    if (!own.ok) {
        return {
            ok: false,
            problems: own.problems.length > 0 ? own.problems : [`无法读取 ${target.worktree} 相对基线 ${shortCommit(target.base)} 的新提交`],
        }
    }
    return { ok: true, head: head.commit, own }
}

/** Judge one successful read: any subject of `base..HEAD` carrying the id is enough (AC-002). */
function judgeSubjects(target: CommitTarget, read: Extract<CommitRead, { ok: true }>): CommitVerdict {
    if (read.own.subjects.some((subject) => carriesTaskPrefix(subject, target.task.id))) {
        return { ok: true, commit: read.head, problems: [] }
    }
    const input = { taskId: target.task.id, count: read.own.count, base: target.base, head: read.head, subjects: read.own.subjects }
    // The commit is STILL reported: a wrong subject is "committed with a wrong
    // title", and `run.json` must be able to name what the worker actually pushed.
    return { ok: false, commit: read.head, problems: [missingPrefixProblem(input)] }
}

/** What the fallback decided: it committed, it could not, or there was nothing to commit. */
interface FallbackOutcome {
    committed: boolean
    problems: string[]
}

/**
 * Commit the worker's leftovers — ONLY when the worktree is actually dirty.
 *
 * A clean worktree returns `{ committed: false, problems: [] }` and the caller
 * reports 「worker 没有产生提交」 unchanged: this is the negative constraint, and
 * it is why `status` is read before anything is written.
 */
function fallbackCommit(book: SplitRunBook, target: CommitTarget): FallbackOutcome {
    const status = book.seam.status(target.worktree)
    if (!status.ok) {
        return {
            committed: false,
            problems: status.problems.length > 0 ? status.problems : [`无法读取 ${target.worktree} 的工作区状态：runner 不猜它改没改`],
        }
    }
    if (!status.dirty) return { committed: false, problems: [] }
    const made = book.seam.autocommit({ worktree: target.worktree, message: autocommitMessage(target.task) })
    if (made.ok && made.commit !== undefined) return { committed: true, problems: [] }
    return {
        committed: false,
        problems: made.problems.length > 0 ? made.problems : [`runner 代提交失败：${target.worktree} 的 git commit 没有产生提交`],
    }
}

/**
 * Verify one task's commits, letting the runner finish the job when the worker
 * changed files but did not commit (AC-002), and never when it changed nothing.
 *
 * @param book - the run state (its `seam` is the only git access used here).
 * @param target - the task, its worktree and the base it started on.
 * @returns the verdict; a failure carries the exact sentence for `problems`.
 */
export function verifyTaskCommit(book: SplitRunBook, target: CommitTarget): CommitVerdict {
    const first = readCommits(book, target)
    if (!first.ok) return { ok: false, problems: first.problems }
    if (first.own.count > 0) return judgeSubjects(target, first)
    // AC-002: `0` commits is ambiguous — dirty = "forgot to commit", clean = "did nothing".
    const fallback = fallbackCommit(book, target)
    if (fallback.problems.length > 0) return { ok: false, problems: fallback.problems }
    if (!fallback.committed) return { ok: false, problems: [noCommitProblem(target.base)] }
    const again = readCommits(book, target)
    if (!again.ok) return { ok: false, problems: again.problems }
    const judged = judgeSubjects(target, again)
    if (!judged.ok) return judged
    // AC-003: the record says the runner made this commit — never silent.
    return { ...judged, autocommit: true, note: autocommitNote(target.task.id, again.head) }
}

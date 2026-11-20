/**
 * The production value of the runner's worktree seam: real `git`.
 *
 * Every side effect the split runner performs on a repository goes through here,
 * so the runner itself never shells out and a test can replace the whole
 * filesystem/git story with an in-memory fake:
 *
 *  - `create` / `cleanup` are the already-tested library calls
 *    (`createTaskWorktree` / `cleanupTaskWorktree`), including AC-009's refusal to
 *    remove a worktree whose evidence is still unimported;
 *  - `head` answers "what is this tree's HEAD" — the main tree's HEAD becomes the
 *    task's recorded base before the worktree exists, the worktree's HEAD after;
 *  - `commits` answers "what did the worker commit" as the DIFF SET `base..HEAD`
 *    (count + subjects). A worker that committed nothing leaves HEAD on the base
 *    commit, and the base commit takes part in NO judgment (it may be another
 *    plugin's session-end auto-commit) — the `<taskId>:` prefix check reads only
 *    the subjects of commits the worker added;
 *  - `merge` merges the task BRANCH into the main tree, because AC-008's importer
 *    only accepts commits that are already in the main tree's history. A failed
 *    merge is aborted (`git merge --abort`) and reported: leaving conflict
 *    markers and a `MERGE_HEAD` behind would poison every later merge and every
 *    "clean tree" check of the main tree.
 *
 * @module dsh-orchestrator/split-run-git
 */

import { spawnSync } from 'node:child_process'
import { cleanupTaskWorktree, createTaskWorktree } from 'dsh-eng-core/split'
import type { SplitWorktrees, TaskCommit, TaskCommits, TaskMerge } from './split-run-types.js'

/** One git invocation; never throws (a refusal is a result). */
function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string; error?: string } {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000 })
    if (result.error !== undefined) return { status: null, stdout: '', stderr: '', error: result.error.message }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The tail of one command's output, bounded for a report line. */
function tail(text: string, max = 400): string {
    const trimmed = text.trim()
    return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

/** Why a git call failed, in one phrase (`spawn error` > stderr > exit code). */
function reasonOf(result: { status: number | null; stderr: string; error?: string }): string {
    if (result.error !== undefined) return result.error
    const stderr = tail(result.stderr)
    return stderr === '' ? `git exit ${String(result.status)}` : stderr
}

/**
 * Read the commits one worktree's HEAD has on top of `base` (AC-002).
 *
 * This is the task's OWN work: `base` is the commit the worktree was created on,
 * so a worker that committed nothing answers `count: 0` here no matter what the
 * base commit's subject happens to be. Reading `git log -1` instead would read
 * somebody else's commit (the base) and judge its subject as if the worker wrote
 * it — the failure mode this function exists to remove.
 *
 * @param worktree - absolute path of the task worktree.
 * @param base - the commit-ish recorded when the worktree was created.
 */
export function taskCommits(worktree: string, base: string): TaskCommits {
    const range = `${base}..HEAD`
    const counted = git(worktree, ['rev-list', '--count', range])
    const count = Number.parseInt(counted.stdout.trim(), 10)
    if (counted.status !== 0 || !Number.isInteger(count) || count < 0) {
        return { ok: false, count: 0, subjects: [], problems: [`无法读取 ${worktree} 相对基线 ${base} 的新提交数（${reasonOf(counted)}）：子任务没有可核验的 commit`] }
    }
    if (count === 0) return { ok: true, count: 0, subjects: [], problems: [] }
    const logged = git(worktree, ['log', '--format=%s', range])
    if (logged.status !== 0) {
        return { ok: false, count, subjects: [], problems: [`无法读取 ${worktree} 相对基线 ${base} 的新提交标题（${reasonOf(logged)}）：无法校验子任务前缀`] }
    }
    return { ok: true, count, subjects: logged.stdout.split('\n').filter((line) => line !== ''), problems: [] }
}

/**
 * Read one tree's HEAD commit id.
 * @param worktree - absolute path of the worktree (the main tree included).
 */
export function headCommit(worktree: string): TaskCommit {
    const rev = git(worktree, ['rev-parse', 'HEAD'])
    const commit = rev.stdout.trim()
    if (rev.status !== 0 || commit === '') {
        return { ok: false, problems: [`无法读取 worktree ${worktree} 的 HEAD（${reasonOf(rev)}）：子任务没有产出可核验的 commit`] }
    }
    return { ok: true, commit, problems: [] }
}

/**
 * Merge one task branch into the main tree (no fast-forward: the merge commit is
 * the record that this branch landed).
 * @param input - main tree, branch and task id.
 */
export function mergeTaskBranch(input: { mainTree: string; branch: string; taskId: string }): TaskMerge {
    const landed = git(input.mainTree, ['merge-base', '--is-ancestor', input.branch, 'HEAD'])
    if (landed.status === 0) return { ok: true, merged: false, problems: [] }
    const merge = git(input.mainTree, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', input.branch])
    if (merge.status === 0) return { ok: true, merged: true, problems: [] }
    // A failed merge leaves MERGE_HEAD + conflict markers: abort, then report.
    git(input.mainTree, ['merge', '--abort'])
    return {
        ok: false,
        merged: false,
        problems: [
            `把分支 ${input.branch}（子任务 ${input.taskId}）合并进主树失败：${reasonOf(merge)}`,
            '已执行 git merge --abort：主树保持合并前的状态，该子任务记为合并冲突（返工）。',
        ],
    }
}

/**
 * The real worktree seam (what a deployment runs).
 * @returns the five operations, all safe to call repeatedly.
 */
export function defaultSplitWorktrees(): SplitWorktrees {
    return {
        create: (input) => createTaskWorktree(input),
        head: headCommit,
        commits: taskCommits,
        merge: mergeTaskBranch,
        cleanup: (input) => cleanupTaskWorktree(input),
    }
}

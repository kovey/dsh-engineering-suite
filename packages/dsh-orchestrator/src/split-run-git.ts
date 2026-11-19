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
 *  - `head` answers "what did this task actually commit" — the commit id and its
 *    subject, which is what the `<taskId>:` prefix check reads;
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
import type { SplitWorktrees, TaskCommit, TaskMerge } from './split-run-types.js'

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
 * Read one worktree's HEAD commit and subject.
 * @param worktree - absolute path of the task worktree.
 */
export function headCommit(worktree: string): TaskCommit {
    const rev = git(worktree, ['rev-parse', 'HEAD'])
    const commit = rev.stdout.trim()
    if (rev.status !== 0 || commit === '') {
        return { ok: false, problems: [`无法读取 worktree ${worktree} 的 HEAD（${reasonOf(rev)}）：子任务没有产出可核验的 commit`] }
    }
    const subject = git(worktree, ['log', '-1', '--format=%s']).stdout.trim()
    return { ok: true, commit, subject, problems: [] }
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
 * @returns the four operations, all safe to call repeatedly.
 */
export function defaultSplitWorktrees(): SplitWorktrees {
    return {
        create: (input) => createTaskWorktree(input),
        head: headCommit,
        merge: mergeTaskBranch,
        cleanup: (input) => cleanupTaskWorktree(input),
    }
}

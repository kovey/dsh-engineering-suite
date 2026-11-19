/**
 * The task worktree lifecycle (AC-006 / AC-009).
 *
 * A parallel task runs in its own `git worktree` on its own branch so two
 * children never edit the same files. Two operations are enough for the
 * workflow, and both are deliberately conservative:
 *
 *  - {@link createTaskWorktree} puts the tree UNDER the repository
 *    (`<root>/worktrees/<missionId>/<taskId>`, gitignored) and refuses a layout
 *    that would place it outside the main tree: a worktree outside the repo can
 *    neither be ignored nor audited as part of it.
 *  - {@link cleanupTaskWorktree} asks "is any worker evidence still unimported?"
 *    FIRST. A worktree is a directory, and removing it removes the only copy of
 *    that task's local evidence — so a pending import is a refusal that PRINTS
 *    the list (AC-009), and a failing `git worktree remove` never falls back to
 *    deleting the directory.
 *
 * A library (not a script) because the caller is the orchestrator and the tests
 * need the same function an operator would run; `scripts/split-worktree.sh` is
 * the thin CLI over it for manual use.
 *
 * @module dsh-eng-core/worktree
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describePendingImport, pendingImports, type PendingWorkerImport } from './evidence-pending.js'
import { isInside, isReallyInside, realTargetOf, resolveLayout, type Layout } from './paths.js'
import { splitTaskBranch, splitWorktreeDir, worktreeRoot } from './split-plan.js'

/** Input of {@link createTaskWorktree}. */
export interface CreateWorktreeInput {
    /** Absolute path of the main work tree (the workspace root). */
    mainTree: string
    missionId: string
    taskId: string
    /** Commit-ish the branch starts at (default `HEAD`). */
    base?: string
    /** Layout override (tests / a relocated trail). */
    layout?: Layout
}

/** Outcome of one creation. */
export interface CreateWorktreeResult {
    ok: boolean
    /** `true` only when this call created the worktree. */
    created: boolean
    /** Absolute worktree path (always known, even on failure). */
    worktree: string
    branch: string
    /** What the `.gitignore` state was (`already` / `appended`). */
    gitignore?: 'already' | 'appended'
    problems: string[]
}

/** Input of {@link cleanupTaskWorktree}. */
export interface CleanupWorktreeInput {
    mainTree: string
    missionId: string
    taskId: string
    layout?: Layout
}

/** Outcome of one cleanup. */
export interface CleanupWorktreeResult {
    ok: boolean
    /** `true` only when this call removed the worktree. */
    removed: boolean
    /** `true` when there was nothing left to remove (repeated cleanup). */
    alreadyGone: boolean
    worktree: string
    branch: string
    /** Unimported evidence that refused the cleanup (AC-009). */
    pending: PendingWorkerImport[]
    problems: string[]
}

/** One git invocation; never throws (a refusal is a result). */
function git(mainTree: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string; error?: string } {
    const result = spawnSync('git', ['-C', mainTree, ...args], { encoding: 'utf8', timeout: 30_000 })
    if (result.error !== undefined) {
        return { status: null, stdout: '', stderr: '', error: result.error.message }
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * `fs.realpathSync` of the deepest existing ancestor, with the unresolved tail
 * kept: the worktree root does not exist yet, but its CONTAINMENT must still be
 * decided on real paths (`/var` and `/private/var` are the same directory on
 * macOS, and git always answers with the real one).
 */
function real(target: string): string {
    return realTargetOf(target)
}

/** The repository root (`mainTree` itself when git cannot say), realpath'd. */
function repoTop(mainTree: string): string {
    const result = git(mainTree, ['rev-parse', '--show-toplevel'])
    const top = result.status === 0 ? result.stdout.trim() : ''
    // git answers with the REAL path, while a caller may hold a symlinked one
    // (/var vs /private/var on macOS). Both sides are normalised, like
    // `gitFingerprint` does, or every containment check would be false there.
    return top === '' ? real(mainTree) : real(top)
}

/** The `.gitignore` line that keeps a workspace-relative directory out of git. */
function ignoreRuleFor(top: string, target: string): string {
    return `/${path.relative(top, target).split(path.sep).join('/').replace(/\/+$/, '')}/`
}

/** Whether git already ignores `target`. */
function isIgnored(mainTree: string, target: string): boolean {
    const relative = path.relative(real(mainTree), real(target))
    const result = git(mainTree, ['check-ignore', '-q', '--', relative === '' ? '.' : relative])
    return result.status === 0
}

/**
 * Make sure the worktree root is gitignored, appending the rule when missing.
 *
 * Reported (`gitignore: 'appended'`) rather than silent: writing the host's
 * `.gitignore` is a real change to the repository, and a caller that runs in a
 * checkout it does not own must be able to see it happened.
 */
function ensureIgnored(mainTree: string, root: string): { state: 'already' | 'appended'; note?: string; problem?: string } {
    if (isIgnored(mainTree, root)) return { state: 'already' }
    const top = repoTop(mainTree)
    const rule = ignoreRuleFor(top, real(root))
    const file = path.join(top, '.gitignore')
    try {
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        if (!existing.split('\n').includes(rule)) {
            const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
            fs.writeFileSync(file, `${prefix}${rule}\n`)
        }
    } catch (error) {
        return { state: 'already', problem: `worktree 根没有被 .gitignore 忽略，且无法写 ${file}（${(error as Error).message}）：拒绝创建，否则主树会被工作副本弄脏` }
    }
    // Trust git's answer, not the text we just wrote: a later negation rule (or
    // a global exclude) can still leave the directory tracked.
    if (!isIgnored(mainTree, root)) return { state: 'appended', problem: `已写入 ${file} 的规则 ${rule}，但 git 仍不认为该目录被忽略：拒绝创建` }
    return { state: 'appended', note: `已在 ${file} 追加 ${rule}` }
}

/** Whether `dir` is a live worktree of `mainTree` (has its own `.git` entry). */
function isLiveWorktree(dir: string): boolean {
    try {
        return fs.statSync(path.join(dir, '.git')).isFile()
    } catch {
        return false
    }
}

/** The branch a live worktree is on (`undefined` when git cannot say). */
function branchOf(mainTree: string, dir: string): string | undefined {
    const result = git(mainTree, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (result.status !== 0) return undefined
    const name = result.stdout.trim()
    return name === '' || name === 'HEAD' ? undefined : name
}

/** A failure result with every field filled in. */
function failure(worktree: string, branch: string, problems: string[]): CreateWorktreeResult {
    return { ok: false, created: false, worktree, branch, problems }
}

/** The path guard: the worktree must live under the main tree's worktrees root. */
function pathProblem(mainTree: string, root: string): string | undefined {
    if (!isReallyInside(mainTree, root)) {
        return `worktree 根 ${root} 不在主树 ${mainTree} 内：无法被 .gitignore 忽略，也无法作为仓库的一部分审计（layout.rootDir 指到了仓库外）`
    }
    const top = repoTop(mainTree)
    if (!isInside(top, real(root))) {
        return `worktree 根 ${root} 不在 git 仓库 ${top} 内：.gitignore 无法忽略仓库外的目录`
    }
    return undefined
}

/**
 * Create one task's worktree and branch (AC-006).
 *
 * Idempotent: a worktree already on the documented branch is reported as
 * `created: false` instead of failing, so a retried dispatch does not leave the
 * caller with a half-created task.
 * @param input - main tree, mission/task ids, base commit-ish.
 * @returns the worktree path, its branch, and every problem found.
 */
export function createTaskWorktree(input: CreateWorktreeInput): CreateWorktreeResult {
    const mainTree = path.resolve(input.mainTree)
    const layout = input.layout ?? resolveLayout(mainTree)
    const root = worktreeRoot(layout)
    const branch = splitTaskBranch(input.missionId, input.taskId)
    let worktree: string
    try {
        worktree = splitWorktreeDir(layout, input.missionId, input.taskId)
    } catch (error) {
        return failure(path.join(root, input.taskId), branch, [(error as Error).message])
    }
    const guard = pathProblem(mainTree, root)
    if (guard !== undefined) return failure(worktree, branch, [guard])
    if (!isInside(root, worktree)) return failure(worktree, branch, [`worktree 路径 ${worktree} 不在 ${root}/** 之下`])
    if (isLiveWorktree(worktree)) {
        const live = branchOf(mainTree, worktree)
        if (live === branch) return { ok: true, created: false, worktree, branch, problems: [] }
        return failure(worktree, branch, [`${worktree} 已存在且是 worktree，但分支是 ${live ?? '(未知)'} 而不是 ${branch}`])
    }
    if (fs.existsSync(worktree)) return failure(worktree, branch, [`${worktree} 已存在但不是 git worktree：拒绝覆盖`])
    // The worktrees ROOT is created first (an empty directory is invisible to
    // git, so it cannot dirty the tree): `git check-ignore` can only apply a
    // directory pattern (`…/worktrees/`) to a path it knows is a directory, and
    // this root does not exist yet on the first task.
    fs.mkdirSync(root, { recursive: true })
    const ignored = ensureIgnored(mainTree, root)
    if (ignored.problem !== undefined) return failure(worktree, branch, [ignored.problem])
    const base = input.base ?? 'HEAD'
    fs.mkdirSync(path.dirname(worktree), { recursive: true })
    const added = git(mainTree, ['worktree', 'add', '-b', branch, worktree, base])
    if (added.status !== 0) {
        const reason = added.error ?? added.stderr.trim() ?? `git exit ${String(added.status)}`
        return failure(worktree, branch, [...(ignored.note === undefined ? [] : [ignored.note]), `git worktree add 失败：${reason}`])
    }
    if (!isLiveWorktree(worktree)) return failure(worktree, branch, [`git worktree add 声称成功，但 ${worktree} 没有 .git 文件`])
    const live = branchOf(mainTree, worktree)
    if (live !== branch) return failure(worktree, branch, [`worktree 已创建，但当前分支是 ${live ?? '(未知)'} 而不是 ${branch}`])
    return {
        ok: true,
        created: true,
        worktree,
        branch,
        gitignore: ignored.state,
        problems: ignored.note === undefined ? [] : [ignored.note],
    }
}

/** The failure text for a refused cleanup (AC-009: print the pending list). */
function pendingProblems(pending: readonly PendingWorkerImport[]): string[] {
    return [
        `存在未导入的本地 evidence（${pending.length} 个子任务）：清理被拒绝，worktree 目录保持原样。`,
        ...pending.map((entry) => describePendingImport(entry)),
        '先把证据导入主 mission（split 导入器），再重新清理；未导入的本地证据随目录删除就再也找不回来了。',
    ]
}

/**
 * Remove one task's worktree, but only after its evidence landed (AC-009).
 *
 * @param input - main tree and mission/task ids.
 * @returns whether it removed anything, plus the pending list when it refused.
 */
export function cleanupTaskWorktree(input: CleanupWorktreeInput): CleanupWorktreeResult {
    const mainTree = path.resolve(input.mainTree)
    const layout = input.layout ?? resolveLayout(mainTree)
    const worktree = splitWorktreeDir(layout, input.missionId, input.taskId)
    const branch = splitTaskBranch(input.missionId, input.taskId)
    const pending = pendingImports({ mainTree, missionId: input.missionId, layout })
    if (pending.length > 0) {
        return { ok: false, removed: false, alreadyGone: false, worktree, branch, pending, problems: pendingProblems(pending) }
    }
    if (!fs.existsSync(worktree)) {
        git(mainTree, ['worktree', 'prune'])
        return { ok: true, removed: false, alreadyGone: true, worktree, branch, pending: [], problems: [] }
    }
    const removed = git(mainTree, ['worktree', 'remove', worktree])
    if (removed.status !== 0) {
        return {
            ok: false,
            removed: false,
            alreadyGone: false,
            worktree,
            branch,
            pending: [],
            problems: [
                `git worktree remove 失败（exit ${String(removed.status)}）：${removed.error ?? removed.stderr.trim()}`,
                `目录保持原样：${worktree}（不会为了"清理干净"而删掉未提交/未导入的工作）。`,
            ],
        }
    }
    if (fs.existsSync(worktree)) {
        return { ok: false, removed: false, alreadyGone: false, worktree, branch, pending: [], problems: [`git 报告已删除，但目录仍在：${worktree}`] }
    }
    return { ok: true, removed: true, alreadyGone: false, worktree, branch, pending: [], problems: [] }
}

/**
 * The task worktree lifecycle (AC-006 / AC-009): create a worktree+branch under
 * the gitignored `<root>/worktrees/<mission>/<task>`, and refuse to clean it up
 * while any local evidence is still unimported.
 *
 * Every test runs against a THROWAWAY git repository (never this one): the
 * fixture commits with its own identity and ignores `.dsh/`, exactly like the
 * real workspace does, so the worktree can be removed only when git considers it
 * clean.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStore, resolveLayout, type Layout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import {
    cleanupTaskWorktree,
    createTaskWorktree,
    importTaskEvidence,
    recordSplitReview,
    saveSplitPlan,
    splitTaskBranch,
    splitWorktreeDir,
    type SplitPlan,
} from '../dist/split.js'

/** One git invocation in the fixture (throws on failure: a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/** Real path (`/var` and `/private/var` are the same directory on macOS). */
function real(target: string): string {
    return fs.realpathSync(target)
}

/** A throwaway repo with one commit and `.dsh/` ignored (the workspace's own layout). */
function repo(): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace('eng-worktree-')
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'fixture@example.com'])
    git(cwd, ['config', 'user.name', 'Fixture'])
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    return { cwd, layout: resolveLayout(cwd) }
}

/** A plan with the single task the fixture works on. */
function plan(): SplitPlan {
    return {
        tasks: [{ id: 't1', goal: '做 t1', paths: ['src/**'], acceptance: ['AC-001'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['t1'] },
        parallelGroups: [['t1']],
    }
}

/** A mission with a reviewed plan (the importer requires both). */
function missionWithPlan(cwd: string, layout: Layout): void {
    new MissionStore({ layout }).create({ id: 'm1', title: 'worktree 夹具', cwd, sessionId: 's1' })
    const saved = saveSplitPlan(layout, 'm1', plan())
    const review = recordSplitReview(layout, 'm1', { approver: 'alice', decision: 'approved', planDigest: saved.digest })
    assert.equal(review.ok, true, review.problems.join(' | '))
}

/** Commit one file inside the task worktree and return the commit id. */
function commitIn(worktree: string, taskId: string): string {
    git(worktree, ['config', 'user.email', 'worker@example.com'])
    git(worktree, ['config', 'user.name', 'Worker'])
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), 'export const a = 1\n')
    git(worktree, ['add', 'src/a.ts'])
    git(worktree, ['commit', '-q', '-m', `${taskId}: 实现`])
    return git(worktree, ['rev-parse', 'HEAD'])
}

/** Write one worker evidence row into the worktree's local ledger. */
function writeWorkerEvidence(worktree: string, layout: Layout, commit: string): void {
    const dir = path.join(worktree, path.relative(layout.cwd, layout.rootDir), 'missions', 'm1')
    fs.mkdirSync(dir, { recursive: true })
    const row = { id: 'ev-1', kind: 'test', at: 1_700_000_000_000, summary: '本地测试通过', taskId: 't1', commit, worktree, branch: splitTaskBranch('m1', 't1') }
    fs.writeFileSync(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(row)}\n`)
}

// --- create ---------------------------------------------------------------

test('createTaskWorktree makes a worktree on its own branch under <root>/worktrees (AC-006)', () => {
    const { cwd, layout } = repo()
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join(' | '))
    assert.equal(created.created, true)
    assert.equal(created.worktree, splitWorktreeDir(layout, 'm1', 't1'))
    assert.equal(created.branch, 'split/m1/t1')
    assert.ok(created.worktree.startsWith(path.join(layout.rootDir, 'worktrees') + path.sep))
    // It really is a worktree of this repository, on the documented branch.
    assert.equal(fs.statSync(path.join(created.worktree, '.git')).isFile(), true)
    assert.equal(git(created.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'split/m1/t1')
    assert.match(git(cwd, ['worktree', 'list', '--porcelain']), new RegExp(real(created.worktree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // The directory is gitignored: creating it never dirties the main tree.
    assert.equal(git(cwd, ['status', '--porcelain']), '')
    assert.equal(created.gitignore, 'already')
})

test('createTaskWorktree appends the ignore rule when the repository lacks it', () => {
    const { cwd } = repo()
    fs.writeFileSync(path.join(cwd, '.gitignore'), '# nothing about worktrees\n')
    git(cwd, ['add', '.gitignore'])
    git(cwd, ['commit', '-q', '-m', 'chore: gitignore'])
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join(' | '))
    assert.equal(created.gitignore, 'appended')
    assert.match(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), /\/\.dsh\/worktrees\//)
    // The rule edit is the ONLY change: the new worktree itself is invisible to git.
    const status = git(cwd, ['status', '--porcelain'])
    assert.equal(status.includes('.dsh'), false, status)
})

test('createTaskWorktree is idempotent for the same task and refuses a foreign branch', () => {
    const { cwd } = repo()
    assert.equal(createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' }).created, true)
    const again = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(again.ok, true, again.problems.join(' | '))
    assert.equal(again.created, false)
})

// --- cleanup --------------------------------------------------------------

test('cleanup refuses while local evidence is unimported and PRINTS the list (AC-009)', () => {
    const { cwd, layout } = repo()
    missionWithPlan(cwd, layout)
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join(' | '))
    const commit = commitIn(created.worktree, 't1')
    writeWorkerEvidence(created.worktree, layout, commit)

    const refused = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(refused.ok, false)
    assert.equal(refused.removed, false)
    assert.ok(refused.pending.length >= 1, JSON.stringify(refused.pending))
    assert.equal(refused.pending[0]?.taskId, 't1')
    assert.equal(refused.pending[0]?.pending, 1)
    assert.match(refused.problems.join('\n'), /待导入/)
    assert.match(refused.problems.join('\n'), /ev-1|1 条待导入/)
    // The directory and its evidence are untouched: deleting it would lose the only copy.
    assert.equal(fs.existsSync(created.worktree), true)
    assert.equal(fs.existsSync(path.join(created.worktree, '.dsh', 'missions', 'm1', 'evidence.jsonl')), true)
})

test('after the evidence is imported the worktree can be removed, and removal is idempotent (AC-008/AC-009)', () => {
    const { cwd, layout } = repo()
    missionWithPlan(cwd, layout)
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    const commit = commitIn(created.worktree as string, 't1')
    writeWorkerEvidence(created.worktree as string, layout, commit)
    // Merge the task branch into the main tree: the importer only accepts commits
    // that are part of the main history.
    git(cwd, ['merge', '--ff-only', 'split/m1/t1'])

    const imported = importTaskEvidence({ mainTree: cwd, missionId: 'm1' })
    assert.equal(imported.ok, true, imported.problems.join(' | '))
    assert.equal(imported.imported.length, 1)
    assert.equal(imported.imported[0]?.taskId, 't1')
    assert.equal(imported.imported[0]?.commit, commit)
    // Source mapping names task/worktree/branch/commit.
    assert.equal(imported.sources[0]?.branch, 'split/m1/t1')

    const cleaned = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(cleaned.ok, true, cleaned.problems.join(' | '))
    assert.equal(cleaned.removed, true)
    assert.equal(fs.existsSync(created.worktree as string), false)

    const again = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(again.ok, true, again.problems.join(' | '))
    assert.equal(again.removed, false)
    assert.equal(again.alreadyGone, true)
})

test('a dirty worktree is kept when `git worktree remove` refuses: nothing is deleted (AC-009)', () => {
    const { cwd, layout } = repo()
    missionWithPlan(cwd, layout)
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    const worktree = created.worktree as string
    // A tracked change that was never committed: git refuses to remove it.
    fs.writeFileSync(path.join(worktree, 'README.md'), '# changed\n')

    const refused = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 't1' })
    assert.equal(refused.ok, false)
    assert.equal(refused.removed, false)
    assert.match(refused.problems.join('\n'), /worktree remove 失败/)
    assert.match(refused.problems.join('\n'), /目录保持原样/)
    assert.equal(fs.existsSync(worktree), true)
    assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'split/m1/t1')
})

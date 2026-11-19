/**
 * The importer (AC-008 / AC-009): the five rejections, the all-or-nothing rule,
 * de-duplication and the source mapping.
 *
 * Every test builds a REAL git repository, because the fact being verified is
 * "is this commit part of the main tree's history" — a mocked answer would
 * test the mock. The rows are the worker's local evidence; the mission, plan and
 * review are the durable artifacts the importer must consult.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import {
    importTaskEvidence,
    pendingImports,
    readSplitPlan,
    recordSplitReview,
    saveSplitPlan,
    workerEvidenceFile,
    type PendingWorkerImport,
    type SplitPlan,
} from '../dist/split.js'

// --- git fixture ----------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
    return (result.stdout ?? '').trim()
}

/** A repository with one base commit on its default branch. */
function baseRepo(): string {
    const cwd = tempWorkspace('evidence-import-')
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'test')
    // The engineering trail is runtime state, never part of a task commit (the
    // real repository gitignores it); without this a checkout of the base
    // branch would DELETE the mission the importer is about to read.
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', 'base')
    return cwd
}

/** Commit a file on a task branch, merged back into the default branch. */
function mergedCommit(cwd: string, taskId = 't1'): string {
    const main = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(cwd, 'checkout', '-q', '-b', `split/m-import/${taskId}`)
    fs.writeFileSync(path.join(cwd, `${taskId}.txt`), `${taskId}\n`)
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', `${taskId}: work`)
    const sha = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'checkout', '-q', main)
    git(cwd, 'merge', '--no-ff', '-q', '-m', `merge ${taskId}`, `split/m-import/${taskId}`)
    return sha
}

/** Commit a file on a task branch and leave it UNMERGED. */
function unmergedCommit(cwd: string, taskId = 't9'): string {
    const main = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(cwd, 'checkout', '-q', '-b', `split/m-import/${taskId}`)
    fs.writeFileSync(path.join(cwd, `${taskId}.txt`), `${taskId}\n`)
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', `${taskId}: unfinished`)
    const sha = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'checkout', '-q', main)
    return sha
}

// --- mission fixture ------------------------------------------------------

const MISSION = 'm-import'

/** Create the mission, its plan and an approved review for it. */
function approvedMission(cwd: string, taskIds: string[] = ['t1']): { layout: Layout; digest: string } {
    const layout = resolveLayout(cwd)
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: MISSION, title: '导入测试', cwd })
    const plan: SplitPlan = {
        tasks: taskIds.map((id) => ({
            id,
            goal: `做 ${id}`,
            paths: [`${id}.txt`],
            acceptance: [`AC-${id.slice(1).padStart(3, '0')}`],
            dependsOn: [],
            parallel: taskIds.length > 1,
        })),
        coverage: Object.fromEntries(taskIds.map((id) => [`AC-${id.slice(1).padStart(3, '0')}`, [id]])),
        parallelGroups: [taskIds],
    }
    const saved = saveSplitPlan(layout, MISSION, plan)
    const review = recordSplitReview(layout, MISSION, { approver: 'alice', decision: 'approved', planDigest: saved.digest })
    assert.equal(review.ok, true, review.problems.join(' | '))
    return { layout, digest: saved.digest }
}

/** One worker row, with overrides for the rejection cases. */
function row(commit: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'R-1',
        kind: 'test',
        at: 1_000,
        summary: 'node --test passed',
        taskId: 't1',
        commit,
        worktree: '/tmp/worktree/t1',
        branch: 'split/m-import/t1',
        command: 'node --test packages/x',
        exitCode: 0,
        ...overrides,
    }
}

function importResult(cwd: string, options: { planDigest?: string; rows?: unknown[] } = {}) {
    return importTaskEvidence({
        mainTree: cwd,
        missionId: MISSION,
        ...(options.planDigest === undefined ? {} : { planDigest: options.planDigest }),
        ...(options.rows === undefined ? {} : { rows: options.rows }),
    })
}

function ledger(cwd: string, missionId = MISSION): Record<string, unknown>[] {
    const file = path.join(resolveLayout(cwd).missionsDir, missionId, 'evidence.jsonl')
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// --- positive path --------------------------------------------------------

test('verified rows are appended to the main ledger with a source mapping (TC-2006)', () => {
    const cwd = baseRepo()
    const { layout, digest } = approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const result = importResult(cwd, { planDigest: digest, rows: [row(commit)] })
    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.imported.length, 1)
    assert.equal(result.imported[0]?.taskId, 't1')
    assert.equal(result.imported[0]?.commit, commit)
    const rows = ledger(cwd)
    assert.equal(rows.length, 1)
    const imported = rows[0]?.['data'] as { import?: Record<string, unknown>; worker?: unknown }
    assert.equal(imported.import?.['taskId'], 't1')
    assert.equal(imported.import?.['at'], 1_000)
    assert.equal(imported.import?.['id'], 'R-1')
    assert.equal(imported.import?.['commit'], commit)
    // The worker's own payload survives, nested (nothing is overwritten).
    assert.equal(imported.worker, undefined)
    const sourcesFile = path.join(layout.missionsDir, MISSION, 'evidence-sources.jsonl')
    assert.equal(fs.existsSync(sourcesFile), true)
    const sources = fs.readFileSync(sourcesFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.['taskId'], 't1')
    assert.equal(sources[0]?.['commit'], commit)
    assert.equal(sources[0]?.['worktree'], '/tmp/worktree/t1')
    assert.equal(sources[0]?.['branch'], 'split/m-import/t1')
    assert.deepEqual(sources[0]?.['evidenceIds'], [result.imported[0]?.evidenceId])
})

test('the source mapping falls back to the documented worktree and branch when the row omits them', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const result = importResult(cwd, { rows: [row(commit, { worktree: undefined, branch: undefined })] })
    assert.equal(result.ok, true, result.problems.join(' | '))
    const source = result.sources[0]
    assert.ok(source?.worktree.endsWith(path.join('worktrees', MISSION, 't1')), source?.worktree)
    assert.equal(source?.branch, 'split/m-import/t1')
})

// --- the five rejections --------------------------------------------------

test('a commit that is not merged into the main tree is refused, and NOTHING is written (TC-2013)', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const unmerged = unmergedCommit(cwd)
    const result = importResult(cwd, { rows: [row(unmerged)] })
    assert.equal(result.ok, false)
    assert.equal(result.imported.length, 0)
    assert.ok(
        result.problems.some((problem) => problem.includes('尚未合并') && problem.includes(unmerged.slice(0, 12))),
        result.problems.join(' | '),
    )
    assert.deepEqual(ledger(cwd), [])
})

test('a taskId that is not in the reviewed plan is refused (naming the plan\'s tasks)', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const result = importResult(cwd, { rows: [row(commit, { taskId: 'ghost' })] })
    assert.equal(result.ok, false)
    assert.ok(
        result.problems.some((problem) => problem.includes('不在已审核 plan 里') && problem.includes('ghost') && problem.includes('t1')),
        result.problems.join(' | '),
    )
    assert.deepEqual(ledger(cwd), [])
})

test('a planDigest that does not match the plan on disk refuses the batch', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const result = importResult(cwd, { planDigest: 'deadbeef'.repeat(8), rows: [row(commit)] })
    assert.equal(result.ok, false)
    assert.ok(
        result.problems.some((problem) => problem.includes('planDigest') && problem.includes('不一致')),
        result.problems.join(' | '),
    )
    assert.deepEqual(ledger(cwd), [])
})

test('a malformed evidence row refuses the batch and names the broken fields', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const result = importResult(cwd, { rows: [{ id: '', kind: 'bogus', taskId: 't1', commit }] })
    assert.equal(result.ok, false)
    for (const fragment of ['缺少 id', 'kind', 'at', 'summary']) {
        assert.ok(
            result.problems.some((problem) => problem.includes(fragment)),
            `missing problem for ${fragment}: ${result.problems.join(' | ')}`,
        )
    }
    assert.deepEqual(ledger(cwd), [])
})

test('a mixed batch is refused as a whole: the good rows do not sneak in', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const merged = mergedCommit(cwd, 't1')
    const unmerged = unmergedCommit(cwd, 't9')
    const result = importResult(cwd, { rows: [row(merged), row(unmerged, { id: 'R-2', taskId: 't1', at: 2_000 })] })
    assert.equal(result.ok, false)
    assert.equal(result.imported.length, 0)
    assert.deepEqual(ledger(cwd), [], 'the batch is all-or-nothing')
})

test('the plan must be reviewed: no review, a rejection, or a plan edited after review are all refused', () => {
    const cwd = baseRepo()
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: MISSION, title: '导入测试', cwd })
    const layout = resolveLayout(cwd)
    const plan: SplitPlan = {
        tasks: [{ id: 't1', goal: '做 t1', paths: ['t1.txt'], acceptance: ['AC-001'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['t1'] },
        parallelGroups: [['t1']],
    }
    const saved = saveSplitPlan(layout, MISSION, plan)
    const commit = mergedCommit(cwd)
    const unreviewed = importResult(cwd, { rows: [row(commit)] })
    assert.equal(unreviewed.ok, false)
    assert.ok(unreviewed.problems.some((problem) => problem.includes('审核记录')), unreviewed.problems.join(' | '))

    recordSplitReview(layout, MISSION, { approver: 'alice', decision: 'approved', planDigest: saved.digest })
    assert.equal(importResult(cwd, { rows: [row(commit)] }).ok, true)

    // Edit the plan afterwards: the review no longer describes it.
    saveSplitPlan(layout, MISSION, { ...plan, tasks: [{ ...plan.tasks[0]!, goal: '改了目标' }] })
    const stale = importResult(cwd, { rows: [row(commit, { id: 'R-2', at: 2_000 })] })
    assert.equal(stale.ok, false)
    assert.ok(stale.problems.some((problem) => problem.includes('必须重新审核')), stale.problems.join(' | '))

    recordSplitReview(layout, MISSION, { approver: 'alice', decision: 'rejected', planDigest: splitDigest(layout) })
    const rejected = importResult(cwd, { rows: [row(commit, { id: 'R-3', at: 3_000 })] })
    assert.equal(rejected.ok, false)
    assert.ok(rejected.problems.some((problem) => problem.includes('审核未通过')), rejected.problems.join(' | '))
})

/** The digest of the plan currently on disk (small helper for the stale case). */
function splitDigest(layout: Layout): string {
    const stored = readSplitPlan(layout, MISSION)
    assert.ok(stored !== undefined, 'the plan is still on disk')
    return stored.digest
}

// --- de-duplication (TC-2018) --------------------------------------------

test('importing the same rows twice adds nothing the second time', () => {
    const cwd = baseRepo()
    approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const first = importResult(cwd, { rows: [row(commit)] })
    assert.equal(first.ok, true)
    const second = importResult(cwd, { rows: [row(commit)] })
    assert.equal(second.ok, true, second.problems.join(' | '))
    assert.equal(second.imported.length, 0)
    assert.deepEqual(second.skipped, [{ taskId: 't1', workerId: 'R-1', at: 1_000, reason: 'duplicate' }])
    assert.deepEqual(second.sources, [])
    assert.equal(ledger(cwd).length, 1)
})

// --- pending imports (AC-009 prerequisite) -------------------------------

test('pendingImports lists what a worktree still holds, and importing it empties the list', () => {
    const cwd = baseRepo()
    const { layout } = approvedMission(cwd)
    const commit = mergedCommit(cwd)
    const worktree = path.join(layout.rootDir, 'worktrees', MISSION, 't1')
    const file = workerEvidenceFile(worktree, cwd, layout, MISSION)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(row(commit))}\n`)

    const before: PendingWorkerImport[] = pendingImports({ mainTree: cwd, missionId: MISSION })
    assert.equal(before.length, 1)
    assert.equal(before[0]?.taskId, 't1')
    assert.equal(before[0]?.pending, 1)
    assert.equal(before[0]?.alreadyImported, 0)
    assert.equal(before[0]?.branch, 'split/m-import/t1')

    const imported = importResult(cwd)
    assert.equal(imported.ok, true, imported.problems.join(' | '))
    assert.equal(imported.imported.length, 1)
    assert.deepEqual(pendingImports({ mainTree: cwd, missionId: MISSION }), [])
})

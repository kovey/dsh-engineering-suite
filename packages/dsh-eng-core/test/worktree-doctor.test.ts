/**
 * The read-only crash-recovery doctor (AC-003 of P3) and the discipline it
 * inherits from the cleaner (AC-009 of P1).
 *
 * The fixture is a REAL throwaway git repository with REAL task worktrees: the
 * classification is about directories that git made, and a fake directory would
 * prove nothing about "is this a live worktree". `run.json` is hand-written
 * because the doctor's whole job is to read a run record that may be missing or
 * truncated — including one from a process that died before writing it.
 *
 * The assertions that matter most are the NEGATIVE ones: the doctor writes
 * nothing (byte-identical `.dsh/` before/after), it never removes a directory,
 * and an `needs-import` directory is refused by the cleaner until its evidence
 * landed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout } from '../dist/index.js'
import {
    cleanupTaskWorktree,
    createTaskWorktree,
    describeOrphanWorktrees,
    findOrphanWorktrees,
    orphanCount,
    splitTaskBranch,
    splitWorktreeDir,
    workerEvidenceFile,
} from '../dist/split.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** One git invocation in the fixture (a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/** A throwaway repo whose `.dsh/` (missions + worktrees) is gitignored. */
function repo(prefix = 'worktree-doctor-'): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace(prefix)
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'fixture@example.com'])
    git(cwd, ['config', 'user.name', 'Fixture'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    const layout = resolveLayout(cwd)
    new MissionStoreRegistry().for(cwd).create({ id: 'm1', title: 'doctor 测试', cwd, sessionId: 's1' })
    return { cwd, layout }
}

/** Write a `split/run.json` with the given task rows (the doctor's only input). */
function withRun(layout: Layout, tasks: { id: string; state: string; commit?: string }[]): void {
    const file = path.join(layout.missionsDir, 'm1', 'split', 'run.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ missionId: 'm1', at: 1_700_000_000_000, state: 'ran', tasks }))
}

/** Create one real task worktree (the directory the doctor classifies). */
function worktree(layout: Layout, cwd: string, taskId: string): string {
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId })
    assert.equal(created.ok, true, created.problems.join(' | '))
    return created.worktree
}

/** Write one unimported row into a worker's local ledger (inside its worktree). */
function localEvidence(cwd: string, layout: Layout, worktreePath: string, taskId: string): void {
    const file = workerEvidenceFile(worktreePath, cwd, layout, 'm1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(
        file,
        `${JSON.stringify({ id: `ev-${taskId}`, kind: 'test', at: 1_700_000_000_000, summary: `${taskId} 本地验证`, taskId, commit: 'abcdef0123456789' })}\n`,
    )
}

/** Every file's path + bytes under `dir` (the read-only assertion). */
function snapshot(dir: string): string {
    const hash = createHash('sha256')
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(current, entry.name)
            if (entry.isDirectory()) walk(absolute)
            else hash.update(`${path.relative(dir, absolute)}\n`).update(fs.readFileSync(absolute))
        }
    }
    if (fs.existsSync(dir)) walk(dir)
    return hash.digest('hex')
}

test('a directory with no run.json row is an orphan, listed with its branch and the clean command (TC-2204)', () => {
    const { cwd, layout } = repo()
    worktree(layout, cwd, 'T-007')
    withRun(layout, [{ id: 'T-001', state: 'done', commit: 'abcdef0123456789' }])

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })

    assert.equal(report.runRecordRead, true)
    assert.equal(orphanCount(report, 'orphan'), 1)
    const entry = report.entries[0]
    assert.equal(entry?.taskId, 'T-007')
    assert.equal(entry?.kind, 'orphan')
    assert.equal(entry?.runState, undefined)
    assert.equal(entry?.live, true)
    assert.equal(entry?.branch, splitTaskBranch('m1', 'T-007'))
    assert.match(entry?.notes.join(' ') ?? '', /run\.json 里没有这个任务/)
    assert.match(entry?.notes.join(' ') ?? '', /bash scripts\/split-clean\.sh --orphans --mission m1/)
    // The run record mentions a task whose directory is gone: informational, and
    // NOT a reason to touch anything.
    assert.deepEqual(report.missingDirs, ['T-001'])
    // The command is printed; nothing is removed (the dir is still there).
    assert.equal(fs.existsSync(splitWorktreeDir(layout, 'm1', 'T-007')), true)
})

test('unimported evidence makes a directory needs-import, and the cleaner refuses with the pending list (TC-2208)', () => {
    const { cwd, layout } = repo()
    const dir = worktree(layout, cwd, 'T-001')
    localEvidence(cwd, layout, dir, 'T-001')
    withRun(layout, [{ id: 'T-001', state: 'done', commit: 'abcdef0123456789' }])

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })

    assert.equal(orphanCount(report, 'needs-import'), 1)
    assert.equal(report.entries[0]?.pendingRows, 1)
    assert.match(report.entries[0]?.notes.join(' ') ?? '', /删除目录就再也找不回来/)
    assert.equal(report.pending.length, 1, 'the doctor exposes the pending summary the CLI refuses on')
    // The cleaner itself refuses, so no caller can skip this check.
    const cleanup = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001' })
    assert.equal(cleanup.ok, false)
    assert.equal(cleanup.removed, false)
    assert.match(cleanup.problems.join('\n'), /存在未导入的本地 evidence/)
    assert.equal(fs.existsSync(dir), true, 'a refused cleanup must leave the directory alone')
})

test('a done task with nothing pending is safe-to-clean, and the cleaner really removes it', () => {
    const { cwd, layout } = repo()
    const dir = worktree(layout, cwd, 'T-002')
    withRun(layout, [{ id: 'T-002', state: 'done', commit: 'abcdef0123456789' }])

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })

    assert.equal(orphanCount(report, 'safe-to-clean'), 1)
    assert.match(report.entries[0]?.notes.join(' ') ?? '', /目录可以清理/)
    const cleanup = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-002' })
    assert.equal(cleanup.ok, true, cleanup.problems.join(' | '))
    assert.equal(cleanup.removed, true)
    assert.equal(fs.existsSync(dir), false)
})

test('a failed removal keeps the directory (git refuses a non-worktree, and nothing falls back to rm -rf)', () => {
    const { cwd, layout } = repo()
    // A plain directory where a worktree would be: git cannot remove it, and the
    // library must NOT "clean up" by deleting the directory itself.
    const dir = splitWorktreeDir(layout, 'm1', 'T-009')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'worker-note.txt'), 'half done\n')
    withRun(layout, [])

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })
    assert.equal(report.entries[0]?.kind, 'orphan')
    assert.equal(report.entries[0]?.live, false)

    const cleanup = cleanupTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-009' })
    assert.equal(cleanup.ok, false)
    assert.match(cleanup.problems.join('\n'), /git worktree remove 失败|目录保持原样/)
    assert.equal(fs.readFileSync(path.join(dir, 'worker-note.txt'), 'utf8'), 'half done\n', 'the file must survive a refused removal')
})

test('the doctor is READ-ONLY: the .dsh tree is byte-identical before/after (AC-005)', () => {
    const { cwd, layout } = repo()
    const dir = worktree(layout, cwd, 'T-001')
    localEvidence(cwd, layout, dir, 'T-001')
    worktree(layout, cwd, 'T-003')
    withRun(layout, [{ id: 'T-001', state: 'done' }])
    const before = snapshot(layout.rootDir)

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })

    assert.equal(report.entries.length, 2)
    assert.equal(snapshot(layout.rootDir), before, 'the doctor must not write anything')
    assert.equal(fs.existsSync(path.join(layout.rootDir, 'missions', 'm1', 'gates')), false, 'a doctor run must not record a gate')
})

test('a corrupt run.json is REPORTED and every directory becomes an orphan (never guessed)', () => {
    const { cwd, layout } = repo()
    worktree(layout, cwd, 'T-001')
    const file = path.join(layout.missionsDir, 'm1', 'split', 'run.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ "missionId": "m1", "tasks": [ { "id": "T-001", ')

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })

    assert.equal(report.runRecordRead, false)
    assert.equal(orphanCount(report, 'orphan'), 1)
    assert.equal(report.entries[0]?.runState, undefined)
    assert.ok(
        report.problems.some((problem) => problem.includes('run.json') && problem.includes('无法解析')),
        `the unreadable record must be named: ${report.problems.join(' | ')}`,
    )
    // A truncated record is not "the task finished": the evidence-safety rule wins.
    assert.equal(orphanCount(report, 'safe-to-clean'), 0)
})

test('the rendered list is bounded, so a status view can print the first few and the command', () => {
    const { cwd, layout } = repo()
    for (const taskId of ['T-001', 'T-002', 'T-003']) worktree(layout, cwd, taskId)
    withRun(layout, [])

    const report = findOrphanWorktrees({ mainTree: cwd, missionId: 'm1', layout })
    const lines = describeOrphanWorktrees(report, 2)

    assert.equal(lines.length, 2)
    assert.match(lines[0] ?? '', /^- T-001：orphan（run=无记录/)
    assert.match(lines[1] ?? '', /^- T-002：orphan/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { archiveFootprint, archiveMissions, findArchivedMission, planArchive, readArchiveIndex } from '../dist/index.js'
import { resolveLayout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** Build a mission directory by hand: the plan only needs meta + receipts. */
function mission(cwd: string, id: string, options: { createdAt: number; delivered?: boolean; bytes?: number }): void {
    const dir = path.join(cwd, '.dsh', 'missions', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mission.json'), JSON.stringify({ id, title: `任务 ${id}`, createdAt: options.createdAt, status: 'completed' }))
    if (options.delivered === true) {
        fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'receipts', 'R-1.json'), JSON.stringify({ id: 'R-1' }))
    }
    if (options.bytes !== undefined) fs.writeFileSync(path.join(dir, 'payload.bin'), Buffer.alloc(options.bytes, 1))
}

const DAY = 86_400_000

test('the plan keeps the newest N and protects undelivered work (regression)', () => {
    const cwd = tempWorkspace('archive-plan-')
    const layout = resolveLayout(cwd)
    const now = 1_000 * DAY
    mission(cwd, 'M-new', { createdAt: now - 1 * DAY, delivered: true })
    mission(cwd, 'M-old-delivered', { createdAt: now - 30 * DAY, delivered: true })
    mission(cwd, 'M-old-undelivered', { createdAt: now - 40 * DAY })
    const plan = planArchive({ layout, keep: 1, now })
    assert.deepEqual(plan.candidates.map((c) => c.missionId), ['M-old-delivered'])
    assert.match(plan.kept.find((k) => k.missionId === 'M-old-undelivered')?.reason ?? '', /尚未交付/)
    assert.match(plan.kept.find((k) => k.missionId === 'M-new')?.reason ?? '', /最新 1 个/)
})

test('undelivered missions need the explicit opt-in, and the age rule is respected (regression)', () => {
    const cwd = tempWorkspace('archive-rules-')
    const layout = resolveLayout(cwd)
    const now = 1_000 * DAY
    mission(cwd, 'M-undelivered', { createdAt: now - 90 * DAY })
    mission(cwd, 'M-recent', { createdAt: now - 2 * DAY, delivered: true })
    const strict = planArchive({ layout, keep: 0, olderThanDays: 30, now })
    assert.deepEqual(strict.candidates, [], 'nothing eligible: one undelivered, one too recent')
    const opted = planArchive({ layout, keep: 0, olderThanDays: 30, includeUndelivered: true, now })
    assert.deepEqual(opted.candidates.map((c) => c.missionId), ['M-undelivered'])
})

test('a dry run reports the plan and moves nothing (regression)', () => {
    const cwd = tempWorkspace('archive-dry-')
    const layout = resolveLayout(cwd)
    mission(cwd, 'M-1', { createdAt: 1, delivered: true })
    const result = archiveMissions({ layout, keep: 0, dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.moved.length, 1)
    assert.ok(fs.existsSync(path.join(cwd, '.dsh', 'missions', 'M-1')), 'the mission stays put')
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'archive', 'index.jsonl')), false, 'no index is written')
})

test('archiving moves the mission, writes the index and stays findable (regression)', () => {
    const cwd = tempWorkspace('archive-run-')
    const layout = resolveLayout(cwd)
    const createdAt = Date.UTC(2026, 4, 17)
    mission(cwd, 'M-9', { createdAt, delivered: true, bytes: 2_048 })
    const result = archiveMissions({ layout, keep: 0 })
    assert.equal(result.moved.length, 1)
    assert.match(result.moved[0]?.movedTo ?? '', /2026-05[/\\]M-9$/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', 'M-9')), false)
    assert.ok(fs.existsSync(path.join(cwd, '.dsh', 'archive', '2026-05', 'M-9', 'mission.json')))
    const rows = readArchiveIndex(layout)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.missionId, 'M-9')
    assert.ok((rows[0]?.bytes ?? 0) >= 2_048, 'the recorded size reflects the payload')
    assert.equal(findArchivedMission(layout, 'M-9')?.missionId, 'M-9')
    assert.equal(findArchivedMission(layout, 'M-nope'), undefined)
    assert.deepEqual(archiveFootprint(layout).missions, 1)
    assert.ok(archiveFootprint(layout).bytes > 0)
})

test('an existing archive target is refused instead of merged (regression)', () => {
    const cwd = tempWorkspace('archive-collision-')
    const layout = resolveLayout(cwd)
    mission(cwd, 'M-3', { createdAt: Date.UTC(2026, 0, 5), delivered: true })
    fs.mkdirSync(path.join(cwd, '.dsh', 'archive', '2026-01', 'M-3'), { recursive: true })
    assert.throws(() => archiveMissions({ layout, keep: 0 }), /归档目标已存在/)
})

test('a truncated index line does not break reading (regression)', () => {
    const cwd = tempWorkspace('archive-truncated-')
    const layout = resolveLayout(cwd)
    mission(cwd, 'M-4', { createdAt: Date.UTC(2026, 2, 2), delivered: true })
    archiveMissions({ layout, keep: 0 })
    fs.appendFileSync(path.join(cwd, '.dsh', 'archive', 'index.jsonl'), '{"at":1,"missionId":"M-5"')
    const rows = readArchiveIndex(layout)
    assert.equal(rows.length, 1, 'the complete row survives, the torn one is dropped')
})

/**
 * The read-only split section of `orchestrate({ action: "status" })` (AC-004).
 *
 * The assertion that matters most is the NEGATIVE one: a mission without a plan
 * must produce exactly the old report, and a status call must write nothing at
 * all (no gate record, no mission update). Both are checked as facts — the
 * section is absent, and the `.dsh` tree is byte-identical before/after.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout, type MissionStore } from 'dsh-eng-core'
import { recordSplitReview, saveSplitPlan, splitPlanDigest, splitTaskBranch, worktreeRoot, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { splitReportFile, splitRunFile } from '../dist/split-run-types.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** A host with the orchestrator mounted and the split workflow enabled. */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('split-status-log-'), 'orchestrator.log'), split: { enabled: true } })
    return fake
}

/** A mission bound to the fake host's session, parked on `implement`. */
function mission(fake: FakeHost): { store: MissionStore; layout: Layout; cwd: string } {
    const store = new MissionStoreRegistry().for(fake.cwd)
    store.create({ id: 'm1', title: '拆分 status 测试', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm1', 'implement')
    store.update('m1', () => ({ status: 'spec-approved', stage: 'implement' }))
    return { store, layout: resolveLayout(fake.cwd), cwd: fake.cwd }
}

/** A two-task plan covering AC-001/AC-002, with AC-003 in the second task. */
function plan(): SplitPlan {
    return {
        tasks: [
            { id: 'T-001', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 'T-002', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002', 'AC-003'], dependsOn: [], parallel: true },
        ],
        coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-002'], 'AC-003': ['T-002'] },
        parallelGroups: [['T-001', 'T-002']],
    }
}

/** Write a plan and (optionally) approve it. */
function withPlan(layout: Layout, options: { review?: 'approved' | 'rejected' | 'none'; edited?: boolean } = {}): string {
    const stored = saveSplitPlan(layout, 'm1', options.edited === true ? { ...plan(), coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-002'], 'AC-003': ['T-001'] } } : plan())
    if (options.review === undefined || options.review === 'none') return stored.digest
    const review = recordSplitReview(layout, 'm1', { approver: 'alice', decision: options.review, planDigest: stored.digest, at: 1 })
    assert.equal(review.ok, true, review.problems.join(' | '))
    return stored.digest
}

/** Write a `split/run.json` describing a finished run. */
function withRun(layout: Layout, digest: string): void {
    const file = splitRunFile(layout, 'm1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
        file,
        JSON.stringify({
            missionId: 'm1',
            at: 1_700_000_000_000,
            state: 'ran',
            ok: true,
            planDigest: digest,
            tasks: [
                { id: 'T-001', state: 'done', commit: 'abcdef0123456789', attempts: 1, imported: 2, cleanedUp: true, signals: [], problems: [] },
                { id: 'T-002', state: 'done', commit: '1234567890abcdef', attempts: 1, imported: 1, cleanedUp: true, signals: [], problems: [] },
            ],
            imported: 3,
            rework: { started: 2, reworked: 0, ratio: 0, threshold: 0.3, exceeded: false, escalate: false, tasks: [], problems: [] },
        }),
    )
}

/** A local worker ledger inside a task worktree (what `pendingImports` scans). */
function withPendingEvidence(layout: Layout, cwd: string, taskId: string): void {
    const relativeRoot = path.relative(cwd, layout.rootDir)
    const dir = path.join(worktreeRoot(layout), 'm1', taskId, relativeRoot, 'missions', 'm1')
    fs.mkdirSync(dir, { recursive: true })
    const row = { id: `ev-${taskId}`, kind: 'test', at: 1_700_000_000_000, summary: `${taskId} 本地验证通过`, taskId, commit: 'abcdef0123456789', worktree: path.join(worktreeRoot(layout), 'm1', taskId), branch: splitTaskBranch('m1', taskId) }
    fs.appendFileSync(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(row)}\n`)
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

async function status(fake: FakeHost): Promise<string> {
    const run = await fake.runTool('orchestrate', { action: 'status' })
    assert.equal(run.isError, false, String(run.content))
    return runText(run)
}

test('a mission without a plan keeps the old status report (no split section)', async () => {
    const cwd = tempWorkspace('split-status-plain-')
    const fake = host(cwd)
    mission(fake)

    const text = await status(fake)

    assert.equal(text.includes('## 拆分'), false)
    assert.match(text, /mission：m1/)
    assert.match(text, /未挂载插件：/)
})

test('a plan with an approval and a run is rendered per task, with the digest and the ratio (TC-2104)', async () => {
    const cwd = tempWorkspace('split-status-full-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)

    const text = await status(fake)

    assert.match(text, /## 拆分/)
    assert.match(text, new RegExp(`plan：摘要 ${digest.slice(0, 12)}`))
    assert.match(text, /2 个子任务，1 个并行组/)
    assert.match(text, /审核：approved/)
    assert.match(text, /运行：ran/)
    // Per task: state | 8-char commit | imported rows | cleanup
    assert.match(text, /T-001 \| done \| abcdef01 \| 2 \| ✅/)
    assert.match(text, /T-002 \| done \| 12345678 \| 1 \| ✅/)
    assert.match(text, /返工率：0\/2 = 0\.000（阈值 0\.3，未升级（不超过阈值））/)
    assert.match(text, /待导入：0 条（0 个子任务）/)
})

test('a rejected review is shown as rejected, with its reason (AC-004)', async () => {
    const cwd = tempWorkspace('split-status-rejected-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    withPlan(layout, { review: 'rejected' })

    const text = await status(fake)

    assert.match(text, /审核：rejected/)
    assert.match(text, /需要重新拆分/)
    assert.match(text, /运行：尚未派发（split\/run\.json 缺失）/)
    // No run: task rows say so instead of inventing a state.
    assert.match(text, /T-001 \| 未派发 \| - \| - \| -/)
})

test('a plan that changed after the review is reported as stale, not as approved', async () => {
    const cwd = tempWorkspace('split-status-stale-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    withPlan(layout, { review: 'approved' })
    // Editing the plan is exactly what makes the review stale.
    saveSplitPlan(layout, 'm1', { ...plan(), tasks: [...plan().tasks, { id: 'T-003', goal: '额外', paths: ['packages/c/**'], acceptance: ['AC-001'], dependsOn: [], parallel: false }], parallelGroups: [['T-001', 'T-002'], ['T-003']], coverage: { ...plan().coverage } })

    const text = await status(fake)

    assert.match(text, /审核：已失效（stale/)
    assert.match(text, /必须重新审核/)
})

test('all tasks done and imported: the report says it can be cleaned up, with 0 rows left (TC-2111)', async () => {
    const cwd = tempWorkspace('split-status-cleanable-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)

    const text = await status(fake)

    assert.match(text, /待导入：0 条（0 个子任务）；可清理：是（2\/2 个子任务已完成，剩余未导入为 0）/)
})

test('unimported worker evidence is counted and blocks cleanup (AC-009 visible in the status)', async () => {
    const cwd = tempWorkspace('split-status-pending-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)
    // A third task's worktree whose local row never landed in the main ledger.
    withPendingEvidence(layout, cwd, 'T-003')

    const text = await status(fake)

    assert.match(text, /待导入：1 条（1 个子任务）；可清理：否/)
    assert.match(text, /先导入这些证据/)
})

test('escalated rework is shown as escalated (AC-004/AC-011)', async () => {
    const cwd = tempWorkspace('split-status-escalated-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)
    const file = splitRunFile(layout, 'm1')
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { rework: Record<string, unknown> }
    record.rework = { ...record.rework, reworked: 1, ratio: 0.5, exceeded: true, escalate: true }
    fs.writeFileSync(file, JSON.stringify(record))

    const text = await status(fake)

    assert.match(text, /返工率：1\/2 = 0\.500（阈值 0\.3，已升级 planner 模型）/)
})

test('status is READ-ONLY: it neither writes nor records a gate while rendering the split section (AC-004)', async () => {
    const cwd = tempWorkspace('split-status-readonly-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)
    const before = snapshot(layout.rootDir)

    const text = await status(fake)

    assert.match(text, /## 拆分/)
    assert.equal(snapshot(layout.rootDir), before, 'orchestrate status must not write anything')
    assert.equal(fs.existsSync(path.join(layout.rootDir, 'missions', 'm1', 'gates')), false, 'no gate record may be created by a status view')
})

test('the report.json next to run.json is not consulted by the status view', async () => {
    const cwd = tempWorkspace('split-status-report-')
    const fake = host(cwd)
    const { layout } = mission(fake)
    const digest = withPlan(layout, { review: 'approved' })
    withRun(layout, digest)
    // A hand-written report claiming something else must not change the view.
    fs.writeFileSync(splitReportFile(layout, 'm1'), JSON.stringify({ rework: { ratio: 1, threshold: 0, escalate: true } }))

    const text = await status(fake)

    assert.match(text, /返工率：0\/2 = 0\.000（阈值 0\.3，未升级（不超过阈值））/)
})

test('the review digest quoted by the status is the one a review record must match', () => {
    const cwd = tempWorkspace('split-status-digest-')
    const layout = resolveLayout(cwd)
    new MissionStoreRegistry().for(cwd).create({ id: 'm1', title: 'digest', cwd })
    const digest = withPlan(layout, { review: 'approved' })
    assert.equal(splitPlanDigest(JSON.parse(fs.readFileSync(path.join(layout.missionsDir, 'm1', 'split', 'plan.json'), 'utf8')) as SplitPlan), digest)
})

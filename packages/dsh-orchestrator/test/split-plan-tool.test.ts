/**
 * `split_plan` (AC-001): the checked write entry of the split workflow.
 *
 * The mission store and the tool registry are the fake host's; the FILES are
 * real (`plan.json` under a throwaway workspace), so "refused" is asserted as
 * "nothing was written" rather than as a message.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { MissionStoreRegistry, resolveLayout, type MissionStore } from 'dsh-eng-core'
import { readSplitPlan, splitPlanDigest, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** A host with the orchestrator mounted (split workflow ON: its stages exist). */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('split-plan-log-'), 'orchestrator.log'), split: { enabled: true } })
    return fake
}

/** A mission bound to the fake host's session, with a three-criterion spec. */
function missionWithSpec(fake: FakeHost, options: { spec?: boolean } = {}): MissionStore {
    const store = new MissionStoreRegistry().for(fake.cwd)
    store.create({ id: 'm1', title: '写 plan 测试', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm1', 'split')
    if (options.spec === false) return store
    store.update('m1', () => ({
        status: 'spec-approved',
        spec: {
            title: '写 plan 测试',
            background: '',
            requirements: [],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'a' },
                { id: 'AC-002', text: 'b' },
                { id: 'AC-003', text: 'c' },
            ],
            fileBoundaries: ['packages/**'],
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
        },
    }))
    return store
}

/** Three valid tasks covering all three criteria. */
function tasks(): unknown[] {
    return [
        { id: 'T-001', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
        { id: 'T-002', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002'], dependsOn: [], parallel: true },
        { id: 'T-003', goal: '做 c', paths: ['packages/c/**'], acceptance: ['AC-003'], dependsOn: [], parallel: true },
    ]
}

async function call(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('split_plan', args)
    assert.equal(run.isError, false, `split_plan failed: ${String(run.content)}`)
    return runText(run)
}

/** The digest of the plan on disk (fails the test when there is none). */
function digestOnDisk(cwd: string): string {
    const stored = readSplitPlan(resolveLayout(cwd), 'm1')
    assert.ok(stored !== undefined, 'expected split/plan.json to exist')
    return stored.digest
}

test('split_plan is registered next to orchestrate', () => {
    const fake = host(tempWorkspace('split-plan-reg-'))
    assert.equal(fake.tools.has('split_plan'), true)
    assert.equal(fake.tools.has('orchestrate'), true)
})

test('a valid plan is written and the report returns the digest a review must quote (TC-2101)', async () => {
    const cwd = tempWorkspace('split-plan-ok-')
    const fake = host(cwd)
    missionWithSpec(fake)

    const text = await call(fake, { tasks: tasks(), parallelGroups: [['T-001', 'T-002', 'T-003']] })

    assert.match(text, /拆分计划已写入/)
    assert.match(text, /摘要：[0-9a-f]{12}/)
    const stored = readSplitPlan(resolveLayout(cwd), 'm1')
    assert.ok(stored !== undefined)
    assert.equal(stored.plan.missionId, 'm1')
    assert.equal(stored.plan.tasks.length, 3)
    assert.deepEqual(stored.plan.parallelGroups, [['T-001', 'T-002', 'T-003']])
    // The coverage map is DERIVED from the tasks, so the stored plan explains
    // itself without a second hand-written mapping.
    assert.deepEqual(stored.plan.coverage, { 'AC-001': ['T-001'], 'AC-002': ['T-002'], 'AC-003': ['T-003'] })
    assert.match(text, new RegExp(stored.digest.slice(0, 12)))
    assert.match(text, /还没有审核记录/)
    assert.match(text, /下一步：走 split-review/)
})

test('check 1: a task mapping a criterion the spec does not have is refused, and nothing is written (TC-2106)', async () => {
    const cwd = tempWorkspace('split-plan-check1-')
    const fake = host(cwd)
    missionWithSpec(fake)
    const bad = tasks()
    ;(bad[0] as { acceptance: string[] }).acceptance = ['AC-999']

    const text = await call(fake, { tasks: bad, parallelGroups: [['T-001', 'T-002', 'T-003']] })

    assert.match(text, /三道自动校验未通过/)
    assert.match(text, /AC-999/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'split', 'plan.json')), false)
})

test('check 1: a task with NO acceptance criterion is refused', async () => {
    const cwd = tempWorkspace('split-plan-check1b-')
    const fake = host(cwd)
    missionWithSpec(fake)
    const bad = tasks()
    ;(bad[1] as { acceptance: string[] }).acceptance = []

    const text = await call(fake, { tasks: bad, parallelGroups: [['T-001'], ['T-002'], ['T-003']] })

    assert.match(text, /没有映射任何验收标准/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'split', 'plan.json')), false)
})

test('check 2: overlapping paths inside one parallel group are refused, naming both paths', async () => {
    const cwd = tempWorkspace('split-plan-check2-')
    const fake = host(cwd)
    missionWithSpec(fake)
    const bad = tasks()
    ;(bad[1] as { paths: string[] }).paths = ['packages/a/src/**']

    const text = await call(fake, { tasks: bad, parallelGroups: [['T-001', 'T-002'], ['T-003']] })

    assert.match(text, /路径重叠/)
    assert.match(text, /packages\/a\/\*\* ↔ packages\/a\/src\/\*\*/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'split', 'plan.json')), false)
})

test('check 3: an acceptance criterion nobody covers is refused', async () => {
    const cwd = tempWorkspace('split-plan-check3-')
    const fake = host(cwd)
    missionWithSpec(fake)
    const bad = tasks().slice(0, 2) // AC-003 is now uncovered

    const text = await call(fake, { tasks: bad, parallelGroups: [['T-001', 'T-002']] })

    assert.match(text, /AC-003 没有被任何子任务覆盖/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'split', 'plan.json')), false)
})

test('omitted parallelGroups defaults to one group per task (conservative: serial)', async () => {
    const cwd = tempWorkspace('split-plan-groups-')
    const fake = host(cwd)
    missionWithSpec(fake)

    const text = await call(fake, { tasks: tasks() })

    assert.match(text, /并行组：3 个/)
    const stored = readSplitPlan(resolveLayout(cwd), 'm1')
    assert.deepEqual(stored?.plan.parallelGroups, [['T-001'], ['T-002'], ['T-003']])
})

test('rewriting the SAME plan needs no force and keeps the review valid (TC-2107 positive half)', async () => {
    const cwd = tempWorkspace('split-plan-same-')
    const fake = host(cwd)
    missionWithSpec(fake)
    await call(fake, { tasks: tasks(), parallelGroups: [['T-001', 'T-002', 'T-003']] })
    const before = digestOnDisk(cwd)

    const text = await call(fake, { tasks: tasks(), parallelGroups: [['T-001', 'T-002', 'T-003']] })

    assert.match(text, /已写入/)
    assert.match(text, /内容未变（摘要相同）：现有审核记录仍然有效/)
    assert.equal(digestOnDisk(cwd), before)
})

test('a CHANGED plan is refused without force, saying the change needs a new review (TC-2107)', async () => {
    const cwd = tempWorkspace('split-plan-force-')
    const fake = host(cwd)
    missionWithSpec(fake)
    await call(fake, { tasks: tasks(), parallelGroups: [['T-001', 'T-002', 'T-003']] })
    const before = digestOnDisk(cwd)
    const edited = tasks()
    ;(edited[0] as { goal: string }).goal = '换了目标'

    const text = await call(fake, { tasks: edited, parallelGroups: [['T-001', 'T-002', 'T-003']] })

    assert.match(text, /改动需要重新审核/)
    assert.match(text, /force: true/)
    // The refusal really wrote nothing: the digest and the goal are the old ones.
    assert.equal(digestOnDisk(cwd), before)
    assert.equal(readSplitPlan(resolveLayout(cwd), 'm1')?.plan.tasks[0]?.goal, '做 a')
})

test('force: true writes the changed plan and says the old review is invalid', async () => {
    const cwd = tempWorkspace('split-plan-forced-')
    const fake = host(cwd)
    missionWithSpec(fake)
    await call(fake, { tasks: tasks(), parallelGroups: [['T-001', 'T-002', 'T-003']] })
    const before = digestOnDisk(cwd)
    const edited = tasks()
    ;(edited[0] as { goal: string }).goal = '换了目标'

    const text = await call(fake, { tasks: edited, parallelGroups: [['T-001', 'T-002', 'T-003']], force: true })

    assert.match(text, /拆分计划已写入/)
    assert.match(text, /旧审核记录已失效/)
    const after = digestOnDisk(cwd)
    assert.notEqual(after, before)
    assert.equal(readSplitPlan(resolveLayout(cwd), 'm1')?.plan.tasks[0]?.goal, '换了目标')
})

test('the digest is stable: key order and a second write do not change it', () => {
    const plan: SplitPlan = { tasks: [{ id: 't1', goal: 'g', paths: ['p'], acceptance: ['AC-001'], dependsOn: [], parallel: false }], coverage: {}, parallelGroups: [['t1']] }
    const reordered = { parallelGroups: plan.parallelGroups, coverage: plan.coverage, tasks: plan.tasks }
    assert.equal(splitPlanDigest(plan), splitPlanDigest(reordered))
})

test('a session without a mission is told to start one (no plan is written for nobody)', async () => {
    const cwd = tempWorkspace('split-plan-nomission-')
    const fake = host(cwd)

    const text = await call(fake, { tasks: tasks() })

    assert.match(text, /没有绑定 mission/)
    assert.match(text, /orchestrate\(\{ action: "start"/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1')), false)
})

test('a mission without a specification is refused (no AC oracle, no plan)', async () => {
    const cwd = tempWorkspace('split-plan-nospec-')
    const fake = host(cwd)
    missionWithSpec(fake, { spec: false })

    const text = await call(fake, { tasks: tasks() })

    assert.match(text, /还没有规格/)
    assert.match(text, /spec_create/)
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'split')), false)
})

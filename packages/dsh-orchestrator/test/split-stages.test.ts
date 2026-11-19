/**
 * The split stages of the orchestrator: placement, the plan gate (AC-004/005),
 * the not-worth-splitting exit and the digest checks that keep an edited plan
 * out of `implement` (AC-003).
 *
 * The split workflow is opt-in (`config.split.enabled`), so every test here
 * enables it explicitly; the default six-stage pipeline is covered by the
 * existing tests in `orchestrator.test.ts` and is not duplicated.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout, type MissionStore } from 'dsh-eng-core'
import { appendDelegation } from 'dsh-eng-core/delegations'
import { recordSplitReview, saveSplitPlan, splitPlanDigest, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** Sibling plugin tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Assemble the plugin with the split workflow enabled (or not). */
function host(options: { cwd?: string; split?: boolean } = {}): FakeHost {
    const cwd = options.cwd ?? tempWorkspace('orchestrator-split-')
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'orchestrator.log'),
        ...(options.split === false ? {} : { split: { enabled: true } }),
    })
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    return fake
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

function storeFor(cwd: string): MissionStore {
    return new MissionStoreRegistry().for(cwd)
}

/** A mission parked on a stage with an approved spec (three criteria). */
function missionAt(fake: FakeHost, stage: string, id = 'm-split'): { store: MissionStore; cwd: string; layout: Layout } {
    const store = storeFor(fake.cwd)
    store.create({ id, title: '拆分测试', cwd: fake.cwd, sessionId: 'session-1' })
    // Bind the session: `orchestrate` resolves the mission through the binding.
    store.bindSession('session-1', id, stage)
    store.update(id, () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: '拆分测试',
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
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
    return { store, cwd: fake.cwd, layout: resolveLayout(fake.cwd) }
}

/** A plan whose two tasks are valid and cover AC-001 / AC-002 (+AC-003). */
function goodPlan(): SplitPlan {
    return {
        tasks: [
            { id: 't1', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 't2', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002', 'AC-003'], dependsOn: [], parallel: true },
        ],
        coverage: { 'AC-001': ['t1'], 'AC-002': ['t2'], 'AC-003': ['t2'] },
        parallelGroups: [['t1', 't2']],
    }
}

/** Record an approval for the plan currently on disk. */
function approve(layout: Layout, missionId = 'm-split'): string {
    const digest = splitPlanDigest(JSON.parse(fs.readFileSync(path.join(layout.missionsDir, missionId, 'split', 'plan.json'), 'utf8')) as SplitPlan)
    const review = recordSplitReview(layout, missionId, { approver: 'alice', decision: 'approved', planDigest: digest })
    assert.equal(review.ok, true, review.problems.join(' | '))
    return digest
}

function stageFile(cwd: string, missionId: string, stageId: string): { state: string; attempt: number; gateState?: string; summary?: string } {
    const file = path.join(cwd, '.dsh', 'missions', missionId, 'stages', `${stageId}.json`)
    assert.equal(fs.existsSync(file), true, `missing stage artifact ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { state: string; attempt: number; gateState?: string; summary?: string }
}

// --- placement ------------------------------------------------------------

test('enabling split inserts the two stages between spec-approve and implement, in order', async () => {
    const fake = host()
    const text = await orchestrate(fake, { action: 'stages' })
    const ids = [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
    assert.deepEqual(ids, ['spec-clarify', 'test-design-review', 'spec-approve', 'split', 'split-review', 'implement', 'quality-verify', 'delivery'])
    assert.match(text, /split[\s\S]{0,200}拆分计划已落盘且三道自动校验通过/)
    assert.match(text, /split-review[\s\S]{0,200}已人工审核且 plan 摘要匹配/)
    assert.match(text, /implement[\s\S]{0,400}没有待审核的拆分计划/)
})

test('split is opt-in: the default pipeline keeps its six stages untouched', async () => {
    const fake = host({ split: false })
    const text = await orchestrate(fake, { action: 'stages' })
    const ids = [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
    assert.deepEqual(ids, ['spec-clarify', 'test-design-review', 'spec-approve', 'implement', 'quality-verify', 'delivery'])
    assert.equal(/^\d+\. split — /m.test(text), false)
})

// --- the plan gate --------------------------------------------------------

test('a plan that fails the automatic checks BLOCKS the split stage, naming the problem', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split')
    const plan = goodPlan()
    plan.tasks[1] = { ...plan.tasks[1]!, acceptance: [] }
    saveSplitPlan(layout, 'm-split', plan)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /三道自动校验未通过/)
    assert.match(text, /子任务 t2 没有映射任何验收标准/)
    // The stage stays OPEN for a re-plan: nothing was settled, nothing advanced.
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'split.json')), false)
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'split-review.json')), false)
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
    // Retrying is free: the same refusal comes back, no attempt was burned.
    const again = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(again, /三道自动校验未通过/)
})

test('a plan over maxTasks is refused and points at several missions (AC-005)', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split')
    fs.writeFileSync(path.join(layout.rootDir, 'models.json'), JSON.stringify({ split: { maxTasks: 2 }, planner: {}, worker: {}, quality: {} }))
    const plan = goodPlan()
    plan.tasks.push({ id: 't3', goal: '做 c', paths: ['packages/c/**'], acceptance: ['AC-003'], dependsOn: [], parallel: true })
    plan.coverage['AC-003'] = ['t2', 't3']
    plan.parallelGroups = [['t1', 't2', 't3']]
    saveSplitPlan(layout, 'm-split', plan)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /maxTasks=2/)
    assert.match(text, /拆成多个 mission/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
})

test('a passing plan waits for review: the split stage settles and split-review is entered', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split')
    saveSplitPlan(layout, 'm-split', goodPlan())
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /→ 下一阶段 split-review/)
    assert.match(text, /通过三道自动校验/)
    assert.equal(stageFile(cwd, 'm-split', 'split').state, 'passed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
})

// --- the "not worth splitting" exit --------------------------------------

test('a one-task plan is not worth splitting: review is skipped and implement is entered (AC-005)', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split')
    saveSplitPlan(layout, 'm-split', {
        tasks: [{ id: 't1', goal: '全部', paths: ['packages/**'], acceptance: ['AC-001', 'AC-002', 'AC-003'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['t1'], 'AC-002': ['t1'], 'AC-003': ['t1'] },
        parallelGroups: [['t1']],
    })
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /→ 下一阶段 implement/)
    assert.match(text, /跳过 split-review/)
    // AC-003 of the model-class follow-up: the threshold's own verdict/wording
    // is untouched — "not worth splitting" is decided here, not by the rework
    // limit (which never even ran: this plan was never sent for review).
    assert.match(text, /只有 1 条子任务（少于 2 条）：不值得拆分成并行任务/)
    assert.equal(stageFile(cwd, 'm-split', 'split').state, 'passed')
    assert.equal(stageFile(cwd, 'm-split', 'split-review').state, 'skipped')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

// --- review + digest -----------------------------------------------------

test('an approved plan lets split-review settle and implement be entered (AC-003)', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())
    approve(layout)
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(stageFile(cwd, 'm-split', 'split-review').state, 'passed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

test('a plan edited after review cannot leave split-review, so implement is not entered (TC-2012)', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())
    approve(layout)
    const edited = goodPlan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '换了目标' }
    saveSplitPlan(layout, 'm-split', edited)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /必须重新审核|不一致/)
    // The rejected review rolls back to `split` for a re-plan; implement stays closed.
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(stageFile(cwd, 'm-split', 'split-review').state, 'failed')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
})

test('implement itself refuses to start while the plan is not the reviewed one', async () => {
    const fake = host()
    const { cwd, layout } = missionAt(fake, 'implement')
    saveSplitPlan(layout, 'm-split', goodPlan())
    approve(layout)
    const edited = goodPlan()
    edited.tasks[1] = { ...edited.tasks[1]!, paths: ['packages/z/**'] }
    saveSplitPlan(layout, 'm-split', edited)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /阶段 implement 不能进入/)
    assert.match(text, /重新审核/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'quality-verify.json')), false)
})

test('a mission without any plan passes implement (plain implement is unaffected)', async () => {
    const fake = host()
    const { cwd } = missionAt(fake, 'implement')
    // Settling a role stage requires the delegation `team_delegate` records.
    appendDelegation(cwd, { missionId: 'm-split', role: 'developer', childSessionId: 'session-child', stage: 'implement', at: Date.now() })
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /→ 下一阶段 quality-verify/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'quality-verify')
})

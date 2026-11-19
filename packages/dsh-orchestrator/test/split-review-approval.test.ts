/**
 * The split review through the HOST approval seam, and the rework limit that
 * ends the review loop (AC-003).
 *
 * The four answers are the contract: only `allowed-once` writes an approval;
 * `rejected` writes a rejection (it is what the rework limit counts) and rolls
 * back for a re-plan; `cancelled` and `unavailable` write NOTHING and leave the
 * stage entered — "nobody decided" is never a pass, and re-planning cannot fix a
 * card nobody answered. With no seam at all the stage refuses by name.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout, type MissionStore } from 'dsh-eng-core'
import { appendDelegation } from 'dsh-eng-core/delegations'
import { readSplitReview, readSplitReviews, recordSplitReview, saveSplitPlan, splitPlanDigest, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** Sibling plugin tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Assemble the plugin with a fake approval seam answering `outcome` every time. */
function host(options: { approvalOutcome?: ApprovalOutcome; withApproval?: boolean } = {}): FakeHost {
    const cwd = tempWorkspace('orchestrator-split-approval-')
    const fake = createFakeHost({
        cwd,
        approvalOutcome: options.approvalOutcome ?? 'allowed-once',
        ...(options.withApproval === false ? { withApproval: false } : {}),
    })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log'), split: { enabled: true } })
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
function missionAt(fake: FakeHost, stage: string): { store: MissionStore; cwd: string; layout: Layout } {
    const store = storeFor(fake.cwd)
    store.create({ id: 'm-split', title: '拆分审核测试', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm-split', stage)
    store.update('m-split', () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: '拆分审核测试',
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

/** A valid two-task plan covering the three criteria. */
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

/** The number of review rows on disk (0 when nobody recorded anything). */
function reviewRows(layout: Layout): number {
    const file = path.join(layout.missionsDir, 'm-split', 'split', 'reviews.jsonl')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length : 0
}

function stageState(cwd: string, stageId: string): string | undefined {
    const file = path.join(cwd, '.dsh', 'missions', 'm-split', 'stages', `${stageId}.json`)
    if (!fs.existsSync(file)) return undefined
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { state: string }).state
}

// --- the four answers ------------------------------------------------------

test('allowed-once writes the approval for the shown digest and lets the mission enter implement (AC-003)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /→ 下一阶段 implement/)
    const record = readSplitReview(layout, 'm-split')
    assert.equal(record?.decision, 'approved')
    assert.equal(record?.planDigest, saved.digest, 'the record binds the digest the human saw')
    assert.equal(record?.approver, 'approval')
    assert.equal(reviewRows(layout), 1)
    assert.equal(stageState(cwd, 'split-review'), 'passed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
    // The card really was asked, through the host seam.
    assert.equal(fake.approvalRequests.length, 1)
    assert.match(JSON.stringify(fake.approvalRequests[0]), /拆分计划审核/)
    assert.match(JSON.stringify(fake.approvalRequests[0]), /approval-context/)
})

test('rejected writes a rejection (not an approval) and rolls back to a re-plan; implement is never entered', async () => {
    const fake = host({ approvalOutcome: 'rejected' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /审核被拒/)
    assert.match(text, /重新拆分/)
    const record = readSplitReview(layout, 'm-split')
    assert.equal(record?.decision, 'rejected')
    assert.equal(reviewRows(layout), 1)
    assert.equal(stageState(cwd, 'split-review'), 'failed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
})

test('cancelled writes NOTHING and leaves the stage entered (no decision = no pass)', async () => {
    const fake = host({ approvalOutcome: 'cancelled' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /审核被取消/)
    assert.match(text, /保持 entered/)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'split-review.json')), false)
})

test('unavailable writes NOTHING and says there was no answerer', async () => {
    const fake = host({ approvalOutcome: 'unavailable' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /没有应答者/)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
})

test('no approval seam refuses by name: 无审批通道, never an assumed pass', async () => {
    const fake = host({ withApproval: false })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /无审批通道/)
    assert.match(text, /未写任何审核记录/)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
    assert.equal(fake.approvalRequests.length, 0)
})

// --- plan edits must be re-reviewed ---------------------------------------

test('a plan edited after approval is reviewed again, and the NEW digest is what gets approved (TC-2012 / AC-003)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    const first = saveSplitPlan(layout, 'm-split', goodPlan())
    recordSplitReview(layout, 'm-split', { approver: 'alice', decision: 'approved', planDigest: first.digest })
    const edited = goodPlan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '换了目标' }
    const second = saveSplitPlan(layout, 'm-split', edited)
    assert.notEqual(second.digest, first.digest)

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /→ 下一阶段 implement/)
    const record = readSplitReview(layout, 'm-split')
    assert.equal(record?.planDigest, second.digest)
    assert.equal(record?.decision, 'approved')
    // The human was told the plan changed before being asked again.
    assert.match(JSON.stringify(fake.approvalRequests[0]), /必须重新审核/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

test('an already-approved plan is not asked again (a second card must not undo the first decision)', async () => {
    const fake = host({ approvalOutcome: 'rejected' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())
    recordSplitReview(layout, 'm-split', { approver: 'alice', decision: 'approved', planDigest: saved.digest })

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(fake.approvalRequests.length, 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

// --- the rework limit (AC-003 tail) ---------------------------------------

test('below maxReworkRounds the rejection still BLOCKS: the plan goes back for a re-plan', async () => {
    const fake = host({ approvalOutcome: 'rejected' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())
    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /未通过/)
    assert.match(text, /回退目标：split/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
    // The re-plan round is still allowed: the split stage does not degrade yet.
    const next = await orchestrate(fake, { action: 'advance' })
    assert.match(next, /→ 下一阶段 split-review/)
    assert.match(next, /通过三道自动校验/)
})

test('at maxReworkRounds the split degrades to plain implement and records a skipped stage (AC-003)', async () => {
    const fake = host({ approvalOutcome: 'rejected' })
    const { cwd, layout } = missionAt(fake, 'split')
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())
    recordSplitReview(layout, 'm-split', { approver: 'alice', decision: 'rejected', planDigest: saved.digest, note: '拆得太碎' })
    recordSplitReview(layout, 'm-split', { approver: 'alice', decision: 'rejected', planDigest: saved.digest, note: '还是不清晰' })
    assert.equal(readSplitReviews(layout, 'm-split').length, 2)

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /降级为 plain implement/)
    assert.match(text, /拒绝 2 轮（上限 maxReworkRounds=2）/)
    assert.match(text, /跳过 split-review：拆分多轮未通过审核，降级为 plain implement/)
    assert.equal(stageState(cwd, 'split'), 'passed')
    assert.equal(stageState(cwd, 'split-review'), 'skipped')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
    assert.equal(fake.approvalRequests.length, 0, 'degraded means no further review card')
    // Implementing is now plain: a developer delegation settles it.
    appendDelegation(cwd, { missionId: 'm-split', role: 'developer', childSessionId: 'child-1', stage: 'implement', at: Date.now() })
    const settled = await orchestrate(fake, { action: 'advance' })
    assert.match(settled, /→ 下一阶段 quality-verify/)
})

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
import { readSplitReview, readSplitReviews, recordSplitReview, saveSplitPlan, splitPlanDigest, splitRejectionCount, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** Sibling plugin tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * What the fake session policy reporter answers. `throws` models a host whose
 * policy store is broken; `absent` is the DEFAULT fake (no `effectivePolicy` at
 * all) and is covered by the pre-existing tests + the explicit TC-2502 test.
 */
type PolicyCase = 'never' | 'ask' | 'throws'

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** The reporter the patched approval service exposes (`effectivePolicy(session)`). */
function policyReporter(policy: PolicyCase): (session: unknown) => string {
    if (policy === 'throws') {
        return () => {
            throw new Error('policy store unavailable')
        }
    }
    return () => policy
}

/**
 * Give the fake approval service a real `effectivePolicy`, delegating `request`
 * to the original fake so `fake.approvalRequests` still counts the cards.
 */
function provideApprovalPolicy(fake: FakeHost, policy: PolicyCase): void {
    const context = fake.ctx as unknown as {
        get: (name: string) => unknown
        provide: (name: string, value: unknown) => unknown
    }
    const seam = context.get('approval') as Record<string, unknown>
    context.provide('approval', { ...seam, effectivePolicy: policyReporter(policy) })
}

/** Assemble the plugin with a fake approval seam answering `outcome` every time. */
function host(options: { approvalOutcome?: ApprovalOutcome; withApproval?: boolean; policy?: PolicyCase } = {}): FakeHost {
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
    if (options.policy !== undefined) provideApprovalPolicy(fake, options.policy)
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

test('allowed-once writes the approval for the shown digest and lets the mission enter implement (TC-2303 / AC-003)', async () => {
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
    // The card really was asked, through the host seam — the SAME
    // `ctx.get('approval')` service `spec_approve` asks through. TC-2303 pins that
    // there is exactly one request and it is this one (no second channel).
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

test('no approval seam refuses by name: 宿主没有 approval 接缝, never an assumed pass (TC-2304)', async () => {
    const fake = host({ withApproval: false })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    // P4 AC-003: the refusal names the missing piece exactly, and says why nothing
    // extra is needed — split-review uses the SAME host seam `spec_approve` uses.
    assert.match(text, /宿主没有 approval 接缝/)
    assert.match(text, /split-review 与 spec_approve 使用同一条宿主接缝/)
    assert.match(text, /跟随当前运行界面 tui\/web\/desktop/)
    assert.match(text, /配置了 IM 即走 IM/)
    assert.match(text, /不需要任何额外配置/)
    assert.match(text, /未写任何审核记录/)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
    assert.equal(fake.approvalRequests.length, 0)
})

// --- the session policy: `never` is not a human rejection ------------------

test('an approval policy of never BLOCKS by name, without a card or a review row (TC-2504 / TC-2505 / AC-001)', async () => {
    const fake = host({ policy: 'never' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    // The three sentences are the contract: what the host does, what the suite
    // did NOT record, and the one action that changes the outcome.
    assert.match(text, /本会话审批策略为 never（提示被禁用）：宿主不会弹任何审批卡，而是直接返回 rejected/)
    assert.match(text, /本会话审批策略为 never（不弹任何提示），无法人工审核拆分/)
    assert.match(text, /所以这次没有记录成'人工打回'，也不计入拆分审核轮数/)
    assert.match(text, /把审批策略切到 ask 后重新 advance 即可审核/)
    assert.match(text, /这是宿主策略，不是套件故障/)
    // Nothing was asked, nothing was recorded: the host's policy answered, not a
    // person — so reviews.jsonl (and the rejection count) stay untouched.
    assert.equal(fake.approvalRequests.length, 0, 'never must not render a card')
    assert.equal(reviewRows(layout), 0)
    assert.equal(splitRejectionCount(layout, 'm-split'), 0)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(stageState(cwd, 'split-review'), undefined, 'the stage stays entered, not settled')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
})

test('a never policy never spends a rework round: two advances keep 0 rejections and never degrade (TC-2506 / AC-003)', async () => {
    const fake = host({ policy: 'never' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    assert.match(await orchestrate(fake, { action: 'advance' }), /本会话审批策略为 never/)
    assert.match(await orchestrate(fake, { action: 'advance' }), /本会话审批策略为 never/)
    assert.equal(splitRejectionCount(layout, 'm-split'), 0, 'policy refusals never count as rejections')
    assert.equal(reviewRows(layout), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review', 'still waiting for a review, not degraded')
    // Degrading would pass `split` and skip `split-review`; neither happened.
    assert.equal(stageState(cwd, 'split'), undefined)
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'split.json')), false)
})

test('an approval policy of ask asks exactly once and records the approval (TC-2501 / TC-2503 / AC-002)', async () => {
    const fake = host({ policy: 'ask', approvalOutcome: 'allowed-once' })
    const { cwd, layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(fake.approvalRequests.length, 1)
    assert.equal(readSplitReview(layout, 'm-split')?.decision, 'approved')
    assert.equal(splitRejectionCount(layout, 'm-split'), 0)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

test('a seam without effectivePolicy still asks; a throwing reporter only logs (TC-2502 / TC-2507 / AC-002)', async () => {
    // The default fake has no `effectivePolicy` at all: the old-host shape.
    const absent = host({ approvalOutcome: 'allowed-once' })
    const first = missionAt(absent, 'split-review')
    saveSplitPlan(first.layout, 'm-split', goodPlan())
    assert.match(await orchestrate(absent, { action: 'advance' }), /→ 下一阶段 implement/)
    assert.equal(absent.approvalRequests.length, 1, 'an unreadable policy must not refuse the review')
    assert.equal(readSplitReview(first.layout, 'm-split')?.decision, 'approved')

    // A reporter that throws is "unknown", never "never": ask anyway, log why.
    const throwing = host({ approvalOutcome: 'allowed-once', policy: 'throws' })
    const second = missionAt(throwing, 'split-review')
    saveSplitPlan(second.layout, 'm-split', goodPlan())
    assert.match(await orchestrate(throwing, { action: 'advance' }), /→ 下一阶段 implement/)
    assert.equal(throwing.approvalRequests.length, 1)
    assert.equal(readSplitReview(second.layout, 'm-split')?.decision, 'approved')
    const log = fs.readFileSync(path.join(second.cwd, 'orchestrator.log'), 'utf8')
    assert.match(log, /读不到本会话审批策略/)
    assert.match(log, /effectivePolicy 抛错：policy store unavailable/)
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
    // AC-003 of the model-class follow-up: the summary says WHICH rule fired
    // (the review ran out of rounds) and explicitly separates it from the
    // threshold's "not worth splitting" verdict — those are different facts.
    assert.match(text, /拆分审核 2 轮未通过（maxReworkRounds=2）：按规则降级为 plain implement/)
    assert.match(text, /这不等于"不值得拆分"/)
    assert.match(text, /判定标准见 split-threshold：任务数 <2 \/ 路径完全相同才叫不值得拆/)
    assert.match(text, /降级为 plain implement/)
    assert.match(text, /不建 worktree、不派 worker/)
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

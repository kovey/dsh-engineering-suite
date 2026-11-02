/**
 * Revalidation before resume: `orchestrate({ action: "unblock" })` must first
 * re-check the mission's recorded authorisation (policy version, approver,
 * withdrawal), fail closed, and record the refusal in the mission's own trail.
 * Also covers `stop`, the only thing that withdraws a mandate.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStoreRegistry,
    policyFingerprint,
    type MissionRecord,
    type MissionStore,
    type SpecRecord,
} from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const SPEC: SpecRecord = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: [{ id: 'R-001', text: '暴露 GET /health' }],
    acceptanceCriteria: [{ id: 'AC-001', text: 'GET /health 返回 200' }],
    fileBoundaries: ['src/**'],
    negativeConstraints: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    approvedAt: 2,
    approvedBy: 'alice',
}

/** One assembled host over a workspace whose mission is `blocked`. */
function setup(options: {
    /** Files to write into the trust root before the mandate is recorded. */
    trustRoot?: Record<string, unknown>
    /** Runs after the policy snapshot is taken (e.g. edit a trust-root file). */
    afterApproval?: (cwd: string) => void
    withdraw?: boolean
    legacy?: boolean
} = {}): { fake: FakeHost; store: MissionStore; cwd: string; missionId: string; policy: string } {
    const cwd = tempWorkspace('orchestrator-mandate-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    for (const [name, value] of Object.entries(options.trustRoot ?? { 'quality-gate.json': { commands: [] } })) {
        // Strings are written verbatim (the approver list is one id per line);
        // objects are JSON (the plugin configs).
        fs.writeFileSync(path.join(cwd, '.dsh', name), typeof value === 'string' ? value : JSON.stringify(value))
    }
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    const mission = store.create({ title: 'Add health endpoint', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    const fingerprint = policyFingerprint(cwd)
    store.writeArtifact(mission.id, 'policy-fingerprint.json', `${JSON.stringify(fingerprint, undefined, 2)}\n`)
    const mandate = options.legacy
        ? undefined
        : {
              version: 1,
              strength: 'explicit',
              basis: 'spec-approved',
              scope: { phases: [], paths: ['src/**'] },
              policyVersion: fingerprint.version,
              approvedBy: 'alice',
              at: Date.now(),
              ...(options.withdraw === true ? { withdrawn: { at: Date.now(), by: 'bob', reason: '需求取消' } } : {}),
          }
    store.update(mission.id, () => ({
        status: 'blocked',
        spec: options.legacy ? { ...SPEC, approvedBy: 'approval' } : SPEC,
        ...(mandate === undefined ? {} : { mandate }),
    }))
    options.afterApproval?.(cwd)
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log') })
    return { fake, store, cwd, missionId: mission.id, policy: fingerprint.version }
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, runText(run))
    return runText(run)
}

/** The rows the refusal/success must leave in the mission's own trail. */
function evidence(store: MissionStore, id: string): { summary: string; data?: unknown }[] {
    return store.readEvidence(id).map((row) => ({ summary: row.summary, data: row.data }))
}

test('unblock refuses when the trust root changed: both versions, the changed file, the next step, still blocked', async () => {
    const { fake, store, missionId, policy } = setup({
        afterApproval: (cwd) => fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [{ id: 'test', command: 'go test ./...' }] })),
    })
    const current = policyFingerprint(fake.cwd).version
    const text = await orchestrate(fake, { action: 'unblock', summary: 'fix applied' })
    assert.match(text, new RegExp(policy), 'the recorded version is quoted')
    assert.match(text, new RegExp(current), 'the current version is quoted')
    assert.match(text, /\.dsh\/quality-gate\.json/)
    assert.match(text, /spec_create/)
    assert.match(text, /spec_approve/)
    assert.match(text, /mandate 复核未通过/)
    assert.equal(store.read(missionId)?.status, 'blocked', 'fail closed: the mission stays blocked')

    const rows = evidence(store, missionId)
    assert.ok(rows.some((row) => JSON.stringify(row).includes('"result":"refused"')), 'the refusal is a durable row')
    assert.match(rows.at(-1)?.summary ?? '', /mandate 复核拒绝解除熔断/)
})

test('unblock succeeds when the policy still holds, and records what it revalidated', async () => {
    const { fake, store, missionId, policy } = setup()
    const text = await orchestrate(fake, { action: 'unblock', summary: 'transient failure' })
    assert.match(text, /熔断已解除/)
    assert.match(text, new RegExp(policy.slice(0, 12)))
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.ok(evidence(store, missionId).some((row) => JSON.stringify(row).includes('"result":"allowed"')))
})

test('unblock refuses when the approver was removed from the allowlist (not a policy-version change)', async () => {
    const { fake, store, missionId } = setup({
        trustRoot: {
            'quality-gate.json': { commands: [] },
            'interaction-gate.json': { requireApproverList: true },
            'interaction-approvers.txt': 'alice\n',
        },
        // The approver list is NOT part of the fingerprint, so this is the one
        // way to change "who is allowed" without changing the policy version.
        afterApproval: (cwd) => fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-approvers.txt'), 'carol\n'),
    })
    const text = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(text, /审批人 alice 已不在允许清单里/)
    assert.match(text, /interaction-approvers\.txt/)
    assert.equal(store.read(missionId)?.status, 'blocked')
})

test('unblock refuses a withdrawn mandate (a person\'s stop cannot be released)', async () => {
    const { fake, store, missionId } = setup({ withdraw: true })
    const text = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(text, /已被 bob .*撤回/)
    assert.match(text, /需求取消/)
    assert.equal(store.read(missionId)?.status, 'blocked')
})

test('stop records the withdrawal (who/when/why) and blocks the mission; unblock then refuses', async () => {
    const { fake, store, missionId } = setup()
    // Move it out of `blocked` first so stop is a real transition.
    store.setStatus(missionId, 'spec-approved')
    const text = await orchestrate(fake, { action: 'stop', summary: '需求取消', by: 'alice' })
    assert.match(text, /已停止/)
    const mission = store.read(missionId)
    assert.equal(mission?.status, 'blocked')
    assert.deepEqual(mission?.mandate?.withdrawn && { by: mission.mandate.withdrawn.by, reason: mission.mandate.withdrawn.reason }, {
        by: 'alice',
        reason: '需求取消',
    })
    assert.equal(mission?.mandate?.strength, 'explicit', 'the grant itself is not rewritten')
    assert.equal(mission?.mandate?.policyVersion, JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'policy-fingerprint.json'), 'utf8')).version)

    const refused = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(refused, /授权已被 alice .*撤回/)
    assert.equal(store.read(missionId)?.status, 'blocked')
})

test('stop without a reason is refused; a legacy mission has nothing to withdraw', async () => {
    const { fake, store, missionId } = setup()
    store.setStatus(missionId, 'spec-approved')
    const noReason = await orchestrate(fake, { action: 'stop' })
    assert.match(noReason, /需要说明原因/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    const legacy = setup({ legacy: true })
    const legacyText = await orchestrate(legacy.fake, { action: 'stop', summary: '取消' })
    assert.match(legacyText, /legacy/)
    assert.match(legacyText, /没有可撤回的对象/)
    assert.equal(legacy.store.read(legacy.missionId)?.status, 'blocked')
})

test('a legacy mission revalidates as a stated fact and unblock still works', async () => {
    const { fake, store, missionId } = setup({ legacy: true })
    const text = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(text, /legacy/)
    assert.match(text, /事实，不是缺陷/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
})

test('legacy is stated, not treated as a defect: a removed concrete approver still refuses', async () => {
    const { fake, store, missionId } = setup({
        legacy: true,
        trustRoot: { 'quality-gate.json': { commands: [] }, 'interaction-gate.json': { requireApproverList: true } },
        afterApproval: (cwd) => fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-approvers.txt'), 'carol\n'),
    })
    // The legacy view's approver is the placeholder `approval`: no identity an
    // allowlist could contain, so it is not refused (compatibility).
    const text = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(text, /legacy/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    // A mission whose legacy approval names a CONCRETE person is checked.
    const concrete = setup({ legacy: true })
    concrete.store.update(concrete.missionId, (record) => ({
        spec: record.spec === undefined ? undefined : { ...record.spec, approvedBy: 'alice' },
    }))
    fs.writeFileSync(path.join(concrete.cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ requireApproverList: true }))
    fs.writeFileSync(path.join(concrete.cwd, '.dsh', 'interaction-approvers.txt'), 'carol\n')
    const refused = await orchestrate(concrete.fake, { action: 'unblock', summary: 'release' })
    assert.match(refused, /已不在允许清单里/)
    assert.equal(concrete.store.read(concrete.missionId)?.status, 'blocked')
})

test('the stop action is in the contract and a resumed mission still reports its mandate', async () => {
    const { fake, store, missionId } = setup()
    const stages = await orchestrate(fake, { action: 'status' })
    assert.match(stages, new RegExp(missionId))
    // No `stop` regression: the action exists and is documented in the enum.
    const unknown = await fake.runTool('orchestrate', { action: 'stop-everything' })
    assert.equal(unknown.isError, true)
    assert.match(String(unknown.content), /"stop"/)
    assert.equal(store.read(missionId)?.mandate?.strength, 'explicit')
})

test('a mission whose mandate record is corrupt is refused, never treated as "no mandate"', async () => {
    const { fake, store, missionId } = setup()
    store.update(missionId, () => ({ mandate: { version: 1, strength: 'legacy' } as never }))
    const text = await orchestrate(fake, { action: 'unblock', summary: 'release' })
    assert.match(text, /记录损坏/)
    assert.equal(store.read(missionId)?.status, 'blocked')
})

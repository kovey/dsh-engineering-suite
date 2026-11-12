/**
 * The stage-role half of the write guard (AC-005): a stage that declares a role
 * may only be written by the child delegated for that stage. Reads and stages
 * without a role are untouched.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type MissionStore } from 'dsh-eng-core'
import { appendDelegation } from 'dsh-eng-core/delegations'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const FILE_BOUNDARIES = ['src/**']

/** Assemble spec-gate and put its session on an approved mission in `stage`. */
function hostWithMission(stage: string, options: { role?: string } = {}): { fake: FakeHost; store: MissionStore; missionId: string } {
    const cwd = tempWorkspace('spec-gate-stage-role-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })

    const store = new MissionStoreRegistry().for(cwd)
    const missionId = 'mission-stage-role'
    store.create({ id: missionId, title: 'stage role', cwd, sessionId: 'session-1' })
    store.update(missionId, () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: 'stage role',
            background: '',
            requirements: [],
            acceptanceCriteria: [],
            fileBoundaries: FILE_BOUNDARIES,
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
        },
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
    store.bindSession('session-1', missionId, stage)
    store.writeStageResult(missionId, {
        stageId: stage,
        attempt: 1,
        state: 'entered',
        enteredAt: Date.now(),
        ...(options.role === undefined ? {} : { role: options.role }),
    })
    return { fake, store, missionId }
}

/** A delegated child of `session-1` (the mission is inherited through the header). */
function childAgent(cwd: string, sessionId: string) {
    return {
        id: `agent-${sessionId}`,
        session: { id: sessionId, header: { id: sessionId, cwd, origin: 'subagent', parentSession: 'session-1' } },
    }
}

test('the lead cannot write in a stage that declares a role (TC-1553)', () => {
    const { fake } = hostWithMission('implement', { role: 'developer' })
    const reason = fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent })
    assert.match(reason ?? '', /阶段 implement 声明了角色 developer/)
    assert.match(reason ?? '', /team_delegate\(\{ role: 'developer'/)
    assert.match(reason ?? '', /delegations\.jsonl/)
    assert.match(reason ?? '', /读操作不受影响/)
})

test('the delegated child of that stage may write (TC-1551)', () => {
    const { fake, missionId } = hostWithMission('implement', { role: 'developer' })
    const cwd = fake.cwd
    appendDelegation(cwd, { missionId, role: 'developer', childSessionId: 'session-child', stage: 'implement', at: Date.now() })
    const child = childAgent(cwd, 'session-child')
    assert.equal(
        fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: child }),
        undefined,
        'the recorded delegation is what unblocks the child write',
    )
})

test('a child delegated for another stage or role is still refused', () => {
    const { fake, missionId } = hostWithMission('implement', { role: 'developer' })
    const cwd = fake.cwd
    appendDelegation(cwd, { missionId, role: 'qa', childSessionId: 'session-qa', stage: 'quality-verify', at: Date.now() })
    const reason = fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: childAgent(cwd, 'session-qa') })
    assert.match(reason ?? '', /阶段 implement 声明了角色 developer/)
})

test('a stage without a declared role is unaffected (TC-1556)', () => {
    const { fake } = hostWithMission('quality-verify')
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }), undefined)
    // The boundary rule still applies exactly as before.
    const outside = fake.guardReason({ name: 'write', arguments: { file_path: 'docs/readme.md' }, agent: fake.agent })
    assert.match(outside ?? '', /不在规格声明的文件边界内/)
})

test('read tools are never gated by the stage role', () => {
    const { fake } = hostWithMission('implement', { role: 'developer' })
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'grep', arguments: { pattern: 'x', path: 'src' }, agent: fake.agent }), undefined)
})

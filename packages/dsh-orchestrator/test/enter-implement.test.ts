/**
 * The `orchestrator` service (强制进入 implement / AC-001): `enterImplement`
 * walks the mission stage by stage up to `implement`, reusing the `advance`
 * code path — so every step is judged by the existing entry gates, never by a
 * jump. These tests fix the stopping points: satisfied gates reach `implement`;
 * a missing test design stops at `test-design-review` with the missing fact; an
 * unapproved spec stops at `spec-approve`.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type MissionStore } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** The tools the default pipeline probes (a mounted sibling plugin). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

/** One host assembled by a test, torn down at the end. */
const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Assemble the plugin, stub the sibling tools and park a mission on `stage`. */
function hostWithMission(stage: string, options: { approved?: boolean; testDesign?: boolean } = {}): {
    fake: FakeHost
    store: MissionStore
    cwd: string
    missionId: string
} {
    const cwd = tempWorkspace('orchestrator-enter-implement-')
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log') })
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    const store = new MissionStoreRegistry().for(cwd)
    const missionId = 'mission-enter-implement'
    store.create({ id: missionId, title: 'enter implement', cwd, sessionId: 'session-1' })
    store.update(missionId, () => ({
        stage,
        status: 'spec-approved',
        ...(options.approved === false
            ? {}
            : {
                  spec: {
                      title: 'enter implement',
                      background: '',
                      requirements: [],
                      acceptanceCriteria: [],
                      fileBoundaries: ['packages/**'],
                      negativeConstraints: [],
                      revision: 1,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      approvedAt: Date.now(),
                      approvedBy: 'test',
                  },
              }),
        ...(options.testDesign === false ? {} : { testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() } }),
    }))
    return { fake, store, cwd, missionId }
}

/** The provided service, typed the way a consumer sees it. */
function serviceOf(fake: FakeHost): { enterImplement: (missionId: string, cwd?: string) => Promise<{ ok: boolean; stage?: string; message: string }> } {
    const service = (fake.ctx as { get: (name: string) => unknown }).get('orchestrator') as
        | { enterImplement?: (missionId: string, cwd?: string) => Promise<{ ok: boolean; stage?: string; message: string }> }
        | undefined
    assert.equal(typeof service?.enterImplement, 'function', 'the plugin provides the optional orchestrator service')
    return service as { enterImplement: (missionId: string, cwd?: string) => Promise<{ ok: boolean; stage?: string; message: string }> }
}

test('the plugin provides the optional orchestrator service (AC-001)', () => {
    const cwd = tempWorkspace('orchestrator-service-')
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log') })
    serviceOf(fake)
    // Teardown withdraws it: a service nobody provides must not linger.
    fake.dispose()
    assert.equal((fake.ctx as { get: (name: string) => unknown }).get('orchestrator'), undefined)
})

test('entry gates satisfied: enterImplement reaches implement stage by stage (TC-1801)', async () => {
    const { fake, store, cwd, missionId } = hostWithMission('spec-clarify')
    const result = await serviceOf(fake).enterImplement(missionId, cwd)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.stage, 'implement')
    const mission = store.read(missionId)
    assert.equal(mission?.stage, 'implement')
    assert.equal(mission?.status, 'implementing')
    // The settlements it walked through are on the record, in order.
    assert.equal(store.listStageResults(missionId).length, 4, 'spec-clarify → test-design-review → spec-approve → implement entered')
})

test('missing test design stops at test-design-review and names the missing fact (TC-1803)', async () => {
    const { fake, store, cwd, missionId } = hostWithMission('spec-clarify', { testDesign: false })
    const result = await serviceOf(fake).enterImplement(missionId, cwd)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'test-design-review')
    assert.match(result.message, /测试设计/)
    assert.match(result.message, /testDesign/)
    // It stopped AT the stage: implement was not entered.
    assert.equal(store.read(missionId)?.stage, 'test-design-review')
    assert.equal(store.readStageResult(missionId, 'implement'), undefined)
})

test('an unapproved spec stops at spec-approve instead of advancing into implement', async () => {
    const { fake, store, cwd, missionId } = hostWithMission('spec-approve', { approved: false })
    const result = await serviceOf(fake).enterImplement(missionId, cwd)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'spec-approve')
    assert.match(result.message, /规格尚未审批/)
    assert.equal(store.read(missionId)?.stage, 'spec-approve')
})

test('a mission that never entered the pipeline is told to start it, not guessed into a stage', async () => {
    const { fake, store, cwd, missionId } = hostWithMission('spec-clarify')
    store.update(missionId, () => ({ stage: undefined }))
    const result = await serviceOf(fake).enterImplement(missionId, cwd)
    assert.equal(result.ok, false)
    assert.match(result.message, /还没有进入流水线/)
    assert.match(result.message, /orchestrate\(\{ action: "start"/)
})

test('an unknown mission id is a result, not a throw', async () => {
    const { fake, cwd } = hostWithMission('spec-clarify')
    const result = await serviceOf(fake).enterImplement('mission-does-not-exist', cwd)
    assert.equal(result.ok, false)
    assert.match(result.message, /不在工作区/)
})

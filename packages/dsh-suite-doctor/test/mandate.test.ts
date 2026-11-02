/**
 * The mandate check the doctor reports: `mandate.policy` (required when an
 * in-flight mission's recorded policy version no longer matches), the changed
 * files it names, and the `legacy` fact `suite_status` states for old missions.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStoreRegistry,
    checkWorkspace,
    policyFingerprint,
    renderDoctor,
    withRuntime,
    type MissionStore,
} from 'dsh-eng-core'
import { fakeAgent, tempWorkspace } from 'dsh-eng-core/testing'
import { probeRuntime } from '../dist/probe.js'

interface Seeded {
    cwd: string
    store: MissionStore
    id: string
    policyVersion: string
}

/** A workspace with one mission, its mandate, and a fingerprint snapshot. */
function seed(options: { status?: string; legacy?: boolean; cwd?: string } = {}): Seeded {
    const cwd = options.cwd ?? tempWorkspace('suite-doctor-mandate-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const config = path.join(cwd, '.dsh', 'quality-gate.json')
    if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ commands: [] }))
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    const mission = store.create({ title: 'Add health endpoint', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    const fingerprint = policyFingerprint(cwd)
    if (options.legacy !== true) {
        store.writeArtifact(mission.id, 'policy-fingerprint.json', `${JSON.stringify(fingerprint, undefined, 2)}\n`)
    }
    store.update(mission.id, () => ({
        status: (options.status ?? 'implementing') as never,
        ...(options.legacy === true
            ? { spec: { title: 't', background: '', requirements: [], acceptanceCriteria: [], fileBoundaries: [], negativeConstraints: [], revision: 1, createdAt: 1, updatedAt: 1, approvedAt: 1, approvedBy: 'approval' } }
            : {
                  spec: { title: 't', background: '', requirements: [], acceptanceCriteria: [], fileBoundaries: [], negativeConstraints: [], revision: 1, createdAt: 1, updatedAt: 1, approvedAt: 1, approvedBy: 'alice' },
                  mandate: {
                      version: 1,
                      strength: 'explicit',
                      basis: 'spec-approved',
                      scope: { phases: [], paths: [] },
                      policyVersion: fingerprint.version,
                      approvedBy: 'alice',
                      at: 1,
                  },
              }),
    }))
    return { cwd, store, id: mission.id, policyVersion: fingerprint.version }
}

function mandateCheck(cwd: string) {
    const report = checkWorkspace({ cwd, now: 0 })
    return { check: report.checks.find((entry) => entry.id === 'mandate.policy'), report }
}

test('a stale mandate is a REQUIRED finding naming the mission and the changed file', () => {
    const { cwd, id } = seed()
    // Change one trust-root file after the approval.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [{ id: 'test', command: 'go test ./...' }] }))
    const { check, report } = mandateCheck(cwd)
    assert.ok(check !== undefined)
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.detail ?? '', new RegExp(id))
    assert.match(check?.detail ?? '', /\.dsh\/quality-gate\.json/)
    assert.match(check?.detail ?? '', /policy [0-9a-f]{12}…? → [0-9a-f]{12}/)
    assert.match(check?.fix ?? '', /spec_approve/)
    assert.match(check?.fix ?? '', /spec_create/)
    assert.ok(report.blockers.some((entry) => entry.id === 'mandate.policy'), 'the drift blocks a healthy setup')
})

test('matching mandates are ok', () => {
    const { cwd } = seed()
    const { check, report } = mandateCheck(cwd)
    assert.equal(check?.state, 'ok')
    assert.match(check?.detail ?? '', /与当前信任根一致/)
    assert.equal(report.blockers.some((entry) => entry.id === 'mandate.policy'), false)
})

test('nothing to judge is unknown with the reason (never ok)', () => {
    const empty = tempWorkspace('suite-doctor-mandate-empty-')
    const { check } = mandateCheck(empty)
    assert.equal(check?.state, 'unknown')
    assert.match(check?.detail ?? '', /还没有 mission/)

    const draft = seed()
    // Replace the approved mission with an unapproved draft: no mandate exists.
    draft.store.update(draft.id, () => ({ status: 'draft', spec: undefined, mandate: undefined }))
    const { check: second } = mandateCheck(draft.cwd)
    assert.equal(second?.state, 'unknown')
    assert.match(second?.detail ?? '', /没有可比的 policyVersion/)
})

test('delivered missions are history: they are not revalidated', () => {
    const { cwd } = seed({ status: 'delivered' })
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: ['changed'] }))
    const { check } = mandateCheck(cwd)
    assert.equal(check?.state, 'unknown', 'no in-flight mission = nothing to judge')
    assert.match(check?.detail ?? '', /都已交付|没有在飞/)
})

test('a legacy approval is reported as a fact, not as a defect (doctor and suite_status)', async () => {
    const { cwd, id } = seed({ legacy: true })
    const { check, report } = mandateCheck(cwd)
    assert.equal(check?.state, 'unknown', 'a legacy mission has no policyVersion to compare')
    assert.match(check?.detail ?? '', /legacy/)
    assert.match(check?.detail ?? '', /事实，不是缺陷/)
    assert.equal(report.blockers.some((entry) => entry.id === 'mandate.policy'), false, 'legacy is never a blocker')

    // The runtime half states it for the session's own mission.
    const stores = new MissionStoreRegistry()
    const probe = await probeRuntime({
        ctx: { tools: { get: () => undefined }, get: () => undefined },
        agent: fakeAgent(cwd, 'agent-1', 'session-1'),
        expectedPlugins: [],
        stores,
        cwd,
        probeTimeoutMs: 1_000,
    })
    assert.equal(probe.facts.mission?.id, id)
    assert.equal(probe.facts.mission?.mandate?.strength, 'legacy')
    const text = renderDoctor(withRuntime(checkWorkspace({ cwd, now: 0 }), probe.facts))
    assert.match(text, /mandate legacy/)
    assert.match(text, /事实，不是缺陷/)
})

test('the detail names at most five missions and summarises the rest', () => {
    const first = seed()
    for (let index = 1; index < 6; index += 1) seed({ cwd: first.cwd })
    fs.writeFileSync(path.join(first.cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: ['changed again'] }))
    const { check } = mandateCheck(first.cwd)
    assert.equal(check?.state, 'missing')
    assert.match(check?.detail ?? '', /另有 1 个 mission 的 mandate 已过期/)
})

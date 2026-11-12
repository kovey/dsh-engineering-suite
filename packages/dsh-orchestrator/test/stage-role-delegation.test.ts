/**
 * The stage-role constraint on `advance` (AC-006): leaving a stage that declares
 * a role requires the delegation record `team_delegate` writes; the default is
 * `reject`, `stageRoleDelegation: 'warn'` only reports.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type MissionStore } from 'dsh-eng-core'
import { appendDelegation, readDelegations } from 'dsh-eng-core/delegations'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply as applyRoleGuard } from 'dsh-role-guard'
import { apply } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'

/** `plan` → `implement` (role: developer) → `review`: no sibling plugin needed. */
const STAGES = [
    { id: 'plan', prompt: '写计划', requiredPlugins: [], gate: 'none', next: 'implement' },
    { id: 'implement', prompt: '实现', requiredPlugins: [], gate: 'none', role: 'developer', next: 'review' },
    { id: 'review', prompt: '审查', requiredPlugins: [], gate: 'none' },
]

function host(options: { stageRoleDelegation?: 'reject' | 'warn' } = {}): FakeHost {
    const cwd = tempWorkspace('orchestrator-stage-role-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'orchestrator.log'),
        stages: STAGES,
        ...(options.stageRoleDelegation === undefined ? {} : { stageRoleDelegation: options.stageRoleDelegation }),
    })
    return fake
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

function missionIdOf(cwd: string): string {
    const dir = path.join(cwd, '.dsh', 'missions')
    const ids = fs.readdirSync(dir)
    assert.equal(ids.length, 1, `expected exactly one mission, got ${ids.join(', ')}`)
    return ids[0] as string
}

function storeFor(cwd: string): MissionStore {
    return new MissionStoreRegistry().for(cwd)
}

/** Put a fresh mission on the `implement` stage (entered, role recorded). */
async function enterImplement(fake: FakeHost): Promise<{ missionId: string; store: MissionStore }> {
    await orchestrate(fake, { action: 'start', summary: 'stage role' })
    const missionId = missionIdOf(fake.cwd)
    await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.equal(storeFor(fake.cwd).read(missionId)?.stage, 'implement')
    const artifact = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'stages', 'implement.json'), 'utf8')) as {
        state: string
        role?: string
    }
    assert.equal(artifact.role, 'developer', 'precondition: the stage declares a role')
    return { missionId, store: storeFor(fake.cwd) }
}

/**
 * A host with the REAL role-guard plugin composed next to the orchestrator, and
 * `autoDispatch` on for the role-declaring `implement` stage.
 *
 * Mounting the real plugin (rather than a stub service) is the point: the seam
 * under test is "the dispatcher calls service.bind(), and bind leaves the row
 * advance reads". A stub whose bind() performed the write would assert the
 * test's own bookkeeping, not the shipped path.
 */
function autoDispatchHost(): FakeHost {
    const cwd = tempWorkspace('orchestrator-stage-role-auto-')
    const fake = createFakeHost({ cwd, withSubagents: true })
    // The role whitelist is pruned against the tools this deployment exposes.
    for (const toolName of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image']) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    applyRoleGuard(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log') })
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'orchestrator.log'),
        stages: STAGES,
        autoDispatch: { enabled: true, stages: ['implement'] },
    })
    return fake
}

test('advance passes for an auto-dispatched role child: bind() wrote the record (TC-1562)', async () => {
    const fake = autoDispatchHost()
    // Entering `implement` dispatches the child itself; no team_delegate call.
    const { missionId, store } = await enterImplement(fake)
    assert.equal(fake.subagentStarts.length, 1, 'the role stage was auto-dispatched exactly once')

    // role-guard's service.bind() produced the SAME row team_delegate would:
    // the child's session id, the mission, the stage and the role.
    const rows = readDelegations(fake.cwd, missionId)
    assert.equal(rows.length, 1, 'one delegation row from the auto-dispatch path')
    assert.deepEqual(
        { mission: rows[0]?.missionId, role: rows[0]?.role, stage: rows[0]?.stage, child: rows[0]?.childSessionId },
        { mission: missionId, role: 'developer', stage: 'implement', child: 'run-1' },
    )

    // advance must pass on that record alone — this test never calls
    // appendDelegation(), so "the model forgot to add the row" is not a factor.
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS', summary: '实现完成' })
    assert.match(text, /→ 下一阶段 review/)
    assert.doesNotMatch(text, /advance 被拒绝/)
    assert.equal(store.read(missionId)?.stage, 'review')
})

test('advance refuses to leave a role stage with no delegation record (TC-1554)', async () => {
    const fake = host()
    const { missionId, store } = await enterImplement(fake)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /阶段 implement 声明了角色 developer/)
    assert.match(text, /delegations\.jsonl/)
    assert.match(text, /team_delegate\(\{ role: 'developer'/)
    assert.match(text, /advance 被拒绝/)
    assert.match(text, /stageRoleDelegation/)
    // Refusing must not move the mission: the stage stays entered, the retry is free.
    assert.equal(store.read(missionId)?.stage, 'implement')
    const artifact = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'stages', 'implement.json'), 'utf8')) as {
        state: string
        attempt: number
    }
    assert.equal(artifact.state, 'entered')
    assert.equal(artifact.attempt, 1)
})

test('a recorded delegation for the stage lets advance settle it (TC-1552)', async () => {
    const fake = host()
    const { missionId, store } = await enterImplement(fake)
    appendDelegation(fake.cwd, {
        missionId,
        role: 'developer',
        childSessionId: 'session-child',
        stage: 'implement',
        at: Date.now(),
    })

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS', summary: '实现完成' })
    assert.match(text, /→ 下一阶段 review/)
    assert.equal(store.read(missionId)?.stage, 'review')
    const artifact = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'stages', 'implement.json'), 'utf8')) as {
        state: string
    }
    assert.equal(artifact.state, 'passed')
})

test("stageRoleDelegation: 'warn' only warns and lets the advance through (TC-1555)", async () => {
    const fake = host({ stageRoleDelegation: 'warn' })
    const { missionId, store } = await enterImplement(fake)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /仅告警并放行/)
    assert.match(text, /⚠️/)
    assert.match(text, /→ 下一阶段 review/)
    assert.equal(store.read(missionId)?.stage, 'review')
})

test('a non-role stage is not affected by the delegation requirement', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'non-role' })
    const missionId = missionIdOf(fake.cwd)
    // `plan` declares no role: settling it needs no delegation record.
    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(storeFor(fake.cwd).read(missionId)?.stage, 'implement')
})

test('an unknown stageRoleDelegation value falls back to reject and is reported', () => {
    assert.equal(resolveConfig({}).config.stageRoleDelegation, 'reject', 'the default is the strict mode')
    const resolved = resolveConfig({ stageRoleDelegation: 'ignore' })
    assert.equal(resolved.config.stageRoleDelegation, 'reject')
    assert.ok(resolved.issues.some((issue) => /stageRoleDelegation 只接受 'reject' \| 'warn'/.test(issue)))
})

/**
 * 强制进入 implement (AC-005 / AC-006) — the two halves of the spec-gate side:
 *
 *  1. `spec_approve` asks the OPTIONAL `orchestrator.enterImplement` service to
 *     move the mission into `implement`, best effort: a missing, failing or
 *     throwing service never turns a granted approval into an error;
 *  2. the write guard refuses CODE writes outside `implement` (independently of
 *     roles), while documentation/configuration writes stay open and the
 *     existing "not approved" refusal keeps priority.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type MissionStore } from 'dsh-eng-core'
import { appendDelegation } from 'dsh-eng-core/delegations'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const TEST_DESIGN = [
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动 | 请求 /health | 返回 200 | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口被占用 | 启动服务 | 退出码非 0 并打印原因 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 配置为空 | 启动服务 | 使用默认端口 | AC-001 |',
    '',
].join('\n')

const DRAFT = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: ['暴露 GET /health'],
    acceptanceCriteria: ['GET /health 返回 200', '端口占用时启动失败'],
    fileBoundaries: ['src/server.ts'],
    negativeConstraints: ['不得修改 dsh 核心代码'],
    testDesign: TEST_DESIGN,
}

/** The file boundaries the guard fixtures declare: code, docs and config. */
const BOUNDARIES = ['packages/**', 'src/**', 'docs/**', 'CHANGELOG.md', 'package.json']

/** One host assembled by a test, torn down at the end. */
const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Assemble spec-gate on a fake host (approval granted once). */
function host(): FakeHost {
    const cwd = tempWorkspace('spec-gate-advance-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(fake.cwd, 'spec-gate.log') })
    return fake
}

/** Register a fake orchestrator service (`ctx.provide`, like the real plugin). */
function provideService(fake: FakeHost, service: unknown): void {
    ;(fake.ctx as { provide: (name: string, value: unknown) => unknown }).provide('orchestrator', service)
}

/** The mission spec_create just wrote. */
function missionIdOf(fake: FakeHost): string {
    return fs.readdirSync(path.join(fake.cwd, '.dsh', 'specs'))[0]?.replace(/\.md$/, '') ?? ''
}

/** spec_create → the mission id (no test_design_review is mounted, so approval needs none). */
async function createSpec(fake: FakeHost): Promise<string> {
    const run = await fake.runTool('spec_create', DRAFT)
    assert.equal(run.isError, false, runText(run))
    return missionIdOf(fake)
}

/** Assemble spec-gate and park a mission on `stage`, approved unless told otherwise. */
function hostWithMission(stage: string, options: { approved?: boolean; role?: string } = {}): { fake: FakeHost; store: MissionStore; missionId: string } {
    const cwd = tempWorkspace('spec-gate-code-stage-')
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const store = new MissionStoreRegistry().for(cwd)
    const missionId = 'mission-code-stage'
    store.create({ id: missionId, title: 'code stage', cwd, sessionId: 'session-1' })
    store.update(missionId, () => ({
        stage,
        status: options.approved === false ? 'draft' : 'spec-approved',
        spec: {
            title: 'code stage',
            background: '',
            requirements: [],
            acceptanceCriteria: [],
            fileBoundaries: BOUNDARIES,
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...(options.approved === false ? {} : { approvedAt: Date.now(), approvedBy: 'test' }),
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

test('spec_approve calls orchestrator.enterImplement and reports reaching implement (TC-1800)', async () => {
    const fake = host()
    const calls: { missionId: string; cwd?: string }[] = []
    provideService(fake, {
        enterImplement: async (missionId: string, cwd?: string) => {
            calls.push({ missionId, ...(cwd === undefined ? {} : { cwd }) })
            return { ok: true, stage: 'implement', message: '已在 implement' }
        },
    })
    const missionId = await createSpec(fake)
    const run = await fake.runTool('spec_approve', {})
    const text = runText(run)
    assert.equal(run.isError, false, text)
    assert.deepEqual(calls, [{ missionId, cwd: fake.cwd }], 'called once, with the mission and its workspace')
    assert.match(text, /已进入 implement/)
    assert.match(text, /team_delegate\(\{ role: 'developer'/)
})

test('a throwing orchestrator service never fails the approval (best effort)', async () => {
    const fake = host()
    provideService(fake, {
        enterImplement: async () => {
            throw new Error('orchestrator exploded')
        },
    })
    const missionId = await createSpec(fake)
    const run = await fake.runTool('spec_approve', {})
    assert.equal(run.isError, false, runText(run))
    assert.match(runText(run), /规格已审批/)
    const mission = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'mission.json'), 'utf8')) as { status: string }
    assert.equal(mission.status, 'spec-approved')
})

test('a service that cannot advance says where the mission stopped and why', async () => {
    const fake = host()
    provideService(fake, {
        enterImplement: async () => ({ ok: false, stage: 'test-design-review', message: '测试设计尚未通过：调用 test_design_review。' }),
    })
    await createSpec(fake)
    const text = runText(await fake.runTool('spec_approve', {}))
    assert.match(text, /停在 test-design-review/)
    assert.match(text, /test_design_review/)
})

test('an approved mission in spec-clarify cannot write code (TC-1804)', () => {
    const { fake } = hostWithMission('spec-clarify')
    const reason = fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent })
    assert.match(reason ?? '', /当前阶段是 spec-clarify/)
    assert.match(reason ?? '', /src\/a\.ts/)
    assert.match(reason ?? '', /orchestrate advance 到 implement/)
    assert.match(reason ?? '', /team_delegate\(\{ role: 'developer'/)
})

test('documentation/configuration writes in spec-clarify are not blocked by the stage rule (TC-1805)', () => {
    const { fake } = hostWithMission('spec-clarify')
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'docs/a.md' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'CHANGELOG.md' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'package.json' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'packages/x/package.json' }, agent: fake.agent }), undefined)
})

test('the implement stage allows the delegated developer to write code (TC-1802)', () => {
    const { fake, missionId } = hostWithMission('implement', { role: 'developer' })
    appendDelegation(fake.cwd, { missionId, role: 'developer', childSessionId: 'session-1', stage: 'implement', at: Date.now() })
    const reason = fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent })
    assert.equal(reason, undefined, 'the stage rule does not fire in implement')
})

test('an unapproved mission keeps the existing refusal, before the stage rule', () => {
    const { fake } = hostWithMission('spec-clarify', { approved: false })
    const reason = fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent })
    assert.match(reason ?? '', /尚未审批/)
    assert.doesNotMatch(reason ?? '', /不是 implement/)
})

/**
 * The mandate written by `spec_approve`: its exact shape, the computed strength
 * matrix (allowlist / local operator / subagent / IM), immutability, and the
 * `inferred` fail-closed rule at the write guard.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { mandateState, policyVersion } from 'dsh-eng-core'
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

interface MissionJson {
    status: string
    spec?: { approvedAt?: number; approvedBy?: string; fileBoundaries: string[] }
    mandate?: {
        version: number
        strength: string
        basis: string
        scope: { phases: string[]; paths: string[] }
        policyVersion: string
        approvedBy: string
        at: number
        withdrawn?: { at: number; by: string; reason: string }
    }
}

/** One assembled host, with an injectable approval answer and optional allowlist. */
function host(
    options: {
        cwd?: string
        approve?: (request: unknown) => unknown
        allowlist?: string[]
        config?: Record<string, unknown>
    } = {},
): FakeHost {
    const cwd = options.cwd ?? tempWorkspace('spec-mandate-')
    if (options.allowlist !== undefined) {
        fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
        fs.writeFileSync(path.join(cwd, '.dsh', 'role-guard.json'), JSON.stringify({ approvers: options.allowlist }))
    }
    const fake = createFakeHost({
        cwd,
        withApproval: false,
        services: { approval: { request: async (request: unknown) => (options.approve ?? (() => 'allowed-once'))(request) } },
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), ...(options.config ?? {}) })
    return fake
}

function missionIdOf(fake: FakeHost): string {
    return fs.readdirSync(path.join(fake.cwd, '.dsh', 'specs'))[0]?.replace(/\.md$/, '') ?? ''
}

function missionOf(fake: FakeHost): MissionJson {
    const id = missionIdOf(fake)
    return JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', id, 'mission.json'), 'utf8')) as MissionJson
}

/** A delegated child's agent (its approval must never be explicit). */
function subagentOf(fake: FakeHost): { id: string; session: { id: string; header: Record<string, unknown> } } {
    return {
        id: 'child',
        session: {
            id: 'child-session',
            header: { id: 'child-session', cwd: fake.cwd, origin: 'subagent', parentSession: 'session-1', delegationDepth: 1 },
        },
    }
}

test('spec_approve writes the mandate from the agreed shape and the trust-root fingerprint', async () => {
    const fake = host()
    await fake.runTool('spec_create', DRAFT)
    const run = await fake.runTool('spec_approve', { note: 'ready' })
    assert.equal(run.isError, false, runText(run))
    const mission = missionOf(fake)
    const mandate = mission.mandate
    assert.ok(mandate !== undefined, 'approval must record a mandate')
    assert.equal(mandate?.version, 1)
    assert.equal(mandate?.strength, 'explicit', 'no allowlist + local session = explicit')
    assert.equal(mandate?.basis, 'spec-approved')
    assert.deepEqual(mandate?.scope, { phases: [], paths: ['src/server.ts'] }, 'scope comes from the specification')
    assert.equal(mandate?.policyVersion, policyVersion(fake.cwd))
    assert.match(mandate?.policyVersion ?? '', /^[0-9a-f]{64}$/)
    assert.equal(mandate?.approvedBy, 'approval')
    assert.equal(typeof mandate?.at, 'number')

    // The approval-time fingerprint is persisted so a later revalidation can
    // name the changed files (the mandate itself carries only the version).
    const snapshot = JSON.parse(
        fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionIdOf(fake), 'policy-fingerprint.json'), 'utf8'),
    ) as { version: string; files: { path: string }[] }
    assert.equal(snapshot.version, mandate?.policyVersion)
    assert.ok(snapshot.files.some((file) => file.path === '.dsh/spec-gate.json') || snapshot.files.length === 0)
    assert.match(runText(run), /mandate：explicit/)
})

test('an allowlisted approver is explicit across channels; an approver outside the list is inferred and fails closed', async () => {
    // (a) allowlisted + IM provenance: the list is the authority.
    const allowlisted = host({
        allowlist: ['alice'],
        approve: () => ({ decision: 'allowed-once', by: 'alice', source: 'im', messageId: 'om_1' }),
    })
    await allowlisted.runTool('spec_create', DRAFT)
    const ok = await allowlisted.runTool('spec_approve', {})
    assert.equal(ok.isError, false, runText(ok))
    assert.equal(missionOf(allowlisted).mandate?.strength, 'explicit')
    assert.equal(
        allowlisted.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: allowlisted.agent }),
        undefined,
    )

    // (b) same allowlist, an approver it does not name: recorded, never explicit.
    const outsider = host({ allowlist: ['alice'], approve: () => ({ decision: 'allowed-once', by: 'mallory', source: 'im' }) })
    await outsider.runTool('spec_create', DRAFT)
    const inferred = await outsider.runTool('spec_approve', {})
    assert.equal(inferred.isError, false, runText(inferred))
    assert.equal(missionOf(outsider).mandate?.strength, 'inferred')
    assert.match(runText(inferred), /inferred/)
    const denied = outsider.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: outsider.agent })
    assert.match(denied ?? '', /inferred/)
    assert.doesNotMatch(denied ?? '', /尚未审批/, 'the refusal names inferred, not "no spec"')
    assert.match(denied ?? '', /spec_create/)
})

test('a subagent approval is never explicit, even when its name is allowlisted', async () => {
    const fake = host({ allowlist: ['approval'] })
    await fake.runTool('spec_create', DRAFT)
    const run = await fake.runTool('spec_approve', {}, { agent: subagentOf(fake) })
    assert.equal(run.isError, false, runText(run))
    const mission = missionOf(fake)
    assert.equal(mission.status, 'spec-approved')
    assert.equal(mission.mandate?.strength, 'inferred')
    assert.match(
        fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }) ?? '',
        /inferred/,
    )
})

test('no allowlist: an IM sender is inferred, the local operator session is explicit', async () => {
    const im = host({ approve: () => ({ decision: 'allowed-once', by: 'ou_123', source: 'im' }) })
    await im.runTool('spec_create', DRAFT)
    await im.runTool('spec_approve', {})
    assert.equal(missionOf(im).mandate?.strength, 'inferred')

    const local = host({ approve: () => ({ decision: 'allowed-once', by: 'approval', source: 'tui' }) })
    await local.runTool('spec_create', DRAFT)
    await local.runTool('spec_approve', {})
    assert.equal(missionOf(local).mandate?.strength, 'explicit')
})

test('a second approval does not rewrite the first mandate (immutability)', async () => {
    const fake = host()
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const first = missionOf(fake).mandate
    assert.ok(first !== undefined)

    // The policy changes between the two approvals: the FIRST record must stay
    // exactly as approved (a refresh here would silently re-authorise new rules).
    fs.writeFileSync(path.join(fake.cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    assert.notEqual(policyVersion(fake.cwd), first?.policyVersion)

    const again = await fake.runTool('spec_approve', {})
    assert.equal(again.isError, false, runText(again))
    assert.deepEqual(missionOf(fake).mandate, first)
    assert.match(runText(again), /沿用已记录的 mandate/)
})

test('a wider scope needs a new mission: the attempt is refused before a human is asked', async () => {
    const fake = host()
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const approvalsBefore = fake.approvalRequests.length

    // Rewrite the spec with wider boundaries (same mission, new revision).
    const revised = await fake.runTool('spec_create', { ...DRAFT, fileBoundaries: ['src/server.ts', 'docs/**'] })
    assert.equal(revised.isError, false, runText(revised))
    const refused = await fake.runTool('spec_approve', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /新 mission/)
    assert.match(String(refused.content), /docs\/\*\*/)
    assert.equal(fake.approvalRequests.length, approvalsBefore, 'the refusal happens on the record, not after a review round')
    assert.equal(missionOf(fake).mandate?.scope.paths.length, 1, 'the original scope is untouched')
})

test('a legacy mission (approved before mandates) is read as legacy and still authorises writes', async () => {
    const fake = host()
    await fake.runTool('spec_create', DRAFT)
    const id = missionIdOf(fake)
    const file = path.join(fake.cwd, '.dsh', 'missions', id, 'mission.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as MissionJson
    // Exactly what a pre-mandate spec-gate left behind: approval fields only.
    fs.writeFileSync(
        file,
        JSON.stringify({
            ...record,
            status: 'spec-approved',
            spec: { ...record.spec, approvedAt: Date.now(), approvedBy: 'approval' },
        }),
    )
    const legacy = mandateState(JSON.parse(fs.readFileSync(file, 'utf8')) as never)
    assert.equal(legacy.kind, 'legacy')
    assert.equal(
        fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }),
        undefined,
        'legacy is treated like explicit for compatibility',
    )
    const status = await fake.runTool('spec_status', {})
    assert.match(runText(status), /legacy/)
})

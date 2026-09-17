/**
 * End-to-end contract test: all seven plugins mounted in ONE host, walking a
 * mission from "spec clarification" to a signed receipt.
 *
 * This is the test that fails when the cross-plugin contract drifts — tool
 * names, mission fields, artifact paths, event wiring or verdict vocabulary —
 * even though every package's own unit tests still pass.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'

import { apply as applyAudit } from '../packages/dsh-audit-trail/dist/index.js'
import { apply as applyEvidence } from '../packages/dsh-evidence-gate/dist/index.js'
import { apply as applyOrchestrator } from '../packages/dsh-orchestrator/dist/index.js'
import { apply as applyQuality } from '../packages/dsh-quality-gate/dist/index.js'
import { apply as applyRoleGuard } from '../packages/dsh-role-guard/dist/index.js'
import { apply as applySpecGate } from '../packages/dsh-spec-gate/dist/index.js'
import { apply as applyTestDesign } from '../packages/dsh-test-design-gate/dist/index.js'

const TEST_DESIGN = [
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动 | 请求 GET /health | 返回 200 且 body 为 ok | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口被占用 | 启动服务 | 退出码非 0 并打印占用端口 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 配置为空 | 启动服务 | 使用默认端口并成功探活 | AC-001 |',
    '',
].join('\n')

interface Suite {
    fake: FakeHost
    steers: { content: { text: string }[] }[]
    stores: MissionStoreRegistry
}

/** Mount every plugin of the suite into one fake host. */
function suite(): Suite {
    const cwd = tempWorkspace('suite-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once', withSubagents: true, withSubprocess: true })
    const steers: { content: { text: string }[] }[] = []
    ;(fake.agent as unknown as { steer: (message: { content: { text: string }[] }) => void }).steer = (message) => steers.push(message)
    for (const toolName of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
    const log = (name: string): string => path.join(cwd, `${name}.log`)
    applySpecGate(fake.ctx as never, { logFile: log('spec-gate'), approval: 'seam' })
    applyTestDesign(fake.ctx as never, { logFile: log('test-design-gate') })
    applyQuality(fake.ctx as never, {
        logFile: log('quality-gate'),
        commands: [{ id: 'test', name: '单元测试', command: 'node -e "process.exit(0)"', required: true, phase: 'gate' }],
    })
    applyEvidence(fake.ctx as never, { logFile: log('evidence-gate') })
    applyRoleGuard(fake.ctx as never, { logFile: log('role-guard') })
    applyAudit(fake.ctx as never, { logFile: log('audit-trail') })
    applyOrchestrator(fake.ctx as never, { logFile: log('orchestrator') })
    return { fake, steers, stores: new MissionStoreRegistry().for(cwd) }
}

async function emitToolCall(fake: FakeHost, toolName: string, args: Record<string, unknown>): Promise<void> {
    const exec = { name: toolName, agent: fake.agent, callId: `call-${toolName}-${Date.now()}`, arguments: args }
    await fake.waterfall('tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    fake.emit('tools/result', [exec, { isError: false, content: [{ type: 'text', text: 'ok' }] }])
}

test('the full pipeline runs from spec creation to a signed receipt', async () => {
    const { fake, stores } = suite()

    // ① the orchestrator owns stage movement
    const stages = runText(await fake.runTool('orchestrate', { action: 'stages' }))
    assert.match(stages, /spec-clarify/)
    const started = runText(await fake.runTool('orchestrate', { action: 'start' }))
    assert.match(started, /spec-clarify/)

    // ② a write is refused before any specification exists (spec-gate guard)
    const early = fake.guardReason({ name: 'write', arguments: { file_path: 'src/health.ts' }, agent: fake.agent })
    assert.match(early ?? '', /规格/)

    // ③ spec_create writes the artifact and binds the session
    const created = await fake.runTool('spec_create', {
        title: 'Add health endpoint',
        background: '运维需要探活接口',
        requirements: ['暴露 GET /health'],
        acceptanceCriteria: ['GET /health 返回 200', '端口占用时启动失败'],
        fileBoundaries: ['src/**'],
        negativeConstraints: ['不得修改 dsh 核心代码'],
        testDesign: TEST_DESIGN,
    })
    assert.equal(created.isError, false, runText(created))
    const mission = stores.active('session-1')
    assert.ok(mission !== undefined, 'spec_create must bind the mission to the session')
    assert.ok(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs', `${mission.id}.md`)))

    // ④ writes stay refused until the specification is approved
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/health.ts' }, agent: fake.agent }) ?? '', /尚未审批/)

    // ⑤ the test design must pass before approval is even possible
    const review = runText(await fake.runTool('test_design_review', {}))
    assert.match(review, /✅/)
    assert.equal(stores.read(mission.id)?.testDesign?.passed, true)

    // ⑥ human approval through the seam unlocks writes
    const approved = await fake.runTool('spec_approve', { note: 'ready' })
    assert.equal(approved.isError, false, runText(approved))
    assert.equal(stores.read(mission.id)?.status, 'spec-approved')
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'src/health.ts' }, agent: fake.agent }), undefined)

    // ⑦ the audited write path: turn context → snapshot → execute → result
    const target = path.join(fake.cwd, 'src', 'health.ts')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'export const ok = true\n')
    await fake.waterfall(
        'agent/pre-step',
        { agent: fake.agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
        () => ({ kind: 'enter', messages: [] }),
    )
    await emitToolCall(fake, 'write', { file_path: 'src/health.ts', content: 'export const ok = "v2"\n' })
    fs.writeFileSync(target, 'export const ok = "v2"\n')
    const auditFile = path.join(fake.cwd, '.dsh', 'audit', 'session-1.jsonl')
    assert.ok(fs.existsSync(auditFile), 'audit-trail must record the call')
    const auditRows = fs
        .readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { phase: string; tool: string; snapshot?: { path: string } })
    assert.deepEqual(
        auditRows.map((row) => row.phase),
        ['pre', 'result'],
    )
    assert.match(auditRows[0]?.snapshot?.path ?? '', /src\/health\.ts$/)

    // ⑧ the quality gate runs the host-configured command and records PASS
    const gate = runText(await fake.runTool('quality_gate_run', { reason: 'before delivery' }))
    assert.match(gate, /质量门禁：PASS/)
    assert.equal(stores.lastGate(mission.id, { source: 'dsh-quality-gate' })?.state, 'PASS')

    // ⑨ evidence binds the agent's own verification output to a git fingerprint
    const recorded = await fake.runTool('evidence_record', {
        kind: 'test',
        summary: 'pnpm test: 12 passed',
        command: 'pnpm test',
        exitCode: 0,
        output: 'ok 12 tests',
    })
    assert.equal(recorded.isError, false, runText(recorded))
    assert.ok(stores.readEvidence(mission.id).some((entry) => entry.kind === 'test'))

    // ⑩ delivery is refused while a required evidence kind is missing and the
    //    gate no longer covers the newest verification output (fail closed).
    const incomplete = runText(await fake.runTool('mission_complete', {}))
    assert.match(incomplete, /❌/)
    assert.match(incomplete, /command/)
    assert.match(incomplete, /早于最新证据/)
    assert.equal(stores.read(mission.id)?.status, 'spec-approved')

    await fake.runTool('evidence_record', {
        kind: 'command',
        summary: 'pnpm run typecheck: 0 errors',
        command: 'pnpm run typecheck',
        exitCode: 0,
        output: 'no errors',
    })
    const stale = runText(await fake.runTool('mission_complete', {}))
    assert.match(stale, /❌/)
    assert.match(stale, /早于最新证据/)
    assert.match(stale, /quality_gate_run/)

    // ⑪ re-running the gate makes its verdict cover the newest evidence, and
    //    only then is an immutable receipt issued.
    const regate = runText(await fake.runTool('quality_gate_run', { reason: 'cover latest evidence' }))
    assert.match(regate, /质量门禁：PASS/)
    const delivered = runText(await fake.runTool('mission_complete', { summary: '交付' }))
    assert.match(delivered, /✅/)
    const after = stores.read(mission.id)
    assert.equal(after?.status, 'delivered')
    const receipts = stores.readReceipts(mission.id)
    assert.equal(receipts.length, 1)
    assert.match(receipts[0]?.id ?? '', /^RCP-/)
    assert.equal(receipts[0]?.gateId, stores.lastGate(mission.id, { source: 'dsh-quality-gate' })?.id)

    // ⑫ the receipt is immutable: completing again cannot rewrite it
    const receiptPath = path.join(fake.cwd, '.dsh', 'missions', mission.id, 'receipts', `${receipts[0]?.id}.json`)
    const before = fs.readFileSync(receiptPath, 'utf8')
    await fake.runTool('mission_complete', { summary: 'again' })
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), before)
    assert.equal(stores.readReceipts(mission.id).length, 1)

    // ⑬ the audit trail can be reported and the workspace rolled back
    const report = runText(await fake.runTool('audit_report', {}))
    assert.match(report, /write/)
    const dry = runText(await fake.runTool('audit_rewind', { turn: 1, dryRun: true }))
    assert.match(dry, /src\/health\.ts/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'export const ok = "v2"\n')

    const applied = runText(await fake.runTool('audit_rewind', { turn: 1, dryRun: false, confirm: true }))
    assert.match(applied, /src\/health\.ts/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'export const ok = true\n')
})

test('stage movement respects the capability probes and the mission state', async () => {
    const { fake } = suite()
    // `stages` must show every plugin of the suite as mounted.
    const stages = runText(await fake.runTool('orchestrate', { action: 'stages' }))
    for (const plugin of [
        'dsh-role-guard',
        'dsh-spec-gate',
        'dsh-test-design-gate',
        'dsh-quality-gate',
        'dsh-evidence-gate',
        'dsh-audit-trail',
    ]) {
        assert.match(stages, new RegExp(plugin))
    }
    const started = runText(await fake.runTool('orchestrate', { action: 'start' }))
    assert.match(started, /spec-create|spec_create|澄清需求/)
    const status = runText(await fake.runTool('orchestrate', { action: 'status' }))
    assert.match(status, /spec-clarify/)
})

test('a turn that ends on a red gate is steered back instead of closing', async () => {
    const cwd = tempWorkspace('suite-red-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once', withSubprocess: true })
    const steers: unknown[] = []
    ;(fake.agent as unknown as { steer: (message: unknown) => void }).steer = (message) => steers.push(message)
    for (const toolName of ['read', 'write', 'edit']) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
    applySpecGate(fake.ctx as never, { logFile: path.join(cwd, 'spec.log'), approval: 'auto' })
    applyQuality(fake.ctx as never, {
        logFile: path.join(cwd, 'quality.log'),
        commands: [{ id: 'test', name: '单元测试', command: 'node -e "process.exit(1)"', required: true }],
    })
    await fake.runTool('spec_create', {
        title: 'red gate',
        requirements: ['r'],
        acceptanceCriteria: ['a'],
        fileBoundaries: ['src/**'],
        negativeConstraints: ['n'],
    })
    await fake.runTool('spec_approve', {})

    const exec = { name: 'write', agent: fake.agent, callId: 'c1', arguments: { file_path: 'src/a.ts' } }
    await fake.waterfall('tools/post-execute', [exec, { isError: false, content: [] }], () => ({ kind: 'accept' }))
    await fake.waterfall('agent/turn-stopping', { agent: fake.agent, turn: 1, signal: new AbortController().signal }, () => undefined)
    assert.equal(steers.length, 1)
    const text = JSON.stringify(steers[0])
    assert.match(text, /质量门禁/)
    assert.match(text, /BLOCK|未通过/)
})

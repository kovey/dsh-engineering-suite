/**
 * dsh-orchestrator tests: the assembly surface, the pipeline contract
 * (docs.md §5), capability probing, the deterministic stage gates, rollback
 * with the iteration circuit breaker, resume/rerun (断点恢复 / 阶段重跑), and
 * the opt-in automatic transition with its role binding (docs.md §4.3).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type MissionStore } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'

/** One steered message, as the harness would receive it from `agent.steer`. */
interface Steered {
    content: { text: string }[]
    source: { kind: string; plugin?: string; summary?: string }
}

/** The six stages of docs.md §5, in order. */
const DEFAULT_IDS = ['spec-clarify', 'test-design-review', 'spec-approve', 'implement', 'quality-verify', 'delivery']

/** The tool each plugin registers, per docs/PLUGIN-CONVENTIONS.md §7. */
const PLUGIN_TOOLS = [
    'spec_create',
    'test_design_review',
    'team_delegate',
    'quality_gate_run',
    'mission_complete',
    'audit_report',
]

/** Every host assembled by this module (see {@link disposeHosts}). */
const hosts: FakeHost[] = []

/** Tear every assembled host down (unregisters tools, sections and effects). */
function disposeHosts(): void {
    for (const fake of hosts.splice(0)) fake.dispose()
}

function stubTools(fake: FakeHost): void {
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
}

/**
 * Create a host, assemble the plugin and optionally stub the sibling plugins.
 *
 * `hosts` keeps every host this module assembled so a test that needs an
 * isolated registry can call {@link disposeHosts} — node:test shares one module
 * instance, and a leaked tool registration would make a later test see a plugin
 * that is supposed to be "not mounted".
 */
function host(options: { cwd?: string; withPlugins?: boolean; config?: Record<string, unknown> } = {}): FakeHost & { steers: Steered[] } {
    const cwd = options.cwd ?? tempWorkspace('orchestrator-')
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    // The fake agent has no steering channel; collect what the plugin tells the
    // model (the automatic transition must be visible to it).
    const steers: Steered[] = []
    const agent = fake.agent as unknown as { steer: (message: Steered) => void }
    agent.steer = (message: Steered) => steers.push(message)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log'), ...(options.config ?? {}) })
    // The stub registry rejects duplicate names, so siblings are registered
    // after this plugin's own tool — exactly how a real composition behaves.
    if (options.withPlugins !== false) stubTools(fake)
    return Object.assign(fake, { steers })
}

/** Drive the `agent/turn-stopping` boundary the way the harness does. */
function turnStop(fake: FakeHost, options: { turn?: number; signal?: AbortSignal } = {}): Promise<void> {
    return fake.waterfall(
        'agent/turn-stopping',
        { agent: fake.agent, turn: options.turn ?? 1, signal: options.signal ?? new AbortController().signal },
        () => undefined,
    )
}

/** The texts of every message steered to the model. */
function steerTexts(fake: FakeHost & { steers: Steered[] }): string[] {
    return fake.steers.map((message) => message.content.map((block) => block.text).join('\n'))
}

/**
 * A three-stage pipeline for the automatic-transition tests:
 * `plan` (ungated) → `impl` (gated on the approved spec, auto-advance, role) → `review`.
 */
function autoStages(options: { autoAdvance?: boolean; gate?: unknown; successorPlugins?: string[] } = {}): unknown[] {
    return [
        { id: 'plan', prompt: '写计划', requiredPlugins: [] },
        {
            id: 'impl',
            prompt: '实现',
            requiredPlugins: ['dsh-role-guard'],
            gate: options.gate ?? 'spec-approved',
            role: 'developer',
            ...(options.autoAdvance === false ? {} : { autoAdvance: true }),
            next: 'review',
        },
        { id: 'review', prompt: '审查', requiredPlugins: options.successorPlugins ?? ['dsh-evidence-gate'], gate: 'none' },
    ]
}

/** Put a mission directly on a stage, the way an interrupted run would leave it. */
function parkMission(
    store: MissionStore,
    cwd: string,
    id: string,
    stageId: string,
    options: { approved?: boolean; state?: 'entered' | 'passed' } = {},
): void {
    store.create({ id, title: id, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', id, stageId)
    store.update(id, () => ({ stage: stageId, status: 'implementing' }))
    store.writeStageResult(id, { stageId, attempt: 1, state: options.state ?? 'entered', enteredAt: Date.now() })
    if (options.approved !== false) approveMission(store, id)
}

function storeFor(cwd: string): MissionStore {
    return new MissionStoreRegistry({}).for(cwd)
}

/** Fake the durable facts three of the gates read (spec approval, design, gate). */
function approveMission(store: MissionStore, id: string): void {
    store.update(id, (record) => ({
        status: 'spec-approved',
        spec: {
            title: 'stub',
            background: '',
            requirements: [],
            acceptanceCriteria: [],
            fileBoundaries: [],
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
            ...(record.spec ?? {}),
        },
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
}

/** Record a PASS quality gate the way dsh-quality-gate does. */
function recordPassGate(store: MissionStore, id: string): void {
    store.recordGate(id, { source: 'dsh-quality-gate', state: 'PASS', reason: 'stub gate', results: [] })
}

/** Issue a receipt the way dsh-evidence-gate does. */
function issueReceipt(store: MissionStore, id: string): void {
    store.issueReceipt(id, { issuedBy: 'dsh-evidence-gate', gateId: 'GATE-1', evidenceIds: [] })
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

function stageFile(cwd: string, missionId: string, stageId: string): { state: string; attempt: number; gateState?: string; next?: string; role?: string } {
    const file = path.join(cwd, '.dsh', 'missions', missionId, 'stages', `${stageId}.json`)
    assert.equal(fs.existsSync(file), true, `missing stage artifact ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { state: string; attempt: number; gateState?: string; role?: string }
}

/** The `status` table row of one stage (empty when the stage is absent). */
function statusRow(text: string, stageId: string): string {
    return text.split('\n').find((line) => line.startsWith(`${stageId} |`)) ?? ''
}

function missionIdOf(cwd: string): string {
    const dirs = fs.readdirSync(path.join(cwd, '.dsh', 'missions'))
    assert.equal(dirs.length, 1, `expected one mission, got ${dirs.join(', ')}`)
    return dirs[0] ?? ''
}

// --- 1. assembly ----------------------------------------------------------

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-orchestrator')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the single tool and the prompt section, and dispose() leaves nothing behind', () => {
    const fake = host()
    // Exactly one tool of our own: the stubs belong to the sibling plugins.
    assert.deepEqual(
        [...fake.tools.keys()].filter((tool) => tool === 'orchestrate'),
        ['orchestrate'],
    )
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:orchestrator'],
    )
    fake.dispose()
    // Only `orchestrate` goes away: the sibling stubs are other plugins'.
    assert.equal(fake.tools.has('orchestrate'), false)
    assert.equal(fake.tools.has('audit_report'), true)
    assert.equal(fake.sections.length, 0)
    assert.equal(fake.effects.length, 0)
})

test('the prompt section describes the pipeline and the rollback/breaker rules', () => {
    const fake = host()
    const text = fake.sectionText('eng:orchestrator')
    for (const id of DEFAULT_IDS) assert.ok(text.includes(id), `section is missing stage ${id}`)
    assert.match(text, /orchestrate/)
    assert.match(text, /插件未挂载时阶段不能进入/)
    assert.match(text, /熔断/)
    assert.match(text, /门禁失败是回退，不是跳过/)
})

test('the prompt section is dropped when disabled', () => {
    const fake = host({ config: { prompt: { enabled: false } } })
    assert.equal(fake.sections.length, 0)
    assert.equal(fake.sectionText('eng:orchestrator'), '')
})

// --- 2. the default pipeline matches docs.md §5 ---------------------------

test('the default pipeline matches docs.md §5 (ids, order, prompts, plugins, gates)', async () => {
    const fake = host({ withPlugins: false })
    const text = await orchestrate(fake, { action: 'stages' })
    const ids = [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
    assert.deepEqual(ids, DEFAULT_IDS)

    const expected: [string, string[], string][] = [
        ['spec-clarify', ['dsh-spec-gate'], '澄清需求，产出规格草稿'],
        ['test-design-review', ['dsh-test-design-gate'], '评审测试设计，确保覆盖度与可执行性'],
        ['spec-approve', ['dsh-spec-gate'], '审批规格（人工审批门禁）'],
        ['implement', ['dsh-role-guard'], '按规格实现代码'],
        ['quality-verify', ['dsh-quality-gate', 'dsh-evidence-gate'], '执行质量门禁并登记证据'],
        ['delivery', ['dsh-evidence-gate', 'dsh-audit-trail'], '交付审计与回执'],
    ]
    for (const [id, plugins, prompt] of expected) {
        assert.ok(text.includes(`${id} — ${prompt}`), `stage ${id} prompt drifted: ${text}`)
        const block = text.slice(text.indexOf(`${id} —`), text.indexOf(`${id} —`) + 600)
        for (const plugin of plugins) assert.ok(block.includes(plugin), `stage ${id} is missing required plugin ${plugin}`)
    }
    // Gates: entry for spec-approve/test-design-review, exit for quality-verify/delivery.
    assert.match(text, /spec-approve[\s\S]{0,300}规格已审批/)
    assert.match(text, /test-design-review[\s\S]{0,300}测试设计已登记/)
    assert.match(text, /quality-verify[\s\S]{0,400}离开时要求：质量门禁 PASS/)
    assert.match(text, /delivery[\s\S]{0,400}离开时要求：已签发交付回执/)
    // The default rollback chain (§5 "门禁不通过时流程回退到上一合适阶段").
    assert.match(text, /quality-verify[\s\S]{0,400}回退：implement/)
    assert.match(text, /delivery[\s\S]{0,400}回退：quality-verify/)
    assert.match(text, /上限：3 次/)
})

// --- 3. capability probing ------------------------------------------------

test('stages reports every stage with the mounted/missing flag for stubbed probes', async () => {
    const fake = host({ withPlugins: false })
    const empty = await orchestrate(fake, { action: 'stages' })
    assert.match(empty, /dsh-role-guard：未挂载（探测 tool:team_delegate）/)
    assert.match(empty, /dsh-audit-trail：未挂载（探测 tool:audit_report）/)

    stubTools(fake)
    const full = await orchestrate(fake, { action: 'stages' })
    assert.equal(/未挂载/.test(full), false, `every plugin should be mounted: ${full}`)
    for (const tool of PLUGIN_TOOLS) assert.ok(full.includes(`tool:${tool}`), `probe ${tool} is missing`)
})

test('a configured probe override is honoured, and services can be probed instead of tools', async () => {
    const fake = host({ withPlugins: false, config: { probes: { 'dsh-audit-trail': { service: 'auditTrail' } } } })
    const before = await orchestrate(fake, { action: 'stages' })
    assert.match(before, /dsh-audit-trail：未挂载（探测 service:auditTrail）/)
    ;(fake.ctx as { provide: (name: string, value: unknown) => void }).provide('auditTrail', {})
    const after = await orchestrate(fake, { action: 'stages' })
    assert.match(after, /dsh-audit-trail：已挂载（service:auditTrail）/)
})

test('an unusable probe override is ignored instead of disabling the built-in probe', async () => {
    const fake = host({ withPlugins: false, config: { probes: { 'dsh-spec-gate': {} } } })
    const text = await orchestrate(fake, { action: 'stages' })
    // The half-written block must not turn a capability check into "unmounted
    // for an unknown reason": the built-in probe stays in effect.
    assert.match(text, /dsh-spec-gate：未挂载（探测 tool:spec_create）/)
    assert.equal(/未配置探测器/.test(text), false)
})

test('assembly logs the effective probe map so a misconfiguration is visible in the log file', () => {
    const fake = host({ withPlugins: false, config: { probes: { 'dsh-audit-trail': { service: 'auditTrail' } } } })
    const log = fs.readFileSync(path.join(fake.cwd, 'orchestrator.log'), 'utf8')
    assert.match(log, /probes: dsh-role-guard\(team_delegate\), dsh-spec-gate\(spec_create\)/)
    assert.match(log, /dsh-audit-trail\(auditTrail\)/)
    assert.match(log, /applied \(tool: orchestrate; stages: spec-clarify → test-design-review/)
})

// --- 4. start -------------------------------------------------------------

test('start creates and binds the mission and returns the first stage prompt', async () => {
    const fake = host()
    const text = await orchestrate(fake, { action: 'start', summary: 'add health endpoint' })
    assert.match(text, /已开始/)
    assert.match(text, /阶段：spec-clarify（第 1 次进入/)
    assert.match(text, /任务：澄清需求，产出规格草稿/)
    assert.match(text, /dsh-spec-gate：已挂载/)
    assert.match(text, /下一步：/)

    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    const mission = store.read(id)
    assert.equal(mission?.stage, 'spec-clarify')
    assert.equal(mission?.status, 'draft')
    assert.equal(store.activeMissionId('session-1'), id)
    const first = stageFile(fake.cwd, id, 'spec-clarify')
    assert.equal(first.state, 'entered')
    assert.equal(first.attempt, 1)
    assert.equal(first.summary, 'add health endpoint')
})

test('start on a started mission does not restart or erase the record', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'task' })
    const id = missionIdOf(fake.cwd)
    await orchestrate(fake, { action: 'advance' })
    const again = await orchestrate(fake, { action: 'start', summary: 'task' })
    assert.match(again, /已经开始过：阶段 spec-clarify 的最近结果是 passed/)
    assert.match(again, /start 不会清空已落盘的阶段结果/)
    assert.match(again, /action: "resume"/)
    // …and the record is untouched: one entry, still the first attempt.
    const specClarify = stageFile(fake.cwd, id, 'spec-clarify')
    assert.equal(specClarify.state, 'passed')
    assert.equal(specClarify.attempt, 1)
})

// --- 5. advance refuses a missing plugin ----------------------------------

test('advance refuses a stage whose required plugin is missing, naming it and the fix', async () => {
    const cwd = tempWorkspace('orchestrator-missing-')
    const fake = host({ cwd, withPlugins: false })
    fake.tools.set('spec_create', { name: 'spec_create', description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    const started = await orchestrate(fake, { action: 'start', summary: 'task' })
    assert.match(started, /spec-clarify/)

    // dsh-test-design-gate is not mounted → the next stage cannot be entered.
    const blocked = await orchestrate(fake, { action: 'advance' })
    assert.match(blocked, /阶段 test-design-review 不能进入|阶段 spec-clarify 无法推进/)
    assert.match(blocked, /dsh-test-design-gate/)
    assert.match(blocked, /tool:test_design_review/)
    assert.match(blocked, /dsh\.profile\.bundles/)
    assert.match(blocked, /下一步：/)

    const id = missionIdOf(cwd)
    const specClarify = stageFile(cwd, id, 'spec-clarify')
    assert.equal(specClarify.state, 'entered')
    assert.equal(specClarify.attempt, 1)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', id, 'stages', 'test-design-review.json')), false)

    // The refusal must not have settled the stage, and retrying must not burn
    // attempt counters: the plugin is the only thing that changed.
    const retried = await orchestrate(fake, { action: 'advance' })
    assert.match(retried, /暂不记为 passed/)
    assert.equal(stageFile(cwd, id, 'spec-clarify').attempt, 1)

    // Mount it and the very same advance succeeds.
    fake.tools.set('test_design_review', { name: 'test_design_review', description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    const advanced = await orchestrate(fake, { action: 'advance' })
    assert.match(advanced, /→ 下一阶段 test-design-review/)
    assert.equal(stageFile(cwd, id, 'spec-clarify').state, 'passed')
    assert.equal(stageFile(cwd, id, 'spec-clarify').attempt, 1)
    assert.equal(stageFile(cwd, id, 'test-design-review').state, 'entered')
})

test('advance refuses an entry gate that is not satisfied, with the concrete missing fact', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'task' })
    await orchestrate(fake, { action: 'advance' }) // spec-clarify → test-design-review (gate fails)
    const refused = await orchestrate(fake, { action: 'advance' })
    assert.match(refused, /阶段 test-design-review 不能进入：门禁未通过/)
    assert.match(refused, /mission\.testDesign 缺失/)
    assert.match(refused, /test_design_review/)
    const id = missionIdOf(fake.cwd)
    assert.equal(stageFile(fake.cwd, id, 'test-design-review').state, 'entered')
})

// --- 6. the happy path through all six stages -----------------------------

test('the happy path advances through all six stages and persists every stage result', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'happy path' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)

    for (let index = 0; index < DEFAULT_IDS.length; index += 1) {
        const current = DEFAULT_IDS[index] ?? ''
        // The stage's own exit gate: a fresh PASS quality gate, evidence, receipt.
        if (current === 'quality-verify') {
            await new Promise((resolve) => setTimeout(resolve, 5))
            recordPassGate(store, id)
        }
        if (current === 'delivery') {
            // A receipt must be issued during THIS pass: same-millisecond
            // timestamps count as stale, exactly like the quality gate.
            await new Promise((resolve) => setTimeout(resolve, 5))
            issueReceipt(store, id)
        }
        const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS', summary: `done ${current}` })
        const next = DEFAULT_IDS[index + 1]
        if (next === undefined) {
            assert.match(text, /已是最后一个阶段/)
        } else {
            assert.match(text, new RegExp(`→ 下一阶段 ${next}`))
        }
    }

    for (const stageId of DEFAULT_IDS) {
        const result = stageFile(fake.cwd, id, stageId)
        assert.equal(result.state, 'passed', `${stageId} should be passed`)
        assert.equal(result.attempt, 1, `${stageId} attempt`)
    }
    assert.equal(stageFile(fake.cwd, id, 'spec-clarify').gateState, 'PASS')
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').gateState, 'PASS')
    assert.equal(store.read(id)?.status, 'delivered')
    assert.equal(store.read(id)?.stage, 'delivery')

    const status = await orchestrate(fake, { action: 'status' })
    for (const stageId of DEFAULT_IDS) assert.ok(status.includes(stageId), `status is missing ${stageId}`)
    assert.match(status, /状态：delivered/)
    assert.match(status, /未挂载插件：无/)
    assert.match(status, /下一步：/)
})

// --- 7. the quality-verify exit gate rolls back ---------------------------

test('quality-verify with a missing/BLOCK gate rolls back to implement instead of advancing', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'rollback' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    for (const stageId of ['test-design-review', 'spec-approve', 'implement', 'quality-verify']) {
        await orchestrate(fake, { action: 'advance', verdict: 'PASS' })
        assert.ok(stageId.length > 0)
    }
    assert.equal(store.read(id)?.stage, 'quality-verify')

    const text = await orchestrate(fake, { action: 'advance', verdict: 'BLOCK', summary: '门禁没过' })
    assert.match(text, /阶段 quality-verify 未通过/)
    assert.match(text, /回退目标：implement（onFail）/)
    assert.match(text, /回退：阶段 quality-verify 门禁未通过/)
    assert.match(text, /阶段：implement（第 2 次进入/)

    const failed = stageFile(fake.cwd, id, 'quality-verify')
    assert.equal(failed.state, 'failed')
    assert.equal(failed.attempt, 1)
    assert.equal(failed.gateState, 'BLOCK')
    assert.equal(store.read(id)?.stage, 'implement')
    assert.equal(stageFile(fake.cwd, id, 'implement').attempt, 2)
    assert.equal(store.read(id)?.status, 'implementing')
})

test('a PASS gate recorded before the stage was entered does not let it advance', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'stale gate' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    recordPassGate(store, id) // stale: recorded before quality-verify is entered
    for (let index = 0; index < 4; index += 1) await orchestrate(fake, { action: 'advance' })
    assert.equal(store.read(id)?.stage, 'quality-verify')

    const text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /不晚于本阶段进入时间/)
    assert.equal(store.read(id)?.stage, 'implement', 'the stale gate must roll the run back')
    assert.match(text, /回退目标：implement/)
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').state, 'failed')

    // Back into quality-verify (implement passes), then a PASS gate recorded
    // strictly after that entry: only then may the run leave the stage.
    await orchestrate(fake, { action: 'advance' })
    assert.equal(store.read(id)?.stage, 'quality-verify')
    await new Promise((resolve) => setTimeout(resolve, 5))
    recordPassGate(store, id)
    const advanced = await orchestrate(fake, { action: 'advance' })
    assert.match(advanced, /→ 下一阶段 delivery/)
})

// --- 8. the iteration circuit breaker -------------------------------------

test('the circuit breaker blocks the mission after maxAttempts failures', async () => {
    const fake = host({ config: { defaultMaxAttempts: 2 } })
    await orchestrate(fake, { action: 'start', summary: 'breaker' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    // spec-clarify → test-design-review → spec-approve → implement → quality-verify
    for (let index = 0; index < 4; index += 1) await orchestrate(fake, { action: 'advance' })
    assert.equal(store.read(id)?.stage, 'quality-verify')

    let text = ''
    for (let round = 0; round < 6; round += 1) {
        text = await orchestrate(fake, { action: 'advance' })
        if (store.read(id)?.status === 'blocked') break
    }
    assert.match(text, /熔断（迭代上限）/)
    assert.match(text, /implement/)
    assert.match(text, /maxAttempts=2/)
    assert.match(text, /需要人工介入后才能继续/)
    assert.match(text, /orchestrate\(\{ action: "rerun", stageId: "implement" \}\)/)

    assert.equal(store.read(id)?.status, 'blocked')
    // No further rollback happened: implement stopped at its budget.
    assert.equal(stageFile(fake.cwd, id, 'implement').attempt, 2)
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').state, 'failed')

    // The breaker is idempotent: a repeated advance does not loop or grow. The
    // latch refuses before any further state movement.
    const again = await orchestrate(fake, { action: 'advance' })
    assert.match(again, /熔断状态（blocked）/)
    assert.match(again, /unblock/)
    assert.equal(stageFile(fake.cwd, id, 'implement').attempt, 2)
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').attempt, 2)

    // The latch holds for resume/rerun too, until a human releases it.
    const resumed = await orchestrate(fake, { action: 'resume' })
    assert.match(resumed, /熔断状态（blocked）/)
    const released = await orchestrate(fake, { action: 'unblock', summary: '根因已修复，人工放行' })
    assert.match(released, /熔断已解除/)
    assert.equal(store.read(id)?.status, 'spec-approved')
    assert.ok(store.readEvidence(id).some((row) => row.kind === 'manual' && /解除熔断/.test(row.summary)))
    const after = await orchestrate(fake, { action: 'resume' })
    assert.match(after, /quality-verify/)
})

// --- 9. resume and rerun --------------------------------------------------

test('resume re-enters the persisted mission.stage without resetting attempts', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'resume' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    await orchestrate(fake, { action: 'advance' }) // → test-design-review
    await orchestrate(fake, { action: 'advance' }) // → spec-approve
    assert.equal(store.read(id)?.stage, 'spec-approve')

    const before = stageFile(fake.cwd, id, 'spec-approve')
    const text = await orchestrate(fake, { action: 'resume' })
    assert.match(text, /断点恢复：mission /)
    assert.match(text, /上次停在阶段 spec-approve/)
    assert.match(text, /不会重置尝试计数/)
    assert.match(text, /阶段：spec-approve（第 1 次进入/)
    assert.match(text, /下一步：/)
    const after = stageFile(fake.cwd, id, 'spec-approve')
    assert.equal(after.state, 'entered')
    assert.equal(after.attempt, before.attempt)
    assert.equal(after.enteredAt, before.enteredAt, 'resume keeps the original entry time')
    assert.equal(store.read(id)?.stage, 'spec-approve')
})

test('resume reports the missing plugin instead of entering the stage', async () => {
    const cwd = tempWorkspace('orchestrator-resume-')
    const fake = host({ cwd })
    await orchestrate(fake, { action: 'start', summary: 'resume' })
    const id = missionIdOf(cwd)
    const store = storeFor(cwd)
    approveMission(store, id)
    await orchestrate(fake, { action: 'advance' }) // → test-design-review
    await orchestrate(fake, { action: 'advance' }) // → spec-approve
    // Persist "the mission crashed while sitting on implement".
    store.writeStageResult(id, { stageId: 'implement', attempt: 1, state: 'entered', enteredAt: Date.now() })
    store.update(id, () => ({ stage: 'implement' }))
    fake.tools.delete('team_delegate')

    const text = await orchestrate(fake, { action: 'resume' })
    assert.match(text, /断点恢复/)
    assert.match(text, /阶段 implement 不能进入：所需插件未挂载/)
    assert.match(text, /dsh-role-guard/)
    assert.match(text, /tool:team_delegate/)
    assert.equal(store.read(id)?.stage, 'implement')
})

test('rerun increments the attempt counter and stops at the budget', async () => {
    const fake = host({ config: { defaultMaxAttempts: 2 } })
    await orchestrate(fake, { action: 'start', summary: 'rerun' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)

    const first = await orchestrate(fake, { action: 'rerun', stageId: 'spec-clarify' })
    assert.match(first, /重跑阶段 spec-clarify（第 2 次，上限 2 次）/)
    assert.equal(stageFile(fake.cwd, id, 'spec-clarify').attempt, 2)

    const broken = await orchestrate(fake, { action: 'rerun', stageId: 'spec-clarify' })
    assert.match(broken, /熔断（迭代上限）/)
    assert.match(broken, /上限 maxAttempts=2/)
    assert.equal(store.read(id)?.status, 'blocked')
    assert.equal(stageFile(fake.cwd, id, 'spec-clarify').attempt, 2)
})

test('rerun/advance on an unknown stage id reports the next action instead of throwing', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'unknown' })
    const rerun = await orchestrate(fake, { action: 'rerun', stageId: 'nope' })
    assert.match(rerun, /找不到要重跑的阶段/)
    assert.match(rerun, /下一步：调用 orchestrate\(\{ action: "status" \}\)/)
})

// --- 10. invalid configuration falls back to the default ------------------

test('an invalid user stages config falls back to the default pipeline', async () => {
    const fake = host({
        config: {
            stages: [
                { id: 'a', prompt: '阶段A', requiredPlugins: [] },
                { id: 'a', prompt: '重复 id', requiredPlugins: [], next: 'ghost', maxAttempts: 0 },
            ],
        },
    })
    const text = await orchestrate(fake, { action: 'stages' })
    const ids = [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
    assert.deepEqual(ids, DEFAULT_IDS)

    // …and a valid custom pipeline is used as-is.
    const custom = host({
        config: {
            stages: [
                { id: 'plan', prompt: '写计划', requiredPlugins: [] },
                { id: 'build', prompt: '写代码', requiredPlugins: [], gate: 'none', maxAttempts: 5 },
            ],
        },
    })
    const customText = await orchestrate(custom, { action: 'stages' })
    const customIds = [...customText.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
    assert.deepEqual(customIds, ['plan', 'build'])
    assert.match(customText, /回退：plan/)
    assert.match(customText, /上限：5 次/)
})

test('a broken stages array (not an array / empty / non-object entries) falls back too', async () => {
    for (const stages of ['nope', 42, [], [{ id: '' }], [null]]) {
        const fake = host({ config: { stages } })
        const text = await orchestrate(fake, { action: 'stages' })
        const ids = [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1])
        assert.deepEqual(ids, DEFAULT_IDS, `stages=${JSON.stringify(stages)} should fall back`)
    }
})

// --- 11. mission resolution ----------------------------------------------

test('missionId resolution prefers the explicit id, then the session binding', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'mission one' })
    const one = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    store.create({ id: 'explicit-two', title: 'mission two', cwd: fake.cwd })

    assert.match(await orchestrate(fake, { action: 'status', missionId: 'explicit-two' }), /mission：explicit-two/)
    assert.match(await orchestrate(fake, { action: 'status' }), new RegExp(`mission：${one}`))

    // …and an unknown explicit id is reported instead of silently re-resolving.
    assert.match(await orchestrate(fake, { action: 'status', missionId: 'ghost' }), /当前工作区没有 mission/)
})

test('an unknown explicit missionId on advance is reported without touching the state', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'mission one' })
    const id = missionIdOf(fake.cwd)
    const text = await orchestrate(fake, { action: 'advance', missionId: 'ghost' })
    assert.match(text, /当前工作区没有 mission/)
    assert.match(text, /下一步：/)
    assert.equal(stageFile(fake.cwd, id, 'spec-clarify').state, 'entered')
})

test('the tool schema rejects an out-of-contract call before the handler runs', async () => {
    const fake = host()
    const unknownAction = await fake.runTool('orchestrate', { action: 'nonsense' })
    assert.equal(unknownAction.isError, true)
    assert.match(String(unknownAction.content), /must be one of \["start","status","advance","rerun","resume","stages","retro","unblock"\]/)

    const missingAction = await fake.runTool('orchestrate', {})
    assert.equal(missingAction.isError, true)
    assert.match(String(missingAction.content), /missing required property "action"/)

    const badVerdict = await fake.runTool('orchestrate', { action: 'status', verdict: 'MAYBE' })
    assert.equal(badVerdict.isError, true)
    assert.match(String(badVerdict.content), /verdict/)
})

test('a failing store never breaks the tool (fail closed, not crash)', async () => {
    const fake = host()
    // A corrupt stage artifact reads as "no result" instead of throwing.
    await orchestrate(fake, { action: 'start', summary: 'corrupt' })
    const id = missionIdOf(fake.cwd)
    fs.writeFileSync(path.join(fake.cwd, '.dsh', 'missions', id, 'stages', 'spec-clarify.json'), '{not json')
    const text = await orchestrate(fake, { action: 'status' })
    assert.match(text, /spec-clarify/)
    assert.match(text, /下一步：/)
})

test('a WARN verdict becomes a declarative conditional edge when the host allows it', async () => {
    // docs.md §3.4: 只有非必需命令失败 = WARN，可以带风险交付。The host expresses that
    // policy declaratively; the default stays fail-closed (pass-only).
    disposeHosts()
    const cwd = tempWorkspace('orchestrator-edge-')
    const stages = (verdict?: 'pass-only' | 'pass-or-warn'): unknown[] => [
        { id: 'impl', prompt: '实现', requiredPlugins: ['dsh-role-guard'], next: 'quality' },
        {
            id: 'quality',
            prompt: '验证',
            requiredPlugins: ['dsh-quality-gate'],
            gate: verdict === undefined ? { kind: 'quality-pass' } : { kind: 'quality-pass', verdict },
            onFail: 'impl',
            next: 'delivery',
        },
        { id: 'delivery', prompt: '交付', requiredPlugins: ['dsh-evidence-gate'], gate: { kind: 'receipt' } },
    ]

    // Default (pass-only): WARN rolls back instead of advancing.
    const strict = host({ cwd, config: { stages: stages() } })
    const strictStore = storeFor(cwd)
    await orchestrate(strict, { action: 'start' })
    const strictId = missionIdOf(cwd)
    await orchestrate(strict, { action: 'advance', verdict: 'PASS' })
    assert.equal(missionIdOf(cwd), strictId)
    strictStore.recordGate(strictId, { source: 'dsh-quality-gate', state: 'WARN', reason: 'lint failed', results: [] })
    const strictResult = await orchestrate(strict, { action: 'advance', verdict: 'PASS' })
    assert.match(strictResult, /回退|impl/)
    assert.equal(stageFile(cwd, strictId, 'quality').state, 'failed')

    // Declared edge (pass-or-warn): the same WARN leaves the stage.
    disposeHosts()
    const relaxedCwd = tempWorkspace('orchestrator-edge2-')
    const relaxed = host({ cwd: relaxedCwd, config: { stages: stages('pass-or-warn') } })
    const relaxedStore = storeFor(relaxedCwd)
    await orchestrate(relaxed, { action: 'start' })
    const relaxedId = missionIdOf(relaxedCwd)
    await orchestrate(relaxed, { action: 'advance', verdict: 'PASS' })
    relaxedStore.recordGate(relaxedId, { source: 'dsh-quality-gate', state: 'WARN', reason: 'lint failed', results: [] })
    const advanced = await orchestrate(relaxed, { action: 'advance', verdict: 'PASS' })
    assert.match(advanced, /delivery/)
    const settled = stageFile(relaxedCwd, relaxedId, 'quality')
    assert.equal(settled.state, 'passed')
    assert.equal(settled.gateState, 'WARN')
})

test('the retrospective folds the rework facts and lands in the cross-run ledger', async () => {
    disposeHosts()
    const cwd = tempWorkspace('orchestrator-retro-')
    const fake = host({ cwd })
    const store = storeFor(cwd)
    await orchestrate(fake, { action: 'start' })
    const id = missionIdOf(cwd)

    // A mission that needed rework: gate BLOCK then PASS, one rollback.
    store.recordGate(id, { source: 'dsh-quality-gate', state: 'BLOCK', reason: 'test failed', results: [{ id: 'test', name: 'test', command: 'x', required: true, exitCode: 1, signal: null, durationMs: 1, timedOut: false, output: 'boom', outputDigest: 'd1' }] })
    store.recordGate(id, { source: 'dsh-quality-gate', state: 'PASS', reason: 'ok', results: [] })
    store.appendEvidence(id, { kind: 'test', summary: 'tests', recordedBy: 'tester' })

    const report = await orchestrate(fake, { action: 'retro' })
    assert.match(report, /复盘/)
    assert.match(report, /门禁：PASS 1 \/ WARN 0 \/ BLOCK 1/)
    assert.match(report, /test×1/)
    assert.match(report, /memory_save/)

    const retro = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'missions', id, 'retrospective.json'), 'utf8'))
    assert.equal(retro.gates.block, 1)
    assert.deepEqual(retro.failingCommands, [{ id: 'test', count: 1 }])
    assert.ok(Array.isArray(retro.lessons) && retro.lessons.length > 0)
    assert.match(String(retro.lessons.join('\n')), /门禁阻断/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', id, 'retrospective.md')), true)
    const ledger = fs.readFileSync(path.join(cwd, '.dsh', 'retrospectives.jsonl'), 'utf8').trim().split('\n')
    assert.equal(ledger.length, 1)
    assert.equal(JSON.parse(ledger[0] ?? '{}').missionId, id)

    // Running it again appends another ledger row (append-only, cross-run).
    await orchestrate(fake, { action: 'retro' })
    assert.equal(fs.readFileSync(path.join(cwd, '.dsh', 'retrospectives.jsonl'), 'utf8').trim().split('\n').length, 2)
})

test('advance can only settle the stage the mission is in (regression)', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'skip guard' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)

    // Jump straight to delivery: the old behaviour settled stages that were
    // never entered and skipped their gates.
    const jumped = await orchestrate(fake, { action: 'advance', stageId: 'delivery', verdict: 'PASS' })
    assert.match(jumped, /advance 只能结算当前阶段/)
    assert.match(jumped, /rerun/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'missions', id, 'stages', 'delivery.json')), false)

    // The current stage still advances normally.
    const normal = await orchestrate(fake, { action: 'advance', stageId: 'spec-clarify' })
    assert.match(normal, /test-design-review/)
})

test('a receipt from an earlier round cannot stamp the current one (regression)', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'stale receipt' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    // Deliver once.
    for (let index = 0; index < 4; index += 1) await orchestrate(fake, { action: 'advance' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    recordPassGate(store, id)
    await orchestrate(fake, { action: 'advance' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    issueReceipt(store, id)
    assert.match(await orchestrate(fake, { action: 'advance' }), /已是最后一个阶段/)

    // Roll back into a new round: the old receipt must not satisfy delivery.
    await orchestrate(fake, { action: 'rerun', stageId: 'implement' })
    for (let index = 0; index < 3; index += 1) await orchestrate(fake, { action: 'advance' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    recordPassGate(store, id)
    const enteredDelivery = await orchestrate(fake, { action: 'advance' })
    assert.match(enteredDelivery, /delivery/)
    const stale = await orchestrate(fake, { action: 'advance' })
    assert.match(stale, /这是上一轮的回执/)
    assert.equal(stageFile(fake.cwd, id, 'delivery').state, 'failed')
})

test('the cross-run ledger is fed back when the next mission starts (regression)', async () => {
    disposeHosts()
    const cwd = tempWorkspace('orchestrator-history-')
    const fake = host({ cwd })
    const store = storeFor(cwd)

    // First mission: one BLOCK, one rollback, then a retrospective.
    await orchestrate(fake, { action: 'start', summary: 'first' })
    const first = missionIdOf(cwd)
    store.recordGate(first, { source: 'dsh-quality-gate', state: 'BLOCK', reason: 'test failed', results: [] })
    store.writeStageResult(first, { stageId: 'quality-verify', attempt: 1, state: 'failed', enteredAt: Date.now(), settledAt: Date.now(), gateState: 'BLOCK', next: 'implement' })
    await orchestrate(fake, { action: 'retro' })

    // The retrospective sees the rollback (and would see a breaker row too).
    const retro = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'missions', first, 'retrospective.json'), 'utf8'))
    assert.deepEqual(retro.rollbacks, [{ stage: 'quality-verify', to: 'implement', count: 1 }])

    // A second mission in the same workspace is greeted with the pattern.
    disposeHosts()
    const second = host({ cwd })
    second.stores = undefined as never
    const started = runText(await second.runTool('orchestrate', { action: 'start', summary: 'second' }))
    assert.match(started, /历史返工模式/)
    assert.match(started, /BLOCK 1 次/)
    assert.match(started, /retrospectives\.jsonl/)
})

// --- 12. stage roles (docs.md §4.3) ---------------------------------------

test('a stage role lands in the stage artifact, the prompt text and mission.roles (regression)', async () => {
    const fake = host()
    await orchestrate(fake, { action: 'start', summary: 'role binding' })
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)

    // spec-clarify → test-design-review → spec-approve → implement.
    let text = ''
    for (let index = 0; index < 3; index += 1) text = await orchestrate(fake, { action: 'advance' })
    assert.match(text, /阶段：implement/)
    // The stage text names the tool that actually activates the role.
    assert.match(text, /角色：developer/)
    assert.match(text, /本阶段请通过 team_delegate\(\{ role: "developer", \.\.\. \}\) 派发实现/)
    assert.match(text, /dsh-role-guard 执行/)

    assert.equal(stageFile(fake.cwd, id, 'implement').role, 'developer')
    assert.deepEqual(store.read(id)?.roles, ['developer'])

    // Roles are a set: re-entering the same stage does not duplicate it.
    await orchestrate(fake, { action: 'rerun', stageId: 'implement' })
    assert.deepEqual(store.read(id)?.roles, ['developer'])

    // The artifact stays self-describing after the role's stage settles…
    await orchestrate(fake, { action: 'advance' })
    const settled = stageFile(fake.cwd, id, 'implement')
    assert.equal(settled.state, 'passed')
    assert.equal(settled.role, 'developer')
    // …and a stage with no role invents none.
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').role, undefined)

    // An unparseable role takes the existing "invalid stages config" path.
    const broken = host({ config: { stages: [{ id: 'a', prompt: 'A', requiredPlugins: [], role: 42 }] } })
    const brokenText = await orchestrate(broken, { action: 'stages' })
    assert.deepEqual([...brokenText.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1]), DEFAULT_IDS)
})

test('stages/status show the configured role per stage (regression)', async () => {
    const fake = host()
    const stages = await orchestrate(fake, { action: 'stages' })
    assert.match(stages, /implement[\s\S]{0,700}角色：developer（本阶段请通过 team_delegate/)
    assert.match(stages, /spec-clarify[\s\S]{0,300}角色：无/)
    // The default pipeline keeps today's model-driven transitions.
    assert.match(stages, /自动推进：未启用（默认/)

    const custom = host({
        config: { stages: [{ id: 'build', prompt: '实现', requiredPlugins: [], gate: 'spec-approved', role: 'qa', autoAdvance: true }] },
    })
    const customText = await orchestrate(custom, { action: 'stages' })
    assert.match(customText, /角色：qa（本阶段请通过 team_delegate\(\{ role: "qa", \.\.\. \}\) 派发实现）/)
    assert.match(customText, /自动推进：已启用（autoAdvance: true）/)

    // The system prompt carries the same contract, with the budget that
    // actually applies (a built-in stage declares none of its own).
    assert.match(
        fake.sectionText('eng:orchestrator'),
        /上限 3 次；角色：developer（本阶段请通过 team_delegate\(\{ role: "developer", \.\.\. \}\) 派发实现）/,
    )

    await orchestrate(fake, { action: 'start', summary: 'role view' })
    const status = await orchestrate(fake, { action: 'status' })
    assert.match(status, /门禁裁决 \| 角色 \| 所需插件/)
    assert.equal(statusRow(status, 'implement').split(' | ')[6], 'developer')
    assert.equal(statusRow(status, 'spec-clarify').split(' | ')[6], '-')
    assert.match(status, /已使用角色：无（阶段未声明 role）/)

    // Once a role-bearing stage was entered, the mission records the role.
    const id = missionIdOf(fake.cwd)
    const store = storeFor(fake.cwd)
    approveMission(store, id)
    for (let index = 0; index < 3; index += 1) await orchestrate(fake, { action: 'advance' })
    assert.match(await orchestrate(fake, { action: 'status' }), /已使用角色：developer/)
})

// --- 13. the opt-in automatic transition (docs.md §4.2) -------------------

test('auto-advance settles a gated stage whose gate passes and steers the model (regression)', async () => {
    disposeHosts()
    const cwd = tempWorkspace('orchestrator-auto-')
    const fake = host({ cwd, config: { stages: autoStages() } })
    const store = storeFor(cwd)
    await orchestrate(fake, { action: 'start', summary: 'auto' })
    const id = missionIdOf(cwd)
    approveMission(store, id)
    const entered = await orchestrate(fake, { action: 'advance' }) // → impl
    assert.match(entered, /阶段：impl/)
    assert.match(entered, /自动推进：已启用/)
    assert.equal(store.read(id)?.stage, 'impl')
    assert.equal(fake.steers.length, 0, 'entering a stage is not an auto-advance')

    await turnStop(fake, { turn: 3 })
    // Exactly one transition: the stage settled, the successor is entered.
    assert.equal(store.read(id)?.stage, 'review')
    assert.equal(stageFile(cwd, id, 'impl').state, 'passed')
    assert.equal(stageFile(cwd, id, 'impl').gateState, 'PASS')
    assert.equal(stageFile(cwd, id, 'review').state, 'entered')
    assert.equal(fake.steers.length, 1)
    const notice = steerTexts(fake)[0] ?? ''
    assert.match(notice, /阶段自动推进：impl → review/)
    assert.match(notice, /依据：宿主声明 autoAdvance=true/)
    assert.match(notice, /state: passed/)
    assert.match(notice, /当前阶段：review/)
    assert.equal(fake.steers[0]?.source.plugin, 'dsh-orchestrator')

    // The successor is ungated and opted out: a second stop in the same turn
    // moves nothing and says nothing.
    await turnStop(fake, { turn: 3 })
    assert.equal(store.read(id)?.stage, 'review')
    assert.equal(fake.steers.length, 1)
})

test('auto-advance does not fire when the gate fails, the stage is ungated, the successor is missing, the mission is blocked or the signal is aborted (regression)', async () => {
    // (a) the gate does not pass: no deterministic fact to advance on.
    disposeHosts()
    const gateCwd = tempWorkspace('orchestrator-auto-gate-')
    const gateFake = host({ cwd: gateCwd, config: { stages: autoStages() } })
    const gateStore = storeFor(gateCwd)
    parkMission(gateStore, gateCwd, 'auto-gate', 'impl', { approved: false })
    await turnStop(gateFake)
    assert.equal(gateStore.read('auto-gate')?.stage, 'impl')
    assert.equal(stageFile(gateCwd, 'auto-gate', 'impl').state, 'entered')
    assert.equal(gateFake.steers.length, 0)

    // (b) an ungated stage has nothing to decide on.
    disposeHosts()
    const freeCwd = tempWorkspace('orchestrator-auto-free-')
    const freeFake = host({ cwd: freeCwd, config: { stages: autoStages({ gate: 'none' }) } })
    const freeStore = storeFor(freeCwd)
    parkMission(freeStore, freeCwd, 'auto-free', 'impl')
    await turnStop(freeFake)
    assert.equal(freeStore.read('auto-free')?.stage, 'impl')
    assert.equal(freeFake.steers.length, 0)

    // (c) the successor's plugin is not mounted: refuse, never settle.
    disposeHosts()
    const bareCwd = tempWorkspace('orchestrator-auto-bare-')
    const bareFake = host({ cwd: bareCwd, config: { stages: autoStages() } })
    const bareStore = storeFor(bareCwd)
    parkMission(bareStore, bareCwd, 'auto-bare', 'impl')
    bareFake.tools.delete('mission_complete') // dsh-evidence-gate, required by `review`
    await turnStop(bareFake)
    assert.equal(bareStore.read('auto-bare')?.stage, 'impl')
    assert.equal(stageFile(bareCwd, 'auto-bare', 'impl').state, 'entered')
    assert.equal(bareFake.steers.length, 0)

    // (d) a blocked mission is a latch: the automatic trigger respects it too.
    disposeHosts()
    const blockedCwd = tempWorkspace('orchestrator-auto-blocked-')
    const blockedFake = host({ cwd: blockedCwd, config: { stages: autoStages() } })
    const blockedStore = storeFor(blockedCwd)
    parkMission(blockedStore, blockedCwd, 'auto-blocked', 'impl')
    blockedStore.setStatus('auto-blocked', 'blocked')
    await turnStop(blockedFake)
    assert.equal(blockedStore.read('auto-blocked')?.stage, 'impl')
    assert.equal(blockedStore.read('auto-blocked')?.status, 'blocked')
    assert.equal(blockedFake.steers.length, 0)

    // (e) a pre-aborted signal belongs to a turn the harness is discarding.
    disposeHosts()
    const abortedCwd = tempWorkspace('orchestrator-auto-aborted-')
    const abortedFake = host({ cwd: abortedCwd, config: { stages: autoStages() } })
    const abortedStore = storeFor(abortedCwd)
    parkMission(abortedStore, abortedCwd, 'auto-aborted', 'impl')
    const controller = new AbortController()
    controller.abort()
    await turnStop(abortedFake, { signal: controller.signal })
    assert.equal(abortedStore.read('auto-aborted')?.stage, 'impl')
    assert.equal(abortedFake.steers.length, 0)
})

test('the per-turn auto-advance cap holds and a settled stage is never re-advanced (regression)', async () => {
    disposeHosts()
    const cwd = tempWorkspace('orchestrator-auto-cap-')
    // A → B → C all auto-advance on the same (passing) gate, D does not.
    const chain = ['a', 'b', 'c', 'd'].map((id, index) => ({
        id,
        prompt: id,
        requiredPlugins: [],
        ...(index < 3 ? { gate: 'spec-approved', autoAdvance: true } : { gate: 'none' }),
    }))
    const fake = host({ cwd, config: { stages: chain, turnStop: { maxAutoAdvancesPerTurn: 2 } } })
    const store = storeFor(cwd)
    parkMission(store, cwd, 'auto-cap', 'a')

    await turnStop(fake, { turn: 5 })
    assert.equal(store.read('auto-cap')?.stage, 'b')
    await turnStop(fake, { turn: 5 })
    assert.equal(store.read('auto-cap')?.stage, 'c')
    // Third stop in the same turn: the budget is spent, nothing moves.
    await turnStop(fake, { turn: 5 })
    assert.equal(store.read('auto-cap')?.stage, 'c')
    assert.equal(fake.steers.length, 2)
    // A new turn re-arms the budget (the cap is per turn, not per session).
    await turnStop(fake, { turn: 6 })
    assert.equal(store.read('auto-cap')?.stage, 'd')
    assert.equal(fake.steers.length, 3)

    // An already-settled stage entry is never re-advanced, even though the
    // mission still points at it (the shape a finished last stage leaves).
    disposeHosts()
    const settledCwd = tempWorkspace('orchestrator-auto-settled-')
    const settledFake = host({ cwd: settledCwd, config: { stages: autoStages() } })
    const settledStore = storeFor(settledCwd)
    parkMission(settledStore, settledCwd, 'auto-settled', 'impl', { state: 'passed' })
    await turnStop(settledFake)
    assert.equal(settledStore.read('auto-settled')?.stage, 'impl')
    assert.equal(fake.steers.length, 3)
    assert.equal(settledFake.steers.length, 0)
})

test('auto-advance is off by default: the turn-stopping listener is a no-op (regression)', async () => {
    const fake = host()
    const store = storeFor(fake.cwd)
    await orchestrate(fake, { action: 'start', summary: 'default off' })
    const id = missionIdOf(fake.cwd)
    approveMission(store, id)
    for (let index = 0; index < 4; index += 1) await orchestrate(fake, { action: 'advance' })
    assert.equal(store.read(id)?.stage, 'quality-verify')

    // The trigger IS registered (the boundary exists), but no stage opted in…
    assert.equal(fake.listeners.get('agent/turn-stopping')?.length, 1)
    // …so even a stage whose exit gate now passes stays put and the model is
    // not steered: the default is exactly today's model-driven behaviour.
    await new Promise((resolve) => setTimeout(resolve, 5))
    recordPassGate(store, id)
    await turnStop(fake, { turn: 1 })
    await turnStop(fake, { turn: 2 })
    assert.equal(store.read(id)?.stage, 'quality-verify')
    assert.equal(stageFile(fake.cwd, id, 'quality-verify').state, 'entered')
    assert.equal(fake.steers.length, 0)

    fake.dispose()
    assert.equal(fake.listeners.get('agent/turn-stopping')?.length ?? 0, 0)
})

/**
 * dsh-evidence-gate tests: the assembly surface, evidence capture, the
 * fail-closed delivery checklist, `force` semantics and the immutable receipt.
 *
 * Ordering matters in several tests: a gate is "stale" when a `command`/`test`
 * evidence row is at least as new as it, so the fixtures deliberately record
 * evidence before the gate on the happy path (evidence → gate → complete) and
 * after it on the stale path.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStoreRegistry,
    clearProjectConfigCache,
    gitFingerprint,
    sha256,
    type GateCommandResult,
    type GateRecord,
    type GateScope,
    type GateState,
    type GitFingerprint,
    type MissionStore,
} from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeAgent, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'
import { captureEvidence } from '../dist/evidence.js'

const SESSION = 'session-1'
const GATE_SOURCE = 'dsh-quality-gate'

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Rig {
    fake: FakeHost
    store: MissionStore
    cwd: string
}

function rig(options: { config?: Record<string, unknown>; cwd?: string; logFile?: string } = {}): Rig {
    const cwd = options.cwd ?? tempWorkspace('evidence-gate-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, {
        logFile: options.logFile ?? path.join(cwd, 'evidence-gate.log'),
        ...(options.config ?? {}),
    })
    return { fake, store: new MissionStoreRegistry().for(cwd), cwd }
}

interface SeedOptions {
    id?: string
    approved?: boolean
    title?: string
}

/** Create a mission (optionally with an approved spec), like spec-gate would. */
function seedMission(store: MissionStore, cwd: string, options: SeedOptions = {}): string {
    const id = options.id ?? 'M-1'
    const record = store.create({ id, title: options.title ?? 'Add health endpoint', cwd })
    store.bindSession(SESSION, record.id)
    if (options.approved !== false) {
        const now = Date.now()
        store.update(record.id, () => ({
            status: 'spec-approved',
            spec: {
                title: record.title,
                background: '证据门禁测试',
                requirements: ['暴露 GET /health'],
                acceptanceCriteria: [{ id: 'AC-001', text: 'GET /health 返回 200' }],
                fileBoundaries: ['src/server.ts'],
                negativeConstraints: ['不得修改 dsh 核心代码'],
                revision: 1,
                createdAt: now,
                updatedAt: now,
                approvedAt: now,
                approvedBy: 'test',
            },
        }))
    }
    return record.id
}

/** One successful host command result (the shape `store.recordGate` stores). */
function gateResult(id = 'host-test', exitCode = 0): GateCommandResult {
    return {
        id,
        name: id,
        command: 'pnpm test',
        required: true,
        exitCode,
        signal: null,
        durationMs: 12,
        timedOut: false,
        output: 'ok',
        outputDigest: sha256('ok'),
    }
}

/** A complete gate run: one host command, all of them selected. */
const FULL_SCOPE: GateScope = { selected: ['host-test'], total: 1, full: true }

interface GateFixture {
    state?: GateState
    /** `null` records a gate with no fingerprint at all (partial/old record). */
    fingerprint?: GitFingerprint | null
    /** `null` records a gate with no `scope` field (pre-`GateScope` record). */
    scope?: GateScope | null
    /** `null` records a gate with an empty result list. */
    results?: GateCommandResult[] | null
}

/**
 * Record one gate verdict the way `dsh-quality-gate` would: a full-scope run
 * with a real command result, the workspace fingerprint and (through
 * `store.recordGate`) its matching `kind=gate` ledger row.
 */
function recordGate(store: MissionStore, missionId: string, options: GateFixture = {}): GateRecord {
    const state = options.state ?? 'PASS'
    const fingerprint = options.fingerprint === undefined ? gitFingerprint(store.layout.cwd) : options.fingerprint
    const scope = options.scope === undefined ? FULL_SCOPE : options.scope
    const results = options.results === undefined ? [gateResult()] : options.results
    return store.recordGate(missionId, {
        source: GATE_SOURCE,
        state,
        reason: `${state}：宿主配置的确定性命令`,
        results: results ?? [],
        ...(fingerprint === null ? {} : { fingerprint }),
        ...(scope === null ? {} : { scope }),
    })
}

/**
 * Hand-write `gates/<id>.json` **without** its ledger row — exactly what a
 * forger does. `store.recordGate` always appends the `kind=gate` row, so the
 * artifact is written directly.
 */
function forgeGate(
    store: MissionStore,
    missionId: string,
    options: { id?: string; fingerprint?: GitFingerprint | null } = {},
): GateRecord {
    const dir = store.artifactPath(missionId, 'gates')
    fs.mkdirSync(dir, { recursive: true })
    const fingerprint = options.fingerprint === undefined ? gitFingerprint(store.layout.cwd) : options.fingerprint
    const record: GateRecord = {
        id: options.id ?? 'GATE-forged-001',
        missionId,
        source: GATE_SOURCE,
        state: 'PASS',
        checkedAt: Date.now(),
        reason: 'PASS：手工写入的裁决（不是 quality_gate_run 产生的）',
        results: [gateResult()],
        ...(fingerprint === null ? {} : { fingerprint }),
        scope: FULL_SCOPE,
    }
    fs.writeFileSync(path.join(dir, `${record.id}.json`), `${JSON.stringify(record, undefined, 2)}\n`)
    return record
}

/** Record the configured required evidence kinds through the tool surface. */
async function recordProof(
    fake: FakeHost,
    missionId: string,
    kinds: ('command' | 'test')[] = ['command', 'test'],
): Promise<void> {
    for (const kind of kinds) {
        const run = await fake.runTool('evidence_record', {
            missionId,
            kind,
            summary: `${kind} 证据`,
            command: kind === 'test' ? 'node --test test/*.test.ts' : 'pnpm test',
            exitCode: 0,
            output: `${kind} ok`,
        })
        assert.equal(run.isError, false, runText(run))
    }
}

/** Move every recorded gate of a mission `minutes` into the past. */
function ageGates(store: MissionStore, missionId: string, minutes: number): void {
    const dir = store.artifactPath(missionId, 'gates')
    for (const entry of fs.readdirSync(dir)) {
        const file = path.join(dir, entry)
        const gate = JSON.parse(fs.readFileSync(file, 'utf8')) as { checkedAt: number }
        gate.checkedAt = Date.now() - minutes * 60_000
        fs.writeFileSync(file, `${JSON.stringify(gate, undefined, 2)}\n`)
    }
}

/** Rewrite one gate's `checkedAt` (fixture control over the clock). */
function setGateCheckedAt(store: MissionStore, missionId: string, gateId: string, checkedAt: number): void {
    const file = path.join(store.artifactPath(missionId, 'gates'), `${gateId}.json`)
    const gate = JSON.parse(fs.readFileSync(file, 'utf8')) as { checkedAt: number }
    gate.checkedAt = checkedAt
    fs.writeFileSync(file, `${JSON.stringify(gate, undefined, 2)}\n`)
}

/** Every `- ❌ …` line of a checklist, without the detail (report divergence check). */
function failedLabels(text: string): string[] {
    return text
        .split('\n')
        .filter((line) => line.startsWith('- ❌ '))
        .map((line) => line.slice(0, line.indexOf(' — ') === -1 ? undefined : line.indexOf(' — ')))
}

/**
 * Create a committed git workspace fixture; `undefined` when git is unavailable.
 * @param options - `ignoreTrail: false` leaves `.dsh/` untracked instead of
 *   gitignoring it, which is the case the trail exclusion has to survive.
 */
function gitRepo(prefix: string, options: { ignoreTrail?: boolean } = {}): string | undefined {
    try {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' })
        if (options.ignoreTrail !== false) fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
        fs.writeFileSync(path.join(cwd, 'src.txt'), 'initial\n')
        execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
        execFileSync(
            'git',
            [
                '-c',
                'user.email=test@example.com',
                '-c',
                'user.name=dsh-test',
                '-c',
                'commit.gpgsign=false',
                'commit',
                '-q',
                '-m',
                'init',
            ],
            { cwd, stdio: 'ignore' },
        )
        return cwd
    } catch {
        return undefined
    }
}

const receiptDir = (cwd: string, missionId: string): string =>
    path.join(cwd, '.dsh', 'missions', missionId, 'receipts')

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-evidence-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the three tools and the prompt section; dispose() removes them', () => {
    const { fake } = rig()
    assert.deepEqual([...fake.tools.keys()].sort(), [
        'evidence_record',
        'evidence_status',
        'mission_complete',
    ])
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:evidence-gate'],
    )
    assert.equal(fake.sections[0]?.order, 650)
    const text = fake.sectionText('eng:evidence-gate')
    assert.match(text, /evidence_record → quality_gate_run → mission_complete/)
    assert.match(text, /Git diff 指纹/)
    fake.dispose()
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.sections.length, 0)
})

test('the prompt section and the tools can be switched off', () => {
    const noPrompt = rig({ config: { prompt: { enabled: false } } })
    assert.equal(noPrompt.fake.sections.length, 0)
    assert.equal(noPrompt.fake.sectionText('eng:evidence-gate'), '')
    assert.equal(noPrompt.fake.tools.size, 3)

    const disabled = rig({ config: { enabled: false } })
    assert.equal(disabled.fake.tools.size, 0)
    assert.equal(disabled.fake.sections.length, 0)
})

test('resolveConfig applies the documented defaults and clamps junk values', () => {
    const defaults = resolveConfig({})
    assert.equal(defaults.enabled, true)
    assert.equal(defaults.logFile, '~/.dsh/evidence-gate.log')
    assert.equal(defaults.requireGate, true)
    assert.equal(defaults.gateSource, 'dsh-quality-gate')
    assert.deepEqual(defaults.requiredEvidenceKinds, ['command', 'test'])
    assert.equal(defaults.maxOutputTail, 2000)
    // The receipt must bind the workspace state the gate observed: on by default.
    assert.equal(defaults.requireCleanTree, true)
    assert.equal(defaults.maxGateAgeMinutes, 0)
    assert.deepEqual(defaults.prompt, { enabled: true, order: 650 })

    const junk = resolveConfig({
        requiredEvidenceKinds: ['nope'],
        maxOutputTail: -5,
        maxGateAgeMinutes: -1,
        gateSource: '',
        enabled: 'yes',
        layout: { rootDir: '.trail' },
    })
    assert.deepEqual(junk.requiredEvidenceKinds, ['command', 'test'])
    assert.equal(junk.maxOutputTail, 0)
    assert.equal(junk.maxGateAgeMinutes, 0)
    assert.equal(junk.gateSource, 'dsh-quality-gate')
    assert.equal(junk.enabled, true)
    assert.equal(junk.layout.rootDir, '.trail')

    const escape = resolveConfig({ requiredEvidenceKinds: [], rootDir: '.dsh' })
    assert.deepEqual(escape.requiredEvidenceKinds, [])
    assert.equal(resolveConfig({ requireCleanTree: false }).requireCleanTree, false)
})

test('evidence_record captures command/test/diff/manual rows with digest, tail and git fingerprint', async () => {
    const { fake, store } = rig({ config: { maxOutputTail: 40 } })
    const missionId = seedMission(store, fake.cwd)
    const output = `${'x'.repeat(100)}END`

    const commandRun = await fake.runTool('evidence_record', {
        missionId,
        kind: 'command',
        summary: '运行 pnpm test',
        command: 'pnpm test',
        exitCode: 0,
        output,
    })
    assert.equal(commandRun.isError, false, runText(commandRun))
    const commandText = runText(commandRun)
    assert.match(commandText, /已记录证据 EV-/)
    assert.match(commandText, /git 指纹/)
    assert.match(commandText, /下一步：/)

    const rows = store.readEvidence(missionId)
    assert.equal(rows.length, 1)
    const command = rows[0]
    assert.equal(command?.kind, 'command')
    assert.equal(command?.command, 'pnpm test')
    assert.equal(command?.exitCode, 0)
    assert.equal(command?.missionId, missionId)
    assert.equal(command?.recordedBy, fake.agent.id)
    assert.equal(command?.outputDigest, sha256(output))
    assert.equal(command?.outputTail?.endsWith(output.slice(-40)), true)
    assert.match(command?.outputTail ?? '', /chars dropped/)
    assert.equal(typeof command?.git?.diffDigest, 'string')
    assert.equal(command?.git?.isRepo, false)

    await recordProof(fake, missionId, ['test'])
    const diffRun = await fake.runTool('evidence_record', {
        missionId,
        kind: 'diff',
        summary: '工作区 diff 指纹',
    })
    assert.equal(diffRun.isError, false, runText(diffRun))
    assert.match(runText(diffRun), /git diff 摘要/)
    const diff = store.readEvidence(missionId).find((row) => row.kind === 'diff')
    assert.equal(diff?.outputDigest, sha256(''))
    assert.equal(typeof (diff?.data as { diffSummary?: unknown } | undefined)?.diffSummary, 'string')

    const manualRun = await fake.runTool('evidence_record', {
        missionId,
        kind: 'manual',
        summary: '人工确认 UI 文案',
        note: '张三 2026-09-17 复核截图',
    })
    assert.equal(manualRun.isError, false, runText(manualRun))
    const manual = store.readEvidence(missionId).find((row) => row.kind === 'manual')
    assert.equal((manual?.data as { note?: string } | undefined)?.note, '张三 2026-09-17 复核截图')

    assert.equal(store.readEvidence(missionId).length, 4)
    assert.equal(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'evidence.jsonl'), 'utf8').trim().split('\n').length, 4)
})

test('evidence_record refuses a manual claim without a note, a missing mission and a bad kind', async () => {
    const { fake, store } = rig()
    const empty = createFakeHost({ cwd: tempWorkspace('evidence-gate-empty-') })
    apply(empty.ctx as never, { logFile: path.join(empty.cwd, 'evidence-gate.log') })
    const missing = await empty.runTool('evidence_record', { kind: 'command', summary: 'x' })
    assert.equal(missing.isError, true)
    assert.match(String(missing.content), /先调用 spec_create/)

    const missionId = seedMission(store, fake.cwd)
    const noNote = await fake.runTool('evidence_record', {
        missionId,
        kind: 'manual',
        summary: '人工声明完成',
    })
    assert.equal(noNote.isError, true)
    assert.match(String(noNote.content), /必须提供 note/)
    assert.equal(store.readEvidence(missionId).length, 0)

    const badKind = await fake.runTool('evidence_record', { missionId, kind: 'vibes', summary: 'x' })
    assert.equal(badKind.isError, true)
    assert.match(String(badKind.content), /kind/)
    assert.equal(store.readEvidence(missionId).length, 0)

    const noSummary = await fake.runTool('evidence_record', { missionId, kind: 'command' })
    assert.equal(noSummary.isError, true)
    assert.match(String(noSummary.content), /summary/)
})

test('captureEvidence is the defensive second line for hosts without schema validation', () => {
    const cwd = tempWorkspace('evidence-gate-capture-')
    assert.throws(
        () => captureEvidence({ kind: 'vibes', summary: 'x' }, { cwd, maxOutputTail: 2000 }),
        /证据类型非法/,
    )
    // `gate` rows are the deterministic verdict of the quality gate, never a
    // model-authored row.
    assert.throws(
        () => captureEvidence({ kind: 'gate', summary: 'x' }, { cwd, maxOutputTail: 2000 }),
        /证据类型非法/,
    )
    assert.throws(
        () => captureEvidence({ kind: 'manual', summary: 'x' }, { cwd, maxOutputTail: 2000 }),
        /必须提供 note/,
    )
    assert.throws(
        () => captureEvidence({ kind: 'command', summary: ' ' }, { cwd, maxOutputTail: 2000 }),
        /缺少 summary/,
    )
    assert.throws(
        () =>
            captureEvidence(
                { kind: 'command', summary: 'x', exitCode: 1.5 },
                { cwd, maxOutputTail: 2000 },
            ),
        /exitCode 必须是整数/,
    )
})

test('evidence_status on a bare mission lists every missing item (fail closed)', async () => {
    const { fake, store } = rig()
    seedMission(store, fake.cwd, { approved: false })
    const run = await fake.runTool('evidence_status', {})
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /## 证据与交付总览（mission M-1）/)
    assert.match(text, /规格: 未创建/)
    assert.match(text, /证据: 共 0 条（无）/)
    assert.match(text, /最近证据: 无/)
    assert.match(text, /回执: 无/)
    assert.match(text, /必填证据类型（config.requiredEvidenceKinds）: command, test/)
    assert.match(text, /fail-closed 检查表/)
    assert.match(text, /- ❌ 规格已审批（spec.approvedAt 存在）/)
    assert.match(text, /- ❌ 质量门禁已运行（source=dsh-quality-gate）/)
    assert.match(text, /- ❌ 必填证据类型齐全（command, test）/)
    assert.match(text, /→ 下一步：spec_create → spec_approve/)
    assert.match(text, /→ 下一步：quality_gate_run/)
    assert.match(text, /结论: 还差 3 项/)

    const nowhere = await fake.runTool('evidence_status', { missionId: 'M-404' })
    assert.match(runText(nowhere), /没有 mission/)
})

test('evidence_status turns green once the spec, gate and evidence are in place', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId)
    const text = runText(await fake.runTool('evidence_status', { missionId }))
    assert.match(text, /规格: 已审批（rev 1，验收标准 1 条/)
    assert.match(text, /证据: 共 3 条（command 1 \/ test 1 \/ gate 1）/)
    assert.match(text, /最新门禁（source=dsh-quality-gate）: GATE-.* PASS/)
    assert.match(text, /- ✅ 规格已审批/)
    assert.match(text, /- ✅ 门禁裁决为 PASS/)
    assert.match(text, /- ✅ 门禁不早于最新 command\/test 证据/)
    assert.match(text, /结论: 全部通过，可以调用 mission_complete 交付。/)
})

test('mission_complete blocks without an approved specification', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd, { approved: false })
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId)
    const run = await fake.runTool('mission_complete', { missionId })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /❌ mission M-1 不能交付/)
    assert.match(text, /- ❌ 规格已审批/)
    assert.match(text, /→ 下一步：spec_create → spec_approve/)
    assert.match(text, /状态未改变，仍为 draft/)
    assert.equal(store.read(missionId)?.status, 'draft')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)
})

test('mission_complete blocks when the quality gate never ran', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    const run = await fake.runTool('mission_complete', { missionId })
    const text = runText(run)
    assert.match(text, /- ❌ 质量门禁已运行（source=dsh-quality-gate）/)
    assert.match(text, /没有任何来自 dsh-quality-gate 的门禁记录/)
    assert.match(text, /→ 下一步：quality_gate_run/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
})

test('mission_complete blocks a WARN and a BLOCK gate', async () => {
    for (const state of ['WARN', 'BLOCK'] as const) {
        const { fake, store } = rig()
        const missionId = seedMission(store, fake.cwd)
        await recordProof(fake, missionId)
        await sleep(5)
        recordGate(store, missionId, { state })
        const text = runText(await fake.runTool('mission_complete', { missionId }))
        assert.match(text, new RegExp(`最新裁决 ${state}`), state)
        assert.match(text, /门禁裁决为 PASS/)
        assert.equal(store.read(missionId)?.status, 'spec-approved', state)
        assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false, state)
    }
})

test('mission_complete blocks when a required evidence kind is missing', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId, ['command'])
    await sleep(5)
    recordGate(store, missionId)
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 必填证据类型齐全（command, test）/)
    assert.match(text, /缺少 test/)
    assert.match(text, /→ 下一步：evidence_record（kind=test/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
})

test('mission_complete blocks a stale gate and passes after the gate is re-run', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    recordGate(store, missionId)
    await sleep(5)
    await recordProof(fake, missionId)
    const blocked = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(blocked, /- ❌ 门禁不早于最新 command\/test 证据/)
    assert.match(blocked, /早于最新证据 EV-/)
    assert.match(blocked, /→ 下一步：quality_gate_run/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    await sleep(5)
    recordGate(store, missionId)
    const delivered = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(delivered, /✅ mission M-1 已交付/)
    assert.equal(store.read(missionId)?.status, 'delivered')
})

test('maxGateAgeMinutes blocks a gate that is too old', async () => {
    const { fake, store } = rig({ config: { requiredEvidenceKinds: [], maxGateAgeMinutes: 30 } })
    const missionId = seedMission(store, fake.cwd)
    recordGate(store, missionId)
    ageGates(store, missionId, 120)
    const blocked = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(blocked, /- ❌ 门禁年龄未超过 30 分钟（maxGateAgeMinutes）/)
    assert.match(blocked, /120 分钟前/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    await sleep(5)
    recordGate(store, missionId)
    assert.match(runText(await fake.runTool('mission_complete', { missionId })), /✅ mission M-1 已交付/)
})

test('mission_complete issues one immutable receipt after a PASS gate covering the evidence', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    const gate = recordGate(store, missionId)
    const evidenceIds = store.readEvidence(missionId).map((row) => row.id)

    const run = await fake.runTool('mission_complete', { missionId, summary: '健康检查接口已交付' })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /✅ mission M-1 已交付（状态 delivered）。/)
    assert.match(text, /回执: RCP-/)
    assert.match(text, /receipts\/RCP-.*\.json/)
    assert.match(text, new RegExp(`门禁: ${gate.id} PASS by ${GATE_SOURCE}`))
    assert.match(text, /交付说明: 健康检查接口已交付/)

    assert.equal(store.read(missionId)?.status, 'delivered')
    const files = fs.readdirSync(receiptDir(fake.cwd, missionId))
    assert.equal(files.length, 1)
    const receiptFile = path.join(receiptDir(fake.cwd, missionId), files[0] ?? '')
    const before = fs.readFileSync(receiptFile, 'utf8')
    const beforeStat = fs.statSync(receiptFile).mtimeMs
    const receipt = JSON.parse(before) as {
        id: string
        digest: string
        gateId: string
        evidenceIds: string[]
        specDigest?: string
        git?: GitFingerprint
    }
    assert.equal(receipt.gateId, gate.id)
    assert.deepEqual(receipt.evidenceIds, [...evidenceIds].sort())
    assert.equal(receipt.specDigest, store.read(missionId)?.specDigest)
    assert.equal(typeof receipt.git?.diffDigest, 'string')

    // The receipt is immutable: a second call neither re-issues nor rewrites it.
    await sleep(5)
    const second = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(second, /已经交付过/)
    assert.match(second, /不重复签发、不覆盖/)
    assert.equal(fs.readdirSync(receiptDir(fake.cwd, missionId)).length, 1)
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), before)
    assert.equal(fs.statSync(receiptFile).mtimeMs, beforeStat)
    assert.equal(store.read(missionId)?.status, 'delivered')
})

test('force relaxes only the required-evidence-kinds check and leaves a manual override row', async () => {
    // The override only exists when the host asked for it.
    const { fake, store } = rig({ config: { allowForceOverride: true } })
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId, ['command'])
    await sleep(5)
    recordGate(store, missionId)

    const text = runText(await fake.runTool('mission_complete', { missionId, force: true }))
    assert.match(text, /✅ mission M-1 已交付/)
    assert.match(text, /force 覆盖已留痕/)
    const override = store.readEvidence(missionId).find((row) => row.kind === 'manual')
    assert.match(override?.summary ?? '', /force=true 放松了"必填证据类型"检查：缺少 test/)
    assert.equal((override?.data as { override?: boolean } | undefined)?.override, true)
    assert.equal(override?.recordedBy, 'dsh-evidence-gate')
    const receipt = store.readReceipts(missionId)[0]
    assert.equal(receipt?.evidenceIds.includes(override?.id ?? ''), true)
})

test('force can never bypass the gate, the spec or a stale gate', async () => {
    const { fake, store } = rig({ config: { allowForceOverride: true } })
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId, ['command'])
    const noGate = runText(await fake.runTool('mission_complete', { missionId, force: true }))
    assert.match(noGate, /❌ mission M-1 不能交付/)
    assert.match(noGate, /force=true 被拒绝/)
    assert.match(noGate, /质量门禁已运行/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    await sleep(5)
    recordGate(store, missionId, { state: 'WARN' })
    const warn = runText(await fake.runTool('mission_complete', { missionId, force: true }))
    assert.match(warn, /force=true 被拒绝/)
    assert.match(warn, /最新裁决 WARN/)
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)

    const unapproved = rig({ config: { allowForceOverride: true } })
    const other = seedMission(unapproved.store, unapproved.fake.cwd, { id: 'M-2', approved: false })
    await recordProof(unapproved.fake, other, ['command'])
    await sleep(5)
    recordGate(unapproved.store, other)
    const specText = runText(await unapproved.fake.runTool('mission_complete', { missionId: other, force: true }))
    assert.match(specText, /force=true 被拒绝/)
    assert.match(specText, /规格已审批/)
    assert.equal(unapproved.store.read(other)?.status, 'draft')
})

test('mission_complete reports a missing mission instead of throwing', async () => {
    const { fake } = rig()
    const run = await fake.runTool('mission_complete', {})
    assert.equal(run.isError, false)
    assert.match(runText(run), /❌ 不能交付：当前会话\/工作区没有 mission/)
    assert.match(runText(run), /→ 下一步：spec_create/)
    const explicit = await fake.runTool('mission_complete', { missionId: 'M-404' })
    assert.match(runText(explicit), /找不到 mission M-404/)
})

test('requireCleanTree compares the working tree with the fingerprint the gate observed', async (t) => {
    const cwd = gitRepo('evidence-gate-git-')
    if (cwd === undefined) {
        t.skip('git is unavailable in this environment')
        return
    }
    const { fake, store } = rig({
        cwd,
        config: { requireCleanTree: true },
        logFile: path.join(os.tmpdir(), 'evidence-gate-clean-tree.log'),
    })

    const first = seedMission(store, cwd, { id: 'M-1' })
    await recordProof(fake, first)
    await sleep(5)
    const clean = gitFingerprint(cwd)
    assert.equal(clean.isRepo, true)
    assert.equal(clean.dirty, false, 'the trail is gitignored, so the tree stays clean')
    recordGate(store, first, { fingerprint: clean })
    const delivered = runText(await fake.runTool('mission_complete', { missionId: first }))
    assert.match(delivered, /✅ mission M-1 已交付/)
    assert.match(delivered, /- 交付前检查|交付前检查/)

    const second = seedMission(store, cwd, { id: 'M-2' })
    await recordProof(fake, second)
    await sleep(5)
    recordGate(store, second, { fingerprint: gitFingerprint(cwd) })
    fs.writeFileSync(path.join(cwd, 'src.txt'), 'changed after the gate\n')
    const blocked = runText(await fake.runTool('mission_complete', { missionId: second }))
    assert.match(blocked, /- ❌ 工作区与门禁观测时的指纹一致（requireCleanTree=true）/)
    assert.match(blocked, /≠ 门禁观测/)
    assert.equal(store.read(second)?.status, 'spec-approved')

    fs.writeFileSync(path.join(cwd, 'src.txt'), 'initial\n')
    assert.match(
        runText(await fake.runTool('mission_complete', { missionId: second })),
        /✅ mission M-2 已交付/,
    )
})

test('a mission without a gate fingerprint blocks when requireCleanTree is on (fail closed)', async () => {
    const { fake, store } = rig({ config: { requireCleanTree: true } })
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId, { fingerprint: null })
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 工作区与门禁观测时的指纹一致（requireCleanTree=true）/)
    assert.match(text, /门禁记录没有工作区指纹/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
})

// --- audit regressions -----------------------------------------------------

test('[audit 1] mission 解析不回退到“工作区里最新的 mission”', async () => {
    const cwd = tempWorkspace('evidence-gate-resolve-')
    const owner = createFakeHost({ cwd })
    apply(owner.ctx as never, { logFile: path.join(cwd, 'owner.log') })
    const store = new MissionStoreRegistry().for(cwd)
    const missionId = seedMission(store, cwd)

    // A different session in the same workspace: it must neither annotate nor
    // deliver the mission that belongs to `session-1`.
    const stranger = createFakeHost({ cwd, agent: fakeAgent(cwd, 'agent-9', 'session-9') })
    apply(stranger.ctx as never, { logFile: path.join(cwd, 'stranger.log') })

    const record = await stranger.runTool('evidence_record', { kind: 'command', summary: '越权登记' })
    assert.equal(record.isError, true)
    const error = String(record.content)
    assert.match(error, /不会回退到工作区里最新的 mission/)
    assert.match(error, /spec_create/)
    assert.match(error, /orchestrate start/)
    assert.match(error, /missionId/)
    assert.equal(store.readEvidence(missionId).length, 0, 'no cross-session write')

    const status = runText(await stranger.runTool('evidence_status', {}))
    assert.match(status, /❌ 没有 mission 可查看/)
    assert.match(status, /orchestrate start/)
    const complete = runText(await stranger.runTool('mission_complete', {}))
    assert.match(complete, /❌ 不能交付/)
    assert.match(complete, /missionId/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    // Way forward 1: pass the mission explicitly.
    const explicit = await stranger.runTool('evidence_record', {
        missionId,
        kind: 'command',
        summary: '显式指定 mission',
        command: 'pnpm typecheck',
        exitCode: 0,
        output: 'ok',
    })
    assert.equal(explicit.isError, false, runText(explicit))
    assert.equal(store.readEvidence(missionId).length, 1)

    // Way forward 2 (delegation): a child session inherits its parent's mission
    // through its own session header.
    const child = createFakeHost({
        cwd,
        agent: {
            id: 'agent-child',
            session: {
                id: 'session-child',
                header: { id: 'session-child', cwd, parentSession: SESSION },
            },
        } as never,
    })
    apply(child.ctx as never, { logFile: path.join(cwd, 'child.log') })
    const inherited = await child.runTool('evidence_record', {
        kind: 'manual',
        summary: '子代理继承父会话 mission',
        note: 'delegated child',
    })
    assert.equal(inherited.isError, false, runText(inherited))
    assert.equal(store.readEvidence(missionId).length, 2)
})

test('[audit 2] mission_complete 只把成功的 command/test 行算作必填证据', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    const host = await fake.runTool('evidence_record', {
        missionId,
        kind: 'command',
        summary: '宿主类型检查',
        command: 'pnpm typecheck',
        exitCode: 0,
        output: 'no errors',
    })
    assert.equal(host.isError, false, runText(host))
    const failed = await fake.runTool('evidence_record', {
        missionId,
        kind: 'test',
        summary: '测试失败（保留作参考）',
        command: 'node --test test/*.test.ts',
        exitCode: 2,
        output: 'BOOM: 12 tests failed',
    })
    // Recording a failure stays legal: it is informative.
    assert.equal(failed.isError, false, runText(failed))
    assert.match(runText(failed), /不会计入交付检查表/)
    const failedId = store.readEvidence(missionId).find((row) => row.kind === 'test')?.id ?? ''
    assert.notEqual(failedId, '')

    await sleep(5)
    recordGate(store, missionId)
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /❌ mission M-1 不能交付/)
    assert.match(text, /- ❌ 必填证据类型齐全（command, test）/)
    assert.match(text, /缺少 test/)
    assert.ok(text.includes(`${failedId} 记录了 exitCode=2`), text)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)

    // The same checklist is what evidence_status reports.
    const status = runText(await fake.runTool('evidence_status', { missionId }))
    assert.ok(status.includes(`${failedId} 记录了 exitCode=2`), status)
    assert.deepEqual(failedLabels(status), failedLabels(text))

    // A genuine passing test row repairs it.
    await fake.runTool('evidence_record', {
        missionId,
        kind: 'test',
        summary: '测试通过',
        command: 'node --test test/*.test.ts',
        exitCode: 0,
        output: 'ok: 12 tests',
    })
    await sleep(5)
    recordGate(store, missionId)
    assert.match(runText(await fake.runTool('mission_complete', { missionId })), /✅ mission M-1 已交付/)
})

test('[audit 2] manual 声明不能顶替必填类型（无 output / 无 command 的行也不行）', async () => {
    const { fake, store } = rig({ config: { requiredEvidenceKinds: ['command', 'manual'] } })
    const missionId = seedMission(store, fake.cwd)
    await fake.runTool('evidence_record', {
        missionId,
        kind: 'manual',
        summary: '人工声明完成',
        note: '张三复核截图',
    })
    await fake.runTool('evidence_record', {
        missionId,
        kind: 'command',
        summary: '没有捕获输出',
        command: 'pnpm test',
        exitCode: 0,
    })
    await sleep(5)
    recordGate(store, missionId)
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 必填证据类型齐全（command, manual）/)
    assert.match(text, /缺少 command, manual/)
    assert.match(text, /是 manual 声明/)
    assert.match(text, /没有捕获输出/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
})

test('[audit 3] 手工写入的 gates/*.json（没有台账行）视为伪造，拒绝交付', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    const forged = forgeGate(store, missionId)
    assert.equal(store.readEvidence(missionId).some((row) => row.kind === 'gate'), false)

    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /❌ mission M-1 不能交付/)
    assert.match(text, /- ❌ 门禁裁决在证据台账中有对应记录（kind=gate 且 data.gateId 匹配）/)
    assert.ok(text.includes(`gates/${forged.id}.json 在证据台账里没有对应的 gate 证据行`), text)
    assert.match(text, /伪造/)
    assert.match(text, /→ 下一步：quality_gate_run/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)

    // The forgery was the only blocker: a real gate run delivers.
    await sleep(5)
    recordGate(store, missionId)
    assert.match(runText(await fake.runTool('mission_complete', { missionId })), /✅ mission M-1 已交付/)
})

test('[audit 3] 门禁只覆盖部分命令 / 没有 scope 字段（旧记录）都被拒绝', async () => {
    const partial: GateScope = { selected: ['host-test'], total: 3, full: false }
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId, { scope: partial })
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 门禁覆盖了全部宿主命令（gate.scope.full=true）/)
    assert.match(text, /门禁只覆盖了部分命令（scope.full=false），请重跑完整门禁/)
    assert.match(text, /已执行 1\/3 条/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)

    // An older record without `scope` is "unknown", never "full".
    const second = rig()
    const other = seedMission(second.store, second.fake.cwd)
    await recordProof(second.fake, other)
    await sleep(5)
    recordGate(second.store, other, { scope: null })
    const legacy = runText(await second.fake.runTool('mission_complete', { missionId: other }))
    assert.match(legacy, /- ❌ 门禁覆盖了全部宿主命令（gate.scope.full=true）/)
    assert.match(legacy, /门禁只覆盖了部分命令（scope.full=false），请重跑完整门禁/)
    assert.match(legacy, /没有 scope 字段/)
    assert.equal(second.store.read(other)?.status, 'spec-approved')
})

test('[audit 3] PASS 但 results 为空（没验证任何命令）被视为无效证据', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId, { results: null })
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 门禁真的执行了命令（gate.results.length > 0）/)
    assert.match(text, /门禁裁决 PASS 但 results 为空/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)
})

test('[audit 3] 门禁与最新证据同一毫秒也算陈旧（fail closed）', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    const proof = store.readEvidence(missionId).at(-1)
    assert.notEqual(proof, undefined)
    const gate = recordGate(store, missionId)
    setGateCheckedAt(store, missionId, gate.id, proof?.recordedAt ?? 0)
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ 门禁不早于最新 command\/test 证据/)
    assert.match(text, /同一毫秒/)
    assert.match(text, /按陈旧处理/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')

    // Even 1 ms newer is accepted: only the tie is treated as stale.
    setGateCheckedAt(store, missionId, gate.id, (proof?.recordedAt ?? 0) + 1)
    assert.match(runText(await fake.runTool('mission_complete', { missionId })), /✅ mission M-1 已交付/)
})

test('[audit 4] blocked 的 mission 拒绝交付（熔断不可绕过，force 也不行）', async () => {
    const { fake, store } = rig({ config: { allowForceOverride: true } })
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId)
    store.setStatus(missionId, 'blocked')

    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /- ❌ mission 未被熔断阻断（status ≠ blocked）/)
    assert.match(text, /blocked（熔断）状态/)
    assert.equal(store.read(missionId)?.status, 'blocked')
    assert.equal(fs.existsSync(receiptDir(fake.cwd, missionId)), false)

    const forced = runText(await fake.runTool('mission_complete', { missionId, force: true }))
    assert.match(forced, /force=true 被拒绝/)
    assert.match(forced, /mission 未被熔断阻断/)
    assert.equal(store.read(missionId)?.status, 'blocked')

    const status = runText(await fake.runTool('evidence_status', { missionId }))
    assert.match(status, /- ❌ mission 未被熔断阻断/)
})

test('[audit 4] requireCleanTree 默认开启：门禁之后改动工作区即拒绝，.dsh 台账被排除', async (t) => {
    const cwd = gitRepo('evidence-gate-default-clean-', { ignoreTrail: false })
    if (cwd === undefined) {
        t.skip('git is unavailable in this environment')
        return
    }
    const { fake, store } = rig({ cwd, logFile: path.join(os.tmpdir(), 'evidence-gate-default-clean.log') })
    const missionId = seedMission(store, cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    // The gate observes the tree; everything after it writes into `.dsh/`
    // (untracked here), which must never invalidate the comparison.
    recordGate(store, missionId, { fingerprint: gitFingerprint(cwd) })
    const delivered = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(delivered, /✅ mission M-1 已交付/)
    assert.doesNotMatch(delivered, /未核对项/)

    const second = seedMission(store, cwd, { id: 'M-2' })
    await recordProof(fake, second)
    await sleep(5)
    recordGate(store, second, { fingerprint: gitFingerprint(cwd) })
    fs.writeFileSync(path.join(cwd, 'src.txt'), 'changed after the gate\n')
    const blocked = runText(await fake.runTool('mission_complete', { missionId: second }))
    assert.match(blocked, /- ❌ 工作区与门禁观测时的指纹一致（requireCleanTree=true）/)
    assert.match(blocked, /≠ 门禁观测/)
    assert.equal(store.read(second)?.status, 'spec-approved')
})

test('[audit 4] 非 git 工作区照常交付，但报告显式标注“无法核对”', async () => {
    const { fake, store } = rig()
    const missionId = seedMission(store, fake.cwd)
    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId) // non-repo fingerprint on both sides

    const status = runText(await fake.runTool('evidence_status', { missionId }))
    assert.match(status, /- ⚠️ 工作区与门禁观测时的指纹一致（requireCleanTree=true）/)
    assert.match(status, /无法核对（非 git 工作区）/)
    assert.match(status, /⚠️ 未核对项/)

    const delivered = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(delivered, /✅ mission M-1 已交付/)
    assert.match(delivered, /⚠️ 未核对项/)
    assert.match(delivered, /无法核对（非 git 工作区）/)
    assert.equal(store.read(missionId)?.status, 'delivered')
})

test('force is only honoured when the host opts in (regression)', async () => {
    // The escape hatch that can turn a red checklist green must be the host's
    // explicit decision, not a parameter the model can reach for.
    const strict = rig()
    const strictMission = seedMission(strict.store, strict.fake.cwd)
    await recordProof(strict.fake, strictMission, ['command'])
    await sleep(5)
    recordGate(strict.store, strictMission)
    const refused = runText(await strict.fake.runTool('mission_complete', { missionId: strictMission, force: true }))
    assert.match(refused, /allowForceOverride=false/)
    assert.match(refused, /❌ mission M-1 不能交付/)
    assert.equal(strict.store.read(strictMission)?.status, 'spec-approved')
    assert.equal(strict.store.readReceipts(strictMission).length, 0)
    assert.equal(strict.store.readEvidence(strictMission).some((row) => row.kind === 'manual'), false)

    // With the host's opt-in the same call delivers and leaves the override row.
    const relaxed = rig({ config: { allowForceOverride: true } })
    const relaxedMission = seedMission(relaxed.store, relaxed.fake.cwd)
    await recordProof(relaxed.fake, relaxedMission, ['command'])
    await sleep(5)
    recordGate(relaxed.store, relaxedMission)
    const delivered = runText(await relaxed.fake.runTool('mission_complete', { missionId: relaxedMission, force: true }))
    assert.doesNotMatch(delivered, /allowForceOverride=false/)
    assert.match(delivered, /force 覆盖已留痕/)
    assert.equal(relaxed.store.readEvidence(relaxedMission).some((row) => row.kind === 'manual'), true)
})

// --- project-level configuration (.dsh/evidence-gate.json) -----------------

/**
 * Write one workspace's project-level config file (`{ … }`, or a raw string to
 * produce a broken file) and drop the reader cache, so the fixture can never
 * observe a stale read.
 */
function writeProjectConfig(cwd: string, value: unknown): string {
    const file = path.join(cwd, '.dsh', 'evidence-gate.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, undefined, 2)}\n`)
    clearProjectConfigCache()
    return file
}

/**
 * Every file under `root`, relative and sorted: a cheap "did anything at all
 * change here" check for a directory no gate may write into.
 */
function listFiles(root: string): string[] {
    if (!fs.existsSync(root)) return []
    return (fs.readdirSync(root, { recursive: true }) as string[]).sort()
}

/** `recordProof`, but for a workspace other than the fake host's default agent. */
async function recordProofFor(
    fake: FakeHost,
    missionId: string,
    kinds: ('command' | 'test')[],
    agent: FakeAgent,
): Promise<void> {
    for (const kind of kinds) {
        const run = await fake.runTool(
            'evidence_record',
            {
                missionId,
                kind,
                summary: `${kind} 证据`,
                command: kind === 'test' ? 'node --test test/*.test.ts' : 'pnpm test',
                exitCode: 0,
                output: `${kind} ok`,
            },
            { agent },
        )
        assert.equal(run.isError, false, runText(run))
    }
}

test('项目级 requiredEvidenceKinds 只作用于自己的工作区（一个 host 服务两个仓库） (regression)', async () => {
    // One profile, two repositories: A refines its checklist to `artifact`,
    // B inherits the profile's `command`+`test`. Neither may affect the other.
    const cwdA = tempWorkspace('evidence-gate-project-a-')
    const cwdB = tempWorkspace('evidence-gate-project-b-')
    writeProjectConfig(cwdA, { requiredEvidenceKinds: ['artifact'] })
    const { fake } = rig({ cwd: cwdA, logFile: path.join(cwdA, 'evidence-gate.log') })
    const storeA = new MissionStoreRegistry().for(cwdA)
    const storeB = new MissionStoreRegistry().for(cwdB)
    const agentB = fakeAgent(cwdB, 'agent-b')
    const missionA = seedMission(storeA, cwdA, { id: 'M-A' })
    const missionB = seedMission(storeB, cwdB, { id: 'M-B' })

    // A only demands `artifact`: no command/test row exists, yet nothing else
    // is reported missing.
    const statusA = runText(await fake.runTool('evidence_status', { missionId: missionA }))
    assert.match(statusA, /配置来源：项目级 /)
    assert.match(statusA, /必填证据类型（config.requiredEvidenceKinds）: artifact/)
    assert.match(statusA, /- ❌ 必填证据类型齐全（artifact）/)
    assert.doesNotMatch(statusA, /必填证据类型齐全（command, test）/)

    const artifact = await fake.runTool('evidence_record', {
        missionId: missionA,
        kind: 'artifact',
        summary: '构建产物',
        artifactPath: 'dist/app.js',
    })
    assert.equal(artifact.isError, false, runText(artifact))
    await sleep(5)
    recordGate(storeA, missionA)
    assert.match(runText(await fake.runTool('mission_complete', { missionId: missionA })), /✅ mission M-A 已交付/)

    // B, in the same host, still demands the profile's kinds.
    const statusB = runText(await fake.runTool('evidence_status', { missionId: missionB }, { agent: agentB }))
    assert.match(statusB, /配置来源：profile/)
    assert.match(statusB, /必填证据类型（config.requiredEvidenceKinds）: command, test/)

    const artifactB = await fake.runTool(
        'evidence_record',
        { missionId: missionB, kind: 'artifact', summary: '构建产物', artifactPath: 'dist/b.js' },
        { agent: agentB },
    )
    assert.equal(artifactB.isError, false, runText(artifactB))
    await sleep(5)
    recordGate(storeB, missionB)
    const blockedB = runText(await fake.runTool('mission_complete', { missionId: missionB }, { agent: agentB }))
    assert.match(blockedB, /- ❌ 必填证据类型齐全（command, test）/)
    assert.equal(storeB.read(missionB)?.status, 'spec-approved')

    await recordProofFor(fake, missionB, ['command', 'test'], agentB)
    await sleep(5)
    recordGate(storeB, missionB)
    assert.match(runText(await fake.runTool('mission_complete', { missionId: missionB }, { agent: agentB })), /✅ mission M-B 已交付/)
})

test('host-only 键（enabled/allowForceOverride/logFile/layout）在项目文件里一律被忽略 (regression)', async () => {
    const cwd = tempWorkspace('evidence-gate-host-only-')
    const hijackLog = path.join(cwd, 'hijacked.log')
    writeProjectConfig(cwd, {
        enabled: false,
        allowForceOverride: true,
        logFile: hijackLog,
        rootDir: 'hijacked',
        missionsDir: 'hijacked/missions',
    })
    const { fake, store } = rig({ cwd, logFile: path.join(cwd, 'evidence-gate.log') })
    // `enabled: false` is ignored: the gate is still assembled.
    assert.equal(fake.tools.size, 3)

    const missionId = seedMission(store, cwd)
    await recordProof(fake, missionId, ['command'])
    await sleep(5)
    recordGate(store, missionId)

    // `allowForceOverride: true` is ignored: the profile's `false` decides, so
    // the model-supplied `force` still cannot downgrade the checklist.
    const refused = runText(await fake.runTool('mission_complete', { missionId, force: true }))
    assert.match(refused, /allowForceOverride=false/)
    assert.match(refused, /❌ mission M-1 不能交付/)
    assert.equal(store.read(missionId)?.status, 'spec-approved')
    assert.equal(store.readReceipts(missionId).length, 0)

    // Every refused key is a reported problem, never a silent no-op.
    const status = runText(await fake.runTool('evidence_status', { missionId }))
    assert.match(status, /另有 5 条配置问题/)

    // `logFile`/layout are ignored: artifacts land in the profile's layout.
    assert.equal(fs.existsSync(hijackLog), false)
    assert.equal(fs.existsSync(path.join(cwd, 'hijacked')), false)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', missionId, 'evidence.jsonl')), true)

    // The profile's checklist is still in force: `test` is still required.
    await recordProof(fake, missionId, ['test'])
    await sleep(5)
    recordGate(store, missionId)
    assert.match(runText(await fake.runTool('mission_complete', { missionId })), /✅ mission M-1 已交付/)
    assert.equal(fs.existsSync(receiptDir(cwd, missionId)), true)
})

test('项目级 requireCleanTree=false 只放松写了这个键的工作区 (regression)', async (t) => {
    const cwdA = gitRepo('evidence-gate-project-clean-a-')
    const cwdB = gitRepo('evidence-gate-project-clean-b-')
    if (cwdA === undefined || cwdB === undefined) {
        t.skip('git is unavailable in this environment')
        return
    }
    writeProjectConfig(cwdA, { requireCleanTree: false })
    const { fake } = rig({
        cwd: cwdA,
        logFile: path.join(os.tmpdir(), 'evidence-gate-project-clean.log'),
    })
    const storeA = new MissionStoreRegistry().for(cwdA)
    const storeB = new MissionStoreRegistry().for(cwdB)
    const agentB = fakeAgent(cwdB, 'agent-b')

    // A: the gate observes a clean tree, then the tree changes — the project
    // file turned the comparison off for THIS workspace, so it still delivers.
    const missionA = seedMission(storeA, cwdA, { id: 'M-A' })
    await recordProof(fake, missionA)
    await sleep(5)
    recordGate(storeA, missionA, { fingerprint: gitFingerprint(cwdA) })
    fs.writeFileSync(path.join(cwdA, 'src.txt'), 'changed after the gate\n')
    const statusA = runText(await fake.runTool('evidence_status', { missionId: missionA }))
    assert.match(statusA, /配置来源：项目级 /)
    assert.match(statusA, /requireCleanTree=false/)
    assert.doesNotMatch(statusA, /工作区与门禁观测时的指纹一致/)
    assert.match(runText(await fake.runTool('mission_complete', { missionId: missionA })), /✅ mission M-A 已交付/)

    // B: no override, so the profile's `requireCleanTree=true` still blocks.
    const missionB = seedMission(storeB, cwdB, { id: 'M-B' })
    await recordProofFor(fake, missionB, ['command', 'test'], agentB)
    await sleep(5)
    recordGate(storeB, missionB, { fingerprint: gitFingerprint(cwdB) })
    fs.writeFileSync(path.join(cwdB, 'src.txt'), 'changed after the gate\n')
    const statusB = runText(await fake.runTool('evidence_status', { missionId: missionB }, { agent: agentB }))
    assert.match(statusB, /配置来源：profile/)
    assert.match(statusB, /requireCleanTree=true/)
    const blockedB = runText(await fake.runTool('mission_complete', { missionId: missionB }, { agent: agentB }))
    assert.match(blockedB, /- ❌ 工作区与门禁观测时的指纹一致（requireCleanTree=true）/)
    assert.equal(storeB.read(missionB)?.status, 'spec-approved')
})

test('损坏的项目级文件回退到 profile 配置，交付照常 (regression)', async () => {
    const cwd = tempWorkspace('evidence-gate-broken-')
    writeProjectConfig(cwd, '{ not json')
    const { fake, store } = rig({ cwd, logFile: path.join(cwd, 'evidence-gate.log') })
    assert.equal(fake.tools.size, 3, 'a broken file must not stop the plugin')

    const missionId = seedMission(store, cwd)
    const status = runText(await fake.runTool('evidence_status', { missionId }))
    assert.match(status, /配置来源：profile/)
    assert.match(status, /另有 1 条配置问题/)
    assert.match(status, /必填证据类型（config.requiredEvidenceKinds）: command, test/)
    assert.match(status, /requireCleanTree=true/)

    await recordProof(fake, missionId)
    await sleep(5)
    recordGate(store, missionId)
    const delivered = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(delivered, /✅ mission M-1 已交付/)
    assert.equal(store.read(missionId)?.status, 'delivered')
})

test('类型不对的可覆盖键回退到 profile 值，并逐条记录问题 (regression)', async () => {
    const cwd = tempWorkspace('evidence-gate-typed-')
    writeProjectConfig(cwd, {
        requireGate: 'yes',
        requireCleanTree: 1,
        gateSource: '',
        maxGateAgeMinutes: -5,
        maxOutputTail: 0,
        requiredEvidenceKinds: ['command', 'test', 7],
    })
    const { fake, store } = rig({ cwd, logFile: path.join(cwd, 'evidence-gate.log') })
    const missionId = seedMission(store, cwd)
    const status = runText(await fake.runTool('evidence_status', { missionId }))
    // Nothing valid was applied, so the profile configuration is in force…
    assert.match(status, /配置来源：profile/)
    assert.match(status, /必填证据类型（config.requiredEvidenceKinds）: command, test/)
    assert.match(status, /requireGate=true/)
    assert.match(status, /requireCleanTree=true/)
    assert.match(status, /maxGateAgeMinutes=0/)
    // …and every single bad value was reported instead of guessed.
    assert.match(status, /另有 6 条配置问题/)
})

test('evidence_status 显示配置来源与生效值（项目级 / profile） (regression)', async () => {
    const cwdA = tempWorkspace('evidence-gate-status-a-')
    const cwdB = tempWorkspace('evidence-gate-status-b-')
    const fileA = writeProjectConfig(cwdA, {
        requiredEvidenceKinds: ['artifact', 'gate', 'vibes'],
        requireCleanTree: false,
        maxGateAgeMinutes: 30,
        maxOutputTail: 12,
        nope: 1,
    })
    const { fake } = rig({ cwd: cwdA, logFile: path.join(cwdA, 'evidence-gate.log') })
    const storeA = new MissionStoreRegistry().for(cwdA)
    const storeB = new MissionStoreRegistry().for(cwdB)
    const agentB = fakeAgent(cwdB, 'agent-b')
    const missionA = seedMission(storeA, cwdA, { id: 'M-A' })
    const missionB = seedMission(storeB, cwdB, { id: 'M-B' })

    const statusA = runText(await fake.runTool('evidence_status', { missionId: missionA }))
    assert.ok(statusA.includes(`配置来源：项目级 ${fileA}`), statusA)
    assert.match(statusA, /必填证据类型（config.requiredEvidenceKinds）: artifact/)
    assert.match(statusA, /requireGate=true/)
    assert.match(statusA, /requireCleanTree=false/)
    assert.match(statusA, /maxGateAgeMinutes=30/)
    // `'gate'` and the unknown name were dropped, the unknown key refused:
    // three problems, each logged, none silently honoured.
    assert.match(statusA, /另有 3 条配置问题/)

    // `evidence_record` reads the same effective config: the project's
    // `maxOutputTail: 12` bounds the stored output of THIS workspace.
    const output = `${'x'.repeat(200)}END`
    const recorded = await fake.runTool('evidence_record', {
        missionId: missionA,
        kind: 'command',
        summary: '长输出',
        command: 'pnpm test',
        exitCode: 0,
        output,
    })
    assert.equal(recorded.isError, false, runText(recorded))
    const row = storeA.readEvidence(missionA)[0]
    assert.equal(row?.outputTail?.endsWith(output.slice(-12)), true)
    assert.match(row?.outputTail ?? '', /chars dropped/)

    const statusB = runText(await fake.runTool('evidence_status', { missionId: missionB }, { agent: agentB }))
    assert.match(statusB, /配置来源：profile/)
    assert.match(statusB, /必填证据类型（config.requiredEvidenceKinds）: command, test/)
    assert.match(statusB, /requireGate=true/)
    assert.match(statusB, /requireCleanTree=true/)
    assert.match(statusB, /maxGateAgeMinutes=0/)
    assert.doesNotMatch(statusB, /配置问题/)
})

// --- per-workspace prompt section + declared-workspace enforcement ----------

test('提示词章节按“本次装配的调用会话”解析生效配置：同一注册、不同 cwd 得到不同文本 (regression)', () => {
    // Gap: the section used to be baked from the profile config once at apply
    // time, so a workspace whose `.dsh/evidence-gate.json` demands `artifact`
    // was still told `command`+`test` on every turn.
    const cwdA = tempWorkspace('evidence-gate-prompt-a-')
    const cwdB = tempWorkspace('evidence-gate-prompt-b-')
    writeProjectConfig(cwdA, { requiredEvidenceKinds: ['artifact'], requireCleanTree: false, gateSource: 'repo-gate' })
    const { fake } = rig({ cwd: cwdA, logFile: path.join(cwdA, 'evidence-gate.log') })

    const section = fake.sections.find((entry) => entry.name === 'eng:evidence-gate')
    assert.ok(section !== undefined, 'the section must be registered')
    assert.equal(typeof section.text, 'function')
    /** Exactly what the harness does for one assembly: `{ scope: <agent> }`. */
    const assembleFor = (agent: unknown): string => (section.text as (context: unknown) => string)({ scope: agent })

    // One registration, two calling agents: each assembly states ITS workspace.
    const textA = assembleFor(fakeAgent(cwdA, 'agent-a'))
    const textB = assembleFor(fakeAgent(cwdB, 'agent-b'))
    assert.notEqual(textA, textB)
    assert.match(textA, /必填证据类型：artifact——/)
    assert.match(textA, /来源：本工作区的项目级配置/)
    assert.match(textA, /门禁：来源 repo-gate/)
    assert.match(textA, /requireCleanTree=false——交付前不核对工作区指纹/)
    assert.doesNotMatch(textA, /必填证据类型：command、test/)

    assert.match(textB, /必填证据类型：command、test——/)
    assert.match(textB, /本工作区没有生效的项目级配置，取值即 profile 默认/)
    assert.match(textB, /门禁：来源 dsh-quality-gate/)
    assert.match(textB, /requireCleanTree=true/)
    assert.match(textB, /profile 只是默认值\/上限/)
    assert.doesNotMatch(textB, /artifact/)

    // No declared workspace (and no assembly context at all) never throws: the
    // profile values are rendered, and nothing pretends to know the workspace.
    const profileText = assembleFor(undefined)
    assert.match(profileText, /本会话未声明工作区（session\.header\.cwd 缺失）/)
    assert.match(profileText, /必填证据类型：command、test——/)
    assert.equal(fake.sectionText('eng:evidence-gate'), profileText)

    // The effective config is re-read per assembly: a workspace edit shows up
    // on the next turn without re-registering the section.
    writeProjectConfig(cwdA, { requiredEvidenceKinds: ['test'], requireCleanTree: true })
    const reAssembled = assembleFor(fakeAgent(cwdA, 'agent-a'))
    assert.match(reAssembled, /必填证据类型：test——/)
    assert.match(reAssembled, /requireCleanTree=true/)
    assert.notEqual(reAssembled, textA)
})

test('未声明 header.cwd 时三个工具都拒绝执行，且不往宿主目录写任何工件 (regression)', async () => {
    // Gap: with no declared workspace the tools fell back to `process.cwd()` —
    // the harness's OWN directory — and would then record evidence, report a
    // checklist and issue receipts for a DIFFERENT project. `process.chdir`
    // makes the assertion meaningful: anything new under this directory is the
    // old bug.
    const harnessCwd = tempWorkspace('evidence-gate-harness-cwd-')
    const ws = tempWorkspace('evidence-gate-undeclared-')
    const previous = process.cwd()
    process.chdir(harnessCwd)
    try {
        // A session that declared no `cwd` — but does carry its session id.
        const agent = { id: 'agent-undeclared', session: { id: SESSION, header: { id: SESSION } } }
        const fake = createFakeHost({ cwd: ws, agent: agent as never })
        apply(fake.ctx as never, { logFile: path.join(ws, 'evidence-gate.log') })

        const before = listFiles(harnessCwd)
        const guessed = [
            await fake.runTool('evidence_record', {
                kind: 'command',
                summary: '未声明工作区的证据',
                command: 'pnpm test',
                exitCode: 0,
                output: 'ok',
            }),
            await fake.runTool('evidence_status', {}),
            await fake.runTool('mission_complete', {}),
        ]
        for (const run of guessed) {
            assert.equal(run.isError, true, `${run.name} 必须拒绝执行（不能猜工作区）`)
            assert.match(String(run.content), /无法确定本会话的工作区/)
            assert.match(String(run.content), /header\.cwd 缺失/)
            assert.match(String(run.content), /拒绝执行/)
        }
        assert.deepEqual(listFiles(harnessCwd), before, '宿主目录里不得新增任何文件')
        assert.equal(fs.existsSync(path.join(harnessCwd, '.dsh')), false, '宿主目录里不得出现 .dsh/')

        // Even a mission sitting IN the harness's own directory — bound to this
        // very session — is never touched. The old fallback resolved against
        // it and appended evidence / opened a receipt there; an explicit
        // `missionId` does not stand in for a workspace either.
        const harnessStore = new MissionStoreRegistry().for(harnessCwd)
        const decoy = seedMission(harnessStore, harnessCwd, { id: 'M-DECOY' })
        const seeded = listFiles(harnessCwd)
        const explicit = [
            await fake.runTool('evidence_record', {
                missionId: decoy,
                kind: 'command',
                summary: '显式 missionId 也不行',
                command: 'pnpm test',
                exitCode: 0,
                output: 'ok',
            }),
            await fake.runTool('evidence_status', { missionId: decoy }),
            await fake.runTool('mission_complete', { missionId: decoy }),
        ]
        for (const run of explicit) {
            assert.equal(run.isError, true, `${run.name} 显式 missionId 也必须拒绝`)
            assert.match(String(run.content), /无法确定本会话的工作区/)
        }
        assert.deepEqual(listFiles(harnessCwd), seeded, '显式 missionId 也不得往宿主目录写证据/回执')
        assert.equal(harnessStore.readEvidence(decoy).length, 0)
        assert.equal(harnessStore.readReceipts(decoy).length, 0)
        assert.equal(fs.existsSync(receiptDir(harnessCwd, decoy)), false)
        assert.equal(harnessStore.read(decoy)?.status, 'spec-approved')
    } finally {
        process.chdir(previous)
    }
})

test('an adopted standards gate must pass for this round of the code (regression)', async () => {
    // Opt-in: the check exists only when the host requires it, and it is a
    // SEPARATE axis from the quality gate — structural debt does not fail a build.
    const cwd = tempWorkspace('evidence-standards-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'evidence-gate.log'), approval: 'auto', requireStandardsGate: true })
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title: '规范门禁', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id, 'implement')
    const recorded = await fake.runTool('evidence_record', {
        kind: 'test',
        summary: '跑测试',
        command: 'node --test test/*.test.ts',
        exitCode: 0,
        output: 'ok',
    })
    assert.equal(recorded.isError, false, runText(recorded))

    // No standards record at all → delivery is refused with the exact fix.
    // (A refusal is a REPORT here, not an isError: the mission state is left
    // untouched and the report lists which checks failed.)
    const missing = await fake.runTool('mission_complete', {})
    const missingText = runText(missing)
    assert.match(missingText, /不能交付/)
    assert.match(missingText, /❌ 规范门禁/)
    assert.match(missingText, /standards_check/)
    assert.equal(store.read(mission.id)?.status !== 'delivered', true, 'no receipt was issued')

    // A PASS recorded BEFORE the newest evidence proves nothing about this code.
    store.recordGate(mission.id, { source: 'dsh-standards-gate', state: 'PASS', reason: '上一轮', results: [] })
    const gatesDir = path.join(cwd, '.dsh', 'missions', mission.id, 'gates')
    for (const name of fs.readdirSync(gatesDir)) {
        const file = path.join(gatesDir, name)
        const record = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (record.source === 'dsh-standards-gate') {
            record.checkedAt = Date.now() - 600_000
            fs.writeFileSync(file, JSON.stringify(record))
        }
    }
    const stale = await fake.runTool('mission_complete', {})
    assert.match(runText(stale), /❌ 规范门禁/)
    assert.match(runText(stale), /早于最新证据/)

    // A fresh PASS lets the (other) checks decide again. The millisecond gap is
    // deliberate: a gate recorded in the SAME millisecond as the evidence is
    // treated as stale (fail closed), exactly like the quality gate's own rule.
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.recordGate(mission.id, { source: 'dsh-standards-gate', state: 'PASS', reason: '本轮无新增违规', results: [] })
    const after = await fake.runTool('mission_complete', {})
    const text = runText(after)
    assert.doesNotMatch(text, /早于最新证据/)
    assert.doesNotMatch(text, /没有任何来自 dsh-standards-gate 的门禁记录/)
    // The report lists only the FAILING checks, so a satisfied standards axis is
    // exactly "no ❌ 规范门禁 line" (the other axes still fail in this fixture).
    assert.doesNotMatch(text, /❌ 规范门禁/)
})

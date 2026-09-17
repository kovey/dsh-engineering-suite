/**
 * dsh-test-design-gate tests: the assembly surface, the passing review path
 * with its artifacts and evidence, every failing check (fail closed), strict
 * mode, and the fact that the review is re-runnable after fixing the spec.
 *
 * The `(regression)` tests cover the two-layer configuration model: one dsh
 * process serves several workspaces, so the review policy and the prompt
 * section must be resolved per calling workspace, and a session that declares
 * no workspace is refused instead of silently using the harness's own cwd.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStore,
    renderSpecMarkdown,
    resolveLayout,
    sha256,
    type MissionRecord,
    type SpecRecord,
    type TestCase,
} from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'

const SESSION_ID = 'session-1'

/** A project-level configuration file, as a human would commit it. */
const PROJECT_CONFIG = '.dsh/test-design-gate.json'

interface CaseDraft {
    id: string
    kind: TestCase['kind']
    steps?: string
    expected?: string
    precondition?: string
    covers?: string[]
}

interface SpecOptions {
    title?: string
    criteria?: string[]
    cases?: CaseDraft[]
    /** Custom layout root (mirrors `config.layout.rootDir`). */
    rootDir?: string
    /** Session the mission is bound to (defaults to {@link SESSION_ID}). */
    sessionId?: string
}

function toCases(drafts: readonly CaseDraft[]): TestCase[] {
    return drafts.map((draft) => ({
        id: draft.id,
        kind: draft.kind,
        precondition: draft.precondition ?? `已准备 ${draft.id} 的前置条件`,
        steps: draft.steps ?? `执行 ${draft.id} 的操作步骤`,
        expected: draft.expected ?? `观察到 ${draft.id} 的预期结果`,
        covers: draft.covers ?? [],
    }))
}

function storeFor(cwd: string, rootDir?: string): MissionStore {
    return new MissionStore({ layout: resolveLayout(cwd, rootDir === undefined ? {} : { rootDir }) })
}

/** Write a real specification artifact (the disk is the gate's source of truth). */
function writeSpec(cwd: string, options: SpecOptions = {}): { missionId: string; markdown: string } {
    const store = storeFor(cwd, options.rootDir)
    const sessionId = options.sessionId ?? SESSION_ID
    const mission = store.create({ title: options.title ?? 'Test design gate mission', cwd, sessionId })
    store.bindSession(sessionId, mission.id)
    const now = Date.now()
    const criterialTexts = options.criteria ?? ['第一个行为可验收', '第二个行为可验收', '第三个行为可验收']
    const spec: SpecRecord = {
        title: mission.title,
        background: '测试设计门禁的测试用规格',
        requirements: ['实现可验收的行为'],
        acceptanceCriteria: criterialTexts.map((text, index) => ({
            id: `AC-${String(index + 1).padStart(3, '0')}`,
            text,
        })),
        fileBoundaries: ['src/demo.ts'],
        negativeConstraints: ['不得修改 dsh 核心代码'],
        revision: 1,
        createdAt: now,
        updatedAt: now,
    }
    const updated = store.update(mission.id, () => ({
        spec,
        testDesign: { cases: toCases(options.cases ?? []), covered: [], uncovered: [] },
    }))
    if (updated === undefined) throw new Error(`mission ${mission.id} disappeared`)
    const markdown = renderSpecMarkdown(updated)
    store.writeSpec(mission.id, markdown)
    return { missionId: mission.id, markdown }
}

/** Replace the design of an existing specification (the "fix and re-run" path). */
function rewriteSpec(cwd: string, missionId: string, drafts: readonly CaseDraft[]): void {
    const store = storeFor(cwd)
    const updated = store.update(missionId, () => ({
        testDesign: { cases: toCases(drafts), covered: [], uncovered: [] },
    }))
    if (updated === undefined) throw new Error(`mission ${missionId} disappeared`)
    store.writeSpec(missionId, renderSpecMarkdown(updated))
}

const GREEN_CASES: CaseDraft[] = [
    { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
    { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
    { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
]

function host(options: { cwd?: string; config?: Record<string, unknown> } = {}): FakeHost {
    const cwd = options.cwd ?? tempWorkspace('test-design-gate-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'test-design-gate.log'), ...options.config })
    return fake
}

function missionRecord(cwd: string, missionId: string): MissionRecord {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'missions', missionId, 'mission.json'), 'utf8')) as MissionRecord
}

function evidenceRows(cwd: string, missionId: string): { kind: string; artifactPath?: string; outputDigest?: string; summary: string; recordedBy: string }[] {
    const file = path.join(cwd, '.dsh', 'missions', missionId, 'evidence.jsonl')
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
}

function artifact(cwd: string, missionId: string, relative: string): string {
    return fs.readFileSync(path.join(cwd, '.dsh', 'missions', missionId, relative), 'utf8')
}

function lastLine(report: string): string {
    const lines = report.trimEnd().split('\n')
    return lines[lines.length - 1] ?? ''
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-test-design-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers both tools and the prompt section, and dispose leaves nothing behind', () => {
    const fake = host()
    assert.deepEqual([...fake.tools.keys()].sort(), ['test_design_review', 'test_design_template'])
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:test-design-gate'],
    )
    assert.equal(fake.sections[0]?.order, 630)
    const text = fake.sectionText('eng:test-design-gate')
    assert.match(text, /测试设计门禁/)
    assert.match(text, /正向场景/)
    assert.match(text, /异常场景/)
    assert.match(text, /边界场景/)
    assert.match(text, /spec_approve/)

    fake.dispose()
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.sections.length, 0)
    assert.equal(fake.effects.length, 0)
})

test('prompt.enabled=false drops the prompt section', () => {
    const fake = host({ config: { prompt: { enabled: false } } })
    assert.deepEqual(fake.sections, [])
    assert.equal(fake.sectionText('eng:test-design-gate'), '')
    // The tools still work without the prompt contribution.
    assert.deepEqual([...fake.tools.keys()].sort(), ['test_design_review', 'test_design_template'])
})

test('a complete design passes: ✅ report, mission verdict, both artifacts and one evidence row', async () => {
    const cwd = tempWorkspace('test-design-gate-pass-')
    const fake = host({ cwd })
    const { missionId, markdown } = writeSpec(cwd, { cases: GREEN_CASES })

    const run = await fake.runTool('test_design_review', {})
    assert.equal(run.isError, false, runText(run))
    const report = runText(run)
    assert.ok(report.startsWith('✅ 测试设计评审通过'), report)
    assert.match(lastLine(report), /^下一步：/)
    assert.match(lastLine(report), /spec_approve/)

    const mission = missionRecord(cwd, missionId)
    assert.equal(mission.testDesign?.passed, true)
    assert.deepEqual(mission.testDesign?.findings, [])
    assert.deepEqual(mission.testDesign?.uncovered, [])
    assert.deepEqual(mission.testDesign?.covered, ['AC-001', 'AC-002', 'AC-003'])
    assert.equal(typeof mission.testDesign?.reviewedAt, 'number')

    const json = JSON.parse(artifact(cwd, missionId, 'test-design-review.json')) as Record<string, unknown>
    assert.equal(json['missionId'], missionId)
    assert.equal(json['passed'], true)
    assert.deepEqual(json['findings'], [])
    assert.deepEqual(json['uncovered'], [])
    assert.equal(json['specDigest'], sha256(markdown))
    assert.equal((json['cases'] as unknown[]).length, 3)

    const md = artifact(cwd, missionId, 'test-design-review.md')
    assert.match(md, /测试设计评审报告/)
    assert.match(md, /TC-002/)
    assert.match(md, /✅ 通过/)

    const rows = evidenceRows(cwd, missionId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'artifact')
    assert.equal(rows[0]?.recordedBy, 'dsh-test-design-gate')
    assert.equal(rows[0]?.artifactPath, 'test-design-review.json')
    assert.equal(rows[0]?.outputDigest, sha256(artifact(cwd, missionId, 'test-design-review.json')))
    assert.match(rows[0]?.summary ?? '', /测试设计评审通过：3 条用例覆盖 3 条验收标准/)
})

test('an uncovered acceptance criterion fails the review', async () => {
    const cwd = tempWorkspace('test-design-gate-uncovered-')
    const fake = host({ cwd })
    const { missionId } = writeSpec(cwd, {
        cases: [
            { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
            { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
            { id: 'TC-003', kind: 'boundary', covers: ['AC-001'] },
        ],
    })
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.equal(run.isError, false, 'a failed review is data, not a tool error')
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /AC-003 没有任何测试用例覆盖/)
    assert.equal(missionRecord(cwd, missionId).testDesign?.passed, false)
    assert.equal(evidenceRows(cwd, missionId).length, 0)
    assert.match(lastLine(report), /spec_create/)
    assert.match(lastLine(report), /test_design_review/)
})

test('a missing 异常场景 class fails the review', async () => {
    const cwd = tempWorkspace('test-design-gate-scenarios-')
    const fake = host({ cwd })
    const { missionId } = writeSpec(cwd, {
        cases: [
            { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
            { id: 'TC-002', kind: 'positive', covers: ['AC-002'] },
            { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
        ],
    })
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /缺少「异常场景」用例/)
    assert.match(report, /### 异常场景/)
    const mission = missionRecord(cwd, missionId)
    assert.equal(mission.testDesign?.passed, false)
    assert.equal(mission.testDesign?.findings?.length, 1)
})

test('placeholder 操作步骤 fails the review', async () => {
    const cwd = tempWorkspace('test-design-gate-placeholder-')
    const fake = host({ cwd })
    const { missionId } = writeSpec(cwd, {
        cases: [
            { id: 'TC-001', kind: 'positive', steps: '...', covers: ['AC-001'] },
            { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
            { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
        ],
    })
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /TC-001 的「操作步骤」是占位符/)
    assert.equal(missionRecord(cwd, missionId).testDesign?.passed, false)
})

test('duplicate case ids fail the review', async () => {
    const cwd = tempWorkspace('test-design-gate-duplicate-')
    const fake = host({ cwd })
    const { missionId } = writeSpec(cwd, {
        cases: [
            { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
            { id: 'TC-001', kind: 'negative', covers: ['AC-002'] },
            { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
        ],
    })
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /TC-001 与 TC-001 重复/)
    const mission = missionRecord(cwd, missionId)
    assert.equal(mission.testDesign?.passed, false)
    assert.equal(mission.testDesign?.findings?.length, 1)
})

test('a case covering an unknown criterion fails the review', async () => {
    const cwd = tempWorkspace('test-design-gate-unknown-')
    const fake = host({ cwd })
    const { missionId } = writeSpec(cwd, {
        cases: [...GREEN_CASES, { id: 'TC-004', kind: 'positive', covers: ['AC-099'] }],
    })
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /TC-004 覆盖了不存在的验收标准 AC-099/)
    const mission = missionRecord(cwd, missionId)
    assert.equal(mission.testDesign?.passed, false)
    assert.equal(mission.testDesign?.findings?.length, 1)
})

test('a case with no covers is dangling unless allowDanglingCase is on', async () => {
    const cases: CaseDraft[] = [...GREEN_CASES, { id: 'TC-004', kind: 'positive', covers: [] }]

    const strictCwd = tempWorkspace('test-design-gate-dangling-')
    const strictHost = host({ cwd: strictCwd })
    const strictSpec = writeSpec(strictCwd, { cases })
    const failed = await strictHost.runTool('test_design_review', {})
    assert.match(runText(failed), /TC-004 没有声明覆盖的验收标准/)
    assert.equal(missionRecord(strictCwd, strictSpec.missionId).testDesign?.passed, false)

    const laxCwd = tempWorkspace('test-design-gate-dangling-ok-')
    const laxHost = host({ cwd: laxCwd, config: { allowDanglingCase: true } })
    const laxSpec = writeSpec(laxCwd, { cases })
    const passed = await laxHost.runTool('test_design_review', {})
    assert.ok(runText(passed).startsWith('✅ 测试设计评审通过'), runText(passed))
    assert.equal(missionRecord(laxCwd, laxSpec.missionId).testDesign?.passed, true)
})

test('minTextLength rejects a too-short step and accepts it when lowered', async () => {
    const cases: CaseDraft[] = [
        { id: 'TC-001', kind: 'positive', steps: 'abc', covers: ['AC-001'] },
        { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
        { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
    ]
    const cwd = tempWorkspace('test-design-gate-minlen-')
    const strict = host({ cwd })
    const spec = writeSpec(cwd, { cases })
    const run = await strict.runTool('test_design_review', {})
    assert.match(runText(run), /TC-001 的「操作步骤」只有 3 个字符/)
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, false)

    const laxCwd = tempWorkspace('test-design-gate-minlen-ok-')
    const lax = host({ cwd: laxCwd, config: { minTextLength: 2 } })
    const laxSpec = writeSpec(laxCwd, { cases })
    const laxRun = await lax.runTool('test_design_review', {})
    assert.ok(runText(laxRun).startsWith('✅ 测试设计评审通过'), runText(laxRun))
    assert.equal(missionRecord(laxCwd, laxSpec.missionId).testDesign?.passed, true)
})

test('strict mode requires a negative or boundary case per criterion', async () => {
    const positiveOnly: CaseDraft[] = [
        { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
        { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
        { id: 'TC-003', kind: 'boundary', covers: ['AC-002'] },
    ]
    const cwd = tempWorkspace('test-design-gate-strict-')
    const fake = host({ cwd })
    const spec = writeSpec(cwd, { criteria: ['行为一可验收', '行为二可验收'], cases: positiveOnly })

    // Default (strict=false): a positive-only criterion is acceptable.
    const lax = await fake.runTool('test_design_review', {})
    assert.ok(runText(lax).startsWith('✅ 测试设计评审通过'), runText(lax))
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, true)

    // strict=true rejects it...
    const strictRun = await fake.runTool('test_design_review', { strict: true })
    const report = runText(strictRun)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /严格模式（strict）：验收标准 AC-001 只有正向用例覆盖/)
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, false)

    // ...and a design where every criterion has a non-positive case passes strict.
    rewriteSpec(cwd, spec.missionId, [
        { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
        { id: 'TC-002', kind: 'negative', covers: ['AC-001'] },
        { id: 'TC-003', kind: 'boundary', covers: ['AC-002'] },
    ])
    const fixed = await fake.runTool('test_design_review', { strict: true })
    assert.ok(runText(fixed).startsWith('✅ 测试设计评审通过'), runText(fixed))
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, true)
})

test('config.strict=true makes strictness the default', async () => {
    const cwd = tempWorkspace('test-design-gate-strict-config-')
    const fake = host({ cwd, config: { strict: true } })
    const spec = writeSpec(cwd, {
        criteria: ['行为一可验收', '行为二可验收'],
        cases: [
            { id: 'TC-001', kind: 'positive', covers: ['AC-001'] },
            { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
            { id: 'TC-003', kind: 'boundary', covers: ['AC-002'] },
        ],
    })
    const run = await fake.runTool('test_design_review', {})
    assert.match(runText(run), /严格模式（strict）/)
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, false)
    assert.match(fake.sectionText('eng:test-design-gate'), /strict=true/)
})

test('the review is re-runnable: fixing the specification flips the verdict to pass', async () => {
    const cwd = tempWorkspace('test-design-gate-rerun-')
    const fake = host({ cwd })
    const spec = writeSpec(cwd, {
        cases: [
            { id: 'TC-001', kind: 'positive', steps: '...', covers: ['AC-001'] },
            { id: 'TC-002', kind: 'positive', covers: ['AC-002'] },
        ],
    })

    const first = await fake.runTool('test_design_review', {})
    assert.ok(runText(first).startsWith('❌ 测试设计评审未通过'), runText(first))
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, false)

    // Fix the artifact on disk (the source of truth) and re-run.
    rewriteSpec(cwd, spec.missionId, GREEN_CASES)
    const second = await fake.runTool('test_design_review', {})
    assert.ok(runText(second).startsWith('✅ 测试设计评审通过'), runText(second))
    const mission = missionRecord(cwd, spec.missionId)
    assert.equal(mission.testDesign?.passed, true)
    assert.deepEqual(mission.testDesign?.findings, [])
    assert.equal(evidenceRows(cwd, spec.missionId).length, 1)
    assert.match(artifact(cwd, spec.missionId, 'test-design-review.md'), /✅ 通过/)
})

test('an empty specification artifact fails closed with an actionable finding', async () => {
    const cwd = tempWorkspace('test-design-gate-empty-')
    const fake = host({ cwd })
    const spec = writeSpec(cwd, { cases: GREEN_CASES })
    fs.writeFileSync(path.join(cwd, '.dsh', 'specs', `${spec.missionId}.md`), '')
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('❌ 测试设计评审未通过'), report)
    assert.match(report, /规格工件为空或不存在/)
    assert.match(report, /spec_create/)
    assert.equal(missionRecord(cwd, spec.missionId).testDesign?.passed, false)
})

test('test_design_review without a mission tells the model to call spec_create first', async () => {
    const cwd = tempWorkspace('test-design-gate-nomission-')
    const fake = host({ cwd })
    const run = await fake.runTool('test_design_review', {})
    assert.equal(run.isError, true)
    assert.match(String(run.content), /spec_create/)
    assert.match(String(run.content), /test_design_review/)
})

test('test_design_review honours an explicit missionId', async () => {
    const cwd = tempWorkspace('test-design-gate-explicit-')
    const fake = host({ cwd })
    const first = writeSpec(cwd, { title: 'First mission', cases: [{ id: 'TC-001', kind: 'positive', steps: '...', covers: ['AC-001'] }] })
    const second = writeSpec(cwd, { title: 'Second mission', cases: GREEN_CASES, criteria: ['一', '二', '三'] })
    assert.notEqual(first.missionId, second.missionId)

    const run = await fake.runTool('test_design_review', { missionId: first.missionId })
    assert.match(runText(run), new RegExp(first.missionId))
    assert.equal(missionRecord(cwd, first.missionId).testDesign?.passed, false)
    assert.equal(missionRecord(cwd, second.missionId).testDesign?.passed, undefined)
})

test('test_design_template returns the canonical table shape plus an example row per class', async () => {
    const fake = host()
    const run = await fake.runTool('test_design_template', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /## 验收标准/)
    assert.match(text, /\| 用例ID \| 前置条件 \| 操作步骤 \| 预期结果 \| 覆盖验收标准 \|/)
    assert.match(text, /### 正向场景/)
    assert.match(text, /### 异常场景/)
    assert.match(text, /### 边界场景/)
    assert.match(text, /\| TC-001 \|/)
    assert.match(text, /\| TC-002 \|/)
    assert.match(text, /\| TC-003 \|/)
})

test('a disabled gate registers nothing', () => {
    const fake = host({ config: { enabled: false } })
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.sections.length, 0)
})

test('config.layout.rootDir moves the artifacts out of the default .dsh root', async () => {
    const cwd = tempWorkspace('test-design-gate-layout-')
    const fake = host({ cwd, config: { layout: { rootDir: 'eng' } } })
    const spec = writeSpec(cwd, { rootDir: 'eng', cases: GREEN_CASES })

    const run = await fake.runTool('test_design_review', {})
    assert.ok(runText(run).startsWith('✅ 测试设计评审通过'), runText(run))

    const missionDir = path.join(cwd, 'eng', 'missions', spec.missionId)
    assert.equal(fs.existsSync(path.join(missionDir, 'test-design-review.json')), true)
    assert.equal(fs.existsSync(path.join(missionDir, 'test-design-review.md')), true)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false)
    const mission = JSON.parse(fs.readFileSync(path.join(missionDir, 'mission.json'), 'utf8')) as MissionRecord
    assert.equal(mission.testDesign?.passed, true)
})

test('a failing tool registration does not break assembly', async () => {
    const cwd = tempWorkspace('test-design-gate-dup-')
    const fake = createFakeHost({ cwd })
    // A sibling mount already owns the tool names: both registrations fail.
    for (const toolName of ['test_design_review', 'test_design_template']) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'stub' })
    }
    assert.doesNotThrow(() => apply(fake.ctx as never, { logFile: path.join(cwd, 'test-design-gate.log') }))
    // The host is intact: the pre-existing tools still answer, the section is in.
    assert.equal(runText(await fake.runTool('test_design_review', {})), 'stub')
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:test-design-gate'],
    )
})

// --- project-level configuration (.dsh/test-design-gate.json) ---------------

/** A design whose first step is deliberately short (6 characters). */
const SHORT_STEP_CASES: CaseDraft[] = [
    { id: 'TC-001', kind: 'positive', steps: 'abcdef', covers: ['AC-001'] },
    { id: 'TC-002', kind: 'negative', covers: ['AC-002'] },
    { id: 'TC-003', kind: 'boundary', covers: ['AC-003'] },
]

/** Write `<workspace>/.dsh/test-design-gate.json` (raw text or an object). */
function writeProjectConfig(cwd: string, content: string | Record<string, unknown>): string {
    const file = path.join(cwd, PROJECT_CONFIG)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, undefined, 2)}\n`)
    return file
}

test('one host, two workspaces: a project-level minTextLength only tightens its own repo (regression)', async () => {
    const cwdA = tempWorkspace('test-design-gate-proj-a-')
    const cwdB = tempWorkspace('test-design-gate-proj-b-')
    const fake = host({ cwd: cwdA })
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')
    const specA = writeSpec(cwdA, { cases: SHORT_STEP_CASES, sessionId: 'session-a' })
    const specB = writeSpec(cwdB, { cases: SHORT_STEP_CASES, sessionId: 'session-b' })
    const fileA = writeProjectConfig(cwdA, { minTextLength: 20 })

    const a = await fake.runTool('test_design_review', {}, { agent: agentA })
    const b = await fake.runTool('test_design_review', {}, { agent: agentB })

    // A: the project file raised the bar, so the same design now fails there.
    const reportA = runText(a)
    assert.ok(reportA.startsWith('❌ 测试设计评审未通过'), reportA)
    assert.match(reportA, /TC-001 的「操作步骤」只有 6 个字符（至少 20 个）/)
    assert.ok(reportA.includes(`配置：项目级 ${fileA}（minTextLength=20`), reportA)
    assert.equal(missionRecord(cwdA, specA.missionId).testDesign?.passed, false)

    // B: no project file — the profile default (4) still applies to the SAME design.
    const reportB = runText(b)
    assert.ok(reportB.startsWith('✅ 测试设计评审通过'), reportB)
    assert.ok(reportB.includes('配置：profile（minTextLength=4'), reportB)
    assert.equal(missionRecord(cwdB, specB.missionId).testDesign?.passed, true)

    // Provenance is honest in the artifacts too: A names its file and the value
    // that decided the verdict, B admits it used the profile.
    const mdA = artifact(cwdA, specA.missionId, 'test-design-review.md')
    assert.ok(mdA.includes(fileA), mdA)
    assert.match(mdA, /minTextLength=20/)
    assert.match(artifact(cwdB, specB.missionId, 'test-design-review.md'), /生效评审策略: profile（minTextLength=4/)

    // Both reviews really ran, each in its own workspace.
    assert.equal(fs.existsSync(path.join(cwdA, '.dsh', 'missions', specA.missionId, 'test-design-review.json')), true)
    assert.equal(fs.existsSync(path.join(cwdB, '.dsh', 'missions', specB.missionId, 'test-design-review.json')), true)
    assert.equal(resolveEffectiveConfig(resolveConfig({}), resolveLayout(cwdA)).source, 'project')
    assert.equal(resolveEffectiveConfig(resolveConfig({}), resolveLayout(cwdB)).source, 'profile')
})

test('host-only keys are refused with a reason, so provenance stays profile (regression)', async () => {
    const cwd = tempWorkspace('test-design-gate-hostonly-')
    const fake = host({ cwd })
    const spec = writeSpec(cwd, { cases: GREEN_CASES })
    writeProjectConfig(cwd, { enabled: false, logFile: '/tmp/elsewhere.log', specsDir: 'elsewhere', prompt: { enabled: false } })

    const effective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(cwd))
    assert.equal(effective.source, 'profile', 'a file whose keys were all refused must not claim provenance')
    assert.equal(effective.config.enabled, true, 'a project file must not switch the gate off')
    assert.equal(effective.config.minTextLength, 4)
    assert.equal(effective.problems.length, 4)
    for (const key of ['enabled', 'logFile', 'specsDir', 'prompt']) {
        assert.ok(
            effective.problems.some((entry) => entry.includes(`"${key}"`)),
            `missing the problem for ${key}: ${effective.problems.join(' | ')}`,
        )
    }
    const problems = effective.problems.join('\n')
    assert.match(problems, /profile 是上限/)
    assert.match(problems, /不能把测试设计门禁关掉/)
    assert.match(problems, /已忽略/)

    // The review still runs, and artifacts still land under the profile's layout.
    const run = await fake.runTool('test_design_review', {})
    const report = runText(run)
    assert.ok(report.startsWith('✅ 测试设计评审通过'), report)
    assert.ok(report.includes('配置：profile（'), report)
    assert.match(report, /项目级配置问题 4 条/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', spec.missionId, 'test-design-review.json')), true)
    assert.equal(fs.existsSync(path.join(cwd, 'elsewhere')), false, 'specsDir must not be relocated by a project file')
})

test('a malformed project file falls back to the profile and the review still works (regression)', async () => {
    // 1. Broken JSON: the whole file is dropped with a problem.
    const brokenJson = tempWorkspace('test-design-gate-broken-json-')
    const brokenHost = host({ cwd: brokenJson })
    const brokenSpec = writeSpec(brokenJson, { cases: SHORT_STEP_CASES })
    writeProjectConfig(brokenJson, '{ "minTextLength": 20,, }')
    const brokenRun = await brokenHost.runTool('test_design_review', {})
    const brokenReport = runText(brokenRun)
    assert.ok(brokenReport.startsWith('✅ 测试设计评审通过'), brokenReport)
    assert.ok(brokenReport.includes('配置：profile（minTextLength=4'), brokenReport)
    assert.match(brokenReport, /项目级配置问题 1 条/)
    assert.equal(missionRecord(brokenJson, brokenSpec.missionId).testDesign?.passed, true)
    const brokenEffective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(brokenJson))
    assert.equal(brokenEffective.source, 'profile')
    assert.match(brokenEffective.problems[0] ?? '', /不是合法 JSON/)

    // 2. A top-level array is a shape error, not a configuration.
    const notObject = tempWorkspace('test-design-gate-not-object-')
    const arrayHost = host({ cwd: notObject })
    const arraySpec = writeSpec(notObject, { cases: SHORT_STEP_CASES })
    writeProjectConfig(notObject, '[1, 2, 3]')
    assert.ok(runText(await arrayHost.runTool('test_design_review', {})).startsWith('✅ 测试设计评审通过'))
    const arrayEffective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(notObject))
    assert.equal(arrayEffective.source, 'profile')
    assert.match(arrayEffective.problems[0] ?? '', /顶层必须是对象/)
    assert.equal(missionRecord(notObject, arraySpec.missionId).testDesign?.passed, true)

    // 3. A bad-typed value is refused per key and never coerced: "20" is not 20.
    const badType = tempWorkspace('test-design-gate-bad-type-')
    const typeHost = host({ cwd: badType })
    const typeSpec = writeSpec(badType, { cases: SHORT_STEP_CASES })
    writeProjectConfig(badType, { minTextLength: '20' })
    const typeRun = await typeHost.runTool('test_design_review', {})
    assert.ok(runText(typeRun).startsWith('✅ 测试设计评审通过'), runText(typeRun))
    assert.ok(runText(typeRun).includes('配置：profile（minTextLength=4'), runText(typeRun))
    const typeEffective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(badType))
    assert.equal(typeEffective.source, 'profile')
    assert.equal(typeEffective.config.minTextLength, 4)
    assert.match(typeEffective.problems[0] ?? '', /minTextLength 必须是 ≥ 1 的整数/)
    assert.equal(missionRecord(badType, typeSpec.missionId).testDesign?.passed, true)
})

test('the prompt section quotes the review policy of the assembling agent workspace (regression)', () => {
    const cwdA = tempWorkspace('test-design-gate-section-a-')
    const cwdB = tempWorkspace('test-design-gate-section-b-')
    const fake = host({ cwd: cwdA })
    writeProjectConfig(cwdA, { minTextLength: 20, strict: true, allowDanglingCase: true, requireAllScenarios: false })
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')

    const section = fake.sections.find((entry) => entry.name === 'eng:test-design-gate')
    assert.ok(section !== undefined && typeof section.text === 'function', 'the section must be registered')

    // One registration, two assemblies: each agent reads its own policy.
    const textA = section?.text?.({ scope: agentA }) ?? ''
    const textB = section?.text?.({ scope: agentB }) ?? ''
    assert.match(textA, /来源：项目级/)
    assert.match(textA, /minTextLength=20；strict=true；allowDanglingCase=true；requireAllScenarios=false/)
    assert.match(textB, /来源：profile/)
    assert.match(textB, /minTextLength=4；strict=false；allowDanglingCase=false；requireAllScenarios=true/)
    assert.notEqual(textA, textB)

    // The contract itself is always stated, whichever policy applies.
    for (const text of [textA, textB]) {
        assert.match(text, /测试设计门禁/)
        assert.match(text, /正向场景/)
        assert.match(text, /spec_approve/)
    }

    // An unknown workspace falls back to the profile text — and never throws.
    assert.match(section?.text?.({}) ?? '', /来源：profile/)
    assert.match(section?.text?.(undefined) ?? '', /minTextLength=4/)
    assert.doesNotThrow(() => section?.text?.({ scope: {} }))
    assert.match(section?.text?.({ scope: { session: { header: {} } } }) ?? '', /来源：profile/)
})

test('a session without header.cwd is refused instead of reviewed in process.cwd() (regression)', async () => {
    const cwd = tempWorkspace('test-design-gate-nocwd-')
    const fake = host({ cwd })
    const previous = process.cwd()
    try {
        // Make the harness' own directory the one a `process.cwd()` fallback
        // would have used: nothing here may be touched.
        process.chdir(cwd)
        const anonymous = { id: 'agent-nocwd', session: { id: 'session-nocwd', header: { id: 'session-nocwd' } } }
        const run = await fake.runTool('test_design_review', {}, { agent: anonymous })
        assert.equal(run.isError, true)
        const message = String(run.content)
        assert.equal(
            message,
            '无法确定本会话的工作区（session.header.cwd 缺失），为避免把评审写到错误的项目，本工具拒绝执行。下一步：在带 cwd 的会话里工作。',
        )
        assert.match(message, /工作区/)
        assert.match(message, /header\.cwd/)
        assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false, 'no .dsh may be created under the harness cwd')
        // The template reads no artifact, so a cwd-less session may still ask for the shape.
        assert.equal((await fake.runTool('test_design_template', {}, { agent: anonymous })).isError, false)
        // A session that does declare a workspace is unaffected.
        assert.equal(fake.tools.has('test_design_review'), true)
    } finally {
        process.chdir(previous)
    }
})

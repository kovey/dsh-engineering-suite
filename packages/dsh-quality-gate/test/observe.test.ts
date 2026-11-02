/**
 * Shadow mode (`observe`) of the quality gate, end to end.
 *
 * The fixed semantics under test:
 *  - an observe rule is still evaluated exactly once and its would-be verdict is
 *    recorded, but it does not contribute to the gate's own verdict;
 *  - an enforcing rule behaves exactly as before;
 *  - the record carries `observations` ordered by rule id, the report prints a
 *    dedicated shadow section with the switch-on next step, and no shadow
 *    verdict ever appears as an enforcing PASS/BLOCK.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, clearProjectConfigCache } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'
import { parseBudget } from '../dist/budget.js'

const OK = 'node -e "console.log(\'ok\')"'
const FAIL = 'node -e "console.error(\'boom\'); process.exit(2)"'

function host(cwd: string, config: Record<string, unknown>): FakeHost & { steers: unknown[] } {
    const fake = createFakeHost({ cwd })
    const steers: unknown[] = []
    ;(fake.agent as unknown as { steer: (message: unknown) => void }).steer = (message: unknown) => steers.push(message)
    const resolved = { ...config }
    if (typeof resolved['logFile'] === 'string' && !path.isAbsolute(resolved['logFile'])) {
        resolved['logFile'] = path.join(cwd, resolved['logFile'])
    }
    apply(fake.ctx as never, resolved)
    return Object.assign(fake, { steers })
}

function bindMission(cwd: string, title: string): { id: string; store: ReturnType<MissionStoreRegistry['for']> } {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    return { id: mission.id, store }
}

async function write(fake: FakeHost): Promise<unknown> {
    const exec = { name: 'write', agent: fake.agent, callId: 'call-1', arguments: { file_path: 'src/a.ts' } }
    return await fake.waterfall('tools/post-execute', [exec, { isError: false, content: [] }], () => ({ kind: 'accept' }))
}

function turnStopReal(fake: FakeHost, turn = 1): Promise<void> {
    return fake.waterfall('agent/turn-stopping', { agent: fake.agent, turn, signal: new AbortController().signal }, () => undefined)
}

/** The shadow section of a report (header + its indented lines). */
function shadowSection(text: string): string[] {
    const lines = text.split('\n')
    const start = lines.findIndex((line) => line.startsWith('影子（observe）：'))
    if (start < 0) return []
    const section: string[] = []
    for (const line of lines.slice(start)) {
        if (section.length > 0 && !line.startsWith('  ')) break
        section.push(line)
    }
    return section
}

test('observe: a rule that would BLOCK is recorded, and the gate is PASS with a shadow section', async () => {
    const cwd = tempWorkspace('qg-observe-block-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'must-pass', name: '门禁测试', command: OK, required: true, phase: 'gate' },
            { id: 'shadow-block', name: '影子测试', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
        ],
    })
    const { id, store } = bindMission(cwd, 'shadow block')

    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /质量门禁：PASS/)
    assert.doesNotMatch(text, /质量门禁：BLOCK/)
    // The effective reason counts only the enforcing rule — it must not claim
    // "all commands passed" while a shadow would block.
    assert.match(text, /原因：1 个命令全部通过；1 条 observe 规则只记录（would BLOCK 1 条），不计入裁决/)
    // The dedicated section: N would-blocks, one line per rule, its would + reason.
    assert.match(text, /影子（observe）：本会拦下 1 条/)
    assert.match(text, /shadow-block：would=BLOCK — 必需命令失败（exit=2）/)
    // ...and the next step that says what switching to enforce would change.
    assert.match(text, /下一步：把 mode: 'observe' 改成 'enforce'/)
    // The row says "shadow would", never PASS/FAIL/BLOCK as a verdict.
    assert.match(text, /\[影子 would=BLOCK\] shadow-block/)
    assert.match(text, /command set: .*shadow-block\[gate,required,observe\]/)

    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.observations, [
        { rule: 'shadow-block', mode: 'observe', would: 'BLOCK', reason: '必需命令失败（exit=2）' },
    ])
    assert.equal(gate?.scope?.full, true, 'scope semantics are unchanged: the observe rule did execute')
    assert.equal(gate?.results.length, 2)
    assert.equal(gate?.results.find((result) => result.id === 'shadow-block')?.mode, 'observe')
})

test('enforce (the default): the same rule blocks, names itself, and records no observation', async () => {
    const cwd = tempWorkspace('qg-enforce-block-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'must-pass', name: '门禁测试', command: OK, required: true, phase: 'gate' },
            { id: 'hard-block', name: '门禁测试2', command: FAIL, required: true, phase: 'gate' },
        ],
    })
    const { id, store } = bindMission(cwd, 'enforce block')

    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /质量门禁：BLOCK/)
    assert.match(text, /1 个必需命令失败：hard-block/)
    assert.doesNotMatch(text, /影子（observe）/)

    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.observations, undefined, 'an enforcing-only run keeps the old record shape')
    assert.equal(gate?.results.find((result) => result.id === 'hard-block')?.mode, undefined)
})

test('mixed: an enforcing BLOCK wins, and only the enforcing rule is named as the blocker', async () => {
    const cwd = tempWorkspace('qg-observe-mixed-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'hard-block', name: '强制', command: FAIL, required: true, phase: 'gate' },
            { id: 'shadow-block', name: '影子', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
        ],
    })
    const { id, store } = bindMission(cwd, 'mixed')
    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /质量门禁：BLOCK/)
    assert.match(text, /1 个必需命令失败：hard-block/)
    assert.doesNotMatch(text, /1 个必需命令失败：hard-block, shadow-block/)
    assert.match(text, /影子（observe）：本会拦下 1 条/)

    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.reason.includes('shadow-block'), false, 'the blocker list names enforcing rules only')
    assert.deepEqual(
        gate?.observations?.map((observation) => observation.rule),
        ['shadow-block'],
    )

    // Two observing rules: the gate passes, both are recorded, ordered by id.
    const twoCwd = tempWorkspace('qg-observe-two-')
    const two = host(twoCwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'shadow-b', name: '影子 B', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
            { id: 'shadow-a', name: '影子 A', command: OK, required: true, phase: 'gate', mode: 'observe' },
        ],
    })
    const twoMission = bindMission(twoCwd, 'two shadows')
    const twoText = runText(await two.runTool('quality_gate_run', {}))
    assert.match(twoText, /质量门禁：PASS/)
    const twoGate = twoMission.store.lastGate(twoMission.id, { source: 'dsh-quality-gate' })
    assert.deepEqual(
        twoGate?.observations?.map((observation) => [observation.rule, observation.would]),
        [
            ['shadow-a', 'PASS'],
            ['shadow-b', 'BLOCK'],
        ],
    )
    const section = shadowSection(twoText).join('\n')
    assert.ok(section.indexOf('shadow-a') < section.indexOf('shadow-b'), section)
})

test('every enabled observe rule appears exactly once in observations (matched or not)', async () => {
    const cwd = tempWorkspace('qg-observe-once-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'o-pass', name: '影子通过', command: OK, required: true, phase: 'gate', mode: 'observe' },
            { id: 'o-warn', name: '影子告警', command: FAIL, required: false, phase: 'gate', mode: 'observe' },
            { id: 'o-block', name: '影子阻断', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
        ],
    })
    const { id, store } = bindMission(cwd, 'observe once')
    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /质量门禁：PASS/, 'three observe rules cannot block the gate')
    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.deepEqual(
        gate?.observations,
        [
            { rule: 'o-block', mode: 'observe', would: 'BLOCK', reason: '必需命令失败（exit=2）' },
            { rule: 'o-pass', mode: 'observe', would: 'PASS', reason: '通过（exit=0）' },
            { rule: 'o-warn', mode: 'observe', would: 'WARN', reason: '非必需命令失败（exit=2）' },
        ],
    )
    const section = shadowSection(text)
    assert.match(section[0] ?? '', /本会拦下 1 条（3 条 observe 规则只记录/)
    assert.equal(section.filter((line) => line.startsWith('  - ')).length, 3)
})

test('an unknown mode is reported with the accepted values, and the rule stays enforce', async () => {
    const problems: string[] = []
    const resolved = resolveConfig(
        { commands: [{ id: 'shadow', command: FAIL, required: true, mode: 'shadow' }] },
        (message) => problems.push(message),
    )
    assert.equal(resolved.commands[0]?.mode, undefined, 'an unknown value is never read as observe')
    assert.match(resolved.commands[0]?.modeProblem ?? '', /mode 必须是 observe \/ enforce 之一/)
    assert.ok(problems.some((problem) => /mode 必须是 observe \/ enforce/.test(problem)), JSON.stringify(problems))

    const cwd = tempWorkspace('qg-observe-typo-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [{ id: 'shadow', name: '拼错的模式', command: FAIL, required: true, phase: 'gate', mode: 'shadow' }],
    })
    const { id, store } = bindMission(cwd, 'typo mode')
    const text = runText(await fake.runTool('quality_gate_run', {}))
    // Behaves exactly as before shadow mode existed: an enforcing BLOCK.
    assert.match(text, /质量门禁：BLOCK/)
    assert.match(text, /1 个必需命令失败：shadow/)
    assert.match(text, /配置问题：.*mode 必须是 observe \/ enforce 之一.*已按 enforce 处理/)
    assert.doesNotMatch(text, /影子（observe）/)
    assert.equal(store.lastGate(id, { source: 'dsh-quality-gate' })?.observations, undefined)
})

test('a project-level config can mark its own command observe (and reports an unknown mode)', async () => {
    const cwd = tempWorkspace('qg-observe-project-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const projectFile = path.join(cwd, '.dsh', 'quality-gate.json')
    fs.writeFileSync(
        projectFile,
        JSON.stringify({ commands: [{ id: 'shadow', name: '影子', command: FAIL, required: true, phase: 'gate', mode: 'observe' }] }),
    )
    clearProjectConfigCache()
    const fake = host(cwd, { logFile: 'quality-gate.log', commands: [{ id: 'profile', command: OK, required: true }] })
    const { id, store } = bindMission(cwd, 'project shadow')
    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /质量门禁：PASS/)
    assert.match(text, /shadow：would=BLOCK — 必需命令失败（exit=2）/)
    assert.match(text, /来源：.*quality-gate\.json/)
    assert.equal(store.lastGate(id, { source: 'dsh-quality-gate' })?.observations?.[0]?.rule, 'shadow')

    // An unknown mode in the project file keeps enforce and is reported.
    fs.writeFileSync(
        projectFile,
        JSON.stringify({ commands: [{ id: 'shadow', name: '影子', command: FAIL, required: true, phase: 'gate', mode: 'shadow' }] }),
    )
    clearProjectConfigCache()
    const typoText = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(typoText, /质量门禁：BLOCK/)
    assert.match(typoText, /配置问题：.*mode 必须是 observe \/ enforce 之一/)
    assert.doesNotMatch(typoText, /影子（observe）/)
})

test('a legacy gate record without observations renders and is not an error', async () => {
    const cwd = tempWorkspace('qg-observe-legacy-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', name: '测试', command: OK, required: true, phase: 'gate' }],
    })
    const { id, store } = bindMission(cwd, 'legacy record')
    // The shape written before shadow mode existed: no `observations`.
    const gate = store.recordGate(id, {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: '旧记录',
        results: [],
        scope: { selected: ['test'], total: 1, full: true },
    })
    const record = JSON.parse(fs.readFileSync(path.join(store.layout.missionsDir, id, 'gates', `${gate.id}.json`), 'utf8')) as Record<string, unknown>
    assert.equal('observations' in record, false, 'the legacy fixture really has no observations field')

    const status = runText(await fake.runTool('quality_gate_status', {}))
    assert.match(status, /latest gate: PASS/)
    assert.match(status, /旧记录/)
    assert.doesNotMatch(status, /影子（observe）/)
    assert.equal(store.readGates(id).length, 1)
})

test('a run with no observing rule writes no observations field (byte-identical default)', async () => {
    const cwd = tempWorkspace('qg-observe-shape-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', name: '测试', command: OK, required: true, phase: 'gate' }],
    })
    const { id, store } = bindMission(cwd, 'default shape')
    await fake.runTool('quality_gate_run', {})
    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.ok(gate !== undefined)
    const record = JSON.parse(fs.readFileSync(path.join(store.layout.missionsDir, id, 'gates', `${gate.id}.json`), 'utf8')) as Record<string, unknown>
    assert.equal('observations' in record, false)
})

test('determinism: two runs over the same fixture produce identical observations and strings', async () => {
    const cwd = tempWorkspace('qg-observe-determinism-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'shadow-z', name: 'Z', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
            { id: 'shadow-a', name: 'A', command: OK, required: true, phase: 'gate', mode: 'observe' },
            { id: 'test', name: '测试', command: OK, required: true, phase: 'gate' },
        ],
    })
    const { id, store } = bindMission(cwd, 'determinism')
    const firstText = runText(await fake.runTool('quality_gate_run', {}))
    const first = store.lastGate(id, { source: 'dsh-quality-gate' })
    const secondText = runText(await fake.runTool('quality_gate_run', {}))
    const second = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.deepEqual(first?.observations, second?.observations)
    assert.equal(JSON.stringify(first?.observations), JSON.stringify(second?.observations))
    assert.deepEqual(shadowSection(firstText), shadowSection(secondText))
    assert.deepEqual(
        first?.observations?.map((observation) => observation.rule),
        ['shadow-a', 'shadow-z'],
    )
})

test('observe never steers the turn-stop gate (a shadow block cannot fail the turn)', async () => {
    const cwd = tempWorkspace('qg-observe-turnstop-')
    const fake = host(cwd, {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'test', name: '测试', command: OK, required: true, phase: 'gate' },
            { id: 'shadow', name: '影子', command: FAIL, required: true, phase: 'gate', mode: 'observe' },
        ],
    })
    const { id, store } = bindMission(cwd, 'turn stop shadow')
    await write(fake)
    await turnStopReal(fake, 1)
    assert.equal(fake.steers.length, 0)
    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.equal(gate?.observations?.[0]?.would, 'BLOCK')
})

test('budget observe: the measurement is recorded, the budget cannot block, and no result row pretends it was verified', async () => {
    const budget = {
        id: 'bundle',
        name: '包体积',
        metric: 'number',
        command: 'node -e "console.log(\'size=300\')"',
        regex: 'size=(\\d+)',
        max: 200,
        mode: 'observe',
    }
    const cwd = tempWorkspace('qg-observe-budget-')
    const fake = host(cwd, { logFile: 'quality-gate.log', commands: [{ id: 'test', command: OK, required: true }], budgets: [budget] })
    const { id, store } = bindMission(cwd, 'budget shadow')
    const text = runText(await fake.runTool('budget_check', {}))
    assert.match(text, /预算门禁：PASS/)
    assert.match(text, /影子（observe）：本会拦下 1 条/)
    assert.match(text, /bundle：would=BLOCK — 本次 300 > 200/)
    assert.match(text, /\[影子 would=BLOCK\] bundle/)
    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.equal(gate?.observations?.[0]?.rule, 'bundle')
    assert.equal(gate?.observations?.[0]?.would, 'BLOCK')
    // A shadow budget is not a verification: downstream readers look budgets up
    // in `results` by id and read the gate state, so the row is deliberately absent.
    assert.equal(gate?.results.some((result) => result.id === 'bundle'), false)

    // The same budget without `mode` blocks (the old behaviour).
    const enforceCwd = tempWorkspace('qg-observe-budget-enforce-')
    const enforced: Record<string, unknown> = { ...budget }
    delete enforced['mode']
    const enforceFake = host(enforceCwd, {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', command: OK, required: true }],
        budgets: [enforced],
    })
    const enforcedMission = bindMission(enforceCwd, 'budget enforce')
    const enforcedText = runText(await enforceFake.runTool('budget_check', {}))
    assert.match(enforcedText, /预算门禁：BLOCK/)
    assert.doesNotMatch(enforcedText, /影子（observe）/)
    const enforcedGate = enforcedMission.store.lastGate(enforcedMission.id, { source: 'dsh-quality-gate' })
    assert.equal(enforcedGate?.state, 'BLOCK')
    assert.equal(enforcedGate?.observations, undefined)
    assert.equal(enforcedGate?.results.some((result) => result.id === 'bundle'), true)

    // An unknown budget mode is a reported problem, and the budget stays enforce.
    const parsed = parseBudget({ ...budget, mode: 'shadow' }, 0)
    assert.equal(parsed.budget.mode, undefined)
    assert.match(parsed.problem ?? '', /mode 必须是 observe \/ enforce 之一/)
})

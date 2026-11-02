/**
 * Shadow mode (`observe`) of the standards gate, end to end.
 *
 * The fixed semantics under test:
 *  - an observe rule is still measured exactly once and its would-be verdict is
 *    recorded, but it does not contribute to the gate's own verdict;
 *  - an enforcing rule behaves exactly as before;
 *  - the record carries `observations` ordered by rule id, the report prints a
 *    dedicated shadow section with the switch-on next step, and no shadow
 *    verdict ever appears as an enforcing PASS/BLOCK;
 *  - THE RATCHET: a shadow measurement never updates the baseline — not by
 *    accepting (`accept` skips observe rules) and not by pruning (an observe
 *    rule's acceptance survives) — so a later enforcing run behaves as if the
 *    observe run never happened, while the measurement itself is preserved for
 *    the operator (gate record + measurement artifact + report).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { loadStandards } from '../dist/tools.js'
import { parseRuleModes } from '../dist/rule-modes.js'

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Assemble the plugin in a throwaway workspace (approvals are recorded, allowed). */
function host(cwd: string): FakeHost & { approvals: string[] } {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    const approvals: string[] = []
    const seam = {
        request: async (request: { reason: string }) => {
            approvals.push(request.reason)
            return 'allowed-once'
        },
    }
    ;(fake.ctx as unknown as { get: (name: string) => unknown }).get = ((name: string) =>
        name === 'approval' ? seam : undefined) as never
    apply(fake.ctx as never, { logFile: path.join(cwd, 'standards-gate.log') })
    return Object.assign(fake, { approvals })
}

function bindMission(cwd: string, title: string): { id: string; store: ReturnType<MissionStoreRegistry['for']> } {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id, 'implement')
    return { id: mission.id, store }
}

function writeFile(cwd: string, relative: string, lines: readonly string[]): void {
    const file = path.join(cwd, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join('\n'))
}

/** A `func Deep` whose body nests `levels` `if`s — one violation per level over the limit. */
function writeDeep(cwd: string, levels: number): void {
    writeFile(cwd, 'deep.go', [
        'package demo',
        '',
        'func Deep(a int) int {',
        ...Array.from({ length: levels }, (_, index) => `${'\t'.repeat(index + 1)}if a > ${index} {`),
        `${'\t'.repeat(levels + 1)}return a`,
        ...Array.from({ length: levels }, (_, index) => `${'\t'.repeat(levels - index)}}`),
        '\treturn 0',
        '}',
    ])
}

/**
 * A Go repository with three INDEPENDENT violations, each owned by one rule:
 * `long.go` (maxFileLines), `deep.go` (maxDepth) and `wide.go` (maxParams).
 */
function ruleRepo(): string {
    const cwd = tempWorkspace('standards-observe-')
    writeFile(cwd, 'go.mod', ['module example.com/demo', '', 'go 1.26'])
    writeFile(cwd, 'long.go', ['package demo', ...Array.from({ length: 420 }, (_, index) => `// 行 ${index}`)])
    writeDeep(cwd, 6)
    writeFile(cwd, 'wide.go', [
        'package demo',
        '',
        'func Wide(a, b, c, d, e, f, g int) int {',
        '\treturn a + b + c + d + e + f + g',
        '}',
    ])
    return cwd
}

/** The standards file a repository owns (the rule modes live in the same file). */
function writeStandards(cwd: string, body: unknown): void {
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), `${JSON.stringify(body, null, 2)}\n`)
}

const DEEP_KEY = 'maxDepth|deep.go|Deep'

/** A baseline that accepted `Deep` at 4 levels (today it is 6). */
function writeBaseline(cwd: string, actual = 4): string {
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const body = {
        version: 1,
        frozenAt: new Date(0).toISOString(),
        note: '上一轮接受',
        accepted: [DEEP_KEY],
        entries: [{ key: DEEP_KEY, actual, limit: 3 }],
    }
    const file = path.join(cwd, '.dsh', 'standards-baseline.json')
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
    return file
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

/** The gate record file, so a test can assert the RECORD's shape, not the prose. */
function recordOf(store: ReturnType<MissionStoreRegistry['for']>, missionId: string, gateId: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(store.layout.missionsDir, missionId, 'gates', `${gateId}.json`), 'utf8'),
    ) as Record<string, unknown>
}

test('observe: a rule that would BLOCK is recorded, and the gate is PASS with a shadow section', async () => {
    const cwd = ruleRepo()
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxDepth: 'observe' } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'shadow block')

    const text = runText(await fake.runTool('standards_check', {}))
    assert.match(text, /— PASS/)
    assert.doesNotMatch(text, /— BLOCK/)
    // The reason counts only the enforcing rules and says why the shadow exists.
    assert.match(text, /observe 规则记录到 1 项新增\/恶化，未计入裁决/)
    // The dedicated section: N would-blocks, one line per rule, its would + the measurement.
    assert.match(text, /影子（observe）：本会拦下 1 条（1 条 observe 规则只记录，不计入本次 PASS 裁决）/)
    assert.match(text, /maxDepth：would=BLOCK — 新增 1 项、恶化 0 项（基线已接受 0 项；实测 7 \/ 上限 3）/)
    // ...and the next step that says what switching to enforce would change.
    assert.match(text, /下一步：把 .*rules 里 "maxDepth" 从 'observe' 改成 'enforce'/)
    // Shadow rows are RECORDINGS: they say `影子 would=…`, never PASS/FAIL/BLOCK.
    assert.match(text, /- maxDepth：1 \[影子 would=BLOCK\]/)
    assert.match(text, /### 新增违规（1 项：全部来自 observe 规则，不阻断门禁）/)
    assert.match(text, /- \[影子 would=BLOCK\] deep\.go:9 嵌套深度 7（上限 3，位于函数 Deep）/)

    const gate = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.observations, [
        {
            rule: 'maxDepth',
            mode: 'observe',
            would: 'BLOCK',
            reason: '新增 1 项、恶化 0 项（基线已接受 0 项；实测 7 / 上限 3）',
        },
    ])
    // The measurement is preserved for the operator in the run's artifact too.
    assert.ok(gate !== undefined)
    const artifact = JSON.parse(
        fs.readFileSync(path.join(store.layout.missionsDir, id, 'standards', `${gate.id}.json`), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(artifact['shadow'], { added: [DEEP_KEY], worsened: [] })
    assert.deepEqual(artifact['added'], [], 'a shadow violation is not an "added" failure of the gate')
    assert.equal((artifact['violations'] as unknown[]).length, 1, 'the measurement itself is kept, with its numbers')
})

test('enforce (the default): the same rule blocks, names itself, and records no observation', async () => {
    const cwd = ruleRepo()
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'enforce block')

    const text = runText(await fake.runTool('standards_check', {}))
    assert.match(text, /— BLOCK/)
    assert.match(text, /新增 1 项、恶化 0 项规范违规（基线已接受 0 项）：maxDepth/)
    assert.doesNotMatch(text, /影子（observe）/)
    assert.doesNotMatch(text, /\[影子 would=/)

    const gate = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.observations, undefined, 'an enforcing-only run keeps the old record shape')
    const record = recordOf(store, id, gate?.id ?? '')
    assert.equal('observations' in record, false, 'the record of an enforcing-only run grows no field')
})

test('mixed: an enforcing BLOCK wins, only the enforcing rule is named, and the shadow stays a recording', async () => {
    const cwd = ruleRepo()
    // long.go (420 lines > 400) enforces; wide.go (7 params > 5) only observes.
    writeStandards(cwd, { languages: { go: { maxFileLines: 400, maxParams: 5 } }, rules: { maxParams: 'observe' } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'mixed')

    const text = runText(await fake.runTool('standards_check', {}))
    assert.match(text, /— BLOCK/)
    // The blocker list names ENFORCING rules only.
    assert.match(text, /（基线已接受 0 项）：maxFileLines/)
    assert.doesNotMatch(text, /：maxFileLines、maxParams/)
    assert.doesNotMatch(text, /：maxParams、/)
    assert.match(text, /### 新增违规（2 项：门禁失败的原因，其中 1 项来自 observe 规则、不阻断）/)
    assert.match(text, /影子（observe）：本会拦下 1 条/)
    assert.match(text, /maxParams：would=BLOCK/)
    assert.equal(text.includes('[影子 would=BLOCK] wide.go'), true)
    assert.equal(text.includes('[影子 would=BLOCK] long.go'), false, 'an enforcing row is a failure, not a shadow')

    const gate = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.reason.includes('maxParams'), false, 'the reason names enforcing rules only')
    assert.deepEqual(
        gate?.observations?.map((observation) => observation.rule),
        ['maxParams'],
    )
})

test('every observe rule is recorded exactly once, ordered by rule id', async () => {
    const cwd = ruleRepo()
    // Both violations are shadow ones; maxFileLines stays under its limit.
    writeStandards(cwd, {
        languages: { go: { maxFileLines: 500, maxDepth: 3, maxParams: 5 } },
        rules: { maxParams: 'observe', maxDepth: 'observe' },
    })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'two shadows')

    const text = runText(await fake.runTool('standards_check', {}))
    assert.match(text, /— PASS/, 'two observe rules cannot block the gate')
    const gate = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.deepEqual(
        gate?.observations?.map((observation) => [observation.rule, observation.would]),
        [
            ['maxDepth', 'BLOCK'],
            ['maxParams', 'BLOCK'],
        ],
    )
    const section = shadowSection(text)
    assert.match(section[0] ?? '', /本会拦下 2 条（2 条 observe 规则只记录，不计入本次 PASS 裁决）/)
    assert.equal(section.filter((line) => line.startsWith('  - ')).length, 2)
    assert.ok(section.join('\n').indexOf('maxDepth') < section.join('\n').indexOf('maxParams'), 'ordered by id')
})

test('an unknown mode is a config problem, the rule stays enforce, and the gate is unchanged', async () => {
    const parsed = parseRuleModes({ maxDepth: 'shadow' }, '.dsh/standards.json')
    assert.equal(parsed.modes.get('maxDepth'), 'enforce', 'an unknown value is never read as observe')
    assert.match(parsed.problems.join('\n'), /mode 必须是 observe \/ enforce 之一/)
    assert.match(parsed.problems.join('\n'), /已按 enforce 处理/)

    const typo = parseRuleModes({ maxDepths: 'observe' }, '.dsh/standards.json')
    assert.equal(typo.modes.size, 0)
    assert.match(typo.problems.join('\n'), /"maxDepths" 不是已知规则/)
    const notAnObject = parseRuleModes(['observe'], '.dsh/standards.json')
    assert.match(notAnObject.problems.join('\n'), /rules 必须是对象/)

    const cwd = ruleRepo()
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxDepth: 'shadow' } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'typo mode')
    const text = runText(await fake.runTool('standards_check', {}))
    // Behaves exactly as before shadow mode existed: an enforcing BLOCK.
    assert.match(text, /— BLOCK/)
    assert.match(text, /配置问题：.*mode 必须是 observe \/ enforce 之一.*已按 enforce 处理/)
    assert.doesNotMatch(text, /影子（observe）/)
    assert.equal(store.lastGate(id, { source: 'dsh-standards-gate' })?.observations, undefined)

    // A mode without a rule measures nothing: that is said, not silently accepted.
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxParams: 'observe', maxDepth: 'observe' } })
    const dangling = loadStandards(cwd, '.dsh/standards.json')
    assert.match(dangling.problems.join('\n'), /把 "maxParams" 标成了 observe，但规范文件没有声明对应的阈值/)
})

test('THE RATCHET: a shadow measurement never moves the baseline, in either direction', async () => {
    const cwd = ruleRepo()
    const baselinePath = writeBaseline(cwd, 4) // Deep was accepted at 4; today it is 6 → worse.
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxDepth: 'observe' } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'ratchet')
    const before = fs.readFileSync(baselinePath, 'utf8')

    // (1) Watching: the rule measures, would BLOCK on the WORSE measurement, and
    // the gate does not fail.
    const watched = runText(await fake.runTool('standards_check', {}))
    assert.match(watched, /— PASS/)
    assert.match(watched, /maxDepth：would=BLOCK — 新增 0 项、恶化 1 项（基线已接受 0 项；实测 7 \/ 上限 3）/)
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), before, 'a shadow measurement writes no baseline')

    // (2) `accept` while observing writes NOTHING and does not even ask a person:
    // there is nothing an enforcing rule could accept.
    const accepted = runText(await fake.runTool('standards_check', { accept: true, note: '想蒙过去' }))
    assert.match(accepted, /accept 没有写入任何东西/)
    assert.match(accepted, /影子规则的新增违规不会被记进基线/)
    assert.equal(fake.approvals.length, 0, 'an accept that could only grandfather shadow data asks nobody')
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), before)

    // (3) Switching the rule back to enforce behaves as if the observe run never
    // happened: the old acceptance (4) is intact, the 6 is still a worsening.
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } } })
    const enforced = runText(await fake.runTool('standards_check', {}))
    assert.match(enforced, /— BLOCK/)
    assert.match(enforced, /恶化（1 项：基线接受过，但比当初更严重）/)
    assert.match(enforced, /（基线已接受 0 项）：maxDepth/)

    // (4) The tightening direction: while observing, the violation disappears —
    // the implicit pruning pass must NOT drop the acceptance either.
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxDepth: 'observe' } })
    writeDeep(cwd, 2)
    const fixed = runText(await fake.runTool('standards_check', {}))
    assert.match(fixed, /— PASS/)
    assert.match(fixed, /maxDepth：would=PASS — 无新增违规（基线已接受 0 项）/)
    assert.match(fixed, /其中 1 项属于 observe 规则：它们\*\*不会\*\*被从基线里收紧/)
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), before, 'a shadow measurement tightens nothing either')

    // …so reverting to the accepted depth is "known" again, exactly as it was
    // before the observe run — no acceptance was lost, none was invented.
    writeDeep(cwd, 3) // measured depth 4 = exactly what the baseline accepted
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } } })
    const reverted = runText(await fake.runTool('standards_check', {}))
    assert.match(reverted, /— PASS/)
    assert.match(reverted, /无新增违规（基线已接受 1 项/)

    // The shadow measurement is still preserved for the operator, not silently lost.
    const gates = store.readGates(id).filter((gate) => gate.source === 'dsh-standards-gate')
    assert.ok(gates.length >= 5, `one record per run: ${gates.length}`)
    assert.ok(gates.some((gate) => gate.observations?.[0]?.would === 'BLOCK'))
    assert.ok(gates.some((gate) => gate.observations?.[0]?.would === 'PASS'))
})

test('determinism: two runs over the same fixture produce identical observations and strings', async () => {
    const cwd = ruleRepo()
    writeStandards(cwd, {
        languages: { go: { maxFileLines: 500, maxDepth: 3, maxParams: 5 } },
        rules: { maxParams: 'observe', maxDepth: 'observe' },
    })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'determinism')

    const firstText = runText(await fake.runTool('standards_check', {}))
    const first = store.lastGate(id, { source: 'dsh-standards-gate' })
    const secondText = runText(await fake.runTool('standards_check', {}))
    const second = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.deepEqual(first?.observations, second?.observations)
    assert.equal(JSON.stringify(first?.observations), JSON.stringify(second?.observations))
    assert.deepEqual(shadowSection(firstText), shadowSection(secondText))
    const reasonLine = (text: string): string => text.split('\n').find((line) => line.startsWith('结论：')) ?? ''
    assert.equal(reasonLine(firstText), reasonLine(secondText))
})

test('a legacy gate record without observations renders, and is not an error', async () => {
    const cwd = ruleRepo()
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } } })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'legacy record')
    // The shape written before shadow mode existed: no `observations`.
    const gate = store.recordGate(id, {
        source: 'dsh-standards-gate',
        state: 'PASS',
        reason: '旧记录',
        results: [],
        scope: { selected: ['standards'], total: 1, full: true },
    })
    assert.equal('observations' in recordOf(store, id, gate.id), false, 'the legacy fixture really has no observations')

    const status = runText(await fake.runTool('standards_status', {}))
    assert.match(status, /GATE-.*：PASS/)
    assert.match(status, /旧记录/)
    assert.doesNotMatch(status, /影子（observe）/)
    assert.equal(store.readGates(id).length, 1)
})

test('standards_status shows the declared modes and the last record observations', async () => {
    const cwd = ruleRepo()
    writeStandards(cwd, { languages: { go: { maxDepth: 3 } }, rules: { maxDepth: 'observe' } })
    const fake = host(cwd)
    const { id } = bindMission(cwd, 'status shadow')
    await fake.runTool('standards_check', {})
    const status = runText(await fake.runTool('standards_status', {}))
    assert.match(status, /### 规则模式（rules）/)
    assert.match(status, /`maxDepth`：observe（只测量、记进 observations，不阻断；\*\*不会\*\*写进基线）/)
    assert.match(status, /影子（observe）：本会拦下 1 条/)
    assert.match(status, /maxDepth：would=BLOCK/)
    assert.ok(id.length > 0)
})

test('standards_bootstrap freeze carries the rule modes an operator committed', async () => {
    const cwd = tempWorkspace('standards-observe-bootstrap-')
    writeFile(cwd, 'go.mod', ['module example.com/demo', '', 'go 1.26'])
    writeFile(cwd, 'wide.go', ['package demo', '', 'func Wide(a, b int) int {', '\treturn a + b', '}'])
    writeStandards(cwd, { languages: { go: { maxParams: 5 } }, rules: { maxParams: 'observe' } })
    const fake = host(cwd)
    const frozen = runText(await fake.runTool('standards_bootstrap', { action: 'freeze', thresholds: { maxFileLines: 300 } }))
    assert.match(frozen, /已写入/)
    const written = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'standards.json'), 'utf8')) as Record<string, unknown>
    assert.equal(written['languages'] !== undefined, true)
    assert.deepEqual(written['rules'], { maxParams: 'observe' }, 'a threshold write must not silently re-enforce a rule')
})

test('the mode vocabulary covers non-threshold rules too (layers, cycles)', async () => {
    const cwd = tempWorkspace('standards-observe-layer-')
    // `src/domain` must not import `src/app`: one layer violation, no cycle.
    writeFile(cwd, 'src/app/b.ts', ['export function b(): number {', '    return 1', '}'])
    writeFile(cwd, 'src/domain/a.ts', ["import { b } from '../app/b.ts'", '', 'export function a(): number {', '    return b()', '}'])
    writeStandards(cwd, {
        languages: { ts: { maxFileLines: 300 } },
        layers: [{ path: 'src/domain', mayImport: [] }],
        forbidCycles: true,
        rules: { layer: 'observe', cycle: 'observe' },
    })
    const fake = host(cwd)
    const { id, store } = bindMission(cwd, 'layer shadow')

    const text = runText(await fake.runTool('standards_check', {}))
    assert.match(text, /— PASS/, 'a shadow layer violation cannot block the gate')
    assert.match(text, /layer：would=BLOCK — 新增 1 项、恶化 0 项（基线已接受 0 项；实测 1 \/ 上限 0）/)
    assert.match(text, /cycle：would=PASS — 无新增违规（基线已接受 0 项）/)
    const gate = store.lastGate(id, { source: 'dsh-standards-gate' })
    assert.deepEqual(
        gate?.observations?.map((observation) => [observation.rule, observation.would]),
        [
            ['cycle', 'PASS'],
            ['layer', 'BLOCK'],
        ],
        'every declared rule is evaluated once, ordered by id',
    )
})

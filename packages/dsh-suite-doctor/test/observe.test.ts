/**
 * `gate.observe`: the operator's aggregation of shadow-rule records.
 *
 * The check reads durable gate records over a stated window (newest 20 missions
 * by `updatedAt`), counts would-blocks by rule id, and is advice — never a
 * blocker. Legacy records without `observations` are "no observation", never an
 * error.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type GateObservation, type GateRecord } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import {
    OBSERVE_ENFORCE_STREAK,
    OBSERVE_WINDOW_MISSIONS,
    gateObserveCheck,
    tallyObservations,
    type ObserveStoreLike,
} from '../dist/observe.js'

function observation(rule: string, would: GateObservation['would'], reason = '原因'): GateObservation {
    return { rule, mode: 'observe', would, reason }
}

function gate(id: string, checkedAt: number, observations?: GateObservation[]): GateRecord {
    return {
        id,
        missionId: 'M',
        source: 'dsh-quality-gate',
        state: 'PASS',
        checkedAt,
        reason: '记录',
        results: [],
        ...(observations === undefined ? {} : { observations }),
    }
}

/** A structural mission store: the window logic is pure over missions + gates. */
function fakeStore(
    missions: { id: string; updatedAt: number; gates: GateRecord[] }[],
): ObserveStoreLike {
    return {
        list: () => missions.map((mission) => ({ id: mission.id, updatedAt: mission.updatedAt })),
        readGates: (id) => missions.find((mission) => mission.id === id)?.gates ?? [],
    }
}

test('counts would-blocks by rule id over the window, with a concrete switch-on step', () => {
    const store = fakeStore([
        {
            id: 'M-A',
            updatedAt: 3,
            gates: [
                gate('g1', 100, [observation('lint', 'BLOCK', '必需命令失败（exit=2）'), observation('bundle', 'PASS')]),
                gate('g2', 200, [observation('lint', 'PASS'), observation('bundle', 'PASS')]),
                gate('g3', 300, [observation('lint', 'PASS'), observation('bundle', 'PASS')]),
            ],
        },
    ])
    const tally = tallyObservations(store)
    assert.equal(tally.missions, 1)
    assert.equal(tally.gates, 3)
    assert.equal(tally.observations, 6)
    assert.equal(tally.wouldBlock, 1)
    assert.deepEqual(
        tally.rules.map((rule) => [rule.rule, rule.observations, rule.would.BLOCK, rule.zeroDiffStreak]),
        [
            ['bundle', 3, 0, 3],
            ['lint', 3, 1, 2],
        ],
        'grouped by rule id, chronological, streaks count the newest PASS run',
    )
    const check = gateObserveCheck(store)
    assert.equal(check.id, 'gate.observe')
    assert.equal(check.area, 'test')
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    assert.match(check.detail, /窗口：最近 20 个 mission（按 updatedAt 倒序）的 3 条门禁记录/)
    assert.match(check.detail, /影子记录 6 条，其中 would BLOCK 1 条/)
    assert.match(check.detail, /bundle：3 条（would BLOCK 0 \/ WARN 0 \/ PASS 3），当前连续 3 次零差异/)
    assert.match(check.detail, /lint：3 条（would BLOCK 1 \/ WARN 0 \/ PASS 2），当前连续 2 次零差异/)
    assert.match(check.fix ?? '', new RegExp(`连续 ${OBSERVE_ENFORCE_STREAK} 次零差异（would=PASS）后再切 enforce`))
    assert.match(check.fix ?? '', /重跑一次完整 quality_gate_run/)
    assert.notEqual(check.severity, 'required')
})

test('ok when nothing is observing; a legacy record is "no observation", not an error', () => {
    const store = fakeStore([
        { id: 'M-1', updatedAt: 2, gates: [gate('legacy', 100)] },
        { id: 'M-2', updatedAt: 1, gates: [gate('empty', 200, [])] },
    ])
    const check = gateObserveCheck(store)
    assert.equal(check.state, 'ok')
    assert.equal(check.severity, 'recommended')
    assert.match(check.detail, /没有 observe 规则在测量（0 条影子记录）/)
    assert.match(check.detail, /其中 1 条旧记录没有 observations 字段（按"没有观察"读取，不是错误）/)
    assert.equal(check.fix, undefined)
})

test('the window is bounded: the newest 20 missions by updatedAt are read (and stated)', () => {
    const missions = Array.from({ length: OBSERVE_WINDOW_MISSIONS + 1 }, (_unused, index) => ({
        id: `M-${String(index + 1).padStart(2, '0')}`,
        updatedAt: index + 1,
        gates: [gate(`g-${index}`, index, index === 0 ? [observation('oldest', 'BLOCK')] : undefined)],
    }))
    const store = fakeStore(missions)
    const bounded = tallyObservations(store)
    assert.equal(bounded.missions, OBSERVE_WINDOW_MISSIONS)
    assert.equal(bounded.observations, 0, 'the 21st-newest mission is outside the window')
    assert.match(gateObserveCheck(store).detail, new RegExp(`最近 ${OBSERVE_WINDOW_MISSIONS} 个 mission`))

    // Stating the window means it is also configurable (e.g. a deeper audit).
    const wider = tallyObservations(store, { windowMissions: OBSERVE_WINDOW_MISSIONS + 1 })
    assert.equal(wider.missions, OBSERVE_WINDOW_MISSIONS + 1)
    assert.equal(wider.observations, 1)
    assert.equal(wider.rules[0]?.rule, 'oldest')
})

test('a malformed observations entry is counted and ignored, never thrown', () => {
    const record = gate('g1', 100)
    // A hand-edited artifact must not crash the doctor.
    record.observations = [
        { rule: 42 },
        null,
        { rule: 'usable', mode: 'observe', would: 'PASS', reason: 'ok' },
    ] as never
    const check = gateObserveCheck(fakeStore([{ id: 'M-1', updatedAt: 1, gates: [record] }]))
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    assert.match(check.detail, /另有 2 条 observations 条目无法识别，已忽略（记录损坏，不是错误）/)
    assert.match(check.detail, /usable：1 条/)
})

// --- integration with suite_status -----------------------------------------

function host(cwd: string) {
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('suite-doctor-observe-log-'), 'doctor.log') })
    return fake
}

function reportOf(run: { value: unknown }): {
    checks: { id: string; state: string; severity: string; detail: string; fix?: string }[]
    blockers: { id: string }[]
    advice: { id: string }[]
} {
    return JSON.parse(String(run.value)) as never
}

test('suite_status reports gate.observe as advice, never as a blocker', async () => {
    const cwd = tempWorkspace('suite-doctor-observe-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '影子聚合', cwd, id: 'M-1' })
    store.bindSession('session-1', 'M-1')
    store.recordGate('M-1', {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: '影子记录',
        results: [],
        observations: [observation('command-test', 'BLOCK', '必需命令失败（exit=2）')],
    })
    const fake = host(cwd)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'gate.observe')
    assert.ok(check !== undefined, JSON.stringify(report.checks.map((entry) => entry.id)))
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    assert.match(check.detail, /would BLOCK 1 条/)
    assert.match(check.detail, /command-test：1 条/)
    assert.match(check.fix ?? '', /连续 5 次零差异/)
    assert.equal(report.blockers.some((entry) => entry.id === 'gate.observe'), false)
    assert.equal(report.advice.some((entry) => entry.id === 'gate.observe'), true)

    // The text report carries the same section (the operator reads Chinese text).
    const text = runText(await fake.runTool('suite_status', {}))
    assert.match(text, /影子规则（gate\.observe）/)
    assert.match(text, /command-test：1 条/)
})

test('suite_status with only legacy gate records reports gate.observe as ok', async () => {
    const cwd = tempWorkspace('suite-doctor-observe-legacy-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '旧记录', cwd, id: 'M-2' })
    store.bindSession('session-1', 'M-2')
    // No `observations`: the shape written before shadow mode existed.
    store.recordGate('M-2', { source: 'dsh-quality-gate', state: 'PASS', reason: '旧记录', results: [] })
    const fake = host(cwd)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'gate.observe')
    assert.equal(check?.state, 'ok')
    assert.equal(check?.severity, 'recommended')
    assert.match(check?.detail ?? '', /其中 1 条旧记录没有 observations 字段/)
    assert.equal(report.advice.some((entry) => entry.id === 'gate.observe'), false)
})

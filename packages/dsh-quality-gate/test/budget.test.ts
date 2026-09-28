/**
 * dsh-quality-gate budgets: absolute bounds, the append-only baseline ratchet,
 * refusals for anything that could not be measured, and the recorded gate row.
 *
 * Commands are never really spawned here: the tool-level tests inject a scripted
 * `ctx.subprocess`, and the engine-level tests pass a stubbed runner with an
 * injected clock, so every number in the assertions is one the test chose.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, formatTime } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import {
    appendBaseline,
    baselineFileFor,
    compareRegression,
    evaluateMeasurement,
    extractNumber,
    lowerIsBetter,
    parseBudget,
    readBaseline,
    runBudgets,
    selectBudgets,
    type BaselineEntry,
    type BudgetCheck,
    type BudgetConfig,
} from '../dist/budget.js'

/** One scripted `ctx.subprocess` reply. */
interface Step {
    exitCode?: number | null
    stdout?: string
    stderr?: string
    signal?: string | null
    /** Throw instead of spawning (ENOENT and friends). */
    spawnError?: string
    durationMs?: number
    timedOut?: boolean
}

/** A `ctx.subprocess` that answers with the script, in order. */
function scriptedService(script: readonly Step[]): { service: unknown; spawns: { argv: readonly string[]; cwd: string }[] } {
    const spawns: { argv: readonly string[]; cwd: string }[] = []
    let index = 0
    return {
        spawns,
        service: {
            spawn(spec: { argv: readonly string[]; cwd: string }) {
                spawns.push({ argv: spec.argv, cwd: spec.cwd })
                const step = script[Math.min(index, script.length - 1)] ?? {}
                index += 1
                if (step.spawnError !== undefined) {
                    return { done: Promise.reject(new Error(step.spawnError)), collected: {}, terminate: () => undefined }
                }
                const collected = { stdout: step.stdout ?? '', stderr: step.stderr ?? '' }
                return {
                    done: Promise.resolve({ exitCode: step.exitCode ?? 0, signal: step.signal ?? null }),
                    collected: {
                        stdout: { readFrom: () => ({ text: collected.stdout }) },
                        stderr: { readFrom: () => ({ text: collected.stderr }) },
                    },
                    terminate: () => undefined,
                }
            },
        },
    }
}

const hosts: FakeHost[] = []
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gate-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in `cwd` with a scripted subprocess. */
function host(
    cwd: string,
    config: Record<string, unknown>,
    script: readonly Step[],
): FakeHost & { spawns: { argv: readonly string[]; cwd: string }[] } {
    const scripted = scriptedService(script)
    const fake = createFakeHost({ cwd, services: { subprocess: scripted.service } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return Object.assign(fake, { spawns: scripted.spawns })
}

/** Every file under `dir`, relative path → content (for "wrote nothing" checks). */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(current, entry.name)
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
            if (entry.isDirectory()) walk(absolute, relative)
            else out[relative] = fs.readFileSync(absolute, 'utf8')
        }
    }
    if (fs.existsSync(dir)) walk(dir, '')
    return out
}

/** A mission bound to the fake host's session; returns the mission id. */
function bindMission(cwd: string, title = '预算测试'): string {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    return mission.id
}

/** The plugin config used by most tests (one bytes budget with a ratchet). */
function budget(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', name: '单元测试', command: 'node -e "0"', required: true, phase: 'gate' }],
        budgets: [
            {
                id: 'bundle',
                name: '前端包体积',
                metric: 'bytes',
                command: 'node size.mjs',
                regex: 'size=(\\d+)',
                max: 2000,
                maxRegressionPercent: 10,
            },
        ],
        ...extra,
    }
}

/** Fixed clock, so the recorded timestamp can be asserted. */
const CLOCK = 1_700_000_000_000

/** Find one check by the prefix of its name. */
function checkOf(checks: readonly BudgetCheck[] | undefined, prefix: string): BudgetCheck | undefined {
    return checks?.find((check) => check.name.startsWith(prefix))
}

/** A stubbed command runner recording the specs it received. */
function stubRunner(replies: readonly Step[]): {
    runner: (spec: Record<string, unknown>) => Promise<Record<string, unknown>>
    specs: Record<string, unknown>[]
} {
    const specs: Record<string, unknown>[] = []
    let index = 0
    return {
        specs,
        runner: async (spec) => {
            specs.push(spec)
            const step = replies[Math.min(index, replies.length - 1)] ?? {}
            index += 1
            return {
                argv: spec['argv'],
                command: (spec['argv'] as string[]).join(' '),
                cwd: spec['cwd'],
                exitCode: step.exitCode ?? 0,
                signal: step.signal ?? null,
                stdout: step.stdout ?? '',
                stderr: step.stderr ?? '',
                durationMs: step.durationMs ?? 1,
                timedOut: step.timedOut ?? false,
                ...(step.spawnError === undefined ? {} : { spawnError: step.spawnError }),
            }
        },
    }
}

// --- config ---------------------------------------------------------------

test('budgets: defaults, metric validation and problems that never drop a rule', () => {
    const good = parseBudget({ id: 'a', metric: 'number', command: 'x', regex: 'n=(\\d+)' }, 0)
    assert.equal(good.problem, undefined)
    assert.equal(good.budget.unit, undefined)
    // A malformed entry is KEPT: dropping it would make the report look green
    // because the rule stopped existing.
    const bad = parseBudget({ id: 'b', metric: 'nan', command: 'x' }, 1)
    assert.match(bad.problem ?? '', /metric 必须是 durationMs \/ number \/ bytes/)
    assert.equal(bad.budget.id, 'b')
    const notObject = parseBudget('nonsense', 2)
    assert.equal(notObject.budget.id, 'budget-3')
    assert.match(notObject.problem ?? '', /必须是对象/)
    assert.match(parseBudget({ id: 'c', metric: 'number', command: 'x', regex: '([' }, 3).problem ?? '', /不是合法正则/)
    assert.match(parseBudget({ id: 'd', metric: 'durationMs', command: 'x', expect: {} }, 4).problem ?? '', /expect 不属于预算/)
    assert.notEqual(parseBudget({ id: 'e', metric: 'durationMs', maxRegressionPercent: -1 }, 5).problem, undefined)
})

test('budgets: direction follows the bound, so a min-only budget guards going down', () => {
    assert.equal(lowerIsBetter({ id: 'a', name: 'a', metric: 'number', max: 10 }), true)
    assert.equal(lowerIsBetter({ id: 'b', name: 'b', metric: 'number', min: 10 }), false)
})

test('budgets: a missing command/commandId and an unknown commandId are refusals naming the budget', async () => {
    const empty = resolveConfig(budget({ budgets: [{ id: 'empty', metric: 'durationMs' }] }))
    const missing = await runBudgets({ cwd: '/tmp', config: empty, rootDir: '/tmp/.dsh' })
    assert.equal(missing.ok, false)
    assert.match(missing.ok === false ? missing.problem : '', /预算 "empty" 没有声明 command 或 commandId/)
    assert.match(missing.ok === false ? missing.problem : '', /下一步/)

    const unknown = resolveConfig(budget({ budgets: [{ id: 'ghost', metric: 'durationMs', commandId: 'nope' }] }))
    const refused = await runBudgets({ cwd: '/tmp', config: unknown, rootDir: '/tmp/.dsh' })
    assert.equal(refused.ok, false)
    assert.match(refused.ok === false ? refused.problem : '', /引用了不存在的门禁命令 "nope"：可用的命令 id 是 test/)
})

test('budgets: selectBudgets refuses an unknown `only` id instead of silently running nothing', () => {
    const config = resolveConfig(budget())
    const result = selectBudgets(config, ['nope'])
    assert.equal('problem' in result, true)
    assert.match('problem' in result ? result.problem : '', /请求的预算不存在：nope（可用：bundle）/)
    assert.deepEqual(selectBudgets(config, ['bundle']).budgets?.map((entry) => entry.id), ['bundle'])
})

// --- extraction -----------------------------------------------------------

test('budgets: extractNumber takes the first capture group and never invents a 0', () => {
    assert.deepEqual(extractNumber(/size=(\d+)/, 'size=1234 bytes'), { ok: true, value: 1234, raw: '1234' })
    assert.equal(extractNumber(/size=(\d+)/, 'nothing here').ok, false)
    assert.deepEqual(extractNumber(/size=([\d.]+k?B?)/, 'size=1.2kB'), { ok: false, kind: 'unparsable', raw: '1.2kB' })
    assert.deepEqual(extractNumber(/n=([\d,]+)/, 'n=1,200'), { ok: false, kind: 'unparsable', raw: '1,200' })
    // A pattern with no group uses the whole match.
    assert.deepEqual(extractNumber(/\d+/, 'took 42ms'), { ok: true, value: 42, raw: '42' })
})

// --- bounds and the ratchet ----------------------------------------------

test('budgets: absolute max/min bounds are reported one by one', () => {
    const config: BudgetConfig = { id: 'b', name: 'b', metric: 'number', max: 100, min: 10 }
    const checks = evaluateMeasurement(config, 150, [])
    assert.deepEqual(
        checks.map((check) => [check.name, check.state]),
        [
            ['上限 ≤ 100 count', 'FAIL'],
            ['下限 ≥ 10 count', 'PASS'],
            ['回归（未声明 maxRegressionPercent，不判）', 'PASS'],
        ],
    )
    assert.match(checkOf(checks, '上限')?.detail ?? '', /超过上限 50\.00/)
    assert.match(checkOf(evaluateMeasurement(config, 5, []), '下限')?.detail ?? '', /低于下限 5\.00/)
})

test('budgets: the regression message names the recorded value, its run and when it was taken', () => {
    const config: BudgetConfig = { id: 'slow', name: 'slow', metric: 'durationMs', max: 500, maxRegressionPercent: 20 }
    const history: BaselineEntry[] = [{ at: CLOCK, value: 100, metric: 'durationMs', unit: 'ms', command: 'node slow', exitCode: 0 }]
    const verdict = compareRegression(config, 130, history)
    assert.equal(verdict.state, 'FAIL')
    assert.match(verdict.detail, new RegExp(`历史最佳 100 ms（第 1 次记录，${formatTime(CLOCK).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(verdict.detail, /变差 30\.0%，超过允许的 20%/)
    assert.equal(verdict.limit, 120)
    const inside = compareRegression(config, 118, history)
    assert.equal(inside.state, 'PASS')
    assert.match(inside.detail, /历史最佳 100 ms/)
})

test('budgets: the ratchet compares against the best ever recorded, not the last run', () => {
    const file = path.join(tempWorkspace('budget-history-'), 'budgets.json')
    const entry = (at: number, value: number): BaselineEntry => ({ at, value, metric: 'number', unit: 'count', command: 'x', exitCode: 0 })
    appendBaseline(file, 'b', entry(CLOCK, 100))
    appendBaseline(file, 'b', entry(CLOCK + 1_000, 300))
    appendBaseline(file, 'b', entry(CLOCK + 2_000, 120))
    const history = readBaseline(file, 'b').entries
    assert.deepEqual(history.map((item) => item.value), [100, 300, 120])
    // 120 is the LAST value but 100 is the BEST, so the 10% allowance ends at 110.
    const verdict = compareRegression({ id: 'b', name: 'b', metric: 'number', maxRegressionPercent: 10 }, 120, history)
    assert.equal(verdict.state, 'FAIL')
    assert.match(verdict.detail, /历史最佳 100 count（第 1 次记录，/)
})

test('budgets: an unmeasured budget is "no data yet", and a 0 best cannot absorb growth', () => {
    const first = compareRegression({ id: 'w', name: 'w', metric: 'number', maxRegressionPercent: 10 }, 5, [])
    assert.equal(first.state, 'NO-HISTORY')
    assert.match(first.detail, /基线已记录/)
    const zero: BaselineEntry[] = [{ at: CLOCK, value: 0, metric: 'number', unit: 'count', command: 'x', exitCode: 0 }]
    assert.equal(compareRegression({ id: 'w', name: 'w', metric: 'number', maxRegressionPercent: 10 }, 0, zero).state, 'PASS')
    const grown = compareRegression({ id: 'w', name: 'w', metric: 'number', maxRegressionPercent: 10 }, 1, zero)
    assert.equal(grown.state, 'FAIL')
    assert.match(grown.detail, /为 0：本次 1 从 0 增长/)
})

// --- the engine: first run, ratchet, gate rows ---------------------------

test('budgets: the first run records the baseline (PASS + 基线已记录) and the next worse run BLOCKs', async () => {
    const cwd = tempWorkspace('budget-ratchet-')
    const config = resolveConfig(budget())
    const rootDir = path.join(cwd, '.dsh')
    const file = path.join(rootDir, 'budgets.json')

    const first = stubRunner([{ exitCode: 0, stdout: 'size=1000' }])
    const run1 = await runBudgets({ cwd, config, rootDir, runner: first.runner, now: () => CLOCK })
    assert.equal(run1.ok, true)
    assert.equal(run1.ok === true ? run1.state : '', 'PASS')
    assert.equal(run1.ok === true ? run1.recorded : -1, 1)
    assert.equal(run1.ok === true ? run1.scope.full : true, false, 'a budget run is never the host command set')
    assert.deepEqual(run1.ok === true ? run1.scope.selected : [], ['bundle'])
    assert.match(checkOf(run1.ok === true ? run1.evaluations[0]?.checks : [], '回归')?.detail ?? '', /基线已记录：本次 1000 bytes 是第 1 次测量/)
    assert.equal(run1.ok === true ? run1.evaluations[0]?.baseline.recorded : false, true)
    assert.deepEqual(readBaseline(file, 'bundle').entries.map((item) => [item.value, item.at, item.unit]), [[1000, CLOCK, 'bytes']])

    // Same value again: PASS, and the comparison names the recorded value.
    const second = stubRunner([{ exitCode: 0, stdout: 'size=1000' }])
    const run2 = await runBudgets({ cwd, config, rootDir, runner: second.runner, now: () => CLOCK + 1_000 })
    assert.equal(run2.ok === true ? run2.state : '', 'PASS')
    assert.match(checkOf(run2.ok === true ? run2.evaluations[0]?.checks : [], '回归')?.detail ?? '', /历史最佳 1000 bytes（第 1 次记录，/)

    // 25% worse AND over the absolute max → BLOCK, and the violating value is
    // not accepted as a baseline.
    const third = stubRunner([{ exitCode: 0, stdout: 'size=2500' }])
    const run3 = await runBudgets({ cwd, config, rootDir, runner: third.runner, now: () => CLOCK + 2_000 })
    assert.equal(run3.ok === true ? run3.state : '', 'BLOCK')
    const evaluation = run3.ok === true ? run3.evaluations[0] : undefined
    assert.equal(checkOf(evaluation?.checks, '上限')?.state, 'FAIL')
    assert.match(checkOf(evaluation?.checks, '回归')?.detail ?? '', /比历史最佳 1000 bytes（第 1 次记录，/)
    assert.match(checkOf(evaluation?.checks, '回归')?.detail ?? '', /变差 150\.0%，超过允许的 10%/)
    assert.equal(evaluation?.baseline.recorded, false)
    assert.equal(readBaseline(file, 'bundle').entries.length, 2, 'only accepted measurements enter the history')
})

test('budgets: duration is measured from the run and stamped with the injected clock', async () => {
    const cwd = tempWorkspace('budget-duration-')
    const rootDir = path.join(cwd, '.dsh')
    const config = resolveConfig(
        budget({
            budgets: [{ id: 'slow', name: '慢命令', metric: 'durationMs', command: 'node slow.mjs', max: 100, maxRegressionPercent: 20 }],
        }),
    )
    const runner = stubRunner([{ exitCode: 0, durationMs: 42 }])
    const run = await runBudgets({ cwd, config, rootDir, runner: runner.runner, now: () => CLOCK })
    assert.equal(run.ok === true ? run.evaluations[0]?.value : -1, 42)
    assert.deepEqual(runner.specs[0]?.['argv'], ['node', 'slow.mjs'])
    assert.equal(runner.specs[0]?.['timeoutMs'], 300_000, 'a literal command inherits the default deadline')
    assert.deepEqual(readBaseline(path.join(rootDir, 'budgets.json'), 'slow').entries.map((item) => [item.value, item.at]), [[42, CLOCK]])

    // 90ms is inside max=100 but 114% worse than 42 → BLOCK on the ratchet alone.
    const worse = stubRunner([{ exitCode: 0, durationMs: 90 }])
    const second = await runBudgets({ cwd, config, rootDir, runner: worse.runner, now: () => CLOCK + 5 })
    assert.equal(second.ok === true ? second.state : '', 'BLOCK')
    const checks = second.ok === true ? second.evaluations[0]?.checks : []
    assert.equal(checkOf(checks, '上限')?.state, 'PASS', 'the absolute max still holds')
    assert.equal(checkOf(checks, '回归')?.state, 'FAIL', 'the regression is what fails')
})

test('budgets: a command that does not succeed is BLOCKed and nothing enters the baseline', async () => {
    const cwd = tempWorkspace('budget-exit-')
    const config = resolveConfig(budget())
    const runner = stubRunner([{ exitCode: 3, stdout: 'size=999', stderr: 'boom' }])
    const run = await runBudgets({ cwd, config, rootDir: path.join(cwd, '.dsh'), runner: runner.runner, now: () => CLOCK })
    assert.equal(run.ok, true)
    assert.equal(run.ok === true ? run.state : '', 'BLOCK')
    assert.match(run.ok === true ? run.evaluations[0]?.reason ?? '' : '', /命令没有成功执行（命令退出码 3）/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'budgets.json')), false)
})

// --- refusals -------------------------------------------------------------

test('budgets: a regex that matches nothing is a refusal naming the command, and writes nothing', async () => {
    const cwd = tempWorkspace('budget-nomatch-')
    const config = resolveConfig(budget())
    const runner = stubRunner([{ exitCode: 0, stdout: 'no size here' }])
    const run = await runBudgets({ cwd, config, rootDir: path.join(cwd, '.dsh'), runner: runner.runner })
    assert.equal(run.ok, false)
    const problem = run.ok === false ? run.problem : ''
    assert.match(problem, /正则没有匹配到任何数字/)
    assert.match(problem, /命令：node size\.mjs/)
    assert.match(problem, /正则：\/size=\(\\d\+\)\//)
    assert.match(problem, /下一步/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false, 'a refusal writes no baseline')
})

test('budgets: a capture that is not a number is a refusal, never a 0', async () => {
    const cwd = tempWorkspace('budget-unparsable-')
    const config = resolveConfig(
        budget({ budgets: [{ id: 'bundle', name: '体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\S+)' }] }),
    )
    const runner = stubRunner([{ exitCode: 0, stdout: 'size=1.2kB' }])
    const run = await runBudgets({ cwd, config, rootDir: path.join(cwd, '.dsh'), runner: runner.runner })
    assert.equal(run.ok, false)
    const problem = run.ok === false ? run.problem : ''
    assert.match(problem, /捕获到的内容不是数字（"1\.2kB"）/)
    assert.match(problem, /绝不退化成 0/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false)
})

test('budgets: a corrupt baseline file is a refusal (never read as "no history")', async () => {
    const cwd = tempWorkspace('budget-corrupt-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'budgets.json'), '{ "budgets": { "bundle": [ {"value": 1')
    const config = resolveConfig(budget())
    const runner = stubRunner([{ exitCode: 0, stdout: 'size=1000' }])
    const run = await runBudgets({ cwd, config, rootDir: path.join(cwd, '.dsh'), runner: runner.runner })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /存在但无法解析为 JSON/)
})

// --- tool surface ---------------------------------------------------------

test('budget_check: records a PASS gate row whose scope names the budgets, and never authorises delivery', async () => {
    const cwd = tempWorkspace('budget-tool-')
    const fake = host(cwd, budget(), [{ exitCode: 0, stdout: 'size=1200' }])
    const missionId = bindMission(cwd)
    const run = await fake.runTool('budget_check', {})
    const text = runText(run)
    assert.equal(run.isError, false)
    assert.match(text, /预算门禁：PASS/)
    assert.match(text, /基线已记录/)
    assert.match(text, /scope\.full` 恒为 false/)

    const store = new MissionStoreRegistry().for(cwd)
    const gate = store.lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.scope, { selected: ['bundle'], total: 1, full: false })
    assert.deepEqual(gate?.results.map((result) => result.id), ['bundle'])
    assert.equal(gate?.results[0]?.exitCode, 0)
    assert.match(gate?.reason ?? '', /预算裁决/)
    assert.ok(store.readEvidence(missionId).some((entry) => entry.kind === 'gate'))
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'budgets.json')), true)
})

test('budget_check: a violated budget BLOCKs the recorded verdict', async () => {
    const cwd = tempWorkspace('budget-tool-block-')
    const fake = host(cwd, budget(), [{ exitCode: 0, stdout: 'size=9999' }])
    const missionId = bindMission(cwd, '越界')
    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, false)
    assert.match(runText(run), /预算门禁：BLOCK/)
    const gate = new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.results[0]?.exitCode, 1)
})

test('budget_check: refuses without a workspace, an unknown mission or an unknown budget, writing nothing', async () => {
    const cwd = tempWorkspace('budget-tool-refusal-')
    const fake = host(cwd, budget(), [{ exitCode: 0, stdout: 'size=1200' }])
    const before = snapshot(path.join(cwd, '.dsh'))

    const noWorkspace = await fake.runTool('budget_check', {}, { agent: { id: 'a', session: { id: 's', header: {} } } })
    assert.equal(noWorkspace.isError, true)
    assert.match(runText(noWorkspace), /无法确定本会话的工作区/)

    const unknownMission = await fake.runTool('budget_check', { missionId: 'nope' })
    assert.equal(unknownMission.isError, true)
    assert.match(runText(unknownMission), /未知 mission "nope"/)

    const unknownBudget = await fake.runTool('budget_check', { only: ['nope'] })
    assert.equal(unknownBudget.isError, true)
    assert.match(runText(unknownBudget), /请求的预算不存在：nope/)

    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, 'refusals must not write anything')
    assert.deepEqual(fake.spawns, [], 'a refusal must not run a command either')
})

test('budget_check: a regex mismatch at tool level refuses and leaves .dsh untouched', async () => {
    const cwd = tempWorkspace('budget-tool-nomatch-')
    const fake = host(cwd, budget(), [{ exitCode: 0, stdout: 'size=unknown' }])
    bindMission(cwd, '无匹配')
    const before = snapshot(path.join(cwd, '.dsh'))
    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, true)
    assert.match(runText(run), /正则没有匹配到任何数字/)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before)
})

// --- project overlay ------------------------------------------------------

test('budgets: a project file replaces the list; forbidden keys and broken entries are reported', () => {
    const cwd = tempWorkspace('budget-overlay-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({
            budgets: [
                { id: 'local', metric: 'number', command: 'node local.mjs', regex: 'n=(\\d+)', max: 10 },
                { id: 'broken', metric: 'nonsense', command: 'x' },
            ],
            // Host-only: a project may not relocate the log or switch the gate off.
            logFile: '/tmp/elsewhere.log',
            enabled: false,
        }),
    )
    const hostConfig = resolveConfig(budget({ budgets: [{ id: 'profile', metric: 'durationMs', command: 'x' }] }))
    const store = new MissionStoreRegistry().for(cwd)
    const effective = resolveEffectiveConfig(hostConfig, store.layout)
    assert.equal(effective.source, 'project')
    assert.deepEqual(effective.config.budgets.map((entry) => entry.id), ['local', 'broken'])
    assert.equal(effective.config.enabled, true, 'a project cannot switch the gate off')
    assert.match(effective.problems.join('\n'), /键 "logFile" 不允许在项目级配置里覆盖/)
    assert.match(effective.problems.join('\n'), /键 "enabled" 不允许在项目级配置里覆盖/)
    assert.match(effective.problems.join('\n'), /metric 必须是 durationMs \/ number \/ bytes/)
    // A project-level baselineFile is resolved against the workspace, not the trail.
    assert.equal(
        baselineFileFor({ id: 'local', name: 'local', metric: 'number', baselineFile: 'baselines/b.json' }, { cwd, rootDir: store.layout.rootDir }),
        path.join(cwd, 'baselines', 'b.json'),
    )
})

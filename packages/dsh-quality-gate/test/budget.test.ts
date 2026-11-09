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
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
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
    DEFAULT_BASELINE_LOCK_RETRY_MS,
    DEFAULT_BASELINE_LOCK_STALE_MS,
    MAX_BASELINE_LOCK_RETRY_MS,
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

// --- adversarial-audit regressions: the baseline file is never someone else's ---

test('budgets: a project-level baselineFile outside the workspace is refused and keeps the default', () => {
    const cwd = tempWorkspace('budget-escape-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({
            budgets: [
                { id: 'outside', metric: 'number', command: 'node size.mjs', regex: 'n=(\\d+)', max: 10, baselineFile: '../other-project/budgets.json' },
                { id: 'local', metric: 'number', command: 'node size.mjs', regex: 'n=(\\d+)', max: 10, baselineFile: 'baselines/b.json' },
            ],
        }),
    )
    const hostConfig = resolveConfig(budget({ budgets: [{ id: 'profile', metric: 'durationMs', command: 'x' }] }))
    const store = new MissionStoreRegistry().for(cwd)
    const effective = resolveEffectiveConfig(hostConfig, store.layout)
    assert.match(effective.problems.join('\n'), /预算 "outside" 的 baselineFile 必须指向工作区内的路径/)
    assert.equal(effective.config.budgets.find((entry) => entry.id === 'outside')?.baselineFile, undefined, 'the escaping value is dropped, not honoured')
    assert.equal(
        baselineFileFor(effective.config.budgets.find((entry) => entry.id === 'outside') as BudgetConfig, { cwd, rootDir: store.layout.rootDir }),
        path.join(store.layout.rootDir, 'budgets.json'),
    )
    assert.equal(effective.config.budgets.find((entry) => entry.id === 'local')?.baselineFile, 'baselines/b.json', 'a workspace-relative relocation stays allowed')
})

test('budgets: a run refuses a baselineFile outside the workspace and writes nothing there', async () => {
    const root = tempWorkspace('budget-escape-run-')
    const cwd = path.join(root, 'repo')
    const victim = path.join(root, 'other-project', 'budgets.json')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(path.dirname(victim), { recursive: true })
    const owned = '{ "note": "another tool owns this file" }\n'
    fs.writeFileSync(victim, owned)
    const config = resolveConfig(
        budget({
            budgets: [{ id: 'size', name: 'size', metric: 'number', command: 'node -e "console.log(42)"', regex: '([0-9]+)', max: 100, baselineFile: victim }],
        }),
    )
    const runner = stubRunner([{ exitCode: 0, stdout: '42' }])
    const run = await runBudgets({ cwd, config, rootDir: path.join(cwd, '.dsh'), runner: runner.runner, now: () => CLOCK })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /必须指向工作区内的路径/)
    assert.match(run.ok === false ? run.problem : '', /没有跑任何命令，也没有写入基线/)
    assert.equal(runner.specs.length, 0, 'nothing is executed once the write target is refused')
    assert.equal(fs.readFileSync(victim, 'utf8'), owned, 'the other project\'s file is untouched')
})

test('budgets: a foreign JSON document is not "no history", and appending never replaces it', () => {
    const file = path.join(tempWorkspace('budget-foreign-'), 'someone-elses.json')
    const foreign = JSON.stringify({ keep: 'this matters', other: { a: 1 } }, null, 2) + '\n'
    fs.writeFileSync(file, foreign)
    const read = readBaseline(file, 'b')
    assert.deepEqual(read.entries, [])
    assert.match(read.problem ?? '', /不是本门禁的基线文档/)
    assert.match(read.problem ?? '', /keep, other/)
    assert.throws(
        () => appendBaseline(file, 'b', { at: CLOCK, value: 5, metric: 'number', unit: 'count', command: 'x', exitCode: 0 }),
        /拒绝写入基线文件/,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), foreign, 'the document is left exactly as it was')
    // An empty-but-shaped baseline document is still usable.
    const shaped = path.join(path.dirname(file), 'budgets.json')
    fs.writeFileSync(shaped, '{ "version": 1, "budgets": {} }\n')
    assert.deepEqual(readBaseline(shaped, 'b'), { entries: [] })
    appendBaseline(shaped, 'b', { at: CLOCK, value: 5, metric: 'number', unit: 'count', command: 'x', exitCode: 0 })
    assert.deepEqual(readBaseline(shaped, 'b').entries.map((entry) => entry.value), [5])
})

// --- 2026-09 follow-up audit: the baseline lock -----------------------------

/** A baseline entry, with the value the only thing a test cares about. */
function sample(at: number, value: number): BaselineEntry {
    return { at, value, metric: 'number', unit: 'count', command: 'x', exitCode: 0 }
}

/**
 * The failure a worker throws on purpose in the diagnosis test. It is deliberately
 * distinctive: if it ever shows up as `屏障未会合`, the worker's own error was lost.
 */
const INJECTED_WORKER_FAILURE = '注入的 worker 自身错误：appendBaseline 之前的意外失败'

/** One writer's report, exactly as the worker body posts it. */
interface WriterReport {
    ok: boolean
    /** The worker's own stack, posted only when `ok` is false. */
    error?: string
    /** Length of the document the writer read before appending. */
    before?: number
    /** The budget ids in the document after its append. */
    keys?: string[]
}

/** How the diagnosis test bends one worker's body before it does any real work. */
interface WriterLaunch {
    /** An error message the worker body throws before touching anything else. */
    failWith?: string
    /** Exit the worker with this code WITHOUT posting a report (a silent failure). */
    exitSilently?: number
}

/**
 * The body of one writer worker: a real second thread, a real `appendBaseline`, and
 * a rendezvous that releases both writers within microseconds of each other.
 *
 * A worker NEVER dies silently: its whole body is inside the `try`, so any failure
 * becomes a report carrying its own stack. Otherwise the main thread only sees a
 * dead worker and the surviving one's rendezvous timeout — a failure that names
 * somebody else.
 */
function writerSource(): string {
    return `
        import { parentPort, workerData } from 'node:worker_threads'
        import fs from 'node:fs'
        const barrier = new Int32Array(workerData.barrier)
        const index = workerData.value - 1
        const file = workerData.file
        try {
            // The diagnosis test launches one worker that throws HERE: what comes out
            // is either this message (the worker reported itself) or a barrier timeout
            // (it did not, and the failure was disguised as somebody else's).
            if (workerData.failWith !== undefined) throw new Error(workerData.failWith)
            // ...and one that dies without a report, which the main thread must fail
            // with the exit facts instead of resolving into "both writers finished".
            if (workerData.exitSilently !== undefined) process.exit(workerData.exitSilently)
            const entry = { at: Date.now(), value: workerData.value, metric: 'number', unit: 'count', command: 'x', exitCode: 0 }
            // A counting barrier for exactly these two writers, implemented with a
            // pure spin (no Atomics.wait: its timeout can fire even after another
            // agent changed the slot, which makes the release unreliable). Writers 1
            // and 2 arrive, the LAST one pushes the counter to 3, and both then spin
            // until they observe it — so they leave this line within microseconds of
            // each other, which is what makes the read-modify-write window a window.
            // EVERY access to the SharedArrayBuffer goes through Atomics: a plain
            // \`barrier[index] = 1\` is not a guaranteed-visible write across workers,
            // and an invisible arrival is exactly the phantom this test must not have.
            Atomics.store(barrier, index, 1)
            if (Atomics.add(barrier, 2, 1) === 1) Atomics.store(barrier, 2, 3)
            const started = Date.now()
            const deadline = started + 5000
            while (Atomics.load(barrier, 2) !== 3) {
                if (Date.now() > deadline) {
                    throw new Error(
                        '屏障未会合（另一个 worker 未到达屏障）：worker ' + index + ' 自旋了 ' +
                        Math.round((Date.now() - started) / 1000) + 's，计数仍是 ' + Atomics.load(barrier, 2) +
                        '（应为 3），所以这一次没有同时进入读-改-写窗口',
                    )
                }
            }
            const before = fs.readFileSync(file, 'utf8')
            let spin = 0
            while (spin < 500000) spin += 1
            const { appendBaseline } = await import(workerData.modulePath)
            appendBaseline(file, 'b', entry, { lockRetryMs: 10000 })
            const document = JSON.parse(fs.readFileSync(file, 'utf8'))
            parentPort.postMessage({ ok: true, before: before.length, keys: Object.keys(document.budgets) })
        } catch (error) {
            // The main thread gets THIS stack, not a rendezvous timeout: a worker that
            // fails must name its own cause.
            parentPort.postMessage({ ok: false, error: String(error?.stack ?? error) })
        }
    `
}

/**
 * Launch one writer per value and settle when each has reported.
 *
 * - a report is the worker's own account (`ok: false` carries its stack);
 * - a worker that exits WITHOUT a report fails the run with its exit facts and its
 *   index, instead of resolving into a misleading "both writers finished";
 * - worker 'error' events are still listened for and still reject.
 */
async function spawnWriters(
    file: string,
    modulePath: string,
    values: readonly number[],
    launch: WriterLaunch = {},
): Promise<{ barrier: Int32Array; reports: WriterReport[] }> {
    const barrier = new Int32Array(new SharedArrayBuffer(16))
    const reports: WriterReport[] = []
    await Promise.all(
        values.map(
            (value) =>
                new Promise<void>((resolve, reject) => {
                    const index = value - 1
                    const instance = new Worker(writerSource(), {
                        eval: true,
                        type: 'module',
                        workerData: {
                            file,
                            modulePath,
                            value,
                            barrier: barrier.buffer,
                            failWith: launch.failWith,
                            exitSilently: launch.exitSilently,
                        },
                    })
                    let reported = false
                    instance.on('message', (message: WriterReport) => {
                        reported = true
                        reports.push(message)
                        resolve()
                    })
                    instance.on('error', reject)
                    instance.on('exit', (code, signal) => {
                        if (reported) return
                        // The report may still be queued behind this event: give the
                        // port one turn before calling the worker silent.
                        setImmediate(() => {
                            if (reported) return
                            reject(
                                new Error(
                                    `worker ${index} 没有上报任何结果就退出了（exit code=${code}, signal=${signal ?? 'none'}）：` +
                                        '它自己的错误没有被上报，所以这次并发的结论不可信（这不是屏障超时）',
                                ),
                            )
                        })
                    })
                }),
        ),
    )
    return { barrier, reports }
}

test(
    'budgets: two concurrent writers both end up in the history (an append is never lost)',
    // Serially: the rendezvous only proves something if both writers really get a
    // core at the same time, so this pair must not compete with another test's work.
    { concurrency: false },
    async () => {
        const cwd = tempWorkspace('budget-lock-race-')
        const file = path.join(cwd, 'budgets.json')
        fs.writeFileSync(file, `${JSON.stringify({ version: 1, budgets: {} }, null, 2)}\n`)
        // The compiled module, so a REAL second process does the writing: this test's
        // claim is about concurrency, and an interleaved stub cannot make it.
        const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/budget.js')
        const { barrier, reports } = await spawnWriters(file, modulePath, [1, 2])
        assert.equal(Atomics.load(barrier, 0), 1, 'writer 1 reached the barrier')
        assert.equal(Atomics.load(barrier, 1), 1, 'writer 2 reached the barrier')
        assert.equal(reports.length, 2, 'both writers finished')
        assert.deepEqual(
            reports.map((report) => report.ok),
            [true, true],
            `both writers must succeed, and a failure carries its own stack: ${JSON.stringify(reports)}`,
        )
        const entries = readBaseline(file, 'b').entries
        assert.deepEqual(
            entries.map((entry) => entry.value).sort((left, right) => left - right),
            [1, 2],
            'both measurements are in the append-only history: one was not overwritten by the other',
        )
    },
)

test(
    'budgets: a worker that throws reports ITS OWN error, never a barrier timeout (the diagnosis path)',
    { concurrency: false },
    async () => {
        const cwd = tempWorkspace('budget-lock-race-diagnosis-')
        const file = path.join(cwd, 'budgets.json')
        fs.writeFileSync(file, `${JSON.stringify({ version: 1, budgets: {} }, null, 2)}\n`)
        const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/budget.js')

        // 1. ONE worker, and it throws before the barrier: the only two outcomes are
        // its own report (item 2 holds) or a silently dead worker whose failure the
        // main thread would misread. A failed writer must never be reported as "the
        // other one was slow to reach the barrier".
        const { reports } = await spawnWriters(file, modulePath, [1], { failWith: INJECTED_WORKER_FAILURE })
        assert.equal(reports.length, 1, 'the worker posted its own report instead of dying silently')
        assert.equal(reports[0]?.ok, false, 'the report says the worker failed')
        assert.ok(
            String(reports[0]?.error).includes(INJECTED_WORKER_FAILURE),
            `the worker's own error reaches the main thread verbatim: ${String(reports[0]?.error)}`,
        )
        assert.doesNotMatch(
            String(reports[0]?.error),
            /屏障未会合|barrier timeout/,
            'the failure is not disguised as a rendezvous timeout',
        )

        // 2. A worker that dies WITHOUT posting: the run must fail naming the exit
        // facts and the worker index, never resolve into "both writers finished".
        await assert.rejects(
            () => spawnWriters(file, modulePath, [1], { exitSilently: 7 }),
            (error: unknown) => {
                const message = String((error as Error).message)
                assert.match(message, /worker 0 没有上报任何结果就退出了/)
                assert.match(message, /exit code=7/)
                assert.match(message, /signal=none/)
                assert.doesNotMatch(message, /屏障未会合|barrier timeout/, 'a silent death is not a rendezvous timeout either')
                return true
            },
        )
        assert.deepEqual(readBaseline(file, 'b').entries, [], 'neither failed worker wrote anything')

        // Verified by temporarily reverting each item in this file and watching this
        // test go red, then restoring it byte-for-byte from a copy in /tmp:
        //  - item 2 reverted (no try/catch around the worker body): the throwing
        //    worker dies as an uncaught 'error', `spawnWriters` rejects and no report
        //    ever arrives — the `await` above throws, RED.
        //  - item 4 reverted (`exit` resolves regardless of a report): the silent
        //    worker resolves, so `assert.rejects` fails with "Missing expected
        //    rejection", RED.
    },
)

test('budgets: a stale lock file is reported with its path and age, and refused (never waited out)', () => {
    const cwd = tempWorkspace('budget-lock-stale-')
    const file = path.join(cwd, 'budgets.json')
    const lock = `${file}.lock`
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, budgets: { b: [sample(CLOCK, 1)] } }, null, 2)}\n`)
    const before = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(lock, `${JSON.stringify({ pid: 4242, at: CLOCK - 120_000, file })}\n`)
    const problems: string[] = []
    assert.throws(
        () =>
            appendBaseline(file, 'b', sample(CLOCK, 2), {
                now: () => CLOCK,
                sleep: () => problems.push('sleep called'),
            }),
        (error: unknown) => {
            const message = String((error as Error).message)
            assert.match(message, /已过期/)
            assert.match(message, /budgets\.json\.lock/)
            assert.match(message, /120s/)
            assert.match(message, /pid=4242/)
            assert.match(message, /手动删除/)
            assert.match(message, /不会自动删掉这个锁/)
            return true
        },
    )
    assert.deepEqual(problems, [], 'a stale lock is refused outright — it is never waited on')
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the baseline document is untouched')
    assert.equal(fs.existsSync(lock), true, 'the stale lock is left for a human to remove')
})

test('budgets: a live lock makes the second writer wait, then refuses loudly (no silent skip)', async () => {
    const cwd = tempWorkspace('budget-lock-live-')
    const file = path.join(cwd, 'budgets.json')
    const lock = `${file}.lock`
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, budgets: {} }, null, 2)}\n`)
    // A live lock (age 2s, well under the 30s stale bound) owned by this process.
    fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: CLOCK - 2_000, file })}\n`)
    const sleeps: number[] = []
    assert.throws(
        () =>
            appendBaseline(file, 'b', sample(CLOCK, 1), {
                now: () => CLOCK,
                lockRetryMs: 200,
                lockSleepMs: 30,
                sleep: (ms) => sleeps.push(ms),
            }),
        (error: unknown) => {
            const message = String((error as Error).message)
            assert.match(message, /等待基线文件 .* 的锁超时（200ms/)
            assert.match(message, /budgets\.json\.lock/)
            assert.match(message, /该锁的年龄约 2s/)
            assert.match(message, /不会丢测量|丢失其中一次测量/)
            return true
        },
    )
    assert.equal(sleeps.length > 0, true, 'the retry loop really waited (with the injected sleep)')
    assert.deepEqual(readBaseline(file, 'b').entries, [], 'nothing was appended without the lock')

    // Through the run: the refusal is the tool-level refusal, not a lost append.
    // The default baseline lives at `<rootDir>/budgets.json`, so that is where the
    // live lock has to be for a `budget_check` to meet it.
    const rootDir = path.join(cwd, '.dsh')
    const defaultFile = path.join(rootDir, 'budgets.json')
    fs.mkdirSync(rootDir, { recursive: true })
    // On the INJECTED clock, like every other age in this file: `at: Date.now() - 2000`
    // would be 2s old only against the real clock, and a 28s stall would turn it into
    // a stale lock (30s default) and route the run down a different refusal path.
    fs.writeFileSync(`${defaultFile}.lock`, `${JSON.stringify({ pid: process.pid, at: CLOCK - 2_000, file: defaultFile })}\n`)
    const run = await runBudgets({
        cwd,
        config: resolveConfig(budget()),
        rootDir,
        runner: stubRunner([{ exitCode: 0, stdout: 'size=1000' }]).runner,
        now: () => CLOCK,
        baselineLockRetryMs: 100,
        baselineLockStaleMs: 60_000,
        lockSleep: () => undefined,
    })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /锁超时/)
    assert.match(run.ok === false ? run.problem : '', /没有写入/)
    assert.deepEqual(readBaseline(defaultFile, 'bundle').entries, [], 'a refused run writes no history')
    assert.equal(fs.existsSync(defaultFile), false, 'a refused run does not invent a baseline document either')

    // Release it by hand: the next append works, which is the documented fix.
    fs.unlinkSync(lock)
    appendBaseline(file, 'b', sample(CLOCK, 1), { lockRetryMs: 50 })
    assert.deepEqual(readBaseline(file, 'b').entries.map((entry) => entry.value), [1])
    assert.equal(fs.existsSync(lock), false, 'the lock is always released, including after a successful append')
})

test('budgets: the lock file is created exclusively, written atomically and always released', () => {
    const cwd = tempWorkspace('budget-lock-shape-')
    const file = path.join(cwd, 'budgets.json')
    const lock = `${file}.lock`
    // A document that must be refused on the WRITE side: the lock is still taken
    // and still released (a lock left behind would refuse every later run).
    fs.writeFileSync(file, JSON.stringify({ someone: 'else' }))
    assert.throws(
        () => appendBaseline(file, 'b', sample(CLOCK, 1), { lockRetryMs: 50 }),
        /拒绝写入基线文件/,
    )
    assert.equal(fs.existsSync(lock), false, 'the finally released the lock on the refusal path')
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ someone: 'else' }), 'the foreign document is untouched')

    // A crash mid-write cannot truncate the document: the new bytes arrive by
    // rename, so the previous COMPLETE document is what a reader ever sees.
    const shaped = path.join(cwd, 'other.json')
    fs.writeFileSync(shaped, `${JSON.stringify({ version: 1, budgets: {} }, null, 2)}\n`)
    appendBaseline(shaped, 'b', sample(CLOCK, 1), { lockRetryMs: 50 })
    appendBaseline(shaped, 'b', sample(CLOCK + 1, 2), { lockRetryMs: 50 })
    assert.deepEqual(readBaseline(shaped, 'b').entries.map((entry) => entry.value), [1, 2])
    assert.deepEqual(
        fs.readdirSync(cwd).filter((entry) => entry.includes('.tmp-')),
        [],
        'the atomic write leaves no temp file behind',
    )

    // Two concurrent writers on the SAME document cannot both hold the lock: the
    // second `wx` create fails while the first is alive. (`held.json.lock` holds a
    // real record, so the holder is "alive", not an unreadable orphan.)
    const heldTarget = path.join(cwd, 'held.json')
    const held = `${heldTarget}.lock`
    fs.writeFileSync(held, `${JSON.stringify({ pid: process.pid, at: Date.now(), file: heldTarget })}\n`)
    try {
        assert.throws(
            () =>
                appendBaseline(heldTarget, 'b', sample(CLOCK, 1), {
                    lockRetryMs: 0,
                    sleep: () => undefined,
                }),
            /锁超时/,
        )
    } finally {
        fs.unlinkSync(held)
    }
    // An unreadable/orphaned lock (no record at all) is refused as stale, with the
    // manual-removal instruction — never "wait for it" and never deleted for the
    // other run: this is the shape a crash mid-create leaves behind.
    fs.writeFileSync(held, '')
    try {
        // Semantics changed on 2026-11-09: an empty lock file is "the owner is
        // mid-publication or crashed", NOT "the lock expired". The refusal says
        // it cannot determine the age and deliberately does not invite deletion.
        assert.throws(
            () => appendBaseline(heldTarget, 'b', sample(CLOCK, 1), { lockRetryMs: 0 }),
            /无法判定[\s\S]*没有进程在写/,
        )
    } finally {
        fs.unlinkSync(held)
    }
})

test('budgets: the lock bounds are host keys with defaults, a ceiling and a reported unusable value', () => {
    const defaults = resolveConfig({})
    assert.equal(defaults.baselineLockRetryMs, DEFAULT_BASELINE_LOCK_RETRY_MS)
    assert.equal(defaults.baselineLockRetryMs, 2_000)
    assert.equal(defaults.baselineLockStaleMs, DEFAULT_BASELINE_LOCK_STALE_MS)
    assert.equal(defaults.baselineLockStaleMs, 30_000)
    assert.equal(MAX_BASELINE_LOCK_RETRY_MS, 10_000)

    assert.equal(resolveConfig({ baselineLockRetryMs: 250 }).baselineLockRetryMs, 250)
    assert.equal(resolveConfig({ baselineLockRetryMs: 0 }).baselineLockRetryMs, 0, '0 is a real value: fail fast')
    const problems: string[] = []
    assert.equal(
        resolveConfig({ baselineLockRetryMs: 60_000 }, (message) => problems.push(message)).baselineLockRetryMs,
        MAX_BASELINE_LOCK_RETRY_MS,
        'waiting for a lock may not become a hang',
    )
    assert.match(problems.join('\n'), /baselineLockRetryMs=60000 超过上限 10000/)
    for (const bad of ['2000', -1, 1.5, null, {}]) {
        const warnings: string[] = []
        const resolved = resolveConfig({ baselineLockStaleMs: bad }, (message) => warnings.push(message))
        assert.equal(resolved.baselineLockStaleMs, DEFAULT_BASELINE_LOCK_STALE_MS, `${JSON.stringify(bad)} is not usable`)
        assert.match(warnings.join('\n'), /baselineLockStaleMs 必须是 0 或正整数/)
    }
    // Host-only: a project file may not shorten the wait and start losing appends.
    const projectCwd = tempWorkspace('budget-lock-project-')
    const layout = new MissionStoreRegistry().for(projectCwd).layout
    fs.mkdirSync(layout.rootDir, { recursive: true })
    fs.writeFileSync(
        path.join(layout.rootDir, 'quality-gate.json'),
        JSON.stringify({ baselineLockRetryMs: 1, baselineLockStaleMs: 1, budgets: [] }),
    )
    const { config, problems: projectProblems } = resolveEffectiveConfig(resolveConfig({}), layout)
    assert.equal(config.baselineLockRetryMs, DEFAULT_BASELINE_LOCK_RETRY_MS, 'the lock bounds stay the host\'s')
    assert.equal(config.baselineLockStaleMs, DEFAULT_BASELINE_LOCK_STALE_MS)
    assert.match(projectProblems.join('\n'), /键 "baselineLockRetryMs" 不允许在项目级配置里覆盖/)
    assert.match(projectProblems.join('\n'), /键 "baselineLockStaleMs" 不允许在项目级配置里覆盖/)
})

// --- 锁语义：不可读 ≠ 过期（2026-11-09 门禁抓到的并发失败） --------------------

/** Create a lock file whose content cannot be read as a record. */
function writeEmptyLock(file: string): string {
    const lockPath = `${file}.lock`
    fs.writeFileSync(lockPath, '')
    return lockPath
}

function writeLockRecord(file: string, at: number): string {
    const lockPath = `${file}.lock`
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, at, file })}\n`)
    return lockPath
}

test('an UNREADABLE lock is waited for, not declared stale (regression: two writers, one lost)', () => {
    const dir = tempWorkspace('budget-lock-unreadable-')
    const file = path.join(dir, 'budgets.json')
    appendBaseline(file, 'b', sample(CLOCK, 1))
    const lockPath = writeEmptyLock(file)
    // The injected sleep PLAYS the other writer: its first wake publishes a valid
    // record (the publication window closing), the second releases the lock. A
    // real timer cannot be used here — the retry sleep is `Atomics.wait`, which
    // blocks the event loop, so a `setTimeout` would never fire and the test would
    // assert on its own harness instead of on the lock.
    let wakes = 0
    const publishThenRelease = (): void => {
        wakes += 1
        if (wakes === 1) {
            fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 7, at: Date.now(), file })}\n`)
            return
        }
        if (wakes === 2) {
            try {
                fs.unlinkSync(lockPath)
            } catch {
                // already gone
            }
        }
    }
    try {
        appendBaseline(file, 'b', sample(CLOCK + 1_000, 2), {
            lockRetryMs: 3_000,
            lockSleepMs: 20,
            sleep: publishThenRelease,
        })
    } finally {
        try {
            fs.unlinkSync(lockPath)
        } catch {
            // already released
        }
    }
    assert.equal(readBaseline(file, 'b').entries.length, 2, 'the second append must not be lost')
})

test('an unreadable lock that never resolves refuses with 无法判定 and does NOT advise deleting it', () => {
    const dir = tempWorkspace('budget-lock-unreadable-refuse-')
    const file = path.join(dir, 'budgets.json')
    appendBaseline(file, 'b', sample(CLOCK, 1))
    writeEmptyLock(file)
    let message = ''
    try {
        appendBaseline(file, 'b', sample(CLOCK + 1_000, 2), { lockRetryMs: 120, lockSleepMs: 10 })
    } catch (error) {
        message = (error as Error).message
    }
    assert.match(message, /无法判定/)
    assert.doesNotMatch(message, /手动删除/, 'deleting an unreadable lock is how measurements get lost')
    assert.match(message, /没有进程在写/, 'the next step must be "check for a live writer", not "delete it"')
})

test('a readable lock past the stale bound still refuses as EXPIRED, with its age', () => {
    const dir = tempWorkspace('budget-lock-stale-')
    const file = path.join(dir, 'budgets.json')
    appendBaseline(file, 'b', sample(CLOCK, 1))
    writeLockRecord(file, Date.now() - 10 * 60_000)
    assert.throws(
        () => appendBaseline(file, 'b', sample(CLOCK + 1_000, 2), { lockRetryMs: 100, lockStaleMs: 1_000 }),
        /已过期/,
    )
})

test('a readable lock INSIDE the stale bound waits, then refuses as HELD (not expired)', () => {
    const dir = tempWorkspace('budget-lock-held-')
    const file = path.join(dir, 'budgets.json')
    appendBaseline(file, 'b', sample(CLOCK, 1))
    writeLockRecord(file, Date.now())
    let message = ''
    try {
        appendBaseline(file, 'b', sample(CLOCK + 1_000, 2), { lockRetryMs: 120, lockSleepMs: 10 })
    } catch (error) {
        message = (error as Error).message
    }
    assert.match(message, /仍被占用/)
    assert.doesNotMatch(message, /已过期/, 'a live lock is not an expired one')
})

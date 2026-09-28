/**
 * dsh-impact-gate flaky plans: classification, the quarantine deadline (and the
 * refusal to quarantine without an owner), own-run mode over a scripted
 * subprocess, the plan artifact, and the read-only status.
 *
 * No real command is ever spawned: own-run mode is fed by a fake
 * `ctx.subprocess`, so the observed "runs" are exactly the ones this file wrote.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, clearProjectConfigCache } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { PROJECT_OVERRIDABLE_KEYS, resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import {
    buildPlan,
    clampRuns,
    classifyTally,
    compileSignatures,
    currentQuarantines,
    expiredQuarantines,
    matchSignature,
    observeRuns,
    parseNamedTests,
    parseReport,
    quarantineCommandFor,
    quarantineFileFor,
    readQuarantine,
    tallyRuns,
    unseenQuarantines,
    BUILTIN_SIGNATURES,
    MAX_FLAKY_RUNS,
    type FlakySignature,
    type ObservedRun,
    type QuarantineRow,
    type TestTally,
} from '../dist/flaky.js'

/** One scripted `ctx.subprocess` reply. */
interface Step {
    exitCode?: number | null
    stdout?: string
    stderr?: string
    timedOut?: boolean
}

/** A `ctx.subprocess` answering with the script, in order. */
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
                const collected = { stdout: step.stdout ?? '', stderr: step.stderr ?? '' }
                return {
                    done: Promise.resolve({ exitCode: step.exitCode ?? 0, signal: null }),
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
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-gate-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in `cwd`. */
function host(cwd: string, config: Record<string, unknown> = {}, script: readonly Step[] = []): FakeHost & { spawns: { argv: readonly string[]; cwd: string }[] } {
    const scripted = scriptedService(script)
    const fake = createFakeHost({ cwd, services: { subprocess: scripted.service } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return Object.assign(fake, { spawns: scripted.spawns })
}

/** Every file under `dir`, relative path → content. */
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

/** A mission bound to the fake host's session. */
function bindMission(cwd: string, id = 'm1'): MissionStoreRegistry {
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ id, title: 'flaky 测试', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', id)
    return stores
}

/** Write a quarantine ledger row (JSONL, append-only). */
function writeQuarantine(cwd: string, rows: readonly Record<string, unknown>[], trailingPartial = ''): string {
    const file = path.join(cwd, '.dsh', 'flaky-quarantine.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${trailingPartial}`)
    return file
}

const DAY = 24 * 60 * 60 * 1_000

// --- signatures and parsing ----------------------------------------------

test('flaky: the built-in signatures name the environment smells, and config can replace them', () => {
    assert.equal(matchSignature('panic: test timed out after 10m0s', BUILTIN_SIGNATURES)?.label, '超时')
    assert.equal(matchSignature('listen tcp :8080: bind: address already in use', BUILTIN_SIGNATURES)?.label, '端口被占用')
    assert.equal(matchSignature('assertion failed: expected 2, got 3', BUILTIN_SIGNATURES), undefined)

    const replaced = compileSignatures([{ pattern: 'ORA-\\d+', label: '数据库', advice: '先看数据库' }])
    assert.deepEqual(replaced.problems, [])
    assert.deepEqual(replaced.signatures.map((signature) => [signature.label, signature.source]), [['数据库', 'config']])
    assert.equal(matchSignature('ORA-01555 snapshot too old', replaced.signatures)?.label, '数据库')
    // An explicitly configured list REPLACES the built-ins (including with `[]`).
    assert.deepEqual(compileSignatures([]).signatures, [])
    assert.match(compileSignatures([{ pattern: '([' }]).problems.join('\n'), /不是合法正则/)
    assert.match(compileSignatures('nope').problems.join('\n'), /必须是数组/)
})

test('flaky: a report is parsed from either the coverage-gate artifact or a plain tally list', () => {
    const artifact = parseReport({
        kind: 'flaky',
        flakyTests: [{ name: 'TestUnstable', passed: 2, failed: 1, opaque: 0 }],
        stableTests: [{ name: 'TestStable', passed: 3, failed: 0, opaque: 0 }],
        inconclusiveTests: [{ name: 'TestFoggy', passed: 1, failed: 1, opaque: 1 }],
        runs: [{ index: 1, exitCode: 1, outcome: 'fail', timedOut: false }],
    })
    assert.equal('problem' in artifact, false)
    const tallies = 'tallies' in artifact ? artifact.tallies : []
    assert.deepEqual(
        tallies.map((tally) => [tally.name, tally.runs, tally.failures, tally.inconclusive === true]),
        [
            ['TestFoggy', 2, 1, true],
            ['TestStable', 3, 0, false],
            ['TestUnstable', 3, 1, false],
        ],
    )
    assert.match(('notes' in artifact ? artifact.notes : []).join('\n'), /没有携带失败输出/)

    const plain = parseReport({ tests: [{ name: 'TestX', runs: 4, failures: 1, firstFailingRun: 1, output: 'x' }] })
    assert.deepEqual('tallies' in plain ? plain.tallies.map((tally) => [tally.name, tally.runs, tally.failures, tally.firstFailingRun]) : [], [
        ['TestX', 4, 1, 1],
    ])

    // `times` is accepted as a count or as one entry per run.
    const byTimes = parseReport({ tests: [{ name: 'TestT', times: [true, false, true] }, { name: 'TestU', times: 4, failures: 0 }] })
    assert.deepEqual(
        'tallies' in byTimes ? byTimes.tallies.map((tally) => [tally.name, tally.runs, tally.failures, tally.firstFailingRun]) : [],
        [
            ['TestT', 3, 1, 2],
            ['TestU', 4, 0, undefined],
        ],
    )

    // Unreadable data is a refusal, never "no unstable tests".
    assert.match(parseReport({ nope: true }).problem ?? '', /没有任何用例计数/)
    assert.match(parseReport(42).problem ?? '', /顶层必须是对象或数组/)
    assert.match(parseReport({ flakyTests: 'nope' }).problem ?? '', /必须是数组/)
})

// --- classification -------------------------------------------------------

test('flaky: each test lands in exactly one bucket, from the report fixture', () => {
    const parsed = parseReport({
        tests: [
            { name: 'TestStable', runs: 3, failures: 0 },
            { name: 'TestUnstable', runs: 3, failures: 1 },
            { name: 'TestFirstRun', runs: 3, failures: 1, firstFailingRun: 1 },
            { name: 'TestAlwaysFails', runs: 3, failures: 3 },
            { name: 'TestTimeout', runs: 3, failures: 2, output: 'panic: test timed out after 10m0s' },
        ],
    })
    assert.equal('problem' in parsed, false)
    const tallies = 'tallies' in parsed ? parsed.tallies : []
    assert.deepEqual(
        tallies.map((tally) => [tally.name, classifyTally(tally, BUILTIN_SIGNATURES).classification]),
        [
            ['TestAlwaysFails', 'investigate'],
            ['TestFirstRun', 'investigate'],
            ['TestStable', 'stable'],
            ['TestTimeout', 'suspect-instrumentation'],
            ['TestUnstable', 'quarantine'],
        ],
    )
    assert.match(classifyTally({ name: 'TestTimeout', runs: 3, failures: 2, failureOutput: 'i/o timeout' }).action, /先查仪器\/环境/)
    assert.match(classifyTally({ name: 'x', runs: 3, failures: 1, failureOutput: 'x' }, []).classification, /investigate|quarantine/)
    // A 3-run tally failing once on run 1 is the setup/ordering pattern, not a quarantine.
    assert.match(classifyTally({ name: 'x', runs: 3, failures: 1, firstFailingRun: 1 }).evidence, /只在第 1 次运行失败/)
})

// --- own-run mode ---------------------------------------------------------

test('flaky: named tests are read from the runner output, and opaque runs are stated', () => {
    assert.deepEqual(parseNamedTests('--- FAIL: TestA (0.01s)\n--- PASS: TestB\n'), [
        { name: 'TestA', ok: false },
        { name: 'TestB', ok: true },
    ])
    assert.deepEqual(parseNamedTests('ok 1 - adds numbers\nnot ok 2 - divides\n'), [
        { name: 'adds numbers', ok: true },
        { name: 'divides', ok: false },
    ])
    const observed = observeRuns([
        { argv: [], command: 'x', cwd: '/tmp', exitCode: 0, signal: null, stdout: '--- PASS: TestA', stderr: '', durationMs: 1, timedOut: false },
        { argv: [], command: 'x', cwd: '/tmp', exitCode: 1, signal: null, stdout: '--- FAIL: TestA', stderr: '', durationMs: 1, timedOut: false },
        { argv: [], command: 'x', cwd: '/tmp', exitCode: 1, signal: null, stdout: 'boom', stderr: '', durationMs: 1, timedOut: false },
    ])
    assert.deepEqual(observed.runs.map((run) => [run.index, run.outcome, run.named.length]), [
        [1, 'pass', 1],
        [2, 'fail', 1],
        [3, 'fail', 0],
    ])
    assert.match(observed.notes.join('\n'), /第 3 次运行没有点名任何用例/)
    assert.match(observed.failureOutput, /--- 第 2 次运行 ---/)
    assert.deepEqual(
        tallyRuns(observed.runs, observed.failureOutput).map((tally) => [tally.name, tally.runs, tally.failures, tally.firstFailingRun]),
        [['TestA', 2, 1, 2]],
    )
    assert.deepEqual(clampRuns(undefined), 3)
    assert.deepEqual(clampRuns(1), 2)
    assert.deepEqual(clampRuns(99), MAX_FLAKY_RUNS)
})

// --- the quarantine ledger ------------------------------------------------

test('flaky: the ledger is append-only, newest row wins, and a truncated tail line is skipped', () => {
    const cwd = tempWorkspace('flaky-ledger-')
    const row = (at: number, owner: string, expiresAt: number): Record<string, unknown> => ({
        at,
        test: 'TestA',
        owner,
        expiresAt,
        reason: 'flaky',
        evidencePath: 'flaky/x-plan.json',
    })
    const file = writeQuarantine(cwd, [row(1_000, 'alice', 2_000), row(3_000, 'bob', 4_000)], '{"at":1790')
    const ledger = readQuarantine(file)
    assert.equal(ledger.rows.length, 2)
    assert.equal(ledger.problems.length, 1)
    assert.match(ledger.problems[0] ?? '', /不是合法 JSON（文件被截断的尾行，已跳过）/)
    const current = currentQuarantines(ledger.rows)
    assert.deepEqual(current.map((entry) => [entry.test, entry.owner]), [['TestA', 'bob']])
    assert.deepEqual(expiredQuarantines(current, 5_000).map((entry) => entry.owner), ['bob'])

    // A row without an owner is NOT a quarantine: it is reported as unusable.
    fs.writeFileSync(file, `${JSON.stringify({ at: 1, test: 'TestB', expiresAt: 2, reason: '', evidencePath: '' })}\n`)
    const owned = readQuarantine(file)
    assert.deepEqual(owned.rows, [])
    assert.match(owned.problems[0] ?? '', /没有 owner/)
    assert.deepEqual(readQuarantine(path.join(cwd, 'missing.json')), { rows: [], problems: [] })
})

test('flaky: unseen detection reads the last N runs, and does not judge a short window', () => {
    const runs: ObservedRun[] = [
        { index: 1, exitCode: 0, outcome: 'pass', timedOut: false, named: [{ name: 'TestA', ok: true }, { name: 'TestB', ok: true }] },
        { index: 2, exitCode: 0, outcome: 'pass', timedOut: false, named: [{ name: 'TestA', ok: true }] },
        { index: 3, exitCode: 0, outcome: 'pass', timedOut: false, named: [{ name: 'TestA', ok: true }] },
    ]
    const rows: QuarantineRow[] = [
        { at: 1, test: 'TestA', owner: 'alice', expiresAt: 9, reason: '', evidencePath: '' },
        { at: 2, test: 'TestGone', owner: 'bob', expiresAt: 9, reason: '', evidencePath: '' },
    ]
    assert.deepEqual(unseenQuarantines(rows, runs, 2).map((row) => row.test), ['TestGone'])
    assert.deepEqual(unseenQuarantines(rows, runs, 3).map((row) => row.test), ['TestGone'])
    // A window shorter than the threshold judges nothing (the caller says so).
    assert.deepEqual(unseenQuarantines(rows, runs.slice(0, 1), 3), [])
    assert.deepEqual(unseenQuarantines(rows, [], 3), [])
})

// --- the plan -------------------------------------------------------------

test('flaky: a plan refuses to quarantine an unowned test, and escalates an expired one', () => {
    const cwd = tempWorkspace('flaky-plan-owner-')
    const file = path.join(cwd, '.dsh', 'flaky-quarantine.json')
    const tallies: TestTally[] = [{ name: 'TestUnstable', runs: 3, failures: 1 }]
    const options = {
        cwd,
        quarantineFile: file,
        now: 1_700_000_000_000,
        source: { mode: 'report' as const, report: 'r.json', observed: 3 },
        tallies,
        runs: [],
        quarantined: [{ at: 1, test: 'TestOld', owner: 'alice', expiresAt: 1_600_000_000_000, reason: '老的隔离', evidencePath: 'flaky/old.json' }],
        evidencePath: 'flaky/20260928-120000-plan.json',
    }
    const withoutOwner = buildPlan({ ...options, settings: { signatures: BUILTIN_SIGNATURES, quarantineMaxDays: 14, unseenRunsBeforeWarn: 3 } })
    assert.equal(withoutOwner.tests[0]?.classification, 'quarantine')
    assert.match(withoutOwner.tests[0]?.refusal ?? '', /拒绝隔离：没有 owner/)
    assert.equal(withoutOwner.tests[0]?.quarantineCommand, undefined)
    assert.equal(withoutOwner.summary.refused, 1)
    assert.deepEqual(
        withoutOwner.escalations.map((escalation) => [escalation.kind, escalation.test]),
        [['expired', 'TestOld']],
    )
    assert.match(withoutOwner.escalations[0]?.message ?? '', /这条隔离已过期：要么修，要么删，不能继续挂着/)

    const withOwner = buildPlan({ ...options, settings: { signatures: BUILTIN_SIGNATURES, quarantineMaxDays: 7, unseenRunsBeforeWarn: 3, owner: 'platform-team' } })
    const entry = withOwner.tests[0]
    assert.equal(entry?.owner, 'platform-team')
    assert.equal(entry?.expiresAt, 1_700_000_000_000 + 7 * DAY)
    assert.deepEqual(entry?.quarantineRow, {
        at: 1_700_000_000_000,
        test: 'TestUnstable',
        owner: 'platform-team',
        expiresAt: 1_700_000_000_000 + 7 * DAY,
        reason: 'flaky：3 次运行中失败 1 次：不稳定（通过和失败都出现过）',
        evidencePath: 'flaky/20260928-120000-plan.json',
    })
    assert.equal(entry?.quarantineCommand, quarantineCommandFor(file, entry.quarantineRow as QuarantineRow))
    assert.match(entry?.quarantineCommand ?? '', /^node -e /)
    // The printed command is what a human pastes, so it must be correct for
    // arbitrary test names and paths — run it, with both made hostile.
    const hostile = path.join(cwd, 'led ger with space.jsonl')
    const hostileRow: QuarantineRow = {
        at: 7,
        test: `Test with 'quote' and $(echo nope) and "double"`,
        owner: 'platform-team',
        expiresAt: 9,
        reason: "reason with 'quotes'",
        evidencePath: 'flaky/x.json',
    }
    execFileSync('bash', ['-c', quarantineCommandFor(hostile, hostileRow)], { cwd })
    const rows = fs.readFileSync(hostile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as QuarantineRow)
    assert.deepEqual(rows, [hostileRow], 'the command appends exactly this row, whatever the name contains')
    assert.equal(withOwner.summary.refused, 0)
})

// --- tool surface ---------------------------------------------------------

test('flaky_plan: report mode classifies a fixture, writes the artifact and renders per test', async () => {
    const cwd = tempWorkspace('flaky-tool-report-')
    const report = path.join(cwd, 'flaky.json')
    fs.writeFileSync(
        report,
        JSON.stringify({
            tests: [
                { name: 'TestStable', runs: 3, failures: 0 },
                { name: 'TestUnstable', runs: 3, failures: 1 },
                { name: 'TestTimeout', runs: 3, failures: 2, output: 'panic: test timed out after 10m0s' },
            ],
        }),
    )
    const fake = host(cwd, { flaky: { owner: 'platform-team' } })
    const stores = bindMission(cwd)
    const run = await fake.runTool('flaky_plan', { report: 'flaky.json' })
    const text = runText(run)
    assert.equal(run.isError, false)
    assert.match(text, /flaky 计划：3 个用例/)
    assert.match(text, /\[稳定\] TestStable — 运行 3 次，失败 0 次/)
    assert.match(text, /\[隔离\] TestUnstable/)
    assert.match(text, /\[疑似仪器\/环境\] TestTimeout/)
    assert.match(text, /本插件不会执行/)
    assert.deepEqual(fake.spawns, [], 'report mode must not run a command')

    // The artifact is on the mission, with an evidence row, and is valid JSON.
    const store = stores.for(cwd)
    const dir = store.artifactPath('m1', 'flaky')
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0] ?? '', /^\d{8}-\d{6}-plan\.json$/)
    const artifact = JSON.parse(fs.readFileSync(path.join(dir, files[0] as string), 'utf8')) as {
        kind: string
        plugin: string
        tests: { name: string; classification: string }[]
        summary: { stable: number; quarantine: number }
        quarantine: { owner: string }
    }
    assert.equal(artifact.kind, 'flaky-plan')
    assert.equal(artifact.plugin, 'dsh-impact-gate')
    assert.deepEqual(artifact.tests.map((entry) => [entry.name, entry.classification]), [
        ['TestStable', 'stable'],
        ['TestTimeout', 'suspect-instrumentation'],
        ['TestUnstable', 'quarantine'],
    ])
    assert.equal(artifact.summary.quarantine, 1)
    assert.equal(artifact.quarantine.owner, 'platform-team')
    assert.ok(store.readEvidence('m1').some((row) => row.kind === 'artifact' && row.artifactPath?.endsWith('-plan.json')))
})

test('flaky_plan: own-run mode repeats the configured command through the injected seam', async () => {
    const cwd = tempWorkspace('flaky-tool-runs-')
    const fake = host(
        cwd,
        { fullTestCommand: 'node --test', flaky: { owner: 'team-a' } },
        [
            { exitCode: 0, stdout: '--- PASS: TestA\n--- PASS: TestB\n' },
            { exitCode: 0, stdout: '--- PASS: TestA\n--- PASS: TestB\n' },
            { exitCode: 1, stdout: '--- FAIL: TestA\n--- PASS: TestB\n' },
        ],
    )
    bindMission(cwd)
    const run = await fake.runTool('flaky_plan', { runs: 3 })
    const text = runText(run)
    assert.equal(run.isError, false)
    assert.match(text, /本插件重复运行命令 node --test 3 次/)
    assert.match(text, /\[隔离\] TestA — 运行 3 次，失败 1 次/)
    assert.match(text, /\[稳定\] TestB/)
    assert.deepEqual(fake.spawns.map((spawn) => spawn.argv), [
        ['node', '--test'],
        ['node', '--test'],
        ['node', '--test'],
    ])

    // Both outcomes observed earlier stops the loop: no load test, and the
    // render says the count was cut short.
    const shortCwd = tempWorkspace('flaky-tool-short-')
    const short = host(
        shortCwd,
        { fullTestCommand: 'node --test', flaky: { owner: 'team-a' } },
        [
            { exitCode: 0, stdout: '--- PASS: TestA\n' },
            { exitCode: 1, stdout: '--- FAIL: TestA\n' },
        ],
    )
    bindMission(shortCwd, 'm3')
    const stopped = runText(await short.runTool('flaky_plan', { runs: 5 }))
    assert.match(stopped, /本插件重复运行命令 node --test 2 次/)
    assert.match(stopped, /提前结束（原计划 5 次）/)
    assert.equal(short.spawns.length, 2)

    // A single run cannot conclude anything.
    const single = await fake.runTool('flaky_plan', { runs: 1 })
    assert.equal(single.isError, true)
    assert.match(runText(single), /至少需要 2 次运行/)

    // No report and no configured command: refuse with the two ways forward.
    const bare = host(tempWorkspace('flaky-tool-bare-'))
    bindMission(bare.cwd, 'm2')
    const refused = await bare.runTool('flaky_plan', {})
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /没有可重复运行的命令/)
    assert.match(runText(refused), /下一步二选一/)
})

test('flaky_plan: an unreadable report refuses instead of reading as "no flaky tests"', async () => {
    const cwd = tempWorkspace('flaky-tool-bad-report-')
    fs.writeFileSync(path.join(cwd, 'broken.json'), '{ not json')
    const fake = host(cwd)
    bindMission(cwd)
    const run = await fake.runTool('flaky_plan', { report: 'broken.json' })
    assert.equal(run.isError, true)
    assert.match(runText(run), /不是合法 JSON/)
    const missing = await fake.runTool('flaky_plan', { report: 'nope.json' })
    assert.equal(missing.isError, true)
    assert.match(runText(missing), /报告文件不存在/)
})

test('flaky_status: read-only, tolerant of a truncated ledger, and reports expired + unseen quarantines', async () => {
    const cwd = tempWorkspace('flaky-tool-status-')
    const now = Date.now()
    writeQuarantine(
        cwd,
        [
            { at: now - 10 * DAY, test: 'TestExpired', owner: 'alice', expiresAt: now - DAY, reason: '老的隔离', evidencePath: 'flaky/a.json' },
            { at: now - DAY, test: 'TestGone', owner: 'bob', expiresAt: now + 13 * DAY, reason: '不稳定', evidencePath: 'flaky/b.json' },
            { at: now, test: 'TestNobody', expiresAt: now + DAY, reason: '没有负责人', evidencePath: 'flaky/c.json' },
        ],
        '{"at":1790000000',
    )
    const fake = host(
        cwd,
        { fullTestCommand: 'node --test', flaky: { owner: 'team-a' } },
        [
            { exitCode: 0, stdout: '--- PASS: TestA\n' },
            { exitCode: 0, stdout: '--- PASS: TestA\n' },
            { exitCode: 0, stdout: '--- PASS: TestA\n' },
        ],
    )
    bindMission(cwd)
    // A plan first, so the status has observed runs to compare the ledger against.
    await fake.runTool('flaky_plan', { runs: 3 })

    const before = snapshot(path.join(cwd, '.dsh'))
    const status = await fake.runTool('flaky_status', {})
    const text = runText(status)
    assert.equal(status.isError, false)
    assert.match(text, /flaky 状态（只读）/)
    assert.match(text, /\| TestExpired \| alice \|/)
    assert.match(text, /⛔ 已过期的隔离（1 条）：要么修，要么删，不能继续挂着/)
    assert.match(text, /台账里有 2 行无法使用/)
    assert.match(text, /没有 owner/)
    assert.match(text, /不是合法 JSON（文件被截断的尾行，已跳过）/)
    assert.match(text, /可能悄悄丢失的覆盖（最近 3 次运行都没点名）/)
    assert.match(text, /TestGone/)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, 'flaky_status must write nothing')
})

test('flaky_status: without a mission it says the plan cannot be recorded', async () => {
    const cwd = tempWorkspace('flaky-tool-nomission-')
    const fake = host(cwd, { flaky: { owner: 'team-a' } })
    const status = await fake.runTool('flaky_status', {})
    assert.equal(status.isError, false)
    assert.match(runText(status), /最近计划：（无）/)
    assert.match(runText(status), /没有 mission，计划不会落盘/)
})

// --- config ---------------------------------------------------------------

test('flaky: config parses the policy, accepts the alias, and the project may only tighten it', () => {
    const profile = resolveConfig({
        fullTestCommand: 'go test ./...',
        flaky: { owner: 'platform-team', quarantineMaxDays: 10, unseenRunsBeforeWarn: 4, signatures: [{ pattern: 'ORA-\\d+', label: '数据库' }] },
    })
    assert.equal(profile.flaky.owner, 'platform-team')
    assert.equal(profile.flaky.quarantineMaxDays, 10)
    assert.equal(profile.flaky.unseenRunsBeforeWarn, 4)
    assert.deepEqual(profile.flaky.signatures.map((signature: FlakySignature) => signature.label), ['数据库'])

    // The top-level alias sets the same thing.
    assert.equal(resolveConfig({ flakySignatures: [{ pattern: 'X', label: 'x' }] }).flaky.signatures.length, 1)
    // Defaults stand when nothing is configured.
    const defaults = resolveConfig({})
    assert.equal(defaults.flaky.quarantineMaxDays, 14)
    assert.equal(defaults.flaky.unseenRunsBeforeWarn, 3)
    assert.equal(defaults.flaky.owner, undefined)
    assert.equal(defaults.flaky.signatures.length, BUILTIN_SIGNATURES.length)
    assert.equal(quarantineFileFor(defaults.flaky, { cwd: '/repo', rootDir: '/repo/.dsh' }), path.join('/repo', '.dsh', 'flaky-quarantine.json'))

    const cwd = tempWorkspace('flaky-overlay-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'impact-gate.json'),
        JSON.stringify({ flaky: { owner: 'repo-owner', quarantineMaxDays: 7, unseenRunsBeforeWarn: 2, quarantineFile: '.dsh/q.json', nope: 1 } }),
    )
    const stores = new MissionStoreRegistry()
    const effective = resolveEffectiveConfig(resolveConfig({ flaky: { quarantineMaxDays: 10, unseenRunsBeforeWarn: 4 } }), stores.for(cwd).layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.flaky.owner, 'repo-owner')
    assert.equal(effective.config.flaky.quarantineMaxDays, 7)
    assert.equal(effective.config.flaky.unseenRunsBeforeWarn, 2)
    assert.equal(effective.config.flaky.quarantineFile, '.dsh/q.json')
    assert.equal(quarantineFileFor(effective.config.flaky, { cwd, rootDir: stores.for(cwd).layout.rootDir }), path.join(cwd, '.dsh', 'q.json'))
    assert.match(effective.problems.join('\n'), /不认识的键 "nope"/)

    // Loosening the host's policy is refused, and the profile value stays.
    fs.writeFileSync(path.join(cwd, '.dsh', 'impact-gate.json'), JSON.stringify({ flaky: { quarantineMaxDays: 30, unseenRunsBeforeWarn: 9 } }))
    clearProjectConfigCache()
    const loosened = resolveEffectiveConfig(resolveConfig({ flaky: { quarantineMaxDays: 10, unseenRunsBeforeWarn: 4 } }), stores.for(cwd).layout)
    assert.equal(loosened.config.flaky.quarantineMaxDays, 10)
    assert.equal(loosened.config.flaky.unseenRunsBeforeWarn, 4)
    assert.match(loosened.problems.join('\n'), /比 profile 的 10 更宽松，已忽略（profile 是上限：项目只能收紧）/)
    assert.deepEqual([...PROJECT_OVERRIDABLE_KEYS].includes('flaky'), true)
})

test('flaky: the plugin declares its name and injects the two services it uses', () => {
    assert.equal(name, 'dsh-impact-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
    const cwd = tempWorkspace('flaky-prompt-')
    const fake = host(cwd)
    // Without an owner the prompt must say so, because the plan will refuse.
    assert.match(fake.sectionText('eng:impact-gate'), /没有配置 `flaky\.owner`/)
    fake.dispose()
    const owned = host(tempWorkspace('flaky-prompt-2-'), { flaky: { owner: 'team-a' } })
    const section = owned.sectionText('eng:impact-gate')
    assert.match(section, /隔离是向未来借的债，不是修复/)
    assert.match(section, /不能继续挂着/)
    assert.match(section, /owner=team-a/)
})

// --- adversarial-audit regressions: report mode, path containment, injection ---

test('flaky_status: a report that only carries tallies never accuses a quarantine it proves ran (regression)', async () => {
    const cwd = tempWorkspace('flaky-status-report-')
    // Exactly the shape dsh-coverage-gate's flaky_check writes: tallies DO name
    // the tests, the runs carry only exit codes.
    fs.writeFileSync(
        path.join(cwd, 'flaky.json'),
        JSON.stringify({
            runs: [
                { index: 1, exitCode: 0, timedOut: false, outcome: 'pass' },
                { index: 2, exitCode: 1, timedOut: false, outcome: 'fail' },
                { index: 3, exitCode: 0, timedOut: false, outcome: 'pass' },
            ],
            flakyTests: [{ name: 'TestRan', passed: 2, failed: 1, times: [true, false, true] }],
            stableTests: [{ name: 'TestOther', passed: 3, failed: 0 }],
            inconclusiveTests: [],
        }),
    )
    const fake = host(cwd, { flaky: { owner: 'team-a' } })
    const stores = bindMission(cwd)
    assert.equal((await fake.runTool('flaky_plan', { report: 'flaky.json' })).isError, false)
    // A human quarantined the test the report counts — this is the row the plan
    // told them to write.
    const ledger = path.join(cwd, '.dsh', 'flaky-quarantine.json')
    const days = 10 * 24 * 60 * 60 * 1_000
    const rows: QuarantineRow[] = [
        { at: 1, test: 'TestRan', owner: 'team-a', expiresAt: Date.now() + days, reason: 'flaky', evidencePath: 'flaky/x.json' },
        { at: 2, test: 'TestVanished', owner: 'team-a', expiresAt: Date.now() + days, reason: 'flaky', evidencePath: 'flaky/y.json' },
    ]
    fs.writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

    const text = runText(await fake.runTool('flaky_status', { missionId: 'm1' }))
    // The report's own caveat is rendered (it was dropped before), and the check
    // uses the tallies as the observed set instead of "no name = not seen".
    assert.match(text, /说明：报告只带运行级结果/)
    assert.match(text, /报告的用例计数里没有覆盖全部 3 次运行/)
    // The accusation is reserved for the test the report really never names.
    assert.match(text, /TestVanished/)
    assert.match(text, /报告的 3 次运行里完全没有它/)
    const accused = text.split('\n').filter((line) => line.includes('覆盖正在静默消失'))
    assert.equal(accused.length, 1, 'exactly one quarantine is reported as silently disappearing')
    assert.match(accused[0] ?? '', /TestVanished/)
    assert.equal(/TestRan.*覆盖正在静默消失/.test(text), false, 'a test the tallies prove ran is never accused')
    assert.deepEqual(stores.for(cwd).readEvidence('m1').length > 0, true)

    // With only the covered test quarantined the check PASSES — the case the audit
    // found accusing every quarantine of "覆盖正在静默消失".
    fs.writeFileSync(ledger, `${JSON.stringify(rows[0])}\n`)
    const covered = runText(await fake.runTool('flaky_status', { missionId: 'm1' }))
    assert.match(covered, /"最近 3 次运行没出现"检查：通过（报告没有逐次点名/)
    assert.equal(/覆盖正在静默消失/.test(covered), false, 'nothing is accused when the counts cover every quarantine')
})

test('a project file may not point the quarantine ledger outside the workspace (regression)', () => {
    const cwd = tempWorkspace('flaky-quarantine-escape-')
    const outside = tempWorkspace('flaky-quarantine-outside-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'impact-gate.json'),
        JSON.stringify({ flaky: { quarantineFile: path.join(outside, 'ledger.jsonl') } }),
    )
    clearProjectConfigCache()
    const stores = new MissionStoreRegistry([])
    const hostConfig = resolveConfig({ logFile: 'impact-gate.log' })
    const effective = resolveEffectiveConfig(hostConfig, stores.for(cwd).layout)
    assert.match(effective.problems.join('\n'), /flaky\.quarantineFile 必须指向工作区内的路径/)
    assert.equal(effective.config.flaky.quarantineFile, undefined, 'the escaping value keeps the profile value')
    assert.equal(effective.source, 'profile', 'a refused key is not "applied"')
    // A workspace-relative relocation is still allowed.
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'impact-gate.json'),
        JSON.stringify({ flaky: { quarantineFile: '.dsh/q.json' } }),
    )
    clearProjectConfigCache()
    const relocated = resolveEffectiveConfig(hostConfig, stores.for(cwd).layout)
    assert.equal(relocated.config.flaky.quarantineFile, '.dsh/q.json')
})

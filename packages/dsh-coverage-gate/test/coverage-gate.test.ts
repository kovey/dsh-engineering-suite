/**
 * dsh-coverage-gate tests.
 *
 * Four groups:
 *  - PURE parsers (lcov / cobertura / go-cover / istanbul-json, each with a
 *    malformed input that must be REFUSED, plus incremental coverage);
 *  - the flaky classifier (per-test shapes, run-level fallback);
 *  - the three tools against a fake host, a real temp git repository and a
 *    counter-driven (never time-driven) flaky fixture;
 *  - the profile-ceiling / project-overlay rules.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name, resolveEffectiveConfig } from '../dist/index.js'
import { resolveConfig, MAX_FLAKY_REPEATS } from '../dist/config.js'
import { incrementalCoverage, parseCoverage, worstFiles } from '../dist/coverage.js'
import { classifyRuns, compareRuns, detectFlakiness, parseTestNames } from '../dist/flaky.js'
import { tokenizeTemplate } from '../dist/command.js'

// --- fixtures ---------------------------------------------------------------

/** lcov: 5 instrumented lines, 2 hit (40%). */
const LCOV = [
    'TN:',
    'SF:src/a.ts',
    'DA:1,1',
    'DA:2,1',
    'DA:3,0',
    'LF:3',
    'LH:2',
    'end_of_record',
    'SF:src/b.ts',
    'DA:1,0',
    'DA:2,0',
    'LF:2',
    'LH:0',
    'end_of_record',
    '',
].join('\n')

/** cobertura: 2 lines in one class, 1 hit (50%). */
const COBERTURA = [
    '<?xml version="1.0" ?>',
    '<coverage line-rate="0.5" version="1.9">',
    '  <packages>',
    '    <package name="demo">',
    '      <classes>',
    '        <class name="a" filename="src/a.py" line-rate="0.5">',
    '          <methods/>',
    '          <lines>',
    '            <line number="1" hits="3"/>',
    '            <line number="2" hits="0"/>',
    '          </lines>',
    '        </class>',
    '      </classes>',
    '    </package>',
    '  </packages>',
    '</coverage>',
    '',
].join('\n')

/** go cover profile: 6 statements in 3 blocks, 3 hit (50%). */
const GO_COVER = [
    'mode: set',
    'example.com/demo/internal/a.go:1.1,2.2 2 1',
    'example.com/demo/internal/a.go:5.1,7.2 3 0',
    'example.com/demo/internal/b.go:1.1,1.10 1 1',
    '',
].join('\n')

/** istanbul: 2 statements, 1 hit (50%). */
const ISTANBUL = `${JSON.stringify(
    {
        '/ws/src/a.ts': {
            statementMap: {
                '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
                '1': { start: { line: 2, column: 0 }, end: { line: 3, column: 5 } },
            },
            s: { '0': 2, '1': 0 },
        },
    },
    undefined,
    2,
)}\n`

/** A workspace-local log file keeps every test's logging out of the package. */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd })
    const resolved: Record<string, unknown> = { ...config }
    const logFile = resolved['logFile']
    resolved['logFile'] =
        typeof logFile === 'string' && path.isAbsolute(logFile) ? logFile : path.join(cwd, typeof logFile === 'string' ? logFile : 'coverage-gate.log')
    apply(fake.ctx as never, resolved)
    return fake
}

/** Bind a fresh mission to the fake host's session. */
function bindMission(
    cwd: string,
    title: string,
    sessionId = 'session-1',
): { id: string; store: ReturnType<MissionStoreRegistry['for']> } {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId })
    store.bindSession(sessionId, mission.id)
    return { id: mission.id, store }
}

/** A git workspace (an empty repository with identity configured). */
function gitWorkspace(prefix: string): string {
    const cwd = tempWorkspace(prefix)
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    return cwd
}

/** Write a coverage report outside the workspace (keeps the diff clean). */
function reportIn(prefix: string, body: string): string {
    const dir = tempWorkspace(prefix)
    const file = path.join(dir, 'lcov.info')
    fs.writeFileSync(file, body)
    return file
}

// --- package surface --------------------------------------------------------

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-coverage-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the three tools and the prompt section, and disposes cleanly', () => {
    const cwd = tempWorkspace('cov-apply-')
    const fake = host(cwd, { thresholds: { total: 80 } })
    assert.deepEqual([...fake.tools.keys()].sort(), ['coverage_check', 'coverage_status', 'flaky_check'])
    const section = fake.sectionText('eng:coverage-gate')
    assert.match(section, /覆盖率数字不是正确性/)
    assert.match(section, /flaky/)
    assert.match(section, /total ≥ 80%/)
    fake.dispose()
    assert.equal(fake.tools.size, 0)
})

// --- config -----------------------------------------------------------------

test('config: a threshold outside 0–100 is refused, never silently defaulted', () => {
    const problems: string[] = []
    const resolved = resolveConfig(
        { thresholds: { total: 150, changed: '80', perFile: -1, bogus: 5 } },
        (message) => problems.push(message),
    )
    assert.deepEqual(resolved.thresholds, {}, 'no threshold survives validation and no default replaces it')
    assert.equal(problems.length, 4)
    assert.match(problems.join('\n'), /thresholds\.total 必须在 0–100 之间/)
    assert.match(problems.join('\n'), /thresholds\.changed 必须是 0–100 的数字/)
    assert.match(problems.join('\n'), /未知的阈值键 "bogus"/)

    const ok = resolveConfig({ thresholds: { total: 80, changed: 0, perFile: 100 } })
    assert.deepEqual(ok.thresholds, { total: 80, changed: 0, perFile: 100 })
})

test('config: repeats are capped, an unknown policy falls back to the strictest one', () => {
    const problems: string[] = []
    const clamped = resolveConfig({ flakyRepeats: 99 }, (message) => problems.push(message))
    assert.equal(clamped.flakyRepeats, MAX_FLAKY_REPEATS)
    assert.match(problems.join('\n'), /超过上限/)
    assert.equal(resolveConfig({ flakyPolicy: 'ignore' }).flakyPolicy, 'block')
    assert.equal(resolveConfig({ reportFormat: 'nope' }).reportFormat, 'auto')
    assert.equal(resolveConfig({ thresholds: { total: 0 } }).thresholds.total, 0, '0% is a real threshold, not a missing one')
})

test('command templates: no shell, no silent placeholders', () => {
    const plain = tokenizeTemplate('node -e "console.log(1)"')
    assert.deepEqual('argv' in plain ? plain.argv : undefined, ['node', '-e', 'console.log(1)'])

    for (const [template, glyph] of [
        ['node a.mjs; rm -rf /', ';'],
        ['node a.mjs | tee log', '|'],
        ['node a.mjs > out.txt', '>'],
        ['echo $HOME', '$'],
        ['node `whoami`.mjs', '`'],
        ['node a.mjs &', '&'],
        ['node a.mjs < in.txt', '<'],
    ] as const) {
        const result = tokenizeTemplate(template)
        assert.ok('error' in result, `${template} must be refused`)
        assert.match(result.error, new RegExp(`shell 元字符 "${glyph.replace(/[$`]/g, '\\$&')}"`))
    }

    const unknown = tokenizeTemplate('node {nope}')
    assert.ok('error' in unknown)
    assert.match(unknown.error, /未知占位符 \{nope\}/)
    assert.match(unknown.error, /\{reportFile\}/)

    const missing = tokenizeTemplate('node {reportFile}', {})
    assert.ok('error' in missing)
    assert.match(missing.error, /没有该值/)

    // A substituted value stays ONE argv element even when it contains a space.
    const spaced = tokenizeTemplate('node --out={reportFile}', { reportFile: '/tmp/a b/lcov.info' })
    assert.deepEqual('argv' in spaced ? spaced.argv : undefined, ['node', '--out=/tmp/a b/lcov.info'])
})

// --- pure parsers -----------------------------------------------------------

test('lcov: files, totals and the empty-file caveat', () => {
    const parsed = parseCoverage(LCOV, { format: 'lcov', cwd: '/ws' })
    assert.ok(parsed.ok, JSON.stringify(parsed))
    const report = parsed
    assert.equal(report.format, 'lcov')
    assert.equal(report.metric, 'lines')
    assert.deepEqual(
        report.files.map((file) => [file.path, file.linesFound, file.linesHit]),
        [
            ['src/a.ts', 3, 2],
            ['src/b.ts', 2, 0],
        ],
    )
    assert.deepEqual(report.totals, { linesFound: 5, linesHit: 2 })
    assert.deepEqual(report.emptyFiles, [])
})

test('lcov: a malformed DA row is a problem, not zero coverage', () => {
    const parsed = parseCoverage('SF:src/a.ts\nDA:abc,1\nend_of_record\n', { format: 'lcov' })
    assert.equal(parsed.ok, false)
    assert.ok(!parsed.ok && /DA: 格式非法/.test(parsed.problem))
    const noRecords = parseCoverage('this is not a coverage report\n', { format: 'lcov' })
    assert.ok(!noRecords.ok && /没有任何 "SF:" 记录/.test(noRecords.problem))
})

test('cobertura: class/line parsing, path resolution and a malformed line', () => {
    const parsed = parseCoverage(COBERTURA, { format: 'cobertura', cwd: '/ws' })
    assert.ok(parsed.ok, JSON.stringify(parsed))
    assert.deepEqual(
        parsed.files.map((file) => [file.path, file.linesFound, file.linesHit]),
        [['src/a.py', 2, 1]],
    )
    assert.deepEqual(parsed.totals, { linesFound: 2, linesHit: 1 })

    const malformed = parseCoverage('<class filename="src/a.py"><lines><line number="1"/></lines></class>', {
        format: 'cobertura',
    })
    assert.ok(!malformed.ok)
    assert.match(malformed.problem, /<line> 缺少合法的 number\/hits/)
})

test('go-cover: statement metric, block spans and a malformed data row', () => {
    const parsed = parseCoverage(GO_COVER, { format: 'go-cover', cwd: '/ws' })
    assert.ok(parsed.ok, JSON.stringify(parsed))
    assert.equal(parsed.metric, 'statements')
    assert.deepEqual(parsed.totals, { linesFound: 6, linesHit: 3 })
    assert.deepEqual(parsed.files[0]?.spans, [
        { start: 1, end: 2, hits: 1 },
        { start: 5, end: 7, hits: 0 },
    ])
    assert.match(parsed.notes.join('\n'), /语句块/)

    const malformed = parseCoverage('mode: set\nexample.com/a.go:1 1 1\n', { format: 'go-cover' })
    assert.ok(!malformed.ok)
    assert.match(malformed.problem, /第 2 行的数据格式非法/)
    const noMode = parseCoverage('internal/a.go:1.1,2.2 1 1\n', { format: 'go-cover' })
    assert.ok(!noMode.ok && /第一行必须是 "mode:/.test(noMode.problem))
})

test('istanbul-json: statementMap/s parsing and a missing hit count', () => {
    const parsed = parseCoverage(ISTANBUL, { format: 'istanbul-json', cwd: '/ws' })
    assert.ok(parsed.ok, JSON.stringify(parsed))
    assert.equal(parsed.metric, 'statements')
    assert.deepEqual(parsed.totals, { linesFound: 2, linesHit: 1 })
    assert.equal(parsed.files[0]?.path, 'src/a.ts', 'an absolute path inside the workspace becomes workspace-relative')

    // A report path outside the workspace stays absolute and is flagged.
    const outside = parseCoverage(ISTANBUL, { format: 'istanbul-json', cwd: '/elsewhere' })
    assert.ok(outside.ok)
    assert.equal(outside.files[0]?.path, '/ws/src/a.ts')
    assert.equal(outside.files[0]?.outsideWorkspace, true)

    const malformed = parseCoverage('{"src/a.ts": {"statementMap": {"0": {"start": {"line": 1}}}, "s": {}}}', {
        format: 'istanbul-json',
    })
    assert.ok(!malformed.ok)
    assert.match(malformed.problem, /s 缺少语句 "0" 的命中次数/)
    const notJson = parseCoverage('{ not json', { format: 'istanbul-json' })
    assert.ok(!notJson.ok && /JSON 解析失败/.test(notJson.problem))
})

test('auto: every format is detected, unknown text is refused', () => {
    for (const [body, expected] of [
        [LCOV, 'lcov'],
        [COBERTURA, 'cobertura'],
        [GO_COVER, 'go-cover'],
        [ISTANBUL, 'istanbul-json'],
    ] as const) {
        const parsed = parseCoverage(body)
        assert.ok(parsed.ok, `${expected} should parse`)
        assert.equal(parsed.format, expected)
    }
    // The format may be passed positionally (`parseCoverage(text, 'lcov')`).
    const positional = parseCoverage(ISTANBUL, 'istanbul-json')
    assert.ok(positional.ok && positional.format === 'istanbul-json')

    const unknown = parseCoverage('coverage: 73.2% of statements\n')
    assert.equal(unknown.ok, false, 'an unrecognised report must never parse as an empty success')
    assert.match(!unknown.ok ? unknown.problem : '', /auto 无法识别报告格式/)
    const empty = parseCoverage('   \n')
    assert.ok(!empty.ok && /报告为空/.test(empty.problem))
    const badFormat = parseCoverage(LCOV, { format: 'sonarqube' })
    assert.ok(!badFormat.ok && /未知的报告格式/.test(badFormat.problem))
})

test('parsers never throw on hostile input: a problem, or a report', () => {
    const hostile = [
        '',
        '   \n\n',
        'SF:',
        'SF:src/a.ts',
        'SF:src/a.ts\nDA:',
        'DA:1,1',
        'end_of_record',
        'mode:',
        'mode: set\n',
        'mode: nonsense\n',
        'mode: set\nnot-a-row\n',
        '{',
        '[]',
        'null',
        '{"src/a.ts": null}',
        '{"src/a.ts": {}}',
        '<class filename=""></class>',
        '<coverage><line number="1" hits="1"/></coverage>',
        '<?xml version="1.0"?><coverage/>',
        'SF:src/a.ts\nDA:1,1\nDA:1,2\nend_of_record\n',
        'SF:src/a.ts\nLF:5\nend_of_record\n',
        'SF:src/a.ts\nDA:1,1\nSF:src/a.ts\nDA:2,1\nend_of_record\nend_of_record\n',
        'mode: set\n:1.1,2.2 1 1\n',
        'mode: set\nexample.com/a.go:5.1,2.2 1 1\n',
        'TN:x\nSF:src/a.ts\nDA:1,0\nend_of_record\n',
        '\u0000\u0001binary',
    ]
    for (const body of hostile) {
        for (const format of ['auto', 'lcov', 'cobertura', 'go-cover', 'istanbul-json'] as const) {
            const result = parseCoverage(body, { format, cwd: '/ws' })
            if (result.ok) {
                assert.ok(result.files.every((file) => Number.isFinite(file.linesFound) && file.linesFound >= file.linesHit))
            } else {
                assert.equal(typeof result.problem, 'string')
                assert.notEqual(result.problem, '')
            }
        }
    }
    // Duplicate DA rows merge with the maximum hit count (deterministic).
    const merged = parseCoverage('SF:src/a.ts\nDA:1,1\nDA:1,2\nend_of_record\n', { format: 'lcov' })
    assert.ok(merged.ok)
    assert.deepEqual(merged.files[0]?.spans, [{ start: 1, end: 1, hits: 2 }])
    // A record with only LF/LH keeps the aggregate and says the detail is missing.
    const aggregate = parseCoverage('SF:src/a.ts\nLF:5\nLH:4\nend_of_record\n', { format: 'lcov' })
    assert.ok(aggregate.ok)
    assert.deepEqual(aggregate.totals, { linesFound: 5, linesHit: 4 })
    assert.equal(aggregate.files[0]?.spans.length, 0)
})

test('incrementalCoverage: only instrumented added lines are judged', () => {
    const parsed = parseCoverage('SF:src/a.ts\nDA:4,1\nDA:5,0\nDA:9,1\nend_of_record\n', { format: 'lcov', cwd: '/ws' })
    assert.ok(parsed.ok)
    const incremental = incrementalCoverage(parsed, [
        { path: 'src/a.ts', added: [[4, 6]], removed: 0, status: 'modified' },
        { path: 'src/new.ts', added: [[1, 2]], removed: 0, status: 'untracked' },
        { path: 'src/gone.ts', added: [], removed: 3, status: 'deleted' },
        { path: 'README.md', added: [[1, 1]], removed: 0, status: 'modified' },
    ])
    const a = incremental.files.find((file) => file.path === 'src/a.ts')
    assert.deepEqual(
        { added: a?.addedLines, instrumented: a?.instrumented, hit: a?.hit, missed: a?.missed },
        { added: 3, instrumented: 2, hit: 1, missed: 1 },
    )
    assert.deepEqual(a?.missedLines, [5])
    assert.deepEqual(a?.uninstrumentedRanges, [[6, 6]], 'added lines the report does not instrument are named, not counted')
    assert.deepEqual(incremental.totals, { addedLines: 6, instrumented: 2, hit: 1, missed: 1, uninstrumented: 4 })
    assert.deepEqual(incremental.missing, ['README.md', 'src/new.ts'], 'sorted by path')
    const gone = incremental.files.find((file) => file.path === 'src/gone.ts')
    assert.match(gone?.problem ?? '', /文件已删除/)
    assert.equal(incremental.judgement, 'partial', 'files the report never mentions make the judgement partial')
    assert.match(incremental.notes.join('\n'), /没有被报告插桩/)

    // A report with only aggregate numbers cannot judge added lines either.
    const noDetail = parseCoverage('SF:src/a.ts\nLF:10\nLH:9\nend_of_record\n', { format: 'lcov', cwd: '/ws' })
    assert.ok(noDetail.ok)
    const viaAggregate = incrementalCoverage(noDetail, [{ path: 'src/a.ts', added: [[1, 2]], removed: 0, status: 'modified' }])
    assert.equal(viaAggregate.totals.instrumented, 0)
    assert.match(viaAggregate.files[0]?.problem ?? '', /没有逐行明细/)
})

test('worstFiles: least covered first, deterministic tie-breaks', () => {
    const parsed = parseCoverage(LCOV, { format: 'lcov', cwd: '/ws' })
    assert.ok(parsed.ok)
    assert.deepEqual(
        worstFiles(parsed).map((file) => [file.path, Math.round(file.percent)]),
        [
            ['src/b.ts', 0],
            ['src/a.ts', 67],
        ],
    )
})

// --- flaky ------------------------------------------------------------------

test('parseTestNames: the four runner shapes (and their passing counterparts)', () => {
    const go = parseTestNames('--- FAIL: TestStore/creates\n--- PASS: TestStore/deletes\n')
    assert.deepEqual(go.failed, ['TestStore/creates'])
    assert.deepEqual(go.passed, ['TestStore/deletes'])

    const vitest = parseTestNames('  ✖ renders the list 52ms\n  ✓ renders the header\n')
    assert.deepEqual(vitest.failed, ['renders the list'])
    assert.deepEqual(vitest.passed, ['renders the header'])

    const pytest = parseTestNames('FAILED tests/x.py::test_y - AssertionError: boom\nPASSED tests/x.py::test_z\n')
    assert.deepEqual(pytest.failed, ['tests/x.py::test_y'])
    assert.deepEqual(pytest.passed, ['tests/x.py::test_z'])

    const jest = parseTestNames('  × suite > case A\n  √ suite > case B\n')
    assert.deepEqual(jest.failed, ['suite > case A'])
    assert.deepEqual(jest.passed, ['suite > case B'])

    // A reporter's FILE summary is not a test name.
    assert.deepEqual(parseTestNames(' ✖ src/a.test.ts (1 test | 1 failed)\n').failed, [])
})

test('classifyRuns: flaky vs stable vs inconclusive', () => {
    const runs = [
        { index: 1, exitCode: 1, stdout: '--- FAIL: TestA\n--- PASS: TestB\n', stderr: '' },
        { index: 2, exitCode: 0, stdout: '--- PASS: TestA\n--- PASS: TestB\n', stderr: '' },
        { index: 3, exitCode: 1, stdout: '--- FAIL: TestA\n--- FAIL: TestC\n', stderr: '' },
    ]
    const classification = classifyRuns(runs)
    assert.deepEqual(
        classification.flaky.map((tally) => [tally.name, tally.passed, tally.failed]),
        [['TestA', 1, 2]],
    )
    assert.deepEqual(
        classification.stable.map((tally) => [tally.name, tally.outcome]),
        [
            ['TestC', 'failing'],
            ['TestB', 'passing'],
        ],
    )
    assert.deepEqual(classification.inconclusive, [])
    assert.deepEqual(classification.opaqueRuns, [])

    // One opaque run: a test that failed there and is absent elsewhere is NOT
    // proven flaky.
    const withOpaque = classifyRuns([
        { index: 1, exitCode: 2, stdout: '', stderr: 'compile error\n' },
        { index: 2, exitCode: 1, stdout: '--- FAIL: TestA\n', stderr: '' },
    ])
    assert.deepEqual(withOpaque.flaky, [])
    assert.deepEqual(
        withOpaque.inconclusive.map((tally) => tally.name),
        ['TestA'],
    )
    assert.deepEqual(withOpaque.opaqueRuns, [1])
    assert.match(withOpaque.notes.join('\n'), /没有给出任何用例名/)
})

test('compareRuns: exit-code-only runners are honest about the level', () => {
    const mixed = compareRuns([
        { index: 1, exitCode: 0, stdout: 'ok\n', stderr: '' },
        { index: 2, exitCode: 1, stdout: 'boom\n', stderr: '' },
    ])
    assert.equal(mixed.flaky, true)
    assert.equal(mixed.passed, 1)
    assert.equal(mixed.failed, 1)
    assert.match(mixed.reason, /没有给出用例名/)
    assert.match(mixed.reason, /无法定位到具体用例/)

    const allFail = compareRuns([
        { index: 1, exitCode: 1, stdout: '', stderr: '' },
        { index: 2, exitCode: 2, stdout: '', stderr: '' },
    ])
    assert.equal(allFail.flaky, false)
    assert.match(allFail.reason, /稳定失败（不是 flaky）/)

    const allPass = compareRuns([
        { index: 1, exitCode: 0, stdout: '', stderr: '' },
        { index: 2, exitCode: 0, stdout: '', stderr: '' },
    ])
    assert.equal(allPass.flaky, false)
    assert.match(allPass.reason, /全部 2 次运行都通过/)

    const single = detectFlakiness([{ index: 1, exitCode: 0, stdout: '', stderr: '' }])
    assert.equal(single.inconclusive, true)
    assert.match(single.reason, /至少需要 2 次/)

    const timeouts = compareRuns([
        { index: 1, exitCode: 0, stdout: '', stderr: '' },
        { index: 2, exitCode: null, timedOut: true, stdout: '', stderr: '' },
    ])
    assert.deepEqual(timeouts.timeouts, [2])
    assert.match(timeouts.reason, /超时/)
})

// --- coverage_check ---------------------------------------------------------

test('coverage_check: below the threshold BLOCKS and records a gate; above PASSES', async () => {
    const cwd = tempWorkspace('cov-threshold-')
    const { id, store } = bindMission(cwd, '覆盖率门禁')
    const reportFile = reportIn('cov-report-a-', LCOV) // 40%
    const fake = host(cwd, { thresholds: { total: 80 }, reportFile })

    const blocked = runText(await fake.runTool('coverage_check', {}))
    assert.match(blocked, /覆盖率检查：BLOCK/)
    assert.match(blocked, /总覆盖率 40%/)
    assert.match(blocked, /阈值 80%/)
    const blockGate = store.lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(blockGate?.state, 'BLOCK')
    assert.equal(blockGate?.source, 'dsh-coverage-gate')
    assert.equal(blockGate?.scope?.full, true, 'every configured threshold was judged')
    assert.deepEqual(blockGate?.scope?.selected, ['total'])
    assert.equal(blockGate?.fingerprint?.isRepo, false, 'a temp workspace is not a repo, and the gate says so')
    assert.equal(blockGate?.results.find((result) => result.id === 'coverage-total')?.exitCode, 1)

    // A threshold the report satisfies: PASS.
    const lower = host(cwd, { thresholds: { total: 30 }, reportFile })
    const passed = runText(await lower.runTool('coverage_check', {}))
    assert.match(passed, /覆盖率检查：PASS/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'PASS')

    // The parsed numbers land on the mission as a JSON artifact.
    const artifact = JSON.parse(store.readArtifact(id, 'artifacts/coverage.json') ?? '{}') as {
        totals: { percent: number; linesFound: number }
        state: string
        thresholds: { total?: number }
    }
    assert.equal(artifact.totals.linesFound, 5)
    assert.equal(Math.round(artifact.totals.percent), 40)
    assert.equal(artifact.state, 'PASS')
    assert.equal(artifact.thresholds.total, 30)
})

test('coverage_check: missing threshold, missing report and a missing reportFile are refused with the next step', async () => {
    const cwd = tempWorkspace('cov-refuse-')
    bindMission(cwd, '拒绝路径')

    const noThreshold = host(cwd, { reportFile: reportIn('cov-report-b-', LCOV) })
    const thresholdRun = await noThreshold.runTool('coverage_check', {})
    assert.equal(thresholdRun.isError, true)
    assert.match(String(thresholdRun.content), /没有生效的覆盖率阈值/)
    assert.match(String(thresholdRun.content), /下一步/)

    const noReport = host(cwd, { thresholds: { total: 50 }, reportFile: 'coverage/missing.info' })
    const reportRun = await noReport.runTool('coverage_check', {})
    assert.equal(reportRun.isError, true)
    assert.match(String(reportRun.content), /报告不存在或不可读/)
    assert.match(String(reportRun.content), /下一步/)

    const noSource = host(cwd, { thresholds: { total: 50 } })
    const sourceRun = await noSource.runTool('coverage_check', {})
    assert.equal(sourceRun.isError, true)
    assert.match(String(sourceRun.content), /没有可用的覆盖率报告来源/)

    const commandWithoutReport = host(cwd, { thresholds: { total: 50 }, coverageCommand: 'node -v' })
    const commandRun = await commandWithoutReport.runTool('coverage_check', {})
    assert.equal(commandRun.isError, true)
    assert.match(String(commandRun.content), /没有配置 reportFile/)

    // A call-level threshold that is not a percentage is refused, not rounded.
    const badThreshold = host(cwd, { thresholds: { total: 50 }, reportFile: reportIn('cov-report-c-', LCOV) })
    const badRun = await badThreshold.runTool('coverage_check', { thresholds: { total: 150 } })
    assert.equal(badRun.isError, true)
    assert.match(String(badRun.content), /thresholds\.total 必须在 0–100 之间/)
})

test('coverage_check: an unparseable report is BLOCK with the parser complaint', async () => {
    const cwd = tempWorkspace('cov-badreport-')
    const { id, store } = bindMission(cwd, '报告解析失败')
    const fake = host(cwd, { thresholds: { total: 50 }, reportFile: reportIn('cov-report-d-', 'SF:src/a.ts\nDA:oops,1\nend_of_record\n') })
    const run = runText(await fake.runTool('coverage_check', {}))
    assert.match(run, /覆盖率检查：BLOCK/)
    assert.match(run, /覆盖率报告无法解析/)
    assert.match(run, /DA: 格式非法/)
    assert.match(run, /不是\*\* 0 覆盖/)
    const gate = store.lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.scope?.full, false)
    assert.equal(gate?.results[0]?.id, 'coverage-report')
})

test('coverage_check: incremental coverage against a real git repository', async () => {
    const cwd = gitWorkspace('cov-incremental-')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'line1\nline2\nline3\n')
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd })
    // Three uncommitted added lines, of which two stay uncovered.
    fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'line1\nline2\nline3\nline4\nline5\nline6\n')
    const { id, store } = bindMission(cwd, '增量覆盖率')
    const uncovered = reportIn(
        'cov-report-e-',
        'SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,0\nDA:6,0\nLF:6\nLH:4\nend_of_record\n',
    )
    const fake = host(cwd, { thresholds: { total: 50, changed: 80 }, reportFile: uncovered })
    const blocked = runText(await fake.runTool('coverage_check', {}))
    assert.match(blocked, /增量（本次改动新增行）：插桩 3 行、命中 1 行、未命中 2 行 → 33.3%/)
    assert.match(blocked, /src\/a\.js：新增 3，插桩 3，命中 1\/未命中 2/)
    assert.match(blocked, /未命中行 5,6/)
    assert.match(blocked, /覆盖率检查：BLOCK/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'BLOCK')
    assert.deepEqual(store.lastGate(id, { source: 'dsh-coverage-gate' })?.scope?.selected, ['total', 'changed'])
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.fingerprint?.isRepo, true)

    // The same change with the new lines covered: PASS, scope full, judgement complete.
    const covered = reportIn(
        'cov-report-f-',
        'SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\nDA:6,1\nLF:6\nLH:6\nend_of_record\n',
    )
    const second = host(cwd, { thresholds: { total: 50, changed: 80 }, reportFile: covered })
    const passed = runText(await second.runTool('coverage_check', {}))
    assert.match(passed, /覆盖率检查：PASS/)
    assert.match(passed, /增量（本次改动新增行）：插桩 3 行、命中 3 行、未命中 0 行 → 100%/)
    assert.match(passed, /覆盖范围：完整/)
    const artifact = JSON.parse(store.readArtifact(id, 'artifacts/coverage.json') ?? '{}') as {
        incremental: { judgement: string; percent: number; files: { path: string }[] }
    }
    assert.equal(artifact.incremental.judgement, 'complete')
    assert.equal(Math.round(artifact.incremental.percent), 100)
    assert.deepEqual(
        artifact.incremental.files.filter((file) => file.path.startsWith('src/')).map((file) => file.path),
        ['src/a.js'],
    )
})

test('coverage_check: a coverageCommand runs without a shell and its verdict is authorising', async () => {
    const cwd = tempWorkspace('cov-command-')
    const { id, store } = bindMission(cwd, '覆盖率命令')
    fs.writeFileSync(
        path.join(cwd, 'make-coverage.mjs'),
        [
            "import fs from 'node:fs'",
            "import path from 'node:path'",
            'const out = process.argv[2]',
            'fs.mkdirSync(path.dirname(out), { recursive: true })',
            "fs.writeFileSync(out, 'SF:src/a.ts\\nDA:1,1\\nDA:2,0\\nLF:2\\nLH:1\\nend_of_record\\n')",
            '',
        ].join('\n'),
    )
    const fake = host(cwd, {
        thresholds: { total: 40 },
        coverageCommand: 'node make-coverage.mjs {reportFile}',
        reportFile: 'coverage/lcov.info',
    })
    const run = runText(await fake.runTool('coverage_check', {}))
    assert.match(run, /覆盖率检查：PASS/)
    assert.match(run, /总覆盖率 50%/)
    assert.match(run, /coverage-command/)
    assert.ok(fs.existsSync(path.join(cwd, 'coverage', 'lcov.info')), 'the command wrote the report where reportFile points')
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'PASS')

    // A shell pipeline in the host template is refused by name.
    const shellish = host(cwd, {
        thresholds: { total: 40 },
        coverageCommand: 'node make-coverage.mjs {reportFile} && echo done',
        reportFile: 'coverage/lcov.info',
    })
    const refused = await shellish.runTool('coverage_check', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /shell 元字符 "&"/)
    assert.match(String(refused.content), /argv 直传/)

    // A caller-supplied report file is judged, but not as a delivery basis.
    const foreign = reportIn('cov-report-g-', LCOV)
    const nonAuthorising = runText(await fake.runTool('coverage_check', { reportFile: foreign }))
    assert.match(nonAuthorising, /来源：调用参数/)
    assert.match(nonAuthorising, /覆盖范围：部分/)
    assert.match(nonAuthorising, /报告文件由调用参数指定（非宿主配置）/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.scope?.full, false)
})

// --- flaky_check ------------------------------------------------------------

/**
 * A race-free flaky fixture: the pass/fail decision comes from a counter file
 * (and an env override), never from the clock.
 */
function writeFlakyFixture(cwd: string): void {
    fs.writeFileSync(
        path.join(cwd, 'flaky.mjs'),
        [
            "import fs from 'node:fs'",
            "const counter = new URL('./.flaky-counter', import.meta.url)",
            'let count = 0',
            "try { count = Number(fs.readFileSync(counter, 'utf8')) } catch {}",
            'count += 1',
            "fs.writeFileSync(counter, String(count))",
            "const failOn = Number(process.env['FLAKY_FAIL_ON'] ?? '2')",
            'if (count === failOn) {',
            "  console.log('✖ case A')",
            '  process.exit(1)',
            '}',
            "console.log('✔ case A')",
            'process.exit(0)',
            '',
        ].join('\n'),
    )
}

function resetFlakyCounter(cwd: string): void {
    fs.rmSync(path.join(cwd, '.flaky-counter'), { force: true })
}

test('flaky_check: a counter-driven failure is BLOCKed, attributed and stopped early', async () => {
    const cwd = tempWorkspace('flaky-block-')
    writeFlakyFixture(cwd)
    const { id, store } = bindMission(cwd, 'flaky 门禁')
    const fake = host(cwd, { flakyPolicy: 'block', flakyRepeats: 3, flakyCommand: 'node flaky.mjs {run}' })
    const run = runText(await fake.runTool('flaky_check', { repeats: 3 }))
    assert.match(run, /flaky 检查：BLOCK/)
    assert.match(run, /已提前结束/)
    assert.match(run, /case A（通过 1 \/ 失败 1）/)
    assert.match(run, /第 1 次：通过/)
    assert.match(run, /第 2 次：失败/)
    const gate = store.lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.scope?.full, false, 'an early stop is not a full run')
    assert.equal(gate?.scope?.total, 3)
    assert.equal(gate?.scope?.selected.length, 2)
    assert.equal(gate?.results.length, 2)
    assert.equal(gate?.results[0]?.required, true, 'flakyPolicy=block makes the runs required')
    const artifact = JSON.parse(store.readArtifact(id, 'artifacts/flaky.json') ?? '{}') as {
        stoppedEarly: boolean
        flakyTests: { name: string }[]
    }
    assert.equal(artifact.stoppedEarly, true)
    assert.deepEqual(artifact.flakyTests.map((entry) => entry.name), ['case A'])
})

test('flaky_check: warn records WARN, off records nothing, and repeats are bounded', async () => {
    const cwd = tempWorkspace('flaky-policy-')
    writeFlakyFixture(cwd)
    const { id, store } = bindMission(cwd, 'flaky 策略')

    const warn = host(cwd, { flakyPolicy: 'warn', flakyRepeats: 3, flakyCommand: 'node flaky.mjs {run}' })
    resetFlakyCounter(cwd)
    const warned = runText(await warn.runTool('flaky_check', { repeats: 3 }))
    assert.match(warned, /flaky 检查：WARN/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'WARN')
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.results[0]?.required, false)

    const off = host(cwd, { flakyPolicy: 'off', flakyRepeats: 3, flakyCommand: 'node flaky.mjs {run}' })
    resetFlakyCounter(cwd)
    const gatesBefore = store.readGates(id).length
    const reported = runText(await off.runTool('flaky_check', { repeats: 3 }))
    assert.match(reported, /flakyPolicy=off：只报告，不写门禁记录/)
    assert.match(reported, /\(策略 off，未记录\)/)
    assert.equal(store.readGates(id).length, gatesBefore, 'off writes no gate record')

    // The host's repeat count is a cap, and a single run cannot decide anything.
    const capped = host(cwd, { flakyPolicy: 'block', flakyRepeats: 2, flakyCommand: 'node flaky.mjs {run}' })
    resetFlakyCounter(cwd)
    const capRun = runText(await capped.runTool('flaky_check', { repeats: 5 }))
    assert.match(capRun, /调用要求运行 5 次，按宿主配置上限 2 次执行/)
    assert.match(capRun, /运行：2\/2 次/)
    resetFlakyCounter(cwd)
    const single = runText(await capped.runTool('flaky_check', { repeats: 1 }))
    assert.match(single, /只计划运行 1 次/)
    assert.match(single, /flaky 检查：WARN/)
    assert.match(single, /未能判定 flaky/)
})

test('flaky_check: no command is refused, and a caller-supplied one is non-authorising', async () => {
    const cwd = tempWorkspace('flaky-refuse-')
    writeFlakyFixture(cwd)
    const { id, store } = bindMission(cwd, 'flaky 拒绝')

    const noCommand = host(cwd, { flakyPolicy: 'block' })
    const refused = await noCommand.runTool('flaky_check', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /没有 flaky 命令/)
    assert.match(String(refused.content), /flakyCommand/)

    const hostCommand = host(cwd, { flakyPolicy: 'block', flakyRepeats: 2, flakyCommand: 'node flaky.mjs {run}' })
    resetFlakyCounter(cwd)
    const fromHost = runText(await hostCommand.runTool('flaky_check', { repeats: 2 }))
    assert.match(fromHost, /（宿主配置）/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.scope?.full, true)

    // A command the CALL supplied is judged, but never as a full-scope record.
    resetFlakyCounter(cwd)
    const fromCall = runText(await hostCommand.runTool('flaky_check', { command: 'node flaky.mjs {run0}', repeats: 2 }))
    assert.match(fromCall, /（调用参数）/)
    assert.match(fromCall, /命令由调用参数提供/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.scope?.full, false)

    const badRepeats = await hostCommand.runTool('flaky_check', { repeats: 0 })
    assert.equal(badRepeats.isError, true)
    assert.match(String(badRepeats.content), /repeats 必须是正整数/)
})

test('a configured incremental threshold that cannot be computed is a fail-closed BLOCK', async () => {
    const cwd = tempWorkspace('cov-nogit-')
    const { id, store } = bindMission(cwd, '非 git 工作区')
    const fake = host(cwd, { thresholds: { changed: 80 }, reportFile: reportIn('cov-report-j-', LCOV) })
    const run = runText(await fake.runTool('coverage_check', {}))
    assert.match(run, /覆盖率检查：BLOCK/)
    assert.match(run, /无法计算增量覆盖率/)
    assert.match(run, /配置了 thresholds.changed 就必须能判定它/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'BLOCK')
    assert.deepEqual(store.lastGate(id, { source: 'dsh-coverage-gate' })?.scope?.selected, [])

    // In a repository with no changes, the same threshold is "not applicable"
    // (a judgement nobody asked for) — a PASS, but never a full-scope one.
    const repo = gitWorkspace('cov-nodiff-')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
    const bound = bindMission(repo, '空 diff')
    const ok = host(repo, { thresholds: { total: 30, changed: 80 }, reportFile: reportIn('cov-report-k-', LCOV) })
    const emptyDiff = runText(await ok.runTool('coverage_check', {}))
    assert.match(emptyDiff, /覆盖率检查：PASS/)
    assert.match(emptyDiff, /增量阈值不适用，未判定/)
    assert.match(emptyDiff, /覆盖范围：部分/)
    assert.equal(bound.store.lastGate(bound.id, { source: 'dsh-coverage-gate' })?.scope?.full, false)
})

test('a cancelled run is not a verdict: no gate record, and the report says so', async () => {
    const cwd = tempWorkspace('cov-abort-')
    writeFlakyFixture(cwd)
    const { id, store } = bindMission(cwd, '取消')
    const controller = new AbortController()
    controller.abort()

    const coverage = host(cwd, {
        thresholds: { total: 40 },
        coverageCommand: 'node -e "process.exit(0)"',
        reportFile: 'coverage/lcov.info',
    })
    const coverageRun = runText(await coverage.runTool('coverage_check', {}, { signal: controller.signal }))
    assert.match(coverageRun, /覆盖率检查：已取消/)
    assert.match(coverageRun, /未写入门禁记录/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' }), undefined)

    const flaky = host(cwd, { flakyPolicy: 'block', flakyRepeats: 3, flakyCommand: 'node flaky.mjs {run}' })
    const flakyRun = runText(await flaky.runTool('flaky_check', {}, { signal: controller.signal }))
    assert.match(flakyRun, /flaky 检查：已取消/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' }), undefined)
    assert.equal(fs.existsSync(path.join(cwd, '.flaky-counter')), false, 'the cancelled command never started')
})

// --- coverage_status --------------------------------------------------------

test('coverage_status: thresholds, sources and the newest numbers', async () => {
    const cwd = tempWorkspace('cov-status-')
    const { id, store } = bindMission(cwd, '状态查询')
    const reportFile = reportIn('cov-report-h-', LCOV)
    const fake = host(cwd, {
        thresholds: { total: 30, perFile: 0 },
        reportFile,
        flakyPolicy: 'warn',
        flakyRepeats: 4,
        flakyCommand: 'node -v',
    })
    const before = runText(await fake.runTool('coverage_status', {}))
    assert.match(before, /阈值：total ≥ 30%（profile 配置），perFile ≥ 0%（profile 配置）/)
    assert.match(before, /报告来源：未配置覆盖率命令；reportFile/)
    assert.match(before, /flaky：策略 warn，重复 4 次/)
    assert.match(before, /最新 coverage 门禁：\(未运行过\)/)

    await fake.runTool('coverage_check', {})
    const after = runText(await fake.runTool('coverage_status', {}))
    assert.match(after, new RegExp(`mission: ${id}`))
    assert.match(after, /最新 coverage 门禁：PASS/)
    assert.match(after, /总覆盖率 40%/)
    assert.match(after, /最新工件（artifacts\/coverage\.json/)
    assert.match(after, /最差文件：src\/b\.ts 0%/)
    assert.equal(store.lastGate(id, { source: 'dsh-coverage-gate' })?.state, 'PASS')

    // A gate that produced no artifact (unparseable report) is not silently
    // presented as the artifact's numbers.
    fs.writeFileSync(reportFile, 'SF:src/a.ts\nDA:oops,1\nend_of_record\n')
    await fake.runTool('coverage_check', {})
    const stale = runText(await fake.runTool('coverage_status', {}))
    assert.match(stale, /最新 coverage 门禁：BLOCK/)
    assert.match(stale, /早于最新门禁/)

    // Without any threshold the status says the gate will refuse.
    const bare = host(cwd, {})
    const bareStatus = runText(await bare.runTool('coverage_status', {}))
    assert.match(bareStatus, /没有生效的覆盖率阈值/)
})

// --- project overlay --------------------------------------------------------

test('project overlay: which command/report/thresholds apply is the repository\'s choice', async () => {
    const profileReport = reportIn('cov-report-i-', LCOV)
    const fake = host(tempWorkspace('cov-overlay-logs-'), { thresholds: { total: 99 }, reportFile: profileReport })

    // Workspace A lowers its own bar through <repo>/.dsh/coverage-gate.json.
    const cwdA = tempWorkspace('cov-overlay-a-')
    fs.mkdirSync(path.join(cwdA, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwdA, '.dsh', 'coverage-gate.json'),
        JSON.stringify({ thresholds: { total: 30 }, reportFile: profileReport, flakyRepeats: 5 }),
    )
    const agentA = { id: 'agent-a', session: { id: 'session-a', header: { id: 'session-a', cwd: cwdA } } }
    const runA = runText(await fake.runTool('coverage_check', {}, { agent: agentA }))
    assert.match(runA, /覆盖率检查：PASS/)
    assert.match(runA, /来源 项目级配置/)
    const statusA = runText(await fake.runTool('coverage_status', {}, { agent: agentA }))
    assert.match(statusA, /配置来源：项目级配置/)
    assert.match(statusA, /total ≥ 30%（项目级配置）/)

    // Workspace B has no project file → the profile's 99% applies and blocks.
    const cwdB = tempWorkspace('cov-overlay-b-')
    const agentB = { id: 'agent-b', session: { id: 'session-b', header: { id: 'session-b', cwd: cwdB } } }
    const runB = runText(await fake.runTool('coverage_check', {}, { agent: agentB }))
    assert.match(runB, /覆盖率检查：BLOCK/)
    assert.match(runB, /来源 profile 配置/)
})

test('project overlay: host-only keys are refused, malformed files fall back', () => {
    const cwd = tempWorkspace('cov-overlay-guard-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'coverage-gate.json'),
        JSON.stringify({
            enabled: false,
            logFile: '/tmp/evil.log',
            layout: { rootDir: '/tmp' },
            flakyPolicy: 'off',
            prompt: { enabled: false },
            thresholds: { total: 40 },
            coverageCommand: 'cargo llvm-cov --lcov',
            reportFile: null,
            flakyCommand: 'cargo test',
        }),
    )
    const hostConfig = resolveConfig({ thresholds: { total: 90 }, reportFile: 'profile.info', flakyPolicy: 'block' })
    const layout = { cwd, rootDir: path.join(cwd, '.dsh'), specsDir: '', missionsDir: '', auditDir: '', stateDir: '', rolesDir: '' }
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.enabled, true, 'a repository cannot switch the gate off')
    assert.equal(effective.config.logFile, hostConfig.logFile)
    assert.ok(!effective.config.logFileTemplate)
    assert.equal(effective.config.flakyPolicy, 'block', 'flakyPolicy is host-only')
    assert.equal(effective.config.prompt.enabled, true)
    assert.equal(effective.config.thresholds.total, 40)
    assert.equal(effective.config.coverageCommand, 'cargo llvm-cov --lcov')
    assert.equal(effective.config.flakyCommand, 'cargo test')
    assert.equal(effective.config.reportFile, undefined, 'an explicit null clears the inherited value')
    assert.deepEqual(effective.config.layout, hostConfig.layout === undefined ? {} : {})
    const problems = effective.problems.join('\n')
    for (const key of ['enabled', 'logFile', 'layout', 'flakyPolicy', 'prompt']) {
        assert.match(problems, new RegExp(`键 "${key}" 不允许在项目级配置里覆盖`))
    }

    // An unusable threshold keeps the profile's value and says why.
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ thresholds: { total: 500 } }))
    const kept = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(kept.config.thresholds.total, 90)
    assert.match(kept.problems.join('\n'), /thresholds\.total 必须在 0–100 之间/)

    // A malformed file falls back to the profile instead of disabling the gate.
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), '{ not json')
    const malformed = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(malformed.source, 'profile')
    assert.equal(malformed.config.thresholds.total, 90)
    assert.match(malformed.problems.join('\n'), /不是合法 JSON/)

    // Every key refused → the profile configuration stays in force.
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ enabled: false, logFile: '/tmp/x' }))
    const refused = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(refused.source, 'profile')
    assert.equal(refused.config.reportFile, 'profile.info')
    assert.ok(refused.problems.length >= 2)
})

test('the prompt section names the repository config and the honest limits', () => {
    const cwd = tempWorkspace('cov-prompt-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ thresholds: { total: 10 } }))
    const fake = host(tempWorkspace('cov-prompt-logs-'), { thresholds: { total: 80 } })
    const section = fake.sections.find((entry) => entry.name === 'eng:coverage-gate') as { text: (assembly?: unknown) => string }
    const textA = section.text({ scope: { session: { header: { cwd } } } })
    assert.match(textA, /coverage-gate\.json/)
    assert.match(textA, /当前的阈值|当前阈值/)
    const textProfile = section.text({ scope: fake.agent })
    assert.doesNotMatch(textProfile, /coverage-gate\.json/)
    assert.match(textProfile, /没被插桩的行不能判定/)
    assert.match(textProfile, /flaky 是测试套件的缺陷/)
    assert.match(textProfile, /scope\.full=false/)
})

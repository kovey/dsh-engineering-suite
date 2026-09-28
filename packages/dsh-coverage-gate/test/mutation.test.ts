/**
 * dsh-coverage-gate — mutation testing.
 *
 * Five groups, in the order the honesty rules are stacked:
 *  - PURE word-level rules: operators, ids, the string/comment state machine and
 *    the "bare integer only" rule;
 *  - PLANNING: determinism, the mutant cap (a sample says it is a sample) and the
 *    file selection (`.dsh/**`, vendor, build output, generated files, tests);
 *  - EXECUTION: killed / survived / run-error, restore-after-failure including
 *    timeout, the external-edit refusal and the time budget;
 *  - the `mutation_check` TOOL against a fake host: refusals (disabled, no
 *    threshold, no command), the derived test command, thresholds → PASS / WARN /
 *    BLOCK, and the recorded `GateRecord` scope;
 *  - one end-to-end run against a REAL temp git repository and a REAL test command
 *    (`node test/suite.mjs`), because a stubbed runner proves the classification
 *    and a real one proves the wiring.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, resolveEffectiveConfig } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'
import {
    classifyMutantOutcome,
    collectSourceFiles,
    isExcludedPath,
    judgeMutation,
    maskDocument,
    mutationScoreOf,
    planMutants,
    resolveOperators,
    runMutationPlan,
    stripCoverageDecorations,
    MutationRestoreError,
    DEFAULT_EXCLUDE_GLOBS,
    MUTATION_OPERATORS,
} from '../dist/mutation.js'

// --- fixtures and helpers ---------------------------------------------------

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
function bindMission(cwd: string, title: string): { id: string; store: ReturnType<MissionStoreRegistry['for']> } {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    return { id: mission.id, store }
}

/** A git workspace with one commit and a clean tree. */
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

/** Write a file (and its parent directories) inside a workspace. */
function write(cwd: string, relative: string, body: string): string {
    const file = path.join(cwd, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    return file
}

/**
 * A scripted `ctx.subprocess`: no process is started, the outcome is decided by
 * the test (optionally by READING the mutated file, which is how a stub proves
 * the mutation was really written before the command ran).
 */
function scriptedSubprocess(
    decide: (spec: { argv: readonly string[]; cwd: string }) => { exitCode: number | null; stdout?: string },
): unknown {
    return {
        spawn(spec: { argv: readonly string[]; cwd: string }) {
            const outcome = decide({ argv: spec.argv, cwd: spec.cwd })
            const text = outcome.stdout ?? ''
            return {
                done: Promise.resolve({ exitCode: outcome.exitCode, signal: null }),
                collected: {
                    stdout: { readFrom: () => ({ text }) },
                    stderr: { readFrom: () => ({ text: '' }) },
                },
                terminate: () => undefined,
            }
        },
    }
}

/** Provide a fake subprocess service on a fake host. */
function provideSubprocess(fake: FakeHost, service: unknown): void {
    ;(fake.ctx as { provide: (name: string, value: unknown) => void }).provide('subprocess', service)
}

/** The source fixture the pure tests mutate. */
const SOURCE = [
    'export const LIMIT = 10',
    'export function below(x) {',
    '    return x < 10 && x >= 0',
    '}',
    '',
].join('\n')

/** A fixture whose whole plan is exactly 5 mutants (2 literals + 1 comparison). */
const SMALL = 'export const one = 1 < 2\n'

// --- operators and the lexical scan -----------------------------------------

test('mutation: every operator applies textually with exact positions and a stable id', () => {
    const text = ['a < b', 'c <= d', 'e > f', 'g >= h', 'i == j', 'k != l', 'm && n', 'o || p', 'q = r + s', 't = u - v', 'w = x * y', 'z = aa / bb', 'flag = true', 'other = false'].join('\n')
    const plan = planMutants({ files: [{ path: 'src/a.ts', text }] })
    assert.deepEqual(
        plan.mutants.map((mutant) => [mutant.line, mutant.column, mutant.operator, mutant.tokenBefore, mutant.tokenAfter]),
        [
            [1, 2, 'REL_LT_TO_LE', '<', '<='],
            [2, 2, 'REL_LE_TO_LT', '<=', '<'],
            [3, 2, 'REL_GT_TO_GE', '>', '>='],
            [4, 2, 'REL_GE_TO_GT', '>=', '>'],
            [5, 2, 'EQ_TO_NE', '==', '!='],
            [6, 2, 'NE_TO_EQ', '!=', '=='],
            [7, 2, 'AND_TO_OR', '&&', '||'],
            [8, 2, 'OR_TO_AND', '||', '&&'],
            [9, 6, 'PLUS_TO_MINUS', '+', '-'],
            [10, 6, 'MINUS_TO_PLUS', '-', '+'],
            [11, 6, 'MUL_TO_DIV', '*', '/'],
            [12, 7, 'DIV_TO_MUL', '/', '*'],
            [13, 7, 'TRUE_TO_FALSE', 'true', 'false'],
            [14, 8, 'FALSE_TO_TRUE', 'false', 'true'],
        ],
    )
    // The id encodes file:line:column:operator, so two plans over the same bytes
    // are byte-identical — a mutant a reviewer quotes is the mutant that ran.
    assert.deepEqual(
        plan.mutants[0]?.id,
        'src/a.ts:1:2:REL_LT_TO_LE',
    )
    assert.deepEqual(plan.mutants.map((mutant) => mutant.id), planMutants({ files: [{ path: 'src/a.ts', text }] }).mutants.map((mutant) => mutant.id))
    // The report snippet shows the line, mutated.
    const first = plan.mutants[0]
    assert.equal(first?.snippetBefore, 'a < b')
    assert.equal(first?.snippetAfter, 'a <= b')
})

test('mutation: strings, comments and template literals are never mutated', () => {
    const text = [
        'const a = x // "true" and 1 == 1 in a comment must not be mutated',
        '/* block comment: 3 > 2 && false */',
        'const s = "x < 2 && true"',
        "const t = 'a != b'",
        'const u = `x <= 2`',
        'const v = 7',
        '',
    ].join('\n')
    const plan = planMutants({ files: [{ path: 'src/a.ts', text }] })
    assert.deepEqual(
        plan.mutants.map((mutant) => [mutant.line, mutant.operator, mutant.tokenBefore]),
        [
            [6, 'INT_DEC', '7'],
            [6, 'INT_INC', '7'],
        ],
        'only the real literal on line 6 is in the plan',
    )

    // A multi-line block comment and a multi-line template literal are carried
    // across lines (the state machine is per line, its state is not).
    const multi = ['/*', '2 > 1 && true', '*/', 'const t = `', '3 <= 4', '`', 'const real = 5'].join('\n')
    assert.deepEqual(
        planMutants({ files: [{ path: 'src/b.ts', text: multi }] }).mutants.map((mutant) => [mutant.line, mutant.operator]),
        [
            [7, 'INT_DEC'],
            [7, 'INT_INC'],
        ],
    )

    // Python: `#` comments and `"""docstrings"""` are blanked too.
    const python = ['# 1 < 2', '"""doc: true == false"""', 'x = 3'].join('\n')
    assert.deepEqual(
        planMutants({ files: [{ path: 'a.py', text: python }] }).mutants.map((mutant) => [mutant.line, mutant.operator]),
        [
            [3, 'INT_DEC'],
            [3, 'INT_INC'],
        ],
    )
    // `maskDocument` keeps the line length, which is what keeps columns valid.
    const masked = maskDocument('const s = "abc" // x')
    assert.equal(masked[0]?.length, 'const s = "abc" // x'.length)
    assert.equal(masked[0]?.includes('abc'), false)
})

test('mutation: ±1 applies to bare integer literals only', () => {
    const text = ['const a = 1', 'const b = 1.5', 'const c = 0x1f', 'const d = x1', 'const e = 007', 'const f = v1_000', 'arr[0] = 2', 'const g = 1234567890123456'].join('\n')
    const plan = planMutants({ files: [{ path: 'src/a.ts', text }] })
    assert.deepEqual(
        plan.mutants.map((mutant) => [mutant.line, mutant.operator, mutant.tokenBefore, mutant.tokenAfter]),
        [
            [1, 'INT_DEC', '1', '0'],
            [1, 'INT_INC', '1', '2'],
            [7, 'INT_DEC', '0', '-1'],
            [7, 'INT_INC', '0', '1'],
            [7, 'INT_DEC', '2', '1'],
            [7, 'INT_INC', '2', '3'],
        ],
        'floats, hex, identifiers, octal-looking and 16-digit literals are left alone',
    )
    // `<=`, `+=`, `->`, `<<`, `===` are larger tokens: only `==` may match.
    const tokens = ['a === b', 'c += 1', 'd -> e', 'f << 2', 'g <= h'].join('\n')
    assert.deepEqual(
        planMutants({ files: [{ path: 'src/b.ts', text: tokens }] }).mutants.map((mutant) => [mutant.line, mutant.operator]),
        [
            [2, 'INT_DEC'],
            [2, 'INT_INC'],
            [4, 'INT_DEC'],
            [4, 'INT_INC'],
            [5, 'REL_LE_TO_LT'],
        ],
    )
})

test('mutation: the operator set is filterable by id and by group, and unknown names are refused', () => {
    const text = 'a < b && c == 2'
    const relational = planMutants({ files: [{ path: 'src/a.ts', text }], operators: ['relational'] })
    assert.deepEqual(relational.operatorIds.sort(), ['REL_GE_TO_GT', 'REL_GT_TO_GE', 'REL_LE_TO_LT', 'REL_LT_TO_LE'])
    assert.deepEqual(relational.mutants.map((mutant) => mutant.operator), ['REL_LT_TO_LE'])

    const one = planMutants({ files: [{ path: 'src/a.ts', text }], operators: ['AND_TO_OR'] })
    assert.deepEqual(one.mutants.map((mutant) => mutant.operator), ['AND_TO_OR'])

    const refused = resolveOperators(['REL_LT_TO_LE', 'lt_to_le'])
    assert.ok('error' in refused)
    assert.match(refused.error, /未知的变异操作符 "lt_to_le"/)
    assert.match(refused.error, /REL_LT_TO_LE/)
    assert.match(refused.error, /relational/)
    assert.throws(() => planMutants({ files: [{ path: 'src/a.ts', text }], operators: ['nope'] }), /未知的变异操作符/)
})

test('mutation: planning is deterministic and the mutant cap samples round-robin across files', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((file) => ({
        path: file,
        text: ['const x = 1', 'const y = 2', 'const z = 3'].join('\n'),
    }))
    const all = planMutants({ files })
    assert.equal(all.available, 18, '3 files × 3 literals × (±1)')
    assert.equal(all.truncated, false)
    assert.deepEqual(all.files, ['src/a.ts', 'src/b.ts', 'src/c.ts'])

    const capped = planMutants({ files, maxMutants: 4 })
    assert.equal(capped.available, 18)
    assert.equal(capped.truncated, true)
    assert.equal(capped.mutants.length, 4)
    assert.deepEqual(capped.files, ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'the sample covers every file, not just the alphabetically first')
    assert.deepEqual(capped.mutants.map((mutant) => mutant.id), planMutants({ files, maxMutants: 4 }).mutants.map((mutant) => mutant.id))
    assert.match(capped.notes.join('\n'), /抽样/)
    assert.match(capped.notes.join('\n'), /不外推/)
})

// --- file selection ---------------------------------------------------------

test('mutation: .dsh, vendor, build output, generated files and test files are never mutated', () => {
    for (const excluded of [
        '.dsh/coverage-gate.json',
        '.git/config',
        'node_modules/pkg/a.ts',
        'vendor/lib/a.go',
        'dist/bundle.js',
        'src/a.min.js',
        'src/types.d.ts',
        'src/api.pb.go',
        'src/model_generated.go',
        'src/schema.gen.ts',
    ]) {
        assert.equal(isExcludedPath(excluded, DEFAULT_EXCLUDE_GLOBS), true, `${excluded} must be excluded`)
    }
    assert.equal(isExcludedPath('src/a.ts', DEFAULT_EXCLUDE_GLOBS), false)

    const cwd = gitWorkspace('mut-select-')
    write(cwd, 'src/a.ts', 'const a = 1\n')
    write(cwd, 'src/a.test.ts', 'const t = 2\n')
    write(cwd, 'dist/bundle.ts', 'const b = 3\n')
    write(cwd, 'src/types.d.ts', 'declare const c: 4\n')
    write(cwd, '.dsh/ledger.ts', 'const d = 5\n')
    return collectSourceFiles({ cwd, sourceGlobs: ['**/*.ts'] }).then((collected) => {
        assert.deepEqual(collected.files.map((file) => file.path), ['src/a.ts'])
        const reasons = collected.skipped.map((entry) => `${entry.path}: ${entry.reason}`).join('\n')
        assert.match(reasons, /src\/a\.test\.ts: 是测试文件/)
        assert.match(reasons, /src\/types\.d\.ts: 命中排除 glob/)
        // `.dsh` never even reaches the exclusion list here: the shared walker
        // prunes the trust root, node_modules and vendor. The changed-file path
        // (below) is where the configured globs do the work.
        assert.equal(
            collected.skipped.some((entry) => entry.path.startsWith('.dsh/')),
            false,
        )
        assert.equal(collected.notes.length, 0, 'globs were configured, so nothing is "detected"')
    })
})

test('mutation: sourceGlobs are detected from the workspace languages when unset', async () => {
    const cwd = gitWorkspace('mut-detect-')
    write(cwd, 'internal/a.go', 'package internal\n\nfunc A() int { return 1 }\n')
    write(cwd, 'web/b.ts', 'export const b = 2\n')
    const collected = await collectSourceFiles({ cwd })
    assert.deepEqual(collected.files.map((file) => file.path), ['internal/a.go', 'web/b.ts'])
    assert.match(collected.notes.join('\n'), /按工作区实际语言探测（go, ts）/)
    assert.deepEqual(collected.sourceGlobs, ['**/*.go', '**/*.ts', '**/*.tsx'])
})

test('mutation: changed mode takes its file set from changedRanges (and still excludes the trail)', async () => {
    const cwd = gitWorkspace('mut-changed-')
    write(cwd, 'src/a.ts', 'const a = 1\n')
    write(cwd, 'src/b.ts', 'const b = 2\n')
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'ignore' })
    // The current work: one source file changed, a new source file, an untracked
    // ledger file under .dsh (which is not source, however new it is).
    write(cwd, 'src/a.ts', 'const a = 1\nconst extra = 3\n')
    write(cwd, 'src/c.ts', 'const c = 4\n')
    write(cwd, '.dsh/ledger.ts', 'const ledger = 5\n')

    const collected = await collectSourceFiles({ cwd, changed: true, baseRef: 'HEAD', sourceGlobs: ['**/*.ts'] })
    assert.deepEqual(collected.files.map((file) => file.path), ['src/a.ts', 'src/c.ts'])
    assert.deepEqual(
        collected.skipped.map((entry) => entry.path).sort(),
        ['.dsh/ledger.ts'],
        'a changed file under the trust root is skipped, not mutated',
    )
    assert.match(collected.notes.join('\n'), /changed：只变异相对 HEAD 改动的文件/)

    // A non-repository cannot answer "what changed": that is a refusal, not an
    // empty plan.
    const plain = tempWorkspace('mut-norepo-')
    write(plain, 'src/a.ts', 'const a = 1\n')
    const broken = await collectSourceFiles({ cwd: plain, changed: true, sourceGlobs: ['**/*.ts'] })
    assert.equal(broken.files.length, 0)
    assert.ok(broken.problem !== undefined)
    const tool = host(plain, { mutation: { enabled: true, thresholds: { mutationScore: 50 }, testCommand: 'node -e 0' } })
    const refused = await tool.runTool('mutation_check', { changed: true })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /无法读取改动文件/)
    assert.match(String(refused.content), /下一步：确认工作区是 git 仓库/)
})

// --- execution --------------------------------------------------------------

test('mutation: killed / survived / run-error are classified from the command, never guessed', async () => {
    const cwd = tempWorkspace('mut-run-')
    const file = write(cwd, 'src/a.ts', SMALL)
    const plan = planMutants({ files: [{ path: 'src/a.ts', text: SMALL }] })
    assert.equal(plan.mutants.length, 5)
    const observed: string[] = []
    const run = await runMutationPlan(plan, {
        cwd,
        argv: ['node', '-e', '0'],
        timeoutMs: 1_000,
        timeBudgetMs: 60_000,
        run: async (spec) => {
            // The command runner sees the MUTATED file: that is what makes the
            // verdict evidence rather than bookkeeping.
            observed.push(fs.readFileSync(path.join(cwd, spec.mutant.file), 'utf8'))
            if (spec.mutant.operator === 'REL_LT_TO_LE') return { exitCode: 1, durationMs: 5 }
            if (spec.mutant.operator === 'INT_DEC') return { exitCode: null, timedOut: true, durationMs: 7 }
            return { exitCode: 0, durationMs: 3 }
        },
    })
    assert.deepEqual(run.counts, { executed: 5, killed: 1, survived: 2, runError: 2 })
    assert.equal(run.score, (1 / 3) * 100, 'score = killed ÷ (killed + survived) = 1 ÷ 3')
    assert.equal(run.formula.includes('1 ÷ (1 + 2)'), true)
    assert.equal(run.formula.includes('run-error 2 个不计入分母'), true)
    assert.equal(run.stopped, 'complete')
    assert.deepEqual(run.survivors.map((survivor) => survivor.operator).sort(), ['INT_INC', 'INT_INC'])
    for (const result of run.results) {
        assert.match(result.reason, result.verdict === 'killed' ? /测试套件发现了这处改动/ : result.verdict === 'survived' ? /没有任何断言发现了这处改动/ : /不是被杀死/)
    }
    assert.equal(observed.every((text) => text !== SMALL), true, 'every run happened against a mutated file')
    assert.equal(fs.readFileSync(file, 'utf8'), SMALL, 'and the file is byte-identical afterwards')
})

test('mutation: a timeout is run-error (never a kill) and the file is still restored', async () => {
    const cwd = tempWorkspace('mut-timeout-')
    const file = write(cwd, 'src/a.ts', SOURCE)
    const plan = planMutants({ files: [{ path: 'src/a.ts', text: SOURCE }], maxMutants: 2 })
    const run = await runMutationPlan(plan, {
        cwd,
        argv: ['node', '-e', '0'],
        timeoutMs: 1_000,
        timeBudgetMs: 60_000,
        run: async () => ({ exitCode: null, timedOut: true, durationMs: 1_000 }),
    })
    assert.equal(run.counts.killed, 0, 'a hung suite is not a detection')
    assert.equal(run.counts.runError, 2)
    assert.equal(run.counts.survived, 0)
    assert.equal(run.score, undefined, 'nothing was judged, so there is no score')
    assert.match(run.formula, /无法判定（分母为 0）/)
    for (const result of run.results) assert.match(result.reason, /超时/)
    assert.equal(fs.readFileSync(file, 'utf8'), SOURCE)
    // The classifier itself, spelled out: only a real non-zero exit is a kill.
    assert.equal(classifyMutantOutcome({ exitCode: 1 }).verdict, 'killed')
    assert.equal(classifyMutantOutcome({ exitCode: 0 }).verdict, 'survived')
    assert.equal(classifyMutantOutcome({ exitCode: null, timedOut: true }).verdict, 'run-error')
    assert.equal(classifyMutantOutcome({ exitCode: null, spawnError: 'ENOENT' }).verdict, 'run-error')
    assert.equal(classifyMutantOutcome({ exitCode: null, signal: 'SIGSEGV' }).verdict, 'run-error')
    assert.equal(classifyMutantOutcome({ exitCode: 0, aborted: true }).verdict, 'run-error')
})

test('mutation: the failing-mutant path restores the exact bytes it started with', async () => {
    const cwd = tempWorkspace('mut-restore-')
    // Deliberately non-UTF-8-safe: CRLF endings and a BOM must come back exactly.
    const body = '\uFEFFconst a = 1\r\nconst b = 2\r\n'
    const file = write(cwd, 'src/a.ts', body)
    const before = fs.readFileSync(file)
    const plan = planMutants({ files: [{ path: 'src/a.ts', text: body }] })
    const run = await runMutationPlan(plan, {
        cwd,
        argv: ['node', '-e', '0'],
        timeoutMs: 1_000,
        timeBudgetMs: 60_000,
        run: async (spec) => {
            assert.notEqual(fs.readFileSync(path.join(cwd, spec.mutant.file)).toString('utf8'), body)
            return { exitCode: 1, durationMs: 1 }
        },
    })
    assert.equal(run.counts.killed, plan.mutants.length)
    assert.deepEqual(fs.readFileSync(file), before, 'byte-identical: BOM and CRLF included')
})

test('mutation: an external edit during the run is a refusal, not a silent overwrite', async () => {
    const cwd = tempWorkspace('mut-external-')
    const file = write(cwd, 'src/a.ts', SOURCE)
    const plan = planMutants({ files: [{ path: 'src/a.ts', text: SOURCE }], maxMutants: 1 })
    await assert.rejects(
        runMutationPlan(plan, {
            cwd,
            argv: ['node', '-e', '0'],
            timeoutMs: 1_000,
            timeBudgetMs: 60_000,
            run: async (spec) => {
                // Another agent writing the same file mid-run.
                fs.writeFileSync(path.join(cwd, spec.mutant.file), 'const someoneElse = 9\n')
                return { exitCode: 0, durationMs: 1 }
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof MutationRestoreError)
            assert.match(error.message, /在变异体 .* 运行期间被外部改动/)
            assert.match(error.message, /下一步：确认没有别的进程/)
            assert.match(error.message, /本工具没有还原它/)
            return true
        },
    )
    // The other writer's bytes stay exactly as written: putting our pre-run
    // snapshot back over them would destroy work, and the refusal would claim
    // the opposite ("为了避免覆盖别人的改动" while overwriting it).
    assert.equal(fs.readFileSync(file, 'utf8'), 'const someoneElse = 9\n', 'an external edit is left as the external writer wrote it')
})

test('mutation: the time budget stops the run, and the partial result says it is partial', async () => {
    const cwd = tempWorkspace('mut-budget-')
    const file = write(cwd, 'src/a.ts', SMALL)
    const plan = planMutants({ files: [{ path: 'src/a.ts', text: SMALL }] })
    let clock = 0
    const run = await runMutationPlan(plan, {
        cwd,
        argv: ['node', '-e', '0'],
        timeoutMs: 1_000,
        timeBudgetMs: 25_000,
        now: () => clock,
        run: async () => {
            clock += 10_000
            return { exitCode: 1, durationMs: 10_000 }
        },
    })
    assert.equal(run.stopped, 'budget')
    assert.equal(run.counts.executed, 3, 'the fourth mutant is not started once the budget is gone')
    assert.equal(run.planned, 5)
    assert.equal(run.score, 100, 'the score covers exactly the mutants that ran')
    assert.equal(fs.readFileSync(file, 'utf8'), SMALL)
    // The verdict says the run is partial instead of extrapolating, and the
    // budget arithmetic reaches the notes verbatim.
    const verdict = judgeMutation({ run, thresholds: { mutationScore: 50 }, changed: false })
    assert.equal(verdict.state, 'WARN')
    assert.match(verdict.reason, /时间预算用尽/)
    assert.match(verdict.notes.join('\n'), /时间预算 25000ms 用尽：计划 5 个变异体，实际跑完 3 个/)
    assert.equal(verdict.checks[0]?.ok, true)
})

// --- score and verdict arithmetic -------------------------------------------

test('mutation: the score prints both numbers and the formula, and is undefined when nothing was judged', () => {
    const scored = mutationScoreOf({ executed: 10, killed: 8, survived: 2, runError: 3 })
    assert.equal(scored.score, 80)
    assert.equal(scored.denominator, 10)
    assert.equal(scored.formula, 'score = killed ÷ (killed + survived) = 8 ÷ (8 + 2) = 80%；run-error 3 个不计入分母（未跑到的变异体是未知，既不算杀死也不算存活）')
    const empty = mutationScoreOf({ executed: 2, killed: 0, survived: 0, runError: 2 })
    assert.equal(empty.score, undefined)
    assert.match(empty.formula, /无法判定（分母为 0）/)

    const base = {
        results: [],
        counts: { executed: 4, killed: 3, survived: 1, runError: 0 },
        score: 75,
        formula: 'score = killed ÷ (killed + survived) = 3 ÷ (3 + 1) = 75%',
        stopped: 'complete' as const,
        planned: 4,
        available: 4,
        truncated: false,
        timeBudgetMs: 60_000,
        elapsedMs: 1_000,
        files: ['src/a.ts'],
        survivors: [],
        notes: [],
    }
    // Threshold met → PASS; a missed score → BLOCK; an absolute survivor cap → BLOCK.
    assert.equal(judgeMutation({ run: base, thresholds: { mutationScore: 75 }, changed: false }).state, 'PASS')
    const missed = judgeMutation({ run: base, thresholds: { mutationScore: 80 }, changed: false })
    assert.equal(missed.state, 'BLOCK')
    assert.match(missed.reason, /变异测试不达标/)
    assert.match(missed.checks[0]?.output ?? '', /阈值 80% → 不达标/)
    const capped = judgeMutation({ run: base, thresholds: { mutationScore: 75, maxSurvived: 0 }, changed: false })
    assert.equal(capped.state, 'BLOCK')
    assert.match(capped.checks[1]?.expectation ?? '', /mutation\.survived <= 0/)
    // Nothing judged at all: fail closed, and say which number is missing.
    const nothing = judgeMutation({
        run: { ...base, counts: { executed: 2, killed: 0, survived: 0, runError: 2 }, score: undefined },
        thresholds: { mutationScore: 50 },
        changed: false,
    })
    assert.equal(nothing.state, 'BLOCK')
    assert.equal(nothing.checks[0]?.ok, null)
    assert.match(nothing.reason, /无法判定/)
    // `changed` prefers changedMutationScore and falls back to mutationScore.
    const changed = judgeMutation({ run: base, thresholds: { mutationScore: 10, changedMutationScore: 90 }, changed: true })
    assert.equal(changed.state, 'BLOCK')
    assert.match(changed.checks[0]?.expectation ?? '', /changedMutationScore/)
    assert.equal(judgeMutation({ run: base, thresholds: { mutationScore: 10 }, changed: true }).state, 'PASS')
})

// --- the tool ---------------------------------------------------------------

test('mutation_check: disabled by default, and the refusal names the key to set', async () => {
    const cwd = tempWorkspace('mut-off-')
    const fake = host(cwd, { thresholds: { total: 80 } })
    const run = await fake.runTool('mutation_check', {})
    assert.equal(run.isError, true)
    assert.match(String(run.content), /没有启用变异测试/)
    assert.match(String(run.content), /mutation: \{ enabled: true/)
    assert.equal(resolveConfig({}).mutation.enabled, false, 'the default is off')
})

test('mutation_check: refused without a threshold, and without a test command', async () => {
    const cwd = tempWorkspace('mut-nothresh-')
    write(cwd, 'src/a.ts', 'const a = 1\n')
    const noThreshold = host(cwd, { mutation: { enabled: true, testCommand: 'node -e 0' } })
    const first = await noThreshold.runTool('mutation_check', {})
    assert.equal(first.isError, true)
    assert.match(String(first.content), /没有生效的变异阈值/)
    assert.match(String(first.content), /mutation\.thresholds/)

    const noCommand = host(cwd, {
        mutation: { enabled: true, thresholds: { mutationScore: 50 } },
    })
    const second = await noCommand.runTool('mutation_check', {})
    assert.equal(second.isError, true)
    assert.match(String(second.content), /没有可用的测试命令/)
    assert.match(String(second.content), /mutation\.testCommand/)
    assert.match(String(second.content), /flakyCommand/)
    assert.match(String(second.content), /coverageCommand/)
})

test('mutation_check: the test command falls back only where nothing has to be guessed', async () => {
    const cwd = tempWorkspace('mut-derive-')
    write(cwd, 'src/a.ts', 'const a = 1\n')
    // A coverage command that IS a test invocation plus a coverage switch.
    const derived = host(cwd, {
        coverageCommand: 'npx vitest run --coverage',
        reportFile: 'coverage/lcov.info',
        mutation: { enabled: true, thresholds: { mutationScore: 50 } },
    })
    const run = await derived.runTool('mutation_check', { maxMutants: 1 })
    const text = runText(run)
    assert.match(text, /由宿主配置的 coverageCommand 去掉覆盖率参数/)
    assert.match(text, /npx vitest run/)

    // A coverage command with no recognisable coverage flag: refuse, name the key.
    const ambiguous = host(tempWorkspace('mut-derive2-'), {
        coverageCommand: 'npx vitest run',
        reportFile: 'coverage/lcov.info',
        mutation: { enabled: true, thresholds: { mutationScore: 50 } },
    })
    const refused = await ambiguous.runTool('mutation_check', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /不能推出测试命令/)
    assert.match(String(refused.content), /mutation\.testCommand/)

    // A coverage command that needs a report file placeholder is refused too.
    const placeheld = host(tempWorkspace('mut-derive3-'), {
        coverageCommand: 'npx vitest run --coverage --coverage.reporter=lcov --outputFile={reportFile}',
        reportFile: 'coverage/lcov.info',
        mutation: { enabled: true, thresholds: { mutationScore: 50 } },
    })
    const third = await placeheld.runTool('mutation_check', {})
    assert.equal(third.isError, true)
    assert.match(String(third.content), /占位符 \{reportFile\}/)

    assert.deepEqual(stripCoverageDecorations(['go', 'test', '-coverprofile=coverage.out', './...']), {
        argv: ['go', 'test', './...'],
        stripped: ['-coverprofile=coverage.out'],
    })
    assert.deepEqual(stripCoverageDecorations(['npx', 'vitest', 'run']).stripped, [])
})

test('mutation_check: a stubbed runner produces the score, the survivor list and a full gate scope', async () => {
    const cwd = gitWorkspace('mut-stub-')
    const source = write(cwd, 'src/lib.ts', 'export const LIMIT = 10\nexport const below = (x: number) => x < 10\n')
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'ignore' })
    const { id } = bindMission(cwd, '变异测试')
    const fake = host(cwd, {
        thresholds: { total: 80 },
        mutation: { enabled: true, threshold: undefined, testCommand: 'node --test test/suite.ts', thresholds: { mutationScore: 50, maxSurvived: 5 } },
    })
    // The stub decides from the MUTATED file, so it proves the write happened.
    provideSubprocess(
        fake,
        scriptedSubprocess((spec) => {
            const text = fs.readFileSync(path.join(spec.cwd, 'src/lib.ts'), 'utf8')
            return { exitCode: text.includes('x < 10') ? 0 : 1, stdout: 'stub' }
        }),
    )
    const run = await fake.runTool('mutation_check', { missionId: id })
    assert.equal(run.isError, false, String(run.content))
    const text = runText(run)
    assert.match(text, /变异测试（mutation）：PASS/)
    assert.match(text, /score = killed ÷ \(killed \+ survived\)/)
    assert.match(text, /存活变异体 2 个/)
    assert.match(text, /覆盖范围：完整/)
    assert.equal(fs.readFileSync(source, 'utf8'), 'export const LIMIT = 10\nexport const below = (x: number) => x < 10\n')

    const store = new MissionStoreRegistry().for(cwd)
    const gate = store.lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.scope, { selected: ['src/lib.ts'], total: 1, full: true })
    assert.deepEqual(gate?.results.map((result) => result.id), ['mutation-score', 'mutation-survived'])
    const artifact = JSON.parse(store.readArtifact(id, path.join('mutation', 'mutants.json')) as string) as {
        score: number
        counts: Record<string, number>
        survivors: { file: string; line: number; operator: string; snippetBefore: string; snippetAfter: string }[]
        mutants: { id: string; verdict: string }[]
        formula: string
    }
    assert.equal(artifact.score, 60)
    assert.deepEqual(artifact.counts, { executed: 5, killed: 3, survived: 2, runError: 0 })
    assert.equal(artifact.survivors.length, 2)
    assert.equal(artifact.survivors[0]?.file, 'src/lib.ts')
    assert.equal(typeof artifact.survivors[0]?.snippetBefore, 'string')
    assert.equal(typeof artifact.survivors[0]?.snippetAfter, 'string')
    assert.equal(artifact.mutants.length, 5)
    assert.match(artifact.formula, /3 ÷ \(3 \+ 2\)/)
})

test('mutation_check: a missed score is BLOCK, a survivor cap is BLOCK, run-errors are WARN', async () => {
    const prepare = (thresholds: Record<string, unknown>): { cwd: string; fake: FakeHost } => {
        const cwd = gitWorkspace('mut-verdict-')
        write(cwd, 'src/lib.ts', 'export const below = (x: number) => x < 10\n')
        const fake = host(cwd, { mutation: { enabled: true, testCommand: 'node --test test/suite.ts', thresholds } })
        // One surviving mutant (the suite only ever fails on `<=`), plus the
        // numeric mutants which the stub also lets through.
        provideSubprocess(
            fake,
            scriptedSubprocess((spec) => {
                const text = fs.readFileSync(path.join(spec.cwd, 'src/lib.ts'), 'utf8')
                return { exitCode: text.includes('<= 10') ? 1 : 0 }
            }),
        )
        return { cwd, fake }
    }
    const blocked = prepare({ mutationScore: 90 })
    const blockedRun = await blocked.fake.runTool('mutation_check', {})
    assert.match(runText(blockedRun), /变异测试（mutation）：BLOCK/)
    assert.match(runText(blockedRun), /阈值 90% → 不达标/)

    const capped = prepare({ mutationScore: 10, maxSurvived: 0 })
    assert.match(runText(await capped.fake.runTool('mutation_check', {})), /存活变异体上限.*不达标/s)

    // A mutant whose command cannot run is run-error: the score ignores it and
    // the verdict says the run is incomplete rather than inventing a kill.
    const cwd = gitWorkspace('mut-runerror-')
    write(cwd, 'src/lib.ts', 'export const below = (x: number) => x < 10\n')
    const fake = host(cwd, {
        mutation: { enabled: true, testCommand: 'node --test test/suite.ts', thresholds: { mutationScore: 0 } },
    })
    provideSubprocess(
        fake,
        scriptedSubprocess((spec) => {
            const text = fs.readFileSync(path.join(spec.cwd, 'src/lib.ts'), 'utf8')
            if (text.includes('<= 10')) throw new Error('spawn ENOENT (simulated)')
            return { exitCode: 0 }
        }),
    )
    const warned = runText(await fake.runTool('mutation_check', {}))
    assert.match(warned, /变异测试（mutation）：WARN/)
    assert.match(warned, /run-error 1 个/)
    assert.match(warned, /未能运行（run-error 1 个，\*\*不计入得分\*\*/)
    assert.match(warned, /scope\.full=false 的原因：.*run-error/)
})

test('mutation_check: changed mode uses changedRanges and changedMutationScore', async () => {
    const cwd = gitWorkspace('mut-changed-tool-')
    write(cwd, 'src/a.ts', 'export const a = (x: number) => x < 1\n')
    write(cwd, 'src/b.ts', 'export const b = (x: number) => x < 2\n')
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'ignore' })
    write(cwd, 'src/a.ts', 'export const a = (x: number) => x < 1\n// touched\n')
    const { id } = bindMission(cwd, '增量变异')
    const fake = host(cwd, {
        mutation: {
            enabled: true,
            testCommand: 'node --test test/suite.ts',
            sourceGlobs: ['**/*.ts'],
            thresholds: { mutationScore: 100, changedMutationScore: 0, maxSurvived: 5 },
        },
    })
    provideSubprocess(fake, scriptedSubprocess(() => ({ exitCode: 0 })))
    const text = runText(await fake.runTool('mutation_check', { changed: true, missionId: id }))
    assert.match(text, /范围：只变异本次改动（baseRef=HEAD）/)
    assert.match(text, /变异测试（mutation）：PASS/, 'the changed threshold (0%) is the one enforced, not mutationScore (100%)')
    assert.match(text, /mutationScore ≥ 100%，changedMutationScore ≥ 0%，maxSurvived ≤ 5/)
    const gate = new MissionStoreRegistry().for(cwd).lastGate(id, { source: 'dsh-coverage-gate' })
    assert.deepEqual(gate?.scope?.selected, ['src/a.ts'])
    assert.equal(gate?.results[0]?.command.includes('changedMutationScore'), true)
})

test('mutation_check: a narrower call (operators / maxMutants) is recorded as non-authorising', async () => {
    const cwd = gitWorkspace('mut-narrow-')
    write(cwd, 'src/lib.ts', 'export const below = (x: number) => x < 10 && x > 0\n')
    const { id } = bindMission(cwd, '窄化调用')
    const fake = host(cwd, { mutation: { enabled: true, testCommand: 'node --test test/suite.ts', thresholds: { mutationScore: 0 } } })
    provideSubprocess(fake, scriptedSubprocess(() => ({ exitCode: 0 })))
    const text = runText(await fake.runTool('mutation_check', { operators: ['relational'], maxMutants: 1, missionId: id }))
    assert.match(text, /部分/)
    assert.match(text, /抽样/)
    assert.match(text, /得分只覆盖实际跑过的变异体，不外推/)
    assert.match(text, /scope\.full=false 的原因：.*操作符由调用参数提供/)
    assert.match(text, /maxMutants 比宿主配置更窄/)
    const gate = new MissionStoreRegistry().for(cwd).lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(gate?.scope?.full, false)
})

test('mutation_check: no mutants at all is a refusal that names the operators', async () => {
    const cwd = tempWorkspace('mut-nomutants-')
    write(cwd, 'src/a.ts', '// nothing to mutate here\n')
    const fake = host(cwd, {
        mutation: { enabled: true, testCommand: 'node -e 0', sourceGlobs: ['**/*.ts'], thresholds: { mutationScore: 50 } },
    })
    const refused = await fake.runTool('mutation_check', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /没有任何可应用的变异/)
    assert.match(String(refused.content), /mutation\.operators/)
})

test('mutation_check: the project overlay may turn mutation on, and never off', () => {
    const cwd = tempWorkspace('mut-overlay-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const layout = {
        cwd,
        rootDir: path.join(cwd, '.dsh'),
        specsDir: '',
        missionsDir: '',
        auditDir: '',
        stateDir: '',
        rolesDir: '',
    }
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'coverage-gate.json'),
        JSON.stringify({ mutation: { enabled: true, maxMutants: 3, thresholds: { mutationScore: 70 }, testCommand: 'pnpm test' } }),
    )
    const hostConfig = resolveConfig({ thresholds: { total: 80 } })
    const raised = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(raised.config.mutation.enabled, true)
    assert.equal(raised.config.mutation.maxMutants, 3)
    assert.equal(raised.config.mutation.thresholds.mutationScore, 70)
    assert.equal(raised.config.mutation.testCommand, 'pnpm test')
    assert.equal(raised.source, 'project')

    // The host enabled it; the repository may not exempt itself.
    const hostOn = resolveConfig({ mutation: { enabled: true, thresholds: { mutationScore: 60 } } })
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ mutation: { enabled: false } }))
    const kept = resolveEffectiveConfig(hostOn, layout)
    assert.equal(kept.config.mutation.enabled, true, 'a repository cannot switch the gate off')
    assert.match(kept.problems.join('\n'), /mutation\.enabled 不能在项目级配置里关闭/)
    assert.equal(kept.config.mutation.thresholds.mutationScore, 60)

    // A bad value is dropped with a message, never silently defaulted.
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'coverage-gate.json'),
        JSON.stringify({ mutation: { maxMutants: 0, operators: ['REL_LT_TO_LE', 'nope'], thresholds: { mutationScore: 500 } } }),
    )
    const refused = resolveEffectiveConfig(hostOn, layout)
    assert.match(refused.problems.join('\n'), /mutation\.maxMutants 必须是正整数/)
    assert.match(refused.problems.join('\n'), /含未知操作符 "nope"/)
    assert.match(refused.problems.join('\n'), /已忽略整个 operators 配置/)
    assert.equal(refused.config.mutation.operators.length, 0)
    assert.equal(refused.config.mutation.thresholds.mutationScore, 60, 'the profile threshold stays in force')
})

// --- end to end -------------------------------------------------------------

test('mutation_check: a real suite kills one mutant and survives another (real git repo, real command)', async () => {
    const cwd = gitWorkspace('mut-e2e-')
    const source = write(cwd, 'src/lib.mjs', 'export const LIMIT = 10\n\nexport function below(x) {\n    return x < 10\n}\n')
    // The "suite": one assertion, about one token. Everything else in the file
    // is executed by the import and asserted by nothing — exactly the blind spot
    // mutation testing exists to expose.
    write(cwd, 'test/suite.mjs', ['import fs from "node:fs"', 'const text = fs.readFileSync("src/lib.mjs", "utf8")', 'process.exit(text.includes("x < 10") ? 0 : 1)', ''].join('\n'))
    write(cwd, 'package.json', '{ "type": "module" }\n')
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'ignore' })
    const { id } = bindMission(cwd, '端到端变异')
    const fake = host(cwd, {
        mutation: { enabled: true, testCommand: 'node test/suite.mjs', thresholds: { mutationScore: 50, maxSurvived: 5 } },
    })
    const run = await fake.runTool('mutation_check', { missionId: id })
    assert.equal(run.isError, false, String(run.content))
    const text = runText(run)
    assert.match(text, /变异测试（mutation）：PASS/)
    assert.match(text, /killed 3、survived 2、run-error 0/)
    assert.match(text, /score = killed ÷ \(killed \+ survived\) = 3 ÷ \(3 \+ 2\) = 60%/)
    assert.match(text, /存活变异体 2 个/)
    assert.equal(fs.readFileSync(source, 'utf8'), 'export const LIMIT = 10\n\nexport function below(x) {\n    return x < 10\n}\n')
    // Only the engineering trail and this test's own log file are new: the
    // mutated source is byte-identical, so nothing under src/ or test/ shows up.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
        .trim()
        .split('\n')
        .sort()
    assert.deepEqual(status, ['?? .dsh/', '?? coverage-gate.log'])

    // The real end-to-end numbers are also what the artifact says.
    const store = new MissionStoreRegistry().for(cwd)
    const artifact = JSON.parse(store.readArtifact(id, path.join('mutation', 'mutants.json')) as string) as {
        counts: Record<string, number>
        survivors: { operator: string; line: number }[]
        state: string
    }
    assert.deepEqual(artifact.counts, { executed: 5, killed: 3, survived: 2, runError: 0 })
    assert.deepEqual(artifact.survivors.map((survivor) => survivor.operator), ['INT_DEC', 'INT_INC'])
    assert.deepEqual(artifact.survivors.map((survivor) => survivor.line), [1, 1], 'the untouched constant on line 1 is the surviving mutant')
    assert.equal(artifact.state, 'PASS')
})

test('mutation_check: a hung suite stops the plan inside the time budget and reports a partial score', async () => {
    const cwd = gitWorkspace('mut-budget-tool-')
    write(cwd, 'src/lib.mjs', 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\nexport const e = 5\n')
    // A suite that waits: the point is that the BUDGET, not the mutant count,
    // ends the run — and that the report says so instead of extrapolating.
    write(cwd, 'test/slow.mjs', 'await new Promise((resolve) => setTimeout(resolve, 500))\n')
    const fake = host(cwd, {
        mutation: { enabled: true, testCommand: 'node test/slow.mjs', timeBudgetMs: 1_500, thresholds: { mutationScore: 0 } },
    })
    const text = runText(await fake.runTool('mutation_check', {}))
    assert.match(text, /预算用尽、提前结束/)
    assert.match(text, /时间预算用尽/)
    assert.match(text, /覆盖范围：部分/)
    const executed = Number.parseInt(/跑过 (\d+) 个/.exec(text)?.[1] ?? '0', 10)
    assert.ok(executed > 0 && executed < 10, `the run is partial, not extrapolated (executed=${executed})`)
    assert.equal(MUTATION_OPERATORS.length, 16, 'the operator table is the documented set')
})

// --- adversarial-audit regressions (data loss, path escape, wrong verdict) ---

test('mutation: a symlink is never a mutation target, so nothing outside the workspace is written', async () => {
    const root = tempWorkspace('mut-symlink-')
    const cwd = path.join(root, 'repo')
    const outside = path.join(root, 'other-repo')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    write(cwd, 'src/ok.ts', SMALL)
    const victim = write(outside, 'lib.ts', 'export const limit = 10 > 3\nexport const flag = true\n')
    fs.symlinkSync(victim, path.join(cwd, 'src', 'linked.ts'))
    fs.symlinkSync(outside, path.join(cwd, 'src', 'elsewhere'))

    const collected = await collectSourceFiles({ cwd, sourceGlobs: ['**/*.ts'] })
    assert.deepEqual(collected.files.map((file) => file.path), ['src/ok.ts'], 'a symlink to a file is not a source file this gate may rewrite')
    const linked = collected.skipped.find((entry) => entry.path === 'src/linked.ts')
    assert.match(linked?.reason ?? '', /是符号链接/)
    assert.equal(linked?.unusable, true, 'a file that could have been mutated but was skipped is not coverage')

    // A hand-made plan that bypasses the selection is refused too — before any write.
    const plan = planMutants({ files: [{ path: 'src/linked.ts', text: 'export const limit = 10 > 3\n' }] })
    await assert.rejects(
        runMutationPlan(plan, { cwd, argv: ['node', '-e', '0'], timeoutMs: 1_000, timeBudgetMs: 60_000, run: async () => ({ exitCode: 0 }) }),
        (error: unknown) => {
            assert.match(String((error as Error).message), /不能作为变异目标：是符号链接/)
            assert.match(String((error as Error).message), /本次没有改写任何文件/)
            return true
        },
    )
    assert.equal(fs.readFileSync(victim, 'utf8'), 'export const limit = 10 > 3\nexport const flag = true\n', 'the file outside the workspace is untouched')
})

test('mutation: a file this run did not write keeps an external change instead of being restored over it', async () => {
    const cwd = tempWorkspace('mut-interfere-')
    const other = write(cwd, 'src/b.ts', SMALL)
    write(cwd, 'src/a.ts', SMALL)
    const files = ['src/a.ts', 'src/b.ts'].map((file) => ({ path: file, text: SMALL }))
    const plan = planMutants({ files })
    assert.equal(plan.mutants[0]?.file, 'src/a.ts', 'the plan runs file by file, a.ts first')
    const external = 'const someoneElse = 9\n'
    await assert.rejects(
        runMutationPlan(plan, {
            cwd,
            argv: ['node', '-e', '0'],
            timeoutMs: 1_000,
            timeBudgetMs: 60_000,
            run: async () => {
                // An external writer touches a file THIS RUN HAS NOT MUTATED YET.
                fs.writeFileSync(other, external)
                return { exitCode: 0, durationMs: 1 }
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof MutationRestoreError)
            assert.match(error.message, /src\/b\.ts 在本次运行期间被外部改动/)
            assert.match(error.message, /本工具没有写它/)
            return true
        },
    )
    assert.equal(fs.readFileSync(other, 'utf8'), external, 'the external content is the current work: it is never replaced by our snapshot')
})

test('mutation: an external change to an unmutated file fails the end-of-run check closed', async () => {
    const cwd = tempWorkspace('mut-interfere2-')
    const other = write(cwd, 'src/b.ts', SMALL)
    write(cwd, 'src/a.ts', SMALL)
    const files = ['src/a.ts', 'src/b.ts'].map((file) => ({ path: file, text: SMALL }))
    // The budget ends the run after a.ts, so the loop never reaches b.ts: only
    // the end-of-run comparison can notice — and it must refuse to give a verdict
    // instead of reporting on a workspace that was not restored.
    const plan = planMutants({ files })
    let clock = 0
    await assert.rejects(
        runMutationPlan(plan, {
            cwd,
            argv: ['node', '-e', '0'],
            timeoutMs: 1_000,
            timeBudgetMs: 60_000,
            now: () => clock,
            run: async () => {
                clock += 60_000
                fs.writeFileSync(other, 'const someoneElse = 9\n')
                return { exitCode: 0, durationMs: 1 }
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof MutationRestoreError)
            assert.match(error.message, /src\/b\.ts/)
            assert.match(error.message, /与运行前的字节快照不一致/)
            assert.match(error.message, /没有给出任何裁决|不给出任何裁决/)
            return true
        },
    )
    assert.equal(fs.readFileSync(other, 'utf8'), 'const someoneElse = 9\n')
})

test('mutation_check: a source file that could not be mutated makes the verdict partial and is named', async () => {
    const cwd = gitWorkspace('mut-skip-tool-')
    write(cwd, 'src/ok.ts', 'export const below = (x: number) => x < 10\n')
    // Not valid UTF-8: text mutation could not guarantee a byte-exact restore,
    // so the file is skipped — and "every file was mutated" would be a lie.
    fs.writeFileSync(path.join(cwd, 'src', 'bad.ts'), Buffer.from([0x65, 0x78, 0x70, 0xff, 0xfe, 0x0a]))
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd, stdio: 'ignore' })
    const { id } = bindMission(cwd, '跳过文件')
    const fake = host(cwd, {
        mutation: { enabled: true, testCommand: 'node --test test/suite.ts', thresholds: { mutationScore: 0 } },
    })
    provideSubprocess(fake, scriptedSubprocess(() => ({ exitCode: 0 })))
    const text = runText(await fake.runTool('mutation_check', { missionId: id }))
    assert.match(text, /变异测试（mutation）：PASS/)
    assert.match(text, /覆盖范围：部分/)
    assert.match(text, /scope\.full=false 的原因：.*1 个本该参与变异的源码文件没有被变异/)
    assert.match(text, /没有被变异的源码文件（1 个/)
    assert.match(text, /src\/bad\.ts：不是合法 UTF-8/)
    const gate = new MissionStoreRegistry().for(cwd).lastGate(id, { source: 'dsh-coverage-gate' })
    assert.equal(gate?.scope?.full, false, 'a skipped source file is not covered')
    assert.deepEqual(gate?.scope?.selected, ['src/ok.ts'])
})

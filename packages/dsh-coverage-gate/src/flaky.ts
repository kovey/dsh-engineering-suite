/**
 * Flakiness: what changed between two runs of the same command.
 *
 * A test suite that fails one time in three is not "green with retries" — it is a
 * defect in the suite, and the only deterministic way to see it is to run the
 * same command several times and compare. Two comparison levels exist, and this
 * module is explicit about which one it managed:
 *
 *  1. **per test** — when the runner names its cases (`--- FAIL: TestX`,
 *     `✖ name`, `FAILED tests/x.py::test_y`, `× name`, TAP `not ok`), a name that
 *     both passed and failed is flaky, and a name that failed every time is a
 *     STABLE failure (a bug, not flakiness — do not re-run it into a pass);
 *  2. **per run** — when the runner only produces an exit code, a mixture of
 *     passes and failures is still flakiness, but only at the run level: the
 *     verdict says "the runner does not name tests" instead of inventing one.
 *
 * Runs that produced no per-test output at all are "opaque": a test that failed
 * in one run and is absent from an opaque run has NOT been shown to pass, so it
 * lands in `inconclusive` rather than in `flaky`.
 *
 * Pure functions: no clocks, no I/O, sorted output.
 *
 * @module dsh-coverage-gate/flaky
 */

import type { RunOutcome } from 'dsh-eng-core'

/** One execution of the repeated command. */
export interface RunResult {
    /** 1-based run index. */
    index: number
    exitCode: number | null
    signal?: string | null
    timedOut?: boolean
    stdout: string
    stderr: string
}

/** How often one test name passed/failed across the runs that named it. */
export interface TestTally {
    name: string
    passed: number
    failed: number
    /** Runs that produced no per-test output at all (neither pass nor fail seen). */
    opaque: number
}

/** The outcome of {@link classifyRuns}. */
export interface FlakyClassification {
    /** How many runs were compared. */
    runs: number
    /** Runs whose output named no test at all (only an exit code was available). */
    opaqueRuns: number[]
    /** Names that both passed and failed (flakiness). */
    flaky: TestTally[]
    /** Names with a consistent outcome. */
    stable: (TestTally & { outcome: 'passing' | 'failing' })[]
    /** Names whose outcome cannot be decided (failed, but some run was opaque). */
    inconclusive: TestTally[]
    /** How many distinct names were parsed across all runs. */
    named: number
    /** Honest caveats. */
    notes: string[]
}

/** The outcome of {@link compareRuns} (exit-code level). */
export interface RunLevelComparison {
    runs: { index: number; exitCode: number | null; timedOut: boolean; outcome: 'pass' | 'fail' }[]
    passed: number
    failed: number
    /** At least one pass AND at least one fail. */
    flaky: boolean
    /** Runs that hit their deadline (a slow run is not proof of flakiness). */
    timeouts: number[]
    reason: string
}

/** The combined verdict {@link detectFlakiness} returns. */
export interface FlakinessVerdict {
    flaky: boolean
    /** `test` = named cases disagreed; `run` = only exit codes disagreed; `none`. */
    level: 'test' | 'run' | 'none'
    /** Fewer than two runs: nothing can be concluded yet. */
    inconclusive: boolean
    reason: string
    classification: FlakyClassification
    comparison: RunLevelComparison
}

/** Strip ANSI colour codes so a reporter's styling cannot hide a name. */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/** Names that are really files (a reporter's file summary, not a test case). */
function looksLikeFile(name: string): boolean {
    return /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$|\.java$|\.rb$|\.cs$|\.php$/.test(name)
}

/**
 * Normalise a captured name: drop a trailing reporter timing (`52ms`) and a
 * trailing parenthesised summary (`(1 test | 1 failed)`).
 *
 * Both vary between runs, and a name that varies between runs would look like
 * two different tests — the opposite of what a flakiness comparison needs.
 */
function normalizeName(name: string): string {
    return name
        .replace(/\s+\d+(?:\.\d+)?\s*m?s$/, '')
        .replace(/\s*\([^()]*\)\s*$/, '')
        .trim()
}

/** Failure markers, in the shapes the common runners print. */
const FAILURE_PATTERNS: readonly RegExp[] = [
    // go test -v
    /^\s*---\s+FAIL:\s*(\S+)/,
    // pytest short summary
    /^\s*FAILED\s+(\S+)/,
    // TAP
    /^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/,
    // vitest / jest per-case list
    /^\s*(?:✖|✗|×|✕|❌|●)\s*(.+?)\s*$/,
    // pytest -v (`tests/x.py::test_y FAILED [ 50%]`)
    /^\s*(\S+::\S+)\s+FAILED\b/,
]

/** Success markers, mirroring {@link FAILURE_PATTERNS}. */
const PASS_PATTERNS: readonly RegExp[] = [
    /^\s*---\s+PASS:\s*(\S+)/,
    /^\s*PASSED\s+(\S+)/,
    /^\s*ok\s+\d+\s*-\s*(.+?)\s*$/,
    /^\s*(?:✔|✓|√|✅)\s*(.+?)\s*$/,
    /^\s*(\S+::\S+)\s+PASSED\b/,
]

/** Apply a pattern list to one run's output. */
function collect(text: string, patterns: readonly RegExp[]): string[] {
    const found: string[] = []
    for (const rawLine of stripAnsi(text).split('\n')) {
        for (const pattern of patterns) {
            const match = pattern.exec(rawLine)
            if (match === null) continue
            const name = normalizeName((match[1] as string).trim())
            if (name === '' || looksLikeFile(name)) break
            if (!found.includes(name)) found.push(name)
            break
        }
    }
    return found
}

/**
 * Parse the test names one run's output reports, by outcome.
 *
 * The four shapes the suite's runners use are the primary targets; a reporter's
 * file-level summary line (`✖ a.test.ts`) is deliberately NOT taken as a test
 * name, because naming a file would make every other case in it look flaky.
 * @param text - one run's stdout+stderr.
 */
export function parseTestNames(text: string): { failed: string[]; passed: string[] } {
    return { failed: collect(text, FAILURE_PATTERNS).sort(), passed: collect(text, PASS_PATTERNS).sort() }
}

/**
 * Compare the runs at per-test granularity.
 * @param runs - every execution of the repeated command.
 */
export function classifyRuns(runs: readonly RunResult[]): FlakyClassification {
    const perRun = runs.map((run) => parseTestNames(`${run.stdout}\n${run.stderr}`))
    const opaqueRuns = runs.filter((_, position) => {
        const parsed = perRun[position]
        return parsed !== undefined && parsed.failed.length === 0 && parsed.passed.length === 0
    }).map((run) => run.index)
    const names = new Set<string>()
    for (const parsed of perRun) {
        for (const name of parsed.failed) names.add(name)
        for (const name of parsed.passed) names.add(name)
    }
    const flaky: TestTally[] = []
    const stable: FlakyClassification['stable'] = []
    const inconclusive: TestTally[] = []
    for (const name of [...names].sort()) {
        let passed = 0
        let failed = 0
        for (const parsed of perRun) {
            if (parsed.failed.includes(name)) failed += 1
            if (parsed.passed.includes(name)) passed += 1
        }
        const tally: TestTally = { name, passed, failed, opaque: opaqueRuns.length }
        if (passed > 0 && failed > 0) flaky.push(tally)
        else if (passed > 0) stable.push({ ...tally, outcome: 'passing' })
        else if (failed > 0 && opaqueRuns.length === 0) stable.push({ ...tally, outcome: 'failing' })
        else inconclusive.push(tally)
    }
    stable.sort(
        (left, right) => left.outcome.localeCompare(right.outcome) || left.name.localeCompare(right.name),
    )
    const notes: string[] = []
    if (opaqueRuns.length > 0) {
        notes.push(
            `第 ${opaqueRuns.join(', ')} 次运行的输出没有给出任何用例名（只有退出码）：这些运行里的用例结果未知`,
        )
    }
    if (inconclusive.length > 0) {
        notes.push(`${inconclusive.length} 个用例只在部分运行里出现，无法判定是否不稳定（缺少对照运行）`)
    }
    return {
        runs: runs.length,
        opaqueRuns,
        flaky,
        stable,
        inconclusive,
        named: names.size,
        notes,
    }
}

/**
 * Compare the runs at exit-code granularity (the only level an anonymous runner
 * supports).
 * @param runs - every execution of the repeated command.
 */
export function compareRuns(runs: readonly RunResult[]): RunLevelComparison {
    const summary = runs
        .map((run) => ({
            index: run.index,
            exitCode: run.exitCode,
            timedOut: run.timedOut === true,
            outcome: run.exitCode === 0 && run.timedOut !== true ? ('pass' as const) : ('fail' as const),
        }))
        .sort((left, right) => left.index - right.index)
    const passed = summary.filter((entry) => entry.outcome === 'pass').length
    const failed = summary.length - passed
    const timeouts = summary.filter((entry) => entry.timedOut).map((entry) => entry.index)
    const flaky = passed > 0 && failed > 0
    const total = summary.length
    const reason =
        total < 2
            ? `只运行了 ${total} 次：运行级判定至少要 2 次（单次结果无论通过还是失败都说明不了稳定性）`
            : passed === total
              ? `全部 ${total} 次运行都通过：没有观察到不稳定`
              : failed === total
                ? `全部 ${total} 次运行都失败：这是稳定失败（不是 flaky），说明代码或测试本身有问题`
                : `${total} 次运行中 ${passed} 次通过、${failed} 次失败：存在运行级不稳定，但运行器的输出没有给出用例名，无法定位到具体用例。下一步：让运行器输出用例名（jest/vitest 加 --verbose、go test 加 -v、pytest 加 -v），或直接修共享状态/时间依赖/随机源`
    const notes: string[] =
        timeouts.length === 0
            ? []
            : [`第 ${timeouts.join(', ')} 次运行超时：超时可能是慢或环境问题，按"未通过"计入，但不要把超时当成 flaky 的证据`]
    return { runs: summary, passed, failed, flaky, timeouts, reason: [reason, ...notes].join('；') }
}

/**
 * Decide whether the runs are flaky, and say at which level the answer holds.
 * @param runs - every execution of the repeated command.
 */
export function detectFlakiness(runs: readonly RunResult[]): FlakinessVerdict {
    const classification = classifyRuns(runs)
    const comparison = compareRuns(runs)
    if (runs.length < 2) {
        return {
            flaky: false,
            level: 'none',
            inconclusive: true,
            reason: `只运行了 ${runs.length} 次：无法判定 flaky（至少需要 2 次运行；配置 flakyRepeats 或调用时传 repeats）`,
            classification,
            comparison,
        }
    }
    if (classification.flaky.length > 0) {
        const worst = classification.flaky
            .map((tally) => `${tally.name}（通过 ${tally.passed} / 失败 ${tally.failed}）`)
            .join('，')
        return {
            flaky: true,
            level: 'test',
            inconclusive: false,
            reason: `${classification.flaky.length} 个用例在重复运行中结果不一致：${worst}`,
            classification,
            comparison,
        }
    }
    if (comparison.flaky) {
        return {
            flaky: true,
            level: 'run',
            inconclusive: false,
            reason: comparison.reason,
            classification,
            comparison,
        }
    }
    return {
        flaky: false,
        level: 'none',
        inconclusive: false,
        reason:
            classification.named > 0
                ? `${classification.runs} 次运行里 ${classification.named} 个用例结果一致（没有观察到不稳定）`
                : comparison.reason,
        classification,
        comparison,
    }
}

/** Convert a `dsh-eng-core` outcome into a {@link RunResult}. */
export function toRunResult(outcome: RunOutcome, index: number): RunResult {
    return {
        index,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        stdout: outcome.stdout,
        stderr: `${outcome.stderr}${outcome.spawnError === undefined ? '' : `\n[spawn error] ${outcome.spawnError}`}`,
    }
}

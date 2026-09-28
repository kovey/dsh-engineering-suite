/**
 * Flaky plans: turn "this test is unstable" into "here is what to do about it".
 *
 * A flakiness report is a number, not a decision. `dsh-coverage-gate`'s
 * `flaky_check` tells you that `TestX` disagreed with itself; it does not tell
 * you which of the three honest answers applies (fix it, isolate it, or the
 * *harness* is what is broken), and it has no opinion about the one failure mode
 * that quietly destroys a suite: a test quarantined and then never looked at
 * again, still counted as covered.
 *
 * This module owns that decision, deterministically:
 *
 *  - **classification** — every named test lands in exactly one bucket:
 *    `stable` (never failed), `quarantine` (failed sometimes, never
 *    consistently), `investigate` (the failures follow a pattern: only the first
 *    run, or every run — a setup/ordering smell or a plain bug), or
 *    `suspect-instrumentation` (the failure output matches a declared signature
 *    such as a timeout, a taken port or a clock read — the test may be fine and
 *    the environment broken);
 *  - **quarantine is a loan** — it needs an `owner` and an `expiresAt`
 *    (`quarantineMaxDays`, default 14). A plan refuses to quarantine without an
 *    owner, and an EXPIRED quarantine is an escalation: fix it or delete it, it
 *    may not hang there;
 *  - **the artifact is the receipt** — the plan is written to
 *    `flaky/<stamp>-plan.json` on the mission and rendered for a human. This
 *    plugin never runs the command that writes a quarantine row: a machine must
 *    not quietly silence a test on its own.
 *
 * It reads either a report another plugin produced (a file, so the two packages
 * stay independent) or its own repeated run of a configured command.
 *
 * @module dsh-impact-gate/flaky
 */

import path from 'node:path'
import { exists, listDir, readJson, readText, runCommand, splitCommand, tail, type RunOutcome } from 'dsh-eng-core'

/** One declared failure signature: "this smell is the environment, not the test". */
export interface FlakySignature {
    pattern: string
    label: string
    advice: string
    source: 'builtin' | 'config'
}

/**
 * The signatures that ship with the plugin.
 *
 * They exist because the alternative is a model guessing why a test failed:
 * a timeout, a taken port and a clock read are the three failure modes that
 * most often get a healthy test quarantined for the wrong reason.
 */
export const BUILTIN_SIGNATURES: readonly FlakySignature[] = [
    {
        pattern: 'timed?\\s*out|timeout|deadline exceeded|ETIMEDOUT',
        label: '超时',
        advice: '先确认它是不是只是慢：慢不是 flaky。要么放宽这条用例的超时并查清它为什么慢，要么把它拆小；把慢用例隔离掉等于把性能回归藏起来。',
        source: 'builtin',
    },
    {
        pattern: 'EADDRINUSE|address already in use|port .{0,20}(already )?in use',
        label: '端口被占用',
        advice: '固定端口会随并行与残留进程漂移：让测试自己挑空闲端口（或串行启动），不要在用例里写死端口。',
        source: 'builtin',
    },
    {
        pattern: 'clock|timezone|time zone|system time|NTP|date skew',
        label: '时钟 / 时区',
        advice: '读系统时间的用例在边界时刻必然不稳定：把时钟注入进来（fake clock），不要读 Date.now()/time.Now()。',
        source: 'builtin',
    },
    {
        pattern: 'ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network is unreachable|connection reset by peer|503 Service Unavailable',
        label: '网络 / 外部依赖',
        advice: '外部依赖不稳定不是被测代码的缺陷：把它打桩，或把这条用例移到明确的集成层（并在那里重试）。',
        source: 'builtin',
    },
    {
        pattern: 'ENOSPC|out of memory|OOM|too many open files|disk full',
        label: '资源耗尽',
        advice: '这是跑的机器/容器的问题：先修资源（磁盘、内存、句柄），再看这条用例本身是否泄漏资源。',
        source: 'builtin',
    },
]

/** The resolved flaky policy of one workspace. */
export interface FlakySettings {
    signatures: readonly FlakySignature[]
    /** Longest a quarantine may live, in days. */
    quarantineMaxDays: number
    /** Quarantine ledger file (default `<rootDir>/flaky-quarantine.json`). */
    quarantineFile?: string
    /** Warn when a quarantined test was not seen in this many consecutive runs. */
    unseenRunsBeforeWarn: number
    /** Who is responsible for the quarantines of this repository. */
    owner?: string
}

/** Default quarantine lifetime. */
export const DEFAULT_QUARANTINE_MAX_DAYS = 14
/** Default "not seen for N runs" threshold. */
export const DEFAULT_UNSEEN_RUNS = 3
/** Hard cap on repeated runs: flakiness detection must not become a load test. */
export const MAX_FLAKY_RUNS = 10
/** Minimum runs before anything can be classified (one run proves nothing). */
export const MIN_FLAKY_RUNS = 2
/** Deadline of one repeated run. */
export const FLAKY_RUN_TIMEOUT_MS = 10 * 60_000

/** How one test behaved across the observed runs. */
export interface TestTally {
    name: string
    /** Runs that named this test at all. */
    runs: number
    /** Runs that named it as failed. */
    failures: number
    /** 1-based index of the first run that failed it. */
    firstFailingRun?: number
    /** Every failing run index, ascending. */
    failingRuns?: number[]
    /** Bounded failure output, when the source carried any. */
    failureOutput?: string
    /** Some runs were opaque: the outcome cannot be decided from this data. */
    inconclusive?: boolean
}

/** One observed execution. */
export interface ObservedRun {
    index: number
    exitCode: number | null
    outcome: 'pass' | 'fail'
    timedOut: boolean
    /** Test names this run named (empty when the runner named none). */
    named: { name: string; ok: boolean }[]
}

/** Where a plan's data came from. */
export interface FlakySource {
    mode: 'report' | 'runs'
    /** The report file, in report mode. */
    report?: string
    /** The repeated command, in run mode. */
    command?: string
    /** Planned number of runs, in run mode. */
    planned?: number
    /** How many runs the source actually carried. */
    observed: number
}

/** The classification of one test. */
export type FlakyClassification = 'stable' | 'quarantine' | 'investigate' | 'suspect-instrumentation'

/** One planned action for one test. */
export interface FlakyPlanEntry {
    name: string
    classification: FlakyClassification
    runs: number
    failures: number
    firstFailingRun?: number
    /** The evidence sentence a reviewer reads. */
    evidence: string
    /** What to do, in one sentence. */
    action: string
    /** Why a planned quarantine was refused (no owner, no mission, …). */
    refusal?: string
    /** The owner a quarantine would be recorded under. */
    owner?: string
    /** Epoch ms the quarantine would expire at. */
    expiresAt?: number
    /** The host-side command that writes the quarantine row (never run here). */
    quarantineCommand?: string
    /** The JSONL row that command appends. */
    quarantineRow?: QuarantineRow
}

/** One row of the append-only quarantine ledger. */
export interface QuarantineRow {
    /** Epoch ms the row was written. */
    at: number
    test: string
    owner: string
    /** Epoch ms the quarantine expires (accepted as an ISO string when read). */
    expiresAt: number
    reason: string
    evidencePath: string
}

/** An escalation: something a human has to decide about. */
export interface FlakyEscalation {
    test: string
    kind: 'expired' | 'no-owner' | 'not-seen' | 'invalid-row'
    message: string
}

/** The plan artifact: written under `flaky/<stamp>-plan.json`. */
export interface FlakyPlan {
    version: 1
    plugin: 'dsh-impact-gate'
    kind: 'flaky-plan'
    generatedAt: string
    cwd: string
    source: FlakySource
    runs: readonly ObservedRun[]
    tests: readonly FlakyPlanEntry[]
    summary: { stable: number; quarantine: number; investigate: number; suspectInstrumentation: number; refused: number }
    escalations: readonly FlakyEscalation[]
    quarantine: { file: string; owner: string | null; maxDays: number; unseenRunsBeforeWarn: number }
    notes: readonly string[]
}

/** How one unstable test should be treated. */
export interface Classification {
    classification: FlakyClassification
    evidence: string
    action: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

// --- signatures -----------------------------------------------------------

/** Compile the configured signatures (the built-ins are the default). */
export function compileSignatures(value: unknown): { signatures: FlakySignature[]; problems: string[] } {
    if (value === undefined) return { signatures: [...BUILTIN_SIGNATURES], problems: [] }
    if (!Array.isArray(value)) {
        return { signatures: [...BUILTIN_SIGNATURES], problems: ['flaky.signatures 必须是数组（每项 { pattern, label?, advice? } 或一个正则字符串），已忽略'] }
    }
    const signatures: FlakySignature[] = []
    const problems: string[] = []
    for (const [index, entry] of value.entries()) {
        const raw = typeof entry === 'string' ? { pattern: entry } : isRecord(entry) ? entry : undefined
        if (raw === undefined) {
            problems.push(`flaky.signatures[${index}] 必须是字符串或对象 { pattern, label?, advice? }`)
            continue
        }
        const pattern = typeof raw['pattern'] === 'string' ? raw['pattern'].trim() : ''
        if (pattern === '') {
            problems.push(`flaky.signatures[${index}].pattern 不能为空`)
            continue
        }
        try {
            new RegExp(pattern, 'i')
        } catch (error) {
            problems.push(`flaky.signatures[${index}].pattern 不是合法正则（${error instanceof Error ? error.message : String(error)}）：${pattern}`)
            continue
        }
        signatures.push({
            pattern,
            label: typeof raw['label'] === 'string' && raw['label'].trim() !== '' ? raw['label'].trim() : pattern,
            advice:
                typeof raw['advice'] === 'string' && raw['advice'].trim() !== ''
                    ? raw['advice'].trim()
                    : '这条失败签名说明问题可能在环境/工具链，而不是被测代码：先确认它，再决定修或隔离。',
            source: 'config',
        })
    }
    // An explicitly configured list REPLACES the built-ins: a repository's
    // failure vocabulary is repository knowledge, and `[]` (no signature
    // classification) must stay expressible.
    return { signatures, problems }
}

/** The first declared signature a piece of failure output matches. */
export function matchSignature(output: string, signatures: readonly FlakySignature[]): FlakySignature | undefined {
    return signatures.find((signature) => new RegExp(signature.pattern, 'i').test(output))
}

// --- reading the runs -----------------------------------------------------

/** Names a reporter prints for a passing case. */
const PASS_PATTERNS: readonly RegExp[] = [
    /^\s*---\s+PASS:\s*(\S+)/, // go test -v
    /^\s*ok\s+\d+\s+-\s+(.+?)\s*$/, // TAP
    /^\s*PASSED\s+(\S+)/, // pytest
    /^\s*[✓√]\s+(.+?)\s*$/, // vitest / jest verbose
]
/** Names a reporter prints for a failing case. */
const FAIL_PATTERNS: readonly RegExp[] = [
    /^\s*---\s+FAIL:\s*(\S+)/, // go test -v
    /^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/, // TAP
    /^\s*FAILED\s+(\S+)/, // pytest short summary
    /^\s*[✖×✗]\s+(.+?)\s*$/, // vitest / jest verbose
]

/** Strip a trailing timing / parenthesised summary so runs compare equal. */
function normalizeName(name: string): string {
    return name
        .replace(/\s+\d+(?:\.\d+)?\s*m?s$/, '')
        .replace(/\s*\([^()]*\)\s*$/, '')
        .trim()
}

/**
 * Read the test names one run's output declared.
 *
 * Deliberately a small, fixed set of the shapes the common runners print: this
 * plugin must stay independent of `dsh-coverage-gate` (they are separately
 * mountable), and a runner that names nothing is reported as "run level" rather
 * than guessed at.
 * @param output - the run's captured stdout+stderr.
 */
export function parseNamedTests(output: string): { name: string; ok: boolean }[] {
    const named: { name: string; ok: boolean }[] = []
    for (const line of output.split('\n')) {
        for (const pattern of PASS_PATTERNS) {
            const match = pattern.exec(line)
            if (match?.[1] !== undefined) {
                const name = normalizeName(match[1])
                if (name !== '') named.push({ name, ok: true })
            }
        }
        for (const pattern of FAIL_PATTERNS) {
            const match = pattern.exec(line)
            if (match?.[1] !== undefined) {
                const name = normalizeName(match[1])
                if (name !== '') named.push({ name, ok: false })
            }
        }
    }
    return named
}

/** Turn raw command outcomes into the runs a plan is built from. */
export function observeRuns(outcomes: readonly RunOutcome[]): { runs: ObservedRun[]; failureOutput: string; notes: string[] } {
    const runs: ObservedRun[] = []
    const notes: string[] = []
    const failing: string[] = []
    for (const [index, outcome] of outcomes.entries()) {
        const output = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n')
        const named = parseNamedTests(output)
        const failed = outcome.exitCode !== 0 || outcome.timedOut
        runs.push({
            index: index + 1,
            exitCode: outcome.exitCode,
            outcome: failed ? 'fail' : 'pass',
            timedOut: outcome.timedOut,
            named,
        })
        if (failed && output.trim() !== '') failing.push(`--- 第 ${index + 1} 次运行 ---\n${output}`)
        if (named.length === 0) notes.push(`第 ${index + 1} 次运行没有点名任何用例（只有退出码）：这一轮无法按用例判定`)
    }
    return { runs, failureOutput: tail(failing.join('\n'), 8_000), notes }
}

/** Count how often each test was seen and failed. */
export function tallyRuns(runs: readonly ObservedRun[], failureOutput?: string): TestTally[] {
    const tallies = new Map<string, TestTally>()
    for (const run of runs) {
        for (const entry of run.named) {
            const tally = tallies.get(entry.name) ?? { name: entry.name, runs: 0, failures: 0 }
            tally.runs += 1
            if (!entry.ok) {
                tally.failures += 1
                tally.firstFailingRun ??= run.index
                tally.failingRuns = [...(tally.failingRuns ?? []), run.index]
            }
            tallies.set(entry.name, tally)
        }
    }
    return [...tallies.values()]
        .map((tally) => (failureOutput === undefined || tally.failures === 0 ? tally : { ...tally, failureOutput }))
        .sort((left, right) => left.name.localeCompare(right.name))
}

// --- reading a report -----------------------------------------------------

/** What a parsed report produced. */
export interface ParsedReport {
    tallies: TestTally[]
    runs: ObservedRun[]
    notes: string[]
}

/**
 * Parse a flakiness report.
 *
 * Accepts the artifact `dsh-coverage-gate`'s `flaky_check` writes
 * (`{ flakyTests, stableTests, inconclusiveTests, runs }`, where each tally is
 * `{ name, passed, failed, opaque }`) plus a plain `{ tests: [{ name, runs,
 * failures }] }` / bare array shape. Anything else is refused: a report this
 * plugin cannot read must never look like "no unstable tests".
 * @param value - the parsed JSON document.
 */
export function parseReport(value: unknown): ParsedReport | { problem: string } {
    const notes: string[] = []
    const tallies: TestTally[] = []
    const runs: ObservedRun[] = []

    const fromTally = (entry: Record<string, unknown>, bucket: 'flaky' | 'stable' | 'inconclusive'): TestTally | undefined => {
        const name = typeof entry['name'] === 'string' ? entry['name'].trim() : ''
        if (name === '') return undefined
        const passed = typeof entry['passed'] === 'number' && entry['passed'] > 0 ? Math.floor(entry['passed']) : 0
        const failed = typeof entry['failed'] === 'number' && entry['failed'] > 0 ? Math.floor(entry['failed']) : 0
        const opaque = typeof entry['opaque'] === 'number' && entry['opaque'] > 0 ? Math.floor(entry['opaque']) : 0
        const explicitRuns = positiveInt(entry['runs'])
        const explicitFailures = typeof entry['failures'] === 'number' && entry['failures'] >= 0 ? Math.floor(entry['failures']) : undefined
        const output = typeof entry['failureOutput'] === 'string' ? entry['failureOutput'] : typeof entry['output'] === 'string' ? entry['output'] : undefined
        const explicitFirst = positiveInt(entry['firstFailingRun'])
        // `times` is the third shape a producer may use: a count, or one entry
        // per run (`[true, false, true]`), where false / 'fail' / 0 is a failure.
        const times = entry['times']
        const timesRuns = typeof times === 'number' && times > 0 ? Math.floor(times) : Array.isArray(times) ? times.length : undefined
        const isFailure = (item: unknown): boolean => item === false || item === 0 || item === 'fail' || item === 'failed' || item === 'FAIL'
        const timesFailures = Array.isArray(times) ? times.filter(isFailure).length : undefined
        const timesFirst = Array.isArray(times) ? times.findIndex(isFailure) : -1
        const firstFailing = explicitFirst ?? (timesFirst >= 0 ? timesFirst + 1 : undefined)
        return {
            name,
            runs: explicitRuns ?? timesRuns ?? passed + failed,
            failures: explicitFailures ?? timesFailures ?? failed,
            ...(firstFailing === undefined ? {} : { firstFailingRun: firstFailing }),
            ...(output === undefined ? {} : { failureOutput: output }),
            // A test that failed while some runs named nothing has NOT been shown
            // to be consistently unstable: say so instead of quarantining on a guess.
            ...(bucket === 'inconclusive' || opaque > 0 ? { inconclusive: true } : {}),
        }
    }

    const push = (entry: Record<string, unknown>, bucket: 'flaky' | 'stable' | 'inconclusive'): void => {
        const tally = fromTally(entry, bucket)
        if (tally !== undefined) tallies.push(tally)
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            if (!isRecord(entry)) return { problem: '报告数组里存在非对象项：无法解析成用例计数' }
            push(entry, 'flaky')
        }
    } else if (isRecord(value)) {
        const buckets: [string, 'flaky' | 'stable' | 'inconclusive'][] = [
            ['flakyTests', 'flaky'],
            ['stableTests', 'stable'],
            ['inconclusiveTests', 'inconclusive'],
            ['tests', 'flaky'],
        ]
        let found = 0
        for (const [key, bucket] of buckets) {
            const list = value[key]
            if (list === undefined) continue
            if (!Array.isArray(list)) return { problem: `报告的 "${key}" 必须是数组` }
            found += list.length
            for (const entry of list) {
                if (!isRecord(entry)) return { problem: `报告的 "${key}" 里存在非对象项：无法解析成用例计数` }
                push(entry, bucket)
            }
        }
        if (found === 0 && !Array.isArray(value['runs'])) {
            return {
                problem:
                    '报告里没有任何用例计数（期望 flakyTests / stableTests / inconclusiveTests / tests 之一，或一个用例数组）：' +
                    '读不懂的报告绝不能当成"没有不稳定用例"',
            }
        }
        if (Array.isArray(value['runs'])) {
            for (const [index, entry] of value['runs'].entries()) {
                if (!isRecord(entry)) continue
                const outcome = entry['outcome'] === 'pass' || entry['outcome'] === 'fail' ? (entry['outcome'] as 'pass' | 'fail') : entry['exitCode'] === 0 ? 'pass' : 'fail'
                runs.push({
                    index: positiveInt(entry['index']) ?? index + 1,
                    exitCode: typeof entry['exitCode'] === 'number' ? entry['exitCode'] : null,
                    outcome,
                    timedOut: entry['timedOut'] === true,
                    named: [],
                })
            }
            notes.push('报告只带运行级结果（每次运行的退出码），没有逐用例的点名结果：无法判定"某条被隔离的用例最近有没有出现"')
        }
        if (found === 0) notes.push('报告没有列出任何用例（只带运行级结果）')
    } else {
        return { problem: '报告顶层必须是对象或数组' }
    }

    if (tallies.length === 0 && runs.length === 0) return { problem: '报告里没有任何可用数据' }
    if (!tallies.some((tally) => tally.failureOutput !== undefined)) {
        notes.push('报告没有携带失败输出：无法判定 suspect-instrumentation（`flaky.signatures` 匹配的是失败输出）')
    }
    // A report's `runs` are the runs that OBSERVED these tallies, so a tally's
    // own run count is what the classification uses.
    return { tallies: tallies.sort((left, right) => left.name.localeCompare(right.name)), runs, notes }
}

/** Read and parse one report file (a refusal when it cannot be read). */
export function readReport(file: string): ParsedReport | { problem: string } {
    if (!exists(file)) {
        return { problem: `报告文件不存在：${file}。下一步：确认路径（相对会话工作区或绝对路径），或省略 report 让本插件自己重复运行命令。` }
    }
    const value = readJson<unknown>(file)
    if (value === undefined) {
        return { problem: `报告文件不是合法 JSON：${file}。下一步：用 flaky_check 重新产出报告，或修好这个文件。` }
    }
    return parseReport(value)
}

// --- classification -------------------------------------------------------

/**
 * Classify one test from its tally.
 *
 * The order matters and is fixed:
 *   1. never failed → `stable`;
 *   2. the failure output matches a declared signature → `suspect-instrumentation`
 *      (the test may be healthy and the environment broken — the advice differs);
 *   3. the failures follow a pattern (only the first run; or every run) →
 *      `investigate` (setup/ordering smell, or a plain bug — never quarantine a
 *      consistent failure);
 *   4. failed at least once, never consistently → `quarantine`.
 * @param tally - runs/failures for one test.
 * @param signatures - the declared signatures (empty disables rule 2).
 */
export function classifyTally(tally: TestTally, signatures: readonly FlakySignature[] = BUILTIN_SIGNATURES): Classification {
    const where = tally.firstFailingRun === undefined ? '' : `，首次失败：第 ${tally.firstFailingRun} 次运行`
    const base = `${tally.runs} 次运行中失败 ${tally.failures} 次${where}`
    if (tally.failures === 0) {
        return {
            classification: 'stable',
            evidence: `${tally.runs} 次运行中没有失败`,
            action: '不用管它：这条用例在观察窗口内是稳定的（观察次数有限，重要交付可以再跑几轮）。',
        }
    }
    const signature = tally.failureOutput === undefined ? undefined : matchSignature(tally.failureOutput, signatures)
    if (signature !== undefined) {
        return {
            classification: 'suspect-instrumentation',
            evidence: `${base}；失败输出匹配签名「${signature.label}」（/${signature.pattern}/i）`,
            action: `先查仪器/环境，不要急着隔离：${signature.advice}（签名是配置里的模式，改它等于改口径，需要 review。）`,
        }
    }
    if (tally.inconclusive === true) {
        return {
            classification: 'investigate',
            evidence: `${base}；但有些运行没有点名任何用例（opaque）：证据不足以判定"稳定失败"还是"不稳定"`,
            action: '先补齐证据：让 runner 点名用例（verbose/TAP 输出），或在计划里多跑几次；在测不准的数据上做隔离只会把不确定性藏起来。',
        }
    }
    if (tally.failures === tally.runs) {
        return {
            classification: 'investigate',
            evidence: `${base}：每一次运行都失败`,
            action: '这不是 flaky，是稳定失败：去修它（或修它依赖的环境）。隔离一条每次都失败的用例只会让红色消失，不会让问题消失。',
        }
    }
    if (tally.failures === 1 && tally.runs > 1 && tally.firstFailingRun === 1) {
        return {
            classification: 'investigate',
            evidence: `${base}：只在第 1 次运行失败，之后都通过（像 setup / 排序问题：首次编译、残留状态、端口还没释放）`,
            action: '查顺序依赖与 setup：让这条用例自己准备前置状态（不要依赖"前面跑过什么"），再重跑确认。',
        }
    }
    return {
        classification: 'quarantine',
        evidence: `${base}：不稳定（通过和失败都出现过）`,
        action: '隔离它——隔离是借款不是修复：先让主干可信，再单独查根因（隔离条目必须带 owner 与到期时间）。',
    }
}

// --- the quarantine ledger ------------------------------------------------

/** Unusable rows of the ledger file, with why (the tail line of a crash). */
export interface QuarantineRead {
    rows: QuarantineRow[]
    problems: string[]
}

/** Normalise one ledger row; `undefined` when it is not usable as a quarantine. */
function toRow(value: unknown): { row: QuarantineRow } | { problem: string } {
    if (!isRecord(value)) return { problem: `行不是对象：${JSON.stringify(value)}` }
    const test = typeof value['test'] === 'string' ? value['test'].trim() : ''
    if (test === '') return { problem: '行缺少 test' }
    const at = positiveInt(value['at']) ?? (typeof value['at'] === 'string' ? Date.parse(value['at']) : Number.NaN)
    const owner = typeof value['owner'] === 'string' ? value['owner'].trim() : ''
    const rawExpiry = value['expiresAt']
    const expiresAt =
        typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)
            ? rawExpiry
            : typeof rawExpiry === 'string'
              ? Date.parse(rawExpiry)
              : Number.NaN
    if (!Number.isFinite(at)) return { problem: `${test}：at 缺失或不可解析（epoch ms 或 ISO-8601 字符串）` }
    if (!Number.isFinite(expiresAt)) return { problem: `${test}：expiresAt 缺失或不可解析（epoch ms 或 ISO-8601 字符串）` }
    if (owner === '') return { problem: `${test}：没有 owner——没有负责人的隔离不允许存在` }
    return {
        row: {
            at,
            test,
            owner,
            expiresAt,
            reason: typeof value['reason'] === 'string' ? value['reason'] : '',
            evidencePath: typeof value['evidencePath'] === 'string' ? value['evidencePath'] : '',
        },
    }
}

/**
 * Read the append-only quarantine ledger.
 *
 * The file is JSONL, so a truncated tail line (a crash mid-append) is skipped
 * with a note instead of failing the read — but a row that exists and cannot be
 * used (no owner, no expiry) is reported as a problem: it must not silently
 * count as "quarantined".
 * @param file - the ledger path.
 */
export function readQuarantine(file: string): QuarantineRead {
    if (!exists(file)) return { rows: [], problems: [] }
    const text = readText(file) ?? ''
    const rows: QuarantineRow[] = []
    const problems: string[] = []
    for (const [index, line] of text.split('\n').entries()) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let value: unknown
        try {
            value = JSON.parse(trimmed) as unknown
        } catch {
            // The last line of a file whose writer died mid-append; anything else
            // is a corrupted ledger and is named.
            const isTail = index === text.split('\n').length - 1 && !text.endsWith('\n')
            problems.push(`${file} 第 ${index + 1} 行不是合法 JSON${isTail ? '（文件被截断的尾行，已跳过）' : '（中间行损坏，已跳过）'}`)
            continue
        }
        const parsed = toRow(value)
        if ('problem' in parsed) {
            problems.push(`${file} 第 ${index + 1} 行：${parsed.problem}`)
            continue
        }
        rows.push(parsed.row)
    }
    return { rows, problems }
}

/** The newest row per test (the ledger is append-only, newest wins). */
export function currentQuarantines(rows: readonly QuarantineRow[]): QuarantineRow[] {
    const latest = new Map<string, QuarantineRow>()
    for (const row of rows) {
        const existing = latest.get(row.test)
        if (existing === undefined || row.at >= existing.at) latest.set(row.test, row)
    }
    return [...latest.values()].sort((left, right) => left.test.localeCompare(right.test))
}

/** Quarantines whose expiry has passed (the plan's escalations). */
export function expiredQuarantines(rows: readonly QuarantineRow[], now: number): QuarantineRow[] {
    return rows.filter((row) => row.expiresAt <= now).sort((left, right) => left.expiresAt - right.expiresAt)
}

/**
 * Quarantined tests that the last `threshold` runs never named.
 *
 * A test quarantined and then deleted (or renamed, or skipped) is coverage
 * silently lost: nothing fails, nothing is checked, and the suite still reports
 * green. This is the only way that shows up.
 */
export function unseenQuarantines(rows: readonly QuarantineRow[], runs: readonly ObservedRun[], threshold: number): QuarantineRow[] {
    if (threshold <= 0 || runs.length < threshold) return []
    const window = runs.slice(runs.length - threshold)
    const observed = new Set(window.flatMap((run) => run.named.map((entry) => entry.name)))
    return rows
        .filter((row) => !observed.has(row.test))
        .sort((left, right) => left.test.localeCompare(right.test))
}

// --- building the plan ----------------------------------------------------

/** Options for {@link buildPlan}. */
export interface BuildPlanOptions {
    cwd: string
    settings: FlakySettings
    /** The quarantine ledger path (resolved against the workspace). */
    quarantineFile: string
    now: number
    source: FlakySource
    tallies: readonly TestTally[]
    runs: readonly ObservedRun[]
    /** Rows already in the ledger, for escalations. */
    quarantined: readonly QuarantineRow[]
    /** Ledger rows that could not be used. */
    ledgerProblems?: readonly string[]
    /** Mission-relative path of the artifact (named inside the quarantine rows). */
    evidencePath: string
    notes?: readonly string[]
}

/** The host-side command that appends one quarantine row (never run by this plugin). */
export function quarantineCommandFor(file: string, row: QuarantineRow): string {
    return `printf '%s\\n' '${JSON.stringify(row)}' >> ${file}`
}

/** Build the plan (pure: the caller passes the clock and the data). */
export function buildPlan(options: BuildPlanOptions): FlakyPlan {
    const settings = options.settings
    const notes = [...(options.notes ?? [])]
    const escalations: FlakyEscalation[] = []
    for (const problem of options.ledgerProblems ?? []) escalations.push({ test: '(台账)', kind: 'invalid-row', message: problem })
    for (const row of expiredQuarantines(options.quarantined, options.now)) {
        escalations.push({
            test: row.test,
            kind: 'expired',
            message: `这条隔离已过期：要么修，要么删，不能继续挂着（owner=${row.owner}，到期 ${new Date(row.expiresAt).toISOString()}，理由：${row.reason || '未写'}）`,
        })
    }
    if (settings.owner === undefined && options.tallies.some((tally) => classifyTally(tally, settings.signatures).classification === 'quarantine')) {
        notes.push(
            '没有配置 `flaky.owner`：本次**拒绝**给出隔离命令（隔离必须有负责人，否则就是"谁都不管"）。' +
                '下一步：由人决定负责人并写进 profile 或 <repo>/.dsh/impact-gate.json 的 flaky.owner。',
        )
    }
    const maxMs = settings.quarantineMaxDays * 24 * 60 * 60 * 1_000
    const tests: FlakyPlanEntry[] = options.tallies.map((tally) => {
        const classified = classifyTally(tally, settings.signatures)
        const entry: FlakyPlanEntry = {
            name: tally.name,
            classification: classified.classification,
            runs: tally.runs,
            failures: tally.failures,
            ...(tally.firstFailingRun === undefined ? {} : { firstFailingRun: tally.firstFailingRun }),
            evidence: classified.evidence,
            action: classified.action,
        }
        if (classified.classification !== 'quarantine') return entry
        const expiresAt = options.now + maxMs
        if (settings.owner === undefined) {
            return {
                ...entry,
                refusal: '拒绝隔离：没有 owner（`flaky.owner` 未配置）。隔离是借款，借款人必须有名有姓。',
                expiresAt,
            }
        }
        const row: QuarantineRow = {
            at: options.now,
            test: tally.name,
            owner: settings.owner,
            expiresAt,
            reason: `flaky：${classified.evidence}`,
            evidencePath: options.evidencePath,
        }
        return {
            ...entry,
            owner: settings.owner,
            expiresAt,
            quarantineRow: row,
            quarantineCommand: quarantineCommandFor(options.quarantineFile, row),
        }
    })
    const counts = { stable: 0, quarantine: 0, investigate: 0, suspectInstrumentation: 0, refused: 0 }
    for (const entry of tests) {
        if (entry.classification === 'stable') counts.stable += 1
        else if (entry.classification === 'quarantine') counts.quarantine += 1
        else if (entry.classification === 'investigate') counts.investigate += 1
        else counts.suspectInstrumentation += 1
        if (entry.refusal !== undefined) counts.refused += 1
    }
    return {
        version: 1,
        plugin: 'dsh-impact-gate',
        kind: 'flaky-plan',
        generatedAt: new Date(options.now).toISOString(),
        cwd: options.cwd,
        source: options.source,
        runs: [...options.runs],
        tests,
        summary: counts,
        escalations,
        quarantine: {
            file: options.quarantineFile,
            owner: settings.owner ?? null,
            maxDays: settings.quarantineMaxDays,
            unseenRunsBeforeWarn: settings.unseenRunsBeforeWarn,
        },
        notes,
    }
}

/** Label of one classification, in Chinese. */
export function classificationLabel(classification: FlakyClassification): string {
    if (classification === 'stable') return '稳定'
    if (classification === 'quarantine') return '隔离'
    if (classification === 'investigate') return '查根因'
    return '疑似仪器/环境'
}

/** Render the plan for a human (Chinese, exact, ends with 下一步). */
export function renderPlan(plan: FlakyPlan, options: { recorded?: { relative: string; evidenceId: string }; artifactProblem?: string; missionId?: string } = {}): string {
    const lines: string[] = []
    const head =
        plan.source.mode === 'report'
            ? `报告 ${plan.source.report ?? '(未命名)'}`
            : `本插件重复运行命令 ${plan.source.command ?? '(未配置)'} ${plan.source.observed} 次`
    lines.push(`🧪 flaky 计划：${plan.tests.length} 个用例（来源：${head}）`)
    lines.push(
        `分类：稳定 ${plan.summary.stable}、隔离 ${plan.summary.quarantine}、查根因 ${plan.summary.investigate}、疑似仪器/环境 ${plan.summary.suspectInstrumentation}` +
            (plan.summary.refused > 0 ? `，其中 ${plan.summary.refused} 项被拒绝隔离` : ''),
    )
    lines.push(
        `隔离策略：owner=${plan.quarantine.owner ?? '(未配置)'}，最长 ${plan.quarantine.maxDays} 天，台账 ${plan.quarantine.file}（"最近 ${plan.quarantine.unseenRunsBeforeWarn} 次运行没出现"由 flaky_status 报出）`,
    )
    if (plan.source.mode === 'runs') {
        for (const run of plan.runs) lines.push(`  - 第 ${run.index} 次运行：${run.outcome === 'pass' ? '通过' : '失败'}（exit=${run.exitCode ?? 'null'}${run.timedOut ? '，超时' : ''}，点名 ${run.named.length} 个用例）`)
    }
    for (const entry of plan.tests) {
        lines.push('')
        lines.push(
            `[${classificationLabel(entry.classification)}] ${entry.name} — 运行 ${entry.runs} 次，失败 ${entry.failures} 次` +
                (entry.firstFailingRun === undefined ? '' : `（首次失败：第 ${entry.firstFailingRun} 次运行）`),
        )
        lines.push(`  证据：${entry.evidence}`)
        lines.push(`  建议：${entry.action}`)
        if (entry.refusal !== undefined) lines.push(`  ⛔ ${entry.refusal}`)
        if (entry.quarantineCommand !== undefined && entry.expiresAt !== undefined) {
            lines.push(`  隔离：owner=${entry.owner ?? '?'}，到期 ${new Date(entry.expiresAt).toISOString()}（${plan.quarantine.maxDays} 天后）`)
            lines.push('  宿主执行的写入命令（**本插件不会执行**：隔离是人的决定，机器不该自己让一条用例闭嘴）：')
            lines.push(`    ${entry.quarantineCommand}`)
        }
    }
    if (plan.escalations.length > 0) {
        lines.push('')
        lines.push(`⛔ 升级（${plan.escalations.length} 项，必须有人处理）：`)
        for (const escalation of plan.escalations) lines.push(`  - [${escalation.kind}] ${escalation.test}：${escalation.message}`)
    }
    if (plan.notes.length > 0) {
        lines.push('')
        for (const note of plan.notes) lines.push(`ℹ️ ${note}`)
    }
    lines.push('')
    if (options.artifactProblem !== undefined) {
        lines.push(`⚠️ 产物写入失败：${options.artifactProblem}（计划本身仍然有效，但它没有被记录到 mission 上）`)
    } else if (options.recorded !== undefined) {
        lines.push(`产物：${options.recorded.relative}（证据 ${options.recorded.evidenceId}，mission ${options.missionId ?? '(无)'}）`)
    } else {
        lines.push('产物：(无 mission，未落盘)')
    }
    lines.push(
        plan.summary.quarantine > 0 && plan.quarantine.owner === null
            ? '下一步：先由人指定负责人（flaky.owner）——本次**没有渲染隔离命令**（没有负责人的隔离等于没人管）；指定后重跑 `flaky_plan` 拿写入命令，再用 `flaky_status` 复查到期与"消失"的隔离。'
            : plan.summary.quarantine > 0
              ? '下一步：把要隔离的条目用上面的命令写进台账（人来执行），不需要隔离的就按建议去修；之后定期用 `flaky_status` 复查到期与"消失"的隔离。'
              : plan.summary.investigate + plan.summary.suspectInstrumentation > 0
                ? '下一步：按上面的建议去查根因（先看仪器/环境，再看顺序依赖）；修完重跑一次把不稳定用例压到 0。'
                : '下一步：没有不稳定用例；这只是有限次观察的结论，重要交付可以再提高 runs 重跑一次。',
    )
    return lines.join('\n')
}

// --- status ---------------------------------------------------------------

/** One recorded plan artifact, as `flaky_status` needs it. */
export interface FlakyPlanSummary {
    file: string
    relative: string
    generatedAt?: string
    tests?: number
    quarantine?: number
    /** Runs the plan observed, with the names each one saw. */
    runs: ObservedRun[]
    summary?: FlakyPlan['summary']
    /** Set when the file exists but cannot be read as JSON. */
    problem?: string
}

/** List a mission's flaky plans, oldest first (names sort chronologically). */
export function listFlakyPlans(dir: string): FlakyPlanSummary[] {
    return listDir(dir)
        .filter((name) => /^\d{8}-\d{6}-plan\.json$/.test(name))
        .sort((left, right) => left.localeCompare(right))
        .map((name) => {
            const file = path.join(dir, name)
            const raw = readJson<Partial<FlakyPlan>>(file)
            if (raw === undefined) return { file, relative: `flaky/${name}`, runs: [], problem: `${file} 不是合法 JSON：无法读取这次计划` }
            return {
                file,
                relative: `flaky/${name}`,
                ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
                ...(Array.isArray(raw.tests) ? { tests: raw.tests.length } : {}),
                ...(raw.summary === undefined ? {} : { quarantine: raw.summary.quarantine }),
                ...(raw.summary === undefined ? {} : { summary: raw.summary }),
                runs: Array.isArray(raw.runs) ? [...raw.runs] : [],
            }
        })
}

/** What `flaky_status` renders. */
export interface StatusInput {
    cwd: string
    settings: FlakySettings
    quarantineFile: string
    now: number
    quarantined: readonly QuarantineRow[]
    ledgerProblems: readonly string[]
    newest?: FlakyPlanSummary
    plansSeen: number
    missionId?: string
    /** The command own-run mode would repeat, when the host configured one. */
    flakyCommand?: string
}

/** Render the read-only `flaky_status` report. */
export function renderStatus(input: StatusInput): string {
    const lines: string[] = []
    lines.push('🧪 flaky 状态（只读）')
    lines.push(
        `策略：owner=${input.settings.owner ?? '(未配置 — 隔离会被拒绝)'}，隔离最长 ${input.settings.quarantineMaxDays} 天，` +
            `"最近 ${input.settings.unseenRunsBeforeWarn} 次运行没出现"告警；签名 ${input.settings.signatures.length} 条`,
    )
    lines.push(`台账：${input.quarantineFile}（${input.quarantined.length} 条生效中的隔离）`)
    lines.push(
        `重复运行的命令：${input.flakyCommand === undefined ? '(未配置 fullTestCommand —— flaky_plan 只能用 report 模式)' : `\`${input.flakyCommand}\``}`,
    )
    if (input.quarantined.length === 0) {
        lines.push('', '当前没有任何隔离条目。')
    } else {
        lines.push('', '| 用例 | owner | 到期 | 理由 | 证据 |', '|------|-------|------|------|------|')
        for (const row of input.quarantined) {
            lines.push(
                `| ${row.test} | ${row.owner} | ${new Date(row.expiresAt).toISOString()} | ${row.reason || '—'} | ${row.evidencePath || '—'} |`,
            )
        }
    }
    const expired = expiredQuarantines(input.quarantined, input.now)
    if (expired.length > 0) {
        lines.push('', `⛔ 已过期的隔离（${expired.length} 条）：要么修，要么删，不能继续挂着`)
        for (const row of expired) {
            lines.push(`  - ${row.test}（owner=${row.owner}，已于 ${new Date(row.expiresAt).toISOString()} 到期）`)
        }
    }
    if (input.ledgerProblems.length > 0) {
        lines.push('', `⚠️ 台账里有 ${input.ledgerProblems.length} 行无法使用（不计入"已隔离"）：`)
        for (const problem of input.ledgerProblems) lines.push(`  - ${problem}`)
    }
    lines.push('')
    if (input.newest === undefined) {
        lines.push(
            `最近计划：（无${input.plansSeen === 0 ? '' : '，产物无法读取'}）— 没有计划产物就无法判断"被隔离的用例最近有没有出现"。`,
        )
    } else {
        lines.push(
            `最近计划：${input.newest.relative}${input.newest.generatedAt === undefined ? '' : `（${input.newest.generatedAt}）`}` +
                (input.newest.problem === undefined ? '' : ` — ${input.newest.problem}`),
        )
        if (input.newest.summary !== undefined) {
            lines.push(
                `  分类：稳定 ${input.newest.summary.stable}、隔离 ${input.newest.summary.quarantine}、查根因 ${input.newest.summary.investigate}、疑似仪器/环境 ${input.newest.summary.suspectInstrumentation}`,
            )
        }
        const runs = input.newest.runs
        const threshold = input.settings.unseenRunsBeforeWarn
        if (runs.length === 0) {
            lines.push(`  该计划没有携带逐次运行的点名结果：无法判断"最近 ${threshold} 次运行没出现"。`)
        } else if (runs.length < threshold) {
            lines.push(`  该计划只有 ${runs.length} 次运行（少于阈值 ${threshold}）：暂不判定"消失"，先积累运行记录。`)
        } else {
            const unseen = unseenQuarantines(input.quarantined, runs, threshold)
            if (unseen.length === 0) {
                lines.push(`  "最近 ${threshold} 次运行没出现"检查：通过（所有隔离用例都还在被点名）。`)
            } else {
                lines.push(`  ⚠️ 可能悄悄丢失的覆盖（最近 ${threshold} 次运行都没点名）：`)
                for (const row of unseen) {
                    lines.push(
                        `    - ${row.test}（owner=${row.owner}）：隔离后被删除/改名/跳过了？覆盖正在静默消失——要么恢复它，要么把隔离条目一起删掉。`,
                    )
                }
            }
        }
    }
    lines.push(
        '',
        input.missionId === undefined
            ? '下一步：没有 mission，计划不会落盘；先建任务（spec_create）或省略 missionId 之外的参数重试。'
            : '下一步：隔离到期前复查（`flaky_plan` 重跑取新数据，本工具只读）；要新增隔离由人执行计划里渲染的命令，本插件不会自己写台账。',
    )
    return lines.join('\n')
}

/** Resolve the quarantine ledger path for one workspace. */
export function quarantineFileFor(settings: FlakySettings, options: { cwd: string; rootDir: string }): string {
    if (settings.quarantineFile === undefined) return path.join(options.rootDir, 'flaky-quarantine.json')
    return path.isAbsolute(settings.quarantineFile) ? settings.quarantineFile : path.resolve(options.cwd, settings.quarantineFile)
}

/** Clamp a requested repeat count into the supported window. */
export function clampRuns(requested: number | undefined, fallback = DEFAULT_UNSEEN_RUNS): number {
    const value = positiveInt(requested) ?? fallback
    return Math.min(MAX_FLAKY_RUNS, Math.max(MIN_FLAKY_RUNS, value))
}

/** Repeat one command and observe the runs (the own-run mode of `flaky_plan`). */
export async function repeatCommand(options: {
    command: string
    cwd: string
    runs: number
    service?: unknown
    signal?: AbortSignal
}): Promise<{ outcomes: RunOutcome[]; notes: string[] }> {
    const argv = splitCommand(options.command)
    const notes: string[] = []
    if (argv.length === 0) throw new Error(`命令是空的：无法重复运行。下一步：配置 fullTestCommand 或传 command（argv 形式，不经过 shell）。`)
    const outcomes: RunOutcome[] = []
    for (let index = 0; index < options.runs; index += 1) {
        const outcome = await runCommand(
            {
                argv,
                cwd: options.cwd,
                timeoutMs: FLAKY_RUN_TIMEOUT_MS,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            options.service as never,
        )
        if (outcome.aborted === true) {
            throw new Error(`第 ${index + 1} 次运行已取消（signal 已 abort）：取消不是结论，本次没有产出计划。下一步：在未被取消的轮次重跑 flaky_plan。`)
        }
        outcomes.push(outcome)
        // Stop early once a pass and a fail have both been seen: more runs cannot
        // change "unstable", and repeating a suite is not a load test.
        const passed = outcomes.some((entry) => entry.exitCode === 0)
        const failed = outcomes.some((entry) => entry.exitCode !== 0)
        if (passed && failed && index + 1 < options.runs) {
            // More runs cannot change "unstable", and repeating a suite is not a
            // load test — so stop, and say that the count was cut short.
            notes.push(`第 ${index + 1} 次运行后已同时观察到通过与失败：提前结束（原计划 ${options.runs} 次）`)
            break
        }
    }
    return { outcomes, notes }
}

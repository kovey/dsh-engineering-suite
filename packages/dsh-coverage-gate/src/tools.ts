/**
 * The model-facing tool surface: `coverage_check`, `flaky_check`, `coverage_status`.
 *
 * Division of labour, the same one the rest of the suite follows:
 *
 *  - the NUMBERS are produced by host-configured commands or by a report the
 *    host pointed at, and are parsed by pure functions (`./coverage`, `./flaky`);
 *  - the THRESHOLDS come from the host profile and may be refined per repository
 *    — never invented here. A gate with no threshold REFUSES instead of passing;
 *  - the VERDICT is recorded on the mission as a `GateRecord`
 *    (`source: dsh-coverage-gate`, with `scope` and a workspace fingerprint), so
 *    delivery can require it the same way it requires a quality gate.
 *
 * Fail-closed, everywhere: an unreadable report is a refusal with the next step,
 * an unparseable one is a `BLOCK` carrying the parser's complaint, and a
 * threshold that could not be judged is reported as unjudged — never as a pass.
 *
 * @module dsh-coverage-gate/tools
 */

import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    changedRanges,
    formatTime,
    gitFingerprint,
    outputDigestOf,
    runCommand,
    tail,
    type AgentLike,
    type ChangedFile,
    type GateCommandResult,
    type GateScope,
    type GateState,
    type GitFingerprint,
    type Logger,
    type MissionStore,
    type MissionStoreRegistry,
    type RunOutcome,
} from 'dsh-eng-core'
import {
    MAX_FLAKY_REPEATS,
    MIN_FLAKY_REPEATS,
    REPORT_FORMATS,
    describeSource,
    describeThresholds,
    formatPercent,
    parseThresholds,
    thresholdKeys,
    type CoverageGateConfig,
    type CoverageThresholds,
    type EffectiveConfig,
    type ReportFormat,
    type ThresholdKey,
} from './config.js'
import {
    incrementalCoverage,
    parseCoverage,
    percentOf,
    worstFiles,
    type CoverageReport,
    type IncrementalCoverage,
} from './coverage.js'
import { detectFlakiness, toRunResult, type FlakinessVerdict, type RunResult } from './flaky.js'
import { renderForDisplay, tokenizeTemplate } from './command.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Structural view of `ctx.subprocess`. */
export interface SubprocessLike {
    spawn(spec: never): never
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: CoverageGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    /** `ctx.get('subprocess')`, read per run. */
    subprocess: () => unknown
    /** Plugin logger; `deps.logger.for(cwd)` routes a line to that workspace's file. */
    logger: Logger
}

/** The gate `source` every record this plugin writes carries. */
export const GATE_SOURCE = 'dsh-coverage-gate'

/** Arguments of `coverage_check`. */
interface CoverageArgs {
    base?: string
    missionId?: string
    reportFile?: string
    format?: string
    thresholds?: Record<string, unknown>
}

/** Arguments of `flaky_check`. */
interface FlakyArgs {
    command?: string
    repeats?: number
    missionId?: string
}

/** Arguments of `coverage_status`. */
interface StatusArgs {
    missionId?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/**
 * The workspace a tool call applies to.
 *
 * With no declared `header.cwd` the gate would read a report (or run a command)
 * in the harness's own directory and record the verdict against the wrong
 * project, so the call is refused.
 */
function declaredCwdOrThrow(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：覆盖率报告与门禁命令会在错误的目录上执行，因此本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    return cwd
}

/** Resolve a configured artifact path (an absolute value stays absolute). */
export function artifactPathOf(cwd: string, file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** The workspace-relative form of a path, when it is inside the workspace. */
function relativeOf(cwd: string, file: string): string | undefined {
    const relative = path.relative(cwd, file).split(path.sep).join('/')
    if (relative === '' || relative.startsWith('..')) return undefined
    return relative
}

/** Build one synthetic gate-check result. */
function checkResult(
    id: string,
    name: string,
    expectation: string,
    exitCode: number | null,
    output: string,
    required = true,
): GateCommandResult {
    return {
        id,
        name,
        command: expectation,
        required,
        exitCode,
        signal: null,
        durationMs: 0,
        timedOut: false,
        output,
        outputDigest: outputDigestOf(output, ''),
    }
}

/** Read a UTF-8 file, `undefined` when it cannot be read. */
function readTextFile(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
}

/** The refusal a missing threshold set produces. */
function missingThresholdsRefusal(file: string): string {
    return [
        '本仓库没有生效的覆盖率阈值：没有阈值就没有门禁，本插件不会用默认值静默放行。',
        `下一步：在 profile 的 coverage-gate 配置里设置 thresholds（例如 thresholds: { total: 80, changed: 80, perFile: 60 }），`,
        `或在 ${file} 里为本仓库设置，或在调用 coverage_check 时传 thresholds。`,
    ].join('\n')
}

/** The refusal a missing report source produces. */
function missingReportRefusal(): string {
    return [
        '没有可用的覆盖率报告来源：既没有本次调用的 reportFile，也没有配置 coverageCommand/reportFile。',
        '下一步（任选其一）：',
        '  1. 在配置里设置 coverageCommand（宿主命令，例如 "npx vitest run --coverage --coverage.reporter=lcov"）+ reportFile（报告落盘位置）；',
        '  2. 在配置里只设置 reportFile，指向 CI 已经产出的报告；',
        '  3. 调用时传 reportFile（该裁决会标记 scope.full=false：报告不是宿主指定的那一份）。',
    ].join('\n')
}

/** Format a percentage that may be undefined ("cannot judge" is not 0%). */
function percentText(value: number | undefined, hit: number, found: number): string {
    return value === undefined ? `无法判定（0 个插桩单元）` : `${formatPercent(value)}（${hit}/${found}）`
}

/** One-line summary of a coverage report. */
function describeReport(report: CoverageReport): string {
    const percent = percentOf(report.totals.linesHit, report.totals.linesFound)
    return `${report.format}（${report.metric === 'lines' ? '行' : '语句块'}）：${report.files.length} 个文件，${
        report.metric === 'lines' ? '行' : '语句'
    }覆盖率 ${percentText(percent, report.totals.linesHit, report.totals.linesFound)}`
}

/** Render the report's own caveats, bounded. */
function renderNotes(notes: readonly string[], limit = 6): string {
    if (notes.length === 0) return ''
    const shown = notes.slice(0, limit).map((note) => `  - ${note}`)
    if (notes.length > limit) shown.push(`  - …另有 ${notes.length - limit} 条（见插件日志/工件）`)
    return ['说明：', ...shown].join('\n')
}

/** One line per changed file for the incremental section. */
function renderIncremental(incremental: IncrementalCoverage, limit = 12): string {
    const lines: string[] = []
    const percent = percentOf(incremental.totals.hit, incremental.totals.instrumented)
    lines.push(
        `增量（本次改动新增行）：插桩 ${incremental.totals.instrumented} 行、命中 ${incremental.totals.hit} 行、未命中 ${incremental.totals.missed} 行 → ${
            percent === undefined ? '无法判定（新增行里没有一行被插桩）' : formatPercent(percent)
        }`,
    )
    if (incremental.totals.uninstrumented > 0) {
        lines.push(`  另有 ${incremental.totals.uninstrumented} 个新增行没有被报告插桩：不计入上面的比例，也无法判定（既不是 0% 也不是 100%）`)
    }
    const judged = incremental.files.filter((file) => file.status !== 'deleted')
    for (const file of judged.slice(0, limit)) {
        const detail: string[] = []
        detail.push(`新增 ${file.addedLines}`)
        detail.push(`插桩 ${file.instrumented}`)
        if (file.instrumented > 0) detail.push(`命中 ${file.hit}/未命中 ${file.missed}`)
        if (file.uninstrumentedRanges.length > 0) {
            detail.push(
                `未插桩 ${file.uninstrumentedRanges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(',')}`,
            )
        }
        if (file.missedLines.length > 0) detail.push(`未命中行 ${file.missedLines.slice(0, 12).join(',')}${file.missedLines.length > 12 ? '…' : ''}`)
        lines.push(`  - ${file.path}：${detail.join('，')}${file.problem === undefined ? '' : `；⚠️ ${file.problem}`}`)
    }
    if (judged.length > limit) lines.push(`  - …另有 ${judged.length - limit} 个改动文件`)
    if (judged.length === 0) lines.push('  - （本次改动没有新增行）')
    return lines.join('\n')
}

/** Files the gate never judges: the engineering trail, the report, the log. */
function excludedChangedPaths(store: MissionStore, cwd: string, reportFile: string, config: CoverageGateConfig): string[] {
    const excluded: string[] = []
    const trail = relativeOf(cwd, store.layout.rootDir)
    if (trail !== undefined) excluded.push(trail)
    const report = relativeOf(cwd, reportFile)
    if (report !== undefined) excluded.push(report)
    const log = relativeOf(cwd, artifactPathOf(cwd, config.logFile))
    if (log !== undefined) excluded.push(log)
    return excluded
}

/** Whether a changed path falls under one of the excluded prefixes. */
function isExcluded(file: string, excluded: readonly string[]): boolean {
    return excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
}

/** The workspace fingerprint recorded with a gate. */
function fingerprintOf(cwd: string, store: MissionStore): GitFingerprint {
    return gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
}

/** Render a `RunOutcome`'s captured output for a gate result and the report. */
function combinedOutput(outcome: RunOutcome, limit: number): string {
    const text = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n--- stderr ---\n')
    const spawn = outcome.spawnError === undefined ? '' : `\n[spawn error] ${outcome.spawnError}`
    return `${tail(text, limit)}${spawn}`.trim()
}

/** Register the coverage-gate tools. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, toolName: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(toolName)
        } catch {
            failed.push(toolName)
        }
    }

    register(
        defineTool({
            name: 'coverage_check',
            description:
                'Judge test EFFECTIVENESS, not test success: run the host-configured coverage command (or read the report it produced), parse it (lcov / cobertura / go-cover / istanbul-json), and compare total coverage, the coverage of the lines THIS CHANGE added, and the per-file worst offenders against the thresholds. Records a PASS / BLOCK gate on the mission. Refuses when there is no threshold, no report source or no readable report — it never passes silently, and it never substitutes a default for a threshold the host did not set.',
            parameters: {
                base: { type: 'string', description: 'Git ref to diff against for incremental coverage (default HEAD, i.e. the working tree).' },
                missionId: { type: 'string', description: 'Mission to record the verdict against (default: the session mission).' },
                reportFile: {
                    type: 'string',
                    description:
                        'Read this coverage report instead of running the configured command. A path that is not the host-configured reportFile makes the verdict non-authorising (scope.full=false).',
                },
                format: {
                    type: 'string',
                    enum: [...REPORT_FORMATS],
                    description: 'Report format; auto (default) sniffs it and refuses text it cannot recognise.',
                },
                thresholds: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        total: { type: 'number', description: 'Minimum whole-report coverage, 0–100.' },
                        changed: { type: 'number', description: 'Minimum coverage of the lines this change added, 0–100.' },
                        perFile: { type: 'number', description: 'Minimum coverage for every instrumented file, 0–100.' },
                    },
                    description: 'Per-call threshold overrides (0–100). Supplying one makes the verdict non-authorising (scope.full=false).',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: CoverageArgs = {} as CoverageArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(agent)
                const config = effective.config
                const signal = (exec as { signal?: AbortSignal }).signal
                const base = typeof args.base === 'string' && args.base.trim() !== '' ? args.base.trim() : 'HEAD'

                // --- thresholds: call argument > project config > profile ----
                const callThresholds = parseThresholds(args.thresholds, '调用参数')
                if (callThresholds.problems.length > 0) {
                    throw new Error(
                        [...callThresholds.problems, '阈值必须是 0–100 的数字；本插件不会用默认值替代它（那等于静默放宽门禁）。'].join('\n'),
                    )
                }
                const thresholds: CoverageThresholds = { ...config.thresholds, ...callThresholds.thresholds }
                const keys = thresholdKeys(thresholds)
                if (keys.length === 0) throw new Error(missingThresholdsRefusal(effective.file))
                const overridden = thresholdKeys(callThresholds.thresholds).filter(
                    (key) => callThresholds.thresholds[key] !== config.thresholds[key],
                )

                // --- format -------------------------------------------------
                let format: ReportFormat = config.reportFormat
                if (args.format !== undefined) {
                    if (!(REPORT_FORMATS as readonly string[]).includes(args.format)) {
                        throw new Error(
                            `未知的报告格式 "${args.format}"（可用：${REPORT_FORMATS.join(', ')}）。下一步：改成受支持的格式，或省略 format 让它按报告内容自动识别（识别不了会拒绝，不会当成 0 覆盖）。`,
                        )
                    }
                    format = args.format as ReportFormat
                }

                // --- obtain the report --------------------------------------
                const callReportFile =
                    typeof args.reportFile === 'string' && args.reportFile.trim() !== '' ? args.reportFile.trim() : undefined
                const hostReportFile = config.reportFile
                let reportFileText: string | undefined
                let reportSource: 'host' | 'call' = 'host'
                let commandText: string | undefined
                let commandOutcome: RunOutcome | undefined

                if (callReportFile !== undefined) {
                    reportFileText = callReportFile
                    reportSource =
                        hostReportFile !== undefined && artifactPathOf(cwd, hostReportFile) === artifactPathOf(cwd, callReportFile)
                            ? 'host'
                            : 'call'
                } else if (config.coverageCommand !== undefined) {
                    if (hostReportFile === undefined) {
                        throw new Error(
                            [
                                '配置了 coverageCommand 但没有配置 reportFile：跑完命令也无法知道报告写在哪里。',
                                '下一步：把 reportFile 指向命令产出的报告（例如 coverage/lcov.info），或在配置里删掉 coverageCommand。',
                            ].join('\n'),
                        )
                    }
                    const reportPath = artifactPathOf(cwd, hostReportFile)
                    const tokenized = tokenizeTemplate(config.coverageCommand, { reportFile: reportPath, workspace: cwd, base })
                    if ('error' in tokenized) {
                        throw new Error(
                            [
                                `覆盖率命令模板无法执行：${tokenized.error}`,
                                '下一步：把 coverageCommand 改写成不带 shell 语法的 argv 形式（需要管道/重定向就写成一个脚本文件再调用）。',
                            ].join('\n'),
                        )
                    }
                    commandText = renderForDisplay(config.coverageCommand, { reportFile: reportPath, workspace: cwd, base })
                    commandOutcome = await runCommand(
                        {
                            argv: tokenized.argv,
                            cwd,
                            timeoutMs: config.commandTimeoutMs,
                            maxOutputBytes: config.maxOutputBytes,
                            ...(signal === undefined ? {} : { signal }),
                        },
                        deps.subprocess() as never,
                    )
                    reportFileText = hostReportFile
                } else if (hostReportFile !== undefined) {
                    reportFileText = hostReportFile
                } else {
                    throw new Error(missingReportRefusal())
                }

                // A cancelled run is not a verdict: no gate record, no artifact.
                if (commandOutcome?.aborted === true || signal?.aborted === true) {
                    return [
                        '⛔ 覆盖率检查：已取消',
                        '本次运行被 signal 取消（命令未跑完）：结果不构成裁决，未写入门禁记录。需要结论时请在未被取消的轮次重跑 coverage_check。',
                    ].join('\n')
                }

                const reportPath = artifactPathOf(cwd, reportFileText)
                const text = readTextFile(reportPath)
                const commandFailed =
                    commandOutcome !== undefined &&
                    (commandOutcome.exitCode !== 0 || commandOutcome.spawnError !== undefined)

                if (text === undefined) {
                    // A command that failed explains the missing report better
                    // than a refusal does — record that failure, never a pass.
                    if (commandFailed && commandOutcome !== undefined) {
                        const output = combinedOutput(commandOutcome, 2_000)
                        const result = gateResultOfRun('coverage-command', '覆盖率命令', commandText ?? '', commandOutcome)
                        const reason = `覆盖率命令失败（exit=${commandOutcome.exitCode ?? 'null'}${commandOutcome.timedOut ? '，超时' : ''}）：报告未产出`
                        const gateId = recordIfMission(store, agent, args.missionId, {
                            state: 'BLOCK',
                            reason,
                            results: [result],
                            scope: { selected: [], total: keys.length, full: false },
                            fingerprint: fingerprintOf(cwd, store),
                        })
                        logger.warn(`coverage_check: BLOCK — ${reason}`)
                        return [
                            '⛔ 覆盖率检查：BLOCK',
                            `原因：${reason}`,
                            `命令：\`${commandText ?? ''}\``,
                            `报告路径：${reportPath}（不存在）`,
                            output === '' ? '' : `输出（截断）：\n${output}`,
                            `gate record: ${gateId ?? '(无 mission，未记录)'}`,
                            '下一步：先让覆盖率命令跑通（它失败时覆盖率无从谈起），再重跑 coverage_check。',
                        ]
                            .filter((line) => line !== '')
                            .join('\n')
                    }
                    throw new Error(
                        [
                            `覆盖率报告不存在或不可读：${reportPath}`,
                            '下一步（任选其一）：',
                            '  1. 配置 coverageCommand 让它生成报告，并确认 reportFile 指向生成位置；',
                            '  2. 先运行生成报告的命令，再重跑 coverage_check；',
                            '  3. 如果报告在别处，用 coverage_check 的 reportFile 参数指定（该裁决会标记 scope.full=false）。',
                        ].join('\n'),
                    )
                }

                // --- parse --------------------------------------------------
                const parsed = parseCoverage(text, { cwd, format })
                if (!parsed.ok) {
                    const result = checkResult('coverage-report', '覆盖率报告解析', 'report parseable', 1, parsed.problem)
                    const reason = `覆盖率报告无法解析：${parsed.problem}`
                    const gateId = recordIfMission(store, agent, args.missionId, {
                        state: 'BLOCK',
                        reason,
                        results: [result],
                        scope: { selected: [], total: keys.length, full: false },
                        fingerprint: fingerprintOf(cwd, store),
                    })
                    logger.warn(`coverage_check: BLOCK — ${reason}`)
                    return [
                        '⛔ 覆盖率检查：BLOCK',
                        `原因：${reason}`,
                        `报告：${reportPath}（格式请求：${format}）`,
                        `gate record: ${gateId ?? '(无 mission，未记录)'}`,
                        '说明：报告解析失败**不是** 0 覆盖，也不是通过——它是"这份报告不能作为依据"。',
                        '下一步：确认 reportFormat 与报告实际格式一致（auto 都识别不了时说明报告可能被截断或不是覆盖率报告）。',
                    ].join('\n')
                }
                const report = parsed

                // --- incremental coverage -----------------------------------
                const diff = await changedRanges({ cwd, base })
                const excluded = excludedChangedPaths(store, cwd, reportPath, config)
                const changed: ChangedFile[] = diff.files.filter((file) => !isExcluded(file.path, excluded))
                const incremental = incrementalCoverage(report, changed)

                // --- judge --------------------------------------------------
                const checks: GateCommandResult[] = []
                const judged: ThresholdKey[] = []
                const unjudged: ThresholdKey[] = []
                const summary: string[] = []

                checks.push(
                    checkResult(
                        'coverage-report',
                        '覆盖率报告解析',
                        'report parseable',
                        0,
                        `已解析 ${describeReport(report)}${report.notes.length === 0 ? '' : `；${report.notes.length} 条说明`}`,
                    ),
                )
                if (commandOutcome !== undefined) {
                    const result = gateResultOfRun('coverage-command', '覆盖率命令', commandText ?? '', commandOutcome)
                    checks.push(result)
                    summary.push(`覆盖率命令 exit=${commandOutcome.exitCode ?? 'null'}（${commandOutcome.durationMs}ms）`)
                }

                for (const key of keys) {
                    const threshold = thresholds[key] as number
                    if (key === 'total') {
                        const percent = percentOf(report.totals.linesHit, report.totals.linesFound)
                        const expectation = `coverage.total >= ${formatPercent(threshold)}`
                        if (percent === undefined) {
                            unjudged.push(key)
                            checks.push(
                                checkResult(
                                    'coverage-total',
                                    '总覆盖率',
                                    expectation,
                                    // Fail closed: a report that instruments nothing
                                    // cannot support the threshold the host set.
                                    1,
                                    `报告里没有任何被插桩的单元（找到 ${report.files.length} 个文件）：总覆盖率无从判定。这不是 0%，但同样不能作为通过依据。`,
                                ),
                            )
                            continue
                        }
                        judged.push(key)
                        const pass = percent >= threshold
                        const output = `总覆盖率 ${percentText(percent, report.totals.linesHit, report.totals.linesFound)}，阈值 ${formatPercent(
                            threshold,
                        )} → ${pass ? '达标' : '不达标'}`
                        checks.push(checkResult('coverage-total', '总覆盖率', expectation, pass ? 0 : 1, output))
                        summary.push(`总 ${percentText(percent, report.totals.linesHit, report.totals.linesFound)} ${pass ? '≥' : '<'} ${formatPercent(threshold)}`)
                        continue
                    }
                    if (key === 'changed') {
                        const expectation = `coverage.changed >= ${formatPercent(threshold)}`
                        if (!diff.isRepo) {
                            unjudged.push(key)
                            checks.push(
                                checkResult(
                                    'coverage-changed',
                                    '增量覆盖率（本次改动新增行）',
                                    expectation,
                                    // A configured incremental threshold that cannot
                                    // be computed is a BLOCK: the host asked for a
                                    // judgement this workspace cannot produce.
                                    1,
                                    `${diff.problem ?? '工作区不是 git 仓库'}：无法计算增量覆盖率。配置了 thresholds.changed 就必须能判定它；把它删掉或让工作区可 diff。`,
                                ),
                            )
                            continue
                        }
                        if (incremental.empty) {
                            unjudged.push(key)
                            checks.push(
                                checkResult(
                                    'coverage-changed',
                                    '增量覆盖率（本次改动新增行）',
                                    expectation,
                                    null,
                                    `本次改动（相对 ${base}）没有任何新增行：增量阈值不适用，未判定。`,
                                ),
                            )
                            continue
                        }
                        const percent = percentOf(incremental.totals.hit, incremental.totals.instrumented)
                        if (percent === undefined) {
                            unjudged.push(key)
                            checks.push(
                                checkResult(
                                    'coverage-changed',
                                    '增量覆盖率（本次改动新增行）',
                                    expectation,
                                    1,
                                    `本次改动有 ${incremental.totals.addedLines} 个新增行，但报告没有插桩其中任何一行：无法判定增量覆盖率（这既不是 0% 也不是 100%）。`,
                                ),
                            )
                            continue
                        }
                        judged.push(key)
                        const pass = percent >= threshold
                        const output = `新增行插桩 ${incremental.totals.instrumented}/${incremental.totals.addedLines} 行，命中 ${incremental.totals.hit} 行 → ${formatPercent(
                            percent,
                        )}，阈值 ${formatPercent(threshold)} → ${pass ? '达标' : '不达标'}`
                        checks.push(checkResult('coverage-changed', '增量覆盖率（本次改动新增行）', expectation, pass ? 0 : 1, output))
                        summary.push(`增量 ${formatPercent(percent)} ${pass ? '≥' : '<'} ${formatPercent(threshold)}`)
                        continue
                    }
                    // perFile
                    const expectation = `coverage.perFile >= ${formatPercent(threshold)}`
                    const files = report.files.filter((file) => file.linesFound > 0)
                    if (files.length === 0) {
                        unjudged.push(key)
                        checks.push(
                            checkResult(
                                'coverage-per-file',
                                '每文件覆盖率',
                                expectation,
                                1,
                                '报告里没有被插桩的文件：每文件阈值无从判定（这既不是 0% 也不是 100%）。',
                            ),
                        )
                        continue
                    }
                    const violations = files.filter((file) => (file.linesHit / file.linesFound) * 100 < threshold)
                    judged.push(key)
                    const worst = worstFiles(report, 5)
                    const output =
                        violations.length === 0
                            ? `${files.length} 个被插桩的文件全部达到 ${formatPercent(threshold)}；最低 ${worst[0]?.path ?? ''} ${formatPercent(worst[0]?.percent ?? 0)}`
                            : `${violations.length}/${files.length} 个文件低于 ${formatPercent(threshold)}：${worst
                                  .filter((file) => file.percent < threshold)
                                  .map((file) => `${file.path} ${formatPercent(file.percent)}`)
                                  .join('，')}`
                    checks.push(checkResult('coverage-per-file', '每文件覆盖率', expectation, violations.length === 0 ? 0 : 1, output))
                    summary.push(`每文件最低 ${formatPercent(worst[0]?.percent ?? 0)} ${violations.length === 0 ? '≥' : '<'} ${formatPercent(threshold)}`)
                }

                const blocking = checks.filter((check) => check.exitCode !== null && check.exitCode !== 0)
                const state: GateState = blocking.length > 0 ? 'BLOCK' : 'PASS'
                const full = judged.length === keys.length && overridden.length === 0 && reportSource === 'host'
                const scope: GateScope = { selected: [...judged], total: keys.length, full }
                const reason =
                    state === 'PASS'
                        ? `覆盖率达标：${summary.join('；') || '无阈值'}`
                        : `覆盖率不达标：${blocking.map((check) => check.output).join('；') || '无法判定'}`

                // --- artifact + gate record ---------------------------------
                const artifact = {
                    kind: 'coverage',
                    at: Date.now(),
                    workspace: cwd,
                    base,
                    format: report.format,
                    metric: report.metric,
                    reportFile: reportPath,
                    reportSource,
                    command: commandText ?? null,
                    totals: {
                        linesFound: report.totals.linesFound,
                        linesHit: report.totals.linesHit,
                        percent: percentOf(report.totals.linesHit, report.totals.linesFound) ?? null,
                    },
                    incremental: {
                        addedLines: incremental.totals.addedLines,
                        instrumented: incremental.totals.instrumented,
                        hit: incremental.totals.hit,
                        missed: incremental.totals.missed,
                        uninstrumented: incremental.totals.uninstrumented,
                        percent: percentOf(incremental.totals.hit, incremental.totals.instrumented) ?? null,
                        judgement: incremental.judgement,
                        files: incremental.files,
                    },
                    thresholds,
                    checks: checks.map((check) => ({ id: check.id, exitCode: check.exitCode, output: check.output })),
                    worst: worstFiles(report, 10),
                    state,
                    reason,
                }
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined ? {} : { explicitId: args.missionId }),
                })
                let artifactNote = '(无 mission，未落盘)'
                if (mission !== undefined) {
                    const file = store.writeArtifact(mission.id, path.join('artifacts', 'coverage.json'), `${JSON.stringify(artifact, undefined, 2)}\n`)
                    artifactNote = path.relative(cwd, file)
                }
                const gateId = recordIfMission(store, agent, args.missionId, {
                    state,
                    reason,
                    results: checks,
                    scope,
                    fingerprint: fingerprintOf(cwd, store),
                })
                logger.info(
                    `coverage_check: ${state} — ${reason}；报告 ${reportPath}（${report.format}，来源 ${reportSource === 'host' ? '宿主配置' : '调用参数'}）；scope.full=${full}；mission ${mission?.id ?? '(无)'}`,
                )

                const lines: string[] = []
                lines.push(`${state === 'PASS' ? '✅' : '⛔'} 覆盖率检查：${state}`)
                lines.push(`原因：${reason}`)
                lines.push('')
                lines.push(`报告：${reportPath}（格式 ${report.format}，来源：${reportSource === 'host' ? '宿主配置' : '调用参数'}）`)
                lines.push(`汇总：${describeReport(report)}`)
                lines.push(renderIncremental(incremental))
                const worst = worstFiles(report, 5)
                if (worst.length > 0) {
                    lines.push(
                        `最差文件：${worst
                            .map((file) => `${file.path} ${formatPercent(file.percent)}（${file.linesHit}/${file.linesFound}）`)
                            .join('，')}`,
                    )
                }
                lines.push('判定：')
                for (const check of checks) {
                    lines.push(
                        `  - [${check.exitCode === 0 ? 'PASS' : check.exitCode === null ? 'SKIP' : 'FAIL'}] ${check.id}（${check.name}）：${check.output}`,
                    )
                }
                lines.push('')
                lines.push(
                    `阈值（生效值，来源 ${describeSource(effective)}）：${describeThresholds(thresholds)}${
                        overridden.length === 0 ? '' : `；本次调用覆盖了 ${overridden.join(', ')}`
                    }`,
                )
                lines.push(
                    `覆盖范围：${full ? `完整（${judged.join(', ') || '无'}/${keys.length} 个阈值全部判定）` : `部分（已判定 ${judged.join(', ') || '无'}；未判定 ${
                        unjudged.join(', ') || '无'
                    }）— 不构成完整的交付依据`}`,
                )
                if (!full) {
                    const why: string[] = []
                    if (unjudged.length > 0) why.push(`未判定的阈值：${unjudged.join(', ')}`)
                    if (overridden.length > 0) why.push(`阈值由调用参数提供（非宿主配置）：${overridden.join(', ')}`)
                    if (reportSource === 'call') why.push('报告文件由调用参数指定（非宿主配置）')
                    lines.push(`  scope.full=false 的原因：${why.join('；')}`)
                }
                if (report.notes.length > 0) lines.push(renderNotes(report.notes))
                if (incremental.notes.length > 0) lines.push(renderNotes(incremental.notes))
                lines.push('')
                lines.push(`gate record: ${gateId ?? '(无 mission，未记录)'}`)
                lines.push(`工件：${artifactNote}`)
                lines.push(
                    state === 'PASS'
                        ? '下一步：这条 PASS 只说明"这些行被测到了"，不说明行为正确；交付前请确认最新覆盖率门禁晚于最后一次代码改动（改动后要重跑）。'
                        : '下一步：给未命中的新增行补测试（优先补 `missedLines`），或把确实无法插桩的部分说明清楚；**不要**通过调低阈值或换报告文件让它变绿。',
                )
                return lines.join('\n')
            },
        }),
        'coverage_check',
    )

    register(
        defineTool({
            name: 'flaky_check',
            description:
                'Detect flakiness: run the same test command N times (default 3, hard cap 10), stop early once both a pass and a fail have been seen, and compare the runs at per-test granularity when the runner names its cases (--- FAIL: TestX, ✖ name, FAILED tests/x.py::test_y, × name, TAP) or at run level when it only produces an exit code. Records BLOCK/WARN on the mission according to the host flakyPolicy; a suite that fails intermittently is a defect in the suite, not in the product.',
            parameters: {
                command: {
                    type: 'string',
                    description:
                        'Command to repeat, argv-split without a shell (shell metacharacters are refused). Placeholders: {run} (1-based), {run0} (0-based), {workspace}. Overriding the host-configured command makes the verdict non-authorising (scope.full=false).',
                },
                repeats: { type: 'integer', description: `How many runs to attempt (2–${MAX_FLAKY_REPEATS}); capped by the host configuration.` },
                missionId: { type: 'string', description: 'Mission to record the verdict against (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: FlakyArgs = {} as FlakyArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(agent)
                const config = effective.config
                const signal = (exec as { signal?: AbortSignal }).signal

                const callCommand = typeof args.command === 'string' && args.command.trim() !== '' ? args.command.trim() : undefined
                const hostCommand = config.flakyCommand
                const command = callCommand ?? hostCommand
                if (command === undefined) {
                    throw new Error(
                        [
                            '没有 flaky 命令：不知道要重复运行什么。',
                            '下一步：在 profile 或项目配置里设置 flakyCommand（例如 "node --test test/*.test.ts"，或 "go test ./..."），',
                            '或在调用 flaky_check 时传 command（该裁决会标记 scope.full=false）。',
                        ].join('\n'),
                    )
                }
                const commandFromHost = callCommand === undefined || callCommand === hostCommand

                if (args.repeats !== undefined && (!Number.isInteger(args.repeats) || args.repeats < 1)) {
                    throw new Error(`repeats 必须是正整数（收到 ${JSON.stringify(args.repeats)}）。下一步：传 2–${MAX_FLAKY_REPEATS} 之间的整数，或省略它使用配置值 ${config.flakyRepeats}。`)
                }
                const requested = args.repeats ?? config.flakyRepeats
                const planned = Math.min(requested, config.flakyRepeats)
                const notes: string[] = []
                if (planned < requested) notes.push(`调用要求运行 ${requested} 次，按宿主配置上限 ${config.flakyRepeats} 次执行（重复运行不能变成压力测试）`)
                if (planned < MIN_FLAKY_REPEATS) notes.push(`只计划运行 ${planned} 次：单次运行无法判定 flaky（至少需要 2 次）`)

                const runs: RunResult[] = []
                const results: GateCommandResult[] = []
                let stoppedEarly = false
                for (let index = 1; index <= planned; index += 1) {
                    const tokenized = tokenizeTemplate(command, { run: String(index), run0: String(index - 1), workspace: cwd })
                    if ('error' in tokenized) {
                        throw new Error(
                            [
                                `flaky 命令模板无法执行：${tokenized.error}`,
                                '下一步：把 flakyCommand 改写成不带 shell 语法的 argv 形式（需要管道/重定向就写成一个脚本文件再调用）。',
                            ].join('\n'),
                        )
                    }
                    const outcome = await runCommand(
                        {
                            argv: tokenized.argv,
                            cwd,
                            timeoutMs: config.commandTimeoutMs,
                            maxOutputBytes: config.maxOutputBytes,
                            ...(signal === undefined ? {} : { signal }),
                        },
                        deps.subprocess() as never,
                    )
                    if (outcome.aborted === true || signal?.aborted === true) {
                        return [
                            '⛔ flaky 检查：已取消',
                            `第 ${index} 次运行被 signal 取消：结果不构成裁决，未写入门禁记录（已完成的 ${runs.length} 次运行也不构成结论）。`,
                            '下一步：在未被取消的轮次重跑 flaky_check。',
                        ].join('\n')
                    }
                    runs.push(toRunResult(outcome, index))
                    results.push(gateResultOfRun(`flaky-run-${index}`, `第 ${index} 次运行`, tokenized.argv.join(' '), outcome, config.flakyPolicy === 'block'))
                    const passes = runs.filter((run) => run.exitCode === 0 && run.timedOut !== true).length
                    const failures = runs.length - passes
                    if (passes > 0 && failures > 0 && index < planned) {
                        stoppedEarly = true
                        break
                    }
                }

                const verdict: FlakinessVerdict = detectFlakiness(runs)
                const policy = config.flakyPolicy
                const state: GateState = verdict.flaky ? (policy === 'block' ? 'BLOCK' : 'WARN') : verdict.inconclusive ? 'WARN' : 'PASS'
                const reason = verdict.flaky
                    ? `${verdict.level === 'test' ? 'flaky 用例' : '运行级不稳定'}：${verdict.reason}`
                    : verdict.inconclusive
                      ? `未能判定 flaky：${verdict.reason}`
                      : `稳定：${verdict.reason}`
                const scope: GateScope = {
                    selected: runs.map((run) => `flaky-run-${run.index}`),
                    total: planned,
                    full: runs.length === planned && commandFromHost,
                }

                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined ? {} : { explicitId: args.missionId }),
                })
                const artifact = {
                    kind: 'flaky',
                    at: Date.now(),
                    workspace: cwd,
                    command,
                    commandFromHost,
                    policy,
                    planned,
                    executed: runs.length,
                    stoppedEarly,
                    verdict: { flaky: verdict.flaky, level: verdict.level, inconclusive: verdict.inconclusive, reason: verdict.reason },
                    runs: verdict.comparison.runs,
                    flakyTests: verdict.classification.flaky,
                    stableTests: verdict.classification.stable,
                    inconclusiveTests: verdict.classification.inconclusive,
                    notes: [...notes, ...verdict.classification.notes],
                    state,
                }
                let artifactNote = '(无 mission，未落盘)'
                if (mission !== undefined) {
                    const file = store.writeArtifact(mission.id, path.join('artifacts', 'flaky.json'), `${JSON.stringify(artifact, undefined, 2)}\n`)
                    artifactNote = path.relative(cwd, file)
                }
                let gateId: string | undefined
                if (mission !== undefined && policy !== 'off') {
                    gateId = store.recordGate(mission.id, {
                        source: GATE_SOURCE,
                        state,
                        reason,
                        results,
                        scope,
                        fingerprint: fingerprintOf(cwd, store),
                    }).id
                }
                if (policy !== 'off') {
                    logger.info(
                        `flaky_check: ${state} — ${reason}；运行 ${runs.length}/${planned} 次（${command}）；scope.full=${scope.full}；mission ${mission?.id ?? '(无)'}`,
                    )
                }

                const lines: string[] = []
                lines.push(
                    `${state === 'PASS' ? '✅' : state === 'WARN' ? '⚠️' : '⛔'} flaky 检查：${state}${policy === 'off' ? '（宿主设 flakyPolicy=off：只报告，不写门禁记录）' : ''}`,
                )
                lines.push(`原因：${reason}`)
                lines.push('')
                lines.push(`命令：\`${renderForDisplay(command, { run: 'N', run0: 'N-1', workspace: cwd })}\`（${commandFromHost ? '宿主配置' : '调用参数'}）`)
                lines.push(
                    `运行：${runs.length}/${planned} 次${stoppedEarly ? `（第 ${runs.length} 次后同时观察到通过与失败，已提前结束；原计划 ${planned} 次）` : ''}`,
                )
                for (const run of verdict.comparison.runs) {
                    lines.push(`  - 第 ${run.index} 次：${run.outcome === 'pass' ? '通过' : '失败'}（exit=${run.exitCode ?? 'null'}${run.timedOut ? '，超时' : ''}）`)
                }
                if (verdict.classification.flaky.length > 0) {
                    lines.push(
                        `不稳定用例：${verdict.classification.flaky
                            .map((tally) => `${tally.name}（通过 ${tally.passed} / 失败 ${tally.failed}）`)
                            .join('，')}`,
                    )
                }
                const stableFailing = verdict.classification.stable.filter((tally) => tally.outcome === 'failing')
                if (stableFailing.length > 0) {
                    lines.push(`稳定失败（不是 flaky，是真 bug）：${stableFailing.map((tally) => tally.name).join('，')}`)
                }
                if (verdict.classification.inconclusive.length > 0) {
                    lines.push(`无法判定：${verdict.classification.inconclusive.map((tally) => tally.name).join('，')}`)
                }
                if (notes.length > 0 || verdict.classification.notes.length > 0) {
                    lines.push(renderNotes([...notes, ...verdict.classification.notes]))
                }
                lines.push('')
                lines.push(
                    `策略：flakyPolicy=${policy}（宿主配置），重复上限 ${config.flakyRepeats} 次${
                        policy === 'off' ? '；off 不写门禁记录' : ''
                    }`,
                )
                lines.push(
                    `覆盖范围：${scope.full ? `完整（${runs.length}/${planned} 次）` : `部分（${runs.length}/${planned} 次${stoppedEarly ? '，提前结束' : ''}${
                        commandFromHost ? '' : '；命令由调用参数提供'
                    }）— 不构成完整的交付依据`}`,
                )
                lines.push(`gate record: ${gateId ?? (policy === 'off' ? '(策略 off，未记录)' : '(无 mission，未记录)')}`)
                lines.push(`工件：${artifactNote}`)
                lines.push(
                    verdict.flaky
                        ? '下一步：定位共享状态/时间依赖/随机源/未等待的异步（同一用例多次运行的差异就是线索）；**不要**靠重跑到达标、不要删掉或跳过不稳定的用例——那是在把缺陷藏起来。'
                        : verdict.inconclusive
                          ? `下一步：把重复次数提到至少 ${MIN_FLAKY_REPEATS} 次（配置 flakyRepeats 或传 repeats），否则无法判定。`
                          : '下一步：结果一致说明没观察到不稳定；它不证明没有 flaky（重复次数有限），重要的交付可以再提高 repeats。',
                )
                return lines.join('\n')
            },
        }),
        'flaky_check',
    )

    register(
        defineTool({
            name: 'coverage_status',
            description:
                'Read-only: the coverage thresholds in force and where they come from, whether a coverage command/report and a flaky command are configured, and the newest coverage/flaky gate recorded on the mission with its numbers. Use it before claiming a coverage result, or to see why coverage_check refuses.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to inspect (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const effective = deps.configFor(agent)
                const config = effective.config
                const lines: string[] = []
                lines.push(`配置来源：${describeSource(effective)}${effective.problems.length === 0 ? '' : `（另有 ${effective.problems.length} 条配置问题，见插件日志）`}`)
                const profile = deps.config.thresholds
                lines.push(
                    `阈值：${
                        thresholdKeys(config.thresholds).length === 0
                            ? '⚠️ 没有生效的覆盖率阈值 —— coverage_check 会拒绝执行（没有阈值就没有门禁）'
                            : thresholdKeys(config.thresholds)
                                  .map(
                                      (key) =>
                                          `${key} ≥ ${formatPercent(config.thresholds[key] as number)}（${
                                              effective.source === 'project' && config.thresholds[key] !== profile[key] ? '项目级配置' : 'profile 配置'
                                          }）`,
                                  )
                                  .join('，')
                    }`,
                )
                lines.push(
                    `报告来源：${
                        config.coverageCommand === undefined ? '未配置覆盖率命令' : `命令 \`${config.coverageCommand}\``
                    }${
                        config.reportFile === undefined
                            ? '；未配置 reportFile —— 没有报告来源时 coverage_check 会拒绝执行'
                            : `；reportFile \`${config.reportFile}\`（格式 ${config.reportFormat}）`
                    }`,
                )
                lines.push(
                    `flaky：策略 ${config.flakyPolicy}，重复 ${config.flakyRepeats} 次，命令 ${
                        config.flakyCommand === undefined ? '（未配置 —— flaky_check 会拒绝执行）' : `\`${config.flakyCommand}\``
                    }`,
                )
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined ? {} : { explicitId: args.missionId }),
                })
                if (mission === undefined) {
                    lines.push('mission: (无) — 门禁结果不会被记录到任何 mission。')
                    return lines.join('\n')
                }
                lines.push('')
                lines.push(`mission: ${mission.id}（${mission.status}）`)
                const coverageGate = latestGateOfKind(store, mission.id, 'coverage')
                const flakyGate = latestGateOfKind(store, mission.id, 'flaky')
                lines.push(
                    coverageGate === undefined
                        ? '最新 coverage 门禁：(未运行过)'
                        : `最新 coverage 门禁：${coverageGate.state} @ ${formatTime(coverageGate.checkedAt)} — ${coverageGate.reason}\n  ${describeGateScope(coverageGate)}\n  报告文件：${store.artifactPath(mission.id, path.join('artifacts', 'coverage.json'))}`,
                )
                if (coverageGate !== undefined) {
                    for (const result of coverageGate.results) lines.push(`  - [${result.exitCode === 0 ? 'PASS' : result.exitCode === null ? 'SKIP' : 'FAIL'}] ${result.id}：${result.output}`)
                }
                lines.push(
                    flakyGate === undefined
                        ? '最新 flaky 门禁：(未运行过)'
                        : `最新 flaky 门禁：${flakyGate.state} @ ${formatTime(flakyGate.checkedAt)} — ${flakyGate.reason}\n  ${describeGateScope(flakyGate)}`,
                )
                if (flakyGate !== undefined) {
                    for (const result of flakyGate.results) lines.push(`  - [exit=${result.exitCode ?? 'null'}] ${result.id} ${result.timedOut ? '（超时）' : ''}`)
                }
                const artifactText = store.readArtifact(mission.id, path.join('artifacts', 'coverage.json'))
                if (artifactText !== undefined) {
                    try {
                        const artifact = JSON.parse(artifactText) as {
                            at?: number
                            format?: string
                            totals?: { linesHit?: number; linesFound?: number; percent?: number | null }
                            incremental?: { instrumented?: number; hit?: number; percent?: number | null; judgement?: string }
                            worst?: { path: string; percent: number }[]
                        }
                        lines.push('')
                        // An artifact older than the newest gate means that gate
                        // produced none (a parse failure, a failed command) — the
                        // numbers below describe an EARLIER run and must say so.
                        const stale = artifact.at !== undefined && coverageGate !== undefined && artifact.at < coverageGate.checkedAt
                        lines.push(
                            `最新工件（artifacts/coverage.json @ ${artifact.at === undefined ? '?' : formatTime(artifact.at)}${
                                stale ? '，⚠️ 早于最新门禁：该门禁没有产出新工件（例如报告解析失败），下面是更早一次运行的数字' : ''
                            }）：格式 ${artifact.format ?? '?'}；总覆盖率 ${
                                artifact.totals?.percent === null || artifact.totals?.percent === undefined
                                    ? '无法判定'
                                    : `${formatPercent(artifact.totals.percent)}（${artifact.totals.linesHit ?? 0}/${artifact.totals.linesFound ?? 0}）`
                            }；增量 ${
                                artifact.incremental?.percent === null || artifact.incremental?.percent === undefined
                                    ? `无法判定（插桩 ${artifact.incremental?.instrumented ?? 0} 行，判定 ${artifact.incremental?.judgement ?? '?'}）`
                                    : `${formatPercent(artifact.incremental.percent)}（${artifact.incremental.hit ?? 0}/${artifact.incremental.instrumented ?? 0} 行）`
                            }`,
                        )
                        const worst = (artifact.worst ?? []).slice(0, 3)
                        if (worst.length > 0) {
                            lines.push(`  最差文件：${worst.map((file) => `${file.path} ${formatPercent(file.percent)}`).join('，')}`)
                        }
                    } catch {
                        lines.push('⚠️ artifacts/coverage.json 无法解析（工件被改动过？）')
                    }
                }
                lines.push(
                    '',
                    `配置的阈值键：${thresholdKeys(config.thresholds).join(', ') || '(无)'}；说明：coverage_check 的调用参数可以覆盖阈值与报告文件，但那样的裁决 scope.full=false，不作为交付依据。`,
                )
                return lines.join('\n')
            },
        }),
        'coverage_status',
    )

    return { disposers, registered, failed }
}

/** Build one gate result from a command outcome. */
function gateResultOfRun(
    id: string,
    name: string,
    command: string,
    outcome: RunOutcome,
    required = true,
): GateCommandResult {
    // The exit facts always ride the output: a runner that prints nothing on
    // success would otherwise leave an empty, unreadable gate result.
    const captured = combinedOutput(outcome, 2_000)
    const header = `exit=${outcome.exitCode ?? 'null'}${outcome.timedOut ? '（超时）' : ''}；${outcome.durationMs}ms`
    return {
        id,
        name,
        command,
        required,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        output: captured === '' ? header : `${header}\n${captured}`,
        outputDigest: outputDigestOf(outcome.stdout, outcome.stderr),
    }
}

/** Record a gate when a mission could be resolved; `undefined` otherwise. */
function recordIfMission(
    store: MissionStore,
    agent: AgentLike | undefined,
    explicitId: string | undefined,
    input: {
        state: GateState
        reason: string
        results: GateCommandResult[]
        scope: GateScope
        fingerprint: GitFingerprint
    },
): string | undefined {
    const mission = store.resolveForAgent(agent, { ...(explicitId === undefined ? {} : { explicitId }) })
    if (mission === undefined) return undefined
    return store.recordGate(mission.id, {
        source: GATE_SOURCE,
        state: input.state,
        reason: input.reason,
        results: input.results,
        scope: input.scope,
        fingerprint: input.fingerprint,
    }).id
}

/** The newest recorded gate of one kind (`coverage-*` / `flaky-*` results). */
function latestGateOfKind(store: MissionStore, missionId: string, kind: 'coverage' | 'flaky') {
    return store
        .readGates(missionId)
        .filter((gate) => gate.source === GATE_SOURCE && gate.results.some((result) => result.id.startsWith(`${kind}-`)))
        .sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id))
        .at(-1)
}

/** Coverage line for a recorded gate. */
function describeGateScope(gate: { scope?: GateScope }): string {
    if (gate.scope === undefined) return 'scope: (记录未标注覆盖范围 — 视为未知，不能当作"跑全了")'
    return gate.scope.full
        ? `scope: full（${gate.scope.selected.join(', ') || '无'}/${gate.scope.total}）`
        : `scope: 部分（${gate.scope.selected.join(', ') || '无'}/${gate.scope.total}）— ⚠️ 该裁决不能作为交付依据`
}

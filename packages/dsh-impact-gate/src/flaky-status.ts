/**
 * The read-only `flaky_status` report.
 *
 * Split out of `flaky.ts`: rendering a status report is a different job from
 * judging runs, and keeping the two apart makes each one readable (the renderer
 * pushed the judgement module into nesting it did not need).
 * @module dsh-impact-gate/flaky-status
 */

import {
    expiredQuarantines,
    unseenQuarantines,
    type FlakyPlanSummary,
    type ObservedRun,
    type QuarantineRow,
    type StatusInput,
} from './flaky.js'

/**
 * The quarantine table plus the rows that can no longer be used.
 * @param lines - the report so far (appended to).
 * @param input - the status input.
 */
function renderQuarantines(lines: string[], input: StatusInput): void {
    if (input.quarantined.length === 0) {
        lines.push('', '当前没有任何隔离条目。')
        return
    }
    lines.push('', '| 用例 | owner | 到期 | 理由 | 证据 |', '|------|-------|------|------|------|')
    for (const row of input.quarantined) {
        lines.push(`| ${row.test} | ${row.owner} | ${new Date(row.expiresAt).toISOString()} | ${row.reason || '—'} | ${row.evidencePath || '—'} |`)
    }
}

/**
 * The overdue quarantines and the ledger rows that could not be read.
 * @param lines - the report so far (appended to).
 * @param input - the status input.
 */
function renderOverdue(lines: string[], input: StatusInput): void {
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
}

/**
 * The "possibly lost coverage" list, judged from the runs that NAMED their cases.
 * @param lines - the report so far (appended to).
 * @param quarantined - the live quarantines.
 * @param runs - the runs the newest plan observed.
 * @param threshold - how many consecutive runs count as "not seen".
 */
function renderUnseenNamed(lines: string[], quarantined: readonly QuarantineRow[], runs: readonly ObservedRun[], threshold: number): void {
    const unseen = unseenQuarantines(quarantined, runs, threshold)
    if (unseen.length === 0) {
        lines.push(`  "最近 ${threshold} 次运行没出现"检查：通过（所有隔离用例都还在被点名）。`)
        return
    }
    lines.push(`  ⚠️ 可能悄悄丢失的覆盖（最近 ${threshold} 次运行都没点名）：`)
    for (const row of unseen) {
        lines.push(`    - ${row.test}（owner=${row.owner}）：隔离后被删除/改名/跳过了？覆盖正在静默消失——要么恢复它，要么把隔离条目一起删掉。`)
    }
}

/**
 * The "possibly lost coverage" list, judged from the report's per-test COUNTS.
 *
 * Report mode carries no per-run names, so the counts ARE the observed set; a
 * nameless run alone proves nothing.
 * @param lines - the report so far (appended to).
 * @param quarantined - the live quarantines.
 * @param tallies - the per-test counts the report carried.
 * @param window - how many runs those counts cover.
 */
function renderUnseenCounted(lines: string[], quarantined: readonly QuarantineRow[], tallies: readonly { name: string; runs: number }[], window: number): void {
    const observed = new Set(tallies.filter((tally) => tally.runs >= window).map((tally) => tally.name))
    const unseen = quarantined.filter((row) => !observed.has(row.test)).sort((left, right) => left.test.localeCompare(right.test))
    if (unseen.length === 0) {
        lines.push(
            `  "最近 ${window} 次运行没出现"检查：通过（报告没有逐次点名，但 ${tallies.length} 条用例计数的观察窗口是 ${window} 次运行，每一条隔离用例都在里面）。`,
        )
        return
    }
    lines.push(`  ⚠️ 隔离用例在报告的用例计数里没有覆盖全部 ${window} 次运行（报告模式只有计数，没有逐次点名）：`)
    for (const row of unseen) {
        const tally = tallies.find((candidate) => candidate.name === row.test)
        const what =
            tally === undefined
                ? `报告的 ${window} 次运行里完全没有它——隔离后被删除/改名/跳过了？覆盖正在静默消失：要么恢复它，要么把隔离条目一起删掉`
                : `报告里只在 ${tally.runs}/${window} 次运行里被点名（其他运行没有它：可能被跳过或条件执行）`
        lines.push(`    - ${row.test}（owner=${row.owner}）：${what}。`)
    }
}

/**
 * The newest plan's section: what it classified and whether coverage may be lost.
 * @param lines - the report so far (appended to).
 * @param newest - the plan summary to render.
 * @param input - the status input (quarantines, settings).
 */
function renderNewestPlan(lines: string[], newest: FlakyPlanSummary, input: StatusInput): void {
    lines.push(
        `最近计划：${newest.relative}${newest.generatedAt === undefined ? '' : `（${newest.generatedAt}）`}` +
            (newest.problem === undefined ? '' : ` — ${newest.problem}`),
    )
    if (newest.summary !== undefined) {
        const summary = newest.summary
        lines.push(
            `  分类：稳定 ${summary.stable}、隔离 ${summary.quarantine}、查根因 ${summary.investigate}、疑似仪器/环境 ${summary.suspectInstrumentation}`,
        )
    }
    // The plan's own caveats are the difference between "this test is gone"
    // and "this report cannot say": dropping them would turn a limitation of
    // the data into an accusation.
    for (const note of newest.notes ?? []) lines.push(`  说明：${note}`)
    const runs = newest.runs
    const threshold = input.settings.unseenRunsBeforeWarn
    // Report mode carries per-test TALLIES, not per-run names. Reading a
    // nameless run as "nothing was observed" accused every quarantined test —
    // including the ones the same report proves ran in every run. The tallies
    // ARE the observed set in that mode; a nameless run alone proves nothing.
    const tallies = newest.observedTests ?? []
    const namedRuns = runs.filter((run) => run.named.length > 0)
    const tallyWindow = tallies.reduce((max, tally) => Math.max(max, tally.runs), 0)
    const window = namedRuns.length > 0 ? runs.length : Math.max(runs.length, tallyWindow)
    if (window < threshold) {
        lines.push(
            runs.length === 0 && tallyWindow === 0
                ? `  该计划没有携带逐用例结果（报告只有运行级退出码）：无法判断"最近 ${threshold} 次运行没出现"——**不能**因此说覆盖正在消失。`
                : `  该计划只有 ${window} 次运行（少于阈值 ${threshold}）：暂不判定"消失"，先积累运行记录。`,
        )
        return
    }
    if (namedRuns.length > 0) renderUnseenNamed(lines, input.quarantined, runs, threshold)
    else renderUnseenCounted(lines, input.quarantined, tallies, window)
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
    renderQuarantines(lines, input)
    renderOverdue(lines, input)
    lines.push('')
    if (input.newest === undefined) {
        lines.push(`最近计划：（无${input.plansSeen === 0 ? '' : '，产物无法读取'}）— 没有计划产物就无法判断"被隔离的用例最近有没有出现"。`)
    } else {
        renderNewestPlan(lines, input.newest, input)
    }
    lines.push(
        '',
        input.missionId === undefined
            ? '下一步：没有 mission，计划不会落盘；先建任务（spec_create）或省略 missionId 之外的参数重试。'
            : '下一步：隔离到期前复查（`flaky_plan` 重跑取新数据，本工具只读）；要新增隔离由人执行计划里渲染的命令，本插件不会自己写台账。',
    )
    return lines.join('\n')
}

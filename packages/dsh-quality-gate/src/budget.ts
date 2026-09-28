/**
 * Budgets: "this number must not get worse".
 *
 * The quality gate answers "did the commands pass". That is not the same
 * question as "did something regress": a suite that passes after its command got
 * three times slower, a bundle that doubled, a migration that stopped being
 * reversible — all of those are green. A *budget* is the missing half: a
 * host-configured number with a bound, measured from a host-configured command,
 * recorded as history so the NEXT run is compared against the best run ever
 * recorded.
 *
 * Four fixed rules keep this honest:
 *
 *  1. **A number that could not be measured is a refusal, never a pass.** A
 *     regex that matches nothing, or a capture that does not parse, refuses the
 *     call naming the budget and the command (`0` is a value; "no value" is not,
 *     and nothing is written);
 *  2. **A command that did not succeed is not a measurement.** A non-zero exit,
 *     a timeout or a spawn error BLOCKs that budget: a duration taken from a
 *     crashed run says nothing about performance;
 *  3. **Comparisons are against the BEST recorded value, not the last one.** The
 *     history is append-only, so a bad run can never loosen the bar it is judged
 *     against (`maxRegressionPercent` is a ratchet, not a moving average). A
 *     budget with no history yet records its baseline and says so — "no data
 *     yet", explicitly not a pass;
 *  4. **Only accepted measurements enter the baseline.** A value that violated
 *     its absolute bound was never accepted, so it is reported but not recorded.
 *
 * The regression message always names WHICH recorded value it compared against
 * and when that value was taken: "变慢了" without the reference point is not
 * actionable.
 *
 * @module dsh-quality-gate/budget
 */

import path from 'node:path'
import {
    exists,
    formatTime,
    outputDigestOf,
    readJson,
    runCommand,
    splitCommand,
    tail,
    writeJsonAtomic,
    type GateCommandResult,
    type GateScope,
    type GateState,
    type RunOutcome,
    type RunSpec,
} from 'dsh-eng-core'
import type { GateCommandConfig, QualityGateConfig } from './config.js'

/** How a budget's number is obtained. */
export type BudgetMetric = 'durationMs' | 'number' | 'bytes'

/** One host-configured budget. */
export interface BudgetConfig {
    /** Stable id (also the key of its baseline history). */
    id: string
    /** Human-readable name shown in reports. */
    name: string
    /** What is measured: the command's wall time, or a number from its output. */
    metric: BudgetMetric
    /** The exact command line (tokenised without a shell). */
    command?: string
    /** Id of a configured gate command to measure instead of a literal one. */
    commandId?: string
    /** Pattern extracting the number (first capturing group) from the output. */
    regex?: string
    /** Display unit (`ms` / `count` / `bytes` by default). */
    unit?: string
    /** Upper bound: the value must be ≤ `max`. Also means "lower is better". */
    max?: number
    /** Lower bound: the value must be ≥ `min`. (With no `max`: higher is better.) */
    min?: number
    /** Allowed regression against the best recorded value, in percent. */
    maxRegressionPercent?: number
    /** Baseline history file override (default `<rootDir>/budgets.json`). */
    baselineFile?: string
}

/** One recorded measurement in a budget's append-only history. */
export interface BaselineEntry {
    /** Epoch milliseconds the measurement was taken. */
    at: number
    value: number
    metric: BudgetMetric
    unit: string
    /** The command line that produced it. */
    command: string
    exitCode: number | null
}

/** The baseline file: one append-only history per budget id. */
export interface BudgetBaselineFile {
    version: 1
    budgets: Record<string, BaselineEntry[]>
}

/** One individually reported expectation of a budget. */
export interface BudgetCheck {
    /** `上限` / `下限` / `回归` / `命令退出码`. */
    name: string
    state: 'PASS' | 'FAIL' | 'UNJUDGED'
    detail: string
}

/** The evaluated result of one budget. */
export interface BudgetEvaluation {
    id: string
    name: string
    metric: BudgetMetric
    unit: string
    /** The measured number; absent when the command produced none. */
    value?: number
    command: string
    exitCode: number | null
    durationMs: number
    timedOut: boolean
    state: 'PASS' | 'BLOCK'
    /** One-line, machine-stable reason (also goes into the gate record). */
    reason: string
    checks: BudgetCheck[]
    baseline: {
        file: string
        /** `true` when this run appended a new history entry. */
        recorded: boolean
        /** How many measurements existed BEFORE this run. */
        history: number
        /** The recorded value the regression check compared against. */
        comparedValue?: number
        comparedAt?: number
        /** 1-based position of that value in the history. */
        comparedRun?: number
    }
}

/** The resolved command a budget measures. */
export interface BudgetTarget {
    command: string
    cwd: string
    timeoutMs: number
    env?: Record<string, string>
    source: 'command' | 'commandId'
}

/** Options for {@link runBudgets}. */
export interface BudgetRunOptions {
    cwd: string
    config: QualityGateConfig
    /** The engineering-trail root (`store.layout.rootDir`) the default baseline lives in. */
    rootDir: string
    /** Restrict to these budget ids. */
    only?: readonly string[]
    /** Injected clock (the recorded timestamp; tests). */
    now?: () => number
    /** Injected command runner; defaults to `dsh-eng-core`'s `runCommand`. */
    runner?: (spec: RunSpec, service?: unknown) => Promise<RunOutcome>
    /** `ctx.subprocess`, when the host provides it. */
    service?: unknown
    /** Cancellation (the turn signal). */
    signal?: AbortSignal
}

/**
 * The outcome of one budget run.
 *
 * A refusal (`ok: false`) is NOT a verdict: the caller must not record a gate
 * and must not append anything to the baseline. Nothing was judged, so nothing
 * may be written.
 */
export type BudgetRun =
    | {
          ok: true
          evaluations: BudgetEvaluation[]
          state: GateState
          reason: string
          results: GateCommandResult[]
          scope: GateScope
          /** Baseline files this run read (and, when measured, appended to). */
          baselineFiles: string[]
          /** How many measurements were appended to a history. */
          recorded: number
      }
    | { ok: false; problem: string }

const METRICS: readonly BudgetMetric[] = ['durationMs', 'number', 'bytes']

/** The default display unit of a metric. */
export function defaultUnit(metric: BudgetMetric): string {
    return metric === 'durationMs' ? 'ms' : metric === 'bytes' ? 'bytes' : 'count'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse one configured budget.
 *
 * This NEVER drops an entry silently: a malformed budget is kept (best-effort
 * coerced) with a `problem` attached, and {@link preflightBudgets} refuses the
 * whole run when it sees one. Dropping a rule would be the worst outcome — the
 * report would look green because the rule no longer exists.
 * @param input - the untrusted config entry.
 * @param index - position, used to build a fallback id.
 * @returns the budget (always a usable shape) plus the problem, when any.
 */
export function parseBudget(input: unknown, index: number): { budget: BudgetConfig; problem?: string } {
    if (!isRecord(input)) {
        return {
            budget: { id: `budget-${index + 1}`, name: `budget-${index + 1}`, metric: 'durationMs' },
            problem: `budgets[${index}]: 必须是对象（收到 ${JSON.stringify(input)}）`,
        }
    }
    const id = optionalText(input['id']) ?? `budget-${index + 1}`
    const problems: string[] = []
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) problems.push(`budgets[${index}].id "${id}" 不合法（只能字母数字与 - _，以字母数字开头）`)

    const rawMetric = input['metric']
    const known = METRICS.includes(rawMetric as BudgetMetric)
    if (!known) {
        problems.push(`budgets[${index}] (${id}).metric 必须是 ${METRICS.join(' / ')} 之一（收到 ${JSON.stringify(rawMetric)}）`)
    }
    const command = optionalText(input['command'])
    const commandId = optionalText(input['commandId'])
    const regex = optionalText(input['regex'])
    const unit = optionalText(input['unit'])
    const baselineFile = optionalText(input['baselineFile'])
    const budget: BudgetConfig = {
        id,
        name: optionalText(input['name']) ?? id,
        metric: known ? (rawMetric as BudgetMetric) : 'durationMs',
        ...(command === undefined ? {} : { command }),
        ...(commandId === undefined ? {} : { commandId }),
        ...(regex === undefined ? {} : { regex }),
        ...(unit === undefined ? {} : { unit }),
        ...(baselineFile === undefined ? {} : { baselineFile }),
    }
    const takeBound = (key: 'max' | 'min' | 'maxRegressionPercent'): void => {
        if (input[key] === undefined) return
        const value = optionalNumber(input[key])
        if (value === undefined) {
            problems.push(`budgets[${index}] (${id}).${key} 必须是有限数字（收到 ${JSON.stringify(input[key])}）`)
            return
        }
        if (key === 'maxRegressionPercent' && value < 0) {
            problems.push(`budgets[${index}] (${id}).maxRegressionPercent 不能是负数（收到 ${value}）`)
            return
        }
        budget[key] = value
    }
    takeBound('max')
    takeBound('min')
    takeBound('maxRegressionPercent')
    if (regex !== undefined) {
        try {
            new RegExp(regex)
        } catch (error) {
            problems.push(`budgets[${index}] (${id}).regex 不是合法正则（${error instanceof Error ? error.message : String(error)}）：${regex}`)
        }
    }
    if (input['expect'] !== undefined) {
        // A copy/paste from a contract entry: say so instead of ignoring it.
        problems.push(`budgets[${index}] (${id}).expect 不属于预算（预算只有 max / min / maxRegressionPercent 三种界限）`)
    }
    return problems.length === 0 ? { budget } : { budget, problem: problems.join('；') }
}

/** Resolve the command a budget measures, or name what it is missing. */
export function resolveTarget(
    budget: BudgetConfig,
    config: QualityGateConfig,
    cwd: string,
): { target: BudgetTarget } | { problem: string } {
    if (budget.command !== undefined && budget.commandId !== undefined) {
        return {
            problem:
                `预算 "${budget.id}" 同时声明了 command 和 commandId：二选一（commandId 继承该门禁命令的 cwd / 超时 / env；` +
                `command 是这条预算自己的命令）。下一步：删掉其中一个。`,
        }
    }
    if (budget.commandId !== undefined) {
        const configured: GateCommandConfig | undefined = config.commands.find((command) => command.id === budget.commandId)
        if (configured === undefined) {
            return {
                problem:
                    `预算 "${budget.id}" 引用了不存在的门禁命令 "${budget.commandId}"：可用的命令 id 是 ` +
                    `${config.commands.map((command) => command.id).join(', ') || '(无)'}。` +
                    `下一步：把 commandId 改成上面某一个，或在预算里直接写 command。`,
            }
        }
        return {
            target: {
                command: configured.command,
                cwd: configured.cwd === undefined ? cwd : path.resolve(cwd, configured.cwd),
                timeoutMs: configured.timeoutMs,
                ...(configured.env === undefined ? {} : { env: configured.env }),
                source: 'commandId',
            },
        }
    }
    if (budget.command !== undefined) {
        return { target: { command: budget.command, cwd, timeoutMs: config.defaultTimeoutMs, source: 'command' } }
    }
    return {
        problem:
            `预算 "${budget.id}" 没有声明 command 或 commandId：它要测什么无从得知（缺配置绝不能悄悄变成"通过"）。` +
            `下一步：在预算里写 command（例如 "node scripts/bundle-size.mjs"），或写 commandId 指向 config.commands 里已有的命令` +
            `（可用：${config.commands.map((command) => command.id).join(', ') || '(无)'}）。`,
    }
}

/**
 * Validate every selected budget BEFORE anything runs.
 *
 * All problems are returned at once so an operator fixes them in one pass, and
 * a defect refuses the whole call: a run that judged only "the budgets that
 * happened to be valid" would read like a verdict on all of them.
 */
export function preflightBudgets(budgets: readonly BudgetConfig[], config: QualityGateConfig, cwd: string): string[] {
    const problems: string[] = []
    for (const budget of budgets) {
        const resolved = resolveTarget(budget, config, cwd)
        if ('problem' in resolved) problems.push(resolved.problem)
        if (budget.metric !== 'durationMs' && budget.regex === undefined) {
            problems.push(
                `预算 "${budget.id}" 的 metric=${budget.metric} 需要 regex：数字只从命令输出里按你给的正则取（第一个捕获组）。` +
                    `下一步：写 regex（例如 "size=(\\\\d+)"），或把 metric 改成 durationMs 直接测命令耗时。`,
            )
        }
        if (budget.metric === 'durationMs' && budget.regex !== undefined) {
            problems.push(
                `预算 "${budget.id}" 同时声明了 metric=durationMs 与 regex：durationMs 测的是命令的墙钟时间，与输出无关。` +
                    `下一步：要解析输出里的数字请用 metric: number（并写清 unit）。`,
            )
        }
    }
    return problems
}

/** Select the budgets a run should measure (`only` names budget ids). */
export function selectBudgets(config: QualityGateConfig, only?: readonly string[]): { budgets: BudgetConfig[] } | { problem: string } {
    if (only === undefined || only.length === 0) return { budgets: [...config.budgets] }
    const known = new Set(config.budgets.map((budget) => budget.id))
    const unknown = only.filter((id) => !known.has(id))
    if (unknown.length > 0) {
        return {
            problem:
                `请求的预算不存在：${unknown.join(', ')}（可用：${config.budgets.map((budget) => budget.id).join(', ') || '(无)'}）。` +
                `下一步：用 budget_check 的 only 只选已配置的预算 id，或把该预算写进 quality-gate 的 config.budgets。`,
        }
    }
    return { budgets: config.budgets.filter((budget) => only.includes(budget.id)) }
}

/** The baseline file one budget records into. */
export function baselineFileFor(budget: BudgetConfig, options: { cwd: string; rootDir: string }): string {
    if (budget.baselineFile === undefined) return path.join(options.rootDir, 'budgets.json')
    return path.isAbsolute(budget.baselineFile) ? budget.baselineFile : path.resolve(options.cwd, budget.baselineFile)
}

/** One budget's history, or the reason it cannot be read. */
export interface BaselineRead {
    entries: BaselineEntry[]
    /** Set when the file exists but cannot be used — the caller must refuse. */
    problem?: string
}

/**
 * Read one budget's recorded history.
 *
 * A MISSING file is "no history yet" (the first run legitimately has none). A
 * file that exists but cannot be parsed is a REFUSAL: reading it as "no
 * history" would silently drop the regression guard and turn this run into a
 * green first run.
 */
export function readBaseline(file: string, budgetId: string): BaselineRead {
    if (!exists(file)) return { entries: [] }
    const parsed = readJson<BudgetBaselineFile>(file)
    if (parsed === undefined) {
        return {
            entries: [],
            problem:
                `基线文件 ${file} 存在但无法解析为 JSON：按 fail closed 拒绝判定（当成"没有历史"会让预算悄悄失去回归护栏）。` +
                `下一步：修复该文件，或删掉它重新记录基线。`,
        }
    }
    const budgets = (parsed as { budgets?: unknown }).budgets
    if (budgets !== undefined && !isRecord(budgets)) {
        return {
            entries: [],
            problem: `基线文件 ${file} 的 "budgets" 字段必须是对象（每个预算 id 一个历史数组）。下一步：修复该文件，或删掉它重新记录基线。`,
        }
    }
    const entries = isRecord(budgets) ? budgets[budgetId] : undefined
    if (entries === undefined) return { entries: [] }
    if (!Array.isArray(entries)) {
        return {
            entries: [],
            problem: `基线文件 ${file} 里 "${budgetId}" 的历史必须是数组。下一步：修复该文件，或删掉该键重新记录基线。`,
        }
    }
    const usable: BaselineEntry[] = []
    for (const entry of entries) {
        if (isRecord(entry) && typeof entry['value'] === 'number' && Number.isFinite(entry['value']) && typeof entry['at'] === 'number') {
            usable.push({
                at: entry['at'],
                value: entry['value'],
                metric: entry['metric'] as BudgetMetric,
                unit: typeof entry['unit'] === 'string' ? entry['unit'] : '',
                command: typeof entry['command'] === 'string' ? entry['command'] : '',
                exitCode: typeof entry['exitCode'] === 'number' ? entry['exitCode'] : null,
            })
        }
    }
    return { entries: usable }
}

/** Append one measurement to a budget's history (read-modify-write, atomic). */
export function appendBaseline(file: string, budgetId: string, entry: BaselineEntry): void {
    const current = readJson<BudgetBaselineFile>(file)
    const previous = isRecord(current?.budgets) ? (current?.budgets as Record<string, BaselineEntry[]>) : {}
    const history = Array.isArray(previous[budgetId]) ? (previous[budgetId] as BaselineEntry[]) : []
    writeJsonAtomic(file, {
        version: 1,
        budgets: { ...previous, [budgetId]: [...history, entry] },
    } satisfies BudgetBaselineFile)
}

/** The number a `regex` extracted from a command's output. */
export type Extracted =
    | { ok: true; value: number; raw: string }
    | { ok: false; kind: 'no-match' }
    | { ok: false; kind: 'unparsable'; raw: string }

/**
 * Extract a number from a command's output.
 *
 * The FIRST CAPTURING GROUP is the number (the whole match only when the
 * pattern declares no group); it must parse as a finite number on its own —
 * `12.3kB`, `1,200` and `n/a` are refusals, not `12.3`, `1` and `0`.
 * @param pattern - the budget's compiled pattern.
 * @param text - the command's captured output (stdout + stderr).
 */
export function extractNumber(pattern: RegExp, text: string): Extracted {
    const match = pattern.exec(text)
    if (match === null) return { ok: false, kind: 'no-match' }
    const raw = (match[1] ?? match[0] ?? '').trim()
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return { ok: false, kind: 'unparsable', raw }
    const value = Number(raw)
    if (!Number.isFinite(value)) return { ok: false, kind: 'unparsable', raw }
    return { ok: true, value, raw }
}

/** `true` when smaller values are better (a `max` bound, or neither bound). */
export function lowerIsBetter(budget: BudgetConfig): boolean {
    return budget.max !== undefined || budget.min === undefined
}

/** The best recorded value, its 1-based position and its timestamp. */
export interface BestRecorded {
    value: number
    at: number
    run: number
}

/** Pick the best recorded value: the minimum, or the maximum when higher is better. */
export function bestRecorded(entries: readonly BaselineEntry[], lower: boolean): BestRecorded | undefined {
    let best: BestRecorded | undefined
    for (const [index, entry] of entries.entries()) {
        if (best === undefined || (lower ? entry.value < best.value : entry.value > best.value)) {
            best = { value: entry.value, at: entry.at, run: index + 1 }
        }
    }
    return best
}

/** What the regression comparison concluded. */
export interface RegressionVerdict {
    state: 'PASS' | 'FAIL' | 'NO-HISTORY'
    detail: string
    best?: BestRecorded
    /** The value beyond which the budget is violated. */
    limit?: number
    /** How much worse this run is, in percent of the best value. */
    percent?: number
}

/**
 * Compare one measurement against a budget's recorded history.
 * @param budget - the budget (its bound decides the direction).
 * @param value - this run's measurement.
 * @param entries - the history recorded BEFORE this run.
 */
export function compareRegression(budget: BudgetConfig, value: number, entries: readonly BaselineEntry[]): RegressionVerdict {
    const percent = budget.maxRegressionPercent
    if (percent === undefined) {
        return { state: 'PASS', detail: '未声明 maxRegressionPercent：这条预算只判绝对上下限' }
    }
    const unit = budget.unit ?? defaultUnit(budget.metric)
    const lower = lowerIsBetter(budget)
    const best = bestRecorded(entries, lower)
    if (best === undefined) {
        return {
            state: 'NO-HISTORY',
            detail: `基线已记录：本次 ${value} ${unit} 是第 1 次测量，此前没有可比的历史值（回归判定从下一次开始）`,
        }
    }
    const reference = `历史最佳 ${best.value} ${unit}（第 ${best.run} 次记录，${formatTime(best.at)}）`
    if (lower) {
        const limit = best.value * (1 + percent / 100)
        if (best.value === 0) {
            return value > 0
                ? {
                      state: 'FAIL',
                      detail: `${reference} 为 0：本次 ${value} 从 0 增长，任何增长都算变差（允许的 ${percent}% 在 0 上无法按比例计算）`,
                      best,
                      limit: 0,
                      percent: Number.POSITIVE_INFINITY,
                  }
                : { state: 'PASS', detail: `与${reference}持平（本次 ${value}）`, best, limit: 0, percent: 0 }
        }
        const worseBy = ((value - best.value) / Math.abs(best.value)) * 100
        return value > limit
            ? {
                  state: 'FAIL',
                  detail: `本次 ${value} ${unit} 比${reference}变差 ${worseBy.toFixed(1)}%，超过允许的 ${percent}%（阈值 ${limit.toFixed(2)}）`,
                  best,
                  limit,
                  percent: worseBy,
              }
            : {
                  state: 'PASS',
                  detail: `本次 ${value} ${unit} 对${reference}：变化 ${worseBy.toFixed(1)}%，在允许的 ${percent}% 内`,
                  best,
                  limit,
                  percent: worseBy,
              }
    }
    const limit = best.value * (1 - percent / 100)
    const worseBy = ((best.value - value) / Math.abs(best.value || 1)) * 100
    return value < limit
        ? {
              state: 'FAIL',
              detail: `本次 ${value} ${unit} 比${reference}变差 ${worseBy.toFixed(1)}%（更小即更差），超过允许的 ${percent}%（阈值 ${limit.toFixed(2)}）`,
              best,
              limit,
              percent: worseBy,
          }
        : {
              state: 'PASS',
              detail: `本次 ${value} ${unit} 对${reference}：变化 ${worseBy.toFixed(1)}%，在允许的 ${percent}% 内`,
              best,
              limit,
              percent: worseBy,
          }
}

/** Judge one measured value: absolute bounds first, then the regression. */
export function evaluateMeasurement(budget: BudgetConfig, value: number, entries: readonly BaselineEntry[]): BudgetCheck[] {
    const unit = budget.unit ?? defaultUnit(budget.metric)
    const checks: BudgetCheck[] = []
    if (budget.max !== undefined) {
        checks.push({
            name: `上限 ≤ ${budget.max} ${unit}`,
            state: value <= budget.max ? 'PASS' : 'FAIL',
            detail: value <= budget.max ? `本次 ${value} ≤ ${budget.max}` : `本次 ${value} > ${budget.max}：超过上限 ${(value - budget.max).toFixed(2)}`,
        })
    }
    if (budget.min !== undefined) {
        checks.push({
            name: `下限 ≥ ${budget.min} ${unit}`,
            state: value >= budget.min ? 'PASS' : 'FAIL',
            detail: value >= budget.min ? `本次 ${value} ≥ ${budget.min}` : `本次 ${value} < ${budget.min}：低于下限 ${(budget.min - value).toFixed(2)}`,
        })
    }
    const regression = compareRegression(budget, value, entries)
    checks.push({
        name:
            budget.maxRegressionPercent === undefined
                ? '回归（未声明 maxRegressionPercent，不判）'
                : `回归 ≤ ${budget.maxRegressionPercent}%（相对历史最佳）`,
        state: regression.state === 'FAIL' ? 'FAIL' : 'PASS',
        detail: regression.detail,
    })
    return checks
}

/** Whether the absolute bounds hold (a violating value is not a baseline). */
function boundsHold(budget: BudgetConfig, value: number): boolean {
    if (budget.max !== undefined && value > budget.max) return false
    if (budget.min !== undefined && value < budget.min) return false
    return true
}

/** Everything one budget's measurement produced. */
type Measured = { ok: true; evaluation: BudgetEvaluation } | { ok: false; problem: string }

/** Run one budget's command and judge what it produced. */
async function measureBudget(
    budget: BudgetConfig,
    target: BudgetTarget,
    config: QualityGateConfig,
    options: {
        entries: readonly BaselineEntry[]
        baselineFile: string
        runner: (spec: RunSpec, service?: unknown) => Promise<RunOutcome>
        service?: unknown
        signal?: AbortSignal
    },
): Promise<Measured> {
    const outcome = await options.runner(
        {
            argv: splitCommand(target.command),
            cwd: target.cwd,
            timeoutMs: target.timeoutMs,
            maxOutputBytes: config.maxOutputBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(target.env === undefined ? {} : { env: target.env }),
        },
        options.service,
    )
    const output = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n--- stderr ---\n')
    const unit = budget.unit ?? defaultUnit(budget.metric)

    if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnError !== undefined || outcome.aborted === true) {
        const why =
            outcome.aborted === true
                ? '运行已取消（signal 已 abort）'
                : outcome.timedOut
                  ? `命令超时（${target.timeoutMs}ms）`
                  : outcome.spawnError !== undefined
                    ? `命令无法启动：${outcome.spawnError}`
                    : `命令退出码 ${outcome.exitCode ?? 'null'}`
        // A command that did not succeed is not a measurement: the budget is
        // BLOCKed (recorded), but nothing enters the baseline.
        return {
            ok: true,
            evaluation: {
                id: budget.id,
                name: budget.name,
                metric: budget.metric,
                unit,
                command: target.command,
                exitCode: outcome.exitCode,
                durationMs: outcome.durationMs,
                timedOut: outcome.timedOut,
                state: 'BLOCK',
                reason: `命令没有成功执行（${why}）：本次没有测到任何数字，预算判 BLOCK（也不写入基线）`,
                checks: [
                    { name: '命令退出码', state: 'FAIL', detail: `${why}；命令：${target.command}` },
                    { name: '数值判定', state: 'UNJUDGED', detail: '命令没有产出可用的测量值，界限与回归都无法判定' },
                ],
                baseline: { file: options.baselineFile, recorded: false, history: options.entries.length },
            },
        }
    }

    if (budget.metric === 'durationMs') {
        const checks = evaluateMeasurement(budget, outcome.durationMs, options.entries)
        const regression = compareRegression(budget, outcome.durationMs, options.entries)
        const accepted = boundsHold(budget, outcome.durationMs)
        const failed = checks.filter((check) => check.state === 'FAIL')
        return {
            ok: true,
            evaluation: {
                id: budget.id,
                name: budget.name,
                metric: budget.metric,
                unit,
                value: outcome.durationMs,
                command: target.command,
                exitCode: outcome.exitCode,
                durationMs: outcome.durationMs,
                timedOut: false,
                state: failed.length === 0 ? 'PASS' : 'BLOCK',
                reason:
                    failed.length === 0
                        ? `命令耗时 ${outcome.durationMs} ${unit}${regression.state === 'NO-HISTORY' ? '；基线已记录（本次是第 1 次测量）' : ''}`
                        : failed.map((check) => check.detail).join('；'),
                checks,
                baseline: {
                    file: options.baselineFile,
                    recorded: accepted,
                    history: options.entries.length,
                    ...(regression.best === undefined
                        ? {}
                        : { comparedValue: regression.best.value, comparedAt: regression.best.at, comparedRun: regression.best.run }),
                },
            },
        }
    }

    // `preflightBudgets` guarantees a compilable pattern here.
    const extracted = extractNumber(new RegExp(budget.regex as string), output)
    if (!extracted.ok) {
        // Unmeasurable: a refusal, never a silent pass and never a 0.
        return {
            ok: false,
            problem:
                extracted.kind === 'no-match'
                    ? [
                          `预算 "${budget.id}"（${budget.name}）无法判定：正则没有匹配到任何数字——测不到数字就是拒绝，不是"通过"。`,
                          `- 命令：${target.command}`,
                          `- 正则：/${budget.regex ?? ''}/`,
                          `- 命令输出尾部：${tail(output.trim(), 400) || '(空)'}`,
                          '下一步：把 regex 对齐这条命令的真实输出格式（第一个捕获组必须是纯数字），然后重跑 budget_check；本次没有写入基线，也没有记录门禁。',
                      ].join('\n')
                    : [
                          `预算 "${budget.id}"（${budget.name}）无法判定：正则捕获到的内容不是数字（${JSON.stringify(extracted.raw)}）——按拒绝处理，绝不退化成 0。`,
                          `- 命令：${target.command}`,
                          `- 正则：/${budget.regex ?? ''}/（第一个捕获组必须是 123 / 12.5 / -3 这类写法）`,
                          '下一步：调整 regex（只捕获数字本身，单位别放进捕获组），然后重跑 budget_check；本次没有写入基线，也没有记录门禁。',
                      ].join('\n'),
        }
    }
    const value = extracted.value
    const checks = evaluateMeasurement(budget, value, options.entries)
    const regression = compareRegression(budget, value, options.entries)
    const accepted = boundsHold(budget, value)
    const failed = checks.filter((check) => check.state === 'FAIL')
    return {
        ok: true,
        evaluation: {
            id: budget.id,
            name: budget.name,
            metric: budget.metric,
            unit,
            value,
            command: target.command,
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
            timedOut: false,
            state: failed.length === 0 ? 'PASS' : 'BLOCK',
            reason:
                failed.length === 0
                    ? `测得 ${value} ${unit}${regression.state === 'NO-HISTORY' ? '；基线已记录（本次是第 1 次测量）' : ''}`
                    : failed.map((check) => check.detail).join('；'),
            checks,
            baseline: {
                file: options.baselineFile,
                recorded: accepted,
                history: options.entries.length,
                ...(regression.best === undefined
                    ? {}
                    : { comparedValue: regression.best.value, comparedAt: regression.best.at, comparedRun: regression.best.run }),
            },
        },
    }
}

/**
 * Measure every selected budget and build the gate rows.
 *
 * Nothing is written before EVERY budget has been judged: a refusal (a missing
 * command, an unreadable baseline, a regex that matched nothing) leaves the
 * workspace untouched, so a failed call can never leave a half-recorded bar
 * behind.
 * @param options - workspace, configuration, selection and transport.
 */
export async function runBudgets(options: BudgetRunOptions): Promise<BudgetRun> {
    const config = options.config
    const now = options.now ?? (() => Date.now())
    const runner = options.runner ?? runCommand
    const selected = selectBudgets(config, options.only)
    if ('problem' in selected) return { ok: false, problem: selected.problem }
    const budgets = selected.budgets
    if (budgets.length === 0) {
        return {
            ok: false,
            problem:
                '没有配置任何预算（config.budgets 为空）：预算门禁无法证明任何东西。' +
                '下一步：在 quality-gate 的 config.budgets 里声明至少一条，例如 ' +
                '{"id":"bundle","name":"前端包体积","metric":"bytes","command":"node scripts/size.mjs","regex":"size=(\\\\d+)","max":200000,"maxRegressionPercent":10}。',
        }
    }
    const problems = preflightBudgets(budgets, config, options.cwd)
    if (problems.length > 0) {
        return {
            ok: false,
            problem: [
                `预算配置有 ${problems.length} 处无法执行（没有跑任何命令，也没有写入基线）：`,
                ...problems.map((problem) => `- ${problem}`),
            ].join('\n'),
        }
    }

    const evaluations: BudgetEvaluation[] = []
    const pending: { file: string; budgetId: string; entry: BaselineEntry }[] = []
    for (const budget of budgets) {
        const resolved = resolveTarget(budget, config, options.cwd)
        if ('problem' in resolved) return { ok: false, problem: resolved.problem }
        const file = baselineFileFor(budget, { cwd: options.cwd, rootDir: options.rootDir })
        const history = readBaseline(file, budget.id)
        if (history.problem !== undefined) return { ok: false, problem: history.problem }
        const measured = await measureBudget(budget, resolved.target, config, {
            entries: history.entries,
            baselineFile: file,
            runner: runner as (spec: RunSpec, service?: unknown) => Promise<RunOutcome>,
            ...(options.service === undefined ? {} : { service: options.service }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        if (!measured.ok) {
            const already = evaluations.map((evaluation) => `- ${evaluation.id}：${evaluation.state} — ${evaluation.reason}`)
            return {
                ok: false,
                problem:
                    already.length === 0
                        ? measured.problem
                        : [`${measured.problem}`, '', '（本次已判定但未写入的预算，仅供修复参考：）', ...already].join('\n'),
            }
        }
        const evaluation = measured.evaluation
        evaluations.push(evaluation)
        if (evaluation.baseline.recorded && evaluation.value !== undefined) {
            pending.push({
                file,
                budgetId: budget.id,
                entry: {
                    at: now(),
                    value: evaluation.value,
                    metric: budget.metric,
                    unit: evaluation.unit,
                    command: evaluation.command,
                    exitCode: evaluation.exitCode,
                },
            })
        }
    }
    for (const entry of pending) appendBaseline(entry.file, entry.budgetId, entry.entry)

    const blocked = evaluations.filter((evaluation) => evaluation.state === 'BLOCK')
    const state: GateState = blocked.length === 0 ? 'PASS' : 'BLOCK'
    const firstRun = evaluations.every((evaluation) => evaluation.baseline.history === 0)
    return {
        ok: true,
        evaluations,
        state,
        reason:
            state === 'PASS'
                ? `预算裁决：${evaluations.length}/${config.budgets.length} 条全部在界限内${firstRun ? '；基线已记录（均为首次测量）' : ''}`
                : `预算裁决：${blocked.map((evaluation) => evaluation.id).join(', ')} 越界`,
        results: evaluations.map((evaluation) => budgetResult(evaluation)),
        scope: {
            selected: budgets.map((budget) => budget.id),
            total: config.budgets.length,
            // A budget run never executes the host's gate command set, so it can
            // never authorise a delivery (see the module docs / README).
            full: false,
        },
        baselineFiles: [...new Set(evaluations.map((evaluation) => evaluation.baseline.file))],
        recorded: pending.length,
    }
}

/** One budget as a `GateCommandResult` row (the shape the gate ledger stores). */
export function budgetResult(evaluation: BudgetEvaluation): GateCommandResult {
    const output = [
        `预算：${evaluation.name}（${evaluation.id}）— metric=${evaluation.metric}，单位 ${evaluation.unit}`,
        `测量值：${evaluation.value === undefined ? '无（命令未成功执行）' : `${evaluation.value} ${evaluation.unit}`}`,
        ...evaluation.checks.map((check) => `[${check.state}] ${check.name}：${check.detail}`),
        `基线：${evaluation.baseline.file}（此前 ${evaluation.baseline.history} 次记录；本次${
            evaluation.baseline.recorded ? '已追加' : '未追加（越界或未测到）'
        }）`,
    ].join('\n')
    return {
        id: evaluation.id,
        name: `预算：${evaluation.name}`,
        command: evaluation.command,
        required: true,
        exitCode: evaluation.state === 'PASS' ? 0 : 1,
        signal: null,
        durationMs: evaluation.durationMs,
        timedOut: evaluation.timedOut,
        output: tail(output, 4_000),
        outputDigest: outputDigestOf(output, evaluation.command),
    }
}

/** Render the `budget_check` report (Chinese, exact, ends with 下一步). */
export function renderBudgets(run: Extract<BudgetRun, { ok: true }>, options: { problems?: number } = {}): string {
    const lines: string[] = []
    lines.push(`${run.state === 'PASS' ? '✅' : '⛔'} 预算门禁：${run.state}`)
    lines.push(`原因：${run.reason}`)
    lines.push(
        `范围：${run.scope.selected.length}/${run.scope.total} 条预算（${run.scope.selected.join('、')}）；` +
            '预算裁决的 `scope.full` 恒为 false —— 它执行的不是宿主的门禁命令集，因此**不构成交付依据**。',
    )
    if ((options.problems ?? 0) > 0) {
        lines.push(
            `⚠️ 配置另有 ${options.problems} 条问题（见插件日志）：被跳过的规则不会执行，而"规则变少"看起来和"全部通过"一模一样。`,
        )
    }
    for (const evaluation of run.evaluations) {
        lines.push('')
        lines.push(
            `[${evaluation.state === 'PASS' ? 'PASS' : 'BLOCK'}] ${evaluation.id}（${evaluation.name}）— ` +
                `${evaluation.value === undefined ? '未测到数值' : `${evaluation.value} ${evaluation.unit}`}，命令耗时 ${evaluation.durationMs}ms`,
        )
        lines.push(`  $ ${evaluation.command}`)
        for (const check of evaluation.checks) lines.push(`  - [${check.state}] ${check.name}：${check.detail}`)
        lines.push(
            `  基线：${evaluation.baseline.file}（此前 ${evaluation.baseline.history} 次记录；本次${
                evaluation.baseline.recorded ? '已追加一条' : '未追加'
            }）`,
        )
    }
    lines.push('')
    lines.push(`基线文件：${run.baselineFiles.join('、')}；本次追加 ${run.recorded} 条测量（历史只增不改，回归永远对照"历史最佳值"）。`)
    lines.push(
        run.state === 'PASS'
            ? '下一步：预算在界限内 ≠ 门禁通过——交付前仍需不带 only/phase 跑一次完整的 quality_gate_run，再 evidence_record → mission_complete。'
            : '下一步：先分辨"真实回归"还是"口径该改"：真实回归就修代码；口径要改就改 config.budgets（改口径是宿主/人的决定，不是这次调用的参数）。改完重跑 budget_check。',
    )
    return lines.join('\n')
}

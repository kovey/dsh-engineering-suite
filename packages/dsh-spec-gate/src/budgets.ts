/**
 * 非功能预算：把「健康检查 p95 < 50ms」「包体积 ≤ 200KiB」「迁移必须在 2s 内跑完」
 * 这类要求写进规格本身。
 *
 * 为什么需要这个模块：非功能要求以前只能写在 quality-gate 的宿主配置里，于是它既不
 * 随规格一起被人工审批，也无法追溯到需求编号，更没有人能回答「我们哪些要求是预算、
 * 验证过没有」。规格才是权威，所以预算必须先成为规格的一部分，然后才是可测量的门禁
 * 规则（`budget_check` 会读这里声明的预算并标注 `来源：规格`）。
 *
 * 三条纪律，与需求/验收标准完全一致：
 *
 *  1. **编号稳定、绝不复用。** 删掉的预算 id 进入 `retiredBudgets`，之后任何一次声明
 *     再用同一个 id 都会被拒绝 —— 基线历史（`budgets.json`）是按 id 存的，复用等于让
 *     旧历史冒充新预算；
 *  2. **fail closed，并把修法写在消息里。** 声明里的任何一处问题都拒绝整次写入：不猜、
 *     不忽略、不「尽力而为」（一个被悄悄丢掉的预算看起来和「全都通过」一模一样）；
 *  3. **没声明就不出现。** 没有预算的规格渲染出空表格是骗人的，所以宁可不渲染那一节。
 *
 * 预算随规格存储：`SpecRecord` 是 dsh-eng-core 的共享契约，本插件不修改它，因此
 * `budgets` / `retiredBudgets` / `budgetChanges` 是附加在同一个对象上的字段。读的一方
 * （`readSpecBudgets`、quality-gate 的规格预算解析）必须结构性地读取，并在读不出来时
 * fail closed —— README 的「诚实的边界」一节写明了这一点。
 *
 * @module dsh-spec-gate/budgets
 */

import { cell, formatTime, type SpecRecord } from 'dsh-eng-core'

/** 预算测量的三种口径（与 quality-gate 的 `BudgetMetric` 一致）。 */
export type BudgetMetric = 'durationMs' | 'number' | 'bytes'

/** 预算的界限：至少要有一种。 */
export interface BudgetThreshold {
    /** 上限：测量值必须 ≤ max（同时意味着「越小越好」）。 */
    max?: number
    /** 下限：测量值必须 ≥ min（只给 min 时意味着「越大越好」）。 */
    min?: number
    /** 相对「历史最佳值」允许的变差幅度（百分比，≥0）。 */
    maxRegressionPercent?: number
}

/** 规格里声明的一条非功能预算。 */
export interface SpecBudget {
    /** 稳定编号（同时是 quality-gate 基线历史的键），永不复用。 */
    id: string
    /** 报告里显示的名称。 */
    name: string
    metric: BudgetMetric
    /** 展示单位（缺省按 metric：durationMs→ms / bytes→bytes / number→count）。 */
    unit?: string
    /** 要测的命令（argv 形式，不经 shell）。 */
    command: string
    /** metric 为 number/bytes 时必填：第一个捕获组必须是纯数字。 */
    regex?: string
    threshold: BudgetThreshold
    /** 这条预算守护的编号（R-00n / AC-00n），必须存在于同一份规格。 */
    requirementIds?: string[]
}

/** 一次预算变更的记录（与需求的 `changes` 同构，但走自己的字段）。 */
export interface BudgetChange {
    kind: 'add-budget' | 'update-budget' | 'remove-budget'
    /** Epoch 毫秒。 */
    at: number
    /** 谁改的（session id 或 `spec_amend`）。 */
    by: string
    target: string
    /** 改动前的定义（update/remove）。 */
    before?: string
    /** 改动后的定义（add/update）。 */
    after?: string
    /** 为什么改，调用方解释过才有。 */
    note?: string
}

/**
 * 工具参数里的一条预算声明（未校验的模型输入）。
 *
 * 每个字段都是可选的字符串/数字，唯一目的是让 `spec_create` / `spec_amend` 的
 * parameter schema 与 TypeScript 类型对得上；真正的校验在
 * {@link parseBudgetDeclaration} 里（fail closed，且逐条给出修法）。
 */
export interface SpecBudgetInput {
    id?: string
    name?: string
    metric?: string
    unit?: string
    command?: string
    regex?: string
    threshold?: { max?: number; min?: number; maxRegressionPercent?: number }
    requirementIds?: string[]
}

/**
 * 规格记录 + 预算字段。
 *
 * 这是「附加字段」的显式落点：core 的 `SpecRecord` 不含预算，任何读 `mission.spec` 的
 * 代码都必须先经过这里的读取函数，而不是自己 `as` 一下。
 */
export interface SpecRecordWithBudgets extends SpecRecord {
    budgets?: SpecBudget[]
    /** 已作废的预算编号（永不复用）。 */
    retiredBudgets?: string[]
    /** 预算的变更历史（只增不改）。 */
    budgetChanges?: BudgetChange[]
}

/** 三种口径的默认展示单位。 */
export function defaultBudgetUnit(metric: BudgetMetric): string {
    return metric === 'durationMs' ? 'ms' : metric === 'bytes' ? 'bytes' : 'count'
}

/** 合法的口径取值。 */
export const BUDGET_METRICS: readonly BudgetMetric[] = ['durationMs', 'number', 'bytes']

/**
 * 预算 id 的形状：与宿主配置里的预算 id 同一规则。
 *
 * 必须一致，因为两边按 id 对齐（`budget_check` 用宿主配置的预算覆盖同 id 的规格预算，
 * 基线历史也按 id 存）。同时满足 `assertSafeId` 的单路径段要求。
 */
export const BUDGET_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i

/** 预算 id 的最长长度（与 `assertSafeId` 一致）。 */
export const BUDGET_ID_MAX_LENGTH = 200

/** 一条预算允许出现的字段（其余字段一律拒绝：打错一个字母绝不能被忽略）。 */
const BUDGET_FIELDS: readonly string[] = ['id', 'name', 'metric', 'unit', 'command', 'regex', 'threshold', 'requirementIds']

/** `threshold` 允许出现的字段。 */
const THRESHOLD_FIELDS: readonly string[] = ['max', 'min', 'maxRegressionPercent']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 一段正则里有没有捕获组。
 *
 * `extractNumber` 取的是第一个捕获组，一个没有捕获组的正则在 quality-gate 里只会落到
 * 「整个匹配」这条兼容路径上 —— 对规格里声明的预算来说那是含混的（`size=\d+` 捕获到的
 * 是 `size=123` 而不是数字），所以在声明阶段就拒绝。
 * @param source - 正则源码（已确认可编译）。
 */
export function hasCaptureGroup(source: string): boolean {
    let inClass = false
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index]
        if (character === '\\') {
            index += 1
            continue
        }
        if (inClass) {
            if (character === ']') inClass = false
            continue
        }
        if (character === '[') {
            inClass = true
            continue
        }
        if (character !== '(') continue
        const next = source[index + 1]
        if (next !== '?') return true
        // `(?:` 与 `(?=` `(?!` 不捕获；`(?<name>` 捕获（`(?<=` `(?<!` 是断言）。
        const after = source[index + 2]
        if (after === '<' && source[index + 3] !== '=' && source[index + 3] !== '!') return true
    }
    return false
}

/** 渲染界限（`≤ 50 ms；回归 ≤ 10%`）。 */
export function describeThreshold(threshold: BudgetThreshold, unit: string): string {
    const parts: string[] = []
    if (threshold.max !== undefined) parts.push(`≤ ${threshold.max} ${unit}`)
    if (threshold.min !== undefined) parts.push(`≥ ${threshold.min} ${unit}`)
    if (threshold.maxRegressionPercent !== undefined) parts.push(`相对历史最佳 ≤ ${threshold.maxRegressionPercent}%`)
    return parts.join('；')
}

/** 一条预算的一行定义（报告、变更历史与台账摘要共用一种写法）。 */
export function renderBudgetLine(budget: SpecBudget): string {
    const unit = budget.unit ?? defaultBudgetUnit(budget.metric)
    const requirements = (budget.requirementIds ?? []).join('、')
    return [
        `${budget.id} ${budget.name}：${budget.metric} ${describeThreshold(budget.threshold, unit)}`,
        `命令 \`${budget.command}\``,
        `关联需求 ${requirements === '' ? '(未关联)' : requirements}`,
    ].join('；')
}

/** 表格里的命令单元格（反引号里再放反引号会破表，替换成单引号）。 */
function commandCell(command: string): string {
    return cell(command.replace(/`/g, "'"))
}

/** 表格里的关联需求单元格。 */
function requirementCell(budget: SpecBudget): string {
    const ids = budget.requirementIds ?? []
    return ids.length === 0 ? '(未关联)' : ids.join('、')
}

/** 校验上下文：编号必须对得上「这次要写入的那一版」规格。 */
export interface BudgetContext {
    /** 本次修订的需求编号（R-00n）。 */
    requirementIds: readonly string[]
    /** 本次修订的验收标准编号（AC-00n）。 */
    criterionIds: readonly string[]
    /** 已作废的预算编号（永不复用）。 */
    retiredBudgets: readonly string[]
    /** 已作废的需求/验收标准编号（写错编号时给出更准的话）。 */
    retiredSpecIds?: readonly string[]
    /** 同一份声明里已经出现过的编号。 */
    seen?: ReadonlySet<string>
    /** 字段名，用于消息（`budgets` / `budget`）。 */
    field?: string
}

/** 解析一条声明：`budget` 缺失表示这一条无法使用，`problems` 里是每一步的修法。 */
export function parseBudgetDeclaration(input: unknown, index: number, context: BudgetContext): { budget?: SpecBudget; problems: string[] } {
    const field = context.field ?? 'budgets'
    const label = `${field}[${index}]`
    const problems: string[] = []
    if (!isRecord(input)) {
        return {
            problems: [
                `${label}: 必须是对象（收到 ${JSON.stringify(input)}）。` +
                    `下一步：按 { id, name, metric, command, threshold } 声明一条预算，例如 ` +
                    `{ id: "p95-health", name: "健康检查 p95", metric: "durationMs", command: "node scripts/p95.mjs", threshold: { max: 50 } }。`,
            ],
        }
    }

    for (const key of Object.keys(input)) {
        if (!BUDGET_FIELDS.includes(key)) {
            problems.push(
                `${label}.${key} 不属于非功能预算（只认 ${BUDGET_FIELDS.join(' / ')}）：未知字段会被拒绝而不是忽略。` +
                    `下一步：删掉它，或把它写进 threshold（max / min / maxRegressionPercent 之一）。`,
            )
        }
    }

    const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
    if (id === '') {
        problems.push(`${label}.id 缺失：预算 id 是它与宿主配置、基线历史对齐的键，不能省。下一步：给一个短 id（例如 "p95-health"）。`)
    } else if (!BUDGET_ID_PATTERN.test(id) || id.length > BUDGET_ID_MAX_LENGTH) {
        problems.push(
            `${label}.id "${id}" 不合法：只能字母/数字与 - _，以字母数字开头，最长 ${BUDGET_ID_MAX_LENGTH} 字符` +
                `（与 quality-gate 的预算 id 同一规则，因为它同时是基线历史的键）。下一步：改成 "p95-health" 这样的 id。`,
        )
    } else if (context.retiredBudgets.some((retired) => retired.toLowerCase() === id.toLowerCase())) {
        problems.push(
            `${label}.id "${id}" 已经被作废过（编号不复用）：基线历史按 id 存，复用会让旧历史冒充新预算。` +
                `下一步：换一个新 id（例如 "${id}-v2"），旧编号只出现在规格的「已作废预算编号」里。`,
        )
    } else if (context.seen?.has(id.toLowerCase()) === true) {
        problems.push(
            `${label}.id "${id}" 在同一份声明里出现了两次：预算 id 会共用同一份基线历史，重复声明等于两条规则互相覆盖。` +
                `下一步：合并成一条，或给其中一条换 id。`,
        )
    }

    const name = text(input['name'])
    if (name === undefined) {
        problems.push(`${label}.name 缺失或为空白：报告里要按名字说清楚测的是什么。下一步：写一句人能看懂的名称（例如 "健康检查 p95"）。`)
    }

    const metricRaw = input['metric']
    const metric = BUDGET_METRICS.includes(metricRaw as BudgetMetric) ? (metricRaw as BudgetMetric) : undefined
    if (metric === undefined) {
        problems.push(
            `${label}.metric 必须是 ${BUDGET_METRICS.join(' / ')} 之一（收到 ${JSON.stringify(metricRaw)}）：` +
                `durationMs 测命令耗时，number/bytes 从命令输出里按 regex 取数。下一步：补上或改正 metric。`,
        )
    }

    const unit = input['unit'] === undefined ? undefined : text(input['unit'])
    if (input['unit'] !== undefined && unit === undefined) {
        problems.push(`${label}.unit 必须是字符串（收到 ${JSON.stringify(input['unit'])}）。下一步：写 "ms" / "bytes" / "count"，或省略它用默认单位。`)
    }

    const command = text(input['command'])
    if (command === undefined) {
        problems.push(
            `${label}.command 缺失或为空白：预算要测哪条命令必须写清楚（不经 shell，按 argv 切分）。` +
                `下一步：写 "node scripts/p95.mjs" 这样的完整命令行。`,
        )
    }

    const regexRaw = input['regex']
    if (metric === 'durationMs' && regexRaw !== undefined) {
        problems.push(
            `${label} 同时声明了 metric=durationMs 与 regex：durationMs 测的是命令的墙钟时间，与输出无关。` +
                `下一步：删掉 regex，或把 metric 改成 number（并写清 unit）。`,
        )
    }
    if (metric !== undefined && metric !== 'durationMs' && regexRaw === undefined) {
        problems.push(
            `${label} 的 metric=${metric} 需要 regex：数字只从命令输出里按你给的正则取（第一个捕获组必须是纯数字）。` +
                `下一步：写 regex（例如 "size=(\\\\d+)"），或把 metric 改成 durationMs 直接测命令耗时。`,
        )
    }
    const regex = regexRaw === undefined ? undefined : text(regexRaw)
    if (regexRaw !== undefined && regex === undefined) {
        problems.push(`${label}.regex 必须是字符串（收到 ${JSON.stringify(regexRaw)}）。下一步：写一个能捕获纯数字的正则。`)
    } else if (regex !== undefined && metric !== 'durationMs') {
        let compiled: RegExp | undefined
        try {
            compiled = new RegExp(regex)
        } catch (error) {
            problems.push(
                `${label}.regex 不是合法正则（${error instanceof Error ? error.message : String(error)}）：${regex}。` +
                    `下一步：修正正则（只捕获数字本身，单位别放进捕获组）。`,
            )
        }
        if (compiled !== undefined && !hasCaptureGroup(compiled.source)) {
            problems.push(
                `${label}.regex /${regex}/ 没有捕获组：取数只认第一个捕获组，没有捕获组就没有明确的数字。` +
                    `下一步：给数字加上括号，例如 "size=(\\\\d+)"（"size=\\\\d+" 这种整段匹配会被拒绝）。`,
            )
        }
    }

    const thresholdRaw = input['threshold']
    let threshold: BudgetThreshold | undefined
    if (!isRecord(thresholdRaw)) {
        problems.push(
            `${label}.threshold 缺失或不是对象（收到 ${JSON.stringify(thresholdRaw)}）：没有界限的预算是无法判定的规则。` +
                `下一步：写 threshold: { max: 50 }（上限）、{ min: 1000 }（下限）、{ maxRegressionPercent: 10 }（回归）中的至少一种。`,
        )
    } else {
        const parsed: BudgetThreshold = {}
        for (const key of Object.keys(thresholdRaw)) {
            if (!THRESHOLD_FIELDS.includes(key)) {
                problems.push(
                    `${label}.threshold.${key} 不是界限（只认 ${THRESHOLD_FIELDS.join(' / ')}）。` +
                        `下一步：删掉它，或改成 max / min / maxRegressionPercent 之一。`,
                )
            }
        }
        for (const key of THRESHOLD_FIELDS as readonly ('max' | 'min' | 'maxRegressionPercent')[]) {
            if (thresholdRaw[key] === undefined) continue
            const value = finite(thresholdRaw[key])
            if (value === undefined) {
                problems.push(`${label}.threshold.${key} 必须是有限数字（收到 ${JSON.stringify(thresholdRaw[key])}）。下一步：写数字，或省略该界限。`)
                continue
            }
            if (key === 'maxRegressionPercent' && value < 0) {
                problems.push(`${label}.threshold.maxRegressionPercent 不能是负数（收到 ${value}）。下一步：写 0 或正数（百分比）。`)
                continue
            }
            parsed[key] = value
        }
        if (Object.keys(parsed).length === 0) {
            problems.push(
                `${label}.threshold 里一个界限都没有：预算必须至少有一个 max / min / maxRegressionPercent，否则它永远无法判定。` +
                    `下一步：补一个界限（例如 max: 50），或删掉这条预算。`,
            )
        } else {
            threshold = parsed
        }
    }

    let requirementIds: string[] | undefined
    if (input['requirementIds'] !== undefined) {
        const raw = input['requirementIds']
        if (!Array.isArray(raw)) {
            problems.push(
                `${label}.requirementIds 必须是数组（收到 ${JSON.stringify(raw)}）：它把预算挂到需求/验收标准的编号上。` +
                    `下一步：写 ["AC-003"]，或省略该字段。`,
            )
        } else {
            const live = new Map<string, string>()
            for (const entry of [...context.requirementIds, ...context.criterionIds]) live.set(entry.toUpperCase(), entry)
            const collected: string[] = []
            for (const entry of raw) {
                const value = text(entry)
                if (value === undefined) {
                    problems.push(`${label}.requirementIds 里必须是编号字符串（收到 ${JSON.stringify(entry)}）。下一步：写 "AC-003" 这样的编号。`)
                    continue
                }
                const canonical = live.get(value.toUpperCase())
                if (canonical === undefined) {
                    const retired = (context.retiredSpecIds ?? []).some((id) => id.toUpperCase() === value.toUpperCase())
                    problems.push(
                        `${label}.requirementIds 里的 "${value}" 在这份规格里不存在（未知编号会被拒绝，而不是忽略）：` +
                            (retired
                                ? `它已经被作废（编号不复用）。`
                                : `当前可用编号：${[...live.values()].join('、') || '(无)'}。`) +
                            `下一步：改成上面某个编号（预算必须挂在真实存在的需求/验收标准上），或删掉这条关联。`,
                    )
                    continue
                }
                if (!collected.includes(canonical)) collected.push(canonical)
            }
            if (collected.length > 0) requirementIds = collected
        }
    }

    if (problems.length > 0 || id === '' || name === undefined || metric === undefined || command === undefined || threshold === undefined) {
        return { problems }
    }
    return {
        budget: {
            id,
            name,
            metric,
            ...(unit === undefined ? {} : { unit }),
            command,
            ...(regex === undefined || metric === 'durationMs' ? {} : { regex }),
            threshold,
            ...(requirementIds === undefined ? {} : { requirementIds }),
        },
        problems: [],
    }
}

/** 解析一份预算声明列表（整份拒绝：只写入「部分合法」的声明会让报告看起来是完整的）。 */
export function parseBudgetDeclarations(
    declared: unknown,
    context: BudgetContext,
): { ok: true; budgets: SpecBudget[] } | { ok: false; problems: string[] } {
    const field = context.field ?? 'budgets'
    if (!Array.isArray(declared)) {
        return {
            ok: false,
            problems: [`${field} 必须是数组（收到 ${JSON.stringify(declared)}）。下一步：写 [{ id, name, metric, command, threshold }]，或省略该参数表示不改动预算。`],
        }
    }
    const problems: string[] = []
    const budgets: SpecBudget[] = []
    const seen = new Set<string>()
    for (const [index, entry] of declared.entries()) {
        const parsed = parseBudgetDeclaration(entry, index, { ...context, field, seen })
        problems.push(...parsed.problems)
        if (parsed.budget !== undefined) {
            seen.add(parsed.budget.id.toLowerCase())
            budgets.push(parsed.budget)
        }
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true, budgets }
}

/** 一条预算的规范化签名（用于判断 update 是否真的改了东西）。 */
function signatureOf(budget: SpecBudget): string {
    return JSON.stringify({
        id: budget.id,
        name: budget.name,
        metric: budget.metric,
        unit: budget.unit ?? defaultBudgetUnit(budget.metric),
        command: budget.command,
        regex: budget.regex ?? null,
        threshold: {
            max: budget.threshold.max ?? null,
            min: budget.threshold.min ?? null,
            maxRegressionPercent: budget.threshold.maxRegressionPercent ?? null,
        },
        requirementIds: [...(budget.requirementIds ?? [])],
    })
}

/** 一次预算变更的计划。 */
export interface BudgetPlan {
    /** 变更之后的活预算（按声明顺序）。 */
    budgets: SpecBudget[]
    /** 变更之后的已作废编号（只增不减）。 */
    retired: string[]
    /** 本次真正发生的变更（没有变化时为空）。 */
    changes: BudgetChange[]
    /** 一句话摘要（工具输出与台账行共用）。 */
    summary: string
}

/** 把计划写进规格记录（空集合不落字段：没声明就不出现）。 */
export function specWithBudgetPlan(spec: SpecRecord, plan: BudgetPlan): SpecRecordWithBudgets {
    const next: SpecRecordWithBudgets = { ...spec }
    if (plan.budgets.length > 0) next.budgets = plan.budgets
    else delete next.budgets
    if (plan.retired.length > 0) next.retiredBudgets = plan.retired
    else delete next.retiredBudgets
    const history = [...(readSpecBudgets(spec).changes ?? []), ...plan.changes]
    if (history.length > 0) next.budgetChanges = history
    else delete next.budgetChanges
    return next
}

/**
 * 对账的内部实现（`spec_create` / `spec_amend` 的整组声明与单条编辑共用）。
 * @param current - 变更前的活预算。
 * @param parsed - 已校验的新声明（按声明顺序，就是变更后的活预算）。
 * @param context - 变更元信息。
 * @param now - 注入的时钟。
 */
function planAgainst(
    current: readonly SpecBudget[],
    parsed: readonly SpecBudget[],
    context: { retiredBudgets: readonly string[]; by: string; note?: string },
    now: number,
): BudgetPlan {
    const previousById = new Map(current.map((budget) => [budget.id.toLowerCase(), budget]))
    const changes: BudgetChange[] = []
    const retired = [...context.retiredBudgets]
    const declaredIds = new Set(parsed.map((budget) => budget.id.toLowerCase()))

    for (const budget of parsed) {
        const previous = previousById.get(budget.id.toLowerCase())
        if (previous === undefined) {
            changes.push({
                kind: 'add-budget',
                at: now,
                by: context.by,
                target: budget.id,
                after: renderBudgetLine(budget),
                ...(context.note === undefined ? {} : { note: context.note }),
            })
            continue
        }
        if (signatureOf(previous) !== signatureOf(budget)) {
            changes.push({
                kind: 'update-budget',
                at: now,
                by: context.by,
                target: budget.id,
                before: renderBudgetLine(previous),
                after: renderBudgetLine(budget),
                ...(context.note === undefined ? {} : { note: context.note }),
            })
        }
    }
    for (const budget of current) {
        if (declaredIds.has(budget.id.toLowerCase())) continue
        changes.push({
            kind: 'remove-budget',
            at: now,
            by: context.by,
            target: budget.id,
            before: renderBudgetLine(budget),
            ...(context.note === undefined ? {} : { note: context.note }),
        })
        if (!retired.some((id) => id.toLowerCase() === budget.id.toLowerCase())) retired.push(budget.id)
    }

    const summary =
        changes.length === 0
            ? `非功能预算未变化（${parsed.length} 条）`
            : `非功能预算：${changes
                  .map((change) =>
                      change.kind === 'add-budget'
                          ? `新增 ${change.target}`
                          : change.kind === 'update-budget'
                            ? `修改 ${change.target}`
                            : `删除 ${change.target}（编号不复用）`,
                  )
                  .join('；')}`
    return { budgets: [...parsed], retired, changes, summary }
}

/**
 * 对账一份「整组声明」：新增、修改、删除（删除即作废编号）。
 *
 * 规则是「声明即现状」：列表里有的就是活预算（同 id 视为同一条，内容不同就是 update），
 * 列表里没有的活预算就是 remove —— 并立刻把 id 记进 `retiredBudgets`，之后任何一次
 * 声明再用这个 id 都会被拒绝。
 *
 * `budgets: []` 是**明确**地删掉全部预算（省略 `budgets` 参数才是「不改动」）：这是一次
 * 有记录的决定，不是默认值。
 * @param current - 变更前的活预算。
 * @param declared - 声明的整组预算（未校验）。
 * @param context - 本次修订的编号、已作废集合与变更元信息。
 */
export function declareBudgets(
    current: readonly SpecBudget[],
    declared: unknown,
    context: BudgetContext & { by: string; now?: number; note?: string },
): { ok: true; plan: BudgetPlan } | { ok: false; problems: string[] } {
    const parsed = parseBudgetDeclarations(declared, context)
    if (!parsed.ok) return parsed
    const now = context.now ?? Date.now()
    return { ok: true, plan: planAgainst(current, parsed.budgets, context, now) }
}

/** 单条预算编辑的请求（`spec_amend({ part: 'budget' })`）。 */
export interface BudgetEditRequest {
    action: 'add' | 'update' | 'remove'
    /** `update` / `remove` 必填；`add` 时可以在这里给 id（或写在 budget 里）。 */
    target?: string
    /** `add` / `update` 的新定义。 */
    budget?: unknown
    note?: string
}

/**
 * 应用一条预算编辑（与需求的 add/update/remove 同一套纪律）。
 * @param current - 变更前的活预算。
 * @param context - 本次修订的编号、已作废集合与变更元信息。
 * @param request - 编辑请求。
 */
export function applyBudgetEdit(
    current: readonly SpecBudget[],
    context: BudgetContext & { by: string; now?: number },
    request: BudgetEditRequest,
): { ok: true; plan: BudgetPlan; summary: string } | { ok: false; problem: string; nextSteps?: string } {
    const now = context.now ?? Date.now()
    const target = (request.target ?? '').trim()
    const live = new Map(current.map((budget) => [budget.id.toLowerCase(), budget]))
    const retired = [...context.retiredBudgets]

    if (request.action === 'remove') {
        if (target === '') {
            return { ok: false, problem: '删除预算必须给出 target（预算 id）。', nextSteps: '先调用 spec_status 看已声明的预算 id，再带上 target 重试。' }
        }
        const budget = live.get(target.toLowerCase())
        if (budget === undefined) {
            const wasRetired = retired.some((id) => id.toLowerCase() === target.toLowerCase())
            return {
                ok: false,
                problem: wasRetired
                    ? `预算 "${target}" 已经被删除过（编号进入 retired，不会复用）：不能对已删除的预算做 remove。`
                    : `规格里没有预算 "${target}"：当前声明的是 ${current.map((entry) => entry.id).join('、') || '(无)'}。`,
                nextSteps: wasRetired
                    ? '需要重新约束这个数字时用 action: "add"（会分配一个新 id），不要复活旧编号。'
                    : '调用 spec_status 查看当前预算 id 后再试。',
            }
        }
        const plan = planAgainst(current, current.filter((entry) => entry.id !== budget.id), { retiredBudgets: retired, by: context.by, ...(request.note === undefined ? {} : { note: request.note }) }, now)
        return { ok: true, plan, summary: `删除预算 ${budget.id}（原定义：${renderBudgetLine(budget)}）` }
    }

    const raw = isRecord(request.budget) ? { ...request.budget } : request.budget
    const declaredId = isRecord(raw) ? (typeof raw['id'] === 'string' ? raw['id'].trim() : '') : ''
    if (request.action === 'update') {
        if (target === '') {
            return { ok: false, problem: '修改预算必须给出 target（预算 id）。', nextSteps: '先调用 spec_status 看已声明的预算 id，再带上 target 重试。' }
        }
        const budget = live.get(target.toLowerCase())
        if (budget === undefined) {
            const wasRetired = retired.some((id) => id.toLowerCase() === target.toLowerCase())
            return {
                ok: false,
                problem: wasRetired
                    ? `预算 "${target}" 已经被删除过（编号进入 retired，不会复用）：不能对已删除的预算做 update。`
                    : `规格里没有预算 "${target}"：当前声明的是 ${current.map((entry) => entry.id).join('、') || '(无)'}。`,
                nextSteps: wasRetired
                    ? '需要重新约束这个数字时用 action: "add"（会分配一个新 id），不要复活旧编号。'
                    : '调用 spec_status 查看当前预算 id 后再试。',
            }
        }
        if (declaredId !== '' && declaredId.toLowerCase() !== budget.id.toLowerCase()) {
            return {
                ok: false,
                problem: `update 的 target "${target}" 与 budget.id "${declaredId}" 不一致：改预算不换编号（换 id 等于换一条规则，编号也不复用）。`,
                nextSteps: `下一步：把 budget.id 改成 "${budget.id}"（或删掉它），或用 action: "add" 声明一条新预算。`,
            }
        }
        if (!isRecord(raw)) {
            return {
                ok: false,
                problem: '修改预算必须给出 budget（完整的新定义）。下一步：把 { id, name, metric, command, threshold } 一起写上（这是替换，不是补丁）。',
            }
        }
        const parsed = parseBudgetDeclaration({ ...raw, id: budget.id }, 0, { ...context, field: 'budget' })
        if (parsed.budget === undefined) return { ok: false, problem: `修改预算 ${budget.id} 的声明无法使用：`, nextSteps: parsed.problems.join('\n') }
        const next = current.map((entry) => (entry.id === budget.id ? (parsed.budget as SpecBudget) : entry))
        const plan = planAgainst(current, next, { retiredBudgets: retired, by: context.by, ...(request.note === undefined ? {} : { note: request.note }) }, now)
        return {
            ok: true,
            plan,
            summary:
                signatureOf(budget) === signatureOf(parsed.budget)
                    ? `预算 ${budget.id} 的定义没有变化（未记入变更历史）`
                    : `修改预算 ${budget.id}：${renderBudgetLine(budget)} → ${renderBudgetLine(parsed.budget)}`,
        }
    }

    // add
    const id = declaredId !== '' ? declaredId : target
    if (isRecord(raw) && declaredId !== '' && target !== '' && declaredId.toLowerCase() !== target.toLowerCase()) {
        return {
            ok: false,
            problem: `add 的 target "${target}" 与 budget.id "${declaredId}" 不一致：一条预算只有一个编号。`,
            nextSteps: `下一步：只保留其中一个（推荐把 id 写在 budget 里）。`,
        }
    }
    if (!isRecord(raw)) {
        return {
            ok: false,
            problem: '新增预算必须给出 budget（完整定义）。下一步：写 { id, name, metric, command, threshold }，例如 { id: "p95-health", name: "健康检查 p95", metric: "durationMs", command: "node scripts/p95.mjs", threshold: { max: 50 } }。',
        }
    }
    const parsed = parseBudgetDeclaration({ ...raw, id }, 0, { ...context, field: 'budget' })
    if (parsed.budget === undefined) return { ok: false, problem: `新增预算的声明无法使用：`, nextSteps: parsed.problems.join('\n') }
    if (live.has(parsed.budget.id.toLowerCase())) {
        return {
            ok: false,
            problem: `预算 "${parsed.budget.id}" 已经存在：不要用重复声明制造"改过了"的错觉。`,
            nextSteps: '确需修改请用 action: "update" 指向这个 id。',
        }
    }
    const next = [...current, parsed.budget]
    const plan = planAgainst(current, next, { retiredBudgets: retired, by: context.by, ...(request.note === undefined ? {} : { note: request.note }) }, now)
    return { ok: true, plan, summary: `新增预算 ${parsed.budget.id}：${renderBudgetLine(parsed.budget)}` }
}

/** 读取规格里的预算：读不出来的条目会被记进 `problems`，绝不静默丢弃。 */
export interface BudgetRead {
    budgets: SpecBudget[]
    retired: string[]
    changes: BudgetChange[]
    /** 无法解析的条目（手工改过 mission.json 才会出现）。 */
    problems: string[]
}

/**
 * 结构性读取附加在规格上的预算字段。
 *
 * 这是唯一允许读 `spec.budgets` 的地方：写入时已经校验过，所以读出来的条目只可能被
 * 「手工改过 mission.json」破坏 —— 那种情况下必须留下 `problems`，因为「少了一条规则」
 * 和「全部通过」在报告里长得一模一样。
 * @param spec - mission 记录里的规格（可能来自旧版本，没有预算字段）。
 */
export function readSpecBudgets(spec: SpecRecord | undefined): BudgetRead {
    const source = spec as SpecRecordWithBudgets | undefined
    const rawBudgets = source?.budgets
    const budgets: SpecBudget[] = []
    const problems: string[] = []
    if (rawBudgets !== undefined) {
        if (!Array.isArray(rawBudgets)) {
            problems.push(`规格记录里的 budgets 不是数组（收到 ${JSON.stringify(rawBudgets)}）：无法确认声明了哪些预算。`)
        } else {
            for (const [index, entry] of rawBudgets.entries()) {
                const budget = readOneBudget(entry)
                if (budget === undefined) problems.push(`规格记录里的 budgets[${index}] 无法解析：${JSON.stringify(entry)}`)
                else budgets.push(budget)
            }
        }
    }
    const rawRetired = source?.retiredBudgets
    const retired = Array.isArray(rawRetired) ? rawRetired.filter((id): id is string => typeof id === 'string' && id.trim() !== '') : []
    const rawChanges = source?.budgetChanges
    const changes = Array.isArray(rawChanges)
        ? rawChanges.filter((change): change is BudgetChange => isRecord(change) && typeof change['kind'] === 'string' && typeof change['target'] === 'string' && typeof change['at'] === 'number')
        : []
    return { budgets, retired, changes, problems }
}

/** 结构性读取一条已持久化的预算。 */
function readOneBudget(entry: unknown): SpecBudget | undefined {
    if (!isRecord(entry)) return undefined
    const id = text(entry['id'])
    const name = text(entry['name'])
    const command = text(entry['command'])
    const metricRaw = entry['metric']
    if (id === undefined || name === undefined || command === undefined) return undefined
    if (metricRaw !== 'durationMs' && metricRaw !== 'number' && metricRaw !== 'bytes') return undefined
    if (!isRecord(entry['threshold'])) return undefined
    const threshold: BudgetThreshold = {}
    for (const key of THRESHOLD_FIELDS as readonly ('max' | 'min' | 'maxRegressionPercent')[]) {
        const value = finite(entry['threshold'][key])
        if (value !== undefined) threshold[key] = value
    }
    if (Object.keys(threshold).length === 0) return undefined
    const unit = text(entry['unit'])
    const regex = text(entry['regex'])
    const requirementIds = Array.isArray(entry['requirementIds'])
        ? entry['requirementIds'].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        : undefined
    return {
        id,
        name,
        metric: metricRaw,
        ...(unit === undefined ? {} : { unit }),
        command,
        ...(regex === undefined ? {} : { regex }),
        threshold,
        ...(requirementIds === undefined || requirementIds.length === 0 ? {} : { requirementIds }),
    }
}

/** 一条预算变更的历史行。 */
export function renderBudgetChangeLine(change: BudgetChange): string {
    const body =
        change.kind === 'add-budget'
            ? `新增：${change.after ?? ''}`
            : change.kind === 'update-budget'
              ? `修改：${change.before ?? ''} → ${change.after ?? ''}`
              : `删除（原定义：${change.before ?? ''}）`
    return `- ${formatTime(change.at)} \`${change.kind}\` ${change.target} ${body}${change.note === undefined ? '' : `（理由：${change.note}）`}`
}

/**
 * 渲染规格工件的 `## 非功能预算` 章节。
 *
 * 没有预算、没有作废编号、也没有变更历史时返回空串：空的表格是骗人的（它看起来像
 * 「声明过，但一条都没有」）。
 * @param spec - 规格记录（含附加的预算字段）。
 */
export function renderBudgetSection(spec: SpecRecord | undefined): string {
    const read = readSpecBudgets(spec)
    if (read.budgets.length === 0 && read.retired.length === 0 && read.changes.length === 0 && read.problems.length === 0) return ''
    const lines: string[] = ['## 非功能预算', '']
    if (read.budgets.length === 0) {
        lines.push('(当前没有预算；下面是已作废的编号与变更历史)', '')
    } else {
        lines.push('| 编号 | 名称 | 指标 | 阈值 | 命令 | 关联需求 |')
        lines.push('|------|------|------|------|------|----------|')
        for (const budget of read.budgets) {
            const unit = budget.unit ?? defaultBudgetUnit(budget.metric)
            lines.push(
                `| ${cell(budget.id)} | ${cell(budget.name)} | ${budget.metric} | ${cell(describeThreshold(budget.threshold, unit))} | \`${commandCell(budget.command)}\` | ${cell(requirementCell(budget))} |`,
            )
        }
        lines.push('')
    }
    if (read.retired.length > 0) {
        lines.push(`已作废预算编号（不会复用）：${read.retired.join('、')}`, '')
    }
    if (read.changes.length > 0) {
        lines.push('预算变更（最近 5 条）：', '')
        for (const change of read.changes.slice(-5)) lines.push(renderBudgetChangeLine(change))
        lines.push('')
    }
    if (read.problems.length > 0) {
        lines.push('⚠️ 规格记录里还有无法解析的预算条目（见 spec_status）：', '')
        for (const problem of read.problems) lines.push(`- ${problem}`)
        lines.push('')
    }
    return lines.join('\n').trimEnd()
}

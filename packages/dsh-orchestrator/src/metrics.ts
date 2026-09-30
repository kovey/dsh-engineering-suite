/**
 * Delivery metrics: "交付到底进行得怎么样"，从套件本来就在写的 trail 里读出来
 * （`.dsh/missions/*`、`.dsh/deployments.jsonl`、`.dsh/releases.jsonl`）。
 *
 * 管理问题与工程问题不同：复盘（`retrospective.ts`）回答"这一个 mission 为什么返工"，
 * 度量回答"这段时间的交付节奏如何、卡在哪一步"。所以这里只做四件事：
 *
 *  1. **定义写死在代码里**：lead time、审批等待、门禁失败率、部署失败率/回滚、在飞、
 *     最近发布——每条定义都在 README 里有一行公式，报告里带口径；
 *  2. **每个数字都带样本量**：`中位数 X 天 / p90 Y 天（n=3）`。分位数用
 *     **linear-interpolation（R-7 / numpy `linear` 默认）**：排序样本上取
 *     `rank = (n-1)·p`，在相邻两个值之间线性插值，1 个样本时 median = p90 = 该值
 *     并且**明说"单样本"**，0 个样本时说"没有数据"，绝不假装成 0；
 *  3. **读不到就是缺口，不是 0**：台账缺失/末行截断/行不是本套件写的，都降级为
 *     **有名字的缺口**（`数据缺口` 段落），而不是一个看起来像测量结果的 0；
 *  4. **只读**：本模块没有任何写路径（`node:fs` 只用于读取与探测文件是否存在），
 *     `orchestrate({ action: 'metrics' })` 不写门禁、不改 mission、不落任何文件——
 *     `test/orchestrator.test.ts` 用 `.dsh` 前后快照断言这一点。
 *
 * 计算是纯函数（`computeMetrics` 只吃准备好的数据），I/O 隔离在 `collectTrail` 里，
 * 这样"口径"可以在测试里脱离文件系统验证。
 *
 * @module dsh-orchestrator/metrics
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    cell,
    formatTime,
    listDir,
    readText,
    type GateRecord,
    type GateState,
    type Layout,
    type MissionRecord,
    type MissionStore,
    type StageResult,
} from 'dsh-eng-core'

// --- constants ---------------------------------------------------------------

/** 默认窗口：90 天（`config.metrics.windowDays` 或 `action: 'metrics'` 的入参可改）。 */
export const DEFAULT_METRICS_WINDOW_DAYS = 90
/** 窗口上限（10 年）——再大就不是"近况"了，而全量历史应直接读台账。 */
export const MAX_METRICS_WINDOW_DAYS = 3650
/** 在飞列表默认显示条数（`config.metrics.maxInFlight`）。 */
export const DEFAULT_MAX_IN_FLIGHT = 20
/** 在飞列表上限。 */
export const MAX_MAX_IN_FLIGHT = 200
/** 门禁失败原因按 source 归组后最多显示几组。 */
export const GATE_REASON_TOP_N = 5
/** 最近发布显示条数。 */
export const RECENT_RELEASE_LIMIT = 5
/** 失败部署明细最多显示几条。 */
export const FAILED_DEPLOY_LIMIT = 5
/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000
/** 分位数方法的稳定名字（写进报告，读的人可以自己复算）。 */
export const QUANTILE_METHOD = 'linear-interpolation'

// --- 分位数（纯函数） ---------------------------------------------------------

/** 一次分位数计算的结论，含它有多少样本、是否只是单样本。 */
export interface DurationStats {
    /** 样本量（0 = 没有数据；1 = 单样本）。 */
    n: number
    /** `no-data` / `one-sample`（分布无意义）/ `ok`。 */
    status: 'no-data' | 'one-sample' | 'ok'
    median?: number
    p90?: number
}

/**
 * 排序样本上的线性插值分位数（R-7）：`rank = (n-1)·p`。
 * 选它的理由：任何读报告的人用表格软件都能复算，而且结果永远落在样本区间内
 * （不会像某些定义那样外插出一个没有出现过的值）。
 * @param sorted - 升序样本（调用方保证有序）。
 * @param p - 0..1。
 * @returns 分位数；空样本返回 `undefined`。
 */
export function quantile(sorted: readonly number[], p: number): number | undefined {
    const n = sorted.length
    if (n === 0) return undefined
    if (n === 1) return sorted[0]
    const rank = (n - 1) * p
    const low = Math.floor(rank)
    const high = Math.ceil(rank)
    const lowValue = sorted[low]
    const highValue = sorted[high]
    if (lowValue === undefined || highValue === undefined) return undefined
    if (low === high) return lowValue
    return lowValue + (highValue - lowValue) * (rank - low)
}

/** 中位数 + p90，并如实记录样本量。1 个样本时两个值相等且标为"单样本"。 */
export function durationStats(samples: readonly number[]): DurationStats {
    const sorted = [...samples].sort((left, right) => left - right)
    if (sorted.length === 0) return { n: 0, status: 'no-data' }
    const median = quantile(sorted, 0.5)
    const p90 = quantile(sorted, 0.9)
    if (sorted.length === 1) return { n: 1, status: 'one-sample', median, p90 }
    return { n: sorted.length, status: 'ok', median, p90 }
}

// --- 台账读取（容错，缺口有名字） ---------------------------------------------

/** 一次台账读取的结果；`problems` 是"读到了但用不了"的行，绝不静默吞掉。 */
export interface LedgerRead {
    /** 实际读取的文件（绝对路径）。 */
    file: string
    /** 文件是否存在。 */
    present: boolean
    /** 可用的原始行（未按业务字段过滤）。 */
    rows: Record<string, unknown>[]
    /** 无法使用的行，每条一句中文。 */
    problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取一个 JSONL 台账，容忍截断末行。
 *
 * `dsh-eng-core` 的 `readJsonl` 会静默跳过坏行；度量不能那样——"台账里少了 2 行"
 * 与"台账里那 2 行是 refused" 对读数的含义完全不同，所以这里把坏行数成缺口。
 */
export function readLedger(file: string): LedgerRead {
    const text = readText(file)
    if (text === undefined) return { file, present: false, rows: [], problems: [] }
    const rows: Record<string, unknown>[] = []
    const problems: string[] = []
    const lines = text.split('\n')
    lines.forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed === '') return
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            // 崩溃通常只会损坏最后一行（append-only + 单行写入），所以这是预期形状。
            const tail = lines.slice(index + 1).every((rest) => rest.trim() === '')
            problems.push(
                tail
                    ? `第 ${index + 1} 行无法解析（JSON 不完整，通常是写入被中断留下的截断末行）：已跳过，不影响前面的 ${rows.length} 行`
                    : `第 ${index + 1} 行无法解析：已跳过`,
            )
            return
        }
        if (!isRecord(parsed)) {
            problems.push(`第 ${index + 1} 行不是 JSON 对象：已跳过`)
            return
        }
        rows.push(parsed)
    })
    return { file, present: true, rows, problems }
}

/**
 * 台账的候选路径：优先套件自己的 trail 根（`<rootDir>/<name>.jsonl`），其次
 * 兄弟插件的默认位置（`<cwd>/.dsh/<name>.jsonl`）。
 *
 * `dsh-deploy-gate` 的 `ledgerFile` 与 `dsh-evidence-gate` 的 `releasesFile` 都是宿主
 * 可改的键，而编排插件不重复定义它们：先看 trail 根，再看默认位置；两个都没有时，
 * 报告里点名"无部署台账/无发布台账"并给出期望路径——**绝不返回 0**。
 */
export function ledgerCandidatePaths(layout: Layout, name: string): string[] {
    const primary = path.join(layout.rootDir, `${name}.jsonl`)
    const fallback = path.join(layout.cwd, '.dsh', `${name}.jsonl`)
    return primary === fallback ? [primary] : [primary, fallback]
}

/** 读取台账：取第一个存在的候选路径，都没有时读主路径（`present: false`）。 */
export function readTrailLedger(layout: Layout, name: string): LedgerRead {
    const candidates = ledgerCandidatePaths(layout, name)
    const existing = candidates.find((file) => fs.existsSync(file))
    return readLedger(existing ?? candidates[0] ?? path.join(layout.rootDir, `${name}.jsonl`))
}

// --- 部署台账（纯函数） -------------------------------------------------------

/**
 * 部署行（`dsh-deploy-gate` 的 `LedgerRow` 子集）。
 *
 * 拼写差异是要处理的现实：部署门禁写的是 `rolled-back` / `verify-failed`
 * （连字符），而需求/文档里常写成 `rolledBack` / `verifyFailed`，两种都认。
 */
export interface DeployRow {
    at: number
    environment: string
    revision: string
    state: string
    id?: string
    rollbackOf?: string
}

/** 一行部署台账在统计里的归类。 */
export type DeployBucket = 'attempt' | 'verification' | 'failure' | 'rollback' | 'refused' | 'unknown'

/** 一次部署尝试是如何失败的（报告里点名环境/revision/时间）。 */
export interface DeployIncident {
    environment: string
    revision: string
    at: number
    /** 上报失败的那一行的 state（`failed` / `verify-failed` / `rolled-back` …）。 */
    state: string
    /** 被归因的那次部署行 id，能在台账里对上号时给出。 */
    attributedTo?: string
}

/** 部署台账的读数。`failureRate` 在"没有尝试"时是 `undefined`，不是 0。 */
export interface DeployStats {
    /** 台账里落在窗口内的行数。 */
    rows: number
    /** 真的碰了环境的部署次数（`deployed` 行，加上台账里没有对应 `deployed` 行的失败/回滚行）。 */
    attempts: number
    /** 失败次数（每个失败事件只算一次）。 */
    failures: number
    /** 带 `rollbackOf` 的行数（回滚动作本身）。 */
    rollbacks: number
    /** 被拒绝、从未碰环境的行数（`refused`）。 */
    refused: number
    /** 验收行数（`verified`）。 */
    verifications: number
    /** `verified` 行里没有对应 `deployed` 行的数量（那次部署多半在窗口外）。 */
    orphanVerifications: number
    /** state 不认识、无法归类的行数。 */
    unknownStates: number
    /** `failures / attempts`；没有尝试时为 `undefined`。 */
    failureRate?: number
    /** 计入失败率的失败明细（新的在前）。 */
    incidents: DeployIncident[]
}

/** 归一化一个 state 字符串（认连字符与驼峰两种拼写，大小写不敏感）。 */
function normalizeState(value: string): string {
    return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

/** 一行的归类；未知 state 返回 `unknown`（调用方记缺口）。 */
export function deployBucketOf(state: string): DeployBucket {
    switch (normalizeState(state)) {
        case 'deployed':
            return 'attempt'
        case 'verified':
            return 'verification'
        case 'failed':
        case 'verify-failed':
        case 'verifyfailed':
            return 'failure'
        case 'rolled-back':
        case 'rolledback':
        case 'rollback-failed':
        case 'rollbackfailed':
            return 'rollback'
        case 'refused':
            return 'refused'
        default:
            return 'unknown'
    }
}

/** 从一行原始 JSON 里取出可用的部署行；字段不全时 `undefined`（调用方记缺口）。 */
export function deployRowOf(value: Record<string, unknown>): DeployRow | undefined {
    const at = value['at']
    const environment = value['environment']
    const state = value['state']
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    if (typeof environment !== 'string' || environment === '') return undefined
    if (typeof state !== 'string' || state === '') return undefined
    const revision = value['revision']
    const id = value['id']
    const rollbackOf = value['rollbackOf']
    return {
        at,
        environment,
        revision: typeof revision === 'string' ? revision : '(未记录)',
        state,
        ...(typeof id === 'string' && id !== '' ? { id } : {}),
        ...(typeof rollbackOf === 'string' && rollbackOf !== '' ? { rollbackOf } : {}),
    }
}

/**
 * 按环境把部署行折成"尝试 / 失败 / 回滚"三个数字。
 *
 * 规则（README 有同样的表）：
 *  - `deployed` = 一次尝试；同一环境上还没结算又来一次 `deployed` 时，前一次按"被顶替"
 *    处理（它照旧算一次尝试，但不会因此再计一次失败）；
 *  - `verified` = 前面那次尝试成功，结算掉；没有对应 `deployed` 行的 `verified` 记进
 *    `orphanVerifications`（那次部署多半在窗口外），既不算尝试也不算失败；
 *  - `failed` / `verify-failed` = 这次尝试失败，计一次失败；归因到还开着的那次部署，
 *    没有开着的就是"台账里没有 deployed 行的独立失败"——它本身也是一次尝试
 *    （否则失败率会算出大于 100% 的数）；
 *  - `rolled-back` / `rollback-failed` = 回滚动作，`rollbacks + 1`；它**不重复计失败**——
 *    如果它 `rollbackOf` 指向的那次失败已经计过，就只算回滚；否则它本身就是那次失败；
 *  - `refused` = 没碰环境（被 checklist 或人拦下），既不是尝试也不是失败。
 */
export function foldDeployments(rows: readonly DeployRow[]): DeployStats {
    const ordered = rows.map((row, index) => ({ row, index })).sort((left, right) => left.row.at - right.row.at || left.index - right.index)
    const open = new Map<string, DeployRow>()
    const countedFailures = new Set<string>()
    const incidents: DeployIncident[] = []
    let attempts = 0
    let failures = 0
    let rollbacks = 0
    let refused = 0
    let verifications = 0
    let orphanVerifications = 0
    let unknownStates = 0

    for (const { row } of ordered) {
        const bucket = deployBucketOf(row.state)
        if (bucket === 'unknown') {
            unknownStates += 1
            continue
        }
        if (bucket === 'refused') {
            refused += 1
            continue
        }
        if (bucket === 'attempt') {
            attempts += 1
            open.set(row.environment, row)
            continue
        }
        if (bucket === 'verification') {
            verifications += 1
            if (open.get(row.environment) === undefined) orphanVerifications += 1
            open.delete(row.environment)
            continue
        }
        if (bucket === 'rollback') rollbacks += 1
        const current = open.get(row.environment)
        // 回滚是"某次失败"的补救动作：同一目标的失败已经计过就不再计一次。
        if (bucket === 'rollback' && row.rollbackOf !== undefined && countedFailures.has(row.rollbackOf)) {
            open.delete(row.environment)
            continue
        }
        failures += 1
        // 没有开着的那次部署 → 这行自己就是一次尝试（否则 failures/attempts 会超过 1）。
        if (current === undefined) attempts += 1
        else if (current.id !== undefined) countedFailures.add(current.id)
        incidents.push({
            environment: row.environment,
            revision: row.revision,
            at: row.at,
            state: row.state,
            ...(current?.id === undefined ? {} : { attributedTo: current.id }),
        })
        open.delete(row.environment)
    }

    return {
        rows: rows.length,
        attempts,
        failures,
        rollbacks,
        refused,
        verifications,
        orphanVerifications,
        unknownStates,
        ...(attempts === 0 ? {} : { failureRate: failures / attempts }),
        incidents: incidents.reverse(),
    }
}

// --- 发布台账（纯函数） -------------------------------------------------------

/** 发布行（`dsh-evidence-gate` 的 `ReleaseRow` 子集）。 */
export interface ReleaseRow {
    at: number
    version: string
    tag?: string
    missionCount: number
    receiptCount: number
}

/** 从一行原始 JSON 里取出可用的发布行。 */
export function releaseRowOf(value: Record<string, unknown>): ReleaseRow | undefined {
    const at = value['at']
    const version = value['version']
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    if (typeof version !== 'string' || version === '') return undefined
    const tag = value['tag']
    const countOf = (key: string): number => {
        const list = value[key]
        return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry !== '').length : 0
    }
    return {
        at,
        version,
        ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
        missionCount: countOf('missionIds'),
        receiptCount: countOf('receiptIds'),
    }
}

// --- 读 trail（I/O 隔离在这里） -----------------------------------------------

/** 一个 mission 在窗口内的最小事实集。 */
export interface TrailMission {
    id: string
    title: string
    createdAt: number
    status: MissionRecord['status']
    stage?: string
    approvedAt?: number
}

/** 采集到的原始事实；`computeMetrics` 只吃这个，不再碰文件系统。 */
export interface Trail {
    now: number
    windowDays: number
    windowStart: number
    /** 窗口内（按 `createdAt`）的 mission，新的在前。 */
    missions: TrailMission[]
    /** 因窗口被排除的 mission 数（**要报告**，否则读数会被误读成全量）。 */
    excludedByWindow: number
    /** 仓库里一共有多少个 mission（含窗口外的）。 */
    missionsTotal: number
    /** missionId → 回执签发时间（升序）。 */
    receipts: Record<string, number[]>
    /** missionId → 门禁记录（按 checkedAt 升序）。 */
    gates: Record<string, GateRecord[]>
    /** missionId → 阶段结果（按 enteredAt 升序）。 */
    stages: Record<string, StageResult[]>
    deployments: LedgerRead
    releases: LedgerRead
    deployRows: DeployRow[]
    releaseRows: ReleaseRow[]
    /** 有名字的缺口（读不到/读不全的来源）。 */
    gaps: string[]
}

/** 采集参数。 */
export interface CollectOptions {
    store: MissionStore
    /** 注入的时钟：度量是"现在"的函数，测试必须能钉住它。 */
    now: number
    windowDays: number
}

function safeRead<T>(read: () => T, gap: string, gaps: string[]): T | undefined {
    try {
        return read()
    } catch (error) {
        gaps.push(`${gap}：${(error as Error).message}`)
        return undefined
    }
}

/** 读出窗口内的全部事实。所有失败都变成 `gaps` 里的一句中文，绝不抛出。 */
export function collectTrail(options: CollectOptions): Trail {
    const { store, now, windowDays } = options
    const layout = store.layout
    const windowStart = now - windowDays * DAY_MS
    const gaps: string[] = []

    const all = safeRead(() => store.list(), `missions 目录读不到（${layout.missionsDir}）`, gaps) ?? []
    const known = new Set(all.map((mission) => mission.id))
    // store.list() 只返回能解析的 mission.json；目录在、记录读不到的分母不能悄悄少一个。
    for (const entry of listDir(layout.missionsDir)) {
        if (known.has(entry)) continue
        const full = path.join(layout.missionsDir, entry)
        let isDirectory = false
        try {
            isDirectory = fs.statSync(full).isDirectory()
        } catch {
            isDirectory = false
        }
        if (isDirectory) gaps.push(`missions/${entry}/mission.json 读不到或不是合法记录：该 mission 不计入任何指标`)
    }

    const inWindow = all.filter((mission) => mission.createdAt >= windowStart)
    const trailMissions: TrailMission[] = inWindow.map((mission) => ({
        id: mission.id,
        title: mission.title,
        createdAt: mission.createdAt,
        status: mission.status,
        ...(mission.stage === undefined ? {} : { stage: mission.stage }),
        ...(mission.spec?.approvedAt === undefined ? {} : { approvedAt: mission.spec.approvedAt }),
    }))

    const receipts: Record<string, number[]> = {}
    const gates: Record<string, GateRecord[]> = {}
    const stages: Record<string, StageResult[]> = {}
    for (const mission of trailMissions) {
        const readReceipts = safeRead(() => store.readReceipts(mission.id), `mission ${mission.id} 的 receipts 读不到`, gaps)
        receipts[mission.id] = (readReceipts ?? []).map((receipt) => receipt.issuedAt).sort((left, right) => left - right)
        const readGates = safeRead(() => store.readGates(mission.id), `mission ${mission.id} 的 gates 读不到`, gaps)
        gates[mission.id] = (readGates ?? []).slice().sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id))
        const readStages = safeRead(() => store.listStageResults(mission.id), `mission ${mission.id} 的 stages 读不到`, gaps)
        stages[mission.id] = (readStages ?? []).slice().sort((left, right) => left.enteredAt - right.enteredAt)
    }

    const deployments = readTrailLedger(layout, 'deployments')
    const releases = readTrailLedger(layout, 'releases')
    for (const problem of deployments.problems) gaps.push(`${path.relative(layout.cwd, deployments.file)}：${problem}`)
    for (const problem of releases.problems) gaps.push(`${path.relative(layout.cwd, releases.file)}：${problem}`)

    const deployRows: DeployRow[] = []
    deployments.rows.forEach((row, index) => {
        const parsed = deployRowOf(row)
        if (parsed === undefined) {
            gaps.push(`${path.relative(layout.cwd, deployments.file)} 第 ${index + 1} 行不是部署记录（缺 at/environment/state）：已跳过`)
            return
        }
        deployRows.push(parsed)
    })
    const releaseRows: ReleaseRow[] = []
    releases.rows.forEach((row, index) => {
        const parsed = releaseRowOf(row)
        if (parsed === undefined) {
            gaps.push(`${path.relative(layout.cwd, releases.file)} 第 ${index + 1} 行不是发布记录（缺 at/version）：已跳过`)
            return
        }
        releaseRows.push(parsed)
    })

    return {
        now,
        windowDays,
        windowStart,
        missions: trailMissions,
        excludedByWindow: all.length - inWindow.length,
        missionsTotal: all.length,
        receipts,
        gates,
        stages,
        deployments,
        releases,
        deployRows,
        releaseRows,
        gaps,
    }
}

// --- 计算（纯函数） -----------------------------------------------------------

/** 在飞 mission 的一条记录。 */
export interface InFlightFact {
    missionId: string
    title: string
    createdAt: number
    ageMs: number
    /** 当前阶段 id；`undefined` = 还没进入任何阶段。 */
    stage?: string
    /** 当前阶段工件的状态（`entered` / `failed` / `passed` / `skipped`）。 */
    stageState?: StageResult['state']
    enteredAt?: number
    /** 最新一次门禁裁决（不限 source）。 */
    lastGate?: GateState
    lastGateAt?: number
}

/** 门禁失败的一条事实：交付前最新那次门禁不是 PASS。 */
export interface GateFailureFact {
    missionId: string
    title: string
    state: GateState
    source: string
    reason: string
    checkedAt: number
}

/** 按 (source, reason) 归组后的计数。 */
export interface GateReasonCount {
    source: string
    reason: string
    count: number
}

/** 最近发布的一条。 */
export interface ReleaseFact {
    at: number
    version: string
    tag?: string
    missionCount: number
    receiptCount: number
}

/** 交付度量全集（每个数字都带自己的样本量）。 */
export interface DeliveryMetrics {
    now: number
    windowDays: number
    windowStart: number
    missions: {
        /** 仓库里的 mission 总数。 */
        total: number
        /** 窗口内（按创建时间）。 */
        inWindow: number
        /** 被窗口排除。 */
        excluded: number
        /** 窗口内已签发回执的。 */
        delivered: number
        /** 窗口内没有回执的（在飞）。 */
        inFlight: number
        /** 在飞里还没被人工批准规格的（`spec.approvedAt` 为空）。 */
        pendingApproval: number
    }
    leadTime: DurationStats
    approvalWait: DurationStats
    approvalWaitFacts: { missionId: string; title: string; createdAt: number; approvedAt: number; ms: number }[]
    gateFailure: {
        /** 有回执的 mission 数（分母）。 */
        delivered: number
        pass: number
        warn: number
        block: number
        /**
         * 交付前**没有任何门禁记录**的已交付 mission 数。
         *
         * 它们既不是 PASS 也不是"不是 PASS"：分母仍然含它们（不悄悄缩小分母），
         * 但报告必须把这个洞说出来（`无门禁记录 w`），否则 66% 会被读成"全都测过"。
         */
        noGate: number
        failures: GateFailureFact[]
        /** `failures / delivered`；没有已交付 mission 时 `undefined`。 */
        rate?: number
        /** 按 (source, reason) 归组，计数降序；完整列表（渲染时取前 N）。 */
        reasons: GateReasonCount[]
    }
    deployments: DeployStats & {
        present: boolean
        file: string
        problems: string[]
        excludedByWindow: number
    }
    releases: {
        present: boolean
        file: string
        problems: string[]
        rowsTotal: number
        excludedByWindow: number
        recent: ReleaseFact[]
    }
    inFlight: InFlightFact[]
    gaps: string[]
}

/** 最新一次门禁（`checkedAt` 最大，平局取 id 大的），可限定在某个时点之前。 */
function newestGateBefore(gates: readonly GateRecord[], before: number): GateRecord | undefined {
    const usable = gates.filter((gate) => gate.checkedAt <= before)
    return usable.at(-1)
}

/**
 * 把采集到的事实折成度量。纯函数：同样的 trail 永远得到同样的读数。
 * @param trail - `collectTrail` 的输出。
 */
export function computeMetrics(trail: Trail): DeliveryMetrics {
    const inFlight: InFlightFact[] = []
    const delivered: { mission: TrailMission; deliveredAt: number }[] = []
    const leadSamples: number[] = []
    const approvalWaitFacts: DeliveryMetrics['approvalWaitFacts'] = []
    let pass = 0
    let warn = 0
    let block = 0
    let noGate = 0
    const failures: GateFailureFact[] = []
    let pendingApproval = 0

    for (const mission of trail.missions) {
        const receiptTimes = trail.receipts[mission.id] ?? []
        const firstReceipt = receiptTimes[0]
        if (mission.approvedAt === undefined) pendingApproval += 1
        if (firstReceipt === undefined) {
            const stages = trail.stages[mission.id] ?? []
            const current = mission.stage === undefined ? undefined : stages.find((result) => result.stageId === mission.stage)
            const last = (trail.gates[mission.id] ?? []).at(-1)
            inFlight.push({
                missionId: mission.id,
                title: mission.title,
                createdAt: mission.createdAt,
                ageMs: Math.max(0, trail.now - mission.createdAt),
                ...(mission.stage === undefined ? {} : { stage: mission.stage }),
                ...(current === undefined ? {} : { stageState: current.state, enteredAt: current.enteredAt }),
                ...(last === undefined ? {} : { lastGate: last.state, lastGateAt: last.checkedAt }),
            })
            continue
        }
        delivered.push({ mission, deliveredAt: firstReceipt })
        leadSamples.push(firstReceipt - mission.createdAt)
        if (mission.approvedAt !== undefined) {
            approvalWaitFacts.push({
                missionId: mission.id,
                title: mission.title,
                createdAt: mission.createdAt,
                approvedAt: mission.approvedAt,
                ms: mission.approvedAt - mission.createdAt,
            })
        }
        // "交付前最后一个门禁"：只看 `checkedAt ≤ 首个回执` 的记录——回执之后才跑的
        // 门禁（例如交付后补跑的质量门禁）不能改写这次交付的历史。
        const gate = newestGateBefore(trail.gates[mission.id] ?? [], firstReceipt)
        if (gate === undefined) {
            // 交付了但没有任何门禁记录：不是 PASS，也不是"不是 PASS"——数出来，说清楚。
            noGate += 1
            continue
        }
        if (gate.state === 'PASS') pass += 1
        if (gate.state === 'WARN') warn += 1
        if (gate.state === 'BLOCK') block += 1
        if (gate.state !== 'PASS') {
            failures.push({
                missionId: mission.id,
                title: mission.title,
                state: gate.state,
                source: gate.source,
                reason: gate.reason,
                checkedAt: gate.checkedAt,
            })
        }
    }

    const grouped = new Map<string, GateReasonCount>()
    for (const failure of failures) {
        const key = `${failure.source}\u0000${failure.reason}`
        const entry = grouped.get(key) ?? { source: failure.source, reason: failure.reason, count: 0 }
        entry.count += 1
        grouped.set(key, entry)
    }

    const deployStats = foldDeployments(trail.deployRows.filter((row) => row.at >= trail.windowStart))
    const releaseRows = trail.releaseRows.map((row, index) => ({ row, index }))
    const inWindowReleases = releaseRows
        .filter((entry) => entry.row.at >= trail.windowStart)
        .sort((left, right) => right.row.at - left.row.at || right.index - left.index)
    const recentReleases = inWindowReleases.slice(0, RECENT_RELEASE_LIMIT)

    return {
        now: trail.now,
        windowDays: trail.windowDays,
        windowStart: trail.windowStart,
        missions: {
            total: trail.missionsTotal,
            inWindow: trail.missions.length,
            excluded: trail.excludedByWindow,
            delivered: delivered.length,
            inFlight: inFlight.length,
            pendingApproval,
        },
        leadTime: durationStats(leadSamples),
        approvalWait: durationStats(approvalWaitFacts.map((fact) => fact.ms)),
        approvalWaitFacts,
        gateFailure: {
            delivered: delivered.length,
            pass,
            warn,
            block,
            noGate,
            failures,
            ...(delivered.length === 0 ? {} : { rate: failures.length / delivered.length }),
            reasons: [...grouped.values()].sort((left, right) => right.count - left.count || left.source.localeCompare(right.source) || left.reason.localeCompare(right.reason)),
        },
        deployments: {
            ...deployStats,
            present: trail.deployments.present,
            file: trail.deployments.file,
            problems: trail.deployments.problems,
            excludedByWindow: trail.deployRows.length - deployStats.rows,
        },
        releases: {
            present: trail.releases.present,
            file: trail.releases.file,
            problems: trail.releases.problems,
            rowsTotal: trail.releaseRows.length,
            excludedByWindow: trail.releaseRows.length - inWindowReleases.length,
            recent: recentReleases.map((entry) => ({
                at: entry.row.at,
                version: entry.row.version,
                ...(entry.row.tag === undefined ? {} : { tag: entry.row.tag }),
                missionCount: entry.row.missionCount,
                receiptCount: entry.row.receiptCount,
            })),
        },
        inFlight: inFlight.sort((left, right) => left.createdAt - right.createdAt),
        gaps: [...trail.gaps, ...deployProblemsOf(trail), ...(noGate === 0 ? [] : [noGateGap(noGate)])],
    }
}

/** 交付了却没有门禁记录：不静默算作"通过"，也不静默排除出分母。 */
function noGateGap(noGate: number): string {
    return `有 ${noGate} 个已交付 mission 在交付前没有任何门禁记录：它们既不算通过也不算失败，但仍在门禁失败率的分母里`
}

/** 部署台账里"state 不认识"或"验收行没有对应部署行"都要成为缺口（数字只从 `foldDeployments` 来）。 */
function deployProblemsOf(trail: Trail): string[] {
    const inWindow = trail.deployRows.filter((row) => row.at >= trail.windowStart)
    const stats = foldDeployments(inWindow)
    const gaps: string[] = []
    if (stats.unknownStates > 0) {
        const states = [...new Set(inWindow.filter((row) => deployBucketOf(row.state) === 'unknown').map((row) => row.state))].join('、')
        gaps.push(`部署台账里有 ${stats.unknownStates} 行的 state 不是部署门禁写的值（${states}）：既不计入尝试也不计入失败`)
    }
    if (stats.orphanVerifications > 0) {
        gaps.push(`部署台账里有 ${stats.orphanVerifications} 行 verified 在窗口内没有对应的 deployed 行（那次部署多半在窗口外）：既不算尝试也不算成功`)
    }
    return gaps
}

/** 采集 + 计算（I/O 只发生在 `collectTrail` 里）。 */
export function collectMetrics(options: CollectOptions): DeliveryMetrics {
    return computeMetrics(collectTrail(options))
}

// --- 渲染 --------------------------------------------------------------------

/** 渲染选项。 */
export interface RenderOptions {
    /** 工作区根（报告里给相对路径）。 */
    cwd: string
    /** 在飞列表最多显示几条（`config.metrics.maxInFlight`）。 */
    maxInFlight: number
    /** 参数被校正/覆盖时给读报告的人一句说明（可选）。 */
    note?: string | undefined
}

/** `6.0 天`。 */
function days(ms: number | undefined): string {
    return ms === undefined ? '(无)' : `${(ms / DAY_MS).toFixed(1)} 天`
}

/** `66.7%（2/3）`。 */
function ratio(part: number, whole: number): string {
    return `${((part / whole) * 100).toFixed(1)}%（${part}/${whole}）`
}

function short(value: string, max = 72): string {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/** 一条时长的指标行：结果 + 样本量 + 口径。`noData` 是"没有数据"的原因。 */
function durationRow(label: string, stats: DurationStats, noData: string, scope: string): string {
    const sample = `n=${stats.n}`
    if (stats.status === 'no-data') {
        return `| ${cell(label)} | 没有数据：${cell(noData)} | ${sample} | ${cell(scope)} |`
    }
    if (stats.status === 'one-sample') {
        return `| ${cell(label)} | 中位数 ${days(stats.median)} / p90 ${days(stats.p90)}（单样本：两者必然相等，**不代表分布**） | ${sample}（样本不足） | ${cell(scope)} |`
    }
    return `| ${cell(label)} | 中位数 ${days(stats.median)} / p90 ${days(stats.p90)} | ${sample} | ${cell(scope)} |`
}

/** 报告里的路径：工作区相对路径（读的人不用自己减前缀）。 */
function rel(cwd: string, file: string): string {
    return path.relative(cwd, file) || file
}

/** 部署口径那三行共用的样本量与口径文本。 */
function deployScope(metrics: DeliveryMetrics): string {
    const { deployments } = metrics
    if (!deployments.present) return '无部署台账'
    const parts = [`台账 ${deployments.rows} 行（窗口内）`]
    if (deployments.refused > 0) parts.push(`refused ${deployments.refused} 行不计入尝试`)
    if (deployments.verifications > 0) parts.push(`验收行 ${deployments.verifications}${deployments.orphanVerifications > 0 ? `（其中 ${deployments.orphanVerifications} 行没有对应的 deployed 行）` : ''}`)
    if (deployments.unknownStates > 0) parts.push(`未知 state ${deployments.unknownStates} 行`)
    if (deployments.excludedByWindow > 0) parts.push(`窗口外 ${deployments.excludedByWindow} 行`)
    return parts.join('；')
}

function deploymentRow(metrics: DeliveryMetrics, cwd: string): string {
    const { deployments } = metrics
    const sample = deployments.present ? `${deployments.attempts} 次尝试` : 'n=0'
    if (!deployments.present) {
        return `| 部署失败率（一次部署尝试后出现 failed/rolled-back） | 没有数据：无部署台账（${cell(rel(cwd, deployments.file))} 不存在） | ${sample} | 台账缺失时说"读不到"，不说"零失败" |`
    }
    if (deployments.attempts === 0) {
        return `| 部署失败率（一次部署尝试后出现 failed/rolled-back） | 没有数据：台账 ${deployments.rows} 行里没有可归因的部署尝试（只有 refused/验收行） | ${sample} | ${cell(deployScope(metrics))} |`
    }
    return `| 部署失败率（一次部署尝试后出现 failed/rolled-back） | ${ratio(deployments.failures, deployments.attempts)}次部署尝试失败 | ${sample} | ${cell(deployScope(metrics))} |`
}

function rollbackRow(metrics: DeliveryMetrics, cwd: string): string {
    const { deployments } = metrics
    if (!deployments.present) {
        return `| 回滚行数（带 rollbackOf 的行） | 没有数据：无部署台账（${cell(rel(cwd, deployments.file))} 不存在） | n=0 | 没有台账时说"读不到"，不说 0 次回滚 |`
    }
    return `| 回滚行数（带 rollbackOf 的行） | ${deployments.rollbacks} 行 | ${deployments.rows} 行台账（窗口内） | 回滚动作本身；同一次失败的补救只算一次失败 |`
}

function inFlightRow(metrics: DeliveryMetrics, maxInFlight: number): string {
    if (metrics.missions.inWindow === 0) {
        return '| 在飞 mission（没有回执） | 没有数据：窗口内没有 mission | n=0 | 窗口按 mission 创建时间 |'
    }
    if (metrics.inFlight.length === 0) {
        return `| 在飞 mission（没有回执） | 没有数据：窗口内没有未交付的 mission（${metrics.missions.delivered} 个都签发了回执） | n=${metrics.missions.inWindow} | 窗口按 mission 创建时间 |`
    }
    const oldest = metrics.inFlight[0]
    return `| 在飞 mission（没有回执） | ${metrics.inFlight.length} 个（最老 ${days(oldest?.ageMs)}） | 窗口内 ${metrics.missions.inWindow} 个 mission | 最多列出 ${Math.max(1, maxInFlight)} 个，最老的在前 |`
}

function releaseRow(metrics: DeliveryMetrics, cwd: string): string {
    const { releases } = metrics
    if (!releases.present) {
        return `| 最近发布（releases.jsonl） | 没有数据：无发布台账（${cell(rel(cwd, releases.file))} 不存在） | n=0 | 发布台账由 dsh-evidence-gate 的 release_record 追加 |`
    }
    if (releases.recent.length === 0) {
        return `| 最近发布（releases.jsonl） | 没有数据：台账 ${releases.rowsTotal} 条都在窗口外 | n=0（台账 ${releases.rowsTotal} 条） | 窗口按发布记录时间 |`
    }
    const newest = releases.recent[0]
    return `| 最近发布（releases.jsonl） | ${releases.recent.length} 条（最新 ${cell(newest?.version ?? '')} @ ${cell(formatTime(newest?.at ?? metrics.now))}） | 台账 ${releases.rowsTotal} 条，窗口内 ${releases.recent.length} 条 | 显示最新 ${RECENT_RELEASE_LIMIT} 条 |`
}

/** 门禁失败率那一行。 */
function gateFailureRow(metrics: DeliveryMetrics): string {
    const { gateFailure } = metrics
    const scope = '交付前最后一次门禁（checkedAt ≤ 首个回执）不是 PASS 即算失败；WARN 也算'
    if (gateFailure.delivered === 0) {
        return `| 门禁失败率（交付前最后一次门禁 ≠ PASS） | 没有数据：窗口内没有已交付的 mission（没有回执就没有"交付前"这个时点） | n=0 | ${cell(scope)} |`
    }
    return `| 门禁失败率（交付前最后一次门禁 ≠ PASS） | ${ratio(gateFailure.failures.length, gateFailure.delivered)}个已交付 mission | n=${gateFailure.delivered} | ${cell(scope)} |`
}

/** 1. 指标表。 */
function renderTable(metrics: DeliveryMetrics, options: RenderOptions): string[] {
    const leadReason = metrics.missions.inWindow === 0 ? '窗口内没有 mission' : '窗口内没有已交付的 mission（没有回执）'
    const approvalReason = metrics.missions.inWindow === 0 ? '窗口内没有 mission' : '窗口内没有已记录 spec.approvedAt 的 mission'
    return [
        '### 指标（每个数字都带样本量）',
        '',
        '| 指标 | 结果 | 样本量 | 口径 |',
        '|------|------|--------|------|',
        durationRow('lead time（创建 → 首个回执）', metrics.leadTime, leadReason, `中位数/p90 用 ${QUANTILE_METHOD}（R-7）；首个回执 = 交付时点`),
        durationRow('审批等待（创建 → spec.approvedAt）', metrics.approvalWait, approvalReason, '人工等待是流程方能改的部分；只统计已批准的 mission'),
        gateFailureRow(metrics),
        deploymentRow(metrics, options.cwd),
        rollbackRow(metrics, options.cwd),
        inFlightRow(metrics, options.maxInFlight),
        releaseRow(metrics, options.cwd),
    ]
}

/** 2. 门禁失败原因（按 source 归组）。 */
function renderGateReasons(metrics: DeliveryMetrics): string[] {
    const { gateFailure } = metrics
    const lines = ['', `### 门禁失败原因（按 source 归组，最多 ${GATE_REASON_TOP_N} 组）`, '']
    if (gateFailure.delivered === 0) {
        lines.push('- 没有数据：窗口内没有已交付的 mission，无法判断"交付前那次门禁"的结果。')
        return lines
    }
    if (gateFailure.failures.length === 0) {
        lines.push('- 没有数据：本次样本里没有"交付前最后一次门禁不是 PASS"的 mission（这不是"没有失败"，是样本里没出现失败）。')
        lines.push(gateStatsLine(metrics))
        return lines
    }
    if (gateFailure.reasons.length === 0) {
        lines.push(`- ${gateFailure.warn} 个 WARN / ${gateFailure.block} 个 BLOCK，但原因文本为空：检查门禁记录是否被改写过。`)
        lines.push(gateStatsLine(metrics))
        return lines
    }
    for (const reason of gateFailure.reasons.slice(0, GATE_REASON_TOP_N)) {
        lines.push(`- \`${reason.source}\` ×${reason.count}：${short(reason.reason)}`)
    }
    if (gateFailure.reasons.length > GATE_REASON_TOP_N) {
        lines.push(`（另有 ${gateFailure.reasons.length - GATE_REASON_TOP_N} 组未显示：共 ${gateFailure.reasons.length} 组）`)
    }
    lines.push(gateStatsLine(metrics))
    return lines
}

/** 门禁那一段的统计口径行（按 source 合计、分母、各状态计数、无门禁记录数）。 */
function gateStatsLine(metrics: DeliveryMetrics): string {
    const { gateFailure } = metrics
    const parts: string[] = []
    if (gateFailure.failures.length > 0) parts.push(`按 source 合计：${sourceTotals(gateFailure.failures)}`)
    parts.push(`分母：${gateFailure.delivered} 个已交付 mission`)
    const noGate = gateFailure.noGate > 0 ? ` / 无门禁记录 ${gateFailure.noGate}` : ''
    parts.push(`PASS ${gateFailure.pass} / WARN ${gateFailure.warn} / BLOCK ${gateFailure.block}${noGate}`)
    return `（${parts.join('；')}）`
}

/** `dsh-quality-gate ×2、dsh-standards-gate ×1`（按次数降序，平局按名字）。 */
function sourceTotals(failures: readonly GateFailureFact[]): string {
    const totals = new Map<string, number>()
    for (const failure of failures) totals.set(failure.source, (totals.get(failure.source) ?? 0) + 1)
    return [...totals.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([source, count]) => `${source} ×${count}`)
        .join('、')
}

/** 3. 在飞 mission。 */
function renderInFlight(metrics: DeliveryMetrics, options: RenderOptions): string[] {
    const limit = Math.max(1, options.maxInFlight)
    const lines = ['', `### 在飞 mission（没有回执，最老的在前；最多 ${limit} 个）`, '']
    if (metrics.inFlight.length === 0) {
        lines.push(
            metrics.missions.inWindow === 0
                ? '- 没有数据：窗口内没有 mission（trail 里没有可统计的对象）。'
                : `- 没有数据：窗口内 ${metrics.missions.delivered} 个 mission 都已签发回执，没有在飞的。`,
        )
        return lines
    }
    for (const fact of metrics.inFlight.slice(0, limit)) {
        const stage = fact.stage === undefined ? '还没有进入阶段' : `阶段 ${fact.stage}（${fact.stageState ?? '无工件'}${fact.enteredAt === undefined ? '' : ` @ ${formatTime(fact.enteredAt)}`}）`
        const gate = fact.lastGate === undefined ? '无门禁记录' : `最近门禁 ${fact.lastGate} @ ${formatTime(fact.lastGateAt ?? metrics.now)}`
        lines.push(`- \`${fact.missionId}\`（${short(fact.title, 40)}）：已 ${days(fact.ageMs)}，${stage}，${gate}`)
    }
    const hidden = metrics.inFlight.length - limit
    if (hidden > 0) lines.push(`（另有 ${hidden} 个未显示：用 metrics.maxInFlight 或 action 入参放宽上限）`)
    return lines
}

/** 4. 最近发布。 */
function renderReleases(metrics: DeliveryMetrics, cwd: string): string[] {
    const { releases } = metrics
    const lines = ['', `### 最近发布（releases.jsonl 最新 ${RECENT_RELEASE_LIMIT} 条）`, '']
    if (!releases.present) {
        lines.push(`- 没有数据：无发布台账（${rel(cwd, releases.file)} 不存在）——发布由 dsh-evidence-gate 的 \`release_record\` 追加。`)
        return lines
    }
    if (releases.recent.length === 0) {
        lines.push(`- 没有数据：台账 ${releases.rowsTotal} 条都在窗口外（窗口 ${metrics.windowDays} 天）。`)
        return lines
    }
    for (const release of releases.recent) {
        const tag = release.tag === undefined ? '' : `（tag ${release.tag}）`
        lines.push(`- ${release.version}${tag} @ ${formatTime(release.at)}：${release.missionCount} 个 mission、${release.receiptCount} 张回执`)
    }
    if (releases.excludedByWindow > 0) lines.push(`（另有 ${releases.excludedByWindow} 条在窗口外）`)
    return lines
}

/** 5. 数据缺口（不是 0，是读不到）。 */
function renderGaps(metrics: DeliveryMetrics): string[] {
    const lines = ['', '### 数据缺口（不是 0，是读不到）', '']
    if (metrics.missions.total === 0) {
        lines.push('- 没有可读的来源：本仓库还没有任何 mission 记录，也还没有部署/发布台账——上面的"没有数据"是"读不到记录"，不是"没有问题"。')
        return lines
    }
    if (metrics.gaps.length === 0) {
        lines.push(`- 无：本次读到的文件都可解析（${metrics.missions.inWindow} 个窗口内 mission、部署台账 ${metrics.deployments.rows} 行、发布台账 ${metrics.releases.rowsTotal} 条）。`)
        return lines
    }
    for (const gap of metrics.gaps) lines.push(`- ${gap}`)
    return lines
}

/**
 * 收尾那一行：**最有行动价值的发现**，限定一条，永远以 `下一步：` 开头。
 *
 * 优先级（先挑"人能改的"）：空 trail → 全在飞（审批是否卡住）→ 审批等待占比 →
 * 门禁失败率 → 部署失败/回滚 → 缺口 → 常规节奏提示。
 */
export function nextStepOf(metrics: DeliveryMetrics): string {
    const { missions, leadTime, approvalWait, gateFailure, deployments, releases } = metrics
    if (missions.inWindow === 0) {
        return `下一步：窗口内没有任何 mission 记录（窗口 ${metrics.windowDays} 天，仓库共 ${missions.total} 个）：trail 还是空的，先跑一条流水线（orchestrate({ action: "start", summary: "<任务名>" })），或用 action: "metrics" 的 windowDays 放宽窗口再看。`
    }
    if (missions.delivered === 0) {
        const oldest = metrics.inFlight[0]
        const where = oldest === undefined ? '（无在飞记录）' : `最老的 \`${oldest.missionId}\` 已 ${days(oldest.ageMs)}（${oldest.stage === undefined ? '还没进入阶段' : `阶段 ${oldest.stage}`}）`
        const approval = missions.pendingApproval > 0 ? `其中 ${missions.pendingApproval} 个连规格都还没批（spec.approvedAt 为空）：先把送审环节前置` : '先确认它卡在哪个阶段，再决定是拆任务还是补证据'
        return `下一步：窗口内 ${missions.inFlight} 个 mission 都还没有回执，${where}——${approval}。用 orchestrate({ action: "status" }) 看当前阶段。`
    }
    if (leadTime.status === 'ok' && approvalWait.status === 'ok' && approvalWait.median !== undefined && leadTime.median !== undefined && approvalWait.median > leadTime.median / 2) {
        return `下一步：审批等待中位数 ${days(approvalWait.median)}（n=${approvalWait.n}）> lead time 中位数的一半（${days(leadTime.median / 2)}）：先把送审环节前置——规格草稿一成形就送审，别等实现细节写完再等人工。`
    }
    if (gateFailure.rate !== undefined && gateFailure.rate >= 0.5) {
        const worst = gateFailure.reasons[0]
        const why = worst === undefined ? '原因文本为空，先查门禁记录' : `最常见的是 \`${worst.source}\` ×${worst.count}：${short(worst.reason, 48)}`
        return `下一步：交付前门禁失败率 ${ratio(gateFailure.failures.length, gateFailure.delivered)}偏高：${why}。把这一条修在交付之前，失败率会直接掉下来。`
    }
    if (deployments.present && deployments.attempts > 0 && deployments.failures > 0) {
        const incident = deployments.incidents[0]
        const where = incident === undefined ? '' : `（最近一次：${incident.environment} ${incident.revision} @ ${formatTime(incident.at)}）`
        return `下一步：部署失败率 ${ratio(deployments.failures, deployments.attempts)}、回滚 ${deployments.rollbacks} 行${where}：先看回滚行 note 里写的根因，再决定是补验证还是回滚流程本身有问题。`
    }
    if (metrics.gaps.length > 0) {
        return `下一步：有 ${metrics.gaps.length} 处数据读不到（见"数据缺口"）：这些来源上的读数是空白而不是 0，先把写入路径修好再看趋势。`
    }
    if (releases.recent.length > 0) {
        const newest = releases.recent[0]
        return `下一步：lead time 中位数 ${days(leadTime.median)}（n=${leadTime.n}）、审批等待中位数 ${days(approvalWait.median)}（n=${approvalWait.n}），最近发布 ${newest?.version ?? ''}：把这条基线记下来，下个窗口对比是否有改善（同一 action 再跑一次即可）。`
    }
    return `下一步：样本还小（已交付 ${missions.delivered} 个、在飞 ${missions.inFlight} 个）：先按当前节奏跑完几个 mission 再看趋势；要看更早的记录可以加大 windowDays。`
}

/** 完整报告（中文，末行固定是下一步）。 */
export function renderMetrics(metrics: DeliveryMetrics, options: RenderOptions): string {
    const lines: string[] = []
    lines.push(`## 交付度量（窗口 ${metrics.windowDays} 天：mission 创建时间 ≥ ${formatTime(metrics.windowStart)}；现在 ${formatTime(metrics.now)}）`)
    lines.push('')
    lines.push(`- 仓库 trail：\`${options.cwd}\``)
    lines.push(
        `- 样本：窗口内 mission ${metrics.missions.inWindow} 个（仓库共 ${metrics.missions.total} 个，被窗口排除 ${metrics.missions.excluded} 个）；已交付 ${metrics.missions.delivered} 个；在飞 ${metrics.missions.inFlight} 个`,
    )
    lines.push(
        `- 台账：部署 \`${metrics.deployments.present ? rel(options.cwd, metrics.deployments.file) : '缺失'}\`（窗口内 ${metrics.deployments.rows} 行）；发布 \`${metrics.releases.present ? rel(options.cwd, metrics.releases.file) : '缺失'}\`（窗口内 ${metrics.releases.rowsTotal - metrics.releases.excludedByWindow} 条）`,
    )
    if (options.note !== undefined && options.note !== '') lines.push(`- 参数：${options.note}`)
    lines.push('')
    lines.push(...renderTable(metrics, options))
    lines.push(...renderGateReasons(metrics))
    lines.push(...renderInFlight(metrics, options))
    lines.push(...renderReleases(metrics, options.cwd))
    lines.push(...renderGaps(metrics))
    lines.push('')
    lines.push('（这些数字描述的是**本仓库记录下来的 trail**，不是团队绩效：没被记录的 mission 不可见；"失败"是门禁记下的那次记录，不是生产判断。）')
    lines.push('')
    lines.push(nextStepOf(metrics))
    return lines.join('\n')
}

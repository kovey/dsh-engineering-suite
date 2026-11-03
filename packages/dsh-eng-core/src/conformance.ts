/**
 * 一致性总览（conformance）：一个 mission 离"规则允许的范围"有多远。
 *
 * 这套装置已经有三个面：`suite_status` 回答"配置好了吗"、`metrics` 回答"交付在
 * 变好还是变坏"、门禁记录回答"能不能交付"。**没有一个输出能横向比较两个
 * mission 的整体状态**，操作者只能自己在脑子里合成。这个模块就是那一面：
 *
 *  授权（authorization）  mandate 还在不在、算不算数；
 *  证据（evidence）       回执、覆盖范围与门禁来源；
 *  门禁（gates）          各来源最新裁决（含影子观察，但影子不计入裁决）；
 *  新鲜度（freshness）    策略版本、工作区指纹、基线与索引是否过时；
 *  一致性（consistency）  台账与产物之间的引用事实。
 *
 * **头行状态 = 最差维度**，只有四个取值：`conformant` / `partial` / `divergent`
 * / `unknown`。排序只写在一处（{@link HEADLINE_RANK}）：`divergent` < `partial` <
 * `conformant`，而 **`unknown` 永远不优于 `partial`**（未知不是好消息）。
 *
 * 三条硬约束（docs/CONFORMANCE.md §4）：
 *
 *  1. **只读、派生、可复现**：只读给定路径，不写任何文件；时钟由调用方注入；
 *  2. **零权力**：任何门禁都不得读它——它裁的是一致性，不是许可；
 *  3. **不做加权分数**：要比较就给同一组维度的分布，要趋势就用既有 `metrics`。
 *
 * 每个维度都带 `facts`（依据：哪些文件、哪几次记录、样本量）与 `blind`
 * （哪些东西根本看不见）。`unknown` 必须带原因，绝不输出"看起来健康"。
 *
 * @module dsh-eng-core/conformance
 */

import fs from 'node:fs'
import path from 'node:path'
import { formatTime } from './digest.js'
import {
    FINGERPRINT_ALGORITHM,
    changedPathsWithExcludes,
    fingerprintWithExcludes,
    sameFingerprint,
    usableFingerprintExcludes,
} from './fingerprint.js'
import { gitFingerprint } from './git.js'
import { readJson, readText } from './io.js'
import { mandateState, policyDifferences, policyFingerprint, readPolicySnapshot } from './mandate.js'
import type { PolicyFingerprint } from './mandate.js'
import { MissionStore } from './mission.js'
import { isInside, isSafeId, missionDir, resolvePath } from './paths.js'
import type { Layout } from './paths.js'
import { loadProjectConfig } from './project-config.js'
import type { EvidenceRecord, GateRecord, GitFingerprint, MissionRecord, Receipt } from './types.js'

/** 五个维度的固定顺序（所有输出、计数与测试都按这个顺序）。 */
export const CONFORMANCE_DIMENSIONS = ['authorization', 'evidence', 'gates', 'freshness', 'consistency'] as const

/** 一个维度的名字。 */
export type ConformanceDimensionName = (typeof CONFORMANCE_DIMENSIONS)[number]

/** 维度的中文标签（报告与计数共用同一份）。 */
export const CONFORMANCE_DIMENSION_LABEL: Readonly<Record<ConformanceDimensionName, string>> = {
    authorization: '授权',
    evidence: '证据',
    gates: '门禁',
    freshness: '新鲜度',
    consistency: '一致性',
}

/** 头行状态的固定顺序（分布输出按这个顺序）。 */
export const CONFORMANCE_HEADLINES = ['conformant', 'partial', 'divergent', 'unknown'] as const

/** 头行状态：五个维度里最差的那个。 */
export type ConformanceHeadline = (typeof CONFORMANCE_HEADLINES)[number]

/**
 * 头行状态的排序——**唯一一处**。
 *
 * `divergent` (0) < `partial` (1) < `conformant` (2)；`unknown` 与 `partial` 同档，
 * 而不是更高的档：未知不是好消息，绝不能因为"读不到"就把头行抬成 `conformant`。
 * 同档时 `partial` 胜出（一个已知的偏离至少比一个未知更具体）。
 */
export const HEADLINE_RANK: Readonly<Record<ConformanceHeadline, number>> = {
    divergent: 0,
    partial: 1,
    unknown: 1,
    conformant: 2,
}

/** 一个维度允许出现的状态（冒号前的基础 token）。 */
export const CONFORMANCE_DIMENSION_STATES: Readonly<Record<ConformanceDimensionName, readonly string[]>> = {
    authorization: ['ok', 'stale', 'legacy', 'withdrawn', 'missing'],
    evidence: ['full', 'partial', 'absent'],
    gates: ['pass', 'warn', 'block', 'no-record'],
    freshness: ['fresh', 'stale', 'unknown'],
    consistency: ['consistent', 'divergent', 'unknown'],
}

/** 一个维度如何折算成头行状态的一档。 */
interface StateRule {
    /** 0 = divergent，1 = partial 档，2 = conformant。 */
    tier: 0 | 1 | 2
    /** `true` = 这个状态本身是"没读到"，全为未知时头行才是 unknown。 */
    unknown?: boolean
}

/**
 * 维度状态 → 头行档位。**这是唯一的状态折算表**：新增一个维度状态必须在这里
 * 登记，否则按 `unknown`（fail closed）处理，而不是悄悄当作好状态。
 */
const DIMENSION_STATE_RULES: Readonly<Record<ConformanceDimensionName, Readonly<Record<string, StateRule>>>> = {
    authorization: {
        ok: { tier: 2 },
        legacy: { tier: 2 },
        stale: { tier: 1 },
        withdrawn: { tier: 0 },
        missing: { tier: 1, unknown: true },
    },
    evidence: {
        full: { tier: 2 },
        partial: { tier: 1 },
        absent: { tier: 0 },
    },
    gates: {
        pass: { tier: 2 },
        warn: { tier: 1 },
        block: { tier: 0 },
        'no-record': { tier: 1, unknown: true },
    },
    freshness: {
        fresh: { tier: 2 },
        stale: { tier: 1 },
        unknown: { tier: 1, unknown: true },
    },
    consistency: {
        consistent: { tier: 2 },
        divergent: { tier: 0 },
        unknown: { tier: 1, unknown: true },
    },
}

/** 一个维度的结论：状态、可读的依据、以及看不见的东西。 */
export interface ConformanceDimension {
    /**
     * 状态 token。带原因的形态是 `stale:<原因>` / `divergent:<原因>`：冒号前是
     * 机器可归类的 token（见 {@link CONFORMANCE_DIMENSION_STATES}），冒号后是
     * 给人读的原因。**绝不是状态码**。
     */
    state: string
    /** 一句话说清楚"看到了什么"。 */
    detail: string
    /** 依据：具体文件、记录 id、样本量。 */
    facts: string[]
    /** 盲区：这个维度**没能核对**的东西（空数组 = 没有已知盲区）。 */
    blind: string[]
}

/** 一个 mission 的一致性结论。 */
export interface MissionConformance {
    /** 被描述的 mission id；`undefined` = 仓库里还没有任何 mission。 */
    missionId?: string
    title?: string
    status?: string
    createdAt?: number
    dimensions: Record<ConformanceDimensionName, ConformanceDimension>
    headline: ConformanceHeadline
    /** 头行是怎么算出来的（点名最差维度）。 */
    headlineReason: string
    /** 五个维度的盲区合集（去重，按维度顺序）。 */
    blind: string[]
}

/** 一行 JSONL 台账的容错读取结果（`problems` 绝不静默）。 */
export interface ConformanceLedgerScan {
    name: string
    /** 实际读取的文件（绝对路径）：存在的候选优先，否则主路径。 */
    file: string
    present: boolean
    rows: Record<string, unknown>[]
    /** 无法使用的行，每条一句中文。 */
    problems: string[]
}

/** 证据要求的来源（仓库级配置，或内置默认值）。 */
export interface ConformanceEvidenceRequirements {
    /** 交付要求的质量门禁来源（`evidence-gate.gateSource`）。 */
    gateSource: string
    /** 回执必须引用的证据类型（`requiredEvidenceKinds`）。 */
    requiredKinds: string[]
    /** 值从哪来（`.dsh/evidence-gate.json` 或默认值）。 */
    source: string
    /** 这份要求本身看不见什么（例如宿主 profile 的配置）。 */
    blind: string[]
}

/**
 * 计算一次一致性总览所需的"当前世界"事实。
 *
 * 由 {@link buildConformanceContext} 读一次，随后同一份事实用于窗口内的每个
 * mission：策略版本、工作区指纹与仓库级台账不会在处理一个 mission 时改变。
 */
export interface ConformanceContext {
    layout: Layout
    /** 注入的时钟（目前只作为报告时间；任何判定都不依赖它漂移）。 */
    now: number
    /** 当前信任根策略（版本 + 文件摘要），用于与 mandate 比对并点名改动的文件。 */
    policy: PolicyFingerprint
    /** 当前工作区指纹（已排除 `.dsh/` 台账），用于与门禁记录比对。 */
    fingerprint: GitFingerprint
    requirements: ConformanceEvidenceRequirements
    ledgers: {
        plan: ConformanceLedgerScan
        releases: ConformanceLedgerScan
        deployments: ConformanceLedgerScan
    }
}

/** {@link buildConformanceContext} 的入参；测试可注入已观测好的世界。 */
export interface ConformanceContextOptions {
    layout: Layout
    now: number
    /** 已计算好的策略指纹（省略时读取信任根）。 */
    policy?: PolicyFingerprint
    /** 已观测的工作区指纹（省略时调用 git）。 */
    fingerprint?: GitFingerprint
    /** 已解析的证据要求（省略时读 `.dsh/evidence-gate.json` 或默认值）。 */
    requirements?: ConformanceEvidenceRequirements
}

/** 分布里的一个 mission（只保留比较所需的字段）。 */
export interface ConformanceWindowEntry {
    missionId: string
    createdAt: number
    headline: ConformanceHeadline
    /** 维度 → 基础状态 token（`stale:<原因>` 记作 `stale`）。 */
    dimensions: Record<ConformanceDimensionName, string>
}

/** 跨 mission 的一致性分布（**没有**加权分数）。 */
export interface ConformanceRollup {
    /** 窗口大小（最新 N 个）。 */
    limit: number
    /** 仓库里的 mission 总数。 */
    total: number
    /** 最新 N 个 mission，新的在前（按 createdAt 倒序，同刻按 id）。 */
    window: ConformanceWindowEntry[]
    headlines: Record<ConformanceHeadline, number>
    dimensions: Record<ConformanceDimensionName, Record<string, number>>
    /** 趋势：只有存在上一窗口（同样是 N 个）时才有。 */
    trend?: {
        /** 上一窗口的样本量。 */
        previousSize: number
        /** 上一窗口的头行计数。 */
        previousHeadlines: Record<ConformanceHeadline, number>
        /** 一句可直接渲染的"与上一窗口相比 …"。 */
        line: string
    }
    /** 这份分布看不见的东西（缺失台账、窗口外 mission、unknown 的样本…）。 */
    blind: string[]
}

/** 一次完整的一致性视图：当前 mission + 仓库级分布。 */
export interface ConformanceOverview {
    now: number
    workspace: string
    mission: MissionConformance
    rollup: ConformanceRollup
}

/** {@link missionConformance} 需要的最小入参。 */
export interface MissionConformanceOptions {
    layout: Layout
    missionId: string
    now: number
    policy?: PolicyFingerprint
    fingerprint?: GitFingerprint
    requirements?: ConformanceEvidenceRequirements
}

/** {@link conformanceRollup} 需要的最小入参。 */
export interface ConformanceRollupOptions {
    layout: Layout
    now: number
    /** 窗口大小（默认 {@link DEFAULT_CONFORMANCE_WINDOW}）。 */
    limit?: number
    policy?: PolicyFingerprint
    fingerprint?: GitFingerprint
    requirements?: ConformanceEvidenceRequirements
}

/** {@link conformanceOverview} 需要的最小入参。 */
export interface ConformanceOverviewOptions extends ConformanceRollupOptions {
    /** 要描述的 mission；省略 = 仓库里最新的 mission。 */
    missionId?: string
}

/** 跨 mission 分布的默认窗口（与 `metrics` 的在飞列表上限同为 20）。 */
export const DEFAULT_CONFORMANCE_WINDOW = 20

/** mandate.at 与 spec.approvedAt 同属一次审批的容差（毫秒）。 */
export const APPROVAL_AT_TOLERANCE_MS = 5_000

/** 默认的证据要求（与 `dsh-evidence-gate` 的默认值一致；读不到仓库配置时使用）。 */
const DEFAULT_GATE_SOURCE = 'dsh-quality-gate'
const DEFAULT_REQUIRED_EVIDENCE_KINDS: readonly string[] = ['command', 'test']
const DEFAULT_STANDARDS_FILE = '.dsh/standards.json'
const DEFAULT_BASELINE_FILE = '.dsh/standards-baseline.json'

/** 状态的机器 token（冒号前）。 */
export function conformanceStateToken(state: string): string {
    const colon = state.indexOf(':')
    return colon < 0 ? state : state.slice(0, colon)
}

/** 头行状态的中文短句（报告与"与上一窗口相比"共用）。 */
export const HEADLINE_LABEL: Readonly<Record<ConformanceHeadline, string>> = {
    conformant: 'conformant',
    partial: 'partial',
    divergent: 'divergent',
    unknown: 'unknown',
}

/**
 * 由五个维度的状态算出头行状态（**唯一实现**）。
 * @param states - 维度 → 状态 token（可带 `:<原因>`）。
 * @returns 头行状态与点名最差维度的可读原因。
 */
export function conformanceHeadline(states: Readonly<Record<ConformanceDimensionName, string>>): {
    headline: ConformanceHeadline
    reason: string
} {
    const entries = CONFORMANCE_DIMENSIONS.map((dimension) => {
        const token = conformanceStateToken(states[dimension])
        const rule = DIMENSION_STATE_RULES[dimension][token] ?? { tier: 1 as const, unknown: true }
        return { dimension, token, tier: rule.tier, unknown: rule.unknown === true }
    })
    const worstTier = Math.min(...entries.map((entry) => entry.tier)) as 0 | 1 | 2
    const worst = entries.filter((entry) => entry.tier === worstTier)
    const named = worst
        .map((entry) => `${CONFORMANCE_DIMENSION_LABEL[entry.dimension]}（${entry.token}）`)
        .join('、')
    // The tier → headline word comes from HEADLINE_RANK (the single ranking
    // table): the first word at that rank wins, and CONFORMANCE_HEADLINES puts
    // `partial` before `unknown`, so the two tie at rank 1 resolve to partial.
    const byRank = new Map<number, ConformanceHeadline>()
    for (const headline of CONFORMANCE_HEADLINES) {
        const rank = HEADLINE_RANK[headline]
        if (!byRank.has(rank)) byRank.set(rank, headline)
    }
    const headlineForTier = (tier: 0 | 1 | 2): ConformanceHeadline => byRank.get(tier) ?? 'unknown'
    if (worstTier === 2) {
        return {
            headline: headlineForTier(2),
            reason: `五个维度都在规则允许的范围内（最差一档仍是 conformant：${named}）`,
        }
    }
    if (worstTier === 0) {
        return { headline: headlineForTier(0), reason: `最差维度：${named}（divergent 优先于其它一切）` }
    }
    // partial 档：全部维度都是"没读到"时才是 unknown；只要有一个已知的偏离，
    // 或存在更高档的维度，头行就是 partial（unknown 永远不优于 partial）。
    const allUnknown = entries.every((entry) => entry.tier === 1 && entry.unknown)
    if (allUnknown) {
        return { headline: 'unknown', reason: `五个维度都读不到（${named}）：unknown 不是通过，也不优于 partial` }
    }
    return {
        headline: headlineForTier(1),
        reason: `最差维度：${named}（partial/stale 或 unknown；unknown 不优于 partial）`,
    }
}

/** 去重并保持首次出现的顺序。 */
function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = []
    for (const value of values) {
        if (value === '' || out.includes(value)) continue
        out.push(value)
    }
    return out
}

/** 把绝对路径变成工作区相对路径（台账与报告里用相对路径）。 */
function rel(layout: Layout, file: string): string {
    const relative = path.relative(layout.cwd, file)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
}

/** 状态的短形态：只保留冒号前的 token（报告里"状态 + 最短的诚实细节"）。 */
function shortState(state: string): string {
    return conformanceStateToken(state)
}

/** 把一段可能很长的原因压成一行（detail 要短，但不能只剩状态码）。 */
function shortText(value: string, max = 96): string {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/** 文件是否存在（不跟随任何写操作）。 */
function exists(file: string): boolean {
    try {
        fs.statSync(file)
        return true
    } catch {
        return false
    }
}

/** 读一个目录的条目，区分"不存在"与"读不到"。 */
function listEntries(dir: string): { entries: string[]; missing: boolean; problem?: string } {
    try {
        return { entries: fs.readdirSync(dir).sort(), missing: false }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { entries: [], missing: true }
        return { entries: [], missing: false, problem: `${dir} 读不到：${(error as Error).message}` }
    }
}

/** 台账候选路径：优先 trail 根，其次兄弟插件的默认位置（与 metrics 一致）。 */
function ledgerFile(layout: Layout, name: string): string {
    const primary = path.join(layout.rootDir, `${name}.jsonl`)
    const fallback = path.join(layout.cwd, '.dsh', `${name}.jsonl`)
    if (exists(primary)) return primary
    if (primary !== fallback && exists(fallback)) return fallback
    return primary
}

/**
 * 读一份仓库级 JSONL 台账，坏行变成 `problems`（绝不静默跳过）。
 * @param layout - 工作区布局。
 * @param name - `plan` / `releases` / `deployments`。
 */
export function scanConformanceLedger(layout: Layout, name: string): ConformanceLedgerScan {
    const file = ledgerFile(layout, name)
    const text = readText(file)
    if (text === undefined) return { name, file, present: false, rows: [], problems: [] }
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
            const tail = lines.slice(index + 1).every((rest) => rest.trim() === '')
            problems.push(
                tail
                    ? `第 ${index + 1} 行无法解析（JSON 不完整，通常是写入被中断留下的截断末行）：已跳过`
                    : `第 ${index + 1} 行无法解析：已跳过`,
            )
            return
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            problems.push(`第 ${index + 1} 行不是 JSON 对象：已跳过`)
            return
        }
        rows.push(parsed as Record<string, unknown>)
    })
    return { name, file, present: true, rows, problems }
}

/** 读仓库级的证据要求；缺失 = 默认值，但把"看不见 profile"写进 blind。 */
function evidenceRequirementsOf(layout: Layout): ConformanceEvidenceRequirements {
    const loaded = loadProjectConfig<Record<string, unknown>>(layout, 'evidence-gate')
    const blind: string[] = []
    if (!loaded.present) {
        blind.push(
            `证据要求使用内置默认值（${rel(layout, loaded.file)} 不存在）：宿主 profile 若配置了 gateSource/requiredEvidenceKinds，这里读不到`,
        )
    }
    for (const problem of loaded.problems) blind.push(`证据要求：${problem}`)
    const value = loaded.value ?? {}
    const gateSource =
        typeof value['gateSource'] === 'string' && value['gateSource'].trim() !== ''
            ? value['gateSource'].trim()
            : DEFAULT_GATE_SOURCE
    const kinds = Array.isArray(value['requiredEvidenceKinds'])
        ? value['requiredEvidenceKinds'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
        : [...DEFAULT_REQUIRED_EVIDENCE_KINDS]
    if (Array.isArray(value['requiredEvidenceKinds']) && value['requiredEvidenceKinds'].length > 0 && kinds.length === 0) {
        blind.push('证据要求：requiredEvidenceKinds 存在但没有可用的字符串，已回退到默认值')
    }
    return {
        gateSource,
        requiredKinds: [...kinds],
        source: loaded.present ? rel(layout, loaded.file) : '内置默认值',
        blind,
    }
}

/**
 * 读一次"当前世界"事实（只读），供同一批 mission 复用。
 * @param options - 布局、注入时钟与可选的世界快照（测试用）。
 */
export function buildConformanceContext(options: ConformanceContextOptions): ConformanceContext {
    const { layout, now } = options
    return {
        layout,
        now,
        policy: options.policy ?? policyFingerprint(layout.cwd, { rootDir: layout.rootDir }),
        fingerprint: options.fingerprint ?? gitFingerprint(layout.cwd, { excludePaths: [layout.rootDir] }),
        requirements: options.requirements ?? evidenceRequirementsOf(layout),
        ledgers: {
            plan: scanConformanceLedger(layout, 'plan'),
            releases: scanConformanceLedger(layout, 'releases'),
            deployments: scanConformanceLedger(layout, 'deployments'),
        },
    }
}

// --- 台账读取（mission 级） ---------------------------------------------------

interface GateScan {
    records: GateRecord[]
    blind: string[]
}

/** 读 `gates/*.json`，读不到的文件点名（绝不假装"没有记录"）。 */
function scanGates(layout: Layout, missionId: string): GateScan {
    const dir = path.join(missionDir(layout, missionId), 'gates')
    const listed = listEntries(dir)
    const blind: string[] = []
    if (listed.problem !== undefined) blind.push(listed.problem)
    const records: GateRecord[] = []
    for (const entry of listed.entries) {
        if (!entry.endsWith('.json')) continue
        const record = readJson<GateRecord>(path.join(dir, entry))
        if (record === undefined) {
            blind.push(`gates/${entry} 无法解析：这次裁决不在任何维度里可见`)
            continue
        }
        records.push(record)
    }
    return { records, blind }
}

interface ReceiptScan {
    records: Receipt[]
    blind: string[]
}

/** 读 `receipts/*.json`，读不到的文件点名。 */
function scanReceipts(layout: Layout, missionId: string): ReceiptScan {
    const dir = path.join(missionDir(layout, missionId), 'receipts')
    const listed = listEntries(dir)
    const blind: string[] = []
    if (listed.problem !== undefined) blind.push(listed.problem)
    const records: Receipt[] = []
    for (const entry of listed.entries) {
        if (!entry.endsWith('.json')) continue
        const record = readJson<Receipt>(path.join(dir, entry))
        if (record === undefined) {
            blind.push(`receipts/${entry} 无法解析：这个回执不在任何维度里可见`)
            continue
        }
        records.push(record)
    }
    return { records, blind }
}

interface EvidenceScan {
    rows: EvidenceRecord[]
    /** 无法解析的物理行号（1-based）。 */
    badLines: number[]
    present: boolean
}

/** 读 `evidence.jsonl`，把坏行**数出来**（`readJsonl` 会静默跳过，这里不能）。 */
function scanEvidence(layout: Layout, missionId: string): EvidenceScan {
    const file = path.join(missionDir(layout, missionId), 'evidence.jsonl')
    const text = readText(file)
    if (text === undefined) return { rows: [], badLines: [], present: false }
    const rows: EvidenceRecord[] = []
    const badLines: number[] = []
    text.split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed === '') return
        try {
            const parsed = JSON.parse(trimmed) as unknown
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                badLines.push(index + 1)
                return
            }
            rows.push(parsed as EvidenceRecord)
        } catch {
            badLines.push(index + 1)
        }
    })
    return { rows, badLines, present: true }
}

/** 每个 source 的最新一次裁决（checkedAt 最大，平局取 id 大的）。 */
function newestPerSource(gates: readonly GateRecord[]): GateRecord[] {
    const bySource = new Map<string, GateRecord>()
    for (const gate of gates) {
        const previous = bySource.get(gate.source)
        if (
            previous === undefined ||
            gate.checkedAt > previous.checkedAt ||
            (gate.checkedAt === previous.checkedAt && gate.id.localeCompare(previous.id) > 0)
        ) {
            bySource.set(gate.source, gate)
        }
    }
    return [...bySource.values()].sort((left, right) => left.source.localeCompare(right.source))
}

/** 最新一次（任意 source），平局取 id 大的。 */
function newestGate(gates: readonly GateRecord[]): GateRecord | undefined {
    let newest: GateRecord | undefined
    for (const gate of gates) {
        if (
            newest === undefined ||
            gate.checkedAt > newest.checkedAt ||
            (gate.checkedAt === newest.checkedAt && gate.id.localeCompare(newest.id) > 0)
        ) {
            newest = gate
        }
    }
    return newest
}

/** 指纹差异的可读描述（顺序固定）。 */
function fingerprintDifferences(indexed: GitFingerprint, current: GitFingerprint): string[] {
    const differences: string[] = []
    const head = (value: string | undefined): string => (value === undefined ? 'no-commit' : value.slice(0, 8))
    if (indexed.head !== current.head) differences.push(`HEAD ${head(indexed.head)} → ${head(current.head)}`)
    if (indexed.branch !== current.branch) {
        differences.push(`分支 ${indexed.branch ?? 'detached'} → ${current.branch ?? 'detached'}`)
    }
    if (indexed.diffDigest !== current.diffDigest) {
        differences.push(`diff ${indexed.diffDigest.slice(0, 8)} → ${current.diffDigest.slice(0, 8)}`)
    }
    if (indexed.dirty !== current.dirty || indexed.changedFiles !== current.changedFiles) {
        differences.push(`改动数 ${indexed.changedFiles} → ${current.changedFiles}（dirty ${indexed.dirty ? '是' : '否'} → ${current.dirty ? '是' : '否'}）`)
    }
    return differences
}

/** 短策略版本（前 12 位；空版本有可读占位）。 */
function shortVersion(version: string): string {
    if (version === '') return '(未记录)'
    return version.length <= 12 ? version : `${version.slice(0, 12)}…`
}

// --- 五个维度 ----------------------------------------------------------------

/**
 * 授权：mandate 还在不在、算不算数。
 *
 * `legacy`（mandate 之前的历史审批）是**事实**，按 explicit 兼容处理，不进
 * `divergent`；`missing` 是"没有可复核的授权"，属于 unknown 档。
 */
function authorizationDimension(mission: MissionRecord, context: ConformanceContext): ConformanceDimension {
    const state = mandateState(mission)
    const facts: string[] = [`mission 状态 ${mission.status}`]
    if (state.kind === 'absent') {
        facts.push('spec.approvedAt 不存在；mission.mandate 不存在')
        return {
            state: 'missing',
            detail: '没有已审批的规格（spec.approvedAt 不存在），也没有 mandate 记录：没有可复核的授权（missing 不是 ok）',
            facts,
            blind: ['没有 mandate 记录：授权强度、范围与策略版本都无从核对'],
        }
    }
    if (state.kind === 'invalid') {
        facts.push(`mission.json 里的 mandate 未通过校验：${state.reason}`)
        return {
            state: `stale:mandate 记录损坏（${state.reason}）；损坏的记录不能当作授权`,
            detail: `mandate 记录损坏：${state.reason}；按 fail closed 当作"需要重新授权"`,
            facts,
            blind: ['损坏的 mandate 无法核对强度/范围/策略版本'],
        }
    }
    const mandate = state.mandate
    facts.push(`mandate：strength=${mandate.strength}，by ${mandate.approvedBy}，at ${formatTime(mandate.at)}`)
    if (state.kind === 'legacy') {
        facts.push(`spec.approvedAt ${formatTime(mandate.at)}；没有 mission.mandate 记录`)
        return {
            state: 'legacy',
            detail:
                'legacy 审批（mandate 之前的历史记录）：没有 mandate 记录，按 explicit 兼容处理——这是事实，不是缺陷，不计入 divergent',
            facts,
            blind: ['legacy 审批没有记录强度/范围/策略版本：这三项无法复核（这是历史兼容，不是缺陷）'],
        }
    }
    facts.push(`policy 记录 ${shortVersion(mandate.policyVersion)}；当前信任根 ${shortVersion(context.policy.version)}`)
    if (mandate.withdrawn !== undefined) {
        facts.push(`withdrawn：${formatTime(mandate.withdrawn.at)} by ${mandate.withdrawn.by}：${mandate.withdrawn.reason}`)
        return {
            state: 'withdrawn',
            detail: `mandate 已被 ${mandate.withdrawn.by} 于 ${formatTime(mandate.withdrawn.at)} 撤回（${mandate.withdrawn.reason}）：授权不再成立`,
            facts,
            blind: [],
        }
    }
    const reasons: string[] = []
    const blind: string[] = []
    if (mission.spec?.approvedAt === undefined) {
        reasons.push('规格审批已失效（spec.approvedAt 不存在）：mandate 只是历史记录')
    }
    if (mandate.strength === 'inferred') {
        reasons.push('授权强度 inferred：不是一个人的有效批准，强制门禁不接受')
    }
    if (mandate.policyVersion !== context.policy.version) {
        const snapshot = readPolicySnapshot(new MissionStore({ layout: context.layout }), mission.id)
        if (snapshot === undefined) {
            blind.push('缺少审批时的 policy-fingerprint.json 快照：无法点名是哪些信任根文件变了')
            reasons.push(`策略版本已变（${shortVersion(mandate.policyVersion)} → ${shortVersion(context.policy.version)}）`)
        } else {
            const changed = policyDifferences(snapshot, context.policy)
            const names = changed.slice(0, 5).map((entry) => `${entry.path}（${entry.change === 'added' ? '新增' : entry.change === 'removed' ? '删除' : '修改'}）`)
            reasons.push(
                `策略版本已变（${shortVersion(mandate.policyVersion)} → ${shortVersion(context.policy.version)}）` +
                    (names.length === 0 ? '：快照与当前文件清单相同，未能定位到具体文件' : `：改动文件 ${names.join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个` : ''}`),
            )
        }
    }
    const declared = mission.spec?.fileBoundaries ?? []
    if (mandate.scope.paths.length === 0) {
        facts.push('范围未收窄（空 = 未收窄，不是"什么都不允许"）')
    } else {
        const outside = declared.filter((entry) => !mandate.scope.paths.includes(entry))
        if (outside.length > 0) {
            reasons.push(`规格声明的范围比 mandate 宽（新增：${outside.slice(0, 5).join('、')}${outside.length > 5 ? ` 等 ${outside.length} 个` : ''}）`)
        }
        facts.push(`范围 paths：${mandate.scope.paths.join('、')}${mandate.scope.phases.length === 0 ? '' : `；phases：${mandate.scope.phases.join('、')}`}`)
    }
    if (reasons.length > 0) {
        return {
            state: `stale:${reasons.join('；')}`,
            detail: `授权已不能按原样成立：${reasons.join('；')}`,
            facts,
            blind,
        }
    }
    return {
        state: 'ok',
        detail: `mandate strength=${mandate.strength} 有效；policy 与当前信任根一致；规格审批有效`,
        facts,
        blind,
    }
}

/** 证据：回执 + `scope.full` + 交付要求的门禁来源。 */
function evidenceDimension(input: {
    mission: MissionRecord
    gates: readonly GateRecord[]
    receipts: readonly Receipt[]
    evidence: EvidenceScan
    requirements: ConformanceEvidenceRequirements
}): ConformanceDimension {
    const { mission, gates, receipts, evidence, requirements } = input
    const kinds = [...new Set(evidence.rows.map((row) => row.kind))].sort()
    const facts = [
        `证据行 ${evidence.rows.length} 条${kinds.length === 0 ? '' : `（类型：${kinds.join('、')}）`}`,
        `回执 ${receipts.length} 个`,
        `交付要求的门禁来源 ${requirements.gateSource}（${requirements.source}）`,
    ]
    if (receipts.length === 0) {
        if (evidence.rows.length === 0) {
            return {
                state: 'absent',
                detail: `没有任何回执或证据行（mission 状态 ${mission.status}）：交付没有可核对的依据`,
                facts,
                blind: ['没有证据与回执：覆盖范围、门禁来源与必填类型都无法核对'],
            }
        }
        return {
            state: 'partial',
            detail: `有 ${evidence.rows.length} 条证据行但没有回执：交付没有被签发，证据链没有闭环`,
            facts,
            blind: requirements.blind,
        }
    }
    const newest = [...receipts].sort((left, right) => right.issuedAt - left.issuedAt || left.id.localeCompare(right.id))[0] as Receipt
    facts.push(`最新回执 ${newest.id}：issuedAt ${formatTime(newest.issuedAt)}，gateId ${newest.gateId}，证据 ${newest.evidenceIds.length} 条`)
    if (receipts.length > 1) facts.push(`另有 ${receipts.length - 1} 个历史回执（只核对最新一个）`)
    const gate = gates.find((record) => record.id === newest.gateId)
    if (gate === undefined) {
        return {
            state: 'partial',
            detail: `回执 ${newest.id} 引用的门禁 ${newest.gateId} 不在 gates/ 里：证据链断了`,
            facts,
            blind: requirements.blind,
        }
    }
    const reasons: string[] = []
    if (gate.source !== requirements.gateSource) {
        reasons.push(`回执依赖的门禁来源是 ${gate.source}，本仓库要求 ${requirements.gateSource}`)
    }
    if (gate.state !== 'PASS') {
        reasons.push(`回执依赖的门禁裁决是 ${gate.state}（${gate.reason}）`)
    }
    if (gate.scope === undefined) {
        reasons.push(`门禁 ${gate.id} 没有 scope 字段（旧记录一律不视为"完整覆盖"）`)
    } else if (gate.scope.full !== true) {
        reasons.push(`门禁 ${gate.id} 只覆盖了部分命令（${gate.scope.selected.length}/${gate.scope.total}：${gate.scope.selected.join(', ') || '无'}）`)
    }
    if (gate.results.length === 0) {
        reasons.push(`门禁 ${gate.id} 的 results 为空：没有执行任何命令的 PASS 不是证据`)
    }
    const known = new Set(evidence.rows.map((row) => row.id))
    const missingEvidence = newest.evidenceIds.filter((id) => !known.has(id))
    if (missingEvidence.length > 0) {
        reasons.push(`回执引用了 ${missingEvidence.length} 条不存在的证据行（${missingEvidence.slice(0, 5).join('、')}）`)
    }
    const cited = evidence.rows.filter((row) => newest.evidenceIds.includes(row.id))
    const citedKinds = new Set(cited.map((row) => row.kind))
    const missingKinds = requirements.requiredKinds.filter((kind) => !citedKinds.has(kind as EvidenceRecord['kind']))
    if (missingKinds.length > 0) {
        reasons.push(`回执引用的证据里没有必填类型 ${missingKinds.join('、')}（本仓库要求 ${requirements.requiredKinds.join('、') || '无'}）`)
    }
    if (reasons.length > 0) {
        return {
            state: `partial:${reasons.join('；')}`,
            detail: `回执存在但不满足交付要求：${reasons.join('；')}`,
            facts,
            blind: requirements.blind,
        }
    }
    return {
        state: 'full',
        detail: `回执 ${newest.id} 依赖门禁 ${gate.id}（source=${gate.source}，scope.full=true，${gate.results.length} 条命令，PASS）与 ${cited.length} 条证据：满足交付要求`,
        facts,
        blind: requirements.blind,
    }
}

/** 门禁：各来源最新记录；`observations` 里的影子项只进 detail，不进裁决。 */
function gatesDimension(gates: readonly GateRecord[], scanBlind: readonly string[]): ConformanceDimension {
    const newest = newestPerSource(gates)
    const blind = [...scanBlind]
    if (newest.length === 0) {
        return {
            state: 'no-record',
            detail: 'gates/ 里没有任何可解析的门禁记录：没有裁决可看（no-record 不是 pass）',
            facts: [`可解析的门禁记录 0 条（原始文件 ${gates.length} 条）`],
            blind: [...blind, '没有门禁记录：任一来源的最新裁决都无从核对'],
        }
    }
    const states = newest.map((gate) => gate.state)
    const worst = states.includes('BLOCK') ? 'block' : states.includes('WARN') ? 'warn' : 'pass'
    const facts: string[] = [`可解析的门禁记录 ${gates.length} 条；来源 ${newest.length} 个（每个来源取最新一次）`]
    for (const gate of newest) {
        const observations = gate.observations ?? []
        const shadow =
            observations.length === 0
                ? ''
                : `；影子观察 ${observations.length} 条：${observations
                      .map((entry) => `${entry.rule}=would ${entry.would}（${entry.reason}）`)
                      .join('、')}`
        facts.push(`${gate.source}：最新 ${gate.id} ${gate.state} @ ${formatTime(gate.checkedAt)}（${gate.reason}）${shadow}`)
    }
    const shadowCount = newest.reduce((total, gate) => total + (gate.observations?.length ?? 0), 0)
    const shadowBlocks = newest.reduce(
        (total, gate) => total + (gate.observations?.filter((entry) => entry.would === 'BLOCK').length ?? 0),
        0,
    )
    const shadowLine =
        shadowCount === 0
            ? ''
            : `；影子（observe）观察 ${shadowCount} 条，其中 would BLOCK ${shadowBlocks} 条——影子项**不计入**本维度裁决`
    // The state alone is not a detail: each source's own reason (and every
    // shadow verdict) must be READABLE here, because that is what a person acts on.
    const stateLine = newest
        .map((gate) => {
            const observations = gate.observations ?? []
            const shadow =
                observations.length === 0
                    ? ''
                    : `，影子：${observations.map((entry) => `${entry.rule}=would ${entry.would}（${entry.reason}）`).join('、')}`
            return `${gate.source}=${gate.state}（${shortText(gate.reason)}${shadow}）`
        })
        .join('，')
    return {
        state: worst,
        detail: `各来源最新裁决：${stateLine}${shadowLine}`,
        facts,
        blind: [...blind, ...(shadowCount === 0 ? [] : ['影子项是"本会怎样"的记录，不是裁决；切 enforce 前不能把它当作已拦截'])],
    }
}

/** 标准/规范基线的新鲜度（eng-core 能看见的那一半）。 */
function standardsFreshness(layout: Layout): { facts: string[]; reasons: string[]; blind: string[] } {
    const loaded = loadProjectConfig<Record<string, unknown>>(layout, 'standards-gate')
    const value = loaded.value ?? {}
    const standardsFile = resolvePath(typeof value['standardsFile'] === 'string' ? value['standardsFile'] : DEFAULT_STANDARDS_FILE, layout.cwd)
    const baselineFile = resolvePath(typeof value['baselineFile'] === 'string' ? value['baselineFile'] : DEFAULT_BASELINE_FILE, layout.cwd)
    const facts: string[] = []
    const reasons: string[] = []
    const blind: string[] = []
    for (const problem of loaded.problems) blind.push(`规范基线：${problem}`)
    if (!exists(standardsFile)) {
        facts.push(`未配置规范阈值（${rel(layout, standardsFile)} 不存在）：基线这项不适用`)
        return { facts, reasons, blind }
    }
    if (!exists(baselineFile)) {
        reasons.push(`规范阈值已配置（${rel(layout, standardsFile)}）但没有基线（${rel(layout, baselineFile)}）：存量违规会被当成新增`)
        return { facts, reasons, blind }
    }
    facts.push(`规范基线与阈值都在（${rel(layout, standardsFile)} / ${rel(layout, baselineFile)}）`)
    blind.push('规范基线是否仍覆盖当前代码，要跑 standards_check 才知道：eng-core 不重复实现该测量')
    return { facts, reasons, blind }
}

/** The manifest fields this module reads (never trusted as a whole). */
interface KnowledgeManifestFacts {
    builtAt?: unknown
    staleness?: { reason?: unknown }
    fingerprint?: unknown
}

/**
 * The fingerprint a manifest recorded, or `undefined` when the shape is not one
 * this module can compare.
 *
 * The manifest comes back through `JSON.parse`, so an unreadable or foreign
 * shape must not be coerced into "looks the same" — that is exactly how a
 * freshness check reports `fresh` with nothing behind it.
 */
function recordedKnowledgeFingerprint(value: unknown): GitFingerprint | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (
        typeof record['isRepo'] !== 'boolean' ||
        typeof record['dirty'] !== 'boolean' ||
        typeof record['changedFiles'] !== 'number' ||
        !Number.isFinite(record['changedFiles']) ||
        typeof record['diffDigest'] !== 'string'
    ) {
        return undefined
    }
    if (record['head'] !== undefined && typeof record['head'] !== 'string') return undefined
    if (record['branch'] !== undefined && typeof record['branch'] !== 'string') return undefined
    return {
        isRepo: record['isRepo'],
        dirty: record['dirty'],
        changedFiles: record['changedFiles'],
        diffDigest: record['diffDigest'],
        ...(typeof record['head'] === 'string' ? { head: record['head'] } : {}),
        ...(typeof record['branch'] === 'string' ? { branch: record['branch'] } : {}),
    }
}

/** The declared exclusions as the core fingerprinter will consume them. */
function declaredKnowledgeExcludes(value: unknown): { paths: string[] } | { problem: string } {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return { problem: '知识库索引声明的排除集不是字符串数组：按不可复算处理' }
    }
    for (const entry of value as string[]) {
        // One entry at a time: `usableFingerprintExcludes` dedupes, so a repeated
        // path is not a problem, while an absolute/escaping/empty one is.
        if (usableFingerprintExcludes([entry]).length !== 1) {
            return { problem: `知识库索引声明的排除集含无法复算的路径 ${JSON.stringify(entry)}：按不可复算处理` }
        }
    }
    return { paths: usableFingerprintExcludes(value as string[]) }
}

/** One readable list of the exclusions a comparison used (empty is named). */
function formatExcludes(paths: readonly string[]): string {
    return paths.length === 0 ? '（未排除任何路径）' : paths.join('、')
}

/**
 * 知识库索引的新鲜度：**从数据复算**，不重复实现写方的规则。
 *
 * The manifest declares how it may be compared (`fingerprint.algorithm` +
 * `fingerprint.excludes`); this function honours that declaration through the
 * same core function the writer used. A manifest that does not declare the rule
 * (written by an older version) is `unknown` with a blind line — never `fresh`,
 * because "cannot recompute" is not "up to date". An artifact that declared a
 * rule this module does not know is also unknown, for the same reason.
 */
function knowledgeIndexFreshness(layout: Layout): { facts: string[]; reasons: string[]; blind: string[] } {
    const manifestFile = path.join(layout.rootDir, 'kb', 'manifest.json')
    if (!exists(manifestFile)) {
        return { facts: [`没有知识库索引（${rel(layout, manifestFile)} 不存在）：索引这项不适用`], reasons: [], blind: [] }
    }
    const manifest = readJson<KnowledgeManifestFacts>(manifestFile)
    if (manifest === undefined) {
        return {
            facts: [],
            reasons: [],
            blind: [`${rel(layout, manifestFile)} 无法解析：索引新旧无从核对`],
        }
    }
    const facts = [
        `知识库索引构建于 ${typeof manifest.builtAt === 'string' ? manifest.builtAt : '(未记录)'}（${rel(layout, manifestFile)}）`,
    ]
    const selfDeclared =
        typeof manifest.staleness === 'object' &&
        manifest.staleness !== null &&
        typeof manifest.staleness.reason === 'string'
            ? manifest.staleness.reason
            : undefined
    if (selfDeclared !== undefined) {
        return { facts, reasons: [`知识库索引自述不完整：${selfDeclared}`], blind: [] }
    }
    const recorded = recordedKnowledgeFingerprint(manifest.fingerprint)
    if (recorded === undefined) {
        return { facts, reasons: [], blind: [`知识库索引的 manifest 没有可比较的 git 指纹：索引新旧无从核对`] }
    }
    const fingerprintRecord =
        typeof manifest.fingerprint === 'object' && manifest.fingerprint !== null
            ? (manifest.fingerprint as Record<string, unknown>)
            : undefined
    const algorithm = fingerprintRecord?.['algorithm']
    const excludesValue = fingerprintRecord?.['excludes']
    if (algorithm === undefined || excludesValue === undefined) {
        // An index written before the declaration existed. `dsh-knowledge-base`
        // itself can still compare it (it knows its own index directory); this
        // view cannot, and saying `fresh` here would be a guess.
        return { facts, reasons: [], blind: ['旧索引未声明算法与排除集，无法复算'] }
    }
    if (typeof algorithm !== 'string') {
        return { facts, reasons: [], blind: ['知识库索引声明的指纹算法不可读：按不可复算处理'] }
    }
    if (algorithm !== FINGERPRINT_ALGORITHM) {
        return {
            facts,
            reasons: [],
            blind: [`知识库索引声明的指纹算法 ${shortText(algorithm)} 不是 ${FINGERPRINT_ALGORITHM}：按不可复算处理`],
        }
    }
    const declared = declaredKnowledgeExcludes(excludesValue)
    if ('problem' in declared) return { facts, reasons: [], blind: [declared.problem] }
    if (!recorded.isRepo) {
        return { facts, reasons: [], blind: ['知识库索引构建时工作区不是 git 仓库：索引新旧无从复算'] }
    }
    const current = fingerprintWithExcludes(layout.cwd, { paths: declared.paths })
    if (!current.isRepo) {
        return { facts, reasons: [], blind: ['当前工作区不是 git 仓库：知识库索引新旧无从复算'] }
    }
    const scope = `（按 manifest 声明的 ${algorithm}、排除集 ${formatExcludes(declared.paths)} 复算）`
    if (sameFingerprint(recorded, current)) {
        facts.push(`知识库索引的指纹与当前工作区一致${scope}`)
        return { facts, reasons: [], blind: [] }
    }
    const differences = fingerprintDifferences(recorded, current)
    const changed = changedPathsWithExcludes(layout.cwd, { paths: declared.paths })
    const named =
        changed.length === 0
            ? ''
            : `；改动的文件：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ` 等 ${changed.length} 个` : ''}`
    return {
        facts,
        reasons: [`知识库索引落后于工作区${scope}：${differences.join('，') || '指纹字段有差异'}${named}`],
        blind: [],
    }
}

/** 新鲜度：策略版本、工作区指纹、基线与索引。 */
function freshnessDimension(mission: MissionRecord, gates: readonly GateRecord[], context: ConformanceContext): ConformanceDimension {
    const reasons: string[] = []
    const facts: string[] = []
    const blind: string[] = []
    const state = mandateState(mission)
    if (state.kind === 'present') {
        if (state.mandate.policyVersion === context.policy.version) {
            facts.push(`policyVersion ${shortVersion(context.policy.version)} 与当前信任根一致`)
        } else {
            reasons.push(`policyVersion 已变（${shortVersion(state.mandate.policyVersion)} → ${shortVersion(context.policy.version)}）`)
        }
    } else if (state.kind === 'legacy') {
        // Nothing was recorded about the rule set, so there is nothing to compare.
        // That is a FACT about a legacy approval (the authorization dimension
        // already declares it as a blind spot), not a freshness failure.
        facts.push('legacy 审批没有 policyVersion：策略版本这一项不适用')
    } else if (state.kind === 'absent') {
        facts.push('没有 mandate：策略版本这一项不适用（授权维度已说明）')
    } else {
        facts.push('mandate 记录损坏：策略版本这一项不适用（授权维度已说明）')
    }

    const fingerprinted = gates
        .filter((gate) => gate.fingerprint !== undefined)
        .sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id))
        .at(-1)
    if (fingerprinted === undefined) {
        blind.push('没有任何门禁记录携带工作区指纹：无法核对工作区在裁决之后是否已变')
    } else if (fingerprinted.fingerprint === undefined || !fingerprinted.fingerprint.isRepo || !context.fingerprint.isRepo) {
        blind.push('工作区不是 git 仓库（或门禁记录时不是）：工作区指纹无法比较')
    } else {
        const differences = fingerprintDifferences(fingerprinted.fingerprint, context.fingerprint)
        if (differences.length === 0) {
            facts.push(`工作区指纹与最新带指纹的门禁 ${fingerprinted.id}（${formatTime(fingerprinted.checkedAt)}）一致`)
        } else {
            reasons.push(`工作区在门禁 ${fingerprinted.id}（${formatTime(fingerprinted.checkedAt)}）之后变了：${differences.join('，')}`)
        }
    }

    const standards = standardsFreshness(context.layout)
    facts.push(...standards.facts)
    reasons.push(...standards.reasons)
    blind.push(...standards.blind)
    const knowledge = knowledgeIndexFreshness(context.layout)
    facts.push(...knowledge.facts)
    reasons.push(...knowledge.reasons)
    blind.push(...knowledge.blind)

    if (reasons.length > 0) {
        return {
            state: `stale:${reasons.join('；')}`,
            detail: `有 ${reasons.length} 项过期：${reasons.join('；')}`,
            facts,
            blind: uniqueStrings(blind),
        }
    }
    if (blind.length > 0) {
        return {
            state: 'unknown',
            detail: `没有发现过期迹象，但以下无法核对：${uniqueStrings(blind).join('；')}`,
            facts,
            blind: uniqueStrings(blind),
        }
    }
    return { state: 'fresh', detail: 'policy、工作区指纹、基线与索引都与当前一致', facts, blind: [] }
}

/** 一致性：台账 ↔ 产物的引用事实。 */
function consistencyDimension(input: {
    mission: MissionRecord
    gates: readonly GateRecord[]
    receipts: readonly Receipt[]
    evidence: EvidenceScan
    context: ConformanceContext
}): ConformanceDimension {
    const { mission, gates, receipts, evidence, context } = input
    const layout = context.layout
    const reasons: string[] = []
    const facts: string[] = []
    const blind: string[] = []
    let checked = false

    // A missing ledger is a blind spot in its own right: "this mission has no
    // deployment gate" and "the deployment ledger cannot be read" are different
    // statements, and only one of them is good news.
    if (!context.ledgers.plan.present) blind.push(`${rel(layout, context.ledgers.plan.file)} 不存在：规划台账无法核对`)
    if (!context.ledgers.releases.present) blind.push(`${rel(layout, context.ledgers.releases.file)} 不存在：发布台账无法核对`)
    if (!context.ledgers.deployments.present) {
        blind.push(`${rel(layout, context.ledgers.deployments.file)} 不存在：部署台账无法核对`)
    }

    if (!evidence.present) {
        blind.push(`missions/${mission.id}/evidence.jsonl 不存在：证据行无法核对`)
    } else {
        checked = true
        if (evidence.badLines.length > 0) {
            reasons.push(`evidence.jsonl 有 ${evidence.badLines.length} 行无法解析（第 ${evidence.badLines.slice(0, 5).join('、')}${evidence.badLines.length > 5 ? ' 等' : ''} 行）`)
        } else {
            facts.push(`evidence.jsonl ${evidence.rows.length} 行全部可解析`)
        }
    }

    const directory = missionDir(layout, mission.id)
    const evidenceIds = new Set(evidence.rows.map((row) => row.id))
    let referencedArtifacts = 0
    for (const receipt of receipts) {
        checked = true
        if (receipt.path === undefined || receipt.path === '') {
            blind.push(`回执 ${receipt.id} 没有记录 path：无法核对回执文件本身`)
        } else {
            const file = path.resolve(layout.cwd, receipt.path)
            if (!exists(file)) reasons.push(`回执 ${receipt.id} 记录的 path ${receipt.path} 在磁盘上不存在`)
        }
        const missing = receipt.evidenceIds.filter((id) => !evidenceIds.has(id))
        if (missing.length > 0) {
            reasons.push(`回执 ${receipt.id} 引用了不存在的证据 ${missing.slice(0, 5).join('、')}`)
        }
    }
    for (const row of evidence.rows) {
        if (row.artifactPath === undefined || row.artifactPath === '') continue
        referencedArtifacts += 1
        const target = path.resolve(directory, row.artifactPath)
        if (!isInside(directory, target)) {
            reasons.push(`证据 ${row.id} 的 artifactPath ${row.artifactPath} 越出 mission 目录`)
        } else if (!exists(target)) {
            reasons.push(`证据 ${row.id} 的 artifactPath ${row.artifactPath} 在磁盘上不存在`)
        }
    }
    if (referencedArtifacts > 0) facts.push(`证据工件引用 ${referencedArtifacts} 个：逐个核对存在性`)

    const mandateView = mandateState(mission)
    if (mandateView.kind === 'present') {
        checked = true
        const mandate = mandateView.mandate
        const approvedAt = mission.spec?.approvedAt
        if (approvedAt === undefined) {
            facts.push('spec.approvedAt 不存在：没有可比的审批时间（授权维度已说明审批失效）')
        } else {
            const difference = Math.abs(mandate.at - approvedAt)
            if (difference <= APPROVAL_AT_TOLERANCE_MS) {
                facts.push(`mandate.at 与 spec.approvedAt 一致（相差 ${difference}ms，同一次审批）`)
            } else if (mission.approval !== undefined) {
                facts.push(
                    `mandate 指向首次审批 ${formatTime(mandate.at)}，spec.approvedAt ${formatTime(approvedAt)} 属于第 ${mission.approval.round} 轮（${mission.approval.state}）：mandate 不可改写`,
                )
            } else {
                reasons.push(
                    `mandate.at ${formatTime(mandate.at)} 与 spec.approvedAt ${formatTime(approvedAt)} 相差 ${difference}ms：不是同一次审批`,
                )
            }
        }
    } else {
        blind.push('没有可用的 mandate 记录：mandate 与规格审批时间的对应关系无法核对')
    }

    const deployGates = gates.filter((gate) => /deploy/i.test(gate.source))
    const deployments = context.ledgers.deployments
    if (deployGates.length === 0) {
        facts.push('没有部署门禁记录：部署台账这一项不适用')
    } else if (!deployments.present) {
        reasons.push(
            `mission 有 ${deployGates.length} 条部署门禁记录，但 ${rel(layout, deployments.file)} 不存在：部署结论没有台账行`,
        )
    } else {
        checked = true
        const rows = deployments.rows.map((row) => (typeof row['gateId'] === 'string' ? row['gateId'] : ''))
        const missing = deployGates.filter((gate) => !rows.includes(gate.id)).map((gate) => gate.id)
        if (missing.length > 0) {
            reasons.push(`部署门禁 ${missing.slice(0, 5).join('、')} 在 ${rel(layout, deployments.file)} 里没有对应行（行只通过 gateId 归属）`)
        } else {
            facts.push(`${rel(layout, deployments.file)} ${deployments.rows.length} 行：${deployGates.length} 个部署门禁都有对应行`)
        }
        blind.push('deployments.jsonl 的行不记录 missionId：只能经 gateId 归属，手工改写 gateId 的行无法归属到本 mission')
    }

    const releases = context.ledgers.releases
    if (!releases.present) {
        blind.push(`${rel(layout, releases.file)} 不存在：发布台账无法核对`)
    } else {
        checked = true
        const referencing = releases.rows.filter((row) => Array.isArray(row['missionIds']) && row['missionIds'].includes(mission.id))
        if (referencing.length > 0 && receipts.length === 0) {
            reasons.push(`${rel(layout, releases.file)} 有 ${referencing.length} 条记录引用了该 mission，但没有任何回执`)
        } else if (referencing.length > 0) {
            facts.push(`${rel(layout, releases.file)} ${referencing.length} 条记录引用该 mission，回执存在`)
        } else {
            facts.push(`${rel(layout, releases.file)} 没有引用该 mission（这一项不适用）`)
        }
    }

    const plan = context.ledgers.plan
    if (!plan.present) {
        blind.push(`${rel(layout, plan.file)} 不存在：规划台账无法核对`)
    } else {
        checked = true
        const referencing = plan.rows.filter((row) => row['missionId'] === mission.id)
        facts.push(
            referencing.length === 0
                ? `${rel(layout, plan.file)} 没有引用该 mission（这一项不适用）`
                : `${rel(layout, plan.file)} ${referencing.length} 行引用该 mission`,
        )
    }

    for (const ledger of [plan, releases, deployments]) {
        for (const problem of ledger.problems) blind.push(`${rel(layout, ledger.file)} ${problem}`)
    }

    const blindOut = uniqueStrings(blind)
    if (reasons.length > 0) {
        return {
            state: `divergent:${reasons.join('；')}`,
            detail: `台账与产物对不上：${reasons.join('；')}`,
            facts,
            blind: blindOut,
        }
    }
    if (!checked) {
        return {
            state: 'unknown',
            detail: '没有可核对的引用：既没有证据/回执，也没有可用的 mandate 或仓库级台账',
            facts,
            blind: uniqueStrings([...blindOut, '没有可核对的对象：一致性无从判断']),
        }
    }
    return {
        state: 'consistent',
        detail: '可核对的引用都存在（证据行可解析、回执与工件路径存在、审批时间对应），未完成的核对见盲区',
        facts,
        blind: blindOut,
    }
}

/** 没有 mission 记录时的五维结论：全部 unknown，每个都带原因。 */
function unknownMission(missionId: string | undefined, reason: string): MissionConformance {
    const dimensions = {} as Record<ConformanceDimensionName, ConformanceDimension>
    for (const dimension of CONFORMANCE_DIMENSIONS) {
        dimensions[dimension] = {
            state: 'unknown',
            detail: `${CONFORMANCE_DIMENSION_LABEL[dimension]}：${reason}`,
            facts: [],
            blind: [reason],
        }
    }
    const result = conformanceHeadline(
        Object.fromEntries(CONFORMANCE_DIMENSIONS.map((dimension) => [dimension, 'unknown'])) as Record<
            ConformanceDimensionName,
            string
        >,
    )
    const blind = uniqueStrings([reason])
    return {
        ...(missionId === undefined ? {} : { missionId }),
        dimensions,
        headline: result.headline,
        headlineReason: result.reason,
        blind,
    }
}

/**
 * 计算一个 mission 的五维结论（只读）。
 * @param context - 由 {@link buildConformanceContext} 一次性读好的"当前世界"。
 * @param missionId - 目标 mission。
 */
export function missionConformance(context: ConformanceContext, missionId: string): MissionConformance {
    if (!isSafeId(missionId)) {
        return unknownMission(missionId, `mission id ${JSON.stringify(missionId)} 不是合法的单段目录名：拒绝读取（fail closed）`)
    }
    const store = new MissionStore({ layout: context.layout })
    const mission = store.read(missionId)
    if (mission === undefined) {
        return unknownMission(missionId, `missions/${missionId}/mission.json 不存在或无法解析：没有可核对的事实`)
    }
    const gateScan = scanGates(context.layout, missionId)
    const receiptScan = scanReceipts(context.layout, missionId)
    const evidenceScan = scanEvidence(context.layout, missionId)
    const gates = gateScan.records
    const receipts = receiptScan.records

    const dimensions: Record<ConformanceDimensionName, ConformanceDimension> = {
        authorization: authorizationDimension(mission, context),
        evidence: evidenceDimension({
            mission,
            gates,
            receipts,
            evidence: evidenceScan,
            requirements: context.requirements,
        }),
        gates: gatesDimension(gates, gateScan.blind),
        freshness: freshnessDimension(mission, gates, context),
        consistency: consistencyDimension({ mission, gates, receipts, evidence: evidenceScan, context }),
    }
    // 台账文件读不出来的盲区也要进各自的维度：否则"读不到"会静默消失。
    for (const [dimension, extra] of [
        ['evidence', receiptScan.blind],
        ['consistency', receiptScan.blind],
        ['freshness', gateScan.blind],
    ] as const) {
        if (extra.length === 0) continue
        dimensions[dimension] = { ...dimensions[dimension], blind: uniqueStrings([...dimensions[dimension].blind, ...extra]) }
    }
    const states = Object.fromEntries(CONFORMANCE_DIMENSIONS.map((dimension) => [dimension, dimensions[dimension].state])) as Record<
        ConformanceDimensionName,
        string
    >
    const headline = conformanceHeadline(states)
    return {
        missionId: mission.id,
        title: mission.title,
        status: mission.status,
        createdAt: mission.createdAt,
        dimensions,
        headline: headline.headline,
        headlineReason: headline.reason,
        blind: uniqueStrings(CONFORMANCE_DIMENSIONS.flatMap((dimension) => dimensions[dimension].blind)),
    }
}

/** 空计数表（固定顺序，含 0；分布不省略任何一档）。 */
function zeroDimensionCounts(): Record<ConformanceDimensionName, Record<string, number>> {
    return Object.fromEntries(
        CONFORMANCE_DIMENSIONS.map((dimension) => [
            dimension,
            Object.fromEntries(CONFORMANCE_DIMENSION_STATES[dimension].map((state) => [state, 0])),
        ]),
    ) as Record<ConformanceDimensionName, Record<string, number>>
}

function zeroHeadlineCounts(): Record<ConformanceHeadline, number> {
    return { conformant: 0, partial: 0, divergent: 0, unknown: 0 }
}

/**
 * 最近 N 个 mission 的一致性分布（**不做加权分数**）。
 *
 * 排序是确定的：`createdAt` 倒序、同刻按 id 升序。上一窗口（接下来的 N 个）
 * 只用于"与上一窗口相比"的趋势行；没有上一窗口时不输出趋势。
 * @param context - 一次性读好的"当前世界"。
 * @param limit - 窗口大小（默认 {@link DEFAULT_CONFORMANCE_WINDOW}）。
 */
export function conformanceRollup(context: ConformanceContext, limit: number = DEFAULT_CONFORMANCE_WINDOW): ConformanceRollup {
    const windowSize = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_CONFORMANCE_WINDOW
    const store = new MissionStore({ layout: context.layout })
    const all = store.list()
    const ordered = [...all].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    const current = ordered.slice(0, windowSize)
    const previous = ordered.slice(windowSize, windowSize * 2)

    const headlines = zeroHeadlineCounts()
    const dimensions = zeroDimensionCounts()
    const entries: ConformanceWindowEntry[] = []
    const blind: string[] = []
    const unknownIds: string[] = []
    let withBlind = 0
    for (const mission of current) {
        const conformance = missionConformance(context, mission.id)
        const tokens = Object.fromEntries(
            CONFORMANCE_DIMENSIONS.map((dimension) => [dimension, conformanceStateToken(conformance.dimensions[dimension].state)]),
        ) as Record<ConformanceDimensionName, string>
        entries.push({ missionId: mission.id, createdAt: mission.createdAt, headline: conformance.headline, dimensions: tokens })
        headlines[conformance.headline] += 1
        if (conformance.headline === 'unknown') unknownIds.push(mission.id)
        for (const dimension of CONFORMANCE_DIMENSIONS) {
            const counts = dimensions[dimension]
            const token = tokens[dimension]
            if (counts[token] === undefined) counts[token] = 0
            counts[token] += 1
        }
        if (conformance.blind.length > 0) withBlind += 1
    }

    const previousHeadlines = zeroHeadlineCounts()
    for (const mission of previous) {
        const conformance = missionConformance(context, mission.id)
        previousHeadlines[conformance.headline] += 1
    }

    const known = new Set(all.map((mission) => mission.id))
    for (const entry of listEntries(context.layout.missionsDir).entries) {
        if (known.has(entry)) continue
        const full = path.join(context.layout.missionsDir, entry)
        let directory = false
        try {
            directory = fs.statSync(full).isDirectory()
        } catch {
            directory = false
        }
        if (directory) blind.push(`missions/${entry}/mission.json 读不到或不是合法记录：该 mission 没有计入分布`)
    }
    if (all.length > windowSize) {
        blind.push(`分布只统计最新 ${windowSize} 个 mission（仓库共 ${all.length} 个）：更早的 ${all.length - windowSize} 个没有计入`)
    }
    for (const ledger of [context.ledgers.plan, context.ledgers.releases, context.ledgers.deployments]) {
        if (!ledger.present) {
            blind.push(`${rel(context.layout, ledger.file)} 不存在：${ledger.name} 台账里的关联没有进入分布`)
        }
    }
    if (withBlind > 0) {
        blind.push(`${withBlind} 个 mission 至少有一个维度存在盲区（缺台账、legacy 授权等）：用 suite_status 看具体是哪个 mission 的哪一项`)
    }
    if (unknownIds.length > 0) {
        // Counted, not named: this distribution is about states, and another
        // surface's window (delivery metrics' windowDays) must not be confused
        // with this one by a list of mission ids appearing in its report.
        blind.push(`${unknownIds.length} 个 mission 的头行是 unknown（记录不足以判断，unknown 不优于 partial）：用 suite_status 看具体是哪一个`)
    }
    for (const entry of context.requirements.blind) if (!blind.includes(entry)) blind.push(entry)

    const rollup: ConformanceRollup = {
        limit: windowSize,
        total: ordered.length,
        window: entries,
        headlines,
        dimensions,
        blind: uniqueStrings(blind),
    }
    if (previous.length > 0) {
        const compared = CONFORMANCE_HEADLINES.map((state) => `${state} ${previousHeadlines[state]}→${headlines[state]}`).join('、')
        rollup.trend = {
            previousSize: previous.length,
            previousHeadlines,
            line: `与上一窗口相比（上一窗口 ${previous.length} 个 mission → 本窗口 ${entries.length} 个）：${compared}`,
        }
    }
    return rollup
}

/**
 * 一次完整的一致性视图：当前 mission（显式 id → 最新 mission）+ 仓库级分布。
 * @param options - 布局、注入时钟、可选 mission 与窗口大小。
 */
export function conformanceOverview(options: ConformanceOverviewOptions): ConformanceOverview {
    const { layout, now } = options
    const context = buildConformanceContext({
        layout,
        now,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
        ...(options.requirements === undefined ? {} : { requirements: options.requirements }),
    })
    const store = new MissionStore({ layout })
    let missionId = options.missionId
    if (missionId === undefined || missionId === '') {
        const ordered = [...store.list()].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
        missionId = ordered[0]?.id
    }
    const mission =
        missionId === undefined
            ? unknownMission(undefined, `本工作区还没有任何 mission（${rel(layout, layout.missionsDir)} 为空或不存在）`)
            : missionConformance(context, missionId)
    return {
        now,
        workspace: layout.cwd,
        mission,
        rollup: conformanceRollup(context, options.limit),
    }
}

/** 供报告使用的一句话摘要（不含任何评分）。 */
export function describeConformanceHeadline(mission: MissionConformance): string {
    const tokens = CONFORMANCE_DIMENSIONS.map(
        (dimension) => `${CONFORMANCE_DIMENSION_LABEL[dimension]} ${shortState(mission.dimensions[dimension].state)}`,
    ).join('、')
    return `${HEADLINE_LABEL[mission.headline]}（${tokens}）`
}

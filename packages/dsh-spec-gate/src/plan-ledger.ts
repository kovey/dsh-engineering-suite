/**
 * The plan ledger: one repository-level index of every planning transition.
 *
 * Requirement ids are stable *inside* one mission, and that used to be all they
 * were: a later mission could not see the earlier ones, so "which requirements
 * exist in this repository, which are approved, which are delivered, and in
 * which mission does each one live" had no answer at all. The ledger is that
 * answer — an append-only JSONL at `<layout.rootDir>/plan.jsonl` (config:
 * `planFile`) that `spec_create`, `spec_approve` and `spec_amend` append to.
 *
 * Three rules shape everything here:
 *
 *  - **the specification is the authority, the ledger is an index.** A failed
 *    append is logged and reported as a warning in the tool's output — it never
 *    fails the spec operation, and the file can be rebuilt from the specs;
 *  - **the newest row wins.** The same requirement appears in several rows
 *    (created → amended → milestone-changed) and every row carries the FULL id
 *    list of the revision it recorded, so a later row can never lose state an
 *    earlier one had;
 *  - **a conflict is reported, never merged.** One id in two missions is
 *    ambiguity about which requirement the id names, and guessing an owner
 *    would be exactly the silent merge this ledger exists to prevent.
 *
 * @module dsh-spec-gate/plan-ledger
 */

import path from 'node:path'
import {
    appendJsonl,
    formatTime,
    readText,
    resolvePath,
    type GateRecord,
    type GateState,
    type Layout,
    type Logger,
    type MissionRecord,
    type MissionStore,
} from 'dsh-eng-core'
import type { SpecGateConfig } from './config.js'
import { milestoneOf } from './spec.js'
import { readSpecBudgets } from './budgets.js'

/** The transitions a plan row can record. */
export type PlanRowKind = 'spec-created' | 'spec-approved' | 'spec-amended' | 'requirement-retired' | 'milestone-changed' | 'budget-retired'

/**
 * One appended planning transition.
 *
 * `specId` equals `missionId` today: this suite keys the specification artifact
 * by mission (`.dsh/specs/<mission-id>.md`). It is a separate column so the two
 * can be decoupled later without rewriting the ledger.
 */
export interface PlanRow {
    /** Epoch milliseconds of the transition. */
    at: number
    kind: PlanRowKind
    missionId: string
    specId: string
    /** Specification title at that moment. */
    title: string
    milestone?: string
    /** `R-00n` ids of the requirements list after the transition. */
    requirementIds: string[]
    /** `AC-00n` ids of the acceptance criteria after the transition. */
    criteriaIds: string[]
    /**
     * 非功能预算的 id（转换之后那一版的活预算）。
     *
     * 与 `requirementIds` 同一条规则：每一行都带上完整清单，所以「后一行覆盖前一行」
     * 不会丢掉任何一条声明。旧版本写的行没有这个字段，读的一方按「未记录」处理。
     */
    budgetIds?: string[]
    /** 本次转换作废掉的预算编号（`budget-retired` 行会带上）。 */
    retiredBudgetIds?: string[]
    /** Ids this transition RETIRED (a `requirement-retired` row carries them). */
    retiredRequirementIds?: string[]
    approvedBy?: string
    summary: string
}

/** Default ledger location; the resolved path follows `layout.rootDir`. */
export const DEFAULT_PLAN_FILE = '.dsh/plan.jsonl'

/**
 * Absolute path of the plan ledger for one workspace.
 *
 * The default follows the layout root: `rootDir` is a profile-level decision, and
 * a ledger that ignored it would describe missions stored somewhere else. An
 * explicitly configured `planFile` is resolved against the workspace (`~`
 * expanded) like every other path in the suite.
 * @param layout - the workspace layout.
 * @param config - resolved configuration (only `planFile` is read).
 */
export function planLedgerFile(layout: Layout, config: Pick<SpecGateConfig, 'planFile'>): string {
    return config.planFile === DEFAULT_PLAN_FILE
        ? path.join(layout.rootDir, 'plan.jsonl')
        : resolvePath(config.planFile, layout.cwd)
}

/** The ledger path as the caller sees it (workspace-relative when possible). */
export function describePlanFile(layout: Layout, file: string): string {
    return path.relative(layout.cwd, file) || file
}

/** What one read of the ledger found. */
export interface PlanLedgerRead {
    file: string
    exists: boolean
    rows: PlanRow[]
    /** Lines that were skipped (a truncated tail after a crash is expected). */
    unparsable: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * Whether a parsed line has the shape of a plan row.
 *
 * Unknown KINDS are accepted on purpose (a newer plugin version may append one);
 * an id list that is not an array is not, because a row whose ids cannot be read
 * would silently hide requirements from the report.
 */
function isPlanRow(value: unknown): boolean {
    if (!isRecord(value)) return false
    if (typeof value['at'] !== 'number' || typeof value['kind'] !== 'string') return false
    if (typeof value['missionId'] !== 'string' || typeof value['specId'] !== 'string') return false
    if (typeof value['title'] !== 'string' || typeof value['summary'] !== 'string') return false
    if (stringList(value['requirementIds']) === undefined) return false
    if (stringList(value['criteriaIds']) === undefined) return false
    if (value['budgetIds'] !== undefined && stringList(value['budgetIds']) === undefined) return false
    if (value['retiredBudgetIds'] !== undefined && stringList(value['retiredBudgetIds']) === undefined) return false
    if (value['retiredRequirementIds'] !== undefined && stringList(value['retiredRequirementIds']) === undefined) return false
    if (value['milestone'] !== undefined && typeof value['milestone'] !== 'string') return false
    if (value['approvedBy'] !== undefined && typeof value['approvedBy'] !== 'string') return false
    return true
}

/**
 * Read the ledger.
 *
 * A missing file is reported as `exists: false` (never as an empty ledger: an
 * empty report would claim "no requirements exist" about a repository that has
 * simply never used the ledger). Lines that do not parse are counted instead of
 * throwing — a crash can leave a truncated last line behind.
 * @param file - absolute ledger path.
 */
export function readPlanLedger(file: string): PlanLedgerRead {
    const text = readText(file)
    if (text === undefined) return { file, exists: false, rows: [], unparsable: 0 }
    const rows: PlanRow[] = []
    let unparsable = 0
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            unparsable += 1
            continue
        }
        if (!isPlanRow(parsed)) {
            unparsable += 1
            continue
        }
        rows.push(parsed as unknown as PlanRow)
    }
    return { file, exists: true, rows, unparsable }
}

/** Outcome of an append: how much landed, and what to tell the model. */
export interface PlanAppendResult {
    written: number
    /** Present when nothing (or only part of the rows) could be appended. */
    warning?: string
}

/**
 * Append rows to the ledger WITHOUT ever failing the caller's operation.
 *
 * The specification is the authority and the ledger is an index, so a read-only
 * `.dsh`, a full disk or a rogue directory at the ledger path must not turn a
 * successful `spec_create` into an error. The failure is logged and returned so
 * the tool can report it as a warning.
 * @param file - absolute ledger path.
 * @param rows - rows to append, in order (an empty list appends nothing).
 * @param logger - diagnostics sink.
 */
export function appendPlanRows(file: string, rows: readonly PlanRow[], logger?: Logger): PlanAppendResult {
    if (rows.length === 0) return { written: 0 }
    let written = 0
    try {
        for (const row of rows) {
            appendJsonl(file, row)
            written += 1
        }
        return { written }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn(`plan ledger append failed (${file}, ${written}/${rows.length} rows): ${message}`)
        return {
            written,
            warning: [
                `⚠️ 规划台账写入失败（${file}，已写入 ${written}/${rows.length} 行）：${message}`,
                '规格本身已保存：台账只是索引，可从规格重建，本次变更不会出现在 plan_status 里。',
            ].join('\n'),
        }
    }
}

/** Spec status as the ledger report shows it (`unknown` = no mission record). */
export type PlanSpecStatus = 'draft' | 'approved' | 'unknown'

/** One requirement (or acceptance criterion) of ONE mission, from the ledger. */
export interface PlanRequirementState {
    id: string
    /** Live text, when the owning mission still has the specification. */
    text?: string
    /** The mission the id belongs to: ids are stable per mission, not per repo. */
    missionId: string
    missionTitle: string
    milestone?: string
    specStatus: PlanSpecStatus
    /** A delivery receipt exists for the owning mission. */
    delivered: boolean
    retired: boolean
    retiredAt?: number
    /** Every mission whose rows mention this id, newest mention first. */
    missions: string[]
    /** The other missions with the same id — reported, never silently merged. */
    conflicts: string[]
}

/**
 * 一条非功能预算在台账报告里的状态。
 *
 * 「验证过没有」是这份报告存在的理由之一：规格可以声明一条 p95 预算，但只有
 * `budget_check` 真的跑过它，才谈得上验证。没有记录 = **未验证**（不是「通过」，也不
 * 是「不存在」）。
 */
export interface PlanBudgetState {
    id: string
    missionId: string
    /** 有一条记录在案的预算裁决覆盖了它（`false` = 未验证）。 */
    verified: boolean
    /** 覆盖它的那条裁决的状态（BLOCK 也是「验证过」：测了，没过）。 */
    state?: GateState
    at?: number
    gateId?: string
    /** 那条裁决的行里标注了「来源：规格」（即这次测量用的是规格声明的那条预算）。 */
    fromSpec?: boolean
    /** 规格里声明的关联编号（`R-00n` / `AC-00n`）。 */
    requirementIds?: string[]
    /** 这条 id 来自台账行而不是 mission 记录（记录已丢失时的兜底）。 */
    fromLedger?: boolean
}

/** One mission as the ledger report shows it. */
export interface PlanMissionState {
    id: string
    title: string
    status: string
    specStatus: PlanSpecStatus
    delivered: boolean
    milestone?: string
    requirements: number
    /** 该 mission 声明的非功能预算及其验证状态。 */
    budgets: PlanBudgetState[]
    /** 该 mission 已作废的预算编号（不会复用）。 */
    retiredBudgetIds: string[]
}

/** Requirements of one milestone (`milestone` unset = the 无里程碑 group). */
export interface PlanMilestoneGroup {
    milestone?: string
    label: string
    requirements: PlanRequirementState[]
}

/** The whole read-only answer of `plan_status`. */
export interface PlanReport {
    file: string
    relativeFile: string
    exists: boolean
    rows: number
    unparsable: number
    missions: PlanMissionState[]
    groups: PlanMilestoneGroup[]
    undelivered: PlanRequirementState[]
    retired: PlanRequirementState[]
    /** 所有声明过的非功能预算（按 mission 过滤之后）。 */
    budgets: PlanBudgetState[]
    /** 其中没有任何预算裁决覆盖的那些。 */
    unverifiedBudgets: PlanBudgetState[]
    /** Ids in more than one mission: reported, never merged. */
    conflicts: { id: string; missions: string[] }[]
    /** Missions the ledger mentions but the store no longer has. */
    orphans: string[]
    generatedAt: number
}

/** The label of the explicit "no milestone" group. */
export const NO_MILESTONE_LABEL = '无里程碑'

/** Options for {@link buildPlanReport}. */
export interface PlanReportOptions {
    store: MissionStore
    /** Absolute ledger path. */
    file: string
    /** Only this milestone (pass {@link NO_MILESTONE_LABEL} for the empty one). */
    milestone?: string
    /** Only requirements that this mission mentioned. */
    missionId?: string
    now?: number
}

/** Every id one row mentions (live ids first, then the retired ones). */
function idsOf(row: PlanRow): string[] {
    const ids: string[] = []
    for (const id of [...row.requirementIds, ...row.criteriaIds, ...(row.retiredRequirementIds ?? [])]) {
        if (!ids.includes(id)) ids.push(id)
    }
    return ids
}

/** One requirement INSTANCE of one mission, reconstructed from its newest row. */
interface Instance {
    id: string
    missionId: string
    row: PlanRow
    index: number
}

/** One mention of an id: which mission, when. */
interface Mention {
    missionId: string
    at: number
}

/** Requirement text from a mission record, when it still has the document. */
function textOf(record: MissionRecord | undefined, id: string): string | undefined {
    const spec = record?.spec
    if (spec === undefined) return undefined
    const entry = [...spec.requirements, ...spec.acceptanceCriteria].find((candidate) => candidate.id.toUpperCase() === id.toUpperCase())
    return entry?.text
}

/**
 * How the recorded budget verdicts are recognised.
 *
 * `dsh-quality-gate` writes `${reason}（预算裁决；scope.full=false，不构成交付依据）`
 * into every budget gate row, and every row of that verdict is one budget. These two
 * literals are the whole join key between the two plugins — they talk through the
 * mission store, never by importing each other (see the module docs of
 * `dsh-quality-gate/budget`). If either side ever renames them, the report degrades
 * to "未验证" (a missing claim), never to a false "已验证".
 */
const BUDGET_VERDICT_MARK = '预算裁决'

/** The label `dsh-quality-gate` puts on a row whose budget came from the spec. */
const SPEC_ORIGIN_MARK = '来源：规格'

/** The recorded budget verdicts of one mission (`budget_check` only). */
function budgetVerdicts(store: MissionStore, missionId: string): GateRecord[] {
    try {
        return store.readGates(missionId).filter((gate) => gate.source === 'dsh-quality-gate' && gate.reason.includes(BUDGET_VERDICT_MARK))
    } catch {
        // An unreadable gate directory must not crash the report; "verified" simply
        // stays unproven, which is the honest reading.
        return []
    }
}

/** Whether one budget id was measured by a recorded budget verdict. */
export interface BudgetVerification {
    verified: boolean
    state?: GateState
    at?: number
    gateId?: string
    /** The recorded row said the budget came from the specification. */
    fromSpec?: boolean
}

/**
 * Look up one budget id in the mission's recorded budget verdicts.
 *
 * READ-ONLY. "Verified" means a recorded verdict actually contains a row for this id
 * — the absence of a verdict is `未验证`, never a pass. The newest verdict wins.
 * @param store - the workspace store.
 * @param missionId - the mission whose gate records are searched.
 * @param budgetId - the budget id to look up.
 * @param verdicts - pre-fetched verdicts (the report reads them once per mission).
 */
export function budgetVerification(
    store: MissionStore,
    missionId: string,
    budgetId: string,
    verdicts?: readonly GateRecord[],
): BudgetVerification {
    const gates = verdicts ?? budgetVerdicts(store, missionId)
    let newest: { gate: GateRecord; fromSpec: boolean } | undefined
    for (const gate of gates) {
        const result = gate.results.find((entry) => entry.id === budgetId)
        if (result === undefined) continue
        if (newest === undefined || gate.checkedAt >= newest.gate.checkedAt) {
            newest = { gate, fromSpec: result.output.includes(SPEC_ORIGIN_MARK) }
        }
    }
    if (newest === undefined) return { verified: false }
    return { verified: true, state: newest.gate.state, at: newest.gate.checkedAt, gateId: newest.gate.id, fromSpec: newest.fromSpec }
}

/** One budget id's verification state, as `spec_status` / `plan_status` print it. */
export function describeBudgetVerification(verification: BudgetVerification): string {
    if (!verification.verified) return '未验证（没有任何记录在案的预算裁决提到它）'
    return (
        `已验证：${verification.state ?? '(状态未知)'}` +
        `${verification.at === undefined ? '' : ` @ ${formatTime(verification.at)}`}` +
        `${verification.fromSpec === true ? '，来源：规格' : ''}` +
        `${verification.gateId === undefined ? '' : `（${verification.gateId}）`}`
    )
}

/**
 * One mission's declared budgets plus whether anything ever measured them.
 *
 * The mission record is the authority for WHAT is declared (the specification owns
 * it); the ledger rows are the fallback when the record is gone, and the quality
 * gate's recorded verdicts are the only evidence of verification. A budget id that
 * appears in no verdict is reported `未验证` — never as verified-by-absence.
 * @param store - the workspace store (gate records live in the mission directory).
 * @param missionId - the mission whose budgets are described.
 * @param record - the mission record, when it still exists.
 * @param rows - every ledger row (filtered here to this mission).
 */
function budgetStatesOf(
    store: MissionStore,
    missionId: string,
    record: MissionRecord | undefined,
    rows: readonly PlanRow[],
): { budgets: PlanBudgetState[]; retired: string[] } {
    const declared = readSpecBudgets(record?.spec)
    const mine = rows.filter((row) => row.missionId === missionId)
    const retired = new Set(declared.retired)
    for (const row of mine) for (const id of row.retiredBudgetIds ?? []) retired.add(id)
    const latestRow = [...mine].sort((left, right) => left.at - right.at).at(-1)
    const liveIds = declared.budgets.length > 0 ? declared.budgets.map((budget) => budget.id) : (latestRow?.budgetIds ?? [])
    const verdicts = budgetVerdicts(store, missionId)
    const budgets: PlanBudgetState[] = []
    for (const id of liveIds) {
        if (retired.has(id)) continue
        const budget = declared.budgets.find((entry) => entry.id === id)
        const verification = budgetVerification(store, missionId, id, verdicts)
        budgets.push({
            id,
            missionId,
            verified: verification.verified,
            ...(verification.verified === false
                ? {}
                : { state: verification.state, at: verification.at, gateId: verification.gateId, fromSpec: verification.fromSpec }),
            ...(budget?.requirementIds === undefined ? {} : { requirementIds: [...budget.requirementIds] }),
            ...(budget === undefined ? { fromLedger: true } : {}),
        })
    }
    return { budgets, retired: [...retired] }
}

/**
 * Join the ledger with the mission store.
 *
 * READ-ONLY: it reads the ledger, the mission records, the recorded gate runs and
 * the receipts, and writes nothing. The mission store is the authority for the
 * CURRENT state (spec status, delivery, milestone, declared budgets), while the
 * ledger decides which ids exist and which mission first mentioned them.
 * @param options - store, ledger path and the optional filters.
 */
export function buildPlanReport(options: PlanReportOptions): PlanReport {
    const layout = options.store.layout
    const now = options.now ?? Date.now()
    const relativeFile = describePlanFile(layout, options.file)
    const ledger = readPlanLedger(options.file)
    if (!ledger.exists) {
        return {
            file: options.file,
            relativeFile,
            exists: false,
            rows: 0,
            unparsable: 0,
            missions: [],
            groups: [],
            undelivered: [],
            retired: [],
            budgets: [],
            unverifiedBudgets: [],
            conflicts: [],
            orphans: [],
            generatedAt: now,
        }
    }

    // A requirement's identity is (mission, id): ids are stable INSIDE one
    // mission and restart at `R-001`/`AC-001` in the next one, so collapsing the
    // same id from two missions into one row would invent a requirement that
    // nobody ever wrote. "The newest row wins" therefore applies per mission —
    // that is where the created → amended → milestone-changed sequence lives.
    const instances = new Map<string, Instance>()
    const byId = new Map<string, Mention[]>()
    for (const [index, row] of ledger.rows.entries()) {
        for (const id of idsOf(row)) {
            const key = `${row.missionId}\u0000${id}`
            const previous = instances.get(key)
            // Greatest `at`, and for a tie the later line: the rows of one
            // transition are appended in order, so a `milestone-changed` row
            // follows the row whose state it corrects.
            if (previous === undefined || row.at > previous.row.at || (row.at === previous.row.at && index >= previous.index)) {
                instances.set(key, { id, missionId: row.missionId, row, index })
            }
            const seen = byId.get(id) ?? []
            if (!seen.some((entry) => entry.missionId === row.missionId)) seen.push({ missionId: row.missionId, at: row.at })
            byId.set(id, seen)
        }
    }

    const lastRowAt = new Map<string, number>()
    for (const row of ledger.rows) {
        lastRowAt.set(row.missionId, Math.max(lastRowAt.get(row.missionId) ?? 0, row.at))
    }
    const missionIds = [...lastRowAt.keys()].sort((left, right) => (lastRowAt.get(right) ?? 0) - (lastRowAt.get(left) ?? 0) || left.localeCompare(right))
    const records = new Map<string, MissionRecord>()
    const missions: PlanMissionState[] = []
    const orphanIds: string[] = []
    for (const id of missionIds) {
        // A hand-edited ledger row can carry an id that is not a single path
        // segment; `store.read` refuses those, and an unreadable mission is
        // reported as unknown rather than crashing the report.
        let record: MissionRecord | undefined
        try {
            record = options.store.read(id)
        } catch {
            record = undefined
        }
        if (record !== undefined) records.set(id, record)
        else orphanIds.push(id)
        let delivered = false
        try {
            delivered = options.store.readReceipts(id).length > 0
        } catch {
            delivered = false
        }
        const newestTitle = [...ledger.rows].reverse().find((row) => row.missionId === id)?.title ?? id
        const milestone = record === undefined ? undefined : milestoneOf(record)
        const budgetState = budgetStatesOf(options.store, id, record, ledger.rows)
        missions.push({
            id,
            title: record?.title ?? newestTitle,
            status: record?.status ?? '(mission 记录缺失)',
            specStatus: record === undefined ? 'unknown' : record.spec?.approvedAt === undefined ? 'draft' : 'approved',
            delivered,
            ...(milestone === undefined ? {} : { milestone }),
            requirements: [...instances.values()].filter((entry) => entry.missionId === id).length,
            budgets: budgetState.budgets,
            retiredBudgetIds: budgetState.retired,
        })
    }

    const requirements: PlanRequirementState[] = []
    for (const instance of instances.values()) {
        const { id, missionId, row } = instance
        const record = records.get(missionId)
        const rowMilestone = row.milestone === undefined || row.milestone === '' ? undefined : row.milestone
        // The mission store is the authority for the current milestone; a row's
        // value is the fallback when that mission record is gone.
        const milestone = record === undefined ? rowMilestone : (milestoneOf(record) ?? rowMilestone)
        const missionList = [...(byId.get(id) ?? [])].sort((left, right) => right.at - left.at).map((entry) => entry.missionId)
        const text = textOf(record, id)
        const retired = (row.retiredRequirementIds ?? []).includes(id)
        const missionState = missions.find((mission) => mission.id === missionId)
        requirements.push({
            id,
            missionId,
            missionTitle: record?.title ?? row.title,
            ...(text === undefined ? {} : { text }),
            ...(milestone === undefined ? {} : { milestone }),
            specStatus: missionState?.specStatus ?? 'unknown',
            delivered: missionState?.delivered ?? false,
            retired,
            ...(retired ? { retiredAt: row.at } : {}),
            missions: missionList,
            conflicts: missionList.filter((candidate) => candidate !== missionId),
        })
    }
    requirements.sort((left, right) => left.id.localeCompare(right.id) || left.missionId.localeCompare(right.missionId))

    // Filters first, so the lists and the groups of one report can never
    // describe different sets.
    const selected = requirements.filter((requirement) => {
        if (options.missionId !== undefined && requirement.missionId !== options.missionId) return false
        if (options.milestone === undefined) return true
        if (options.milestone === NO_MILESTONE_LABEL) return requirement.milestone === undefined
        return requirement.milestone === options.milestone
    })

    const grouped = new Map<string, PlanRequirementState[]>()
    for (const requirement of selected.filter((entry) => !entry.retired)) {
        const key = requirement.milestone ?? ''
        grouped.set(key, [...(grouped.get(key) ?? []), requirement])
    }
    const groups: PlanMilestoneGroup[] = [...grouped.entries()]
        .map(([key, entries]) => ({
            ...(key === '' ? {} : { milestone: key }),
            label: key === '' ? NO_MILESTONE_LABEL : key,
            requirements: entries,
        }))
        // Named milestones in code-point order, the explicit 无里程碑 group last.
        .sort((left, right) => {
            if (left.milestone === undefined) return 1
            if (right.milestone === undefined) return -1
            return left.milestone.localeCompare(right.milestone)
        })

    const visibleMissions = options.missionId === undefined ? missions : missions.filter((mission) => mission.id === options.missionId)
    const budgets = visibleMissions.flatMap((mission) => mission.budgets)

    return {
        file: options.file,
        relativeFile,
        exists: true,
        rows: ledger.rows.length,
        unparsable: ledger.unparsable,
        missions: visibleMissions,
        groups,
        undelivered: selected.filter((entry) => !entry.retired && !entry.delivered),
        retired: selected.filter((entry) => entry.retired),
        budgets,
        unverifiedBudgets: budgets.filter((budget) => !budget.verified),
        // Conflicts are filter-independent on purpose: the warning "this id lives
        // in two missions" must survive the very filter that hid the other one.
        conflicts: [...byId.entries()]
            .filter(([, mentions]) => new Set(mentions.map((mention) => mention.missionId)).size > 1)
            .map(([id, mentions]) => ({
                id,
                missions: [...mentions].sort((left, right) => right.at - left.at).map((mention) => mention.missionId),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        orphans: options.missionId === undefined ? orphanIds : orphanIds.filter((id) => id === options.missionId),
        generatedAt: now,
    }
}

/** `R-001 文本` — the id, plus the text when the mission still has it. */
function requirementLine(requirement: PlanRequirementState): string {
    const text = requirement.text === undefined ? '' : ` ${requirement.text}`
    const where = `mission \`${requirement.missionId}\``
    const spec = requirement.specStatus === 'approved' ? '规格已审批' : requirement.specStatus === 'draft' ? '规格 draft' : '规格状态未知'
    const delivery = requirement.delivered ? '已交付' : '未交付'
    const milestone = requirement.milestone === undefined ? `，${NO_MILESTONE_LABEL}` : `，里程碑 ${requirement.milestone}`
    const conflict =
        requirement.conflicts.length === 0
            ? ''
            : ` ⚠ 重号：也出现在 ${requirement.conflicts.map((id) => `\`${id}\``).join('、')}`
    return `- \`${requirement.id}\`${text}（${where}，${spec}，${delivery}${milestone}）${conflict}`
}

/**
 * How one budget's verification state reads.
 *
 * "未验证" is spelled out with its evidence rule, because a bare dash next to a
 * budget looks like a passing grade.
 * @param budget - the budget state from the report.
 */
export function budgetStateLine(budget: PlanBudgetState): string {
    const requirements = budget.requirementIds === undefined || budget.requirementIds.length === 0 ? '' : `，关联 ${budget.requirementIds.join('、')}`
    if (!budget.verified) {
        return `未验证（没有任何记录在案的预算裁决提到它${requirements}）`
    }
    return `${describeBudgetVerification(budget)}${requirements}`
}

/**
 * Render the report for the model.
 *
 * A missing ledger gets its own sentence instead of an empty table: "no
 * requirements" and "no ledger yet" are different facts, and only the second one
 * has an obvious first step.
 * @param report - the built report.
 */
export function renderPlanReport(report: PlanReport): string {
    if (!report.exists) {
        return [
            '本仓库还没有规划台账（第一条 spec_create 会创建）。',
            `台账文件：${report.relativeFile}`,
            '台账会记录每次 spec_create / spec_approve / spec_amend 的编号、里程碑与审批人；它只是索引，规格才是权威。',
        ].join('\n')
    }
    const ids = report.groups.reduce((total, group) => total + group.requirements.length, 0) + report.retired.length
    const lines: string[] = [
        '## 规划台账（plan_status）',
        '',
        `台账：${report.relativeFile}`,
        `行数：${report.rows}${report.unparsable === 0 ? '' : `（另有 ${report.unparsable} 行无法解析，已跳过：崩溃留下的截断尾行按预期忽略）`}`,
        `mission：${report.missions.length} 个；编号：${ids} 个（已作废 ${report.retired.length} 个）`,
        `非功能预算：${report.budgets.length} 条（未验证 ${report.unverifiedBudgets.length} 条 —— 未验证 ≠ 通过）`,
        '（编号在 mission 内稳定：每个 mission 都从 R-001 / AC-001 开始，跨 mission 用 mission id 区分。）',
        '',
    ]

    if (report.missions.length > 0) {
        lines.push('### mission', '')
        for (const mission of report.missions) {
            lines.push(
                `- \`${mission.id}\` ${mission.title} — ${mission.status}；` +
                    `${mission.specStatus === 'approved' ? '规格已审批' : mission.specStatus === 'draft' ? '规格 draft' : '规格状态未知'}；` +
                    `${mission.delivered ? '已交付' : '未交付'}；编号 ${mission.requirements} 个` +
                    `${mission.milestone === undefined ? '' : `；里程碑 ${mission.milestone}`}` +
                    `${mission.budgets.length === 0 ? '' : `；预算 ${mission.budgets.length} 条`}`,
            )
            for (const budget of mission.budgets) {
                lines.push(`  · 预算 \`${budget.id}\`：${budgetStateLine(budget)}`)
            }
            if (mission.retiredBudgetIds.length > 0) {
                lines.push(`  · 已作废预算编号（不会复用）：${mission.retiredBudgetIds.map((id) => `\`${id}\``).join('、')}`)
            }
        }
        lines.push('')
    }

    if (report.groups.length === 0) {
        lines.push('### 需求（按里程碑分组）', '', '(没有匹配的编号)', '')
    }
    for (const group of report.groups) {
        lines.push(`### ${group.milestone === undefined ? NO_MILESTONE_LABEL : `里程碑：${group.milestone}`}（${group.requirements.length} 条）`, '')
        for (const requirement of group.requirements) lines.push(requirementLine(requirement))
        lines.push('')
    }

    lines.push(`### 未交付（${report.undelivered.length} 条）`, '')
    if (report.undelivered.length === 0) lines.push('(无)')
    for (const requirement of report.undelivered) lines.push(requirementLine(requirement))
    lines.push('')

    lines.push(`### 已作废（${report.retired.length} 条）`, '')
    if (report.retired.length === 0) lines.push('(无)')
    for (const requirement of report.retired) {
        // The ledger records ids, not prose; a retired id is gone from the
        // mission's specification too, so its text is usually unrecoverable —
        // say so instead of printing an empty pair of brackets.
        const text = requirement.text === undefined ? '文本已随删除从规格中移除（台账只记编号）' : requirement.text
        lines.push(
            `- \`${requirement.id}\` ${text}（mission \`${requirement.missionId}\`，` +
                `作废于 ${requirement.retiredAt === undefined ? '(未知时间)' : formatTime(requirement.retiredAt)}，编号不会复用）`,
        )
    }
    lines.push('')

    lines.push(`### 非功能预算（${report.budgets.length} 条，未验证 ${report.unverifiedBudgets.length} 条）`, '')
    if (report.budgets.length === 0) {
        lines.push('(无：没有任何 mission 的规格声明非功能预算 —— 声明过的预算会出现在这里，连同它验证过没有)')
    } else {
        for (const budget of report.budgets) {
            lines.push(`- \`${budget.id}\`（mission \`${budget.missionId}\`）${budgetStateLine(budget)}`)
        }
        if (report.unverifiedBudgets.length > 0) {
            lines.push(
                '',
                '未验证 = 没有任何记录在案的预算裁决覆盖它（不是通过，也不是不存在）：规格声明的非功能要求只有在 `budget_check` 真跑过之后才算验证。',
                '下一步：在 quality-gate 里装配这些预算的命令并跑 `budget_check`（规格声明的预算会被自动读取，报告里标注「来源：规格」）；',
                '要改或删一条声明请用 `spec_amend`（删除会作废编号，永不复用），不要在宿主配置里静默改口径。',
            )
        }
    }
    lines.push('')

    lines.push('### 编号 → mission（反查）', '')
    if (report.groups.length === 0 && report.retired.length === 0) lines.push('(无)')
    // One line per id (not per instance): the question this section answers is
    // "which missions does this address point at".
    const reverse = new Map<string, PlanRequirementState>()
    for (const requirement of [...report.groups.flatMap((group) => group.requirements), ...report.retired]) {
        const existing = reverse.get(requirement.id)
        if (existing === undefined || (existing.retired && !requirement.retired)) reverse.set(requirement.id, requirement)
    }
    for (const requirement of [...reverse.values()].sort((left, right) => left.id.localeCompare(right.id))) {
        lines.push(
            `- \`${requirement.id}\` → ${requirement.missions.map((id) => `\`${id}\``).join('、')}${requirement.retired ? '（已作废）' : ''}`,
        )
    }
    lines.push('')

    if (report.conflicts.length > 0) {
        lines.push(`### ⚠ 冲突（${report.conflicts.length} 个编号出现在多个 mission）`, '')
        for (const conflict of report.conflicts) {
            lines.push(`- \`${conflict.id}\`：${conflict.missions.map((id) => `\`${id}\``).join('、')}`)
        }
        lines.push(
            '',
            '编号在 mission 内稳定，但**跨 mission 不唯一**（每个 mission 都从 R-001/AC-001 开始）：台账只报告冲突，',
            '不会替你合并或改号，也不会把两个 mission 的同名编号当成同一条需求。',
            '下一步：引用编号时带上 mission（`plan_status({ missionId })` 看单个 mission 的编号）；',
            '如果两条其实是同一条需求，把其中一个 mission 的条目改文本/重新编号（`spec_amend`），或把它们并到同一个 mission。',
            '',
        )
    }
    if (report.orphans.length > 0) {
        lines.push(`### ⚠ 孤儿台账行（${report.orphans.length} 个 mission 没有记录文件）`, '')
        for (const id of report.orphans) lines.push(`- \`${id}\`：台账里有它的行，但 .dsh/missions/${id}/mission.json 不存在（被删除或换了工作区？）`)
        lines.push('')
    }
    lines.push(
        '说明：台账只是索引（可从 `.dsh/specs/*.md` 与 mission 记录重建）；规格状态与交付状态取自 mission 记录与本 mission 的最新回执。',
    )
    return lines.join('\n')
}

/** Log one appended ledger write (kept here so both call sites agree). */
export function logPlanAppend(logger: Logger | undefined, result: PlanAppendResult, file: string): void {
    if (result.warning === undefined) logger?.debug(`plan ledger: appended ${result.written} row(s) to ${file}`)
}

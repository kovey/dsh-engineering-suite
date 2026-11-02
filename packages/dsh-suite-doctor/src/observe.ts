/**
 * `gate.observe` — the operator's aggregation of shadow (`observe`) rules.
 *
 * A shadow rule is a measurement, not a defect: the quality gate still evaluates
 * it and records what it WOULD have decided, but the gate's verdict ignores it.
 * The question an operator asks before switching a rule to `enforce` is a
 * statistical one — "across recent runs, how often would it have blocked, and
 * did any of those would-blocks disagree with reality?" — so this module reads
 * the durable gate records and answers exactly that.
 *
 * The window is bounded and stated in the report: the **newest 20 missions**
 * (by `updatedAt`, ties by id), all of their gate records. Missions are the
 * durable unit here; a byte or time window would make the same repository report
 * different numbers on different days without any rule changing.
 *
 * Two rules keep it honest:
 *
 *  1. a gate record WITHOUT `observations` is "no observation", never an error —
 *     records written before shadow mode existed are not defects;
 *  2. an aggregation is never `required`: a shadow rule is a measurement in
 *     progress, so it can only be advice (`recommended`), and it is `ok` when
 *     nothing is observing at all.
 *
 * @module dsh-suite-doctor/observe
 */

import type { DoctorCheck, GateObservation, GateRecord, GateState, MissionRecord } from 'dsh-eng-core'

/** The bounded window: the newest N missions (by `updatedAt`) are read. */
export const OBSERVE_WINDOW_MISSIONS = 20

/**
 * How many consecutive zero-difference observations the report asks for before
 * suggesting `enforce`. A fixed number on purpose: "some evidence" is not
 * actionable, and the operator should be able to quote the same bar in review.
 */
export const OBSERVE_ENFORCE_STREAK = 5

/**
 * The read surface of the mission store this check needs.
 *
 * Structural on purpose: the check is pure over "a list of missions and their
 * gate records", so tests can drive it without a filesystem, while the live
 * doctor passes its real `MissionStore`.
 */
export interface ObserveStoreLike {
    list(): readonly Pick<MissionRecord, 'id' | 'updatedAt'>[]
    readGates(id: string): readonly GateRecord[]
}

/** One rule's shadow tally. */
export interface ObserveRuleTally {
    /** Rule id (`commands[].id` / `budgets[].id`). */
    rule: string
    /** How many shadow verdicts were recorded for it. */
    observations: number
    /** How many of them would have decided each state. */
    would: Record<GateState, number>
    /**
     * How many of the NEWEST observations in a row would have passed. A
     * would-BLOCK (or WARN) resets it to 0: "zero difference" means the shadow
     * agreed with a clean run, not "no data".
     */
    zeroDiffStreak: number
}

/** The whole aggregation over the window. */
export interface ObserveTally {
    /** Missions inspected (at most the window). */
    missions: number
    /** Gate records read from those missions. */
    gates: number
    /** Records without an `observations` field (legacy; read as "no observation"). */
    legacyGates: number
    /** Entries inside an `observations` list that are not a valid observation. */
    invalid: number
    /** Shadow verdicts recorded in the window. */
    observations: number
    /** How many of them would have BLOCKed. */
    wouldBlock: number
    /** Per-rule tallies, ordered by rule id. */
    rules: ObserveRuleTally[]
}

/** Locale-independent id order (byte order, so two machines agree). */
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

/** Whether a persisted value is a usable observation (a hand-edited record is not trusted). */
function isObservation(value: unknown): value is GateObservation {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        typeof record['rule'] === 'string' &&
        record['rule'] !== '' &&
        record['mode'] === 'observe' &&
        (record['would'] === 'PASS' || record['would'] === 'WARN' || record['would'] === 'BLOCK') &&
        typeof record['reason'] === 'string'
    )
}

/**
 * Read the shadow verdicts of the bounded window and group them by rule.
 * @param store - the mission store (or a structural stand-in in tests).
 * @param options - window override (default {@link OBSERVE_WINDOW_MISSIONS}).
 */
export function tallyObservations(store: ObserveStoreLike, options: { windowMissions?: number } = {}): ObserveTally {
    const window = Math.max(1, Math.floor(options.windowMissions ?? OBSERVE_WINDOW_MISSIONS))
    // `updatedAt` (not `createdAt`): a long-running mission's newest gate records
    // are the ones that matter, and the report states the window it used.
    const missions = [...store.list()]
        .sort((left, right) => right.updatedAt - left.updatedAt || compareIds(left.id, right.id))
        .slice(0, window)
    const rows: { observation: GateObservation; checkedAt: number; gateId: string; index: number }[] = []
    let gates = 0
    let legacyGates = 0
    let invalid = 0
    let observations = 0
    let wouldBlock = 0
    for (const mission of missions) {
        const records = [...store.readGates(mission.id)].sort(
            (left, right) => left.checkedAt - right.checkedAt || compareIds(left.id, right.id),
        )
        for (const gate of records) {
            gates += 1
            const list: unknown = gate.observations
            if (list === undefined || !Array.isArray(list)) {
                // Absent (old record) or unusable shape: "no observation", never
                // an error — this check must not fail on history it did not write.
                legacyGates += 1
                continue
            }
            for (const [index, entry] of list.entries()) {
                if (!isObservation(entry)) {
                    invalid += 1
                    continue
                }
                observations += 1
                if (entry.would === 'BLOCK') wouldBlock += 1
                rows.push({ observation: entry, checkedAt: gate.checkedAt, gateId: gate.id, index })
            }
        }
    }
    rows.sort(
        (left, right) =>
            left.checkedAt - right.checkedAt ||
            compareIds(left.gateId, right.gateId) ||
            left.index - right.index,
    )
    const byRule = new Map<string, GateObservation[]>()
    for (const row of rows) {
        const bucket = byRule.get(row.observation.rule)
        if (bucket === undefined) byRule.set(row.observation.rule, [row.observation])
        else bucket.push(row.observation)
    }
    const rules: ObserveRuleTally[] = [...byRule.entries()]
        .sort(([left], [right]) => compareIds(left, right))
        .map(([rule, entries]) => {
            const would: Record<GateState, number> = { PASS: 0, WARN: 0, BLOCK: 0 }
            for (const entry of entries) would[entry.would] += 1
            let zeroDiffStreak = 0
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                if (entries[index]?.would !== 'PASS') break
                zeroDiffStreak += 1
            }
            return { rule, observations: entries.length, would, zeroDiffStreak }
        })
    return { missions: missions.length, gates, legacyGates, invalid, observations, wouldBlock, rules }
}

/** One rule's line in the check's detail. */
function describeRule(tally: ObserveRuleTally): string {
    return (
        `${tally.rule}：${tally.observations} 条（would BLOCK ${tally.would.BLOCK} / WARN ${tally.would.WARN} / PASS ${tally.would.PASS}）` +
        `${tally.zeroDiffStreak === 0 ? '，最近一次 would 不是 PASS' : `，当前连续 ${tally.zeroDiffStreak} 次零差异`}`
    )
}

/**
 * Build the `gate.observe` doctor check.
 *
 * `ok` + `recommended` when nothing is observing (a valid state, not a gap);
 * `partial` + `recommended` while shadow rules are being measured. It is never
 * `required` and never lands in `blockers`: a measurement in progress is not a
 * defect.
 * @param store - the mission store (or a structural stand-in in tests).
 * @param options - window override (default {@link OBSERVE_WINDOW_MISSIONS}).
 */
export function gateObserveCheck(store: ObserveStoreLike, options: { windowMissions?: number } = {}): DoctorCheck {
    const window = Math.max(1, Math.floor(options.windowMissions ?? OBSERVE_WINDOW_MISSIONS))
    const tally = tallyObservations(store, options)
    const base = {
        id: 'gate.observe',
        area: 'test' as const,
        severity: 'recommended' as const,
        label: '影子规则（gate.observe）：observe 的 would 统计',
    }
    const windowText = `窗口：最近 ${window} 个 mission（按 updatedAt 倒序）的 ${tally.gates} 条门禁记录`
    const legacy =
        tally.legacyGates === 0 ? '' : `；其中 ${tally.legacyGates} 条旧记录没有 observations 字段（按"没有观察"读取，不是错误）`
    const invalid = tally.invalid === 0 ? '' : `；另有 ${tally.invalid} 条 observations 条目无法识别，已忽略（记录损坏，不是错误）`
    if (tally.observations === 0) {
        return {
            ...base,
            state: 'ok',
            detail: `${windowText}；没有 observe 规则在测量（0 条影子记录）${legacy}${invalid}`,
        }
    }
    return {
        ...base,
        state: 'partial',
        detail:
            `${windowText}；影子记录 ${tally.observations} 条，其中 would BLOCK ${tally.wouldBlock} 条${legacy}${invalid}。` +
            `按规则：${tally.rules.map(describeRule).join('；')}`,
        fix:
            `下一步：逐条核对影子记录的 would 与真实失败是否一致（影子只记录、不阻断，误报要在这里发现）；` +
            `同一规则连续 ${OBSERVE_ENFORCE_STREAK} 次零差异（would=PASS）后再切 enforce` +
            '（把配置里的 mode: observe 删掉或改成 enforce），然后重跑一次完整 quality_gate_run 确认裁决仍为 PASS。',
    }
}

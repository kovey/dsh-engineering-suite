/**
 * Where a PASSING stage goes next (AC-005's "不值得拆" exit).
 *
 * The pipeline's `next` edge is static, but one legitimate pass changes the
 * route: a plan the threshold calls `not-worth-splitting` must send the mission
 * straight to plain `implement`, skipping `split-review`. The gate says so
 * through `GateOutcome.skip`; this module turns that instruction into the
 * successor AND into recorded `skipped` stage results, so the ledger answers
 * "why did split-review not run" without reading the plan or the code.
 *
 * Pure except for the timestamp it stamps (injected, so a report is
 * reproducible): no store writes here — the caller persists the records.
 *
 * @module dsh-orchestrator/split-advance
 */

import type { StageResult } from 'dsh-eng-core'
import type { GateOutcome } from './gate-facts.js'
import { successorOf, type Pipeline, type StageConfig } from './pipeline.js'

/** The transition a passing stage takes, plus what it skipped on the way. */
export interface StageLane {
    /** The stage the transition enters (`undefined` = end of pipeline). */
    target?: StageConfig
    /** Records to persist for the stages this pass skips. */
    skipped: StageResult[]
    /** One Chinese line for the report, when stages were skipped. */
    note?: string
}

/**
 * Resolve the successor of a passing stage.
 * @param pipeline - the effective pipeline.
 * @param stage - the stage that just passed.
 * @param outcome - its gate outcome (may carry `skip` instructions).
 * @param at - timestamp stamped on the skipped records.
 */
export function laneAfterPass(pipeline: Pipeline, stage: StageConfig, outcome: GateOutcome, at: number = Date.now()): StageLane {
    const successor = successorOf(pipeline, stage)
    const skip = new Map((outcome.skip ?? []).map((entry) => [entry.stageId, entry.reason]))
    const skipped: StageResult[] = []
    let cursor = successor
    while (cursor !== undefined && skip.has(cursor.id)) {
        skipped.push({
            stageId: cursor.id,
            attempt: 1,
            state: 'skipped',
            enteredAt: at,
            settledAt: at,
            summary: `跳过：${skip.get(cursor.id) ?? '上游门禁判定不值得执行'}`,
            next: successorOf(pipeline, cursor)?.id,
        })
        cursor = successorOf(pipeline, cursor)
    }
    if (skipped.length === 0) return { target: successor, skipped }
    return {
        target: cursor,
        skipped,
        note: `跳过 ${skipped.map((entry) => entry.stageId).join('、')}：${outcome.skip?.map((entry) => entry.reason).join('；') ?? ''}`,
    }
}

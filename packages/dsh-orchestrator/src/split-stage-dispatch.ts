/**
 * The ONE entry point the stage machine calls to start a stage's work.
 *
 * It exists so the split workflow can take over `implement` without editing the
 * dispatcher itself: `dispatchStage` is a large, well-tested function, and the
 * split decision belongs to the SPLIT feature, not to "how a stage child is
 * started". The order is deliberate —
 *
 *  1. `splitDispatch` decides whether THIS stage entry is the split workflow's
 *     (split enabled + `split-reviewed` gate + a reviewed plan worth splitting);
 *     it returns a result only when it is, and `undefined` for every other stage.
 *  2. Otherwise the ordinary single-child dispatch runs, unchanged.
 *
 * Both return the same `DispatchOutcome`, so the caller (`recordAndDispatch`)
 * and the report do not need to know which path produced them. Neither path
 * settles the stage: the gate still decides the transition.
 *
 * @module dsh-orchestrator/split-stage-dispatch
 */

import type { AgentLike, MissionRecord } from 'dsh-eng-core'
import { dispatchStage, type DispatchDeps, type DispatchOutcome } from './dispatch.js'
import type { StageConfig } from './pipeline.js'
import { splitDispatch } from './split-dispatch.js'

/** Everything one stage entry hands to its dispatcher (same shape as `dispatchStage`). */
export interface StageDispatchInput {
    stage: StageConfig
    mission: MissionRecord
    cwd: string
    agent?: AgentLike
    signal?: AbortSignal
    /** Stage attempt, used to name the transcript without collisions. */
    attempt?: number
    /** Extra context for the prompt (e.g. the spec path). */
    extra?: string
}

/**
 * Start the work of one stage entry: the split runner when it applies, else the
 * ordinary stage child.
 * @param deps - the dispatcher's deps (config, subagents, role-guard, presets).
 * @param input - the stage, the mission and the caller's context.
 * @returns what happened (never a settlement); never throws for a refusal.
 */
export async function dispatchStageEntry(deps: DispatchDeps, input: StageDispatchInput): Promise<DispatchOutcome> {
    const split = await splitDispatch(deps, input)
    if (split !== undefined) return split
    return dispatchStage(deps, input)
}

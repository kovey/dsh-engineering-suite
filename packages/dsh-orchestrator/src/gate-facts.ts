/**
 * The facts and the verdict of one gate evaluation.
 *
 * Their own module because THREE families of gate implementations read them
 * (`gates.ts` for the pipeline facts, `deploy-gates.ts` for deployment,
 * `split-gates.ts` for the split workflow). Sharing the types from one place is
 * what keeps the import graph a tree instead of a cycle: a helper importing a
 * type "back" from `gates.ts` would make every new gate a new cycle.
 *
 * @module dsh-orchestrator/gate-facts
 */

import type { GateState, MissionRecord, StageResult, MissionStore } from 'dsh-eng-core'

/** Facts a gate evaluation needs beyond the stage itself. */
export interface GateFacts {
    store: MissionStore
    mission: MissionRecord
    /** The persisted `entered` result of the stage being gated. */
    current: StageResult | undefined
    /**
     * The host's profile-level defaults for the project's `models.json`
     * (`config.split.models`), when declared. The split gates pass this to the
     * resolver so "project file > profile > built-in" is one rule, not two.
     */
    models?: unknown
}

/** Outcome of one deterministic gate check. */
export interface GateOutcome {
    /** `true` when the transition may happen. */
    ok: boolean
    /** The recorded three-state verdict when the gate produced one. */
    state?: GateState
    /** Chinese explanation for the report (present in both directions). */
    detail: string
    /** The concrete missing fact + the tool that fixes it, when blocked. */
    fix?: string
    /**
     * Stages a passing gate tells the pipeline to SKIP, with the reason.
     *
     * Only the split threshold uses it: a plan that is not worth splitting is a
     * legitimate pass whose next transition is "plain implement". The skip is
     * recorded as a `skipped` stage result, so the ledger says why a stage did
     * not run — never silently missing.
     */
    skip?: readonly { stageId: string; reason: string }[]
}

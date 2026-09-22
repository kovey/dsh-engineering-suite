/**
 * `spec_amend` — adding, rewording and removing requirements without losing the
 * standard process.
 *
 * The point of a separate tool (instead of asking the model to rewrite the whole
 * document) is that an edit keeps what a rewrite destroys:
 *
 *  - ids stay attached to their text, so test-case citations keep meaning what
 *    they meant;
 *  - removed ids are retired, so a stale citation can never resolve to a new
 *    requirement;
 *  - the change is recorded (who, when, before → after) and appended to the
 *    specification a human approves;
 *  - the approval is revoked, because the human approved a DIFFERENT document —
 *    which puts the mission back at the specification stage, exactly like the
 *    original creation did.
 *
 * @module dsh-spec-gate/amend
 */

import { planAmendment, type AmendRequest, type MissionStore, type SpecChange } from 'dsh-eng-core'
import { renderSpec } from './spec.js'

/** Everything the tool needs. */
export interface AmendDeps {
    store: MissionStore
    /** `mission.testDesign.cases` is what coverage analysis reads. */
    now?: number
}

/** Result of one amendment, in the shape the tool renders. */
export type AmendOutcome =
    | { ok: true; summary: string; change: SpecChange; revision: number; removedCases: string[]; file: string }
    | { ok: false; problem: string; nextSteps?: string; coveredBy?: string[] }

/**
 * Apply one requirement/criterion edit to a mission's specification.
 * @param deps - store and clock.
 * @param missionId - the mission whose specification is edited.
 * @param request - the edit.
 * @param by - who asked (agent/session id, or `approval`).
 */
export function amendMissionSpec(
    deps: AmendDeps,
    missionId: string,
    request: AmendRequest,
    by: string,
): AmendOutcome {
    const mission = deps.store.read(missionId)
    if (mission === undefined) {
        return { ok: false, problem: `mission ${missionId} 不存在。`, nextSteps: '先 spec_create 建立规格。' }
    }
    const spec = mission.spec
    if (spec === undefined) {
        return {
            ok: false,
            problem: `mission ${missionId} 还没有规格：没有可增删改的清单。`,
            nextSteps: '先调用 spec_create 建立规格（增删改是在已有规格上做的编辑）。',
        }
    }

    const plan = planAmendment(
        spec,
        request,
        {
            cases: mission.testDesign?.cases ?? [],
            by,
            ...(deps.now === undefined ? {} : { now: deps.now }),
        },
    )
    if (!plan.ok) return { ok: false, problem: plan.problem, ...(plan.nextSteps === undefined ? {} : { nextSteps: plan.nextSteps }), ...(plan.coveredBy === undefined ? {} : { coveredBy: plan.coveredBy }) }

    // Dropping the cases that cited a removed criterion is part of the same
    // decision, so it happens in the same write and lands in the history.
    const remaining =
        mission.testDesign === undefined || plan.removedCases.length === 0
            ? mission.testDesign
            : {
                  ...mission.testDesign,
                  cases: mission.testDesign.cases.filter((testCase) => !plan.removedCases.includes(testCase.id)),
              }
    const updated = deps.store.update(missionId, () => ({
        status: 'draft' as const,
        spec: plan.spec,
        ...(remaining === undefined ? {} : { testDesign: remaining }),
        // A design whose CASES changed must be reviewed again: the design gate
        // compares this digest against the specification, so clearing it is how
        // "re-review required" is enforced rather than merely suggested. When
        // only a requirement's wording changed the design is untouched and keeps
        // its verdict — the criteria it covers are the same ids.
        ...(remaining === undefined || plan.removedCases.length === 0
            ? {}
            : { testDesign: { ...remaining, reviewedAt: undefined, passed: undefined, specDigest: undefined } }),
    }))
    if (updated === undefined) return { ok: false, problem: `mission ${missionId} 在写入时消失。` }
    const file = deps.store.writeSpec(missionId, renderSpec(updated))

    return {
        ok: true,
        summary: plan.summary,
        change: plan.change,
        revision: plan.spec.revision,
        removedCases: plan.removedCases,
        file,
    }
}

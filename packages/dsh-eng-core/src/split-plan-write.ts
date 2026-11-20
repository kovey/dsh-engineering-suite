/**
 * Writing a split plan: `plan.json` AND the readable `plan.md`, in one step.
 *
 * The pair is written together on purpose. A plan that exists as JSON only is a
 * plan nobody can review: the reviewer sees a card rendered from `plan.json`,
 * not the file itself, and the one surface both reviews share (the read-only
 * preview) needs a document. So every write of `plan.json` also re-renders
 * `plan.md` (AC-001) — a plan edited through ANY path cannot leave a stale
 * description behind.
 *
 * The digest is over what is WRITTEN, not over the argument: the stored plan
 * gains its `missionId`, and a digest that ignores it would let a plan reviewed
 * under one mission be replayed under another.
 *
 * This module is separate from `split-plan.ts` so the renderer
 * (`split-plan-md.ts`) can read the review standing without an import cycle:
 * `split-review.ts` already imports the plan shape/paths.
 *
 * @module dsh-eng-core/split-plan-write
 */

import { writeJsonAtomic } from './io.js'
import type { Layout } from './paths.js'
import { writeSplitPlanMarkdown } from './split-plan-md.js'
import { splitPlanDigest, splitPlanFile, type SplitPlan } from './split-plan.js'
import { splitReviewStatus } from './split-review.js'
import type { SplitValidation } from './split-validate.js'

/** Optional facts the caller already has (the writable path runs the checks). */
export interface SaveSplitPlanOptions {
    /** Verdict of the three automatic checks, when the caller ran them. */
    validation?: SplitValidation
    /** Mission title, so the rendered document is readable. */
    title?: string
    /** Write time override (tests). */
    at?: number
}

/** What one write produced. */
export interface SavedSplitPlan {
    /** Absolute path of `plan.json`. */
    file: string
    /** Digest of the plan as written (what a review must quote). */
    digest: string
    /** Absolute path of the readable `plan.md` written next to it. */
    markdownFile: string
}

/**
 * Write one plan (JSON + Markdown) and return its digest.
 * @param layout - the workspace layout.
 * @param missionId - the mission the plan belongs to.
 * @param plan - the plan to persist (written as given, not normalised).
 * @param options - the checks' verdict and the mission title, when known.
 * @returns the absolute paths written and the digest a review must quote.
 */
export function saveSplitPlan(
    layout: Layout,
    missionId: string,
    plan: SplitPlan,
    options: SaveSplitPlanOptions = {},
): SavedSplitPlan {
    const file = splitPlanFile(layout, missionId)
    const stored: SplitPlan = { ...plan, missionId: plan.missionId ?? missionId }
    writeJsonAtomic(file, stored)
    const digest = splitPlanDigest(stored)
    const markdownFile = writeSplitPlanMarkdown(layout, missionId, {
        plan: stored,
        digest,
        missionId,
        // The standing is read AFTER the JSON write: a re-plan makes the previous
        // review stale, and the document must say so rather than repeat an
        // approval that no longer describes this plan.
        review: splitReviewStatus(layout, missionId),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.validation === undefined ? {} : { validation: options.validation }),
        ...(options.at === undefined ? {} : { at: options.at }),
    })
    return { file, digest, markdownFile }
}

/**
 * The split workflow's public surface (`dsh-eng-core/split`).
 *
 * Kept as a SUBPATH rather than added to the package root because the root
 * barrel is on the structural ratchet: every `export *` line there is counted,
 * and the split workflow is a self-contained feature — a plugin that does not
 * split work should not have to load its types either.
 *
 * @module dsh-eng-core/split
 */

export * from './models.js'
export * from './split-plan.js'
export * from './split-plan-md.js'
export * from './split-plan-write.js'
export * from './split-validate.js'
export * from './split-overlap.js'
export * from './split-threshold.js'
export * from './split-review.js'
export * from './evidence-rows.js'
export * from './evidence-pending.js'
export * from './evidence-import.js'
export * from './worktree.js'
export * from './worktree-check.js'
export * from './worktree-doctor.js'
export * from './rework.js'

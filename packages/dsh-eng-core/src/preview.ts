/**
 * `dsh-eng-core/preview` — the ONE read-only preview two gates share.
 *
 * `spec_approve` (spec-gate) and `split-review` (orchestrator) both hand a person
 * a document to read before deciding. They import the same surface from here:
 * the same fallback order, the same `q`-to-close viewer, the same wording in the
 * notice. A second implementation would be a second behaviour.
 *
 * Kept as a SUBPATH (not added to the package root barrel) for the same reason
 * as `dsh-eng-core/split`: a plugin that never previews should not load it.
 *
 * @module dsh-eng-core/preview
 */

export { openPath, readPreviewLines, type NvimTuiPreviewApi, type PreviewPlacement } from './preview-open.js'
export {
    describePreview,
    previewArtifact,
    releasePreview,
    waitForPreview,
    type PreviewOptions,
} from './preview-surface.js'

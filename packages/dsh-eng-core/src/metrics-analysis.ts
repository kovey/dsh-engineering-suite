/**
 * The shape every per-language analyser returns.
 *
 * `metrics.ts` owns the dispatch, the imports and the violations; each language
 * family owns only how to read its own declarations. Sharing this interface is
 * what lets the dispatcher treat "how long is this function" as one question
 * regardless of whether the language closes a body with `}`, `end` or an
 * indentation change.
 *
 * `skipped` is not a statistic: a function whose body cannot be paired has no
 * honest length, and counting it is the only alternative to inventing one.
 *
 * @module dsh-eng-core/metrics-analysis
 */

import type { MeasuredFunction } from './metrics-text.js'
import type { IfBlockMetric } from './metrics-branch.js'

/** Everything one language analyser measured about one file (imports excluded). */
export interface LanguageAnalysis {
    functions: MeasuredFunction[]
    /** Functions whose body could not be paired, so no honest length exists. */
    skipped: number
    ifBlocks: IfBlockMetric[]
    exports: number
    maxDepth: number
    /** 1-based line where `maxDepth` is first reached. */
    maxDepthLine: number
}

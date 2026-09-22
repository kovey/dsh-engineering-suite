/**
 * The baseline ratchet.
 *
 * Declaring thresholds for a repository that already violates all of them is
 * useless — it either blocks every mission or gets switched off. The baseline
 * records the violations that exist TODAY, so the gate only fails on NEW ones an
 * agent/developer actually introduced; refactoring shrinks the baseline.
 *
 * Two rules make it a ratchet rather than an escape hatch:
 *
 *  1. **The baseline lives in the repository** (`<repo>/.dsh/standards-baseline.json`),
 *     inside the trust root `dsh-spec-gate` protects, so a model cannot widen it
 *     with `write`/`edit`;
 *  2. **widening requires the human approval seam** (`requireApprovalForBaseline`,
 *     default on): "accept the 12 new violations" is a decision, and a decision
 *     needs a person — the same rule the rest of this suite follows.
 *
 * @module dsh-standards-gate/baseline
 */

import {
    compareToBaseline,
    ensureDir,
    parseBaseline,
    readText,
    writeTextAtomic,
    writeJsonAtomic,
    type BaselineFile,
    type Logger,
    type Violation,
} from 'dsh-eng-core'

/** The comparison a `standards_check` run reports. */
export interface BaselineComparison {
    /** Violations this change introduced: what the gate fails on. */
    added: Violation[]
    /** Violations the baseline already accepted, at or below the accepted size. */
    known: Violation[]
    /** Accepted keys that no longer exist: the repository improved. */
    fixed: string[]
    /**
     * Accepted keys whose violation got BIGGER than what was accepted.
     *
     * A ratchet that ignores magnitude is not a ratchet — a 420-line file
     * accepted today must not silently pass at 900 lines tomorrow.
     */
    worsened: Violation[]
    /** Whether a baseline file was found at all. */
    present: boolean
}

/**
 * Read the baseline.
 *
 * A malformed baseline is treated as ABSENT with a reported problem rather than
 * as "everything is accepted": failing open here would silently legalise every
 * violation in the repository.
 * @param file - absolute path of the baseline file.
 * @param logger - optional diagnostic sink.
 * @returns the parsed baseline, or `undefined` with the reason logged.
 */
export function readBaseline(file: string, logger?: Logger): BaselineFile | undefined {
    const text = readText(file)
    if (text === undefined) return undefined
    const parsed = parseBaselineText(text)
    if (parsed === undefined) {
        logger?.warn(`${file} 不是合法的基线文件：按"没有基线"处理（会报告全部违规），请修好它或用 standards_check({ accept: true }) 重新冻结。`)
        return undefined
    }
    return parsed
}

/**
 * Parse baseline JSON.
 *
 * Delegates to core: a second implementation here silently dropped the recorded
 * magnitudes, which disabled the "a violation that got bigger fails" rule while
 * the tests still passed. One parser, one behaviour.
 * @param text - raw file content.
 * @returns the baseline, or `undefined` when it is not usable.
 */
export function parseBaselineText(text: string): BaselineFile | undefined {
    return parseBaseline(text)
}

/**
 * Compare today's violations with the baseline.
 * @param violations - the measurement result.
 * @param baseline - the accepted violations, when a baseline exists.
 * @returns the three buckets the caller reports.
 */
export function compareViolations(
    violations: readonly Violation[],
    baseline: BaselineFile | undefined,
): BaselineComparison {
    const compared = compareToBaseline(violations, baseline)
    return { ...compared, present: baseline !== undefined }
}

/**
 * Write a new baseline that accepts every violation in `violations`.
 *
 * Only ever called after the approval gate in `tools.ts`: this is the ONE write
 * in the plugin that loosens a check, so it must stay the only path that does.
 * @param input - where to write, what to accept, and who decided.
 */
export function freezeBaseline(input: {
    file: string
    violations: readonly Violation[]
    /** Free-text provenance: which decision accepted these. */
    note: string
    now?: number
}): BaselineFile {
    const baseline: BaselineFile = {
        version: 1,
        frozenAt: new Date(input.now ?? Date.now()).toISOString(),
        note: input.note,
        accepted: [...new Set(input.violations.map((violation) => violation.key))].sort(),
        // Magnitudes are what make tomorrow's bigger violation fail.
        entries: input.violations
            .map((violation) => ({ key: violation.key, actual: violation.actual, limit: violation.limit }))
            .sort((left, right) => left.key.localeCompare(right.key)),
    }
    ensureDir(input.file.replace(/\/[^/]*$/, ''))
    writeTextAtomic(input.file, `${JSON.stringify(baseline, null, 2)}\n`)
    return baseline
}

/**
 * Drop accepted keys whose violation no longer exists.
 *
 * Tightening only — it can never accept anything new — so it needs no approval,
 * and it closes the loophole where a violation is deleted (making the gate
 * green) and restored later (passing on the old acceptance).
 * @param file - the baseline file to rewrite.
 * @param fixed - keys to drop.
 * @param previous - the baseline that was read.
 * @returns the pruned baseline, or `undefined` when nothing had to change.
 */
export function pruneBaseline(
    file: string,
    fixed: readonly string[],
    previous: BaselineFile | undefined,
): BaselineFile | undefined {
    if (previous === undefined || fixed.length === 0) return undefined
    const dropped = new Set(fixed)
    const accepted = previous.accepted.filter((key) => !dropped.has(key))
    if (accepted.length === previous.accepted.length) return undefined
    const pruned: BaselineFile = {
        version: 1,
        frozenAt: previous.frozenAt,
        ...(previous.note === undefined ? {} : { note: previous.note }),
        accepted,
        ...(previous.entries === undefined ? {} : { entries: previous.entries.filter((entry) => !dropped.has(entry.key)) }),
    }
    writeTextAtomic(file, `${JSON.stringify(pruned, null, 2)}\n`)
    return pruned
}

/** Count violations per rule, for the report. */
export function countByRule(violations: readonly Violation[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const violation of violations) counts[violation.rule] = (counts[violation.rule] ?? 0) + 1
    return counts
}

/** Write the machine-readable measurement next to the mission's other artifacts. */
export function writeMeasurement(file: string, payload: unknown): void {
    ensureDir(file.replace(/\/[^/]*$/, ''))
    writeJsonAtomic(file, payload)
}

/**
 * Per-mission trends: what actually changed between two measurements.
 *
 * A metric that never moves is a number nobody uses. The gate already writes one
 * measurement artifact per run; comparing the first and the last one of a
 * mission answers the question people actually ask — "did this change make the
 * codebase worse, and where?" — without a database or a time series.
 *
 * @module dsh-standards-gate/trends
 */

import fs from 'node:fs'
import path from 'node:path'
import { readJson } from 'dsh-eng-core'

/** One stored measurement (the shape `standards_check` writes). */
export interface StoredMeasurement {
    /** Absolute path of the artifact. */
    file: string
    at?: number
    sizes: Record<string, number>
    violations: string[]
}

/** The delta a human cares about. */
export interface TrendDelta {
    path: string
    from: number
    to: number
    /** `to - from`. */
    lines: number
}

export interface Trends {
    /** How many measurements were compared. */
    samples: number
    /** Files that grew the most (worst first). */
    grew: TrendDelta[]
    /** Files that shrank the most (best first). */
    shrank: TrendDelta[]
    /** Violation keys present now and not before. */
    addedViolations: string[]
    /** Violation keys gone (refactoring progress). */
    fixedViolations: string[]
}

/** Read every measurement artifact a mission directory holds, oldest first. */
export function readMeasurements(dir: string): StoredMeasurement[] {
    const entries: StoredMeasurement[] = []
    let names: string[]
    try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
        return []
    }
    for (const name of names.sort()) {
        const file = path.join(dir, name)
        const raw = readJson<{ sizes?: unknown; violations?: unknown; checkedAt?: unknown }>(file)
        if (raw === undefined) continue
        const sizes: Record<string, number> = {}
        if (typeof raw.sizes === 'object' && raw.sizes !== null) {
            for (const [key, value] of Object.entries(raw.sizes as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) sizes[key] = value
            }
        }
        entries.push({
            file,
            ...(typeof raw.checkedAt === 'number' ? { at: raw.checkedAt } : {}),
            sizes,
            violations: Array.isArray(raw.violations)
                ? (raw.violations as unknown[])
                      .map((entry) =>
                          typeof entry === 'string'
                              ? entry
                              : typeof (entry as { key?: unknown })?.key === 'string'
                                ? ((entry as { key: string }).key)
                                : '',
                      )
                      .filter((key) => key !== '')
                : [],
        })
    }
    return entries
}

/**
 * Compare two measurements.
 *
 * Files present in only one side are reported with `0` on the missing side, which
 * is what "this mission created a 600-line file" looks like.
 * @param first - the earliest measurement of the mission.
 * @param last - the most recent one.
 * @param limit - how many files to report per direction.
 */
export function diffMeasurements(first: StoredMeasurement, last: StoredMeasurement, limit: number): Trends {
    const paths = new Set([...Object.keys(first.sizes), ...Object.keys(last.sizes)])
    const deltas: TrendDelta[] = []
    for (const file of paths) {
        const from = first.sizes[file] ?? 0
        const to = last.sizes[file] ?? 0
        if (from === to) continue
        deltas.push({ path: file, from, to, lines: to - from })
    }
    const before = new Set(first.violations)
    const after = new Set(last.violations)
    return {
        samples: 2,
        grew: deltas.filter((delta) => delta.lines > 0).sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, limit),
        shrank: deltas.filter((delta) => delta.lines < 0).sort((a, b) => a.lines - b.lines || a.path.localeCompare(b.path)).slice(0, limit),
        addedViolations: [...after].filter((key) => !before.has(key)).sort(),
        fixedViolations: [...before].filter((key) => !after.has(key)).sort(),
    }
}

/**
 * The mission's trend, or `undefined` when there is nothing to compare.
 * @param dir - the mission's `standards/` directory.
 * @param limit - files reported per direction.
 */
export function trendsOf(dir: string, limit: number): Trends | undefined {
    const measurements = readMeasurements(dir)
    if (measurements.length < 2) return undefined
    const first = measurements[0]
    const last = measurements[measurements.length - 1]
    if (first === undefined || last === undefined || first.file === last.file) return undefined
    return diffMeasurements(first, last, limit)
}

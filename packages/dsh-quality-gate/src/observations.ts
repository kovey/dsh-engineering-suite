/**
 * Rendering of the shadow (`observe`) section shared by the gate and budget
 * reports.
 *
 * The section exists because a shadow run's top-line verdict must stay honest:
 * a `PASS` with a would-`BLOCK` observation is not a pass that hid anything —
 * the shadow is printed right below it, with what it would have decided and
 * why, and a next step for switching it on. A run with no observation prints no
 * section at all, so the report of an enforcing-only gate is unchanged.
 *
 * @module dsh-quality-gate/observations
 */

import type { GateObservation, GateState } from 'dsh-eng-core'

/**
 * Render the dedicated shadow section.
 *
 * One line per recorded rule (already ordered by rule id by
 * `applyRuleModes`), plus the switch-on next step when at least one would block.
 * @param observations - the recorded shadow verdicts.
 * @param state - the gate's own (enforcing) verdict, for the honesty line.
 * @returns the section lines; empty when there is nothing observing.
 */
export function renderObservations(observations: readonly GateObservation[], state: GateState): string[] {
    if (observations.length === 0) return []
    const blocking = observations.filter((observation) => observation.would === 'BLOCK')
    const lines: string[] = [
        `影子（observe）：本会拦下 ${blocking.length} 条（${observations.length} 条 observe 规则只记录，不计入本次 ${state} 裁决）`,
    ]
    for (const observation of observations) {
        lines.push(`  - ${observation.rule}：would=${observation.would} — ${observation.reason}`)
    }
    if (blocking.length > 0) {
        lines.push(
            `  下一步：把 mode: 'observe' 改成 'enforce'（或删掉 mode 键）后，上述 ${blocking.length} 条会真的阻断门禁；` +
                '切换前先确认这些影子结果都是误报或已经修复——影子只测量，不拦截。',
        )
    }
    return lines
}

/**
 * Shadow (`observe`) rules for the standards gate.
 *
 * A standards rule used to have exactly one behaviour: a violation NEW since the
 * baseline blocks the mission. That cannot answer the question an operator
 * actually asks before switching a rule on — "if this rule were enforcing, what
 * would it fail on today?" — so a rule may be declared `observe` in the
 * repository's own standards file:
 *
 * ```json
 * "rules": { "maxDepth": "observe", "cycle": "enforce" }
 * ```
 *
 * The rule is still measured exactly once; its would-be verdict is recorded as a
 * gate observation and printed in a dedicated shadow section, but it contributes
 * nothing to the gate's own verdict (`applyRuleModes` in `dsh-eng-core` is the
 * one place that folds modes into a veto, so this gate cannot disagree with the
 * quality gate about what `observe` means).
 *
 * THE RATCHET SIDE — the part this package has and the others do not:
 * the baseline under `.dsh/` only ever tightens, so a shadow measurement must
 * never become an INPUT to it. Observing today would otherwise change tomorrow's
 * verdict, which is the opposite of "measure first":
 *
 *  - {@link enforcingViolations} / {@link enforcingKeys} are the ONLY source of a
 *    baseline write. A rule in `observe` contributes nothing to `accept` (it is
 *    not grandfathered) and nothing to the pruning of fixed keys (its acceptance
 *    is not dropped). Both directions are gated on `enforce`;
 *  - the measurement itself is NOT thrown away: it rides in the gate record
 *    (`observations`), in the run's measurement artifact and in the report, so
 *    the operator sees exactly which files would fail. Those are read-only
 *    artifacts — the gate never reads a previous run's measurement back, so
 *    preserving it cannot move the ratchet.
 *
 * @module dsh-standards-gate/rule-modes
 */

import {
    parseRuleMode,
    type GateObservation,
    type GateState,
    type RuleMode,
    type RuleModeRule,
    type RuleSet,
    type RuleVerdict,
    type StandardsConfig,
    type Violation,
} from 'dsh-eng-core'
import type { BaselineComparison } from './baseline.js'

/**
 * Every rule id the measurement can produce.
 *
 * Kept here (not in core) because it is the gate's rule vocabulary: a mode may
 * only name one of these, and a name outside it is a reported configuration
 * problem instead of a silent typo that measures nothing.
 */
export const STANDARDS_RULE_IDS: readonly string[] = [
    'cycle',
    'layer',
    'maxDepth',
    'maxExports',
    'maxFileLines',
    'maxFunctionLines',
    'maxIfBlockLines',
    'maxParams',
]

/** Threshold keys of one language's rule set, in report order. */
const RULE_SET_KEYS: readonly (keyof RuleSet)[] = [
    'maxFileLines',
    'maxFunctionLines',
    'maxDepth',
    'maxIfBlockLines',
    'maxParams',
    'maxExports',
]

/** The `rules` declaration read from the repository's standards file. */
export interface RuleModeDeclaration {
    /** Rule id → declared mode. An absent id is `enforce` (the default). */
    modes: ReadonlyMap<string, RuleMode>
    /** Recoverable configuration problems (unknown rule id, unusable mode). */
    problems: string[]
}

/** No declaration at all: every rule enforces (the pre-shadow behaviour). */
export function noRuleModes(): RuleModeDeclaration {
    return { modes: new Map(), problems: [] }
}

/**
 * Read the `rules` map of a standards file.
 *
 * Untrusted input, three outcomes: an absent key is "no shadow rule" (the old
 * behaviour, byte for byte); a usable `observe`/`enforce` is stored; anything
 * else — a non-object, an unknown rule id, a misspelled mode — is a reported
 * problem and the rule stays `enforce`. A typo must never be read as `observe`,
 * because that silently downgrades a gate rule into a measurement.
 * @param value - the raw `rules` value from the standards file.
 * @param where - the file, for the messages (`<repo>/.dsh/standards.json`).
 * @returns the parsed declaration plus every problem found.
 */
export function parseRuleModes(value: unknown, where: string): RuleModeDeclaration {
    const modes = new Map<string, RuleMode>()
    const problems: string[] = []
    if (value === undefined) return { modes, problems }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(
            `${where} 的 rules 必须是对象（形如 { "maxDepth": "observe" }，收到 ${JSON.stringify(value)}），已忽略：没有规则被标记为 observe`,
        )
        return { modes, problems }
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    )
    for (const [id, raw] of entries) {
        if (!STANDARDS_RULE_IDS.includes(id)) {
            problems.push(
                `${where} 的 rules 里的 "${id}" 不是已知规则（可用：${STANDARDS_RULE_IDS.join(' / ')}），已忽略：` +
                    '拼错的规则名不会测量任何东西，安静地接受它等于让一条影子规则从未存在过',
            )
            continue
        }
        const parsed = parseRuleMode(raw, `规则 "${id}"`)
        if (parsed.problem !== undefined) problems.push(`${where}: ${parsed.problem}`)
        modes.set(id, parsed.mode)
    }
    return { modes, problems }
}

/**
 * The rule ids the standards file actually DECLARES (thresholds, `layers`,
 * `forbidCycles`) — a mode does not declare a rule, it only marks one.
 * @param standards - the repository's standards.
 * @returns the rule ids, sorted.
 */
export function declaredRuleIds(standards: StandardsConfig): string[] {
    const ids = new Set<string>()
    for (const ruleset of Object.values(standards.languages)) {
        for (const key of RULE_SET_KEYS) {
            if (typeof ruleset[key] === 'number') ids.add(key)
        }
    }
    if (standards.layers !== undefined && standards.layers.length > 0) ids.add('layer')
    if (standards.forbidCycles === true) ids.add('cycle')
    return [...ids].sort()
}

/**
 * The rule ids a run must produce exactly one verdict for.
 *
 * Every rule that is DECLARED somewhere in the standards file — a threshold in
 * any language's rule set, `layer` when dependency-direction rules exist,
 * `cycle` when cycles are forbidden — plus every rule a mode names, so a rule
 * marked `observe` is still evaluated (and therefore reported) instead of
 * silently vanishing.
 * @param standards - the repository's standards.
 * @param declaration - the parsed `rules` map.
 * @returns the rule ids, sorted (a stable evaluation order).
 */
export function configuredRuleIds(standards: StandardsConfig, declaration: RuleModeDeclaration): string[] {
    return [...new Set([...declaredRuleIds(standards), ...declaration.modes.keys()])].sort()
}

/** The declared modes as `applyRuleModes` input. */
export function ruleModeRules(ids: readonly string[], declaration: RuleModeDeclaration): RuleModeRule[] {
    return ids.map((id) => {
        const mode = declaration.modes.get(id)
        return mode === undefined ? { id } : { id, mode }
    })
}

/** Whether a rule is a shadow one (recorded, never a veto). */
export function isObserve(declaration: RuleModeDeclaration, rule: string): boolean {
    return declaration.modes.get(rule) === 'observe'
}

/** The worst measurement of one rule, picked deterministically (largest actual, then key). */
function worstOf(violations: readonly Violation[]): Violation | undefined {
    return [...violations].sort((left, right) => right.actual - left.actual || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))[0]
}

/**
 * One verdict per rule, in rule-id order.
 *
 * A rule BLOCKs when it contributes at least one added or worsened violation, and
 * PASSes otherwise; the reason carries the counts AND the largest measurement, so
 * a shadow observation says what was measured, not only that something was.
 * @param comparison - the buckets `compareToBaseline` produced.
 * @param configured - rule ids to evaluate (see {@link configuredRuleIds}).
 * @returns one verdict per rule, ordered by id (determinism).
 */
export function ruleVerdicts(comparison: BaselineComparison, configured: readonly string[]): RuleVerdict[] {
    const ids = new Set<string>(configured)
    for (const violation of [...comparison.added, ...comparison.known, ...comparison.worsened]) ids.add(violation.rule)
    const byRule = (violations: readonly Violation[], rule: string): Violation[] =>
        violations.filter((violation) => violation.rule === rule)
    return [...ids].sort().map((rule) => {
        const added = byRule(comparison.added, rule)
        const worsened = byRule(comparison.worsened, rule)
        const known = byRule(comparison.known, rule)
        const failing = [...added, ...worsened]
        if (failing.length === 0) {
            return {
                rule,
                state: 'PASS' as GateState,
                reason: `无新增违规（基线已接受 ${known.length} 项）`,
            }
        }
        const worst = worstOf(failing)
        return {
            rule,
            state: 'BLOCK' as GateState,
            reason:
                `新增 ${added.length} 项、恶化 ${worsened.length} 项（基线已接受 ${known.length} 项；` +
                `实测 ${worst?.actual ?? 0} / 上限 ${worst?.limit ?? 0}）`,
        }
    })
}

/**
 * The violations a baseline write may see: enforcing rules only.
 *
 * `standards_check({ accept: true })` is the one write that LOOSENS the ratchet,
 * so it must not grandfather a shadow rule's violations — switching that rule to
 * `enforce` later has to show what it catches, not find it already accepted.
 * @param violations - every violation of the run.
 * @param declaration - the parsed `rules` map.
 * @returns the violations whose rule is enforcing.
 */
export function enforcingViolations(violations: readonly Violation[], declaration: RuleModeDeclaration): Violation[] {
    return violations.filter((violation) => !isObserve(declaration, violation.rule))
}

/**
 * The accepted keys the pruning pass may drop: enforcing rules only.
 *
 * Pruning is a tightening write, and a shadow measurement must not tighten
 * either — otherwise an observe run that happened to see a fixed file would make
 * tomorrow's revert fail. The key is `rule|path|label`, so the rule is its first
 * segment.
 * @param keys - keys of violations that no longer exist.
 * @param declaration - the parsed `rules` map.
 * @returns the keys whose rule is enforcing.
 */
export function enforcingKeys(keys: readonly string[], declaration: RuleModeDeclaration): string[] {
    return keys.filter((key) => !isObserve(declaration, key.split('|')[0] ?? ''))
}

/**
 * Render the dedicated shadow section.
 *
 * Same wording pattern as the quality gate's: the top-line verdict stays honest
 * (an enforcing PASS with a would-be BLOCK prints the shadow right below it),
 * one line per rule in rule-id order, and — when something would block — the
 * exact next step that switches it on.
 * @param observations - the recorded shadow verdicts.
 * @param state - the gate's own (enforcing) verdict, for the honesty line.
 * @param standardsFile - the repository file that carries the `rules` map.
 * @returns the section lines; empty when no rule observes.
 */
export function renderObservations(
    observations: readonly GateObservation[],
    state: GateState,
    standardsFile: string,
): string[] {
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
            `  下一步：把 ${standardsFile} 的 rules 里 ${blocking.map((observation) => `"${observation.rule}"`).join('、')} 从 'observe' 改成 'enforce'（或删掉该条）后，` +
                '上述违规会真的阻断门禁；切换前先确认这些影子结果都是误报或已经修复——影子只测量，不拦截。',
        )
    }
    return lines
}

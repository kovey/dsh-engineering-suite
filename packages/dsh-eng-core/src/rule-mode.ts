/**
 * Rule modes: measuring a gate rule before enforcing it (`observe`).
 *
 * A gate rule used to have exactly one behaviour — it either passed or blocked.
 * That cannot answer "if I turned this rule on, what would it block?", so a rule
 * may now carry `mode: 'observe'`: the rule is still evaluated EXACTLY ONCE and
 * its result is recorded as "would PASS/WARN/BLOCK", but it contributes nothing
 * to the gate's own verdict. Switching it to `enforce` (the default) makes the
 * recorded "would" real.
 *
 * This module is the ONE place that turns rule modes into an effective veto, so
 * every consumer (the quality gate's commands and budgets today) downgrades
 * identically instead of reimplementing the rule:
 *
 *  1. an absent `mode` means `enforce` (existing gates keep their behaviour
 *     byte for byte — no record grows an empty `observations` list);
 *  2. an UNKNOWN `mode` is a configuration problem: it is reported with the
 *     accepted values and the rule stays `enforce`. A typo must never be read as
 *     `observe`, which would silently turn a veto into a measurement;
 *  3. the effective state is folded from ENFORCING verdicts only; an `observe`
 *     verdict appears once in `observations`, ordered by rule id (determinism);
 *  4. a verdict with no matching rule (a synthetic check such as the change
 *     budget) is enforcing: only a rule the host marked can be a shadow.
 *
 * @module dsh-eng-core/rule-mode
 */

import type { GateObservation, GateState, RuleMode } from './types.js'

/** The accepted modes, in the order reports list them. */
export const RULE_MODES: readonly RuleMode[] = ['observe', 'enforce']

/** One rule's configured mode, as read from untrusted configuration. */
export interface RuleModeRule {
    /** Stable rule id (`commands[].id`, `budgets[].id`). */
    id: string
    /**
     * The configured value, kept UNTRUSTED on purpose: `undefined` means
     * `enforce`, `observe`/`enforce` mean themselves, and anything else is a
     * reported configuration problem (the rule stays `enforce`).
     */
    mode?: unknown
}

/** One rule's own verdict, before modes are applied. */
export interface RuleVerdict {
    /** Rule id the verdict belongs to. */
    rule: string
    /** The verdict this rule WOULD contribute if it were enforcing. */
    state: GateState
    /** One-line, machine-stable reason. */
    reason: string
}

/** The gate's own verdict: enforcing rules only. */
export interface EffectiveRuleVerdict {
    /** Fold of the enforcing rules (`PASS` < `WARN` < `BLOCK`). */
    state: GateState
    /** The enforcing verdicts that produced it, in evaluation order. */
    rules: RuleVerdict[]
}

/** What {@link applyRuleModes} decided. */
export interface RuleModeOutcome {
    /** The verdict the gate may act on — never influenced by an observe rule. */
    effective: EffectiveRuleVerdict
    /** Shadow verdicts, ordered by rule id. Empty when no rule observes. */
    observations: GateObservation[]
    /** Recoverable configuration problems (unknown `mode`, duplicate verdicts, …). */
    problems: string[]
}

/** Severity order used to fold several rule verdicts into one gate state. */
const RANK: Readonly<Record<GateState, number>> = { PASS: 0, WARN: 1, BLOCK: 2 }

/**
 * Read one configured `mode`.
 *
 * `undefined` is the default `enforce` (not a problem). Every other unrecognised
 * value is a problem AND `enforce`: the accepted values are named in the
 * message, and the "never silently observe" promise is stated explicitly.
 * @param value - the untrusted config value.
 * @param where - the rule, for the message (`规则 "test"`).
 * @returns the mode to apply, plus the problem when the value was unusable.
 */
export function parseRuleMode(value: unknown, where: string): { mode: RuleMode; problem?: string } {
    if (value === undefined) return { mode: 'enforce' }
    if (value === 'observe' || value === 'enforce') return { mode: value }
    return {
        mode: 'enforce',
        problem:
            `${where} 的 mode 必须是 ${RULE_MODES.join(' / ')} 之一（收到 ${JSON.stringify(value)}），` +
            '已按 enforce 处理：未知值绝不会被静默当作 observe（那会把一条门禁规则悄悄降级成测量）',
    }
}

/** Locale-independent id order (byte order, so two machines agree). */
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Apply rule modes to one run's verdicts.
 *
 * The caller evaluates EVERY selected rule exactly once (matched or not) and
 * hands the verdicts here; this function never evaluates anything, so "still
 * evaluated exactly once" cannot be broken by the downgrade itself.
 * @param rules - the evaluated rules and their configured modes.
 * @param verdicts - one verdict per evaluated rule, in evaluation order.
 * @returns the effective verdict, the shadow observations and any problems.
 */
export function applyRuleModes(
    rules: readonly RuleModeRule[],
    verdicts: readonly RuleVerdict[],
): RuleModeOutcome {
    const problems: string[] = []
    const modes = new Map<string, RuleMode>()
    for (const rule of rules) {
        if (modes.has(rule.id)) {
            problems.push(`规则 "${rule.id}" 重复出现：沿用第一次的 mode（同一条规则应当只配置一次）`)
            continue
        }
        const parsed = parseRuleMode(rule.mode, `规则 "${rule.id}"`)
        if (parsed.problem !== undefined) problems.push(parsed.problem)
        modes.set(rule.id, parsed.mode)
    }

    const enforcing: RuleVerdict[] = []
    const observations: GateObservation[] = []
    const seen = new Set<string>()
    for (const verdict of verdicts) {
        if (seen.has(verdict.rule)) {
            // A rule evaluated twice would appear twice in the record, and the
            // "every enabled rule appears exactly once" property would be a lie.
            problems.push(`规则 "${verdict.rule}" 出现了多次裁决：每条规则只评估一次，后续裁决已忽略`)
            continue
        }
        seen.add(verdict.rule)
        // A verdict with no configured rule is a synthetic check (the change
        // budget): it can only enforce, because nobody could have marked it.
        const mode = modes.get(verdict.rule) ?? 'enforce'
        if (mode === 'observe') {
            observations.push({
                rule: verdict.rule,
                mode: 'observe',
                would: verdict.state,
                reason: verdict.reason,
            })
            continue
        }
        enforcing.push({ rule: verdict.rule, state: verdict.state, reason: verdict.reason })
    }
    for (const rule of rules) {
        if (!seen.has(rule.id)) {
            // Do not fabricate an observation: "was not evaluated" and "would
            // pass" are different facts, and a shadow record must never invent one.
            problems.push(
                `规则 "${rule.id}" 没有裁决（未被评估）：observe 规则也必须评估一次，否则它的影子记录是空的`,
            )
        }
    }

    observations.sort((left, right) => compareIds(left.rule, right.rule))
    let state: GateState = 'PASS'
    for (const verdict of enforcing) {
        if (RANK[verdict.state] > RANK[state]) state = verdict.state
    }
    return { effective: { state, rules: enforcing }, observations, problems }
}

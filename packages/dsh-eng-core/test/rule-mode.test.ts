/**
 * Rule modes: `observe` measures a gate rule without enforcing it.
 *
 * These are the pure-function tests for the ONE place that decides which rule
 * verdicts count. The plugin-level behaviour (record shape, report text) is
 * tested in `dsh-quality-gate/test/observe.test.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRuleModes, parseRuleMode } from '../dist/index.js'

test('an absent mode enforces: the old behaviour is the default', () => {
    const outcome = applyRuleModes(
        [{ id: 'test' }, { id: 'lint', mode: 'enforce' }],
        [
            { rule: 'test', state: 'PASS', reason: '通过' },
            { rule: 'lint', state: 'BLOCK', reason: '失败' },
        ],
    )
    assert.equal(outcome.effective.state, 'BLOCK')
    assert.deepEqual(
        outcome.effective.rules.map((verdict) => verdict.rule),
        ['test', 'lint'],
    )
    assert.deepEqual(outcome.observations, [])
    assert.deepEqual(outcome.problems, [])
})

test('an observe verdict is recorded exactly once and never reaches the effective state', () => {
    const outcome = applyRuleModes(
        [{ id: 'shadow', mode: 'observe' }, { id: 'test' }],
        [
            { rule: 'shadow', state: 'BLOCK', reason: '必需命令失败（exit=2）' },
            { rule: 'test', state: 'PASS', reason: '通过（exit=0）' },
        ],
    )
    assert.equal(outcome.effective.state, 'PASS')
    assert.deepEqual(
        outcome.effective.rules.map((verdict) => verdict.rule),
        ['test'],
    )
    assert.deepEqual(outcome.observations, [
        { rule: 'shadow', mode: 'observe', would: 'BLOCK', reason: '必需命令失败（exit=2）' },
    ])
    assert.deepEqual(outcome.problems, [])
})

test('a rule that would pass in observe is still recorded (matched or not)', () => {
    const outcome = applyRuleModes(
        [{ id: 'a', mode: 'observe' }, { id: 'b', mode: 'observe' }],
        [
            { rule: 'a', state: 'PASS', reason: '通过（exit=0）' },
            { rule: 'b', state: 'WARN', reason: '非必需命令失败（exit=1）' },
        ],
    )
    assert.equal(outcome.effective.state, 'PASS')
    assert.deepEqual(
        outcome.observations.map((observation) => [observation.rule, observation.would]),
        [
            ['a', 'PASS'],
            ['b', 'WARN'],
        ],
    )
})

test('observations are ordered by rule id, independent of evaluation order', () => {
    const outcome = applyRuleModes(
        [{ id: 'zeta', mode: 'observe' }, { id: 'alpha', mode: 'observe' }, { id: 'middle', mode: 'observe' }],
        [
            { rule: 'zeta', state: 'BLOCK', reason: 'z' },
            { rule: 'alpha', state: 'PASS', reason: 'a' },
            { rule: 'middle', state: 'WARN', reason: 'm' },
        ],
    )
    assert.deepEqual(
        outcome.observations.map((observation) => observation.rule),
        ['alpha', 'middle', 'zeta'],
    )
    // Determinism: the same input yields the same JSON, byte for byte.
    const again = applyRuleModes(
        [{ id: 'zeta', mode: 'observe' }, { id: 'alpha', mode: 'observe' }, { id: 'middle', mode: 'observe' }],
        [
            { rule: 'zeta', state: 'BLOCK', reason: 'z' },
            { rule: 'alpha', state: 'PASS', reason: 'a' },
            { rule: 'middle', state: 'WARN', reason: 'm' },
        ],
    )
    assert.equal(JSON.stringify(outcome.observations), JSON.stringify(again.observations))
})

test('an unknown mode is a problem AND stays enforce (never silently observe)', () => {
    const parsed = parseRuleMode('shadow', '规则 "test"')
    assert.equal(parsed.mode, 'enforce')
    assert.match(parsed.problem ?? '', /mode 必须是 observe \/ enforce 之一/)
    assert.match(parsed.problem ?? '', /已按 enforce 处理/)
    assert.match(parsed.problem ?? '', /绝不会被静默当作 observe/)

    const outcome = applyRuleModes(
        [{ id: 'test', mode: 'shadow' }],
        [{ rule: 'test', state: 'BLOCK', reason: '必需命令失败（exit=2）' }],
    )
    assert.equal(outcome.effective.state, 'BLOCK')
    assert.deepEqual(outcome.observations, [])
    assert.match(outcome.problems[0] ?? '', /规则 "test" 的 mode 必须是 observe \/ enforce/)
})

test('a verdict with no configured rule is a synthetic check and enforces', () => {
    const outcome = applyRuleModes(
        [{ id: 'test' }],
        [
            { rule: 'test', state: 'PASS', reason: '通过' },
            { rule: 'limit-changed-files', state: 'BLOCK', reason: '改动文件数超限' },
        ],
    )
    assert.equal(outcome.effective.state, 'BLOCK')
    assert.deepEqual(
        outcome.effective.rules.map((verdict) => verdict.rule),
        ['test', 'limit-changed-files'],
    )
})

test('a rule with no verdict is reported, never invented as an observation', () => {
    const outcome = applyRuleModes(
        [{ id: 'shadow', mode: 'observe' }],
        [],
    )
    assert.equal(outcome.effective.state, 'PASS')
    assert.deepEqual(outcome.observations, [])
    assert.match(outcome.problems[0] ?? '', /没有裁决（未被评估）/)
})

test('a duplicated verdict cannot make one rule appear twice in the record', () => {
    const outcome = applyRuleModes(
        [{ id: 'shadow', mode: 'observe' }],
        [
            { rule: 'shadow', state: 'PASS', reason: '第一次' },
            { rule: 'shadow', state: 'BLOCK', reason: '第二次' },
        ],
    )
    assert.deepEqual(
        outcome.observations.map((observation) => observation.would),
        ['PASS'],
    )
    assert.match(outcome.problems[0] ?? '', /出现了多次裁决/)
})

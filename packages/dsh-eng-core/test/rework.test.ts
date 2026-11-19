/**
 * The rework ratio and its escalation (AC-011).
 *
 * The ratio is the only number the split workflow uses to decide "keep going or
 * change the model", so every boundary is pinned here: what counts as started,
 * what counts as redone, and that EQUALITY with the threshold is not "exceeded"
 * (a `<` / `<=` slip here would silently change when the mission starts running
 * on the expensive model).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import {
    computeRework,
    ratioText,
    renderReworkReport,
    routeForNextTask,
    splitReworkFile,
    writeSplitReworkReport,
} from '../dist/split.js'

/** The effective `models.json` the route decision reads. */
const MODELS = {
    planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
    worker: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' },
}

test('the ratio is reworked ÷ started; unstarted tasks are in neither side (AC-011)', () => {
    const report = computeRework({
        tasks: [
            { id: 't1', started: true, reworked: true, signals: ['merge-conflict'] },
            { id: 't2', started: true },
            { id: 't3', started: true },
            { id: 't4', started: true },
            { id: 't5', started: false, reworked: true },
        ],
        threshold: 0.3,
    })
    assert.equal(report.started, 4)
    assert.equal(report.reworked, 1)
    assert.equal(report.ratio, 0.25)
    assert.equal(report.exceeded, false)
    assert.equal(report.escalate, false)
    assert.equal(report.tasks.length, 5)
    assert.deepEqual(report.tasks[0]?.signals, ['merge-conflict'])
})

test('exactly AT the threshold is not exceeded (equality is allowed)', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, started: true, reworked: index < 3 }))
    const report = computeRework({ tasks, threshold: 0.3 })
    assert.equal(report.started, 10)
    assert.equal(report.reworked, 3)
    assert.equal(report.ratio, 0.3)
    assert.equal(report.exceeded, false, '0.3 must not exceed 0.3')
    assert.equal(report.escalate, false)
})

test('above the threshold escalates without stopping (只升级，不中止)', () => {
    const report = computeRework({
        tasks: [
            { id: 't1', started: true, reworked: true, signals: ['acceptance-failed'] },
            { id: 't2', started: true, reworked: true, signals: ['gate-rollback'] },
            { id: 't3', started: true },
        ],
        threshold: 0.3,
    })
    assert.equal(report.ratio, 2 / 3)
    assert.equal(report.exceeded, true)
    assert.equal(report.escalate, true)
    // No `abort`/`stop` field: escalating is the whole reaction.
    assert.equal('abort' in report, false)
})

test('all three rework signals count, and a naked reworked marker does too', () => {
    const report = computeRework({
        tasks: [
            { id: 't1', signals: ['merge-conflict', 'gate-rollback'] },
            { id: 't2', reworked: true },
            { id: 't3' },
        ],
        threshold: 0.9,
    })
    assert.deepEqual(report.tasks[0]?.signals, ['merge-conflict', 'gate-rollback'])
    assert.equal(report.reworked, 2)
})

test('malformed input is named instead of guessed', () => {
    const report = computeRework({
        tasks: [{ id: 't1', signals: ['because-i-said-so'] }, { id: '' }, 42],
        threshold: 'high',
    })
    assert.equal(report.threshold, 0, 'an unusable threshold is strict, not permissive')
    assert.ok(report.problems.some((problem) => problem.includes('maxReworkRatio')))
    assert.ok(report.problems.some((problem) => problem.includes('because-i-said-so')))
    assert.ok(report.problems.some((problem) => problem.includes('tasks[1].id')))
    assert.ok(report.problems.some((problem) => problem.includes('tasks[2]')))
    assert.equal(report.started, 1)
})

test('a report with no started task has ratio 0 (no division by zero)', () => {
    const report = computeRework({ tasks: [{ id: 't1', started: false }], threshold: 0 })
    assert.equal(report.started, 0)
    assert.equal(report.ratio, 0)
    assert.equal(report.exceeded, false)
})

test('an omitted threshold uses the documented 0.3 default (project value still wins)', () => {
    const withoutThreshold = computeRework({ tasks: [{ id: 't1', reworked: true }, { id: 't2' }, { id: 't3' }, { id: 't4' }] })
    assert.equal(withoutThreshold.threshold, 0.3)
    assert.equal(withoutThreshold.ratio, 0.25)
    assert.equal(withoutThreshold.escalate, false)
    const stricter = computeRework({ tasks: [{ id: 't1', reworked: true }, { id: 't2' }], threshold: 0.1 })
    assert.equal(stricter.threshold, 0.1)
    assert.equal(stricter.escalate, true)
})

test('the next task uses the worker model normally, the planner model when escalated (AC-011)', () => {
    const calm = routeForNextTask({ escalate: false }, MODELS)
    assert.equal(calm.modelClass, 'worker')
    assert.equal(calm.provider, 'deepseek')
    assert.equal(calm.model, 'deepseek-chat')
    assert.equal(calm.reasoningEffort, 'low')
    assert.equal(calm.escalated, false)
    assert.deepEqual(calm.problems, [])

    const escalated = routeForNextTask({ escalate: true }, MODELS)
    assert.equal(escalated.modelClass, 'planner')
    assert.equal(escalated.model, 'deepseek-reasoner')
    assert.equal(escalated.reasoningEffort, 'high')
    assert.equal(escalated.escalated, true)
})

test('escalation with no planner model is named, never silently downgraded', () => {
    const route = routeForNextTask({ escalate: true }, { worker: { model: 'deepseek/deepseek-chat' } })
    assert.equal(route.escalated, true)
    assert.equal(route.modelClass, 'planner')
    assert.equal(route.model, undefined)
    assert.ok(route.problems.some((problem) => problem.includes('planner 段没有配置 model')))
    assert.match(route.problems[0] ?? '', /不会回退宿主默认/)
})

test('the ratio and threshold are written into the mission split report (AC-011)', () => {
    const cwd = tempWorkspace('rework-')
    const layout = resolveLayout(cwd)
    const report = computeRework({ tasks: [{ id: 't1', reworked: true }, { id: 't2' }], threshold: 0.3 })
    const written = writeSplitReworkReport(layout, 'm1', report, 1_700_000_000_000)
    assert.equal(written.file, splitReworkFile(layout, 'm1'))
    const stored = JSON.parse(fs.readFileSync(written.file, 'utf8')) as { missionId: string; at: number; ratio: number; threshold: number; escalate: boolean }
    assert.equal(stored.missionId, 'm1')
    assert.equal(stored.at, 1_700_000_000_000)
    assert.equal(stored.ratio, 0.5)
    assert.equal(stored.threshold, 0.3)
    assert.equal(stored.escalate, true)
    assert.ok(fs.existsSync(path.dirname(written.file)))
})

test('the summary names the ratio, the threshold and the decision', () => {
    const report = computeRework({ tasks: [{ id: 't1', reworked: true }, { id: 't2' }], threshold: 0.3 })
    assert.equal(ratioText(report), '1/2 = 0.500')
    const text = renderReworkReport(report)
    assert.match(text, /返工率 1\/2 = 0\.500/)
    assert.match(text, /超过阈值 0\.3/)
    assert.match(text, /planner 模型（不中止）/)
})

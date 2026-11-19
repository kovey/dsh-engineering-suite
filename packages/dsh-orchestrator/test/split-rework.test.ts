/**
 * Rework escalation at dispatch time (AC-011): above
 * `quality.maxReworkRatio` the next task runs on the PLANNER model, the ratio
 * and the threshold are written into `split/rework.json`, and a warning is
 * recorded in the mission's evidence ledger — without stopping the mission.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStore, resolveLayout, type Layout } from 'dsh-eng-core'
import type { ModelsConfig } from 'dsh-eng-core/split'
import { splitReworkFile } from 'dsh-eng-core/split'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { planNextSplitTask } from '../dist/split-rework.js'

/** The effective `models.json` a mission runs with. */
function models(maxReworkRatio: number): ModelsConfig {
    return {
        planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
        worker: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' },
        split: { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2 },
        quality: { maxReworkRatio },
    }
}

/** A mission in a temp workspace (the warning is written into its ledger). */
function mission(modelsFile: ModelsConfig): { cwd: string; layout: Layout; store: MissionStore; models: ModelsConfig } {
    const cwd = tempWorkspace('orchestrator-rework-')
    const layout = resolveLayout(cwd)
    const store = new MissionStore({ layout })
    store.create({ id: 'm-1', title: '返工率测试', cwd, sessionId: 's-1' })
    return { cwd, layout, store, models: modelsFile }
}

test('a high rework ratio switches the next task to the planner model and warns (AC-011)', () => {
    const { layout, store, models: config } = mission(models(0.3))
    const plan = planNextSplitTask({
        layout,
        missionId: 'm-1',
        models: config,
        tasks: [
            { id: 't1', started: true, reworked: true, signals: ['merge-conflict'] },
            { id: 't2', started: true },
        ],
    })
    assert.equal(plan.report.escalate, true)
    assert.equal(plan.report.ratio, 0.5)
    assert.equal(plan.route.modelClass, 'planner')
    assert.equal(plan.route.model, 'deepseek-reasoner')
    assert.match(plan.warning ?? '', /返工率 1\/2 = 0\.500 超过阈值 0\.3/)
    assert.match(plan.warning ?? '', /不中止/)
    // The ratio and the threshold are in the mission's split report.
    const file = splitReworkFile(layout, 'm-1')
    assert.equal(plan.file, file)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { ratio: number; threshold: number; escalate: boolean }
    assert.equal(stored.ratio, 0.5)
    assert.equal(stored.threshold, 0.3)
    assert.equal(stored.escalate, true)
    // ... and the warning is a mission evidence row, not a console line.
    const warnings = store.readEvidence('m-1').filter((record) => record.kind === 'manual' && /返工率/.test(record.summary))
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.artifactPath, file)
    assert.equal((warnings[0]?.data as { rework?: { escalate?: boolean } }).rework?.escalate, true)
})

test('a rework ratio at or under the threshold keeps the worker model and writes no warning', () => {
    const { layout, store, models: config } = mission(models(0.3))
    const plan = planNextSplitTask({
        layout,
        missionId: 'm-1',
        models: config,
        tasks: [
            { id: 't1', started: true, reworked: true, signals: ['acceptance-failed'] },
            { id: 't2', started: true },
            { id: 't3', started: true },
            { id: 't4', started: true },
        ],
    })
    assert.equal(plan.report.escalate, false)
    assert.equal(plan.route.modelClass, 'worker')
    assert.equal(plan.route.model, 'deepseek-chat')
    assert.equal(plan.route.reasoningEffort, 'low')
    assert.equal(plan.warning, undefined)
    assert.equal(store.readEvidence('m-1').length, 0)
    assert.match(plan.lines.join('\n'), /未超过阈值 0\.3/)
})

test('an escalation without a planner model is reported on the dispatch line (never silently un-escalated)', () => {
    const config = { ...models(0.3), planner: {} }
    const { layout } = mission(config)
    const plan = planNextSplitTask({
        layout,
        missionId: 'm-1',
        models: config,
        tasks: [
            { id: 't1', started: true, reworked: true },
            { id: 't2', started: true },
        ],
    })
    assert.equal(plan.route.escalated, true)
    assert.equal(plan.route.model, undefined)
    assert.equal(plan.route.modelClass, 'planner')
    assert.match(plan.lines.join('\n'), /planner 段没有配置 model/)
    assert.match(plan.lines.join('\n'), /未配置/)
    // Still not a stop: the mission keeps going, with the problem on the record.
    assert.ok(fs.existsSync(splitReworkFile(layout, 'm-1')))
    assert.equal(path.dirname(splitReworkFile(layout, 'm-1')).endsWith(path.join('split')), true)
})

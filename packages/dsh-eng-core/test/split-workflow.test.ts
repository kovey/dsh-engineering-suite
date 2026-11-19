/**
 * The split workflow's pure half: `models.json` resolution (AC-001), the three
 * automatic checks of a plan (AC-004), the "is splitting worth it" threshold
 * (AC-005) and the review record's digest binding (AC-003).
 *
 * The tests are the specification's TC-2001/TC-2004/TC-2009/TC-2010/TC-2016/
 * TC-2017 cases, plus the digest-mismatch behaviour the orchestrator gate relies
 * on (TC-2012). Everything here is filesystem + pure functions: no host, no
 * orchestrator.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout, type Layout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import {
    DEFAULT_MODELS_CONFIG,
    canonicalJson,
    decideSplit,
    loadModelsConfig,
    recordSplitReview,
    saveSplitPlan,
    splitPlanDigest,
    splitReviewStatus,
    splitTaskBranch,
    splitWorktreeDir,
    validateSplitPlan,
    type SplitPlan,
} from '../dist/split.js'

// --- helpers --------------------------------------------------------------

/** A workspace with the resolved layout and (optionally) a written models file. */
function workspace(models?: unknown): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace('split-models-')
    const layout = resolveLayout(cwd)
    if (models !== undefined) {
        fs.mkdirSync(layout.configDir, { recursive: true })
        fs.writeFileSync(path.join(layout.configDir, 'models.json'), typeof models === 'string' ? models : JSON.stringify(models))
    }
    return { cwd, layout }
}

/** A specification view with the given acceptance criteria. */
function spec(...ids: string[]): { acceptanceCriteria: { id: string }[] } {
    return { acceptanceCriteria: ids.map((id) => ({ id })) }
}

/** A plan with two disjoint tasks covering AC-001 and AC-002. */
function twoTaskPlan(): SplitPlan {
    return {
        tasks: [
            { id: 't1', goal: '改 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 't2', goal: '改 b', paths: ['packages/b/**'], acceptance: ['AC-002'], dependsOn: [], parallel: true },
        ],
        coverage: { 'AC-001': ['t1'], 'AC-002': ['t2'] },
        parallelGroups: [['t1', 't2']],
    }
}

// --- models.json ----------------------------------------------------------

test('no models.json: every class falls back to the host defaults and is NAMED (TC-2001)', () => {
    const { cwd, layout } = workspace()
    const resolved = loadModelsConfig(layout)
    assert.equal(resolved.present, false)
    assert.deepEqual(resolved.config, DEFAULT_MODELS_CONFIG)
    assert.deepEqual(resolved.config.split, { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2 })
    assert.equal(resolved.config.quality.maxReworkRatio, 0.3)
    assert.deepEqual(resolved.sources, { planner: 'default', worker: 'default', split: 'default', quality: 'default' })
    // Never silent: one line per class, pointing at the file that was consulted.
    for (const section of ['planner', 'worker', 'split', 'quality']) {
        assert.ok(
            resolved.problems.some((problem) => problem.includes(section) && problem.includes('models.json')),
            `problems must name the missing ${section} class: ${resolved.problems.join(' | ')}`,
        )
    }
    assert.equal(resolved.problems.length, 4, resolved.problems.join(' | '))
    assert.ok(fs.existsSync(cwd))
})

test('the project file wins over the profile, and both win over the host defaults (AC-001)', () => {
    const { layout } = workspace({
        planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
        worker: { model: 'deepseek/deepseek-chat' },
        split: { reviewRequired: false, maxTasks: 4, maxParallel: 2, maxReworkRounds: 1 },
        quality: { maxReworkRatio: 0.5 },
    })
    const resolved = loadModelsConfig(layout, { profile: { planner: { model: 'profile-model' }, worker: { model: 'profile-worker' } } })
    assert.equal(resolved.present, true)
    assert.equal(resolved.config.planner.model, 'deepseek/deepseek-reasoner')
    assert.equal(resolved.config.planner.reasoningEffort, 'high')
    assert.equal(resolved.config.worker.model, 'deepseek/deepseek-chat')
    assert.equal(resolved.config.split.reviewRequired, false)
    assert.equal(resolved.config.split.maxTasks, 4)
    assert.equal(resolved.config.split.maxParallel, 2)
    assert.equal(resolved.config.split.maxReworkRounds, 1)
    assert.equal(resolved.config.quality.maxReworkRatio, 0.5)
    assert.deepEqual(resolved.sources, { planner: 'project', worker: 'project', split: 'project', quality: 'project' })
    assert.deepEqual(resolved.problems, [])
})

test('a class only the profile declares comes from the profile, and says so', () => {
    const { layout } = workspace({ planner: { model: 'project-planner' } })
    const resolved = loadModelsConfig(layout, {
        profile: { worker: { model: 'profile-worker' }, split: { maxTasks: 6 }, quality: { maxReworkRatio: 0.2 } },
    })
    assert.equal(resolved.config.planner.model, 'project-planner')
    assert.equal(resolved.sources.planner, 'project')
    assert.equal(resolved.config.worker.model, 'profile-worker')
    assert.equal(resolved.sources.worker, 'profile')
    assert.equal(resolved.config.split.maxTasks, 6)
    assert.equal(resolved.config.split.maxParallel, 3)
    assert.equal(resolved.sources.split, 'profile')
    // Nothing fell back to the host default except split.maxParallel etc.
    assert.ok(resolved.problems.some((problem) => problem.includes('split.maxParallel')))
    assert.ok(resolved.problems.some((problem) => problem.includes('split.reviewRequired')))
})

test('a partially declared class reports every field it took from the default (never silent)', () => {
    const { layout } = workspace({ split: { maxTasks: 5 } })
    const resolved = loadModelsConfig(layout)
    assert.equal(resolved.config.split.maxTasks, 5)
    assert.equal(resolved.config.split.maxParallel, 3)
    for (const field of ['reviewRequired', 'maxParallel', 'maxReworkRounds']) {
        assert.ok(
            resolved.problems.some((problem) => problem.includes(`split.${field}`) && problem.includes('回退默认')),
            `missing fallback note for split.${field}: ${resolved.problems.join(' | ')}`,
        )
    }
})

test('invalid values are reported and replaced by the default, never guessed', () => {
    const { layout } = workspace({
        planner: { model: 42 },
        split: { maxTasks: 0, maxParallel: 'many', reviewRequired: 'yes', maxReworkRounds: -1 },
        quality: { maxReworkRatio: 2 },
    })
    const resolved = loadModelsConfig(layout)
    assert.equal(resolved.config.planner.model, undefined)
    assert.equal(resolved.config.split.maxTasks, 8)
    assert.equal(resolved.config.split.maxParallel, 3)
    assert.equal(resolved.config.split.reviewRequired, true)
    assert.equal(resolved.config.split.maxReworkRounds, 2)
    assert.equal(resolved.config.quality.maxReworkRatio, 0.3)
    for (const fragment of ['planner 段 的 model', 'maxTasks', 'maxParallel', 'reviewRequired', 'maxReworkRounds', 'maxReworkRatio']) {
        assert.ok(
            resolved.problems.some((problem) => problem.includes(fragment)),
            `missing problem for ${fragment}: ${resolved.problems.join(' | ')}`,
        )
    }
})

test('a malformed models.json is reported and the defaults still apply', () => {
    const { layout } = workspace('{ not json')
    const resolved = loadModelsConfig(layout)
    assert.equal(resolved.present, true)
    assert.deepEqual(resolved.config, DEFAULT_MODELS_CONFIG)
    assert.ok(resolved.problems.some((problem) => problem.includes('不是合法 JSON')))
    assert.equal(resolved.problems.filter((problem) => problem.includes('已回退宿主默认')).length, 4)
})

// --- the three automatic checks (AC-004) ----------------------------------

test('a plan that satisfies all three checks is sendable', () => {
    const validation = validateSplitPlan(twoTaskPlan(), spec('AC-001', 'AC-002'))
    assert.deepEqual(validation.problems, [])
    assert.equal(validation.ok, true)
    assert.deepEqual(validation.covered, ['AC-001', 'AC-002'])
    assert.deepEqual(validation.uncovered, [])
})

test('check 1: a task with no acceptance criterion blocks the plan (TC-2009)', () => {
    const plan = twoTaskPlan()
    plan.tasks[1] = { ...plan.tasks[1]!, acceptance: [] }
    const validation = validateSplitPlan(plan, spec('AC-001', 'AC-002'))
    assert.equal(validation.ok, false)
    assert.ok(validation.problems.some((problem) => problem.code === 'task-without-ac' && problem.taskId === 't2'))
})

test('check 1: a task mapping an acceptance criterion the spec does not have blocks the plan', () => {
    const plan = twoTaskPlan()
    plan.tasks[1] = { ...plan.tasks[1]!, acceptance: ['AC-002', 'AC-999'] }
    const validation = validateSplitPlan(plan, spec('AC-001', 'AC-002'))
    assert.equal(validation.ok, false)
    assert.ok(validation.problems.some((problem) => problem.code === 'unknown-ac' && problem.detail.includes('AC-999')))
})

test('check 2: overlapping paths inside one parallel group block the plan, naming both paths (TC-2010)', () => {
    const plan = twoTaskPlan()
    plan.tasks[0] = { ...plan.tasks[0]!, paths: ['packages/a/**'] }
    plan.tasks[1] = { ...plan.tasks[1]!, paths: ['packages/a/file.ts'] }
    const validation = validateSplitPlan(plan, spec('AC-001', 'AC-002'))
    assert.equal(validation.ok, false)
    const overlap = validation.problems.find((problem) => problem.code === 'paths-overlap')
    assert.ok(overlap !== undefined, JSON.stringify(validation.problems))
    assert.match(overlap.detail, /packages\/a\/\*\*/)
    assert.match(overlap.detail, /packages\/a\/file\.ts/)
})

test('check 2: the same overlapping paths in DIFFERENT groups are allowed (the group is the unit)', () => {
    const plan = twoTaskPlan()
    plan.tasks[0] = { ...plan.tasks[0]!, paths: ['packages/a/**'] }
    plan.tasks[1] = { ...plan.tasks[1]!, paths: ['packages/a/file.ts'] }
    plan.parallelGroups = [['t1'], ['t2']]
    const validation = validateSplitPlan(plan, spec('AC-001', 'AC-002'))
    assert.equal(validation.ok, true, JSON.stringify(validation.problems))
})

test('check 3: an acceptance criterion nobody covers blocks the plan (TC-2002 negative half)', () => {
    const validation = validateSplitPlan(twoTaskPlan(), spec('AC-001', 'AC-002', 'AC-003'))
    assert.equal(validation.ok, false)
    assert.deepEqual(validation.uncovered, ['AC-003'])
    assert.ok(validation.problems.some((problem) => problem.code === 'ac-uncovered' && problem.detail.includes('AC-003')))
})

test('shape problems are reported instead of throwing (unknown task in a group / duplicate group)', () => {
    const plan = twoTaskPlan()
    plan.parallelGroups = [['t1', 'ghost'], ['t1']]
    const validation = validateSplitPlan(plan, spec('AC-001', 'AC-002'))
    assert.equal(validation.ok, false)
    assert.ok(validation.problems.some((problem) => problem.code === 'unknown-task' && problem.detail.includes('ghost')))
    assert.ok(validation.problems.some((problem) => problem.detail.includes('多个并行组')))
    assert.ok(validation.problems.some((problem) => problem.taskId === 't2' && problem.detail.includes('没有出现在任何并行组')))
})

test('the plan digest ignores key order but not content (the review binds to content)', () => {
    const plan = twoTaskPlan()
    const reordered: SplitPlan = {
        parallelGroups: [['t1', 't2']],
        coverage: { 'AC-002': ['t2'], 'AC-001': ['t1'] },
        tasks: plan.tasks.map((task) => ({ parallel: task.parallel, dependsOn: task.dependsOn, acceptance: task.acceptance, paths: task.paths, goal: task.goal, id: task.id })),
    }
    assert.equal(splitPlanDigest(plan), splitPlanDigest(reordered))
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
    const edited = { ...plan, tasks: [{ ...plan.tasks[0]!, goal: '改 c' }, plan.tasks[1]!] }
    assert.notEqual(splitPlanDigest(plan), splitPlanDigest(edited))
})

// --- the threshold (AC-005) ----------------------------------------------

test('one task is not worth splitting (TC-2017)', () => {
    const plan: SplitPlan = {
        tasks: [{ id: 't1', goal: '全部', paths: ['packages/**'], acceptance: ['AC-001'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['t1'] },
        parallelGroups: [['t1']],
    }
    const decision = decideSplit(plan, DEFAULT_MODELS_CONFIG.split)
    assert.equal(decision.decision, 'not-worth-splitting')
    assert.match(decision.reasons[0] ?? '', /少于 2 条/)
})

test('two tasks with exactly the same paths are not worth splitting either', () => {
    const plan = twoTaskPlan()
    plan.tasks[1] = { ...plan.tasks[1]!, paths: ['packages/a/**'] }
    const decision = decideSplit(plan, DEFAULT_MODELS_CONFIG.split)
    assert.equal(decision.decision, 'not-worth-splitting')
    assert.match(decision.reasons[0] ?? '', /路径完全相同/)
})

test('more tasks than maxTasks is refused, pointing at several missions (TC-2016)', () => {
    const plan = twoTaskPlan()
    plan.tasks.push({ id: 't3', goal: '改 c', paths: ['packages/c/**'], acceptance: ['AC-003'], dependsOn: [], parallel: true })
    const decision = decideSplit(plan, { ...DEFAULT_MODELS_CONFIG.split, maxTasks: 2 })
    assert.equal(decision.decision, 'too-large')
    assert.match(decision.reasons[0] ?? '', /maxTasks=2/)
    assert.match(decision.reasons[0] ?? '', /拆成多个 mission/)
})

test('a parallel group larger than maxParallel is refused, pointing at several missions', () => {
    const plan = twoTaskPlan()
    const decision = decideSplit(plan, { ...DEFAULT_MODELS_CONFIG.split, maxParallel: 1 })
    assert.equal(decision.decision, 'too-large')
    assert.match(decision.reasons[0] ?? '', /maxParallel=1/)
    assert.match(decision.reasons[0] ?? '', /拆成多个 mission/)
})

test('a valid two-task plan is split', () => {
    const decision = decideSplit(twoTaskPlan(), DEFAULT_MODELS_CONFIG.split)
    assert.equal(decision.decision, 'split')
    assert.match(decision.reasons[0] ?? '', /2 条子任务/)
})

// --- the review record (AC-003 / TC-2012) --------------------------------

test('a review records the CURRENT plan digest and is readable', () => {
    const { layout } = workspace()
    const saved = saveSplitPlan(layout, 'm-1', twoTaskPlan())
    assert.ok(fs.existsSync(saved.file))
    const written = recordSplitReview(layout, 'm-1', { approver: 'alice', decision: 'approved', planDigest: saved.digest })
    assert.equal(written.ok, true, written.problems.join(' | '))
    assert.equal(written.record?.planDigest, saved.digest)
    assert.equal(written.record?.round, 1)
    const status = splitReviewStatus(layout, 'm-1')
    assert.equal(status.state, 'approved')
    assert.equal(status.ok, true)
})

test('a review quoting another plan digest is refused and writes nothing (TC-2012)', () => {
    const { layout } = workspace()
    saveSplitPlan(layout, 'm-1', twoTaskPlan())
    const written = recordSplitReview(layout, 'm-1', { approver: 'alice', decision: 'approved', planDigest: 'deadbeef' })
    assert.equal(written.ok, false)
    assert.ok(written.problems.some((problem) => problem.includes('不一致')))
    assert.equal(splitReviewStatus(layout, 'm-1').state, 'missing-review')
})

test('editing the plan after approval makes the review stale', () => {
    const { layout } = workspace()
    const saved = saveSplitPlan(layout, 'm-1', twoTaskPlan())
    recordSplitReview(layout, 'm-1', { approver: 'alice', decision: 'approved', planDigest: saved.digest })
    const edited = twoTaskPlan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '换一个目标' }
    saveSplitPlan(layout, 'm-1', edited)
    const status = splitReviewStatus(layout, 'm-1')
    assert.equal(status.state, 'stale')
    assert.equal(status.ok, false)
    assert.match(status.detail, /必须重新审核/)
})

test('a rejection is visible as rejected, with its round and note', () => {
    const { layout } = workspace()
    const saved = saveSplitPlan(layout, 'm-1', twoTaskPlan())
    recordSplitReview(layout, 'm-1', { approver: 'alice', decision: 'rejected', planDigest: saved.digest, note: '拆得太碎' })
    const status = splitReviewStatus(layout, 'm-1')
    assert.equal(status.state, 'rejected')
    assert.match(status.detail, /拆得太碎/)
    assert.match(status.detail, /第 1 轮/)
})

test('reviewing without a plan is refused (nothing to review)', () => {
    const { layout } = workspace()
    const written = recordSplitReview(layout, 'm-1', { approver: 'alice', decision: 'approved' })
    assert.equal(written.ok, false)
    assert.ok(written.problems.some((problem) => problem.includes('没有拆分计划')))
})

// --- worktree conventions (AC-006 paths, used by the importer) -----------

test('worktree and branch names are derived from the mission and task ids', () => {
    const { layout } = workspace()
    assert.equal(splitTaskBranch('m-1', 't1'), 'split/m-1/t1')
    assert.ok(splitWorktreeDir(layout, 'm-1', 't1').endsWith(path.join('worktrees', 'm-1', 't1')))
    assert.throws(() => splitWorktreeDir(layout, 'm-1', '../escape'), /unsafe/)
})

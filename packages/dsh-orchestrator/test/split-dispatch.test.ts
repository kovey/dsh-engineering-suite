/**
 * The split workflow's PRODUCTION call site: entering `implement` with an
 * approved plan dispatches the plan's workers (no model in the loop).
 *
 * The fake host supplies `startActivation` (the workers) and a `role-guard`
 * service (the worker's whitelist); the repository is real, so the worktrees are
 * really created. `autoDispatch` stays DISABLED on purpose: enabling `split` is
 * the deployment's decision to dispatch workers, and this test pins that the
 * runner is not silently gated behind a second switch.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout, type MissionStore } from 'dsh-eng-core'
import { recordSplitReview, saveSplitPlan, splitPlanDigest, splitWorktreeDir, worktreeRoot, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { splitRunFile } from '../dist/split-run-types.js'
import { apply } from '../dist/index.js'
import { splitTaskTimeoutMs } from '../dist/split-dispatch.js'

/** Sibling plugin tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** The role-guard service the runner needs (worker identity + tool whitelist). */
const ROLE_GUARD = {
    plan: () => ({ persona: '你是子任务执行者（worker）', toolFilter: { allow: ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write'] } }),
    bind: () => ({ role: 'worker' }),
}

/** One git invocation (a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/** A real repository with `.dsh/` ignored, so worktrees can be created. */
function repo(): string {
    const cwd = tempWorkspace('orchestrator-split-dispatch-')
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'fixture@example.com'])
    git(cwd, ['config', 'user.name', 'Fixture'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    return cwd
}

/** Assemble the plugin with a modern host and the split workflow enabled. */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({
        cwd,
        withSubagents: true,
        withActivation: true,
        withAgentPresets: true,
        services: { 'role-guard': ROLE_GUARD },
    })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log'), split: { enabled: true } })
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    return fake
}

/** A plan whose two tasks are valid and cover the mission's three criteria. */
function goodPlan(): SplitPlan {
    return {
        tasks: [
            { id: 'T-001', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 'T-002', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002', 'AC-003'], dependsOn: [], parallel: true },
        ],
        coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-002'], 'AC-003': ['T-002'] },
        parallelGroups: [['T-001', 'T-002']],
    }
}

/** A mission parked on `stage` with an approved spec (three criteria). */
function missionAt(fake: FakeHost, stage: string): { store: MissionStore; layout: Layout } {
    const store = new MissionStoreRegistry().for(fake.cwd)
    store.create({ id: 'm1', title: '拆分派发接线', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm1', stage)
    store.update('m1', () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: '拆分派发接线',
            background: '',
            requirements: [],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'a' },
                { id: 'AC-002', text: 'b' },
                { id: 'AC-003', text: 'c' },
            ],
            fileBoundaries: ['packages/**'],
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
        },
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
    const layout = resolveLayout(fake.cwd)
    // The project's model classes (AC-001): worker runs the tasks, planner is the
    // escalation. Written where `loadModelsConfig` reads it.
    fs.writeFileSync(
        path.join(layout.rootDir, 'models.json'),
        JSON.stringify({
            worker: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' },
            planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
            split: { maxParallel: 2 },
        }),
    )
    return { store, layout }
}

/** Record an approval for the plan currently on disk. */
function approve(layout: Layout): void {
    const digest = splitPlanDigest(JSON.parse(fs.readFileSync(path.join(layout.missionsDir, 'm1', 'split', 'plan.json'), 'utf8')) as SplitPlan)
    const review = recordSplitReview(layout, 'm1', { approver: 'alice', decision: 'approved', planDigest: digest })
    assert.equal(review.ok, true, review.problems.join(' | '))
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

test('entering implement with an approved plan dispatches one worker per task, inside its worktree (AC-006/AC-011)', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const { layout } = missionAt(fake, 'split-review')
    saveSplitPlan(layout, 'm1', goodPlan())
    approve(layout)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })

    // Admitted: the split-review stage settled and implement is ENTERED (dispatch
    // is not settlement — the mission stays in implement).
    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(new MissionStoreRegistry().for(cwd).read('m1')?.stage, 'implement')
    // Two workers were dispatched, each inside its own worktree, on the project's
    // worker model, with the role preset mounted (the whitelist travels with it).
    assert.equal(fake.activationSpecs.length, 2, text)
    const specs = fake.activationSpecs as { label: string; request?: { cwd?: string; agentOptions?: { model?: string } } }[]
    assert.deepEqual(specs.map((spec) => spec.request?.cwd), [splitWorktreeDir(layout, 'm1', 'T-001'), splitWorktreeDir(layout, 'm1', 'T-002')])
    assert.deepEqual(specs.map((spec) => spec.request?.agentOptions?.model), ['deepseek-chat', 'deepseek-chat'])
    assert.equal(fake.presetDefinitions.has('orchestrator:worker'), true, 'the worker role preset must be mounted')
    assert.equal(fake.activationDisposals(), 2)
    // The workers produced nothing usable (the fake host's child makes no commit),
    // so the run is recorded as failed tasks rather than claimed as success.
    // Since P3 the state is `needs-resplit` (AC-002): the ONE allowed attempt
    // (default `maxAttempts: 1`) failed, so the task needs a new split/review
    // round — `failed` would read like "an attempt is still coming".
    const record = JSON.parse(fs.readFileSync(splitRunFile(layout, 'm1'), 'utf8')) as { state: string; tasks: { id: string; state: string; attempts: number }[]; rework: { ratio: number } }
    assert.equal(record.state, 'ran')
    assert.deepEqual(record.tasks.map((entry) => [entry.id, entry.state, entry.attempts]), [
        ['T-001', 'needs-resplit', 1],
        ['T-002', 'needs-resplit', 1],
    ])
    assert.equal(record.rework.ratio, 1)
    // The report shows one line per task and says the stage is NOT settled.
    assert.match(text, /拆分派发：2 个子任务/)
    assert.match(text, /T-001 needs-resplit/)
    assert.match(text, /T-002 needs-resplit/)
    assert.match(text, /派发\*\*不结算\*\*本阶段/)
})

test('a project without model classes dispatches on the host default and the summary says so (P4 AC-001)', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const { layout } = missionAt(fake, 'split-review')
    // No model classes at all: the override nobody wrote means "host default".
    fs.writeFileSync(path.join(layout.rootDir, 'models.json'), JSON.stringify({ worker: {}, planner: {} }))
    saveSplitPlan(layout, 'm1', goodPlan())
    approve(layout)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })

    // Dispatched anyway, with model/provider OMITTED from the request (the host decides).
    assert.equal(fake.activationSpecs.length, 2, text)
    const specs = fake.activationSpecs as { request?: { agentOptions?: { model?: string; provider?: string } } }[]
    assert.deepEqual(specs.map((spec) => spec.request?.agentOptions?.model), [undefined, undefined])
    assert.deepEqual(specs.map((spec) => spec.request?.agentOptions?.provider), [undefined, undefined])
    // The cross-task summary carries the same note `run.json` records.
    assert.match(text, /模型回退：worker 模型未配置，使用宿主默认/)
    assert.match(text, /worker=宿主默认/)
})

test('a plan that is not worth splitting leaves implement on the plain path (no worker, no run record) (AC-005)', async () => {
    const cwd = repo()
    const fake = host(cwd)
    // Parked on `split`: the plan gate itself decides "not worth splitting" and
    // skips the review, which is the plain-implement exit.
    const { layout } = missionAt(fake, 'split')
    saveSplitPlan(layout, 'm1', {
        tasks: [{ id: 'T-001', goal: '全部', paths: ['packages/**'], acceptance: ['AC-001', 'AC-002', 'AC-003'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-001'], 'AC-003': ['T-001'] },
        parallelGroups: [['T-001']],
    })

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })

    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(fake.activationSpecs.length, 0, 'a plan that is not worth splitting dispatches nobody')
    assert.equal(fs.existsSync(splitRunFile(layout, 'm1')), false, 'and it writes no dispatch record')
    assert.equal(fs.existsSync(worktreeRoot(layout)), false, 'and it creates no worktree')
})

test('the per-worker deadline comes from models.json split.taskTimeoutMs, not the host default (AC-003)', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const { layout } = missionAt(fake, 'split-review')
    // The project overrides the host's autoDispatch.timeoutMs (which stays at
    // its 10-minute default here): the dispatch report must quote the project's.
    const modelsFile = path.join(layout.rootDir, 'models.json')
    const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as { split: Record<string, unknown> }
    models.split['taskTimeoutMs'] = 4321
    fs.writeFileSync(modelsFile, JSON.stringify(models))
    saveSplitPlan(layout, 'm1', goodPlan())
    approve(layout)

    const text = await orchestrate(fake, { action: 'advance', verdict: 'PASS' })

    assert.match(text, /单任务超时 4321ms/)
    assert.equal(fake.activationSpecs.length, 2, text)
})

test('splitTaskTimeoutMs: project value → autoDispatch.timeoutMs → 600000, and an unusable value falls back', () => {
    const config = { autoDispatch: { timeoutMs: 90_000 } } as never
    assert.equal(splitTaskTimeoutMs(config, { split: { taskTimeoutMs: 4321 } }), 4321)
    assert.equal(splitTaskTimeoutMs(config, { split: {} }), 90_000)
    assert.equal(splitTaskTimeoutMs({ autoDispatch: undefined } as never, { split: {} }), 600_000)
    // 0 / negative / NaN are not deadlines: the documented default applies, never
    // "no deadline at all" (which is how a stuck worker wedges a tool call).
    for (const unusable of [0, -5, Number.NaN]) {
        assert.equal(splitTaskTimeoutMs(config, { split: { taskTimeoutMs: unusable } }), 90_000)
    }
})

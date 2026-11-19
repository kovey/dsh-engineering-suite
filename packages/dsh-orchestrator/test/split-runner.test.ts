/**
 * The split runner (AC-006 / AC-011): the schedule, the per-task dispatch, the
 * model routing and the finish sequence (merge → import → cleanup → records).
 *
 * The fixture is a REAL throwaway git repository and the REAL worktree/importer
 * code. Only the host's agent service is fake: `startActivation` records the spec
 * and hands the test a promise it completes — so "two workers started before the
 * first finished" is an observed fact, not a mock of the scheduler.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    createDelegationPresets,
    MissionStore,
    resolveLayout,
    type AgentLike,
    type DelegationActivationLike,
    type DelegationActivationSpec,
    type DelegationPresets,
    type Layout,
} from 'dsh-eng-core'
import {
    readSplitPlan,
    recordSplitReview,
    saveSplitPlan,
    splitTaskBranch,
    splitWorktreeDir,
    worktreeRoot,
    type ModelsConfig,
    type SplitPlan,
    type SplitTask,
} from 'dsh-eng-core/split'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { splitReworkFile } from 'dsh-eng-core/split'
import { runSplitPlan } from '../dist/split-runner.js'
import { splitRunFile, type SplitRunnerDeps, type SplitRoleGuard } from '../dist/split-run-types.js'

/** One git invocation in the fixture (a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/** A throwaway repo whose `.dsh/` (missions + worktrees) is gitignored, like the real workspace. */
function repo(prefix = 'orchestrator-split-runner-'): string {
    const cwd = tempWorkspace(prefix)
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

/** The effective `models.json` every test runs with. */
function models(overrides: Partial<ModelsConfig> = {}): ModelsConfig {
    return {
        planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
        worker: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' },
        split: { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2 },
        quality: { maxReworkRatio: 0.3 },
        ...overrides,
    }
}

/** One task of the fixture plans. */
function task(id: string, overrides: Partial<SplitTask> = {}): SplitTask {
    return { id, goal: `做 ${id}`, paths: [`src/${id}/**`], acceptance: ['AC-001'], dependsOn: [], parallel: true, ...overrides }
}

/** A plan with two tasks (the minimum AC-005 lets through). */
function twoTasks(groups: string[][], second: Partial<SplitTask> = {}): SplitPlan {
    return {
        tasks: [task('T-001'), task('T-002', second)],
        coverage: { 'AC-001': ['T-001', 'T-002'] },
        parallelGroups: groups,
    }
}

/** A mission whose plan is REVIEWED (the runner refuses an unreviewed one). */
function mission(cwd: string, plan: SplitPlan, options: { review?: 'approved' | 'none' } = {}): void {
    const layout = resolveLayout(cwd)
    new MissionStore({ layout }).create({ id: 'm1', title: '拆分派发测试', cwd, sessionId: 's1' })
    const saved = saveSplitPlan(layout, 'm1', plan)
    if (options.review === 'none') return
    const review = recordSplitReview(layout, 'm1', { approver: 'alice', decision: 'approved', planDigest: saved.digest, at: 1 })
    assert.equal(review.ok, true, review.problems.join(' | '))
}

// --- the fake host ---------------------------------------------------------

/** One activation the runner started, waiting for the test to finish it. */
interface StartedWorker {
    taskId: string
    spec: DelegationActivationSpec
    /** `true` once the test resolved or rejected the child. */
    finished: boolean
    resolve: () => void
    reject: (error: Error) => void
}

/** The fake `ctx.subagents`: records activations, completes on demand. */
interface FakeWorkers {
    service: {
        list: () => string[]
        getProvider: (name: string) => { name?: string; capabilities?: { agentPreset?: boolean } } | undefined
        startActivation: (spec: DelegationActivationSpec) => Promise<DelegationActivationLike>
    }
    started: StartedWorker[]
    waitFor: (count: number) => Promise<void>
}

function fakeWorkers(): FakeWorkers {
    const started: StartedWorker[] = []
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (count: number): Promise<void> => {
        for (let waited = 0; waited < 5_000; waited += 5) {
            if (started.length >= count) return
            await sleep(5)
        }
        throw new Error(`timed out waiting for ${count} activations (got ${started.length})`)
    }
    const service = {
        list: () => ['spawn'],
        getProvider: (name: string) => (name === 'spawn' ? { name, capabilities: { agentOptions: true, agentPreset: true, depthLimit: true } } : undefined),
        startActivation: async (spec: DelegationActivationSpec): Promise<DelegationActivationLike> => {
            const taskId = /·\s*(\S+)\s*$/.exec(spec.label)?.[1] ?? ''
            let settle: { resolve: () => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined }
            const result = new Promise<{ stopReason: string; output: { type: string; text?: string }[] }>((resolve, reject) => {
                settle = {
                    resolve: () => resolve({ stopReason: 'completed', output: [{ type: 'text', text: `done ${taskId}` }] }),
                    reject,
                }
            })
            const entry: StartedWorker = { taskId, spec, finished: false, resolve: () => undefined, reject: () => undefined }
            entry.resolve = () => {
                entry.finished = true
                settle.resolve()
            }
            entry.reject = (error) => {
                entry.finished = true
                settle.reject(error)
            }
            started.push(entry)
            return { childId: `child-${started.length}-${taskId}`, result, dispose: async () => undefined }
        },
    }
    return { service, started, waitFor }
}

/** The activation's request directory (the worktree the worker must run in). */
function worktreeOf(worker: StartedWorker): string {
    const cwd = worker.spec.request?.cwd ?? worker.spec.cwd
    assert.equal(typeof cwd, 'string', 'the activation must carry a cwd')
    return cwd as string
}

/** Commit one file inside the worker's worktree and return the commit id. */
function commitIn(worktree: string, subject: string): string {
    git(worktree, ['config', 'user.email', 'worker@example.com'])
    git(worktree, ['config', 'user.name', 'Worker'])
    const file = path.join(worktree, 'src', `${subject.split(':')[0]}.ts`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `export const value = ${JSON.stringify(subject)}\n`)
    git(worktree, ['add', 'src'])
    git(worktree, ['commit', '-q', '-m', subject])
    return git(worktree, ['rev-parse', 'HEAD'])
}

/** Write the worker's LOCAL evidence row into its own worktree ledger. */
function writeLocalEvidence(worktree: string, layout: Layout, taskId: string, commit: string): void {
    const dir = path.join(worktree, path.relative(layout.cwd, layout.rootDir), 'missions', 'm1')
    fs.mkdirSync(dir, { recursive: true })
    const row = { id: `ev-${taskId}`, kind: 'test', at: 1_700_000_000_000, summary: `${taskId} 本地验证通过`, taskId, commit, worktree, branch: splitTaskBranch('m1', taskId) }
    fs.appendFileSync(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(row)}\n`)
}

/** Finish one worker: commit in its worktree (optionally with evidence), then resolve. */
function finishWorker(workers: FakeWorkers, layout: Layout, taskId: string, options: { subject?: string; evidence?: boolean } = {}): string {
    const worker = workers.started.find((entry) => entry.taskId === taskId && !entry.finished)
    assert.ok(worker !== undefined, `no pending worker for ${taskId}`)
    const commit = commitIn(worktreeOf(worker), options.subject ?? `${taskId}: 实现 ${taskId}`)
    if (options.evidence !== false) writeLocalEvidence(worktreeOf(worker), layout, taskId, commit)
    worker.resolve()
    return commit
}

// --- the runner's deps -----------------------------------------------------

function fakePresets(): { presets: DelegationPresets; ids: string[] } {
    const ids: string[] = []
    const presets = createDelegationPresets({
        presets: () => ({
            register: async (definition: unknown) => {
                ids.push((definition as { id: string }).id)
                return async () => undefined
            },
        }),
    })
    return { presets, ids }
}

const ROLE_GUARD: SplitRoleGuard = {
    plan: () => ({ persona: '你是子任务执行者（worker）', toolFilter: { allow: ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write'] } }),
    bind: () => ({}),
}

/** The runner deps every test starts from. */
function deps(cwd: string, workers: FakeWorkers, overrides: Partial<SplitRunnerDeps> = {}): SplitRunnerDeps {
    const presets = fakePresets()
    const agent: AgentLike = { id: 'agent-1', session: { id: 's1', header: { id: 's1', cwd } } }
    return {
        layout: resolveLayout(cwd),
        missionId: 'm1',
        models: models(),
        subagents: workers.service,
        presets: presets.presets,
        roleGuard: () => ROLE_GUARD,
        provider: 'spawn',
        agent,
        maxDepth: 1,
        now: () => 1_700_000_000_000,
        ...overrides,
    }
}

/** The stored `split/run.json` of a mission. */
function runRecord(cwd: string): { state: string; tasks: { id: string; state: string; commit?: string; imported: number; cleanedUp: boolean }[]; imported: number } {
    const file = splitRunFile(resolveLayout(cwd), 'm1')
    assert.equal(fs.existsSync(file), true, `missing ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as never
}

// --- order and parallelism ------------------------------------------------

test('two independent tasks in one group are started together, on the worker model, inside their own worktrees (AC-006)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    // Both activations exist BEFORE either child produced anything: that is the
    // parallelism assertion (not "the run finished quickly").
    assert.equal(workers.started.length, 2)
    assert.deepEqual(workers.started.map((entry) => entry.taskId), ['T-001', 'T-002'])
    const layout = resolveLayout(cwd)
    const first = workers.started[0] as StartedWorker
    assert.equal(worktreeOf(first), splitWorktreeDir(layout, 'm1', 'T-001'))
    // The model comes from models.json (`deepseek/deepseek-chat` → provider + model).
    assert.equal(first.spec.request?.agentOptions?.model, 'deepseek-chat')
    assert.equal(first.spec.request?.agentOptions?.provider, 'deepseek')
    assert.equal(first.spec.agentOptions?.model, 'deepseek-chat', 'rc.2 reads the flat shape')

    const commit1 = finishWorker(workers, layout, 'T-001')
    // The second child is still pending after the first one finished.
    assert.equal((workers.started[1] as StartedWorker).finished, false)
    const commit2 = finishWorker(workers, layout, 'T-002')
    const result = await running

    assert.equal(result.state, 'ran')
    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.tasks[0]?.state, 'done')
    assert.equal(result.tasks[0]?.commit, commit1)
    assert.equal(result.tasks[1]?.commit, commit2)
    assert.equal(result.rework.ratio, 0)
    // imported rows landed in the main ledger with their source mapping.
    assert.equal(result.imported, 2)
    const evidence = fs.readFileSync(path.join(layout.missionsDir, 'm1', 'evidence.jsonl'), 'utf8').trim().split('\n')
    assert.equal(evidence.length, 2)
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm1', 'evidence-sources.jsonl')), true)
    // The worktrees are gone (import happened first, so the cleanup was allowed).
    assert.equal(fs.existsSync(splitWorktreeDir(layout, 'm1', 'T-001')), false)
    assert.equal(result.tasks.every((entry) => entry.cleanedUp), true)
    // ...and the runner recorded every task's state and commit.
    const record = runRecord(cwd)
    assert.equal(record.state, 'ran')
    assert.deepEqual(record.tasks.map((entry) => [entry.id, entry.state, entry.commit]), [
        ['T-001', 'done', commit1],
        ['T-002', 'done', commit2],
    ])
    assert.equal(record.imported, 2)
})

test('dependsOn is a gate, not a hint: a dependency runs first even when the plan lists its group last', async () => {
    const cwd = repo()
    // The plan lists T-002's group FIRST although T-002 depends on T-001: the
    // runner must order the groups topologically.
    mission(cwd, twoTasks([['T-002'], ['T-001']], { dependsOn: ['T-001'] }))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(1)
    assert.equal(workers.started[0]?.taskId, 'T-001', 'the dependency must start first')
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    await workers.waitFor(2)
    assert.equal(workers.started[1]?.taskId, 'T-002')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running
    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.deepEqual(result.tasks.map((entry) => entry.state), ['done', 'done'])
})

test('maxParallel=1 degrades one group to serial execution', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { maxParallel: 1 }))

    await workers.waitFor(1)
    // Give the scheduler a chance to (wrongly) start the second worker.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(workers.started.length, 1, 'with maxParallel=1 only one worker may run')
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    await workers.waitFor(2)
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running
    assert.equal(result.ok, true, result.problems.join(' | '))
})

test('a task whose dependency failed is NEVER started (AC-006 assertion inside the runner)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']], { dependsOn: ['T-001'] }))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(1)
    const worker = workers.started[0] as StartedWorker
    worker.reject(new Error('worker 崩溃了'))
    const result = await running

    assert.equal(workers.started.length, 1, 'the dependent task must not start')
    assert.equal(result.tasks[0]?.state, 'failed')
    assert.equal(result.tasks[1]?.state, 'blocked')
    assert.match(result.tasks[1]?.problems.join(' ') ?? '', /依赖 T-001 尚未完成|依赖 T-001 未完成/)
    assert.equal(result.ok, false)
})

// --- model routing (AC-011) ------------------------------------------------

test('above quality.maxReworkRatio the NEXT task switches to the planner model and the ratio is recorded (AC-011)', async () => {
    const cwd = repo()
    // Two groups, no dependency: T-001 fails first, then T-002 must be escalated.
    const plan = twoTasks([['T-001'], ['T-002']])
    mission(cwd, plan)
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(1)
    const first = workers.started[0] as StartedWorker
    assert.equal(first.spec.request?.agentOptions?.model, 'deepseek-chat', 'the first task runs on the worker model')
    first.reject(new Error('验收不过'))
    await workers.waitFor(2)
    const second = workers.started[1] as StartedWorker
    assert.equal(second.taskId, 'T-002')
    assert.equal(second.spec.request?.agentOptions?.model, 'deepseek-reasoner', 'the escalated task runs on the planner model')
    assert.equal(second.spec.request?.agentOptions?.provider, 'deepseek')
    assert.equal(second.spec.request?.agentOptions?.reasoningEffort, 'high')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.rework.started, 2)
    assert.equal(result.rework.reworked, 1)
    assert.equal(result.rework.ratio, 0.5)
    assert.equal(result.rework.threshold, 0.3)
    assert.equal(result.rework.escalate, true)
    assert.equal(result.tasks[1]?.modelClass, 'planner')
    // The ratio + threshold are in the mission's split report (AC-011).
    const stored = JSON.parse(fs.readFileSync(splitReworkFile(resolveLayout(cwd), 'm1'), 'utf8')) as { ratio: number; threshold: number }
    assert.equal(stored.ratio, 0.5)
    assert.equal(stored.threshold, 0.3)
    assert.equal(runRecord(cwd).tasks[1]?.state, 'done')
})

test('a worker model class with no configuration refuses the task instead of using a host default', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers, { models: models({ worker: {} }) }))

    assert.equal(workers.started.length, 0)
    assert.equal(result.tasks[0]?.state, 'failed')
    assert.match(result.problems.join('\n'), /不会回退宿主默认/)
    assert.equal(result.ok, false)
})

// --- the commit contract ---------------------------------------------------

test('a commit without the `<taskId>:` prefix is rework, named with the commit and its subject', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    const commit = finishWorker(workers, resolveLayout(cwd), 'T-001', { subject: 'feat: 忘了前缀' })
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.tasks[0]?.state, 'failed')
    assert.equal(result.tasks[0]?.commit, commit)
    assert.match(result.tasks[0]?.problems.join('\n') ?? '', /不带前缀 "T-001:"/)
    assert.match(result.tasks[0]?.problems.join('\n') ?? '', new RegExp(commit.slice(0, 12)))
    assert.deepEqual(result.tasks[0]?.signals, ['acceptance-failed'])
    // The unmerged, unimported rows keep the worktree alive (AC-009 in the runner).
    assert.equal(result.tasks[0]?.cleanedUp, false)
    assert.match(result.problems.join('\n'), /待导入/)
    assert.equal(result.ok, false)
    // The independent task still finished and was imported.
    assert.equal(result.tasks[1]?.state, 'done')
    assert.equal(result.imported, 1)
})

// --- refusals -------------------------------------------------------------

test('an UNREVIEWED plan is refused before any worktree or worker exists', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]), { review: 'none' })
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'refused')
    assert.match(result.problems.join('\n'), /还没有人工审核记录/)
    assert.equal(workers.started.length, 0)
    assert.equal(fs.existsSync(worktreeRoot(resolveLayout(cwd))), false, 'no worktree may be created')
    assert.equal(runRecord(cwd).state, 'refused')
})

test('a plan that is not worth splitting dispatches nobody and says so (AC-005)', async () => {
    const cwd = repo()
    const single: SplitPlan = {
        tasks: [{ id: 'T-001', goal: '全部', paths: ['src/**'], acceptance: ['AC-001'], dependsOn: [], parallel: false }],
        coverage: { 'AC-001': ['T-001'] },
        parallelGroups: [['T-001']],
    }
    mission(cwd, single)
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'not-worth-splitting')
    assert.equal(workers.started.length, 0)
    assert.match(result.warnings.join('\n'), /不值得拆分|少于 2 条/)
    assert.equal(fs.existsSync(worktreeRoot(resolveLayout(cwd))), false)
})

test('a task that depends on ITSELF is refused as a cycle, not treated as "no dependency"', async () => {
    const cwd = repo()
    const plan: SplitPlan = {
        tasks: [task('T-001', { dependsOn: ['T-001'] }), task('T-002')],
        coverage: { 'AC-001': ['T-001', 'T-002'] },
        parallelGroups: [['T-001'], ['T-002']],
    }
    mission(cwd, plan)
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'refused')
    assert.match(result.problems.join('\n'), /有环/)
    assert.match(result.problems.join('\n'), /T-001/)
    assert.equal(workers.started.length, 0)
})

test('a dependency cycle is refused and named (no worker is started)', async () => {
    const cwd = repo()
    const plan: SplitPlan = {
        tasks: [task('T-001', { dependsOn: ['T-002'] }), task('T-002', { dependsOn: ['T-001'] })],
        coverage: { 'AC-001': ['T-001', 'T-002'] },
        parallelGroups: [['T-001', 'T-002']],
    }
    mission(cwd, plan)
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'refused')
    assert.match(result.problems.join('\n'), /有环/)
    assert.match(result.problems.join('\n'), /T-001、T-002/)
    assert.equal(workers.started.length, 0)
})

test('a caller-passed plan that is not the one on disk is refused (digest mismatch)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const edited = twoTasks([['T-001', 'T-002']], { goal: '换了目标' })
    const result = await runSplitPlan(deps(cwd, workers, { plan: edited }))

    assert.equal(result.state, 'refused')
    assert.match(result.problems.join('\n'), /不一致/)
    assert.equal(workers.started.length, 0)
    // The plan on disk is untouched by the refusal.
    assert.equal(readSplitPlan(resolveLayout(cwd), 'm1')?.plan.tasks[1]?.goal, '做 T-002')
})

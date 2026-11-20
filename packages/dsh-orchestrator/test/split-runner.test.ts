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
import { defaultSplitWorktrees } from '../dist/split-run-git.js'
import { splitRunFile, splitReportFile, type SplitRunnerDeps, type SplitRoleGuard } from '../dist/split-run-types.js'

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

/** Resolve one worker WITHOUT committing: HEAD stays on the base commit. */
function finishWorkerWithoutCommit(workers: FakeWorkers, taskId: string): void {
    const worker = workers.started.find((entry) => entry.taskId === taskId && !entry.finished)
    assert.ok(worker !== undefined, `no pending worker for ${taskId}`)
    worker.resolve()
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
function runRecord(cwd: string): {
    state: string
    tasks: { id: string; state: string; commit?: string; base?: string; imported: number; cleanedUp: boolean; modelNote?: string }[]
    imported: number
    modelNotes?: string[]
} {
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
    // P3 AC-002: the single allowed attempt failed, so the task is
    // `needs-resplit` (not `failed`), and the successor is blocked NAMING it.
    assert.equal(result.tasks[0]?.state, 'needs-resplit')
    assert.equal(result.tasks[1]?.state, 'blocked')
    assert.match(result.tasks[1]?.problems.join(' ') ?? '', /依赖 T-001/)
    assert.match(result.problems.join(' '), /needs-resplit/)
    assert.match(result.problems.join(' '), /后继 T-002 一律 blocked/)
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

// P4 AC-001/AC-002: models.json is an OVERRIDE layer. "No model configured" means
// "use the host default" (the dispatch request omits model/provider), never a
// failed task — and it is never a rework signal either.

test('a worker model class with no configuration still dispatches on the host default, with a note (TC-2301)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: models({ worker: {} }) }))

    await workers.waitFor(2)
    assert.equal(workers.started.length, 2, 'a missing model must not stop the dispatch')
    const first = workers.started[0] as StartedWorker
    // Omitted, not emptied: the host decides, which is the whole point of an override layer.
    assert.equal(first.spec.request?.agentOptions?.model, undefined)
    assert.equal(first.spec.request?.agentOptions?.provider, undefined)
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.deepEqual(result.tasks.map((entry) => entry.state), ['done', 'done'])
    // The note is on the task record, at run level, and in the report projection.
    assert.equal(result.tasks[0]?.modelNote, 'worker 模型未配置，使用宿主默认')
    assert.deepEqual(result.modelNotes, ['worker 模型未配置，使用宿主默认'])
    const record = runRecord(cwd)
    assert.equal(record.tasks[0]?.modelNote, 'worker 模型未配置，使用宿主默认')
    assert.deepEqual(record.modelNotes, ['worker 模型未配置，使用宿主默认'])
    assert.deepEqual(reportRecord(cwd).modelNotes, ['worker 模型未配置，使用宿主默认'])
    // A missing model is not rework: it never becomes a failure signal.
    assert.equal(result.rework.ratio, 0)
})

test('with neither class configured every task runs on the host default and the summary says so (TC-2305)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: models({ worker: {}, planner: {} }) }))

    await workers.waitFor(2)
    assert.deepEqual(workers.started.map((entry) => entry.spec.request?.agentOptions?.model), [undefined, undefined])
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.deepEqual(result.tasks.map((entry) => entry.state), ['done', 'done'])
    // One sentence, not one per task: the summary says "all of it used the host default".
    assert.deepEqual(result.modelNotes, ['worker 模型未配置，使用宿主默认'])
    assert.match(result.modelNotes.join(' '), /使用宿主默认/)
})

test('a failing task still counts as rework while the missing model does not (TC-2306)', async () => {
    const cwd = repo()
    // Two groups so the first failure does not block the second task.
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: models({ worker: {}, planner: {}, quality: { maxReworkRatio: 1 } }) }))

    await workers.waitFor(1)
    ;(workers.started[0] as StartedWorker).reject(new Error('验收不过'))
    await workers.waitFor(2)
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    // Exactly ONE rework: the real failure. If "no model" were still counted, the
    // started tasks would both be reworked and the ratio would be 1.
    assert.equal(result.rework.started, 2)
    assert.equal(result.rework.reworked, 1)
    assert.equal(result.rework.ratio, 0.5)
    assert.deepEqual(result.tasks[0]?.signals, ['acceptance-failed'])
    assert.equal(result.tasks[0]?.modelNote, 'worker 模型未配置，使用宿主默认')
    assert.equal(result.tasks[1]?.state, 'done')
})

test('escalating without a planner model degrades to the worker model and warns, it does not fail (TC-2302)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: models({ planner: {} }) }))

    await workers.waitFor(1)
    assert.equal((workers.started[0] as StartedWorker).spec.request?.agentOptions?.model, 'deepseek-chat')
    ;(workers.started[0] as StartedWorker).reject(new Error('验收不过'))
    await workers.waitFor(2)
    const second = workers.started[1] as StartedWorker
    assert.equal(second.taskId, 'T-002')
    // Escalation was ASKED for and could not be granted: the task continues on the
    // worker class (which IS configured) instead of failing or stopping.
    assert.equal(second.spec.request?.agentOptions?.model, 'deepseek-chat')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.tasks[1]?.state, 'done')
    assert.equal(result.tasks[1]?.modelClass, 'planner')
    assert.equal(result.tasks[1]?.model, 'deepseek-chat')
    assert.equal(result.tasks[1]?.modelNote, '无法升级到 planner：未配置，继续使用 worker 模型')
    // The degradation is in the durable artifacts (TC-2302 asks for the report/warning).
    const rework = JSON.parse(fs.readFileSync(splitReworkFile(resolveLayout(cwd), 'm1'), 'utf8')) as { route?: { note?: string } }
    assert.equal(rework.route?.note, '无法升级到 planner：未配置，继续使用 worker 模型')
    assert.match(result.warnings.join('\n'), /无法升级到 planner：未配置/)
    assert.deepEqual(reportRecord(cwd).modelNotes, ['无法升级到 planner：未配置，继续使用 worker 模型'])
    assert.equal(result.ok, false, 'the first task really failed')
})

// --- the commit contract ---------------------------------------------------

test('a new commit without the `<taskId>:` prefix is rework, named with the diff set and its subjects', async () => {
    const cwd = repo()
    const base = git(cwd, ['rev-parse', 'HEAD'])
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    const commit = finishWorker(workers, resolveLayout(cwd), 'T-001', { subject: 'feat: 忘了前缀' })
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    // The attempt failed and exhausted the default `maxAttempts: 1` (AC-002):
    // `needs-resplit`, not `failed`, and the commit/subject are still named.
    assert.equal(result.tasks[0]?.state, 'needs-resplit')
    assert.equal(result.tasks[0]?.commit, commit)
    const problems = result.tasks[0]?.problems.join('\n') ?? ''
    // The NEW wording names the DIFF SET (base → HEAD), never the bare HEAD as
    // "the commit": the old text `commit <head> 的标题 … 不带前缀` is what judged a
    // base commit as the task's own output. Pinned exactly, in full.
    assert.deepEqual(result.tasks[0]?.problems, [
        `本次 1 个新提交里没有一个带 "T-001:" 前缀（base ${base.slice(0, 8)} → HEAD ${commit.slice(0, 8)}）：无法证明它属于子任务 T-001。新提交标题："feat: 忘了前缀"`,
    ])
    assert.doesNotMatch(problems, /不带前缀|commit [0-9a-f]{12}/)
    assert.deepEqual(result.tasks[0]?.signals, ['acceptance-failed'])
    // The unmerged, unimported rows keep the worktree alive (AC-009 in the runner).
    assert.equal(result.tasks[0]?.cleanedUp, false)
    assert.match(result.problems.join('\n'), /待导入/)
    assert.equal(result.ok, false)
    // The independent task still finished and was imported.
    assert.equal(result.tasks[1]?.state, 'done')
    assert.equal(result.imported, 1)
})

test('a worker that committed nothing is "no commit", even when the base is another plugin\'s session-end commit (TC-2803)', async () => {
    const cwd = repo()
    // The base is exactly the commit that named this bug: dsh-memory's auto-commit.
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'dsh-memory: project memory: session end'])
    const base = git(cwd, ['rev-parse', 'HEAD'])
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    finishWorkerWithoutCommit(workers, 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    // AC-002/AC-003: `0` new commits is its own failure — never "the subject has
    // no prefix" — and another plugin's subject is quoted nowhere.
    const problems = result.tasks[0]?.problems.join('\n') ?? ''
    assert.deepEqual(result.tasks[0]?.problems, [
        `worker 没有产生提交（HEAD 仍是基线 ${base.slice(0, 8)}）：无法证明这次任务做过任何事`,
    ])
    assert.doesNotMatch(problems, /dsh-memory|前缀/)
    assert.equal(result.tasks[0]?.state, 'needs-resplit')
    // The base commit is NOT recorded as this task's commit (the old code did).
    assert.equal(result.tasks[0]?.commit, undefined)
    assert.equal(result.tasks[0]?.base, base.slice(0, 8))
    // The gate is not relaxed: producing nothing still fails the task.
    assert.equal(result.ok, false)
    assert.equal(result.tasks[1]?.state, 'done')
    assert.equal(result.imported, 1, 'only T-002 landed')
})

test('a base commit whose subject LOOKS like the task\'s commit is still not the task\'s commit (AC-003)', async () => {
    const cwd = repo()
    // The base "wears the prefix": anything that read HEAD's subject would pass
    // this task although the worker did nothing at all.
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'T-001: 基线看起来像任务提交'])
    const base = git(cwd, ['rev-parse', 'HEAD'])
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    finishWorkerWithoutCommit(workers, 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.tasks[0]?.state, 'needs-resplit', 'the base title must never count as the task\'s commit')
    const problems = result.tasks[0]?.problems.join('\n') ?? ''
    assert.match(problems, new RegExp(`worker 没有产生提交（HEAD 仍是基线 ${base.slice(0, 8)}）`))
    assert.doesNotMatch(problems, /基线看起来像任务提交/)
})

test('a new commit with the `<taskId>:` prefix finishes the task, and run.json records the base it started on (TC-2801/TC-2805)', async () => {
    const cwd = repo()
    const base = git(cwd, ['rev-parse', 'HEAD'])
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    const commit = finishWorker(workers, resolveLayout(cwd), 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.tasks[0]?.state, 'done')
    assert.equal(result.tasks[0]?.commit, commit)
    // AC-001: every task record carries the base it started on, readable as a
    // short hash — both tasks started on the same main-tree HEAD.
    assert.deepEqual(
        runRecord(cwd).tasks.map((entry) => entry.base),
        [base.slice(0, 8), base.slice(0, 8)],
    )
})

test('among several new commits, one carrying the `<taskId>:` prefix is enough (TC-2802)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const layout = resolveLayout(cwd)
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(2)
    const worker = workers.started.find((entry) => entry.taskId === 'T-001')
    assert.ok(worker !== undefined)
    // The judgment is "ANY commit of base..HEAD carries it": a worker that writes
    // a plain commit first and the prefixed one second must not be reworked.
    const worktree = worktreeOf(worker)
    commitIn(worktree, 'feat: 先写实现')
    const commit = commitIn(worktree, 'T-001: 补上前缀')
    writeLocalEvidence(worktree, layout, 'T-001', commit)
    worker.resolve()
    finishWorker(workers, layout, 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.tasks[0]?.state, 'done')
    assert.equal(result.tasks[0]?.commit, commit)
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

// --- the deadline (AC-003) and the report (AC-005) -------------------------

/** The whole `split/report.json` of a mission (fails when it was not written). */
function reportRecord(cwd: string): {
    planDigest: string
    state: string
    modelNotes: string[]
    tasks: { id: string; modelClass: string | null; model: string | null; durationMs: number; attempts: number; reworkReasons: string[]; imported: number }[]
    rework: { ratio: number; threshold: number; escalate: boolean }
    parallelism: { maxParallel: number; groups: string[][] }
    economics: {
        tasks: { id: string; durationMs: number; prepareMs: number; attempts: number }[]
        serialEstimateMs: number
        wallClockMs: number
        speedup: number | null
        verdict: string
        reasons: string[]
        tokens: { state: string; reason: string }
    }
} {
    const file = splitReportFile(resolveLayout(cwd), 'm1')
    assert.equal(fs.existsSync(file), true, `missing ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as never
}

test('a worker past split.taskTimeoutMs is rework with a timeout signal, and its worktree + local ledger stay (TC-2103)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { taskTimeoutMs: 1 }))

    await workers.waitFor(2)
    const layout = resolveLayout(cwd)
    // Whatever the worker wrote before the deadline fired is the only copy of
    // that work: the run must not delete it.
    fs.writeFileSync(path.join(splitWorktreeDir(layout, 'm1', 'T-001'), 'worker-note.txt'), 'half done\n')
    const result = await running

    assert.equal(result.state, 'ran')
    // A deadline stop is retryable, but the default `maxAttempts: 1` was used up
    // (AC-002) — and the timeout rule of AC-003 (keep the worktree + ledger) still
    // wins over the cleanup step below.
    assert.deepEqual(result.tasks.map((entry) => entry.state), ['needs-resplit', 'needs-resplit'])
    assert.deepEqual(result.tasks.map((entry) => entry.signals), [['timeout'], ['timeout']])
    assert.match(result.problems.join('\n'), /超时/)
    // AC-003: the worktree and its local files stay for a later import/cleanup.
    assert.equal(fs.existsSync(splitWorktreeDir(layout, 'm1', 'T-001')), true)
    assert.equal(fs.readFileSync(path.join(splitWorktreeDir(layout, 'm1', 'T-001'), 'worker-note.txt'), 'utf8'), 'half done\n')
    assert.equal(result.tasks.every((entry) => entry.cleanedUp === false), true)
    // The timeout is in the durable records, not only in the returned object.
    const run = JSON.parse(fs.readFileSync(splitRunFile(layout, 'm1'), 'utf8')) as { tasks: { signals: string[]; cleanedUp: boolean }[] }
    assert.deepEqual(run.tasks.map((entry) => entry.signals), [['timeout'], ['timeout']])
    assert.deepEqual(run.tasks.map((entry) => entry.cleanedUp), [false, false])
    assert.deepEqual(reportRecord(cwd).tasks.map((entry) => entry.reworkReasons), [['timeout'], ['timeout']])
    assert.equal(result.ok, false)
})

test('a worker whose own failure merely mentions 超时 is NOT recorded as a timeout (signal honesty)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { taskTimeoutMs: 60_000 }))

    await workers.waitFor(2)
    const worker = workers.started[0] as StartedWorker
    worker.reject(new Error('上游返回 超时'))
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.deepEqual(result.tasks[0]?.signals, ['acceptance-failed'])
    assert.match(result.tasks[0]?.problems.join('\n') ?? '', /超时/)
})

test('report.json holds every per-task field and the REAL parallelism (TC-2105/TC-2110)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    let clock = 1_700_000_000_000
    const running = runSplitPlan(deps(cwd, workers, { maxParallel: 2, now: () => clock }))

    await workers.waitFor(2)
    const layout = resolveLayout(cwd)
    clock += 250
    finishWorker(workers, layout, 'T-001')
    // Let the runner's continuation record the first finish before moving the
    // clock: the durations are the assertion, so the test must not race them.
    await new Promise((resolve) => setTimeout(resolve, 20))
    clock += 250
    finishWorker(workers, layout, 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    const reportFile = splitReportFile(layout, 'm1')
    assert.equal(result.reportFile, reportFile)
    const report = reportRecord(cwd)
    assert.equal(report.state, 'ran')
    assert.equal(report.planDigest, result.planDigest)
    assert.deepEqual(report.parallelism, { maxParallel: 2, groups: [['T-001', 'T-002']] })
    assert.deepEqual(report.rework, { ratio: 0, threshold: 0.3, escalate: false })
    assert.deepEqual(report.tasks, [
        { id: 'T-001', modelClass: 'worker', model: 'deepseek-chat', durationMs: 250, attempts: 1, reworkReasons: [], imported: 1 },
        // Both tasks were dispatched together; the second one finished 250ms later.
        { id: 'T-002', modelClass: 'worker', model: 'deepseek-chat', durationMs: 500, attempts: 1, reworkReasons: [], imported: 1 },
    ])
})

test('report.json names the escalated model class when the rework ratio switches routes (TC-2110 / AC-011)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers))

    await workers.waitFor(1)
    ;(workers.started[0] as StartedWorker).reject(new Error('验收不过'))
    await workers.waitFor(2)
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.rework.escalate, true)
    const report = reportRecord(cwd)
    assert.equal(report.rework.ratio, 0.5)
    assert.equal(report.rework.escalate, true)
    assert.equal(report.tasks[0]?.modelClass, 'worker')
    assert.equal(report.tasks[1]?.modelClass, 'planner')
    assert.equal(report.tasks[1]?.model, 'deepseek-reasoner')
    assert.deepEqual(report.tasks[0]?.reworkReasons, ['acceptance-failed'])
})

test('a refused run still writes report.json, so "why nothing ran" is answerable from the artifacts', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]), { review: 'none' })
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'refused')
    const report = reportRecord(cwd)
    assert.equal(report.state, 'refused')
    assert.equal(report.parallelism.groups.length, 1)
    assert.deepEqual(report.tasks.map((entry) => entry.attempts), [0, 0])
})

// --- P3 AC-001: does the parallelism actually pay off? -----------------------

test('two tasks in one parallel group: economics says worth-parallel with speedup 2.00 (TC-2201)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    let clock = 1_700_000_000_000
    const running = runSplitPlan(deps(cwd, workers, { maxParallel: 2, now: () => clock }))

    await workers.waitFor(2)
    // Both workers finish at the same (fake) moment: 2 × 100ms of work in a
    // 100ms wall clock — the verdict must come out of the numbers, not the plan.
    clock += 100
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    const economics = reportRecord(cwd).economics
    assert.equal(economics.wallClockMs, 100)
    assert.equal(economics.serialEstimateMs, 200)
    assert.equal(economics.speedup, 2)
    assert.equal(economics.verdict, 'worth-parallel')
    assert.match(economics.reasons.join(' '), /并行值得/)
    assert.deepEqual(economics.tasks, [
        { id: 'T-001', durationMs: 100, prepareMs: 0, attempts: 1 },
        { id: 'T-002', durationMs: 100, prepareMs: 0, attempts: 1 },
    ])
})

test('the one-time worktree preparation is timed per task (prepareMs) and is part of the duration (AC-001)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001', 'T-002']]))
    const workers = fakeWorkers()
    let clock = 1_700_000_000_000
    // The real seam, with the clock moved by 40ms on each worktree creation: the
    // ONLY way "preparation cost" can be observed is by timing it around create.
    const real = defaultSplitWorktrees()
    const seam = {
        ...real,
        create: (input: Parameters<typeof real.create>[0]) => {
            clock += 40
            return real.create(input)
        },
    }
    const running = runSplitPlan(deps(cwd, workers, { maxParallel: 2, now: () => clock, worktrees: seam }))

    await workers.waitFor(2)
    clock += 100
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    const economics = reportRecord(cwd).economics
    assert.deepEqual(economics.tasks.map((entry) => entry.prepareMs), [40, 40])
    // T-001 started before its own create, T-002 only after T-001's: the durations
    // differ by exactly one preparation, and both include theirs.
    assert.deepEqual(economics.tasks.map((entry) => entry.durationMs), [180, 140])
    assert.equal(economics.serialEstimateMs, 320)
    assert.equal(economics.wallClockMs, 180)
    assert.equal(economics.speedup, 1.78)
    assert.equal(economics.verdict, 'worth-parallel')
    assert.match(economics.reasons.join(' '), /prepare 合计 80ms/)
})

test('a serial plan whose finishing overhead eats the gain is slower-than-serial, with the numbers (TC-2202)', async () => {
    const cwd = repo()
    // One task per group: the scheduler runs them one after the other.
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    let clock = 1_700_000_000_000
    const real = defaultSplitWorktrees()
    const seam = {
        ...real,
        // Merge/import/cleanup are real cost that a serial run would NOT avoid:
        // charging 60ms per merge is how "parallel lost to overhead" is observed.
        merge: (input: Parameters<typeof real.merge>[0]) => {
            clock += 60
            return real.merge(input)
        },
    }
    const running = runSplitPlan(deps(cwd, workers, { now: () => clock, worktrees: seam }))

    await workers.waitFor(1)
    clock += 100
    finishWorker(workers, resolveLayout(cwd), 'T-001')
    await workers.waitFor(2)
    clock += 100
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    const economics = reportRecord(cwd).economics
    assert.equal(economics.serialEstimateMs, 200)
    // 200ms of work + 2 merges × 60ms: the wall clock is worse than running the
    // same tasks one at a time with no finishing steps.
    assert.equal(economics.wallClockMs, 320)
    assert.equal(economics.speedup, 0.63)
    assert.equal(economics.verdict, 'slower-than-serial')
    assert.match(economics.reasons.join(' '), /并行反而更慢/)
    assert.match(economics.reasons.join(' '), /墙钟 320ms/)
})

test('a single-task plan is not worth splitting and its economics says unknown, naming why (TC-2210)', async () => {
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
    const economics = reportRecord(cwd).economics
    assert.equal(economics.verdict, 'unknown')
    assert.equal(economics.wallClockMs, 0)
    assert.equal(economics.speedup, null, 'no wall clock means no speedup — never a made-up 0')
    assert.match(economics.reasons.join(' '), /没有并行收益/)
    assert.deepEqual(economics.tasks, [{ id: 'T-001', durationMs: 0, prepareMs: 0, attempts: 0 }])
})

test('tokens are explicitly unavailable with a fixed reason and never a number (TC-2206)', async () => {
    const cwd = repo()
    // A refused run also writes the report, so the token contract holds for every
    // outcome — not only for a run that dispatched.
    mission(cwd, twoTasks([['T-001', 'T-002']]), { review: 'none' })
    const workers = fakeWorkers()
    const result = await runSplitPlan(deps(cwd, workers))

    assert.equal(result.state, 'refused')
    const economics = reportRecord(cwd).economics
    assert.deepEqual(economics.tokens, { state: 'unavailable', reason: '宿主 subagent 接缝不暴露 usage' })
    // The negative constraint, as an assertion: no digits anywhere in the field.
    assert.equal(/\d/.test(JSON.stringify(economics.tokens)), false, 'the host has no usage seam: a number here would be invented')
    // ...and measuring wrote no gate record (AC-005: a measurement decides nothing).
    assert.equal(fs.existsSync(path.join(resolveLayout(cwd).missionsDir, 'm1', 'gates')), false, 'economics must not write a gate')
})

// --- P3 AC-002: bounded retries and needs-resplit ---------------------------

/** The effective models of a retry test (maxAttempts + no escalation noise). */
function retryModels(maxAttempts: number): ModelsConfig {
    return models({
        split: { reviewRequired: true, maxTasks: 8, maxParallel: 3, maxReworkRounds: 2, maxAttempts },
        quality: { maxReworkRatio: 1 },
    })
}

test('maxAttempts=2: the first failure is retried in the SAME worktree and the second attempt succeeds (TC-2203)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: retryModels(2) }))

    await workers.waitFor(1)
    const first = workers.started[0] as StartedWorker
    assert.equal(first.taskId, 'T-001')
    const worktree = worktreeOf(first)
    first.reject(new Error('第一次没做完'))
    // The retry is a NEW activation of the SAME task, inside the SAME directory.
    await workers.waitFor(2)
    const retry = workers.started[1] as StartedWorker
    assert.equal(retry.taskId, 'T-001')
    assert.equal(worktreeOf(retry), worktree, 'a retry must reuse the task worktree')
    const commit = finishWorker(workers, resolveLayout(cwd), 'T-001')
    await workers.waitFor(3)
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.tasks[0]?.state, 'done')
    assert.equal(result.tasks[0]?.attempts, 2)
    assert.equal(result.tasks[0]?.commit, commit)
    // Every failed attempt counts as rework, even though the task finished (AC-002).
    assert.deepEqual(result.tasks[0]?.signals, ['acceptance-failed'])
    assert.equal(result.rework.reworked, 1)
    assert.equal(result.rework.started, 2)
    // The durable records carry the attempt count too.
    const report = reportRecord(cwd)
    assert.equal(report.tasks[0]?.attempts, 2)
    assert.equal(report.economics.tasks[0]?.attempts, 2)
    const run = JSON.parse(fs.readFileSync(splitRunFile(resolveLayout(cwd), 'm1'), 'utf8')) as { maxAttempts: number }
    assert.equal(run.maxAttempts, 2)
})

test('maxAttempts=2 and both attempts fail: exactly two dispatches, then needs-resplit (bounded, AC-002)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const running = runSplitPlan(deps(cwd, workers, { models: retryModels(2) }))

    await workers.waitFor(1)
    ;(workers.started[0] as StartedWorker).reject(new Error('第一次失败'))
    await workers.waitFor(2)
    ;(workers.started[1] as StartedWorker).reject(new Error('第二次失败'))
    await workers.waitFor(3)
    finishWorker(workers, resolveLayout(cwd), 'T-002')
    const result = await running

    assert.equal(result.tasks[0]?.state, 'needs-resplit')
    assert.equal(result.tasks[0]?.attempts, 2)
    // Bounded means bounded: no third activation of T-001, ever.
    assert.equal(workers.started.filter((entry) => entry.taskId === 'T-001').length, 2)
    assert.match(result.problems.join(' '), /用尽 2 次尝试仍失败/)
    assert.match(result.problems.join(' '), /第二次失败/)
    // The independent task still finished; only the exhausted one needs a re-split.
    assert.equal(result.tasks[1]?.state, 'done')
    assert.equal(result.ok, false)
})

test('retrying does NOT bypass "import before cleanup": an unimported row keeps the worktree (AC-002/AC-009)', async () => {
    const cwd = repo()
    mission(cwd, twoTasks([['T-001'], ['T-002']]))
    const workers = fakeWorkers()
    const layout = resolveLayout(cwd)
    const running = runSplitPlan(deps(cwd, workers, { models: retryModels(2) }))

    await workers.waitFor(1)
    const first = workers.started[0] as StartedWorker
    // The first attempt leaves a local evidence row (pointing at a commit that
    // will never be merged) and then fails.
    const unmerged = commitIn(worktreeOf(first), 'T-001: 第一次尝试')
    writeLocalEvidence(worktreeOf(first), layout, 'T-001', unmerged)
    first.reject(new Error('验收不过'))
    await workers.waitFor(2)
    ;(workers.started[1] as StartedWorker).reject(new Error('第二次还是失败'))
    await workers.waitFor(3)
    finishWorker(workers, layout, 'T-002')
    const result = await running

    assert.equal(result.tasks[0]?.state, 'needs-resplit')
    // The retry never removes anything, and the cleanup step still refuses while
    // that row is unimported — the discipline is structural, not a code path.
    assert.equal(result.tasks[0]?.cleanedUp, false)
    assert.equal(fs.existsSync(splitWorktreeDir(layout, 'm1', 'T-001')), true)
    assert.match(result.problems.join(' '), /待导入/)
    assert.equal(result.imported, 1, 'only T-002 rows landed')
})

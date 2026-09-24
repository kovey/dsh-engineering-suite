/**
 * dsh-quality-gate tests: config parsing, the three-state verdict, the
 * post-write lint loop (including its loop breaker) and the turn-stop gate.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'

const OK = 'node -e "console.log(\'ok\')"'
const FAIL = 'node -e "console.error(\'boom\'); process.exit(2)"'

function config(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logFile: 'quality-gate.log',
        commands: [
            { id: 'test', name: '单元测试', command: OK, required: true, phase: 'gate' },
            { id: 'lint', name: 'lint', command: FAIL, required: false, phase: 'lint' },
        ],
        ...extra,
    }
}

interface Steered {
    content: { text: string }[]
    source: { kind: string; plugin?: string; summary?: string }
}

function host(options: { cwd?: string; config?: Record<string, unknown> } = {}): FakeHost & { steers: Steered[] } {
    const cwd = options.cwd ?? tempWorkspace('quality-gate-')
    const fake = createFakeHost({ cwd })
    const steers: Steered[] = []
    const agent = fake.agent as unknown as { steer: (message: Steered) => void }
    agent.steer = (message: Steered) => steers.push(message)
    // Keep every log file inside the throwaway workspace: a relative path would
    // land in the package directory because that is the test process's cwd.
    const resolved = { ...(options.config ?? config()) }
    if (typeof resolved['logFile'] === 'string' && !path.isAbsolute(resolved['logFile'])) {
        resolved['logFile'] = path.join(cwd, resolved['logFile'])
    }
    apply(fake.ctx as never, resolved)
    return Object.assign(fake, { steers })
}

function turnStop(fake: FakeHost, turn = 1): Promise<void> {
    return fake.waterfall('agent/turn-stopping', { agent: fake.agent, turn, signal: new AbortController().signal }, () => undefined)
}

async function write(fake: FakeHost, toolName = 'write'): Promise<unknown> {
    const exec = { name: toolName, agent: fake.agent, callId: `call-${Math.random()}`, arguments: { file_path: 'src/a.ts' } }
    const result = { isError: false, content: [] }
    return await fake.waterfall('tools/post-execute', [exec, result], () => ({ kind: 'accept' }))
}

/** Create a committed git workspace (the fingerprint trigger needs a repo). */
function gitWorkspace(prefix: string): string {
    const cwd = tempWorkspace(prefix)
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    fs.writeFileSync(path.join(cwd, 'src.txt'), 'one\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    return cwd
}

/** Bind a fresh mission to the fake host's session. */
function bindMission(
    cwd: string,
    title: string,
    sessionId = 'session-1',
): { id: string; store: ReturnType<MissionStoreRegistry['for']> } {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId })
    store.bindSession(sessionId, mission.id)
    return { id: mission.id, store }
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-quality-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the tools, hooks and prompt section', () => {
    const fake = host()
    assert.deepEqual([...fake.tools.keys()].sort(), ['quality_gate_run', 'quality_gate_status'])
    assert.deepEqual(
        [...new Set([...fake.listeners.keys()])].sort(),
        ['agent/disposed', 'agent/turn-stopping', 'tools/post-execute'],
    )
    assert.match(fake.sectionText('eng:quality-gate'), /BLOCK/)
    fake.dispose()
    assert.equal(fake.tools.size, 0)
})

test('config defaults: gate commands are required, lint commands are optional', () => {
    const resolved = resolveConfig({
        commands: [
            { id: 'a', command: 'x' },
            { id: 'b', command: 'y', phase: 'lint' },
            { command: 'z' },
        ],
    })
    assert.deepEqual(
        resolved.commands.map((command) => [command.id, command.phase, command.required]),
        [
            ['a', 'gate', true],
            ['b', 'lint', false],
            ['cmd-3', 'gate', true],
        ],
    )
})

test('config rejects malformed entries and duplicate ids without throwing', () => {
    const problems: string[] = []
    const resolved = resolveConfig(
        {
            commands: [
                { id: 'a', command: 'x' },
                { id: 'a', command: 'dup' },
                { id: 'b' },
                'nonsense',
                { id: 'BAD ID', command: 'x' },
            ],
        },
        (message) => problems.push(message),
    )
    assert.deepEqual(
        resolved.commands.map((command) => command.id),
        ['a'],
    )
    assert.equal(problems.length, 4)
})

test('quality_gate_run returns PASS, records the gate and clears pending writes', async () => {
    const cwd = tempWorkspace('quality-gate-full-')
    const fake = host({
        cwd,
        config: config({
            commands: [
                { id: 'test', name: '单元测试', command: OK, required: true, phase: 'gate' },
                { id: 'lint', name: 'lint', command: OK, required: false, phase: 'lint' },
            ],
        }),
    })
    const stores = new MissionStoreRegistry().for(cwd)
    const mission = stores.create({ title: 'gate', cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', mission.id)

    await write(fake)
    // A *full* run (no `only`/`phase`): only this may clear the pending-write
    // counter, because only this covered every configured command.
    const run = await fake.runTool('quality_gate_run', {})
    const text = runText(run)
    assert.match(text, /质量门禁：PASS/)
    assert.equal(run.isError, false)

    const gate = stores.lastGate(mission.id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.equal(gate?.results.length, 2)
    assert.equal(gate?.scope?.full, true)
    // The gate run is also evidence.
    assert.ok(stores.readEvidence(mission.id).some((entry) => entry.kind === 'gate'))

    const status = runText(await fake.runTool('quality_gate_status', {}))
    assert.match(status, /latest gate: PASS/)
    assert.match(status, /pendingWrites=0/)
})

test('a failing required command yields BLOCK; only optional failures yield WARN', async () => {
    const cwd = tempWorkspace('quality-gate-verdict-')
    const fake = host({
        cwd,
        config: {
            logFile: 'quality-gate.log',
            commands: [
                { id: 'test', command: FAIL, required: true },
                { id: 'lint', command: FAIL, required: false, phase: 'lint' },
            ],
        },
    })
    const blocked = runText(await fake.runTool('quality_gate_run', { only: ['test'] }))
    assert.match(blocked, /质量门禁：BLOCK/)
    assert.match(blocked, /boom/)

    const warned = runText(await fake.runTool('quality_gate_run', { only: ['lint'] }))
    assert.match(warned, /质量门禁：WARN/)
})

test('the post-write lint loop reports an identical failure only once', async () => {
    const fake = host()
    const first = (await write(fake)) as { kind: string; feedback?: { text: string }[] }
    assert.equal(first.kind, 'block')
    assert.match(first.feedback?.[0]?.text ?? '', /写后 lint 未通过/)
    assert.match(first.feedback?.[0]?.text ?? '', /boom/)

    // Identical failure: repeating the same block would only burn the turn.
    const second = (await write(fake)) as { kind: string }
    assert.equal(second.kind, 'accept')
})

test('the lint loop caps corrective blocks per turn and re-arms on the next turn', async () => {
    const cwd = tempWorkspace('quality-gate-lintcap-')
    // A command whose output changes on every run, so each failure is a new
    // signature and the per-turn cap (not the signature) is what stops it.
    const varying = 'node -e "console.error(Date.now()); process.exit(1)"'
    const fake = host({
        cwd,
        config: {
            logFile: 'quality-gate.log',
            commands: [{ id: 'lint', command: varying, phase: 'lint', required: false }],
        },
    })
    assert.equal(((await write(fake)) as { kind: string }).kind, 'block')
    assert.equal(((await write(fake)) as { kind: string }).kind, 'block')
    assert.equal(((await write(fake)) as { kind: string }).kind, 'accept')

    await turnStop(fake, 2)
    assert.equal(((await write(fake)) as { kind: string }).kind, 'block')
})

test('the lint loop leaves non-write tools and failed tools alone', async () => {
    const fake = host()
    const readDecision = (await write(fake, 'read')) as { kind: string }
    assert.equal(readDecision.kind, 'accept')

    const exec = { name: 'write', agent: fake.agent, callId: 'c1', arguments: {} }
    const blocked = await fake.waterfall('tools/post-execute', [exec, { isError: true, content: [] }], () => ({ kind: 'accept' }))
    assert.equal((blocked as { kind: string }).kind, 'accept')

    // A downstream block is never overridden.
    const upstream = await fake.waterfall('tools/post-execute', [exec, { isError: false, content: [] }], () => ({
        kind: 'block',
        feedback: [{ type: 'text', text: 'other plugin' }],
    }))
    assert.equal((upstream as { kind: string }).kind, 'block')
})

test('the turn-stop gate does nothing without a write, and steers on BLOCK', async () => {
    const cwd = tempWorkspace('quality-gate-turnstop-')
    const fake = host({
        cwd,
        config: {
            logFile: 'quality-gate.log',
            commands: [{ id: 'test', command: FAIL, required: true }],
        },
    })
    const stores = new MissionStoreRegistry().for(cwd)
    const mission = stores.create({ title: 'turn stop', cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', mission.id)

    // No writes since the last run → the gate does not run at all.
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 0)
    assert.equal(stores.lastGate(mission.id), undefined)

    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 1)
    assert.match(fake.steers[0]?.content[0]?.text ?? '', /质量门禁未通过/)
    // Own source kind since 0.1.7 (the shared `plugin` kind is gone) + bounded notice.
    const source = fake.steers[0]?.source as { kind?: string; form?: string; summary?: string } | undefined
    assert.equal(source?.kind, 'dsh-quality-gate')
    assert.equal(source?.form, 'notice')
    assert.ok(String(source?.summary).length <= 120)
    assert.equal(stores.lastGate(mission.id)?.state, 'BLOCK')

    // The gate only reruns when something changed again...
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 1)

    // ...and the per-turn cap stops the loop even then.
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 2)
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 2)
})

test('a passing turn-stop gate records PASS and does not steer', async () => {
    const cwd = tempWorkspace('quality-gate-pass-')
    const fake = host({
        cwd,
        config: { logFile: 'quality-gate.log', commands: [{ id: 'test', command: OK, required: true }] },
    })
    const stores = new MissionStoreRegistry().for(cwd)
    const mission = stores.create({ title: 'pass', cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', mission.id)
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 0)
    assert.equal(stores.lastGate(mission.id)?.state, 'PASS')
})

test('an empty command list is reported instead of silently passing', async () => {
    const cwd = tempWorkspace('quality-gate-empty-')
    const fake = host({ cwd, config: { logFile: 'quality-gate.log', commands: [] } })
    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /没有配置任何门禁命令/)
    assert.match(fake.sectionText('eng:quality-gate'), /没有配置门禁命令/)
})

test('commands are never shell-interpreted', async () => {
    const cwd = tempWorkspace('quality-gate-noshell-')
    const marker = path.join(cwd, 'pwned')
    const fake = host({
        cwd,
        config: {
            logFile: 'quality-gate.log',
            commands: [{ id: 'evil', command: `node -e "console.log(1)" ; touch ${marker}`, required: true }],
        },
    })
    await fake.runTool('quality_gate_run', { only: ['evil'] })
    assert.equal(fs.existsSync(marker), false)
})

test('the host change budget blocks a runaway diff (docs.md §9)', async () => {
    const cwd = tempWorkspace('quality-gate-budget-')
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'c.txt'), 'c\n')

    const strict = host({
        cwd,
        config: {
            logFile: path.join(tempWorkspace('quality-gate-logs-'), 'q.log'),
            commands: [{ id: 'ok', command: OK, required: true }],
            limits: { maxChangedFiles: 1 },
        },
    })
    // The engineering trail itself must not count towards the budget.
    const stores = new MissionStoreRegistry().for(cwd)
    const mission = stores.create({ title: 'budget', cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', mission.id)
    const blocked = runText(await strict.runTool('quality_gate_run', {}))
    assert.match(blocked, /质量门禁：BLOCK/)
    assert.match(blocked, /limit-changed-files/)
    assert.match(blocked, /改动文件数 2（上限 1）/)

    const relaxed = host({
        cwd,
        config: {
            logFile: path.join(tempWorkspace('quality-gate-logs2-'), 'q.log'),
            commands: [{ id: 'ok', command: OK, required: true }],
            limits: { maxChangedFiles: 5 },
        },
    })
    assert.match(runText(await relaxed.runTool('quality_gate_run', {})), /质量门禁：PASS/)

    // Disabled by default and when the workspace is not a git repository.
    const off = host({ cwd, config: { logFile: 'quality-gate.log', commands: [{ id: 'ok', command: OK, required: true }] } })
    assert.match(runText(await off.runTool('quality_gate_run', {})), /质量门禁：PASS/)
    const noRepo = host({
        cwd: tempWorkspace('quality-gate-norepo-'),
        config: {
            logFile: path.join(tempWorkspace('quality-gate-logs3-'), 'q.log'),
            commands: [{ id: 'ok', command: OK, required: true }],
            limits: { maxChangedFiles: 3 },
        },
    })
    const failClosed = runText(await noRepo.runTool('quality_gate_run', {}))
    assert.match(failClosed, /不是 git 仓库/)
    assert.match(failClosed, /BLOCK/)
})

// --- regressions for the audit (coverage, shell edits, cancellation, caps) ----

const FULL_COMMANDS = [
    { id: 'test', name: '单元测试', command: OK, required: true, phase: 'gate' as const },
    { id: 'lint', name: 'lint', command: OK, required: false, phase: 'lint' as const },
]

test('a partial selection never clears pendingWrites and records scope.full === false (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-partial-')
    const fake = host({
        cwd,
        config: config({
            commands: [
                { id: 'test', name: '单元测试', command: FAIL, required: true, phase: 'gate' },
                { id: 'lint', name: 'lint', command: OK, required: false, phase: 'lint' },
            ],
        }),
    })
    const { id, store } = bindMission(cwd, 'partial run')

    await write(fake)
    // The host's required `test` command (exit 2) never ran, yet this run
    // reports PASS: the record must say so, and the turn-stop gate must still
    // have work to do afterwards.
    const text = runText(await fake.runTool('quality_gate_run', { only: ['lint'] }))
    assert.match(text, /覆盖范围：部分/)
    assert.match(text, /不构成完整的交付依据/)
    assert.match(text, /不能作为交付依据/)

    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.scope, { selected: ['lint'], total: 2, full: false })
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=1/)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /scope: 部分/)

    // A phase-restricted run is partial too.
    assert.match(runText(await fake.runTool('quality_gate_run', { phase: 'lint' })), /覆盖范围：部分/)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=1/)

    // ...so the turn-stop gate runs the *full* set and catches the required
    // command that never executed.
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 1)
    const blocking = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.equal(blocking?.state, 'BLOCK')
    assert.equal(blocking?.scope?.full, true)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=0/)
})

test('a full run records scope.full === true (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-scope-full-')
    const fake = host({ cwd, config: config({ commands: FULL_COMMANDS }) })
    const { id, store } = bindMission(cwd, 'full run')

    await write(fake)
    const text = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(text, /覆盖范围：完整（2\/2 个已配置命令）/)

    const gate = store.lastGate(id, { source: 'dsh-quality-gate' })
    assert.deepEqual(gate?.scope, { selected: ['test', 'lint'], total: 2, full: true })
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /scope: full/)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=0/)
})

test('a shell-only workspace change still triggers the turn-stop gate (regression)', async () => {
    const cwd = gitWorkspace('quality-gate-shell-')
    const fake = host({
        cwd,
        config: config({ commands: [{ id: 'test', name: '单元测试', command: OK, required: true, phase: 'gate' }] }),
    })
    const { id, store } = bindMission(cwd, 'shell edit')

    // A write-class call establishes the recorded fingerprint baseline.
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(store.readGates(id).length, 1)

    // Nothing any write hook can see: no pendingWrites, only a `sed -i`-style
    // change on disk. The diff digest moved, so the gate must run again.
    fs.appendFileSync(path.join(cwd, 'src.txt'), 'two\n')
    await turnStop(fake, 1)
    assert.equal(store.readGates(id).length, 2)
    assert.equal(store.lastGate(id, { source: 'dsh-quality-gate' })?.state, 'PASS')
    const log = fs.readFileSync(path.join(cwd, 'quality-gate.log'), 'utf8')
    assert.match(log, /收尾门禁 PASS（触发：fingerprint/)

    // Unchanged workspace (and no writes): the gate stays idle.
    await turnStop(fake, 1)
    assert.equal(store.readGates(id).length, 2)

    // Not a git repository → no digest to compare → the fallback is skipped.
    const plain = tempWorkspace('quality-gate-norepo-shell-')
    const noRepo = host({ cwd: plain, config: config({ commands: [{ id: 'test', command: OK, required: true }] }) })
    const noRepoMission = bindMission(plain, 'no repo')
    await turnStop(noRepo, 1)
    assert.equal(noRepoMission.store.readGates(noRepoMission.id).length, 0)
    assert.equal(noRepo.steers.length, 0)
})

test('a pre-aborted signal is a no-op: no gate record, no steer, pendingWrites unchanged (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-abort-')
    const fake = host({
        cwd,
        config: config({
            commands: [
                { id: 'test', name: '单元测试', command: FAIL, required: true, phase: 'gate' },
                { id: 'lint', name: 'lint', command: FAIL, required: false, phase: 'lint' },
            ],
        }),
    })
    const { id, store } = bindMission(cwd, 'cancelled turn')
    const aborted = new AbortController()
    aborted.abort()

    // The write hook: a cancelled turn must not even count a pending write.
    const decision = await fake.waterfall(
        'tools/post-execute',
        [{ name: 'write', agent: fake.agent, callId: 'c1', arguments: {}, signal: aborted.signal }, { isError: false, content: [] }],
        () => ({ kind: 'accept' }),
    )
    assert.equal((decision as { kind: string }).kind, 'accept')
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=0/)

    // The turn-stop gate: no commands, no record, no steer.
    await fake.waterfall('agent/turn-stopping', { agent: fake.agent, turn: 1, signal: aborted.signal }, () => undefined)
    assert.equal(fake.steers.length, 0)
    assert.equal(store.readGates(id).length, 0)

    // A normal write raises the counter; a cancelled explicit run must neither
    // record a verdict nor clear it.
    await write(fake)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=1/)
    const cancelled = runText(await fake.runTool('quality_gate_run', {}, { signal: aborted.signal }))
    assert.match(cancelled, /已取消/)
    assert.match(cancelled, /\(已取消，未记录\)/)
    assert.equal(store.readGates(id).length, 0)
    assert.match(runText(await fake.runTool('quality_gate_status', {})), /pendingWrites=1/)

    // A command killed by a mid-flight cancellation is not a verdict either.
    const slowCwd = tempWorkspace('quality-gate-abort-mid-')
    const slow = host({
        cwd: slowCwd,
        config: config({ commands: [{ id: 'slow', command: 'node -e "setTimeout(() => {}, 3000)"', required: true }] }),
    })
    const slowMission = bindMission(slowCwd, 'mid-run cancel')
    await write(slow)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 150)
    const midRun = runText(await slow.runTool('quality_gate_run', {}, { signal: controller.signal }))
    clearTimeout(timer)
    assert.match(midRun, /已取消/)
    assert.equal(slowMission.store.readGates(slowMission.id).length, 0)
    assert.match(runText(await slow.runTool('quality_gate_status', {})), /pendingWrites=1/)
})

test('maxBlocksPerTurn: 0 still records BLOCK but does not steer (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-cap0-')
    const fake = host({
        cwd,
        config: config({
            commands: [{ id: 'test', command: FAIL, required: true }],
            trigger: { turnStop: { enabled: true, maxBlocksPerTurn: 0 } },
        }),
    })
    const { id, store } = bindMission(cwd, 'cap zero')

    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 0)
    assert.equal(store.lastGate(id, { source: 'dsh-quality-gate' })?.state, 'BLOCK')
    assert.match(fs.readFileSync(path.join(cwd, 'quality-gate.log'), 'utf8'), /只记录不纠正/)

    // Only a negative cap is the no-op configuration: nothing runs at all.
    const offCwd = tempWorkspace('quality-gate-capneg-')
    const off = host({
        cwd: offCwd,
        config: config({
            commands: [{ id: 'test', command: FAIL, required: true }],
            trigger: { turnStop: { enabled: true, maxBlocksPerTurn: -1 } },
        }),
    })
    const offMission = bindMission(offCwd, 'cap negative')
    await write(off)
    await turnStop(off, 1)
    assert.equal(off.steers.length, 0)
    assert.equal(offMission.store.readGates(offMission.id).length, 0)
})

test('a session without header.cwd never runs host commands automatically (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-nocwd-')
    const marker = path.join(tempWorkspace('quality-gate-nocwd-marker-'), 'ran')
    const agent = { id: 'agent-x', session: { id: 'session-x', header: { id: 'session-x' } } }
    const fake = createFakeHost({ cwd, agent: agent as never })
    const steers: Steered[] = []
    ;(fake.agent as unknown as { steer: (message: Steered) => void }).steer = (message: Steered) => steers.push(message)
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'quality-gate.log'),
        commands: [
            { id: 'test', name: '单元测试', command: OK, required: true, phase: 'gate' },
            { id: 'lint', name: 'lint', command: `node -e "require('fs').writeFileSync('${marker}','x')"`, required: false, phase: 'lint' },
        ],
    })
    const { id, store } = bindMission(cwd, 'no cwd', 'session-x')

    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fs.existsSync(marker), false, 'no host command may run in the unknown directory')
    assert.equal(steers.length, 0)
    assert.equal(store.readGates(id).length, 0)

    // The explicit tool refuses too: "explicit" does not turn an unnamed
    // directory into a project (the run would be recorded against the wrong one).
    const explicit = await fake.runTool('quality_gate_run', { only: ['lint'] })
    assert.equal(explicit.isError, true)
    assert.match(String(explicit.content), /无法确定本会话的工作区/)
    assert.match(String(explicit.content), /header\.cwd/)
    assert.equal(fs.existsSync(marker), false, 'no host command may run from an unnamed workspace')

    // The warning is emitted once per session, not once per hook event.
    const log = fs.readFileSync(path.join(cwd, 'quality-gate.log'), 'utf8')
    assert.equal((log.match(/没有声明 header\.cwd/g) ?? []).length, 1)
    fake.dispose()
})

test('per-turn counters are keyed by session+mission (regression)', async () => {
    const cwd = tempWorkspace('quality-gate-permission-')
    const fake = host({
        cwd,
        config: config({
            commands: [{ id: 'test', command: FAIL, required: true }],
            trigger: { turnStop: { enabled: true, maxBlocksPerTurn: 1 } },
        }),
    })
    const stores = new MissionStoreRegistry().for(cwd)
    const first = stores.create({ title: 'first mission', cwd, sessionId: 'session-1' })
    const second = stores.create({ title: 'second mission', cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', first.id)

    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 1)

    // Same session and turn, different mission: its own bucket steers again.
    stores.bindSession('session-1', second.id)
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 2)

    // ...while the first mission's bucket stays exhausted.
    stores.bindSession('session-1', first.id)
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 2)

    // Disposal drops the counters (and the plugin teardown clears the rest).
    fake.emit('agent/disposed', { agent: fake.agent })
    stores.bindSession('session-1', first.id)
    await write(fake)
    await turnStop(fake, 1)
    assert.equal(fake.steers.length, 3)
})

test('a project-level config supplies the commands for ITS workspace (regression)', async () => {
    // One dsh process serves several repositories: the test command must come
    // from the workspace, not from the profile.
    const profileCommands = [{ id: 'profile-test', name: 'profile test', command: OK, required: true, phase: 'gate' as const }]
    const fake = host({ config: { logFile: path.join(tempWorkspace('qg-logs-'), 'q.log'), commands: profileCommands } })

    // Workspace A declares its own command set.
    const cwdA = tempWorkspace('qg-proj-a-')
    fs.mkdirSync(path.join(cwdA, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwdA, '.dsh', 'quality-gate.json'),
        JSON.stringify({
            commands: [
                { id: 'a-test', name: 'A 项目测试', command: OK, required: true, phase: 'gate' },
                { id: 'a-sub', name: 'A 子目录', command: OK, required: true, phase: 'gate', cwd: 'sub' },
            ],
            limits: { maxChangedFiles: 0 },
        }),
    )
    fs.mkdirSync(path.join(cwdA, 'sub'), { recursive: true })

    const agentA = { id: 'agent-a', session: { id: 'session-a', header: { id: 'session-a', cwd: cwdA } } }
    const runA = runText(await fake.runTool('quality_gate_run', {}, { agent: agentA }))
    assert.match(runA, /a-test/)
    assert.match(runA, /a-sub/)
    assert.doesNotMatch(runA, /profile-test/)
    assert.match(runA, /来源：.*quality-gate\.json/)

    // Workspace B has no project file → the profile commands apply unchanged.
    const cwdB = tempWorkspace('qg-proj-b-')
    const agentB = { id: 'agent-b', session: { id: 'session-b', header: { id: 'session-b', cwd: cwdB } } }
    const runB = runText(await fake.runTool('quality_gate_run', {}, { agent: agentB }))
    assert.match(runB, /profile-test/)
    assert.match(runB, /profile 配置/)

    const statusA = runText(await fake.runTool('quality_gate_status', {}, { agent: agentA }))
    assert.match(statusA, /命令来源：项目级配置/)
    assert.match(statusA, /a-test/)
})

test('a project-level config can refine but never weaken the gate (regression)', async () => {
    const cwd = tempWorkspace('qg-proj-guard-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({
            enabled: false, // host-only key: must be ignored
            logFile: '/tmp/evil.log', // host-only key: must be ignored
            rootDir: '/tmp', // host-only key: must be ignored
            commands: [{ id: 'proj', name: 'project test', command: FAIL, required: true, phase: 'gate' }],
        }),
    )
    const fake = host({ config: { logFile: path.join(tempWorkspace('qg-logs2-'), 'q.log'), commands: [{ id: 'profile', command: OK, required: true }] } })
    const agent = { id: 'a', session: { id: 's', header: { id: 's', cwd } } }
    const run = runText(await fake.runTool('quality_gate_run', {}, { agent }))
    // The forbidden keys were ignored (the gate still ran and still blocked).
    assert.match(run, /proj/)
    assert.match(run, /质量门禁：BLOCK/)
    assert.doesNotMatch(run, /profile/)
})

test('a malformed project config falls back to the profile instead of running nothing (regression)', async () => {
    const cwd = tempWorkspace('qg-proj-bad-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), '{ not json')
    const fake = host({ config: { logFile: path.join(tempWorkspace('qg-logs3-'), 'q.log'), commands: [{ id: 'profile', command: OK, required: true }] } })
    const agent = { id: 'a', session: { id: 's', header: { id: 's', cwd } } }
    const run = runText(await fake.runTool('quality_gate_run', {}, { agent }))
    assert.match(run, /profile/)
    assert.match(run, /质量门禁：PASS/)

    // An explicitly empty list is a human decision: honour it, but say so loudly.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    const empty = runText(await fake.runTool('quality_gate_run', {}, { agent }))
    assert.match(empty, /没有配置任何门禁命令|没有 .* 阶段的命令可执行/)
    assert.match(empty, /质量门禁：WARN/)
    assert.match(empty, /quality-gate\.json/)
})

test('the change budget follows the project config, not the profile (regression)', async () => {
    const cwd = tempWorkspace('qg-proj-limits-')
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd })
    execFileSync('git', ['config', 'user.name', 't'], { cwd })
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd })
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'c.txt'), 'c\n')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [{ id: 'ok', command: OK, required: true }], limits: { maxChangedFiles: 1 } }))
    const fake = host({ cwd, config: { logFile: path.join(tempWorkspace('qg-logs4-'), 'q.log'), commands: [] } })
    const run = runText(await fake.runTool('quality_gate_run', {}))
    assert.match(run, /质量门禁：BLOCK/)
    assert.match(run, /改动文件数 2（上限 1）/)
})

test('a project file whose keys were all refused reports the profile as the source (regression)', async () => {
    const cwd = tempWorkspace('qg-provenance-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ enabled: false, logFile: '/tmp/x.log', unknownKey: 1 }))
    const fake = host({
        cwd,
        config: { logFile: path.join(tempWorkspace('qg-logs5-'), 'q.log'), commands: [{ id: 'profile', command: OK, required: true }] },
    })
    const status = runText(await fake.runTool('quality_gate_status', {}))
    assert.match(status, /命令来源：profile 配置/)
    assert.doesNotMatch(status, /命令来源：项目级/)
    assert.match(status, /配置问题/)
})

test('the prompt section lists the workspace\'s own commands (regression)', async () => {
    const profileLog = path.join(tempWorkspace('qg-prompt-logs-'), 'q.log')
    const fake = host({ config: { logFile: profileLog, commands: [{ id: 'profile-test', command: OK, required: true }] } })
    const cwdA = tempWorkspace('qg-prompt-a-')
    fs.mkdirSync(path.join(cwdA, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwdA, '.dsh', 'quality-gate.json'),
        JSON.stringify({ commands: [{ id: 'cargo-test', name: 'cargo test', command: 'cargo test', required: true }] }),
    )
    const section = (fake.sections.find((entry) => entry.name === 'eng:quality-gate') ?? {}) as { text: (assemble?: unknown) => string }
    const agentA = { id: 'a', session: { id: 's', header: { id: 's', cwd: cwdA } } }
    const textA = section.text({ scope: agentA })
    const textProfile = section.text({ scope: fake.agent })
    assert.match(textA, /cargo test/)
    assert.match(textA, /项目级配置/)
    assert.doesNotMatch(textA, /profile-test/)
    assert.match(textProfile, /profile-test/)
    assert.doesNotMatch(textProfile, /项目级配置/)
})

test('with logFileTemplate each workspace logs to its own file (regression)', async () => {
    // Several repositories in one dsh process: interleaved lines make a failure
    // impossible to follow, so the host may ask for per-workspace files.
    const dir = tempWorkspace('qg-logsplit-')
    const fake = host({
        config: {
            logFile: path.join(dir, 'quality-gate.log'),
            logFileTemplate: path.join(dir, 'logs', '{project}', 'quality-gate.log'),
            commands: [{ id: 'ok', command: OK, required: true }],
        },
    })
    const wsA = tempWorkspace('qg-logsplit-a-')
    const wsB = tempWorkspace('qg-logsplit-b-')
    const agentA = { id: 'a', session: { id: 'sa', header: { id: 'sa', cwd: wsA } } }
    const agentB = { id: 'b', session: { id: 'sb', header: { id: 'sb', cwd: wsB } } }
    await fake.runTool('quality_gate_run', {}, { agent: agentA })
    await fake.runTool('quality_gate_run', {}, { agent: agentB })

    const logs = fs.readdirSync(path.join(dir, 'logs'))
    assert.equal(logs.length, 2, `expected one directory per workspace, got ${logs.join(', ')}`)
    const [first, second] = logs.map((name) => fs.readFileSync(path.join(dir, 'logs', name, 'quality-gate.log'), 'utf8'))
    assert.match(first ?? '', /quality_gate_run: PASS/)
    assert.match(second ?? '', /quality_gate_run: PASS/)
    // Each file carries exactly its own workspace's lines; the `[project]` tag on
    // every line says which project a file belongs to.
    const texts = logs.map((name) => fs.readFileSync(path.join(dir, 'logs', name, 'quality-gate.log'), 'utf8'))
    const aText = texts.find((text) => text.includes(`[${path.basename(wsA)}]`)) ?? ''
    const bText = texts.find((text) => text.includes(`[${path.basename(wsB)}]`)) ?? ''
    assert.notEqual(aText, '', `slugs: ${logs.join(', ')}`)
    assert.equal((aText.match(/quality_gate_run: /g) ?? []).length, 1)
    assert.equal((bText.match(/quality_gate_run: /g) ?? []).length, 1)
    // The shared file keeps only the unattributable lines (assembly here).
    const shared = fs.readFileSync(path.join(dir, 'quality-gate.log'), 'utf8')
    assert.doesNotMatch(shared, /quality_gate_run: /)
    assert.match(shared, /applied \(/)
})

/**
 * Unit tests for dsh-suite-doctor.
 *
 * The plugin is one read-only tool over two halves (eng-core's offline doctor +
 * the runtime probe), so the tests are about three things:
 *
 *  1. the tool answers with the facts the host actually has — mounted plugins,
 *     the session mission, interaction channels;
 *  2. it stays honest where a fact is missing: `partial` for a plugin that is
 *     mounted but no longer exposes its signature tool, `unknown` (never `ok`)
 *     when a runtime fact cannot be read, and the phases this build does not
 *     implement at all;
 *  3. it is READ-ONLY and refuses to guess a workspace or a mission id.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { MissionStoreRegistry, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name, resolveConfig, resolveEffectiveConfig } from '../dist/index.js'
import { registerTools } from '../dist/tools.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

/** A log file OUTSIDE the workspace: the byte-identical test snapshots the repo. */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-doctor-log-'), 'suite-doctor.log')
}

/** Assemble the plugin in a throwaway workspace. */
function host(cwd: string, config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: logFileFor(), ...config })
    return fake
}

/** Register fake tool definitions so the plugin's probes see them as mounted. */
function mount(fake: FakeHost, ...names: string[]): void {
    for (const name of names) {
        fake.tools.set(name, { name, description: `fake ${name}`, parameters: {}, execute: async () => '' })
    }
}

/** The seven plugins eng-core's withRuntime() requires. */
const CORE_TOOLS = ['team_delegate', 'spec_create', 'test_design_review', 'quality_gate_run', 'evidence_status', 'audit_report', 'orchestrate']

/** A repo with a git identity so `git check-ignore` works. */
function repo(options: { ignoreTrail?: boolean } = {}): string {
    const cwd = tempWorkspace('suite-doctor-')
    execFileSync('git', ['init', '-q'], { cwd })
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    if (options.ignoreTrail === true) fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    return cwd
}

/** The two required config files a "healthy setup" needs. */
function configure(cwd: string): void {
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({ commands: [{ id: 'test', name: '单元测试', command: 'go test ./...', required: true, phase: 'gate' }] }),
    )
    fs.writeFileSync(path.join(cwd, '.dsh', 'evidence-gate.json'), JSON.stringify({ requiredEvidenceKinds: ['command', 'test'] }))
}

/** Parse the tool's JSON answer. */
function reportOf(run: { value: unknown }): Record<string, never> & {
    blockers: { id: string; state: string; label: string; fix?: string; severity: string }[]
    advice: { id: string; state: string; label: string }[]
    checks: { id: string; state: string; label: string; detail: string; fix?: string; severity: string }[]
    runtime?: {
        mountedPlugins?: string[]
        registeredTools?: string[]
        mission?: { id: string; status: string; stage?: string; blocked: boolean; specApproved: boolean; lastGate?: { state: string } }
        channels?: { name: string; canAsk: boolean }[]
    }
} {
    return JSON.parse(String(run.value)) as never
}

/** Every file under `dir`, content-hashed: "byte-identical" means this map. */
function snapshot(dir: string): Record<string, string> {
    const files: Record<string, string> = {}
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (!entry.isFile()) continue
            files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
    }
    if (fs.existsSync(dir)) walk(dir)
    return files
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-suite-doctor')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('suite_status registers, and disposing the plugin removes it', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd)
    assert.ok(fake.tools.has('suite_status'), 'suite_status must be registered')
    const run = await fake.runTool('suite_status', {})
    assert.equal(run.isError, false, runText(run))
    fake.dispose()
    assert.equal(fake.tools.has('suite_status'), false, 'dispose must unregister the tool')
})

test('a configured workspace with the core plugins mounted reports zero blockers', async () => {
    const cwd = repo({ ignoreTrail: true })
    configure(cwd)
    const fake = host(cwd)
    mount(fake, ...CORE_TOOLS)
    const run = await fake.runTool('suite_status', { json: true })
    assert.equal(run.isError, false, runText(run))
    const report = reportOf(run)
    assert.deepEqual(
        report.blockers.map((check) => [check.id, check.detail]),
        [],
        'a configured workspace with every core plugin usable has no blocker',
    )
    assert.equal(report.checks.find((check) => check.id === 'config.quality-gate')?.state, 'ok')
    assert.match(report.checks.find((check) => check.id === 'config.quality-gate')?.detail ?? '', /1 条命令（1 条 required）/)
    assert.equal(report.checks.find((check) => check.id === 'runtime.mounts')?.state, 'ok')
    // The four gates outside eng-core's required seven are advice, not blockers.
    assert.equal(report.checks.find((check) => check.id === 'runtime.plugin.standards-gate')?.state, 'missing')
    assert.equal(report.checks.find((check) => check.id === 'runtime.plugin.standards-gate')?.severity, 'recommended')
    assert.deepEqual(report.runtime?.mountedPlugins, [
        'role-guard',
        'spec-gate',
        'test-design-gate',
        'quality-gate',
        'evidence-gate',
        'audit-trail',
        'orchestrator',
    ])
    assert.ok(report.runtime?.registeredTools?.includes('spec_create'))
})

test('a bare workspace reports blockers, each naming the exact fix', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const run = await fake.runTool('suite_status', { json: true })
    const report = reportOf(run)
    const ids = report.blockers.map((check) => check.id)
    for (const expected of ['config.quality-gate', 'config.evidence-gate', 'ledger.gitignore', 'runtime.mounts']) {
        assert.ok(ids.includes(expected), `expected blocker ${expected}: ${JSON.stringify(ids)}`)
    }
    for (const check of report.blockers) {
        assert.ok(check.fix !== undefined && check.fix !== '', `${check.id} must name its fix`)
    }
    // An unmounted core plugin is a per-plugin blocker with a bundle fix.
    const quality = report.checks.find((check) => check.id === 'runtime.plugin.quality-gate')
    assert.equal(quality?.state, 'missing')
    assert.equal(quality?.severity, 'required')
    assert.match(quality?.fix ?? '', /dsh-quality-gate/)
    const text = runText(await fake.runTool('suite_status', {}))
    assert.match(text, /# 套件自检/)
    assert.match(text, /→ 下一步：/)
})

test('a fake host with a mission reports the runtime mission check', async () => {
    const cwd = repo({ ignoreTrail: true })
    configure(cwd)
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '自检任务', cwd, id: 'M-1' })
    store.bindSession('session-1', 'M-1')
    store.update('M-1', () => ({ status: 'verified', stage: 'test' }))
    store.recordGate('M-1', { source: 'dsh-quality-gate', state: 'PASS', reason: '全部通过', results: [] })
    const fake = host(cwd)
    mount(fake, ...CORE_TOOLS)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'runtime.mission')
    assert.equal(check?.state, 'ok')
    assert.match(check?.label ?? '', /M-1/)
    assert.match(check?.detail ?? '', /阶段 test/)
    assert.match(check?.detail ?? '', /规格未审批/)
    assert.match(check?.detail ?? '', /最近门禁 PASS/)
    assert.equal(report.runtime?.mission?.id, 'M-1')
    assert.equal(report.runtime?.mission?.stage, 'test')
    assert.equal(report.runtime?.mission?.blocked, false)
    assert.equal(report.runtime?.mission?.specApproved, false)
})

test('a blocked mission is a blocker whose fix is unblock (the latch needs a human)', async () => {
    const cwd = repo({ ignoreTrail: true })
    configure(cwd)
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '熔断任务', cwd, id: 'M-2' })
    store.bindSession('session-1', 'M-2')
    store.setStatus('M-2', 'blocked')
    const fake = host(cwd)
    mount(fake, ...CORE_TOOLS)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'runtime.mission')
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.fix ?? '', /unblock/)
    assert.ok(report.blockers.some((entry) => entry.id === 'runtime.mission'))
})

test('an interaction service with channels lists them, and pending asks are timed', async () => {
    const cwd = repo({ ignoreTrail: true })
    // The shape dsh-interaction-gate documents for the doctor: describeAll() +
    // pending() + ledgers() + problems().
    const fake = host(cwd, {}, {
        interaction: {
            describeAll: () => [
                { name: 'feishu', canAsk: true, canNotify: true, reason: 'ok', order: 0 },
                { name: 'terminal', canAsk: false, canNotify: true, reason: '未实现 wait()，只能推送不能收答案', order: 1 },
            ],
            pending: () => [{ id: 'A-1', questionId: 'q-1', title: '规格审批', at: Date.now() - 7 * 60_000 }],
            ledgers: () => ['/tmp/interaction.jsonl'],
            problems: () => [],
        },
    })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const channels = report.checks.find((check) => check.id === 'runtime.channels')
    assert.equal(channels?.state, 'ok')
    assert.match(channels?.detail ?? '', /feishu/)
    assert.equal(report.runtime?.channels?.length, 2)
    // The reason a channel cannot ask is what makes the gap actionable.
    const capability = report.checks.find((check) => check.id === 'runtime.channel-capability')
    assert.equal(capability?.state, 'partial')
    assert.match(capability?.detail ?? '', /terminal：未实现 wait\(\)/)
    const pending = report.checks.find((check) => check.id === 'runtime.pending-asks')
    assert.equal(pending?.state, 'partial')
    assert.match(pending?.detail ?? '', /已等 7 分钟/)
    assert.equal(report.checks.find((check) => check.id === 'runtime.interaction-problems'), undefined)
})

test('an empty pending() with no observed ledger is unknown, never "nobody is waiting"', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, {}, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => [],
        },
    })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const pending = report.checks.find((check) => check.id === 'runtime.pending-asks')
    assert.equal(pending?.state, 'unknown')
    assert.match(pending?.detail ?? '', /不等于"没有人在等回答"/)
    assert.match(pending?.detail ?? '', /还没有观察到任何交互台账/)
    assert.match(pending?.fix ?? '', /interaction_status/)
})

test('an empty pending() with observed ledgers is a real "nobody is waiting" (no check)', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, {}, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
        },
    })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    assert.equal(report.checks.find((check) => check.id === 'runtime.pending-asks'), undefined)
})

test('the older describe() vocabulary still answers, and channel defects are reported', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, {}, {
        interaction: {
            describe: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pendingAsks: () => [{ id: 'A-2', title: '部署确认', at: Date.now() }],
            problems: () => ['通道 "dup" 被拒绝：名称重复'],
        },
    })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    assert.equal(report.checks.find((check) => check.id === 'runtime.channels')?.state, 'ok')
    const defects = report.checks.find((check) => check.id === 'runtime.interaction-problems')
    assert.equal(defects?.state, 'partial')
    assert.match(defects?.detail ?? '', /名称重复/)
})

test('with no interaction service the channel fact is unknown, never ok', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const channels = report.checks.find((check) => check.id === 'runtime.channels')
    assert.equal(channels?.state, 'unknown')
    assert.match(channels?.detail ?? '', /没有挂载名为 interaction 的服务/)
    assert.match(channels?.detail ?? '', /不等于"没有通道"/)
    assert.equal(report.runtime?.channels, undefined, 'a fact that could not be read must not be reported as an empty list')
    assert.equal(report.checks.find((check) => check.id === 'runtime.pending-asks')?.state, 'unknown')
})

test('a plugin mounted through its service but exposing no tool is partial, not ok', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, {}, { 'role-guard': { delegate: () => undefined } })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'runtime.plugin.role-guard')
    assert.equal(check?.state, 'partial')
    assert.match(check?.detail ?? '', /已挂载但不完整/)
    assert.match(check?.detail ?? '', /服务 role-guard/)
    assert.ok(check?.fix !== undefined && check.fix !== '')
    // Its capability is not usable, so it must not count as mounted for the
    // required aggregate check either.
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.mounts')?.state, 'missing')
    assert.equal(report.runtime?.mountedPlugins?.includes('role-guard'), false)
})

test('a plugin whose signature tool is missing is partial while a sibling tool proves it is loaded', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd)
    mount(fake, 'standards_status')
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const check = report.checks.find((entry) => entry.id === 'runtime.plugin.standards-gate')
    assert.equal(check?.state, 'partial')
    assert.match(check?.detail ?? '', /tool:standards_status/)
    assert.match(check?.detail ?? '', /tool:standards_check/)
})

test('a plugin with no evidence at all is missing, and only the expected ones are probed', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd)
    mount(fake, 'spec_create')
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.plugin.spec-gate')?.state, 'ok')
    const missing = report.checks.find((entry) => entry.id === 'runtime.plugin.orchestrator')
    assert.equal(missing?.state, 'missing')
    assert.match(missing?.fix ?? '', /dsh-orchestrator/)
    assert.equal(report.checks.filter((entry) => entry.id.startsWith('runtime.plugin.')).length, 11)
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.phases'), undefined, 'all six phases are implemented today')
})

test('a phase whose plugins are outside the configured build is reported, not silently ok', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, { expectedPlugins: ['spec-gate'] })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const phases = report.checks.find((entry) => entry.id === 'runtime.phases')
    assert.equal(phases?.state, 'unknown')
    assert.match(phases?.detail ?? '', /实现/)
    assert.match(phases?.detail ?? '', /部署/)
    assert.equal(report.checks.filter((entry) => entry.id.startsWith('runtime.plugin.')).length, 1)
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.plugin.quality-gate'), undefined)
})

test('suite_status is read-only: the workspace is byte-identical afterwards', async () => {
    const cwd = repo({ ignoreTrail: true })
    configure(cwd)
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '只读检查', cwd, id: 'M-3' })
    store.bindSession('session-1', 'M-3')
    const fake = host(cwd, {}, { interaction: { describe: () => [{ name: 'feishu', canAsk: true, canNotify: true }] } })
    mount(fake, ...CORE_TOOLS)
    const before = { dsh: snapshot(path.join(cwd, '.dsh')), root: fs.readdirSync(cwd).sort() }
    const text = await fake.runTool('suite_status', {})
    const json = await fake.runTool('suite_status', { json: true })
    assert.equal(text.isError, false, runText(text))
    assert.equal(json.isError, false, runText(json))
    const after = { dsh: snapshot(path.join(cwd, '.dsh')), root: fs.readdirSync(cwd).sort() }
    assert.deepEqual(after, before, 'suite_status must not write anything (no gate record, no artifact, no mission update)')
    // The strongest form: a workspace WITHOUT a ledger must not grow one.
    const bare = tempWorkspace('suite-doctor-bare-')
    const bareHost = host(bare)
    mount(bareHost, ...CORE_TOOLS)
    const run = await bareHost.runTool('suite_status', {})
    assert.equal(run.isError, false, runText(run))
    assert.equal(fs.existsSync(path.join(bare, '.dsh')), false, 'a read-only check must not create the ledger directory')
})

test('json: true returns parseable JSON whose blockers are the text report results', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const text = runText(await fake.runTool('suite_status', {}))
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    assert.ok(report.blockers.length > 0, 'a bare workspace has blockers')
    assert.match(text, new RegExp(`必需项 ${report.blockers.length} 项未就绪`))
    for (const blocker of report.blockers) {
        assert.ok(text.includes(blocker.label), `the text report must carry "${blocker.label}"`)
    }
    const textRun = await fake.runTool('suite_status', {})
    assert.equal(runText(textRun), text, '两次调用之间工作区没有变化，文本判定必须逐字一致')
})

test('the prompt section registers, explains the four states, and is disposed', () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, { prompt: { order: 605 } })
    assert.ok(
        fake.sections.some((section) => section.name === 'eng:suite-doctor' && section.order === 605),
        'the prompt section must be registered with its order',
    )
    const text = fake.sectionText('eng:suite-doctor')
    assert.match(text, /suite_status/)
    assert.match(text, /❔/)
    assert.match(text, /`unknown` 不是通过/)
    assert.match(text, /role-guard/)
    fake.dispose()
    assert.equal(fake.sections.length, 0, 'dispose must drop the section')
})

test('a session without a workspace is refused instead of reporting on process.cwd()', async () => {
    const fake = createFakeHost({
        cwd: tempWorkspace('suite-doctor-nocwd-'),
        agent: { id: 'agent-1', session: { id: 'session-1', header: { id: 'session-1', cwd: '' } } },
    })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: logFileFor() })
    const run = await fake.runTool('suite_status', {})
    assert.equal(run.isError, true)
    assert.match(runText(run), /无法确定工作区/)
})

test('an unknown missionId is refused (fail closed), not silently ignored', async () => {
    const cwd = repo({ ignoreTrail: true })
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '存在的任务', cwd, id: 'M-4' })
    const fake = host(cwd)
    const run = await fake.runTool('suite_status', { missionId: 'M-404' })
    assert.equal(run.isError, true)
    assert.match(runText(run), /未知 mission "M-404"/)
    assert.match(runText(run), /M-4/)
    const ok = await fake.runTool('suite_status', { missionId: 'M-4', json: true })
    assert.equal(ok.isError, false, runText(ok))
    assert.equal(reportOf(ok).runtime?.mission?.id, 'M-4')
})

test('a cancelled call reports nothing (exec.signal is observed)', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd)
    const run = await fake.runTool('suite_status', {}, { signal: AbortSignal.abort() })
    assert.equal(run.isError, true)
    assert.match(runText(run), /已被取消/)
})

test('a project file may widen the expected set, and the tool probes what it added', async () => {
    const cwd = repo({ ignoreTrail: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'suite-doctor.json'), JSON.stringify({ expectedPlugins: ['deploy-gate'] }))
    const fake = host(cwd)
    mount(fake, 'deploy_plan')
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.plugin.deploy-gate')?.state, 'ok')
    assert.equal(
        report.checks.filter((entry) => entry.id.startsWith('runtime.plugin.')).length,
        12,
        'the eleven profile plugins plus the one the repository added',
    )
    // The deploy phase is now implemented by the plugin the repository declared.
    assert.equal(report.checks.find((entry) => entry.id === 'runtime.phases'), undefined)
})

test('the optional phase-completing bundles are advice, never blockers', async () => {
    const cwd = repo({ ignoreTrail: true })
    configure(cwd)
    const fake = host(cwd)
    mount(fake, ...CORE_TOOLS)
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const optional = report.checks.find((check) => check.id === 'runtime.mounts-optional')
    assert.equal(optional?.severity, 'recommended')
    // interaction-gate + deploy-gate are absent; suite-doctor's own tool is
    // visible (a running plugin cannot observe its own absence).
    assert.equal(optional?.state, 'partial')
    assert.match(optional?.detail ?? '', /interaction-gate（补全"交互"阶段；未装载）/)
    assert.match(optional?.detail ?? '', /审批只能走宿主 approval 接缝/)
    assert.match(optional?.detail ?? '', /deploy-gate（补全"部署"阶段；未装载）/)
    assert.match(optional?.detail ?? '', /不产生部署门禁记录/)
    assert.match(optional?.fix ?? '', /dsh\.profile\.bundles/)
    assert.equal(report.blockers.some((check) => check.id === 'runtime.mounts-optional'), false)
    assert.ok(report.advice.some((check) => check.id === 'runtime.mounts-optional'))
})

test('promoting an optional bundle into expectedPlugins makes it a required finding', async () => {
    const cwd = repo({ ignoreTrail: true })
    const fake = host(cwd, { expectedPlugins: ['deploy-gate'] })
    const report = reportOf(await fake.runTool('suite_status', { json: true }))
    const promoted = report.checks.find((check) => check.id === 'runtime.plugin.deploy-gate')
    assert.equal(promoted?.state, 'missing')
    assert.equal(promoted?.severity, 'required')
    assert.ok(report.blockers.some((check) => check.id === 'runtime.plugin.deploy-gate'))
    // Promoted means "the per-plugin check owns it": it leaves the advice list.
    const optional = report.checks.find((check) => check.id === 'runtime.mounts-optional')
    assert.doesNotMatch(optional?.detail ?? '', /deploy-gate/)
    assert.match(optional?.detail ?? '', /interaction-gate/)
})

test('the project file may only tighten: expectedPlugins is unioned, unusable values keep the profile value', () => {
    const cwd = tempWorkspace('suite-doctor-config-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'suite-doctor.json'),
        JSON.stringify({
            expectedPlugins: ['spec-gate', 'my-own-plugin'],
            probeTimeoutMs: -1,
            enabled: false,
            layout: { rootDir: 'elsewhere' },
        }),
    )
    const problems: string[] = []
    const effective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(cwd), { warn: (message) => problems.push(message) })
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.enabled, true, 'a project may not switch the doctor off')
    assert.equal(effective.config.layout.rootDir, undefined, 'a project may not relocate the ledger')
    assert.ok(effective.config.expectedPlugins.includes('my-own-plugin'), 'adding a plugin is honoured')
    assert.ok(effective.config.expectedPlugins.includes('quality-gate'), 'removing a plugin the host expects is refused')
    assert.equal(effective.config.probeTimeoutMs, undefined, 'an unusable value keeps the profile value')
    assert.ok(problems.some((problem) => /enabled/.test(problem)), JSON.stringify(problems))
    assert.ok(problems.some((problem) => /并集/.test(problem)), JSON.stringify(problems))
    assert.ok(problems.some((problem) => /probeTimeoutMs/.test(problem)), JSON.stringify(problems))
    assert.ok(problems.some((problem) => /layout/.test(problem)), JSON.stringify(problems))
})

// --- adversarial-audit regression -------------------------------------------

test('a logger without for() must not break the report (eng-core\u2019s silentLogger has none)', async () => {
    // Repro a7.mjs: `deps.logger?.for(cwd)` assumed `for` exists, so the tool
    // threw a TypeError AFTER the whole report had been built.
    const cwd = repo()
    configure(cwd)
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    const fake = createFakeHost({ cwd, services: {} })
    hosts.push(fake)
    const bare = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never
    const config = resolveConfig({ logFile: logFileFor() })
    const registered = registerTools(fake.ctx as never, {
        config,
        configFor: () => config,
        stores: new MissionStoreRegistry(),
        ctx: () => fake.ctx as never,
        logger: bare,
    })
    assert.deepEqual(registered.failed, [])
    const run = await fake.runTool('suite_status', {})
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /# 套件自检（suite_status）/)
    assert.ok(text.length > 100, 'the whole report must be produced, not a TypeError')
})

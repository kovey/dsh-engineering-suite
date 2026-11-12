/**
 * Tests for `suite_init`, `suite_config`, `/suite doctor` and the `/suite`
 * command, following the accepted test design TC-1501 … TC-1506.
 *
 * TC-1507 is a VERIFICATION-level case (`bash scripts/verify.sh --quiet` twice,
 * both exit 0). Per the team's iteration rule this package run does not execute
 * the full verify suite; the package tests, tsc and standards-check are the
 * evidence here, and the full run remains the delivery gate's job.
 *
 * The invariants these tests pin are the ones that make a scaffold safe to run:
 *
 *  - **no write without apply** — a dry run leaves the workspace byte-identical;
 *  - **no overwrite without force** — reviewed thresholds survive a second run;
 *  - **idempotent** — a second apply changes no byte (the whole layout root is
 *    hashed, not just the files the plan lists);
 *  - **the command is optional and portable** — absent registry = no command and
 *    no failure; present registry = `/suite` registered and executable, with no
 *    TUI-specific API involved.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { clearProjectConfigCache, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { registerSuiteCommand } from '../dist/command.js'
import { runSuiteHealth } from '../dist/health.js'
import { inspectSuiteConfig } from '../dist/inspect.js'
import { configText, SUITE_CONFIGS } from '../dist/scaffold-catalog.js'
import { planSuiteInit } from '../dist/scaffold.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

/** A log file outside the workspace: the byte-identical tests hash the repo. */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-init-log-'), 'suite-doctor.log')
}

/** A throwaway repository with optional marker files. */
function repo(files: Record<string, string> = {}): string {
    const cwd = tempWorkspace('suite-init-')
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
    return cwd
}

function layoutOf(cwd: string): ReturnType<typeof resolveLayout> {
    return resolveLayout(cwd)
}

/** Assemble the plugin in a throwaway workspace (optionally with a registry). */
function host(cwd: string, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    clearProjectConfigCache()
    apply(fake.ctx as never, { logFile: logFileFor() })
    return fake
}

/** Every file under `dir`, content-hashed (the "byte-identical" assertion). */
function snapshot(dir: string): Record<string, string> {
    const files: Record<string, string> = {}
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (entry.isFile()) files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
    }
    if (fs.existsSync(dir)) walk(dir)
    return files
}

function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** A structural fake of `ctx.get('commands')`, recording what was registered. */
function registryOf(): {
    service: { register: (definition: { name: string; handler: (invocation: unknown) => unknown }) => () => void }
    definitions: { name: string; handler: (invocation: unknown) => unknown }[]
    disposed: string[]
} {
    const definitions: { name: string; handler: (invocation: unknown) => unknown }[] = []
    const disposed: string[] = []
    return {
        service: {
            register(definition) {
                definitions.push(definition)
                return () => disposed.push(definition.name)
            },
        },
        definitions,
        disposed,
    }
}

test('TC-1501: suite_init on an empty repository is a dry run that writes nothing', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    const report = planSuiteInit({ cwd, rootDir: layout.configDir })
    assert.equal(report.dryRun, true)
    assert.equal(report.entries.length, 10, 'ten configuration files are planned')
    assert.deepEqual(
        report.entries.map((entry) => entry.action),
        Array(10).fill('write'),
    )
    assert.equal(fs.existsSync(layout.rootDir), false, 'dry run must not create the layout root')
})

test('TC-1501: suite_init({ apply: true }) writes all ten files, valid JSON, ecosystem defaults', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    const report = planSuiteInit({ cwd, rootDir: layout.configDir, apply: true })
    assert.equal(report.entries.length, 10)
    for (const descriptor of SUITE_CONFIGS) {
        const file = path.join(layout.rootDir, descriptor.file)
        assert.ok(fs.existsSync(file), `${descriptor.file} must exist`)
        const parsed = readJson(file)
        assert.equal(typeof parsed, 'object')
    }
    const quality = readJson(path.join(layout.rootDir, 'quality-gate.json')) as { commands: { command: string; required: boolean }[] }
    assert.equal(quality.commands[0]?.command, 'node --test')
    assert.equal(quality.commands[0]?.required, true)
    const standards = readJson(path.join(layout.rootDir, 'standards.json')) as { languages: Record<string, unknown> }
    assert.deepEqual(Object.keys(standards.languages), ['ts', 'js'])
})

test('TC-1501: the detected ecosystem decides the generated commands (go / py / js)', () => {
    const go = repo({ 'go.mod': 'module example\n' })
    planSuiteInit({ cwd: go, rootDir: layoutOf(go).configDir, apply: true })
    const goQuality = readJson(path.join(layoutOf(go).rootDir, 'quality-gate.json')) as { commands: { command: string }[] }
    assert.equal(goQuality.commands[0]?.command, 'go test ./...')
    const goCoverage = readJson(path.join(layoutOf(go).rootDir, 'coverage-gate.json')) as { reportFile: string; reportFormat: string }
    assert.equal(goCoverage.reportFile, 'coverage/cover.out')
    assert.equal(goCoverage.reportFormat, 'go-cover')

    const py = repo({ 'pyproject.toml': '[project]\nname = "x"\n' })
    planSuiteInit({ cwd: py, rootDir: layoutOf(py).configDir, apply: true })
    const pyQuality = readJson(path.join(layoutOf(py).rootDir, 'quality-gate.json')) as { commands: { command: string }[] }
    assert.equal(pyQuality.commands[0]?.command, 'python -m pytest -q')

    const js = repo({ 'package.json': '{"name":"x"}' })
    planSuiteInit({ cwd: js, rootDir: layoutOf(js).configDir, apply: true })
    const jsQuality = readJson(path.join(layoutOf(js).rootDir, 'quality-gate.json')) as { commands: { command: string }[] }
    assert.equal(jsQuality.commands[0]?.command, 'npm test')
})

test('TC-1504: an existing configuration is skipped and never overwritten by default', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    const file = path.join(layout.rootDir, 'spec-gate.json')
    const custom = '{\n  "enforce": false\n}\n'
    fs.writeFileSync(file, custom)
    const report = planSuiteInit({ cwd, rootDir: layout.configDir, apply: true })
    const entry = report.entries.find((item) => item.relative === '.dsh/spec-gate.json')
    assert.equal(entry?.action, 'skip')
    assert.equal(entry?.bytes, Buffer.byteLength(custom))
    assert.equal(fs.readFileSync(file, 'utf8'), custom, 'reviewed thresholds must survive a scaffold run')
})

test('suite_init force:true overwrites (and says so)', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    const file = path.join(layout.rootDir, 'spec-gate.json')
    fs.writeFileSync(file, '{"enforce":false}\n')
    const report = planSuiteInit({ cwd, rootDir: layout.configDir, apply: true, force: true })
    const entry = report.entries.find((item) => item.relative === '.dsh/spec-gate.json')
    assert.equal(entry?.action, 'overwrite')
    const descriptor = SUITE_CONFIGS.find((item) => item.id === 'spec-gate')
    assert.ok(descriptor)
    assert.equal(fs.readFileSync(file, 'utf8'), configText(descriptor, 'ts'))
})

test('TC-1502: a second apply is idempotent — the layout root stays byte-identical', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    planSuiteInit({ cwd, rootDir: layout.configDir, apply: true })
    const before = snapshot(layout.rootDir)
    const second = planSuiteInit({ cwd, rootDir: layout.configDir, apply: true })
    assert.deepEqual(
        second.entries.map((entry) => entry.action),
        Array(10).fill('skip'),
    )
    assert.deepEqual(snapshot(layout.rootDir), before)
})

test('suite_init only: restricts the run; an unknown or empty filter is refused', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    const report = planSuiteInit({ cwd, rootDir: layout.configDir, apply: true, only: ['quality', 'deploy-gate.json'] })
    assert.deepEqual(
        report.entries.map((entry) => entry.relative),
        ['.dsh/quality-gate.json', '.dsh/deploy-gate.json'],
    )
    assert.deepEqual(fs.readdirSync(layout.rootDir).sort(), ['deploy-gate.json', 'quality-gate.json'])
    assert.throws(() => planSuiteInit({ cwd, rootDir: layout.configDir, only: ['nope'] }), /不认识的配置名/)
    assert.throws(() => planSuiteInit({ cwd, rootDir: layout.configDir, only: [] }), /空数组/)
})

test('TC-1506: suite_config names the file and the key (unknown top-level, host-only)', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    fs.writeFileSync(
        path.join(layout.rootDir, 'quality-gate.json'),
        JSON.stringify({ commands: [{ id: 'test', command: 'npm test', required: true }], nonsense: 1, enabled: false }),
    )
    const inspection = inspectSuiteConfig({ cwd, layout }, ['quality'])
    const row = inspection.rows[0]
    assert.ok(row)
    assert.equal(row.source, 'repo')
    const problems = row.problems.join('\n')
    assert.match(problems, /quality-gate\.json/)
    assert.match(problems, /未知顶层键 "nonsense"/)
    assert.match(problems, /"enabled".*不能在项目级覆盖/)
})

test('suite_config: a malformed file is unknown input, not a pass', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    fs.writeFileSync(path.join(layout.rootDir, 'quality-gate.json'), '{ "commands": [')
    const inspection = inspectSuiteConfig({ cwd, layout }, ['quality-gate'])
    const row = inspection.rows[0]
    assert.ok(row)
    assert.equal(row.present, true)
    assert.equal(row.value, undefined)
    assert.equal(row.source, 'profile')
    assert.match(row.problems.join('\n'), /不是合法 JSON/)
})

test('suite_config: a file whose keys are all refused falls back to profile', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    fs.writeFileSync(path.join(layout.rootDir, 'quality-gate.json'), JSON.stringify({ enabled: false, logFile: '/tmp/x.log' }))
    const inspection = inspectSuiteConfig({ cwd, layout }, ['quality'])
    const row = inspection.rows[0]
    assert.ok(row)
    assert.equal(row.source, 'profile')
    assert.equal(row.problems.length, 2)
})

test('suite_config: a path key escaping the workspace is reported with file and key', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const layout = layoutOf(cwd)
    fs.mkdirSync(layout.rootDir, { recursive: true })
    fs.writeFileSync(path.join(layout.rootDir, 'coverage-gate.json'), JSON.stringify({ reportFile: '../../../outside.info', thresholds: { total: 70 } }))
    const inspection = inspectSuiteConfig({ cwd, layout }, ['coverage'])
    const row = inspection.rows[0]
    assert.ok(row)
    assert.equal(row.pathProblems.length, 1)
    assert.match(row.pathProblems[0] ?? '', /coverage-gate\.json: reportFile/)
})

test('suite_init / suite_config tools refuse a session without a workspace', async () => {
    const fake = host(repo())
    const run = await fake.runTool('suite_init', {}, { agent: { id: 'a', session: { id: 's', header: { id: 's', cwd: '' } } } })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /无法确定工作区/)
})

test('TC-1501/TC-1506: the tools scaffold and inspect through the calling agent workspace', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const fake = host(cwd)
    assert.ok(fake.tools.has('suite_init'))
    assert.ok(fake.tools.has('suite_config'))

    const dry = await fake.runTool('suite_init', {})
    assert.equal(dry.isError, false)
    assert.match(runText(dry), /dry-run/)
    assert.equal(fs.existsSync(layoutOf(cwd).rootDir), false)

    const applied = await fake.runTool('suite_init', { apply: true })
    assert.equal(applied.isError, false)
    assert.match(runText(applied), /合计：写入 10/)
    const config = await fake.runTool('suite_config', { plugin: 'quality' })
    assert.equal(config.isError, false)
    assert.match(runText(config), /quality-gate/)
    assert.match(runText(config), /\[repo\]/)
})

test('TC-1505: without a command registry the plugin loads and registers no command, without error', () => {
    const outcome = registerSuiteCommand({ get: () => undefined }, {} as never)
    assert.equal(outcome.registered, false)
    assert.match(outcome.problem ?? '', /commands 服务/)
    const fake = host(repo())
    assert.ok(fake.tools.has('suite_status'))
    assert.ok(fake.tools.has('suite_init'))
    assert.ok(fake.tools.has('suite_config'))
})

test('TC-1503: with a registry, /suite is registered and show/init/doctor execute', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const registry = registryOf()
    const fake = host(cwd, { commands: registry.service })
    assert.equal(registry.definitions.length, 1)
    const definition = registry.definitions[0]
    assert.ok(definition)
    assert.equal(definition.name, 'suite')

    const shown = (await definition.handler({ agent: fake.agent, rawInput: ' show spec' })) as { kind: string; text: string }
    assert.equal(shown.kind, 'success')
    assert.match(shown.text, /spec-gate/)

    const dry = (await definition.handler({ agent: fake.agent, rawInput: ' init' })) as { kind: string; text: string }
    assert.equal(dry.kind, 'success')
    assert.match(dry.text, /dry-run/)
    assert.equal(fs.existsSync(layoutOf(cwd).rootDir), false, '/suite init without --apply writes nothing')

    const applied = (await definition.handler({ agent: fake.agent, rawInput: ' init --apply --only quality' })) as { kind: string; text: string }
    assert.equal(applied.kind, 'success')
    assert.deepEqual(fs.readdirSync(layoutOf(cwd).rootDir), ['quality-gate.json'])

    const doctor = (await definition.handler({ agent: fake.agent, rawInput: ' doctor' })) as { kind: string; text: string }
    assert.equal(doctor.kind, 'success')
    assert.match(doctor.text, /汇总：/)
    assert.match(doctor.text, /config\.quality-gate/)

    const bad = (await definition.handler({ agent: fake.agent, rawInput: ' nonsense' })) as { kind: string; text: string }
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /用法/)

    fake.dispose()
    assert.deepEqual(registry.disposed, ['suite'])
})

test('/suite doctor reports missing configs on an empty repo and ok rows after init', () => {
    const empty = repo({ 'tsconfig.json': '{}' })
    const emptyLayout = layoutOf(empty)
    const before = runSuiteHealth({ cwd: empty, layout: emptyLayout })
    assert.equal(before.state, 'missing')
    assert.equal(before.checks.find((check) => check.id === 'config.quality-gate')?.state, 'missing')
    assert.equal(fs.existsSync(emptyLayout.rootDir), false, 'the doctor is read-only')

    planSuiteInit({ cwd: empty, rootDir: emptyLayout.configDir, apply: true })
    const afterInit = runSuiteHealth({ cwd: empty, layout: emptyLayout })
    assert.equal(afterInit.checks.find((check) => check.id === 'config.quality-gate')?.state, 'ok')
    assert.equal(afterInit.checks.find((check) => check.id === 'config.interaction-gate')?.state, 'ok')
    assert.equal(afterInit.checks.find((check) => check.id === 'paths.resolve')?.state, 'ok')
    // The scaffold cannot freeze a baseline (that needs human approval) and leaves
    // deploy environments empty: both are honestly partial, never "ok".
    assert.equal(afterInit.checks.find((check) => check.id === 'standards.artifacts')?.state, 'partial')
    assert.equal(afterInit.checks.find((check) => check.id === 'deploy.environments')?.state, 'partial')
    assert.notEqual(afterInit.state, 'ok')
})

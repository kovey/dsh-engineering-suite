/**
 * `/suite init` / `suite_init`: WHICH directory configuration is created in.
 *
 * The user-visible defect these tests pin (found in a real run): on an empty
 * repository the scaffold wrote all ten files into `<repo>/.dsh/` — the read
 * path's fallback — instead of the suite's namespace `.dsh/engineering-suite/`.
 * The three repository shapes therefore have to be told apart by the WRITE path:
 *
 *  - empty: create and write the namespace (top-level name asserted);
 *  - migrated (namespace exists): keep writing it, never the legacy root;
 *  - legacy-only (`.dsh/*-gate.json` exists): keep writing the legacy root so
 *    the configuration is not split, and say "沿用遗留位置" in the report.
 *
 * Plus the property that makes the fix complete: after `init`, the reader
 * (`/suite show`, `/suite doctor`, and every plugin through `resolveLayout`)
 * sees exactly the files that were just written — no migration step in between.
 *
 * TC mapping: TC-1651 (empty), TC-1652 (migrated), TC-1653 (legacy-only),
 * TC-1654 (show after init); AC-001 … AC-003 of the mission spec.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { clearProjectConfigCache, resolveLayout } from 'dsh-eng-core'
import { scaffoldConfigDir } from 'dsh-eng-core/scaffold'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { registerSuiteCommand } from '../dist/command.js'
import { planSuiteInit, renderInitPlan } from '../dist/scaffold.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

/** A log file outside the workspace: the byte-identical assertions hash the repo. */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-init-layout-log-'), 'suite-doctor.log')
}

/** A throwaway repository with optional marker files. */
function repo(files: Record<string, string> = {}): string {
    const cwd = tempWorkspace('suite-init-layout-')
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
    return cwd
}

/** The plugin mounted in a throwaway workspace (optionally with a registry). */
function host(cwd: string, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    clearProjectConfigCache()
    apply(fake.ctx as never, { logFile: logFileFor() })
    return fake
}

/** A structural fake of `ctx.get('commands')`, recording what was registered. */
function registryOf(): {
    service: { register: (definition: { name: string; handler: (invocation: unknown) => unknown }) => () => void }
    definitions: { name: string; handler: (invocation: unknown) => unknown }[]
} {
    const definitions: { name: string; handler: (invocation: unknown) => unknown }[] = []
    return {
        service: {
            register(definition) {
                definitions.push(definition)
                return () => undefined
            },
        },
        definitions,
    }
}

/** JSON file names directly under a directory (empty when it does not exist). */
function jsonFilesIn(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
}

/** The directory list of `<cwd>/.dsh` (empty when it does not exist). */
function topLevelOfDsh(cwd: string): string[] {
    const dir = path.join(cwd, '.dsh')
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

test('TC-1651: an empty repository is scaffolded into .dsh/engineering-suite, never into .dsh/', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const fake = host(cwd)
    const dshRoot = path.join(cwd, '.dsh')
    const namespace = path.join(dshRoot, 'engineering-suite')

    const dry = await fake.runTool('suite_init', {})
    assert.equal(dry.isError, false)
    const dryText = runText(dry)
    assert.match(dryText, /布局根：\.dsh\/engineering-suite/, 'the report must print 布局根：.dsh/engineering-suite')
    assert.match(dryText, /（namespace）/, 'the report must print which branch decided the root')
    assert.match(dryText, /空仓库/, 'the report must say why the namespace was chosen')
    assert.equal(fs.existsSync(dshRoot), false, 'a dry run creates nothing — not even the directory')

    const applied = await fake.runTool('suite_init', { apply: true })
    assert.equal(applied.isError, false)
    assert.match(runText(applied), /布局根：\.dsh\/engineering-suite/)
    assert.match(runText(applied), /合计：写入 10/)

    assert.deepEqual(topLevelOfDsh(cwd), ['engineering-suite'], 'the only top-level entry under .dsh is the namespace directory')
    assert.deepEqual(jsonFilesIn(dshRoot), [], 'no configuration may land in the .dsh root')
    assert.equal(fs.readdirSync(namespace).length, 10)
    assert.ok(fs.existsSync(path.join(namespace, 'quality-gate.json')))
    // The creation target is the read target: nothing else has to move.
    assert.equal(resolveLayout(cwd).configDir, namespace)
})

test('TC-1652: a migrated repository keeps writing the namespace', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const namespace = path.join(cwd, '.dsh', 'engineering-suite')
    fs.mkdirSync(namespace, { recursive: true })
    const fake = host(cwd)

    const applied = await fake.runTool('suite_init', { apply: true })
    assert.equal(applied.isError, false)
    const text = runText(applied)
    assert.match(text, /布局根：\.dsh\/engineering-suite/)
    assert.match(text, /已迁移/)

    assert.deepEqual(jsonFilesIn(path.join(cwd, '.dsh')), [], 'a migrated repository must not gain .dsh/*.json')
    assert.equal(fs.readdirSync(namespace).length, 10)
    assert.deepEqual(topLevelOfDsh(cwd), ['engineering-suite'])
})

test('TC-1653: a legacy-only repository keeps writing the legacy root and says so', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const dshRoot = path.join(cwd, '.dsh')
    fs.mkdirSync(dshRoot, { recursive: true })
    const custom = '{\n  "commands": []\n}\n'
    fs.writeFileSync(path.join(dshRoot, 'quality-gate.json'), custom)
    const fake = host(cwd)

    const applied = await fake.runTool('suite_init', { apply: true })
    assert.equal(applied.isError, false)
    const text = runText(applied)
    assert.match(text, /布局根：\.dsh（legacy）/)
    assert.match(text, /沿用遗留位置/, 'the operator must be told the old location was kept on purpose')
    assert.match(text, /quality-gate\.json/)

    assert.equal(fs.existsSync(path.join(dshRoot, 'engineering-suite')), false, 'creating the namespace next to legacy config would split it')
    assert.deepEqual(topLevelOfDsh(cwd), ['deploy-gate.json', 'evidence-gate.json', 'impact-gate.json', 'interaction-gate.json', 'quality-gate.json', 'spec-gate.json', 'standards.json', 'supply-chain-gate.json', 'test-design-gate.json', 'coverage-gate.json'].sort())
    assert.equal(fs.readFileSync(path.join(dshRoot, 'quality-gate.json'), 'utf8'), custom, 'the reviewed file is skipped, never replaced')
    // The reader resolves the legacy root too, so read and write still agree.
    assert.equal(resolveLayout(cwd).configDir, dshRoot)
})

test('TC-1654: after init, /suite show and /suite doctor read what was just written', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const registry = registryOf()
    const fake = host(cwd, { commands: registry.service })
    const definition = registry.definitions[0]
    assert.ok(definition)

    const applied = (await definition.handler({ agent: fake.agent, rawInput: ' init --apply' })) as { kind: string; text: string }
    assert.equal(applied.kind, 'success')
    assert.match(applied.text, /布局根：\.dsh\/engineering-suite/)

    const shown = (await definition.handler({ agent: fake.agent, rawInput: ' show quality' })) as { kind: string; text: string }
    assert.equal(shown.kind, 'success')
    assert.match(shown.text, /quality-gate/, 'show must find the file init just wrote')
    assert.match(shown.text, /\[repo\]/, 'the effective source is the repository file, not the profile default')

    const doctor = (await definition.handler({ agent: fake.agent, rawInput: ' doctor' })) as { kind: string; text: string }
    assert.equal(doctor.kind, 'success')
    assert.match(doctor.text, /布局根：.*engineering-suite/)
    assert.match(doctor.text, /✅ config\.quality-gate/, 'the doctor must see the written configuration immediately')
})

test('the plan and its renderer agree with scaffoldConfigDir (one decision, two callers)', () => {
    const empty = repo({ 'tsconfig.json': '{}' })
    const plan = planSuiteInit({ cwd: empty })
    assert.equal(plan.layout, 'namespace')
    assert.equal(plan.rootDir, path.join(empty, '.dsh', 'engineering-suite'))
    assert.match(renderInitPlan(plan), /布局根：\.dsh\/engineering-suite/)

    const legacy = repo({ 'tsconfig.json': '{}' })
    fs.mkdirSync(path.join(legacy, '.dsh'))
    fs.writeFileSync(path.join(legacy, '.dsh', 'spec-gate.json'), '{"enforce":false}\n')
    const legacyPlan = planSuiteInit({ cwd: legacy })
    assert.equal(legacyPlan.layout, 'legacy')
    assert.equal(legacyPlan.rootDir, path.join(legacy, '.dsh'))
    assert.deepEqual(legacyPlan.entries.map((entry) => entry.action)[0], 'skip', 'the existing file is skipped in the plan, not silently rewritten')
    assert.equal(scaffoldConfigDir(legacy).dir, legacyPlan.rootDir)
})

test('an explicit host layout.rootDir still wins (and is reported as explicit)', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const plan = planSuiteInit({ cwd, rootDir: 'team-trail' })
    assert.equal(plan.layout, 'explicit')
    assert.equal(plan.rootDir, path.join(cwd, 'team-trail'))
    assert.match(renderInitPlan(plan), /布局根：team-trail（explicit）/)
    assert.equal(fs.existsSync(path.join(cwd, 'team-trail')), false, 'planning alone writes nothing')
})

/**
 * `scaffoldConfigDir` — where suite configuration is CREATED.
 *
 * The defect these tests pin: creation used to reuse the READ path
 * (`resolveLayout().configDir`), whose empty-repository fallback is `.dsh/`, so
 * `/suite init` wrote ten config files into the legacy root. Creating and
 * reading are different questions; the namespace directory is the answer to
 * "create" on an empty repository, and the legacy root is only kept when it
 * already holds configuration (writing elsewhere would split it).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout } from '../dist/index.js'
import { scaffoldConfigDir, SUITE_CONFIG_FILES } from '../dist/scaffold.js'

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-dir-'))
}

/** `.dsh` of a workspace (the legacy root). */
function legacyRoot(cwd: string): string {
    return path.join(cwd, '.dsh')
}

/** The namespace directory of a workspace. */
function namespaceDir(cwd: string): string {
    return path.join(cwd, '.dsh', 'engineering-suite')
}

test('an empty repository is CREATED in the namespace (not the .dsh root), and nothing is created yet', () => {
    const cwd = workspace()
    const decided = scaffoldConfigDir(cwd)
    assert.equal(decided.dir, namespaceDir(cwd))
    assert.equal(decided.layout, 'namespace')
    assert.match(decided.reason, /空仓库/)
    assert.equal(fs.existsSync(legacyRoot(cwd)), false, 'the decision is pure: a dry run must not create anything')
    // The reader prefers the namespace once it exists, so writer and reader agree.
    fs.mkdirSync(namespaceDir(cwd), { recursive: true })
    assert.equal(resolveLayout(cwd).configDir, decided.dir, 'the creation target is exactly the directory the reader prefers')
})

test('a migrated repository keeps writing the namespace', () => {
    const cwd = workspace()
    fs.mkdirSync(namespaceDir(cwd), { recursive: true })
    const decided = scaffoldConfigDir(cwd)
    assert.equal(decided.dir, namespaceDir(cwd))
    assert.equal(decided.layout, 'namespace')
    assert.match(decided.reason, /已迁移/)
})

test('a repository that only has legacy config keeps writing the legacy root, and says why', () => {
    const cwd = workspace()
    fs.mkdirSync(legacyRoot(cwd))
    fs.writeFileSync(path.join(legacyRoot(cwd), 'quality-gate.json'), '{"commands":[]}\n')
    const decided = scaffoldConfigDir(cwd)
    assert.equal(decided.dir, legacyRoot(cwd))
    assert.equal(decided.layout, 'legacy')
    assert.match(decided.reason, /沿用遗留位置/, 'the report must tell the operator the old location was kept on purpose')
    assert.match(decided.reason, /quality-gate\.json/, 'the reason names the files that made it legacy')
    assert.equal(fs.existsSync(namespaceDir(cwd)), false)
})

test('a plugin gate file outside the default catalog still marks the root as legacy', () => {
    const cwd = workspace()
    fs.mkdirSync(legacyRoot(cwd))
    fs.writeFileSync(path.join(legacyRoot(cwd), 'some-future-gate.json'), '{}')
    assert.equal(scaffoldConfigDir(cwd).layout, 'legacy')
    // An explicit caller catalog covers the non-`*-gate.json` artifacts too.
    const custom = workspace()
    fs.mkdirSync(legacyRoot(custom))
    fs.writeFileSync(path.join(legacyRoot(custom), 'team-rules.json'), '{}')
    assert.equal(scaffoldConfigDir(custom).layout, 'namespace', 'not in the default catalog: still an empty repository')
    assert.equal(scaffoldConfigDir(custom, { legacyFiles: ['team-rules.json'] }).layout, 'legacy')
})

test('an explicit layout.rootDir wins over every branch (including the namespace)', () => {
    const cwd = workspace()
    fs.mkdirSync(namespaceDir(cwd), { recursive: true })
    const relative = scaffoldConfigDir(cwd, { rootDir: 'trail' })
    assert.equal(relative.dir, path.join(cwd, 'trail'))
    assert.equal(relative.layout, 'explicit')
    assert.match(relative.reason, /显式/)
    assert.equal(scaffoldConfigDir(cwd, { rootDir: '/tmp/abs-trail' }).dir, '/tmp/abs-trail')
    // An empty string is the suite-wide spelling of "follow the layout root",
    // not a directory named "": treat it as absent.
    assert.equal(scaffoldConfigDir(workspace(), { rootDir: '   ' }).layout, 'namespace')
})

test('a migrated repository with leftover legacy files still writes the namespace (no split)', () => {
    const cwd = workspace()
    fs.mkdirSync(namespaceDir(cwd), { recursive: true })
    fs.writeFileSync(path.join(legacyRoot(cwd), 'quality-gate.json'), '{"commands":[]}\n')
    const decided = scaffoldConfigDir(cwd)
    assert.equal(decided.dir, namespaceDir(cwd))
    assert.equal(decided.layout, 'namespace')
})

test('the default catalog covers the scaffolded config files and the baseline', () => {
    for (const name of ['spec-gate.json', 'test-design-gate.json', 'quality-gate.json', 'standards.json', 'standards-baseline.json', 'evidence-gate.json', 'coverage-gate.json', 'impact-gate.json', 'supply-chain-gate.json', 'interaction-gate.json', 'deploy-gate.json', 'suite-doctor.json']) {
        assert.ok(SUITE_CONFIG_FILES.includes(name), `${name} must mark a legacy root`)
    }
    const cwd = workspace()
    fs.mkdirSync(legacyRoot(cwd))
    fs.writeFileSync(path.join(legacyRoot(cwd), 'standards-baseline.json'), '{}')
    assert.equal(scaffoldConfigDir(cwd).layout, 'legacy', 'a repository-owned artifact is still evidence the old root is in use')
})

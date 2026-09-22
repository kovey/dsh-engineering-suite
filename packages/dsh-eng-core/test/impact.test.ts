import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { analyzeImpact, changedRanges, isTestPath, renderTestCommand } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** A workspace with a real git repository (the diff is the point). */
function repo(): string {
    const cwd = tempWorkspace('impact-')
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    fs.mkdirSync(path.join(cwd, 'src', 'store'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'src', 'api'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n  return 1\n}\n')
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.test.ts'), "import { save } from './store.js'\n\ntest('save', () => {\n  save()\n})\n")
    fs.writeFileSync(path.join(cwd, 'src', 'api', 'handler.ts'), "import { save } from '../store/store.js'\n\nexport function handle(): number {\n  return save()\n}\n")
    fs.writeFileSync(path.join(cwd, 'src', 'api', 'handler.spec.ts'), "import { handle } from './handler.js'\n\ntest('handle', () => {\n  handle()\n})\n")
    fs.writeFileSync(path.join(cwd, 'package.json'), '{ "name": "demo" }\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    return cwd
}

test('changedRanges reads the added lines of a worktree change (regression)', async () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n  // new line\n  return 2\n}\n')
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'brand.ts'), 'export const brand = 1\n')
    const ranges = await changedRanges({ cwd })
    assert.equal(ranges.isRepo, true)
    const store = ranges.files.find((file) => file.path === 'src/store/store.ts')
    assert.deepEqual(store?.added, [[2, 3]], 'exactly the inserted lines, thanks to -U0')
    assert.equal(store?.removed, 1)
    assert.equal(store?.status, 'modified')
    const brand = ranges.files.find((file) => file.path === 'src/store/brand.ts')
    assert.equal(brand?.status, 'untracked', 'untracked files count as fully new')
    assert.deepEqual(brand?.added, [[1, 1]])
})

test('changedRanges reports a non-repository instead of pretending (regression)', async () => {
    const cwd = tempWorkspace('impact-nogit-')
    const ranges = await changedRanges({ cwd })
    assert.equal(ranges.isRepo, false)
    assert.deepEqual(ranges.files, [])
    assert.match(ranges.problem ?? '', /git/)
})

test('analyzeImpact finds the tests that reach a change (regression)', async () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n  return 2\n}\n')
    const report = await analyzeImpact({ cwd })
    assert.deepEqual(report.changed.map((file) => file.path), ['src/store/store.ts'])
    // A test that IMPORTS the change outranks one that merely shares its
    // directory: `imports-changed` is evidence, `same-package` is the fallback
    // for ecosystems whose tests do not import their subject (Go).
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'pkgonly.test.ts'), "test('pkg', () => {})\n")
    const report2 = await analyzeImpact({ cwd, paths: ['src/store/store.ts'] })
    const tests = report2.tests.map((selection) => [selection.path, selection.reason])
    assert.deepEqual(tests, [
        ['src/store/store.test.ts', 'imports-changed'],
        ['src/api/handler.spec.ts', 'imports-changed'],
        ['src/store/pkgonly.test.ts', 'same-package'],
    ])
    // The transitive dependent is reported with its distance and the path that
    // pulled it in — the answer to "what else does this touch".
    const handler = report.impacted.find((file) => file.path === 'src/api/handler.ts')
    assert.equal(handler?.distance, 1)
    assert.equal(handler?.via, 'src/store/store.ts')
    assert.equal(report.risk, 'low')
    assert.ok(report.stats.graphEdges >= 2, `graph edges: ${report.stats.graphEdges}`)
})

test('a test file that is itself changed is selected first (regression)', async () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.test.ts'), "import { save } from './store.js'\n\ntest('save again', () => {\n  save()\n})\n")
    const report = await analyzeImpact({ cwd })
    assert.equal(report.tests[0]?.path, 'src/store/store.test.ts')
    assert.equal(report.tests[0]?.reason, 'changed')
})

test('the risk level follows the documented thresholds (regression)', async () => {
    const cwd = repo()
    // Nothing reaches it and no test matches: that is the high-risk case.
    fs.writeFileSync(path.join(cwd, 'src', 'lonely.ts'), 'export const lonely = 1\n')
    const lonely = await analyzeImpact({ cwd, paths: ['src/lonely.ts'] })
    assert.equal(lonely.risk, 'high')
    assert.match(lonely.reasons.join('\n'), /没有任何测试文件覆盖/)
    assert.match(lonely.reasons.join('\n'), /既没有依赖者也没有测试触及/)

    // A wide public surface is medium/high on its own.
    const wide = ['export const a = 1']
    for (let index = 0; index < 20; index += 1) wide.push(`export const v${index} = ${index}`)
    fs.writeFileSync(path.join(cwd, 'src', 'wide.ts'), `${wide.join('\n')}\n`)
    const report = await analyzeImpact({ cwd, paths: ['src/wide.ts'] })
    assert.notEqual(report.risk, 'low')
    assert.match(report.reasons.join('\n'), /导出面 21 个符号/)
})

test('explicit paths work without a diff, and the command template renders (regression)', async () => {
    const cwd = repo()
    const report = await analyzeImpact({ cwd, paths: ['src/store/store.ts'] })
    assert.equal(report.base, '(explicit paths)')
    assert.deepEqual(report.changed.map((file) => file.path), ['src/store/store.ts'])
    assert.equal(renderTestCommand('go test {files}', report.tests), 'go test src/store/store.test.ts src/api/handler.spec.ts')
    assert.equal(renderTestCommand('vitest run', []), 'vitest run')
    assert.equal(renderTestCommand('go test ./...', []), 'go test ./...')
})

test('test paths are recognised across ecosystems (regression)', () => {
    for (const file of ['a/b_test.go', 'src/x.test.ts', 'src/x.spec.tsx', 'tests/it.py', 'test_it.py', 'FooTests.java', 'pkg/__tests__/y.js']) {
        assert.equal(isTestPath(file), true, `${file} is a test`)
    }
    for (const file of ['src/store.ts', 'internal/store/store.go', 'testdata/fixture.go', 'src/latest.ts']) {
        assert.equal(isTestPath(file), false, `${file} is not a test`)
    }
})

test('a directory import reaches the package files (regression: a real Go repo had 0 edges)', async () => {
    // Go imports a package directory. Requiring the import to name a FILE made
    // the graph empty on `golang/im` (113 files, 0 edges, no useful selection);
    // the same shape appears in Python packages.
    const cwd = tempWorkspace('impact-go-')
    fs.mkdirSync(path.join(cwd, 'internal', 'store'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'internal', 'api'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/demo\n\ngo 1.26\n')
    fs.writeFileSync(path.join(cwd, 'internal', 'store', 'store.go'), 'package store\n\nfunc Save() int { return 1 }\n')
    fs.writeFileSync(
        path.join(cwd, 'internal', 'api', 'api.go'),
        'package api\n\nimport "example.com/demo/internal/store"\n\nfunc Handle() int { return store.Save() }\n',
    )
    fs.writeFileSync(
        path.join(cwd, 'internal', 'store', 'store_test.go'),
        'package store\n\nfunc TestSave(t *testing.T) { _ = Save() }\n',
    )
    const report = await analyzeImpact({ cwd, paths: ['internal/store/store.go'] })
    assert.ok(report.stats.graphEdges >= 1, `expected an edge through the package import, got ${report.stats.graphEdges}`)
    assert.ok(
        report.impacted.some((file) => file.path === 'internal/api/api.go'),
        `the importing package must be impacted: ${JSON.stringify(report.impacted)}`,
    )
    assert.ok(report.tests.some((test) => test.path === 'internal/store/store_test.go'))
})

test('a failed diff is reported as "unknown", not as a risky change (regression)', async () => {
    // The plugin agent found this: dropping the diff's problem turned "I could not
    // read the workspace" into "no test covers this" → high risk, which reads
    // like a finding about the code.
    const cwd = tempWorkspace('impact-unknown-')
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'export const a = 1\n')
    const report = await analyzeImpact({ cwd })
    assert.equal(report.analysis, 'error')
    assert.equal(report.risk, 'unknown')
    assert.match(report.reasons.join('\n'), /无法判定/)
    assert.deepEqual(report.tests, [])
})

test('a clean worktree is "empty", not a high-risk change (regression)', async () => {
    const cwd = repo()
    const report = await analyzeImpact({ cwd })
    assert.equal(report.analysis, 'empty')
    assert.equal(report.risk, 'low')
    assert.match(report.reasons.join('\n'), /没有改动/)
})

test('a rename keeps the old path in the walk (regression)', async () => {
    // Importers of the OLD path are exactly who must be updated, so a rename has
    // to follow both names — otherwise the most dangerous refactor looks local.
    const cwd = repo()
    execFileSync('git', ['mv', 'src/store/store.ts', 'src/store/keeper.ts'], { cwd })
    const report = await analyzeImpact({ cwd })
    const renamed = report.changed.find((file) => file.status === 'renamed')
    assert.equal(renamed?.path, 'src/store/keeper.ts')
    assert.equal(renamed?.previousPath, 'src/store/store.ts')
    assert.ok(report.impacted.length + report.tests.length > 0, 'the old name still reaches dependents')
})

test('an empty selection never renders a bare placeholder (regression)', () => {
    assert.equal(renderTestCommand('go test {files}', []), 'go test')
    assert.equal(renderTestCommand('vitest run {files}', []), 'vitest run')
    assert.equal(renderTestCommand('go test {files}', [{ path: 'a_test.go', reason: 'changed' }]), 'go test a_test.go')
})

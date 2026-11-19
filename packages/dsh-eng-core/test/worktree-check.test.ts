/**
 * The worktree check scope (AC-002): only the affected packages, through the
 * repository's own scripts, and NEVER the full acceptance run or the
 * repository-wide standards scan.
 *
 * The scripts are fixtures on disk (`scripts/test-all.sh` writes its argv and
 * exits 0), so "which packages were checked" is an observed fact rather than an
 * inference from the code. The fixture workspace is a plain directory: the
 * module reads the manifests under `packages/` and runs scripts, it never
 * touches git.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { affectedPackages, closureInOrder, packageOfPath, runTaskChecks } from '../dist/split.js'

/** One workspace package (its own manifest, optionally with workspace deps). */
function pkg(worktree: string, name: string, deps: Record<string, string> = {}): void {
    const dir = path.join(worktree, 'packages', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, dependencies: deps }))
}

/** A fake `scripts/<name>.sh` that records its argv and exits with `rc`. */
function script(worktree: string, name: string, rc = 0): string {
    const dir = path.join(worktree, 'scripts')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    const log = path.join(worktree, `${name}.argv`)
    fs.writeFileSync(file, ['#!/usr/bin/env bash', `printf '%s\\n' "$*" >> "${log}"`, `exit ${rc}`, ''].join('\n'))
    return log
}

/** A workspace with three packages: dsh-b depends on dsh-a, dsh-c depends on dsh-b. */
function workspace(): string {
    const worktree = tempWorkspace('worktree-check-')
    pkg(worktree, 'dsh-a')
    pkg(worktree, 'dsh-b', { 'dsh-a': 'workspace:*' })
    pkg(worktree, 'dsh-c', { 'dsh-b': 'workspace:*' })
    script(worktree, 'test-all.sh')
    script(worktree, 'typecheck-all.sh')
    return worktree
}

/** The argv lines one fake script recorded. */
function recorded(log: string): string[] {
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
}

test('only the affected package and its dependency closure run, in build order (AC-002)', () => {
    const worktree = workspace()

    const result = runTaskChecks({ worktree, changedPaths: ['packages/dsh-b/src/x.ts'] })

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.full, false)
    // dsh-c is NOT affected (nothing depends on it being checked) but dsh-a is,
    // because dsh-b is compiled against dsh-a's built dist.
    assert.deepEqual(result.packages, ['dsh-a', 'dsh-b'])
    const tests = recorded(path.join(worktree, 'test-all.sh.argv'))
    const typechecks = recorded(path.join(worktree, 'typecheck-all.sh.argv'))
    assert.deepEqual(tests, ['--quiet dsh-a dsh-b'])
    assert.deepEqual(typechecks, ['dsh-a dsh-b'])
    // The scope contract in one assertion: the two repository-wide commands that
    // would defeat it were never invoked.
    const invoked = result.commands.map((command) => command.script)
    assert.deepEqual(invoked, ['scripts/test-all.sh', 'scripts/typecheck-all.sh'])
    assert.equal(invoked.some((name) => /verify|standards/.test(name)), false)
})

test('a docs-only change checks nothing (and says so instead of pretending to run)', () => {
    const worktree = workspace()

    const result = runTaskChecks({ worktree, changedPaths: ['docs/ARCHITECTURE.md', 'CHANGELOG.md'] })

    assert.equal(result.ok, true)
    assert.deepEqual(result.packages, [])
    assert.deepEqual(result.commands, [])
    assert.match(result.notes.join('\n'), /没有受影响的包/)
    assert.deepEqual(recorded(path.join(worktree, 'test-all.sh.argv')), [])
})

test('a tooling change cannot be narrowed: every package is checked and the report says why', () => {
    const worktree = workspace()

    const result = runTaskChecks({ worktree, changedPaths: ['scripts/verify.sh'] })

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.full, true)
    assert.deepEqual(result.packages, ['dsh-a', 'dsh-b', 'dsh-c'])
    assert.match(result.notes.join('\n'), /全部 3 个包/)
})

test('a failing package script is reported with its exit code and output (not swallowed)', () => {
    const worktree = workspace()
    script(worktree, 'typecheck-all.sh', 1)

    const result = runTaskChecks({ worktree, changedPaths: ['packages/dsh-a/src/x.ts'] })

    assert.equal(result.ok, false)
    const typecheck = result.commands.find((command) => command.script === 'scripts/typecheck-all.sh')
    assert.equal(typecheck?.ok, false)
    assert.equal(typecheck?.exitCode, 1)
    assert.match(result.problems.join('\n'), /typecheck-all\.sh/)
})

test('a missing script is a problem, never a silent pass', () => {
    const worktree = workspace()
    fs.rmSync(path.join(worktree, 'scripts', 'test-all.sh'))

    const result = runTaskChecks({ worktree, changedPaths: ['packages/dsh-a/src/x.ts'] })

    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /test-all\.sh 不存在/)
})

test('a missing worktree is refused', () => {
    const result = runTaskChecks({ worktree: path.join(tempWorkspace('worktree-check-missing-'), 'nope'), changedPaths: ['packages/dsh-a/src/x.ts'] })

    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /不存在/)
})

test('the path → package mapping and the closure order are the two pure pieces', () => {
    assert.equal(packageOfPath('packages/dsh-eng-core/src/models.ts'), 'dsh-eng-core')
    assert.equal(packageOfPath('CHANGELOG.md'), undefined)
    assert.equal(packageOfPath('packages/'), undefined)
    const worktree = workspace()
    // The closure is transitive and dependency-first, even when asked in reverse.
    assert.deepEqual(closureInOrder(worktree, ['dsh-c']), ['dsh-a', 'dsh-b', 'dsh-c'])
    assert.deepEqual(affectedPackages(worktree, ['packages/dsh-a/**']).packages, ['dsh-a'])
})

/**
 * Preparing a task worktree (AC-002): reuse the main tree's pnpm store, install
 * once (idempotent), and KEEP the directory when the install fails.
 *
 * No network: the pnpm binary is a shell fixture handed to `prepareTaskWorktree`
 * explicitly, so what is asserted is the argv this module builds, the store it
 * resolved and what it does with the result — not "pnpm happened to work".
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout, type Layout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { createTaskWorktree, prepareTaskWorktree, splitWorktreeDir } from '../dist/split.js'

/** One git invocation in the fixture (a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/** A throwaway repo with `.dsh/` ignored, exactly like the real workspace. */
function repo(): string {
    const cwd = tempWorkspace('worktree-prepare-')
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'fixture@example.com'])
    git(cwd, ['config', 'user.name', 'Fixture'])
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    return cwd
}

/** A ready task worktree (created by the real library) inside `cwd`. */
function worktree(cwd: string): { layout: Layout; dir: string } {
    const layout = resolveLayout(cwd)
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001' })
    assert.equal(created.ok, true, created.problems.join(' | '))
    return { layout, dir: splitWorktreeDir(layout, 'm1', 'T-001') }
}

/**
 * A fake `pnpm` executable.
 *
 * `store path` answers per `FAKE_STORE_RC`; `install` answers per
 * `FAKE_INSTALL_RC` and creates `node_modules` on success. Every invocation is
 * appended to `$FAKE_PNPM_LOG`, so "was the install skipped" is an observed fact.
 */
function fakePnpm(): { bin: string; log: string } {
    const dir = tempWorkspace('fake-pnpm-')
    const bin = path.join(dir, 'pnpm')
    const log = path.join(dir, 'calls.log')
    fs.writeFileSync(
        bin,
        [
            '#!/bin/sh',
            'printf "%s\\n" "$*" >> "$FAKE_PNPM_LOG"',
            'case "$1" in',
            '  store) if [ "${FAKE_STORE_RC:-0}" = "0" ]; then echo "/fake/store"; exit 0; fi; echo "store probe failed" >&2; exit 1 ;;',
            '  install) if [ "${FAKE_INSTALL_RC:-0}" != "0" ]; then echo "install exploded" >&2; exit 1; fi; mkdir -p node_modules; exit 0 ;;',
            'esac',
            'exit 0',
            '',
        ].join('\n'),
    )
    fs.chmodSync(bin, 0o755)
    return { bin, log }
}

/** The environment one prepare runs with (a copy, so tests cannot leak into each other). */
function envFor(log: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, FAKE_PNPM_LOG: log, ...extra }
}

/** Every line the fake pnpm was called with. */
function calls(log: string): string[] {
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '') : []
}

test('prepare reuses the main tree store and installs prefer-offline (TC-2102/AC-002)', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "task" }\n')
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log) })

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.skipped, false)
    assert.equal(result.storeDir, '/fake/store')
    assert.equal(result.storeSource, 'probe')
    assert.equal(fs.existsSync(path.join(dir, 'node_modules')), true)
    assert.deepEqual(calls(fake.log), ['store path', 'install --prefer-offline --store-dir /fake/store'])
    assert.match(result.notes.join('\n'), /复用主树 pnpm store/)
})

test('prepare is idempotent: a worktree with node_modules is not installed twice', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "task" }\n')
    const fake = fakePnpm()
    assert.equal(prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log) }).ok, true)

    const again = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log) })

    assert.equal(again.ok, true)
    assert.equal(again.skipped, true)
    assert.match(again.notes.join('\n'), /node_modules/)
    // Only the FIRST call ran anything: the second never probed or installed.
    assert.equal(calls(fake.log).length, 2)
})

test('a failed store probe falls back to the main tree node_modules store when it exists', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "task" }\n')
    fs.mkdirSync(path.join(cwd, 'node_modules', '.pnpm-store'), { recursive: true })
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log, { FAKE_STORE_RC: '1' }) })

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.storeSource, 'fallback')
    assert.equal(result.storeDir, path.join(cwd, 'node_modules', '.pnpm-store'))
    assert.match(result.notes.join('\n'), /pnpm store path 不可用/)
    assert.match(calls(fake.log).join('\n'), /--store-dir .*\.pnpm-store/)
})

test('a failed store probe without a fallback drops the flag and says so (never silently points at a store)', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "task" }\n')
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log, { FAKE_STORE_RC: '1' }) })

    assert.equal(result.ok, true, result.problems.join(' | '))
    assert.equal(result.storeDir, undefined)
    assert.match(result.notes.join('\n'), /不传 --store-dir/)
    assert.equal(calls(fake.log).includes('install --prefer-offline'), true)
})

test('a failed install is reported and the worktree is KEPT (TC-2108/AC-002)', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "task" }\n')
    // The worker's only copy of whatever it wrote: it must survive the failure.
    fs.writeFileSync(path.join(dir, 'worker-note.txt'), 'local work\n')
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log, { FAKE_INSTALL_RC: '1' }) })

    assert.equal(result.ok, false)
    assert.equal(fs.existsSync(dir), true, 'a failed prepare must keep the worktree')
    assert.equal(fs.existsSync(path.join(dir, 'worker-note.txt')), true)
    assert.match(result.problems.join('\n'), /install --prefer-offline/)
    assert.match(result.problems.join('\n'), /install exploded/)
    assert.match(result.problems.join('\n'), /目录保持原样/)
})

test('a missing worktree is refused (prepare does not create it)', () => {
    const cwd = repo()
    const layout = resolveLayout(cwd)
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-404', layout, pnpm: fake.bin, env: envFor(fake.log) })

    assert.equal(result.ok, false)
    assert.equal(result.skipped, false)
    assert.match(result.problems.join('\n'), /T-404/)
    assert.deepEqual(calls(fake.log), [])
})

test('a worktree without package.json is a no-op (nothing to install, no pnpm call)', () => {
    const cwd = repo()
    const { layout } = worktree(cwd)
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log) })

    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
    assert.match(result.notes.join('\n'), /没有 package.json/)
    assert.deepEqual(calls(fake.log), [])
})

test('a worktree is not preparable after it was cleaned up', () => {
    const cwd = repo()
    const { layout, dir } = worktree(cwd)
    git(cwd, ['worktree', 'remove', dir])
    const fake = fakePnpm()

    const result = prepareTaskWorktree({ mainTree: cwd, missionId: 'm1', taskId: 'T-001', layout, pnpm: fake.bin, env: envFor(fake.log) })

    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /不存在/)
})

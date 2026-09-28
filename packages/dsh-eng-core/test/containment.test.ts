/**
 * dsh-eng-core — the shared containment rule for project-relocatable paths.
 *
 * One rule, one test file: `dsh-quality-gate` (a budget's baseline file),
 * `dsh-spec-gate` (the ADR directory, its index and the plan ledger) and
 * `dsh-impact-gate` (the quarantine ledger) all decide with `containedPath`, so
 * the escapes are proven once here instead of four times.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { containedPath, isInside } from '../dist/index.js'

/** A workspace plus a sibling directory that is NOT part of it. */
function fixture(): { cwd: string; outside: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-core-contain-'))
    const cwd = path.join(root, 'repo')
    const outside = path.join(root, 'other-project')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    return { cwd, outside }
}

test('containedPath: a workspace-relative path is accepted and resolved', () => {
    const { cwd } = fixture()
    const inside = containedPath(cwd, '.dsh/adr', 'adrDir')
    assert.equal(inside.ok, true, inside.problem)
    assert.equal(inside.path, path.join(cwd, '.dsh', 'adr'))
    assert.equal(inside.relative, path.join('.dsh', 'adr'))
    // A path that does not exist yet is still judged (writes create it).
    assert.equal(containedPath(cwd, 'nested/deeper/file.jsonl', 'planFile').ok, true)
})

test('containedPath: `../`, absolute and `~` values outside the workspace are refused', () => {
    const { cwd, outside } = fixture()
    const escaped = containedPath(cwd, '../other-project/budgets.json', 'baselineFile')
    assert.equal(escaped.ok, false)
    assert.match(escaped.problem ?? '', /必须指向工作区内/)
    assert.match(escaped.problem ?? '', /other-project/)
    const absolute = containedPath(cwd, path.join(outside, 'q.json'), 'quarantineFile')
    assert.equal(absolute.ok, false)
    // The home directory is not inside a temp workspace, so `~` is refused too.
    assert.equal(containedPath(cwd, '~/ledger.jsonl', 'planFile').ok, false)
    // ... and the refusal never claims the value was fine.
    assert.equal(isInside(cwd, escaped.path), false)
})

test('containedPath: a symlink is judged by its REAL path, not its lexical one', () => {
    const { cwd, outside } = fixture()
    fs.writeFileSync(path.join(outside, 'victim.json'), '{}\n')
    fs.symlinkSync(path.join(outside, 'victim.json'), path.join(cwd, 'link.json'))
    const linked = containedPath(cwd, 'link.json', 'baselineFile')
    assert.equal(linked.ok, false, 'a symlink inside the workspace must not address a file outside it')
    assert.match(linked.problem ?? '', /真实路径/)
    // A symlink that stays inside the workspace is fine.
    fs.mkdirSync(path.join(cwd, 'records'), { recursive: true })
    fs.symlinkSync(path.join(cwd, 'records'), path.join(cwd, 'records-link'))
    assert.equal(containedPath(cwd, 'records-link/adr', 'adrDir').ok, true)
})

/**
 * The declared-exclusion fingerprinter and the one field-set comparison.
 *
 * The regression this file exists for: without `-uall`, git collapses an
 * untracked directory into ONE `?? .dsh/` line, so excluding `.dsh/kb` excludes
 * nothing and the index artifact makes its own workspace look dirty. The test
 * below writes ONLY the artifact and demands `changedFiles === 0`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    changedPathsWithExcludes,
    fingerprintWithExcludes,
    gitFingerprint,
    sameFingerprint,
    sha256,
    usableFingerprintExcludes,
    type GitFingerprint,
} from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** Run git in a fixture without depending on the developer's identity. */
function git(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=fp@example.com', '-c', 'user.name=fp-test', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'ignore',
    })
}

/** A committed repository with one tracked README. */
function repo(prefix = 'fingerprint-'): string {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n登录失败的处理写在 docs/guide.md。\n')
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'fixture'])
    return cwd
}

/** Write the three index artifact files under `.dsh/kb/`. */
function writeArtifact(cwd: string): void {
    const dir = path.join(cwd, '.dsh', 'kb')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}\n')
    fs.writeFileSync(path.join(dir, 'chunks.jsonl'), '')
    fs.writeFileSync(path.join(dir, 'postings.json'), '{}\n')
}

test('the declared exclusion removes the artifact from status, dirty and digest', () => {
    const cwd = repo('fingerprint-exclude-')
    writeArtifact(cwd)

    const excluded = fingerprintWithExcludes(cwd, { paths: ['.dsh/kb'] })
    assert.equal(excluded.isRepo, true)
    assert.equal(excluded.dirty, false)
    assert.equal(excluded.changedFiles, 0)
    assert.equal(excluded.diffDigest, sha256(''), 'a clean/excluded worktree has the empty diff digest')

    // The exclusion is an exclusion, not a blindfold: a tracked edit outside it
    // still moves the fingerprint.
    fs.appendFileSync(path.join(cwd, 'README.md'), '\n补充说明。\n')
    const edited = fingerprintWithExcludes(cwd, { paths: ['.dsh/kb'] })
    assert.equal(edited.dirty, true)
    assert.equal(edited.changedFiles, 1)
    assert.notEqual(edited.diffDigest, sha256(''))
    assert.deepEqual(changedPathsWithExcludes(cwd, { paths: ['.dsh/kb'] }), ['README.md'])
})

test('without -uall the artifact would return through its parent (the regression)', () => {
    const cwd = repo('fingerprint-uall-')
    // ONLY the artifact exists under `.dsh`. With `git status` collapsing the
    // untracked directory this becomes one `?? .dsh/` line; `-uall` plus the
    // `:(top,exclude,literal).dsh/kb` pathspec is what makes the answer zero.
    writeArtifact(cwd)
    assert.equal(fingerprintWithExcludes(cwd, { paths: ['.dsh/kb'] }).changedFiles, 0)
    assert.deepEqual(changedPathsWithExcludes(cwd, { paths: ['.dsh/kb'] }), [])
    // An empty exclusion set counts each untracked file individually (3), never
    // the collapsed directory (1) — that would be a different measurement.
    const everything = fingerprintWithExcludes(cwd, { paths: [] })
    assert.equal(everything.changedFiles, 3)
    assert.equal(everything.dirty, true)
})

test('head, branch and isRepo still come from gitFingerprint unchanged', () => {
    const cwd = repo('fingerprint-fields-')
    writeArtifact(cwd)
    const base = gitFingerprint(cwd)
    const excludes = fingerprintWithExcludes(cwd, { paths: ['.dsh/kb'] })
    assert.equal(excludes.isRepo, base.isRepo)
    assert.equal(excludes.head, base.head)
    assert.equal(excludes.branch, base.branch)
    // ... while the fields the exclusion exists for are recomputed.
    assert.notEqual(excludes.changedFiles, base.changedFiles)
})

test('a workspace outside git is a verdict, not a crash', () => {
    const cwd = tempWorkspace('fingerprint-norepo-')
    const fingerprint = fingerprintWithExcludes(cwd, { paths: ['.dsh/kb'] })
    assert.equal(fingerprint.isRepo, false)
    assert.equal(changedPathsWithExcludes(cwd, { paths: ['.dsh/kb'] }).length, 0)
})

test('sameFingerprint compares exactly the six fields the comparison uses', () => {
    const base: GitFingerprint = {
        isRepo: true,
        head: 'a'.repeat(40),
        branch: 'main',
        dirty: false,
        changedFiles: 0,
        diffDigest: sha256(''),
    }
    assert.equal(sameFingerprint(base, { ...base }), true)
    const different: Partial<GitFingerprint>[] = [
        { isRepo: false },
        { head: 'b'.repeat(40) },
        { branch: 'release' },
        { dirty: true },
        { changedFiles: 3 },
        { diffDigest: sha256('x') },
    ]
    for (const patch of different) {
        assert.equal(sameFingerprint(base, { ...base, ...patch }), false, `a changed ${Object.keys(patch)[0]} must be a difference`)
    }
    // Artifact metadata is not a workspace change: the manifest's algorithm and
    // exclusion declaration must not make an otherwise-equal fingerprint stale.
    const decorated = { ...base, algorithm: 'git-status-v1', excludes: ['.dsh/kb'] }
    assert.equal(sameFingerprint(base, decorated), true)
    assert.equal(sameFingerprint(decorated, base), true)
})

test('declared exclusions are normalised, and unusable entries exclude nothing', () => {
    assert.deepEqual(usableFingerprintExcludes(['./.dsh/kb/', '.dsh/kb']), ['.dsh/kb'])
    assert.deepEqual(usableFingerprintExcludes(['/abs', '../outside', '.', '', 'C:/drive']), [])
})

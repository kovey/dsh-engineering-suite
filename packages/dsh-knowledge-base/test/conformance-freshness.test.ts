/**
 * The conformance freshness dimension, compared FROM THE ARTIFACT'S DATA.
 *
 * The blind spot this file closes: `dsh-eng-core` cannot import this package
 * (cycle), so the conformance view used to know nothing about the knowledge-base
 * index except what the manifest said about itself. Comparing with its own idea
 * of "exclude .dsh" would never match a fingerprint built with "exclude
 * .dsh/kb" — a permanent false "stale", worse than "unknown".
 *
 * Every test here builds a REAL index in a real git fixture and asks the
 * conformance view. The manifest declares `algorithm: git-status-v1` and
 * `excludes: [".dsh/kb"]`; the view recomputes with exactly those.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    MissionStore,
    buildConformanceContext,
    fingerprintWithExcludes,
    missionConformance,
    resolveLayout,
    sameFingerprint,
    sha256,
    type ConformanceDimension,
    type GitFingerprint,
    type Layout,
} from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'
import {
    MANIFEST_FILE,
    buildIndex,
    indexFingerprint,
    loadIndex,
    stalenessOf,
} from '../dist/index-store.js'

const NOW = 1_760_000_000_000
const RECORDED_AT = 1_700_000_000_000
const POLICY = 'a'.repeat(64)
const MISSION_ID = 'kb-freshness'
const GATE_FINGERPRINT: GitFingerprint = {
    isRepo: true,
    head: 'c'.repeat(40),
    branch: 'main',
    dirty: false,
    changedFiles: 0,
    diffDigest: 'd'.repeat(64),
}
const SCRIPT = fileURLToPath(new URL('../../../scripts/kb.mjs', import.meta.url))

/** Run git in a fixture without depending on the developer's identity. */
function git(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=kb-conf@example.com', '-c', 'user.name=kb-conf-test', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'ignore',
    })
}

/** A committed repository with docs, and (optionally) a `.gitignore` for `.dsh/kb`. */
function repository(prefix: string, options: { ignoreKb?: boolean } = {}): string {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n登录失败的处理写在 docs/guide.md。\n')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# 部署指南\n\n发布流程：先跑 node --test。\n')
    if (options.ignoreKb === true) fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/kb/\n')
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'fixture'])
    return cwd
}

interface Seeded {
    cwd: string
    layout: Layout
    dir: string
}

/**
 * Seed one mission + one fingerprinted gate, commit the trail, then index.
 *
 * Committing BEFORE the build matters: the only untracked thing the fingerprint
 * can then see is the index artifact itself, which is exactly the thing the
 * exclusion must remove.
 */
function indexedRepository(prefix: string, options: { ignoreKb?: boolean } = {}): Seeded {
    const cwd = repository(prefix, options)
    const layout = resolveLayout(cwd)
    const store = new MissionStore({ layout })
    store.create({ title: '知识库新鲜度', cwd, id: MISSION_ID })
    store.recordGate(MISSION_ID, {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: '全部命令通过',
        results: [],
        fingerprint: GATE_FINGERPRINT,
    })
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'trail'])
    const config = resolveConfig({ logFile: path.join(tempWorkspace('kb-conf-log-'), 'kb.log'), maxFileBytes: 4096 })
    const built = buildIndex({ cwd, layout, config, now: RECORDED_AT })
    return { cwd, layout, dir: built.dir }
}

/** The freshness dimension of the seeded mission, with everything else injected. */
function freshnessOf(seeded: Pick<Seeded, 'cwd' | 'layout'>): ConformanceDimension {
    const context = buildConformanceContext({
        layout: seeded.layout,
        now: NOW,
        policy: { version: POLICY, files: [] },
        fingerprint: GATE_FINGERPRINT,
        requirements: { gateSource: 'dsh-quality-gate', requiredKinds: ['command', 'test'], source: '测试注入', blind: [] },
    })
    return missionConformance(context, MISSION_ID).dimensions.freshness
}

interface ParsedManifest {
    file: string
    value: Record<string, unknown>
}

/** Read the manifest as plain data (the same way the conformance view does). */
function manifestOf(cwd: string): ParsedManifest {
    const file = path.join(cwd, '.dsh', 'kb', MANIFEST_FILE)
    return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
}

/** Write the manifest back with human indentation, as a hand edit would. */
function writeManifest(manifest: ParsedManifest): void {
    fs.writeFileSync(manifest.file, `${JSON.stringify(manifest.value, undefined, 2)}\n`)
}

/** A byte snapshot of `.dsh` (relative path → digest). */
function snapshotDsh(cwd: string): Record<string, string> {
    const root = path.join(cwd, '.dsh')
    const out: Record<string, string> = {}
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) walk(target)
            else out[path.relative(root, target)] = sha256(fs.readFileSync(target))
        }
    }
    walk(root)
    return out
}

/** Mount the plugin in a throwaway log location (the log must not be a change). */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('kb-conf-log-'), 'knowledge-base.log'), maxFileBytes: 4096 })
    return fake
}

/** The three surfaces' verdicts about one fixture. */
async function verdicts(seeded: Seeded): Promise<{ kbStatus: boolean; script: boolean; conformance: boolean; statusText: string; scriptText: string }> {
    const statusText = runText(await host(seeded.cwd).runTool('kb_status'))
    const scriptText = execFileSync(process.execPath, [SCRIPT, 'status', seeded.cwd], { encoding: 'utf8' })
    return {
        kbStatus: /索引可能过期/.test(statusText),
        script: /⚠️ 新鲜度：/.test(scriptText),
        conformance: freshnessOf(seeded).state.startsWith('stale:'),
        statusText,
        scriptText,
    }
}

// ---------------------------------------------------------------------------
// 1. fresh
// ---------------------------------------------------------------------------

test('fresh: a freshly built index is fresh in the conformance view', () => {
    const seeded = indexedRepository('kb-conf-fresh-', { ignoreKb: true })
    const dimension = freshnessOf(seeded)
    assert.equal(dimension.state, 'fresh', dimension.detail)
    assert.ok(
        dimension.facts.some((fact) => /知识库索引的指纹与当前工作区一致（按 manifest 声明的 git-status-v1、排除集 \.dsh\/kb 复算）/.test(fact)),
        `facts: ${dimension.facts.join(' | ')}`,
    )
    assert.deepEqual(dimension.blind, [], 'a readable, recomputable index opens no blind line')
})

// ---------------------------------------------------------------------------
// 2. stale names the changed file
// ---------------------------------------------------------------------------

test('stale: a tracked file the index does not cover is named in the verdict', () => {
    const seeded = indexedRepository('kb-conf-stale-', { ignoreKb: true })
    fs.appendFileSync(path.join(seeded.cwd, '.gitignore'), '\n# 新规则\n')
    const dimension = freshnessOf(seeded)
    assert.match(dimension.state, /^stale:/)
    assert.match(dimension.detail, /知识库索引落后于工作区/)
    assert.match(dimension.detail, /\.gitignore/, `detail: ${dimension.detail}`)
})

// ---------------------------------------------------------------------------
// 3. the artifact must not make its own index stale (the -uall regression)
// ---------------------------------------------------------------------------

test('no self-staleness: an un-ignored `.dsh/kb/` still leaves the index fresh', () => {
    const seeded = indexedRepository('kb-conf-self-')
    assert.equal(fs.existsSync(path.join(seeded.cwd, '.gitignore')), false, 'the fixture must NOT gitignore the artifact')
    const manifest = manifestOf(seeded.cwd)
    const recorded = manifest.value['fingerprint'] as Record<string, unknown>
    assert.deepEqual(recorded['excludes'], ['.dsh/kb'])
    assert.equal(recorded['algorithm'], 'git-status-v1')

    // The direct regression: only the three artifact files are untracked, so a
    // status call WITHOUT `-uall` would report one `?? .dsh/` line and count 1.
    const recomputed = fingerprintWithExcludes(seeded.cwd, { paths: recorded['excludes'] as string[] })
    assert.equal(recomputed.changedFiles, 0, `recomputed: ${JSON.stringify(recomputed)}`)
    assert.equal(recomputed.dirty, false)
    assert.equal(sameFingerprint(recorded as unknown as GitFingerprint, recomputed), true)

    const dimension = freshnessOf(seeded)
    assert.equal(dimension.state, 'fresh', dimension.detail)
})

// ---------------------------------------------------------------------------
// 4. a legacy manifest is unknown, never fresh — and still readable by the package
// ---------------------------------------------------------------------------

test('legacy: a manifest without algorithm/excludes is unknown with the exact blind line', () => {
    const seeded = indexedRepository('kb-conf-legacy-', { ignoreKb: true })
    const manifest = manifestOf(seeded.cwd)
    const fingerprint = manifest.value['fingerprint'] as Record<string, unknown>
    delete fingerprint['algorithm']
    delete fingerprint['excludes']
    writeManifest(manifest)

    const dimension = freshnessOf(seeded)
    assert.equal(dimension.state, 'unknown', `legacy must never be fresh: ${dimension.state}`)
    assert.ok(dimension.blind.includes('旧索引未声明算法与排除集，无法复算'), `blind: ${dimension.blind.join(' | ')}`)

    // The package itself knows its own excludes, so it keeps answering: old
    // manifests stay readable, only the cross-package view refuses to guess.
    const loaded = loadIndex(seeded.dir)
    assert.ok(loaded.manifest !== undefined)
    assert.equal(stalenessOf(loaded.manifest.fingerprint, indexFingerprint(seeded.cwd, seeded.dir)).stale, false)
})

// ---------------------------------------------------------------------------
// 5. the DECLARED exclusions drive the recomputation
// ---------------------------------------------------------------------------

test('excludes drive the computation: hand-editing the manifest changes the verdict', () => {
    const seeded = indexedRepository('kb-conf-excludes-')
    assert.equal(freshnessOf(seeded).state, 'fresh', 'baseline: declared `.dsh/kb` makes it fresh')

    const manifest = manifestOf(seeded.cwd)
    const fingerprint = manifest.value['fingerprint'] as Record<string, unknown>
    const recorded = fingerprint as unknown as GitFingerprint
    fingerprint['excludes'] = []
    writeManifest(manifest)

    // The reader must honour `[]`, not its own idea of what to exclude: with no
    // declared exclusion the artifact itself becomes a visible change.
    const withoutExclusion = fingerprintWithExcludes(seeded.cwd, { paths: [] })
    assert.equal(sameFingerprint(recorded, withoutExclusion), false)
    const dimension = freshnessOf(seeded)
    assert.match(dimension.state, /^stale:/, dimension.detail)
    assert.match(dimension.detail, /排除集 （未排除任何路径）/)
    assert.match(dimension.detail, /\.dsh\/kb\//, `the changed artifact must be named: ${dimension.detail}`)
})

// ---------------------------------------------------------------------------
// 6. one comparison only
// ---------------------------------------------------------------------------

test('one comparison only: kb_status, scripts/kb.mjs and conformance agree', async () => {
    const seeded = indexedRepository('kb-conf-agree-', { ignoreKb: true })
    const before = await verdicts(seeded)
    assert.deepEqual(
        { kbStatus: before.kbStatus, script: before.script, conformance: before.conformance },
        { kbStatus: false, script: false, conformance: false },
        `fresh surface disagreement: ${JSON.stringify(before)}`,
    )
    assert.match(before.statusText, /新鲜度：与当前工作区指纹一致/)
    assert.doesNotMatch(before.scriptText, /新鲜度/)

    fs.appendFileSync(path.join(seeded.cwd, '.gitignore'), '\n# 触发一次真实改动\n')
    const after = await verdicts(seeded)
    assert.deepEqual(
        { kbStatus: after.kbStatus, script: after.script, conformance: after.conformance },
        { kbStatus: true, script: true, conformance: true },
        `stale surface disagreement: ${JSON.stringify(after)}`,
    )
})

// ---------------------------------------------------------------------------
// 7. determinism + read-only
// ---------------------------------------------------------------------------

test('the conformance freshness view is deterministic and read-only', () => {
    const seeded = indexedRepository('kb-conf-ro-', { ignoreKb: true })
    const before = snapshotDsh(seeded.cwd)
    const first = JSON.stringify(freshnessOf(seeded))
    const second = JSON.stringify(freshnessOf(seeded))
    const after = snapshotDsh(seeded.cwd)
    assert.equal(first, second, 'same tree → byte-identical dimension (including fact/state order)')
    assert.deepEqual(after, before, 'the view reads `.dsh` and writes nothing')
})

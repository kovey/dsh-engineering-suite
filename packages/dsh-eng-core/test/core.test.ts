/**
 * dsh-eng-core tests: mission store durability, the spec markdown round-trip,
 * and the deterministic command runner.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStore,
    MissionStoreRegistry,
    parseAcceptanceCriteria,
    parseSections,
    parseTestDesign,
    pathMatchesAny,
    pathMatchesPattern,
    renderSpecMarkdown,
    runCommand,
    sha256,
    splitCommand,
    createLogger,
    projectSlugOf,
    projectPathSlugOf,
    renderLogTemplate,
} from '../dist/index.js'

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-core-'))
}

function storeFor(cwd: string): MissionStore {
    return new MissionStoreRegistry().for(cwd)
}

test('missions, evidence, gates, receipts and stages persist under .dsh', () => {
    const cwd = workspace()
    const store = storeFor(cwd)
    const mission = store.create({ title: 'Wire the quality gate', cwd, sessionId: 'session-1' })

    assert.match(mission.id, /^wire-the-quality-gate-\d{8}-\d{6}$/)
    assert.equal(mission.status, 'draft')
    assert.ok(fs.existsSync(path.join(cwd, '.dsh', 'missions', mission.id, 'mission.json')))

    store.bindSession('session-1', mission.id)
    assert.equal(store.activeMissionId('session-1'), mission.id)
    assert.equal(store.resolve('session-1')?.id, mission.id)

    store.setStatus(mission.id, 'spec-approved')
    assert.equal(store.read(mission.id)?.status, 'spec-approved')

    const evidence = store.appendEvidence(mission.id, {
        kind: 'command',
        summary: 'pnpm test',
        recordedBy: 'tester',
        command: 'pnpm test',
        exitCode: 0,
        outputDigest: sha256('ok'),
    })
    assert.match(evidence.id, /^EV-\d{8}-\d{6}-001-[0-9a-f]{12}$/)
    assert.equal(store.readEvidence(mission.id).length, 1)

    const gate = store.recordGate(mission.id, {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: 'all required commands passed',
        results: [],
    })
    assert.equal(store.lastGate(mission.id, { state: 'PASS' })?.id, gate.id)
    // A gate run is evidence too.
    assert.equal(store.readEvidence(mission.id).length, 2)

    const receipt = store.issueReceipt(mission.id, {
        issuedBy: 'dsh-evidence-gate',
        gateId: gate.id,
        evidenceIds: [evidence.id],
    })
    assert.match(receipt.id, /^RCP-\d{8}-\d{6}-[0-9a-f]{8}$/)
    assert.ok(fs.existsSync(path.join(cwd, '.dsh', 'missions', mission.id, 'receipts', `${receipt.id}.json`)))
    assert.equal(store.readReceipts(mission.id).length, 1)

    const stagePath = store.writeStageResult(mission.id, {
        stageId: 'spec-clarify',
        attempt: 1,
        state: 'passed',
        enteredAt: Date.now(),
    })
    assert.ok(fs.existsSync(stagePath))
    assert.equal(store.listStageResults(mission.id).length, 1)

    // A second store instance over the same root sees the same state: the
    // plugins each hold their own registry.
    const other = new MissionStoreRegistry().for(cwd)
    assert.equal(other.read(mission.id)?.status, 'spec-approved')
    assert.equal(other.readEvidence(mission.id).length, 2)
})

test('a corrupt mission file reads as undefined instead of throwing', () => {
    const cwd = workspace()
    const store = storeFor(cwd)
    const mission = store.create({ title: 'corrupt me', cwd })
    fs.writeFileSync(path.join(cwd, '.dsh', 'missions', mission.id, 'mission.json'), '{not json')
    assert.equal(store.read(mission.id), undefined)
})

test('spec markdown round-trips criteria and the three test-design scenarios', () => {
    const cwd = workspace()
    const store = storeFor(cwd)
    const mission = store.create({ title: 'roundtrip', cwd })
    store.update(mission.id, () => ({
        status: 'spec-approved',
        spec: {
            title: 'roundtrip',
            background: 'why',
            requirements: ['do a thing'],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'the thing works' },
                { id: 'AC-002', text: 'the thing fails loudly' },
            ],
            fileBoundaries: ['src/**'],
            negativeConstraints: ['不得修改 dsh 核心代码'],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'approval',
        },
        testDesign: {
            cases: [
                {
                    id: 'TC-001',
                    kind: 'positive',
                    precondition: 'built',
                    steps: 'run it',
                    expected: 'exit 0',
                    covers: ['AC-001'],
                },
                { id: 'TC-002', kind: 'negative', precondition: 'broken', steps: 'run it', expected: 'exit 1', covers: ['AC-002'] },
                { id: 'TC-003', kind: 'boundary', precondition: 'empty', steps: 'run it', expected: 'exit 0', covers: ['AC-001'] },
            ],
            covered: ['AC-001', 'AC-002'],
            uncovered: [],
        },
    }))
    const record = store.read(mission.id)
    assert.ok(record !== undefined)
    const markdown = renderSpecMarkdown(record)
    assert.ok(markdown.includes('## 验收标准'))
    assert.ok(markdown.includes('## 测试设计'))

    const sections = parseSections(markdown)
    const criteria = parseAcceptanceCriteria(sections)
    assert.deepEqual(criteria, [
        { id: 'AC-001', text: 'the thing works' },
        { id: 'AC-002', text: 'the thing fails loudly' },
    ])
    const design = parseTestDesign(markdown)
    assert.equal(design.cases.length, 3)
    assert.deepEqual(
        design.cases.map((testCase) => [testCase.id, testCase.kind]),
        [
            ['TC-001', 'positive'],
            ['TC-002', 'negative'],
            ['TC-003', 'boundary'],
        ],
    )
    assert.deepEqual(design.covered, ['AC-001', 'AC-002'])
    assert.deepEqual(design.uncovered, [])

    // The spec artifact path is the one docs.md prescribes.
    const file = store.writeSpec(mission.id, markdown)
    assert.equal(file, path.join(cwd, '.dsh', 'specs', `${mission.id}.md`))
    assert.equal(store.read(mission.id)?.specPath, path.join('.dsh', 'specs', `${mission.id}.md`))
    assert.equal(store.read(mission.id)?.specDigest, sha256(markdown))
})

test('an uncovered acceptance criterion is reported by the parser', () => {
    const markdown = [
        '# t',
        '',
        '## 验收标准',
        '',
        '| 编号 | 验收标准 |',
        '|------|----------|',
        '| AC-001 | covered |',
        '| AC-002 | not covered |',
        '',
        '## 测试设计',
        '',
        '### 正向场景',
        '',
        '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
        '|--------|----------|----------|----------|--------------|',
        '| TC-001 | none | run | ok | AC-001 |',
        '',
    ].join('\n')
    const design = parseTestDesign(markdown)
    assert.deepEqual(design.uncovered, ['AC-002'])
})

test('splitCommand tokenises without a shell', () => {
    assert.deepEqual(splitCommand('pnpm test'), ['pnpm', 'test'])
    assert.deepEqual(splitCommand('node -e "console.log(1)"'), ['node', '-e', 'console.log(1)'])
    assert.deepEqual(splitCommand("sh -c 'a b'"), ['sh', '-c', 'a b'])
    assert.deepEqual(splitCommand('  a   b  '), ['a', 'b'])
    // An explicitly quoted empty token is a real argv element.
    assert.deepEqual(splitCommand('a "" b'), ['a', '', 'b'])
    assert.deepEqual(splitCommand("a '' b"), ['a', '', 'b'])
})

test('runCommand reports exit code, output and timeouts', async () => {
    const cwd = workspace()
    const ok = await runCommand({ argv: ['node', '-e', 'console.log("hello")'], cwd })
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.stdout.trim(), 'hello')
    assert.equal(ok.timedOut, false)

    const bad = await runCommand({ argv: ['node', '-e', 'process.exit(3)'], cwd })
    assert.equal(bad.exitCode, 3)

    const missing = await runCommand({ argv: ['definitely-not-a-real-binary-xyz'], cwd })
    assert.equal(missing.exitCode, null)
    assert.ok((missing.spawnError ?? '') !== '')

    const slow = await runCommand({ argv: ['node', '-e', 'setTimeout(() => {}, 5000)'], cwd, timeoutMs: 300 })
    assert.equal(slow.timedOut, true)
})

test('boundary patterns match the way a specification author expects', () => {
    // exact file
    assert.equal(pathMatchesPattern('README.md', 'README.md'), true)
    assert.equal(pathMatchesPattern('README.md', 'readme.md'), false)
    // a bare directory covers everything under it
    assert.equal(pathMatchesPattern('src', 'src/a/b.ts'), true)
    assert.equal(pathMatchesPattern('src', 'src'), true)
    assert.equal(pathMatchesPattern('src', 'srcx/a.ts'), false)
    // globs
    assert.equal(pathMatchesPattern('src/**', 'src/a/b.ts'), true)
    assert.equal(pathMatchesPattern('src/**/*.ts', 'src/a.ts'), true)
    assert.equal(pathMatchesPattern('src/**/*.ts', 'src/a/b.ts'), true)
    assert.equal(pathMatchesPattern('src/*.ts', 'src/a/b.ts'), false)
    assert.equal(pathMatchesPattern('*.json', 'package.json'), true)
    assert.equal(pathMatchesPattern('*.json', 'sub/package.json'), false)
    assert.equal(pathMatchesPattern('doc?.md', 'doc1.md'), true)
    assert.equal(pathMatchesPattern('doc?.md', 'doc12.md'), false)
    // traversal and absolute escapes never match a workspace-relative boundary
    assert.equal(pathMatchesAny(['src/**'], '../evil.ts'), false)
    assert.equal(pathMatchesAny([], 'src/a.ts'), false)
    assert.equal(pathMatchesAny(['src/**', 'tests/**'], 'tests/a.ts'), true)
})

test('a subprocess service that never settles still times out (regression)', async () => {
    const cwd = workspace()
    let terminated = 0
    const hung = {
        spawn: () => ({
            done: new Promise<never>(() => undefined),
            collected: {},
            terminate: () => {
                terminated += 1
            },
        }),
    } as never
    const started = Date.now()
    const outcome = await runCommand({ argv: ['sleep', '999'], cwd, timeoutMs: 100, graceMs: 100 }, hung)
    assert.equal(outcome.timedOut, true)
    assert.equal(outcome.exitCode, null)
    assert.equal(terminated, 1, 'the provider must be asked to terminate')
    assert.ok(Date.now() - started < 5_000)
})

test('an already-aborted signal never starts a command (regression)', async () => {
    const cwd = workspace()
    const controller = new AbortController()
    controller.abort()
    const outcome = await runCommand({ argv: ['node', '-e', 'console.log("ran")'], cwd, signal: controller.signal })
    assert.equal(outcome.aborted, true)
    assert.equal(outcome.stdout, '')
    assert.equal(outcome.exitCode, null)
})

test('a timed-out command does not leave grandchildren behind', async (t) => {
    if (process.platform === 'win32') {
        t.skip('process groups are POSIX-only here')
        return
    }
    // The sandbox denies `ps` in some environments; skip rather than assert on
    // an unverifiable fact.
    const canList = (): boolean => {
        try {
            execFileSync('ps', ['-eo', 'pid'], { encoding: 'utf8' })
            return true
        } catch {
            return false
        }
    }
    if (!canList()) {
        t.skip('process listing is unavailable in this sandbox')
        return
    }
    const cwd = workspace()
    const marker = `eng-grandchild-${process.pid}-${Date.now()}`
    const outcome = await runCommand({
        argv: [
            'node',
            '-e',
            `require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)`,
            marker,
        ],
        cwd,
        timeoutMs: 300,
        graceMs: 200,
    })
    assert.equal(outcome.timedOut, true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const listing = (() => {
        try {
            return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
        } catch {
            return ''
        }
    })()
    const survivors = listing.split('\n').filter((line) => /[s]leep 60/.test(line)).length
    assert.equal(survivors, '0', `grandchildren survived the timeout: ${survivors}`)
})

test('two missions created in the same second never share an id (regression)', () => {
    const cwd = workspace()
    const store = storeFor(cwd)
    const first = store.create({ title: 'same title', cwd })
    const second = store.create({ title: 'same title', cwd })
    const third = store.create({ title: 'same title', cwd })
    assert.notEqual(first.id, second.id)
    assert.notEqual(second.id, third.id)
    // Same second → the suffix disambiguates; a second boundary crossed between
    // the calls legitimately produces a different stamp instead.
    for (const id of [first.id, second.id, third.id]) {
        assert.match(id, /^same-title-\d{8}-\d{6}(-\d+)?$/)
    }
    assert.equal(store.list().length, 3)
    // An explicit id stays idempotent.
    const explicit = store.create({ title: 'other', cwd, id: 'fixed-id' })
    assert.equal(store.create({ title: 'other again', cwd, id: 'fixed-id' }).id, explicit.id)
})

test('the logger routes per workspace and still greps when it cannot (regression)', () => {
    const dir = workspace()
    const wsA = path.join(dir, 'proj-a')
    const wsB = path.join(dir, 'proj-b')
    fs.mkdirSync(wsA, { recursive: true })
    fs.mkdirSync(wsB, { recursive: true })
    const file = path.join(dir, 'shared.log')
    const logger = createLogger({ tag: 't', file, template: path.join(dir, 'logs', '{project}', 't.log') })

    logger.info('unbound line')
    logger.for(wsA).info('a line')
    logger.for(wsB).info('b line')
    logger.for(wsA).info('a line 2')
    logger.for(undefined).info('still unbound')

    // With a template the shared file keeps only the unattributable lines: the
    // whole point is that projects do NOT interleave any more.
    const shared = fs.readFileSync(file, 'utf8')
    assert.match(shared, /unbound line/)
    assert.match(shared, /still unbound/)
    assert.doesNotMatch(shared, /a line/)
    assert.doesNotMatch(shared, /b line/)

    // Each workspace got its own file, and the two projects never interleave.
    const aFile = logger.for(wsA).file ?? ''
    const bFile = logger.for(wsB).file ?? ''
    assert.notEqual(aFile, bFile)
    // Readable: the last two path segments + a short digest.
    assert.match(aFile, /logs\/.+-proj-a-[0-9a-f]{6}\/t\.log$/)
    assert.match(path.basename(path.dirname(aFile)), new RegExp(`^${path.basename(path.dirname(wsA))}-proj-a-[0-9a-f]{6}$`))
    const a = fs.readFileSync(aFile, 'utf8')
    const b = fs.readFileSync(bFile, 'utf8')
    assert.match(a, /a line/)
    assert.match(a, /a line 2/)
    assert.doesNotMatch(a, /b line/)
    assert.doesNotMatch(b, /a line/)
    // Same basename in different directories must not share a file.
    const wsA2 = path.join(dir, 'other', 'proj-a')
    fs.mkdirSync(wsA2, { recursive: true })
    assert.notEqual(logger.for(wsA2).file, logger.for(wsA).file)
    // Binding is memoized: repeated lookups are the same object.
    assert.equal(logger.for(wsA), logger.for(wsA))
})

test('without a template the scoped logger keeps the single configured file (regression)', () => {
    // No template = one file (deployment decision), but every scoped line names
    // its project so the interleaved log is still greppable.
    const dir = workspace()
    const file = path.join(dir, 'plain.log')
    const logger = createLogger({ tag: 't', file })
    logger.for(path.join(dir, 'ws')).warn('scoped but shared')
    assert.equal(logger.for(path.join(dir, 'ws')).file, file)
    assert.match(fs.readFileSync(file, 'utf8'), /\[ws\] scoped but shared/)
})

test('log templates offer readable project ids (regression)', () => {
    const home = process.env['HOME'] ?? ''
    const ws = path.join(home, 'workspace', 'deepseek', 'dsh-project')
    // `{project}`: recognisable (two segments) and unique (short digest).
    const slug = projectSlugOf(ws)
    assert.match(slug, /^deepseek-dsh-project-[0-9a-f]{6}$/)
    assert.equal(slug, projectSlugOf(ws), 'deterministic across calls')
    // Same basename in a different parent must not collide.
    assert.notEqual(projectSlugOf(path.join(home, 'personal', 'dsh-project')), slug)
    // `{projectPath}`: fully readable, no digest at all.
    assert.equal(projectPathSlugOf(ws), 'workspace-deepseek-dsh-project')
    assert.equal(projectPathSlugOf(path.join(home, 'a', 'dsh-project')), 'a-dsh-project')
    // Outside $HOME the whole path is used, still readable.
    assert.equal(projectPathSlugOf('/opt/repos/api'), 'opt-repos-api')
    // The rendered template keeps the rest of the path intact.
    assert.equal(
        renderLogTemplate('~/.dsh/logs/{projectPath}/{basename}-{tag}.log', 'quality-gate', ws),
        '~/.dsh/logs/workspace-deepseek-dsh-project/dsh-project-quality-gate.log',
    )
})

test('a rejection invalidates the approval it reviewed and advances the round (regression)', () => {
    const cwd = workspace()
    const store = storeFor(cwd)
    const mission = store.create({ title: 'approval loop', cwd })
    store.update(mission.id, () => ({
        status: 'spec-approved',
        spec: {
            title: 't', background: '', requirements: [], acceptanceCriteria: [],
            fileBoundaries: [], negativeConstraints: [], revision: 1,
            createdAt: Date.now(), updatedAt: Date.now(), approvedAt: Date.now(), approvedBy: 'approval',
        },
    }))
    assert.equal(store.nextApprovalRound(mission.id), 1)

    const rejected = store.recordApproval(mission.id, { state: 'rejected', round: 1, at: Date.now(), by: 'approval', note: '验收标准不全' })
    // The rejection clears the approval: every write path must agree the
    // mission is not approved while the model revises.
    assert.equal(rejected?.spec?.approvedAt, undefined)
    assert.equal(rejected?.approval?.state, 'rejected')
    assert.equal(rejected?.approval?.note, '验收标准不全')
    assert.equal(store.nextApprovalRound(mission.id), 2)

    const approved = store.recordApproval(mission.id, { state: 'approved', round: 2, at: Date.now(), by: 'approval' })
    assert.equal(approved?.approval?.round, 2)
    assert.equal(approved?.spec?.approvedAt, undefined, 'the tool sets approvedAt, not the recorder')
    assert.equal(store.nextApprovalRound(mission.id), 3)
})

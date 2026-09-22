/**
 * dsh-spec-gate tests: assembly surface, specification artifact, and the
 * write guard's allow/deny paths (the gate must fail closed).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, specReviewDigest } from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'

function fakeAgentFor(cwd: string, id: string, sessionId: string) {
    return fakeAgent(cwd, id, sessionId)
}
import { apply, inject, name } from '../dist/index.js'
import { parseConstraints } from '../dist/constraints.js'

const TEST_DESIGN = [
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动 | 请求 /health | 返回 200 | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口被占用 | 启动服务 | 退出码非 0 并打印原因 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 配置为空 | 启动服务 | 使用默认端口 | AC-001 |',
    '',
].join('\n')

function host(options: { approvalOutcome?: 'allowed-once' | 'rejected'; cwd?: string } = {}): FakeHost {
    const cwd = options.cwd ?? tempWorkspace('spec-gate-')
    const fake = createFakeHost({
        cwd,
        ...(options.approvalOutcome === undefined ? {} : { approvalOutcome: options.approvalOutcome }),
    })
    apply(fake.ctx as never, { logFile: path.join(fake.cwd, 'spec-gate.log') })
    return fake
}

const DRAFT = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: ['暴露 GET /health'],
    acceptanceCriteria: ['GET /health 返回 200', '端口占用时启动失败'],
    fileBoundaries: ['src/server.ts'],
    negativeConstraints: ['不得修改 dsh 核心代码'],
    testDesign: TEST_DESIGN,
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-spec-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the three tools, the guard and the prompt section', () => {
    const fake = host()
    assert.deepEqual([...fake.tools.keys()].sort(), ['spec_approve', 'spec_bootstrap', 'spec_create', 'spec_status'])
    assert.equal(fake.guards.length, 1)
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:spec-gate'],
    )
    fake.dispose()
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.guards.length, 0)
    assert.equal(fake.sections.length, 0)
})

test('spec_create writes the specification artifact and the mission record', async () => {
    const fake = host()
    const run = await fake.runTool('spec_create', DRAFT)
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /规格已写入/)

    const specFiles = fs.readdirSync(path.join(fake.cwd, '.dsh', 'specs'))
    assert.equal(specFiles.length, 1)
    const missionId = specFiles[0]?.replace(/\.md$/, '') ?? ''
    const markdown = fs.readFileSync(path.join(fake.cwd, '.dsh', 'specs', `${missionId}.md`), 'utf8')
    assert.ok(markdown.includes('| AC-001 | GET /health 返回 200 |'))
    assert.ok(markdown.includes('TC-002'))

    const mission = JSON.parse(
        fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'mission.json'), 'utf8'),
    ) as { status: string; testDesign?: { cases: unknown[]; uncovered: string[] } }
    assert.equal(mission.status, 'draft')
    assert.equal(mission.testDesign?.cases.length, 3)
    assert.deepEqual(mission.testDesign?.uncovered, [])
})

test('spec_create rejects an incomplete draft instead of writing a hollow spec', async () => {
    const fake = host()
    const run = await fake.runTool('spec_create', { ...DRAFT, acceptanceCriteria: [], negativeConstraints: [] })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /acceptanceCriteria/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs')), false)
})

test('the write guard denies writes until the specification is approved', async () => {
    const fake = host()
    // No mission at all → denied.
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }) ?? '', /没有已登记的规格/)

    await fake.runTool('spec_create', DRAFT)
    const denied = fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent })
    assert.match(denied ?? '', /尚未审批/)
    assert.match(denied ?? '', /spec_approve/)

    // Read-only tools and the gate's own artifact directory stay open.
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: '.dsh/specs/x.md' }, agent: fake.agent }), undefined)
    // ... and so does another workspace's write, which has its own mission.
    const otherCwd = tempWorkspace('spec-gate-other-')
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'a.ts' }, agent: { id: 'a', session: { id: 's', header: { id: 's', cwd: otherCwd } } } })?.startsWith('spec-gate: 该会话没有已登记的规格') ?? false, true)
})

test('spec_approve asks the human through the approval seam and unlocks writes', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    const run = await fake.runTool('spec_approve', { note: 'ready' })
    assert.equal(run.isError, false, runText(run))
    assert.equal(fake.approvalRequests.length, 1)

    const missionId = fs.readdirSync(path.join(fake.cwd, '.dsh', 'specs'))[0]?.replace(/\.md$/, '') ?? ''
    const mission = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'missions', missionId, 'mission.json'), 'utf8')) as {
        status: string
        spec: { approvedBy?: string }
    }
    assert.equal(mission.status, 'spec-approved')
    assert.equal(mission.spec.approvedBy, 'approval')
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }), undefined)
})

test('a rejected approval leaves the mission unwritable (fail closed)', async () => {
    const fake = host({ approvalOutcome: 'rejected' })
    await fake.runTool('spec_create', DRAFT)
    const run = await fake.runTool('spec_approve', {})
    // A rejection is a first-class review outcome, not a crash: the model gets
    // the loop instructions instead of an opaque error.
    assert.match(runText(run), /打回/)
    assert.match(runText(run), /spec_create/)
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }) ?? '', /尚未审批/)
})

test('requireTestDesign blocks approval until the design is reviewed', async () => {
    const cwd = tempWorkspace('spec-gate-design-')
    const fake = createFakeHost({ cwd })
    // A sibling test-design gate is mounted (its review tool is registered),
    // but this draft carries no test design at all.
    fake.tools.set('test_design_review', {
        name: 'test_design_review',
        description: 'stub',
        parameters: {},
        execute: async () => 'ok',
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await fake.runTool('spec_create', { ...DRAFT, testDesign: '' })
    const run = await fake.runTool('spec_approve', {})
    assert.equal(run.isError, true)
    assert.match(String(run.content), /缺少测试设计/)

    // With a design that has not passed review the approval is still refused.
    await fake.runTool('spec_create', DRAFT)
    const stillBlocked = await fake.runTool('spec_approve', {})
    assert.equal(stillBlocked.isError, true)
    assert.match(String(stillBlocked.content), /尚未通过评审/)
})

test('spec_status reports the mission without any mission present', async () => {
    const fake = host()
    const run = await fake.runTool('spec_status', {})
    assert.match(runText(run), /没有绑定 mission/)
})

test('a delegated child inherits the parent session mission', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const child = {
        id: 'child-agent',
        session: { id: 'child-session', header: { id: 'child-session', cwd: fake.cwd, parentSession: 'session-1', origin: 'subagent' } },
    }
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: child }), undefined)
})

test('a specification revision revokes the previous test-design verdict (regression)', async () => {
    // The dangerous path found in the audit: revise the specification by adding
    // an acceptance criterion WITHOUT supplying a new test design. The old
    // verdict (`passed: true`) covered criteria that no longer match, so it must
    // not authorise the new revision.
    const cwd = tempWorkspace('spec-gate-revise-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    fake.tools.set('test_design_review', {
        name: 'test_design_review',
        description: 'stub (marks the design reviewed)',
        parameters: {},
        execute: async (_args: never, exec: never) => {
            const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent
            const store = new MissionStoreRegistry().for(agent?.session?.header?.cwd ?? cwd)
            const mission = store.active('session-1')
            if (mission === undefined) throw new Error('no mission')
            const design = mission.testDesign
            if (design === undefined) throw new Error('no design')
            store.setTestDesign(mission.id, { ...design, passed: true, reviewedAt: Date.now(), specDigest: specReviewDigest(mission.spec, design) })
            return 'ok'
        },
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })

    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('test_design_review', {})
    const first = await fake.runTool('spec_approve', {})
    assert.equal(first.isError, false, runText(first))

    // Revision: one more acceptance criterion, no test design supplied.
    const { testDesign: _droppedDesign, ...withoutDesign } = DRAFT
    const revised = await fake.runTool('spec_create', {
        ...withoutDesign,
        acceptanceCriteria: [...DRAFT.acceptanceCriteria, '端口占用时打印占用者'],
    })
    assert.equal(revised.isError, false, runText(revised))
    const stores = new MissionStoreRegistry().for(cwd)
    const mission = stores.active('session-1')
    assert.equal(mission?.status, 'draft')
    assert.equal(mission?.testDesign, undefined, 'the stale design must be dropped by the revision')

    const second = await fake.runTool('spec_approve', {})
    assert.equal(second.isError, true)
    assert.match(String(second.content), /缺少测试设计|尚未通过评审/)
})

test('a verdict bound to different criteria cannot authorise the specification (regression)', async () => {
    // Defence in depth: even if something rewrites the specification record
    // behind spec_create's back, the digest binding refuses the stale verdict.
    const cwd = tempWorkspace('spec-gate-digest-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), requireTestDesign: true })
    const stores = new MissionStoreRegistry().for(cwd)
    await fake.runTool('spec_create', DRAFT)
    const mission = stores.active('session-1')
    assert.ok(mission?.spec !== undefined && mission.testDesign !== undefined)

    // A verdict that claims PASS but was computed over a DIFFERENT criteria set.
    stores.setTestDesign(mission.id, {
        ...mission.testDesign,
        passed: true,
        specDigest: specReviewDigest(
            { acceptanceCriteria: [{ id: 'AC-001', text: '完全不同的验收标准' }] },
            mission.testDesign,
        ),
    })
    const run = await fake.runTool('spec_approve', {})
    assert.equal(run.isError, true)
    assert.match(String(run.content), /评审针对的不是当前规格/)
    assert.match(String(run.content), /test_design_review/)
})

test('writes outside the declared file boundaries are denied (regression)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const write = (target: string) => fake.guardReason({ name: 'write', arguments: { file_path: target }, agent: fake.agent })

    // Inside the declared boundary → allowed.
    assert.equal(write('src/server.ts'), undefined)
    // Outside it → denied with the boundary list and the spec-amendment route.
    const denied = write('README.md')
    assert.match(denied ?? '', /不在规格声明的文件边界内/)
    assert.match(denied ?? '', /src\/server\.ts/)
    assert.match(denied ?? '', /spec_create/)
    // Traversal and absolute escapes are denied too.
    assert.match(write('src/../README.md') ?? '', /不在规格声明的文件边界内/)
    assert.match(write('/etc/passwd') ?? '', /不在规格声明的文件边界内/)
    // The gate's own artifact root stays writable.
    assert.equal(write('.dsh/specs/note.md'), undefined)
    // Configured exemptions are honoured.
    const exempt = host({ cwd: tempWorkspace('spec-gate-exempt-'), approvalOutcome: 'allowed-once' })
    assert.equal(exempt.guards.length, 1)
})

test('boundary enforcement can be switched off by the host', async () => {
    const cwd = tempWorkspace('spec-gate-noboundary-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto', enforceBoundaries: false })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    assert.equal(fake.guardReason({ name: 'write', arguments: { file_path: 'README.md' }, agent: fake.agent }), undefined)
})

test('a submitted test-design row can never silently disappear from the artifact (regression)', async () => {
    const row = (id: string): string => `| ${id} | 前置条件足够长 | 操作步骤足够长 | 预期结果足够长 | AC-001 |`
    const header = ['| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |', '|--------|----------|----------|----------|--------------|']
    const variants: { name: string; design: string; cases: number }[] = [
        {
            name: 'canonical',
            design: ['### 正向场景', '', ...header, row('TC-001'), '', '### 异常场景', '', ...header, row('TC-002'), '', '### 边界场景', '', ...header, row('TC-003')].join('\n'),
            cases: 3,
        },
        {
            name: 'rows without leading pipes',
            design: ['### 正向场景', '', '用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准', `TC-001 | 前置条件足够长 | 操作步骤足够长 | 预期结果足够长 | AC-001`].join('\n'),
            cases: 1,
        },
        {
            name: 'full-width pipes',
            design: ['### 正向场景', '', '｜用例ID｜前置条件｜操作步骤｜预期结果｜覆盖验收标准｜', '｜---｜---｜---｜---｜---｜', '｜TC-001｜前置条件足够长｜操作步骤足够长｜预期结果足够长｜AC-001｜'].join('\n'),
            cases: 1,
        },
        {
            name: 'no header row',
            design: ['### 正向场景', '', row('TC-001'), row('TC-002')].join('\n'),
            cases: 2,
        },
        {
            name: 'full-width dash separator',
            design: ['### 正向场景', '', ...header, '｜－－－－｜－－－－｜－－－－｜－－－－｜－－－－｜', row('TC-001')].join('\n'),
            cases: 1,
        },
    ]
    for (const variant of variants) {
        const cwd = tempWorkspace(`spec-gate-loss-`)
        const fake = createFakeHost({ cwd })
        apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
        const run = await fake.runTool('spec_create', { ...DRAFT, testDesign: variant.design })
        assert.equal(run.isError, false, `${variant.name}: ${runText(run)}`)
        const mission = new MissionStoreRegistry().for(cwd).active('session-1')
        assert.equal(mission?.testDesign?.cases.length, variant.cases, `${variant.name} must keep every submitted row`)
        // The artifact is rendered from the parse: the same rows must appear in it.
        const artifact = fs.readFileSync(path.join(cwd, '.dsh', 'specs', `${mission?.id}.md`), 'utf8')
        for (const testCase of mission?.testDesign?.cases ?? []) {
            assert.ok(artifact.includes(testCase.id), `${variant.name}: ${testCase.id} missing from the artifact`)
        }
    }
})

test('an unparseable design table is rejected instead of being silently dropped (regression)', async () => {
    const fake = host()
    const run = await fake.runTool('spec_create', {
        ...DRAFT,
        testDesign: ['### 正常场景', '', '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |', '|---|---|---|---|---|', '| TC-001 | 足够长的前置条件 | 足够长的操作步骤 | 足够长的预期结果 | AC-001 |'].join('\n'),
    })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /无法识别的场景标题/)
    assert.match(String(run.content), /正向场景/)
})

test('approval and status never fall back to another session\'s mission (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-strict-')
    const owner = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(owner.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await owner.runTool('spec_create', DRAFT)

    // A second session in the same workspace has no binding of its own.
    const intruder = createFakeHost({ cwd, agent: fakeAgentFor(cwd, 'agent-2', 'session-2'), approvalOutcome: 'allowed-once' })
    apply(intruder.ctx as never, { logFile: path.join(cwd, 'spec-gate-2.log'), approval: 'auto' })
    const approve = await intruder.runTool('spec_approve', {})
    assert.equal(approve.isError, true)
    assert.match(String(approve.content), /没有绑定任何 mission/)
    assert.match(String(approve.content), /missionId/)

    const status = runText(await intruder.runTool('spec_status', {}))
    assert.match(status, /没有绑定 mission/)

    // ... and a bound-but-corrupt mission state fails closed instead of retargeting.
    const stores = new MissionStoreRegistry().for(cwd)
    const bound = stores.active('session-1')
    assert.ok(bound !== undefined)
    fs.writeFileSync(path.join(cwd, '.dsh', 'missions', bound.id, 'mission.json'), '{not json')
    const corrupt = await owner.runTool('spec_approve', {})
    assert.equal(corrupt.isError, true)
    assert.match(String(corrupt.content), /损坏/)
})

test('approval refuses when the artifact no longer matches the record (regression)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    const mission = new MissionStoreRegistry().for(fake.cwd).active('session-1')
    assert.ok(mission !== undefined)
    // An out-of-band edit (a human, another tool, an older session) changes the
    // document the human would be asked to approve.
    fs.appendFileSync(path.join(fake.cwd, '.dsh', 'specs', `${mission.id}.md`), '\n\n偷偷改一行。\n')
    const run = await fake.runTool('spec_approve', {})
    assert.equal(run.isError, true)
    assert.match(String(run.content), /工件与记录不一致/)
})

test('the approval request carries the digest and the counts, not just a title (regression)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const request = fake.approvalRequests[0] as { reason?: string } | undefined
    assert.match(request?.reason ?? '', /摘要/)
    assert.match(request?.reason ?? '', /验收标准 2 条/)
    assert.match(request?.reason ?? '', /用例 3 条/)
})

test('spec_create with an unknown explicit missionId refuses instead of creating another mission (regression)', async () => {
    const fake = host()
    const run = await fake.runTool('spec_create', { ...DRAFT, missionId: 'does-not-exist' })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /不存在/)
    const run2 = await fake.runTool('spec_create', { ...DRAFT, missionId: '../../escape' })
    assert.equal(run2.isError, true)
    assert.match(String(run2.content), /unsafe mission id|不存在/)
})

test('shell writes are boundary-checked like write-tool calls (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-shell-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const shell = (command: string) => fake.guardReason({ name: 'bash', arguments: { command }, agent: fake.agent })

    // Inside the declared boundary → allowed.
    assert.equal(shell('echo ok > src/server.ts'), undefined)
    assert.equal(shell("sed -i 's/a/b/' src/server.ts"), undefined)
    assert.equal(shell('node -e "console.log(1)"'), undefined)
    // Outside it → denied, with the boundary list.
    assert.match(shell('echo pwned > README.md') ?? '', /不在规格声明的文件边界内/)
    assert.match(shell('sed -i "" s/a/b/ ../../outside.ts') ?? '', /不在规格声明的文件边界内/)
    assert.match(shell('rm -rf src/server.ts.bak && cp /etc/hosts ../../hosts') ?? '', /不在规格声明的文件边界内/)
    // The engineering trail is the trust root, not a boundary question.
    assert.match(shell('echo x > .dsh/missions/m1/mission.json') ?? '', /信任根/)
    // A shell call without a command cannot be checked → fail closed.
    assert.match(fake.guardReason({ name: 'bash', arguments: {}, agent: fake.agent }) ?? '', /找不到命令参数/)
})

test('shellPolicy=strict refuses commands whose targets cannot be attributed (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-shellstrict-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto', shellPolicy: 'strict' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const shell = (command: string) => fake.guardReason({ name: 'bash', arguments: { command }, agent: fake.agent })
    assert.match(shell('git checkout -- .') ?? '', /strict/)
    assert.match(shell('find src -name "*.ts" -delete') ?? '', /strict/)
    // An attributable, in-boundary command still runs.
    assert.equal(shell('echo ok > src/server.ts'), undefined)

    // shellPolicy=off skips shell analysis entirely.
    const off = createFakeHost({ cwd: tempWorkspace('spec-gate-shelloff-'), approvalOutcome: 'allowed-once' })
    apply(off.ctx as never, { logFile: path.join(cwd, 'off.log'), approval: 'auto', shellPolicy: 'off' })
    await off.runTool('spec_create', DRAFT)
    await off.runTool('spec_approve', {})
    assert.equal(off.guardReason({ name: 'bash', arguments: { command: 'echo x > README.md' }, agent: off.agent }), undefined)
})

test('declarative negative constraints are enforced on every gated call (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-constraints-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await fake.runTool('spec_create', {
        ...DRAFT,
        negativeConstraints: [
            'path:src/core/**',
            'tool:web_search',
            'cmd:rm -rf',
            'argv:"deploy"\\s*:\\s*true',
            '不得修改 dsh 核心代码',
        ],
    })
    await fake.runTool('spec_approve', {})
    const call = (name: string, args: Record<string, unknown>) => fake.guardReason({ name, arguments: args, agent: fake.agent })

    // path: denies matching write targets (write tool, boundary or not).
    assert.match(call('write', { file_path: 'src/core/engine.ts' }) ?? '', /负面约束禁止改动/)
    assert.equal(call('write', { file_path: 'src/server.ts' }), undefined)
    // ... and matching shell targets.
    assert.match(call('bash', { command: 'echo x > src/core/engine.ts' }) ?? '', /负面约束禁止改动/)
    // tool: denies the tool itself, even a non-write tool.
    assert.match(call('web_search', { query: 'x' }) ?? '', /禁止调用工具/)
    assert.equal(call('read', { file_path: 'src/server.ts' }), undefined)
    // cmd: denies a shell command containing the string.
    assert.match(call('bash', { command: 'rm -rf src/tmp' }) ?? '', /禁止命令中出现/)
    // argv: a regex over any tool's serialized arguments.
    assert.match(call('write', { file_path: 'src/server.ts', deploy: true }) ?? '', /禁止这样的参数/)

    // The reporting surface distinguishes enforced from advisory constraints.
    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /可机器校验 4 条/)
    assert.match(status, /仅提示级 1 条/)
})

test('constraint parsing fails open to advisory, never to a crash (regression)', () => {
    const parsed = parseConstraints([
        'path:src/**',
        'tool:bash',
        'cmd:rm -rf',
        'argv:[unclosed',
        'argv:ok.*',
        '不得修改 dsh 核心代码',
        'path:',
    ])
    assert.deepEqual(
        parsed.enforced.map((entry) => `${entry.kind}:${entry.value}`),
        ['path:src/**', 'tool:bash', 'cmd:rm -rf', 'argv:ok.*'],
    )
    assert.equal(parsed.advisory.length, 3)
    assert.match(parsed.advisory.join('\n'), /正则无法编译/)
})

test('reads are never blocked by write-scoped rules (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-reads-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await fake.runTool('spec_create', { ...DRAFT, negativeConstraints: ['path:src/core/**', '不得修改 dsh 核心代码'] })
    await fake.runTool('spec_approve', {})
    // A read tool names a file, but it modifies nothing: the trust root and the
    // `path:` constraints must not turn into read bans.
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/core/engine.ts' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: '.dsh/missions/x/mission.json' }, agent: fake.agent }), undefined)
    assert.equal(fake.guardReason({ name: 'grep', arguments: { path: '.dsh/specs' }, agent: fake.agent }), undefined)
    // The write side is still enforced.
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/core/engine.ts' }, agent: fake.agent }) ?? '', /负面约束禁止改动/)
})

test('read-only shell stays usable before approval, writes do not (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-shellpre-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'auto' })
    await fake.runTool('spec_create', DRAFT)  // mission exists, NOT approved
    const shell = (command: string) => fake.guardReason({ name: 'bash', arguments: { command }, agent: fake.agent })

    // Looking around is not a write: `ls`, `git status`, `npm test` keep working
    // while the specification is still being written.
    assert.equal(shell('ls -la'), undefined)
    assert.equal(shell('git status --porcelain'), undefined)
    assert.equal(shell('npm test'), undefined)
    assert.equal(shell('git checkout -- src/server.ts') ?? '', '', 'unattributable writes are only refused under strict')
    // An attributable write is a write — and needs the approval.
    assert.match(shell('echo x > src/server.ts') ?? '', /尚未审批/)
    assert.match(shell('sed -i "" s/a/b/ src/server.ts') ?? '', /尚未审批/)
})

test('a project can opt out of enforcement without touching the profile (regression)', async () => {
    // A scratch repository and a controlled one live in the SAME process: the
    // overlay must be per workspace, never global.
    const cwd = tempWorkspace('spec-gate-projcfg-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })

    const scratch = tempWorkspace('spec-gate-scratch-')
    fs.mkdirSync(path.join(scratch, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(scratch, '.dsh', 'spec-gate.json'), JSON.stringify({ enforce: false }))
    const scratchAgent = fakeAgent(scratch, 'agent-s', 'session-s')
    assert.equal(
        fake.guardReason({ name: 'write', arguments: { file_path: 'anything.ts' }, agent: scratchAgent }),
        undefined,
        'the scratch repo opted out',
    )

    // The ungated repo still gets the tools and a status that names the source.
    const status = runText(await fake.runTool('spec_status', {}, { agent: scratchAgent }))
    assert.match(status, /配置来源：项目级/)

    // Every other workspace keeps the profile's enforcement.
    const controlled = tempWorkspace('spec-gate-controlled-')
    const controlledAgent = fakeAgent(controlled, 'agent-c', 'session-c')
    assert.match(
        fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: controlledAgent }) ?? '',
        /没有已登记的规格/,
    )
})

test('project-level keys may narrow but not relocate or disable the plugin (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-projkeys-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'spec-gate.json'),
        JSON.stringify({ enabled: false, logFile: '/tmp/evil.log', rootDir: '/tmp', shellPolicy: 'strict' }),
    )
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    // The forbidden keys were ignored: writes are still gated…
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }) ?? '', /没有已登记的规格/)
    // …while the allowed key took effect.
    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /策略 strict/)
    // A malformed file falls back to the profile instead of failing open.
    fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), 'not json at all')
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }) ?? '', /没有已登记的规格/)
})

test('a project file whose keys were all refused reports the profile as the source (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-provenance-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), JSON.stringify({ enabled: false, logFile: '/tmp/x.log' }))
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /配置来源：profile/)
    assert.doesNotMatch(status, /配置来源：项目级/)
})

test('the prompt section follows the calling workspace (regression)', async () => {
    // Two repositories in one process must be told THEIR rules: a repo with
    // enforce=false must not read "写操作会被拒绝".
    const cwd = tempWorkspace('spec-gate-prompt-')
    const scratch = tempWorkspace('spec-gate-prompt-scratch-')
    fs.mkdirSync(path.join(scratch, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(scratch, '.dsh', 'spec-gate.json'), JSON.stringify({ enforce: false }))
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })

    const section = (fake.sections.find((entry) => entry.name === 'eng:spec-gate') ?? {}) as {
        text: (assemble?: unknown) => string
    }
    const scratchText = section.text({ scope: fakeAgent(scratch, 'a', 's1') })
    const profileText = section.text({ scope: fakeAgent(tempWorkspace('spec-gate-prompt-plain-'), 'b', 's2') })

    assert.match(scratchText, /enforce=false/)
    assert.match(scratchText, /项目级配置/)
    assert.match(scratchText, /写操作不会被拦截/)
    assert.doesNotMatch(profileText, /项目级配置/)
    assert.match(profileText, /会被直接拒绝/)
    // No assembly context (or a broken one) falls back to the profile text.
    assert.match(section.text(undefined), /会被直接拒绝/)
    assert.match(section.text({ scope: {} }), /会被直接拒绝/)
})

test('a tool call without a declared workspace refuses instead of guessing (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-nocwd-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const homeless = { id: 'agent-x', session: { id: 'session-x', header: { id: 'session-x' } } }
    const run = await fake.runTool('spec_create', DRAFT, { agent: homeless })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /无法确定本会话的工作区/)
    assert.match(String(run.content), /header\.cwd/)
    // Nothing was written anywhere: the harness's own directory stayed clean.
    assert.equal(fs.existsSync(path.join(process.cwd(), '.dsh', 'specs')), false)
})

test('denial counts are reported per workspace (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-counts-a-')
    const other = tempWorkspace('spec-gate-counts-b-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    await fake.runTool('spec_create', DRAFT)
    const write = (agent: unknown) => fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent })
    write(fake.agent)
    write(fake.agent)
    write(fakeAgent(other, 'o', 'so'))
    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /拦截次数：本工作区 2 次/)
    assert.match(status, /合计 3 次/)
})

test('the approval prompt names both artifacts so the human can open them (regression)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
    const reason = (fake.approvalRequests[0] as { reason?: string } | undefined)?.reason ?? ''
    // The reviewer must not approve blind: both directories and both files.
    assert.match(reason, /需求文档目录: \.dsh\/specs\//)
    assert.match(reason, /测试用例目录: \.dsh\/missions\/[^/]+\//)
    assert.match(reason, /需求文档: \.dsh\/specs\/[^)]+\.md（验收标准 \d+ 条）/)
    assert.match(reason, /测试用例: \.dsh\/missions\/[^/]+\/test-design-review\.md（用例 \d+ 条/)
    // …plus what each criterion and case actually says.
    assert.match(reason, /AC-001/)
    assert.match(reason, /TC-001/)
    // …and what rejection means.
    assert.match(reason, /第 1 次送审/)
    assert.match(reason, /拒绝并在对话里说明要改什么/)
    assert.match(reason, /\n/, 'multi-line: a UI can render it as a list')
})

test('a rejection records the round, asks what to change, and loops (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-loop-')
    const asked: unknown[] = []
    const fake = createFakeHost({
        cwd,
        approvalOutcome: 'rejected',
        services: {
            userQuestions: {
                ask: async (request: unknown) => {
                    asked.push(request)
                    // Echo the caller's question id, like the real service does.
                    const id = (request as { questions: { id: string }[] }).questions[0]?.id ?? ''
                    return { answers: [{ id, selected: ['验收标准不全或不准确'], custom: '另外补一条 503 的用例' }] }
                },
            },
        },
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    await fake.runTool('spec_create', DRAFT)
    const run = await fake.runTool('spec_approve', {})
    const text = runText(run)

    // The rejection is recorded with its round and the human's note.
    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.approval?.state, 'rejected')
    assert.equal(mission?.approval?.round, 1)
    assert.match(mission?.approval?.note ?? '', /验收标准不全或不准确/)
    assert.match(mission?.approval?.note ?? '', /另外补一条 503 的用例/)
    // The approval it reviewed is void, so no write path can slip through.
    assert.equal(mission?.spec?.approvedAt, undefined)
    assert.match(fake.guardReason({ name: 'write', arguments: { file_path: 'src/server.ts' }, agent: fake.agent }) ?? '', /尚未审批/)

    // The human was asked through the host's question channel.
    assert.equal(asked.length, 1)
    const question = (asked[0] as { questions: { question: string; options?: unknown[] }[] }).questions[0]
    assert.match(question?.question ?? '', /要改什么/)
    assert.ok((question?.options ?? []).length >= 3)

    // The model is told the note and the exact loop.
    assert.match(text, /人工意见：验收标准不全或不准确；另外补一条 503 的用例/)
    assert.match(text, /第 2 次/)

    // The next submission is round 2 and can pass.
    const again = host({ approvalOutcome: 'allowed-once', cwd })
    await again.runTool('spec_create', DRAFT)
    const second = await again.runTool('spec_approve', {})
    assert.match(runText(second), /规格已审批/)
    assert.match((again.approvalRequests[0] as { reason?: string })?.reason ?? '', /第 2 次送审/)
})

test('a rejection without a question channel still records and guides (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-loop-noq-')
    const fake = createFakeHost({ cwd, approvalOutcome: 'rejected' })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    await fake.runTool('spec_create', DRAFT)
    const text = runText(await fake.runTool('spec_approve', {}))
    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.approval?.state, 'rejected')
    assert.equal(mission?.approval?.note, undefined)
    assert.match(text, /打回/)
    assert.match(text, /spec_create/)
})

/** A stand-in for nvim-tui's public ext API: records opens and fires actions. */
function fakeTui(cwd: string) {
    const ex: string[] = []
    const notices: string[] = []
    const cards: {
        title: string
        body: string
        actions?: { label: string; value: string; kind?: string }[]
        onAction?: (value: string) => void
        updated: string[]
        dismissed: boolean
    }[] = []
    const pickers: { title: string; items: { label: string; value: string }[] }[] = []
    const panels: { slot: string; title: string; lines: string[]; released: number }[] = []
    const floats: { title: string; lines: string[] }[] = []
    const closedFloats: string[] = []
    const viewers: { title: string; lines: string[]; editPath: string; closed: boolean }[] = []
    let holdViewer = false
    let currentTab = 1
    const answers: (string | null | ((picker: { title: string; items: { label: string; value: string }[] }) => string | null))[] = []
    const inserted: string[] = []
    const api = {
        version: '0.1.0',
        capabilities: () => ({ card: true, float: true, picker: true }),
        nvim: {
            // The TUI's own public entries: the read-only viewer, its liveness
            // probe, its close, and `open_file_tab` (the tab route).
            lua: async (code: string, args?: unknown[]) => {
                if (code.includes('show_lines_float')) {
                    viewers.push({ title: String(args?.[0] ?? ''), lines: (args?.[1] as string[]) ?? [], editPath: String(args?.[2] ?? ''), closed: false })
                    return { buf: viewers.length, win: 100 + viewers.length }
                }
                if (code.includes('nvim_get_current_tabpage')) {
                    return currentTab
                }
                if (code.includes('nvim_buf_is_valid')) {
                    const buf = Number(args?.[0] ?? 0)
                    const entry = viewers[buf - 1]
                    if (entry === undefined) return false
                    // By default the reviewer reads and closes right away; tests
                    // that need to hold it open call `holdViewer()`.
                    if (!holdViewer && !entry.closed) entry.closed = true
                    return !entry.closed
                }
                if (code.includes('close_lines_float')) {
                    for (const entry of viewers) entry.closed = true
                    return undefined
                }
                if (code.includes('open_file_tab')) {
                    ex.push(`lua:open_file_tab ${String(args?.[0] ?? '')}`)
                    return true
                }
                throw new Error(`unexpected lua: ${code}`)
            },
            ex: async (cmd: string) => {
                ex.push(cmd)
            },
            // nvim's own escaping; the fake echoes the path so an assertion can
            // name the file that was opened.
            call: async (fn: string, args?: unknown[]) => (fn === 'fnameescape' ? String(args?.[0] ?? '') : undefined),
        },
        ui: {
            panel: async (opts: { slot?: string; title?: string; lines?: string[] }) => {
                const record = { slot: opts.slot ?? '', title: opts.title ?? '', lines: opts.lines ?? [], released: 0 }
                panels.push(record)
                return {
                    win: 1,
                    buf: 2,
                    slot: record.slot,
                    release: async () => {
                        record.released += 1
                    },
                }
            },
            float: async (opts: { lines: string[]; title?: string }) => {
                floats.push({ title: opts.title ?? '', lines: opts.lines })
                return { id: `float-${floats.length}`, win: 3, buf: 4 }
            },
            floatClose: async (id: string) => {
                closedFloats.push(id)
            },
            card: (opts: {
                title: string
                body: string
                actions?: { label: string; value: string; kind?: string }[]
                onAction?: (value: string) => void
            }) => {
                const record = { ...opts, updated: [] as string[], dismissed: false }
                cards.push(record)
                return {
                    id: `card-${cards.length}`,
                    update: (next: { title?: string; body?: string }) => record.updated.push(next.title ?? ''),
                    dismiss: () => {
                        record.dismissed = true
                    },
                }
            },
            picker: async (opts: { title: string; items: { label: string; value: string }[] }) => {
                pickers.push(opts)
                const next = answers.length === 0 ? null : answers.shift()
                return typeof next === 'function' ? next(opts) : ((next ?? null) as string | null)
            },
            notice: (text: unknown) => notices.push(String(text)),
        },
    }
    const api2 = { ...api, insertInput: (text: string) => inserted.push(text) }
    return {
        api: api2,
        ex,
        cards,
        pickers,
        notices,
        panels,
        floats,
        closedFloats,
        viewers,
        /** Simulate the human pressing `q` in the viewer. */
        closeViewer: () => {
            for (const entry of viewers) entry.closed = true
        },
        /** Keep the viewer open until `closeViewer()` (default: closes at once). */
        holdViewer: () => {
            holdViewer = true
        },
        /** Simulate `i`/`o` inside the viewer: the file opens in another tab. */
        jumpToFileTab: () => {
            currentTab = 2
        },
        /** Simulate the human returning to the review tab. */
        backToReviewTab: () => {
            currentTab = 1
        },
        inserted,
        /** Queue the picker answers, in order (a function may inspect the picker). */
        queue: (...values: (string | null | ((picker: { title: string; items: { label: string; value: string }[] }) => string | null))[]) =>
            answers.push(...values),
        cwd,
    }
}

test('the review POPUP lists both artifacts and drives the verdict (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, approvalOutcome: 'rejected', services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)

    // Read first, then approve: the popup stays in charge between the two.
    tui.queue('spec:open-spec', 'spec:open-design', 'spec:approve')
    const result = runText(await fake.runTool('spec_approve', {}))

    // The card is only a RECORD in the feed — and nvim-tui renders at most four
    // actions, so a verdict must never be hidden behind a fifth.
    assert.equal(tui.cards.length, 1)
    const card = tui.cards[0]!
    assert.match(card.body, /需求文档: \.dsh\/specs\//)
    assert.match(card.body, /测试用例: \.dsh\/missions\//)
    assert.equal(card.actions?.length, 4)
    assert.deepEqual(
        card.actions?.map((action) => action.value),
        ['spec:open-spec', 'spec:open-design', 'spec:list-specs', 'spec:list-design'],
    )
    assert.equal(
        card.actions?.some((action) => action.value === 'spec:approve' || action.value === 'spec:reject'),
        false,
        'the verdict lives in the popup, not on a card whose actions get truncated',
    )

    // The POPUP is the decision channel: it names both files and both folders.
    assert.ok(tui.pickers.length >= 3, 'one picker per decision round')
    const menu = tui.pickers[0]!
    const labels = menu.items.map((item) => item.label).join('\n')
    assert.match(menu.title, /规格审批（第 1 次送审）/)
    for (const needle of ['查看需求文档', '查看测试用例', '浏览需求文档目录', '浏览测试用例目录', '通过并放行', '打回重写', '取消']) {
        assert.match(labels, new RegExp(needle), `menu must offer ${needle}`)
    }
    assert.match(labels, /\.dsh\/specs\//)
    assert.match(labels, /test-design-review\.md/)
    assert.doesNotMatch(labels, /新标签页/, 'the tab route is gone from the menu')

    // The two review choices opened the artifacts.
    // The preview went into the TUI's OWN read-only viewer float (scrollable,
    // `q` closes it and returns) — not into a tab the TUI would immediately hide
    // behind its own window.
    assert.equal(tui.viewers.length, 2)
    assert.match(tui.viewers[0]?.title ?? '', /需求文档/)
    assert.match(tui.viewers[1]?.title ?? '', /测试用例/)
    assert.match(tui.viewers[0]?.editPath ?? '', /\.dsh\/specs\/.*\.md$/, 'the viewer can hand off to real editing')
    assert.ok((tui.viewers[0]?.lines.length ?? 0) > 0, 'the viewer shows the document content')
    assert.equal(tui.ex.length, 0, 'no tab was needed')
    assert.ok(
        tui.notices.some((notice) => notice.startsWith('已打开只读预览')),
        `notices: ${tui.notices.join(' | ')}`,
    )
    // The viewer is closed once the verdict is in.
    assert.equal(tui.viewers.every((entry) => entry.closed), true)

    assert.match(result, /规格已审批/)
    assert.ok((new MissionStoreRegistry().for(cwd).active('session-1')?.spec?.approvedAt ?? 0) > 0)
})

test('a rejection takes its reason from the popup and loops (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-reject-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)

    tui.queue('spec:reject', 'reject:验收标准不全或不准确')
    const text = runText(await fake.runTool('spec_approve', {}))

    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.approval?.state, 'rejected')
    assert.equal(mission?.approval?.round, 1)
    assert.equal(mission?.approval?.note, '验收标准不全或不准确')
    assert.equal(mission?.spec?.approvedAt, undefined, 'the approval it reviewed is void')
    assert.match(text, /人工意见：验收标准不全或不准确/)
    assert.match(text, /spec_create/)
    assert.match(text, /第 2 次/)
    // The second popup asked WHY, and the canned answers were offered.
    assert.equal(tui.pickers.length, 2)
    assert.match(tui.pickers[1]?.title ?? '', /打回原因/)
    assert.ok((tui.pickers[1]?.items.length ?? 0) >= 4)
    assert.match(tui.cards[0]?.updated.join(' ') ?? '', /已打回/)
    assert.equal(fake.approvalRequests.length, 0, 'no generic approval prompt on top of the popup')
})

test('"其它" hands the rejection reason back to the chat input (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-other-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)
    tui.queue('spec:reject', 'reject:other')
    const text = runText(await fake.runTool('spec_approve', {}))
    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.approval?.state, 'rejected')
    assert.equal(mission?.approval?.note, undefined)
    // The input box is prefilled so typing the details is one step away.
    assert.deepEqual(tui.inserted, ['打回原因：'])
    assert.match(text, /打回/)
})

test('browsing a directory from the popup opens the chosen file (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-browse-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)

    // A cancelled sub-picker must not decide anything, and must not close the
    // review: the menu comes back and the verdict is still ours to make.
    tui.queue('spec:list-specs', null, 'spec:approve')
    assert.match(runText(await fake.runTool('spec_approve', {})), /规格已审批/)
    assert.equal(tui.ex.length, 0, 'a cancelled browse opens nothing')

    // Choosing a file in the browse picker opens THAT file, then shows the menu.
    const other = tempWorkspace('spec-gate-tui-browse2-')
    const tui2 = fakeTui(other)
    const fake2 = createFakeHost({ cwd: other, services: { 'nvim-tui': tui2.api } })
    apply(fake2.ctx as never, { logFile: path.join(other, 'spec-gate.log'), approval: 'seam' })
    await fake2.runTool('spec_create', DRAFT)
    tui2.queue(
        'spec:list-specs',
        (picker) => picker.items.find((item) => item.value.endsWith('.md'))?.value ?? null,
        'spec:approve',
    )
    assert.match(runText(await fake2.runTool('spec_approve', {})), /规格已审批/)
    assert.equal(tui2.ex.length, 1)
    assert.match(tui2.ex[0] ?? '', /^lua:open_file_tab .*\.dsh\/specs\/.*\.md$/)
    assert.ok(
        tui2.pickers.some((picker) => picker.title.includes('需求文档目录')),
        'the directory listing came from the popup',
    )
})

test('reviewChannel=approval forces the generic seam, tui refuses without the API (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-off-')
    const tui = fakeTui(cwd)
    const forced = createFakeHost({ cwd, approvalOutcome: 'allowed-once', services: { 'nvim-tui': tui.api } })
    apply(forced.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam', reviewChannel: 'approval' })
    await forced.runTool('spec_create', DRAFT)
    await forced.runTool('spec_approve', {})
    assert.equal(tui.cards.length, 0, 'no card when the host asked for the seam')
    assert.equal(forced.approvalRequests.length, 1)

    // reviewChannel=tui without the API is a configuration error, not a silent downgrade.
    const other = tempWorkspace('spec-gate-tui-missing-')
    const strict = createFakeHost({ cwd: other, approvalOutcome: 'allowed-once' })
    apply(strict.ctx as never, { logFile: path.join(other, 'spec-gate.log'), approval: 'seam', reviewChannel: 'tui' })
    await strict.runTool('spec_create', DRAFT)
    const refused = await strict.runTool('spec_approve', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /nvim-tui|reviewChannel/)
    assert.equal(strict.approvalRequests.length, 0)
})

test('a review that nobody answers fails closed (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-tui-timeout-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam', reviewTimeoutMs: 1_000 })
    await fake.runTool('spec_create', DRAFT)
    const pending = fake.runTool('spec_approve', {})
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const text = runText(await pending)
    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.spec?.approvedAt, undefined, 'a timeout is never an approval')
    assert.match(text, /取消|超时|未/)
})

test('opening falls back when the primary route fails, and reports failures (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-open-fallback-')
    const tui = fakeTui(cwd)
    // Break the Lua route and the first ex route: the local-escape route must
    // still open the file, and the human must see what happened.
    ;(tui.api.nvim as { lua?: unknown }).lua = async () => {
        throw new Error('lua 通道不可用')
    }
    // No panel/float surface either: the chain must reach the tab route.
    delete (tui.api.ui as { panel?: unknown }).panel
    delete (tui.api.ui as { float?: unknown }).float
    let callCount = 0
    ;(tui.api.nvim as { call?: unknown }).call = async () => {
        callCount += 1
        throw new Error('call 白名单拒绝')
    }
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)
    tui.queue('spec:open-spec', 'spec:approve')
    assert.match(runText(await fake.runTool('spec_approve', {})), /规格已审批/)
    assert.equal(callCount, 1, 'the fnameescape route was tried')
    assert.equal(tui.ex.length, 1)
    assert.match(tui.ex[0] ?? '', /^tabedit .*\.dsh\/specs\/.*\.md$/)
    assert.ok(
        tui.notices.some((notice) => notice.startsWith('已在新标签页打开')),
        `notices: ${tui.notices.join(' | ')}`,
    )

    // Every route failing is reported, never silent, and never decides anything.
    const other = tempWorkspace('spec-gate-open-fail-')
    const tui2 = fakeTui(other)
    delete (tui2.api.ui as { panel?: unknown }).panel
    delete (tui2.api.ui as { float?: unknown }).float
    ;(tui2.api.nvim as { lua?: unknown }).lua = async () => {
        throw new Error('lua down')
    }
    ;(tui2.api.nvim as { ex?: unknown }).ex = async () => {
        throw new Error('ex down')
    }
    ;(tui2.api.nvim as { call?: unknown }).call = async () => {
        throw new Error('call down')
    }
    const fake2 = createFakeHost({ cwd: other, services: { 'nvim-tui': tui2.api } })
    apply(fake2.ctx as never, { logFile: path.join(other, 'spec-gate.log'), approval: 'seam' })
    await fake2.runTool('spec_create', DRAFT)
    tui2.queue('spec:open-spec', 'spec:approve')
    assert.match(runText(await fake2.runTool('spec_approve', {})), /规格已审批/, 'a failed open still leaves the review usable')
    assert.ok(
        tui2.notices.some((notice) => notice.startsWith('⚠ 打开失败')),
        `notices: ${tui2.notices.join(' | ')}`,
    )
    // The failure is in the plugin log, so a user report can be diagnosed.
    const log = fs.readFileSync(path.join(other, 'spec-gate.log'), 'utf8')
    assert.match(log, /\[review\] ⚠ 打开失败/)
})

test('a stuck nvim RPC cannot wedge the review (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-open-hang-')
    const tui = fakeTui(cwd)
    // The Lua route never settles: the timeout must move on to the ex route.
    delete (tui.api.ui as { panel?: unknown }).panel
    delete (tui.api.ui as { float?: unknown }).float
    ;(tui.api.nvim as { lua?: unknown }).lua = () => new Promise(() => undefined)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)
    tui.queue('spec:open-spec', 'spec:approve')
    const text = runText(await fake.runTool('spec_approve', {}))
    assert.match(text, /规格已审批/)
    assert.ok(tui.ex.some((entry) => entry.startsWith('tabedit ')), `ex calls: ${tui.ex.join(' | ')}`)
})

test('the reviewer reads first: the menu waits until the viewer is closed (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-viewer-wait-')
    const tui = fakeTui(cwd)
    tui.holdViewer() // the human keeps reading
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam', reviewTimeoutMs: 6_000 })
    await fake.runTool('spec_create', DRAFT)

    tui.queue('spec:open-spec', 'spec:approve')
    const pending = fake.runTool('spec_approve', {})
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    // Still reading: one menu, one viewer, and the verdict has NOT been asked for
    // again (a second picker on top of the document would hide it).
    assert.equal(tui.viewers.length, 1)
    assert.equal(tui.pickers.length, 1, `pickers: ${tui.pickers.length}`)

    tui.closeViewer() // `q`
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(tui.pickers.length, 2, 'the menu came back after the viewer closed')
    assert.match(runText(await pending), /规格已审批/)

    // If the human never closes it, the review deadline still ends the wait.
    const other = tempWorkspace('spec-gate-viewer-timeout-')
    const tui2 = fakeTui(other)
    tui2.holdViewer()
    const fake2 = createFakeHost({ cwd: other, services: { 'nvim-tui': tui2.api } })
    apply(fake2.ctx as never, { logFile: path.join(other, 'spec-gate.log'), approval: 'seam', reviewTimeoutMs: 1_500 })
    await fake2.runTool('spec_create', DRAFT)
    tui2.queue('spec:open-spec')
    const text = runText(await fake2.runTool('spec_approve', {}))
    const mission = new MissionStoreRegistry().for(other).active('session-1')
    assert.equal(mission?.spec?.approvedAt, undefined, 'a viewer left open is never an approval')
    assert.match(text, /未决定|取消|超时/)
    assert.equal(tui2.viewers.every((entry) => entry.closed), true, 'the viewer is closed on the way out')
})

test('i/o in the viewer jumps to the file and the menu stays out of the way (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-viewer-jump-')
    const tui = fakeTui(cwd)
    tui.holdViewer()
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam', reviewTimeoutMs: 8_000 })
    await fake.runTool('spec_create', DRAFT)

    tui.queue('spec:open-spec', 'spec:approve')
    const pending = fake.runTool('spec_approve', {})
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(tui.viewers.length, 1)
    assert.equal(tui.pickers.length, 1)

    // The human presses `i`: the viewer closes (nvim opens the file in a new
    // tab). The menu must NOT reappear over that buffer.
    tui.jumpToFileTab()
    tui.closeViewer()
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.equal(tui.pickers.length, 1, 'the menu must not steal focus from the opened file')

    // …and comes back once they return to the review tab.
    tui.backToReviewTab()
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(tui.pickers.length, 2, 'the menu returns after the human comes back')
    assert.match(runText(await pending), /规格已审批/)
})

test('Esc in the rejection popup goes back instead of rejecting silently (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-reject-back-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)

    // The secondary popup must offer a way out, and Esc must mean the same.
    tui.queue('spec:reject', null, 'spec:approve')
    const text = runText(await fake.runTool('spec_approve', {}))
    const mission = new MissionStoreRegistry().for(cwd).active('session-1')
    assert.equal(mission?.approval, undefined, 'no rejection was recorded')
    assert.ok((mission?.spec?.approvedAt ?? 0) > 0, 'the review continued and was approved')
    assert.match(text, /规格已审批/)
    assert.equal(tui.pickers.length, 3, 'reason popup → back → menu again')
    assert.ok(
        (tui.pickers[1]?.items ?? []).some((item) => item.label.includes('返回评审菜单')),
        `the reason popup offers a way back: ${JSON.stringify(tui.pickers[1]?.items)}`,
    )
    assert.ok(
        tui.notices.some((notice) => notice.includes('已返回评审菜单')),
        `notices: ${tui.notices.join(' | ')}`,
    )
})

test('the browse popup walks back out one level at a time (regression)', async () => {
    const cwd = tempWorkspace('spec-gate-browse-back-')
    const tui = fakeTui(cwd)
    const fake = createFakeHost({ cwd, services: { 'nvim-tui': tui.api } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), approval: 'seam' })
    await fake.runTool('spec_create', DRAFT)

    // Drill into a subdirectory, then Esc: the PARENT listing comes back (not the
    // verdict menu), and Esc again leaves for the menu.
    const specs = path.join(cwd, '.dsh', 'specs')
    fs.mkdirSync(path.join(specs, 'archive'), { recursive: true })
    tui.queue(
        'spec:list-specs',
        () => path.join(specs, 'archive'),
        null,
        null,
        'spec:approve',
    )
    assert.match(runText(await fake.runTool('spec_approve', {})), /规格已审批/)
    const titles = tui.pickers.map((picker) => picker.title)
    // menu → specs listing → inside archive → back to specs → menu again
    assert.match(titles[1] ?? '', /specs$/, 'the specs listing')
    assert.ok(
        (tui.pickers[1]?.items ?? []).some((item) => item.label.includes('archive')),
        'the subdirectory is listed',
    )
    assert.match(titles[2] ?? '', /archive/, 'inside the subdirectory')
    assert.match(titles[3] ?? '', /specs$/, 'Esc came back to the parent listing')
    assert.match(titles[4] ?? '', /规格审批/, 'Esc at the top returns to the review menu')
    assert.ok(
        (tui.pickers[2]?.items ?? []).some((item) => item.label.includes('返回上一级目录')),
        'the nested listing says how to go up',
    )
    assert.ok(
        (tui.pickers[1]?.items ?? []).some((item) => item.label.includes('返回评审菜单')),
        'the top listing says how to leave',
    )
})

// ---------------------------------------------------------------------------
// spec_bootstrap: the MODEL reads the code; the plugin owns contract + check
// ---------------------------------------------------------------------------

/** A scripted read-only drafting child: records the dispatch, answers once. */
function fakeSubagents(answer: string | (() => Promise<never>)) {
    const calls: {
        provider: string
        request: { toolFilter?: { allow?: readonly string[] }; prompt: { text: string }[]; agentOptions?: Record<string, unknown> }
    }[] = []
    const disposed: string[] = []
    let counter = 0
    const service = {
        start: async (
            provider: string,
            request: { toolFilter?: { allow?: readonly string[] }; prompt: { text: string }[]; agentOptions?: Record<string, unknown> },
        ) => {
            calls.push({ provider, request })
            const id = `run-${(counter += 1)}`
            return {
                id,
                result:
                    typeof answer === 'function'
                        ? answer()
                        : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: answer }] }),
                dispose: async () => {
                    disposed.push(id)
                },
            }
        },
    }
    return { service, calls, disposed }
}

/** A legacy repository: requirement doc + code + one test, no spec at all. */
function legacyRepo(): string {
    const cwd = tempWorkspace('spec-gate-legacy-')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, 'README.md'),
        ['# 图片爬虫', '', '## 功能需求', '', '- 支持按页面地址抓取图片', '- 支持按描述分类落盘'].join('\n'),
    )
    fs.writeFileSync(path.join(cwd, 'docs', 'design.md'), ['# 设计', '', '## 要求', '', '- 单次抓取不超过 100 张'].join('\n'))
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module spider\n\ngo 1.26\n')
    fs.mkdirSync(path.join(cwd, 'internal', 'crawler'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, 'internal', 'crawler', 'crawl.go'),
        ['package crawler', '', 'func Fetch(url string) ([]byte, error) { return nil, nil }'].join('\n'),
    )
    fs.writeFileSync(
        path.join(cwd, 'internal', 'crawler', 'crawl_test.go'),
        ['package crawler', '', 'import "testing"', '', 'func TestFetch(t *testing.T) {', '\tt.Run("拒绝空地址", func(t *testing.T) {})', '}'].join('\n'),
    )
    return cwd
}

const DRAFT_ANSWER = [
    '## 验收标准',
    '',
    '| 编号 | 验收标准 |',
    '|------|----------|',
    '| AC-001 | `go run ./cmd/spider -url <页面>` 能把页面里的图片抓到目标目录并写入清单 |',
    '| AC-002 | `-url ""` 时进程以非 0 退出码结束且不写任何文件 |',
    '',
    '## 测试设计',
    '',
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 本地有一个含 3 张图片的测试页面 | 执行 `go run ./cmd/spider -url http://127.0.0.1:8080/demo.html -out /tmp/out` | 退出码 0，/tmp/out 下有 3 个图片文件，清单文件包含这 3 条记录 | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 无 | 执行 `go run ./cmd/spider -url ""` | 退出码非 0，stderr 含 "url is required"，目标目录未被创建 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 测试页面恰好有 100 张图片 | 执行 `go run ./cmd/spider -url http://127.0.0.1:8080/hundred.html -out /tmp/out100` | 100 张全部落盘，清单含 100 条记录，退出码 0 | AC-001 |',
].join('\n')

test('spec_bootstrap brief hands over the contract and where to look (regression)', async () => {
    const cwd = legacyRepo()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const brief = runText(await fake.runTool('spec_bootstrap', { action: 'brief' }))

    // The contract: what to write, and the rule that the MODEL reads the code.
    assert.match(brief, /\| 用例ID \| 前置条件 \| 操作步骤 \| 预期结果 \| 覆盖验收标准 \|/)
    assert.match(brief, /必须真的读代码/)
    assert.match(brief, /禁止发明/)
    // The index points at real files instead of summarising them.
    assert.match(brief, /README\.md/)
    assert.match(brief, /docs\/design\.md/)
    assert.match(brief, /crawl_test\.go/)
    assert.match(brief, /go test \.\/\.\.\./)
    // Gaps: nothing is approved yet, so the missing spec is named.
    assert.match(brief, /缺的工件：.*spec/)
    assert.match(brief, /spec_bootstrap\(\{ action: "check"/)
})

test('spec_bootstrap draft dispatches a READ-ONLY child and validates what it returns (regression)', async () => {
    const cwd = legacyRepo()
    const child = fakeSubagents(DRAFT_ANSWER)
    const fake = createFakeHost({ cwd, services: { subagents: child.service } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const out = runText(await fake.runTool('spec_bootstrap', { action: 'draft', focus: '重点补 HTTP 层' }))

    // Least privilege by construction: the child cannot write anything.
    assert.equal(child.calls.length, 1)
    assert.deepEqual(child.calls[0]?.request.toolFilter?.allow, ['read', 'grep', 'glob'])
    assert.equal(child.calls[0]?.request.toolFilter?.allow?.includes('write'), false)
    assert.equal(child.calls[0]?.request.toolFilter?.allow?.includes('bash'), false)
    const prompt = child.calls[0]?.request.prompt[0]?.text ?? ''
    assert.match(prompt, /必须真的读代码/)
    assert.match(prompt, /只读/)
    assert.match(prompt, /重点补 HTTP 层/)
    // The child is disposed even on the happy path.
    assert.deepEqual(child.disposed, ['run-1'])

    // The answer was parsed, validated and written as a DRAFT.
    assert.match(out, /规格草稿（只读子代理读代码生成/)
    assert.match(out, /✅ 自查通过/)
    assert.match(out, /\| AC-001 \|/)
    assert.match(out, /\| TC-001 \|/)
    assert.match(out, /没有任何审批效力/)
    const dir = path.join(cwd, '.dsh', 'bootstrap')
    const stamps = fs.readdirSync(dir)
    assert.equal(stamps.length, 1)
    const markdown = fs.readFileSync(path.join(dir, stamps[0]!, 'spec-draft.md'), 'utf8')
    assert.match(markdown, /## 验收标准/)
    assert.match(markdown, /### 正向场景/)
    assert.match(markdown, /还没有|没有任何审批效力/)
    // A draft is not a specification: no mission, no spec artifact.
    assert.equal(new MissionStoreRegistry().for(cwd).list().length, 0)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'specs')), false)
})

test('spec_bootstrap draft surfaces the check findings instead of hiding them (regression)', async () => {
    const cwd = legacyRepo()
    // A child answer that parses but leaves an AC uncovered and a placeholder.
    const weak = [
        '## 验收标准',
        '',
        '| 编号 | 验收标准 |',
        '|------|----------|',
        '| AC-001 | 抓取能落盘 |',
        '| AC-002 | 空地址报错 |',
        '',
        '## 测试设计',
        '',
        '### 正向场景',
        '',
        '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
        '|--------|----------|----------|----------|--------------|',
        '| TC-001 | [待确认] | [待确认] | [待确认] | AC-001 |',
    ].join('\n')
    const child = fakeSubagents(weak)
    const fake = createFakeHost({ cwd, services: { subagents: child.service } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const out = runText(await fake.runTool('spec_bootstrap', { action: 'draft' }))

    assert.match(out, /⚠️ 自查还有 \d+ 个问题/)
    assert.match(out, /\[coverage\] AC-002 没有任何用例覆盖/)
    assert.match(out, /\[placeholder\] TC-001 还留着占位符/)
    assert.match(out, /\[steps\] TC-001 的操作步骤或预期结果过短/)
    // The draft is still written (a human may want to fix it), the findings ride along.
    const stamps = fs.readdirSync(path.join(cwd, '.dsh', 'bootstrap'))
    const markdown = fs.readFileSync(path.join(cwd, '.dsh', 'bootstrap', stamps[0]!, 'spec-draft.md'), 'utf8')
    assert.match(markdown, /自查发现的问题/)
})

test('spec_bootstrap refuses to invent a draft when the child is unusable (regression)', async () => {
    // (a) The child returns prose that is not a draft: report it, write nothing.
    const cwd = legacyRepo()
    const chatty = fakeSubagents('这个仓库看起来是个爬虫，我觉得写得不错。')
    const fake = createFakeHost({ cwd, services: { subagents: chatty.service } })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const out = runText(await fake.runTool('spec_bootstrap', { action: 'draft' }))
    assert.match(out, /只读草稿代理的输出不可用/)
    assert.match(out, /没有退化成脚手架/)
    assert.match(out, /--- 代理原始输出/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'bootstrap')), false, 'nothing is written for an unusable answer')

    // (b) The child fails outright: the failure is reported, not swallowed.
    const other = legacyRepo()
    const broken = fakeSubagents(() => Promise.reject(new Error('child exploded')))
    const failing = createFakeHost({ cwd: other, services: { subagents: broken.service } })
    apply(failing.ctx as never, { logFile: path.join(other, 'spec-gate.log') })
    const failed = await failing.runTool('spec_bootstrap', { action: 'draft' })
    assert.equal(failed.isError, true)
    assert.match(String(failed.content), /child exploded/)

    // (c) No subagent service at all: point at the path that still works.
    const bare = legacyRepo()
    const noSub = createFakeHost({ cwd: bare })
    apply(noSub.ctx as never, { logFile: path.join(bare, 'spec-gate.log') })
    const refused = await noSub.runTool('spec_bootstrap', { action: 'draft' })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /action: "brief"/)
    // …and briefing still works without any child.
    assert.match(runText(await noSub.runTool('spec_bootstrap', { action: 'brief' })), /必须真的读代码/)
})

test('spec_bootstrap check catches what spec_create would silently accept (regression)', async () => {
    const cwd = legacyRepo()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })

    // A good draft passes.
    const good = runText(
        await fake.runTool('spec_bootstrap', {
            action: 'check',
            acceptanceCriteria: ['AC-001 抓取能落盘并写清单', 'AC-002 空地址报错'],
            testDesign: DRAFT_ANSWER.slice(DRAFT_ANSWER.indexOf('## 测试设计')),
        }),
    )
    assert.match(good, /✅ 草稿通过自查/)

    // Malformed criteria, an uncovered AC, thin steps and a leftover placeholder.
    const bad = runText(
        await fake.runTool('spec_bootstrap', {
            action: 'check',
            acceptanceCriteria: ['AC-001 抓取能落盘', '这条没有编号', 'AC-003 空地址报错'],
            testDesign: [
                '## 测试设计',
                '',
                '### 正向场景',
                '',
                '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
                '|--------|----------|----------|----------|--------------|',
                '| TC-001 | [待确认] | [待确认] | [待确认] | AC-001 |',
            ].join('\n'),
        }),
    )
    assert.match(bad, /\[shape\]/)
    assert.match(bad, /\[coverage\] AC-003 没有任何用例覆盖/)
    assert.match(bad, /\[steps\] TC-001/)
    assert.match(bad, /\[placeholder\] TC-001/)
    assert.match(bad, /改完再 spec_create/)

    // Missing inputs is a caller error, not a silent pass.
    const incomplete = await fake.runTool('spec_bootstrap', { action: 'check' })
    assert.equal(incomplete.isError, true)
})

test('spec_bootstrap can be disabled, and never touches the mission ledger (regression)', async () => {
    const cwd = legacyRepo()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), bootstrap: { enabled: false } })
    const refused = await fake.runTool('spec_bootstrap', { action: 'brief' })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /bootstrap\.enabled=false/)

    // Even with drafting enabled, no mission/spec exists afterwards.
    const other = legacyRepo()
    const child = fakeSubagents(DRAFT_ANSWER)
    const drafting = createFakeHost({ cwd: other, services: { subagents: child.service } })
    apply(drafting.ctx as never, { logFile: path.join(other, 'spec-gate.log'), bootstrap: { minTextLength: 4 } })
    await drafting.runTool('spec_bootstrap', { action: 'draft' })
    const stores = new MissionStoreRegistry().for(other)
    assert.equal(stores.list().length, 0)
    assert.equal(stores.active('session-1'), undefined)
})

test('the drafting child can be routed to a cheaper model (regression)', async () => {
    const cwd = legacyRepo()
    const child = fakeSubagents(DRAFT_ANSWER)
    const fake = createFakeHost({ cwd, services: { subagents: child.service } })
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'spec-gate.log'),
        bootstrap: { model: 'deepseek-official/deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 8000 },
    })
    await fake.runTool('spec_bootstrap', { action: 'draft' })
    const options = (child.calls[0]?.request as { agentOptions?: Record<string, unknown> }).agentOptions
    assert.deepEqual(options, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 8000 })

    // With no route configured the child inherits the session's model.
    const other = legacyRepo()
    const inherited = fakeSubagents(DRAFT_ANSWER)
    const bare = createFakeHost({ cwd: other, services: { subagents: inherited.service } })
    apply(bare.ctx as never, { logFile: path.join(other, 'spec-gate.log') })
    await bare.runTool('spec_bootstrap', { action: 'draft' })
    assert.equal(
        (inherited.calls[0]?.request as { agentOptions?: unknown }).agentOptions,
        undefined,
        'no configured route → no agentOptions, the child uses the session model',
    )
})

test('the trust root survives a symlink (regression: SECURITY)', async () => {
    // Found by an adversarial audit: containment was lexical, so
    // `evil.txt -> .dsh/standards-baseline.json` let a write-class tool land
    // bytes inside the trust root while the path looked innocent. Everything
    // under `.dsh/**` decides whether a write is allowed, so this cannot hold.
    const cwd = tempWorkspace('spec-gate-symlink-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), '{"languages":{}}\n')
    fs.symlinkSync(path.join(cwd, '.dsh', 'standards.json'), path.join(cwd, 'evil.json'))
    fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true })
    fs.symlinkSync(path.join(cwd, '.dsh'), path.join(cwd, 'sub', 'link'))

    for (const target of ['evil.json', 'sub/link/standards.json', './sub/../evil.json']) {
        const reason = fake.guardReason({ name: 'write', arguments: { file_path: target }, agent: fake.agent })
        assert.ok(reason !== undefined, `writing through ${target} must be denied`)
        assert.match(reason, /工程台账|信任根/)
    }
    // The check must not deny everything: an ordinary path is not refused FOR
    // BEING the trust root (this fixture has no approved spec, so the write is
    // refused for that separate, expected reason).
    const ordinary = fake.guardReason({ name: 'write', arguments: { file_path: 'src/ok.ts' }, agent: fake.agent })
    assert.doesNotMatch(ordinary ?? '', /工程台账|信任根/)
})

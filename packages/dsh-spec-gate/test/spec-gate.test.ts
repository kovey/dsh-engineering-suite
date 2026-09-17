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
    assert.deepEqual([...fake.tools.keys()].sort(), ['spec_approve', 'spec_create', 'spec_status'])
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
    assert.equal(run.isError, true)
    assert.match(String(run.content), /审批被拒绝/)
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
    assert.match(request?.reason ?? '', /测试用例 3 条/)
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

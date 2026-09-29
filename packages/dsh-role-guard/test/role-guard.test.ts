/**
 * dsh-role-guard tests: role-file parsing, least-privilege tool filtering and
 * the delegation contract.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, renderSpecMarkdown, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { unexpressibleGuarantees } from '../dist/agent-teams.js'
import { RoleBindingStore, roleForSession } from '../dist/bindings.js'
import { apply, inject, name } from '../dist/index.js'
import { parseRole } from '../dist/roles.js'
import { readTeammate, teammateObservation, UNGOVERNED_MISSING } from '../dist/teammates.js'
import { filterRefusal, planToolFilter } from '../dist/tools.js'

const HOST_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image', 'subagent', 'skill']

function stubTools(fake: FakeHost, names: readonly string[] = HOST_TOOLS): void {
    for (const toolName of names) {
        fake.tools.set(toolName, {
            name: toolName,
            description: 'stub',
            parameters: {},
            execute: async () => 'ok',
        })
    }
}

function host(cwd = tempWorkspace('role-guard-'), config: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, withSubagents: true })
    stubTools(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log'), ...config })
    return fake
}

/** A workspace with one read-only role that declares a skill whitelist. */
function skillRoleWorkspace(): string {
    const cwd = tempWorkspace('role-guard-skill-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    fs.writeFileSync(
        path.join(rolesDir, 'auditor.md'),
        [
            '---',
            'id: auditor',
            'name: 技能受限审查者',
            'description: 只读审查，只允许白名单内的技能',
            'mode: read',
            'tools:',
            '  - read',
            '  - grep',
            'skills:',
            '  - allowed-skill',
            '---',
            '只读审查，只使用白名单技能。',
            '',
        ].join('\n'),
    )
    return cwd
}

/** The child agent object `team_delegate` produces: `run-1` is the child session id. */
function childAgent(cwd: string, sessionId: string, parentSession: string): Record<string, unknown> {
    return {
        id: `agent-${sessionId}`,
        session: { id: sessionId, header: { id: sessionId, cwd, parentSession, origin: 'subagent' } },
    }
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-role-guard')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the delegation tools and the prompt section', () => {
    const fake = host()
    assert.deepEqual([...fake.tools.keys()].filter((key) => key === 'team_delegate' || key === 'role_list').sort(), [
        'role_list',
        'team_delegate',
    ])
    assert.deepEqual(
        fake.sections.map((section) => section.name),
        ['eng:role-guard'],
    )
    const text = fake.sectionText('eng:role-guard')
    assert.match(text, /team_delegate/)
    assert.match(text, /developer/)
    assert.match(text, /reviewer/)
    fake.dispose()
    assert.equal(fake.tools.has('team_delegate'), false)
})

test('builtin roles ship with the package and are listed', async () => {
    const fake = host()
    const text = runText(await fake.runTool('role_list', {}))
    assert.match(text, /\| developer \|/)
    assert.match(text, /\| reviewer \|/)
    assert.match(text, /\| qa \|/)
    assert.match(text, /read/)

    const single = runText(await fake.runTool('role_list', { role: 'reviewer' }))
    assert.match(single, /mode: read/)
    assert.match(single, /只读角色/)
})

test('a workspace role file is loaded and can override a builtin role', async () => {
    const cwd = tempWorkspace('role-guard-ws-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    fs.writeFileSync(
        path.join(rolesDir, 'auditor.md'),
        [
            '---',
            'id: auditor',
            'name: 审计员',
            'description: 只读审计',
            'mode: read',
            'tools:',
            '  - read',
            '  - grep',
            'model: deepseek-official/deepseek-v4-flash',
            '---',
            '',
            '你是审计员，只读。',
            '',
        ].join('\n'),
    )
    fs.writeFileSync(
        path.join(rolesDir, 'qa.md'),
        ['---', 'id: qa', 'name: 本地验证者', 'mode: read', 'tools:', '  - read', '---', '本地覆盖的 qa。', ''].join('\n'),
    )
    const fake = host(cwd)
    const text = runText(await fake.runTool('role_list', {}))
    assert.match(text, /\| auditor \|/)
    assert.match(text, /本地验证者/)
    const auditor = runText(await fake.runTool('role_list', { role: 'auditor' }))
    assert.match(auditor, /deepseek-official\/deepseek-v4-flash/)
})

test('a malformed role file is reported instead of breaking assembly', async () => {
    const cwd = tempWorkspace('role-guard-bad-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'roles'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'roles', 'broken.md'), 'no frontmatter here\n')
    const fake = host(cwd)
    const text = runText(await fake.runTool('role_list', {}))
    assert.match(text, /角色文件问题/)
    assert.match(text, /broken\.md/)
    // The builtin roles still work.
    assert.match(text, /\| developer \|/)
})

test('planToolFilter keeps read-only roles free of write tools and drops unknown names', () => {
    const config = {
        readonlyDeny: ['write', 'edit', 'str_replace_editor'],
    } as never
    const visible = (toolName: string): boolean => HOST_TOOLS.includes(toolName)

    const reviewer = parseRole(
        ['---', 'id: r', 'mode: read', 'tools:', '  - read', '  - write', '  - nope', '---', 'persona'].join('\n'),
        'test',
    )
    assert.ok(!('error' in reviewer))
    const plan = planToolFilter(reviewer, config, visible)
    assert.deepEqual(plan.filter?.allow, ['read'])
    assert.deepEqual(plan.dropped, ['nope'])

    const writeRole = parseRole(['---', 'id: d', 'mode: write', 'tools:', '  - read', '  - write', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in writeRole))
    const writePlan = planToolFilter(writeRole, config, visible)
    assert.deepEqual(writePlan.filter?.allow, ['read', 'write'])
    assert.equal(writePlan.dropped.length, 0)

    // A role with no tool list inherits everything except its deny list.
    const inheriting = parseRole(['---', 'id: i', 'mode: write', 'deny:', '  - bash', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in inheriting))
    const inheritPlan = planToolFilter(inheriting, config, visible)
    assert.equal(inheritPlan.filter?.allow, undefined)
    assert.deepEqual(inheritPlan.filter?.deny, ['bash'])
})

test('team_delegate creates the child with the role persona, model and tool filter', async () => {
    const fake = host()
    const run = await fake.runTool('team_delegate', {
        role: 'reviewer',
        task: '审查 src/server.ts 是否满足 AC-001',
        context: '刚完成实现',
        deliverable: '逐条结论 + 证据',
    })
    assert.equal(run.isError, false)
    assert.equal(fake.subagentStarts.length, 1)
    const start = fake.subagentStarts[0] as { provider: string; request: Record<string, unknown> }
    assert.equal(start.provider, 'spawn')
    assert.deepEqual(start.request['toolFilter'], { allow: ['read', 'glob', 'grep'] })
    assert.match(String(start.request['persona']), /审查者/)
    const prompt = (start.request['prompt'] as { text: string }[])[0]?.text ?? ''
    assert.match(prompt, /# 角色：审查者/)
    assert.match(prompt, /## 任务/)
    assert.match(prompt, /只读角色/)
    assert.match(runText(run), /child output/)
    assert.match(runText(run), /stop reason: 完成/)
})

test('team_delegate refuses an unknown role and a missing subagent service', async () => {
    const fake = host()
    const unknown = await fake.runTool('team_delegate', { role: 'nope', task: 'x' })
    assert.equal(unknown.isError, true)
    assert.match(String(unknown.content), /未知角色/)

    const bare = createFakeHost({ cwd: tempWorkspace('role-guard-bare-') })
    stubTools(bare)
    apply(bare.ctx as never, { logFile: path.join(bare.cwd, 'role-guard.log') })
    const missing = await bare.runTool('team_delegate', { task: 'x' })
    assert.equal(missing.isError, true)
    assert.match(String(missing.content), /ctx\.subagents/)
})

test('a model route in the role file becomes agentOptions', async () => {
    const cwd = tempWorkspace('role-guard-model-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'roles'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'roles', 'cheap.md'),
        ['---', 'id: cheap', 'name: 便宜模型', 'mode: write', 'model: deepseek-official/deepseek-v4-flash', 'tools:', '  - read', '---', '用便宜模型干活。', ''].join('\n'),
    )
    const fake = host(cwd)
    await fake.runTool('team_delegate', { role: 'cheap', task: 't' })
    const start = fake.subagentStarts[0] as { request: Record<string, unknown> }
    assert.deepEqual(start.request['agentOptions'], { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('the child prompt carries the approved mission contract', async () => {
    const fake = host()
    const stores = new MissionStoreRegistry().for(fake.cwd)
    const mission = stores.create({ title: 'spec injection', cwd: fake.cwd, sessionId: 'session-1' })
    stores.bindSession('session-1', mission.id)
    stores.update(mission.id, () => ({
        status: 'spec-approved',
        spec: {
            title: 'spec injection',
            background: '',
            requirements: ['r'],
            acceptanceCriteria: [{ id: 'AC-001', text: '必须返回 200' }],
            fileBoundaries: ['src/**'],
            negativeConstraints: ['不得修改 dsh 核心代码'],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'approval',
        },
    }))
    const record = stores.read(mission.id)
    assert.ok(record !== undefined)
    stores.writeSpec(mission.id, renderSpecMarkdown(record))

    await fake.runTool('team_delegate', { role: 'developer', task: '实现' })
    const start = fake.subagentStarts[0] as { request: Record<string, unknown> }
    const prompt = (start.request['prompt'] as { text: string }[])[0]?.text ?? ''
    assert.match(prompt, /AC-001/)
    assert.match(prompt, /不得修改 dsh 核心代码/)
    assert.match(prompt, /src\/\*\*/)
})

test('an empty or unusable whitelist can never widen a child\'s rights (regression)', () => {
    const config = { readonlyDeny: ['write', 'edit', 'str_replace_editor'] } as never
    const visible = (toolName: string): boolean => HOST_TOOLS.includes(toolName)

    // A whitelist whose every entry is unknown must stay an (empty) whitelist,
    // never degrade into "no filter at all".
    const typos = parseRole(['---', 'id: t', 'mode: read', 'tools:', '  - typo1', '  - typo2', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in typos))
    const typoPlan = planToolFilter(typos, config, visible)
    assert.deepEqual(typoPlan.filter?.allow, [])
    assert.match(filterRefusal(typos, typoPlan) ?? '', /白名单在当前部署里没有任何可用项/)

    // A read-only role that only listed write tools must NOT get them back.
    const onlyWrites = parseRole(['---', 'id: w', 'mode: read', 'tools:', '  - write', '  - edit', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in onlyWrites))
    const writePlan = planToolFilter(onlyWrites, config, visible)
    assert.deepEqual(writePlan.filter?.allow, [])
    assert.match(filterRefusal(onlyWrites, writePlan) ?? '', /白名单/)
    assert.equal(writePlan.filter?.allow?.includes('write'), false)

    // A read-only role without any whitelist cannot be proven read-only.
    const noList = parseRole(['---', 'id: n', 'mode: read', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in noList))
    assert.match(filterRefusal(noList, planToolFilter(noList, config, visible)) ?? '', /没有声明 tools 白名单/)

    // A healthy role passes the refusal check unchanged.
    const reviewer = parseRole(['---', 'id: r', 'mode: read', 'tools:', '  - read', '  - grep', '---', 'persona'].join('\n'), 'test')
    assert.ok(!('error' in reviewer))
    assert.equal(filterRefusal(reviewer, planToolFilter(reviewer, config, visible)), undefined)
})

test('a broken workspace role file refuses delegation instead of falling back to the builtin', async () => {
    const cwd = tempWorkspace('role-guard-broken-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'roles'), { recursive: true })
    // Meant to demote developer to read-only, but the mode value is invalid.
    fs.writeFileSync(path.join(cwd, '.dsh', 'roles', 'developer.md'), ['---', 'id: developer', 'mode: readonly', '---', '只读。', ''].join('\n'))
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'developer', task: 'x' })
    assert.equal(run.isError, true)
    assert.match(String(run.content), /解析失败/)
    assert.equal(fake.subagentStarts.length, 0, 'the child must never start with inherited rights')
})

test('a delegated run is disposed even when the child reports a stop reason', async () => {
    const fake = host()
    let disposed = 0
    const subagents = (fake.ctx as { get: (name: string) => unknown }).get('subagents') as {
        start: () => Promise<{ id: string; result: Promise<unknown>; dispose: () => Promise<void> }>
    }
    const original = subagents.start
    subagents.start = async (...args: unknown[]) => {
        const run = await (original as (...values: unknown[]) => Promise<{ id: string; result: Promise<unknown> }>)(...args)
        return { ...run, dispose: async () => { disposed += 1 } }
    }
    await fake.runTool('team_delegate', { role: 'reviewer', task: 'review' })
    assert.equal(disposed, 1)
})

test('a role file edited mid-session is picked up without a reload (regression)', async () => {
    const cwd = tempWorkspace('role-guard-hot-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    fs.writeFileSync(path.join(rolesDir, 'auditor.md'), ['---', 'id: auditor', 'name: 版本一', 'mode: read', 'tools:', '  - read', '---', '只读。', ''].join('\n'))
    const fake = host(cwd)
    assert.match(runText(await fake.runTool('role_list', { role: 'auditor' })), /版本一/)

    // Edit the file (content + mtime change) and read again through the same host.
    await new Promise((resolve) => setTimeout(resolve, 20))
    fs.writeFileSync(path.join(rolesDir, 'auditor.md'), ['---', 'id: auditor', 'name: 版本二', 'mode: read', 'tools:', '  - read', '  - grep', '---', '只读。', ''].join('\n'))
    const after = runText(await fake.runTool('role_list', { role: 'auditor' }))
    assert.match(after, /版本二/)
    assert.match(after, /read, grep/)
})

test('an inline role config supports the same route fields as a role file (regression)', async () => {
    const cwd = tempWorkspace('role-guard-inline-')
    const fake = createFakeHost({ cwd, withSubagents: true })
    stubTools(fake)
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'role-guard.log'),
        roles: [
            {
                id: 'cheap',
                name: '便宜模型',
                mode: 'write',
                tools: ['read', 'write'],
                model: 'deepseek-official/deepseek-v4-flash',
                reasoningEffort: 'low',
                maxTokens: 4096,
                persona: '用便宜模型干活。',
            },
        ],
    })
    await fake.runTool('team_delegate', { role: 'cheap', task: 't' })
    const start = fake.subagentStarts[0] as { request: Record<string, unknown> }
    assert.deepEqual(start.request['agentOptions'], { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 4096 })
})

// --- per-call model routing -------------------------------------------------

/** A workspace with a routed write role and one role that declares no route. */
function routeRoleWorkspace(): string {
    const cwd = tempWorkspace('role-guard-route-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    fs.writeFileSync(
        path.join(rolesDir, 'cheap.md'),
        [
            '---',
            'id: cheap',
            'name: 便宜模型',
            'mode: write',
            'model: deepseek-official/deepseek-v4-flash',
            'reasoningEffort: low',
            'maxTokens: 2048',
            'tools:',
            '  - read',
            '---',
            '用便宜模型干活。',
            '',
        ].join('\n'),
    )
    fs.writeFileSync(
        path.join(rolesDir, 'noroute.md'),
        ['---', 'id: noroute', 'name: 无路由', 'mode: write', 'tools:', '  - read', '---', '没有声明路由。', ''].join('\n'),
    )
    return cwd
}

/** The request recorded for the n-th `team_delegate` start. */
function startRequest(fake: FakeHost, index = 0): Record<string, unknown> {
    const start = fake.subagentStarts[index] as { provider: string; request: Record<string, unknown> }
    return start.request
}

/** The route of the `cheap` role file above. */
const ROLE_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 2048 }

test('a call-level model override reaches the child and names itself as the source (regression)', async () => {
    const fake = host()
    const run = await fake.runTool('team_delegate', {
        role: 'reviewer',
        task: '审查实现',
        model: 'deepseek-official/deepseek-v4-pro',
        reasoningEffort: 'high',
    })
    assert.equal(run.isError, false)
    assert.deepEqual(startRequest(fake)['agentOptions'], {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
    })
    assert.match(runText(run), /模型：deepseek-official\/deepseek-v4-pro（调用覆盖；effort=high）/)
})

test("without an override the role file's route wins and is named as the source (regression)", async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'cheap', task: 't' })
    assert.equal(run.isError, false)
    assert.deepEqual(startRequest(fake)['agentOptions'], ROLE_ROUTE)
    assert.match(runText(run), /模型：deepseek-official\/deepseek-v4-flash（角色文件；effort=low；maxTokens=2048）/)
})

test('allowModelOverride: false ignores the call override and explains why (regression)', async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd, { allowModelOverride: false })
    const run = await fake.runTool('team_delegate', {
        role: 'cheap',
        task: 't',
        model: 'deepseek-official/deepseek-v4-pro',
        reasoningEffort: 'high',
        maxTokens: 999,
    })
    assert.equal(run.isError, false)
    // The role's route, field by field — nothing of the call survives.
    assert.deepEqual(startRequest(fake)['agentOptions'], ROLE_ROUTE)
    const text = runText(run)
    assert.match(text, /宿主禁用了按调用覆盖模型：沿用角色路由/)
    assert.match(text, /被忽略的调用参数：model、reasoningEffort、maxTokens/)
    assert.match(text, /模型：deepseek-official\/deepseek-v4-flash（角色文件；effort=low；maxTokens=2048）/)
    assert.doesNotMatch(text, /deepseek-v4-pro/)

    // With no override parameters the switch has nothing to say.
    const quiet = await fake.runTool('team_delegate', { role: 'cheap', task: 't' })
    assert.doesNotMatch(runText(quiet), /宿主禁用了按调用覆盖模型/)
})

test('a malformed override never produces a broken agentOptions (regression)', async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd)

    // An empty model falls back to the role's route for that field.
    const empty = await fake.runTool('team_delegate', { role: 'cheap', task: 't', model: '' })
    assert.equal(empty.isError, false)
    assert.deepEqual(startRequest(fake, 0)['agentOptions'], ROLE_ROUTE)
    assert.match(runText(empty), /model 覆盖参数无效（空字符串）/)
    assert.match(runText(empty), /沿用角色路由的 model（deepseek-official\/deepseek-v4-flash）/)

    // A wrong TYPE never reaches the plugin: the declared schema rejects it, so
    // the model gets a precise "must be a string" instead of a silent fallback.
    const wrongType = await fake.runTool('team_delegate', { role: 'cheap', task: 't', model: 42 })
    assert.equal(wrongType.isError, true)
    assert.match(String(wrongType.content), /model/)
    assert.equal(fake.subagentStarts.length, 1, 'no child was started for a schema-rejected call')

    // A non-positive token cap is refused too.
    const negative = await fake.runTool('team_delegate', { role: 'cheap', task: 't', maxTokens: -5 })
    assert.equal(negative.isError, false)
    assert.deepEqual(startRequest(fake, 1)['agentOptions'], ROLE_ROUTE)
    assert.match(runText(negative), /maxTokens 覆盖参数无效（期望正整数，收到 number -5）/)
    assert.match(runText(negative), /沿用角色路由的 maxTokens（2048）/)

    // A bare model id keeps the role's provider, and says where the rest came from.
    const bare = await fake.runTool('team_delegate', { role: 'cheap', task: 't', model: 'deepseek-v4-pro' })
    assert.equal(bare.isError, false)
    assert.deepEqual(startRequest(fake, 2)['agentOptions'], { ...ROLE_ROUTE, model: 'deepseek-v4-pro' })
    assert.match(runText(bare), /模型：deepseek-official\/deepseek-v4-pro（调用覆盖；effort=low 来自角色文件；maxTokens=2048 来自角色文件）/)

    // With no provider anywhere a bare model id cannot be routed: refuse it
    // instead of handing the provider a model it cannot place.
    const orphan = await fake.runTool('team_delegate', { role: 'noroute', task: 't', model: 'deepseek-v4-pro' })
    assert.equal(orphan.isError, false)
    assert.equal(startRequest(fake, 3)['agentOptions'], undefined)
    assert.match(runText(orphan), /裸模型 id "deepseek-v4-pro"，但角色路由也没有 provider/)
    assert.match(runText(orphan), /模型：宿主默认/)
})

test('the binding records the effective route and it survives a fresh apply() (regression)', async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', {
        role: 'cheap',
        task: 't',
        model: 'deepseek-official/deepseek-v4-pro',
        reasoningEffort: 'high',
    })
    assert.equal(run.isError, false)

    const file = path.join(cwd, '.dsh', 'state', 'roles', 'run-1.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    // The pre-existing fields keep their shape…
    assert.equal(stored['sessionId'], 'run-1')
    assert.equal(stored['roleId'], 'cheap')
    assert.equal(stored['role'], '便宜模型')
    assert.equal(stored['mode'], 'write')
    assert.deepEqual(stored['tools'], ['read'])
    assert.deepEqual(stored['skills'], [])
    assert.equal(typeof stored['updatedAt'], 'number')
    // …and the effective route (call override over the role's file) is recorded.
    const route = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 2048 }
    assert.deepEqual(stored['route'], route)

    // Read back through the store…
    const first = new RoleBindingStore(() => resolveLayout(cwd))
    assert.deepEqual(roleForSession(first, fake.agent, 'run-1')?.route, route)
    fake.dispose()

    // …and through a fresh apply() in the same workspace.
    const second = host(cwd)
    const binding = roleForSession(new RoleBindingStore(() => resolveLayout(cwd)), second.agent, 'run-1')
    assert.deepEqual(binding?.route, route)
    assert.deepEqual(binding?.tools, ['read'])

    // A child that inherits the host's own route carries no route field at all,
    // so a binding file written before this field existed stays readable.
    await second.runTool('team_delegate', { role: 'noroute', task: 't' })
    const inherited = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal('route' in inherited, false)
    assert.equal(inherited['roleId'], 'noroute')
})

// --- skill whitelist enforcement (invocation time) --------------------------

test("a delegated role's skill whitelist is enforced at invocation time (regression)", async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    assert.equal(run.isError, false)
    assert.match(runText(run), /skill whitelist: allowed-skill（调用时强制）/)

    const child = childAgent(cwd, 'run-1', 'session-1')
    const denied = fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child })
    assert.equal(typeof denied, 'string')
    assert.match(String(denied), /技能白名单拒绝/)
    assert.match(String(denied), /auditor/)
    assert.match(String(denied), /other-skill/)
    assert.match(String(denied), /allowed-skill/)
    assert.match(String(denied), /交回主 Agent/)

    // Argument-shape tricks cannot smuggle another skill past the gate: the
    // first recognised string wins, and other keys never soften the check.
    for (const arguments_ of [
        { skill: 'other-skill' },
        { skill_id: 'other-skill' },
        { id: 'other-skill' },
        { name: 'other-skill', id: 'allowed-skill' },
        { name: ' other-skill ' },
        JSON.stringify({ name: 'other-skill' }),
    ]) {
        assert.equal(
            typeof fake.guardReason({ name: 'skill', arguments: arguments_, agent: child }),
            'string',
            `the gate must deny ${JSON.stringify(arguments_)}`,
        )
    }

    // The whitelisted skill loads, and a non-skill tool is never the gate's business.
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'allowed-skill' }, agent: child }), undefined)
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/server.ts' }, agent: child }), undefined)
    // The main agent is not a delegated child: no binding, no restriction.
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: fake.agent }), undefined)
})

test('a builtin role with a skill whitelist is enforced too (regression)', async () => {
    const fake = host()
    await fake.runTool('team_delegate', { role: 'developer', task: '实现' })
    const child = childAgent(fake.cwd, 'run-1', 'session-1')
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'auto-retrospective' }, agent: child }), undefined)
    assert.match(String(fake.guardReason({ name: 'skill', arguments: { name: 'unity-mcp-orchestrator' }, agent: child }) ?? ''), /开发者|developer/)
})

test('a session with no role binding is never blocked (regression)', async () => {
    const fake = host()
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'anything' }, agent: fake.agent }), undefined)
    // A subagent whose session was never created by team_delegate inherits nothing.
    const orphan = childAgent(fake.cwd, 'orphan-1', 'session-1')
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'anything' }, agent: orphan }), undefined)
    // A call with no agent at all is not our business either.
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'anything' } }), undefined)
})

test('a role with an empty skills list is never blocked (regression)', async () => {
    const fake = host()
    await fake.runTool('team_delegate', { role: 'qa', task: '跑验证' })
    // `skills: []` must parse as "no list", not as the literal name "[]".
    assert.match(runText(await fake.runTool('role_list', { role: 'qa' })), /skills: \(未声明 = 不限制\)/)
    const child = childAgent(fake.cwd, 'run-1', 'session-1')
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'any-skill' }, agent: child }), undefined)
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: '[]' }, agent: child }), undefined)
})

test("a grandchild inherits its parent's skill whitelist (regression)", async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    await fake.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    // No binding of its own; its `parentSession` is the bound child.
    const grandchild = childAgent(cwd, 'grand-1', 'run-1')
    assert.match(String(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: grandchild }) ?? ''), /技能白名单拒绝/)
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'allowed-skill' }, agent: grandchild }), undefined)
})

test('the skill gate is total: malformed calls and corrupt files never throw or block (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    await fake.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    const child = childAgent(cwd, 'run-1', 'session-1')
    const malformed: unknown[] = [
        { name: 'skill', arguments: {}, agent: child },
        { name: 'skill', arguments: { name: 42 }, agent: child },
        { name: 'skill', arguments: { name: undefined, id: null }, agent: child },
        { name: 'skill', agent: child },
        { name: 'skill', arguments: 'not json', agent: child },
        { name: 'skill', arguments: undefined, agent: child },
        { name: 42, arguments: { name: 'other-skill' }, agent: child },
        { name: 'skill', arguments: { name: 'other-skill' } },
        {},
        undefined,
    ]
    for (const exec of malformed) {
        assert.equal(fake.guardReason(exec), undefined, `the gate must not deny a call it cannot parse: ${JSON.stringify(exec)}`)
    }
    // A corrupt binding file reads as "no binding" instead of blocking the tool.
    fs.writeFileSync(path.join(cwd, '.dsh', 'state', 'roles', 'run-1.json'), '{ not json at all')
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }), undefined)
})

test('the role binding is durable: a fresh apply() in the same workspace still enforces it (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const first = host(cwd)
    await first.runTool('team_delegate', { role: 'auditor', task: '审查实现' })

    const file = path.join(cwd, '.dsh', 'state', 'roles', 'run-1.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(stored['sessionId'], 'run-1')
    assert.equal(stored['roleId'], 'auditor')
    assert.equal(stored['role'], '技能受限审查者')
    assert.equal(stored['mode'], 'read')
    assert.deepEqual(stored['skills'], ['allowed-skill'])
    assert.deepEqual(stored['tools'], ['read', 'grep'])
    assert.equal(typeof stored['updatedAt'], 'number')
    first.dispose()

    // A second assembly has no in-memory state: the file is the source of truth.
    const second = host(cwd)
    const child = childAgent(cwd, 'run-1', 'session-1')
    assert.match(String(second.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }) ?? ''), /技能白名单拒绝/)
    assert.equal(second.guardReason({ name: 'skill', arguments: { name: 'allowed-skill' }, agent: child }), undefined)
})

test('disposal drops the cache but keeps the binding file for a resumed child (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    await fake.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    const child = childAgent(cwd, 'run-1', 'session-1')
    const file = path.join(cwd, '.dsh', 'state', 'roles', 'run-1.json')
    assert.match(String(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }) ?? ''), /技能白名单拒绝/)

    // Every payload shape the host may emit must be handled without throwing.
    fake.emit('agent/disposed', { agent: child })
    fake.emit('agent/disposed', [child])
    fake.emit('session/disposed', 'run-1')
    fake.emit('session/disposed', { session: { id: 'run-1' } })

    assert.equal(fs.existsSync(file), true, 'the binding must survive disposal: a resumed child keeps its role')
    assert.match(String(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }) ?? ''), /技能白名单拒绝/)
})

test('the skill gate is configurable and can be switched off (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const child = childAgent(cwd, 'run-1', 'session-1')

    const disabled = host(cwd, { enforceSkillWhitelist: false })
    await disabled.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    assert.equal(disabled.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }), undefined)

    const renamed = host(cwd, { skillTools: ['load_skill'] })
    await renamed.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    assert.equal(renamed.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: child }), undefined)
    assert.match(String(renamed.guardReason({ name: 'load_skill', arguments: { skill: 'other-skill' }, agent: child }) ?? ''), /技能白名单拒绝/)
    assert.equal(renamed.guardReason({ name: 'load_skill', arguments: { skill: 'allowed-skill' }, agent: child }), undefined)
})

test('the role-guard service plans a delegation without a model in the loop (regression)', async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd)
    // `apply()` provides the service; the fake context records it.
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as
        | {
              plan(request: { role: string; cwd?: string }): {
                  persona: string
                  toolFilter?: { allow?: readonly string[] }
                  route: { model?: string; provider?: string }
                  dropped: readonly string[]
              }
              list(cwd?: string): string[]
          }
        | undefined
    assert.ok(service !== undefined, 'the service is provided at assembly')

    const plan = service.plan({ role: 'cheap', cwd })
    assert.match(plan.persona, /用便宜模型干活/)
    assert.deepEqual(plan.route, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 2048 })
    assert.deepEqual(plan.toolFilter?.allow, ['read'], 'the role whitelist is enforced, not inherited')

    // An unknown role is REFUSED: an autonomous dispatcher must never get a
    // widened child because it guessed a role id.
    assert.throws(() => service.plan({ role: 'does-not-exist', cwd }), /未知角色 "does-not-exist"/)
    assert.ok(service.list(cwd).includes('cheap'))
})

test('a read-only role keeps its restriction through the service seam (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as {
        plan(request: { role: string; cwd?: string }): { toolFilter?: { allow?: readonly string[] }; mode: string }
    }
    const plan = service.plan({ role: 'auditor', cwd })
    assert.equal(plan.mode, 'read')
    const allow = plan.toolFilter?.allow ?? []
    assert.equal(allow.includes('write'), false)
    assert.equal(allow.includes('edit'), false)
    assert.equal(allow.includes('bash'), false)
})

test('the service refuses exactly what team_delegate refuses (regression)', async () => {
    // A broken role file must not silently become the builtin role of the same
    // id: that turns a broken "demotion" into an escalation.
    const cwd = tempWorkspace('role-guard-service-gates-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    fs.writeFileSync(path.join(rolesDir, 'developer.md'), ['---', 'id: developer', 'mode: readonly', '---', '坏了', ''].join('\n'))
    const fake = host(cwd)
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as {
        plan(request: { role: string; cwd?: string }): unknown
    }
    assert.throws(() => service.plan({ role: 'developer', cwd }), /定义文件解析失败/)

    // A read-only role without a whitelist cannot be planned either: a deny list
    // can only subtract names it knows, so it would inherit every write tool.
    const other = tempWorkspace('role-guard-service-readonly-')
    const otherRoles = path.join(other, '.dsh', 'roles')
    fs.mkdirSync(otherRoles, { recursive: true })
    fs.writeFileSync(path.join(otherRoles, 'nolist.md'), ['---', 'id: nolist', 'mode: read', '---', '只读但没写白名单', ''].join('\n'))
    const otherFake = host(other)
    const otherService = (otherFake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as {
        plan(request: { role: string; cwd?: string }): unknown
    }
    assert.throws(() => otherService.plan({ role: 'nolist', cwd: other }), /没有声明 tools 白名单/)
})

test('the service refuses a workspace that does not exist instead of using builtins (regression)', async () => {
    const cwd = routeRoleWorkspace()
    const fake = host(cwd)
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as {
        plan(request: { role: string; cwd?: string }): unknown
    }
    assert.throws(() => service.plan({ role: 'cheap', cwd: path.join(cwd, 'typo') }), /不存在或不是目录/)
})

test('the service binds the child so the skill whitelist applies (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const fake = host(cwd)
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as {
        bind(request: { role: string; sessionId: string; cwd?: string }): { skills?: readonly string[] } | undefined
    }
    const binding = service.bind({ role: 'auditor', sessionId: 'run-skill', cwd })
    assert.ok(binding !== undefined, 'a dispatched child must get a binding')
    assert.deepEqual(binding?.skills, ['allowed-skill'])
    // The binding the skill gate reads is on disk for this child session.
    // The layout decides the exact path; assert on the real one instead of
    // guessing at the directory names.
    const found: string[] = []
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.name === 'run-skill.json') found.push(full)
        }
    }
    walk(path.join(cwd, '.dsh'))
    assert.equal(found.length, 1, `expected exactly one binding file, found: ${found.join(', ')}`)
})

// --- Agent Teams composition (a collaboration surface, never authority) ------

/**
 * A fake `agentTeams` service, shaped like the one harness 0.2.0-rc.1 mounts
 * (`TeamService`: `spawnTeammate` + roster/mailbox reads). `spawns()` counts
 * calls, so a test can prove the official path was NOT used.
 */
function fakeAgentTeams(): { service: Record<string, unknown>; spawns: () => number } {
    let spawns = 0
    return {
        service: {
            spawnTeammate: async () => {
                spawns += 1
                return { member: { id: 'teammate-1', name: 'peer', role: 'teammate', status: 'active', diagnostics: [] } }
            },
            listMembers: () => [],
            tryMembership: () => undefined,
        },
        spawns: () => spawns,
    }
}

/** A host with an official Agent Teams service mounted (`undefined` = not installed). */
function hostWithTeams(cwd: string, service: unknown, config: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, withSubagents: true, services: service === undefined ? {} : { agentTeams: service } })
    stubTools(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log'), ...config })
    return fake
}

/** The Team Lead's session object, as `session/event` carries it. */
function leadSession(cwd: string, id = 'session-1'): Record<string, unknown> {
    return { id, header: { id, cwd } }
}

/** One `team/member` session event, as the official journal writes it. */
function teamMemberEvent(member: Record<string, unknown>, teamId = 'session-1'): Record<string, unknown> {
    return {
        type: 'team/member',
        seq: 1,
        time: Date.now(),
        data: { version: 2, teamId, member: { provider: 'spawn', context: 'fresh', ...member } },
    }
}

test('a team-style dispatch is refused by name and served by the governed path (regression)', async () => {
    const cwd = tempWorkspace('role-guard-teams-')
    const teams = fakeAgentTeams()
    const fake = hostWithTeams(cwd, teams.service)
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查 src/server.ts', dispatch: 'team' })
    assert.equal(run.isError, false)
    const text = runText(run)
    // Which path was used, and exactly why the official one was not.
    assert.match(text, /dispatch path: subagents/)
    assert.match(text, /spawnTeammate/)
    assert.match(text, /persona 影子段/)
    assert.match(text, /工具白名单/)
    // The official spawn was never called: no teammate exists that we did not govern.
    assert.equal(teams.spawns(), 0)
    // …and the delegation carries every guarantee it carried before.
    assert.equal(fake.subagentStarts.length, 1)
    const start = fake.subagentStarts[0] as { provider: string; request: Record<string, unknown> }
    assert.equal(start.provider, 'spawn')
    assert.deepEqual(start.request['toolFilter'], { allow: ['read', 'glob', 'grep'] })
    assert.match(String(start.request['persona']), /审查者/)
    assert.match(text, /child output/)
    // The durable per-child record names the path as well.
    const binding = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'state', 'roles', 'run-1.json'), 'utf8')) as Record<string, unknown>
    assert.equal(binding['dispatch'], 'subagents')
})

test('the refusal names exactly the guarantees this role needs (regression)', async () => {
    /** The named-guarantee bullets of a dispatch report (the report's own lines only). */
    const refusalLines = (text: string): string =>
        text
            .split('\n')
            .filter((line) => line.startsWith('  - '))
            .join('\n')

    // `auditor`: persona + tool whitelist + skill whitelist, no model route.
    const cwd = skillRoleWorkspace()
    const text = runText(
        await hostWithTeams(cwd, fakeAgentTeams().service).runTool('team_delegate', { role: 'auditor', task: '审查实现', dispatch: 'team' }),
    )
    assert.match(refusalLines(text), /persona 影子段/)
    assert.match(refusalLines(text), /工具白名单/)
    assert.match(refusalLines(text), /技能白名单/)
    assert.doesNotMatch(refusalLines(text), /模型路由/, 'the role declares no route, so nothing about routing may be refused')

    // A role that declares a route is told about that too.
    const routed = runText(
        await hostWithTeams(routeRoleWorkspace(), fakeAgentTeams().service).runTool('team_delegate', {
            role: 'cheap',
            task: 't',
            dispatch: 'team',
        }),
    )
    assert.match(refusalLines(routed), /模型路由/)
})

test('the persona guarantee is structural: a role that declares nothing still needs one (regression)', () => {
    const role = parseRole(['---', 'id: bare', 'mode: write', 'tools: []', 'deny: []', 'skills: []', '---', '只声明了 persona。'].join('\n'), 'test')
    assert.ok(!('error' in role))
    // No tool filter, no route, no skills: the persona alone is unexpressible,
    // because every loadable role has one and `SpawnTeammateRequest` has no
    // persona field. That is why the official path is refused for EVERY role.
    const missing = unexpressibleGuarantees(role, { filter: {}, dropped: [] }, {})
    assert.equal(missing.length, 1)
    assert.match(missing[0] ?? '', /persona 影子段/)
})

test("composeWithAgentTeams: 'off' reproduces the previous dispatch exactly (regression)", async () => {
    const cwd = routeRoleWorkspace()
    const teamsOff = fakeAgentTeams()
    const off = hostWithTeams(cwd, teamsOff.service, { composeWithAgentTeams: 'off' })
    const auto = hostWithTeams(cwd, fakeAgentTeams().service)

    const plainOff = await off.runTool('team_delegate', { role: 'cheap', task: 't' })
    const plainAuto = await auto.runTool('team_delegate', { role: 'cheap', task: 't' })
    // Field for field the same start request (the signal is per-call by construction).
    const startOff = { ...(off.subagentStarts[0] as { request: Record<string, unknown> }).request }
    const startAuto = { ...(auto.subagentStarts[0] as { request: Record<string, unknown> }).request }
    delete startOff['signal']
    delete startAuto['signal']
    assert.deepEqual(startOff, startAuto)
    assert.deepEqual(startOff['toolFilter'], { allow: ['read'] })
    assert.deepEqual(startOff['agentOptions'], { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low', maxTokens: 2048 })
    // …and the same output: a delegation that did not ask for a team gains no line.
    assert.equal(runText(plainOff), runText(plainAuto))
    assert.doesNotMatch(runText(plainOff), /dispatch path/)
    // No observer is installed under 'off': the official roster is never read.
    assert.equal(off.listeners.has('session/event'), false)
    assert.equal(auto.listeners.has('session/event'), true)

    // A team request under 'off' is answered, not silently ignored.
    const refused = runText(await off.runTool('team_delegate', { role: 'cheap', task: 't', dispatch: 'team' }))
    assert.match(refused, /dispatch path: subagents/)
    assert.match(refused, /composeWithAgentTeams: off/)
    assert.equal(teamsOff.spawns(), 0)

    // …and the prompt section is the one from before this capability existed:
    // 'off' adds no paragraph, 'auto' explains the composition.
    assert.equal(off.sectionText('eng:role-guard').includes('协作面'), false)
    assert.match(auto.sectionText('eng:role-guard'), /协作面/)
})

test('a partial, hostile or missing agentTeams service never breaks a delegation (regression)', async () => {
    const cwd = tempWorkspace('role-guard-teams-partial-')
    // Mounted, but with no programmatic spawn: only the model-facing tools' backing store.
    const partial = await hostWithTeams(cwd, { listMembers: () => [], tryMembership: () => undefined }).runTool('team_delegate', {
        role: 'reviewer',
        task: 'x',
        dispatch: 'team',
    })
    assert.equal(partial.isError, false)
    assert.match(runText(partial), /dispatch path: subagents/)
    assert.match(runText(partial), /programmatic spawn/)

    // A service whose probe throws is treated as "no programmatic spawn".
    const hostile = { get spawnTeammate(): never { throw new Error('boom') } }
    const probed = await hostWithTeams(cwd, hostile).runTool('team_delegate', { role: 'reviewer', task: 'x', dispatch: 'team' })
    assert.equal(probed.isError, false)
    assert.match(runText(probed), /programmatic spawn/)

    // Nothing mounted at all.
    const absent = await hostWithTeams(cwd, undefined).runTool('team_delegate', { role: 'reviewer', task: 'x', dispatch: 'team' })
    assert.equal(absent.isError, false)
    assert.match(runText(absent), /没有挂载 agentTeams 服务/)

    // An unrecognised dispatch value falls back with a warning instead of failing.
    const typo = await hostWithTeams(cwd, fakeAgentTeams().service).runTool('team_delegate', { role: 'reviewer', task: 'x', dispatch: 'teams' })
    assert.equal(typo.isError, false)
    assert.match(runText(typo), /未知的 dispatch 值/)
})

test('a teammate created outside team_delegate is recorded as ungoverned (regression)', async () => {
    const cwd = tempWorkspace('role-guard-teams-audit-')
    const fake = hostWithTeams(cwd, fakeAgentTeams().service)
    const file = path.join(cwd, '.dsh', 'state', 'teammates', 'tm-1.json')
    assert.equal(fs.existsSync(file), false)

    fake.emit('session/event', [leadSession(cwd), teamMemberEvent({ id: 'tm-1', name: 'peer-a', phase: 'provisioning' })])
    const first = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(first['sessionId'], 'tm-1')
    assert.equal(first['teamId'], 'session-1')
    assert.equal(first['name'], 'peer-a')
    assert.equal(first['phase'], 'provisioning')
    assert.equal(first['governance'], 'ungoverned')
    assert.equal(first['provenance'], 'team/member')
    assert.deepEqual(first['missing'], [...UNGOVERNED_MISSING])
    assert.match(String(first['reason']), /未经 team_delegate/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'roles', 'tm-1.json')), false, 'a teammate record is not a role binding')

    // A later roster write updates the phase without a second record and without
    // resetting the first observation.
    fake.emit('session/event', [leadSession(cwd), teamMemberEvent({ id: 'tm-1', name: 'peer-a', phase: 'active' })])
    const second = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(second['phase'], 'active')
    assert.equal(second['observedAt'], first['observedAt'])
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.dsh', 'state', 'teammates')), ['tm-1.json'])

    // The record reads back through the store, and the plugin log carries the verdict.
    const stored = readTeammate(resolveLayout(cwd), 'tm-1')
    assert.equal(stored?.governance, 'ungoverned')
    assert.equal(stored?.phase, 'active')
    assert.match(fs.readFileSync(path.join(cwd, 'role-guard.log'), 'utf8'), /ungoverned/)
})

test('a teammate record is evidence of a gap, not a grant (regression)', async () => {
    const cwd = skillRoleWorkspace()
    const fake = hostWithTeams(cwd, fakeAgentTeams().service)
    fake.emit('session/event', [leadSession(cwd), teamMemberEvent({ id: 'tm-9', name: 'peer', phase: 'active' })])
    assert.equal(readTeammate(resolveLayout(cwd), 'tm-9')?.governance, 'ungoverned')

    // The skill gate is NOT widened by the record: a teammate whose session has
    // no binding (its own or its parent's) stays unrestricted, exactly as any
    // other child this plugin did not create — the record is a report, never a
    // policy, and it grants nothing.
    const orphan = childAgent(cwd, 'tm-9', 'session-unbound')
    assert.equal(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: orphan }), undefined)

    // And it does not weaken the gate for a teammate that DOES inherit a role
    // binding one hop up: the gate keeps working from the binding alone.
    await fake.runTool('team_delegate', { role: 'auditor', task: '审查实现' })
    const under = childAgent(cwd, 'tm-10', 'run-1')
    assert.match(String(fake.guardReason({ name: 'skill', arguments: { name: 'other-skill' }, agent: under }) ?? ''), /技能白名单拒绝/)
})

test('the roster observer is total and never files a record outside a known workspace (regression)', async () => {
    const cwd = tempWorkspace('role-guard-teams-total-')
    const fake = hostWithTeams(cwd, fakeAgentTeams().service)
    const session = leadSession(cwd)
    // Hostile or unrelated session events must not throw inside the listener.
    for (const payload of [
        [],
        [undefined, undefined],
        [session, undefined],
        [session, { type: 'team/task' }],
        [session, { type: 'team/member' }],
        [session, { type: 'team/member', data: {} }],
        [session, { type: 'team/member', data: { member: null } }],
        [session, { type: 'team/member', data: { member: { id: 'x', phase: 'nope' } } }],
        [session, { type: 'team/member', data: { teamId: 'session-1', member: { id: '', phase: 'active' } } }],
        'not an event',
    ]) {
        fake.emit('session/event', payload)
    }
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'teammates')), false)
    assert.equal(teammateObservation(session, teamMemberEvent({ id: 'tm-x', name: 'peer-x', phase: 'active' }))?.sessionId, 'tm-x')

    // A Lead session with no cwd is NOT guessed from the process directory
    // (that would file the record under whatever repository the host runs in).
    fake.emit('session/event', [{ id: 'session-2', header: {} }, teamMemberEvent({ id: 'tm-2', name: 'peer-b', phase: 'active' })])
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'teammates', 'tm-2.json')), false)

    // Under 'off' no observer exists at all: the official roster is never read.
    const off = hostWithTeams(cwd, fakeAgentTeams().service, { composeWithAgentTeams: 'off' })
    off.emit('session/event', [leadSession(cwd), teamMemberEvent({ id: 'tm-3', name: 'peer-c', phase: 'active' })])
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'teammates', 'tm-3.json')), false)
})

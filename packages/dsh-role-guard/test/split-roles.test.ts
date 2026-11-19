/**
 * The split workflow's two roles and the `model: @class` indirection
 * (AC-002 / AC-007 of the split mission; AC-001..AC-004 of the model-class
 * follow-up mission).
 *
 * What is pinned here:
 *  - `planner` is READ-ONLY and `worker` carries only the seven execution tools
 *    (no gate/delivery tool, no `team_delegate`), so "worker cannot write the
 *    main mission's gates or receipt" is a tool-surface fact, not a promise;
 *  - `model: @planner` / `@worker` resolve through the project's `models.json`;
 *  - a class that EXISTS but has no `model` is a reported FALLBACK: dispatch
 *    succeeds, the request carries no `model`/`provider` (host default), and the
 *    result text/log carry「模型类 <class> 未配置，使用宿主默认」;
 *  - a WRONG reference (`@bogus`, `@planer`, a bare `@`) is still a hard error
 *    listing the usable classes — a typo must never be read as "unconfigured".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout, type Layout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { builtinRolesDir } from '../dist/loader.js'
import { resolveModelClassRoles, resolveRoleModelClass } from '../dist/model-class.js'
import { isRoleError, parseRole, RoleRegistry, type Role } from '../dist/roles.js'

const HOST_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image', 'subagent', 'skill', 'quality_gate_run', 'mission_complete', 'evidence_record', 'orchestrate']

/** The parsed builtin role file (the same parser the loader uses). */
function builtinRole(id: string): Role {
    const file = path.join(builtinRolesDir(), `${id}.md`)
    const parsed = parseRole(fs.readFileSync(file, 'utf8'), `builtin:${id}.md`, id)
    assert.equal(isRoleError(parsed), false, `builtin role ${id} must parse: ${JSON.stringify(parsed)}`)
    return parsed as Role
}

/** A temp workspace with an optional `models.json`. */
function workspace(models?: unknown): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace('role-guard-split-')
    const layout = resolveLayout(cwd)
    if (models !== undefined) {
        fs.mkdirSync(layout.configDir, { recursive: true })
        fs.writeFileSync(path.join(layout.configDir, 'models.json'), JSON.stringify(models))
    }
    return { cwd, layout }
}

/** A host whose role list comes from `cwd`. */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd, withSubagents: true })
    for (const toolName of HOST_TOOLS) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
    apply(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log') })
    return fake
}

/** Resolve one builtin role against a workspace through the real loader step. */
function resolveIn(layout: Layout, id: string): Role {
    const registry = new RoleRegistry()
    registry.add(builtinRole(id))
    resolveModelClassRoles(registry, layout, { warn: () => undefined })
    const role = registry.get(id)
    assert.ok(role !== undefined)
    return role
}

// --- the roles themselves --------------------------------------------------

test('planner and worker are builtin roles and show up in role_list (AC-002)', async () => {
    const { cwd } = workspace()
    const fake = host(cwd)
    const text = runText(await fake.runTool('role_list', {}))
    assert.match(text, /\| planner \|/)
    assert.match(text, /\| worker \|/)
    // The table still lists the original three.
    for (const id of ['developer', 'reviewer', 'qa']) assert.match(text, new RegExp(`\\| ${id} \\|`))
    fake.dispose()
})

test('planner is READ-ONLY: no write/edit/bash tool in its whitelist (AC-002)', () => {
    const planner = builtinRole('planner')
    assert.equal(planner.mode, 'read')
    assert.deepEqual([...planner.tools], ['read', 'glob', 'grep'])
    for (const forbidden of ['write', 'edit', 'bash', 'todo_write']) {
        assert.equal(planner.tools.includes(forbidden), false, `planner must not have ${forbidden}`)
    }
    assert.equal(planner.model, '@planner')
})

test('worker is WRITE-capable but has no gate/delivery tool and no team_delegate (AC-007)', () => {
    const worker = builtinRole('worker')
    assert.equal(worker.mode, 'write')
    assert.deepEqual([...worker.tools], ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write'])
    for (const forbidden of ['team_delegate', 'orchestrate', 'quality_gate_run', 'evidence_record', 'mission_complete', 'spec_approve', 'standards_check', 'deploy_run']) {
        assert.equal(worker.tools.includes(forbidden), false, `worker must not have ${forbidden}`)
    }
    assert.equal(worker.model, '@worker')
})

// --- model: @class ---------------------------------------------------------

test('@planner / @worker resolve through the project models.json (AC-001/AC-002)', () => {
    const { layout } = workspace({
        planner: { model: 'deepseek/deepseek-reasoner', reasoningEffort: 'high' },
        worker: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' },
    })
    const planner = resolveIn(layout, 'planner')
    assert.deepEqual(planner.modelProblems, undefined)
    assert.equal(planner.provider, 'deepseek')
    assert.equal(planner.model, 'deepseek-reasoner')
    assert.equal(planner.reasoningEffort, 'high')

    const worker = resolveIn(layout, 'worker')
    assert.equal(worker.provider, 'deepseek')
    assert.equal(worker.model, 'deepseek-chat')
    assert.equal(worker.reasoningEffort, 'low')
})

test('a class that has no model FALLS BACK to the host default and says so (TC-2401 / TC-2402 / AC-001)', async () => {
    const { cwd, layout } = workspace()
    const planner = resolveIn(layout, 'planner')
    assert.deepEqual(planner.modelProblems, undefined, 'an unconfigured class is not a problem')
    assert.equal(planner.modelNote, '模型类 planner 未配置，使用宿主默认')
    // The request must carry NO route at all: that IS the host default.
    assert.equal(planner.model, undefined)
    assert.equal(planner.provider, undefined)

    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'planner', task: '拆任务' })
    assert.equal(run.isError, false, 'an unconfigured class must dispatch, not refuse')
    assert.match(runText(run), /note: 模型类 planner 未配置，使用宿主默认/)
    const start = fake.subagentStarts[0] as { request: Record<string, unknown> }
    assert.equal(start.request['agentOptions'], undefined, 'no model/provider = the host default')
    // Same sentence, logged at info level (never a warning).
    const log = fs.readFileSync(path.join(cwd, 'role-guard.log'), 'utf8')
    assert.match(log, /\[info\].*模型类 planner 未配置，使用宿主默认/)
    fake.dispose()
})

test('a WRONG class name still refuses dispatch and lists the usable classes (TC-2404 / TC-2405 / AC-002)', async () => {
    const cases = [
        { id: 'bogus-role', model: '@bogus', detail: /models\.json 没有这个类/ },
        { id: 'typo-role', model: '@planer', detail: /models\.json 没有这个类/ },
        { id: 'empty-role', model: '@', detail: /@ 后面没有类名/ },
    ] as const
    for (const entry of cases) {
        const cwd = tempWorkspace('role-guard-wrong-class-')
        const rolesDir = path.join(cwd, '.dsh', 'roles')
        fs.mkdirSync(rolesDir, { recursive: true })
        fs.writeFileSync(
            path.join(rolesDir, `${entry.id}.md`),
            ['---', `id: ${entry.id}`, `name: ${entry.model}`, 'mode: read', `model: '${entry.model}'`, 'tools:', '  - read', '---', '只读。', ''].join('\n'),
        )
        const fake = host(cwd)
        const run = await fake.runTool('team_delegate', { role: entry.id, task: 't' })
        assert.equal(run.isError, true, `${entry.model} must be refused, not treated as unconfigured`)
        const text = String(run.content)
        assert.match(text, /模型类引用无法解析/)
        assert.match(text, /可用模型类：planner \/ worker/)
        assert.match(text, entry.detail)
        assert.match(text, /类名写错不会被当成"未配置"放过/)
        assert.equal(fake.subagentStarts.length, 0, 'a typo never starts a child')
        fake.dispose()
    }
})

test('a workspace that configures only one class resolves that one and falls back for the other', () => {
    const { layout } = workspace({ worker: { model: 'deepseek/deepseek-chat' } })
    assert.equal(resolveIn(layout, 'worker').model, 'deepseek-chat')
    const planner = resolveIn(layout, 'planner')
    assert.deepEqual(planner.modelProblems, undefined)
    assert.equal(planner.modelNote, '模型类 planner 未配置，使用宿主默认')
})

test('a literal provider/model route is untouched by the class resolver', () => {
    const literal = builtinRole('developer')
    assert.equal(literal.model, undefined)
    const withLiteral: Role = { ...literal, provider: 'acme', model: 'fast-model' }
    const { layout } = workspace()
    assert.equal(resolveRoleModelClass(withLiteral, layout), withLiteral)
    const inline: Role = { ...literal, model: '@nope' }
    const resolved = resolveRoleModelClass(inline, layout)
    assert.match(resolved.modelProblems?.[0] ?? '', /未知的模型类|没有这个类/)
})

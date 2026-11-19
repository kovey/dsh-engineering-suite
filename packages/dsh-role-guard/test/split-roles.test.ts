/**
 * The split workflow's two roles and the `model: @class` indirection
 * (AC-002 / AC-007 of the split mission).
 *
 * What is pinned here:
 *  - `planner` is READ-ONLY and `worker` carries only the seven execution tools
 *    (no gate/delivery tool, no `team_delegate`), so "worker cannot write the
 *    main mission's gates or receipt" is a tool-surface fact, not a promise;
 *  - `model: @planner` / `@worker` resolve through the project's `models.json`;
 *  - an unresolvable reference is NAMED and refuses dispatch — it never falls
 *    back to the host default model (that silent downgrade is the defect the
 *    class reference exists to prevent).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout, type Layout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { builtinRolesDir } from '../dist/loader.js'
import { modelClassRefusal, resolveModelClassRoles, resolveRoleModelClass } from '../dist/model-class.js'
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

test('a missing class is NAMED and refuses dispatch — never the host default', async () => {
    const { cwd, layout } = workspace()
    const planner = resolveIn(layout, 'planner')
    assert.deepEqual(planner.modelProblems?.length, 1)
    assert.match(planner.modelProblems?.[0] ?? '', /@planner/)
    assert.match(planner.modelProblems?.[0] ?? '', /planner 段没有配置 model/)
    const refusal = modelClassRefusal(planner)
    assert.ok(refusal !== undefined)
    assert.match(refusal, /fail closed/)
    assert.match(refusal, /不会回退宿主默认/)

    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'planner', task: '拆任务' })
    assert.equal(run.isError, true, 'dispatch must be refused, not silently downgraded')
    assert.match(String(run.content), /planner/)
    assert.match(String(run.content), /没有配置 model/)
    fake.dispose()
})

test('a workspace that configures only one class resolves that one and names the other', () => {
    const { layout } = workspace({ worker: { model: 'deepseek/deepseek-chat' } })
    assert.equal(resolveIn(layout, 'worker').model, 'deepseek-chat')
    const planner = resolveIn(layout, 'planner')
    assert.match(planner.modelProblems?.[0] ?? '', /缺失的类：planner/)
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

/**
 * The delegation seam against harness 0.2.2-rc.1: `startActivation` + Agent
 * Presets, the legacy fallback an old host still uses, and the premises that
 * are refused instead of silently degraded.
 *
 * The load-bearing difference from `role-guard.test.ts`: these hosts are built
 * with the modern subagent surface (`withActivation`) and the preset registry
 * (`withAgentPresets`), because on 0.2.2-rc.1 the role's persona and tool
 * whitelist travel as a composition — `SubagentStartRequest` has neither field.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost, type FakeHostOptions } from 'dsh-eng-core/testing'
import { apply as applyRoleGuard } from '../dist/index.js'
import { apply as applyScope, name as scopeName, PERSONA_SECTION } from '../dist/scope.js'

const HOST_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image', 'subagent', 'skill']

function stubTools(fake: FakeHost): void {
    for (const toolName of HOST_TOOLS) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
}

/** Assemble the plugin into a fake host built from `options`. */
function assembly(options: FakeHostOptions, config: Record<string, unknown> = {}, prepare?: (fake: FakeHost) => void): FakeHost {
    const fake = createFakeHost(options)
    stubTools(fake)
    prepare?.(fake)
    applyRoleGuard(fake.ctx as never, { logFile: path.join(fake.cwd, 'role-guard.log'), ...config })
    return fake
}

/** A 0.2.2-rc.1 host: the activation seam plus the preset registry. */
function modernHost(cwd: string, extra: FakeHostOptions = {}, config: Record<string, unknown> = {}, prepare?: (fake: FakeHost) => void): FakeHost {
    return assembly({ cwd, withSubagents: true, withActivation: true, withAgentPresets: true, ...extra }, config, prepare)
}

/** An old host: only the legacy two-arg `start(provider, request)`. */
function legacyHost(cwd: string, config: Record<string, unknown> = {}): FakeHost {
    return assembly({ cwd, withSubagents: true }, config)
}

/** The one activation spec a test expects (with its request). */
function activationSpec(fake: FakeHost): { provider: string; label: string; delivery: string; request: Record<string, unknown> } {
    const spec = fake.activationSpecs[0] as { provider: string; label: string; delivery: string; request: Record<string, unknown> } | undefined
    assert.ok(spec !== undefined, 'expected one startActivation call')
    return spec
}

/** The single plugin row of a registered preset. */
function presetRow(fake: FakeHost, presetId: string): { id: string; name: string; config: Record<string, unknown> } {
    const definition = fake.presetDefinitions.get(presetId)
    assert.ok(definition !== undefined, `expected preset ${presetId} to be registered, got ${[...fake.presetDefinitions.keys()].join(', ')}`)
    assert.equal(definition.plugins.length, 1)
    return definition.plugins[0] as { id: string; name: string; config: Record<string, unknown> }
}

// --- the two dispatch paths -------------------------------------------------

test('a modern host dispatches through startActivation and mounts the role preset (TC-801)', async () => {
    const fake = modernHost(tempWorkspace('role-guard-act-'))
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查 src/server.ts 是否满足 AC-001' })
    assert.equal(run.isError, false)

    // The modern seam was used, and ONLY it: the legacy start must not run.
    assert.equal(fake.activationSpecs.length, 1)
    assert.equal(fake.subagentStarts.length, 0, 'the legacy seam must not be used when startActivation exists')
    const spec = activationSpec(fake)
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'caller', 'a delegation returns its product to the caller, not as a second parent turn')
    assert.match(spec.label, /审查者/)
    assert.equal(spec.request['agentPreset'], 'role:reviewer')
    // 0.2.2-rc.1 has no persona/toolFilter in the start request: they travel
    // through the preset, and sending them would be a lie about enforcement.
    assert.equal('toolFilter' in spec.request, false)
    assert.equal('persona' in spec.request, false)
    const prompt = (spec.request['prompt'] as { text: string }[])[0]?.text ?? ''
    assert.match(prompt, /# 角色：审查者/)

    // The identity/whitelist the HOST will enforce in the child scope.
    const row = presetRow(fake, 'role:reviewer')
    assert.equal(row.id, 'role-guard-scope')
    assert.equal(row.name, 'dsh-role-guard/scope')
    assert.deepEqual(row.config['allow'], ['read', 'glob', 'grep'])
    assert.match(String(row.config['persona']), /审查者/)
    const definition = fake.presetDefinitions.get('role:reviewer')
    assert.equal(definition?.name, '审查者')
    assert.ok((definition?.description ?? '').length <= 120, 'a roster description stays within 120 characters')

    // The activation's identity is what the tool reports and what it binds.
    const text = runText(run)
    assert.match(text, /child session: activation-1/)
    assert.match(text, /stop reason: 完成/)
    assert.match(text, /派发: startActivation \+ Agent Preset（role:reviewer/)
    assert.match(text, /child output/)
    assert.equal(fake.activationDisposals(), 1, 'the published activation is disposed')
    const binding = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'state', 'roles', 'activation-1.json'), 'utf8')) as Record<string, unknown>
    assert.equal(binding['roleId'], 'reviewer')
})

test("the child's id and output come from the activation, not from a guess (TC-801)", async () => {
    const fake = modernHost(tempWorkspace('role-guard-act-output-'), {
        activationChildId: 'child-9',
        activationResult: { stopReason: 'completed', output: [{ type: 'text', text: '逐条结论：AC-001 满足。' }] },
    })
    const run = await fake.runTool('team_delegate', { role: 'qa', task: '跑验证' })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /child session: child-9/)
    assert.match(text, /逐条结论：AC-001 满足。/)
    // The binding is keyed by the activation's child id, which the skill gate
    // resolves the role through — not by some id the plugin invented.
    const binding = JSON.parse(fs.readFileSync(path.join(fake.cwd, '.dsh', 'state', 'roles', 'child-9.json'), 'utf8')) as Record<string, unknown>
    assert.equal(binding['roleId'], 'qa')
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'state', 'roles', 'run-1.json')), false)
})

test('an old host still delegates through the legacy two-arg start, and says so (TC-802, TC-804)', async () => {
    const fake = legacyHost(tempWorkspace('role-guard-legacy-'))
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, false)
    assert.equal(fake.activationSpecs.length, 0, 'no activation exists on an old host')
    assert.equal(fake.subagentStarts.length, 1)
    const start = fake.subagentStarts[0] as { provider: string; request: Record<string, unknown> }
    assert.equal(start.provider, 'spawn')
    assert.deepEqual(start.request['toolFilter'], { allow: ['read', 'glob', 'grep'] })
    assert.match(String(start.request['persona']), /审查者/)

    const text = runText(run)
    assert.match(text, /派发: legacy start\(provider, request\)/)
    assert.match(text, /旧宿主/)
    // The honest half: the whitelist rides in the request, NOT in a preset.
    assert.match(text, /persona\/toolFilter 随启动请求传递/)
    assert.doesNotMatch(text, /Agent Preset/, 'an old host must never be described as preset-enforced')
    assert.match(text, /child output/)
})

// --- the four missing premises ---------------------------------------------

test('a host with neither dispatch API is refused by name, never by a TypeError (TC-805)', async () => {
    const fake = assembly({ cwd: tempWorkspace('role-guard-nodispatch-'), services: { subagents: { list: () => ['spawn'] } } })
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, true)
    const text = String(run.content)
    assert.match(text, /startActivation/)
    assert.match(text, /start\(provider, request\)/)
    assert.match(text, /@deepseek-ai\/dsh-subagent/)
    assert.match(text, /@deepseek-ai\/dsh-subagent-spawn-in-process/)
    assert.match(text, /@deepseek-ai\/dsh-agent-preset-registry/)
    assert.match(text, /fail closed/)
    assert.doesNotMatch(text, /is not a function/)
    assert.doesNotMatch(text, /TypeError/)
    assert.equal(fake.activationSpecs.length, 0)
})

test('startActivation without an agentPresets registry is refused, naming the repair script (TC-806)', async () => {
    const fake = assembly({ cwd: tempWorkspace('role-guard-nopresets-'), withSubagents: true, withActivation: true })
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, true)
    const text = String(run.content)
    assert.match(text, /agentPresets/)
    assert.match(text, /@deepseek-ai\/dsh-agent-preset-registry/)
    assert.match(text, /repair-profile-closure\.sh --apply/)
    assert.match(text, /拒绝派发/)
    assert.match(text, /persona 与工具白名单只能通过 Agent Preset/)
    assert.equal(fake.activationSpecs.length, 0, 'nothing is started without a way to carry the role')
})

test('an unknown provider is refused with the registered providers listed (TC-807)', async () => {
    const fake = modernHost(tempWorkspace('role-guard-provider-'), { providers: ['spawn', 'fork-in-process'] }, { provider: 'nope' })
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, true)
    const text = String(run.content)
    assert.match(text, /provider "nope" 没有注册/)
    assert.match(text, /已注册的 provider（service\.list\(\)）：spawn, fork-in-process/)
    assert.match(text, /spawn/)
    assert.equal(fake.activationSpecs.length, 0)
})

test('a preset id registered by somebody else is refused, never trusted (AC-002)', async () => {
    const fake = modernHost(tempWorkspace('role-guard-foreign-'), {}, {}, (host) => {
        const service = (host.ctx as { get: (name: string) => unknown }).get('agentPresets') as { register: (definition: unknown) => unknown }
        service.register({ id: 'role:reviewer', plugins: [] })
    })
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, true)
    const text = String(run.content)
    assert.match(text, /role:reviewer/)
    assert.match(text, /其他插件注册/)
    assert.equal(fake.activationSpecs.length, 0)
})

test('a rejected preset registration refuses the delegation instead of claiming success (AC-002)', async () => {
    const fake = modernHost(tempWorkspace('role-guard-register-fail-'), {}, {}, (host) => {
        const service = (host.ctx as { get: (name: string) => unknown }).get('agentPresets') as { register: (definition: unknown) => unknown }
        service.register = () => Promise.reject(new Error('激活失败：订阅不到 tools 服务'))
    })
    // The rejection settles one microtask turn after apply(); a real host has
    // long finished assembling before any tool call arrives.
    await new Promise((resolve) => setImmediate(resolve))
    const run = await fake.runTool('team_delegate', { role: 'reviewer', task: '审查实现' })
    assert.equal(run.isError, true)
    const text = String(run.content)
    assert.match(text, /注册失败/)
    assert.match(text, /激活失败：订阅不到 tools 服务/)
    assert.equal(fake.activationSpecs.length, 0)
})

test('a tool list edited after registration is refused instead of enforced stale (AC-002)', async () => {
    const cwd = tempWorkspace('role-guard-stale-')
    const rolesDir = path.join(cwd, '.dsh', 'roles')
    fs.mkdirSync(rolesDir, { recursive: true })
    const writeRole = (tools: readonly string[]): void => {
        fs.writeFileSync(
            path.join(rolesDir, 'auditor.md'),
            ['---', 'id: auditor', 'name: 审计员', 'mode: read', 'tools:', ...tools.map((tool) => `  - ${tool}`), '---', '只读审计。', ''].join('\n'),
        )
    }
    writeRole(['read'])
    const fake = modernHost(cwd)
    const first = await fake.runTool('team_delegate', { role: 'auditor', task: '审计' })
    assert.equal(first.isError, false)
    assert.equal(fake.activationSpecs.length, 1)
    assert.deepEqual(presetRow(fake, 'role:auditor').config['allow'], ['read'])

    // The preset is fixed at registration while role files hot-reload: a WIDER
    // whitelist must not be silently enforced with the old (narrower) filter.
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeRole(['read', 'grep'])
    const second = await fake.runTool('team_delegate', { role: 'auditor', task: '审计' })
    assert.equal(second.isError, true)
    assert.match(String(second.content), /注册时的工具过滤与当前角色文件不一致/)
    assert.equal(fake.activationSpecs.length, 1, 'the stale preset is never used for a second child')
})

// --- the scope plugin (what the preset row mounts in the child) -------------

test('the scope plugin enforces the filter and installs the persona in the child scope (TC-803)', () => {
    assert.equal(scopeName, 'dsh-role-guard/scope')
    const filters: unknown[] = []
    const sections: { name: string; order: number; text: string | (() => string) }[] = []
    const effects: (() => void)[] = []
    let released = 0
    const ctx = {
        tools: {
            restrict: (filter: unknown) => {
                filters.push(filter)
                return () => {
                    released += 1
                }
            },
        },
        systemPrompt: {
            section: (section: { name: string; order: number; text: string | (() => string) }) => {
                sections.push(section)
                return () => {
                    released += 1
                }
            },
        },
        effect: (execute: () => (() => void) | void) => {
            const disposer = execute()
            if (typeof disposer === 'function') effects.push(disposer)
        },
    }

    applyScope(ctx, { persona: '你是审查者，只读。', allow: ['read', 'grep'] })
    assert.deepEqual(filters, [{ allow: ['read', 'grep'] }], 'the host-enforced restriction is applied exactly once')
    assert.equal(sections.length, 1)
    assert.equal(sections[0]?.name, PERSONA_SECTION)
    assert.equal(sections[0]?.order, 0)
    assert.equal(typeof sections[0]?.text, 'function')
    assert.equal((sections[0]?.text as () => string)(), '你是审查者，只读。')

    // Teardown releases both registrations (the scope's effect owns them).
    for (const dispose of effects) dispose()
    assert.equal(released, 2)
})

test('the scope plugin never throws on an absent capability, and never half-enforces silently (TC-803)', () => {
    // Nothing to enforce and nothing to crash: a bare composition is legal.
    assert.doesNotThrow(() => applyScope({}, { persona: '只读角色', allow: ['read'] }))
    assert.doesNotThrow(() => applyScope({ tools: {}, systemPrompt: {} }, { persona: '只读角色', allow: ['read'] }))
    assert.doesNotThrow(() => applyScope({}, 'not even an object'))

    // No filter, no section when nothing is declared.
    const filters: unknown[] = []
    const sections: unknown[] = []
    applyScope(
        { tools: { restrict: (filter: unknown) => (filters.push(filter), () => undefined) }, systemPrompt: { section: (s: unknown) => (sections.push(s), () => undefined) } },
        { persona: '   ', deny: [] },
    )
    assert.deepEqual(filters, [])
    assert.deepEqual(sections, [])

    // A declared-but-EMPTY whitelist is not "no whitelist": the child must not
    // mount at all rather than run with everything the role excluded.
    assert.throws(() => applyScope({ tools: { restrict: () => () => undefined } }, { allow: [] }), /empty tool whitelist/)

    // A deny-only role leans on the deny half (read-only roles do exactly this).
    const denyFilters: unknown[] = []
    applyScope({ tools: { restrict: (filter: unknown) => (denyFilters.push(filter), () => undefined) } }, { deny: ['write', 'edit'] })
    assert.deepEqual(denyFilters, [{ deny: ['write', 'edit'] }])

    // A filter the host REJECTS must fail the child's start: swallowing it would
    // hand the child every tool the role excluded.
    assert.throws(
        () =>
            applyScope(
                {
                    tools: {
                        restrict: () => {
                            throw new Error('unknown tool "nope"')
                        },
                    },
                },
                { allow: ['nope'] },
            ),
        /unknown tool "nope"/,
    )
})

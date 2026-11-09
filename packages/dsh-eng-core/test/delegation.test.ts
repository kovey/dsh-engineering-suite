/**
 * The delegation seam (`dsh-eng-core/delegation`): one implementation for the
 * three plugins that start child agents.
 *
 * What is pinned here is the DECISION, not the wording of one plugin's report:
 * which path a given host gets, the five premises that are refused before
 * anything starts, that a preset somebody else registered is never trusted, and
 * that both start paths normalise to one `{ id, result, dispose }` shape.
 *
 * The per-plugin behaviour (role persona/whitelist, the orchestrator's
 * anti-recursion guard, the reviewer's confinement) is pinned beside each
 * plugin: `dsh-role-guard/test/delegation-preset.test.ts`,
 * `dsh-orchestrator/test/orchestrator.test.ts`,
 * `dsh-impact-gate/test/impact-gate.test.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DELEGATION_PRESET_REASONS,
    createDelegationPresets,
    delegationPresetDefinition,
    dispatchLine,
    planDelegation,
    registerDelegationPreset,
    startDelegation,
    type DelegationActivationLike,
    type DelegationChildResult,
    type DelegationOwner,
    type DelegationPresetDefinition,
    type DelegationPresetInput,
    type DelegationPresets,
    type DelegationServices,
} from '../dist/delegation.js'
import { name as scopePluginName } from '../dist/scope.js'

const OWNER: DelegationOwner = { plugin: 'dsh-test-plugin', subject: '测试子代理' }

/** A preset input with a fixed id scheme. */
function preset(overrides: Partial<DelegationPresetInput> = {}): DelegationPresetInput {
    return {
        id: 'test:one',
        name: '测试 preset',
        description: '测试用的 preset',
        order: 500,
        rowId: 'test-scope',
        persona: '你是测试子代理。',
        filter: { allow: ['read', 'grep'] },
        ...overrides,
    }
}

/** A fake `agentPresets` service that records what was registered. */
function fakePresets(options: { sync?: boolean; reject?: string } = {}): {
    service: { register: (definition: unknown) => unknown; has: (id: string) => boolean }
    definitions: Map<string, DelegationPresetDefinition>
    registrations: unknown[]
} {
    const definitions = new Map<string, DelegationPresetDefinition>()
    const registrations: unknown[] = []
    const service = {
        register(definition: unknown) {
            registrations.push(definition)
            if (options.reject !== undefined) return Promise.reject(new Error(options.reject))
            const def = definition as DelegationPresetDefinition
            if (definitions.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
            definitions.set(def.id, def)
            return Promise.resolve(async () => definitions.delete(def.id))
        },
        has: (id: string) => definitions.has(id),
    }
    return { service, definitions, registrations }
}

/** A registry owned by "this plugin". */
function registry(service: ReturnType<typeof fakePresets>['service'] | undefined, problems: string[] = []): DelegationPresets {
    return createDelegationPresets({
        presets: () => service,
        logger: { warn: (message: string) => problems.push(message) },
    })
}

/** The child result every fake start resolves to. */
function result(text = 'child output'): DelegationChildResult {
    return { stopReason: 'completed', output: [{ type: 'text', text }] }
}

/** A modern host: `startActivation` only (the legacy seam is deleted there). */
function modernServices(options: { providers?: string[]; capability?: boolean | undefined; childId?: string } = {}): {
    services: DelegationServices
    specs: unknown[]
    disposed: () => number
} {
    const specs: unknown[] = []
    let disposals = 0
    const providers = options.providers ?? ['spawn']
    const services: DelegationServices = {
        startActivation: async (spec) => {
            specs.push(spec)
            const activation: DelegationActivationLike = {
                childId: options.childId ?? 'activation-1',
                result: Promise.resolve(result()),
                dispose: async () => {
                    disposals += 1
                },
            }
            return activation
        },
        list: () => [...providers],
        getProvider: (name) =>
            providers.includes(name) ? { name, capabilities: { agentPreset: options.capability ?? true } } : undefined,
    }
    return { services, specs, disposed: () => disposals }
}

/** An old host: the legacy two-arg `start` only, with the fields 0.2.2-rc.1 deleted. */
function legacyServices(options: { withDispose?: boolean } = {}): {
    services: DelegationServices
    calls: { provider: string; request: Record<string, unknown> }[]
} {
    const calls: { provider: string; request: Record<string, unknown> }[] = []
    const services: DelegationServices = {
        start: async (provider, request) => {
            calls.push({ provider, request: request as unknown as Record<string, unknown> })
            return {
                id: 'run-1',
                result: Promise.resolve(result()),
                ...(options.withDispose === false ? {} : { dispose: async () => undefined }),
            } as never
        },
        list: () => ['spawn'],
    }
    return { services, calls }
}

// --- the decision -----------------------------------------------------------

test('a modern host is planned as an activation with the registered preset (TC-902)', async () => {
    const service = fakePresets()
    const presets = registry(service.service)
    const host = modernServices()
    const plan = await planDelegation({ owner: OWNER, provider: 'spawn', subagents: host.services, presets, preset: preset() })
    assert.deepEqual(plan, { kind: 'activation', presetId: 'test:one' })
    // The preset is exactly one row, and the row names the plugin eng-core exports.
    const definition = service.definitions.get('test:one')
    assert.ok(definition !== undefined)
    assert.equal(definition.plugins.length, 1)
    assert.equal(definition.plugins[0]?.name, 'dsh-eng-core/scope')
    assert.equal(definition.plugins[0]?.name, scopePluginName)
    assert.deepEqual(definition.plugins[0]?.config, { persona: '你是测试子代理。', allow: ['read', 'grep'] })
})

test('an old host is planned as the legacy path, and needs no preset at all (TC-904)', async () => {
    const host = legacyServices()
    const plan = await planDelegation({ owner: OWNER, provider: 'spawn', subagents: host.services, preset: preset() })
    assert.deepEqual(plan, { kind: 'legacy' })
})

test('no dispatch API at all is refused by name, never by a TypeError (TC-903)', async () => {
    const plan = await planDelegation({ owner: OWNER, provider: 'spawn', subagents: { list: () => ['spawn'] }, preset: preset() })
    assert.equal(plan.kind, 'refused')
    const reason = plan.kind === 'refused' ? plan.reason : ''
    assert.match(reason, /startActivation/)
    assert.match(reason, /start\(provider, request\)/)
    assert.match(reason, /fail closed/)
    assert.match(reason, /@deepseek-ai\/dsh-subagent/)
    assert.match(reason, /@deepseek-ai\/dsh-agent-preset-registry/)
    assert.match(reason, /repair-profile-closure\.sh --apply/)
    assert.doesNotMatch(reason, /TypeError/)
    assert.doesNotMatch(reason, /is not a function/)
})

test('startActivation without an agentPresets registry is refused, naming the repair (TC-903)', async () => {
    const host = modernServices()
    // Both shapes of "no registry": a hand-wired deps with none, and a host
    // whose service getter returns nothing.
    for (const presets of [undefined, registry(undefined)]) {
        const plan = await planDelegation({
            owner: OWNER,
            provider: 'spawn',
            subagents: host.services,
            ...(presets === undefined ? {} : { presets }),
            preset: preset(),
        })
        assert.equal(plan.kind, 'refused')
        const reason = plan.kind === 'refused' ? plan.reason : ''
        assert.match(reason, /agentPresets/)
        assert.match(reason, /persona 与工具白名单只能通过 Agent Preset/)
        assert.match(reason, /repair-profile-closure\.sh --apply/)
        assert.match(reason, /拒绝派发/)
    }
    assert.equal(host.specs.length, 0, 'nothing starts without a way to carry the restriction')
})

test('an unknown provider is refused with the registered providers listed (TC-903)', async () => {
    const host = modernServices({ providers: ['spawn', 'fork-in-process'] })
    const plan = await planDelegation({
        owner: OWNER,
        provider: 'nope',
        subagents: host.services,
        presets: registry(fakePresets().service),
        preset: preset(),
    })
    assert.equal(plan.kind, 'refused')
    const reason = plan.kind === 'refused' ? plan.reason : ''
    assert.match(reason, /provider "nope" 没有注册/)
    assert.match(reason, /已注册的 provider（service\.list\(\)）：spawn, fork-in-process/)
    assert.equal(host.specs.length, 0, 'no silent fallback to the first registered provider')
})

test('a provider without the agentPreset capability is refused, not silently widened (TC-903)', async () => {
    const host = modernServices({ capability: false })
    const plan = await planDelegation({
        owner: OWNER,
        provider: 'spawn',
        subagents: host.services,
        presets: registry(fakePresets().service),
        preset: preset(),
    })
    assert.equal(plan.kind, 'refused')
    const reason = plan.kind === 'refused' ? plan.reason : ''
    assert.match(reason, /capabilities\.agentPreset = false/)
    assert.match(reason, /无法由宿主强制/)
    assert.equal(host.specs.length, 0)
})

test('a partial or hostile service never turns into a thrown TypeError (TC-903)', async () => {
    // `list()` throwing is "cannot enumerate", not "this provider is missing";
    // a `getProvider` that throws is "unknown shape", not a capability refusal.
    const host: DelegationServices = {
        startActivation: async () => ({ childId: 'a', result: Promise.resolve(result()), dispose: async () => undefined }),
        list: () => {
            throw new Error('registry exploded')
        },
        getProvider: () => {
            throw new Error('descriptor exploded')
        },
    }
    const plan = await planDelegation({
        owner: OWNER,
        provider: 'spawn',
        subagents: host,
        presets: registry(fakePresets().service),
        preset: preset(),
    })
    assert.equal(plan.kind, 'activation')
})

// --- the preset registry ----------------------------------------------------

test('a preset id somebody else registered is refused, never trusted (TC-903)', async () => {
    const foreign = fakePresets()
    foreign.service.register({ id: 'test:one', plugins: [] })
    const problems: string[] = []
    const presets = registry(foreign.service, problems)
    const status = await registerDelegationPreset(presets, preset())
    assert.equal(status.ok, false)
    assert.equal(status.reason, 'foreign')
    assert.match(String(status.detail), /其他插件注册/)
    assert.deepEqual(presets.registeredIds(), [], 'a foreign id is never adopted as ours')
    assert.equal(problems.length, 1, 'the plugin log carries it too')
})

test('a duplicate-id rejection (a registry without `has`) is foreign, not failed', async () => {
    const service = fakePresets()
    // `has` absent: the only way to learn about a taken id is the rejection.
    const nameless = { register: service.service.register } as { register: (definition: unknown) => unknown }
    const presets = registry(nameless as never)
    await registerDelegationPreset(presets, preset())
    const second = await registerDelegationPreset(presets, preset({ id: 'test:one' }))
    // The first registration is ours, so the second is simply idempotent…
    assert.equal(second.ok, true)
    // …and a *different* preset registered by somebody else still collides.
    const other = registry(nameless as never)
    const status = await registerDelegationPreset(other, preset({ id: 'test:one' }))
    assert.equal(status.ok, false)
    assert.equal(status.reason, 'foreign')
    assert.match(String(status.detail), /Duplicate agent preset/)
})

test('a rejected registration surfaces as failed and is never claimed', async () => {
    const service = fakePresets({ reject: '激活失败：订阅不到 tools 服务' })
    const problems: string[] = []
    const presets = registry(service.service, problems)
    const status = await registerDelegationPreset(presets, preset())
    assert.equal(status.ok, false)
    assert.equal(status.reason, 'failed')
    assert.match(String(status.detail), /激活失败：订阅不到 tools 服务/)
    assert.deepEqual(presets.registeredIds(), [])
    assert.equal(problems.length, 1)
    // A failed id stays failed: retrying it on every delegation would hide the
    // original error behind a storm of identical rejections.
    const again = await registerDelegationPreset(presets, preset())
    assert.equal(again.reason, 'failed')
    assert.equal(service.registrations.length, 1)
})

test('a filter changed after registration is a stale refusal, not a silent re-register', async () => {
    const service = fakePresets()
    const presets = registry(service.service)
    assert.equal((await registerDelegationPreset(presets, preset())).ok, true)
    const stale = await registerDelegationPreset(presets, preset({ filter: { allow: ['read', 'grep', 'bash'] } }))
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, 'stale')
    assert.equal(DELEGATION_PRESET_REASONS.stale, '注册时的工具过滤与当前角色文件不一致（或策略在注册后被改动）')
    // The same filter (in another ORDER) is the same enforcement: idempotent.
    assert.equal((await registerDelegationPreset(presets, preset({ filter: { allow: ['grep', 'read'] } }))).ok, true)
    assert.equal(service.registrations.length, 1)
})

test('two concurrent registrations of one id register it once', async () => {
    // The assembly-time batch and the first delegation race: a duplicate id is
    // indistinguishable from "somebody else's", so the second call must JOIN
    // the first instead of registering again.
    const service = fakePresets()
    const presets = registry(service.service)
    const [first, second] = await Promise.all([
        registerDelegationPreset(presets, preset()),
        registerDelegationPreset(presets, preset()),
    ])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(service.registrations.length, 1)
})

// --- the definition ---------------------------------------------------------

test('the preset has exactly one row, a clamped description and no empty fields', () => {
    const long = 'x'.repeat(500)
    const definition = delegationPresetDefinition(preset({ description: long, persona: '   ', filter: undefined }))
    assert.equal(definition.plugins.length, 1)
    assert.equal(definition.description.length, 120)
    assert.match(definition.description, /…$/)
    // An empty persona is "no section", not an empty one; no filter is "no
    // restriction", not an empty allow-list (which the scope plugin refuses).
    assert.deepEqual(definition.plugins[0]?.config, {})
    assert.equal(definition.order, 500)
})

test('the registered order follows the roster position, not a hard-coded index', async () => {
    const service = fakePresets()
    const presets = registry(service.service)
    await registerDelegationPreset(presets, preset({ id: 'test:one', order: 500 }))
    await registerDelegationPreset(presets, preset({ id: 'test:two', order: 500 }))
    assert.equal(service.definitions.get('test:one')?.order, 500)
    assert.equal(service.definitions.get('test:two')?.order, 501)
})

test('clear() releases every registration this plugin owns', async () => {
    const service = fakePresets()
    const presets = registry(service.service)
    await registerDelegationPreset(presets, preset())
    assert.equal(service.definitions.size, 1)
    presets.clear()
    assert.deepEqual(presets.registeredIds(), [])
    await Promise.resolve()
    assert.equal(service.definitions.size, 0, 'the host registration is released, not leaked')
})

// --- the start --------------------------------------------------------------

test('an activation start carries agentPreset and maxDepth, and never persona/toolFilter/signal', async () => {
    const host = modernServices()
    const run = await startDelegation(host.services, {
        owner: OWNER,
        provider: 'spawn',
        plan: { kind: 'activation', presetId: 'test:one' },
        label: 'label',
        prompt: 'do the thing',
        parent: { id: 'agent-1' },
        signal: AbortSignal.abort(),
        maxDepth: 1,
        legacy: { persona: 'ignored here', filter: { allow: ['read'] } },
    })
    const spec = host.specs[0] as { request: Record<string, unknown>; signal: AbortSignal; delivery: string; provider: string; label: string }
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.label, 'label')
    assert.equal(spec.delivery, 'caller', 'the product returns to the caller, not as a second parent turn')
    assert.equal(spec.request['agentPreset'], 'test:one')
    assert.equal(spec.request['maxDepth'], 1)
    assert.equal(spec.request['persona'], undefined)
    assert.equal(spec.request['toolFilter'], undefined)
    assert.equal(spec.request['signal'], undefined, 'the signal rides on the activation spec')
    assert.equal(run.id, 'activation-1')
    assert.equal((await run.result).stopReason, 'completed')
    await run.dispose()
    assert.equal(host.disposed(), 1)
})

test('a legacy start carries persona/toolFilter in the request and still normalises', async () => {
    const host = legacyServices({ withDispose: false })
    const run = await startDelegation(host.services, {
        owner: OWNER,
        provider: 'spawn',
        plan: { kind: 'legacy' },
        label: 'label',
        prompt: 'do the thing',
        parent: { id: 'agent-1' },
        signal: AbortSignal.abort(),
        legacy: { persona: '你是测试子代理。', filter: { allow: ['read'], deny: ['orchestrate'] } },
    })
    const request = host.calls[0]?.request ?? {}
    assert.deepEqual(request['toolFilter'], { allow: ['read'], deny: ['orchestrate'] })
    assert.equal(request['persona'], '你是测试子代理。')
    assert.equal(request['label'], 'label')
    assert.ok(request['signal'] instanceof AbortSignal, 'an old host takes the signal inside the request')
    assert.equal(request['agentPreset'], undefined, 'an old host has no preset to select')
    assert.equal(run.id, 'run-1')
    // A host that returned no disposer still yields the one normalised shape.
    await run.dispose()
})

test('a start failure is a named explanation, never a raw TypeError', async () => {
    const host: DelegationServices = {
        startActivation: async () => ({ childId: '', result: Promise.resolve(result()), dispose: async () => undefined }),
    }
    await assert.rejects(
        startDelegation(host, {
            owner: OWNER,
            provider: 'spawn',
            plan: { kind: 'activation', presetId: 'test:one' },
            label: 'label',
            prompt: 'p',
            parent: { id: 'a' },
            signal: AbortSignal.abort(),
            detail: '白名单：read',
        }),
        (error: Error) => {
            assert.match(error.message, /子代理启动失败（provider spawn，startActivation \+ preset test:one）/)
            assert.match(error.message, /宿主返回的 activation 没有 childId/)
            assert.match(error.message, /白名单：read/)
            assert.match(error.message, /repair-profile-closure\.sh --apply/)
            assert.doesNotMatch(error.message, /TypeError/)
            return true
        },
    )
})

test('a legacy handle without an id is refused instead of bound under undefined', async () => {
    const host: DelegationServices = { start: async () => ({ result: Promise.resolve(result()) }) as never }
    await assert.rejects(
        startDelegation(host, {
            owner: OWNER,
            provider: 'spawn',
            plan: { kind: 'legacy' },
            label: 'label',
            prompt: 'p',
            parent: { id: 'a' },
            signal: AbortSignal.abort(),
        }),
        /不可用的运行句柄（没有 id）/,
    )
})

// --- the witness line -------------------------------------------------------

test('the dispatch line names the path, the preset and the guarantee', () => {
    assert.equal(
        dispatchLine({ kind: 'activation', presetId: 'test:one' }),
        '派发: startActivation + Agent Preset（test:one；persona 与工具限制在子作用域由宿主 restrict 强制）',
    )
    assert.match(dispatchLine({ kind: 'activation', presetId: 'test:one' }, 'orchestrate 已剔除'), /；orchestrate 已剔除）$/)
    const legacy = dispatchLine({ kind: 'legacy' })
    assert.match(legacy, /派发: legacy start\(provider, request\)/)
    assert.match(legacy, /旧宿主/)
    assert.match(legacy, /persona\/toolFilter 随启动请求传递/)
    assert.doesNotMatch(legacy, /Agent Preset/, 'an old host must never be described as preset-enforced')
    assert.equal(dispatchLine({ kind: 'refused', reason: 'no' }), '派发: 已拒绝')
})

test('the service is called BOUND: a method that needs `this` must not be detached (regression)', async () => {
    // The bug this pins, found by the first real `team_delegate` after a restart:
    // `const f = service.startActivation; f(spec)` loses the receiver, and the
    // host's own methods (`expectProvider`, the provider registry) then throw
    // "Cannot read properties of undefined (reading 'expectProvider')".
    // Every fake before this one was a plain function object, so nothing noticed.
    class RealisticService {
        readonly #providers = new Set(['spawn'])
        readonly calls: string[] = []
        /** Private helper, like the host's own `expectProvider`. */
        #expect(name: string): void {
            if (!this.#providers.has(name)) throw new Error(`unknown provider ${name}`)
        }
        async startActivation(spec: { provider: string }): Promise<{ childId: string; result: Promise<{ stopReason: string; output: unknown[] }>; dispose: () => Promise<void> }> {
            this.#expect(spec.provider)
            this.calls.push(spec.provider)
            return { childId: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => undefined }
        }
    }
    const service = new RealisticService()
    const run = await startDelegation(service as never, {
        owner: { plugin: 'test', subject: 'qa' },
        provider: 'spawn',
        plan: { kind: 'activation', presetId: 'role:qa' },
        label: 'qa · bound call',
        prompt: 'hi',
        parent: {} as never,
        signal: new AbortController().signal,
    })
    assert.equal(run.id, 'child-1')
    assert.deepEqual(service.calls, ['spawn'], 'the method ran with its receiver')
})

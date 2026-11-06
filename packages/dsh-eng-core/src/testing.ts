/**
 * A fake host for unit tests.
 *
 * Every plugin in the suite is assembled with `apply(ctx, config)`, so tests
 * need a context that behaves like the harness for exactly the extension
 * points the suite uses: `tools.register` / `tools.guard` / `tools.get`,
 * `on(event, listener)`, `effect`, `systemPrompt.section`, `approval.request`,
 * `subagents.start` / `subagents.startActivation`, `agentPresets.register`,
 * `subprocess.spawn` and `get(service)`.
 *
 * The fake is deliberately small and honest: it stores definitions, dispatches
 * emit-mode events, and runs waterfall listeners in registration order with a
 * caller-supplied base decision. It performs no schema validation — a test that
 * cares about argument shape should assert on what the tool received.
 *
 * The subagent surface is **opt-in per API**, because the two are a version
 * boundary rather than a detail: `withSubagents` gives the legacy
 * `start(provider, request)` seam (an old host), `withActivation` adds the
 * 0.2.2-rc.1 `startActivation(spec)` seam on top, and `withAgentPresets` adds
 * the `agentPresets` registry. A test can therefore assemble an old host and a
 * new one from the same fake instead of mocking the difference by hand.
 *
 * @module dsh-eng-core/testing
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RunOutcome, RunSpec, SubprocessLike } from './run.js'
import { runCommand } from './run.js'

/** One registered tool definition (structurally what `defineTool` returns). */
export interface FakeTool {
    name: string
    description: string
    parameters: Record<string, unknown>
    output?: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
    execute: (args: never, exec: unknown) => Promise<unknown>
    presentCall?: unknown
    presentResult?: unknown
}

/** A recorded tool run. */
export interface ToolRun {
    name: string
    args: unknown
    value: unknown
    isError: boolean
    content: unknown
}

/** Options for {@link createFakeHost}. */
export interface FakeHostOptions {
    /** Services visible to `ctx.get(name)` and `inject`. */
    services?: Record<string, unknown>
    /** Approval outcome returned by `ctx.approval.request` (default `'rejected'`). */
    approvalOutcome?: 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled'
    /** Whether an approval service exists at all (default true). */
    withApproval?: boolean
    /** Recorded subagent starts; supply to enable `ctx.subagents`. */
    withSubagents?: boolean
    /**
     * Add the 0.2.2-rc.1 `startActivation(spec)` seam to `ctx.subagents`
     * (requires {@link withSubagents}). Default false = an old host that only
     * has the legacy `start(provider, request)`.
     */
    withActivation?: boolean
    /** Add an `agentPresets` registry service (the Agent Preset seam). */
    withAgentPresets?: boolean
    /** Provider names `subagents.list()` reports (default `['spawn']`). */
    providers?: string[]
    /** Child session id `startActivation` returns (default `'activation-1'`). */
    activationChildId?: string
    /** The result `startActivation` returns, so a test seeds the child's output. */
    activationResult?: { stopReason?: string; diagnostic?: string; output?: { type: string; text?: string }[] }
    /** Enable `ctx.subprocess` backed by the real child-process runner. */
    withSubprocess?: boolean
    /** The agent every tool call runs as (defaults to a root agent in `cwd`). */
    agent?: FakeAgent
    /** Workspace root; a temp directory is created when omitted. */
    cwd?: string
}

/** Structural agent used by the fakes. */
export interface FakeAgent {
    id: string
    session: { id: string; header: { id: string; cwd: string; origin?: string } }
}

/** One preset definition registered through the fake `agentPresets` service. */
export interface FakePresetDefinition {
    id: string
    name?: string
    description?: string
    order?: number
    plugins: readonly unknown[]
}

/** The fake host surface. */
export interface FakeHost {
    ctx: unknown
    cwd: string
    agent: FakeAgent
    tools: Map<string, FakeTool>
    guards: ((exec: unknown) => string | undefined)[]
    listeners: Map<string, ((...args: never[]) => unknown)[]>
    effects: (() => void)[]
    sections: { name: string; order?: number; text?: (context?: unknown) => string }[]
    toolRuns: ToolRun[]
    subagentStarts: unknown[]
    /** Every `startActivation(spec)` the fake accepted (the 0.2.2-rc.1 seam). */
    activationSpecs: unknown[]
    /** How many activations the caller disposed. */
    activationDisposals: () => number
    /** Definitions handed to the fake `agentPresets.register` (id → definition). */
    presetDefinitions: Map<string, FakePresetDefinition>
    /** Every `register` call, in order (including a rejected duplicate). */
    presetRegistrations: unknown[]
    approvalRequests: unknown[]
    /**
     * Register a reactive dependency (the fake of cordis's `ctx.inject`).
     *
     * The callback runs when EVERY named service is available — immediately when
     * it already is (the fake is synchronous on purpose, so a test needs no
     * sleep), and again after the service is provided later or replaced. Its
     * returned disposer runs when the service is withdrawn or the host is
     * disposed. `off`-style plugins that must never touch a service simply do
     * not call it.
     */
    inject: (deps: string[] | Record<string, unknown>, callback: (ctx: { get: (name: string) => unknown }) => unknown) => () => void
    /** The dependency declarations currently subscribed (one name list per `inject`). */
    injections: () => string[][]
    /** Dispatch an emit-mode event to every listener. */
    emit: (event: string, payload: unknown) => void
    /** Run a waterfall event: listeners in order, then `base`. */
    waterfall: <T>(event: string, payload: unknown, base: () => Promise<T> | T) => Promise<T>    /** Invoke a registered tool. */
    runTool: (name: string, args?: unknown, exec?: Record<string, unknown>) => Promise<ToolRun>
    /** Invoke the first registered guard, if any. */
    guardReason: (exec: unknown) => string | undefined
    /** Text of a registered prompt section. */
    sectionText: (name: string) => string
    /** Run every registered effect disposer. */
    dispose: () => void
}

/** Create a temporary workspace directory. */
export function tempWorkspace(prefix = 'eng-test-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Create a fake agent in `cwd`. */
export function fakeAgent(cwd: string, id = 'agent-1', sessionId = 'session-1'): FakeAgent {
    return { id, session: { id: sessionId, header: { id: sessionId, cwd } } }
}

/**
 * Build a fake host context.
 * @param options - service and agent configuration.
 * @returns the fake host, including helpers to drive events and tools.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
    const cwd = options.cwd ?? tempWorkspace()
    const agent = options.agent ?? fakeAgent(cwd)
    const tools = new Map<string, FakeTool>()
    const guards: ((exec: unknown) => string | undefined)[] = []
    const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
    const effects: (() => void)[] = []
    const sections: FakeHost['sections'] = []
    const toolRuns: ToolRun[] = []
    const subagentStarts: unknown[] = []
    const activationSpecs: unknown[] = []
    const presetDefinitions = new Map<string, FakePresetDefinition>()
    const presetRegistrations: unknown[] = []
    let activationDisposals = 0
    const approvalRequests: unknown[] = []

    const on = (event: string, listener: (...args: never[]) => unknown): (() => void) => {
        const bucket = listeners.get(event) ?? []
        bucket.push(listener)
        listeners.set(event, bucket)
        return () => {
            const current = listeners.get(event) ?? []
            listeners.set(
                event,
                current.filter((entry) => entry !== listener),
            )
        }
    }

    const services: Record<string, unknown> = { ...options.services }
    if (options.withApproval !== false) {
        services['approval'] = {
            request: async (request: unknown) => {
                approvalRequests.push(request)
                return options.approvalOutcome ?? 'rejected'
            },
        }
    }
    if (options.withSubagents === true) {
        const providers = [...(options.providers ?? ['spawn'])]
        // The legacy seam: every fake host with a subagent service keeps it, so a
        // test can still model an old host (`withActivation` off).
        const service: Record<string, unknown> = {
            start: async (provider: string, request: unknown) => {
                subagentStarts.push({ provider, request })
                return {
                    id: 'run-1',
                    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'child output' }] }),
                }
            },
            list: () => [...providers],
            getProvider: (name: string) =>
                providers.includes(name)
                    ? { name, capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }
                    : undefined,
        }
        if (options.withActivation === true) {
            // The 0.2.2-rc.1 seam: `startActivation(spec)` → activation whose
            // `childId`/`result`/`dispose` the caller must honour. The seeded
            // result is what a test asserts flows back into the tool output.
            service['startActivation'] = async (spec: unknown) => {
                activationSpecs.push(spec)
                const seeded = options.activationResult ?? {}
                return {
                    childId: options.activationChildId ?? 'activation-1',
                    result: Promise.resolve({
                        stopReason: seeded.stopReason ?? 'completed',
                        output: seeded.output ?? [{ type: 'text', text: 'child output' }],
                        ...(seeded.diagnostic === undefined ? {} : { diagnostic: seeded.diagnostic }),
                    }),
                    dispose: async () => {
                        activationDisposals += 1
                    },
                }
            }
        }
        services['subagents'] = service
    }
    if (options.withAgentPresets === true) {
        services['agentPresets'] = {
            // Deliberately NOT async: a duplicate id fails synchronously, which
            // is the stricter of the two shapes a caller must survive (the real
            // `register` rejects instead — both paths are exercised by tests).
            register(definition: unknown) {
                presetRegistrations.push(definition)
                const id = definition !== null && typeof definition === 'object' ? (definition as { id?: unknown }).id : undefined
                if (typeof id !== 'string' || id === '') throw new Error('agent preset id must be a non-empty string')
                if (presetDefinitions.has(id)) throw new Error(`Duplicate agent preset: ${id}`)
                presetDefinitions.set(id, definition as FakePresetDefinition)
                // The real one resolves to a disposer that unregisters.
                return Promise.resolve(async () => {
                    presetDefinitions.delete(id)
                })
            },
            has: (id: string) => presetDefinitions.has(id),
        }
    }
    if (options.withSubprocess === true) {
        const service: SubprocessLike = {
            spawn(spec) {
                const controller = new AbortController()
                const collected = { stdout: '', stderr: '' }
                const done = (async () => {
                    const outcome = await runCommand(
                        {
                            argv: spec.argv,
                            cwd: spec.cwd,
                            ...(spec.signal === undefined ? {} : { signal: spec.signal }),
                        },
                        undefined,
                    )
                    collected.stdout = outcome.stdout
                    collected.stderr = outcome.stderr
                    return { exitCode: outcome.exitCode, signal: outcome.signal }
                })()
                return {
                    done,
                    collected: {
                        stdout: { readFrom: () => ({ text: collected.stdout }) },
                        stderr: { readFrom: () => ({ text: collected.stderr }) },
                    },
                    terminate: () => controller.abort(),
                }
            },
        }
        services['subprocess'] = service
    }

    // --- reactive dependencies (the fake of cordis's `ctx.inject`) ------------
    // A plugin that consumes an OPTIONAL service must not freeze the startup
    // observation: the real host runs the callback when the service is provided
    // later (and its disposer when the service goes away). The fake does the
    // same synchronously — a test needs no sleep to see the transition.
    interface FakeInjector {
        names: string[]
        callback: (ctx: { get: (name: string) => unknown }) => unknown
        active: boolean
        disposers: (() => void)[]
    }
    const injectors: FakeInjector[] = []
    const hasService = (name: string): boolean => services[name] !== undefined
    const injectedContext = { get: (name: string): unknown => services[name] }

    const activate = (injector: FakeInjector): void => {
        if (injector.active || !injector.names.every(hasService)) return
        injector.active = true
        const result = injector.callback(injectedContext)
        if (typeof result === 'function') injector.disposers.push(result as () => void)
    }

    const deactivate = (injector: FakeInjector): void => {
        injector.active = false
        // Reverse order, like a fiber unloading its effects: the last cleanup
        // registered runs first.
        for (const dispose of injector.disposers.splice(0).reverse()) {
            try {
                dispose()
            } catch {
                // A test's own cleanup; never let it hide the transition.
            }
        }
    }

    const notifyInjectors = (name: string): void => {
        for (const injector of injectors) {
            if (!injector.names.includes(name)) continue
            // A replaced service reloads its dependents: the old instance is
            // unloaded (disposer runs) before the callback runs against the new one.
            if (injector.active) deactivate(injector)
            activate(injector)
        }
    }

    const inject = (
        deps: string[] | Record<string, unknown>,
        callback: (ctx: { get: (name: string) => unknown }) => unknown,
    ): (() => void) => {
        const names = Array.isArray(deps) ? [...deps] : Object.keys(deps)
        const injector: FakeInjector = { names, callback, active: false, disposers: [] }
        injectors.push(injector)
        activate(injector)
        return () => {
            const index = injectors.indexOf(injector)
            if (index >= 0) injectors.splice(index, 1)
            deactivate(injector)
        }
    }

    const ctx = {
        tools: {
            register(definition: FakeTool) {
                if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
                tools.set(definition.name, definition)
                return () => tools.delete(definition.name)
            },
            guard(guard: (exec: unknown) => string | undefined) {
                guards.push(guard)
                return () => {
                    const index = guards.indexOf(guard)
                    if (index >= 0) guards.splice(index, 1)
                }
            },
            get(name: string) {
                return tools.get(name)
            },
            restrict() {
                return () => undefined
            },
        },
        systemPrompt: {
            section(section: FakeHost['sections'][number]) {
                if (sections.some((entry) => entry.name === section.name)) {
                    throw new Error(`duplicate section ${section.name}`)
                }
                sections.push(section)
                return () => {
                    const index = sections.indexOf(section)
                    if (index >= 0) sections.splice(index, 1)
                }
            },
        },
        on,
        effect(execute: () => (() => void) | void) {
            const disposer = execute()
            if (typeof disposer === 'function') effects.push(disposer)
        },
        get(name: string) {
            return services[name]
        },
        provide(name: string, value: unknown) {
            services[name] = value
            notifyInjectors(name)
            return () => {
                // Only the provider of the CURRENT value may withdraw it (a
                // stale disposer must not delete a service that replaced it).
                if (services[name] !== value) return
                delete services[name]
                notifyInjectors(name)
            }
        },
        inject,
    }

    const emit = (event: string, payload: unknown): void => {
        const args = Array.isArray(payload) ? payload : [payload]
        for (const listener of listeners.get(event) ?? []) {
            ;(listener as (...values: unknown[]) => unknown)(...args)
        }
    }

    const waterfall = async <T>(event: string, payload: unknown, base: () => Promise<T> | T): Promise<T> => {
        const chain = [...(listeners.get(event) ?? [])] as ((...values: unknown[]) => Promise<T>)[]
        // A waterfall's leading arguments differ per event (`(exec, next)` vs
        // `(exec, result, next)`), so an array payload is spread.
        const leading = Array.isArray(payload) ? payload : [payload]
        let index = 0
        const next = async (): Promise<T> => {
            const listener = chain[index]
            index += 1
            if (listener === undefined) return await base()
            return await listener(...leading, next)
        }
        return await next()
    }

    const runTool = async (name: string, args: unknown = {}, exec: Record<string, unknown> = {}): Promise<ToolRun> => {
        const definition = tools.get(name)
        if (definition === undefined) throw new Error(`tool ${name} is not registered`)
        const context = {
            agent,
            callId: `call-${toolRuns.length + 1}`,
            rootCallId: `call-${toolRuns.length + 1}`,
            name,
            arguments: args,
            signal: new AbortController().signal,
            deferContext: () => undefined,
            concludeTurn: () => undefined,
            ...exec,
        }
        try {
            const value = await definition.execute(args as never, context)
            const rendered = definition.output?.render(args, value) ?? value
            const run: ToolRun = { name, args, value, isError: false, content: rendered }
            toolRuns.push(run)
            return run
        } catch (error) {
            const run: ToolRun = {
                name,
                args,
                value: undefined,
                isError: true,
                content: error instanceof Error ? error.message : String(error),
            }
            toolRuns.push(run)
            return run
        }
    }

    return {
        ctx,
        cwd,
        agent,
        tools,
        guards,
        listeners,
        effects,
        sections,
        toolRuns,
        subagentStarts,
        activationSpecs,
        activationDisposals: () => activationDisposals,
        presetDefinitions,
        presetRegistrations,
        approvalRequests,
        emit,
        waterfall,
        inject,
        injections: () => injectors.map((injector) => [...injector.names]),
        runTool,
        guardReason: (exec: unknown) => {
            for (const guard of guards) {
                const reason = guard(exec)
                if (reason !== undefined) return reason
            }
            return undefined
        },
        sectionText: (name: string) => {
            const section = sections.find((entry) => entry.name === name)
            if (section === undefined) return ''
            return typeof section.text === 'function' ? section.text() : ''
        },
        dispose: () => {
            for (const disposer of effects.splice(0)) disposer()
            // The host is going away: every dependency callback is unloaded.
            for (const injector of injectors.splice(0)) deactivate(injector)
        },
    }
}

/** Convenience: the text of an emitted tool's rendered content. */
export function runText(run: ToolRun): string {
    const content = run.content
    if (Array.isArray(content)) {
        return content
            .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : JSON.stringify(block)))
            .join('\n')
    }
    return typeof content === 'string' ? content : JSON.stringify(content)
}

/** Expose the outcome shape of a run for assertions. */
export type { RunOutcome, RunSpec }

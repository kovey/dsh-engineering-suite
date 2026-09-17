/**
 * A fake host for unit tests.
 *
 * Every plugin in the suite is assembled with `apply(ctx, config)`, so tests
 * need a context that behaves like the harness for exactly the extension
 * points the suite uses: `tools.register` / `tools.guard` / `tools.get`,
 * `on(event, listener)`, `effect`, `systemPrompt.section`, `approval.request`,
 * `subagents.start`, `subprocess.spawn` and `get(service)`.
 *
 * The fake is deliberately small and honest: it stores definitions, dispatches
 * emit-mode events, and runs waterfall listeners in registration order with a
 * caller-supplied base decision. It performs no schema validation — a test that
 * cares about argument shape should assert on what the tool received.
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
    approvalRequests: unknown[]
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
        services['subagents'] = {
            start: async (provider: string, request: unknown) => {
                subagentStarts.push({ provider, request })
                return {
                    id: 'run-1',
                    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'child output' }] }),
                }
            },
            list: () => ['spawn'],
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
        },
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
        approvalRequests,
        emit,
        waterfall,
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

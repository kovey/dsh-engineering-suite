/**
 * dsh-audit-trail — the audit and traceability layer (docs.md §3.6).
 *
 * Responsibilities:
 *  - observe every tool call and append two structured JSONL rows per call
 *    (`tools/pre-execute` → `pre`, `tools/result` → `result`) with the agent,
 *    session, turn, decision, duration and digests;
 *  - keep the pre-write snapshot chain: before a write-class call runs, copy the
 *    target file's current bytes to `.dsh/audit/snapshots/…`, so the compensation
 *    (`audit_rewind`) can restore the workspace by turn;
 *  - expose `audit_report` / `audit_rewind`.
 *
 * The plugin is a **bypass observer**: no other plugin ever calls it, it only
 * subscribes to events. A failure inside the audit path must therefore never be
 * able to break a tool call — every observer body is wrapped, and the
 * `tools/pre-execute` listener always returns `next()`'s decision unchanged.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.on('tools/pre-execute' | 'tools/result' | 'agent/pre-step' | 'session/disposed')
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt (optional)
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-audit-trail
 */

import type { Context } from '@deepseek-ai/cordis'
import {
    MissionStoreRegistry,
    appendJsonl,
    auditFile,
    createLogger,
    expandHome,
    sessionCwd,
    sessionIdOf,
    agentIdOf,
    type AgentLike,
} from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig, shouldTrack, DEFAULT_ROOT_DIR, type AuditTrailConfig, type EffectiveAuditTrailConfig } from './config.js'
import { describeArgs, describeResult, digestOf, type AuditRow, type DecisionKind, type PreRow, type ResultRow } from './journal.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { captureSnapshot } from './snapshot.js'
import { registerTools } from './tools.js'
import { declaredCwdOf } from './workspace.js'

/** Thrown internally to skip one row without touching the pipeline decision. */
class SkipRow extends Error {}

export const name = 'dsh-audit-trail'

/** Only the service this plugin actually needs (`systemPrompt` is probed, not required). */
export const inject = ['tools']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assemble?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt?: PromptRuntimeLike
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
    effect: (execute: () => (() => void) | void) => void
}

interface ExecLike {
    callId?: string
    rootCallId?: string
    name?: string
    arguments?: unknown
    agent?: AgentLike
}

interface ResultLike {
    isError?: boolean
    content?: unknown
}

interface PreStepPayloadLike {
    agent?: AgentLike
    turn?: number
}

/** One in-flight call, remembered between the `pre` and the `result` event. */
interface Pending {
    startedAt: number
    tool: string
    sessionId: string
    cwd: string
    agentId?: string
    turn?: number
}

const UNKNOWN_SESSION = 'unknown'
/** Bound on the in-flight map: a `pre` whose `result` never arrives must not leak. */
const MAX_PENDING = 1000

/**
 * Normalize the `tools/result` payload.
 *
 * The host emits `(exec, result)`; the suite's fake host dispatches a single
 * payload argument, so both an `[exec, result]` tuple and an
 * `{ exec, result }` record are accepted.
 */
function splitResultPayload(first: unknown, second: unknown): [ExecLike, ResultLike] {
    if (second === undefined) {
        if (Array.isArray(first) && first.length === 2) return [first[0] as ExecLike, first[1] as ResultLike]
        if (typeof first === 'object' && first !== null && 'exec' in first && 'result' in first) {
            const record = first as { exec: ExecLike; result: ResultLike }
            return [record.exec, record.result]
        }
    }
    return [first as ExecLike, second as ResultLike]
}

function decisionKind(decision: unknown): DecisionKind {
    const kind = (decision as { kind?: unknown } | undefined)?.kind
    return kind === 'deny' || kind === 'ask' || kind === 'allow' ? kind : 'allow'
}

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    const resolved = resolveConfig(config)
    if (!resolved.enabled) return
    const logger = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger })
        const disposers: (() => void)[] = []

        // --- in-memory state (per plugin instance, dropped on dispose) --------
        const pending = new Map<string, Pending>()
        const turnBySession = new Map<string, number>()
        const snapshotCounters = new Map<string, number>()

        const forgetSession = (sessionId: string): void => {
            for (const [callId, entry] of pending) if (entry.sessionId === sessionId) pending.delete(callId)
            turnBySession.delete(sessionId)
            for (const key of [...snapshotCounters.keys()]) {
                if (key.startsWith(`${sessionId}#`)) snapshotCounters.delete(key)
            }
        }

        /** Append one row to a session's trail; never throws, never breaks a call. */
        /** Sessions already told that their trail cannot be attributed. */
        const warnedNoWorkspace = new Set<string>()

        const write = (sessionId: string, cwd: string, row: AuditRow): void => {
            try {
                const layout = stores.for(cwd).layout
                appendJsonl(auditFile(layout, sessionId), row)
            } catch (error) {
                logger.debug('audit row dropped:', error)
            }
        }

        /**
         * The configuration that applies to the workspace the calling agent
         * declared. Profile config is the ceiling; the workspace may refine it
         * through its own `.dsh/audit-trail.json` (see `resolveEffectiveConfig`).
         *
         * A session without a declared `header.cwd` keeps the profile
         * configuration: there is no workspace to read a project file from, and
         * reading one out of `process.cwd()` (a directory nobody named) would
         * let an unrelated repository change this session's audit behaviour.
         * Never throws: a broken project file degrades to the profile config.
         */
        const effectiveFor = (agent: AgentLike | undefined): EffectiveAuditTrailConfig => {
            try {
                const cwd = agent?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') return { config: resolved, source: 'profile', problems: [] }
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)
            } catch (error) {
                logger.debug('project config lookup failed:', error)
                return { config: resolved, source: 'profile', problems: [] }
            }
        }

        // --- tools/pre-execute (waterfall) ------------------------------------
        const onPreExecute = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
            const exec = (payload ?? {}) as ExecLike
            // Every value below is pre-initialized: whatever happens while
            // preparing the row, `await next()` must still be reached with the
            // chain's own decision returned unchanged.
            let callId = `unidentified-${Date.now()}`
            let tool = 'unknown'
            let sessionId = UNKNOWN_SESSION
            // Deliberately NOT `process.cwd()`: an undeclared workspace must not
            // silently become the harness's own directory (the trail would be
            // written into the wrong project). `undefined` = "cannot attribute",
            // and the row is skipped below.
            let cwd: string | undefined
            let agentId: string | undefined
            let turn: number | undefined
            let tracked = false
            let startedAt = Date.now()
            let snapshot: PreRow['snapshot']
            let snapshotNote: string | undefined
            // The profile configuration until the workspace is known: `describeArgs`
            // in the `finally` block must never read an undefined config.
            let effective: EffectiveAuditTrailConfig = { config: resolved, source: 'profile', problems: [] }
            // Unbound until the workspace is known.
            let scopedLog = logger

            try {
                callId = typeof exec.callId === 'string' && exec.callId !== '' ? exec.callId : callId
                tool = typeof exec.name === 'string' && exec.name !== '' ? exec.name : tool
                const agent = exec.agent
                sessionId = sessionIdOf(agent) ?? UNKNOWN_SESSION
                agentId = agentIdOf(agent)
                cwd = declaredCwdOf(agent)
                turn = turnBySession.get(sessionId)
                // Resolved per call (one cached `stat`): one dsh process serves
                // several workspaces, each with its own audit settings.
                effective = effectiveFor(agent)
                tracked = shouldTrack(effective.config, tool)
                startedAt = Date.now()

                // Snapshot BEFORE `next()`: the pre-state must be the state
                // before anything in the pipeline (or the tool) touches the file.
                if (tracked && cwd !== undefined) {
                    const key = `${sessionId}#${turn === undefined ? 'turn-unknown' : `turn-${turn}`}`
                    const ordinal = (snapshotCounters.get(key) ?? 0) + 1
                    const layout = stores.for(cwd).layout
                    // Every line of this call goes to the WORKSPACE's log file, so
                    // several repositories never interleave (docs/ARCHITECTURE §5.3).
                    scopedLog = logger.for(cwd)
                    snapshot = captureSnapshot(tool, exec.arguments, {
                        config: effective.config,
                        layout,
                        cwd,
                        sessionId,
                        ...(turn === undefined ? {} : { turn }),
                        ordinal,
                    })
                    if (snapshot !== undefined && snapshot.reason === undefined) snapshotCounters.set(key, ordinal)
                }
            } catch (error) {
                snapshotNote = 'snapshot-failed'
                scopedLog.debug('pre-execute preparation failed:', error)
            }

            let decision: DecisionKind | 'error' = 'error'
            try {
                const settled = await next()
                decision = decisionKind(settled)
                return settled
            } catch (error) {
                logger.debug('pre-execute chain threw:', error)
                throw error
            } finally {
                try {
                    if (tracked) {
                        const args = describeArgs(exec.arguments, effective.config)
                        const notes = [
                            args.unserializable ? 'args-unserializable' : '',
                            snapshotNote ?? '',
                            decision === 'error' ? 'decision-error' : '',
                        ].filter((part) => part !== '')
                        const row: PreRow = {
                            phase: 'pre',
                            ts: new Date().toISOString(),
                            sessionId,
                            ...(agentId === undefined ? {} : { agentId }),
                            ...(turn === undefined ? {} : { turn }),
                            callId,
                            ...(typeof exec.rootCallId === 'string' && exec.rootCallId !== '' ? { rootCallId: exec.rootCallId } : {}),
                            tool,
                            argsDigest: args.digest,
                            argsSummary: args.summary,
                            decision,
                            ...(snapshot === undefined ? {} : { snapshot }),
                            ...(notes.length === 0 ? {} : { note: notes.join(',') }),
                        }
                        if (cwd === undefined) {
                            if (!warnedNoWorkspace.has(sessionId)) {
                                warnedNoWorkspace.add(sessionId)
                                logger.warn(
                                    `会话 ${sessionId} 没有声明 header.cwd：无法确定审计轨迹属于哪个项目，本会话的审计行被跳过（绝不写到 harness 自己的目录）。`,
                                )
                            }
                            // Not `return` (this is the `finally` block): just
                            // skip persisting the row for this call.
                            throw new SkipRow()
                        }
                        pending.set(callId, {
                            startedAt,
                            tool,
                            sessionId,
                            cwd,
                            ...(agentId === undefined ? {} : { agentId }),
                            ...(turn === undefined ? {} : { turn }),
                        })
                        while (pending.size > MAX_PENDING) {
                            const oldest = pending.keys().next()
                            if (oldest.done === true) break
                            pending.delete(oldest.value)
                        }
                        write(sessionId, cwd, row)
                    }
                } catch (error) {
                    if (!(error instanceof SkipRow)) scopedLog.debug('pre row failed:', error)
                }
            }
        }

        // --- tools/result (emit) ---------------------------------------------
        const onResult = (first: unknown, second: unknown): void => {
            try {
                const [exec, result] = splitResultPayload(first, second)
                const callId = typeof exec.callId === 'string' ? exec.callId : ''
                const agent = exec.agent
                const sessionId = sessionIdOf(agent) ?? UNKNOWN_SESSION
                const cwd = declaredCwdOf(agent)
                const remembered = pending.get(callId)
                if (remembered !== undefined) pending.delete(callId)
                const tool = typeof exec.name === 'string' && exec.name !== '' ? exec.name : (remembered?.tool ?? 'unknown')
                // The workspace's own settings decide this too (one cached
                // `stat`): the profile-only config would record a row the `pre`
                // of a project that ignores this tool never wrote.
                const effective = effectiveFor(exec.agent)
                if (!shouldTrack(effective.config, tool)) return

                const described = describeResult(result, effective.config)
                const row: ResultRow = {
                    phase: 'result',
                    ts: new Date().toISOString(),
                    sessionId: remembered?.sessionId ?? sessionId,
                    ...(remembered?.agentId === undefined ? {} : { agentId: remembered.agentId }),
                    ...(remembered?.turn === undefined ? {} : { turn: remembered.turn }),
                    callId,
                    ...(typeof exec.rootCallId === 'string' && exec.rootCallId !== '' ? { rootCallId: exec.rootCallId } : {}),
                    tool,
                    isError: described.isError,
                    durationMs: remembered === undefined ? 0 : Math.max(0, Date.now() - remembered.startedAt),
                    resultDigest: described.digest,
                    resultTail: described.tail,
                    ...(described.digest === '' ? { note: 'result-unserializable' } : {}),
                }
                const rowCwd = remembered?.cwd ?? cwd
                if (rowCwd === undefined) {
                    if (!warnedNoWorkspace.has(sessionId)) {
                        warnedNoWorkspace.add(sessionId)
                        logger.warn(`会话 ${sessionId} 没有声明 header.cwd：审计行被跳过（绝不写到 harness 自己的目录）。`)
                    }
                    return
                }
                write(row.sessionId, rowCwd, row)
            } catch (error) {
                logger.debug('result row failed:', error)
            }
        }

        // --- agent/pre-step (waterfall: learn the current turn) ---------------
        const onPreStep = async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
            try {
                const step = (payload ?? {}) as PreStepPayloadLike
                const sessionId = sessionIdOf(step.agent)
                if (sessionId !== undefined && typeof step.turn === 'number' && Number.isFinite(step.turn)) {
                    turnBySession.set(sessionId, step.turn)
                }
            } catch (error) {
                logger.debug('turn attribution failed:', error)
            }
            return await next()
        }

        // --- agent/inbox/claimed + agent/turn-stopping (emit/serial: the same
        //     turn attribution as agent/pre-step, so a session that never emits
        //     pre-step still produces rollbackable snapshots) ------------------
        const onTurnSignal = (payload: unknown): void => {
            try {
                const signal = (payload ?? {}) as { agent?: unknown; turn?: unknown }
                const sessionId = sessionIdOf(signal.agent as never)
                if (sessionId !== undefined && typeof signal.turn === 'number' && Number.isFinite(signal.turn)) {
                    turnBySession.set(sessionId, signal.turn)
                }
            } catch (error) {
                logger.debug('turn attribution failed:', error)
            }
        }

        // --- session/disposed (emit; subscribed defensively) ------------------
        const onSessionDisposed = (payload: unknown): void => {
            try {
                const direct = typeof payload === 'string' ? payload : undefined
                const record = (payload ?? {}) as { id?: unknown; sessionId?: unknown; session?: { id?: unknown } }
                const sessionId =
                    direct ??
                    (typeof record.id === 'string' ? record.id : undefined) ??
                    (typeof record.sessionId === 'string' ? record.sessionId : undefined) ??
                    (typeof record.session?.id === 'string' ? record.session.id : undefined)
                if (sessionId !== undefined) forgetSession(sessionId)
            } catch (error) {
                logger.debug('session cleanup failed:', error)
            }
        }

        const listen = (event: string, listener: (...args: never[]) => unknown): void => {
            try {
                disposers.push(context.on(event, listener))
            } catch (error) {
                logger.warn(`cannot subscribe to ${event}:`, error)
            }
        }

        listen('tools/pre-execute', onPreExecute as never)
        listen('tools/result', onResult as never)
        listen('agent/pre-step', onPreStep as never)
        // Turn attribution must not depend on a single event: a session driven
        // without `agent/pre-step` (an SDK embedding) still emits inbox/claimed
        // and turn-stopping, both of which carry the turn number.
        listen('agent/inbox/claimed', onTurnSignal as never)
        listen('agent/turn-stopping', onTurnSignal as never)
        listen('session/disposed', onSessionDisposed as never)

        // --- tool surface -----------------------------------------------------
        const tools = registerTools(context as never, {
            config: resolved,
            stores,
            // Profile config is the ceiling; a workspace may refine it through
            // its own .dsh/audit-trail.json (see resolveEffectiveConfig).
            configFor: (cwd: string) => resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger),
        })
        disposers.push(...tools.disposers)

        if (resolved.prompt.enabled && typeof context.systemPrompt?.section === 'function') {
            try {
                disposers.push(
                    context.systemPrompt.section({
                        name: PROMPT_SECTION,
                        order: resolved.prompt.order,
                        // Per assembly: the snapshot/tool policy is workspace-scoped.
                        text: (assemble?: unknown) => {
                            try {
                                const scope = (assemble as { scope?: { session?: { header?: { cwd?: string } } } } | undefined)?.scope
                                const cwd = scope?.session?.header?.cwd
                                if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                                const effective = resolveEffectiveConfig(resolved, stores.for(cwd).layout, logger)
                                return sectionText(effective.config)
                            } catch {
                                return sectionText(resolved)
                            }
                        },
                    }),
                )
            } catch (error) {
                logger.warn('prompt section rejected:', error)
            }
        }

        ctx.effect(() => () => {
            for (const dispose of disposers.splice(0)) {
                try {
                    dispose()
                } catch (error) {
                    logger.warn('disposer failed:', error)
                }
            }
            pending.clear()
            turnBySession.clear()
            snapshotCounters.clear()
        })

        logger.info(
            `applied (tools: ${tools.registered.join(', ')}${tools.failed.length > 0 ? `; failed: ${tools.failed.join(', ')}` : ''}; snapshot=${resolved.snapshot.enabled}; redactArgs=${resolved.redactArgs}; prompt=${resolved.prompt.enabled}; projectConfig=${resolved.layout.rootDir ?? DEFAULT_ROOT_DIR}/audit-trail.json)`,
        )
    } catch (error) {
        logger.error('apply failed:', error)
    }
}

/** Exported for tests: the row digest of one arbitrary value. */
export { digestOf }
export type { AuditTrailConfig }

/**
 * The host-facing shell of the trust-root fallback (`trust-root-watch.ts`).
 *
 * It exists to translate ONE host event into the pure inputs of the watcher:
 * `tools/result` → `{ tool, cwd, approved }` → `observe`. Everything else
 * (fingerprints, classification, the breach, the ledger) lives in the core
 * module, which a test can drive without a host.
 *
 * Both event spellings are registered because the contract is the EVENT, not
 * the name: this host emits `tools/result` (`dsh-tools`' emit-mode event, the
 * one `dsh-audit-trail` observes), while a host that spells it `tool/result`
 * must not lose the fallback. A host without the event simply never emits —
 * registration is not an error either way.
 *
 * @module dsh-spec-gate/trust-root-events
 */

import type { Logger } from 'dsh-eng-core'
import { createTrustRootWatch, type TrustRootWatch, type TrustRootWatchOptions } from './trust-root-watch.js'

/** The host context slice the event shell needs (`ctx.on`). */
export interface WatchContextLike {
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** Register one listener; a host that rejects the event is reported, not fatal. */
function listen(
    ctx: WatchContextLike,
    event: string,
    listener: (...args: never[]) => unknown,
    logger?: Logger,
): (() => void) | undefined {
    try {
        return ctx.on(event, listener)
    } catch (error) {
        logger?.warn(`无法监听宿主事件 ${event}（该宿主没有此事件）：${messageOf(error)}`)
        return undefined
    }
}

/** Run every listener disposer; one broken disposer must not leak the rest. */
function disposeAll(disposers: readonly (() => void)[], logger?: Logger): void {
    for (const dispose of disposers) {
        try {
            dispose()
        } catch (error) {
            logger?.warn(`信任根监听器卸载失败：${messageOf(error)}`)
        }
    }
}

/**
 * Mount the watcher on the host's tool-result event(s).
 * @param ctx - the host context (`ctx.on`).
 * @param options - see {@link TrustRootWatchOptions}.
 */
export function mountTrustRootWatch(ctx: WatchContextLike, options: TrustRootWatchOptions = {}): TrustRootWatch {
    const watch = createTrustRootWatch(options)
    if (options.cwd !== undefined) watch.ensureBaseline(options.cwd)
    const disposers: (() => void)[] = []
    for (const event of ['tools/result', 'tool/result']) {
        const dispose = listen(ctx, event, ((...args: never[]) => onToolResult(watch, args, options)) as never, options.logger)
        if (dispose !== undefined) disposers.push(dispose)
    }
    return {
        ...watch,
        dispose: () => {
            disposeAll(disposers, options.logger)
            watch.dispose()
        },
    }
}

function onToolResult(watch: TrustRootWatch, args: readonly unknown[], options: TrustRootWatchOptions): void {
    const event = toolResultOf(args, options.cwd)
    if (event === undefined) return
    try {
        watch.observe({ tool: event.tool, cwd: event.cwd, ...(event.approved ? { approved: true } : {}) })
    } catch (error) {
        options.logger?.warn(`信任根兜底比对失败（${event.tool}）：${messageOf(error)}`)
    }
}

/** Text of a tool result's `content` (string, text blocks, or nested content). */
function resultText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(resultText).join('\n')
    if (isRecord(content) && typeof content['text'] === 'string') return content['text']
    return ''
}

/** Whether this `spec_approve` result recorded an approval (`isError` means no). */
function approvalSucceeded(result: unknown): boolean {
    if (!isRecord(result) || result['isError'] === true) return false
    return resultText(result['content']).includes('规格已审批')
}

/**
 * Normalise one `tools/result` dispatch into the pure inputs.
 *
 * The host emits `(exec, result)`; a fake host (and some builds) dispatch a
 * single `{ exec, result }` record or an `[exec, result]` tuple. All three are
 * accepted, because a payload shape must never be the reason the fallback
 * silently stops observing.
 */
function toolResultOf(
    args: readonly unknown[],
    fallbackCwd: string | undefined,
): { tool: string; cwd: string; approved: boolean } | undefined {
    const [first, second] = args
    let exec: unknown = first
    let result: unknown = second
    if (second === undefined) {
        if (Array.isArray(first) && first.length === 2) [exec, result] = first
        else if (isRecord(first) && 'exec' in first) {
            exec = first['exec']
            result = first['result']
        }
    }
    if (!isRecord(exec)) return undefined
    const tool = typeof exec['name'] === 'string' ? exec['name'] : ''
    const agent = isRecord(exec['agent']) ? exec['agent'] : undefined
    const session = agent !== undefined && isRecord(agent['session']) ? agent['session'] : undefined
    const header = session !== undefined && isRecord(session['header']) ? session['header'] : undefined
    const cwd = header !== undefined && typeof header['cwd'] === 'string' ? header['cwd'] : fallbackCwd
    if (tool === '' || cwd === undefined) return undefined
    return { tool, cwd, approved: tool === 'spec_approve' && approvalSucceeded(result) }
}

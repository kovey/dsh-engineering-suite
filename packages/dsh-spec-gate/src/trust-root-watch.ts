/**
 * Runtime fallback for the trust root (`docs/ARCHITECTURE.md` §5.31).
 *
 * The shell analyser (see `shell.ts`) catches the write forms it can model, but
 * a static analyser is a net, not a proof: a command string can always be
 * assembled in a way it does not recognise, and a tool this gate does not know
 * at all can still write `.dsh/**`. This module adds the property that does not
 * depend on the spelling of a command: **the trust root only changes through
 * the suite's own tools**. After every host tool result it recomputes the
 * trust-root fingerprint (the SAME `policyFingerprint` a mission's mandate uses
 * — no second hash to drift from it) and compares it with the last observation.
 *
 *   - unchanged                → nothing happened;
 *   - changed by a suite tool  → legitimate (spec mission state, gates,
 *     evidence, ADR, standards baseline); the baseline is refreshed;
 *   - changed by anything else → a violation: one JSONL row under
 *     `<布局根>/state/`, a warn through the optional `interaction` registry,
 *     and a sticky breach that makes `guard()` refuse write-class calls until
 *     the process restarts or a NEW mission is approved.
 *
 * The pure part (`fingerprint` / `classifyTool` / `evaluate`) is separated from
 * the event shell (`trust-root-events.ts`) on purpose: the policy is testable
 * without a host, and the shell only translates one `tools/result` payload into
 * these inputs.
 *
 * @module dsh-spec-gate/trust-root-watch
 */

import path from 'node:path'
import {
    appendJsonl,
    policyDifferences,
    policyFingerprint,
    resolveLayout,
    type Logger,
    type PolicyChange,
    type PolicyFingerprint,
} from 'dsh-eng-core'

/** One recorded out-of-band change of the trust root. */
export interface TrustRootViolation {
    /** When it was observed (epoch ms). */
    at: number
    /** The tool whose completion exposed the change. */
    tool: string
    /** Workspace root the fingerprint was computed against. */
    workspace: string
    /** Trust-root files that differ from the last observation. */
    changed: PolicyChange[]
}

/** What one tool completion did to the trust root. */
export type TrustRootVerdict =
    | { kind: 'none' }
    | { kind: 'refresh' }
    | { kind: 'violation'; changed: PolicyChange[] }

/** A tool the suite itself registers — its writes to the trust root are legal. */
const SUITE_TOOLS: readonly string[] = [
    'adr_list', 'adr_record', 'audit_report', 'audit_rewind', 'budget_check', 'contract_check',
    'coverage_check', 'coverage_status', 'dependency_audit',
    'deploy_plan', 'deploy_rollback', 'deploy_run', 'deploy_status', 'deploy_verify',
    'evidence_record', 'evidence_status', 'flaky_check', 'flaky_plan', 'flaky_status',
    'impact_analyze', 'impact_status', 'impact_tests',
    'interaction_ask', 'interaction_notify', 'interaction_progress', 'interaction_status',
    'kb_index', 'kb_search', 'kb_status', 'mission_complete', 'mutation_check', 'plan_status',
    'quality_gate_run', 'quality_gate_status',
    'release_notes', 'release_record', 'release_status', 'role_list', 'secret_scan',
    'spec_amend', 'spec_approve', 'spec_bootstrap', 'spec_create', 'spec_status',
    'standards_bootstrap', 'standards_check', 'standards_review', 'standards_status',
    'suite_config', 'suite_init', 'suite_status', 'supply_chain_status', 'team_delegate',
    'test_design_review', 'test_design_template',
]

/**
 * Whether a tool belongs to this suite.
 *
 * Unknown names classify as `foreign` on purpose: an extension that forgets to
 * list its tool gets a LOUD violation, while the opposite default would let a
 * host tool rewrite the trust root silently. `extra` is the configuration seam
 * for a deployment whose plugins add tools of their own.
 * @param name - the tool name from the host's `tools/result` event.
 * @param extra - additional suite tool names (host configuration).
 */
export function classifyTool(name: string, extra: readonly string[] = []): 'suite' | 'foreign' {
    const trimmed = name.trim()
    return SUITE_TOOLS.includes(trimmed) || extra.includes(trimmed) ? 'suite' : 'foreign'
}

/**
 * The trust-root fingerprint of one workspace.
 *
 * Delegates to `dsh-eng-core`'s `policyFingerprint` — the exact function that
 * stamps a mission's mandate (`policyVersion`), so "the gate's view of the
 * trust root" and "the runtime fallback's view" cannot diverge.
 * @param cwd - workspace root (a session's `header.cwd`).
 * @param rootDir - trail root override, when the host configured one.
 */
export function fingerprint(cwd: string, rootDir?: string): PolicyFingerprint {
    return policyFingerprint(cwd, rootDir === undefined ? {} : { rootDir })
}

/**
 * Judge one before/after fingerprint pair for one tool. Pure.
 * @param before - the last observation of this workspace.
 * @param after - the fingerprint right after the tool completed.
 * @param toolName - the tool whose completion produced `after`.
 * @param suiteTools - additional suite tool names (host configuration).
 */
export function evaluate(
    before: PolicyFingerprint,
    after: PolicyFingerprint,
    toolName: string,
    suiteTools: readonly string[] = [],
): TrustRootVerdict {
    const changed = policyDifferences(before, after)
    if (changed.length === 0) return { kind: 'none' }
    return classifyTool(toolName, suiteTools) === 'suite' ? { kind: 'refresh' } : { kind: 'violation', changed }
}

/** The denial text `guard()` returns while the trust root is breached. */
export function breachReason(row: TrustRootViolation): string {
    const named = row.changed.slice(0, 8).map((change) => `${change.path}(${change.change})`)
    const more = row.changed.length > named.length ? `（另有 ${row.changed.length - named.length} 个）` : ''
    return [
        'spec-gate: 信任根在套件之外被修改，写操作被拒绝——需要重新审批 mission。',
        `触发工具：${row.tool}；工作区：${row.workspace}；时间：${new Date(row.at).toISOString()}`,
        `变化的信任根文件：${named.join(', ')}${more}`,
        '这些文件（门禁阈值、结构与规范基线、审批人名单、角色定义）决定了"什么改动被允许"，只能由套件自己的工具写入。',
        `兜底记录：<布局根>/state/trust-root-violations.jsonl。`,
        '下一步：先用 git diff 看清这些改动，确认后新建 mission：spec_create → test_design_review → spec_approve；',
        '同一个进程里审批通过的新 mission 会解除这条拒绝，否则重启宿主进程。',
    ].join('\n')
}

/** Options of {@link createTrustRootWatch}. */
export interface TrustRootWatchOptions {
    /** Workspace seeded at mount time (the host process cwd by default). */
    cwd?: string
    /** Trail root override, when the host configured one. */
    rootDir?: string
    logger?: Logger
    /** `ctx.get('interaction')` — optional suite channel registry. */
    interaction?: () => unknown
    now?: () => number
    /** Additional suite tool names (host configuration). */
    suiteTools?: readonly string[]
    /** Override the violation ledger path (default `<stateDir>/trust-root-violations.jsonl`). */
    violationsFile?: (stateDir: string) => string
}

/** The stateful half: baselines per workspace, the breach, the ledger. */
export interface TrustRootWatch {
    /** Seed the baseline for a workspace on first sight (idempotent). */
    ensureBaseline: (cwd: string) => void
    /** The last observed fingerprint of a workspace. */
    baseline: (cwd: string) => PolicyFingerprint | undefined
    /** The sticky breach, when one was recorded. */
    breach: () => TrustRootViolation | undefined
    /** Drop the breach (a NEW mission was approved). */
    clear: () => void
    /** Judge one completed tool and update the state. */
    observe: (input: { tool: string; cwd: string; approved?: boolean }) => TrustRootVerdict
    /** Violations recorded by this process, oldest first. */
    violations: () => TrustRootViolation[]
    /**
     * The sliver `guard.ts` consults (`TrustRootGuard`): a baseline seeder and
     * the denial text while breached. Returned as its own object so the guard
     * cannot reach the ledger or clear a breach.
     */
    guard: () => { ensureBaseline: (cwd: string) => void; reason: () => string | undefined }
    dispose: () => void
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** The part of `dsh-interaction-gate`'s registry this module uses. */
interface RegistryLike {
    list: () => { name: string; canNotify: boolean }[]
    send: (name: string, message: { kind: 'notify'; title: string; body: string }) => Promise<unknown>
}

/** Push a warn notification through the optional interaction registry. */
async function notifyInteraction(registry: unknown, row: TrustRootViolation, logger?: Logger): Promise<void> {
    if (!isRecord(registry) || typeof registry['list'] !== 'function' || typeof registry['send'] !== 'function') return
    try {
        const live = registry as unknown as RegistryLike
        const channel = live.list().find((entry) => entry.canNotify)
        if (channel === undefined) return
        await live.send(channel.name, { kind: 'notify', title: '信任根在套件之外被修改', body: breachReason(row) })
    } catch (error) {
        logger?.warn(`interaction 通知发送失败（违规已记录，拒绝已生效）：${messageOf(error)}`)
    }
}

/**
 * Build the stateful watcher (no host dependency; usable from a test directly).
 * @param options - cwd, trail root, logger, interaction, clock and extra tools.
 */
export function createTrustRootWatch(options: TrustRootWatchOptions = {}): TrustRootWatch {
    const baselines = new Map<string, PolicyFingerprint>()
    const rows: TrustRootViolation[] = []
    let breach: TrustRootViolation | undefined

    const ensureBaseline = (cwd: string): void => {
        if (baselines.has(cwd)) return
        try {
            baselines.set(cwd, fingerprint(cwd, options.rootDir))
        } catch (error) {
            options.logger?.warn(`信任根基线计算失败（${cwd}）：${messageOf(error)}`)
        }
    }

    const record = (row: TrustRootViolation): void => {
        rows.push(row)
        breach = row
        try {
            const rootOptions = options.rootDir === undefined ? {} : { rootDir: options.rootDir }
            const stateDir = resolveLayout(row.workspace, rootOptions).stateDir
            appendJsonl(options.violationsFile?.(stateDir) ?? path.join(stateDir, 'trust-root-violations.jsonl'), row)
        } catch (error) {
            options.logger?.warn(`信任根违规无法落盘（已在内存中拒绝写入）：${messageOf(error)}`)
        }
        void notifyInteraction(options.interaction?.(), row, options.logger)
    }

    const observe = (input: { tool: string; cwd: string; approved?: boolean }): TrustRootVerdict => {
        ensureBaseline(input.cwd)
        const before = baselines.get(input.cwd)
        if (before === undefined) return { kind: 'none' }
        const after = fingerprint(input.cwd, options.rootDir)
        const verdict = evaluate(before, after, input.tool, options.suiteTools)
        baselines.set(input.cwd, after)
        if (verdict.kind === 'violation') {
            record({ at: options.now?.() ?? Date.now(), tool: input.tool, workspace: input.cwd, changed: verdict.changed })
        }
        if (input.approved === true) breach = undefined
        return verdict
    }

    return {
        ensureBaseline,
        baseline: (cwd) => baselines.get(cwd),
        breach: () => breach,
        clear: () => {
            breach = undefined
        },
        observe,
        violations: () => [...rows],
        guard: () => ({ ensureBaseline, reason: () => (breach === undefined ? undefined : breachReason(breach)) }),
        dispose: () => baselines.clear(),
    }
}

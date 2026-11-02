/**
 * The deterministic gate engine: run the host-configured commands and turn
 * their exit facts into a `PASS` / `WARN` / `BLOCK` verdict (docs.md §3.4).
 *
 * Rule (fixed, not configurable): a required command that fails → `BLOCK`; only
 * optional commands failing → `WARN`; everything passing → `PASS`. The model
 * never chooses the commands and never rewrites the verdict.
 *
 * Every verdict also reports its **coverage** (`scope`): a `PASS` that only ran
 * a subset of the configured commands proves less than a full run, so the
 * consumer (`dsh-evidence-gate`) can refuse to authorise delivery on it. A run
 * whose command was cancelled (`aborted`) is not a verdict at all.
 *
 * @module dsh-quality-gate/gate
 */

import path from 'node:path'
import {
    applyRuleModes,
    gitFingerprint,
    outputDigestOf,
    runCommand,
    splitCommand,
    tail,
    type GateCommandResult,
    type GateObservation,
    type GateScope,
    type GateState,
    type GitFingerprint,
    type RuleVerdict,
} from 'dsh-eng-core'
import type { GateCommandConfig, QualityGateConfig } from './config.js'
import { renderObservations } from './observations.js'

/** Structural view of `ctx.subprocess`. */
export interface SubprocessLike {
    spawn(spec: never): never
}

/**
 * One command result plus the cooperative-cancellation fact.
 *
 * `dsh-eng-core`'s `GateCommandResult` is shared with the other packages, so
 * the extra field lives here instead of changing the core type: a command that
 * never ran because the turn was cancelled must not read like a failure the
 * model has to fix.
 */
export type GateCommandResultExt = GateCommandResult & { aborted?: boolean }

/** One evaluated gate. */
export interface GateVerdict {
    state: GateState
    /** One-line machine-stable reason. */
    reason: string
    results: GateCommandResultExt[]
    /**
     * What the run actually covered. `full` is false for any selection that did
     * not execute every configured command — a partial `PASS` proves less and
     * must never authorise delivery.
     */
    scope: GateScope
    /**
     * `true` when a command was cancelled before/while running: the run is not a
     * verdict, so callers must not record it nor clear their pending-write state.
     */
    aborted: boolean
    /**
     * Shadow (`observe`) rule verdicts of this run, ordered by rule id. They are
     * recorded, never folded into `state`.
     */
    observations: GateObservation[]
    /**
     * Recoverable rule-mode configuration problems (an unknown `mode`). The rule
     * stays enforcing and the run's verdict is unchanged.
     */
    problems: string[]
}

/** Options for {@link runGate}. */
export interface RunGateOptions {
    /** Workspace root the configured commands run in. */
    cwd: string
    /** Restrict to these command ids. */
    only?: readonly string[]
    /** Restrict to one phase (`lint` skips gate commands). */
    phase?: 'gate' | 'lint'
    /** Cancellation (the turn signal). */
    signal?: AbortSignal
    /** `ctx.subprocess`, when the host provides it. */
    service?: unknown
    /** Pre-captured workspace fingerprint (avoids a second git call in the hooks). */
    fingerprint?: GitFingerprint
    /**
     * Directories whose files never count as "changes" — the engineering trail
     * itself must not consume the host's change budget.
     */
    excludeChangedPaths?: readonly string[]
}

/** Select the commands a run should execute. */
export function selectCommands(
    config: QualityGateConfig,
    options: { only?: readonly string[]; phase?: 'gate' | 'lint' } = {},
): GateCommandConfig[] {
    return config.commands.filter((command) => {
        if (options.only !== undefined && options.only.length > 0 && !options.only.includes(command.id)) return false
        if (options.phase === 'lint' && command.phase !== 'lint') return false
        return true
    })
}

/**
 * The coverage of one run: `full` is true only when the executed command id set
 * equals the configured command id set (and the run was not cancelled).
 * @param config - the resolved configuration (the source of the command set).
 * @param executed - ids of the configured commands that actually executed.
 * @param aborted - whether the run was cancelled (never counts as full).
 */
export function scopeOf(config: QualityGateConfig, executed: readonly string[], aborted = false): GateScope {
    const ids = new Set(executed)
    return {
        selected: [...ids],
        total: config.commands.length,
        full:
            !aborted &&
            config.commands.length > 0 &&
            ids.size === config.commands.length &&
            config.commands.every((command) => ids.has(command.id)),
    }
}

/** One-line coverage summary (shared by verdict rendering and the tool report). */
export function describeScope(scope: GateScope): string {
    return scope.full
        ? `覆盖范围：完整（${scope.selected.length}/${scope.total} 个已配置命令）`
        : `覆盖范围：部分（${scope.selected.length}/${scope.total} 个命令：${
              scope.selected.join(', ') || '无'
          }）— 不构成完整的交付依据，只有跑完整个命令集的裁决才能放行`
}

/**
 * The verdict ONE command would contribute if it were enforcing.
 * @param result - the command's exit facts.
 */
function stateOfResult(result: GateCommandResultExt): GateState {
    if (result.exitCode === 0) return 'PASS'
    return result.required ? 'BLOCK' : 'WARN'
}

/**
 * A one-line, machine-stable reason for one rule's verdict.
 *
 * Deliberately built from stable facts only (exit code / timeout / required):
 * an observation is compared across runs by the doctor, so durations or output
 * order must not make two identical shadows look different.
 * @param result - the command's exit facts.
 */
function reasonOfResult(result: GateCommandResultExt): string {
    const outcome = result.timedOut ? '超时' : `exit=${result.exitCode ?? 'null'}`
    if (result.exitCode === 0) return `通过（${outcome}）`
    return `${result.required ? '必需命令失败' : '非必需命令失败'}（${outcome}）`
}

/**
 * Execute the configured commands and compute the verdict.
 * @param config - resolved configuration.
 * @param options - workspace, selection, cancellation and transport.
 * @returns the verdict with every command's exit facts and bounded output.
 */
export async function runGate(config: QualityGateConfig, options: RunGateOptions): Promise<GateVerdict> {
    const commands = selectCommands(config, {
        ...(options.only === undefined ? {} : { only: options.only }),
        ...(options.phase === undefined ? {} : { phase: options.phase }),
    })
    // A caller may not narrow the gate into a vacuous pass: naming a command
    // that does not exist must fail loudly, because "run only the command I
    // just made up" is exactly how a green verdict gets fabricated.
    const requested = options.only ?? []
    const unknown = requested.filter((id) => !config.commands.some((command) => command.id === id))
    if (unknown.length > 0) {
        return {
            state: 'BLOCK',
            reason:
                config.commands.length === 0
                    ? `未配置任何门禁命令，且请求的命令不存在：${unknown.join(', ')}`
                    : `请求的门禁命令不存在：${unknown.join(', ')}（可用：${config.commands.map((command) => command.id).join(', ')}）`,
            results: [],
            scope: scopeOf(config, []),
            aborted: false,
            observations: [],
            problems: [],
        }
    }
    if (commands.length === 0) {
        return {
            state: 'WARN',
            reason:
                config.commands.length === 0
                    ? '没有配置任何门禁命令：门禁无法证明任何东西（请在 quality-gate 的 config.commands 中声明宿主命令）'
                    : `没有 ${options.phase ?? '指定'} 阶段的命令可执行（已配置：${config.commands
                          .map((command) => `${command.id}[${command.phase}]`)
                          .join(', ')}）`,
            results: [],
            scope: scopeOf(config, []),
            aborted: false,
            observations: [],
            problems: [],
        }
    }
    const results: GateCommandResultExt[] = []
    const executed: string[] = []
    // A rule whose configured `mode` was unusable stays enforcing; its problem
    // rides along to the report (never silently dropped, never read as observe).
    const problems = commands.flatMap((command) => (command.modeProblem === undefined ? [] : [command.modeProblem]))
    for (const command of commands) {
        const outcome = await runCommand(
            {
                argv: splitCommand(command.command),
                // A project-level command may name a subdirectory: resolve it
                // against the workspace, never against the harness process cwd.
                cwd: command.cwd === undefined ? options.cwd : path.resolve(options.cwd, command.cwd),
                timeoutMs: command.timeoutMs,
                maxOutputBytes: config.maxOutputBytes,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                ...(command.env === undefined ? {} : { env: command.env }),
            },
            options.service as never,
        )
        const output = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n--- stderr ---\n')
        const result: GateCommandResultExt = {
            id: command.id,
            name: command.name,
            command: command.command,
            required: command.required,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            durationMs: outcome.durationMs,
            timedOut: outcome.timedOut,
            output: tail(output, 4_000),
            outputDigest: outputDigestOf(outcome.stdout, outcome.stderr),
            ...(outcome.aborted === true ? { aborted: true } : {}),
            // The row is a RECORDING for an observe rule, marked so no reader
            // (report, retrospective, ledger) can mistake it for a verdict.
            ...(command.mode === 'observe' ? { mode: 'observe' as const } : {}),
        }
        results.push(result)
        // A cancelled command never ran (or was killed by the cancellation): the
        // harness discards this turn, so the run stops here and the caller must
        // treat it as "not a verdict" (never record it, never clear its
        // pending-write counter).
        if (outcome.aborted === true || options.signal?.aborted === true) {
            return {
                state: 'BLOCK',
                reason: `运行已取消（signal 已 abort）："${command.id}" 的结果不构成裁决，不会被记录。`,
                results,
                scope: scopeOf(config, executed, true),
                aborted: true,
                observations: [],
                problems: [],
            }
        }
        executed.push(command.id)
        if (outcome.spawnError !== undefined) {
            result.output = `${result.output}\n[spawn error] ${outcome.spawnError}`
        }
    }
    // Host-configured change budget (docs.md §9: "最大改动文件数…都应从插件的
    // Config 中读取"). It is a deterministic check that does not depend on any
    // command, so it is recorded as a synthetic gate entry.
    if (config.limits.maxChangedFiles > 0) {
        const fingerprint = options.fingerprint ?? gitFingerprint(options.cwd, { excludePaths: options.excludeChangedPaths ?? [] })
        if (fingerprint.isRepo) {
            const exceeded = fingerprint.changedFiles > config.limits.maxChangedFiles
            const detail = `改动文件数 ${fingerprint.changedFiles}（上限 ${config.limits.maxChangedFiles}）`
            results.push({
                id: 'limit-changed-files',
                name: '改动文件数上限',
                command: `changedFiles <= ${config.limits.maxChangedFiles}`,
                required: true,
                exitCode: exceeded ? 1 : 0,
                signal: null,
                durationMs: 0,
                timedOut: false,
                output: exceeded
                    ? `${detail}：一次任务改动的文件过多，通常意味着范围失控。请拆分任务或收窄规格的文件边界后重跑门禁。`
                    : detail,
                outputDigest: outputDigestOf(detail, ''),
            })
        } else {
            results.push({
                id: 'limit-changed-files',
                name: '改动文件数上限',
                command: `changedFiles <= ${config.limits.maxChangedFiles}`,
                required: true,
                exitCode: 1,
                signal: null,
                durationMs: 0,
                timedOut: false,
                output: '工作区不是 git 仓库：无法统计改动文件数，按 fail closed 处理（把 limits.maxChangedFiles 设为 0 可关闭该检查）。',
                outputDigest: outputDigestOf('not-a-repo', ''),
            })
        }
    }
    // Every evaluated rule produced exactly one verdict above (a rule is never
    // skipped because of its mode). `applyRuleModes` is the single place that
    // decides which of them may veto the gate and which are only recorded.
    const outcome = applyRuleModes(
        commands.map((command) => ({ id: command.id, mode: command.mode })),
        results.map((result) => ({
            rule: result.id,
            state: stateOfResult(result),
            reason: reasonOfResult(result),
        })),
    )
    const state: GateState = outcome.effective.state
    const enforcing = outcome.effective.rules
    const blockedRules = enforcing.filter((verdict) => verdict.state === 'BLOCK')
    const warnedRules = enforcing.filter((verdict) => verdict.state === 'WARN')
    const shadowBlocks = outcome.observations.filter((observation) => observation.would === 'BLOCK').length
    const shadowNote =
        outcome.observations.length === 0
            ? ''
            : `；${outcome.observations.length} 条 observe 规则只记录（would BLOCK ${shadowBlocks} 条），不计入裁决`
    return {
        state,
        reason:
            state === 'PASS'
                ? `${enforcing.length === 0 ? '没有执行规则（全部为 observe）' : `${enforcing.length} 个命令全部通过`}${shadowNote}`
                : state === 'WARN'
                  ? `${warnedRules.length} 个非必需命令失败（不阻断交付）${shadowNote}`
                  : `${blockedRules.length} 个必需命令失败：${blockedRules.map((verdict) => verdict.rule).join(', ')}${shadowNote}`,
        results,
        scope: scopeOf(config, executed),
        aborted: false,
        observations: outcome.observations,
        problems: [...problems, ...outcome.problems],
    }
}

/**
 * Status glyph for one command result.
 *
 * A shadow row is never labelled PASS/FAIL/WARN: those read as verdicts. It
 * says `影子 would=…` so the reader sees the measurement, not a decision.
 */
function glyph(result: GateCommandResultExt): string {
    if (result.aborted === true) return 'SKIP'
    if (result.mode === 'observe') return `影子 would=${stateOfResult(result)}`
    return result.exitCode === 0 ? 'PASS' : result.required ? 'FAIL' : 'WARN'
}

/**
 * Render a verdict for the model (compact but complete enough to act on).
 * @param verdict - the evaluated gate.
 * @param options - how much output to include.
 */
export function renderVerdict(
    verdict: GateVerdict,
    options: { heading?: string; outputBytes?: number; includeCommands?: boolean } = {},
): string {
    const lines: string[] = []
    const heading = options.heading ?? '质量门禁'
    lines.push(`${verdict.state === 'PASS' ? '✅' : verdict.state === 'WARN' ? '⚠️' : '⛔'} ${heading}：${verdict.state}`)
    lines.push(`原因：${verdict.reason}`)
    lines.push(describeScope(verdict.scope))
    if (verdict.problems.length > 0) lines.push(`配置问题：${verdict.problems.join('；')}`)
    lines.push(...renderObservations(verdict.observations, verdict.state))
    for (const result of verdict.results) {
        lines.push('')
        lines.push(
            `[${glyph(result)}] ${result.id}（${result.name}）— exit=${result.exitCode ?? 'null'}${result.timedOut ? ' 超时' : ''} ${result.durationMs}ms`,
        )
        if (options.includeCommands !== false) lines.push(`  $ ${result.command}`)
        const output = tail(result.output, options.outputBytes ?? 2_000)
        if (output.trim() !== '') lines.push(output.trimEnd())
    }
    return lines.join('\n')
}

/**
 * A stable signature of a failing verdict, used to suppress repeated identical
 * corrective feedback (the loop breaker of the lint feedback path).
 * @param verdict - the evaluated gate.
 */
export function failureSignature(verdict: GateVerdict): string {
    // Shadow failures never contribute: an observe rule must not be able to
    // change the loop breaker's key for an enforcing failure.
    const failing = verdict.results.filter((result) => result.exitCode !== 0 && result.mode !== 'observe')
    return `${verdict.state}:${failing.map((result) => `${result.id}@${result.outputDigest}`).join('|')}`
}

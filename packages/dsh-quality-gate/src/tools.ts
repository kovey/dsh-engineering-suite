/**
 * The model-facing tool surface: `quality_gate_run` and `quality_gate_status`.
 * @module dsh-quality-gate/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    formatTime,
    gitFingerprint,
    isSafeId,
    sessionCwd,
    sessionIdOf,
    type AgentLike,
    type GateRecord,
    type MissionRecord,
    type MissionStore,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import type { Logger } from 'dsh-eng-core'
import { EXAMPLE_BUDGETS, EXAMPLE_CONTRACTS, type QualityGateConfig } from './config.js'
import { renderBudgets, runBudgets, type SpecBudgetSource } from './budget.js'
import { renderContracts, runContracts } from './contract.js'
import { describeScope, renderVerdict, runGate, selectCommands } from './gate.js'
import { declaredCwdOf, type GateSessions } from './hooks.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools close over. */
export interface ToolDeps {
    config: QualityGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (cwd: string) => { config: QualityGateConfig; source: 'profile' | 'project'; file?: string; problems: string[] }
    stores: MissionStoreRegistry
    sessions: GateSessions
    /** `ctx.get('subprocess')`, read per run. */
    subprocess: () => unknown
    /** Plugin logger; `deps.logger.for(cwd)` routes a line to that workspace's file. */
    logger: Logger
}

/**
 * The workspace a tool call applies to.
 *
 * With no declared `header.cwd` the gate would run the host's commands in the
 * harness's own directory and record the verdict against the wrong project, so
 * the call is refused (the automatic triggers already skip such sessions).
 */
function declaredCwdOrThrow(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：门禁命令会在错误的目录执行，因此本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    return cwd
}

interface RunArgs {
    missionId?: string
    only?: string[]
    phase?: 'gate' | 'lint'
    reason?: string
}

interface StatusArgs {
    missionId?: string
}

interface BudgetArgs {
    missionId?: string
    only?: string[]
}

interface ContractArgs {
    missionId?: string
}

/**
 * Resolve the mission the new gate tools record against, fail closed.
 *
 * `quality_gate_run` tolerates an unknown id (it still returns a verdict about
 * the workspace); a budget/contract call must not, because the interesting half
 * of its output is the ledger row: running the commands and then silently
 * recording nothing would look like a recorded verdict.
 */
function missionOrRefusal(store: MissionStore, agent: AgentLike | undefined, explicitId: string | undefined): MissionRecord | undefined {
    const id = typeof explicitId === 'string' ? explicitId.trim() : ''
    if (id === '') return store.resolveForAgent(agent)
    if (!isSafeId(id)) {
        throw new Error(`mission id 不合法（${JSON.stringify(id)}）：id 是单个路径段。下一步：用 spec_status 取一个正确的 missionId。`)
    }
    const mission = store.read(id)
    if (mission === undefined) {
        const known = store.list().map((entry) => entry.id)
        throw new Error(
            `未知 mission "${id}"：按 fail closed 拒绝（否则这次裁决不会落到任何 mission 上）。` +
                `可用 mission：${known.join('、') || '(无)'}。下一步：用 spec_status 看当前任务的 id，或省略 missionId 用本会话绑定的任务。`,
        )
    }
    return mission
}

/**
 * The budget declaration of a mission's specification, read structurally.
 *
 * `dsh-spec-gate` persists the declarations additively on `mission.spec`
 * (`budgets` / `retiredBudgets`) because `SpecRecord` — the shared contract —
 * has no budget field; this package never imports that plugin, so it reads the
 * shape out of the record and re-validates every field it uses (see
 * `parseSpecBudgets`). A record without the fields declares no budgets.
 * @param mission - the mission whose specification is consulted.
 */
function specBudgetSourceOf(mission: MissionRecord | undefined): SpecBudgetSource | undefined {
    const spec = mission?.spec as { budgets?: unknown; retiredBudgets?: unknown } | undefined
    if (spec?.budgets === undefined) return undefined
    return {
        budgets: Array.isArray(spec.budgets) ? spec.budgets : [spec.budgets],
        ...(Array.isArray(spec.retiredBudgets) ? { retired: spec.retiredBudgets.filter((id): id is string => typeof id === 'string') } : {}),
        ...(mission === undefined ? {} : { missionId: mission.id }),
        ...(mission?.spec?.revision === undefined ? {} : { revision: mission.spec.revision }),
        ...(mission?.spec?.approvedAt === undefined ? { approved: false } : { approved: true }),
    }
}

/** Register the quality-gate tools. */export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    register(
        defineTool({
            name: 'quality_gate_run',
            description:
                'Run the host-configured quality-gate commands (tests, typecheck, lint) and return a PASS / WARN / BLOCK verdict. The command list comes from host configuration, never from this call: you cannot invent or substitute a command.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to record the verdict against (default: the session mission).' },
                only: { type: 'array', items: { type: 'string' }, description: 'Run only these command ids.' },
                phase: {
                    type: 'string',
                    enum: ['gate', 'lint'],
                    description: 'Restrict to one phase; omit to run every configured command.',
                },
                reason: { type: 'string', description: 'Why the gate is being run now (recorded in the audit trail).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: RunArgs = {} as RunArgs, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                // Profile config is the ceiling; the workspace may refine it
                // through its own .dsh/quality-gate.json (project-level commands).
                const effective = deps.configFor(cwd)
                const config = effective.config
                // One fingerprint for the whole call: it feeds the change-budget
                // check and the recorded baseline, so the recorded digest is the
                // one the turn-stop fallback will compare against.
                const fingerprint = gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
                const verdict = await runGate(config, {
                    cwd,
                    ...(args.only === undefined ? {} : { only: args.only }),
                    ...(args.phase === undefined ? {} : { phase: args.phase }),
                    signal: (exec as { signal?: AbortSignal }).signal,
                    service: deps.subprocess(),
                    fingerprint,
                    excludeChangedPaths: [store.layout.rootDir],
                })
                const sessionId = sessionIdOf(agent)
                if (sessionId !== undefined) {
                    const state = deps.sessions.stateFor(sessionId)
                    // A cancelled run is not a verdict, and a partial run proves
                    // only its own subset: neither may clear the pending writes
                    // the turn-stop gate still has to verify.
                    if (!verdict.aborted && verdict.scope.full) {
                        state.pendingWrites = 0
                        if (fingerprint.isRepo) state.lastGateDigest = fingerprint.diffDigest
                    }
                    state.lastVerdict = verdict
                }
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined ? {} : { explicitId: args.missionId }),
                })
                let gateId: string | undefined
                if (mission !== undefined && !verdict.aborted) {
                    gateId = store.recordGate(mission.id, {
                        source: 'dsh-quality-gate',
                        state: verdict.state,
                        reason: args.reason === undefined ? verdict.reason : `${verdict.reason}（${args.reason}）`,
                        results: verdict.results,
                        scope: verdict.scope,
                        fingerprint,
                    }).id
                }
                const next = verdict.aborted
                    ? '本次运行已取消（signal 已 abort）：结果不构成裁决，未写入 gate 记录，pendingWrites 保持不变。需要结论时请在未被取消的轮次重跑 quality_gate_run。'
                    : verdict.state === 'PASS'
                      ? verdict.scope.full
                          ? '下一步：先 evidence_record 登记验证输出（若有），再调用 mission_complete 交付；如果之后又登记了 command/test 证据，重跑一次 quality_gate_run 让门禁覆盖它。'
                          : '本次只跑了部分命令（scope.full=false），它的 PASS 不能作为交付依据：交付前请不带 only/phase 再跑一次完整门禁。'
                      : verdict.state === 'WARN'
                        ? '非必需命令失败：可以在说明风险后继续交付，或先修掉它们。'
                        : '下一步：修复失败的必需命令并重新运行 quality_gate_run；未通过时 mission_complete 会拒绝签发回执。'
                // One line per run, in the WORKSPACE's own log file: with several
                // repositories in one process this is what makes a failure
                // traceable ("谁在哪个项目跑了什么命令、结果如何").
                if (!verdict.aborted) {
                    logger.info(
                        `quality_gate_run: ${verdict.state} — ${verdict.reason}；命令 ${verdict.results
                            .map((result) => `${result.id}=${result.exitCode ?? 'null'}`)
                            .join(', ') || '(无)'}；mission ${mission === undefined ? '(无)' : mission.id}；来源 ${
                            effective.source === 'project' ? effective.file ?? '项目级配置' : 'profile'
                        }`,
                    )
                }
                return [
                    renderVerdict(verdict, { heading: '质量门禁', outputBytes: 4_000 }),
                    '',
                    `command set: ${config.commands.map((command) => `${command.id}[${command.phase}${command.required ? ',required' : ''}]`).join(', ') || '(未配置)'}（来源：${effective.source === 'project' ? effective.file ?? '项目级配置' : 'profile 配置'}）`,
                    `gate record: ${
                        gateId ?? (verdict.aborted ? '(已取消，未记录)' : '(无 mission，未记录)')
                    }`,
                    next,
                ].join('\n')
            },
        }),
        'quality_gate_run',
    )

    register(
        defineTool({
            name: 'quality_gate_status',
            description:
                'Show the configured gate commands, the latest recorded verdict for the mission, and the pending-write/corrective-steer counters of this session.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to inspect (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const lines: string[] = []
                const effective = deps.configFor(declaredCwdOrThrow(agent))
                const config = effective.config
                lines.push(
                    `命令来源：${effective.source === 'project' ? `项目级配置 ${effective.file ?? ''}` : 'profile 配置'}${
                        effective.problems.length === 0 ? '' : `（另有 ${effective.problems.length} 条配置问题，见插件日志）`
                    }`,
                )
                lines.push(
                    config.commands.length === 0
                        ? '⚠️ 没有配置任何门禁命令：spec 的"验收标准"无法被确定性验证。请在 quality-gate 的 config.commands 中声明。'
                        : '| id | 名称 | 命令 | 阶段 | 必需 | 超时 |\n|----|------|------|------|------|------|',
                )
                for (const command of config.commands) {
                    lines.push(
                        `| ${command.id} | ${command.name} | \`${command.command}\` | ${command.phase} | ${command.required ? '是' : '否'} | ${command.timeoutMs}ms |`,
                    )
                }
                const store = deps.stores.for(sessionCwd(agent))
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined ? {} : { explicitId: args.missionId }),
                })
                const sessionId = sessionIdOf(agent)
                if (sessionId !== undefined) {
                    const state = deps.sessions.stateFor(sessionId)
                    const counters = deps.sessions.countersFor(sessionId, mission?.id)
                    lines.push('')
                    lines.push(
                        `session: turn=${state.turn} pendingWrites=${state.pendingWrites} blocksThisTurn=${counters.blocksThisTurn}/${config.turnStop.maxBlocksPerTurn} lintBlocks=${counters.lintBlocksThisTurn}/${config.afterWrite.maxPerTurn}`,
                    )
                }
                if (mission === undefined) {
                    lines.push('mission: (无) — 门禁结果不会被记录到任何 mission。')
                    return lines.join('\n')
                }
                const gate = store.lastGate(mission.id, { source: 'dsh-quality-gate' })
                lines.push(
                    `mission: ${mission.id}（${mission.status}）`,
                    gate === undefined
                        ? 'latest gate: (未运行过)'
                        : `latest gate: ${gate.state} @ ${formatTime(gate.checkedAt)} — ${gate.reason}`,
                )
                if (gate !== undefined) {
                    lines.push(`  ${describeGateScope(gate)}`)
                    for (const result of gate.results) {
                        lines.push(`  - [${result.exitCode === 0 ? 'PASS' : result.required ? 'FAIL' : 'WARN'}] ${result.id} exit=${result.exitCode ?? 'null'}`)
                    }
                    lines.push(`  ${describeDrift(store, gate)}`)
                }
                lines.push(
                    `configured phases: gate=${selectCommands(config, { phase: 'gate' }).length} lint=${selectCommands(config, { phase: 'lint' }).length}`,
                )
                return lines.join('\n')
            },
        }),
        'quality_gate_status',
    )

    register(
        defineTool({
            name: 'budget_check',
            description:
                'Measure the regression budgets and answer "did this get worse", which a PASS/BLOCK test verdict cannot: a duration, a bundle size, a count. Budgets come from TWO sources: the host configuration (config.budgets) and the MISSION\'S SPECIFICATION (declared by spec_create / spec_amend). A spec budget is used when the host declares no budget with that id (the report marks it 来源：规格); when both declare one id the HOST wins (it is the deployment\'s ceiling) and the differing threshold is REPORTED as a conflict naming both values and which one was applied — never resolved silently. Each budget runs its configured command (or a configured gate command via commandId) and compares the measured number against its absolute bounds (max/min) and against the BEST value ever recorded in the append-only baseline (<rootDir>/budgets.json) within maxRegressionPercent. The verdict\'s reason and rows name the linked requirement ids (关联需求：AC-003), so a delivery can show that requirement\'s budget was verified against the spec. The first measurement records the baseline and says so (that is "no data yet", not a pass). A command that did not succeed BLOCKs its own budget and records no measurement; a regex that matches nothing, or a capture that does not parse, is a REFUSAL that writes nothing at all — never a silent pass. With config.requireSpecBudgets=true the call also REFUSES when the specification declares budgets and this run covered none of them. Records a gate row on the mission with scope.full=false: a budget run is not the host gate command set and never authorises a delivery.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to record the budget verdict against (default: the session mission). Its specification is the second source of budgets.' },
                only: { type: 'array', items: { type: 'string' }, description: 'Measure only these budget ids (must exist in the host configuration or in the mission\'s specification).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: BudgetArgs = {} as BudgetArgs, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(cwd)
                const mission = missionOrRefusal(store, agent, args.missionId)
                const spec = specBudgetSourceOf(mission)
                const run = await runBudgets({
                    cwd,
                    config: effective.config,
                    rootDir: store.layout.rootDir,
                    ...(args.only === undefined ? {} : { only: args.only }),
                    ...(spec === undefined ? {} : { spec }),
                    requireSpecBudgets: effective.config.requireSpecBudgets,
                    service: deps.subprocess(),
                    ...((exec as { signal?: AbortSignal }).signal === undefined ? {} : { signal: (exec as { signal?: AbortSignal }).signal }),
                })
                if (!run.ok) {
                    // A refusal writes NOTHING: no baseline entry, no gate row.
                    logger.warn(`budget_check 拒绝执行：${run.problem}`)
                    throw new Error(
                        [
                            run.problem,
                            '',
                            '（预算里没有配置项时的写法示例：）',
                            '```yaml',
                            EXAMPLE_BUDGETS,
                            '```',
                        ].join('\n'),
                    )
                }
                const fingerprint = gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
                let gateId: string | undefined
                if (mission !== undefined) {
                    gateId = store.recordGate(mission.id, {
                        source: 'dsh-quality-gate',
                        state: run.state,
                        reason: `${run.reason}（预算裁决；scope.full=false，不构成交付依据）`,
                        results: run.results,
                        scope: run.scope,
                        fingerprint,
                    }).id
                }
                logger.info(
                    `budget_check: ${run.state} — ${run.reason}；预算 ${run.evaluations
                        .map((evaluation) => `${evaluation.id}=${evaluation.value ?? 'null'}`)
                        .join(', ')}；基线追加 ${run.recorded} 条；mission ${mission === undefined ? '(无)' : mission.id}；来源 ${
                        effective.source === 'project' ? effective.file ?? '项目级配置' : 'profile'
                    }`,
                )
                return [
                    renderBudgets(run, { problems: effective.problems.length }),
                    '',
                    `预算来源：宿主配置 ${effective.source === 'project' ? effective.file ?? '项目级配置' : 'profile 配置'}（${effective.config.budgets.length} 条）` +
                        `；规格 ${run.spec.declared} 条${run.spec.missionId === undefined ? '' : `（mission ${run.spec.missionId}${run.spec.revision === undefined ? '' : `，revision ${run.spec.revision}`}）`}` +
                        `；本次共 ${run.scope.total} 条可用`,
                    ...(run.conflicts.length === 0
                        ? []
                        : [`⚠️ 宿主配置与规格的阈值冲突 ${run.conflicts.length} 条：${run.conflicts.map((conflict) => conflict.id).join('、')}（按宿主配置判定，两个值都写在报告里）`]),
                    `mission: ${mission === undefined ? '(无 — 基线照记，但裁决不会落到任何 mission 上)' : mission.id}`,
                    `gate record: ${gateId ?? '(未记录)'}`,
                    `requireSpecBudgets: ${effective.config.requireSpecBudgets === true ? 'true（规格声明了预算时必须至少覆盖一条）' : 'false'}`,
                    '说明：这次裁决只覆盖预算，不会清零本会话的"待验证写"计数——交付前仍需不带 only/phase 跑一次完整的 quality_gate_run。',
                ].join('\n')
            },
        }),
        'budget_check',
    )

    register(
        defineTool({
            name: 'contract_check',
            description:
                'Run the host-configured smoke contracts and report EVERY declared expectation separately (never one boolean): the exit code, strings that must (or must not) appear on stdout, and JSON values addressed by a dotted path with [n] indices. A JSON path that does not exist is a FAILURE naming the path, never a skip, and stdout that is not valid JSON fails every path assertion. This is a smoke gate, not a mocking framework: it runs the configured command for real, and it proves the declared interface still behaves — not that the interface is correct. Refuses a contract it cannot evaluate (unknown kind, empty command, unknown expectation key, empty expect) with the fix, and records a gate row with scope.full=false.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to record the contract verdict against (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ContractArgs = {} as ContractArgs, exec) {
                const agent = (exec as { agent?: AgentLike }).agent
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(cwd)
                const mission = missionOrRefusal(store, agent, args.missionId)
                const run = await runContracts({
                    cwd,
                    config: effective.config,
                    service: deps.subprocess(),
                    ...((exec as { signal?: AbortSignal }).signal === undefined ? {} : { signal: (exec as { signal?: AbortSignal }).signal }),
                })
                if (!run.ok) {
                    logger.warn(`contract_check 拒绝执行：${run.problem}`)
                    throw new Error(
                        [
                            run.problem,
                            '',
                            '（契约的写法示例：）',
                            '```yaml',
                            EXAMPLE_CONTRACTS,
                            '```',
                        ].join('\n'),
                    )
                }
                const fingerprint = gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
                let gateId: string | undefined
                if (mission !== undefined) {
                    gateId = store.recordGate(mission.id, {
                        source: 'dsh-quality-gate',
                        state: run.state,
                        reason: `${run.reason}（契约裁决；scope.full=false，不构成交付依据）`,
                        results: run.results,
                        scope: run.scope,
                        fingerprint,
                    }).id
                }
                logger.info(
                    `contract_check: ${run.state} — ${run.reason}；契约 ${run.evaluations
                        .map((evaluation) => `${evaluation.id}=${evaluation.checks.filter((check) => check.state === 'FAIL').length} 项失败`)
                        .join(', ')}；mission ${mission === undefined ? '(无)' : mission.id}`,
                )
                return [
                    renderContracts(run, { problems: effective.problems.length }),
                    '',
                    `契约来源：${effective.source === 'project' ? effective.file ?? '项目级配置' : 'profile 配置'}（${run.scope.total} 条已配置）`,
                    `mission: ${mission === undefined ? '(无 — 裁决不会落到任何 mission 上)' : mission.id}`,
                    `gate record: ${gateId ?? '(未记录)'}`,
                    '说明：这次裁决只覆盖契约，不会清零本会话的"待验证写"计数——交付前仍需不带 only/phase 跑一次完整的 quality_gate_run。',
                ].join('\n')
            },
        }),
        'contract_check',
    )

    return { disposers, registered, failed }
}

/** Coverage line for a recorded gate (absent scope = written before it existed). */
function describeGateScope(gate: GateRecord): string {
    if (gate.scope === undefined) {
        return 'scope: (记录未标注覆盖范围 — 视为未知，不能当作"跑全了")'
    }
    return gate.scope.full
        ? `scope: full（${gate.scope.selected.length}/${gate.scope.total} 个已配置命令）`
        : `scope: 部分（${gate.scope.selected.join(', ') || '无'}/${gate.scope.total}）— ⚠️ 该裁决不能作为交付依据`
}

/** Whether the workspace changed since the recorded gate (the turn-stop fallback). */
function describeDrift(store: ReturnType<MissionStoreRegistry['for']>, gate: GateRecord): string {
    if (gate.fingerprint === undefined || !gate.fingerprint.isRepo) return '工作区：指纹不可用（非 git 仓库）'
    const current = gitFingerprint(store.layout.cwd, { excludePaths: [store.layout.rootDir] })
    if (!current.isRepo) return '工作区：不是 git 仓库 — 指纹触发的收尾门禁不生效（仅写类工具触发）'
    return current.diffDigest === gate.fingerprint.diffDigest
        ? '工作区：与最新门禁的指纹一致（收尾时不会因指纹变化重跑门禁）'
        : '工作区：自最新门禁后已变化（含 shell 改动）— 收尾时会自动重跑门禁'
}

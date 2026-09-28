/**
 * The model-facing tool surface: `deploy_plan`, `deploy_run`, `deploy_verify`,
 * `deploy_rollback`, `deploy_status`.
 *
 * Division of labour, the same one the rest of the suite follows:
 *
 *  - the **verdict** comes from `./plan` (pure, injected facts) — never from the
 *    model's summary of how things look;
 *  - the **commands** come from the host's configuration (argv, never a shell);
 *    the model can pick an *environment name*, never a command line;
 *  - the **approval** comes from a human through the `interaction` service (a
 *    chat/IM channel) or the harness approval seam;
 *  - the **record** is a `GateRecord` on the mission plus one append-only row in
 *    the workspace ledger, carrying revision + approver + approval message id.
 *
 * Fail-closed everywhere: an undeployable environment refuses instead of
 * inventing steps, a missing approval channel refuses instead of assuming
 * consent, "nobody answered" is never a pass, and a rollback that is not declared
 * is not a rollback.
 *
 * @module dsh-deploy-gate/tools
 */

import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    approverName,
    describeFingerprint,
    formatTime,
    gitFingerprint,
    normalizeApprovalReply,
    outputDigestOf,
    proseOf,
    readText,
    renderApprovalContext,
    runCommand,
    sessionIdOf,
    agentIdOf,
    stamp,
    tail,
    type AgentLike,
    type ApprovalLike,
    type ApprovalOutcome,
    type GateCommandResult,
    type GateRecord,
    type GateScope,
    type GateState,
    type GitFingerprint,
    type Logger,
    type MissionRecord,
    type MissionStore,
    type MissionStoreRegistry,
    type Receipt,
    type RunOutcome,
    type SubprocessLike,
} from 'dsh-eng-core'
import {
    describeCommands,
    describeSource,
    environmentByName,
    type DeployGateConfig,
    type EffectiveConfig,
    type EnvironmentConfig,
} from './config.js'
import { resolveCommands, type TemplateVars } from './command.js'
import {
    appendLedgerRow,
    deploymentId,
    findDeployment,
    lastRowOf,
    ledgerWritable,
    liveDeployment,
    readLedger,
    rollbackTargetOf,
    summarize,
    type DeployState,
    type LedgerRow,
} from './ledger.js'
import {
    compareRevision,
    describeFailures,
    evaluateGoNoGo,
    newestEvidenceAt,
    newestReceipt,
    QUALITY_GATE_SOURCE,
    type PendingAsk,
    type PlanCheck,
} from './plan.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** The gate `source` every record this plugin writes carries. */
export const GATE_SOURCE = 'dsh-deploy-gate'

/** Everything the tools close over. */
export interface ToolDeps {
    config: DeployGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    /** `ctx.get('approval')`, read per call. */
    approval: () => ApprovalLike | undefined
    /** `ctx.get('interaction')`, read per call. */
    interaction: () => InteractionLike | undefined
    /** `ctx.get('subprocess')`, read per run. */
    subprocess: () => unknown
    /** Plugin logger; `loggerFor(deps.logger, cwd)` routes a line to that workspace's file. */
    logger: Logger
    /** Injected sleep, so retries and canary waits are testable without waiting. */
    sleep: (ms: number) => Promise<void>
    /** Injected clock. */
    now: () => number
}

// --- optional interaction service ------------------------------------------

/** One question asked through a chat/IM channel. */
export interface InteractionAsk {
    title: string
    question: string
    options?: { value: string; label: string; description?: string }[]
    timeoutMs?: number
    agent?: unknown
    toolName?: string
    signal?: AbortSignal
}

/**
 * Structural view of the optional `interaction` service (the chat/IM hub).
 *
 * Both halves are optional and both are called defensively: a channel that
 * cannot answer, or a hub that cannot list its pending questions, must degrade
 * to "unavailable" (fail closed) rather than break a deployment verdict.
 *
 * `ask` is one accepted shape, but the suite's OWN interaction layer does not
 * provide it (it offers a channel registry: `list`/`describeAll`, `send`, `arm`,
 * `awaitAnswer`, `pending`). Both surfaces are driven here, because a documented
 * path that only exists in tests is a path that does not exist.
 */
export interface InteractionLike {
    ask?: (request: InteractionAsk) => Promise<unknown>
    pendingAsks?: () => unknown
    pending?: () => unknown
    listPending?: () => unknown
    /** Ledgers this process has observed (`pending()` reads only those). */
    ledgers?: () => unknown
    /** The channel registry surface (see `dsh-interaction-gate`). */
    list?: () => unknown
    describeAll?: () => unknown
    get?: (name: string) => unknown
    send?: (name: string, message: unknown) => Promise<unknown>
    arm?: (questionId: string) => unknown
    retire?: (questionId: string) => unknown
    awaitAnswer?: (questionId: string, timeoutMs: number, options?: unknown) => Promise<unknown>
}

/** Most asks a channel's bare count is allowed to stand for in one report. */
export const MAX_REPORTED_ASKS = 1_000

/** Values that mean "yes" when a channel answers with a word instead of a decision. */
export const ACCEPT_VALUES: readonly string[] = ['yes', 'y', 'ok', 'allow', 'approved', 'approve', 'allowed-once']

/** Values that mean "no". Everything else is `unavailable` (fail closed). */
export const REJECT_VALUES: readonly string[] = ['no', 'n', 'deny', 'denied', 'reject', 'rejected', 'cancel', 'cancelled']

/**
 * An unpredictable one-shot token for a question asked through a channel.
 *
 * The same convention `dsh-interaction-gate` uses (128 random bits, hex): never
 * derived from a clock or a counter, so an answer can only ever belong to the
 * question it claims.
 */
export function newQuestionToken(): string {
    return `q-${randomBytes(16).toString('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An approval outcome that means "nobody decided". */
function unavailableOutcome(by = '', source = 'unknown'): ApprovalOutcome {
    return { decision: 'unavailable', by, messageId: '', source, allowed: false }
}

function decisionFrom(value: unknown): ApprovalOutcome | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim().toLowerCase()
    if (ACCEPT_VALUES.includes(normalized)) return { decision: 'allowed-once', by: '', messageId: '', source: 'im', allowed: true }
    if (REJECT_VALUES.includes(normalized)) return { decision: 'rejected', by: '', messageId: '', source: 'im', allowed: false }
    return undefined
}

/**
 * Normalise whatever an interaction channel returned.
 *
 * An unreadable reply is `unavailable` (fail closed): guessing a decision out of
 * an unrecognised shape is exactly how "nobody answered" becomes "approved".
 * @param reply - the channel's return value (untrusted: it crosses a plugin seam).
 */
export function normalizeInteractionReply(reply: unknown): ApprovalOutcome {
    const direct = decisionFrom(reply)
    if (direct !== undefined) return direct
    if (typeof reply === 'object' && reply !== null) {
        const record = reply as Record<string, unknown>
        for (const key of ['decision', 'answer', 'value', 'text', 'reply']) {
            const decided = decisionFrom(record[key])
            if (decided === undefined) continue
            const by = ['by', 'user', 'userId', 'from'].map((field) => record[field]).find((value) => typeof value === 'string' && value !== '')
            const messageId = ['messageId', 'message_id', 'id'].map((field) => record[field]).find((value) => typeof value === 'string' && value !== '')
            const at = record['at'] ?? record['answeredAt']
            const source = record['source'] ?? record['channel']
            return {
                decision: decided.decision,
                by: typeof by === 'string' ? by : '',
                messageId: typeof messageId === 'string' ? messageId : '',
                ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
                source: typeof source === 'string' && source !== '' ? source : 'im',
                allowed: decided.allowed,
            }
        }
    }
    return { decision: 'unavailable', by: '', messageId: '', source: 'unknown', allowed: false }
}

/** Normalise one pending-ask entry. */
function pendingAskOf(value: unknown): PendingAsk | undefined {
    if (typeof value === 'string' && value.trim() !== '') return { title: value.trim() }
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    const title = ['title', 'question', 'summary', 'text'].map((key) => record[key]).find((entry) => typeof entry === 'string' && entry !== '')
    if (typeof title !== 'string') return undefined
    const age = record['ageMs'] ?? record['age']
    if (typeof age === 'number' && Number.isFinite(age)) return { title, ageMs: Math.max(0, age) }
    const createdAt = record['createdAt'] ?? record['askedAt']
    if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return { title, ageMs: Math.max(0, Date.now() - createdAt) }
    return { title }
}

/**
 * Whether the service has observed a ledger in THIS process.
 *
 * `pending()` (the interaction gate) is derived from the ledgers the service has
 * touched in this process, so an empty list is ambiguous: "nobody is waiting"
 * and "this process has not read that workspace's ledger yet" both produce `[]`.
 * `ledgers()` is the discriminator the interaction gate documents and
 * `dsh-suite-doctor` implements; without it there is nothing to tell them apart
 * and the empty list is kept as-is.
 * @param interaction - the service.
 * @returns `false` only when the service says it has observed NO ledger.
 */
function observedAnyLedger(interaction: InteractionLike): boolean {
    const ledgers = interaction.ledgers
    if (typeof ledgers !== 'function') return true
    try {
        const value = (ledgers as () => unknown).call(interaction)
        return !Array.isArray(value) || value.length > 0
    } catch {
        return true
    }
}

/**
 * The questions a human still has to answer.
 * @param interaction - the optional service.
 * @returns the asks, and whether they could actually be queried (an unqueried
 *   check is reported as unverified, never as verified-empty).
 */
export function pendingAsksOf(interaction: InteractionLike | undefined): { asks: PendingAsk[]; queryable: boolean } {
    if (interaction === undefined) return { asks: [], queryable: false }
    for (const method of ['pendingAsks', 'pending', 'listPending'] as const) {
        const candidate = interaction[method]
        if (typeof candidate !== 'function') continue
        let raw: unknown
        try {
            raw = (candidate as () => unknown).call(interaction)
        } catch {
            return { asks: [], queryable: false }
        }
        // A bare NUMBER is a count, not a list: materialising it (`new Array(n)`)
        // is an unbounded allocation (`pending: () => 20_000_000` killed the
        // process), and a positive count IS somebody waiting. So it becomes ONE
        // synthetic ask that says how many there are — clamped, never expanded.
        if (typeof raw === 'number') {
            if (!Number.isFinite(raw)) return { asks: [], queryable: false }
            const count = Math.max(0, Math.floor(raw))
            if (count === 0) return { asks: [], queryable: true }
            return {
                asks: [{ title: `通道只报告了数量：${count > MAX_REPORTED_ASKS ? `超过 ${MAX_REPORTED_ASKS} 个` : `${count} 个`}提问在等人回答（通道没有给出标题）` }],
                queryable: true,
            }
        }
        // Anything that is not an array (an empty object, a string, `undefined`)
        // is UNREADABLE: `{asks: []}` and "we could not read it" must never look
        // the same, or "nobody is waiting" becomes an unverified claim.
        const list = Array.isArray(raw)
            ? raw
            : typeof raw === 'object' && raw !== null
              ? ((raw as Record<string, unknown>)['asks'] ?? (raw as Record<string, unknown>)['pending'] ?? (raw as Record<string, unknown>)['items'])
              : undefined
        if (!Array.isArray(list)) return { asks: [], queryable: false }
        const asks: PendingAsk[] = []
        for (const entry of list) {
            const ask = pendingAskOf(entry)
            if (ask !== undefined) asks.push(ask)
        }
        if (asks.length === 0 && !observedAnyLedger(interaction)) return { asks: [], queryable: false }
        return { asks, queryable: true }
    }
    return { asks: [], queryable: false }
}

// --- argument plumbing ------------------------------------------------------

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

/** The workspace a tool call applies to. */
function declaredCwdOrThrow(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：部署命令会在错误的目录上执行，台账与门禁也会写到错误的项目，因此本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    return cwd
}

/** Resolve a configured path (an absolute value stays absolute). */
function pathOf(cwd: string, file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** The workspace-relative form of a path, when it is inside the workspace. */
function relativeOf(cwd: string, file: string): string | undefined {
    const relative = path.relative(cwd, file).split(path.sep).join('/')
    if (relative === '' || relative.startsWith('..')) return undefined
    return relative
}

/** The absolute path of the deployment ledger. */
export function ledgerPathOf(cwd: string, config: DeployGateConfig): string {
    return pathOf(cwd, config.ledgerFile)
}

/**
 * The workspace fingerprint a deployment binds.
 *
 * The engineering trail (`.dsh/**`) and the ledger itself are excluded: writing
 * the bookkeeping of a deployment must not make the tree look dirty, or every
 * second deploy would refuse itself.
 */
export function fingerprintOf(cwd: string, store: MissionStore, ledgerFile: string): GitFingerprint {
    const exclude: string[] = [store.layout.rootDir]
    const ledger = relativeOf(cwd, ledgerFile)
    if (ledger !== undefined) exclude.push(ledger)
    return gitFingerprint(cwd, { excludePaths: exclude })
}

/** The revision string a deployment binds (compact, human-readable). */
export function revisionOf(fingerprint: GitFingerprint): string {
    return describeFingerprint(fingerprint)
}

/**
 * A workspace-scoped logger, tolerating a logger without the scoping method.
 *
 * `Logger.for` is how a multi-repository profile keeps its log files apart; a
 * test double (and any host that ships a thinner logger) may not implement it, and
 * losing a log line must never break a deployment verdict.
 */
function loggerFor(logger: Logger, workspace: string): Logger {
    try {
        const scoped = typeof logger.for === 'function' ? logger.for(workspace) : undefined
        return scoped ?? logger
    } catch {
        return logger
    }
}

/** Who is deploying (the session is the identity the suite records everywhere). */
function deployerOf(agent: AgentLike | undefined): string {
    return sessionIdOf(agent) ?? agentIdOf(agent) ?? 'unknown'
}

/**
 * Resolve the mission, or refuse an id that does not exist.
 *
 * An explicit `missionId` that cannot be read is always a refusal: silently
 * planning/recording against nothing is how a deployment ends up belonging to
 * nobody. Without an explicit id the session binding decides, and `undefined` is
 * a legitimate answer — the tools then keep the ledger row and record NO gate
 * (they never fabricate a mission id to have somewhere to write).
 */
function resolveMission(store: MissionStore, agent: AgentLike | undefined, explicitId: string | undefined): MissionRecord | undefined {
    const wanted = typeof explicitId === 'string' ? explicitId.trim() : ''
    if (wanted !== '') {
        const explicit = store.read(wanted)
        if (explicit === undefined) {
            const known = store.list().map((mission) => mission.id)
            throw new Error(
                `未知 mission "${wanted}"：按 fail closed 拒绝（否则这次部署会静默地不属于任何一次交付，也没有地方记录它的结果）。` +
                    `可用 mission：${known.join(', ') || '(无)'}。`,
            )
        }
        return explicit
    }
    return store.resolveForAgent(agent, {})
}

/** The line every report carries when it recorded a ledger row but no gate. */
function missionNote(mission: MissionRecord | undefined): string {
    return mission === undefined ? '无 mission：仅记台账，未写门禁记录（不会为一个不存在的交付编造 mission id）。' : `mission：${mission.id}`
}

/** Resolve the environment, or refuse naming what IS declared. */
function environmentOrThrow(config: DeployGateConfig, name: string | undefined): EnvironmentConfig {
    const found = environmentByName(config, name ?? '')
    if ('error' in found) throw new Error(found.error)
    return found.environment
}

// --- plan rendering ---------------------------------------------------------

/** The placeholder values one deployment uses. */
function templateVars(cwd: string, environment: EnvironmentConfig, revision: string, target: string): TemplateVars {
    return { workspace: cwd, environment: environment.name, revision, target }
}

/**
 * The checks that can only be made once the commands are tokenised.
 *
 * A command with a shell metacharacter is not a command this plugin will ever
 * run, so "the environment is deployable" is false — and the plan must say so
 * BEFORE anything executes, not halfway through a rollout.
 */
export function commandChecks(environment: EnvironmentConfig, vars: TemplateVars): PlanCheck[] {
    const checks: PlanCheck[] = []
    const group = (id: string, label: string, commands: readonly string[]): void => {
        if (commands.length === 0) return
        const resolved = resolveCommands(commands, vars)
        const refused = resolved.filter((entry) => 'error' in entry) as { template: string; error: string }[]
        checks.push({
            id,
            ok: refused.length === 0,
            label,
            detail:
                refused.length === 0
                    ? `${commands.length} 条命令都可以 argv 直传（无 shell 元字符、无未知占位符）`
                    : `${refused.length}/${commands.length} 条命令会被拒绝：${refused.map((entry) => `\`${entry.template}\` → ${entry.error}`).join('；')}`,
            fix: '把管道/重定向/变量展开写进脚本文件，再以 argv 调用解释器（例如 `bash scripts/deploy.sh`）',
        })
    }
    group('commands-deploy-usable', '部署命令可以被 argv 直传（无 shell 元字符）', environment.deployCommands)
    group('commands-verify-usable', '验证命令可以被 argv 直传（无 shell 元字符）', environment.verifyCommands ?? [])
    group('commands-rollback-usable', '回滚命令可以被 argv 直传（无 shell 元字符）', environment.rollbackCommands ?? [])
    if (environment.canary !== undefined) {
        const canaryCommands = environment.canary.steps.flatMap((step) => [step.command, ...(step.verifyCommands ?? [])])
        group('commands-canary-usable', 'canary 步骤命令可以被 argv 直传（无 shell 元字符）', canaryCommands)
    }
    return checks
}

/** Render one check as a report line (plus its fix on a separate line). */
function renderCheck(check: PlanCheck): string[] {
    const mark = check.ok ? (check.unverified === true ? '⚠️' : '✅') : '⛔'
    const lines = [`  ${mark} ${check.label}`, `     ${check.detail}`]
    if (!check.ok && check.fix !== undefined) lines.push(`     下一步：${check.fix}`)
    if (check.ok && check.unverified === true) lines.push('     （本项未实际核对，不计为已验证）')
    return lines
}

/** Render a configured command list, with the argv it would become. */
function renderCommands(title: string, commands: readonly string[], vars: TemplateVars): string[] {
    if (commands.length === 0) return [`${title}：(未声明)`]
    const lines = [`${title}（来自配置，未经模型改写）：`]
    resolveCommands(commands, vars).forEach((entry, index) => {
        if ('error' in entry) lines.push(`  ${index + 1}. ⛔ \`${entry.template}\` — 会被拒绝：${entry.error}`)
        else lines.push(`  ${index + 1}. \`${entry.template}\` → argv: ${JSON.stringify(entry.argv)}`)
    })
    return lines
}

/** Everything a plan section renders. */
interface PlanRenderInput {
    config: DeployGateConfig
    source: string
    environment: EnvironmentConfig
    checks: readonly PlanCheck[]
    fingerprint: GitFingerprint
    mission?: MissionRecord
    receipt?: Receipt
    gate?: GateRecord
    ledgerFile: string
    vars: TemplateVars
}

/** Render the plan/verdict block shared by `deploy_plan`, `deploy_run` and `deploy_rollback`. */
function renderPlan(input: PlanRenderInput): string[] {
    const { config, environment, checks, fingerprint, mission, receipt, gate } = input
    const failures = checks.filter((check) => !check.ok)
    const lines: string[] = []
    lines.push(`## 部署计划：${environment.name}（kind=${environment.kind}；配置来源：${input.source}）`)
    lines.push('')
    lines.push(`${failures.length === 0 ? '✅ 裁决：可以部署（go/no-go 全部通过）' : `⛔ 裁决：不可部署（${failures.length}/${checks.length} 项未通过）`}`)
    lines.push(`revision：${revisionOf(fingerprint)}`)
    lines.push(
        `mission：${mission === undefined ? '(无——这次部署没有归属)' : `${mission.id}（${mission.status}）`}`,
    )
    lines.push(
        `回执：${
            receipt === undefined
                ? '(无)'
                : `${receipt.id} @ ${formatTime(receipt.issuedAt)}（依赖门禁 ${receipt.gateId}）`
        }`,
    )
    lines.push(
        `质量门禁：${
            gate === undefined
                ? `(无 source=${QUALITY_GATE_SOURCE} 的记录)`
                : `${gate.id} ${gate.state} @ ${formatTime(gate.checkedAt)}（${gate.results.length} 条命令）`
        }`,
    )
    lines.push('')
    lines.push(`检查（${checks.length} 项${failures.length === 0 ? '' : `，${failures.length} 项未通过`}）：`)
    for (const check of checks) lines.push(...renderCheck(check))
    lines.push('')
    for (const line of renderCommands('将要执行的部署命令', environment.deployCommands, input.vars)) lines.push(line)
    if (environment.canary !== undefined) {
        lines.push(`canary 放量（${environment.canary.steps.length} 步，按顺序执行）：`)
        environment.canary.steps.forEach((step, index) => {
            lines.push(`  ${index + 1}. ${step.percent}% → \`${step.command}\`，等待 ${step.waitMs}ms${(step.verifyCommands?.length ?? 0) === 0 ? '' : `，随后验证 ${step.verifyCommands?.map((command) => `\`${command}\``).join('、')}`}`)
        })
    }
    lines.push('')
    const verify = environment.verifyCommands ?? []
    lines.push(
        `部署后验证（deploy_verify：最多 ${config.verifyRetries} 次尝试，间隔 ${config.verifyBackoffMs}ms）：`,
    )
    for (const line of renderCommands('  验证命令', verify, input.vars).slice(1)) lines.push(line)
    if (verify.length === 0) lines.push('  ⛔ (未声明)——部署完不看结果的部署不会被本插件判为"可以上"')
    lines.push('')
    lines.push('回滚路径（deploy_rollback）：')
    for (const line of renderCommands('  回滚命令', environment.rollbackCommands ?? [], input.vars).slice(1)) lines.push(line)
    if ((environment.rollbackCommands?.length ?? 0) === 0) lines.push('  ⛔ (未声明)——未演练的回滚不是回滚')
    lines.push('')
    lines.push(
        `审批：${environment.requiresApproval ? `需要人工批准${environment.approversFile === undefined ? '' : `（按名单 ${environment.approversFile} 核对审批人身份）`}` : '无需人工批准（该环境显式声明了 requiresApproval=false）'}`,
    )
    lines.push(`部署台账：${input.ledgerFile}`)
    lines.push(`自动回滚：${config.autoRollbackOnFailure ? '已开启（命令失败/验证失败后执行环境声明的回滚命令）' : '未开启（automatic rollback 关闭）'}`)
    return lines
}

// --- execution --------------------------------------------------------------

/** One configured command that actually ran. */
interface SequenceRun {
    id: string
    template: string
    argv: string[]
    outcome: RunOutcome
    /** Bounded stdout+stderr for the report and the gate record. */
    output: string
}

/** The outcome of running one command sequence. */
interface SequenceResult {
    runs: SequenceRun[]
    /** The command that stopped the sequence (`undefined` = every command passed). */
    failed?: SequenceRun
    /** A command that could not be tokenised — it was never executed. */
    refused?: { template: string; error: string }
}

/** Combined, bounded output of one run. */
function combinedOutput(outcome: RunOutcome, limit: number): string {
    const text = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n--- stderr ---\n')
    const spawn = outcome.spawnError === undefined ? '' : `\n[spawn error] ${outcome.spawnError}`
    const timeout = outcome.timedOut ? `\n[timeout] 命令在 ${outcome.durationMs}ms 后被终止` : ''
    return `${tail(text, limit)}${spawn}${timeout}`.trim()
}

/**
 * Execute a configured command sequence in order, stopping at the first failure.
 *
 * Tokenisation happens per command as it is about to run, so a refusal can never
 * leave a half-executed sequence behind: the refusal of a LATER command is
 * caught by {@link commandChecks} before the first one starts.
 */
async function runSequence(
    commands: readonly string[],
    options: {
        kind: 'deploy' | 'verify' | 'rollback' | 'canary'
        /**
         * Prefix of every result id in this call. Defaults to `kind`, so a
         * single-call sequence keeps its readable ids — but a caller that runs
         * several sequences inside one tool call (canary steps, verify attempts)
         * MUST pass a distinct one: the counter restarts per call, and duplicate
         * ids make "which command produced this" unanswerable in the gate record.
         */
        idPrefix?: string
        vars: TemplateVars
        cwd: string
        timeoutMs: number
        maxOutputBytes: number
        signal?: AbortSignal
        subprocess: unknown
        logger: Logger
    },
): Promise<SequenceResult> {
    const prefix = options.idPrefix ?? options.kind
    const runs: SequenceRun[] = []
    for (const [index, template] of commands.entries()) {
        const resolved = resolveCommands([template], options.vars)[0]
        if (resolved === undefined || 'error' in resolved) {
            return {
                runs,
                ...(resolved === undefined ? {} : { refused: { template, error: resolved.error } }),
            }
        }
        const outcome = await runCommand(
            {
                argv: resolved.argv,
                cwd: options.cwd,
                timeoutMs: options.timeoutMs,
                maxOutputBytes: options.maxOutputBytes,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            options.subprocess as SubprocessLike | undefined,
        )
        const run: SequenceRun = {
            id: `${prefix}-${index + 1}`,
            template,
            argv: resolved.argv,
            outcome,
            output: combinedOutput(outcome, 4_000),
        }
        runs.push(run)
        options.logger.info(
            `${options.kind}[${index + 1}/${commands.length}] ${resolved.argv.join(' ')} → exit=${outcome.exitCode ?? 'null'}${
                outcome.timedOut ? ' (timed out)' : ''
            }${outcome.spawnError === undefined ? '' : ` (spawn error: ${outcome.spawnError})`}`,
        )
        if (outcome.exitCode !== 0) return { runs, failed: run }
    }
    return { runs }
}

/** Build the gate-check results of one sequence (also the artifact the audit reads). */
function gateResultsOf(runs: readonly SequenceRun[]): GateCommandResult[] {
    return runs.map((run) => ({
        id: run.id,
        name: run.template,
        command: run.template,
        required: true,
        exitCode: run.outcome.exitCode,
        signal: run.outcome.signal,
        durationMs: run.outcome.durationMs,
        timedOut: run.outcome.timedOut,
        output: run.output,
        outputDigest: outputDigestOf(run.outcome.stdout, run.outcome.stderr),
    }))
}

/** Render the executed commands of one sequence. */
function renderRuns(title: string, runs: readonly SequenceRun[], failed: SequenceRun | undefined): string[] {
    const lines = [title]
    for (const run of runs) {
        const mark = run.outcome.exitCode === 0 ? '✅' : '⛔'
        lines.push(
            `  ${mark} \`${run.argv.join(' ')}\`（退出码 ${run.outcome.exitCode ?? 'null'}${run.outcome.timedOut ? '，超时被终止' : ''}，${run.outcome.durationMs}ms）`,
        )
        if (run === failed) {
            lines.push('     输出尾部：')
            for (const line of run.output.split('\n').slice(-12)) lines.push(`       ${line}`)
        }
    }
    return lines
}

// --- approval ---------------------------------------------------------------

/** What an approval attempt produced. */
interface ApprovalAttempt {
    kind: 'allowed' | 'denied' | 'no-channel'
    outcome?: ApprovalOutcome
    /** The reason to show when nothing was approved. */
    reason: string
}

/**
 * Whether an approver identity is on the environment's allowlist.
 *
 * Fail-closed in all four directions: a missing file, an empty list, an
 * anonymous decision and an unlisted person all refuse. A list that silently
 * approves when it cannot be read is worse than no list at all.
 */
export function approverAllowed(cwd: string, file: string, who: string): { ok: true } | { ok: false; reason: string } {
    const target = pathOf(cwd, file)
    const text = readText(target)
    if (text === undefined) {
        return { ok: false, reason: `环境声明了审批人名单（${file}），但 ${target} 不存在或读不到：名单不在，就无法确认谁有权批准（fail closed）。` }
    }
    const list = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    if (list.length === 0) {
        return { ok: false, reason: `审批人名单 ${file} 是空的：空名单批准任何人等于没有名单（fail closed）。` }
    }
    if (who.trim() === '') {
        return { ok: false, reason: `审批通道没有给出审批人身份（by 为空），而本环境要求按名单 ${file} 核对：无法确认是谁批准的（fail closed）。` }
    }
    const normalize = (value: string): string => value.trim().toLowerCase()
    const matches = list.some((entry) => {
        const candidate = normalize(entry)
        const actual = normalize(who)
        return actual === candidate || actual.endsWith(`:${candidate}`) || candidate.endsWith(`:${actual}`)
    })
    if (!matches) {
        return { ok: false, reason: `审批人 "${who}" 不在名单 ${file} 里（名单：${list.join(', ')}）：拒绝执行。` }
    }
    return { ok: true }
}

/** Ask a human, through the interaction service when one is mounted, else the approval seam. */
async function askHuman(input: {
    deps: ToolDeps
    agent: AgentLike | undefined
    toolName: 'deploy_run' | 'deploy_rollback'
    action: 'deploy' | 'rollback'
    environment: EnvironmentConfig
    cwd: string
    missionId: string
    revision: string
    commands: readonly string[]
    signal?: AbortSignal
}): Promise<ApprovalAttempt> {
    const { deps, environment } = input
    // Host-only ceiling: a deadline is a refusal, and a repository may not extend
    // how long a deploy turn hangs on a person.
    const timeoutMs = deps.config.approvalTimeoutMs
    const prose = [
        input.action === 'deploy'
            ? `部署审批：把 ${input.revision} 部署到环境 "${environment.name}"（kind=${environment.kind}）。`
            : `回滚审批：把环境 "${environment.name}"（kind=${environment.kind}）回滚到 ${input.revision}。`,
        '',
        `mission：${input.missionId}`,
        `将要执行的命令（${input.commands.length} 条，来自宿主配置）：`,
        ...input.commands.map((command, index) => `  ${index + 1}. ${command}`),
        environment.rollbackCommands === undefined
            ? ''
            : `声明的回滚路径：${describeCommands(environment.rollbackCommands)}`,
        '',
        `批准后这些命令会立即在 ${input.cwd} 上执行。拒绝则什么都不做。`,
    ]
        .filter((line) => line !== '')
        .join('\n')
    const reason = renderApprovalContext(prose, {
        kind: input.action === 'deploy' ? 'deploy' : 'rollback',
        missionId: input.missionId,
        revision: input.revision,
        risk: environment.kind === 'production' ? 'high' : 'medium',
        facts: {
            环境: environment.name,
            类型: environment.kind,
            命令数: input.commands.length,
            回滚命令数: environment.rollbackCommands?.length ?? 0,
        },
        channelHints: { buttons: ['yes', 'no'] },
    })
    const finish = (outcome: ApprovalOutcome): ApprovalAttempt => {
        if (!outcome.allowed) {
            const why =
                outcome.decision === 'rejected'
                    ? '人工审批被拒绝'
                    : outcome.decision === 'cancelled'
                      ? '人工审批被取消'
                      : '没有可用的审批决定（unavailable）'
            return {
                kind: 'denied',
                outcome,
                reason: `${why}${outcome.by === '' ? '' : `（by ${outcome.by}）`}：本次不执行任何命令。`,
            }
        }
        if (environment.approversFile !== undefined) {
            const verdict = approverAllowed(input.cwd, environment.approversFile, outcome.by)
            if (!verdict.ok) return { kind: 'denied', outcome, reason: verdict.reason }
        }
        return { kind: 'allowed', outcome, reason: '' }
    }
    const titleOf = (): string => (input.action === 'deploy' ? `部署到 ${environment.name}` : `回滚 ${environment.name}`)

    /**
     * Ask through the channel registry the interaction layer actually provides.
     *
     * The answer is mapped through the SAME normaliser as the `ask()` path and
     * then through {@link finish}, so the approver list is enforced identically.
     * @returns the attempt, or `undefined` when the service exposes no registry.
     */
    const askThroughChannels = async (service: InteractionLike): Promise<ApprovalAttempt | undefined> => {
        const list = service.list ?? service.describeAll
        if (list === undefined) return undefined
        if (typeof service.arm !== 'function' || typeof service.send !== 'function' || typeof service.awaitAnswer !== 'function') {
            return {
                kind: 'no-channel',
                reason:
                    'interaction 服务暴露了通道列表，却没有提供提问所需的 arm/send/awaitAnswer：无法把卡片发出去并等一个对得上令牌的答案（fail closed）。' +
                    '下一步：升级/修正该 interaction 服务（`dsh-interaction-gate` 提供 register/send/arm/awaitAnswer），或让宿主装配审批通道。',
            }
        }
        let raw: unknown
        try {
            raw = list.call(service)
        } catch (error) {
            return {
                kind: 'no-channel',
                reason: `interaction 服务列出通道时抛错（${error instanceof Error ? error.message : String(error)}）：无法知道有哪些通道，按 fail closed 拒绝。`,
            }
        }
        const channels = (Array.isArray(raw) ? raw : []).filter(isRecord)
        const usable = channels.filter((entry) => entry['canAsk'] === true && typeof entry['name'] === 'string' && entry['name'] !== '')
        if (usable.length === 0) {
            return {
                kind: 'no-channel',
                reason: [
                    `interaction 服务注册了 ${channels.length} 个通道，但没有一个能提问（canAsk=false）：通道必须实现 wait() 才收得到答案。`,
                    ...(channels.length === 0
                        ? ['（一个通道都没有注册：让宿主/IM 插件向 interaction 服务注册一个通道）']
                        : channels.map((entry) => `  - ${String(entry['name'] ?? '(无名)')}：canAsk=false${typeof entry['reason'] === 'string' && entry['reason'] !== '' ? `（${entry['reason']}）` : ''}`)),
                    '下一步（任选其一）：让该通道实现 wait()（收不到答案的通道不能用来批准部署）；换一个能提问的通道；或由人把该环境的 requiresApproval 设为 false（宿主的决定，模型改不了 `.dsh/**` 里的配置）。',
                ].join('\n'),
            }
        }
        const failures: string[] = []
        for (const candidate of usable) {
            const name = candidate['name'] as string
            const questionId = newQuestionToken()
            let armed: unknown = false
            try {
                armed = (service.arm as (id: string) => unknown).call(service, questionId)
            } catch (error) {
                failures.push(`- ${name}：arm() 抛错（${error instanceof Error ? error.message : String(error)}）`)
                continue
            }
            if (armed !== true) {
                failures.push(`- ${name}：一次性令牌无法登记（arm() 返回 ${JSON.stringify(armed)}）`)
                continue
            }
            let sent: unknown
            try {
                sent = await (service.send as (channel: string, message: unknown) => Promise<unknown>).call(service, name, {
                    kind: 'ask',
                    title: titleOf(),
                    body: reason,
                    questionId,
                    buttons: [
                        { value: 'yes', label: input.action === 'deploy' ? '批准部署' : '批准回滚' },
                        { value: 'no', label: '拒绝' },
                    ],
                })
            } catch (error) {
                sent = { ok: false, error: error instanceof Error ? error.message : String(error) }
            }
            if (!isRecord(sent) || sent['ok'] !== true) {
                if (typeof service.retire === 'function') (service.retire as (id: string) => void).call(service, questionId)
                failures.push(`- ${name}：卡片发不出去（${isRecord(sent) && typeof sent['error'] === 'string' ? sent['error'] : '通道未说明原因'}）`)
                continue
            }
            const implementation = typeof service.get === 'function' ? service.get(name) : undefined
            const wait =
                isRecord(implementation) && typeof implementation['wait'] === 'function'
                    ? (implementation['wait'] as (id: string, ms: number, signal?: AbortSignal) => Promise<unknown>).bind(implementation)
                    : undefined
            let awaited: unknown
            try {
                awaited = await (service.awaitAnswer as (id: string, ms: number, options?: unknown) => Promise<unknown>).call(service, questionId, timeoutMs, {
                    ...(wait === undefined ? {} : { wait }),
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                })
            } catch (error) {
                awaited = { outcome: 'unreadable', error: error instanceof Error ? error.message : String(error) }
            }
            const outcome = isRecord(awaited) && typeof awaited['outcome'] === 'string' ? awaited['outcome'] : 'unreadable'
            if (outcome === 'answered') {
                const answer = isRecord(awaited) ? awaited['answer'] : undefined
                if (!isRecord(answer) || typeof answer['value'] !== 'string') {
                    return {
                        kind: 'denied',
                        outcome: unavailableOutcome('', name),
                        reason: `通道 "${name}" 报告已回答，但答案读不出来（没有 value）：按"没有决定"处理（fail closed），本次不执行任何命令。`,
                    }
                }
                return finish(
                    normalizeInteractionReply({
                        value: answer['value'],
                        ...(typeof answer['by'] === 'string' ? { by: answer['by'] } : {}),
                        ...(typeof answer['messageId'] === 'string' ? { messageId: answer['messageId'] } : {}),
                        source: name,
                    }),
                )
            }
            if (outcome === 'timeout') {
                return {
                    kind: 'denied',
                    outcome: unavailableOutcome('', name),
                    reason:
                        `等待人工批准的截止时间（${timeoutMs}ms，配置 approvalTimeoutMs）到了：通道 "${name}" 没有在期限内给出答案。` +
                        '超时**不是**拒绝、也**不是**同意——没有人作出决定，本次不执行任何命令。',
                }
            }
            if (outcome === 'cancelled') {
                return { kind: 'denied', outcome: { decision: 'cancelled', by: '', messageId: '', source: name, allowed: false }, reason: `等待人工批准被取消（通道 "${name}" 或调用方中止）：没有人作出决定，本次不执行任何命令。` }
            }
            failures.push(
                `- ${name}：${outcome === 'unknown-token' ? '一次性令牌在等待期间失效（同一令牌只能被回答一次）' : `等待结果读不出来（outcome=${outcome}）`}`,
            )
        }
        return {
            kind: 'no-channel',
            reason: [`interaction 服务的通道都没能完成这次提问（${failures.length} 个）：`, ...failures].join('\n'),
        }
    }

    const interaction = deps.interaction()
    if (interaction !== undefined && typeof interaction.ask === 'function') {
        try {
            const reply = await interaction.ask({
                title: titleOf(),
                question: reason,
                options: [
                    { value: 'yes', label: input.action === 'deploy' ? '批准部署' : '批准回滚' },
                    { value: 'no', label: '拒绝' },
                ],
                ...(input.agent === undefined ? {} : { agent: input.agent }),
                toolName: input.toolName,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
            return finish(normalizeInteractionReply(reply))
        } catch (error) {
            return {
                kind: 'no-channel',
                reason: `interaction 服务存在，但提问失败（${error instanceof Error ? error.message : String(error)}）：没有人作出决定，按 fail closed 拒绝。`,
            }
        }
    }

    // The suite's own interaction layer provides a CHANNEL REGISTRY, not `ask()`.
    // Driving it is the difference between a documented path and a path that
    // only works in tests: pick a channel that can ask, arm a fresh one-shot
    // token, send the card, and wait for the answer on that token.
    let registryRefusal: string | undefined
    if (interaction !== undefined && (typeof interaction.list === 'function' || typeof interaction.describeAll === 'function')) {
        const driven = await askThroughChannels(interaction)
        if (driven !== undefined) {
            if (driven.kind !== 'no-channel' || deps.approval() === undefined) return driven
            // No usable channel, but the host may still have the approval seam:
            // report both when neither can produce a decision.
            registryRefusal = driven.reason
        }
    }

    const seam = deps.approval()
    if (seam === undefined) {
        return {
            kind: 'no-channel',
            reason: [
                `环境 "${environment.name}"（kind=${environment.kind}）需要人工批准，但宿主既没有装配可用的 interaction 服务，也没有审批通道（ctx.approval）：没有人可以批准，按 fail closed 拒绝。`,
                ...(registryRefusal === undefined ? [] : ['interaction 服务的情况：', registryRefusal]),
                '下一步（任选其一）：让宿主装配审批插件或交互通道（IM 通道必须实现 wait() 才能收到答案）；或由人把该环境的 requiresApproval 设为 false（这是宿主的决定，模型改不了 `.dsh/**` 里的配置）。',
            ].join('\n'),
        }
    }
    try {
        const reply = await seam.request({
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            toolName: input.toolName,
            reason,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        return finish(normalizeApprovalReply(reply))
    } catch (error) {
        return {
            kind: 'no-channel',
            reason: `审批通道调用失败（${error instanceof Error ? error.message : String(error)}）：没有人作出决定，按 fail closed 拒绝。`,
        }
    }
}

/** Render the denial block for a report (always ending with a next step). */
function renderDenial(attempt: ApprovalAttempt, action: string, recorded?: string): string[] {
    return [
        `### 未${action}`,
        '',
        attempt.reason,
        ...(attempt.outcome === undefined || attempt.outcome.by === ''
            ? []
            : [`（审批人：${attempt.outcome.by}${attempt.outcome.source === '' ? '' : ` via ${attempt.outcome.source}`}${attempt.outcome.messageId === '' ? '' : `，消息 ${attempt.outcome.messageId}`}）`]),
        '',
        ...(recorded === undefined ? [] : [recorded, '']),
        '下一步：与审批人确认后重试；或在配置里把该环境的 requiresApproval 设为 false（宿主的决定）——不要绕过本工具直接手动执行命令，那样这次上线不会进台账。',
    ]
}

// --- recording --------------------------------------------------------------

/** Record a gate when a mission is given (`undefined` only for read-only tools). */
function recordGate(
    store: MissionStore,
    mission: MissionRecord | undefined,
    input: { state: GateState; reason: string; results: GateCommandResult[]; scope: GateScope; fingerprint: GitFingerprint },
): GateRecord | undefined {
    if (mission === undefined) return undefined
    return store.recordGate(mission.id, {
        source: GATE_SOURCE,
        state: input.state,
        reason: input.reason,
        results: input.results,
        scope: input.scope,
        fingerprint: input.fingerprint,
    })
}

/** Append one ledger row with a collision-free id derived from the current ledger. */
function recordLedgerRow(
    file: string,
    row: Omit<LedgerRow, 'id'>,
): LedgerRow {
    const existing = readLedger(file)
    const id = deploymentId(row.at, row.environment, row.revision, existing.rows.length + 1)
    const complete: LedgerRow = { id, ...row }
    appendLedgerRow(file, complete)
    return complete
}

/** One-line description of a ledger row for a report. */
function describeRow(row: LedgerRow): string {
    return `${row.id} ${row.state} @ ${formatTime(row.at)}（${row.revision}${row.approvedBy === undefined ? '' : `，审批 ${row.approvedBy}`}${row.gateId === undefined ? '' : `，门禁 ${row.gateId}`}）`
}

/** One-line summary of what a sequence did, for a partial-success report. */
function summarizeRuns(runs: readonly SequenceRun[]): string {
    if (runs.length === 0) return '(没有命令执行)'
    return runs.map((run) => `${run.id} \`${run.argv.join(' ')}\` exit=${run.outcome.exitCode ?? 'null'}${run.outcome.timedOut ? '(超时)' : ''}`).join('；')
}

/**
 * Everything an executed attempt records: the gate, then its ledger row.
 *
 * The gate goes first because the row carries its id (the row → gate link an
 * audit reads). The row write is therefore GUARDED: if it fails, a BLOCK is
 * recorded immediately, so the newest record of this source is never a PASS
 * whose ledger row does not exist — and the caller reports the partial success
 * instead of a bare filesystem error. An unwritable ledger is normally caught
 * BEFORE anything runs ({@link ledgerWritable}); this is the belt for a race
 * (the path turns into a directory, the disk fills up) after the commands ran.
 */
interface ExecutionRecording {
    gate?: GateRecord
    /** Present when the row landed. */
    row?: LedgerRow
    /** Present when the row could not be written (the commands HAD run). */
    ledgerProblem?: string
    /** The BLOCK recorded in place of the missing row. */
    blockGate?: GateRecord
}

function recordExecution(input: {
    store: MissionStore
    mission: MissionRecord | undefined
    ledgerFile: string
    environment: EnvironmentConfig
    revision: string
    deployer: string
    now: number
    state: GateState
    reason: string
    results: GateCommandResult[]
    scope: GateScope
    fingerprint: GitFingerprint
    row: Omit<LedgerRow, 'id' | 'gateId'>
}): ExecutionRecording {
    const gate = recordGate(input.store, input.mission, {
        state: input.state,
        reason: input.reason,
        results: input.results,
        scope: input.scope,
        fingerprint: input.fingerprint,
    })
    try {
        const row = recordLedgerRow(input.ledgerFile, {
            ...input.row,
            ...(gate === undefined ? {} : { gateId: gate.id }),
        })
        return { ...(gate === undefined ? {} : { gate }), row }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const blockGate = recordGate(input.store, input.mission, {
            state: 'BLOCK',
            reason: `台账行写不进去（${reason}）：${input.reason}——这次动作没有可对账的台账行，按未记录处理`,
            results: input.results,
            scope: input.scope,
            fingerprint: input.fingerprint,
        })
        return { ...(gate === undefined ? {} : { gate }), ...(blockGate === undefined ? {} : { blockGate }), ledgerProblem: reason }
    }
}

/** The error for "the commands ran, but their ledger row could not be written". */
function ledgerRowFailure(input: {
    action: string
    environment: EnvironmentConfig
    ledgerFile: string
    reason: string
    outcomeLine: string
    runs: readonly SequenceRun[]
    blockGate?: GateRecord
}): Error {
    return new Error(
        [
            `${input.action}的命令**已经执行完了**（${input.outcomeLine}），但部署台账行写不进去：${input.reason}`,
            `- 台账：${input.ledgerFile}`,
            `- 已执行：${summarizeRuns(input.runs)}`,
            input.blockGate === undefined
                ? '- ⚠️ 没有 mission：这次动作连门禁记录都没有，台账是它唯一的痕迹，而它没写进去。'
                : `- 已记录：门禁 ${input.blockGate.id}（BLOCK）——最新一条 dsh-deploy-gate 记录是 BLOCK，不是 PASS：一条没有台账行的 PASS 会给下一次上线背书，所以它必须被覆盖。`,
            '下一步：修好台账路径（它必须是可写的文件，而不是目录/只读文件/满盘的挂载点）后重新执行——命令会再跑一遍，' +
                `请先用 deploy_status 确认环境当前的真实状态（它读的也是台账）。`,
        ].join('\n'),
    )
}

/** The error for "refused before anything ran, because the ledger cannot be written". */
function ledgerPreflightFailure(input: {
    action: string
    environment: EnvironmentConfig
    ledgerFile: string
    reason: string
    blockGate?: GateRecord
}): Error {
    return new Error(
        [
            `${input.action}未执行：部署台账不可写（${input.reason}）：${input.ledgerFile}`,
            `环境 "${input.environment.name}"（kind=${input.environment.kind}）未被触碰。`,
            input.blockGate === undefined
                ? '- ⚠️ 这次尝试连门禁记录都写不了（没有 mission 时本来也不写门禁），台账是它唯一的痕迹。'
                : `- 已记录：门禁 ${input.blockGate.id}（BLOCK）。`,
            '说明：没有台账行就没有这次动作的记录（谁批的、上了哪个 revision 都无处可查），所以本插件在执行**任何命令之前**拒绝。',
            '下一步：让台账路径可写（目录存在、进程有写权限、路径指向文件而不是目录），然后重新执行。',
        ].join('\n'),
    )
}

/**
 * The gate results of a refusal: one synthetic, failing "result" per blocked check.
 *
 * A refusal must be VISIBLE to whatever reads the newest `dsh-deploy-gate`
 * record — an orchestrator stage that gates on `deploy-go` must see the BLOCK,
 * not the previous PASS. Recording nothing would let a stale PASS authorise the
 * next attempt.
 */
function refusalResults(failures: readonly PlanCheck[]): GateCommandResult[] {
    return failures.map((check) => {
        const output = `${check.detail}${check.fix === undefined ? '' : `\n下一步：${check.fix}`}`
        return {
            id: `check:${check.id}`,
            name: check.label,
            command: '(未执行：go/no-go 未通过)',
            required: true,
            exitCode: 1,
            signal: null,
            durationMs: 0,
            timedOut: false,
            output,
            outputDigest: outputDigestOf(output, ''),
        }
    })
}

/** Everything a refused attempt records (gate when possible, ledger row always). */
interface RefusalRecording {
    gate?: GateRecord
    row: LedgerRow
}

/**
 * Record an attempt that never touched the environment.
 *
 * Both records are written on purpose: the gate is what an orchestrator gates
 * on, and the ledger row is what a human reads later ("we tried, it was stopped,
 * here is why"). Neither pretends anything ran.
 */
function recordRefusal(input: {
    store: MissionStore
    mission: MissionRecord | undefined
    ledgerFile: string
    environment: EnvironmentConfig
    revision: string
    deployer: string
    now: number
    reason: string
    note: string
    failures?: readonly PlanCheck[]
    fingerprint: GitFingerprint
    approvalMessageId?: string
    approvedBy?: string
}): RefusalRecording {
    const gate = recordGate(input.store, input.mission, {
        state: 'BLOCK',
        reason: input.reason,
        results: refusalResults(input.failures ?? []),
        scope: { selected: [], total: Math.max(1, input.failures?.length ?? 0), full: false },
        fingerprint: input.fingerprint,
    })
    const row = recordLedgerRow(input.ledgerFile, {
        at: input.now,
        environment: input.environment.name,
        revision: input.revision,
        deployer: input.deployer,
        state: 'refused',
        note: input.note,
        ...(gate === undefined ? {} : { gateId: gate.id }),
        ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
        ...(input.approvalMessageId === undefined ? {} : { approvalMessageId: input.approvalMessageId }),
    })
    return { ...(gate === undefined ? {} : { gate }), row }
}

// --- tools ------------------------------------------------------------------

/** Arguments of `deploy_plan`. */
interface PlanArgs {
    environment?: string
    missionId?: string
}

/** Arguments of `deploy_run`. */
interface RunArgs {
    environment?: string
    missionId?: string
    dryRun?: boolean
}

/** Arguments of `deploy_verify`. */
interface VerifyArgs {
    environment?: string
    missionId?: string
}

/** Arguments of `deploy_rollback`. */
interface RollbackArgs {
    environment?: string
    missionId?: string
    to?: string
    note?: string
}

/** Arguments of `deploy_status`. */
interface StatusArgs {
    environment?: string
    missionId?: string
}

/** Register the five deploy-gate tools. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, toolName: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(toolName)
        } catch {
            failed.push(toolName)
        }
    }

    /** Shared context resolution + go/no-go evaluation for one call. */
    const prepare = (exec: unknown, environmentName: string | undefined) => {
        const agent = agentOf(exec)
        const cwd = declaredCwdOrThrow(agent)
        const effective = deps.configFor(agent)
        const config = effective.config
        if (!config.enabled) throw new Error('dsh-deploy-gate 已被宿主禁用（enabled=false）：部署门禁未生效，本工具拒绝执行。')
        const environment = environmentOrThrow(config, environmentName)
        const store = deps.stores.for(cwd)
        const ledgerFile = ledgerPathOf(cwd, config)
        const fingerprint = fingerprintOf(cwd, store, ledgerFile)
        const revision = revisionOf(fingerprint)
        // `{revision}` is a VALUE for a command, not prose: a non-git workspace
        // has no revision to pass, and handing a script "not a git repository"
        // would be worse than handing it nothing.
        const vars = templateVars(cwd, environment, fingerprint.isRepo ? (fingerprint.head ?? 'HEAD') : '', '')
        return { agent, cwd, effective, config, environment, store, ledgerFile, fingerprint, revision, vars, source: describeSource(effective) }
    }

    /** The full check list: the pure verdict plus the command-usability checks. */
    const checksFor = (
        context: ReturnType<typeof prepare>,
        mission: MissionRecord | undefined,
        vars: TemplateVars,
    ): { checks: PlanCheck[]; ok: boolean; failures: PlanCheck[]; receipt?: Receipt; gate?: GateRecord } => {
        const store = context.store
        const evidence = mission === undefined ? [] : store.readEvidence(mission.id)
        const receipt = mission === undefined ? undefined : newestReceipt(store.readReceipts(mission.id))
        const gate = mission === undefined ? undefined : store.lastGate(mission.id, { source: QUALITY_GATE_SOURCE })
        const proofAt = newestEvidenceAt(evidence)
        const asks = pendingAsksOf(deps.interaction())
        const verdict = evaluateGoNoGo({
            mission: mission === undefined ? undefined : { id: mission.id, status: mission.status, title: mission.title },
            ...(receipt === undefined ? {} : { receipt }),
            ...(gate === undefined ? {} : { newestGate: gate }),
            ...(proofAt === undefined ? {} : { newestEvidenceAt: proofAt }),
            pendingAsks: asks.asks,
            pendingAsksQueryable: asks.queryable,
            fingerprint: context.fingerprint,
            config: context.config,
            environment: context.environment,
            now: deps.now(),
        })
        const checks = [...verdict.checks, ...commandChecks(context.environment, vars)]
        const failures = checks.filter((check) => !check.ok)
        return {
            checks,
            ok: failures.length === 0,
            failures,
            ...(receipt === undefined ? {} : { receipt }),
            ...(gate === undefined ? {} : { gate }),
        }
    }

    /** A refusal message naming the blocking checks. */
    const refusal = (failures: readonly PlanCheck[]): Error =>
        new Error(
            [
                `检查未通过（${failures.length} 项）：`,
                describeFailures(failures),
                '',
                '未执行任何命令，环境未被触碰。',
                `下一步：按上面每一项的"下一步"修掉这 ${failures.length} 项，然后重试。`,
            ].join('\n'),
        )

    /**
     * Refuse BEFORE anything runs when the ledger cannot record the outcome.
     *
     * The ledger is the only place "who approved what, and how it ended" is
     * written for a workspace. Discovering it is unwritable AFTER the deploy
     * commands ran leaves the newest `dsh-deploy-gate` record a PASS with no row
     * — exactly the state an orchestrator must never read as success.
     */
    const assertLedgerWritable = (context: ReturnType<typeof prepare>, mission: MissionRecord | undefined, action: string): void => {
        const writable = ledgerWritable(context.ledgerFile)
        if (writable.ok) return
        const blockGate = recordGate(context.store, mission, {
            state: 'BLOCK',
            reason: `${action}未执行：部署台账不可写（${writable.reason}）`,
            results: refusalResults([
                {
                    id: 'ledger-writable',
                    ok: false,
                    label: '部署台账可写（否则这次动作没有可审计的记录）',
                    detail: `台账 ${context.ledgerFile} 不可写：${writable.reason}`,
                    fix: '让台账路径可写（目录存在、进程有写权限、路径指向文件而不是目录）后重试',
                },
            ]),
            scope: { selected: [], total: 1, full: false },
            fingerprint: context.fingerprint,
        })
        throw ledgerPreflightFailure({
            action,
            environment: context.environment,
            ledgerFile: context.ledgerFile,
            reason: writable.reason,
            ...(blockGate === undefined ? {} : { blockGate }),
        })
    }

    /** Render the plan section, including the shared header lines. */
    const planBlock = (
        context: ReturnType<typeof prepare>,
        evaluated: ReturnType<typeof checksFor>,
        mission: MissionRecord | undefined,
        vars: TemplateVars,
    ): string[] =>
        renderPlan({
            config: context.config,
            source: context.source,
            environment: context.environment,
            checks: evaluated.checks,
            fingerprint: context.fingerprint,
            ...(mission === undefined ? {} : { mission }),
            ...(evaluated.receipt === undefined ? {} : { receipt: evaluated.receipt }),
            ...(evaluated.gate === undefined ? {} : { gate: evaluated.gate }),
            ledgerFile: context.ledgerFile,
            vars,
        })

    /** Run the environment's rollback commands after a failure, when the host asked for it. */
    const maybeAutoRollback = async (input: {
        context: ReturnType<typeof prepare>
        mission: MissionRecord | undefined
        vars: TemplateVars
        deployer: string
        failedRow?: LedgerRow
        signal?: AbortSignal
    }): Promise<{ lines: string[]; row?: LedgerRow }> => {
        const { context, mission } = input
        if (!context.config.autoRollbackOnFailure) {
            return { lines: ['自动回滚未开启（autoRollbackOnFailure=false）：回滚需要在明确知道要回滚什么之后手动执行 `deploy_rollback`。'] }
        }
        const rollbackCommands = context.environment.rollbackCommands ?? []
        if (rollbackCommands.length === 0) {
            return {
                lines: [
                    `自动回滚已开启（autoRollbackOnFailure=true），但环境 "${context.environment.name}" 没有声明 rollbackCommands：本插件不会发明回滚步骤，请人工处理（这正是"回滚必须声明"的原因）。`,
                ],
            }
        }
        const target = input.failedRow ?? rollbackTargetOf(readLedger(context.ledgerFile).rows, context.environment.name)
        const vars: TemplateVars = { ...input.vars, target: target?.id ?? '' }
        const result = await runSequence(rollbackCommands, {
            kind: 'rollback',
            vars,
            cwd: context.cwd,
            timeoutMs: context.config.commandTimeoutMs,
            maxOutputBytes: 64_000,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            subprocess: deps.subprocess(),
            logger: loggerFor(deps.logger, context.cwd),
        })
        const state: DeployState = result.failed === undefined ? 'rolled-back' : 'rollback-failed'
        const gate = recordGate(context.store, mission, {
            state: state === 'rolled-back' ? 'WARN' : 'BLOCK',
            reason: `deploy-gate 自动回滚（autoRollbackOnFailure）：${state}；目标 ${target?.id ?? '(未知)'}`,
            results: gateResultsOf(result.runs),
            scope: { selected: result.runs.map((run) => run.id), total: rollbackCommands.length, full: result.failed === undefined },
            fingerprint: context.fingerprint,
        })
        const row = recordLedgerRow(context.ledgerFile, {
            at: deps.now(),
            environment: context.environment.name,
            revision: vars.revision ?? context.revision,
            deployer: input.deployer,
            state,
            note: '自动回滚（autoRollbackOnFailure）',
            ...(gate === undefined ? {} : { gateId: gate.id }),
            ...(target === undefined ? {} : { rollbackOf: target.id }),
        })
        const lines = [`### 自动回滚：${state === 'rolled-back' ? '已执行' : '执行失败'}`, '', ...renderRuns('回滚命令：', result.runs, result.failed), '', `台账：${describeRow(row)}`]
        return { lines, row }
    }

    // --- deploy_plan ------------------------------------------------------
    register(
        defineTool({
            name: 'deploy_plan',
            description:
                'Evaluate the go/no-go checklist for deploying the current revision to one declared environment: mission delivered, delivery receipt bound to THIS workspace revision, newest quality gate PASS and strictly newer than the newest command/test evidence, no pending human asks, optional gate-age limit, clean tree, and an environment that declares deploy + verify + rollback commands that can be passed to a program as argv (no shell). Renders the exact commands that WOULD run and the rollback path. READ-ONLY with respect to the environment: nothing is executed, nothing is approved. Writes deploy/<stamp>-plan.json under the mission when one exists. Refuses when the environment is not declared in the host configuration.',
            parameters: {
                environment: { type: 'string', required: true, description: 'Declared environment name (e.g. "production"). An undeclared name is refused — this plugin never invents a deployment target.' },
                missionId: { type: 'string', description: 'Mission to plan for (default: the mission bound to this session).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: PlanArgs = {} as PlanArgs, exec) {
                const missionId = typeof args.missionId === 'string' ? args.missionId : undefined
                const context = prepare(exec, args.environment)
                const wanted = typeof missionId === 'string' && missionId.trim() !== ''
                // The plan may run without a mission (it is read-only), but an
                // explicit id that does not exist is a refusal, never a silent
                // "planned for nothing".
                const mission = resolveMission(context.store, context.agent, wanted ? missionId : undefined)
                const evaluated = checksFor(context, mission, context.vars)
                const lines = planBlock(context, evaluated, mission, context.vars)

                let artifactNote = '(无 mission，未落盘)'
                if (mission !== undefined) {
                    const stampAt = deps.now()
                    const body = {
                        kind: 'deploy-plan',
                        at: stampAt,
                        environment: context.environment.name,
                        kindOfEnvironment: context.environment.kind,
                        revision: context.revision,
                        missionId: mission.id,
                        missionStatus: mission.status,
                        receipt: evaluated.receipt?.id ?? null,
                        gate: evaluated.gate?.id ?? null,
                        verdict: evaluated.ok ? 'go' : 'no-go',
                        checks: evaluated.checks.map((check) => ({ id: check.id, ok: check.ok, unverified: check.unverified === true, detail: check.detail })),
                        deployCommands: context.environment.deployCommands,
                        verifyCommands: context.environment.verifyCommands ?? [],
                        rollbackCommands: context.environment.rollbackCommands ?? [],
                        canarySteps: context.environment.canary?.steps.length ?? 0,
                        requiresApproval: context.environment.requiresApproval,
                        configurationSource: context.source,
                    }
                    const file = context.store.writeArtifact(
                        mission.id,
                        path.join('deploy', `${stamp(stampAt)}-plan.json`),
                        `${JSON.stringify(body, undefined, 2)}\n`,
                    )
                    artifactNote = path.relative(context.cwd, file)
                }
                loggerFor(deps.logger, context.cwd).info(
                    `deploy_plan: ${context.environment.name} → ${evaluated.ok ? 'go' : `no-go（${evaluated.failures.length} 项）`}；mission ${mission?.id ?? '(无)'}`,
                )
                lines.push('', `落盘：${artifactNote}`)
                lines.push(
                    '',
                    evaluated.ok
                        ? `下一步：deploy_run({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`} }) 执行这次部署${context.environment.requiresApproval ? '（会先要求人工批准）' : ''}。`
                        : `下一步：按上面每项的"下一步"修掉 ${evaluated.failures.length} 项未通过的检查，然后重新运行 deploy_plan。`,
                )
                return lines.join('\n')
            },
        }),
        'deploy_plan',
    )

    // --- deploy_run -------------------------------------------------------
    register(
        defineTool({
            name: 'deploy_run',
            description:
                'Deploy the current revision to one declared environment, as a gated process: re-evaluate the go/no-go checklist (refusing and naming every failing check), refuse when the deployment ledger cannot be written (nothing may run while its outcome cannot be recorded), ask a human for approval when the environment requires it (through the interaction service — its `ask()` seam or its channel registry — else the harness approval seam — no channel means refusal, never a silent assumption of consent), re-observe the workspace and the checks after the approval (a revision or dirty state that moved while the card was open is refused and named), then execute the environment\'s deployCommands in order as argv (never a shell). A non-zero exit stops the sequence immediately and is reported with the captured output tail; a canary configuration runs its steps in order with their waits and verifications. Records a gate (source dsh-deploy-gate, with scope + workspace fingerprint) and one append-only ledger row carrying the revision, the approver and the approval message id; if that row cannot be written, a BLOCK is recorded immediately instead of leaving a PASS without its row. dryRun prints exactly what would happen and writes nothing.',
            parameters: {
                environment: { type: 'string', required: true, description: 'Declared environment name to deploy to.' },
                missionId: { type: 'string', description: 'Mission being deployed (default: the mission bound to this session). Required in practice: a deployment must belong to a delivery.' },
                dryRun: { type: 'boolean', description: 'Print exactly what would run (checks, commands, approval requirement) and write nothing.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: RunArgs = {} as RunArgs, exec) {
                const agent = agentOf(exec)
                const context = prepare(exec, args.environment)
                const mission = resolveMission(context.store, agent, args.missionId)
                const evaluated = checksFor(context, mission, context.vars)
                const signal = signalOf(exec)
                const lines = planBlock(context, evaluated, mission, context.vars)

                if (args.dryRun === true) {
                    lines.push(
                        '',
                        '### 预演（dryRun）',
                        '',
                        '未执行任何命令，未写任何文件，未请求任何审批。',
                        `若真正执行：${evaluated.ok ? 'go/no-go 通过' : `${evaluated.failures.length} 项检查未通过，deploy_run 会直接拒绝`}${
                            context.environment.requiresApproval ? '，并先请求人工批准' : '（该环境无需人工批准）'
                        }；随后按顺序执行上面列出的 ${context.environment.deployCommands.length} 条部署命令${context.environment.canary === undefined ? '' : ` 与 ${context.environment.canary.steps.length} 步 canary`}。`,
                        '',
                        `下一步：deploy_run({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`} }) 真正执行。`,
                    )
                    return lines.join('\n')
                }

                const deployer = deployerOf(agent)

                // A refusal is recorded, never silent: the newest gate of this
                // source must be the BLOCK, otherwise a stale PASS would authorise
                // the next attempt for whoever reads the gate.
                if (!evaluated.ok) {
                    const recording = recordRefusal({
                        store: context.store,
                        mission,
                        ledgerFile: context.ledgerFile,
                        environment: context.environment,
                        revision: context.revision,
                        deployer,
                        now: deps.now(),
                        reason: `部署被拒绝（go/no-go）：${evaluated.failures.map((check) => check.label).join('；')}`,
                        note: `go/no-go 未通过：${evaluated.failures.map((check) => check.id).join(', ')}`,
                        failures: evaluated.failures,
                        fingerprint: context.fingerprint,
                    })
                    loggerFor(deps.logger, context.cwd).warn(`deploy_run: 拒绝（${evaluated.failures.length} 项）→ ${recording.row.id}`)
                    throw new Error(
                        [
                            `部署 go/no-go 未通过（${evaluated.failures.length} 项）：`,
                            describeFailures(evaluated.failures),
                            '',
                            '未执行任何命令，环境未被触碰。',
                            `已记录：台账 ${recording.row.id}${recording.gate === undefined ? '；无 mission：仅记台账，未写门禁记录' : `；门禁 ${recording.gate.id}（BLOCK）`}。`,
                            `下一步：按上面每一项的"下一步"修掉这 ${evaluated.failures.length} 项，然后重新运行 deploy_run（想先复核可以跑 deploy_plan）。`,
                        ].join('\n'),
                    )
                }
                if (signal?.aborted === true) {
                    throw new Error('调用已被取消（signal 已中止）：未执行任何命令，环境未被触碰。')
                }
                // Nothing may run while its outcome cannot be recorded.
                assertLedgerWritable(context, mission, '部署')

                const vars = { ...context.vars, target: '' }
                let approval: ApprovalOutcome | undefined
                if (context.environment.requiresApproval) {
                    const attempt = await askHuman({
                        deps,
                        agent,
                        toolName: 'deploy_run',
                        action: 'deploy',
                        environment: context.environment,
                        cwd: context.cwd,
                        missionId: mission?.id ?? '(无 mission)',
                        revision: context.revision,
                        commands: context.environment.deployCommands,
                        ...(signal === undefined ? {} : { signal }),
                    })
                    if (attempt.kind !== 'allowed') {
                        const recording = recordRefusal({
                            store: context.store,
                            mission,
                            ledgerFile: context.ledgerFile,
                            environment: context.environment,
                            revision: context.revision,
                            deployer,
                            now: deps.now(),
                            reason: `部署未获批准：${proseOf(attempt.reason).split('\n')[0] ?? ''}`,
                            note: `审批未通过（${attempt.kind}）`,
                            fingerprint: context.fingerprint,
                            ...(attempt.outcome === undefined || attempt.outcome.by === '' ? {} : { approvedBy: attempt.outcome.by }),
                            ...(attempt.outcome === undefined || attempt.outcome.messageId === '' ? {} : { approvalMessageId: attempt.outcome.messageId }),
                        })
                        loggerFor(deps.logger, context.cwd).warn(`deploy_run: 未执行（${attempt.kind}）→ ${recording.row.id}`)
                        const recorded = `已记录：台账 ${recording.row.id}（state=refused）${recording.gate === undefined ? '；无 mission：仅记台账，未写门禁记录' : `；门禁 ${recording.gate.id}（BLOCK）`}。`
                        // A missing approval channel is a configuration failure the
                        // caller must fix; a human saying "no" is a normal outcome
                        // that gets a report. (The same split as dsh-standards-gate.)
                        if (attempt.kind === 'no-channel') throw new Error(`${attempt.reason}\n${recorded}`)
                        lines.push('', ...renderDenial(attempt, '执行部署', recorded))
                        return lines.join('\n')
                    }
                    approval = attempt.outcome
                }

                // The card was open for a while, and a workspace is not frozen
                // while a human reads it. Everything the verdict was computed from
                // is re-observed HERE, right before the first command: a revision
                // (or a dirty state, or a go/no-go fact) that moved during the
                // approval is refused and named, instead of being deployed under
                // the old revision and an old, now-false "clean tree" claim.
                const observed = fingerprintOf(context.cwd, context.store, context.ledgerFile)
                const observedVars = templateVars(context.cwd, context.environment, observed.isRepo ? (observed.head ?? 'HEAD') : '', '')
                const rechecked = checksFor({ ...context, fingerprint: observed, revision: revisionOf(observed), vars: observedVars }, mission, observedVars)
                const drift: PlanCheck[] = []
                const revisionMoved = revisionOf(observed) !== context.revision
                if (revisionMoved) {
                    drift.push({
                        id: 'revision-moved',
                        ok: false,
                        label: '审批期间 revision 没有变化',
                        detail: `审批前 ${context.revision}，批准后 ${revisionOf(observed)}`,
                        fix: '重新 deploy_plan/deploy_run，让这次审批针对当前这个 revision',
                    })
                }
                if (observed.changedFiles !== context.fingerprint.changedFiles) {
                    drift.push({
                        id: 'dirty-state-moved',
                        ok: false,
                        label: '审批期间未提交改动数没有变化',
                        detail: `审批前 ${context.fingerprint.changedFiles} 个文件未提交，批准后 ${observed.changedFiles} 个`,
                        fix: '提交（或撤销）这些改动后重新走一遍流程——审批针对的是审批时看到的那个 revision',
                    })
                }
                if (drift.length > 0 || !rechecked.ok) {
                    const failures = [...drift, ...rechecked.failures]
                    const recording = recordRefusal({
                        store: context.store,
                        mission,
                        ledgerFile: context.ledgerFile,
                        environment: context.environment,
                        revision: context.revision,
                        deployer,
                        now: deps.now(),
                        reason: `部署被拒绝（审批期间工作区/检查发生变化）：${failures.map((check) => check.label).join('；')}`,
                        note: `审批期间漂移：${failures.map((check) => check.id).join(', ')}`,
                        failures,
                        fingerprint: observed,
                        ...(approval === undefined || approval.by === '' ? {} : { approvedBy: approval.by }),
                        ...(approval === undefined || approval.messageId === '' ? {} : { approvalMessageId: approval.messageId }),
                    })
                    throw new Error(
                        [
                            `审批已经通过，但批准之后工作区/检查变了（${failures.length} 项）：`,
                            describeFailures(failures),
                            '',
                            '未执行任何命令，环境未被触碰。',
                            `已记录：台账 ${recording.row.id}（state=refused）${recording.gate === undefined ? '；无 mission：仅记台账，未写门禁记录' : `；门禁 ${recording.gate.id}（BLOCK）`}。`,
                            '下一步：重新 deploy_plan/deploy_run（审批针对的是审批当时的那个 revision）；要部署新的改动，就先让它被门禁与回执覆盖。',
                        ].join('\n'),
                    )
                }

                const logger = loggerFor(deps.logger, context.cwd)
                const deploy = await runSequence(context.environment.deployCommands, {
                    kind: 'deploy',
                    vars,
                    cwd: context.cwd,
                    timeoutMs: context.config.commandTimeoutMs,
                    maxOutputBytes: 64_000,
                    ...(signal === undefined ? {} : { signal }),
                    subprocess: deps.subprocess(),
                    logger,
                })
                const canarySteps = context.environment.canary?.steps ?? []
                const canaryRuns: SequenceRun[] = []
                let canaryFailed: SequenceRun | undefined
                let canaryRefused: { template: string; error: string } | undefined
                if (deploy.failed === undefined && canarySteps.length > 0) {
                    for (const [index, step] of canarySteps.entries()) {
                        const stepResult = await runSequence([step.command], {
                            kind: 'canary',
                            idPrefix: `canary-${index + 1}`,
                            vars,
                            cwd: context.cwd,
                            timeoutMs: context.config.commandTimeoutMs,
                            maxOutputBytes: 64_000,
                            ...(signal === undefined ? {} : { signal }),
                            subprocess: deps.subprocess(),
                            logger,
                        })
                        canaryRuns.push(...stepResult.runs)
                        if (stepResult.refused !== undefined) {
                            canaryRefused = stepResult.refused
                            break
                        }
                        if (stepResult.failed !== undefined) {
                            canaryFailed = stepResult.failed
                            break
                        }
                        logger.info(`deploy_run: canary 步骤 ${index + 1}/${canarySteps.length}（${step.percent}%）完成，等待 ${step.waitMs}ms`)
                        if (step.waitMs > 0) await deps.sleep(step.waitMs)
                        if ((step.verifyCommands?.length ?? 0) > 0) {
                            const verifyResult = await runSequence(step.verifyCommands as string[], {
                                kind: 'canary',
                                idPrefix: `canary-${index + 1}-verify`,
                                vars,
                                cwd: context.cwd,
                                timeoutMs: context.config.commandTimeoutMs,
                                maxOutputBytes: 64_000,
                                ...(signal === undefined ? {} : { signal }),
                                subprocess: deps.subprocess(),
                                logger,
                            })
                            canaryRuns.push(...verifyResult.runs)
                            if (verifyResult.failed !== undefined) {
                                canaryFailed = verifyResult.failed
                                break
                            }
                        }
                    }
                }
                const failedRun = deploy.failed ?? canaryFailed
                const refusedRun = deploy.refused ?? canaryRefused
                const allRuns = [...deploy.runs, ...canaryRuns]
                // EVERY command the environment declared for this rollout counts —
                // including each canary step's own verifyCommands. Counting only the
                // steps made `scope.full` unreachable (`allRuns.length` could never
                // meet `total`), so a fully successful rollout recorded `full: false`
                // and the documented authorising predicate never held on a canary
                // environment.
                const totalCommands =
                    context.environment.deployCommands.length +
                    canarySteps.reduce((sum, step) => sum + 1 + (step.verifyCommands?.length ?? 0), 0)
                const state: GateState = failedRun === undefined && refusedRun === undefined ? 'PASS' : 'BLOCK'
                const reason =
                    state === 'PASS'
                        ? `部署到 ${context.environment.name} 成功：${deploy.runs.length} 条部署命令${canaryRuns.length === 0 ? '' : `、${canarySteps.length} 步 canary`}全部退出码 0`
                        : refusedRun !== undefined
                          ? `部署到 ${context.environment.name} 未执行：命令 \`${refusedRun.template}\` 被拒绝（${refusedRun.error}）`
                          : `部署到 ${context.environment.name} 失败：命令 \`${failedRun?.template ?? ''}\` 退出码 ${failedRun?.outcome.exitCode ?? 'null'}`
                const recorded = recordExecution({
                    store: context.store,
                    mission,
                    ledgerFile: context.ledgerFile,
                    environment: context.environment,
                    revision: context.revision,
                    deployer,
                    now: deps.now(),
                    state,
                    reason,
                    results: gateResultsOf(allRuns),
                    scope: {
                        selected: allRuns.map((run) => run.id),
                        total: Math.max(1, totalCommands),
                        full: failedRun === undefined && refusedRun === undefined && allRuns.length === totalCommands,
                    },
                    fingerprint: context.fingerprint,
                    row: {
                        at: deps.now(),
                        environment: context.environment.name,
                        revision: context.revision,
                        deployer,
                        state: state === 'PASS' ? 'deployed' : 'failed',
                        plan: { checks: evaluated.checks.length },
                        ...(canarySteps.length === 0 ? {} : { canary: { steps: canarySteps.length } }),
                        ...(approval === undefined ? {} : { approvedBy: approverName(approval), approvalMessageId: approval.messageId }),
                    },
                })
                if (recorded.ledgerProblem !== undefined) {
                    throw ledgerRowFailure({
                        action: '部署',
                        environment: context.environment,
                        ledgerFile: context.ledgerFile,
                        reason: recorded.ledgerProblem,
                        outcomeLine: `${allRuns.length}/${Math.max(1, totalCommands)} 条命令已执行，${state === 'PASS' ? '全部退出码 0' : '有命令失败'}`,
                        runs: allRuns,
                        ...(recorded.blockGate === undefined ? {} : { blockGate: recorded.blockGate }),
                    })
                }
                const gate = recorded.gate
                const row = recorded.row as LedgerRow
                logger.info(`deploy_run: ${context.environment.name} → ${row.state}（${row.id}）；gate ${gate?.id ?? '(未记录)'}`)

                lines.push('', `### 部署执行：${state === 'PASS' ? '成功' : '失败'}`, '')
                lines.push(...renderRuns('部署命令：', deploy.runs, deploy.failed))
                if (canarySteps.length > 0) {
                    lines.push('', ...renderRuns(`canary 放量（${canarySteps.length} 步）：`, canaryRuns, canaryFailed))
                }
                if (refusedRun !== undefined) {
                    lines.push('', `⛔ 命令 \`${refusedRun.template}\` 在执行前被拒绝：${refusedRun.error}`)
                }
                lines.push('')
                if (approval !== undefined) {
                    lines.push(
                        `审批：${approverName(approval)}${approval.source === '' ? '' : ` via ${approval.source}`}${approval.messageId === '' ? '' : `，消息 ${approval.messageId}`}（${approval.decision}）`,
                    )
                } else {
                    lines.push('审批：该环境无需人工批准')
                }
                lines.push(`门禁记录：${gate?.id ?? '(未记录)'}（${state}）`)
                lines.push(`台账：${describeRow(row)}`)

                if (state !== 'PASS') {
                    lines.push('', `失败位置：\`${failedRun?.argv.join(' ') ?? refusedRun?.template ?? '(未知)'}\` —— 后续命令未执行（不回滚、不继续，交给人和回滚路径决定）。`)
                    const auto = await maybeAutoRollback({ context, mission, vars, deployer, failedRow: row, ...(signal === undefined ? {} : { signal }) })
                    lines.push('', ...auto.lines)
                    lines.push(
                        '',
                        `下一步：${auto.row === undefined ? `deploy_rollback({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`}, note: "…" }) 回滚` : '确认回滚后的环境状态（deploy_verify）'}；修好后重新 deploy_run。`,
                    )
                    lines.push('', missionNote(mission))
                    return lines.join('\n')
                }
                lines.push('', missionNote(mission))
                lines.push(
                    '',
                    `下一步：deploy_verify({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`} }) 跑部署后验证——部署命令退出码为 0 只说明命令跑了，不说明环境好了。`,
                )
                return lines.join('\n')
            },
        }),
        'deploy_run',
    )

    // --- deploy_verify ----------------------------------------------------
    register(
        defineTool({
            name: 'deploy_verify',
            description:
                'Run the environment\'s verifyCommands against the freshly deployed revision, with a bounded number of attempts and a backoff between them (both from configuration). Refuses unless the ledger shows a successful deployment of THIS revision that is still live (a verify-only PASS would otherwise be read by an orchestrator as "deployed and verified"), and refuses when the environment declares no verification commands — a deploy nothing checks is not a verified deploy. Records a PASS gate when an attempt fully succeeds and a BLOCK gate when the attempts are exhausted; on exhaustion the report surfaces the environment\'s rollback commands verbatim, so the next step is executable rather than a discussion.',
            parameters: {
                environment: { type: 'string', required: true, description: 'Declared environment name to verify.' },
                missionId: { type: 'string', description: 'Mission the verification belongs to (default: the mission bound to this session).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: VerifyArgs = {} as VerifyArgs, exec) {
                const agent = agentOf(exec)
                const context = prepare(exec, args.environment)
                const mission = resolveMission(context.store, agent, args.missionId)
                const verifyCommands = context.environment.verifyCommands ?? []
                if (verifyCommands.length === 0) {
                    throw new Error(
                        [
                            `环境 "${context.environment.name}" 没有声明 verifyCommands：没有可执行的验证，本插件不会把一个空验证判成 PASS（fail closed）。`,
                            `下一步：在 profile 或 .dsh/deploy-gate.json 里为该环境声明 verifyCommands（例如健康检查/冒烟测试脚本）。`,
                        ].join('\n'),
                    )
                }
                const commandIssues = commandChecks(context.environment, context.vars).filter((check) => !check.ok)
                if (commandIssues.length > 0) throw refusal(commandIssues)
                const signal = signalOf(exec)
                if (signal?.aborted === true) throw new Error('调用已被取消（signal 已中止）：未执行任何验证命令。')

                // A verify-only PASS must never become the newest record an
                // orchestrator reads as "部署已执行且通过": verification is evidence
                // ABOUT a deployment, so it needs one — a successful deploy of the
                // revision that is in the workspace now, still live in the ledger.
                //
                // (Only enforced when a mission exists, because that is exactly when
                // a gate record — the thing an orchestrator reads — is written. With
                // no mission the ledger row is the only trace and nothing can be
                // mistaken for an authorised deployment.)
                const ledger = readLedger(context.ledgerFile)
                if (mission !== undefined) {
                    const live = liveDeployment(ledger.rows, context.environment.name)
                    const newest = lastRowOf(ledger.rows, context.environment.name)
                    const foundInstead =
                        newest === undefined
                            ? `台账 ${context.ledgerFile} 里没有环境 "${context.environment.name}" 的任何记录`
                            : `最近一行是 ${describeRow(newest)}`
                    const problems: PlanCheck[] = []
                    if (live === undefined) {
                        problems.push({
                            id: 'verify-requires-deploy',
                            ok: false,
                            label: '本环境有一次成功且仍然上线的部署（deploy_verify 只能验证真的发生过的部署）',
                            detail: `${foundInstead}。没有一次成功的部署，这次验证的 PASS 会被编排器读成"部署已执行且通过"——而实际上什么都没上`,
                            fix: '先 deploy_run（走完 go/no-go 与审批）把这次交付真正部署上去，再跑 deploy_verify',
                        })
                    } else if (live.revision !== context.revision) {
                        problems.push({
                            id: 'verify-revision-matches',
                            ok: false,
                            label: '台账里上线的那个 revision 就是当前工作区的 revision',
                            detail: `台账上线的是 ${live.revision}（${live.id}），当前工作区是 ${context.revision}：验证必须针对被部署的那个 revision`,
                            fix: '部署当前 revision（deploy_run）后再验证；或回滚到台账里那个版本再验证它',
                        })
                    }
                    if (problems.length > 0) {
                        const recording = recordRefusal({
                            store: context.store,
                            mission,
                            ledgerFile: context.ledgerFile,
                            environment: context.environment,
                            revision: context.revision,
                            deployer: deployerOf(agent),
                            now: deps.now(),
                            reason: `部署后验证被拒绝：${problems.map((check) => check.label).join('；')}`,
                            note: `验证前置条件未满足：${problems.map((check) => check.id).join(', ')}`,
                            failures: problems,
                            fingerprint: context.fingerprint,
                        })
                        throw new Error(
                            [
                                `部署后验证未执行（${problems.length} 项前置条件未满足）：`,
                                describeFailures(problems),
                                '',
                                '未执行任何验证命令，环境未被触碰。',
                                `已记录：台账 ${recording.row.id}（state=refused）${recording.gate === undefined ? '；无 mission：仅记台账，未写门禁记录' : `；门禁 ${recording.gate.id}（BLOCK）`}。`,
                                '下一步：先部署（deploy_run）再验证；一次没有部署的"验证通过"不证明任何东西。',
                            ].join('\n'),
                        )
                    }
                }
                // Nothing may run while its outcome cannot be recorded.
                assertLedgerWritable(context, mission, '部署后验证')

                const logger = loggerFor(deps.logger, context.cwd)
                const attempts: { runs: SequenceRun[]; failed?: SequenceRun }[] = []
                const maxAttempts = Math.max(1, context.config.verifyRetries)
                for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                    const result = await runSequence(verifyCommands, {
                        kind: 'verify',
                        // One attempt = one sequence: without its own prefix the
                        // retries would all be `verify-1` and the gate record could
                        // not say which attempt a command belonged to.
                        idPrefix: `verify-${attempt}`,
                        vars: context.vars,
                        cwd: context.cwd,
                        timeoutMs: context.config.commandTimeoutMs,
                        maxOutputBytes: 64_000,
                        ...(signal === undefined ? {} : { signal }),
                        subprocess: deps.subprocess(),
                        logger,
                    })
                    attempts.push({ runs: result.runs, ...(result.failed === undefined ? {} : { failed: result.failed }) })
                    if (result.failed === undefined) break
                    if (attempt < maxAttempts && context.config.verifyBackoffMs > 0) {
                        logger.info(`deploy_verify: 第 ${attempt}/${maxAttempts} 次未通过，${context.config.verifyBackoffMs}ms 后重试`)
                        await deps.sleep(context.config.verifyBackoffMs)
                    }
                }
                const last = attempts.at(-1)
                const ok = last !== undefined && last.failed === undefined
                const runs = attempts.flatMap((entry) => entry.runs)
                const state: GateState = ok ? 'PASS' : 'BLOCK'
                const reason = ok
                    ? `部署后验证通过（${attempts.length}/${maxAttempts} 次尝试）：${verifyCommands.length} 条验证命令全部退出码 0`
                    : `部署后验证失败：${attempts.length} 次尝试后仍未通过（最后一次失败于 \`${last?.failed?.argv.join(' ') ?? '(未知)'}\`，退出码 ${last?.failed?.outcome.exitCode ?? 'null'}）`
                const recorded = recordExecution({
                    store: context.store,
                    mission,
                    ledgerFile: context.ledgerFile,
                    environment: context.environment,
                    revision: context.revision,
                    deployer: deployerOf(agent),
                    now: deps.now(),
                    state,
                    reason,
                    results: gateResultsOf(runs),
                    scope: { selected: runs.map((run) => run.id), total: verifyCommands.length * attempts.length, full: ok },
                    fingerprint: context.fingerprint,
                    row: {
                        at: deps.now(),
                        environment: context.environment.name,
                        revision: context.revision,
                        deployer: deployerOf(agent),
                        state: ok ? 'verified' : 'verify-failed',
                        verify: { attempts: attempts.length, ok },
                    },
                })
                if (recorded.ledgerProblem !== undefined) {
                    throw ledgerRowFailure({
                        action: '部署后验证',
                        environment: context.environment,
                        ledgerFile: context.ledgerFile,
                        reason: recorded.ledgerProblem,
                        outcomeLine: `${runs.length} 条验证命令已执行，${ok ? '全部退出码 0' : '未通过'}`,
                        runs,
                        ...(recorded.blockGate === undefined ? {} : { blockGate: recorded.blockGate }),
                    })
                }
                const gate = recorded.gate
                const row = recorded.row as LedgerRow
                logger.info(`deploy_verify: ${context.environment.name} → ${row.state}（${attempts.length} 次尝试）；gate ${gate?.id ?? '(未记录)'}`)

                const lines: string[] = []
                lines.push(`## 部署后验证：${context.environment.name}（kind=${context.environment.kind}）`)
                lines.push('')
                lines.push(`${ok ? '✅' : '⛔'} 裁决：${state} —— ${reason}`)
                lines.push(`revision：${context.revision}`)
                lines.push(`尝试：最多 ${maxAttempts} 次，间隔 ${context.config.verifyBackoffMs}ms；实际尝试 ${attempts.length} 次`)
                lines.push('')
                attempts.forEach((entry, index) => {
                    lines.push(`第 ${index + 1} 次尝试${entry.failed === undefined ? '（通过）' : '（未通过）'}：`)
                    lines.push(...renderRuns('  验证命令：', entry.runs, entry.failed))
                })
                lines.push('')
                lines.push(`门禁记录：${gate?.id ?? '(未记录)'}（${state}）`)
                lines.push(`台账：${describeRow(row)}`)
                if (!ok) {
                    const rollback = context.environment.rollbackCommands ?? []
                    lines.push('', '### 回滚路径（环境声明的原话，未执行）', '')
                    if (rollback.length === 0) {
                        lines.push(`⛔ 环境 "${context.environment.name}" 没有声明 rollbackCommands：本插件不会发明回滚步骤。先补齐回滚路径，再部署。`)
                    } else {
                        for (const line of renderCommands('回滚命令', rollback, context.vars).slice(1)) lines.push(line)
                    }
                    const auto = await maybeAutoRollback({ context, mission, vars: context.vars, deployer: deployerOf(agent), ...(signal === undefined ? {} : { signal }) })
                    lines.push('', ...auto.lines)
                    lines.push(
                        '',
                        rollback.length === 0
                            ? `下一步：为该环境声明 rollbackCommands（未演练的回滚不是回滚），然后重新部署或人工处理。`
                            : auto.row === undefined
                              ? `下一步：deploy_rollback({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`}, note: "验证未通过" }) 执行上面列出的回滚命令。`
                              : `下一步：deploy_status 查看台账；确认环境处于预期版本后再决定是否重新部署。`,
                    )
                    lines.push('', missionNote(mission))
                    return lines.join('\n')
                }
                lines.push('', missionNote(mission))
                lines.push(
                    '',
                    `下一步：deploy_status({ environment: ${JSON.stringify(context.environment.name)} }) 查看台账与当前上线版本；若这次部署属于一次发布，把这行台账（${row.id}）记进发布记录。`,
                )
                return lines.join('\n')
            },
        }),
        'deploy_verify',
    )

    // --- deploy_rollback --------------------------------------------------
    register(
        defineTool({
            name: 'deploy_rollback',
            description:
                'Execute the environment\'s declared rollbackCommands (argv, never a shell) to take the environment back to a known revision. Uses the same approval rule as deploy_run: an environment that requires approval for deploying requires it for rolling back too. Refuses when the environment declares no rollback commands — an unrehearsed rollback is not a rollback. Records a gate and a ledger row with rollbackOf pointing at the deployment it undoes, when the target is known (either the "to" argument, the currently-live deployment, or the last attempt).',
            parameters: {
                environment: { type: 'string', required: true, description: 'Declared environment name to roll back.' },
                missionId: { type: 'string', description: 'Mission the rollback belongs to (default: the mission bound to this session).' },
                to: { type: 'string', description: 'Rollback target: a ledger deployment id (DPL-…) or a revision. Default: the deployment the ledger believes is live.' },
                note: { type: 'string', description: 'Why this rollback is happening; recorded in the ledger row (an incident id or a one-line reason).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: RollbackArgs = {} as RollbackArgs, exec) {
                const agent = agentOf(exec)
                const context = prepare(exec, args.environment)
                const mission = resolveMission(context.store, agent, args.missionId)
                const rollbackCommands = context.environment.rollbackCommands ?? []
                if (rollbackCommands.length === 0) {
                    throw new Error(
                        [
                            `环境 "${context.environment.name}" 没有声明 rollbackCommands：本插件拒绝执行一次没有声明的回滚（fail closed）——现场拼出来的命令既没有演练过，也不会出现在台账里，那不是回滚，是第二次事故。`,
                            `下一步：为该环境声明 rollbackCommands（例如 ["bash scripts/rollback.sh"]），并至少演练一次；然后重试。`,
                        ].join('\n'),
                    )
                }
                const ledger = readLedger(context.ledgerFile)
                const wanted = typeof args.to === 'string' && args.to.trim() !== '' ? args.to.trim() : undefined
                const target = wanted === undefined ? rollbackTargetOf(ledger.rows, context.environment.name) : findDeployment(ledger.rows, context.environment.name, wanted)
                const signal = signalOf(exec)
                if (signal?.aborted === true) throw new Error('调用已被取消（signal 已中止）：未执行任何回滚命令。')
                const revision = target?.revision ?? wanted ?? context.revision
                const vars = templateVars(context.cwd, context.environment, revision, target?.id ?? '')
                const issues = commandChecks(context.environment, vars).filter((check) => check.ok === false && check.id === 'commands-rollback-usable')
                if (issues.length > 0) throw refusal(issues)

                const lines: string[] = []
                lines.push(`## 回滚：${context.environment.name}（kind=${context.environment.kind}）`)
                lines.push('')
                lines.push(`目标：${wanted === undefined ? (target === undefined ? '台账没有可回滚的部署记录（将按配置执行回滚命令，不绑定目标）' : `台账记录的上线版本 ${target.id}`) : wanted}`)
                if (target !== undefined) {
                    lines.push(`将撤销：${target.id}（${target.state} @ ${formatTime(target.at)}，revision ${target.revision}）`)
                } else if (wanted !== undefined) {
                    lines.push(`台账里没有匹配 "${wanted}" 的部署记录：按 revision/ref 处理，本次回滚不会写入 rollbackOf。`)
                }
                lines.push(`当前工作区 revision：${context.revision}`)
                lines.push(mission === undefined ? 'mission：(本会话没有绑定 mission——仅记台账，未写门禁记录)' : `mission：${mission.id}（${mission.status}）`)
                for (const line of renderCommands('回滚命令（来自配置）', rollbackCommands, vars)) lines.push(line)
                lines.push('')
                lines.push(
                    `审批：${context.environment.requiresApproval ? `需要人工批准${context.environment.approversFile === undefined ? '' : `（按名单 ${context.environment.approversFile} 核对审批人身份）`}` : '无需人工批准'}`,
                )
                // Nothing may run while its outcome cannot be recorded.
                assertLedgerWritable(context, mission, '回滚')

                let approval: ApprovalOutcome | undefined
                if (context.environment.requiresApproval) {
                    const attempt = await askHuman({
                        deps,
                        agent,
                        toolName: 'deploy_rollback',
                        action: 'rollback',
                        environment: context.environment,
                        cwd: context.cwd,
                        missionId: mission?.id ?? '(无 mission)',
                        revision,
                        commands: rollbackCommands,
                        ...(signal === undefined ? {} : { signal }),
                    })
                    if (attempt.kind !== 'allowed') {
                        const recording = recordRefusal({
                            store: context.store,
                            mission,
                            ledgerFile: context.ledgerFile,
                            environment: context.environment,
                            revision,
                            deployer: deployerOf(agent),
                            now: deps.now(),
                            reason: `回滚未获批准：${proseOf(attempt.reason).split('\n')[0] ?? ''}`,
                            note: `审批未通过（${attempt.kind}）`,
                            fingerprint: context.fingerprint,
                        })
                        const recorded = `已记录：台账 ${recording.row.id}（state=refused）${recording.gate === undefined ? '；无 mission：仅记台账，未写门禁记录' : `；门禁 ${recording.gate.id}（BLOCK）`}。`
                        if (attempt.kind === 'no-channel') throw new Error(`${attempt.reason}\n${recorded}`)
                        lines.push('', ...renderDenial(attempt, '执行回滚', recorded))
                        return lines.join('\n')
                    }
                    approval = attempt.outcome
                }

                const deployer = deployerOf(agent)
                const result = await runSequence(rollbackCommands, {
                    kind: 'rollback',
                    vars,
                    cwd: context.cwd,
                    timeoutMs: context.config.commandTimeoutMs,
                    maxOutputBytes: 64_000,
                    ...(signal === undefined ? {} : { signal }),
                    subprocess: deps.subprocess(),
                    logger: loggerFor(deps.logger, context.cwd),
                })
                const ok = result.failed === undefined
                const state: DeployState = ok ? 'rolled-back' : 'rollback-failed'
                const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim() : undefined
                const recorded = recordExecution({
                    store: context.store,
                    mission,
                    ledgerFile: context.ledgerFile,
                    environment: context.environment,
                    revision,
                    deployer,
                    now: deps.now(),
                    state: ok ? 'PASS' : 'BLOCK',
                    reason: ok
                        ? `回滚到 ${revision} 成功：${rollbackCommands.length} 条回滚命令全部退出码 0`
                        : `回滚失败：\`${result.failed?.argv.join(' ') ?? ''}\` 退出码 ${result.failed?.outcome.exitCode ?? 'null'}`,
                    results: gateResultsOf(result.runs),
                    scope: { selected: result.runs.map((run) => run.id), total: rollbackCommands.length, full: ok },
                    fingerprint: context.fingerprint,
                    row: {
                        at: deps.now(),
                        environment: context.environment.name,
                        revision,
                        deployer,
                        state,
                        ...(note === undefined ? {} : { note }),
                        ...(target === undefined ? {} : { rollbackOf: target.id }),
                        ...(approval === undefined ? {} : { approvedBy: approverName(approval), approvalMessageId: approval.messageId }),
                    },
                })
                if (recorded.ledgerProblem !== undefined) {
                    throw ledgerRowFailure({
                        action: '回滚',
                        environment: context.environment,
                        ledgerFile: context.ledgerFile,
                        reason: recorded.ledgerProblem,
                        outcomeLine: `${result.runs.length}/${rollbackCommands.length} 条回滚命令已执行，${ok ? '全部退出码 0' : '有命令失败'}`,
                        runs: result.runs,
                        ...(recorded.blockGate === undefined ? {} : { blockGate: recorded.blockGate }),
                    })
                }
                const gate = recorded.gate
                const row = recorded.row as LedgerRow
                loggerFor(deps.logger, context.cwd).info(`deploy_rollback: ${context.environment.name} → ${state}（${row.id}）${target === undefined ? '' : ` rollbackOf=${target.id}`}`)

                lines.push('', `### 回滚执行：${ok ? '成功' : '失败'}`, '')
                lines.push(...renderRuns('回滚命令：', result.runs, result.failed))
                lines.push('')
                if (approval !== undefined) {
                    lines.push(
                        `审批：${approverName(approval)}${approval.source === '' ? '' : ` via ${approval.source}`}${approval.messageId === '' ? '' : `，消息 ${approval.messageId}`}（${approval.decision}）`,
                    )
                }
                lines.push(`门禁记录：${gate?.id ?? '(未记录)'}（${ok ? 'PASS' : 'BLOCK'}）`)
                lines.push(`台账：${describeRow(row)}${target === undefined ? '' : `（rollbackOf=${target.id}）`}`)
                lines.push('')
                lines.push('', missionNote(mission))
                lines.push(
                    ok
                        ? `下一步：deploy_verify({ environment: ${JSON.stringify(context.environment.name)}${mission === undefined ? '' : `, missionId: ${JSON.stringify(mission.id)}`} }) 验证回滚后的环境确实健康——回滚命令退出码 0 只说明命令跑了。`
                        : `下一步：回滚也失败了，环境处于未知状态：立即人工介入，并保留上面的输出（门禁 ${gate?.id ?? '(未记录)'}）作为事故记录。`,
                )
                return lines.join('\n')
            },
        }),
        'deploy_rollback',
    )

    // --- deploy_status ----------------------------------------------------
    register(
        defineTool({
            name: 'deploy_status',
            description:
                'Read-only deployment status: the environments the host declared (with whether each one requires approval and whether its rollback path is configured), the workspace ledger summary per environment, the deployment a rollback would target right now, the newest deploy/verify/rollback gate of the mission, any pending human asks, and the workspace revision. Writes nothing and executes nothing.',
            parameters: {
                environment: { type: 'string', description: 'Only report this environment (default: every declared environment).' },
                missionId: { type: 'string', description: 'Mission whose gates to report (default: the mission bound to this session, when any).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const effective = deps.configFor(agent)
                const config = effective.config
                const store = deps.stores.for(cwd)
                const ledgerFile = ledgerPathOf(cwd, config)
                const fingerprint = fingerprintOf(cwd, store, ledgerFile)
                const ledger = readLedger(ledgerFile)
                const summary = summarize(ledger.rows)
                const wanted = typeof args.environment === 'string' && args.environment.trim() !== '' ? args.environment.trim() : undefined
                const environments =
                    wanted === undefined
                        ? config.environments
                        : config.environments.filter((entry) => entry.name === wanted)
                const mission =
                    typeof args.missionId === 'string' && args.missionId.trim() !== ''
                        ? resolveMission(store, agent, args.missionId)
                        : store.resolveForAgent(agent, {})
                const asks = pendingAsksOf(deps.interaction())

                const lines: string[] = []
                lines.push('## 部署状态')
                lines.push('')
                lines.push(`配置来源：${describeSource(effective)}${effective.problems.length === 0 ? '' : `（${effective.problems.length} 个配置问题，见插件日志）`}`)
                lines.push(`工作区 revision：${revisionOf(fingerprint)}`)
                lines.push(`部署台账：${ledgerFile}（${ledger.rows.length} 行${ledger.problems.length === 0 ? '' : `，${ledger.problems.length} 行无法解析`}）`)
                for (const problem of ledger.problems) lines.push(`  ⚠️ ${problem}`)
                lines.push('')
                if (config.environments.length === 0) {
                    lines.push('⛔ 没有声明任何环境：本插件的每个工具都会拒绝执行（没有目标就没有部署）。')
                }
                lines.push(`环境（${environments.length}/${config.environments.length} 个${wanted === undefined ? '' : `，筛选 ${wanted}`}）：`)
                if (environments.length === 0 && wanted !== undefined) {
                    lines.push(`  ⛔ 未声明名为 "${wanted}" 的环境。`)
                }
                for (const environment of environments) {
                    const stat = summary.environments.find((entry) => entry.environment === environment.name)
                    const deployable =
                        environment.deployCommands.length > 0 && (environment.verifyCommands?.length ?? 0) > 0 && (environment.rollbackCommands?.length ?? 0) > 0
                    lines.push(
                        `  - ${environment.name}（kind=${environment.kind}；${environment.requiresApproval ? '需要人工批准' : '无需批准'}${environment.approversFile === undefined ? '' : `；名单 ${environment.approversFile}`}）`,
                    )
                    lines.push(
                        `      部署 ${environment.deployCommands.length} 条，验证 ${environment.verifyCommands?.length ?? 0} 条，回滚 ${environment.rollbackCommands?.length ?? 0} 条${environment.canary === undefined ? '' : `，canary ${environment.canary.steps.length} 步`}${deployable ? '' : ' ⛔ 声明不完整：deploy_plan 会拒绝（缺部署/验证/回滚命令）'}`,
                    )
                    if (stat === undefined) {
                        lines.push('      台账：本环境没有任何部署记录')
                        continue
                    }
                    lines.push(
                        `      台账：${stat.count} 行，最近 ${stat.state ?? '(未知)'} @ ${stat.lastAt === undefined ? '(未知)' : formatTime(stat.lastAt)}（${stat.revision ?? '(未知)'}）`,
                    )
                    const rows = ledger.rows.filter((row) => row.environment === environment.name)
                    const live = liveDeployment(ledger.rows, environment.name)
                    lines.push(
                        `      当前上线（台账口径）：${live === undefined ? '未知（最近一次是失败或回滚——台账不知道环境现在跑的是哪个版本）' : `${live.id} revision ${live.revision} @ ${formatTime(live.at)}`}`,
                    )
                    lines.push(
                        `      回滚目标：${
                            stat.rollbackTarget === undefined
                                ? stat.count === 0
                                    ? '无（台账里没有这个环境的记录）'
                                    : '未知（台账不知道当前上线的是哪个版本：最近一次是失败或回滚；deploy_rollback 不带 to 时会退化为撤销最后一次尝试）'
                                : `${stat.rollbackTarget.id}（${stat.rollbackTarget.state}，revision ${stat.rollbackTarget.revision}）`
                        }`,
                    )
                    const last = rows.at(-1)
                    if (last !== undefined) lines.push(`      最近一行：${describeRow(last)}`)
                }
                lines.push('')
                lines.push(`mission：${mission === undefined ? '(本会话没有绑定 mission)' : `${mission.id}（${mission.status}）`}`)
                if (mission !== undefined) {
                    const gates = store
                        .readGates(mission.id)
                        .filter((gate) => gate.source === GATE_SOURCE)
                        .sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id))
                    const newest = gates.at(-1)
                    lines.push(
                        `最近一条部署门禁（source=${GATE_SOURCE}，编排器读的就是这一条）：${
                            newest === undefined ? '(无)' : `${newest.id} ${newest.state} @ ${formatTime(newest.checkedAt)}：${newest.reason}`
                        }`,
                    )
                    const deployGate = gates.filter((gate) => gate.results.some((result) => result.id.startsWith('deploy-'))).at(-1)
                    const verifyGate = gates.filter((gate) => gate.results.some((result) => result.id.startsWith('verify-'))).at(-1)
                    if (deployGate === undefined && verifyGate === undefined && newest === undefined) {
                        lines.push('  （本 mission 还没有任何 dsh-deploy-gate 记录）')
                    }
                    lines.push(
                        `  最近一次部署：${deployGate === undefined ? '(无)' : `${deployGate.id} ${deployGate.state} @ ${formatTime(deployGate.checkedAt)}`}`,
                    )
                    lines.push(
                        `  最近一次验证：${verifyGate === undefined ? '(无)' : `${verifyGate.id} ${verifyGate.state} @ ${formatTime(verifyGate.checkedAt)}`}`,
                    )
                    const evidence = store.readEvidence(mission.id)
                    const proofAt = newestEvidenceAt(evidence)
                    const receipt = newestReceipt(store.readReceipts(mission.id))
                    lines.push(
                        `  交付回执：${receipt === undefined ? '(无)' : `${receipt.id} @ ${formatTime(receipt.issuedAt)}`}；最新 command/test 证据：${proofAt === undefined ? '(无)' : formatTime(proofAt)}`,
                    )
                    if (receipt !== undefined) {
                        const verdict = compareRevision(receipt.git, fingerprint)
                        lines.push(`  回执与当前工作区：${verdict.ok ? '一致' : '不一致'} —— ${verdict.detail}`)
                    }
                }
                lines.push('')
                lines.push(
                    `挂起的提问：${asks.queryable ? `${asks.asks.length} 个${asks.asks.length === 0 ? '' : `（${asks.asks.map((ask) => ask.title).join('；')}）`}` : '无法确定（没有可查询的 interaction 服务，或服务还没读到本工作区的台账——“读不到”不等于“没有人在等回答”）'}`,
                )
                lines.push('')
                lines.push(
                    `下一步：${
                        environments.length === 0
                            ? '先在 profile 或 .dsh/deploy-gate.json 里声明至少一个环境（deployCommands / verifyCommands / rollbackCommands）。'
                            : `deploy_plan({ environment: ${JSON.stringify(environments[0]?.name ?? '')} }) 看这个环境当前能不能上；或 deploy_rollback(...) 回滚到上面列出的回滚目标。`
                    }`,
                )
                return lines.join('\n')
            },
        }),
        'deploy_status',
    )

    return { disposers, registered, failed }
}

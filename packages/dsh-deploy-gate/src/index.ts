/**
 * dsh-deploy-gate — the deployment gate.
 *
 * The suite turns the engineering process into deterministic gates for 规划 /
 * 实现 / 测试 / 交互 / 交付. **部署 was the missing phase**: the chain ended at a
 * delivery receipt and "deploy" was a human typing commands. This plugin makes
 * the last step look like the others:
 *
 *  - **plan** — a go/no-go verdict computed from what the suite already recorded
 *    (delivered mission, receipt bound to this revision, quality gate PASS and
 *    newer than the newest evidence, no pending asks, clean tree, an environment
 *    that declares deploy + verify + rollback steps);
 *  - **approval** — production-class environments need a person, through the
 *    `interaction` service (chat/IM) when one is mounted, else the harness
 *    approval seam; no channel means refusal;
 *  - **run** — the host's commands, in order, **as argv, never through a shell**,
 *    stopping at the first non-zero exit with the output tail attached;
 *  - **verify** — bounded retries with backoff, and a BLOCK that carries the
 *    environment's rollback commands verbatim when the attempts run out;
 *  - **rollback** — the same approval rule as a deploy, and a refusal when the
 *    environment declares no rollback commands at all;
 *  - **record** — a `GateRecord` (`source: dsh-deploy-gate`) on the mission plus
 *    one append-only row in the workspace ledger (`.dsh/deployments.jsonl`) with
 *    the revision, the approver and the approval message id.
 *
 * Responsibilities:
 *  - register `deploy_plan` / `deploy_run` / `deploy_verify` / `deploy_rollback`
 *    / `deploy_status`;
 *  - decide with pure functions (`./plan`) over injected facts, so every branch
 *    is testable without touching a machine;
 *  - refuse — never guess — when an environment, a command, an approval or a
 *    rollback path is missing.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.get('subprocess')                 @deepseek-ai/dsh-subprocess
 *  - ctx.get('approval')                   the harness approval seam
 *  - ctx.get('interaction')                the optional chat/IM channel hub
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-deploy-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'

export const name = 'dsh-deploy-gate'

/** Only the services this plugin actually touches; `approval`/`interaction` are read via `get`. */
export const inject = ['tools', 'systemPrompt']

interface ToolRuntimeLike {
    register: (definition: never) => () => void
}

interface PromptRuntimeLike {
    section: (section: { name: string; order: number; text: (assembly?: unknown) => string }) => () => void
}

interface ContextLike {
    tools: ToolRuntimeLike
    systemPrompt: PromptRuntimeLike
    get: (name: string) => unknown
    effect: (execute: () => (() => void) | void) => void
}

/** The sleep the real host uses (tests inject their own through `registerTools`). */
function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms))
    })
}

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    // Config problems are collected before the logger exists, then replayed.
    const problems: string[] = []
    const resolved = resolveConfig(config, (message) => problems.push(message))
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        // Per-workspace files keep several repositories' deploys from interleaving.
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    for (const problem of problems) log.warn(`config: ${problem}`)
    if (!resolved.enabled) {
        log.info('disabled by config')
        return
    }
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const deps: ToolDeps = {
            config: resolved,
            // Profile config is the ceiling; a workspace declares/refines ITS
            // environments through .dsh/deploy-gate.json (see resolveEffectiveConfig).
            configFor: (agent: AgentLike | undefined) => {
                const cwd = agent?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') {
                    return { config: resolved, source: 'profile', file: '', problems: [] }
                }
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
            },
            stores,
            approval: () => context.get('approval') as never,
            interaction: () => context.get('interaction') as never,
            subprocess: () => context.get('subprocess'),
            logger: log,
            sleep: realSleep,
            now: () => Date.now(),
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) log.warn(`tools that failed to register: ${tools.failed.join(', ')}`)

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Per assembly: the model must be told THIS workspace's
                    // effective environments, not the profile defaults.
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            const cwd = scope?.session?.header?.cwd
                            if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                            const effective = deps.configFor(scope)
                            return sectionText(effective.config, effective.source === 'project' ? effective.file : undefined)
                        } catch {
                            return sectionText(resolved)
                        }
                    },
                }),
            )
        }

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    log.warn('disposer failed:', error)
                }
            }
        })

        log.info(
            `applied (tools: ${tools.registered.join(', ') || 'none'}; environments: ${
                resolved.environments.map((environment) => environment.name).join(', ') || 'none'
            }; ledger=${resolved.ledgerFile}; verify=${resolved.verifyRetries}x/${resolved.verifyBackoffMs}ms)`,
        )
        if (resolved.environments.length === 0) {
            log.warn('no deployment environment configured — every tool will refuse until the host declares one')
        }
    } catch (error) {
        log.error('apply failed:', error)
    }
}

export {
    resolveConfig,
    resolveEffectiveConfig,
    environmentByName,
    defaultRequiresApproval,
    verifyNeedsApproval,
    describeVerifyApproval,
    PROJECT_OVERRIDABLE_KEYS,
    VERIFY_APPROVAL_MODES,
    MAX_VERIFY_RETRIES,
} from './config.js'
export type { DeployGateConfig, EnvironmentConfig, CanaryStep, GoNoGoConfig, EffectiveConfig, VerifyApprovalMode, PendingAsksPolicy } from './config.js'
export { evaluateGoNoGo, compareRevision, newestEvidenceAt, newestReceipt, describeFailures, QUALITY_GATE_SOURCE } from './plan.js'
export type { GoNoGoInput, GoNoGoResult, PlanCheck, PendingAsk, MissionLike } from './plan.js'
export { readLedger, appendLedgerRow, summarize, liveDeployment, rollbackTargetOf, findDeployment, deploymentId, DEPLOY_STATES } from './ledger.js'
export type { LedgerRow, LedgerSummary, LedgerRead, DeployState, EnvironmentLedgerSummary } from './ledger.js'
export { tokenizeTemplate, checkTemplate, resolveCommands, SHELL_METACHARACTERS, TEMPLATE_VARS } from './command.js'
export {
    registerTools,
    pendingAsksOf,
    normalizeInteractionReply,
    approverAllowed,
    commandChecks,
    GATE_SOURCE,
    PENDING_ASK_OBSERVABILITY_FIX,
} from './tools.js'
export type { PendingAsksQuery } from './tools.js'
export type { ToolDeps, InteractionLike, InteractionAsk } from './tools.js'
export { PROMPT_SECTION, sectionText } from './prompt.js'

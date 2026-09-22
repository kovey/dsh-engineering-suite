/**
 * dsh-supply-chain-gate — the supply-chain and secret gate.
 *
 * The other gates ask "does it work" (`dsh-quality-gate`), "is it the right
 * thing" (`dsh-spec-gate`, `dsh-test-design-gate`), "can we prove it"
 * (`dsh-evidence-gate`) and "is it maintainable" (`dsh-standards-gate`). This one
 * asks the question that comes BEFORE all of them: **"can this even ship?"** —
 * committed secrets, unreviewed new dependencies, and known-vulnerable or
 * ill-licensed dependencies.
 *
 * Responsibilities:
 *  - register `secret_scan` / `dependency_audit` / `supply_chain_status`;
 *  - detect secrets in the lines a change ADDED (default), in explicit files, or
 *    in the bounded tree — with redacted evidence only, never the raw value;
 *  - diff the host-configured manifests for NEW dependencies, ask the human
 *    approval seam for them, and catch orphan lockfile changes;
 *  - run the host-configured auditors (`govulncheck`, `npm audit --json`,
 *    `pip-audit --format json`, …) through an argv array, never a shell;
 *  - record gates (`source: dsh-supply-chain-gate`) plus a detail artifact, so a
 *    delivery can require them the way it requires a quality gate.
 *
 * Every failure mode is fail-closed: an unparseable audit report, a refused
 * auditor, an empty scan, an expired allowlist entry and an unjudgeable
 * dependency set are reported as such, and none of them is a PASS.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.get('approval')                   @deepseek-ai/dsh-user-approval
 *  - ctx.get('subprocess')                 @deepseek-ai/dsh-subprocess
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-supply-chain-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import {
    MissionStoreRegistry,
    createLogger,
    expandHome,
    type AgentLike,
    type SubprocessLike,
} from 'dsh-eng-core'
import { PROJECT_OVERRIDABLE, resolveConfig, resolveEffectiveConfig, type SupplyChainGateConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { SECRET_RULES } from './secrets.js'
import { registerTools, type ApprovalLike, type ToolDeps } from './tools.js'

export const name = 'dsh-supply-chain-gate'

/** Only the services this plugin actually touches. */
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

/**
 * Register the plugin.
 * @param ctx - the host context.
 * @param config - the loader row's `config` value.
 */
export function apply(ctx: Context, config: unknown = {}): void {
    const resolved: SupplyChainGateConfig = resolveConfig(config)
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        ...(resolved.logFileTemplate === undefined ? {} : { template: resolved.logFileTemplate }),
    })
    if (!resolved.enabled) {
        log.info('disabled by config')
        return
    }
    try {
        const context = ctx as unknown as ContextLike
        const stores = new MissionStoreRegistry({ ...resolved.layout, logger: log })
        const deps: ToolDeps = {
            config: resolved,
            // Profile config is the ceiling; a workspace may refine it through its
            // own .dsh/supply-chain-gate.json (scan scope and audit commands are
            // the repository's business — switching the gate off is not).
            configFor: (agent: AgentLike | undefined) => {
                const cwd = agent?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') return { config: resolved, source: 'profile', problems: [] }
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
            },
            stores,
            approval: () => context.get('approval') as ApprovalLike | undefined,
            subprocess: () => context.get('subprocess') as SubprocessLike | undefined,
            logger: log,
        }

        const tools = registerTools(context as never, deps)
        if (tools.failed.length > 0) log.warn(`tools that failed to register: ${tools.failed.join(', ')}`)

        const disposers: (() => void)[] = [...tools.disposers]
        if (resolved.prompt.enabled) {
            disposers.push(
                context.systemPrompt.section({
                    name: PROMPT_SECTION,
                    order: resolved.prompt.order,
                    // Per assembly: the model must be told THIS workspace's effective
                    // switches, not the profile's defaults.
                    text: (assembly?: unknown) => {
                        try {
                            const scope = (assembly as { scope?: AgentLike } | undefined)?.scope
                            const cwd = scope?.session?.header?.cwd
                            if (typeof cwd !== 'string' || cwd === '') return sectionText(resolved)
                            const effective = resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
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
            `applied (tools: ${tools.registered.join(', ') || 'none'}; rules=${SECRET_RULES.length}; secretScan=${resolved.secretScan.enabled}; wholeTree=${resolved.secretScan.scanWholeTree}; approvalForNewDeps=${resolved.deps.requireApprovalForNewDeps}; auditCommands=${resolved.deps.auditCommands.length}; projectKeys=${PROJECT_OVERRIDABLE.join('/')})`,
        )
        if (resolved.deps.auditCommands.length === 0) {
            log.warn('no audit commands configured — dependency_audit can only report WARN until config.deps.auditCommands is filled in')
        }
    } catch (error) {
        log.error('apply failed:', error)
    }
}

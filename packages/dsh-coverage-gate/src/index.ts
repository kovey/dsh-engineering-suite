/**
 * dsh-coverage-gate — the test-effectiveness gate.
 *
 * Every other gate in the suite asks "does it work" (`dsh-quality-gate`), "is it
 * the right thing" (`dsh-spec-gate`, `dsh-test-design-gate`), "is it still
 * maintainable" (`dsh-standards-gate`) or "can we prove it"
 * (`dsh-evidence-gate`). This one asks **"are the tests doing anything"**:
 *
 *  - **total coverage** — the whole report against the host's threshold;
 *  - **incremental coverage** — the lines THIS change added, judged from
 *    `dsh-eng-core`'s `changedRanges`, and reported honestly for the added lines
 *    no report instruments (they cannot be judged, and are neither 0% nor 100%);
 *  - **flakiness** — the same command repeated up to `flakyRepeats` times, with
 *    per-test attribution when the runner names its tests and a run-level verdict
 *    when it does not;
 *  - **mutation score** (opt-in) — the source is deliberately broken, mutant by
 *    mutant, and the suite is asked whether it noticed. Coverage says a line ran;
 *    mutation says an assertion would have failed. A mutant whose command could
 *    not run is `run-error`, never a kill.
 *
 * Responsibilities:
 *  - register `coverage_check` / `flaky_check` / `mutation_check` / `coverage_status`;
 *  - obtain the numbers from host-configured commands (argv only, no shell) or
 *    from the report the host pointed at, and parse them with PURE functions;
 *  - record a `GateRecord` (`source: dsh-coverage-gate`, with `scope` and a git
 *    fingerprint) so a delivery can require it exactly like a quality gate;
 *  - refuse — never pass — when a threshold, a report source or a readable report
 *    is missing, and `BLOCK` when a report cannot be parsed;
 *  - mutate source files ONLY inside `mutation_check`, always restoring the
 *    pre-run bytes (verified), and refuse when the workspace cannot be restored.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.get('subprocess')                 @deepseek-ai/dsh-subprocess
 *  - ctx.systemPrompt.section({...})       @deepseek-ai/dsh-system-prompt
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *
 * @module dsh-coverage-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { MissionStoreRegistry, createLogger, expandHome } from 'dsh-eng-core'
import type { AgentLike } from 'dsh-eng-core'
import { resolveConfig, resolveEffectiveConfig, type CoverageGateConfig } from './config.js'
import { PROMPT_SECTION, sectionText } from './prompt.js'
import { registerTools, type ToolDeps } from './tools.js'

export const name = 'dsh-coverage-gate'

/** Only the two services this plugin actually touches. */
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

/** Wire the plugin into a host context. */
export function apply(ctx: Context, config: unknown = {}): void {
    // Config problems are collected before the logger exists, then replayed.
    const problems: string[] = []
    const resolved = resolveConfig(config, (message) => problems.push(message))
    const log = createLogger({
        tag: name,
        file: expandHome(resolved.logFile),
        // Per-workspace files keep several repositories' lines from interleaving.
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
            // Profile config is the ceiling; a workspace may refine it through
            // its own .dsh/coverage-gate.json (see resolveEffectiveConfig).
            configFor: (agent: AgentLike | undefined) => {
                const cwd = agent?.session?.header?.cwd
                if (typeof cwd !== 'string' || cwd === '') {
                    return { config: resolved, source: 'profile', file: '', problems: [] }
                }
                return resolveEffectiveConfig(resolved, stores.for(cwd).layout, log)
            },
            stores,
            subprocess: () => context.get('subprocess'),
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
                    // Per assembly: the model must be told THIS workspace's
                    // effective thresholds and commands, not the profile defaults.
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
            `applied (tools: ${tools.registered.join(', ') || 'none'}; thresholds: ${
                Object.keys(resolved.thresholds).join(', ') || 'none'
            }; report=${resolved.reportFile ?? 'none'}; flakyPolicy=${resolved.flakyPolicy}; repeats=${resolved.flakyRepeats}; mutation=${
                resolved.mutation.enabled ? `on (maxMutants=${resolved.mutation.maxMutants}, thresholds: ${Object.keys(resolved.mutation.thresholds).join(', ') || 'none'})` : 'off'
            })`,
        )
        if (Object.keys(resolved.thresholds).length === 0) {
            log.warn('no coverage threshold configured — coverage_check will refuse until the host sets thresholds')
        }
        if (resolved.mutation.enabled && Object.keys(resolved.mutation.thresholds).length === 0) {
            log.warn('mutation is enabled but has no threshold — mutation_check will refuse until mutation.thresholds is set')
        }
    } catch (error) {
        log.error('apply failed:', error)
    }
}

export {
    resolveConfig,
    resolveEffectiveConfig,
    PROJECT_OVERRIDABLE_KEYS,
    MAX_FLAKY_REPEATS,
    MAX_MUTANTS_CEILING,
    DEFAULT_MAX_MUTANTS,
    DEFAULT_MUTATION_TIME_BUDGET_MS,
    describeMutation,
    describeMutationThresholds,
    parseMutationThresholds,
} from './config.js'
export type {
    CoverageGateConfig,
    CoverageThresholds,
    FlakyPolicy,
    MutationConfig,
    ReportFormat,
} from './config.js'
export { parseCoverage, incrementalCoverage, worstFiles } from './coverage.js'
export type { CoverageReport, IncrementalCoverage, CoverageParseResult } from './coverage.js'
export { classifyRuns, compareRuns, detectFlakiness, parseTestNames } from './flaky.js'
export type { RunResult, FlakinessVerdict } from './flaky.js'
export { tokenizeTemplate, SHELL_METACHARACTERS } from './command.js'
export {
    applyMutant,
    classifyMutantOutcome,
    collectSourceFiles,
    detectSourceGlobs,
    formatMutationPercent,
    judgeMutation,
    maskDocument,
    maskLine,
    mutantsInFile,
    mutationScoreOf,
    planMutants,
    resolveOperators,
    runMutationPlan,
    scoreThresholdFor,
    stripCoverageDecorations,
    MutationRestoreError,
    ALL_SOURCE_GLOBS,
    DEFAULT_EXCLUDE_GLOBS,
    LANGUAGE_SOURCE_GLOBS,
    MUTATION_OPERATORS,
    MUTATION_OPERATOR_GROUPS,
    MUTATION_OPERATOR_IDS,
    SNIPPET_WIDTH,
} from './mutation.js'
export type {
    CollectedSources,
    JudgeMutationInput,
    LexicalState,
    Mutant,
    MutantCommandOutcome,
    MutantCommandRunner,
    MutantCommandSpec,
    MutantResult,
    MutantVerdict,
    MutationCheck,
    MutationCounts,
    MutationJudgement,
    MutationOperator,
    MutationOperatorGroup,
    MutationPlan,
    MutationRun,
    MutationRunOptions,
    MutationThresholds,
    PlanOptions,
    SourceFile,
} from './mutation.js'

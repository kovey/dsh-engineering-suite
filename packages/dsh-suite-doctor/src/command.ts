/**
 * The human-facing `/suite` command.
 *
 * Five operations a person wants while setting up or reviewing a repository —
 * scaffold the gate configs, see the effective config and its provenance, change
 * one key with a diff, open the file in the current UI, and run the config-level
 * health check — are exposed WITHOUT a model turn. The handler calls exactly the
 * functions the `suite_init` / `suite_config` tools and the doctor use
 * (`planSuiteInit`, `inspectSuiteConfig`, `runSuiteHealth`), so a person and a
 * model can never be told different things about the same file.
 *
 * `set` / `unset` are the only writes, and they exist ONLY here: the tools stay
 * read-only (see `tools-scaffold.ts`), because a reviewed threshold is something
 * a person changes deliberately, not something an agent may rewrite to pass its
 * own gate. The key verdict is `inspect.ts`'s, not a second allowlist.
 *
 * Three deliberate properties, the same ones `/kb` documents:
 *
 *  - **Optional integration.** The registry is reached through
 *    `ctx.get('commands')`, never through `inject`: a minimal host without
 *    `@deepseek-ai/dsh-commands` still loads this plugin, and an absent registry
 *    is a logged note, not a failed `apply`.
 *  - **No TUI-specific surface for registration.** Registration uses the
 *    harness's command registry (the same one the TUI, desktop and web
 *    composers read), NOT nvim-tui's extension API — the command is therefore
 *    available wherever the host mounted that registry, and simply absent where
 *    it did not. nvim-tui stays OPTIONAL: `edit` uses its file-tab entry, and
 *    every report its `ui.float` (`render-report.ts`); without it, same report
 *    as text.
 *  - **Fail closed on grammar.** An unrecognised sub-command or flag is an error
 *    result carrying the usage; `/suite init` without `--apply` writes nothing.
 *
 * @module dsh-suite-doctor/command
 */

import { resolveLayout, type AgentLike } from 'dsh-eng-core'
import { isConfigSubcommand, parseConfigInvocation, runConfigInvocation, type SuiteConfigInvocation } from './command-config.js'
import type { SuiteDoctorConfig } from './config.js'
import { runSuiteHealth, renderSuiteHealth } from './health.js'
import { inspectSuiteConfig, renderConfigInspection } from './inspect.js'
import { planSuiteInit, renderInitPlan } from './scaffold.js'
import { showReport } from './render-report.js'
import type { ToolDeps } from './tools.js'

/** The registered command name (the `/` is the harness's, not ours). */
export const SUITE_COMMAND_NAME = 'suite'

/** Discovery text shown in the command UI. */
export const SUITE_COMMAND_DESCRIPTION = '套件管理：脚手架门禁配置（默认 dry-run）/ 查看生效配置与来源 / 改配置（diff + 原子写）/ 在当前界面打开 / 配置体检'

/** Input hint advertised to capable composers. */
export const SUITE_COMMAND_HINT =
    'init [--apply] [--force] [--only <id,…>] | show [plugin] | set <plugin> <key> <json-value> | unset <plugin> <key> | edit [plugin] | doctor | help'

/** Expected command outcome, structurally what `@deepseek-ai/dsh-commands` returns. */
export type CommandResultLike = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** The invocation the registry hands the handler (only what this plugin reads). */
export interface CommandInvocationLike {
    /** The agent whose UI received the command; its session carries the workspace. */
    agent?: AgentLike
    /** Exact text after `suite`, including the separator whitespace. */
    rawInput?: unknown
}

/** Structural view of the registry (`ctx.get('commands')`), not an import. */
export interface CommandRuntimeLike {
    register: (definition: {
        name: string
        description: string
        input?: { hint: string }
        handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
    }) => () => void
}

/** One parsed invocation. */
export type SuiteInvocation =
    | { kind: 'help' }
    | { kind: 'init'; apply: boolean; force: boolean; only?: string[] }
    | { kind: 'show'; plugin?: string }
    | SuiteConfigInvocation
    | { kind: 'doctor' }
    | { kind: 'error'; text: string }

/** Whether a `ctx.get('commands')` value is the registry (structure, not identity). */
export function isCommandRuntime(value: unknown): value is CommandRuntimeLike {
    if (typeof value !== 'object' || value === null) return false
    return typeof (value as { register?: unknown }).register === 'function'
}

/** The usage text (no configuration needed: the grammar is fixed). */
export function usageText(): string {
    return [
        '/suite —— 套件管理（TUI / desktop / web 共用宿主命令注册面，不依赖 nvim-tui 扩展）',
        '用法：',
        '  /suite init [--apply] [--force] [--only <id,…>]   脚手架十份门禁配置（默认 dry-run；--apply 才写盘；已存在默认跳过，--force 才覆盖）',
        '  /suite show [plugin]                              只读查看生效配置与来源（repo/profile/default），并校验未知键与越权键',
        '  /suite set <plugin> <key> <json-value> [--dry-run] [--allow-unknown]',
        '                                                    改一个顶层键：先校验键与 JSON 值、打印逐键 diff，再原子写盘（失败保留原文件）',
        '  /suite unset <plugin> <key> [--dry-run] [--allow-unknown]',
        '                                                    删一个顶层键（同样先打印 diff 再原子写盘）',
        '  /suite edit [plugin]                              在当前界面打开配置文件（TUI 经 nvim-tui 的 open_file_tab 开标签页；其它端回落为打印绝对路径）',
        '  /suite doctor                                     配置级体检：文件是否存在/可解析、规范与基线、关键路径',
        '  /suite help                                       这条用法',
        'id：quality-gate（quality）、spec-gate（spec）、test-design-gate（test-design）、standards、evidence-gate（evidence）、',
        '    coverage-gate（coverage）、impact-gate（impact）、supply-chain-gate（supply-chain）、interaction-gate（interaction）、',
        '    deploy-gate（deploy）、suite-doctor',
        '说明：不认得的子命令/参数一律报错并显示这份用法；/suite init 默认不写盘；set/unset 只改顶层键（嵌套字段请设置整个顶层值），',
        '      被禁止在项目级覆盖的键（如 enabled、askTimeoutMs）一律拒绝，--allow-unknown 只放行未知键。',
    ].join('\n')
}

function usageError(reason: string): SuiteInvocation {
    return { kind: 'error', text: `${reason}。\n\n${usageText()}` }
}

/** The two flags `set` / `unset` accept. */
const WRITE_FLAGS = '--dry-run|--allow-unknown'

function parseInit(tokens: readonly string[]): SuiteInvocation {
    let apply = false
    let force = false
    const only: string[] = []
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string
        if (token === '--apply') {
            apply = true
            continue
        }
        if (token === '--force') {
            force = true
            continue
        }
        if (token === '--only') {
            const value = tokens[index + 1]
            if (value === undefined || value.startsWith('--')) return usageError('--only 后面要跟至少一个配置 id（可用逗号分隔）')
            for (const name of value.split(',')) if (name.trim() !== '') only.push(name.trim())
            index += 1
            continue
        }
        return usageError(`init 无法识别的参数 ${JSON.stringify(token)}`)
    }
    return { kind: 'init', apply, force, ...(only.length === 0 ? {} : { only }) }
}

/**
 * Parse one config sub-command, appending the usage to a grammar error.
 *
 * The grammar itself (and the JSON-fragment rule) lives in `command-config.ts`
 * next to the executor; this file keeps the usage text every sub-command shares.
 */
function parseConfig(command: string, remainder: string): SuiteInvocation {
    if (!isConfigSubcommand(command)) return usageError(`未知子命令 ${JSON.stringify(command)}`)
    const parsed = parseConfigInvocation(command, remainder)
    return parsed.kind === 'error' ? usageError(parsed.problem) : parsed
}

/**
 * Parse one command line. Everything is defensive: a non-string, an empty line
 * and an unknown word all end in a defined result, never in an exception.
 * @param rawInput - the text after `suite`.
 * @returns the invocation to run, or an error result carrying the usage.
 */
export function parseSuiteInvocation(rawInput: unknown): SuiteInvocation {
    const text = typeof rawInput === 'string' ? rawInput : ''
    const trimmed = text.trim()
    const tokens = trimmed.split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0 || tokens[0]?.toLowerCase() === 'help') return { kind: 'help' }
    // The raw remainder keeps a JSON value's inner whitespace: `set` is parsed
    // from text, not from re-joined tokens.
    const command = tokens[0] as string
    const remainder = trimmed.slice(command.length)
    const rest = tokens.slice(1)
    switch (command.toLowerCase()) {
        case 'init':
            return parseInit(rest)
        case 'show':
            if (rest.length > 1) return usageError(`show 最多接受一个 plugin（收到 ${rest.map((token) => JSON.stringify(token)).join(' ')}）`)
            return { kind: 'show', ...(rest[0] === undefined ? {} : { plugin: rest[0] }) }
        case 'set':
        case 'unset':
        case 'edit':
            return parseConfig(command.toLowerCase(), remainder)
        case 'doctor':
            if (rest.length > 0) return usageError(`doctor 不接受参数（收到 ${rest.map((token) => JSON.stringify(token)).join(' ')}）`)
            return { kind: 'doctor' }
        default:
            return usageError(`未知子命令 ${JSON.stringify(command)}`)
    }
}

/** The `init` text: the same plan `suite_init` tools render. */
function initText(parsed: { apply: boolean; force: boolean; only?: string[] }, cwd: string, rootDir: string): string {
    return renderInitPlan(
        planSuiteInit({ cwd, rootDir, apply: parsed.apply, force: parsed.force, ...(parsed.only === undefined ? {} : { only: parsed.only }) }),
    )
}

/** The `show` text: the same inspection `suite_config` renders. */
function showText(plugin: string | undefined, cwd: string, layout: ReturnType<typeof resolveLayout>, config: SuiteDoctorConfig): string {
    return renderConfigInspection(inspectSuiteConfig({ cwd, layout, host: config }, plugin === undefined ? undefined : [plugin]))
}

/** Execute one parsed, non-help invocation and return its raw report text. */
async function operationText(
    parsed: Exclude<SuiteInvocation, { kind: 'help' } | { kind: 'error' }>,
    deps: ToolDeps,
    cwd: string,
    agent: AgentLike | undefined,
): Promise<string> {
    const config = deps.configFor(agent)
    const layout = resolveLayout(cwd, config.layout)
    switch (parsed.kind) {
        case 'init':
            return initText(parsed, cwd, layout.configDir)
        case 'show':
            return showText(parsed.plugin, cwd, layout, config)
        case 'doctor':
            return renderSuiteHealth(runSuiteHealth({ cwd, layout, host: config }))
        default:
            // `set` / `unset` / `edit`: the only human write path and the only
            // optional-UI path. Their grammar and refusals live in command-config.ts.
            return runConfigInvocation(parsed, { cwd, layout, getService: (name) => deps.ctx().get(name) })
    }
}

/**
 * Execute one operation and present its report: an nvim-tui float when the host
 * has that OPTIONAL service, the same laid-out report as text otherwise
 * (`render-report.ts` owns both decisions).
 */
async function runOperation(
    parsed: Exclude<SuiteInvocation, { kind: 'help' } | { kind: 'error' }>,
    deps: ToolDeps,
    cwd: string,
    agent: AgentLike | undefined,
): Promise<CommandResultLike> {
    const text = await operationText(parsed, deps, cwd, agent)
    return showReport({ get: (name) => deps.ctx().get(name) }, `suite · ${parsed.kind}`, text)
}

/**
 * Run one invocation. Never throws: the operations refuse by throwing, and a
 * person typing `/suite` has no channel for that — the refusal becomes the error
 * result, word for word.
 * @param deps - configuration, stores, logger and clock.
 * @param invocation - what the registry handed the handler.
 * @returns the result the UI renders.
 */
export async function runSuiteCommand(deps: ToolDeps, invocation: CommandInvocationLike): Promise<CommandResultLike> {
    const parsed = parseSuiteInvocation(invocation?.rawInput)
    if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
    if (parsed.kind === 'help') return { kind: 'success', text: usageText() }
    const agent = invocation?.agent
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
    if (cwd === '') {
        return { kind: 'error', text: '无法确定工作区：命令调用方没有会话目录（session.header.cwd）。/suite 必须在知道工作区的前提下运行。' }
    }
    try {
        return await runOperation(parsed, deps, cwd, agent)
    } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
}

/** What {@link registerSuiteCommand} managed to do. */
export interface CommandRegistration {
    registered: boolean
    /** The registry's own disposer, when registration succeeded. */
    dispose?: () => void
    /** Why it is not registered (or not disposable), for the log. */
    problem?: string
}

/**
 * Register `/suite` when — and only when — the host mounted the command registry.
 * @param context - the host context (only `get` is used).
 * @param deps - configuration, stores, logger and clock.
 * @returns whether it registered, its disposer, and any problem worth logging.
 */
export function registerSuiteCommand(context: { get: (name: string) => unknown }, deps: ToolDeps): CommandRegistration {
    const service = context.get('commands')
    if (!isCommandRuntime(service)) {
        return { registered: false, problem: '宿主没有装配 commands 服务（@deepseek-ai/dsh-commands）：/suite 未注册，工具与提示词段不受影响' }
    }
    try {
        const dispose = service.register({
            name: SUITE_COMMAND_NAME,
            description: SUITE_COMMAND_DESCRIPTION,
            input: { hint: SUITE_COMMAND_HINT },
            handler: (invocation) => runSuiteCommand(deps, invocation),
        })
        if (typeof dispose !== 'function') {
            return { registered: true, problem: 'commands.register() 没有返回 disposer：命令已注册，但插件卸载时无法注销它' }
        }
        return { registered: true, dispose }
    } catch (error) {
        return { registered: false, problem: `注册 /suite 失败（宿主不会因此失去套件工具）：${error instanceof Error ? error.message : String(error)}` }
    }
}

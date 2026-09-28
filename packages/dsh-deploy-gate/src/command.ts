/**
 * Host command templates: rendered, tokenised **without a shell**, refused loudly.
 *
 * This plugin runs deployment commands, so the only thing standing between a
 * configuration file and an arbitrary shell is this module. Two invariants, the
 * same ones `dsh-coverage-gate` enforces for its own commands:
 *
 *  1. **No shell.** A configured line becomes an argv array (`runCommand` spawns
 *     `argv[0]` with `argv.slice(1)`), so `;`, `|`, `&`, `$`, `>`, `<` and
 *     backticks would be handed to the program as literal text — a silently
 *     different command from the one the host wrote. Any of them (and newlines)
 *     is therefore REFUSED with the reason, instead of being passed through.
 *     "Deploy" is exactly the place where a passthrough would be catastrophic.
 *  2. **No silent placeholders.** `{workspace}` and friends are substituted per
 *     token, after tokenisation, so a path containing a space stays one argv
 *     element. An unknown placeholder is an error listing the supported set —
 *     never a literal `{typo}` handed to the program (which would deploy
 *     somewhere else, or nowhere).
 *
 * @module dsh-deploy-gate/command
 */

import { splitCommand } from 'dsh-eng-core'

/**
 * Characters that only mean something to a shell. Their presence in a template
 * means the host expected shell semantics; since none are provided, running the
 * line anyway would execute something else than what was configured.
 */
export const SHELL_METACHARACTERS: readonly string[] = [';', '|', '&', '$', '>', '<', '`']

/** Placeholders a template may use, with what each one renders to. */
export const TEMPLATE_VARS: Readonly<Record<string, string>> = {
    workspace: '工作区（仓库）根目录的绝对路径',
    environment: '环境名（配置里声明的 name）',
    revision: '本次部署/回滚要落到环境上的 revision（git HEAD，或回滚目标 to）',
    target: '回滚目标的部署 id（deploy_rollback 的 to 命中台账时；未知时为空串）',
}

/** Values a caller supplies for the placeholders it uses. */
export type TemplateVars = Partial<Record<keyof typeof TEMPLATE_VARS & string, string>>

/** A rendered argv, or the reason the template was refused. */
export type TokenizeResult = { argv: string[] } | { error: string }

/** Every `{name}` occurrence in a template, in order of appearance. */
export function placeholdersOf(template: string): string[] {
    const found: string[] = []
    for (const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
        const name = match[1] as string
        if (!found.includes(name)) found.push(name)
    }
    return found
}

/** Whether `text` contains a shell metacharacter, and which one. */
export function metacharacterIn(text: string): string | undefined {
    for (const character of SHELL_METACHARACTERS) {
        if (text.includes(character)) return character
    }
    return undefined
}

/** The advice every refusal repeats (one place, so it stays consistent). */
const SHELL_ADVICE =
    '本插件不经 shell 执行部署命令（argv 直传），这些字符会被当成普通文本传给程序，和你写的命令不是一回事。' +
    '请把管道/重定向/变量展开/条件判断写成一个脚本文件，再以 argv 形式调用解释器（例如 `bash scripts/deploy.sh`、`node scripts/deploy.mjs`）。'

/**
 * Check the template itself: shell metacharacters, newlines, unknown placeholders.
 * @param template - the configured command template.
 * @param vars - the values the caller can supply.
 * @returns `undefined` when the template is usable, else the reason.
 */
export function checkTemplate(template: string, vars: TemplateVars): string | undefined {
    if (template.trim() === '') return '部署命令为空'
    if (/[\r\n]/.test(template)) {
        return `部署命令包含换行：多行命令是 shell 脚本，${SHELL_ADVICE}`
    }
    const metacharacter = metacharacterIn(template)
    if (metacharacter !== undefined) {
        return `部署命令包含 shell 元字符 "${metacharacter}"：${SHELL_ADVICE}`
    }
    const unknown = placeholdersOf(template).filter((name) => !(name in TEMPLATE_VARS))
    if (unknown.length > 0) {
        return `部署命令包含未知占位符 ${unknown.map((name) => `{${name}}`).join(', ')}；可用占位符：${Object.keys(TEMPLATE_VARS)
            .map((name) => `{${name}}`)
            .join(', ')}（未知占位符不会被原样传给程序）`
    }
    const missing = placeholdersOf(template).filter((name) => vars[name as keyof TemplateVars] === undefined)
    if (missing.length > 0) {
        return `部署命令使用了 ${missing.map((name) => `{${name}}`).join(', ')}，但本次调用没有该值`
    }
    return undefined
}

/**
 * Render and tokenise a configured command template.
 *
 * Tokenisation uses `dsh-eng-core`'s `splitCommand` (quotes and backslash
 * escapes, no shell), then each placeholder is substituted **inside its token**,
 * so a substituted path may contain spaces without splitting the argv element.
 * @param template - the configured template.
 * @param vars - the placeholder values.
 * @returns the argv array, or the refusal reason.
 */
export function tokenizeTemplate(template: string, vars: TemplateVars = {}): TokenizeResult {
    const problem = checkTemplate(template, vars)
    if (problem !== undefined) return { error: problem }
    const argv: string[] = []
    for (const raw of splitCommand(template)) {
        const token = raw.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => vars[name as keyof TemplateVars] as string)
        // Defence in depth: a substituted VALUE (a revision, an environment name)
        // must not smuggle a shell character into the argv either — the plugin
        // would still not run a shell, but refusing keeps the failure legible.
        const metacharacter = metacharacterIn(token)
        if (metacharacter !== undefined) {
            return {
                error: `部署命令渲染后包含 shell 元字符 "${metacharacter}"（来自某个占位符的值）：请改用不含这些字符的取值。`,
            }
        }
        argv.push(token)
    }
    if (argv.length === 0 || (argv[0] as string) === '') return { error: '部署命令解析后没有可执行程序（argv 为空）' }
    return { argv }
}

/** Render a template to text for display (no tokenisation, no validation). */
export function renderForDisplay(template: string, vars: TemplateVars = {}): string {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name as keyof TemplateVars] ?? match)
}

/** One configured command, resolved for display or execution. */
export type ResolvedCommand = { template: string; argv: string[] } | { template: string; error: string }

/**
 * Resolve a whole command list, keeping the order and every refusal.
 * @param commands - the configured templates.
 * @param vars - the placeholder values.
 */
export function resolveCommands(commands: readonly string[], vars: TemplateVars = {}): ResolvedCommand[] {
    return commands.map((template) => {
        const tokenized = tokenizeTemplate(template, vars)
        return 'argv' in tokenized ? { template, argv: tokenized.argv } : { template, error: tokenized.error }
    })
}

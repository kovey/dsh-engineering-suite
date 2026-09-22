/**
 * Host command templates: rendered, tokenised **without a shell**, refused loudly.
 *
 * The gates execute host-configured commands, so the only thing standing between
 * a configuration file and an arbitrary shell is this module. Two invariants:
 *
 *  1. **No shell.** The command line becomes an argv array (`runCommand` spawns
 *     `argv[0]` with `argv.slice(1)`), so `;`, `|`, `&`, `$`, `>` and `<` would
 *     be handed to the program as literal text — a silently different command
 *     from the one the host wrote. Any of them (and backticks, and newlines) is
 *     therefore REFUSED with the reason, instead of being passed through.
 *  2. **No silent placeholders.** `{reportFile}` and friends are substituted per
 *     token, after tokenisation, so a path containing a space stays one argv
 *     element. An unknown placeholder is an error listing the supported set —
 *     never a literal `{typo}` handed to the program.
 *
 * @module dsh-coverage-gate/command
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
    reportFile: '覆盖率报告文件的绝对路径',
    workspace: '工作区（仓库）根目录的绝对路径',
    base: '增量覆盖率使用的 diff 基准（默认 HEAD）',
    run: '本次重复运行的序号，从 1 开始',
    run0: '本次重复运行的序号，从 0 开始',
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

/**
 * Check the template itself: shell metacharacters, newlines, unknown placeholders.
 * @param template - the configured command template.
 * @param vars - the values the caller can supply.
 * @returns `undefined` when the template is usable, else the reason.
 */
export function checkTemplate(template: string, vars: TemplateVars): string | undefined {
    if (template.trim() === '') return '命令模板为空'
    if (/[\r\n]/.test(template)) {
        return '命令模板包含换行：多行命令是 shell 脚本，本插件不经 shell 执行。请把它写成一个脚本文件，再以 argv 形式调用解释器（例如 `node scripts/coverage.mjs`）。'
    }
    const metacharacter = metacharacterIn(template)
    if (metacharacter !== undefined) {
        return `命令模板包含 shell 元字符 "${metacharacter}"：本插件不经 shell 执行（argv 直传），这些字符会被当成普通文本传给程序，和你写的命令不是一回事。请把管道/重定向/变量展开拆开（例如写成一个脚本文件再调用）。`
    }
    const unknown = placeholdersOf(template).filter((name) => !(name in TEMPLATE_VARS))
    if (unknown.length > 0) {
        return `命令模板包含未知占位符 ${unknown.map((name) => `{${name}}`).join(', ')}；可用占位符：${Object.keys(TEMPLATE_VARS)
            .map((name) => `{${name}}`)
            .join(', ')}`
    }
    const missing = placeholdersOf(template).filter((name) => vars[name as keyof TemplateVars] === undefined)
    if (missing.length > 0) {
        return `命令模板使用了 ${missing.map((name) => `{${name}}`).join(', ')}，但本次调用没有该值（例如没有配置 reportFile 就没有 {reportFile}）`
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
        // Defence in depth: a substituted VALUE (a path, an id) must not smuggle
        // a shell character into the argv either — the gate would still not run a
        // shell, but the refusal keeps the failure legible.
        const metacharacter = metacharacterIn(token)
        if (metacharacter !== undefined) {
            return {
                error: `命令模板渲染后包含 shell 元字符 "${metacharacter}"（来自某个占位符的值）：请改用不含这些字符的路径或命令参数。`,
            }
        }
        argv.push(token)
    }
    if (argv.length === 0 || (argv[0] as string) === '') return { error: '命令模板解析后没有可执行程序（argv 为空）' }
    return { argv }
}

/** Render a template to text for display (no tokenisation, no validation). */
export function renderForDisplay(template: string, vars: TemplateVars = {}): string {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name as keyof TemplateVars] ?? match)
}

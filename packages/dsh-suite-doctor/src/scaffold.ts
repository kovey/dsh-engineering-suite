/**
 * `suite_init`'s planning and writing.
 *
 * Two rules shape this module:
 *
 *  - **Dry run by default.** Planning and writing are the same traversal, so the
 *    plan a dry run prints is EXACTLY what `apply: true` would do; a plan built
 *    by a second code path is a plan that can disagree with the write.
 *  - **Never overwrite by default.** An existing file is `skip` with the bytes it
 *    already has, because these files are the trust root: a scaffold run must not
 *    undo a repository's reviewed thresholds. `force: true` is the only path that
 *    replaces them, and it says `overwrite` in the report.
 *
 * Idempotency falls out of determinism: the generated text depends only on the
 * descriptor and the detected language, so a second `apply` writes nothing (all
 * entries are `skip`) and the layout root stays byte-identical.
 *
 * @module dsh-suite-doctor/scaffold
 */

import fs from 'node:fs'
import path from 'node:path'
import { configText, detectLanguage, selectDescriptors, type SuiteConfigDescriptor, type SuiteLanguage } from './scaffold-catalog.js'

/** What happened (or would happen) to one file. */
export type InitAction = 'write' | 'skip' | 'overwrite'

/** One file in the plan. */
export interface InitEntry {
    /** Absolute path. */
    path: string
    /** Workspace-relative path, POSIX separators (what the report prints). */
    relative: string
    action: InitAction
    /** Size of the bytes involved: the existing file for `skip`, the new text otherwise. */
    bytes: number
}

/** The whole plan (and, after `apply`, what was done). */
export interface InitPlan {
    cwd: string
    rootDir: string
    language: SuiteLanguage
    dryRun: boolean
    entries: InitEntry[]
    /** Non-fatal notes (currently: none — kept so the shape can grow honestly). */
    problems: string[]
}

/** Inputs of {@link planSuiteInit}. */
export interface InitInput {
    cwd: string
    /** The layout root the suite reads configuration from (`Layout.configDir`). */
    rootDir: string
    /** Write for real (default false). */
    apply?: boolean
    /** Replace existing files (default false). */
    force?: boolean
    /** Restrict to these config ids/aliases/file names. */
    only?: readonly string[]
}

function relativeTo(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    return relative === '' ? path.basename(target) : relative.split(path.sep).join('/')
}

function sizeOf(file: string): number {
    try {
        return fs.statSync(file).size
    } catch {
        return 0
    }
}

function writeText(target: string, text: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
}

/**
 * Decide one file's action and (when applying) write it.
 *
 * Split from {@link planSuiteInit} because the decision tree is the safety
 * property: an existing file is `skip` and is never opened for writing.
 * @param input - the caller's workspace, root and flags.
 * @param descriptor - the file to plan.
 * @param language - the bytes to generate.
 * @returns the entry the report prints.
 */
function planEntry(input: InitInput, descriptor: SuiteConfigDescriptor, language: SuiteLanguage): InitEntry {
    const target = path.join(input.rootDir, descriptor.file)
    const relative = relativeTo(input.cwd, target)
    const exists = fs.existsSync(target)
    const action: InitAction = exists ? (input.force === true ? 'overwrite' : 'skip') : 'write'
    if (action === 'skip') return { path: target, relative, action, bytes: sizeOf(target) }
    const text = configText(descriptor, language)
    if (input.apply === true) writeText(target, text)
    return { path: target, relative, action, bytes: Buffer.byteLength(text) }
}

/**
 * Plan (and optionally perform) the scaffold.
 *
 * `only` is validated up front by {@link selectDescriptors}: an unknown name
 * throws before anything is written, so a typo cannot produce a half-applied
 * scaffold that looks intentional.
 * @param input - workspace, layout root and the three flags.
 * @returns every file, its action and its byte count.
 */
export function planSuiteInit(input: InitInput): InitPlan {
    const descriptors = selectDescriptors(input.only)
    const language = detectLanguage(input.cwd)
    const entries = descriptors.map((descriptor) => planEntry(input, descriptor, language))
    return { cwd: input.cwd, rootDir: input.rootDir, language, dryRun: input.apply !== true, entries, problems: [] }
}

const ACTION_ICON: Record<InitAction, string> = { write: '➕', skip: '⏭️', overwrite: '♻️' }

/**
 * Render one plan for a person (tool output and `/suite init` share this text).
 * @param plan - the plan to render.
 * @returns Chinese text, one line per file plus the next step.
 */
export function renderInitPlan(plan: InitPlan): string {
    const written = plan.entries.filter((entry) => entry.action === 'write').length
    const overwritten = plan.entries.filter((entry) => entry.action === 'overwrite').length
    const skipped = plan.entries.filter((entry) => entry.action === 'skip').length
    const lines = [
        `suite_init —— 套件配置脚手架（${plan.dryRun ? 'dry-run：只打印计划，未写盘；apply:true 才写入' : 'apply：已写盘'}）`,
        `工作区：${plan.cwd}；布局根：${relativeTo(plan.cwd, plan.rootDir) || '.'}；检测语言：${plan.language}`,
    ]
    for (const entry of plan.entries) lines.push(`${ACTION_ICON[entry.action]} ${entry.action.padEnd(9)} ${entry.relative}  (${entry.bytes} B)`)
    lines.push(`合计：写入 ${written}、覆盖 ${overwritten}、跳过（已存在）${skipped}；共 ${plan.entries.length} 份`)
    if (plan.dryRun) lines.push('下一步：suite_init({ apply: true })（已存在的文件默认跳过；force:true 才覆盖）')
    else lines.push('说明：这些是保守默认值，请按仓库实际情况复核命令与阈值；重复执行是幂等的（第二次全部 skip）。')
    return `${lines.join('\n')}\n`
}

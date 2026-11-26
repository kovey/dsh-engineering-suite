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
 *  - **Creation location is not the read location.** The target comes from
 *    `scaffoldConfigDir` (`dsh-eng-core/scaffold`), never from
 *    `resolveLayout().configDir`: that read path falls back to `.dsh/` on an
 *    empty repository, which is how ten config files once landed in the legacy
 *    root. The plan therefore carries the layout and the reason, and the report
 *    prints both.
 *
 * Idempotency falls out of determinism: the generated text depends only on the
 * descriptor and the detected ecosystems (the primary one for nine documents,
 * every one of them for the supply-chain gate), so a second `apply` writes
 * nothing (all entries are `skip`) and the layout root stays byte-identical.
 *
 * @module dsh-suite-doctor/scaffold
 */

import fs from 'node:fs'
import path from 'node:path'
import { scaffoldConfigDir, type ScaffoldLayout } from 'dsh-eng-core/scaffold'
import type { LayoutOptions } from 'dsh-eng-core'
import { AUDIT_COMMAND_BY_LANGUAGE } from './scaffold-audit.js'
import { configText, SUITE_CONFIGS, SUITE_DOCTOR_ID, selectDescriptors, type SuiteConfigDescriptor, type SuiteLanguage } from './scaffold-catalog.js'
import { generatedLanguages, supplyChainDeps, type SupplyChainDeps } from './scaffold-content.js'
import { detectLanguageInfo, type LanguageMatch } from './scaffold-detect.js'
import { coverageNoteOf, defaultsOf } from './scaffold-languages.js'

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
    /** Absolute directory the files are written to (decided by `scaffoldConfigDir`). */
    rootDir: string
    /** Which branch decided `rootDir`: explicit host override / namespace / legacy. */
    layout: ScaffoldLayout
    /** Why that root was chosen (printed verbatim; the legacy branch says "沿用遗留位置"). */
    reason: string
    /** Primary ecosystem: the one the single-ecosystem documents are generated for. */
    language: SuiteLanguage
    /**
     * Every ecosystem the documents are generated for, in detection order.
     *
     * Equals the detected list, EXCEPT on an empty repository where it is the
     * documented `ts` default (a default is not a detection, so {@link matches}
     * stays empty and the report says so).
     */
    languages: SuiteLanguage[]
    /** Which root file evidenced each detected ecosystem; empty when the default applied. */
    matches: LanguageMatch[]
    /** The manifest that decided the primary ecosystem, or why the default applied (printed verbatim). */
    languageReason: string
    /** Why the coverage command is empty, for the ecosystems whose report format is unsupported. */
    coverageNote?: string
    /** What the supply-chain gate was stocked with (manifests union, audit commands, skipped). */
    supplyChain: SupplyChainDeps
    dryRun: boolean
    entries: InitEntry[]
    /** Non-fatal notes (currently: none — kept so the shape can grow honestly). */
    problems: string[]
}

/** Inputs of {@link planSuiteInit}. */
export interface InitInput {
    cwd: string
    /**
     * Explicit layout root override (the host's `layout.rootDir`).
     *
     * OMITTED on purpose by `/suite init` and `suite_init`: the creation target
     * is a different question than the read path, so a caller that does not have
     * an explicit host override must let `scaffoldConfigDir` decide (namespace on
     * an empty or migrated repository, legacy only when legacy files exist).
     */
    rootDir?: string
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

/**
 * Build {@link InitInput} for one invocation.
 *
 * The host's explicit `layout.rootDir` is the ONLY thing that passes through:
 * `layout.configDir` is a READ path whose empty-repository fallback is `.dsh/`,
 * and using it as the write target is exactly the defect `scaffoldConfigDir`
 * fixes. Both `/suite init` and `suite_init` come through here, so they cannot
 * disagree about the directory.
 * @param cwd - workspace root (a session's `header.cwd`).
 * @param layout - the host's layout options (only `rootDir` is used).
 * @param flags - the invocation's dry-run/force/only flags.
 * @returns the input {@link planSuiteInit} expects.
 */
export function initInputOf(cwd: string, layout: LayoutOptions, flags: { apply?: boolean; force?: boolean; only?: readonly string[] } = {}): InitInput {
    return {
        cwd,
        ...(layout.rootDir === undefined ? {} : { rootDir: layout.rootDir }),
        apply: flags.apply === true,
        force: flags.force === true,
        ...(flags.only === undefined ? {} : { only: flags.only }),
    }
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
 * @param input - the caller's workspace and flags.
 * @param rootDir - absolute directory the file belongs to (already decided).
 * @param descriptor - the file to plan.
 * @param language - the PRIMARY ecosystem (the nine single-ecosystem documents).
 * @param languages - every generated ecosystem (the supply-chain gate pools these).
 * @returns the entry the report prints.
 */
function planEntry(input: InitInput, rootDir: string, descriptor: SuiteConfigDescriptor, language: SuiteLanguage, languages: readonly SuiteLanguage[]): InitEntry {
    const target = path.join(rootDir, descriptor.file)
    const relative = relativeTo(input.cwd, target)
    const exists = fs.existsSync(target)
    const action: InitAction = exists ? (input.force === true ? 'overwrite' : 'skip') : 'write'
    if (action === 'skip') return { path: target, relative, action, bytes: sizeOf(target) }
    const text = configText(descriptor, language, languages)
    if (input.apply === true) writeText(target, text)
    return { path: target, relative, action, bytes: Buffer.byteLength(text) }
}

/**
 * Plan (and optionally perform) the scaffold.
 *
 * The write target comes from `scaffoldConfigDir`, NOT from a resolved read
 * layout: an empty repository reads `.dsh/` but must be CREATED in the namespace,
 * otherwise the scaffold splits from the convention it documents. The caller's
 * catalog is passed along so a config file this package adds later still counts
 * as evidence of a legacy root.
 *
 * `only` is validated up front by {@link selectDescriptors}: an unknown name
 * throws before anything is written, so a typo cannot produce a half-applied
 * scaffold that looks intentional.
 *
 * Detection is computed ONCE: the nine single-ecosystem documents read the
 * primary language, the supply-chain gate reads every detected one, and the
 * plan's `supplyChain` field is the same projection the written file is built
 * from.
 * @param input - workspace, explicit root override (if any) and the three flags.
 * @returns every file, its action, its byte count and the chosen layout root.
 */
export function planSuiteInit(input: InitInput): InitPlan {
    const descriptors = selectDescriptors(input.only)
    const target = scaffoldConfigDir(input.cwd, {
        ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
        legacyFiles: [...SUITE_CONFIGS.map((descriptor) => descriptor.file), 'standards-baseline.json', `${SUITE_DOCTOR_ID}.json`],
    })
    const detection = detectLanguageInfo(input.cwd)
    const languages = generatedLanguages(detection.language, detection.languages)
    const entries = descriptors.map((descriptor) => planEntry(input, target.dir, descriptor, detection.language, languages))
    const coverageNote = coverageNoteOf(detection.language)
    return {
        cwd: input.cwd,
        rootDir: target.dir,
        layout: target.layout,
        reason: target.reason,
        language: detection.language,
        languages,
        matches: detection.matches,
        languageReason: detection.reason,
        ...(coverageNote === undefined ? {} : { coverageNote }),
        supplyChain: supplyChainDeps(detection.language, detection.languages),
        dryRun: input.apply !== true,
        entries,
        problems: [],
    }
}

const ACTION_ICON: Record<InitAction, string> = { write: '➕', skip: '⏭️', overwrite: '♻️' }

/** `(namespace)` / `(legacy)` / `(explicit)` — the branch that chose the root. */
function layoutLabel(layout: ScaffoldLayout): string {
    return `（${layout}）`
}

/** `go（命中 go.mod；manifests go.mod、go.sum）` — one ecosystem, its evidence, its watch list. */
function ecosystemLine(match: LanguageMatch): string {
    return `${match.language}（命中 ${match.manifest}；manifests ${defaultsOf(match.language).manifests.join('、')}）`
}

/**
 * The `审计命令` cell: each command annotated with the ecosystem(s) that named it.
 *
 * Read from `plan.supplyChain.auditCommands` (the value the file gets) rather
 * than recomputed, so the report cannot list a command that was not written —
 * only the OWNER labels come from the table.
 */
function auditCommandSummary(plan: InitPlan): string {
    if (plan.supplyChain.auditCommands.length === 0) return '无（检测到的生态都没有标准审计器，见"跳过"）'
    const owners = new Map<string, SuiteLanguage[]>()
    for (const language of plan.languages) {
        const command = AUDIT_COMMAND_BY_LANGUAGE[language]
        if (command === undefined) continue
        owners.set(command, [...(owners.get(command) ?? []), language])
    }
    return plan.supplyChain.auditCommands.map((command) => `${command}（${(owners.get(command) ?? []).join('、')}）`).join('、')
}

/**
 * The `语言与供应链` block: every detected ecosystem with its evidence and watch
 * list, the manifests union, the audit commands, and what was skipped WHY.
 *
 * Nothing is collapsed into a count-only line: a repository with two ecosystems
 * is exactly where "which one did it pick" must be readable, and an ecosystem
 * left without an auditor must name the way out instead of going silent.
 * @param plan - the plan to describe.
 * @returns the section's lines (heading included).
 */
function supplyChainLines(plan: InitPlan): string[] {
    const detected =
        plan.matches.length === 0
            ? `无（没有找到任何已知 manifest，按约定默认 ${plan.language}）`
            : plan.matches.map(ecosystemLine).join('、')
    const ledger = plan.supplyChain
    const skipped =
        ledger.skipped.length === 0
            ? '- 跳过：无（生成所用的生态都有标准审计器）'
            : `- 跳过（${ledger.skipped.length}）：${ledger.skipped.map((entry) => `${entry.language} —— ${entry.note}`).join('；')}`
    return [
        '语言与供应链：',
        `- 检测到的生态（${plan.matches.length}）：${detected}`,
        `- manifests 并集（${ledger.manifests.length}）：${ledger.manifests.join('、')}`,
        `- 审计命令（${ledger.auditCommands.length}）：${auditCommandSummary(plan)}`,
        skipped,
    ]
}

/**
 * Render one plan for a person (tool output and `/suite init` share this text).
 * @param plan - the plan to render.
 * @returns Chinese text, one line per file plus the layout decision and next step.
 */
export function renderInitPlan(plan: InitPlan): string {
    const written = plan.entries.filter((entry) => entry.action === 'write').length
    const overwritten = plan.entries.filter((entry) => entry.action === 'overwrite').length
    const skipped = plan.entries.filter((entry) => entry.action === 'skip').length
    const rootDir = relativeTo(plan.cwd, plan.rootDir) || '.'
    const lines = [
        `suite_init —— 套件配置脚手架（${plan.dryRun ? 'dry-run：只打印计划，未写盘；apply:true 才写入' : 'apply：已写盘'}）`,
        `工作区：${plan.cwd}；布局根：${rootDir}${layoutLabel(plan.layout)}；检测语言：${plan.language}`,
        `语言判定：${plan.languageReason}`,
        `布局判定：${plan.reason}`,
    ]
    // An empty coverage command is a decision, not an omission: say why, where a
    // person reading the plan can act on it.
    if (plan.coverageNote !== undefined) lines.push(`覆盖率：${plan.language} 的命令留空 —— ${plan.coverageNote}`)
    lines.push(...supplyChainLines(plan))
    for (const entry of plan.entries) lines.push(`${ACTION_ICON[entry.action]} ${entry.action.padEnd(9)} ${entry.relative}  (${entry.bytes} B)`)
    lines.push(`合计：写入 ${written}、覆盖 ${overwritten}、跳过（已存在）${skipped}；共 ${plan.entries.length} 份`)
    if (plan.dryRun) lines.push('下一步：suite_init({ apply: true })（已存在的文件默认跳过；force:true 才覆盖）')
    else lines.push('说明：这些是保守默认值，请按仓库实际情况复核命令与阈值；重复执行是幂等的（第二次全部 skip）。')
    return `${lines.join('\n')}\n`
}

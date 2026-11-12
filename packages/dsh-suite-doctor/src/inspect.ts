/**
 * `suite_config`'s read-only view: what each plugin's project file says, where
 * the effective values come from, and what is wrong with the file.
 *
 * The report answers three questions per plugin, and keeps them apart:
 *
 *  1. **Is there a repository file, and did it apply?** `repo` = at least one
 *     allow-listed key applied; `profile` = a file exists but contributes
 *     nothing (malformed, or every key refused), so the profile / built-in
 *     values stay in force; `default` = no file at all.
 *  2. **Which keys are wrong?** Three distinct findings, each naming the file
 *     AND the key: unparsable JSON, a top-level key the plugin does not read
 *     (a typo), and a host-only key the project may not override.
 *  3. **Do the path values stay inside the workspace?** A repository may relocate
 *     its own artifacts, never point them outside itself; the containment check
 *     is the same one every plugin applies when it accepts those keys.
 *
 * Read-only, strictly: no file is created and no cache is trusted — the view is
 * read uncached, because an inspector that reports yesterday's file is worse
 * than one that reports nothing.
 *
 * @module dsh-suite-doctor/inspect
 */

import fs from 'node:fs'
import path from 'node:path'
import { containedPath, loadProjectConfig, projectConfigFile, type Layout } from 'dsh-eng-core'
import { resolveEffectiveConfig, type SuiteDoctorConfig } from './config.js'
import { SUITE_CONFIGS, SUITE_DOCTOR_ID, descriptorForName, type SuiteConfigDescriptor } from './scaffold-catalog.js'

/** Where the effective values come from. */
export type ConfigSource = 'repo' | 'profile' | 'default'

/** One plugin's inspected project file. */
export interface ConfigInspection {
    id: string
    title: string
    /** The file that was consulted (workspace-relative, POSIX separators). */
    file: string
    present: boolean
    source: ConfigSource
    /** Keys found in the file, in file order. */
    keys: string[]
    /** The parsed document (absent when the file is absent or unparsable). */
    value?: Record<string, unknown>
    /** Unknown / host-only keys and file-level parse problems, each naming file+key. */
    problems: string[]
    /** Path-valued keys that resolve outside the workspace. */
    pathProblems: string[]
}

/** The whole view. */
export interface SuiteInspection {
    cwd: string
    rootDir: string
    rows: ConfigInspection[]
    problems: string[]
}

/** Inputs of {@link inspectSuiteConfig}. */
export interface InspectInput {
    cwd: string
    layout: Layout
    /** The suite-doctor configuration in force (for the plugin's own row). */
    host?: SuiteDoctorConfig
}

/** Path-valued keys worth a containment check, per plugin id. */
const PATH_KEYS: Readonly<Record<string, readonly string[]>> = {
    'spec-gate': ['planFile', 'adrDir', 'adrIndexFile'],
    'evidence-gate': ['releasesFile', 'releasesDir'],
    'coverage-gate': ['reportFile'],
    'interaction-gate': ['ledgerFile', 'outboxFile', 'attentionFile'],
    'deploy-gate': ['ledgerFile'],
    'supply-chain-gate': ['secretScan.allowlistFile'],
}

/** Every id `suite_config` accepts (`plugin` filter and `/suite show`). */
export const INSPECTABLE_IDS: readonly string[] = [...SUITE_CONFIGS.map((entry) => entry.id), SUITE_DOCTOR_ID]

/** Reasons for the keys every plugin keeps host-owned, in one place. */
const HOST_ONLY_REASONS: Readonly<Record<string, string>> = {
    enabled: '插件开关是部署决定，项目不能关掉对自己仓库的检查',
    logFile: '日志落点是部署决定',
    logFileTemplate: '日志落点是部署决定',
    layout: '台账/工件位置是部署决定，项目不能迁移它们',
    rootDir: '台账/工件位置是部署决定，项目不能迁移它们',
    missionsDir: '台账/工件位置是部署决定，项目不能迁移它们',
    specsDir: '台账/工件位置是部署决定，项目不能迁移它们',
    prompt: '系统提示词小节由 profile 装配决定',
    goNoGo: 'go/no-go 上限是宿主决定（仓库能放宽它就能自己绕过交付门禁）',
    allowForceOverride: 'force 逃生舱只能由宿主显式开启（项目文件是模型可经 shell 改写的路径）',
    approversFile: '审批人名单的权威在宿主：仓库不能给自己发权限',
    im: '审批发到哪个会话、由谁回答按工作区由宿主分配',
}

function reasonFor(key: string): string {
    return HOST_ONLY_REASONS[key] ?? '它不是该插件允许项目级覆盖的键（profile 是上限）'
}

/** What one top-level key means for a project file. */
export type KeyVerdict = { kind: 'ok' } | { kind: 'unknown' } | { kind: 'forbidden'; reason: string }

/**
 * Classify one top-level key against the owning plugin's contract.
 *
 * The SINGLE answer to "may this key live in the project file": `suite_config`
 * renders it as a problem, `/suite set` refuses the write with the same verdict.
 * Two implementations would drift, and the drift would look like the inspector
 * accepting a key the editor silently drops.
 * @param descriptor - the owning plugin's catalog entry.
 * @param key - the top-level key the project file would carry.
 * @returns `ok`, `unknown` (not a key the plugin reads) or `forbidden` (host-only).
 */
export function classifyKey(descriptor: SuiteConfigDescriptor, key: string): KeyVerdict {
    if (!descriptor.knownKeys.includes(key)) return { kind: 'unknown' }
    if (descriptor.projectOwned !== true && !descriptor.overridableKeys.includes(key)) return { kind: 'forbidden', reason: reasonFor(key) }
    return { kind: 'ok' }
}

function relativeTo(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
}

/** Read one dotted key (`secretScan.allowlistFile`) from a document. */
function valueAt(raw: Record<string, unknown>, dotted: string): unknown {
    let current: unknown = raw
    for (const part of dotted.split('.')) {
        if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

function pathProblemsOf(descriptor: SuiteConfigDescriptor, value: Record<string, unknown>, row: ConfigInspection, cwd: string): string[] {
    const problems: string[] = []
    for (const key of PATH_KEYS[descriptor.id] ?? []) {
        const candidate = valueAt(value, key)
        if (typeof candidate !== 'string' || candidate.trim() === '') continue
        const contained = containedPath(cwd, candidate.trim(), `${row.file}: ${key}`)
        if (!contained.ok && contained.problem !== undefined) problems.push(contained.problem)
    }
    return problems
}

/**
 * Classify one document's keys and decide where its values come from.
 * @returns source, validation problems and the keys in file order.
 */
function validateKeys(descriptor: SuiteConfigDescriptor, raw: Record<string, unknown>, row: ConfigInspection): { source: ConfigSource; problems: string[] } {
    const keys = Object.keys(raw)
    const problems: string[] = []
    let applied = 0
    for (const key of keys) {
        const verdict = classifyKey(descriptor, key)
        if (verdict.kind === 'unknown') {
            problems.push(`${row.file}: 未知顶层键 "${key}"（${descriptor.id} 不读这个键：检查拼写，或写进拥有它的插件配置）`)
            continue
        }
        if (verdict.kind === 'forbidden') {
            problems.push(`${row.file}: 键 "${key}" 不能在项目级覆盖：${verdict.reason}；已忽略`)
            continue
        }
        applied += 1
    }
    return { source: applied > 0 ? 'repo' : 'profile', problems }
}

/** Build one row from the plugin config file that is actually consulted. */
function rowOf(descriptor: SuiteConfigDescriptor, cwd: string, layout: Layout): ConfigInspection {
    const loaded = loadProjectConfig<Record<string, unknown>>(layout, descriptor.id, { cache: false })
    const row: ConfigInspection = {
        id: descriptor.id,
        title: descriptor.title,
        file: relativeTo(cwd, loaded.file),
        present: loaded.present,
        source: loaded.present ? 'profile' : 'default',
        keys: [],
        problems: [...loaded.problems],
        pathProblems: [],
    }
    if (loaded.value === undefined) return row
    const raw = loaded.value
    row.keys = Object.keys(raw)
    row.value = raw
    const verdict = validateKeys(descriptor, raw, row)
    row.source = verdict.source
    row.problems.push(...verdict.problems)
    row.pathProblems = pathProblemsOf(descriptor, raw, row, cwd)
    return row
}

/** Build the suite-doctor's own row from the resolved effective configuration. */
function selfRow(cwd: string, layout: Layout, host: SuiteDoctorConfig): ConfigInspection {
    const effective = resolveEffectiveConfig(host, layout)
    const file = projectConfigFile(layout, SUITE_DOCTOR_ID)
    return {
        id: SUITE_DOCTOR_ID,
        title: '套件自检（本插件）',
        file: relativeTo(cwd, effective.file === '' ? file : effective.file),
        present: fs.existsSync(effective.file === '' ? file : effective.file),
        source: effective.source === 'project' ? 'repo' : 'profile',
        keys: Object.keys(effective.config),
        value: { ...effective.config } as unknown as Record<string, unknown>,
        problems: effective.problems,
        pathProblems: [],
    }
}

/**
 * Inspect every scaffolded config file (or the selected ones).
 * @param input - workspace, layout and the suite-doctor configuration in force.
 * @param only - ids/aliases/file names to restrict to; an unknown id throws.
 * @returns the rows and the aggregated problems.
 */
export function inspectSuiteConfig(input: InspectInput, only?: readonly string[]): SuiteInspection {
    const selected = selectInspectable(only)
    const rows: ConfigInspection[] = []
    for (const descriptor of SUITE_CONFIGS) {
        if (selected.includes(descriptor.id)) rows.push(rowOf(descriptor, input.cwd, input.layout))
    }
    if (selected.includes(SUITE_DOCTOR_ID) && input.host !== undefined) rows.push(selfRow(input.cwd, input.layout, input.host))
    return {
        cwd: input.cwd,
        rootDir: relativeTo(input.cwd, input.layout.configDir),
        rows,
        problems: rows.flatMap((row) => [...row.problems, ...row.pathProblems]),
    }
}

function selectInspectable(only?: readonly string[]): string[] {
    if (only === undefined) return [...INSPECTABLE_IDS]
    if (only.length === 0) throw new Error(`suite_config: 没有选中任何配置；可用：${INSPECTABLE_IDS.join('、')}`)
    const selected: string[] = []
    const unknown: string[] = []
    for (const name of only) {
        const id = descriptorForName(name)?.id ?? (name.trim().toLowerCase() === SUITE_DOCTOR_ID ? SUITE_DOCTOR_ID : undefined)
        if (id === undefined) unknown.push(name)
        else if (!selected.includes(id)) selected.push(id)
    }
    if (unknown.length > 0) throw new Error(`suite_config: 不认识的配置名 ${unknown.map((name) => JSON.stringify(name)).join('、')}；可用：${INSPECTABLE_IDS.join('、')}`)
    return selected
}

/** One rendered value, bounded: a huge config must not become an unbounded report. */
function displayValue(value: Record<string, unknown>): string {
    const text = JSON.stringify(value)
    return text.length <= 600 ? text : `${text.slice(0, 600)}…（已截断，共 ${text.length} 字符）`
}

const SOURCE_LABEL: Record<ConfigSource, string> = {
    repo: '仓库文件生效',
    profile: '仓库文件未生效（profile/内置默认值）',
    default: '没有仓库文件（profile/内置默认值）',
}

/** Render one inspection for a person (tool output and `/suite show` share it). */
export function renderConfigInspection(inspection: SuiteInspection): string {
    const lines = [
        'suite_config —— 门禁配置（只读）',
        `工作区：${inspection.cwd}；布局根：${inspection.rootDir}`,
        '来源：repo=仓库文件生效；profile=有文件但没有可用键；default=没有仓库文件（后两者都是 profile/内置默认值说了算）',
        '说明：本工具看不到其它插件的 profile 行，所以只展示仓库文件的覆盖值；未列出的键保持 profile/内置默认（不猜具体值）。',
    ]
    for (const row of inspection.rows) {
        const clean = row.problems.length === 0 && row.pathProblems.length === 0
        lines.push('', `- ${clean ? '✅' : '⚠️'} [${row.source}] ${row.id}（${row.title}）  ${row.file}`)
        if (row.value !== undefined) lines.push(`    文件键：${row.keys.length === 0 ? '（空对象）' : row.keys.join('、')}`)
        lines.push(`    生效来源：${SOURCE_LABEL[row.source]}`)
        if (row.value !== undefined && row.source === 'repo') lines.push(`    值：${displayValue(row.value)}`)
        for (const problem of row.problems) lines.push(`    ❌ ${problem}`)
        for (const problem of row.pathProblems) lines.push(`    ❌ ${problem}`)
        if (row.problems.length > 0 || row.pathProblems.length > 0) continue
        if (row.value === undefined) lines.push('    ℹ️ 没有仓库文件：使用 profile 或插件内置默认值（这不是错误）')
        else lines.push('    ✅ 文件可解析，键名与项目级覆盖规则都合法')
    }
    const repo = inspection.rows.filter((row) => row.source === 'repo').length
    lines.push('', `合计：${inspection.rows.length} 份；仓库文件生效 ${repo}、未生效/默认 ${inspection.rows.length - repo}；问题 ${inspection.problems.length} 条`)
    if (inspection.problems.length > 0) lines.push('下一步：修正上面点名的文件与键（未知键多半是拼写错误；被禁止的项目级键要放到 profile）。')
    return `${lines.join('\n')}\n`
}

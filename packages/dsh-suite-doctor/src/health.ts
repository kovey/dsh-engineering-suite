/**
 * `/suite doctor` — config-level health across the ten scaffolded files.
 *
 * This is deliberately NOT a second `suite_status`: that tool merges eng-core's
 * offline checks with LIVE host facts (mounted plugins, mission, channels), and it
 * needs a running host. `doctor` answers the narrower question a person asks right
 * after scaffolding or while reviewing a config diff: **is each file present,
 * parseable, semantically usable, and are its key paths resolvable?**
 *
 * States follow the rest of the suite, and the vocabulary is load-bearing:
 *
 *  - `ok` — checked and usable;
 *  - `partial` — present but incomplete (no required command, thresholds without a
 *    source, a deploy environment without a declared rollback);
 *  - `missing` — required by the scaffold and absent;
 *  - `unknown` — could not be judged (unparsable JSON, or a dependent fact that
 *    cannot be read because the file it needs is absent). `unknown` is NOT a pass.
 *
 * Read-only: it runs no command, creates no file and changes no mission.
 *
 * @module dsh-suite-doctor/health
 */

import fs from 'node:fs'
import { containedPath, loadProjectConfig, projectArtifactOf, type Layout } from 'dsh-eng-core'
import type { SuiteDoctorConfig } from './config.js'
import { inspectSuiteConfig, type ConfigInspection, type SuiteInspection } from './inspect.js'
import { SUITE_CONFIGS } from './scaffold-catalog.js'

/** The four states, same meaning as everywhere else in the suite. */
export type HealthState = 'ok' | 'partial' | 'missing' | 'unknown'

/** One health finding. */
export interface HealthCheck {
    id: string
    state: HealthState
    label: string
    detail: string
    fix?: string
}

/** The whole config-level health report. */
export interface SuiteHealth {
    cwd: string
    rootDir: string
    checks: HealthCheck[]
    /** The worst state among the checks (`unknown` is worse than `partial`). */
    state: HealthState
}

/** Inputs of {@link runSuiteHealth}. */
export interface HealthInput {
    cwd: string
    layout: Layout
    host?: SuiteDoctorConfig
}

const STATE_RANK: Record<HealthState, number> = { ok: 0, partial: 1, unknown: 2, missing: 3 }

const STATE_ICON: Record<HealthState, string> = { ok: '✅', partial: '⚠️', missing: '❌', unknown: '❔' }

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The one state a config row reports. */
function stateOfRow(row: ConfigInspection | undefined): HealthState {
    if (row === undefined || !row.present) return 'missing'
    if (row.value === undefined) return 'unknown'
    return row.problems.length + row.pathProblems.length > 0 ? 'partial' : 'ok'
}

function rowDetail(row: ConfigInspection | undefined): string {
    if (row === undefined) return '无法读取该配置行'
    if (!row.present) return `没有 ${row.file}`
    if (row.value === undefined) return row.problems[0] ?? `${row.file} 存在但无法解析`
    const problems = [...row.problems, ...row.pathProblems]
    if (problems.length === 0) return `${row.file}（来源 ${row.source}；键：${row.keys.join('、') || '（空）'}）`
    return `${row.file}：${problems.join('；')}`
}

function configCheck(id: string, title: string, row: ConfigInspection | undefined): HealthCheck {
    const state = stateOfRow(row)
    const fix =
        state === 'missing'
            ? `suite_init({ apply: true, only: ["${id}"] })`
            : state === 'ok'
              ? undefined
              : state === 'unknown'
                ? '文件不是合法 JSON 对象：修正它，或删除后重新 suite_init'
                : '修正上面点名的文件与键（未知键多半是拼写错误；被禁止的项目级键要放到 profile）'
    return { id: `config.${id}`, state, label: `${title}配置`, detail: rowDetail(row), ...(fix === undefined ? {} : { fix }) }
}

/** A dependent check cannot be judged without its config: say so, never "ok". */
function dependentCheck(id: string, label: string, row: ConfigInspection | undefined, evaluate: (value: Record<string, unknown>) => HealthCheck): HealthCheck {
    if (row === undefined || !row.present || row.value === undefined) {
        return { id, state: 'unknown', label, detail: `${row?.file ?? '配置文件'} 缺失或无法解析：这一项无法判断（不是通过）`, fix: `suite_init({ apply: true, only: ["${row?.id ?? 'quality-gate'}"] })` }
    }
    return evaluate(row.value)
}

function qualityCheck(row: ConfigInspection | undefined, cwd: string): HealthCheck {
    return dependentCheck('quality.commands', '质量门禁命令列表', row, (value) => {
        const commands = asArray(value['commands'])
        const required = commands.filter((entry) => asRecord(entry)['required'] === true).length
        const problems: string[] = []
        for (const entry of commands) {
            const commandCwd = asString(asRecord(entry)['cwd'])
            if (commandCwd === '') continue
            const label = `${asString(asRecord(entry)['id']) || '(未命名命令)'} 的 cwd`
            const contained = containedPath(cwd, commandCwd, label)
            if (!contained.ok && contained.problem !== undefined) problems.push(contained.problem)
        }
        if (commands.length === 0) return { id: 'quality.commands', state: 'missing', label: '质量门禁命令列表', detail: 'commands 为空：quality_gate_run 没有命令可跑，交付拿不到确定性裁决', fix: '在 quality-gate.json 写 commands（至少一条 required 的测试命令）' }
        if (required === 0) return { id: 'quality.commands', state: 'partial', label: '质量门禁命令列表', detail: `${commands.length} 条命令但没有一条 required：失败只会是 WARN，交付不会被拦住`, fix: '把真正决定交付的那条命令标成 required: true' }
        const detail = `${commands.length} 条命令（${required} 条 required）${problems.length === 0 ? '' : `；${problems.join('；')}`}`
        return { id: 'quality.commands', state: problems.length === 0 ? 'ok' : 'partial', label: '质量门禁命令列表', detail, ...(problems.length === 0 ? {} : { fix: '把命令的 cwd 收敛到工作区内：门禁命令是关于本仓库的' }) }
    })
}

function coverageCheck(row: ConfigInspection | undefined): HealthCheck {
    return dependentCheck('coverage.source', '覆盖率来源与阈值', row, (value) => {
        const configured = asString(value['coverageCommand']) !== '' || asString(value['reportFile']) !== ''
        const thresholds = asRecord(value['thresholds'])
        const thresholded = typeof thresholds['total'] === 'number' || typeof thresholds['changed'] === 'number'
        if (configured && thresholded) return { id: 'coverage.source', state: 'ok', label: '覆盖率来源与阈值', detail: '来源与阈值都已配置：coverage_check 可以给出确定性裁决' }
        return { id: 'coverage.source', state: 'partial', label: '覆盖率来源与阈值', detail: `${configured ? '' : '没有覆盖率来源（coverageCommand 或 reportFile）；'}${thresholded ? '' : '没有阈值（thresholds.total / changed）'}`, fix: '补上 coverageCommand/reportFile 与 thresholds.total（没有阈值时 coverage_check 会直接拒绝）' }
    })
}

function impactCheck(row: ConfigInspection | undefined): HealthCheck {
    return dependentCheck('impact.template', '最小回归测试模板', row, (value) => {
        const template = asString(value['testCommandTemplate'])
        if (template === '') return { id: 'impact.template', state: 'partial', label: '最小回归测试模板', detail: 'testCommandTemplate 为空：impact_tests 会拒绝给出命令', fix: '写 testCommandTemplate（例如 "go test {files}"；没有 {files} 时选中文件会追加在末尾）' }
        return { id: 'impact.template', state: 'ok', label: '最小回归测试模板', detail: `模板：${template}${template.includes('{files}') ? '（含 {files} 占位符）' : '（无 {files}：选中文件会追加在末尾）'}` }
    })
}

function supplyCheck(row: ConfigInspection | undefined): HealthCheck {
    return dependentCheck('supply.audit', '依赖审计命令', row, (value) => {
        const audit = asArray(asRecord(value['deps'])['auditCommands'])
        if (audit.length === 0) return { id: 'supply.audit', state: 'partial', label: '依赖审计命令', detail: 'deps.auditCommands 为空：依赖漏洞最多报 WARN，永远不会阻断交付', fix: '按生态写 deps.auditCommands（例如 ["govulncheck ./..."] 或 ["npm audit --json"]）' }
        return { id: 'supply.audit', state: 'ok', label: '依赖审计命令', detail: `${audit.length} 条审计命令（按 severity 阻断）` }
    })
}

function evidenceCheck(row: ConfigInspection | undefined): HealthCheck {
    return dependentCheck('evidence.checklist', '交付证据检查表', row, (value) => {
        const kinds = asArray(value['requiredEvidenceKinds'])
        const gate = asString(value['gateSource'])
        const requireGate = value['requireGate'] !== false
        const gaps = [kinds.length === 0 ? 'requiredEvidenceKinds 为空' : '', gate === '' ? 'gateSource 为空' : '', requireGate ? '' : 'requireGate=false（没有门禁也能交付）'].filter(Boolean)
        if (gaps.length === 0) return { id: 'evidence.checklist', state: 'ok', label: '交付证据检查表', detail: `${kinds.length} 类必填证据；门禁来源 ${gate}` }
        return { id: 'evidence.checklist', state: 'partial', label: '交付证据检查表', detail: gaps.join('；'), fix: '补上必填证据类型与门禁来源，并保持 requireGate=true（否则交付不会被拦住）' }
    })
}

function interactionCheck(row: ConfigInspection | undefined): HealthCheck {
    const id = 'interaction.channels'
    const label = '交互/审批通道的项目级覆盖'
    if (row === undefined || !row.present) {
        return { id, state: 'ok', label, detail: '没有仓库级覆盖：使用宿主 profile 的交互配置（没有通道就是没有通道，这不是"读不到"）' }
    }
    if (row.value === undefined) return { id, state: 'unknown', label, detail: rowDetail(row) }
    const problems = [...row.problems, ...row.pathProblems]
    if (problems.length > 0) return { id, state: 'partial', label, detail: problems.join('；'), fix: '修正上面点名的键；项目级只能改 denyApprovers / ledgerFile / preferredChannels / notifyLevels / redactPatterns' }
    const channels = asArray(row.value['preferredChannels'])
    return { id, state: 'ok', label, detail: `仓库级覆盖合法；preferredChannels 优先通道 ${channels.length} 个` }
}

function selfCheck(row: ConfigInspection | undefined): HealthCheck {
    const id = 'config.suite-doctor'
    const label = '套件自检（本插件）配置'
    if (row === undefined || !row.present) return { id, state: 'ok', label, detail: '没有项目级覆盖：使用 profile 配置（本插件没有项目文件也能工作）' }
    if (row.value === undefined) return { id, state: 'unknown', label, detail: rowDetail(row), fix: '修正成合法 JSON 对象，或删除该文件' }
    if (row.problems.length + row.pathProblems.length > 0) return { id, state: 'partial', label, detail: rowDetail(row), fix: '项目级只能改 expectedPlugins / probeTimeoutMs；其余键属于宿主' }
    return { id, state: 'ok', label, detail: rowDetail(row) }
}

function environmentsOf(value: Record<string, unknown>): HealthCheck {
    const environments = asArray(value['environments'])
    if (environments.length === 0) return { id: 'deploy.environments', state: 'partial', label: '部署环境声明', detail: 'environments 为空：部署工具会全部拒绝（这是合法配置，但部署不可用）', fix: '要启用部署时声明环境，并为每个环境写 deployCommands / verifyCommands / rollbackCommands' }
    const gaps: string[] = []
    for (const entry of environments) {
        const environment = asRecord(entry)
        const name = asString(environment['name']) || '(未命名)'
        if (asArray(environment['deployCommands']).length === 0) gaps.push(`${name} 没有 deployCommands`)
        if (asArray(environment['verifyCommands']).length === 0) gaps.push(`${name} 没有 verifyCommands`)
        if (asArray(environment['rollbackCommands']).length === 0) gaps.push(`${name} 没有 rollbackCommands（未演练的回滚不是回滚）`)
    }
    if (gaps.length === 0) return { id: 'deploy.environments', state: 'ok', label: '部署环境声明', detail: `${environments.length} 个环境都声明了部署/验证/回滚命令` }
    return { id: 'deploy.environments', state: 'partial', label: '部署环境声明', detail: gaps.join('；'), fix: '补齐每个环境的命令；没有回滚路径的环境不应上线' }
}

function deployCheck(row: ConfigInspection | undefined): HealthCheck {
    return dependentCheck('deploy.environments', '部署环境声明', row, environmentsOf)
}

function standardsArtifactsCheck(input: HealthInput, standardsRow: ConfigInspection | undefined): HealthCheck {
    const plugin = loadProjectConfig<Record<string, unknown>>(input.layout, 'standards-gate', { cache: false })
    const standardsFile = projectArtifactOf(input.layout, plugin.value, 'standardsFile', 'standards.json')
    const baselineFile = projectArtifactOf(input.layout, plugin.value, 'baselineFile', 'standards-baseline.json')
    const hasStandards = fs.existsSync(standardsFile)
    const hasBaseline = fs.existsSync(baselineFile)
    if (!hasStandards) return { id: 'standards.artifacts', state: 'missing', label: '结构规范与基线', detail: `没有规范文件 ${standardsFile}：standards_check 会拒绝运行（插件不猜阈值）`, fix: 'suite_init({ apply: true, only: ["standards"] })' }
    const languages = asRecord(standardsRow?.value?.['languages'])
    if (Object.keys(languages).length === 0) return { id: 'standards.artifacts', state: 'partial', label: '结构规范与基线', detail: `${standardsFile} 的 languages 为空：不会产生任何违规（这通常不是本意）`, fix: '在 standards.json 写 languages 阈值' }
    if (!hasBaseline) return { id: 'standards.artifacts', state: 'partial', label: '结构规范与基线', detail: `有规范但没有基线 ${baselineFile}：存量违规都会被算作新增，第一次 standards_check 会全线飘红`, fix: 'standards_check({ accept: true, note: "存量债务" })（需要人工批准）' }
    return { id: 'standards.artifacts', state: 'ok', label: '结构规范与基线', detail: `规范与基线都在（${standardsFile}）` }
}

function pathsCheck(inspection: SuiteInspection): HealthCheck {
    const problems = inspection.rows.flatMap((row) => row.pathProblems)
    if (problems.length === 0) return { id: 'paths.resolve', state: 'ok', label: '配置里的路径都在工作区内', detail: '所有显式路径键都解析到工作区内（或没有显式路径键）' }
    return { id: 'paths.resolve', state: 'partial', label: '配置里的路径都在工作区内', detail: problems.join('；'), fix: '把这些路径改成工作区内的相对路径；仓库不能把工件指到工作区外' }
}

function worstOf(checks: readonly HealthCheck[]): HealthState {
    let worst: HealthState = 'ok'
    for (const check of checks) if (STATE_RANK[check.state] > STATE_RANK[worst]) worst = check.state
    return worst
}

/**
 * Run the config-level health check.
 * @param input - workspace, layout and the suite-doctor configuration in force.
 * @returns one check per config file plus the dependent semantic checks.
 */
export function runSuiteHealth(input: HealthInput): SuiteHealth {
    const inspection = inspectSuiteConfig(input)
    const rows = new Map(inspection.rows.map((row) => [row.id, row]))
    const checks: HealthCheck[] = SUITE_CONFIGS.map((descriptor) => configCheck(descriptor.id, descriptor.title, rows.get(descriptor.id)))
    const self = rows.get('suite-doctor')
    if (self !== undefined) checks.push(selfCheck(self))
    checks.push(
        standardsArtifactsCheck(input, rows.get('standards')),
        qualityCheck(rows.get('quality-gate'), input.cwd),
        coverageCheck(rows.get('coverage-gate')),
        impactCheck(rows.get('impact-gate')),
        supplyCheck(rows.get('supply-chain-gate')),
        evidenceCheck(rows.get('evidence-gate')),
        interactionCheck(rows.get('interaction-gate')),
        deployCheck(rows.get('deploy-gate')),
        pathsCheck(inspection),
    )
    return { cwd: inspection.cwd, rootDir: inspection.rootDir, checks, state: worstOf(checks) }
}

/**
 * Render the health report for a person (tool output and `/suite doctor` share it).
 * @param health - the report to render.
 * @returns Chinese text, one line per check plus every non-ok next step.
 */
export function renderSuiteHealth(health: SuiteHealth): string {
    const count = (state: HealthState): number => health.checks.filter((check) => check.state === state).length
    const lines = [
        '/suite doctor —— 套件配置体检（只读；门禁/回执才是裁决依据，这里只回答"配好没有"）',
        `工作区：${health.cwd}；布局根：${health.rootDir}`,
        `汇总：${STATE_ICON.ok} ok ${count('ok')}、${STATE_ICON.partial} partial ${count('partial')}、${STATE_ICON.missing} missing ${count('missing')}、${STATE_ICON.unknown} unknown ${count('unknown')} → 结论：${health.state}`,
    ]
    for (const check of health.checks) {
        lines.push(`${STATE_ICON[check.state]} ${check.id}：${check.detail}`)
        if (check.fix !== undefined) lines.push(`   ↳ ${check.fix}`)
    }
    if (health.state !== 'ok') lines.push('', '说明：missing/unknown 都不是通过——按上面的下一步补齐，再跑一次 /suite doctor。')
    return `${lines.join('\n')}\n`
}

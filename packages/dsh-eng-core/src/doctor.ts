/**
 * The suite's self-check: one report that answers "where is this project, what
 * is configured, and what is missing".
 *
 * Eleven plugins each know their own corner; nobody answered the whole question,
 * so every onboarding step was a manual hunt through `.dsh/*.json` — and the
 * failure modes are quiet ones. Two examples this check exists for:
 *
 *  - `requireCleanTree` (on by default) compares the delivery's fingerprint with
 *    the one the gate observed. If the runtime ledgers under `.dsh/` are NOT
 *    gitignored, every gate run dirties the tree and delivery fails with two
 *    different diff digests — a confusing error whose fix is one line in
 *    `.gitignore`;
 *  - a coverage threshold without a report source, an evidence rule that
 *    requires the standards gate while no standards file exists, or a dependency
 *    audit with no `auditCommands` (which can only ever WARN) are all
 *    config-shaped gaps that look like gate bugs later.
 *
 * Two rules this module follows, both learned the hard way:
 *
 *  1. **Never claim `ok` for something it could not read.** An unparsable config
 *     is `unknown` (with the parser's complaint), not a pass.
 *  2. **Always name the fix.** A finding without the exact next command is a
 *     complaint, not a diagnosis.
 *
 * @module dsh-eng-core/doctor
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './io.js'
import type { Logger } from './log.js'
import { archiveFootprint } from './archive.js'
import { projectConfigFile } from './project-config.js'
import { resolveLayout, type Layout } from './paths.js'

/** The six phases this suite organises itself around. */
export type PhaseName = 'plan' | 'build' | 'test' | 'interact' | 'deliver' | 'deploy'

/** Phase order used by every renderer. */
export const PHASES: readonly PhaseName[] = ['plan', 'build', 'test', 'interact', 'deliver', 'deploy']

/** Human labels for the phases. */
export const PHASE_LABEL: Record<PhaseName, string> = {
    plan: '规划',
    build: '实现',
    test: '测试',
    interact: '交互',
    deliver: '交付',
    deploy: '部署',
}

/**
 * `ok` — checked and present; `partial` — present but incomplete (a threshold
 * without a source, an audit command list that is empty);
 * `missing` — required and absent; `unknown` — could not be judged (unreadable,
 * or the fact lives in a runtime this offline check cannot see).
 */
export type CheckState = 'ok' | 'partial' | 'missing' | 'unknown'

/** One finding. */
export interface DoctorCheck {
    /** Stable id, e.g. `config.quality-gate`, `deliver.standards-consistency`. */
    id: string
    area: PhaseName
    state: CheckState
    /** A missing `required` item blocks a healthy setup; `recommended` is advice. */
    severity: 'required' | 'recommended'
    /** The rule, in Chinese. */
    label: string
    /** What was actually observed, in Chinese. */
    detail: string
    /** The exact next step; omitted only when there is nothing to do. */
    fix?: string
}

/** What the runtime layer (the plugin, with a live context) can add. */
export interface DoctorRuntimeFacts {
    /** Plugin ids whose `apply()` ran in this host. */
    mountedPlugins?: string[]
    /** Tools the host actually exposes (a plugin can be mounted and expose none). */
    registeredTools?: string[]
    /** The session's mission, when there is one. */
    mission?: {
        id: string
        title: string
        status: string
        stage?: string
        blocked: boolean
        specApproved: boolean
        lastGate?: { id: string; state: string; source: string; reason: string; checkedAt: number }
    }
    /** Interaction asks still waiting for a human. */
    pendingAsks?: { id: string; title: string; at: number; ageMs: number }[]
    /** Interaction channels the host registered (`describe()` output). */
    channels?: { name: string; canAsk: boolean; canNotify: boolean }[]
    /** Asked for a phase that is not implemented yet. */
    notImplementedPhases?: PhaseName[]
}

/** Ledger size and shape: how much the suite has written here. */
export interface DoctorFootprint {
    missions: number
    /** Missions already moved to the archive (still findable through its index). */
    archivedMissions: number
    archivedBytes: number
    /** Total bytes under the layout root. */
    bytes: number
    gates: number
    receipts: number
    evidenceRows: number
    oldestMissionAt?: number
    newestMissionAt?: number
}

/** The whole report. */
export interface DoctorReport {
    cwd: string
    rootDir: string
    checks: DoctorCheck[]
    /** `required` items that are not `ok` — what actually blocks a healthy setup. */
    blockers: DoctorCheck[]
    /** `recommended` items that are not `ok`. */
    advice: DoctorCheck[]
    footprint: DoctorFootprint
    runtime?: DoctorRuntimeFacts
    generatedAt: number
}

/** Inputs of {@link checkWorkspace}. */
export interface DoctorOptions {
    cwd: string
    /** Override the trail location (defaults to `<cwd>/.dsh`). */
    layout?: Layout
    now?: number
    logger?: Logger
}

/** Read a project config file, distinguishing "absent" from "unreadable". */
function readProjectConfig(layout: Layout, pluginId: string): { file: string; present: boolean; value?: Record<string, unknown>; problem?: string } {
    const file = projectConfigFile(layout, pluginId)
    if (!fs.existsSync(file)) return { file, present: false }
    const value = readJson<Record<string, unknown>>(file)
    if (value === undefined || typeof value !== 'object' || value === null) {
        return { file, present: true, problem: `${path.relative(layout.cwd, file)} 存在但不是合法的 JSON 对象` }
    }
    return { file, present: true, value }
}

/** Whether git ignores a path inside this repository (fail-closed on error). */
function isGitIgnored(cwd: string, relative: string): boolean | undefined {
    const result = spawnSync('git', ['check-ignore', '-q', relative], { cwd, timeout: 10_000 })
    if (result.error !== undefined && result.error !== null && result.status === null) return undefined
    if (result.status === 0) return true
    if (result.status === 1) return false
    // 128 = not a git repository
    return undefined
}

/** Root-level `*.jsonl` ledgers that exist under the trail, as repo-relative paths. */
function existingLedgerFiles(rootDir: string, trail: string): string[] {
    try {
        return fs
            .readdirSync(rootDir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => `${trail}/${name}`)
    } catch {
        return []
    }
}

/** The `.dsh/*.json` config files git actually tracks (empty when none/unusable). */
function trackedTrailConfigs(cwd: string, trail: string): string[] {
    const result = spawnSync('git', ['ls-files', `${trail}/*.json`], { cwd, timeout: 10_000, encoding: 'utf8' })
    if (result.status !== 0 || typeof result.stdout !== 'string') return []
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
}

function isGitRepo(cwd: string): boolean {
    try {
        return fs.existsSync(path.join(cwd, '.git'))
    } catch {
        return false
    }
}

/** Directory size in bytes, bounded so a huge tree cannot stall the check. */
function directorySize(dir: string, budgetMs = 1_500, now = Date.now()): number {
    let total = 0
    const walk = (current: string): void => {
        if (Date.now() - now > budgetMs) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (!entry.isFile()) continue
            try {
                total += fs.statSync(full).size
            } catch {
                // a file that vanished mid-walk contributes nothing
            }
        }
    }
    walk(dir)
    return total
}

/** Count the JSON artifacts of one kind inside the missions directory. */
function countArtifacts(missionsDir: string, kind: string): number {
    let count = 0
    let missions: fs.Dirent[]
    try {
        missions = fs.readdirSync(missionsDir, { withFileTypes: true })
    } catch {
        return 0
    }
    for (const mission of missions) {
        if (!mission.isDirectory()) continue
        try {
            count += fs.readdirSync(path.join(missionsDir, mission.name, kind)).filter((name) => name.endsWith('.json')).length
        } catch {
            // no such directory for this mission
        }
    }
    return count
}

/** Count lines of a JSONL file (0 when unreadable). */
function countLines(file: string): number {
    try {
        const text = fs.readFileSync(file, 'utf8')
        return text.split('\n').filter((line) => line.trim() !== '').length
    } catch {
        return 0
    }
}

/**
 * Check a workspace against every configured gate.
 *
 * Offline and read-only: it never writes, never asks a human and never records a
 * gate. Runtime facts (mounted plugins, current stage, pending asks) are merged
 * in by the caller when a live context exists.
 * @param options - workspace, optional layout/clock.
 */
export function checkWorkspace(options: DoctorOptions): DoctorReport {
    const cwd = options.cwd
    const layout = options.layout ?? resolveLayout(cwd)
    const checks: DoctorCheck[] = []
    const add = (check: DoctorCheck): void => {
        checks.push(check)
    }

    // ---- global -----------------------------------------------------------
    const repo = isGitRepo(cwd)
    add({
        id: 'repo.git',
        area: 'deliver',
        state: repo ? 'ok' : 'partial',
        severity: 'recommended',
        label: '工作区是 git 仓库',
        detail: repo ? `已初始化（${path.join(cwd, '.git')}）` : '不是 git 仓库：门禁与回执无法绑定工作区指纹',
        ...(repo ? {} : { fix: 'git init（随后提交一次，让指纹有基准）' }),
    })

    // Runtime ledgers must be ignored, but the CONFIG files must not be: the
    // suite's own scaffold tells people to commit `.dsh/*.json` (they are the
    // trust root and belong in review), while missions/audit/state and the
    // trailing `*.jsonl` ledgers are written on every run. Ignoring the whole
    // `.dsh/` would hide the configuration; ignoring none of it makes every
    // gate run dirty the tree, so `requireCleanTree` fails with two different
    // diff digests and no obvious cause.
    const trail = path.relative(cwd, layout.rootDir) || '.dsh'
    // Four directories are written by the suite on every run, so they must be
    // ignored everywhere. Others are runtime too but only once the matching
    // plugin is used (`media/` for images, `interaction/` for the decision
    // ledger, `deploy/` for plans) — demanding them from a repo that never
    // writes them is noise, so they count only when they exist. `roles/` is
    // CONFIG and must stay trackable.
    const runtimePaths = ['missions', 'audit', 'state', 'specs']
        .map((name) => `${trail}/${name}`)
        .concat(
            ['media', 'interaction', 'deploy']
                .filter((name) => fs.existsSync(path.join(layout.rootDir, name)))
                .map((name) => `${trail}/${name}`),
        )
    // Only the ledgers that EXIST are required to be ignored: asking every repo
    // to ignore four files its plugins may never write is noise, while a ledger
    // file that is present and unignored is a real leak (it changes on every
    // run, which is exactly what breaks `requireCleanTree`).
    const ledgerFiles = existingLedgerFiles(layout.rootDir, trail)
    // A directory pattern (`.dsh/missions/`) only matches when git is told the
    // path is a directory, which a trailing slash does and a bare path does not
    // — and the path usually does not exist yet on a fresh checkout, so git
    // cannot stat its way to the answer.
    const probes = runtimePaths
        .map((target) => ({ target, probe: `${target}/`, isDir: true }))
        .concat(ledgerFiles.map((target) => ({ target, probe: target, isDir: false })))
    const ignoreStates = repo
        ? probes.map(({ target, probe, isDir }) => ({ target, isDir, ignored: isGitIgnored(cwd, probe) }))
        : []
    const leaking = ignoreStates.filter((entry) => entry.ignored === false)
    const unchecked = ignoreStates.filter((entry) => entry.ignored === undefined)
    add({
        id: 'ledger.gitignore',
        area: 'deliver',
        state: !repo ? 'unknown' : leaking.length === 0 ? 'ok' : leaking.length === runtimePaths.length + ledgerFiles.length ? 'missing' : 'partial',
        severity: 'required',
        label: `运行时台账被 git 忽略（${trail}/ 下的运行时目录与实际存在的 *.jsonl）`,
        detail:
            !repo
                ? '无法判断（不是 git 仓库或 git 不可用）'
                : leaking.length === 0
                  ? '运行时目录与台账文件都已忽略：门禁观测的工作区指纹不会被写入弄脏'
                  : `未忽略：${leaking.map((entry) => entry.target).join('、')}${
                        unchecked.length > 0 ? `（另有 ${unchecked.length} 项无法判断）` : ''
                    }；每次门禁运行都会改动工作区，交付时 requireCleanTree 会报"与门禁观测的指纹不一致"（两个 diff 摘要不同）`,
        ...(leaking.length > 0
            ? { fix: `printf '%s\\n' ${leaking.map((entry) => `'${entry.isDir ? `${entry.target}/` : entry.target}'`).join(' ')} >> .gitignore（配置类文件如 ${trail}/*.json 不要忽略：它们属于信任根，应当提交并评审）` }
            : {}),
    })

    if (repo) {
        const tracked = trackedTrailConfigs(cwd, trail)
        add({
            id: 'ledger.config-tracked',
            area: 'deliver',
            state: tracked.length > 0 ? 'ok' : 'partial',
            severity: 'recommended',
            label: '门禁配置可评审（.dsh/*.json 已提交）',
            detail:
                tracked.length > 0
                    ? `已跟踪：${tracked.slice(0, 4).join('、')}${tracked.length > 4 ? ' 等' : ''}`
                    : `没有跟踪任何 ${trail}/*.json：门禁阈值/命令是信任根，放在版本控制外就无法评审与追责`,
            ...(tracked.length > 0 ? {} : { fix: `git add ${trail}/quality-gate.json（以及 standards.json / evidence-gate.json 等）并提交` }),
        })
    }

    // ---- plan -------------------------------------------------------------
    const specGate = readProjectConfig(layout, 'spec-gate')
    add({
        id: 'config.spec-gate',
        area: 'plan',
        state: specGate.problem !== undefined ? 'unknown' : specGate.present ? 'ok' : 'partial',
        severity: 'recommended',
        label: '仓库级规格门禁配置（.dsh/spec-gate.json）',
        detail:
            specGate.problem ?? (specGate.present ? `已配置：enforce=${String(specGate.value?.['enforce'] ?? '(未写)')}` : '未配置：写拦截使用宿主的 profile 默认值'),
        ...(specGate.present ? {} : { fix: 'bash scripts/project-config.sh --workspace <repo> --write --spec on' }),
    })
    add({
        id: 'config.test-design-gate',
        area: 'plan',
        state: readProjectConfig(layout, 'test-design-gate').present ? 'ok' : 'partial',
        severity: 'recommended',
        label: '仓库级测试设计门禁配置（.dsh/test-design-gate.json）',
        detail: readProjectConfig(layout, 'test-design-gate').present ? '已配置' : '未配置：使用 profile 默认（strict=false）',
        fix: 'bash scripts/project-config.sh --workspace <repo> --write（如需要更严的 strict）',
    })
    let roleFiles = 0
    try {
        roleFiles = fs.readdirSync(path.join(layout.rootDir, 'roles')).filter((name) => name.endsWith('.md')).length
    } catch {
        roleFiles = 0
    }
    add({
        id: 'roles.workspace',
        area: 'plan',
        state: roleFiles > 0 ? 'ok' : 'partial',
        severity: 'recommended',
        label: '仓库自带角色文件（.dsh/roles/*.md）',
        detail: roleFiles > 0 ? `${roleFiles} 个角色文件` : '没有仓库级角色文件：使用 role-guard 的内置角色（developer/reviewer/qa）',
        ...(roleFiles > 0 ? {} : { fix: '如需项目专属角色/模型/权限：在 .dsh/roles/ 下新增 <role>.md（见 role-guard README 的 frontmatter 格式）' }),
    })

    // ---- build ------------------------------------------------------------
    const quality = readProjectConfig(layout, 'quality-gate')
    const commands = Array.isArray(quality.value?.['commands']) ? (quality.value?.['commands'] as unknown[]) : []
    const requiredCommands = commands.filter((entry) => typeof entry === 'object' && entry !== null && (entry as { required?: unknown }).required === true)
    add({
        id: 'config.quality-gate',
        area: 'build',
        state: quality.problem !== undefined ? 'unknown' : commands.length === 0 ? 'missing' : requiredCommands.length === 0 ? 'partial' : 'ok',
        severity: 'required',
        label: '质量门禁命令（.dsh/quality-gate.json 的 commands）',
        detail:
            quality.problem ??
            (commands.length === 0
                ? '没有任何命令：quality_gate_run 无命令可跑，交付拿不到确定性裁决'
                : requiredCommands.length === 0
                  ? `${commands.length} 条命令但都不是 required：门禁失败只会是 WARN，交付不会被拦住`
                  : `${commands.length} 条命令（${requiredCommands.length} 条 required）`),
        fix: 'bash scripts/project-config.sh --workspace <repo> --write --test "<测试命令>" --lint "<lint 命令>"',
    })

    const standardsFile = path.join(cwd, String(readProjectConfig(layout, 'standards-gate').value?.['standardsFile'] ?? '.dsh/standards.json'))
    const baselineFile = path.join(cwd, String(readProjectConfig(layout, 'standards-gate').value?.['baselineFile'] ?? '.dsh/standards-baseline.json'))
    const hasStandards = fs.existsSync(standardsFile)
    const hasBaseline = fs.existsSync(baselineFile)
    add({
        id: 'config.standards',
        area: 'build',
        state: hasStandards ? (hasBaseline ? 'ok' : 'partial') : 'partial',
        severity: 'recommended',
        label: '代码规范阈值与基线（.dsh/standards.json / standards-baseline.json）',
        detail: hasStandards
            ? hasBaseline
                ? '阈值与基线都在：新增/恶化违规会挡门禁，存量已被接受'
                : '有阈值但没有基线：所有存量违规都会被算作"新增"（第一次 standards_check 会全线飘红）'
            : '没有阈值文件：standards_check 会拒绝运行（插件不猜阈值）',
        fix: hasStandards ? 'standards_check({ accept: true, note: "存量债务" })（人工批准后冻结基线）' : 'bash scripts/project-config.sh --workspace <repo> --write --standards on',
    })

    const supply = readProjectConfig(layout, 'supply-chain-gate')
    const auditCommands = (supply.value?.['deps'] as { auditCommands?: unknown } | undefined)?.auditCommands
    const auditCount = Array.isArray(auditCommands) ? auditCommands.length : 0
    add({
        id: 'config.supply-chain',
        area: 'build',
        state: supply.problem !== undefined ? 'unknown' : auditCount > 0 ? 'ok' : 'partial',
        severity: 'recommended',
        label: '依赖审计命令（.dsh/supply-chain-gate.json 的 deps.auditCommands）',
        detail:
            supply.problem ??
            (auditCount > 0 ? `${auditCount} 条审计命令（按 severity 阻断）` : '未配置：依赖漏洞只能报 WARN，永远不会阻断交付'),
        ...(auditCount > 0 ? {} : { fix: '在 .dsh/supply-chain-gate.json 写 deps.auditCommands，例如 ["govulncheck ./..."]（无 severity 的报告可用 deps.auditSeverities.block 加 "unknown" 来阻断）' }),
    })

    // ---- test -------------------------------------------------------------
    const testLike = commands.filter((entry) => {
        const command = typeof entry === 'object' && entry !== null ? String((entry as { command?: unknown }).command ?? '') : ''
        return /(^|\s)(go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|vitest|jest|node\s+--test|cargo\s+test|mvn\s+test)/.test(command)
    })
    add({
        id: 'test.command',
        area: 'test',
        state: testLike.length > 0 ? 'ok' : 'partial',
        severity: 'required',
        label: '质量门禁里有测试类命令',
        detail: testLike.length > 0 ? `${testLike.length} 条测试命令` : '命令列表里没有测试类命令：交付证据可能只有 lint/构建',
        ...(testLike.length > 0 ? {} : { fix: 'bash scripts/project-config.sh --workspace <repo> --write --test "<测试命令>"' }),
    })

    const coverage = readProjectConfig(layout, 'coverage-gate')
    const coverageCommand = coverage.value?.['coverageCommand']
    const reportFile = coverage.value?.['reportFile']
    const thresholds = coverage.value?.['thresholds'] as { total?: unknown; changed?: unknown } | undefined
    const hasSource = typeof coverageCommand === 'string' && coverageCommand !== '' ? true : typeof reportFile === 'string' && reportFile !== ''
    const hasThreshold = typeof thresholds?.total === 'number' || typeof thresholds?.changed === 'number'
    add({
        id: 'config.coverage',
        area: 'test',
        state: coverage.problem !== undefined ? 'unknown' : hasSource && hasThreshold ? 'ok' : 'partial',
        severity: 'recommended',
        label: '覆盖率门禁的来源与阈值（.dsh/coverage-gate.json）',
        detail:
            coverage.problem ??
            (hasSource && hasThreshold
                ? `来源：${typeof coverageCommand === 'string' && coverageCommand !== '' ? '命令' : '报告文件'}；阈值：${[typeof thresholds?.total === 'number' ? `总 ${thresholds.total}%` : '', typeof thresholds?.changed === 'number' ? `增量 ${thresholds.changed}%` : ''].filter(Boolean).join(' / ')}`
                : `${hasSource ? '' : '没有覆盖率来源（coverageCommand 或 reportFile）；'}${hasThreshold ? '' : '没有阈值（total/changed）'}：coverage_check 会被拒绝`),
        fix: '在 .dsh/coverage-gate.json 写 coverageCommand（例如 "go test ./... -coverprofile=cover.out"）与 thresholds.total/changed',
    })

    const impact = readProjectConfig(layout, 'impact-gate')
    const template = impact.value?.['testCommandTemplate']
    add({
        id: 'config.impact',
        area: 'test',
        state: impact.problem !== undefined ? 'unknown' : typeof template === 'string' && template !== '' ? 'ok' : 'partial',
        severity: 'recommended',
        label: '最小回归集命令模板（.dsh/impact-gate.json 的 testCommandTemplate）',
        detail:
            impact.problem ??
            (typeof template === 'string' && template !== '' ? `模板：${template}` : '未配置：impact_tests 会拒绝渲染命令（不会猜测试运行器）'),
        fix: '在 .dsh/impact-gate.json 写 testCommandTemplate（例如 "go test {files}" 或 "vitest run {files}"）',
    })

    // ---- test budgets / mutation / contracts / flaky (all opt-in) ----------
    const coverageMutation = (coverage.value?.['mutation'] ?? undefined) as Record<string, unknown> | undefined
    const mutationEnabled = coverageMutation?.['enabled'] === true
    const mutationCommand = coverageMutation?.['testCommand'] ?? coverageCommand
    add({
        id: 'config.mutation',
        area: 'test',
        state: !mutationEnabled ? 'ok' : typeof mutationCommand === 'string' && mutationCommand !== '' ? 'ok' : 'missing',
        severity: mutationEnabled ? 'required' : 'recommended',
        label: '变异测试（.dsh/coverage-gate.json 的 mutation）',
        detail: !mutationEnabled
            ? '未启用（可选）：覆盖率只证明"这行跑过"，变异测试才回答"断言会不会发现它变坏"'
            : typeof mutationCommand === 'string' && mutationCommand !== ''
              ? `已启用，测试命令：${mutationCommand}`
              : '已启用但没有可用的测试命令（mutation.testCommand 缺失，且覆盖率命令无法明确推导）：mutation_check 会拒绝运行',
        ...(mutationEnabled && (typeof mutationCommand !== 'string' || mutationCommand === '')
            ? { fix: '在 .dsh/coverage-gate.json 的 mutation.testCommand 写明跑测试的命令（argv 形式，例如 "go test ./..."）' }
            : {}),
    })

    const budgets = Array.isArray(quality.value?.['budgets']) ? (quality.value?.['budgets'] as unknown[]) : []
    const brokenBudgets = budgets.filter((entry) => {
        if (typeof entry !== 'object' || entry === null) return true
        const budget = entry as Record<string, unknown>
        const hasCommand = typeof budget['command'] === 'string' || typeof budget['commandId'] === 'string'
        const hasBound = budget['max'] !== undefined || budget['min'] !== undefined || budget['maxRegressionPercent'] !== undefined
        const needsRegex = budget['metric'] !== undefined && budget['metric'] !== 'durationMs' && budget['metric'] !== 'bytes'
        const hasRegex = typeof budget['regex'] === 'string' && budget['regex'] !== ''
        return !hasCommand || !hasBound || (needsRegex && !hasRegex)
    })
    add({
        id: 'config.budgets',
        area: 'test',
        state: budgets.length === 0 ? 'ok' : brokenBudgets.length === 0 ? 'ok' : 'partial',
        severity: budgets.length > 0 ? 'required' : 'recommended',
        label: '指标预算（.dsh/quality-gate.json 的 budgets）',
        detail:
            budgets.length === 0
                ? '未配置（可选）：命令通过不等于没有变慢/变大，预算防的是"这次改动让数字变坏"'
                : brokenBudgets.length === 0
                  ? `${budgets.length} 条预算，字段齐备（命令 + 界限${budgets.some((b) => typeof (b as Record<string, unknown>)['maxRegressionPercent'] === 'number') ? '，含回归对比' : ''}）`
                  : `${brokenBudgets.length}/${budgets.length} 条预算字段不全：每条都需要 command（或 commandId）+ 至少一个界限（max/min/maxRegressionPercent）；提取数字的预算还需要 regex`,
        ...(brokenBudgets.length > 0 ? { fix: '补齐 budgets 里缺字段的条目（或删掉不打算维护的那条）——字段不全的预算会在 budget_check 时被拒绝' } : {}),
    })

    const contracts = Array.isArray(quality.value?.['contracts']) ? (quality.value?.['contracts'] as unknown[]) : []
    const brokenContracts = contracts.filter((entry) => {
        if (typeof entry !== 'object' || entry === null) return true
        const contract = entry as Record<string, unknown>
        const expect = contract['expect']
        return typeof contract['command'] !== 'string' || typeof expect !== 'object' || expect === null || Object.keys(expect).length === 0
    })
    add({
        id: 'config.contracts',
        area: 'test',
        state: contracts.length === 0 ? 'ok' : brokenContracts.length === 0 ? 'ok' : 'partial',
        severity: contracts.length > 0 ? 'required' : 'recommended',
        label: '契约冒烟检查（.dsh/quality-gate.json 的 contracts）',
        detail:
            contracts.length === 0
                ? '未配置（可选）：用来证明"声明的接口还能按预期行为"，不是正确性证明'
                : brokenContracts.length === 0
                  ? `${contracts.length} 条契约检查`
                  : `${brokenContracts.length}/${contracts.length} 条缺 command 或 expect（expect 至少要有一条期望）`,
        ...(brokenContracts.length > 0 ? { fix: '给每条 contract 写 command 与 expect（exitCode/stdoutContains/stdoutNotContains/jsonPaths 至少一项）' } : {}),
    })

    const impactCfg = readProjectConfig(layout, 'impact-gate')
    const flaky = (impactCfg.value?.['flaky'] ?? undefined) as Record<string, unknown> | undefined
    const quarantineDays = flaky?.['quarantineMaxDays']
    add({
        id: 'config.flaky',
        area: 'test',
        state: quarantineDays === 0 ? 'partial' : 'ok',
        severity: quarantineDays === 0 ? 'recommended' : 'recommended',
        label: 'flaky 隔离策略（.dsh/impact-gate.json 的 flaky）',
        detail:
            flaky === undefined
                ? '未配置：flaky_plan 使用默认签名与 14 天隔离期（每条隔离都要 owner 与到期时间）'
                : quarantineDays === 0
                  ? 'quarantineMaxDays=0：隔离立即过期，flaky_plan 的每次输出都会是"已过期"升级'
                  : `已配置（隔离期 ${String(quarantineDays ?? 14)} 天）`,
        ...(quarantineDays === 0 ? { fix: '把 flaky.quarantineMaxDays 设为正数（例如 14），否则隔离形同虚设' } : {}),
    })

    // ---- interact ---------------------------------------------------------
    const interaction = readProjectConfig(layout, 'interaction-gate')
    add({
        id: 'config.interaction',
        area: 'interact',
        state: interaction.problem !== undefined ? 'unknown' : interaction.present ? 'ok' : 'partial',
        severity: 'recommended',
        label: '交互层配置（.dsh/interaction-gate.json）',
        detail:
            interaction.problem ??
            (interaction.present
                ? '已配置（通道是否可用需运行时 facts：interaction_status 会列出已注册通道）'
                : '未配置：审批仍只走宿主 approval 接缝（终端可用，IM/无头场景下没有统一入口）'),
        ...(interaction.present ? {} : { fix: '部署 dsh-interaction-gate 后按需写 .dsh/interaction-gate.json（requireApproverList/askTimeoutMs 等）' }),
    })
    const approvers = path.join(cwd, String(interaction.value?.['approversFile'] ?? '.dsh/interaction-approvers.txt'))
    const requireApprovers = interaction.value?.['requireApproverList'] === true
    add({
        id: 'interaction.approvers',
        area: 'interact',
        state: !requireApprovers ? 'ok' : fs.existsSync(approvers) ? 'ok' : 'missing',
        severity: requireApprovers ? 'required' : 'recommended',
        label: '审批人名单（requireApproverList=true 时必填）',
        detail: requireApprovers
            ? fs.existsSync(approvers)
                ? `已提供：${path.relative(cwd, approvers)}`
                : 'requireApproverList=true 但名单文件不存在：所有回答都会被判为"无权限"（fail closed）'
            : '未启用严格名单（该会话里任何人都可以决定）',
        ...(requireApprovers && !fs.existsSync(approvers) ? { fix: `写入允许的审批人 id（每行一个）到 ${path.relative(cwd, approvers)}` } : {}),
    })

    // ---- deliver ----------------------------------------------------------
    const evidence = readProjectConfig(layout, 'evidence-gate')
    const kinds = Array.isArray(evidence.value?.['requiredEvidenceKinds']) ? (evidence.value?.['requiredEvidenceKinds'] as unknown[]) : []
    add({
        id: 'config.evidence-gate',
        area: 'deliver',
        state: evidence.problem !== undefined ? 'unknown' : kinds.length > 0 ? 'ok' : 'partial',
        severity: 'required',
        label: '必填证据类型（.dsh/evidence-gate.json 的 requiredEvidenceKinds）',
        detail:
            evidence.problem ??
            (kinds.length > 0 ? `必填：${kinds.map((kind) => String(kind)).join(', ')}` : '未配置：若宿主 profile 也没配，交付只要求"有回执"而不要求证据类型'),
        ...(kinds.length > 0 ? {} : { fix: '在 .dsh/evidence-gate.json 写 requiredEvidenceKinds（例如 ["command","test"]）' }),
    })
    const requireStandards = evidence.value?.['requireStandardsGate'] === true
    add({
        id: 'deliver.standards-consistency',
        area: 'deliver',
        state: !requireStandards ? 'ok' : hasStandards ? 'ok' : 'missing',
        severity: requireStandards ? 'required' : 'recommended',
        label: '交付要求规范门禁时，规范文件必须存在',
        detail: requireStandards
            ? hasStandards
                ? 'requireStandardsGate=true 且阈值文件存在：交付前会要求最新一条规范门禁 PASS'
                : 'requireStandardsGate=true 但没有 .dsh/standards.json：standards_check 会拒绝运行，交付将永远等不到那条 PASS'
            : '未要求规范门禁（requireStandardsGate=false）',
        ...(requireStandards && !hasStandards ? { fix: 'bash scripts/project-config.sh --workspace <repo> --write --standards on（或把 requireStandardsGate 改回 false）' } : {}),
    })
    add({
        id: 'config.audit-trail',
        area: 'deliver',
        state: readProjectConfig(layout, 'audit-trail').present ? 'ok' : 'partial',
        severity: 'recommended',
        label: '仓库级审计配置（.dsh/audit-trail.json）',
        detail: readProjectConfig(layout, 'audit-trail').present ? '已配置' : '未配置：使用 profile 默认（快照与回滚策略以宿主为准）',
    })

    // ---- deploy -----------------------------------------------------------
    const deploy = readProjectConfig(layout, 'deploy-gate')
    add({
        id: 'config.deploy-gate',
        area: 'deploy',
        state: deploy.present ? 'ok' : 'partial',
        severity: 'recommended',
        label: '部署层配置（.dsh/deploy-gate.json）',
        detail: deploy.present ? '已配置' : '未配置：环境清单/发布单/上线后验证尚无定义（部署层是本套件最新补的一层）',
        ...(deploy.present ? {} : { fix: '部署 dsh-deploy-gate 后写 .dsh/deploy-gate.json（environments / goNoGo / postDeploy 检查）' }),
    })

    // ---- footprint --------------------------------------------------------
    const missionsDir = layout.missionsDir
    let missionNames: string[] = []
    try {
        missionNames = fs.readdirSync(missionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
        missionNames = []
    }
    const stamps: number[] = []
    for (const name of missionNames) {
        try {
            stamps.push(fs.statSync(path.join(missionsDir, name)).mtimeMs)
        } catch {
            // ignore
        }
    }
    const footprint: DoctorFootprint = {
        missions: missionNames.length,
        archivedMissions: 0,
        archivedBytes: 0,
        bytes: directorySize(layout.rootDir),
        gates: countArtifacts(missionsDir, 'gates'),
        receipts: countArtifacts(missionsDir, 'receipts'),
        evidenceRows: countLines(path.join(layout.rootDir, '..', '.dsh', 'evidence.jsonl')),
        ...(stamps.length === 0 ? {} : { oldestMissionAt: Math.min(...stamps), newestMissionAt: Math.max(...stamps) }),
    }
    // Evidence lives per mission in this suite; count the files when the root
    // ledger is absent so the number means "rows recorded" either way.
    if (footprint.evidenceRows === 0) {
        footprint.evidenceRows = countArtifacts(missionsDir, '') === 0 ? 0 : countEvidenceLines(missionsDir)
    }

    // Archiving is the answer to "the trail only grows", so the report has to
    // show the growth and the command that trims it — a 200-mission repository
    // where every read pays for every old mission is a real problem, and a
    // silent one.
    const archived = archiveFootprint(layout)
    const growthMissions = 50
    const growthBytes = 64 * 1024 * 1024
    const oversized = footprint.missions > growthMissions || footprint.bytes > growthBytes
    add({
        id: 'ledger.growth',
        area: 'deliver',
        state: oversized && archived.missions === 0 ? 'partial' : 'ok',
        severity: 'recommended',
        label: '台账规模可控（可归档旧 mission）',
        detail:
            (archived.missions > 0 ? `已归档 ${archived.missions} 个 mission / ${(archived.bytes / 1024).toFixed(0)} KiB；` : '') +
            `当前活跃 mission ${footprint.missions} 个 / ${(footprint.bytes / 1024 / 1024).toFixed(1)} MiB` +
            (oversized ? `（超过建议水位 ${growthMissions} 个 / ${Math.round(growthBytes / 1024 / 1024)} MiB）` : ''),
        ...(oversized && archived.missions === 0
            ? { fix: `bash scripts/archive-missions.sh --keep 20 --days 90 --dry-run（确认清单后再执行）；未交付的 mission 默认不动` }
            : {}),
    })

    footprint.archivedMissions = archived.missions
    footprint.archivedBytes = archived.bytes

    const generatedAt = options.now ?? Date.now()
    return {
        cwd,
        rootDir: layout.rootDir,
        checks,
        blockers: checks.filter((check) => check.severity === 'required' && check.state !== 'ok'),
        advice: checks.filter((check) => check.severity === 'recommended' && check.state !== 'ok'),
        footprint,
        generatedAt,
    }
}

/** Count `evidence.jsonl` rows across every mission directory. */
function countEvidenceLines(missionsDir: string): number {
    let rows = 0
    let missions: fs.Dirent[]
    try {
        missions = fs.readdirSync(missionsDir, { withFileTypes: true })
    } catch {
        return 0
    }
    for (const mission of missions) {
        if (!mission.isDirectory()) continue
        rows += countLines(path.join(missionsDir, mission.name, 'evidence.jsonl'))
    }
    return rows
}

/** Merge runtime facts (from a live host) into an offline report. */
export function withRuntime(report: DoctorReport, runtime: DoctorRuntimeFacts): DoctorReport {
    const checks = [...report.checks]
    if (runtime.mountedPlugins !== undefined) {
        const expected = ['role-guard', 'spec-gate', 'test-design-gate', 'quality-gate', 'evidence-gate', 'audit-trail', 'orchestrator']
        const missing = expected.filter((id) => !runtime.mountedPlugins?.includes(id))
        checks.push({
            id: 'runtime.mounts',
            area: 'interact',
            state: missing.length === 0 ? 'ok' : 'missing',
            severity: 'required',
            label: '核心插件已挂载',
            detail: missing.length === 0 ? `${runtime.mountedPlugins.length} 个插件在线` : `未挂载：${missing.join(', ')}（门禁与编排缺一环，流程会断）`,
            fix: '把对应 bundle 加入 profile 的 dsh.profile.bundles，然后重启会话',
        })
    }
    if (runtime.channels !== undefined) {
        const askable = runtime.channels.filter((channel) => channel.canAsk)
        checks.push({
            id: 'runtime.channels',
            area: 'interact',
            state: askable.length > 0 ? 'ok' : 'partial',
            severity: 'recommended',
            label: '交互通道可问人',
            detail:
                runtime.channels.length === 0
                    ? '没有任何通道注册：interaction_ask 会拒绝（fail closed）'
                    : `已注册 ${runtime.channels.length} 个通道，其中可问人的 ${askable.length} 个（${runtime.channels.map((c) => c.name).join(', ')}）`,
            ...(askable.length > 0 ? {} : { fix: '让一个通道插件注册到 interaction 服务（IM 插件提供 canAsk 能力）' }),
        })
    }
    if (runtime.pendingAsks !== undefined && runtime.pendingAsks.length > 0) {
        checks.push({
            id: 'runtime.pending-asks',
            area: 'interact',
            state: 'partial',
            severity: 'recommended',
            label: '有等待人工回答的提问',
            detail: runtime.pendingAsks.map((ask) => `${ask.title}（已等 ${Math.round(ask.ageMs / 60_000)} 分钟）`).join('；'),
            fix: 'interaction_status 查看详情；超时后这些提问会按 fail-closed 判为未通过',
        })
    }
    if (runtime.mission !== undefined) {
        const mission = runtime.mission
        checks.push({
            id: 'runtime.mission',
            area: 'plan',
            state: mission.blocked ? 'missing' : 'ok',
            severity: mission.blocked ? 'required' : 'recommended',
            label: `当前 mission（${mission.id}）`,
            detail: [
                `状态 ${mission.status}`,
                mission.stage === undefined ? undefined : `阶段 ${mission.stage}`,
                mission.specApproved ? '规格已审批' : '规格未审批',
                mission.blocked ? '已被熔断阻断' : undefined,
                mission.lastGate === undefined ? '无门禁记录' : `最近门禁 ${mission.lastGate.state}（${mission.lastGate.source}）`,
            ]
                .filter((part): part is string => part !== undefined)
                .join('；'),
            ...(mission.blocked ? { fix: 'orchestrate({ action: "unblock", note: "…" })（熔断是 latch，需要显式解除）' } : {}),
        })
    }
    if (runtime.notImplementedPhases !== undefined && runtime.notImplementedPhases.length > 0) {
        checks.push({
            id: 'runtime.phases',
            area: 'deploy',
            state: 'unknown',
            severity: 'recommended',
            label: '尚未实现的阶段',
            detail: `${runtime.notImplementedPhases.map((phase) => PHASE_LABEL[phase]).join('、')}：本套件对该阶段还没有门禁能力`,
        })
    }
    return {
        ...report,
        checks,
        blockers: checks.filter((check) => check.severity === 'required' && check.state !== 'ok'),
        advice: checks.filter((check) => check.severity === 'recommended' && check.state !== 'ok'),
        runtime,
    }
}

const STATE_MARK: Record<CheckState, string> = { ok: '✅', partial: '⚠️', missing: '❌', unknown: '❔' }

/** Render the report as the text a human or a model reads. */
export function renderDoctor(report: DoctorReport): string {
    const lines: string[] = []
    lines.push('# 套件自检（suite_status）')
    lines.push('')
    lines.push(`工作区：${report.cwd}`)
    lines.push(`台账：${report.rootDir}`)
    lines.push(
        `结果：必需项 ${report.blockers.length === 0 ? '全部就绪' : `${report.blockers.length} 项未就绪`}` +
            `；建议项 ${report.advice.length} 条待处理（共 ${report.checks.length} 项检查）`,
    )
    lines.push(
        `规模：mission ${report.footprint.missions} 个（已归档 ${report.footprint.archivedMissions} 个）、门禁记录 ${report.footprint.gates} 条、` +
            `回执 ${report.footprint.receipts} 个、证据行 ${report.footprint.evidenceRows} 条、台账 ${(report.footprint.bytes / 1024).toFixed(0)} KiB`,
    )
    for (const phase of PHASES) {
        const items = report.checks.filter((check) => check.area === phase)
        if (items.length === 0) continue
        lines.push('')
        lines.push(`## ${PHASE_LABEL[phase]}（${items.filter((item) => item.state === 'ok').length}/${items.length} 就绪）`)
        lines.push('')
        for (const item of items) {
            lines.push(`- ${STATE_MARK[item.state]} ${item.label}${item.severity === 'required' ? '（必需）' : ''}`)
            lines.push(`  ${item.detail}`)
            if (item.fix !== undefined && item.state !== 'ok') lines.push(`  → 下一步：${item.fix}`)
        }
    }
    const fixes = [...new Set([...report.blockers, ...report.advice].map((check) => check.fix).filter((fix): fix is string => fix !== undefined))]
    if (fixes.length > 0) {
        lines.push('')
        lines.push('## 建议的处理顺序')
        lines.push('')
        fixes.slice(0, 10).forEach((fix, index) => lines.push(`${index + 1}. ${fix}`))
    }
    return lines.join('\n')
}

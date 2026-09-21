/**
 * The model-facing tool surface: `standards_check`, `standards_bootstrap`,
 * `standards_status`.
 *
 * Division of labour, the same one the rest of the suite follows:
 *
 *  - the MEASUREMENT is deterministic (core's `measureWorkspace`);
 *  - the THRESHOLDS belong to the target repository, and this plugin cannot
 *    invent them — a missing standards file is an instruction to bootstrap, not
 *    a licence to guess;
 *  - LOOSENING the ratchet (accepting new violations, writing thresholds) goes
 *    through the human approval seam, because "this repository is allowed to
 *    grow a 600-line file" is a decision, not a measurement.
 *
 * @module dsh-standards-gate/tools
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    ensureDir,
    formatTime,
    gitFingerprint,
    measureWorkspace,
    readJson,
    readText,
    sessionCwd,
    writeTextAtomic,
    type AgentLike,
    type FileMetrics,
    type LayerRule,
    type Logger,
    type MetricsResult,
    type MissionStoreRegistry,
    type RuleSet,
    type StandardsConfig,
} from 'dsh-eng-core'
import { compareViolations, countByRule, freezeBaseline, parseBaselineText, readBaseline, writeMeasurement } from './baseline.js'
import { runStructuralReview, selectReviewTargets, type SubagentsLike } from './review.js'
import type { StandardsGateConfig } from './config.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Minimal structural view of `ctx.approval` (same seam spec-gate uses). */
export interface ApprovalLike {
    request(request: {
        agent?: AgentLike
        toolName: string
        reason: string
        signal?: AbortSignal
    }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: StandardsGateConfig
    /** Resolved per-call configuration (host row + `<repo>/.dsh/standards-gate.json`). */
    configFor: (agent: AgentLike | undefined) => StandardsGateConfig
    stores: MissionStoreRegistry
    approval: () => ApprovalLike | undefined
    /** `ctx.get('subagents')`, for the read-only structural reviewer. */
    subagents: () => SubagentsLike | undefined
    logger?: Logger
}

/** Arguments of `standards_check`. */
interface CheckArgs {
    missionId?: string
    /** Accept today's violations into the baseline (requires approval when configured). */
    accept?: boolean
    /** Free-text note recorded with an accepted baseline. */
    note?: string
    /** Report only: never touches the baseline even when `accept` is set. */
    dryRun?: boolean
}

/** Arguments of `standards_review`. */
interface ReviewArgs {
    missionId?: string
    targets?: number
    focus?: string
}

/** Arguments of `standards_bootstrap`. */
interface BootstrapArgs {
    /** `measure` = distributions + suggested thresholds; `freeze` = write them. */
    action?: 'measure' | 'freeze'
    note?: string
    /**
     * Overrides for the suggested thresholds (e.g. `{ maxFileLines: 300 }`).
     * Declared as unknown values because the tool schema is an open object; each
     * field is validated before use.
     */
    thresholds?: Record<string, unknown>
}

/** What a measurement run produced, for the report and the artifacts. */
interface CheckOutcome {
    cwd: string
    standards: StandardsConfig
    result: MetricsResult
    comparison: ReturnType<typeof compareViolations>
    verdict: 'PASS' | 'WARN' | 'BLOCK'
    reason: string
    gateId?: string
    measurementFile?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

/** The workspace of the calling agent, refusing an unknown one. */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = sessionCwd(agent)
    if (cwd === undefined || cwd === '') {
        throw new Error(
            '无法确定工作区：调用方 agent 没有会话目录（session.cwd）。standards_check 必须在知道工作区的前提下运行，' +
                '否则会把某个不相关的仓库当成被测对象。',
        )
    }
    return cwd
}

/**
 * Load the repository-owned standards file.
 *
 * Absent is not "no standards": the caller is told to bootstrap, so a repository
 * cannot end up ungated by accident.
 */
export function loadStandards(cwd: string, file: string, logger?: Logger): { standards?: StandardsConfig; problem?: string; path: string } {
    const target = path.isAbsolute(file) ? file : path.join(cwd, file)
    const raw = readJson<Record<string, unknown>>(target)
    if (raw === undefined) {
        return {
            path: target,
            problem:
                `没有找到规范文件 ${target}。\n` +
                '规范由**目标仓库自己拥有**，插件不会替你猜阈值。下一步：`standards_bootstrap({ action: "measure" })` 看现状与建议阈值，' +
                '确认后 `standards_bootstrap({ action: "freeze" })` 写进仓库（需要人工批准）。',
        }
    }
    const languages = raw['languages']
    if (typeof languages !== 'object' || languages === null || Array.isArray(languages)) {
        return { path: target, problem: `${target} 缺少 languages 段（形如 { "languages": { "go": { "maxFileLines": 400 } } }）。` }
    }
    const layers = Array.isArray(raw['layers'])
        ? (raw['layers'] as LayerRule[]).filter(
              (entry) => typeof entry === 'object' && entry !== null && typeof (entry as LayerRule).path === 'string',
          )
        : undefined
    const standards: StandardsConfig = {
        languages: languages as Record<string, RuleSet>,
        ...(layers === undefined || layers.length === 0 ? {} : { layers }),
        ...(raw['forbidCycles'] === true ? { forbidCycles: true } : {}),
        ...(Array.isArray(raw['exempt'])
            ? { exempt: (raw['exempt'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') }
            : {}),
    }
    if (Object.keys(standards.languages).length === 0) {
        logger?.warn(`${target} 的 languages 是空的：不会产生任何违规（这通常不是本意）`)
    }
    return { standards, path: target }
}

/** Run one measurement and compare it with the baseline. */
function runCheck(deps: ToolDeps, cwd: string, config: StandardsGateConfig): CheckOutcome | { problem: string } {
    const loaded = loadStandards(cwd, config.standardsFile, deps.logger)
    if (loaded.standards === undefined) return { problem: loaded.problem ?? `无法读取 ${loaded.path}` }
    const result = measureWorkspace({
        cwd,
        standards: loaded.standards,
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    })
    const baselinePath = path.isAbsolute(config.baselineFile) ? config.baselineFile : path.join(cwd, config.baselineFile)
    const baseline = readBaseline(baselinePath, deps.logger)
    const comparison = compareViolations(result.violations, baseline)
    const verdict: CheckOutcome['verdict'] =
        comparison.added.length > 0 ? 'BLOCK' : result.stats.truncated ? 'WARN' : 'PASS'
    const reason =
        comparison.added.length > 0
            ? `新增 ${comparison.added.length} 项规范违规（基线已接受 ${comparison.known.length} 项）`
            : result.stats.truncated
              ? `本次扫描达到文件上限（${config.maxFiles}）：覆盖面不完整，结论按 WARN 处理`
              : `无新增违规（基线已接受 ${comparison.known.length} 项，本次扫描 ${result.stats.filesScanned} 个文件）`
    return { cwd, standards: loaded.standards, result, comparison, verdict, reason }
}

/** Render the measurement as the text a model/human reads. */
export function renderCheck(outcome: CheckOutcome, config: StandardsGateConfig): string {
    const { result, comparison } = outcome
    const languages = Object.entries(result.stats.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([language, count]) => `${language} ${count}`)
        .join('、')
    const lines = [
        `## 规范检查（dsh-standards-gate）— ${outcome.verdict}`,
        '',
        `工作区：${outcome.cwd}`,
        `扫描：${result.stats.filesScanned} 个文件（豁免 ${result.stats.exempted} 个${result.stats.truncated ? '；**已达上限，结论不完整**' : ''}）${languages === '' ? '' : `；语言：${languages}`}`,
        `结论：${outcome.reason}`,
        ...(outcome.gateId === undefined ? [] : [`门禁记录：${outcome.gateId}`]),
        ...(outcome.measurementFile === undefined ? [] : [`度量明细：${outcome.measurementFile}`]),
        '',
        '### 违规（按规则统计）',
        '',
        ...(result.violations.length === 0
            ? ['- 无']
            : Object.entries(countByRule(result.violations))
                  .sort((a, b) => b[1] - a[1])
                  .map(([rule, count]) => `- ${rule}：${count}`)),
        '',
        ...(comparison.added.length === 0
            ? ['### 新增违规', '', '- 无（与基线一致）']
            : [
                  `### 新增违规（${comparison.added.length} 项：门禁失败的原因）`,
                  '',
                  ...comparison.added.slice(0, 25).map((violation) => `- ${violation.detail}`),
                  ...(comparison.added.length > 25 ? [`- …另有 ${comparison.added.length - 25} 项（见度量明细）`] : []),
              ]),
        ...(comparison.fixed.length === 0
            ? []
            : ['', `### 已消除（${comparison.fixed.length} 项）`, '', ...comparison.fixed.slice(0, 10).map((key) => `- ${key}`)]),
        '',
        ...(comparison.added.length === 0
            ? []
            : [
                  '### 怎么办',
                  '',
                  '1. 优先**改代码**：拆文件/拆函数（早返回替代深层嵌套）、抽掉超长 if 分支、收敛导出面、修正依赖方向；',
                  '2. 确实是刻意为之（表格型代码、生成的代码、大 switch）→ 在 `<repo>/.dsh/standards.json` 的 `exempt` 里排除，或按语言/目录放宽阈值；',
                  '3. 存量债务确实要带着走 → `standards_check({ accept: true, note: "原因" })`：这会**要求人工批准**后才写入基线。',
                  '',
              ]),
        ...(config.enforce === 'warn' ? ['（当前 enforce=warn：只报告，不写门禁记录为失败状态。）', ''] : []),
    ]
    return lines.join('\n')
}

/** The worst offenders, for a bootstrap suggestion. */
function worst(
    files: readonly FileMetrics[],
    by: (file: FileMetrics) => number,
    count: number,
): FileMetrics[] {
    return [...files].sort((a, b) => by(b) - by(a) || a.path.localeCompare(b.path)).slice(0, count)
}

/** Percentile of a numeric list (nearest-rank; deterministic). */
function percentile(values: readonly number[], fraction: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
    return sorted[index] ?? 0
}

/**
 * The thresholds a project should AIM for, per language.
 *
 * Deliberately NOT the measured p90. The baseline ratchet exists precisely so a
 * repository with legacy debt does not have to weaken its standards: set the
 * target you actually want, freeze today's violations, and let the number shrink
 * as the code is refactored. Measured on a real workspace (`golang/im`, 113 Go
 * files): p90 file length was 588 lines — adopting that as the limit would gate
 * nothing, while the 400-line target plus a baseline gates every new offender.
 */
export function targetThresholds(): Record<string, RuleSet> {
    return {
        default: { maxFileLines: 400, maxFunctionLines: 80, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 20 },
        go: { maxFileLines: 400, maxFunctionLines: 80, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 20 },
        ts: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
        js: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
        python: { maxFileLines: 400, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 20 },
    }
}

/**
 * Files that no standards check should count: generated code is not hand-written
 * and holding it to a human limit only teaches people to ignore the gate.
 */
export const DEFAULT_EXEMPT: readonly string[] = [
    '**/*_test.go',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/testdata/**',
    '**/vendor/**',
    '**/*.pb.go',
    '**/*_gen.go',
    '**/*.gen.go',
    '**/*.generated.*',
    '**/mocks/**',
    '**/__mocks__/**',
]

/** Suggested thresholds from the measured distribution, rounded to pleasant numbers. */
export function suggestThresholds(result: MetricsResult): { suggested: Record<string, RuleSet>; basis: string[] } {
    const byLanguage = new Map<string, FileMetrics[]>()
    for (const file of result.files) {
        const bucket = byLanguage.get(file.language) ?? []
        bucket.push(file)
        byLanguage.set(file.language, bucket)
    }
    const suggested: Record<string, RuleSet> = {}
    const basis: string[] = []
    for (const [language, files] of [...byLanguage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const round = (value: number, step: number): number => Math.max(step, Math.ceil(value / step) * step)
        const fileLines = files.map((file) => file.lines)
        const fnLines = files.flatMap((file) => file.functions.map((fn: { lines: number }) => fn.lines))
        const rounds = files.map((file) => file.maxDepth)
        const ifLines = files.flatMap((file) => file.ifBlocks.map((block: { lines: number }) => block.lines))
        const params = files.flatMap((file) => file.functions.map((fn: { params: number }) => fn.params))
        const exports = files.map((file) => file.exports)
        suggested[language] = {
            maxFileLines: round(percentile(fileLines, 0.9), 50),
            maxFunctionLines: round(percentile(fnLines, 0.9), 10),
            maxDepth: Math.max(3, Math.round(percentile(rounds, 0.9))),
            maxIfBlockLines: round(percentile(ifLines, 0.9), 5),
            maxParams: Math.max(3, Math.round(percentile(params, 0.9))),
            maxExports: round(percentile(exports, 0.9), 5),
        }
        basis.push(
            `${language}：${files.length} 个文件；文件行数 p90=${percentile(fileLines, 0.9)}、函数行数 p90=${percentile(fnLines, 0.9)}、嵌套 p90=${percentile(rounds, 0.9)}`,
        )
    }
    return { suggested, basis }
}

/**
 * Register the three tools.
 * @param ctx - the tool runtime (narrow structural view of `ctx.tools`).
 * @param deps - configuration, stores, approval seam and logger.
 * @returns disposers and the registered tool names.
 */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch {
            failed.push(name)
        }
    }

    register(
        defineTool({
            name: 'standards_check',
            description:
                'Measure the workspace against the structural standards the repository declares in `<repo>/.dsh/standards.json` (file/function size, nesting depth, branch size, parameter count, exported surface, module dependency direction, import cycles) and record the verdict on the mission as a gate. Violations the baseline already accepted do not fail; NEW violations do. `accept: true` widens the baseline to today\'s violations — that requires human approval (the ratchet must not be loosenable by the model alone). Missing standards file → run standards_bootstrap.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to record the gate on (default: the session mission).' },
                accept: { type: 'boolean', description: 'Accept today\'s violations into the baseline (human approval required).' },
                note: { type: 'string', description: 'Why these violations are accepted; recorded in the baseline.' },
                dryRun: { type: 'boolean', description: 'With accept: report what would be accepted, write nothing.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: CheckArgs = {} as CheckArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = deps.configFor(agent)
                if (!config.enabled) throw new Error('dsh-standards-gate 已被宿主禁用（enabled=false）')

                const outcome = runCheck(deps, cwd, config)
                if ('problem' in outcome) throw new Error(outcome.problem)

                const store = deps.stores.for(cwd)
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }),
                })

                // Accepting today's violations is the only action that LOOSENS a
                // check, so it is the only one that needs a person.
                if (args.accept === true && outcome.comparison.added.length > 0) {
                    const approve = async (reason: string): Promise<boolean> => {
                        const seam = deps.approval()
                        if (seam === undefined) return false
                        const decision = await seam.request({
                            ...(agent === undefined ? {} : { agent }),
                            toolName: 'standards_check',
                            reason,
                            ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                        })
                        return decision === 'allowed-once'
                    }
                    if (args.dryRun === true) {
                        return [
                            renderCheck(outcome, config),
                            '',
                            `### 预演：accept 会把 ${outcome.comparison.added.length} 项违规写入基线（未写盘）`,
                            ...outcome.comparison.added.slice(0, 10).map((violation) => `- ${violation.detail}`),
                        ].join('\n')
                    }
                    if (config.requireApprovalForBaseline) {
                        const allowed = await approve(
                            [
                                `规范检查要求放宽基线：把 ${outcome.comparison.added.length} 项**新增**违规记为"已接受"。`,
                                '',
                                ...outcome.comparison.added.slice(0, 12).map((violation) => `- ${violation.detail}`),
                                ...(outcome.comparison.added.length > 12 ? [`- …另有 ${outcome.comparison.added.length - 12} 项`] : []),
                                '',
                                `基线文件：${path.join(cwd, config.baselineFile)}`,
                                args.note === undefined || args.note === '' ? '（未填理由）' : `理由：${args.note}`,
                            ].join('\n'),
                        )
                        if (!allowed) {
                            return [
                                renderCheck(outcome, config),
                                '',
                                '### 未写入基线',
                                '',
                                '人工审批未通过（拒绝/取消/无审批通道）。基线保持不变，本次结论仍为 BLOCK。',
                                '下一步：改代码消除新增违规；或按语言/目录放宽阈值、把确有理由的路径写进 `exempt`——这两者改的是仓库里的规范文件，需要人来做。',
                            ].join('\n')
                        }
                    }
                    const baselinePath = path.join(cwd, config.baselineFile)
                    const accepted = freezeBaseline({
                        file: baselinePath,
                        violations: outcome.result.violations,
                        note:
                            args.note === undefined || args.note === ''
                                ? `standards_check 接受 ${outcome.comparison.added.length} 项新增违规`
                                : args.note,
                    })
                    deps.logger?.for(cwd).info(`standards-gate: 基线已更新（${baselinePath}，接受 ${accepted.accepted.length} 项）`)
                    outcome.comparison = { added: [], known: outcome.result.violations, fixed: outcome.comparison.fixed, present: true }
                    outcome.verdict = outcome.result.stats.truncated ? 'WARN' : 'PASS'
                    outcome.reason = `基线已更新：接受 ${accepted.accepted.length} 项违规（人工批准）`
                    return [renderCheck(outcome, config), '', `基线已写入 ${baselinePath}（${formatTime(Date.now())}）。`].join('\n')
                }

                const fingerprint = gitFingerprint(cwd)
                if (config.enforce === 'off') {
                    return [
                        renderCheck(outcome, config),
                        '',
                        '### 未记录门禁',
                        '',
                        '当前 enforce=off：只度量并报告，不写门禁记录（宿主明确关掉了这一层）。',
                    ].join('\n')
                }
                if (mission !== undefined) {
                    outcome.gateId = store.recordGate(mission.id, {
                        source: 'dsh-standards-gate',
                        state: outcome.verdict,
                        reason: outcome.reason,
                        results: [],
                        scope: { selected: ['standards'], total: 1, full: !outcome.result.stats.truncated },
                        fingerprint,
                    }).id
                    const file = store.artifactPath(mission.id, path.join('standards', `${outcome.gateId}.json`))
                    try {
                        writeMeasurement(file, {
                            verdict: outcome.verdict,
                            reason: outcome.reason,
                            scanned: outcome.result.stats,
                            violations: outcome.result.violations,
                            added: outcome.comparison.added.map((violation) => violation.key),
                            known: outcome.comparison.known.length,
                            fixed: outcome.comparison.fixed,
                        })
                        outcome.measurementFile = file
                    } catch (error) {
                        deps.logger?.warn('度量明细写入失败：', error)
                    }
                }
                return renderCheck(outcome, config)
            },
        }),
        'standards_check',
    )

    register(
        defineTool({
            name: 'standards_bootstrap',
            description:
                'Introduce the standards gate to a repository that already has code: `measure` reports the current distribution (file/function lines, nesting, branch size, parameters, exports) and SUGGESTS thresholds at the 90th percentile plus the worst offenders, so the first gate run does not block on legacy debt; `freeze` writes `<repo>/.dsh/standards.json` (and optionally the baseline) after human approval. Thresholds belong to the repository: this tool never invents them silently.',
            parameters: {
                action: { type: 'string', enum: ['measure', 'freeze'], required: true, description: 'measure = distributions + suggestion; freeze = write them (approval required).' },
                note: { type: 'string', description: 'Why these thresholds; recorded in the standards file.' },
                thresholds: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Override the suggestion, e.g. { "maxFileLines": 300, "maxFunctionLines": 60 }.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: BootstrapArgs = {} as BootstrapArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = deps.configFor(agent)
                if (!config.enabled) throw new Error('dsh-standards-gate 已被宿主禁用（enabled=false）')
                const action = args.action ?? 'measure'

                // Measurement for a bootstrap runs with NO limits: we want the
                // distribution, not a verdict.
                const result = measureWorkspace({
                    cwd,
                    standards: { languages: {} },
                    maxFiles: config.maxFiles,
                    maxFileBytes: config.maxFileBytes,
                    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                })
                const { suggested: p90, basis } = suggestThresholds(result)
                // The target profile is the recommendation; p90 is shown only as
                // context for teams that would rather not carry a baseline.
                const targetProfile = targetThresholds()
                const languages = Object.keys(result.stats.languages).filter((language) => language !== 'other')
                const recommended: Record<string, RuleSet> = {}
                for (const language of languages) recommended[language] = targetProfile[language] ?? targetProfile.default ?? {}
                const atTarget = measureWorkspace({
                    cwd,
                    standards: { languages: recommended, exempt: [...DEFAULT_EXEMPT] },
                    maxFiles: config.maxFiles,
                    maxFileBytes: config.maxFileBytes,
                    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                })
                const targetCounts = countByRule(atTarget.violations)
                const files = worst(result.files, (file) => file.lines, 10)
                const functions = worstFunctionList(result)
                const target = path.join(cwd, config.standardsFile)

                const report = [
                    '## 规范接入（standards_bootstrap）',
                    '',
                    `工作区：${cwd}`,
                    `扫描：${result.stats.filesScanned} 个文件（豁免 ${result.stats.exempted}）${result.stats.truncated ? '；**已达上限**' : ''}`,
                    '',
                    '### 现状分布',
                    '',
                    ...basis.map((line) => `- ${line}`),
                    '',
                    '### 最大的文件',
                    '',
                    ...files.map(
                          (file) =>
                              `- ${file.path}：${file.lines} 行，最长函数 ${Math.max(0, ...file.functions.map((fn: { lines: number }) => fn.lines))} 行，嵌套 ${file.maxDepth}`,
                      ),
                    '',
                    '### 最长的函数',
                    '',
                    ...functions.map((entry) => `- ${entry.path}:${entry.line} ${entry.name}：${entry.lines} 行，嵌套 ${entry.depth}，参数 ${entry.params}`),
                    '',
                    `### 推荐阈值（目标值，${Object.keys(recommended).join('、') || '无'}）`,
                    '',
                    '```json',
                    JSON.stringify({ languages: recommended, exempt: [...DEFAULT_EXEMPT], forbidCycles: true }, null, 2),
                    '```',
                    '',
                    `按目标阈值现在会有 **${atTarget.violations.length}** 项违规（${Object.entries(targetCounts).map(([rule, count]) => `${rule} ${count}`).join('、') || '无'}）：`,
                    '**不要为了它们放宽阈值**——第一次 `standards_check({ accept: true, note: "存量债务" })` 把它们冻结进基线，',
                    '门禁只挡之后新增的，重构会让这个数字变小。',
                    '',
                    `（参考：按各语言 p90 取值会得到 ${JSON.stringify(Object.fromEntries(Object.entries(p90).map(([language, ruleset]) => [language, ruleset.maxFileLines])))} 这样的文件行数上限——`,
                    '  那等于放弃门禁。只有在"不想引入基线"时才考虑它。）',
                    ...(args.thresholds === undefined ? [] : ['', `（调用方覆盖：${JSON.stringify(args.thresholds)}）`]),
                    '',
                    ...(action === 'measure'
                        ? [
                              '### 下一步',
                              '',
                              `1. 决定阈值（上面的建议可改：源文件 300/400、函数 60/80、嵌套 4、if 块 20 都是常见取值）；`,
                              `2. \`standards_bootstrap({ action: "freeze", note: "为什么这么定", thresholds: {...} })\` 写入 ${target}（**需要人工批准**）；`,
                              '3. 第一次 `standards_check({ accept: true, note: "存量债务" })` 冻结基线，之后只挡新增违规。',
                          ]
                        : []),
                ].join('\n')

                if (action === 'measure') return report

                const seam = deps.approval()
                const merged = mergeThresholds(recommended, args.thresholds)
                const body = {
                    languages: merged,
                    exempt: [...DEFAULT_EXEMPT],
                    forbidCycles: true,
                    ...(args.note === undefined || args.note === '' ? {} : { note: args.note }),
                }
                if (config.requireApprovalForBaseline) {
                    if (seam === undefined) {
                        throw new Error(
                            '宿主没有装配审批通道（ctx.approval）：写入仓库级规范需要人工批准，按 fail closed 拒绝。' +
                                '下一步：让宿主装配审批插件（或人工把上面的 JSON 写进 ' + target + '）。',
                        )
                    }
                    const decision = await seam.request({
                        ...(agent === undefined ? {} : { agent }),
                        toolName: 'standards_bootstrap',
                        reason: [
                            `为 ${cwd} 写入代码规范阈值（${target}）。之后每次 standards_check 都会用它门禁新增违规。`,
                            '',
                            '```json',
                            JSON.stringify(merged, null, 2),
                            '```',
                        ].join('\n'),
                        ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                    })
                    if (decision !== 'allowed-once') {
                        return [report, '', '### 未写入', '', '人工审批未通过：规范文件保持不变。'].join('\n')
                    }
                }
                ensureDir(path.dirname(target))
                writeTextAtomic(target, `${JSON.stringify(body, null, 2)}\n`)
                deps.logger?.for(cwd).info(`standards-gate: 规范文件已写入 ${target}`)
                return [report, '', `### 已写入`, '', `${target}（${formatTime(Date.now())}；阈值来源：调用方确认的目标值）`].join('\n')
            },
        }),
        'standards_bootstrap',
    )

    register(
        defineTool({
            name: 'standards_review',
            description:
                'Structural review: the judgment layer a metrics module cannot provide. It measures the workspace, picks the most suspicious files (size, nesting, longest function, exported surface), and dispatches a READ-ONLY reviewer agent with a rubric (single responsibility, naming, needless abstraction, error paths, local readability, whether splitting actually helps). The findings are OPINIONS: nothing here changes a gate, and the report says so. Use it after standards_check when the numbers look bad but you need to know whether they matter.',
            parameters: {
                missionId: { type: 'string', description: 'Mission whose directory stores the report (default: the session mission).' },
                targets: { type: 'integer', description: 'How many of the worst files to review (default: host config).' },
                focus: { type: 'string', description: 'Extra focus for this review, e.g. "重点看 internal/crawler 的拆分".' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: ReviewArgs = {} as ReviewArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = deps.configFor(agent)
                if (!config.enabled) throw new Error('dsh-standards-gate 已被宿主禁用（enabled=false）')
                const loaded = loadStandards(cwd, config.standardsFile, deps.logger)
                const result = measureWorkspace({
                    cwd,
                    standards: loaded.standards ?? { languages: {} },
                    maxFiles: config.maxFiles,
                    maxFileBytes: config.maxFileBytes,
                    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                })
                const limit = args.targets ?? config.reviewTargets
                const targets = selectReviewTargets(result, limit)
                if (targets.length === 0) {
                    return `工作区里没有可评审的源文件（扫描 ${result.stats.filesScanned} 个）——先确认 standards.json 的语言与豁免设置。`
                }
                const store = deps.stores.for(cwd)
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }),
                })
                const reportDir =
                    mission === undefined
                        ? path.join(cwd, '.dsh', 'standards-reviews')
                        : store.artifactPath(mission.id, 'standards-reviews')
                const outcome = await runStructuralReview(
                    {
                        subagents: () => deps.subagents() as never,
                        reportDir,
                        provider: config.reviewProvider,
                        timeoutMs: config.reviewTimeoutMs,
                        maxDepth: config.reviewMaxDepth,
                        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                    },
                    {
                        cwd,
                        targets,
                        ...(agent === undefined ? {} : { agent }),
                        ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                        ...(args.focus === undefined ? {} : { focus: args.focus }),
                    },
                )
                const header = [
                    `## 结构评审（${outcome.ok ? `只读子代理 ${outcome.runId ?? ''}` : '未完成'}）`,
                    '',
                    `评审对象（按可疑度排序，共 ${targets.length} 个）：${targets.map((target) => `\`${target.path}\``).join('、')}`,
                    ...(outcome.outputFile === undefined ? [] : [`报告落盘：${outcome.outputFile}`]),
                    '',
                    '⚠️ 这是**意见**，不是门禁裁决：它不改变任何门禁状态，也不构成交付依据。',
                    '机械结论看 `standards_check`；这里回答的是"这些数字要不要紧"。',
                ].join('\n')
                if (!outcome.ok) {
                    return [header, '', `### 未产出评审`, '', outcome.problem ?? '未知原因'].join('\n')
                }
                return [header, '', outcome.report].join('\n')
            },
        }),
        'standards_review',
    )

    register(
        defineTool({
            name: 'standards_status',
            description:
                'Show the standards the workspace currently declares, the baseline it carries (how many violations are grandfathered, when it was frozen, why), and what the most recent standards gate recorded on the mission. Read-only: use it before deciding whether to fix code, exempt paths, or accept the debt.',
            parameters: {
                missionId: { type: 'string', description: 'Mission whose gate history to show (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: { missionId?: string } = {}, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = deps.configFor(agent)
                const loaded = loadStandards(cwd, config.standardsFile, deps.logger)
                const baselinePath = path.isAbsolute(config.baselineFile) ? config.baselineFile : path.join(cwd, config.baselineFile)
                const baselineText = readBaselineText(baselinePath)
                const baseline = baselineText === undefined ? undefined : parseBaselineText(baselineText)
                const store = deps.stores.for(cwd)
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }),
                })
                const last = mission === undefined ? undefined : store.lastGate(mission.id, { source: 'dsh-standards-gate' })
                const rules = loaded.standards === undefined ? {} : loaded.standards.languages
                return [
                    '## 规范现状（standards_status）',
                    '',
                    `工作区：${cwd}`,
                    `规范文件：${loaded.path}${loaded.standards === undefined ? '（**不存在**——先 standards_bootstrap）' : ''}`,
                    ...(loaded.problem === undefined ? [] : ['', loaded.problem]),
                    '',
                    '### 阈值',
                    '',
                    ...(Object.keys(rules).length === 0
                        ? ['- （无）']
                        : Object.entries(rules)
                              .sort((a, b) => a[0].localeCompare(b[0]))
                              .map(([language, ruleset]) => `- ${language}：${describeRuleSet(ruleset)}`)),
                    ...(loaded.standards?.layers === undefined
                        ? []
                        : ['', '### 依赖方向', '', ...loaded.standards.layers.map((layer) => `- \`${layer.path}\` 只能依赖：${layer.mayImport.join('、') || '(仅自身)'}`)]),
                    ...(loaded.standards?.forbidCycles === true ? ['', '- 禁止循环依赖：已开启'] : []),
                    ...(loaded.standards?.exempt === undefined ? [] : ['', `节/豁免：${loaded.standards.exempt.join('、')}`]),
                    '',
                    '### 基线（棘轮）',
                    '',
                    ...(baseline === undefined
                        ? ['- 没有基线：当前所有违规都算新增（第一次 `standards_check({ accept: true })` 可冻结现状）']
                        : [
                              `- 已接受 ${baseline.accepted.length} 项违规`,
                              `- 冻结时间：${baseline.frozenAt}${baseline.note === undefined ? '' : `；理由：${baseline.note}`}`,
                              `- 文件：${baselinePath}`,
                          ]),
                    '',
                    '### 最近一次门禁',
                    '',
                    ...(last === undefined
                        ? ['- 本次 mission 还没有 standards 门禁记录']
                        : [`- ${last.id}：${last.state}（${formatTime(last.checkedAt)}）`, `- 结论：${last.reason}`]),
                ].join('\n')
            },
        }),
        'standards_status',
    )

    return { disposers, registered, failed }
}

/** Longest functions across the workspace, for a bootstrap report. */
function worstFunctionList(result: MetricsResult): { path: string; line: number; name: string; lines: number; depth: number; params: number }[] {
    return result.files
        .flatMap((file) =>
            file.functions.map((fn: { line: number; name: string; lines: number; depth: number; params: number }) => ({
                path: file.path,
                line: fn.line,
                name: fn.name,
                lines: fn.lines,
                depth: fn.depth,
                params: fn.params,
            })),
        )
        .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
        .slice(0, 10)
}

/** Merge caller overrides into the suggestion (per field, never wholesale). */
function mergeThresholds(
    suggested: Record<string, RuleSet>,
    overrides: Record<string, unknown> | undefined,
): Record<string, RuleSet> {
    if (overrides === undefined) return suggested
    const known = ['maxFileLines', 'maxFunctionLines', 'maxDepth', 'maxIfBlockLines', 'maxParams', 'maxExports'] as const
    const out: Record<string, RuleSet> = {}
    for (const [language, ruleset] of Object.entries(suggested)) {
        const merged: RuleSet = { ...ruleset }
        for (const key of known) {
            const value = overrides[key]
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) merged[key] = Math.floor(value)
        }
        out[language] = merged
    }
    return out
}

/** Read raw baseline text without the warn-on-malformed behaviour (status is read-only). */
function readBaselineText(file: string): string | undefined {
    try {
        return readText(file)
    } catch {
        return undefined
    }
}

/** One-line description of a rule set. */
function describeRuleSet(ruleset: RuleSet): string {
    const parts: string[] = []
    const pairs: [keyof RuleSet, string][] = [
        ['maxFileLines', '文件行数'],
        ['maxFunctionLines', '函数行数'],
        ['maxDepth', '嵌套'],
        ['maxIfBlockLines', 'if 块行数'],
        ['maxParams', '参数个数'],
        ['maxExports', '导出数'],
    ]
    for (const [key, label] of pairs) {
        const value = ruleset[key]
        if (typeof value === 'number') parts.push(`${label} ≤ ${value}`)
    }
    return parts.length === 0 ? '(未设阈值)' : parts.join('；')
}

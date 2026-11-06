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
    applyRuleModes,
    ensureDir,
    formatTime,
    normalizeApprovalReply,
    type ApprovalLike,
    gitFingerprint,
    measureWorkspace,
    readJson,
    readText,
    sessionCwd,
    writeTextAtomic,
    type AgentLike,
    type DelegationPresets,
    type DelegationServices,
    type FileMetrics,
    type GateObservation,
    type LayerRule,
    type Logger,
    type MetricsResult,
    type MissionStoreRegistry,
    type RuleSet,
    type StandardsConfig,
    type Violation,
} from 'dsh-eng-core'
import { compareViolations, countByRule, freezeBaseline, parseBaselineText, pruneBaseline, readBaseline, writeMeasurement } from './baseline.js'
import {
    configuredRuleIds,
    declaredRuleIds,
    enforcingKeys,
    enforcingViolations,
    isObserve,
    noRuleModes,
    parseRuleModes,
    renderObservations,
    ruleModeRules,
    ruleVerdicts,
    type RuleModeDeclaration,
} from './rule-modes.js'
import { runStructuralReview, selectReviewTargets } from './review.js'
import { trendsOf } from './trends.js'
import type { StandardsGateConfig } from './config.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** How many file sizes one measurement artifact stores (largest first). */
const SIZE_SAMPLE_LIMIT = 2_000

/**
 * Minimal structural view of `ctx.approval` — the type is shared with the whole
 * suite (`dsh-eng-core`), so an IM answerer can report WHO decided and WHICH card
 * carried the decision, and this plugin records it.
 */
export type { ApprovalLike }
export type ApprovalSeam = ApprovalLike

/** Everything the tools close over. */
export interface ToolDeps {
    config: StandardsGateConfig
    /** Resolved per-call configuration (host row + `<repo>/.dsh/standards-gate.json`). */
    configFor: (agent: AgentLike | undefined) => StandardsGateConfig
    stores: MissionStoreRegistry
    approval: () => ApprovalLike | undefined
    /** `ctx.get('subagents')`, for the read-only structural reviewer. */
    subagents: () => DelegationServices | undefined
    /**
     * The presets THIS plugin registered (`dsh-eng-core`'s delegation seam): the
     * reviewer's persona and allow/deny set travel through a preset mounted into
     * the child scope, because 0.2.2-rc.1's start request has no `toolFilter`.
     */
    presets: DelegationPresets
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
    /** The repository's declared rule modes (`rules` in the standards file). */
    modes: RuleModeDeclaration
    /** Rule-mode configuration problems, before the verdict fold. */
    modeProblems: string[]
    result: MetricsResult
    comparison: ReturnType<typeof compareViolations>
    verdict: 'PASS' | 'WARN' | 'BLOCK'
    reason: string
    /**
     * Shadow (`observe`) rule verdicts of this run, ordered by rule id.
     *
     * They are recorded and reported, never folded into `verdict`; empty means
     * "no rule is observing", and the gate record then keeps its old shape.
     */
    observations: GateObservation[]
    /** Recoverable rule-mode configuration problems (unknown rule id, unusable mode). */
    problems: string[]
    /**
     * The comparison split by mode. ONLY these two arrays may drive a baseline
     * write (`accept` / pruning): a shadow measurement must never move a ratchet.
     */
    enforcing: { added: Violation[]; worsened: Violation[] }
    shadow: { added: Violation[]; worsened: Violation[] }
    gateId?: string
    measurementFile?: string
}

/** Resolve a repository-owned artifact path (an absolute value stays absolute). */
export function artifactPathOf(cwd: string, file: string): string {
    return path.isAbsolute(file) ? file : path.join(cwd, file)
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
 *
 * The optional `rules` map is read HERE, next to the thresholds it belongs to:
 * a rule's mode and its threshold live in the same repository file (under the
 * `.dsh/**` trust root), so the two can never drift apart, and a model cannot
 * mark a rule `observe` on its own.
 */
export function loadStandards(
    cwd: string,
    file: string,
    logger?: Logger,
): { standards?: StandardsConfig; modes: RuleModeDeclaration; problems: string[]; problem?: string; path: string } {
    const target = artifactPathOf(cwd, file)
    const raw = readJson<Record<string, unknown>>(target)
    if (raw === undefined) {
        return {
            path: target,
            modes: noRuleModes(),
            problems: [],
            problem:
                `没有找到规范文件 ${target}。\n` +
                '规范由**目标仓库自己拥有**，插件不会替你猜阈值。下一步：`standards_bootstrap({ action: "measure" })` 看现状与建议阈值，' +
                '确认后 `standards_bootstrap({ action: "freeze" })` 写进仓库（需要人工批准）。',
        }
    }
    const languages = raw['languages']
    if (typeof languages !== 'object' || languages === null || Array.isArray(languages)) {
        return {
            path: target,
            modes: noRuleModes(),
            problems: [],
            problem: `${target} 缺少 languages 段（形如 { "languages": { "go": { "maxFileLines": 400 } } }）。`,
        }
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
    const modes = parseRuleModes(raw['rules'], target)
    const declared = new Set(declaredRuleIds(standards))
    for (const rule of [...modes.modes.keys()].sort()) {
        if (declared.has(rule)) continue
        // A mode without a rule measures nothing: say it instead of leaving a
        // shadow rule that silently never runs (the same reason an unknown mode
        // value is a problem rather than an `observe`).
        modes.problems.push(
            `${target}: rules 里把 "${rule}" 标成了 ${modes.modes.get(rule)}，但规范文件没有声明对应的阈值/开关` +
                '（例如 maxDepth 阈值、layers、forbidCycles），这条规则不会产生任何违规',
        )
    }
    for (const problem of modes.problems) logger?.warn(problem)
    return { standards, modes, problems: modes.problems, path: target }
}

/** The shadow note appended to a reason (empty when nothing observes). */
function shadowNoteOf(observations: readonly GateObservation[]): string {
    if (observations.length === 0) return ''
    const blocks = observations.filter((observation) => observation.would === 'BLOCK').length
    return `；${observations.length} 条 observe 规则只记录（would BLOCK ${blocks} 条），不计入裁决`
}

/**
 * Fold one comparison into a verdict.
 *
 * Every declared rule is evaluated exactly once and handed to
 * `applyRuleModes` — the ONE place that decides which verdicts may veto — so this
 * gate cannot disagree with the quality gate about what `observe` means. The
 * shadow observations are split out here (not in the report) because the same
 * split decides what may be written to the baseline.
 */
function evaluateRun(input: {
    standards: StandardsConfig
    comparison: ReturnType<typeof compareViolations>
    modes: RuleModeDeclaration
    modeProblems: readonly string[]
    truncated: boolean
    maxFiles: number
    filesScanned: number
}): {
    verdict: CheckOutcome['verdict']
    reason: string
    observations: GateObservation[]
    problems: string[]
    enforcing: { added: Violation[]; worsened: Violation[] }
    shadow: { added: Violation[]; worsened: Violation[] }
} {
    const configured = configuredRuleIds(input.standards, input.modes)
    const folded = applyRuleModes(ruleModeRules(configured, input.modes), ruleVerdicts(input.comparison, configured))
    const blocking = folded.effective.rules.filter((verdict) => verdict.state === 'BLOCK')
    const enforcing = {
        added: enforcingViolations(input.comparison.added, input.modes),
        worsened: enforcingViolations(input.comparison.worsened, input.modes),
    }
    const shadow = {
        added: input.comparison.added.filter((violation) => isObserve(input.modes, violation.rule)),
        worsened: input.comparison.worsened.filter((violation) => isObserve(input.modes, violation.rule)),
    }
    const failed = enforcing.added.length + enforcing.worsened.length
    const shadowFailed = shadow.added.length + shadow.worsened.length
    const known = input.comparison.known.length
    const note = shadowNoteOf(folded.observations)
    const verdict: CheckOutcome['verdict'] = failed > 0 ? 'BLOCK' : input.truncated ? 'WARN' : 'PASS'
    const reason =
        failed > 0
            ? `新增 ${enforcing.added.length} 项、恶化 ${enforcing.worsened.length} 项规范违规（基线已接受 ${known} 项）：` +
              `${blocking.map((verdict_) => verdict_.rule).join('、')}${note}`
            : input.truncated
              ? `本次扫描达到文件上限（${input.maxFiles}）：覆盖面不完整，结论按 WARN 处理${note}`
              : shadowFailed > 0
                ? `observe 规则记录到 ${shadowFailed} 项新增/恶化，未计入裁决（基线已接受 ${known} 项，本次扫描 ${input.filesScanned} 个文件）`
                : `无新增违规（基线已接受 ${known} 项，本次扫描 ${input.filesScanned} 个文件）`
    return {
        verdict,
        reason,
        observations: folded.observations,
        problems: [...input.modeProblems, ...folded.problems],
        enforcing,
        shadow,
    }
}

/** Re-fold an outcome's comparison (the accept path rewrites it). */
function applyEvaluation(outcome: CheckOutcome, config: StandardsGateConfig): void {
    const evaluation = evaluateRun({
        standards: outcome.standards,
        comparison: outcome.comparison,
        modes: outcome.modes,
        modeProblems: outcome.modeProblems,
        truncated: outcome.result.stats.truncated,
        maxFiles: config.maxFiles,
        filesScanned: outcome.result.stats.filesScanned,
    })
    outcome.verdict = evaluation.verdict
    outcome.reason = evaluation.reason
    outcome.observations = evaluation.observations
    outcome.problems = evaluation.problems
    outcome.enforcing = evaluation.enforcing
    outcome.shadow = evaluation.shadow
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
    const baselinePath = artifactPathOf(cwd, config.baselineFile)
    const baseline = readBaseline(baselinePath, deps.logger)
    const comparison = compareViolations(result.violations, baseline)
    const outcome: CheckOutcome = {
        cwd,
        standards: loaded.standards,
        modes: loaded.modes,
        modeProblems: loaded.problems,
        result,
        comparison,
        verdict: 'PASS',
        reason: '',
        observations: [],
        problems: [],
        enforcing: { added: [], worsened: [] },
        shadow: { added: [], worsened: [] },
    }
    applyEvaluation(outcome, config)
    return outcome
}

/** Render the measurement as the text a model/human reads. */
export function renderCheck(outcome: CheckOutcome, config: StandardsGateConfig): string {
    const { result, comparison } = outcome
    const languages = Object.entries(result.stats.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([language, count]) => `${language} ${count}`)
        .join('、')
    const wouldByRule = new Map(outcome.observations.map((observation) => [observation.rule, observation.would]))
    // A shadow row is a RECORDING, never a verdict: it says `[影子 would=…]` so no
    // reader (model, human, retrospective) can mistake it for PASS/FAIL/BLOCK.
    const marker = (rule: string): string => {
        const would = wouldByRule.get(rule)
        return would === undefined ? '' : ` [影子 would=${would}]`
    }
    const violationRow = (violation: Violation): string =>
        `${isObserve(outcome.modes, violation.rule) ? '[影子 would=BLOCK] ' : ''}${violation.detail}`
    const enforcingFailed = outcome.enforcing.added.length + outcome.enforcing.worsened.length
    const shadowAdded = outcome.shadow.added
    const shadowWorsened = outcome.shadow.worsened
    const shadowFixed = comparison.fixed.filter((key) => isObserve(outcome.modes, key.split('|')[0] ?? ''))
    const lines = [
        `## 规范检查（dsh-standards-gate）— ${outcome.verdict}`,
        '',
        `工作区：${outcome.cwd}`,
        `扫描：${result.stats.filesScanned} 个文件（豁免 ${result.stats.exempted} 个${result.stats.truncated ? '；**已达上限，结论不完整**' : ''}）${languages === '' ? '' : `；语言：${languages}`}`,
        `结论：${outcome.reason}`,
        ...(outcome.problems.length === 0 ? [] : [`配置问题：${outcome.problems.join('；')}`]),
        ...(outcome.gateId === undefined ? [] : [`门禁记录：${outcome.gateId}`]),
        ...(outcome.measurementFile === undefined ? [] : [`度量明细：${outcome.measurementFile}`]),
        ...renderObservations(outcome.observations, outcome.verdict, config.standardsFile),
        '',
        '### 违规（按规则统计）',
        '',
        ...(result.violations.length === 0
            ? ['- 无']
            : Object.entries(countByRule(result.violations))
                  .sort((a, b) => b[1] - a[1])
                  .map(([rule, count]) => `- ${rule}：${count}${marker(rule)}`)),
        '',
        ...(comparison.added.length === 0
            ? ['### 新增违规', '', '- 无（与基线一致）']
            : [
                  outcome.enforcing.added.length > 0
                      ? `### 新增违规（${comparison.added.length} 项：门禁失败的原因${shadowAdded.length === 0 ? '' : `，其中 ${shadowAdded.length} 项来自 observe 规则、不阻断`}）`
                      : `### 新增违规（${comparison.added.length} 项：全部来自 observe 规则，不阻断门禁）`,
                  '',
                  ...comparison.added.slice(0, 25).map((violation) => `- ${violationRow(violation)}`),
                  ...(comparison.added.length > 25 ? [`- …另有 ${comparison.added.length - 25} 项（见度量明细）`] : []),
              ]),
        ...(comparison.worsened.length === 0
            ? []
            : [
                  '',
                  outcome.enforcing.worsened.length > 0
                      ? `### 恶化（${comparison.worsened.length} 项：基线接受过，但比当初更严重${shadowWorsened.length === 0 ? '' : `，其中 ${shadowWorsened.length} 项来自 observe 规则、不阻断`}）`
                      : `### 恶化（${comparison.worsened.length} 项：全部来自 observe 规则，不阻断门禁）`,
                  '',
                  ...comparison.worsened.slice(0, 15).map((violation) => `- ${violationRow(violation)}`),
                  ...(outcome.enforcing.worsened.length === 0
                      ? []
                      : ['这些不是"新问题"，而是旧债变大：要么改回去，要么重新走一次 accept（人工批准）把新的尺度记进基线。']),
              ]),
        ...(comparison.fixed.length === 0
            ? []
            : result.stats.truncated
              ? [
                    '',
                    `### 已消除（${comparison.fixed.length} 项）— **本次扫描不完整，不能当真**`,
                    '',
                    `本次只扫了 ${result.stats.filesScanned} 个文件（已达上限）：这些"已消除"可能只是没被扫到。`,
                    '提高 maxFiles 或缩小工作区后重跑，再据此收紧基线。',
                ]
              : [
                    '',
                    `### 已消除（${comparison.fixed.length} 项）`,
                    '',
                    ...comparison.fixed.slice(0, 10).map((key) => `- ${key}`),
                    ...(shadowFixed.length === 0
                        ? []
                        : [
                              `其中 ${shadowFixed.length} 项属于 observe 规则：它们**不会**被从基线里收紧——影子只测量，棘轮不动，` +
                                  '切回 enforce 后仍按原基线判定。',
                          ]),
                ]),
        '',
        ...(enforcingFailed === 0
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
    // Build output is ignored at the workspace root, but a monorepo keeps a
    // `dist/` (or `build/`) next to every package: generated bundles must not be
    // measured as if a human had written them.
    '**/dist/**',
    '**/build/**',
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
 * Record the gate for a standards run.
 *
 * A helper (not inline code) because the `accept` path must record too: printing
 * a verdict the ledger does not contain is how a report starts lying.
 */
function recordStandardsGate(
    deps: ToolDeps,
    store: ReturnType<MissionStoreRegistry['for']>,
    missionId: string,
    outcome: CheckOutcome,
    cwd: string,
    fingerprint = gitFingerprint(cwd),
): string {
    return store.recordGate(missionId, {
        source: 'dsh-standards-gate',
        state: outcome.verdict,
        reason: outcome.reason,
        results: [],
        scope: { selected: ['standards'], total: 1, full: !outcome.result.stats.truncated },
        fingerprint,
        // Only a run that HAS shadow verdicts grows the field: a run with no
        // observing rule keeps the record shape it always had, byte for byte.
        ...(outcome.observations.length === 0 ? {} : { observations: outcome.observations }),
    }).id
}

/** Write the measurement detail (violations + file sizes) next to the gate. */
function writeStandardsArtifact(
    deps: ToolDeps,
    store: ReturnType<MissionStoreRegistry['for']>,
    missionId: string,
    outcome: CheckOutcome,
): string | undefined {
    if (outcome.gateId === undefined) return undefined
    const file = store.artifactPath(missionId, path.join('standards', `${outcome.gateId}.json`))
    try {
        // File sizes ride along (bounded): one measurement per run is enough to
        // answer "which file got fatter during this mission" by comparing the
        // first and the last one.
        const sizes: Record<string, number> = {}
        for (const entry of [...outcome.result.files].sort((a, b) => b.lines - a.lines).slice(0, SIZE_SAMPLE_LIMIT)) {
            sizes[entry.path] = entry.lines
        }
        writeMeasurement(file, {
            checkedAt: Date.now(),
            verdict: outcome.verdict,
            reason: outcome.reason,
            scanned: outcome.result.stats,
            sizes,
            violations: outcome.result.violations,
            // `added` keeps its old meaning (what would fail the gate), so a
            // consumer comparing two measurements is not suddenly fed shadow
            // rows; the shadow measurement is preserved in its own field and in
            // `observations` — it is READ by humans, never by the ratchet.
            added: outcome.enforcing.added.map((violation) => violation.key),
            known: outcome.comparison.known.length,
            fixed: outcome.comparison.fixed,
            ...(outcome.observations.length === 0
                ? {}
                : {
                      observations: outcome.observations,
                      shadow: {
                          added: outcome.shadow.added.map((violation) => violation.key),
                          worsened: outcome.shadow.worsened.map((violation) => violation.key),
                      },
                  }),
        })
        return file
    } catch (error) {
        deps.logger?.warn('度量明细写入失败：', error)
        return undefined
    }
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
                'Measure the workspace against the structural standards the repository declares in `<repo>/.dsh/standards.json` (file/function size, nesting depth, branch size, parameter count, exported surface, module dependency direction, import cycles) and record the verdict on the mission as a gate. Violations the baseline already accepted do not fail; NEW violations do. A rule the repository marks `observe` (in that file\'s `rules` map) is still measured and its would-be verdict is recorded in the gate record (observations) and printed in a dedicated shadow section, but it never contributes to PASS/WARN/BLOCK and never blocks; only enforcing rules decide the verdict, and a shadow measurement never touches the baseline (not by `accept`, not by pruning). `accept: true` widens the baseline to today\'s violations — that requires human approval (the ratchet must not be loosenable by the model alone). Missing standards file → run standards_bootstrap.',
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
                if (args.missionId !== undefined && args.missionId !== '' && store.read(args.missionId) === undefined) {
                    const known = store.list().map((mission) => mission.id)
                    throw new Error(
                        `未知 mission "${args.missionId}"：按 fail closed 拒绝（否则这次检查会静默地不记录任何门禁，看起来却像成功）。` +
                            `可用 mission：${known.join(', ') || '(无)'}。`,
                    )
                }
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }),
                })

                // Accepting today's violations is the only action that LOOSENS a
                // check, so it is the only one that needs a person.
                //
                // THE RATCHET RULE: only ENFORCING rules may be accepted. A rule
                // in `observe` still measures, but its violations are not
                // grandfathered — otherwise observing today would hand the rule a
                // baseline it never earned, and switching it to enforce would find
                // tomorrow's verdict already bought.
                const acceptable = outcome.enforcing.added
                const shadowOnlyAdded = outcome.shadow.added
                // A shadow rule's worsening is just as unaccepted as its addition:
                // freezing it would record a magnitude it never earned.
                const shadowOnlyWorsened = outcome.shadow.worsened
                const shadowOnly = shadowOnlyAdded.length + shadowOnlyWorsened.length
                if (args.accept === true && acceptable.length > 0) {
                    const approve = async (reason: string): Promise<boolean> => {
                        const seam = deps.approval()
                        if (seam === undefined) return false
                        const decision = normalizeApprovalReply(
                            await seam.request({
                                ...(agent === undefined ? {} : { agent }),
                                toolName: 'standards_check',
                                reason,
                                ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                            }),
                        )
                        return decision.allowed
                    }
                    if (args.dryRun === true) {
                        return [
                            renderCheck(outcome, config),
                            '',
                            `### 预演：accept 会把 ${acceptable.length} 项违规写入基线（未写盘）`,
                            ...acceptable.slice(0, 10).map((violation) => `- ${violation.detail}`),
                            ...(shadowOnlyAdded.length === 0
                                ? []
                                : [`（另有 ${shadowOnlyAdded.length} 项来自 observe 规则：**不会**写入基线，见下。）`]),
                        ].join('\n')
                    }
                    if (config.requireApprovalForBaseline) {
                        const allowed = await approve(
                            [
                                `规范检查要求放宽基线：把 ${acceptable.length} 项**新增**违规记为"已接受"。`,
                                '',
                                ...acceptable.slice(0, 12).map((violation) => `- ${violation.detail}`),
                                ...(acceptable.length > 12
                                    ? [`- …另有 ${acceptable.length - 12} 项未列出（合计 ${acceptable.length} 项）`]
                                    : []),
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
                    const baselinePath = artifactPathOf(cwd, config.baselineFile)
                    // Only enforcing rules are frozen: an observe rule keeps its
                    // violations OUT of the baseline, in both `accepted` and
                    // `entries` (a magnitude is an acceptance too).
                    const accepted = freezeBaseline({
                        file: baselinePath,
                        violations: enforcingViolations(outcome.result.violations, outcome.modes),
                        note:
                            args.note === undefined || args.note === ''
                                ? `standards_check 接受 ${acceptable.length} 项新增违规`
                                : args.note,
                    })
                    deps.logger?.for(cwd).info(`standards-gate: 基线已更新（${baselinePath}，接受 ${accepted.accepted.length} 项）`)
                    // The report after an accept: enforcing rules are accepted, so
                    // only the SHADOW side is still "added"/"worsened" — it stays
                    // unaccepted on purpose, and saying so is the honest shape.
                    outcome.comparison = {
                        added: shadowOnlyAdded,
                        known: enforcingViolations(outcome.result.violations, outcome.modes),
                        fixed: outcome.comparison.fixed,
                        worsened: outcome.shadow.worsened,
                        present: true,
                    }
                    applyEvaluation(outcome, config)
                    outcome.reason = `基线已更新：接受 ${accepted.accepted.length} 项违规（人工批准，只含 enforce 规则）${shadowNoteOf(outcome.observations)}`
                    // The report says PASS, so the LEDGER must say PASS too: a
                    // version that returned here without recording left the old
                    // BLOCK in place while the tool printed a pass (an audit
                    // caught exactly that difference between words and records).
                    const acceptedGateId = mission === undefined ? undefined : recordStandardsGate(deps, store, mission.id, outcome, cwd)
                    // The artifact writer keys off `outcome.gateId`; forgetting this
                    // assignment meant the accepted run left no measurement detail
                    // (caught by the ledger-vs-words test below).
                    outcome.gateId = acceptedGateId
                    const measured = mission === undefined ? undefined : writeStandardsArtifact(deps, store, mission.id, outcome)
                    return [
                        renderCheck(outcome, config),
                        '',
                        `基线已写入 ${baselinePath}（${formatTime(Date.now())}）。`,
                        ...(acceptedGateId === undefined ? ['（没有 mission：未记录门禁）'] : [`门禁记录：${acceptedGateId}`]),
                        ...(measured === undefined ? [] : [`度量明细：${measured}`]),
                        ...(shadowOnly === 0
                            ? []
                            : [
                                  '',
                                  `### accept 不动 observe 规则（${shadowOnly} 项未写入基线）`,
                                  '',
                                  '这些违规属于 observe 规则：影子只测量，不豁免。把它们记进基线等于先豁免再测量，',
                                  '所以它们留在这里、并继续出现在报告的影子段落里；切回 enforce 时会照常判定（届时可以再决定是否 accept）。',
                              ]),
                    ].join('\n')
                }
                // `accept` asked for, but every new violation belongs to an observe
                // rule: nothing may be written, and the report says why instead of
                // printing a silent no-op.
                if (args.accept === true && shadowOnly > 0) {
                    deps.logger
                        ?.for(cwd)
                        .info(`standards-gate: accept 未写入基线（${shadowOnly} 项新增/恶化全部来自 observe 规则）`)
                }

                const fingerprint = gitFingerprint(cwd)
                // `warn` means "tell me, do not block me": a BLOCK record would be
                // picked up by consumers that require a PASS (the orchestrator's
                // standards-pass gate, evidence-gate's requireStandardsGate), which
                // is exactly what the host asked not to happen.
                if (config.enforce === 'warn' && outcome.verdict === 'BLOCK') {
                    outcome.verdict = 'WARN'
                    outcome.reason = `${outcome.reason}（宿主设 enforce=warn：记录为 WARN，不阻断交付）`
                }
                // A violation that disappeared is progress: drop its acceptance so a
                // later revert cannot ride the old acceptance. Tightening only, so
                // it needs no approval (and it is skipped when the scan was partial,
                // because "not scanned" is not "fixed").
                //
                // THE RATCHET RULE, second half: pruning is a tightening write, and
                // a shadow measurement must not tighten either — an observe rule's
                // acceptance stays exactly as it was, so switching the rule back to
                // enforce behaves as if the observe run never happened.
                if (!outcome.result.stats.truncated && outcome.comparison.fixed.length > 0) {
                    const prunable = enforcingKeys(outcome.comparison.fixed, outcome.modes)
                    const pruned =
                        prunable.length === 0
                            ? undefined
                            : pruneBaseline(
                                  artifactPathOf(cwd, config.baselineFile),
                                  prunable,
                                  readBaseline(artifactPathOf(cwd, config.baselineFile), deps.logger),
                              )
                    if (pruned !== undefined) {
                        deps.logger?.for(cwd).info(`standards-gate: 基线收紧（消除 ${prunable.length} 项）`)
                    }
                }
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
                    outcome.gateId = recordStandardsGate(deps, store, mission.id, outcome, cwd, fingerprint)
                    // The detail (violations + file sizes) goes with the record:
                    // it is what `standards_status` compares to show what got
                    // fatter, and what a human reads when the gate says BLOCK.
                    outcome.measurementFile = writeStandardsArtifact(deps, store, mission.id, outcome)
                }
                return [
                    renderCheck(outcome, config),
                    ...(args.accept === true && shadowOnly > 0
                        ? [
                              '',
                              `### accept 没有写入任何东西（${shadowOnly} 项新增/恶化全部来自 observe 规则）`,
                              '',
                              '影子规则的新增违规不会被记进基线：先测量、再决定，把它们豁免掉就等于跳过了这次测量。',
                              '把该规则的 mode 改成 enforce（或删掉 rules 里的那条）后重跑，届时再决定是否 accept。',
                          ]
                        : []),
                ].join('\n')
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
                const target = artifactPathOf(cwd, config.standardsFile)

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
                // Freezing thresholds must not silently drop the rule MODES an
                // operator committed: a rule they marked `observe` would become
                // enforcing again — a gate change nobody asked for. The existing
                // `rules` map is carried over verbatim (validated by the reader).
                const existing = readJson<Record<string, unknown>>(target)
                const carriedRules = existing?.['rules']
                const body = {
                    languages: merged,
                    exempt: [...DEFAULT_EXEMPT],
                    forbidCycles: true,
                    ...(carriedRules === undefined ? {} : { rules: carriedRules }),
                    ...(args.note === undefined || args.note === '' ? {} : { note: args.note }),
                }
                if (config.requireApprovalForBaseline) {
                    if (seam === undefined) {
                        throw new Error(
                            '宿主没有装配审批通道（ctx.approval）：写入仓库级规范需要人工批准，按 fail closed 拒绝。' +
                                '下一步：让宿主装配审批插件（或人工把上面的 JSON 写进 ' + target + '）。',
                        )
                    }
                    const decided = normalizeApprovalReply(await seam.request({
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
                    }))
                    if (!decided.allowed) {
                        return [
                            report,
                            '',
                            '### 未写入',
                            '',
                            `人工审批未通过（${decided.decision}${decided.by === '' ? '' : `，by ${decided.by}`}${decided.source === '' ? '' : ` via ${decided.source}`}）：规范文件保持不变。`,
                        ].join('\n')
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
                        presets: deps.presets,
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
                'Show the standards the workspace currently declares (including which rules are shadow `observe` ones), the baseline it carries (how many violations are grandfathered, when it was frozen, why), and what the most recent standards gate recorded on the mission — including that record\'s shadow observations; a legacy record without observations reads as "no observation" and is not an error. Read-only: use it before deciding whether to fix code, exempt paths, or accept the debt.',
            parameters: {
                missionId: { type: 'string', description: 'Mission whose gate history to show (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: { missionId?: string } = {}, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOf(agent)
                const config = deps.configFor(agent)
                const loaded = loadStandards(cwd, config.standardsFile, deps.logger)
                const baselinePath = artifactPathOf(cwd, config.baselineFile)
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
                    ...(loaded.standards?.exempt === undefined ? [] : ['', `豁免：${loaded.standards.exempt.join('、')}`]),
                    ...(loaded.modes.modes.size === 0
                        ? []
                        : [
                              '',
                              '### 规则模式（rules）',
                              '',
                              ...[...loaded.modes.modes.entries()]
                                  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                                  .map(([rule, mode]) =>
                                      mode === 'observe'
                                          ? `- \`${rule}\`：observe（只测量、记进 observations，不阻断；**不会**写进基线）`
                                          : `- \`${rule}\`：enforce`,
                                  ),
                          ]),
                    ...(loaded.problems.length === 0 ? [] : ['', `配置问题：${loaded.problems.join('；')}`]),
                    '',
                    '### 基线（棘轮）',
                    '',
                    ...(baseline === undefined
                        ? [
                              baselineText === undefined
                                  ? '- 没有基线：当前所有违规都算新增（第一次 `standards_check({ accept: true })` 可冻结现状）'
                                  : `- ⚠️ 基线文件存在但**无法解析**（${baselinePath}）：按"没有基线"处理（会报告全部违规），请修好它或用 accept 重新冻结`,
                          ]
                        : [
                              `- 已接受 ${baseline.accepted.length} 项违规`,
                              `- 冻结时间：${baseline.frozenAt}${baseline.note === undefined ? '' : `；理由：${baseline.note}`}`,
                              `- 文件：${baselinePath}`,
                          ]),
                    '',
                    '### 本次 mission 的变化',
                    '',
                    ...(mission === undefined
                        ? ['- （没有 mission：无法比较历史测量）']
                        : (() => {
                              const trends = trendsOf(store.artifactPath(mission.id, 'standards'), 8)
                              if (trends === undefined) {
                                  return ['- 只有一次测量（或还没有）：跑第二次 `standards_check` 后这里会显示"哪个文件变胖/变瘦、哪些违规新增/消除"']
                              }
                              return [
                                  ...(trends.grew.length === 0 ? ['- 没有文件变大'] : trends.grew.map((delta) => `- 变胖：${delta.path} ${delta.from} → ${delta.to} 行（+${delta.lines}）`)),
                                  ...(trends.shrank.length === 0 ? [] : trends.shrank.map((delta) => `- 变瘦：${delta.path} ${delta.from} → ${delta.to} 行（${delta.lines}）`)),
                                  `- 违规：新增 ${trends.addedViolations.length} 项、消除 ${trends.fixedViolations.length} 项`,
                                  ...trends.addedViolations.slice(0, 5).map((key) => `  - 新增 ${key}`),
                                  ...trends.fixedViolations.slice(0, 5).map((key) => `  - 消除 ${key}`),
                              ]
                          })()),
                    '',
                    '### 最近一次门禁',
                    '',
                    ...(last === undefined
                        ? ['- 本次 mission 还没有 standards 门禁记录']
                        : [
                              `- ${last.id}：${last.state}（${formatTime(last.checkedAt)}）`,
                              `- 结论：${last.reason}`,
                              // A record written before shadow mode existed has no
                              // `observations`: that reads as "no observation" and
                              // is never an error.
                              ...(last.observations === undefined || last.observations.length === 0
                                  ? []
                                  : renderObservations(last.observations, last.state, config.standardsFile).map(
                                        (line) => `  ${line}`,
                                    )),
                          ]),
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

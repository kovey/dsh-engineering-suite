/**
 * The model-facing tool surface: `impact_analyze`, `impact_tests`,
 * `impact_status`.
 *
 * Division of labour, the same one the rest of the suite follows:
 *
 *  - the ANALYSIS is deterministic (core's `changedRanges` / `analyzeImpact` /
 *    `renderTestCommand`): a diff, a reverse-import closure and three kinds of
 *    test evidence. No model judgement enters the selection.
 *  - the COMMAND comes from the host (`testCommandTemplate`). This plugin never
 *    guesses a runner: a wrong guess renders a plausible command that tests
 *    nothing, and the mistake looks like a green gate. No template → refuse with
 *    the exact next step.
 *  - the RECORD is an artifact plus an `artifact` evidence row on the mission
 *    (`store.writeArtifact` / `store.appendEvidence` — core exposes no
 *    `recordEvidence`; nothing is invented here). No mission → the analysis still
 *    runs and the report says the record is missing.
 *  - the OPT-IN reviewer (`reviewDispatch`) adds an opinion about what the import
 *    graph cannot see. It never changes the risk level.
 *
 * @module dsh-impact-gate/tools
 */

import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    RISK_RULES,
    analyzeImpact,
    changedRanges,
    formatTime,
    isSafeId,
    isTestPath,
    listDir,
    measureWorkspace,
    readJson,
    renderTestCommand,
    stamp,
    type AgentLike,
    type ChangedFile,
    type ImpactReport,
    type ImpactedFile,
    type Logger,
    type MissionRecord,
    type MissionStore,
    type MissionStoreRegistry,
    type SelectedTest,
} from 'dsh-eng-core'
import { TEMPLATE_EXAMPLES, type EffectiveConfig, type ImpactGateConfig } from './config.js'
import {
    changeSourceLabel,
    resolveChangeSet,
    sourceLabel,
    type ChangeProviderDeps,
    type ChangeProvenance,
} from './changes.js'
import {
    buildPlan,
    clampRuns,
    currentQuarantines,
    DEFAULT_UNSEEN_RUNS,
    listFlakyPlans,
    observeRuns,
    quarantineFileFor,
    readQuarantine,
    readReport,
    renderPlan,
    renderStatus as renderFlakyStatus,
    repeatCommand,
    tallyRuns,
    type FlakyPlan,
} from './flaky.js'
import { runImpactReview, selectReviewTargets, type ReviewOutcome, type SubagentsLike } from './review.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Display caps: a report is read by a human, the artifact keeps everything. */
const DISPLAY_CHANGED = 20
const DISPLAY_IMPACTED = 30
const DISPLAY_TESTS = 40
const DISPLAY_UNREACHED = 20

/** Bound on the reviewer's prose stored inside the JSON artifact. */
const ARTIFACT_REVIEW_CHARS = 8_000

/**
 * What a file-level import graph structurally cannot see.
 *
 * Written in the report, not in a footnote: a selection that pretends to be
 * complete is worse than one that names its blind spots.
 */
export const BLIND_SPOTS: readonly string[] = [
    '接口 / 多态派发：按接口调用的地方，实现方与调用方之间没有 import 边（Go 的 interface、TS 的结构类型、Python 的鸭子类型）',
    '依赖注入与容器注册：wire / DI 容器 / Provider / 装饰器装配的实现在装配点之外没有 import 边',
    '反射与元编程：按字符串、注解或装饰器在运行时解析的类型（`reflect`、`getattr`、`Class.forName`）',
    '字符串查表：路由表、事件名、配置键、迁移名、模板名等按名字引用的位置',
    '动态 import 与代码生成：条件导入、`importlib`、生成的客户端/桩代码',
    '跨进程 / 跨语言边界：HTTP、gRPC、消息队列、数据库 schema、CLI 参数',
    '非源码文件：模板、SQL、proto、YAML/JSON 配置不参与导入图',
    '测试选择的兜底只是启发式：既不 import 被测代码、又不同目录/同名的测试（例如独立的表驱动集成测试）不会被选中',
]

/** Minimal structural view of the tool execution identity. */
interface ExecLike {
    agent?: AgentLike
    signal?: AbortSignal
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: ImpactGateConfig
    /** Effective config for one workspace (profile row + `<repo>/.dsh/impact-gate.json`). */
    configFor: (cwd: string) => EffectiveConfig
    /** Where the change set may come from: the host's `workspaceChanges` service, or git. */
    changes: ChangeProviderDeps
    stores: MissionStoreRegistry
    /** `ctx.get('subagents')`, used only when `reviewDispatch.enabled`. */
    subagents: () => SubagentsLike | undefined
    /** `ctx.get('subprocess')`, used by `flaky_plan`'s repeated-run mode. */
    subprocess: () => unknown
    logger?: Logger
}

/** Arguments of `impact_analyze`. */
interface AnalyzeArgs {
    base?: string
    /** Declared `json` so a wrong shape reaches the tool and gets a real answer. */
    paths?: unknown
    missionId?: string
}

/** Arguments of `impact_tests`. */
interface TestsArgs extends AnalyzeArgs {
    template?: string
}

/** Arguments of `impact_status`. */
interface StatusArgs {
    missionId?: string
}

/** Arguments of `flaky_plan`. */
interface FlakyPlanArgs {
    missionId?: string
    report?: string
    runs?: number
    command?: string
}

/** Arguments of `flaky_status`. */
interface FlakyStatusArgs {
    missionId?: string
}

/** One analysis run, as recorded on the mission. */
export interface ImpactArtifact {
    version: 1
    plugin: 'dsh-impact-gate'
    generatedAt: string
    cwd: string
    /** The base the analysis used (`(explicit paths)` in paths mode). */
    base: string
    /** Explicit paths, when the caller supplied them instead of a diff. */
    paths?: readonly string[]
    /** Explicit paths that did not exist on disk at analysis time. */
    missingPaths?: readonly string[]
    /**
     * Whether the GIT diff could be read (always true in paths mode).
     *
     * With `changeSource.source === 'workspaceChanges'` this describes the
     * cross-check read only: the change set itself came from the host service,
     * and `changeSource` is the field that says so.
     */
    diffRead: boolean
    /** Why the git diff could not be read, verbatim from core. */
    diffProblem?: string
    /**
     * Which source produced the change set, and what it could not tell us.
     *
     * Recorded because the two sources answer different questions: a reader of
     * this artifact must be able to tell a turn snapshot from a diff against a
     * ref without reading the tool output.
     */
    changeSource: ChangeProvenance
    risk: ImpactReport['risk']
    reasons: readonly string[]
    counts: { changed: number; impacted: number; tests: number; unreached: number }
    changed: readonly ChangedFile[]
    impacted: readonly ImpactedFile[]
    tests: readonly SelectedTest[]
    unreached: readonly string[]
    stats: ImpactReport['stats']
    blindSpots: readonly string[]
    config: {
        defaultBase: string
        maxDistance: number
        maxFiles: number
        maxFileBytes: number
        /** The configured source (`auto` / `workspaceChanges` / `git`). */
        changeSource: ImpactGateConfig['changeSource']
        /** `null` = the host has not configured a runner (`impact_tests` refuses). */
        testCommandTemplate: string | null
        fullTestCommand: string | null
    }
    review?: {
        ok: boolean
        runId?: string
        outputFile?: string
        stopReason?: string
        report: string
        problem?: string
    }
}

// --- small pure helpers ---------------------------------------------------

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as ExecLike).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as ExecLike).signal
}

/**
 * The workspace this call acts on, or a refusal.
 *
 * `header.cwd` is the only durable answer; falling back to `process.cwd()` would
 * analyse (and record against) some unrelated repository.
 */
function declaredCwdOf(agent: AgentLike | undefined): string {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            '无法确定工作区：调用方 agent 没有会话目录（session.header.cwd）。影响分析必须在知道工作区的前提下运行，' +
                '否则会把某个不相关的仓库当成分析对象。下一步：在有工作区的会话里调用；嵌入场景请由宿主补上 header.cwd。',
        )
    }
    return cwd
}

/** `高（high）` / `中（medium）` / `低（low）`. */
export function riskLabel(risk: ImpactReport['risk']): string {
    return risk === 'high' ? '高（high）' : risk === 'medium' ? '中（medium）' : '低（low）'
}

/** Chinese label of one diff status. */
function statusLabel(status: ChangedFile['status']): string {
    if (status === 'added') return '新增'
    if (status === 'deleted') return '删除'
    if (status === 'renamed') return '重命名'
    if (status === 'untracked') return '未跟踪（视作整文件新增）'
    return '修改'
}

/** Chinese label of one test-selection reason. */
function reasonLabel(test: SelectedTest): string {
    switch (test.reason) {
        case 'changed':
            return '改动本身就是测试文件'
        case 'imports-changed':
            return `导入改动文件（距离 ${test.distance ?? '?'}）`
        case 'same-package':
            return '与改动文件同目录（Go 这类测试不 import 被测包时的兜底证据）'
        case 'name-match':
            return '与改动文件同名'
    }
}

/** The added line ranges of one changed file, in Chinese. */
function describeAdded(file: ChangedFile): string {
    const parts: string[] = []
    if (file.added.length === 0) parts.push('无新增行')
    else parts.push(`新增 ${file.added.map(([start, end]) => (start === end ? `L${start}` : `L${start}-L${end}`)).join('、')}`)
    if (file.removed > 0) parts.push(`删除 ${file.removed} 行`)
    return parts.join('，')
}

/** Impacted files grouped by distance, deterministic. */
export function groupByDistance(impacted: readonly ImpactedFile[]): [number, ImpactedFile[]][] {
    const groups = new Map<number, ImpactedFile[]>()
    for (const file of impacted) {
        const bucket = groups.get(file.distance) ?? []
        bucket.push(file)
        groups.set(file.distance, bucket)
    }
    return [...groups.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([distance, files]) => [distance, [...files].sort((a, b) => a.path.localeCompare(b.path))] as [number, ImpactedFile[]])
}

/**
 * Validate the `paths` argument.
 *
 * Declared as `type: 'json'` so a wrong shape reaches this function instead of
 * being rejected by the schema: "paths: 'src/a.ts'" is a reasonable call and gets
 * a usable answer, while `paths: []` is a mistake that must not silently mean
 * "analyse nothing".
 */
export function parsePaths(value: unknown): { paths?: string[]; problem?: string } {
    if (value === undefined || value === null) return {}
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed === '') {
            return {
                problem:
                    'paths 是空字符串：无法据此确定要分析的文件。下一步：传工作区相对路径（如 paths: ["src/store/store.ts"]），或完全不传 paths（那样会读 git diff）。',
            }
        }
        return { paths: [trimmed] }
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return {
                problem:
                    'paths 是空数组：要么给出至少一个路径，要么完全不传 paths（那样会读 git diff）。' +
                    '下一步：impact_analyze({ paths: ["src/a.ts"] }) 或 impact_analyze({})。',
            }
        }
        const paths: string[] = []
        for (const entry of value) {
            if (typeof entry !== 'string' || entry.trim() === '') {
                return {
                    problem: `paths 里必须全是非空字符串（${JSON.stringify(entry)} 不是）。下一步：改成 paths: ["src/a.ts", "src/b.ts"]，或不传 paths 让工具读 diff。`,
                }
            }
            paths.push(entry.trim())
        }
        return { paths }
    }
    return {
        problem: `paths 必须是字符串数组（或单个字符串），收到 ${typeof value}。下一步：改成 paths: ["src/a.ts"]，或不传 paths 让工具读 diff。`,
    }
}

/** Resolve the diff base: the explicit argument wins over the configured default. */
function baseOf(base: string | undefined, config: ImpactGateConfig): string {
    const trimmed = typeof base === 'string' ? base.trim() : ''
    return trimmed === '' ? config.defaultBase : trimmed
}

// --- mission plumbing -----------------------------------------------------

/**
 * Resolve the mission, fail closed.
 *
 * Same rule as the rest of the suite: explicit id → this session's binding →
 * the delegating parent's binding. A `missionId` that does not exist is an error
 * rather than "record nothing": an analysis that silently fails to record looks
 * like a successful one.
 */
function resolveMission(
    store: MissionStore,
    agent: AgentLike | undefined,
    explicitId: string | undefined,
): MissionRecord | undefined {
    const id = typeof explicitId === 'string' ? explicitId.trim() : ''
    if (id === '') return store.resolveForAgent(agent)
    if (!isSafeId(id)) {
        throw new Error(
            `mission id 不合法（${JSON.stringify(id)}）：id 是单个路径段，不能含 "/"、".." 或以 "." 开头。下一步：用 spec_status 取一个正确的 missionId。`,
        )
    }
    const mission = store.read(id)
    if (mission === undefined) {
        const known = store.list().map((entry) => entry.id)
        throw new Error(
            `未知 mission "${id}"：按 fail closed 拒绝（否则这次分析不会落盘、也不会记证据，看起来却像成功）。` +
                `可用 mission：${known.join('、') || '(无)'}。下一步：用 spec_create 建任务，或用 spec_status 看当前任务的 id。`,
        )
    }
    return mission
}

/** What one artifact write produced. */
interface Recorded {
    missionId: string
    /** Mission-relative path, e.g. `impact/20260922-173000.json`. */
    relative: string
    /** Absolute path on disk. */
    absolute: string
    /** The `artifact` evidence row id. */
    evidenceId: string
}

/** Build the artifact body (pure: the clock is passed in, nothing is read). */
export function buildArtifact(input: {
    report: ImpactReport
    config: ImpactGateConfig
    generatedAt: string
    /** Where the change set came from; recorded verbatim. */
    provenance: ChangeProvenance
    paths?: readonly string[]
    missingPaths?: readonly string[]
    diff?: { isRepo: boolean; problem?: string }
    review?: ReviewOutcome
}): ImpactArtifact {
    const { report, config } = input
    const diffRead = input.paths !== undefined || input.diff === undefined || input.diff.problem === undefined
    return {
        version: 1,
        plugin: 'dsh-impact-gate',
        generatedAt: input.generatedAt,
        cwd: report.cwd,
        base: report.base,
        ...(input.paths === undefined ? {} : { paths: input.paths }),
        ...(input.missingPaths === undefined || input.missingPaths.length === 0 ? {} : { missingPaths: input.missingPaths }),
        diffRead,
        ...(input.diff?.problem === undefined ? {} : { diffProblem: input.diff.problem }),
        changeSource: input.provenance,
        risk: report.risk,
        reasons: report.reasons,
        counts: {
            changed: report.changed.length,
            impacted: report.impacted.length,
            tests: report.tests.length,
            unreached: report.unreached.length,
        },
        changed: report.changed,
        impacted: report.impacted,
        tests: report.tests,
        unreached: report.unreached,
        stats: report.stats,
        blindSpots: BLIND_SPOTS,
        config: {
            defaultBase: config.defaultBase,
            maxDistance: config.maxDistance,
            maxFiles: config.maxFiles,
            maxFileBytes: config.maxFileBytes,
            /** The host's pin; the artifact also records what actually answered. */
            changeSource: config.changeSource,
            testCommandTemplate: config.testCommandTemplate === '' ? null : config.testCommandTemplate,
            fullTestCommand: config.fullTestCommand ?? null,
        },
        ...(input.review === undefined
            ? {}
            : {
                  review: {
                      ok: input.review.ok,
                      ...(input.review.runId === undefined ? {} : { runId: input.review.runId }),
                      ...(input.review.outputFile === undefined ? {} : { outputFile: input.review.outputFile }),
                      ...(input.review.stopReason === undefined ? {} : { stopReason: input.review.stopReason }),
                      report: input.review.report.length > ARTIFACT_REVIEW_CHARS ? `${input.review.report.slice(0, ARTIFACT_REVIEW_CHARS)}\n…[已截断]` : input.review.report,
                      ...(input.review.problem === undefined ? {} : { problem: input.review.problem }),
                  },
              }),
    }
}

/**
 * Write the artifact and the `artifact` evidence row.
 *
 * Core exposes `store.writeArtifact` and `store.appendEvidence`; there is no
 * `recordEvidence`, and nothing is invented to look like one. The evidence row
 * is what `dsh-evidence-gate` reads, so the artifact is not invisible to
 * delivery.
 */
export function writeImpactArtifact(store: MissionStore, missionId: string, artifact: ImpactArtifact): Recorded {
    const relative = `impact/${stamp()}.json`
    const absolute = store.writeArtifact(missionId, relative, `${JSON.stringify(artifact, null, 2)}\n`)
    const evidence = store.appendEvidence(missionId, {
        kind: 'artifact',
        summary: `变更影响分析：风险 ${artifact.risk}；改动 ${artifact.counts.changed}、影响面 ${artifact.counts.impacted}、选中测试 ${artifact.counts.tests}`,
        recordedBy: 'dsh-impact-gate',
        artifactPath: relative,
        data: {
            artifact: relative,
            risk: artifact.risk,
            base: artifact.base,
            counts: artifact.counts,
        },
    })
    return { missionId, relative, absolute, evidenceId: evidence.id }
}

/** One recorded artifact, as `impact_status` needs it. */
export interface ImpactArtifactSummary {
    file: string
    relative: string
    generatedAt?: string
    risk?: string
    counts?: { changed?: number; impacted?: number; tests?: number; unreached?: number }
    base?: string
    /**
     * Which source produced that analysis (`workspaceChanges` / `git` /
     * `显式 paths`), as recorded in the artifact. Absent for artifacts written
     * before the sources were told apart — read it as "unknown", never as "git".
     */
    changeSource?: string
    /** Set when the file exists but cannot be read as JSON. */
    problem?: string
}

/**
 * List a mission's impact artifacts, newest last.
 *
 * Names are `<stamp>.json`, so lexicographic order IS chronological order for
 * one format — no mtime (which is not part of the artifact) is consulted.
 */
export function listImpactArtifacts(store: MissionStore, missionId: string): ImpactArtifactSummary[] {
    const dir = store.artifactPath(missionId, 'impact')
    return listDir(dir)
        .filter((name) => /^\d{8}-\d{6}\.json$/.test(name))
        .sort((left, right) => left.localeCompare(right))
        .map((name) => {
            const file = path.join(dir, name)
            const raw = readJson<Partial<ImpactArtifact>>(file)
            if (raw === undefined) return { file, relative: `impact/${name}`, problem: `${file} 不是合法 JSON：无法读取这次分析` }
            const recorded = raw.changeSource as { source?: unknown; fallbackReason?: unknown } | undefined
            return {
                file,
                relative: `impact/${name}`,
                ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
                ...(typeof raw.risk === 'string' ? { risk: raw.risk } : {}),
                ...(raw.counts === undefined ? {} : { counts: raw.counts }),
                ...(typeof raw.base === 'string' ? { base: raw.base } : {}),
                ...(typeof recorded?.source !== 'string'
                    ? {}
                    : {
                          changeSource:
                              recorded.source === 'git' && typeof recorded.fallbackReason === 'string'
                                  ? `git（回退：${recorded.fallbackReason}）`
                                  : recorded.source,
                      }),
            }
        })
}

// --- analysis ------------------------------------------------------------

interface AnalyzeInput {
    cwd: string
    config: ImpactGateConfig
    base: string
    paths?: readonly string[]
    /** The calling agent: its session is what the host's change service is keyed by. */
    agent?: AgentLike
    signal?: AbortSignal
}

/**
 * Explicit paths that do not exist on disk.
 *
 * `paths` mode covers a PLANNED change, so a missing file is legitimate — but a
 * typo produces exactly the same empty answer, and core reports both as "no
 * dependents, no tests". This is the list that tells them apart, in the report.
 */
function missingPathsOf(cwd: string, paths: readonly string[] | undefined): string[] {
    if (paths === undefined) return []
    return paths
        .filter((entry) => !fs.existsSync(path.isAbsolute(entry) ? entry : path.join(cwd, entry)))
        .sort((left, right) => left.localeCompare(right))
}

/**
 * Run core's analysis with the configured bounds, on the change set the
 * configured SOURCE supplies.
 *
 * The diff is still pre-read in diff mode: it is the only way to learn
 * `isRepo`/`problem` (core's report drops the `problem` field that
 * `changedRanges` carries — a non-git workspace would otherwise be reported as
 * "no tests cover this change"), and, when the host's `workspaceChanges` service
 * answers instead, it is the cross-check the report prints. A source that cannot
 * answer is a reported fallback, never an empty change set.
 */
async function analyze(
    deps: ToolDeps,
    input: AnalyzeInput,
): Promise<{ report: ImpactReport; diff?: { isRepo: boolean; problem?: string }; missingPaths: string[]; provenance: ChangeProvenance }> {
    if (input.signal?.aborted === true) {
        throw new Error('调用方已取消（signal 已 abort）：未做分析。下一步：确认会话仍在运行后重试 impact_analyze。')
    }
    const git =
        input.paths === undefined
            ? await changedRanges({
                  cwd: input.cwd,
                  base: input.base,
                  ...(deps.logger === undefined ? {} : { logger: deps.logger }),
              })
            : undefined
    const diff = git === undefined ? undefined : { isRepo: git.isRepo, ...(git.problem === undefined ? {} : { problem: git.problem }) }
    const resolved = await resolveChangeSet(deps.changes, {
        cwd: input.cwd,
        base: input.base,
        config: input.config,
        ...(input.paths === undefined ? {} : { paths: input.paths }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(git === undefined
            ? {}
            : { gitRead: { isRepo: git.isRepo, files: git.files, ...(git.problem === undefined ? {} : { problem: git.problem }) } }),
    })
    const report = await analyzeImpact({
        cwd: input.cwd,
        ...(input.paths === undefined
            ? resolved.adopted === undefined
                ? { base: input.base }
                : // The service's facts are not relative to a ref, so the label
                  // core reports is the source itself (see `ImpactOptions.changed`).
                  { changed: resolved.adopted, base: resolved.base }
            : { paths: input.paths }),
        maxDistance: input.config.maxDistance,
        maxFiles: input.config.maxFiles,
        maxFileBytes: input.config.maxFileBytes,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    })
    return {
        report,
        missingPaths: missingPathsOf(input.cwd, input.paths),
        ...(diff === undefined ? {} : { diff }),
        provenance: resolved.provenance,
    }
}

// --- rendering -----------------------------------------------------------

/** What `renderAnalyze` needs: everything, so it stays pure. */
export interface AnalyzeRenderInput {
    report: ImpactReport
    config: ImpactGateConfig
    /** Where the change set came from: printed, so an audit can tell the sources apart. */
    provenance: ChangeProvenance
    /** Explicit paths, when that was the mode. */
    paths?: readonly string[]
    /** Explicit paths that do not exist on disk (a typo looks like a planned file). */
    missingPaths?: readonly string[]
    /** The diff pre-read; absent in paths mode. */
    diff?: { isRepo: boolean; problem?: string }
    /** The artifact + evidence row, when a mission existed. */
    record?: Recorded
    /** A mission existed but recording failed; the analysis itself is still valid. */
    recordProblem?: string
    /** The mission the analysis was resolved to, when one exists. */
    missionId?: string
    review?: ReviewOutcome
}

/**
 * The lines that say where the change set came from.
 *
 * Two sources can answer this question and they do NOT mean the same thing, so
 * the report never prints one without the other: the base says what the facts
 * are relative to, the source line says who produced them (and, on a fallback,
 * why the preferred source did not).
 */
export function originLines(input: {
    report: ImpactReport
    provenance: ChangeProvenance
    paths?: readonly string[]
}): string[] {
    const { provenance, report } = input
    if (input.paths !== undefined) {
        return [`变更基线：${report.base}（显式 paths 模式：没有 diff，新增行区间不可用）`, `变更来源：${sourceLabel(provenance)}`]
    }
    if (provenance.source === 'git') {
        return [`变更基线：${report.base}`, `变更来源：${sourceLabel(provenance)}`]
    }
    return [
        `变更来源：${provenance.detail}`,
        '变更基线：不适用（该来源报的是某一轮的改动，不是相对某个 ref 的差异）',
        provenance.granularity === 'hunk'
            ? '行区间：hunk 级（来自该来源自己的比较，未再读工作区）'
            : '行区间：不可用（该来源只给了文件与行数，没有位置）',
    ]
}

/** The adopted source's limits and the git cross-check — `impact_analyze` only. */
export function provenanceNotes(input: { provenance: ChangeProvenance; changed: number }): string[] {
    const provenance = input.provenance
    if (provenance.source !== 'workspaceChanges') return []
    const lines = ['', '### 这一次改动集的边界（来源本身的限制）', '', ...provenance.limits.map((limit) => `- ${limit}`)]
    const cross = provenance.crossCheck
    if (cross !== undefined && (cross.onlyInGit.length > 0 || cross.onlyInService.length > 0)) {
        // Not a verdict, a divergence: the service answers "what this turn
        // changed", git answers "what differs from the ref", and a reader who
        // needs the second question answered must not be left to infer it.
        lines.push(
            '',
            `⚠️ 交叉核对（只报告，不裁决）：\`git diff ${cross.base}\` 报 ${cross.gitFiles} 个改动文件，本次采用的来源报了 ${input.changed} 个：`,
            ...(cross.onlyInGit.length === 0
                ? []
                : [`- 只有 git 报的：${cross.onlyInGit.map((entry) => `\`${entry}\``).join('、')}${cross.onlyInGit.length >= 10 ? '（列表已截断）' : ''}`]),
            ...(cross.onlyInService.length === 0
                ? []
                : [`- 只有服务报的：${cross.onlyInService.map((entry) => `\`${entry}\``).join('、')}${cross.onlyInService.length >= 10 ? '（列表已截断）' : ''}`]),
            '若这次分析必须覆盖 base 以来的全部改动，用 `changeSource: "git"` 重跑（或显式传 `paths`）——服务的语义是"哪一轮改了什么"。',
        )
        return lines
    }
    if (cross !== undefined) {
        lines.push('', `交叉核对：\`git diff ${cross.base}\` 与本次来源的改动集一致（各 ${cross.gitFiles} 个文件）。`)
    }
    return lines
}

/** Render the `impact_analyze` report. Chinese, exact, ends with 下一步. */
export function renderAnalyze(input: AnalyzeRenderInput): string {
    const { report, config } = input
    const provenance = input.provenance
    const unreadable = input.paths === undefined && provenance.source === 'git' && input.diff?.problem !== undefined
    const lines: string[] = [
        '## 变更影响分析（impact_analyze）',
        '',
        `工作区：${report.cwd}`,
        ...originLines(input),
        `扫描：${report.stats.filesScanned} 个文件、${report.stats.graphEdges} 条导入边${report.stats.truncated ? '（已达 maxFiles 上限：本次分析不完整）' : ''}`,
    ]

    if (unreadable) {
        lines.push(
            '',
            '### 无法读取 diff（这次分析的前提不成立）',
            '',
            input.diff?.problem ?? '（core 没有给出原因）',
            '',
            '本次没有改动集：下面的风险/影响面/测试选择只由空集合算出，**不能用来判断真实改动的风险**。',
            input.diff?.isRepo === false
                ? '下一步：确认工作区是 git 仓库（`git init` 或换到仓库目录），或改用显式 paths：`impact_analyze({ paths: ["src/a.ts"] })`。'
                : '下一步：确认 base 引用有效（`impact_status` 显示当前 defaultBase），或改用显式 paths：`impact_analyze({ paths: ["src/a.ts"] })`。',
        )
    }

    if (unreadable) {
        lines.push('', '风险：无法判定（改动集为空，见上）')
    } else {
        lines.push('', `风险：${riskLabel(report.risk)}`, '', '判定理由：')
        for (const reason of report.reasons) lines.push(`- ${reason}`)
    }

    lines.push('', `### 改动文件（${report.changed.length} 个）`)
    if (report.changed.length === 0) {
        lines.push(unreadable ? '- （空：diff 未读到）' : '- （空：没有改动）')
    } else {
        for (const file of report.changed.slice(0, DISPLAY_CHANGED)) {
            lines.push(`- \`${file.path}\`：${statusLabel(file.status)}，${describeAdded(file)}`)
        }
        const omitted = report.changed.length - DISPLAY_CHANGED
        if (omitted > 0) lines.push(`- （另有 ${omitted} 个改动文件未列出；完整清单见分析产物）`)
    }

    const deleted = report.changed.filter((file) => file.status === 'deleted')
    if (deleted.length > 0) {
        lines.push(
            '',
            `注意：${deleted.length} 个改动文件是删除。反向可达性只从未删除的文件出发（core 的行为），` +
                '所以"谁引用了被删掉的文件"需要人工确认。',
        )
    }

    lines.push(...provenanceNotes({ provenance, changed: report.changed.length }))

    const missing = input.missingPaths ?? []
    if (missing.length > 0) {
        lines.push(
            '',
            `### 显式 paths 里当前不存在的文件（${missing.length} 个）`,
            '',
            ...missing.slice(0, DISPLAY_CHANGED).map((entry) => `- \`${entry}\``),
            ...(missing.length > DISPLAY_CHANGED ? [`- （另有 ${missing.length - DISPLAY_CHANGED} 个未列出）`] : []),
            '',
            '若是计划新增的文件，这属正常；若是拼写错误，本次结论就是空洞的——core 对不存在的路径同样只报"无依赖者、无测试"。',
        )
    }

    if (report.impacted.length === 0) {
        lines.push('', '### 影响面（0 个文件）', '', '- 没有任何文件按 import 关系依赖这些改动（接口/DI/反射/字符串查表不产生 import 边，见文末边界）。')
    } else {
        lines.push('', `### 影响面（${report.impacted.length} 个文件，按导入距离分组）`)
        let shown = 0
        for (const [distance, files] of groupByDistance(report.impacted)) {
            if (shown >= DISPLAY_IMPACTED) break
            const room = Math.max(0, DISPLAY_IMPACTED - shown)
            const visible = files.slice(0, room)
            shown += visible.length
            const label = (file: ImpactedFile): string =>
                distance >= 2 && file.via !== '' ? `\`${file.path}\`（经由 \`${file.via}\`）` : `\`${file.path}\``
            const suffix = files.length > visible.length ? `（另有 ${files.length - visible.length} 个未列出）` : ''
            lines.push(`- 距离 ${distance}（${files.length} 个）：${visible.map(label).join('、') || '—'}${suffix}`)
        }
        const omitted = report.impacted.length - shown
        if (omitted > 0) lines.push(`- （另有 ${omitted} 个影响文件未列出；完整清单见分析产物）`)
    }

    lines.push('', `### 选中的测试（${report.tests.length} 个）`)
    if (report.tests.length === 0) {
        lines.push('- （一个都没有：按导入、同目录、同名三类证据都找不到测试——这是高风险信号，先补测试）')
    } else {
        for (const test of report.tests.slice(0, DISPLAY_TESTS)) lines.push(`- \`${test.path}\`：${reasonLabel(test)}`)
        const omitted = report.tests.length - DISPLAY_TESTS
        if (omitted > 0) lines.push(`- （另有 ${omitted} 个选中测试未列出；完整清单见分析产物）`)
    }

    if (report.unreached.length > 0) {
        lines.push(
            '',
            `### 既没有依赖者也没有测试触及的改动文件（${report.unreached.length} 个）`,
            '',
            '这些文件改了以后，按静态关系没有任何东西会受影响——要么它真的是叶子，要么引用方式在导入图之外。',
        )
        for (const entry of report.unreached.slice(0, DISPLAY_UNREACHED)) lines.push(`- \`${entry}\``)
        const omitted = report.unreached.length - DISPLAY_UNREACHED
        if (omitted > 0) lines.push(`- （另有 ${omitted} 个未列出；完整清单见分析产物）`)
    }

    lines.push(
        '',
        '### 这次选择看不到什么（诚实边界）',
        '',
        '这是**文件级导入可达性**，不是调用图。下面这些位置不产生 import 边，需要人来判断：',
        ...BLIND_SPOTS.map((spot) => `- ${spot}`),
        '',
        '所以 `impact_tests` 给出的是**必要**回归集（"先跑这些"），不是"其余可以跳过"的证明。',
    )

    if (input.review !== undefined) {
        lines.push('', '### 复核意见（reviewDispatch，只读子代理）', '', '⚠️ 这是**意见**，不是门禁裁决：它不改变上面的风险等级，也不构成交付依据。')
        if (input.review.ok) {
            lines.push('', input.review.report)
            if (input.review.outputFile !== undefined) lines.push('', `报告落盘：${input.review.outputFile}`)
        } else {
            lines.push('', `未产出复核：${input.review.problem ?? '未知原因'}`)
            if (input.review.outputFile !== undefined) lines.push('', `（落盘位置：${input.review.outputFile}）`)
        }
    }

    lines.push('', '### 记录')
    if (input.record !== undefined) {
        lines.push(
            `- 分析产物：${input.record.absolute}`,
            `  （mission 相对路径：\`${input.record.relative}\`）`,
            `- 证据台账：${input.record.evidenceId}（kind=artifact，记录者 dsh-impact-gate）`,
            ...(input.missionId === undefined ? [] : [`- mission：${input.missionId}`]),
        )
    } else if (input.recordProblem !== undefined) {
        lines.push(
            `- ⚠️ mission ${input.missionId ?? '(未知)'} 存在，但**产物/证据写入失败**：${input.recordProblem}`,
            '- 上面的分析结果仍然有效（它是算出来的，不依赖落盘）；但这次分析**没有留痕**，交付侧看不到它。',
        )
    } else {
        lines.push(
            '- 没有 mission：本次分析**没有落盘、也没有记证据**（两者都写在 `.dsh/missions/<id>/` 下）。',
            '  分析结果本身在上面，不受影响；需要留痕时先建任务再跑一次。',
        )
    }

    const templateNote =
        config.testCommandTemplate === ''
            ? '（宿主尚未配置 testCommandTemplate——它会拒绝执行并给出配置方法）'
            : `（模板：\`${config.testCommandTemplate}\`）`
    lines.push(
        '',
        unreadable
            ? '下一步：先让改动集可信（git 仓库 + 有效 base，或显式传 paths），再跑 `impact_analyze`；然后用 `impact_tests` 取回归命令。'
            : `下一步：用 \`impact_tests\` 取这次改动的最小回归命令${templateNote}，跑完把结果交给 \`quality_gate_run\`。`,
    )
    return lines.join('\n')
}

/** What `renderTests` needs. */
export interface TestsRenderInput {
    report: ImpactReport
    config: ImpactGateConfig
    /** Where the change set came from (the selection is only as good as it). */
    provenance: ChangeProvenance
    /** The resolved template (argument or config), for the empty-selection note. */
    template: string
    /** The rendered command (`renderTestCommand` output). */
    command: string
    templateSource: 'argument' | 'config'
    paths?: readonly string[]
    /** Explicit paths that do not exist on disk (a typo looks like a planned file). */
    missingPaths?: readonly string[]
    diff?: { isRepo: boolean; problem?: string }
    /** Whole-workspace test count, computed only when `fullTestCommand` is configured. */
    suite?: { total: number; truncated: boolean }
    missionId?: string
}

/** Render the `impact_tests` report. Chinese, exact, ends with 下一步. */
export function renderTests(input: TestsRenderInput): string {
    const { report, config } = input
    const unreadable = input.paths === undefined && input.provenance.source === 'git' && input.diff?.problem !== undefined
    const lines: string[] = [
        '## 最小回归命令（impact_tests）',
        '',
        `工作区：${report.cwd}`,
        ...originLines(input),
        `模板来源：${input.templateSource === 'argument' ? '调用参数 template（本次覆盖）' : 'profile 的 testCommandTemplate'}`,
        ...(input.missionId === undefined ? [] : [`mission：${input.missionId}`]),
    ]

    if (unreadable) {
        lines.push(
            '',
            '### 无法读取 diff（这条命令的依据不成立）',
            '',
            input.diff?.problem ?? '（core 没有给出原因）',
            '',
            '选中的测试是在空改动集上算出来的：**不要把它当成这次改动的回归命令**。',
        )
    }

    lines.push('', '### 命令', '', `\`${input.command}\``)
    const missing = input.missingPaths ?? []
    if (missing.length > 0) {
        lines.push(
            '',
            `注意：显式 paths 里 ${missing.length} 个文件当前不存在（${missing.slice(0, DISPLAY_CHANGED).map((entry) => `\`${entry}\``).join('、')}）——`,
            '若是计划新增的文件，这属正常；若是拼写错误，这条命令的依据不成立（core 对不存在的路径同样只报"无依赖者、无测试"）。',
        )
    }

    if (report.tests.length === 0) {
        lines.push(
            '',
            '### 选中集为空',
            '',
            input.template.includes('{files}')
                ? '- 模板里的 `{files}` 会被替换成空串：这条命令可能跑全量、也可能空转，取决于 runner。'
                : '- 模板没有 `{files}` 占位符，且选中集为空：这条命令就是模板本身（通常等于全量）。',
            '- 没有任何测试覆盖这些改动（按导入 / 同目录 / 同名三类证据）。先确认改动集，再补测试。',
        )
    } else {
        lines.push('', `### 选中的测试（${report.tests.length} 个）`, '')
        for (const test of report.tests.slice(0, DISPLAY_TESTS)) lines.push(`- \`${test.path}\`：${reasonLabel(test)}`)
        const omitted = report.tests.length - DISPLAY_TESTS
        if (omitted > 0) lines.push(`- （另有 ${omitted} 个未列出；完整清单见 impact_analyze 的产物）`)
    }

    lines.push('', '### 代价对照')
    if (config.fullTestCommand === undefined) {
        lines.push(
            '- 宿主未配置 `fullTestCommand`：**没有对照数据**，所以不要用"少跑"来跳过其余测试。',
            '- 把这批当"先跑这些"；全量回归按项目既有流程跑。',
        )
    } else if (input.suite === undefined) {
        lines.push(`- 全量命令：\`${config.fullTestCommand}\`（本次没有统计全量测试文件数）`)
    } else {
        const saved = Math.max(0, input.suite.total - report.tests.length)
        const percent = input.suite.total === 0 ? 0 : Math.round((saved / input.suite.total) * 100)
        lines.push(
            `- 全量：${input.suite.total} 个测试文件 → \`${config.fullTestCommand}\`${input.suite.truncated ? '（扫描达到 maxFiles 上限，全量数是最小值）' : ''}`,
            `- 本次选中：${report.tests.length} 个 → 少跑 ${saved} 个测试文件（约 ${percent}%）`,
            '- 前提是宿主已经用 `fullTestCommand` 明确对照过；选中集是**必要**不是**充分**，动态行为（配置驱动的分支、外部系统、性能特征）不在其中。',
        )
    }

    lines.push(
        '',
        '### 这次选择看不到什么（要点）',
        '',
        '- 接口分派、依赖注入、反射、字符串查表、动态 import、跨进程边界都不产生 import 边。',
        '- 完整清单与逐条说明见 `impact_analyze` 的报告和产物。',
    )

    lines.push(
        '',
        unreadable
            ? '下一步：先让改动集可信（git 仓库 + 有效 base，或显式传 paths）再跑 `impact_tests`；期间按项目流程跑全量回归。'
            : '下一步：跑上面这条命令；把结果用 `quality_gate_run` 记入质量门禁（失败时先修，不要改这条命令来"过门禁"）。',
    )
    return lines.join('\n')
}

/** What `renderStatus` needs. */
export interface StatusRenderInput {
    cwd: string
    effective: EffectiveConfig
    /** Newest impact artifact of the mission, when there is one. */
    newest?: ImpactArtifactSummary
    /** How many artifacts the mission has. */
    artifactsSeen: number
    missionId?: string
    /**
     * Whether the host mounted the `workspaceChanges` service this call, and how
     * many sessions it has recorded turns for. Read-only facts: `auto` prefers
     * the service, so whether it exists changes what the next analysis means.
     */
    changeService?: { mounted: boolean; sessions: number }
    /**
     * `true` when no mission was resolved at all, `false` when a mission exists
     * but has no artifacts yet. Both states are reported distinctly.
     */
    noMission: boolean
}

/** Render the `impact_status` report. Read-only, ends with 下一步. */
export function renderStatus(input: StatusRenderInput): string {
    const { config } = input.effective
    const lines: string[] = [
        '## 影响分析现状（impact_status）',
        '',
        `工作区：${input.cwd}`,
        `配置来源：${
            input.effective.source === 'project'
                ? `项目级 ${input.effective.file}`
                : input.effective.present
                  ? `profile（项目文件 ${input.effective.file} 存在但未生效：键被拒绝或值不可用，见下）`
                  : `profile（项目文件 ${input.effective.file} 不存在）`
        }`,
    ]
    if (input.effective.problems.length > 0) {
        lines.push(`配置问题（${input.effective.problems.length} 条，已按上限回退）：`)
        for (const problem of input.effective.problems) lines.push(`- ${problem}`)
    }

    lines.push(
        '',
        '### 生效配置',
        '',
        `- 变更基线（defaultBase）：\`${config.defaultBase}\``,
        `- 改动集来源（changeSource）：${changeSourceLabel(config.changeSource)}` +
            (input.changeService === undefined
                ? ''
                : input.changeService.mounted
                  ? `｜workspaceChanges 服务：已挂载（已记录 ${input.changeService.sessions} 个会话的轮次）`
                  : '｜workspaceChanges 服务：**未挂载**（`auto` 会回退到 git，并在报告里写明回退原因）'),
        `- 反向可达最大距离（maxDistance）：${config.maxDistance}`,
        `- 扫描上限：maxFiles ${config.maxFiles} / maxFileBytes ${config.maxFileBytes}`,
        config.testCommandTemplate === ''
            ? '- 测试命令模板（testCommandTemplate）：**未配置** —— `impact_tests` 会拒绝执行（不给 runner 就是不给猜测的机会）'
            : `- 测试命令模板（testCommandTemplate）：\`${config.testCommandTemplate}\``,
        config.fullTestCommand === undefined
            ? '- 全量命令（fullTestCommand）：未配置（因此没有"少跑多少"的对照）'
            : `- 全量命令（fullTestCommand）：\`${config.fullTestCommand}\``,
        config.reviewDispatch.enabled
            ? `- 复核派发（reviewDispatch）：开启（provider=${config.reviewDispatch.provider}、targets=${config.reviewDispatch.targets}、timeoutMs=${config.reviewDispatch.timeoutMs}、maxDepth=${config.reviewDispatch.maxDepth}${config.reviewDispatch.model === undefined ? '' : `、model=${config.reviewDispatch.model}`}）——只产出意见，不改风险等级`
            : '- 复核派发（reviewDispatch）：关闭（默认；开启会派只读子代理，属宿主决定）',
    )

    lines.push(
        '',
        '### 在用阈值（RISK_RULES，来自 dsh-eng-core）',
        '',
        `- high：单个改动文件被 ≥ ${RISK_RULES.highFanIn} 处依赖，或影响面 ≥ ${RISK_RULES.highImpacted} 个文件，或导出面 ≥ ${RISK_RULES.wideSurface} 个符号`,
        `- high：没有任何测试文件覆盖这些改动（按目录/命名/导入关系都找不到）`,
        `- medium：影响面 ≥ ${RISK_RULES.mediumImpacted} 个文件，或导出面 ≥ ${RISK_RULES.mediumSurface} 个符号`,
        '- low：以上都不满足',
        '- 阈值是**口径**不是配置项：改它等于改门禁口径，属于代码改动（`RISK_RULES`）。',
    )

    lines.push('', '### 最近一次分析')
    if (input.noMission) {
        lines.push(
            '- 没有 mission：无法定位分析产物（它在 `.dsh/missions/<id>/impact/` 下）。',
            '- 这不影响分析和命令；需要留痕时先建任务（`spec_create`），或用 `missionId` 指定一个已有任务。',
        )
    } else if (input.newest === undefined) {
        lines.push(
            `- mission ${input.missionId ?? '(未知)'} 还没有分析产物：先跑 \`impact_analyze\`（产物会写到 \`.dsh/missions/${input.missionId ?? '<id>'}/impact/<stamp>.json\`）。`,
        )
    } else {
        const counts = input.newest.counts
        const risk = input.newest.risk
        const known = risk === 'high' || risk === 'medium' || risk === 'low'
        const generated = input.newest.generatedAt
        lines.push(
            `- mission：${input.missionId ?? '(未知)'}（共 ${input.artifactsSeen} 个产物，取最新）`,
            ...(input.newest.problem === undefined ? [] : [`- ⚠️ ${input.newest.problem}`]),
            `- 产物：\`${input.newest.relative}\``,
            known
                ? `- 风险：${riskLabel(risk)}；改动 ${counts?.changed ?? '?'}、影响面 ${counts?.impacted ?? '?'}、选中测试 ${counts?.tests ?? '?'}、未触及 ${counts?.unreached ?? '?'}`
                : `- ⚠️ 产物里的风险值无法识别（${JSON.stringify(risk ?? null)}）：按 fail closed 不要当作低风险`,
            ...(generated === undefined || !Number.isFinite(Date.parse(generated))
                ? []
                : [`- 生成时间：${formatTime(Date.parse(generated))}`]),
            ...(input.newest.base === undefined ? [] : [`- 当时基线：\`${input.newest.base}\``]),
            ...(input.newest.changeSource === undefined
                ? []
                : [`- 当时的改动集来源：${input.newest.changeSource}（产物里的 \`changeSource.source\`）`]),
        )
    }

    lines.push(
        '',
        input.newest === undefined
            ? '下一步：`impact_analyze` 先产出这次改动的影响报告与产物；命令用 `impact_tests` 取。'
            : '下一步：改动集变了就重跑 `impact_analyze`（产物不可复用）；要跑测试用 `impact_tests` 取最小回归命令。',
    )
    return lines.join('\n')
}

// --- registration --------------------------------------------------------

/**
 * Register the three tools.
 * @param ctx - the tool runtime (narrow structural view of `ctx.tools`).
 * @param deps - configuration, stores, subagent seam and logger.
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

    /** Shared preamble: workspace, config, cancellation. */
    const preamble = (exec: unknown): { agent: AgentLike | undefined; cwd: string; config: ImpactGateConfig; effective: EffectiveConfig } => {
        const agent = agentOf(exec)
        const cwd = declaredCwdOf(agent)
        const effective = deps.configFor(cwd)
        if (!effective.config.enabled) {
            throw new Error(
                'dsh-impact-gate 已被宿主禁用（enabled=false）：影响分析不可用。下一步：让宿主把 config.enabled 设回 true（这是宿主决定，项目级配置改不了它）。',
            )
        }
        return { agent, cwd, config: effective.config, effective }
    }

    register(
        defineTool({
            name: 'impact_analyze',
            description:
                'Answer "what does this change touch" from FACTS, not from reading code: diff against `base` (or explicit `paths`), the reverse import graph (transitive dependents with distances) and three kinds of test evidence (imports the change / same directory / same name). Writes a JSON artifact plus an `artifact` evidence row on the mission when one exists, and renders the report a reviewer reads: risk level with the reasons, changed files with their added line ranges, impacted files grouped by distance, the selected tests with reasons, and the blind spots an import graph cannot see (interface dispatch, DI, reflection, string lookups). Run it AFTER implementing; run impact_tests BEFORE running tests.',
            parameters: {
                base: { type: 'string', description: 'Git ref to diff against (default: the host-configured defaultBase, normally HEAD). Ignored when `paths` is given.' },
                paths: { type: 'json', description: 'Explicit paths (array of workspace-relative strings, or one string) to analyse instead of a diff — e.g. a planned change. Added line ranges are unavailable in this mode.' },
                missionId: { type: 'string', description: 'Mission that stores the analysis artifact (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: AnalyzeArgs = {}, exec) {
                const { agent, cwd, config } = preamble(exec)
                const parsed = parsePaths(args.paths)
                if (parsed.problem !== undefined) throw new Error(parsed.problem)
                const store = deps.stores.for(cwd)
                const mission = resolveMission(store, agent, args.missionId)
                const base = baseOf(args.base, config)
                const { report, diff, missingPaths, provenance } = await analyze(deps, {
                    cwd,
                    config,
                    base,
                    ...(agent === undefined ? {} : { agent }),
                    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
                    ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                })

                let review: ReviewOutcome | undefined
                if (config.reviewDispatch.enabled) {
                    const targets = selectReviewTargets(report, config.reviewDispatch.targets)
                    review = await runImpactReview(
                        {
                            subagents: () => deps.subagents(),
                            reportDir:
                                mission === undefined
                                    ? path.join(cwd, '.dsh', 'impact-reviews')
                                    : store.artifactPath(mission.id, 'impact-reviews'),
                            provider: config.reviewDispatch.provider,
                            ...(config.reviewDispatch.model === undefined ? {} : { model: config.reviewDispatch.model }),
                            timeoutMs: config.reviewDispatch.timeoutMs,
                            maxDepth: config.reviewDispatch.maxDepth,
                            ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                        },
                        {
                            cwd,
                            base: report.base,
                            report,
                            targets,
                            ...(agent === undefined ? {} : { agent }),
                            ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                        },
                    )
                    if (!review.ok) deps.logger?.for(cwd).warn(`impact-gate: 复核未产出（${review.problem ?? '未知原因'}）`)
                }

                const artifact = buildArtifact({
                    report,
                    config,
                    provenance,
                    generatedAt: new Date().toISOString(),
                    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
                    ...(missingPaths.length === 0 ? {} : { missingPaths }),
                    ...(diff === undefined ? {} : { diff }),
                    ...(review === undefined ? {} : { review }),
                })
                let record: Recorded | undefined
                let recordProblem: string | undefined
                if (mission !== undefined) {
                    try {
                        record = writeImpactArtifact(store, mission.id, artifact)
                        deps.logger
                            ?.for(cwd)
                            .info(`impact-gate: 产物 ${record.absolute}；证据 ${record.evidenceId}（风险 ${report.risk}）`)
                    } catch (error) {
                        // The analysis is still valid; only the record failed. Say
                        // so instead of returning a report that looks recorded.
                        recordProblem = error instanceof Error ? error.message : String(error)
                        deps.logger?.for(cwd).error('impact-gate: 产物写入失败:', error)
                    }
                }

                return renderAnalyze({
                    report,
                    config,
                    provenance,
                    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
                    ...(missingPaths.length === 0 ? {} : { missingPaths }),
                    ...(diff === undefined ? {} : { diff }),
                    ...(record === undefined ? {} : { record }),
                    ...(recordProblem === undefined ? {} : { recordProblem }),
                    ...(mission === undefined ? {} : { missionId: mission.id }),
                    ...(review === undefined ? {} : { review }),
                })
            },
        }),
        'impact_analyze',
    )

    register(
        defineTool({
            name: 'impact_tests',
            description:
                'The minimal regression command for the current change: the analysed selection rendered through the host\'s template (`testCommandTemplate`, or the `template` argument for this call only). REFUSES when no template is configured — this plugin never guesses a runner (a wrong guess renders a plausible command that tests nothing). Also prints the selected files with the evidence that selected them, and, when the host configured `fullTestCommand`, how many test files the selection saves versus the whole suite.',
            parameters: {
                base: { type: 'string', description: 'Git ref to diff against (default: the host-configured defaultBase, normally HEAD). Ignored when `paths` is given.' },
                paths: { type: 'json', description: 'Explicit paths (array of workspace-relative strings, or one string) to analyse instead of a diff.' },
                template: { type: 'string', description: 'Command template for this call only, overriding the host config. `{files}` is replaced with the selection; without the placeholder the selection is appended.' },
                missionId: { type: 'string', description: 'Mission to name in the report (default: the session mission); it is not written to.' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: TestsArgs = {}, exec) {
                const { agent, cwd, config } = preamble(exec)
                const parsed = parsePaths(args.paths)
                if (parsed.problem !== undefined) throw new Error(parsed.problem)
                const store = deps.stores.for(cwd)
                const mission = resolveMission(store, agent, args.missionId)

                const fromArgument = typeof args.template === 'string' && args.template.trim() !== ''
                const template = fromArgument ? (args.template as string).trim() : config.testCommandTemplate
                if (template === '') {
                    // Fail closed, and make the next step mechanical: an empty
                    // template is "no runner here", never "use a sensible default".
                    throw new Error(
                        [
                            '没有配置测试命令模板：impact_tests 不会猜 runner（猜错会渲染出一条看起来合理、实际什么都没测的命令）。',
                            '',
                            `可用模板示例（把 {files} 当占位符，或不写占位符让选中文件被追加）：`,
                            ...TEMPLATE_EXAMPLES.map((example) => `- \`${example}\``),
                            '',
                            '配置方式二选一：',
                            `- 宿主（推荐）：profile 的 \`- id: impact-gate\` + \`config.testCommandTemplate: '…'\`（重启后对每个工作区生效）；`,
                            `- 项目：\`<repo>/.dsh/impact-gate.json\` 里写 \`{ "testCommandTemplate": "…" }\`（人提交在仓库里，模型写不了 .dsh/**）。`,
                            '',
                            '下一步：先让宿主或项目配上模板；只想临时试一次就传 `template`：`impact_tests({ template: "go test {files}" })`。',
                        ].join('\n'),
                    )
                }

                const base = baseOf(args.base, config)
                const { report, diff, missingPaths, provenance } = await analyze(deps, {
                    cwd,
                    config,
                    base,
                    ...(agent === undefined ? {} : { agent }),
                    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
                    ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                })
                const command = renderTestCommand(template, report.tests)

                let suite: { total: number; truncated: boolean } | undefined
                if (config.fullTestCommand !== undefined) {
                    // Only computed when a comparison was asked for: a second walk
                    // is real work, and its absence must be visible, not guessed.
                    const measured = measureWorkspace({
                        cwd,
                        standards: { languages: {} },
                        maxFiles: config.maxFiles,
                        maxFileBytes: config.maxFileBytes,
                        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
                    })
                    suite = { total: measured.files.filter((file) => isTestPath(file.path)).length, truncated: measured.stats.truncated }
                }

                if (report.tests.length === 0) {
                    deps.logger?.for(cwd).warn('impact-gate: 选中集为空——回归命令没有静态可达的测试支撑')
                }
                return renderTests({
                    report,
                    config,
                    provenance,
                    template,
                    command,
                    templateSource: fromArgument ? 'argument' : 'config',
                    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
                    ...(missingPaths.length === 0 ? {} : { missingPaths }),
                    ...(diff === undefined ? {} : { diff }),
                    ...(suite === undefined ? {} : { suite }),
                    ...(mission === undefined ? {} : { missionId: mission.id }),
                })
            },
        }),
        'impact_tests',
    )

    register(
        defineTool({
            name: 'impact_status',
            description:
                'Read-only: the configuration in force for this workspace (diff base, analysis bounds, whether a test command template is configured, whether review dispatch is on), the RISK_RULES thresholds the analysis uses, and the newest impact artifact recorded on the mission (risk, counts, when). Use it before deciding what to run, and to see whether a template still needs configuring.',
            parameters: {
                missionId: { type: 'string', description: 'Mission whose impact artifacts to show (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {}, exec) {
                const { agent, cwd, effective } = preamble(exec)
                const store = deps.stores.for(cwd)
                const mission = resolveMission(store, agent, args.missionId)
                // Read-only facts about the source that `auto` prefers: whether it
                // is mounted decides what the NEXT analysis will be based on.
                const changeService = { mounted: deps.changes.mounted(), sessions: deps.changes.ledger.sessions }
                if (mission === undefined) {
                    return renderStatus({ cwd, effective, artifactsSeen: 0, noMission: true, changeService })
                }
                const artifacts = listImpactArtifacts(store, mission.id)
                const newest = artifacts[artifacts.length - 1]
                return renderStatus({
                    cwd,
                    effective,
                    artifactsSeen: artifacts.length,
                    missionId: mission.id,
                    noMission: false,
                    changeService,
                    ...(newest === undefined ? {} : { newest }),
                })
            },
        }),
        'impact_status',
    )

    register(
        defineTool({
            name: 'flaky_plan',
            description:
                'Turn flakiness data into a PLAN, deterministically: classify every unstable test as stable / quarantine / investigate / suspect-instrumentation, and say what to DO. Input is either a report file (the JSON dsh-coverage-gate\'s flaky_check writes) or this plugin\'s own repeated run of a configured command (`fullTestCommand`, or `command`); it never imports the other plugin. A quarantine is a LOAN: it needs an owner (`flaky.owner`; without one the plan REFUSES to quarantine) and an expiry (`flaky.quarantineMaxDays`, default 14 days), and an expired quarantine is reported as an escalation. Writes the plan to flaky/<stamp>-plan.json on the mission plus an artifact evidence row, and renders per test: the classification, the evidence, the suggested action, and the exact host command that would record the quarantine — which this plugin NEVER executes.',
            parameters: {
                missionId: { type: 'string', description: 'Mission that stores the plan artifact (default: the session mission).' },
                report: {
                    type: 'string',
                    description: 'Path to a flakiness report (workspace-relative or absolute) to classify instead of running anything. Omit it to repeat the configured command yourself.',
                },
                runs: {
                    type: 'number',
                    description: 'How many times to repeat the command when no report is given (default 3, clamped to 2–10; one run proves nothing).',
                },
                command: {
                    type: 'string',
                    description: 'Command to repeat (argv form, no shell) instead of the host-configured fullTestCommand.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: FlakyPlanArgs = {} as FlakyPlanArgs, exec) {
                const { agent, cwd, config } = preamble(exec)
                const store = deps.stores.for(cwd)
                const mission = resolveMission(store, agent, args.missionId)
                const settings = config.flaky
                const quarantineFile = quarantineFileFor(settings, { cwd, rootDir: store.layout.rootDir })
                const now = Date.now()
                const ledger = readQuarantine(quarantineFile)

                const report = typeof args.report === 'string' ? args.report.trim() : ''
                let tallies
                let runs
                let source: FlakyPlan['source']
                let notes: string[] = []
                if (report !== '') {
                    // Report mode never runs a command: another plugin already
                    // paid for the runs, and repeating them would be a second
                    // (possibly different) observation.
                    const file = path.isAbsolute(report) ? report : path.resolve(cwd, report)
                    const parsed = readReport(file)
                    if ('problem' in parsed) {
                        throw new Error(
                            `${parsed.problem}\n下一步：给出 flaky_check 产出的报告路径（例如 .dsh/missions/<id>/artifacts/flaky.json），或省略 report 让本插件重复运行已配置的命令。`,
                        )
                    }
                    tallies = parsed.tallies
                    runs = parsed.runs
                    notes = parsed.notes
                    source = { mode: 'report', report: file, observed: parsed.runs.length > 0 ? parsed.runs.length : parsed.tallies.length }
                } else {
                    const command = (typeof args.command === 'string' ? args.command.trim() : '') || config.fullTestCommand || ''
                    if (command === '') {
                        throw new Error(
                            [
                                '没有可重复运行的命令：report 没给，宿主也没有配置 fullTestCommand。',
                                '',
                                '下一步二选一：',
                                '- 传 report 指向 flaky_check 产出的报告（`flaky_plan({ report: ".dsh/missions/<id>/artifacts/flaky.json" })`）；',
                                "- 让宿主配置 fullTestCommand（整个测试套件的命令，例如 `go test ./...`），或在调用时传 command（argv 形式，不经过 shell）。",
                            ].join('\n'),
                        )
                    }
                    const planned = clampRuns(args.runs, DEFAULT_UNSEEN_RUNS)
                    if (args.runs !== undefined && Math.floor(args.runs) < 2) {
                        throw new Error(
                            `runs=${args.runs} 无法判定 flaky：至少需要 ${2} 次运行。下一步：传 2–10 之间的次数，或省略它使用默认 ${DEFAULT_UNSEEN_RUNS} 次。`,
                        )
                    }
                    const repeated = await repeatCommand({
                        command,
                        cwd,
                        runs: planned,
                        service: deps.subprocess(),
                        ...(signalOf(exec) === undefined ? {} : { signal: signalOf(exec) }),
                    })
                    const observed = observeRuns(repeated.outcomes)
                    tallies = tallyRuns(observed.runs, observed.failureOutput)
                    runs = observed.runs
                    notes = [...repeated.notes, ...observed.notes]
                    source = { mode: 'runs', command, planned, observed: repeated.outcomes.length }
                    const passed = observed.runs.filter((run) => run.outcome === 'pass').length
                    if (tallies.length === 0 && passed > 0 && passed < observed.runs.length) {
                        notes.push('运行级不稳定（每次运行的退出码不一致），但 runner 没有点名任何用例：无法按用例分类，先让 runner 输出用例名（verbose/TAP）再重跑。')
                    }
                }
                if (tallies.length === 0 && notes.length === 0) {
                    notes.push('数据里没有任何用例计数：无法分类（读不懂的数据不会被当成"没有不稳定用例"）。')
                }

                const evidencePath = `flaky/${stamp(now)}-plan.json`
                const plan = buildPlan({
                    cwd,
                    settings,
                    quarantineFile,
                    now,
                    source,
                    tallies,
                    runs,
                    quarantined: currentQuarantines(ledger.rows),
                    ...(ledger.problems.length === 0 ? {} : { ledgerProblems: ledger.problems }),
                    evidencePath,
                    notes,
                })
                let recorded: { relative: string; evidenceId: string } | undefined
                let recordProblem: string | undefined
                if (mission !== undefined) {
                    try {
                        store.writeArtifact(mission.id, evidencePath, `${JSON.stringify(plan, null, 2)}\n`)
                        const evidence = store.appendEvidence(mission.id, {
                            kind: 'artifact',
                            summary: `flaky 计划：${plan.tests.length} 个用例（稳定 ${plan.summary.stable}、隔离 ${plan.summary.quarantine}、查根因 ${plan.summary.investigate}、疑似仪器 ${plan.summary.suspectInstrumentation}）`,
                            recordedBy: 'dsh-impact-gate',
                            artifactPath: evidencePath,
                            data: { artifact: evidencePath, kind: 'flaky-plan', summary: plan.summary },
                        })
                        recorded = { relative: evidencePath, evidenceId: evidence.id }
                        deps.logger
                            ?.for(cwd)
                            .info(`impact-gate: flaky 计划 ${evidencePath}（不稳定 ${plan.summary.quarantine + plan.summary.investigate + plan.summary.suspectInstrumentation}，升级 ${plan.escalations.length}）`)
                    } catch (error) {
                        recordProblem = error instanceof Error ? error.message : String(error)
                        deps.logger?.for(cwd).error('impact-gate: flaky 计划写入失败:', error)
                    }
                }
                return renderPlan(plan, {
                    ...(recorded === undefined ? {} : { recorded }),
                    ...(recordProblem === undefined ? {} : { artifactProblem: recordProblem }),
                    ...(mission === undefined ? {} : { missionId: mission.id }),
                })
            },
        }),
        'flaky_plan',
    )

    register(
        defineTool({
            name: 'flaky_status',
            description:
                'Read-only: the flakiness policy in force (owner, quarantine deadline, unseen-run threshold, signature count), the current quarantine ledger (<rootDir>/flaky-quarantine.json, append-only rows {at, test, owner, expiresAt, reason, evidencePath}), which quarantines are EXPIRED (fix it or delete it — an expired quarantine may not hang there), ledger rows that cannot be used, and which quarantined tests have NOT been named by the last N runs (a test quarantined and then deleted is coverage silently lost). Writes nothing, and never records a quarantine itself.',
            parameters: {
                missionId: { type: 'string', description: 'Mission whose newest flaky plan artifact supplies the observed runs (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: FlakyStatusArgs = {} as FlakyStatusArgs, exec) {
                const { agent, cwd, config } = preamble(exec)
                const store = deps.stores.for(cwd)
                const mission = resolveMission(store, agent, args.missionId)
                const settings = config.flaky
                const quarantineFile = quarantineFileFor(settings, { cwd, rootDir: store.layout.rootDir })
                const ledger = readQuarantine(quarantineFile)
                const plans = mission === undefined ? [] : listFlakyPlans(store.artifactPath(mission.id, 'flaky'))
                const newest = plans[plans.length - 1]
                return renderFlakyStatus({
                    cwd,
                    settings,
                    quarantineFile,
                    now: Date.now(),
                    quarantined: currentQuarantines(ledger.rows),
                    ledgerProblems: ledger.problems,
                    ...(newest === undefined ? {} : { newest }),
                    plansSeen: plans.length,
                    ...(mission === undefined ? {} : { missionId: mission.id }),
                    ...(config.fullTestCommand === undefined ? {} : { flakyCommand: config.fullTestCommand }),
                })
            },
        }),
        'flaky_status',
    )

    return { disposers, registered, failed }
}

/**
 * The model-facing tool surface: `secret_scan`, `dependency_audit`,
 * `supply_chain_status`.
 *
 * Division of labour, the same one the rest of the suite follows:
 *
 *  - DETECTION is deterministic (`src/secrets.ts`, `src/deps.ts`, pure and
 *    testable);
 *  - what to WATCH is host configuration (manifests, audit commands) and what to
 *    EXEMPT is a repository-owned allowlist inside `.dsh/**`
 *    (`dsh-spec-gate`'s trust root, so the model cannot write itself one);
 *  - a decision a human owns — "we accept this new dependency" — goes through the
 *    approval seam, and a refusal is a BLOCK, never a warning.
 *
 * Everything here is fail-closed: an unreadable report, a refused auditor, an
 * empty scan, an expired allowlist entry and an unjudgeable dependency set are
 * all reported as what they are, and none of them is a PASS.
 *
 * @module dsh-supply-chain-gate/tools
 */

import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    changedRanges,
    formatTime,
    gitFingerprint,
    listDir,
    readJson,
    readText,
    runCommand,
    sessionCwd,
    sha256,
    splitCommand,
    walkWorkspace,
    type AgentLike,
    type ChangedRanges,
    type GateCommandLike,
    type GateScope,
    type GateState,
    type Logger,
    type MissionRecord,
    type MissionStoreRegistry,
    type RunOutcome,
    type SubprocessLike,
} from 'dsh-eng-core'
import type { EffectiveConfig, SupplyChainGateConfig } from './config.js'
import {
    classifyFindings,
    diffManifests,
    isSupportedManifest,
    lockfileManifestOf,
    manifestMatches,
    parseAuditOutput,
    treatmentOf,
    type AuditFinding,
    type DependencyEntry,
    type ManifestDiff,
} from './deps.js'
import {
    EMPTY_ALLOWLIST,
    ENTROPY_RULE_ID,
    SECRET_RULES,
    allowlistedBy,
    parseAllowlist,
    scanText,
    type AddedRange,
    type AllowlistEntry,
    type SecretAllowlist,
    type SecretFinding,
} from './secrets.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Gate source recorded on every row this plugin writes. */
export const GATE_SOURCE = 'dsh-supply-chain-gate'

/** Mission artifact directory for this plugin's per-run details. */
export const ARTIFACT_DIR = 'supply-chain'

/** Bound on how many files one report lists individually. */
const REPORT_FILE_LIMIT = 10

/** Bound on how many findings one report lists individually. */
const REPORT_FINDING_LIMIT = 25

/** Minimal structural view of `ctx.approval` (the same seam spec-gate uses). */
export interface ApprovalLike {
    request(request: {
        agent?: AgentLike
        toolName: string
        reason: string
        signal?: AbortSignal
    }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | string>
}

/** Everything the tools close over. */
export interface ToolDeps {
    config: SupplyChainGateConfig
    /** Resolved per-workspace configuration (profile row + project overlay). */
    configFor: (agent: AgentLike | undefined) => EffectiveConfig
    stores: MissionStoreRegistry
    /** The approval seam, read at call time (`ctx.get('approval')`). */
    approval: () => ApprovalLike | undefined
    /** `ctx.get('subprocess')`, read at call time (the harness execution seam). */
    subprocess: () => SubprocessLike | undefined
    /** Plugin logger; `deps.logger.for(cwd)` routes a line to that workspace's file. */
    logger: Logger
}

/** Arguments of `secret_scan`. */
interface SecretScanArgs {
    base?: string
    paths?: string[]
    wholeTree?: boolean
    missionId?: string
}

/** Arguments of `dependency_audit`. */
interface DependencyAuditArgs {
    base?: string
    missionId?: string
}

/** Arguments of `supply_chain_status`. */
interface StatusArgs {
    missionId?: string
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

function signalOf(exec: unknown): AbortSignal | undefined {
    return (exec as { signal?: AbortSignal }).signal
}

/**
 * Whether the turn was already cancelled.
 *
 * A helper rather than `signal?.aborted === true` at each site: TypeScript's
 * control-flow analysis narrows `aborted` to `false` after the first such check,
 * which makes every later identical check a compile error.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && signal.aborted
}

/**
 * The workspace a call applies to.
 *
 * Without a declared `header.cwd` the scan would read the harness's own
 * directory and record the verdict against the wrong project, so the call is
 * refused.
 */
function declaredCwdOrThrow(agent: AgentLike | undefined): string {
    const cwd = sessionCwd(agent)
    if (typeof cwd !== 'string' || cwd === '') {
        throw new Error(
            [
                '无法确定本会话的工作区（session.header.cwd 缺失）：扫描会在错误的目录进行，因此本工具拒绝执行。',
                '下一步：在带 cwd 的会话里工作（宿主应给会话设置 header.cwd）。',
            ].join('\n'),
        )
    }
    return cwd
}

/** Shell metacharacters this plugin refuses anywhere in a configured command. */
const SHELL_METACHARACTERS = '|&;<>()$`\\#*?[]{}~!\n\r'

/**
 * Split a configured audit command into argv WITHOUT a shell.
 *
 * A command line that contains shell syntax is REFUSED rather than interpreted:
 * `runCommand` takes an argv array, and quietly passing `foo | bar` to it would
 * run a program literally named `|` — a confusing failure the config should hear
 * about instead.
 * @param command - the configured command line.
 * @returns the argv, or an error naming the offending character.
 */
export function splitAuditCommand(command: string): { argv: string[] } | { error: string } {
    const offending = [...command].find((character) => SHELL_METACHARACTERS.includes(character))
    if (offending !== undefined) {
        return {
            error:
                `审计命令包含 shell 元字符 ${JSON.stringify(offending)}：本插件不经过 shell（argv 数组执行），` +
                '请把命令写成可直接 exec 的形式（需要管道/重定向时写成一个包装脚本，再指向它）',
        }
    }
    const argv = splitCommand(command)
    if (argv.length === 0) return { error: '审计命令为空' }
    return { argv }
}

/** Why a scan target was not scanned. */
type SkipReason = 'missing' | 'not-a-file' | 'too-large' | 'unreadable' | 'binary' | 'outside-workspace'

/** One file the scan considered. */
interface ScanTarget {
    /** Workspace-relative POSIX path. */
    path: string
    /** Added line ranges, or `undefined` for a whole-file scan. */
    ranges?: readonly AddedRange[]
}

/** What one scan pass produced (report + artifact input). */
interface ScanOutcome {
    cwd: string
    scope: 'changed-lines' | 'whole-tree' | 'explicit-paths' | 'none'
    base: string
    targets: number
    scannedFiles: number
    scannedLines: number
    findings: SecretFinding[]
    suppressed: { finding: SecretFinding; entry: AllowlistEntry }[]
    skipped: { path: string; reason: SkipReason }[]
    /** Set when the scope could not be established at all (non-git workspace, bad base…). */
    coverageProblem?: string
    /** `true` only when nothing was skipped-unread and the walk was not truncated. */
    full: boolean
    truncated: boolean
    allowlist: SecretAllowlist
    allowlistFile: string
    durationMs: number
}

/** Read a file for scanning, bounded and binary-aware. */
function readForScan(absolute: string, maxFileBytes: number): { text: string } | { skipped: SkipReason } {
    let size: number
    try {
        const stat = fs.statSync(absolute)
        if (!stat.isFile()) return { skipped: 'not-a-file' }
        size = stat.size
    } catch {
        return { skipped: 'missing' }
    }
    if (size > maxFileBytes) return { skipped: 'too-large' }
    let buffer: Buffer
    try {
        buffer = fs.readFileSync(absolute)
    } catch {
        return { skipped: 'unreadable' }
    }
    // A NUL byte in the head is the classic binary tell; a secret embedded in a
    // binary is not something a line-oriented net can judge (README limits).
    if (buffer.subarray(0, 8_192).includes(0)) return { skipped: 'binary' }
    return { text: buffer.toString('utf8') }
}

/** Load and parse the repository-owned allowlist (never throws, never silent). */
export function loadAllowlist(cwd: string, allowlistFile: string, now: number = Date.now()): SecretAllowlist {
    const file = path.isAbsolute(allowlistFile) ? allowlistFile : path.join(cwd, allowlistFile)
    const text = readText(file)
    if (text === undefined) return EMPTY_ALLOWLIST
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return {
            entries: [],
            problems: [`${file}: 不是合法 JSON —— 未应用任何豁免（fail-closed：读不懂的 allowlist 不是 allowlist）`],
        }
    }
    const result = parseAllowlist(parsed, now)
    return { entries: result.entries, problems: result.problems.map((problem) => `${file}: ${problem}`) }
}

/** Run the detector over the selected targets. */
function runScan(input: {
    cwd: string
    targets: readonly ScanTarget[]
    scope: ScanOutcome['scope']
    base: string
    config: SupplyChainGateConfig
    allowlist: SecretAllowlist
    truncated?: boolean
    coverageProblem?: string
}): ScanOutcome {
    const started = Date.now()
    const findings: SecretFinding[] = []
    const suppressed: { finding: SecretFinding; entry: AllowlistEntry }[] = []
    const skipped: { path: string; reason: SkipReason }[] = []
    let scannedFiles = 0
    let scannedLines = 0
    const truncated = input.truncated === true
    for (const target of input.targets) {
        const absolute = path.join(input.cwd, target.path)
        const read = readForScan(absolute, input.config.secretScan.maxFileBytes)
        if ('skipped' in read) {
            skipped.push({ path: target.path, reason: read.skipped })
            continue
        }
        const found = scanText({
            path: target.path,
            text: read.text,
            ...(target.ranges === undefined ? {} : { addedRanges: target.ranges }),
            entropyThreshold: input.config.secretScan.entropyThreshold,
        })
        scannedFiles += 1
        scannedLines += countScannedLines(read.text, target.ranges)
        for (const finding of found) {
            const entry = allowlistedBy(input.allowlist.entries, finding)
            if (entry === undefined) findings.push(finding)
            else suppressed.push({ finding, entry })
        }
    }
    // Coverage honesty: an unread text file, or a walk that hit its budget,
    // means a PASS does not cover the whole change (the reason line says so).
    const unread = skipped.filter((entry) => entry.reason === 'too-large' || entry.reason === 'unreadable').length
    return {
        cwd: input.cwd,
        scope: input.scope,
        base: input.base,
        targets: input.targets.length,
        scannedFiles,
        scannedLines,
        findings: findings.sort(compareFindings),
        suppressed,
        skipped,
        ...(input.coverageProblem === undefined ? {} : { coverageProblem: input.coverageProblem }),
        full: unread === 0 && !truncated && input.coverageProblem === undefined && scannedFiles > 0,
        truncated,
        allowlist: input.allowlist,
        allowlistFile: input.config.secretScan.allowlistFile,
        durationMs: Date.now() - started,
    }
}

/** Lines a scan actually looked at (all lines, or only the added ones). */
function countScannedLines(text: string, ranges: readonly AddedRange[] | undefined): number {
    const total = text === '' ? 0 : text.split('\n').length
    if (ranges === undefined) return total
    let count = 0
    for (const [start, end] of ranges) count += Math.max(0, Math.min(end, total) - start + 1)
    return count
}

function compareFindings(left: SecretFinding, right: SecretFinding): number {
    return (
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.rule.localeCompare(right.rule)
    )
}

/** Which added ranges a target carries (untracked/new files are wholly new). */
function targetsFromDiff(diff: ChangedRanges): ScanTarget[] {
    return diff.files
        .filter((file) => file.status !== 'deleted' && file.added.length > 0)
        .map((file) => ({ path: file.path, ranges: file.added }))
        .sort((left, right) => left.path.localeCompare(right.path))
}

/** The mission for a call, refusing an unknown explicit id (fail-closed). */
function missionOf(
    deps: ToolDeps,
    store: ReturnType<MissionStoreRegistry['for']>,
    agent: AgentLike | undefined,
    explicitId: string | undefined,
): MissionRecord | undefined {
    if (explicitId !== undefined && explicitId !== '') {
        const mission = store.read(explicitId)
        if (mission === undefined) {
            throw new Error(
                `未知 mission "${explicitId}"：门禁不会记录到任何 mission。下一步：确认真实的 mission id，或省略 missionId 使用会话当前 mission。`,
            )
        }
        return mission
    }
    return store.resolveForAgent(agent)
}

/**
 * Record one gate row and write its detail artifact.
 *
 * A gate is only recorded when the call produced a verdict (an aborted call does
 * not), and the artifact always lands next to the row — a verdict nobody can
 * inspect afterwards is a rumour.
 */
function recordSupplyChainGate(
    deps: ToolDeps,
    store: ReturnType<MissionStoreRegistry['for']>,
    missionId: string,
    outcome: { state: GateState; reason: string; results: GateCommandLike[]; scope?: GateScope },
    payload: Record<string, unknown>,
): { gateId?: string; artifact?: string } {
    const fingerprint = gitFingerprint(store.layout.cwd, { excludePaths: [store.layout.rootDir] })
    const record = store.recordGate(missionId, {
        source: GATE_SOURCE,
        state: outcome.state,
        reason: outcome.reason,
        results: outcome.results,
        ...(outcome.scope === undefined ? {} : { scope: outcome.scope }),
        fingerprint,
    })
    let artifact: string | undefined
    try {
        artifact = store.writeArtifact(
            missionId,
            path.join(ARTIFACT_DIR, `${record.id}.json`),
            `${JSON.stringify(
                {
                    gateId: record.id,
                    missionId,
                    source: GATE_SOURCE,
                    state: outcome.state,
                    reason: outcome.reason,
                    checkedAt: record.checkedAt,
                    scope: outcome.scope,
                    ...payload,
                },
                undefined,
                2,
            )}\n`,
        )
    } catch (error) {
        deps.logger.for(store.layout.cwd).warn('supply-chain 明细写入失败：', error)
    }
    return { gateId: record.id, ...(artifact === undefined ? {} : { artifact }) }
}

/** A gate "command" row describing what this plugin did (no shell involved). */
function componentResult(input: {
    id: string
    name: string
    command: string
    ok: boolean
    exitCode?: number | null
    durationMs: number
    output: string
    timedOut?: boolean
}): GateCommandLike {
    return {
        id: input.id,
        name: input.name,
        command: input.command,
        required: true,
        exitCode: input.exitCode === undefined ? (input.ok ? 0 : 1) : input.exitCode,
        signal: null,
        durationMs: input.durationMs,
        timedOut: input.timedOut === true,
        output: input.output,
        outputDigest: sha256(input.output),
    }
}

/** One line per finding, redacted. */
function findingLines(findings: readonly SecretFinding[], limit = REPORT_FINDING_LIMIT): string[] {
    const lines: string[] = ['| 规则 | 位置 | 严重度 | 摘要（已脱敏） | sha256(值) |', '|---|---|---|---|---|']
    for (const finding of findings.slice(0, limit)) {
        const entropy = finding.entropy === undefined ? '' : `；熵 ${finding.entropy}`
        lines.push(
            `| ${finding.rule} | ${finding.path}:${finding.line}:${finding.column} | ${finding.severity}${entropy} | ${finding.excerpt} | \`${finding.hash.slice(0, 16)}…\` |`,
        )
    }
    if (findings.length > limit) lines.push(`| … | 其余 ${findings.length - limit} 条见 artifact | | | |`)
    return lines
}

/** One line per skipped file, grouped by reason. */
function skippedLines(skipped: readonly { path: string; reason: SkipReason }[]): string[] {
    if (skipped.length === 0) return []
    const byReason = new Map<SkipReason, string[]>()
    for (const entry of skipped) {
        const bucket = byReason.get(entry.reason) ?? []
        bucket.push(entry.path)
        byReason.set(entry.reason, bucket)
    }
    const label: Record<SkipReason, string> = {
        missing: '不存在',
        'not-a-file': '不是普通文件',
        'too-large': '超过 maxFileBytes（未扫描）',
        unreadable: '不可读（未扫描）',
        binary: '二进制（不参与匹配）',
        'outside-workspace': '路径在工作区之外（已拒绝）',
    }
    const lines = [`跳过：${skipped.length} 个`]
    for (const reason of ['missing', 'not-a-file', 'binary', 'too-large', 'unreadable', 'outside-workspace'] as SkipReason[]) {
        const paths = byReason.get(reason)
        if (paths === undefined || paths.length === 0) continue
        const shown = paths.slice(0, REPORT_FILE_LIMIT).join('、')
        lines.push(`  - ${label[reason]}（${paths.length}）：${shown}${paths.length > REPORT_FILE_LIMIT ? ' …' : ''}`)
    }
    return lines
}

/** Register the three tools. */
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

    // --- secret_scan ------------------------------------------------------

    register(
        defineTool({
            name: 'secret_scan',
            description:
                'Scan for committed secrets (API keys, tokens, private keys, high-entropy literals) in the lines this change ADDED, in explicit files, or in the whole bounded tree; honour a repository-owned allowlist (`.dsh/secret-allow.json`); record a PASS/BLOCK gate on the mission. Every excerpt in the report and the artifact is REDACTED (first 4 + last 2 characters + a SHA-256 fingerprint) — the raw secret is never written anywhere. A clean scan means "nothing matched", never "no secret exists".',
            parameters: {
                base: { type: 'string', description: 'Commit/ref to diff against (default HEAD = the working tree).' },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Scan exactly these workspace-relative files, whole file (no added-line filter).',
                },
                wholeTree: {
                    type: 'boolean',
                    description: 'Sweep the bounded tree instead of the change (overrides config `secretScan.scanWholeTree`).',
                },
                missionId: { type: 'string', description: 'Mission to record the gate on (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: SecretScanArgs = {} as SecretScanArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(agent)
                const config = effective.config
                const scanConfig = config.secretScan
                const header = ['## 密钥扫描（secret_scan）', '', `工作区：${cwd}`]
                if (!scanConfig.enabled) {
                    return [
                        ...header,
                        '',
                        '⛔ secret 扫描已被宿主禁用（`secretScan.enabled=false`）：本工具不产出裁决，也不写门禁记录。',
                        '',
                        '下一步：让宿主把 `secretScan.enabled` 打开（这是宿主决定，项目级配置改不了它）；在此之前不要声称"没有密钥"。',
                    ].join('\n')
                }

                const allowlistFileAbs = path.isAbsolute(scanConfig.allowlistFile)
                    ? scanConfig.allowlistFile
                    : path.join(cwd, scanConfig.allowlistFile)
                const allowlist = loadAllowlist(cwd, scanConfig.allowlistFile)
                const explicitPaths = (args.paths ?? []).map((entry) => entry.replace(/^\.\//, '').trim()).filter((entry) => entry !== '')
                const wholeTree = args.wholeTree ?? scanConfig.scanWholeTree
                const base = args.base ?? 'HEAD'

                // The engineering trail (`.dsh/**`) is not source and is not
                // shippable: it is written by plugins (redacted by design) and the
                // write tools are refused there anyway. Scanning it would only add
                // noise to every report.
                const trailPrefix = (() => {
                    const relative = path.relative(cwd, store.layout.rootDir).split(path.sep).join('/')
                    return relative === '' || relative.startsWith('..') ? undefined : `${relative}/`
                })()
                const withoutTrail = (entries: ScanTarget[]): ScanTarget[] =>
                    trailPrefix === undefined ? entries : entries.filter((entry) => !entry.path.startsWith(trailPrefix))

                let targets: ScanTarget[] = []
                let scope: ScanOutcome['scope'] = 'none'
                let truncated = false
                let coverageProblem: string | undefined
                const refused: { path: string; reason: SkipReason }[] = []

                if (explicitPaths.length > 0) {
                    scope = 'explicit-paths'
                    const accepted: string[] = []
                    for (const entry of [...new Set(explicitPaths)].sort()) {
                        const absolute = path.join(cwd, entry)
                        const relative = path.relative(cwd, absolute)
                        // The model supplies these paths: a `../../etc/passwd` must
                        // never become a scan target outside the workspace.
                        if (relative.startsWith('..') || path.isAbsolute(relative)) {
                            refused.push({ path: entry, reason: 'outside-workspace' })
                            continue
                        }
                        accepted.push(relative.split(path.sep).join('/'))
                    }
                    targets = withoutTrail(accepted.map((entry) => ({ path: entry })))
                } else if (wholeTree) {
                    scope = 'whole-tree'
                    const walk = walkWorkspace({ cwd, maxFiles: config.maxFiles })
                    truncated = walk.truncated
                    // The walker already skips the default `.dsh`; a custom
                    // `layout.rootDir` needs the same treatment.
                    targets = withoutTrail(walk.files.map((file) => ({ path: file.rel })))
                } else {
                    scope = 'changed-lines'
                    const diff = await changedRanges({ cwd, base })
                    if (!diff.isRepo) {
                        coverageProblem =
                            diff.problem === undefined
                                ? `不是 git 仓库（base="${base}"）：无法回答"这次改动引入了什么"`
                                : `无法确定改动范围（base="${base}"）：${diff.problem}`
                    } else {
                        targets = withoutTrail(targetsFromDiff(diff))
                    }
                }

                const outcome = runScan({
                    cwd,
                    targets,
                    scope,
                    base: scope === 'changed-lines' ? base : '(整文件)',
                    config,
                    allowlist,
                    truncated,
                    ...(coverageProblem === undefined ? {} : { coverageProblem }),
                })
                outcome.skipped.push(...refused)

                // Nothing scanned is NOT a pass: an empty scan proves nothing.
                const nothingScanned = outcome.scannedFiles === 0 || outcome.scannedLines === 0
                const blockSeverities = scanConfig.blockSeverities
                const blockingFindings = outcome.findings.filter((finding) => blockSeverities.includes(finding.severity))
                const advisoryFindings = outcome.findings.filter((finding) => !blockSeverities.includes(finding.severity))
                const state: GateState =
                    // Only the configured severities block. A known credential
                    // SHAPE blocks; an advisory (entropy without secret context,
                    // e.g. a base64 blob in a README) is reported and makes the
                    // gate WARN — a gate that fires on documentation gets turned
                    // off, which protects nothing.
                    blockingFindings.length > 0
                        ? 'BLOCK'
                        : outcome.findings.length > 0 || nothingScanned || outcome.coverageProblem !== undefined
                          ? 'WARN'
                          : 'PASS'
                const reason =
                    state === 'BLOCK'
                        ? `发现 ${blockingFindings.length} 处疑似密钥（阻断 severity：${blockSeverities.join('、')}；另有 ${advisoryFindings.length} 条建议级提示；扫描 ${outcome.scannedFiles} 个文件 / ${outcome.scannedLines} 行；${describeScope(outcome.scope, outcome.base)}）`
                        : state === 'WARN'
                          ? outcome.coverageProblem !== undefined
                              ? `无法扫描：${outcome.coverageProblem}`
                              : outcome.findings.length > 0
                                ? `只发现 ${advisoryFindings.length} 条建议级提示（severity 不在阻断名单 ${blockSeverities.join('、')} 里）：例如文档里的 base64 或测试夹具里的占位字符串。它们被列出但不阻断；确认无害后用 allowlist 收口。`
                                : `没有扫到任何内容（${outcome.scannedFiles} 个文件 / ${outcome.scannedLines} 行；${describeScope(outcome.scope, outcome.base)}）——"没扫到"不等于"干净"`
                          : `未发现疑似密钥（扫描 ${outcome.scannedFiles} 个文件 / ${outcome.scannedLines} 行；${describeScope(outcome.scope, outcome.base)}）${
                                outcome.full ? '' : '；覆盖不完整（有文件被跳过或遍历被截断，scope.full=false）'
                            }`

                const mission = missionOf(deps, store, agent, args.missionId)
                let gateId: string | undefined
                let artifact: string | undefined
                if (mission !== undefined) {
                    const recorded = recordSupplyChainGate(
                        deps,
                        store,
                        mission.id,
                        {
                            state,
                            reason,
                            results: [
                                componentResult({
                                    id: 'secret-scan',
                                    name: '密钥扫描',
                                    command: `secret_scan(${describeScope(outcome.scope, outcome.base)})`,
                                    ok: state === 'PASS',
                                    durationMs: outcome.durationMs,
                                    output: [
                                        `state=${state}`,
                                        `files=${outcome.scannedFiles}/${outcome.targets} lines=${outcome.scannedLines}`,
                                        `findings=${outcome.findings.length} allowlisted=${outcome.suppressed.length} skipped=${outcome.skipped.length}`,
                                        ...outcome.findings.slice(0, 10).map((finding) => `${finding.rule} ${finding.path}:${finding.line} ${finding.excerpt}`),
                                    ].join('\n'),
                                }),
                            ],
                            scope: { selected: ['secret-scan'], total: 1, full: outcome.full },
                        },
                        {
                            tool: 'secret_scan',
                            rules: SECRET_RULES.map((rule) => ({ id: rule.id, severity: rule.severity })),
                            entropyThreshold: scanConfig.entropyThreshold,
                            allowlistFile: scanConfig.allowlistFile,
                            scope: outcome.scope,
                            base: outcome.base,
                            coverage: {
                                targets: outcome.targets,
                                scannedFiles: outcome.scannedFiles,
                                scannedLines: outcome.scannedLines,
                                full: outcome.full,
                                truncated: outcome.truncated,
                                skipped: outcome.skipped,
                                ...(outcome.coverageProblem === undefined ? {} : { problem: outcome.coverageProblem }),
                            },
                            // Redacted excerpts + hashes only: never the raw value.
                            findings: outcome.findings,
                            allowlisted: outcome.suppressed.map((entry) => ({
                                finding: entry.finding,
                                allowlistEntry: entry.entry.index,
                                ...(entry.entry.note === undefined ? {} : { note: entry.entry.note }),
                                ...(entry.entry.until === undefined ? {} : { until: entry.entry.until }),
                            })),
                        },
                    )
                    gateId = recorded.gateId
                    artifact = recorded.artifact
                }

                const report = [
                    ...header,
                    `范围：${describeScope(outcome.scope, outcome.base)}`,
                    `规则：${SECRET_RULES.length} 条（含熵检测 ${ENTROPY_RULE_ID}，阈值 ${scanConfig.entropyThreshold}）`,
                    `扫描：${outcome.scannedFiles}/${outcome.targets} 个文件、${outcome.scannedLines} 行${outcome.truncated ? `（遍历达到上限 ${config.maxFiles}，已截断 → scope.full=false）` : ''}`,
                    `豁免：${allowlistFileAbs}${allowlist.entries.length === 0 ? '（无生效条目）' : `（${allowlist.entries.length} 条生效）`}`,
                    ...skippedLines(outcome.skipped),
                    ...(allowlist.problems.length === 0 ? [] : ['', '⚠️ allowlist 问题：', ...allowlist.problems.map((problem) => `  - ${problem}`)]),
                    ...(outcome.coverageProblem === undefined ? [] : ['', `⚠️ ${outcome.coverageProblem}`]),
                    '',
                    `裁决：${state} —— ${reason}`,
                    '',
                    ...(outcome.findings.length === 0
                        ? ['未发现匹配的密钥模式。']
                        : [...findingLines(outcome.findings), '', `（artifact 里有全部 ${outcome.findings.length} 条，摘要同样已脱敏）`]),
                    ...(outcome.suppressed.length === 0
                        ? []
                        : [
                              '',
                              `另有 ${outcome.suppressed.length} 处匹配被 allowlist 豁免（逐条记入 artifact，报告里不展开值）：`,
                              ...outcome.suppressed
                                  .slice(0, 5)
                                  .map(
                                      (entry) =>
                                          `  - ${entry.finding.rule} ${entry.finding.path}:${entry.finding.line}（allowlist 第 ${entry.entry.index} 条${entry.entry.note === undefined ? '' : `：${entry.entry.note}`}）`,
                                  ),
                          ]),
                    '',
                    `配置来源：${effective.source === 'project' ? `项目级配置 ${effective.file ?? ''}` : 'profile 配置'}`,
                    `gate record: ${gateId ?? '(无 mission，未记录)'}`,
                    ...(artifact === undefined ? [] : [`artifact: ${artifact}`]),
                    '',
                    state === 'BLOCK'
                        ? '下一步：把匹配到的值从代码里删掉（已经提交过的值一律视为已泄露，去对应平台**轮换**它），改完重跑 secret_scan；确认为误报的匹配写进 .dsh/secret-allow.json（rules/paths/values + until + note），它由人维护。'
                        : state === 'WARN'
                          ? outcome.coverageProblem !== undefined
                              ? '下一步：在 git 仓库里工作（或显式传 paths / wholeTree: true）后重跑 secret_scan；本次的 WARN 不构成"没有密钥"的结论。'
                              : '下一步：确认要扫的范围（本次没有改动、改动没有新增行，或显式 paths 都读不到）——需要全量核查时跑 secret_scan({ wholeTree: true })；不要用本次结果声称仓库干净。'
                          : '下一步：这是"没有匹配到密钥模式"的结论，不是"仓库里没有密钥"的证明（正则 + 熵是网，不是证明）；交付前再跑一次 dependency_audit，让最新门禁覆盖当前改动。',
                ].join('\n')
                logger.info(`secret_scan: ${state} — ${reason}；mission ${mission === undefined ? '(无)' : mission.id}`)
                return report
            },
        }),
        'secret_scan',
    )

    // --- dependency_audit -------------------------------------------------

    register(
        defineTool({
            name: 'dependency_audit',
            description:
                'Gate the dependency change: diff the configured manifests against `base` for NEW declarations, ask the human approval seam for all of them in ONE prompt (a refusal or an unavailable channel is a BLOCK), detect orphan lockfile changes (a lockfile that changed while its declaring manifest did not), and run the host-configured audit commands (`govulncheck`, `npm audit --json`, `pip-audit --format json`, …) through an argv array with no shell. An unparseable report, a refused auditor and "nothing to judge" are never a PASS. Records ONE gate whose state is the worst outcome.',
            parameters: {
                base: { type: 'string', description: 'Commit/ref the manifests are compared against (default HEAD).' },
                missionId: { type: 'string', description: 'Mission to record the gate on (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: DependencyAuditArgs = {} as DependencyAuditArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const logger = deps.logger.for(cwd)
                const effective = deps.configFor(agent)
                const config = effective.config
                const depsConfig = config.deps
                const signal = signalOf(exec)
                const base = args.base ?? 'HEAD'
                const header = ['## 依赖门禁（dependency_audit）', '', `工作区：${cwd}`, `base：${base}`]
                if (!depsConfig.enabled) {
                    return [
                        ...header,
                        '',
                        '⛔ 依赖门禁已被宿主禁用（`deps.enabled=false`）：本工具不产出裁决，也不写门禁记录。',
                        '',
                        '下一步：让宿主把 `deps.enabled` 打开（宿主决定，项目级配置改不了它）；在此之前不要声称依赖变化被门禁覆盖。',
                    ].join('\n')
                }
                const mission = missionOf(deps, store, agent, args.missionId)
                const abortMessage = (): string =>
                    [
                        ...header,
                        '',
                        '⏸️ 本次 dependency_audit 被取消（signal 已 abort）：不构成裁决，未写门禁记录。',
                        '',
                        '下一步：在未被取消的轮次里重跑 dependency_audit。',
                    ].join('\n')

                // --- git base -------------------------------------------------
                const baseProbe = await runCommand({
                    argv: ['git', 'rev-parse', '--verify', '--quiet', `${base}^{commit}`],
                    cwd,
                    timeoutMs: 20_000,
                    ...(signal === undefined ? {} : { signal }),
                })
                if (baseProbe.aborted === true) return abortMessage()
                const baseResolved = baseProbe.exitCode === 0
                const baseProblem = baseResolved
                    ? undefined
                    : `无法解析 base "${base}"（不是 git 仓库或该引用不存在）：无法判断"哪些依赖是这次新增的"`

                // --- manifest diffs ------------------------------------------
                //
                // ONLY with a resolvable base. Without it `diffManifests` would
                // treat the missing "before" as an empty file, so every manifest
                // would look brand-new and every lockfile like an orphan change —
                // a false BLOCK caused by a typo in `base`. Not judging is the
                // honest answer, and it is reported (WARN), never a PASS.
                const manifestPaths = baseResolved ? resolveManifests(cwd, depsConfig.manifests, config.maxFiles) : []
                const diffs: ManifestDiff[] = []
                const unsupported: string[] = []
                const oversized: string[] = []
                const deleted: string[] = []
                for (const manifestPath of manifestPaths) {
                    const after = readText(path.join(cwd, manifestPath))
                    if (after === undefined) {
                        const existedAtBase = (await runCommand({ argv: ['git', 'show', `${base}:${manifestPath}`], cwd, timeoutMs: 20_000 })).exitCode === 0
                        // A manifest that existed at base and is gone now was DELETED:
                        // a dependency change nobody approved.
                        deleted.push(existedAtBase ? `${manifestPath}（工作区里已不存在：删除未参与"新增依赖"判定）` : `${manifestPath}（读取失败）`)
                        continue
                    }
                    if (Buffer.byteLength(after, 'utf8') > config.maxManifestBytes) {
                        oversized.push(manifestPath)
                        continue
                    }
                    const treatment = treatmentOf(manifestPath)
                    if (treatment === 'declared' && !isSupportedManifest(manifestPath)) {
                        unsupported.push(manifestPath)
                        continue
                    }
                    const show = await runCommand({
                        argv: ['git', 'show', `${base}:${manifestPath}`],
                        cwd,
                        timeoutMs: 20_000,
                        ...(signal === undefined ? {} : { signal }),
                    })
                    if (show.aborted === true) return abortMessage()
                    // A non-zero exit here means "absent at base" (the ref itself was
                    // already verified above), i.e. a brand-new manifest whose every
                    // dependency is new.
                    const before = show.exitCode === 0 ? show.stdout : ''
                    const diff = diffManifests({ path: manifestPath, before, after })
                    if (diff.problem !== undefined) unsupported.push(`${manifestPath}（${diff.problem}）`)
                    diffs.push(diff)
                }
                if (isAborted(signal)) return abortMessage()

                const declared = diffs.filter((diff) => diff.treatment === 'declared' && diff.problem === undefined)
                const newDeps: { path: string; entry: DependencyEntry }[] = declared.flatMap((diff) =>
                    diff.added.map((entry) => ({ path: diff.path, entry })),
                )
                const versionChanges: { path: string; name: string; from: string; to: string }[] = declared.flatMap((diff) =>
                    diff.changed.map((change) => ({ path: diff.path, name: change.name, from: change.from, to: change.to })),
                )
                const removedDeps: { path: string; name: string; version: string }[] = declared.flatMap((diff) =>
                    diff.removed.map((entry) => ({ path: diff.path, name: entry.name, version: entry.version })),
                )
                const changedManifests = diffs.filter((diff) => diff.textChanged).map((diff) => diff.path)

                // --- orphan lockfiles ----------------------------------------
                const orphans: { path: string; manifest: string }[] = []
                const companion: { path: string; manifest: string }[] = []
                for (const diff of diffs.filter((entry) => entry.treatment === 'lockfile')) {
                    if (!diff.textChanged) continue
                    const manifest = lockfileManifestOf(diff.path) ?? '(未知)'
                    const manifestChanged = await manifestChangedAgainstBase(cwd, base, manifest, baseResolved)
                    if (manifestChanged) companion.push({ path: diff.path, manifest })
                    else orphans.push({ path: diff.path, manifest })
                }
                if (isAborted(signal)) return abortMessage()

                // --- approval (ONE prompt for every new dependency) ----------
                let approval: { required: boolean; asked: boolean; outcome: string; reason?: string } | undefined
                if (newDeps.length > 0) {
                    if (!depsConfig.requireApprovalForNewDeps) {
                        approval = { required: false, asked: false, outcome: 'not-required' }
                    } else {
                        const seam = deps.approval()
                        if (seam === undefined) {
                            approval = {
                                required: true,
                                asked: false,
                                outcome: 'unavailable',
                                reason: '宿主没有装配审批通道（ctx.get("approval") 为空）',
                            }
                        } else {
                            try {
                                const outcome = await seam.request({
                                    ...(agent === undefined ? {} : { agent }),
                                    toolName: 'dependency_audit',
                                    reason: renderApprovalPrompt(newDeps, { mission: mission?.id, base }),
                                    ...(signal === undefined ? {} : { signal }),
                                })
                                approval = { required: true, asked: true, outcome: String(outcome) }
                            } catch (error) {
                                approval = {
                                    required: true,
                                    asked: true,
                                    outcome: 'unavailable',
                                    reason: `审批通道报错：${error instanceof Error ? error.message : String(error)}`,
                                }
                            }
                        }
                    }
                }
                if (isAborted(signal)) return abortMessage()

                // --- audit commands ------------------------------------------
                interface AuditRun {
                    command: string
                    argv?: string[]
                    configError?: string
                    shape?: string
                    exitCode?: number | null
                    timedOut?: boolean
                    spawnError?: string
                    findings: AuditFinding[]
                    blocking: number
                    warning: number
                    unclassified: number
                    dropped?: number
                    problem?: string
                    durationMs: number
                    summary: string
                }
                const audits: AuditRun[] = []
                const auditResults: GateCommandLike[] = []
                for (const [index, command] of depsConfig.auditCommands.entries()) {
                    const split = splitAuditCommand(command)
                    if ('error' in split) {
                        audits.push({
                            command,
                            configError: split.error,
                            findings: [],
                            blocking: 0,
                            warning: 0,
                            unclassified: 0,
                            problem: split.error,
                            durationMs: 0,
                            summary: `配置被拒绝：${split.error}`,
                        })
                        auditResults.push(
                            componentResult({
                                id: `audit-${index + 1}`,
                                name: `审计命令 ${index + 1}（配置被拒绝）`,
                                command,
                                ok: false,
                                durationMs: 0,
                                output: split.error,
                            }),
                        )
                        continue
                    }
                    if (isAborted(signal)) return abortMessage()
                    const run: RunOutcome = await runCommand(
                        {
                            argv: split.argv,
                            cwd,
                            timeoutMs: config.auditTimeoutMs,
                            maxOutputBytes: config.maxOutputBytes,
                            ...(signal === undefined ? {} : { signal }),
                        },
                        deps.subprocess(),
                    )
                    if (run.aborted === true) return abortMessage()
                    const parsed = parseAuditOutput({ command, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode })
                    const classified = classifyFindings(parsed.findings, depsConfig.auditSeverities)
                    const problem =
                        run.spawnError !== undefined
                            ? `无法启动审计命令：${run.spawnError}`
                            : run.timedOut
                              ? `审计命令超时（${config.auditTimeoutMs}ms）后被杀：报告不完整，按 fail-closed 处理`
                              : parsed.problem
                    const summary = [
                        `shape=${parsed.shape}`,
                        `exit=${run.exitCode === null ? 'null' : run.exitCode}`,
                        `findings=${parsed.findings.length}`,
                        `block=${classified.blocking.length}`,
                        `warn=${classified.warning.length}`,
                        `unclassified=${classified.unclassified.length}`,
                        ...(problem === undefined ? [] : [`problem=${problem}`]),
                    ].join(' ')
                    audits.push({
                        command,
                        argv: split.argv,
                        shape: parsed.shape,
                        exitCode: run.exitCode,
                        timedOut: run.timedOut,
                        ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
                        findings: parsed.findings,
                        blocking: classified.blocking.length,
                        warning: classified.warning.length,
                        unclassified: classified.unclassified.length,
                        ...(parsed.dropped === undefined ? {} : { dropped: parsed.dropped }),
                        ...(problem === undefined ? {} : { problem }),
                        durationMs: run.durationMs,
                        summary,
                    })
                    auditResults.push(
                        componentResult({
                            id: `audit-${index + 1}`,
                            name: `审计命令 ${index + 1}`,
                            command,
                            ok: problem === undefined && classified.blocking.length === 0,
                            exitCode: run.exitCode,
                            durationMs: run.durationMs,
                            timedOut: run.timedOut,
                            // The raw report is NOT stored: an auditor's output can embed
                            // a registry URL with credentials. This summary is not raw.
                            output: summary,
                        }),
                    )
                }

                // --- verdict --------------------------------------------------
                const problems: string[] = []
                if (baseProblem !== undefined) problems.push(baseProblem)
                for (const path of unsupported) problems.push(`${path}: 清单格式无法解析，变更未参与"新增依赖"判定——需要人看 diff`)
                for (const path of oversized) problems.push(`${path}: 超过 maxManifestBytes（${config.maxManifestBytes}），未参与判定`)
                for (const path of deleted) problems.push(`${path}: 未参与判定`)
                for (const diff of diffs) {
                    if (diff.treatment === 'watch-only' && diff.textChanged) {
                        problems.push(`${diff.path}: 只观察不解析（不支持该格式）：它变了，但门禁无法判断变了什么`)
                    }
                }

                const approvalBlocked = approval !== undefined && approval.required && approval.outcome !== 'allowed-once'
                const auditBlocking = audits.some((audit) => audit.blocking > 0 || audit.problem !== undefined)
                const manifestChanged = changedManifests.length > 0
                const nothingToJudge = !manifestChanged && audits.length === 0
                const warnReasons: string[] = []
                if (nothingToJudge) warnReasons.push('没有可判定的对象：清单未变更，也没有配置审计命令')
                if (manifestChanged && audits.length === 0) {
                    warnReasons.push('清单变了但没有配置任何审计命令：新依赖/新版本是否已知漏洞无人检查')
                }
                if (newDeps.length > 0 && !depsConfig.requireApprovalForNewDeps) {
                    warnReasons.push('新增依赖未经人工审批（宿主关闭了 requireApprovalForNewDeps）：只报告')
                }
                if (problems.length > 0) warnReasons.push(`有 ${problems.length} 项未能判定（见下）`)
                if (audits.some((audit) => audit.unclassified > 0)) {
                    warnReasons.push('审计报告里有未分类 severity 的条目：已列出但不阻断')
                }
                const state: GateState =
                    approvalBlocked || auditBlocking || orphans.length > 0 ? 'BLOCK' : warnReasons.length > 0 ? 'WARN' : 'PASS'
                const reason = buildDepsReason({
                    state,
                    newDeps: newDeps.length,
                    versionChanges: versionChanges.length,
                    removed: removedDeps.length,
                    changedManifests,
                    orphans,
                    audits,
                    approval,
                    warnReasons,
                    problems,
                })

                let gateId: string | undefined
                let artifact: string | undefined
                if (mission !== undefined) {
                    const selected = [
                        'manifest-diff',
                        ...(approval === undefined ? [] : ['new-deps-approval']),
                        ...audits.map((_entry, index) => `audit-${index + 1}`),
                    ]
                    const recorded = recordSupplyChainGate(
                        deps,
                        store,
                        mission.id,
                        {
                            state,
                            reason,
                            results: [
                                componentResult({
                                    id: 'manifest-diff',
                                    name: '清单差异',
                                    command: `git show ${base}:<manifest> ×${manifestPaths.length}`,
                                    ok: problems.length === 0 && orphans.length === 0,
                                    durationMs: 0,
                                    output: `manifests=${manifestPaths.length} changed=${changedManifests.length} added=${newDeps.length} versionChanged=${versionChanges.length} removed=${removedDeps.length} orphans=${orphans.length}`,
                                }),
                                ...(approval === undefined
                                    ? []
                                    : [
                                          componentResult({
                                              id: 'new-deps-approval',
                                              name: '新依赖审批',
                                              command: `approval: ${newDeps.length} 个新增依赖一次请求`,
                                              ok: !approvalBlocked,
                                              durationMs: 0,
                                              output: `required=${approval.required} asked=${approval.asked} outcome=${approval.outcome}${approval.reason === undefined ? '' : ` (${approval.reason})`}`,
                                          }),
                                      ]),
                                ...auditResults,
                            ],
                            scope: {
                                selected,
                                total: selected.length,
                                full: problems.length === 0 && audits.length === depsConfig.auditCommands.length && (audits.length > 0 || newDeps.length > 0),
                            },
                        },
                        {
                            tool: 'dependency_audit',
                            base,
                            baseResolved,
                            manifestsConfigured: depsConfig.manifests,
                            manifestsRead: manifestPaths,
                            manifestsChanged: changedManifests,
                            requiresApproval: depsConfig.requireApprovalForNewDeps,
                            diffs,
                            newDependencies: newDeps,
                            versionChanges,
                            removedDependencies: removedDeps,
                            orphanLockfiles: orphans,
                            lockfilesWithManifest: companion,
                            deletedManifests: deleted,
                            unsupportedManifests: unsupported,
                            audits,
                            problems,
                            limits: { maxManifestBytes: config.maxManifestBytes, auditTimeoutMs: config.auditTimeoutMs, maxFiles: config.maxFiles },
                        },
                    )
                    gateId = recorded.gateId
                    artifact = recorded.artifact
                }

                const unclassified = audits.reduce((sum, audit) => sum + audit.unclassified, 0)
                const report = [
                    ...header,
                    `清单：配置 ${depsConfig.manifests.length} 项 → 命中 ${manifestPaths.length} 个；变更 ${changedManifests.length} 个${changedManifests.length === 0 ? '' : `（${changedManifests.join('、')}）`}`,
                    `依赖变化：新增 ${newDeps.length}、版本变更 ${versionChanges.length}、删除 ${removedDeps.length}`,
                    ...newDeps.slice(0, 15).map((entry) => `  - 新增 ${entry.path}: ${entry.entry.name} ${entry.entry.version}（${entry.entry.kind}）`),
                    ...(newDeps.length > 15 ? [`  - … 其余 ${newDeps.length - 15} 个见 artifact`] : []),
                    ...versionChanges.slice(0, 10).map((change) => `  - 变更 ${change.path}: ${change.name} ${change.from} → ${change.to}`),
                    `新依赖审批：${
                        approval === undefined
                            ? `未触发（新增 0 个；requireApprovalForNewDeps=${depsConfig.requireApprovalForNewDeps}）`
                            : approval.required
                              ? `已请求（一次列出全部 ${newDeps.length} 个）→ ${approval.outcome}${approval.reason === undefined ? '' : `（${approval.reason}）`}`
                              : '已由宿主关闭（requireApprovalForNewDeps=false）：只报告，不阻断'
                    }`,
                    `锁文件：孤儿变更 ${orphans.length} 个${
                        orphans.length === 0 ? '' : `（${orphans.map((entry) => `${entry.path} 变了但 ${entry.manifest} 没变`).join('；')}）`
                    }${companion.length === 0 ? '' : `；与声明文件一起变更 ${companion.length} 个（正常）`}`,
                    `审计命令：${depsConfig.auditCommands.length} 条${
                        audits.length === 0 ? '（未配置：新依赖是否已知漏洞无人检查）' : audits.map((audit) => `\n  - \`${audit.command}\` → ${audit.summary}`).join('')
                    }`,
                    ...(unclassified === 0
                        ? []
                        : [
                              '  ⚠️ 有未分类 severity 的条目（该报告的格式里没有 severity，或 severity 不在 block/warn 名单里）：它们已被列出，但不会 BLOCK。',
                              `     要阻断它们，把 "unknown"（或报告里的真实 severity）加进 deps.auditSeverities.block（当前 block=${depsConfig.auditSeverities.block.join(',') || '(空)'}）。`,
                          ]),
                    ...(audits.some((audit) => (audit.dropped ?? 0) > 0) ? ['  ⚠️ 部分审计条目超出上限被丢弃，明细见 artifact。'] : []),
                    ...(problems.length === 0 ? [] : ['', '⚠️ 未能判定的部分：', ...problems.map((problem) => `  - ${problem}`)]),
                    ...(warnReasons.length === 0 ? [] : ['', '⚠️ 未阻断的问题（会让裁决至少 WARN）：', ...warnReasons.map((warning) => `  - ${warning}`)]),
                    '',
                    `裁决：${state} —— ${reason}`,
                    '',
                    `配置来源：${effective.source === 'project' ? `项目级配置 ${effective.file ?? ''}` : 'profile 配置'}`,
                    `gate record: ${gateId ?? '(无 mission，未记录)'}`,
                    ...(artifact === undefined ? [] : [`artifact: ${artifact}`]),
                    '',
                    state === 'BLOCK'
                        ? approvalBlocked
                            ? '下一步：新增依赖未被批准（或审批通道不可用）。把依赖从清单里去掉，或让人类重新批准（宿主需要装配 ctx.approval）；批准后重跑 dependency_audit。'
                            : audits.some((audit) => audit.problem !== undefined)
                              ? '下一步：修好审计命令的配置/输出（见上面的问题行）后重跑 dependency_audit；"看不懂的报告"不会因为重跑变成干净。'
                              : orphans.length > 0
                                ? `下一步：锁文件出现了没有声明依据的变更（${orphans.map((entry) => entry.path).join('、')}）。把对应声明写进 ${orphans.map((entry) => entry.manifest).join('、')}，或还原锁文件（git checkout <base> -- <锁文件>）；改完重跑 dependency_audit。`
                                : '下一步：修掉上面的阻断项（漏洞/审批），改完重跑 dependency_audit。'
                        : state === 'WARN'
                          ? depsConfig.auditCommands.length === 0
                              ? '下一步：配置 deps.auditCommands（例如 "govulncheck ./..."、"npm audit --json"、"pip-audit --format json"）——没有审计命令时，依赖是否已知漏洞无人检查，所以这里最多只能是 WARN。注意 govulncheck / pip-audit 的输出里没有 severity，要阻断它们请把 "unknown" 加进 deps.auditSeverities.block。'
                              : '下一步：按上面的问题行与"为什么不是 PASS"补齐判定（清单格式/锁文件/未分类 severity），或让人类确认后再交付；本次 WARN 不是"依赖没问题"的结论。'
                          : '下一步：依赖变化已被判定（新增依赖已获人工批准，审计命令已跑且无阻断项）。交付前让最新一条 supply-chain 门禁覆盖当前改动，并注意：审计命令只覆盖它自己认识的那部分生态。',
                ].join('\n')
                logger.info(`dependency_audit: ${state} — ${reason}；mission ${mission === undefined ? '(无)' : mission.id}`)
                return report
            },
        }),
        'dependency_audit',
    )

    // --- supply_chain_status ---------------------------------------------

    register(
        defineTool({
            name: 'supply_chain_status',
            description:
                'Read-only view of the supply-chain gate: the configuration in force (rule count, allowlist size, audit commands, block severities), the newest supply-chain gate recorded on the mission with its findings, and the newest detail artifact. Use it before claiming anything about secrets or dependencies.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to inspect (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const agent = agentOf(exec)
                const cwd = declaredCwdOrThrow(agent)
                const store = deps.stores.for(cwd)
                const effective: EffectiveConfig = deps.configFor(agent)
                const config = effective.config
                const allowlist = loadAllowlist(cwd, config.secretScan.allowlistFile)
                const allowlistFileAbs = path.isAbsolute(config.secretScan.allowlistFile)
                    ? config.secretScan.allowlistFile
                    : path.join(cwd, config.secretScan.allowlistFile)
                const lines = [
                    '## 供应链门禁现状（supply_chain_status）',
                    '',
                    `工作区：${cwd}`,
                    `配置来源：${effective.source === 'project' ? `项目级配置 ${effective.file ?? ''}` : 'profile 配置'}`,
                    ...(effective.problems.length === 0 ? [] : ['配置问题：', ...effective.problems.map((problem) => `  - ${problem}`)]),
                    '',
                    '### 密钥扫描',
                    '',
                    `- 开关：${config.secretScan.enabled ? '开启' : '**关闭**（宿主决定）'}`,
                    `- 规则：${SECRET_RULES.length} 条（含熵检测 ${ENTROPY_RULE_ID}，阈值 ${config.secretScan.entropyThreshold}）`,
                    `- 规则清单：${SECRET_RULES.map((rule) => `${rule.id}[${rule.severity}]`).join('、')}`,
                    `- 默认范围：${config.secretScan.scanWholeTree ? '整棵树' : '仅改动新增行'}（上限 ${config.maxFiles} 个文件、单文件 ${config.secretScan.maxFileBytes} 字节）`,
                    `- allowlist：${allowlistFileAbs} —— ${allowlist.entries.length} 条生效`,
                    ...(allowlist.problems.length === 0 ? [] : ['- ⚠️ allowlist 问题：', ...allowlist.problems.map((problem) => `  - ${problem}`)]),
                    ...allowlist.entries.map((entry) => {
                        const parts: string[] = []
                        if (entry.rules !== undefined) parts.push(`rules=${entry.rules.join(',')}`)
                        if (entry.paths !== undefined) parts.push(`paths=${entry.paths.join(',')}`)
                        if (entry.values !== undefined) parts.push(`values=${entry.values.length} 个哈希`)
                        if (entry.until !== undefined) parts.push(`until=${entry.until}`)
                        return `  - 第 ${entry.index} 条：${parts.join(' ')}${entry.note === undefined ? '' : ` —— ${entry.note}`}`
                    }),
                    '',
                    '### 依赖',
                    '',
                    `- 开关：${config.deps.enabled ? '开启' : '**关闭**（宿主决定）'}；新依赖审批：${
                        config.deps.requireApprovalForNewDeps ? '开（需要人工批准）' : '**关**（宿主关闭：新增依赖只报告）'
                    }`,
                    `- 观察清单（${config.deps.manifests.length}）：${config.deps.manifests.join('、')}`,
                    `- 审计命令（${config.deps.auditCommands.length}）：${
                        config.deps.auditCommands.length === 0
                            ? '**未配置**（依赖是否已知漏洞无人检查 → 依赖侧最多 WARN）'
                            : config.deps.auditCommands.map((command) => `\`${command}\``).join('、')
                    }`,
                    `- 阻断 severity：${config.deps.auditSeverities.block.join('、') || '(空)'}；警告 severity：${config.deps.auditSeverities.warn.join('、') || '(空)'}（不在两者里的 severity 只报告，可用 "unknown" 显式纳入阻断）`,
                    `- 审计超时：${config.auditTimeoutMs}ms；清单上限：${config.maxManifestBytes} 字节`,
                    '',
                    '### 本次 mission 的门禁',
                    '',
                ]
                const mission = store.resolveForAgent(agent, {
                    ...(args.missionId === undefined || args.missionId === '' ? {} : { explicitId: args.missionId }),
                })
                if (mission === undefined) {
                    lines.push('- （没有 mission：本插件的门禁结果不会被记录到任何 mission）')
                } else {
                    const gate = store.lastGate(mission.id, { source: GATE_SOURCE })
                    lines.push(
                        `- mission：${mission.id}（${mission.status}）`,
                        gate === undefined
                            ? '- 最新门禁：（还没跑过 secret_scan / dependency_audit）'
                            : `- 最新门禁：${gate.state} @ ${formatTime(gate.checkedAt)} —— ${gate.reason}`,
                        ...(gate === undefined
                            ? []
                            : [
                                  `  - scope：${gate.scope === undefined ? '(未标注)' : `${gate.scope.selected.join(',')} (full=${gate.scope.full})`}`,
                                  ...gate.results.map((result) => `  - [${result.exitCode === 0 ? 'ok' : 'fail'}] ${result.id}: ${result.output.split('\n')[0] ?? ''}`),
                              ]),
                    )
                }
                const artifacts = mission === undefined ? [] : listDir(store.artifactPath(mission.id, ARTIFACT_DIR)).filter((name) => name.endsWith('.json')).sort()
                lines.push('', '### 最新明细工件', '')
                const newest = artifacts.at(-1)
                if (mission === undefined || newest === undefined) {
                    lines.push('- （还没有 supply-chain 明细工件）')
                } else {
                    const file = store.artifactPath(mission.id, path.join(ARTIFACT_DIR, newest))
                    const payload = readJson<Record<string, unknown>>(file)
                    lines.push(
                        `- ${newest}（共 ${artifacts.length} 个）`,
                        `- 文件：${file}`,
                        ...(payload === undefined
                            ? ['- ⚠️ 无法解析该工件（可能被截断）']
                            : [
                                  `- 工具：${String(payload['tool'] ?? '?')}；裁决：${String(payload['state'] ?? '?')}；原因：${String(payload['reason'] ?? '')}`,
                                  ...(Array.isArray(payload['findings']) ? [`- 未豁免的匹配：${(payload['findings'] as unknown[]).length} 条（摘要已脱敏）`] : []),
                                  ...(Array.isArray(payload['allowlisted']) ? [`- 被豁免的匹配：${(payload['allowlisted'] as unknown[]).length} 条`] : []),
                                  ...(Array.isArray(payload['newDependencies']) ? [`- 新增依赖：${(payload['newDependencies'] as unknown[]).length} 个`] : []),
                                  ...(Array.isArray(payload['audits']) ? [`- 审计命令：${(payload['audits'] as unknown[]).length} 条`] : []),
                              ]),
                    )
                }
                lines.push(
                    '',
                    '下一步：交付前依次跑 secret_scan 与 dependency_audit，确认最新一条 supply-chain 门禁是 PASS 且覆盖当前改动；本插件只回答"提交里有没有密钥形状的字符串"和"依赖变化有没有人看过/有没有已知漏洞"，不回答"这个依赖是否可信"。',
                )
                return lines.join('\n')
            },
        }),
        'supply_chain_status',
    )

    return { disposers, registered, failed }
}

/** Human-readable scope label. */
function describeScope(scope: ScanOutcome['scope'], base: string): string {
    switch (scope) {
        case 'changed-lines':
            return `改动新增行（base=${base}）`
        case 'whole-tree':
            return '整棵树（上限内）'
        case 'explicit-paths':
            return '显式 paths（整文件）'
        case 'none':
            return '(未建立范围)'
    }
}

/**
 * Expand configured manifest entries into concrete workspace-relative paths.
 *
 * A plain entry is used as-is when the file exists; an entry containing a glob is
 * matched against the bounded workspace walk, so a monorepo can watch every
 * package manifest (`packages/<name>/package.json`) without listing each one.
 */
function resolveManifests(cwd: string, manifests: readonly string[], maxFiles: number): string[] {
    const out = new Set<string>()
    const globs = manifests.filter((entry) => entry.includes('*') || entry.includes('?'))
    for (const entry of manifests) {
        if (entry.includes('*') || entry.includes('?')) continue
        const relative = entry.replace(/^\.\//, '')
        if (readText(path.join(cwd, relative)) !== undefined) out.add(relative)
    }
    if (globs.length > 0) {
        const walk = walkWorkspace({ cwd, maxFiles })
        for (const file of walk.files) {
            if (globs.some((pattern) => manifestMatches(pattern, file.rel) || manifestMatches(pattern, path.basename(file.rel)))) {
                out.add(file.rel)
            }
        }
    }
    return [...out].sort((left, right) => left.localeCompare(right))
}

/** Whether a lockfile's declaring manifest differs from `base` (or is absent there). */
async function manifestChangedAgainstBase(cwd: string, base: string, manifest: string, baseResolved: boolean): Promise<boolean> {
    const after = readText(path.join(cwd, manifest))
    if (after === undefined) return false
    if (!baseResolved) return false
    const show = await runCommand({ argv: ['git', 'show', `${base}:${manifest}`], cwd, timeoutMs: 20_000 })
    const before = show.exitCode === 0 ? show.stdout : ''
    return before !== after
}

/** The human reads this before granting a new-dependency allowance. */
function renderApprovalPrompt(
    newDeps: readonly { path: string; entry: DependencyEntry }[],
    context: { mission?: string | undefined; base: string },
): string {
    const shown = newDeps.slice(0, 40)
    return [
        `新增依赖需要人工确认（${newDeps.length} 个${newDeps.length > shown.length ? `，下面只列前 ${shown.length} 个` : ''}）：`,
        ...shown.map((entry) => `  - ${entry.path}: ${entry.entry.name} ${entry.entry.version}（${entry.entry.kind}）`),
        '',
        `基线：${context.base}${context.mission === undefined ? '' : `；mission ${context.mission}`}`,
        '批准 = 允许这次改动引入这些依赖（只授权本次，不改动任何文件）；',
        '拒绝 = dependency_audit 记 BLOCK，交付被挡住。',
        '如果这些依赖不是你/团队有意引入的，请拒绝并检查改动来源。',
    ].join('\n')
}

/** The one-line verdict explanation for `dependency_audit`. */
function buildDepsReason(input: {
    state: GateState
    newDeps: number
    versionChanges: number
    removed: number
    changedManifests: readonly string[]
    orphans: readonly { path: string }[]
    audits: readonly { blocking: number; warning: number; unclassified: number; problem?: string }[]
    approval?: { required: boolean; outcome: string; reason?: string } | undefined
    warnReasons: readonly string[]
    problems: readonly string[]
}): string {
    const parts: string[] = []
    parts.push(
        `清单变更 ${input.changedManifests.length} 个（新增 ${input.newDeps}、版本变更 ${input.versionChanges}、删除 ${input.removed}）`,
    )
    if (input.orphans.length > 0) parts.push(`${input.orphans.length} 个锁文件出现孤儿变更（${input.orphans.map((entry) => entry.path).join('、')}）`)
    if (input.approval !== undefined && input.approval.required) {
        parts.push(
            input.approval.outcome === 'allowed-once'
                ? '新增依赖已获人工批准'
                : `新增依赖未获批（${input.approval.outcome}${input.approval.reason === undefined ? '' : `：${input.approval.reason}`}）`,
        )
    }
    if (input.audits.length > 0) {
        const blocking = input.audits.reduce((sum, audit) => sum + audit.blocking, 0)
        const warning = input.audits.reduce((sum, audit) => sum + audit.warning, 0)
        const unclassified = input.audits.reduce((sum, audit) => sum + audit.unclassified, 0)
        const broken = input.audits.filter((audit) => audit.problem !== undefined).length
        parts.push(
            `审计 ${input.audits.length} 条（阻断 ${blocking}、警告 ${warning}、未分类 ${unclassified}${broken === 0 ? '' : `、无法判定 ${broken}`}）`,
        )
    } else {
        parts.push('没有配置审计命令：依赖是否已知漏洞无人检查')
    }
    if (input.problems.length > 0) parts.push(`未能判定 ${input.problems.length} 项`)
    if (input.state === 'PASS') parts.push('全部判定完成')
    return parts.join('；')
}

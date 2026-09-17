/**
 * Chinese report rendering: every verdict the model receives is a checklist
 * with the exact next tool call, so "blocked" is always actionable
 * (docs.md §9 "门禁不通过时给出可执行的下一步").
 * @module dsh-evidence-gate/report
 */

import { describeFingerprint, formatTime, type GitFingerprint, type MissionRecord, type Receipt } from 'dsh-eng-core'
import type { EvidenceGateConfig } from './config.js'
import type { DeliveryCheck, DeliveryEvaluation, DeliveryOutcome } from './delivery.js'
import { describeEvidence } from './evidence.js'

/** `✅` / `❌`, and `⚠️` for a check that passed without being verified. */
function mark(check: DeliveryCheck): string {
    if (!check.ok) return '❌'
    return check.unverified === true ? '⚠️' : '✅'
}

/** Render the fingerprint of a gate record (`未记录` when the gate has none). */
function fingerprintText(fingerprint: GitFingerprint | undefined): string {
    return fingerprint === undefined ? '未记录' : describeFingerprint(fingerprint)
}

/** Render one checklist, including the fix line of every failed check. */
export function renderChecklist(checks: readonly DeliveryCheck[]): string[] {
    const lines: string[] = []
    for (const check of checks) {
        lines.push(`- ${mark(check)} ${check.label} — ${check.detail}`)
        if (!check.ok && check.fix !== undefined) lines.push(`  → 下一步：${check.fix}`)
    }
    return lines
}

/** One line naming every check that passed without being verified. */
function unverifiedLine(checks: readonly DeliveryCheck[]): string | undefined {
    const unverified = checks.filter((check) => check.ok && check.unverified === true)
    if (unverified.length === 0) return undefined
    return `⚠️ 未核对项（不阻断交付，但没有任何证据证明它们是成立的）: ${unverified
        .map((check) => `${check.label} — ${check.detail}`)
        .join('；')}`
}

/** The full flow overview returned by `evidence_status`. */
export function renderOverview(input: {
    mission: MissionRecord
    evaluation: DeliveryEvaluation
    config: EvidenceGateConfig
    /**
     * Where `config` came from: the profile, or this workspace's
     * `.dsh/evidence-gate.json`. Reported so a human can see which
     * configuration produced the checklist.
     */
    configSource: { source: 'profile' | 'project'; file?: string; problems: readonly string[] }
    receipts: readonly Receipt[]
}): string {
    const { mission, evaluation, config, configSource, receipts } = input
    const counts = new Map<string, number>()
    for (const row of evaluation.evidence) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    const countsText = counts.size === 0 ? '无' : [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(' / ')
    const newest = [...evaluation.evidence].sort((left, right) => right.recordedAt - left.recordedAt).slice(0, 5)
    const spec = mission.spec
    const specText =
        spec === undefined
            ? '未创建'
            : spec.approvedAt === undefined
              ? `已创建但未审批（rev ${spec.revision}）`
              : `已审批（rev ${spec.revision}，验收标准 ${spec.acceptanceCriteria.length} 条，${formatTime(spec.approvedAt)} by ${spec.approvedBy ?? 'unknown'}）`
    const gate = evaluation.gate
    const sourceText =
        configSource.source === 'project'
            ? `项目级 ${configSource.file ?? '（项目配置文件）'}`
            : configSource.problems.length > 0
              ? `profile（项目级文件 ${configSource.file ?? '（未知路径）'} 未生效：见配置问题）`
              : `profile（无项目级覆盖${configSource.file === undefined ? '' : `：${configSource.file} 不存在或没有可覆盖的键`}）`
    const lines = [
        `## 证据与交付总览（mission ${mission.id}）`,
        `标题: ${mission.title}`,
        `状态: ${mission.status}；规格: ${specText}`,
        `证据: 共 ${evaluation.evidence.length} 条（${countsText}）`,
    ]
    if (newest.length === 0) {
        lines.push('最近证据: 无')
    } else {
        lines.push('最近证据（最新 5 条）:')
        for (const row of newest) lines.push(`  - ${describeEvidence(row)}`)
    }
    lines.push(
        `最新门禁（source=${config.gateSource}）: ${
            gate === undefined
                ? '无'
                : `${gate.id} ${gate.state} — ${gate.reason}（${formatTime(gate.checkedAt)}，观测指纹 ${fingerprintText(gate.fingerprint)}）`
        }`,
    )
    lines.push(
        receipts.length === 0
            ? '回执: 无'
            : `回执: ${receipts.map((receipt) => `${receipt.id}（digest ${receipt.digest.slice(0, 16)}…，${formatTime(receipt.issuedAt)}）`).join(' / ')}`,
    )
    // The provenance line: the checklist below is the *effective* config, so
    // say whether it came from the profile or this workspace's project file.
    lines.push(
        `配置来源：${sourceText}${
            configSource.problems.length === 0 ? '' : `（另有 ${configSource.problems.length} 条配置问题，见插件日志）`
        }`,
    )
    lines.push(`必填证据类型（config.requiredEvidenceKinds）: ${config.requiredEvidenceKinds.join(', ') || '（无）'}`)
    lines.push(
        `其它门禁参数（生效值）: requireGate=${config.requireGate} / requireCleanTree=${config.requireCleanTree} / maxGateAgeMinutes=${config.maxGateAgeMinutes}`,
    )
    lines.push('fail-closed 检查表（mission_complete 的通过条件，缺一项即拒绝）:')
    lines.push(...renderChecklist(evaluation.checks))
    const unverified = unverifiedLine(evaluation.checks)
    if (unverified !== undefined) lines.push(unverified)
    lines.push(
        evaluation.ok
            ? `结论: 全部通过，可以调用 mission_complete 交付。${
                  unverified === undefined ? '' : '（注意上面带 ⚠️ 的项没有经过核对，交付报告会再次声明。）'
              }`
            : `结论: 还差 ${evaluation.failures.length} 项，现在调用 mission_complete 会被拒绝。`,
    )
    return lines.join('\n')
}

/** The `❌` report returned by a blocked `mission_complete`. */
export function renderBlocked(input: {
    mission: MissionRecord
    evaluation: DeliveryEvaluation
    failures: readonly DeliveryCheck[]
    refused: readonly string[]
    forceRequested: boolean
}): string {
    const { mission, evaluation, failures, refused, forceRequested } = input
    const lines = [
        `❌ mission ${mission.id} 不能交付：${failures.length} 项检查未通过（mission 状态未改变，仍为 ${mission.status}）。`,
        ...renderChecklist(failures),
    ]
    if (forceRequested) {
        lines.push(
            refused.length > 0
                ? `force=true 被拒绝：它只能放松"必填证据类型"检查，不能绕过 ${refused.join('、')}。`
                : 'force=true 只放松"必填证据类型"检查，并在通过时强制写入一条 manual 证据留痕。',
        )
    }
    const gate = evaluation.gate
    lines.push(
        `当前最新门禁: ${gate === undefined ? '无' : `${gate.id} ${gate.state} — ${gate.reason}`}；证据 ${evaluation.evidence.length} 条；当前指纹 ${describeFingerprint(evaluation.fingerprint)}`,
    )
    lines.push('按上面的"下一步"修复后重新调用 mission_complete：回执只在全部通过时签发，且不可覆盖。')
    return lines.join('\n')
}

/** The `✅` report returned by a successful `mission_complete`. */
export function renderDelivered(input: {
    mission: MissionRecord
    evaluation: DeliveryEvaluation
    outcome: DeliveryOutcome
    summary?: string
}): string {
    const { mission, evaluation, outcome, summary } = input
    const gate = outcome.gate
    const text = summary === undefined ? undefined : summary.trim()
    const unverified = unverifiedLine(evaluation.checks)
    return [
        `✅ mission ${mission.id} 已交付（状态 delivered）。`,
        `回执: ${outcome.receipt.id}（digest ${outcome.receipt.digest.slice(0, 16)}…）${
            outcome.receipt.path === undefined ? '' : `\n工件: ${outcome.receipt.path}`
        }`,
        `门禁: ${gate === undefined ? '(无)' : `${gate.id} ${gate.state} by ${gate.source} — ${gate.reason}`}`,
        `证据: ${outcome.evidenceIds.length} 条（${outcome.evidenceIds.join(', ') || '无'}）`,
        `git 指纹: ${fingerprintText(outcome.receipt.git)}`,
        `规格 digest: ${mission.specDigest?.slice(0, 16) ?? '(none)'}`,
        ...(outcome.overrideNote === undefined ? [] : [`force 覆盖已留痕: ${outcome.overrideNote}`]),
        ...(text === undefined || text === '' ? [] : [`交付说明: ${text}`]),
        `交付前检查: ${evaluation.checks.filter((check) => check.ok).length}/${evaluation.checks.length} 通过。`,
        ...(unverified === undefined ? [] : [unverified]),
        '回执是不可变工件（write-once）：再次调用 mission_complete 不会覆盖它，也不会重复签发。',
    ].join('\n')
}

/** Report for an already delivered mission (immutability short-circuit). */
export function renderAlreadyDelivered(mission: MissionRecord, receipt: Receipt): string {
    return [
        `ℹ️ mission ${mission.id} 已经交付过（状态 ${mission.status}，receipt ${receipt.id}，digest ${receipt.digest.slice(0, 16)}…，签发于 ${formatTime(receipt.issuedAt)}）。`,
        '回执是不可变工件（write-once）：本次调用不重复签发、不覆盖，证据台账也不改动。',
        '如需重新交付，请新建 mission（spec_create），重新走 evidence_record → quality_gate_run → mission_complete。',
    ].join('\n')
}

/**
 * The two supported ways to get a mission, appended to every "no mission"
 * report. Resolution never falls back to "the newest mission in the
 * workspace": that would let an unrelated session annotate — and deliver —
 * somebody else's mission.
 */
const RESOLUTION_HINT = [
    '  → 下一步：spec_create（建立规格与 mission）或 orchestrate start（建立并绑定流水线 mission）',
    '  → 或者显式指定：在工具参数里传入 missionId（例如 missionId: "M-…"），用于交付本会话以外的 mission',
]

/** Report for `evidence_status` when no mission resolves for this session. */
export function renderNoMission(explicitId?: string): string {
    return [
        explicitId === undefined
            ? '❌ 没有 mission 可查看：当前会话既没有绑定 mission，也没有可继承的委派父会话 mission（不会回退到工作区里最新的 mission——那可能是别的会话的任务）。'
            : `❌ 没有 mission 可查看：找不到 mission ${explicitId}。`,
        '- ❌ mission 已解析 — 解析顺序：显式 missionId → 本会话绑定的 mission → 委派父会话的 mission',
        ...RESOLUTION_HINT,
        '  （先调用 spec_create 建立规格与 mission，再调用 evidence_record / evidence_status。）',
    ].join('\n')
}

/** Report for `mission_complete` when no mission resolves for this session. */
export function renderNoMissionDelivery(explicitId?: string): string {
    return [
        `❌ 不能交付：${
            explicitId === undefined
                ? '当前会话/工作区没有 mission（不会回退到工作区里最新的 mission——那可能是别的会话的任务）'
                : `找不到 mission ${explicitId}`
        }。`,
        '- ❌ mission 已解析 — 解析顺序：显式 missionId → 本会话绑定的 mission → 委派父会话的 mission',
        ...RESOLUTION_HINT,
        '  （完整流程：spec_create → spec_approve → 实现 → evidence_record → quality_gate_run → mission_complete。）',
    ].join('\n')
}

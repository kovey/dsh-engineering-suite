/**
 * Chinese report rendering: every verdict the model receives is a checklist
 * with the exact next tool call, so "blocked" is always actionable
 * (docs.md §9 "门禁不通过时给出可执行的下一步").
 * @module dsh-evidence-gate/report
 */

import fs from 'node:fs'
import path from 'node:path'
import { describeFingerprint, formatTime, type GitFingerprint, type MissionRecord, type Receipt } from 'dsh-eng-core'
import type { EvidenceGateConfig } from './config.js'
import type { DeliveryCheck, DeliveryEvaluation, DeliveryOutcome } from './delivery.js'
import { describeEvidence } from './evidence.js'
import type {
    MissionGateNote,
    MissionNotes,
    ReleaseMission,
    ReleaseNotes,
    ReleaseRefusal,
    ReleaseRow,
} from './releases.js'

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

// --- 发布台账（release_record / release_notes / release_status） --------------

/** `未记录`, or the fingerprint of a ledger row / gate / receipt. */
function revisionText(revision: GitFingerprint | undefined): string {
    return revision === undefined ? '未记录' : describeFingerprint(revision)
}

/** The verdict line of one gate source. */
function gateLine(gate: MissionGateNote): string {
    return `${gate.source}：${gate.state} — ${gate.reason}（${gate.id} @ ${formatTime(gate.checkedAt)}）`
}

/**
 * What one gate recorded as its scope.
 *
 * A record without a `scope` field cannot say what it covered, so the notes say
 * 未记录 — inventing a file list from the command ids of another record would
 * make the notes claim a coverage nobody recorded.
 */
function scopeLine(gate: MissionGateNote): string {
    const scope = gate.scope
    if (scope === undefined) return `${gate.source}：未记录（该记录没有 scope 字段，不推断它覆盖了什么）`
    const selected = scope.selected.join(', ') || '无'
    return scope.full
        ? `${gate.source}：完整覆盖 ${scope.selected.length}/${scope.total}（${selected}）`
        : `${gate.source}：部分覆盖 ${scope.selected.length}/${scope.total}（${selected}）— 该裁决不能作为交付依据`
}

/** The evidence-kind counts of one mission's notes. */
function kindsText(note: MissionNotes): string {
    return note.evidenceKinds.length === 0 ? '未记录' : note.evidenceKinds.map((entry) => `${entry.kind} ${entry.count}`).join('、')
}

/** The header block of the notes document. */
function notesHeader(notes: ReleaseNotes): string[] {
    const version = notes.version ?? '(未命名)'
    return [
        `# 发布说明 ${version}`,
        '',
        `- 版本：${version}${notes.recorded ? '' : '（草稿预览：台账里还没有这个版本，release_record 才会记录它）'}`,
        `- tag：${notes.tag ?? '未记录（本次发布没有绑定 Git tag；台账只记录发布，不代替打 tag）'}`,
        `- 修订：${revisionText(notes.revision)}`,
        `- 日期：${formatTime(notes.at)}`,
        `- mission（${notes.missionIds.length}）：${notes.missionIds.join('、') || '无'}`,
        `- 回执（${notes.receiptIds.length}）：${notes.receiptIds.join('、') || '无'}`,
        ...(notes.notesPath === undefined ? [] : [`- 本文件：${notes.notesPath}`]),
        ...(notes.warnings.length === 0 ? [] : ['', '> ⚠️ ' + notes.warnings.join('\n> ⚠️ ')]),
    ]
}

/** The section of one mission. */
function missionSection(note: MissionNotes, config: EvidenceGateConfig): string[] {
    const lines = [`## ${note.id} — ${note.title}`, '']
    lines.push(
        note.spec === undefined
            ? '- 规格：未记录（mission 上没有规格记录，需求与验收标准无法列出）'
            : `- 规格：rev ${note.spec.revision}${note.spec.path === undefined ? '' : `（\`${note.spec.path}\`）`}${
                  note.spec.approvedAt === undefined
                      ? '，未审批'
                      : `，${formatTime(note.spec.approvedAt)} 由 ${note.spec.approvedBy ?? 'unknown'} 审批`
              }${note.spec.digest === undefined ? '' : `，digest ${note.spec.digest.slice(0, 16)}…`}`,
    )
    lines.push(
        `- 状态：${note.status}${note.delivered ? '' : '——⚠️ 没有回执（未交付）：release_record 会拒绝把该 mission 记入发布'}`,
    )
    // Requirements with their ids: this is what the human approved, quoted.
    if (note.requirements.length === 0) {
        lines.push('- 需求：未记录')
    } else {
        lines.push(`- 需求（${note.requirements.length} 条）：`)
        for (const requirement of note.requirements) lines.push(`  - ${requirement.id} ${requirement.text}`)
    }
    if (!config.notesIncludeCriteria) {
        lines.push(`- 验收标准：${note.criteriaCount} 条（notesIncludeCriteria=false：不列出条目文本）`)
    } else if (note.criteria.length === 0) {
        lines.push(`- 验收标准：${note.criteriaCount} 条（未记录条目文本）`)
    } else {
        lines.push(`- 验收标准（${note.criteriaCount} 条）：`)
        for (const criterion of note.criteria) lines.push(`  - ${criterion.id} ${criterion.text}`)
    }
    // The verdicts that mattered: newest per source, never "the newest gate".
    if (note.gates.length === 0) {
        lines.push('- 门禁裁决：未记录（该 mission 没有任何门禁记录）')
    } else {
        lines.push('- 门禁裁决（每个来源最新一条）：')
        for (const gate of note.gates) lines.push(`  - ${gateLine(gate)}`)
    }
    // What those gates said they covered — 未记录 when the record cannot say.
    if (note.gates.length > 0) {
        lines.push('- 门禁观测范围（scope）：')
        for (const gate of note.gates) lines.push(`  - ${scopeLine(gate)}`)
    }
    lines.push(
        `- 证据类型（回执绑定的 ${note.evidenceCount} 条）：${kindsText(note)}${
            note.unboundEvidence === 0 ? '' : `；台账另有 ${note.unboundEvidence} 条未被任何回执绑定（不计入本说明）`
        }`,
    )
    lines.push(`- 观测到的文件（证据 artifactPath 并集）：${note.files.join('、') || '未记录'}`)
    lines.push(
        note.approver === undefined
            ? '- 交付审批：未记录（回执里没有人工审批记录）'
            : `- 交付审批：by ${note.approver.by}${note.approver.source === '' ? '' : ` via ${note.approver.source}`}${
                  note.approver.messageId === '' ? '' : ` #${note.approver.messageId}`
              }（回执 ${note.approver.receiptId}）`,
    )
    return lines
}

/**
 * Render the release notes document (the artifact `release_record` writes, and
 * what `release_notes` returns).
 *
 * The footer is part of the format on purpose: these notes are a projection of
 * recorded artifacts, and a reader must be able to see what they do NOT claim.
 */
export function renderReleaseNotes(notes: ReleaseNotes, config: EvidenceGateConfig): string {
    const withReceipts = notes.missionIds.length !== notes.receiptIds.length
    return [
        ...notesHeader(notes),
        '',
        ...notes.missions.flatMap((note, index) => (index === 0 ? missionSection(note, config) : ['', ...missionSection(note, config)])),
        '',
        '---',
        '',
        '## 本说明是什么、不是什么',
        '',
        ...NOTES_LIMITS.map((line) => `- ${line}`),
        `- 本次发布的 mission 有 ${notes.missionIds.length} 个、回执 ${notes.receiptIds.length} 个${
            withReceipts ? '：**数量不一致**（一个 mission 可能有多张回执），以回执清单为准' : ''
        }。`,
        ...(notes.tag === undefined
            ? ['- **本次发布未绑定 Git tag**（台账里 tag 为空）：它只存在于本台账，Git 侧没有任何对应的引用。']
            : []),
    ].join('\n')
}

/** The honest limits printed in every notes document's footer. */
const NOTES_LIMITS: readonly string[] = [
    '**这些说明由已登记的工件生成**（规格 / 门禁记录 / 证据台账 / 回执），不是人工凭记忆撰写的，也不要人手改写——要改内容就补记录后重新生成。',
    '**只覆盖上面列出的 mission**：没有登记成证据的验证不会出现在这里，哪怕它真的做过。',
    '**不声明记录里没有的东西**：门禁没有 `scope`、规格没有需求、证据没有 `artifactPath`，都照实写“未记录”，不推断、不补全。',
    '**证据只算回执绑定的那些行**：交付之后补记的证据不会被算进来（会被标注为“未被任何回执绑定”）。',
    '**门禁裁决是每个来源当前最新的一条**：它可能晚于回执（回执之后的复跑也会显示）。要判断“交付当时门禁覆盖了什么”，看回执绑定的证据与门禁记录的时间戳。',
    '**它不代替 tag、不代替 CHANGELOG、也不代替部署记录**：发布台账回答“哪个版本包含这些工作”，Git tag 回答“代码在哪”，部署门禁回答“是否真的上去了”。',
]

/** The notes document plus what `release_notes` wants the model to know about it. */
export function renderReleaseNotesView(input: {
    notes: ReleaseNotes
    config: EvidenceGateConfig
    /** Where `release_record` would (or did) write this document. */
    notesFile: string
    /** The row already in the ledger, when the notes were regenerated from one. */
    recorded?: ReleaseRow
}): string {
    const { notes, config, notesFile, recorded } = input
    return [
        renderReleaseNotes(notes, config),
        '',
        '---',
        recorded === undefined
            ? `ℹ️ 只读预览：release_record({version:${notes.version === undefined ? '…' : `"${notes.version}"`}}) 会把以上内容写入 \`${notesFile}\`（本工具不写任何文件、不改台账）。`
            : `ℹ️ 只读：以上内容按台账里 ${recorded.version} 的记录（记录于 ${formatTime(recorded.at)}）重新生成，与 \`${recorded.notesPath ?? notesFile}\` 对应的发布说明同源；本工具不写任何文件、不改台账。`,
    ].join('\n')
}

/** The `✅` report returned by a successful `release_record`. */
export function renderReleaseRecorded(input: { row: ReleaseRow; file: string; notesFile: string }): string {
    const { row, file, notesFile } = input
    const notesPath = row.notesPath ?? notesFile
    return [
        `✅ 已记录发布 ${row.version}（mission ${row.missionIds.length} 个，回执 ${row.receiptIds.length} 个）。`,
        `- 台账行: ${file}`,
        `- 发布说明: ${notesFile}（台账里记为 ${notesPath}）`,
        `- revision: ${revisionText(row.revision)}`,
        `- tag: ${row.tag ?? '未记录（本次发布没有绑定 Git tag；台账只记录发布，打 tag 仍是 Git 侧的动作）'}`,
        `- mission: ${row.missionIds.map((id, index) => `${id}（${row.receiptIds[index] ?? '回执未记录'}）`).join('、') || '无'}`,
        ...(row.note === undefined ? [] : [`- 备注: ${row.note}`]),
        '这份发布说明由已登记工件生成（规格 / 门禁 / 证据 / 回执），不要手工改写：补记录后重新生成。',
        `下一步：把 tag 打在这一版修订上（\`git tag ${row.tag ?? row.version}\`）并推送；随时用 release_status 查看“已发布 / 交付但未发布”。`,
    ].join('\n')
}

/** The `❌` report returned by a refused `release_record`, one branch per rule. */
export function renderReleaseRefused(refusal: ReleaseRefusal): string {
    const head = `❌ 拒绝记录发布${refusal.version === undefined ? '' : ` ${refusal.version}`}：`
    switch (refusal.code) {
        case 'no-version':
            return [
                '❌ 拒绝记录发布：缺少 version。',
                '版本是发布台账的键（同一版本只能记录一次），没有它就没有可追溯的标识。',
                '  → 下一步：release_record({ version: "v1.2.0", tag: "v1.2.0" })，版本号用你的发布命名规则（可用 requireTagFormat 约束）。',
            ].join('\n')
        case 'unsafe-version':
            return [
                bar(head, `${refusal.version} 不能作为文件名/台账键`),
                '版本会被用作发布说明的文件名（<releasesDir>/<version>.md），因此必须是单个路径段：不含 "/"、"\\"、".."，不以 "." 开头，不超过 200 字符。',
                '  → 下一步：改用一个正常的版本号（例如 "v1.2.0"），不要用路径。',
            ].join('\n')
        case 'bad-tag':
            return [
                bar(head, 'tag 不是合法的 Git tag 名'),
                `tag=${JSON.stringify(refusal.tag ?? '')} 含空白/控制字符或 ".."，Git 不接受这样的引用名。`,
                '  → 下一步：改用合法 tag（如 "v1.2.0"），或省略 tag（允许记录一次没有 tag 的发布，台账会标注“未记录 tag”）。',
            ].join('\n')
        case 'bad-pattern':
            return [
                bar(head, 'requireTagFormat 配置的正则无法编译'),
                `requireTagFormat=${JSON.stringify(refusal.pattern ?? '')}：${refusal.reason ?? '无法编译'}`,
                '按 fail closed 处理：配置了版本格式却无法判定时，不记录任何版本（否则等于悄悄跳过检查）。',
                '  → 下一步：修正 profile（或项目级 .dsh/evidence-gate.json）里的 requireTagFormat，或删除该键以关闭格式校验。',
            ].join('\n')
        case 'version-format':
            return [
                bar(head, `版本不符合 requireTagFormat：${refusal.pattern ?? ''}`),
                `当前版本 ${refusal.version} 与模式 ${refusal.pattern ?? ''} 不匹配。`,
                '  → 下一步：改用符合该模式的版本号（例如 v1.2.0），或由宿主调整 requireTagFormat。',
            ].join('\n')
        case 'duplicate':
            return [
                bar(head, '该版本已在发布台账里'),
                `已有记录：${refusal.existing?.version}，记录于 ${refusal.existing === undefined ? '未记录' : formatTime(refusal.existing.at)}（revision ${revisionText(refusal.existing?.revision)}，mission ${refusal.existing?.missionIds.join('、') || '无'}）。`,
                '发布台账是 append-only 的：一个版本只记录一次，重复记录会让“v1.2.0 里有什么”有两个答案。',
                '  → 下一步：换一个版本号，或用 release_status({ version: "…" }) 查看该版本已记录的内容；确实记错了就人工修订台账文件并说明原因。',
            ].join('\n')
        case 'not-a-repo':
            return [
                bar(head, '工作区不是 git 仓库'),
                '没有 revision 的发布不是发布：版本必须指向一个可复现的代码状态（HEAD + 分支 + 工作区指纹），否则台账只是一个人名列表。',
                '  → 下一步：在 git 仓库里工作（git init 并至少提交一次），或先让工作区成为仓库再重试；本工具不会用空指纹凑一条记录。',
            ].join('\n')
        case 'empty-mission-ids':
            return [
                bar(head, 'missionIds 是空数组'),
                '一次没有任何 mission 的发布没有可追溯的内容，拒绝记录（省略 missionIds 才是“自动取上次发布以来交付的 mission”）。',
                '  → 下一步：省略 missionIds 让本工具自动选取，或列出要发布的 mission id。',
            ].join('\n')
        case 'unknown-missions':
            return [
                bar(head, `mission 不存在：${refusal.missions?.join('、') ?? ''}`),
                '发布只能包含本工作区里真实存在的 mission；拼错一个 id 就会让“v1.2.0 里有什么”缺一块。',
                '  → 下一步：用 release_status 或 evidence_status 核对 mission id 后重新调用（mission 解析不会回退到“最新的 mission”）。',
            ].join('\n')
        case 'undelivered-missions':
            return [
                bar(head, `mission 没有回执（未交付）：${refusal.missions?.join('、') ?? ''}`),
                '发布是“已交付的工作”：把这些 mission 记进版本，等于声称它们被交付过而没有回执。',
                '  → 下一步：先交付它们（evidence_record → quality_gate_run → mission_complete，拿到回执），再重新调用 release_record；或先把它们从 missionIds 里去掉。',
            ].join('\n')
        case 'nothing-to-release':
            return [
                bar(head, '自上次发布以来没有新的交付'),
                '默认的 mission 集合是“回执晚于上一条发布记录的 mission”，当前为空——可能是确实没有新交付，也可能是回执与上一条发布记录落在同一毫秒（本工具按“严格晚于”判定）。',
                '  → 下一步：看 release_status 的“交付但未发布”清单；确实要记录一个空版本没有意义，要发布就显式传 missionIds（必须都已交付）。',
            ].join('\n')
        case 'write-failed':
            return [
                bar(head, '写入发布台账 / 发布说明失败'),
                `底层错误：${refusal.reason ?? '未知错误'}。台账行没有追加（不会留下指向不存在文档的记录）。`,
                '  → 下一步：检查 <layout.rootDir>/releases.jsonl 与 <releasesDir> 的写权限后重试。',
            ].join('\n')
    }
}

/** `head + what`, kept as one line for every refusal branch. */
function bar(head: string, what: string): string {
    return `${head}${what}。`
}

/** The `release_notes` report when there is nothing to build notes from. */
export function renderReleaseNotesEmpty(input: { version?: string; known: readonly string[] }): string {
    return [
        `❌ 没有可生成发布说明的 mission${input.version === undefined ? '' : `（version=${input.version}）`}。`,
        input.version === undefined
            ? '既没有显式传 missionIds，也没有“自上次发布以来交付的 mission”。'
            : `台账里没有 ${input.version} 这条发布记录，也没有显式传 missionIds。`,
        ...(input.known.length === 0 ? [] : [`台账里已记录的版本：${input.known.join('、')}。`]),
        '  → 下一步：先交付 mission（mission_complete 会签发回执），再 release_notes({ version: "v1.2.0" }) 预览；或显式传 missionIds 预览指定 mission。',
    ].join('\n')
}

/** The `release_status` report. */
export function renderReleaseStatus(input: {
    /** Absolute path of the ledger. */
    file: string
    /** Workspace root the view belongs to. */
    cwd: string
    releases: readonly ReleaseRow[]
    unreleased: readonly ReleaseMission[]
    /** Newest receipt id per delivered mission, in delivery order. */
    delivered: readonly ReleaseMission[]
    /** Lines of the ledger that did not parse (a truncated tail). */
    unreadable: number
    /** The version the caller asked about, when they named one. */
    focus?: ReleaseRow
}): string {
    const { file, cwd, releases, unreleased, delivered, unreadable, focus } = input
    const newestReceipt = (entry: ReleaseMission): Receipt | undefined =>
        [...entry.receipts].sort((left, right) => right.issuedAt - left.issuedAt)[0]
    const lines = [`## 发布台账（工作区 ${cwd}）`, `台账: ${file}（已记录 ${releases.length} 次发布）`]
    if (unreadable > 0) {
        lines.push(`⚠️ 台账里有 ${unreadable} 行无法解析（崩溃留下的截断行是预期情况），已忽略这些行——它们不影响其余记录。`)
    }
    if (focus !== undefined) {
        lines.push(
            '',
            `本次查看: ${focus.version}`,
            `- 记录于: ${formatTime(focus.at)}${focus.recordedBy === undefined ? '' : ` by ${focus.recordedBy}`}`,
            `- tag: ${focus.tag ?? '未记录（这次发布没有绑定 Git tag）'}`,
            `- revision: ${revisionText(focus.revision)}`,
            `- mission（${focus.missionIds.length}）: ${focus.missionIds.join('、') || '无'}`,
            `- 回执（${focus.receiptIds.length}）: ${focus.receiptIds.join('、') || '无'}`,
            `- 发布说明: ${focus.notesPath ?? '未记录'}${focus.notesPath === undefined ? '' : `（${fs.existsSync(path.join(cwd, focus.notesPath)) ? '存在' : '文件已不在'}）`}`,
            ...(focus.note === undefined ? [] : [`- 备注: ${focus.note}`]),
        )
    }
    lines.push('', '已记录的发布（最新在前）:')
    if (releases.length === 0) {
        lines.push('- 无')
    } else {
        for (const row of releases) {
            lines.push(
                `- ${row.version} — ${formatTime(row.at)}，revision ${revisionText(row.revision)}，mission ${row.missionIds.length} 个（${row.missionIds.join('、') || '无'}）${row.tag === undefined ? '，未记录 tag' : `，tag ${row.tag}`}`,
            )
        }
    }
    lines.push('', `交付但未发布（这就是“我准备发什么”）（${unreleased.length} 个）:`)
    if (unreleased.length === 0) {
        lines.push('- 无')
    } else {
        for (const entry of unreleased) {
            const receipt = newestReceipt(entry)
            lines.push(
                `- ${entry.mission.id} ${entry.mission.title} — 最新回执 ${receipt?.id ?? '无'}${receipt === undefined ? '' : ` @ ${formatTime(receipt.issuedAt)}`}（证据 ${receipt?.evidenceIds.length ?? 0} 条）`,
            )
        }
    }
    lines.push('', '每个已交付 mission 的最新回执:')
    if (delivered.length === 0) {
        lines.push('- 无（还没有任何 mission 拿到回执）')
    } else {
        for (const entry of delivered) {
            const receipt = newestReceipt(entry)
            lines.push(`- ${entry.mission.id} → ${receipt?.id ?? '无'}${receipt === undefined ? '' : ` @ ${formatTime(receipt.issuedAt)}`}`)
        }
    }
    lines.push(
        '',
        unreleased.length === 0
            ? '下一步：没有待发布的交付；交付新 mission 后 release_status 会把它们列在“交付但未发布”里。'
            : `下一步：release_notes({ version: "…" }) 预览发布说明，确认无误后 release_record({ version: "…", tag: "…" }) 记录版本（记录本身就是把回执与版本、tag 绑起来的那一步）。`,
    )
    return lines.join('\n')
}

/** The `release_status` refusal when the caller named an unknown version. */
export function renderReleaseStatusUnknown(version: string, releases: readonly ReleaseRow[]): string {
    return [
        `❌ 发布台账里没有 ${version}。`,
        releases.length === 0
            ? '台账里还没有任何发布记录（<layout.rootDir>/releases.jsonl 不存在或为空）。'
            : `已记录的版本：${releases.map((row) => row.version).join('、')}。`,
        '  → 下一步：省略 version 看全部发布与“交付但未发布”清单；要记录新版本用 release_record({ version: "…" })。',
    ].join('\n')
}

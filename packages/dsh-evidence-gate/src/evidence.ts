/**
 * Evidence capture: turning one tool call into a durable, fingerprint-bound
 * ledger row (docs.md §3.5 "Evidence 包括：验证命令的执行输出、Git diff 的
 * 摘要指纹、测试报告").
 *
 * Every capture is bound to the Git state observed at recording time, because
 * an output digest without a workspace fingerprint cannot answer the only
 * question a receipt has to answer: *which* state was verified.
 *
 * @module dsh-evidence-gate/evidence
 */

import {
    describeFingerprint,
    formatTime,
    gitDiffSummary,
    gitFingerprint,
    sha256,
    tail,
    type EvidenceKind,
    type EvidenceRecord,
    type GitFingerprint,
    type JsonValue,
} from 'dsh-eng-core'
import { RECORDABLE_KINDS } from './config.js'

/** Raw arguments of `evidence_record` (defensively re-validated in code). */
export interface EvidenceArgs {
    missionId?: string
    kind?: string
    summary?: string
    command?: string
    exitCode?: number
    output?: string
    artifactPath?: string
    note?: string
}

/** A validated, fingerprint-bound capture, ready to append to the ledger. */
export interface EvidenceCapture {
    kind: EvidenceKind
    summary: string
    command?: string
    exitCode?: number | null
    outputDigest: string
    outputTail?: string
    git: GitFingerprint
    artifactPath?: string
    data?: JsonValue
    /** `git diff --stat` text captured for `kind: 'diff'`. */
    diffSummary?: string
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
    return typeof value === 'string' && (RECORDABLE_KINDS as readonly string[]).includes(value)
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate the arguments and capture the workspace state.
 * @param args - the tool arguments (untrusted; the model wrote them).
 * @param options - workspace root and the configured output tail cap.
 * @returns the capture; the caller appends it with `store.appendEvidence`.
 * @throws when the arguments cannot produce credible evidence (fail closed).
 */
export function captureEvidence(
    args: EvidenceArgs,
    options: { cwd: string; maxOutputTail: number },
): EvidenceCapture {
    if (!isEvidenceKind(args.kind)) {
        throw new Error(
            `证据类型非法（kind=${String(args.kind)}）：只能是 ${RECORDABLE_KINDS.join(' / ')}（\`gate\` 由质量门禁写入，不接受手工登记）。`,
        )
    }
    const kind = args.kind
    const summary = optionalText(args.summary)
    if (summary === undefined) throw new Error('缺少 summary：每条证据都需要一句可读的说明。')
    const note = optionalText(args.note)
    if (kind === 'manual' && note === undefined) {
        throw new Error(
            'kind=manual 必须提供 note：手工声明必须带可读依据（谁/何时/凭什么认为成立），否则无法审计。',
        )
    }
    if (args.exitCode !== undefined && !Number.isInteger(args.exitCode)) {
        throw new Error(`exitCode 必须是整数（收到 ${String(args.exitCode)}）。`)
    }
    const output = typeof args.output === 'string' ? args.output : undefined
    const git = gitFingerprint(options.cwd)
    const data: Record<string, JsonValue> = {}
    if (note !== undefined) data['note'] = note
    let diffSummary: string | undefined
    if (kind === 'diff') {
        // `gitDiffSummary` is captured "additionally (or instead)" of output:
        // the diff stat is the human-readable half of the fingerprint.
        diffSummary = gitDiffSummary(options.cwd)
        data['diffSummary'] = diffSummary
        if (output === undefined) data['source'] = 'gitDiffSummary'
    }
    return {
        kind,
        summary,
        git,
        // The digest always exists: with no output it is the digest of "" and
        // means "this row carries no captured output".
        outputDigest: sha256(output ?? ''),
        ...(args.command === undefined ? {} : { command: args.command }),
        ...(args.exitCode === undefined ? {} : { exitCode: args.exitCode }),
        ...(output === undefined ? {} : { outputTail: tail(output, options.maxOutputTail) }),
        ...(args.artifactPath === undefined ? {} : { artifactPath: args.artifactPath }),
        ...(Object.keys(data).length === 0 ? {} : { data }),
        ...(diffSummary === undefined ? {} : { diffSummary }),
    }
}

/** `sha256('')`: the digest of a row that captured no output at all. */
export const EMPTY_DIGEST = sha256('')

/**
 * Why one ledger row cannot *satisfy* a required evidence kind, or `undefined`
 * when it can.
 *
 * Presence is not success: `evidence_record` deliberately keeps accepting a
 * failed run (it is informative), but a delivery may only count a
 * `command`/`test` row that really succeeded — `exitCode === 0`, a recorded
 * command line and non-empty captured output. A `manual` claim never counts,
 * whatever the configuration asks for.
 * @param row - one ledger row.
 * @returns the Chinese reason, or `undefined` when the row qualifies.
 */
export function evidenceShortfall(row: EvidenceRecord): string | undefined {
    if (row.kind === 'manual') return '是 manual 声明（人工声明不能作为必填证据）'
    if (row.kind === 'command' || row.kind === 'test') {
        if (row.exitCode !== 0) {
            return row.exitCode === undefined || row.exitCode === null
                ? '没有记录 exitCode'
                : `记录了 exitCode=${row.exitCode}`
        }
        if (typeof row.command !== 'string' || row.command.trim() === '') return '没有记录 command'
        if (row.outputDigest === undefined || row.outputDigest === EMPTY_DIGEST) {
            return '没有捕获输出（outputDigest 为空）'
        }
    }
    return undefined
}

/** One-line description of an evidence row, used by every report. */
export function describeEvidence(record: EvidenceRecord): string {
    const digest = record.outputDigest === undefined ? 'digest n/a' : `digest ${record.outputDigest.slice(0, 16)}…`
    return `${record.id} [${record.kind}] ${record.summary} — ${digest} · git ${describeFingerprint(record.git)} · ${formatTime(record.recordedAt)}`
}

/**
 * The Chinese confirmation returned by `evidence_record`.
 * @param record - the appended row.
 * @param missionId - mission the row belongs to.
 * @param diffSummary - captured diff stat, for `kind: 'diff'`.
 */
export function confirmationText(record: EvidenceRecord, missionId: string, diffSummary?: string): string {
    const shortfall = evidenceShortfall(record)
    return [
        `已记录证据 ${record.id}（kind=${record.kind}）：${record.summary}`,
        `mission: ${missionId}`,
        `git 指纹: ${describeFingerprint(record.git)}`,
        `输出摘要: ${(record.outputDigest ?? EMPTY_DIGEST).slice(0, 16)}…${
            record.outputTail === undefined ? '（本条未提供 output）' : `（tail ${record.outputTail.length} 字符）`
        }`,
        ...(diffSummary === undefined ? [] : ['git diff 摘要:', diffSummary]),
        // A recorded failure is useful history, never proof: say so at the
        // moment it is written instead of at delivery time.
        ...(shortfall === undefined
            ? []
            : [`注意：这条 ${record.kind} 证据${shortfall}，不会计入交付检查表（保留作参考）。`]),
        '下一步：记完证据后运行 quality_gate_run，让门禁覆盖最新证据，再调用 mission_complete。',
    ].join('\n')
}

/**
 * The fail-closed delivery pipeline: `Mission → Evidence → Quality Gate →
 * Receipt` (docs.md §3.5).
 *
 * Everything here is a verdict, never an exception: a delivery either satisfies
 * every check, or it is refused with a concrete Chinese reason and the exact
 * next tool call. The receipt is issued only on the deterministic `PASS` path,
 * and only once — `MissionStore#issueReceipt` writes it with `writeOnce`.
 *
 * @module dsh-evidence-gate/delivery
 */

import {
    describeFingerprint,
    formatTime,
    gitFingerprint,
    type EvidenceRecord,
    type GateRecord,
    type GitFingerprint,
    type JsonValue,
    type MissionRecord,
    type MissionStore,
    type Receipt,
} from 'dsh-eng-core'
import type { EvidenceGateConfig } from './config.js'
import { evidenceShortfall } from './evidence.js'

/** The issuer recorded on receipts and override rows (equals the plugin name). */
export const ISSUER = 'dsh-evidence-gate'

/** One fail-closed delivery check. */
export interface DeliveryCheck {
    /**
     * Stable id (`mission-state`, `spec`, `gate`, `gate-state`, `gate-scope`,
     * `gate-results`, `gate-ledger`, `gate-stale`, `gate-age`,
     * `required-kinds`, `clean-tree`).
     */
    id: string
    ok: boolean
    /** The rule, in Chinese. */
    label: string
    /** What was actually observed, in Chinese. */
    detail: string
    /** The exact next tool call that repairs a failed check. */
    fix?: string
    /**
     * The check passed but could not actually be verified (today: a non-git
     * workspace has no fingerprint to compare). It never blocks delivery, but
     * every report renders it as `⚠️` and names it as an unverified item — a
     * receipt may never *imply* a verification that did not happen.
     */
    unverified?: boolean
}

/** The evaluated state of one mission's delivery. */
export interface DeliveryEvaluation {
    mission: MissionRecord
    checks: DeliveryCheck[]
    failures: DeliveryCheck[]
    /** Every check passed (before any `force` relaxation). */
    ok: boolean
    evidence: EvidenceRecord[]
    /** The newest gate from `config.gateSource`, when one exists. */
    gate?: GateRecord
    /** Evidence kinds the ledger does not carry yet. */
    missingKinds: string[]
    /** The newest `command`/`test` evidence (the proof the gate must cover). */
    newestProof?: EvidenceRecord
    /** Captured at evaluation time (used by `requireCleanTree`). */
    fingerprint: GitFingerprint
}

/** Result of applying `force` to a failed evaluation. */
export interface ForceRelaxation {
    /** Checks that still block delivery. */
    failures: DeliveryCheck[]
    /** Chinese note to record as a `manual` evidence row when the override is used. */
    overrideNote?: string
    /** Labels of the checks `force` is explicitly not allowed to bypass. */
    refused: string[]
}

/** What `finalizeDelivery` produced. */
export interface DeliveryOutcome {
    receipt: Receipt
    evidenceIds: string[]
    gate?: GateRecord
    overrideNote?: string
}

function newestOf(rows: readonly EvidenceRecord[]): EvidenceRecord | undefined {
    let newest: EvidenceRecord | undefined
    for (const row of rows) {
        if (newest === undefined || row.recordedAt > newest.recordedAt) newest = row
    }
    return newest
}

/** `data.gateId` of a `kind: 'gate'` ledger row, when it carries one. */
function gateIdOf(row: EvidenceRecord): string | undefined {
    const data = row.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
    const id = (data as Record<string, JsonValue>)['gateId']
    return typeof id === 'string' && id !== '' ? id : undefined
}

/** One ledger row the checklist refused to count, with the reason (Chinese). */
interface ProofRejection {
    row: EvidenceRecord
    reason: string
}

/**
 * Whether one ledger row may *satisfy* a required evidence kind.
 *
 * Presence is not success: see {@link evidenceShortfall} for the exact bar a
 * `command`/`test` row has to clear and why a `manual` claim never counts.
 * @param row - one ledger row.
 * @returns `{ok: true}`, or `{ok: false, reason}` naming exactly what is wrong.
 */
function proofVerdict(row: EvidenceRecord): { ok: true } | { ok: false; reason: string } {
    const reason = evidenceShortfall(row)
    return reason === undefined ? { ok: true } : { ok: false, reason }
}

/**
 * Evaluate every delivery rule against one mission.
 * @param input - store, mission, config, workspace and clock.
 * @returns the checks (ordered: mission state → spec → gate → evidence kinds →
 *   tree) plus the observed gate/evidence facts the reports render.
 */
export function evaluateDelivery(input: {
    store: MissionStore
    mission: MissionRecord
    config: EvidenceGateConfig
    cwd: string
    now?: number
}): DeliveryEvaluation {
    const { store, mission, config, cwd } = input
    const now = input.now ?? Date.now()
    const checks: DeliveryCheck[] = []
    const evidence = store.readEvidence(mission.id)
    // The engineering trail (`.dsh`) changes on every tool call, so it is
    // excluded from both sides of the comparison: a receipt must bind the
    // *code* state the gate observed, never the bookkeeping of the gate itself.
    const fingerprint = gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })

    // 0. A blocked mission is a circuit breaker: no receipt may be issued.
    const blocked = mission.status === 'blocked'
    checks.push({
        id: 'mission-state',
        ok: !blocked,
        label: 'mission 未被熔断阻断（status ≠ blocked）',
        detail: blocked
            ? 'mission 处于 blocked（熔断）状态：交付通道已关闭，先解除阻断或新建 mission，再交付'
            : `mission 状态为 ${mission.status}`,
        fix: 'orchestrate（查看并解除阻断），或 spec_create（新建 mission 重新走流程）',
    })

    // 1. The specification must be approved.
    const spec = mission.spec
    const approvedAt = spec?.approvedAt
    const approved = spec !== undefined && approvedAt !== undefined
    checks.push({
        id: 'spec',
        ok: approved,
        label: '规格已审批（spec.approvedAt 存在）',
        detail:
            spec !== undefined && approvedAt !== undefined
                ? `spec rev ${spec.revision}，${formatTime(approvedAt)} 由 ${spec.approvedBy ?? 'unknown'} 审批`
                : 'mission 没有已审批的规格（未创建，或改写后审批已失效）',
        fix: 'spec_create → spec_approve',
    })

    // 1b. Code standards — a SEPARATE axis from "the commands passed".
    //     Structural debt does not fail a build, yet it is what makes a codebase
    //     unmaintainable, so a host that adopted standards can require a PASS
    //     from this round of the code. Opt-in, and refused when the plugin is not
    //     even mounted rather than silently satisfied.
    const standardsGate = store.lastGate(mission.id, { source: config.standardsGateSource })
    if (config.requireStandardsGate) {
        // Freshness is measured against the newest COMMAND/TEST evidence — the
        // same baseline the quality gate uses. Two details are deliberate:
        //  * gate ledger rows are excluded: every gate writes a `kind: gate`
        //    evidence row whose timestamp is a hair LATER than the gate record, so
        //    counting them made every standards gate look stale by a millisecond;
        //  * a same-millisecond tie counts as stale (fail closed), matching
        //    `gate-stale`: a verdict that cannot be shown to cover the evidence
        //    must not be trusted to cover it.
        const codeProofs = evidence.filter((row) => row.kind === 'command' || row.kind === 'test')
        const newestProofAt = codeProofs.reduce((newest, row) => (row.recordedAt > newest ? row.recordedAt : newest), 0)
        const hasProof = codeProofs.length > 0
        const fresh =
            standardsGate !== undefined && (!hasProof || standardsGate.checkedAt > newestProofAt)
        // Forgery: a gate RECORD is not evidence. The quality gate has always
        // required a `kind: 'gate'` ledger row with a matching `data.gateId`, so a
        // hand-written `gates/GATE-….json` is refused. An audit showed the
        // standards axis accepted exactly that trick, so it gets the same check.
        const standardsRow =
            standardsGate === undefined ? undefined : evidence.find((row) => row.kind === 'gate' && gateIdOf(row) === standardsGate.id)
        const forged = standardsGate !== undefined && standardsRow === undefined
        checks.push({
            id: 'standards',
            ok: standardsGate?.state === 'PASS' && fresh && !forged,
            label: `规范门禁 PASS（source=${config.standardsGateSource}，且晚于最新改动）`,
            detail:
                forged
                    ? `gates/${standardsGate?.id}.json 在证据台账里没有对应的 gate 证据行（data.gateId=${standardsGate?.id}）：手工写入的 gates/*.json 视为伪造，拒绝交付`
                    : standardsGate === undefined
                    ? `没有任何来自 ${config.standardsGateSource} 的门禁记录：调用 standards_check`
                    : standardsGate.state !== 'PASS'
                      ? `${standardsGate.id} 是 ${standardsGate.state}：${standardsGate.reason}`
                      : !fresh
                        ? standardsGate.checkedAt === newestProofAt
                          ? `${standardsGate.id} 与最新 command/test 证据记录在同一毫秒（${formatTime(newestProofAt)}）：无法证明它覆盖了该证据，按陈旧处理（fail closed）`
                          : `${standardsGate.id} PASS 于 ${formatTime(standardsGate.checkedAt)}，早于最新证据（${formatTime(newestProofAt)}）：这是上一轮代码的结论`
                        : `${standardsGate.id} PASS @ ${formatTime(standardsGate.checkedAt)}`,
            fix: 'standards_check',
        })
    }

    // 2. The quality gate: exists, is a PASS, is complete, is genuine, is not
    //    stale, is not too old.
    const gate = store.lastGate(mission.id, { source: config.gateSource })
    const proofs = evidence.filter((row) => row.kind === 'command' || row.kind === 'test')
    const newestProof = newestOf(proofs)
    if (gate === undefined) {
        checks.push({
            id: 'gate',
            ok: !config.requireGate,
            label: config.requireGate
                ? `质量门禁已运行（source=${config.gateSource}）`
                : '质量门禁（requireGate=false：不校验，仍展示最新记录）',
            detail: config.requireGate
                ? `没有任何来自 ${config.gateSource} 的门禁记录：没有确定性裁决就没有交付依据`
                : `没有来自 ${config.gateSource} 的门禁记录（宿主已声明不要求门禁）`,
            fix: 'quality_gate_run',
        })
    } else {
        checks.push({
            id: 'gate',
            ok: true,
            label: `质量门禁已运行（source=${config.gateSource}）`,
            detail: `${gate.id} @ ${formatTime(gate.checkedAt)}（${gate.results.length} 条命令）`,
            fix: 'quality_gate_run',
        })
        const passed = gate.state === 'PASS'
        if (config.requireGate) {
            checks.push({
                id: 'gate-state',
                ok: passed,
                label: '门禁裁决为 PASS（WARN/BLOCK 不放行）',
                detail: `最新裁决 ${gate.state}：${gate.reason}`,
                fix: 'quality_gate_run（修复后重跑，直到 PASS）',
            })
        }
        // The three integrity checks apply whenever a gate exists: the receipt
        // cites it as the verdict it depends on, so a partial or hand-written
        // gate may never authorize a delivery.
        const scope = gate.scope
        const scopeFull = scope !== undefined && scope.full === true
        let scopeDetail: string
        if (scope === undefined) {
            scopeDetail =
                '门禁只覆盖了部分命令（scope.full=false），请重跑完整门禁（该记录没有 scope 字段，旧记录一律不视为“完整覆盖”）'
        } else if (scopeFull) {
            scopeDetail = `门禁执行了全部 ${scope.total} 条宿主命令（${scope.selected.join(', ') || '—'}）`
        } else {
            scopeDetail = `门禁只覆盖了部分命令（scope.full=false），请重跑完整门禁（已执行 ${scope.selected.length}/${scope.total} 条：${scope.selected.join(', ') || '无'}）`
        }
        checks.push({
            id: 'gate-scope',
            ok: scopeFull,
            label: '门禁覆盖了全部宿主命令（gate.scope.full=true）',
            detail: scopeDetail,
            fix: 'quality_gate_run（不加命令过滤，跑完整门禁）',
        })
        checks.push({
            id: 'gate-results',
            ok: gate.results.length > 0,
            label: '门禁真的执行了命令（gate.results.length > 0）',
            detail:
                gate.results.length > 0
                    ? `${gate.results.length} 条命令：${gate.results.map((result) => `${result.id}=${result.exitCode ?? 'null'}`).join(', ')}`
                    : '门禁裁决 PASS 但 results 为空：没有验证任何命令的 PASS 不是证据',
            fix: 'quality_gate_run',
        })
        const gateRow = evidence.find((row) => row.kind === 'gate' && gateIdOf(row) === gate.id)
        checks.push({
            id: 'gate-ledger',
            ok: gateRow !== undefined,
            label: '门禁裁决在证据台账中有对应记录（kind=gate 且 data.gateId 匹配）',
            detail:
                gateRow === undefined
                    ? `gates/${gate.id}.json 在证据台账里没有对应的 gate 证据行（data.gateId=${gate.id}）：手工写入的 gates/*.json 没有质量门禁的落盘记录，视为伪造，拒绝交付`
                    : `台账行 ${gateRow.id} 对应 ${gate.id}（${gateRow.recordedBy} @ ${formatTime(gateRow.recordedAt)}）`,
            fix: 'quality_gate_run（让质量门禁自己写裁决记录，不要手工写 gates/*.json）',
        })
        if (config.requireGate) {
            // `<=`: a gate recorded in the *same millisecond* as the newest
            // proof cannot be shown to have covered it, so the tie is stale
            // (fail closed). A strict `<` would let it look fresh.
            const tie = newestProof !== undefined && gate.checkedAt === newestProof.recordedAt
            const stale = newestProof !== undefined && gate.checkedAt <= newestProof.recordedAt
            checks.push({
                id: 'gate-stale',
                ok: !stale,
                label: '门禁不早于最新 command/test 证据（门禁覆盖当前证据）',
                detail:
                    newestProof === undefined
                        ? '还没有 command/test 证据，门禁之后没有出现新证据'
                        : tie
                          ? `门禁与最新证据 ${newestProof.id} 记录在同一毫秒（${formatTime(newestProof.recordedAt)}）：无法证明门禁覆盖了该证据，按陈旧处理（fail closed）`
                          : stale
                            ? `门禁 ${formatTime(gate.checkedAt)} 早于最新证据 ${newestProof.id}（${formatTime(newestProof.recordedAt)}）：证据不确定，门禁裁决不再覆盖它`
                            : `门禁 ${formatTime(gate.checkedAt)} 晚于最新证据 ${newestProof.id}（${formatTime(newestProof.recordedAt)}）`,
                fix: 'quality_gate_run（重跑门禁，使其覆盖最新证据）',
            })
            if (config.maxGateAgeMinutes > 0) {
                const ageMs = now - gate.checkedAt
                const limitMs = config.maxGateAgeMinutes * 60_000
                const tooOld = ageMs > limitMs
                checks.push({
                    id: 'gate-age',
                    ok: !tooOld,
                    label: `门禁年龄未超过 ${config.maxGateAgeMinutes} 分钟（maxGateAgeMinutes）`,
                    detail: `门禁运行于 ${formatTime(gate.checkedAt)}（${Math.round(ageMs / 60_000)} 分钟前）`,
                    fix: 'quality_gate_run',
                })
            }
        }
    }

    // 3. Every configured evidence kind must be satisfied by a *successful* row.
    const usableKinds: string[] = []
    const rejections: ProofRejection[] = []
    for (const row of evidence) {
        const verdict = proofVerdict(row)
        if (verdict.ok) {
            if (!usableKinds.includes(row.kind)) usableKinds.push(row.kind)
        } else {
            rejections.push({ row, reason: verdict.reason })
        }
    }
    const missingKinds = config.requiredEvidenceKinds.filter(
        (kind) => !evidence.some((row) => row.kind === kind && proofVerdict(row).ok),
    )
    const offenders = rejections.filter((entry) => config.requiredEvidenceKinds.includes(entry.row.kind))
    const offenderText = offenders.map((entry) => `${entry.row.id} ${entry.reason}`).join('；')
    checks.push({
        id: 'required-kinds',
        ok: missingKinds.length === 0,
        label: `必填证据类型齐全（${config.requiredEvidenceKinds.join(', ') || '未配置'}）`,
        detail:
            missingKinds.length === 0
                ? `台账已有可用证据：${usableKinds.join(', ') || '无'}${
                      rejections.length === 0
                          ? ''
                          : `（另有 ${rejections.length} 条不合格行未计入：${rejections.map((entry) => `${entry.row.id} ${entry.reason}`).join('；')}）`
                  }`
                : `缺少 ${missingKinds.join(', ')}（可用：${usableKinds.join(', ') || '无'}）${
                      offenderText === '' ? '' : `；不合格的台账行：${offenderText}`
                  }`,
        ...(missingKinds.length === 0
            ? {}
            : { fix: `evidence_record（kind=${missingKinds[0]}，需 command + exitCode=0 + 真实输出）` }),
    })

    // 4. The tree must still be the one the gate observed.
    if (config.requireCleanTree) {
        if (gate === undefined) {
            // Nothing was observed, so there is nothing to compare: the missing
            // gate (or `requireGate=false`) already decides this delivery. Be
            // explicit rather than implying a verification that never happened.
            checks.push({
                id: 'clean-tree',
                ok: true,
                unverified: true,
                label: '工作区与门禁观测时的指纹一致（requireCleanTree=true）',
                detail: '无法核对（没有门禁记录可比对）：本次交付不绑定任何门禁观测的工作区状态',
                fix: 'quality_gate_run（先跑门禁，交付才能绑定它观测到的工作区状态）',
            })
        } else {
            const verdict = compareTree(fingerprint, gate.fingerprint)
            checks.push({
                id: 'clean-tree',
                ok: verdict.ok,
                ...(verdict.unverified === true ? { unverified: true } : {}),
                label: '工作区与门禁观测时的指纹一致（requireCleanTree=true）',
                detail: verdict.detail,
                fix: 'quality_gate_run（清理/提交工作区后重跑门禁）',
            })
        }
    }

    const failures = checks.filter((check) => !check.ok)
    return {
        mission,
        checks,
        failures,
        ok: failures.length === 0,
        evidence,
        ...(gate === undefined ? {} : { gate }),
        missingKinds,
        ...(newestProof === undefined ? {} : { newestProof }),
        fingerprint,
    }
}

/**
 * Whether the current tree is dirtier (or simply different) than the observed one.
 * @returns `ok: false` when the tree changed, `unverified: true` when both
 *   sides are not git repositories (the delivery proceeds, but nothing was
 *   actually compared).
 */
function compareTree(
    current: GitFingerprint,
    observed: GitFingerprint | undefined,
): { ok: boolean; unverified?: boolean; detail: string } {
    if (observed === undefined) {
        return {
            ok: false,
            detail: '门禁记录没有工作区指纹，无法验证工作区是否变更（fail closed）',
        }
    }
    if (!observed.isRepo && !current.isRepo) {
        return {
            ok: true,
            unverified: true,
            detail:
                '无法核对（非 git 工作区）：门禁与当前工作区都不是 git 仓库，本次交付只核对了证据台账与门禁，未核对工作区指纹',
        }
    }
    if (observed.isRepo !== current.isRepo) {
        return {
            ok: false,
            detail: `工作区类型已变化：门禁观测 ${describeFingerprint(observed)}，当前 ${describeFingerprint(current)}`,
        }
    }
    const dirtier = current.changedFiles > observed.changedFiles || current.diffDigest !== observed.diffDigest
    return {
        ok: !dirtier,
        detail: dirtier
            ? `当前 ${describeFingerprint(current)} ≠ 门禁观测 ${describeFingerprint(observed)}`
            : `当前 ${describeFingerprint(current)} 与门禁观测一致`,
    }
}

/**
 * Apply the documented `force` semantics: it downgrades *only* the required
 * evidence kinds check and never the gate, the specification or staleness.
 * @param evaluation - the evaluated delivery.
 * @param force - the tool argument.
 * @returns the failures that still block, plus the note to record when the
 *   override is honoured.
 */
export function relaxForForce(evaluation: DeliveryEvaluation, force: boolean): ForceRelaxation {
    if (!force) return { failures: evaluation.failures, refused: [] }
    const relaxed = evaluation.failures.filter((check) => check.id === 'required-kinds')
    const fatal = evaluation.failures.filter((check) => check.id !== 'required-kinds')
    if (fatal.length > 0) {
        return { failures: evaluation.failures, refused: fatal.map((check) => check.label) }
    }
    if (relaxed.length === 0) {
        return {
            failures: [],
            refused: [],
            overrideNote: 'force=true 已声明人工覆盖，但所有检查均已通过（未放松任何检查）。',
        }
    }
    return {
        failures: [],
        refused: [],
        overrideNote: `force=true 放松了"必填证据类型"检查：缺少 ${evaluation.missingKinds.join(', ')}；规格审批与质量门禁仍然通过。`,
    }
}

/**
 * Issue the receipt, mark the mission delivered, and (when `force` was used)
 * leave a `manual` evidence row explaining the override first, so the receipt
 * binds the override as well.
 * @throws never — `store.issueReceipt` is write-once and idempotent per path.
 */
export function finalizeDelivery(input: {
    store: MissionStore
    mission: MissionRecord
    evaluation: DeliveryEvaluation
    /** Human decision that authorised the delivery, when one was required. */
    approval?: { by: string; source: string; messageId: string }
    /** Workspace root the evaluation ran in (the receipt uses its fingerprint). */
    cwd: string
    overrideNote?: string
}): DeliveryOutcome {
    const { store, mission, evaluation, overrideNote, approval } = input
    if (overrideNote !== undefined) {
        store.appendEvidence(mission.id, {
            kind: 'manual',
            summary: `交付覆盖（force）：${overrideNote}`,
            recordedBy: ISSUER,
            ...(evaluation.gate?.fingerprint === undefined ? {} : { git: evaluation.gate.fingerprint }),
            data: {
                note: overrideNote,
                override: true,
                missingKinds: evaluation.missingKinds,
                gateId: evaluation.gate?.id ?? null,
            },
        })
    }
    const evidenceIds = store.readEvidence(mission.id).map((row) => row.id)
    // The receipt binds the fingerprint the gate observed (what was verified);
    // a workspace without a gate observation binds the (trail-excluded)
    // fingerprint captured at evaluation time, and a non-git workspace has no
    // fingerprint to bind at all.
    const git = evaluation.gate?.fingerprint ?? evaluation.fingerprint
    const receipt = store.issueReceipt(mission.id, {
        issuedBy: ISSUER,
        gateId: evaluation.gate?.id ?? '(no-gate)',
        evidenceIds,
        git,
        ...(mission.specDigest === undefined ? {} : { specDigest: mission.specDigest }),
        ...(approval === undefined ? {} : { approval }),
    })
    store.setStatus(mission.id, 'delivered')
    return {
        receipt,
        evidenceIds,
        ...(evaluation.gate === undefined ? {} : { gate: evaluation.gate }),
        ...(overrideNote === undefined ? {} : { overrideNote }),
        ...(approval === undefined ? {} : { approval }),
    }
}

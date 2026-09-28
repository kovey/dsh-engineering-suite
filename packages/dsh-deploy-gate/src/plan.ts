/**
 * The go/no-go evaluation: a PURE function over facts somebody else gathered.
 *
 * Everything this module decides is a function of its input — no filesystem, no
 * clock, no git, no plugin context — so a test can drive every branch (including
 * the ones that are hard to reach in a real workspace: a stale gate, a receipt
 * bound to another revision, a pending question, an environment with no rollback
 * path) without touching the machine.
 *
 * The question it answers is deliberately narrow: **may this revision be
 * deployed to this environment, given what the suite already recorded?** It does
 * NOT re-run tests, does not re-read the diff and does not trust anything it was
 * not handed. "Delivery is the missing phase" is only solved if the deployment
 * verdict is a function of the delivery evidence, and this is that function.
 *
 * @module dsh-deploy-gate/plan
 */

import {
    describeFingerprint,
    formatTime,
    type EvidenceRecord,
    type GateRecord,
    type GitFingerprint,
    type MissionStatus,
    type Receipt,
} from 'dsh-eng-core'
import type { DeployGateConfig, EnvironmentConfig } from './config.js'

/** The `source` every quality-gate record carries (`dsh-quality-gate`). */
export const QUALITY_GATE_SOURCE = 'dsh-quality-gate'

/** Structural view of the mission: what the verdict needs, nothing more. */
export interface MissionLike {
    id: string
    status: MissionStatus
    title?: string
}

/** One question a human has not answered yet. */
export interface PendingAsk {
    title: string
    /** How long it has been waiting (ms), when the channel reported it. */
    ageMs?: number
}

/** One fail-closed go/no-go check. */
export interface PlanCheck {
    /** Stable id (`mission`, `receipt`, `gate-state`, `clean-tree`, …). */
    id: string
    ok: boolean
    /** The rule, in Chinese. */
    label: string
    /** What was actually observed, in Chinese. */
    detail: string
    /** The exact next step that repairs a failed check. */
    fix?: string
    /**
     * The check passed but nothing was actually verified (a non-git workspace, a
     * host that opted out, a channel that could not be queried). It never blocks,
     * but every report renders it as `⚠️` — a deployment may never *imply* a
     * verification that did not happen.
     */
    unverified?: boolean
}

/** Everything the verdict reads. Injected, so the function stays pure. */
export interface GoNoGoInput {
    /** The mission the deployment belongs to (`undefined` = nothing to deploy). */
    mission: MissionLike | undefined
    /** The newest delivery receipt, when the mission has one. */
    receipt?: Receipt
    /** The newest `dsh-quality-gate` record of the mission. */
    newestGate?: GateRecord
    /** When the newest `command`/`test` evidence was recorded (`undefined` = none). */
    newestEvidenceAt?: number
    /** Questions still waiting for a human. */
    pendingAsks: readonly PendingAsk[]
    /**
     * Whether those asks could actually be queried (`ctx.get('interaction')`).
     * `false` turns the pending-asks check into an explicit "unverified" pass
     * instead of a silent one.
     */
    pendingAsksQueryable?: boolean
    /** The workspace state observed right now. */
    fingerprint: GitFingerprint
    /** The effective configuration (only `goNoGo` is read). */
    config: DeployGateConfig
    /** The environment that would be deployed to. */
    environment: EnvironmentConfig
    /** The clock, injected. */
    now: number
}

/** The verdict plus every check behind it. */
export interface GoNoGoResult {
    ok: boolean
    checks: PlanCheck[]
    /** The checks that block (a subset of `checks`, in order). */
    failures: PlanCheck[]
}

/** The newest receipt of a mission (greatest `issuedAt`, tie-broken by id). */
export function newestReceipt(receipts: readonly Receipt[]): Receipt | undefined {
    return [...receipts].sort((left, right) => left.issuedAt - right.issuedAt || left.id.localeCompare(right.id)).at(-1)
}

/**
 * When the newest `command`/`test` evidence was recorded.
 *
 * `gate` ledger rows are deliberately excluded: every gate writes one whose
 * timestamp is a hair later than the gate record itself, so counting them would
 * make every gate look stale against itself (the rule `dsh-evidence-gate` and
 * `dsh-standards-gate` already follow).
 */
export function newestEvidenceAt(evidence: readonly EvidenceRecord[]): number | undefined {
    let newest: number | undefined
    for (const row of evidence) {
        if (row.kind !== 'command' && row.kind !== 'test') continue
        if (newest === undefined || row.recordedAt > newest) newest = row.recordedAt
    }
    return newest
}

/**
 * Whether the receipt was issued for the workspace state we are about to deploy.
 *
 * Content is what matters: the diff digest must match, and a HEAD that moved is a
 * different revision even when the diff happens to look the same. A receipt with
 * no fingerprint at all cannot be shown to bind anything, so it fails closed.
 */
export function compareRevision(
    observed: GitFingerprint | undefined,
    current: GitFingerprint,
): { ok: boolean; unverified?: boolean; detail: string } {
    if (observed === undefined) {
        return { ok: false, detail: '回执没有记录工作区指纹（git 字段缺失）：无法证明它绑定的就是当前这个 revision（fail closed）' }
    }
    if (!observed.isRepo && !current.isRepo) {
        return {
            ok: true,
            unverified: true,
            detail: '无法核对（非 git 工作区）：回执与当前工作区都不是 git 仓库，本次部署没有 revision 可以绑定',
        }
    }
    if (observed.isRepo !== current.isRepo) {
        return {
            ok: false,
            detail: `工作区类型已变化：回执记录 ${describeFingerprint(observed)}，当前 ${describeFingerprint(current)}`,
        }
    }
    if (observed.diffDigest !== current.diffDigest) {
        return {
            ok: false,
            detail: `工作区内容与回执不一致：回执记录 ${describeFingerprint(observed)}，当前 ${describeFingerprint(current)}`,
        }
    }
    if (observed.head !== undefined && current.head !== undefined && observed.head !== current.head) {
        return {
            ok: false,
            detail: `HEAD 已移动：回执记录 ${observed.head.slice(0, 8)}，当前 ${current.head.slice(0, 8)}（内容一致但 revision 变了）`,
        }
    }
    return { ok: true, detail: `回执绑定的工作区与当前一致（${describeFingerprint(current)}）` }
}

/** Render a list of blocking checks for a refusal message. */
export function describeFailures(failures: readonly PlanCheck[], limit = 6): string {
    const shown = failures.slice(0, limit).map((check) => `- ${check.label}：${check.detail}${check.fix === undefined ? '' : `（下一步：${check.fix}）`}`)
    if (failures.length > limit) shown.push(`- …另有 ${failures.length - limit} 项未列出`)
    return shown.join('\n')
}

/**
 * Evaluate every go/no-go rule.
 * @param input - mission, receipt, gate, evidence time, asks, fingerprint, config, environment, clock.
 * @returns the checks (ordered: mission → receipt → gate → asks → tree → environment)
 *   and whether they all pass.
 */
export function evaluateGoNoGo(input: GoNoGoInput): GoNoGoResult {
    const { mission, receipt, newestGate, newestEvidenceAt: proofAt, pendingAsks, fingerprint, environment, now } = input
    const { goNoGo } = input.config
    const checks: PlanCheck[] = []

    // --- 1. There must be a delivered mission ------------------------------
    const blocked = mission?.status === 'blocked'
    checks.push({
        id: 'mission',
        ok: mission !== undefined && !blocked,
        label: 'mission 存在且未被熔断（status ≠ blocked）',
        detail:
            mission === undefined
                ? '本会话没有绑定任何 mission：部署必须有归属，否则这次上线不属于任何一次交付'
                : blocked
                  ? `mission ${mission.id} 处于 blocked（熔断）状态：先解除阻断，再谈部署`
                  : `mission ${mission.id}（${mission.status}${mission.title === undefined ? '' : `：${mission.title}`}）`,
        fix: 'spec_create（建立 mission 并走完交付），或 orchestrate（解除熔断）',
    })

    checks.push({
        id: 'mission-delivered',
        ok: mission?.status === 'delivered',
        label: 'mission 已交付（status = delivered）',
        detail:
            mission === undefined
                ? '没有 mission（见上一条）'
                : mission.status === 'delivered'
                  ? 'mission 已走完交付'
                  : `当前状态 ${mission.status}：交付还没闭环的改动不进入部署`,
        fix: 'mission_complete（交付并签发回执后再部署）',
    })

    // --- 2. The delivery receipt, and the revision it binds ----------------
    if (receipt === undefined) {
        checks.push({
            id: 'receipt',
            ok: !goNoGo.requireReceipt,
            ...(goNoGo.requireReceipt ? {} : { unverified: true }),
            label: goNoGo.requireReceipt ? '存在交付回执（receipts/RCP-*.json）' : '交付回执（宿主声明不要求：goNoGo.requireReceipt=false）',
            detail: goNoGo.requireReceipt
                ? 'mission 上没有交付回执：没有回执就没有"被批准交付的那个东西"，部署无从谈起'
                : '没有回执（宿主已声明不要求）：本次部署不绑定任何交付回执',
            fix: 'mission_complete',
        })
    } else {
        checks.push({
            id: 'receipt',
            ok: true,
            label: '存在交付回执（receipts/RCP-*.json）',
            detail: `${receipt.id} @ ${formatTime(receipt.issuedAt)} 由 ${receipt.issuedBy} 签发（依赖门禁 ${receipt.gateId}，证据 ${receipt.evidenceIds.length} 条）`,
            fix: 'mission_complete',
        })
        const verdict = compareRevision(receipt.git, fingerprint)
        const optedOut = !goNoGo.requireReceipt && !verdict.ok
        checks.push({
            id: 'receipt-revision',
            // The opt-out is explicit and visible: it never silently turns a
            // mismatch into a pass without saying so in the report.
            ok: verdict.ok || !goNoGo.requireReceipt,
            ...(optedOut || verdict.unverified === true ? { unverified: true } : {}),
            label: '回执绑定的 revision 与当前工作区一致',
            detail: optedOut
                ? `宿主声明不要求回执（goNoGo.requireReceipt=false）：${verdict.detail}——已如实报告，未阻断`
                : verdict.detail,
            fix: 'mission_complete（在当前这个提交上重新交付，让回执绑定这个 revision）',
        })
    }

    // --- 3. The quality gate: present, PASS, fresh, young enough -----------
    if (newestGate === undefined) {
        checks.push({
            id: 'gate',
            ok: false,
            label: `存在质量门禁记录（source=${QUALITY_GATE_SOURCE}）`,
            detail: 'mission 上没有任何质量门禁记录：没有确定性裁决就没有部署依据（新鲜度与年龄检查因此无法评估）',
            fix: 'quality_gate_run',
        })
    } else {
        checks.push({
            id: 'gate',
            ok: true,
            label: `存在质量门禁记录（source=${QUALITY_GATE_SOURCE}）`,
            detail: `${newestGate.id} @ ${formatTime(newestGate.checkedAt)}（${newestGate.results.length} 条命令，scope.full=${newestGate.scope?.full === true ? 'true' : 'false'})`,
            fix: 'quality_gate_run',
        })
        checks.push({
            id: 'gate-state',
            ok: newestGate.state === 'PASS',
            label: '质量门禁裁决为 PASS（WARN/BLOCK 不放行）',
            detail: `最新裁决 ${newestGate.state}：${newestGate.reason}`,
            fix: 'quality_gate_run（修复后重跑，直到 PASS）',
        })
        if (goNoGo.requireGateNewerThanEvidence) {
            // `<=` on purpose: a gate recorded in the SAME millisecond as the
            // newest proof cannot be shown to have covered it, so the tie counts
            // as stale (fail closed) — the same rule the delivery checklist uses.
            const tie = proofAt !== undefined && newestGate.checkedAt === proofAt
            const stale = proofAt !== undefined && newestGate.checkedAt <= proofAt
            checks.push({
                id: 'gate-newer-than-evidence',
                ok: !stale,
                label: '质量门禁不早于最新 command/test 证据（门禁覆盖当前证据）',
                detail:
                    proofAt === undefined
                        ? '还没有 command/test 证据，门禁之后没有出现新证据'
                        : tie
                          ? `门禁与最新证据记录在同一毫秒（${formatTime(proofAt)}）：无法证明门禁覆盖了该证据，按陈旧处理（fail closed）`
                          : stale
                            ? `门禁 ${formatTime(newestGate.checkedAt)} 早于最新证据（${formatTime(proofAt)}）：门禁裁决不再覆盖它`
                            : `门禁 ${formatTime(newestGate.checkedAt)} 晚于最新证据（${formatTime(proofAt)}）`,
                fix: 'quality_gate_run（重跑门禁，使其覆盖最新证据）',
            })
        }
        if (goNoGo.maxGateAgeMinutes > 0) {
            const ageMs = now - newestGate.checkedAt
            const limitMs = goNoGo.maxGateAgeMinutes * 60_000
            checks.push({
                id: 'gate-age',
                ok: ageMs <= limitMs,
                label: `质量门禁年龄未超过 ${goNoGo.maxGateAgeMinutes} 分钟（goNoGo.maxGateAgeMinutes）`,
                detail: `门禁运行于 ${formatTime(newestGate.checkedAt)}（${Math.round(ageMs / 60_000)} 分钟前）`,
                fix: 'quality_gate_run',
            })
        }
    }

    // --- 4. Nobody is still waiting to answer a question -------------------
    if (goNoGo.requireNoPendingAsks) {
        const queryable = input.pendingAsksQueryable !== false
        const waiting = pendingAsks.length === 0 ? '' : pendingAsks
            .slice(0, 5)
            .map((ask) => `${ask.title}${ask.ageMs === undefined ? '' : `（已等 ${Math.round(ask.ageMs / 60_000)} 分钟）`}`)
            .join('；')
        checks.push({
            id: 'asks',
            ok: pendingAsks.length === 0,
            ...(queryable ? {} : { unverified: true }),
            label: '没有等待人工回答的提问（goNoGo.requireNoPendingAsks）',
            detail:
                pendingAsks.length > 0
                    ? `有 ${pendingAsks.length} 个提问还在等人回答：${waiting}`
                    : queryable
                      ? '没有挂起的提问'
                      : '没有可查询的交互服务（未装配 interaction）：本项无法核对，标为未校验（不是"确认没有提问"）',
            fix: 'interaction_status（先回答或撤掉这些提问，再部署）',
        })
    }

    // --- 5. The tree must be the revision that will be shipped -------------
    if (goNoGo.requireCleanTree) {
        const inRepo = fingerprint.isRepo
        checks.push({
            id: 'clean-tree',
            ok: !inRepo || fingerprint.changedFiles === 0,
            ...(inRepo ? {} : { unverified: true }),
            label: '工作区没有未提交的改动（工程台账 .dsh/** 不计入）',
            detail: !inRepo
                ? '非 git 工作区：没有 revision 可以绑定，也没有未提交改动可言（未校验）'
                : fingerprint.changedFiles === 0
                  ? `工作区干净（${describeFingerprint(fingerprint)}）`
                  : `${fingerprint.changedFiles} 个文件未提交：${describeFingerprint(fingerprint)}（部署必须对应一个可追溯的 revision，而不是某台机器上的临时改动）`,
            fix: 'git commit（提交并让门禁/交付覆盖这个提交）',
        })
    }

    // --- 6. The environment must actually describe a release ---------------
    const deployCommands = environment.deployCommands.length
    checks.push({
        id: 'environment-deploy-commands',
        ok: deployCommands > 0,
        label: '环境声明了部署命令（deployCommands）',
        detail:
            deployCommands > 0
                ? `${deployCommands} 条部署命令（按配置顺序执行，argv 直传、不经 shell）`
                : `环境 "${environment.name}" 没有声明任何部署命令：没有步骤可执行的"部署"不是部署（fail closed）`,
        fix: `在 profile 或 .dsh/deploy-gate.json 里为环境 "${environment.name}" 声明 deployCommands（例如 ["bash scripts/deploy.sh"]）`,
    })
    const verifyCommands = environment.verifyCommands?.length ?? 0
    checks.push({
        id: 'environment-verify-commands',
        ok: verifyCommands > 0,
        label: '环境声明了部署后验证命令（verifyCommands）',
        detail:
            verifyCommands > 0
                ? `${verifyCommands} 条验证命令（deploy_verify 会在部署后执行，并带有限次重试）`
                : `环境 "${environment.name}" 没有声明验证命令：部署完不看结果的部署只能靠人回忆，本插件不接受这种"完成"`,
        fix: `为该环境声明 verifyCommands（例如 ["bash scripts/healthcheck.sh"]）`,
    })
    const rollbackCommands = environment.rollbackCommands?.length ?? 0
    checks.push({
        id: 'environment-rollback-commands',
        ok: rollbackCommands > 0,
        label: '环境声明了回滚命令（rollbackCommands）——未演练的回滚不是回滚',
        detail:
            rollbackCommands > 0
                ? `${rollbackCommands} 条回滚命令（deploy_rollback 会执行它们）`
                : `环境 "${environment.name}" 没有声明回滚命令：出事时只能现场想办法。本插件拒绝在没有回滚路径的情况下把这次部署判为"可以上"`,
        fix: `为该环境声明 rollbackCommands（例如 ["bash scripts/rollback.sh"]），并至少演练一次`,
    })

    const failures = checks.filter((check) => !check.ok)
    return { ok: failures.length === 0, checks, failures }
}

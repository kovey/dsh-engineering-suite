/**
 * `runtime.im-approval` — can an approval actually be DECIDED over IM?
 *
 * Since P1 the suite can answer the HOST's `approval/request` seam over IM
 * (`dsh-interaction-gate`'s `im.approvalVia`). Three keys decide whether that
 * path can produce a decision at all, and all three are host-owned (a repository
 * cannot change them):
 *
 *  - `im.approvalVia` — `off` (default) / `fallback` / `only`;
 *  - `im.approvalChatId` — the ONE conversation a card may go to;
 *  - the approver list — the `from` whitelist an answer must belong to. The
 *    approval path requires it even when the host did not make it mandatory,
 *    because an approval grants a permission.
 *
 * A deployment that turns the seam on and forgets one of the two data keys looks
 * hardened and refuses every approval (fail closed, by design). That is not a
 * bug to discover in a run — it is a configuration state a self-check can name,
 * with the two ways forward: configure it, or go back to `off` (the host seam).
 *
 * What this check does NOT do, on purpose:
 *
 *  - it does not probe the IM plugin's `chatKind` capability. No API declares
 *    it, so a "probe" would be an invented truth; the `im.p2pOnly` risk is
 *    reported as **advice** (`recommended`), naming the consequence and the two
 *    deliberate options;
 *  - it does not warn about the default. `off` (and a process with no
 *    `interaction` service, where the mode cannot take effect) is reported as
 *    `ok` with one sentence — the default deployment must not be nagged.
 *
 * Two sources, each for what it can know:
 *
 *  - the live `interaction` service's `im()` report carries the host-owned keys
 *    (`approvalVia` / `approvalChatId` / `p2pOnly`) — no repository file can
 *    contain them, and no probe of a repository could see them;
 *  - the approver-list file is repository knowledge (`approversFile` is a
 *    project-overridable key), so it is read from `<rootDir>/interaction-gate.json`
 *    the same way the gate resolves it, with the gate's own default path.
 *
 * @module dsh-suite-doctor/im-approval
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig, type DoctorCheck, type Layout } from 'dsh-eng-core'

/** Every accepted value of `im.approvalVia`, most conservative first. */
export const APPROVAL_VIA_MODES = ['off', 'fallback', 'only'] as const

/** The mode of the host approval seam (`im.approvalVia`). */
export type ApprovalVia = (typeof APPROVAL_VIA_MODES)[number]

/** The approver-list path `dsh-interaction-gate` defaults to (relative to the workspace). */
export const DEFAULT_APPROVERS_FILE = '.dsh/interaction-approvers.txt'

/** The id the required check is reported under. */
export const IM_APPROVAL_CHECK_ID = 'runtime.im-approval'

/** The id of the ADVISORY check about `im.p2pOnly` and an upstream without `chatKind`. */
export const IM_APPROVAL_P2P_CHECK_ID = 'runtime.im-approval-p2p'

/** One approver list, as the gate would read it. */
export interface ApproverListFact {
    /** The absolute path inspected (always stated: a missing file must not be hidden). */
    file: string
    present: boolean
    /** Usable ids: non-empty, non-comment lines, deduplicated — the gate's own rule. */
    count: number
}

/** Everything the check judges (built by `probe.ts` from the service report + the project file). */
export interface ImApprovalFact {
    /** Whether this process mounts the `interaction` service at all. */
    service: boolean
    /**
     * The reported `im.approvalVia`.
     *
     * `undefined` = the service does not report it (an older build). That is
     * `unknown`, never `off`: "we could not read the mode" and "the mode is off"
     * are different facts.
     */
    mode?: ApprovalVia
    /** The configured approval conversation; `''`/absent = not configured. */
    target?: string
    /** `im.p2pOnly` (the gate's fail-closed default is `true`). */
    p2pOnly?: boolean
    /** Why the mode could not be read (a probe failure / an older service), when known. */
    modeProblem?: string
    /** The approver list (`from` whitelist) as found on disk. */
    approvers: ApproverListFact
}

/** A chat id shown whole only when it is too short to be an identity leak. */
export function maskTarget(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

/**
 * Read the approver list the same way `dsh-interaction-gate` does.
 *
 * `approversFile` is one of the keys a repository may refine, so the project
 * overlay is consulted first and the gate's default is used otherwise. A
 * PROFILE that relocated the key cannot be seen from here — the report therefore
 * always names the file it actually inspected, and the fix points at
 * `interaction_status`, which resolves the effective path.
 * @param layout - the workspace layout (the file is resolved relative to `cwd`, like the gate).
 * @returns the path, whether it exists, and how many usable ids it holds.
 */
export function approverListOf(layout: Layout): ApproverListFact {
    const overlay = loadProjectConfig<Record<string, unknown>>(layout, 'interaction-gate')
    const declared = overlay.value?.['approversFile']
    const relative = typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : DEFAULT_APPROVERS_FILE
    const file = path.isAbsolute(relative) ? relative : path.resolve(layout.cwd, relative)
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return { file, present: false, count: 0 }
    }
    const ids = new Set<string>()
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        ids.add(trimmed)
    }
    return { file, present: true, count: ids.size }
}

/**
 * The `im.approvalVia` labels the report uses.
 * @param mode - the effective mode.
 */
function modeLabel(mode: ApprovalVia): string {
    return `im.approvalVia=${mode}`
}

/**
 * Judge the IM approval path and return its checks.
 *
 * Exactly one of these shapes comes back:
 *
 *  - no `interaction` service (or a service that does not report the mode) →
 *    one `ok`/`unknown` check, never a warning (the default eleven do not ship
 *    the interaction gate);
 *  - `off` → one `ok` check stating that approvals still go through the host
 *    seam (TUI), with NO advice item: the default deployment is not nagged;
 *  - `fallback`/`only` → the required check (`ok` when the target and a
 *    non-empty approver list are both present, `missing` naming every missing
 *    piece otherwise) plus, when `im.p2pOnly` is on (the default), one
 *    `recommended` advice item about `chatKind` — advice because the upstream's
 *    capability cannot be determined from any API.
 * @param fact - the facts read from the service and the workspace.
 * @returns the checks (1 or 2), in report order.
 */
export function imApprovalChecks(fact: ImApprovalFact): DoctorCheck[] {
    const label = 'IM 审批可用性'

    if (!fact.service) {
        return [
            {
                id: IM_APPROVAL_CHECK_ID,
                area: 'interact',
                state: 'ok',
                severity: 'required',
                label: `${label}（无 interaction 服务）`,
                detail:
                    '审批仍走宿主接缝（TUI）：本进程没有 interaction 服务，im.approvalVia 无从生效（等价于 off）' +
                    '——默认十一件里没有它，这不是故障',
            },
        ]
    }
    if (fact.mode === undefined) {
        return [
            {
                id: IM_APPROVAL_CHECK_ID,
                area: 'interact',
                state: 'unknown',
                severity: 'recommended',
                label: `${label}（读不到 im.approvalVia）`,
                detail:
                    'interaction 服务没有报告审批模式（im() 里没有 approvalVia）：无法判断宿主把 approval/request 交给了谁' +
                    '——**读不到不等于 off**，也不等于"审批不会走 IM"' +
                    (fact.modeProblem === undefined ? '' : `（原因：${fact.modeProblem}）`),
                fix: '升级 dsh-interaction-gate 到会报告 im.approvalVia 的版本后重新 suite_status；当前生效值仍可在 interaction_status 的「IM 审批应答者」一行看到',
            },
        ]
    }

    const mode = fact.mode
    if (mode === 'off') {
        return [
            {
                id: IM_APPROVAL_CHECK_ID,
                area: 'interact',
                state: 'ok',
                severity: 'required',
                label: `${label}（${modeLabel(mode)}）`,
                detail:
                    '审批仍走宿主接缝（TUI）：im.approvalVia=off（默认，本插件没有注册 approval/request 监听器），' +
                    '审批不在 IM 上做决定——默认部署不需要任何 IM 审批配置',
            },
        ]
    }

    const target = fact.target ?? ''
    const problems: string[] = []
    if (target === '') {
        problems.push(
            '没有配置审批目标 im.approvalChatId：审批提问在发卡之前就会被拒绝（refused:no-target），' +
                '这个部署会以为审批在手机上，实际一次决定也做不出来',
        )
    }
    if (fact.approvers.count === 0) {
        problems.push(
            `审批人名单为空或不可读（${fact.approvers.file}，存在=${fact.approvers.present}）：` +
                '审批是权限，所以名单为空时连卡片都不发（refused:approvers-missing），每次审批都会在发问之前被拒绝',
        )
    }
    const labelWithMode = `${label}（${modeLabel(mode)}）`
    if (problems.length > 0) {
        // The fix names ONLY what is actually missing: a target that is already
        // configured must not be "fixed" again, and an empty list must point at
        // its file. The `off` alternative is always the second way out.
        const repairs: string[] = []
        if (target === '') {
            repairs.push(
                '由宿主在 profile 的 dsh-interaction-gate 配置里补上 im.approvalChatId（你与 bot 私聊的那个会话 id）',
            )
        }
        if (fact.approvers.count === 0) {
            repairs.push(`由人把审批人的 id 写进 ${fact.approvers.file}（每行一个，# 开头是注释）`)
        }
        return [
            {
                id: IM_APPROVAL_CHECK_ID,
                area: 'interact',
                state: 'missing',
                severity: 'required',
                label: labelWithMode,
                detail: `审批接缝配了走 IM（${modeLabel(mode)}），但还没配齐：${problems.map((problem, index) => `${index + 1}) ${problem}`).join('；')}`,
                fix:
                    `两条路，二选一（别停在"配了一半"）：① ${repairs.join('；并')}；` +
                    '② 把 im.approvalVia 设回 off，让审批继续走宿主接缝（TUI）。这些键是宿主/仓库配置，模型改不了；' +
                    'interaction_status 的「IM 审批目标」「审批人名单」两行显示生效值',
            },
        ]
    }

    const checks: DoctorCheck[] = [
        {
            id: IM_APPROVAL_CHECK_ID,
            area: 'interact',
            state: 'ok',
            severity: 'required',
            label: labelWithMode,
            detail:
                `审批接缝走 IM（${modeLabel(mode)}）：目标会话已配置（${maskTarget(target)}）；` +
                `审批人名单 ${fact.approvers.count} 个 id（${fact.approvers.file}）`,
        },
    ]
    if (fact.p2pOnly !== false) {
        checks.push({
            id: IM_APPROVAL_P2P_CHECK_ID,
            area: 'interact',
            state: 'partial',
            severity: 'recommended',
            label: 'IM 审批的会话类型要求（im.p2pOnly=true）',
            detail:
                'im.p2pOnly=true 要求每个审批答案都被证明来自私聊（chatKind=p2p），而上游插件是否报告 chatKind ' +
                '**无法从任何 API 判定**：如果它不报，**每一次** IM 审批回答都会被当成"未证明"拒绝（refused:not-p2p），' +
                '审批会全部超时——没有人被错误地放行，但也没有人能做决定',
            fix:
                '先确认这个 IM 插件确实在答案里报告 chatKind（interaction_status 的「IM 被忽略的回答尝试」与拒绝原因会写明 not-p2p）；' +
                '它不报就二选一：把 im.p2pOnly 设为 false（接受"会话类型未证明"，卡片仍锁在 im.approvalChatId 里），' +
                '或保持 im.approvalVia=off（审批留在宿主接缝）。这是**建议**：自检探测不到上游能力，不能把它写成通过',
        })
    }
    return checks
}

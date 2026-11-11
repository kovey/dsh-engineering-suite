/**
 * `runtime.im-approval` — can an approval actually be DECIDED over IM?
 *
 * Since P1 the suite can answer the HOST's `approval/request` seam over IM
 * (`dsh-interaction-gate`'s `im.approvalVia`). Four things decide whether that
 * path can produce a decision at all, and all four are host-owned (a repository
 * cannot change them):
 *
 *  - `im.approvalVia` — `off` (default) / `fallback` / `only`;
 *  - `im.approvalChatId` — the ONE conversation a card may go to;
 *  - the approver list — the `from` whitelist an answer must belong to. The
 *    approval path requires it even when the host did not make it mandatory,
 *    because an approval grants a permission;
 *  - since P3.1, WHERE that list lives: the host (`im.approvers` /
 *    `im.approversFile`, default `~/.dsh/interaction-approvers.txt`). The old
 *    repository file `<repo>/.dsh/interaction-approvers.txt` is not read by any
 *    approval path any more.
 *
 * A deployment that turns the seam on and forgets one of the data keys looks
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
 *    `ok` with one sentence — the default deployment must not be nagged;
 *  - it never answers "is there an approver list?" from a repository file. That
 *    file used to BE the list; reading it now would report a stale truth in the
 *    one case that matters (an empty host list next to a committed repository
 *    file, i.e. exactly the deployment that will refuse every approval).
 *
 * Sources, each for what it can know:
 *
 *  - the live `interaction` service's `im()` report carries the host-owned keys
 *    (`approvalVia` / `approvalChatId` / `p2pOnly`) AND the host-side approver
 *    facts (`approvers`) — no repository file can contain them, and no probe of
 *    a repository could see them;
 *  - the repository is read for ONE thing only: whether a legacy list file (or a
 *    project `approversFile`) still exists, so the migration is stated instead of
 *    leaving a repository that believes its list still decides approvals.
 *
 * The vocabulary (check ids, host-owned keys, the fact types) lives in
 * `im-approval-contract.ts` and is re-exported here, so callers keep importing
 * from this module.
 *
 * @module dsh-suite-doctor/im-approval
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig, type DoctorCheck, type Layout } from 'dsh-eng-core'
import {
    HOST_APPROVERS_FILE,
    IM_APPROVAL_CHECK_ID,
    IM_APPROVAL_LEGACY_CHECK_ID,
    IM_APPROVAL_P2P_CHECK_ID,
    LEGACY_APPROVERS_FILE,
    maskTarget,
    modeLabel,
    type ApprovalVia,
    type ImApprovalFact,
    type LegacyApproverFact,
} from './im-approval-contract.js'
import { workspaceMappingCheckOf } from './im-approval-workspace.js'

export {
    APPROVAL_VIA_MODES,
    HOST_APPROVERS_FILE,
    IM_APPROVAL_CHECK_ID,
    IM_APPROVAL_LEGACY_CHECK_ID,
    IM_APPROVAL_P2P_CHECK_ID,
    IM_APPROVAL_WORKSPACE_CHECK_ID,
    LEGACY_APPROVERS_FILE,
    maskTarget,
} from './im-approval-contract.js'
export type { ApprovalVia, HostApproverFact, ImApprovalFact, LegacyApproverFact, WorkspaceMappingFact } from './im-approval-contract.js'

/** Count the usable ids of one approver file (non-empty, non-comment lines, deduplicated). */
function countIds(file: string): { present: boolean; count: number } {
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return { present: false, count: 0 }
    }
    const ids = new Set<string>()
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        ids.add(trimmed)
    }
    return { present: true, count: ids.size }
}

/**
 * Read the legacy repository list — for the MIGRATION message only.
 *
 * P3.1 moved the approver list to the host, so this file decides nothing. It is
 * still counted, because "move these N ids" is the actionable sentence an
 * operator needs; a project config that still declares `approversFile` is
 * reported too (the gate ignores that key and records a problem).
 * @param layout - the workspace layout.
 * @returns what is on disk, never what would be effective.
 */
export function legacyApproverListOf(layout: Layout): LegacyApproverFact {
    const file = path.resolve(layout.cwd, LEGACY_APPROVERS_FILE)
    const found = countIds(file)
    const fact: LegacyApproverFact = { file, present: found.present, count: found.count }
    const overlay = loadProjectConfig<Record<string, unknown>>(layout, 'interaction-gate')
    const declared = overlay.value?.['approversFile']
    if (typeof declared === 'string' && declared.trim() !== '') {
        const relative = declared.trim()
        const declaredPath = path.isAbsolute(relative) ? relative : path.resolve(layout.cwd, relative)
        fact.declaredPath = declaredPath
        fact.declaredCount = countIds(declaredPath).count
    }
    return fact
}

/**
 * The migration check: a repository list that no longer affects approvals.
 *
 * Emitted whenever the old file exists or a project file still sets
 * `approversFile` — including while the seam is `off`, because a repository that
 * believes its committed list still decides approvals is exactly the state this
 * check exists to end. `recommended`, not `required`: nothing is broken (the
 * host list may be perfectly configured); the operator needs to MOVE the ids.
 * @param legacy - what was found on disk.
 * @returns the check, or `undefined` when there is nothing to migrate.
 */
function legacyCheckOf(legacy: LegacyApproverFact): DoctorCheck | undefined {
    if (!legacy.present && legacy.declaredPath === undefined) return undefined
    const found: string[] = []
    if (legacy.present) found.push(`${legacy.file}（${legacy.count} 个 id）`)
    if (legacy.declaredPath !== undefined) {
        found.push(`项目配置里的 approversFile=${legacy.declaredPath}（${legacy.declaredCount ?? 0} 个 id，该键已忽略并记问题）`)
    }
    return {
        id: IM_APPROVAL_LEGACY_CHECK_ID,
        area: 'interact',
        state: 'partial',
        severity: 'recommended',
        label: '审批人名单迁移（仓库文件不再影响审批）',
        detail:
            `仓库里仍有旧名单：${found.join('；')}。P3.1 起审批人名单的权威在宿主，` +
            '**这些文件不再被任何审批路径读取**（否则仓库能提交自己的名单给自己发权限）；' +
            `有效名单只来自宿主：im.approvers（内联 id 数组）和/或 im.approversFile（默认 ${HOST_APPROVERS_FILE}），` +
            '项目只能通过 denyApprovers 做减法',
        fix:
            `由宿主把这些 id 搬到 im.approvers 或 ${HOST_APPROVERS_FILE}（一行一个，# 开头是注释），然后在仓库里删掉旧文件` +
            '（及项目配置里的 approversFile）；搬完用 interaction_status 核对「审批人名单」与「项目减法」两行的生效值。' +
            '仓库若还想收紧，只能用项目的 denyApprovers 做减法（有效名单 = 宿主名单 − denyApprovers），永远不能加人',
    }
}

/** The base label every IM-approval check is reported under. */
const IM_APPROVAL_LABEL = 'IM 审批可用性'

/**
 * The `ok` check for a process with no `interaction` service at all.
 * @param label - the check's base label.
 * @param migration - the migration check, when a legacy list still exists.
 * @returns the checks for this shape.
 */
function noServiceChecks(migration: DoctorCheck | undefined): DoctorCheck[] {
    return [
        {
            id: IM_APPROVAL_CHECK_ID,
            area: 'interact',
            state: 'ok',
            severity: 'required',
            label: `${IM_APPROVAL_LABEL}（无 interaction 服务）`,
            detail:
                '审批仍走宿主接缝（TUI）：本进程没有 interaction 服务，im.approvalVia 无从生效（等价于 off）' +
                '——默认十一件里没有它，这不是故障',
        },
        ...(migration === undefined ? [] : [migration]),
    ]
}

/**
 * The `unknown` check for a service that does not report `im.approvalVia`.
 * @param fact - the facts read from the service.
 * @param migration - the migration check, when a legacy list still exists.
 * @returns the checks for this shape.
 */
function unreadableModeChecks(fact: ImApprovalFact, migration: DoctorCheck | undefined): DoctorCheck[] {
    return [
        {
            id: IM_APPROVAL_CHECK_ID,
            area: 'interact',
            state: 'unknown',
            severity: 'recommended',
            label: `${IM_APPROVAL_LABEL}（读不到 im.approvalVia）`,
            detail:
                'interaction 服务没有报告审批模式（im() 里没有 approvalVia）：无法判断宿主把 approval/request 交给了谁' +
                '——**读不到不等于 off**，也不等于"审批不会走 IM"' +
                (fact.modeProblem === undefined ? '' : `（原因：${fact.modeProblem}）`),
            fix: '升级 dsh-interaction-gate 到会报告 im.approvalVia 的版本后重新 suite_status；当前生效值仍可在 interaction_status 的「IM 审批应答者」一行看到',
        },
        ...(migration === undefined ? [] : [migration]),
    ]
}

/**
 * The `ok` check for the default `off` mode (never nagged).
 * @param mode - the effective mode (`off`).
 * @param migration - the migration check, when a legacy list still exists.
 * @returns the checks for this shape.
 */
function offModeChecks(mode: ApprovalVia, migration: DoctorCheck | undefined): DoctorCheck[] {
    return [
        {
            id: IM_APPROVAL_CHECK_ID,
            area: 'interact',
            state: 'ok',
            severity: 'required',
            label: `${IM_APPROVAL_LABEL}（${modeLabel(mode)}）`,
            detail:
                '审批仍走宿主接缝（TUI）：im.approvalVia=off（默认，本插件没有注册 approval/request 监听器），' +
                '审批不在 IM 上做决定——默认部署不需要任何 IM 审批配置',
        },
        ...(migration === undefined ? [] : [migration]),
    ]
}

/**
 * Everything missing on a seam that is configured to go over IM.
 *
 * P3.2: a matched `im.approvals` entry that DECLARES `approvers` is this
 * workspace's whitelist, so an empty HOST list is not a failure here — the gate
 * would not refuse, and reporting it as missing would be a false alarm that
 * pushes an operator to configure a list nothing reads.
 * @param fact - the facts read from the service and the workspace.
 * @param target - the configured approval conversation (`''` = none).
 * @param mappedApprovers - ids the matched entry declares (0 = falls back to host).
 * @returns one sentence per missing piece.
 */
function problemsOf(fact: ImApprovalFact, target: string, mappedApprovers: number): string[] {
    const problems: string[] = []
    if (target === '') {
        problems.push(
            '没有配置审批目标 im.approvalChatId：审批提问在发卡之前就会被拒绝（refused:no-target），' +
                '这个部署会以为审批在手机上，实际一次决定也做不出来',
        )
    }
    if (fact.approvers.count === undefined) {
        problems.push(
            'interaction 服务没有报告宿主审批人名单（im() 里没有 approvers）：**读不到不等于名单为空**，' +
                '升级 dsh-interaction-gate 后在 interaction_status 的「审批人名单」一行核对生效值',
        )
    } else if (fact.approvers.count === 0 && mappedApprovers === 0) {
        problems.push(
            `宿主审批人名单为空（im.approvers ${fact.approvers.inline ?? 0} 个内联 id + ${
                fact.approvers.file === undefined || fact.approvers.file === ''
                    ? 'im.approversFile 路径不可用'
                    : `${fact.approvers.file}（存在=${fact.approvers.filePresent === true}，${fact.approvers.fileCount ?? 0} 个 id）`
            }）：审批是权限，所以名单为空时连卡片都不发（refused:approvers-missing），每次审批都会在发问之前被拒绝；` +
                `仓库里的 ${LEGACY_APPROVERS_FILE} 不会被当作回退`,
        )
    }
    return problems
}

/**
 * The repairs for the missing pieces — naming ONLY what is actually absent.
 *
 * A target that is already configured must not be "fixed" again, and an empty
 * list must point at the HOST-side keys.
 * @param fact - the facts read from the service and the workspace.
 * @param target - the configured approval conversation (`''` = none).
 * @param mappedApprovers - ids the matched entry declares (0 = falls back to host).
 * @returns the repair sentences, joined by the caller.
 */
function repairsOf(fact: ImApprovalFact, target: string, mappedApprovers: number): string[] {
    const repairs: string[] = []
    if (target === '') {
        repairs.push('由宿主在 profile 的 dsh-interaction-gate 配置里补上 im.approvalChatId（你与 bot 私聊的那个会话 id）')
    }
    if (fact.approvers.count === 0 && mappedApprovers === 0) {
        repairs.push(
            `由宿主配置 im.approvers（内联 id 数组）或 im.approversFile（默认 ${HOST_APPROVERS_FILE}，一行一个 id，# 开头是注释）` +
                `——仓库里的 ${LEGACY_APPROVERS_FILE} 不再被读取`,
        )
    } else if (fact.approvers.count === undefined) {
        repairs.push('升级 dsh-interaction-gate 让它报告宿主审批人名单，然后在 interaction_status 里核对')
    }
    return repairs
}

/**
 * The `missing` check for a seam that is on but not configured all the way.
 * @param fact - the facts read from the service and the workspace.
 * @param target - the configured approval conversation (`''` = none).
 * @param mappedApprovers - ids the matched entry declares (0 = falls back to host).
 * @param problems - what `problemsOf` found.
 * @param mode - the effective mode (named in the detail).
 * @returns the required check naming every missing piece and both ways out.
 */
function missingCheckOf(
    fact: ImApprovalFact,
    target: string,
    mappedApprovers: number,
    problems: readonly string[],
    mode: ApprovalVia,
): DoctorCheck {
    const repairs = repairsOf(fact, target, mappedApprovers)
    return {
        id: IM_APPROVAL_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: `${IM_APPROVAL_LABEL}（${modeLabel(mode)}）`,
        detail: `审批接缝配了走 IM（${modeLabel(mode)}），但还没配齐：${problems.map((problem, index) => `${index + 1}) ${problem}`).join('；')}`,
        fix:
            `两条路，二选一（别停在"配了一半"）：① ${repairs.join('；并')}；` +
            '② 把 im.approvalVia 设回 off，让审批继续走宿主接缝（TUI）。这些键是宿主配置，模型和仓库都改不了；' +
            'interaction_status 的「IM 审批目标」「审批人名单」「项目减法」三行显示生效值',
    }
}

/**
 * The `ok` check for a fully configured IM approval seam.
 * @param fact - the facts read from the service and the workspace.
 * @param target - the configured approval conversation.
 * @param mappedApprovers - ids the matched entry declares (0 = falls back to host).
 * @param mode - the effective mode (named in the detail).
 * @returns the required `ok` check.
 */
function okCheckOf(fact: ImApprovalFact, target: string, mappedApprovers: number, mode: ApprovalVia): DoctorCheck {
    const hostCount = fact.approvers.count ?? 0
    const sources: string[] = []
    if ((fact.approvers.inline ?? 0) > 0) sources.push(`im.approvers ${fact.approvers.inline} 个内联 id`)
    if (fact.approvers.file !== undefined && fact.approvers.file !== '') {
        sources.push(`im.approversFile=${fact.approvers.file}（存在=${fact.approvers.filePresent === true}，${fact.approvers.fileCount ?? 0} 个 id）`)
    }
    const mappedEntry = fact.mapping?.matched
    const denyNote =
        (fact.approvers.deny ?? 0) > 0
            ? `；宿主 denyApprovers ${fact.approvers.deny} 个会先减去，项目还能再减（有效名单见 interaction_status 的「项目减法」一行）`
            : ''
    const mappedNote =
        mappedApprovers > 0
            ? `；这个工作区命中的 im.approvals[${mappedEntry?.index ?? '?'}] 声明了自己的 approvers（${mappedApprovers} 个 id），` +
              '宿主名单在该工作区不参与（denyApprovers 仍会先减）'
            : ''
    return {
        id: IM_APPROVAL_CHECK_ID,
        area: 'interact',
        state: 'ok',
        severity: 'required',
        label: `${IM_APPROVAL_LABEL}（${modeLabel(mode)}）`,
        detail:
            `审批接缝走 IM（${modeLabel(mode)}）：目标会话已配置（${maskTarget(target)}）；` +
            `宿主审批人名单 ${hostCount} 个 id（${sources.join(' + ') || `im.approversFile=${HOST_APPROVERS_FILE}`}）` +
            denyNote +
            mappedNote,
    }
}

/**
 * The ADVISORY check about `im.p2pOnly` and an upstream that may not report
 * `chatKind`: advice because no API declares that capability.
 * @returns the `partial` (recommended) advice item.
 */
function p2pAdviceCheck(): DoctorCheck {
    return {
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
    }
}

/**
 * The checks for a seam that is on (`fallback` / `only`).
 * @param fact - the facts read from the service and the workspace.
 * @param mode - the effective mode.
 * @param migration - the migration check, when a legacy list still exists.
 * @returns the checks, in report order.
 */
function configuredChecks(fact: ImApprovalFact, mode: ApprovalVia, migration: DoctorCheck | undefined): DoctorCheck[] {
    const workspaceCheck = workspaceMappingCheckOf(mode, fact.mapping ?? {})
    const target = fact.target ?? ''
    // P3.2: an entry that DECLARES `approvers` replaces the host list here.
    const mappedEntry = fact.mapping?.matched
    const mappedApprovers = mappedEntry !== undefined && mappedEntry.approversFallback === false ? (mappedEntry.approvers ?? 0) : 0
    const problems = problemsOf(fact, target, mappedApprovers)
    const checks =
        problems.length === 0
            ? [okCheckOf(fact, target, mappedApprovers, mode)]
            : [missingCheckOf(fact, target, mappedApprovers, problems, mode)]
    if (workspaceCheck !== undefined) checks.push(workspaceCheck)
    if (migration !== undefined) checks.push(migration)
    if (problems.length === 0 && fact.p2pOnly !== false) checks.push(p2pAdviceCheck())
    return checks
}

/**
 * Judge the IM approval path and return its checks.
 *
 * Exactly one of these shapes comes back (plus the migration check when a
 * repository still carries an old list):
 *
 *  - no `interaction` service (or a service that does not report the mode) →
 *    one `ok`/`unknown` check, never a warning (the default eleven do not ship
 *    the interaction gate);
 *  - `off` → one `ok` check stating that approvals still go through the host
 *    seam (TUI), with NO advice item: the default deployment is not nagged;
 *  - `fallback`/`only` → the required check (`ok` when the target and a
 *    non-empty HOST approver list are both present, `missing` naming every
 *    missing piece otherwise) plus, when `im.p2pOnly` is on (the default), one
 *    `recommended` advice item about `chatKind` — advice because the upstream's
 *    capability cannot be determined from any API.
 * @param fact - the facts read from the service and the workspace.
 * @returns the checks (1 or 2, plus the migration check), in report order.
 */
export function imApprovalChecks(fact: ImApprovalFact): DoctorCheck[] {
    const migration = legacyCheckOf(fact.legacy)
    if (!fact.service) return noServiceChecks(migration)
    if (fact.mode === undefined) return unreadableModeChecks(fact, migration)
    if (fact.mode === 'off') return offModeChecks(fact.mode, migration)
    return configuredChecks(fact, fact.mode, migration)
}

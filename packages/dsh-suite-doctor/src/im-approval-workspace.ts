/**
 * The WORKSPACE-MAPPING check (P3.2): does THIS workspace have an approval
 * conversation at all?
 *
 * A host may split its approvals per workspace (`im.approvals`). That makes a
 * new, invisible failure possible: the mode, the target and the allowlist are
 * all configured correctly, and yet every approval raised in THIS repository is
 * refused before a card because no entry claims it
 * (`refused:no-workspace-mapping`) — or, under `host-default`, is sent to a
 * conversation configured for a different repository. Neither shows up in the
 * process-wide keys, so it is asked here, per workspace.
 *
 * Split out of `im-approval.ts` so each verdict is small enough to read on its
 * own; the vocabulary it judges lives in `im-approval-contract.ts`.
 * @module dsh-suite-doctor/im-approval-workspace
 */

import type { DoctorCheck } from 'dsh-eng-core'
import {
    HOST_APPROVERS_FILE,
    IM_APPROVAL_WORKSPACE_CHECK_ID,
    type ApprovalVia,
    type WorkspaceMappingFact,
} from './im-approval-contract.js'

/** What every workspace-mapping verdict needs to say (computed once). */
interface WorkspaceContext {
    mode: ApprovalVia
    /** The workspace the verdict is about, as the gate named it. */
    where: string
    /** `N 条声明/M 条可用`. */
    counts: string
    /** The mapping's own configuration problems, already formatted as a suffix. */
    suffix: string
    /** The one-line `im.approvals` example the fix texts quote. */
    entryHint: string
}

/**
 * The shared facts of one workspace-mapping verdict.
 * @param mode - the effective `im.approvalVia`.
 * @param mapping - the mapping facts for this workspace.
 * @returns the context every branch reads.
 */
function workspaceContextOf(mode: ApprovalVia, mapping: WorkspaceMappingFact): WorkspaceContext {
    const resolved = mapping.resolved !== undefined && mapping.resolved !== '' ? mapping.resolved : undefined
    const where = resolved ?? mapping.workspace ?? '(工作区未报告)'
    const counts = `${mapping.declared ?? 0} 条声明/${mapping.usable ?? 0} 条可用`
    const problems = mapping.problems ?? []
    const suffix = problems.length === 0 ? '' : `；映射配置问题：${problems.join('；')}`
    const entryHint =
        `{ "workspace": ${JSON.stringify(where)}, "chatId": "<该工作区与 bot 私聊的会话 id>" }` +
        '（approvers 省略则回落到宿主名单，写上则替换它）'
    return { mode, where, counts, suffix, entryHint }
}

/**
 * The verdict for a mapping whose entries were ambiguous.
 * @param context - the shared facts.
 * @param conflict - the candidates the gate reported.
 * @returns the `missing` check naming every candidate.
 */
function conflictWorkspaceCheck(context: WorkspaceContext, conflict: NonNullable<WorkspaceMappingFact['conflict']>): DoctorCheck {
    const candidates = conflict.candidates ?? []
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: 'IM 审批的工作区映射（歧义）',
        detail:
            `im.approvalVia=${context.mode}，工作区 ${context.where} 同时命中 ${candidates.length} 条**具体度相同**的 im.approvals 条目` +
            `（${candidates.map((entry) => `im.approvals[${entry.index ?? '?'}] ${entry.workspace ?? '?'}（会话 ${entry.chatId ?? '?'}）`).join(' / ')}）：` +
            '具体度相同就无法判断哪一条才是这个工作区的决定，所以每次审批都会在发卡之前被拒绝（refused:ambiguous-workspace-mapping），' +
            '一次决定也做不出来' +
            context.suffix,
        fix:
            '由宿主把其中一条写得更具体（更长的路径前缀，例如把 /a 改成 /a/b），或删掉重复的那条；' +
            '判定规则：先比字面前缀（越长越具体），再比通配符个数（越少越具体，`**` 算两个），同分不裁决。' +
            '改完用 interaction_status 的「工作区映射」一行核对命中项',
    }
}

/**
 * The verdict for a mapping entry that declares an EMPTY approver list.
 * @param context - the shared facts.
 * @param matched - the entry that claimed this workspace.
 * @returns the `missing` check: nobody may approve here.
 */
function emptyApproversWorkspaceCheck(
    context: WorkspaceContext,
    matched: NonNullable<WorkspaceMappingFact['matched']>,
): DoctorCheck {
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: 'IM 审批的工作区映射（映射项的空名单）',
        detail:
            `im.approvalVia=${context.mode}，工作区 ${context.where} 命中的 im.approvals[${matched.index ?? '?'}] ${matched.workspace ?? ''} 声明了**空**的 approvers：` +
            '这个工作区**谁也不能批准**，每次审批都会在发卡之前被拒绝（refused:approvers-missing）——' +
            '空名单不会退回宿主名单（那会让"谁能审批"随配置漂移）' +
            context.suffix,
        fix:
            '由宿主给这条映射项写上该工作区的审批人 id，或删掉它的 `approvers` 字段以回落到宿主名单' +
            `（im.approvers / im.approversFile，默认 ${HOST_APPROVERS_FILE}）`,
    }
}

/**
 * The verdict for a workspace an `im.approvals` entry claimed.
 * @param context - the shared facts.
 * @param matched - the entry that claimed this workspace.
 * @returns the `ok` or (empty list) `missing` check.
 */
function matchedWorkspaceCheck(context: WorkspaceContext, matched: NonNullable<WorkspaceMappingFact['matched']>): DoctorCheck {
    const approvers = matched.approvers ?? 0
    if (matched.approversFallback === false && approvers === 0) return emptyApproversWorkspaceCheck(context, matched)
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'ok',
        severity: 'required',
        label: `IM 审批的工作区映射（命中 im.approvals[${matched.index ?? '?'}]）`,
        detail:
            `im.approvalVia=${context.mode}，工作区 ${context.where} 命中映射项 ${matched.workspace ?? '(未报告)'}` +
            `（会话 ${matched.chatId ?? '(未报告)'}，${context.counts}）：` +
            (matched.approversFallback === true
                ? '该条没有声明 approvers，审批人**回落到宿主名单**（由 im.approvers / im.approversFile 决定，denyApprovers 之后再生效）'
                : `该条声明了 approvers（${approvers} 个 id），denyApprovers 仍然会先减去被 deny 的人`) +
            '；审批提问按这条映射发到它的会话' +
            context.suffix,
    }
}

/**
 * The verdict for `only` next to `unmappedWorkspace=local` — a contradiction.
 * @param context - the shared facts.
 * @returns the `missing` check naming the two mutually exclusive switches.
 */
function onlyWithLocalWorkspaceCheck(context: WorkspaceContext): DoctorCheck {
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: 'IM 审批的工作区映射（only 与 local 矛盾）',
        detail:
            `im.approvalVia=only 表示"IM 或无人决定"，但工作区 ${context.where} 未命中任何映射且 im.unmappedWorkspace=local，` +
            '两者互相否定：审批既不会走 IM（没有目标会话），也不会落回宿主接缝（only 不回落），' +
            '结果是每次审批都返回 unavailable，一次决定也做不出来' +
            context.suffix,
        fix:
            '二选一：① 把 im.approvalVia 改成 fallback（未映射时交还 TUI），或 ② 给这个工作区在 im.approvals 里加一条 ' +
            `${context.entryHint}，或 ③ 把 im.unmappedWorkspace 改成 refuse（显式拒绝，而不是假装能批）`,
    }
}

/**
 * The verdict for an unmapped workspace under the `local` policy.
 * @param context - the shared facts.
 * @returns `missing` when `only` contradicts `local`, otherwise `ok`.
 */
function localWorkspaceCheck(context: WorkspaceContext): DoctorCheck {
    if (context.mode === 'only') return onlyWithLocalWorkspaceCheck(context)
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'ok',
        severity: 'required',
        label: 'IM 审批的工作区映射（未命中 → local：走本地审批）',
        detail:
            `工作区 ${context.where} 不在 im.approvals 的条目里（${context.counts}），而 im.unmappedWorkspace=local：` +
            '这个工作区的审批**不走 IM**，交给宿主接缝（本机是 TUI）；interaction_ask 会跳过 IM 通道改用本地通道，不会发出任何 IM 卡片' +
            context.suffix,
        fix:
            `要让这个工作区的审批也走 IM，就由宿主在 im.approvals 里加一条 ${context.entryHint}；` +
            '不加也安全：只是审批留在本机终端做决定',
    }
}

/**
 * The verdict for an unmapped workspace under `host-default` (advice, not a gap).
 * @param context - the shared facts.
 * @returns the `partial` (recommended) check.
 */
function hostDefaultWorkspaceCheck(context: WorkspaceContext): DoctorCheck {
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'partial',
        severity: 'recommended',
        label: 'IM 审批的工作区映射（未命中 → host-default）',
        detail:
            `im.approvalVia=${context.mode}，但工作区 ${context.where} 不在 im.approvals 的任何条目里（${context.counts}）：` +
            'im.unmappedWorkspace=host-default 允许这里回落到 im.approvalChatId + 宿主名单，' +
            '所以审批会发到**宿主默认会话**，而不是为这个工作区配置的会话——这可能正是你要的，也可能把卡片送进另一个项目的会话里' +
            context.suffix,
        fix:
            `要给这个工作区自己的审批会话，就由宿主在 im.approvals 里加一条 ${context.entryHint}；` +
            '要让"未映射就拒绝"成为硬规矩，把 im.unmappedWorkspace 设为 refuse（默认）。' +
            '这是**建议**：host-default 是显式策略，不是配置遗漏',
    }
}

/**
 * The verdict for an unmapped workspace under the default `refuse` policy.
 * @param context - the shared facts.
 * @returns the `missing` check: every approval from here is refused.
 */
function refuseWorkspaceCheck(context: WorkspaceContext): DoctorCheck {
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: 'IM 审批的工作区映射（未命中 → refuse）',
        detail:
            `im.approvalVia=${context.mode}（审批走 IM），但工作区 ${context.where} 不在 im.approvals 的任何条目里（${context.counts}），` +
            '而 im.unmappedWorkspace=refuse：这个工作区**每一次**审批都会在发卡之前被拒绝' +
            '（refused:no-workspace-mapping），一次决定也做不出来' +
            context.suffix,
        fix:
            `① 由宿主在 profile 的 dsh-interaction-gate 配置里给 im.approvals 加一条 ${context.entryHint}；` +
            '② 或把 im.unmappedWorkspace 设为 host-default（明确接受这里使用宿主默认会话 im.approvalChatId），或设为 local（未映射时走本地审批，不走 IM）；' +
            '③ 或把 im.approvalVia 设回 off，让审批继续走宿主接缝（TUI）。这三个键都是宿主配置，模型和仓库都改不了',
    }
}

/**
 * The workspace-mapping check: does THIS workspace have an approval conversation?
 *
 * Silent when the mapping is not in force (`configured !== true`) or was not
 * reported: "no mapping declared" is today's behaviour and must not be nagged,
 * and "could not read it" is not a state this check may invent.
 * @param mode - the effective `im.approvalVia` (this check only matters when the seam is on).
 * @param mapping - the mapping facts for this workspace.
 * @returns the check, or `undefined` when it does not apply.
 */
export function workspaceMappingCheckOf(mode: ApprovalVia, mapping: WorkspaceMappingFact): DoctorCheck | undefined {
    if (mapping.configured !== true) return undefined
    const context = workspaceContextOf(mode, mapping)
    if (mapping.conflict !== undefined) return conflictWorkspaceCheck(context, mapping.conflict)
    if (mapping.matched !== undefined) return matchedWorkspaceCheck(context, mapping.matched)
    const policy = mapping.policy ?? 'refuse'
    if (policy === 'local') return localWorkspaceCheck(context)
    if (policy === 'host-default') return hostDefaultWorkspaceCheck(context)
    return refuseWorkspaceCheck(context)
}

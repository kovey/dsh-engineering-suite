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
 * @module dsh-suite-doctor/im-approval
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig, type DoctorCheck, type Layout } from 'dsh-eng-core'

/** Every accepted value of `im.approvalVia`, most conservative first. */
export const APPROVAL_VIA_MODES = ['off', 'fallback', 'only'] as const

/** The mode of the host approval seam (`im.approvalVia`). */
export type ApprovalVia = (typeof APPROVAL_VIA_MODES)[number]

/** The HOST-side default the report names when it tells an operator where the list belongs. */
export const HOST_APPROVERS_FILE = '~/.dsh/interaction-approvers.txt'

/** The repository file the pre-P3.1 rule read — reported, never used. */
export const LEGACY_APPROVERS_FILE = '.dsh/interaction-approvers.txt'

/** The id the required check is reported under. */
export const IM_APPROVAL_CHECK_ID = 'runtime.im-approval'

/** The id of the ADVISORY check about `im.p2pOnly` and an upstream without `chatKind`. */
export const IM_APPROVAL_P2P_CHECK_ID = 'runtime.im-approval-p2p'

/** The id of the MIGRATION check: a repository list that no longer decides anything. */
export const IM_APPROVAL_LEGACY_CHECK_ID = 'runtime.im-approval-legacy-list'

/**
 * The id of the WORKSPACE-MAPPING check (P3.2): does THIS workspace have an
 * approval conversation at all?
 *
 * A separate id because it is a separate failure with a separate fix: the two
 * host keys of P1 can be perfect and this workspace still have no entry in
 * `im.approvals`, in which case every approval raised from here is refused
 * before a card (`refused:no-workspace-mapping`) — or lands in another
 * workspace's conversation under the `host-default` policy. Neither is visible
 * from the mode/target/allowlist facts, which are process-wide.
 */
export const IM_APPROVAL_WORKSPACE_CHECK_ID = 'runtime.im-approval-workspace'

/**
 * The workspace mapping, as the gate reported it for THIS workspace
 * (`im(workspace).workspaceMapping`, P3.2).
 *
 * Absent = the service does not implement the mapping (an older build) or was
 * not asked about a workspace. That is not a state the check can judge, so the
 * check stays silent instead of inventing "mapped" or "unmapped".
 */
export interface WorkspaceMappingFact {
    configured?: boolean
    declared?: number
    usable?: number
    policy?: 'refuse' | 'host-default'
    workspace?: string
    resolved?: string
    realpathProblem?: string
    matched?: { index?: number; workspace?: string; chatId?: string; approvers?: number; approversFallback?: boolean }
    conflict?: { candidates?: { index?: number; workspace?: string; chatId?: string }[] }
    problems?: string[]
}

/**
 * The host-side approver facts, exactly as `dsh-interaction-gate` reports them.
 *
 * Every field is optional: the service is not part of this package and may be an
 * older build. `count: undefined` = "this service does not report approvers" —
 * `unknown`, never `0` (which would claim "the host has no list").
 */
export interface HostApproverFact {
    /** Deduplicated host ids (inline ∪ file), before any deny list. */
    count?: number
    /** Host ids declared inline (`im.approvers`). */
    inline?: number
    /** The host-side file (`im.approversFile`, `~` expanded); `''` = unusable path. */
    file?: string
    /** Whether that file was readable. */
    filePresent?: boolean
    /** Usable ids the file holds. */
    fileCount?: number
    /** Host-declared deny ids (`im.denyApprovers`). */
    deny?: number
}

/** The legacy repository list, as found on disk (its ids are NOT the whitelist). */
export interface LegacyApproverFact {
    /** `<repo>/.dsh/interaction-approvers.txt` (always named, present or not). */
    file: string
    present: boolean
    /** Usable ids in that file (so an operator knows what to migrate). */
    count: number
    /** The path a project config still declares via `approversFile` (ignored since P3.1). */
    declaredPath?: string
    /** Usable ids at that declared path, when it is readable. */
    declaredCount?: number
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
    /**
     * The workspace mapping for the workspace this report is about (P3.2), when
     * the service reports one. Absent = no mapping feature (an older build) or no
     * workspace was named: the mapping check then stays silent instead of
     * inventing "mapped"/"unmapped".
     */
    mapping?: WorkspaceMappingFact
    /** The HOST-side approver list (`from` whitelist): the only source that decides approvals. */
    approvers: HostApproverFact
    /** The legacy repository list: migration signal only. */
    legacy: LegacyApproverFact
}

/** A chat id shown whole only when it is too short to be an identity leak. */
export function maskTarget(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

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
 * The `im.approvalVia` labels the report uses.
 * @param mode - the effective mode.
 */
function modeLabel(mode: ApprovalVia): string {
    return `im.approvalVia=${mode}`
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

/**
 * The workspace-mapping check: does THIS workspace have an approval conversation?
 *
 * Since P3.2 a host may split its approvals per workspace (`im.approvals`). That
 * makes a new, invisible failure possible: the mode, the target and the allowlist
 * are all configured correctly, and yet every approval raised in THIS repository
 * is refused before a card because no entry claims it
 * (`refused:no-workspace-mapping`) — or, under `host-default`, is sent to a
 * conversation configured for a different repository. Neither shows up in the
 * process-wide keys, so it is asked here, per workspace.
 *
 * Silent when the mapping is not in force (`configured !== true`) or was not
 * reported: "no mapping declared" is today's behaviour and must not be nagged,
 * and "could not read it" is not a state this check may invent.
 * @param mode - the effective `im.approvalVia` (this check only matters when the seam is on).
 * @param mapping - the mapping facts for this workspace.
 * @returns the check, or `undefined` when it does not apply.
 */
function workspaceMappingCheckOf(mode: ApprovalVia, mapping: WorkspaceMappingFact): DoctorCheck | undefined {
    if (mapping.configured !== true) return undefined
    const label = 'IM 审批的工作区映射'
    const resolved = mapping.resolved !== undefined && mapping.resolved !== '' ? mapping.resolved : undefined
    const where = resolved ?? mapping.workspace ?? '(工作区未报告)'
    const counts = `${mapping.declared ?? 0} 条声明/${mapping.usable ?? 0} 条可用`
    const problems = mapping.problems ?? []
    const suffix = problems.length === 0 ? '' : `；映射配置问题：${problems.join('；')}`

    if (mapping.conflict !== undefined) {
        const candidates = mapping.conflict.candidates ?? []
        return {
            id: IM_APPROVAL_WORKSPACE_CHECK_ID,
            area: 'interact',
            state: 'missing',
            severity: 'required',
            label: `${label}（歧义）`,
            detail:
                `im.approvalVia=${mode}，工作区 ${where} 同时命中 ${candidates.length} 条**具体度相同**的 im.approvals 条目` +
                `（${candidates.map((entry) => `im.approvals[${entry.index ?? '?'}] ${entry.workspace ?? '?'}（会话 ${entry.chatId ?? '?'}）`).join(' / ')}）：` +
                '具体度相同就无法判断哪一条才是这个工作区的决定，所以每次审批都会在发卡之前被拒绝（refused:ambiguous-workspace-mapping），' +
                '一次决定也做不出来' +
                suffix,
            fix:
                '由宿主把其中一条写得更具体（更长的路径前缀，例如把 /a 改成 /a/b），或删掉重复的那条；' +
                '判定规则：先比字面前缀（越长越具体），再比通配符个数（越少越具体，`**` 算两个），同分不裁决。' +
                '改完用 interaction_status 的「工作区映射」一行核对命中项',
        }
    }

    if (mapping.matched !== undefined) {
        const matched = mapping.matched
        const approvers = matched.approvers ?? 0
        if (matched.approversFallback === false && approvers === 0) {
            // `approvers: []` is a real state and a real trap: the entry says
            // "nobody may approve here", and the approval path then refuses every
            // ask with `refused:approvers-missing` (it never falls back to the
            // host list — a silent fallback would change who may decide).
            return {
                id: IM_APPROVAL_WORKSPACE_CHECK_ID,
                area: 'interact',
                state: 'missing',
                severity: 'required',
                label: `${label}（映射项的空名单）`,
                detail:
                    `im.approvalVia=${mode}，工作区 ${where} 命中的 im.approvals[${matched.index ?? '?'}] ${matched.workspace ?? ''} 声明了**空**的 approvers：` +
                    '这个工作区**谁也不能批准**，每次审批都会在发卡之前被拒绝（refused:approvers-missing）——' +
                    '空名单不会退回宿主名单（那会让"谁能审批"随配置漂移）' + suffix,
                fix:
                    '由宿主给这条映射项写上该工作区的审批人 id，或删掉它的 `approvers` 字段以回落到宿主名单' +
                    `（im.approvers / im.approversFile，默认 ${HOST_APPROVERS_FILE}）`
            }
        }
        return {
            id: IM_APPROVAL_WORKSPACE_CHECK_ID,
            area: 'interact',
            state: 'ok',
            severity: 'required',
            label: `${label}（命中 im.approvals[${matched.index ?? '?'}]）`,
            detail:
                `im.approvalVia=${mode}，工作区 ${where} 命中映射项 ${matched.workspace ?? '(未报告)'}` +
                `（会话 ${matched.chatId ?? '(未报告)'}，${counts}）：` +
                (matched.approversFallback === true
                    ? '该条没有声明 approvers，审批人**回落到宿主名单**（由 im.approvers / im.approversFile 决定，denyApprovers 之后再生效）'
                    : `该条声明了 approvers（${approvers} 个 id），denyApprovers 仍然会先减去被 deny 的人`) +
                '；审批提问按这条映射发到它的会话' +
                suffix,
        }
    }

    // Unmatched. `host-default` is a policy the host wrote down (allowed, but it
    // must SAY that the conversation came from the default and not from an entry).
    const entryHint =
        `{ "workspace": ${JSON.stringify(where)}, "chatId": "<该工作区与 bot 私聊的会话 id>" }` +
        '（approvers 省略则回落到宿主名单，写上则替换它）'
    if ((mapping.policy ?? 'refuse') === 'host-default') {
        return {
            id: IM_APPROVAL_WORKSPACE_CHECK_ID,
            area: 'interact',
            state: 'partial',
            severity: 'recommended',
            label: `${label}（未命中 → host-default）`,
            detail:
                `im.approvalVia=${mode}，但工作区 ${where} 不在 im.approvals 的任何条目里（${counts}）：` +
                'im.unmappedWorkspace=host-default 允许这里回落到 im.approvalChatId + 宿主名单，' +
                '所以审批会发到**宿主默认会话**，而不是为这个工作区配置的会话——这可能正是你要的，也可能把卡片送进另一个项目的会话里' +
                suffix,
            fix:
                `要给这个工作区自己的审批会话，就由宿主在 im.approvals 里加一条 ${entryHint}；` +
                '要让"未映射就拒绝"成为硬规矩，把 im.unmappedWorkspace 设为 refuse（默认）。' +
                '这是**建议**：host-default 是显式策略，不是配置遗漏',
        }
    }
    return {
        id: IM_APPROVAL_WORKSPACE_CHECK_ID,
        area: 'interact',
        state: 'missing',
        severity: 'required',
        label: `${label}（未命中 → refuse）`,
        detail:
            `im.approvalVia=${mode}（审批走 IM），但工作区 ${where} 不在 im.approvals 的任何条目里（${counts}），` +
            '而 im.unmappedWorkspace=refuse：这个工作区**每一次**审批都会在发卡之前被拒绝' +
            '（refused:no-workspace-mapping），一次决定也做不出来' +
            suffix,
        fix:
            `① 由宿主在 profile 的 dsh-interaction-gate 配置里给 im.approvals 加一条 ${entryHint}；` +
            '② 或把 im.unmappedWorkspace 设为 host-default（明确接受这里使用宿主默认会话 im.approvalChatId）；' +
            '③ 或把 im.approvalVia 设回 off，让审批继续走宿主接缝（TUI）。这三个键都是宿主配置，模型和仓库都改不了',
    }
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
    const label = 'IM 审批可用性'
    const migration = legacyCheckOf(fact.legacy)

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
            ...(migration === undefined ? [] : [migration]),
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
            ...(migration === undefined ? [] : [migration]),
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
            ...(migration === undefined ? [] : [migration]),
        ]
    }

    const workspaceCheck = workspaceMappingCheckOf(mode, fact.mapping ?? {})
    const target = fact.target ?? ''
    // P3.2: a matched `im.approvals` entry that DECLARES `approvers` is this
    // workspace's whitelist, so an empty HOST list is not a failure here — the
    // gate would not refuse, and reporting it as missing would be a false alarm
    // that pushes an operator to configure a list nothing reads.
    const mappedEntry = fact.mapping?.matched
    const mappedApprovers = mappedEntry !== undefined && mappedEntry.approversFallback === false ? (mappedEntry.approvers ?? 0) : 0
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
    const labelWithMode = `${label}（${modeLabel(mode)}）`
    if (problems.length > 0) {
        // The fix names ONLY what is actually missing: a target that is already
        // configured must not be "fixed" again, and an empty list must point at
        // the HOST-side keys. The `off` alternative is always the second way out.
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
                    '② 把 im.approvalVia 设回 off，让审批继续走宿主接缝（TUI）。这些键是宿主配置，模型和仓库都改不了；' +
                    'interaction_status 的「IM 审批目标」「审批人名单」「项目减法」三行显示生效值',
            },
            ...(workspaceCheck === undefined ? [] : [workspaceCheck]),
            ...(migration === undefined ? [] : [migration]),
        ]
    }

    const hostCount = fact.approvers.count ?? 0
    const sources: string[] = []
    if ((fact.approvers.inline ?? 0) > 0) sources.push(`im.approvers ${fact.approvers.inline} 个内联 id`)
    if (fact.approvers.file !== undefined && fact.approvers.file !== '') {
        sources.push(`im.approversFile=${fact.approvers.file}（存在=${fact.approvers.filePresent === true}，${fact.approvers.fileCount ?? 0} 个 id）`)
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
                `宿主审批人名单 ${hostCount} 个 id（${sources.join(' + ') || `im.approversFile=${HOST_APPROVERS_FILE}`}）` +
                ((fact.approvers.deny ?? 0) > 0
                    ? `；宿主 denyApprovers ${fact.approvers.deny} 个会先减去，项目还能再减（有效名单见 interaction_status 的「项目减法」一行）`
                    : '') +
                (mappedApprovers > 0
                    ? `；这个工作区命中的 im.approvals[${mappedEntry?.index ?? '?'}] 声明了自己的 approvers（${mappedApprovers} 个 id），` +
                      '宿主名单在该工作区不参与（denyApprovers 仍会先减）'
                    : ''),
        },
    ]
    if (workspaceCheck !== undefined) checks.push(workspaceCheck)
    if (migration !== undefined) checks.push(migration)
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

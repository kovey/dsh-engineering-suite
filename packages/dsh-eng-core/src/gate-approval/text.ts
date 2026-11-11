/**
 * Everything the kernel SAYS: the "nobody was asked" sentences, the five
 * distinct outcome sentences, and the two predicates a caller should use.
 *
 * Sentences live in one module because they are the contract: throwing all
 * non-allow outcomes into one "approval failed" line is the defect this kernel
 * exists to end, and {@link describeGateApproval} gives each outcome its own.
 *
 * @module dsh-eng-core/gate-approval/text
 */

import type { GateApprovalResult, GateApprovalVia } from './types.js'

/** A string field of an untrusted record (`''` when it is not a string). */
export function textOf(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

/** A thrown value as a message (`String(error)` for non-`Error` throws). */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The rich surface could not carry the question: nobody was asked. */
export function richNoAnswererText(reason: string, toolName: string): string {
    return (
        `没有可用的富审阅面（no-answerer）：这次请求（${toolName}）需要一份可阅读、可修改的评审材料，` +
        '所以不会降级成"只能点允许/拒绝"的审批浮窗——**没有人被问到**。' +
        `面的情况：${reason}。` +
        '建议：在 nvim-tui 里运行（扩展卡片可打开/预览工件），或在能渲染 userQuestions plan-review 的 desktop / web TUI 里运行；' +
        '并把 spec-gate 的 reviewChannel 设为 auto。'
    )
}

/** The binary surfaces could not carry the question: nobody was asked. */
export function noAnswererText(suiteReason: string, seamReason: string, hostPolicy: string | undefined): string {
    return (
        '没有可用的审批面（no-answerer）：没有人被问到，所以这既不是拒绝，也不是取消。' +
        `套件通道：${suiteReason}；宿主审批接缝：${seamReason}。` +
        (hostPolicy === undefined
            ? '（宿主没有暴露审批策略，无法判断策略是否也参与其中。）'
            : `（宿主审批策略：policy=${hostPolicy}；策略只影响宿主接缝，不影响套件通道。）`) +
        '建议：装配 dsh-interaction-gate 的 IM 通道（它实现了 wait()，能收到答案），或让宿主装配审批插件（ctx.approval）；' +
        '然后重试。'
    )
}

/** A card may already be on somebody's phone: a second prompt is a double question. */
export function cardSentText(reason: string): string {
    return (
        `二元面已经发出过卡片但没有得到可用答案（${reason}）：同一问题不能再问第二个面，按"没有人决定"处理。`
    )
}

/**
 * One sentence per outcome, deliberately distinct.
 *
 * Callers MUST report the sentence for the outcome they received: throwing all
 * non-allow outcomes into one "approval failed" line is the defect this module
 * exists to end.
 * @param result - the kernel's verdict.
 */
export function describeGateApproval(result: GateApprovalResult): string {
    const who = result.by === '' ? '' : `（by ${result.by}${result.via === undefined ? '' : ` via ${result.via}`}）`
    switch (result.outcome) {
        case 'allowed-once':
            return `已获一次性授权${who}：只放行这一次。`
        case 'rejected':
            return `审批人拒绝了这次请求${who}：不是"没人回答"，也不是"取消"。`
        case 'cancelled':
            return '等待人工裁决的过程被取消（cancelled）：没有人作出决定——取消不是拒绝，也不是同意。'
        case 'no-answerer':
            return '没有可用的审批面（no-answerer）：**没有人被问到**——既不是拒绝，也不是取消。'
        case 'rejected-by-host-policy':
            return `宿主会话的审批策略直接拒绝了这次请求（rejected-by-host-policy${result.hostPolicy === undefined ? '' : `，policy=${result.hostPolicy}`}）：接缝没有派发，**没有问过任何人**。`
    }
}

/** Whether a result authorises the action (the only predicate a caller should use). */
export function gateApprovalAllowed(result: GateApprovalResult): boolean {
    return result.outcome === 'allowed-once' && result.allowed === true
}

/**
 * Map a kernel `via` onto the vocabulary `approvalStrength` understands
 * (`tui` / `questions` / `im` / `seam`).
 *
 * The strength rule is a security decision (a local operator session vs a
 * remote channel), and it predates the kernel. Translating in ONE place keeps a
 * new surface from silently changing how strong an approval looks: `im` stays
 * `im` (and stays `inferred` without an allowlist), the TUI card stays `tui`,
 * the web/desktop plan-review card keeps its historical `questions` label, and
 * the generic seam stays `seam`.
 * @param via - the surface the kernel reported.
 * @returns the strength-vocabulary source (empty when nobody decided).
 */
export function approvalSourceOfVia(via: GateApprovalVia | undefined): string {
    switch (via) {
        case 'tui-card':
            return 'tui'
        case 'tui-approval':
            return 'questions'
        case 'host-seam':
            return 'seam'
        case 'im':
            return 'im'
        default:
            return ''
    }
}

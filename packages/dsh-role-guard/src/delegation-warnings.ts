/**
 * The `warning:` lines of one `team_delegate` report.
 *
 * Extracted from `tools.ts` for the structural ratchet (that file must not grow
 * past its accepted length) and because the list is read by two audiences: the
 * model decides what to retry from it, and an audit reads why a child ran where
 * it did. The order is part of the contract: route warnings first, then the
 * dispatch/whitelist/binding facts, then recorded problems.
 *
 * @module dsh-role-guard/delegation-warnings
 */

/** Everything one delegation report has to warn about. */
export interface DelegationWarningsInput {
    /** The resolved route: what the caller overrode and what was ignored. */
    route: { ignored: readonly string[]; problems: readonly string[] }
    /** Problems found while reading the caller's `dispatch` argument. */
    dispatchProblems: readonly string[]
    /** Whitelist entries the role file names but this deployment lacks. */
    droppedTools: readonly string[]
    /** Whether the durable session → role binding was written. */
    bindingRecorded: boolean
    /** The child session id (named in the binding warning). */
    childSessionId: string
    /** The role id (named in the binding warning). */
    roleId: string
    /** Problems the role registry reported for this workspace. */
    registryProblems: readonly string[]
    /** Agent-preset problems reported by the seam. */
    presetProblems: readonly string[]
    /** The delegation ledger could not be written; the delegation still ran. */
    delegationWarning?: string
}

/**
 * Assemble the report's `warning:` lines.
 * @param input - every fact the lines are built from.
 * @returns warning texts, in the documented order (empty when nothing to say).
 */
export function delegationWarnings(input: DelegationWarningsInput): string[] {
    const warnings: string[] = []
    if (input.route.ignored.length > 0) {
        warnings.push(
            `宿主禁用了按调用覆盖模型：沿用角色路由（被忽略的调用参数：${input.route.ignored.join('、')}）。` +
                '模型覆盖是成本决策，是否允许由宿主的 allowModelOverride 决定。',
        )
    }
    for (const problem of input.route.problems) warnings.push(problem)
    for (const problem of input.dispatchProblems) warnings.push(problem)
    if (input.droppedTools.length > 0) {
        warnings.push(`角色文件里这些工具在当前部署不存在，已从白名单剔除：${input.droppedTools.join(', ')}`)
    }
    if (!input.bindingRecorded) {
        warnings.push(
            `未能记录角色绑定（${input.childSessionId} → ${input.roleId}）：技能白名单对这个子 Agent 不生效（详见 role-guard 日志）。工具白名单不受影响，仍由宿主强制。`,
        )
    }
    for (const problem of input.registryProblems) warnings.push(`角色文件问题：${problem}`)
    // A preset that failed to register stays visible on every delegation:
    // another role's dispatch must not hide it.
    for (const problem of input.presetProblems) warnings.push(`Agent Preset：${problem}`)
    // The ledger could not be written: the child still runs (a delegation the
    // host authorised must not fail on a bookkeeping error), but the fact that
    // the role is NOT recorded for this stage is exactly what the write guard
    // and `advance` will refuse on next time.
    if (input.delegationWarning !== undefined) warnings.push(input.delegationWarning)
    return warnings
}

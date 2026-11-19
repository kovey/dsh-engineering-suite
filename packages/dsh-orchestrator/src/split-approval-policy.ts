/**
 * Whether this session can be asked at all — read BEFORE the seam is asked.
 *
 * `@deepseek-ai/dsh-user-approval` decides `policy === 'never'` INSIDE
 * `request()`: it dispatches no card and answers `'rejected'`. That answer is
 * byte-identical to a person pressing "打回", so recording it as a human
 * rejection spends a `split.maxReworkRounds` round, and two such rounds degrade
 * a perfectly good plan to plain `implement` without a single card ever having
 * been shown. The plan was never judged; the channel just never asked.
 *
 * So the policy is read here, structurally and defensively:
 *  - `never` → the caller refuses by name, writing NO review row;
 *  - anything unreadable (no `effectivePolicy`, no `agent.session`, a throw, a
 *    non-string answer) → the caller asks exactly as before. A read failure is
 *    a log line, never a reason to refuse work — that is the whole difference
 *    between "nobody could answer" and "we did not look".
 *
 * The method is private in the host's `.d.ts` but present on the service at
 * runtime; the read is therefore structural (optional call) and never assumed.
 *
 * @module dsh-orchestrator/split-approval-policy
 */

/** What reading the session policy produced: the value, or why it is unknown. */
export interface SessionApprovalPolicy {
    /** The reported policy (`never` is the only value acted on). */
    policy?: string
    /** Why it could not be read; for the log, never for a refusal. */
    problem?: string
}

/** The seam's policy reporter, structurally (typed `private` by the host). */
interface PolicyReporter {
    effectivePolicy?: (session: unknown) => unknown
}

/**
 * Read the session's effective approval policy.
 * @param seam - whatever `ctx.get('approval')` returned (untrusted shape).
 * @param agent - the caller, whose `session` the policy applies to.
 * @returns the policy string, or the reason it is unknown.
 */
export function readSessionApprovalPolicy(seam: unknown, agent: unknown): SessionApprovalPolicy {
    const reporter = (seam as PolicyReporter | undefined)?.effectivePolicy
    if (typeof reporter !== 'function') return { problem: '宿主审批服务没有暴露 effectivePolicy（旧版宿主）' }
    const session = (agent as { session?: unknown } | undefined)?.session
    // A service that indexes the session cannot answer for a missing one; asking
    // it anyway would turn "no agent" into a throw instead of "keep asking".
    if (session === undefined) return { problem: '调用方没有 agent.session' }
    try {
        const value: unknown = reporter.call(seam, session)
        return typeof value === 'string' && value !== '' ? { policy: value } : { problem: `effectivePolicy 返回了非字符串（${typeof value}）` }
    } catch (error) {
        return { problem: `effectivePolicy 抛错：${(error as Error).message}` }
    }
}

/**
 * The refusal for a session whose approval policy never prompts.
 *
 * The words are the contract: what the host did (`never` → rejected without a
 * card), what the suite did NOT do (no review row, no rework round), and the
 * one action that changes the outcome (switch to `ask`, advance again).
 * @returns the detail paragraph and the next step.
 */
export function neverPolicyRefusal(): { detail: string; fix: string } {
    return {
        detail: [
            '本会话审批策略为 never（提示被禁用）：宿主不会弹任何审批卡，而是直接返回 rejected。',
            '也就是说本会话审批策略为 never（不弹任何提示），无法人工审核拆分。',
            '所以这次没有记录成\'人工打回\'，也不计入拆分审核轮数（本轮 reviews.jsonl 未写入任何行）。',
        ].join('\n'),
        fix: '把审批策略切到 ask 后重新 advance 即可审核；这是宿主策略，不是套件故障（split.reviewRequired 仍然是硬门禁，本轮只是没法问到人）。',
    }
}

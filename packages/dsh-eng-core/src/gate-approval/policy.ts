/**
 * The ONE structural reader of the host's approval policy.
 *
 * The policy is READ, never obeyed: the kernel records it next to the decision
 * (`hostPolicy`) and names it when a seam rejection is explained
 * (`rejected-by-host-policy`). It is never consulted to decide WHETHER to ask —
 * that would let `policy=never` answer a hard gate by itself.
 *
 * @module dsh-eng-core/gate-approval/policy
 */

/**
 * Read the host's approval policy from a service, structurally.
 *
 * The installed `@deepseek-ai/dsh-user-approval` keeps the effective policy out
 * of the public surface (`effectivePolicy` is private) but exposes its two
 * inputs: the session override (`overrideOf(session)`) and the deployment
 * default (`config.policy`). Both are read here, defensively — an older host
 * that has neither yields `undefined`, which a caller must treat as "unknown"
 * (the kernel then reports a plain `rejected`, never `rejected-by-host-policy`,
 * because naming a policy it did not read would be a guess).
 * @param approval - whatever `ctx.get('approval')` returned (untrusted shape).
 * @param agent - the agent whose session policy applies.
 * @returns the policy string, or `undefined` when it cannot be read.
 */
export function readHostApprovalPolicy(approval: unknown, agent: unknown): string | undefined {
    if (typeof approval !== 'object' || approval === null) return undefined
    const service = approval as Record<string, unknown>
    const session = (agent as { session?: unknown } | undefined)?.session
    const overrideOf = service['overrideOf']
    if (typeof overrideOf === 'function' && session !== undefined) {
        try {
            const value = (overrideOf as (session: unknown) => unknown).call(approval, session)
            if (typeof value === 'string' && value !== '') return value
        } catch {
            // A service that throws while reporting its policy has not told us
            // anything: fall through to the configured default.
        }
    }
    const config = service['config']
    if (typeof config === 'object' && config !== null) {
        const policy = (config as Record<string, unknown>)['policy']
        if (typeof policy === 'string' && policy !== '') return policy
    }
    const direct = service['policy']
    if (typeof direct === 'string' && direct !== '') return direct
    return undefined
}

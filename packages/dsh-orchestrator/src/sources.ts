/**
 * This plugin's own message-source kind.
 *
 * 0.1.7 removed the shared catch-all `plugin` kind from `MessageSourceMap`: each
 * producer now declares its own kind in its own module (the harness's own
 * `subagent-settled` is the reference). Declaring ours keeps the origin of an
 * injected notice readable — a session log now says *which gate* spoke, instead
 * of "some plugin".
 *
 * @module dsh-orchestrator/sources
 */

/** The shape of an orchestrator notice injected into the conversation. */
export interface OrchestratorNoticeSource {
    readonly kind: 'dsh-orchestrator'
    readonly form: 'notice'
    /** One-line account, bounded by the harness's `boundContextSummary`. */
    readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-orchestrator': OrchestratorNoticeSource
    }
}

/**
 * This plugin's own message-source kind.
 *
 * See the orchestrator's twin file: 0.1.7 dropped the shared `plugin` kind, so a
 * producer declares its own in its own module. A BLOCK reminder injected into the
 * conversation then reads as coming from the quality gate specifically.
 *
 * @module dsh-quality-gate/sources
 */

/** The shape of a quality-gate notice injected into the conversation. */
export interface QualityGateNoticeSource {
    readonly kind: 'dsh-quality-gate'
    readonly form: 'notice'
    /** One-line account, bounded by the harness's `boundContextSummary`. */
    readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-quality-gate': QualityGateNoticeSource
    }
}

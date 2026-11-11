/**
 * The `bootstrap` section of the configuration: drafting specifications for
 * repositories that already exist (see `spec_bootstrap`).
 * @module dsh-spec-gate/config-bootstrap
 */

import { bool, isRecord, num, str, strList } from './config-values.js'

/**
 * Drafting specifications for repositories that already exist (`spec_bootstrap`):
 * the scan is deterministic, the model only writes the missing prose, and nothing
 * it returns is approved automatically.
 */
export interface BootstrapConfig {
    /** `false` disables the tool entirely. */
    enabled: boolean
    /** `ctx.subagents` provider used for the read-only drafting child. */
    provider: string
    /** Tools the drafting child may use — read-only by construction. */
    readTools: readonly string[]
    /**
     * Model route for the drafting child (`provider/model` or a bare model id).
     *
     * Reading a repository is exactly the work a cheap model can do, so a host
     * can point drafting somewhere cheaper than the session's model without
     * changing anything else. Omitted = the session's own model.
     */
    model?: string
    /** Adapter-owned reasoning effort for the drafting child. */
    reasoningEffort?: string
    /** Output-token cap for the drafting child. */
    maxTokens?: number
    /** Deadline for one drafting child. */
    timeoutMs: number
    /** Bound on how many index entries the brief lists. */
    maxIndexEntries: number
    /** Bound on the cases a draft may contain. */
    maxCases: number
    /** Minimum length of a case's steps/expected before `check` complains. */
    minTextLength: number
}

/** The read-only tool set a drafting child gets (no write/edit/bash by design). */
export const DEFAULT_BOOTSTRAP_READ_TOOLS: readonly string[] = ['read', 'grep', 'glob']

/**
 * Parse the `bootstrap` section.
 *
 * A model route is optional: when it is omitted the drafter asks the host's
 * `agentDefaultModel`, so the common case needs no configuration at all.
 * @param value - the untrusted configured section.
 * @returns the section with every default applied.
 */
export function resolveBootstrap(value: unknown): BootstrapConfig {
    const raw = isRecord(value) ? value : {}
    return {
        enabled: bool(raw['enabled'], true),
        provider: str(raw['provider'], 'spawn'),
        readTools: strList(raw['readTools'], DEFAULT_BOOTSTRAP_READ_TOOLS),
        ...(typeof raw['model'] === 'string' && raw['model'] !== '' ? { model: raw['model'] } : {}),
        ...(typeof raw['reasoningEffort'] === 'string' && raw['reasoningEffort'] !== ''
            ? { reasoningEffort: raw['reasoningEffort'] }
            : {}),
        ...(typeof raw['maxTokens'] === 'number' && raw['maxTokens'] > 0
            ? { maxTokens: Math.floor(raw['maxTokens']) }
            : {}),
        timeoutMs: Math.max(10_000, Math.floor(num(raw['timeoutMs'], 10 * 60_000))),
        maxIndexEntries: Math.max(5, Math.floor(num(raw['maxIndexEntries'], 40))),
        maxCases: Math.max(1, Math.floor(num(raw['maxCases'], 80))),
        minTextLength: Math.max(1, Math.floor(num(raw['minTextLength'], 12))),
    }
}

/** Overlay one project-level `bootstrap` object onto the host's. */
export function mergeBootstrap(value: unknown, host: BootstrapConfig): BootstrapConfig {
    if (!isRecord(value)) return host
    return resolveBootstrap({ ...host, ...value })
}

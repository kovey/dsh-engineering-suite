/**
 * Plugin configuration.
 * @module dsh-role-guard/config
 */

import type { LayoutOptions } from 'dsh-eng-core'

/** Resolved plugin configuration. */
export interface RoleGuardConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log file template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Extra role directories, resolved against the session workspace. */
    roleDirs: readonly string[]
    /** Load the roles shipped with this package. */
    includeBuiltin: boolean
    /** Inline role definitions (highest precedence). */
    roles: readonly unknown[]
    /** `ctx.subagents` provider used for delegation. */
    provider: string
    /** Role used when `team_delegate` omits one. */
    defaultRole: string
    /** Tools stripped from every `mode: read` role. */
    readonlyDeny: readonly string[]
    /** Cap for the child's returned output. */
    maxOutputChars: number
    /**
     * Whether `team_delegate` may override the role's model route per call
     * (`model` / `reasoningEffort` / `maxTokens`). A model override is a cost
     * decision, so the host can forbid it.
     */
    allowModelOverride: boolean
    /** Include the mission's specification digest in the child prompt. */
    injectSpec: boolean
    /** Enforce a role's `skills` list at invocation time (see `skill-gate`). */
    enforceSkillWhitelist: boolean
    /** Tool names that load a skill; only these are gated. */
    skillTools: readonly string[]
    prompt: {
        enabled: boolean
        order: number
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function strList(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback]
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** Tools a read-only role must never hold, whatever its file says. */
export const DEFAULT_READONLY_DENY: readonly string[] = ['write', 'edit', 'str_replace_editor']

/**
 * Tool names that load a skill, gated by `enforceSkillWhitelist`.
 *
 * `skill` is the name registered by `@deepseek-ai/dsh-tool-skill` (the harness
 * plugin that publishes the model-facing skill catalog). A deployment that
 * mounts a differently-named loader configures it here.
 */
export const DEFAULT_SKILL_TOOLS: readonly string[] = ['skill']

/**
 * Resolve user configuration into the effective one.
 * @param input - the loader row's `config` value (untrusted).
 */
export function resolveConfig(input: unknown): RoleGuardConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    // An explicitly empty list would silently disarm the gate; the documented
    // switch for that is `enforceSkillWhitelist: false`.
    const skillTools = strList(raw['skillTools'], DEFAULT_SKILL_TOOLS)
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/role-guard.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== '' ? { logFileTemplate: raw['logFileTemplate'] } : {}),
        layout: {
            ...(typeof raw['rootDir'] === 'string' ? { rootDir: raw['rootDir'] } : {}),
            ...(typeof raw['rolesDir'] === 'string' ? { rolesDir: raw['rolesDir'] } : {}),
        },
        roleDirs: strList(raw['roleDirs'], []),
        includeBuiltin: bool(raw['includeBuiltin'], true),
        roles: Array.isArray(raw['roles']) ? raw['roles'] : [],
        provider: str(raw['provider'], 'spawn'),
        defaultRole: str(raw['defaultRole'], 'developer'),
        readonlyDeny: strList(raw['readonlyDeny'], DEFAULT_READONLY_DENY),
        maxOutputChars: num(raw['maxOutputChars'], 6_000),
        allowModelOverride: bool(raw['allowModelOverride'], true),
        injectSpec: bool(raw['injectSpec'], true),
        enforceSkillWhitelist: bool(raw['enforceSkillWhitelist'], true),
        skillTools: skillTools.length > 0 ? skillTools : [...DEFAULT_SKILL_TOOLS],
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 610),
        },
    }
}

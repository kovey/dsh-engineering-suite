/**
 * Invocation-time enforcement of a role's skill whitelist (docs.md §3.1).
 *
 * `ctx.skills` (`@deepseek-ai/dsh-skill`'s registry) is layered and **add-only**:
 * `register()` adds into the calling context's scope layer and `list({scope})`
 * merges the scope chain, so there is no way to subtract the host's catalog for
 * one child. The catalog a child *sees* therefore cannot express a whitelist.
 *
 * Enforcement therefore happens where it can be authoritative — at the moment a
 * skill-loading tool is invoked: a monotonic `ctx.tools.guard` resolves the
 * calling agent's role binding (recorded by `team_delegate`) and denies a
 * request for a skill outside the role's `skills` list. A guard is preferred
 * over a `tools/pre-execute` listener because guards have no allow result, so
 * listener ordering cannot turn the denial back into permission.
 *
 * The gate is deliberately permissive about everything it cannot answer: no
 * binding, no whitelist, an unparseable argument or an unreadable binding file
 * all mean "not our business" and the call proceeds. It never throws.
 *
 * @module dsh-role-guard/skill-gate
 */

import type { AgentLike, Logger } from 'dsh-eng-core'
import type { RoleBinding, RoleBindingStore } from './bindings.js'
import type { RoleGuardConfig } from './config.js'

/** Argument keys a skill-loading tool may use for the requested skill id (first string wins). */
export const SKILL_ARG_KEYS: readonly string[] = ['name', 'skill', 'skill_id', 'id']

/** Structural view of one tool execution (see `@deepseek-ai/dsh-tools`). */
interface ExecutionLike {
    name?: unknown
    arguments?: unknown
    agent?: AgentLike
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
}

/**
 * The skill id a call asks for, from the first recognised string argument.
 *
 * A JSON-encoded argument object is accepted (some transports hand the
 * arguments over unparsed); anything else that is not a plain object is
 * unparseable and yields `undefined`.
 * @param args - the tool call's arguments, of unknown shape.
 */
export function requestedSkill(args: unknown): string | undefined {
    let record = asRecord(args)
    if (record === undefined && typeof args === 'string') record = asRecord(safeParse(args))
    if (record === undefined) return undefined
    for (const key of SKILL_ARG_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

/** The Chinese, actionable denial for one refused skill load. */
export function refusalReason(binding: RoleBinding, skill: string): string {
    const lines = [
        `技能白名单拒绝：角色 "${binding.roleId}"（${binding.role}，mode=${binding.mode}）不能加载技能 "${skill}"。`,
        `该角色允许的技能：${binding.skills.join(', ')}。`,
        '这是宿主在调用时强制的硬约束，不是建议：换参数名、改大小写或换个写法都不会让加载生效。',
        '需要白名单外的技能时，把「你要做什么 + 为什么需要它」写进汇报交回主 Agent，由它决定是否调整角色文件或自己执行。',
    ]
    if (binding.mode === 'read') {
        lines.push('（你是只读角色：能用的技能同样由白名单限定。）')
    }
    return lines.join('\n')
}

/** Everything the gate closes over. */
export interface SkillGateDeps {
    config: RoleGuardConfig
    /** Session → role bindings recorded by `team_delegate`. */
    bindings: RoleBindingStore
    logger?: Logger
}

/**
 * Build the guard.
 *
 * Cost per tool call: one array lookup on the tool name; only a call to a
 * configured skill tool touches the binding store (one `stat`, plus one small
 * `readJson` when cold).
 */
export function createSkillGuard(deps: SkillGateDeps): (exec: unknown) => string | undefined {
    return (exec: unknown): string | undefined => {
        try {
            if (!deps.config.enforceSkillWhitelist) return undefined
            const execution = asRecord(exec)
            if (execution === undefined) return undefined
            const toolName = execution['name']
            if (typeof toolName !== 'string' || !deps.config.skillTools.includes(toolName)) return undefined
            const skill = requestedSkill(execution['arguments'])
            if (skill === undefined) return undefined
            const binding = deps.bindings.resolve((execution as ExecutionLike).agent)
            if (binding === undefined || binding.skills.length === 0) return undefined
            if (binding.skills.includes(skill)) return undefined
            return refusalReason(binding, skill)
        } catch (error) {
            // A guard that throws would break the tool call it merely observes.
            deps.logger?.debug('skill gate failed open:', error)
            return undefined
        }
    }
}

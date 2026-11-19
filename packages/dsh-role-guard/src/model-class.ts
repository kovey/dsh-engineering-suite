/**
 * `model: @planner` / `model: @worker` — a role that names a MODEL CLASS.
 *
 * A role file already carries a literal route (`provider/model`). The split
 * workflow needs one more indirection: the SAME role definition must run on the
 * model the PROJECT configured (`.dsh/engineering-suite/models.json`), because
 * "the planner model" is a property of the repository, not of one profile. So a
 * role may write `model: @planner` and the loader fills in the class's
 * `provider` / `model` / `reasoningEffort`.
 *
 * Two rules keep the indirection from becoming a silent downgrade:
 *
 *  - a literal `provider/model` is NEVER touched (the old behaviour is exact);
 *  - an unresolvable class is REPORTED, never replaced by the host default. A
 *    role that asked for the planner model and silently ran on the host's cheap
 *    default is the exact failure this feature exists to prevent, so the role
 *    keeps its `modelProblems` and every dispatch path refuses it by name.
 *
 * @module dsh-role-guard/model-class
 */

import type { Layout } from 'dsh-eng-core'
import { loadModelsConfig, type ModelClassConfig } from 'dsh-eng-core/split'
import type { Role, RoleRegistry } from './roles.js'

/** Prefix that marks a model class reference. */
export const MODEL_CLASS_PREFIX = '@'

/** The classes that carry a model (the other two carry numbers, not routes). */
export const MODEL_CLASSES = ['planner', 'worker'] as const

/** A model class a role may reference. */
export type RoleModelClass = (typeof MODEL_CLASSES)[number]

/** A logger shape (the loader's own, structurally). */
interface WarnSink {
    warn: (message: string, error?: unknown) => void
}

/**
 * The class a role's `model` field references.
 * @param role - the resolved role.
 * @returns the class name (without `@`), or `undefined` for a literal route.
 */
export function modelClassRefOf(role: Role): string | undefined {
    const model = role.model
    if (model === undefined || !model.startsWith(MODEL_CLASS_PREFIX)) return undefined
    return model.slice(MODEL_CLASS_PREFIX.length).trim()
}

/** `provider/model` split, exactly like a role file's literal shorthand. */
function splitRoute(value: string): { provider?: string; model: string } {
    const slash = value.indexOf('/')
    if (slash <= 0) return { model: value }
    const provider = value.slice(0, slash).trim()
    const model = value.slice(slash + 1).trim()
    return provider === '' || model === '' ? { model: value } : { provider, model }
}

/** One unresolvable reference, with the fix (never a silent fallback). */
function unresolved(role: Role, className: string, detail: string): Role {
    return { ...role, modelProblems: [`角色 ${role.id} 的 model: ${MODEL_CLASS_PREFIX}${className} 无法解析：${detail}`] }
}

/** The route a class config can supply, and whether it has a model at all. */
function classRoute(config: ModelClassConfig): { provider?: string; model: string; reasoningEffort?: string } | undefined {
    const model = config.model
    if (model === undefined || model === '') return undefined
    const parsed = splitRoute(model)
    return {
        ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
        model: parsed.model,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
}

/** Fill a role's route from one models class (the role's own fields win per field). */
function fillFromClass(role: Role, route: { provider?: string; model: string; reasoningEffort?: string }): Role {
    const provider = role.provider ?? route.provider
    const effort = role.reasoningEffort ?? route.reasoningEffort
    return {
        ...role,
        ...(provider === undefined ? {} : { provider }),
        model: route.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
}

/**
 * Resolve one role's `@class` reference against the workspace's `models.json`.
 *
 * @param role - the role as parsed (its literal route is left untouched).
 * @param layout - workspace layout; `models.json` lives at `<configDir>/models.json`.
 * @returns the same role, with the class's route filled in, or with
 *   `modelProblems` naming the missing class. Never throws.
 */
export function resolveRoleModelClass(role: Role, layout: Layout): Role {
    const ref = modelClassRefOf(role)
    if (ref === undefined) return role
    if (!(MODEL_CLASSES as readonly string[]).includes(ref)) {
        return unresolved(role, ref, `models.json 没有这个类（可用：${MODEL_CLASSES.join(' / ')}）`)
    }
    const resolved = loadModelsConfig(layout)
    const config = resolved.config[ref as RoleModelClass]
    const route = classRoute(config)
    if (route === undefined) {
        return unresolved(
            role,
            ref,
            `${resolved.file}${resolved.present ? '' : '（文件不存在）'} 的 ${ref} 段没有配置 model（缺失的类：${ref}）；` +
                '不会回退宿主默认模型——请在该文件的 ' + `${ref} 段写 "model": "provider/model"`,
        )
    }
    return fillFromClass(role, route)
}

/**
 * Resolve every role of one registry (called once, after all layers load).
 *
 * A resolved role replaces its entry in the registry; an unresolved one stays
 * listable (with its problems) so `role_list` can explain what to fix.
 * @param registry - the registry to resolve in place.
 * @param layout - the workspace layout consulted for `models.json`.
 * @param logger - diagnostics sink for every unresolved reference.
 */
export function resolveModelClassRoles(registry: RoleRegistry, layout: Layout, logger: WarnSink): void {
    for (const role of registry.list()) {
        if (modelClassRefOf(role) === undefined) continue
        const resolved = resolveRoleModelClass(role, layout)
        for (const problem of resolved.modelProblems ?? []) logger.warn(problem)
        registry.add(resolved)
    }
}

/**
 * The refusal text for a role whose model class did not resolve.
 *
 * Shared by every dispatch path (`team_delegate` and the `role-guard` service)
 * so an autonomous dispatcher and the model-facing tool cannot disagree about
 * whether a role is usable.
 * @param role - the role about to be dispatched.
 * @returns the refusal paragraph, or `undefined` when the role's route is fine.
 */
export function modelClassRefusal(role: Role): string | undefined {
    const problems = role.modelProblems ?? []
    if (problems.length === 0) return undefined
    return [
        `角色 "${role.id}" 的模型类引用无法解析，按 fail closed 拒绝派发。`,
        ...problems.map((problem) => `- ${problem}`),
        '下一步：在项目级 models.json 里给对应段配置 model（例如 { "planner": { "model": "provider/model" } }），',
        '或把角色文件里的 @类引用换成显式 provider/model；不会回退宿主默认模型（那样会把拆分/实现悄悄跑在别的模型上）。',
    ].join('\n')
}


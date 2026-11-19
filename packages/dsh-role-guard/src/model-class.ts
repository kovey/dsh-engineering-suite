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
 * Three rules keep the indirection from becoming a silent downgrade:
 *
 *  - a literal `provider/model` is NEVER touched (the old behaviour is exact);
 *  - a class that EXISTS but has no `model` is a reported FALLBACK, not a
 *    refusal: the role is dispatched on the host default (the request carries
 *    no `model`/`provider`) and every surface prints the note
 *    「模型类 <class> 未配置，使用宿主默认」. A missing class is optional
 *    configuration — the same rule `models.json` follows for the split runner;
 *  - a reference that is WRONG (a class name outside `planner` / `worker`, an
 *    empty `@`, invalid syntax) stays a hard error naming the class and the
 *    usable ones. Treating a typo as "unconfigured" would swallow exactly the
 *    mistake a human needs to see.
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
interface RoleLogSink {
    warn: (message: string, error?: unknown) => void
    /** The fallback note is informational, never a warning (AC-001). */
    info?: (message: string) => void
}

/** The classes a human may write, as one readable list. */
function usableClasses(): string {
    return MODEL_CLASSES.join(' / ')
}

/**
 * The sentence a fallback carries (AC-001): the class exists but has no model,
 * so the child runs on the host default. Reported, never raised.
 * @param className - the class the role referenced.
 */
export function modelClassFallbackNote(className: string): string {
    return `模型类 ${className} 未配置，使用宿主默认`
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

/** One wrong reference, with the fix (a typo is never a silent fallback). */
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
 * The reported fallback: no class route, so the request must carry NO route.
 *
 * `model`/`provider` are dropped rather than set to the reference text: leaving
 * `@planner` in place would hand the provider an unroutable model, and keeping
 * a `provider` alone would pin a route the project never configured. The role's
 * own `reasoningEffort` / `maxTokens` survive — those are role settings, not
 * class settings.
 * @param role - the role whose `@class` is unconfigured.
 * @param className - the class the role named (for the note).
 */
function fallbackToHostDefault(role: Role, className: string): Role {
    const copy: Role = { ...role, modelNote: modelClassFallbackNote(className) }
    delete copy.model
    delete copy.provider
    return copy
}

/**
 * Resolve one role's `@class` reference against the workspace's `models.json`.
 *
 * @param role - the role as parsed (its literal route is left untouched).
 * @param layout - workspace layout; `models.json` lives at `<configDir>/models.json`.
 * @returns the same role, with the class's route filled in; or with an empty
 *   route plus `modelNote` when the class has no model; or with
 *   `modelProblems` naming a WRONG reference. Never throws.
 */
export function resolveRoleModelClass(role: Role, layout: Layout): Role {
    const ref = modelClassRefOf(role)
    if (ref === undefined) return role
    if (ref === '') {
        return unresolved(role, ref, `${MODEL_CLASS_PREFIX} 后面没有类名（可用：${usableClasses()}）`)
    }
    if (!(MODEL_CLASSES as readonly string[]).includes(ref)) {
        return unresolved(role, ref, `models.json 没有这个类（可用：${usableClasses()}）`)
    }
    const resolved = loadModelsConfig(layout)
    const route = classRoute(resolved.config[ref as RoleModelClass])
    // A class that exists but has no model is OPTIONAL configuration, not an
    // error: dispatch on the host default and say so. The note is the whole
    // difference between "a documented fallback" and "a silent downgrade".
    if (route === undefined) return fallbackToHostDefault(role, ref)
    return fillFromClass(role, route)
}

/**
 * Resolve every role of one registry (called once, after all layers load).
 *
 * A resolved role replaces its entry in the registry; a wrong reference stays
 * listable (with its problems) so `role_list` can explain what to fix.
 * @param registry - the registry to resolve in place.
 * @param layout - the workspace layout consulted for `models.json`.
 * @param logger - diagnostics sink; fallbacks are `info`, wrong references `warn`.
 */
export function resolveModelClassRoles(registry: RoleRegistry, layout: Layout, logger: RoleLogSink): void {
    for (const role of registry.list()) {
        if (modelClassRefOf(role) === undefined) continue
        const resolved = resolveRoleModelClass(role, layout)
        if (resolved.modelNote !== undefined) {
            logger.info?.(`角色 "${resolved.id}"：${resolved.modelNote}（派发请求不带 model/provider）`)
        }
        for (const problem of resolved.modelProblems ?? []) logger.warn(problem)
        registry.add(resolved)
    }
}

/**
 * The result-header line of a fallback (empty when the class resolved).
 * @param role - the role being dispatched.
 */
export function modelClassNoteLines(role: Role): string[] {
    return role.modelNote === undefined ? [] : [`note: ${role.modelNote}`]
}

/**
 * Log one fallback at the dispatch point.
 *
 * Shared by `team_delegate` and the service seam so both log the same sentence;
 * `where` names the caller. `info` on purpose: an unconfigured class is a
 * documented state, not an error (AC-001).
 * @param role - the role being dispatched.
 * @param logger - the caller's logger (possibly absent).
 * @param where - the dispatch path, as it should read in the log.
 */
export function logModelClassFallback(role: Role, logger: { info?: (message: string) => void } | undefined, where: string): void {
    if (role.modelNote === undefined) return
    logger?.info?.(`${where} 角色 "${role.id}"：${role.modelNote}（派发请求不带 model/provider）`)
}

/**
 * The `role_list` tail: wrong references (refused) and fallbacks (dispatched).
 * @param roles - every role of the registry.
 */
export function modelClassReport(roles: readonly Role[]): string[] {
    const problems = roles.flatMap((role) => role.modelProblems ?? [])
    const notes = roles.flatMap((role) => (role.modelNote === undefined ? [] : [`- ${role.id}：${role.modelNote}`]))
    return [
        ...(problems.length === 0 ? [] : ['', '模型类引用无法解析（类名写错；这些角色不会被派发）：', ...problems.map((problem) => `- ${problem}`)]),
        ...(notes.length === 0 ? [] : ['', '模型类未配置（按规则回退宿主默认，派发照常进行）：', ...notes]),
    ]
}

/**
 * The refusal text for a role whose model class reference is WRONG.
 *
 * Shared by every dispatch path (`team_delegate` and the `role-guard` service)
 * so an autonomous dispatcher and the model-facing tool cannot disagree about
 * whether a role is usable. Reached only for a typo / empty `@` — an
 * unconfigured class is a fallback and never gets here.
 * @param role - the role about to be dispatched.
 * @returns the refusal paragraph, or `undefined` when the role's route is fine.
 */
export function modelClassRefusal(role: Role): string | undefined {
    const problems = role.modelProblems ?? []
    if (problems.length === 0) return undefined
    return [
        `角色 "${role.id}" 的模型类引用无法解析，按 fail closed 拒绝派发。`,
        ...problems.map((problem) => `- ${problem}`),
        `可用模型类：${usableClasses()}。`,
        '类名写错不会被当成"未配置"放过，否则拼写错误会被静默吞掉。',
        '下一步：① 检查角色文件里的 @类名是否拼写正确；② 确实要用某个类，就在项目级 models.json 里给对应段配置 model（例如 { "planner": { "model": "provider/model" } }）；或把角色文件里的 @类引用换成显式 provider/model。',
        '（"类已配置但没写 model"是另一条路径：回退宿主默认并给出一条 note，不会走到这里。）',
    ].join('\n')
}



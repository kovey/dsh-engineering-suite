/**
 * The effective LLM route of a delegated child.
 *
 * A role file (or an inline role) already declares a route — `model`,
 * `reasoningEffort`, `maxTokens` — and `team_delegate` hands it to the provider
 * as `agentOptions`. Per-stage model routing needs one more layer: the caller
 * may override that route for a single delegation (`model` /
 * `reasoningEffort` / `maxTokens`), because the difficulty of *this* piece of
 * work is known at the call site, not in the role file.
 *
 * Precedence is **explicit call parameter > role file > host default**, resolved
 * per field, so a call that overrides only `reasoningEffort` keeps the role's
 * model.
 *
 * A malformed parameter is never silently dropped *and* never silently
 * applied: it is reported and that one field falls back to the role's route
 * (or the host default), because a broken route would send the child to an
 * unintended — usually more expensive, sometimes unavailable — model.
 *
 * @module dsh-role-guard/route
 */

import type { Role } from './roles.js'

/** Which layer decided a route field. */
export type RouteSource = 'call' | 'role' | 'host'

/** The route actually handed to the child as `agentOptions`; every field is optional. */
export interface EffectiveRoute {
    provider?: string
    model?: string
    reasoningEffort?: string
    maxTokens?: number
}

/** The three `team_delegate` override parameters, of unknown runtime shape. */
export interface RouteOverride {
    model?: unknown
    reasoningEffort?: unknown
    maxTokens?: unknown
}

/** One resolved route plus why it looks the way it does. */
export interface RouteResolution {
    route: EffectiveRoute
    /** The layer that decided the provider/model pair. */
    source: RouteSource
    /** The layer that decided `reasoningEffort` (absent when the field is unset). */
    effortSource?: RouteSource
    /** The layer that decided `maxTokens` (absent when the field is unset). */
    maxTokensSource?: RouteSource
    /** Malformed call parameters that were ignored (reported, never silent). */
    problems: string[]
    /** Call parameters dropped because the host forbids overriding. */
    ignored: string[]
}

/** Provenance labels used in the delegation result. */
export const ROUTE_SOURCE_LABEL: Record<RouteSource, string> = {
    call: '调用覆盖',
    role: '角色文件',
    host: '宿主默认',
}

/** Parameter names checked, in the order they are reported. */
export const ROUTE_OVERRIDE_KEYS: readonly string[] = ['model', 'reasoningEffort', 'maxTokens']

/** The route fields a role may declare. */
export type RoleRoute = Pick<Role, 'provider' | 'model' | 'reasoningEffort' | 'maxTokens'>

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A short type name for error messages (`42` → `number`). */
function typeName(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

/**
 * The route a role declares. Re-validated even though the role parser already
 * filtered these fields, so a hand-built `Role` cannot inject an empty string
 * or a non-positive token cap.
 * @param role - the resolved role.
 */
export function roleRoute(role: RoleRoute): EffectiveRoute {
    const provider = text(role.provider)
    const model = text(role.model)
    const reasoningEffort = text(role.reasoningEffort)
    const maxTokens = typeof role.maxTokens === 'number' && Number.isFinite(role.maxTokens) && role.maxTokens > 0 ? role.maxTokens : undefined
    return {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
    }
}

/**
 * How a route reads in a tool result: `provider/model`, a bare provider, or
 * `宿主默认` when this plugin hands no route over.
 * @param route - the route to render.
 */
export function routeText(route: EffectiveRoute): string {
    if (route.model === undefined) return route.provider ?? '宿主默认'
    return route.provider === undefined ? route.model : `${route.provider}/${route.model}`
}

function annotation(source: RouteSource | undefined, base: RouteSource): string {
    return source === undefined || source === base ? '' : ` 来自${ROUTE_SOURCE_LABEL[source]}`
}

/**
 * The provenance line of a delegation result:
 * `模型：deepseek-official/deepseek-v4-pro（调用覆盖；effort=high）` /
 * `模型：…（角色文件）` / `模型：宿主默认`.
 * @param resolution - the resolved route.
 */
export function routeLine(resolution: RouteResolution): string {
    const parts: string[] = []
    if (resolution.route.reasoningEffort !== undefined) {
        parts.push(`effort=${resolution.route.reasoningEffort}${annotation(resolution.effortSource, resolution.source)}`)
    }
    if (resolution.route.maxTokens !== undefined) {
        parts.push(`maxTokens=${resolution.route.maxTokens}${annotation(resolution.maxTokensSource, resolution.source)}`)
    }
    // `宿主默认` is itself the provenance, so it carries no label of its own.
    const label = resolution.source === 'host' ? '' : ROUTE_SOURCE_LABEL[resolution.source]
    const inside = [label, ...parts].filter((part) => part !== '').join('；')
    return inside === '' ? `模型：${routeText(resolution.route)}` : `模型：${routeText(resolution.route)}（${inside}）`
}

/** The call parameters that were supplied at all (even with a malformed value). */
export function suppliedOverrides(override: RouteOverride): string[] {
    const names: string[] = []
    for (const key of ROUTE_OVERRIDE_KEYS) {
        if (override[key as keyof RouteOverride] !== undefined) names.push(key)
    }
    return names
}

/**
 * Read the `model` parameter: `provider/model` (the role-file shorthand) or a
 * bare model id, which keeps the role's provider.
 * @returns the parsed pair, or `undefined` when the value is unusable.
 */
function readModel(
    raw: unknown,
    roleProvider: string | undefined,
    fallback: string,
    problems: string[],
): { provider?: string; model: string } | undefined {
    if (typeof raw !== 'string') {
        problems.push(`model 覆盖参数无效（期望字符串，收到 ${typeName(raw)}）：已忽略该字段，沿用${fallback}。`)
        return undefined
    }
    const value = raw.trim()
    if (value === '') {
        problems.push(`model 覆盖参数无效（空字符串）：已忽略该字段，沿用${fallback}。`)
        return undefined
    }
    const slash = value.indexOf('/')
    if (slash < 0) {
        // A bare model id is only usable when a provider is known: the role's
        // own provider. Otherwise the harness would receive a model it cannot
        // route, which is exactly the "broken route" this check exists for.
        if (roleProvider === undefined) {
            problems.push(`model 覆盖参数无效（裸模型 id "${value}"，但角色路由也没有 provider）：已忽略该字段，沿用${fallback}。`)
            return undefined
        }
        return { model: value }
    }
    const provider = value.slice(0, slash).trim()
    const model = value.slice(slash + 1).trim()
    if (provider === '' || model === '') {
        problems.push(`model 覆盖参数无效（"${value}" 缺少 provider 或 model 部分）：已忽略该字段，沿用${fallback}。`)
        return undefined
    }
    return { provider, model }
}

/**
 * Merge the three call parameters over the role's route.
 * @param role - the resolved role; its route is the fallback for every field.
 * @param override - the raw `team_delegate` arguments.
 * @param allowOverride - the host switch; `false` ignores every override.
 */
export function resolveRoute(role: RoleRoute, override: RouteOverride, allowOverride: boolean): RouteResolution {
    const route = roleRoute(role)
    const problems: string[] = []
    const ignored = allowOverride ? [] : suppliedOverrides(override)
    const roleSource: RouteSource = route.provider === undefined && route.model === undefined ? 'host' : 'role'
    let source: RouteSource = roleSource
    let effortSource: RouteSource | undefined = route.reasoningEffort === undefined ? undefined : 'role'
    let maxTokensSource: RouteSource | undefined = route.maxTokens === undefined ? undefined : 'role'

    if (allowOverride) {
        if (override.model !== undefined) {
            const roleModelText = routeText({ ...(route.provider === undefined ? {} : { provider: route.provider }), ...(route.model === undefined ? {} : { model: route.model }) })
            const fallback = roleSource === 'role' ? `角色路由的 model（${roleModelText}）` : '宿主默认'
            const parsed = readModel(override.model, route.provider, fallback, problems)
            if (parsed !== undefined) {
                const provider = parsed.provider ?? route.provider
                if (provider === undefined) delete route.provider
                else route.provider = provider
                route.model = parsed.model
                source = 'call'
            }
        }
        if (override.reasoningEffort !== undefined) {
            const value = text(override.reasoningEffort)
            if (value === undefined) {
                const fallback = route.reasoningEffort === undefined ? '宿主默认' : `角色路由的 reasoningEffort（${route.reasoningEffort}）`
                problems.push(
                    `reasoningEffort 覆盖参数无效（期望非空字符串，收到 ${typeName(override.reasoningEffort)}）：已忽略该字段，沿用${fallback}。`,
                )
            } else {
                route.reasoningEffort = value
                effortSource = 'call'
            }
        }
        if (override.maxTokens !== undefined) {
            const raw = override.maxTokens
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
                const fallback = route.maxTokens === undefined ? '宿主默认' : `角色路由的 maxTokens（${route.maxTokens}）`
                const received = typeof raw === 'number' ? `number ${raw}` : typeName(raw)
                problems.push(`maxTokens 覆盖参数无效（期望正整数，收到 ${received}）：已忽略该字段，沿用${fallback}。`)
            } else {
                route.maxTokens = raw
                maxTokensSource = 'call'
            }
        }
    }

    return {
        route,
        source,
        ...(effortSource === undefined ? {} : { effortSource }),
        ...(maxTokensSource === undefined ? {} : { maxTokensSource }),
        problems,
        ignored,
    }
}

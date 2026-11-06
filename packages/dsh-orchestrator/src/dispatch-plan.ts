/**
 * The dispatch premises and the two start paths (harness 0.2.2-rc.1).
 *
 * `dispatchStage` cannot start a child unless its premises hold. On the modern
 * host the child's identity and tool restriction travel as an Agent Preset, so
 * the premises are:
 *
 *   ① the service exposes `startActivation(spec)` (0.2.2-rc.1) — or, on an old
 *     host, still exposes the legacy `start(provider, request)`;
 *   ② an `agentPresets` registry exists (the only way a restriction travels);
 *   ③ this plugin registered the stage role's preset (somebody else's same-id
 *     preset is not ours to vouch for);
 *   ④ the configured provider is registered (and can carry an independent
 *     preset — without that capability the restriction cannot be enforced, which
 *     would quietly drop the anti-recursion guard).
 *
 * A missing premise is answered with an **actionable refusal**, never with a
 * degraded dispatch: refusing costs one stage of automation, silently widening
 * a child's rights costs the pipeline (recursion, measured once as ~800 child
 * sessions from a single stage entry).
 *
 * @module dsh-orchestrator/dispatch-plan
 */

import type { AgentLike } from 'dsh-eng-core'
import type { DispatchPresetRegistry, PresetFilter, PresetStatus } from './presets.js'

/** One child result, as both dispatch paths deliver it. */
export interface ChildResultLike {
    stopReason: string
    output: readonly { type: string; text?: string }[]
    diagnostic?: string
}

/** One started child, normalised from an activation or a legacy run. */
export interface ChildRunLike {
    id: string
    result: Promise<ChildResultLike>
    dispose?: () => Promise<void>
}

/** The execution options a child may be started with. */
export interface ChildAgentOptionsLike {
    provider?: string
    model?: string
    reasoningEffort?: string
    maxTokens?: number
}

/**
 * The part of `SubagentStartRequest` this plugin supplies.
 *
 * `persona` and `toolFilter` are deliberately absent: 0.2.2-rc.1 removed both,
 * and the legacy request type below is the only place they still exist.
 */
export interface SubagentRequestLike {
    prompt: { type: 'text'; text: string }[]
    parent: AgentLike
    agentOptions?: ChildAgentOptionsLike
    /** Independent preset selection; the host mounts it into the child scope. */
    agentPreset?: string
    maxDepth?: number
}

/** `SubagentActivationSpec` (0.2.2-rc.1). */
export interface ActivationSpecLike {
    provider: string
    label: string
    request: SubagentRequestLike
    signal: AbortSignal
    delivery: 'parent' | 'caller'
}

/** `SubagentActivation` (0.2.2-rc.1). */
export interface ActivationLike {
    childId: string
    messageId?: string
    result: Promise<ChildResultLike>
    dispose: () => Promise<void>
}

/** The old host's request: persona, a tool filter AND the signal rode along in it. */
export interface LegacyRequestLike extends SubagentRequestLike {
    label?: string
    signal: AbortSignal
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    persona?: string
}

/** Structural view of `ctx.subagents` (0.2.2-rc.1, plus the legacy seam). */
export interface SubagentsLike {
    /** Modern start: every child is established under the activation manager. */
    startActivation?: (spec: ActivationSpecLike) => Promise<ActivationLike>
    /** Legacy start (pre-0.2.2): kept so an old host keeps working. */
    start?: (provider: string, request: LegacyRequestLike) => Promise<ChildRunLike>
    /** Registered provider names (used to refuse an unknown provider by name). */
    list?: () => string[]
    /** One provider descriptor; `capabilities.agentPreset` decides whether a preset can ride along. */
    getProvider?: (name: string) => { name?: string; capabilities?: { agentPreset?: boolean } } | undefined
}

const PKG_SUBAGENT = '@deepseek-ai/dsh-subagent'
const PKG_PROVIDER = '@deepseek-ai/dsh-subagent-spawn-in-process'
const PKG_PRESETS = '@deepseek-ai/dsh-agent-preset-registry'
const REPAIR_CLOSURE = 'bash scripts/repair-profile-closure.sh --apply'

/** Both dispatch APIs are absent: nothing can start a child. */
export function missingDispatchRefusal(): string {
    return [
        '宿主既没有 `subagents.startActivation`，也没有旧的 `subagents.start(provider, request)`：orchestrator 无法派发子代理（fail closed，不降级）。',
        `缺失的 API：${PKG_SUBAGENT} 的 startActivation（本插件按 0.2.2-rc.1 的 d.ts 对接；旧的 start(provider, request) 在该版本已不存在）。`,
        `应挂载的包：${PKG_SUBAGENT} + 一个具体 provider（如 ${PKG_PROVIDER}）+ ${PKG_PRESETS}（提供 ctx.agentPresets）。`,
        `如果这些包已经在 profile 的 bundles 里却仍然解析不到，说明 profile 的共享闭包过期了（悬空软链不会自己报错）：${REPAIR_CLOSURE} 后重启宿主。`,
    ].join('\n')
}

/** `startActivation` exists but the preset registry does not: no way to carry the restriction. */
export function missingPresetsRefusal(role: string | undefined): string {
    const owner = role === undefined ? '本阶段（未声明角色）' : `阶段角色 "${role}"`
    return [
        `${owner} 的 persona 与工具限制只能通过 Agent Preset 交给子作用域（新宿主的启动请求没有 persona/toolFilter 字段），而宿主没有装配 agentPresets 服务：拒绝派发。`,
        `缺失的服务：ctx.agentPresets（${PKG_PRESETS}）。`,
        `下一步：在 profile 的 bundles 里挂载 ${PKG_PRESETS}（0.2.2-rc.1 把旧的 dsh-agent-presets 拆成了 agent-preset + agent-preset-registry 两个包）。`,
        `如果它已经在 bundles 里，说明 profile 的共享闭包过期了：${REPAIR_CLOSURE} 后重启宿主。`,
    ].join('\n')
}

const PRESET_REASON_TEXT: Record<string, string> = {
    unavailable: '宿主没有 agentPresets 服务',
    foreign: '该 id 被其他插件注册了，不是 dsh-orchestrator 注册的',
    stale: '注册时的工具限制与本次派发要用的限制不一致',
    failed: '注册失败',
}

/** The stage's preset is not usable: never fall back to a prompt-only restriction. */
export function presetRefusal(role: string | undefined, status: PresetStatus): string {
    const reason = PRESET_REASON_TEXT[status.reason ?? 'failed'] ?? '不可用'
    const owner = role === undefined ? '本阶段（未声明角色）' : `阶段角色 "${role}"`
    return [
        `${owner} 的 Agent Preset "${status.id}" 不可用（${reason}）：拒绝派发，不降级成"只写提示词"。`,
        ...(status.detail === undefined ? [] : [`细节：${status.detail}`]),
        '下一步：重启宿主让 dsh-orchestrator 重新注册 preset（注册发生在第一次派发，工具限制在注册时被固化）；',
        '若仍然失败，看 orchestrator 日志里的 "agent preset ... 注册失败"，并用 role_list 确认角色文件本身能解析。',
    ].join('\n')
}

/** The configured provider is not registered on the service. */
export function unknownProviderRefusal(provider: string, providers: readonly string[]): string {
    return [
        `子代理 provider "${provider}" 没有注册：拒绝派发（不会自动改用列表里的第一个——那会悄悄换掉运行位置）。`,
        `已注册的 provider（service.list()）：${providers.length === 0 ? '(空)' : providers.join(', ')}。`,
        `下一步：在 profile 里挂载提供它的包（${PKG_PROVIDER} 注册的 provider 名是 "spawn"），或把 autoDispatch.provider 改成上面列出的名字。`,
    ].join('\n')
}

/** The provider exists but cannot carry an independent preset. */
export function unsupportedProviderRefusal(provider: string): string {
    return [
        `子代理 provider "${provider}" 不支持独立 Agent Preset（capabilities.agentPreset = false）：本阶段的工具限制无法由宿主强制（orchestrate 也就剔不掉），拒绝派发。`,
        `下一步：改用支持 agentPreset 的 provider（${PKG_PROVIDER} 的 "spawn" 支持它）。`,
    ].join('\n')
}

/** How this dispatch will start its child. */
export type DispatchPlan = { kind: 'activation'; presetId: string } | { kind: 'legacy' } | { kind: 'refused'; reason: string }

/**
 * The provider-side problem that would make a preset dispatch meaningless.
 * @param subagents - the service.
 * @param provider - the configured provider name.
 * @returns a refusal message, or `undefined` when the provider is usable.
 */
function providerProblem(subagents: SubagentsLike, provider: string): string | undefined {
    if (typeof subagents.list !== 'function') return undefined
    let providers: string[]
    try {
        providers = subagents.list()
    } catch {
        // A service that cannot enumerate its providers is not evidence that this
        // one is missing; the start itself still validates it.
        return undefined
    }
    if (!Array.isArray(providers)) return undefined
    if (!providers.includes(provider)) return unknownProviderRefusal(provider, providers)
    let capability: boolean | undefined
    try {
        capability = subagents.getProvider?.(provider)?.capabilities?.agentPreset
    } catch {
        capability = undefined
    }
    // Only an explicit `false` refuses: an unknown descriptor shape must not turn
    // a working deployment into a refusal.
    return capability === false ? unsupportedProviderRefusal(provider) : undefined
}

/** Everything one dispatch decision needs. */
export interface PlanInput {
    subagents: SubagentsLike
    provider: string
    /** The preset seam; absent on a hand-wired deps or a host without the service. */
    presets: DispatchPresetRegistry | undefined
    /** The stage's role id, or `undefined` when it declares none. */
    role: string | undefined
    /** The role's persona (empty/absent = no section). */
    persona: string | undefined
    /** The effective filter, ALREADY passed through `withoutOrchestrate`. */
    filter: PresetFilter
}

/**
 * Decide how (or whether) one stage's child may be started.
 *
 * The modern path wins whenever it is technically possible: `startActivation`
 * plus a preset this plugin registered. The legacy path is used ONLY when the
 * host has `start` and no `startActivation` — an old host, where persona and
 * toolFilter still ride along in the request.
 * @param input - the service, the provider, the stage role and the guarded filter.
 * @returns the plan; `refused` carries the message the caller reports.
 */
export async function planDispatch(input: PlanInput): Promise<DispatchPlan> {
    const hasActivation = typeof input.subagents.startActivation === 'function'
    if (!hasActivation && typeof input.subagents.start !== 'function') return { kind: 'refused', reason: missingDispatchRefusal() }
    if (!hasActivation) return { kind: 'legacy' }
    if (input.presets === undefined || input.presets.service() === undefined) {
        return { kind: 'refused', reason: missingPresetsRefusal(input.role) }
    }
    const status = await input.presets.ensure({ role: input.role, persona: input.persona, filter: input.filter })
    if (!status.ok) return { kind: 'refused', reason: presetRefusal(input.role, status) }
    const problem = providerProblem(input.subagents, input.provider)
    if (problem !== undefined) return { kind: 'refused', reason: problem }
    return { kind: 'activation', presetId: status.id }
}

/** The witness line naming which path started the child (and what it guarantees). */
export function dispatchLine(plan: DispatchPlan): string {
    if (plan.kind === 'activation') {
        return `派发: startActivation + Agent Preset（${plan.presetId}；工具限制在子作用域由宿主 restrict 强制，orchestrate 已剔除）`
    }
    if (plan.kind === 'legacy') {
        return '派发: legacy start(provider, request)（旧宿主：没有 startActivation，persona/toolFilter 随启动请求传递，orchestrate 已在过滤里剔除）'
    }
    return '派发: 已拒绝'
}

/** A start failure, translated into a stage-shaped explanation (never a bare TypeError). */
function startFailure(provider: string, how: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(
        [
            `子代理启动失败（provider ${provider}，${how}）：${message}`,
            '常见原因：preset 里的工具名在当前部署不存在（scope 插件会拒绝挂载），或 preset 行加载失败（profile 共享闭包过期）。',
            `下一步：先用 bash scripts/repair-profile-closure.sh --apply 修闭包并重启宿主；仍失败时改用 role_list 对照工具名。`,
        ].join('\n'),
    )
}

/** Everything one start needs, already computed by the caller. */
export interface StartInput {
    provider: string
    plan: Exclude<DispatchPlan, { kind: 'refused' }>
    label: string
    prompt: string
    parent: AgentLike
    signal: AbortSignal
    agentOptions?: ChildAgentOptionsLike
    persona?: string
    toolFilter: PresetFilter
    maxDepth?: number
}

/**
 * Start one child through the plan's path.
 * @param subagents - the service (the plan already proved the path exists).
 * @param input - provider, prompt, parent, signal and the guarded restriction.
 * @returns the normalised child run.
 */
export async function startChild(subagents: SubagentsLike, input: StartInput): Promise<ChildRunLike> {
    // `signal` is deliberately NOT part of the modern request: 0.2.2-rc.1 carries
    // it on the activation SPEC, and sending it inside `request` too would be a
    // claim about an API that does not have that field.
    const request: SubagentRequestLike = {
        prompt: [{ type: 'text', text: input.prompt }],
        parent: input.parent,
        ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    }
    if (input.plan.kind === 'activation') {
        const startActivation = subagents.startActivation
        if (startActivation === undefined) throw new Error('startActivation disappeared between the plan and the call')
        try {
            const activation = await startActivation({
                provider: input.provider,
                label: input.label,
                request: { ...request, agentPreset: input.plan.presetId },
                signal: input.signal,
                // 'caller': the result returns to this stage entry only. The child
                // is still cataloged under its parent, but a stage's product is
                // the tool output, not a second turn for the parent model.
                delivery: 'caller',
            })
            if (typeof activation?.childId !== 'string' || activation.childId === '') {
                throw new Error('宿主返回的 activation 没有 childId')
            }
            return { id: activation.childId, result: activation.result, dispose: () => activation.dispose() }
        } catch (error) {
            throw startFailure(input.provider, `startActivation + preset ${input.plan.presetId}`, error)
        }
    }
    const start = subagents.start
    if (start === undefined) throw new Error('start disappeared between the plan and the call')
    try {
        const run = await start(input.provider, {
            ...request,
            label: input.label,
            signal: input.signal,
            toolFilter: input.toolFilter,
            ...(input.persona === undefined ? {} : { persona: input.persona }),
        })
        // A provider that resolves to nothing usable must not take the stage
        // down with a TypeError.
        const id = typeof (run as { id?: unknown } | null)?.id === 'string' ? (run as { id: string }).id : undefined
        if (id === undefined) throw new Error('provider 返回了不可用的运行句柄（没有 id）')
        return { id, result: run.result, ...(run.dispose === undefined ? {} : { dispose: run.dispose }) }
    } catch (error) {
        throw startFailure(input.provider, 'legacy start(provider, request)', error)
    }
}

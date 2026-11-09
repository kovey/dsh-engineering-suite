/**
 * The **single** delegation seam: how a child agent is planned, started, and
 * given its identity + tool restriction.
 *
 * Why a shared module and not one implementation per plugin: harness 0.2.2-rc.1
 * deleted `subagents.start(provider, request)`, and `SubagentStartRequest`
 * carries neither `persona` nor `toolFilter`. A child is now created by
 * `startActivation(spec)` with `spec.request = Omit<SubagentStartRequest,
 * 'label' | 'signal'>`, and **`request.agentPreset` must be set** or the preset
 * never mounts — the child then runs with the parent's whole tool surface and
 * the deployment only *believes* it enforced a restriction. The identity and
 * the whitelist travel as an Agent Preset (`ctx.agentPresets.register(def)`,
 * async) whose rows mount in the CHILD scope; the shared row plugin is
 * `dsh-eng-core/scope`, which calls `ctx.tools.restrict(...)` + installs the
 * persona section there.
 *
 * THREE packages hand-wrote that seam and each broke independently:
 * `dsh-role-guard` (a role's persona/whitelist), `dsh-orchestrator` (a stage's
 * restriction + the anti-recursion guard) and `dsh-impact-gate` (a read-only
 * reviewer). Two were migrated; the third still called the deleted two-arg
 * `start` with `toolFilter`/`persona` and therefore started a reviewer with NO
 * restriction on 0.2.2-rc.1+. One implementation, three users — and
 * `test/delegation-seam.test.ts` fails the build if a fourth copy appears.
 *
 * The seam answers three questions and nothing else:
 *  1. {@link planDelegation} — may this child be started, and through which
 *     path? Pure decision over the service's capabilities; a missing premise is
 *     an actionable refusal, never a raw `TypeError` and never a degraded start.
 *  2. {@link startDelegation} — perform the activation (or the legacy start an
 *     old host still has) and normalise both to `{ id, result, dispose }`.
 *  3. {@link registerDelegationPreset} — register this plugin's preset, one row
 *     = the shared scope plugin, remembering which ids IT registered so a
 *     preset somebody else declared under the same id is refused instead of
 *     trusted.
 *
 * Deliberately NOT here: *what* the restriction should be. `withoutOrchestrate`
 * (the recursion guard), a role's whitelist and a reviewer's allow-list are the
 * callers' policy; this module only carries it into the child, where the host
 * enforces it.
 *
 * @module dsh-eng-core/delegation
 */

import { name as SCOPE_NAME } from './scope.js'
import type { AgentLike } from './session.js'

/** The scope plugin every preset row mounts (`dsh-eng-core/scope`). */
export const SCOPE_PLUGIN_NAME = SCOPE_NAME

/** Packages a host needs for the modern path (named in every refusal). */
export const PKG_SUBAGENT = '@deepseek-ai/dsh-subagent'
/** A concrete provider package (its registered name is `spawn`). */
export const PKG_PROVIDER = '@deepseek-ai/dsh-subagent-spawn-in-process'
/** The registry package that supplies `ctx.agentPresets`. */
export const PKG_PRESETS = '@deepseek-ai/dsh-agent-preset-registry'

/** The repair command for a stale profile closure (dangling symlinks are silent). */
export const REPAIR_CLOSURE = 'bash scripts/repair-profile-closure.sh --apply'

/** Longest preset description the roster renders well. */
export const PRESET_DESCRIPTION_MAX = 120

/**
 * The tool restriction a child scope enforces (`tools.restrict`'s arguments).
 *
 * Both sides are optional, but an EMPTY `allow` is not "no restriction": the
 * scope plugin refuses to mount it, because mounting a child with an empty
 * whitelist would be indistinguishable from granting it everything.
 */
export interface DelegationFilter {
    allow?: readonly string[]
    deny?: readonly string[]
}

/** The execution options a child may be started with. */
export interface DelegationAgentOptions {
    provider?: string
    model?: string
    reasoningEffort?: string
    maxTokens?: number
}

/**
 * The part of `SubagentStartRequest` this seam supplies.
 *
 * `persona` and `toolFilter` are deliberately absent: 0.2.2-rc.1 removed both. They
 * exist only on {@link DelegationLegacyRequest}, which models an OLD host.
 */
export interface DelegationRequest {
    prompt: { type: 'text'; text: string }[]
    parent: AgentLike
    agentOptions?: DelegationAgentOptions
    /** Absolute delegation-depth cap; the provider refuses it without `depthLimit`. */
    maxDepth?: number
}

/** `SubagentActivationSpec` (harness 0.2.2-rc.1+). */
export interface DelegationActivationSpec {
    provider: string
    label: string
    /** The modern request plus the preset that must be mounted into the child. */
    request: DelegationRequest & { agentPreset?: string }
    signal: AbortSignal
    /** `caller`: the product returns to the tool call, not as a second parent turn. */
    delivery: 'parent' | 'caller'
}

/** The child's terminal outcome, as both paths deliver it. */
export interface DelegationChildResult {
    stopReason: string
    output: readonly { type: string; text?: string }[]
    diagnostic?: string
}

/** `SubagentActivation` (harness 0.2.2-rc.1+). */
export interface DelegationActivationLike {
    childId: string
    messageId?: string
    result: Promise<DelegationChildResult>
    dispose: () => Promise<void>
}

/**
 * The old host's request: persona, a tool filter AND the signal rode along in
 * it. Kept so a pre-0.2.2 host keeps delegating instead of failing outright.
 */
export interface DelegationLegacyRequest extends DelegationRequest {
    label?: string
    signal?: AbortSignal
    toolFilter?: DelegationFilter
    persona?: string
}

/** What a legacy `start(provider, request)` resolves to. */
export interface DelegationRunLike {
    id: string
    result: Promise<DelegationChildResult>
    dispose?: () => Promise<void>
}

/**
 * Structural view of `ctx.subagents` — both the current and the legacy seam.
 *
 * Typed structurally (not imported from `@deepseek-ai/dsh-subagent`) so this
 * package keeps importing nothing from `@deepseek-ai/*`: the d.ts of the
 * installed harness is the reference the call sites were checked against.
 */
export interface DelegationServices {
    /** Modern start: every child is established under the activation manager. */
    startActivation?: (spec: DelegationActivationSpec) => Promise<DelegationActivationLike>
    /**
     * The seam harness 0.2.2-rc.1 deleted. Present only on an old host, where the
     * legacy path is the ONLY path — the modern one always wins when it exists.
     */
    start?: (provider: string, request: DelegationLegacyRequest) => Promise<DelegationRunLike>
    /** Registered provider names (used to refuse an unknown provider by name). */
    list?: () => string[]
    /** One provider descriptor; `capabilities.agentPreset` decides the modern path. */
    getProvider?: (name: string) => { name?: string; capabilities?: { agentPreset?: boolean } } | undefined
}

/** One normalised child run: both paths produce exactly this shape. */
export interface DelegationRun {
    id: string
    result: Promise<DelegationChildResult>
    /** Always present: a host that returned no disposer gets a no-op. */
    dispose: () => Promise<void>
}

/**
 * Who is delegating, for the refusal texts.
 *
 * The texts are shared; the subject is not. `dsh-role-guard` delegates a
 * `角色 "reviewer"`, `dsh-orchestrator` a `阶段角色 "developer"`, and
 * `dsh-impact-gate` a `复核子会话` — a refusal must name the thing the human
 * can go and fix, not "the child".
 */
export interface DelegationOwner {
    /** The delegating plugin (`dsh-role-guard`), named in ownership texts. */
    plugin: string
    /** What is being delegated (`角色 "reviewer"`). */
    subject: string
}

// --- the five refusals ------------------------------------------------------
//
// Every premise is checked BEFORE a child is started, and a missing one is an
// actionable refusal with the exact package/command to fix it. Refusing costs
// one delegation; a degraded start silently hands a child the parent's rights.

/** Both dispatch APIs are absent: nothing can start a child. */
export function missingDispatchRefusal(owner: DelegationOwner): string {
    return [
        `宿主既没有 \`subagents.startActivation\`，也没有旧的 \`subagents.start(provider, request)\`：${owner.plugin} 无法派发子代理（fail closed，不降级）。`,
        `缺失的 API：${PKG_SUBAGENT} 的 startActivation（本插件按 0.2.2-rc.1+ 的 d.ts 对接；旧的 start(provider, request) 在该版本已不存在）。`,
        `应挂载的包：${PKG_SUBAGENT} + 一个具体 provider（如 ${PKG_PROVIDER}）+ ${PKG_PRESETS}（提供 ctx.agentPresets）。`,
        `如果这些包已经在 profile 的 bundles 里却仍然解析不到，说明 profile 的共享闭包过期了（悬空软链不会自己报错）：${REPAIR_CLOSURE} 后重启宿主。`,
    ].join('\n')
}

/**
 * `startActivation` exists but the preset registry does not.
 *
 * The only way a persona or a whitelist reaches the child scope is a preset, so
 * without `ctx.agentPresets` there is nothing to enforce — the delegation is
 * refused rather than downgraded to "just write it in the prompt".
 */
export function missingPresetsRefusal(owner: DelegationOwner): string {
    return [
        `${owner.subject} 的 persona 与工具白名单只能通过 Agent Preset 交给子作用域（新宿主的启动请求没有 persona/toolFilter 字段），而宿主没有装配 agentPresets 服务：拒绝派发。`,
        `缺失的服务：ctx.agentPresets（${PKG_PRESETS}）。`,
        `下一步：在 profile 的 bundles 里挂载 ${PKG_PRESETS}（0.2.2-rc.1 把旧的 dsh-agent-presets 拆成了 agent-preset + agent-preset-registry 两个包）。`,
        `如果它已经在 bundles 里，说明 profile 的共享闭包过期了：${REPAIR_CLOSURE} 后重启宿主。`,
    ].join('\n')
}

/** Why a preset cannot be used for a delegation. */
export type DelegationPresetRefusalReason = 'unavailable' | 'foreign' | 'stale' | 'failed'

/** The outcome of asking for one preset. */
export interface DelegationPresetStatus {
    id: string
    ok: boolean
    reason?: DelegationPresetRefusalReason
    /** Human-readable detail (the registration error, the differing filters). */
    detail?: string
}

/**
 * The reason texts. Shared, so "which premise failed" reads the same in all
 * three plugins — and so a new reason cannot be invented at one call site.
 */
export const DELEGATION_PRESET_REASONS: Record<DelegationPresetRefusalReason, string> = {
    unavailable: '宿主没有 agentPresets 服务',
    foreign: '该 id 被其他插件注册了，不是本插件注册的',
    // Both halves matter: the registry refuses to enforce a filter nobody
    // declares any more, and the detail lists what was registered vs what is
    // wanted now.
    stale: '注册时的工具过滤与当前角色文件不一致（或策略在注册后被改动）',
    failed: '注册失败',
}

/** The plugin's preset is not usable: never fall back to a prompt-only child. */
export function presetRefusal(owner: DelegationOwner, status: DelegationPresetStatus): string {
    const reason = DELEGATION_PRESET_REASONS[status.reason ?? 'failed'] ?? '不可用'
    return [
        `${owner.subject} 的 Agent Preset "${status.id}" 不可用（${reason}）：拒绝派发，不降级成"只写提示词"。`,
        ...(status.detail === undefined ? [] : [`细节：${status.detail}`]),
        `下一步：重启宿主让 ${owner.plugin} 重新注册 preset（注册发生在插件装配或第一次派发时，工具限制在注册时被固化）；`,
        `若仍然失败，看 ${owner.plugin} 日志里的 "agent preset ... 注册失败"，并确认角色/阶段配置本身能解析。`,
    ].join('\n')
}

/** The configured provider is not registered on the service. */
export function unknownProviderRefusal(owner: DelegationOwner, provider: string, providers: readonly string[]): string {
    return [
        `子代理 provider "${provider}" 没有注册：拒绝派发（不会自动改用列表里的第一个——那会悄悄换掉运行位置）。`,
        `已注册的 provider（service.list()）：${providers.length === 0 ? '(空)' : providers.join(', ')}。`,
        `下一步：在 profile 里挂载提供它的包（${PKG_PROVIDER} 注册的 provider 名是 "spawn"），或把 ${owner.plugin} 配置的 provider 改成上面列出的名字。`,
    ].join('\n')
}

/** The provider exists but cannot carry an independent preset. */
export function unsupportedProviderRefusal(owner: DelegationOwner, provider: string): string {
    return [
        `子代理 provider "${provider}" 不支持独立 Agent Preset（capabilities.agentPreset = false）：${owner.subject} 的 persona 与工具限制无法由宿主强制，拒绝派发。`,
        `下一步：改用支持 agentPreset 的 provider（${PKG_PROVIDER} 的 "spawn" 支持它）。`,
    ].join('\n')
}

// --- the preset seam --------------------------------------------------------

/** A `PresetDefinition` as `@deepseek-ai/dsh-agent-preset-registry` declares it. */
export interface DelegationPresetDefinition {
    id: string
    name: string
    description: string
    order: number
    plugins: { id: string; name: string; config: Record<string, unknown> }[]
}

/** One preset row (the shape a preset definition carries). */
export interface DelegationPresetRow {
    id: string
    name: string
    config: Record<string, unknown>
}

/** Structural view of `ctx.agentPresets`, read per call (it may appear late). */
export interface AgentPresetsLike {
    /** Register one definition. The real one is async and resolves to a disposer. */
    register: (definition: unknown) => unknown
    /** Optional "is this id in the roster" probe (the real registry has none). */
    has?: (id: string) => boolean
}

/** A logger, narrowed to what this module uses. */
export interface DelegationPresetLogger {
    warn: (message: string, error?: unknown) => void
}

/** What one plugin needs to declare a preset. */
export interface DelegationPresetInput {
    /** Preset id, namespaced by the declaring plugin (`role:<roleId>`, `orchestrator:<role>`). */
    id: string
    /** Roster name (what a human reads in the preset list). */
    name: string
    /** Roster description; clamped to {@link PRESET_DESCRIPTION_MAX}. */
    description?: string
    /** Roster position base: the registered definition's order is `order + already registered`. */
    order: number
    /** Row id inside the preset; stable so a roster reads in a diff. */
    rowId: string
    /** The persona installed into the child scope (absent/empty = no section). */
    persona?: string
    /** The tool restriction the child scope enforces (absent = none). */
    filter?: DelegationFilter
}

/** One registration this plugin owns. */
export interface OwnedDelegationPreset {
    definition: DelegationPresetDefinition
    /** The enforcement fingerprint (the filter), for stale detection. */
    fingerprint: string
    disposer?: unknown
}

/** Dependencies of {@link createDelegationPresets}. */
export interface DelegationPresetDeps {
    /** `ctx.get('agentPresets')`, read per call (the service may appear late). */
    presets: () => AgentPresetsLike | undefined
    logger?: DelegationPresetLogger
}

/**
 * The presets one plugin registered.
 *
 * `owned` is the trust boundary: a preset somebody else registered under the
 * same id is never used as if it were ours (we cannot vouch for its persona or
 * its restriction), and `pending` keeps two concurrent callers from registering
 * one id twice — the second `register` of a duplicate id is indistinguishable
 * from "somebody else's" and would turn a working delegation into a refusal.
 */
export interface DelegationPresets {
    /** The live `agentPresets` service, or `undefined` when the host has none. */
    service(): AgentPresetsLike | undefined
    /** The ids this plugin registered (never somebody else's). */
    registeredIds(): string[]
    /** Registration problems observed so far (surfaced through the tool output). */
    problems(): readonly string[]
    /** Release the registrations this plugin owns (plugin teardown). */
    clear(): void
    /** Registered presets by id — what {@link registerDelegationPreset} trusts. */
    readonly owned: Map<string, OwnedDelegationPreset>
    /** Registrations in flight by id (deduplicates concurrent callers). */
    readonly pending: Map<string, Promise<DelegationPresetStatus>>
    /** Registration failures by id (a refusal, never a silent retry). */
    readonly failures: Map<string, string>
    /** Everything that went wrong, for the plugin log. */
    readonly issues: string[]
    /** Where registration problems and disposer failures are reported. */
    readonly logger?: DelegationPresetLogger
    /** `ctx.agentPresets`, read per call. */
    readonly lookup: () => AgentPresetsLike | undefined
}

/**
 * Create the preset registry for one plugin.
 * @param deps - the service getter and a logger.
 * @returns the registry {@link registerDelegationPreset} operates on.
 */
export function createDelegationPresets(deps: DelegationPresetDeps): DelegationPresets {
    const owned = new Map<string, OwnedDelegationPreset>()
    const pending = new Map<string, Promise<DelegationPresetStatus>>()
    const failures = new Map<string, string>()
    const issues: string[] = []
    const service = (): AgentPresetsLike | undefined => {
        try {
            return deps.presets()
        } catch {
            return undefined
        }
    }
    return {
        service,
        lookup: deps.presets,
        owned,
        pending,
        failures,
        issues,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        registeredIds: () => [...owned.keys()],
        problems: () => issues,
        clear: () => {
            for (const entry of owned.values()) release(entry, deps.logger)
            owned.clear()
            pending.clear()
        },
    }
}

/** Run one disposer, whatever shape the host returns it in. */
function release(entry: OwnedDelegationPreset, logger?: DelegationPresetLogger): void {
    const disposer = entry.disposer
    try {
        if (typeof disposer === 'function') {
            void (disposer as () => unknown)()
            return
        }
        if (typeof (disposer as PromiseLike<unknown>)?.then === 'function') {
            // Never awaited: teardown must not block on the host.
            void Promise.resolve(disposer as PromiseLike<unknown>)
                .then((unregister) => (typeof unregister === 'function' ? (unregister as () => unknown)() : undefined))
                .catch(() => undefined)
        }
    } catch (error) {
        logger?.warn(`agent preset ${entry.definition.id} disposer failed:`, error)
    }
}

/** The enforcement fingerprint of a filter (order-insensitive per side). */
export function delegationFilterFingerprint(filter: DelegationFilter | undefined): string {
    const allow = filter?.allow === undefined ? null : [...filter.allow].sort()
    const deny = filter?.deny === undefined ? null : [...filter.deny].sort()
    return JSON.stringify([allow, deny])
}

/**
 * Build one preset: a single row mounting the scope plugin.
 *
 * One row on purpose. The row's `config` is the ONLY thing that reaches the
 * child scope, so a second row could widen what this preset declares — and the
 * specifier is the imported plugin name, never a spelled-out string (a rename
 * that leaves a stale string behind produces a row the host cannot load, i.e. a
 * child with NO restriction).
 * @param input - the id scheme, the persona and the filter.
 * @returns the definition to register.
 */
export function delegationPresetDefinition(input: DelegationPresetInput): DelegationPresetDefinition {
    const description = input.description ?? input.name
    const persona = input.persona?.trim() ?? ''
    const row: DelegationPresetRow = {
        id: input.rowId,
        name: SCOPE_PLUGIN_NAME,
        config: {
            ...(persona === '' ? {} : { persona }),
            ...(input.filter?.allow === undefined ? {} : { allow: input.filter.allow }),
            ...(input.filter?.deny === undefined ? {} : { deny: input.filter.deny }),
        },
    }
    return {
        id: input.id,
        name: input.name,
        description: description.length > PRESET_DESCRIPTION_MAX ? `${description.slice(0, PRESET_DESCRIPTION_MAX - 1)}…` : description,
        order: input.order,
        plugins: [row],
    }
}

/**
 * Register one preset, idempotently, remembering that THIS plugin owns it.
 *
 * Idempotent by id and stale-checked by filter fingerprint: a plugin config (or
 * a role file) that changed after registration would otherwise be enforced with
 * the OLD restriction, so a changed fingerprint is a refusal, not a re-register.
 *
 * Never throws — the caller decides whether a non-`ok` status becomes a
 * refusal — and never claims success for a host that rejected the definition:
 * the real `register` is async and settles activation later, so its rejection
 * un-owns the id and surfaces through {@link DelegationPresetStatus}.
 * @param presets - the registry of the plugin that declares the preset.
 * @param input - the preset's id scheme, persona and filter.
 * @returns whether the preset is usable for a delegation.
 */
export async function registerDelegationPreset(presets: DelegationPresets, input: DelegationPresetInput): Promise<DelegationPresetStatus> {
    const service = presets.service()
    if (service === undefined) return { id: input.id, ok: false, reason: 'unavailable' }
    const fingerprint = delegationFilterFingerprint(input.filter)
    const tracked = presets.owned.get(input.id)
    if (tracked !== undefined) {
        if (tracked.fingerprint === fingerprint) return { id: input.id, ok: true }
        // The preset is fixed at registration while role files and configs
        // hot-reload: refusing is the only honest answer, because the child
        // would otherwise run under rights nobody declares any more.
        return {
            id: input.id,
            ok: false,
            reason: 'stale',
            detail: `注册时的工具限制 ${tracked.fingerprint}，本次要用的限制 ${fingerprint}`,
        }
    }
    const failed = presets.failures.get(input.id)
    if (failed !== undefined) return { id: input.id, ok: false, reason: 'failed', detail: failed }
    // A registration for this id is already in flight: join it instead of
    // registering twice (a duplicate id is indistinguishable from "foreign").
    const inFlight = presets.pending.get(input.id)
    if (inFlight !== undefined) return await inFlight
    const registration = performRegistration(presets, service, input, fingerprint)
    presets.pending.set(input.id, registration)
    try {
        return await registration
    } finally {
        presets.pending.delete(input.id)
    }
}

/** The actual registration, once the dedupe above has claimed the id. */
async function performRegistration(
    presets: DelegationPresets,
    service: AgentPresetsLike,
    input: DelegationPresetInput,
    fingerprint: string,
): Promise<DelegationPresetStatus> {
    if (looksRegisteredElsewhere(service, input.id)) {
        const detail = '已被其他插件注册，不是本插件注册的：无法保证它的 persona 与工具限制'
        presets.failures.set(input.id, detail)
        issue(presets, `agent preset ${input.id}: ${detail}`)
        return { id: input.id, ok: false, reason: 'foreign', detail }
    }
    const definition = delegationPresetDefinition({ ...input, order: input.order + presets.owned.size })
    try {
        // The real `register` is async and settles activation later; awaiting it
        // is what makes "the child starts only after its preset can be mounted"
        // true rather than hoped for.
        const disposer = await Promise.resolve(service.register(definition))
        presets.owned.set(input.id, { definition, fingerprint, disposer })
        return { id: input.id, ok: true }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // The registry has no `has`, so an id that already exists surfaces as a
        // duplicate-id rejection: that is somebody else's registration, never
        // something this plugin may adopt.
        const foreign = /duplicate agent preset/i.test(message)
        if (!foreign) presets.failures.set(input.id, message)
        issue(presets, `agent preset ${input.id} 注册失败：${message}`)
        return { id: input.id, ok: false, reason: foreign ? 'foreign' : 'failed', detail: message }
    }
}

/** Report one registration problem through the plugin log (the refusal carries it too). */
function issue(presets: DelegationPresets, message: string): void {
    presets.issues.push(message)
    presets.logger?.warn(message)
}

/**
 * Whether somebody else already owns this id.
 *
 * The real registry has no `has`; the probe exists for a host that does, and a
 * throwing probe is "unknown", never a crash in the middle of a delegation.
 */
function looksRegisteredElsewhere(service: AgentPresetsLike, id: string): boolean {
    if (typeof service.has !== 'function') return false
    try {
        return service.has(id) === true
    } catch {
        return false
    }
}

// --- the decision -----------------------------------------------------------

/** How a delegation will start its child. */
export type DelegationPlan = { kind: 'activation'; presetId: string } | { kind: 'legacy' } | { kind: 'refused'; reason: string }

/** Everything one delegation decision needs. */
export interface PlanDelegationInput {
    /** Who is delegating (used in the refusal texts). */
    owner: DelegationOwner
    /** The configured provider name. */
    provider: string
    /** `ctx.get('subagents')`, already required by the caller. */
    subagents: DelegationServices
    /**
     * The preset seam. Absent on a hand-wired deps (a unit test, an older
     * embedding): the activation path is then refused by name instead of
     * starting a child nothing can restrict.
     */
    presets?: DelegationPresets
    /** The preset the child must be started with (ignored on the legacy path). */
    preset: DelegationPresetInput
}

/**
 * The provider-side problem that would make a preset dispatch meaningless.
 * @param subagents - the service.
 * @param owner - who is delegating.
 * @param provider - the configured provider name.
 * @returns a refusal message, or `undefined` when the provider is usable.
 */
function providerProblem(subagents: DelegationServices, owner: DelegationOwner, provider: string): string | undefined {
    if (typeof subagents.list !== 'function') return undefined
    let providers: string[]
    try {
        providers = subagents.list()
    } catch {
        // A service that cannot enumerate its providers is not evidence that
        // this one is missing; the start itself still validates it.
        return undefined
    }
    if (!Array.isArray(providers)) return undefined
    if (!providers.includes(provider)) return unknownProviderRefusal(owner, provider, providers)
    let capability: boolean | undefined
    try {
        capability = subagents.getProvider?.(provider)?.capabilities?.agentPreset
    } catch {
        capability = undefined
    }
    // Only an explicit `false` refuses: an unknown descriptor shape must not
    // turn a working deployment into a refusal.
    return capability === false ? unsupportedProviderRefusal(owner, provider) : undefined
}

/**
 * Decide how (or whether) one delegation may start its child.
 *
 * The modern path wins whenever it is technically possible: `startActivation`
 * plus a preset this plugin registered. The legacy path is used ONLY when the
 * host has `start` and no `startActivation` — an old host, where persona and
 * toolFilter still ride along in the request.
 *
 * Every premise is checked before anything starts, and a hostile or partial
 * service is answered with a refusal: a delegation must never surface as a raw
 * `TypeError` from a host-internal call.
 * @param input - the service, the owner, the provider and the preset.
 * @returns the plan; `refused` carries the message the caller throws/reports.
 */
export async function planDelegation(input: PlanDelegationInput): Promise<DelegationPlan> {
    const hasActivation = typeof input.subagents.startActivation === 'function'
    if (!hasActivation && typeof input.subagents.start !== 'function') {
        return { kind: 'refused', reason: missingDispatchRefusal(input.owner) }
    }
    if (!hasActivation) return { kind: 'legacy' }
    if (input.presets === undefined || input.presets.service() === undefined) {
        return { kind: 'refused', reason: missingPresetsRefusal(input.owner) }
    }
    const status = await registerDelegationPreset(input.presets, input.preset)
    if (!status.ok) return { kind: 'refused', reason: presetRefusal(input.owner, status) }
    const problem = providerProblem(input.subagents, input.owner, input.provider)
    if (problem !== undefined) return { kind: 'refused', reason: problem }
    return { kind: 'activation', presetId: status.id }
}

/**
 * The witness line naming which path started the child (and what it guarantees).
 * @param plan - the plan that was executed.
 * @param note - an extra guarantee this caller adds (e.g. `orchestrate 已剔除`).
 * @returns one line for the tool output/artifact, so an audit never has to guess.
 */
export function dispatchLine(plan: DelegationPlan, note?: string): string {
    const extra = note === undefined || note === '' ? '' : `；${note}`
    if (plan.kind === 'activation') {
        return `派发: startActivation + Agent Preset（${plan.presetId}；persona 与工具限制在子作用域由宿主 restrict 强制${extra}）`
    }
    if (plan.kind === 'legacy') {
        return `派发: legacy start(provider, request)（旧宿主：没有 startActivation，persona/toolFilter 随启动请求传递${extra}）`
    }
    return '派发: 已拒绝'
}

// --- the start --------------------------------------------------------------

/** Everything one start needs, already computed by the caller. */
export interface StartDelegationInput {
    /** Who is delegating (used in the failure text). */
    owner: DelegationOwner
    provider: string
    /** The decision; a `refused` plan must never reach this call. */
    plan: Exclude<DelegationPlan, { kind: 'refused' }>
    label: string
    prompt: string
    parent: AgentLike
    signal: AbortSignal
    agentOptions?: DelegationAgentOptions
    maxDepth?: number
    /**
     * What the LEGACY request carries: an old host still accepts the persona and
     * the filter inside the request. Ignored on the activation path on purpose —
     * sending them there would claim a guarantee 0.2.2-rc.1 does not have.
     */
    legacy?: { persona?: string; filter?: DelegationFilter }
    /** One extra line for the failure text (e.g. the target's tool whitelist). */
    detail?: string
}

/** A start failure, translated into an explanation the human can act on. */
function startFailure(provider: string, how: string, error: unknown, detail?: string): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(
        [
            `子代理启动失败（provider ${provider}，${how}）：${message}`,
            ...(detail === undefined || detail === '' ? [] : [detail]),
            '常见原因：preset 里的工具名在当前部署不存在（scope 插件会拒绝挂载），或 preset 行加载失败（profile 共享闭包过期）。',
            `下一步：先用 ${REPAIR_CLOSURE} 修闭包并重启宿主；仍失败时按配置/角色里的工具名核对（role_list），或让宿主在插件 config 里覆盖。`,
        ].join('\n'),
    )
}

/** Run one disposer without letting a teardown failure mask the result. */
const noopDispose = async (): Promise<void> => undefined

/**
 * Start one child through the plan's path.
 *
 * Both paths normalise to {@link DelegationRun}, so a caller has exactly one
 * shape to handle and cannot accidentally leak an activation the host expects
 * to be disposed.
 * @param subagents - the service (the plan already proved the path exists).
 * @param input - provider, prompt, parent, signal, the guard's restriction.
 * @returns the normalised child run.
 */
export async function startDelegation(subagents: DelegationServices, input: StartDelegationInput): Promise<DelegationRun> {
    // `signal` is deliberately NOT part of the modern request: 0.2.2-rc.1 carries it
    // on the activation SPEC, and sending it inside `request` too would be a
    // claim about an API that does not have that field.
    const request: DelegationRequest = {
        prompt: [{ type: 'text', text: input.prompt }],
        parent: input.parent,
        ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    }
    if (input.plan.kind === 'activation') {
        if (typeof subagents.startActivation !== 'function') throw new Error('startActivation disappeared between the plan and the call')
        try {
            // BOUND call, never `const f = service.startActivation; f(...)`:
            // the host service is a class instance whose methods use `this`
            // (`expectProvider`, the provider registry). A detached call throws
            // "Cannot read properties of undefined (reading 'expectProvider')"
            // — which is exactly how this shipped broken the first time, because
            // every fake in the tests was a plain function that needed no `this`.
            const activation = await subagents.startActivation({
                provider: input.provider,
                label: input.label,
                // THE load-bearing field: without it the host mounts no preset and
                // the child runs with the parent's whole tool surface.
                request: { ...request, agentPreset: input.plan.presetId },
                signal: input.signal,
                delivery: 'caller',
            })
            if (typeof activation?.childId !== 'string' || activation.childId === '') {
                throw new Error('宿主返回的 activation 没有 childId')
            }
            return { id: activation.childId, result: activation.result, dispose: () => activation.dispose() }
        } catch (error) {
            throw startFailure(input.provider, `startActivation + preset ${input.plan.presetId}`, error, input.detail)
        }
    }
    if (typeof subagents.start !== 'function') throw new Error('start disappeared between the plan and the call')
    try {
        // Bound, for the same reason as `startActivation` above.
        const run = await subagents.start(input.provider, {
            ...request,
            label: input.label,
            signal: input.signal,
            ...(input.legacy?.filter === undefined ? {} : { toolFilter: input.legacy.filter }),
            ...(input.legacy?.persona === undefined ? {} : { persona: input.legacy.persona }),
        })
        // A provider that resolves to nothing usable must not take the caller
        // down with a TypeError (nor bind a child under an `undefined` id).
        const id = typeof (run as { id?: unknown } | null)?.id === 'string' ? (run as { id: string }).id : undefined
        if (id === undefined || id === '') throw new Error('provider 返回了不可用的运行句柄（没有 id）')
        return { id, result: run.result, dispose: run.dispose === undefined ? noopDispose : () => (run.dispose as () => Promise<void>)() }
    } catch (error) {
        throw startFailure(input.provider, 'legacy start(provider, request)', error, input.detail)
    }
}

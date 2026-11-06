/**
 * The drafting child's Agent Preset: who `spec_bootstrap({ action: "draft" })`
 * delegates to, and with what.
 *
 * Harness 0.2.2-rc.1 deleted `subagents.start(provider, request)`, and its
 * `SubagentStartRequest` carries neither `persona` nor `toolFilter` — so the
 * drafting child's read-only allow-list has exactly one carrier left: a preset
 * whose single row mounts `dsh-eng-core/scope` into the CHILD scope. This module
 * owns only what is drafting-shaped (the id scheme, the persona, the allow
 * list, the model route); *how* a preset is registered and a child started is
 * `dsh-eng-core`'s delegation seam, shared with role-guard, the orchestrator and
 * impact-gate.
 *
 * @module dsh-spec-gate/drafting
 */

import {
    delegationFilterFingerprint,
    sha256,
    type DelegationAgentOptions,
    type DelegationFilter,
    type DelegationOwner,
    type DelegationPresetInput,
} from 'dsh-eng-core'

/** Preset id prefix, namespaced so it cannot collide with a deployment's own. */
export const BOOTSTRAP_PRESET_PREFIX = 'spec-gate:bootstrap'

/** Presets sort after role-guard's (100), the orchestrator's (200) and impact-gate's (300). */
export const BOOTSTRAP_PRESET_ORDER = 400

/** Row id inside the preset; stable so a roster is readable in a diff. */
export const BOOTSTRAP_SCOPE_ROW_ID = 'spec-gate-bootstrap-scope'

/** The drafting child's persona: unchanged from what the start request used to carry. */
export const BOOTSTRAP_PERSONA = [
    '你是规格草稿员：读代码、写可验证的验收标准与可执行的测试用例步骤。',
    '你只有只读工具：绝不修改文件，也不要尝试。',
    '证据不足就标注 [推断] 或 [待确认]，禁止发明行为。',
].join('\n')

/** The refusal subject: the seam's texts name the thing a human can go and fix. */
export const BOOTSTRAP_OWNER: DelegationOwner = {
    plugin: 'dsh-spec-gate',
    subject: 'spec_bootstrap draft 的只读草稿子代理',
}

/**
 * The drafting child's confinement — unchanged from `toolFilter: { allow: readTools }`.
 *
 * There is deliberately no `deny` side: the allow-list IS the decision, and a
 * second list here would change what the child can do.
 * @param readTools - `bootstrap.readTools` (the effective, per-workspace list).
 * @returns the filter the preset row enforces in the child scope.
 */
export function bootstrapFilter(readTools: readonly string[]): DelegationFilter {
    return { allow: [...readTools] }
}

/**
 * The preset id: the plugin's namespace plus the allow-list's fingerprint.
 *
 * `bootstrap.readTools` is project-overridable, so two workspaces of one host can
 * legitimately want different read-only sets. A single fixed id would make the
 * second one a "stale preset" refusal — the registry refuses a filter that
 * changed after registration, because the child would otherwise run under
 * rights nobody declares any more — and no restart could ever satisfy both
 * workspaces. The id therefore IS the filter's identity: one preset per
 * distinct list, each mounting exactly that list.
 * @param readTools - the effective read-only allow-list.
 * @returns the preset id.
 */
export function bootstrapPresetId(readTools: readonly string[]): string {
    return `${BOOTSTRAP_PRESET_PREFIX}:${sha256(delegationFilterFingerprint(bootstrapFilter(readTools))).slice(0, 8)}`
}

/**
 * Everything the seam needs to declare and start one drafting delegation.
 * @param readTools - the effective read-only allow-list.
 * @returns the preset input (id, persona, filter, roster metadata).
 */
export function bootstrapPresetInput(readTools: readonly string[]): DelegationPresetInput {
    return {
        id: bootstrapPresetId(readTools),
        name: '规格草稿（只读）',
        description: `spec_bootstrap draft 的只读草稿子代理：白名单 ${readTools.join('/') || '(空)'}。`,
        order: BOOTSTRAP_PRESET_ORDER,
        rowId: BOOTSTRAP_SCOPE_ROW_ID,
        persona: BOOTSTRAP_PERSONA,
        filter: bootstrapFilter(readTools),
    }
}

/**
 * The configured model route for the drafting child, as a start request takes it.
 *
 * On a 0.2.2-rc.1 host `agentOptions` still rides in the request (only `persona`
 * and `toolFilter` moved into the preset), so this is unchanged behaviour: the
 * bulk reading of a repository is exactly the work a cheap model can do.
 * @param route - `bootstrap`'s model/reasoningEffort/maxTokens.
 * @returns the options, or `undefined` when no route is configured (the child
 *   then runs on the session's model, which is the documented default).
 */
export function bootstrapAgentOptions(route: {
    model?: string
    reasoningEffort?: string
    maxTokens?: number
}): DelegationAgentOptions | undefined {
    if (route.model === undefined) return undefined
    const slash = route.model.indexOf('/')
    return {
        ...(slash < 0 ? {} : { provider: route.model.slice(0, slash) }),
        model: slash < 0 ? route.model : route.model.slice(slash + 1),
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    }
}

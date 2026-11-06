/**
 * Agent Presets for auto-dispatched stages: what is STAGE-shaped about them.
 *
 * The preset itself — one row mounting the scope plugin shared from
 * `dsh-eng-core/scope` — and its registration live in `dsh-eng-core`'s
 * delegation seam (`registerDelegationPreset`). What stays here is:
 *
 *  - the id scheme (`orchestrator:<role>`, order base 200, row id), unchanged
 *    since it was this plugin's private copy: an audit that looked for
 *    `orchestrator:<role>` must keep finding it;
 *  - the roster texts;
 *  - {@link withoutOrchestrate}, the anti-recursion guard, which is this
 *    plugin's POLICY and not the seam's business.
 *
 * The guard is what the preset row's `config` carries (or, on an old host, the
 * legacy start request): `orchestrate` in a child's hands means recursion — the
 * child calls `orchestrate start`, that re-enters the stage, and the auto-dispatch
 * spawns a grandchild (measured live as ~800 child sessions from ONE entry). The
 * stage prompt says "don't call orchestrate", but prose is not a permission
 * model, so the tool is removed structurally. A declared whitelist is narrowed,
 * never dropped: dropping `allow` would turn "these tools only" into "everything
 * except orchestrate" — the exact widening this function exists to prevent.
 *
 * @module dsh-orchestrator/presets
 */

import type { DelegationFilter, DelegationPresetInput } from 'dsh-eng-core'

/** Preset ids are namespaced so they cannot collide with a deployment's own. */
export const PRESET_ID_PREFIX = 'orchestrator:'

/** Presets sort after role-guard's role presets (order base 100). */
export const PRESET_ORDER_BASE = 200

/** Row id inside one preset; stable so a roster is readable in a diff. */
export const SCOPE_ROW_ID = 'orchestrator-scope'

/** The tool restriction a dispatched child's scope enforces. */
export type PresetFilter = DelegationFilter

/**
 * Add the anti-recursion guard to a filter.
 * @param filter - the effective filter (role or deployment), already merged.
 * @returns a filter that can never contain `orchestrate`.
 */
export function withoutOrchestrate(filter: DelegationFilter | undefined): DelegationFilter {
    if (filter?.allow !== undefined) {
        return {
            allow: filter.allow.filter((entry) => entry !== 'orchestrate'),
            deny: [...new Set([...(filter.deny ?? []), 'orchestrate'])],
        }
    }
    return { deny: [...new Set([...(filter?.deny ?? []), 'orchestrate'])] }
}

/**
 * The preset id for one stage role.
 * @param role - the stage's role id, or `undefined` for a role-less stage.
 */
export function presetIdFor(role: string | undefined): string {
    return `${PRESET_ID_PREFIX}${role === undefined || role === '' ? 'stage' : role}`
}

/**
 * Build the preset declaration for one dispatched stage.
 * @param input - the stage's role, its persona and the GUARDED filter.
 * @returns what `registerDelegationPreset` needs.
 */
export function dispatchPresetInput(input: { role: string | undefined; persona?: string; filter: DelegationFilter }): DelegationPresetInput {
    const role = input.role
    return {
        id: presetIdFor(role),
        name: role === undefined ? '自动派发：无角色的阶段' : `自动派发：角色 ${role}`,
        description:
            role === undefined
                ? '自动派发阶段（未声明角色）的 persona 与工具限制；orchestrate 已从子作用域剔除。'
                : `自动派发阶段角色 ${role} 的 persona 与工具限制；orchestrate 已从子作用域剔除。`,
        order: PRESET_ORDER_BASE,
        rowId: SCOPE_ROW_ID,
        ...(input.persona === undefined || input.persona === '' ? {} : { persona: input.persona }),
        filter: input.filter,
    }
}

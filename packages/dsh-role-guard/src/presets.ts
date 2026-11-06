/**
 * Role → Agent Preset mapping.
 *
 * The preset itself — one row mounting the scope plugin shared from
 * `dsh-eng-core/scope` — is declared and registered by `dsh-eng-core`'s
 * delegation seam (`registerDelegationPreset`). What lives here is only what is
 * ROLE-shaped:
 *
 * ```
 * id: role:<roleId>            order: 100 + index
 * plugins:
 *   - id: role-guard-scope     name: dsh-eng-core/scope
 *     config: { persona, allow?, deny? }
 * ```
 *
 * The id scheme and the order base are unchanged since the seam was one
 * plugin's private copy: an audit that looked for `role:<roleId>` must keep
 * finding it. The row's specifier is taken from the implementation by
 * eng-core, never spelled out here — a rename that leaves a stale string behind
 * produces a row the host cannot load, i.e. a child with NO restriction.
 *
 * @module dsh-role-guard/presets
 */

import { PRESET_DESCRIPTION_MAX, type DelegationFilter, type DelegationPresetInput } from 'dsh-eng-core'
import type { Role } from './roles.js'

/** Preset ids are namespaced so they cannot collide with a deployment's own. */
export const PRESET_ID_PREFIX = 'role:'

/** Presets sort after a deployment's hand-written ones. */
export const PRESET_ORDER_BASE = 100

/** Row id inside one preset; stable so a roster is readable in a diff. */
export const SCOPE_ROW_ID = 'role-guard-scope'

/** Longest preset description the roster renders well. */
export const DESCRIPTION_MAX = PRESET_DESCRIPTION_MAX

/** The preset id for a role id. */
export function presetIdFor(roleId: string): string {
    return `${PRESET_ID_PREFIX}${roleId}`
}

/**
 * The roster description for a role's preset.
 * @param role - the resolved role.
 * @returns the role's own description, or a sentence naming the role.
 */
export function presetDescription(role: Role): string {
    const text =
        role.description.trim() === ''
            ? `角色 ${role.name}（${role.id}，mode=${role.mode}）的 persona 与工具白名单，由宿主强制。`
            : role.description.trim()
    return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

/**
 * Build the preset declaration for one role.
 *
 * The filter MUST be the one computed against the GLOBAL tool view (the same
 * view `tools.restrict` validates against), in the assembly path and in the
 * delegation path alike: the registry refuses a fingerprint that changed since
 * registration, so computing it differently at the two call sites would turn a
 * working delegation into a "stale preset" refusal.
 * @param role - the resolved role.
 * @param filter - the role's tool filter, pruned against the global tool view.
 * @returns what `registerDelegationPreset` needs.
 */
export function rolePresetInput(role: Role, filter: DelegationFilter | undefined): DelegationPresetInput {
    return {
        id: presetIdFor(role.id),
        name: role.name,
        description: presetDescription(role),
        order: PRESET_ORDER_BASE,
        rowId: SCOPE_ROW_ID,
        persona: role.persona,
        ...(filter === undefined ? {} : { filter }),
    }
}

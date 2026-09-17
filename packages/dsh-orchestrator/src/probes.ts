/**
 * Capability probing (docs.md §4.1: 在正确的阶段激活对应的插件).
 *
 * "Is plugin X mounted?" is answered by two harness facts and nothing else:
 * `ctx.tools.get(toolName, agent)` (a tool the plugin registers) and
 * `ctx.get(serviceName)` (a service). There is deliberately no third path —
 * a probe that cannot be answered counts as **not mounted**, so a stage is
 * never entered on a guess (fail closed).
 *
 * @module dsh-orchestrator/probes
 */

import type { AgentLike } from 'dsh-eng-core'
import type { ProbeConfig } from './config.js'

/** The harness extension points the probes read (structurally). */
export interface ProbeContext {
    tools: { get: (name: string, scope?: unknown) => unknown }
    get: (name: string) => unknown
}

/**
 * Built-in probe map (docs/PLUGIN-CONVENTIONS.md §7 — the cross-plugin tool
 * table; these names must not change). `config.probes` overrides entries here.
 */
export const BUILTIN_PROBES: Readonly<Record<string, ProbeConfig>> = {
    'dsh-role-guard': { tool: 'team_delegate' },
    'dsh-spec-gate': { tool: 'spec_create' },
    'dsh-test-design-gate': { tool: 'test_design_review' },
    'dsh-quality-gate': { tool: 'quality_gate_run' },
    'dsh-evidence-gate': { tool: 'mission_complete' },
    'dsh-audit-trail': { tool: 'audit_report' },
}

/** One plugin probe, resolved and ready to run. */
export interface PluginProbe {
    plugin: string
    /** Probe description used in refusals (`tool:quality_gate_run`). */
    probe: string
    /** Deterministic mount check. */
    isMounted: () => boolean
}

/**
 * Merge the built-in map with user overrides (per key, not deep-merged).
 *
 * An override that names neither a tool nor a service is ignored rather than
 * taken as "no probe": a half-written config block must not silently disable a
 * capability check (fail closed means "probe it", not "assume it is mounted").
 */
export function mergeProbes(overrides: Record<string, ProbeConfig>): Record<string, ProbeConfig> {
    const merged: Record<string, ProbeConfig> = {}
    for (const [plugin, value] of Object.entries(BUILTIN_PROBES)) merged[plugin] = { ...value }
    for (const [plugin, value] of Object.entries(overrides)) {
        if (value.tool === undefined && value.service === undefined) continue
        merged[plugin] = { ...value }
    }
    return merged
}

/** Render the probe description of one entry (`tool:x service:y`). */
function describeProbe(value: ProbeConfig): string {
    return [...(value.tool === undefined ? [] : [`tool:${value.tool}`]), ...(value.service === undefined ? [] : [`service:${value.service}`])].join(' ')
}

/** Build one probe over a host context (agent scope included). */
function buildProbe(ctx: ProbeContext, plugin: string, value: ProbeConfig, agent: AgentLike | undefined): PluginProbe {
    const tool = value.tool
    const service = value.service
    return {
        plugin,
        probe: describeProbe(value),
        isMounted: () => {
            try {
                if (tool !== undefined && ctx.tools.get(tool, agent ?? undefined) != null) return true
                if (service !== undefined && ctx.get(service) != null) return true
            } catch {
                // A scope lookup that throws is "not mounted", never "maybe".
            }
            return false
        },
    }
}

/**
 * Build the probe table bound to one host context.
 * @param ctx - structural host context (`ctx.tools.get` / `ctx.get`).
 * @param overrides - `config.probes`.
 * @param agent - the calling agent (the tool registry is scope-aware).
 * @returns one probe per known plugin.
 */
export function createProbes(
    ctx: ProbeContext,
    overrides: Record<string, ProbeConfig>,
    agent: AgentLike | undefined,
): Record<string, PluginProbe> {
    const table: Record<string, PluginProbe> = {}
    for (const [plugin, value] of Object.entries(mergeProbes(overrides))) {
        if (value.tool === undefined && value.service === undefined) continue
        table[plugin] = buildProbe(ctx, plugin, value, agent)
    }
    return table
}

/** How one plugin's mount state is rendered in a report. */
export function describeMount(probe: PluginProbe | undefined, plugin: string): string {
    if (probe === undefined) return `未挂载（未配置探测器：请补 config.probes["${plugin}"]）`
    return probe.isMounted() ? `已挂载（${probe.probe}）` : `未挂载（探测 ${probe.probe}）`
}

/** One required plugin and whether it is mounted right now. */
export interface MountState {
    plugin: string
    probe: string
    mounted: boolean
}

/** Probe every plugin a stage requires. */
export function requiredPluginStates(required: readonly string[], probes: Record<string, PluginProbe>): MountState[] {
    return required.map((plugin) => {
        const probe = probes[plugin]
        return {
            plugin,
            probe: probe?.probe ?? '(未配置探测器)',
            mounted: probe === undefined ? false : probe.isMounted(),
        }
    })
}

/** The refusal text for a stage whose required plugins are missing. */
export function refusalForMissingPlugins(stageId: string, missing: MountState[]): string {
    return [
        `阶段 ${stageId} 不能进入：所需插件未挂载。`,
        ...missing.map(
            (entry) =>
                `- ${entry.plugin}：未探测到 ${entry.probe === '(未配置探测器)' ? '任何探测器（请在 config.probes 中为该插件配置 tool 或 service）' : entry.probe}`,
        ),
        '',
        `修复：把缺失插件加入 profile 的 dsh.profile.bundles（dsh plugin --profile <名字> add ${missing[0]?.plugin ?? 'dsh-xxx'}），重启会话后重新调用 orchestrate({ action: "advance" })。`,
        '在插件补齐之前，本阶段不会被跳过，也不会"先推进再补"：门禁是确定的。',
    ].join('\n')
}

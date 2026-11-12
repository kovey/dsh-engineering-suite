/**
 * The stage-role constraint on `advance`: leaving a stage that declares a role
 * requires a delegation record for that mission, stage and role.
 *
 * The role used to be a declaration the orchestrator only advertised. The
 * write guard on the spec side now refuses the lead's writes in such a stage;
 * this is the second half: the stage cannot be **settled** by a run that never
 * delegated its work. Both read the same ledger (`<layout>/state/delegations.jsonl`,
 * written by `dsh-role-guard` after `team_delegate` started a child), so they
 * cannot drift into "the write was delegated but the advance was not" (or the
 * reverse).
 *
 * The gate is configurable on purpose (`stageRoleDelegation: 'reject' | 'warn'`):
 * a deployment that turns enforcement off must say so in configuration, and the
 * report still names what it let through.
 *
 * @module dsh-orchestrator/stage-role
 */

import path from 'node:path'
import type { LayoutOptions, MissionRecord, MissionStore } from 'dsh-eng-core'
import { DELEGATION_LEDGER, matchesDelegation, readDelegations } from 'dsh-eng-core/delegations'
import type { StageConfig } from './pipeline.js'

/** How strictly `advance` enforces a role stage's delegation record. */
export type StageRoleDelegationMode = 'reject' | 'warn'

/** The resolved `stageRoleDelegation` config key. */
export interface StageRoleDelegationSetting {
    mode: StageRoleDelegationMode
    issues: readonly string[]
}

/**
 * Parse the `stageRoleDelegation` key.
 *
 * An unknown value falls back to `'reject'` (fail closed) and is reported — a
 * typo must not quietly relax a role requirement, which is the same rule every
 * other config key in this package follows.
 * @param value - the raw config value.
 */
export function resolveStageRoleDelegation(value: unknown): StageRoleDelegationSetting {
    if (value === undefined) return { mode: 'reject', issues: [] }
    if (value === 'reject' || value === 'warn') return { mode: value, issues: [] }
    return {
        mode: 'reject',
        issues: [`stageRoleDelegation 只接受 'reject' | 'warn'（收到 ${JSON.stringify(value) ?? String(value)}）：已按更严格的 'reject' 处理（未知值不放宽门禁）`],
    }
}

/** Everything the check reads (the caller has already resolved all of it). */
export interface StageRoleCheckInput {
    /** The configured enforcement mode (`reject` refuses, `warn` only reports). */
    mode: StageRoleDelegationMode
    /** The plugin's layout overrides (same ones the mission store resolved with). */
    layout: LayoutOptions
    /** Mission store of the workspace (layout + stage artifacts). */
    store: MissionStore
    /** The mission being advanced. */
    mission: MissionRecord
    /** The stage being settled (its declared role is the requirement). */
    stage: StageConfig
    /** Workspace root, for the ledger path and the report. */
    cwd: string
}

/** The outcome of the check: a refusal (reject mode) or a warning (warn mode). */
export interface StageRoleCheck {
    refusal?: string
    warning?: string
}

/**
 * Check the delegation ledger before settling a role-declaring stage.
 * @param input - mode, mission/stage, layout and cwd.
 * @returns `{}` when the requirement holds or does not apply; a refusal text
 *   under `reject`, a report line under `warn`.
 */
export function stageRoleDelegationCheck(input: StageRoleCheckInput): StageRoleCheck {
    const role = input.stage.role
    if (role === undefined || role === '') return {}
    // `advance` only settles the current stage (checked by the caller); keep the
    // guard local too so a future caller cannot check the wrong stage.
    if (input.mission.stage !== input.stage.id) return {}
    const records = readDelegations(input.cwd, input.mission.id, input.layout)
    if (matchesDelegation(records, { stage: input.stage.id, role }) !== undefined) return {}
    const ledger = path.relative(input.cwd, path.join(input.store.layout.stateDir, DELEGATION_LEDGER)).split(path.sep).join('/')
    return input.mode === 'warn' ? { warning: warnText(input.mission, input.stage, role, ledger) } : { refusal: refusalText(input.mission, input.stage, role, ledger) }
}

/** The `reject` text: what is missing, and the exact call that fixes it. */
function refusalText(mission: MissionRecord, stage: StageConfig, role: string, ledger: string): string {
    return [
        `mission ${mission.id}（${mission.title}）阶段 ${stage.id} 声明了角色 ${role}，但委派记录 ${ledger} 里没有该 mission/stage/role 的子会话记录，advance 被拒绝。`,
        `stage: ${stage.id} · role: ${role}`,
        '原因：阶段角色是硬约束——实现类工作必须由该角色的子会话完成，主会话直接结算会让职责分离再次变成声明。',
        `下一步：回到阶段 ${stage.id}，调用 team_delegate({ role: '${role}', task: '…' }) 派发实现；`,
        '子会话启动成功后 dsh-role-guard 会追加一条委派记录，然后重新调用 orchestrate({ action: "advance" })。',
        "放宽：宿主可把 stageRoleDelegation 设为 'warn'（默认 'reject'，只告警不拒绝）。",
    ].join('\n')
}

/** The `warn` text: the same facts, phrased as something that was let through. */
function warnText(mission: MissionRecord, stage: StageConfig, role: string, ledger: string): string {
    return [
        `阶段 ${stage.id} 声明了角色 ${role}，但委派记录 ${ledger} 里没有该 mission/stage/role 的子会话记录。`,
        "按 stageRoleDelegation='warn' 仅告警并放行（默认 'reject' 会拒绝这次 advance）。",
        `下一步：下一次请先用 team_delegate({ role: '${role}', … }) 派发本阶段工作，保持职责分离。`,
    ].join('\n')
}

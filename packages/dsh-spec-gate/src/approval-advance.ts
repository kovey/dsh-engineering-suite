/**
 * The `spec_approve` → `orchestrator.enterImplement` seam (AC-005 of 强制进入
 * implement).
 *
 * Approving a specification unlocks the FILE BOUNDARIES; it must also move the
 * mission into the stage where implementation writes are allowed. `dsh-spec-gate`
 * cannot drive the pipeline itself, so it asks the orchestrator's optional
 * service and reports what happened.
 *
 * This is a BEST-EFFORT seam on purpose — three failures are all acceptable and
 * all leave the approval itself intact:
 *  - the orchestrator is not mounted (`service === undefined`);
 *  - the runtime provides something that is not the service (shape check);
 *  - the service throws or rejects (logged, never surfaced as an error).
 *
 * The module is pure report-building: it writes nothing and decides nothing
 * about the approval, which is already recorded by the time it runs.
 *
 * @module dsh-spec-gate/approval-advance
 */

import type { Logger, MissionRecord } from 'dsh-eng-core'

/** The result shape this plugin relies on (a structural subset). */
export interface EnterImplementResultLike {
    /** `true` only when the mission reached (or passed) `implement`. */
    ok: boolean
    /** The stage the mission is in after the attempt. */
    stage?: string
    /** One paragraph: what happened, or what is missing and how to fix it. */
    message: string
}

/** The sliver of `dsh-orchestrator`'s service this plugin calls. */
export interface OrchestratorServiceLike {
    /** Optional `cwd`: the workspace the mission lives in (`mission.cwd`). */
    enterImplement: (missionId: string, cwd?: string) => Promise<EnterImplementResultLike>
}

/** Where the service and the diagnostics sink come from. */
export interface ApprovalAdvanceDeps {
    /** `ctx.get('orchestrator')`, read at call time (the plugin may load later). */
    orchestrator: () => OrchestratorServiceLike | undefined
    /** Plugin logger (the failure is recorded, never returned as an error). */
    logger: Logger
}

/**
 * Ask the orchestrator to enter `implement`, and turn the answer into report
 * lines.
 * @param deps - service accessor and logger.
 * @param mission - the mission whose specification was just approved.
 * @returns 0–1 report lines to append to the approval text.
 */
export async function enterImplementLines(deps: ApprovalAdvanceDeps, mission: MissionRecord): Promise<string[]> {
    const service = deps.orchestrator()
    if (service === undefined || typeof service.enterImplement !== 'function') {
        // Optional service: an older/smaller deployment simply has no pipeline
        // to advance, and the approval text stays exactly as it was.
        return []
    }
    try {
        const result = await service.enterImplement(mission.id, mission.cwd)
        if (typeof result !== 'object' || result === null) {
            deps.logger.warn(`orchestrator.enterImplement 返回了不可用的结果（${String(result)}）：审批照常生效。`)
            return []
        }
        if (result.ok === true) {
            return ['已进入 implement：请用 team_delegate({ role: \'developer\', task: \'…\' }) 派发实现（写守卫只在 implement 阶段放行代码写入，文档/配置写入不受限）。']
        }
        return [`停在 ${result.stage ?? '(未开始)'}：${typeof result.message === 'string' && result.message !== '' ? result.message : 'orchestrator 未说明原因'}`]
    } catch (error) {
        deps.logger.warn(`orchestrator.enterImplement 失败（best effort，不影响审批）：${(error as Error).message}`)
        return []
    }
}

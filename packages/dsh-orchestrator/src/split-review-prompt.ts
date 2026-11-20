/**
 * What the human is shown before deciding on a split plan (TUI and seam alike).
 *
 * Two surfaces ask the same question — the nvim-tui menu and the host approval
 * seam — and they must show the same facts: the plan's digest, how many tasks
 * and parallel groups it has, which task maps which criteria, and (when it
 * applies) the warning that the plan CHANGED since the last review. Keeping the
 * prose here is what makes "same experience" checkable: a change to the review
 * sheet cannot land on one route only.
 *
 * Nothing here decides anything: the texts are read by a person, and the verdict
 * is mapped in `split-approval.ts`.
 *
 * @module dsh-orchestrator/split-review-prompt
 */

import path from 'node:path'
import type { SplitPlan, StoredSplitPlan } from 'dsh-eng-core/split'
import type { GateFacts } from './gate-facts.js'

/** The listed tasks of a plan, capped so one card stays readable. */
function taskLines(plan: SplitPlan): string[] {
    const shown = plan.tasks.slice(0, 12).map((task) => {
        const deps = task.dependsOn.length === 0 ? '' : `；依赖 ${task.dependsOn.join(',')}`
        return `- ${task.id}：${task.goal}（paths ${task.paths.join(' ') || '-'}；AC ${task.acceptance.join(',') || '-'}${deps}）`
    })
    if (plan.tasks.length > shown.length) shown.push(`- …（另有 ${plan.tasks.length - shown.length} 条，见 plan.json / plan.md）`)
    return shown
}

/** The prose a human reads before deciding. */
export function reviewPrompt(facts: GateFacts, plan: SplitPlan, digest: string, stale: string | undefined): string {
    return [
        `拆分计划审核（mission ${facts.mission.id} · ${facts.mission.title}）`,
        '',
        `plan 摘要：${digest}`,
        `子任务 ${plan.tasks.length} 条，并行组 ${plan.parallelGroups.length} 个。`,
        ...(stale === undefined ? [] : ['', `注意：${stale}`]),
        '',
        '任务：',
        ...taskLines(plan),
        '',
        '批准后才会派发第一个 worker；打回则重新拆分。',
    ].join('\n')
}

/**
 * The artifacts a reviewer should be able to open, workspace-relative.
 *
 * `plan.md` is the readable document (AC-001) and the one the TUI preview opens;
 * it is the split review's answer to "the spec review shows me the document".
 */
export function splitPlanArtifacts(facts: GateFacts): string[] {
    return [path.relative(facts.store.layout.cwd, path.join(facts.store.layout.missionsDir, facts.mission.id, 'split', 'plan.md'))]
}

/**
 * The TUI menu's title: mission, plan identity, and the two numbers a reviewer
 * needs to judge the decomposition at a glance.
 */
export function splitMenuTitle(facts: GateFacts, stored: StoredSplitPlan): string {
    return (
        `拆分计划审核（mission ${facts.mission.id} · 摘要 ${stored.digest.slice(0, 12)}` +
        ` · 子任务 ${stored.plan.tasks.length} / 并行组 ${stored.plan.parallelGroups.length}）`
    )
}

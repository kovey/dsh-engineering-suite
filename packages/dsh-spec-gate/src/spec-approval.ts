/**
 * What an approval REFUSES, and what the human is shown before deciding.
 *
 * These rules used to live inside `tools.ts`: one `spec_approve` branch was the
 * longest block in that file, and the review sheet was rendered from inside the
 * registration closure. They are the same rules here — one named function per
 * refusal — so the registration surface stays a list of tools instead of a list
 * of refusals.
 * @module dsh-spec-gate/spec-approval
 */

import path from 'node:path'
import {
    formatTime,
    scopeWidened,
    specReviewDigest,
    type Layout,
    type Mandate,
    type MandateScope,
    type MissionRecord,
    type SpecRecord,
} from 'dsh-eng-core'
import { defaultBudgetUnit, describeThreshold, readSpecBudgets } from './budgets.js'

/**
 * Refuse approval unless a test-design PASS was reached against THIS
 * specification: a revision (or a hand-edited artifact) changes the digest and
 * revokes the old verdict.
 * @param mission - the mission being approved.
 * @param spec - its current specification (the one the verdict must cover).
 */
export function assertTestDesignApproved(mission: MissionRecord, spec: SpecRecord): void {
    const design = mission.testDesign
    if (design === undefined) {
        throw new Error(
            `mission ${mission.id} 缺少测试设计：请先在 spec_create 的 testDesign 参数中补齐三类场景，再调用 test_design_review。`,
        )
    }
    if (design.passed !== true) {
        throw new Error(
            `mission ${mission.id} 的测试设计尚未通过评审（用例 ${design.cases.length} 条，未覆盖 ${design.uncovered.join(', ') || '无'}）：请调用 test_design_review。`,
        )
    }
    const current = specReviewDigest(spec, design)
    if (design.specDigest === current) return
    throw new Error(
        [
            `mission ${mission.id} 的测试设计评审针对的不是当前规格（规格 revision ${spec.revision}）：`,
            design.specDigest === undefined
                ? '该评审记录没有绑定规格摘要（可能来自旧版本插件），无法确认它覆盖了当前验收标准。'
                : `评审摘要 ${design.specDigest.slice(0, 12)} ≠ 当前摘要 ${current.slice(0, 12)}。`,
            '下一步：对当前规格重新运行 test_design_review，通过后再调用 spec_approve。',
        ].join('\n'),
    )
}

/**
 * Refuse a re-approval that would rewrite the mandate: a withdrawal is a
 * person's stop (final), and a wider declared scope needs a NEW mission.
 * @param mission - the mission being approved.
 * @param mandate - the immutable mandate already recorded.
 * @param declared - the scope the current specification declares.
 */
export function assertMandateReusable(mission: MissionRecord, mandate: Mandate, declared: MandateScope): void {
    const withdrawn = mandate.withdrawn
    if (withdrawn !== undefined) {
        throw new Error(
            [
                `mission ${mission.id} 的 mandate 已于 ${formatTime(withdrawn.at)} 由 ${withdrawn.by} 撤回（${withdrawn.reason}）：拒绝重新审批。`,
                '撤回是一个人的停止决定，一次新的审批不能覆盖它（mandate 不可改写）。',
                '下一步：用 spec_create 新建 mission 重新提交规格，再 spec_approve。',
            ].join('\n'),
        )
    }
    const widened = scopeWidened(mandate.scope, declared)
    if (widened.length === 0) return
    const current = mandate.scope
    throw new Error(
        [
            `mission ${mission.id} 已有更窄的 mandate（paths: ${current.paths.join('、') || '(未收窄)'}；phases: ${current.phases.join('、') || '(未收窄)'}），本次规格声明的范围更大，拒绝扩大授权。`,
            `扩大的部分：${widened.join('、')}。`,
            'mandate 不可改写：更宽的范围需要一个新 mission（这也是它防住"先拿窄授权、再悄悄改宽"的方式）。',
            '下一步：用 spec_create 新建 mission 重新审批；或把本次规格收敛回原范围内再送审。',
        ].join('\n'),
    )
}

/** The workspace-relative spelling of a path (for prompts). */
function relativePathOf(mission: MissionRecord, candidate: string): string {
    return path.isAbsolute(candidate) ? path.relative(mission.cwd, candidate) || candidate : candidate
}

/**
 * The text the human reads in the approval prompt.
 *
 * Two directories and two files, so a reviewer can open them (a UI may render
 * the `需求文档:` / `测试用例:` lines as openable paths), the numbers that
 * matter, and what rejection means — the review is a loop, not a one-shot.
 * @param layout - the workspace layout: both directories follow the layout root
 *   (a migrated repository keeps its spec under `.dsh/engineering-suite/specs`).
 */
export function renderApprovalPrompt(mission: MissionRecord, round: number, layout: Layout, note?: string): string {
    const spec = mission.spec
    const criteria = spec?.acceptanceCriteria ?? []
    const cases = mission.testDesign?.cases ?? []
    const uncovered = mission.testDesign?.uncovered ?? []
    const budgets = readSpecBudgets(spec)
    const relativeMissions = path.relative(layout.cwd, layout.missionsDir) || layout.missionsDir
    const relativeSpecs = path.relative(layout.cwd, layout.specsDir).split(path.sep).join('/') || '.'
    const specFile = relativePathOf(mission, mission.specPath ?? path.join(layout.specsDir, `${mission.id}.md`))
    const designFile = `${relativeMissions}/${mission.id}/test-design-review.md`
    const lines = [
        note === undefined ? `规格审批（第 ${round} 次送审）：${mission.title}` : `${note}（第 ${round} 次送审）`,
        `mission ${mission.id} · rev ${spec?.revision ?? '?'} · 摘要 ${(mission.specDigest ?? '').slice(0, 12) || '?'}`,
        '',
        `需求文档目录: ${relativeSpecs}/`,
        `需求文档: ${specFile}（验收标准 ${criteria.length} 条）`,
        ...criteria.slice(0, 6).map((criterion) => `  · ${criterion.id} ${criterion.text}`),
        ...(criteria.length > 6 ? [`  · …另有 ${criteria.length - 6} 条`] : []),
        '',
        // 非功能要求也在被审批的文档里：审的人必须看见它们，否则"预算"又变成了事后补的口径。
        `非功能预算: ${budgets.budgets.length} 条${budgets.retired.length === 0 ? '' : `（已作废编号：${budgets.retired.join('、')}，不会复用）`}`,
        ...budgets.budgets.slice(0, 6).map((budget) => {
            const unit = budget.unit ?? defaultBudgetUnit(budget.metric)
            return `  · ${budget.id} ${budget.name}：${budget.metric} ${describeThreshold(budget.threshold, unit)}（命令 \`${budget.command}\`，关联 ${(budget.requirementIds ?? []).join('、') || '(未关联)'}）`
        }),
        ...(budgets.budgets.length > 6 ? [`  · …另有 ${budgets.budgets.length - 6} 条`] : []),
        '',
        `测试用例目录: ${relativeMissions}/${mission.id}/`,
        `测试用例: ${designFile}（用例 ${cases.length} 条${uncovered.length === 0 ? '，覆盖全部验收标准' : `，未覆盖 ${uncovered.join('、')}`}）`,
        ...cases.slice(0, 6).map((entry) => `  · ${entry.id} → ${entry.covers.join('、') || '(未标注)'}：${entry.expected.slice(0, 40)}`),
        ...(cases.length > 6 ? [`  · …另有 ${cases.length - 6} 条`] : []),
        '',
        '通过：写操作放行。',
        '不合格：拒绝并在对话里说明要改什么——规格会回到草稿，模型据此重写后再次送审（可反复多轮）。',
    ]
    return lines.join('\n')
}

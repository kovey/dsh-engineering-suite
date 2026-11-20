/**
 * `missions/<id>/split/plan.md`: the plan a person can READ.
 *
 * `plan.json` is the reviewed artifact (its digest is what a review binds to),
 * but a JSON file is not a document: a reviewer asked to decide "may these
 * workers run?" used to get a task list rendered into an approval card, with the
 * three automatic checks summarized in one sentence. Every plan write now also
 * renders this Markdown — title, digest, task table, parallel groups, the three
 * checks, and the review standing — so the SAME file can be opened in the
 * read-only preview the specification approval uses (AC-001).
 *
 * Two rules keep it honest:
 *
 *  - **It is regenerated whenever `plan.json` changes** (see `saveSplitPlan`),
 *    so it cannot describe a plan that is no longer on disk.
 *  - **It never makes a decision**. The verdict lives in `split/review.json` /
 *    `split/reviews.jsonl`; this file prints the standing as of its own write
 *    time and says so. A review decision does not rewrite it — the next plan
 *    write does. Nothing here is read by a gate.
 *
 * @module dsh-eng-core/split-plan-md
 */

import path from 'node:path'
import { cell, formatTime } from './digest.js'
import { writeTextAtomic } from './io.js'
import type { Layout } from './paths.js'
import { splitDir, type SplitPlan, type SplitTask } from './split-plan.js'
import type { SplitReviewState } from './split-review.js'
import type { SplitProblem, SplitValidation } from './split-validate.js'

/** The review standing printed in the file (see `splitReviewStatus`). */
export interface SplitPlanMarkdownReview {
    state: SplitReviewState
    detail: string
}

/** Everything one render needs. */
export interface SplitPlanMarkdownInput {
    plan: SplitPlan
    /** Digest of the plan as written (the identity a review quotes). */
    digest: string
    missionId: string
    /** Mission title, when the caller knows it (the heading reads better). */
    title?: string
    /** The three automatic checks, when the writer ran them. */
    validation?: SplitValidation
    /** The review standing at write time. */
    review?: SplitPlanMarkdownReview
    /** Write time (epoch ms); defaults to now. */
    at?: number
}

/** `missions/<id>/split/plan.md`. */
export function splitPlanMarkdownFile(layout: Layout, missionId: string): string {
    return path.join(splitDir(layout, missionId), 'plan.md')
}

/** The heading lines: what this plan is, and the digest a review must quote. */
function headerLines(input: SplitPlanMarkdownInput, at: number): string[] {
    const { plan, digest } = input
    const heading = input.title === undefined || input.title.trim() === '' ? `拆分计划：${input.missionId}` : `拆分计划：${input.title}`
    return [
        `# ${heading}`,
        '',
        `- Mission：\`${input.missionId}\``,
        `- plan 摘要：\`${digest.slice(0, 12)}\`（审核绑定这个摘要；改动 plan 就换摘要，必须重新审核）`,
        `- 子任务：${plan.tasks.length} 个；并行组：${plan.parallelGroups.length} 个`,
        `- 写入时间：${formatTime(at)}`,
        '',
    ]
}

/** One task row (the five columns AC-001 names: id / 目标 / 路径 / AC / 依赖). */
function taskRow(task: SplitTask): string {
    const paths = task.paths.length === 0 ? '-' : task.paths.map((entry) => `\`${cell(entry)}\``).join('、')
    const acceptance = task.acceptance.length === 0 ? '-' : task.acceptance.map((entry) => cell(entry)).join('、')
    const dependsOn = task.dependsOn.length === 0 ? '-' : task.dependsOn.map((entry) => cell(entry)).join('、')
    return `| ${cell(task.id)} | ${cell(task.goal) || '-'} | ${paths} | ${acceptance} | ${dependsOn} |`
}

/** The task table. */
function taskLines(plan: SplitPlan): string[] {
    if (plan.tasks.length === 0) return ['（plan 里没有任何子任务）']
    return ['| id | 目标 | 路径 | 覆盖 AC | 依赖 |', '|----|------|------|---------|------|', ...plan.tasks.map(taskRow)]
}

/** The parallel groups; a task missing from every group is called out. */
function groupLines(plan: SplitPlan): string[] {
    const lines: string[] = []
    plan.parallelGroups.forEach((group, index) => {
        lines.push(`- 组 ${index + 1}：${group.map((id) => `\`${cell(id)}\``).join('、') || '（空）'}`)
    })
    const placed = new Set(plan.parallelGroups.flat())
    const missing = plan.tasks.filter((task) => !placed.has(task.id)).map((task) => task.id)
    if (missing.length > 0) lines.push(`- 未出现在任何并行组：${missing.map((id) => `\`${cell(id)}\``).join('、')}`)
    if (lines.length === 0) lines.push('（没有并行组：全部子任务串行）')
    return lines
}

/** The problems of one check, by the codes that belong to it. */
const CHECK_CODES: readonly (readonly string[])[] = [
    ['task-without-ac', 'unknown-ac', 'dependency'],
    ['paths-overlap'],
    ['ac-uncovered'],
]

/** One "three checks" row. */
function checkRow(index: number, title: string, problems: readonly SplitProblem[], detail: string): string {
    const mark = problems.length === 0 ? '✅ 通过' : `❌ 未通过（${problems.length} 条）`
    return `| ${index}. ${cell(title)} | ${mark} | ${cell(detail)} |`
}

/** The three automatic checks, as a table — plus whatever else the validator found. */
function checksLines(validation: SplitValidation | undefined, plan: SplitPlan): string[] {
    if (validation === undefined) {
        return ['（本次写入未附校验结果：`split_plan` 会运行三道校验并把结果写在这里；直接调用 `saveSplitPlan` 的写入路径不运行校验。）']
    }
    const of = (index: number): SplitProblem[] => validation.problems.filter((problem) => CHECK_CODES[index]?.includes(problem.code) === true)
    const covered = validation.covered.length === 0 ? '（无）' : validation.covered.join('、')
    const rows = [
        checkRow(1, '每个子任务映射真实验收标准', of(0), `子任务 ${plan.tasks.length} 个；` + (validation.uncovered.length === 0 ? '映射的标准都在规格里' : `未覆盖：${validation.uncovered.join('、')}`)),
        checkRow(2, '并行组内路径不重叠', of(1), `并行组 ${plan.parallelGroups.length} 个；组内两两比较路径`),
        checkRow(3, '每个验收标准都被覆盖', of(2), `覆盖：${covered}`),
    ]
    const other = validation.problems.filter((problem) => CHECK_CODES.every((codes) => !codes.includes(problem.code)))
    return [
        `整体结论：${validation.ok ? '✅ 三道校验全部通过' : '❌ 存在未通过项（详见下表与问题清单）'}`,
        '',
        '| 校验 | 结果 | 说明 |',
        '|------|------|------|',
        ...rows,
        ...(other.length === 0 ? [] : ['', `结构问题 ${other.length} 条（plan 形状本身不对，先修这些）：`, ...other.map((problem) => `- ${problem.detail}`)]),
    ]
}

/** The review standing, with the authoritative files named. */
function reviewLines(review: SplitPlanMarkdownReview | undefined, at: number): string[] {
    return [
        review === undefined ? '（本次写入没有读到审核状态）' : `- 写入时的状态：${review.detail}`,
        `- 权威记录：\`split/review.json\`（最近一次决定）与 \`split/reviews.jsonl\`（全部历史）；审核决定本身不重写本文件，下一次写 plan.json 时才会重写（本次写于 ${formatTime(at)}）。`,
    ]
}

/**
 * Render the whole document.
 * @param input - plan, digest, optional checks and review standing.
 * @returns Markdown text (ends with one newline).
 */
export function renderSplitPlanMarkdown(input: SplitPlanMarkdownInput): string {
    const at = input.at ?? Date.now()
    return [
        ...headerLines(input, at),
        '## 子任务',
        '',
        ...taskLines(input.plan),
        '',
        '## 并行组',
        '',
        ...groupLines(input.plan),
        '',
        '## 三道自动校验',
        '',
        ...checksLines(input.validation, input.plan),
        '',
        '## 审核状态',
        '',
        ...reviewLines(input.review, at),
        '',
    ].join('\n')
}

/**
 * Write `plan.md` for one mission.
 * @param layout - the workspace layout.
 * @param missionId - the mission the plan belongs to.
 * @param input - plan, digest, optional checks and review standing.
 * @returns the absolute path written.
 */
export function writeSplitPlanMarkdown(layout: Layout, missionId: string, input: SplitPlanMarkdownInput): string {
    const file = splitPlanMarkdownFile(layout, missionId)
    writeTextAtomic(file, renderSplitPlanMarkdown({ ...input, missionId }))
    return file
}

/**
 * `split/plan.md` — the plan a person can read (AC-001).
 *
 * `plan.json` is what a review binds to (its digest), but a person asked to
 * approve dispatching workers must be able to READ the decomposition. Every
 * write of `plan.json` therefore also renders `plan.md`: task table, parallel
 * groups, the three automatic checks, and the review standing at write time.
 *
 * These cases pin the three properties that make it trustworthy: it is produced
 * by the SAME write (never a second command to forget), it is REWRITTEN when the
 * plan changes (never a stale document), and it says honestly what it does not
 * know (checks not run, standing as of its own write time).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout, type Layout } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'
import {
    readSplitPlan,
    recordSplitReview,
    saveSplitPlan,
    splitPlanMarkdownFile,
    validateSplitPlan,
    type SplitPlan,
} from '../dist/split.js'

/** A workspace with a resolved layout. */
function workspace(): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace('split-plan-md-')
    return { cwd, layout: resolveLayout(cwd) }
}

/** The oracle: two acceptance criteria. */
const SPEC = {
    acceptanceCriteria: [
        { id: 'AC-001', text: '先做 a' },
        { id: 'AC-002', text: '再做 b' },
    ],
}

/** A valid two-task plan covering both criteria. */
function plan(): SplitPlan {
    return {
        tasks: [
            { id: 'T-001', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 'T-002', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002'], dependsOn: ['T-001'], parallel: true },
        ],
        coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-002'] },
        parallelGroups: [['T-001', 'T-002']],
    }
}

/** Read the rendered document (fails the test when it was not written). */
function markdownOf(layout: Layout, missionId = 'm1'): string {
    const file = splitPlanMarkdownFile(layout, missionId)
    assert.equal(fs.existsSync(file), true, `plan.md was not written: ${file}`)
    return fs.readFileSync(file, 'utf8')
}

test('a plan write produces plan.json AND plan.md: digest, task table, groups, checks, standing (TC-2601)', () => {
    const { layout } = workspace()
    const draft = plan()
    const saved = saveSplitPlan(layout, 'm1', draft, { title: '拆分计划测试', validation: validateSplitPlan(draft, SPEC) })

    // The two files are written together, and the digest is the same one.
    assert.equal(fs.existsSync(saved.file), true)
    assert.equal(saved.markdownFile, splitPlanMarkdownFile(layout, 'm1'))
    assert.equal(fs.existsSync(saved.markdownFile), true)
    assert.equal(readSplitPlan(layout, 'm1')?.digest, saved.digest)

    const md = markdownOf(layout)
    assert.match(md, /^# 拆分计划：拆分计划测试$/m)
    assert.match(md, new RegExp(`plan 摘要：\`${saved.digest.slice(0, 12)}\``))
    assert.match(md, /- 子任务：2 个；并行组：1 个/)
    // The task table names all five columns AC-001 asks for.
    assert.match(md, /\| id \| 目标 \| 路径 \| 覆盖 AC \| 依赖 \|/)
    assert.match(md, /\| T-001 \| 做 a \| `packages\/a\/\*\*` \| AC-001 \| - \|/)
    assert.match(md, /\| T-002 \| 做 b \| `packages\/b\/\*\*` \| AC-002 \| T-001 \|/)
    // Groups and the three checks, with their verdict.
    assert.match(md, /- 组 1：`T-001`、`T-002`/)
    assert.match(md, /整体结论：✅ 三道校验全部通过/)
    assert.match(md, /1\. 每个子任务映射真实验收标准 \| ✅ 通过/)
    assert.match(md, /2\. 并行组内路径不重叠 \| ✅ 通过/)
    assert.match(md, /3\. 每个验收标准都被覆盖 \| ✅ 通过/)
    assert.match(md, /覆盖：AC-001、AC-002/)
    // The standing section exists and is honest about being a write-time snapshot.
    assert.match(md, /## 审核状态/)
    assert.match(md, /还没有人工审核记录/)
    assert.match(md, /split\/review\.json/)
})

test('changing the plan REWRITES plan.md (a plan edit never leaves a stale document behind)', () => {
    const { layout } = workspace()
    const first = saveSplitPlan(layout, 'm1', plan(), { title: '拆分计划测试', validation: validateSplitPlan(plan(), SPEC) })
    assert.match(markdownOf(layout), /做 a/)

    const edited = plan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '换成新目标' }
    const second = saveSplitPlan(layout, 'm1', edited, { title: '拆分计划测试', validation: validateSplitPlan(edited, SPEC) })
    assert.notEqual(second.digest, first.digest)

    const md = markdownOf(layout)
    assert.match(md, /换成新目标/)
    assert.doesNotMatch(md, /做 a/, 'the previous rendering must be replaced, not appended')
    assert.match(md, new RegExp(second.digest.slice(0, 12)))
    assert.equal(md.match(/^# 拆分计划/gm)?.length, 1, 'one document, one heading')
})

test('the checks section says what was NOT run, and lists the problems of a failed check', () => {
    const { layout } = workspace()
    // A direct library write (no checks run): the section says so instead of
    // implying a green verdict nobody computed.
    saveSplitPlan(layout, 'no-checks', plan())
    const bare = markdownOf(layout, 'no-checks')
    assert.match(bare, /本次写入未附校验结果/)
    assert.match(bare, /`split_plan` 会运行三道校验/)

    // A failed plan (only reachable through the library, the tool refuses to
    // write it): the failing check is marked and its problem is quoted.
    const broken = plan()
    broken.tasks[1] = { ...broken.tasks[1]!, acceptance: ['AC-999'], dependsOn: [] }
    const validation = validateSplitPlan(broken, SPEC)
    assert.equal(validation.ok, false)
    saveSplitPlan(layout, 'broken', broken, { validation })
    const md = markdownOf(layout, 'broken')
    assert.match(md, /整体结论：❌ 存在未通过项/)
    assert.match(md, /1\. 每个子任务映射真实验收标准 \| ❌ 未通过/)
    assert.match(md, /AC-999/)
})

test('the standing is read AFTER the write: an approval shows up, a re-plan makes it stale', () => {
    const { layout } = workspace()
    const draft = plan()
    const saved = saveSplitPlan(layout, 'm1', draft, { validation: validateSplitPlan(draft, SPEC) })
    recordSplitReview(layout, 'm1', { approver: 'alice', decision: 'approved', planDigest: saved.digest })

    // A second write of the SAME plan renders the approval.
    saveSplitPlan(layout, 'm1', draft, { validation: validateSplitPlan(draft, SPEC) })
    assert.match(markdownOf(layout), /已由 alice/)

    // A re-plan makes the old approval stale, and the document says exactly that
    // — an approval that no longer describes THIS plan must not be repeated.
    const edited = plan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '重拆后的目标' }
    saveSplitPlan(layout, 'm1', edited, { validation: validateSplitPlan(edited, SPEC) })
    const md = markdownOf(layout)
    assert.match(md, /重拆后的目标/)
    assert.match(md, /必须重新审核/)
    assert.doesNotMatch(md, /已由 alice/, 'the stale approval is not restated as current')
})

test('the plan directory holds both artifacts and plan.md stays out of the gate record', () => {
    const { layout } = workspace()
    saveSplitPlan(layout, 'm1', plan(), { validation: validateSplitPlan(plan(), SPEC) })
    const splitDir = path.dirname(splitPlanMarkdownFile(layout, 'm1'))
    assert.deepEqual(fs.readdirSync(splitDir).sort(), ['plan.json', 'plan.md'])
    // Rendering is not a gate: no gate records appear for a plain write.
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm1', 'gates')), false)
})

/**
 * The split admission check of `team_delegate` (§5.38.5): when the repository
 * runs the split workflow, a delegation may start a child only from the
 * `implement` stage, and only on top of a plan that a person approved (or of no
 * plan at all — the legitimate "not worth splitting" / degraded route).
 *
 * Every case asserts BOTH halves of the decision: the refusal text a model reads,
 * and `fake.activationSpecs.length === 0` (a refusal that still started a child
 * would be a warning in disguise).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout } from 'dsh-eng-core'
import { recordSplitReview, saveSplitPlan, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const HOST_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image', 'subagent', 'skill']

/** A workspace whose effective `models.json` declares (or does not) the split workflow. */
function workspace(withSplit: boolean): string {
    const cwd = tempWorkspace('role-guard-split-gate-')
    const configDir = path.join(cwd, '.dsh', 'engineering-suite')
    fs.mkdirSync(configDir, { recursive: true })
    if (withSplit) fs.writeFileSync(path.join(configDir, 'models.json'), JSON.stringify({ split: { enabled: true } }))
    return cwd
}

/** One mission bound to the fake host's session (`session-1`) at `stage`. */
function missionAt(cwd: string, stage: string): string {
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: 'mission-split-gate', title: 'split gate', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'mission-split-gate', stage)
    store.update('mission-split-gate', () => ({ stage }))
    return 'mission-split-gate'
}

/** A valid two-task plan (the shapes the split validators accept). */
const PLAN: SplitPlan = {
    tasks: [
        { id: 'T-001', goal: '实现 AC-001', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
        { id: 'T-002', goal: '实现 AC-002', paths: ['packages/b/**'], acceptance: ['AC-002'], dependsOn: [], parallel: false },
    ],
    coverage: { 'AC-001': ['T-001'], 'AC-002': ['T-002'] },
    parallelGroups: [['T-001']],
}

/** Write a plan and approve it (the review quotes the digest of what was written). */
function approvedPlan(cwd: string, missionId: string): string {
    const layout = resolveLayout(cwd)
    const saved = saveSplitPlan(layout, missionId, PLAN)
    const written = recordSplitReview(layout, missionId, { approver: 'approval', decision: 'approved', planDigest: saved.digest })
    assert.equal(written.ok, true, written.problems.join('；'))
    return saved.digest
}

/** Assemble role-guard into the fake host (modern activation seam, so starts are countable). */
function host(cwd: string) {
    const fake = createFakeHost({ cwd, withSubagents: true, withActivation: true, withAgentPresets: true })
    for (const toolName of HOST_TOOLS) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
    apply(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log') })
    return fake
}

/** Run one delegation and return its rendered text plus whether it created a child. */
async function delegate(cwd: string) {
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'developer', task: '实现 AC-001' })
    return { run, text: runText(run), starts: fake.activationSpecs.length, fake }
}

test('TC-3003: 停留在 spec-approve 时拒绝派单，文案含"先走 split"与当前阶段（AC-001/AC-003）', async () => {
    const cwd = workspace(true)
    missionAt(cwd, 'spec-approve')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, true, text)
    assert.equal(starts, 0, 'a refusal must not start a child')
    assert.match(text, /先走 split/)
    assert.match(text, /当前阶段：spec-approve/)
    assert.match(text, /缺少的步骤/)
    assert.match(text, /开启拆分后必须先 advance 到 split 完成拆分与审核/)
    assert.match(text, /不值得拆.*合法路径.*必须先经过 split 阶段的判定/)
})

test('TC-3004: 停在 split 阶段同样拒绝，且不创建子会话（AC-001）', async () => {
    const cwd = workspace(true)
    missionAt(cwd, 'split')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, true, text)
    assert.equal(starts, 0)
    assert.match(text, /当前阶段：split（/)
})

test('split-review 阶段拒绝（AC-001）', async () => {
    const cwd = workspace(true)
    missionAt(cwd, 'split-review')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, true, text)
    assert.equal(starts, 0)
    assert.match(text, /当前阶段：split-review/)
})

test('TC-3001: implement 且磁盘上没有 plan 时放行（不值得拆/降级路径，AC-002）', async () => {
    const cwd = workspace(true)
    missionAt(cwd, 'implement')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, false, text)
    assert.equal(starts, 1)
    assert.match(text, /child session: activation-1/)
})

test('TC-3002: implement 且 plan 已 approved、摘要一致时放行（AC-002）', async () => {
    const cwd = workspace(true)
    const missionId = missionAt(cwd, 'implement')
    const digest = approvedPlan(cwd, missionId)
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, false, text)
    assert.equal(starts, 1)
    assert.match(text, /child session: activation-1/)
    // The admitted path must not carry the refusal sentence.
    assert.doesNotMatch(text, /team_delegate 拒绝/)
    assert.ok(digest.length >= 12)
})

test('TC-3005: plan 改动后审核摘要过期即拒绝，并要求重审（AC-002）', async () => {
    const cwd = workspace(true)
    const missionId = missionAt(cwd, 'implement')
    approvedPlan(cwd, missionId)
    // Re-plan AFTER the approval: the record still quotes the old digest.
    const saved = saveSplitPlan(resolveLayout(cwd), missionId, {
        ...PLAN,
        tasks: [...PLAN.tasks, { id: 'T-003', goal: '实现 AC-003', paths: ['packages/c/**'], acceptance: ['AC-003'], dependsOn: [], parallel: false }],
        coverage: { ...PLAN.coverage, 'AC-003': ['T-003'] },
    })
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, true, text)
    assert.equal(starts, 0)
    assert.match(text, /还没有通过审核（stale）/)
    assert.match(text, /重新送审/)
    assert.match(text, new RegExp(`当前 plan 摘要：${saved.digest.slice(0, 12)}`))
    assert.match(text, /审核记录引用的是 [0-9a-f]{12}/)
})

test('TC-3006: split 未开启时行为完全不变（任何阶段都照常派发，AC-004）', async () => {
    const cwd = workspace(false)
    missionAt(cwd, 'spec-approve')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, false, text)
    assert.equal(starts, 1)
    assert.doesNotMatch(text, /拆分/)
    // The "open switch" README stays honest: absent models.json = no gate at all.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'engineering-suite', 'models.json')), false)
})

test('没有绑定 mission 时不阻断（按未开启拆分处理），但日志留痕（AC-004 边界）', async () => {
    const cwd = workspace(true)
    const { run, text, starts, fake } = await delegate(cwd)
    assert.equal(run.isError, false, text)
    assert.equal(starts, 1)
    assert.doesNotMatch(text, /team_delegate 拒绝/)
    const log = fs.readFileSync(path.join(cwd, 'role-guard.log'), 'utf8')
    assert.match(log, /仓库开启了拆分，但调用方没有绑定 mission/)
    fake.dispose()
})

test('绑定的 mission 记录读不出来时 fail closed（读不到不等于没开拆分）', async () => {
    const cwd = workspace(true)
    missionAt(cwd, 'implement')
    // A dangling binding: the session is still bound, the record is unreadable.
    fs.writeFileSync(path.join(cwd, '.dsh', 'engineering-suite', 'missions', 'mission-split-gate', 'mission.json'), '{ not json')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, true, text)
    assert.equal(starts, 0)
    assert.match(text, /会话绑定的 mission mission-split-gate 读不出来/)
    assert.match(text, /读不到不等于没开拆分/)
})

test('models.json 把 split.enabled 写成非布尔值时按未开启处理，并在结果里报出来（不信猜测）', async () => {
    const cwd = tempWorkspace('role-guard-split-gate-typo-')
    const configDir = path.join(cwd, '.dsh', 'engineering-suite')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'models.json'), JSON.stringify({ split: { enabled: 'true' } }))
    missionAt(cwd, 'spec-approve')
    const { run, text, starts } = await delegate(cwd)
    assert.equal(run.isError, false, text)
    assert.equal(starts, 1)
    assert.match(text, /warning: 拆分准入检查：.*\.enabled 必须是布尔值/)
    assert.match(text, /按未开启处理/)
})

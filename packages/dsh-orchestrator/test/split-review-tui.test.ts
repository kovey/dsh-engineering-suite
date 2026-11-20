/**
 * The split review on the TUI (AC-002 / AC-004): the SAME experience as
 * `spec_approve` — a picker menu with four decisions and a read-only preview of
 * `split/plan.md` — and the SAME fallback when the host is not the TUI.
 *
 * The four answers are the contract and do not change with the surface: only
 * approve writes an approval (bound to the digest the person saw); reject writes
 * a rejection and rolls back to a re-plan; cancel/Esc write NOTHING and leave the
 * stage entered. Opening the plan decides nothing. A session whose approval
 * policy is `never` is refused BEFORE either surface asks — the TUI menu must not
 * become a way around "do not prompt me".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout, type Layout, type MissionStore } from 'dsh-eng-core'
import { readSplitPlan, readSplitReview, recordSplitReview, saveSplitPlan, splitRejectionCount, type SplitPlan } from 'dsh-eng-core/split'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** Sibling plugin tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** A stand-in for nvim-tui's public ext API, limited to what the menu + preview use. */
function fakeTui() {
    const pickers: { title: string; items: { label: string; value: string }[] }[] = []
    const viewers: { title: string; lines: string[]; target: string; closed: boolean }[] = []
    const notices: string[] = []
    const answers: (string | null)[] = []
    const api = {
        version: '0.1.0',
        capabilities: () => ({ picker: true, float: true }),
        nvim: {
            lua: async (code: string, args?: unknown[]) => {
                if (code.includes('show_lines_float')) {
                    viewers.push({
                        title: String(args?.[0] ?? ''),
                        lines: (args?.[1] as string[]) ?? [],
                        target: String(args?.[2] ?? ''),
                        closed: false,
                    })
                    return { buf: viewers.length, win: 100 + viewers.length }
                }
                if (code.includes('nvim_get_current_tabpage')) return 1
                // The reviewer closes the viewer right away (default).
                if (code.includes('nvim_buf_is_valid')) return false
                if (code.includes('close_lines_float')) return undefined
                throw new Error(`unexpected lua: ${code}`)
            },
        },
        ui: {
            picker: async (opts: { title: string; items: { label: string; value: string }[] }) => {
                pickers.push(opts)
                const next = answers.shift()
                return next === undefined ? null : next
            },
            notice: (text: unknown) => notices.push(String(text)),
        },
    }
    return {
        api,
        pickers,
        viewers,
        notices,
        /** Queue the picker answers, in order (`null` = Esc). */
        queue: (...values: (string | null)[]) => answers.push(...values),
    }
}

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** Give the fake approval service a real `effectivePolicy` (the `never` guard reads it). */
function provideApprovalPolicy(fake: FakeHost, policy: string): void {
    const context = fake.ctx as unknown as {
        get: (name: string) => unknown
        provide: (name: string, value: unknown) => unknown
    }
    const seam = context.get('approval') as Record<string, unknown>
    context.provide('approval', { ...seam, effectivePolicy: () => policy })
}

/** Assemble the plugin with the given host surface(s). */
function host(options: { approvalOutcome?: ApprovalOutcome; withApproval?: boolean; policy?: string; tui?: ReturnType<typeof fakeTui>; withPicker?: boolean } = {}): FakeHost {
    const cwd = tempWorkspace('orchestrator-split-tui-')
    const fake = createFakeHost({
        cwd,
        approvalOutcome: options.approvalOutcome ?? 'allowed-once',
        ...(options.withApproval === false ? { withApproval: false } : {}),
        ...(options.tui === undefined ? {} : { services: { 'nvim-tui': options.tui.api } }),
    })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log'), split: { enabled: true } })
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    if (options.policy !== undefined) provideApprovalPolicy(fake, options.policy)
    return fake
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

function storeFor(cwd: string): MissionStore {
    return new MissionStoreRegistry().for(cwd)
}

/** A mission parked on `split-review` with an approved spec (three criteria). */
function missionAt(fake: FakeHost, stage = 'split-review'): { store: MissionStore; cwd: string; layout: Layout } {
    const store = storeFor(fake.cwd)
    store.create({ id: 'm-split', title: '拆分审核测试', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm-split', stage)
    store.update('m-split', () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: '拆分审核测试',
            background: '',
            requirements: [],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'a' },
                { id: 'AC-002', text: 'b' },
                { id: 'AC-003', text: 'c' },
            ],
            fileBoundaries: ['packages/**'],
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
        },
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
    return { store, cwd: fake.cwd, layout: resolveLayout(fake.cwd) }
}

/** A valid two-task plan covering the three criteria. */
function goodPlan(): SplitPlan {
    return {
        tasks: [
            { id: 't1', goal: '做 a', paths: ['packages/a/**'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
            { id: 't2', goal: '做 b', paths: ['packages/b/**'], acceptance: ['AC-002', 'AC-003'], dependsOn: [], parallel: true },
        ],
        coverage: { 'AC-001': ['t1'], 'AC-002': ['t2'], 'AC-003': ['t2'] },
        parallelGroups: [['t1', 't2']],
    }
}

function reviewRows(layout: Layout): number {
    const file = path.join(layout.missionsDir, 'm-split', 'split', 'reviews.jsonl')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length : 0
}

function stageState(cwd: string, stageId: string): string | undefined {
    const file = path.join(cwd, '.dsh', 'missions', 'm-split', 'stages', `${stageId}.json`)
    if (!fs.existsSync(file)) return undefined
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { state: string }).state
}

// --- the menu --------------------------------------------------------------

test('with nvim-tui the review asks through a picker menu with exactly four decisions (TC-2602 / AC-002)', async () => {
    const tui = fakeTui()
    const fake = host({ tui, approvalOutcome: 'rejected' })
    const { layout } = missionAt(fake)
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())
    tui.queue('split:cancel')

    await orchestrate(fake, { action: 'advance' })

    assert.equal(tui.pickers.length, 1, 'the menu is the only thing asked')
    const menu = tui.pickers[0]!
    assert.match(menu.title, /拆分计划审核/)
    assert.match(menu.title, new RegExp(`摘要 ${saved.digest.slice(0, 12)}`))
    assert.match(menu.title, /子任务 2 \/ 并行组 1/)
    const labels = menu.items.map((item) => item.label).join('\n')
    assert.match(labels, /查看拆分计划（只读预览，q 关闭）/)
    assert.match(labels, /批准并派发/)
    assert.match(labels, /打回重写/)
    assert.match(labels, /取消/)
    assert.match(labels, /split\/plan\.md/, 'the menu names the readable document')
    assert.deepEqual(
        menu.items.map((item) => item.value),
        ['split:preview', 'split:approve', 'split:reject', 'split:cancel'],
    )
    assert.equal(fake.approvalRequests.length, 0, 'no generic approval card on top of the menu')
})

test('choosing 查看打开 plan.md in the shared read-only preview, then the menu returns (TC-2603 / AC-002)', async () => {
    const tui = fakeTui()
    const fake = host({ tui })
    const { cwd, layout } = missionAt(fake)
    saveSplitPlan(layout, 'm-split', goodPlan())
    // Read first, then decide nothing: the preview must not record anything.
    tui.queue('split:preview', null)

    const text = await orchestrate(fake, { action: 'advance' })

    assert.equal(tui.viewers.length, 1, 'the plan was opened in the read-only viewer')
    assert.match(tui.viewers[0]?.title ?? '', /拆分计划/)
    assert.match(tui.viewers[0]?.target ?? '', /split\/plan\.md$/)
    const shown = tui.viewers[0]?.lines.join('\n') ?? ''
    assert.match(shown, /^# 拆分计划/m)
    assert.match(shown, /\| t1 \| 做 a \|/, 'the reviewer sees the task table, not a summary')
    assert.match(shown, /## 四道自动校验/)
    assert.match(tui.notices.join('\n'), /已打开只读预览/)
    // The menu came back after the viewer closed, and Esc there decides nothing.
    assert.equal(tui.pickers.length, 2)
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.match(text, /审核被取消/)
    assert.match(text, /保持 entered/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
})

test('批准并派发 writes the approval for the shown digest and enters implement (TC-2604 / AC-002)', async () => {
    const tui = fakeTui()
    const fake = host({ tui })
    const { cwd, layout } = missionAt(fake)
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())
    tui.queue('split:approve')

    const text = await orchestrate(fake, { action: 'advance' })

    assert.match(text, /→ 下一阶段 implement/)
    const record = readSplitReview(layout, 'm-split')
    assert.equal(record?.decision, 'approved')
    assert.equal(record?.planDigest, saved.digest, 'the record binds the digest the human saw')
    assert.equal(record?.source, 'tui', 'the surface that decided is recorded')
    assert.equal(reviewRows(layout), 1)
    assert.equal(stageState(cwd, 'split-review'), 'passed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
    assert.equal(fake.approvalRequests.length, 0, 'the seam was never asked')
})

test('打回重写 asks why, writes a rejection and rolls back to a re-plan (TC-2607 / AC-002)', async () => {
    const tui = fakeTui()
    const fake = host({ tui })
    const { cwd, layout } = missionAt(fake)
    saveSplitPlan(layout, 'm-split', goodPlan())
    tui.queue('split:reject', 'split-reject:任务粒度不合适（太粗或太碎）')

    const text = await orchestrate(fake, { action: 'advance' })

    // The second popup asked WHY, and its canned answers are the split review's.
    assert.equal(tui.pickers.length, 2)
    assert.match(tui.pickers[1]?.title ?? '', /打回原因/)
    const record = readSplitReview(layout, 'm-split')
    assert.equal(record?.decision, 'rejected')
    assert.equal(record?.note, '任务粒度不合适（太粗或太碎）')
    assert.equal(splitRejectionCount(layout, 'm-split'), 1)
    assert.match(text, /审核被拒/)
    assert.match(text, /重新拆分/)
    assert.equal(stageState(cwd, 'split-review'), 'failed')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split')
    assert.equal(fs.existsSync(path.join(layout.missionsDir, 'm-split', 'stages', 'implement.json')), false)
})

test('Esc in the reason popup returns to the menu and decides nothing', async () => {
    const tui = fakeTui()
    const fake = host({ tui })
    const { cwd, layout } = missionAt(fake)
    saveSplitPlan(layout, 'm-split', goodPlan())
    tui.queue('split:reject', null, 'split:cancel')

    const text = await orchestrate(fake, { action: 'advance' })

    assert.equal(tui.pickers.length, 3, 'menu → reason (Esc) → menu')
    assert.equal(readSplitReview(layout, 'm-split'), undefined)
    assert.equal(reviewRows(layout), 0)
    assert.match(text, /审核被取消/)
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'split-review')
})

// --- without the TUI: the seam, with the readable plan named ----------------

test('without nvim-tui the approval seam asks, with split/plan.md and the plan numbers in the card (TC-2605 / AC-004)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    const { cwd, layout } = missionAt(fake)
    const saved = saveSplitPlan(layout, 'm-split', goodPlan())

    const text = await orchestrate(fake, { action: 'advance' })

    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(fake.approvalRequests.length, 1)
    const reason = (fake.approvalRequests[0] as { reason?: string }).reason ?? ''
    // The reviewer is pointed at the READABLE document, not only the JSON.
    assert.match(reason, /split\/plan\.md/)
    assert.match(reason, new RegExp(saved.digest.slice(0, 12)))
    assert.match(reason, /"子任务": 2/)
    assert.match(reason, /"并行组": 1/)
    assert.match(reason, /plan 摘要：/)
    assert.match(reason, /approval-context/)
    assert.equal(readSplitReview(layout, 'm-split')?.decision, 'approved')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

test('a TUI host with no approval seam still reviews (the menu is a real surface, not a fallback)', async () => {
    const tui = fakeTui()
    const fake = host({ tui, withApproval: false })
    const { cwd, layout } = missionAt(fake)
    saveSplitPlan(layout, 'm-split', goodPlan())
    tui.queue('split:approve')

    const text = await orchestrate(fake, { action: 'advance' })

    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(tui.pickers.length, 1)
    assert.equal(readSplitReview(layout, 'm-split')?.decision, 'approved')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

test('a TUI whose picker is unavailable hands over to the approval seam instead of failing', async () => {
    const tui = fakeTui()
    // A host that mounts nvim-tui but reports no picker cannot host the menu.
    const pickerless = { ...tui.api, capabilities: () => ({ picker: false }) }
    const fake = host({ approvalOutcome: 'allowed-once' })
    const { cwd, layout } = missionAt(fake)
    saveSplitPlan(layout, 'm-split', goodPlan())
    const context = fake.ctx as unknown as { provide: (name: string, value: unknown) => unknown }
    context.provide('nvim-tui', pickerless)

    const text = await orchestrate(fake, { action: 'advance' })

    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(tui.pickers.length, 0)
    assert.equal(fake.approvalRequests.length, 1, 'the seam asked instead')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
})

// --- `never` is refused before EITHER surface asks -------------------------

test('an approval policy of never BLOCKS on both routes, with no menu and no review row (TC-2606 / AC-004)', async () => {
    // Route 1: the TUI menu would have been shown — it must not be.
    const tui = fakeTui()
    const viaTui = host({ tui, policy: 'never' })
    const first = missionAt(viaTui)
    saveSplitPlan(first.layout, 'm-split', goodPlan())
    const tuiText = await orchestrate(viaTui, { action: 'advance' })
    assert.match(tuiText, /本会话审批策略为 never（提示被禁用）：宿主不会弹任何审批卡，而是直接返回 rejected/)
    assert.match(tuiText, /所以这次没有记录成'人工打回'，也不计入拆分审核轮数/)
    assert.equal(tui.pickers.length, 0, 'never must not render the menu')
    assert.equal(reviewRows(first.layout), 0)
    assert.equal(splitRejectionCount(first.layout, 'm-split'), 0)
    assert.equal(stageState(first.cwd, 'split-review'), undefined)
    assert.equal(storeFor(first.cwd).read('m-split')?.stage, 'split-review')

    // Route 2: no TUI, the seam — the same refusal, byte for byte.
    const viaSeam = host({ policy: 'never' })
    const second = missionAt(viaSeam)
    saveSplitPlan(second.layout, 'm-split', goodPlan())
    const seamText = await orchestrate(viaSeam, { action: 'advance' })
    assert.match(seamText, /本会话审批策略为 never（提示被禁用）/)
    assert.equal(viaSeam.approvalRequests.length, 0)
    assert.equal(reviewRows(second.layout), 0)
    assert.equal(storeFor(second.cwd).read('m-split')?.stage, 'split-review')
})

// --- an edited plan is reviewed again on the TUI too -----------------------

test('a plan edited after approval is reviewed again in the menu, and the new digest is what gets approved', async () => {
    const tui = fakeTui()
    const fake = host({ tui })
    const { cwd, layout } = missionAt(fake)
    const first = saveSplitPlan(layout, 'm-split', goodPlan())
    // An approval of the OLD digest exists; the plan then changes.
    recordSplitReview(layout, 'm-split', { approver: 'alice', decision: 'approved', planDigest: first.digest })
    const edited = goodPlan()
    edited.tasks[0] = { ...edited.tasks[0]!, goal: '换了目标' }
    const second = saveSplitPlan(layout, 'm-split', edited)
    assert.notEqual(second.digest, first.digest)
    tui.queue('split:approve')

    const text = await orchestrate(fake, { action: 'advance' })

    assert.match(text, /→ 下一阶段 implement/)
    assert.equal(tui.pickers.length, 1)
    assert.equal(readSplitReview(layout, 'm-split')?.planDigest, second.digest)
    assert.equal(readSplitReview(layout, 'm-split')?.decision, 'approved')
    assert.equal(storeFor(cwd).read('m-split')?.stage, 'implement')
    assert.equal(readSplitPlan(layout, 'm-split')?.digest, second.digest)
})

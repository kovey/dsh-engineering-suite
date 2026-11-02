/**
 * Attention: "a question waiting for a person", and a pause that extends a
 * deadline instead of burning it.
 *
 * The rules these tests pin down:
 *
 *  - an attention is DERIVED from the ledger (a question with no decision row);
 *    the sidecar stores only `whyYou`, the closing transitions and the pause
 *    interval;
 *  - `whyYou` has exactly two values, `decision-required` when nothing was
 *    recorded, and never a third;
 *  - `stale` is computed on read with a REASON (policy version / too old /
 *    mission ended) and the attention stays listed;
 *  - a question becomes `superseded` once when its mission ends, and a late
 *    answer is REFUSED with the usual refusal shape — it never becomes an
 *    approval;
 *  - while a mission is blocked/paused the deadline does not run:
 *    `deadlineAt = askedAt + window + pausedMs`, a wait started before the pause
 *    does not time out during it and reports the extension, and resuming
 *    continues from the extended deadline;
 *  - `withdrawn` is recorded once, is not an answer and is not an approval.
 *
 * Everything is driven through the real tool surface (`apply` + `runTool`) and
 * through the sidecar API, with an injected clock wherever the math is asserted.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import {
    DEFAULT_WHY_YOU,
    WHY_YOU_VALUES,
    createAttentionSource,
    isWhyYou,
    missionFactsOf,
    pauseIntervals,
    readAttention,
    staleOf,
    type AttentionSource,
} from '../dist/attention.js'
import { apply } from '../dist/index.js'
import { appendLedgerRow, newRowId, readLedger, refusalOf, summarizeLedger } from '../dist/ledger.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const ATTENTION = '.dsh/interaction/attention.jsonl'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const hosts: FakeHost[] = []

/** Assemble the plugin in a throwaway workspace. */
function host(cwd: string): FakeHost & { registry: any } {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'interaction-gate.log') })
    const registry = (fake.ctx as { get: (service: string) => unknown }).get('interaction')
    return Object.assign(fake, { registry })
}

/** A scripted channel: the test decides when (and what) it answers. */
function scriptedChannel(channelName: string, options: { waitMode?: 'never' } = {}) {
    const sent: any[] = []
    const state: { waiter?: (value: unknown) => void; tokens: string[] } = { tokens: [] }
    const channel: any = {
        name: channelName,
        async send(message: any) {
            sent.push(message)
            return { ok: true, messageId: `m-${channelName}-${sent.length}` }
        },
        async wait(questionId: string): Promise<unknown> {
            state.tokens.push(questionId)
            return await new Promise((resolve) => {
                state.waiter = resolve
                if (options.waitMode === 'never') return
            })
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    }
    return { name: channelName, sent, state, channel }
}

/** Answer once the channel has reached its wait. */
async function answerWith(scripted: ReturnType<typeof scriptedChannel>, value: unknown): Promise<void> {
    for (let index = 0; index < 500 && scripted.state.waiter === undefined; index += 1) await sleep(2)
    assert.ok(scripted.state.waiter !== undefined, `${scripted.name} 没有进入等待状态`)
    scripted.state.waiter(value)
}

function rowsOf(cwd: string) {
    return readLedger(path.join(cwd, LEDGER)).rows
}

function attentionRowsOf(cwd: string) {
    return readAttention(path.join(cwd, ATTENTION)).rows
}

/** A sidecar over one temp workspace with a clock the test owns. */
function sourceOver(cwd: string, clock: { at: number }, options: { maxAgeMs?: number; mission?: (id: string) => any } = {}): AttentionSource {
    return createAttentionSource({
        file: path.join(cwd, ATTENTION),
        ledgerFile: path.join(cwd, LEDGER),
        now: () => clock.at,
        defaultWindowMs: 900_000,
        maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60 * 1_000,
        ...(options.mission === undefined ? {} : { mission: options.mission }),
    })
}

/** Write one pending ask row (the question itself lives in the ledger). */
function askRow(file: string, input: { at: number; questionId: string; title?: string; missionId?: string; windowMs?: number }): void {
    appendLedgerRow(file, {
        at: input.at,
        id: newRowId(),
        kind: 'ask',
        title: input.title ?? `问题 ${input.questionId}`,
        questionId: input.questionId,
        channel: 'im',
        ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
        ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
    })
}

function decideRow(file: string, input: { at: number; questionId: string; decision: string }): void {
    appendLedgerRow(file, {
        at: input.at,
        id: newRowId(),
        kind: 'ask',
        title: `问题 ${input.questionId}`,
        questionId: input.questionId,
        channel: 'im',
        decision: input.decision,
        userId: 'alice',
    })
}

test('attention 由台账派生：未回答的列出、已回答的不列；列表最老在前', () => {
    const cwd = tempWorkspace('attention-derive-')
    const ledger = path.join(cwd, LEDGER)
    fs.mkdirSync(path.dirname(ledger), { recursive: true })
    askRow(ledger, { at: 1_000, questionId: 'q-old', windowMs: 60_000 })
    askRow(ledger, { at: 2_000, questionId: 'q-new' })
    askRow(ledger, { at: 1_500, questionId: 'q-done' })
    decideRow(ledger, { at: 1_600, questionId: 'q-done', decision: 'allowed-once' })

    const clock = { at: 10_000 }
    const source = sourceOver(cwd, clock)
    const attentions = source.attentions()
    assert.deepEqual(
        attentions.map((entry) => entry.questionId),
        ['q-old', 'q-new'],
        '未回答的按最老在前；已回答的不在注意力里',
    )
    assert.equal(attentions[0]?.ageMs, 9_000)
    // The window comes from the ledger row when it carries one, else the ceiling.
    assert.equal(attentions[0]?.windowMs, 60_000)
    assert.equal(attentions[0]?.deadlineAt, 1_000 + 60_000)
    assert.equal(attentions[1]?.windowMs, 900_000, '没有 windowMs 的旧行按配置上限')
    // The answered one still has a record (it is not deleted, it is closed).
    assert.equal(source.stateOf('q-done'), 'answered')
    assert.equal(source.records().find((record) => record.questionId === 'q-done')?.decision, 'allowed-once')
    assert.equal(source.stateOf('q-never-asked'), undefined)
})

test('whyYou：默认 decision-required；两个显式值都被记录；第三个值被拒绝（绝不发明）', async () => {
    const cwd = tempWorkspace('attention-why-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-default' })
    askRow(path.join(cwd, LEDGER), { at: 2_000, questionId: 'q-result' })
    askRow(path.join(cwd, LEDGER), { at: 2_500, questionId: 'q-decide' })
    const clock = { at: 3_000 }
    const source = sourceOver(cwd, clock)

    // Nothing recorded: the conservative default, and it says it is a default.
    const byDefault = source.attentions().find((entry) => entry.questionId === 'q-default')
    assert.equal(byDefault?.whyYou, DEFAULT_WHY_YOU)
    assert.equal(byDefault?.whyYou, 'decision-required')
    assert.equal(byDefault?.whyYouSource, 'default')

    // Both explicit values round-trip.
    assert.equal(source.recordWhy('q-decide', 'decision-required'), true)
    const explicitDecision = source.attentions().find((entry) => entry.questionId === 'q-decide')
    assert.equal(explicitDecision?.whyYou, 'decision-required')
    assert.equal(explicitDecision?.whyYouSource, 'recorded', '显式写下的值不能读成"默认"')
    assert.equal(source.recordWhy('q-result', 'result-usable'), true)
    const recorded = source.attentions().find((entry) => entry.questionId === 'q-result')
    assert.equal(recorded?.whyYou, 'result-usable')
    assert.equal(recorded?.whyYouSource, 'recorded')
    // Recorded ONCE per question: a second call writes nothing.
    assert.equal(source.recordWhy('q-result', 'decision-required'), false)
    assert.equal(
        readAttention(path.join(cwd, ATTENTION)).rows.filter((row) => row.kind === 'why').length,
        2,
        '每个提问一条 why 行（q-decide 与 q-result），重复调用不再新增',
    )

    // There is no third value: exactly two, and a row claiming a third is not a
    // why-row at all (it falls back to the default instead of inventing one).
    assert.deepEqual([...WHY_YOU_VALUES], ['decision-required', 'result-usable'])
    assert.equal(isWhyYou('nice-to-have'), false)
    fs.appendFileSync(path.join(cwd, ATTENTION), `${JSON.stringify({ at: 3_100, id: 'ar-third', kind: 'why', questionId: 'q-default', whyYou: 'nice-to-have' })}\n`)
    assert.equal(source.attentions().find((entry) => entry.questionId === 'q-default')?.whyYou, DEFAULT_WHY_YOU)
    assert.equal(
        readAttention(path.join(cwd, ATTENTION)).skipped,
        1,
        '第三个值的行被跳过并计数（不是被当成一个合法值）',
    )

    // At the tool surface the third value never reaches the question either.
    const fake = host(tempWorkspace('attention-why-tool-'))
    const bad = await fake.runTool('interaction_ask', { question: '要放行吗？', options: ['yes', 'no'], whyYou: 'nice-to-have' })
    assert.equal(bad.isError, true)
    const text = runText(bad)
    assert.match(text, /"decision-required"/)
    assert.match(text, /"result-usable"/)
})

test('whyYou 在提问时落盘：卡片发出后就能读出"为什么问这一句"', async () => {
    const cwd = tempWorkspace('attention-why-ask-')
    const fake = host(cwd)
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)
    const running = fake.runTool('interaction_ask', { question: '有个结果你要不要用？', options: ['用', '不用'], whyYou: 'result-usable', missionId: 'm-1' })
    await answerWith(im, { value: '用', by: 'alice' })
    const run = await running
    assert.equal(run.isError, false, runText(run))

    const why = attentionRowsOf(cwd).filter((row) => row.kind === 'why')
    assert.equal(why.length, 1)
    assert.equal(why[0]?.whyYou, 'result-usable')
    assert.equal(why[0]?.questionId, im.state.tokens[0])
    // The question was answered, so it is NOT an attention any more — but the
    // ledger row carries the window it was allowed.
    const asked = rowsOf(cwd).find((row) => row.kind === 'ask' && row.decision === undefined)
    assert.equal(asked?.windowMs, 900_000, '台账记下这次提问被允许等多久')
})

test('stale：策略版本变了 → 带理由列出（不隐藏）', () => {
    const cwd = tempWorkspace('attention-stale-policy-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '换过策略的任务', cwd, id: 'M-1' })
    store.update('M-1', () => ({
        status: 'implementing',
        mandate: {
            version: 1,
            strength: 'explicit',
            basis: 'spec-approved',
            scope: { phases: [], paths: [] },
            policyVersion: 'not-the-current-trust-root',
            approvedBy: 'alice',
            at: 1,
        },
    }))
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-policy', missionId: 'M-1' })

    const clock = { at: 2_000 }
    const source = sourceOver(cwd, clock, { mission: (id) => missionFactsOf(store, id) })
    const attention = source.attentions()[0]
    assert.ok(attention !== undefined)
    assert.equal(attention.stale?.reason, 'policy-version')
    assert.match(attention.stale?.detail ?? '', /策略版本/)
    assert.match(attention.stale?.detail ?? '', /当前信任根/)
    assert.equal(source.attentions().length, 1, '过期的注意力仍然列出，只是被标注')
})

test('stale：等得太久 → 带理由列出（不隐藏）', () => {
    const cwd = tempWorkspace('attention-stale-old-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-old' })
    const clock = { at: 1_000 + 2 * 3_600_000 }
    const source = sourceOver(cwd, clock, { maxAgeMs: 3_600_000 })
    const attention = source.attentions()[0]
    assert.equal(attention?.stale?.reason, 'too-old')
    assert.match(attention?.stale?.detail ?? '', /超过上限 1 小时/)
    assert.equal(source.attentions().length, 1)
    // A question inside the bound carries no stale mark at all.
    assert.equal(staleOf({ askedAt: 0, ageMs: 1_000, maxAgeMs: 3_600_000 }), undefined)
})

test('stale：mission 已结束 → 带理由列出（不隐藏）', () => {
    const cwd = tempWorkspace('attention-stale-ended-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '已交付的任务', cwd, id: 'M-1' })
    store.setStatus('M-1', 'delivered')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-ended', missionId: 'M-1' })

    const clock = { at: 2_000 }
    const source = sourceOver(cwd, clock, { mission: (id) => missionFactsOf(store, id) })
    const attention = source.attentions()[0]
    assert.equal(attention?.stale?.reason, 'mission-ended')
    assert.match(attention?.stale?.detail ?? '', /已交付/)
    assert.equal(source.attentions().length, 1)
})

test('superseded：mission 结束后提问作废（只记一次），迟到的答案被拒绝且不算批准', async () => {
    const cwd = tempWorkspace('attention-superseded-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '会先结束的任务', cwd, id: 'M-9' })
    store.bindSession('session-1', 'M-9')
    store.setStatus('M-9', 'implementing')

    const fake = host(cwd)
    const im = scriptedChannel('im', { waitMode: 'never' })
    fake.registry.register(im.channel)

    const running = fake.runTool('interaction_ask', { question: '这一步能发布吗？', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    for (let index = 0; index < 500 && im.state.waiter === undefined; index += 1) await sleep(2)
    assert.ok(im.state.waiter !== undefined, '卡片必须已发出并进入等待')
    const token = im.state.tokens[0] as string

    // The mission completes while the question is still waiting.
    store.setStatus('M-9', 'delivered')
    await answerWith(im, { value: 'allowed-once', by: 'alice' })
    const run = await running

    // (1) The gate refuses, naming the reason, in the usual refusal shape.
    assert.equal(run.isError, true, '迟到的答案必须被拒绝')
    const text = runText(run)
    assert.match(text, /interaction_ask 拒绝（refused:superseded）/)
    assert.match(text, /迟到的回答不算决定/)

    // (2) The question became superseded ONCE, with the reason and the mission id.
    const closures = attentionRowsOf(cwd).filter((row) => row.kind === 'superseded')
    assert.equal(closures.length, 1, '作废只记一次')
    assert.equal(closures[0]?.missionId, 'M-9')
    assert.match(closures[0]?.reason ?? '', /已交付/)

    // (3) NO decision: the ledger has the pending ask row and one refusal, and
    // the approval count is still zero.
    const rows = rowsOf(cwd)
    const summary = summarizeLedger(rows, Date.now())
    assert.equal(summary.answered, 0, '作废的提问不产生任何批准')
    assert.equal(summary.byDecision[refusalOf('superseded')], 1)
    const decisions = rows.filter((row) => row.decision !== undefined).map((row) => row.decision ?? '')
    assert.ok(
        decisions.every((decision) => decision.startsWith('refused:')),
        `除了拒绝，不能写下任何决定（实际：${decisions.join(', ')}）`,
    )
    assert.ok(!decisions.includes('allowed-once'))

    // (4) The attention is gone from the queue, and the state is recorded.
    const source = sourceOver(cwd, { at: Date.now() }, { mission: (id) => missionFactsOf(store, id) })
    assert.deepEqual(source.attentions(), [])
    assert.equal(source.stateOf(token), 'superseded')

    // (5) A second sweep records nothing new.
    const swept = source.sweep()
    assert.equal(swept.superseded, 0)
    assert.equal(attentionRowsOf(cwd).filter((row) => row.kind === 'superseded').length, 1)
})

test('superseded：授权被撤回（人工停止）也算 mission 结束 → 提问作废（一次，带原因）', () => {
    const cwd = tempWorkspace('attention-stopped-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '会被停掉的任务', cwd, id: 'M-2' })
    store.update('M-2', () => ({
        status: 'implementing',
        mandate: {
            version: 1,
            strength: 'explicit',
            basis: 'spec-approved',
            scope: { phases: [], paths: [] },
            policyVersion: 'pv-1',
            approvedBy: 'alice',
            at: 1,
        },
    }))
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-stopped', missionId: 'M-2' })

    const clock = { at: 2_000 }
    const source = sourceOver(cwd, clock, { mission: (id) => missionFactsOf(store, id) })
    assert.equal(source.attentions().length, 1)
    // A person's stop: the mandate is withdrawn (the status becomes `blocked`).
    store.withdrawMandate('M-2', { at: 2_500, by: 'alice', reason: '不做了' })
    const swept = source.sweep()
    assert.equal(swept.superseded, 1)
    assert.deepEqual(source.attentions(), [])
    const closures = attentionRowsOf(cwd).filter((row) => row.kind === 'superseded')
    assert.equal(closures.length, 1)
    assert.match(closures[0]?.reason ?? '', /撤回/)
    assert.match(closures[0]?.reason ?? '', /不做了/)
    assert.equal(source.sweep().superseded, 0, '只记一次')
})

test('withdrawn：只记一次，不算已回答、不算批准；迟到的答案同样被拒绝', async () => {
    // (a) the transition itself
    const cwd = tempWorkspace('attention-withdrawn-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-withdraw' })
    const clock = { at: 2_000 }
    const source = sourceOver(cwd, clock)
    assert.equal(source.attentions().length, 1)

    assert.equal(source.withdraw('q-withdraw', '门禁放弃了这次提问'), true)
    assert.equal(source.withdraw('q-withdraw', '第二次不该再记一行'), false)
    const rows = attentionRowsOf(cwd).filter((row) => row.kind === 'withdrawn')
    assert.equal(rows.length, 1, '撤回只记一次')
    assert.equal(rows[0]?.reason, '门禁放弃了这次提问')
    assert.deepEqual(source.attentions(), [], '撤回后不再等回答')
    assert.equal(source.stateOf('q-withdraw'), 'withdrawn')
    // Not an answer: the ledger is untouched, and nothing counts as answered.
    const ledgerRows = rowsOf(cwd)
    assert.equal(ledgerRows.length, 1)
    assert.equal(ledgerRows[0]?.decision, undefined)
    assert.equal(summarizeLedger(ledgerRows, clock.at).answered, 0, '撤回不是回答，也不是批准')

    // (b) the same transition while a tool call is waiting: the answer is refused
    const cwd2 = tempWorkspace('attention-withdrawn-live-')
    const fake = host(cwd2)
    const im = scriptedChannel('im', { waitMode: 'never' })
    fake.registry.register(im.channel)
    const running = fake.runTool('interaction_ask', { question: '还需要这个答案吗？', options: ['yes', 'no'], timeoutMs: 5_000, missionId: 'm-3' })
    for (let index = 0; index < 500 && im.state.waiter === undefined; index += 1) await sleep(2)
    const token = im.state.tokens[0] as string
    assert.equal(fake.registry.withdrawQuestion(token, '门禁已经不问了'), true)
    await answerWith(im, { value: 'yes', by: 'alice' })
    const run = await running
    assert.equal(run.isError, true)
    assert.match(runText(run), /interaction_ask 拒绝（refused:withdrawn）/)
    assert.equal(summarizeLedger(rowsOf(cwd2), Date.now()).answered, 0, '撤回后的回答不产生批准')
})

test('pause：暂停区间把 deadlineAt 精确推后（askedAt + window + pausedMs）', () => {
    const cwd = tempWorkspace('attention-pause-math-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    const ledger = path.join(cwd, LEDGER)
    askRow(ledger, { at: 1_000, questionId: 'q-paused', missionId: 'M-1', windowMs: 60_000 })

    const clock = { at: 1_000 }
    const source = sourceOver(cwd, clock)
    assert.equal(source.attentions()[0]?.deadlineAt, 61_000, '没有暂停时：askedAt + window')

    clock.at = 11_000
    assert.equal(source.pauseMission('M-1', '熔断中'), true)
    assert.equal(source.pauseMission('M-1', '重复的暂停不该再记一行'), false)
    clock.at = 41_000
    const paused = source.attentions()[0]
    assert.equal(paused?.pausedMs, 30_000, '暂停 30s：pausedMs 就是被暂停的时长')
    assert.equal(paused?.deadlineAt, 61_000 + 30_000, '截止时间被暂停精确推后')
    assert.equal(paused?.paused?.from, 11_000)

    clock.at = 51_000
    assert.equal(source.resumeMission('M-1'), true)
    assert.equal(source.resumeMission('M-1'), false, '恢复只记一次')
    clock.at = 99_000
    const resumed = source.attentions()[0]
    assert.equal(resumed?.pausedMs, 40_000, '恢复后 pausedMs 不再增长（区间已闭合）')
    assert.equal(resumed?.deadlineAt, 61_000 + 40_000, '恢复后从顺延后的截止时间继续')
    assert.equal(resumed?.paused, undefined)
    // The interval is one pair of rows, from the pause start to the resume.
    const intervals = pauseIntervals(readAttention(path.join(cwd, ATTENTION)).rows).intervals
    assert.deepEqual(intervals, [{ missionId: 'M-1', from: 11_000, to: 51_000 }])
})

test('pause：等待在暂停期间不超时，超时信息说明被延长了多少；恢复后从顺延后的截止时间继续', async () => {
    const cwd = tempWorkspace('attention-pause-wait-')
    const fake = host(cwd)
    const im = scriptedChannel('im', { waitMode: 'never' })
    fake.registry.register(im.channel)

    const startedAt = Date.now()
    const running = fake.runTool('interaction_ask', { question: '熔断中还要继续吗？', options: ['yes', 'no'], timeoutMs: 150, missionId: 'm-paused' })
    for (let index = 0; index < 500 && im.state.waiter === undefined; index += 1) await sleep(2)
    assert.ok(im.state.waiter !== undefined, '卡片必须已发出并进入等待')
    const token = im.state.tokens[0] as string

    // The mission blocks ~60ms into the wait; the timeout would otherwise fire
    // at +150ms. Registered through the service hook (the same rows the ask's
    // own mission sampling writes).
    assert.equal(fake.registry.pauseMission('m-paused', '熔断中'), true)
    // Well past the original deadline the call must still be waiting: a pause
    // does not burn the deadline.
    await sleep(300)
    const during = rowsOf(cwd)
    assert.equal(
        during.filter((row) => row.decision !== undefined).length,
        0,
        '暂停期间不得超时：台账里还没有任何决定行',
    )

    assert.equal(fake.registry.resumeMission('m-paused'), true)
    const run = await running
    const elapsed = Date.now() - startedAt
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.match(text, /refused:timeout/)
    assert.match(text, /等待被延长 \d+ms/, '超时信息必须说明等待被延长了多少')
    assert.match(text, /期限不流逝/)
    const extensionMs = Number(/等待被延长 (\d+)ms/.exec(text)?.[1] ?? '0')
    assert.ok(extensionMs >= 200, `延长应当覆盖暂停时长（实际 ${extensionMs}ms）`)
    assert.ok(extensionMs <= elapsed, `延长不能超过实际耗时（延长 ${extensionMs}ms，耗时 ${elapsed}ms）`)
    assert.ok(elapsed >= 350, `暂停必须推迟超时（实际 ${elapsed}ms）`)

    // Resuming continues from the EXTENDED deadline: the reported deadline is
    // askedAt + window + pausedMs, not askedAt + window. The interval is on disk,
    // so any later reader (the doctor, a resumed session) computes the same one.
    const asked = rowsOf(cwd).find((row) => row.kind === 'ask' && row.decision === undefined)
    assert.ok(asked !== undefined)
    const source = sourceOver(cwd, { at: Date.now() })
    const pausedMs = source.pausedMsFor({ missionId: 'm-paused', questionId: token, from: asked.at, to: asked.at + elapsed })
    assert.ok(pausedMs > 0, `暂停时长必须留在记录里（实际 ${pausedMs}ms）`)
    assert.ok(asked.windowMs !== undefined)
    assert.equal(asked.at + asked.windowMs! + pausedMs, asked.at + 150 + pausedMs, '截止时间 = askedAt + window + pausedMs')
    const intervals = pauseIntervals(readAttention(path.join(cwd, ATTENTION)).rows).intervals
    assert.equal(intervals.length, 1)
    assert.equal(intervals[0]?.to === undefined, false, '恢复后区间已闭合')
})

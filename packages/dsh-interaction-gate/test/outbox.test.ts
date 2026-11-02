/**
 * dsh-interaction-gate — the ask outbox (durability for the send).
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 *
 * Two levels, on purpose:
 *  - the MODULE level drives `createOutbox` directly with an injected clock, an
 *    injected sleep and a fake deliverer, so backoff/replay/ordering are claimed
 *    deterministically (no wall-clock timing in the claim);
 *  - the TOOL level drives the real surface (`apply` + `runTool`) so the claim
 *    "an ask records its intent first" is about what a channel plugin sees, not
 *    about what this file believes.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { appendLedgerRow, readLedger, refusalOf } from '../dist/ledger.js'
import {
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    ORDER_FAILURE_LIMIT,
    blockingRecordFor,
    createOutbox,
    outboxIdOf,
    readOutbox,
    type OutboxDeliver,
} from '../dist/outbox.js'
import { createAskDeliverer } from '../dist/tools.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const OUTBOX = '.dsh/interaction/outbox.jsonl'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const hosts: FakeHost[] = []

/** Assemble the plugin in a throwaway workspace (same shape as the acceptance suite). */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost & { registry: any } {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'interaction-gate.log'), ...config })
    const registry = (fake.ctx as { get: (service: string) => unknown }).get('interaction')
    return Object.assign(fake, { registry })
}

/** Poll until `predicate` holds (the tools are async; nothing here sleeps blind). */
async function waitFor(predicate: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > budgetMs) throw new Error(`等待超时：${label}`)
        await sleep(2)
    }
}

/** A channel with an explicit conversation id and a queue of waiters. */
function conversationChannel(name: string, chatId: string): {
    name: string
    sent: any[]
    waiters: ((value: unknown) => void)[]
    channel: any
} {
    const sent: any[] = []
    const waiters: ((value: unknown) => void)[] = []
    return {
        name,
        sent,
        waiters,
        channel: {
            name,
            chatId,
            async send(message: any) {
                sent.push(message)
                return { ok: true, messageId: `m-${name}-${sent.length}` }
            },
            async wait() {
                return await new Promise((resolve) => {
                    waiters.push(resolve)
                })
            },
            describe: () => ({ canAsk: true, canNotify: true }),
        },
    }
}

/** Answer the n-th wait of a channel (0-based). */
async function answer(channel: ReturnType<typeof conversationChannel>, index: number, value: unknown): Promise<void> {
    await waitFor(() => channel.waiters.length > index, `${channel.name} 的第 ${index + 1} 次等待`)
    channel.waiters[index](value)
}

/** A clock the test moves by hand (no `Date.now()` anywhere in the claims). */
function fakeClock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
    const state = { t: start }
    return { now: () => state.t, advance: (ms: number) => (state.t += ms) }
}

function outboxRows(cwd: string, file = OUTBOX): any[] {
    return readOutbox(path.join(cwd, file)).rows
}

test('意图先落盘：通道发送抛错时，outbox 里已有 intent 行，随后才是 send-failed 行', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const fake = host(cwd)
    const file = path.join(cwd, OUTBOX)
    const seen: string[] = []
    fake.registry.register({
        name: 'im',
        chatId: 'chat-1',
        async send() {
            // What the channel can see AT THE MOMENT it is touched: the intent
            // row must already be on disk (never "send first, record later").
            seen.push(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
            throw new Error('webhook 挂了')
        },
        async wait() {
            return await new Promise(() => undefined)
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    })

    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:send-failed'), text)

    assert.equal(seen.length, 1, '通道被碰了一次')
    const visible = seen[0]!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    assert.equal(visible.length, 1, '发卡片时 outbox 里必须已经有那一行')
    assert.equal(visible[0].state, 'intent')
    assert.equal(visible[0].kind, 'ask')
    assert.equal(visible[0].channel, 'im')
    assert.equal(visible[0].chatId, 'chat-1')
    assert.equal(visible[0].attempts, 0)

    const rows = outboxRows(cwd)
    assert.deepEqual(
        rows.map((row) => row.state),
        ['intent', 'send-failed'],
    )
    assert.equal(rows[0].id, rows[1].id, '状态变化是同一道提问的追加行')
    assert.equal(rows[1].id, outboxIdOf({ questionId: rows[0].questionId, channel: 'im', chatId: 'chat-1' }), 'id 是内容寻址的')
    assert.equal(rows[1].attempts, 1)
    assert.equal(rows[1].nextAttemptAt - rows[1].at, BACKOFF_BASE_MS, '第一次失败退避 5 秒')
    assert.ok((rows[1].settleReason ?? '').includes('webhook 挂了'), rows[1].settleReason)
    assert.ok(text.includes(rows[0].id), '拒绝报文要指出 outbox 行')
})

test('重放只重发一次：第二次尝试成功 → 一条提问、一条台账行、一条 sent 行', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, 'outbox.jsonl')
    const clock = fakeClock()
    const outbox = createOutbox({ file, now: clock.now, sleep: async (ms) => clock.advance(ms) })
    const ledgerRows: string[] = []
    let attempts = 0
    const deliver: OutboxDeliver = async (record) => {
        attempts += 1
        if (attempts === 1) return { ok: false, error: '第一次：webhook 503' }
        ledgerRows.push(`${record.questionId}@${record.channel}`)
        return { ok: true, messageId: 'm-1', ledgerRowId: 'il-1' }
    }
    const begun = outbox.begin({ questionId: 'q-replay', channel: 'im', chatId: 'c1' })
    outbox.attach(begun.record.id, deliver, { deadlineAt: clock.now() + 60_000 })

    const first = await outbox.deliver(begun.record.id)
    assert.equal(first.ok, false)
    assert.equal(first.record?.state, 'send-failed')

    // Inside the backoff window nothing is retried.
    const early = await outbox.replay('manual')
    assert.equal(early.resent, 0)
    assert.equal(early.notDue, 1, '未到 nextAttemptAt 的记录不重发')
    assert.equal(attempts, 1)

    clock.advance(BACKOFF_BASE_MS)
    const retried = await outbox.replay('manual')
    assert.equal(retried.resent, 1)
    assert.equal(attempts, 2)
    assert.equal(ledgerRows.length, 1, '重发成功也只写一条台账行')

    // A second replay changes nothing: `sent` is not a retryable state.
    const again = await outbox.replay('manual')
    assert.equal(again.considered, 0)
    assert.equal(attempts, 2)
    const rows = readOutbox(file).rows
    assert.deepEqual(
        rows.map((row) => row.state),
        ['intent', 'send-failed', 'sent'],
    )
    assert.equal(new Set(rows.map((row) => row.id)).size, 1, '一道提问只有一条记录')
    assert.equal(new Set(rows.map((row) => row.questionId)).size, 1)
})

test('同一会话按顺序发送：慢的第一条挡住同会话的第二条，另一个会话不等；status 报 behind', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const fake = host(cwd)
    const chatA = conversationChannel('chat-a', 'A')
    const chatB = conversationChannel('chat-b', 'B')
    fake.registry.register(chatA.channel)
    fake.registry.register(chatB.channel)

    const first = fake.runTool('interaction_ask', { question: 'A 的第一条', options: ['yes', 'no'], prefer: 'chat-a', timeoutMs: 8_000 })
    await waitFor(() => chatA.sent.length === 1, '第一条先发出去')

    const second = fake.runTool('interaction_ask', { question: 'A 的第二条', options: ['yes', 'no'], prefer: 'chat-a', timeoutMs: 8_000 })
    await waitFor(() => outboxRows(cwd).some((row) => row.state === 'deferred'), '第二条应被记为 deferred')
    await sleep(60)
    assert.equal(chatA.sent.length, 1, '同一会话的第二条必须在第一条落定之前排队')

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('排队中（behind：同一会话里更早的提问还没落定）：1 个'), status)

    // A DIFFERENT conversation never waits for chat A.
    const third = fake.runTool('interaction_ask', { question: 'B 的第一条', options: ['yes', 'no'], prefer: 'chat-b', timeoutMs: 8_000 })
    await waitFor(() => chatB.sent.length === 1, '另一个会话不用等')

    await answer(chatA, 0, { value: 'yes', by: 'u-1' })
    assert.equal((await first).isError, false)
    await waitFor(() => chatA.sent.length === 2, '第一条落定后第二条才发出')
    await answer(chatA, 1, { value: 'no', by: 'u-1' })
    const secondRun = await second
    assert.equal(secondRun.isError, false, runText(secondRun))
    assert.ok(runText(secondRun).includes('同会话排队'), runText(secondRun))

    await answer(chatB, 0, { value: 'yes', by: 'u-1' })
    assert.equal((await third).isError, false)
})

test('排队到截止时间：拒绝为 refused:deferred（不是失败），attempts 不变', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const fake = host(cwd)
    const chat = conversationChannel('im', 'A')
    fake.registry.register(chat.channel)

    const first = fake.runTool('interaction_ask', { question: '第一条', options: ['yes', 'no'], timeoutMs: 8_000 })
    await waitFor(() => chat.sent.length === 1, '第一条先发出去')

    // A short deadline: the queue never frees, and that is a DEFERRAL, not a
    // channel failure — the refusal must say so (and point at the real fix).
    const second = await fake.runTool('interaction_ask', { question: '第二条', options: ['yes', 'no'], timeoutMs: 150 })
    assert.equal(second.isError, true)
    const text = runText(second)
    assert.ok(text.includes('refused:deferred'), text)
    assert.ok(text.includes('同会话排队超时'), text)
    assert.ok(text.includes('排队等待不是失败，也不是同意'), text)
    assert.equal(chat.sent.length, 1, '排队期间一次卡片都不发')

    const deferred = outboxRows(cwd).filter((row) => row.state === 'deferred')
    assert.equal(deferred.length, 1, '一次排队一条 deferred 行')
    assert.equal(deferred[0].attempts, 0, '排队不是失败：attempts 不变')
    assert.equal(deferred[0].nextAttemptAt, undefined)

    // Leave nothing waiting: answer the first question.
    await answer(chat, 0, { value: 'yes', by: 'u-1' })
    assert.equal((await first).isError, false)
})

test('退避按 5s 倍增到 300s；纯粹的推后（deferral）不增加 attempts', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, 'outbox.jsonl')
    const clock = fakeClock()
    const outbox = createOutbox({ file, now: clock.now, sleep: async (ms) => clock.advance(ms) })

    const begun = outbox.begin({ questionId: 'q-backoff', channel: 'im', chatId: 'c1' })
    outbox.attach(begun.record.id, async () => ({ ok: false, error: 'webhook 503' }), { deadlineAt: clock.now() + 3_600_000 })
    const waits: number[] = []
    for (let index = 0; index < 8; index += 1) {
        clock.advance(BACKOFF_MAX_MS)
        const delivered = await outbox.deliver(begun.record.id)
        assert.equal(delivered.ok, false)
        const record = delivered.record!
        waits.push(record.nextAttemptAt! - record.at)
    }
    assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000], '5s 起倍增，封顶 300s')

    // …and a record that already failed 3 times stops blocking its conversation
    // (otherwise one poisoned question would block that chat for ever).
    clock.advance(1)
    const afterTripped = outbox.begin({ questionId: 'q-after-tripped', channel: 'im', chatId: 'c1' })
    assert.equal(blockingRecordFor(afterTripped.record, outbox.records()), undefined, '失败 3 次的记录不再挡住同会话的后来者')

    // A deferral is NOT a failure: it is its own state and it never touches attempts.
    clock.advance(1)
    const other = outbox.begin({ questionId: 'q-defer', channel: 'im', chatId: 'c2' })
    outbox.defer(other.record.id, '同会话里更早的提问还没落定')
    const deferred = outbox.get(other.record.id)!
    assert.equal(deferred.state, 'deferred')
    assert.equal(deferred.attempts, 0, '推后不是失败，attempts 必须不变')
    assert.equal(deferred.settleReason, '同会话里更早的提问还没落定')
    assert.equal(deferred.nextAttemptAt, undefined, '推后不设置退避时间')

    // A channel that DEFERS (not connected / no free slot) is the same: its own
    // state, no attempts change — "temporarily unavailable" is not a failure.
    clock.advance(1)
    const channelDeferred = outbox.begin({ questionId: 'q-channel-defer', channel: 'im', chatId: 'c4' })
    outbox.attach(channelDeferred.record.id, async () => ({ ok: false, error: 'IM 通道不可用：没有 active chat', deferred: true }), {
        deadlineAt: clock.now() + 60_000,
    })
    const deferredDelivery = await outbox.deliver(channelDeferred.record.id)
    assert.equal(deferredDelivery.ok, false)
    assert.equal(deferredDelivery.record?.state, 'deferred')
    assert.equal(deferredDelivery.record?.attempts, 0, '通道暂时不可用不是失败')
    assert.equal(deferredDelivery.record?.settleReason, 'IM 通道不可用：没有 active chat')

    // The ordering gate records exactly ONE deferral per wait and keeps attempts.
    clock.advance(1)
    const blocker = outbox.begin({ questionId: 'q-block', channel: 'im', chatId: 'c3' })
    clock.advance(1)
    const waiter = outbox.begin({ questionId: 'q-wait', channel: 'im', chatId: 'c3' })
    assert.equal(blockingRecordFor(waiter.record, outbox.records())?.id, blocker.record.id, '同会话里更早的记录挡住后来者')

    const slot = await outbox.awaitSlot(waiter.record.id, clock.now() + 500)
    assert.equal(slot.ok, false)
    assert.equal(slot.timedOut, true)
    assert.equal(slot.deferrals, 1)
    const waited = outbox.get(waiter.record.id)!
    assert.equal(waited.state, 'deferred')
    assert.equal(waited.attempts, 0, '排队等待不是失败')
    assert.equal(outboxRows(cwd, 'outbox.jsonl').filter((row) => row.questionId === 'q-wait' && row.state === 'deferred').length, 1, '一次排队只记一行')

    outbox.settle(blocker.record.id, 'answered', '人回答了')
    const free = await outbox.awaitSlot(waiter.record.id, clock.now() + 500)
    assert.equal(free.ok, true, '前一条落定后不再排队')
    assert.equal(free.deferrals, 0)
})

test('通道暂时不可用 → deferred（不是失败），拒绝理由是 refused:deferred', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const fake = host(cwd)
    fake.registry.register({
        name: 'im',
        chatId: 'A',
        async send() {
            return { ok: false, error: 'IM 通道不可用：渠道 "feishu" 没有 active chat', defer: true }
        },
        async wait() {
            return await new Promise(() => undefined)
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    })

    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:deferred'), text)
    assert.ok(text.includes('deferral，不是失败'), text)
    assert.ok(text.includes('这不是失败'), text)
    assert.ok(text.includes('attempts 没有增加'), text)
    assert.ok(text.includes('没有 active chat'), text)

    const rows = outboxRows(cwd)
    assert.deepEqual(
        rows.map((row) => row.state),
        ['intent', 'deferred'],
    )
    assert.equal(rows[1].attempts, 0, '暂时不可用不是失败：attempts 不变')
    assert.equal(rows[1].nextAttemptAt, undefined, '没有退避，下一次机会可以再试')

    // The ledger records a refusal, never a decision.
    assert.equal(readLedger(path.join(cwd, LEDGER)).rows.at(-1).decision, refusalOf('deferred'))
})

test('永久失败 → dropped 带原因，后续任何重放都不再重试它', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, 'outbox.jsonl')
    const clock = fakeClock()
    const outbox = createOutbox({ file, now: clock.now })
    const begun = outbox.begin({ questionId: 'q-perm', channel: 'im', chatId: 'c1' })
    outbox.attach(begun.record.id, async () => ({ ok: false, error: '通道 "im" 未注册', permanent: true }), {
        deadlineAt: clock.now() + 60_000,
    })
    const delivered = await outbox.deliver(begun.record.id)
    assert.equal(delivered.ok, false)
    assert.equal(delivered.record?.state, 'dropped')
    assert.equal(delivered.record?.settleReason, '通道 "im" 未注册')
    assert.equal(delivered.record?.attempts, 0, 'dropped 不计入重试次数')
    assert.equal(typeof delivered.record?.at, 'number')

    const rowsBefore = readOutbox(file).rows.length
    clock.advance(BACKOFF_MAX_MS * 2)
    const replay = await outbox.replay('manual')
    assert.equal(replay.considered, 0, 'dropped 不再进入重放')
    assert.equal(readOutbox(file).rows.length, rowsBefore, '没有新增行')

    // End to end: a channel that says "permanent" produces a dropped row and the
    // ask refuses exactly like today.
    const toolCwd = tempWorkspace('interaction-outbox-')
    const fake = host(toolCwd)
    fake.registry.register({
        name: 'im',
        chatId: 'A',
        async send() {
            return { ok: false, error: '本通道只转发 kind=ask 的提问', permanent: true }
        },
        async wait() {
            return await new Promise(() => undefined)
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    })
    const refused = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    assert.equal(refused.isError, true)
    assert.ok(runText(refused).includes('refused:send-failed'), runText(refused))
    const toolRows = outboxRows(toolCwd)
    assert.deepEqual(
        toolRows.map((row) => row.state),
        ['intent', 'dropped'],
    )
    assert.ok((toolRows[1].settleReason ?? '').includes('本通道只转发'), toolRows[1].settleReason)
    const droppedAt = toolRows[1].at

    // A later ask replays first; a dropped row is never re-enqueued.
    const question = toolRows[0].questionId
    const second = await fake.runTool('interaction_ask', { question: '再问一次', options: ['yes'] })
    assert.equal(second.isError, true)
    const firstQuestionRows = outboxRows(toolCwd).filter((row) => row.questionId === question)
    assert.deepEqual(
        firstQuestionRows.map((row) => row.state),
        ['intent', 'dropped'],
        '重放没有把已丢弃的提问重新排上',
    )
    assert.equal(firstQuestionRows[1].at, droppedAt, 'dropped 行没有被改写')
})

test('重放不会在台账里造第二道提问：已有收据就复用，卡片一次都不再发', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const ledgerFile = path.join(cwd, LEDGER)
    // A row a previous delivery already wrote: that IS the receipt of the send.
    appendLedgerRow(ledgerFile, {
        at: 1_000,
        id: 'il-existing',
        kind: 'ask',
        title: '需要决定：放行吗？',
        questionId: 'q-guard',
        channel: 'im',
        messageId: 'm-old',
    })
    const registry = {
        sends: 0,
        async send(_name: string, _message: unknown) {
            registry.sends += 1
            return { ok: true, messageId: `m-${registry.sends}` }
        },
    }
    const record = (questionId: string): any => ({
        id: outboxIdOf({ questionId, channel: 'im' }),
        questionId,
        channel: 'im',
        kind: 'ask',
        createdAt: 1_000,
        state: 'intent',
        attempts: 0,
        at: 1_000,
    })

    const deliver = createAskDeliverer({
        registry,
        ledgerFile,
        message: { kind: 'ask', title: '需要决定：放行吗？', body: 'b', questionId: 'q-guard' },
        questionId: 'q-guard',
        now: () => 2_000,
    })
    const reused = await deliver(record('q-guard'))
    assert.equal(registry.sends, 0, '台账已有收据：重放不再发卡片')
    assert.equal(reused.ok, true)
    assert.equal(reused.ledgerReused, true)
    assert.equal(reused.ledgerRowId, 'il-existing')
    assert.equal(reused.messageId, 'm-old')
    assert.equal(readLedger(ledgerFile).rows.length, 1, '台账里仍然只有一道提问')

    // Without a receipt: one send, one row — and calling it again reuses that row.
    const fresh = createAskDeliverer({
        registry,
        ledgerFile,
        message: { kind: 'ask', title: '新问题', body: 'b', questionId: 'q-new' },
        questionId: 'q-new',
        now: () => 2_000,
    })
    const first = await fresh(record('q-new'))
    assert.equal(first.ok, true)
    assert.equal(first.ledgerReused, undefined)
    assert.equal(registry.sends, 1)
    const again = await fresh(record('q-new'))
    assert.equal(again.ledgerReused, true)
    assert.equal(registry.sends, 1, '第二次调用不再发卡片')
    const rows = readLedger(ledgerFile).rows
    assert.equal(rows.length, 2)
    assert.equal(rows[1].questionId, 'q-new')
    assert.equal(rows[1].channel, 'im')
})

test('截断的尾行被忽略并计数，其余记录照常重放', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, 'outbox.jsonl')
    const clock = fakeClock()
    const seed = createOutbox({ file, now: clock.now })
    const begun = seed.begin({ questionId: 'q-torn', channel: 'im', chatId: 'c1' })
    // A crash mid-write: the file ends with half a row and NO newline.
    fs.appendFileSync(file, '{"id":"ob-torn","questionId":"q-torn","chan')

    const read = readOutbox(file)
    assert.equal(read.rows.length, 1, '可用的行照常读出')
    assert.equal(read.skipped, 1, '截断的尾行被跳过并计数')
    assert.ok(read.problems.some((problem) => problem.includes('截断')), JSON.stringify(read.problems))

    const outbox = createOutbox({ file, now: clock.now })
    const replay = await outbox.replay('apply')
    assert.equal(replay.dropped, 1, '没有载荷的重放以 dropped 结案（不再提问）')

    const after = readOutbox(file)
    assert.equal(after.skipped, 1)
    assert.deepEqual(
        after.rows.map((row) => row.state),
        ['intent', 'dropped'],
        '新追加的行没有被截断的尾行吞掉',
    )
    assert.equal(after.rows[0].id, begun.record.id)
    assert.equal(outbox.summary().skipped, 1, 'status 会报告跳过的行数')
    assert.equal(outbox.summary().byState.dropped, 1)
})

test('令牌过期/被消费后重放：以 dropped 结案，不重新提问，也不授予任何东西', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const fake = host(cwd)
    let sends = 0
    fake.registry.register({
        name: 'im',
        chatId: 'A',
        async send() {
            sends += 1
            return { ok: false, error: 'webhook 503' }
        },
        async wait() {
            return await new Promise(() => undefined)
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    })

    const first = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    assert.equal(first.isError, true)
    assert.ok(runText(first).includes('refused:send-failed'), runText(first))
    const token = outboxRows(cwd)[0].questionId
    assert.equal(outboxRows(cwd).at(-1).state, 'send-failed')
    assert.equal(sends, 1)

    // The next opportunity (another ask) replays first: the token is gone, so
    // the question can never be answered — it must not be asked again.
    const second = await fake.runTool('interaction_ask', { question: '另一个问题', options: ['yes'] })
    assert.equal(second.isError, true)
    assert.ok(runText(second).includes('refused:send-failed'), runText(second))
    assert.equal(sends, 2, '重放没有再为第一道提问发一次卡片（第二次发送是第二个提问自己的）')

    const firstQuestionRows = outboxRows(cwd).filter((row) => row.questionId === token)
    assert.deepEqual(
        firstQuestionRows.map((row) => row.state),
        ['intent', 'send-failed', 'dropped'],
    )
    const dropped = firstQuestionRows.at(-1)
    assert.ok((dropped.settleReason ?? '').includes('不再提问'), dropped.settleReason)
    assert.ok(dropped.at >= dropped.createdAt)

    // The gate-visible truth is untouched: the ledger has two refusals and NO decision.
    const ledger = readLedger(path.join(cwd, LEDGER)).rows
    assert.deepEqual(
        ledger.map((row) => row.decision),
        [refusalOf('send-failed'), refusalOf('send-failed')],
    )
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('已决定的提问：0'), status)
    assert.ok(status.includes('已丢弃（dropped，永久失败，不会再重试，也**不是**已发出的提问）：1 个'), status)
})

test('interaction_status 报 outbox 计数与最老年龄；连续失败 3 次的记录出现在 problems()', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, OUTBOX)
    const clock = fakeClock(Date.now())
    const seed = createOutbox({ file, now: clock.now })
    const begun = seed.begin({ questionId: 'q-tripped', channel: 'im', chatId: 'A' })
    seed.attach(begun.record.id, async () => ({ ok: false, error: 'webhook 503' }), { deadlineAt: clock.now() + 3_600_000 })
    for (let index = 0; index < ORDER_FAILURE_LIMIT; index += 1) {
        clock.advance(BACKOFF_MAX_MS)
        await seed.deliver(begun.record.id)
    }
    const tripped = seed.get(begun.record.id)!
    assert.equal(tripped.state, 'send-failed')
    assert.equal(tripped.attempts, ORDER_FAILURE_LIMIT)
    assert.ok(
        seed.problems().some((line) => line.includes(tripped.id) && line.includes('系统问题')),
        'outbox 自己的缺陷列表要指出这一行',
    )

    const fake = host(cwd)
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('提问 outbox（意图先落盘、再发卡片）'), status)
    assert.ok(status.includes('send-failed=1'), status)
    assert.ok(status.includes('排队中（behind：同一会话里更早的提问还没落定）：0 个'), status)
    assert.match(status, /最老未落定：\d+s（ob-[0-9a-f]+，im\/A，state=send-failed）/)
    assert.ok(status.includes(`连续失败≥${ORDER_FAILURE_LIMIT} 次（系统问题，见上方通道缺陷）：1 个`), status)
    assert.ok(status.includes(tripped.id), status)

    const defects = fake.registry.problems()
    const named = defects.filter((line: string) => line.includes(tripped.id))
    assert.equal(named.length, 1, `problems() 必须指出这一行，且只报一次：${JSON.stringify(defects)}`)
    assert.ok(named[0].includes('连续失败 3 次'), named[0])

    // A second read is not a second defect.
    runText(await fake.runTool('interaction_status', {}))
    assert.equal(fake.registry.problems().filter((line: string) => line.includes(tripped.id)).length, 1)
})

test('对同一文件重放两次是幂等的：不会为同一次状态变化重复落行', async () => {
    const cwd = tempWorkspace('interaction-outbox-')
    const file = path.join(cwd, 'outbox.jsonl')
    const clock = fakeClock()
    const seed = createOutbox({ file, now: clock.now })
    const begun = seed.begin({ questionId: 'q-idem', channel: 'im', chatId: 'c1' })

    const first = createOutbox({ file, now: clock.now })
    const second = createOutbox({ file, now: clock.now })
    const report1 = await first.replay('apply')
    const rowsAfterFirst = readOutbox(file).rows.length
    const report2 = await second.replay('apply')

    assert.equal(report1.dropped, 1)
    assert.equal(report2.considered, 0, '第二次重放没有可动的记录')
    assert.equal(report2.dropped, 0)
    assert.equal(readOutbox(file).rows.length, rowsAfterFirst, '同一次状态变化只有一行')
    assert.deepEqual(
        readOutbox(file).rows.map((row) => row.state),
        ['intent', 'dropped'],
    )
    assert.equal(readOutbox(file).rows[1].id, begun.record.id)

    // Settling an already settled record (and re-deriving it) adds nothing.
    seed.settle(begun.record.id, 'dropped', '重复结案不该再落一行')
    assert.equal(readOutbox(file).rows.length, rowsAfterFirst)
})

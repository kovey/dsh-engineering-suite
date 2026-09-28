/**
 * dsh-interaction-gate — the acceptance suite.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 * Everything is driven through the REAL tool surface (`apply` + `runTool`) and
 * through the service the plugin provides (`ctx.get('interaction')`), so a test
 * that passes here is a claim about what a channel plugin and the model see.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { createInteractionRegistry } from '../dist/channels.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import { appendLedgerRow, newRowId, readLedger, refusalOf, summarizeLedger } from '../dist/ledger.js'
import { PROMPT_SECTION } from '../dist/prompt.js'
import { PROGRESS_DEDUPE_WINDOW_MS } from '../dist/tools.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const hosts: FakeHost[] = []

/** Assemble the plugin in a throwaway workspace. */
function host(
    cwd: string,
    config: Record<string, unknown> = {},
    services: Record<string, unknown> | undefined = undefined,
): FakeHost & { registry: any } {
    const fake = createFakeHost({ cwd, ...(services === undefined ? {} : { services: { ...services } }) })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'interaction-gate.log'), ...config })
    const registry = (fake.ctx as { get: (service: string) => unknown }).get('interaction')
    return Object.assign(fake, { registry })
}

/**
 * A scripted channel. `waitMode: 'never'` never answers, `'null'` gives up like
 * a channel whose own deadline expired, the default lets the test answer.
 */
function scriptedChannel(
    channelName: string,
    options: {
        withWait?: boolean
        sendThrows?: boolean
        sendError?: string
        canAsk?: boolean
        canNotify?: boolean
        waitMode?: 'never' | 'null'
        onWait?: (questionId: string, resolve: (value: unknown) => void, attempt: number) => void
    } = {},
) {
    const sent: any[] = []
    const state: { waiter?: (value: unknown) => void; attempts: number; tokens: string[] } = { attempts: 0, tokens: [] }
    const channel: any = {
        name: channelName,
        async send(message: any) {
            if (options.sendThrows === true) throw new Error(`${channelName} 的 webhook 挂了`)
            sent.push(message)
            if (options.sendError !== undefined) return { ok: false, error: options.sendError }
            return { ok: true, messageId: `m-${channelName}-${sent.length}` }
        },
        describe: () => ({ canAsk: options.canAsk !== false, canNotify: options.canNotify !== false }),
    }
    if (options.withWait !== false) {
        channel.wait = async (questionId: string): Promise<unknown> => {
            state.attempts += 1
            const attempt = state.attempts
            state.tokens.push(questionId)
            if (options.waitMode === 'null') return null
            return await new Promise((resolve) => {
                state.waiter = resolve
                // 'never' = the channel waits forever on its own; the test may
                // still answer by hand (or let the ask's deadline fire).
                if (options.waitMode === 'never') return
                if (options.onWait !== undefined) options.onWait(questionId, resolve, attempt)
            })
        }
    }
    return { name: channelName, sent, state, channel }
}

/** Answer once the channel has reached its wait. */
async function answerWith(scripted: ReturnType<typeof scriptedChannel>, value: unknown): Promise<void> {
    for (let index = 0; index < 500 && scripted.state.waiter === undefined; index += 1) await sleep(1)
    assert.ok(scripted.state.waiter !== undefined, `${scripted.name} 没有进入等待状态`)
    scripted.state.waiter(value)
}

function rowsOf(cwd: string, file = LEDGER): any[] {
    return readLedger(path.join(cwd, file)).rows
}

function writeApprovers(cwd: string, lines: string[]): string {
    const file = path.join(cwd, '.dsh', 'interaction-approvers.txt')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
    return file
}

test('插件声明、服务名与四个工具都在装配后可见', () => {
    assert.equal(name, 'dsh-interaction-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])

    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    assert.deepEqual([...fake.tools.keys()].sort(), [
        'interaction_ask',
        'interaction_notify',
        'interaction_progress',
        'interaction_status',
    ])
    assert.equal(typeof fake.registry.register, 'function')
    assert.equal(typeof fake.registry.unregister, 'function')
    assert.equal(typeof fake.registry.list, 'function')
    assert.equal(typeof fake.registry.describeAll, 'function')
    assert.equal(typeof fake.registry.pending, 'function')
    assert.deepEqual(fake.registry.describeAll(), [])
    assert.deepEqual(fake.registry.pending(), [])

    const prompt = fake.sectionText(PROMPT_SECTION)
    for (const tool of ['interaction_ask', 'interaction_notify', 'interaction_progress', 'interaction_status']) {
        assert.ok(prompt.includes(tool), `提示词段缺少 ${tool}`)
    }
    assert.ok(prompt.includes('生效配置来源：profile'), '提示词段应写明配置来源')
    assert.ok(prompt.includes('没有注册任何通道'), '没有任何通道时提示词段必须说出来')
})

test('注册/注销：重复名被拒绝（不抛错）、描述能力、抛错的通道不影响别的通道', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const bad = scriptedChannel('bad', { sendThrows: true })
    const good = scriptedChannel('good')
    const disposeBad = fake.registry.register(bad.channel)
    const disposeGood = fake.registry.register(good.channel)

    // Duplicate registration: rejected with a recorded problem, never a throw.
    const duplicate = fake.registry.register(scriptedChannel('good').channel)
    assert.equal(typeof duplicate, 'function')
    assert.equal(fake.registry.list().length, 2)
    assert.ok(
        fake.registry.problems().some((problem: string) => problem.includes('拒绝重复注册通道 "good"')),
        '重复注册必须留下原因',
    )

    const info = fake.registry.list()
    assert.deepEqual(
        info.map((entry: any) => [entry.name, entry.order]),
        [
            ['bad', 0],
            ['good', 1],
        ],
    )

    // The throwing channel reports a failure; the other one still receives it.
    const run = await fake.runTool('interaction_notify', { level: 'warn', title: '门禁 BLOCK', body: 'quality gate 失败' })
    const text = runText(run)
    assert.ok(text.includes('已推送 1/2 个通道'), text)
    assert.ok(text.includes('bad：推送失败（通道 "bad" 的 send() 抛错：bad 的 webhook 挂了'), text)
    assert.equal(good.sent.length, 1)
    assert.ok(fake.registry.problems().some((problem: string) => problem.includes('send() 抛错')))

    // Unregistration, both ways, is idempotent.
    disposeBad()
    assert.equal(fake.registry.list().length, 1)
    disposeBad()
    assert.equal(fake.registry.list().length, 1)
    assert.equal(fake.registry.unregister('good'), true)
    assert.equal(fake.registry.unregister('good'), false)
    assert.deepEqual(fake.registry.list(), [])
    disposeGood()
})

test('describe()：没有 wait() 的通道 canAsk=false 且说明原因，提问被拒绝（refused:no-channel）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const pushOnly = scriptedChannel('webhook', { withWait: false, canNotify: true })
    fake.registry.register(pushOnly.channel)

    const info = fake.registry.list()[0]
    assert.equal(info.canAsk, false)
    assert.equal(info.canNotify, true)
    assert.ok(info.reason.includes('wait'), `原因里应说明缺 wait()：${info.reason}`)

    const run = await fake.runTool('interaction_ask', { question: '要部署吗？', options: ['yes', 'no'] })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('interaction_ask 拒绝（refused:no-channel）'), text)
    assert.ok(text.includes('canAsk=false'), text)
    assert.equal(pushOnly.sent.length, 0, '不能收答案时不该发出卡片')

    const rows = rowsOf(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].decision, refusalOf('no-channel'))
    assert.ok(text.trimEnd().split('\n').at(-1)!.startsWith('下一步：'))
})

test('interaction_ask：脚本通道回答 → 决定 + 回答者 + 通道 + 台账行（pending 行 + 决定行）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)

    const running = fake.runTool('interaction_ask', { question: '把这个交付放出去？', options: ['allowed-once', 'rejected'], context: { kind: 'delivery', missionId: 'm-1', facts: { 风险: 'medium' } } })
    await answerWith(im, { value: 'allowed-once', by: 'user-7', messageId: 'card-9' })
    const run = await running
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.ok(text.startsWith('interaction_ask：已决定'), text)
    assert.ok(text.includes('决定：allowed-once（声明选项之一）'), text)
    assert.ok(text.includes('回答者：user-7'), text)
    assert.ok(text.includes('通道：im（消息 card-9）'), text)
    assert.ok(text.includes('门禁语义'), '套件词汇的决定必须说明门禁语义')
    assert.ok(text.includes('一次性令牌：q-'), text)
    assert.ok(text.trimEnd().split('\n').at(-1)!.startsWith('下一步：'))

    // The card carried the token, the declared options and the approval-context block.
    const card = im.sent[0]
    assert.equal(card.kind, 'ask')
    assert.ok(card.questionId.startsWith('q-'))
    assert.deepEqual(card.buttons, [
        { value: 'allowed-once', label: 'allowed-once' },
        { value: 'rejected', label: 'rejected' },
    ])
    assert.ok(card.body.includes('```approval-context'), card.body)
    assert.ok(card.body.includes('"kind": "delivery"'), card.body)

    const rows = rowsOf(cwd)
    assert.equal(rows.length, 2)
    const pending = rows[0]
    assert.equal(pending.kind, 'ask')
    assert.equal(pending.decision, undefined)
    assert.equal(pending.questionId, card.questionId)
    assert.equal(pending.channel, 'im')
    const decided = rows[1]
    assert.equal(decided.decision, 'allowed-once')
    assert.equal(decided.userId, 'user-7')
    assert.equal(decided.questionId, card.questionId)
    assert.equal(typeof decided.durationMs, 'number')
    assert.ok(text.includes(decided.id), '报告里要给出台账行 id')
})

test('interaction_ask：超时 → 拒绝并在报文里给出截止时间（deadline）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const silent = scriptedChannel('im', { waitMode: 'never' })
    fake.registry.register(silent.channel)

    const run = await fake.runTool('interaction_ask', { question: '还在吗？', options: ['yes', 'no'], timeoutMs: 40 })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:timeout'), text)
    assert.ok(text.includes('等待超时'), text)
    assert.ok(text.includes('40ms'), `报文必须写明截止毫秒数：${text}`)
    assert.ok(text.includes('截止 20'), `报文必须写明截止时刻：${text}`)
    assert.ok(text.includes('超时**不是**拒绝，也**不是**同意'), text)

    const rows = rowsOf(cwd)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].decision, undefined, '发卡片时要留下 pending 行')
    assert.equal(rows[1].decision, refusalOf('timeout'))
    assert.ok(typeof rows[1].durationMs === 'number')
})

test('interaction_ask：错误的令牌被忽略，提问仍在等待；正确令牌才落定', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const silent = scriptedChannel('im', { waitMode: 'never' })
    fake.registry.register(silent.channel)

    let settled = false
    const running = fake.runTool('interaction_ask', { question: '选一个', options: ['a', 'b'], timeoutMs: 5_000 }).then((run) => {
        settled = true
        return run
    })
    // Wait until the pending row exists (the card is out, the ask is waiting).
    let token = ''
    for (let index = 0; index < 500 && token === ''; index += 1) {
        const rows = rowsOf(cwd)
        token = rows.find((row) => row.decision === undefined)?.questionId ?? ''
        if (token === '') await sleep(2)
    }
    assert.ok(token.startsWith('q-'), 'pending 行必须带一次性令牌')

    // A token nobody asked about: dropped, and the ask keeps waiting.
    assert.equal(fake.registry.submit('q-someone-else', { value: 'a' }), false)
    assert.equal(fake.registry.submit('', { value: 'a' }), false)
    await sleep(30)
    assert.equal(settled, false, '错误的令牌不能让提问落定')
    assert.ok(fake.registry.droppedAnswers() >= 2)

    // The right token settles it.
    assert.equal(fake.registry.submit(token, { value: 'b', by: 'user-3' }), true)
    const run = await running
    assert.equal(run.isError, false)
    assert.ok(runText(run).includes('决定：b'), runText(run))
    assert.equal(rowsOf(cwd).at(-1).decision, 'b')
})

test('interaction_ask：通道 wait() 回了一个别的令牌 → 丢弃后继续等待，正确的答案才算数', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const echo = scriptedChannel('echo', {
        onWait: (questionId: string, resolve: (value: unknown) => void, attempt: number) => {
            if (attempt === 1) resolve({ value: 'yes', questionId: 'q-not-mine' })
            else setTimeout(() => resolve({ value: 'no', by: 'user-9' }), 5)
        },
    })
    fake.registry.register(echo.channel)

    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'], timeoutMs: 2_000 })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.ok(text.includes('决定：no'), text)
    assert.ok(text.includes('回答者：user-9'), text)
    assert.equal(echo.state.attempts, 2, '丢弃后必须重新进入等待')
    assert.ok(fake.registry.droppedAnswers() >= 1)
    assert.ok(fake.registry.problems().some((problem: string) => problem.includes('q-not-mine')))
})

test('interaction_ask：requireApproverList=true 时未授权回答者 → 拒绝 + 台账行（含回答者）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    writeApprovers(cwd, ['# 项目审批人', 'alice'])
    const fake = host(cwd, { requireApproverList: true })
    const mallory = scriptedChannel('im')
    fake.registry.register(mallory.channel)

    const run = fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    await answerWith(mallory, { value: 'yes', by: 'mallory' })
    const outcome = await run
    assert.equal(outcome.isError, true)
    const text = runText(outcome)
    assert.ok(text.includes('refused:unauthorized'), text)
    assert.ok(text.includes('未获授权'), text)
    // The refusal points at the FILE and the count, not at the other approvers'
    // identities: the model needs to know why it failed, not who else may answer.
    assert.ok(text.includes('不在项目审批人名单里'), text)
    assert.ok(text.includes('interaction-approvers.txt'), text)
    const rows = rowsOf(cwd)
    assert.equal(rows.at(-1).decision, refusalOf('unauthorized'))
    assert.equal(rows.at(-1).userId, 'mallory', '未授权的回答者也要如实记录')
})

test('interaction_ask：名单里的人可以回答；名单缺失时在发卡片前就拒绝', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    writeApprovers(cwd, ['alice'])
    const fake = host(cwd, { requireApproverList: true })
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await answerWith(im, { value: 'allowed-once', by: 'ALICE' })
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.ok(runText(run).includes('项目审批人名单：1 个 id'), runText(run))

    // No list at all: refuse BEFORE sending a card nobody may answer.
    const bare = tempWorkspace('interaction-gate-')
    const bareHost = host(bare, { requireApproverList: true })
    const channel = scriptedChannel('im')
    bareHost.registry.register(channel.channel)
    const refused = await bareHost.runTool('interaction_ask', { question: '放行吗？', options: ['yes'] })
    assert.equal(refused.isError, true)
    assert.ok(runText(refused).includes('refused:approvers-missing'), runText(refused))
    assert.equal(channel.sent.length, 0, '名单不可用时不该发出卡片')
    assert.equal(rowsOf(bare).at(-1).decision, refusalOf('approvers-missing'))
})

test('interaction_ask：答案不是声明选项之一 → 拒绝（refused:unknown-answer）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    await answerWith(im, { value: 'maybe', by: 'user-1' })
    const run = await running
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:unknown-answer'), text)
    assert.ok(text.includes('不是声明选项之一'), text)
    assert.ok(text.includes('yes / no'), text)
    const rows = rowsOf(cwd)
    assert.equal(rows.at(-1).decision, refusalOf('unknown-answer'))
    assert.equal(rows.at(-1).userId, 'user-1')
})

test('interaction_notify：没有通道 → 报告推送失败（不是静默），并记一行 notify-failed', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const run = await fake.runTool('interaction_notify', { level: 'warn', title: '门禁 BLOCK', body: 'quality gate 失败：3 个用例挂了' })
    assert.equal(run.isError, false, '通知失败不应该让工具调用失败')
    const text = runText(run)
    assert.ok(text.startsWith('interaction_notify：推送失败（没有可用通道）'), text)
    assert.ok(text.includes('通知失败**不等于**默认通过'), text)
    assert.ok(text.includes('台账'), text)
    assert.ok(text.trimEnd().split('\n').at(-1)!.startsWith('下一步：'))

    const rows = rowsOf(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'notify')
    assert.equal(rows[0].decision, 'notify-failed')
})

test('interaction_notify：等级被配置过滤是明确报告（不是静默），成功推送按通道记账', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd, { notifyLevels: ['error'] })
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)

    const filtered = await fake.runTool('interaction_notify', { level: 'warn', title: '注意', body: '只是提醒' })
    assert.ok(runText(filtered).includes('未推送（按配置过滤）'), runText(filtered))
    assert.equal(im.sent.length, 0)
    assert.equal(rowsOf(cwd).at(-1).decision, 'filtered')

    const pushed = await fake.runTool('interaction_notify', { level: 'error', title: '坏了', body: '构建失败' })
    assert.ok(runText(pushed).includes('已推送 1/1 个通道'), runText(pushed))
    assert.equal(im.sent.length, 1)
    assert.equal(im.sent[0].kind, 'notify')
    assert.equal(rowsOf(cwd).at(-1).decision, 'notified')
    assert.equal(rowsOf(cwd).at(-1).messageId, 'm-im-1')
})

test('interaction_progress：窗口内相同内容被抑制，内容变了才再推', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)

    const first = await fake.runTool('interaction_progress', { stage: 'tests', elapsedMs: 1_000, note: '跑单元测试' })
    assert.ok(runText(first).includes('已推送 1/1 个通道'), runText(first))
    assert.equal(im.sent.length, 1)

    const second = await fake.runTool('interaction_progress', { stage: 'tests', elapsedMs: 4_000, note: '跑单元测试' })
    const text = runText(second)
    assert.ok(text.includes('已抑制（与上一次完全相同的内容）'), text)
    assert.ok(text.includes(`${PROGRESS_DEDUPE_WINDOW_MS}ms`), text)
    assert.equal(im.sent.length, 1, '窗口内不得重复推送')
    assert.equal(rowsOf(cwd).length, 1, '被抑制的进度不写台账')

    const third = await fake.runTool('interaction_progress', { stage: 'tests', note: '跑集成测试' })
    assert.ok(runText(third).includes('已推送 1/1 个通道'), runText(third))
    assert.equal(im.sent.length, 2)
    assert.equal(rowsOf(cwd).at(-1).decision, 'progress')
})

test('台账：截断的尾行被容忍并计数；summarizeLedger 给出计数与未决定的提问', () => {
    const cwd = tempWorkspace('interaction-gate-')
    const file = path.join(cwd, 'ledger.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    appendLedgerRow(file, {
        at: 1_000,
        id: newRowId(),
        kind: 'ask',
        title: '要部署吗？',
        questionId: 'q-open',
        channel: 'im',
    })
    appendLedgerRow(file, {
        at: 2_000,
        id: newRowId(),
        kind: 'ask',
        title: '放行吗？',
        questionId: 'q-done',
        channel: 'im',
        decision: 'allowed-once',
        userId: 'alice',
        durationMs: 12,
    })
    appendLedgerRow(file, { at: 3_000, id: newRowId(), kind: 'notify', title: '门禁 BLOCK', decision: 'notify-failed' })
    // A crash mid-write: a truncated last line must not make the ledger unreadable.
    fs.appendFileSync(file, '{"at":4000,"id":"il-broken","kind":"ask","titl')
    fs.appendFileSync(file, '\n{"totally":"not a row"}\n')

    const read = readLedger(file)
    assert.equal(read.rows.length, 3)
    assert.equal(read.skipped, 2)
    assert.equal(read.present, true)
    assert.ok(read.problems.length >= 1)

    const missing = readLedger(path.join(cwd, 'nope.jsonl'))
    assert.equal(missing.present, false)
    assert.deepEqual(missing.rows, [])

    const summary = summarizeLedger(read.rows, 10_000, read.skipped)
    assert.deepEqual(summary.byKind, { ask: 2, notify: 1, progress: 0 })
    assert.equal(summary.answered, 1)
    assert.equal(summary.undecided, 1)
    assert.equal(summary.notifyFailed, 1)
    assert.equal(summary.pending.length, 1, '有决定行的令牌不再算未决定')
    assert.equal(summary.pending[0].questionId, 'q-open')
    assert.equal(summary.pending[0].ageMs, 9_000)
    assert.equal(summary.skipped, 2)
    assert.equal(summary.last!.title, '门禁 BLOCK')
})

test('出站载荷里的疑似凭据 → 拒绝发送（打码也不行），原文不回显', async () => {
    // Assembled at runtime on purpose: a realistic-looking literal is a secret
    // scanner's problem, and this fixture must never look like a real key.
    const fakeKey = ['sk', '-', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('')
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)

    const run = await fake.runTool('interaction_ask', {
        question: `用这把 key 部署吧：${fakeKey}`,
        options: ['yes', 'no'],
    })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:secret'), text)
    assert.ok(text.includes('provider-api-key'), text)
    assert.ok(text.includes('指纹'), text)
    assert.ok(!text.includes(fakeKey), '被拒绝的报文里不得回显原始凭据')
    assert.equal(im.sent.length, 0, '检测到凭据时不得发送')

    const rows = rowsOf(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].decision, refusalOf('secret'))

    // notify/progress report the refusal instead of throwing (they are best-effort pushes).
    const notified = await fake.runTool('interaction_notify', { level: 'warn', title: '注意', body: `token=${fakeKey}` })
    assert.equal(notified.isError, false)
    assert.ok(runText(notified).includes('拒绝发送（载荷疑似含凭据）'), runText(notified))
    assert.ok(!runText(notified).includes(fakeKey))
    assert.equal(im.sent.length, 0)
    assert.equal(rowsOf(cwd).at(-1).decision, refusalOf('secret'))
})

test('interaction_status：通道能力、生效配置、名单状态、台账计数与未决定的提问（含年龄）', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    writeApprovers(cwd, ['alice', 'bob'])
    const fake = host(cwd, { requireApproverList: true, preferredChannels: ['im', 'ghost'] })
    const im = scriptedChannel('im', { waitMode: 'never' })
    const pushOnly = scriptedChannel('webhook', { withWait: false })
    fake.registry.register(im.channel)
    fake.registry.register(pushOnly.channel)

    // One ask left in flight, so the status has something genuinely pending.
    const running = fake.runTool('interaction_ask', { question: '谁来决定？', options: ['yes', 'no'], timeoutMs: 5_000, missionId: 'm-42' })
    let text = ''
    for (let index = 0; index < 500 && !text.includes('未决定的提问（按年龄，共 1 个）'); index += 1) {
        const run = await fake.runTool('interaction_status', {})
        text = runText(run)
        if (!text.includes('共 1 个')) await sleep(2)
    }
    assert.ok(text.includes('配置来源：profile'), text)
    assert.ok(text.includes('canAsk=true，canNotify=true'), text)
    assert.ok(text.includes('canAsk=false'), text)
    assert.ok(text.includes('未实现 wait()'), text)
    assert.ok(text.includes('⚠️ 配置偏好但未注册的通道：ghost'), text)
    assert.ok(text.includes('审批人名单：**必须**；文件 '), text)
    assert.ok(text.includes('有效 id=2'), text)
    assert.ok(text.includes('未决定的提问（按年龄，共 1 个）'), text)
    assert.match(text, /- q-[0-9a-f]+：年龄 \d+s/)
    assert.ok(text.includes('mission m-42'), text)
    assert.ok(text.includes('记录发生过什么，**不授予任何权限**'), text)
    assert.ok(text.trimEnd().split('\n').at(-1)!.startsWith('下一步：'))

    // The service view the doctor uses sees the same pending ask.
    const pending = fake.registry.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, pending[0].questionId)
    assert.equal(pending[0].title.includes('需要决定'), true)
    assert.equal(typeof pending[0].at, 'number')

    // Answer it so the run settles (and the pending row is superseded).
    await answerWith(im, { value: 'yes', by: 'alice' })
    const settled = await running
    assert.equal(settled.isError, false, runText(settled))
    assert.deepEqual(fake.registry.pending(), [])
})

test('项目级配置：允许的键生效、非法值与宿主键被拒绝并记录；status/prompt 如实写明来源', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'interaction-gate.json'),
        `${JSON.stringify(
            {
                ledgerFile: '.dsh/interaction/custom.jsonl',
                preferredChannels: ['im'],
                notifyLevels: ['info', 'warn', 'error'],
                redactPatterns: ['INTERNAL-[0-9]{4}', '((('],
                // Host-owned / unusable values, all of which must be refused:
                requireApproverList: false,
                askTimeoutMs: 1,
                approversFile: 42,
            },
            null,
            2,
        )}\n`,
    )
    const hostConfig = resolveConfig({ requireApproverList: true, askTimeoutMs: 900_000 }, () => undefined)
    const effective = resolveEffectiveConfig(hostConfig, resolveLayout(cwd, {}), undefined)

    assert.equal(effective.source, 'project')
    assert.equal(effective.config.ledgerFile, '.dsh/interaction/custom.jsonl')
    assert.deepEqual(effective.config.preferredChannels, ['im'])
    assert.deepEqual(effective.config.notifyLevels, ['info', 'warn', 'error'])
    assert.deepEqual(effective.config.redactPatterns, ['INTERNAL-[0-9]{4}'], '非法正则必须被丢掉')
    assert.equal(effective.config.requireApproverList, true, '宿主键不得被项目关闭')
    assert.equal(effective.config.askTimeoutMs, 900_000, '宿主键不得被项目改写')
    assert.equal(effective.config.approversFile, '.dsh/interaction-approvers.txt', '类型不对的值回退 profile 值')

    const problems = effective.problems.join('\n')
    assert.ok(problems.includes('"requireApproverList" 不允许在项目级配置里覆盖'), problems)
    assert.ok(problems.includes('"askTimeoutMs" 不允许在项目级配置里覆盖'), problems)
    assert.ok(problems.includes('approversFile 必须是非空字符串'), problems)
    assert.ok(problems.includes('不是合法正则'), problems)

    // The plugin, in the same workspace, applies the overlay end to end.
    const fake = host(cwd, { requireApproverList: true })
    writeApprovers(cwd, ['alice'])
    const im = scriptedChannel('im')
    fake.registry.register(im.channel)
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['yes', 'no'] })
    await answerWith(im, { value: 'yes', by: 'alice' })
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.ok(rowsOf(cwd, '.dsh/interaction/custom.jsonl').length === 2, '项目级台账路径必须生效')

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes(`配置来源：项目级 ${path.join(cwd, '.dsh', 'interaction-gate.json')}`), status)
    assert.ok(status.includes('条配置问题'), status)
    assert.ok(status.includes(path.join(cwd, '.dsh', 'interaction', 'custom.jsonl')), status)

    // The section is rendered per assembly, so this is the real project view.
    const section = fake.sections.find((entry) => entry.name === PROMPT_SECTION)!
    const prompt = section.text!({ scope: fake.agent })
    assert.ok(prompt.includes('生效配置来源：项目级'), prompt)
    assert.ok(prompt.includes('条配置问题'), prompt)
})

test('交互层不猜工作区：没有 session.header.cwd 时四个工具都拒绝', async () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = createFakeHost({ cwd, agent: { id: 'agent-x', session: { id: 'session-x', header: { id: 'session-x' } } } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'interaction-gate.log') })
    for (const [tool, args] of [
        ['interaction_ask', { question: '放行吗？', options: ['yes'] }],
        ['interaction_notify', { level: 'warn', title: 't', body: 'b' }],
        ['interaction_progress', { stage: 'tests' }],
        ['interaction_status', {}],
    ] as const) {
        const run = await fake.runTool(tool, args)
        assert.equal(run.isError, true, `${tool} 必须拒绝`)
        assert.ok(runText(run).includes('无法确定工作区'), runText(run))
    }
})

test('配置校验：不可用的数值回退默认值并报告；注册表对外永不抛错', () => {
    const problems: string[] = []
    const config = resolveConfig({ askTimeoutMs: 10, maxPayloadChars: 5, notifyLevels: [], preferredChannels: 'im' }, (message) => problems.push(message))
    assert.equal(config.askTimeoutMs, 900_000)
    assert.equal(config.maxPayloadChars, 4_000)
    assert.deepEqual(config.notifyLevels, ['warn', 'error'])
    assert.deepEqual(config.preferredChannels, [])
    assert.equal(problems.length, 4, problems.join(' | '))

    // A registry that receives garbage is total: no throw, and a recorded reason.
    const registry = createInteractionRegistry({ now: () => 1_000 })
    const dispose = registry.register({} as never)
    dispose()
    assert.equal(registry.list().length, 0)
    assert.ok(registry.problems().length >= 1)
    assert.equal(registry.arm(''), false)
    assert.equal(registry.submit('q-nope', { value: 'yes' }), false)
    assert.deepEqual(registry.pending(), [])
    assert.equal(registry.unregister('nope'), false)
})

test('dispose 之后无残留：工具、提示词段与服务都被撤下', () => {
    const cwd = tempWorkspace('interaction-gate-')
    const fake = host(cwd)
    assert.equal(fake.tools.size, 4)
    assert.equal(fake.sections.length, 1)
    fake.dispose()
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.sections.length, 0)
})

// --- adversarial-audit regressions ------------------------------------------

test('项目级 redactPatterns 与宿主取并集：加规则只会收紧，绝不清空宿主的规则', async () => {
    // Repro a1.mjs(C): a project list REPLACED the host's, and an all-invalid list
    // produced an effective `[]` while still counting as "applied".
    const cwd = tempWorkspace('interaction-gate-redact-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const hostConfig = resolveConfig({ redactPatterns: ['ACME-SECRET-[0-9]{4}'] }, () => undefined)

    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ redactPatterns: ['ACME-PROJECT-[0-9]{4}'] }))
    const union = resolveEffectiveConfig(hostConfig, resolveLayout(cwd, {}), undefined)
    assert.deepEqual(union.config.redactPatterns, ['ACME-SECRET-[0-9]{4}', 'ACME-PROJECT-[0-9]{4}'], 'host rules first, project rules appended (deduplicated)')

    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ redactPatterns: ['[', '(?<'] }))
    const allInvalid = resolveEffectiveConfig(hostConfig, resolveLayout(cwd, {}), undefined)
    assert.deepEqual(allInvalid.config.redactPatterns, ['ACME-SECRET-[0-9]{4}'], 'an all-invalid list must not empty the host rules')
    assert.equal(allInvalid.source, 'profile', 'a list that adds nothing must not claim the project file applied')
    assert.ok(allInvalid.problems.some((problem) => /不是合法正则/.test(problem)), JSON.stringify(allInvalid.problems))

    // End to end: with a project file present, the HOST rule still refuses a payload.
    const fake = host(cwd, { redactPatterns: ['ACME-SECRET-[0-9]{4}'] })
    fake.registry.register(scriptedChannel('im').channel)
    const refused = await fake.runTool('interaction_ask', { question: '密钥 ACME-SECRET-1234 可以发吗？' })
    assert.equal(refused.isError, true)
    assert.ok(runText(refused).includes('refused:secret'), runText(refused))
    assert.ok(runText(refused).includes('ACME-SECRET-[0-9]{4}'), runText(refused))
})

test('自由文本答案落账与回显都被 maxPayloadChars 限界，并说明已截断', async () => {
    // Repro a15.mjs: a 2 MB answer was stored verbatim and echoed by both
    // `interaction_ask` and `interaction_status`.
    const cwd = tempWorkspace('interaction-gate-biganswer-')
    const fake = host(cwd, { maxPayloadChars: 500 })
    const huge = 'y'.repeat(2_000_000)
    const im = scriptedChannel('im', { onWait: (_questionId, resolve) => resolve({ value: huge, by: 'user-9' }) })
    fake.registry.register(im.channel)

    const run = await fake.runTool('interaction_ask', { question: '随便说点什么' })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.ok(text.length < 5_000, `the answer must be bounded, got ${text.length} chars`)
    assert.ok(text.includes('已截断'), text.slice(-600))
    assert.ok(text.includes('原文 2000000 字符'), text.slice(-600))

    const ledgerBytes = fs.statSync(path.join(cwd, LEDGER)).size
    assert.ok(ledgerBytes < 5_000, `the ledger row must be bounded, got ${ledgerBytes} bytes`)
    const decided = rowsOf(cwd).at(-1)
    assert.equal(decided.decision.length, 500, 'stored bounded to exactly maxPayloadChars')

    const status = await fake.runTool('interaction_status', {})
    const statusText = runText(status)
    assert.ok(statusText.length < 10_000, `interaction_status must stay bounded, got ${statusText.length} chars`)

    // A row an OLDER version wrote (unbounded) is also rendered bounded.
    appendLedgerRow(path.join(cwd, LEDGER), {
        at: Date.now(),
        id: newRowId(),
        kind: 'ask',
        title: '旧版本的超长回答',
        decision: 'z'.repeat(2_000_000),
    })
    const again = await fake.runTool('interaction_status', {})
    assert.ok(runText(again).length < 10_000, 'rendering must bound what is already on disk')
})

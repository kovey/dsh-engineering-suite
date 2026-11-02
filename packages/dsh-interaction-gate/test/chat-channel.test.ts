/**
 * dsh-interaction-gate — the OPTIONAL IM channel (`chat-interaction` api v1).
 *
 * The acceptance suite for `src/chat-channel.ts` + the `im` config key. Every
 * test drives the REAL tool surface (`apply` + `runTool`) or the REAL registry
 * (`ctx.get('interaction')`), with a fake `chatInteraction` service that
 * records what the adapter asked it to do — so a passing test is a claim about
 * what the IM plugin and the gate actually see, not about an internal branch.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { imRequiredHint } from '../dist/chat-channel.js'
import { refusalOf } from '../dist/ledger.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const LOG = 'interaction-gate.log'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until a predicate holds (the tools run on real timers). */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 1_000; index += 1) {
        if (predicate()) return
        await sleep(1)
    }
    assert.ok(predicate(), message)
}

/** A fake `chatInteraction` layer whose `api.ask` waits for the test's answer. */
interface FakeChat {
    layer: { api: Record<string, unknown> }
    api: Record<string, unknown>
    asks: Record<string, any>[]
    pending: ((value: unknown) => void)[]
}

function makeChat(overrides: Record<string, unknown> = {}): FakeChat {
    const asks: Record<string, any>[] = []
    const pending: ((value: unknown) => void)[] = []
    const api: Record<string, unknown> = {
        apiVersion: 1,
        info: () => ({ apiVersion: 1, pluginVersion: '0.3.0', channels: [] }),
        channels: () => [
            { name: 'feishu', label: '飞书', connected: true, capabilities: { cards: true, richText: true, images: false, inbound: true } },
        ],
        capabilities: (name: string) =>
            name === 'feishu'
                ? { ok: true, value: { cards: true, richText: true, images: false, inbound: true } }
                : { ok: false, code: 'channel-not-found', message: `unknown channel "${name}"` },
        authState: () => ({
            ok: true,
            mode: 'auto',
            allowlist: [],
            activeChat: 'oc_demo',
            p2pChat: '',
            listenerRole: '',
            listenerConnected: true,
            pendingQuestions: [],
        }),
        ask: (request: Record<string, any>): unknown => {
            asks.push(request)
            return new Promise((resolve) => pending.push(resolve as (value: unknown) => void))
        },
    }
    Object.assign(api, overrides)
    return { layer: { api }, api, asks, pending }
}

/** Deliver one answer to the last `api.ask` the adapter started. */
function answer(chat: FakeChat, value: string, extra: Record<string, unknown> = {}): void {
    const resolve = chat.pending.shift()
    assert.ok(resolve !== undefined, 'IM 的 ask() 没有在等待回答')
    resolve({ ok: true, value: { value, text: value, messageId: 'om_card_1', by: 'ou_alice', via: 'click', at: Date.now(), ...extra } })
}

/** Assemble the plugin; count the service lookups the plugin performs. */
interface Assembly {
    fake: FakeHost
    registry: any
    getCalls: { chat: number }
}

function assemble(cwd: string, config: Record<string, unknown> = {}, services?: Record<string, unknown>): Assembly {
    const fake = createFakeHost({ cwd, ...(services === undefined ? {} : { services: { ...services } }) })
    const getCalls = { chat: 0 }
    const original = (fake.ctx as { get: (name: string) => unknown }).get.bind(fake.ctx)
    ;(fake.ctx as { get: (name: string) => unknown }).get = (service: string) => {
        if (service === 'chatInteraction') getCalls.chat += 1
        return original(service)
    }
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG), ...config })
    const registry = (fake.ctx as { get: (name: string) => unknown }).get('interaction')
    return { fake, registry, getCalls }
}

/** A local (non-IM) scripted channel, the shape the existing suite tests use. */
function localChannel(name = 'terminal') {
    const sent: Record<string, any>[] = []
    const state: { waiter?: (value: unknown) => void } = {}
    const channel = {
        name,
        async send(message: Record<string, any>) {
            sent.push(message)
            return { ok: true, messageId: `m-${sent.length}` }
        },
        async wait(): Promise<unknown> {
            return await new Promise((resolve) => {
                state.waiter = resolve
            })
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    }
    return {
        channel,
        sent,
        state,
        async answer(value: unknown): Promise<void> {
            await waitFor(() => state.waiter !== undefined, `${name} 没有进入等待状态`)
            ;(state.waiter as (value: unknown) => void)(value)
        },
    }
}

function rowsOf(cwd: string): Record<string, any>[] {
    const file = path.join(cwd, LEDGER)
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, any>)
}

test('IM 通道：chatInteraction(api v1) 存在 → 注册 chat-interaction，提问以卡片选项发出，答案回填本套件的令牌', async () => {
    const cwd = tempWorkspace('interaction-chat-')
    const chat = makeChat()
    const { fake, registry, getCalls } = assemble(cwd, { im: { channel: 'auto', channelId: 'feishu' } }, { chatInteraction: chat.layer })

    const info = registry.list().find((entry: { name: string }) => entry.name === 'chat-interaction')
    assert.ok(info !== undefined, 'IM 通道应该注册为 chat-interaction')
    assert.equal(info.canAsk, true)
    assert.equal(info.canNotify, false, '本通道只转发提问，不接管通知')
    assert.equal(registry.describeAll().some((entry: { name: string }) => entry.name === 'chat-interaction'), true)
    assert.deepEqual([registry.im().mode, registry.im().registered, registry.im().apiVersion, registry.im().channelId], ['auto', true, 1, 'feishu'])
    assert.ok(registry.im().reason.includes('api v1'), registry.im().reason)
    assert.deepEqual(registry.problems(), [])
    assert.equal(getCalls.chat, 1, '每次 apply 只探测一次服务')

    const running = fake.runTool('interaction_ask', { question: '这条交付可以放出去吗？', options: ['allowed-once', 'rejected'] })
    await waitFor(() => chat.asks.length === 1, 'interaction_ask 没有把提问交给 chatInteraction')

    const request = chat.asks[0] as Record<string, any>
    assert.deepEqual(request.options, [
        { value: 'allowed-once', label: 'allowed-once' },
        { value: 'rejected', label: 'rejected' },
    ])
    assert.equal(request.channel, 'feishu', 'im.channelId 固定了要用的 IM 渠道')
    assert.ok(String(request.title).startsWith('需要决定：'), String(request.title))
    assert.ok(String(request.body).includes('一次性令牌：q-'), String(request.body))
    assert.ok(String(request.body).includes('allowed-once / rejected'), String(request.body))
    assert.equal(request.timeoutMs, 900_000, 'IM api 拿到的是宿主上限（调用方只能缩短）')
    const token = /一次性令牌：(q-[0-9a-f]+)/.exec(String(request.body))?.[1]
    assert.ok(token !== undefined, '卡片正文必须带一次性令牌')

    answer(chat, 'allowed-once')
    const run = await running
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.ok(text.includes('决定：allowed-once（声明选项之一）'), text)
    assert.ok(text.includes('通道：chat-interaction'), text)
    assert.ok(text.includes('回答者：ou_alice'), text)

    // The IM answer is recorded exactly like a local answer, against THIS
    // suite's token (pending row + decision row).
    const rows = rowsOf(cwd)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].channel, 'chat-interaction')
    assert.equal(rows[0].questionId, token)
    assert.equal(rows[0].decision, undefined)
    assert.equal(rows[1].decision, 'allowed-once')
    assert.equal(rows[1].channel, 'chat-interaction')
    assert.equal(rows[1].userId, 'ou_alice')
    assert.equal(rows[1].questionId, token)

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('IM 通道：chat-interaction（api v1，插件 v0.3.0，渠道 feishu）'), status)
    assert.ok(status.includes('需要人决定的提问走 IM'), status)
    assert.ok(status.includes('canAsk=true，canNotify=false'), status)

    // One answer per token: a replay (out-of-band push, re-wait) is refused.
    assert.equal(registry.submit(token, { value: 'rejected' }), false)
    assert.equal((await registry.awaitAnswer(token, 5)).outcome, 'unknown-token')
    assert.equal(await registry.get('chat-interaction').wait(token, 5), null)
    const after = rowsOf(cwd)
    assert.equal(after.length, 2, '重放不得写第三行')
    assert.equal(after[1].decision, 'allowed-once')
    assert.ok(registry.droppedAnswers() >= 1)
})

test('IM 通道：服务缺失 / apiVersion=0 / 部分对象 / 访问器抛错 → 不注册，本地通道路径与今天逐字一致', async () => {
    const variants: { label: string; services?: Record<string, unknown> }[] = [
        { label: '服务缺失' },
        { label: 'apiVersion=0', services: { chatInteraction: makeChat({ apiVersion: 0 }).layer } },
        { label: '部分对象（v1 但没有 ask）', services: { chatInteraction: makeChat({ ask: undefined }).layer } },
        { label: 'api 访问器抛错', services: { chatInteraction: Object.defineProperty({}, 'api', { get: () => { throw new Error('boom-accessor') } }) } },
        { label: '服务不是对象', services: { chatInteraction: 'not-a-service' } },
    ]
    for (const variant of variants) {
        const cwd = tempWorkspace('interaction-chat-')
        const { fake, registry, getCalls } = assemble(cwd, {}, variant.services)
        assert.equal(registry.list().some((entry: { name: string }) => entry.name === 'chat-interaction'), false, variant.label)
        assert.equal(registry.im().registered, false, variant.label)
        assert.notEqual(registry.im().reason.trim(), '', `${variant.label}：未注册必须给出原因`)
        assert.ok(
            registry.problems().some((problem: string) => problem.includes('IM 通道不可用')),
            `${variant.label}：problems() 也要写明"没走 IM、为什么"：${JSON.stringify(registry.problems())}`,
        )
        assert.equal(getCalls.chat, 1, `${variant.label}：只查一次服务，不重试也不崩溃`)

        // The local path is byte-for-byte today's: same declared options, same
        // token, same ledger rows, same decision.
        const local = localChannel()
        registry.register(local.channel)
        const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 4_000 })
        await waitFor(() => local.sent.length === 1, `${variant.label}：interaction_ask 没有走本地通道`)
        const card = local.sent[0] as Record<string, any>
        assert.equal(card.kind, 'ask')
        assert.ok(String(card.questionId).startsWith('q-'))
        assert.deepEqual(card.buttons, [
            { value: 'allowed-once', label: 'allowed-once' },
            { value: 'rejected', label: 'rejected' },
        ])
        assert.ok(String(card.body).includes('一次性令牌：'), variant.label)
        await local.answer({ value: 'allowed-once', by: 'local-1' })
        const run = await running
        assert.equal(run.isError, false, `${variant.label}：${runText(run)}`)
        const rows = rowsOf(cwd)
        assert.equal(rows.length, 2, variant.label)
        assert.equal(rows[0].decision, undefined, variant.label)
        assert.equal(rows[1].decision, 'allowed-once', variant.label)
        assert.equal(rows[1].channel, 'terminal', variant.label)
    }
})

test('IM 通道：im.channel=off → 即使服务存在也一次都不碰（0 次查找、0 次属性访问）', async () => {
    const cwd = tempWorkspace('interaction-chat-')
    let touched = 0
    const tripwire = new Proxy(
        {},
        {
            get: (_target, property) => {
                touched += 1
                throw new Error(`im.channel=off 时访问了 chatInteraction.${String(property)}`)
            },
        },
    )
    const { fake, registry, getCalls } = assemble(cwd, { im: { channel: 'off' } }, { chatInteraction: tripwire })

    assert.equal(getCalls.chat, 0, 'off 模式不得调用 ctx.get("chatInteraction")')
    assert.equal(touched, 0, 'off 模式不得读取 chatInteraction 的任何属性')
    assert.equal(registry.im().mode, 'off')
    assert.equal(registry.im().registered, false)
    assert.ok(registry.im().reason.includes('off'), registry.im().reason)
    assert.equal(registry.problems().some((problem: string) => problem.includes('IM 通道')), false, 'off 不是缺陷，不写进问题清单')

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('IM 通道：未注册（im.channel=off'), status)
    assert.ok(status.includes('仅本地通道'), status)
    assert.ok(status.trimEnd().split('\n').at(-1)!.startsWith('下一步：'))

    const local = localChannel()
    registry.register(local.channel)
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 4_000 })
    await waitFor(() => local.sent.length === 1, 'off 模式必须仍然走本地通道')
    await local.answer({ value: 'allowed-once', by: 'local-1' })
    assert.equal((await running).isError, false)
    assert.equal(getCalls.chat, 0, '整个提问过程也不得查找 IM 服务')
})

test('IM 通道：im.channel=required + 缺失/过旧 → apply 拒绝（写明装什么、怎么装），不装配任何工具与服务', async () => {
    const variants: { label: string; services?: Record<string, unknown> }[] = [
        { label: '缺失' },
        { label: '过旧', services: { chatInteraction: makeChat({ apiVersion: 0 }).layer } },
    ]
    for (const variant of variants) {
        const cwd = tempWorkspace('interaction-chat-')
        const fake = createFakeHost({ cwd, ...(variant.services === undefined ? {} : { services: variant.services }) })
        apply(fake.ctx as never, { logFile: path.join(cwd, LOG), im: { channel: 'required' } })
        assert.equal(fake.tools.size, 0, `${variant.label}：required 不允许静默降级运行`)
        assert.equal((fake.ctx as { get: (name: string) => unknown }).get('interaction'), undefined, variant.label)
        const log = fs.readFileSync(path.join(cwd, LOG), 'utf8')
        assert.ok(log.includes('im.channel=required'), log)
        assert.ok(log.includes('dsh-chat-interaction@>=0.3.0'), `${variant.label}：提示必须写明装什么版本`)
        assert.ok(log.includes('apiVersion'), `${variant.label}：提示必须写明契约版本`)
    }

    const hint = imRequiredHint('示例原因')
    assert.ok(hint.includes('dsh-chat-interaction@>=0.3.0'))
    assert.ok(hint.includes('拒绝'))

    // required + a usable service applies normally.
    const cwd = tempWorkspace('interaction-chat-')
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, { im: { channel: 'required' } }, { chatInteraction: chat.layer })
    assert.equal(fake.tools.size, 4)
    assert.equal(registry.im().registered, true)
})

test('IM 通道：超时与通道级失败 → 台账记拒绝并写明原因，任何门禁都不能读成 allowed-once', async () => {
    // 1) The human never answers: the ask deadline ends it.
    const cwd = tempWorkspace('interaction-chat-')
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, {}, { chatInteraction: chat.layer })
    // A short deadline used to mean 60 ms, which the channel clamps to its 1 s floor:
    // the send-side pre-flight could then lose the race under load and the test saw
    // `send-failed` instead of the `timeout` it asserts. The assertion stays exact —
    // give the deadline enough room that "nobody answered" is the only way to fail.
    const run = await fake.runTool('interaction_ask', { question: '还在吗？', options: ['allowed-once', 'rejected'], timeoutMs: 3000 })
    assert.equal(run.isError, true)
    assert.ok(runText(run).includes('refused:timeout'), runText(run))
    const rows = rowsOf(cwd)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].decision, undefined)
    assert.equal(rows[1].decision, refusalOf('timeout'))
    assert.notEqual(rows[1].decision, 'allowed-once')
    assert.ok(
        registry.problems().some((problem: string) => problem.includes('等待回答超时')),
        `超时必须被通道记录下来：${JSON.stringify(registry.problems())}`,
    )

    // 2) The IM api refuses up front (channel-unsupported): a refusal naming
    //    the reason, never a timeout that hides it.
    const cwd2 = tempWorkspace('interaction-chat-')
    const asks: Record<string, any>[] = []
    const chat2 = makeChat({
        ask: (request: Record<string, any>): unknown => {
            asks.push(request)
            return Promise.resolve({ ok: false, code: 'channel-unsupported', message: 'channel has no inbound capability' })
        },
    })
    const second = assemble(cwd2, {}, { chatInteraction: chat2.layer })
    const run2 = await second.fake.runTool('interaction_ask', { question: '有人能回答吗？', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    assert.equal(run2.isError, true)
    const text2 = runText(run2)
    assert.ok(text2.includes('refused:send-failed'), text2)
    assert.ok(text2.includes('channel-unsupported'), `拒绝必须写明 IM 的原因：${text2}`)
    const rows2 = rowsOf(cwd2)
    assert.equal(rows2.length, 1, '发不出去的提问不写 pending 行')
    assert.equal(rows2[0].decision, refusalOf('send-failed'))
    assert.ok(
        second.registry.problems().some((problem: string) => problem.includes('channel-unsupported')),
        JSON.stringify(second.registry.problems()),
    )
})

test('IM 通道：ask() 抛错 → 同样的拒绝路径（refused:send-failed + 原因），不崩溃', async () => {
    const cwd = tempWorkspace('interaction-chat-')
    const chat = makeChat({
        ask: (): unknown => {
            throw new Error('webhook 502')
        },
    })
    const { fake, registry } = assemble(cwd, {}, { chatInteraction: chat.layer })
    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:send-failed'), text)
    assert.ok(text.includes('webhook 502'), text)
    const rows = rowsOf(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].decision, refusalOf('send-failed'))
    assert.ok(registry.problems().some((problem: string) => problem.includes('webhook 502')))
})

test('IM 通道：宿主/敌对的 api（怪异返回、解两次）→ 不崩溃，台账绝不凭空多出一次批准', async () => {
    // Each shape arrives AFTER the card was accepted (a tick later), which is
    // the case the wait path must survive: a result the adapter cannot turn
    // into an answer is "no answer", never a decision.
    const late = (value: unknown): Promise<unknown> => new Promise((resolve) => setTimeout(() => resolve(value), 5))
    const shapes: { label: string; ask: () => unknown }[] = [
        { label: '声称成功但没有价值', ask: () => late({ ok: true }) },
        { label: '空答案文本', ask: () => late({ ok: true, value: { value: '   ' } }) },
        { label: '答非所问（未声明的选项）', ask: () => late({ ok: true, value: { value: 'root' } }) },
        { label: '非对象结果', ask: () => late('nope') },
        { label: '拒绝并带错误码', ask: () => late({ ok: false, code: 'internal', message: 'disposed' }) },
    ]
    for (const shape of shapes) {
        const cwd = tempWorkspace('interaction-chat-')
        const chat = makeChat({ ask: shape.ask })
        const { fake, registry } = assemble(cwd, {}, { chatInteraction: chat.layer })
        const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 80 })
        assert.equal(run.isError, true, shape.label)
        const rows = rowsOf(cwd).filter((row) => row.kind === 'ask' && row.decision !== undefined)
        assert.equal(rows.length, 1, shape.label)
        assert.equal(rows[0].decision, refusalOf('timeout'), `${shape.label}：${JSON.stringify(rows[0])}`)
        assert.notEqual(rows[0].decision, 'allowed-once', shape.label)
        assert.ok(registry.problems().length >= 1, `${shape.label}：必须记录原因`)
    }

    // A thenable that resolves twice: only the FIRST settlement may count, and
    // the second (a forged approval) must never reach the ledger.
    const cwd = tempWorkspace('interaction-chat-')
    const twice = {
        then(resolve: (value: unknown) => void): void {
            resolve({ ok: true, value: { value: 'rejected', text: 'rejected', messageId: 'om_1', by: 'ou_alice', via: 'click', at: Date.now() } })
            resolve({ ok: true, value: { value: 'allowed-once', text: 'allowed-once', messageId: 'om_2', by: 'ou_alice', via: 'click', at: Date.now() } })
        },
    }
    const chat = makeChat({ ask: () => twice })
    const { fake } = assemble(cwd, {}, { chatInteraction: chat.layer })
    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    assert.equal(run.isError, false, runText(run))
    const rows = rowsOf(cwd)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].decision, 'rejected', '只有第一次结算算数，第二次的"批准"必须被丢弃')
})

test('IM 通道：出站凭据在通道层就被拦下（内置规则 + 配置规则），卡片一次都不发', async () => {
    const cases: { label: string; config: Record<string, unknown>; body: string; rule: string }[] = [
        { label: '内置规则（AWS key）', config: {}, body: '把这把 key 贴进卡片：AKIAABCDEFGHIJKLMNOP', rule: 'aws-access-key-id' },
        { label: '配置的 redactPatterns', config: { redactPatterns: ['TOPSECRET-[0-9]{4}'] }, body: '内部代号 TOPSECRET-1234 不能外发', rule: 'config:redactPatterns[0]' },
    ]
    for (const testCase of cases) {
        const cwd = tempWorkspace('interaction-chat-')
        const chat = makeChat()
        const { registry } = assemble(cwd, testCase.config, { chatInteraction: chat.layer })
        const token = `q-${'a'.repeat(32)}`
        assert.equal(registry.arm(token), true)
        const sent = await registry.send('chat-interaction', { kind: 'ask', title: '需要决定：能发吗？', body: testCase.body, questionId: token })
        assert.equal(sent.ok, false, `${testCase.label}：疑似凭据必须拒绝发送`)
        assert.ok(String(sent.error).includes('凭据'), String(sent.error))
        assert.equal(chat.asks.length, 0, `${testCase.label}：卡片一次都不能发出去`)
        const problems = registry.problems().join('\n')
        assert.ok(problems.includes(testCase.rule), `${testCase.label}：必须记录命中的规则（脱敏）\n${problems}`)
        assert.ok(!problems.includes(testCase.body), `${testCase.label}：台账/问题里不得出现原文`)
        const log = fs.existsSync(path.join(cwd, LOG)) ? fs.readFileSync(path.join(cwd, LOG), 'utf8') : ''
        assert.ok(!log.includes(testCase.body), `${testCase.label}：日志里不得出现原文`)
    }
})

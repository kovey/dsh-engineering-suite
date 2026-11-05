/**
 * dsh-interaction-gate — the OPTIONAL IM channel's REACTIVE binding.
 *
 * The bug this file is about: bundle order does not decide apply order, and
 * `dsh-chat-interaction` provides its `chatInteraction` service at the END of
 * its own `apply`. A one-shot probe in our `apply` froze "local only" forever
 * whenever we applied first. These tests drive the REAL tool surface
 * (`apply` + `runTool`) and the REAL registry, with a fake `chatInteraction`
 * provided AFTER our apply — the exact ordering that used to lose the channel.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, createInteractionRegistry, installImChannel, resolveConfig } from '../dist/index.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const LOG = 'interaction-gate.log'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Every host assembled here is torn down (timers/subscriptions) after the run. */
const hosts: FakeHost[] = []
test.after(() => {
    for (const host of hosts) host.dispose()
})

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 1_000; index += 1) {
        if (predicate()) return
        await sleep(1)
    }
    assert.ok(predicate(), message)
}

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
        capabilities: () => ({ ok: true, value: { cards: true, richText: true, images: false, inbound: true } }),
        authState: () => ({ ok: true, mode: 'auto', activeChat: 'oc_demo', listenerConnected: true, pendingQuestions: [] }),
        ask: (request: Record<string, any>): unknown => {
            asks.push(request)
            return new Promise((resolve) => pending.push(resolve as (value: unknown) => void))
        },
    }
    Object.assign(api, overrides)
    return { layer: { api }, api, asks, pending }
}

function answer(chat: FakeChat, value: string, extra: Record<string, unknown> = {}): void {
    const resolve = chat.pending.shift()
    assert.ok(resolve !== undefined, 'IM 的 ask() 没有在等待回答')
    resolve({ ok: true, value: { value, text: value, messageId: 'om_card_1', by: 'ou_alice', via: 'click', at: Date.now(), ...extra } })
}

interface Assembly {
    fake: FakeHost
    registry: any
    getCalls: { chat: number }
}

/** Assemble the plugin, counting the service lookups the plugin performs. */
function assemble(cwd: string, config: Record<string, unknown> = {}, services?: Record<string, unknown>): Assembly {
    const fake = createFakeHost({ cwd, ...(services === undefined ? {} : { services: { ...services } }) })
    hosts.push(fake)
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

/** Provide a service AFTER apply (the ordering bug) and return its withdrawal disposer. */
function provide(fake: FakeHost, name: string, value: unknown): () => void {
    const ctx = fake.ctx as { provide: (service: string, value: unknown) => unknown }
    const dispose = ctx.provide(name, value)
    assert.equal(typeof dispose, 'function', 'fake host 的 provide 必须返回 disposer（与 cordis 一致）')
    return dispose as () => void
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

test('IM 通道（装配顺序 bug 回归）：先 apply 本插件、后 provide 服务 → 通道自动注册，提问经 api.ask 落账', async () => {
    const cwd = tempWorkspace('interaction-chat-order-')
    const { fake, registry, getCalls } = assemble(cwd, { preferredChannels: ['chat-interaction'] })
    assert.equal(registry.im().phase, 'absent')
    assert.equal(registry.im().registered, false)
    const before = runText(await fake.runTool('interaction_status', {}))
    assert.ok(before.includes('phase=absent'), before)

    // Before the service exists the local path behaves exactly as today.
    const local = localChannel()
    registry.register(local.channel)
    const first = fake.runTool('interaction_ask', { question: '服务出现前问一次', options: ['allowed-once', 'rejected'], timeoutMs: 4_000 })
    await waitFor(() => local.sent.length === 1, '服务缺失时必须仍走本地通道')
    await local.answer({ value: 'allowed-once', by: 'local-1' })
    const firstRun = await first
    assert.equal(firstRun.isError, false, runText(firstRun))
    assert.equal(rowsOf(cwd).at(-1)!.channel, 'terminal')

    // The bug: dsh-chat-interaction applies AFTER us and provides at the end.
    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '服务出现后必须注册 chat-interaction')
    assert.ok(registry.get('chat-interaction') !== undefined)
    assert.deepEqual(fake.injections(), [['chatInteraction']])
    assert.equal(getCalls.chat, 1, '快路径探测一次；反应式回调走注入上下文，不重复探测父上下文')
    const afterProvide = runText(await fake.runTool('interaction_status', {}))
    assert.ok(afterProvide.includes('phase=registered'), afterProvide)

    const second = fake.runTool('interaction_ask', { question: '服务出现后再问一次', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat.asks.length === 1, '服务出现后提问必须走 IM')
    const token = /一次性令牌：(q-[0-9a-f]+)/.exec(String(chat.asks[0]!.body))?.[1]
    answer(chat, 'allowed-once')
    const secondRun = await second
    assert.equal(secondRun.isError, false, runText(secondRun))
    assert.ok(runText(secondRun).includes('通道：chat-interaction'), runText(secondRun))
    const last = rowsOf(cwd).at(-1)!
    assert.equal(last.channel, 'chat-interaction')
    assert.equal(last.decision, 'allowed-once')
    assert.equal(last.questionId, token)

    const log = fs.readFileSync(path.join(cwd, LOG), 'utf8')
    assert.ok(log.includes('等待 chatInteraction 提供'), log)
    assert.ok(log.includes('interaction channel: chat-interaction(api v1)'), log)
})

test('IM 通道：服务始终不出现 → 本地照常、status phase=absent、"等待提供"日志只有一行', async () => {
    const cwd = tempWorkspace('interaction-chat-absent-')
    const { fake, registry } = assemble(cwd, {})
    assert.equal(registry.im().phase, 'absent')
    const local = localChannel()
    registry.register(local.channel)
    const running = fake.runTool('interaction_ask', { question: '没有 IM 时也要能问', options: ['allowed-once', 'rejected'], timeoutMs: 4_000 })
    await waitFor(() => local.sent.length === 1, '本地通道路径必须照常工作')
    await local.answer({ value: 'allowed-once', by: 'local-1' })
    assert.equal((await running).isError, false)
    assert.equal(rowsOf(cwd).at(-1)!.channel, 'terminal')
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('phase=absent'), status)
    assert.ok(status.includes('仅本地通道'), status)
    assert.equal(registry.list().some((entry: { name: string }) => entry.name === 'chat-interaction'), false)
    const log = fs.readFileSync(path.join(cwd, LOG), 'utf8')
    const waitingLines = log.split('\n').filter((line) => line.includes('interaction channel: 等待 chatInteraction 提供'))
    assert.equal(waitingLines.length, 1, `等待日志不得刷屏：\n${log}`)
})

test('IM 通道：required + 窗口内出现 → phase=waiting 后注册，提问经 IM 落账', async () => {
    const cwd = tempWorkspace('interaction-chat-window-')
    const { fake, registry } = assemble(cwd, {
        im: { channel: 'required', requiredWaitMs: 2_000 },
        preferredChannels: ['chat-interaction'],
    })
    assert.equal(registry.im().phase, 'waiting')
    assert.equal(registry.im().requiredWaitMs, 2_000)
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('phase=waiting'), status)
    assert.ok(status.includes('等待窗口 2000ms'), status)

    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '窗口内出现必须注册')
    const running = fake.runTool('interaction_ask', { question: '窗口内出现后问一次', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat.asks.length === 1, '窗口内出现后提问必须走 IM')
    answer(chat, 'allowed-once')
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.equal(rowsOf(cwd).at(-1)!.channel, 'chat-interaction')
})

test('IM 通道：required 超时拒绝后迟到出现 → 清除拒绝并注册，后续提问走 IM（自愈）', async () => {
    const cwd = tempWorkspace('interaction-chat-late-')
    const { fake, registry } = assemble(cwd, {
        im: { channel: 'required', requiredWaitMs: 20 },
        preferredChannels: ['chat-interaction'],
    })
    await waitFor(() => registry.im().phase === 'refused', '窗口结束后应拒绝')
    const local = localChannel()
    registry.register(local.channel)
    const refused = await fake.runTool('interaction_ask', { question: '拒绝期间提问', options: ['yes', 'no'] })
    assert.equal(refused.isError, true)
    assert.equal(local.sent.length, 0, '拒绝期间不得静默走本地')

    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '迟到出现必须清除拒绝并注册')
    assert.equal(registry.im().registered, true)
    const running = fake.runTool('interaction_ask', { question: '自愈后再问', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat.asks.length === 1, '自愈后必须走 IM')
    answer(chat, 'allowed-once')
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.equal(rowsOf(cwd).at(-1)!.decision, 'allowed-once')
})

test('IM 通道：注册后撤销 → 注销并回退本地、在途提问失败关闭（落 refused 行）；再次提供重新注册', async () => {
    const cwd = tempWorkspace('interaction-chat-withdraw-')
    const { fake, registry } = assemble(cwd, { preferredChannels: ['chat-interaction'] })
    const chat = makeChat()
    const remove = provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '先注册成功')
    const local = localChannel()
    registry.register(local.channel)

    const inFlight = fake.runTool('interaction_ask', { question: '撤销时在途的提问', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat.asks.length === 1, '提问应已交给 IM')
    remove()
    await waitFor(() => registry.im().phase === 'absent', '撤销后应回到缺席')
    assert.equal(registry.get('chat-interaction'), undefined)
    const settled = await inFlight
    assert.equal(settled.isError, true, '在途提问必须失败关闭，不能挂起')
    assert.ok(runText(settled).includes('refused:'), runText(settled))
    const last = rowsOf(cwd).at(-1)!
    assert.ok(String(last.decision).startsWith('refused:'), JSON.stringify(last))
    assert.notEqual(last.decision, 'allowed-once')

    // `auto` falls back to the local channel.
    const second = fake.runTool('interaction_ask', { question: '撤销后回退本地', options: ['allowed-once', 'rejected'], timeoutMs: 4_000 })
    await waitFor(() => local.sent.length === 1, '撤销后应回退本地通道')
    await local.answer({ value: 'allowed-once', by: 'local-2' })
    const secondRun = await second
    assert.equal(secondRun.isError, false, runText(secondRun))
    assert.equal(rowsOf(cwd).at(-1)!.channel, 'terminal')

    // Re-provide registers again and routes there.
    const chat2 = makeChat()
    provide(fake, 'chatInteraction', chat2.layer)
    await waitFor(() => registry.im().phase === 'registered', '再次提供必须重新注册')
    const third = fake.runTool('interaction_ask', { question: '重新注册后再问', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat2.asks.length === 1, '重新注册后必须走 IM')
    answer(chat2, 'allowed-once')
    const thirdRun = await third
    assert.equal(thirdRun.isError, false, runText(thirdRun))
    assert.equal(rowsOf(cwd).at(-1)!.channel, 'chat-interaction')
})

test('IM 通道：旧 apiVersion=0 先出现 → 按缺席处理并记录；替换成 v1 后注册', async () => {
    const cwd = tempWorkspace('interaction-chat-old-')
    const { fake, registry } = assemble(cwd, { preferredChannels: ['chat-interaction'] })
    const old = makeChat({ apiVersion: 0 })
    const removeOld = provide(fake, 'chatInteraction', old.layer)
    await waitFor(() => registry.im().appeared === true, '应记录服务已出现')
    assert.equal(registry.im().phase, 'absent')
    assert.equal(registry.im().registered, false)
    assert.ok(registry.im().reason.includes('apiVersion=0'), registry.im().reason)
    assert.equal(registry.list().some((entry: { name: string }) => entry.name === 'chat-interaction'), false)
    assert.equal(old.asks.length, 0, '旧版本一次都不能被用来提问')
    const log = fs.readFileSync(path.join(cwd, LOG), 'utf8')
    assert.ok(log.includes('出现但不可用'), log)
    removeOld()

    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '替换成 v1 后必须注册')
    const running = fake.runTool('interaction_ask', { question: '升级后问一次', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat.asks.length === 1, '升级后必须走 IM')
    answer(chat, 'allowed-once')
    assert.equal((await running).isError, false)
})

test('IM 通道：api 不完整（v1 但没有 ask）→ 按缺席处理；替换成完整 v1 后注册', async () => {
    const cwd = tempWorkspace('interaction-chat-partial-')
    const { fake, registry } = assemble(cwd, {})
    const partial = makeChat({ ask: undefined })
    const removePartial = provide(fake, 'chatInteraction', partial.layer)
    await waitFor(() => registry.im().appeared === true, '应记录服务已出现')
    assert.equal(registry.im().phase, 'absent')
    assert.ok(registry.im().reason.includes('ask'), registry.im().reason)
    assert.equal(registry.list().some((entry: { name: string }) => entry.name === 'chat-interaction'), false)
    removePartial()

    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '完整 v1 必须注册')
    assert.equal(registry.im().apiVersion, 1)
})

test('IM 通道：required + requiredWaitMs=0 → 立即拒绝（不睡默认 5s），迟到出现仍可自愈', async () => {
    const cwd = tempWorkspace('interaction-chat-zero-')
    const { fake, registry } = assemble(cwd, {
        im: { channel: 'required', requiredWaitMs: 0 },
        preferredChannels: ['chat-interaction'],
    })
    assert.equal(registry.im().phase, 'refused')
    assert.equal(registry.im().requiredWaitMs, 0)
    const chat = makeChat()
    provide(fake, 'chatInteraction', chat.layer)
    await waitFor(() => registry.im().phase === 'registered', '迟到出现必须自愈')
})

test('IM 通道：服务提供者重启（重新 provide 同版本）→ 旧通道摘掉、新通道注册，列表仍只有 1 个', async () => {
    const cwd = tempWorkspace('interaction-chat-replace-')
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, {}, { chatInteraction: chat.layer })
    assert.equal(registry.im().phase, 'registered')
    const chat2 = makeChat()
    provide(fake, 'chatInteraction', chat2.layer)
    await waitFor(() => registry.im().phase === 'registered', '替换后必须重新注册')
    assert.equal(registry.list().filter((entry: { name: string }) => entry.name === 'chat-interaction').length, 1)
    assert.equal(
        registry.problems().some((problem: string) => problem.includes('拒绝重复注册通道')),
        false,
        JSON.stringify(registry.problems()),
    )
    const running = fake.runTool('interaction_ask', { question: '重启后问一次', options: ['allowed-once', 'rejected'], timeoutMs: 5_000 })
    await waitFor(() => chat2.asks.length === 1, '必须使用新的服务实例')
    answer(chat2, 'allowed-once')
    assert.equal((await running).isError, false)
})

test('IM 通道：required 窗口默认 5000ms、可配置；注入的定时器在 dispose 时清除，触发不再改变状态', () => {
    assert.equal(resolveConfig({}, () => undefined).im.requiredWaitMs, 5_000)
    assert.equal(resolveConfig({ im: { channel: 'required', requiredWaitMs: 1_200 } }, () => undefined).im.requiredWaitMs, 1_200)
    const warnings: string[] = []
    assert.equal(
        resolveConfig({ im: { channel: 'required', requiredWaitMs: -1 } }, (message) => warnings.push(message)).im.requiredWaitMs,
        5_000,
    )
    assert.ok(warnings.some((message) => message.includes('im.requiredWaitMs')), warnings.join('\n'))

    const scheduled: { at: number; fire: () => void }[] = []
    const cleared: unknown[] = []
    const registry = createInteractionRegistry({ now: () => 1_000 })
    const binding = installImChannel(
        { get: () => undefined },
        {
            mode: 'required',
            requiredWaitMs: 5_000,
            askTimeoutMs: 900_000,
            registry,
            logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
            timers: {
                setTimeout: (callback, ms) => {
                    const handle = { scheduledAt: ms }
                    scheduled.push({ at: ms, fire: callback })
                    return handle
                },
                clearTimeout: (handle) => cleared.push(handle),
            },
        },
    )
    assert.equal(scheduled.length, 1, '有界窗口必须安排一个定时器')
    assert.equal(scheduled[0]!.at, 5_000)
    assert.equal(registry.im().phase, 'waiting')
    binding.dispose()
    assert.equal(cleared.length, 1, 'dispose 必须清除窗口定时器（不留悬挂定时器）')
    scheduled[0]!.fire()
    assert.equal(registry.im().phase, 'waiting', '已清除的定时器触发不得改变状态')
})

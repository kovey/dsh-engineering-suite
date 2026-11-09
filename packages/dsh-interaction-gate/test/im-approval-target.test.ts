/**
 * dsh-interaction-gate — P0: the IM approval TARGET and its whitelist.
 *
 * The hole this closes: without `im.approvalChatId` the IM plugin resolves the
 * target from its own state (`p2pChat || activeChat`), and `p2pChat` is simply
 * "the last chat that messaged the bot" — so anyone who DMs the bot could
 * redirect our approval card. Every test here therefore drives the REAL tool
 * surface (`apply` + `runTool`) over a fake `chatInteraction` service that
 * records the exact `api.ask` payload, so a passing test is a claim about what
 * the IM plugin and the gate actually exchange.
 *
 * Acceptance cases: TC-901…TC-907 of the approved specification
 * (`p0-im-p2p-chatid-from-…`). TC-908 is the verification run itself
 * (`bash scripts/verify.sh --quiet` → exit 0), not a unit case.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, resolveConfig } from '../dist/index.js'
import { refusalOf } from '../dist/ledger.js'
import { imAskTargetOf } from '../dist/tools.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const OUTBOX = '.dsh/interaction/outbox.jsonl'
const APPROVERS = '.dsh/interaction-approvers.txt'
const LOG = 'interaction-gate.log'

/** The one conversation approvals may go to. */
const APPROVAL_CHAT = 'oc_approvals'
/** Deliberately NOT the approval chat: what the IM plugin would resolve on its own. */
const PLUGIN_ACTIVE_CHAT = 'oc_active'
const PLUGIN_P2P_CHAT = 'oc_whoever_dmed'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Hosts assembled by this file: their effects (timers/subscriptions) are torn down after the run. */
const hosts: FakeHost[] = []
test.after(() => {
    for (const host of hosts) host.dispose()
})

/** Poll until a predicate holds (the tools run on real timers). */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 1_000; index += 1) {
        if (predicate()) return
        await sleep(1)
    }
    assert.ok(predicate(), message)
}

/** A fake `chatInteraction` service (0.3.4 shape) that records the ask payload. */
interface FakeChat {
    layer: { api: Record<string, unknown> }
    asks: Record<string, any>[]
    /** Resolve the pending `api.ask` with a crafted answer. */
    settle: (result: unknown) => void
    /** Fire one `onAnswerIgnored` event (asserts the hook was subscribed). */
    emitIgnored: (event: Record<string, unknown>) => void
    /** Whether the adapter disposed its subscription. */
    hooked: () => boolean
}

function makeChat(variant: { withIgnoredHook?: boolean } = {}): FakeChat {
    const asks: Record<string, any>[] = []
    const pending: ((value: unknown) => void)[] = []
    let handler: ((event: Record<string, unknown>) => void) | undefined
    const api: Record<string, unknown> = {
        apiVersion: 1,
        info: () => ({ apiVersion: 1, pluginVersion: '0.3.4', channels: [] }),
        channels: () => [
            { name: 'feishu', label: '飞书', connected: true, capabilities: { cards: true, richText: true, images: false, inbound: true } },
        ],
        capabilities: () => ({ ok: true, value: { cards: true, richText: true, images: false, inbound: true } }),
        // The plugin's OWN idea of where the conversation is: the tests assert
        // the adapter never falls back to it once a target is configured.
        authState: () => ({
            ok: true,
            mode: 'auto',
            allowlist: [],
            activeChat: PLUGIN_ACTIVE_CHAT,
            p2pChat: PLUGIN_P2P_CHAT,
            listenerRole: '',
            listenerConnected: true,
            pendingQuestions: [],
        }),
        ask: (request: Record<string, any>): unknown => {
            asks.push(request)
            return new Promise((resolve) => pending.push(resolve as (value: unknown) => void))
        },
    }
    if (variant.withIgnoredHook !== false) {
        api['onAnswerIgnored'] = (next: (event: Record<string, unknown>) => void): { dispose: () => void } => {
            handler = next
            return {
                dispose: () => {
                    handler = undefined
                },
            }
        }
    }
    return {
        layer: { api },
        asks,
        settle(result: unknown): void {
            const resolve = pending.shift()
            assert.ok(resolve !== undefined, 'IM 的 ask() 没有在等待回答')
            ;(resolve as (value: unknown) => void)(result)
        },
        emitIgnored(event: Record<string, unknown>): void {
            assert.ok(handler !== undefined, 'adapter 必须已订阅 onAnswerIgnored')
            ;(handler as (event: Record<string, unknown>) => void)(event)
        },
        hooked: () => handler !== undefined,
    }
}

/** Write the project approver list (also the `from` whitelist of an approval card). */
function writeApprovers(cwd: string, ids: string[]): void {
    const file = path.join(cwd, APPROVERS)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ids.map((id) => `# approvers\n${id}`).join('\n') + '\n', 'utf8')
}

/** Assemble the plugin (the real `apply`) with a fake IM service. */
function assemble(
    cwd: string,
    config: Record<string, unknown>,
    services?: Record<string, unknown>,
): { fake: FakeHost; registry: any } {
    const fake = createFakeHost({ cwd, ...(services === undefined ? {} : { services: { ...services } }) })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG), ...config })
    return { fake, registry: (fake.ctx as { get: (name: string) => unknown }).get('interaction') }
}

function rowsOf(file: string): Record<string, any>[] {
    const full = file.includes(path.sep) || path.isAbsolute(file) ? file : file
    if (!fs.existsSync(full)) return []
    return fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, any>)
}

const ledgerOf = (cwd: string): Record<string, any>[] => rowsOf(path.join(cwd, LEDGER))
const outboxOf = (cwd: string): Record<string, any>[] => rowsOf(path.join(cwd, OUTBOX))

/** The configured-target shape every case below starts from. */
const TARGET_CONFIG = { im: { channel: 'auto', channelId: 'feishu', approvalChatId: APPROVAL_CHAT } } as const

test('TC-901 P0 目标：ask 显式携带 chatId（im.approvalChatId）与 from（审批人名单），来源匹配后正常落账为决定', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice', 'ou_bob'])
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })

    const running = fake.runTool('interaction_ask', { question: '这条交付可以放出去吗？', options: ['allowed-once', 'rejected'] })
    await waitFor(() => chat.asks.length === 1, 'interaction_ask 没有把提问交给 chatInteraction')

    const request = chat.asks[0] as Record<string, any>
    // AC-001: the target and the whitelist are EXPLICIT in the payload…
    assert.equal(request.chatId, APPROVAL_CHAT, 'chatId 必须来自配置的 im.approvalChatId')
    assert.notEqual(request.chatId, PLUGIN_ACTIVE_CHAT, '不得退回 IM 插件的 activeChat')
    assert.notEqual(request.chatId, PLUGIN_P2P_CHAT, '不得退回 IM 插件的 p2pChat（任何人私聊都能覆写）')
    assert.deepEqual(request.from, ['ou_alice', 'ou_bob'], 'from 必须是项目审批人名单')
    // …and nothing else about the payload changed.
    assert.equal(request.channel, 'feishu', 'im.channelId 仍然固定渠道')
    assert.deepEqual(request.options, [
        { value: 'allowed-once', label: 'allowed-once' },
        { value: 'rejected', label: 'rejected' },
    ])
    assert.equal(request.timeoutMs, 900_000)
    // The conversation is now KNOWN, so the outbox serializes the right chat.
    assert.equal(registry.get('chat-interaction').chatId, APPROVAL_CHAT)
    const intent = outboxOf(cwd).find((row) => row.kind === 'ask' && row.state === 'intent')
    assert.ok(intent !== undefined, `outbox 必须有 intent 行：${JSON.stringify(outboxOf(cwd))}`)
    assert.equal(intent?.chatId, APPROVAL_CHAT)

    // A matching answer (right chat, proven p2p, named approver) is a decision.
    chat.settle({
        ok: true,
        value: {
            value: 'allowed-once',
            text: 'allowed-once',
            messageId: 'om_card_1',
            by: 'ou_alice',
            chatId: APPROVAL_CHAT,
            chatKind: 'p2p',
            via: 'click',
            at: Date.now(),
        },
    })
    const run = await running
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.ok(text.includes('决定：allowed-once（声明选项之一）'), text)
    assert.ok(text.includes('通道：chat-interaction'), text)
    assert.ok(text.includes('回答者：ou_alice'), text)

    const rows = ledgerOf(cwd)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].decision, undefined, '第一行是 pending（提问已发出）')
    assert.equal(rows[1].decision, 'allowed-once')
    assert.equal(rows[1].userId, 'ou_alice')
    // The subscription is torn down with the plugin (no leak after dispose).
    assert.equal(chat.hooked(), true, '在装期间必须订阅被忽略答案事件')
    fake.dispose()
    assert.equal(chat.hooked(), false, 'dispose 之后必须取消 onAnswerIgnored 订阅')
})

test('TC-902 P0 观测：interaction_status 显示审批目标已配置、名单人数与被忽略回答计数', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice', 'ou_bob'])
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })

    // Someone outside the whitelist tried to answer: the upstream ignored it and
    // told us so. That is "someone tried", not "nobody answered".
    chat.emitIgnored({
        channel: 'feishu',
        chatId: APPROVAL_CHAT,
        by: 'ou_mallory',
        text: 'allowed-once',
        messageId: 'om_evil_1',
        reason: 'sender-not-allowed',
        at: Date.now(),
    })

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes(`IM 审批目标：${APPROVAL_CHAT}（p2pOnly=true；from 白名单 2 个 id`), status)
    assert.ok(status.includes('IM 被忽略的回答尝试：1 次（发起者不在白名单 1 次，答非所问 0 次）'), status)
    assert.ok(status.includes('ou_mallory'), `被忽略的尝试必须写明发起者：\n${status}`)
    assert.ok(status.includes('sender-not-allowed'), status)
    assert.ok(status.includes(APPROVAL_CHAT), status)
    assert.ok(status.includes('它们**不是**决定'), status)

    // The registry report carries the same facts (what `interaction_status` renders).
    const report = registry.im()
    assert.equal(report.approvalChatId, APPROVAL_CHAT)
    assert.equal(report.p2pOnly, true)
    assert.equal(report.ignoredAnswers?.upstream, 'hooked')
    assert.equal(report.ignoredAnswers?.total, 1)
    assert.equal(report.ignoredAnswers?.bySender, 1)
    assert.equal(report.ignoredAnswers?.recent[0]?.by, 'ou_mallory')
    assert.equal(report.ignoredAnswers?.recent[0]?.messageId, 'om_evil_1')
    // The attempt's raw TEXT is never stored (a refused message can still hold a
    // credential; the report only needs the reason/who/where).
    assert.equal(JSON.stringify(report.ignoredAnswers).includes('allowed-once'), false)
})

test('TC-903 P0 来源：答案的 chatId 不是配置目标 → refused:wrong-chat，没有决定、令牌不被换成放行', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice'])
    const chat = makeChat()
    const { fake } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })

    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await waitFor(() => chat.asks.length === 1, '提问没有发出去')
    // The right person, the right option — from the WRONG conversation (the one
    // the plugin would have picked on its own).
    chat.settle({
        ok: true,
        value: {
            value: 'allowed-once',
            text: 'allowed-once',
            messageId: 'om_card_2',
            by: 'ou_alice',
            chatId: PLUGIN_P2P_CHAT,
            chatKind: 'p2p',
            via: 'click',
            at: Date.now(),
        },
    })
    const run = await running
    assert.equal(run.isError, true, runText(run))
    const text = runText(run)
    assert.ok(text.includes('refused:wrong-chat'), text)
    assert.ok(text.includes(`im.approvalChatId=${APPROVAL_CHAT}`), text)
    assert.ok(text.includes(PLUGIN_P2P_CHAT), `拒绝必须写明答案实际来自哪个会话：${text}`)
    assert.ok(text.includes('一次性令牌也不会被换成一次放行'), text)

    const rows = ledgerOf(cwd)
    assert.equal(
        rows.filter((row) => row.decision === 'allowed-once').length,
        0,
        '来源不符的答案绝不能变成放行',
    )
    assert.equal(rows.at(-1)?.decision, refusalOf('wrong-chat'))
    // The audit trail keeps WHO answered and WHICH message it was, so "someone
    // else's answer arrived" is a fact an operator can find later.
    assert.equal(rows.at(-1)?.userId, 'ou_alice')
    assert.equal(rows.at(-1)?.messageId, 'om_card_2')
    // The question was never recorded as answered (no replay will treat it as one).
    assert.equal(outboxOf(cwd).some((row) => row.state === 'answered'), false)
})

test('TC-904 P0 p2p：群聊答案与"类型未证明"的答案都拒绝（refused:not-p2p），没有决定', async () => {
    const cases: { label: string; chatKind?: 'p2p' | 'group'; expect: string }[] = [
        { label: '群聊答案', chatKind: 'group', expect: 'chatKind=group' },
        { label: '未报告会话类型', expect: '没有报告 chatKind' },
    ]
    for (const testCase of cases) {
        const cwd = tempWorkspace('interaction-p0-')
        writeApprovers(cwd, ['ou_alice'])
        const chat = makeChat()
        const { fake } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })

        const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
        await waitFor(() => chat.asks.length === 1, `${testCase.label}：提问没有发出去`)
        chat.settle({
            ok: true,
            value: {
                value: 'allowed-once',
                text: 'allowed-once',
                messageId: 'om_card_3',
                by: 'ou_alice',
                chatId: APPROVAL_CHAT,
                ...(testCase.chatKind === undefined ? {} : { chatKind: testCase.chatKind }),
                via: 'click',
                at: Date.now(),
            },
        })
        const run = await running
        assert.equal(run.isError, true, testCase.label)
        const text = runText(run)
        assert.ok(text.includes('refused:not-p2p'), `${testCase.label}：${text}`)
        assert.ok(text.includes(testCase.expect), `${testCase.label}：拒绝要写明是哪一种"未证明"：${text}`)
        const rows = ledgerOf(cwd)
        assert.equal(rows.filter((row) => row.decision === 'allowed-once').length, 0, testCase.label)
        assert.equal(rows.at(-1)?.decision, refusalOf('not-p2p'), testCase.label)
    }
})

test('TC-905 P0 fail closed：配置了目标但名单为空/缺失 → 拒绝发问，一张卡片都不发（也不降级到本地通道）', async () => {
    for (const testCase of [{ label: '名单不存在' }, { label: '名单只有注释' }]) {
        const cwd = tempWorkspace('interaction-p0-')
        if (testCase.label === '名单只有注释') writeApprovers(cwd, [])
        const chat = makeChat()
        const { fake, registry } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })
        // A perfectly usable LOCAL channel exists: fail-closed must not use it.
        const sent: Record<string, any>[] = []
        registry.register({
            name: 'terminal',
            async send(message: Record<string, any>) {
                sent.push(message)
                return { ok: true, messageId: 'm-1' }
            },
            async wait(): Promise<unknown> {
                return await new Promise(() => undefined)
            },
            describe: () => ({ canAsk: true, canNotify: true }),
        })

        const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
        assert.equal(run.isError, true, testCase.label)
        const text = runText(run)
        assert.ok(text.includes('refused:no-allowlist'), `${testCase.label}：${text}`)
        assert.ok(text.includes('审批人名单为空或不可读'), text)
        assert.equal(chat.asks.length, 0, `${testCase.label}：不得发出任何卡片`)
        assert.equal(sent.length, 0, `${testCase.label}：不得降级到本地通道`)
        const rows = ledgerOf(cwd)
        assert.equal(rows.length, 1, testCase.label)
        assert.equal(rows[0].decision, refusalOf('no-allowlist'), testCase.label)

        const status = runText(await fake.runTool('interaction_status', {}))
        assert.ok(status.includes('当前会**拒绝发问**（refused:no-allowlist）'), `${testCase.label}：${status}`)
    }
})

test('TC-906 P0 留痕：非名单用户回答被上游忽略 → 记录原因/发起者/会话，提问最终是超时而非决定', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice'])
    const chat = makeChat()
    const { fake, registry } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })

    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'], timeoutMs: 2_500 })
    await waitFor(() => chat.asks.length === 1, '提问没有发出去')
    // The upstream enforces `from` itself: the reply is ignored and the wait goes
    // on. We only get to see it through `onAnswerIgnored`.
    chat.emitIgnored({
        channel: 'feishu',
        chatId: APPROVAL_CHAT,
        by: 'ou_mallory',
        text: 'allowed-once',
        messageId: 'om_evil_2',
        reason: 'sender-not-allowed',
        at: Date.now(),
    })
    const run = await running
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:timeout'), text)

    // A timeout, never a decision — and the ignored attempt is on record.
    assert.equal(ledgerOf(cwd).filter((row) => row.decision === 'allowed-once').length, 0)
    const problems = registry.problems().join('\n')
    assert.ok(problems.includes('ou_mallory'), `problems() 必须写明发起者：\n${problems}`)
    assert.ok(problems.includes('sender-not-allowed'), problems)
    assert.ok(problems.includes(APPROVAL_CHAT), problems)
    assert.ok(problems.includes('它没有成为决定'), problems)

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('IM 被忽略的回答尝试：1 次'), status)
    assert.ok(status.includes('ou_mallory'), status)
})

test('TC-907 P0 未配置目标：ask 不带 chatId/from，行为与今天逐字一致（显式 p2pOnly 则是 fail closed）', async () => {
    // (a) No target configured: byte-for-byte today's payload and behaviour.
    const cwd = tempWorkspace('interaction-p0-')
    const chat = makeChat()
    const { fake } = assemble(cwd, { im: { channel: 'auto', channelId: 'feishu' } }, { chatInteraction: chat.layer })
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await waitFor(() => chat.asks.length === 1, '提问没有发出去')
    const request = chat.asks[0] as Record<string, any>
    assert.equal('chatId' in request, false, '未配置目标时不得传 chatId')
    assert.equal('from' in request, false, '未配置目标时不得传 from')
    assert.equal(request.channel, 'feishu')
    // No provenance at all on the answer: still a decision, exactly as today.
    chat.settle({
        ok: true,
        value: { value: 'allowed-once', text: 'allowed-once', messageId: 'om_1', by: 'local-1', via: 'click', at: Date.now() },
    })
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.equal(ledgerOf(cwd).at(-1)?.decision, 'allowed-once')

    // (b) `im.p2pOnly` explicitly on but NO target: a requirement nobody can
    //     execute is refused up front instead of looking hardened.
    const cwd2 = tempWorkspace('interaction-p0-')
    const chat2 = makeChat()
    const second = assemble(cwd2, { im: { channel: 'auto', channelId: 'feishu', p2pOnly: true } }, { chatInteraction: chat2.layer })
    const refused = await second.fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    assert.equal(refused.isError, true, runText(refused))
    const text = runText(refused)
    assert.ok(text.includes('refused:no-target'), text)
    assert.ok(text.includes('im.approvalChatId'), text)
    assert.equal(chat2.asks.length, 0, '没有任何可证明的目标时不得发卡片')
    assert.equal(ledgerOf(cwd2).at(-1)?.decision, refusalOf('no-target'))
})

test('TC-901/TC-907 显式目标不再依赖 active chat：不先私聊 bot，卡片也能发到配置的目标', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice'])
    const chat = makeChat()
    // A fresh deployment: the bot has never received a message, so the plugin
    // has no active chat to resolve. An explicit target makes that irrelevant
    // (upstream `resolve()` returns the given chatId).
    ;(chat.layer.api as Record<string, unknown>)['authState'] = () => ({
        ok: true,
        mode: 'auto',
        allowlist: [],
        activeChat: '',
        p2pChat: '',
        listenerRole: '',
        listenerConnected: true,
        pendingQuestions: [],
    })
    const { fake } = assemble(cwd, TARGET_CONFIG, { chatInteraction: chat.layer })
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await waitFor(() => chat.asks.length === 1, '显式目标下不应再要求先建立 active chat')
    assert.equal((chat.asks[0] as Record<string, any>).chatId, APPROVAL_CHAT)
    chat.settle({
        ok: true,
        value: {
            value: 'allowed-once',
            text: 'allowed-once',
            messageId: 'om_1',
            by: 'ou_alice',
            chatId: APPROVAL_CHAT,
            chatKind: 'p2p',
            via: 'click',
            at: Date.now(),
        },
    })
    assert.equal((await running).isError, false, '目标明确时不需要 inbound 消息当"会话入口"')
})

test('TC-901 显式目标必须与 channel 同行：渠道名不可知时拒绝发送（否则上游静默忽略 chatId）', async () => {
    const cwd = tempWorkspace('interaction-p0-')
    writeApprovers(cwd, ['ou_alice'])
    const chat = makeChat()
    // A "partial but v1" api: no channel discovery, and the profile pins no
    // channel. The installed upstream only honours `chatId` when `channel` is
    // passed with it (`resolve()`), so sending chatId alone would silently fall
    // back to the active chat — the very hole P0 closes.
    delete (chat.layer.api as Record<string, unknown>)['channels']
    delete (chat.layer.api as Record<string, unknown>)['capabilities']
    const { fake } = assemble(cwd, { im: { channel: 'auto', approvalChatId: APPROVAL_CHAT } }, { chatInteraction: chat.layer })
    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    assert.equal(run.isError, true, runText(run))
    const text = runText(run)
    assert.ok(text.includes('refused:send-failed'), text)
    assert.ok(text.includes('im.channelId'), `拒绝要给出可执行的修复：${text}`)
    assert.equal(chat.asks.length, 0, '渠道名不可知时绝不能把 chatId 单独发出去')
    assert.equal(ledgerOf(cwd).filter((row) => row.decision === 'allowed-once').length, 0)
})

test('TC-901/903 配置：不可用的 approvalChatId 报告问题并 fail closed；p2pOnly 不可用则保持严格默认', () => {
    const problems: string[] = []
    const resolved = resolveConfig({ im: { approvalChatId: 42, p2pOnly: 'yes' } }, (message) => problems.push(message))
    assert.equal(resolved.im.approvalChatId, '', '不可用的目标不会被静默当成"没配置"而放行')
    assert.notEqual(resolved.im.approvalChatIdProblem, undefined)
    assert.equal(resolved.im.p2pOnly, true, '不可用的 p2pOnly 保持 fail-closed 的默认值')
    assert.equal(resolved.im.p2pOnlyConfigured, false)
    assert.equal(problems.length, 2, problems.join('\n'))

    // The plan refuses an unusable target — the ask never degrades to "the IM
    // plugin picks the chat".
    const approvers = { file: '.dsh/interaction-approvers.txt', present: true, ids: ['ou_alice'], problems: [] }
    const plan = imAskTargetOf(resolved, approvers)
    assert.equal(plan.ok, false)
    assert.equal(plan.ok ? '' : plan.reason, 'bad-target')

    // Whitespace inside a pasted id is unusable too (it matches no chat).
    const broken = resolveConfig({ im: { approvalChatId: 'oc_a b' } }, () => undefined)
    assert.notEqual(broken.im.approvalChatIdProblem, undefined)

    // Defaults: no target, p2pOnly on, but NOT "explicitly configured" — so the
    // go-live guard stays out of the way of every existing deployment.
    const defaults = resolveConfig({})
    assert.equal(defaults.im.approvalChatId, '')
    assert.equal(defaults.im.p2pOnly, true)
    assert.equal(defaults.im.p2pOnlyConfigured, false)
    assert.equal(imAskTargetOf(defaults, approvers).ok, true)
    // A configured target with no whitelist has no plan (AC-003).
    const configured = resolveConfig({ im: { approvalChatId: APPROVAL_CHAT } })
    const empty = imAskTargetOf(configured, { file: 'x', present: false, ids: [], problems: [] })
    assert.equal(empty.ok ? '' : empty.reason, 'no-allowlist')
    const ready = imAskTargetOf(configured, approvers)
    assert.deepEqual(ready.ok ? ready.target : undefined, { chatId: APPROVAL_CHAT, from: ['ou_alice'], p2pOnly: true })
})

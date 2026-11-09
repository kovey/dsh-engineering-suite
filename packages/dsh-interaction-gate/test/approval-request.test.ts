/**
 * dsh-interaction-gate — stage P1: the HOST's approval seam, answered over IM.
 *
 * What this file is a claim about: `ctx.waterfall('approval/request', …)` — the
 * seam `@deepseek-ai/dsh-user-approval` dispatches (0.2.2-rc.1
 * `lib/index.js`: every answerer in registration order, a returned value
 * short-circuits, `next()` delegates, the host's own last step resolves
 * `'unavailable'`). The chain here is the FAKE host's `waterfall` (its order,
 * its `next()`, its base decision) — not a re-implementation — with one honest
 * correction: the fake's `on()` ignores listener options, while cordis's real
 * `ctx.on(name, cb, { prepend: true })` UNSHIFTS. The wrapper in `assemble()`
 * records the options and restores that order, so "we run first" is exercised
 * instead of assumed.
 *
 * The scripted channel stands in for the IM adapter (it registers under
 * `CHAT_CHANNEL_NAME`, which is the channel the answerer pins). What the adapter
 * puts on the wire (`chatId`/`from`, the P0 payload) is TC-901's job in
 * `im-approval-target.test.ts`; here the question is what an ANSWER over IM does
 * to a host approval request.
 *
 * Acceptance cases: TC-911…TC-917 of the approved specification
 * (`p1-approval-request-approval-spe-20261109-104120`). TC-918 is the
 * verification run itself (`bash scripts/verify.sh --quiet`, twice, exit 0).
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeAgent, type FakeHost } from 'dsh-eng-core/testing'
import { apply, resolveConfig } from '../dist/index.js'
import { APPROVAL_SOURCE, refusalOf } from '../dist/ledger.js'
import { APPROVAL_OPTIONS, approvalQuestionOf } from '../dist/approval.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const OUTBOX = '.dsh/interaction/outbox.jsonl'
const APPROVERS = '.dsh/interaction-approvers.txt'
const LOG = 'interaction-gate.log'

/** The one conversation approvals may go to. */
const APPROVAL_CHAT = 'oc_approvals'
/** The person the approver list names. */
const ALICE = 'ou_alice'
/** Somebody who may not answer. */
const MALLORY = 'ou_mallory'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

function writeApprovers(cwd: string, ids: string[]): void {
    const file = path.join(cwd, APPROVERS)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# approvers\n${ids.join('\n')}\n`, 'utf8')
}

function rowsOf(file: string): Record<string, any>[] {
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, any>)
}

const ledgerOf = (cwd: string): Record<string, any>[] => rowsOf(path.join(cwd, LEDGER))
const outboxOf = (cwd: string): Record<string, any>[] => rowsOf(path.join(cwd, OUTBOX))

/** A scripted channel: the stand-in for the IM adapter. */
interface Scripted {
    name: string
    sent: Record<string, any>[]
    /** Resolve the pending `wait` with an answer (P0 provenance included). */
    answer: (value: string, options?: { by?: string; messageId?: string; chatId?: string; chatKind?: 'p2p' | 'group' }) => Promise<void>
    /** How many `wait` calls the engine made. */
    waits: () => number
}

function scriptedChannel(name: string, options: { waitMode?: 'null' | 'never' } = {}): Scripted & { channel: any } {
    const sent: Record<string, any>[] = []
    let waiter: ((value: unknown) => void) | undefined
    let waits = 0
    const channel: any = {
        name,
        // The conversation the channel sends into (the outbox serializes it).
        chatId: APPROVAL_CHAT,
        async send(message: Record<string, any>) {
            sent.push(message)
            return { ok: true, messageId: `m-${name}-${sent.length}` }
        },
        async wait(): Promise<unknown> {
            waits += 1
            if (options.waitMode === 'null') return null
            return await new Promise((resolve) => {
                waiter = resolve
            })
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    }
    return {
        name,
        sent,
        channel,
        waits: () => waits,
        async answer(value, answerOptions = {}) {
            await waitFor(() => waiter !== undefined, `${name} 没有进入等待状态`)
            waiter?.({
                value,
                by: answerOptions.by ?? ALICE,
                messageId: answerOptions.messageId ?? 'om_answer_1',
                chatId: answerOptions.chatId ?? APPROVAL_CHAT,
                chatKind: answerOptions.chatKind ?? 'p2p',
            })
        },
    }
}

/** One `approval/request` payload, shaped like the host's `ApprovalRequestEvent`. */
function approvalRequest(agent: FakeAgent, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        agent,
        toolName: 'bash',
        callId: 'call-7',
        reason: '需要写入 .dsh/state 下的运行时文件',
        displayReason: { en: 'write a runtime file', zh: '需要写入运行时文件' },
        ...extra,
    }
}

interface Assembled {
    fake: FakeHost
    registry: any
    /** Every `ctx.on(...)` the plugin made, with the options it passed. */
    registrations: { event: string; options?: { prepend?: boolean } }[]
    /** Register an answerer BEHIND ours — the host's pre-existing one (the TUI). */
    behind: (outcome: string) => { calls: () => number; outcomes: string[] }
}

/**
 * Assemble the plugin through the real `apply`.
 *
 * The `on` wrapper is the one piece of host emulation this file owns: the fake
 * appends every listener, so the real `{ prepend: true }` order has to be put
 * back. Everything else (chain execution, `next()`, the base decision) is the
 * fake host's `waterfall`.
 */
function assemble(cwd: string, config: Record<string, unknown>, channel?: Scripted & { channel: any }): Assembled {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    const registrations: { event: string; options?: { prepend?: boolean } }[] = []
    const rawOn = (fake.ctx as { on: (event: string, listener: (...args: never[]) => unknown) => () => void }).on.bind(fake.ctx)
    ;(fake.ctx as Record<string, unknown>)['on'] = (
        event: string,
        listener: (...args: never[]) => unknown,
        options?: { prepend?: boolean },
    ): (() => void) => {
        registrations.push({ event, ...(options === undefined ? {} : { options }) })
        const dispose = rawOn(event, listener)
        if (options?.prepend === true) {
            const bucket = fake.listeners.get(event)
            if (bucket !== undefined) {
                const index = bucket.indexOf(listener)
                if (index > 0) {
                    bucket.splice(index, 1)
                    bucket.unshift(listener)
                }
            }
        }
        return dispose
    }
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG), ...config })
    const registry = (fake.ctx as { get: (name: string) => unknown }).get('interaction')
    if (channel !== undefined) {
        const dispose = registry.register(channel.channel)
        fake.effects.push(dispose)
    }
    return {
        fake,
        registry,
        registrations,
        behind(outcome: string) {
            const outcomes: string[] = []
            rawOn('approval/request', (() => {
                outcomes.push(outcome)
                return outcome
            }) as never)
            return { calls: () => outcomes.length, outcomes }
        },
    }
}

const TARGET = (via: 'off' | 'fallback' | 'only', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    askTimeoutMs: 1_000,
    im: { approvalVia: via, approvalChatId: APPROVAL_CHAT, ...extra },
})

test('TC-911 fallback：名单内的人回答 allowed-once → 应答者返回 allowed-once，台账出现 source=approval-request 的行（含 by/chatId/messageId）', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    const channel = scriptedChannel('chat-interaction')
    const first = assemble(cwd, TARGET('fallback'), channel)
    const { fake, registrations, behind } = first
    // The host's pre-existing answerer, registered AFTER us = behind us in the
    // chain (the fake appends; ours was prepended).
    const tui = behind('rejected')

    // AC-001: registered with `prepend: true`, on the right event.
    const registered = registrations.find((entry) => entry.event === 'approval/request')
    assert.notEqual(registered, undefined, 'approvalVia=fallback 必须注册 approval/request 应答者')
    assert.equal(registered?.options?.prepend, true, '必须用 { prepend: true } 注册：否则只能排在终端应答者之后，永远轮不到')

    const running = fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    await waitFor(() => channel.sent.length === 1, '审批提问没有交给 IM 通道')
    // The card is built from what the request actually carries (tool/call/reason).
    const card = channel.sent[0] as Record<string, any>
    assert.ok(String(card.title).includes('bash'), `卡片标题要说明是哪个工具：${card.title}`)
    assert.ok(String(card.body).includes('需要写入运行时文件'), `卡片正文要说明原因：${card.body}`)
    assert.ok(String(card.body).includes('allowed-once'), '卡片必须声明选项')
    assert.deepEqual(
        (card.buttons ?? []).map((button: { value: string }) => button.value),
        [...APPROVAL_OPTIONS],
        '卡片按钮只允许两个决定：放行一次 / 拒绝',
    )
    // P0 travels with the card: the target and the whitelist.
    assert.equal(card.im?.chatId, APPROVAL_CHAT, '审批卡必须带 P0 的显式目标会话')
    assert.deepEqual(card.im?.from, [ALICE], '审批卡必须带 P0 的 from 白名单')

    await channel.answer('allowed-once', { messageId: 'om_card_911' })
    assert.equal(await running, 'allowed-once', '名单内的人回答 allowed-once → 宿主四词之一 allowed-once')
    assert.equal(tui.calls(), 0, 'IM 已经答了，不应再问原通道（不双问）')

    const rows = ledgerOf(cwd)
    const decided = rows.filter((row) => row.decision === 'allowed-once')
    assert.equal(decided.length, 1, `台账必须有一条决定行：${JSON.stringify(rows)}`)
    assert.equal(decided[0]?.source, APPROVAL_SOURCE, '决定行必须可区分（source=approval-request）')
    assert.equal(decided[0]?.userId, ALICE, '决定行必须写明是谁答的')
    assert.equal(decided[0]?.chatId, APPROVAL_CHAT, '决定行必须记下答案来自哪个会话')
    assert.equal(decided[0]?.messageId, 'om_card_911', '决定行必须记下是哪条消息')
    // …and an `ask` row was written BEFORE the answer (the audit trail of asking).
    assert.equal(rows[0]?.decision, undefined, '第一行是 pending（提问已发出，还没人答）')
    assert.equal(rows[0]?.source, APPROVAL_SOURCE, 'pending 行同样可区分')
    // The outbox recorded the decision too (it never grants anything itself).
    assert.equal(outboxOf(cwd).some((row) => row.state === 'answered'), true)
    // The doctor reports the mode AND the rows, so "a gate was decided over IM"
    // is a fact an operator can read without grepping the ledger.
    const status = runText(await first.fake.runTool('interaction_status', {}))
    assert.ok(status.includes('IM 审批应答者（approval/request）：fallback'), status)
    assert.ok(status.includes(`审批接缝台账行（source=${APPROVAL_SOURCE}）：2 行（已决定 1，拒答 0`), status)
})

test('TC-912 fallback：回答 rejected → rejected；请求信号 abort → cancelled（各自落账）', async () => {
    // --- (a) a human says no ---------------------------------------------------
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    const rejected = scriptedChannel('chat-interaction')
    const first = assemble(cwd, TARGET('fallback'), rejected)
    const runningReject = first.fake.waterfall('approval/request', approvalRequest(first.fake.agent), () => 'unavailable')
    await waitFor(() => rejected.sent.length === 1, '审批提问没有发出去')
    await rejected.answer('rejected', { messageId: 'om_card_912a' })
    assert.equal(await runningReject, 'rejected', '回答 rejected → 宿主四词之一 rejected')
    assert.equal(ledgerOf(cwd).filter((row) => row.decision === 'rejected').length, 1)

    // --- (b) the request is withdrawn while we wait ----------------------------
    const cwd2 = tempWorkspace('interaction-p1-')
    writeApprovers(cwd2, [ALICE])
    const cancelled = scriptedChannel('chat-interaction', { waitMode: 'never' })
    const second = assemble(cwd2, TARGET('fallback'), cancelled)
    const controller = new AbortController()
    const runningAbort = second.fake.waterfall(
        'approval/request',
        approvalRequest(second.fake.agent, { signal: controller.signal }),
        () => 'unavailable',
    )
    await waitFor(() => cancelled.waits() > 0, '审批提问没有进入等待')
    controller.abort()
    assert.equal(await runningAbort, 'cancelled', '请求信号 abort → cancelled（撤回不是拒绝）')
    const rows = ledgerOf(cwd2)
    assert.equal(rows.at(-1)?.decision, refusalOf('cancelled'), `取消必须落成 refused:cancelled：${JSON.stringify(rows)}`)
    assert.equal(rows.some((row) => row.decision === 'rejected'), false, '取消绝不能被记成拒绝')
})

test('TC-913 fallback 但 IM 未注册：调用 next() 落回原通道，返回值来自下层（不是 unavailable），且一张卡都没发', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    // No channel at all: the answerer cannot even ask.
    const { fake, behind } = assemble(cwd, TARGET('fallback'))
    const tui = behind('rejected')

    const outcome = await fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    assert.equal(outcome, 'rejected', 'fallback：问不了就 next()，返回值必须来自下层（这里下层答 rejected）')
    assert.equal(tui.calls(), 1, '下层应答者必须被问到（正好一次）')

    // Nothing was asked, so nothing in the ledger can be read as a decision.
    const rows = ledgerOf(cwd)
    assert.equal(rows.some((row) => row.decision === 'allowed-once' || row.decision === 'rejected'), false, rows.length === 0 ? '' : JSON.stringify(rows))
    assert.equal(rows.at(-1)?.decision, refusalOf('channel-unusable'), `拒绝原因要写明"问不了"：${JSON.stringify(rows)}`)
    assert.equal(outboxOf(cwd).length, 0, '连意图行都不该有：一张卡片都没发出去')

    // The other two "cannot even start" shapes, same rule: no card, delegate.
    // (a) a target with no approver list — there is no `from` whitelist to send.
    const bare = tempWorkspace('interaction-p1-')
    const noList = assemble(bare, TARGET('fallback'))
    const tui2 = noList.behind('allowed-once')
    assert.equal(await noList.fake.waterfall('approval/request', approvalRequest(noList.fake.agent), () => 'unavailable'), 'allowed-once')
    assert.equal(tui2.calls(), 1)
    assert.equal(ledgerOf(bare).at(-1)?.decision, refusalOf('no-allowlist'), JSON.stringify(ledgerOf(bare)))
    assert.equal(outboxOf(bare).length, 0)
    // (b) no approval target at all: an approval card must not go to "whoever
    // DM'd the bot", and `requireAllowlist` still needs a list to check.
    const untargeted = tempWorkspace('interaction-p1-')
    const loose = assemble(untargeted, { askTimeoutMs: 1_000, im: { approvalVia: 'fallback' } })
    const tui3 = loose.behind('rejected')
    assert.equal(await loose.fake.waterfall('approval/request', approvalRequest(loose.fake.agent), () => 'unavailable'), 'rejected')
    assert.equal(tui3.calls(), 1)
    assert.equal(ledgerOf(untargeted).at(-1)?.decision, refusalOf('approvers-missing'), JSON.stringify(ledgerOf(untargeted)))
    assert.equal(outboxOf(untargeted).length, 0)
})

test('TC-914 approvalVia=only 且 IM 未注册：直接返回 unavailable，且不调用 next()', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    const { fake, registrations, behind } = assemble(cwd, TARGET('only'))
    const tui = behind('allowed-once')

    assert.equal(registrations.find((entry) => entry.event === 'approval/request')?.options?.prepend, true, 'only 同样要 prepend')
    const outcome = await fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    assert.equal(outcome, 'unavailable', 'only：问不了就是 unavailable（不是下层应答者的 allowed-once）')
    assert.equal(tui.calls(), 0, 'only 绝不落回原通道')
    assert.equal(ledgerOf(cwd).some((row) => row.decision === 'allowed-once'), false)
})

test('TC-915 名单外的人回答：返回 unavailable（不是决定），台账记 refused 且没有决定行', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    const channel = scriptedChannel('chat-interaction')
    const { fake } = assemble(cwd, TARGET('fallback'), channel)

    const running = fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    await waitFor(() => channel.sent.length === 1, '审批提问没有发出去')
    // The right chat, a proven p2p chat, an option that exists — but not a named
    // approver. An approval is a permission: the list decides, not the channel.
    await channel.answer('allowed-once', { by: MALLORY, messageId: 'om_card_915' })
    assert.equal(await running, 'unavailable', '名单外的人的回答不产生决定：unavailable，绝不是 allowed-once，也不是 rejected')

    const rows = ledgerOf(cwd)
    const refused = rows.filter((row) => row.decision === refusalOf('unauthorized'))
    assert.equal(refused.length, 1, `必须记一条 refused:unauthorized：${JSON.stringify(rows)}`)
    assert.equal(refused[0]?.userId, MALLORY, '拒答里要写明是谁试图回答')
    assert.equal(refused[0]?.source, APPROVAL_SOURCE)
    assert.equal(rows.some((row) => row.decision === 'allowed-once'), false, '越权的回答绝不能变成放行')
})

test('TC-916 无人回答直到超时：返回 unavailable，绝不返回 rejected', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    // A channel whose own deadline expires immediately: the engine keeps pulling
    // until its own deadline, then records a timeout (no real 1 s sleep needed).
    const channel = scriptedChannel('chat-interaction', { waitMode: 'null' })
    const { fake, behind } = assemble(cwd, TARGET('fallback'), channel)
    const tui = behind('rejected')

    const outcome = await fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    assert.equal(outcome, 'unavailable', '超时 = 没有人决定 = unavailable')
    assert.notEqual(outcome, 'rejected', '超时绝不是拒绝：那是替人说"不"')
    assert.equal(tui.calls(), 0, '卡片已经发出去了，就不能再问第二个人（不双问）')

    const rows = ledgerOf(cwd)
    assert.equal(rows.at(-1)?.decision, refusalOf('timeout'), `必须落成 refused:timeout：${JSON.stringify(rows)}`)
    assert.equal(rows.some((row) => row.decision === 'rejected'), false)
})

test('TC-917 approvalVia=off（默认）：不注册任何监听器，请求落到原有应答者；不可用的值按 off 处理并报告', async () => {
    const cwd = tempWorkspace('interaction-p1-')
    writeApprovers(cwd, [ALICE])
    const channel = scriptedChannel('chat-interaction')
    const { fake, registrations, behind } = assemble(cwd, TARGET('off'), channel)
    const tui = behind('rejected')

    assert.equal(
        registrations.some((entry) => entry.event === 'approval/request'),
        false,
        'off 必须一个 approval/request 监听器都不注册（零行为变化）',
    )
    const outcome = await fake.waterfall('approval/request', approvalRequest(fake.agent), () => 'unavailable')
    assert.equal(outcome, 'rejected', 'off：请求照旧落到原有应答者')
    assert.equal(tui.calls(), 1)
    assert.equal(channel.sent.length, 0, 'off 绝不碰 IM 通道')
    assert.equal(ledgerOf(cwd).length, 0, 'off 不写任何台账行')
    assert.equal(outboxOf(cwd).length, 0)

    // The default is `off`, and an unusable value is reported and stays `off`
    // (never coerced upward: this key decides who may grant a permission).
    assert.equal(resolveConfig({}).im.approvalVia, 'off')
    const problems: string[] = []
    const resolved = resolveConfig({ im: { approvalVia: 'always' } }, (message) => problems.push(message))
    assert.equal(resolved.im.approvalVia, 'off', '不可用的 approvalVia 按 off 处理，绝不升格成 fallback/only')
    assert.notEqual(resolved.im.approvalViaProblem, undefined)
    assert.equal(problems.length, 1, problems.join('\n'))
    // A valid value is taken as declared.
    assert.equal(resolveConfig({ im: { approvalVia: 'only' } }).im.approvalVia, 'only')

    // The doctor says which of the two states it is in (未注册 vs 已注册)…
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('IM 审批应答者（approval/request）：off'), status)
    // …and the card text itself is a pure function of the request (no guessing).
    const built = approvalQuestionOf({ toolName: 'bash', reason: '' })
    assert.ok(built.question.includes('发起方没有给出原因'), '没有原因时必须如实说，不要编一个')
    assert.ok(built.question.includes('工具 bash'), built.question)
})

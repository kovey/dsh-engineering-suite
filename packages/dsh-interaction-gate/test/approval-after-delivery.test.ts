/**
 * A delivered mission must not void an APPROVAL, while a withdrawn mandate must.
 *
 * The contradiction this pins (found in a real deployment):
 *   - `deploy_verify` asks a person to approve the verification, and the deploy
 *     go/no-go requires the mission to be DELIVERED first — so that approval
 *     necessarily exists after delivery;
 *   - attention treated `delivered` as "ended" and superseded every open
 *     question of the mission, so the card was voided the instant it was sent and
 *     the click came back as `refused:superseded`.
 * Neither rule is wrong on its own; together they made verification impossible.
 *
 * The fix distinguishes WHERE the question came from (`LedgerRow.source`) and HOW
 * the mission ended (`endedBy`): a delivered mission leaves approvals open (it
 * still needs decisions), a withdrawn mandate voids everything (the work was
 * stopped by a person).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { appendLedgerRow } from '../dist/ledger.js'
import { createAttentionSource, missionFactsOf, staleOf } from '../dist/attention.js'
import { createFakeHost, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const APPROVAL_CHAT = 'oc_approvals'
const ALICE = 'ou_alice'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A minimal scripted channel: records cards, answers when the test says so. */
function scriptedChannelOf(name: string): {
    name: string
    channel: Record<string, unknown>
    waits: () => number
    answer: (value: string, by: string, chatId: string) => void
} {
    let waiter: ((value: unknown) => void) | undefined
    let waits = 0
    const channel: Record<string, unknown> = {
        name,
        chatId: APPROVAL_CHAT,
        async send(): Promise<unknown> {
            return { ok: true, messageId: 'm-1' }
        },
        async wait(): Promise<unknown> {
            waits += 1
            return await new Promise((resolve) => {
                waiter = resolve
            })
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    }
    return {
        name,
        channel,
        waits: () => waits,
        answer(value: string, by: string, chatId: string): void {
            assert.ok(waiter !== undefined, '通道没有进入等待状态')
            waiter?.({ value, by, messageId: 'om_answer_1', chatId, chatKind: 'p2p' })
        },
    }
}

const ATTENTION = '.dsh/interaction/attention.jsonl'

function sourceOver(
    cwd: string,
    clock: { at: number },
    options: { mission?: (id: string) => unknown } = {},
): ReturnType<typeof createAttentionSource> {
    return createAttentionSource({
        file: path.join(cwd, ATTENTION),
        ledgerFile: path.join(cwd, LEDGER),
        now: () => clock.at,
        defaultWindowMs: 900_000,
        maxAgeMs: 24 * 60 * 60 * 1_000,
        ...(options.mission === undefined ? {} : { mission: options.mission }),
    })
}

/** One pending ask row; `source` is what distinguishes an approval from a question. */
function askRow(
    file: string,
    input: { at: number; questionId: string; missionId?: string; source?: string },
): void {
    appendLedgerRow(file, {
        at: input.at,
        id: `ask-${input.questionId}`,
        kind: 'ask',
        title: `问题 ${input.questionId}`,
        questionId: input.questionId,
        channel: 'im',
        ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
        ...(input.source === undefined ? {} : { source: input.source }),
    })
}

function quietSource(cwd: string, clock: { at: number }, store: unknown): ReturnType<typeof createAttentionSource> {
    // `store` must be a MissionStore (not the registry): passing the registry made
    // every lookup throw, `syncMission` returned early, and the tests that
    // expected "nothing was superseded" passed vacuously.
    return sourceOver(cwd, clock, { mission: (id) => missionFactsOf(store as never, id) })
}

test('TC-1021 a delivered mission leaves an approval open (deploy verify lives here)', () => {
    const cwd = tempWorkspace('approval-after-delivery-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '已交付', cwd, id: 'M-1' })
    store.setStatus('M-1', 'delivered')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-approval', missionId: 'M-1', source: 'approval-request' })

    const clock = { at: 2_000 }
    const source = quietSource(cwd, clock, new MissionStoreRegistry().for(cwd))
    const attentions = source.attentions()
    assert.equal(attentions.length, 1, '审批提问必须仍然是一个待决项')
    assert.equal(attentions[0]?.source, 'approval-request')
    assert.equal(attentions[0]?.stale, undefined, '交付不是"作废审批"的理由')
})

test('TC-1022 syncMission on a delivered mission does NOT supersede the approval row', () => {
    const cwd = tempWorkspace('approval-after-delivery-sync-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '已交付', cwd, id: 'M-2' })
    store.setStatus('M-2', 'delivered')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-approval', missionId: 'M-2', source: 'approval-request' })

    const clock = { at: 2_000 }
    const source = quietSource(cwd, clock, stores.for(cwd))
    const synced = source.syncMission('M-2')
    assert.equal(synced.superseded, 0, '交付不得作废审批')
    assert.equal(source.attentions().length, 1, '提问仍然待决')
    const closures = fs.existsSync(path.join(cwd, ATTENTION))
        ? fs.readFileSync(path.join(cwd, ATTENTION), 'utf8').split('\n').filter((line) => line.includes('superseded'))
        : []
    assert.equal(closures.length, 0, '不得写下任何 mission 级作废行')
})

test('TC-1023 a delivered mission still supersedes a model question (interaction_ask)', () => {
    const cwd = tempWorkspace('approval-after-delivery-ask-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '已交付', cwd, id: 'M-3' })
    store.setStatus('M-3', 'delivered')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-ask', missionId: 'M-3' })

    const clock = { at: 2_000 }
    const facts = missionFactsOf(stores.for(cwd), 'M-3')
    assert.equal(facts?.ended, true, `facts=${JSON.stringify(facts)}`)
    assert.equal(facts?.endedBy, 'delivered', `facts=${JSON.stringify(facts)}`)
    const source = quietSource(cwd, clock, stores.for(cwd))
    const synced = source.syncMission('M-3')
    assert.equal(source.records().length, 1, `records=${JSON.stringify(source.records())}`)
    assert.equal(synced.superseded, 1, `record=${JSON.stringify(source.records()[0])}`)
    assert.equal(source.attentions().length, 0)
})

test('TC-1024 a WITHDRAWN end still voids the approval (the exemption is scoped to delivery)', () => {
    const cwd = tempWorkspace('approval-after-delivery-withdrawn-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '被停止的任务', cwd, id: 'M-4' })
    store.setStatus('M-4', 'blocked')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-approval', missionId: 'M-4', source: 'approval-request' })

    const clock = { at: 2_000 }
    const source = quietSource(cwd, clock, store)
    // `endedBy: 'withdrawn'` is the branch a person's `orchestrate stop` produces:
    // the work itself was stopped, so a pending deploy approval must NOT survive
    // (letting it be answered would authorise an action on a mission that ended).
    const closed = source.supersede({ missionId: 'M-4', endedBy: 'withdrawn', reason: '授权已被 operator 撤回' })
    assert.equal(closed, 1, '撤回后连审批也必须作废')
    assert.equal(source.attentions().length, 0)
})

test('TC-1026 a blocked mission that is NOT withdrawn neither pauses nor voids', () => {
    const cwd = tempWorkspace('approval-after-delivery-blocked-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '熔断中', cwd, id: 'M-5' })
    store.setStatus('M-5', 'blocked')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    askRow(path.join(cwd, LEDGER), { at: 1_000, questionId: 'q-approval', missionId: 'M-5', source: 'approval-request' })

    const clock = { at: 2_000 }
    const source = quietSource(cwd, clock, stores.for(cwd))
    const synced = source.syncMission('M-5')
    assert.equal(synced.superseded, 0)
    assert.equal(source.attentions().length, 1)
})

test('TC-1027 staleOf: the exemption is scoped to approval rows of a DELIVERED mission', () => {
    const delivered = { id: 'M-6', status: 'delivered', ended: true, endedBy: 'delivered' as const, endedReason: '已交付' }
    const withdrawn = { id: 'M-7', status: 'blocked', ended: true, endedBy: 'withdrawn' as const, endedReason: '已撤回' }
    const base = { askedAt: 0, ageMs: 1_000, maxAgeMs: 900_000 }

    assert.equal(staleOf({ ...base, mission: delivered, source: 'approval-request' }), undefined)
    assert.equal(staleOf({ ...base, mission: delivered, source: 'interaction_ask' })?.reason, 'mission-ended')
    assert.equal(staleOf({ ...base, mission: delivered })?.reason, 'mission-ended', '没有来源的行沿用旧规则')
    assert.equal(staleOf({ ...base, mission: withdrawn, source: 'approval-request' })?.reason, 'mission-ended')
})

test('TC-1028 end-to-end: the reported timeline — delivered mission, IM approval, human answer ACCEPTED', async () => {
    // This is the exact sequence from the deployment that could not finish:
    //   the mission is DELIVERED (deploy requires it), the approval question goes
    //   out over IM, the whitelisted approver clicks 27 seconds later — and the
    //   answer used to come back as `refused:superseded`. Now it must decide.
    const cwd = tempWorkspace('approval-after-delivery-e2e-')
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ title: '已交付', cwd, id: 'M-8' })
    store.setStatus('M-8', 'delivered')

    const fake = createFakeHost({ cwd })
    const channel = scriptedChannelOf('chat-interaction')
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'interaction-gate.log'),
        askTimeoutMs: 2_000,
        im: {
            approvalVia: 'fallback',
            approvalChatId: APPROVAL_CHAT,
            approvers: [ALICE],
            approversFile: path.join(cwd, 'no-such-approvers.txt'),
        },
    })
    const registry = (fake.ctx as { get: (name: string) => unknown }).get('interaction') as { register: (c: unknown) => () => void }
    fake.effects.push(registry.register(channel.channel))

    // The session is bound to the delivered mission, so the ask row carries it —
    // exactly how the reported row got its `missionId`.
    store.bindSession(fake.agent.session.header.id, 'M-8')

    const running = fake.waterfall('approval/request', { agent: fake.agent, toolName: 'deploy_run', callId: 'c-1', reason: '批准部署' }, () => 'unavailable')
    for (let index = 0; index < 1_000 && channel.waits() < 1; index += 1) await sleep(1)
    assert.ok(channel.waits() >= 1, '审批提问必须发出去')
    channel.answer('allowed-once', ALICE, APPROVAL_CHAT)

    const outcome = await running
    assert.equal(outcome, 'allowed-once', '交付之后的审批回答必须被接受，不能是 refused:superseded')

    // And the refusal that used to poison it must not be in the ledger at all.
    const ledger = fs.readFileSync(path.join(cwd, LEDGER), 'utf8')
    assert.equal(ledger.includes('refused:superseded'), false, ledger)
    assert.equal(ledger.includes('approval-request'), true, '这一行必须标明来源，豁免规则才看得见它')
})

test('TC-1029 an OLD mission-wide supersede row must not close questions asked later', async () => {
    // The reported ledger, verbatim: a mission-wide row written at 01:44:40.223
    // while the first approval (asked 30ms earlier) was open — and then approvals
    // asked at 02:40 and 02:44 came back `refused:superseded` too, because
    // `closureOf` matched the mission without ever looking at the timestamps.
    const cwd = tempWorkspace('approval-after-delivery-oldrow-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ title: '已交付', cwd, id: 'M-10' })
    store.setStatus('M-10', 'delivered')
    fs.mkdirSync(path.join(cwd, '.dsh', 'interaction'), { recursive: true })
    const ledger = path.join(cwd, LEDGER)
    const attention = path.join(cwd, ATTENTION)

    // (1) the question that existed when the row was written
    askRow(ledger, { at: 1_000, questionId: 'q-first', missionId: 'M-10', source: 'approval-request' })
    // (2) the row itself, 30ms later — the shape the old bug wrote
    fs.writeFileSync(
        attention,
        `${JSON.stringify({ at: 1_030, id: 'ar-old', kind: 'superseded', missionId: 'M-10', reason: 'mission M-10 已交付（delivered）：这道提问已不再有意义' })}\n`,
    )
    // (3) a question asked long after the row (55 minutes later in the real case)
    askRow(ledger, { at: 1_000 + 55 * 60_000, questionId: 'q-later', missionId: 'M-10', source: 'approval-request' })

    const clock = { at: 1_000 + 60 * 60_000 }
    const source = quietSource(cwd, clock, store)
    const records = source.records()
    const first = records.find((record) => record.questionId === 'q-first')
    const later = records.find((record) => record.questionId === 'q-later')
    assert.equal(first?.state, 'superseded', '写下该行时已存在的提问仍然被它关闭（历史语义不变）')
    assert.equal(later?.state, 'open', '后来才问的不受老行影响')
    assert.equal(later?.stale, undefined, '也不该被标成过期')
})

test('TC-1121/1123/1125 ownership: an UN-MAPPED workspace defers to the native surfaces', async () => {
    // desktop / web TUI answer `approval/request` themselves (dsh-api-remotes
    // exposes the waterfall to clients), so a plugin that prepends an answerer for
    // EVERY request hijacks their UI. The takeover is scoped to workspaces routed
    // to IM; everything else must call next().
    const cwd = tempWorkspace('ownership-defer-')
    const cases: { policy: string; mode: string }[] = [
        { policy: 'refuse', mode: 'fallback' },
        { policy: 'local', mode: 'fallback' },
    ]
    for (const entry of cases) {
        const fake = createFakeHost({ cwd: tempWorkspace('ownership-defer-') })
        const channel = scriptedChannelOf('chat-interaction')
        apply(fake.ctx as never, {
            logFile: path.join(cwd, 'log.log'),
            askTimeoutMs: 1_000,
            im: {
                approvalVia: entry.mode,
                approvalChatId: APPROVAL_CHAT,
                approvers: [ALICE],
                approversFile: path.join(cwd, 'no-such.txt'),
                approvals: [{ workspace: '/definitely/elsewhere', chatId: 'oc_other' }],
                unmappedWorkspace: entry.policy,
            },
        })
        const registry = (fake.ctx as { get: (n: string) => unknown }).get('interaction') as { register: (c: unknown) => () => void }
        fake.effects.push(registry.register(channel.channel))

        let delegated = 0
        const outcome = await fake.waterfall(
            'approval/request',
            { agent: fake.agent, toolName: 'deploy_run', callId: 'c-1', reason: '批准部署' },
            () => {
                delegated += 1
                return 'allowed-once'
            },
        )
        assert.equal(outcome, 'allowed-once', `未映射工作区必须交还原生面（policy=${entry.policy}）`)
        assert.equal(delegated, 1, 'next() 必须被调用一次')
        assert.equal(channel.waits(), 0, 'IM 不能问（一张卡都不该发）')
    }
})

test('TC-1121 a MAPPED workspace is owned by IM: it answers and never delegates', async () => {
    const cwd = tempWorkspace('ownership-owned-')
    const fake = createFakeHost({ cwd })
    const channel = scriptedChannelOf('chat-interaction')
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'log.log'),
        askTimeoutMs: 2_000,
        im: {
            approvalVia: 'fallback',
            approvalChatId: APPROVAL_CHAT,
            approvers: [ALICE],
            approversFile: path.join(cwd, 'no-such.txt'),
            approvals: [{ workspace: path.resolve(cwd), chatId: APPROVAL_CHAT, approvers: [ALICE] }],
        },
    })
    const registry = (fake.ctx as { get: (n: string) => unknown }).get('interaction') as { register: (c: unknown) => () => void }
    fake.effects.push(registry.register(channel.channel))

    let delegated = 0
    const running = fake.waterfall(
        'approval/request',
        { agent: fake.agent, toolName: 'deploy_run', callId: 'c-1', reason: '批准部署' },
        () => {
            delegated += 1
            return 'rejected'
        },
    )
    for (let index = 0; index < 1_000 && channel.waits() < 1; index += 1) await sleep(1)
    assert.ok(channel.waits() >= 1, '命中的工作区应当由 IM 提问')
    channel.answer('allowed-once', ALICE, APPROVAL_CHAT)

    assert.equal(await running, 'allowed-once')
    assert.equal(delegated, 0, 'mapped 工作区不该把问题再交给原生面（避免双问）')
})

test('TC-1126 the plugin never squats on the official user-questions seam', () => {
    // `userQuestions.ask()` requires a `callId` that belongs to the official
    // `ask_user_question` tool call (the session log reconstructs it). Using it for
    // our own questions would fabricate a tool call that never happened, so the
    // plugin must not touch that seam at all — instead of pretending we render the
    // client question panel, we say plainly that free-form questions stay on
    // chat-interaction and only APPROVALS use the shared seam.
    // `node --test` runs with the PACKAGE as cwd, so resolve from this file.
    const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src')
    const offenders: string[] = []
    for (const entry of fs.readdirSync(src)) {
        if (!entry.endsWith('.ts')) continue
        const text = fs.readFileSync(path.join(src, entry), 'utf8')
        // Comments may legitimately explain WHY we do not use it.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        if (/\buserQuestions\b/.test(code)) offenders.push(entry)
    }
    assert.deepEqual(offenders, [], `interaction-gate 不得引用官方 userQuestions 接缝：${offenders.join(', ')}`)
})

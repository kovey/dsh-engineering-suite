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
import { tempWorkspace } from 'dsh-eng-core/testing'

const LEDGER = '.dsh/interaction/decisions.jsonl'
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

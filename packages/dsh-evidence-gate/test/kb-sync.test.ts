/**
 * The best-effort knowledge-base refresh after a delivery.
 *
 * The property under test is asymmetric on purpose: the refresh must happen when
 * the service is there (otherwise the index silently rots), and it must NEVER
 * change the delivery verdict when it fails (otherwise a housekeeping concern
 * could cost a mission its receipt). Each case therefore asserts BOTH the line
 * appended to the delivery output and the facts that must not move: the mission
 * status, the receipt file, and the absence of an error.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStoreRegistry,
    gitFingerprint,
    sha256,
    type GateCommandResult,
    type GateScope,
    type GateRecord,
    type MissionStore,
} from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { KNOWLEDGE_BASE_REINDEX_TIMEOUT_MS, deliveryKnowledgeBaseNote } from '../dist/kb-sync.js'

const SESSION = 'session-1'
const GATE_SOURCE = 'dsh-quality-gate'

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Rig {
    fake: FakeHost
    store: MissionStore
    cwd: string
}

/** Mount the plugin in a throwaway workspace, with an optional fake KB service. */
function rig(knowledgeBase?: Record<string, unknown>): Rig {
    const cwd = tempWorkspace('evidence-gate-kb-')
    const services: Record<string, unknown> = knowledgeBase === undefined ? {} : { 'knowledge-base': knowledgeBase }
    const fake = createFakeHost({ cwd, services })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'evidence-gate.log') })
    return { fake, store: new MissionStoreRegistry().for(cwd), cwd }
}

/** Create an approved mission bound to the fake host's session, like spec-gate would. */
function seedMission(store: MissionStore, cwd: string): string {
    const record = store.create({ id: 'M-KB', title: '交付后重建知识库索引', cwd })
    store.bindSession(SESSION, record.id)
    const now = Date.now()
    store.update(record.id, () => ({
        status: 'spec-approved',
        spec: {
            title: record.title,
            background: '交付后自动重建索引',
            requirements: ['R-001 交付后 best-effort 重建知识库'],
            acceptanceCriteria: [{ id: 'AC-002', text: '索引失败不影响回执' }],
            fileBoundaries: ['packages/dsh-evidence-gate/**'],
            negativeConstraints: ['不得让索引失败阻断交付'],
            revision: 1,
            createdAt: now,
            updatedAt: now,
            approvedAt: now,
            approvedBy: 'test',
        },
    }))
    return record.id
}

/** One successful host command result (the shape `store.recordGate` stores). */
function gateResult(): GateCommandResult {
    const output = 'ok'
    return {
        id: 'host-test',
        name: 'host-test',
        command: 'node --test test/*.test.ts',
        required: true,
        exitCode: 0,
        signal: null,
        durationMs: 12,
        timedOut: false,
        output,
        outputDigest: sha256(output),
    }
}

/** The full gate scope, so the delivery checklist can pass it. */
const FULL_SCOPE: GateScope = { selected: ['host-test'], total: 1, full: true }

/** Record evidence and a PASS gate covering it (evidence first, gate second). */
async function readyToDeliver(rig: Rig, missionId: string): Promise<GateRecord> {
    for (const kind of ['command', 'test'] as const) {
        const run = await rig.fake.runTool('evidence_record', {
            missionId,
            kind,
            summary: `${kind} 证据`,
            command: kind === 'test' ? 'node --test test/*.test.ts' : 'pnpm test',
            exitCode: 0,
            output: `${kind} ok`,
        })
        assert.equal(run.isError, false, runText(run))
    }
    await sleep(5)
    return rig.store.recordGate(missionId, {
        source: GATE_SOURCE,
        state: 'PASS',
        reason: '全部命令通过',
        results: [gateResult()],
        fingerprint: gitFingerprint(rig.cwd),
        scope: FULL_SCOPE,
    })
}

const receiptDir = (cwd: string, missionId: string): string => path.join(cwd, '.dsh', 'missions', missionId, 'receipts')

test('TC-1831 a delivered mission refreshes the knowledge base and says what happened', async () => {
    const calls: string[] = []
    const { fake, store, cwd } = rig({
        reindex: (workspace: string) => {
            calls.push(workspace)
            return Promise.resolve({ changeKind: 'created', changed: true, documents: 4, chunks: 7, skipped: 0 })
        },
    })
    const missionId = seedMission(store, cwd)
    await readyToDeliver({ fake, store, cwd }, missionId)

    const run = await fake.runTool('mission_complete', { missionId })
    assert.equal(run.isError, false)
    const text = runText(run)
    assert.match(text, /✅ mission M-KB 已交付/)
    assert.deepEqual(calls, [cwd], 'the refresh must target the delivered workspace')
    assert.match(text, /知识库：索引已更新（7 块）/)
    // The note is the LAST thing in the report: it is a footnote on the delivery,
    // not a line the checklist could be mistaken for.
    assert.equal(text.trimEnd().endsWith('知识库：索引已更新（7 块）'), true, text.slice(-300))
    // …and the delivery itself is untouched.
    assert.equal(store.read(missionId)?.status, 'delivered')
    assert.equal(fs.readdirSync(receiptDir(cwd, missionId)).length, 1)
    // The outcome is in the LOG too (the other half of "附注与日志").
    assert.match(fs.readFileSync(path.join(cwd, 'evidence-gate.log'), 'utf8'), /知识库：索引已更新（7 块）/)
})

test('TC-1833 a throwing reindex still issues the receipt, and the failure is visible', async () => {
    const { fake, store, cwd } = rig({
        reindex: () => Promise.reject(new Error('索引写盘失败：磁盘只读')),
    })
    const missionId = seedMission(store, cwd)
    await readyToDeliver({ fake, store, cwd }, missionId)

    const run = await fake.runTool('mission_complete', { missionId })
    assert.equal(run.isError, false, 'a housekeeping failure must never surface as a tool error')
    const text = runText(run)
    assert.match(text, /✅ mission M-KB 已交付/)
    assert.match(text, /知识库：更新失败：索引写盘失败：磁盘只读/)
    assert.equal(store.read(missionId)?.status, 'delivered', 'the mission state is not changed by the refresh')
    const receipts = store.readReceipts(missionId)
    assert.equal(receipts.length, 1, 'the receipt is still issued')
    assert.equal(fs.existsSync(path.join(receiptDir(cwd, missionId), `${receipts[0]?.id ?? ''}.json`)), true)
    assert.match(fs.readFileSync(path.join(cwd, 'evidence-gate.log'), 'utf8'), /\[warn\].*知识库：更新失败：索引写盘失败：磁盘只读/)
})

test('an unchanged index is reported as unchanged, never as "rebuilt"', async () => {
    const { fake, store, cwd } = rig({
        reindex: () => Promise.resolve({ changeKind: 'unchanged', changed: false, documents: 4, chunks: 7, skipped: 0 }),
    })
    const missionId = seedMission(store, cwd)
    await readyToDeliver({ fake, store, cwd }, missionId)
    const text = runText(await fake.runTool('mission_complete', { missionId }))
    assert.match(text, /知识库：索引未变（7 块）/)
    assert.doesNotMatch(text, /知识库：索引已更新/)
})

test('a host without the knowledge base (or with a service that cannot reindex) delivers silently', async () => {
    // (a) no service at all.
    const absent = rig()
    const first = seedMission(absent.store, absent.cwd)
    await readyToDeliver(absent, first)
    const withoutService = runText(await absent.fake.runTool('mission_complete', { missionId: first }))
    assert.match(withoutService, /✅ mission M-KB 已交付/)
    assert.doesNotMatch(withoutService, /知识库：/, 'nothing to report when there is no knowledge base')
    assert.equal(absent.store.read(first)?.status, 'delivered')

    // (b) a service with the right name but without `reindex` (an older plugin).
    const old = rig({ search: () => ({ hits: [] }) })
    const second = seedMission(old.store, old.cwd)
    await readyToDeliver(old, second)
    const withOldService = runText(await old.fake.runTool('mission_complete', { missionId: second }))
    assert.match(withOldService, /✅ mission M-KB 已交付/)
    assert.doesNotMatch(withOldService, /知识库：/)

    // (c) the project disabled its index: a decision, not a failed rebuild.
    const disabled = rig({ reindex: () => Promise.resolve({ changeKind: 'disabled', changed: false, documents: 0, chunks: 0, skipped: 0 }) })
    const third = seedMission(disabled.store, disabled.cwd)
    await readyToDeliver(disabled, third)
    const disabledText = runText(await disabled.fake.runTool('mission_complete', { missionId: third }))
    assert.match(disabledText, /✅ mission M-KB 已交付/)
    assert.doesNotMatch(disabledText, /知识库：/, 'a disabled index is not a failure and gets no footnote')
})

test('the refresh helper never throws: a broken accessor, a timeout and an odd result all degrade to a note', async () => {
    // A throwing accessor is "no service" (the caller must not crash).
    assert.deepEqual(await deliveryKnowledgeBaseNote({ knowledgeBase: () => { throw new Error('boom') } }, '/tmp'), [])

    // A promise that never settles is cut at the deadline and reported as a timeout.
    const timedOut = await deliveryKnowledgeBaseNote(
        { knowledgeBase: () => ({ reindex: () => new Promise(() => undefined) }), knowledgeBaseTimeoutMs: 10 },
        '/tmp/workspace',
    )
    assert.equal(timedOut.length, 1)
    assert.match(timedOut[0] ?? '', /知识库：更新失败：超时/)
    assert.ok(KNOWLEDGE_BASE_REINDEX_TIMEOUT_MS >= 1_000, 'the production deadline is generous, not a second')

    // A result in an unexpected shape still produces an honest line, not a crash.
    const odd = await deliveryKnowledgeBaseNote({ knowledgeBase: () => ({ reindex: () => 'not-an-object' }) }, '/tmp/workspace')
    assert.deepEqual(odd, ['知识库：索引已更新'])
})

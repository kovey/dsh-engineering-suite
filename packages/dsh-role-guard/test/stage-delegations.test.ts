/**
 * The delegation ledger write (AC-001): a successful `team_delegate` appends a
 * row the write guard and `advance` can compare against, and an unwritable
 * ledger warns instead of failing the delegation.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply as applyRoleGuard } from '../dist/index.js'

const HOST_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'todo_write', 'read_image', 'subagent', 'skill']

/** Assemble role-guard into a 0.2.2-rc.1-style fake host. */
function host(cwd: string) {
    const fake = createFakeHost({ cwd, withSubagents: true, withActivation: true, withAgentPresets: true })
    for (const toolName of HOST_TOOLS) {
        fake.tools.set(toolName, { name: toolName, description: 'stub', parameters: {}, execute: async () => 'ok' })
    }
    applyRoleGuard(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log') })
    return fake
}

/** Put the fake host's session on a mission in the `implement` (developer) stage. */
function missionInImplement(cwd: string): string {
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: 'mission-stage-role', title: 'stage role', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'mission-stage-role', 'implement')
    store.update('mission-stage-role', () => ({ stage: 'implement' }))
    store.writeStageResult('mission-stage-role', {
        stageId: 'implement',
        attempt: 1,
        state: 'entered',
        enteredAt: Date.now(),
        role: 'developer',
    })
    return 'mission-stage-role'
}

/** The delegation rows on disk (raw, so the test asserts the real file). */
function ledgerRows(cwd: string): Record<string, unknown>[] {
    const file = path.join(cwd, '.dsh', 'state', 'delegations.jsonl')
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .trimEnd()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('a successful team_delegate appends one delegation row (TC-1550)', async () => {
    const cwd = tempWorkspace('role-guard-delegations-')
    const missionId = missionInImplement(cwd)
    const fake = host(cwd)

    const run = await fake.runTool('team_delegate', { role: 'developer', task: '实现 AC-001' })
    assert.equal(run.isError, false, String(run.content))

    const rows = ledgerRows(cwd)
    assert.equal(rows.length, 1)
    assert.deepEqual(
        { missionId: rows[0]?.['missionId'], role: rows[0]?.['role'], stage: rows[0]?.['stage'], child: rows[0]?.['childSessionId'] },
        { missionId, role: 'developer', stage: 'implement', child: 'activation-1' },
    )
    assert.equal(typeof rows[0]?.['at'], 'number')
    // The row names the child the tool reported, not a synthetic id.
    assert.match(runText(run), /child session: activation-1/)
})

test('a delegation with no bound mission still succeeds and writes no row', async () => {
    const cwd = tempWorkspace('role-guard-delegations-nomission-')
    const fake = host(cwd)
    const run = await fake.runTool('team_delegate', { role: 'developer', task: '实现 AC-001' })
    assert.equal(run.isError, false, String(run.content))
    assert.deepEqual(ledgerRows(cwd), [])
})

test('an unwritable delegation ledger warns but does not fail the delegation (AC-001)', async () => {
    const cwd = tempWorkspace('role-guard-delegations-fail-')
    missionInImplement(cwd)
    // A directory where the ledger file must be: every append fails (EISDIR).
    fs.mkdirSync(path.join(cwd, '.dsh', 'state', 'delegations.jsonl'), { recursive: true })
    const fake = host(cwd)

    const run = await fake.runTool('team_delegate', { role: 'developer', task: '实现 AC-001' })
    assert.equal(run.isError, false, 'a bookkeeping failure must never fail an authorised delegation')
    const text = runText(run)
    assert.match(text, /warning: 未能写入委派记录/)
    assert.match(text, /delegations\.jsonl/)
    // The child really ran: its session is named and the child's output is reported.
    assert.match(text, /child session: activation-1/)
    // The durable role binding (a different file) is unaffected.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'roles', 'activation-1.json')), true)
})

/**
 * The delegation ledger write from the SERVICE seam (AC-001/AC-002/AC-003):
 * an autonomous dispatcher calls `roleGuardService.bind()` instead of
 * `team_delegate`, so `bind` must leave the same row the tool path writes —
 * otherwise the stage-role write guard and `advance` refuse an auto-dispatched
 * child that WAS delegated.
 *
 * Failure policy is the same as the tool path: an unwritable ledger is a
 * warning, never a failed dispatch.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type AgentLike } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply as applyRoleGuard } from '../dist/index.js'
import { recordStageDelegation } from '../dist/stage-delegations.js'

/** The slice of the provided service these tests exercise. */
interface BindServiceLike {
    bind(request: { role: string; sessionId: string; cwd?: string; agent?: AgentLike }): { sessionId: string } | undefined
}

/** Assemble role-guard into a minimal fake host. */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    applyRoleGuard(fake.ctx as never, { logFile: path.join(cwd, 'role-guard.log') })
    return fake
}

/** The service `apply()` provides (the auto-dispatch seam's entry point). */
function bindService(fake: FakeHost): BindServiceLike {
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('role-guard') as BindServiceLike | undefined
    assert.ok(service !== undefined, 'the role-guard service is provided at assembly')
    return service
}

/** Put the fake host's session on a mission in the `implement` (developer) stage. */
function missionInImplement(cwd: string): string {
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: 'mission-bind', title: 'bind delegation', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'mission-bind', 'implement')
    store.update('mission-bind', () => ({ stage: 'implement' }))
    store.writeStageResult('mission-bind', {
        stageId: 'implement',
        attempt: 1,
        state: 'entered',
        enteredAt: Date.now(),
        role: 'developer',
    })
    return 'mission-bind'
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

function logText(cwd: string): string {
    const file = path.join(cwd, 'role-guard.log')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

test('the service bind appends the delegation row team_delegate would write (TC-1561)', () => {
    const cwd = tempWorkspace('role-guard-bind-delegation-')
    const missionId = missionInImplement(cwd)
    const fake = host(cwd)

    const binding = bindService(fake).bind({ role: 'developer', sessionId: 'run-auto-1', cwd, agent: fake.agent })
    assert.ok(binding !== undefined, 'the role binding is still written')
    assert.equal(binding?.sessionId, 'run-auto-1')
    // The skill gate reads a different file; this change must not disturb it.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'roles', 'run-auto-1.json')), true)

    const rows = ledgerRows(cwd)
    assert.equal(rows.length, 1)
    assert.deepEqual(
        {
            missionId: rows[0]?.['missionId'],
            role: rows[0]?.['role'],
            stage: rows[0]?.['stage'],
            child: rows[0]?.['childSessionId'],
        },
        { missionId, role: 'developer', stage: 'implement', child: 'run-auto-1' },
    )
    assert.equal(typeof rows[0]?.['at'], 'number')
    // The write guard/advance match on this exact child session id, so the row
    // must name the child the dispatcher will actually run.
    assert.equal(rows[0]?.['childSessionId'], binding?.sessionId)
})

test('repeated binds and the team_delegate writer keep one row per delegation (TC-1563)', () => {
    const cwd = tempWorkspace('role-guard-bind-dedupe-')
    missionInImplement(cwd)
    const fake = host(cwd)
    const service = bindService(fake)

    service.bind({ role: 'developer', sessionId: 'run-auto-1', cwd, agent: fake.agent })
    // A retried dispatch with the same child id is the same delegation (`at`
    // is not part of the key).
    service.bind({ role: 'developer', sessionId: 'run-auto-1', cwd, agent: fake.agent })
    assert.equal(ledgerRows(cwd).length, 1)

    // The tool path uses the same shared writer; writing the same tuple again
    // from there adds no noise either.
    const warning = recordStageDelegation(
        { stores: new MissionStoreRegistry(), layout: {} },
        fake.agent,
        'developer',
        'run-auto-1',
        cwd,
    )
    assert.equal(warning, undefined)
    assert.equal(ledgerRows(cwd).length, 1)

    // A different child (or stage) is a different delegation.
    service.bind({ role: 'developer', sessionId: 'run-auto-2', cwd, agent: fake.agent })
    assert.equal(ledgerRows(cwd).length, 2)
})

test('a bind with no bound mission writes no row and does not throw (TC-1564)', () => {
    const cwd = tempWorkspace('role-guard-bind-nomission-')
    const fake = host(cwd)

    const binding = bindService(fake).bind({ role: 'developer', sessionId: 'run-auto-1', cwd, agent: fake.agent })
    assert.ok(binding !== undefined, 'the role binding does not depend on a mission')
    assert.deepEqual(ledgerRows(cwd), [])
    assert.doesNotMatch(logText(cwd), /未能写入委派记录/)
})

test('an unwritable ledger warns but the bind (and dispatch) continues (TC-1565)', () => {
    const cwd = tempWorkspace('role-guard-bind-ledgerfail-')
    missionInImplement(cwd)
    // A directory where the ledger file must be: every append fails (EISDIR).
    fs.mkdirSync(path.join(cwd, '.dsh', 'state', 'delegations.jsonl'), { recursive: true })
    const fake = host(cwd)

    const binding = bindService(fake).bind({ role: 'developer', sessionId: 'run-auto-1', cwd, agent: fake.agent })
    assert.ok(binding !== undefined, 'a bookkeeping failure must never fail an authorised dispatch')
    // The skill-whitelist binding (a different file) is unaffected.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', 'roles', 'run-auto-1.json')), true)
    // …and the fact that the stage has no delegation record stays visible.
    assert.match(logText(cwd), /未能写入委派记录/)
    assert.match(logText(cwd), /delegations\.jsonl/)
})

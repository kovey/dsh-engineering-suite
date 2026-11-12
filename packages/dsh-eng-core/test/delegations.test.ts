/**
 * The delegation ledger (`state/delegations.jsonl`): append/read round-trip,
 * crash-truncated tails, malformed rows, and the stage-role helper the write
 * guard and `advance` share.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    DELEGATION_LEDGER,
    appendDelegation,
    delegationLedgerFile,
    matchesDelegation,
    readDelegations,
    stageRoleOf,
} from '../dist/delegations.js'
import { MissionStoreRegistry, resolveLayout } from '../dist/index.js'
import { tempWorkspace } from '../dist/testing.js'

test('appendDelegation writes one JSONL row under the layout state dir and reads it back', () => {
    const cwd = tempWorkspace('delegations-')
    assert.equal(delegationLedgerFile(cwd), path.join(cwd, '.dsh', 'state', DELEGATION_LEDGER))

    const file = appendDelegation(cwd, {
        missionId: 'mission-1',
        role: 'developer',
        childSessionId: 'session-child',
        stage: 'implement',
        at: 1_700_000_000_000,
    })
    assert.equal(file, delegationLedgerFile(cwd))
    assert.equal(fs.existsSync(file), true)

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
        missionId: 'mission-1',
        role: 'developer',
        childSessionId: 'session-child',
        stage: 'implement',
        at: 1_700_000_000_000,
    })

    assert.deepEqual(readDelegations(cwd, 'mission-1'), [
        { missionId: 'mission-1', role: 'developer', childSessionId: 'session-child', stage: 'implement', at: 1_700_000_000_000 },
    ])
    // Another mission's rows are not mixed in.
    assert.deepEqual(readDelegations(cwd, 'mission-2'), [])
})

test('a crash-truncated tail line is skipped and the next append starts a fresh line', () => {
    const cwd = tempWorkspace('delegations-tail-')
    const file = delegationLedgerFile(cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"missionId":"mission-1","role":"dev')

    appendDelegation(cwd, { missionId: 'mission-1', role: 'developer', childSessionId: 'child-1', stage: 'implement', at: 1 })
    const records = readDelegations(cwd, 'mission-1')
    assert.equal(records.length, 1)
    assert.equal(records[0]?.childSessionId, 'child-1')
    // The writer repaired the missing newline instead of gluing the row onto junk.
    const tail = fs.readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) ?? ''
    assert.equal(JSON.parse(tail).childSessionId, 'child-1')
})

test('malformed or mis-shaped rows are skipped, never trusted', () => {
    const cwd = tempWorkspace('delegations-bad-')
    const file = delegationLedgerFile(cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
        file,
        [
            'not json at all',
            JSON.stringify({ missionId: 'mission-1', role: 'developer' }), // no child/session/at
            JSON.stringify({ missionId: 'mission-1', role: 'developer', childSessionId: 'c1', at: 'soon' }),
            JSON.stringify({ missionId: 'mission-1', role: 'developer', childSessionId: 'c2', stage: 'implement', at: 2 }),
            '',
        ].join('\n'),
    )
    const records = readDelegations(cwd, 'mission-1')
    assert.deepEqual(records, [{ missionId: 'mission-1', role: 'developer', childSessionId: 'c2', stage: 'implement', at: 2 }])
})

test('matchesDelegation requires stage + role, and the child when one is named', () => {
    const records = [
        { missionId: 'mission-1', role: 'developer', childSessionId: 'child-1', stage: 'implement', at: 1 },
        { missionId: 'mission-1', role: 'qa', childSessionId: 'child-2', stage: 'quality-verify', at: 2 },
    ]
    assert.equal(matchesDelegation(records, { stage: 'implement', role: 'developer' })?.childSessionId, 'child-1')
    assert.equal(matchesDelegation(records, { stage: 'implement', role: 'developer', childSessionId: 'child-2' }), undefined)
    assert.equal(matchesDelegation(records, { stage: 'quality-verify', role: 'developer' }), undefined)
    assert.equal(matchesDelegation(records, { stage: 'implement', role: 'qa' }), undefined)
})

test('stageRoleOf reads the role of the mission’s current stage artifact', () => {
    const cwd = tempWorkspace('delegations-role-')
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: 'mission-1', title: 'role stage', cwd, sessionId: 'session-1' })
    store.update('mission-1', () => ({ stage: 'implement' }))
    store.writeStageResult('mission-1', { stageId: 'implement', attempt: 1, state: 'entered', enteredAt: 1, role: 'developer' })

    const mission = store.read('mission-1')
    assert.equal(stageRoleOf(mission, store), 'developer')

    // A stage that declares no role (or is not entered yet) reads as "no role".
    store.update('mission-1', () => ({ stage: 'quality-verify' }))
    assert.equal(stageRoleOf(store.read('mission-1'), store), undefined)
    store.update('mission-1', () => ({ stage: 'missing-stage' }))
    assert.equal(stageRoleOf(store.read('mission-1'), store), undefined)
    assert.equal(stageRoleOf(undefined, store), undefined)
})

test('an explicit layout rootDir places the ledger under it', () => {
    const cwd = tempWorkspace('delegations-layout-')
    const options = { rootDir: path.join(cwd, 'trail') }
    appendDelegation(cwd, { missionId: 'm', role: 'r', childSessionId: 'c', stage: 's', at: 3 }, options)
    const expected = path.join(resolveLayout(cwd, options).stateDir, DELEGATION_LEDGER)
    assert.equal(fs.existsSync(expected), true)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', DELEGATION_LEDGER)), false)
})

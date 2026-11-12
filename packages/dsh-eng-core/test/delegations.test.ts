/**
 * The delegation ledger (`state/delegations.jsonl`): append/read round-trip,
 * crash-truncated tails, malformed rows, and the stage-role helper the write
 * guard and `advance` share — plus the `mkdir` lock that makes the de-duplicated
 * append atomic across processes (TC-1571…TC-1575).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    DELEGATION_LEDGER,
    appendDelegation,
    appendDelegationOnce,
    delegationLedgerFile,
    delegationLockDir,
    matchesDelegation,
    readDelegations,
    stageRoleOf,
} from '../dist/delegations.js'
import { MissionStoreRegistry, resolveLayout } from '../dist/index.js'
import { tempWorkspace } from '../dist/testing.js'

/** The built module, so a child process exercises exactly what the suite ships. */
const DIST_MODULE = new URL('../dist/delegations.js', import.meta.url).href

/**
 * Run one de-duplicated append in a REAL second process.
 *
 * Concurrency cannot be shown in this process: `appendDelegationOnce` is
 * synchronous, so ten `Promise.all` calls would run one after another and a
 * missing lock would still look green. Two OS processes racing on the same
 * read-then-append is the only evidence that means anything — the child prints
 * its pid so a caller can prove it really talked to ten different processes.
 * @param cwd - workspace root both processes share.
 * @param input - the delegation row to append.
 * @returns the child's pid (its exit code was 0; a non-zero one rejects).
 */
function appendInChildProcess(cwd: string, input: Record<string, unknown>): Promise<number> {
    const script = [
        `import { appendDelegationOnce } from ${JSON.stringify(DIST_MODULE)}`,
        `appendDelegationOnce(${JSON.stringify(cwd)}, ${JSON.stringify(input)})`,
        'process.stdout.write(String(process.pid))',
        '',
    ].join('\n')
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', (code) => {
            const pid = Number(stdout.trim())
            if (code !== 0) reject(new Error(`child process exited ${String(code)}: ${stderr}`))
            else if (!Number.isInteger(pid) || pid <= 0) reject(new Error(`child process printed no pid: ${stdout}`))
            else resolve(pid)
        })
    })
}

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

test('appendDelegationOnce skips an identical delegation and keeps the legacy append unchanged (TC-1563)', () => {
    const cwd = tempWorkspace('delegations-once-')
    const base = { missionId: 'mission-1', role: 'developer', childSessionId: 'child-1', stage: 'implement' }

    assert.deepEqual(appendDelegationOnce(cwd, { ...base, at: 1 }), { file: delegationLedgerFile(cwd), appended: true })
    // `at` is not part of the key: a retried bind with a later timestamp is the
    // SAME delegation, so it must not add a second row.
    assert.deepEqual(appendDelegationOnce(cwd, { ...base, at: 2 }), { file: delegationLedgerFile(cwd), appended: false })
    assert.equal(readDelegations(cwd, 'mission-1').length, 1)

    // A different child, or a different stage, is a different delegation.
    assert.equal(appendDelegationOnce(cwd, { ...base, childSessionId: 'child-2', at: 3 }).appended, true)
    assert.equal(appendDelegationOnce(cwd, { ...base, stage: 'review', at: 4 }).appended, true)
    assert.equal(readDelegations(cwd, 'mission-1').length, 3)

    // The legacy export keeps its "always append" semantics: callers that rely
    // on it (the team_delegate path before this change) are not silently altered.
    appendDelegation(cwd, { ...base, at: 5 })
    appendDelegation(cwd, { ...base, at: 6 })
    assert.equal(readDelegations(cwd, 'mission-1').length, 5)
})

test('an explicit layout rootDir places the ledger under it', () => {
    const cwd = tempWorkspace('delegations-layout-')
    const options = { rootDir: path.join(cwd, 'trail') }
    appendDelegation(cwd, { missionId: 'm', role: 'r', childSessionId: 'c', stage: 's', at: 3 }, options)
    const expected = path.join(resolveLayout(cwd, options).stateDir, DELEGATION_LEDGER)
    assert.equal(fs.existsSync(expected), true)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'state', DELEGATION_LEDGER)), false)
})

/** The row every concurrency case below competes over. */
const RACE_ROW = { missionId: 'mission-1', role: 'developer', childSessionId: 'child-1', stage: 'implement', at: 1 }

test('concurrent writers of the SAME delegation leave exactly one row (TC-1571)', async () => {
    const cwd = tempWorkspace('delegations-race-same-')
    // Ten OS processes race on the same read-then-append.
    const pids = await Promise.all(Array.from({ length: 10 }, () => appendInChildProcess(cwd, RACE_ROW)))
    // Evidence that this was real concurrency, not ten sequential calls.
    assert.equal(new Set(pids).size, 10)

    assert.equal(readDelegations(cwd, 'mission-1').length, 1)
    // One physical line: the deduplication happened in the writer, not only in
    // the reader (two rows would still "read as one delegation", but they are
    // exactly the noise the lock exists to remove).
    assert.equal(fs.readFileSync(delegationLedgerFile(cwd), 'utf8').trimEnd().split('\n').length, 1)
    // Every writer released the lock it took.
    assert.equal(fs.existsSync(delegationLockDir(cwd)), false)
})

test('concurrent writers of DIFFERENT delegations lose no row (TC-1572)', async () => {
    const cwd = tempWorkspace('delegations-race-diff-')
    const inputs = Array.from({ length: 10 }, (_value, index) => ({ ...RACE_ROW, childSessionId: `child-${index}` }))
    const pids = await Promise.all(inputs.map((input) => appendInChildProcess(cwd, input)))
    assert.equal(new Set(pids).size, 10)

    const records = readDelegations(cwd, 'mission-1')
    assert.equal(records.length, 10)
    // Every child's row is there, in some order: the lock serialises them, it
    // does not drop them.
    assert.deepEqual(
        records.map((record) => record.childSessionId).sort(),
        inputs.map((input) => input.childSessionId).sort(),
    )
    assert.equal(fs.existsSync(delegationLockDir(cwd)), false)
})

test('a lock held by another writer degrades to an unlocked append with a warning (TC-1573)', () => {
    const cwd = tempWorkspace('delegations-lock-busy-')
    const lockDir = delegationLockDir(cwd)
    fs.mkdirSync(lockDir, { recursive: true })
    const warnings: string[] = []
    const startedAt = Date.now()
    const result = appendDelegationOnce(cwd, RACE_ROW, {}, { warn: (message) => warnings.push(message) })
    const waited = Date.now() - startedAt

    // Degraded, not dropped: the row is on disk…
    assert.equal(result.appended, true)
    assert.equal(result.deduped, false)
    assert.match(result.warning ?? '', /锁/)
    assert.equal(readDelegations(cwd, 'mission-1').length, 1)
    // …and both the return value and the log say de-duplication was skipped.
    assert.equal(warnings.length >= 1, true)
    assert.match(warnings.join('|'), /降级/)
    // It retried for the whole budget instead of appending without looking.
    assert.equal(waited >= 1_000, true)
    // A lock this call never owned is never removed — the holder may be alive.
    assert.equal(fs.existsSync(lockDir), true)
})

test('an expired lock directory is taken over, used, and released (TC-1574)', () => {
    const cwd = tempWorkspace('delegations-lock-stale-')
    const file = delegationLedgerFile(cwd)
    const lockDir = delegationLockDir(cwd)
    fs.mkdirSync(lockDir, { recursive: true })
    // A dead holder: the directory has not been touched for a minute.
    const staleSeconds = (Date.now() - 60_000) / 1000
    fs.utimesSync(lockDir, staleSeconds, staleSeconds)

    const warnings: string[] = []
    const result = appendDelegationOnce(cwd, RACE_ROW, {}, { warn: (message) => warnings.push(message) })

    // The normal shape: deduplication really ran (no degraded marker), the
    // takeover was recorded, and the lock was released after the write.
    assert.deepEqual(result, { file, appended: true })
    assert.match(warnings.join('|'), /过期锁/)
    assert.equal(readDelegations(cwd, 'mission-1').length, 1)
    assert.equal(fs.existsSync(lockDir), false)
})

test('a stale lock that cannot be removed is never forced: the append degrades (AC-001)', () => {
    const cwd = tempWorkspace('delegations-lock-refuse-')
    const lockDir = delegationLockDir(cwd)
    // Stale AND undeletable: a non-empty directory fails `rmdir` with ENOTEMPTY.
    // Recursively deleting it could remove a live holder's lock, so the correct
    // behaviour is to give up the takeover and degrade — not to force it.
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'holder-still-here'), '')
    const staleSeconds = (Date.now() - 60_000) / 1000
    fs.utimesSync(lockDir, staleSeconds, staleSeconds)

    const warnings: string[] = []
    const result = appendDelegationOnce(cwd, RACE_ROW, {}, { warn: (message) => warnings.push(message) })

    assert.equal(result.appended, true)
    assert.equal(result.deduped, false)
    assert.match(result.warning ?? '', /放弃接管/)
    assert.equal(readDelegations(cwd, 'mission-1').length, 1)
    // The lock and the holder's marker inside it are untouched.
    assert.deepEqual(fs.readdirSync(lockDir), ['holder-still-here'])
    const logged = warnings.join('|')
    assert.match(logged, /过期锁/)
    assert.match(logged, /无法接管/)
})

test('an append that throws still releases the lock (TC-1575)', () => {
    const cwd = tempWorkspace('delegations-lock-throw-')
    const file = delegationLedgerFile(cwd)
    const lockDir = delegationLockDir(cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // The ledger path is a DIRECTORY: acquiring the lock succeeds (it lives next
    // to it), then the single append fails with EISDIR. Without the `finally`
    // the lock directory would stay behind and stall every later writer.
    fs.mkdirSync(file)
    assert.throws(() => appendDelegationOnce(cwd, RACE_ROW))
    assert.equal(fs.existsSync(lockDir), false)
})

/**
 * dsh-audit-trail tests.
 *
 * The plugin is a bypass observer, so the tests drive the two event contracts
 * the harness publishes (`tools/pre-execute` as a waterfall, `tools/result` as
 * an emit) plus `agent/pre-step` for turn attribution, and assert on the JSONL
 * the plugin wrote — never on its internals.
 *
 * Coverage: the row contract, decision passthrough, the pre-write snapshot
 * chain, `audit_rewind` (dry run / confirm / restore / delete / refusals),
 * `audit_report` (counts, failures, limit), hostile arguments that make
 * `JSON.stringify` throw, and teardown.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { auditFile, clearProjectConfigCache, readJsonl, resolveLayout, sha256, tail } from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeAgent, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'

interface SnapRecord {
    path: string
    relPath: string
    snapshotPath: string
    existed: boolean
    digest: string
    bytes: number
    mode?: number
    reason?: string
    error?: string
}

interface Row {
    phase: 'pre' | 'result'
    ts: string
    sessionId: string
    agentId?: string
    turn?: number
    callId: string
    rootCallId?: string
    tool: string
    decision?: string
    argsDigest?: string
    argsSummary?: string
    note?: string
    snapshot?: SnapRecord
    isError?: boolean
    durationMs?: number
    resultDigest?: string
    resultTail?: string
}

const SESSION = 'session-1'

/** A host with the plugin applied and the trail pointed at its own workspace. */
function host(config: Record<string, unknown> = {}, cwd = tempWorkspace('audit-trail-')): FakeHost {
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'audit-trail.log'), ...config })
    return fake
}

function rowsOf(fake: FakeHost, sessionId = SESSION): Row[] {
    return readJsonl<Row>(auditFile(resolveLayout(fake.cwd), sessionId))
}

/** The trail of one arbitrary workspace (one process serves several of them). */
function rowsAt(cwd: string, sessionId: string): Row[] {
    return readJsonl<Row>(auditFile(resolveLayout(cwd), sessionId))
}

/**
 * Write `<workspace>/.dsh/audit-trail.json` — the project-level override.
 * @param cwd - the workspace that owns the file.
 * @param value - the JSON value (ignored when `raw` is given).
 * @param raw - exact file text, for malformed-file cases.
 * @returns the file path.
 */
function projectConfig(cwd: string, value: unknown = {}, raw?: string): string {
    const file = path.join(cwd, '.dsh', 'audit-trail.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, raw ?? JSON.stringify(value))
    // The reader caches by mtime+size: a rewrite must never be served stale.
    clearProjectConfigCache()
    return file
}

/** The `exec` payload of `tools/pre-execute`. */
function execOf(fake: FakeHost, over: Record<string, unknown> = {}, agent: unknown = fake.agent): Record<string, unknown> {
    return {
        callId: 'call-1',
        rootCallId: 'call-1',
        name: 'read',
        arguments: {},
        agent,
        signal: new AbortController().signal,
        ...over,
    }
}

/** Drive `tools/pre-execute` with a base decision, as one specific agent. */
async function pre(
    fake: FakeHost,
    over: Record<string, unknown>,
    base: unknown = { kind: 'allow' },
    agent: unknown = fake.agent,
): Promise<unknown> {
    const payload = execOf(fake, over, agent)
    return fake.waterfall('tools/pre-execute', payload, () => base as never)
}

/** Drive `agent/pre-step` so the plugin learns the turn. */
async function step(fake: FakeHost, turn: number, agent: FakeAgent = fake.agent): Promise<void> {
    await fake.waterfall(
        'agent/pre-step',
        { agent, messages: [], turn, step: 1, signal: new AbortController().signal },
        () => ({ kind: 'enter', messages: [] }) as never,
    )
}

function writeFile(file: string, text: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-audit-trail')
    assert.deepEqual(inject, ['tools'])
})

test('apply() registers both tools, the observers, and no prompt section by default', () => {
    const fake = host()
    assert.deepEqual([...fake.tools.keys()].sort(), ['audit_report', 'audit_rewind'])
    assert.deepEqual([...fake.listeners.keys()].sort(), [
        // Turn attribution listens to three events on purpose: a session that
        // never emits agent/pre-step must still produce rollbackable snapshots.
        'agent/inbox/claimed',
        'agent/pre-step',
        'agent/turn-stopping',
        'session/disposed',
        'tools/pre-execute',
        'tools/result',
    ])
    assert.equal(fake.sections.length, 0)

    const withPrompt = host({ prompt: { enabled: true, order: 670 } })
    assert.match(withPrompt.sectionText('eng:audit-trail'), /audit_rewind/)
    withPrompt.dispose()
    fake.dispose()
})

test('one call appends a matching pre row and result row', async () => {
    const fake = host()
    const args = { file_path: 'src/a.ts', offset: 5 }
    const call = execOf(fake, { name: 'read', callId: 'call-7', rootCallId: 'call-7', arguments: args })
    assert.deepEqual(await fake.waterfall('tools/pre-execute', call, () => ({ kind: 'allow' })), { kind: 'allow' })

    await new Promise((resolve) => setTimeout(resolve, 25))
    const content = [{ type: 'text', text: 'line 5: hello' }]
    fake.emit('tools/result', [call, { isError: false, content }])

    const rows = rowsOf(fake)
    assert.equal(rows.length, 2)
    const [preRow, resultRow] = rows as [Row, Row]

    assert.equal(preRow.phase, 'pre')
    assert.equal(preRow.tool, 'read')
    assert.equal(preRow.callId, 'call-7')
    assert.equal(preRow.rootCallId, 'call-7')
    assert.equal(preRow.sessionId, SESSION)
    assert.equal(preRow.agentId, 'agent-1')
    assert.equal(preRow.decision, 'allow')
    assert.equal(preRow.argsDigest, sha256(JSON.stringify(args)))
    assert.match(preRow.argsSummary ?? '', /src\/a\.ts/)
    assert.equal(preRow.snapshot, undefined)

    assert.equal(resultRow.phase, 'result')
    assert.equal(resultRow.callId, preRow.callId)
    assert.equal(resultRow.tool, 'read')
    assert.equal(resultRow.isError, false)
    assert.ok((resultRow.durationMs ?? 0) >= 20, `durationMs=${String(resultRow.durationMs)}`)
    assert.equal(resultRow.resultDigest, sha256(JSON.stringify(content)))
    assert.equal(resultRow.resultTail, tail('line 5: hello', 600))

    // The trail is a real file in the workspace layout.
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'audit', `${SESSION}.jsonl`)), true)
    fake.dispose()
})

test('the waterfall returns the base decision unchanged (allow / deny / ask)', async () => {
    const fake = host()
    assert.deepEqual(await pre(fake, { callId: 'c-allow', name: 'read' }, { kind: 'allow' }), { kind: 'allow' })
    assert.deepEqual(await pre(fake, { callId: 'c-deny', name: 'write' }, { kind: 'deny', reason: 'no spec' }), {
        kind: 'deny',
        reason: 'no spec',
    })
    assert.deepEqual(await pre(fake, { callId: 'c-ask', name: 'bash' }, { kind: 'ask', reason: 'confirm' }), {
        kind: 'ask',
        reason: 'confirm',
    })
    assert.deepEqual(
        rowsOf(fake).map((row) => row.decision),
        ['allow', 'deny', 'ask'],
    )
    fake.dispose()
})

test('a write call snapshots the current content before the tool runs', async () => {
    const fake = host()
    const target = writeFile(path.join(fake.cwd, 'src', 'a.ts'), 'v0')
    const call = execOf(fake, { name: 'write', callId: 'c-write', arguments: { file_path: 'src/a.ts', content: 'v1' } })

    await fake.waterfall('tools/pre-execute', call, () => ({ kind: 'allow' }))
    const preRow = rowsOf(fake)[0] as Row
    const snapshot = preRow.snapshot as SnapRecord

    assert.equal(snapshot.path, target)
    assert.equal(snapshot.relPath, path.join('src', 'a.ts'))
    assert.equal(snapshot.existed, true)
    assert.equal(snapshot.bytes, 2)
    assert.equal(snapshot.digest, sha256('v0'))
    assert.equal(snapshot.reason, undefined)
    assert.match(snapshot.snapshotPath, /audit[/\\]snapshots[/\\]session-1[/\\]turn-unknown[/\\]1-[0-9a-f]{12}\.snap$/)
    assert.equal(fs.readFileSync(snapshot.snapshotPath, 'utf8'), 'v0')

    // redactArgs: the file body never reaches the trail, its digest does.
    assert.equal((preRow.argsSummary ?? '').includes('v1'), false)
    assert.ok((preRow.argsSummary ?? '').includes(sha256('v1').slice(0, 12)))
    assert.match(preRow.argsSummary ?? '', /<[0-9a-f]{12}\/2 chars>/)

    // ... and the snapshot really is the state *before* the write.
    fs.writeFileSync(target, 'v1')
    assert.equal(fs.readFileSync(snapshot.snapshotPath, 'utf8'), 'v0')
    fake.dispose()
})

test('read-only calls and non-target arguments never snapshot', async () => {
    const fake = host()
    writeFile(path.join(fake.cwd, 'src', 'a.ts'), 'v0')
    await pre(fake, { callId: 'c-read', name: 'read', arguments: { file_path: 'src/a.ts' } })
    await pre(fake, { callId: 'c-bash', name: 'write' })
    for (const row of rowsOf(fake)) assert.equal(row.snapshot, undefined)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'audit', 'snapshots')), false)
    fake.dispose()
})

test('audit_rewind restores an existing file and deletes one that was created', async () => {
    const fake = host()
    await step(fake, 5)

    const existing = writeFile(path.join(fake.cwd, 'src', 'a.ts'), 'v0')
    const created = path.join(fake.cwd, 'src', 'new.ts')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'src/a.ts', content: 'v1' } })
    fs.writeFileSync(existing, 'v1')
    await pre(fake, { callId: 'c2', name: 'write', arguments: { file_path: 'src/new.ts', content: 'brand new' } })
    fs.writeFileSync(created, 'brand new')

    const snapshotDir = path.join(fake.cwd, '.dsh', 'audit', 'snapshots', SESSION, 'turn-5')
    assert.equal(fs.readdirSync(snapshotDir).length, 1, 'only the pre-existing file has bytes to save')

    // 1. A dry run changes nothing.
    const dry = runText(await fake.runTool('audit_rewind', { turn: 5 }))
    assert.match(dry, /dry-run/)
    assert.match(dry, /恢复/)
    assert.match(dry, /删除/)
    assert.match(dry, /不会修改 git 历史/)
    assert.equal(fs.readFileSync(existing, 'utf8'), 'v1')
    assert.equal(fs.existsSync(created), true)

    // 2. dryRun=false without confirm is refused.
    const refused = runText(await fake.runTool('audit_rewind', { turn: 5, dryRun: false }))
    assert.match(refused, /拒绝写盘/)
    assert.equal(fs.readFileSync(existing, 'utf8'), 'v1')
    assert.equal(fs.existsSync(created), true)

    // 3. dryRun=false + confirm=true compensates both writes.
    const run = await fake.runTool('audit_rewind', { turn: 5, dryRun: false, confirm: true })
    assert.equal(run.isError, false, runText(run))
    const done = runText(run)
    assert.match(done, /已执行 2 项补偿/)
    assert.match(done, /2\/2 项成功/)
    assert.equal(fs.readFileSync(existing, 'utf8'), 'v0')
    assert.equal(fs.existsSync(created), false)

    // 4. A turn with no snapshots is reported honestly, never thrown.
    const missing = await fake.runTool('audit_rewind', { turn: 99 })
    assert.equal(missing.isError, false)
    const missingText = runText(missing)
    assert.match(missingText, /没有可回滚项/)
    assert.match(missingText, /turn >= 99 之后没有写操作/)
    assert.equal(missingText.includes('0/0'), false)
    fake.dispose()
})

test('audit_rewind only replays snapshots at or after the requested turn', async () => {
    const fake = host()
    const file = writeFile(path.join(fake.cwd, 'a.txt'), 'turn-2')
    await step(fake, 2)
    await pre(fake, { callId: 'c2', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'turn-2', new_string: 'turn-4' } })
    fs.writeFileSync(file, 'turn-4')
    await step(fake, 4)
    await pre(fake, { callId: 'c4', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'turn-4', new_string: 'turn-6' } })
    fs.writeFileSync(file, 'turn-6')

    const dry = runText(await fake.runTool('audit_rewind', { turn: 4 }))
    assert.match(dry, /turn >= 4/)
    assert.equal(dry.includes('turn 2'), false)

    const applied = runText(await fake.runTool('audit_rewind', { turn: 4, dryRun: false, confirm: true }))
    assert.match(applied, /1\/1 项成功/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'turn-4')

    // Rewinding to the earliest turn replays both snapshots, newest first, and
    // therefore lands on the original content.
    await fake.runTool('audit_rewind', { turn: 2, dryRun: false, confirm: true })
    assert.equal(fs.readFileSync(file, 'utf8'), 'turn-2')
    fake.dispose()
})

test('paths outside the workspace, .dsh internals, oversized files and quota are never snapshotted', async () => {
    const outside = writeFile(path.join(tempWorkspace('audit-outside-'), 'secret.txt'), 'secret')
    const fake = host({ snapshot: { enabled: true, maxFileBytes: 16, maxFilesPerTurn: 1 } })
    await step(fake, 1)

    writeFile(path.join(fake.cwd, 'big.txt'), 'x'.repeat(100))
    writeFile(path.join(fake.cwd, 'ok.txt'), 'ok')
    writeFile(path.join(fake.cwd, 'ok2.txt'), 'ok')

    await pre(fake, { callId: 'c-out', name: 'write', arguments: { file_path: outside, content: 'y' } })
    await pre(fake, { callId: 'c-dsh', name: 'write', arguments: { file_path: '.dsh/specs/x.md', content: 'y' } })
    await pre(fake, { callId: 'c-big', name: 'write', arguments: { file_path: 'big.txt', content: 'y' } })
    await pre(fake, { callId: 'c-ok', name: 'write', arguments: { file_path: 'ok.txt', content: 'y' } })
    await pre(fake, { callId: 'c-more', name: 'write', arguments: { file_path: 'ok2.txt', content: 'y' } })

    const snapshots = new Map(rowsOf(fake).map((row) => [row.callId, row.snapshot]))
    assert.equal(snapshots.get('c-out')?.reason, 'outside-workspace')
    assert.equal(snapshots.get('c-dsh')?.reason, 'internal')
    assert.equal(snapshots.get('c-big')?.reason, 'oversize')
    assert.equal(snapshots.get('c-more')?.reason, 'quota')
    assert.equal(snapshots.get('c-ok')?.reason, undefined)
    assert.equal(snapshots.get('c-ok')?.digest, sha256('ok'))
    // Non-actionable records carry no snapshot path, so rewind can never use them.
    for (const callId of ['c-out', 'c-dsh', 'c-big', 'c-more']) {
        assert.equal(snapshots.get(callId)?.snapshotPath, '')
        assert.equal(snapshots.get(callId)?.digest, '')
    }

    const bucket = path.join(fake.cwd, '.dsh', 'audit', 'snapshots', SESSION, 'turn-1')
    assert.equal(fs.readdirSync(bucket).length, 1)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret')

    // Rewinding skips every non-actionable record instead of touching those paths.
    const report = runText(await fake.runTool('audit_rewind', { turn: 1, dryRun: false, confirm: true }))
    assert.match(report, /1 项补偿（另有 4 条记录不可回滚，已跳过）/)
    assert.match(report, /结果：1\/1 项成功/)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret')
    assert.equal(fs.readFileSync(path.join(fake.cwd, 'big.txt'), 'utf8'), 'x'.repeat(100))
    assert.equal(fs.readFileSync(path.join(fake.cwd, 'ok2.txt'), 'utf8'), 'ok')
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs', 'x.md')), false)
    fake.dispose()
})

test('snapshots can be disabled and the trail still records the chain', async () => {
    const fake = host({ snapshot: { enabled: false }, redactArgs: false })
    const target = writeFile(path.join(fake.cwd, 'a.txt'), 'v0')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'a.txt', content: 'v1' } })
    const row = rowsOf(fake)[0] as Row
    assert.equal(row.snapshot, undefined)
    assert.match(row.argsSummary ?? '', /"content":"v1"/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'audit', 'snapshots')), false)
    const rewind = runText(await fake.runTool('audit_rewind', { turn: 0 }))
    // Honest totals: nothing to roll back is reported as such, never as "0/0 项成功".
    assert.match(rewind, /没有可回滚项/)
    assert.match(rewind, /未开启快照/)
    assert.equal(rewind.includes('0/0'), false)
    assert.equal(fs.readFileSync(target, 'utf8'), 'v0')
    fake.dispose()
})

test('audit_rewind refuses a target that is now a symlink (regression)', async () => {
    const fake = host()
    await step(fake, 3)

    const real = writeFile(path.join(fake.cwd, 'real.txt'), 'REAL')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'real.txt', content: 'v1' } })

    // Somebody replaces the recorded path with a symlink to another file.
    const decoy = writeFile(path.join(fake.cwd, 'decoy.txt'), 'DECOY')
    fs.rmSync(real)
    fs.symlinkSync(decoy, real)

    const dry = runText(await fake.runTool('audit_rewind', { turn: 3 }))
    assert.match(dry, /是符号链接，跳过（避免写到链接目标）/)
    assert.match(dry, /没有可回滚项/)
    assert.equal(dry.includes('0/0'), false)

    const done = runText(await fake.runTool('audit_rewind', { turn: 3, dryRun: false, confirm: true }))
    assert.match(done, /跳过 1 项/)
    assert.equal(done.includes('项成功'), false, `a refused entry must never count as restored:\n${done}`)
    // The link survives and its target is untouched: rewind never wrote through it.
    assert.equal(fs.lstatSync(real).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY')

    // force does not override the symlink refusal either.
    const forced = runText(await fake.runTool('audit_rewind', { turn: 3, dryRun: false, confirm: true, force: true }))
    assert.match(forced, /符号链接/)
    assert.equal(fs.lstatSync(real).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY')

    // Once the link is gone the very same snapshot restores normally.
    fs.rmSync(real)
    const restored = runText(await fake.runTool('audit_rewind', { turn: 3, dryRun: false, confirm: true }))
    assert.match(restored, /结果：1\/1 项成功/)
    assert.equal(fs.readFileSync(real, 'utf8'), 'REAL')
    fake.dispose()
})

test('a creation written again after the recorded turn is not deleted without force (regression)', async () => {
    const fake = host()
    await step(fake, 7)

    const created = path.join(fake.cwd, 'fresh.txt')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'fresh.txt', content: 'v1' } })
    // The recorded write ...
    fs.writeFileSync(created, 'v1')
    const recorded = rowsOf(fake)[0] as Row
    // ... and then somebody else keeps working in that file, with an mtime
    // strictly after the turn's last journal row for this path.
    fs.utimesSync(created, new Date(), new Date(Date.parse(recorded.ts) + 2000))

    const dry = runText(await fake.runTool('audit_rewind', { turn: 7 }))
    assert.match(dry, /将跳过删除/)
    assert.match(dry, /需要 force 才删除/)

    const guarded = runText(await fake.runTool('audit_rewind', { turn: 7, dryRun: false, confirm: true }))
    assert.match(guarded, /在回滚点之后又被修改，跳过删除（需要 force 才删除）/)
    assert.match(guarded, /没有可回滚项/)
    assert.match(guarded, /force=true 重新调用/)
    assert.equal(fs.existsSync(created), true)
    assert.equal(fs.readFileSync(created, 'utf8'), 'v1')

    const forced = runText(await fake.runTool('audit_rewind', { turn: 7, dryRun: false, confirm: true, force: true }))
    assert.match(forced, /结果：1\/1 项成功/)
    assert.match(forced, /force：true/)
    assert.equal(fs.existsSync(created), false)
    fake.dispose()
})

test('a snapshot failure is recorded with its reason and reported honestly (regression)', async () => {
    const fake = host()
    await step(fake, 2)
    const real = writeFile(path.join(fake.cwd, 'real.txt'), 'REAL')

    // Make the snapshot copy impossible without breaking the trail: the
    // snapshots path is a regular file, so creating the bucket fails (ENOTDIR).
    fs.mkdirSync(path.join(fake.cwd, '.dsh', 'audit'), { recursive: true })
    fs.writeFileSync(path.join(fake.cwd, '.dsh', 'audit', 'snapshots'), 'not a directory')

    const result = await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'real.txt', content: 'v1' } })
    // The hook contract is untouched: the base decision still comes back.
    assert.deepEqual(result, { kind: 'allow' })

    const row = rowsOf(fake)[0] as Row
    const record = row.snapshot as SnapRecord
    assert.equal(record.reason, 'error')
    assert.equal(record.path, real)
    assert.equal(record.relPath, 'real.txt')
    assert.equal(record.snapshotPath, '')
    assert.equal(record.digest, '')
    assert.match(record.error ?? '', /ENOTDIR|not a directory/)

    const report = runText(await fake.runTool('audit_report', {}))
    assert.match(report, /快照失败（不可回滚）/)
    assert.match(report, /ENOTDIR|not a directory/)
    assert.equal(report.includes('未定位到文件参数'), false, `a captured failure must not be blamed on the arguments:\n${report}`)
    assert.match(report, /写调用快照：0\/1 条可用/)

    const rewind = runText(await fake.runTool('audit_rewind', { turn: 2, dryRun: false, confirm: true }))
    assert.match(rewind, /没有可回滚项/)
    assert.match(rewind, /快照失败/)
    assert.match(rewind, /不可回滚/)
    assert.equal(fs.readFileSync(real, 'utf8'), 'REAL')
    fake.dispose()
})

test('a rewind without turn information says how to become rollbackable (regression)', async () => {
    const fake = host()
    // No agent/pre-step: the plugin cannot learn the turn, so the snapshot is
    // recorded under `turn-unknown` and can never be selected by `turn`.
    const target = writeFile(path.join(fake.cwd, 'a.txt'), 'v0')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'a.txt', content: 'v1' } })
    fs.writeFileSync(target, 'v1')

    const rewind = runText(await fake.runTool('audit_rewind', { turn: 1 }))
    assert.match(rewind, /没有可回滚项/)
    assert.match(rewind, /1 条快照记录缺少轮次信息/)
    assert.match(rewind, /agent\/pre-step/)
    assert.equal(rewind.includes('0/0'), false)
    assert.equal(fs.readFileSync(target, 'utf8'), 'v1')
    fake.dispose()
})

test('a rewind restores the recorded file mode (regression)', async () => {
    const fake = host()
    await step(fake, 5)
    const target = writeFile(path.join(fake.cwd, 'script.sh'), '#!/bin/sh\necho v0\n')
    fs.chmodSync(target, 0o755)

    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'script.sh', content: 'echo v1\n' } })
    assert.equal((rowsOf(fake)[0] as Row).snapshot?.mode, 0o755)
    assert.equal(fs.statSync(target).mode & 0o7777, 0o755)

    // The write loses the executable bit, as a plain rewrite would.
    fs.writeFileSync(target, 'echo v1\n')
    fs.chmodSync(target, 0o644)
    assert.equal(fs.statSync(target).mode & 0o7777, 0o644)

    const done = runText(await fake.runTool('audit_rewind', { turn: 5, dryRun: false, confirm: true }))
    assert.match(done, /结果：1\/1 项成功/)
    assert.match(done, /权限 755/)
    assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho v0\n')
    assert.equal(fs.statSync(target).mode & 0o7777, 0o755, 'the recorded mode must come back with the content')
    fake.dispose()
})

test('a creation whose content changed after the recorded write is caught by the digest guard (regression)', async () => {
    const fake = host()
    await step(fake, 8)

    // Turn 8 creates a file ...
    const created = path.join(fake.cwd, 'notes.txt')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'notes.txt', content: 'draft' } })
    fs.writeFileSync(created, 'draft')
    // ... and a later turn writes it again, so the audit records that later
    // state as the post-state of the creation.
    await step(fake, 9)
    await pre(fake, { callId: 'c2', name: 'edit', arguments: { file_path: 'notes.txt', old_string: 'draft', new_string: 'final' } })
    fs.writeFileSync(created, 'final')

    // Somebody edits it by hand and back-dates the mtime before the creation's
    // own journal row, so the mtime guard cannot see it: only the recorded
    // post-state digest can.
    fs.writeFileSync(created, 'HUMAN WORK')
    const c1 = rowsOf(fake).find((row) => row.callId === 'c1') as Row
    const before = new Date(Date.parse(c1.ts) - 1000)
    fs.utimesSync(created, before, before)

    const guarded = runText(await fake.runTool('audit_rewind', { turn: 8, dryRun: false, confirm: true }))
    assert.match(guarded, /跳过删除（需要 force 才删除）/)
    assert.match(guarded, /digest .* 与审计记录的写后状态/)
    // The creation was not deleted — and therefore the newer snapshot's replay
    // could not overwrite the hand-made content either.
    assert.equal(fs.existsSync(created), true)
    assert.equal(fs.readFileSync(created, 'utf8'), 'draft')
    fake.dispose()
})

test('audit_report counts calls, tools and failures and respects limit', async () => {
    const fake = host()
    await step(fake, 3)
    const calls: [string, string, boolean][] = [
        ['c1', 'read', false],
        ['c2', 'write', true],
        ['c3', 'read', false],
    ]
    for (const [callId, tool, isError] of calls) {
        const payload = execOf(fake, { callId, name: tool, arguments: { file_path: 'src/a.ts' } })
        await fake.waterfall('tools/pre-execute', payload, () => ({ kind: 'allow' }))
        fake.emit('tools/result', [payload, { isError, content: [{ type: 'text', text: isError ? 'boom' : 'ok' }] }])
    }

    const report = runText(await fake.runTool('audit_report', { limit: 2 }))
    assert.match(report, /总行数：6（pre 3 \/ result 3）/)
    assert.match(report, /调用次数：3，失败：1/)
    assert.match(report, /read×2/)
    assert.match(report, /write×1/)
    assert.match(report, /失败调用（1）/)
    assert.match(report, /c2/)
    assert.match(report, /boom/)
    assert.match(report, /turn 3/)
    assert.match(report, /\| 时间 \| 工具 \| 轮次 \| 结果 \| 参数摘要 \|/)

    const table = report.split('\n').filter((line) => line.startsWith('| 20') && line.includes('call-') === false)
    assert.equal(table.length, 2, `limit=2 must render two rows:\n${report}`)

    const filtered = runText(await fake.runTool('audit_report', { tool: 'write', limit: 5 }))
    assert.match(filtered, /调用次数：1/)
    assert.match(filtered, /write×1/)
    assert.equal(filtered.includes('read×'), false)

    // An unknown session falls back to listing the sessions that have a trail.
    const orphan = await fake.runTool('audit_report', { limit: 1 }, { agent: { id: 'a-x', session: { header: { cwd: fake.cwd } } } })
    const orphanText = runText(orphan)
    assert.match(orphanText, /无法确定当前会话/)
    assert.match(orphanText, /session-1/)
    fake.dispose()
})

test('audit_report can locate the trail through a mission binding', async () => {
    const fake = host()
    await pre(fake, { callId: 'c1', name: 'read' })
    // Bind the session to a mission through the shared mission store.
    const store = new (await import('dsh-eng-core')).MissionStoreRegistry({}).for(fake.cwd)
    const mission = store.create({ title: 'audit mission', cwd: fake.cwd, sessionId: SESSION })
    const report = runText(await fake.runTool('audit_report', { missionId: mission.id }))
    assert.match(report, new RegExp(`session ${SESSION}`))
    assert.match(report, /调用次数：1/)
    const unknown = runText(await fake.runTool('audit_report', { missionId: 'nope' }))
    assert.match(unknown, /未找到 mission nope/)
    fake.dispose()
})

test('arguments that make JSON.stringify throw are swallowed, the pipeline still runs', async () => {
    const fake = host()
    const hostile = {
        file_path: 'src/a.ts',
        get toJSON(): never {
            throw new Error('boom')
        },
    }
    const call = execOf(fake, { callId: 'c-hostile', name: 'read', arguments: hostile })

    assert.deepEqual(await fake.waterfall('tools/pre-execute', call, () => ({ kind: 'allow' })), { kind: 'allow' })
    fake.emit('tools/result', [call, { isError: false, content: { get toJSON(): never { throw new Error('nope') } } }])

    const rows = rowsOf(fake)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.argsDigest, '')
    assert.equal(rows[0]?.argsSummary, '[unserializable arguments]')
    assert.equal(rows[0]?.note, 'args-unserializable')
    assert.equal(rows[1]?.resultDigest, '')
    assert.equal(rows[1]?.note, 'result-unserializable')
    assert.equal(rows[1]?.isError, false)

    // A throwing writer is contained too: a directory where the file belongs.
    const broken = host()
    fs.mkdirSync(path.join(broken.cwd, '.dsh', 'audit', `${SESSION}.jsonl`), { recursive: true })
    assert.deepEqual(await pre(broken, { callId: 'c1', name: 'read' }), { kind: 'allow' })
    fake.dispose()
    broken.dispose()
})

test('agent/pre-step attributes rows to a turn and session/disposed drops the state', async () => {
    const fake = host()
    await step(fake, 4)
    await pre(fake, { callId: 'c-turn', name: 'read' })
    assert.equal((rowsOf(fake)[0] as Row).turn, 4)

    // After disposal the in-flight entry is gone: no turn, no duration.
    fake.emit('session/disposed', { id: SESSION })
    const payload = execOf(fake, { callId: 'c-turn', name: 'read' })
    fake.emit('tools/result', [payload, { isError: false, content: 'ok' }])
    const resultRow = rowsOf(fake).find((row) => row.phase === 'result') as Row
    assert.equal(resultRow.durationMs, 0)
    assert.equal(resultRow.turn, undefined)

    // A string payload and a session-like payload are both accepted.
    fake.emit('session/disposed', SESSION)
    fake.emit('session/disposed', { session: { id: SESSION } })
    fake.dispose()
})

test('dispose clears every listener, tool and the in-memory state', async () => {
    const fake = host()
    await step(fake, 2)
    await pre(fake, { callId: 'c1', name: 'read' })
    assert.equal(rowsOf(fake).length, 1)

    fake.dispose()
    for (const [event, listeners] of fake.listeners) {
        assert.equal(listeners.length, 0, `${event} still has listeners`)
    }
    assert.equal(fake.tools.size, 0)

    const before = rowsOf(fake).length
    assert.deepEqual(await pre(fake, { callId: 'c-after', name: 'read' }), { kind: 'allow' })
    fake.emit('tools/result', [execOf(fake, { callId: 'c-after', name: 'read' }), { isError: false, content: 'x' }])
    assert.equal(rowsOf(fake).length, before)
})

test('trackTools / ignoreTools narrow what is recorded', async () => {
    const only = host({ trackTools: ['write'] })
    await pre(only, { callId: 'c-read', name: 'read' })
    await pre(only, { callId: 'c-write', name: 'write', arguments: { file_path: 'a.txt' } })
    assert.deepEqual(
        rowsOf(only).map((row) => row.callId),
        ['c-write'],
    )

    const skip = host({ ignoreTools: ['bash'] })
    await pre(skip, { callId: 'c-bash', name: 'bash' })
    await pre(skip, { callId: 'c-edit', name: 'edit', arguments: { file_path: 'a.txt' } })
    assert.deepEqual(
        rowsOf(skip).map((row) => row.callId),
        ['c-edit'],
    )
    only.dispose()
    skip.dispose()
})

test('the result observer accepts the two-argument host emission too', async () => {
    const fake = host()
    const call = execOf(fake, { callId: 'c2', name: 'read' })
    await fake.waterfall('tools/pre-execute', call, () => ({ kind: 'allow' }))
    const listener = (fake.listeners.get('tools/result') ?? [])[0] as unknown as (exec: unknown, result: unknown) => void
    assert.equal(typeof listener, 'function')
    listener(call, { isError: true, content: [{ type: 'text', text: 'two args' }] })
    const resultRow = rowsOf(fake).find((row) => row.phase === 'result') as Row
    assert.equal(resultRow.callId, 'c2')
    assert.equal(resultRow.isError, true)
    assert.equal(resultRow.resultTail, 'two args')
    fake.dispose()
})

test('snapshots and restores binary content byte-exactly', async () => {
    const fake = host()
    await step(fake, 1)
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41])
    const target = path.join(fake.cwd, 'blob.bin')
    fs.writeFileSync(target, bytes)

    await pre(fake, { callId: 'c-bin', name: 'write', arguments: { file_path: 'blob.bin', content: 'text' } })
    const snapshot = (rowsOf(fake)[0] as Row).snapshot as SnapRecord
    assert.equal(snapshot.digest, sha256(bytes))
    assert.deepEqual([...fs.readFileSync(snapshot.snapshotPath)], [...bytes])

    fs.writeFileSync(target, Buffer.from([0x01, 0x02]))
    await fake.runTool('audit_rewind', { turn: 1, dryRun: false, confirm: true })
    assert.deepEqual([...fs.readFileSync(target)], [...bytes])
    fake.dispose()
})

test('a custom layout rootDir keeps the trail out of .dsh', async () => {
    const fake = host({ layout: { rootDir: '.audit-root', auditDir: '.audit-root/audit' } })
    const trail = path.join(fake.cwd, '.audit-root', 'audit', `${SESSION}.jsonl`)
    await pre(fake, { callId: 'c1', name: 'read' })
    assert.equal(fs.existsSync(trail), true)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh')), false)

    // The trail's own root is never snapshotted.
    writeFile(path.join(fake.cwd, '.audit-root', 'audit', 'x.txt'), 'v0')
    await pre(fake, { callId: 'c2', name: 'write', arguments: { file_path: '.audit-root/audit/x.txt', content: 'v1' } })
    const row = readJsonl<Row>(trail).find((entry) => entry.callId === 'c2') as Row
    assert.equal(row.snapshot?.reason, 'internal')
    assert.equal(row.snapshot?.snapshotPath, '')
    fake.dispose()
})

test('a turn learned from agent/inbox/claimed makes a snapshot rollbackable (regression)', async () => {
    const fake = host()
    // No agent/pre-step at all: an SDK-driven session only emits this one.
    fake.emit('agent/inbox/claimed', { agent: fake.agent, message: { id: 'm1' }, turn: 7 })
    const target = path.join(fake.cwd, 'src', 'claimed.ts')
    writeFile(target, 'before\n')
    await pre(fake, { name: 'write', arguments: { file_path: 'src/claimed.ts', content: 'after\n' } })
    writeFile(target, 'after\n')

    const dry = runText(await fake.runTool('audit_rewind', { turn: 7, dryRun: true }))
    assert.match(dry, /src\/claimed\.ts/)
    assert.doesNotMatch(dry, /没有可回滚项/)

    const applied = runText(await fake.runTool('audit_rewind', { turn: 7, dryRun: false, confirm: true }))
    assert.match(applied, /src\/claimed\.ts/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'before\n')
})

test('since/sinceMinutes roll back snapshots that have no turn number (regression)', async () => {
    const fake = host()
    const target = path.join(fake.cwd, 'src', 'untimed.ts')
    writeFile(target, 'before\n')
    // No turn signal at all: the row is recorded with ts only.
    await pre(fake, { name: 'write', arguments: { file_path: 'src/untimed.ts', content: 'after\n' } })
    writeFile(target, 'after\n')

    const notByTurn = runText(await fake.runTool('audit_rewind', { turn: 1, dryRun: true }))
    assert.match(notByTurn, /没有可回滚项|缺少轮次信息/)

    const since = new Date(Date.now() - 60_000).toISOString()
    const dry = runText(await fake.runTool('audit_rewind', { since, dryRun: true }))
    assert.match(dry, /src\/untimed\.ts/)

    const applied = runText(await fake.runTool('audit_rewind', { sinceMinutes: 5, dryRun: false, confirm: true }))
    assert.match(applied, /src\/untimed\.ts/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'before\n')

    // An unparseable timestamp is refused instead of silently rolling back everything.
    const bad = await fake.runTool('audit_rewind', { since: 'not-a-date', dryRun: true })
    assert.equal(bad.isError, true)
    assert.match(String(bad.content), /不是可解析的时间戳/)
    const neither = await fake.runTool('audit_rewind', { dryRun: true })
    assert.equal(neither.isError, true)
    assert.match(String(neither.content), /since/)
})

test('a project-level snapshot switch applies to its own workspace only (regression)', async () => {
    // One dsh process serves several repositories: the workspace owns its audit
    // settings, so A may turn the snapshot chain off without muting B.
    const cwdA = tempWorkspace('audit-trail-proj-a-')
    const cwdB = tempWorkspace('audit-trail-proj-b-')
    projectConfig(cwdA, { snapshot: { enabled: false } })
    const fake = host()
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')
    writeFile(path.join(cwdA, 'src', 'a.ts'), 'a0')
    writeFile(path.join(cwdB, 'src', 'a.ts'), 'b0')

    await pre(fake, { callId: 'c-a', name: 'write', arguments: { file_path: 'src/a.ts', content: 'a1' } }, { kind: 'allow' }, agentA)
    await pre(fake, { callId: 'c-b', name: 'write', arguments: { file_path: 'src/a.ts', content: 'b1' } }, { kind: 'allow' }, agentB)

    const rowsA = rowsAt(cwdA, 'session-a')
    assert.equal(rowsA.length, 1, 'A still records the call — the project only narrowed the policy')
    assert.equal(rowsA[0]?.snapshot, undefined, 'A opted out of the snapshot chain')
    assert.equal(fs.existsSync(path.join(cwdA, '.dsh', 'audit', 'snapshots')), false)

    const rowsB = rowsAt(cwdB, 'session-b')
    assert.equal(rowsB.length, 1)
    const shot = rowsB[0]?.snapshot as SnapRecord
    assert.equal(shot.reason, undefined, 'B has no project file: the profile policy applies')
    assert.equal(shot.existed, true)
    assert.equal(shot.digest, sha256('b0'))
    assert.equal(fs.readFileSync(shot.snapshotPath, 'utf8'), 'b0')
    fake.dispose()
})

test('a project-level snapshot.maxFileBytes is the limit that decides (regression)', async () => {
    // The two limits differ on purpose: 4 bytes in A, 10 KiB in the profile.
    // A file of 10 bytes proves which one was applied in each workspace.
    const cwdA = tempWorkspace('audit-trail-limit-a-')
    const cwdB = tempWorkspace('audit-trail-limit-b-')
    projectConfig(cwdA, { snapshot: { maxFileBytes: 4 } })
    const fake = host({ snapshot: { maxFileBytes: 10 * 1024 } })
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')
    writeFile(path.join(cwdA, 'big.txt'), '0123456789')
    writeFile(path.join(cwdB, 'big.txt'), '0123456789')

    await pre(fake, { callId: 'c-a', name: 'write', arguments: { file_path: 'big.txt', content: 'x' } }, { kind: 'allow' }, agentA)
    await pre(fake, { callId: 'c-b', name: 'write', arguments: { file_path: 'big.txt', content: 'x' } }, { kind: 'allow' }, agentB)

    const skipped = rowsAt(cwdA, 'session-a')[0]?.snapshot as SnapRecord
    assert.equal(skipped.reason, 'oversize', 'A used its own (narrower) limit')
    assert.equal(skipped.bytes, 10)
    assert.equal(skipped.snapshotPath, '')

    const kept = rowsAt(cwdB, 'session-b')[0]?.snapshot as SnapRecord
    assert.equal(kept.reason, undefined, 'the profile limit would have allowed this file')
    assert.equal(kept.digest, sha256('0123456789'))
    fake.dispose()
})

test('a project-level ignoreTools silences a tool in that workspace only (regression)', async () => {
    const cwdA = tempWorkspace('audit-trail-ignore-a-')
    const cwdB = tempWorkspace('audit-trail-ignore-b-')
    projectConfig(cwdA, { ignoreTools: ['read'] })
    const fake = host()
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')

    await pre(fake, { callId: 'a-read', name: 'read', arguments: { file_path: 'a.ts' } }, { kind: 'allow' }, agentA)
    await pre(fake, { callId: 'b-read', name: 'read', arguments: { file_path: 'a.ts' } }, { kind: 'allow' }, agentB)
    assert.deepEqual(rowsAt(cwdA, 'session-a').map((row) => row.tool), [], 'A ignores read')
    assert.deepEqual(rowsAt(cwdB, 'session-b').map((row) => row.tool), ['read'], 'B keeps recording it')

    // A narrowed key must not mute the workspace altogether.
    await pre(fake, { callId: 'a-bash', name: 'bash', arguments: { command: 'ls' } }, { kind: 'allow' }, agentA)
    assert.deepEqual(rowsAt(cwdA, 'session-a').map((row) => row.tool), ['bash'])
    fake.dispose()
})

test('host-only keys in a project file never relocate or mute the trail (regression)', async () => {
    const cwd = tempWorkspace('audit-trail-hostonly-')
    const movedAudit = path.join(cwd, 'moved-audit')
    const movedRoot = path.join(cwd, 'moved-root')
    projectConfig(cwd, {
        enabled: false,
        logFile: path.join(cwd, 'evil.log'),
        rootDir: movedRoot,
        auditDir: movedAudit,
        prompt: { enabled: true },
    })
    const fake = host({}, cwd)
    await pre(fake, { callId: 'c1', name: 'read', arguments: { file_path: 'a.ts' } })

    // The plugin still runs and still writes to the profile's location…
    assert.equal(rowsOf(fake).length, 1)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'audit', `${SESSION}.jsonl`)), true)
    assert.equal(fs.existsSync(movedAudit), false)
    assert.equal(fs.existsSync(movedRoot), false)
    assert.equal(fs.existsSync(path.join(cwd, 'evil.log')), false)
    // …the prompt section stays a profile decision…
    assert.equal(fake.sections.length, 0)
    // …and every refusal is stated with its reason, never silently dropped.
    const log = fs.readFileSync(path.join(cwd, 'audit-trail.log'), 'utf8')
    for (const key of ['enabled', 'logFile', 'rootDir', 'auditDir', 'prompt']) {
        assert.match(log, new RegExp(`键 "${key}" 只能由 profile 决定`), `the refusal of "${key}" must be logged`)
    }
    assert.match(log, /项目不能关掉对自己工作区的审计/)
    fake.dispose()
})

test('a malformed project file falls back to the profile configuration (regression)', async () => {
    const cwd = tempWorkspace('audit-trail-badcfg-')
    projectConfig(cwd, {}, '{ not json')
    const fake = host({}, cwd)
    writeFile(path.join(cwd, 'src', 'a.ts'), 'v0')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'src/a.ts', content: 'v1' } })

    const rows = rowsOf(fake)
    assert.equal(rows.length, 1, 'a malformed file must not stop the audit')
    const shot = rows[0]?.snapshot as SnapRecord
    assert.equal(shot.reason, undefined, 'the profile snapshot policy is still in force')
    assert.equal(shot.digest, sha256('v0'))
    assert.match(fs.readFileSync(path.join(cwd, 'audit-trail.log'), 'utf8'), /不是合法 JSON/)

    // A wrong-typed value is rejected key by key (never coerced): the profile
    // values stay in force and each problem is logged.
    projectConfig(cwd, { snapshot: { enabled: 'no' }, maxResultTail: 0, ignoreTools: 'read' })
    await pre(fake, { callId: 'c2', name: 'read', arguments: { file_path: 'src/a.ts' } })
    assert.deepEqual(rowsOf(fake).map((row) => row.tool), ['write', 'read'])
    const log = fs.readFileSync(path.join(cwd, 'audit-trail.log'), 'utf8')
    assert.match(log, /键 "snapshot\.enabled" 必须是布尔值/)
    assert.match(log, /键 "maxResultTail" 必须是正整数/)
    assert.match(log, /键 "ignoreTools" 必须是字符串数组/)
    fake.dispose()
})

test('audit_report and audit_rewind name the config source and the effective policy (regression)', async () => {
    const cwdA = tempWorkspace('audit-trail-report-a-')
    const cwdB = tempWorkspace('audit-trail-report-b-')
    const fileA = projectConfig(cwdA, { snapshot: { enabled: false, maxFilesPerTurn: 3 } })
    const fake = host()
    const agentA = fakeAgent(cwdA, 'agent-a', 'session-a')
    const agentB = fakeAgent(cwdB, 'agent-b', 'session-b')
    await pre(fake, { callId: 'c-a', name: 'read', arguments: { file_path: 'a.ts' } }, { kind: 'allow' }, agentA)
    await pre(fake, { callId: 'c-b', name: 'read', arguments: { file_path: 'a.ts' } }, { kind: 'allow' }, agentB)

    const reportA = runText(await fake.runTool('audit_report', {}, { agent: agentA }))
    assert.match(reportA, /配置来源：项目级/)
    assert.ok(reportA.includes(fileA), `the report must name the project file:\n${reportA}`)
    assert.match(reportA, /生效快照策略：snapshot\.enabled=false，maxFileBytes=1048576，maxFilesPerTurn=3/)
    const rewindA = runText(await fake.runTool('audit_rewind', { turn: 0 }, { agent: agentA }))
    assert.match(rewindA, /配置来源：项目级/)
    assert.match(rewindA, /生效快照策略：snapshot\.enabled=false/)

    const reportB = runText(await fake.runTool('audit_report', {}, { agent: agentB }))
    assert.match(reportB, /配置来源：profile/)
    assert.match(reportB, /生效快照策略：snapshot\.enabled=true/)
    fake.dispose()
})

test('an undeclared workspace never gets the trail written elsewhere (regression)', async () => {
    // The old code fell back to `process.cwd()`: a session that named no
    // workspace had its audit trail written into the harness's own directory —
    // i.e. into a different project.
    const harnessDir = tempWorkspace('audit-harness-')
    const previous = process.cwd()
    process.chdir(harnessDir)
    try {
        const homeless = { id: 'agent-h', session: { id: 'session-h', header: { id: 'session-h' } } }
        const fake = host({}, harnessDir)
        // `pre` drives the waterfall properly (a bare emit would call the
        // listener without its `next`).
        await pre(fake, { name: 'write', arguments: { file_path: 'src/a.ts' } }, { kind: 'allow' }, homeless)
        fake.emit('tools/result', [
            { ...execOf(fake, { name: 'write' }, homeless), callId: 'call-1' },
            { isError: false, content: [{ type: 'text', text: 'ok' }] },
        ] as never)
        // Nothing was written from the unnamed session — least of all here.
        assert.equal(fs.existsSync(path.join(harnessDir, '.dsh')), false)
        const rows = rowsOf(fake, 'session-h')
        assert.equal(rows.length, 0)
    } finally {
        process.chdir(previous)
    }
})

test('audit tools refuse an undeclared workspace instead of rewinding the harness dir (regression)', async () => {
    const harnessDir = tempWorkspace('audit-harness-tools-')
    const previous = process.cwd()
    process.chdir(harnessDir)
    try {
        const fake = host({}, harnessDir)
        const homeless = { id: 'agent-h2', session: { id: 'session-h2', header: { id: 'session-h2' } } }
        const report = await fake.runTool('audit_report', {}, { agent: homeless })
        assert.equal(report.isError, true)
        assert.match(String(report.content), /无法确定本会话的工作区/)
        const rewind = await fake.runTool('audit_rewind', { turn: 1, dryRun: true }, { agent: homeless })
        assert.equal(rewind.isError, true)
        assert.match(String(rewind.content), /无法确定本会话的工作区/)
        // Nothing was read from, or written to, the harness's directory.
        assert.equal(fs.existsSync(path.join(harnessDir, '.dsh')), false)
    } finally {
        process.chdir(previous)
    }
})

test('a creation written immediately after the record is still compensated (regression)', async () => {
    // The old guard allowed only 5 ms between the journal row and the file's
    // mtime, but the row is written at pre-execute — before the write. Measured
    // jitter reaches ~5 ms under load, which made the ordinary case (write right
    // after the hook returns) intermittently look like "modified later", so the
    // compensation was skipped and the rewind reported one item instead of two.
    const fake = host()
    await step(fake, 9)
    const created = path.join(fake.cwd, 'fresh.txt')
    await pre(fake, { callId: 'c1', name: 'write', arguments: { file_path: 'fresh.txt', content: 'v1' } })

    // Deterministically reproduce the jitter: 25 ms after the record, inside the
    // old 5 ms tolerance's blind spot and well inside the new one.
    await new Promise((resolve) => setTimeout(resolve, 25))
    fs.writeFileSync(created, 'v1')

    const dry = runText(await fake.runTool('audit_rewind', { turn: 9 }))
    assert.match(dry, /删除 fresh\.txt/, `the creation must still be compensated: ${dry}`)
    assert.doesNotMatch(dry, /将跳过删除/)
    const done = runText(await fake.runTool('audit_rewind', { turn: 9, dryRun: false, confirm: true }))
    assert.match(done, /已执行 1 项补偿/)
    assert.equal(fs.existsSync(created), false)
})

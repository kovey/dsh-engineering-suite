/**
 * dsh-spec-gate 的信任根运行时兜底（AC-002）。
 *
 * 纯函数部分（`fingerprint` / `classifyTool` / `evaluate`）先钉住判定，再由
 * `createTrustRootWatch` 钉住"违规落盘 + 粘性拒绝"，最后用 fake ctx 发
 * `tools/result` 事件，证明薄壳与 `guard()` 真的连在一起：
 *  - 非套件工具改了信任根 → 一行违规 JSONL + interaction 通知 + 后续写被拒；
 *  - 套件工具改了信任根 → 不告警、刷新基线（下一次外来改动仍能被发现）；
 *  - 新 mission 审批成功 → 解除拒绝（否则只能重启进程）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { policyFingerprint } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { mountTrustRootWatch } from '../dist/trust-root-events.js'
import { classifyTool, createTrustRootWatch, evaluate, fingerprint } from '../dist/trust-root-watch.js'

const ROOT = path.join('.dsh', 'engineering-suite')
const VIOLATIONS = path.join(ROOT, 'state', 'trust-root-violations.jsonl')

/** A workspace whose trust root exists and holds one hashed `.json` file. */
function workspaceWithTrustRoot(): string {
    const cwd = tempWorkspace('spec-gate-trust-')
    fs.mkdirSync(path.join(cwd, ROOT), { recursive: true })
    fs.writeFileSync(path.join(cwd, ROOT, 'spec-gate.json'), '{"enforce":true}\n')
    return cwd
}

/** Add (or rewrite) one trust-root configuration file. */
function writeTrustFile(cwd: string, name: string, body = '{"enabled":true}\n'): void {
    fs.writeFileSync(path.join(cwd, ROOT, name), body)
}

/** Rows of the violation ledger, when it exists. */
function violationRows(cwd: string): { tool: string; workspace: string; changed: { path: string; change: string }[] }[] {
    const file = path.join(cwd, VIOLATIONS)
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { tool: string; workspace: string; changed: { path: string; change: string }[] })
}

/** A fake interaction registry that records what it was asked to send. */
function recordingRegistry(): { sent: { name: string; message: unknown }[]; registry: unknown } {
    const sent: { name: string; message: unknown }[] = []
    const registry = {
        list: () => [{ name: 'chat', canAsk: false, canNotify: true, reason: '', order: 0 }],
        send: async (name: string, message: unknown) => {
            sent.push({ name, message })
            return { ok: true }
        },
    }
    return { sent, registry }
}

test('TC-1534 fingerprint() is the mandate fingerprint, not a second hash', () => {
    const cwd = workspaceWithTrustRoot()
    assert.equal(fingerprint(cwd).version, policyFingerprint(cwd).version)
    // Adding a trust-root config file changes the version; runtime state does not.
    const before = fingerprint(cwd)
    writeTrustFile(cwd, 'quality-gate.json')
    const after = fingerprint(cwd)
    assert.notEqual(after.version, before.version)
    fs.mkdirSync(path.join(cwd, ROOT, 'state'), { recursive: true })
    fs.writeFileSync(path.join(cwd, ROOT, 'state', 'whatever.json'), '{}')
    assert.equal(fingerprint(cwd).version, after.version, '运行时目录不参与指纹')
})

test('TC-1533 classifyTool knows the suite tools and treats unknown tools as foreign', () => {
    for (const name of ['spec_create', 'spec_amend', 'spec_approve', 'spec_status', 'test_design_review',
        'quality_gate_run', 'evidence_record', 'adr_record', 'standards_check', 'suite_init', 'suite_config',
        'mission_complete', 'release_record']) {
        assert.equal(classifyTool(name), 'suite', name)
    }
    for (const name of ['write', 'edit', 'bash', 'pwsh', 'read', 'unknown_future_tool']) {
        assert.equal(classifyTool(name), 'foreign', name)
    }
    // The configuration seam: a deployment can name its own suite tools.
    assert.equal(classifyTool('acme_gate_run'), 'foreign')
    assert.equal(classifyTool('acme_gate_run', ['acme_gate_run']), 'suite')
})

test('TC-1533/1534 evaluate() is pure: changed+foreign is a violation, changed+suite is a refresh', () => {
    const cwd = workspaceWithTrustRoot()
    const before = fingerprint(cwd)
    writeTrustFile(cwd, 'quality-gate.json')
    const after = fingerprint(cwd)

    const violation = evaluate(before, after, 'write')
    assert.equal(violation.kind, 'violation')
    if (violation.kind === 'violation') {
        assert.deepEqual(violation.changed.map((change) => change.path), ['.dsh/engineering-suite/quality-gate.json'])
        assert.equal(violation.changed[0]?.change, 'added')
    }
    assert.deepEqual(evaluate(before, after, 'quality_gate_run'), { kind: 'refresh' })
    assert.deepEqual(evaluate(after, after, 'bash'), { kind: 'none' })
})

test('TC-1533 a foreign tool changing the trust root records one violation and sticks', () => {
    const cwd = workspaceWithTrustRoot()
    const watch = createTrustRootWatch({ cwd, now: () => 1_700_000_000_000 })
    watch.ensureBaseline(cwd)
    writeTrustFile(cwd, 'quality-gate.json')

    assert.equal(watch.observe({ tool: 'write', cwd }).kind, 'violation')
    const rows = violationRows(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.tool, 'write')
    assert.equal(rows[0]?.workspace, cwd)
    assert.deepEqual(rows[0]?.changed.map((change) => change.path), ['.dsh/engineering-suite/quality-gate.json'])
    assert.ok(watch.breach() !== undefined)
    assert.match(watch.guard().reason() ?? '', /信任根在套件之外被修改/)
    assert.match(watch.guard().reason() ?? '', /需要重新审批 mission/)

    // The breach is STICKY: a later tool that changes nothing does not clear it.
    assert.equal(watch.observe({ tool: 'bash', cwd }).kind, 'none')
    assert.ok(watch.guard().reason() !== undefined)
    // ... and only an explicit clear (a NEW mission approval) drops it.
    watch.clear()
    assert.equal(watch.guard().reason(), undefined)
})

test('TC-1534 a suite tool changing the trust root refreshes the baseline instead of alarming', () => {
    const cwd = workspaceWithTrustRoot()
    const watch = createTrustRootWatch({ cwd })
    watch.ensureBaseline(cwd)
    writeTrustFile(cwd, 'standards-baseline.json', '{"version":1}\n')

    assert.deepEqual(watch.observe({ tool: 'standards_check', cwd }), { kind: 'refresh' })
    assert.equal(watch.breach(), undefined)
    assert.deepEqual(violationRows(cwd), [])

    // The refresh is real: a later foreign change is compared against the NEW
    // baseline, so it is still detected (no permanent blind spot).
    writeTrustFile(cwd, 'spec-gate.json', '{"enforce":false}\n')
    assert.equal(watch.observe({ tool: 'write', cwd }).kind, 'violation')
    assert.equal(violationRows(cwd).length, 1)
})

test('TC-1533 the violation is pushed through the optional interaction registry', async () => {
    const cwd = workspaceWithTrustRoot()
    const { sent, registry } = recordingRegistry()
    const watch = createTrustRootWatch({ cwd, interaction: () => registry })
    watch.ensureBaseline(cwd)
    writeTrustFile(cwd, 'quality-gate.json')
    watch.observe({ tool: 'write', cwd })
    // The push is fire-and-forget; one macrotask is enough for the fake send.
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.name, 'chat')
    const message = sent[0]?.message as { kind: string; title: string; body: string }
    assert.equal(message.kind, 'notify')
    assert.match(message.title, /信任根/)
    assert.match(message.body, /quality-gate\.json/)
})

test('TC-1533 the event shell wires tools/result to the watcher and guard refuses writes', () => {
    const cwd = workspaceWithTrustRoot()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    // Both event spellings are observed; a host with only one still reports.
    assert.equal(fake.listeners.get('tools/result')?.length, 1)
    assert.equal(fake.listeners.get('tool/result')?.length, 1)

    const write = { name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }
    // A read-only call seeds the baseline before anything else runs (that is how
    // "before" is a real observation rather than a post-hoc guess).
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }), undefined)
    writeTrustFile(cwd, 'quality-gate.json')
    fake.emit('tools/result', { exec: { name: 'write', agent: fake.agent }, result: { isError: false, content: [] } })

    assert.equal(violationRows(cwd).length, 1)
    const denied = fake.guardReason(write) ?? ''
    assert.match(denied, /信任根在套件之外被修改/)
    assert.match(denied, /需要重新审批 mission/)
    // Reads stay allowed: the breach refuses WRITES, it does not freeze the session.
    assert.equal(fake.guardReason({ name: 'read', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }), undefined)
    // A shell tool is write-CAPABLE even when its command attributes no target
    // (`ls`): that blind spot is exactly why the runtime fallback exists.
    assert.match(fake.guardReason({ name: 'bash', arguments: { command: 'ls' }, agent: fake.agent }) ?? '', /信任根在套件之外被修改/)
    fake.dispose()
})

test('TC-1534 a suite tool completing changes nothing for the guard (no false positive)', () => {
    const cwd = workspaceWithTrustRoot()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    fake.guardReason({ name: 'read', arguments: {}, agent: fake.agent })
    writeTrustFile(cwd, 'quality-gate.json')
    fake.emit('tools/result', { exec: { name: 'suite_config', agent: fake.agent }, result: { isError: false, content: [] } })

    assert.deepEqual(violationRows(cwd), [])
    // The write is still refused, but for the ordinary reason (no mission), not
    // for a breach the fallback invented.
    const denied = fake.guardReason({ name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }) ?? ''
    assert.match(denied, /没有已登记的规格/)
    assert.doesNotMatch(denied, /信任根在套件之外被修改/)
    fake.dispose()
})

test('TC-1533 a successful spec_approve clears the breach; a disposed watcher stops observing', () => {
    const cwd = workspaceWithTrustRoot()
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    const write = { name: 'write', arguments: { file_path: 'src/a.ts' }, agent: fake.agent }
    fake.guardReason({ name: 'read', arguments: {}, agent: fake.agent })
    writeTrustFile(cwd, 'quality-gate.json')
    fake.emit('tools/result', { exec: { name: 'write', agent: fake.agent }, result: { isError: false } })
    assert.match(fake.guardReason(write) ?? '', /信任根在套件之外被修改/)

    // A NEW mission being approved is the one thing that re-authorises writes.
    fake.emit('tools/result', {
        exec: { name: 'spec_approve', agent: fake.agent },
        result: { isError: false, content: [{ type: 'text', text: '规格已审批（mission m-1，by approval）。' }] },
    })
    assert.doesNotMatch(fake.guardReason(write) ?? '', /信任根在套件之外被修改/)

    // Teardown unregisters the listeners: a later change cannot resurrect a breach.
    fake.dispose()
    const rows = violationRows(cwd).length
    writeTrustFile(cwd, 'deploy-gate.json')
    fake.emit('tools/result', { exec: { name: 'write', agent: fake.agent }, result: { isError: false } })
    assert.equal(violationRows(cwd).length, rows)
})

test('the mount itself seeds the configured cwd (a fresh watcher has a baseline)', () => {
    const cwd = workspaceWithTrustRoot()
    const fake = createFakeHost({ cwd })
    const watch = mountTrustRootWatch(fake.ctx as never, { cwd })
    assert.ok(watch.baseline(cwd) !== undefined)
    watch.dispose()
    assert.equal(fake.listeners.get('tools/result')?.length, 0)
    assert.equal(fake.listeners.get('tool/result')?.length, 0)
})

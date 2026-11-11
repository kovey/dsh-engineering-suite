/**
 * `imApprovalSurface` — the probe the gate-authorisation kernel's BINARY surface
 * needs (AC-005 of `eng-core-im-tui-desktop-web-neve-20261111-111939`).
 *
 * Two facts must not be confused here, and the tests pin the difference:
 *
 *  - "an IM card can carry an approval for this workspace" (this probe), and
 *  - "this plugin answers the HOST's `approval/request` waterfall"
 *    (`im.approvalVia=off|fallback|only`, unchanged by this feature).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, fakeAgent, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply, createInteractionRegistry, imApprovalSurface } from '../dist/index.js'

const LOG = 'interaction-gate.log'

test('no interaction service → unavailable, with a reason (never a silent "no")', () => {
    const report = imApprovalSurface({ get: () => undefined }, '/repo')
    assert.equal(report.available, false)
    assert.match(report.reason, /interaction/, report.reason)
    assert.equal(report.chatId, undefined)
})

test('a ctx without get() is reported, not thrown', () => {
    const report = imApprovalSurface({}, '/repo')
    assert.equal(report.available, false)
    assert.match(report.reason, /get\(\)/)
})

test('a registered IM channel that can ASK is available, with the approval target', () => {
    const registry = createInteractionRegistry({ now: () => 1_000 })
    registry.register({
        name: 'chat-interaction',
        send: async () => ({ ok: true, messageId: 'om_1' }),
        wait: async () => null,
        describe: () => ({ canAsk: true, canNotify: true }),
    })
    registry.setIm({
        mode: 'auto',
        phase: 'registered',
        registered: true,
        name: 'chat-interaction',
        approvalChatId: 'oc_approvals',
        approvalVia: 'fallback',
        reason: 'chat-interaction 已注册',
    })
    const report = imApprovalSurface({ get: (name: string) => (name === 'interaction' ? registry : undefined) }, '/repo')
    assert.equal(report.available, true, report.reason)
    assert.equal(report.chatId, 'oc_approvals')
    assert.match(report.reason, /chat-interaction/)
})

test('a channel that can only PUSH is not an approval surface (it cannot receive a decision)', () => {
    const registry = createInteractionRegistry({ now: () => 1_000 })
    // No wait() on the channel instance: the registry reports canAsk=false.
    registry.register({ name: 'chat-interaction', send: async () => ({ ok: true }), describe: () => ({ canAsk: true, canNotify: true }) })
    registry.setIm({ mode: 'auto', phase: 'registered', registered: true, name: 'chat-interaction', reason: '已注册' })
    const report = imApprovalSurface({ get: () => registry }, '/repo')
    assert.equal(report.available, false)
    assert.match(report.reason, /canAsk=false/, report.reason)
})

test('an unregistered IM channel says WHY (phase + reason) instead of just "unavailable"', () => {
    const registry = createInteractionRegistry({ now: () => 1_000 })
    registry.setIm({ mode: 'auto', phase: 'absent', registered: false, reason: '没有发现可用的 chat-interaction 服务', approvalChatId: 'oc_approvals' })
    const report = imApprovalSurface({ get: () => registry }, '/repo')
    assert.equal(report.available, false)
    assert.match(report.reason, /phase=absent/)
    assert.match(report.reason, /没有发现可用的 chat-interaction 服务/)
    // The configured target is still reported: it is a fact an operator needs.
    assert.equal(report.chatId, 'oc_approvals')
})

test('an older service without the IM report is still probed from its channel list', () => {
    const report = imApprovalSurface(
        {
            get: () => ({
                list: () => [{ name: 'chat-interaction', canAsk: true, canNotify: true, reason: '', order: 0 }],
            }),
        },
        '/repo',
    )
    assert.equal(report.available, true, report.reason)
    assert.match(report.reason, /chat-interaction/)
})

test('the probe does not change approvalVia semantics: off still registers no answerer, and IM stays probeable', () => {
    const cwd = tempWorkspace('interaction-probe-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG), im: { approvalVia: 'off' } })

    // `off` = zero behaviour change on the host seam (the existing contract):
    // no `approval/request` listener is registered at all.
    assert.equal((fake.listeners.get('approval/request') ?? []).length, 0, 'approvalVia=off must not register an approval/request answerer')

    // …and the probe is about the CARD surface, not the host waterfall: an IM
    // channel that can ask is still a usable binary approval surface.
    const report = imApprovalSurface(
        {
            get: () => ({
                im: () => ({ registered: true, phase: 'registered', name: 'chat-interaction', approvalVia: 'off', reason: '已注册' }),
                list: () => [{ name: 'chat-interaction', canAsk: true, canNotify: true, reason: '', order: 0 }],
            }),
        },
        cwd,
    )
    assert.equal(report.available, true, report.reason)
    fake.dispose()
})

test('apply() still works with the probe exported (the plugin surface is unchanged)', async () => {
    const cwd = tempWorkspace('interaction-probe-apply-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG) })
    assert.deepEqual(
        [...fake.tools.keys()].sort(),
        ['interaction_ask', 'interaction_notify', 'interaction_progress', 'interaction_status'],
    )
    // The service the probe reads is provided by this plugin.
    const service = (fake.ctx as unknown as { get: (name: string) => unknown }).get('interaction')
    assert.notEqual(service, undefined)
    const report = imApprovalSurface(fake.ctx as never, cwd)
    assert.equal(typeof report.available, 'boolean')
    assert.notEqual(report.reason, '')
    // `interaction_status` renders the same facts for a human.
    const status = runText(await fake.runTool('interaction_status', {}, { agent: fakeAgent(cwd) }))
    assert.match(status, /IM/)
    fake.dispose()
})

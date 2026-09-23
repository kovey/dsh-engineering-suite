import assert from 'node:assert/strict'
import test from 'node:test'
import {
    approverName,
    normalizeApprovalReply,
    parseApprovalContext,
    proseOf,
    renderApprovalContext,
} from '../dist/index.js'

test('the legacy string reply keeps working (regression)', () => {
    const allowed = normalizeApprovalReply('allowed-once')
    assert.equal(allowed.decision, 'allowed-once')
    assert.equal(allowed.allowed, true)
    assert.equal(allowed.by, '', 'a terminal answerer that reports no identity records none')
    assert.equal(approverName(allowed), 'approval')

    for (const decision of ['rejected', 'cancelled', 'unavailable'] as const) {
        const normalized = normalizeApprovalReply(decision)
        assert.equal(normalized.allowed, false, `${decision} never authorises anything`)
    }
})

test('an unknown reply fails closed (regression)', () => {
    // Guessing a decision out of an unreadable reply is how "nobody answered"
    // becomes "approved".
    for (const reply of [undefined, null, 42, {}, { decision: 'yes' }, [], { decision: 1 }]) {
        const normalized = normalizeApprovalReply(reply)
        assert.equal(normalized.decision, 'unavailable', JSON.stringify(reply))
        assert.equal(normalized.allowed, false)
    }
})

test('an answerer can report who decided and which card carried it (regression)', () => {
    const normalized = normalizeApprovalReply({
        decision: 'allowed-once',
        by: 'ou_im_user',
        messageId: 'om_card_1',
        at: 1_700_000_000_000,
        source: 'im',
    })
    assert.equal(normalized.allowed, true)
    assert.equal(approverName(normalized), 'ou_im_user')
    assert.equal(normalized.source, 'im')
    assert.equal(normalized.messageId, 'om_card_1')
    assert.equal(normalized.at, 1_700_000_000_000)
    // A partial object is still usable: missing provenance stays empty.
    const partial = normalizeApprovalReply({ decision: 'rejected' })
    assert.deepEqual([partial.by, partial.messageId, partial.source, partial.allowed], ['', '', 'unknown', false])
})

test('the approval context block round-trips and keeps the prose readable (regression)', () => {
    const reason = renderApprovalContext('规格审批（第 2 次送审）：Add health endpoint', {
        kind: 'spec',
        missionId: 'M-1',
        revision: 3,
        artifacts: ['.dsh/specs/M-1.md'],
        facts: { 验收标准: 2, 测试用例: 3 },
        channelHints: { buttons: ['通过', '打回'], requiresReason: true },
    })
    assert.match(reason, /```approval-context/)
    assert.match(reason, /"kind": "spec"/)
    const parsed = parseApprovalContext(reason)
    assert.equal(parsed?.missionId, 'M-1')
    assert.equal(parsed?.revision, 3)
    assert.deepEqual(parsed?.artifacts, ['.dsh/specs/M-1.md'])
    assert.equal(parsed?.facts?.['测试用例'], 3)
    // A text-only answerer shows the prose without the machine block.
    const prose = proseOf(reason)
    assert.match(prose, /规格审批（第 2 次送审）/)
    assert.doesNotMatch(prose, /approval-context/)
    assert.doesNotMatch(prose, /missionId/)
})

test('a reason without a context block is not an error (regression)', () => {
    assert.equal(parseApprovalContext('just prose'), undefined)
    assert.equal(parseApprovalContext('```approval-context\n{ not json }\n```'), undefined)
    assert.equal(parseApprovalContext('```approval-context\n[1,2]\n```'), undefined, 'only an object is a context')
    assert.equal(proseOf('just prose'), 'just prose')
})

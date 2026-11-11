/**
 * `dsh-eng-core` gate-authorisation kernel: one entry, two surfaces, five
 * outcomes that never merge.
 *
 * The cases below are the five reasons plus the "never auto-approve" guarantee.
 * They are written against the built `dist/` (like every other package test), so
 * a build is required before running them — `scripts/test-all.sh` does that.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    GATE_APPROVAL_OUTCOMES,
    describeGateApproval,
    gateApprovalAllowed,
    readHostApprovalPolicy,
    requestGateApproval,
    type GateApprovalInput,
    type GateApprovalResult,
    type GateSurfaceAnswer,
} from '../dist/index.js'

const DIGEST = 'a'.repeat(64)

/** The minimum a caller passes; each test overrides the surface/adapters. */
function input(overrides: Partial<GateApprovalInput> = {}): GateApprovalInput {
    return {
        toolName: 'spec_approve',
        reason: '请审批这份规格',
        surface: 'rich',
        digest: DIGEST,
        surfaces: {},
        ...overrides,
    }
}

// --- the five reasons -------------------------------------------------------

test('allowed-once: the rich card decides, and the result names who/where (AC-001/TC-1342)', async () => {
    const seen: unknown[] = []
    const result = await requestGateApproval(
        input({
            surfaces: {
                rich: async (ask) => {
                    seen.push(ask)
                    return { kind: 'answer', decision: 'allowed-once', by: 'ou_reviewer', via: 'tui-card', messageId: 'card-7' }
                },
            },
        }),
    )
    assert.equal(result.outcome, 'allowed-once')
    assert.equal(result.allowed, true)
    assert.equal(gateApprovalAllowed(result), true)
    assert.equal(result.by, 'ou_reviewer')
    assert.equal(result.via, 'tui-card')
    assert.equal(result.messageId, 'card-7')
    assert.equal(result.digest, DIGEST, 'the decision is bound to the digest that was displayed')
    // The surface receives the material's digest, so it can report what it showed.
    assert.equal((seen[0] as { digest?: string }).digest, DIGEST)
    assert.equal((seen[0] as { surface?: string }).surface, 'rich')
})

test('rejected: a person said no — the outcome is a rejection, not "nobody answered" (AC-002)', async () => {
    const result = await requestGateApproval(
        input({
            surfaces: {
                rich: async () => ({ kind: 'answer', decision: 'rejected', by: 'ou_reviewer', note: '验收标准不全' }),
            },
        }),
    )
    assert.equal(result.outcome, 'rejected')
    assert.equal(result.allowed, false)
    assert.equal(gateApprovalAllowed(result), false)
    assert.equal(result.by, 'ou_reviewer')
    assert.equal(result.note, '验收标准不全')
    assert.equal(result.problemCode, 'rejected-by-answerer')
})

test('cancelled: a withdrawn question is neither a rejection nor a pass (AC-003/TC-1346)', async () => {
    const result = await requestGateApproval(
        input({
            surfaces: {
                rich: async () => ({ kind: 'answer', decision: 'cancelled' }),
            },
        }),
    )
    assert.equal(result.outcome, 'cancelled')
    assert.equal(result.allowed, false)
    assert.equal(gateApprovalAllowed(result), false)
    assert.equal(result.problemCode, 'cancelled')
    assert.match(String(result.problem), /没有人作出决定/)
})

test('no-answerer: no surface can carry the question — nobody was asked (AC-002/AC-003, TC-1343)', async () => {
    const result = await requestGateApproval(input({ surfaces: {} }))
    assert.equal(result.outcome, 'no-answerer')
    assert.equal(result.allowed, false)
    assert.equal(result.problemCode, 'surface-unavailable')
    assert.match(String(result.problem), /没有人被问到/)
    // A rich request must never be silently downgraded to the host popup.
    assert.match(String(result.problem), /不会降级成/)
})

test('rejected-by-host-policy: the seam refused without dispatching under policy=never (AC-002/TC-1345)', async () => {
    let seamAsked = 0
    const result = await requestGateApproval(
        input({
            surface: 'binary',
            digest: undefined,
            hostPolicy: 'never',
            surfaces: {
                // No suite channel: only the host seam is left.
                hostSeam: async () => {
                    seamAsked += 1
                    return { kind: 'answer', decision: 'rejected' }
                },
            },
        }),
    )
    assert.equal(seamAsked, 1)
    assert.equal(result.outcome, 'rejected-by-host-policy')
    assert.equal(result.allowed, false)
    assert.equal(result.hostPolicy, 'never')
    assert.equal(result.problemCode, 'host-policy')
    assert.match(String(result.problem), /policy=never/)
    assert.match(describeGateApproval(result), /没有问过任何人/)
})

// --- never auto-approve -----------------------------------------------------

test('never auto-approves: policy=never does not stop a rich ask, and no fallback path grants (AC-001/TC-1341)', async () => {
    // (1) The kernel does not consult the policy to decide WHETHER to ask: a
    //     policy=never session still reaches the declared rich surface, which is
    //     how a hard gate keeps asking a person under a host auto/never stance.
    let richAsked = 0
    const asked = await requestGateApproval(
        input({
            hostPolicy: 'never',
            surfaces: {
                rich: async () => {
                    richAsked += 1
                    return { kind: 'answer', decision: 'allowed-once', by: 'ou_1', via: 'tui-card' }
                },
            },
        }),
    )
    assert.equal(richAsked, 1, 'the human was asked even though the host policy is never')
    assert.equal(asked.outcome, 'allowed-once')
    assert.equal(asked.hostPolicy, 'never')

    // (2) Every non-answer path is fail-closed.
    const cases: { label: string; run: () => Promise<GateApprovalResult> }[] = [
        { label: 'no surfaces', run: () => requestGateApproval(input({ surfaces: {} })) },
        { label: 'binary, no surfaces', run: () => requestGateApproval(input({ surface: 'binary', surfaces: {} })) },
        {
            label: 'garbage reply',
            run: () =>
                requestGateApproval(
                    input({ surfaces: { rich: (() => 'yes') as unknown as () => Promise<GateSurfaceAnswer> } }),
                ),
        },
        {
            label: 'unknown decision word',
            run: () =>
                requestGateApproval(
                    input({
                        surfaces: {
                            rich: (() => ({ kind: 'answer', decision: 'approved' })) as unknown as () => Promise<GateSurfaceAnswer>,
                        },
                    }),
                ),
        },
        {
            label: 'throwing adapter',
            run: () =>
                requestGateApproval(
                    input({
                        surfaces: {
                            rich: async () => {
                                throw new Error('channel exploded')
                            },
                        },
                    }),
                ),
        },
        {
            label: 'seam throws',
            run: () => requestGateApproval(input({ surface: 'binary', surfaces: { hostSeam: async () => Promise.reject(new Error('no seam')) } })),
        },
        {
            label: 'suite card timed out (no seam fallback)',
            run: () =>
                requestGateApproval(
                    input({
                        surface: 'binary',
                        surfaces: {
                            binary: async () => ({ kind: 'unavailable', reason: '等待超时', cardAttempted: true }),
                            hostSeam: async () => ({ kind: 'answer', decision: 'allowed-once' }),
                        },
                    }),
                ),
        },
    ]
    for (const entry of cases) {
        const result = await entry.run()
        assert.equal(result.allowed, false, `${entry.label}: must never allow`)
        assert.notEqual(result.outcome, 'allowed-once', `${entry.label}: must never be allowed-once`)
        assert.equal(gateApprovalAllowed(result), false, entry.label)
        assert.ok(result.problem !== undefined && result.problem !== '', `${entry.label}: must explain itself`)
    }

    // (3) A rich request without a digest is a caller defect: it throws rather
    //     than returning any outcome a caller could mistake for a pass.
    await assert.rejects(
        () => requestGateApproval(input({ digest: undefined, surfaces: { rich: async () => ({ kind: 'answer', decision: 'allowed-once' }) } })),
        /digest/,
    )
})

// --- digest binding ---------------------------------------------------------

test('digest drift: material changed between display and approval is refused (AC-004/TC-1344)', async () => {
    const result = await requestGateApproval(
        input({
            readDigest: () => 'b'.repeat(64),
            surfaces: {
                rich: async () => ({ kind: 'answer', decision: 'allowed-once', by: 'ou_1', via: 'tui-card' }),
            },
        }),
    )
    assert.equal(result.allowed, false)
    assert.equal(result.outcome, 'rejected')
    assert.equal(result.problemCode, 'digest-mismatch')
    assert.match(String(result.problem), /展示摘要 a{12}/)
    assert.match(String(result.problem), /批准时摘要 b{12}/)
    assert.match(String(result.problem), /重新送审/)

    // The surface can also report what it displayed; a disagreement is the same refusal.
    const reported = await requestGateApproval(
        input({
            surfaces: {
                rich: async () => ({ kind: 'answer', decision: 'allowed-once', displayedDigest: 'c'.repeat(64) }),
            },
        }),
    )
    assert.equal(reported.allowed, false)
    assert.equal(reported.problemCode, 'digest-mismatch')
})

// --- two surfaces and the seam fallback order --------------------------------

test('binary: the suite channel is asked first; the host seam only when it could not ask (AC-003)', async () => {
    const order: string[] = []
    const viaChannel = await requestGateApproval(
        input({
            surface: 'binary',
            digest: undefined,
            surfaces: {
                binary: async () => {
                    order.push('channel')
                    return { kind: 'answer', decision: 'allowed-once', by: 'ou_im', messageId: 'om_card_1' }
                },
                hostSeam: async () => {
                    order.push('seam')
                    return { kind: 'answer', decision: 'allowed-once' }
                },
            },
        }),
    )
    assert.deepEqual(order, ['channel'], 'a suite card answered: the host seam was never asked')
    assert.equal(viaChannel.outcome, 'allowed-once')
    assert.equal(viaChannel.via, 'im')
    assert.equal(viaChannel.by, 'ou_im')
    assert.equal(viaChannel.messageId, 'om_card_1')

    const order2: string[] = []
    const viaSeam = await requestGateApproval(
        input({
            surface: 'binary',
            digest: undefined,
            hostPolicy: 'ask',
            surfaces: {
                binary: async () => {
                    order2.push('channel')
                    return { kind: 'unavailable', reason: '没有注册 IM 通道' }
                },
                hostSeam: async () => {
                    order2.push('seam')
                    return { kind: 'answer', decision: 'allowed-once', by: 'terminal-user' }
                },
            },
        }),
    )
    assert.deepEqual(order2, ['channel', 'seam'], 'an unaskable channel defers to the host seam')
    assert.equal(viaSeam.outcome, 'allowed-once')
    assert.equal(viaSeam.via, 'host-seam')
})

test('the host policy is READ, never obeyed, and an unreadable policy stays a plain rejected', async () => {
    // A host service exposing `overrideOf` and `config.policy` — the two public
    // inputs of the installed approval service.
    const approval = {
        overrideOf: (session: { id: string }) => (session.id === 's-never' ? 'never' : undefined),
        config: { policy: 'ask' },
        request: async () => 'rejected',
    }
    assert.equal(readHostApprovalPolicy(approval, { session: { id: 's-never' } }), 'never')
    assert.equal(readHostApprovalPolicy(approval, { session: { id: 's-ask' } }), 'ask')
    assert.equal(readHostApprovalPolicy(undefined, undefined), undefined)
    assert.equal(readHostApprovalPolicy({ request: async () => 'rejected' }, {}), undefined)
    assert.equal(
        readHostApprovalPolicy(
            {
                overrideOf: () => {
                    throw new Error('broken service')
                },
                config: { policy: 'never' },
            },
            { session: { id: 's' } },
        ),
        'never',
        'a throwing override falls back to the configured default',
    )

    // Unknown policy + a seam rejection = plain rejected (naming a policy we did
    // not read would be a guess).
    const unknown = await requestGateApproval(
        input({ surface: 'binary', digest: undefined, surfaces: { hostSeam: async () => ({ kind: 'answer', decision: 'rejected' }) } }),
    )
    assert.equal(unknown.outcome, 'rejected')
    assert.equal(unknown.hostPolicy, undefined)
})

// --- the five outcomes stay distinguishable ---------------------------------

test('the five outcomes have five distinct sentences (AC-002)', () => {
    assert.equal(new Set(GATE_APPROVAL_OUTCOMES).size, 5)
    const sentences = GATE_APPROVAL_OUTCOMES.map((outcome) =>
        describeGateApproval({ outcome, allowed: outcome === 'allowed-once', by: outcome === 'allowed-once' ? 'ou_1' : '', at: 0 }),
    )
    assert.equal(new Set(sentences).size, 5, sentences.join('\n'))
    for (const marker of ['一次性授权', '拒绝了这次请求', '取消', '没有人被问到', '没有问过任何人']) {
        assert.ok(
            sentences.some((sentence) => sentence.includes(marker)),
            `no sentence carries ${marker}`,
        )
    }
})

/**
 * Mandate tests: the policy fingerprint (what a mandate is a statement about),
 * the approval-strength matrix (computed, never claimed), and the `legacy` view
 * of a mission approved before mandates existed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    EMPTY_POLICY_VERSION,
    approverAllowlist,
    approvalStrength,
    checkWorkspace,
    describeMandate,
    effectiveMandate,
    mandateScopeOf,
    mandateState,
    policyDifferences,
    policyFingerprint,
    policyVersion,
    scopeWidened,
    withdrawalOf,
} from '../dist/index.js'
import type { ApproverAllowlist, MissionRecord, SpecRecord } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** A workspace with a trust root containing two config files and one role file. */
function workspace(): string {
    const cwd = tempWorkspace('eng-mandate-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'roles'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), JSON.stringify({ enforce: true }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'roles', 'developer.md'), '# developer\n')
    return cwd
}

const SPEC: SpecRecord = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: [{ id: 'R-001', text: '暴露 GET /health' }],
    acceptanceCriteria: [{ id: 'AC-001', text: 'GET /health 返回 200' }],
    fileBoundaries: ['src/server.ts'],
    negativeConstraints: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    approvedAt: 2,
    approvedBy: 'approval',
}

/** A mission record as `spec_approve` leaves it (approved, with a mandate). */
function missionWith(mandate?: unknown, spec: SpecRecord = SPEC): MissionRecord {
    return {
        id: 'm-1',
        title: 'Add health endpoint',
        status: 'spec-approved',
        cwd: '/tmp/workspace',
        createdAt: 1,
        updatedAt: 2,
        spec,
        ...(mandate === undefined ? {} : { mandate: mandate as MissionRecord['mandate'] }),
    }
}

const MANDATE = {
    version: 1,
    strength: 'explicit',
    basis: 'spec-approved',
    scope: { phases: [], paths: ['src/server.ts'] },
    policyVersion: 'a'.repeat(64),
    approvedBy: 'approval',
    at: 1_700_000_000_000,
}

/** An allowlist as the strength computation expects it. */
function allowlist(configured: boolean, approvers: string[] = []): ApproverAllowlist {
    return { configured, approvers, files: configured ? ['/repo/.dsh/role-guard.json'] : [], problems: [] }
}

test('policyVersion is stable for the same trust root, and roles/*.md are part of it', () => {
    const cwd = workspace()
    const first = policyFingerprint(cwd)
    const second = policyFingerprint(cwd)
    assert.equal(first.version, second.version)
    assert.equal(first.files.length, 3, 'two .json files plus one role file')
    assert.deepEqual(
        first.files.map((file) => file.path),
        ['.dsh/quality-gate.json', '.dsh/roles/developer.md', '.dsh/spec-gate.json'],
        'sorted by posix relative path',
    )
    assert.equal(first.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)), true)
    assert.equal(policyVersion(cwd), first.version)
})

test('adding or editing a trust-root file changes the version and files[] names the path', () => {
    const cwd = workspace()
    const before = policyFingerprint(cwd)
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [{ id: 'test', command: 'go test ./...' }] }))
    const edited = policyFingerprint(cwd)
    assert.notEqual(edited.version, before.version)
    const changed = policyDifferences(before, edited)
    assert.deepEqual(changed, [{ path: '.dsh/quality-gate.json', change: 'changed' }])

    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), JSON.stringify({ languages: {} }))
    const added = policyFingerprint(cwd)
    assert.notEqual(added.version, edited.version)
    assert.deepEqual(policyDifferences(edited, added), [{ path: '.dsh/standards.json', change: 'added' }])

    fs.rmSync(path.join(cwd, '.dsh', 'standards.json'))
    assert.deepEqual(policyDifferences(added, policyFingerprint(cwd)), [{ path: '.dsh/standards.json', change: 'removed' }])
})

test('runtime directories and *.jsonl never affect the version', () => {
    const cwd = workspace()
    const before = policyVersion(cwd)
    for (const [dir, name] of [
        ['missions', 'm-1/mission.json'],
        ['audit', 'session-1.jsonl'],
        ['state', 'sessions/session-1.json'],
        ['kb', 'manifest.json'],
        ['media', 'image.json'],
        ['interaction', 'decisions.jsonl'],
        ['deploy', 'plan.json'],
    ] as const) {
        fs.mkdirSync(path.join(cwd, '.dsh', dir, path.dirname(name)), { recursive: true })
        fs.writeFileSync(path.join(cwd, '.dsh', dir, name), JSON.stringify({ noise: Date.now() }))
    }
    fs.writeFileSync(path.join(cwd, '.dsh', 'plan.jsonl'), '{"row":1}\n')
    fs.writeFileSync(path.join(cwd, '.dsh', 'roles', 'ignored.jsonl'), '{"row":2}\n')
    assert.equal(policyVersion(cwd), before, 'runtime ledgers are not policy')
    assert.equal(
        policyFingerprint(cwd).files.some((file) => file.path.includes('/missions/') || file.path.endsWith('.jsonl')),
        false,
    )
})

test('a missing trust root is one stable, documented empty version', () => {
    const first = tempWorkspace('eng-mandate-empty-')
    const second = tempWorkspace('eng-mandate-empty-')
    const fingerprint = policyFingerprint(first)
    assert.deepEqual(fingerprint.files, [])
    assert.equal(fingerprint.version, EMPTY_POLICY_VERSION)
    assert.equal(policyFingerprint(second).version, EMPTY_POLICY_VERSION)
})

test('approverAllowlist reads role-guard.json / the interaction gate list, and reports problems', () => {
    const cwd = workspace()
    assert.equal(approverAllowlist(cwd).configured, false, 'no file = no allowlist (not an empty one)')

    fs.writeFileSync(path.join(cwd, '.dsh', 'role-guard.json'), JSON.stringify({ approvers: ['alice', 'bob'] }))
    const list = approverAllowlist(cwd)
    assert.equal(list.configured, true)
    assert.deepEqual(list.approvers, ['alice', 'bob'])

    // The suite's existing approver list, honoured only when the gate requires it.
    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-approvers.txt'), '# reviewers\ncarol\n')
    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ requireApproverList: true }))
    assert.deepEqual(approverAllowlist(cwd).approvers, ['alice', 'bob', 'carol'])

    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ requireApproverList: false }))
    assert.deepEqual(approverAllowlist(cwd).approvers, ['alice', 'bob'], 'an unenforced list is not a policy')

    fs.writeFileSync(path.join(cwd, '.dsh', 'role-guard.json'), 'not json')
    const broken = approverAllowlist(cwd)
    assert.equal(broken.configured, false)
    assert.equal(broken.problems.length, 1)
    assert.match(broken.problems[0] ?? '', /role-guard\.json/)
})

test('strength matrix: allowlist, local session, subagent, IM, auto', () => {
    const local = { approvedBy: 'approval', allowlist: allowlist(false) }
    assert.equal(approvalStrength(local).strength, 'explicit', 'no allowlist + local session')

    assert.equal(approvalStrength({ approvedBy: 'alice', allowlist: allowlist(true, ['alice']) }).strength, 'explicit', 'allowlisted approver')
    const notListed = approvalStrength({ approvedBy: 'mallory', allowlist: allowlist(true, ['alice']) })
    assert.equal(notListed.strength, 'inferred', 'not allowlisted')
    assert.match(notListed.why, /允许清单/)

    // An IM click is explicit only when the allowlist names the person: the
    // list is the authority, the surface is provenance.
    assert.equal(approvalStrength({ approvedBy: 'alice', source: 'im', allowlist: allowlist(true, ['alice']) }).strength, 'explicit')
    assert.equal(approvalStrength({ approvedBy: 'ou_123', source: 'im', allowlist: allowlist(false) }).strength, 'inferred', 'IM sender')

    const subagent = {
        approvedBy: 'alice',
        allowlist: allowlist(true, ['alice']),
        agent: { id: 'child', session: { id: 'child', header: { id: 'child', cwd: '/tmp', origin: 'subagent', parentSession: 'parent' } } },
    }
    const child = approvalStrength(subagent)
    assert.equal(child.strength, 'inferred', 'a subagent approval is NEVER explicit, even when allowlisted')
    assert.match(child.why, /子代理/)

    // Auto approval: the local operator's standing configuration, but never a
    // substitute for an allowlist that names people.
    assert.equal(approvalStrength({ approvedBy: 'auto', automatic: true, allowlist: allowlist(false) }).strength, 'explicit')
    assert.equal(approvalStrength({ approvedBy: 'auto', automatic: true, allowlist: allowlist(true, ['alice']) }).strength, 'inferred')

    // An unknown non-empty surface is remote (fail closed), not local.
    assert.equal(approvalStrength({ approvedBy: 'x', source: 'web', allowlist: allowlist(false) }).strength, 'inferred')
})

test('mandateState: recorded, legacy (no record) and forged legacy', () => {
    const present = mandateState(missionWith(MANDATE))
    assert.equal(present.kind, 'present')
    assert.equal(present.kind === 'present' ? present.mandate.strength : '', 'explicit')

    const legacy = mandateState(missionWith(undefined))
    assert.equal(legacy.kind, 'legacy')
    assert.equal(effectiveMandate(missionWith(undefined))?.strength, 'legacy')
    assert.match(describeMandate(effectiveMandate(missionWith(undefined))), /legacy.*事实，不是缺陷/)

    // `legacy` is a READ view: a file claiming it must not inherit the exemption.
    const forged = mandateState(missionWith({ ...MANDATE, strength: 'legacy' }))
    assert.equal(forged.kind, 'invalid')
    assert.match(forged.kind === 'invalid' ? forged.reason : '', /legacy/)

    // A mission with no approval at all is not "legacy": nothing was authorised.
    assert.equal(mandateState(missionWith(undefined, { ...SPEC, approvedAt: undefined })).kind, 'absent')
    // A corrupt scope is invalid, never "no mandate".
    assert.equal(mandateState(missionWith({ ...MANDATE, scope: { paths: 'src' } })).kind, 'invalid')
})

test('scope: an empty list means "not narrowed", and widening is refused-safe', () => {
    assert.deepEqual(mandateScopeOf(SPEC), { phases: [], paths: ['src/server.ts'] })
    assert.deepEqual(mandateScopeOf(undefined), { phases: [], paths: [] })
    assert.deepEqual(scopeWidened({ phases: [], paths: [] }, { phases: [], paths: ['src/**'] }), [], 'not narrowed cannot be widened')
    assert.deepEqual(scopeWidened({ phases: [], paths: ['src/**'] }, { phases: [], paths: ['src/**', 'docs/**'] }), ['path:docs/**'])
    assert.deepEqual(scopeWidened({ phases: ['build'], paths: [] }, { phases: ['build', 'deploy'], paths: [] }), ['phase:deploy'])
})

test('a person\'s stop withdraws the mandate without rewriting it', () => {
    const record = missionWith(MANDATE)
    const stopped = withdrawalOf(record, { at: 5, by: 'alice', reason: '需求取消' })
    assert.ok(stopped.mandate !== undefined)
    assert.deepEqual(stopped.mandate?.withdrawn, { at: 5, by: 'alice', reason: '需求取消' })
    assert.equal(stopped.mandate?.strength, 'explicit', 'the grant itself is untouched')
    assert.match(describeMandate(stopped.mandate), /已撤回.*alice/)
    // A second stop keeps the first one; a legacy mission has nothing to withdraw.
    assert.match(withdrawalOf(missionWith(stopped.mandate), { at: 6, by: 'bob', reason: 'again' }).refusal ?? '', /保留第一次/)
    assert.match(withdrawalOf(missionWith(undefined), { at: 6, by: 'bob', reason: 'x' }).refusal ?? '', /legacy/)
})

test('the offline doctor has a mandate.policy check, and no mission is "nothing to judge"', () => {
    const cwd = workspace()
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((entry) => entry.id === 'mandate.policy')
    assert.ok(check !== undefined, 'the mandate.policy check must exist')
    assert.equal(check?.state, 'unknown', 'no mission = nothing to judge (never ok)')
    assert.match(check?.detail ?? '', /还没有 mission/)
    assert.equal(report.blockers.some((entry) => entry.id === 'mandate.policy'), false, 'unknown is not a blocker')
})

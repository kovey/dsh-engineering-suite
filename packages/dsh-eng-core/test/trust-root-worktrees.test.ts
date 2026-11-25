/**
 * A task worktree is RUNTIME state, not trust-root policy (AC-001 … AC-003).
 *
 * The real failure this pins down: `createTaskWorktree` puts the tree under
 * `<layout root>/worktrees/<mission>/<task>` — INSIDE the trust root. While
 * `worktrees` was missing from `TRUST_ROOT_RUNTIME_DIRS`, creating one changed
 * `policyFingerprint().version` (a worktree is a checkout, and a governed repo
 * commits its `.dsh/*.json` configs), so every in-flight mission's mandate
 * became stale at dispatch time: the worker's writes were refused and the task
 * ended with "worker 没有产生提交".
 *
 * The counter-proofs are deliberate: the exemption is widened by exactly one
 * directory. A real trust-root edit (`quality-gate.json`) must STILL change the
 * version — an exclusion that also swallowed the configs would keep the first
 * assertion green while destroying the guarantee the fingerprint exists for.
 *
 * Every test builds a THROWAWAY repository; the fixture tracks its trust-root
 * configs and ignores only the runtime, exactly like a governed repo, so a task
 * worktree really does contain a copy of those configs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MANDATE_BASIS,
    MANDATE_VERSION,
    MissionStore,
    POLICY_SNAPSHOT_ARTIFACT,
    TRUST_ROOT_RUNTIME_DIRS,
    checkWorkspace,
    mandateState,
    policyDifferences,
    policyFingerprint,
    policyVersion,
    resolveLayout,
    type Layout,
    type SpecRecord,
} from '../dist/index.js'
import { createTaskWorktree, worktreeRoot } from '../dist/split.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** One git invocation in the fixture (throws on failure: a broken fixture must not look green). */
function git(cwd: string, argv: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
}

/**
 * A governed fixture repo: the runtime is ignored, the trust-root configs are
 * COMMITTED. Committing them is what makes the regression reachable — a task
 * worktree is a checkout, so it carries `.dsh/*.json` with it.
 */
function repo(): { cwd: string; layout: Layout } {
    const cwd = tempWorkspace('eng-trust-root-worktrees-')
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'fixture@example.com'])
    git(cwd, ['config', 'user.name', 'Fixture'])
    // Granular ignore: runtime out, configuration in — the policy the suite's own
    // doctor recommends (a blanket `.dsh/` would hide the trust root).
    fs.writeFileSync(
        path.join(cwd, '.gitignore'),
        ['.dsh/missions/', '.dsh/audit/', '.dsh/state/', '.dsh/specs/', ''].join('\n'),
    )
    fs.mkdirSync(path.join(cwd, '.dsh', 'roles'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), JSON.stringify({ enforce: true }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'roles', 'developer.md'), '# developer\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    return { cwd, layout: resolveLayout(cwd) }
}

/** A specification record as `spec_approve` leaves it. */
const SPEC: SpecRecord = {
    title: '信任根里的 worktree',
    background: '拆分派发必须能在建完 worktree 之后继续写',
    requirements: [{ id: 'R-001', text: 'worktree 是运行时目录' }],
    acceptanceCriteria: [{ id: 'AC-001', text: '建 worktree 不改变 policyVersion' }],
    fileBoundaries: ['src/**'],
    negativeConstraints: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    approvedAt: 2,
    approvedBy: 'approval',
}

test('creating a task worktree under the trust root does not change the policy version (AC-001 / TC-3201)', () => {
    const { cwd, layout } = repo()
    assert.equal(TRUST_ROOT_RUNTIME_DIRS.includes('worktrees'), true, 'worktrees 必须是运行时目录')
    const before = policyFingerprint(cwd)

    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm-1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join('；'))
    assert.equal(created.created, true, '本次调用应真的创建了 worktree')
    // The worktree really is INSIDE the trust root, and it really carries a copy
    // of the committed configs: otherwise this test would be pinning a path the
    // real failure never used.
    assert.equal(created.worktree.startsWith(path.join(worktreeRoot(layout), 'm-1')), true, created.worktree)
    assert.equal(
        fs.existsSync(path.join(created.worktree, '.dsh', 'quality-gate.json')),
        true,
        '任务 worktree 是检出，里面带着已提交的信任根配置——这正是过去改变指纹的东西',
    )

    const after = policyFingerprint(cwd)
    assert.deepEqual(policyDifferences(before, after), [], '建 worktree 是运行时动作：指纹文件清单不许变')
    assert.equal(after.version, before.version, '建 worktree 不得改变 policyVersion')

    // The same rule for a hand-written directory: what matters is the PATH, not
    // which function created it (a retried dispatch, a stale leftover, a plain
    // `mkdir` all land here).
    const raw = path.join(worktreeRoot(layout), 'm-2', 't2')
    fs.mkdirSync(path.join(raw, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(raw, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [{ id: 'noise' }] }))
    assert.equal(policyVersion(cwd), before.version, 'worktrees/** 下的 .json 不是策略')
})

test('removing a task worktree leaves the policy version unchanged (AC-001 / TC-3204)', () => {
    const { cwd } = repo()
    const before = policyVersion(cwd)
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm-1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join('；'))
    assert.equal(policyVersion(cwd), before, '创建设置了前置条件：建完指纹仍然相同')

    fs.rmSync(created.worktree, { recursive: true, force: true })
    git(cwd, ['worktree', 'prune'])
    assert.equal(fs.existsSync(created.worktree), false, '目录确实被删掉了（否则这条断言没有意义）')
    assert.equal(policyVersion(cwd), before, '删 worktree 也是运行时动作：指纹必须仍然相同')
})

test('a real trust-root edit still changes the version: only worktrees was exempted (AC-002 / TC-3203)', () => {
    const { cwd } = repo()
    // With a worktree PRESENT, so the exemption is active while we counter-prove:
    // this is the state in which a too-broad exemption would hide a config edit.
    const created = createTaskWorktree({ mainTree: cwd, missionId: 'm-1', taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join('；'))
    const before = policyFingerprint(cwd)

    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({ commands: [{ id: 'test', command: 'node --test', required: true }] }),
    )
    const edited = policyFingerprint(cwd)
    assert.notEqual(edited.version, before.version, 'quality-gate.json 是信任根：改它必须改变指纹')
    assert.deepEqual(policyDifferences(before, edited), [{ path: '.dsh/quality-gate.json', change: 'changed' }])

    // A brand-new config file is still counted: the exemption is one directory,
    // not a relaxed file rule.
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), JSON.stringify({ languages: {} }))
    const added = policyFingerprint(cwd)
    assert.notEqual(added.version, edited.version, '新增信任根配置仍必须改变指纹')
    assert.deepEqual(policyDifferences(edited, added), [{ path: '.dsh/standards.json', change: 'added' }])

    // …and no worktree path ever enters the hashed file list.
    assert.equal(
        added.files.some((file) => file.path.includes('/worktrees/')),
        false,
        `worktrees/** 不得进入指纹：${added.files.map((file) => file.path).join('、')}`,
    )
})

test('a mandate recorded before the dispatch survives the worktree: the same authorisation still writes (AC-003 / TC-3202)', () => {
    const { cwd, layout } = repo()
    const store = new MissionStore({ layout })
    const mission = store.create({ id: 'm-1', title: '信任根里的 worktree', cwd })
    // The approval-time fingerprint, recorded exactly as `spec_approve` does it:
    // the mandate carries the version, the write-once snapshot carries the files.
    const policy = policyFingerprint(cwd)
    store.update(mission.id, () => ({
        status: 'spec-approved',
        spec: SPEC,
        mandate: {
            version: MANDATE_VERSION,
            strength: 'explicit',
            basis: MANDATE_BASIS,
            scope: { phases: [], paths: ['src/**'] },
            policyVersion: policy.version,
            approvedBy: 'approval',
            at: Date.now(),
        },
    }))
    store.writeArtifact(mission.id, POLICY_SNAPSHOT_ARTIFACT, `${JSON.stringify(policy, undefined, 2)}\n`)

    // The dispatch: a REAL worktree at the path the runner uses.
    const created = createTaskWorktree({ mainTree: cwd, missionId: mission.id, taskId: 't1' })
    assert.equal(created.ok, true, created.problems.join('；'))

    // The same mandate writes now (mission record + evidence row). Before the
    // fix the fingerprint had moved, so this authorisation was stale and the
    // write path refused it.
    store.appendEvidence(mission.id, { kind: 'test', summary: 'worker 跑了一次单元测试', recordedBy: 'worker', exitCode: 0 })
    const written = store.update(mission.id, (record) => ({ status: record.status }))
    assert.equal(written?.mandate?.policyVersion, policy.version, 'mandate 不可变：写入不改写授权')
    assert.equal(store.readEvidence(mission.id).length, 1, '证据确实写进去了（不是空跑）')

    // The authorisation still matches the CURRENT trust root, and the doctor —
    // the suite's documented revalidation — agrees instead of reporting drift.
    assert.equal(policyVersion(cwd), policy.version, '建 worktree 没有移动信任根')
    const state = mandateState(store.read(mission.id))
    assert.equal(state.kind, 'present')
    assert.equal(state.kind === 'present' ? state.mandate.policyVersion : '', policyVersion(cwd))
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((entry) => entry.id === 'mandate.policy')
    assert.equal(check?.state, 'ok', `mandate 不应被判过期：${check?.state ?? 'missing'} — ${check?.detail ?? ''}`)
    assert.match(check?.detail ?? '', /1 个在飞 mission 的 mandate 与当前信任根一致/)
})

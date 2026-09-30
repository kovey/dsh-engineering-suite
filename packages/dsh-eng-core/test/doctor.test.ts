import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { checkWorkspace, renderDoctor, withRuntime } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/** A repo with a git identity so `git check-ignore` works. */
function repo(options: { ignoreTrail?: boolean } = {}): string {
    const cwd = tempWorkspace('doctor-')
    execFileSync('git', ['init', '-q'], { cwd })
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    if (options.ignoreTrail === true) fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    return cwd
}

test('an empty repo reports what is missing WITH the fix (regression)', () => {
    const cwd = repo()
    const report = checkWorkspace({ cwd, now: 0 })
    // The two required items that must not be silently "ok" on a bare repo.
    const ids = report.blockers.map((check) => check.id)
    assert.ok(ids.includes('config.quality-gate'), `expected a quality-gate blocker: ${JSON.stringify(report.blockers.map((b) => b.id))}`)
    assert.ok(ids.includes('config.evidence-gate'), 'evidence kinds are required for a delivery that means something')
    for (const check of report.blockers) {
        assert.ok(check.fix !== undefined && check.fix !== '', `${check.id} must name its fix`)
    }
    // A missing ledger ignore is the trap that makes requireCleanTree unexplainable.
    const ignore = report.checks.find((check) => check.id === 'ledger.gitignore')
    assert.equal(ignore?.state, 'missing', 'nothing is ignored yet, so every run would dirty the tree')
    assert.match(ignore?.detail ?? '', /requireCleanTree|指纹/)
    assert.match(ignore?.fix ?? '', /\.gitignore/)
    assert.match(ignore?.fix ?? '', /不要忽略/, 'the fix must keep the trust-root configs tracked')
    // Configs being reviewable is its own (recommended) finding: a bare repo
    // tracks none, and a blanket `.dsh/` ignore would hide them.
    assert.equal(report.checks.find((check) => check.id === 'ledger.config-tracked')?.state, 'partial')
})

test('the GRANULAR ignore policy turns that finding green (regression)', () => {
    const cwd = repo()
    // The policy a real governed repo uses: ignore the runtime, commit the config.
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/missions/\n.dsh/audit/\n.dsh/state/\n.dsh/specs/\n.dsh/media/\n')
    const report = checkWorkspace({ cwd, now: 0 })
    assert.equal(report.checks.find((check) => check.id === 'ledger.gitignore')?.state, 'ok')
})

test('a blanket .dsh/ ignore hides the trust root and is reported (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n')
    const report = checkWorkspace({ cwd, now: 0 })
    assert.equal(report.checks.find((check) => check.id === 'ledger.gitignore')?.state, 'ok', 'the runtime is ignored')
    // …but the configuration is not reviewable, and that is a finding of its own.
    assert.equal(report.checks.find((check) => check.id === 'ledger.config-tracked')?.state, 'partial')
})

test('a ledger file that exists and is not ignored is a leak (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/missions/\n.dsh/audit/\n.dsh/state/\n.dsh/specs/\n.dsh/media/\n')
    fs.writeFileSync(path.join(cwd, '.dsh', 'retrospectives.jsonl'), '{}\n')
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'ledger.gitignore')
    assert.equal(check?.state, 'partial')
    assert.match(check?.detail ?? '', /retrospectives\.jsonl/)
})

test('a committed config makes the reviewability finding green (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/missions/\n.dsh/audit/\n.dsh/state/\n.dsh/specs/\n.dsh/media/\n')
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    execFileSync('git', ['add', '-f', '.dsh/quality-gate.json'], { cwd })
    const report = checkWorkspace({ cwd, now: 0 })
    assert.equal(report.checks.find((check) => check.id === 'ledger.config-tracked')?.state, 'ok')
})

test('a configured workspace shows the counts it read (regression)', () => {
    const cwd = repo({ ignoreTrail: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({ commands: [{ id: 'test', name: '单元测试', command: 'go test ./...', required: true, phase: 'gate' }] }),
    )
    fs.writeFileSync(path.join(cwd, '.dsh', 'evidence-gate.json'), JSON.stringify({ requiredEvidenceKinds: ['command', 'test'] }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), JSON.stringify({ languages: { go: { maxFileLines: 400 } } }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards-baseline.json'), JSON.stringify({ version: 1, frozenAt: 'x', accepted: [] }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ coverageCommand: 'go test -coverprofile=c.out ./...', thresholds: { total: 70, changed: 80 } }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'impact-gate.json'), JSON.stringify({ testCommandTemplate: 'go test {files}' }))
    fs.writeFileSync(path.join(cwd, '.dsh', 'supply-chain-gate.json'), JSON.stringify({ deps: { auditCommands: ['govulncheck ./...'] } }))
    const report = checkWorkspace({ cwd, now: 0 })
    assert.equal(report.blockers.length, 0, `unexpected blockers: ${JSON.stringify(report.blockers.map((b) => [b.id, b.detail]))}`)
    const quality = report.checks.find((check) => check.id === 'config.quality-gate')
    assert.match(quality?.detail ?? '', /1 条命令（1 条 required）/)
    const coverage = report.checks.find((check) => check.id === 'config.coverage')
    assert.equal(coverage?.state, 'ok')
    assert.match(coverage?.detail ?? '', /总 70% \/ 增量 80%/)
    assert.equal(report.checks.find((check) => check.id === 'test.command')?.state, 'ok')
})

test('a threshold without a source is partial, not ok (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.dsh', 'coverage-gate.json'), JSON.stringify({ thresholds: { total: 80 } }))
    const coverage = checkWorkspace({ cwd, now: 0 }).checks.find((check) => check.id === 'config.coverage')
    assert.equal(coverage?.state, 'partial')
    assert.match(coverage?.detail ?? '', /没有覆盖率来源/)
})

test('an unreadable config is unknown, never a pass (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), '{ not json')
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'config.quality-gate')
    assert.equal(check?.state, 'unknown')
    assert.match(check?.detail ?? '', /不是合法的 JSON/)
})

test('requiring the standards gate without a standards file is caught (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.dsh', 'evidence-gate.json'), JSON.stringify({ requiredEvidenceKinds: ['test'], requireStandardsGate: true }))
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'deliver.standards-consistency')
    assert.equal(check?.state, 'missing')
    assert.match(check?.detail ?? '', /永远等不到/)
})

test('a strict approver list without the file is a required blocker (regression)', () => {
    const cwd = repo()
    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ requireApproverList: true }))
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((item) => item.id === 'interaction.approvers')
    assert.equal(check?.state, 'missing')
    assert.ok(report.blockers.some((item) => item.id === 'interaction.approvers'))
})

test('runtime facts are merged and can raise a blocker (regression)', () => {
    const cwd = repo({ ignoreTrail: true })
    const offline = checkWorkspace({ cwd, now: 0 })
    const merged = withRuntime(offline, {
        mountedPlugins: ['spec-gate', 'quality-gate'],
        channels: [{ name: 'feishu', canAsk: true, canNotify: true }],
        pendingAsks: [{ id: 'A-1', title: '规格审批', at: 0, ageMs: 7 * 60_000 }],
        mission: { id: 'M-1', title: 't', status: 'blocked', blocked: true, specApproved: false, lastGate: { id: 'G-1', state: 'BLOCK', source: 'dsh-quality-gate', reason: '测试失败', checkedAt: 0 } },
    })
    assert.ok(merged.blockers.some((check) => check.id === 'runtime.mounts'), 'missing plugins are a blocker')
    assert.match(merged.checks.find((check) => check.id === 'runtime.mounts')?.detail ?? '', /role-guard/)
    assert.equal(merged.checks.find((check) => check.id === 'runtime.channels')?.state, 'ok')
    assert.match(merged.checks.find((check) => check.id === 'runtime.pending-asks')?.detail ?? '', /已等 7 分钟/)
    assert.equal(merged.checks.find((check) => check.id === 'runtime.mission')?.state, 'missing')
    assert.match(merged.checks.find((check) => check.id === 'runtime.mission')?.fix ?? '', /unblock/)
})

test('the rendered report groups by phase and lists the fixes (regression)', () => {
    const cwd = repo()
    const text = renderDoctor(checkWorkspace({ cwd, now: 0 }))
    assert.match(text, /# 套件自检/)
    for (const phase of ['规划', '实现', '测试', '交互', '交付', '部署']) assert.match(text, new RegExp(phase))
    assert.match(text, /## 建议的处理顺序/)
    assert.match(text, /→ 下一步：/)
})

test('spec-declared budgets are counted, and the loose case is advised (regression)', () => {
    const cwd = repo({ ignoreTrail: true })
    fs.mkdirSync(path.join(cwd, '.dsh', 'specs'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'specs', 'M-1.md'),
        [
            '# 规格',
            '',
            '## 验收标准',
            '',
            '| ID | 标准 |',
            '|----|------|',
            '| AC-001 | 返回 200 |',
            '',
            '## 非功能预算',
            '',
            '| 预算 | 名称 | 指标 | 阈值 | 命令 | 关联需求 |',
            '|------|------|------|------|------|----------|',
            '| B-001 | p95 | durationMs | max=50ms | curl -w %{time_total} | AC-001 |',
            '| B-002 | 包体积 | bytes | max=200000 | node size.mjs | AC-001 |',
            '',
        ].join('\n'),
    )
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'config.spec-budgets')
    assert.equal(check?.state, 'partial', 'declared but nothing enforces them without the host switch')
    assert.match(check?.detail ?? '', /2 条（1 份规格）/)
    assert.match(check?.fix ?? '', /requireSpecBudgets/)

    // With the host switch on, the advice disappears (the gate now refuses
    // silently unverified budgets).
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ requireSpecBudgets: true, commands: [{ id: 't', command: 'true', required: true }] }))
    const strict = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'config.spec-budgets')
    assert.equal(strict?.state, 'ok')
    assert.match(strict?.detail ?? '', /requireSpecBudgets=true/)
})

test('a spec without the budget section contributes no rows (regression)', () => {
    const cwd = repo({ ignoreTrail: true })
    fs.mkdirSync(path.join(cwd, '.dsh', 'specs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'specs', 'M-2.md'), '# 规格\n\n## 验收标准\n\n| ID | 标准 |\n|----|------|\n| AC-001 | x |\n')
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'config.spec-budgets')
    assert.equal(check?.state, 'ok')
    assert.match(check?.detail ?? '', /未声明非功能预算/)
})

test('a wrapper test command counts, and "commands but no recognisable test" is advice (regression)', () => {
    const cwd = repo({ ignoreTrail: true })
    // `make test` is a test command: the first version of this check only knew
    // toolchain binaries and reported a healthy repository as having none.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({
        commands: [
            { id: 'test', name: '单元测试', command: 'make test', required: true, phase: 'gate' },
            { id: 'vet', name: 'lint', command: 'make vet', required: false, phase: 'lint' },
        ],
    }))
    const recognised = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'test.command')
    assert.equal(recognised?.state, 'ok')
    assert.match(recognised?.detail ?? '', /1 条测试命令/)

    // An unusual runner is not a missing test: partial + advice, never a blocker.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({
        commands: [{ id: 'ci', name: 'CI', command: './ci/run.sh --all', required: true, phase: 'gate' }],
    }))
    const report = checkWorkspace({ cwd, now: 0 })
    const odd = report.checks.find((item) => item.id === 'test.command')
    assert.equal(odd?.state, 'partial')
    assert.equal(odd?.severity, 'recommended')
    assert.match(odd?.detail ?? '', /人工确认/)
    assert.equal(report.blockers.some((item) => item.id === 'test.command'), false, 'a wrapper script must not block delivery readiness')

    // Only an EMPTY command list is a required gap.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ commands: [] }))
    const empty = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'test.command')
    assert.equal(empty?.state, 'missing')
    assert.equal(empty?.severity, 'required')
})

test('without git the ignore rule is "not applicable", not a blocker (regression)', () => {
    // A plain directory (no .git): the fingerprint rules cannot apply, so a
    // REQUIRED ignore gap here is a false alarm that makes a healthy repository
    // look un-ready.
    const cwd = tempWorkspace('doctor-nogit-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((item) => item.id === 'ledger.gitignore')
    assert.equal(check?.severity, 'recommended')
    assert.equal(check?.state, 'partial')
    assert.match(check?.detail ?? '', /不适用/)
    assert.equal(checkWorkspace({ cwd, now: 0 }).blockers.some((item) => item.id === 'ledger.gitignore'), false)
})

/**
 * 一致性总览（conformance）的单元测试。
 *
 * 设计稿在 `docs/CONFORMANCE.md`，这里逐条钉住它的测试清单：
 *
 *  1. 五个维度各自至少一个 `ok` 与一个非 `ok`，非 `ok` 必须带**可读的原因**；
 *  2. 头行 = 最差维度；`unknown` + `conformant` ⇒ `partial`（绝不是 conformant）；
 *  3. `stale` 授权 + `full` 证据 ⇒ 头行 `divergent`/`partial`，且两个维度都列出；
 *  4. 空仓库 / 未记录 mission ⇒ 全 `unknown` + 原因，头行 `unknown`，绝不"看起来健康"；
 *  5. `legacy` 授权作为**事实**呈现，不计入 `divergent`；
 *  6. `observations` 里的影子 `would: BLOCK` 不把门禁维度变成 `block`，但必须出现在 detail；
 *  7. 只读：`.dsh` 前后逐字节一致；
 *  8. 确定性：同一棵树两次运行逐字节相同（含维度顺序）；
 *  9. 缺台账时盲区行必须出现。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    APPROVAL_AT_TOLERANCE_MS,
    CONFORMANCE_DIMENSIONS,
    MissionStore,
    buildConformanceContext,
    conformanceHeadline,
    conformanceOverview,
    conformanceRollup,
    missionConformance,
    resolveLayout,
    type ConformanceContext,
    type GateRecord,
    type GitFingerprint,
    type Layout,
    type MissionRecord,
    type Receipt,
    type SpecRecord,
} from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

const NOW = 1_760_000_000_000
const DAY = 86_400_000
const POLICY = 'a'.repeat(64)
const OLD_POLICY = 'b'.repeat(64)

/** The workspace fingerprint every seeded gate records unless a test changes it. */
const FINGERPRINT: GitFingerprint = {
    isRepo: true,
    head: 'c'.repeat(40),
    branch: 'main',
    dirty: false,
    changedFiles: 0,
    diffDigest: 'd'.repeat(64),
}

interface Fixture {
    cwd: string
    layout: Layout
    store: MissionStore
}

/** A throwaway workspace with its own mission store (no git needed). */
function workspace(prefix = 'conformance-'): Fixture {
    const cwd = tempWorkspace(prefix)
    const layout = resolveLayout(cwd)
    return { cwd, layout, store: new MissionStore({ layout }) }
}

/** The context with fully injected facts: no git, no clock, no surprise. */
function contextOf(fixture: Fixture, overrides: Partial<ConformanceContext> = {}): ConformanceContext {
    return buildConformanceContext({
        layout: fixture.layout,
        now: NOW,
        policy: { version: POLICY, files: [] },
        fingerprint: FINGERPRINT,
        requirements: {
            gateSource: 'dsh-quality-gate',
            requiredKinds: ['command', 'test'],
            source: '测试注入',
            blind: [],
        },
        ...overrides,
    })
}

function approvedSpec(at: number, boundaries: readonly string[] = []): SpecRecord {
    return {
        title: '测试规格',
        background: '',
        requirements: [],
        acceptanceCriteria: [],
        fileBoundaries: [...boundaries],
        negativeConstraints: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
        approvedAt: at,
        approvedBy: 'alice',
    }
}

function mandateOf(policyVersion: string, overrides: Record<string, unknown> = {}): MissionRecord['mandate'] {
    return {
        version: 1,
        strength: 'explicit',
        basis: 'spec-approved',
        scope: { phases: [], paths: [] },
        policyVersion,
        approvedBy: 'alice',
        at: NOW,
        ...overrides,
    } as MissionRecord['mandate']
}

/** Create one mission with exactly the fields the test needs. */
function seedMission(fixture: Fixture, id: string, overrides: Partial<MissionRecord> = {}): MissionRecord {
    fixture.store.create({ id, title: `任务 ${id}`, cwd: fixture.cwd })
    const created = fixture.store.read(id)
    assert.ok(created !== undefined)
    fixture.store.save({
        ...created,
        createdAt: NOW,
        ...overrides,
        id,
    })
    const stored = fixture.store.read(id)
    assert.ok(stored !== undefined)
    return stored
}

/** One gate record written the way the gates write it. */
function seedGate(
    fixture: Fixture,
    missionId: string,
    input: { id: string; source?: string; state?: GateRecord['state']; checkedAt?: number; reason?: string; observations?: GateRecord['observations']; fingerprint?: GitFingerprint | null; results?: unknown[]; scopeFull?: boolean },
): void {
    const record = {
        id: input.id,
        missionId,
        source: input.source ?? 'dsh-quality-gate',
        state: input.state ?? 'PASS',
        checkedAt: input.checkedAt ?? NOW,
        reason: input.reason ?? `${input.state ?? 'PASS'}（测试）`,
        results: input.results ?? [],
        ...(input.fingerprint === null ? {} : { fingerprint: input.fingerprint ?? FINGERPRINT }),
        ...(input.scopeFull === undefined
            ? {}
            : { scope: { selected: ['test'], total: 1, full: input.scopeFull } }),
        ...(input.observations === undefined ? {} : { observations: input.observations }),
    }
    fixture.store.writeArtifact(missionId, path.join('gates', `${input.id}.json`), `${JSON.stringify(record)}\n`)
}

/** One receipt artifact, optionally with the `path` the real gate records. */
function seedReceipt(
    fixture: Fixture,
    missionId: string,
    input: { id: string; issuedAt?: number; gateId: string; evidenceIds?: string[]; withPath?: boolean },
): Receipt {
    const relative = path.join('receipts', `${input.id}.json`)
    // `Receipt.path` is workspace-relative (the real gate writes
    // `path.relative(layout.cwd, file)`), not mission-relative.
    const workspaceRelative = path.relative(fixture.cwd, path.join(fixture.layout.missionsDir, missionId, relative))
    const body = {
        id: input.id,
        missionId,
        issuedAt: input.issuedAt ?? NOW,
        issuedBy: 'dsh-evidence-gate',
        digest: 'e'.repeat(64),
        gateId: input.gateId,
        evidenceIds: input.evidenceIds ?? [],
        ...(input.withPath === false ? {} : { path: workspaceRelative }),
    }
    fixture.store.writeArtifact(missionId, relative, `${JSON.stringify(body)}\n`)
    return body as Receipt
}

/** Write `evidence.jsonl` verbatim (so a test can also write a broken line). */
function seedEvidence(fixture: Fixture, missionId: string, rows: readonly Record<string, unknown>[], extraLine?: string): void {
    const text = rows.map((row) => JSON.stringify(row)).join('\n')
    const trailing = extraLine === undefined ? '' : `\n${extraLine}`
    fixture.store.writeArtifact(missionId, 'evidence.jsonl', `${text}${trailing}\n`)
}

function evidenceRow(id: string, kind: string): Record<string, unknown> {
    return { id, missionId: 'm', kind, summary: `${kind} 证据`, recordedAt: NOW, recordedBy: 'agent', exitCode: 0 }
}

/** A gate that is complete enough for a `full` evidence dimension. */
function seedCompleteDelivery(fixture: Fixture, missionId: string): void {
    seedGate(fixture, missionId, {
        id: 'GATE-01',
        state: 'PASS',
        scopeFull: true,
        results: [{ id: 'test', name: '测试', command: 'node --test', required: true, exitCode: 0, signal: null, durationMs: 1, timedOut: false, output: 'ok', outputDigest: 'f'.repeat(64) }],
    })
    seedEvidence(fixture, missionId, [evidenceRow('EV-001', 'command'), evidenceRow('EV-002', 'test')])
    seedReceipt(fixture, missionId, { id: 'RCP-01', gateId: 'GATE-01', evidenceIds: ['EV-001', 'EV-002'] })
}

/** Content hash of every file under `.dsh` (the read-only / determinism assertion). */
function snapshotDsh(cwd: string): Record<string, string> {
    const root = path.join(cwd, '.dsh')
    const files: Record<string, string> = {}
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else files[path.relative(cwd, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
    }
    if (fs.existsSync(root)) walk(root)
    return files
}

// --- 授权 -------------------------------------------------------------------

test('授权 ok：mandate 有效、策略与信任根一致、规格审批有效', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-ok', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    const result = missionConformance(contextOf(fixture), 'm-ok')
    assert.equal(result.dimensions.authorization.state, 'ok')
    assert.match(result.dimensions.authorization.detail, /policy 与当前信任根一致/)
    assert.ok(result.dimensions.authorization.facts.some((fact) => /strength=explicit/.test(fact)))
})

test('授权 stale：策略版本变了，原因点名改动的信任根文件（不是状态码）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-stale', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(OLD_POLICY) })
    fixture.store.writeArtifact(
        'm-stale',
        'policy-fingerprint.json',
        `${JSON.stringify({ version: OLD_POLICY, files: [{ path: '.dsh/quality-gate.json', sha256: '1'.repeat(64) }] })}\n`,
    )
    const context = contextOf(fixture, {
        policy: { version: POLICY, files: [{ path: '.dsh/quality-gate.json', sha256: '2'.repeat(64) }] },
    })
    const dimension = missionConformance(context, 'm-stale').dimensions.authorization
    assert.match(dimension.state, /^stale:/)
    assert.match(dimension.detail, /策略版本已变/)
    assert.match(dimension.detail, /\.dsh\/quality-gate\.json（修改）/)
    assert.match(dimension.detail, /不再成立|已不能按原样成立/)
})

test('授权 withdrawn 与 missing 都是可读结论', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-withdrawn', {
        status: 'blocked',
        spec: approvedSpec(NOW),
        mandate: mandateOf(POLICY, { withdrawn: { at: NOW + 1, by: 'alice', reason: '需求取消' } }),
    })
    seedMission(fixture, 'm-missing', { status: 'draft' })
    const context = contextOf(fixture)
    const withdrawn = missionConformance(context, 'm-withdrawn').dimensions.authorization
    assert.equal(withdrawn.state, 'withdrawn')
    assert.match(withdrawn.detail, /已被 alice 于 .* 撤回（需求取消）/)
    const missing = missionConformance(context, 'm-missing').dimensions.authorization
    assert.equal(missing.state, 'missing')
    assert.match(missing.detail, /没有已审批的规格/)
    assert.match(missing.detail, /missing 不是 ok/)
})

test('legacy 授权作为事实呈现：不计入 divergent，头行仍是 conformant', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-legacy', { status: 'delivered', spec: approvedSpec(NOW) })
    seedCompleteDelivery(fixture, 'm-legacy')
    const result = missionConformance(contextOf(fixture), 'm-legacy')
    assert.equal(result.dimensions.authorization.state, 'legacy')
    assert.match(result.dimensions.authorization.detail, /事实，不是缺陷/)
    assert.equal(result.dimensions.evidence.state, 'full')
    assert.equal(result.dimensions.gates.state, 'pass')
    assert.equal(result.dimensions.freshness.state, 'fresh')
    assert.equal(result.dimensions.consistency.state, 'consistent')
    assert.equal(result.headline, 'conformant')
})

// --- 证据 -------------------------------------------------------------------

test('证据 full：回执 + scope.full + 要求的门禁来源 + 引用的证据都在', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-full', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedCompleteDelivery(fixture, 'm-full')
    const result = missionConformance(contextOf(fixture), 'm-full')
    assert.equal(result.dimensions.evidence.state, 'full')
    assert.match(result.dimensions.evidence.detail, /scope\.full=true/)
})

test('证据 partial：门禁只覆盖了部分命令（原因可读）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-partial', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-partial', { id: 'GATE-01', state: 'PASS', scopeFull: false, results: [{}] })
    seedEvidence(fixture, 'm-partial', [evidenceRow('EV-001', 'command')])
    seedReceipt(fixture, 'm-partial', { id: 'RCP-01', gateId: 'GATE-01', evidenceIds: ['EV-001'] })
    const dimension = missionConformance(contextOf(fixture), 'm-partial').dimensions.evidence
    assert.match(dimension.state, /^partial:/)
    assert.match(dimension.detail, /只覆盖了部分命令（1\/1|1\/1：test）/)
})

test('证据 absent：没有回执也没有证据行（不是 full，也不是"没问题"）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-absent', { status: 'draft' })
    const dimension = missionConformance(contextOf(fixture), 'm-absent').dimensions.evidence
    assert.equal(dimension.state, 'absent')
    assert.match(dimension.detail, /没有任何回执或证据行/)
})

// --- 门禁 -------------------------------------------------------------------

test('门禁 pass / warn / block / no-record 都以最新一次为准', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-gates', { status: 'implementing' })
    seedGate(fixture, 'm-gates', { id: 'GATE-01', state: 'BLOCK', checkedAt: NOW - DAY })
    seedGate(fixture, 'm-gates', { id: 'GATE-02', state: 'PASS', checkedAt: NOW })
    const context = contextOf(fixture)
    assert.equal(missionConformance(context, 'm-gates').dimensions.gates.state, 'pass')

    seedGate(fixture, 'm-gates', { id: 'GATE-03', state: 'WARN', checkedAt: NOW + DAY })
    assert.equal(missionConformance(context, 'm-gates').dimensions.gates.state, 'warn')

    seedGate(fixture, 'm-gates', { id: 'GATE-04', state: 'BLOCK', checkedAt: NOW + 2 * DAY, reason: '覆盖率 41% 低于 80%' })
    const blocked = missionConformance(context, 'm-gates').dimensions.gates
    assert.equal(blocked.state, 'block')
    assert.match(blocked.detail, /覆盖率 41% 低于 80%/)

    seedMission(fixture, 'm-no-gate', { status: 'draft' })
    const none = missionConformance(context, 'm-no-gate').dimensions.gates
    assert.equal(none.state, 'no-record')
    assert.match(none.detail, /no-record 不是 pass/)
})

test('影子 would: BLOCK 不计入门禁裁决，但必须出现在 detail', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-shadow', { status: 'implementing' })
    seedGate(fixture, 'm-shadow', {
        id: 'GATE-01',
        state: 'PASS',
        observations: [
            { rule: 'coverage', mode: 'observe', would: 'BLOCK', reason: '覆盖率 41% 低于 80%' },
            { rule: 'complexity', mode: 'observe', would: 'PASS', reason: '复杂度 8 ≤ 10' },
        ],
    })
    const dimension = missionConformance(contextOf(fixture), 'm-shadow').dimensions.gates
    assert.equal(dimension.state, 'pass', '影子项不能把门禁维度变成 block')
    assert.match(dimension.detail, /coverage=would BLOCK/)
    assert.match(dimension.detail, /覆盖率 41% 低于 80%/)
    assert.match(dimension.detail, /不计入/)
})

// --- 新鲜度 -----------------------------------------------------------------

test('新鲜度 fresh：policy、工作区指纹、基线与索引都对得上', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-fresh', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-fresh', { id: 'GATE-01' })
    const dimension = missionConformance(contextOf(fixture), 'm-fresh').dimensions.freshness
    assert.equal(dimension.state, 'fresh')
    assert.ok(dimension.facts.some((fact) => /工作区指纹与最新带指纹的门禁 GATE-01/.test(fact)))
})

test('新鲜度 stale：工作区在门禁之后变了（点名 HEAD 变化）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-stale-fp', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-stale-fp', { id: 'GATE-01', fingerprint: { ...FINGERPRINT, head: '9'.repeat(40) } })
    const dimension = missionConformance(contextOf(fixture), 'm-stale-fp').dimensions.freshness
    assert.match(dimension.state, /^stale:/)
    assert.match(dimension.detail, /HEAD 99999999 → cccccccc/)
})

test('新鲜度 stale：有规范阈值却没有基线（存量违规会被当成新增）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-baseline', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-baseline', { id: 'GATE-01' })
    fs.writeFileSync(path.join(fixture.cwd, '.dsh', 'standards.json'), '{"rules":{}}\n')
    const dimension = missionConformance(contextOf(fixture), 'm-baseline').dimensions.freshness
    assert.match(dimension.state, /^stale:/)
    assert.match(dimension.detail, /没有基线/)
})

test('TC-1308 新鲜度：迁移后的仓库从命名空间目录读规范阈值与基线', () => {
    // `.dsh/engineering-suite/` exists, so the layout root moved. The literal
    // `.dsh/standards.json` default made this dimension report "no standards"
    // for a repository whose files sit exactly where the standards gate reads
    // them (`<layout.rootDir>/standards.json`).
    const cwd = tempWorkspace('conformance-namespace-')
    const namespace = path.join(cwd, '.dsh', 'engineering-suite')
    fs.mkdirSync(namespace, { recursive: true })
    const layout = resolveLayout(cwd)
    const fixture: Fixture = { cwd, layout, store: new MissionStore({ layout }) }
    seedMission(fixture, 'm-ns', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-ns', { id: 'GATE-01' })
    fs.writeFileSync(path.join(namespace, 'standards.json'), '{"rules":{}}\n')
    fs.writeFileSync(path.join(namespace, 'standards-baseline.json'), '{"version":1,"frozenAt":"x","accepted":[]}\n')

    const dimension = missionConformance(contextOf(fixture), 'm-ns').dimensions.freshness
    const facts = dimension.facts.join('\n')
    assert.match(facts, /规范基线与阈值都在/)
    assert.match(facts, /engineering-suite\/standards\.json/)
    assert.match(facts, /engineering-suite\/standards-baseline\.json/)
    assert.doesNotMatch(dimension.detail, /没有基线/, 'both artifacts were found where the standards gate reads them')
})

test('新鲜度 unknown：没有门禁指纹时声明无法核对（不是 fresh）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-unknown-fresh', { status: 'spec-approved', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    const dimension = missionConformance(contextOf(fixture), 'm-unknown-fresh').dimensions.freshness
    assert.equal(dimension.state, 'unknown')
    assert.match(dimension.detail, /无法核对/)
    assert.ok(dimension.blind.some((entry) => /没有(任何)?门禁记录携带工作区指纹/.test(entry)))
})

// --- 一致性 -----------------------------------------------------------------

test('一致性 consistent：证据行、回执路径、证据工件与审批时间都能对上', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-consistent', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedCompleteDelivery(fixture, 'm-consistent')
    fixture.store.writeArtifact('m-consistent', path.join('artifacts', 'report.txt'), 'ok\n')
    seedEvidence(fixture, 'm-consistent', [
        evidenceRow('EV-001', 'command'),
        { ...evidenceRow('EV-002', 'test'), artifactPath: 'artifacts/report.txt' },
    ])
    const dimension = missionConformance(contextOf(fixture), 'm-consistent').dimensions.consistency
    assert.equal(dimension.state, 'consistent')
    assert.ok(dimension.facts.some((fact) => /manifest|全部可解析/.test(fact)))
})

test('一致性 divergent：回执引用的证据不存在 / 工件路径缺失 / 审批时间对不上', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-divergent', {
        status: 'delivered',
        spec: approvedSpec(NOW),
        // A day earlier than the spec approval: not the same approval.
        mandate: mandateOf(POLICY, { at: NOW - DAY }),
    })
    seedGate(fixture, 'm-divergent', { id: 'GATE-01', state: 'PASS', scopeFull: true, results: [{}] })
    seedEvidence(fixture, 'm-divergent', [
        evidenceRow('EV-001', 'command'),
        { ...evidenceRow('EV-002', 'test'), artifactPath: 'artifacts/missing.txt' },
    ])
    seedReceipt(fixture, 'm-divergent', { id: 'RCP-01', gateId: 'GATE-01', evidenceIds: ['EV-001', 'EV-404'] })
    const dimension = missionConformance(contextOf(fixture), 'm-divergent').dimensions.consistency
    assert.match(dimension.state, /^divergent:/)
    assert.match(dimension.detail, /不存在的证据 EV-404/)
    assert.match(dimension.detail, /artifacts\/missing\.txt 在磁盘上不存在/)
    assert.match(dimension.detail, /不是同一次审批/)
})

test('一致性 divergent：evidence.jsonl 的坏行被数出来（不静默跳过）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-bad-evidence', { status: 'implementing' })
    seedEvidence(fixture, 'm-bad-evidence', [evidenceRow('EV-001', 'command')], '{"id": "EV-002", ')
    const dimension = missionConformance(contextOf(fixture), 'm-bad-evidence').dimensions.consistency
    assert.match(dimension.state, /^divergent:/)
    assert.match(dimension.detail, /evidence\.jsonl 有 1 行无法解析（第 2 行）/)
})

test('一致性 unknown：没有任何可核对的引用', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-nothing', { status: 'draft' })
    const dimension = missionConformance(contextOf(fixture), 'm-nothing').dimensions.consistency
    assert.equal(dimension.state, 'unknown')
    assert.match(dimension.detail, /没有可核对的引用/)
})

// --- 头行规则 ---------------------------------------------------------------

test('头行 = 最差维度；unknown + conformant ⇒ partial（绝不是 conformant）', () => {
    const complete = { authorization: 'ok', evidence: 'full', gates: 'pass', freshness: 'fresh', consistency: 'consistent' } as const
    assert.equal(conformanceHeadline(complete).headline, 'conformant')

    const withUnknown = conformanceHeadline({ ...complete, consistency: 'unknown' })
    assert.equal(withUnknown.headline, 'partial', 'unknown 永远不优于 partial')
    assert.match(withUnknown.reason, /unknown 不优于 partial/)

    assert.equal(conformanceHeadline({ ...complete, evidence: 'partial' }).headline, 'partial')
    assert.equal(conformanceHeadline({ ...complete, gates: 'block' }).headline, 'divergent')
    assert.equal(conformanceHeadline({ ...complete, authorization: 'withdrawn' }).headline, 'divergent')
    assert.equal(
        conformanceHeadline({ authorization: 'missing', evidence: 'absent', gates: 'no-record', freshness: 'unknown', consistency: 'unknown' }).headline,
        'divergent',
        '已知的偏离优先于"读不到"',
    )
    assert.equal(
        conformanceHeadline({ authorization: 'missing', evidence: 'partial', gates: 'warn', freshness: 'unknown', consistency: 'unknown' }).headline,
        'partial',
    )
    assert.equal(
        conformanceHeadline({ authorization: 'missing', evidence: 'partial', gates: 'pass', freshness: 'unknown', consistency: 'unknown' }).headline,
        'partial',
    )
})

test('stale 授权 + full 证据 ⇒ 头行 partial，两个维度都被列出', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-mixed', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(OLD_POLICY) })
    seedCompleteDelivery(fixture, 'm-mixed')
    fixture.store.writeArtifact('m-mixed', 'policy-fingerprint.json', `${JSON.stringify({ version: OLD_POLICY, files: [] })}\n`)
    const result = missionConformance(contextOf(fixture), 'm-mixed')
    assert.match(result.dimensions.authorization.state, /^stale:/)
    assert.equal(result.dimensions.evidence.state, 'full')
    assert.equal(result.headline, 'partial')
    assert.match(result.headlineReason, /授权/)
    // The full evidence dimension is NOT the worst one, but it still exists as
    // its own line with its own state and detail.
    assert.match(result.dimensions.evidence.detail, /满足交付要求/)
})

// --- 空仓库 / 未记录 ---------------------------------------------------------

test('空仓库 / 未记录 mission ⇒ 全 unknown + 原因，头行 unknown，绝不"看起来健康"', () => {
    const fixture = workspace('conformance-empty-')
    const overview = conformanceOverview({ layout: fixture.layout, now: NOW })
    assert.equal(overview.mission.missionId, undefined)
    assert.equal(overview.mission.headline, 'unknown')
    for (const dimension of CONFORMANCE_DIMENSIONS) {
        assert.equal(overview.mission.dimensions[dimension].state, 'unknown')
        assert.match(overview.mission.dimensions[dimension].detail, /还没有任何 mission/)
    }
    assert.ok(overview.mission.blind.length > 0, '盲区必须出现')
    const text = JSON.stringify(overview)
    for (const claim of ['看起来健康', '健康', '全部一致', '一切正常']) {
        assert.equal(text.includes(claim), false, `must not claim ${claim}`)
    }

    const context = contextOf(fixture)
    const unrecorded = missionConformance(context, 'never-recorded')
    assert.equal(unrecorded.headline, 'unknown')
    assert.equal(unrecorded.missionId, 'never-recorded')
    for (const dimension of CONFORMANCE_DIMENSIONS) {
        assert.equal(unrecorded.dimensions[dimension].state, 'unknown')
        assert.match(unrecorded.dimensions[dimension].detail, /mission\.json 不存在或无法解析/)
    }
})

test('缺台账时盲区行必须出现（plan / releases / deployments）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-blind', { status: 'implementing' })
    const result = missionConformance(contextOf(fixture), 'm-blind')
    for (const ledger of ['plan.jsonl', 'releases.jsonl', 'deployments.jsonl']) {
        assert.ok(
            result.blind.some((entry) => entry.includes(ledger)),
            `missing ${ledger} must be named as a blind spot`,
        )
    }
})

// --- 只读 / 确定性 -----------------------------------------------------------

test('只读：conformanceOverview 前后 .dsh 逐字节一致', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-ro', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedCompleteDelivery(fixture, 'm-ro')
    const before = snapshotDsh(fixture.cwd)
    conformanceOverview({ layout: fixture.layout, now: NOW })
    conformanceRollup(contextOf(fixture), 20)
    const after = snapshotDsh(fixture.cwd)
    assert.deepEqual(after, before)
})

test('确定性：同一棵树两次运行逐字节相同（含维度顺序）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-d1', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY), createdAt: NOW - DAY })
    seedCompleteDelivery(fixture, 'm-d1')
    seedMission(fixture, 'm-d2', { status: 'implementing', createdAt: NOW })
    const first = JSON.stringify(conformanceOverview({ layout: fixture.layout, now: NOW }))
    const second = JSON.stringify(conformanceOverview({ layout: fixture.layout, now: NOW }))
    assert.equal(first, second)
    // The dimension order is part of the contract, not of object key luck.
    const context = contextOf(fixture)
    const result = missionConformance(context, 'm-d1')
    assert.deepEqual(Object.keys(result.dimensions), [...CONFORMANCE_DIMENSIONS])
})

// --- 分布 -------------------------------------------------------------------

test('分布：最新 N 个的头行计数、每维状态计数，以及"与上一窗口相比"', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-old', { status: 'draft', createdAt: NOW - 3 * DAY })
    seedMission(fixture, 'm-mid', { status: 'delivered', spec: approvedSpec(NOW - 2 * DAY), mandate: mandateOf(POLICY), createdAt: NOW - 2 * DAY })
    seedCompleteDelivery(fixture, 'm-mid')
    seedMission(fixture, 'm-new', { status: 'implementing', createdAt: NOW - DAY })
    const rollup = conformanceRollup(contextOf(fixture), 2)
    assert.equal(rollup.total, 3)
    assert.equal(rollup.limit, 2)
    assert.deepEqual(
        rollup.window.map((entry) => entry.missionId),
        ['m-new', 'm-mid'],
        '新的在前；同刻按 id',
    )
    const headlineTotal = Object.values(rollup.headlines).reduce((sum, count) => sum + count, 0)
    assert.equal(headlineTotal, 2)
    const dimensionTotal = Object.values(rollup.dimensions.authorization).reduce((sum, count) => sum + count, 0)
    assert.equal(dimensionTotal, 2)
    assert.ok(rollup.trend !== undefined, '存在上一窗口时必须有趋势行')
    assert.equal(rollup.trend?.previousSize, 1)
    assert.match(rollup.trend?.line ?? '', /^与上一窗口相比（上一窗口 1 个 mission → 本窗口 2 个）：conformant \d+→\d+、partial \d+→\d+、divergent \d+→\d+、unknown \d+→\d+$/)
    assert.ok(rollup.blind.some((entry) => /只统计最新 2 个 mission/.test(entry)))
    // No composite score anywhere in the rollup.
    const text = JSON.stringify(rollup)
    for (const word of ['score', '得分', '分数', '加权', '百分比']) assert.equal(text.includes(word), false)
})

test('分布：没有上一窗口时没有趋势行（样本还小就说样本还小）', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-only', { status: 'draft', createdAt: NOW })
    const rollup = conformanceRollup(contextOf(fixture), 20)
    assert.equal(rollup.trend, undefined)
    assert.equal(rollup.headlines.unknown + rollup.headlines.divergent + rollup.headlines.partial + rollup.headlines.conformant, 1)
})

test('审批时间容差是一处显式常量（同一次审批允许几毫秒的写入差）', () => {
    assert.equal(APPROVAL_AT_TOLERANCE_MS, 5_000)
})

test('授权 stale：inferred 强度与"规格范围比 mandate 宽"各有可读原因', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-inferred', {
        status: 'spec-approved',
        spec: approvedSpec(NOW),
        mandate: mandateOf(POLICY, { strength: 'inferred' }),
    })
    const inferred = missionConformance(contextOf(fixture), 'm-inferred').dimensions.authorization
    assert.match(inferred.state, /^stale:/)
    assert.match(inferred.detail, /inferred/)

    seedMission(fixture, 'm-wider', {
        status: 'spec-approved',
        spec: approvedSpec(NOW, ['src', 'docs']),
        mandate: mandateOf(POLICY, { scope: { phases: [], paths: ['src'] } }),
    })
    const wider = missionConformance(contextOf(fixture), 'm-wider').dimensions.authorization
    assert.match(wider.state, /^stale:/)
    assert.match(wider.detail, /规格声明的范围比 mandate 宽（新增：docs）/)
})

test('授权 stale：损坏的 mandate 记录按 fail closed 当作需要重新授权', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-broken', {
        status: 'spec-approved',
        spec: approvedSpec(NOW),
        // `legacy` may only be READ from absence; writing it into the file is invalid.
        mandate: mandateOf(POLICY, { strength: 'legacy' }),
    })
    const dimension = missionConformance(contextOf(fixture), 'm-broken').dimensions.authorization
    assert.match(dimension.state, /^stale:/)
    assert.match(dimension.detail, /mandate 记录损坏/)
    assert.match(dimension.detail, /legacy 只用于/)
})

test('证据 partial：回执依赖的门禁来源不是本仓库要求的来源', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-source', { status: 'delivered', spec: approvedSpec(NOW), mandate: mandateOf(POLICY) })
    seedGate(fixture, 'm-source', { id: 'GATE-01', source: 'dsh-other-gate', scopeFull: true, results: [{}] })
    seedEvidence(fixture, 'm-source', [evidenceRow('EV-001', 'command'), evidenceRow('EV-002', 'test')])
    seedReceipt(fixture, 'm-source', { id: 'RCP-01', gateId: 'GATE-01', evidenceIds: ['EV-001', 'EV-002'] })
    const dimension = missionConformance(contextOf(fixture), 'm-source').dimensions.evidence
    assert.match(dimension.state, /^partial:/)
    assert.match(dimension.detail, /门禁来源是 dsh-other-gate，本仓库要求 dsh-quality-gate/)
})

test('门禁 warn：多个来源各取最新，WARN 让维度成为 warn；旧 PASS 不掩盖它', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-multi', { status: 'implementing' })
    seedGate(fixture, 'm-multi', { id: 'GATE-01', source: 'dsh-quality-gate', state: 'PASS', checkedAt: NOW - DAY })
    seedGate(fixture, 'm-multi', { id: 'GATE-02', source: 'dsh-standards-gate', state: 'WARN', checkedAt: NOW, reason: '文件过长 3 处' })
    const dimension = missionConformance(contextOf(fixture), 'm-multi').dimensions.gates
    assert.equal(dimension.state, 'warn')
    assert.match(dimension.detail, /dsh-standards-gate=WARN（文件过长 3 处）/)
    assert.match(dimension.detail, /dsh-quality-gate=PASS/)
})

test('一致性 divergent：部署门禁没有对应的 deployments.jsonl 台账行', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-deploy', { status: 'implementing' })
    seedGate(fixture, 'm-deploy', { id: 'GATE-D1', source: 'dsh-deploy-gate', state: 'PASS', scopeFull: true, results: [{}] })
    const dimension = missionConformance(contextOf(fixture), 'm-deploy').dimensions.consistency
    assert.match(dimension.state, /^divergent:/)
    assert.match(dimension.detail, /部署结论没有台账行/)
})

test('一致性 consistent：部署门禁在 deployments.jsonl 里有对应行', () => {
    const fixture = workspace()
    seedMission(fixture, 'm-deploy-row', { status: 'implementing' })
    seedGate(fixture, 'm-deploy-row', { id: 'GATE-D1', source: 'dsh-deploy-gate', state: 'PASS', scopeFull: true, results: [{}] })
    fs.writeFileSync(
        path.join(fixture.cwd, '.dsh', 'deployments.jsonl'),
        `${JSON.stringify({ at: NOW, id: 'DPL-1', environment: 'prod', revision: 'r1', deployer: 'test', state: 'deployed', gateId: 'GATE-D1' })}\n`,
    )
    const dimension = missionConformance(contextOf(fixture), 'm-deploy-row').dimensions.consistency
    assert.equal(dimension.state, 'consistent')
    assert.ok(dimension.facts.some((fact) => /1 个部署门禁都有对应行/.test(fact)))
})

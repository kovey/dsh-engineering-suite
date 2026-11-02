/**
 * 一致性总览的两个"面"与一条边界。
 *
 *  1. `orchestrate({ action: 'metrics' })` 多了一段**跨 mission 分布**：头行状态计数、
 *     每维状态计数、与上一窗口相比的趋势行、盲区。**没有加权分数**。
 *  2. 零权力：`conformance` 从 `dsh-eng-core` 导出，但**没有任何门禁包引用它**
 *     （机械检查：`grep` 每个包的 `src`，只允许 eng-core / suite-doctor /
 *     orchestrator 出现这个名字）；
 *  3. `mission_complete` 的裁决不受它影响：先算一致性再交付，与直接交付给出**逐字节
 *     相同**的阻断报告，且 `.dsh` 在一致性计算前后逐字节一致。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    EMPTY_POLICY_VERSION,
    MissionStore,
    conformanceOverview,
    resolveLayout,
    type GateRecord,
    type GitFingerprint,
    type MissionRecord,
    type SpecRecord,
} from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** A host with the orchestrator mounted (log outside the workspace). */
function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('orchestrator-conf-log-'), 'orchestrator.log') })
    return fake
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

function specOf(at: number): SpecRecord {
    return {
        title: '测试规格',
        background: '',
        requirements: [],
        acceptanceCriteria: [],
        fileBoundaries: [],
        negativeConstraints: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
        approvedAt: at,
        approvedBy: 'alice',
    }
}

function mandateOf(policyVersion: string, at: number): MissionRecord['mandate'] {
    return {
        version: 1,
        strength: 'explicit',
        basis: 'spec-approved',
        scope: { phases: [], paths: [] },
        policyVersion,
        approvedBy: 'alice',
        at,
    }
}

/** One mission in the trail, with exactly the fields the distribution reads. */
function seedMission(
    store: MissionStore,
    cwd: string,
    input: { id: string; createdAt: number; complete?: boolean; fingerprint?: GitFingerprint },
): void {
    store.create({ id: input.id, title: `任务 ${input.id}`, cwd })
    const created = store.read(input.id)
    assert.ok(created !== undefined)
    if (input.complete !== true) {
        store.save({ ...created, createdAt: input.createdAt, status: 'draft' })
        return
    }
    store.save({
        ...created,
        createdAt: input.createdAt,
        status: 'delivered',
        spec: specOf(input.createdAt),
        mandate: mandateOf(EMPTY_POLICY_VERSION, input.createdAt),
    })
    const gate: GateRecord = {
        id: 'GATE-01',
        missionId: input.id,
        source: 'dsh-quality-gate',
        state: 'PASS',
        checkedAt: input.createdAt,
        reason: '测试门禁',
        results: [
            { id: 'test', name: '测试', command: 'node --test', required: true, exitCode: 0, signal: null, durationMs: 1, timedOut: false, output: 'ok', outputDigest: 'a'.repeat(64) },
        ],
        scope: { selected: ['test'], total: 1, full: true },
        ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    }
    store.writeArtifact(input.id, path.join('gates', 'GATE-01.json'), `${JSON.stringify(gate)}\n`)
    const rows = [
        { id: 'EV-001', missionId: input.id, kind: 'command', summary: '命令证据', recordedAt: input.createdAt, recordedBy: 'agent', exitCode: 0 },
        { id: 'EV-002', missionId: input.id, kind: 'test', summary: '测试证据', recordedAt: input.createdAt, recordedBy: 'agent', exitCode: 0 },
    ]
    store.writeArtifact(input.id, 'evidence.jsonl', `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const relative = path.join('receipts', 'RCP-01.json')
    const receipt = {
        id: 'RCP-01',
        missionId: input.id,
        issuedAt: input.createdAt,
        issuedBy: 'dsh-evidence-gate',
        digest: 'b'.repeat(64),
        gateId: 'GATE-01',
        evidenceIds: ['EV-001', 'EV-002'],
        path: path.relative(cwd, path.join(store.layout.missionsDir, input.id, relative)),
    }
    store.writeArtifact(input.id, relative, `${JSON.stringify(receipt)}\n`)
}

/** Content hash of every file under `.dsh`. */
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

/** One `- 头行状态：…` line parsed into counts. */
function headlineCounts(report: string): Record<string, number> {
    const line = report.split('\n').find((entry) => entry.startsWith('- 头行状态')) ?? ''
    const counts: Record<string, number> = {}
    for (const match of line.matchAll(/(conformant|partial|divergent|unknown) (\d+)/g)) {
        counts[match[1] as string] = Number(match[2])
    }
    return counts
}

// --- metrics：跨 mission 分布 ------------------------------------------------

test('metrics adds a cross-mission distribution (headline + per-dimension counts), never a score', async () => {
    const cwd = tempWorkspace('orchestrator-conformance-metrics-')
    const fake = host(cwd)
    const store = new MissionStore({ layout: resolveLayout(cwd) })
    const now = Date.now()
    // A complete delivery: its authorization is `ok` (a fact the distribution must count).
    seedMission(store, cwd, { id: 'm-complete', createdAt: now - 2 * 86_400_000, complete: true })
    // Nothing recorded: the headline can only be divergent (evidence absent is the worst dimension).
    seedMission(store, cwd, { id: 'm-empty', createdAt: now - 86_400_000 })

    const report = await orchestrate(fake, { action: 'metrics' })
    assert.match(report, /### 一致性分布（最新 20 个 mission；头行 = 五个维度里最差的一个）/)
    assert.match(report, /- 头行状态（2 个）：conformant \d+、partial \d+、divergent \d+、unknown \d+/)
    for (const label of ['授权', '证据', '门禁', '新鲜度', '一致性']) {
        assert.ok(report.includes(`- ${label}：`), `missing per-dimension line: ${label}`)
    }
    // Two missions, two headlines: the counts are of the list they name.
    const counts = headlineCounts(report)
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 2)
    assert.ok((counts['divergent'] ?? 0) >= 1, 'a mission with nothing recorded must not read as conformant')
    // `ok` authorization is counted for the complete mission (this is a fact count, not a score).
    const auth = report.split('\n').find((line) => line.startsWith('- 授权：')) ?? ''
    assert.match(auth, /ok 1/)
    assert.match(report, /- 盲区：/)
    assert.match(report, /plan\.jsonl 不存在/)
    for (const forbidden of ['得分', '加权', '总分', '分数', '评分']) {
        assert.equal(report.includes(forbidden), false, `must not print a composite score: ${forbidden}`)
    }
    // Still read-only: the distribution reads ledgers, it never creates one.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'releases.jsonl')), false)
})

test('metrics distribution says 没有 mission on an empty repository instead of implying agreement', async () => {
    const cwd = tempWorkspace('orchestrator-conformance-empty-')
    const fake = host(cwd)
    const report = await orchestrate(fake, { action: 'metrics' })
    assert.match(report, /### 一致性分布/)
    assert.match(report, /- 没有 mission：没有可比较的一致性样本（这不是"全部一致"）。/)
    assert.match(report, /- 盲区：/)
    for (const claim of ['看起来健康', '一切正常']) assert.equal(report.includes(claim), false)
    assert.match(report, /没有可比较的一致性样本（这不是"全部一致"）/, 'the negation must be explicit')
})

test('metrics distribution prints 与上一窗口相比 only when there is a previous window', async () => {
    const cwd = tempWorkspace('orchestrator-conformance-trend-')
    const fake = host(cwd)
    const store = new MissionStore({ layout: resolveLayout(cwd) })
    const now = Date.now()
    for (let index = 0; index < 22; index += 1) {
        seedMission(store, cwd, { id: `m-${String(index).padStart(2, '0')}`, createdAt: now - (index + 1) * 3_600_000 })
    }
    const report = await orchestrate(fake, { action: 'metrics' })
    assert.match(
        report,
        /- 与上一窗口相比（上一窗口 2 个 mission → 本窗口 20 个）：conformant \d+→\d+、partial \d+→\d+、divergent \d+→\d+、unknown \d+→\d+/,
    )
    assert.match(report, /只统计最新 20 个 mission（仓库共 22 个）/)
})

test('metrics distribution is deterministic: two runs on the same tree are byte-identical', async () => {
    const cwd = tempWorkspace('orchestrator-conformance-deterministic-')
    const fake = host(cwd)
    const store = new MissionStore({ layout: resolveLayout(cwd) })
    const now = Date.now()
    for (const [index, complete] of [true, false, true].entries()) {
        seedMission(store, cwd, { id: `m-${index}`, createdAt: now - (index + 1) * 3_600_000, complete })
    }
    const first = await orchestrate(fake, { action: 'metrics' })
    const second = await orchestrate(fake, { action: 'metrics' })
    assert.equal(first, second)
})

// --- 零权力 -----------------------------------------------------------------

test('zero authority: conformance is exported from eng-core but no gate package references it', () => {
    const allowed = new Set(['dsh-eng-core', 'dsh-suite-doctor', 'dsh-orchestrator'])
    const offenders: string[] = []
    const walk = (dir: string, onFile: (file: string) => void): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full, onFile)
            else if (entry.isFile() && entry.name.endsWith('.ts')) onFile(full)
        }
    }
    for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (allowed.has(entry.name)) continue
        const src = path.join(PACKAGES_DIR, entry.name, 'src')
        if (!fs.existsSync(src)) continue
        walk(src, (file) => {
            if (/conformance/i.test(fs.readFileSync(file, 'utf8'))) {
                offenders.push(path.relative(PACKAGES_DIR, file))
            }
        })
    }
    assert.deepEqual(offenders, [], `no gate package may read conformance (found in: ${offenders.join(', ')})`)
})

test('zero authority: mission_complete behaves exactly the same whether or not conformance ran first', async () => {
    // The gate is loaded through its public package entry (this test never edits it).
    const evidenceGate = (await import('dsh-evidence-gate')) as {
        apply: (ctx: never, config: unknown) => void
    }

    /** A workspace with one draft mission: mission_complete's deterministic refusal. */
    const prepare = (): { cwd: string; fake: FakeHost } => {
        const cwd = tempWorkspace('conformance-zero-authority-')
        const store = new MissionStore({ layout: resolveLayout(cwd) })
        store.create({ id: 'm-delivery', title: '交付测试', cwd })
        const fake = createFakeHost({ cwd })
        hosts.push(fake)
        evidenceGate.apply(
            fake.ctx as never,
            { logFile: path.join(tempWorkspace('conformance-zero-authority-log-'), 'evidence-gate.log') },
        )
        return { cwd, fake }
    }

    const direct = prepare()
    const directRun = await direct.fake.runTool('mission_complete', { missionId: 'm-delivery' })
    assert.equal(directRun.isError, false, runText(directRun))
    const directText = runText(directRun)
    assert.match(directText, /不能交付/)

    const afterConformance = prepare()
    const before = snapshotDsh(afterConformance.cwd)
    const overview = conformanceOverview({ layout: resolveLayout(afterConformance.cwd), now: 1_760_000_000_000 })
    assert.equal(overview.mission.missionId, 'm-delivery', 'the helper must actually have run')
    assert.ok(overview.mission.dimensions.evidence.detail.length > 0)
    const after = snapshotDsh(afterConformance.cwd)
    assert.deepEqual(after, before, 'computing conformance must write nothing')

    const conformanceFirstRun = await afterConformance.fake.runTool('mission_complete', { missionId: 'm-delivery' })
    assert.equal(conformanceFirstRun.isError, false, runText(conformanceFirstRun))
    assert.equal(
        runText(conformanceFirstRun),
        directText,
        'mission_complete must decide from gate records + receipts only — never from the conformance helper',
    )

    // And the mission is still a draft with no receipt: the refusal actually held.
    const store = new MissionStore({ layout: resolveLayout(afterConformance.cwd) })
    const mission = store.read('m-delivery')
    assert.equal(mission?.status, 'draft')
    assert.deepEqual(store.readReceipts('m-delivery'), [])
})

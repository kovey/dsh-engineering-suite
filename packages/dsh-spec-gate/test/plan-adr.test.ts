/**
 * dsh-spec-gate planning tests: the cross-mission plan ledger (`plan_status`),
 * milestones on specifications, and the architecture-decision records
 * (`adr_record` / `adr_list`).
 *
 * The two rules these tests exist for: a ledger write may never fail a spec
 * operation (the specification is the authority, the ledger is an index), and a
 * requirement id in two missions is a CONFLICT to report — never a merge.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { DEFAULT_PLAN_FILE, planLedgerFile, readPlanLedger } from '../dist/plan-ledger.js'
import { adrIndexPath, adrSlug, listAdrRecords } from '../dist/adr.js'
import { resolveConfig } from '../dist/config.js'
import { milestoneProblem } from '../dist/spec.js'

const TEST_DESIGN = [
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动 | 请求 /health | 返回 200 | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口被占用 | 启动服务 | 退出码非 0 并打印原因 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 配置为空 | 启动服务 | 使用默认端口 | AC-001 |',
    '',
].join('\n')

const DRAFT = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: ['暴露 GET /health'],
    acceptanceCriteria: ['GET /health 返回 200', '端口占用时启动失败'],
    fileBoundaries: ['src/server.ts'],
    negativeConstraints: ['不得修改 dsh 核心代码'],
    testDesign: TEST_DESIGN,
}

function host(
    options: { approvalOutcome?: 'allowed-once' | 'rejected'; cwd?: string; config?: Record<string, unknown> } = {},
): FakeHost {
    const cwd = options.cwd ?? tempWorkspace('spec-plan-')
    const fake = createFakeHost({
        cwd,
        ...(options.approvalOutcome === undefined ? {} : { approvalOutcome: options.approvalOutcome }),
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log'), ...(options.config ?? {}) })
    return fake
}

/** The mission id of the only specification in a workspace. */
function missionIdOf(cwd: string): string {
    return fs.readdirSync(path.join(cwd, '.dsh', 'specs'))[0]?.replace(/\.md$/, '') ?? ''
}

/** The plan ledger's rows, read back through the plugin's own reader. */
function ledger(cwd: string, file = DEFAULT_PLAN_FILE): ReturnType<typeof readPlanLedger> {
    return readPlanLedger(path.join(cwd, file))
}

/** The rendered section of one milestone group (`### <label> …`). */
function groupOf(text: string, label: string): string {
    const start = text.indexOf(`### ${label}`)
    assert.notEqual(start, -1, `group "${label}" is missing from:\n${text}`)
    const rest = text.slice(start)
    const next = rest.indexOf('\n### ', 1)
    return next === -1 ? rest : rest.slice(0, next)
}

/** A structural snapshot of everything under a directory. */
function snapshot(dir: string): string {
    const parts: string[] = []
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                parts.push(`dir ${path.relative(dir, full)}`)
                walk(full)
                continue
            }
            parts.push(`file ${path.relative(dir, full)} ${fs.readFileSync(full, 'utf8')}`)
        }
    }
    walk(dir)
    return parts.join('\n')
}

test('spec_create, spec_approve and spec_amend each append their ledger rows', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    const created = await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    assert.equal(created.isError, false)
    const missionId = missionIdOf(fake.cwd)

    const afterCreate = ledger(fake.cwd).rows
    assert.deepEqual(
        afterCreate.map((row) => row.kind),
        ['spec-created', 'milestone-changed'],
        'the created row plus the milestone transition that actually happened',
    )
    assert.deepEqual(afterCreate[0]?.requirementIds, ['R-001'])
    assert.deepEqual(afterCreate[0]?.criteriaIds, ['AC-001', 'AC-002'])
    assert.equal(afterCreate[0]?.missionId, missionId)
    assert.equal(afterCreate[0]?.specId, missionId)
    assert.equal(afterCreate[0]?.milestone, 'v1.0')
    assert.match(afterCreate[1]?.summary ?? '', /里程碑：\(无\) → v1\.0/)

    assert.equal((await fake.runTool('spec_approve', {})).isError, false)
    assert.equal((await fake.runTool('spec_amend', { part: 'requirement', action: 'add', text: '暴露 GET /ready' })).isError, false)
    assert.equal(
        (await fake.runTool('spec_amend', { part: 'requirement', action: 'remove', target: 'R-001', note: '范围缩小' })).isError,
        false,
    )

    const rows = ledger(fake.cwd).rows
    assert.deepEqual(
        rows.map((row) => row.kind),
        ['spec-created', 'milestone-changed', 'spec-approved', 'spec-amended', 'spec-amended', 'requirement-retired'],
    )
    const approved = rows.find((row) => row.kind === 'spec-approved')
    assert.equal(approved?.approvedBy, 'approval')
    assert.deepEqual(approved?.criteriaIds, ['AC-001', 'AC-002'])
    const retired = rows.at(-1)
    assert.deepEqual(retired?.retiredRequirementIds, ['R-001'])
    assert.deepEqual(retired?.requirementIds, ['R-002'])
    assert.match(retired?.summary ?? '', /作废 R-001/)
})

test('a failing ledger write never fails the spec operation, and IS reported', async () => {
    const fake = host()
    // A directory where the ledger file belongs: every append fails.
    fs.mkdirSync(path.join(fake.cwd, '.dsh', 'plan.jsonl'), { recursive: true })

    const run = await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    assert.equal(run.isError, false, 'the specification is the authority: it was written')
    const text = runText(run)
    assert.match(text, /规格已写入/)
    assert.match(text, /规划台账写入失败/)
    assert.match(text, /台账只是索引/)
    assert.ok(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs', `${missionIdOf(fake.cwd)}.md`)))
})

test('the newest ledger row wins when reconstruction sees several rows', async () => {
    const fake = host()
    await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    const before = runText(await fake.runTool('plan_status', {}))
    assert.match(groupOf(before, '里程碑：v1.0'), /`R-001`/)
    assert.doesNotMatch(before, /### 无里程碑/)

    await fake.runTool('spec_amend', { part: 'requirement', action: 'add', text: '暴露 GET /ready', milestone: 'v2.0' })
    const after = runText(await fake.runTool('plan_status', {}))
    const group = groupOf(after, '里程碑：v2.0')
    assert.match(group, /`R-001`/)
    assert.match(group, /`R-002`/)
    assert.doesNotMatch(after, /### 里程碑：v1\.0/, 'the newest row moved the requirement out of the old milestone')
    assert.ok(
        ledger(fake.cwd).rows.some((row) => row.kind === 'milestone-changed' && row.summary.includes('v1.0 → v2.0')),
        'the milestone transition is recorded as its own row',
    )
})

test('plan_status groups by milestone (with 无里程碑), filters, and answers in JSON', async () => {
    const fake = host()
    const other = fakeAgent(fake.cwd, 'agent-2', 'session-2')
    const first = await fake.runTool('spec_create', { ...DRAFT, title: 'Milestoned mission', milestone: 'v1.0' })
    assert.equal(first.isError, false)
    const second = await fake.runTool('spec_create', { ...DRAFT, title: 'Unmilestoned mission' }, { agent: other })
    assert.equal(second.isError, false)

    const text = runText(await fake.runTool('plan_status', {}))
    assert.match(text, /### 里程碑：v1\.0（3 条）/)
    assert.match(text, /### 无里程碑（3 条）/)
    assert.match(groupOf(text, '无里程碑'), /`AC-001`/)
    assert.match(groupOf(text, '里程碑：v1.0'), /mission `/)
    assert.match(text, /里程碑 v1\.0/)
    assert.doesNotMatch(text, /### 未交付（0 条）\n\n\(无\)/, 'both missions are undelivered')

    // Milestone filter (including the explicit no-milestone group) and the
    // mission filter answer narrower views of the same ledger.
    const onlyMilestoned = runText(await fake.runTool('plan_status', { milestone: 'v1.0' }))
    assert.doesNotMatch(onlyMilestoned, /### 无里程碑/)
    const onlyUnmilestoned = runText(await fake.runTool('plan_status', { milestone: '无里程碑' }))
    assert.doesNotMatch(onlyUnmilestoned, /### 里程碑：v1\.0/)
    const perMission = runText(await fake.runTool('plan_status', { missionId: missionIdOf(fake.cwd) }))
    assert.match(perMission, /mission：1 个/)

    const json = JSON.parse(runText(await fake.runTool('plan_status', { json: true }))) as {
        exists: boolean
        groups: { label: string }[]
        rows: number
    }
    assert.equal(json.exists, true)
    assert.deepEqual(
        json.groups.map((group) => group.label).sort(),
        ['v1.0', '无里程碑'],
    )
    assert.equal(json.rows, 3, 'two spec-created rows plus the milestone transition of the first')
    assert.equal(json.groups.length, 2, 'both missions are grouped, including 无里程碑')
})

test('plan_status lists 未交付 and 已作废, and delivery follows the receipt', async () => {
    const fake = host()
    await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    const missionId = missionIdOf(fake.cwd)
    await fake.runTool('spec_amend', { part: 'requirement', action: 'remove', target: 'R-001', note: '不做这个了' })

    const before = runText(await fake.runTool('plan_status', {}))
    assert.match(before, /### 已作废（1 条）/)
    assert.match(groupOf(before, `已作废（1 条）`), /`R-001`.*编号不会复用/)
    assert.doesNotMatch(groupOf(before, '里程碑：v1.0'), /`R-001`/, 'a retired id leaves the active groups')
    assert.match(before, /### 未交付（2 条）/)
    assert.match(before, /规格 draft/)

    // A receipt for the mission is what "delivered" means.
    const stores = new MissionStoreRegistry({})
    stores.for(fake.cwd).issueReceipt(missionId, { issuedBy: 'test', gateId: 'GATE-1', evidenceIds: [] })
    const after = runText(await fake.runTool('plan_status', {}))
    assert.match(after, /### 未交付（0 条）/)
    assert.match(after, /已交付/)
})

test('a requirement id in two missions is reported as a conflict, not merged', async () => {
    const fake = host()
    const other = fakeAgent(fake.cwd, 'agent-2', 'session-2')
    const first = await fake.runTool('spec_create', { ...DRAFT, title: 'Mission one', milestone: 'v1.0' })
    assert.equal(first.isError, false)
    const second = await fake.runTool(
        'spec_create',
        { ...DRAFT, title: 'Mission two', requirements: ['暴露 GET /ready'], milestone: 'v1.0' },
        { agent: other },
    )
    assert.equal(second.isError, false)
    const ids = fs.readdirSync(path.join(fake.cwd, '.dsh', 'specs')).map((name) => name.replace(/\.md$/, '')).sort()
    assert.equal(ids.length, 2)

    const text = runText(await fake.runTool('plan_status', {}))
    // Three ids are shared (R-001, AC-001, AC-002): the two missions restart
    // their numbering, which is exactly what the reverse lookup must reveal.
    assert.match(text, /### ⚠ 冲突（3 个编号出现在多个 mission）/)
    const conflict = groupOf(text, '⚠ 冲突（3 个编号出现在多个 mission）')
    for (const id of ['R-001', 'AC-001', 'AC-002']) assert.match(conflict, new RegExp(`\`${id}\``))
    for (const id of ids) assert.match(conflict, new RegExp(`\`${id}\``))
    assert.match(conflict, /不会替你合并或改号/)
    assert.match(text, /`R-001`.*⚠ 重号：也出现在/)
    // Each mission keeps its OWN instances: the same address, two requirements.
    assert.match(groupOf(text, '里程碑：v1.0'), /`R-001` 暴露 GET \/health/)
    assert.match(groupOf(text, '里程碑：v1.0'), /`R-001` 暴露 GET \/ready/)
})

test('plan_status names the missing ledger instead of pretending everything is fine', async () => {
    const fake = host()
    const text = runText(await fake.runTool('plan_status', {}))
    assert.match(text, /本仓库还没有规划台账（第一条 spec_create 会创建）/)
    assert.match(text, /\.dsh\/plan\.jsonl/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'plan.jsonl')), false, 'reading created nothing')
})

test('reading the ledger tolerates a truncated last line', async () => {
    const fake = host()
    await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    fs.appendFileSync(path.join(fake.cwd, DEFAULT_PLAN_FILE), '{"at":1,"kind":"spec-created","mission\n')
    const read = ledger(fake.cwd)
    assert.equal(read.unparsable, 1)
    const text = runText(await fake.runTool('plan_status', {}))
    assert.match(text, /另有 1 行无法解析/)
    assert.match(text, /`R-001`/, 'the readable rows still answer')
})

test('plan_status and adr_list write nothing (snapshot .dsh before/after)', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    await fake.runTool('spec_approve', {})
    await fake.runTool('adr_record', { title: 'Use SQLite for the local store', decision: 'Embedded database, no server to operate.' })
    const before = snapshot(path.join(fake.cwd, '.dsh'))

    assert.equal((await fake.runTool('plan_status', {})).isError, false)
    assert.equal((await fake.runTool('plan_status', { json: true })).isError, false)
    const listed = await fake.runTool('adr_list', {})
    assert.equal(listed.isError, false)
    assert.match(runText(listed), /Use SQLite for the local store/)

    assert.equal(snapshot(path.join(fake.cwd, '.dsh')), before)
})

test('adr_record numbers from 0001, never overwrites, and keeps the index append-only', async () => {
    const fake = host()
    const first = await fake.runTool('adr_record', {
        title: 'Use SQLite for the local store',
        decision: 'SQLite is embedded and needs no server to operate.',
        alternatives: 'Postgres was rejected: a server per developer is not worth it.',
        consequences: 'Writes are serialised; a future multi-writer mode needs a migration.',
    })
    assert.equal(first.isError, false)
    assert.match(runText(first), /已记录 ADR 0001/)
    const adrDir = path.join(fake.cwd, '.dsh', 'adr')
    const file = path.join(adrDir, '0001-use-sqlite-for-the-local-store.md')
    assert.ok(fs.existsSync(file))
    const body = fs.readFileSync(file, 'utf8')
    for (const heading of ['## 状态', '## 背景', '## 决定', '## 备选方案与为什么不选', '## 后果', '## 证据链接']) {
        assert.ok(body.includes(heading), `the ADR carries ${heading}`)
    }
    assert.match(body, /```json\n\{/)
    assert.match(body, /"number": 1/)
    assert.match(body, /SQLite is embedded/)

    const second = await fake.runTool('adr_record', { title: 'Ship behind a flag', decision: 'The store starts disabled.' })
    assert.equal(second.isError, false)
    assert.ok(fs.existsSync(path.join(adrDir, '0002-ship-behind-a-flag.md')), 'the next number is max + 1')
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'the first record was not rewritten')

    // The index is one row per transition.
    const rows = fs
        .readFileSync(path.join(adrDir, 'index.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { number: number; path: string; title: string })
    assert.deepEqual(
        rows.map((row) => row.number),
        [1, 2],
    )
    assert.equal(rows[0]?.title, 'Use SQLite for the local store')
    assert.equal(rows[0]?.path, path.join('.dsh', 'adr', '0001-use-sqlite-for-the-local-store.md'))
})

test('adr_record refuses a target path that already exists (never overwrite)', async () => {
    const fake = host()
    const adrDir = path.join(fake.cwd, '.dsh', 'adr')
    fs.mkdirSync(adrDir, { recursive: true })
    // A number the 4-digit scan cannot see (5 digits) plus an out-of-band file
    // at the path it computes: exactly the race the write-once rule exists for.
    fs.writeFileSync(
        path.join(adrDir, 'index.jsonl'),
        `${JSON.stringify({ at: 1, number: 9999, slug: 'old', path: '.dsh/adr/9999-old.md', title: 'Old decision' })}\n`,
    )
    const slug = adrSlug('Pick a store')
    const target = path.join(adrDir, `10000-${slug}.md`)
    fs.writeFileSync(target, 'ORIGINAL CONTENT\n')

    const refused = await fake.runTool('adr_record', { title: 'Pick a store', decision: 'Use SQLite.' })
    assert.equal(refused.isError, false, 'a refusal is a result with a fix, not a crash')
    const text = runText(refused)
    assert.match(text, /## 未记录/)
    assert.match(text, /目标文件已存在/)
    assert.match(text, /绝不覆盖/)
    assert.match(text, /### 下一步/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL CONTENT\n')
})

test('a CJK title falls back to a short hash instead of a nameless file', async () => {
    const fake = host()
    const run = await fake.runTool('adr_record', { title: '选择本地存储方案', decision: '先不做分布式存储。' })
    assert.equal(run.isError, false)
    const names = fs.readdirSync(path.join(fake.cwd, '.dsh', 'adr'))
    assert.deepEqual(
        names.filter((name) => name.endsWith('.md')),
        [`0001-${adrSlug('选择本地存储方案')}.md`],
    )
    assert.match(names[0] ?? '', /^\d{4}-adr-[0-9a-f]{8}\.md$/)
    assert.match(runText(run), new RegExp(adrSlug('选择本地存储方案')))
})

test('supersedes must name an existing ADR and appends a supersededBy row', async () => {
    const fake = host()
    const missing = await fake.runTool('adr_record', {
        title: 'Replace the store',
        decision: 'Use SQLite.',
        supersedes: 7,
    })
    assert.equal(missing.isError, false)
    assert.match(runText(missing), /supersedes=0007 不存在/)
    assert.match(runText(missing), /还没有任何 ADR/)

    await fake.runTool('adr_record', { title: 'First decision', decision: 'Start with files.' })
    const replaced = await fake.runTool('adr_record', {
        title: 'Second decision',
        decision: 'Move to SQLite.',
        supersedes: 1,
    })
    assert.equal(replaced.isError, false)
    assert.match(runText(replaced), /取代：0001/)

    const adrDir = path.join(fake.cwd, '.dsh', 'adr')
    const rows = fs
        .readFileSync(path.join(adrDir, 'index.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { number: number; supersedes?: number; supersededBy?: number })
    assert.equal(rows.length, 3, 'the superseded row is APPENDED, never a rewrite')
    assert.equal(rows[0]?.supersededBy, undefined, 'the original row is untouched')
    assert.deepEqual(rows[1], { at: rows[1]?.at, number: 2, slug: 'second-decision', path: rows[1]?.path, title: 'Second decision', supersedes: 1 })
    assert.equal(rows[2]?.number, 1)
    assert.equal(rows[2]?.supersededBy, 2)

    const listed = runText(await fake.runTool('adr_list', {}))
    assert.match(listed, /⚠ 已被 0002 取代/)
    const layout = resolveLayout(fake.cwd, {})
    const records = listAdrRecords(layout, resolveConfig({ logFile: 'x.log' })).records
    assert.equal(records[0]?.number, 2)
    assert.equal(records[1]?.supersededBy, 2)
})

test('adr_list matches title and decision text case-insensitively, newest first', async () => {
    const fake = host()
    const empty = runText(await fake.runTool('adr_list', {}))
    assert.match(empty, /还没有架构决策记录/)

    await fake.runTool('adr_record', {
        title: 'Use SQLite for the local store',
        decision: 'SQLite keeps the installation to one binary.',
        missionId: 'mission-a',
    })
    await fake.runTool('adr_record', { title: 'Ship behind a flag', decision: 'The gateway starts disabled.' })

    const byDecision = runText(await fake.runTool('adr_list', { query: 'sqlite keeps' }))
    assert.match(byDecision, /0001 Use SQLite for the local store/)
    assert.doesNotMatch(byDecision, /Ship behind a flag/)
    const byTitle = runText(await fake.runTool('adr_list', { query: 'BEHIND A FLAG' }))
    assert.match(byTitle, /0002 Ship behind a flag/)
    assert.doesNotMatch(byTitle, /SQLite/)
    const byMission = runText(await fake.runTool('adr_list', { missionId: 'mission-a' }))
    assert.match(byMission, /mission `mission-a`/)

    const all = runText(await fake.runTool('adr_list', {}))
    assert.ok(all.indexOf('0002') < all.indexOf('0001'), 'newest first')
    const none = runText(await fake.runTool('adr_list', { query: 'nothing matches this' }))
    assert.match(none, /没有匹配的记录/)
})

test('milestone validation refuses what cannot be grouped, and accepts what can', async () => {
    const fake = host()
    const tooLong = await fake.runTool('spec_create', { ...DRAFT, milestone: `v${'1'.repeat(70)}` })
    assert.equal(tooLong.isError, true)
    assert.match(String(tooLong.content), /最长 64 个字符/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs')), false, 'nothing was written')

    const control = await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1\n1.1' })
    assert.equal(control.isError, true)
    assert.match(String(control.content), /控制字符/)

    const wrongType = await fake.runTool('spec_create', { ...DRAFT, milestone: 12 as never })
    assert.equal(wrongType.isError, true)
    // The tool schema rejects a non-string before `execute` runs; the plugin's
    // own refusal is the second line of defence.
    assert.match(String(wrongType.content), /must be a string|必须是字符串/)

    assert.equal(milestoneProblem('v1.0'), undefined)
    assert.match(milestoneProblem('   ') ?? '', /空白/)

    assert.equal((await fake.runTool('spec_create', { ...DRAFT, milestone: ' v1.0 ' })).isError, false)
    assert.match(runText(await fake.runTool('spec_status', {})), /里程碑: v1\.0/)
    assert.match(runText(await fake.runTool('spec_status', {})), /规划台账: \.dsh\/plan\.jsonl/)
})

test('milestoneRequired refuses spec_create without a milestone, naming the fix', async () => {
    const fake = host({ config: { milestoneRequired: true } })
    const refused = await fake.runTool('spec_create', DRAFT)
    assert.equal(refused.isError, true)
    const text = String(refused.content)
    assert.match(text, /milestoneRequired=true/)
    assert.match(text, /下一步：给 spec_create 传 milestone/)
    assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs')), false, 'nothing was written')

    assert.equal((await fake.runTool('spec_create', { ...DRAFT, milestone: 'M3' })).isError, false)
})

test('a project file may set the milestone rule and relocate the ledger/ADR records (regression)', async () => {
    const cwd = tempWorkspace('spec-plan-projcfg-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'spec-gate.json'),
        JSON.stringify({ milestoneRequired: true, planFile: 'plan/custom.jsonl', adrDir: 'records/adr' }),
    )
    const fake = host({ cwd })
    assert.equal((await fake.runTool('spec_create', DRAFT)).isError, true, 'the project rule applies to this workspace')
    assert.equal((await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })).isError, false)
    assert.ok(fs.existsSync(path.join(cwd, 'plan', 'custom.jsonl')), 'the ledger follows the project override')
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'plan.jsonl')), false)

    const adr = await fake.runTool('adr_record', { title: 'Custom place', decision: 'Records live in records/adr.' })
    assert.equal(adr.isError, false)
    assert.ok(fs.existsSync(path.join(cwd, 'records', 'adr', '0001-custom-place.md')))
    assert.ok(fs.existsSync(path.join(cwd, 'records', 'adr', 'index.jsonl')), 'the index follows adrDir')
    assert.match(runText(await fake.runTool('plan_status', {})), /plan\/custom\.jsonl/)
})

test('the prompt tells the model about the ledger, plan_status and ADRs', () => {
    const fake = host()
    const text = fake.sectionText('eng:spec-gate')
    assert.match(text, /plan_status/)
    assert.match(text, /规划台账/)
    assert.match(text, /adr_record/)
    assert.match(text, /adr_list/)
    assert.match(text, /milestone/)
    assert.match(text, /\.dsh\/plan\.jsonl/)
})

test('spec_amend validates the milestone before touching the specification', async () => {
    const fake = host()
    await fake.runTool('spec_create', { ...DRAFT, milestone: 'v1.0' })
    const missionId = missionIdOf(fake.cwd)
    const before = fs.readFileSync(path.join(fake.cwd, '.dsh', 'specs', `${missionId}.md`), 'utf8')

    const refused = await fake.runTool('spec_amend', {
        part: 'requirement',
        action: 'add',
        text: '暴露 GET /ready',
        milestone: 'x'.repeat(70),
    })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /最长 64 个字符/)
    assert.equal(fs.readFileSync(path.join(fake.cwd, '.dsh', 'specs', `${missionId}.md`), 'utf8'), before, 'nothing was amended')
    assert.deepEqual(
        ledger(fake.cwd).rows.map((row) => row.kind),
        ['spec-created', 'milestone-changed'],
        'no ledger row for a refused amendment',
    )
})

test('the ledger and ADR defaults follow rootDir, overrides are workspace-relative', () => {
    const cwd = tempWorkspace('spec-plan-layout-')
    const config = resolveConfig({ logFile: 'x.log' })
    const trail = resolveLayout(cwd, { rootDir: '.trail' })
    assert.equal(planLedgerFile(trail, config), path.join(cwd, '.trail', 'plan.jsonl'))
    assert.equal(adrIndexPath(trail, config), path.join(cwd, '.trail', 'adr', 'index.jsonl'))
    assert.equal(planLedgerFile(resolveLayout(cwd, {}), config), path.join(cwd, '.dsh', 'plan.jsonl'))
    const overridden = resolveConfig({ logFile: 'x.log', planFile: 'plan/all.jsonl', adrDir: 'decisions' })
    assert.equal(planLedgerFile(resolveLayout(cwd, {}), overridden), path.join(cwd, 'plan', 'all.jsonl'))
    assert.equal(adrIndexPath(resolveLayout(cwd, {}), overridden), path.join(cwd, 'decisions', 'index.jsonl'))
})

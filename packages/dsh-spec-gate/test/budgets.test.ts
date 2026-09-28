/**
 * dsh-spec-gate 非功能预算：声明校验（fail closed，且每条拒绝都带修法）、规格工件里的
 * 「非功能预算」章节、编号稳定性（改/删+作废不复用）、台账行里的预算 id，以及
 * `spec_status` / `plan_status` 报出的验证状态（未验证 ≠ 通过）。
 *
 * 预算随规格存储（`mission.spec` 上的附加字段），所以这里既断言工件（人审批的那份文档），
 * 也断言 mission 记录与规划台账 —— 三者必须描述同一份声明。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { declareBudgets } from '../dist/budgets.js'
import { DEFAULT_PLAN_FILE, readPlanLedger } from '../dist/plan-ledger.js'

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
    requirements: ['暴露 GET /health', '提供包体积脚本'],
    acceptanceCriteria: ['GET /health 返回 200', '包体积不超过 200KiB'],
    fileBoundaries: ['src/server.ts'],
    negativeConstraints: ['不得修改 dsh 核心代码'],
    testDesign: TEST_DESIGN,
}

/** 一条 durationMs 预算（合法的最小形状）。 */
const HEALTH = {
    id: 'p95-health',
    name: '健康检查 p95',
    metric: 'durationMs',
    command: 'node scripts/p95.mjs',
    threshold: { max: 50, maxRegressionPercent: 10 },
    requirementIds: ['AC-001'],
}

/** 一条 bytes 预算（regex 取数 + 单位）。 */
const BUNDLE = {
    id: 'bundle',
    name: '前端包体积',
    metric: 'bytes',
    command: 'node scripts/size.mjs',
    regex: 'size=(\\d+)',
    unit: 'bytes',
    threshold: { max: 204800 },
    requirementIds: ['AC-002'],
}

/** `BUNDLE` 去掉 regex（工具参数只接受无损 JSON，所以用 delete 而不是 `undefined`）。 */
function withoutRegex(): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...BUNDLE }
    delete copy['regex']
    return copy
}

function host(options: { approvalOutcome?: 'allowed-once' | 'rejected'; cwd?: string } = {}): FakeHost {    const cwd = options.cwd ?? tempWorkspace('spec-budget-')
    const fake = createFakeHost({
        cwd,
        ...(options.approvalOutcome === undefined ? {} : { approvalOutcome: options.approvalOutcome }),
    })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    return fake
}

/** The mission id of the only specification in a workspace. */
function missionIdOf(cwd: string): string {
    return fs.readdirSync(path.join(cwd, '.dsh', 'specs'))[0]?.replace(/\.md$/, '') ?? ''
}

/** The rendered specification artifact. */
function artifact(cwd: string): string {
    return fs.readFileSync(path.join(cwd, '.dsh', 'specs', `${missionIdOf(cwd)}.md`), 'utf8')
}

/** The mission record as stored on disk. */
function recordOf(cwd: string): { spec?: { budgets?: { id: string; threshold: Record<string, number> }[]; retiredBudgets?: string[] } } {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'missions', missionIdOf(cwd), 'mission.json'), 'utf8')) as never
}

/** The plan ledger's rows, read back through the plugin's own reader. */
function ledger(cwd: string): ReturnType<typeof readPlanLedger> {
    return readPlanLedger(path.join(cwd, DEFAULT_PLAN_FILE))
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
    if (fs.existsSync(dir)) walk(dir)
    return parts.join('\n')
}

/** Declare a spec with budgets and return the fake host. */
async function withBudgets(budgets: unknown[] = [HEALTH, BUNDLE]): Promise<FakeHost> {
    const fake = host()
    const run = await fake.runTool('spec_create', { ...DRAFT, budgets })
    assert.equal(run.isError, false, runText(run))
    return fake
}

// --- 渲染 -----------------------------------------------------------------

test('非功能预算：写入规格、渲染成表格，并由 spec_status 报出来', async () => {
    const fake = await withBudgets()
    const markdown = artifact(fake.cwd)
    assert.match(markdown, /## 非功能预算/)
    assert.match(markdown, /\| 编号 \| 名称 \| 指标 \| 阈值 \| 命令 \| 关联需求 \|/)
    // 六个字段都在：编号 / 名称 / 指标 / 阈值 / 命令 / 关联需求
    assert.match(markdown, /\| p95-health \| 健康检查 p95 \| durationMs \| ≤ 50 ms；相对历史最佳 ≤ 10% \| `node scripts\/p95\.mjs` \| AC-001 \|/)
    assert.match(markdown, /\| bundle \| 前端包体积 \| bytes \| ≤ 204800 bytes \| `node scripts\/size\.mjs` \| AC-002 \|/)

    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /非功能预算: 2 条（未验证 2 条 —— 未验证 ≠ 通过）/)
    assert.match(status, /p95-health 健康检查 p95：durationMs ≤ 50 ms；相对历史最佳 ≤ 10%；命令 `node scripts\/p95\.mjs`；关联需求 AC-001/)
    assert.match(status, /验证：未验证（没有任何记录在案的预算裁决提到它）/)
})

test('非功能预算：没有声明的规格不渲染这一节（空的表格是骗人的）', async () => {
    const fake = host()
    assert.equal((await fake.runTool('spec_create', DRAFT)).isError, false)
    assert.doesNotMatch(artifact(fake.cwd), /非功能预算/)
    assert.match(runText(await fake.runTool('spec_status', {})), /非功能预算: 未声明/)
})

test('非功能预算：审批提示里列出声明（人审批的就是这份文档）', async () => {
    const fake = host({ approvalOutcome: 'allowed-once' })
    await fake.runTool('spec_create', { ...DRAFT, budgets: [HEALTH] })
    await fake.runTool('spec_approve', {})
    const reason = (fake.approvalRequests[0] as { reason?: string } | undefined)?.reason ?? ''
    assert.match(reason, /非功能预算: 1 条/)
    assert.match(reason, /p95-health 健康检查 p95：durationMs ≤ 50 ms；相对历史最佳 ≤ 10%/)
    assert.match(reason, /关联 AC-001/)
})

// --- 校验（每一种拒绝都带修法，并且什么都不写） -----------------------------

test('非功能预算：每一种不合法的声明都整份拒绝，并给出修法', async () => {
    // 这些形状能通过工具 schema（宿主/defineTool 先挡掉类型完全不对的调用），由插件逐条拒绝。
    const cases: { name: string; budgets: unknown; expect: RegExp }[] = [
        { name: '缺 id', budgets: [{ name: 'x', metric: 'durationMs', command: 'node a.mjs', threshold: { max: 1 } }], expect: /budgets\[0\]\.id 缺失/ },
        {
            name: 'id 不合法',
            budgets: [{ id: 'p95/health', name: 'x', metric: 'durationMs', command: 'node a.mjs', threshold: { max: 1 } }],
            expect: /id "p95\/health" 不合法/,
        },
        {
            name: 'id 重复',
            budgets: [HEALTH, { ...HEALTH, name: '重复' }],
            expect: /出现了两次/,
        },
        { name: '缺 name', budgets: [{ ...HEALTH, name: '' }], expect: /budgets\[0\]\.name 缺失或为空白/ },
        { name: '缺 command', budgets: [{ ...HEALTH, command: '' }], expect: /command 缺失或为空白/ },
        { name: 'number 缺 regex', budgets: [withoutRegex()], expect: /metric=bytes 需要 regex/ },
        { name: 'durationMs 带 regex', budgets: [{ ...HEALTH, regex: 'x=(\\d+)' }], expect: /durationMs 与 regex/ },
        { name: 'regex 无捕获组', budgets: [{ ...BUNDLE, regex: 'size=\\d+' }], expect: /没有捕获组/ },
        { name: 'regex 不合法', budgets: [{ ...BUNDLE, regex: 'size=(\\d+' }], expect: /不是合法正则/ },
        {
            name: '没有任何界限',
            budgets: [{ ...HEALTH, threshold: {} }],
            expect: /一个界限都没有/,
        },
        {
            name: '未知字段',
            budgets: [{ ...HEALTH, expect: { exitCode: 0 } }],
            expect: /\.expect 不属于非功能预算/,
        },
        {
            name: '未知的关联编号',
            budgets: [{ ...HEALTH, requirementIds: ['AC-999'] }],
            expect: /"AC-999" 在这份规格里不存在.*当前可用编号：R-001、R-002、AC-001、AC-002/s,
        },
    ]
    for (const item of cases) {
        const fake = host()
        const run = await fake.runTool('spec_create', { ...DRAFT, budgets: item.budgets })
        assert.equal(run.isError, true, `${item.name}: 必须拒绝`)
        const text = runText(run)
        assert.match(text, item.expect, item.name)
        assert.match(text, /修正后重新调用 spec_create/, `${item.name}: 拒绝里必须写清下一步`)
        assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'specs')), false, `${item.name}: 拒绝不能写文件`)
        assert.equal(fs.existsSync(path.join(fake.cwd, '.dsh', 'missions')), false, `${item.name}: 拒绝不能留下空 mission`)
    }
})

test('非功能预算：关联编号指向已作废的需求时，拒绝里说明编号不会复用', async () => {
    const fake = host()
    assert.equal((await fake.runTool('spec_create', DRAFT)).isError, false)
    assert.equal((await fake.runTool('spec_amend', { part: 'requirement', action: 'remove', target: 'R-002' })).isError, false)
    const run = await fake.runTool('spec_create', { ...DRAFT, budgets: [{ ...HEALTH, requirementIds: ['R-002'] }] })
    assert.equal(run.isError, true)
    assert.match(runText(run), /"R-002" 在这份规格里不存在/)
    assert.match(runText(run), /它已经被作废（编号不复用）/)
})

test('非功能预算：schema 挡不住的形状由引擎逐条拒绝（数组/编号列表/口径）', () => {
    const context = {
        requirementIds: ['R-001'],
        criterionIds: ['AC-001'],
        retiredBudgets: [],
    }
    const notArray = declareBudgets([], 'p95', context)
    assert.equal(notArray.ok, false)
    assert.match(notArray.ok === false ? notArray.problems.join('\n') : '', /budgets 必须是数组/)
    const notObject = declareBudgets([], [42], context)
    assert.match(notObject.ok === false ? notObject.problems.join('\n') : '', /budgets\[0\]: 必须是对象/)
    const badMetric = declareBudgets([], [{ ...HEALTH, metric: 'seconds' }], context)
    assert.match(badMetric.ok === false ? badMetric.problems.join('\n') : '', /metric 必须是 durationMs \/ number \/ bytes/)
    const badRequirementIds = declareBudgets([], [{ ...HEALTH, requirementIds: 'AC-001' }], context)
    assert.match(badRequirementIds.ok === false ? badRequirementIds.problems.join('\n') : '', /requirementIds 必须是数组/)
    // 已作废的预算编号：任何一次声明都不能复活它。
    const retired = declareBudgets([], [HEALTH], { ...context, retiredBudgets: ['P95-HEALTH'] })
    assert.match(retired.ok === false ? retired.problems.join('\n') : '', /已经被作废过（编号不复用）/)
})

test('非功能预算：关联编号可以指向需求（R-00n）或验收标准（AC-00n）', async () => {
    const fake = await withBudgets([{ ...HEALTH, requirementIds: ['r-001', 'AC-002'] }])
    const status = runText(await fake.runTool('spec_status', {}))
    // 编号按规格里的写法规范化（大小写不敏感，存的是规格里的那个 id）。
    assert.match(status, /关联需求 R-001、AC-002/)
})

// --- 编号稳定性（spec_amend） ----------------------------------------------

test('spec_amend：预算的增 / 改 / 删都记入历史，编号稳定、作废后不复用', async () => {
    const fake = await withBudgets([HEALTH])
    const missionId = missionIdOf(fake.cwd)

    // 改：同一个 id，阈值从 50 放到 80；审批随修订撤销，历史记下 before → after。
    const first = await fake.runTool('spec_approve', {})
    assert.equal(first.isError, false)
    const update = await fake.runTool('spec_amend', {
        part: 'budget',
        action: 'update',
        target: 'p95-health',
        budget: { ...HEALTH, threshold: { max: 80, maxRegressionPercent: 10 } },
        note: '压测口径改为 80ms',
    })
    assert.equal(update.isError, false, runText(update))
    assert.match(runText(update), /修改预算 p95-health/)
    const updated = recordOf(fake.cwd)
    assert.deepEqual(updated.spec?.budgets?.map((budget) => budget.id), ['p95-health'])
    assert.deepEqual(updated.spec?.budgets?.[0]?.threshold, { max: 80, maxRegressionPercent: 10 })
    assert.match(artifact(fake.cwd), /≤ 80 ms/)
    const mission = new MissionStoreRegistry().for(fake.cwd).read(missionId)
    assert.equal(mission?.status, 'draft', '改一条预算会撤销审批（人批准的是上一版文档）')
    assert.equal(mission?.spec?.approvedAt, undefined)
    // 编号没有变过：同一个 id 从头到尾。
    assert.equal(ledger(fake.cwd).rows.at(-1)?.budgetIds?.includes('p95-health'), true)

    // 加一条：新 id 只增不改。
    const added = await fake.runTool('spec_amend', { part: 'budget', action: 'add', budget: BUNDLE })
    assert.equal(added.isError, false, runText(added))
    assert.deepEqual(recordOf(fake.cwd).spec?.budgets?.map((budget) => budget.id), ['p95-health', 'bundle'])

    // 删掉一条：编号作废，台账有 budget-retired 行。
    const removed = await fake.runTool('spec_amend', { part: 'budget', action: 'remove', target: 'bundle', note: '前端不做了' })
    assert.equal(removed.isError, false, runText(removed))
    assert.match(runText(removed), /删除预算 bundle/)
    assert.deepEqual(recordOf(fake.cwd).spec?.budgets?.map((budget) => budget.id), ['p95-health'])
    assert.deepEqual(recordOf(fake.cwd).spec?.retiredBudgets, ['bundle'])
    assert.match(artifact(fake.cwd), /已作废预算编号（不会复用）：bundle/)
    const rows = ledger(fake.cwd).rows
    const retired = rows.find((row) => row.kind === 'budget-retired')
    assert.deepEqual(retired?.retiredBudgetIds, ['bundle'])
    assert.deepEqual(retired?.budgetIds, ['p95-health'], '作废行的活预算清单不再包含被删的 id')

    // 复用旧编号：拒绝，并说明为什么（基线历史按 id 存）。
    const reuse = await fake.runTool('spec_amend', { part: 'budget', action: 'add', budget: BUNDLE })
    assert.equal(reuse.isError, false)
    assert.match(runText(reuse), /已经被作废过（编号不复用）/)
    assert.match(runText(reuse), /下一步/)

    // 对已作废的编号做 update/remove：拒绝。
    const staleDelete = await fake.runTool('spec_amend', { part: 'budget', action: 'remove', target: 'bundle' })
    assert.match(runText(staleDelete), /已经被删除过（编号进入 retired，不会复用）/)

    // 未知编号 / 换 id：拒绝。
    assert.match(runText(await fake.runTool('spec_amend', { part: 'budget', action: 'update', target: 'nope', budget: HEALTH })), /规格里没有预算 "nope"/)
    assert.match(
        runText(await fake.runTool('spec_amend', { part: 'budget', action: 'update', target: 'p95-health', budget: { ...HEALTH, id: 'other' } })),
        /与 budget.id "other" 不一致/,
    )
})

test('spec_amend：整组重声明（budgets 数组）＝ 声明即现状，未列出的作废', async () => {
    const fake = await withBudgets([HEALTH, BUNDLE])
    const reconciled = await fake.runTool('spec_amend', {
        budgets: [{ ...HEALTH, threshold: { max: 60, maxRegressionPercent: 10 } }, { ...HEALTH, id: 'memory', name: '内存峰值' }],
    })
    assert.equal(reconciled.isError, false, runText(reconciled))
    const text = runText(reconciled)
    assert.match(text, /新增 memory/)
    assert.match(text, /修改 p95-health/)
    assert.match(text, /删除 bundle（编号不复用）/)
    assert.deepEqual(recordOf(fake.cwd).spec?.budgets?.map((budget) => budget.id), ['p95-health', 'memory'])
    assert.deepEqual(recordOf(fake.cwd).spec?.retiredBudgets, ['bundle'])

    // `[]` 是明确地删掉全部（省略 budgets 才是"不改动"）。
    const cleared = await fake.runTool('spec_amend', { budgets: [] })
    assert.equal(cleared.isError, false, runText(cleared))
    assert.equal(recordOf(fake.cwd).spec?.budgets, undefined)
    assert.deepEqual(recordOf(fake.cwd).spec?.retiredBudgets, ['bundle', 'p95-health', 'memory'])
    assert.match(artifact(fake.cwd), /当前没有预算；下面是已作废的编号与变更历史/)

    // budgets 与 part/action 同时给出：一次只做一件事。
    const both = await fake.runTool('spec_amend', { part: 'criterion', action: 'update', target: 'AC-001', text: 'x', budgets: [] })
    assert.match(runText(both), /一次调用只做一件事/)

    // 什么都不给：说清楚两条路。
    const nothing = await fake.runTool('spec_amend', {})
    assert.match(runText(nothing), /需要二选一/)
})

test('规格重写不会悄悄删掉预算声明（省略 budgets = 不改动）', async () => {
    const fake = await withBudgets([HEALTH])
    const rewritten = await fake.runTool('spec_create', DRAFT)
    assert.equal(rewritten.isError, false, runText(rewritten))
    assert.deepEqual(recordOf(fake.cwd).spec?.budgets?.map((budget) => budget.id), ['p95-health'])
    assert.match(artifact(fake.cwd), /p95-health/)

    // 改一条需求同样不会碰到预算（core 的 planAmendment 会保留附加字段）。
    const amended = await fake.runTool('spec_amend', { part: 'criterion', action: 'update', target: 'AC-001', text: 'GET /health 返回 200（含 p95 断言）' })
    assert.equal(amended.isError, false, runText(amended))
    assert.deepEqual(recordOf(fake.cwd).spec?.budgets?.map((budget) => budget.id), ['p95-health'])
    assert.match(artifact(fake.cwd), /## 非功能预算/)
})

// --- 台账与验证状态 -------------------------------------------------------

test('plan_status：报出每条 mission 的预算 id 与验证状态（未验证 ≠ 通过）', async () => {
    const fake = await withBudgets([HEALTH, BUNDLE])
    const missionId = missionIdOf(fake.cwd)

    const before = runText(await fake.runTool('plan_status', {}))
    assert.match(before, /非功能预算：2 条（未验证 2 条/)
    assert.match(before, /· 预算 `p95-health`：未验证（没有任何记录在案的预算裁决提到它，关联 AC-001）/)
    assert.match(before, /### 非功能预算（2 条，未验证 2 条）/)

    // 记一条 budget_check 形状的裁决（另一侧插件写进 mission store 的记录）。
    new MissionStoreRegistry().for(fake.cwd).recordGate(missionId, {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: '预算裁决：1/2 条全部在界限内（预算裁决；scope.full=false，不构成交付依据）',
        results: [
            {
                id: 'p95-health',
                name: '预算：健康检查 p95',
                command: 'node scripts/p95.mjs',
                required: true,
                exitCode: 0,
                signal: null,
                durationMs: 12,
                timedOut: false,
                output: '预算：健康检查 p95（p95-health）\n来源：规格\n关联需求：AC-001\n测量值：42 ms',
                outputDigest: 'digest',
            },
        ],
        scope: { selected: ['p95-health'], total: 2, full: false },
    })

    const after = runText(await fake.runTool('plan_status', {}))
    assert.match(after, /非功能预算：2 条（未验证 1 条/)
    assert.match(after, /· 预算 `p95-health`：已验证：PASS @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z，来源：规格（GATE-/)
    assert.match(after, /· 预算 `bundle`：未验证/)

    const json = JSON.parse(runText(await fake.runTool('plan_status', { json: true }))) as {
        budgets: { id: string; verified: boolean; fromSpec?: boolean; requirementIds?: string[] }[]
        unverifiedBudgets: { id: string }[]
    }
    assert.deepEqual(json.budgets.map((budget) => [budget.id, budget.verified, budget.fromSpec, budget.requirementIds]), [
        ['p95-health', true, true, ['AC-001']],
        ['bundle', false, undefined, ['AC-002']],
    ])
    assert.deepEqual(json.unverifiedBudgets.map((budget) => budget.id), ['bundle'])
})

test('只读工具（spec_status / plan_status）不写任何文件', async () => {
    const fake = await withBudgets([HEALTH])
    const dir = path.join(fake.cwd, '.dsh')
    const before = snapshot(dir)
    assert.equal((await fake.runTool('spec_status', {})).isError, false)
    assert.equal((await fake.runTool('plan_status', {})).isError, false)
    assert.equal((await fake.runTool('plan_status', { json: true })).isError, false)
    assert.equal(snapshot(dir), before)
})

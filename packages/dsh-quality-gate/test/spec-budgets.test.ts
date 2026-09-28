/**
 * dsh-quality-gate × 规格预算：`budget_check` 的第二来源 —— mission 规格里声明的非功能预算。
 *
 * 这里的每一条都对应一条纪律：
 *  - 规格声明的预算会被执行，并在报告与门禁行里标注「来源：规格」；
 *  - 宿主配置与规格同 id 时**宿主生效**（它是部署上限），但差别必须被报出来（两个值 + 用了哪个）；
 *  - 关联需求编号进入裁决的 reason 与行，交付的可追溯性才有依据；
 *  - 规格预算测不出来/声明不可用时，和宿主配置一样是**拒绝**（不写基线、不记门禁、绝不退化成 0）；
 *  - `requireSpecBudgets=true` 时，规格声明了预算却一条都没覆盖 = 拒绝（默认 false 不改变既有行为）；
 *  - 预算裁决的 `scope.full` 恒为 false：它不构成交付依据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { runBudgets, type SpecBudgetSource } from '../dist/budget.js'
import { resolveConfig } from '../dist/config.js'

/** One scripted `ctx.subprocess` reply. */
interface Step {
    exitCode?: number | null
    stdout?: string
    stderr?: string
    durationMs?: number
}

/** A `ctx.subprocess` that answers with the script, in order. */
function scriptedService(script: readonly Step[]): { service: unknown; spawns: { argv: readonly string[]; cwd: string }[] } {
    const spawns: { argv: readonly string[]; cwd: string }[] = []
    let index = 0
    return {
        spawns,
        service: {
            spawn(spec: { argv: readonly string[]; cwd: string }) {
                spawns.push({ argv: spec.argv, cwd: spec.cwd })
                const step = script[Math.min(index, script.length - 1)] ?? {}
                index += 1
                const collected = { stdout: step.stdout ?? '', stderr: step.stderr ?? '' }
                return {
                    done: Promise.resolve({ exitCode: step.exitCode ?? 0, signal: null }),
                    collected: {
                        stdout: { readFrom: () => ({ text: collected.stdout }) },
                        stderr: { readFrom: () => ({ text: collected.stderr }) },
                    },
                    terminate: () => undefined,
                }
            },
        },
    }
}

const hosts: FakeHost[] = []
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-budget-gate-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in `cwd` with a scripted subprocess. */
function host(cwd: string, config: Record<string, unknown>, script: readonly Step[]): FakeHost {
    const scripted = scriptedService(script)
    const fake = createFakeHost({ cwd, services: { subprocess: scripted.service } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return fake
}

/** Every file under `dir`, relative path → content (for "wrote nothing" checks). */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(current, entry.name)
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
            if (entry.isDirectory()) walk(absolute, relative)
            else out[relative] = fs.readFileSync(absolute, 'utf8')
        }
    }
    if (fs.existsSync(dir)) walk(dir, '')
    return out
}

/** 规格里声明的一条预算（quality-gate 侧只做结构性读取，不认识 spec-gate 的类型）。 */
interface SpecBudgetLike {
    id: string
    name: string
    metric: string
    command: string
    regex?: string
    unit?: string
    threshold: { max?: number; min?: number; maxRegressionPercent?: number }
    requirementIds?: string[]
}

interface MissionSpecLike {
    title: string
    background: string
    requirements: { id: string; text: string }[]
    acceptanceCriteria: { id: string; text: string }[]
    fileBoundaries: string[]
    negativeConstraints: string[]
    revision: number
    createdAt: number
    updatedAt: number
    approvedAt?: number
    approvedBy?: string
    budgets?: SpecBudgetLike[]
    retiredBudgets?: string[]
}

/**
 * 建一条绑定了会话的 mission，并把规格（含预算）写进 mission 记录。
 *
 * 预算字段是 spec-gate 附加在 `mission.spec` 上的（core 的共享契约里没有），这里用同样的
 * 结构写进去：quality-gate 必须能独立读懂它，而不是靠 import 另一个插件。
 */
function missionWithSpec(
    cwd: string,
    budgets: SpecBudgetLike[] | undefined,
    extras: { retired?: string[]; approved?: boolean; title?: string } = {},
): string {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title: extras.title ?? '规格预算测试', cwd, sessionId: 'session-1' })
    const spec: MissionSpecLike = {
        title: extras.title ?? '规格预算测试',
        background: '规格里声明非功能预算',
        requirements: [{ id: 'R-001', text: '健康检查可用' }],
        acceptanceCriteria: [
            { id: 'AC-001', text: 'GET /health 返回 200' },
            { id: 'AC-003', text: 'p95 小于 50ms' },
        ],
        fileBoundaries: ['src/server.ts'],
        negativeConstraints: ['不得修改 dsh 核心代码'],
        revision: 3,
        createdAt: 1,
        updatedAt: 1,
        ...(extras.approved === false ? {} : { approvedAt: 1, approvedBy: 'human' }),
        ...(budgets === undefined ? {} : { budgets }),
        ...(extras.retired === undefined ? {} : { retiredBudgets: extras.retired }),
    }
    store.update(mission.id, () => ({ status: 'spec-approved', spec: spec as never }))
    store.bindSession('session-1', mission.id)
    return mission.id
}

/** 插件配置：一条门禁命令，预算列表按需给出。 */
function config(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', name: '单元测试', command: 'node -e "0"', required: true, phase: 'gate' }],
        ...extra,
    }
}

/** 规格里的 p95 预算（number：数值从输出里取，测试里可确定）。 */
const P95: SpecBudgetLike = {
    id: 'p95-health',
    name: '健康检查 p95',
    metric: 'number',
    unit: 'ms',
    command: 'node scripts/p95.mjs',
    regex: 'p95=(\\d+)',
    threshold: { max: 50, maxRegressionPercent: 10 },
    requirementIds: ['AC-003'],
}

/** 宿主配置里的一条预算（同 id 用于冲突测试）。 */
function configBudget(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'p95-health',
        name: '健康检查 p95（宿主）',
        metric: 'number',
        unit: 'ms',
        command: 'node scripts/p95.mjs',
        regex: 'p95=(\\d+)',
        max: 200,
        maxRegressionPercent: 10,
        ...extra,
    }
}

// --- 规格作为第二来源 ------------------------------------------------------

test('budget_check：规格声明的预算会被执行，并在报告与门禁行里标注「来源：规格」', async () => {
    const cwd = tempWorkspace('spec-budget-src-')
    const fake = host(cwd, config(), [{ exitCode: 0, stdout: 'p95=42' }])
    const missionId = missionWithSpec(cwd, [P95])

    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /预算门禁：PASS/)
    assert.match(text, /来源：规格/)
    assert.match(text, /规格预算：声明 1 条，本次覆盖 1 条/)
    assert.match(text, /关联需求：AC-003/)
    assert.match(text, /规格预算 p95-health 已按规格验证（关联需求：AC-003）/)

    const store = new MissionStoreRegistry().for(cwd)
    const gate = store.lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    // 预算裁决永远不是宿主的门禁命令集：它不能作为交付依据。
    assert.deepEqual(gate?.scope, { selected: ['p95-health'], total: 1, full: false })
    assert.match(gate?.reason ?? '', /规格预算 p95-health 已按规格验证（关联需求：AC-003）/)
    const row = gate?.results[0]
    assert.equal(row?.id, 'p95-health')
    assert.match(row?.output ?? '', /来源：规格/)
    assert.match(row?.output ?? '', /关联需求：AC-003/)
    assert.match(row?.output ?? '', /测量值：42 ms/)
    // 基线照记：规格预算和宿主预算一样会进入回归护栏。
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'budgets.json')), true)
})

test('budget_check：规格声明了预算但这次没覆盖到时，报告点名（未验证 ≠ 通过）', async () => {
    const cwd = tempWorkspace('spec-budget-uncovered-')
    // 宿主有一条自己的预算，规格另有一条：只选宿主那条时，规格那条没被验证。
    const fake = host(cwd, config({ budgets: [configBudget({ id: 'bundle', name: '包体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\d+)', max: 2000 })] }), [
        { exitCode: 0, stdout: 'size=1200' },
    ])
    missionWithSpec(cwd, [P95])
    const text = runText(await fake.runTool('budget_check', { only: ['bundle'] }))
    assert.match(text, /规格预算：声明 1 条，本次覆盖 0 条/)
    assert.match(text, /一条规格预算都没有被验证（未验证 ≠ 通过）/)
})

// --- 宿主优先，但差别必须报出来 --------------------------------------------

test('budget_check：同 id 时宿主配置生效，差别作为冲突报出来（两个值都写、并说明用了哪个）', async () => {
    const cwd = tempWorkspace('spec-budget-conflict-')
    // 规格说 max=50，宿主说 max=200；实测 120：只有"宿主生效"才会 PASS。
    const fake = host(cwd, config({ budgets: [configBudget()] }), [{ exitCode: 0, stdout: 'p95=120' }])
    const missionId = missionWithSpec(cwd, [P95])

    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /预算门禁：PASS/)
    assert.match(text, /⚠️ 规格与宿主配置冲突（1 条；按"宿主是部署上限"处理，本次使用\*\*宿主配置\*\*的阈值）：/)
    assert.match(text, /- 预算 "p95-health"：规格声明 max=50 ms、回归≤10%；命令 node scripts\/p95\.mjs；regex \/p95=\(\\d\+\)\/；宿主配置 max=200 ms、回归≤10%；命令 node scripts\/p95\.mjs；regex \/p95=\(\\d\+\)\/ —— 本次按宿主配置判定。/)
    assert.match(text, /这条要求可能已经被放宽：请人工确认/)
    // 用的是宿主的口径，所以行也标「来源：宿主配置」，而不是假装规格的那条被执行过。
    assert.match(text, /\[PASS\] p95-health（健康检查 p95（宿主））.*来源：宿主配置/)

    const gate = new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.match(gate?.reason ?? '', /宿主配置与规格有 1 处阈值冲突/)
    assert.deepEqual(gate?.scope, { selected: ['p95-health'], total: 1, full: false })
})

test('budget_check：两个来源的预算并存时都执行（规格的按规格判定）', async () => {
    const cwd = tempWorkspace('spec-budget-both-')
    const fake = host(cwd, config({ budgets: [configBudget({ id: 'bundle', name: '包体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\d+)', max: 2000 })] }), [
        { exitCode: 0, stdout: 'size=1200' },
        { exitCode: 0, stdout: 'p95=42' },
    ])
    missionWithSpec(cwd, [P95])
    const text = runText(await fake.runTool('budget_check', {}))
    assert.match(text, /范围：2\/2 条预算（bundle、p95-health）/)
    assert.match(text, /\[PASS\] p95-health.*来源：规格/)
    assert.match(text, /\[PASS\] bundle.*来源：宿主配置/)
    assert.match(text, /规格预算：声明 1 条，本次覆盖 1 条/)
})

// --- 规格预算测不出来 / 声明不可用：和宿主配置一样是拒绝 ---------------------

test('budget_check：规格预算的 regex 没匹配到数字 = 拒绝，什么都不写', async () => {
    const cwd = tempWorkspace('spec-budget-nomatch-')
    const fake = host(cwd, config(), [{ exitCode: 0, stdout: 'no p95 here' }])
    const missionId = missionWithSpec(cwd, [P95])
    const before = snapshot(path.join(cwd, '.dsh'))
    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.match(text, /正则没有匹配到任何数字/)
    assert.match(text, /命令：node scripts\/p95\.mjs/)
    assert.match(text, /绝不退化成 0|没有写入基线/)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, '拒绝不写基线、不记门禁')
    assert.equal(new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' }), undefined)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'budgets.json')), false)
})

test('budget_check：声明不可用的规格预算整份拒绝（没有界限 / 无捕获组 / 命令切不出 argv / 作废的 id 复活）', async () => {
    const cases: { name: string; budgets: SpecBudgetLike[]; retired?: string[]; expect: RegExp }[] = [
        { name: '没有界限', budgets: [{ ...P95, threshold: {} }], expect: /没有任何界限/ },
        { name: '无捕获组', budgets: [{ ...P95, regex: 'p95=\\d+' }], expect: /没有捕获组/ },
        { name: '命令切不出 argv', budgets: [{ ...P95, command: '""' }], expect: /无法切分为 argv/ },
        { name: '作废的 id 复活', budgets: [P95], retired: ['p95-health'], expect: /已经作废（retired，编号不复用）/ },
        {
            name: 'number 缺 regex',
            budgets: [{ ...P95, regex: undefined } as unknown as SpecBudgetLike],
            expect: /需要 regex/,
        },
    ]
    for (const item of cases) {
        const cwd = tempWorkspace('spec-budget-bad-')
        const fake = host(cwd, config(), [{ exitCode: 0, stdout: 'p95=42' }])
        missionWithSpec(cwd, item.budgets, item.retired === undefined ? {} : { retired: item.retired })
        const before = snapshot(path.join(cwd, '.dsh'))
        const run = await fake.runTool('budget_check', {})
        assert.equal(run.isError, true, `${item.name}: 必须拒绝`)
        const text = runText(run)
        assert.match(text, item.expect, item.name)
        assert.match(text, /下一步/, `${item.name}: 拒绝里必须写清修法`)
        assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, `${item.name}: 拒绝什么都不写`)
    }
})

// --- requireSpecBudgets（宿主 opt-in，默认关闭） ---------------------------

test('requireSpecBudgets=true：规格声明了预算却一条都没覆盖 = 拒绝，并说清下一步', async () => {
    const cwd = tempWorkspace('spec-budget-required-')
    const budgets = [{ id: 'bundle', name: '包体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\d+)', max: 2000 }]
    // 第一次调用在跑命令之前就被拒绝，所以脚本只需要回答第二次（规格那条）的测量。
    const fake = host(cwd, config({ budgets, requireSpecBudgets: true }), [{ exitCode: 0, stdout: 'p95=42' }])
    const missionId = missionWithSpec(cwd, [P95])
    const before = snapshot(path.join(cwd, '.dsh'))

    const refused = await fake.runTool('budget_check', { only: ['bundle'] })
    assert.equal(refused.isError, true)
    const text = runText(refused)
    assert.match(text, /requireSpecBudgets=true/)
    assert.match(text, /规格声明的预算：p95-health/)
    assert.match(text, /本次选中的预算：bundle/)
    assert.match(text, /下一步：去掉 only 参数/)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, '拒绝不能跑命令、不能写基线')
    assert.equal(new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' }), undefined)

    // 覆盖到规格预算之后：放行并记录。
    const passed = await fake.runTool('budget_check', { only: ['p95-health'] })
    assert.equal(passed.isError, false, runText(passed))
    assert.match(runText(passed), /预算门禁：PASS/)
    assert.deepEqual(new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' })?.scope, {
        selected: ['p95-health'],
        total: 2,
        full: false,
    })
})

test('requireSpecBudgets 默认 false：规格声明了预算也不改变既有行为', async () => {
    const cwd = tempWorkspace('spec-budget-default-')
    const budgets = [{ id: 'bundle', name: '包体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\d+)', max: 2000 }]
    const fake = host(cwd, config({ budgets }), [{ exitCode: 0, stdout: 'size=1200' }])
    missionWithSpec(cwd, [P95])
    const run = await fake.runTool('budget_check', { only: ['bundle'] })
    assert.equal(run.isError, false, runText(run))
    assert.match(runText(run), /requireSpecBudgets: false/)
})

test('requireSpecBudgets=true：规格没有声明预算时照旧运行（这条开关只管规格预算）', async () => {
    const cwd = tempWorkspace('spec-budget-none-')
    const budgets = [{ id: 'bundle', name: '包体积', metric: 'bytes', command: 'node size.mjs', regex: 'size=(\\d+)', max: 2000 }]
    const fake = host(cwd, config({ budgets, requireSpecBudgets: true }), [{ exitCode: 0, stdout: 'size=1200' }])
    missionWithSpec(cwd, undefined)
    const run = await fake.runTool('budget_check', {})
    assert.equal(run.isError, false, runText(run))
    assert.match(runText(run), /预算门禁：PASS/)
})

// --- 引擎层：注入时钟与运行器 ---------------------------------------------

test('budgets：规格来源的 durationMs 预算走注入的运行器与时钟，基线照记', async () => {
    const cwd = tempWorkspace('spec-budget-engine-')
    const spec: SpecBudgetSource = {
        budgets: [{ ...P95, metric: 'durationMs', regex: undefined, threshold: { max: 100, maxRegressionPercent: 20 } }],
        missionId: 'm-1',
        revision: 2,
        approved: true,
    }
    const specs: Record<string, unknown>[] = []
    const run = await runBudgets({
        cwd,
        config: resolveConfig(config()),
        rootDir: path.join(cwd, '.dsh'),
        spec,
        now: () => 1_700_000_000_000,
        runner: async (request) => {
            specs.push(request as unknown as Record<string, unknown>)
            return {
                argv: request.argv,
                command: request.argv.join(' '),
                cwd: request.cwd,
                exitCode: 0,
                signal: null,
                stdout: '',
                stderr: '',
                durationMs: 42,
                timedOut: false,
            }
        },
    })
    assert.equal(run.ok, true)
    assert.deepEqual(specs[0]?.['argv'], ['node', 'scripts/p95.mjs'])
    assert.equal(run.ok === true ? run.evaluations[0]?.origin : '', 'spec')
    assert.equal(run.ok === true ? run.evaluations[0]?.value : -1, 42)
    assert.deepEqual(run.ok === true ? run.spec : {}, { declared: 1, covered: 1, missionId: 'm-1', revision: 2, approved: true })
    assert.equal(run.ok === true ? run.scope.full : true, false)
    const baseline = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'budgets.json'), 'utf8')) as { budgets: Record<string, { value: number; at: number }[]> }
    assert.deepEqual(baseline.budgets['p95-health']?.map((entry) => [entry.value, entry.at]), [[42, 1_700_000_000_000]])
})

test('budgets：规格声明的预算无法解析时，整次运行拒绝（不跑命令）', async () => {
    const cwd = tempWorkspace('spec-budget-engine-bad-')
    let ran = 0
    const run = await runBudgets({
        cwd,
        config: resolveConfig(config()),
        rootDir: path.join(cwd, '.dsh'),
        spec: { budgets: [{ id: 'x', metric: 'nonsense', command: 'node x.mjs', threshold: { max: 1 } }] },
        runner: async (request) => {
            ran += 1
            return { argv: request.argv, command: '', cwd, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false }
        },
    })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /规格里声明的 1 条非功能预算无法执行/)
    assert.match(run.ok === false ? run.problem : '', /metric 必须是 durationMs \/ number \/ bytes/)
    assert.equal(ran, 0)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false)
})

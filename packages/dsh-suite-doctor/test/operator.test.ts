/**
 * The operator view (`suite_status`): three questions, in order, and nothing else.
 *
 * The invariants these tests pin down, because each of them can rot silently:
 *
 *  1. **the section order is the operator's order** — "does anything need me
 *     NOW?" before the system's health, and history left where it already lives;
 *  2. **a count equals the length of the list it refers to** — the header number
 *     is the queue length, and a truncated list says how many rows are hidden
 *     (`shown + 另有 N 条 === 总条数`), so "10 shown" can never read as "10
 *     waiting";
 *  3. **a healthy state is ONE line** — the attention section when nothing is
 *     waiting, and the health section when every check is ready;
 *  4. **a probe that failed once is not a problem** — an unreadable attention
 *     queue is stated as unknown (with the reason and the next step) and adds no
 *     blocker, no advice and no check.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { MissionStore, resolveLayout, type DoctorReport, type GateRecord, type MissionRecord, type SpecRecord } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { HISTORY_POINTER, OPERATOR_QUESTIONS, renderOperatorView, type OperatorInput } from '../dist/operator.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

function logFileFor(): string {
    return path.join(tempWorkspace('operator-log-'), 'suite-doctor.log')
}

/** Assemble the plugin in a throwaway workspace. */
function host(cwd: string, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: logFileFor() })
    return fake
}

/** A repo with a git identity (the offline doctor checks `git check-ignore`). */
function repo(): string {
    const cwd = tempWorkspace('operator-')
    execFileSync('git', ['init', '-q'], { cwd })
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    return cwd
}

/** One attention as the interaction layer reports it. */
function attentionOf(id: string, input: { at?: number; missionId?: string; whyYou?: string; stale?: { reason: string; detail: string }; pausedMs?: number } = {}) {
    const at = input.at ?? Date.now()
    return {
        questionId: id,
        title: `问题 ${id}`,
        askedAt: at,
        ageMs: Date.now() - at,
        whyYou: input.whyYou ?? 'decision-required',
        deadlineAt: at + 900_000,
        ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
        ...(input.stale === undefined ? {} : { stale: input.stale }),
        ...(input.pausedMs === undefined ? {} : { pausedMs: input.pausedMs }),
    }
}

/** A synthetic merged report: what the existing checks produced, no runtime needed. */
function reportOf(input: { blockers?: number; advice?: number; checks?: number; cwd?: string } = {}): DoctorReport {
    const blockers = input.blockers ?? 0
    const advice = input.advice ?? 0
    const check = (state: string, severity: string, index: number) => ({
        id: `synthetic.${severity}.${index}`,
        area: 'build' as const,
        state: state as never,
        severity: severity as never,
        label: `检查 ${index}`,
        detail: '细节',
    })
    const checks = [...Array.from({ length: blockers }, (_value, index) => check('missing', 'required', index)), ...Array.from({ length: advice }, (_value, index) => check('partial', 'recommended', index))]
    for (let index = checks.length; index < (input.checks ?? checks.length); index += 1) checks.push(check('ok', 'recommended', index))
    return {
        cwd: input.cwd ?? '/tmp/synthetic',
        rootDir: '/tmp/synthetic/.dsh',
        checks,
        blockers: checks.filter((entry) => entry.severity === 'required'),
        advice: checks.filter((entry) => entry.severity === 'recommended' && entry.state !== 'ok'),
        footprint: { missions: 0, archivedMissions: 0, archivedBytes: 0, bytes: 0, gates: 0, receipts: 0, evidenceRows: 0 },
        generatedAt: 0,
    }
}

/** The content lines of one section, without its heading and blank lines. */
function sectionOf(text: string, index: 1 | 2 | 3 | 4): string[] {
    const lines = text.split('\n')
    // Section 3 is `## 3 一致性…` (no dot) by design; the rest are `## N. …`.
    const start = lines.findIndex((line) => new RegExp(`^## ${index}[. ]`).test(line))
    assert.ok(start >= 0, `缺少第 ${index} 节`)
    const out: string[] = []
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith('## ')) break
        if (line.trim() === '') continue
        out.push(line)
    }
    return out
}

function operatorText(input: Partial<OperatorInput> & { report: DoctorReport }): string {
    return renderOperatorView(input as OperatorInput)
}

test('四问按顺序出现：需要我 → 健康 → 一致性 → 历史（历史只给指路，不重复）', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const text = runText(await fake.runTool('suite_status', {}))

    const positions = OPERATOR_QUESTIONS.map((question) => text.indexOf(question))
    for (const [index, position] of positions.entries()) assert.ok(position >= 0, `第 ${index + 1} 问没有出现`)
    assert.ok(positions[0]! < positions[1]!, '第一问必须排在健康之前')
    assert.ok(positions[1]! < positions[2]!, '一致性必须排在健康之后')
    assert.ok(positions[2]! < positions[3]!, '历史必须排在最后')
    assert.ok(positions[0]! < text.indexOf('配置'), '先回答"要不要我"，再讲配置')
    assert.equal(OPERATOR_QUESTIONS.length, 4)
    assert.equal(text.includes('## 3 一致性（这一项离规则允许的范围有多远）'), true, '第 3 节标题是设计稿指定的')
    assert.equal(text.includes('## 4. 历史'), true, '历史节重编号为 4')

    // Question 4 is a POINTER: one line, no duplicated history.
    const history = sectionOf(text, 4)
    assert.deepEqual(history, [`- ${HISTORY_POINTER}`])
    assert.match(history[0] ?? '', /spec_status/)
    assert.match(history[0] ?? '', /audit_report/)
    assert.equal(text.includes('台账统计'), false, '历史不在操作者视图里重复（那是 interaction_status 的事）')
})

test('计数等于它指向的列表长度；截断时说明还有多少条（shown + 另有 N 条 = 总数）', async () => {
    const cwd = repo()
    const now = Date.now()
    // 12 questions, oldest first: the queue must show 10 and say 2 are hidden.
    const attentions = Array.from({ length: 12 }, (_value, index) => attentionOf(`q-${String(index).padStart(2, '0')}`, { at: now - (12 - index) * 60_000 }))
    const fake = host(cwd, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            attentions: () => attentions,
        },
    })
    const text = runText(await fake.runTool('suite_status', {}))
    const queue = sectionOf(text, 1)
    const rows = queue.filter((line) => line.startsWith('- q-'))
    assert.equal(rows.length, 10, '最多显示 10 条')
    assert.match(queue[0] ?? '', /需要你：12 条/)
    const truncation = queue.find((line) => line.includes('另有'))
    assert.ok(truncation !== undefined, '截断必须说出来')
    assert.match(truncation, /另有 2 条（共 12 条/)
    // The count is the length of the list it refers to.
    const headerCount = Number(/需要你：(\d+) 条/.exec(queue[0] ?? '')?.[1] ?? '0')
    const hidden = Number(/另有 (\d+) 条/.exec(truncation)?.[1] ?? '0')
    assert.equal(headerCount, rows.length + hidden, '表头数字 = 显示的行数 + 隐藏的行数')
    assert.deepEqual(
        rows.map((line) => /^- (q-\d+)/.exec(line)?.[1]),
        attentions.slice(0, 10).map((entry) => entry.questionId),
        '最老在前，按层给出的顺序取前 10 条',
    )
    assert.equal(new Set(rows).size, rows.length, '同一道提问不能重复出现')

    // Not truncated: no "另有" line at all, and the count is the row count.
    const small = host(repo(), {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            attentions: () => [attentionOf('q-a'), attentionOf('q-b'), attentionOf('q-c')],
        },
    })
    const smallText = runText(await small.runTool('suite_status', {}))
    const smallQueue = sectionOf(smallText, 1)
    assert.match(smallQueue[0] ?? '', /需要你：3 条/)
    assert.equal(smallQueue.filter((line) => line.startsWith('- q-')).length, 3)
    assert.equal(smallQueue.some((line) => line.includes('另有')), false, '没有隐藏的就不要提隐藏')
})

test('whyYou 与 stale 徽章（带理由）逐条显示，顺序即层的顺序', async () => {
    const cwd = repo()
    const now = Date.now()
    const stale = { reason: 'too-old', detail: '这道提问已经等了 26 小时，超过上限 24 小时：先确认还要不要这个答案' }
    const fake = host(cwd, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            attentions: () => [
                attentionOf('q-decide', { at: now - 3_600_000, missionId: 'M-1', stale }),
                attentionOf('q-result', { at: now - 1_800_000, whyYou: 'result-usable', pausedMs: 600_000 }),
            ],
        },
    })
    const queue = sectionOf(runText(await fake.runTool('suite_status', {})), 1)
    assert.equal(queue.length, 3, '表头 + 2 行（没有截断行）')
    assert.match(queue[1] ?? '', /q-decide（mission M-1，whyYou=decision-required）：已等 1 小时；⚠️ stale\(too-old\)/)
    assert.match(queue[1] ?? '', /超过上限 24 小时/)
    assert.match(queue[2] ?? '', /q-result（无 mission，whyYou=result-usable）/)
    assert.match(queue[2] ?? '', /已暂停 10 分钟（期限顺延）/)
})

test('健康时只有一行：待办为空一行，检查全绿一行', () => {
    const healthy = operatorText({ report: reportOf({ checks: 6 }), attentions: [] })
    const queue = sectionOf(healthy, 1)
    assert.equal(queue.length, 1, '没有需要你的事：一行')
    assert.match(queue[0] ?? '', /没有需要你处理的提问（0 条/)
    const health = sectionOf(healthy, 2)
    assert.equal(health.length, 1, '全部就绪：一行')
    assert.match(health[0] ?? '', /健康：6 项检查全部就绪/)
    assert.equal(health.some((line) => line.includes('✅')), false, '健康时不列出逐项检查')

    // Anything not ready falls back to the EXISTING report, unchanged.
    const unhealthy = operatorText({ report: reportOf({ blockers: 1, checks: 3 }), attentions: [] })
    const detailed = sectionOf(unhealthy, 2)
    assert.ok(detailed.length > 1)
    assert.match(detailed.join('\n'), /套件自检（suite_status）/, '不健康时给出既有的完整报告')
    assert.match(detailed.join('\n'), /必需项 1 项未就绪/)
})

test('一次探测失败不是"问题"：注意力读不到 → unknown 一行，且不新增 blocker/检查项', async () => {
    const cwd = repo()
    const fake = host(cwd, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            attentions: () => {
                throw new Error('服务暂时不可达（一次网络错误）')
            },
        },
    })
    const run = await fake.runTool('suite_status', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    const queue = sectionOf(text, 1)
    assert.equal(queue.length, 1, '读不到也是一行')
    assert.match(queue[0] ?? '', /未知（读取失败，\*\*不是\*\*"没有"）/)
    assert.match(queue[0] ?? '', /服务暂时不可达/)
    assert.match(queue[0] ?? '', /下一步：/)

    // It is a gap in the report, not a defect of the workspace: no blocker, no
    // advice, no check may appear because a probe failed once.
    const report = JSON.parse(runText(await fake.runTool('suite_status', { json: true }))) as DoctorReport
    assert.equal(
        [...report.blockers, ...report.advice, ...report.checks].some((entry) => /attention|注意力/i.test(`${entry.id} ${entry.label}`)),
        false,
        '读不到的注意力队列不能变成"系统有问题"',
    )
})

test('空列表且没有观察过台账 → unknown，而不是"没有需要你的事"', async () => {
    const cwd = repo()
    const fake = host(cwd, {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => [],
            attentions: () => [],
        },
    })
    const queue = sectionOf(runText(await fake.runTool('suite_status', {})), 1)
    assert.equal(queue.length, 1)
    assert.match(queue[0] ?? '', /未知/)
    assert.match(queue[0] ?? '', /不等于"没有人在等回答"/)
    assert.equal(queue.some((line) => line.includes('没有需要你处理的提问')), false)
})

// --- 第 3 节：一致性（离规则允许的范围有多远） --------------------------------

/** A spec as spec-gate would leave it. */
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

/** A complete delivery: PASS gate with full scope, two evidence kinds, one receipt. */
function seedDelivery(cwd: string, id: string, input: { mandate?: MissionRecord['mandate']; spec?: SpecRecord } = {}): void {
    const store = new MissionStore({ layout: resolveLayout(cwd) })
    const at = Date.now() - 60_000
    store.create({ id, title: `任务 ${id}`, cwd })
    const created = store.read(id)
    assert.ok(created !== undefined)
    store.save({
        ...created,
        status: 'delivered',
        spec: input.spec ?? specOf(at),
        ...(input.mandate === undefined ? {} : { mandate: input.mandate }),
    })
    const gate: GateRecord = {
        id: 'GATE-01',
        missionId: id,
        source: 'dsh-quality-gate',
        state: 'PASS',
        checkedAt: at,
        reason: '测试门禁',
        results: [
            { id: 'test', name: '测试', command: 'node --test', required: true, exitCode: 0, signal: null, durationMs: 1, timedOut: false, output: 'ok', outputDigest: 'a'.repeat(64) },
        ],
        scope: { selected: ['test'], total: 1, full: true },
    }
    store.writeArtifact(id, path.join('gates', 'GATE-01.json'), `${JSON.stringify(gate)}\n`)
    const rows = [
        { id: 'EV-001', missionId: id, kind: 'command', summary: '命令证据', recordedAt: at, recordedBy: 'agent', exitCode: 0 },
        { id: 'EV-002', missionId: id, kind: 'test', summary: '测试证据', recordedAt: at, recordedBy: 'agent', exitCode: 0 },
    ]
    store.writeArtifact(id, 'evidence.jsonl', `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const relative = path.join('receipts', 'RCP-01.json')
    const receipt = {
        id: 'RCP-01',
        missionId: id,
        issuedAt: at,
        issuedBy: 'dsh-evidence-gate',
        digest: 'b'.repeat(64),
        gateId: 'GATE-01',
        evidenceIds: ['EV-001', 'EV-002'],
        path: path.relative(cwd, path.join(store.layout.missionsDir, id, relative)),
    }
    store.writeArtifact(id, relative, `${JSON.stringify(receipt)}\n`)
}

/** Content hash of every file under `.dsh` (the read-only assertion). */
function snapshotDsh(cwd: string): Record<string, string> {
    const root = path.join(cwd, '.dsh')
    const files: Record<string, string> = {}
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else files[path.relative(cwd, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
    }
    if (fs.existsSync(root)) walk(root)
    return files
}

test('第 3 节：空仓库 ⇒ 五维全 unknown + 原因，头行 unknown，绝不"看起来健康"', async () => {
    const cwd = repo()
    const text = runText(await host(cwd).runTool('suite_status', {}))
    const section = sectionOf(text, 3)
    assert.match(section[0] ?? '', /^- mission：.*还没有 mission/)
    assert.match(section[1] ?? '', /^- 头行：unknown — /)
    for (const label of ['授权', '证据', '门禁', '新鲜度', '一致性']) {
        const line = section.find((entry) => entry.startsWith(`- ${label}：`))
        assert.ok(line !== undefined, `missing dimension line: ${label}`)
        assert.match(line ?? '', /^\- .+：unknown — .+$/, `${label} must be unknown WITH a reason`)
    }
    assert.ok(section.some((line) => line.startsWith('- 盲区：')), 'the blind-spot line must appear')
    assert.match(section.at(-1) ?? '', /^- 下一步：/)
    for (const claim of ['看起来健康', '一切正常', '全部一致']) {
        assert.equal(section.some((line) => line.includes(claim) && !line.includes('不是')), false, `must not claim ${claim}`)
    }
})

test('第 3 节：stale 授权 + full 证据都被列出，头行取最差', async () => {
    const cwd = repo()
    seedDelivery(cwd, 'm-mixed', { mandate: mandateOf('b'.repeat(64), Date.now() - 60_000) })
    const text = runText(await host(cwd).runTool('suite_status', {}))
    const section = sectionOf(text, 3)
    const authorization = section.find((line) => line.startsWith('- 授权：')) ?? ''
    assert.match(authorization, /^- 授权：stale — /, 'stale is the state token; the reason is the detail')
    assert.match(authorization, /策略版本已变/)
    const evidence = section.find((line) => line.startsWith('- 证据：')) ?? ''
    assert.match(evidence, /^- 证据：full — /)
    assert.match(evidence, /scope\.full=true/)
    assert.match(section.find((line) => line.startsWith('- 头行：')) ?? '', /^- 头行：partial — /)
    assert.ok(section.some((line) => line.startsWith('- 盲区：')))
    assert.match(section.at(-1) ?? '', /^- 下一步：/)
})

test('第 3 节：legacy 授权以事实呈现，不计入 divergent', async () => {
    const cwd = repo()
    seedDelivery(cwd, 'm-legacy')
    const section = sectionOf(runText(await host(cwd).runTool('suite_status', {})), 3)
    const authorization = section.find((line) => line.startsWith('- 授权：')) ?? ''
    assert.match(authorization, /^- 授权：legacy — /)
    assert.match(authorization, /事实，不是缺陷/)
    const headline = section.find((line) => line.startsWith('- 头行：')) ?? ''
    assert.doesNotMatch(headline, /divergent/, 'a legacy approval is never a divergence')
})

test('第 3 节：observations 里的影子 would: BLOCK 出现在门禁明细，但门禁仍是 pass', async () => {
    const cwd = repo()
    const store = new MissionStore({ layout: resolveLayout(cwd) })
    const at = Date.now() - 60_000
    store.create({ id: 'm-shadow', title: '影子任务', cwd })
    store.writeArtifact(
        'm-shadow',
        path.join('gates', 'GATE-01.json'),
        `${JSON.stringify({
            id: 'GATE-01',
            missionId: 'm-shadow',
            source: 'dsh-quality-gate',
            state: 'PASS',
            checkedAt: at,
            reason: '命令全部通过',
            results: [],
            observations: [{ rule: 'coverage', mode: 'observe', would: 'BLOCK', reason: '覆盖率 41% 低于 80%' }],
        })}\n`,
    )
    const section = sectionOf(runText(await host(cwd).runTool('suite_status', {})), 3)
    const gates = section.find((line) => line.startsWith('- 门禁：')) ?? ''
    assert.match(gates, /^- 门禁：pass — /, 'a shadow would:BLOCK must not count as a block')
    assert.match(gates, /coverage=would BLOCK/)
    assert.match(gates, /覆盖率 41% 低于 80%/)
    assert.match(gates, /不计入/)
})

test('第 3 节确定性：同一棵树两次运行逐字节相同（含维度顺序）', async () => {
    const cwd = repo()
    seedDelivery(cwd, 'm-repeat', { mandate: mandateOf('c'.repeat(64), Date.now() - 60_000) })
    const fake = host(cwd)
    const first = runText(await fake.runTool('suite_status', {}))
    const second = runText(await fake.runTool('suite_status', {}))
    assert.equal(first, second)
    const section = sectionOf(first, 3)
    const dimensionLines = section.filter((line) => /^- (授权|证据|门禁|新鲜度|一致性)：/.test(line))
    assert.deepEqual(
        dimensionLines.map((line) => line.slice(2, line.indexOf('：'))),
        ['授权', '证据', '门禁', '新鲜度', '一致性'],
        'the dimension order is part of the contract',
    )
})

test('第 3 节只读：读取一致性前后 .dsh 逐字节一致', async () => {
    const cwd = repo()
    seedDelivery(cwd, 'm-readonly', { mandate: mandateOf('d'.repeat(64), Date.now() - 60_000) })
    const fake = host(cwd)
    const before = snapshotDsh(cwd)
    assert.match(runText(await fake.runTool('suite_status', {})), /## 3 一致性/)
    assert.deepEqual(snapshotDsh(cwd), before)
})

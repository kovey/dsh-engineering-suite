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
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import type { DoctorReport } from 'dsh-eng-core'
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
function sectionOf(text: string, index: 1 | 2 | 3): string[] {
    const lines = text.split('\n')
    const start = lines.findIndex((line) => line.startsWith(`## ${index}. `))
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

test('三问按顺序出现：需要我 → 健康 → 历史（历史只给指路，不重复）', async () => {
    const cwd = repo()
    const fake = host(cwd)
    const text = runText(await fake.runTool('suite_status', {}))

    const positions = OPERATOR_QUESTIONS.map((question) => text.indexOf(question))
    for (const [index, position] of positions.entries()) assert.ok(position >= 0, `第 ${index + 1} 问没有出现`)
    assert.ok(positions[0]! < positions[1]!, '第一问必须排在健康之前')
    assert.ok(positions[1]! < positions[2]!, '历史必须排在最后')
    assert.ok(positions[0]! < text.indexOf('配置'), '先回答"要不要我"，再讲配置')

    // Question 3 is a POINTER: one line, no duplicated history.
    const history = sectionOf(text, 3)
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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name, resolveEffectiveConfig } from '../dist/index.js'
import { resolveConfig } from '../dist/config.js'
import { compareViolations, freezeBaseline, parseBaselineText } from '../dist/baseline.js'
import { suggestThresholds, loadStandards } from '../dist/tools.js'

const hosts: FakeHost[] = []

/** A scripted read-only reviewer child (same protocol spec_bootstrap uses). */
function fakeSubagents(answer: string | (() => Promise<never>)) {
    const calls: {
        provider: string
        request: {
            prompt: { text: string }[]
            toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
            maxDepth?: number
        }
    }[] = []
    const disposed: string[] = []
    let counter = 0
    const service = {
        start: async (
            provider: string,
            request: { prompt: { text: string }[]; toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }; maxDepth?: number },
        ) => {
            calls.push({ provider, request })
            const id = `review-${(counter += 1)}`
            return {
                id,
                result:
                    typeof answer === 'function'
                        ? answer()
                        : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: answer }] }),
                dispose: async () => {
                    disposed.push(id)
                },
            }
        },
    }
    return { service, calls, disposed }
}

/** Assemble the plugin in a throwaway workspace. */
function host(
    cwd: string,
    config: Record<string, unknown> = {},
    services: Record<string, unknown> = {},
): FakeHost & { approvals: string[] } {
    const fake = createFakeHost({ cwd, services: { ...services } })
    hosts.push(fake)
    const approvals: string[] = []
    const seam = {
        request: async (request: { reason: string }) => {
            approvals.push(request.reason)
            return (services['approvalDecision'] as string | undefined) ?? 'allowed-once'
        },
    }
    ;(fake.ctx as unknown as { get: (name: string) => unknown }).get = ((name: string) =>
        name === 'approval' ? seam : services[name]) as never
    apply(fake.ctx as never, { logFile: path.join(cwd, 'standards-gate.log'), ...config })
    return Object.assign(fake, { approvals })
}

/** A Go-ish repository with a long file, a long function and deep nesting. */
function longGoRepo(): string {
    const cwd = tempWorkspace('standards-gate-')
    fs.mkdirSync(path.join(cwd, 'internal', 'crawler'), { recursive: true })
    const filler = Array.from({ length: 60 }, (_, index) => `\t// 填充 ${index}`).join('\n')
    fs.writeFileSync(
        path.join(cwd, 'go.mod'),
        'module example.com/demo\n\ngo 1.26\n',
    )
    fs.writeFileSync(
        path.join(cwd, 'internal', 'crawler', 'big.go'),
        [
            'package crawler',
            '',
            'func Huge(a, b, c, d, e, f int) int {',
            filler,
            ...Array.from({ length: 90 }, (_, index) => `\tif a > ${index} {`),
            '\t\treturn a',
            ...Array.from({ length: 90 }, () => '\t}'),
            '\treturn 0',
            '}',
        ].join('\n'),
    )
    fs.writeFileSync(
        path.join(cwd, 'internal', 'crawler', 'small.go'),
        ['package crawler', '', 'func Small() int {', '\treturn 1', '}'].join('\n'),
    )
    const lines = Array.from({ length: 420 }, (_, index) => `// 行 ${index}`)
    fs.writeFileSync(path.join(cwd, 'internal', 'crawler', 'long.go'), ['package crawler', ...lines].join('\n'))
    return cwd
}

/** The standards file a repository would own. */
function writeStandards(cwd: string, body: unknown): void {
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), `${JSON.stringify(body, null, 2)}\n`)
}

function writeBaseline(cwd: string, accepted: string[], note = ''): void {
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'standards-baseline.json'),
        `${JSON.stringify({ version: 1, frozenAt: new Date(0).toISOString(), note, accepted }, null, 2)}\n`,
    )
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-standards-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('a missing standards file is an instruction, not a licence to guess (regression)', async () => {
    const cwd = longGoRepo()
    const fake = host(cwd)
    const refused = await fake.runTool('standards_check', {})
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /没有找到规范文件/)
    assert.match(String(refused.content), /standards_bootstrap/)
    // Nothing was invented, and no gate record exists.
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'standards.json')), false)
})

test('new violations block the gate; baseline-accepted ones do not (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, {
        languages: { go: { maxFileLines: 400, maxFunctionLines: 80, maxDepth: 4, maxParams: 5 } },
    })
    const fake = host(cwd)
    // First run: everything is new → BLOCK.
    const first = runText(await fake.runTool('standards_check', {}))
    assert.match(first, /— BLOCK/)
    assert.match(first, /新增违规/)
    assert.match(first, /maxFunctionLines|maxFileLines|maxParams|maxDepth/)
    const gates = new MissionStoreRegistry().for(cwd)
    // No mission in this fake: the check still reports, just without a gate id.
    assert.equal(gates.list().length, 0)

    // Freeze the baseline with approval, then the same violations are "known".
    const accepted = runText(await fake.runTool('standards_check', { accept: true, note: '存量债务' }))
    assert.match(accepted, /基线已写入/)
    assert.equal(fake.approvals.length, 1, 'widening the ratchet needs a person')
    const baseline = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'standards-baseline.json'), 'utf8'))
    const rules = baseline.accepted.map((key: string) => key.split('|')[0]).sort()
    assert.deepEqual(rules, ['maxDepth', 'maxFileLines', 'maxFunctionLines', 'maxParams'], `accepted keys: ${baseline.accepted.join(', ')}`)
    assert.equal(baseline.note, '存量债务')

    const second = runText(await fake.runTool('standards_check', {}))
    assert.match(second, /— PASS/)
    assert.match(second, /与基线一致/)
})

test('a rejected approval leaves the baseline untouched (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, { languages: { go: { maxFileLines: 400, maxFunctionLines: 80 } } })
    const fake = host(cwd, {}, { approvalDecision: 'rejected' })
    const out = runText(await fake.runTool('standards_check', { accept: true, note: '想蒙过去' }))
    assert.match(out, /未写入基线/)
    assert.match(out, /人工审批未通过/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'standards-baseline.json')), false)
})

test('a new violation introduced on top of a frozen baseline fails again (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, { languages: { go: { maxFileLines: 400, maxFunctionLines: 80 } } })
    const fake = host(cwd)
    await fake.runTool('standards_check', { accept: true, note: '冻结现状' })
    assert.match(runText(await fake.runTool('standards_check', {})), /— PASS/)

    // A 500-line file appears: that is the regression the ratchet must catch.
    fs.writeFileSync(
        path.join(cwd, 'internal', 'crawler', 'worse.go'),
        ['package crawler', ...Array.from({ length: 500 }, (_, index) => `// 新增 ${index}`)].join('\n'),
    )
    const after = runText(await fake.runTool('standards_check', {}))
    assert.match(after, /— BLOCK/)
    assert.match(after, /worse\.go/)
    assert.match(after, /改代码/)
})

test('standards_bootstrap recommends target thresholds and freezes them with approval (regression)', async () => {
    const cwd = longGoRepo()
    const fake = host(cwd)
    const measured = runText(await fake.runTool('standards_bootstrap', { action: 'measure' }))
    assert.match(measured, /现状分布/)
    assert.match(measured, /最大的文件/)
    assert.match(measured, /最长的函数/)
    assert.match(measured, /推荐阈值/)
    assert.match(measured, /推荐阈值/)
    assert.match(measured, /不要为了它们放宽阈值/)
    const suggestion = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(measured)?.[1] ?? '{}')
    assert.equal(suggestion.languages.go.maxFileLines, 400, 'the recommendation is the target, not a weakened p90')
    assert.ok(suggestion.exempt.includes('**/*_test.go'), 'test files are exempt by default')
    assert.ok(suggestion.exempt.includes('**/*.pb.go'), 'generated code is exempt by default')
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'standards.json')), false, 'measure writes nothing')

    const frozen = runText(await fake.runTool('standards_bootstrap', { action: 'freeze', note: '首次接入', thresholds: { maxFileLines: 300 } }))
    assert.match(frozen, /已写入/)
    const written = JSON.parse(fs.readFileSync(path.join(cwd, '.dsh', 'standards.json'), 'utf8'))
    assert.equal(written.languages.go.maxFileLines, 300, 'the caller override wins over the suggestion')
    assert.equal(written.note, '首次接入')
    assert.ok(Array.isArray(written.exempt))
    assert.equal(fake.approvals.length, 1)
})

test('standards_status reports thresholds, the baseline and the last gate (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, {
        languages: { go: { maxFileLines: 400, maxFunctionLines: 80 }, ts: { maxFileLines: 300 } },
        layers: [{ path: 'internal/domain', mayImport: [] }],
        forbidCycles: true,
        exempt: ['**/*_test.go'],
    })
    writeBaseline(cwd, ['maxFileLines|internal/crawler/long.go|(file)'], '上一轮接受')
    const fake = host(cwd)
    const out = runText(await fake.runTool('standards_status', {}))
    assert.match(out, /文件行数 ≤ 400/)
    assert.match(out, /文件行数 ≤ 300/)
    assert.match(out, /internal\/domain/)
    assert.match(out, /禁止循环依赖：已开启/)
    assert.match(out, /已接受 1 项违规/)
    assert.match(out, /上一轮接受/)
})

test('project config may only refine the allowed keys (regression)', () => {
    const cwd = tempWorkspace('standards-gate-project-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'standards-gate.json'),
        JSON.stringify({ enforce: 'warn', requireApprovalForBaseline: false, standardsFile: '.dsh/other.json' }),
    )
    const hostConfig = resolveConfig({ enforce: 'gate' })
    const layout = new MissionStoreRegistry().for(cwd).layout
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.enforce, 'warn')
    assert.equal(effective.config.standardsFile, '.dsh/other.json')
    // A workspace cannot switch OFF the human approval the host requires: the key
    // is not overridable, so the profile value stays.
    assert.equal(effective.config.requireApprovalForBaseline, true)
    assert.match(effective.problems.join('\n'), /不允许在项目级配置里覆盖/)
})

test('a malformed baseline is treated as absent, never as "everything accepted" (regression)', () => {
    const cwd = tempWorkspace('standards-gate-baseline-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards-baseline.json'), '{ not json')
    assert.equal(parseBaselineText('{ not json'), undefined)
    assert.equal(parseBaselineText('{"version":2,"frozenAt":"x","accepted":[]}'), undefined)
    const good = parseBaselineText(JSON.stringify({ version: 1, frozenAt: 'x', accepted: ['a', 'a', 'b'] }))
    assert.deepEqual(good?.accepted, ['a', 'b'])
    // compareToBaseline with no baseline: everything is new.
    const compared = compareViolations(
        [{ rule: 'maxFileLines', path: 'a.go', key: 'k1', actual: 10, limit: 1, detail: 'd' }],
        undefined,
    )
    assert.equal(compared.added.length, 1)
    assert.equal(compared.present, false)
})

test('freezeBaseline is deterministic and writeable without a mission (regression)', () => {
    const cwd = tempWorkspace('standards-gate-freeze-')
    const file = path.join(cwd, '.dsh', 'standards-baseline.json')
    const written = freezeBaseline({
        file,
        violations: [
            { rule: 'maxFileLines', path: 'a.go', key: 'k2', actual: 10, limit: 1, detail: 'd' },
            { rule: 'maxDepth', path: 'b.go', key: 'k1', actual: 9, limit: 4, detail: 'd' },
        ],
        note: 'n',
        now: 0,
    })
    assert.deepEqual(written.accepted, ['k1', 'k2'], 'keys are sorted and deduplicated')
    assert.equal(fs.existsSync(file), true)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).frozenAt, new Date(0).toISOString())
})

test('suggestThresholds takes the p90 and rounds to usable numbers (regression)', () => {
    const result = {
        cwd: '/w',
        files: [
            { path: 'a.go', language: 'go' as const, lines: 100, functions: [{ name: 'f', line: 1, lines: 40, depth: 2, params: 2 }], maxDepth: 3, ifBlocks: [{ line: 2, lines: 10, kind: 'if' as const }], exports: 4, imports: [] },
            { path: 'b.go', language: 'go' as const, lines: 380, functions: [{ name: 'g', line: 1, lines: 90, depth: 5, params: 6 }], maxDepth: 6, ifBlocks: [{ line: 2, lines: 30, kind: 'if' as const }], exports: 20, imports: [] },
        ],
        violations: [],
        cycles: [],
        stats: { filesScanned: 2, truncated: false, languages: { go: 2 }, exempted: 0 },
    }
    const { suggested } = suggestThresholds(result)
    assert.equal(suggested.go?.maxFileLines, 400, 'p90 of 100/380 rounded up to a 50 step')
    assert.equal(suggested.go?.maxFunctionLines, 90)
    assert.ok((suggested.go?.maxDepth ?? 0) >= 6)
})

test('loadStandards reports the exact problem instead of guessing (regression)', () => {
    const cwd = tempWorkspace('standards-gate-load-')
    const missing = loadStandards(cwd, '.dsh/standards.json')
    assert.equal(missing.standards, undefined)
    assert.match(missing.problem ?? '', /没有找到规范文件/)
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), '{"nope": 1}')
    const broken = loadStandards(cwd, '.dsh/standards.json')
    assert.equal(broken.standards, undefined)
    assert.match(broken.problem ?? '', /缺少 languages 段/)
    writeStandards(cwd, { languages: { go: { maxFileLines: 10 } } })
    const ok = loadStandards(cwd, '.dsh/standards.json')
    assert.equal(ok.standards?.languages.go?.maxFileLines, 10)
})

test('a structural review dispatches a READ-ONLY reviewer with the rubric (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, { languages: { go: { maxFileLines: 400, maxFunctionLines: 80 } } })
    const child = fakeSubagents('## internal/crawler/big.go\n\n结论：建议拆分\n\n`Huge` 把三层嵌套的判定和返回混在一起（big.go:3）。')
    const fake = host(cwd, {}, { subagents: child.service })
    const out = runText(await fake.runTool('standards_review', {}))

    // The child saw the rubric and the concrete offenders…
    assert.equal(child.calls.length, 1)
    const prompt = child.calls[0]?.request.prompt[0]?.text ?? ''
    assert.match(prompt, /职责是否单一/)
    assert.match(prompt, /允许结论是"没问题"/)
    assert.match(prompt, /internal\/crawler\/big\.go/)
    // …as a read-only reviewer that cannot re-enter the pipeline.
    const filter = child.calls[0]?.request.toolFilter
    assert.deepEqual(filter?.allow, ['read', 'glob', 'grep'])
    assert.ok(filter?.deny?.includes('orchestrate'), 'a reviewer must not advance the pipeline')
    assert.equal(child.calls[0]?.request.maxDepth, 1)
    assert.equal(child.disposed.length, 1, 'the child is always disposed')

    // The outcome is an OPINION, and it is stored for a human to read later.
    assert.match(out, /结构评审/)
    assert.match(out, /建议拆分/)
    assert.match(out, /这是\*\*意见\*\*，不是门禁裁决/)
    const files = fs.readdirSync(path.join(cwd, '.dsh', 'standards-reviews'))
    assert.equal(files.length, 1, `expected one report, got ${files.join(', ')}`)
    assert.match(fs.readFileSync(path.join(cwd, '.dsh', 'standards-reviews', files[0]!), 'utf8'), /不是门禁裁决/)
})

test('a structural review without a subagent service explains itself (regression)', async () => {
    const cwd = longGoRepo()
    writeStandards(cwd, { languages: { go: { maxFileLines: 400 } } })
    const fake = host(cwd, {}, { subagents: undefined })
    const out = runText(await fake.runTool('standards_review', {}))
    assert.match(out, /未产出评审/)
    assert.match(out, /没有装配子代理服务/)
})

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

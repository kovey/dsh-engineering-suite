/**
 * dsh-quality-gate contracts: every declared expectation judged on its own,
 * refusals for anything that cannot be evaluated, and the recorded gate row.
 *
 * The contracts here are smoke contracts over a scripted `ctx.subprocess`, so
 * the assertions are about the JUDGEMENT, not about some real interface.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import {
    contractResult,
    evaluateContract,
    jsonEquals,
    jsonTypeOf,
    parseContract,
    parseJsonPath,
    preflightContracts,
    resolveJsonPath,
    runContracts,
    type ContractConfig,
} from '../dist/contract.js'

/** One scripted `ctx.subprocess` reply. */
interface Step {
    exitCode?: number | null
    stdout?: string
    stderr?: string
    signal?: string | null
    durationMs?: number
    timedOut?: boolean
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
                    done: Promise.resolve({ exitCode: step.exitCode ?? 0, signal: step.signal ?? null }),
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

/** A stubbed command runner (records the specs it received). */
function stubRunner(script: readonly Step[]): {
    runner: (spec: Record<string, unknown>) => Promise<Record<string, unknown>>
    specs: Record<string, unknown>[]
} {
    const specs: Record<string, unknown>[] = []
    let index = 0
    return {
        specs,
        runner: async (spec) => {
            specs.push(spec)
            const step = script[Math.min(index, script.length - 1)] ?? {}
            index += 1
            return {
                argv: spec['argv'],
                command: (spec['argv'] as string[]).join(' '),
                cwd: spec['cwd'],
                exitCode: step.exitCode ?? 0,
                signal: step.signal ?? null,
                stdout: step.stdout ?? '',
                stderr: step.stderr ?? '',
                durationMs: step.durationMs ?? 1,
                timedOut: step.timedOut ?? false,
            }
        },
    }
}

const hosts: FakeHost[] = []
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-gate-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in `cwd` with a scripted subprocess. */
function host(
    cwd: string,
    config: Record<string, unknown>,
    script: readonly Step[],
): FakeHost & { spawns: { argv: readonly string[]; cwd: string }[] } {
    const scripted = scriptedService(script)
    const fake = createFakeHost({ cwd, services: { subprocess: scripted.service } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return Object.assign(fake, { spawns: scripted.spawns })
}

/** Every file under `dir`, relative path → content. */
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

/** A mission bound to the fake host's session; returns the mission id. */
function bindMission(cwd: string, title = '契约测试'): string {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title, cwd, sessionId: 'session-1' })
    store.bindSession('session-1', mission.id)
    return mission.id
}

/** The plugin config used by most tests (one fully-declared http smoke). */
function contractConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logFile: 'quality-gate.log',
        commands: [{ id: 'test', name: '单元测试', command: 'node -e "0"', required: true, phase: 'gate' }],
        contracts: [
            {
                id: 'api-smoke',
                name: '接口冒烟',
                kind: 'http',
                command: 'node smoke.mjs',
                expect: {
                    exitCode: 0,
                    stdoutContains: ['ok'],
                    stdoutNotContains: ['stack trace'],
                    jsonPaths: [
                        { path: 'data.items[0].id', type: 'number' },
                        { path: 'data.total', equals: 1 },
                    ],
                },
            },
        ],
        ...extra,
    }
}

const SMOKE_STDOUT = JSON.stringify({ ok: true, data: { items: [{ id: 7 }], total: 1 } })

// --- path algebra ---------------------------------------------------------

test('contracts: json paths are exact, and a shape that cannot be addressed is refused', () => {
    assert.deepEqual(parseJsonPath('data.items[0].id'), { segments: ['data', 'items', 0, 'id'] })
    assert.deepEqual(parseJsonPath('[0].name'), { segments: [0, 'name'] })
    assert.deepEqual(parseJsonPath('a[0][1]'), { segments: ['a', 0, 1] })
    assert.equal('problem' in parseJsonPath('a..b'), true)
    assert.equal('problem' in parseJsonPath('a['), true)
    assert.equal('problem' in parseJsonPath('a[x]'), true)
    assert.equal('problem' in parseJsonPath(''), true)

    const document = { data: { items: [{ id: 7 }] }, nothing: null }
    assert.deepEqual(resolveJsonPath(document, ['data', 'items', 0, 'id']), { found: true, value: 7 })
    assert.deepEqual(resolveJsonPath(document, ['data', 'items', 3, 'id']), { found: false, at: 'data.items[3]（数组只有 1 个元素）' })
    assert.deepEqual(resolveJsonPath(document, ['data', 'missing']), { found: false, at: 'data.missing' })
    assert.deepEqual(resolveJsonPath(document, ['nothing', 'x']), { found: false, at: 'nothing.x（父级不是对象，是 null）' })
    assert.equal(jsonTypeOf([]), 'array')
    assert.equal(jsonTypeOf(null), 'null')
    assert.equal(jsonEquals({ a: 1, b: [2] }, { b: [2], a: 1 }), true)
    assert.equal(jsonEquals({ a: 1 }, { a: '1' }), false)
})

// --- config refusals ------------------------------------------------------

test('contracts: unknown kind, empty command, unknown expectation keys and an empty expect are refusals', () => {
    const badKind = parseContract({ id: 'c', kind: 'grpc', command: 'x', expect: { exitCode: 0 } }, 0)
    assert.match(badKind.problems.join('\n'), /kind 必须是 cli \/ http \/ schema \/ command/)
    assert.equal(preflightContracts([badKind.contract]).length, 1, 'the entry is kept so the run refuses')

    assert.match(
        parseContract({ id: 'c', kind: 'cli', command: '   ', expect: { exitCode: 0 } }, 1).problems.join('\n'),
        /command 不能为空/,
    )
    assert.match(
        parseContract({ id: 'c', kind: 'cli', command: 'x', expect: { stdoutNotContain: ['oops'] } }, 2).problems.join('\n'),
        /不认识的键 "stdoutNotContain"/,
    )
    assert.match(parseContract({ id: 'c', kind: 'cli', command: 'x' }, 3).problems.join('\n'), /没有声明 expect/)
    assert.match(
        parseContract({ id: 'c', kind: 'cli', command: 'x', expect: { stdoutContains: [] } }, 4).problems.join('\n'),
        /没有声明任何可判定的期望/,
    )
    assert.match(
        parseContract({ id: 'c', kind: 'cli', command: 'x', expect: { jsonPaths: [{ path: 'a.b', type: 'integer' }], exitCode: 0 } }, 5).problems.join('\n'),
        /type 必须是 string \/ number \/ boolean \/ object \/ array \/ null/,
    )
    // Existence-only expectations are legal: `{ path }` with no equals/type.
    assert.deepEqual(
        parseContract({ id: 'c', kind: 'cli', command: 'x', expect: { jsonPaths: [{ path: 'a.b' }], exitCode: 0 } }, 7).problems,
        [],
    )
    assert.match(
        parseContract({ id: 'c', kind: 'cli', command: 'x', expect: { jsonPaths: [{ path: 'a[z]' }] } }, 6).problems.join('\n'),
        /path 无法解析/,
    )
})

test('contracts: an empty contract list is a refusal, not an empty pass', async () => {
    const run = await runContracts({ cwd: '/tmp', config: resolveConfig({ contracts: [] }) })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /没有配置任何契约/)
})

// --- individual expectations ---------------------------------------------

test('contracts: each expectation is judged and reported on its own row', () => {
    const contract: ContractConfig = {
        id: 'api',
        name: 'api',
        kind: 'http',
        command: 'node smoke.mjs',
        expect: {
            exitCode: 0,
            stdoutContains: ['ok'],
            stdoutNotContains: ['stack trace'],
            jsonPaths: [
                { path: 'data.items[0].id', type: 'number' },
                { path: 'data.total', equals: 1 },
                { path: 'data.missing' },
            ],
        },
    }
    const outcome = {
        argv: ['node', 'smoke.mjs'],
        command: 'node smoke.mjs',
        cwd: '/tmp',
        exitCode: 0,
        signal: null,
        stdout: SMOKE_STDOUT,
        stderr: '',
        durationMs: 5,
        timedOut: false,
    }
    const evaluation = evaluateContract(contract, outcome)
    assert.equal(evaluation.state, 'BLOCK')
    assert.deepEqual(
        evaluation.checks.map((check) => [check.name, check.state]),
        [
            ['命令可执行', 'PASS'],
            ['退出码 = 0', 'PASS'],
            ['stdout 含 "ok"', 'PASS'],
            ['stdout 不含 "stack trace"', 'PASS'],
            ['JSON 路径 data.items[0].id 的类型是 number', 'PASS'],
            ['JSON 路径 data.total = 1', 'PASS'],
            ['JSON 路径 data.missing', 'FAIL'],
        ],
    )
    assert.match(evaluation.checks[6]?.detail ?? '', /路径不存在（在 data\.missing 处断开）/)
    assert.deepEqual(evaluation.unasserted, [])

    // A failing exit code and a wrong type are separate rows too.
    const broken = evaluateContract(contract, { ...outcome, exitCode: 2, stdout: JSON.stringify({ data: { items: [{ id: '7' }], total: 2 } }) })
    assert.deepEqual(
        broken.checks.map((check) => [check.name, check.state]),
        [
            ['命令可执行', 'PASS'],
            ['退出码 = 0', 'FAIL'],
            ['stdout 含 "ok"', 'FAIL'],
            ['stdout 不含 "stack trace"', 'PASS'],
            ['JSON 路径 data.items[0].id 的类型是 number', 'FAIL'],
            ['JSON 路径 data.total = 1', 'FAIL'],
            ['JSON 路径 data.missing', 'FAIL'],
        ],
    )
    assert.match(broken.checks[4]?.detail ?? '', /实际类型 string/)
    assert.equal(broken.exitCode, 2)
})

test('contracts: stdout that is not JSON fails every path, naming each one', () => {
    const contract: ContractConfig = {
        id: 'api',
        name: 'api',
        kind: 'schema',
        command: 'node dump.mjs',
        expect: { jsonPaths: [{ path: 'a' }, { path: 'b.c' }] },
    }
    const evaluation = evaluateContract(contract, {
        argv: ['node', 'dump.mjs'],
        command: 'node dump.mjs',
        cwd: '/tmp',
        exitCode: 0,
        signal: null,
        stdout: 'not json at all',
        stderr: '',
        durationMs: 1,
        timedOut: false,
    })
    assert.equal(evaluation.state, 'BLOCK')
    assert.deepEqual(
        evaluation.checks.map((check) => check.name),
        ['命令可执行', 'stdout 是合法 JSON', 'JSON 路径 a', 'JSON 路径 b.c'],
    )
    assert.equal(evaluation.checks[1]?.state, 'FAIL')
    assert.match(evaluation.checks[2]?.detail ?? '', /按失败处理，不是跳过/)
})

test('contracts: an undeclared exit code is reported as unasserted instead of silently passing', () => {
    const contract: ContractConfig = { id: 'c', name: 'c', kind: 'cli', command: 'node cli.mjs', expect: { stdoutContains: ['usage'] } }
    const evaluation = evaluateContract(contract, {
        argv: ['node', 'cli.mjs'],
        command: 'node cli.mjs',
        cwd: '/tmp',
        exitCode: 2,
        signal: null,
        stdout: 'usage: ...',
        stderr: '',
        durationMs: 1,
        timedOut: false,
    })
    assert.equal(evaluation.state, 'PASS')
    assert.deepEqual(evaluation.unasserted, ['exitCode：未声明 → 本次不判定退出码（实际 exit=2）'])
})

// --- the engine -----------------------------------------------------------

test('contracts: the engine runs every contract and refuses before running anything unusable', async () => {
    const cwd = tempWorkspace('contract-run-')
    const config = resolveConfig(contractConfig())
    const runner = stubRunner([{ exitCode: 0, stdout: SMOKE_STDOUT, durationMs: 9 }])
    const run = await runContracts({ cwd, config, runner: runner.runner })
    assert.equal(run.ok, true)
    assert.equal(run.ok === true ? run.state : '', 'PASS')
    assert.deepEqual(run.ok === true ? run.scope : {}, { selected: ['api-smoke'], total: 1, full: false })
    assert.deepEqual(runner.specs.map((spec) => spec['argv']), [['node', 'smoke.mjs']])
    const blocked = await runContracts({ cwd, config: resolveConfig(contractConfig()), runner: stubRunner([{ exitCode: 0, stdout: '{"ok":false}' }]).runner })
    assert.equal(blocked.ok === true ? blocked.state : '', 'BLOCK')
    assert.match(blocked.ok === true ? blocked.reason : '', /契约裁决：api-smoke 有期望未满足/)

    // An unusable contract refuses the whole call and runs nothing.
    const broken = resolveConfig(contractConfig({ contracts: [{ id: 'bad', kind: 'grpc', command: 'x', expect: { exitCode: 0 } }] }))
    const never = stubRunner([{ exitCode: 0 }])
    const refused = await runContracts({ cwd, config: broken, runner: never.runner })
    assert.equal(refused.ok, false)
    assert.match(refused.ok === false ? refused.problem : '', /契约配置有 1 处无法执行/)
    assert.deepEqual(never.specs, [])
})

test('contracts: a cancelled run is a refusal, not a verdict', async () => {
    const cwd = tempWorkspace('contract-abort-')
    const runner = {
        runner: async (spec: Record<string, unknown>) => ({
            argv: spec['argv'],
            command: 'node smoke.mjs',
            cwd: spec['cwd'],
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 0,
            timedOut: false,
            aborted: true,
        }),
        specs: [],
    }
    const run = await runContracts({ cwd, config: resolveConfig(contractConfig()), runner: runner.runner })
    assert.equal(run.ok, false)
    assert.match(run.ok === false ? run.problem : '', /已取消（signal 已 abort）：取消不是裁决/)
})

test('contracts: the gate row carries the contract id and its own exit code', () => {
    const evaluation = evaluateContract(
        { id: 'api', name: '接口', kind: 'cli', command: 'node smoke.mjs', expect: { exitCode: 0 } },
        { argv: [], command: 'node smoke.mjs', cwd: '/tmp', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 3, timedOut: false },
    )
    const result = contractResult(evaluation)
    assert.equal(result.id, 'api')
    assert.equal(result.name, '契约：接口')
    assert.equal(result.required, true)
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /\[PASS\] 命令可执行/)
})

// --- tool surface ---------------------------------------------------------

test('contract_check: reports each expectation, records a non-authorising gate row, and survives a missing path', async () => {
    const cwd = tempWorkspace('contract-tool-')
    const fake = host(cwd, contractConfig(), [{ exitCode: 0, stdout: SMOKE_STDOUT, durationMs: 11 }])
    const missionId = bindMission(cwd)
    const run = await fake.runTool('contract_check', {})
    const text = runText(run)
    assert.equal(run.isError, false)
    assert.match(text, /契约门禁：PASS/)
    assert.match(text, /scope\.full` 恒为 false/)
    assert.match(text, /每个新期望单独判定|JSON 路径 data\.items\[0\]\.id 的类型是 number/)
    assert.match(text, /声明的接口仍然按声明的方式行为/)

    const store = new MissionStoreRegistry().for(cwd)
    const gate = store.lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.deepEqual(gate?.scope, { selected: ['api-smoke'], total: 1, full: false })
    assert.equal(gate?.results[0]?.id, 'api-smoke')
    assert.match(gate?.reason ?? '', /契约裁决/)
})

test('contract_check: a missing JSON path makes the whole verdict BLOCK', async () => {
    const cwd = tempWorkspace('contract-missing-')
    const fake = host(cwd, contractConfig(), [{ exitCode: 0, stdout: JSON.stringify({ ok: true, data: { items: [], total: 1 } }) }])
    const missionId = bindMission(cwd, '路径缺失')
    const run = await fake.runTool('contract_check', {})
    assert.equal(run.isError, false)
    assert.match(runText(run), /JSON 路径 data\.items\[0\]\.id：[^\n]*路径不存在/)
    const gate = new MissionStoreRegistry().for(cwd).lastGate(missionId, { source: 'dsh-quality-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.results[0]?.exitCode, 1)
})

test('contract_check: refuses without a workspace, an unknown mission or an unusable contract, writing nothing', async () => {
    const cwd = tempWorkspace('contract-refusal-')
    const fake = host(cwd, contractConfig(), [{ exitCode: 0, stdout: SMOKE_STDOUT }])
    const before = snapshot(path.join(cwd, '.dsh'))

    const noWorkspace = await fake.runTool('contract_check', {}, { agent: { id: 'a', session: { id: 's', header: {} } } })
    assert.equal(noWorkspace.isError, true)
    assert.match(runText(noWorkspace), /无法确定本会话的工作区/)

    const unknownMission = await fake.runTool('contract_check', { missionId: 'nope' })
    assert.equal(unknownMission.isError, true)
    assert.match(runText(unknownMission), /未知 mission "nope"/)

    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before)
    assert.deepEqual(fake.spawns, [], 'a refusal must not run a command')

    // A contract the gate cannot evaluate refuses with the fix, and runs nothing.
    const brokenCwd = tempWorkspace('contract-refusal-config-')
    const broken = host(brokenCwd, contractConfig({ contracts: [{ id: 'bad', kind: 'grpc', command: 'x', expect: { exitCode: 0 } }] }), [{ exitCode: 0 }])
    bindMission(brokenCwd, '非法契约')
    const brokenBefore = snapshot(path.join(brokenCwd, '.dsh'))
    const refused = await broken.runTool('contract_check', {})
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /kind 必须是 cli \/ http \/ schema \/ command/)
    assert.deepEqual(broken.spawns, [])
    assert.deepEqual(snapshot(path.join(brokenCwd, '.dsh')), brokenBefore, 'a refused contract must not write a gate row')
})

// --- project overlay ------------------------------------------------------

test('contracts: a project file replaces the contract list and cannot switch the gate off', () => {
    const cwd = tempWorkspace('contract-overlay-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'quality-gate.json'),
        JSON.stringify({
            contracts: [{ id: 'local', kind: 'cli', command: 'node local-cli.mjs --help', expect: { stdoutContains: ['usage'] } }],
            enabled: false,
        }),
    )
    const hostConfig = resolveConfig(contractConfig())
    const store = new MissionStoreRegistry().for(cwd)
    const effective = resolveEffectiveConfig(hostConfig, store.layout)
    assert.equal(effective.source, 'project')
    assert.deepEqual(effective.config.contracts.map((contract) => contract.id), ['local'])
    assert.equal(effective.config.enabled, true)
    assert.match(effective.problems.join('\n'), /键 "enabled" 不允许在项目级配置里覆盖/)

    // A malformed project-level contracts value keeps the profile's list.
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), JSON.stringify({ contracts: 'nope' }))
    const store2 = new MissionStoreRegistry().for(tempWorkspace('contract-overlay-2-'))
    void store2
    const effective2 = resolveEffectiveConfig(hostConfig, new MissionStoreRegistry().for(cwd).layout)
    assert.deepEqual(effective2.config.contracts.map((contract) => contract.id), ['api-smoke'])
    assert.match(effective2.problems.join('\n'), /contracts 必须是数组/)
})

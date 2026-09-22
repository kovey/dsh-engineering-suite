/**
 * Acceptance tests for dsh-impact-gate.
 *
 * These run against the built `dist/` (see docs/PLUGIN-CONVENTIONS.md §8), build
 * a real git repository with `execFileSync('git', …)` so the diff is real, and
 * drive the tools through `dsh-eng-core/testing`'s fake host.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, clearProjectConfigCache } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { PROJECT_OVERRIDABLE_KEYS, resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import { BLIND_SPOTS, groupByDistance, parsePaths, riskLabel } from '../dist/tools.js'
import { IMPACT_REVIEW_RUBRIC } from '../dist/review.js'

/** Every assembled host, disposed in `after()`. */
const hosts: FakeHost[] = []

/** Log files live outside the workspaces so they never look like a change. */
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-gate-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in a throwaway workspace. */
function host(cwd: string, config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services: { ...services } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return fake
}

/** A scripted read-only reviewer child. */
function fakeSubagents(answer: string): {
    service: { start: (provider: string, request: unknown) => Promise<unknown> }
    calls: { provider: string; request: Record<string, unknown> }[]
    disposed: string[]
} {
    const calls: { provider: string; request: Record<string, unknown> }[] = []
    const disposed: string[] = []
    let counter = 0
    return {
        calls,
        disposed,
        service: {
            start: async (provider: string, request: unknown) => {
                calls.push({ provider, request: request as Record<string, unknown> })
                const id = `review-${(counter += 1)}`
                return {
                    id,
                    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: answer }] }),
                    dispose: async () => {
                        disposed.push(id)
                    },
                }
            },
        },
    }
}

/**
 * A TypeScript repository whose import graph is the point:
 *
 *   cmd/main.ts ─┐
 *   src/api/handler.spec.ts ─ src/api/handler.ts ─ src/store/store.ts ─ src/store/store.test.ts
 *
 * plus two tests that only the fallback evidence reaches (`pkgonly.test.ts` by
 * directory, `src/other/store.test.ts` by name) and one that nothing reaches.
 */
function fixture(): string {
    const cwd = tempWorkspace('impact-gate-')
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    const write = (file: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
        fs.writeFileSync(path.join(cwd, file), text)
    }
    write('package.json', '{ "name": "impact-fixture" }\n')
    // The engineering trail and logs are artifacts, not source: a real repository
    // ignores them, and the fixture must too (otherwise every mission file would
    // show up as an untracked "change").
    write('.gitignore', '.dsh/\n*.log\n')
    write('src/store/store.ts', 'export function save(): number {\n    return 1\n}\n')
    write('src/store/store.test.ts', "import { save } from './store.js'\n\ntest('save', () => {\n    save()\n})\n")
    write('src/store/pkgonly.test.ts', "test('pkg', () => {})\n")
    write('src/other/store.test.ts', "test('named', () => {})\n")
    write('src/other/unrelated.test.ts', "test('unrelated', () => {})\n")
    write('src/api/handler.ts', "import { save } from '../store/store.js'\n\nexport function handle(): number {\n    return save()\n}\n")
    write('src/api/handler.spec.ts', "import { handle } from './handler.js'\n\ntest('handle', () => {\n    handle()\n})\n")
    write('cmd/main.ts', "import { handle } from '../src/api/handler.js'\n\nconsole.log(handle())\n")
    git('add', '.')
    git('commit', '-qm', 'init')
    return cwd
}

/** Touch `src/store/store.ts`: one inserted line, one modified line. */
function touchStore(cwd: string): void {
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n    // touched\n    return 2\n}\n')
}

/** A mission bound to the fake host's session. */
function bindMission(cwd: string, id = 'm1'): MissionStoreRegistry {
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ id, title: '影响分析测试', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', id)
    return stores
}

// --- surface ---------------------------------------------------------------

test('the plugin declares its name and the services it injects', () => {
    assert.equal(name, 'dsh-impact-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('the three tools register, the prompt section renders, and dispose releases both', () => {
    const cwd = fixture()
    const fake = host(cwd)
    assert.deepEqual([...fake.tools.keys()].sort(), ['impact_analyze', 'impact_status', 'impact_tests'])
    const declared = fake.tools.get('impact_analyze')?.parameters as { properties?: Record<string, unknown> } | undefined
    assert.deepEqual(Object.keys(declared?.properties ?? {}).sort(), ['base', 'missionId', 'paths'])
    // `paths` is declared `json` on purpose: a wrong shape reaches the tool and
    // gets a real Chinese answer instead of a schema rejection (see below). The
    // compiled JSON Schema proves it — the property carries no type constraint.
    const pathsSchema = declared?.properties?.['paths'] as { type?: string } | undefined
    assert.equal(pathsSchema?.type, undefined)
    assert.equal(typeof pathsSchema?.['description' as never], 'string')
    const section = fake.sectionText('eng:impact-gate')
    assert.match(section, /impact_tests/)
    assert.match(section, /impact_analyze/)
    assert.match(section, /文件级导入可达性/)
    // The empty template is a visible state in the prompt, not a silent default.
    assert.match(section, /尚未配置 `testCommandTemplate`/)
    fake.dispose()
    assert.deepEqual([...fake.tools.keys()], [])
    assert.equal(fake.sectionText('eng:impact-gate'), '')
})

test('paths without a diff is accepted as a single string and as an array (tolerance)', async () => {
    const cwd = fixture()
    const fake = host(cwd)
    const single = runText(await fake.runTool('impact_analyze', { paths: 'src/store/store.ts' }))
    assert.doesNotMatch(single, /<error>|必须/)
    assert.match(single, /显式 paths 模式/)
    const array = runText(await fake.runTool('impact_analyze', { paths: ['src/store/store.ts'] }))
    assert.match(array, /`src\/store\/store\.ts`：修改，无新增行/)
    assert.match(array, /变更基线：\(explicit paths\)/)
    assert.deepEqual(parsePaths(undefined), {})
    assert.deepEqual(parsePaths(' a.ts '), { paths: ['a.ts'] })
    assert.match(parsePaths([]).problem ?? '', /空数组/)
    assert.match(parsePaths(42).problem ?? '', /必须是字符串数组/)
    assert.match(parsePaths(['']).problem ?? '', /非空字符串/)

    // A typo produces the same empty answer as a planned new file, so the report
    // says which paths do not exist instead of letting the reader guess.
    const typo = runText(await fake.runTool('impact_analyze', { paths: ['src/store/store.ts', 'src/store/stroe.ts'] }))
    assert.match(typo, /### 显式 paths 里当前不存在的文件（1 个）/)
    assert.match(typo, /`src\/store\/stroe\.ts`/)
    assert.match(typo, /若是计划新增的文件，这属正常/)
})

// --- the real analysis -----------------------------------------------------

test('impact_analyze reports the changed file, the transitive dependent and the selected tests', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd)
    const run = await fake.runTool('impact_analyze', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)

    // The facts a reviewer reads, in the report itself.
    assert.match(text, /变更基线：HEAD/)
    assert.match(text, /扫描：10 个文件、4 条导入边/)
    assert.match(text, /风险：低（low）/)
    assert.match(text, /影响面 4 个文件、4 个测试文件，均在阈值内/)
    assert.match(text, /### 改动文件（1 个）/)
    assert.match(text, /`src\/store\/store\.ts`：修改，新增 L2-L3，删除 1 行/)
    assert.match(text, /### 影响面（4 个文件，按导入距离分组）/)
    assert.match(text, /- 距离 1（2 个）：`src\/api\/handler\.ts`、`src\/store\/store\.test\.ts`/)
    assert.match(text, /- 距离 2（2 个）：`cmd\/main\.ts`（经由 `src\/api\/handler\.ts`）、`src\/api\/handler\.spec\.ts`（经由 `src\/api\/handler\.ts`）/)
    assert.match(text, /### 选中的测试（4 个）/)
    assert.match(text, /`src\/store\/store\.test\.ts`：导入改动文件（距离 1）/)
    assert.match(text, /`src\/api\/handler\.spec\.ts`：导入改动文件（距离 2）/)
    assert.match(text, /`src\/store\/pkgonly\.test\.ts`：与改动文件同目录/)
    assert.match(text, /`src\/other\/store\.test\.ts`：与改动文件同名/)
    // `src/other/unrelated.test.ts` is reached by none of the three kinds of evidence.
    assert.doesNotMatch(text, /unrelated/)
    // No mission: the report says the record is missing instead of pretending.
    assert.match(text, /没有 mission：本次分析\*\*没有落盘、也没有记证据\*\*/)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false)
    // Every report ends with the next tool call.
    assert.match(text.trimEnd().split('\n').at(-1) ?? '', /^下一步：/)
})

test('the report names the analysis blind spots (import-level reachability, not a call graph)', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /文件级导入可达性\*\*，不是调用图/)
    for (const spot of BLIND_SPOTS) assert.ok(text.includes(spot), `报告里缺少边界说明：${spot}`)
    for (const keyword of ['接口', '依赖注入', '反射', '字符串查表']) {
        assert.ok(text.includes(keyword), `报告里缺少边界关键词：${keyword}`)
    }
    assert.match(text, /不是"其余可以跳过"的证明/)
})

test('impact_analyze records a JSON artifact plus an artifact evidence row on the mission', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const stores = bindMission(cwd)
    const fake = host(cwd)
    const run = await fake.runTool('impact_analyze', { missionId: 'm1' })
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)

    const dir = path.join(cwd, '.dsh', 'missions', 'm1', 'impact')
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0] ?? '', /^\d{8}-\d{6}\.json$/)
    const artifact = JSON.parse(fs.readFileSync(path.join(dir, files[0] as string), 'utf8')) as Record<string, unknown>
    assert.equal(artifact['plugin'], 'dsh-impact-gate')
    assert.equal(artifact['version'], 1)
    assert.equal(artifact['risk'], 'low')
    assert.equal(artifact['base'], 'HEAD')
    assert.equal(artifact['diffRead'], true)
    assert.deepEqual(artifact['counts'], { changed: 1, impacted: 4, tests: 4, unreached: 0 })
    assert.deepEqual(artifact['stats'], { filesScanned: 10, graphEdges: 4, truncated: false })
    assert.deepEqual((artifact['changed'] as { path: string; added: number[][]; removed: number; status: string }[])[0], {
        path: 'src/store/store.ts',
        added: [[2, 3]],
        removed: 1,
        status: 'modified',
    })
    assert.deepEqual(
        (artifact['tests'] as { path: string; reason: string }[]).map((entry) => [entry.path, entry.reason]),
        [
            ['src/store/store.test.ts', 'imports-changed'],
            ['src/api/handler.spec.ts', 'imports-changed'],
            ['src/store/pkgonly.test.ts', 'same-package'],
            ['src/other/store.test.ts', 'name-match'],
        ],
    )
    assert.deepEqual(artifact['blindSpots'], BLIND_SPOTS)
    const config = artifact['config'] as Record<string, unknown>
    assert.equal(config['testCommandTemplate'], null, '未配置的模板必须在产物里是 null，不能假装有默认值')
    assert.equal(config['maxDistance'], 6)

    // The evidence ledger row is what dsh-evidence-gate reads.
    const evidence = stores.for(cwd).readEvidence('m1')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]?.kind, 'artifact')
    assert.equal(evidence[0]?.recordedBy, 'dsh-impact-gate')
    assert.equal(evidence[0]?.artifactPath, `impact/${files[0]}`)
    assert.match(evidence[0]?.summary ?? '', /风险 low；改动 1、影响面 4、选中测试 4/)
    assert.match(text, new RegExp(`证据台账：${evidence[0]?.id}`))
    assert.match(text, /分析产物：.*impact/)

    // A second run adds a second artifact (same second → same name is allowed:
    // the artifact is a record of a run, and the ledger keeps both rows).
    const again = await fake.runTool('impact_analyze', { missionId: 'm1' })
    assert.equal(again.isError, false, runText(again))
    assert.ok(stores.for(cwd).readEvidence('m1').length >= 1)
})

test('a non-git workspace is reported honestly instead of throwing', async () => {
    const cwd = tempWorkspace('impact-gate-nogit-')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'lonely.ts'), 'export const lonely = 1\n')
    const fake = host(cwd)
    const run = await fake.runTool('impact_analyze', {})
    assert.equal(run.isError, false, '非 git 工作区必须如实报告，而不是抛错')
    const text = runText(run)
    assert.match(text, /### 无法读取 diff（这次分析的前提不成立）/)
    assert.match(text, /无法读取 git diff/)
    assert.match(text, /风险：无法判定（改动集为空，见上）/)
    assert.match(text, /git 仓库/)
    assert.match(text, /显式 paths/)
    // It must NOT invent a risk verdict from the empty change set.
    assert.doesNotMatch(text, /风险：高（high）/)
})

test('a missing mission is refused fail-closed (both unknown and unsafe ids)', async () => {
    const cwd = fixture()
    const fake = host(cwd)
    const unknown = await fake.runTool('impact_analyze', { missionId: 'nope' })
    assert.equal(unknown.isError, true)
    assert.match(runText(unknown), /未知 mission "nope"/)
    assert.match(runText(unknown), /下一步：/)
    const unsafe = await fake.runTool('impact_analyze', { missionId: '../evil' })
    assert.equal(unsafe.isError, true)
    assert.match(runText(unsafe), /mission id 不合法/)
})

test('bad `paths` input gets a real answer instead of a schema rejection', async () => {
    const cwd = fixture()
    const fake = host(cwd)
    const empty = await fake.runTool('impact_analyze', { paths: [] })
    assert.equal(empty.isError, true)
    assert.match(runText(empty), /空数组/)
    assert.match(runText(empty), /下一步：/)
    const wrong = await fake.runTool('impact_analyze', { paths: 42 })
    assert.equal(wrong.isError, true)
    assert.match(runText(wrong), /必须是字符串数组/)
})

// --- the command -----------------------------------------------------------

test('impact_tests refuses without a template and names the next step', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd)
    const refused = await fake.runTool('impact_tests', {})
    assert.equal(refused.isError, true, '没有模板时必须拒绝而不是猜 runner')
    const message = runText(refused)
    assert.match(message, /没有配置测试命令模板/)
    assert.match(message, /不会猜 runner/)
    assert.match(message, /testCommandTemplate/)
    assert.match(message, /\.dsh\/impact-gate\.json/)
    assert.ok(message.trimEnd().endsWith('`impact_tests({ template: "go test {files}" })`。'), message.slice(-120))

    // The per-call template is the documented escape hatch.
    const run = await fake.runTool('impact_tests', { template: 'go test {files}' })
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /`go test src\/store\/store\.test\.ts src\/api\/handler\.spec\.ts src\/store\/pkgonly\.test\.ts src\/other\/store\.test\.ts`/)
    assert.match(text, /模板来源：调用参数 template（本次覆盖）/)
    assert.match(text, /### 选中的测试（4 个）/)
    assert.match(text, /宿主未配置 `fullTestCommand`：\*\*没有对照数据\*\*/)
    assert.match(text.trimEnd().split('\n').at(-1) ?? '', /^下一步：/)
})

test('impact_tests reports the count saved versus the whole suite when fullTestCommand is configured', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd, { testCommandTemplate: 'node --test {files}', fullTestCommand: 'node --test test/**/*.test.ts' })
    const run = await fake.runTool('impact_tests', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /模板来源：profile 的 testCommandTemplate/)
    assert.match(text, /`node --test src\/store\/store\.test\.ts src\/api\/handler\.spec\.ts src\/store\/pkgonly\.test\.ts src\/other\/store\.test\.ts`/)
    assert.match(text, /全量：5 个测试文件 → `node --test test\/\*\*\/\*\.test\.ts`/)
    assert.match(text, /本次选中：4 个 → 少跑 1 个测试文件（约 20%）/)
    assert.match(text, /必要\*\*不是\*\*充分/)
})

test('a template without the {files} placeholder gets the selection appended', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd, { testCommandTemplate: 'go test' })
    const text = runText(await fake.runTool('impact_tests', {}))
    assert.match(text, /`go test src\/store\/store\.test\.ts/)
})

// --- status ----------------------------------------------------------------

test('impact_status before any analysis states the config, the thresholds and the gap', async () => {
    const cwd = fixture()
    const stores = bindMission(cwd)
    const fake = host(cwd)
    const before = runText(await fake.runTool('impact_status', {}))
    assert.match(before, /### 生效配置/)
    assert.match(before, /配置来源：profile（项目文件 .*\.dsh\/impact-gate\.json 不存在）/)
    assert.match(before, /变更基线（defaultBase）：`HEAD`/)
    assert.match(before, /反向可达最大距离（maxDistance）：6/)
    assert.match(before, /maxFiles 4000 \/ maxFileBytes 262144/)
    assert.match(before, /测试命令模板（testCommandTemplate）：\*\*未配置\*\*/)
    assert.match(before, /### 在用阈值（RISK_RULES，来自 dsh-eng-core）/)
    assert.match(before, /high：单个改动文件被 ≥ 8 处依赖，或影响面 ≥ 25 个文件，或导出面 ≥ 15 个符号/)
    assert.match(before, /medium：影响面 ≥ 5 个文件，或导出面 ≥ 6 个符号/)
    assert.match(before, /还没有分析产物/)
    assert.match(before.trimEnd().split('\n').at(-1) ?? '', /^下一步：/)

    touchStore(cwd)
    const analyzed = await fake.runTool('impact_analyze', {})
    assert.equal(analyzed.isError, false, runText(analyzed))
    const after = runText(await fake.runTool('impact_status', {}))
    assert.match(after, /共 1 个产物，取最新/)
    assert.match(after, /产物：`impact\/\d{8}-\d{6}\.json`/)
    assert.match(after, /风险：低（low）；改动 1、影响面 4、选中测试 4、未触及 0/)
    assert.match(after, /生成时间：\d{4}-\d{2}-\d{2} /)
    assert.equal(stores.for(cwd).list().length, 1)
})

test('impact_status without a mission says so instead of guessing one', async () => {
    const cwd = fixture()
    const fake = host(cwd)
    const text = runText(await fake.runTool('impact_status', {}))
    assert.match(text, /没有 mission：无法定位分析产物/)
    assert.match(text, /下一步：`impact_analyze`/)
})

// --- configuration ---------------------------------------------------------

test('the project-level overlay applies a valid key and refuses an invalid one', () => {
    const cwd = fixture()
    const dir = path.join(cwd, '.dsh')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
        path.join(dir, 'impact-gate.json'),
        `${JSON.stringify(
            {
                testCommandTemplate: 'pnpm vitest run {files}',
                maxDistance: 3,
                enabled: false,
                reviewDispatch: { enabled: true },
                logFile: '/tmp/elsewhere.log',
                prompt: { enabled: false },
            },
            null,
            2,
        )}\n`,
    )
    clearProjectConfigCache()
    const host = resolveConfig({ logFile: '~/.dsh/impact-gate.log' })
    const stores = new MissionStoreRegistry()
    const effective = resolveEffectiveConfig(host, stores.for(cwd).layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.testCommandTemplate, 'pnpm vitest run {files}')
    assert.equal(effective.config.maxDistance, 3)
    // Forbidden keys are ignored LOUDLY: a project cannot switch the plugin off,
    // move the log, turn on subagent escalation, or silence the prompt.
    assert.equal(effective.config.enabled, true)
    assert.equal(effective.config.logFile, '~/.dsh/impact-gate.log')
    assert.equal(effective.config.reviewDispatch.enabled, false)
    assert.equal(effective.config.prompt.enabled, true)
    const refused = effective.problems.join('\n')
    for (const key of ['enabled', 'reviewDispatch', 'logFile', 'prompt']) assert.match(refused, new RegExp(`"${key}" 不允许`))
    assert.equal(effective.present, true)
    assert.deepEqual([...PROJECT_OVERRIDABLE_KEYS].sort(), ['defaultBase', 'fullTestCommand', 'maxDistance', 'maxFileBytes', 'maxFiles', 'testCommandTemplate'])

    // An unusable VALUE keeps the profile's value (never a plugin default).
    fs.writeFileSync(path.join(dir, 'impact-gate.json'), `${JSON.stringify({ maxDistance: 0, testCommandTemplate: 42, fullTestCommand: '' }, null, 2)}\n`)
    clearProjectConfigCache()
    const broken = resolveEffectiveConfig(resolveConfig({ maxDistance: 5, testCommandTemplate: 'go test {files}', fullTestCommand: 'go test ./...' }), stores.for(cwd).layout)
    assert.equal(broken.config.maxDistance, 5)
    assert.equal(broken.config.testCommandTemplate, 'go test {files}')
    assert.equal(broken.config.fullTestCommand, undefined)
    assert.equal(broken.source, 'project', '空串清掉 fullTestCommand 也是一次生效的项目级改动')
    assert.match(broken.problems.join('\n'), /maxDistance 必须是 ≥ 1 的数字/)
    assert.match(broken.problems.join('\n'), /testCommandTemplate 必须是字符串/)
})

test('the project-level template reaches impact_tests, and an empty one is a refusal', async () => {
    const cwd = fixture()
    touchStore(cwd)
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'impact-gate.json'), '{ "testCommandTemplate": "pytest {files}" }\n')
    clearProjectConfigCache()
    const fake = host(cwd)
    const text = runText(await fake.runTool('impact_tests', {}))
    assert.match(text, /模板来源：profile 的 testCommandTemplate/)
    assert.match(text, /`pytest src\/store\/store\.test\.ts/)

    fs.writeFileSync(path.join(cwd, '.dsh', 'impact-gate.json'), '{ "testCommandTemplate": "" }\n')
    clearProjectConfigCache()
    const refused = await fake.runTool('impact_tests', {})
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /没有配置测试命令模板/)
})

test('a disabled plugin registers nothing, and reviewDispatch is opt-in', () => {
    const cwd = fixture()
    const off = createFakeHost({ cwd })
    hosts.push(off)
    apply(off.ctx as never, { enabled: false, logFile: path.join(LOG_DIR, 'disabled.log') })
    assert.deepEqual([...off.tools.keys()], [])

    const on = createFakeHost({ cwd })
    hosts.push(on)
    apply(on.ctx as never, { logFile: path.join(LOG_DIR, 'enabled-default.log') })
    assert.deepEqual([...on.tools.keys()].sort(), ['impact_analyze', 'impact_status', 'impact_tests'])
    assert.equal(resolveConfig({}).reviewDispatch.enabled, false)
    assert.equal(resolveConfig({ reviewDispatch: { enabled: true, provider: 'spawn' } }).reviewDispatch.maxDepth, 1)
})

// --- the optional reviewer -------------------------------------------------

test('reviewDispatch adds a read-only opinion and never a verdict', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const reviewers = fakeSubagents('## 图外引用\n\n- `src/api/handler.ts:5` 通过配置键 "store.mode" 选择实现，import 图看不见。')
    const fake = host(
        cwd,
        { testCommandTemplate: 'go test {files}', reviewDispatch: { enabled: true, targets: 3, timeoutMs: 30_000 } },
        { subagents: reviewers.service },
    )
    const run = await fake.runTool('impact_analyze', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /### 复核意见（reviewDispatch，只读子代理）/)
    assert.match(text, /这是\*\*意见\*\*，不是门禁裁决/)
    assert.match(text, /通过配置键 "store\.mode" 选择实现/)
    // The risk level is unchanged by the opinion.
    assert.match(text, /风险：低（low）/)

    assert.equal(reviewers.calls.length, 1)
    const call = reviewers.calls[0]
    assert.equal(call?.provider, 'spawn')
    const request = call?.request as {
        toolFilter?: { allow?: string[]; deny?: string[] }
        maxDepth?: number
        prompt?: { text?: string }[]
    }
    assert.deepEqual(request.toolFilter, { allow: ['read', 'glob', 'grep'], deny: ['orchestrate'] })
    assert.equal(request.maxDepth, 1)
    const prompt = request.prompt?.[0]?.text ?? ''
    assert.ok(prompt.includes(IMPACT_REVIEW_RUBRIC))
    assert.match(prompt, /src\/store\/store\.ts/)
    assert.deepEqual(reviewers.disposed, ['review-1'])

    // Default OFF: no subagent is dispatched when the host did not ask for one.
    const plain = host(cwd, {}, { subagents: reviewers.service })
    const plainRun = runText(await plain.runTool('impact_analyze', {}))
    assert.doesNotMatch(plainRun, /复核意见/)
    assert.equal(reviewers.calls.length, 1)
})

// --- pure helpers ----------------------------------------------------------

test('small helpers stay deterministic and honest', () => {
    assert.equal(riskLabel('high'), '高（high）')
    assert.equal(riskLabel('medium'), '中（medium）')
    assert.equal(riskLabel('low'), '低（low）')
    assert.deepEqual(
        groupByDistance([
            { path: 'b.ts', distance: 2, via: 'a.ts' },
            { path: 'a.ts', distance: 2, via: 'x.ts' },
            { path: 'z.ts', distance: 1, via: 'x.ts' },
        ]).map(([distance, files]) => [distance, files.map((file) => file.path)]),
        [
            [1, ['z.ts']],
            [2, ['a.ts', 'b.ts']],
        ],
    )
    assert.deepEqual(resolveConfig({ maxDistance: 0, maxFiles: -3, reviewDispatch: 'nope' }).reviewDispatch.provider, 'spawn')
    assert.equal(resolveConfig({ maxDistance: 0 }).maxDistance, 6)
    assert.equal(resolveConfig({ testCommandTemplate: '  go test {files}  ' }).testCommandTemplate, 'go test {files}')
})

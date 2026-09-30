/**
 * The change-SOURCE tests: the host's `workspaceChanges` service vs our own
 * `git diff` parsing.
 *
 * These run against the built `dist/`, build a real git repository with
 * `execFileSync('git', …)` where git is the point, and drive the service through
 * a structural fake — the official package is NOT a dependency of this plugin
 * (the plugin reaches it through `ctx.get('workspaceChanges')`), so the fake is
 * the only honest stand-in for it.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, clearProjectConfigCache } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { CHANGE_SOURCES, resolveConfig } from '../dist/config.js'
import { ChangeLedger, sourceLabel } from '../dist/changes.js'

/** Every assembled host, disposed in `after()`. */
const hosts: FakeHost[] = []

/** Log files live outside the workspaces so they never look like a change. */
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-source-logs-'))

test.after(() => {
    for (const fake of hosts) fake.dispose()
})

/** Assemble the plugin in a throwaway workspace, with optional host services. */
function host(cwd: string, config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services: { ...services } })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${path.basename(cwd)}-${hosts.length}.log`), ...config })
    return fake
}

/**
 * The workspace the tests analyse:
 *
 *   cmd/main.ts ── src/api/handler.ts ── src/store/store.ts ── src/store/store.test.ts
 */
function fixture(): string {
    const cwd = tempWorkspace('impact-source-')
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
    write('package.json', '{ "name": "impact-source-fixture" }\n')
    write('.gitignore', '.dsh/\n*.log\n')
    write('src/store/store.ts', 'export function save(): number {\n    return 1\n}\n')
    write('src/store/store.test.ts', "import { save } from './store.js'\n\ntest('save', () => {\n    save()\n})\n")
    write('src/api/handler.ts', "import { save } from '../store/store.js'\n\nexport function handle(): number {\n    return save()\n}\n")
    git('add', '.')
    git('commit', '-qm', 'init')
    return cwd
}

/** The same edit the git tests make: one inserted line, one modified line. */
function touchStore(cwd: string): void {
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n    // touched\n    return 2\n}\n')
}

/** The hunks the service would compute for {@link touchStore} (three context lines). */
const STORE_HUNKS = [
    {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [' export function save(): number {', '+    // touched', '-    return 1', '+    return 2', ' }'],
    },
]

/** One fake service call log. */
interface ServiceCalls {
    summary: number
    diff: number[]
}

/** What a fake service should answer with. */
interface ServiceOptions {
    files?: { path: string; added?: number; deleted?: number; binary?: boolean; oversized?: boolean }[]
    total?: number
    /** Throw from `summary()` with this message. */
    summaryThrows?: string
    /** Answer `undefined` from `summary()`. */
    summaryMissing?: boolean
    /** Answer with this garbage instead of a summary object. */
    summaryGarbage?: unknown
    /** Throw from `diff()` with this message. */
    diffThrows?: string
    /** Answer `undefined` from `diff()`. */
    diffMissing?: boolean
    /** Answer with this garbage instead of a comparison. */
    diffGarbage?: unknown
    /** Per-path comparisons, overriding the text default. */
    comparisons?: (file: { path: string; added?: number; deleted?: number }) => unknown
    /** The turn the summary itself reports (default: the event's turn). */
    turn?: number
}

/** A structural stand-in for `@deepseek-ai/dsh-workspace-changes`. */
function fakeService(options: ServiceOptions = {}): { api: Record<string, unknown>; calls: ServiceCalls } {
    const calls: ServiceCalls = { summary: 0, diff: [] }
    const files = options.files ?? [{ path: 'src/store/store.ts', added: 2, deleted: 1 }]
    const api = {
        summary: (sessionId: string, seq: number) => {
            calls.summary += 1
            if (options.summaryThrows !== undefined) throw new Error(options.summaryThrows)
            if (options.summaryMissing === true) return undefined
            if (options.summaryGarbage !== undefined) return options.summaryGarbage
            return {
                turn: options.turn ?? 3,
                cwd: sessionId,
                files,
                total: options.total ?? files.length,
                added: 2,
                deleted: 1,
            }
        },
        diff: async (_sessionId: string, seq: number, index: number) => {
            calls.diff.push(index)
            if (options.diffThrows !== undefined) throw new Error(options.diffThrows)
            if (options.diffMissing === true) return undefined
            if (options.diffGarbage !== undefined) return options.diffGarbage
            const file = files[index]
            if (file === undefined) return undefined
            if (options.comparisons !== undefined) return options.comparisons(file)
            if (file.binary === true) return { kind: 'binary', path: file.path, display: file.path }
            if (file.oversized === true) return { kind: 'oversized', path: file.path, display: file.path }
            return { kind: 'text', path: file.path, display: file.path, before: true, after: true, hunks: STORE_HUNKS, coarse: false }
        },
    }
    return { api, calls }
}

/** Announce a `workspace/changes` event, exactly as the host does. */
function emitChange(fake: FakeHost, seq = 7, turn = 3): void {
    fake.emit('session/event', [fake.agent.session, { type: 'workspace/changes', seq, data: { turn } }])
}

/** A mission bound to the fake host's session. */
function bindMission(cwd: string, id = 'm1'): MissionStoreRegistry {
    const stores = new MissionStoreRegistry()
    const store = stores.for(cwd)
    store.create({ id, title: '改动来源测试', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', id)
    return stores
}

/** The newest artifact written for `m1`. */
function newestArtifact(cwd: string, id = 'm1'): Record<string, unknown> {
    const dir = path.join(cwd, '.dsh', 'missions', id, 'impact')
    const files = fs.readdirSync(dir).sort()
    const newest = files[files.length - 1] as string
    return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8')) as Record<string, unknown>
}

// --- the service is used ----------------------------------------------------

test('a mounted workspaceChanges service supplies the change set, and the report says so', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api, calls } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更来源：workspaceChanges（会话 session-1 第 3 轮，事件 seq=7）/)
    assert.match(text, /变更基线：不适用（该来源报的是某一轮的改动，不是相对某个 ref 的差异）/)
    assert.match(text, /行区间：hunk 级/)
    // The hunks ARE the added ranges: the same facts git would have produced.
    assert.match(text, /`src\/store\/store\.ts`：修改，新增 L2-L3，删除 1 行/)
    assert.match(text, /### 影响面（2 个文件，按导入距离分组）/)
    assert.match(text, /`src\/store\/store\.test\.ts`：导入改动文件（距离 1）/)
    // A usable service is not a fallback, and the git read is only a cross-check.
    assert.doesNotMatch(text, /回退/)
    assert.match(text, /交叉核对：`git diff HEAD` 与本次来源的改动集一致/)
    assert.doesNotMatch(text, /### 无法读取 diff/)
    assert.equal(calls.summary, 1)
    assert.deepEqual(calls.diff, [0])
    assert.match(text.trimEnd().split('\n').at(-1) ?? '', /^下一步：/)
})

test("the summary's own turn is preferred over the event's (the record owns that field)", async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService({ turn: 9 })
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake, 7, 3)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /变更来源：workspaceChanges（会话 session-1 第 9 轮，事件 seq=7）/)
})

test('the artifact records which source answered, its turn and the limits it carries', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const stores = bindMission(cwd)
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const run = await fake.runTool('impact_analyze', { missionId: 'm1' })
    assert.equal(run.isError, false, runText(run))

    const artifact = newestArtifact(cwd)
    assert.equal(artifact['base'], 'workspaceChanges（会话 session-1 第 3 轮，事件 seq=7）')
    const source = artifact['changeSource'] as Record<string, unknown>
    assert.equal(source['source'], 'workspaceChanges')
    assert.equal(source['granularity'], 'hunk')
    assert.deepEqual(source['turn'], { session: 'session-1', turn: 3, seq: 7 })
    assert.equal(source['fallbackReason'], undefined, '采用来源时不得出现回退原因')
    assert.ok((source['limits'] as string[]).some((line) => /轮/.test(line)), '来源的语义边界必须写进产物')
    assert.ok((source['limits'] as string[]).some((line) => /重命名/.test(line)), '重命名前的路径不可得，必须写明')
    assert.equal((artifact['config'] as Record<string, unknown>)['changeSource'], 'auto')
    assert.deepEqual(artifact['changed'], [
        { path: 'src/store/store.ts', added: [[2, 3]], removed: 1, status: 'modified' },
    ])
    assert.equal(stores.for(cwd).readEvidence('m1').length, 1)
})

test('a non-git workspace with the service mounted produces an analysis instead of "no diff"', async () => {
    const cwd = tempWorkspace('impact-source-nogit-')
    fs.mkdirSync(path.join(cwd, 'src', 'store'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n    // touched\n    return 2\n}\n')
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.test.ts'), "import { save } from './store.js'\n\ntest('save', () => {\n    save()\n})\n")
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更来源：workspaceChanges/)
    assert.match(text, /风险：低（low）/)
    assert.doesNotMatch(text, /无法判定/)
    assert.doesNotMatch(text, /### 无法读取 diff/)
    assert.match(text, /`src\/store\/store\.ts`：修改，新增 L2-L3/)
})

// --- the git path is untouched without the service ---------------------------

test('without the service the git path is exactly what it always was', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更基线：HEAD/)
    assert.match(text, /变更来源：git（回退：宿主没有挂载 workspaceChanges 服务/)
    assert.match(text, /`src\/store\/store\.ts`：修改，新增 L2-L3，删除 1 行/)
    assert.match(text, /扫描：5 个文件、2 条导入边/)
    assert.match(text, /风险：低（low）/)
    assert.doesNotMatch(text, /交叉核对/)

    // The existing behaviour the pre-change tests pinned, unchanged:
    const legacy = runText(await host(cwd, { changeSource: 'git' }).runTool('impact_analyze', {}))
    assert.match(legacy, /变更基线：HEAD/)
    assert.match(legacy, /变更来源：git$|\n变更来源：git\n/m)
    assert.doesNotMatch(legacy, /回退/)
    assert.match(legacy, /`src\/store\/store\.ts`：修改，新增 L2-L3，删除 1 行/)
})

// --- unusable services are reported fallbacks, never "nothing changed" -------

test('a throwing summary falls back to git with the reason in the report', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService({ summaryThrows: 'boom' })
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更来源：git（回退：workspaceChanges\.summary\(\) 抛错：boom）/)
    assert.match(text, /### 改动文件（1 个）/)
    assert.match(text, /`src\/store\/store\.ts`：修改，新增 L2-L3，删除 1 行/)
    assert.match(text, /风险：低（low）/)
    assert.doesNotMatch(text, /（空：没有改动）/)
})

test('a throwing diff (or a missing comparison) falls back to git, with the file named', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const throwing = fakeService({ diffThrows: 'snapshot read failed' })
    const first = host(cwd, {}, { workspaceChanges: throwing.api })
    emitChange(first)
    const text = runText(await first.runTool('impact_analyze', {}))
    assert.match(text, /变更来源：git（回退：workspaceChanges\.diff\(\) 抛错（第 1 个文件 src\/store\/store\.ts）：snapshot read failed）/)
    assert.match(text, /风险：低（low）/)

    const missing = fakeService({ diffMissing: true })
    const second = host(cwd, {}, { workspaceChanges: missing.api })
    emitChange(second)
    const other = runText(await second.runTool('impact_analyze', {}))
    assert.match(other, /变更来源：git（回退：workspaceChanges 对第 1 个文件 src\/store\/store\.ts 没有比较结果/)
})

test('garbage from the service is a reported fallback, not a crash', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const cases: { options: ServiceOptions; expected: RegExp }[] = [
        { options: { summaryGarbage: { files: 'nope', total: 1 } }, expected: /摘要结构不可用：files 不是数组/ },
        { options: { summaryGarbage: { files: [{ path: 42 }] } }, expected: /files\[0\]\.path 不是非空字符串/ },
        { options: { summaryGarbage: { files: [{ path: 'a.ts' }] }, diffGarbage: { kind: 'surprise' } }, expected: /不认识的比较结果（kind="surprise"）/ },
        { options: { summaryMissing: true }, expected: /没有 seq=7 的摘要/ },
    ]
    for (const [index, entry] of cases.entries()) {
        const { api } = fakeService(entry.options)
        const fake = host(cwd, {}, { workspaceChanges: api })
        emitChange(fake)
        const run = await fake.runTool('impact_analyze', {})
        assert.equal(run.isError, false, `第 ${index + 1} 种垃圾输入不得抛错：${runText(run)}`)
        const text = runText(run)
        assert.match(text, /变更来源：git（回退：/)
        assert.match(text, entry.expected)
        assert.match(text, /风险：低（low）/, '回退之后必须仍然是一次真实分析')
    }
})

test('a service that reports zero files falls back instead of reporting "nothing changed"', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService({ files: [], total: 0 })
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更来源：git（回退：workspaceChanges 报了第 3 轮 0 个改动文件/)
    assert.match(text, /### 改动文件（1 个）/, 'git 看到的那一个改动必须还在')
    assert.doesNotMatch(text, /（空：没有改动）/)
    assert.doesNotMatch(text, /本次没有改动/)
})

test('a session with no recorded turn is a fallback reason, not an empty change set', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api, calls } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    // No emitChange: the plugin never saw a workspace/changes event.
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /回退：本会话没有 workspace\/changes 记录/)
    assert.match(text, /### 改动文件（1 个）/)
    assert.equal(calls.summary, 0, '没有记录时连服务都不问')
})

// --- pinning -----------------------------------------------------------------

test("changeSource: 'workspaceChanges' with no service is a loud refusal naming the key and the fix", async () => {
    const cwd = fixture()
    touchStore(cwd)
    const fake = host(cwd, { changeSource: 'workspaceChanges' })
    const run = await fake.runTool('impact_analyze', {})
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.match(text, /changeSource 已固定为 'workspaceChanges'/)
    assert.match(text, /宿主没有挂载 workspaceChanges 服务/)
    assert.match(text, /@deepseek-ai\/dsh-workspace-changes/)
    assert.match(text, /'auto'/)
    assert.match(text, /'git'/)
    assert.match(text, /宁可拒绝，也不静默回退/)
    // A refusal is not a green analysis.
    assert.doesNotMatch(text, /风险：低/)
})

test("changeSource: 'git' ignores a mounted service completely", async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api, calls } = fakeService({ summaryThrows: 'must never be called' })
    const fake = host(cwd, { changeSource: 'git' }, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /变更基线：HEAD/)
    assert.match(text, /变更来源：git/)
    assert.doesNotMatch(text, /回退/)
    assert.doesNotMatch(text, /must never be called/)
    assert.equal(calls.summary, 0, '固定为 git 时不得碰服务')
    assert.deepEqual(calls.diff, [])
})

test('a project file cannot pin the change source: the host value is kept and the key is reported', async () => {
    const cwd = fixture()
    touchStore(cwd)
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'impact-gate.json'), '{ "changeSource": "workspaceChanges" }\n')
    clearProjectConfigCache()
    const { api, calls } = fakeService()
    const fake = host(cwd, { changeSource: 'git' }, { workspaceChanges: api })
    emitChange(fake)

    const status = runText(await fake.runTool('impact_status', {}))
    assert.match(status, /键 "changeSource" 不允许在项目级配置里覆盖/)
    assert.match(status, /改动集来源（changeSource）：git/)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /变更来源：git/, 'profile 的 git 必须生效：项目改不了它')
    assert.doesNotMatch(text, /workspaceChanges（会话/)
    assert.equal(calls.summary, 0)
    clearProjectConfigCache()
})

test('impact_status reports the configured source and whether the service is mounted', async () => {
    const cwd = fixture()
    const mounted = runText(await host(cwd, {}, { workspaceChanges: fakeService().api }).runTool('impact_status', {}))
    assert.match(mounted, /改动集来源（changeSource）：auto（有 workspaceChanges 服务就用它，否则回退 git 并写明原因）/)
    assert.match(mounted, /workspaceChanges 服务：已挂载（已记录 0 个会话的轮次）/)

    const bare = runText(await host(cwd).runTool('impact_status', {}))
    assert.match(bare, /workspaceChanges 服务：\*\*未挂载\*\*/)
})

test('a pinned service that answers is used, and the refusal only covers a silent one', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService()
    const fake = host(cwd, { changeSource: 'workspaceChanges' }, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /变更来源：workspaceChanges/)
    assert.doesNotMatch(text, /回退/)
})

test('impact_tests renders the same source, so the command cannot look better than its facts', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService()
    const fake = host(cwd, { testCommandTemplate: 'node --test {files}' }, { workspaceChanges: api })
    emitChange(fake)
    const run = await fake.runTool('impact_tests', {})
    assert.equal(run.isError, false, runText(run))
    const text = runText(run)
    assert.match(text, /变更来源：workspaceChanges（会话 session-1 第 3 轮，事件 seq=7）/)
    assert.match(text, /变更基线：不适用/)
    assert.match(text, /### 命令/)
    assert.match(text, /node --test src\/store\/store\.test\.ts/)

    // A fallback is visible here too: the selection is only as good as its facts.
    const fallback = runText(await host(cwd, { testCommandTemplate: 'node --test {files}' }, { workspaceChanges: fakeService({ diffThrows: 'gone' }).api }).runTool('impact_tests', {}))
    assert.match(fallback, /变更来源：git（回退：/)
})

test('impact_status names the source the newest artifact was based on', async () => {
    const cwd = fixture()
    touchStore(cwd)
    bindMission(cwd)
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    assert.equal((await fake.runTool('impact_analyze', { missionId: 'm1' })).isError, false)
    const status = runText(await fake.runTool('impact_status', { missionId: 'm1' }))
    assert.match(status, /当时的改动集来源：workspaceChanges（产物里的 `changeSource.source`）/)
})

// --- honest limits of the adopted source ------------------------------------

test('a divergence from git is reported, not resolved silently', async () => {
    const cwd = fixture()
    touchStore(cwd)
    // git sees a second change the service did not report (another turn, or a
    // different notion of "changed"): the report must say so.
    fs.writeFileSync(path.join(cwd, 'src', 'api', 'extra.ts'), 'export const extra = 1\n')
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /变更来源：workspaceChanges/)
    assert.match(text, /⚠️ 交叉核对（只报告，不裁决）/)
    assert.match(text, /只有 git 报的：`src\/api\/extra\.ts`/)
    assert.match(text, /changeSource: "git"` 重跑/)
})

test('files outside the workspace are skipped, counted and reported', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService({
        files: [
            { path: 'src/store/store.ts', added: 2, deleted: 1 },
            { path: '../outside.ts', added: 3, deleted: 0 },
        ],
    })
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))

    assert.match(text, /### 改动文件（1 个）/, '工作区外的改动不进改动集')
    assert.match(text, /1 个改动文件不在工作区内/)
    assert.match(text, /\.\.\/outside\.ts/)
})

test('a service that only lists a binary file keeps it, with no line ranges', async () => {
    const cwd = fixture()
    const { api } = fakeService({ files: [{ path: 'src/store/store.ts', binary: true }] })
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const text = runText(await fake.runTool('impact_analyze', {}))
    assert.match(text, /变更来源：workspaceChanges/)
    assert.match(text, /`src\/store\/store\.ts`：修改，无新增行/)
    assert.match(text, /1 个文件是二进制或超大/)
})

// --- the ledger and the helpers ----------------------------------------------

test('the ledger keys recorded turns by session and forgets them on disposal', () => {
    const ledger = new ChangeLedger(2)
    assert.equal(ledger.observe({ id: 'a' }, { type: 'workspace/changes', seq: 3, data: { turn: 1 } }), true)
    assert.equal(ledger.observe({ id: 'a' }, { type: 'tool/result', seq: 4 }), false)
    assert.equal(ledger.observe({ header: { id: 'b' } }, { type: 'workspace/changes', seq: 9, data: { turn: 2 } }), true)
    assert.deepEqual(ledger.latestFor('a'), { seq: 3, turn: 1 })
    assert.deepEqual(ledger.latestFor('b'), { seq: 9, turn: 2 })
    // A second event for the same session replaces the first.
    ledger.observe({ id: 'a' }, { type: 'workspace/changes', seq: 11, data: { turn: 2 } })
    assert.deepEqual(ledger.latestFor('a'), { seq: 11, turn: 2 })
    // Garbage is ignored, never recorded as a turn.
    assert.equal(ledger.observe({}, { type: 'workspace/changes', seq: 1 }), false)
    assert.equal(ledger.observe({ id: 'a' }, { type: 'workspace/changes', seq: 'x' }), false)
    assert.equal(ledger.sessions, 2)
    ledger.observe({ id: 'c' }, { type: 'workspace/changes', seq: 1, data: { turn: 1 } })
    assert.equal(ledger.sessions, 2, '超过上限时最久没记录的会话被淘汰')
    assert.equal(ledger.latestFor('b'), undefined, '被淘汰的是最久没记录的那个，不是刚记录过的')
    assert.deepEqual(ledger.latestFor('a'), { seq: 11, turn: 2 })
    ledger.forget({ id: 'c' })
    assert.equal(ledger.sessions, 1)
})

test('the source labels are the exact strings an audit reads', () => {
    assert.deepEqual(CHANGE_SOURCES, ['auto', 'workspaceChanges', 'git'])
    assert.equal(sourceLabel({ source: 'workspaceChanges', detail: '', granularity: 'hunk', limits: [] }), 'workspaceChanges')
    assert.equal(sourceLabel({ source: 'git', detail: 'HEAD', granularity: 'hunk', limits: [] }), 'git')
    assert.equal(
        sourceLabel({ source: 'git', fallbackReason: '服务不可用', detail: 'HEAD', granularity: 'hunk', limits: [] }),
        'git（回退：服务不可用）',
    )
    assert.equal(sourceLabel({ source: 'paths', detail: '', granularity: 'none', limits: [] }), '显式 paths')
    // An unknown value is reported, never silently accepted.
    const problems: string[] = []
    assert.equal(resolveConfig({ changeSource: 'svn' }, (message) => problems.push(message)).changeSource, 'auto')
    assert.match(problems.join('\n'), /config\.changeSource 必须是 auto \/ workspaceChanges \/ git 之一/)
    assert.equal(resolveConfig({}, () => undefined).changeSource, 'auto')
})

test('a consumed service record never masquerades as the current turn (regression)', async () => {
    // The live verification caught this: the service appends a record ONLY for a
    // turn that changed something, so a later analysis in the same session re-served
    // the earlier turn's change set verbatim. The second call must not present that
    // record as the current change set — it falls back and says why.
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    const first = runText(await fake.runTool('impact_analyze', {}))
    assert.match(first, /变更来源：workspaceChanges/, 'the first analysis uses the record')
    const second = runText(await fake.runTool('impact_analyze', {}))
    assert.match(second, /已经被上一次分析使用过/, 'the same record is refused as stale, with the reason')
    assert.match(second, /变更来源：git/, 'and it falls back to git, which does describe now')
    assert.doesNotMatch(second, /变更来源：workspaceChanges（会话 session-1 第 3 轮，事件 seq=7）/)
})

test('a fresh record after a consumed one is used again (regression)', async () => {
    const cwd = fixture()
    touchStore(cwd)
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    await fake.runTool('impact_analyze', {})
    emitChange(fake, 9, 4)
    const third = runText(await fake.runTool('impact_analyze', {}))
    // The invariant is "a NEW record is usable again" — not the turn number, which
    // the fake service reports from its own options rather than from the seq.
    assert.match(third, /变更来源：workspaceChanges/, 'a NEW record is not stale')
    assert.doesNotMatch(third, /已经被上一次分析使用过/)
    assert.match(third, /事件 seq=9/, 'and it is the record that just arrived')
})

test('two analyses in the same second write two artifacts (regression)', async () => {
    // `stamp()` is second-resolution: the second analysis used to overwrite the
    // first artifact while both evidence rows pointed at that one path.
    const cwd = fixture()
    touchStore(cwd)
    bindMission(cwd)
    const { api } = fakeService()
    const fake = host(cwd, {}, { workspaceChanges: api })
    emitChange(fake)
    await fake.runTool('impact_analyze', {})
    emitChange(fake, 9, 4)
    await fake.runTool('impact_analyze', {})
    const dir = path.join(cwd, '.dsh', 'missions', 'm1', 'impact')
    const artifacts = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    assert.equal(artifacts.length, 2, `two analyses must leave two artifacts, got ${JSON.stringify(artifacts)}`)
    // …and the two evidence rows must point at the two DIFFERENT artifacts, which
    // is the property the live verification found broken (both rows named one path
    // because `stamp()` is second-resolution).
    const rows = fs
        .readFileSync(path.join(cwd, '.dsh', 'missions', 'm1', 'evidence.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { artifactPath?: string })
        .filter((row) => row.artifactPath !== undefined)
    assert.equal(new Set(rows.map((row) => row.artifactPath)).size, 2, `evidence rows must name distinct artifacts: ${JSON.stringify(rows.map((r) => r.artifactPath))}`)
})

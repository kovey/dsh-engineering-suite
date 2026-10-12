import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, sha256 } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost, type ToolRun } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import {
    CHUNKS_FILE,
    MANIFEST_FILE,
    POSTINGS_FILE,
    buildIndex,
    buildPostings,
    chunkDocument,
    indexDirOf,
    indexFingerprint,
    loadIndex,
    stalenessOf,
    type KbChunk,
} from '../dist/index-store.js'
import { containsId, idLikeTokens, searchIndex, tokenize } from '../dist/search.js'
import { headingOf } from '../dist/sources.js'

const hosts: FakeHost[] = []
const RECORDED_AT = 1_700_000_000_000

/** Markdown for the fixture's specification (the shape `spec_create` renders). */
function specMarkdown(missionId: string): string {
    return [
        '# 添加 health 端点',
        '',
        `- Mission: \`${missionId}\``,
        '- Status: `verified`',
        '- Revision: 2',
        '',
        '## 背景',
        '',
        '运维需要探活接口，登录失败时必须能看到原因。',
        '',
        '## 需求',
        '',
        '- R-001 暴露 GET /health',
        '- R-002 登录失败时必须返回 401',
        '',
        '## 验收标准',
        '',
        '| 编号 | 验收标准 |',
        '|------|----------|',
        '| AC-001 | GET /health 返回 200 |',
        '| AC-002 | 端口占用时启动失败 |',
        '',
    ].join('\n')
}

/** Run git in a fixture without depending on the developer's identity. */
function git(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=kb@example.com', '-c', 'user.name=kb-test', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'ignore',
    })
}

interface Fixture {
    cwd: string
    missionId: string
    receiptId: string
    specFile: string
}

/**
 * A repository that exercises every collector: specs, an ADR with an index row
 * that supersedes it, a mission with a gate and a receipt, a planning ledger, a
 * release ledger, markdown docs, TS and Go code, plus the three files a
 * collector must refuse (oversized, binary, unreadable).
 */
function fixture(prefix = 'kb-'): Fixture {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/kb/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n本仓库演示知识库索引，发布流程写在 docs/guide.md。\n')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# 部署指南\n\n发布流程：先跑 node --test，再 release_record。\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'healthcheck-body.md'), '# 乙文档\n\n这里只在正文提到 healthcheck 这个词。\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'healthcheck-title.md'), '# healthcheck\n\n标题里有关键词，正文没有重复。\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'cjk-only.md'), '# 中文文档\n\n登录失败时的处理办法写在别处，这一篇只有中文。\n')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, 'src', 'health.ts'),
        ['export function health(): { status: string } {', '    return { status: "ok" }', '}', '', 'export const PORT = 8080', ''].join('\n'),
    )
    fs.mkdirSync(path.join(cwd, 'internal', 'crawler'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'internal', 'crawler', 'small.go'), ['package crawler', '', 'func Small() int {', '\treturn 1', '}', ''].join('\n'))
    // The three refusals: oversized, binary, unreadable. `locked.md` is written
    // AFTER the fixture's commit: git cannot index a file it may not read, and a
    // tracked-but-unreadable file would make every later fingerprint a failure
    // instead of the situation under test.
    fs.writeFileSync(path.join(cwd, 'huge.md'), `# 超大文件\n\n${'x'.repeat(20_000)}\n`)
    fs.writeFileSync(path.join(cwd, 'blob.md'), Buffer.from([0x23, 0x20, 0x62, 0x00, 0x01, 0x02, 0x03]))

    // The mission trail, written through the store (never by hand): this is the
    // API the collector reads, and a hand-written mission.json would test a
    // fixture instead of the contract.
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title: '添加 health 端点', cwd, id: 'add-health-20260928-153000' })
    store.writeSpec(mission.id, specMarkdown(mission.id))
    // The record `spec_approve` writes (spec-gate calls `store.update` with the
    // merged record) — the summary reads THIS, not the markdown.
    store.update(mission.id, () => ({
        status: 'verified',
        stage: 'quality-verify',
        spec: {
            title: '添加 health 端点',
            background: '运维需要探活接口',
            requirements: [
                { id: 'R-001', text: '暴露 GET /health' },
                { id: 'R-002', text: '登录失败时必须返回 401' },
            ],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'GET /health 返回 200' },
                { id: 'AC-002', text: '端口占用时启动失败' },
            ],
            fileBoundaries: ['src/**'],
            negativeConstraints: ['不得修改 .dsh/**'],
            revision: 2,
            createdAt: RECORDED_AT,
            updatedAt: RECORDED_AT,
            approvedAt: RECORDED_AT,
            approvedBy: 'human',
        },
    }))
    const gate = store.recordGate(mission.id, {
        source: 'dsh-quality-gate',
        state: 'PASS',
        reason: '全部命令通过',
        results: [],
        scope: { selected: ['test'], total: 1, full: true },
    })
    const receipt = store.issueReceipt(mission.id, { issuedBy: 'agent-1', gateId: gate.id, evidenceIds: [] })

    const adrDir = path.join(cwd, '.dsh', 'adr')
    fs.mkdirSync(adrDir, { recursive: true })
    fs.writeFileSync(path.join(adrDir, '0001-lexical-index.md'), ['# 0001 词法索引而不是向量库', '', '## 状态', '', '已接受。', ''].join('\n'))
    fs.writeFileSync(
        path.join(adrDir, 'index.jsonl'),
        `${JSON.stringify({
            at: RECORDED_AT,
            number: 1,
            slug: 'lexical-index',
            path: '.dsh/adr/0001-lexical-index.md',
            title: '词法索引而不是向量库',
            missionId: mission.id,
            supersededBy: 2,
        })}\n`,
    )
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'plan.jsonl'),
        `${[
            JSON.stringify({
                at: RECORDED_AT,
                kind: 'spec-created',
                missionId: mission.id,
                specId: mission.id,
                title: '添加 health 端点',
                milestone: 'M1 健康检查',
                requirementIds: ['R-001', 'R-002'],
                criteriaIds: ['AC-001', 'AC-002'],
                summary: '创建规格',
            }),
            JSON.stringify({
                at: RECORDED_AT + 1_000,
                kind: 'spec-approved',
                missionId: mission.id,
                specId: mission.id,
                title: '添加 health 端点',
                milestone: 'M1 健康检查',
                requirementIds: ['R-001', 'R-002'],
                criteriaIds: ['AC-001', 'AC-002'],
                approvedBy: 'human',
                summary: '规格已批准',
            }),
        ].join('\n')}\n`,
    )
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'releases.jsonl'),
        `${JSON.stringify({
            at: RECORDED_AT + 2_000,
            version: '1.2.0',
            tag: 'v1.2.0',
            revision: { isRepo: true, head: 'a'.repeat(40), branch: 'main', dirty: false, changedFiles: 0, diffDigest: sha256('') },
            missionIds: [mission.id],
            receiptIds: [receipt.id],
            recordedBy: 'agent-1',
            note: '首个发布',
        })}\n`,
    )
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'fixture'])
    fs.writeFileSync(path.join(cwd, 'locked.md'), '# 锁住的文件\n')
    fs.chmodSync(path.join(cwd, 'locked.md'), 0o000)
    return { cwd, missionId: mission.id, receiptId: receipt.id, specFile: path.join(cwd, '.dsh', 'specs', `${mission.id}.md`) }
}

/**
 * Mount the plugin in a throwaway workspace.
 *
 * The log file lives OUTSIDE the workspace, as a real profile's does: a log file
 * inside the repository is itself an untracked change, and that change hides the
 * index artifact's own contribution to the git fingerprint (the very thing the
 * freshness tests are about).
 */
function host(cwd: string, config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('kb-log-'), 'knowledge-base.log'), maxFileBytes: 4096, ...config })
    return fake
}

/** Run one tool and return the run (never thrown: `runTool` captures refusals). */
function call(fake: FakeHost, tool: string, args: Record<string, unknown> = {}): Promise<ToolRun> {
    return fake.runTool(tool, args)
}

/** Run one tool and return its rendered report. */
async function text(fake: FakeHost, tool: string, args: Record<string, unknown> = {}): Promise<string> {
    return runText(await call(fake, tool, args))
}

/** Snapshot every file under a directory (relative path → digest). */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) walk(target)
            else out[path.relative(dir, target)] = sha256(fs.readFileSync(target))
        }
    }
    walk(dir)
    return out
}

/**
 * A minimal committed repository with no `.dsh/` at all.
 *
 * `ignoreKb` decides whether the repository tells git to ignore `.dsh/kb/`; the
 * tests around the artifact-invalidates-itself bug need BOTH answers, because the
 * bug only shows up where the artifact is untracked and un-ignored (which is what
 * a live repository did).
 */
function plainRepo(prefix: string, options: { ignoreKb?: boolean } = {}): string {
    const cwd = tempWorkspace(prefix)
    if (options.ignoreKb === true) fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/kb/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n登录失败的处理写在 docs/guide.md。\n')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# 部署指南\n\n发布流程：先跑 node --test。\n')
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'fixture'])
    return cwd
}

/** One command definition as the stand-in registry stores it. */
interface FakeCommand {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { agent?: unknown; rawInput?: unknown }) => { kind: string; text?: string } | Promise<{ kind: string; text?: string }>
}

/**
 * A stand-in for `@deepseek-ai/dsh-commands`: it records definitions and invokes
 * handlers, and — like the real registry — returns the exact disposer.
 */
function fakeCommandRegistry(): { definitions: Map<string, FakeCommand>; disposed: string[]; register: (definition: FakeCommand) => () => void } {
    const definitions = new Map<string, FakeCommand>()
    const disposed: string[] = []
    return {
        definitions,
        disposed,
        register(definition) {
            if (definitions.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
            definitions.set(definition.name, definition)
            return () => {
                definitions.delete(definition.name)
                disposed.push(definition.name)
            }
        },
    }
}

/** Mount the plugin with the command registry present, and run `/kb …` lines. */
function commandHost(cwd: string, config: Record<string, unknown> = {}) {
    const registry = fakeCommandRegistry()
    const fake = host(cwd, config, { commands: registry })
    const run = async (rawInput: unknown): Promise<{ kind: string; text: string }> => {
        const definition = registry.definitions.get('kb')
        assert.ok(definition !== undefined, '/kb must be registered when the registry is mounted')
        const result = await definition.handler({ agent: fake.agent, rawInput })
        return { kind: result.kind, text: result.text ?? '' }
    }
    return { fake, registry, run }
}

/** One hand-made chunk (for the pure retrieval tests). */
function chunkOf(id: string, kind: string, chunkPath: string, title: string, body: string): KbChunk {
    return { id, docId: `${kind}:${chunkPath}`, kind: kind as KbChunk['kind'], path: chunkPath, title, from: 1, to: 1, text: body }
}

/** The config a test uses when it drives `buildIndex` directly. */
function configOf(overrides: Record<string, unknown> = {}) {
    return resolveConfig({ logFile: path.join(tempWorkspace('kb-log-'), 'kb.log'), maxFileBytes: 4096, ...overrides })
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-knowledge-base')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('(regression) rebuilding an unchanged repository is byte-identical and only builtAt moves', () => {
    const { cwd } = fixture('kb-determinism-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT, force: true })
    const chunksFirst = fs.readFileSync(first.files.chunks)
    const postingsFirst = fs.readFileSync(first.files.postings)
    const manifestFirst = JSON.parse(fs.readFileSync(first.files.manifest, 'utf8')) as Record<string, unknown>
    assert.equal(first.changeKind, 'created')
    assert.ok(chunksFirst.length > 0, 'the fixture must produce chunks')

    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000, force: true })
    const chunksSecond = fs.readFileSync(second.files.chunks)
    const postingsSecond = fs.readFileSync(second.files.postings)
    const manifestSecond = JSON.parse(fs.readFileSync(second.files.manifest, 'utf8')) as Record<string, unknown>
    assert.equal(second.changeKind, 'forced')
    assert.ok(chunksFirst.equals(chunksSecond), 'chunks.jsonl must be byte-identical across builds')
    assert.ok(postingsFirst.equals(postingsSecond), 'postings.json must be byte-identical across builds')
    assert.notEqual(manifestFirst['builtAt'], manifestSecond['builtAt'])
    const withoutClock = (value: Record<string, unknown>): Record<string, unknown> => ({ ...value, builtAt: 'x' })
    assert.deepEqual(withoutClock(manifestSecond), withoutClock(manifestFirst), 'builtAt must be the only manifest difference')
})

test('chunk ids are content-addressed, stable and timestamp-free', () => {
    const { cwd } = fixture('kb-ids-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT, force: true })
    const ids = first.chunks.map((chunk) => chunk.id)
    assert.equal(new Set(ids).size, ids.length, 'chunk ids must be unique')
    for (const id of ids) {
        assert.match(id, /^[a-z]+:.+:\d+-\d+$/, `unexpected chunk id ${id}`)
        assert.doesNotMatch(id, /\d{4}-\d{2}-\d{2}|\d{13}/, `chunk id must not carry a timestamp: ${id}`)
    }
    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 1, force: true })
    assert.deepEqual(second.chunks.map((chunk) => chunk.id), ids)
    // A chunk of a file document cites real lines of that file.
    const spec = first.chunks.find((chunk) => chunk.path === '.dsh/specs/add-health-20260928-153000.md')
    assert.ok(spec !== undefined, 'the specification must be indexed')
    const lines = fs.readFileSync(path.join(cwd, spec.path), 'utf8').split('\n')
    assert.ok(spec.to <= lines.length, 'from/to must stay inside the file')
    assert.equal(lines[spec.from - 1], spec.text.split('\n')[0])
})

test('symbols come from the existing extractors (TypeScript and Go)', () => {
    const { cwd } = fixture('kb-symbols-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const loaded = loadIndex(buildIndex({ cwd, layout, config: configOf(), now: RECORDED_AT }).dir)
    const typescript = loaded.chunks.filter((chunk) => chunk.path === 'src/health.ts')
    const go = loaded.chunks.filter((chunk) => chunk.path === 'internal/crawler/small.go')
    assert.ok(typescript.length > 0 && go.length > 0)
    const tsSymbols = typescript.flatMap((chunk) => chunk.symbols ?? []).map((symbol) => symbol.name)
    const goSymbols = go.flatMap((chunk) => chunk.symbols ?? []).map((symbol) => symbol.name)
    assert.ok(tsSymbols.includes('health'), `expected health in ${tsSymbols.join(',')}`)
    assert.ok(tsSymbols.includes('PORT'), `expected PORT in ${tsSymbols.join(',')}`)
    assert.ok(goSymbols.includes('Small'), `expected Small in ${goSymbols.join(',')}`)
    const symbol = typescript.flatMap((chunk) => chunk.symbols ?? []).find((entry) => entry.name === 'health')
    assert.equal(symbol?.kind, 'func')
    assert.equal(symbol?.line, 1)
})

test('CJK text is indexed as bigrams and an ASCII query does not match a CJK-only document', async () => {
    assert.deepEqual(tokenize('登录失败', { cjkBigrams: true, minTokenLength: 2 }), ['登录', '录失', '失败'])
    assert.deepEqual(tokenize('登录失败', { cjkBigrams: false, minTokenLength: 2 }), ['登录失败'])
    assert.deepEqual(tokenize('AC-002 登录', { cjkBigrams: true, minTokenLength: 2 }), ['ac', '002', '登录'])
    assert.deepEqual(idLikeTokens('看看 AC-002 和 ADR-0001、M-7'), ['ac-002', 'adr-0001', 'm-7'])
    assert.equal(containsId('见 AC-0021 与 AC-002。', 'ac-002'), true)
    assert.equal(containsId('只有 AC-0021', 'ac-002'), false)

    const { cwd } = fixture('kb-cjk-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const cjk = await text(fake, 'kb_search', { query: '登录' })
    assert.match(cjk, /命中/)
    assert.match(cjk, /添加 health 端点|\.dsh\/specs/)
    const ascii = await text(fake, 'kb_search', { query: 'login' })
    assert.doesNotMatch(ascii, /docs\/cjk-only\.md/)
})

test('BM25 ranks a title hit above a body-only hit for the same term', () => {
    const config = resolveConfig({})
    const chunks = [
        chunkOf('docs:docs/a.md:1-1', 'docs', 'docs/a.md', 'healthcheck', '标题里有关键词。'),
        chunkOf('docs:docs/b.md:1-1', 'docs', 'docs/b.md', '乙文档', '这里只在正文提到 healthcheck 这个词。'),
    ]
    const outcome = searchIndex({
        chunks,
        postings: buildPostings(chunks, config.tokenizer),
        query: 'healthcheck',
        limit: 10,
        maxLimit: 50,
        boosts: config.search.fieldBoosts,
        tokenizer: config.tokenizer,
    })
    assert.equal(outcome.hits.length, 2)
    assert.equal(outcome.hits[0]?.chunk.path, 'docs/a.md')
    assert.equal(outcome.hits[0]?.reasons[0]?.field, 'title')
    assert.equal(outcome.hits[1]?.reasons[0]?.field, 'body')
    assert.ok((outcome.hits[0]?.score ?? 0) > (outcome.hits[1]?.score ?? 0))
})

test('an exact id finds the chunk that defines it (AC-002, ADR-0001)', async () => {
    const { cwd, missionId } = fixture('kb-id-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)

    const criterion = await text(fake, 'kb_search', { query: 'AC-002' })
    assert.match(criterion, /id 精确命中：ac-002/)
    const firstHit = criterion.split('\n').find((line) => /^\[1\] /.test(line)) ?? ''
    assert.match(firstHit, /\.dsh\/specs\//)

    const decision = await text(fake, 'kb_search', { query: 'ADR-0001' })
    assert.match(decision, /\.dsh\/adr\//)
    assert.match(decision, /0001/)

    const missionQuery = await text(fake, 'kb_search', { query: missionId })
    assert.match(missionQuery, new RegExp(missionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('filters restrict kinds, path prefix and mission', () => {
    const config = resolveConfig({})
    const chunks = [
        chunkOf('spec:.dsh/specs/m1.md:1-1', 'spec', '.dsh/specs/m1.md', '规格 m1', '登录失败返回 401'),
        chunkOf('docs:docs/guide.md:1-1', 'docs', 'docs/guide.md', '部署指南', '登录失败的处理写在别处'),
        chunkOf('code:src/health.ts:1-1', 'code', 'src/health.ts', 'health.ts', '登录失败时抛出错误 health'),
    ]
    const base = {
        chunks,
        postings: buildPostings(chunks, config.tokenizer),
        query: '登录失败',
        limit: 10,
        maxLimit: 50,
        boosts: config.search.fieldBoosts,
        tokenizer: config.tokenizer,
    }
    assert.equal(searchIndex({ ...base, kinds: ['docs'] }).hits.map((hit) => hit.chunk.path).join(), 'docs/guide.md')
    assert.equal(searchIndex({ ...base, pathPrefix: 'src/' }).hits.map((hit) => hit.chunk.path).join(), 'src/health.ts')
    assert.equal(searchIndex({ ...base, missionId: 'm1' }).hits.length, 1)
    assert.equal(searchIndex({ ...base, missionId: 'm1' }).hits[0]?.chunk.path, '.dsh/specs/m1.md')
})

test('the limit is capped at maxLimit and the cap is reported', () => {
    const config = resolveConfig({ search: { limit: 10, maxLimit: 5 } })
    const chunks = Array.from({ length: 9 }, (_, index) =>
        chunkOf(`docs:docs/${index}.md:1-1`, 'docs', `docs/${index}.md`, `文档 ${index}`, '登录失败的说明'),
    )
    const outcome = searchIndex({
        chunks,
        postings: buildPostings(chunks, config.tokenizer),
        query: '登录',
        limit: 100,
        maxLimit: config.search.maxLimit,
        boosts: config.search.fieldBoosts,
        tokenizer: config.tokenizer,
    })
    assert.equal(outcome.limit, 5)
    assert.equal(outcome.limitClamped, true)
    assert.equal(outcome.hits.length, 5)
    assert.equal(outcome.scored, 9)
})

test('kb_search refuses without an index and names kb_index', async () => {
    const cwd = tempWorkspace('kb-missing-')
    const fake = host(cwd)
    const search = await call(fake, 'kb_search', { query: '登录' })
    assert.equal(search.isError, true)
    const message = runText(search)
    assert.match(message, /kb_index/)
    assert.match(message, /索引不存在/)
    const status = await call(fake, 'kb_status')
    assert.equal(status.isError, false)
    assert.match(runText(status), /还没有构建/)
    assert.match(runText(status), /kb_index/)
})

test('(regression) a spec changed after indexing makes kb_search warn, and rebuilding clears it', async () => {
    const { cwd, specFile } = fixture('kb-stale-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const fresh = await text(fake, 'kb_search', { query: 'health' })
    assert.doesNotMatch(fresh, /索引可能过期/)
    assert.match(fresh, /与当前工作区指纹一致/)

    fs.appendFileSync(specFile, '| AC-003 | 新增的验收标准 |\n')
    const stale = await text(fake, 'kb_search', { query: 'health' })
    assert.match(stale, /⚠️ 索引可能过期/)
    assert.match(stale, /diff/)
    const status = await text(fake, 'kb_status')
    assert.match(status, /索引可能过期/)
    assert.match(status, /先 `kb_index` 重建/)

    assert.equal((await call(fake, 'kb_index')).isError, false)
    assert.doesNotMatch(await text(fake, 'kb_search', { query: 'health' }), /索引可能过期/)
})

test('staleness comparison is conservative in both directions', () => {
    const repo = { isRepo: true, head: 'a'.repeat(40), branch: 'main', dirty: false, changedFiles: 0, diffDigest: sha256('') }
    assert.equal(stalenessOf(repo, { ...repo }).stale, false)
    assert.equal(stalenessOf(repo, { ...repo, head: 'b'.repeat(40) }).stale, true)
    assert.match(stalenessOf(repo, { ...repo, diffDigest: sha256('x') }).reason ?? '', /diff/)
    assert.equal(stalenessOf(repo, { ...repo, changedFiles: 1, dirty: true }).stale, true)
    const notRepo = stalenessOf(repo, { isRepo: false, dirty: false, changedFiles: 0, diffDigest: sha256('') })
    assert.equal(notRepo.stale, false)
    assert.equal(notRepo.unknown, true)
})

test('every skipped file is reported with its reason (binary, oversized, unreadable)', async () => {
    const { cwd } = fixture('kb-skips-')
    const report = await text(host(cwd), 'kb_index')
    assert.match(report, /blob\.md：binary（含 NUL 字节）/)
    assert.match(report, /huge\.md：oversized（/)
    let readable = true
    try {
        fs.readFileSync(path.join(cwd, 'locked.md'))
    } catch {
        readable = false
    }
    if (readable) {
        // Running as root (or on a filesystem without POSIX modes): the reason
        // under test cannot be produced, and pretending it was would be worse
        // than saying so.
        assert.match(report, /locked\.md/)
    } else {
        assert.match(report, /locked\.md：unreadable（/)
    }
    assert.match(report, /跳过 \d+ 项/)
})

test('(regression) a torn chunks.jsonl drops rows, reports the count and still answers', async () => {
    const { cwd } = fixture('kb-torn-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const chunksFile = path.join(cwd, '.dsh', 'kb', CHUNKS_FILE)
    const complete = fs.readFileSync(chunksFile, 'utf8').trimEnd().split('\n')
    fs.writeFileSync(chunksFile, `${complete.slice(0, -1).join('\n')}\n${(complete[complete.length - 1] as string).slice(0, 40)}`)

    const loaded = loadIndex(path.dirname(chunksFile))
    assert.equal(loaded.droppedChunks, 1)
    assert.equal(loaded.chunks.length, complete.length - 1)
    const report = await text(fake, 'kb_search', { query: 'health' })
    assert.match(report, /有 1 行无法解析/)
    assert.match(report, /kb_index 重建/)
})

test('a postings file that does not match its chunk list is refused, not answered around', async () => {
    const { cwd } = fixture('kb-mismatch-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const dir = path.join(cwd, '.dsh', 'kb')
    fs.appendFileSync(
        path.join(dir, CHUNKS_FILE),
        `${JSON.stringify({ ...chunkOf('docs:docs/extra.md:1-1', 'docs', 'docs/extra.md', 'x', '附带的一行'), docId: 'docs:docs/extra.md' })}\n`,
    )
    const loaded = loadIndex(dir)
    assert.equal(loaded.problems.length, 1)
    assert.match(loaded.problems[0]?.message ?? '', /不一致/)
    assert.equal(loaded.problems[0]?.fatal, true, 'an unexplained mismatch must be fatal')
    assert.equal(loaded.droppedChunks, 0)
    const refused = await call(fake, 'kb_search', { query: 'health' })
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /kb_index/)
})

test('(regression) kb_index says "unchanged" on a second run and rewrites nothing', async () => {
    const { cwd } = fixture('kb-unchanged-')
    const fake = host(cwd)
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    const before = snapshot(path.join(cwd, '.dsh', 'kb'))
    const second = await text(fake, 'kb_index')
    assert.match(second, /索引已是最新，未变/)
    assert.match(second, /没有重写任何文件/)
    assert.doesNotMatch(second, /首次构建/)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh', 'kb')), before)
    const forced = await text(fake, 'kb_index', { force: true })
    assert.match(forced, /force=true/)
})

test('kb_search and kb_status are read-only (byte snapshot of .dsh)', async () => {
    const { cwd, missionId } = fixture('kb-readonly-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const before = snapshot(path.join(cwd, '.dsh'))
    assert.equal((await call(fake, 'kb_search', { query: '登录', limit: 3 })).isError, false)
    assert.equal((await call(fake, 'kb_search', { query: 'AC-002', missionId })).isError, false)
    assert.equal((await call(fake, 'kb_status')).isError, false)
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before)
})

test('a project may narrow the index but never widen it', async () => {
    const { cwd } = fixture('kb-overlay-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const hostConfig = resolveConfig({ maxFileBytes: 4096, search: { limit: 6, maxLimit: 20 } })
    fs.writeFileSync(
      path.join(cwd, '.dsh', 'knowledge-base.json'),
      `${JSON.stringify({
        search: { limit: 2, maxLimit: 100 },
        maxFileBytes: 10_000_000,
        maxChunkLines: 5,
        tokenizer: { cjkBigrams: true },
        sources: [{ id: 'docs', enabled: false }, { id: 'code', globs: ['**/*.rs'] }, { id: 'nope', enabled: true }],
      })}\n`,
    )
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.search.limit, 2)
    assert.equal(effective.config.search.maxLimit, 20, 'a project may not raise maxLimit past the host ceiling')
    assert.equal(effective.config.maxFileBytes, 4096, 'a project may not raise maxFileBytes')
    assert.equal(effective.config.maxChunkLines, 5, 'a project may lower maxChunkLines')
    assert.equal(effective.config.sources.find((source) => source.id === 'docs')?.enabled, false)
    const codeGlobs = effective.config.sources.find((source) => source.id === 'code')?.globs ?? []
    assert.ok(!codeGlobs.includes('**/*.rs'), 'a project may not add a pattern the profile did not authorise')
    assert.ok(effective.problems.some((problem) => problem.includes('maxLimit=100 超过')))
    assert.ok(effective.problems.some((problem) => problem.includes('maxFileBytes=10000000 超过')))
    assert.ok(effective.problems.some((problem) => problem.includes('新增了 profile 未授权的模式')))
    assert.ok(effective.problems.some((problem) => problem.includes('未定义来源')))

    const fake = host(cwd)
    const report = await text(fake, 'kb_index')
    assert.match(report, /项目级覆盖生效/)
    assert.match(report, /docs（docs）：已停用/)
    assert.match(report, /被拒绝的项目级覆盖/)
    const hits = await text(fake, 'kb_search', { query: '登录' })
    assert.match(hits, /limit=2/)
    assert.doesNotMatch(hits, /docs\/guide\.md/)
})

test('a partial build records its own limitation', async () => {
    const { cwd } = fixture('kb-partial-')
    const fake = host(cwd)
    const report = await text(fake, 'kb_index', { only: ['docs'] })
    assert.match(report, /局部索引/)
    assert.match(report, /spec（spec）：\*\*不在本次索引里\*\*/)
    const status = await text(fake, 'kb_status')
    assert.match(status, /索引自身声明的局限：局部索引/)
    const unknown = await call(fake, 'kb_index', { only: ['nope'] })
    assert.equal(unknown.isError, true)
    assert.match(runText(unknown), /未配置的来源/)
})

test('a query with nothing to search is refused with the fix', async () => {
    const { cwd } = fixture('kb-emptyquery-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const empty = await call(fake, 'kb_search', { query: '   ' })
    assert.equal(empty.isError, true)
    assert.match(runText(empty), /非空的 query/)
    const punctuation = await call(fake, 'kb_search', { query: '，。！' })
    assert.equal(punctuation.isError, true)
    assert.match(runText(punctuation), /没有可检索的内容/)
    const badKind = await call(fake, 'kb_search', { query: 'health', kinds: ['nope'] })
    assert.equal(badKind.isError, true)
    assert.match(runText(badKind), /未知类型/)
    const badLimit = await call(fake, 'kb_search', { query: 'health', limit: -1 })
    assert.equal(badLimit.isError, true)
    assert.match(runText(badLimit), /limit 必须是不小于 1/)
})

test('a project-level disable refuses with the reason and writes no artifact', async () => {
    const { cwd } = fixture('kb-disabled-')
    // The profile keeps the plugin on (so the tools exist to explain themselves);
    // the repository's own file turns it off. A profile-level `enabled: false`
    // registers nothing at all — that is the host's decision, not a refusal.
    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), `${JSON.stringify({ enabled: false })}\n`)
    const fake = host(cwd)
    const refused = await call(fake, 'kb_search', { query: 'health' })
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /enabled=false/)
    const indexRefused = await call(fake, 'kb_index')
    assert.equal(indexRefused.isError, true)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'kb')), false)
    assert.equal(host(cwd, { enabled: false }).tools.size, 0, 'a profile-level disable registers no tool')
})

test('coverage, totals and the honest statement all appear in kb_status', async () => {
    const { cwd } = fixture('kb-status-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const status = await text(fake, 'kb_status')
    assert.match(status, /按来源：/)
    for (const kind of ['spec', 'adr', 'trail', 'plan', 'docs', 'code']) assert.match(status, new RegExp(`- ${kind}（${kind}）`))
    assert.match(status, /不是：向量\/语义检索/)
    assert.match(status, /不是 git 历史/)
    assert.match(status, /BM25 k1=1\.2 b=0\.75/)
    assert.match(status, /未跟踪文件的内容改动不会改变指纹/)
    assert.match(status, /下一步：/)
    const loaded = loadIndex(indexDirOf(cwd, resolveConfig({})))
    assert.equal(loaded.manifest?.totals.chunks, loaded.chunks.length)
    const perSource = (loaded.manifest?.sources ?? []).reduce((sum, source) => sum + source.chunks, 0)
    assert.equal(perSource, loaded.manifest?.totals.chunks)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'kb', MANIFEST_FILE)), true)
})

test('the trail summary names the artifacts behind every fact (and stays a summary)', () => {
    const { cwd, missionId, receiptId } = fixture('kb-trail-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const loaded = loadIndex(buildIndex({ cwd, layout, config: configOf(), now: RECORDED_AT }).dir)
    const missionChunk = loaded.chunks.find((chunk) => chunk.kind === 'trail' && chunk.path.endsWith('mission.json'))
    assert.ok(missionChunk !== undefined, 'one document per mission')
    assert.equal(missionChunk.path, `.dsh/missions/${missionId}/mission.json`)
    assert.match(missionChunk.title, new RegExp(missionId))
    for (const expected of [missionId, 'verified', 'quality-verify', '已批准', 'R-001', 'R-002', 'AC-001', 'AC-002', 'GATE-', receiptId]) {
        assert.match(missionChunk.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the summary must carry ${expected}`)
    }
    // The gate and receipt lines point at their own artifacts.
    assert.match(missionChunk.text, new RegExp(`\\.dsh/missions/${missionId}/gates/GATE-`))
    assert.match(missionChunk.text, new RegExp(`\\.dsh/missions/${missionId}/receipts/`))
    // It is a summary: the specification's body text is NOT duplicated here.
    assert.doesNotMatch(missionChunk.text, /## 验收标准/)
    assert.doesNotMatch(missionChunk.text, /GET \/health 返回 200/)

    const release = loaded.chunks.find((chunk) => chunk.kind === 'trail' && chunk.path === '.dsh/releases.jsonl')
    assert.ok(release !== undefined, 'one document per recorded release')
    assert.match(release.text, /1\.2\.0/)
    assert.match(release.text, /v1\.2\.0/)
    assert.match(release.text, new RegExp(receiptId))

    const plan = loaded.chunks.find((chunk) => chunk.kind === 'plan')
    assert.ok(plan !== undefined)
    assert.equal(plan.path, '.dsh/plan.jsonl')
    assert.match(plan.text, /M1 健康检查/)
    assert.match(plan.text, /R-001 R-002/)
    assert.match(plan.text, /台账行：1-2/)
})

test('(regression) prototype-named tokens survive the index round-trip and score finitely', () => {
    const config = resolveConfig({})
    const chunks = [
        chunkOf(
            'code:src/a.ts:1-2',
            'code',
            'src/a.ts',
            'a.ts',
            'export class A { constructor() {} toString() { return "a" } }\nconst proto = obj.__proto__\n',
        ),
        chunkOf('docs:docs/b.md:1-1', 'docs', 'docs/b.md', '乙文档', '与原型无关的一段正文。'),
    ]
    // The index round-trips through JSON, so its maps inherit Object.prototype
    // (and `__proto__` is an accessor on the WRITE side too).
    const postings = JSON.parse(JSON.stringify(buildPostings(chunks, config.tokenizer)))
    for (const query of ['constructor', '__proto__', 'toString']) {
        const outcome = searchIndex({
            chunks,
            postings,
            query,
            limit: 10,
            maxLimit: 50,
            boosts: config.search.fieldBoosts,
            tokenizer: config.tokenizer,
        })
        assert.equal(outcome.hits.length, 1, `${query} must find exactly the chunk that contains it`)
        assert.equal(outcome.hits[0]?.chunk.path, 'src/a.ts')
        assert.ok(Number.isFinite(outcome.hits[0]?.score ?? Number.NaN), `${query} must produce a finite score`)
    }
})

test('the model-facing section states the citation and gap rules', () => {
    const { cwd } = fixture('kb-prompt-')
    const fake = host(cwd)
    const promptText = fake.sectionText('eng:knowledge-base')
    assert.match(promptText, /kb_search/)
    assert.match(promptText, /path:from-to/)
    assert.match(promptText, /索引里没有/)
    assert.match(promptText, /过期/)
    assert.match(promptText, /不是权威/)
})

test('section text resolves per assembly workspace, without a process.cwd fallback', () => {
    const { cwd } = fixture('kb-section-')
    const fake = host(cwd)
    const section = fake.sections.find((entry) => entry.name === 'eng:knowledge-base')
    assert.ok(section !== undefined && typeof section.text === 'function')
    const scoped = section.text({ scope: { session: { header: { cwd } } } })
    assert.match(scoped, /\.dsh\/kb/)
    const unscoped = section.text(undefined)
    assert.match(unscoped, /kb_search/)
})

test('an unusable configuration value keeps the host value instead of being coerced', () => {
    const config = resolveConfig({
        maxFileBytes: -1,
        maxChunkLines: 'x',
        search: { limit: 0, maxLimit: -3 },
        tokenizer: { minTokenLength: 0 },
        sources: 'nope',
    })
    assert.equal(config.maxFileBytes, 256 * 1024)
    assert.equal(config.maxChunkLines, 60)
    assert.equal(config.search.limit, 10)
    assert.equal(config.search.maxLimit, 50)
    assert.equal(config.tokenizer.minTokenLength, 2)
    assert.equal(config.sources.length, 6)
    // A malformed project file is reported, and the profile value is used.
    const { cwd } = fixture('kb-badjson-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), '{ not json')
    const effective = resolveEffectiveConfig(config, layout)
    assert.equal(effective.source, 'profile')
    assert.equal(effective.config.search.limit, 10)
    assert.ok(effective.problems.some((problem) => problem.includes('不是合法 JSON')))
})

test('chunking respects maxChunkLines and keeps line numbers exact', () => {
    const document = {
        id: 'docs:docs/long.md',
        kind: 'docs' as const,
        path: 'docs/long.md',
        title: '长文档',
        text: Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行`).join('\n'),
    }
    const chunks = chunkDocument(document, 4)
    assert.deepEqual(
        chunks.map((chunk) => `${chunk.from}-${chunk.to}`),
        ['1-4', '5-8', '9-10'],
    )
    assert.equal(chunks[1]?.text.split('\n')[0], '第 5 行')
    assert.deepEqual(chunks.map((chunk) => chunk.id), ['docs:docs/long.md:1-4', 'docs:docs/long.md:5-8', 'docs:docs/long.md:9-10'])
})

test('heading extraction drives the title of markdown documents', () => {
    assert.equal(headingOf('# 标题\n\n正文'), '标题')
    assert.equal(headingOf('没有标题\n\n正文'), undefined)
})

// ---------------------------------------------------------------------------
// Item 1 — the index must not make itself look stale
// ---------------------------------------------------------------------------

test('(regression) an un-ignored index artifact does not make its own index stale', async () => {
    // The live failure: `.dsh/kb/` was untracked and NOT in `.gitignore`, so the
    // build's own files appeared in the workspace fingerprint between the build
    // and the comparison — `kb_index` succeeded and `kb_search` answered "过期，
    // 工作区改动数从 0 变成 0".
    const cwd = plainRepo('kb-unignored-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const dir = indexDirOf(cwd, resolveConfig({}))
    const manifest = loadIndex(dir).manifest
    assert.ok(manifest !== undefined, 'the build must have written a manifest')

    const current = indexFingerprint(cwd, dir)
    assert.equal(stalenessOf(manifest.fingerprint, current).stale, false, `fingerprint: ${JSON.stringify(current)}`)
    assert.equal(current.dirty, false, 'the artifact must not make the workspace dirty')
    assert.equal(current.changedFiles, 0, 'the artifact must not be counted as a change')

    const search = await text(fake, 'kb_search', { query: '登录' })
    assert.match(search, /新鲜度：与当前工作区指纹一致/)
    assert.doesNotMatch(search, /索引可能过期/)
    const status = await text(fake, 'kb_status')
    assert.doesNotMatch(status, /索引可能过期/)
    assert.match(status, /新鲜度：与当前工作区指纹一致/)
    assert.match(status, /比较时索引目录（\.dsh\/kb）被排除/)
    // exit path: the search report's 下一步 no longer tells the reader to rebuild
    assert.match(search, /索引里没有的内容要说/)
})

test('(regression) a real change after indexing is still stale, and the reason names it', async () => {
    const cwd = plainRepo('kb-still-stale-')
    const fake = host(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const dir = indexDirOf(cwd, resolveConfig({}))
    const indexed = loadIndex(dir).manifest?.fingerprint
    assert.ok(indexed !== undefined)

    // ① a tracked source edit moves the diff digest
    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n发布前必须跑 scripts/verify.sh。\n')
    const edited = await text(fake, 'kb_search', { query: '发布' })
    assert.match(edited, /⚠️ 索引可能过期：工作区相对 HEAD 的改动变了/)
    assert.match(edited, /diff [0-9a-f]{8} → [0-9a-f]{8}/)
    assert.equal(stalenessOf(indexed, indexFingerprint(cwd, dir)).stale, true)

    // rebuilding clears it — the artifact still does not re-stale the fresh index
    assert.equal((await call(fake, 'kb_index')).isError, false)
    assert.doesNotMatch(await text(fake, 'kb_search', { query: '发布' }), /索引可能过期/)
    assert.equal(stalenessOf(loadIndex(dir).manifest?.fingerprint as never, indexFingerprint(cwd, dir)).stale, false)

    // ② a new untracked file NEXT TO the artifact (inside `.dsh/`, outside `.dsh/kb/`)
    //    is a real change: the exclusion names the index directory, not its parent
    fs.writeFileSync(path.join(cwd, '.dsh', 'plan.jsonl'), `${JSON.stringify({ at: RECORDED_AT, kind: 'note' })}\n`)
    const moved = await text(fake, 'kb_status')
    assert.match(moved, /⚠️ 索引可能过期/)
    // the tracked edit above is still counted (1), and the new file is the second
    assert.match(moved, /改动数从 1 变成 2/)
})

test('(regression) a committed index artifact does not make its own index stale', () => {
    // The README allows committing `.dsh/kb/` ("可读、可 diff、可进版本库"). A
    // rebuild then rewrites a TRACKED manifest.json (builtAt), which lands in
    // `git diff HEAD` unless the diff digest excludes the artifact too.
    const cwd = plainRepo('kb-committed-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT })
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'index'])
    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000, force: true })
    assert.equal(second.changed, true, 'force must rewrite the manifest')
    assert.equal(first.manifest.fingerprint.diffDigest, second.fingerprint.diffDigest, 'the artifact must not move the diff digest')
    assert.equal(stalenessOf(second.fingerprint, indexFingerprint(cwd, second.dir)).stale, false)

    // and it is an exclusion, not a blindfold
    fs.appendFileSync(path.join(cwd, 'README.md'), '\n补充说明。\n')
    assert.equal(stalenessOf(second.fingerprint, indexFingerprint(cwd, second.dir)).stale, true)
})

test('(regression) a gitignored index directory behaves exactly as before', async () => {
    const cwd = plainRepo('kb-gitignored-', { ignoreKb: true })
    const fake = host(cwd)
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    const dir = indexDirOf(cwd, resolveConfig({}))
    const manifest = loadIndex(dir).manifest
    assert.ok(manifest !== undefined)
    const current = indexFingerprint(cwd, dir)
    assert.equal(current.dirty, false)
    assert.equal(current.changedFiles, 0)
    assert.equal(stalenessOf(manifest.fingerprint, current).stale, false)
    assert.match(await text(fake, 'kb_search', { query: '登录' }), /新鲜度：与当前工作区指纹一致/)
    // the second build is still the byte-comparing, non-rewriting one
    assert.match(await text(fake, 'kb_index'), /索引已是最新，未变/)
    // and a real edit is still reported (the gitignored case never relied on the fix)
    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n新的一行。\n')
    assert.match(await text(fake, 'kb_status'), /⚠️ 索引可能过期/)
})

test('the index fingerprint excludes exactly the index directory, not its parent', () => {
    const cwd = plainRepo('kb-exclusion-')
    const dir = indexDirOf(cwd, resolveConfig({}))
    const clean = indexFingerprint(cwd, dir)
    assert.equal(clean.dirty, false)
    assert.equal(clean.changedFiles, 0)
    assert.equal(clean.diffDigest, sha256(''), 'a clean worktree has the empty diff digest')

    // the artifact's three files are untracked (and not ignored) — still not a change
    fs.mkdirSync(dir, { recursive: true })
    for (const file of [MANIFEST_FILE, CHUNKS_FILE, POSTINGS_FILE]) fs.writeFileSync(path.join(dir, file), '{}\n')
    assert.equal(indexFingerprint(cwd, dir).changedFiles, 0)
    assert.equal(indexFingerprint(cwd, dir).dirty, false)

    // one file next to it IS one change
    fs.writeFileSync(path.join(cwd, '.dsh', 'plan.jsonl'), '{}\n')
    assert.equal(indexFingerprint(cwd, dir).changedFiles, 1)
    assert.equal(indexFingerprint(cwd, dir).dirty, true)

    // untracked files elsewhere are counted individually, not collapsed into `?? notes/`
    fs.mkdirSync(path.join(cwd, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'notes', 'a.md'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'notes', 'b.md'), 'b\n')
    assert.equal(indexFingerprint(cwd, dir).changedFiles, 3)
})

// ---------------------------------------------------------------------------
// Item 2 — the `/kb` human command
// ---------------------------------------------------------------------------

test('(regression) /kb registers only with the command registry, and a broken one never breaks apply', async () => {
    const { cwd } = fixture('kb-command-optional-')

    // ① no registry: the three tools and the prompt section are unaffected
    const bare = host(cwd)
    assert.equal(bare.tools.size, 3)
    assert.equal((bare.ctx as { get: (name: string) => unknown }).get('commands'), undefined)
    bare.dispose()

    // ② a partial registry (no `register`) is treated as absent
    const partial = host(cwd, {}, { commands: {} })
    assert.equal(partial.tools.size, 3)
    assert.ok(partial.sections.some((section) => section.name === 'eng:knowledge-base'))
    partial.dispose()

    // ③ a registry whose register() throws: contained, logged, tools intact
    const broken = host(
        cwd,
        {},
        {
            commands: {
                register() {
                    throw new Error('registry down')
                },
            },
        },
    )
    assert.equal(broken.tools.size, 3)
    broken.dispose()

    // ④ the mounted registry gets exactly one definition, with a hint and a handler
    const mounted = commandHost(cwd)
    assert.deepEqual([...mounted.registry.definitions.keys()], ['kb'])
    const definition = mounted.registry.definitions.get('kb')
    assert.match(definition?.description ?? '', /知识库/)
    assert.match(definition?.input?.hint ?? '', /index/)
    assert.equal(typeof definition?.handler, 'function')
    // …and the plugin's teardown unregisters it through the registry's own disposer
    mounted.fake.dispose()
    assert.deepEqual(mounted.registry.disposed, ['kb'])
})

test('/kb calls the same operations as the tools, byte for byte', async () => {
    const { cwd } = fixture('kb-command-same-')
    const { fake, run } = commandHost(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)

    const statusCommand = await run('status')
    assert.equal(statusCommand.kind, 'success')
    assert.equal(statusCommand.text, await text(fake, 'kb_status'))

    const searchCommand = await run('search health --limit 2 --kind docs --prefix docs/')
    assert.equal(searchCommand.text, await text(fake, 'kb_search', { query: 'health', limit: 2, kinds: ['docs'], pathPrefix: 'docs/' }))

    // `--force` on both sides so the two reports describe the same build
    const indexCommand = await run('index --force')
    assert.equal(indexCommand.text, await text(fake, 'kb_index', { force: true }))

    // repeated `--source` is the tool's `only`
    const partial = await run('index --source docs')
    assert.equal(partial.kind, 'success')
    assert.match(partial.text, /局部索引/)
    assert.match(partial.text, /spec（spec）：\*\*不在本次索引里\*\*/)
})

test('/kb answers help for a bare line, and every unrecognised line is an error carrying the usage', async () => {
    const cwd = plainRepo('kb-command-grammar-')
    const { run } = commandHost(cwd)

    assert.equal((await run('')).kind, 'success')
    assert.match((await run('')).text, /\/kb index \[--force\]/)
    assert.match((await run('help')).text, /\/kb status/)
    assert.match((await run('help 我该怎么用')).text, /用法：/)

    const refused: [string, RegExp][] = [
        ['indx', /未知子命令/],
        ['index --limit 5', /index 无法识别的参数/],
        ['index --source nope', /未配置的来源/],
        ['index --source', /--source 后面要跟一个来源 id/],
        ['search', /search 需要一个关键词/],
        ['search 登录 --kind nope', /未知类型/],
        ['search 登录 --limit 0', /--limit 必须是不小于 1 的整数/],
        ['search 登录 --limit', /--limit 后面要跟一个值/],
        ['search 登录 --limit=5', /本命令用空格分隔参数：--limit 5/],
        ['status extra', /status 不接受参数/],
    ]
    for (const [line, pattern] of refused) {
        const result = await run(line)
        assert.equal(result.kind, 'error', `/${line} must be an error result`)
        assert.match(result.text, pattern, `/${line}`)
        assert.match(result.text, /用法：/, `/${line} must carry the usage`)
    }
    // a partial host can hand over anything: a non-string rawInput is not a crash
    assert.equal((await run(undefined)).kind, 'success')
    assert.equal((await run(42)).kind, 'success')

    // the usage names the configuration in force (source ids live in the config)
    const configured = commandHost(plainRepo('kb-command-usage-'), { search: { limit: 6, maxLimit: 20 } })
    const usage = (await configured.run('help')).text
    for (const id of ['spec', 'adr', 'trail', 'plan', 'docs', 'code']) assert.match(usage, new RegExp(id))
    assert.match(usage, /limit：默认 6、上限 20/)
    assert.match(usage, /\.dsh\/kb/)
})

test('/kb is read-only for search and status, and only `index` writes', async () => {
    const { cwd } = fixture('kb-command-readonly-')
    const { fake, run } = commandHost(cwd)
    assert.equal((await call(fake, 'kb_index')).isError, false)
    const before = snapshot(path.join(cwd, '.dsh'))
    assert.equal((await run('status')).kind, 'success')
    assert.equal((await run('search health')).kind, 'success')
    assert.equal((await run('help')).kind, 'success')
    assert.equal((await run('nonsense')).kind, 'error')
    assert.deepEqual(snapshot(path.join(cwd, '.dsh')), before, 'a read-only sub-command must not touch .dsh')

    // a refusal is an error result (not a crash), and it writes nothing either
    const missing = commandHost(plainRepo('kb-command-missing-'))
    const refused = await missing.run('search 登录')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /索引不存在或不可用/)
    assert.match(refused.text, /kb_index/)
    assert.deepEqual(snapshot(path.join(missing.fake.cwd, '.dsh')), {})

    // `index` is the one writer: it creates the artifact…
    const writer = commandHost(plainRepo('kb-command-writes-'))
    const empty = snapshot(path.join(writer.fake.cwd, '.dsh'))
    assert.deepEqual(empty, {})
    assert.equal((await writer.run('index')).kind, 'success')
    const written = snapshot(path.join(writer.fake.cwd, '.dsh'))
    assert.ok(Object.keys(written).length >= 3, 'index must write the three artifact files')
    // …and a second run is honest about writing nothing
    assert.match((await writer.run('index')).text, /索引已是最新，未变/)
    assert.deepEqual(snapshot(path.join(writer.fake.cwd, '.dsh')), written)
})

test('/kb refuses the same way the tools do when the project disabled the plugin', async () => {
    const cwd = plainRepo('kb-command-disabled-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), `${JSON.stringify({ enabled: false })}\n`)
    const { run } = commandHost(cwd)
    const refused = await run('index')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /enabled=false/)
    assert.equal((await run('search 登录')).kind, 'error')
    assert.match((await run('search 登录')).text, /enabled=false/)
    // `kb_status` never refused a disabled workspace either (it still reports what
    // the artifact is and what is missing), so `/kb status` must behave the same
    assert.equal((await run('status')).kind, 'success')
})

// ---------------------------------------------------------------------------
// Item 3 — the change detection and the freshness judgement must agree
//
// The live failure these tests pin down: `kb_index` decided "changed" from the
// indexed CONTENT only, while `kb_search` / `kb_status` decide "陈旧" from the
// git fingerprint. Editing a tracked file no source covers (`.gitignore`) moved
// the fingerprint and left every indexed byte identical, so a plain `kb_index`
// answered "索引已是最新，未变" and wrote nothing — and the warning's own advice
// could never clear the warning. Only `--force` helped.
// ---------------------------------------------------------------------------

/** One manifest as it was written to disk (parsed, not trusted). */
function manifestOf(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

test('(regression) a moved fingerprint with unchanged content refreshes the manifest only', () => {
    const { cwd } = fixture('kb-fingerprint-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT })
    assert.equal(first.changeKind, 'created')
    const chunksFirst = fs.readFileSync(first.files.chunks)
    const postingsFirst = fs.readFileSync(first.files.postings)

    // `.gitignore` is tracked and no source covers it: editing it moves the
    // workspace's diff digest while every indexed byte stays the same.
    fs.appendFileSync(path.join(cwd, '.gitignore'), 'notes/\n')
    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000 })
    assert.equal(second.changed, true, 'the moved fingerprint must be recorded')
    assert.equal(second.changeKind, 'fingerprint')
    assert.notEqual(second.fingerprint.diffDigest, first.fingerprint.diffDigest, 'the fixture must really move the fingerprint')

    // The byte-identity guarantee survives: the two content artifacts are not
    // even rewritten, let alone changed.
    assert.ok(chunksFirst.equals(fs.readFileSync(second.files.chunks)), 'chunks.jsonl must keep its bytes')
    assert.ok(postingsFirst.equals(fs.readFileSync(second.files.postings)), 'postings.json must keep its bytes')

    const manifest = manifestOf(second.files.manifest)
    assert.equal(manifest['builtAt'], new Date(RECORDED_AT + 60_000).toISOString(), 'the manifest must be stamped with the injected clock')
    assert.deepEqual(manifest['fingerprint'], second.fingerprint, 'the manifest must record the current fingerprint')

    // The whole point: the comparison every reader makes is FRESH afterwards,
    // and it no longer reports the diff that kb_index just declined to record.
    assert.equal(stalenessOf(second.fingerprint, indexFingerprint(cwd, first.dir)).stale, false)
    const loaded = loadIndex(second.dir)
    assert.equal(loaded.manifest?.fingerprint.diffDigest, second.fingerprint.diffDigest)
    assert.equal(loaded.problems.length, 0, 'a refreshed manifest must still pair with the untouched chunks/postings')
})

test('(regression) kb_index clears the staleness warning it used to leave behind, and names the refresh', async () => {
    const { cwd } = fixture('kb-fingerprint-report-')
    const fake = host(cwd)
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    assert.match(await text(fake, 'kb_search', { query: 'health' }), /新鲜度：与当前工作区指纹一致/)

    // The reproduced sequence, on the surface a user actually sees.
    fs.appendFileSync(path.join(cwd, '.gitignore'), 'notes/\n')
    assert.match(await text(fake, 'kb_search', { query: 'health' }), /⚠️ 索引可能过期/)
    assert.match(await text(fake, 'kb_status'), /⚠️ 索引可能过期/)

    const before = snapshot(path.join(cwd, '.dsh', 'kb'))
    const refreshed = await text(fake, 'kb_index')
    assert.match(
        refreshed,
        /^知识库索引：内容未变，仅刷新了指纹（chunks\.jsonl 与 postings\.json 字节未动、未重写；manifest\.json 已记下新的指纹与 builtAt）$/m,
    )
    assert.match(refreshed, /不会再报“索引陈旧”/)
    assert.doesNotMatch(refreshed, /索引已是最新，未变/, 'a refresh is not "unchanged"')
    assert.doesNotMatch(refreshed, /索引已重建/, 'a manifest-only refresh is not a rebuild')
    const after = snapshot(path.join(cwd, '.dsh', 'kb'))
    assert.equal(after[CHUNKS_FILE], before[CHUNKS_FILE], 'chunks.jsonl must not be touched')
    assert.equal(after[POSTINGS_FILE], before[POSTINGS_FILE], 'postings.json must not be touched')
    assert.notEqual(after[MANIFEST_FILE], before[MANIFEST_FILE], 'manifest.json must be rewritten')

    // Every surface that judged the index stale now agrees with the build.
    assert.match(await text(fake, 'kb_search', { query: 'health' }), /新鲜度：与当前工作区指纹一致/)
    const status = await text(fake, 'kb_status')
    assert.doesNotMatch(status, /索引可能过期/)
    assert.match(status, /内容未变但指纹变了/)
    assert.match(status, /只刷新 manifest\.json 的指纹与 builtAt/)
})

test('an unchanged repository is reported as unchanged and writes nothing at all', () => {
    const { cwd } = fixture('kb-plain-unchanged-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT })
    assert.equal(first.changeKind, 'created')
    const builtAtFirst = manifestOf(first.files.manifest)['builtAt']
    const chunksFirst = fs.readFileSync(first.files.chunks)
    const postingsFirst = fs.readFileSync(first.files.postings)
    const before = snapshot(path.join(cwd, '.dsh', 'kb'))

    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000 })
    assert.equal(second.changed, false)
    assert.equal(second.changeKind, 'unchanged')
    assert.deepEqual(snapshot(path.join(cwd, '.dsh', 'kb')), before, 'an unchanged build must not write a byte')
    // `builtAt` is the canary: a rewritten manifest always stamps the clock it
    // was given, so an equal stamp proves the manifest was left alone.
    assert.equal(manifestOf(second.files.manifest)['builtAt'], builtAtFirst)
    // the determinism guard, on plain (not forced) builds
    assert.ok(chunksFirst.equals(fs.readFileSync(second.files.chunks)), 'two plain builds must leave chunks.jsonl byte-identical')
    assert.ok(postingsFirst.equals(fs.readFileSync(second.files.postings)), 'two plain builds must leave postings.json byte-identical')
})

test('force keeps its own meaning and never becomes a fingerprint refresh', () => {
    const { cwd } = fixture('kb-force-kind-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    buildIndex({ cwd, layout, config, now: RECORDED_AT })
    assert.equal(buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000 }).changeKind, 'unchanged')

    const forced = buildIndex({ cwd, layout, config, now: RECORDED_AT + 120_000, force: true })
    assert.equal(forced.changeKind, 'forced', '--force with no change is a requested rewrite, not a refresh')
    assert.equal(forced.changed, true)

    // and the mirror image: a moved fingerprint is 'fingerprint', not 'forced'
    fs.appendFileSync(path.join(cwd, '.gitignore'), 'notes/\n')
    assert.equal(buildIndex({ cwd, layout, config, now: RECORDED_AT + 180_000 }).changeKind, 'fingerprint')
    assert.equal(
        buildIndex({ cwd, layout, config, now: RECORDED_AT + 240_000, force: true }).changeKind,
        'forced',
        'an explicit force stays a force even when the fingerprint moved',
    )
})

test('a real content change is still reported as content (not as a fingerprint refresh)', () => {
    const { cwd } = fixture('kb-content-kind-')
    const layout = new MissionStoreRegistry().for(cwd).layout
    const config = configOf()
    const first = buildIndex({ cwd, layout, config, now: RECORDED_AT })
    const chunksFirst = fs.readFileSync(first.files.chunks)
    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n发布前必须跑 scripts/verify.sh。\n')
    const second = buildIndex({ cwd, layout, config, now: RECORDED_AT + 60_000 })
    assert.equal(second.changeKind, 'content')
    assert.equal(second.changed, true)
    // One tracked edit moves the content AND the fingerprint: the content wins,
    // because that is the fact the reader has to act on.
    assert.notEqual(second.fingerprint.diffDigest, first.fingerprint.diffDigest)
    assert.ok(!chunksFirst.equals(fs.readFileSync(second.files.chunks)), 'the chunk list must be rewritten')
})

test('every host is disposed without a throw', () => {
    for (const fake of hosts) fake.dispose()
    assert.ok(hosts.length > 0)
})

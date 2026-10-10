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
    buildIndex,
    buildPostings,
    chunkDocument,
    indexDirOf,
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

/** Mount the plugin in a throwaway workspace. */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'knowledge-base.log'), maxFileBytes: 4096, ...config })
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

test('every host is disposed without a throw', () => {
    for (const fake of hosts) fake.dispose()
    assert.ok(hosts.length > 0)
})

/**
 * The two behaviour changes of this mission, end to end:
 *
 *  - **the language surface** (AC-005): the `code` source covers the eleven
 *    languages the gates measure. Four of them have a symbol extractor; the other
 *    seven are indexed as TEXT and reported as 「无符号提取器（文本索引）」 — a file
 *    whose language has no extractor is not a "skip", because its text IS in the
 *    index (and a search must find it).
 *  - **editor-time self-healing** (AC-006 / AC-003): a query that finds the index
 *    stale rebuilds it once before ranking (same pipeline as `mission_complete`'s
 *    reindex), prints 「索引已自动更新」; a failed rebuild answers from the old
 *    index but says so on the first line; the cooldown window and the
 *    one-rebuild-at-a-time rule keep a burst of searches from rebuilding once per
 *    query.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, createLogger, languageOf } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { defaultSources, resolveConfig, resolveEffectiveConfig, type EffectiveConfig } from '../dist/config.js'
import { buildWorkspaceIndex, searchWorkspace } from '../dist/operations.js'
import { MANIFEST_FILE, loadIndex } from '../dist/index-store.js'
import { runImQuery } from '../dist/im.js'
import { provideKnowledgeBaseService } from '../dist/service.js'

/** One file per supported extension: the marker must be findable after indexing. */
const LANGUAGE_SAMPLES: readonly { file: string; body: string; marker: string }[] = [
    { file: 'src/sample.ts', body: 'export function tsMarker(): number {\n    return 1\n}\n', marker: 'tsmarker' },
    { file: 'src/sample.tsx', body: 'export const tsxmarker = 1\n', marker: 'tsxmarker' },
    { file: 'src/sample.js', body: 'export function jsMarker() {\n    return 1\n}\n', marker: 'jsmarker' },
    { file: 'src/sample.mjs', body: 'export const mjsmarker = 1\n', marker: 'mjsmarker' },
    { file: 'src/sample.cjs', body: 'module.exports = { cjsmarker: 1 }\n', marker: 'cjsmarker' },
    { file: 'src/sample.go', body: 'package sample\n\nfunc GoMarker() int {\n\treturn 1\n}\n', marker: 'gomarker' },
    { file: 'src/sample.py', body: 'def py_marker():\n    return 1\n', marker: 'py_marker' },
    { file: 'src/sample.rb', body: 'def ruby_marker\n  1\nend\n', marker: 'ruby_marker' },
    { file: 'src/sample.php', body: '<?php\nfunction php_marker() {\n    return 1;\n}\n', marker: 'php_marker' },
    { file: 'src/sample.rs', body: 'pub fn rust_marker() -> i32 {\n    1\n}\n', marker: 'rust_marker' },
    { file: 'src/sample.java', body: 'class JavaMarker {\n    int value() { return 1; }\n}\n', marker: 'javamarker' },
    { file: 'src/sample.kt', body: 'fun kotlin_marker(): Int = 1\n', marker: 'kotlin_marker' },
    { file: 'src/sample.kts', body: 'val kts_marker = 1\n', marker: 'kts_marker' },
    { file: 'src/sample.cs', body: 'class CsMarker {\n    int Value() { return 1; }\n}\n', marker: 'csmarker' },
    { file: 'src/sample.swift', body: 'func swift_marker() -> Int {\n    return 1\n}\n', marker: 'swift_marker' },
]

/** The extensions the default `code` globs must cover (eleven distinct languages). */
const CODE_EXTENSIONS = ['ts', 'tsx', 'js', 'mjs', 'cjs', 'go', 'py', 'rb', 'php', 'rs', 'java', 'kt', 'kts', 'cs', 'swift']

/** Run git in a fixture without depending on the developer's identity. */
function git(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=kb-selfheal@example.com', '-c', 'user.name=kb-selfheal-test', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'ignore',
    })
}

/** A committed repository whose docs/guide.md is searchable and whose artifact is ignored. */
function gitRepo(prefix: string): string {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/kb/\n')
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n登录失败的处理写在 docs/guide.md。\n')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# 部署指南\n\n发布流程：先跑 node --test；登录失败要返回 401。\n')
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'fixture'])
    return cwd
}

/** Mount the plugin in a throwaway workspace (the log file lives outside it). */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('kb-selfheal-log-'), 'knowledge-base.log'), maxFileBytes: 4096, ...config })
    return fake
}

/** Run one tool and return its rendered report. */
async function text(fake: FakeHost, tool: string, args: Record<string, unknown> = {}): Promise<string> {
    return runText(await fake.runTool(tool, args))
}

/** The effective configuration of a workspace (what the tools pass to the operations). */
function effectiveOf(cwd: string, overrides: Record<string, unknown> = {}): EffectiveConfig {
    return { config: resolveConfig(overrides), source: 'profile', file: '', problems: [] }
}

// ---------------------------------------------------------------------------
// AC-005 — the eleven-language surface, and "no symbol extractor" is a note
// ---------------------------------------------------------------------------

test('TC-1855 the default code globs cover eleven languages (fifteen extensions)', () => {
    const globs = defaultSources().find((source) => source.id === 'code')?.globs ?? []
    for (const extension of CODE_EXTENSIONS) assert.ok(globs.includes(`**/*.${extension}`), `code globs 缺少 **/*.${extension}`)
    const languages = new Set(CODE_EXTENSIONS.map((extension) => languageOf(`x.${extension}`)))
    assert.equal(languages.size, 11, `expected 11 distinct languages, got ${[...languages].join(',')}`)
})

test('TC-1851/TC-1855 every extension is indexed as text, none is reported as skipped', async (t) => {
    const cwd = tempWorkspace('kb-languages-')
    for (const sample of LANGUAGE_SAMPLES) {
        fs.mkdirSync(path.dirname(path.join(cwd, sample.file)), { recursive: true })
        fs.writeFileSync(path.join(cwd, sample.file), sample.body)
    }
    const fake = host(cwd)
    t.after(() => fake.dispose())
    const report = await text(fake, 'kb_index')

    // The report says where the symbols stop instead of pretending otherwise...
    assert.match(report, /无符号提取器（文本索引）：/)
    for (const [language, count] of [
        ['ruby', 1],
        ['rust', 1],
        ['php', 1],
        ['java', 1],
        ['kotlin', 2],
        ['csharp', 1],
        ['swift', 1],
    ] as const) {
        assert.match(report, new RegExp(`${language} × ${count}`), `缺少语言计数 ${language} × ${count}`)
    }
    // ...and nothing is called "unsupported" any more: the text IS indexed.
    assert.doesNotMatch(report, /unsupported-language/)
    assert.match(report, /跳过 0 项/)

    const dir = path.join(cwd, '.dsh', 'kb')
    const loaded = loadIndex(dir)
    assert.ok(loaded.manifest !== undefined)
    const code = loaded.manifest.sources.find((source) => source.id === 'code')
    assert.ok(code !== undefined)
    assert.equal(code.documents, LANGUAGE_SAMPLES.length)
    assert.deepEqual(code.skipped, [])
    const paths = new Set(loaded.chunks.map((chunk) => chunk.path))
    for (const sample of LANGUAGE_SAMPLES) assert.ok(paths.has(sample.file), `${sample.file} 必须出现在 chunks 里`)
    // The four scanned languages still carry real symbols; the note never claims
    // the other seven do.
    const go = loaded.chunks.find((chunk) => chunk.path === 'src/sample.go')
    assert.ok((go?.symbols ?? []).some((symbol) => symbol.name === 'GoMarker'))

    // A text-indexed language is findable through kb_search (AC-005's "命中").
    for (const sample of LANGUAGE_SAMPLES.filter((entry) => entry.file.endsWith('.rb') || entry.file.endsWith('.rs'))) {
        const searched = await text(fake, 'kb_search', { query: sample.marker })
        const firstHit = searched.split('\n').find((line) => /^\[1\] /.test(line)) ?? ''
        assert.match(firstHit, new RegExp(sample.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `搜索 ${sample.marker} 的首条命中不是 ${sample.file}`)
    }
})

// ---------------------------------------------------------------------------
// AC-006 — a stale query heals the index before ranking
// ---------------------------------------------------------------------------

test('TC-1852 a stale search rebuilds first, notes it on the first line and finds the new content', async (t) => {
    const cwd = gitRepo('kb-heal-success-')
    const fake = host(cwd, { freshness: { cooldownMs: 0 } })
    t.after(() => fake.dispose())
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    const dir = path.join(cwd, '.dsh', 'kb')
    const builtAtBefore = loadIndex(dir).manifest?.builtAt
    assert.ok(builtAtBefore !== undefined)

    fs.writeFileSync(path.join(cwd, 'docs', 'fresh.md'), '# 新章节\n\n自愈标记 healmarker：这条内容只在重建后才有。\n')
    const searched = await text(fake, 'kb_search', { query: 'healmarker' })
    const firstLine = searched.split('\n')[0] ?? ''
    assert.match(firstLine, /^索引已自动更新（\d+ 块）/, `首行应是自动更新提示，实际：${firstLine}`)
    // The stale reason that TRIGGERED the rebuild stays visible (and is told apart
    // from advice that no longer applies).
    assert.match(searched, /⚠️ 索引可能过期：/)
    assert.match(searched, /已在本次检索前自动重建/)
    const hit = searched.split('\n').find((line) => /^\[1\] /.test(line)) ?? ''
    assert.match(hit, /docs\/fresh\.md/, `重建后应命中新文件，实际首条：${hit}`)

    const manifest = loadIndex(dir).manifest
    assert.notEqual(manifest?.builtAt, builtAtBefore, '重建必须写盘（builtAt 变了）')
    assert.ok(manifest?.sources.find((source) => source.id === 'docs') !== undefined)
})

test('TC-1853 a failed rebuild answers from the old index and says so on the first line', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('root 下目录只读不生效：无法制造重建失败')
        return
    }
    const cwd = gitRepo('kb-heal-failure-')
    const logFile = path.join(tempWorkspace('kb-heal-failure-log-'), 'knowledge-base.log')
    const fake = host(cwd, { freshness: { cooldownMs: 0 }, logFile })
    t.after(() => fake.dispose())
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    const dir = path.join(cwd, '.dsh', 'kb')
    const manifestBefore = fs.readFileSync(path.join(dir, MANIFEST_FILE))

    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n自愈失败标记 selfhealfailmarker。\n')
    fs.chmodSync(dir, 0o555)
    let searched: string
    try {
        const run = await fake.runTool('kb_search', { query: '发布' })
        assert.equal(run.isError, false, '自动重建失败不得让工具抛错')
        searched = runText(run)
    } finally {
        fs.chmodSync(dir, 0o755)
    }
    const firstLine = searched.split('\n')[0] ?? ''
    assert.match(firstLine, /^索引过期且自动重建失败：.+；结果可能缺少最近改动$/)
    // The old answer is still returned — with the stale warning, never silently.
    assert.match(searched, /⚠️ 索引可能过期/)
    assert.match(searched, /docs\/guide\.md/)
    assert.ok(
        fs.readFileSync(path.join(dir, MANIFEST_FILE)).equals(manifestBefore),
        '重建失败时不得改写旧索引（manifest.json 必须保持原字节）',
    )
    assert.match(fs.readFileSync(logFile, 'utf8'), /索引过期且自动重建失败/)
})

test('TC-1854 the cooldown window allows one rebuild, then waits, then heals again', () => {
    const cwd = gitRepo('kb-heal-cooldown-')
    const effective = effectiveOf(cwd, { freshness: { cooldownMs: 10_000 } })
    const stores = new MissionStoreRegistry()
    const logger = createLogger({ tag: 'kb-cooldown-test', file: path.join(tempWorkspace('kb-cooldown-log-'), 'kb.log') })
    const first = buildWorkspaceIndex({ cwd, effective, stores, logger, now: 1_000_000 })
    assert.equal(first.changeKind, 'created')
    const dir = first.dir
    const builtAt = (): string | undefined => loadIndex(dir).manifest?.builtAt
    assert.equal(builtAt(), new Date(1_000_000).toISOString())

    // ① stale, outside the window: rebuilt, and the new content is in the answer.
    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n第一次编辑 cooldownone。\n')
    const healed = searchWorkspace({ cwd, effective, stores, logger, options: { query: 'cooldownone' }, now: () => 1_020_000 })
    assert.equal(healed.selfHeal?.outcome, 'rebuilt')
    assert.match(healed.outcome.hits[0]?.chunk.path ?? '', /docs\/guide\.md/)
    assert.equal(builtAt(), new Date(1_020_000).toISOString())

    // ② stale again, INSIDE the window: no rebuild, old index returned, warning kept.
    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\n第二次编辑 cooldowntwo。\n')
    const skipped = searchWorkspace({ cwd, effective, stores, logger, options: { query: 'cooldowntwo' }, now: () => 1_025_000 })
    assert.equal(skipped.selfHeal?.outcome, 'skipped')
    assert.match(skipped.selfHeal?.reason ?? '', /冷却窗口内/)
    assert.equal(skipped.outcome.hits.length, 0, '冷却窗口内的答案必须来自旧索引（新词不在里面）')
    assert.equal(skipped.freshness.stale, true, '冷却没有让过期消失，只是没有重建')
    assert.equal(builtAt(), new Date(1_020_000).toISOString(), '冷却窗口内不得写盘')

    // ③ the next query after the window heals: exactly one rebuild per window.
    const again = searchWorkspace({ cwd, effective, stores, logger, options: { query: 'cooldowntwo' }, now: () => 1_040_000 })
    assert.equal(again.selfHeal?.outcome, 'rebuilt')
    assert.ok(again.outcome.hits.length > 0)
    assert.equal(builtAt(), new Date(1_040_000).toISOString())
})

test('TC-1858 two concurrent searches share one rebuild (no second write, no missing notice)', async (t) => {
    const cwd = gitRepo('kb-heal-concurrent-')
    const fake = host(cwd, { freshness: { cooldownMs: 0 } })
    t.after(() => fake.dispose())
    assert.match(await text(fake, 'kb_index'), /首次构建/)
    fs.writeFileSync(path.join(cwd, 'docs', 'concurrent.md'), '# 并发\n\n并发标记 concurrentmarker。\n')

    // Start both before awaiting either: the first call heals, the second finds a
    // fresh index — one rebuild, one notice, both answers from the same artifact.
    const pending = [
        fake.runTool('kb_search', { query: 'concurrentmarker' }),
        fake.runTool('kb_search', { query: 'concurrentmarker' }),
    ]
    const reports = (await Promise.all(pending)).map((run) => {
        assert.equal(run.isError, false)
        return runText(run)
    })
    assert.equal(reports.filter((report) => /索引已自动更新/.test(report)).length, 1, '并发搜索只允许一次重建')
    for (const report of reports) assert.match(report, /docs\/concurrent\.md/)
})

test('TC-1859 the IM /kb command heals too, and its first line says so', async () => {
    const cwd = gitRepo('kb-heal-im-')
    const stores = new MissionStoreRegistry()
    const logger = createLogger({ tag: 'kb-im-heal-test', file: path.join(tempWorkspace('kb-im-heal-log-'), 'kb.log') })
    const config = resolveConfig({ logFile: path.join(tempWorkspace('kb-im-heal-log-'), 'kb.log'), maxFileBytes: 4096, im: { workspace: cwd }, freshness: { cooldownMs: 0 } })
    const service = provideKnowledgeBaseService({}, { config, stores, logger }).service
    assert.equal((await service.reindex(cwd)).changeKind, 'created')

    fs.appendFileSync(path.join(cwd, 'docs', 'guide.md'), '\nIM 自愈标记 imhealmarker。\n')
    const reply = await runImQuery(
        { chatId: 'oc_x', args: ['imhealmarker'] },
        {
            deps: { config, stores, logger },
            service,
            imTarget: () => ({ channel: 'auto', chatId: 'oc_x', p2pOnly: false }),
        },
    )
    assert.ok(reply.text.startsWith('索引已自动更新（'), reply.text)
    assert.match(reply.text, /docs\/guide\.md/)
})

test('freshness.cooldownMs: default 10s, project may only lengthen it', () => {
    assert.equal(resolveConfig({}).freshness.cooldownMs, 10_000)
    assert.equal(resolveConfig({ freshness: { cooldownMs: 0 } }).freshness.cooldownMs, 0)
    assert.equal(resolveConfig({ freshness: { cooldownMs: -1 } }).freshness.cooldownMs, 10_000)

    const cwd = tempWorkspace('kb-freshness-config-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const layout = new MissionStoreRegistry().for(cwd).layout
    const hostConfig = resolveConfig({ freshness: { cooldownMs: 10_000 } })

    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), `${JSON.stringify({ freshness: { cooldownMs: 60_000 } })}\n`)
    const lengthened = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(lengthened.source, 'project')
    assert.equal(lengthened.config.freshness.cooldownMs, 60_000)

    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), `${JSON.stringify({ freshness: { cooldownMs: 5_000 } })}\n`)
    const shortened = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(shortened.config.freshness.cooldownMs, 10_000, '项目级不能缩短冷却窗口')
    assert.match(shortened.problems.join('\n'), /freshness\.cooldownMs=5000 低于 profile 的 10000/)
})

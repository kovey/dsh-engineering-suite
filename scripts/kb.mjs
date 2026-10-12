#!/usr/bin/env node
/**
 * kb.mjs — 项目知识库的人/CI 入口。
 *
 * 为什么需要它：`kb_index` / `kb_search` / `kb_status` 是**模型侧工具**（dsh 里由模型在会话中调用，
 * 你也可以直接用自然语言让它跑）。但"人想自己跑一次""CI 想核对索引"时不该只能求模型，
 * 所以这里用同一份 `dsh-knowledge-base` 实现（建索引、加载、检索都直接调它导出的函数，
 * 不复制任何逻辑——渲染是脚本自己的，判定与打分仍只有一份）。
 *
 * usage:
 *   node scripts/kb.mjs index  [<repo>] [--force] [--source <id>]...   # 建/刷新索引
 *   node scripts/kb.mjs search <query> [<repo>] [--limit N] [--kind <k>] [--prefix <p>] [--mission <id>]
 *   node scripts/kb.mjs status [<repo>]
 *
 * 参数位置无关：`index ~/repo`、`search 登录 ~/repo` 都可以；`--help` 看用法。
 * exit: 0 成功；1 缺索引/检索失败；2 用法错误
 */

import path from 'node:path'
import process from 'node:process'
import { gitFingerprint, resolveLayout } from '../packages/dsh-eng-core/dist/index.js'
import { DEFAULT_SOURCES, resolveConfig } from '../packages/dsh-knowledge-base/dist/config.js'
import { buildIndex, indexDirOf, loadIndex, stalenessOf } from '../packages/dsh-knowledge-base/dist/index-store.js'
import { searchIndex } from '../packages/dsh-knowledge-base/dist/search.js'

const USAGE = `usage:
  node scripts/kb.mjs index  [<repo>] [--force] [--source <id>]...
  node scripts/kb.mjs search <query> [<repo>] [--limit N] [--kind spec|adr|trail|plan|docs|code] [--prefix <path>] [--mission <id>]
  node scripts/kb.mjs status [<repo>]

source ids: ${DEFAULT_SOURCES.map((s) => s.id).join(', ')}`

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(argv.length === 0 ? 2 : 0)
}
const action = argv[0]
const flag = (name) => {
    const i = argv.indexOf(name)
    return i < 0 ? undefined : argv[i + 1]
}
const flags = (name) => argv.map((a, i) => (a === name ? argv[i + 1] : undefined)).filter((v) => v !== undefined)
const positional = argv.slice(1).filter((a, i) => !a.startsWith('--') && !['--limit', '--kind', '--prefix', '--mission', '--source'].includes(argv[i]))
const cwd = path.resolve(action === 'search' ? (positional[1] ?? process.cwd()) : (positional[0] ?? process.cwd()))

const config = resolveConfig({})
const layout = resolveLayout(cwd)
const dir = indexDirOf(cwd, config)

if (action === 'index') {
    const result = buildIndex({ cwd, layout, config, now: Date.now(), force: argv.includes('--force'), only: flags('--source') })
    const lines = [`# 知识库索引${result.changed ? '（已更新）' : '（未变化，未写盘）'}`, '', `工作区：${cwd}`, `索引：${path.relative(cwd, result.dir)}`, `指纹：${result.fingerprint.head ?? '(非 git)'}${result.fingerprint.dirty ? ' (dirty)' : ''}`]
    for (const report of result.reports) {
        lines.push(`- ${report.kind}（${report.id}）：文档 ${report.documents}、分块 ${report.chunks}${report.skipped.length === 0 ? '' : `、跳过 ${report.skipped.length}`}`)
        for (const skip of report.skipped.slice(0, 5)) lines.push(`    · 跳过 ${skip.path}：${skip.reason}`)
        if (report.skipped.length > 5) lines.push(`    · …另有 ${report.skipped.length - 5} 个跳过项`)
    }
    for (const problem of result.problems.slice(0, 5)) lines.push(`⚠️ ${problem.message}`)
    lines.push('', `下一步：node scripts/kb.mjs search "<问题关键词>" ${cwd === process.cwd() ? '' : cwd}`.trimEnd())
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exit(0)
}

const loaded = loadIndex(dir)
if (loaded.manifest === undefined) {
    process.stderr.write(`没有索引（${path.relative(cwd, dir)}/manifest.json 不存在）——先跑：node scripts/kb.mjs index${cwd === process.cwd() ? '' : ` ${cwd}`}\n`)
    process.exit(1)
}

if (action === 'status') {
    const staleness = stalenessOf(loaded.manifest.fingerprint, gitFingerprint(cwd))
    const lines = ['# 知识库现状', '', `工作区：${cwd}`, `构建时间：${new Date(loaded.manifest.builtAt).toISOString()}`, `索引指纹：${loaded.manifest.fingerprint?.head ?? '(非 git)'}`, `分块：${loaded.manifest.totals?.chunks ?? '?'}；文档：${loaded.manifest.totals?.documents ?? '?'}`]
    if (staleness.stale || staleness.unknown === true) lines.push(`⚠️ 新鲜度：${staleness.reason ?? '(未知)'}`)
    for (const line of loaded.problems.slice(0, 5)) lines.push(`⚠️ ${line.message}`)
    lines.push('', '说明：这是**词法**索引（BM25 + CJK 二元组），不是嵌入检索；回答需带引用。')
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exit(0)
}

if (action !== 'search') {
    process.stderr.write(`未知动作 "${action}"\n${USAGE}\n`)
    process.exit(2)
}
const query = positional[0]
if (query === undefined || query.trim() === '') {
    process.stderr.write(`search 需要一个查询词\n${USAGE}\n`)
    process.exit(2)
}
const limitRaw = Number(flag('--limit') ?? 10)
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), config.search.maxLimit) : config.search.limit
const outcome = searchIndex({
    chunks: loaded.chunks,
    postings: loaded.postings,
    query,
    limit,
    maxLimit: config.search.maxLimit,
    boosts: config.search.fieldBoosts,
    tokenizer: config.tokenizer,
    ...(flag('--kind') === undefined ? {} : { kinds: [flag('--kind')] }),
    ...(flag('--prefix') === undefined ? {} : { pathPrefix: flag('--prefix') }),
    ...(flag('--mission') === undefined ? {} : { missionId: flag('--mission') }),
})
const lines = [`# 知识库检索：${query}`, '', `工作区：${cwd}`, `命中 ${outcome.hits.length} 条（索引构建于 ${new Date(loaded.manifest.builtAt).toISOString()}）`]
{
    const staleness = stalenessOf(loaded.manifest.fingerprint, gitFingerprint(cwd))
    if (staleness.stale) lines.splice(2, 0, `⚠️ 索引陈旧：可能漏掉最近的改动（${staleness.reason ?? '早于当前指纹'}），先重跑 index`)
}
if (outcome.hits.length === 0) lines.push('', '索引里没有匹配——如实说"索引里没有"，不要据此猜答案。')
for (const [index, hit] of outcome.hits.entries()) {
    const chunk = hit.chunk
    lines.push('', `## ${index + 1}. ${chunk.kind} ${chunk.path}:${chunk.from}-${chunk.to}（得分 ${hit.score.toFixed(2)}）`)
    if (chunk.title !== undefined && chunk.title !== '') lines.push(`标题：${chunk.title}`)
    lines.push(`命中原因：${hit.reasons.map((r) => `${r.field}（${r.tokens.slice(0, 4).join('、')}${r.tokens.length > 4 ? '…' : ''}）`).join('；')}${hit.exactIds.length === 0 ? '' : `；精确命中 id：${hit.exactIds.join('、')}`}`)
    lines.push('```', hit.snippet, '```')
}
process.stdout.write(`${lines.join('\n')}\n`)

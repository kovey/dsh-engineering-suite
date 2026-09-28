#!/usr/bin/env node
/**
 * archive-missions.mjs — 归档旧的 mission（人/CI 入口）。
 *
 * 台账只增不减：每个 mission 的规格/阶段/门禁/证据/回执都留在
 * `.dsh/missions/<id>/`。这对可审计性是正确默认，对治理了一年的仓库是错的——
 * 于是有了这个脚本：把**已交付且不在最新窗口内**的 mission 移到
 * `.dsh/archive/<年-月>/<id>/`，并往 `.dsh/archive/index.jsonl` 追加一行记录，
 * 所以"这条 mission 去哪了"仍然可查。
 *
 * 三条保守规则（为什么不是"删掉旧的"）：
 *   1. 没有回执的 mission **默认不动**（可能还在途，它的证据必须留在原处）；
 *   2. 最新 N 个永远留下（人真正会读的是最近的上下文）；
 *   3. 只搬不删，且记录搬到哪；同 id 目标已存在时**拒绝**并让人处理，不合并覆盖。
 *
 * usage:
 *   node scripts/archive-missions.mjs --dry-run            # 只报告会搬什么
 *   node scripts/archive-missions.mjs --keep 20 --days 90  # 真正归档
 *   node scripts/archive-missions.mjs --workspace ~/repo --include-undelivered
 *   node scripts/archive-missions.mjs --json
 *
 * exit: 0 = 完成（含 dry-run）；1 = 归档失败（例如目标冲突）；2 = 用法错误
 */

import path from 'node:path'
import process from 'node:process'
import { archiveMissions, readArchiveIndex, resolveLayout } from '../packages/dsh-eng-core/dist/index.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const dryRun = args.includes('--dry-run')
const includeUndelivered = args.includes('--include-undelivered')
const numeric = (flag, fallback) => {
    const index = args.indexOf(flag)
    if (index < 0) return fallback
    const value = Number(args[index + 1])
    if (!Number.isFinite(value) || value < 0) {
        process.stderr.write(`${flag} 需要一个非负数字\n`)
        process.exit(2)
    }
    return value
}
const keep = numeric('--keep', 20)
const days = numeric('--days', 0)
const wsIndex = args.indexOf('--workspace')
const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--keep' && args[index - 1] !== '--days' && args[index - 1] !== '--workspace')
const cwd = path.resolve(wsIndex >= 0 ? args[wsIndex + 1] : (positional[0] ?? process.cwd()))

const layout = resolveLayout(cwd)
const before = readArchiveIndex(layout).length

let result
try {
    result = archiveMissions({ layout, keep, olderThanDays: days, includeUndelivered, dryRun })
} catch (error) {
    process.stderr.write(`归档失败：${error.message}\n`)
    process.exit(1)
}

if (json) {
    process.stdout.write(`${JSON.stringify({ cwd, keep, days, includeUndelivered, dryRun, candidates: result.plan.candidates, kept: result.plan.kept, moved: result.moved, archiveDir: result.archiveDir }, null, 2)}\n`)
    process.exit(0)
}

const lines = []
lines.push('# mission 归档')
lines.push('')
lines.push(`工作区：${cwd}`)
lines.push(`规则：保留最新 ${keep} 个${days > 0 ? `、只归档 ${days} 天前的` : ''}${includeUndelivered ? '、包含未交付' : '、未交付不动'}`)
lines.push(`结果：${result.moved.length} 个${dryRun ? '（dry-run，未改动）' : '已归档'}；保留 ${result.plan.kept.length} 个`)
if (result.plan.candidates.length > 0) {
    lines.push('')
    lines.push('## 归档对象')
    lines.push('')
    for (const candidate of result.plan.candidates) {
        const when = new Date(candidate.createdAt).toISOString().slice(0, 10)
        lines.push(`- ${candidate.missionId}（${when}，${(candidate.bytes / 1024).toFixed(0)} KiB）：${candidate.reason}`)
    }
}
const keptReasons = new Map()
for (const kept of result.plan.kept) keptReasons.set(kept.reason.replace(/（.*?）/, ''), (keptReasons.get(kept.reason.replace(/（.*?）/, '')) ?? 0) + 1)
if (keptReasons.size > 0) {
    lines.push('')
    lines.push('## 保留原因')
    lines.push('')
    for (const [reason, count] of keptReasons) lines.push(`- ${reason}：${count} 个`)
}
lines.push('')
lines.push(`归档目录：${path.relative(cwd, result.archiveDir)}（索引 ${path.relative(cwd, path.join(result.archiveDir, 'index.jsonl'))}，此前 ${before} 条）`)
if (dryRun && result.plan.candidates.length > 0) {
    lines.push('')
    lines.push(`下一步：确认清单后去掉 --dry-run 真正执行：bash scripts/archive-missions.sh --keep ${keep}${days > 0 ? ` --days ${days}` : ''}`)
}
process.stdout.write(`${lines.join('\n')}\n`)

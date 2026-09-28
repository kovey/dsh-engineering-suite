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
 *   node scripts/archive-missions.mjs --dry-run --json    # 只看不动 + 机器可读
 *
 * exit: 0 = 完成（含 dry-run）；1 = 归档失败（例如目标冲突、台账逃出工作区）；2 = 用法错误
 *
 * 参数解析是**严格**的（2026-09 对抗式审计 C4）：无法识别的参数、缺值的参数、
 * 以及 "--keep --json" 这种"值本身就是下一个开关"的写法，一律打印用法并 exit 2。
 * 原实现用 `args.includes('--dry-run')` 逐个嗅探：`--dryrun`（少一个连字符）被
 * 静默忽略，于是本来"只看不动"的命令真的把 mission 搬出了 missions/、写了索引、
 * 退出码 0 —— 一个拼写错误造成的静默数据移动。危险命令不允许有"猜你的意思"。
 *
 * 台账的位置同样是**保守**的（审计 C5）：归档会 **移动** 证据，所以只有当
 * `.dsh/missions` 的真实路径确实落在工作区内时才动手。`missions` 是指向共享/
 * 外部台账的符号链接时，`rename` 会把外部的 mission 搬进本仓库的 archive/（实测
 * 外部目录被搬空）—— 这种情况拒绝执行并同时打印两个路径；工作区里根本没有
 * `.dsh/missions` 时，明确报"这个仓库还没有台账"并 exit 1，而不是含糊的"0 个"。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { archiveMissions, isReallyInside, readArchiveIndex, realTargetOf, resolveLayout } from '../packages/dsh-eng-core/dist/index.js'

const USAGE = `usage: node scripts/archive-missions.mjs [--dry-run] [--json] [--include-undelivered]
                                       [--keep N] [--days N] [--workspace <repo>]

  --dry-run               只报告会搬什么（默认：真正执行）
  --json                  机器可读输出（只换输出格式：要"只看不动"请加 --dry-run）
  --include-undelivered   未交付的 mission 也归档（默认不动：可能还在途）
  --keep N                保留最新 N 个（默认 20，0 = 只按其它规则）
  --days N                只归档 N 天前的（默认 0 = 不限）
  --workspace <repo>      目标仓库（默认当前目录；也可写成唯一的位置参数）
  -h, --help              打印本用法
`

/** Print the usage and exit 2: an unrecognised argument must never be ignored. */
function usageError(message) {
    process.stderr.write(`archive-missions: ${message}\n\n${USAGE}`)
    process.exit(2)
}

const argv = process.argv.slice(2)
let json = false
let dryRun = false
let includeUndelivered = false
let keep = 20
let days = 0
let workspace

/** The value of a flag: required, and never another flag. */
function valueOf(index, flag) {
    const value = argv[index + 1]
    if (value === undefined) usageError(`${flag} 需要一个值`)
    if (value.startsWith('-')) usageError(`${flag} 需要一个值，但拿到的是开关 ${JSON.stringify(value)}`)
    return value
}

function numberOf(raw, flag) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) usageError(`${flag} 需要一个非负数字（拿到 ${JSON.stringify(raw)}）`)
    return value
}

for (let index = 0; index < argv.length; ) {
    const arg = argv[index]
    if (arg === '--dry-run') { dryRun = true; index += 1; continue }
    if (arg === '--json') { json = true; index += 1; continue }
    if (arg === '--include-undelivered') { includeUndelivered = true; index += 1; continue }
    if (arg === '--keep') { keep = numberOf(valueOf(index, arg), arg); index += 2; continue }
    if (arg === '--days') { days = numberOf(valueOf(index, arg), arg); index += 2; continue }
    if (arg === '--workspace') {
        if (workspace !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(workspace)}）`)
        workspace = valueOf(index, arg)
        index += 2
        continue
    }
    if (arg.startsWith('--workspace=')) {
        if (workspace !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(workspace)}）`)
        workspace = arg.slice('--workspace='.length)
        if (workspace === '') usageError('--workspace= 需要一个路径')
        index += 1
        continue
    }
    if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); process.exit(0) }
    if (arg.startsWith('-')) usageError(`无法识别的参数 ${JSON.stringify(arg)}`)
    if (workspace !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(workspace)}，又给了 ${JSON.stringify(arg)}）`)
    workspace = arg
    index += 1
}

const cwd = path.resolve(workspace ?? process.cwd())
const layout = resolveLayout(cwd)

// Containment first, mutation never (audit C5). Both checks run before anything
// is planned or read, so a refusal cannot have moved a byte.
if (!fs.existsSync(layout.missionsDir)) {
    process.stderr.write(
        `archive-missions: ${cwd} 还没有台账：${layout.missionsDir} 不存在。\n` +
            `  这不是"0 个可归档"——是这个仓库还没有 mission（先跑一次工程套件）。\n`,
    )
    process.exit(1)
}
if (!isReallyInside(cwd, layout.missionsDir)) {
    process.stderr.write(
        `archive-missions: 拒绝执行 —— missions 台账不在工作区内：\n` +
            `  工作区      : ${realTargetOf(cwd)}\n` +
            `  台账真实路径: ${realTargetOf(layout.missionsDir)}\n` +
            `归档会把台账里的 mission **移出**它的真实目录（共享/外部台账会被搬空）。\n` +
            `请直接在那个目录所在的工作区里运行本命令。\n`,
    )
    process.exit(1)
}

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

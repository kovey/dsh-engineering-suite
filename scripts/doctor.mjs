#!/usr/bin/env node
/**
 * doctor.mjs — 套件自检（人/CI 入口）。
 *
 * 与插件里的 `suite_status` 共用 `dsh-eng-core` 的同一份判定（`checkWorkspace` /
 * `renderDoctor`），区别只在于：这里没有活宿主，所以只能报**离线可判定**的部分
 * （配置、台账、指纹陷阱、footprint），运行时事实（哪些插件挂载、当前阶段、待审批、
 * 通道可用性）由插件在会话里补。
 *
 * usage:
 *   node scripts/doctor.mjs                      # 检查当前目录
 *   node scripts/doctor.mjs --workspace ~/repo   # 检查指定仓库
 *   node scripts/doctor.mjs --json ~/repo        # 机器可读（CI 用）
 *
 * exit: 0 = 必需项全部就绪；1 = 有必需项未就绪；2 = 用法错误
 *
 * 参数解析是严格的（2026-09 对抗式审计 C6）：`--workspace` 缺值、`--workspace=`
 * 空值、以及任何不认识的开关都打印用法并 exit 2。原实现里 `--workspace` 后面没跟
 * 值时会**回落到 process.cwd()**：在一个健康的仓库里跑 `doctor.sh --workspace`，
 * 它会拿当前目录做检查并 exit 0 —— 用户以为检查了目标仓库，其实拿到了"全绿"（而
 * `--workspace=<p>` 这种写法被静默忽略）。默认值只能来自"没写这个开关"，
 * 不能来自"写了但没生效"。
 */

import path from 'node:path'
import process from 'node:process'
import { checkWorkspace, renderDoctor } from '../packages/dsh-eng-core/dist/index.js'

const USAGE = `usage: node scripts/doctor.mjs [--json] [--workspace <repo>] [<repo>]

  --json              机器可读输出（CI 用）
  --workspace <repo>  检查指定仓库（默认当前目录；也可写成位置参数）
  -h, --help          打印本用法
`

/** Print the usage and exit 2: an unrecognised or incomplete argument is not "the default". */
function usageError(message) {
    process.stderr.write(`doctor: ${message}\n\n${USAGE}`)
    process.exit(2)
}

const argv = process.argv.slice(2)
let json = false
let target

for (let index = 0; index < argv.length; ) {
    const arg = argv[index]
    if (arg === '--json') { json = true; index += 1; continue }
    if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); process.exit(0) }
    if (arg === '--workspace') {
        const value = argv[index + 1]
        if (value === undefined) usageError('--workspace 需要一个路径')
        if (value.startsWith('-')) usageError(`--workspace 需要一个路径，但拿到的是开关 ${JSON.stringify(value)}`)
        if (target !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(target)}）`)
        target = value
        index += 2
        continue
    }
    if (arg.startsWith('--workspace=')) {
        const value = arg.slice('--workspace='.length)
        if (value === '') usageError('--workspace= 需要一个路径')
        if (target !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(target)}）`)
        target = value
        index += 1
        continue
    }
    if (arg.startsWith('-')) usageError(`无法识别的参数 ${JSON.stringify(arg)}`)
    if (target !== undefined) usageError(`只能指定一个工作区（已有 ${JSON.stringify(target)}，又给了 ${JSON.stringify(arg)}）`)
    target = arg
    index += 1
}

const cwd = path.resolve(target ?? process.cwd())

const report = checkWorkspace({ cwd })
if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
    process.stdout.write(`${renderDoctor(report)}\n`)
}
process.exit(report.blockers.length === 0 ? 0 : 1)

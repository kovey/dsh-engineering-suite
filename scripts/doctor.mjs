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
 *   node scripts/doctor.mjs --json               # 机器可读（CI 用）
 *
 * exit: 0 = 必需项全部就绪；1 = 有必需项未就绪；2 = 脚本自身失败
 */

import path from 'node:path'
import process from 'node:process'
import { checkWorkspace, renderDoctor } from '../packages/dsh-eng-core/dist/index.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
// `--workspace <p>` and a bare positional both name the workspace, in any order
// and together with `--json` (the first version checked `--json` first and
// silently ignored the path that followed it — it then reported the CURRENT
// directory, which reads like the target repo is empty).
const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--workspace')
const flagIndex = args.findIndex((arg) => arg === '--workspace')
const target = flagIndex >= 0 ? args[flagIndex + 1] : positional[0]
const cwd = path.resolve(target ?? process.cwd())

const report = checkWorkspace({ cwd })
if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
    process.stdout.write(`${renderDoctor(report)}\n`)
}
process.exit(report.blockers.length === 0 ? 0 : 1)

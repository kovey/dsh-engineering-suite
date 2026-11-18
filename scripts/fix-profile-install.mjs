#!/usr/bin/env node
/**
 * Make a dsh profile's install actually produce `dist/` — and prove it did.
 *
 * Why this exists (a real 0.8.13 upgrade): the profile had the package and the
 * bundle links, but `packages/*\/dist` held zero `index.js` and startup failed to
 * resolve a dozen internal plugins. The install had exited 0. Two lines did it,
 * and neither is visible in the install log:
 *   - `allowBuilds` carried an auto-inserted placeholder
 *     (`protobufjs: set this to true or false`), so pnpm could not decide whether
 *     to run that build script;
 *   - `strictDepBuilds: false` demoted "the suite's `prepare` was blocked" to a
 *     warning — the one setting that turns a missing artifact into a green install.
 *
 * The run, in order: (1) rewrite `pnpm-workspace.yaml` per
 * `scripts/profile-install-workspace.mjs`; (2) `pnpm install` in the profile, then
 * run the suite's `prepare-install.mjs` EXPLICITLY (a dependency's own `prepare`
 * or a cached root `postinstall` is never trusted to have produced the artifacts);
 * (3) the three checks from `scripts/profile-install-checks.mjs`. Any failure exits
 * non-zero and prints the backups that restore the previous config.
 *
 * usage: node scripts/fix-profile-install.mjs [--profile DIR] [options]
 *   (no flag)            dry run: planned edits + current state, writes nothing.
 *   --apply              write the config, install, prepare, then verify.
 *   --check              read-only: the three acceptance checks only.
 *   --skip-install       with --apply: write the config only (no pnpm, no prepare);
 *                        the checks still run, so it cannot pass without dist.
 *                        Used by scripts/selftest-ops.sh.
 *   --profile DIR        profile directory (default ~/.dsh/profiles/tui).
 *   --expect-version V   expected suite version (default: the installed one).
 *   -h, --help           this text.
 *
 * exit: 0 = configured and verified (or a dry run / --help); 1 = a step or an
 *       acceptance check failed; 2 = usage error.
 *
 * @module scripts/fix-profile-install
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acceptance, run } from './profile-install-checks.mjs'
import { planWorkspaceFix, SUITE } from './profile-install-workspace.mjs'

const DEFAULT_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'tui')
const USAGE = `usage: node scripts/fix-profile-install.mjs [--profile DIR] [options]

  (no flag)           dry run: planned edits + current state, writes nothing
  --apply             write the config, pnpm install, prepare-install.mjs, verify
  --check             read-only: the three acceptance checks only
  --skip-install      with --apply: config only (no pnpm, no prepare); checks still run
  --profile DIR       profile directory (default ${DEFAULT_PROFILE})
  --expect-version V  expected suite version (default: the installed one)
  -h, --help          this text

exit: 0 = done/verified; 1 = a step or an acceptance check failed; 2 = usage error.`

/** Set once the config was written; a later failure prints it as the rollback path. */
let rollback = ''

function log(message) {
    process.stdout.write(`${message}\n`)
}

function fail(message) {
    process.stderr.write(`fix-profile-install: ${message}\n`)
    if (rollback !== '') process.stderr.write(`${rollback}\n`)
    process.exit(1)
}

function usageError(message) {
    process.stderr.write(`fix-profile-install: ${message}\n\n${USAGE}\n`)
    process.exit(2)
}

/** Best effort: a temp file we could not create must not throw a second error. */
function removeQuietly(file) {
    try {
        fs.rmSync(file, { force: true })
    } catch {
        /* the write failure itself is what gets reported */
    }
}

function parseArgs(argv) {
    const options = { apply: false, check: false, skipInstall: false, help: false, profile: DEFAULT_PROFILE }
    const valued = { '--profile': 'profile', '--expect-version': 'expectVersion' }
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        if (arg === '--apply') options.apply = true
        else if (arg === '--check') options.check = true
        else if (arg === '--skip-install') options.skipInstall = true
        else if (arg === '-h' || arg === '--help') options.help = true
        else if (valued[arg] !== undefined) {
            const value = argv[index + 1]
            if (value === undefined || value.startsWith('-')) usageError(`${arg} 需要一个值`)
            options[valued[arg]] = value
            index += 1
        } else usageError(`未知参数：${arg}`)
    }
    if (options.apply && options.check) usageError('--apply 与 --check 不能同时使用：--check 是只读验收')
    return options
}

function planFor(workspacePath) {
    try {
        return planWorkspaceFix(readWorkspace(workspacePath))
    } catch (error) {
        fail(`无法规划 pnpm-workspace.yaml 的修复：${error.message}`)
    }
}

function describeChange(change) {
    if (change.action === 'delete') return `删除第 ${change.line} 行 ${JSON.stringify(change.before)} —— ${change.note}`
    if (change.action === 'insert') return `新增（${change.line}）${JSON.stringify(change.after)} —— ${change.note}`
    return `第 ${change.line} 行 ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)} —— ${change.note}`
}

function reportPlan(workspacePath, plan) {
    log(`\n[1/3] pnpm-workspace.yaml: ${workspacePath}`)
    if (plan.changes.length === 0) log('  已是目标状态（无需修改）')
    else {
        log(`  将修改 ${plan.changes.length} 处：`)
        for (const change of plan.changes) log(`  - ${describeChange(change)}`)
    }
    for (const entry of plan.kept) log(`  保留 allowBuilds 的 ${entry}`)
    if (plan.notBuilt.length > 0) {
        log(`  这些依赖不会被构建（显式 false，不是占位符）：${plan.notBuilt.join(', ')}`)
    }
}

function readWorkspace(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

/** Write through a temp file so a sandbox denial leaves the original untouched. */
function writeWithBackup(file, text) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.bak-${stamp}`
    const temp = `${file}.tmp-${process.pid}`
    const existed = fs.existsSync(file)
    try {
        if (existed) fs.copyFileSync(file, backup)
        fs.writeFileSync(temp, text)
        fs.renameSync(temp, file)
    } catch (error) {
        removeQuietly(temp)
        fail(
            `无法写入 ${file}（${error.code ?? 'error'}: ${error.message}）。\n` +
                '这通常是因为本会话只允许写工作区：请在能写 ~/.dsh 的真实终端里运行 --apply。\n' +
                `原文件未被修改；备份：${fs.existsSync(backup) ? backup : '未创建'}`,
        )
    }
    log(existed ? `  已写入；备份：${backup}` : `  已创建（此前不存在，无备份）：${file}`)
    return existed ? backup : undefined
}

function rollbackHint(paths, backups, wrote) {
    const lines = ['', '回滚（备份由本次运行创建，prepare-install 幂等、重跑不会重复软链）：']
    if (!wrote) lines.push('  （本次没有改配置，无需还原 pnpm-workspace.yaml）')
    else if (backups.length === 0) lines.push(`  rm '${paths.workspace}'（本次新建，此前不存在）`)
    else lines.push(`  cp '${backups[0]}' '${paths.workspace}'`)
    lines.push(`  cd '${paths.profile}' && pnpm install`)
    return lines.join('\n')
}

function reportOutput(output, maxLines = 20) {
    const lines = output.split('\n').filter((line) => line.trim() !== '')
    for (const line of lines.slice(-maxLines)) log(`  | ${line}`)
}

function installAndPrepare(paths) {
    const install = run('pnpm', ['install'], paths.profile)
    if (install.error !== undefined) fail(`无法执行 pnpm install：${install.error.message}（PATH 里没有 pnpm？）`)
    log(`\n[2/3] pnpm install（cwd=${paths.profile}）→ exit ${install.status}`)
    reportOutput(install.output)
    if (install.status !== 0) {
        fail(
            'pnpm install 失败。若它点名"被忽略的构建脚本"，那是 strictDepBuilds 默认 true 的预期行为：' +
                '把点名的依赖写进 allowBuilds 并明确 true（要构建）或 false（不构建）',
        )
    }
    const script = path.join(paths.profile, 'node_modules', SUITE, 'scripts', 'prepare-install.mjs')
    if (!fs.existsSync(script)) fail(`安装产物里没有 ${script}：套件包没有装进来（先看 pnpm install 的输出）`)
    const prepare = run(process.execPath, [script], paths.profile)
    log(`prepare-install.mjs（显式执行，不依赖 pnpm 是否跑了 prepare/postinstall）→ exit ${prepare.status}`)
    reportOutput(prepare.output)
    if (prepare.status !== 0) fail('prepare-install.mjs 失败：dist 没有被生成（这是安装失败，不是警告）')
}

function reportAcceptance(result) {
    log('\n[3/3] 验收（版本 / dist / 解析路径）：')
    for (const line of result.lines) log(`  ${line}`)
    if (result.ok) return
    log('\n验收未通过：')
    for (const problem of result.problems) log(`  - ${problem}`)
}

function reportCurrentState(options, paths) {
    const result = acceptance(paths.profile, options.expectVersion)
    log('\n当前状态（未被本脚本改动）：')
    for (const line of result.lines) log(`  ${line}`)
    if (!result.ok) log('  （当前未通过验收——这正是 --apply 要修的问题）')
}

function dryRun(options, paths) {
    reportPlan(paths.workspace, planFor(paths.workspace))
    reportCurrentState(options, paths)
    log('\n这是 dry-run：什么都没有写。加 --apply 修配置并安装；只想看验收结果用 --check。')
}

function verifyOnly(options, paths) {
    const result = acceptance(paths.profile, options.expectVersion)
    reportAcceptance(result)
    process.exit(result.ok ? 0 : 1)
}

function applyPlan(options, paths) {
    const source = readWorkspace(paths.workspace)
    const plan = planFor(paths.workspace)
    reportPlan(paths.workspace, plan)
    const wrote = plan.text !== source
    const backups = wrote ? [writeWithBackup(paths.workspace, plan.text)].filter(Boolean) : []
    rollback = rollbackHint(paths, backups, wrote)
    if (options.skipInstall) log('\n[2/3] 跳过 pnpm install 与 prepare-install（--skip-install）')
    else installAndPrepare(paths)
    const result = acceptance(paths.profile, options.expectVersion)
    reportAcceptance(result)
    if (!result.ok) fail('验收未通过：安装没有产出可用的 dist（退出非零，绝不把没有 dist 的安装当成成功）')
    log('\n✅ 配置已修、dist 已生成、三条验收全部通过')
}

function main() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        log(USAGE)
        return
    }
    const profile = path.resolve(options.profile)
    const paths = { profile, workspace: path.join(profile, 'pnpm-workspace.yaml') }
    if (!fs.existsSync(path.join(profile, 'package.json'))) {
        usageError(`${profile}/package.json 不存在：--profile 指向的不是一个 dsh profile`)
    }
    log(`profile: ${profile}`)
    if (options.check) verifyOnly(options, paths)
    else if (options.apply) applyPlan(options, paths)
    else dryRun(options, paths)
}

main()

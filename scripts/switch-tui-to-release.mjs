#!/usr/bin/env node
/**
 * Point a dsh profile at the RELEASED suite instead of the development tree.
 *
 * The profile already has a `postinstall` hook, but it needs two things to work:
 * a compiler and the Node type declarations as the profile's own
 * devDependencies (a git dependency's devDependencies are only present while its
 * `prepare` runs), and - for the case where pnpm decides to run the dependency's
 * own `prepare` - an `allowBuilds` entry in the repository-URL form, because a
 * bare package name never approves a git dependency.
 *
 * Defaults to a dry run; `--apply` writes, installs and verifies. Nothing outside
 * the profile's `package.json`, `pnpm-workspace.yaml` and the backups is touched.
 *
 * @module scripts/switch-tui-to-release
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const profile = readOption('--profile') ?? path.join(os.homedir(), '.dsh', 'profiles', 'tui')

const DEV_DEPENDENCIES = { '@types/node': '^26.6.6', typescript: '^5.9.3' }
const REPO_URL_KEY = 'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git'
const POSTINSTALL = 'node node_modules/dsh-engineering-suite/scripts/prepare-install.mjs'
const EXPECTED_VERSION = readOption('--expect-version') ?? '0.8.11'
// A bare `github:owner/repo` spec lets the lockfile keep whatever commit it first
// resolved - which is how a profile stays on a release that predates the very
// hook the postinstall calls.
const SUITE_SPEC = readOption('--spec') ?? `github:kovey/dsh-engineering-suite#v${EXPECTED_VERSION}`

function readOption(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
    process.stderr.write(`switch-tui-to-release: ${message}\n`)
    process.exit(1)
}

const manifestPath = path.join(profile, 'package.json')
const workspacePath = path.join(profile, 'pnpm-workspace.yaml')
if (!fs.existsSync(manifestPath)) fail(`${manifestPath} 不存在：--profile 指向的不是一个 dsh profile`)

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const workspace = fs.existsSync(workspacePath) ? fs.readFileSync(workspacePath, 'utf8') : 'packages:\n  - .\n'

// --- what would change -------------------------------------------------------
const planned = []
for (const [name, range] of Object.entries(DEV_DEPENDENCIES)) {
    if (manifest.devDependencies?.[name] === range) continue
    planned.push(`devDependencies.${name} = ${range}`)
}
if (manifest.scripts?.postinstall !== POSTINSTALL) planned.push(`scripts.postinstall = ${POSTINSTALL}`)
if (manifest.dependencies?.['dsh-engineering-suite'] !== SUITE_SPEC) {
    planned.push(`dependencies['dsh-engineering-suite'] = ${SUITE_SPEC}`)
}
const hasRepoKey = new RegExp(`^\\s{2}'?${REPO_URL_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?:\\s*true`, 'm').test(workspace)
if (!hasRepoKey) planned.push(`pnpm-workspace.yaml: allowBuilds['${REPO_URL_KEY}'] = true`)
// pnpm >=11 aborts the whole install when ANY dependency has an unreviewed build
// script (protobufjs, pulled in by the Feishu SDK, is one). The suite's dist is
// produced by the profile's own postinstall, which is a root script and always
// runs - so a warning is the honest setting here, not a blanket approval.
const hasStrictOff = /^strictDepBuilds:\s*false\s*$/m.test(workspace)
if (!hasStrictOff) planned.push('pnpm-workspace.yaml: strictDepBuilds = false')

process.stdout.write(`profile: ${profile}\n`)
if (planned.length === 0) {
    process.stdout.write('配置已是目标状态（无需修改）\n')
} else {
    process.stdout.write(`将修改 ${planned.length} 处：\n${planned.map((line) => `  - ${line}`).join('\n')}\n`)
}

/** Backup once per run, timestamped, never overwriting an older copy. */
function backup(file) {
    if (!fs.existsSync(file)) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${file}.bak-${stamp}`
    fs.copyFileSync(file, target)
    return target
}

if (!apply) {
    process.stdout.write('\n这是 dry-run，什么都没有写。加 --apply 执行（会先备份，再 pnpm install）。\n')
    process.exit(0)
}

// --- apply ------------------------------------------------------------------
const backups = [backup(manifestPath), backup(workspacePath)].filter(Boolean)
manifest.devDependencies = { ...(manifest.devDependencies ?? {}), ...DEV_DEPENDENCIES }
manifest.scripts = { ...(manifest.scripts ?? {}), postinstall: POSTINSTALL }
manifest.dependencies = { ...(manifest.dependencies ?? {}), 'dsh-engineering-suite': SUITE_SPEC }
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

let nextWorkspace = workspace
if (!hasRepoKey) {
    const line = `  '${REPO_URL_KEY}': true`
    nextWorkspace = /^allowBuilds:\s*$/m.test(workspace)
        ? workspace.replace(/^allowBuilds:\s*$/m, `allowBuilds:\n${line}`)
        : `${workspace.replace(/\n*$/, '\n')}\nallowBuilds:\n${line}\n`
}
if (!hasStrictOff) nextWorkspace = `${nextWorkspace.replace(/\n*$/, '\n')}\nstrictDepBuilds: false\n`
if (nextWorkspace !== workspace) fs.writeFileSync(workspacePath, nextWorkspace)
process.stdout.write(`已写入配置；备份：${backups.map((file) => path.basename(file)).join(', ') || '(无，首次创建)'}\n`)

// --- install ----------------------------------------------------------------
const install = spawnSync('pnpm', ['install'], { cwd: profile, stdio: 'inherit' })
if (install.status !== 0) {
    fail(`pnpm install 失败（exit ${install.status}）；回滚：把上面列出的 .bak-* 复制回原位，再 pnpm install`)
}

// --- verify -----------------------------------------------------------------
const suiteDir = path.join(profile, 'node_modules', 'dsh-engineering-suite')
if (!fs.existsSync(suiteDir)) fail(`${suiteDir} 不存在：安装没有产生这个包`)

const version = JSON.parse(fs.readFileSync(path.join(suiteDir, 'package.json'), 'utf8')).version
const dists = fs
    .readdirSync(path.join(suiteDir, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(suiteDir, 'packages', entry.name, 'dist', 'index.js')))
const resolution = spawnSync(
    process.execPath,
    ['-e', "console.log(require.resolve('dsh-spec-gate', {paths:[process.argv[1]]}))", profile],
    { encoding: 'utf8' },
)
const resolved = resolution.stdout.trim()

const problems = []
if (version !== EXPECTED_VERSION) problems.push(`版本是 ${version}，期望 ${EXPECTED_VERSION}`)
if (dists.length !== 16) problems.push(`dist 只有 ${dists.length} 个，期望 16`)
if (!resolved.startsWith(path.join(profile, 'node_modules'))) problems.push(`dsh-spec-gate 解析到 ${resolved || '(未解析)'}，不在 profile 的 node_modules 下`)

process.stdout.write(`\n验收：version=${version}、dist=${dists.length}/16、resolve=${resolved}\n`)
if (problems.length > 0) {
    process.stderr.write(`验收未通过：\n${problems.map((line) => `  - ${line}`).join('\n')}\n`)
    process.stderr.write('排查：cd ' + profile + ' && pnpm install；仍失败时看 node scripts/../dsh-engineering-suite/scripts/prepare-install.mjs 的输出\n')
    process.exit(1)
}
process.stdout.write('✅ 该 profile 现在从发布版安装运行（dist 由 postinstall 生成）\n')

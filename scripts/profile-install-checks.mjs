/**
 * The three acceptance checks of `fix-profile-install.mjs`, kept separate because
 * they are the part that must never be lenient: an install that skipped a build
 * still exits 0, so "installed" has to be proven by artifacts.
 *
 *   - version: the installed suite matches `--expect-version` (default: itself);
 *   - dist: `packages/*\/dist/index.js` count equals the package count;
 *   - resolution: `dsh-spec-gate` resolves through the profile's own
 *     `node_modules` (a link to the dev tree would pass a weaker check).
 *
 * @module scripts/profile-install-checks
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SUITE } from './profile-install-workspace.mjs'

const BUNDLE_PROBE = "process.stdout.write(require.resolve('dsh-spec-gate', { paths: [process.argv[1]] }))"

/** One child process, with `stdout`+`stderr` joined for a bounded tail report. */
export function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
    return {
        status: result.status === null ? 1 : result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        error: result.error,
    }
}

function readSuiteVersion(suiteDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(suiteDir, 'package.json'), 'utf8')).version
    } catch {
        return undefined
    }
}

function versionCheck(suiteDir, expectVersion) {
    const version = readSuiteVersion(suiteDir)
    if (version === undefined) {
        return { line: '❌ 版本：套件包没有安装（缺 node_modules/dsh-engineering-suite/package.json）', problem: '套件包没有安装（缺 package.json）' }
    }
    const expected = expectVersion ?? version
    if (version === expected) return { line: `✅ 版本 ${version}（期望 ${expected}）` }
    return { line: `❌ 版本 ${version}（期望 ${expected}）`, problem: `版本是 ${version}，期望 ${expected}` }
}

function distState(suiteDir) {
    const packagesDir = path.join(suiteDir, 'packages')
    try {
        const names = fs
            .readdirSync(packagesDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, 'package.json')))
            .map((entry) => entry.name)
        const missing = names.filter((name) => !fs.existsSync(path.join(packagesDir, name, 'dist', 'index.js')))
        return { total: names.length, withDist: names.length - missing.length, missing }
    } catch {
        return { total: 0, withDist: 0, missing: [] }
    }
}

function distCheck(suiteDir) {
    const state = distState(suiteDir)
    if (state.total === 0) return { line: '❌ dist：套件包下没有任何包目录', problem: '套件包下没有任何包目录（安装不完整）' }
    if (state.withDist === state.total) return { line: `✅ dist ${state.withDist}/${state.total}` }
    const shown = state.missing.slice(0, 12).join(', ')
    const rest = state.missing.length > 12 ? ` 等 ${state.missing.length} 个` : ''
    return {
        line: `❌ dist ${state.withDist}/${state.total}（缺：${shown}${rest}）`,
        problem: `dist 只有 ${state.withDist}/${state.total}：${shown}${rest}`,
    }
}

/** True when `resolved` sits under the profile's `node_modules` (tmp dirs may be symlinked). */
function insideProfile(profile, resolved) {
    const roots = [path.join(profile, 'node_modules')]
    try {
        roots.push(path.join(fs.realpathSync(profile), 'node_modules'))
    } catch {
        /* an unreadable profile already failed the version check */
    }
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
}

function resolveCheck(profile) {
    const probe = run(process.execPath, ['-e', BUNDLE_PROBE, profile], profile)
    const resolved = probe.status === 0 ? probe.output.trim() : ''
    if (resolved === '') return { line: '❌ dsh-spec-gate：未解析（MODULE_NOT_FOUND）', problem: 'dsh-spec-gate 解析不到（bundle 软链没有建出来）' }
    if (insideProfile(profile, resolved)) return { line: `✅ dsh-spec-gate → ${resolved}` }
    return {
        line: `❌ dsh-spec-gate → ${resolved}（在 profile 之外）`,
        problem: `dsh-spec-gate 解析到 ${resolved}，不在 profile 的 node_modules 下`,
    }
}

/** The three checks; `ok` is false when any of them reported a problem. */
export function acceptance(profile, expectVersion) {
    const suiteDir = path.join(profile, 'node_modules', SUITE)
    const checks = [versionCheck(suiteDir, expectVersion), distCheck(suiteDir), resolveCheck(profile)]
    return {
        ok: checks.every((check) => check.problem === undefined),
        lines: checks.map((check) => check.line),
        problems: checks.filter((check) => check.problem !== undefined).map((check) => check.problem),
    }
}

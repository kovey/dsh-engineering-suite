#!/usr/bin/env node
/**
 * Build the suite's `dist/` directories at INSTALL time.
 *
 * `dist/` is deliberately not in the repository (see `.gitignore`): a release is
 * source + a tag, and the artifact is produced where it is consumed. This script
 * is the `prepare` hook that makes that work for a `github:` dependency, where
 * the harness installs the package into a profile's `node_modules` and then
 * expects the bundle names (`dsh-spec-gate`, …) to resolve.
 *
 * Three jobs, in order:
 *   1. link the packages to each other INSIDE the package (`packages/x/node_modules/dsh-y`),
 *      because a fresh checkout has no `node_modules` and the sources import
 *      `dsh-eng-core` by name;
 *   2. compile every package with the host's own `typescript`;
 *   3. when this package sits in a profile's `node_modules`, link each bundle
 *      name next to it so the harness can resolve `dsh-<name>`.
 *
 * Failure is never silent: a missing compiler or a package that does not compile
 * exits non-zero and removes the `dist/` directories this run created, so the
 * next step cannot mistake a half-built tree for a built one.
 *
 * @module scripts/prepare-install
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = path.join(ROOT, 'packages')

const log = (message) => process.stdout.write(`prepare-install: ${message}\n`)
const fail = (message) => {
    process.stderr.write(`prepare-install: ${message}\n`)
    process.exit(1)
}

/** Every package directory, sorted: the order is used only for reporting. */
function packageNames() {
    return fs
        .readdirSync(PACKAGES, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
}

/**
 * Compile order: `scripts/package-order.py` knows the dependency graph; when it
 * cannot run (no python3), fall back to eng-core first, everything else sorted —
 * which is correct today because every package depends only on eng-core.
 */
function buildOrder(names) {
    const script = path.join(ROOT, 'scripts', 'package-order.py')
    if (fs.existsSync(script)) {
        const result = spawnSync('python3', [script, ROOT], { encoding: 'utf8' })
        if (result.status === 0) {
            const order = result.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line !== '')
                .map((line) => path.basename(line))
                .filter((name) => names.includes(name))
            if (order.length === names.length) return order
        }
    }
    return [...names.filter((name) => name === 'dsh-eng-core'), ...names.filter((name) => name !== 'dsh-eng-core')]
}

/**
 * The compiler is a devDependency of this package, so an install places it either
 * inside the package (`node_modules/typescript`) or next to it in the profile's
 * `node_modules` — both are legitimate, neither is guaranteed.
 */
function resolveTsc() {
    const candidates = [
        path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        path.join(path.dirname(ROOT), 'typescript', 'bin', 'tsc'),
        path.join(path.dirname(path.dirname(ROOT)), 'typescript', 'bin', 'tsc'),
    ]
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate
    }
    return undefined
}

/**
 * Give each package a `node_modules` of its own holding siblings by name.
 * A real directory in the way is an error: silently skipping it would compile
 * against something other than this checkout.
 */
function linkSiblings(names) {
    let created = 0
    for (const owner of names) {
        const dir = path.join(PACKAGES, owner, 'node_modules')
        fs.mkdirSync(dir, { recursive: true })
        for (const dependency of names) {
            if (dependency === owner) continue
            if (linkSibling(dir, dependency)) created += 1
        }
    }
    return created
}

/**
 * One sibling link. Returns true when it was created or repaired.
 * A real directory in the way is fatal: it would mean compiling against
 * something other than this checkout.
 */
function linkSibling(dir, dependency) {
    const link = path.join(dir, dependency)
    const target = path.join('..', '..', dependency)
    let existing
    try {
        existing = fs.lstatSync(link)
    } catch {
        fs.symlinkSync(target, link, 'dir')
        return true
    }
    if (!existing.isSymbolicLink()) {
        fail(`${path.relative(ROOT, link)} 是真实目录而不是软链：拒绝覆盖它（请先移除它再安装）`)
    }
    if (fs.readlinkSync(link) === target) return false
    fs.unlinkSync(link)
    fs.symlinkSync(target, link, 'dir')
    return true
}

/** Compile the packages; returns the ones that failed. */
function build(order, tsc) {
    const failed = []
    for (const name of order) {
        const project = path.join(PACKAGES, name, 'tsconfig.json')
        if (!fs.existsSync(project)) {
            failed.push(name)
            continue
        }
        const result = spawnSync(process.execPath, [tsc, '--project', project], { cwd: ROOT, encoding: 'utf8' })
        if (result.status !== 0) {
            process.stderr.write(`${name}: 编译失败\n${result.stdout ?? ''}${result.stderr ?? ''}`)
            failed.push(name)
        }
    }
    return failed
}

/**
 * A profile install puts this package at `<profile>/node_modules/dsh-engineering-suite`;
 * the bundles are bare names the harness resolves from `<profile>/node_modules`.
 * Link them, and never replace a real directory (it may be a deliberate install).
 */
function linkBundles(names) {
    const parent = path.dirname(ROOT)
    if (path.basename(parent) !== 'node_modules') return { linked: 0, skipped: [] }
    let linked = 0
    const skipped = []
    for (const name of names) {
        const link = path.join(parent, name)
        const target = path.join(ROOT, 'packages', name)
        let existing
        try {
            existing = fs.lstatSync(link)
        } catch {
            fs.symlinkSync(target, link, 'dir')
            linked += 1
            continue
        }
        if (!existing.isSymbolicLink()) {
            skipped.push(name)
            continue
        }
        if (fs.readlinkSync(link) !== target) {
            fs.unlinkSync(link)
            fs.symlinkSync(target, link, 'dir')
            linked += 1
        }
    }
    return { linked, skipped }
}

/** Remove the `dist/` directories this run created, so a failure leaves no half-artifact. */
function removeFresh(freshDists) {
    for (const dir of freshDists) {
        try {
            fs.rmSync(dir, { recursive: true, force: true })
        } catch {
            /* best effort: the exit code already says the install failed */
        }
    }
}

const names = packageNames()
if (names.length === 0) fail(`${PACKAGES} 下没有任何包：拒绝在什么都没构建的情况下报告成功`)

const tsc = resolveTsc()
if (tsc === undefined) {
    fail('找不到 typescript 编译器：请安装依赖（npm/pnpm install 会带上 devDependency typescript），或在本包目录执行 npm install')
}

const freshDists = names
    .map((name) => path.join(PACKAGES, name, 'dist'))
    .filter((dir) => !fs.existsSync(dir))

const linkedSiblings = linkSiblings(names)
const order = buildOrder(names)
const failed = build(order, tsc)
if (failed.length > 0) {
    removeFresh(freshDists)
    fail(`构建失败：${failed.join(', ')}（本次新建的 dist 已删除；这是安装失败，不是警告）`)
}

const bundles = linkBundles(names)
log(`构建 ${names.length} 个包（编译器 ${path.relative(ROOT, tsc) || tsc}，内部链接 ${linkedSiblings} 条）`)
if (path.basename(path.dirname(ROOT)) === 'node_modules') {
    log(`profile 软链 ${bundles.linked} 条${bundles.skipped.length === 0 ? '' : `；跳过真实目录 ${bundles.skipped.join(', ')}`}`)
}

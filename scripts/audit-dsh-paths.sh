#!/usr/bin/env bash
# audit-dsh-paths.sh — every repository-internal path default must follow the
# layout root; this is the audit that says so.
#
# WHY: since the namespace migration a repository keeps its engineering trail in
# `.dsh/engineering-suite/` ONCE MIGRATED, and in `.dsh/` before that. `resolveLayout`
# decides which — so every default that names a trail artifact has to go through it
# (`relativeRootFile()`, or the resolved `layout`). A literal `.dsh/…` default pins
# ONE of the two layouts, and the failure is silent: the file is written where the
# reader never looks, the report says "not configured" next to a perfectly good
# configuration, and no test fails because both layouts are legitimate. That class of
# defect has now been fixed plugin by plugin (standards, deploy, kb, interaction, and
# the rest in one pass); this script is the written-down rule so the NEXT plugin
# cannot reintroduce it.
#
# What it scans: `packages/*/src/*.ts` and `packages/*/cordis.patch.yml` — the two
# places a plugin names a repository path (code default, bundle patch).
#
# classification (every entry is listed with its class, `functional` last-resort):
#
#   functional   a bare `.dsh/…` path token in code — a default/location a plugin
#                resolves. MUST be 0: that is the defect. Fix it with
#                `relativeRootFile(cwd, …)` / the resolved `layout`, or an explicit
#                config key whose empty string means "follow the layout root".
#   host         `~/.dsh/…`. The HOST keeps these (`~/.dsh/*.log`, the approver
#                list): they are outside the repository, so they must NOT follow the
#                layout root — moving them would put host files inside a project.
#   text         comments and prompt/report/error copy (naming the trail in a message
#                is honest). Three sub-kinds are reported with their reason and are
#                not path defaults:
#                  prose   a sentence that happens to quote `.dsh/…`;
#                  scope   the trust-root glob `.dsh/**` — the namespace root is
#                          nested INSIDE `.dsh/`, so this one pattern covers both
#                          layouts (it excludes the trail, it does not locate a file);
#                  legacy  a `LEGACY_*` constant that names where a file USED to be,
#                          so the migration can be reported. No approval path reads
#                          it (a repository file must never grant a permission).
#
# usage:
#   bash scripts/audit-dsh-paths.sh            # counts + every entry, grouped
#   bash scripts/audit-dsh-paths.sh --quiet    # counts + verdict only
#   bash scripts/audit-dsh-paths.sh --selftest # prove the classifier both ways
#
# exit: 0 = no functional literal left · 1 = at least one remains (listed) ·
#       2 = usage error / the self-test found a blind classifier.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec node --input-type=module - "$ROOT" "$@" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'

const [rootArg, ...flags] = process.argv.slice(2)
const root = path.resolve(rootArg ?? process.cwd())
const quiet = flags.includes('--quiet')
const selftest = flags.includes('--selftest')
const unknown = flags.filter((flag) => flag !== '--quiet' && flag !== '--selftest')
if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(' ')}`)
    console.error('usage: bash scripts/audit-dsh-paths.sh [--quiet] [--selftest]')
    process.exit(2)
}

/** The needle: a repository-internal trail path (`.dsh` alone is the root's NAME). */
const NEEDLE = '.dsh/'
const CJK = /[\u3000-\u9fff\u3400-\u4dbf\uff00-\uffef]/
const SCOPE_GLOB = '.dsh/**'
const LEGACY_DECL = /LEGACY_[A-Z0-9_]*\s*=/

/** The string-literal spans of one line (`'`, `"`, backtick; escapes respected). */
function quotedSpans(line) {
    const spans = []
    let index = 0
    while (index < line.length) {
        const quote = line[index]
        if (quote !== '"' && quote !== "'" && quote !== '`') {
            index += 1
            continue
        }
        const start = index
        let cursor = index + 1
        let body = ''
        while (cursor < line.length) {
            if (line[cursor] === '\\') {
                body += line[cursor + 1] ?? ''
                cursor += 2
                continue
            }
            if (line[cursor] === quote) break
            body += line[cursor]
            cursor += 1
        }
        spans.push({ start, end: cursor, body })
        index = cursor + 1
    }
    return spans
}

/** Index where a comment starts (outside string literals), or -1. */
function commentIndex(line, yaml) {
    const spans = quotedSpans(line)
    const inside = (index) => spans.some((span) => index > span.start && index < span.end)
    for (let index = 0; index < line.length; index += 1) {
        if (inside(index)) continue
        if (!yaml && line[index] === '/' && line[index + 1] === '/') return index
        if (yaml && line[index] === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) return index
    }
    return -1
}

/**
 * Classify every `.dsh/` occurrence of one line.
 * @param {string} file - repo-relative path (decides YAML vs TypeScript rules).
 * @param {string} line - the source line.
 * @returns {{kind: 'functional'|'host'|'text', reason: string}[]}
 */
function classify(file, line) {
    const yaml = file.endsWith('.yml') || file.endsWith('.yaml')
    const out = []
    if (!line.includes(NEEDLE)) return out
    const trimmed = line.trimStart()
    const commentOnly =
        trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || (yaml && trimmed.startsWith('#'))
    const comment = commentOnly ? 0 : commentIndex(line, yaml)
    const spans = quotedSpans(line)
    let from = 0
    for (;;) {
        const at = line.indexOf(NEEDLE, from)
        if (at < 0) break
        from = at + 1
        if (commentOnly || (comment >= 0 && at > comment)) {
            out.push({ kind: 'text', reason: 'comment' })
            continue
        }
        const span = spans.find((entry) => at > entry.start && at < entry.end)
        if (span === undefined) {
            // Unquoted in code: a YAML value IS the path (functional); in
            // TypeScript this scanner does not understand the construct, so it
            // fails closed instead of calling it text.
            out.push({ kind: 'functional', reason: yaml ? 'yaml value' : 'outside a string literal' })
            continue
        }
        if (span.body.includes(`~/${NEEDLE}`)) {
            out.push({ kind: 'host', reason: 'host path' })
            continue
        }
        if (/\s/.test(span.body) || CJK.test(span.body)) {
            out.push({ kind: 'text', reason: 'prose' })
            continue
        }
        if (span.body.trim() === SCOPE_GLOB) {
            out.push({ kind: 'text', reason: 'scope' })
            continue
        }
        if (LEGACY_DECL.test(line)) {
            out.push({ kind: 'text', reason: 'legacy' })
            continue
        }
        out.push({ kind: 'functional', reason: 'path default' })
    }
    return out
}

// --- selftest: a classifier that matches nothing is a false green -------------

if (selftest) {
    const CASES = [
        // [file, line, expected kind (null = nothing to say)]
        ['src/a.ts', "const DEFAULT_X = '.dsh/x.json'", 'functional'],
        ['src/a.ts', "    allowlistFile: str(raw['allowlistFile'], '.dsh/x.json'),", 'functional'],
        ['src/a.ts', "const LOG = '~/.dsh/x.log'", 'host'],
        ['src/a.ts', ' * writes `.dsh/x.json` (the default follows the layout root)', 'text'],
        ['src/a.ts', "const text = '写入 .dsh/x.json 后重试'", 'text'],
        ['src/a.ts', "const text = 'the file lives in .dsh/x.json on disk'", 'text'],
        ['src/a.ts', "export const LEGACY_FILE = '.dsh/old.txt'", 'text'],
        ['src/a.ts', "export const EXCLUDES = ['.dsh/**', 'node_modules/**']", 'text'],
        ['src/a.ts', "const ok = 1 // was '.dsh/x.json'", 'text'],
        ['cordis.patch.yml', '        allowlistFile: .dsh/x.json', 'functional'],
        ['cordis.patch.yml', "        logFile: '~/.dsh/x.log'", 'host'],
        ['cordis.patch.yml', '# see `.dsh/x.json` — the reader looks there', 'text'],
        ['src/a.ts', "const ok = 'no trail here'", null],
    ]
    let failures = 0
    for (const [file, line, expected] of CASES) {
        const kinds = classify(file, line).map((entry) => entry.kind)
        const actual = kinds.length === 0 ? null : kinds.every((kind) => kind === expected) ? expected : kinds.join('+')
        if (actual !== expected) {
            failures += 1
            console.error(`FAIL ${file}: ${JSON.stringify(line)} → ${actual ?? 'null'}（期望 ${expected ?? 'null'}）`)
        }
    }
    if (failures > 0) {
        console.error(`\n${failures}/${CASES.length} 条分类用例不成立：审计的分类器坏了，它报出的"0 个功能项"没有意义。`)
        process.exit(2)
    }
    console.log(`selftest: ${CASES.length} 条分类用例通过（功能项 / 宿主路径 / 注释文案 / scope / legacy 都能区分）`)
    process.exit(0)
}

// --- scan --------------------------------------------------------------------

/** Every file the audit covers: plugin sources and bundle patches. */
function targets() {
    const out = []
    const packagesDir = path.join(root, 'packages')
    for (const pkg of fs.readdirSync(packagesDir).sort()) {
        const src = path.join(packagesDir, pkg, 'src')
        if (fs.existsSync(src)) {
            for (const name of fs.readdirSync(src).sort()) {
                if (name.endsWith('.ts')) out.push(path.join(src, name))
            }
        }
        const patch = path.join(packagesDir, pkg, 'cordis.patch.yml')
        if (fs.existsSync(patch)) out.push(patch)
    }
    return out
}

const entries = []
for (const file of targets()) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
        for (const entry of classify(relative, line)) {
            entries.push({ file: relative, line: index + 1, text: line.trim(), ...entry })
        }
    })
}

const ORDER = ['functional', 'host', 'text']
const LABEL = {
    functional: '功能项（仓库内路径默认值 —— 必须为 0）',
    host: '宿主路径（仓库外，保持不动）',
    text: '注释 / 提示文案',
}
const REASON = { prose: '文案', comment: '注释', scope: 'scope', legacy: 'legacy', 'yaml value': 'yaml', 'outside a string literal': '未加引号', 'host path': '宿主', 'path default': '默认值' }
const counts = Object.fromEntries(ORDER.map((kind) => [kind, 0]))
const reasons = {}
for (const entry of entries) {
    counts[entry.kind] += 1
    const key = `${entry.kind}:${entry.reason}`
    reasons[key] = (reasons[key] ?? 0) + 1
}
const textBreakdown = ['comment', 'prose', 'scope', 'legacy']
    .map((reason) => [reason, reasons[`text:${reason}`] ?? 0])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${REASON[reason] ?? reason} ${count}`)
    .join(' · ')

console.log(`# .dsh/ 字面量审计：packages/*/src/*.ts 与 packages/*/cordis.patch.yml（${entries.length} 处）`)
console.log('')
console.log(`functional  ${counts.functional}`)
console.log(`host        ${counts.host}`)
console.log(`text        ${counts.text}${textBreakdown === '' ? '' : `   （${textBreakdown}）`}`)

if (!quiet) {
    for (const kind of ORDER) {
        const rows = entries.filter((entry) => entry.kind === kind)
        if (rows.length === 0) continue
        console.log('')
        console.log(`${LABEL[kind]}：`)
        for (const row of rows) {
            const tag = kind === 'text' ? `[${REASON[row.reason] ?? row.reason}] ` : ''
            console.log(`  ${tag}${row.file}:${row.line}  ${row.text.length > 120 ? `${row.text.slice(0, 120)}…` : row.text}`)
        }
    }
}

console.log('')
if (counts.functional > 0) {
    console.log(`⛔ 还有 ${counts.functional} 个功能项把仓库内路径写死成 .dsh/…：迁移后的仓库会把文件写到读者不看的地方。`)
    console.log('   下一步：改成 relativeRootFile(cwd, …) / 已解析的 layout，或让配置默认值为空串（空串 = 跟随布局根）。')
    console.log('   这不是可以"接受"的存量：功能项必须为 0（宿主路径与注释文案不算）。')
    process.exit(1)
}
console.log('结论：functional=0 —— 所有仓库内路径默认值都经布局根解析（命名空间优先，未迁移回退 .dsh/）。')
console.log('宿主路径（~/.dsh/…）保持不动：它们不属于仓库，改成布局根会把宿主文件放进项目里。')
NODE

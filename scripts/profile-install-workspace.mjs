/**
 * The `pnpm-workspace.yaml` half of `fix-profile-install.mjs`: plan the edits that
 * turn a profile from "installs successfully with no dist" into one where a blocked
 * build is a hard failure. No I/O — the caller reads and writes the file.
 *
 * The three rules (a real 0.8.13 upgrade needed all of them):
 *   1. every non-boolean `allowBuilds` value becomes an explicit boolean — the
 *      suite's entries stay `true`, anything else unknown becomes `false` and is
 *      named in `notBuilt` (a placeholder silently means "pnpm cannot decide");
 *   2. the `strictDepBuilds` line is removed, restoring pnpm's default `true`:
 *      a blocked build must fail the install and name itself;
 *   3. the suite's repository-URL approval is preserved, and added when missing
 *      (a git dependency can never be approved by a bare package name).
 *
 * `planWorkspaceFix` re-plans its own result and throws when that is not a fixed
 * point: a fix that edits its own output would rewrite the file on every run.
 *
 * @module scripts/profile-install-workspace
 */

export const SUITE = 'dsh-engineering-suite'
/** The approval pnpm needs for a git dependency: a bare package name never matches it. */
export const SUITE_REPO_KEY = 'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git'

/** One `key: value` line of the `allowBuilds` block; a quoted key may contain `:`. */
function parseEntry(text) {
    const trimmed = text.trim()
    const quoted = trimmed.startsWith("'") || trimmed.startsWith('"')
    const keyEnd = quoted ? trimmed.indexOf(trimmed[0], 1) + 1 : trimmed.indexOf(':')
    const colon = keyEnd > 0 ? trimmed.indexOf(':', keyEnd) : -1
    if (colon === -1 || keyEnd <= 0) return undefined
    const key = trimmed.slice(0, keyEnd)
    const rest = trimmed.slice(colon + 1)
    const commentAt = rest.indexOf(' #')
    return {
        key,
        bare: key.replace(/^['"]|['"]$/g, ''),
        value: (commentAt === -1 ? rest : rest.slice(0, commentAt)).trim(),
        comment: commentAt === -1 ? '' : rest.slice(commentAt),
        indent: text.slice(0, text.length - text.trimStart().length),
    }
}

/** Rewrite one entry to an explicit boolean; returns the suite flag and this entry's indent. */
function fixEntry(line, plan) {
    const entry = parseEntry(line.text)
    if (entry === undefined) throw new Error(`无法解析 allowBuilds 里的这一行：${line.text.trim()}`)
    const suite = entry.bare === SUITE || entry.bare.startsWith(`${SUITE}@`)
    if (entry.value === 'true' || entry.value === 'false') {
        if (suite) plan.kept.push(`${entry.key}: ${entry.value}`)
        return { suite, indent: entry.indent }
    }
    const before = line.text.trim()
    line.text = `${entry.indent}${entry.key}: ${suite ? 'true' : 'false'}${entry.comment}`
    plan.changes.push({
        action: 'set',
        line: line.original,
        before,
        after: line.text.trim(),
        note: suite
            ? '套件的构建必须放行（占位符代替不了批准）'
            : `${entry.bare} 不会被构建（显式 false：未知的构建脚本不自动批准）`,
    })
    if (!suite) plan.notBuilt.push(entry.bare)
    return { suite, indent: entry.indent }
}

/** Append the suite's repository-URL approval when `allowBuilds` has no suite entry. */
function insertSuiteEntry(lines, headerAt, end, indent, plan) {
    let at = headerAt
    for (let index = headerAt + 1; index < end; index += 1) {
        if (lines[index].text.trim() !== '') at = index
    }
    const text = `${indent}'${SUITE_REPO_KEY}': true`
    lines.splice(at + 1, 0, { text, original: undefined })
    plan.changes.push({
        action: 'insert',
        line: '新增',
        before: '',
        after: text,
        note: 'allowBuilds 缺少套件的仓库 URL 批准：补上（git 依赖不能用裸包名放行）',
    })
}

function fixAllowBuilds(lines, headerAt, plan) {
    if (!/^allowBuilds\s*:$/.test(lines[headerAt].text)) {
        throw new Error(`allowBuilds 是内联写法（${lines[headerAt].text.trim()}）：请先手工改成块形式，再运行本脚本`)
    }
    let end = headerAt + 1
    while (end < lines.length && (lines[end].text === '' || /^\s/.test(lines[end].text))) end += 1
    let suiteSeen = false
    let indent = '  '
    for (let index = headerAt + 1; index < end; index += 1) {
        const line = lines[index]
        if (!/^\s+\S/.test(line.text) || line.text.trim().startsWith('#')) continue
        const fixed = fixEntry(line, plan)
        suiteSeen = suiteSeen || fixed.suite
        indent = fixed.indent
    }
    if (!suiteSeen) insertSuiteEntry(lines, headerAt, end, indent, plan)
}

/** Create the `allowBuilds` block when the file has none (a profile before pnpm >= 11). */
function addAllowBuildsBlock(lines, plan) {
    const trailing = lines.length > 0 && lines[lines.length - 1].text === '' ? lines.pop() : undefined
    const text = `  '${SUITE_REPO_KEY}': true`
    lines.push({ text: 'allowBuilds:', original: undefined }, { text, original: undefined })
    if (trailing !== undefined) lines.push(trailing)
    plan.changes.push({
        action: 'insert',
        line: '文件末尾',
        before: '',
        after: `allowBuilds:\n${text}`,
        note: '缺少 allowBuilds：补上套件的仓库 URL 批准（git 依赖不能用裸包名放行）',
    })
}

/** `strictDepBuilds: false` is the line that made a missing dist look like success. */
function removeStrictDepBuilds(lines, plan) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!/^strictDepBuilds\s*:/.test(lines[index].text)) continue
        plan.changes.push({
            action: 'delete',
            line: lines[index].original,
            before: lines[index].text.trim(),
            note: '恢复 pnpm 默认 true：被拦的构建必须让安装失败并点名，而不是静默跳过',
        })
        lines.splice(index, 1)
    }
}

function computeWorkspaceFix(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    const lines = source.replace(/\r\n/g, '\n').split('\n').map((text, index) => ({ text, original: index + 1 }))
    const plan = { changes: [], kept: [], notBuilt: [] }
    const headerAt = lines.findIndex((line) => /^allowBuilds\s*:/.test(line.text))
    if (headerAt === -1) addAllowBuildsBlock(lines, plan)
    else fixAllowBuilds(lines, headerAt, plan)
    removeStrictDepBuilds(lines, plan)
    return { ...plan, text: lines.map((line) => line.text).join(eol) }
}

/**
 * Plan the fix. `text` is the whole new file; `changes` are what to report; `kept`
 * lists the suite approvals left alone; `notBuilt` names the dependencies the run
 * deliberately will not build.
 */
export function planWorkspaceFix(source) {
    const plan = computeWorkspaceFix(source)
    const again = computeWorkspaceFix(plan.text)
    if (again.text !== plan.text || again.changes.length > 0) {
        throw new Error('修复结果不是幂等的（第二次运行仍会改动 pnpm-workspace.yaml）')
    }
    return plan
}

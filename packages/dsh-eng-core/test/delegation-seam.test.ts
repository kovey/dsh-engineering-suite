/**
 * The uniqueness regression (AC-002, TC-901): delegation has ONE implementation.
 *
 * Why a source scan and not a code review: `subagents.start(provider, request)`
 * was deleted in harness 0.2.2-rc.1, and three packages hand-wrote the replacement
 * seam independently. Two were migrated and the third silently rotted —
 * `dsh-impact-gate` still called the deleted API with `toolFilter`/`persona`, so
 * on 0.2.2-rc.1+ it could not start a reviewer at all, and every test that would have
 * noticed was written against an old host. A fourth copy is now a failing test.
 *
 * The rule: `packages/*\/src/**` must not contain a `subagents.start(` CALL
 * outside `packages/dsh-eng-core/src/delegation.ts`, EXCEPT the two sites in
 * {@link PENDING_MIGRATION} — files that are outside this mission's approved
 * file boundary and therefore cannot be migrated here. The exemption list is a
 * RATCHET, not a permission: an entry that is no longer an offence fails the
 * test, so a migrated file must be struck from it, and a new copy anywhere is a
 * failure with no way to be added without editing this test in review.
 *
 * Judgement calls, stated so a future reader can argue with them:
 *
 *  - **Comments are ignored.** The deleted API is named in prose all over the
 *    suite ("the two-arg `subagents.start(provider, request)` no longer
 *    exists"), and a rule that forbade explaining the history would be a rule
 *    that gets deleted. Strings are NOT ignored: a call spelled out in a string
 *    literal is at best ambiguous, and quoting it differently is cheap.
 *  - **`startActivation(` is not a match** (`start` must be followed by `(`), and
 *    reading the method without calling it (`typeof subagents.start`,
 *    `const start = subagents.start`) is allowed: the legacy path has to look
 *    the method up before calling it.
 *  - **Only `src/`.** A test may legitimately call a fake's `start`; the seam
 *    under test is the source tree.
 *  - **Empty walk is a failure.** A checker whose walk finds nothing reports
 *    success having checked nothing (the suite has been bitten by exactly that),
 *    so the scan asserts the seam file is in the file list.
 *
 * @module dsh-eng-core/test/delegation-seam
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** `packages/` (this file lives in `<repo>/packages/dsh-eng-core/test/`). */
const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

/** The one file allowed to perform the legacy start. */
const SEAM = path.join('dsh-eng-core', 'src', 'delegation.ts')

/**
 * Known-unmigrated sites, each with WHY it cannot be fixed in this mission.
 *
 * They are the same defect (a call to the seam harness 0.2.2-rc.1 deleted, with the
 * child's restriction riding in a request that no longer has that field), found
 * by this scan after the three packages of this mission were migrated. Their
 * packages are not in this mission's file boundary, so fixing them here is not
 * possible — but leaving the defect unnamed is how it survived two migrations.
 */
const PENDING_MIGRATION = new Map<string, string>([
    [
        path.join('dsh-spec-gate', 'src', 'tools.ts'),
        'KNOWN-UNMIGRATED：spec_bootstrap({ action: "draft" }) 的只读草稿子代理。0.2.2-rc.1 上 `start` 已不存在，' +
            '所以这条派发起不到子代理；而它的只读收紧（toolFilter: { allow: readTools }）在新宿主没有载体——' +
            '`SubagentStartRequest` 没有 toolFilter/persona，只读约束只能作为 preset 行交给子作用域。' +
            '本任务的文件边界不含 packages/dsh-spec-gate，故未随另外三处一起迁移。',
    ],
    [
        path.join('dsh-standards-gate', 'src', 'review.ts'),
        'KNOWN-UNMIGRATED：runStructuralReview 的结构评审子代理。同一缺陷：' +
            'toolFilter/persona/maxDepth 全塞在请求里，0.2.2-rc.1 上这条派发起不到子代理，' +
            '审查者的只读收紧也就没有载体。本任务的文件边界不含 packages/dsh-standards-gate。',
    ],
])

/**
 * A real call of the deleted two-arg start.
 *
 * `subagents.start(` / `subagents?.start(` with any whitespace or newline
 * between the tokens; `startActivation(` cannot match because `start` must be
 * immediately followed by `(`.
 */
const CALL = /\bsubagents\s*(?:\?\.|\.)\s*start\s*\(/g

/**
 * Remove comments, keeping strings (so a call in code is never hidden by a `//`
 * that happens to live inside a string literal, e.g. a URL).
 * @param source - the file's text.
 * @returns the text with `//` and block comments removed.
 */
function stripComments(source: string): string {
    const out: string[] = []
    let index = 0
    let quote: string | null = null
    while (index < source.length) {
        const char = source[index] as string
        if (quote !== null) {
            out.push(char)
            if (char === '\\') {
                out.push(source[index + 1] ?? '')
                index += 2
                continue
            }
            if (char === quote) quote = null
            index += 1
            continue
        }
        if (char === '/' && source[index + 1] === '/') {
            while (index < source.length && source[index] !== '\n') index += 1
            continue
        }
        if (char === '/' && source[index + 1] === '*') {
            index += 2
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
            index += 2
            continue
        }
        if (char === '"' || char === "'" || char === '`') quote = char
        out.push(char)
        index += 1
    }
    return out.join('')
}

/** Every `.ts` file under `packages/*\/src`, workspace-relative. */
function sourceFiles(): string[] {
    const files: string[] = []
    for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const src = path.join(PACKAGES_DIR, entry.name, 'src')
        if (!fs.existsSync(src)) continue
        const walk = (dir: string): void => {
            for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, child.name)
                if (child.isDirectory()) walk(full)
                else if (child.isFile() && child.name.endsWith('.ts')) files.push(path.relative(PACKAGES_DIR, full))
            }
        }
        walk(src)
    }
    return files.sort()
}

/** The offences: file → the matching call shapes (each with its line number). */
function offences(): { file: string; line: number; text: string }[] {
    const found: { file: string; line: number; text: string }[] = []
    for (const file of sourceFiles()) {
        if (file === SEAM) continue
        const source = fs.readFileSync(path.join(PACKAGES_DIR, file), 'utf8')
        const stripped = stripComments(source)
        for (const match of stripped.matchAll(CALL)) {
            const at = match.index ?? 0
            found.push({ file, line: stripped.slice(0, at).split('\n').length, text: match[0].replace(/\s+/g, '') })
        }
    }
    return found
}

test('the deleted two-arg subagents.start( call exists in exactly one module (AC-002, TC-901)', () => {
    // The walk must be able to fail: an empty (or seam-less) file list would
    // report "no fourth copy" having looked at nothing.
    const files = sourceFiles()
    assert.ok(files.includes(SEAM), `the seam must be in the scanned tree; scanned ${files.length} files under packages/*/src`)
    assert.ok(files.length > 20, `the walk found suspiciously few files (${files.length}): the scan is not looking at the suite`)

    const found = offences()
    const unexpected = found.filter((entry) => !PENDING_MIGRATION.has(entry.file))
    assert.deepEqual(
        unexpected,
        [],
        [
            'delegation has one implementation —— 子代理委派只有一份实现：packages/dsh-eng-core/src/delegation.ts 的',
            'planDelegation / startDelegation（preset 由 registerDelegationPreset 声明）。harness 0.2.2-rc.1 删掉了',
            'subagents.start(provider, request)：请改用那份实现（planDelegation → startDelegation），不要在本包里再写一份。',
            '新出现的调用：',
            ...unexpected.map((entry) => `  packages/${entry.file}:${entry.line} → ${entry.text}`),
            '若某个包不在本任务的文件边界内，不要把它加进 PENDING_MIGRATION：那需要扩大边界、另开任务由人批准。',
        ].join('\n'),
    )

    // The ratchet: every exempted file must STILL be an offence. A migrated file
    // that stays listed would quietly keep the allowance alive for a future copy
    // in the same file.
    const migrated = [...PENDING_MIGRATION.keys()].filter((file) => !found.some((entry) => entry.file === file))
    assert.deepEqual(
        migrated,
        [],
        [
            'this file no longer calls subagents.start —— 这些文件已经不再调用已删除的 API，请从 PENDING_MIGRATION 里删掉：',
            ...migrated.map((file) => `  packages/${file}`),
            '（remove it from the baseline：后续迁移任务正在关闭这份名单，名单活过它就会变成永久豁免。）',
        ].join('\n'),
    )
    // And the debt is exactly what is named: a third exempted file cannot appear
    // without a reviewer noticing the count change.
    assert.equal(PENDING_MIGRATION.size, found.length, `PENDING_MIGRATION 有 ${PENDING_MIGRATION.size} 项，实际命中 ${found.length} 个文件`)
})

test('the scan ignores comments and does not confuse startActivation (self-check)', () => {
    // A checker that matches nothing must not be able to pass by accident: this
    // drives the same function over text it must and must not flag.
    const allowed = stripComments(
        [
            '// the two-arg `subagents.start(provider, request)` no longer exists',
            '/* subagents.start(provider, request) is deleted */',
            'const start = subagents.start',
            'if (typeof subagents.start !== \'function\') return',
            'await subagents.startActivation({ provider })',
            "const note = 'https://example.com/a//b'",
        ].join('\n'),
    )
    assert.equal([...allowed.matchAll(CALL)].length, 0)
    const flagged = stripComments(['await subagents.start(input.provider, request)', 'subagents?.start(provider, request)'].join('\n'))
    assert.equal([...flagged.matchAll(CALL)].length, 2)
})

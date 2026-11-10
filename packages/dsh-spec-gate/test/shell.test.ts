/**
 * dsh-spec-gate 的 shell 分析器：重定向目标提取的两处精确误伤。
 *
 * 两处都在真实使用中复现过：`apiVersion >= 1` 里的 `>` 被当成重定向（目标被记成
 * `=`，于是用 heredoc 传提交信息的 `git commit -F -` 被拒绝），以及 heredoc 正文
 * （提交信息、markdown 片段、代码）被当作 shell 语法扫描。这里逐条钉住：正文不算
 * shell、比较运算符不产生目标，而 `2>&1` 与每一种真实重定向的既有语义都不能变。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeShellCommand, matchesShellAllow } from '../dist/shell.js'

const NEWLINE = '\n'

/** Build one command out of readable lines instead of a packed literal. */
function lines(...rows: string[]): string {
    return rows.join(NEWLINE)
}

test('a heredoc body containing a comparison operator records no target (regression)', () => {
    const command = lines("git commit -F - <<'EOF'", 'apiVersion >= 1', '', '- keep the gate honest', 'EOF')
    // The bug: `>=` was read as `>` plus target `=`, so the commit was refused for
    // "writing `=`", outside the declared file boundaries.
    assert.deepEqual(analyzeShellCommand(command).targets, [])
})

test('a redirect written inside a heredoc body is data, not a target (regression)', () => {
    const command = lines("cat <<'EOF'", 'see > out.txt for the details', 'EOF')
    assert.deepEqual(analyzeShellCommand(command).targets, [])
})

test('a redirect before the heredoc marker is still recorded (regression)', () => {
    const command = lines("cat > notes.md <<'EOF'", '# notes', 'body', 'EOF')
    assert.deepEqual(analyzeShellCommand(command).targets, ['notes.md'])
})

test('every real output redirect is still recorded (regression)', () => {
    assert.deepEqual(analyzeShellCommand('echo hi > out.txt').targets, ['out.txt'])
    assert.deepEqual(analyzeShellCommand('cmd >> log.txt').targets, ['log.txt'])
    assert.deepEqual(analyzeShellCommand('cmd 2> err.log').targets, ['err.log'])
    assert.deepEqual(analyzeShellCommand('cmd &> both.txt').targets, ['both.txt'])
})

test('a comparison operator outside a heredoc is not a target (regression)', () => {
    assert.deepEqual(analyzeShellCommand("awk '$1 >= 2 {print}' f").targets, [])
    // Unquoted too: the `=` after `>` is the operator's tail, never a file name.
    assert.deepEqual(analyzeShellCommand('test 1 >= 2').targets, [])
})

test('file-descriptor duplication is not a write target (regression)', () => {
    assert.deepEqual(analyzeShellCommand('cmd 2>&1').targets, [])
})

test('an unterminated heredoc hides its body and does not throw (regression)', () => {
    const command = lines("cat <<'EOF'", 'no closing delimiter here', 'stray > x')
    const analysed = analyzeShellCommand(command)
    assert.deepEqual(analysed.targets, [])
})

test('a redirect after the heredoc end line is still detected (regression)', () => {
    const command = lines("cat <<'EOF'", 'hello', 'EOF', 'echo hi > after.txt')
    assert.deepEqual(analyzeShellCommand(command).targets, ['after.txt'])
})

test('shellAllow: a reviewed script is allowed, arbitrary code is not (regression)', () => {
    const patterns = ['bash scripts/**']
    assert.equal(matchesShellAllow('bash scripts/verify.sh --quiet', patterns), true)
    // The hole this closes: an inline interpreter is not a reviewed artifact.
    assert.equal(matchesShellAllow('python3 -c "open(\'x\', \'w\')"', patterns), false)
    assert.equal(matchesShellAllow('node -e "require(\'fs\')"', patterns), false)
})

test('shellAllow: traversal never matches (regression)', () => {
    const patterns = ['bash scripts/**']
    assert.equal(matchesShellAllow('bash ../evil.sh', patterns), false)
    assert.equal(matchesShellAllow('bash scripts/../../evil.sh', patterns), false)
})

test('shellAllow: one star stays inside a segment, two stars cross it (regression)', () => {
    assert.equal(matchesShellAllow('bash scripts/run.sh', ['bash scripts/*']), true)
    assert.equal(matchesShellAllow('bash scripts/sub/run.sh', ['bash scripts/*']), false)
    assert.equal(matchesShellAllow('bash scripts/sub/run.sh', ['bash scripts/**']), true)
})

test('shellAllow: an empty list and empty patterns allow nothing (regression)', () => {
    assert.equal(matchesShellAllow('bash scripts/verify.sh', []), false)
    assert.equal(matchesShellAllow('bash scripts/verify.sh', ['']), false)
})

test('shellAllow: extra spacing is normalised before matching (regression)', () => {
    assert.equal(matchesShellAllow('bash   scripts/verify.sh', ['bash scripts/**']), true)
})

// --- 解释器内联载荷：曾经完全看不见的写操作（2026-11-10 审查发现） ---------------

test('TC-1081 a write inside a python heredoc names its file, so the boundary applies', () => {
    // The bypass this closes: `python3 - <<'PY' open('../../outside.txt','w') PY`
    // rewrote files outside the mission boundary while the analyser reported no
    // target at all — the same write through `cat >>` was refused.
    const analysis = analyzeShellCommand("python3 - <<'PY'\nopen('../../outside.txt','w').write('x')\nPY")
    assert.deepEqual(analysis.targets, ['../../outside.txt'])
})

test('TC-1082 bash -c payloads are analysed recursively', () => {
    const analysis = analyzeShellCommand("bash -c 'echo hi > notes.md'")
    assert.deepEqual(analysis.targets, ['notes.md'])
})

test('TC-1083 node -e writes are attributed to their literal path', () => {
    const analysis = analyzeShellCommand('node -e "require(\'fs\').writeFileSync(\'/tmp/x\',\'1\')"')
    assert.deepEqual(analysis.targets, ['/tmp/x'])
})

test('TC-1084 a write whose path is NOT a literal stays undecidable (fail closed)', () => {
    const analysis = analyzeShellCommand('python3 -c "open(name,\'w\')"')
    assert.equal(analysis.undecidable, true)
    assert.equal(analysis.targets.length, 0)
    assert.ok(
        analysis.reasons.some((reason) => /内联载荷里有写操作/.test(reason)),
        `必须点名"载荷里有写操作但目标不可归属"：${analysis.reasons.join(' / ')}`,
    )
})

test('TC-1085 an interpreter payload with no write intent adds no target', () => {
    for (const command of ['python3 -c "print(1)"', 'node -e "console.log(1)"', 'ruby -e "puts 1"']) {
        const analysis = analyzeShellCommand(command)
        assert.deepEqual(analysis.targets, [], command)
        assert.equal(
            analysis.reasons.some((reason) => /内联载荷里有写操作/.test(reason)),
            false,
            `纯计算载荷不该被当成写操作：${command}`,
        )
    }
})

test('TC-1086 heredoc BODIES stay data: a commit message is not a write', () => {
    const analysis = analyzeShellCommand("git commit -F - <<'EOF'\nfeat: a > b # 注释\nEOF")
    assert.deepEqual(analysis.targets, [])
})

test('TC-1087 nested shell payloads terminate at the depth bound', () => {
    const analysis = analyzeShellCommand(`bash -c "bash -c 'bash -c \"touch a.txt\"'"`)
    assert.ok(analysis.targets.includes('a.txt') || analysis.undecidable, '要么定位到 a.txt，要么明确不可判定')
})

test('TC-1201 a heredoc body or code payload containing a PIPE does not crash the analyser', () => {
    // Reported by using it: the segment split on `|` also cut through CODE payloads
    // and quoted strings, and the garbage "command" that produced was interpolated
    // raw into `new RegExp` — which threw `Unmatched ')'` and took the whole guard
    // down for every command with a pipe in a heredoc, a `-c`/`-e` string or even
    // `grep -E "a|b"`.
    const pipe = String.fromCharCode(124)
    const commands = [
        `python3 - <<'PY'\nx = '${pipe}'.join(['a', 'b'])\nopen('out.txt', 'w')\nPY`,
        `node -e "const a = 1 ${pipe}${pipe} 2; require('fs').writeFileSync('/tmp/p', '1')"`,
        `bash -c "echo hi ${pipe}${pipe} true"`,
        `grep -E "alpha${pipe}beta" notes.md`,
    ]
    for (const command of commands) {
        // `doesNotThrow` returns void: capture the result inside the callback.
        let analysis: ReturnType<typeof analyzeShellCommand> | undefined
        assert.doesNotThrow(() => {
            analysis = analyzeShellCommand(command)
        })
        assert.ok(analysis !== undefined && Array.isArray(analysis.targets), `must return an analysis for: ${command}`)
    }
})

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

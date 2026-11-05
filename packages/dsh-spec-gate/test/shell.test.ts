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
import { analyzeShellCommand } from '../dist/shell.js'

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

/**
 * dsh-spec-gate 的 shell 写目标建模：七类"操作数不是一个位置参数"的命令。
 *
 * 每一条都来自真机复现：`tar -x -C .dsh/...`、`xargs -I{} cp {} .dsh/...`、
 * `git apply`、`rsync`、`unzip -d`、`mv -t`、`install -t` 曾经被直接放行，
 * 而等价的 `cat >> .dsh/...` 会被拒绝。测试同时钉住反向要求：解析不了的形态
 * （xargs 下游是变量、rsync 目标是远端、补丁不可见）必须是 `undecidable`，
 * 不能变成"没有目标 = 安全"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeShellCommand } from '../dist/shell.js'

/** The one-line summary this file asserts on. */
function targets(command: string): string[] {
    return analyzeShellCommand(command).targets
}

test('TC-1531 tar: extract writes the -C directory, create writes the -f file, list writes nothing', () => {
    // The real command that used to reach the shell: a real archive unpacks
    // straight into the trust root.
    assert.deepEqual(targets('tar -x -C .dsh/engineering-suite -f pkg.tar'), ['.dsh/engineering-suite'])
    assert.deepEqual(targets('tar -xzf pkg.tgz -C src/generated'), ['src/generated'])
    assert.deepEqual(targets('tar --extract --directory=.dsh --file=pkg.tar'), ['.dsh'])
    // Without -C tar extracts into the current directory: that is a target too.
    assert.deepEqual(targets('tar -xf pkg.tar'), ['.'])
    assert.deepEqual(targets('tar -czf out.tgz src'), ['out.tgz'])
    assert.deepEqual(targets('tar -tf pkg.tar'), [])
    // `-f -` is stdout, not a file.
    assert.deepEqual(targets('tar -cf - src'), [])
})

test('TC-1531 unzip: -d names the directory, listing writes nothing', () => {
    assert.deepEqual(targets('unzip -d .dsh/engineering-suite pkg.zip'), ['.dsh/engineering-suite'])
    assert.deepEqual(targets('unzip -d.dsh pkg.zip'), ['.dsh'])
    assert.deepEqual(targets('unzip -l pkg.zip'), [])
    // No -d extracts into the cwd (the honest default, not "no target").
    assert.deepEqual(targets('unzip pkg.zip'), ['.'])
})

test('TC-1531 rsync: the destination is the last operand; a remote target is undecidable', () => {
    assert.deepEqual(targets('rsync -avz src/ .dsh/engineering-suite/'), ['.dsh/engineering-suite/'])
    assert.deepEqual(targets('rsync --exclude node_modules -a src/ dist/'), ['dist/'])
    const remote = analyzeShellCommand('rsync -e ssh src/ deploy@host:/srv/app')
    assert.equal(remote.undecidable, true)
    assert.deepEqual(remote.targets, [])
    assert.ok(remote.reasons.some((reason) => /远端/.test(reason)), remote.reasons.join(' / '))
    assert.equal(analyzeShellCommand('rsync -a src/ host:').undecidable, true)
})

test('TC-1531 mv: -t names the directory; the sources are moved (and removed) too', () => {
    assert.ok(targets('mv a.txt .dsh/engineering-suite/').includes('.dsh/engineering-suite/'))
    assert.ok(targets('mv a.txt .dsh/engineering-suite/').includes('a.txt'))
    assert.deepEqual(targets('mv --target-directory=.dsh/engineering-suite a.txt'), ['.dsh/engineering-suite', 'a.txt'])
    assert.equal(analyzeShellCommand('mv only-one-operand').undecidable, true)
})

test('TC-1531 install: -t DIR / -d name directories, otherwise the destination is last', () => {
    assert.deepEqual(targets('install -m 755 a .dsh/engineering-suite/a'), ['.dsh/engineering-suite/a'])
    assert.deepEqual(targets('install -t .dsh/engineering-suite a b'), ['.dsh/engineering-suite'])
    assert.deepEqual(targets('install -d .dsh/engineering-suite/x'), ['.dsh/engineering-suite/x'])
    // The option VALUE must not be mistaken for the destination.
    assert.equal(analyzeShellCommand('install -m').undecidable, true)
})

test('TC-1531 git apply: patch paths are the targets; --directory prefixes them', () => {
    const patch = ["git apply <<'PATCH'", '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b', 'PATCH'].join('\n')
    assert.deepEqual(targets(patch), ['src/a.ts'])
    const patchInRoot = ["git apply --directory .dsh/engineering-suite <<'PATCH'", '+++ b/state/x.json', 'PATCH'].join('\n')
    assert.deepEqual(targets(patchInRoot), ['.dsh/engineering-suite/state/x.json'])
    // The patch file itself is invisible to the analyser: --directory is the
    // only attributable answer, and `--stat`/`--check` do not write at all.
    assert.deepEqual(targets('git apply --directory .dsh fix.patch'), ['.dsh'])
    assert.deepEqual(targets('git apply --stat fix.patch'), [])
    assert.equal(analyzeShellCommand('git apply --check fix.patch').undecidable, false)
    // Global `-C DIR` before the subcommand is a directory, not the subcommand:
    // the write lands inside that directory.
    assert.deepEqual(targets('git -C . apply fix.patch'), ['.'])
})

test('TC-1535 git apply with an invisible patch and no directory stays undecidable', () => {
    const analysis = analyzeShellCommand('git apply -p1 fix.patch')
    assert.equal(analysis.undecidable, true)
    assert.deepEqual(analysis.targets, [])
    assert.ok(analysis.reasons.some((reason) => /补丁内容不可见/.test(reason)), analysis.reasons.join(' / '))
})

test('TC-1532 xargs recurses into the command it will run', () => {
    const analysis = analyzeShellCommand('xargs -I{} cp {} .dsh/engineering-suite/')
    assert.deepEqual(analysis.targets, ['.dsh/engineering-suite/'])
    assert.equal(analysis.undecidable, false)
    // The downstream command is re-analysed with its own rules (`rm` names every
    // operand), not read as xargs operands.
    const removed = analyzeShellCommand('xargs -n 1 rm -f .dsh/engineering-suite/tmp')
    assert.ok(removed.targets.includes('.dsh/engineering-suite/tmp'), removed.targets.join(', '))
})

test('TC-1532 xargs through a nested shell payload still names the written file', () => {
    const analysis = analyzeShellCommand('xargs -I{} sh -c "cp {} src/generated/out.ts"')
    assert.ok(analysis.targets.includes('src/generated/out.ts'), analysis.targets.join(', '))
})

test('TC-1535 xargs whose downstream is a variable or a placeholder stays undecidable', () => {
    for (const command of ['xargs -I{} $COMMAND', 'xargs sh -c "$RUN"', 'xargs -I{} cp a.txt {}']) {
        const analysis = analyzeShellCommand(command)
        assert.equal(analysis.undecidable, true, command)
        assert.deepEqual(analysis.targets, [], command)
    }
})

test('TC-1531 the seven models leave the operand-position rules intact', () => {
    // Regression guard: `cp` still writes its last operand and `git checkout`
    // is still unattributable (now including the global -C form).
    assert.deepEqual(targets('cp a.txt .dsh/x'), ['.dsh/x'])
    assert.equal(analyzeShellCommand('git -C . checkout -- src/a.ts').undecidable, true)
})

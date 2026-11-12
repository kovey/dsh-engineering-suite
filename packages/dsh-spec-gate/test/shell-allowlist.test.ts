/**
 * `shellPolicy: 'allowlist'` — the positive-list mode of dsh-spec-gate.
 *
 * `targets` trusts "we could not see a write"; this mode does not. Every shell
 * segment must match a reviewed entry, a near miss is still a refusal, and the
 * ordinary target/boundary checks keep running afterwards. The default stays
 * `targets`, so nothing here changes existing behaviour.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import { checkShellAllowlist, DEFAULT_SHELL_ALLOWLIST } from '../dist/shell-allowlist.js'

const TEST_DESIGN = [
    '### 正向场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-001 | 服务已启动 | 请求 /health | 返回 200 | AC-001 |',
    '',
    '### 异常场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-002 | 端口被占用 | 启动服务 | 退出码非 0 并打印原因 | AC-002 |',
    '',
    '### 边界场景',
    '',
    '| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |',
    '|--------|----------|----------|----------|--------------|',
    '| TC-003 | 配置为空 | 启动服务 | 使用默认端口 | AC-001 |',
    '',
].join('\n')

const DRAFT = {
    title: 'Add health endpoint',
    background: '运维需要探活接口',
    requirements: ['暴露 GET /health'],
    acceptanceCriteria: ['GET /health 返回 200', '端口占用时启动失败'],
    fileBoundaries: ['src/server.ts', 'scripts/**', 'notes.md', 'x.patch'],
    negativeConstraints: ['不得修改 dsh 核心代码'],
    testDesign: TEST_DESIGN,
}

/** A workspace whose profile config selects the allowlist mode. */
function allowlistHost(options: { project?: Record<string, unknown>; profile?: Record<string, unknown> } = {}): FakeHost {
    const cwd = tempWorkspace('spec-gate-allowlist-')
    if (options.project !== undefined) {
        fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
        fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), JSON.stringify(options.project))
    }
    const fake = createFakeHost({ cwd, approvalOutcome: 'allowed-once' })
    apply(fake.ctx as never, {
        logFile: path.join(cwd, 'spec-gate.log'),
        approval: 'seam',
        shellPolicy: 'allowlist',
        ...options.profile,
    })
    return fake
}

async function approved(fake: FakeHost): Promise<void> {
    await fake.runTool('spec_create', DRAFT)
    await fake.runTool('spec_approve', {})
}

function shell(fake: FakeHost, command: string): string | undefined {
    return fake.guardReason({ name: 'bash', arguments: { command }, agent: fake.agent })
}

test('TC-1546 默认策略仍是 targets，默认 allowlist 是一组保守条目', () => {
    const config = resolveConfig({})
    assert.equal(config.shellPolicy, 'targets', '默认必须是 targets：新增模式不改变既有行为')
    for (const entry of ['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'git status', 'git diff', 'git log', 'git show', 'node --test', 'tsc', 'bash scripts/*.sh']) {
        assert.ok(config.shellAllowlist.includes(entry), `默认条目缺少 ${entry}`)
    }
    assert.deepEqual(config.shellAllowlist, [...DEFAULT_SHELL_ALLOWLIST])
})

test('TC-1546 默认 targets 下未知程序仍然可用（allowlist 未生效）', () => {
    const cwd = tempWorkspace('spec-gate-allowlist-default-')
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'spec-gate.log') })
    // The same command is refused under allowlist (below); under the default it
    // is untouched, which is what "默认行为不变" means.
    assert.equal(shell(fake, 'mycmd --x'), undefined)
})

test('TC-1541 allowlist 下 git status 被允许', async () => {
    const fake = allowlistHost()
    await approved(fake)
    assert.equal(shell(fake, 'git status --porcelain'), undefined)
    assert.equal(shell(fake, 'ls -la'), undefined)
    assert.equal(shell(fake, 'cat notes.md'), undefined)
    assert.equal(shell(fake, 'git diff --stat'), undefined)
})

test('TC-1542 allowlist 下 bash scripts/verify.sh --quiet 被允许（命中脚本前缀）', async () => {
    const fake = allowlistHost()
    await approved(fake)
    assert.equal(shell(fake, 'bash scripts/verify.sh --quiet'), undefined)
    // AC-008 的 prefix 形态：条目以 `/` 结尾时按路径前缀匹配。
    assert.equal(checkShellAllowlist('bash scripts/run.sh', ['bash scripts/']).allowed, true)
})

test('TC-1543 allowlist 下 git status 允许但 git apply 被拒绝（理由含最接近条目与追加方式）', async () => {
    const fake = allowlistHost()
    await approved(fake)
    assert.equal(shell(fake, 'git status'), undefined)
    const denied = shell(fake, 'git apply x.patch') ?? ''
    assert.match(denied, /git apply/)
    assert.match(denied, /不在名单上/)
    assert.match(denied, /最接近的条目：`git /)
    assert.match(denied, /shellAllowlist/)
    assert.match(denied, /追加/)
    assert.match(denied, /改用工具/)
})

test('TC-1544 allowlist 下 rsync 被拒绝，理由点名 rsync 并提示追加', async () => {
    const fake = allowlistHost()
    await approved(fake)
    const denied = shell(fake, 'rsync -a src/ .dsh/') ?? ''
    assert.match(denied, /rsync/)
    assert.match(denied, /不在名单上/)
    assert.match(denied, /shellAllowlist/)
    assert.match(denied, /追加/)
})

test('TC-1545 项目级追加 mycmd 后允许，宿主条目仍然保留', async () => {
    const fake = allowlistHost({ project: { shellAllowlist: ['mycmd'] } })
    await approved(fake)
    assert.equal(shell(fake, 'mycmd --x'), undefined)
    assert.equal(shell(fake, 'git status'), undefined, '宿主条目不能被项目文件删掉')

    // 追加是合并而不是替换：项目给空数组也删不掉宿主条目。
    const empty = allowlistHost({ project: { shellAllowlist: [] } })
    const store = new MissionStoreRegistry().for(empty.cwd)
    const effective = resolveEffectiveConfig(resolveConfig({ shellPolicy: 'allowlist' }), store.layout)
    assert.ok(effective.config.shellAllowlist.includes('git status'))
})

test('AC-008 多 token 前缀：位置逐 token 比较，最后一个 token 支持 glob/前缀', () => {
    // git status 允许带参数，但不把 "git statusx" 当成命中。
    assert.equal(checkShellAllowlist('git status --porcelain', ['git status']).allowed, true)
    assert.equal(checkShellAllowlist('git statusx', ['git status']).allowed, false)
    // node --test 允许测试文件参数，node -e 不是同一程序用法。
    assert.equal(checkShellAllowlist('node --test test/*.test.ts', ['node --test']).allowed, true)
    assert.equal(checkShellAllowlist('node -e "require(\'fs\')"', ['node --test']).allowed, false)
    // 一个 star 不跨路径段，两个 star 跨。
    assert.equal(checkShellAllowlist('bash scripts/run.sh', ['bash scripts/*.sh']).allowed, true)
    assert.equal(checkShellAllowlist('bash scripts/sub/run.sh', ['bash scripts/*.sh']).allowed, false)
    assert.equal(checkShellAllowlist('bash scripts/sub/run.sh', ['bash scripts/**']).allowed, true)
    // 首程序按 basename 比较。
    assert.equal(checkShellAllowlist('/bin/ls -la', ['ls']).allowed, true)
})

test('AC-008 逐段判断：管道、&& 与多行里的任意一段不命中就拒绝', () => {
    assert.equal(checkShellAllowlist('git log --oneline | head -5', []).allowed, false)
    assert.equal(checkShellAllowlist('git log | head', ['git log', 'head']).allowed, true)
    assert.equal(checkShellAllowlist('git log | sh', ['git log']).allowed, false)
    assert.equal(checkShellAllowlist('git status && rsync -a src/ /tmp/', ['git status']).allowed, false)
    assert.equal(checkShellAllowlist('ls\nrsync a b', ['ls']).allowed, false)
    // 命令替换里藏着一条 token 遍历看不见的命令 → fail closed。
    const hidden = checkShellAllowlist('git status $(rm -rf src)', DEFAULT_SHELL_ALLOWLIST)
    assert.equal(hidden.allowed, false)
    assert.match(String(hidden.allowed ? '' : hidden.denial.hidden), /\$\(/)
})

test('AC-009 项目级不能切到 allowlist，也不能关掉检查（只能收紧）', () => {
    const projectPolicy = (project: Record<string, unknown>, host: Record<string, unknown> = {}) => {
        const cwd = tempWorkspace('spec-gate-allowlist-policy-')
        fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
        fs.writeFileSync(path.join(cwd, '.dsh', 'spec-gate.json'), JSON.stringify(project))
        return resolveEffectiveConfig(resolveConfig(host), new MissionStoreRegistry().for(cwd).layout)
    }
    const toAllowlist = projectPolicy({ shellPolicy: 'allowlist' })
    assert.equal(toAllowlist.config.shellPolicy, 'targets', '项目不能自行切到 allowlist')
    assert.ok(toAllowlist.problems.some((problem) => /只能由宿主决定/.test(problem)))
    const toOff = projectPolicy({ shellPolicy: 'off' })
    assert.equal(toOff.config.shellPolicy, 'targets', '项目不能关掉 shell 检查')
    // 宿主选了 allowlist 时，项目也不能把它放宽回 targets。
    const relaxed = projectPolicy({ shellPolicy: 'targets' }, { shellPolicy: 'allowlist' })
    assert.equal(relaxed.config.shellPolicy, 'allowlist')
    // 收紧是允许的（既有语义：项目只能在宿主上限之内细化）。
    const tightened = projectPolicy({ shellPolicy: 'strict' })
    assert.equal(tightened.config.shellPolicy, 'strict')
})

test('allowlist 模式在审批之前也拒绝未列出的命令（R-002）', async () => {
    const fake = allowlistHost()
    await fake.runTool('spec_create', DRAFT)
    const denied = shell(fake, 'mycmd --x') ?? ''
    assert.match(denied, /shellAllowlist/)
    assert.match(denied, /mycmd/)
    // 列出的只读命令在审批之前仍然可用（与 targets 模式一致）。
    assert.equal(shell(fake, 'git status'), undefined)
})

test('allowlist 模式仍然执行既有的信任根与边界检查', async () => {
    const fake = allowlistHost({ profile: { shellAllowlist: [...DEFAULT_SHELL_ALLOWLIST, 'bash', 'echo', 'touch'] } })
    await approved(fake)
    // 命中 allowlist，但写入信任根 → 仍被信任根检查拒绝。
    assert.match(shell(fake, 'echo x > .dsh/missions/m1/mission.json') ?? '', /信任根/)
    // 命中 allowlist，但目标在文件边界外 → 仍被边界检查拒绝。
    assert.match(shell(fake, 'touch outside.ts') ?? '', /不在规格声明的文件边界内/)
    // 命中 allowlist 且目标在边界内 → 放行。
    assert.equal(shell(fake, 'touch src/server.ts'), undefined)
})

test('allowlist 模式下找不到命令参数仍然 fail closed', async () => {
    const fake = allowlistHost()
    await approved(fake)
    assert.match(fake.guardReason({ name: 'bash', arguments: {}, agent: fake.agent }) ?? '', /找不到命令参数/)
})

test('spec_status 报告 allowlist 策略（运维可见）', async () => {
    const fake = allowlistHost()
    const status = runText(await fake.runTool('spec_status', {}))
    assert.match(status, /策略 allowlist/)
})

/**
 * P3.2 — which conversation an approval belongs to is a WORKSPACE decision.
 *
 * P0/P1 gave the host ONE approval conversation and ONE approver list. That is
 * the right default and it is wrong the moment one host serves several
 * repositories: a card raised for repository A lands in repository B's
 * conversation, and B's approvers are asked to approve A's work. The mapping
 * (`im.approvals`) fixes that, and every case below is about WHO decides the
 * destination, not about the card plumbing:
 *
 *  - TC-961: two workspaces resolve to their own conversation AND their own
 *    approvers (the other workspace's approver is refused here);
 *  - TC-962: `/a` and `/a/b` both claim a workspace under `/a/b` — the more
 *    specific entry wins;
 *  - TC-963: an entry that omits `approvers` falls back to the host list, and the
 *    status SAYS it fell back;
 *  - TC-964: two entries of equal specificity are a REFUSAL naming both, never a
 *    coin flip;
 *  - TC-965: an unmapped workspace under `unmappedWorkspace=refuse` is refused
 *    before any card, with the entry to add;
 *  - TC-966: a session started through a SYMLINK still matches the entry written
 *    for the real path (the resolution uses `realpath`);
 *  - TC-967: a project file that writes `im.approvals` is ignored with a problem;
 *  - TC-968: an unmapped workspace under `unmappedWorkspace=host-default` uses
 *    `im.approvalChatId` + the host list.
 *
 * TC-969 is the verification run itself (two consecutive
 * `bash scripts/verify.sh --quiet`, exit 0), not a unit case.
 *
 * Two rules these tests are built around, both learned the hard way in this
 * repository:
 *
 *  - every assembly PINS `im.approversFile` to a path that cannot exist on the
 *    developer's machine (a real `~/.dsh/interaction-approvers.txt` once turned a
 *    "no list" case into a 900-second hang);
 *  - every ask carries an explicit short `timeoutMs`, so a failed assertion can
 *    never park the runner behind the product's 900-second default.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, resolveConfig, resolveEffectiveConfig } from '../dist/index.js'
import { refusalOf } from '../dist/ledger.js'
import { resolveApprovalRouting, resolveWorkspaceApprovals, specificityOf, workspaceMatches } from '../dist/workspace-mapping.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
/** A short ask deadline: a failing assertion must fail fast, not hang the runner. */
const ASK_TIMEOUT_MS = 2_000
/**
 * A host-side approver path that CANNOT exist: every assembly pins it, so a real
 * `~/.dsh/interaction-approvers.txt` can never change what these tests assert.
 */
const NO_HOST_FILE = path.join(tempWorkspace('dsh-host-approvers-'), 'approvers.txt')
/** Logs live OUTSIDE the workspaces (a workspace is a fixture, not a scratch pad). */
const LOG_DIR = tempWorkspace('dsh-workspace-mapping-log-')
let logCount = 0

/** The real path of a fixture directory (`/var/…` and `/private/var/…` are one place). */
const real = (target: string): string => fs.realpathSync(target)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const hosts: FakeHost[] = []
after(() => {
    for (const host of hosts) host.dispose()
})

/** A scripted channel: the stand-in for whatever surface actually asks the person. */
interface ScriptedChannel {
    name: string
    sent: Record<string, any>[]
    channel: any
    waits: () => number
    answered: () => number
    answer: (value: string, by: string, chatId: string) => void
}

function scriptedChannel(name: string): ScriptedChannel {
    const sent: Record<string, any>[] = []
    let waiter: ((value: unknown) => void) | undefined
    let waits = 0
    let answers = 0
    const channel: any = {
        name,
        async send(message: Record<string, any>) {
            sent.push(message)
            return { ok: true, messageId: `m-${sent.length}` }
        },
        async wait(): Promise<unknown> {
            waits += 1
            return await new Promise((resolve) => {
                waiter = resolve
            })
        },
        describe: () => ({ canAsk: true, canNotify: true }),
    }
    return {
        name,
        sent,
        channel,
        waits: () => waits,
        answered: () => answers,
        answer(value: string, by: string, chatId: string): void {
            assert.ok(waiter !== undefined, `${name} 没有进入等待状态`)
            const resolve = waiter as (value: unknown) => void
            waiter = undefined
            answers += 1
            // Provenance travels with every answer: the card named a conversation
            // (`im(workspace)` → `im.approvals`), and the post-answer check proves
            // the answer came from it (`chatId`) and from a p2p chat (`chatKind`,
            // because `im.p2pOnly` defaults to true). An answer that claims no
            // conversation is `refused:wrong-chat` — in these tests and in life.
            resolve({ value, by, chatId, chatKind: 'p2p' })
        },
    }
}

/** Answer the channel's NEXT question once it has reached its wait. */
async function answerWith(scripted: ScriptedChannel, value: string, by: string, chatId: string): Promise<void> {
    const target = scripted.answered() + 1
    for (let index = 0; index < 2_000 && scripted.waits() < target; index += 1) await sleep(1)
    assert.ok(scripted.waits() >= target, `${scripted.name} 没有进入等待状态（waits=${scripted.waits()}）`)
    scripted.answer(value, by, chatId)
}

/** Pin the host approver file (see the module comment) and keep any declared `im` keys. */
function pinned(config: Record<string, unknown>): Record<string, unknown> {
    const im = typeof config['im'] === 'object' && config['im'] !== null ? (config['im'] as Record<string, unknown>) : {}
    return { ...config, im: { approversFile: NO_HOST_FILE, ...im } }
}

/** Assemble the real plugin in a throwaway workspace. */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost & { registry: any } {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    logCount += 1
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `log-${logCount}.log`), ...pinned(config) })
    return Object.assign(fake, { registry: (fake.ctx as { get: (name: string) => unknown }).get('interaction') })
}

function rowsOf(cwd: string): Record<string, any>[] {
    const file = path.join(cwd, LEDGER)
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, any>)
}

/** The IM target the last card was sent with (`undefined` = no explicit target). */
function sentTarget(scripted: ScriptedChannel): Record<string, any> | undefined {
    return scripted.sent.at(-1)?.im
}

test('TC-961 两个工作区各配一条映射：各自使用自己那条的会话与审批人', async () => {
    const first = tempWorkspace('workspace-mapping-a-')
    const second = tempWorkspace('workspace-mapping-b-')
    const config = {
        requireApproverList: true,
        im: {
            approvals: [
                { workspace: real(first), chatId: 'oc_alpha_1', approvers: ['ou_alice'] },
                { workspace: real(second), chatId: 'oc_beta_1', approvers: ['ou_bob'] },
            ],
        },
    }
    const hostA = host(first, config)
    const hostB = host(second, config)
    const channelA = scriptedChannel('im')
    const channelB = scriptedChannel('im')
    hostA.registry.register(channelA.channel)
    hostB.registry.register(channelB.channel)

    const runningA = hostA.runTool('interaction_ask', { question: 'A 的这次交付可以放出去吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channelA, 'yes', 'ou_alice', 'oc_alpha_1')
    assert.equal((await runningA).isError, false)

    const runningB = hostB.runTool('interaction_ask', { question: 'B 的这次交付可以放出去吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channelB, 'yes', 'ou_bob', 'oc_beta_1')
    assert.equal((await runningB).isError, false)

    // The two cards went to two conversations, each with its own whitelist.
    assert.equal(sentTarget(channelA)?.chatId, 'oc_alpha_1')
    assert.equal(sentTarget(channelB)?.chatId, 'oc_beta_1')
    assert.deepEqual(sentTarget(channelA)?.from, ['ou_alice'])
    assert.deepEqual(sentTarget(channelB)?.from, ['ou_bob'])

    // …and the lists are not interchangeable: B's approver cannot answer in A.
    const refused = hostA.runTool('interaction_ask', { question: 'A 的另一个问题，换个会话能不能答？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channelA, 'yes', 'ou_bob', 'oc_alpha_1')
    const outcome = await refused
    assert.equal(outcome.isError, true, runText(outcome))
    assert.ok(runText(outcome).includes('refused:unauthorized'), runText(outcome))

    const statusA = runText(await hostA.runTool('interaction_status', {}))
    assert.ok(statusA.includes('命中 im.approvals[0]'), statusA)
    assert.ok(statusA.includes('审批人 1 个，来自该映射项'), statusA)
})

test('TC-962 /a 与 /a/b 都命中：更具体的 /a/b 胜出', async () => {
    const base = tempWorkspace('workspace-mapping-nest-')
    const nested = path.join(base, 'sub')
    fs.mkdirSync(nested, { recursive: true })
    const fake = host(nested, {
        im: {
            approvals: [
                { workspace: real(base), chatId: 'oc_base_level' },
                { workspace: real(nested), chatId: 'oc_nested_level' },
            ],
            approvalChatId: 'oc_host_default',
            // Both entries omit approvers, so the HOST list is the whitelist —
            // and a configured target without one refuses before any card.
            approvers: ['ou_host_one'],
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: '嵌套工作区的审批发到哪儿？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channel, 'yes', 'ou_host_one', 'oc_nested_level')
    assert.equal((await running).isError, false)

    assert.equal(sentTarget(channel)?.chatId, 'oc_nested_level', '更长的字面前缀必须胜出')
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('命中 im.approvals[1]'), status)
})

test('TC-963 映射项省略 approvers：回落到宿主名单，并在 status 里说明是回落', async () => {
    const cwd = tempWorkspace('workspace-mapping-fallback-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: real(cwd), chatId: 'oc_mapped_room' }],
            approvers: ['ou_host_one', 'ou_host_two'],
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: '这条由谁回答？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channel, 'yes', 'ou_host_two', 'oc_mapped_room')
    assert.equal((await running).isError, false)

    // The conversation came from the mapping, the whitelist from the host.
    assert.equal(sentTarget(channel)?.chatId, 'oc_mapped_room')
    assert.deepEqual(sentTarget(channel)?.from, ['ou_host_one', 'ou_host_two'])

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('审批人 **回落到宿主名单**'), status)
    assert.ok(status.includes('该条没有声明 approvers'), status)
    assert.ok(status.includes('有效 2 个 id'), status)
})

test('TC-964 两条同等具体的映射命中同一工作区：拒绝并点名两条，不随机选', async () => {
    const cwd = tempWorkspace('workspace-mapping-ambiguous-')
    const fake = host(cwd, {
        im: {
            approvals: [
                { workspace: real(cwd), chatId: 'oc_left_room' },
                { workspace: real(cwd), chatId: 'oc_right_room' },
            ],
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const run = await fake.runTool('interaction_ask', { question: '歧义时卡片发哪儿？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:ambiguous-workspace-mapping'), text)
    assert.ok(text.includes('im.approvals[0]'), `必须点名第一条：${text}`)
    assert.ok(text.includes('im.approvals[1]'), `必须点名第二条：${text}`)
    assert.ok(text.includes('不替人挑一条') || text.includes('随机挑一条'), text)
    assert.equal(channel.sent.length, 0, '歧义时一张卡片都不发')
    assert.equal(rowsOf(cwd).at(-1)?.decision, refusalOf('ambiguous-workspace-mapping'))

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('**歧义**'), status)
})

test('TC-965 工作区未映射且 unmappedWorkspace=refuse（默认）：refused:no-workspace-mapping 并给出加映射的方法', async () => {
    const cwd = tempWorkspace('workspace-mapping-unmapped-')
    const elsewhere = tempWorkspace('workspace-mapping-elsewhere-')
    const fake = host(cwd, {
        im: {
            approvals: [{ workspace: real(elsewhere), chatId: 'oc_other_project' }],
            approvalChatId: 'oc_host_default',
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const run = await fake.runTool('interaction_ask', { question: '没有映射的仓库能审批吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:no-workspace-mapping'), text)
    assert.ok(text.includes(real(cwd)), `必须点名工作区（解析后的路径）：${text}`)
    assert.ok(text.includes('im.approvals'), '必须说明怎么加映射')
    assert.ok(text.includes('im.unmappedWorkspace'), text)
    assert.equal(channel.sent.length, 0, '未命中且策略为 refuse 时一张卡片都不发，也绝不回落宿主默认会话')
    assert.equal(rowsOf(cwd).at(-1)?.decision, refusalOf('no-workspace-mapping'))

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('未命中'), status)
    assert.ok(status.includes('refused:no-workspace-mapping'), status)
})

test('TC-966 工作区经符号链接访问：按 realpath 命中真实工作区那条（不是未命中）', async () => {
    const target = tempWorkspace('workspace-mapping-real-')
    const linkParent = tempWorkspace('workspace-mapping-link-')
    const link = path.join(linkParent, 'through-symlink')
    fs.symlinkSync(target, link, 'dir')
    // The session's cwd is the LINK; the mapping is written for the REAL path.
    assert.notEqual(link, real(target), '前提：链接路径与真实路径不同')
    const fake = host(link, {
        im: { approvals: [{ workspace: real(target), chatId: 'oc_real_workspace', approvers: ['ou_alice'] }] },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: '从链接路径发起的审批去哪？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channel, 'yes', 'ou_alice', 'oc_real_workspace')
    assert.equal((await running).isError, false, '符号链接不是"未映射"')

    assert.equal(sentTarget(channel)?.chatId, 'oc_real_workspace')
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('命中 im.approvals[0]'), status)
    assert.ok(status.includes(`realpath ${real(target)}`), `status 要说明比较的是 realpath：${status}`)
})

test('TC-967 项目配置里写 im.approvals：被忽略并记问题，宿主映射不受影响', async () => {
    const cwd = tempWorkspace('workspace-mapping-project-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'interaction-gate.json'),
        `${JSON.stringify({ im: { approvals: [{ workspace: cwd, chatId: 'oc_project_chosen' }] } }, null, 2)}\n`,
        'utf8',
    )

    const problems: string[] = []
    const resolved = resolveConfig({ im: { approvals: [{ workspace: real(cwd), chatId: 'oc_host_chosen' }], approversFile: NO_HOST_FILE } }, (message) =>
        problems.push(message),
    )
    const effective = resolveEffectiveConfig(resolved, resolveLayout(cwd), undefined)
    const joined = effective.problems.join('\n')
    assert.ok(joined.includes('"im" 不允许在项目级配置里覆盖'), joined)
    assert.ok(joined.includes('im.approvals'), `问题必须点名新增的宿主键：${joined}`)
    assert.equal(effective.config.im.approvals.length, 1, '项目文件不能增删宿主映射')
    assert.equal(effective.config.im.approvals[0]?.chatId, 'oc_host_chosen', '宿主的映射项仍是唯一权威')

    // End to end: the project's entry decides nothing — the card goes to the
    // host's conversation, never to the one the repository wrote down.
    const fake = host(cwd, { im: { approvals: [{ workspace: real(cwd), chatId: 'oc_host_chosen' }], approvers: ['ou_host_one'] } })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)
    const running = fake.runTool('interaction_ask', { question: '仓库自己写的映射生效了吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channel, 'yes', 'ou_host_one', 'oc_host_chosen')
    assert.equal((await running).isError, false)
    assert.equal(sentTarget(channel)?.chatId, 'oc_host_chosen')

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('条配置问题'), status)
})

test('TC-968 未映射且 unmappedWorkspace=host-default：使用 im.approvalChatId 与宿主名单', async () => {
    const cwd = tempWorkspace('workspace-mapping-default-')
    const elsewhere = tempWorkspace('workspace-mapping-default-other-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: real(elsewhere), chatId: 'oc_other_project' }],
            unmappedWorkspace: 'host-default',
            approvalChatId: 'oc_host_default',
            approvers: ['ou_host_one'],
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: 'host-default 策略下卡片去哪？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(channel, 'yes', 'ou_host_one', 'oc_host_default')
    assert.equal((await running).isError, false)

    assert.equal(sentTarget(channel)?.chatId, 'oc_host_default')
    assert.deepEqual(sentTarget(channel)?.from, ['ou_host_one'])

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('im.unmappedWorkspace=host-default'), status)
    assert.ok(status.includes('回落到 im.approvalChatId'), status)
})

test('映射项声明了空 approvers：拒绝发问（approvers-missing），绝不悄悄退回宿主名单', async () => {
    const cwd = tempWorkspace('workspace-mapping-empty-list-')
    const fake = host(cwd, {
        im: {
            approvals: [{ workspace: real(cwd), chatId: 'oc_nobody_room', approvers: [] }],
            approvers: ['ou_host_one'],
            approvalChatId: 'oc_host_default',
        },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const run = await fake.runTool('interaction_ask', { question: '空名单的工作区谁能批？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:approvers-missing'), text)
    assert.ok(text.includes('im.approvals[0]'), `必须点名命中的映射项：${text}`)
    assert.ok(text.includes('`approvers: []` 是"谁也不能批"'), text)
    assert.equal(channel.sent.length, 0, '空名单时一张卡片都不发（也不退回宿主名单）')

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('审批人 0 个，来自该映射项'), status)
})

test('解析规则：/a 只在路径边界上匹配 /a/b（不匹配 /ab）；* 一段、** 任意深度', () => {
    assert.equal(workspaceMatches('/a', '/a'), true)
    assert.equal(workspaceMatches('/a', '/a/b'), true)
    assert.equal(workspaceMatches('/a', '/ab'), false, '前缀必须在路径边界上')
    assert.equal(workspaceMatches('/a/', '/a/b'), true, '尾斜杠不改变匹配')
    assert.equal(workspaceMatches('/w/*', '/w/one'), true)
    assert.equal(workspaceMatches('/w/*', '/w/one/two'), false, '* 只匹配一段')
    assert.equal(workspaceMatches('/w/**', '/w'), true, '** 也匹配零段')
    assert.equal(workspaceMatches('/w/**', '/w/one/two/three'), true)
    assert.equal(workspaceMatches('/w/**/end', '/w/end'), true, '** 在中间时可以是零段')
    assert.equal(workspaceMatches('/w/**/end', '/w/a/b/end'), true)

    // Specificity: longer literal prefix wins, then fewer wildcards (`**` = two).
    assert.equal(specificityOf('/a/b').literalPrefix, '/a/b')
    assert.equal(specificityOf('/a/**').literalPrefix, '/a', '尾斜杠不计入字面前缀')
    assert.equal(specificityOf('/a/**').wildcardCount, 2)
    assert.equal(specificityOf('/a/*').wildcardCount, 1)
})

test('解析规则：最具体者胜、同分拒绝、未解析的工作区按未命中说清楚', () => {
    const entries = [
        { workspace: '/w', chatId: 'oc_root' },
        { workspace: '/w/*', chatId: 'oc_one' },
        { workspace: '/w/deep/**', chatId: 'oc_deep' },
    ]
    const routing = (workspace: string): ReturnType<typeof resolveApprovalRouting> =>
        resolveApprovalRouting({ workspace, entries, declared: 3, policy: 'refuse', hostChatId: 'oc_default', realpath: (candidate) => candidate })

    assert.equal(routing('/w/deep/x').matched?.entry.chatId, 'oc_deep', '最长的字面前缀胜出')
    // A plain key is the most specific key OF ITS DEPTH: `/w` and `/w/*` have the
    // same literal prefix, so the documented tiebreak ("fewest wildcards") gives
    // the plain key the direct child as well. A host that wants one child to have
    // its own conversation writes that child's path (a LONGER literal prefix) —
    // which is the shape every real deployment uses.
    assert.equal(routing('/w/one').matched?.entry.chatId, 'oc_root')
    assert.equal(routing('/w').matched?.entry.chatId, 'oc_root')
    assert.equal(routing('/elsewhere').chatId, '', '未命中且策略 refuse 时没有目标')
    assert.equal(routing('/elsewhere').matched, undefined)

    // Two entries of equal specificity both claim the workspace: no answer.
    const notATie = resolveApprovalRouting({
        workspace: '/t/a/x',
        entries: [
            { workspace: '/t/*/x', chatId: 'oc_left' },
            { workspace: '/t/**', chatId: 'oc_right' },
        ],
        declared: 2,
        policy: 'refuse',
        hostChatId: '',
        realpath: (candidate) => candidate,
    })
    // `/t/*/x` = literal prefix `/t` + 1 wildcard; `/t/**` = `/t` + 2 → the first
    // one is more specific, so this pair is NOT a tie (documented rule).
    assert.equal(notATie.matched?.entry.chatId, 'oc_left')

    const realTie = resolveApprovalRouting({
        workspace: '/t/a/x',
        entries: [
            { workspace: '/t/*/**', chatId: 'oc_left' },
            { workspace: '/t/**/*', chatId: 'oc_right' },
        ],
        declared: 2,
        policy: 'refuse',
        hostChatId: '',
        realpath: (candidate) => candidate,
    })
    assert.equal(realTie.matched, undefined)
    assert.equal(realTie.conflict?.candidates.length, 2, '同分必须拒绝，并点名两条')

    // An unresolvable workspace is unmatched, and the routing SAYS why.
    const unresolved = resolveApprovalRouting({
        workspace: '/gone',
        entries: [{ workspace: '/gone', chatId: 'oc_never' }],
        declared: 1,
        policy: 'refuse',
        hostChatId: '',
        realpath: () => undefined,
    })
    assert.equal(unresolved.matched, undefined, '未解析的路径不参与匹配')
    assert.notEqual(unresolved.realpathProblem, undefined)
    assert.match(unresolved.realpathProblem ?? '', /realpath/)
})

test('配置校验：不可用的条目被报告且不贡献任何会话/审批人；一条坏 id 也不允许"偷偷退回宿主名单"', () => {
    const problems: string[] = []
    const declaration = resolveWorkspaceApprovals(
        [
            { workspace: 'relative/path', chatId: 'oc_a' },
            { workspace: '/abs/path', chatId: '' },
            { workspace: '/abs/path', chatId: 'oc_ok', approvers: ['ou_alice', 42] },
            { workspace: '/abs/path', chatId: 'oc_empty_list', approvers: [] },
            'not-an-object',
            { workspace: '/abs/path/', chatId: 'oc_good' },
        ],
        (message) => problems.push(message),
    )
    assert.equal(declaration.declared, 6, '声明条数包含不可用的条目')
    assert.equal(declaration.entries.length, 2, '只有两条可用')
    assert.equal(problems.length, 4, problems.join('\n'))
    assert.ok(problems.some((problem) => problem.includes('不是绝对路径')), problems.join('\n'))
    assert.ok(problems.some((problem) => problem.includes('chatId 必须是非空字符串')), problems.join('\n'))
    assert.ok(problems.some((problem) => problem.includes('approvers 里有非字符串')), problems.join('\n'))
    assert.ok(problems.some((problem) => problem.includes('必须是对象')), problems.join('\n'))
    // An explicit empty list is a REAL state (nobody may approve), not "unset".
    assert.deepEqual(declaration.entries[0]?.approvers, [], 'approvers: [] 是"谁也不能批"，不是"用宿主名单"')
    assert.equal(declaration.entries[1]?.approvers, undefined, '省略 approvers 才是回落')
    assert.equal(declaration.entries[1]?.workspace, '/abs/path', '尾斜杠被规范化')

    // The default is "no mapping declared": no entry, no problem, no policy.
    const defaults = resolveWorkspaceApprovals(undefined)
    assert.deepEqual(defaults.entries, [])
    assert.equal(defaults.declared, 0)
    assert.equal(resolveConfig({}).im.unmappedWorkspace, 'refuse', '未映射默认拒绝')
    assert.equal(resolveConfig({}).im.approvalsDeclared, 0)
    // An unusable policy keeps the strict default and says so.
    const policyProblems: string[] = []
    const configured = resolveConfig({ im: { unmappedWorkspace: 'host-default' } }, (message) => policyProblems.push(message))
    assert.equal(configured.im.unmappedWorkspace, 'host-default')
    const broken = resolveConfig({ im: { unmappedWorkspace: 'whatever' } }, (message) => policyProblems.push(message))
    assert.equal(broken.im.unmappedWorkspace, 'refuse', '拼错不会放松策略')
    assert.ok(policyProblems.some((problem) => problem.includes('im.unmappedWorkspace')), policyProblems.join('\n'))
})

test('TC-992 未命中 + local：interaction_ask 不碰 IM，改由本地通道回答', async () => {
    const cwd = tempWorkspace('workspace-mapping-local-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: '/definitely/elsewhere', chatId: 'oc_other_room' }],
            approvalChatId: 'oc_should_not_be_used',
            approvers: ['ou_alice'],
            unmappedWorkspace: 'local',
        },
    })
    const im = scriptedChannel('chat-interaction')
    const local = scriptedChannel('local-tui')
    fake.registry.register(im.channel)
    fake.registry.register(local.channel)

    const running = fake.runTool('interaction_ask', { question: '这个工作区放行吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    await answerWith(local, 'yes', 'ou_alice', 'oc_local')
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.equal(im.sent.length, 0, 'local 策略下 IM 不该收到任何卡片')
    assert.equal(local.sent.length, 1, 'local 通道才是提问的那一方')
})

test('TC-996 未命中 + local：显式 prefer IM 是冲突，绝不改发到别的通道', async () => {
    const cwd = tempWorkspace('workspace-mapping-local-prefer-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: '/definitely/elsewhere', chatId: 'oc_other_room' }],
            approvalChatId: 'oc_should_not_be_used',
            approvers: ['ou_alice'],
            unmappedWorkspace: 'local',
        },
    })
    const im = scriptedChannel('chat-interaction')
    const local = scriptedChannel('local-tui')
    fake.registry.register(im.channel)
    fake.registry.register(local.channel)

    const run = await fake.runTool('interaction_ask', {
        question: '这个工作区放行吗？',
        options: ['yes'],
        prefer: 'chat-interaction',
        timeoutMs: ASK_TIMEOUT_MS,
    })
    assert.equal(run.isError, true, runText(run))
    assert.ok(runText(run).includes('被排除'), runText(run))
    assert.equal(im.sent.length, 0)
    assert.equal(local.sent.length, 0, '冲突时不能悄悄换通道')
})

test('TC-995 未命中 + local 且只有 IM 一个通道：按没有通道能问人拒绝，IM 仍然不发卡', async () => {
    const cwd = tempWorkspace('workspace-mapping-local-nochannel-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: '/definitely/elsewhere', chatId: 'oc_other_room' }],
            approvalChatId: 'oc_should_not_be_used',
            approvers: ['ou_alice'],
            unmappedWorkspace: 'local',
        },
    })
    const im = scriptedChannel('chat-interaction')
    fake.registry.register(im.channel)

    const run = await fake.runTool('interaction_ask', { question: '这个工作区放行吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    assert.equal(run.isError, true, runText(run))
    assert.ok(runText(run).includes('refused:no-channel'), runText(run))
    assert.equal(im.sent.length, 0, 'IM 被排除，即使它是唯一注册的通道')
})

test('TC-997 未命中 + refuse（默认）：仍然在发卡前拒绝，语义未变', async () => {
    const cwd = tempWorkspace('workspace-mapping-refuse-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: {
            approvals: [{ workspace: '/definitely/elsewhere', chatId: 'oc_other_room' }],
            approvalChatId: 'oc_default_room',
            approvers: ['ou_alice'],
        },
    })
    const im = scriptedChannel('chat-interaction')
    fake.registry.register(im.channel)

    const run = await fake.runTool('interaction_ask', { question: '这个工作区放行吗？', options: ['yes'], timeoutMs: ASK_TIMEOUT_MS })
    assert.equal(run.isError, true, runText(run))
    assert.ok(runText(run).includes('refused:no-workspace-mapping'), runText(run))
    assert.equal(im.sent.length, 0)
})

/**
 * P3.1 — the approver list is HOST-owned; a repository may only SUBTRACT.
 *
 * The hole this closes was real: `approversFile` was one of the keys a
 * repository could refine, and it resolved to a file INSIDE the workspace
 * (`.dsh/interaction-approvers.txt`). So a repository could commit its own
 * approver list and whitelist itself — "approval is a permission" (P1) defeated
 * by the half nobody watched.
 *
 * Every case below is about WHO decides the whitelist, not about the answer
 * plumbing:
 *
 *  - TC-931: the host's inline list is used as-is (two ids, either may answer);
 *  - TC-932: the project's `denyApprovers` subtracts (the denied id's answer is
 *    refused and does not become a decision);
 *  - TC-933: an empty host list with a repository file full of ids → REFUSED
 *    before any card, because the file is not read (never a fallback);
 *  - TC-934: a project file that still sets `approversFile` is ignored WITH a
 *    reported problem (and the host list is unaffected);
 *  - TC-935: an id that only exists in the repository file is not accepted.
 *
 * Acceptance cases: TC-931..935 of the approved specification
 * `p3-1-approvers-approversfile-den-20261109-135236` (TC-937 = two consecutive
 * `bash scripts/verify.sh --quiet` runs, exit 0).
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
import { DEFAULT_APPROVERS_FILE, LEGACY_PROJECT_APPROVERS_FILE } from '../dist/config.js'
import { refusalOf } from '../dist/ledger.js'

const LEDGER = '.dsh/interaction/decisions.jsonl'
const LEGACY = LEGACY_PROJECT_APPROVERS_FILE
/** A host-side approver path that cannot exist (keeps the machine's `~/.dsh` out). */
const NO_HOST_FILE = path.join(tempWorkspace('interaction-host-approvers-'), 'approvers.txt')

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
    /** How many times the ask engine entered `wait()` (one per question). */
    waits: () => number
    /** How many answers this channel has already delivered. */
    answered: () => number
    answer: (value: string, by: string) => void
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
        answer(value: string, by: string): void {
            assert.ok(waiter !== undefined, `${name} 没有进入等待状态`)
            const resolve = waiter as (value: unknown) => void
            waiter = undefined
            answers += 1
            resolve({ value, by })
        },
    }
}

/** Answer the channel's NEXT question once it has reached its wait. */
async function answerWith(scripted: ScriptedChannel, value: string, by: string): Promise<void> {
    const target = scripted.answered() + 1
    for (let index = 0; index < 2_000 && scripted.waits() < target; index += 1) await sleep(1)
    assert.ok(scripted.waits() >= target, `${scripted.name} 没有进入等待状态（waits=${scripted.waits()}）`)
    scripted.answer(value, by)
}

/** Assemble the real plugin in a throwaway workspace. */
function host(cwd: string, config: Record<string, unknown> = {}): FakeHost & { registry: any } {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'interaction-gate.log'), ...config })
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

/** Write the PRE-P3.1 repository list (the file that must no longer decide anything). */
function writeLegacyApprovers(cwd: string, ids: string[]): string {
    const file = path.join(cwd, LEGACY)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# approvers\n${ids.map((id) => `${id}\n`).join('')}`, 'utf8')
    return file
}

/** Write a project config (`<repo>/.dsh/interaction-gate.json`). */
function writeProjectConfig(cwd: string, value: Record<string, unknown>): void {
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

test('TC-931 宿主 im.approvers 的两人都可以回答：有效名单就是宿主的那两个 id', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    const fake = host(cwd, {
        requireApproverList: true,
        im: { approvers: ['ou_alice', 'ou_bob'], approversFile: NO_HOST_FILE },
    })
    const channel = scriptedChannel('local')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: '这条交付可以放出去吗？', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_bob')
    const run = await running
    assert.equal(run.isError, false, runText(run))
    assert.ok(runText(run).includes('宿主审批人名单：2 个 id'), runText(run))

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('来源 im.approvers（2 个内联 id）'), status)
    assert.ok(status.includes('有效 2 个 id'), status)
    assert.ok(status.includes('项目减法（denyApprovers）：去掉 0 个 id'), status)

    const rows = rowsOf(cwd)
    assert.equal(rows.at(-1)?.decision, 'allowed-once')
    assert.equal(rows.at(-1)?.userId, 'ou_bob')
})

test('TC-932 项目 denyApprovers 减去一个 id：被 deny 的人回答不生效（unavailable/refused），台账如实记', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    writeProjectConfig(cwd, { denyApprovers: ['OU_BOB'] }) // 大小写不敏感，和其余名单比较一致
    const fake = host(cwd, {
        requireApproverList: true,
        im: { approvers: ['ou_alice', 'ou_bob'], approversFile: NO_HOST_FILE },
    })
    const channel = scriptedChannel('local')
    fake.registry.register(channel.channel)

    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_bob')
    const refused = await running
    assert.equal(refused.isError, true, runText(refused))
    assert.ok(runText(refused).includes('refused:unauthorized'), runText(refused))
    const rows = rowsOf(cwd)
    assert.equal(rows.at(-1)?.decision, refusalOf('unauthorized'))
    assert.equal(rows.some((row) => row.decision === 'allowed-once'), false, '被 deny 的回答不得成为决定')

    // The subtraction is stated, not inferred: the count and BOTH sources appear.
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('有效 1 个 id'), status)
    assert.ok(status.includes('项目减法（denyApprovers）：去掉 1 个 id'), status)
    assert.ok(status.includes('宿主 im.denyApprovers 0 个 + 项目级 1 个'), status)
    assert.ok(status.includes('仓库只能减，永远不能加'), status)

    // The other host id still answers: subtraction did not break the list. The
    // same channel is reused on purpose — `interaction_ask` takes the FIRST
    // usable candidate, so a second channel would never see the question.
    const accepted = fake.runTool('interaction_ask', { question: '再问一次', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_alice')
    assert.equal((await accepted).isError, false, '宿主名单里未被 deny 的人仍然可以回答')
})

test('TC-933 宿主名单为空而仓库里有名单文件：发卡之前就拒绝（refused:approvers-missing），绝不回落仓库文件', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    const legacy = writeLegacyApprovers(cwd, ['ou_carol', 'ou_dave'])
    const fake = host(cwd, {
        // Approval goes over IM: a target is configured, so a card WOULD be sent.
        im: { approvers: [], approversFile: NO_HOST_FILE, approvalChatId: 'oc_approvals' },
    })
    const channel = scriptedChannel('im')
    fake.registry.register(channel.channel)

    const run = await fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    assert.equal(run.isError, true)
    const text = runText(run)
    assert.ok(text.includes('refused:approvers-missing'), text)
    assert.ok(text.includes('宿主审批人名单为空'), text)
    assert.ok(text.includes(legacy), `要指出那个文件的存在（但不会被读取）：${text}`)
    assert.ok(text.includes('不再被读取'), text)
    assert.ok(text.includes(DEFAULT_APPROVERS_FILE), '下一步必须指向宿主侧名单位置')
    assert.equal(channel.sent.length, 0, '名单为空时一张卡片都不发（也不许退回仓库文件）')
    assert.equal(rowsOf(cwd).at(-1)?.decision, refusalOf('approvers-missing'))
})

test('TC-934 项目配置里写 approversFile：被忽略并记问题，宿主名单不受影响', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    const repoFile = writeLegacyApprovers(cwd, ['ou_carol'])
    writeProjectConfig(cwd, { approversFile: repoFile })

    const problems: string[] = []
    const resolved = resolveConfig({ requireApproverList: true, im: { approvers: ['ou_alice'], approversFile: NO_HOST_FILE } }, (message) => problems.push(message))
    const effective = resolveEffectiveConfig(resolved, resolveLayout(cwd), undefined)
    const joined = effective.problems.join('\n')
    assert.ok(joined.includes('"approversFile" 不允许在项目级配置里覆盖'), joined)
    assert.ok(joined.includes('审批人名单的权威在宿主'), `问题必须说明迁移：${joined}`)
    assert.ok(joined.includes(LEGACY), joined)
    assert.deepEqual(effective.config.im.approvers, ['ou_alice'], '宿主名单不受项目文件影响')
    assert.equal(effective.config.im.approversFile, NO_HOST_FILE)

    // End to end: the project's key gets a reported problem and the host list
    // is the only whitelist; `interaction_status` states both facts.
    const fake = host(cwd, { requireApproverList: true, im: { approvers: ['ou_alice'], approversFile: NO_HOST_FILE } })
    const channel = scriptedChannel('local')
    fake.registry.register(channel.channel)
    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_alice')
    const run = await running
    assert.equal(run.isError, false, runText(run))

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('条配置问题'), status)
    assert.ok(status.includes('来源 im.approvers（1 个内联 id）'), status)
    assert.ok(status.includes('迁移：'), status)
    assert.ok(status.includes('已忽略并记问题'), status)

    // The ignored file's id is NOT an approver (it never enters the list).
    const refused = fake.runTool('interaction_ask', { question: '再问一次', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_carol')
    const outcome = await refused
    assert.equal(outcome.isError, true, runText(outcome))
    assert.ok(runText(outcome).includes('refused:unauthorized'), runText(outcome))
})

test('TC-935 只在仓库文件里出现的 id 不被接受：有效名单里没有它', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    writeLegacyApprovers(cwd, ['ou_carol'])
    const fake = host(cwd, { requireApproverList: true, im: { approvers: ['ou_alice'], approversFile: NO_HOST_FILE } })
    const channel = scriptedChannel('local')
    fake.registry.register(channel.channel)

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('有效 1 个 id'), status)
    assert.ok(status.includes('迁移：'), '仓库里还有旧名单这件事必须被说出来')

    const running = fake.runTool('interaction_ask', { question: '放行吗？', options: ['allowed-once', 'rejected'] })
    await answerWith(channel, 'allowed-once', 'ou_carol')
    const run = await running
    assert.equal(run.isError, true, runText(run))
    assert.ok(runText(run).includes('refused:unauthorized'), runText(run))
    assert.ok(runText(run).includes('不在宿主审批人名单里'), runText(run))
    assert.equal(rowsOf(cwd).some((row) => row.decision === 'allowed-once'), false)
})

test('宿主文件按"宿主侧路径"解析：写进 im.approversFile 的 id 生效，且与内联数组取并集去重', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    const hostFile = path.join(tempWorkspace('interaction-host-file-'), 'approvers.txt')
    fs.writeFileSync(hostFile, '# hosts\nou_alice\nou_bob\nOU_ALICE\n', 'utf8')
    const fake = host(cwd, {
        requireApproverList: true,
        im: { approvers: ['ou_carol'], approversFile: hostFile },
    })
    const channel = scriptedChannel('local')
    fake.registry.register(channel.channel)

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('有效 3 个 id'), status)
    assert.ok(status.includes('存在=true，2 个 id'), status)
})

test('不可用的宿主路径（工作区相对路径）被拒绝并报告：绝不改按工作区解析', () => {
    const problems: string[] = []
    const resolved = resolveConfig({ im: { approversFile: '.dsh/interaction-approvers.txt' } }, (message) => problems.push(message))
    assert.equal(resolved.im.approversFile, '', '相对路径不得被解析进仓库')
    assert.notEqual(resolved.im.approversFileProblem, undefined)
    assert.match(resolved.im.approversFileProblem ?? '', /宿主侧/)
    assert.equal(problems.length, 1)

    // The default is host-side, so a fresh deployment has a natural place.
    assert.equal(resolveConfig({}).im.approversFile, DEFAULT_APPROVERS_FILE)
    assert.equal(resolveConfig({}).im.denyApprovers.length, 0)
})

test('项目 denyApprovers 只能减：它无法把宿主 deny 的 id "加回来"，重复项也不会让计数说谎', async () => {
    const cwd = tempWorkspace('interaction-p31-')
    // Same id twice with different case: ONE person, so ONE subtraction.
    writeProjectConfig(cwd, { denyApprovers: ['ou_bob', 'OU_BOB'] })
    const resolved = resolveConfig(
        { im: { approvers: ['ou_alice', 'ou_bob', 'ou_carol'], approversFile: NO_HOST_FILE, denyApprovers: ['ou_bob'] } },
        () => undefined,
    )
    const effective = resolveEffectiveConfig(resolved, resolveLayout(cwd), undefined)
    // The union is monotone: the host's deny survives the project's declaration.
    assert.deepEqual(effective.config.im.denyApprovers, ['ou_bob'])
    assert.deepEqual(effective.config.im.projectDenyApprovers, ['ou_bob'], '大小写重复被折叠成一项')
    assert.deepEqual(effective.config.im.approvers, ['ou_alice', 'ou_bob', 'ou_carol'], 'deny 不修改宿主数组本身')

    // …and the report's arithmetic still adds up (no negative "host deny" count).
    const fake = host(cwd, { requireApproverList: true, im: { approvers: ['ou_alice', 'ou_bob'], approversFile: NO_HOST_FILE } })
    const status = runText(await fake.runTool('interaction_status', {}))
    assert.ok(status.includes('项目减法（denyApprovers）：去掉 1 个 id（宿主 im.denyApprovers 0 个 + 项目级 1 个'), status)

    // Both sides deny the SAME person (different case): one subtraction, and the
    // line still says "host 1 + project 1" — the host's own list is reported as
    // declared, not recomputed from a merged list that folded the duplicate.
    const both = host(cwd, {
        requireApproverList: true,
        im: { approvers: ['ou_alice', 'ou_bob'], approversFile: NO_HOST_FILE, denyApprovers: ['ou_bob'] },
    })
    const bothStatus = runText(await both.runTool('interaction_status', {}))
    assert.ok(bothStatus.includes('项目减法（denyApprovers）：去掉 1 个 id（宿主 im.denyApprovers 1 个 + 项目级 1 个'), bothStatus)
    assert.ok(bothStatus.includes('有效 1 个 id'), bothStatus)
})

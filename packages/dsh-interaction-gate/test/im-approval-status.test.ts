/**
 * `interaction_status` — the IM approval section, in one place.
 *
 * P0/P1 already rendered the pieces (`IM 审批目标`, `IM 审批应答者`,
 * `IM 被忽略的回答尝试`); this stage makes them ONE section an operator reads to
 * answer a single question: **can an approval actually be decided over IM?**
 * — mode / target conversation / approver-list size / refused-answer counters.
 *
 * Two wordings are the point and are asserted literally:
 *
 *  - `off` reads as "the host seam answers approvals; IM makes no approval
 *    decision" — the default deployment is not a warning;
 *  - a counter is `无法观测` (whether the channel is unregistered or the upstream
 *    has no `onAnswerIgnored`) when nobody can see attempts, and `没有发生` only
 *    when the hook IS attached and zero events were recorded. The two must never
 *    read the same.
 *
 * Acceptance cases: TC-922 and TC-926 of the approved specification
 * `p2-im-suite-status-doctor-intera-20261109-112119` (TC-927 = two consecutive
 * `bash scripts/verify.sh --quiet` runs, exit 0).
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

const LOG = 'interaction-gate.log'
const APPROVAL_CHAT = 'oc_approvals'

/**
 * The HOST-side allowlist (P3.1). `approversFile` is pinned to a path that does
 * not exist so the test never depends on the machine's `~/.dsh` (an allowlist is
 * host config; a developer's real file must not leak into a fixture).
 */
function hostApprovers(cwd: string, ids: string[]): Record<string, unknown> {
    return { approvers: ids, approversFile: path.join(cwd, '.dsh', 'host-approvers.txt') }
}

const hosts: FakeHost[] = []
test.after(() => {
    for (const host of hosts) host.dispose()
})

/** A fake `chatInteraction` service: enough to register the IM channel. */
function makeChat(variant: { withIgnoredHook?: boolean } = {}): {
    layer: { api: Record<string, unknown> }
    emitIgnored: (event: Record<string, unknown>) => void
} {
    let handler: ((event: Record<string, unknown>) => void) | undefined
    const api: Record<string, unknown> = {
        apiVersion: 1,
        info: () => ({ apiVersion: 1, pluginVersion: '0.3.4', channels: [] }),
        channels: () => [
            { name: 'feishu', label: '飞书', connected: true, capabilities: { cards: true, richText: true, images: false, inbound: true } },
        ],
        capabilities: () => ({ ok: true, value: { cards: true, richText: true, images: false, inbound: true } }),
        authState: () => ({ ok: true, mode: 'auto', allowlist: [], activeChat: 'oc_active', p2pChat: 'oc_p2p', listenerRole: '', listenerConnected: true, pendingQuestions: [] }),
        ask: () => new Promise(() => undefined),
    }
    if (variant.withIgnoredHook !== false) {
        api['onAnswerIgnored'] = (next: (event: Record<string, unknown>) => void): { dispose: () => void } => {
            handler = next
            return { dispose: () => (handler = undefined) }
        }
    }
    return {
        layer: { api },
        emitIgnored(event: Record<string, unknown>): void {
            assert.ok(handler !== undefined, 'adapter 必须已订阅 onAnswerIgnored')
            ;(handler as (event: Record<string, unknown>) => void)(event)
        },
    }
}


/** Assemble the real plugin (a fake IM service stands in for chatInteraction). */
function assemble(cwd: string, config: Record<string, unknown>, services: Record<string, unknown>): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, LOG), askTimeoutMs: 1_000, ...config })
    return fake
}

test('TC-922 approvalVia=fallback 且目标与名单已配置：IM 段一处显示模式/目标/名单人数/被忽略回答，并区分无法观测与没有发生', async () => {
    const cwd = tempWorkspace('interaction-p2-')
    const chat = makeChat()
    const fake = assemble(
        cwd,
        { im: { channel: 'auto', channelId: 'feishu', approvalChatId: APPROVAL_CHAT, approvalVia: 'fallback', ...hostApprovers(cwd, ['ou_alice', 'ou_bob']) } },
        { chatInteraction: chat.layer },
    )

    // One attempt from outside the whitelist: "someone tried", not "nobody answered".
    chat.emitIgnored({
        channel: 'feishu',
        chatId: APPROVAL_CHAT,
        by: 'ou_mallory',
        text: 'allowed-once',
        messageId: 'om_evil_1',
        reason: 'sender-not-allowed',
        at: Date.now(),
    })

    const status = runText(await fake.runTool('interaction_status', {}))
    // ONE section: the header, then the four facts as consecutive lines.
    const header = status.indexOf('IM 审批（IM 上能不能真的做出决定？')
    const mode = status.indexOf('IM 审批应答者（approval/request）：fallback')
    const target = status.indexOf(`IM 审批目标：${APPROVAL_CHAT}（p2pOnly=true；from 白名单 2 个 id，来自 im.approvers`)
    const approvers = status.indexOf('审批人名单（审批卡片的 from 白名单）：有效 2 个 id')
    const ignored = status.indexOf('IM 被忽略的回答尝试：1 次（发起者不在白名单 1 次，答非所问 0 次）')
    assert.ok(header >= 0, status)
    assert.ok(mode > header, `模式必须在同一段里、在标题之后：\n${status}`)
    assert.ok(target > header, status)
    assert.ok(approvers > header, status)
    assert.ok(ignored > header, status)
    // The counts and the attempts themselves (who / where / why / which message).
    assert.match(status, /ou_mallory/)
    assert.match(status, /sender-not-allowed/)
    assert.match(status, /om_evil_1/)
})

test('TC-922 上游没有 onAnswerIgnored：计数写"无法观测"，绝不写"没有发生"', async () => {
    const cwd = tempWorkspace('interaction-p2-')
    // The channel is registered, but the plugin cannot see refused attempts.
    const fake = assemble(cwd, { im: { channel: 'auto', channelId: 'feishu', approvalChatId: APPROVAL_CHAT, approvalVia: 'fallback', ...hostApprovers(cwd, ['ou_alice']) } }, {
        chatInteraction: makeChat({ withIgnoredHook: false }).layer,
    })

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.match(status, /IM 被忽略的回答尝试：\*\*无法观测\*\*（上游没有 `onAnswerIgnored`）/)
    assert.match(status, /这里的 0 次\*\*不等于\*\*"没人试过"/)
    assert.doesNotMatch(status, /上游已接钩子/)
})

test('TC-922 IM 通道未注册：计数写"无法观测"（没有钩子可挂），不是"没有尝试"', async () => {
    const cwd = tempWorkspace('interaction-p2-')
    const fake = assemble(cwd, { im: { channel: 'off', approvalVia: 'off' } }, {})

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.match(status, /IM 被忽略的回答尝试：\*\*无法观测\*\*（IM 通道未注册：没有 `onAnswerIgnored` 可挂钩/)
    assert.doesNotMatch(status, /没有发生/)
})

test('TC-926 approvalVia=off（默认）：状态说明审批未走 IM，且没有审批相关告警', async () => {
    const cwd = tempWorkspace('interaction-p2-')
    const fake = assemble(cwd, {}, {})

    const status = runText(await fake.runTool('interaction_status', {}))
    assert.match(status, /IM 审批（IM 上能不能真的做出决定？/)
    assert.match(status, /IM 审批应答者（approval\/request）：off（本插件未注册监听器：审批接缝由宿主原有的应答者回答，IM 上做不出任何审批决定——这是默认部署，不是故障）/)
    assert.doesNotMatch(status, /审批接缝走 IM（/, 'off 时不得出现"审批走 IM"的告警')
})

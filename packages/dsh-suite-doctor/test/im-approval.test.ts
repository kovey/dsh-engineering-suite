/**
 * `runtime.im-approval` — can an approval actually be DECIDED over IM?
 *
 * The check judges the three host-owned keys of the P1 approval path
 * (`im.approvalVia` / `im.approvalChatId`, plus the approver list the approval
 * path additionally requires) and answers in the interaction section of
 * `suite_status`. Two rules drive every case below:
 *
 *  - a missing target or an empty approver list makes the path REFUSE every
 *    approval before a card is sent — so it is a REQUIRED failure, naming the
 *    exact key/file and the two ways forward (configure it, or `approvalVia: off`);
 *  - the default (`off`, and a process with no `interaction` service at all)
 *    produces ONE quiet `ok` line and no advice: the default deployment must not
 *    be nagged, and `im.p2pOnly` + an upstream without `chatKind` can only ever
 *    be ADVISORY — no API declares that capability, so a "pass" would be invented.
 *
 * Acceptance cases: TC-921, TC-923, TC-924, TC-925, TC-926 (with TC-927 = two
 * consecutive `bash scripts/verify.sh --quiet` runs, exit 0) of the approved
 * specification `p2-im-suite-status-doctor-intera-20261109-112119`.
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { clearProjectConfigCache, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import {
    DEFAULT_APPROVERS_FILE,
    IM_APPROVAL_CHECK_ID,
    IM_APPROVAL_P2P_CHECK_ID,
    approverListOf,
    imApprovalChecks,
    type ImApprovalFact,
} from '../dist/im-approval.js'

const APPROVERS = DEFAULT_APPROVERS_FILE
const APPROVAL_CHAT = 'oc_approvals_9f2c41'

const hosts: FakeHost[] = []
after(() => {
    for (const host of hosts) host.dispose()
})

/** A log file OUTSIDE the workspace (the workspace must stay byte-identical). */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-doctor-im-log-'), 'suite-doctor.log')
}

/** A workspace with the approver list `dsh-interaction-gate` would read. */
function workspaceWithApprovers(ids: string[]): string {
    const cwd = tempWorkspace('suite-doctor-im-')
    const file = path.join(cwd, APPROVERS)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# approvers\n${ids.map((id) => `${id}\n`).join('')}`, 'utf8')
    clearProjectConfigCache()
    return cwd
}

/** The interaction service shape the doctor documents: channels + pending + im(). */
function imService(report: Record<string, unknown>): Record<string, unknown> {
    return {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            im: () => report,
        },
    }
}

/** Assemble the plugin in a throwaway workspace (the real `apply`, no host services). */
function host(cwd: string, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: logFileFor() })
    return fake
}

/** The doctor check with this id, from the JSON report. */
function checkOf(run: { value: unknown }, id: string): Record<string, any> | undefined {
    const report = JSON.parse(String(run.value)) as { checks: Record<string, any>[] }
    return report.checks.find((check) => check.id === id)
}

/** One IM approval fact, with the "everything is configured" defaults. */
function fact(overrides: Partial<ImApprovalFact> = {}): ImApprovalFact {
    return {
        service: true,
        mode: 'fallback',
        target: APPROVAL_CHAT,
        p2pOnly: false,
        approvers: { file: `/ws/${APPROVERS}`, present: true, count: 2 },
        ...overrides,
    }
}

test('TC-921 approvalVia=fallback 且目标与名单都已配置：必需项通过，并显示模式/目标已配置/名单人数', async () => {
    // Pure check: the three facts an operator asked for are all in the detail.
    const [required] = imApprovalChecks(fact())
    assert.equal(required?.id, IM_APPROVAL_CHECK_ID)
    assert.equal(required?.state, 'ok')
    assert.equal(required?.severity, 'required')
    assert.match(required?.label ?? '', /im\.approvalVia=fallback/)
    assert.match(required?.detail ?? '', /审批接缝走 IM（im\.approvalVia=fallback）/)
    assert.match(required?.detail ?? '', /目标会话已配置（oc_app…2c41）/, '目标要说"已配置"，并且可以掩码')
    assert.match(required?.detail ?? '', /审批人名单 2 个 id/)
    // p2pOnly=false: no chatKind advice at all (nothing to warn about).
    assert.equal(imApprovalChecks(fact()).length, 1)

    // The same verdict through the tool, over a fake interaction service.
    const cwd = workspaceWithApprovers(['ou_alice', 'ou_bob'])
    const fake = host(
        cwd,
        imService({ mode: 'auto', phase: 'registered', registered: true, approvalVia: 'fallback', approvalChatId: APPROVAL_CHAT, p2pOnly: false }),
    )
    const check = checkOf(await fake.runTool('suite_status', { json: true }), IM_APPROVAL_CHECK_ID)
    assert.equal(check?.state, 'ok', JSON.stringify(check))
    assert.equal(check?.severity, 'required')
    assert.match(check?.detail ?? '', /目标会话已配置/)
    assert.match(check?.detail ?? '', /2 个 id/)
    // A passing required check is not a blocker, and off is not the mode here.
    const run = await fake.runTool('suite_status', { json: true })
    const report = JSON.parse(String(run.value)) as { blockers: { id: string }[] }
    assert.equal(report.blockers.some((entry) => entry.id === IM_APPROVAL_CHECK_ID), false)
})

test('TC-923 approvalVia=only 但没配置 approvalChatId：必需项失败，点名缺失键与两条修复路径', async () => {
    const [check] = imApprovalChecks(fact({ mode: 'only', target: '' }))
    assert.equal(check?.id, IM_APPROVAL_CHECK_ID)
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.label ?? '', /im\.approvalVia=only/)
    assert.match(check?.detail ?? '', /没有配置审批目标 im\.approvalChatId/, '必须点名缺失的那个键')
    assert.match(check?.detail ?? '', /refused:no-target/, '必须说明后果：发卡之前就被拒绝')
    assert.match(check?.fix ?? '', /im\.approvalChatId/, '修复要给出确切的配置键')
    assert.match(check?.fix ?? '', /把 im\.approvalVia 设回 off/, '两条路都要给：配好，或回到宿主接缝')

    const cwd = workspaceWithApprovers(['ou_alice'])
    const fake = host(cwd, imService({ mode: 'auto', phase: 'registered', registered: true, approvalVia: 'only', approvalChatId: '', p2pOnly: false }))
    const run = await fake.runTool('suite_status', { json: true })
    const report = JSON.parse(String(run.value)) as { blockers: { id: string; fix?: string }[] }
    const blocker = report.blockers.find((entry) => entry.id === IM_APPROVAL_CHECK_ID)
    assert.notEqual(blocker, undefined, '配了一半的部署必须是必需项失败')
    assert.match(blocker?.fix ?? '', /im\.approvalChatId/)
    // The text report says it too (an operator reads the text, not the JSON).
    assert.match(runText(await fake.runTool('suite_status', {})), /没有配置审批目标 im\.approvalChatId/)
})

test('TC-924 approvalVia=fallback 而名单为空：必需项失败，点名名单文件路径（含项目级 approversFile）', async () => {
    const cwd = tempWorkspace('suite-doctor-im-')
    // A project may move the file; the check must read the same place the gate does.
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'interaction-gate.json'), JSON.stringify({ approversFile: 'config/approvers.txt' }), 'utf8')
    fs.mkdirSync(path.join(cwd, 'config'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'config', 'approvers.txt'), '# 只有注释，没有 id\n\n', 'utf8')
    clearProjectConfigCache()

    const approvers = approverListOf(resolveLayout(cwd))
    assert.equal(approvers.file, path.join(cwd, 'config', 'approvers.txt'))
    assert.equal(approvers.present, true)
    assert.equal(approvers.count, 0, '注释与空行不是 id')

    const [check] = imApprovalChecks({ service: true, mode: 'fallback', target: APPROVAL_CHAT, p2pOnly: false, approvers })
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.detail ?? '', /审批人名单为空或不可读/)
    assert.ok((check?.detail ?? '').includes(approvers.file), '必须点名被读的名单文件')
    assert.match(check?.detail ?? '', /refused:approvers-missing/)
    assert.ok((check?.fix ?? '').includes('名单文件') || (check?.fix ?? '').includes('审批人 id'), '修复要说明怎么补名单')
    assert.match(check?.fix ?? '', /把 im\.approvalVia 设回 off/)
})

test('TC-925 p2pOnly=true 而上游可能不报 chatKind：建议项写明后果与两种处置，且不改变必需项结论', async () => {
    const checks = imApprovalChecks(fact({ p2pOnly: true }))
    assert.equal(checks.length, 2, '必需项 + 建议项')
    const required = checks.find((check) => check.id === IM_APPROVAL_CHECK_ID)
    assert.equal(required?.state, 'ok', '建议项不得把必需项拖成失败')
    const advice = checks.find((check) => check.id === IM_APPROVAL_P2P_CHECK_ID)
    assert.equal(advice?.severity, 'recommended', 'chatKind 风险只能是建议，不能伪装成必需项')
    assert.equal(advice?.state, 'partial')
    assert.match(advice?.detail ?? '', /每一次\*\* IM 审批回答都会被当成"未证明"拒绝/, '要写明后果')
    assert.match(advice?.detail ?? '', /无法从任何 API 判定/, '要写明这是无法探测的上游能力')
    assert.match(advice?.fix ?? '', /im\.p2pOnly 设为 false/, '处置一：关掉 p2p 要求')
    assert.match(advice?.fix ?? '', /保持 im\.approvalVia=off/, '处置二：回到宿主接缝')
    assert.match(advice?.fix ?? '', /建议/, '措辞必须承认它只是建议')

    // Through the report: advice, never a blocker.
    const cwd = workspaceWithApprovers(['ou_alice'])
    const fake = host(
        cwd,
        imService({ mode: 'auto', phase: 'registered', registered: true, approvalVia: 'fallback', approvalChatId: APPROVAL_CHAT, p2pOnly: true }),
    )
    const run = await fake.runTool('suite_status', { json: true })
    const report = JSON.parse(String(run.value)) as { blockers: { id: string }[]; advice: { id: string }[] }
    assert.equal(report.blockers.some((entry) => entry.id === IM_APPROVAL_P2P_CHECK_ID), false)
    assert.equal(report.advice.some((entry) => entry.id === IM_APPROVAL_P2P_CHECK_ID), true)
})

test('TC-926 approvalVia=off（默认）：零告警，状态说明审批仍走宿主接缝（TUI）', async () => {
    const checks = imApprovalChecks(fact({ mode: 'off' }))
    assert.equal(checks.length, 1, 'off 时没有建议项，也没有第二条检查')
    assert.equal(checks[0]?.state, 'ok')
    assert.match(checks[0]?.label ?? '', /im\.approvalVia=off/)
    assert.match(checks[0]?.detail ?? '', /审批仍走宿主接缝（TUI）/)
    assert.doesNotMatch(checks[0]?.detail ?? '', /⚠️|失败|缺失/)

    // The default deployment: no interaction service at all → also quiet.
    const bare = imApprovalChecks({ service: false, approvers: { file: '', present: false, count: 0 } })
    assert.equal(bare.length, 1)
    assert.equal(bare[0]?.state, 'ok')
    assert.match(bare[0]?.detail ?? '', /没有 interaction 服务/)

    // A live service reporting off, through the tool: ok, not in blockers/advice.
    const cwd = workspaceWithApprovers(['ou_alice'])
    const fake = host(
        cwd,
        imService({ mode: 'auto', phase: 'absent', registered: false, approvalVia: 'off', approvalChatId: '', p2pOnly: true }),
    )
    const run = await fake.runTool('suite_status', { json: true })
    const report = JSON.parse(String(run.value)) as { checks: { id: string; state: string }[]; blockers: { id: string }[]; advice: { id: string }[] }
    assert.equal(report.checks.find((check) => check.id === IM_APPROVAL_CHECK_ID)?.state, 'ok')
    for (const group of [report.blockers, report.advice]) {
        assert.equal(group.some((entry) => entry.id === IM_APPROVAL_CHECK_ID || entry.id === IM_APPROVAL_P2P_CHECK_ID), false, 'off 时不得出现任何审批相关告警')
    }
    assert.match(runText(await fake.runTool('suite_status', {})), /审批仍走宿主接缝（TUI）/)
})

test('an older interaction service that does not report approvalVia is unknown, never off', () => {
    const checks = imApprovalChecks({
        service: true,
        modeProblem: 'interaction 服务没有暴露 IM 通道报告（试过 im()）',
        approvers: { file: '', present: false, count: 0 },
    })
    assert.equal(checks.length, 1)
    assert.equal(checks[0]?.state, 'unknown')
    assert.equal(checks[0]?.severity, 'recommended', '读不到不是阻塞：但也不是通过')
    assert.match(checks[0]?.detail ?? '', /读不到不等于 off/)
    assert.match(checks[0]?.fix ?? '', /升级 dsh-interaction-gate/)
})

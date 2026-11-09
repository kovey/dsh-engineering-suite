/**
 * `runtime.im-approval-workspace` — does THIS workspace have an approval
 * conversation? (P3.2)
 *
 * P1 configured ONE approval conversation per host, and `runtime.im-approval`
 * answers "is that path configured?". Once a host splits its approvals per
 * workspace (`im.approvals`), a new failure becomes possible that the
 * process-wide keys cannot see: the mode, the target and the allowlist are all
 * fine, and every approval raised in THIS repository is still refused before a
 * card (`refused:no-workspace-mapping`) because no entry claims it — or is sent
 * to a conversation configured for a different repository under `host-default`.
 *
 * The rules these cases pin down:
 *
 *  - a mapping in force + no entry for this workspace + `refuse` ⇒ REQUIRED
 *    failure, naming `im.approvals` and one concrete entry to add;
 *  - `host-default` is a written-down policy, not a mistake: ADVICE
 *    (`recommended`), and the text says the conversation is the host default
 *    rather than a mapped one;
 *  - two entries of equal specificity ⇒ REQUIRED failure naming both (every ask
 *    there is refused, so it cannot be advice);
 *  - NO mapping declared (the default eleven's deployment), `approvalVia: off`,
 *    or a service that does not report a mapping ⇒ NO check at all: the default
 *    deployment must not be nagged, and "could not read it" is not a state this
 *    check may invent.
 *
 * Acceptance cases: TC-961, TC-965, TC-968 of the approved specification
 * `p3-2-realpath-refuse-host-defaul-20261109-155701` (TC-969 = two consecutive
 * `bash scripts/verify.sh --quiet` runs, exit 0).
 *
 * Run after a build: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import {
    HOST_APPROVERS_FILE,
    IM_APPROVAL_CHECK_ID,
    IM_APPROVAL_WORKSPACE_CHECK_ID,
    imApprovalChecks,
    type ImApprovalFact,
    type WorkspaceMappingFact,
} from '../dist/im-approval.js'

const APPROVAL_CHAT = 'oc_approvals_9f2c41'
const WORKSPACE = '/Users/me/work/app'

const hosts: FakeHost[] = []
after(() => {
    for (const host of hosts) host.dispose()
})

/** A log file OUTSIDE the workspace (the workspace must stay byte-identical). */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-doctor-ws-map-log-'), 'suite-doctor.log')
}

/** The host allowlist fact, as `probe.ts` maps `im()` → `approvers`. */
function hostList(count: number): ImApprovalFact['approvers'] {
    return { count, inline: count, file: '/host/dsh/approvers.txt', filePresent: false, fileCount: 0, deny: 0 }
}

/** One IM approval fact, with "everything P1 needs is configured" defaults. */
function fact(overrides: Partial<ImApprovalFact> = {}): ImApprovalFact {
    return {
        service: true,
        mode: 'fallback',
        target: APPROVAL_CHAT,
        p2pOnly: false,
        approvers: hostList(2),
        legacy: { file: path.resolve(WORKSPACE, '.dsh/interaction-approvers.txt'), present: false, count: 0 },
        ...overrides,
    }
}

/** A mapping in force with one entry claiming the workspace. */
function matchedMapping(overrides: WorkspaceMappingFact = {}, entry: Record<string, unknown> = {}): WorkspaceMappingFact {
    return {
        configured: true,
        declared: 1,
        usable: 1,
        policy: 'refuse',
        workspace: WORKSPACE,
        resolved: WORKSPACE,
        matched: { index: 0, workspace: WORKSPACE, chatId: 'oc_mapped…room', approvers: 2, approversFallback: false, ...entry },
        ...overrides,
    }
}

function checkOf(facts: ImApprovalFact): ReturnType<typeof imApprovalChecks> | undefined {
    return imApprovalChecks(facts).find((check) => check.id === IM_APPROVAL_WORKSPACE_CHECK_ID)
}

/** The doctor's own `host()` helper: the real `apply`, a fake host, no services unless given. */
function host(cwd: string, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: logFileFor() })
    return fake
}

/** A fake interaction service whose `im()` answers per workspace, like the gate's. */
function mappingService(mapping: Record<string, unknown>, report: Record<string, unknown>, seen?: string[]): Record<string, unknown> {
    return {
        interaction: {
            describeAll: () => [{ name: 'feishu', canAsk: true, canNotify: true }],
            pending: () => [],
            ledgers: () => ['/tmp/interaction.jsonl'],
            im: (workspace?: string) => {
                if (workspace !== undefined && seen !== undefined) seen.push(workspace)
                return { ...report, workspaceMapping: mapping }
            },
        },
    }
}

/** The doctor check with this id, from the JSON report. */
function jsonCheckOf(run: { value: unknown }, id: string): Record<string, any> | undefined {
    const report = JSON.parse(String(run.value)) as { checks: Record<string, any>[] }
    return report.checks.find((check) => check.id === id)
}

test('TC-961 命中一条映射：必需项通过，并说明是哪个条目、会话（掩码）与审批人来源', () => {
    const check = checkOf(fact({ mapping: matchedMapping() }))
    assert.equal(check?.id, IM_APPROVAL_WORKSPACE_CHECK_ID)
    assert.equal(check?.state, 'ok')
    assert.equal(check?.severity, 'required')
    assert.match(check?.label ?? '', /命中 im\.approvals\[0\]/)
    assert.match(check?.detail ?? '', /命中映射项 \/Users\/me\/work\/app/, '要点名命中的工作区键')
    assert.match(check?.detail ?? '', /会话 oc_mapped…room/, '会话要掩码（报告里不带完整会话 id）')
    assert.match(check?.detail ?? '', /该条声明了 approvers（2 个 id）/, '要说清审批人来自该条目')
    assert.match(check?.detail ?? '', /denyApprovers 仍然会先减去/, '减法不被映射项取消')

    // Omitted approvers (the fallback) must READ as a fallback, never as if the
    // entry decided the list.
    const fallback = checkOf(fact({ mapping: matchedMapping({}, { approversFallback: true, approvers: 0 }) }))
    assert.equal(fallback?.state, 'ok')
    assert.match(fallback?.detail ?? '', /回落到宿主名单/)
    assert.match(fallback?.detail ?? '', /由 im\.approvers \/ im\.approversFile 决定/, '回落的来源必须是宿主名单')
})

test('TC-965 映射在用而当前工作区未命中、策略 refuse：必需项失败，点名 im.approvals 与一条具体条目', () => {
    const mapping: WorkspaceMappingFact = {
        configured: true,
        declared: 1,
        usable: 1,
        policy: 'refuse',
        workspace: WORKSPACE,
        resolved: WORKSPACE,
    }
    const check = checkOf(fact({ mapping }))
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.label ?? '', /未命中 → refuse/)
    assert.match(check?.detail ?? '', /refused:no-workspace-mapping/, '必须点名后果：每次审批都在发卡前被拒绝')
    assert.ok((check?.detail ?? '').includes(WORKSPACE), '必须点名工作区')
    assert.match(check?.detail ?? '', /im\.approvals/, '必须点名该配的键')
    // The fix is executable: a concrete entry for THIS workspace, plus the two
    // other deliberate ways out.
    assert.ok((check?.fix ?? '').includes(`"workspace": "${WORKSPACE}"`), `修复要给出一条能直接抄的条目：${check?.fix ?? ''}`)
    assert.match(check?.fix ?? '', /im\.unmappedWorkspace/, '第二条路：显式接受宿主默认会话')
    assert.match(check?.fix ?? '', /把 im\.approvalVia 设回 off/, '第三条路：回到宿主接缝')

    // An unmapped workspace that cannot even be realpath'd says so (nothing was
    // compared, so "unmatched" is a fact about an unresolved path).
    const unresolved = checkOf(
        fact({ mapping: { ...mapping, resolved: '', realpathProblem: '无法解析工作区 /gone 的真实路径（realpath 失败）', workspace: '/gone' } }),
    )
    assert.equal(unresolved?.state, 'missing')
    assert.match(unresolved?.detail ?? '', /refused:no-workspace-mapping/)
})

test('TC-968 未命中但策略是 host-default：建议项（不是必需失败），并说清回落的是宿主默认会话', () => {
    const mapping: WorkspaceMappingFact = { configured: true, declared: 1, usable: 1, policy: 'host-default', workspace: WORKSPACE, resolved: WORKSPACE }
    const check = checkOf(fact({ mapping }))
    assert.equal(check?.state, 'partial')
    assert.equal(check?.severity, 'recommended', 'host-default 是写下来的策略，不该阻断交付')
    assert.match(check?.label ?? '', /host-default/)
    assert.match(check?.detail ?? '', /宿主默认会话/)
    assert.match(check?.detail ?? '', /im\.unmappedWorkspace=host-default/)
    assert.match(check?.fix ?? '', /im\.approvals/, '要给出"给它自己的会话"这条路')
})

test('两条同等具体的映射（歧义）：必需项失败并点名两条，不替人挑', () => {
    const mapping: WorkspaceMappingFact = {
        configured: true,
        declared: 2,
        usable: 2,
        policy: 'refuse',
        workspace: WORKSPACE,
        resolved: WORKSPACE,
        conflict: {
            candidates: [
                { index: 0, workspace: WORKSPACE, chatId: 'oc_left…0001' },
                { index: 1, workspace: WORKSPACE, chatId: 'oc_right…0002' },
            ],
        },
    }
    const check = checkOf(fact({ mapping }))
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.label ?? '', /歧义/, '标题就要说这是歧义')
    assert.match(check?.detail ?? '', /具体度相同/)
    assert.match(check?.detail ?? '', /im\.approvals\[0\]/, '两条都要点名')
    assert.match(check?.detail ?? '', /im\.approvals\[1\]/, '两条都要点名')
    assert.match(check?.detail ?? '', /refused:ambiguous-workspace-mapping/)
    assert.match(check?.fix ?? '', /更具体|删掉重复/, '修复：改具体或删掉重复项')
})

test('默认部署不被唠叨：没有映射、approvalVia=off、或服务不报告映射时都不产出这项检查', () => {
    // No mapping declared (the ordinary single-workspace host).
    assert.equal(checkOf(fact({ mapping: { configured: false, declared: 0, usable: 0, policy: 'refuse' } })), undefined)
    // A service that does not implement the mapping at all (an older build).
    assert.equal(checkOf(fact()), undefined)
    // `off`: the approval seam is not over IM, so no mapping can matter.
    assert.equal(checkOf(fact({ mode: 'off', mapping: matchedMapping({ policy: 'refuse' }) })), undefined)
    // The ordinary P1 checks are still exactly one item (nothing was added).
    assert.equal(imApprovalChecks(fact()).length, 1)
})

test('映射项自己带 approvers 时，空的宿主名单不再被误报为必需失败', () => {
    // A host that splits approvals per workspace may legitimately keep NO list of
    // its own: the entries carry them. Reporting "宿主审批人名单为空" here would
    // push an operator to configure a list nothing reads.
    const checks = imApprovalChecks(fact({ approvers: hostList(0), mapping: matchedMapping({}, { approvers: 2, approversFallback: false }) }))
    const required = checks.find((check) => check.id === IM_APPROVAL_CHECK_ID)
    assert.equal(required?.state, 'ok', JSON.stringify(required))
    assert.match(required?.detail ?? '', /声明了自己的 approvers（2 个 id）/)
    assert.match(required?.detail ?? '', /宿主名单在该工作区不参与/)

    // The HOST-default path is unchanged: no entry, no list → still a failure.
    const fallbackOnly = imApprovalChecks(fact({ approvers: hostList(0) })).find((check) => check.id === IM_APPROVAL_CHECK_ID)
    assert.equal(fallbackOnly?.state, 'missing', '没有映射项时，空名单仍然是必需失败')
})

test('映射项声明了空 approvers：必需失败（谁也不能批），并给出"写人"或"删掉字段回落"两条路', () => {
    const check = checkOf(fact({ mapping: matchedMapping({}, { approvers: 0, approversFallback: false }) }))
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.label ?? '', /空名单/)
    assert.match(check?.detail ?? '', /refused:approvers-missing/)
    assert.match(check?.detail ?? '', /谁也不能批准/)
    assert.match(check?.fix ?? '', /删掉它的 `approvers` 字段/, '要给出"回落到宿主名单"这条路')
    assert.ok((check?.fix ?? '').includes(HOST_APPROVERS_FILE), '回落的落点要点名宿主侧默认路径')
})

test('端到端：suite_status 把当前工作区交给 im(workspace)，并按映射判定（必需失败会阻断）', async () => {
    const cwd = tempWorkspace('suite-doctor-ws-map-')
    const seen: string[] = []
    const fake = host(
        cwd,
        mappingService(
            {
                configured: true,
                declared: 1,
                usable: 1,
                policy: 'refuse',
                workspace: cwd,
                resolved: cwd,
                // The single declared entry belongs to ANOTHER workspace.
                matched: undefined,
            },
            {
                mode: 'auto',
                phase: 'registered',
                registered: true,
                approvalVia: 'fallback',
                approvalChatId: APPROVAL_CHAT,
                p2pOnly: false,
                approvers: { hostCount: 2, inline: 2 },
            },
            seen,
        ),
    )
    const run = await fake.runTool('suite_status', { json: true })
    const check = jsonCheckOf(run, IM_APPROVAL_WORKSPACE_CHECK_ID)
    assert.notEqual(check, undefined, `suite_status 必须报出工作区映射这一项：${String(run.value).slice(0, 400)}`)
    assert.equal(check?.state, 'missing')
    assert.equal(check?.severity, 'required')
    assert.match(check?.detail ?? '', /refused:no-workspace-mapping/)
    // The check is about the workspace the doctor is reporting on — which is why
    // the probe passes it into `im(workspace)`.
    assert.deepEqual(seen, [cwd], 'im() 必须拿到被报告的那个工作区')
    const report = JSON.parse(String(run.value)) as { blockers: { id: string }[] }
    assert.ok(
        report.blockers.some((entry) => entry.id === IM_APPROVAL_WORKSPACE_CHECK_ID),
        '每次审批都会被拒的部署必须是必需项失败，而不是建议',
    )
    // …and the text report says it too (operators read the text).
    const text = runText(await fake.runTool('suite_status', {}))
    assert.match(text, /im\.approvals/)
    // The P1 check itself is still ok: the two facts are separate on purpose.
    assert.equal(jsonCheckOf(run, IM_APPROVAL_CHECK_ID)?.state, 'ok')
    assert.ok(HOST_APPROVERS_FILE.length > 0)
})

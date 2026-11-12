/**
 * The denial texts `guard.ts` returns, kept apart so the guard's decision code
 * stays readable (and within the structural thresholds).
 *
 * Every message is written for the MODEL: it names what was refused, which
 * rule refused it, and the exact next tool call that can change the outcome.
 * No message can grant anything — they are strings, not decisions.
 *
 * @module dsh-spec-gate/guard-messages
 */

import path from 'node:path'
import { isInside, isReallyInside, resolvePath, type MissionStore } from 'dsh-eng-core'
import type { ConstraintViolation } from './constraints.js'

/**
 * Whether a path is one of the *derived* artifacts a model may rewrite.
 *
 * Only the rendered specification is in this set, and only because it is
 * derived: `spec_approve` and the write guard both read `mission.spec`, never
 * the markdown, and a hand-written artifact that disagrees with the record is
 * rejected by the review digest. Everything else under the root decides trust
 * and therefore stays closed.
 */
export function isDerivedSpecArtifact(store: MissionStore, absoluteTarget: string): boolean {
    return absoluteTarget.endsWith('.md') && isInside(store.layout.specsDir, absoluteTarget)
}

/** Verdict of one trust-root scan: denied, explicitly allowed, or untouched. */
export type TrustRootScan = { kind: 'allow' } | { kind: 'deny'; reason: string }

/**
 * Scan one write's targets against the trust root.
 *
 * Three outcomes, and the middle one matters: a DERIVED spec artifact is
 * explicitly allowed (the gate renders it, so a model may update it without an
 * approval), a target inside the root is denied with a reason, and a target
 * outside the root reports "untouched" so the boundary check still runs.
 * @param store - the workspace's mission store (its layout owns the root).
 * @param cwd - workspace root the targets are relative to.
 * @param targets - write targets exactly as the call declared them.
 */
export function trustRootViolation(store: MissionStore, cwd: string, targets: readonly string[]): TrustRootScan | undefined {
    for (const declared of targets) {
        const resolved = resolvePath(declared, cwd)
        // Containment is checked on the REAL path: a symlink inside the
        // workspace pointing into `.dsh/` would otherwise pass a lexical check
        // while the bytes land in the trust root (the model could rewrite its
        // own thresholds or baseline through `link/x.json`).
        if (!isReallyInside(store.layout.rootDir, resolved, cwd)) continue
        // The rendered specification is derived and is the one artifact the
        // gate may let through without an approval; everything else under the
        // root is the trust root and stays closed.
        if (isDerivedSpecArtifact(store, resolved)) return { kind: 'allow' }
        return { kind: 'deny', reason: trustRootReason(path.relative(store.layout.cwd, resolved)) }
    }
    return undefined
}

/** A write with no declared workspace is refused (there is no approval to apply). */
export function undeclaredCwdReason(): string {
    return [
        'spec-gate: 无法确定本会话的工作区（session.header.cwd 缺失），写操作被拒绝（fail closed）。',
        '下一步：在带 cwd 的会话里工作；宿主可通过 exemptTools 显式放行该工具（需自行承担风险）。',
    ].join('\n')
}

export function trustRootReason(relative: string): string {
    return [
        `spec-gate: \`${relative}\` 属于工程台账（门禁的信任根），不允许通过写类工具修改。`,
        '这些文件（mission.json / state/** / roles/** / gates / receipts / stages / 审计）决定了"这次改动是否被允许"，',
        '只能由插件自己的工具写入：规格用 spec_create，评审用 test_design_review，审批用 spec_approve，',
        '门禁用 quality_gate_run，证据用 evidence_record。',
        '如果你是在做本套件自身的开发，请让宿主在 spec-gate 的 boundaryExemptPaths 里显式放行对应目录。',
    ].join('\n')
}

export function constraintReason(violation: ConstraintViolation, missionId: string): string {
    return [
        `spec-gate: ${violation.reason}`,
        `约束原文：\`${violation.constraint.raw}\``,
        '这条约束是规格的一部分（negativeConstraints），门禁会强制它。',
        `下一步：如果确实需要这样做，先 spec_create 修改「负面约束」并重新 spec_approve（mission ${missionId}）。`,
    ].join('\n')
}

export function shellBoundaryReason(missionId: string, relative: string, boundaries: readonly string[]): string {
    return [
        `spec-gate: shell 命令要写 \`${relative}\`，不在规格声明的文件边界内，命令被拒绝。`,
        `mission: ${missionId}`,
        `允许的边界：${boundaries.length === 0 ? '(规格未声明任何边界)' : boundaries.join(', ')}`,
        '下一步：把改动收敛到边界内，或先 spec_create 更新 fileBoundaries 并重新 spec_approve。',
    ].join('\n')
}

export function shellStrictReason(missionId: string, command: string, reasons: readonly string[]): string {
    return [
        'spec-gate: shell 命令的写入目标无法静态确认，而宿主把 shellPolicy 设为 strict，因此拒绝执行。',
        `mission: ${missionId}`,
        `命令：\`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\``,
        `原因：${reasons.join('；') || '无法归属写入目标'}`,
        '下一步：改用声明了 file_path 的写类工具，或把命令拆成可归属的形式；宿主也可把 shellPolicy 调成 targets/off。',
    ].join('\n')
}

export function shellUnknownReason(missionId: string, tool: string): string {
    return [
        `spec-gate: shell 工具 \`${tool}\` 的调用里找不到命令参数，无法校验写入目标，按 fail closed 拒绝。`,
        `mission: ${missionId}`,
        '下一步：把命令放在 command 参数里；或让宿主把该工具加入 exemptTools（显式承担风险）。',
    ].join('\n')
}

/**
 * A command refused because `shellPolicy: 'allowlist'` does not cover it.
 *
 * The denial is written for the MODEL: what was refused, the closest entry
 * (a near miss is a hint, not a permission), how to add an entry, and what to
 * use instead of a shell. The risk line is deliberate — widening the list is
 * the one action this text can invite, so it must not sound free.
 * @param missionId - mission named in the text.
 * @param denial - the refusing segment (shape shared with `shell-allowlist.ts`).
 */
export function shellAllowlistReason(
    missionId: string,
    denial: { segment: string; program: string; hidden?: string; closest?: string },
): string {
    const command = denial.segment.length > 200 ? `${denial.segment.slice(0, 200)}…` : denial.segment
    const closest = denial.closest === undefined ? '（没有前缀相同的条目）' : `\`${denial.closest}\``
    const reason =
        denial.hidden === undefined
            ? `首个程序 \`${denial.program}\` 不在名单上`
            : `该段含命令替换/进程替换（${denial.hidden}），无法静态确认实际运行什么`
    return [
        'spec-gate: shell 命令的这一段不在 shellAllowlist 里，而宿主把 shellPolicy 设为 allowlist，因此拒绝执行。',
        `mission: ${missionId}`,
        `命令段：\`${command}\``,
        `拒因：${reason}。`,
        `最接近的条目：${closest}（只按前缀比较；接近不等于命中，不在名单上就不放行）。`,
        '如何追加条目：在仓库的 .dsh/spec-gate.json 写 {"shellAllowlist": ["<程序或前缀>"]}（项目级只能追加，不能删除宿主条目；',
        '是否开启 allowlist 仍由宿主决定）。注意：追加条目 = 扩大可执行面——命中条目的命令不再经过正列表这道闸。',
        '也可以改用工具而不是 shell：写文件用 write/edit（带 file_path，仍走文件边界检查），读文件用 read，',
        '搜索用 grep/glob，运行测试用宿主提供的测试命令。只有当某个程序确实需要长期放行时才追加它。',
    ].join('\n')
}

export function unknownTargetReason(missionId: string, tool: string): string {
    return [
        `spec-gate: 写类工具 \`${tool}\` 没有声明目标路径，无法进行文件边界校验，按 fail closed 拒绝。`,
        `mission: ${missionId}`,
        '宿主可以把它加入 spec-gate 的 exemptTools（显式承担风险），或让该工具在参数里带上 file_path/path。',
    ].join('\n')
}

export function boundaryReason(missionId: string, relative: string, boundaries: readonly string[]): string {
    return [
        `spec-gate: 目标路径 \`${relative}\` 不在规格声明的文件边界内，写操作被拒绝。`,
        `mission: ${missionId}`,
        `允许的边界：${boundaries.length === 0 ? '(规格未声明任何边界)' : boundaries.join(', ')}`,
        '下一步：如果确实需要动这个文件，先调用 spec_create 更新规格的 fileBoundaries（并重新 spec_approve），',
        '不要绕过边界——边界外的改动无法被这次的验收标准覆盖。',
    ].join('\n')
}

/**
 * A write refused because the current stage's role belongs to a delegated child.
 *
 * The stage's `role` used to be a declaration; it is now a constraint. This text
 * is written for the MODEL, which is the only one that can fix it: it names the
 * stage, the role, the exact `team_delegate` call that unblocks the work, and
 * where the delegation row will be written. It never suggests a bypass — editing
 * the mission or the ledger by hand is exactly what the trust-root rule refuses.
 * @param input - mission/stage/role and the caller's session (for the "not the
 *   delegated child" statement) plus the ledger path to name.
 */
export function stageRoleReason(input: {
    missionId: string
    stage: string
    role: string
    sessionId?: string
    ledger: string
}): string {
    const caller = input.sessionId === undefined ? '本会话' : `本会话（${input.sessionId}）`
    return [
        `spec-gate: 阶段 ${input.stage} 声明了角色 ${input.role}，${caller}不是该 mission 该阶段的已委派子会话，写操作被拒绝。`,
        `mission: ${input.missionId}`,
        '原因：阶段角色是硬约束——实现类工作必须由该角色的子会话完成，主会话（lead）直接写会绕过职责分离。',
        `下一步：在当前阶段调用 team_delegate({ role: '${input.role}', task: '…' }) 派发实现；`,
        `子会话启动成功后，dsh-role-guard 会向委派记录 ${input.ledger} 追加一行（missionId/stage/role/childSessionId）；`,
        '该记录存在后，这个子会话的写操作才会被放行。读操作不受影响。',
    ].join('\n')
}

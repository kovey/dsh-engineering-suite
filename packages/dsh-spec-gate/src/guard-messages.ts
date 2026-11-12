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

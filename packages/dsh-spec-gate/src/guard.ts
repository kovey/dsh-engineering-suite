/**
 * The monotonic write guard (docs.md §3.2): a write-class tool call is denied
 * while the calling session's mission has no approved specification.
 *
 * The guard is registered through `ctx.tools.guard()`, which the registry
 * evaluates after every `tools/pre-execute` listener and before the tool body.
 * A returned reason is final — no listener ordering can turn it back into a
 * permission — and the reason text is written for the *model*, because the
 * model is the one that has to fix it.
 *
 * @module dsh-spec-gate/guard
 */

import { isInside, isReallyInside, pathMatchesAny, pathMatchesPattern, resolvePath, type MissionStore, type MissionStoreRegistry } from 'dsh-eng-core'
import path from 'node:path'
import type { AgentLike } from 'dsh-eng-core'
import { evaluateConstraints, type ConstraintViolation } from './constraints.js'
import { analyzeShellCommand, shellCommandOf } from './shell.js'
import type { SpecGateConfig } from './config.js'

/** The write guard and the diagnostics a test (or a status tool) can inspect. */
export interface WriteGuard {
    /** Registry-compatible guard: returns a denial reason or `undefined`. */
    guard: (exec: WriteGuardExecution) => string | undefined
    /** Number of denials since assembly, across every workspace. */
    denials: () => number
    /** Denials recorded for ONE workspace root (multi-project deployments). */
    denialsFor: (rootDir: string) => number
}

/** The slice of a tool execution the guard reads. */
export interface WriteGuardExecution {
    name: string
    arguments: unknown
    agent?: AgentLike
}

/** Inputs the guard needs beyond configuration. */
export interface WriteGuardDeps {
    config: SpecGateConfig
    /** Effective config for one workspace (profile + project overlay). */
    configFor: (cwd: string) => { config: SpecGateConfig; source: 'profile' | 'project'; file?: string; problems: string[] }
    stores: MissionStoreRegistry
    /** Whether the sibling test-design gate is mounted (probed once, at call time). */
    testDesignMounted: () => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** Extract the target path a write-class tool declares. */
export function writeTargetPath(args: unknown): string | undefined {
    if (!isRecord(args)) return undefined
    for (const key of ['file_path', 'filePath', 'path', 'target_file', 'targetFile']) {
        const value = args[key]
        if (typeof value === 'string' && value !== '') return value
    }
    return undefined
}

function noMissionReason(sessionId: string | undefined): string {
    return [
        'spec-gate: 该会话没有已登记的规格（mission），写操作被拒绝。',
        `session: ${sessionId ?? 'unknown'}`,
        '下一步：调用 spec_create 提交结构化规格（验收标准 / 文件边界 / 负面约束 / 测试设计），',
        '然后调用 spec_approve 取得审批，再重新执行本写操作。',
    ].join('\n')
}

function notApprovedReason(missionId: string, status: string): string {
    return [
        `spec-gate: 规格 ${missionId} 尚未审批（当前状态 ${status}），写操作被拒绝。`,
        '下一步：调用 spec_approve 取得审批（必要时先用 test_design_review 通过测试设计门禁），再重新执行本写操作。',
    ].join('\n')
}

/**
 * Build the write guard.
 *
 * Two deterministic checks, in order:
 *  1. the mission has an approved specification (docs.md §3.2);
 *  2. the target path is inside the specification's declared **file
 *     boundaries** (docs.md §1.2/§9 — a boundary the host never checks is a
 *     comment, not a constraint).
 *
 * @param deps - configuration, mission stores and the test-design probe.
 * @returns the guard plus a denial counter.
 */
export function createWriteGuard(deps: WriteGuardDeps): WriteGuard {
    // Counters are per workspace: with several repositories in one process a
    // single number says nothing about which project is being blocked.
    const denialsByRoot = new Map<string, number>()
    const bump = (rootDir: string): void => {
        denialsByRoot.set(rootDir, (denialsByRoot.get(rootDir) ?? 0) + 1)
    }
    const guard = (exec: WriteGuardExecution): string | undefined => {
        const declared = exec.agent?.session?.header?.cwd
        // The overlay is per workspace; an undeclared cwd never reaches the
        // rules below (it is refused), so the profile config is used to decide
        // that refusal.
        const config = declared === undefined ? deps.config : deps.configFor(declared).config
        if (!config.enforce) return undefined
        if (config.exemptTools.includes(exec.name)) return undefined
        const isWriteTool = config.writeTools.includes(exec.name)
        const isShellTool = config.shellTools.includes(exec.name)
        // `command` is extracted for every configured shell tool (so `cmd:`
        // constraints still work with shellPolicy=off); the ANALYSIS is only
        // consulted when the policy is not off.
        const command = isShellTool ? shellCommandOf(exec.arguments) : undefined
        const shell = command === undefined || config.shellPolicy === 'off' ? undefined : analyzeShellCommand(command)
        // A shell command is gated only when it actually WRITES something the
        // analyser could attribute; `ls`, `git status`, `npm test` and other
        // read-only or unattributable commands stay usable before approval
        // (the `strict` policy is what turns the blind spot into a refusal).
        const shellTargets = shell?.targets ?? []
        const shellWriteLike = isShellTool && shellTargets.length > 0
        const gated = isWriteTool || shellWriteLike

        const cwd = exec.agent?.session?.header?.cwd
        if (cwd === undefined) {
            // Without a workspace there is no mission resolution we can trust:
            // falling back to the harness's own cwd would gate this write
            // against a different project's approvals.
            bump('(undeclared)')
            return [
                'spec-gate: 无法确定本会话的工作区（session.header.cwd 缺失），写操作被拒绝（fail closed）。',
                '下一步：在带 cwd 的会话里工作；宿主可通过 exemptTools 显式放行该工具（需自行承担风险）。',
            ].join('\n')
        }
        const store: MissionStore = deps.stores.for(cwd)
        const target = writeTargetPath(exec.arguments)
        // Only WRITE-ish targets count: a `read` of a forbidden path is not a
        // modification, and denying it would stop a reviewer from reading the
        // very file it must review.
        const declaredTargets = [
            ...(isWriteTool && target !== undefined ? [target] : []),
            ...shellTargets,
        ].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
        const absoluteTarget = target === undefined ? undefined : resolvePath(target, cwd)
        const relativeToCwd = absoluteTarget === undefined ? undefined : path.relative(store.layout.cwd, absoluteTarget)
        // The host may explicitly exempt patterns (checked before every other
        // rule, so a deployment can carve out its own artifact directory).
        if (relativeToCwd !== undefined && config.boundaryExemptPaths.some((pattern) => pathMatchesPattern(pattern, relativeToCwd))) {
            return undefined
        }
        // The engineering trail is the gate's TRUST ROOT: `mission.json`,
        // `state/**`, `roles/**`, the gate ledger and the receipts all decide
        // whether a write is allowed, so a write-class tool may never touch
        // them — otherwise one `write .dsh/missions/<id>/mission.json` forges an
        // approval and the gate approves itself.
        for (const declared of gated ? declaredTargets : []) {
            const resolved = resolvePath(declared, cwd)
            // Containment is checked on the REAL path: a symlink inside the
            // workspace pointing into `.dsh/` would otherwise pass a lexical
            // check while the bytes land in the trust root (the model could
            // rewrite its own thresholds or baseline through `link/x.json`).
            if (!isReallyInside(store.layout.rootDir, resolved, cwd)) continue
            // The rendered specification is derived and is the one artifact the
            // gate may let through without an approval; everything else under
            // the root is the trust root and stays closed.
            if (isDerivedSpecArtifact(store, resolved)) return undefined
            bump(store.layout.rootDir)
            return trustRootReason(path.relative(store.layout.cwd, resolved))
        }

        const mission = store.resolveForAgent(exec.agent)
        // Declarative negative constraints apply to EVERY tool the mission's
        // specification forbids (`tool:`/`argv:`), not just to writes, so they
        // are evaluated before the write-only checks decide to skip the call.
        if (mission !== undefined && mission.spec?.approvedAt !== undefined) {
            const violation = evaluateConstraints(mission, {
                tool: exec.name,
                args: exec.arguments,
                cwd,
                ...(command === undefined ? {} : { command }),
                writeTargets: declaredTargets,
            })
            if (violation !== undefined) {
                bump(store.layout.rootDir)
                return constraintReason(violation, mission.id)
            }
        }
        if (!gated) {
            // Not attributable to a write. Two shapes are still refused: a shell
            // call whose command we cannot even find (fail closed, same rule as
            // a write tool without a path), and — under `strict` — a command
            // that is write-like but unattributable.
            if (isShellTool && config.shellPolicy !== 'off' && shell === undefined) {
                bump(store.layout.rootDir)
                return shellUnknownReason(mission?.id ?? '(no mission)', exec.name)
            }
            if (isShellTool && shell?.undecidable === true && config.shellPolicy === 'strict') {
                bump(store.layout.rootDir)
                return shellStrictReason(mission?.id ?? '(no mission)', command ?? '', shell.reasons)
            }
            return undefined
        }
        if (mission === undefined) {
            bump(store.layout.rootDir)
            return noMissionReason(exec.agent?.session?.header?.id)
        }
        if (mission.spec === undefined || mission.spec.approvedAt === undefined) {
            bump(store.layout.rootDir)
            return notApprovedReason(mission.id, mission.status)
        }
        if (!config.enforceBoundaries) return undefined
        // A shell tool that we could not attribute is judged by the host policy.
        if (isShellTool && config.shellPolicy !== 'off') {
            if (shell === undefined) {
                bump(store.layout.rootDir)
                return shellUnknownReason(mission.id, exec.name)
            }
            for (const declared of shell.targets) {
                const resolved = resolvePath(declared, cwd)
                const relative = path.relative(store.layout.cwd, resolved)
                if (relative.startsWith('..') || path.isAbsolute(relative) || !pathMatchesAny(mission.spec.fileBoundaries, relative)) {
                    bump(store.layout.rootDir)
                    return shellBoundaryReason(mission.id, relative, mission.spec.fileBoundaries)
                }
            }
            return undefined
        }
        // A write-class tool that declares no path cannot be checked; the
        // documented escape hatch is `exemptTools`, so the default is a refusal
        // rather than a silent bypass.
        if (absoluteTarget === undefined || relativeToCwd === undefined) {
            bump(store.layout.rootDir)
            return unknownTargetReason(mission.id, exec.name)
        }
        // Boundaries are workspace-relative: anything that leaves the workspace
        // is denied regardless of the patterns, because `**` would otherwise
        // match `../other-repo/file.ts`.
        if (relativeToCwd.startsWith('..') || path.isAbsolute(relativeToCwd)) {
            bump(store.layout.rootDir)
            return boundaryReason(mission.id, relativeToCwd, mission.spec.fileBoundaries)
        }
        if (pathMatchesAny(mission.spec.fileBoundaries, relativeToCwd)) return undefined
        bump(store.layout.rootDir)
        return boundaryReason(mission.id, relativeToCwd, mission.spec.fileBoundaries)
    }
    return {
        guard,
        denials: () => [...denialsByRoot.values()].reduce((total, count) => total + count, 0),
        denialsFor: (rootDir: string) => denialsByRoot.get(rootDir) ?? 0,
    }
}

/**
 * Whether a path is one of the *derived* artifacts a model may rewrite.
 *
 * Only the rendered specification is in this set, and only because it is
 * derived: `spec_approve` and the write guard both read `mission.spec`, never
 * the markdown, and a hand-written artifact that disagrees with the record is
 * rejected by the review digest. Everything else under the root decides trust
 * and therefore stays closed.
 */
function isDerivedSpecArtifact(store: MissionStore, absoluteTarget: string): boolean {
    return absoluteTarget.endsWith('.md') && isInside(store.layout.specsDir, absoluteTarget)
}

function trustRootReason(relative: string): string {
    return [
        `spec-gate: \`${relative}\` 属于工程台账（门禁的信任根），不允许通过写类工具修改。`,
        '这些文件（mission.json / state/** / roles/** / gates / receipts / stages / 审计）决定了"这次改动是否被允许"，',
        '只能由插件自己的工具写入：规格用 spec_create，评审用 test_design_review，审批用 spec_approve，',
        '门禁用 quality_gate_run，证据用 evidence_record。',
        '如果你是在做本套件自身的开发，请让宿主在 spec-gate 的 boundaryExemptPaths 里显式放行对应目录。',
    ].join('\n')
}

function constraintReason(violation: ConstraintViolation, missionId: string): string {
    return [
        `spec-gate: ${violation.reason}`,
        `约束原文：\`${violation.constraint.raw}\``,
        '这条约束是规格的一部分（negativeConstraints），门禁会强制它。',
        `下一步：如果确实需要这样做，先 spec_create 修改「负面约束」并重新 spec_approve（mission ${missionId}）。`,
    ].join('\n')
}

function shellBoundaryReason(missionId: string, relative: string, boundaries: readonly string[]): string {
    return [
        `spec-gate: shell 命令要写 \`${relative}\`，不在规格声明的文件边界内，命令被拒绝。`,
        `mission: ${missionId}`,
        `允许的边界：${boundaries.length === 0 ? '(规格未声明任何边界)' : boundaries.join(', ')}`,
        '下一步：把改动收敛到边界内，或先 spec_create 更新 fileBoundaries 并重新 spec_approve。',
    ].join('\n')
}

function shellStrictReason(missionId: string, command: string, reasons: readonly string[]): string {
    return [
        'spec-gate: shell 命令的写入目标无法静态确认，而宿主把 shellPolicy 设为 strict，因此拒绝执行。',
        `mission: ${missionId}`,
        `命令：\`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\``,
        `原因：${reasons.join('；') || '无法归属写入目标'}`,
        '下一步：改用声明了 file_path 的写类工具，或把命令拆成可归属的形式；宿主也可把 shellPolicy 调成 targets/off。',
    ].join('\n')
}

function shellUnknownReason(missionId: string, tool: string): string {
    return [
        `spec-gate: shell 工具 \`${tool}\` 的调用里找不到命令参数，无法校验写入目标，按 fail closed 拒绝。`,
        `mission: ${missionId}`,
        '下一步：把命令放在 command 参数里；或让宿主把该工具加入 exemptTools（显式承担风险）。',
    ].join('\n')
}

function unknownTargetReason(missionId: string, tool: string): string {
    return [
        `spec-gate: 写类工具 \`${tool}\` 没有声明目标路径，无法进行文件边界校验，按 fail closed 拒绝。`,
        `mission: ${missionId}`,
        '宿主可以把它加入 spec-gate 的 exemptTools（显式承担风险），或让该工具在参数里带上 file_path/path。',
    ].join('\n')
}

function boundaryReason(missionId: string, relative: string, boundaries: readonly string[]): string {
    return [
        `spec-gate: 目标路径 \`${relative}\` 不在规格声明的文件边界内，写操作被拒绝。`,
        `mission: ${missionId}`,
        `允许的边界：${boundaries.length === 0 ? '(规格未声明任何边界)' : boundaries.join(', ')}`,
        '下一步：如果确实需要动这个文件，先调用 spec_create 更新规格的 fileBoundaries（并重新 spec_approve），',
        '不要绕过边界——边界外的改动无法被这次的验收标准覆盖。',
    ].join('\n')
}


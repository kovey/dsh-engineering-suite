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

import { matchesShellAllow } from './shell.js'
import { mandateState, pathMatchesAny, pathMatchesPattern, resolvePath, type Mandate, type MissionRecord, type MissionStore, type MissionStoreRegistry } from 'dsh-eng-core'
import path from 'node:path'
import type { AgentLike } from 'dsh-eng-core'
import { evaluateConstraints } from './constraints.js'
import {
    boundaryReason,
    constraintReason,
    shellBoundaryReason,
    shellStrictReason,
    shellUnknownReason,
    trustRootViolation,
    undeclaredCwdReason,
    unknownTargetReason,
} from './guard-messages.js'
import { analyzeShellCommand, shellCommandOf } from './shell.js'
import { shellAllowlistRefusal } from './shell-allowlist.js'
import { stageRoleWriteRefusal } from './stage-roles.js'
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
    /**
     * The runtime trust-root fallback (`trust-root-watch.ts`), when mounted.
     *
     * Read at call time: after an out-of-band change the watcher is `breached`
     * and every write-class call is refused, whatever its target says.
     */
    trustRoot?: () => TrustRootGuard | undefined
}

/** The sliver of `TrustRootWatch` the guard consults (no import cycle). */
export interface TrustRootGuard {
    /** Seed the baseline before the first tool of a workspace runs. */
    ensureBaseline: (cwd: string) => void
    /** The denial text while breached, `undefined` otherwise. */
    reason: () => string | undefined
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

/**
 * A write refused because the mission's mandate is `inferred`.
 *
 * The distinction matters to the model: the specification IS approved, so
 * telling it "no approved spec" would send it to re-approve forever. The honest
 * answer is "this approval is not strong enough", plus the way out.
 */
function inferredMandateReason(missionId: string, mandate: Mandate): string {
    return [
        `spec-gate: mission ${missionId} 的授权强度是 inferred（已记录，但不满足强制门禁），写操作被拒绝。`,
        `审批人：${mandate.approvedBy}（policy ${mandate.policyVersion.slice(0, 12)}，${new Date(mandate.at).toISOString()}）。`,
        'inferred 的含义：这条批准不能证明是一个"被允许的人"做的决定（可能是允许清单之外的审批人、子代理会话、未配置名单时的 IM 点击，或自动审批）。',
        '下一步：由允许清单内的审批人在本地会话重新审批——但同一 mission 的 mandate 不可改写，因此需要新 mission：',
        'spec_create（重新提交规格）→ test_design_review → spec_approve。',
        '（inferred 授权的 observe 模式是下一阶段，尚未实现；在那之前它一律不放行写操作。）',
    ].join('\n')
}

/** A write refused because the stored mandate cannot be trusted (fail closed). */
function invalidMandateReason(missionId: string, reason: string): string {
    return [
        `spec-gate: mission ${missionId} 的 mandate 记录损坏，写操作被拒绝（fail closed）。`,
        `问题：${reason}`,
        '下一步：检查 .dsh/missions/<id>/mission.json（它属于信任根，只能由插件写入）；确认后新建 mission 重新审批。',
    ].join('\n')
}

/**
 * A mission that can no longer authorise writes.
 *
 * `delivered` means the receipt is signed and immutable: any further change would
 * ship without one. `blocked` means the mandate was withdrawn (or the circuit
 * breaker tripped): the authorisation is gone. Both are refused structurally —
 * being inside the declared file boundary is NOT a reason to allow them, which is
 * exactly the hole this closes (a change rode on a delivered mission and had to
 * be retro-fitted into a new one).
 */
function finishedMissionReason(missionId: string, status: string): string | undefined {
    if (status === 'delivered') {
        return (
            `spec-gate: mission ${missionId} 已交付（delivered），回执不可改写，因此不再放行写操作。\n` +
            '这不是边界问题：文件在规格边界内也不行。要继续改动，请用 spec_create 新建 mission 并重新 spec_approve' +
            '（新 mission 会拿到自己的回执），不要复用已交付的授权。'
        )
    }
    if (status === 'blocked') {
        return (
            `spec-gate: mission ${missionId} 已被停止或熔断（blocked），授权已撤回，不再放行写操作。\n` +
            '下一步：确认要继续这项工作后新建 mission（spec_create → test_design_review → spec_approve），不要沿用被撤回的授权。'
        )
    }
    return undefined
}

function notApprovedReason(missionId: string, status: string): string {
    return [
        `spec-gate: 规格 ${missionId} 尚未审批（当前状态 ${status}），写操作被拒绝。`,
        '下一步：调用 spec_approve 取得审批（必要时先用 test_design_review 通过测试设计门禁），再重新执行本写操作。',
    ].join('\n')
}

/**
 * Whether this mission's approval can still authorise a write.
 *
 * Extracted from `createWriteGuard`'s inner loop so the guard function keeps its
 * accepted size (the structural ratchet) and the four decisions stay readable as
 * one list: finished mission → no approved spec → broken mandate → `inferred`
 * mandate. A refusal is returned as text; an approval that stands returns the
 * narrowed spec, so the boundary checks cannot accidentally read an undefined
 * `mission.spec`.
 * @param mission - the resolved mission (only called when it exists).
 */
function authorisationRefusal(mission: MissionRecord): { refusal: string } | { spec: NonNullable<MissionRecord['spec']> } {
    const finished = finishedMissionReason(mission.id, mission.status)
    if (finished !== undefined) return { refusal: finished }
    if (mission.spec === undefined || mission.spec.approvedAt === undefined) {
        return { refusal: notApprovedReason(mission.id, mission.status) }
    }
    // The approval is only as strong as the mandate it produced. An `inferred`
    // mandate (an allowlist that does not contain the approver, a subagent, an
    // IM click with no allowlist, an automatic approval) is RECORDED and
    // REPORTED, but it does not satisfy an enforcing gate: the write is refused
    // here, with the reason naming `inferred` instead of pretending no
    // specification exists. Legacy (no record) passes: it is a pre-mandate
    // approval, treated like explicit for compatibility.
    const mandate = mandateState(mission)
    if (mandate.kind === 'invalid') return { refusal: invalidMandateReason(mission.id, mandate.reason) }
    if (mandate.kind === 'present' && mandate.mandate.strength === 'inferred') {
        return { refusal: inferredMandateReason(mission.id, mandate.mandate) }
    }
    return { spec: mission.spec }
}

/**
 * Build the write guard.
 *
 * Three deterministic checks, in order:
 *  1. the mission has an approved specification (docs.md §3.2) **and its mandate
 *     satisfies this gate** — an `inferred` approval is recorded but does not
 *     authorise writes (see `dsh-eng-core/mandate.ts`; fail closed);
 *  2. the target path is inside the specification's declared **file
 *     boundaries** (docs.md §1.2/§9 — a boundary the host never checks is a
 *     comment, not a constraint);
 *  3. the target is outside the engineering trail (the gate's trust root).
 *
 * A shell command is gated only when it actually WRITES something the analyser
 * could attribute: `ls`, `git status`, `npm test` and other read-only or
 * unattributable commands stay usable before approval. Under
 * `shellPolicy: 'allowlist'` every shell segment is judged first against
 * `shellAllowlist` (see `shell-allowlist.ts`), because "we could not see a
 * write" is exactly the answer that policy refuses to trust; the ordinary
 * target/boundary checks then still run for a listed command.
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
        // The overlay is per workspace; an undeclared cwd never reaches the rules
        // below (it is refused), so the profile config decides that refusal.
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
        const shellTargets = shell?.targets ?? []
        const shellWriteLike = isShellTool && shellTargets.length > 0
        const gated = isWriteTool || shellWriteLike

        const cwd = exec.agent?.session?.header?.cwd
        if (cwd === undefined) {
            // No workspace → no mission resolution we can trust (harness cwd
            // would gate this write against a different project's approvals).
            bump('(undeclared)')
            return undeclaredCwdReason()
        }
        const store: MissionStore = deps.stores.for(cwd)
        // The runtime fallback (see `trust-root-watch.ts`): a trust root changed
        // outside the suite refuses EVERY write-class call, whatever it targets.
        const trustRoot = deps.trustRoot?.()
        trustRoot?.ensureBaseline(cwd)
        // Write-CAPABLE tools only: an unattributable shell command is the hole
        // this fallback exists for, so it is refused too (reads stay open).
        const breach = isWriteTool || isShellTool ? trustRoot?.reason() : undefined
        if (breach !== undefined) {
            bump(store.layout.rootDir)
            return breach
        }
        const mission = store.resolveForAgent(exec.agent)
        // Positive-list mode: "no write target we can see" is exactly what this
        // policy refuses to accept, so it is judged before the target scan.
        const notListed = isShellTool ? shellAllowlistRefusal(config, command, mission?.id ?? '(no mission)') : undefined
        if (notListed !== undefined) {
            bump(store.layout.rootDir)
            return notListed
        }
        const target = writeTargetPath(exec.arguments)
        // Only WRITE-ish targets count: a `read` of a forbidden path is not a
        // modification, and denying it would stop a reviewer reading that file.
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
        const reserved = gated ? trustRootViolation(store, cwd, declaredTargets) : undefined
        if (reserved?.kind === 'allow') return undefined
        if (reserved !== undefined) {
            bump(store.layout.rootDir)
            return reserved.reason
        }

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
            // An unattributable command is refused under `strict`, EXCEPT when it
            // names a reviewed artifact (`config.shellAllow`, e.g. `bash scripts/**`).
            // Arbitrary code and a reviewed script are not equally safe just because
            // neither can be attributed (2026-11: a python heredoc wrote outside the
            // declared boundaries through exactly this gap).
            if (isShellTool && shell?.undecidable === true && config.shellPolicy === 'strict' && !matchesShellAllow(command ?? '', config.shellAllow)) {
                bump(store.layout.rootDir)
                return shellStrictReason(mission?.id ?? '(no mission)', command ?? '', shell.reasons)
            }
            return undefined
        }
        if (mission === undefined) {
            bump(store.layout.rootDir)
            return noMissionReason(exec.agent?.session?.header?.id)
        }
        // A finished mission can never authorise a write, even with a valid-looking
        // approval: the receipt is immutable (delivered) or the mandate is gone
        // (blocked). Checked BEFORE boundaries so "it is inside my spec" cannot
        // become the loophole. The whole approval/mandate sequence lives in
        // `authorisationRefusal`; it hands back the narrowed, approved spec.
        const authorisation = authorisationRefusal(mission)
        if ('refusal' in authorisation) {
            bump(store.layout.rootDir)
            return authorisation.refusal
        }
        const spec = authorisation.spec
        // A stage that declares a role belongs to the child delegated for it.
        // Checked BEFORE the boundary rules (and independently of
        // `enforceBoundaries`): "the target is inside my spec" is not a reason
        // for the lead to do the work itself. Reads never reach this point.
        const roleRefusal = stageRoleWriteRefusal({ layout: config.layout, store, mission, agent: exec.agent, cwd })
        if (roleRefusal !== undefined) {
            bump(store.layout.rootDir)
            return roleRefusal
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
                if (relative.startsWith('..') || path.isAbsolute(relative) || !pathMatchesAny(spec.fileBoundaries, relative)) {
                    bump(store.layout.rootDir)
                    return shellBoundaryReason(mission.id, relative, spec.fileBoundaries)
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
            return boundaryReason(mission.id, relativeToCwd, spec.fileBoundaries)
        }
        if (pathMatchesAny(spec.fileBoundaries, relativeToCwd)) return undefined
        bump(store.layout.rootDir)
        return boundaryReason(mission.id, relativeToCwd, spec.fileBoundaries)
    }
    return {
        guard,
        denials: () => [...denialsByRoot.values()].reduce((total, count) => total + count, 0),
        denialsFor: (rootDir: string) => denialsByRoot.get(rootDir) ?? 0,
    }
}

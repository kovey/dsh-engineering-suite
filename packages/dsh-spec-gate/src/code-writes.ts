/**
 * The stage half of the write guard (AC-006 of 强制进入 implement): an APPROVED
 * mission whose implementation has not STARTED may not take CODE writes.
 *
 * Why this exists next to `stage-roles.ts`: the stage-role rule only speaks for
 * stages that declare a role, so a mission that stayed in `spec-clarify` after
 * approval (exactly what `spec_approve` used to leave behind) was not covered by
 * any rule — the lead could edit the implementation with an approved spec and
 * every gate stayed green. This check is INDEPENDENT of roles: it refuses the
 * lead and the developer child alike until the mission is in `implement` (or a
 * later stage, see {@link implementationStarted}).
 *
 * "Reached implement" is read from durable facts the orchestrator writes
 * (`mission.stage`, its status, the used roles), never from the caller's claim.
 *
 * Deliberate non-behaviours:
 *  - documentation/configuration/trail paths are never refused here — a
 *    mission must be able to write its notes, config and `.dsh/**` artifacts
 *    while it waits for the stage to advance;
 *  - a mission already at/after implementation is untouched: the rule closes
 *    the "approved but implementation untouched" hole, not post-implementation
 *    change control (file boundaries and stage roles keep deciding there);
 *  - a mission that never entered the pipeline (`mission.stage` absent) is
 *    untouched: there is no stage to advance FROM, and the guard must not invent
 *    one (`spec_approve` already asks the orchestrator to start/advance);
 *  - unapproved missions never reach this rule: `guard.ts` checks approval
 *    first, with its existing message.
 *
 * @module dsh-spec-gate/code-writes
 */

import path from 'node:path'
import { resolvePath, type MissionRecord } from 'dsh-eng-core'

/** The stage that owns implementation writes. */
export const CODE_STAGE = 'implement'

/**
 * Standard stages AFTER `implement`: the implementation has already happened,
 * so their writes are a change-control question (file boundaries, roles), not
 * the "approved spec, untouched implementation" hole this rule closes.
 *
 * Keeping them out of this rule is also what keeps the stage-role contract
 * intact (`stage-role-guard.test.ts` TC-1556: a mission in `quality-verify`
 * may write inside its boundaries).
 */
const IMPLEMENTED_STAGES: readonly string[] = [CODE_STAGE, 'quality-verify', 'delivery']

/**
 * Mission statuses that mean implementation STARTED (set by the orchestrator
 * when it enters a stage, see `missionStatusFor` in `dsh-orchestrator`).
 *
 * Needed for custom pipelines whose post-implement stages have other ids: they
 * keep the `implementing` status, so they must not be sent back to "approve
 * again and advance".
 */
const IMPLEMENTED_STATUSES: readonly MissionRecord['status'][] = ['implementing', 'verified', 'delivered']

/** The role the standard `implement` stage declares (recorded on entry). */
const CODE_ROLE = 'developer'

/** Directory segments whose contents are code (the first matching segment decides). */
const CODE_DIRS: readonly string[] = ['packages', 'src', 'app', 'lib', 'tests']

/** Source extensions: a file with one is code wherever it lives. */
const CODE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.go', '.py', '.rs', '.java', '.kt', '.cs', '.php', '.rb', '.swift']

/**
 * Documentation/configuration extensions.
 *
 * Checked BEFORE `CODE_DIRS`, because a `package.json` under `packages/**` is
 * configuration, not code — refusing to edit it would block the very dependency
 * change a mission may need to make before its implementation stage.
 */
const CONFIG_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.txt', '.lock', '.csv']

/** The inputs of the stage rule (the caller has already resolved the mission). */
export interface CodeStageWriteCheck {
    /** The mission the write is attributed to (approved, by construction). */
    mission: MissionRecord
    /** Declared targets: the write tool's path and any attributable shell targets. */
    targets: readonly string[]
    /** The calling session's workspace (targets may be relative to it). */
    cwd: string
    /** The workspace root paths are attributed to (layout.cwd). */
    workspaceRoot: string
}

/**
 * The refusal for a CODE write outside `implement`, or `undefined` when allowed.
 * @param check - mission, targets and the workspace facts.
 * @returns the reason to refuse, or `undefined` when the write may proceed.
 */
export function codeStageWriteRefusal(check: CodeStageWriteCheck): string | undefined {
    if (check.mission.spec?.approvedAt === undefined) return undefined
    const stage = check.mission.stage
    // No stage = never entered a pipeline: no "advance to implement" step exists
    // to point the caller at, so the ordinary approval rules keep deciding (this
    // is also the standalone-spec-gate case its own tests pin).
    if (stage === undefined || stage === '') return undefined
    // Implementation already started: this rule has nothing to say.
    if (implementationStarted(check.mission)) return undefined
    const code = check.targets.map((target) => relativeToRoot(check, target)).find((target) => target !== undefined && isCodePath(target))
    if (code === undefined) return undefined
    return codeStageReason(check.mission.id, stage, code)
}

/**
 * Whether the mission has moved past "approved, implementation untouched".
 *
 * Three durable answers, any of which is enough: it is IN a standard
 * implementation-or-later stage; its status says implementation began; or it
 * has already used a `developer` role (a custom pipeline's equivalent stage).
 * The status/role facts are what keeps a renamed pipeline out of a loop where
 * every code write asks for a stage that does not exist.
 * @param mission - the mission record.
 */
function implementationStarted(mission: MissionRecord): boolean {
    if (IMPLEMENTED_STAGES.includes(mission.stage ?? '')) return true
    if (IMPLEMENTED_STATUSES.includes(mission.status)) return true
    return mission.roles?.includes(CODE_ROLE) === true
}

/** A target as a workspace-relative POSIX path (`undefined` when it escapes). */
function relativeToRoot(check: CodeStageWriteCheck, target: string): string | undefined {
    const relative = path.relative(check.workspaceRoot, resolvePath(target, check.cwd))
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    return relative.split(path.sep).join('/')
}

/**
 * Whether a workspace-relative path is code.
 *
 * The table (the refusal message states the same categories):
 *
 * | path                                            | verdict | why                        |
 * |-------------------------------------------------|---------|----------------------------|
 * | `.dsh/**`, `docs/**`, `*.md`, `CHANGELOG*`      | docs    | the engineering trail/notes |
 * | `*.json`, `*.yml`, `*.toml`, `*.lock`, …        | config  | configuration, not code     |
 * | `*.ts`, `*.tsx`, `*.js`, `*.go`, `*.py`, …      | code    | source extension            |
 * | segment `packages/`/`src/`/`app/`/`lib/`/`tests/` | code  | source directory            |
 * | anything else                                   | other   | untouched                   |
 * @param relative - workspace-relative path with POSIX separators.
 * @returns whether the path must be treated as a code write.
 */
export function isCodePath(relative: string): boolean {
    const posix = relative.replace(/^\.\//, '')
    if (posix === '' || posix === '..' || posix.startsWith('../') || posix.startsWith('/')) return false
    const segments = posix.split('/')
    const base = segments[segments.length - 1] ?? ''
    const lower = base.toLowerCase()
    if (segments[0] === '.dsh' || segments[0] === 'docs') return false
    if (/^(changelog|license|readme)/.test(lower)) return false
    if (CONFIG_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false
    if (CODE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true
    return segments.slice(0, -1).some((segment) => CODE_DIRS.includes(segment))
}

/**
 * The refusal text, written for the model (the only one that can fix it).
 * @param missionId - the mission whose approval is being held back.
 * @param stage - the stage the mission is in now.
 * @param target - the workspace-relative code path the caller tried to write.
 */
export function codeStageReason(missionId: string, stage: string, target: string): string {
    return [
        `spec-gate: mission ${missionId} 的规格已审批，但当前阶段是 ${stage}，不是 implement：代码写入被拒绝（目标：${target}）。`,
        '这条规则与角色无关：审批只确定"允许改什么"（文件边界），"什么时候能改代码"由阶段决定；developer 子会话同样要等阶段推进。',
        `下一步：先 orchestrate advance 到 implement（逐级推进也可以由 spec_approve 成功后的 enterImplement 自动完成），再用 team_delegate({ role: 'developer', task: '<按规格实现>' }) 派发实现。`,
        '文档/配置/台账（docs/**、*.md、.dsh/**、CHANGELOG*、package.json 等）不受这条规则影响，可以先写。',
    ].join('\n')
}

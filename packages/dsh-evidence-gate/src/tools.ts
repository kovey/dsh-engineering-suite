/**
 * The model-facing tool surface: `evidence_record`, `evidence_status`,
 * `mission_complete` (docs.md §3.5, PLUGIN-CONVENTIONS §7).
 * @module dsh-evidence-gate/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
    agentIdOf,
    normalizeApprovalReply,
    renderApprovalContext,
    sessionIdOf,
    type AgentLike,
    type ApprovalLike,
    type MissionStore,
    type MissionStoreRegistry,
} from 'dsh-eng-core'
import { RECORDABLE_KINDS, type EffectiveEvidenceGateConfig } from './config.js'
import { evaluateDelivery, finalizeDelivery, relaxForForce } from './delivery.js'
import { captureEvidence, confirmationText } from './evidence.js'
import { declaredCwd, NO_WORKSPACE_ERROR } from './workspace.js'
import {
    renderAlreadyDelivered,
    renderBlocked,
    renderDelivered,
    renderNoMission,
    renderNoMissionDelivery,
    renderOverview,
} from './report.js'

const TEXT_OUTPUT = { type: 'string' } as const

/** Everything the tools close over. */
export interface ToolDeps {
    /**
     * Effective config for one workspace: the profile configuration overlaid
     * with that workspace's `.dsh/evidence-gate.json` (see
     * `resolveEffectiveConfig`). The profile stays the ceiling.
     */
    configFor: (cwd: string) => EffectiveEvidenceGateConfig
    stores: MissionStoreRegistry
    /** The approval seam, read at call time (`ctx.get('approval')`). */
    approval?: () => ApprovalLike | undefined
}

interface RecordArgs {
    missionId?: string
    kind?: string
    summary?: string
    command?: string
    exitCode?: number
    output?: string
    artifactPath?: string
    note?: string
}

interface StatusArgs {
    missionId?: string
}

interface CompleteArgs {
    missionId?: string
    summary?: string
    force?: boolean
}

function agentOf(exec: unknown): AgentLike | undefined {
    return (exec as { agent?: AgentLike }).agent
}

/**
 * The store, agent and workspace of one tool call.
 *
 * The workspace is the one the session DECLARED (`session.header.cwd`); there
 * is deliberately no `process.cwd()` fallback (see {@link declaredCwd}): a
 * session that named no workspace would otherwise resolve its mission store —
 * and record evidence and issue receipts — inside the harness's own directory,
 * i.e. inside a different project. The store needs a layout, so even an
 * explicit `missionId` cannot be honoured without a workspace.
 * @throws when the session declared no workspace.
 */
function storeFor(deps: ToolDeps, exec: unknown): { store: MissionStore; agent: AgentLike | undefined; cwd: string } {
    const agent = agentOf(exec)
    const cwd = declaredCwd(agent)
    if (cwd === undefined) throw new Error(NO_WORKSPACE_ERROR)
    return { store: deps.stores.for(cwd), agent, cwd }
}

function recordedBy(agent: AgentLike | undefined): string {
    return agentIdOf(agent) ?? sessionIdOf(agent) ?? 'unknown-agent'
}

/**
 * Resolve the mission for one tool call.
 *
 * Deliberately NO `fallbackLatest`: "the newest mission in the workspace" may
 * belong to another session, and a tool call must never annotate — let alone
 * deliver — a mission it was not given. Order: explicit `missionId` → the
 * session's bound mission → the delegated parent session's mission (the child
 * inherits its parent's mission through its own session header).
 */
function resolve(store: MissionStore, agent: AgentLike | undefined, explicitId?: string) {
    return store.resolveForAgent(agent, explicitId === undefined ? {} : { explicitId })
}

/** The Chinese error shown when no mission resolves, naming both ways forward. */
function noMissionError(): string {
    return [
        '没有可登记的 mission：本会话既没有绑定 mission，也没有可继承的委派父会话 mission（不会回退到工作区里最新的 mission——那可能是别的会话的任务）。',
        '- ❌ mission 已解析 — 解析顺序：显式 missionId → 本会话绑定的 mission → 委派父会话的 mission',
        '  → 下一步：spec_create（先调用 spec_create 建立规格与 mission，再调用 evidence_record）或 orchestrate start（建立并绑定流水线 mission）',
        '  → 或者显式传入 missionId（例如 missionId: "M-…"）',
    ].join('\n')
}

/** Register every evidence-gate tool. */
export function registerTools(
    ctx: { tools: { register: (definition: never) => () => void } },
    deps: ToolDeps,
): { disposers: (() => void)[]; registered: string[]; failed: string[] } {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []

    const register = (definition: unknown, name: string): void => {
        try {
            disposers.push(ctx.tools.register(definition as never))
            registered.push(name)
        } catch (error) {
            failed.push(name)
            void error
        }
    }

    register(
        defineTool({
            name: 'evidence_record',
            description:
                'Record one piece of verifiable evidence for the current mission: a command run, a test report, a Git diff fingerprint, an artifact or a manual claim. The row is bound to the current Git fingerprint and an output digest (sha256) plus a bounded output tail, and it is what mission_complete later checks. Failed runs are recorded (they are informative) but never satisfy the delivery checklist: only a command/test row with exitCode 0, a command line and real captured output counts, and a manual claim never counts. Fail closed: a manual claim without a note is refused, and a mission that cannot be resolved (no missionId, no session binding, no delegated parent) is an error. The mission is never guessed from "the newest mission in the workspace", and the workspace is the session\'s own (`session.header.cwd`): a session that declared none is refused instead of writing evidence into the harness\'s directory.',
            parameters: {
                missionId: {
                    type: 'string',
                    description: 'Mission to attach the evidence to (default: the session mission).',
                },
                kind: {
                    type: 'string',
                    enum: [...RECORDABLE_KINDS] as string[],
                    required: true,
                    description:
                        'Evidence kind. `command`/`test` carry a command line, exit code and output; `diff` captures the git diff summary; `artifact` points at a file; `manual` requires a note. (`gate` rows are written by dsh-quality-gate, not here.)',
                },
                summary: {
                    type: 'string',
                    required: true,
                    description: 'One-line human summary of what this evidence proves.',
                },
                command: { type: 'string', description: 'Exact command line that was run (command/test evidence).' },
                exitCode: {
                    type: 'integer',
                    description: 'Exit code of the command; a non-zero exit is recorded, never hidden.',
                },
                output: {
                    type: 'string',
                    description: 'Captured output: stored as a sha256 digest plus a bounded tail.',
                },
                artifactPath: { type: 'string', description: 'Path of the artifact this evidence refers to.' },
                note: {
                    type: 'string',
                    description: 'Required for kind=manual: the human-readable justification of the claim.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: RecordArgs = {} as RecordArgs, exec) {
                const { store, agent, cwd } = storeFor(deps, exec)
                // The checklist is the *workspace's* effective configuration:
                // the profile overlaid with this repo's .dsh/evidence-gate.json.
                const config = deps.configFor(cwd).config
                const mission = resolve(store, agent, args.missionId)
                if (mission === undefined) throw new Error(noMissionError())
                const capture = captureEvidence(args, { cwd, maxOutputTail: config.maxOutputTail })
                const record = store.appendEvidence(mission.id, {
                    kind: capture.kind,
                    summary: capture.summary,
                    recordedBy: recordedBy(agent),
                    ...(capture.command === undefined ? {} : { command: capture.command }),
                    ...(capture.exitCode === undefined ? {} : { exitCode: capture.exitCode }),
                    outputDigest: capture.outputDigest,
                    ...(capture.outputTail === undefined ? {} : { outputTail: capture.outputTail }),
                    git: capture.git,
                    ...(capture.artifactPath === undefined ? {} : { artifactPath: capture.artifactPath }),
                    ...(capture.data === undefined ? {} : { data: capture.data }),
                })
                return confirmationText(record, mission.id, capture.diffSummary)
            },
        }),
        'evidence_record',
    )

    register(
        defineTool({
            name: 'evidence_status',
            description:
                'Show the whole Mission → Evidence → Quality Gate → Receipt flow of one mission: specification approval, evidence counts and the newest rows, the latest gate verdict, issued receipts, and the fail-closed checklist of everything still missing before mission_complete can succeed. It renders exactly the checklist the delivery path decides with, so reporting and deciding never diverge. The mission is explicit missionId → session binding → delegated parent session; nothing is guessed, and the checklist is the calling workspace\'s (`session.header.cwd`) — a session that declared no workspace is refused rather than reporting on another project.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to inspect (default: the session mission).' },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: StatusArgs = {} as StatusArgs, exec) {
                const { store, agent, cwd } = storeFor(deps, exec)
                const effective = deps.configFor(cwd)
                const mission = resolve(store, agent, args.missionId)
                if (mission === undefined) return renderNoMission(args.missionId)
                const evaluation = evaluateDelivery({ store, mission, config: effective.config, cwd })
                return renderOverview({
                    mission,
                    evaluation,
                    config: effective.config,
                    configSource: effective,
                    receipts: store.readReceipts(mission.id),
                })
            },
        }),
        'evidence_status',
    )

    register(
        defineTool({
            name: 'mission_complete',
            description:
                'Deliver a mission: verify that the mission is not blocked, that the specification is approved, that the quality gate returned a genuine, complete, deterministic PASS covering the newest command/test evidence, that the working tree is still the one the gate observed, and that every configured evidence kind is satisfied by a successful row; then issue an immutable receipt and mark the mission delivered. A PASS is only accepted when its gate record has scope.full=true, a non-empty result list, and a matching ledger row (kind=gate with data.gateId) — a hand-written gates/*.json without its ledger row is treated as a forgery. Fail closed: a missing/WARN/BLOCK/partial/forged/stale gate, a blocked mission or missing evidence is refused with the exact next tool call, and the mission status is left untouched. `force` never bypasses the gate; it only downgrades the required-evidence-kinds check and leaves a manual override row. Delivery happens in the calling session\'s own workspace (`session.header.cwd`); a session that declared no workspace is refused instead of issuing a receipt for another project.',
            parameters: {
                missionId: { type: 'string', description: 'Mission to deliver (default: the session mission).' },
                summary: { type: 'string', description: 'Optional delivery note recorded on the report.' },
                force: {
                    type: 'boolean',
                    description:
                        'Downgrade ONLY the required-evidence-kinds check and record a manual override row. It never bypasses a missing/WARN/BLOCK/stale quality gate or an unapproved specification.',
                },
            },
            output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args: CompleteArgs = {} as CompleteArgs, exec) {
                const { store, agent, cwd } = storeFor(deps, exec)
                // Effective config of the calling workspace; `allowForceOverride`
                // is host-only, so a project file can never open this escape hatch.
                const config = deps.configFor(cwd).config
                const mission = resolve(store, agent, args.missionId)
                if (mission === undefined) return renderNoMissionDelivery(args.missionId)
                // The receipt is immutable: a delivered mission is never re-issued.
                const receipts = store.readReceipts(mission.id)
                const issued = receipts[receipts.length - 1]
                if (issued !== undefined) return renderAlreadyDelivered(mission, issued)

                const evaluation = evaluateDelivery({ store, mission, config, cwd })
                // The host decides whether the override exists at all: with the
                // default `allowForceOverride: false`, asking for `force` is
                // simply not honoured (and the report says so).
                const forceRequested = args.force === true && config.allowForceOverride
                const forceRefused = args.force === true && !config.allowForceOverride
                const relaxation = relaxForForce(evaluation, forceRequested)
                let deliveryApproval: { by: string; source: string; messageId: string } | undefined
                // The human decision comes AFTER the deterministic checklist: a
                // person may approve a delivery that the gates accepted, never one
                // they refused. Asking first would invite rubber-stamping of a
                // delivery that is about to be refused anyway.
                if (relaxation.failures.length === 0 && config.requireDeliveryApproval) {
                    const seam = deps.approval?.()
                    if (seam === undefined) {
                        throw new Error(
                            '宿主要求交付前人工审批（requireDeliveryApproval=true），但没有装配审批通道（ctx.get("approval") 为空）：' +
                                '按 fail closed 拒绝签发回执。下一步：装配审批插件，或把 requireDeliveryApproval 设为 false。',
                        )
                    }
                    const decided = normalizeApprovalReply(
                        await seam.request({
                            ...(agent === undefined ? {} : { agent }),
                            toolName: 'mission_complete',
                            reason: renderApprovalContext(
                                [
                                    `交付审核：mission ${mission.id}（${mission.title}）`,
                                    '',
                                    '确定性检查已全部通过，等你决定是否签发回执：',
                                    ...evaluation.checks.filter((check) => check.ok).map((check) => `- ✅ ${check.label}`),
                                    '',
                                    `证据 ${evaluation.evidence.length} 条；门禁 ${evaluation.gate?.id ?? '(无)'}；指纹 ${evaluation.fingerprint.isRepo ? `${evaluation.fingerprint.branch}@${evaluation.fingerprint.head?.slice(0, 8) ?? '?'}` : 'not a git repository'}`,
                                ].join('\n'),
                                {
                                    kind: 'delivery',
                                    missionId: mission.id,
                                    title: mission.title,
                                    facts: {
                                        证据: evaluation.evidence.length,
                                        门禁: evaluation.gate?.state ?? '(无)',
                                        检查项: evaluation.checks.length,
                                    },
                                    channelHints: { buttons: ['交付', '打回'], requiresReason: true },
                                },
                            ),
                            ...((exec as { signal?: AbortSignal }).signal === undefined
                                ? {}
                                : { signal: (exec as { signal?: AbortSignal }).signal }),
                        }),
                    )
                    if (!decided.allowed) {
                        return [
                            `❌ mission ${mission.id} 未交付：人工审批未通过（${decided.decision}${decided.by === '' ? '' : `，by ${decided.by}`}${decided.source === '' ? '' : ` via ${decided.source}`}）。`,
                            '',
                            '确定性检查全部通过，只有人的决定拦下了它。下一步：把原因写进规格或证据后重新调用 mission_complete。',
                        ].join('\n')
                    }
                    // Carry the decision into the receipt below.
                    deliveryApproval = { by: decided.by === '' ? 'approval' : decided.by, source: decided.source, messageId: decided.messageId }
                }
                if (relaxation.failures.length > 0) {
                    return [
                        ...(forceRefused
                            ? [
                                  'ℹ️ 本次调用的 force=true 未被采纳：宿主的 dsh-evidence-gate 配置里 allowForceOverride=false（默认），',
                                  '   交付判定不接受任何人工放松。需要这个逃生舱时由宿主显式开启并自行承担风险。',
                                  '',
                              ]
                            : []),
                        renderBlocked({
                            mission,
                            evaluation,
                            failures: relaxation.failures,
                            refused: relaxation.refused,
                            forceRequested,
                        }),
                    ].join('\n')
                }
                const outcome = finalizeDelivery({
                    store,
                    mission,
                    evaluation,
                    cwd,
                    ...(relaxation.overrideNote === undefined ? {} : { overrideNote: relaxation.overrideNote }),
                    // Who approved the delivery rides into the receipt: a receipt
                    // that cannot name the approver is not an audit trail.
                    ...(deliveryApproval === undefined ? {} : { approval: deliveryApproval }),
                })
                return [
                    renderDelivered({
                        mission,
                        evaluation,
                        outcome,
                        ...(args.summary === undefined ? {} : { summary: args.summary }),
                    }),
                    ...(deliveryApproval === undefined
                        ? []
                        : [
                              '',
                              `人工交付审批：by ${deliveryApproval.by}${deliveryApproval.source === '' ? '' : ` via ${deliveryApproval.source}`}${deliveryApproval.messageId === '' ? '' : ` #${deliveryApproval.messageId}`}`,
                          ]),
                ].join('\n')
            },
        }),
        'mission_complete',
    )

    return { disposers, registered, failed }
}

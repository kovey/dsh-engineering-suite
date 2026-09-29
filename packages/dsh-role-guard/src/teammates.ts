/**
 * Teammates this plugin did NOT create: the durable "ungoverned" record.
 *
 * The official Agent Teams surface (`spawn_teammate`, and any plugin calling
 * `agentTeams.spawnTeammate` directly) creates teammates with no role policy:
 * no persona shadow, no host-enforced tool whitelist, no model route (see
 * `agent-teams.ts` for the exact API gap). This plugin cannot prevent that —
 * a programmatic `spawnTeammate` never passes a tool guard, so a
 * `ctx.tools.guard` denial would cover only the model-facing tool and would
 * make the block look complete while it is not. What it CAN do is refuse to
 * treat such a teammate as governed, and say so durably:
 *
 *  - the roster write the official service journals into the Team Lead's log
 *    (`session/event` → `event.type === 'team/member'`) is observed;
 *  - every observed teammate is recorded as `governance: 'ungoverned'` at
 *    `<root>/state/teammates/<sessionId>.json`, together with WHAT role-guard
 *    did not apply and WHY — role-guard's own verdict, written against a
 *    durable harness fact, never a teammate's claim about itself.
 *
 * The record is evidence of a GAP, not a grant: nothing in this plugin reads it
 * to allow anything. (The skill gate keeps looking up role bindings on its own,
 * so a teammate that inherited a role binding one hop up stays restricted.)
 *
 * @module dsh-role-guard/teammates
 */

import path from 'node:path'
import { assertSafeId, readJson, writeJsonAtomic } from 'dsh-eng-core'
import type { Layout, Logger } from 'dsh-eng-core'

/** Durable teammate lifecycle, as the official roster journals it. */
export type TeammatePhase = 'provisioning' | 'active' | 'failed'

/** What this plugin did not apply to a teammate created outside its path. */
export const UNGOVERNED_MISSING: readonly string[] = [
    'persona 影子段（teammate 跑在部署 persona 下，不是角色的 persona）',
    '工具白名单（宿主强制；teammate 继承 Lead 的全部工具，只读角色的降权也不生效）',
    '模型路由（teammate 继承 Lead 的 provider/model，不是角色文件里的路由）',
]

/** One-line explanation of the verdict, for a reader who never saw the code. */
export const UNGOVERNED_REASON =
    '该 teammate 由官方 Agent Teams 路径创建，未经 team_delegate：role-guard 没有对它施加任何角色策略。要最小权限，请用 team_delegate。'

/** One observed teammate, as the official `team/member` roster event carries it. */
export interface TeammateObservation {
    /** The teammate's durable session id. */
    sessionId: string
    /** Team identity: the Team Lead's (root) session id. */
    teamId: string
    /** Model-facing teammate name (a roster label, never an authorisation). */
    name: string
    phase: TeammatePhase
    /** Workspace of the Team Lead's session, when its header carries one. */
    cwd?: string
}

/** One durable ungoverned-teammate record. */
export interface TeammateRecord {
    sessionId: string
    teamId: string
    name: string
    /** Last observed lifecycle phase. */
    phase: TeammatePhase
    /** Always `'ungoverned'`: this plugin applied no delegation policy to it. */
    governance: 'ungoverned'
    /** The role-policy pieces this plugin did NOT apply. */
    missing: readonly string[]
    /** Which harness fact this verdict was written against. */
    provenance: 'team/member'
    reason: string
    /** First observation (a teammate keeps the timestamp it was first seen at). */
    observedAt: number
    /** Last observation. */
    updatedAt: number
}

const PHASES: readonly TeammatePhase[] = ['provisioning', 'active', 'failed']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Path of one teammate's record file.
 * @param layout - the workspace layout of the Team Lead's session.
 * @param sessionId - the teammate's session id (validated as a path segment).
 * @throws when the id could escape the state directory.
 */
export function teammateFile(layout: Layout, sessionId: string): string {
    return path.join(layout.stateDir, 'teammates', `${assertSafeId(sessionId, 'session id')}.json`)
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/** Validate a parsed file into a record, or `undefined` when unusable. */
function asRecord(value: unknown, sessionId: string): TeammateRecord | undefined {
    if (!isRecord(value)) return undefined
    const stored = text(value['sessionId'])
    const governance = value['governance']
    if (governance !== 'ungoverned') return undefined
    const phase = value['phase']
    return {
        sessionId: stored ?? sessionId,
        teamId: text(value['teamId']) ?? '',
        name: text(value['name']) ?? '',
        phase: PHASES.includes(phase as TeammatePhase) ? (phase as TeammatePhase) : 'provisioning',
        governance: 'ungoverned',
        missing: stringList(value['missing']),
        provenance: 'team/member',
        reason: text(value['reason']) ?? UNGOVERNED_REASON,
        observedAt: typeof value['observedAt'] === 'number' && Number.isFinite(value['observedAt']) ? value['observedAt'] : 0,
        updatedAt: typeof value['updatedAt'] === 'number' && Number.isFinite(value['updatedAt']) ? value['updatedAt'] : 0,
    }
}

/**
 * The record stored for exactly this teammate session.
 * @returns the record, or `undefined` when there is none, it is unreadable, or
 *   the id is unusable.
 */
export function readTeammate(layout: Layout, sessionId: string): TeammateRecord | undefined {
    try {
        return asRecord(readJson<unknown>(teammateFile(layout, sessionId)), sessionId)
    } catch {
        return undefined
    }
}

/**
 * Parse one `session/event` dispatch into a teammate observation.
 *
 * Total: anything that is not a well-formed `team/member` event (another event
 * type, a payload from a newer/older version, a hostile object) reads as "not a
 * teammate" instead of throwing inside an event listener.
 * @param session - the session whose log grew (the Team Lead's).
 * @param event - the appended session event.
 * @returns the observation, or `undefined` when this is not a teammate roster write.
 */
export function teammateObservation(session: unknown, event: unknown): TeammateObservation | undefined {
    try {
        if (!isRecord(event) || event['type'] !== 'team/member') return undefined
        const data = event['data']
        if (!isRecord(data)) return undefined
        const member = data['member']
        if (!isRecord(member)) return undefined
        const sessionId = text(member['id'])
        const phase = member['phase']
        if (sessionId === undefined || !PHASES.includes(phase as TeammatePhase)) return undefined
        const header = isRecord(session) ? session['header'] : undefined
        const cwd = isRecord(header) ? text(header['cwd']) : undefined
        return {
            sessionId,
            teamId: text(data['teamId']) ?? '',
            name: text(member['name']) ?? sessionId,
            phase: phase as TeammatePhase,
            ...(cwd === undefined ? {} : { cwd }),
        }
    } catch {
        return undefined
    }
}

/** The outcome of one {@link TeammateAuditStore.record} call. */
export interface TeammateRecordResult {
    record: TeammateRecord
    /** Whether this was the first observation of that teammate. */
    created: boolean
}

/**
 * Writes ungoverned-teammate records for one workspace.
 *
 * Idempotent and additive: a later roster write for the same teammate updates
 * its phase and `updatedAt` while keeping the first `observedAt`, so a reload or
 * a recovery pass cannot turn one teammate into two records.
 */
export class TeammateAuditStore {
    constructor(private readonly logger?: Logger) {}

    /**
     * Record one observed teammate.
     * @param layout - the workspace the teammate belongs to (the Lead's).
     * @param observation - the parsed roster event.
     * @returns the written record, or `undefined` when it could not be stored
     *   (the caller must report it: an unrecorded teammate is untracked, and
     *   that is exactly the state this store exists to avoid).
     */
    record(layout: Layout, observation: TeammateObservation): TeammateRecordResult | undefined {
        try {
            const previous = readTeammate(layout, observation.sessionId)
            const now = Date.now()
            const record: TeammateRecord = {
                sessionId: observation.sessionId,
                teamId: observation.teamId,
                name: observation.name,
                phase: observation.phase,
                governance: 'ungoverned',
                missing: [...UNGOVERNED_MISSING],
                provenance: 'team/member',
                reason: UNGOVERNED_REASON,
                observedAt: previous === undefined || previous.observedAt <= 0 ? now : previous.observedAt,
                updatedAt: now,
            }
            writeJsonAtomic(teammateFile(layout, observation.sessionId), record)
            return { record, created: previous === undefined }
        } catch (error) {
            this.logger?.warn(`cannot record the teammate "${observation.sessionId}" as ungoverned:`, error)
            return undefined
        }
    }
}

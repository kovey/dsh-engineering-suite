/**
 * The `userQuestions` review route, and the caller it must NOT ask on 0.2.2-rc.2.
 *
 * `user-questions` is the official structured-review seam the desktop app and the
 * web TUI render (markdown `detail` + `plan-review` intent), so it stays the
 * second route of `spec_approve`'s rich surface. But rc.2 changed WHO may ask:
 *
 *  - rc.1 refused a caller whose agent was not in `agents.roots()` — runtime
 *    ownership, i.e. "a child owned by another live agent has no human answerer";
 *  - rc.2 refuses a caller whose live agent has `session.header.origin ===
 *    'subagent'` (`UserQuestionError` code `DELEGATED_CALLER`) — the same
 *    practical answer for a delegated child, decided from the session's DURABLE
 *    origin instead of runtime ownership (a historical fork may still ask).
 *
 * So a delegated child asking would always be refused: the card is never
 * rendered, and the failure surfaces as a generic "channel unavailable" line —
 * indistinguishable from a host defect. This module answers "is the CALLER a
 * delegated child of THIS mission?" from facts we own:
 *
 *  - the delegation ledger (`<layout>/state/delegations.jsonl`, written by
 *    `dsh-role-guard` after `team_delegate`/auto-dispatch) names the child
 *    session for this mission — `readDelegations`, not `matchesDelegation`:
 *    that helper answers "was THIS stage/role delegated to this child", while the
 *    question here is "did this mission delegate to this session at all" (the
 *    approval may happen in a stage that declares no role);
 *  - the session header's `origin` covers a ledger write that failed (role-guard
 *    warns and lets the child work — the delegation is real, the row is missing).
 *
 * Either way the route declines BEFORE a question is built or sent, and the
 * caller keeps its own routes (`nvim-tui` card → host `approval/request`, neither
 * of which carries the subagent restriction). With `reviewChannel=questions`
 * there is nothing to fall back to by configuration, so the route refuses LOUDLY
 * (a `questions`-only configuration must not silently become a seam approval).
 *
 * @module dsh-spec-gate/review-questions
 */

import path from 'node:path'
import { isSubagent, sessionIdOf, type AgentLike, type MissionRecord, type MissionStore } from 'dsh-eng-core'
import { readDelegations } from 'dsh-eng-core/delegations'
import { APPROVE_LABEL, reviewCardOf } from './review-card.js'

/** Structural view of `@deepseek-ai/dsh-user-questions`' service. */
export interface QuestionsLike {
    ask: (request: {
        agent: AgentLike
        signal?: AbortSignal
        /** Keys the client card to the real tool call (never a fabricated id). */
        wait?: { callId: string; timed?: boolean }
        questions: {
            id: string
            question: string
            /** Rendered as markdown by the client UIs (desktop / web TUI). */
            detail?: string
            header?: string
            multiSelect?: boolean
            options?: { label: string; description?: string }[]
            /**
             * Presentation intent. `plan-review` is the official "a document is
             * submitted for review" card: `detail` is the document itself (markdown,
             * which the clients beautify) and `approve` names the approving option;
             * every other option declines it.
             */
            intent?: { kind: 'plan-review'; detail: string; approve: string }
        }[]
    }) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

/** A caller that rc.2's `user-questions` will refuse, and where that fact came from. */
export interface DelegatedCaller {
    sessionId: string
    /** `ledger` = this mission's delegation ledger names the session; `origin` = the header says subagent. */
    basis: 'ledger' | 'origin'
    role?: string
    stage?: string
}

/**
 * Whether the calling session is a delegated child of this mission.
 *
 * An absent/truncated ledger reads as "no delegation" for that basis, which is
 * why the session header is consulted too: the two together can only ADD a
 * skip, never authorise anything (this module decides no approval).
 * @param input - the mission, its store (for layout overrides) and the caller.
 * @returns the caller identity and the basis, or `undefined` for a root session.
 */
export function delegatedCallerOf(input: {
    mission: MissionRecord
    store: MissionStore
    agent: AgentLike | undefined
}): DelegatedCaller | undefined {
    const sessionId = sessionIdOf(input.agent)
    if (sessionId === undefined) return undefined
    const record = readDelegations(input.mission.cwd, input.mission.id, input.store.layout).find(
        (row) => row.childSessionId === sessionId,
    )
    if (record !== undefined) {
        return {
            sessionId,
            basis: 'ledger',
            role: record.role,
            ...(record.stage === undefined ? {} : { stage: record.stage }),
        }
    }
    return isSubagent(input.agent) ? { sessionId, basis: 'origin' } : undefined
}

/** Why the questions route cannot carry this decision (one sentence, reused by log and refusal). */
function delegatedCallerReason(caller: DelegatedCaller, missionId: string): string {
    const who =
        caller.basis === 'ledger'
            ? `委派台账里 mission ${missionId} 的子会话 ${caller.sessionId}（${caller.role ?? 'unknown'}${caller.stage === undefined ? '' : `@${caller.stage}`}）`
            : `session.header.origin=subagent 的调用会话 ${caller.sessionId}`
    return (
        `${who} 是被委派的子会话：0.2.2-rc.2 的 user-questions 对这类调用直接抛 DELEGATED_CALLER` +
        '（子会话没有人类应答者），问出去只会是一张没人看得到的卡片'
    )
}

/**
 * Decline the route: log + skip, or refuse when the configuration allows nothing else.
 * @returns always `undefined` (the route could not answer) unless it threw.
 */
function declineDelegatedQuestions(
    caller: DelegatedCaller,
    input: { missionId: string; strict?: boolean; log: (message: string) => void },
): undefined {
    const reason = delegatedCallerReason(caller, input.missionId)
    if (input.strict === true) {
        throw new Error(
            `规格审批未进行（no-answerer）：${reason}。reviewChannel=questions 要求走这条通道，本套件不会静默降级。` +
                '下一步（任选其一）：把 spec-gate 的 reviewChannel 改回 auto（改用 nvim-tui 卡片或宿主审批接缝）；' +
                `让主会话调用 spec_approve；或直接在对话里说明验收标准要改什么。（mission ${input.missionId}）`,
        )
    }
    input.log(`questions 通道跳过：${reason}；本次改走 nvim-tui 卡片或宿主审批接缝`)
    return undefined
}

/**
 * Ask for approval through the host's structured-question seam.
 *
 * Why this seam and not the approval one: the approval waterfall carries a single
 * `reason` STRING, so a client can only show one blob. `user-questions` carries
 * structured questions with markdown `detail` and an `intent`, which is what the
 * desktop app and the web TUI render as a real review card. The decision still
 * lands in our own ledger and mandate — the answer is mapped to the host's
 * approval vocabulary, never treated as an authorisation by itself.
 * @param input - seam, caller identity, mission, the reviewer-facing text, and
 *   whether `user-questions` is the ONLY configured route (`strict`).
 * @returns the mapped decision, or `undefined` when this route cannot answer.
 */
export async function reviewThroughQuestions(input: {
    questions: QuestionsLike
    agent: AgentLike
    signal?: AbortSignal
    callId?: string
    mission: MissionRecord
    store: MissionStore
    missionsDir: string
    round: number
    /** `reviewChannel=questions`: skipping this route must refuse, not fall back. */
    strict?: boolean
    log: (message: string) => void
}): Promise<
    | { decision: 'allowed-once'; by: 'approval'; messageId: string; source: 'questions'; allowed: true }
    | { outcome: 'rejected'; note?: string }
    | { outcome: 'cancelled' }
    | undefined
> {
    const { mission, round } = input
    const delegated = delegatedCallerOf(input)
    if (delegated !== undefined) {
        return declineDelegatedQuestions(delegated, {
            missionId: mission.id,
            ...(input.strict === true ? { strict: true } : {}),
            log: input.log,
        })
    }
    const question = reviewQuestionOf(mission, input.store, input.missionsDir, round)
    // Built out of the `try` on purpose: the nesting metric counts object
    // literals, and this request + its nested `wait` object inside `try` is 5
    // brace levels — over the limit for a file that starts without a baseline
    // (tools.ts, its old home, was already accepted at depth 9).
    const wait = input.callId === undefined ? {} : { wait: { callId: input.callId } }
    const request = {
        agent: input.agent,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...wait,
        questions: [question],
    }
    try {
        const answer = await input.questions.ask(request)
        const row = answer.answers[0]
        if (row === undefined) return undefined
        const selected = row.selected ?? []
        if (selected.includes(APPROVE_LABEL)) {
            input.log(`questions 通道：${mission.id} 第 ${round} 轮通过`)
            return { decision: 'allowed-once', by: 'approval', messageId: '', source: 'questions', allowed: true }
        }
        const note = (row.custom ?? '').trim() || selected.join('、')
        input.log(`questions 通道：${mission.id} 第 ${round} 轮被打回（${note || '未填理由'}）`)
        return { outcome: 'rejected', ...(note === '' ? {} : { note }) }
    } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'ASK_ABORTED') return { outcome: 'cancelled' }
        input.log(`questions 通道不可用（${error instanceof Error ? error.message : String(error)}）：回落到审批接缝`)
        return undefined
    }
}

/** The artifacts a reviewer should be able to open before deciding. */
export function approvalArtifacts(mission: MissionRecord, missionsDir: string): string[] {
    return [
        ...(mission.specPath === undefined ? [] : [mission.specPath]),
        path.relative(mission.cwd, path.join(missionsDir, mission.id, 'test-design-review.md')),
    ]
}

/** The `plan-review` card for one round: the specification itself, as markdown. */
function reviewQuestionOf(mission: MissionRecord, store: MissionStore, missionsDir: string, round: number) {
    return reviewCardOf({ mission, store, artifacts: approvalArtifacts(mission, missionsDir), round })
}

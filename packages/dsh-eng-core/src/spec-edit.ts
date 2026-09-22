/**
 * Requirement-level editing: stable ids, change history and impact analysis.
 *
 * A specification is not written once. Requirements get added when a gap shows
 * up, reworded when they turn out ambiguous, and dropped when the scope shrinks —
 * and every one of those edits has to travel the same route as the original
 * document: new revision, approval revoked, test design re-reviewed, human
 * re-approval.
 *
 * The reason this module exists at all is ID STABILITY. Test cases cite
 * `AC-003`; if a rewrite renumbers the criteria, every citation silently starts
 * pointing at a different requirement — coverage that looks green and checks
 * nothing. So:
 *
 *  - an id is assigned once and **kept with its text** across revisions;
 *  - a removed id is RETIRED and never reused, so a stale citation can never
 *    resolve to a new requirement;
 *  - adding in the middle allocates a fresh id instead of shifting the others.
 *
 * @module dsh-eng-core/spec-edit
 */

import type { AcceptanceCriterion, Requirement, SpecChange, SpecRecord, TestCase } from './types.js'

/** Serial prefixes used by the two list-shaped parts of a specification. */
const PREFIX = { requirement: 'R', criterion: 'AC' } as const

/** Numeric suffix of an id like `AC-007`, or `undefined` when it is not one. */
function idNumber(id: string, prefix: string): number | undefined {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
    if (match === null) return undefined
    const value = Number.parseInt(match[1] as string, 10)
    return Number.isFinite(value) ? value : undefined
}

/**
 * Allocate the next free id for a prefix.
 *
 * Both the LIVE and the RETIRED ids are considered, which is what makes
 * retirement real: reusing a removed id would let an old test case citation
 * resolve to a brand-new requirement.
 * @param prefix - `R` or `AC`.
 * @param live - ids currently in the document.
 * @param retired - ids removed by earlier revisions.
 * @param width - zero padding (3 for both parts today).
 */
export function nextFreeId(prefix: string, live: readonly string[], retired: readonly string[], width = 3): string {
    let highest = 0
    for (const id of [...live, ...retired]) {
        const value = idNumber(id, prefix)
        if (value !== undefined && value > highest) highest = value
    }
    return `${prefix}-${String(highest + 1).padStart(width, '0')}`
}

/**
 * Re-apply ids to a submitted list, preserving them by TEXT.
 *
 * Matching is by trimmed text, first occurrence first: an unchanged requirement
 * keeps its id no matter where it moved to, and a reworded one is treated as a
 * new entry (which is the honest reading — the statement changed, so the
 * citations must be re-checked). Ids are allocated from {@link nextFreeId}, so a
 * removed id is never handed out again.
 * @param prefix - `R` or `AC`.
 * @param texts - the submitted texts, in document order.
 * @param previous - the entries of the previous revision.
 * @param retired - ids removed by earlier revisions.
 */
export function allocateStable<T extends { id: string; text: string }>(
    prefix: string,
    texts: readonly string[],
    previous: readonly T[],
    retired: readonly string[],
): T[] {
    const available = new Map<string, string[]>()
    for (const entry of previous) {
        const key = entry.text.trim()
        const ids = available.get(key) ?? []
        ids.push(entry.id)
        available.set(key, ids)
    }
    const live: string[] = []
    const out: T[] = []
    for (const raw of texts) {
        const text = raw.trim()
        const ids = available.get(text)
        const reused = ids?.shift()
        if (reused !== undefined) {
            live.push(reused)
            out.push({ id: reused, text } as T)
            continue
        }
        const fresh = nextFreeId(prefix, [...live, ...previous.map((entry) => entry.id)], retired)
        live.push(fresh)
        out.push({ id: fresh, text } as T)
    }
    return out
}

/** Convenience wrapper for the acceptance criteria (kept for call sites). */
export function allocateCriteriaStable(
    texts: readonly string[],
    previous: readonly AcceptanceCriterion[],
    retired: readonly string[],
): AcceptanceCriterion[] {
    return allocateStable<AcceptanceCriterion>(PREFIX.criterion, texts, previous, retired)
}

/** Convenience wrapper for the requirements list. */
export function allocateRequirements(
    texts: readonly string[],
    previous: readonly Requirement[],
    retired: readonly string[],
): Requirement[] {
    return allocateStable<Requirement>(PREFIX.requirement, texts, previous, retired)
}

/** What a caller asks for. */
export interface AmendRequest {
    /** Which list the edit addresses. */
    part: 'requirement' | 'criterion'
    action: 'add' | 'update' | 'remove'
    /** `R-003` / `AC-002`; omitted for `add`. */
    target?: string
    /** The new text; required for `add` and `update`, ignored for `remove`. */
    text?: string
    /** Free-text reason, recorded in the history. */
    note?: string
    /** Allow removing a criterion that test cases cover (the cases are dropped). */
    cascade?: boolean
}

/** Context the planner needs beyond the document itself. */
export interface AmendContext {
    /** Designed test cases, for the coverage impact. */
    cases: readonly TestCase[]
    /** Who is asking (agent id or `approval`). */
    by: string
    now?: number
}

/** Outcome of {@link planAmendment}. */
export type AmendPlan =
    | { ok: true; spec: SpecRecord; change: SpecChange; removedCases: string[]; summary: string }
    | { ok: false; problem: string; nextSteps?: string; coveredBy?: string[] }

/** Render one list entry for the report. */
function entryOf(part: 'requirement' | 'criterion', id: string, text: string): string {
    return `${id} ${text}`
}

/** Case ids covering a criterion. */
function covering(cases: readonly TestCase[], id: string): string[] {
    return cases.filter((testCase) => testCase.covers.map((entry) => entry.trim().toUpperCase()).includes(id.toUpperCase())).map((testCase) => testCase.id)
}

/** The list a request addresses, with a uniform shape. */
function listOf(spec: SpecRecord, part: 'requirement' | 'criterion'): { id: string; text: string }[] {
    return part === 'requirement' ? spec.requirements : spec.acceptanceCriteria
}

/**
 * Apply one requirement/criterion edit to a specification.
 *
 * Pure: it returns the next revision (approval already revoked by omitting
 * `approvedAt`), the history entry, and — for a cascading removal — the test
 * cases the caller must drop. Refusals carry the reason and the next step.
 * @param spec - the current revision.
 * @param request - what to change.
 * @param context - coverage, actor and clock.
 */
export function planAmendment(spec: SpecRecord, request: AmendRequest, context: AmendContext): AmendPlan {
    const prefix = PREFIX[request.part]
    const retired = [...(spec.retired ?? [])]
    const live = listOf(spec, request.part)
    const text = (request.text ?? '').trim()
    const now = context.now ?? Date.now()
    const target = (request.target ?? '').trim().toUpperCase()

    if (request.action !== 'add' && target === '') {
        return {
            ok: false,
            problem: `${request.action === 'update' ? '修改' : '删除'}必须给出 target（${prefix}-00n）。`,
            nextSteps: `先调用 spec_status 看当前清单与编号，再带上 target 重试。`,
        }
    }
    if (request.action !== 'add') {
        const entry = live.find((candidate) => candidate.id.toUpperCase() === target)
        if (entry === undefined) {
            const isRetired = retired.some((id) => id.toUpperCase() === target)
            return {
                ok: false,
                problem: isRetired
                    ? `${target} 已经被删除过（编号进入 retired，不会复用）：不能对已删除的条目做 ${request.action}。`
                    : `${prefix} 里没有 ${target}。`,
                nextSteps: isRetired
                    ? '需要重新提出这条要求时用 action: "add"（会分配一个新编号），不要复活旧编号。'
                    : '调用 spec_status 查看当前编号后再试。',
            }
        }
        if (request.action === 'update' && text === '') {
            return { ok: false, problem: `修改 ${target} 必须给出新的 text。`, nextSteps: '补上 text 后重试。' }
        }
    }
    if (request.action === 'add' && text === '') {
        return { ok: false, problem: `新增${request.part === 'requirement' ? '需求' : '验收标准'}必须给出 text。`, nextSteps: '补上 text 后重试。' }
    }
    if (request.action === 'add' && live.some((candidate) => candidate.text.trim() === text)) {
        return {
            ok: false,
            problem: `这条内容已经存在（文本完全相同）：不要用重复条目制造"覆盖了"的错觉。`,
            nextSteps: '确需修改请用 action: "update" 指向已有编号。',
        }
    }

    const cases = request.part === 'criterion' ? covering(context.cases, target) : []
    if (request.action === 'remove' && cases.length > 0 && request.cascade !== true) {
        return {
            ok: false,
            problem: `${target} 被 ${cases.length} 个测试用例引用（${cases.join('、')}）：删掉它会让这些用例失去依据。`,
            coveredBy: cases,
            nextSteps:
                '先决定这些用例怎么办：一并删除请用 cascade: true（会同时移除这些用例并记入变更历史）；' +
                '仍然需要该行为则不要删除，改用 update 澄清措辞。',
        }
    }

    let next: Requirement[] | AcceptanceCriterion[]
    let change: SpecChange
    if (request.action === 'add') {
        const id = nextFreeId(prefix, live.map((entry) => entry.id), retired)
        next = [...live, { id, text }]
        change = { kind: `add-${request.part}`, at: now, by: context.by, target: id, after: text, ...(request.note === undefined ? {} : { note: request.note }) }
    } else if (request.action === 'update') {
        const before = live.find((entry) => entry.id.toUpperCase() === target)?.text ?? ''
        next = live.map((entry) => (entry.id.toUpperCase() === target ? { ...entry, text } : entry))
        change = {
            kind: `update-${request.part}`,
            at: now,
            by: context.by,
            target,
            before,
            after: text,
            ...(request.note === undefined ? {} : { note: request.note }),
        }
    } else {
        const before = live.find((entry) => entry.id.toUpperCase() === target)?.text ?? ''
        next = live.filter((entry) => entry.id.toUpperCase() !== target)
        retired.push(target)
        change = {
            kind: `remove-${request.part}`,
            at: now,
            by: context.by,
            target,
            before,
            ...(cases.length === 0 ? {} : { coveredBy: cases }),
            ...(request.note === undefined ? {} : { note: request.note }),
        }
    }

    const nextSpec: SpecRecord = {
        ...spec,
        requirements: request.part === 'requirement' ? (next as Requirement[]) : spec.requirements,
        acceptanceCriteria: request.part === 'criterion' ? (next as AcceptanceCriterion[]) : spec.acceptanceCriteria,
        revision: spec.revision + 1,
        updatedAt: now,
        approvedAt: undefined,
        approvedBy: undefined,
        retired,
        changes: [...(spec.changes ?? []), change],
    }

    const summary =
        request.action === 'add'
            ? `新增 ${change.target}：${text}`
            : request.action === 'update'
              ? `修改 ${target}：${entryOf(request.part, target, change.before ?? '')} → ${text}`
              : `删除 ${target}（原内容：${change.before ?? ''}）${cases.length === 0 ? '' : `，同时移除用例 ${cases.join('、')}`}`

    return {
        ok: true,
        spec: nextSpec,
        change,
        removedCases: request.action === 'remove' ? cases : [],
        summary,
    }
}

/**
 * How a pending edit affects the rest of the mission.
 *
 * Returned to the caller so the "standard process" is spelled out instead of
 * implied: an amendment revokes the approval, so the mission is back at the
 * specification stage.
 * @param spec - the specification AFTER the edit.
 * @param changed - the parts that changed.
 */
export function nextStepsAfter(spec: SpecRecord, changed: readonly string[]): string {
    return [
        `规格已升到 revision ${spec.revision}，之前的审批已**撤销**（人批准的是上一版文档）。`,
        `本次改动：${changed.join('；')}`,
        '',
        '按标准流程继续：',
        '1. 受影响的需求/用例要同步更新（测试设计章节 + test_design_review 重新评审）；',
        '2. `spec_approve` 重新走人工审批（审批弹窗里会列出改动前后的差异）；',
        '3. 审批通过后阶段门禁 spec-approved 才会重新放行（orchestrator 会挡住后面的阶段）。',
    ].join('\n')
}

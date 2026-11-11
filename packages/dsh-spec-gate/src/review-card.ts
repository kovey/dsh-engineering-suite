/**
 * The specification review card: what a human is shown, and nothing else.
 *
 * Why this seam and not the approval one: the approval waterfall carries a single
 * `reason` STRING, so a client can only show one blob. `user-questions` carries
 * structured questions with markdown `detail` and an `intent`, which is what the
 * desktop app and the web TUI render as a real review card.
 *
 * Factored out of `tools.ts` so the card's composition stays readable on its own:
 * the surrounding function owns the decision, this module owns the document the
 * human reads before making it.
 * @module dsh-spec-gate/review-card
 */

import type { MissionStore, MissionRecord } from 'dsh-eng-core'

/**
 * Sanity bound for the review card, NOT a host limit.
 *
 * Verified against the installed host: `user-questions` imposes no length limit —
 * the schema only requires that `plan-review` carries a `detail` and that
 * `intent.approve` names one of the options (`BAD_INTENT` otherwise) — and the
 * client renders `detail` as markdown inside a scrollable card
 * (`max-height: min(60vh,520px)`, `overflow-y:auto`). So the number below is this
 * plugin's own ceiling, chosen far above any real specification (the largest
 * spec in this repository is ~13KB) purely so a pathological payload cannot wedge
 * a client.
 *
 * What it must NEVER do is truncate silently: a reviewer who approves a cut-off
 * document did not review it. When the bound does bite, the card says so, names
 * the omitted size and points at the file.
 */
export const REVIEW_DETAIL_LIMIT = 200_000

/** The option that approves a specification (and the card's `intent.approve`). */
export const APPROVE_LABEL = '通过'

/** One question exactly as the structured-question seam expects it. */
export interface ReviewQuestion {
    id: string
    header: string
    question: string
    detail: string
    options: { label: string; description: string }[]
    intent: { kind: 'plan-review'; detail: string; approve: string }
}

/** Everything one review card needs from the caller. */
export interface ReviewCardInput {
    mission: MissionRecord
    store: MissionStore
    /** Artifacts the reviewer should be able to open before deciding. */
    artifacts: readonly string[]
    round: number
}

/**
 * The document text the card carries (cut loudly, never silently).
 * @param markdown - the full reviewer-facing markdown.
 * @param specPath - where the untruncated document lives.
 */
function detailOf(markdown: string, specPath: string | undefined): string {
    if (markdown.length <= REVIEW_DETAIL_LIMIT) return markdown
    return `${markdown.slice(0, REVIEW_DETAIL_LIMIT)}\n\n> ⚠️ 正文过长（${markdown.length} 字符），上面只显示前 ${REVIEW_DETAIL_LIMIT} 字符。完整内容见 ${specPath ?? '规格文件'}；**在读完之前不要点通过**。`
}

/**
 * Compose the review card for one approval round.
 * @param input - the mission, its store, the artifacts to cite and the round.
 * @returns the single question the card carries.
 */
export function reviewCardOf(input: ReviewCardInput): ReviewQuestion {
    const { mission, store, artifacts, round } = input
    const markdown = [
        store.readSpec(mission.id).trim(),
        '',
        '---',
        '',
        `工件：${artifacts.join('、')}`,
        `核对命令：spec_status ${mission.id}（规格与覆盖度）· audit_report（本次会话的写前快照）`,
    ]
        .join('\n')
        .trim()
    const detail = detailOf(markdown, mission.specPath)
    return {
        id: `spec-review-${mission.id}`,
        header: `规格审批 · 第 ${round} 轮`,
        question: `《${mission.spec?.title ?? mission.title}》第 ${round} 轮送审：${APPROVE_LABEL}还是打回？`,
        detail,
        options: [
            { label: APPROVE_LABEL, description: '按这份规格实现，并签发 mandate（写操作放行）' },
            { label: '打回', description: '规格需要修改；可在下方说明要改什么' },
        ],
        intent: { kind: 'plan-review', detail, approve: APPROVE_LABEL },
    }
}

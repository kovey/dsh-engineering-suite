/**
 * The judgment layer: what a metrics module cannot decide.
 *
 * File and function length are heuristics. "Is this cohesive?", "does the name
 * say what it does?", "is this abstraction earning its keep?" are not, so the
 * gate does not pretend to answer them — it dispatches a READ-ONLY reviewer with
 * a rubric and the concrete worst offenders, and reports what came back as an
 * opinion, never as a verdict.
 *
 * The rules the rest of the suite learned the hard way apply here too:
 *  - the child's tool filter excludes `orchestrate` (a dispatched child that can
 *    re-enter the pipeline recursed into ~800 sessions once) and it gets
 *    `maxDepth: 1`;
 *  - the call is bounded and its failure is reported, never fatal;
 *  - nothing here approves, delivers or writes a gate record: findings are prose.
 *
 * @module dsh-standards-gate/review
 */

import path from 'node:path'
import { ensureDir, writeTextAtomic, type FileMetrics, type MetricsResult } from 'dsh-eng-core'

/** Minimal structural view of `ctx.subagents` (same shape the suite uses). */
export interface SubagentsLike {
    start: (
        provider: string,
        request: {
            label?: string
            prompt: { type: 'text'; text: string }[]
            parent: never
            signal: AbortSignal
            toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
            persona?: string
            maxDepth?: number
        },
    ) => Promise<{
        id: string
        result: Promise<{ stopReason?: string; output?: { type?: string; text?: string }[]; diagnostic?: string }>
        dispose?: () => Promise<void>
    }>
}

/** The reviewer's brief: questions a machine cannot answer, asked concretely. */
export const REVIEW_RUBRIC = [
    '## 你要回答的问题（逐条给结论，不要泛泛而谈）',
    '',
    '1. **职责是否单一**：这个文件/函数混了几件事？如果拆，沿哪条缝拆最省事？',
    '2. **命名是否达意**：名字说的是"做什么"还是"怎么做"？有没有名不符实的参数/返回值？',
    '3. **抽象是否多余**：有没有只被调用一次、却要求读者跳三层的间接层？有没有该抽而没抽的重复？',
    '4. **错误路径是否完整**：失败、超时、取消、部分成功后重试——这些分支存在吗？会不会静默吞掉错误？',
    '5. **局部可读性**：不理解全局的人，能否只看这个文件就明白它在干什么？注释解释的是"为什么"还是复述代码？',
    '6. **拆分收益**：给具体建议（拆成哪几个文件/函数、边界在哪），并说明为什么拆分后更好，而不是"行数超标所以拆"。',
    '',
    '## 纪律',
    '',
    '- **只读**：你没有写工具，也不要试图用别的方式改文件；你的产出是判断，不是补丁。',
    '- **每条结论要可复核**：给出 `文件:行号` 或函数名，让另一个人能按你的说法自己看一眼就认同或反驳。',
    '- **区分事实与方法**：行数/嵌套这类数字由门禁给出，你负责给出数字解释不了的部分。',
    '- **允许结论是"没问题"**：不要为了显得有产出而编造问题；可以明确说"这个文件虽然长，但内聚良好，不建议拆"。',
    '- 结论会被当作**意见**呈现给人，不会被当作门禁裁决。',
].join('\n')

/** Pick the files a human should look at, most suspicious first. */
export function selectReviewTargets(result: MetricsResult, limit: number): FileMetrics[] {
    const score = (file: FileMetrics): number => {
        const longest = Math.max(0, ...file.functions.map((fn) => fn.lines))
        const flattened = Math.max(0, ...file.functions.map((fn) => fn.depth))
        return file.lines + longest * 2 + file.maxDepth * 10 + flattened * 10 + file.exports * 2
    }
    return [...result.files]
        .filter((file) => file.functions.length > 0 || file.lines > 50)
        .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path))
        .slice(0, Math.max(1, limit))
}

/** Render the reviewer's brief: the rubric plus the concrete files to read. */
export function reviewPrompt(input: { cwd: string; targets: readonly FileMetrics[]; focus?: string }): string {
    const lines = [
        '你是一次**结构评审**的审查者。下面这几个文件是度量给出的"最可疑"清单——',
        '数字只说明它们值得看一眼，不说明它们有问题。请真正读懂它们再下结论。',
        '',
        `工作区：${input.cwd}`,
        '',
        '## 要评审的文件',
        '',
    ]
    for (const file of input.targets) {
        const longest = file.functions.reduce((best, fn) => (fn.lines > best.lines ? fn : best), { name: '-', line: 0, lines: 0, depth: 0, params: 0 })
        lines.push(
            `- \`${file.path}\`：${file.lines} 行，导出 ${file.exports} 个，最大嵌套 ${file.maxDepth}；最长函数 \`${longest.name}\`（${longest.lines} 行，嵌套 ${longest.depth}，参数 ${longest.params}）`,
        )
    }
    lines.push('', REVIEW_RUBRIC)
    if (input.focus !== undefined && input.focus.trim() !== '') {
        lines.push('', `## 本次额外关注`, '', input.focus.trim())
    }
    lines.push(
        '',
        '## 汇报格式',
        '',
        '- 逐个文件：`## <path>` → `结论：没问题 / 建议拆分 / 建议改名 / 需要补错误路径` → 理由（带行号）→ 具体建议；',
        '- 最后一段「总体判断」：这批文件里最值得动手的是哪一个，为什么。',
    )
    return lines.join('\n')
}

/** Bound one child run so a stuck reviewer cannot wedge the tool call. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), Math.max(1_000, timeoutMs))
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** What one review run produced. */
export interface ReviewOutcome {
    ok: boolean
    runId?: string
    outputFile?: string
    stopReason?: string
    /** The child's findings, as prose. */
    report: string
    /** Why there is no report (no subagents, refusal, timeout, empty answer). */
    problem?: string
}

/**
 * Dispatch the read-only reviewer.
 *
 * @param deps - the subagent seam, a workspace-relative directory for the report,
 *   the provider and the deadline.
 * @param input - the workspace, the files to review and the caller's signal.
 * @returns the findings, or the reason there are none. Never throws.
 */
export async function runStructuralReview(
    deps: {
        subagents: () => SubagentsLike | undefined
        /** Where the report is written (absolute). */
        reportDir: string
        provider: string
        timeoutMs: number
        maxDepth: number
        logger?: { warn: (message: string, error?: unknown) => void }
    },
    input: { cwd: string; targets: readonly FileMetrics[]; agent?: unknown; signal?: AbortSignal; focus?: string },
): Promise<ReviewOutcome> {
    const subagents = deps.subagents()
    if (subagents === undefined) {
        return {
            ok: false,
            report: '',
            problem:
                '宿主没有装配子代理服务（ctx.subagents）：结构评审需要一个只读子代理来读代码。' +
                '下一步：装配 subagents provider，或让当前 agent 自己按 rubric 评审（见 standards_status 的 rubric 摘要）。',
        }
    }
    if (input.signal?.aborted === true) {
        return { ok: false, report: '', problem: '调用方已取消（signal 已 abort）：未派发评审。' }
    }
    let child: Awaited<ReturnType<SubagentsLike['start']>>
    try {
        child = await subagents.start(deps.provider, {
            label: `结构评审 · ${path.basename(input.cwd)}`,
            prompt: [{ type: 'text', text: reviewPrompt({ cwd: input.cwd, targets: input.targets, ...(input.focus === undefined ? {} : { focus: input.focus }) }) }],
            parent: input.agent as never,
            signal: input.signal ?? new AbortController().signal,
            // Read-only, and the pipeline entry point is removed: a reviewer that
            // can call `orchestrate` can re-enter the stage (that recursion once
            // produced ~800 sessions), and a reviewer has no business advancing
            // anything anyway.
            toolFilter: { allow: ['read', 'glob', 'grep'], deny: ['orchestrate'] },
            maxDepth: Math.max(1, deps.maxDepth),
            persona: [
                '你是结构评审者：只读，只判断，不改代码。',
                '给可复核的结论（文件:行号），区分"事实"（门禁给的数字）与"方法"（你的判断）。',
                '允许结论是"没问题"——不要为了产出而编造问题。',
            ].join('\n'),
        })
    } catch (error) {
        return { ok: false, report: '', problem: `派发评审子代理失败（provider ${deps.provider}）：${(error as Error).message}` }
    }

    let report = ''
    let stopReason = 'unknown'
    let problem: string | undefined
    try {
        const settled = await withDeadline(child.result, deps.timeoutMs, '结构评审子代理')
        stopReason = typeof settled.stopReason === 'string' ? settled.stopReason : 'unknown'
        report = (settled.output ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('\n')
            .trim()
        if (report === '') {
            problem = `评审子代理没有返回文本${typeof settled.diagnostic === 'string' ? `（${settled.diagnostic}）` : ''}`
        }
    } catch (error) {
        problem = (error as Error).message
    } finally {
        try {
            await child.dispose?.()
        } catch {
            // disposal must never mask the review result
        }
    }

    let outputFile: string | undefined
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        // The run id comes from the provider, so it is NOT a filename: an
        // adversarial audit had a hostile id write `/tmp/…/ESCAPED.md` outside
        // the mission directory. Keep one path segment, drop everything else.
        const safeId = String(child.id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80)
        const file = path.join(deps.reportDir, `review-${stamp}-${safeId}.md`)
        ensureDir(deps.reportDir)
        writeTextAtomic(
            file,
            [
                `# 结构评审（只读子代理 ${child.id}）`,
                '',
                `- 工作区：${input.cwd}`,
                `- 评审文件：${input.targets.map((target) => target.path).join('、')}`,
                `- stopReason：${stopReason}`,
                '',
                '> 这是**意见**，不是门禁裁决：它不改变任何门禁状态，也不构成交付依据。',
                '',
                report === '' ? '(空)' : report,
                '',
            ].join('\n'),
        )
        outputFile = file
    } catch (error) {
        deps.logger?.warn('结构评审报告写入失败：', error)
    }
    return { ok: problem === undefined, report, stopReason, ...(outputFile === undefined ? {} : { outputFile }), ...(problem === undefined ? {} : { problem }) }
}

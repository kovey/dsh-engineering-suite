/**
 * The opt-in opinion layer: what the import graph cannot see.
 *
 * `analyzeImpact` answers with facts (a diff, a reverse-import closure, three
 * kinds of test evidence). What it structurally CANNOT answer is whether the
 * change is also referenced through an interface, a DI container, a reflection
 * lookup, a string-keyed registry, a template or a config key — none of those
 * produce an import edge.
 *
 * When the host turns `reviewDispatch` on, this module dispatches a READ-ONLY
 * reviewer over the riskiest files and asks exactly those questions. The rules
 * the rest of the suite learned the hard way apply here too:
 *
 *  - the child's tool filter excludes `orchestrate` (a dispatched child that can
 *    re-enter the pipeline recursed into ~800 sessions once) and it gets
 *    `maxDepth: 1`;
 *  - the call is bounded and its failure is reported, never fatal — a reviewer
 *    timeout must not lose the analysis the tool already computed;
 *  - nothing here changes the risk level or writes a gate record: findings are
 *    prose, and the report says so.
 *
 * @module dsh-impact-gate/review
 */

import path from 'node:path'
import { ensureDir, writeTextAtomic, type ImpactReport } from 'dsh-eng-core'

/** Minimal structural view of `ctx.subagents` (the shape the suite uses). */
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
            agentOptions?: { provider?: string; model?: string }
        },
    ) => Promise<{
        id: string
        result: Promise<{ stopReason?: string; output?: { type?: string; text?: string }[]; diagnostic?: string }>
        dispose?: () => Promise<void>
    }>
}

/** The reviewer's brief: the questions a reverse-import walk cannot answer. */
export const IMPACT_REVIEW_RUBRIC = [
    '## 你要回答的问题（逐条给结论，必须带 `文件:行号`）',
    '',
    '1. **这次改动改掉了什么行为？**（先读懂改动文件本身，再谈影响面）',
    '2. **有没有 import 图看不见的引用方？** 具体找：接口/多态派发、依赖注入与容器注册、反射与装饰器、',
    '   字符串查表（路由/事件名/配置键/迁移名）、模板与静态资源、跨进程边界（HTTP/队列/DB schema）。',
    '   找到就给出位置与"为什么它会被影响"；找不到就明确说没找到。',
    '3. **有没有该一起改但没改的东西？** 测试、文档、示例、生成代码、迁移、默认配置。',
    '4. **有没有静默失效的风险？** 改名/删除后按名字查找的调用不会报编译错误，只会什么都不做。',
    '',
    '## 纪律',
    '',
    '- **只读**：你没有写工具，产出是判断，不是补丁。',
    '- **可复核**：每条结论给 `文件:行号` 或符号名，让另一个人按你的说法看一眼就能认同或反驳。',
    '- **区分事实与方法**：改动集、影响面、风险等级由确定性分析给出（见下面的输入），你只补它看不见的部分。',
    '- **允许结论是"没有发现图外耦合"**：不要为了显得有产出而编造问题。',
    '- 结论会被当作**意见**呈现，不改变风险等级，也不构成交付依据。',
].join('\n')

/**
 * Pick the files a human should read, riskiest first.
 *
 * The changed files come first (they ARE the change), then the impacted files by
 * distance. Deterministic: distance, then path.
 * @param report - the analysis.
 * @param limit - how many files to hand the reviewer.
 * @returns workspace-relative paths, in review order.
 */
export function selectReviewTargets(report: ImpactReport, limit: number): string[] {
    const changed = report.changed.map((file) => file.path)
    const rest = report.impacted.map((file) => file.path).filter((entry) => !changed.includes(entry))
    return [...changed, ...rest].slice(0, Math.max(1, limit))
}

/** Render the reviewer's brief: the rubric plus the concrete inputs. */
export function reviewPrompt(input: {
    cwd: string
    base: string
    report: ImpactReport
    targets: readonly string[]
    focus?: string
}): string {
    const lines = [
        '你是一次**变更影响复核**的审查者。下面是确定性分析已经给出的事实——',
        '它按语法提取 import 关系，得到文件级可达性；它看不见的部分正是你要回答的。',
        '',
        `工作区：${input.cwd}`,
        `变更基线：${input.base}`,
        '',
        '## 已确定的事实（不要重复推导，也不要否定）',
        '',
        `- 改动文件：${input.report.changed.map((file) => `\`${file.path}\``).join('、') || '（无）'}`,
        `- 影响面（导入反向可达）：${input.report.impacted.length} 个文件`,
        `- 已选中的测试：${input.report.tests.map((test) => `\`${test.path}\``).join('、') || '（无）'}`,
        `- 风险等级（阈值判定）：${input.report.risk}`,
        ...input.report.reasons.map((reason) => `  - ${reason}`),
        '',
        '## 优先阅读的文件',
        '',
        ...input.targets.map((target) => `- \`${target}\``),
    ]
    if (input.focus !== undefined && input.focus.trim() !== '') {
        lines.push('', '## 本次额外关注', '', input.focus.trim())
    }
    lines.push(
        '',
        IMPACT_REVIEW_RUBRIC,
        '',
        '## 汇报格式',
        '',
        '- `## 图外引用` → 逐条：`文件:行号`、引用方式、为什么会被这次改动影响、要不要一起改；没有就写「没有发现」。',
        '- `## 需要一起改的东西` → 测试/文档/配置/迁移，逐条给路径。',
        '- `## 总体判断` → 这次改动最容易被忽略的一处是什么（或明确说没有）。',
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
 * @param deps - the subagent seam, the report directory, provider/deadline knobs.
 * @param input - the workspace, the analysis and the caller's signal.
 * @returns the findings, or the reason there are none. Never throws.
 */
export async function runImpactReview(
    deps: {
        subagents: () => SubagentsLike | undefined
        /** Where the report is written (absolute). */
        reportDir: string
        provider: string
        model?: string
        timeoutMs: number
        maxDepth: number
        logger?: { warn: (message: string, error?: unknown) => void }
    },
    input: {
        cwd: string
        base: string
        report: ImpactReport
        targets: readonly string[]
        agent?: unknown
        signal?: AbortSignal
        focus?: string
    },
): Promise<ReviewOutcome> {
    const subagents = deps.subagents()
    if (subagents === undefined) {
        return {
            ok: false,
            report: '',
            problem:
                '宿主没有装配子代理服务（ctx.subagents）：reviewDispatch 需要一个只读子代理来读代码。' +
                '下一步：装配 subagents provider，或把 reviewDispatch.enabled 设为 false（影响分析本身不依赖它）。',
        }
    }
    if (input.signal?.aborted === true) {
        return { ok: false, report: '', problem: '调用方已取消（signal 已 abort）：未派发复核。' }
    }
    let child: Awaited<ReturnType<SubagentsLike['start']>>
    try {
        child = await subagents.start(deps.provider, {
            label: `变更影响复核 · ${path.basename(input.cwd)}`,
            prompt: [
                {
                    type: 'text',
                    text: reviewPrompt({
                        cwd: input.cwd,
                        base: input.base,
                        report: input.report,
                        targets: input.targets,
                        ...(input.focus === undefined ? {} : { focus: input.focus }),
                    }),
                },
            ],
            parent: input.agent as never,
            signal: input.signal ?? new AbortController().signal,
            // Read-only, and the pipeline entry point is removed: a reviewer that
            // can call `orchestrate` can re-enter the stage, and a reviewer has no
            // business advancing anything anyway.
            toolFilter: { allow: ['read', 'glob', 'grep'], deny: ['orchestrate'] },
            maxDepth: Math.max(1, deps.maxDepth),
            ...(deps.model === undefined ? {} : { agentOptions: { model: deps.model } }),
            persona: [
                '你是变更影响复核者：只读，只判断，不改代码。',
                '给可复核的结论（文件:行号），区分"事实"（确定性分析给的改动集/影响面）与"方法"（你的判断）。',
                '允许结论是"没有发现图外耦合"——不要为了产出而编造问题。',
            ].join('\n'),
        })
    } catch (error) {
        return { ok: false, report: '', problem: `派发复核子代理失败（provider ${deps.provider}）：${(error as Error).message}` }
    }

    let report = ''
    let stopReason = 'unknown'
    let problem: string | undefined
    try {
        const settled = await withDeadline(child.result, deps.timeoutMs, '变更影响复核子代理')
        stopReason = typeof settled.stopReason === 'string' ? settled.stopReason : 'unknown'
        report = (settled.output ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('\n')
            .trim()
        if (report === '') {
            problem = `复核子代理没有返回文本${typeof settled.diagnostic === 'string' ? `（${settled.diagnostic}）` : ''}`
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
        // The run id comes from the provider, so it is NOT a filename: keep one
        // path segment (a hostile id once wrote outside the mission directory).
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const safeId = String(child.id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80)
        const file = path.join(deps.reportDir, `review-${stamp}-${safeId}.md`)
        ensureDir(deps.reportDir)
        writeTextAtomic(
            file,
            [
                `# 变更影响复核（只读子代理 ${child.id}）`,
                '',
                `- 工作区：${input.cwd}`,
                `- 变更基线：${input.base}`,
                `- 复核文件：${input.targets.map((target) => `\`${target}\``).join('、') || '（无）'}`,
                `- 确定性结论：风险 ${input.report.risk}；改动 ${input.report.changed.length}、影响面 ${input.report.impacted.length}、测试 ${input.report.tests.length}`,
                `- 停止原因：${stopReason}`,
                '',
                '⚠️ 这是**意见**，不是门禁裁决：它不改变风险等级，也不构成交付依据。',
                '',
                report === '' ? `（没有产出报告：${problem ?? '未知原因'}）` : report,
                '',
            ].join('\n'),
        )
        outputFile = file
    } catch (error) {
        deps.logger?.warn('影响复核报告落盘失败:', error)
    }

    if (problem !== undefined) return { ok: false, runId: child.id, stopReason, report, problem, ...(outputFile === undefined ? {} : { outputFile }) }
    return { ok: true, runId: child.id, stopReason, report, ...(outputFile === undefined ? {} : { outputFile }) }
}

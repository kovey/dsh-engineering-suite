/**
 * How ONE worker is started: role, model, worktree, prompt, deadline.
 *
 * Split out of `split-runner.ts` so "who the worker is" and "in what order the
 * tasks run" can be read (and reviewed) separately — the runner decides the
 * schedule, this module decides the child.
 *
 * Three properties are not negotiable here:
 *
 *  - **The child starts inside its worktree** (`cwd` on the activation request):
 *    a worker whose cwd is the main tree would write its local `.dsh/` evidence
 *    into the main mission's ledger, which is exactly the pollution AC-007
 *    forbids;
 *  - **The role decides the tools** (`worker`: read/write/edit/bash/glob/grep/
 *    todo_write, no gate tools) and `orchestrate` is stripped structurally — the
 *    same anti-recursion guard the stage dispatcher uses, because a worker that
 *    can call `orchestrate` re-enters the pipeline and spawns grandchildren;
 *  - **The model is an override from `models.json`, not a requirement** (P4): the
 *    `worker` class normally, the `planner` class once the rework ratio is above
 *    `quality.maxReworkRatio` (AC-011). A class with no `model` means "host
 *    default" — `agentOptionsOf` omits `model`/`provider` and the task still runs;
 *    the route's `note` says so and is not a failure.
 *
 * @module dsh-orchestrator/split-worker
 */

import { planDelegation, startDelegation, type AgentLike, type DelegationFilter, type DelegationPlan } from 'dsh-eng-core'
import { computeRework, routeForNextTask, type NextTaskRoute, type SplitTask } from 'dsh-eng-core/split'
import { dispatchPresetInput, withoutOrchestrate } from './presets.js'
import type { SplitRolePlan, SplitRunBook, SplitRunnerDeps } from './split-run-types.js'

/** Who is delegating, for the delegation seam's refusal texts. */
const WORKER_OWNER = { plugin: 'dsh-orchestrator', subject: '子任务 worker' }

/** Why one worker did not finish (AC-003 needs the timeout to be nameable). */
export interface WorkerFailure {
    detail: string
    /** `true` only when the configured `taskTimeoutMs` stopped the worker. */
    timeout?: true
}

/** The resolved delegation of one run (registered preset included). */
export interface WorkerDispatch {
    plan: Exclude<DelegationPlan, { kind: 'refused' }>
    persona?: string
    filter: DelegationFilter
}

/** Everything one `startWorker` call needs about the task it starts. */
export interface WorkerStart {
    task: SplitTask
    dispatch: WorkerDispatch
    worktree: string
    route: NextTaskRoute
}

/**
 * The deadline error, distinguishable from the worker's OWN rejection.
 *
 * A plain message would have to be pattern-matched later, and a worker that
 * failed with the word "超时" in its diagnostic would then be recorded as a
 * `timeout` rework signal (a wrong signal understates a real failure).
 */
class DeadlineError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DeadlineError'
    }
}

/**
 * A deadline for one worker (a stuck child must not wedge the tool call).
 *
 * The configured value is honoured AS GIVEN (minimum 1ms): the deadline is a
 * deployment decision, and silently raising a 1ms test configuration to 1s
 * would make "the timeout works" unprovable. `0`/absent means "no deadline" and
 * never reaches this function.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new DeadlineError(`${label} 超时（${timeoutMs}ms）`)), Math.max(1, timeoutMs))
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** The worker's instructions: the task, its paths, its commit rule, its limits. */
function workerPrompt(book: SplitRunBook, task: SplitTask, worktree: string): string {
    return [
        `你是子任务 ${task.id} 的 worker（mission ${book.missionId}）。`,
        '',
        '## 你的工作目录',
        `- worktree：${worktree}`,
        '- 只在这个目录里写文件；主树的文件不属于你。',
        '- 本地 evidence / audit 写在 worktree 内的 .dsh/ 下（相对 worktree 解析）。',
        '',
        '## 这个子任务',
        `- 目标：${task.goal}`,
        `- 你独占的路径：${(task.paths ?? []).join('、') || '(未声明)'}`,
        `- 要满足的验收标准：${(task.acceptance ?? []).join('、') || '(未声明)'}`,
        `- 已完成的依赖：${(task.dependsOn ?? []).join('、') || '(无)'}`,
        '',
        '## 规则',
        '1. 只改上面 paths 覆盖的文件；需要越界就停下来说明，不要偷偷改别的子任务的路径。',
        '2. **禁止**写 mission.json、主树的门禁记录（gates/）与回执（receipts/）：这些工具不在你的白名单里。',
        `3. **完成修改后必须提交**：在 worktree 里执行 \`git add -A && git commit -m "${task.id}: <摘要>"\`（例如 ${task.id}: ${task.goal}）。` +
            `**不提交视为未完成**：runner 只认你在 ${task.id} 分支上产生的提交，不会替你证明做过事；` +
            '它只会在你留下未提交改动时代提交一次并在 run.json 记 autocommit=true（那是兜底记录，不是你的产出）。',
        '4. 你在 worktree 里跑的门禁只有部分 scope，**永不构成交付依据**；合并后的主树会完整重跑一次。',
        '5. 结束时用简短条目汇报：改了什么、命令与输出、没覆盖到的风险。',
    ].join('\n')
}

/** The role plan + delegation decision, once per run (a refusal stops everything). */
export async function prepareDispatch(book: SplitRunBook, deps: SplitRunnerDeps): Promise<{ dispatch?: WorkerDispatch; refusal?: string }> {
    if (deps.subagents === undefined) {
        return { refusal: '宿主没有装配子代理服务（ctx.subagents）：拆分计划无法派发 worker（fail closed，不降级成"自己写完"）' }
    }
    if (deps.agent === undefined) return { refusal: '调用方 agent 未知：无法派发子代理' }
    const guard = deps.roleGuard?.()
    if (guard === undefined) {
        return { refusal: 'dsh-role-guard 没有提供 service：worker 的 persona 与工具白名单无法落实（worker 会拿到门禁工具），拒绝派发' }
    }
    let rolePlan: SplitRolePlan
    try {
        rolePlan = guard.plan({ role: 'worker', cwd: book.mainTree, agent: deps.agent })
    } catch (error) {
        return { refusal: `worker 角色无法解析（${(error as Error).message}）：拒绝派发` }
    }
    const filter = withoutOrchestrate(rolePlan.toolFilter)
    if (filter.allow !== undefined && filter.allow.length === 0) {
        return { refusal: 'worker 角色的工具白名单在剔除 orchestrate 后为空（等于"不给任何工具"）：拒绝派发' }
    }
    const decision = await planDelegation({
        owner: WORKER_OWNER,
        provider: deps.provider,
        subagents: deps.subagents,
        ...(deps.presets === undefined ? {} : { presets: deps.presets }),
        preset: dispatchPresetInput({ role: 'worker', persona: rolePlan.persona, filter }),
    })
    if (decision.kind === 'refused') return { refusal: decision.reason }
    return { dispatch: { plan: decision, persona: rolePlan.persona === '' ? undefined : rolePlan.persona, filter } }
}

/** The model the NEXT worker runs on (planner once the rework ratio is exceeded, else the fallback). */
export function routeFor(book: SplitRunBook): NextTaskRoute {
    const started = book.tasks.filter((record) => record.attempts > 0).map((record) => ({ id: record.id, started: true, signals: [...record.signals] }))
    const report = computeRework({ tasks: started, threshold: book.models.quality.maxReworkRatio })
    return routeForNextTask(report, book.models)
}

/** Bind the child's role, so its skill whitelist is enforced (a failure is reported). */
function bindWorker(deps: SplitRunnerDeps, book: SplitRunBook, sessionId: string): void {
    const guard = deps.roleGuard?.()
    if (guard?.bind === undefined) {
        book.warnings.push(`⚠️ role-guard 没有 bind 能力：子会话 ${sessionId} 没有技能白名单约束`)
        return
    }
    try {
        const binding = guard.bind({ role: 'worker', sessionId, cwd: book.mainTree, ...(deps.agent === undefined ? {} : { agent: deps.agent }) })
        if (binding === undefined) book.warnings.push(`⚠️ 角色绑定未写入：子会话 ${sessionId} 没有技能白名单约束`)
    } catch (error) {
        book.warnings.push(`⚠️ 角色绑定失败（${(error as Error).message}）：子会话 ${sessionId} 没有技能白名单约束`)
    }
}

/** What the activation is started with (the `models.json` route, not the role's). */
function agentOptionsOf(route: NextTaskRoute): { provider?: string; model?: string; reasoningEffort?: string } {
    return {
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        ...(route.model === undefined ? {} : { model: route.model }),
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
}

/** One started child, or why it could not be started. */
interface StartedChild {
    child?: Awaited<ReturnType<typeof startDelegation>>
    error?: string
}

/** Start the activation (a failure is returned, never thrown). */
async function startChild(book: SplitRunBook, deps: SplitRunnerDeps, start: WorkerStart, worktree: string): Promise<StartedChild> {
    const { task, dispatch, route } = start
    if (deps.subagents === undefined || deps.agent === undefined) return { error: '子代理服务或调用方 agent 不存在' }
    // Built before the request: a conditional spread inside the argument object is
    // one more nesting level than the structural limit allows, and this value is
    // the only part of the request that varies that way.
    const legacy = dispatch.persona === undefined ? { filter: dispatch.filter } : { persona: dispatch.persona, filter: dispatch.filter }
    try {
        const child = await startDelegation(deps.subagents, {
            owner: WORKER_OWNER,
            provider: deps.provider,
            plan: dispatch.plan,
            label: `split ${book.missionId} · ${task.id}`,
            prompt: workerPrompt(book, task, worktree),
            parent: deps.agent as AgentLike,
            signal: deps.signal ?? new AbortController().signal,
            agentOptions: agentOptionsOf(route),
            cwd: worktree,
            maxDepth: deps.maxDepth ?? 1,
            legacy,
            detail: `子任务 ${task.id} 的工具白名单：${dispatch.filter.allow?.join('/') ?? '(仅 deny)'}`,
        })
        return { child }
    } catch (error) {
        return { error: `派发失败：${(error as Error).message}` }
    }
}

/** Wait for the child (bounded when a deadline is configured) and read its stop reason. */
async function settleChild(book: SplitRunBook, deps: SplitRunnerDeps, task: SplitTask, child: NonNullable<StartedChild['child']>): Promise<WorkerFailure | undefined> {
    try {
        const bounded = deps.taskTimeoutMs !== undefined && deps.taskTimeoutMs > 0
        const settled = bounded ? await withDeadline(child.result, deps.taskTimeoutMs ?? 0, `子任务 ${task.id} 的 worker`) : await child.result
        const stopReason = typeof settled.stopReason === 'string' ? settled.stopReason : 'unknown'
        if (stopReason === 'error' || stopReason === 'cancelled' || stopReason === 'aborted') {
            return { detail: `worker 结束于 ${stopReason}${typeof settled.diagnostic === 'string' ? `（${settled.diagnostic}）` : ''}` }
        }
        book.log(`子任务 ${task.id} 的 worker 返回（stopReason=${stopReason}，run ${child.id}）`)
        return undefined
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // AC-003: only the DEADLINE is a timeout. The worker's own failure is a
        // different rework signal even when its text happens to contain "超时".
        return error instanceof DeadlineError ? { detail: `worker 未完成：${message}`, timeout: true } : { detail: `worker 未完成：${message}` }
    }
}

/** Release the activation; a teardown failure must never mask the outcome. */
async function disposeChild(child: NonNullable<StartedChild['child']>): Promise<void> {
    try {
        await child.dispose()
    } catch {
        // reported by the outcome, not by a teardown exception
    }
}

/**
 * Start one worker inside its worktree and wait for it.
 * @param book - the run state (warnings are appended here).
 * @param deps - the seams and the caller's agent/signal.
 * @param start - the task, its delegation, its worktree and the model route.
 * @returns `undefined` on success, else the failure (never throws).
 */
export async function startWorker(book: SplitRunBook, deps: SplitRunnerDeps, start: WorkerStart): Promise<WorkerFailure | undefined> {
    const started = await startChild(book, deps, start, start.worktree)
    if (started.child === undefined) return { detail: started.error ?? '派发失败' }
    bindWorker(deps, book, started.child.id)
    const failure = await settleChild(book, deps, start.task, started.child)
    await disposeChild(started.child)
    return failure
}

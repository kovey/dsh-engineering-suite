/**
 * The stage pipeline: what a stage needs, where it goes on success, and where
 * it falls back to when its gate fails (docs.md §4).
 *
 * A pipeline is a pure value: resolution and validation are deterministic, and
 * an invalid user configuration never reaches the runtime — it is rejected here
 * so the caller can log a warning and keep the default pipeline.
 *
 * @module dsh-orchestrator/pipeline
 */

/** One deterministic entry/exit condition, named by the fact it asserts. */
export type GateKind = 'spec-approved' | 'test-design' | 'quality-pass' | 'receipt' | 'none'

/** A gate as a user writes it in config: a known kind, or an explicit spec. */
export type GateInput =
    | GateKind
    | { kind?: GateKind; phase?: 'entry' | 'exit'; label?: string }

/** The two deterministic transition rules the orchestrator knows. */
export type VerdictPolicy = 'pass-only' | 'pass-or-warn'

/** A resolved entry/exit condition of one stage. */
export interface GateSpec {
    kind: GateKind
    /** `entry` refuses to enter the stage; `exit` refuses to leave it. */
    phase: 'entry' | 'exit'
    /** Human label used in refusals and in the status table. */
    label: string
    /**
     * Which recorded verdict lets the transition through. Exit gates are
     * `pass-only` (quality/evidence gates are the whole point of the stage);
     * entry gates accept `WARN` as well, so a warning can never deadlock entry.
     */
    verdict: VerdictPolicy
}

/** One resolved pipeline stage. */
export interface StageConfig {
    id: string
    /** What the agent must do in this stage (Chinese, injected into the prompt). */
    prompt: string
    /** Plugins that must be mounted before this stage may be entered. */
    requiredPlugins: string[]
    /** Deterministic condition checked on the way in or on the way out. */
    gate: GateSpec
    /** Stage to roll back to when the gate fails. */
    onFail?: string
    /**
     * Iteration circuit breaker: attempts beyond this block the mission.
     * Omitted by {@link DEFAULT_STAGES} on purpose — the engine reads
     * `config.defaultMaxAttempts` in that case, so a profile can move the
     * budget for the built-in pipeline too.
     */
    maxAttempts?: number
    /** Stage to move to when the stage passes. */
    next?: string
    /**
     * The agent role this stage is worked in (docs.md §4.3: 在进入「实现」阶段前
     * 激活 developer 角色).
     *
     * **Declaration, not enforcement.** The orchestrator only records the role
     * (mission + stage artifact) and advertises it in the stage prompt: the
     * whitelist a role actually grants is enforced by `dsh-role-guard`, which
     * owns `roles/*.md` and the `team_delegate` tool. Only roles that exist as
     * built-in files in `packages/dsh-role-guard/roles/` (`developer`,
     * `reviewer`, `qa`) are set on {@link DEFAULT_STAGES}.
     */
    role?: string
    /**
     * Opt-in automatic transition (docs.md §4.2: 自动触发下一阶段).
     *
     * `true` means: when this stage's gate is gated *and* currently passes, the
     * orchestrator settles the stage and enters the next one at the end of the
     * turn instead of waiting for `orchestrate({ action: "advance" })`. Default
     * `false` — the transition stays model-driven unless the host declares
     * otherwise, and a system-driven advance is never inferred from the gate.
     */
    autoAdvance?: boolean
}

/** A whole resolved pipeline. */
export type Pipeline = StageConfig[]

/** The verdict the transition policy maps onto a stage result. */
export type Verdict = 'PASS' | 'WARN' | 'BLOCK'

const GATE_KINDS: readonly GateKind[] = ['spec-approved', 'test-design', 'quality-pass', 'receipt', 'none']

const DEFAULT_GATE_LABEL: Record<GateKind, string> = {
    'spec-approved': '规格已审批（mission.spec.approvedAt）',
    'test-design': '测试设计已登记（mission.testDesign）',
    'quality-pass': '质量门禁 PASS 且晚于本阶段进入时间（store.lastGate）',
    receipt: '已签发交付回执（store.readReceipts）',
    none: '无门禁',
}

/**
 * The default pipeline — docs.md §5, ids are a contract.
 *
 * `gate.phase` is the only thing that varies: the stages whose deterministic
 * fact *is* the transition (quality verification, delivery) check on the way
 * out, every other gated stage checks on the way in.
 *
 * `role` is set only where the stage's work is a role's work and that role
 * ships as a built-in file in `packages/dsh-role-guard/roles/` (developer,
 * reviewer, qa): `implement → developer`. The other stages deliberately carry
 * no role — inventing `qa`/`evidence` from a stage id would advertise a role
 * that does not exist, and a role the workspace cannot load is worse than no
 * role at all. `autoAdvance` is left off everywhere: the built-in pipeline
 * keeps today's model-driven transitions unless a profile opts in.
 */
export const DEFAULT_STAGES: readonly StageConfig[] = [
    {
        id: 'spec-clarify',
        prompt: '澄清需求，产出规格草稿',
        requiredPlugins: ['dsh-spec-gate'],
        gate: { kind: 'none', phase: 'entry', label: DEFAULT_GATE_LABEL.none, verdict: 'pass-or-warn' },
        next: 'test-design-review',
    },
    {
        id: 'test-design-review',
        prompt: '评审测试设计，确保覆盖度与可执行性',
        requiredPlugins: ['dsh-test-design-gate'],
        gate: { kind: 'test-design', phase: 'entry', label: DEFAULT_GATE_LABEL['test-design'], verdict: 'pass-or-warn' },
        onFail: 'spec-clarify',
        next: 'spec-approve',
    },
    {
        id: 'spec-approve',
        prompt: '审批规格（人工审批门禁）',
        requiredPlugins: ['dsh-spec-gate'],
        gate: { kind: 'spec-approved', phase: 'entry', label: DEFAULT_GATE_LABEL['spec-approved'], verdict: 'pass-or-warn' },
        onFail: 'test-design-review',
        next: 'implement',
    },
    {
        id: 'implement',
        prompt: '按规格实现代码',
        requiredPlugins: ['dsh-role-guard'],
        gate: { kind: 'none', phase: 'entry', label: DEFAULT_GATE_LABEL.none, verdict: 'pass-or-warn' },
        role: 'developer',
        onFail: 'spec-approve',
        next: 'quality-verify',
    },
    {
        id: 'quality-verify',
        prompt: '执行质量门禁并登记证据',
        requiredPlugins: ['dsh-quality-gate', 'dsh-evidence-gate'],
        gate: { kind: 'quality-pass', phase: 'exit', label: DEFAULT_GATE_LABEL['quality-pass'], verdict: 'pass-only' },
        onFail: 'implement',
        next: 'delivery',
    },
    {
        id: 'delivery',
        prompt: '交付审计与回执',
        requiredPlugins: ['dsh-evidence-gate', 'dsh-audit-trail'],
        gate: { kind: 'receipt', phase: 'exit', label: DEFAULT_GATE_LABEL.receipt, verdict: 'pass-only' },
        onFail: 'quality-verify',
    },
]

/** A resolved pipeline plus the default attempt budget it was built with. */
export interface ResolvedPipeline {
    stages: Pipeline
    defaultMaxAttempts: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGateKind(value: unknown): value is GateKind {
    return typeof value === 'string' && (GATE_KINDS as readonly string[]).includes(value)
}

/** Whether a gate kind gates a transition at all. */
export function isGated(gate: GateSpec): boolean {
    return gate.kind !== 'none'
}

/**
 * Render one gate for a prompt or a status table.
 * @param gate - resolved gate.
 * @returns a short Chinese description.
 */
export function describeGate(gate: GateSpec): string {
    if (!isGated(gate)) return '无'
    return `${gate.phase === 'entry' ? '进入' : '离开'}时要求：${gate.label}`
}

/**
 * Normalise one user-supplied gate value.
 * @param value - `'spec-approved'` / `{ kind, phase, label }` / omitted.
 * @param issues - collector for rejections (an unknown kind lands here).
 * @returns the resolved gate, or `undefined` when the value is unusable.
 */
function normalizeGate(value: unknown, where: string, issues: string[]): GateSpec | undefined {
    if (value === undefined) return undefined
    let kind: unknown
    let phase: unknown
    let label: unknown
    let verdict: unknown
    if (typeof value === 'string') {
        kind = value
    } else if (isRecord(value)) {
        kind = value['kind']
        phase = value['phase']
        label = value['label']
        verdict = value['verdict']
    } else {
        issues.push(`${where}: gate 必须是字符串或 { kind, phase, label, verdict } 对象`)
        return undefined
    }
    if (!isGateKind(kind)) {
        issues.push(`${where}: 未知的 gate "${String(kind)}"（可用：${GATE_KINDS.join(' / ')}）`)
        return undefined
    }
    if (phase !== undefined && phase !== 'entry' && phase !== 'exit') {
        issues.push(`${where}: gate.phase 必须是 "entry" 或 "exit"`)
        return undefined
    }
    if (verdict !== undefined && verdict !== 'pass-only' && verdict !== 'pass-or-warn') {
        issues.push(`${where}: gate.verdict 必须是 "pass-only" 或 "pass-or-warn"（条件边：门禁 WARN 时是否放行）`)
        return undefined
    }
    const resolvedPhase: 'entry' | 'exit' = phase === 'entry' || phase === 'exit' ? phase : kind === 'quality-pass' || kind === 'receipt' ? 'exit' : 'entry'
    return {
        kind,
        phase: resolvedPhase,
        label: typeof label === 'string' && label !== '' ? label : DEFAULT_GATE_LABEL[kind],
        verdict:
            verdict === 'pass-only' || verdict === 'pass-or-warn'
                ? verdict
                : resolvedPhase === 'exit'
                  ? 'pass-only'
                  : 'pass-or-warn',
    }
}

/** The default gate of one stage id (used when a user overrides a default stage). */
function defaultGateOf(id: string): GateSpec {
    return (
        DEFAULT_STAGES.find((stage) => stage.id === id)?.gate ?? {
            kind: 'none',
            phase: 'entry',
            label: DEFAULT_GATE_LABEL.none,
            verdict: 'pass-or-warn',
        }
    )
}

/**
 * Resolve the requested stages into a valid pipeline.
 *
 * @param input - `config.stages` (untrusted) or `undefined` for the default.
 * @param defaultMaxAttempts - attempt budget for stages without their own.
 * @returns the pipeline and, when an invalid user value was rejected, the
 *   reasons — the caller logs them and falls back to {@link DEFAULT_STAGES}.
 */
export function resolvePipeline(input: unknown, defaultMaxAttempts: number): { stages: Pipeline; issues: string[] } {
    if (input === undefined) return { stages: cloneStages(DEFAULT_STAGES), issues: [] }
    if (!Array.isArray(input)) {
        return { stages: cloneStages(DEFAULT_STAGES), issues: ['stages 必须是数组'] }
    }
    if (input.length === 0) {
        return { stages: cloneStages(DEFAULT_STAGES), issues: ['stages 不能为空数组'] }
    }
    const issues: string[] = []
    const parsed: {
        id: string
        prompt: string
        requiredPlugins: string[]
        gate: GateSpec | undefined
        onFail: string | undefined
        maxAttempts: number | undefined
        next: string | undefined
        role: string | undefined
        autoAdvance: boolean | undefined
        index: number
        where: string
    }[] = []

    input.forEach((entry, index) => {
        const where = `stages[${index}]`
        if (!isRecord(entry)) {
            issues.push(`${where}: 必须是对象`)
            return
        }
        const id = entry['id']
        if (typeof id !== 'string' || id.trim() === '') {
            issues.push(`${where}: id 必须是非空字符串`)
            return
        }
        const prompt = entry['prompt']
        if (typeof prompt !== 'string' || prompt.trim() === '') {
            issues.push(`${where} (${id}): prompt 必须是非空字符串`)
        }
        const requiredRaw = entry['requiredPlugins']
        const requiredPlugins: string[] = []
        if (!Array.isArray(requiredRaw)) {
            issues.push(`${where} (${id}): requiredPlugins 必须是字符串数组`)
        } else {
            for (const plugin of requiredRaw) {
                if (typeof plugin !== 'string' || plugin.trim() === '') {
                    issues.push(`${where} (${id}): requiredPlugins 只能包含非空字符串`)
                } else {
                    requiredPlugins.push(plugin)
                }
            }
        }
        const maxAttempts = entry['maxAttempts']
        if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)) {
            issues.push(`${where} (${id}): maxAttempts 必须是不小于 1 的整数`)
        }
        const readRef = (key: 'next' | 'onFail'): string | undefined => {
            const value = entry[key]
            if (value === undefined) return undefined
            if (typeof value !== 'string' || value.trim() === '') {
                issues.push(`${where} (${id}): ${key} 必须是非空 stage id`)
                return undefined
            }
            return value
        }
        // `role` is validated by SHAPE only: whether the role actually exists is
        // decided by dsh-role-guard (built-in + `.dsh/roles/*.md` + inline
        // config), which the orchestrator deliberately does not read.
        const role = entry['role']
        if (role !== undefined && (typeof role !== 'string' || role.trim() === '')) {
            issues.push(`${where} (${id}): role 必须是非空字符串（角色是否存在由 dsh-role-guard 判定）`)
        }
        const autoAdvance = entry['autoAdvance']
        if (autoAdvance !== undefined && typeof autoAdvance !== 'boolean') {
            issues.push(`${where} (${id}): autoAdvance 必须是布尔值（true = 门禁通过时由宿主自动推进）`)
        }
        parsed.push({
            id,
            prompt: typeof prompt === 'string' ? prompt : '',
            requiredPlugins,
            gate: normalizeGate(entry['gate'], `${where} (${id})`, issues),
            onFail: readRef('onFail'),
            maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : undefined,
            next: readRef('next'),
            role: typeof role === 'string' && role.trim() !== '' ? role.trim() : undefined,
            autoAdvance: typeof autoAdvance === 'boolean' ? autoAdvance : undefined,
            index,
            where,
        })
    })

    const seen = new Set<string>()
    for (const stage of parsed) {
        if (seen.has(stage.id)) issues.push(`${stage.where}: 重复的 stage id "${stage.id}"`)
        seen.add(stage.id)
    }
    for (const stage of parsed) {
        for (const key of ['next', 'onFail'] as const) {
            const target = stage[key]
            if (target !== undefined && !seen.has(target)) {
                issues.push(`${stage.where} (${stage.id}): ${key} 指向未知阶段 "${target}"`)
            }
        }
    }
    if (issues.length > 0) return { stages: cloneStages(DEFAULT_STAGES), issues }

    const stages: Pipeline = parsed.map((stage) => {
        const previous = parsed[stage.index - 1]?.id
        const following = parsed[stage.index + 1]?.id
        const next = stage.next ?? following
        const restart = stage.onFail ?? previous
        return {
            id: stage.id,
            prompt: stage.prompt,
            requiredPlugins: stage.requiredPlugins,
            gate: stage.gate ?? defaultGateOf(stage.id),
            ...(restart === undefined ? {} : { onFail: restart }),
            // Resolve the budget here, so the prompt, the breaker report and the
            // status table print the number that actually applies.
            maxAttempts: stage.maxAttempts ?? defaultMaxAttempts,
            ...(next === undefined ? {} : { next }),
            // A user pipeline declares its own roles: unlike the gate (which is
            // inherited by id from the default stage), a role is never inferred
            // for a stage the host rewrote — silently binding `implement` to
            // developer would advertise a role the host did not ask for.
            ...(stage.role === undefined ? {} : { role: stage.role }),
            ...(stage.autoAdvance === undefined ? {} : { autoAdvance: stage.autoAdvance }),
        }
    })
    return { stages, issues: [] }
}

/** Deep-enough copy of a pipeline (stages are flat values). */
function cloneStages(stages: readonly StageConfig[]): Pipeline {
    return stages.map((stage) => ({
        ...stage,
        requiredPlugins: [...stage.requiredPlugins],
        gate: { ...stage.gate },
    }))
}

/** Look one stage up by id. */
export function stageById(pipeline: Pipeline, id: string | undefined): StageConfig | undefined {
    if (id === undefined) return undefined
    return pipeline.find((stage) => stage.id === id)
}

/** The stage before `id` in the pipeline, when any. */
export function previousStageId(pipeline: Pipeline, id: string | undefined): string | undefined {
    if (id === undefined) return undefined
    const index = pipeline.findIndex((stage) => stage.id === id)
    return index > 0 ? pipeline[index - 1]?.id : undefined
}

/** Where a failed stage rolls back to (its `onFail`, else the previous stage). */
export function rollbackTargetOf(pipeline: Pipeline, stage: StageConfig): string | undefined {
    return stage.onFail ?? previousStageId(pipeline, stage.id)
}

/** The stage a passing stage moves to (its `next`, else undefined = end). */
export function nextStageOf(stage: StageConfig): string | undefined {
    return stage.next
}

/**
 * The successor of a passing stage, resolved: its `next`, else its positional
 * follower (a config that omits `next` still chains in order).
 */
export function successorOf(pipeline: Pipeline, stage: StageConfig): StageConfig | undefined {
    const id = nextStageOf(stage) ?? pipeline[pipeline.findIndex((entry) => entry.id === stage.id) + 1]?.id
    return stageById(pipeline, id)
}

/**
 * The instruction that tells the model HOW to activate a stage's role.
 *
 * The orchestrator cannot delegate by itself: activating a role means running
 * `team_delegate`, which belongs to `dsh-role-guard` (that is where the persona
 * and the tool whitelist live). So the stage text names the exact call, and the
 * host probes `dsh-role-guard` as a `requiredPlugins` entry of that stage.
 *
 * @param stage - a stage that declares a role.
 * @returns the Chinese instruction, or `undefined` when the stage has no role.
 */
export function roleInstruction(stage: StageConfig): string | undefined {
    if (stage.role === undefined) return undefined
    return `本阶段请通过 team_delegate({ role: "${stage.role}", ... }) 派发实现`
}

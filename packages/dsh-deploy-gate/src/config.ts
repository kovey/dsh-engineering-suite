/**
 * Plugin configuration: the declared environments, the go/no-go ceiling and the
 * deployment ledger.
 *
 * Two layers, the same rule every plugin in this suite follows (docs.md §9):
 *
 *  - the **profile row** is the ceiling — it decides whether the plugin exists at
 *    all, where its log and its ledger live, how strict the go/no-go verdict is,
 *    and whether a failed deploy may roll itself back;
 *  - `<repo>/.dsh/deploy-gate.json` may **declare/refine the environments** (the
 *    one thing a repository really knows: how *this* project is released) plus the
 *    operational numbers (timeouts, retry counts). It can never weaken the
 *    ceiling: a repository may not turn off a human approval the profile requires,
 *    and it cannot reach `enabled` / `logFile` / the layout / `ledgerFile` /
 *    `goNoGo` / `autoRollbackOnFailure`.
 *
 * Every unusable value follows the suite's rule: it is **reported and the profile
 * value is kept** — never silently replaced by a friendlier one. The one
 * deliberate asymmetry is `requiresApproval`: its default is fail-closed (only an
 * explicit `local`/`staging` kind skips the human), because a default that
 * happens to be "no approval needed" is exactly how an unattended production
 * deploy gets configured by accident.
 *
 * @module dsh-deploy-gate/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions, type Logger } from 'dsh-eng-core'

/** How an environment counts as "production-like" for the approval default. */
export const ENVIRONMENT_KINDS: readonly string[] = ['local', 'staging', 'production']

/** Hard ceiling for `verifyRetries`: verification must not become a wait loop. */
export const MAX_VERIFY_RETRIES = 10

/** Default verify attempts when the host names none. */
export const DEFAULT_VERIFY_RETRIES = 3

/** Hard ceiling for `verifyBackoffMs` (10 minutes). */
export const MAX_VERIFY_BACKOFF_MS = 600_000

/** One canary step: roll out `percent`, wait, then verify. */
export interface CanaryStep {
    /** Traffic/instance share this step moves to the new revision (`0 < percent <= 100`). */
    percent: number
    /** Command template executed for this step (argv, no shell). */
    command: string
    /** How long to wait after the command before verifying. */
    waitMs: number
    /** Extra verification commands for this step (on top of the environment's). */
    verifyCommands?: string[]
}

/** One declared deployment environment. */
export interface EnvironmentConfig {
    /** Stable name the tools address (`production`, `staging-eu`, …). */
    name: string
    /** `local` / `staging` / `production`, or a host-specific label. */
    kind: string
    /**
     * Deployment steps, in order, executed as argv. Empty is legal configuration
     * and an unusable environment: the go/no-go verdict then refuses with the
     * reason instead of pretending there is something to run.
     */
    deployCommands: string[]
    /** Post-deploy verification steps; the go/no-go verdict requires at least one. */
    verifyCommands?: string[]
    /** The rollback path; without it this plugin refuses to roll back. */
    rollbackCommands?: string[]
    /** Whether a human must approve before this environment is touched. */
    requiresApproval: boolean
    /** Optional allowlist file of approvers (one identity per line, `#` comments). */
    approversFile?: string
    /** Optional canary rollout (steps run in order, each verified). */
    canary?: { steps: CanaryStep[] }
}

/** The go/no-go ceiling. */
export interface GoNoGoConfig {
    /** Require a delivery receipt; `false` is the documented opt-out of the receipt binding. */
    requireReceipt: boolean
    /** Require the quality gate to be strictly newer than the newest command/test evidence. */
    requireGateNewerThanEvidence: boolean
    /** Refuse while a human still has an unanswered question pending. */
    requireNoPendingAsks: boolean
    /** Refuse when the quality gate is older than this many minutes (`0` = off). */
    maxGateAgeMinutes: number
    /** Refuse when the workspace has uncommitted changes (the engineering trail excluded). */
    requireCleanTree: boolean
}

/** Resolved plugin configuration. */
export interface DeployGateConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only), e.g. `~/.dsh/logs/{project}/deploy-gate.log`. */
    logFileTemplate?: string
    layout: LayoutOptions
    /** Deployment ledger, relative to the workspace (default `.dsh/deployments.jsonl`). */
    ledgerFile: string
    /** Maximum verify attempts per `deploy_verify` (1…{@link MAX_VERIFY_RETRIES}). */
    verifyRetries: number
    /** Backoff between verify attempts. */
    verifyBackoffMs: number
    /** Deadline for one configured command. */
    commandTimeoutMs: number
    goNoGo: GoNoGoConfig
    /** Whether a failed deploy runs the environment's own rollback commands. */
    autoRollbackOnFailure: boolean
    /** Declared environments (may be empty → every tool refuses). */
    environments: EnvironmentConfig[]
    prompt: {
        enabled: boolean
        order: number
    }
}

/**
 * Keys a repository may refine through `<repo>/.dsh/deploy-gate.json`.
 *
 * How *this* project is released (which commands, to which targets) and how long
 * a command may take are repository knowledge. Everything that decides whether a
 * deploy is allowed at all is the host's call.
 */
export const PROJECT_OVERRIDABLE_KEYS: readonly string[] = [
    'environments',
    'verifyRetries',
    'verifyBackoffMs',
    'commandTimeoutMs',
]

/** Keys a project file may set to `null` to mean "this repository has none". */
export const PROJECT_CLEARABLE_KEYS: readonly string[] = ['environments']

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Whether an environment of this kind needs a human by default.
 *
 * Fail-closed: only an explicitly declared `local`/`staging` kind skips approval.
 * `production`, an unset kind and any host-specific label all require a person,
 * because "we forgot to say it is production" must not be the same as "nobody
 * has to approve it".
 * @param kind - the declared kind.
 */
export function defaultRequiresApproval(kind: string): boolean {
    return kind !== 'local' && kind !== 'staging'
}

/** Render a command list as a bounded one-line summary. */
export function describeCommands(commands: readonly string[] | undefined): string {
    if (commands === undefined || commands.length === 0) return '(未声明)'
    return commands.map((command) => `\`${command}\``).join('、')
}

/** A cleaned string list: non-empty strings only, in order. */
function stringList(value: unknown): { items: string[]; dropped: number } {
    if (!Array.isArray(value)) return { items: [], dropped: 0 }
    const items: string[] = []
    let dropped = 0
    for (const entry of value) {
        if (typeof entry === 'string' && entry.trim() !== '') items.push(entry.trim())
        else dropped += 1
    }
    return { items, dropped }
}

/** Parse one canary step. */
function parseCanaryStep(value: unknown, where: string, warn: (message: string) => void): CanaryStep | undefined {
    if (!isRecord(value)) {
        warn(`${where}: canary 步骤必须是对象 { percent, command, waitMs }，该步骤已丢弃`)
        return undefined
    }
    const percent = value['percent']
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
        warn(`${where}: canary 步骤的 percent 必须是 0–100 之间的大于 0 的数（收到 ${JSON.stringify(percent)}），该步骤已丢弃`)
        return undefined
    }
    const command = value['command']
    if (typeof command !== 'string' || command.trim() === '') {
        warn(`${where}: canary 步骤缺少 command（该步骤已丢弃）——没有命令的"放量"不是一个步骤`)
        return undefined
    }
    const waitMs = num(value['waitMs'], 0)
    if (waitMs < 0) {
        warn(`${where}: canary 步骤的 waitMs 不能为负（收到 ${waitMs}），已按 0 处理`)
    }
    const verify = stringList(value['verifyCommands'])
    return {
        percent: Math.round(percent * 100) / 100,
        command: command.trim(),
        waitMs: Math.max(0, Math.floor(waitMs)),
        ...(verify.items.length === 0 ? {} : { verifyCommands: verify.items }),
    }
}

/**
 * Validate one untrusted environment entry.
 * @param value - the raw entry.
 * @param where - provenance, for the messages.
 * @param warn - sink for recoverable problems.
 * @returns the environment, or the reason it cannot be used at all.
 */
export function parseEnvironment(
    value: unknown,
    where: string,
    warn: (message: string) => void = () => undefined,
): { environment: EnvironmentConfig } | { error: string } {
    if (!isRecord(value)) {
        return { error: `${where}: 环境必须是对象 { name, kind, deployCommands, … }（收到 ${JSON.stringify(value)}）` }
    }
    const name = value['name']
    if (typeof name !== 'string' || name.trim() === '') {
        return { error: `${where}: 环境缺少 name（非空字符串）——没有名字的环境无法被任何工具指定` }
    }
    const cleanName = name.trim()
    const declaredKind = value['kind']
    let kind = 'unknown'
    if (declaredKind !== undefined) {
        if (typeof declaredKind === 'string' && declaredKind.trim() !== '') kind = declaredKind.trim()
        else warn(`${where}: 环境 ${cleanName} 的 kind 必须是非空字符串（收到 ${JSON.stringify(declaredKind)}），已按"未知类型"处理（与 production 同样需要人工批准）`)
    } else {
        warn(`${where}: 环境 ${cleanName} 未声明 kind：按最严格处理（默认需要人工批准；只有显式 kind: local / staging 才默认免审批）`)
    }
    const deploy = stringList(value['deployCommands'])
    if (deploy.dropped > 0) {
        warn(`${where}: 环境 ${cleanName} 的 deployCommands 里有 ${deploy.dropped} 个非字符串/空项，已忽略`)
    }
    const verify = stringList(value['verifyCommands'])
    if (verify.dropped > 0) warn(`${where}: 环境 ${cleanName} 的 verifyCommands 里有 ${verify.dropped} 个非字符串/空项，已忽略`)
    const rollback = stringList(value['rollbackCommands'])
    if (rollback.dropped > 0) warn(`${where}: 环境 ${cleanName} 的 rollbackCommands 里有 ${rollback.dropped} 个非字符串/空项，已忽略`)

    const declaredApproval = value['requiresApproval']
    if (declaredApproval !== undefined && typeof declaredApproval !== 'boolean') {
        warn(`${where}: 环境 ${cleanName} 的 requiresApproval 必须是布尔值（收到 ${JSON.stringify(declaredApproval)}），已按默认值处理`)
    }
    const requiresApproval = typeof declaredApproval === 'boolean' ? declaredApproval : defaultRequiresApproval(kind)

    const approversFile = value['approversFile']
    if (approversFile !== undefined && (typeof approversFile !== 'string' || approversFile.trim() === '')) {
        warn(`${where}: 环境 ${cleanName} 的 approversFile 必须是非空字符串，已忽略`)
    }

    let canary: { steps: CanaryStep[] } | undefined
    const rawCanary = value['canary']
    if (rawCanary !== undefined) {
        if (!isRecord(rawCanary) || !Array.isArray(rawCanary['steps'])) {
            warn(`${where}: 环境 ${cleanName} 的 canary 必须是 { steps: [...] }，已忽略（不会退回"一次性全量发布"的默认行为）`)
        } else {
            const steps: CanaryStep[] = []
            rawCanary['steps'].forEach((step, index) => {
                const parsed = parseCanaryStep(step, `${where}（环境 ${cleanName} canary 步骤 ${index + 1}）`, warn)
                if (parsed !== undefined) steps.push(parsed)
            })
            if (steps.length > 0) canary = { steps }
            else warn(`${where}: 环境 ${cleanName} 声明了 canary 但没有任何可用步骤，已忽略该 canary`)
        }
    }

    return {
        environment: {
            name: cleanName,
            kind,
            deployCommands: deploy.items,
            ...(verify.items.length === 0 ? {} : { verifyCommands: verify.items }),
            ...(rollback.items.length === 0 ? {} : { rollbackCommands: rollback.items }),
            requiresApproval,
            ...(typeof approversFile === 'string' && approversFile.trim() !== '' ? { approversFile: approversFile.trim() } : {}),
            ...(canary === undefined ? {} : { canary }),
        },
    }
}

/** Parse a whole environments array (call arguments, profile and project share it). */
export function parseEnvironments(
    input: unknown,
    where: string,
    warn: (message: string) => void = () => undefined,
): { environments: EnvironmentConfig[]; problems: string[] } {
    const problems: string[] = []
    const collect = (message: string): void => {
        problems.push(message)
        warn(message)
    }
    if (input === undefined || input === null) return { environments: [], problems }
    if (!Array.isArray(input)) {
        collect(`${where}: environments 必须是数组（收到 ${JSON.stringify(input)}）`)
        return { environments: [], problems }
    }
    const environments: EnvironmentConfig[] = []
    input.forEach((entry, index) => {
        const parsed = parseEnvironment(entry, `${where}（environments[${index}]）`, collect)
        if ('error' in parsed) {
            collect(parsed.error)
            return
        }
        if (environments.some((existing) => existing.name === parsed.environment.name)) {
            collect(`${where}: 环境 "${parsed.environment.name}" 重复声明，后一条已忽略（同名环境下"用哪个"必须是确定的）`)
            return
        }
        environments.push(parsed.environment)
    })
    return { environments, problems }
}

/** The go/no-go defaults, spelled out once. */
export function defaultGoNoGo(): GoNoGoConfig {
    return {
        requireReceipt: true,
        requireGateNewerThanEvidence: true,
        requireNoPendingAsks: true,
        maxGateAgeMinutes: 0,
        requireCleanTree: true,
    }
}

/** Parse a go/no-go block (host-only: a repository must not lower this ceiling). */
export function parseGoNoGo(input: unknown, where: string, warn: (message: string) => void): GoNoGoConfig {
    const defaults = defaultGoNoGo()
    if (input === undefined || input === null) return defaults
    if (!isRecord(input)) {
        warn(`${where}: goNoGo 必须是对象，已按默认（最严格）处理`)
        return defaults
    }
    const known = ['requireReceipt', 'requireGateNewerThanEvidence', 'requireNoPendingAsks', 'maxGateAgeMinutes', 'requireCleanTree']
    for (const key of Object.keys(input)) {
        if (!known.includes(key)) warn(`${where}: goNoGo.${key} 不是可识别的键（可用：${known.join(', ')}），已忽略`)
    }
    const takeBool = (key: keyof GoNoGoConfig): boolean => {
        const value = input[key]
        if (value === undefined) return defaults[key] as boolean
        if (typeof value === 'boolean') return value
        warn(`${where}: goNoGo.${key} 必须是布尔值（收到 ${JSON.stringify(value)}），已按默认值 ${String(defaults[key])} 处理`)
        return defaults[key] as boolean
    }
    const rawAge = input['maxGateAgeMinutes']
    let maxGateAgeMinutes = 0
    if (rawAge !== undefined) {
        if (typeof rawAge === 'number' && Number.isFinite(rawAge) && rawAge >= 0) maxGateAgeMinutes = Math.floor(rawAge)
        else warn(`${where}: goNoGo.maxGateAgeMinutes 必须是不小于 0 的数字（0 = 不检查年龄；收到 ${JSON.stringify(rawAge)}），已按 0 处理`)
    }
    return {
        requireReceipt: takeBool('requireReceipt'),
        requireGateNewerThanEvidence: takeBool('requireGateNewerThanEvidence'),
        requireNoPendingAsks: takeBool('requireNoPendingAsks'),
        maxGateAgeMinutes,
        requireCleanTree: takeBool('requireCleanTree'),
    }
}

/**
 * Read one numeric profile key, reporting anything unusable.
 *
 * An absent key takes the default silently (that is what a default is for); a
 * present-but-unusable one is reported, because a value the host wrote and the
 * plugin ignored is a difference the host must hear about. Out-of-range values
 * are clamped to the documented ceiling and reported.
 */
function takeProfileNumber(
    raw: Raw,
    key: string,
    fallback: number,
    floor: number,
    ceiling: number,
    warn: (message: string) => void,
): number {
    const value = raw[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        warn(`profile 配置: ${key} 必须是数字（收到 ${JSON.stringify(value)}），已按默认值 ${fallback} 处理`)
        return fallback
    }
    const floored = Math.max(floor, Math.floor(value))
    if (floored !== value) warn(`profile 配置: ${key}=${value} 不是不小于 ${floor} 的整数，已按 ${floored} 处理`)
    if (floored > ceiling) {
        warn(`profile 配置: ${key}=${value} 超过上限 ${ceiling}，已收敛到上限`)
        return ceiling
    }
    return floored
}

/**
 * Resolve the plugin configuration from the loader row.
 * @param input - the row's `config` value (untrusted).
 * @param warn - sink for recoverable configuration problems.
 */
export function resolveConfig(input: unknown, warn: (message: string) => void = () => undefined): DeployGateConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}

    const environments = parseEnvironments(raw['environments'], 'profile 配置', warn)

    // Numbers are validated on the RAW value: running a wrong type through a
    // defaulting helper would produce a usable number and no message, which is
    // exactly the silent default the suite forbids.
    const retries = takeProfileNumber(raw, 'verifyRetries', DEFAULT_VERIFY_RETRIES, 1, MAX_VERIFY_RETRIES, warn)
    const backoff = takeProfileNumber(raw, 'verifyBackoffMs', 5_000, 0, MAX_VERIFY_BACKOFF_MS, warn)
    const timeout = takeProfileNumber(raw, 'commandTimeoutMs', 600_000, 1_000, Number.MAX_SAFE_INTEGER, warn)

    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/deploy-gate.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        ledgerFile: str(raw['ledgerFile'], '.dsh/deployments.jsonl'),
        verifyRetries: retries,
        verifyBackoffMs: backoff,
        commandTimeoutMs: timeout,
        goNoGo: parseGoNoGo(raw['goNoGo'], 'profile 配置', warn),
        autoRollbackOnFailure: bool(raw['autoRollbackOnFailure'], false),
        environments: environments.environments,
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 650),
        },
    }
}

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: DeployGateConfig
    source: 'profile' | 'project'
    /** The project file consulted, when one exists. */
    file: string
    /** Recoverable problems (unknown keys, unusable values). */
    problems: string[]
}

/**
 * Overlay a workspace's own `<repo>/.dsh/deploy-gate.json` on the profile row.
 *
 * Key-by-key onto the HOST configuration, so a field this overlay forgets to
 * copy can never be reset to a plugin default. A refused key keeps the profile's
 * value and says why; environments are replaced **by name** (a repository entry
 * with the same name wins for the keys it declares, and a repository may add
 * environments the profile does not mention).
 * @param host - the profile-resolved configuration (the ceiling).
 * @param layout - the workspace layout.
 * @param logger - optional diagnostic sink.
 */
export function resolveEffectiveConfig(
    host: DeployGateConfig,
    layout: Layout,
    logger?: Logger | { warn: (message: string) => void },
): EffectiveConfig {
    const file = loadProjectConfig<Record<string, unknown>>(layout, 'deploy-gate')
    const problems = [...file.problems]
    for (const problem of problems) logger?.warn(problem)
    if (file.value === undefined) return { config: host, source: 'profile', file: file.file, problems }

    const raw = file.value
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE_KEYS.includes(key)) {
            const problem = `${file.file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`
            problems.push(problem)
            logger?.warn(problem)
        }
    }

    const next: DeployGateConfig = { ...host, environments: [...host.environments], goNoGo: { ...host.goNoGo }, prompt: host.prompt }
    let applied = 0
    const reject = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }

    if (raw['environments'] !== undefined) {
        if (raw['environments'] === null) {
            // "this repository declares none" — the profile's environments stay,
            // because clearing them would silently disable every deploy here.
            reject(`${file.file}: environments=null 不被接受（清空环境等于禁止部署）：已忽略，继续使用 profile 声明的环境`)
        } else {
            const parsed = parseEnvironments(raw['environments'], file.file, reject)
            for (const environment of parsed.environments) {
                const previous = host.environments.find((entry) => entry.name === environment.name)
                // The approval ceiling is monotone: a repository may add it, never
                // remove it. Everything else about the environment is its business.
                if (previous?.requiresApproval === true && !environment.requiresApproval) {
                    reject(
                        `${file.file}: 环境 "${environment.name}" 的 requiresApproval 不能由项目级配置关闭（profile 声明该环境需要人工批准）——已保持"需要人工批准"`,
                    )
                }
                const requiresApproval = environment.requiresApproval || previous?.requiresApproval === true
                const merged: EnvironmentConfig = { ...environment, requiresApproval }
                const index = next.environments.findIndex((entry) => entry.name === merged.name)
                if (index >= 0) next.environments[index] = merged
                else next.environments.push(merged)
                applied += 1
            }
        }
    }

    const takePositiveInt = (key: 'verifyRetries' | 'verifyBackoffMs' | 'commandTimeoutMs', floor: number, ceiling: number): void => {
        if (raw[key] === undefined) return
        const value = raw[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= floor) {
            next[key] = Math.min(ceiling, Math.floor(value))
            applied += 1
            return
        }
        reject(`${file.file}: ${key} 必须是不小于 ${floor} 的数字，已忽略（继续使用 profile 的值）`)
    }
    takePositiveInt('verifyRetries', 1, MAX_VERIFY_RETRIES)
    takePositiveInt('verifyBackoffMs', 0, MAX_VERIFY_BACKOFF_MS)
    takePositiveInt('commandTimeoutMs', 1_000, Number.MAX_SAFE_INTEGER)

    if (applied === 0) return { config: host, source: 'profile', file: file.file, problems }
    return { config: next, source: 'project', file: file.file, problems }
}

/** One-line provenance for a report ("profile 配置" / "项目级配置 <file>"). */
export function describeSource(effective: EffectiveConfig): string {
    return effective.source === 'project' ? `项目级配置 ${effective.file}` : 'profile 配置'
}

/**
 * Look one environment up by name.
 * @param config - the effective configuration.
 * @param name - the environment the caller asked for.
 * @returns the environment, or the refusal reason naming what IS declared.
 */
export function environmentByName(config: DeployGateConfig, name: string): { environment: EnvironmentConfig } | { error: string } {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (wanted === '') {
        return {
            error: `必须指定环境（environment）。已声明的环境：${config.environments.map((entry) => entry.name).join(', ') || '(无)'}`,
        }
    }
    const found = config.environments.find((entry) => entry.name === wanted)
    if (found === undefined) {
        return {
            error:
                `未知环境 "${wanted}"：本插件只执行宿主声明的环境，不会为一个没声明的名字发明一套部署命令（fail closed）。` +
                `已声明的环境：${config.environments.map((entry) => entry.name).join(', ') || '(无——profile 与 .dsh/deploy-gate.json 都没有声明任何环境)'}`,
        }
    }
    return { environment: found }
}

/**
 * Contract checks: "the interface you declared still behaves".
 *
 * This is a **smoke** contract gate, not a mocking framework. It runs one
 * host-configured command and asserts the expectations the host declared about
 * its behaviour: the exit code, strings that must (or must not) appear on
 * stdout, and JSON values reachable from stdout's parsed document. Nothing is
 * stubbed, nothing is intercepted, nothing is re-implemented — if a real HTTP
 * call, a real CLI invocation or a real schema dump is wanted, the configured
 * command makes it.
 *
 * What it proves is exactly what it checked, and no more: a contract check says
 * the DECLARED interface still behaves as declared. It does not say the
 * interface is correct, complete, or that a consumer is satisfied — the
 * expectations are the contract, and a contract nobody wrote down is not
 * checked.
 *
 * Two honesty rules shape the reporting:
 *
 *  1. **Every expectation is reported separately**, as a named row with its own
 *     state — never one boolean. A check that could not be evaluated is a
 *     failure, not a skip;
 *  2. **A missing JSON path is a FAILURE naming the path.** `.` and `[n]`
 *     addresses are exact; "the object changed shape" is precisely the contract
 *     break this gate exists to catch, and it must never read as "nothing to
 *     check here".
 *
 * @module dsh-quality-gate/contract
 */

import {
    outputDigestOf,
    runCommand,
    splitCommand,
    tail,
    type GateCommandResult,
    type GateScope,
    type GateState,
    type RunOutcome,
    type RunSpec,
} from 'dsh-eng-core'
import type { QualityGateConfig } from './config.js'

/** The interface class a contract declares (a label, validated). */
export type ContractKind = 'cli' | 'http' | 'schema' | 'command'

/** One JSON path expectation: the path must exist, and match what is declared. */
export interface JsonPathExpectation {
    /** Dotted path with `[n]` indices (`data.items[0].id`). */
    path: string
    /** Exact value the path must hold (compared deeply). */
    equals?: unknown
    /** JSON type the path must hold. */
    type?: JsonType
}

/** The JSON types `jsonPaths[].type` accepts. */
export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

/** What a contract asserts about the command it runs. */
export interface ContractExpect {
    exitCode?: number
    stdoutContains?: string[]
    stdoutNotContains?: string[]
    jsonPaths?: JsonPathExpectation[]
}

/** One host-configured smoke contract. */
export interface ContractConfig {
    id: string
    name: string
    kind: ContractKind
    command: string
    expect?: ContractExpect
    /** Reasons this entry cannot be used as written (any entry refuses the run). */
    problems?: string[]
}

/** One individually reported expectation. */
export interface ContractCheck {
    name: string
    state: 'PASS' | 'FAIL'
    detail: string
}

/** The evaluated result of one contract. */
export interface ContractEvaluation {
    id: string
    name: string
    kind: ContractKind
    command: string
    state: 'PASS' | 'BLOCK'
    exitCode: number | null
    durationMs: number
    timedOut: boolean
    checks: ContractCheck[]
    /** One-line, machine-stable reason (also goes into the gate record). */
    reason: string
    /** Declared-nothing-about items, stated out loud instead of implied. */
    unasserted: string[]
}

/** Options for {@link runContracts}. */
export interface ContractRunOptions {
    cwd: string
    config: QualityGateConfig
    /** Injected clock (the recorded timestamp; tests). */
    now?: () => number
    /** Injected command runner; defaults to `dsh-eng-core`'s `runCommand`. */
    runner?: (spec: RunSpec, service?: unknown) => Promise<RunOutcome>
    /** `ctx.subprocess`, when the host provides it. */
    service?: unknown
    /** Cancellation (the turn signal). */
    signal?: AbortSignal
}

/** The outcome of one contract run (a refusal is not a verdict). */
export type ContractRun =
    | {
          ok: true
          evaluations: ContractEvaluation[]
          state: GateState
          reason: string
          results: GateCommandResult[]
          scope: GateScope
      }
    | { ok: false; problem: string }

const KINDS: readonly ContractKind[] = ['cli', 'http', 'schema', 'command']
const TYPES: readonly JsonType[] = ['string', 'number', 'boolean', 'object', 'array', 'null']
const EXPECT_KEYS: readonly string[] = ['exitCode', 'stdoutContains', 'stdoutNotContains', 'jsonPaths']
const CONTRACT_KEYS: readonly string[] = ['id', 'name', 'kind', 'command', 'expect']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A path segment: an object key, or an array index. */
export type PathSegment = string | number

/**
 * Parse a dotted path with `[n]` indices.
 *
 * Supported: `a`, `a.b`, `a.b[0].c`, `[0].c`, `a[0][1]`. Anything else (`a..b`,
 * `a[`, `a[x]`, a trailing dot) is a config defect and refuses the run — an
 * address this gate cannot evaluate must never be silently treated as satisfied.
 * @param path - the configured path.
 * @returns the segments, or the reason the path cannot be read.
 */
export function parseJsonPath(path: string): { segments: PathSegment[] } | { problem: string } {
    const text = path.trim()
    if (text === '') return { problem: '路径是空字符串' }
    const segments: PathSegment[] = []
    let buffer = ''
    // A `.` is legal after a name or after an index (`a.b`, `a[0].b`) and
    // illegal anywhere else (`a..b`, `.a`, `a.`).
    let lastWasIndex = false
    const flush = (): void => {
        if (buffer !== '') {
            segments.push(buffer)
            buffer = ''
        }
    }
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index] as string
        if (character === '.') {
            if (buffer === '' && !lastWasIndex) {
                return { problem: `"${path}" 里有空的路径段（连续的点，或在开头/结尾的点）` }
            }
            flush()
            lastWasIndex = false
            continue
        }
        if (character === '[') {
            flush()
            const close = text.indexOf(']', index)
            if (close === -1) return { problem: `"${path}" 的 "[" 没有对应的 "]"` }
            const inner = text.slice(index + 1, close).trim()
            if (!/^\d+$/.test(inner)) return { problem: `"${path}" 的下标 "[${inner}]" 必须是数字（数组用 [n]，对象字段用 .name）` }
            segments.push(Number(inner))
            lastWasIndex = true
            index = close
            continue
        }
        if (character === ']') return { problem: `"${path}" 里有孤立的 "]"` }
        buffer += character
        lastWasIndex = false
    }
    if (buffer === '') {
        if (segments.length === 0) return { problem: `"${path}" 里没有任何路径段` }
        if (text.endsWith('.')) return { problem: `"${path}" 以 "." 结尾` }
    } else {
        flush()
    }
    return { segments }
}

/** Human-readable form of the segments walked so far. */
function pathPrefix(segments: readonly PathSegment[], upto: number): string {
    let out = ''
    for (const segment of segments.slice(0, upto + 1)) {
        if (typeof segment === 'number') out += `[${segment}]`
        else out += out === '' ? segment : `.${segment}`
    }
    return out
}

/** Walk a parsed document along the segments. */
export function resolveJsonPath(root: unknown, segments: readonly PathSegment[]): { found: true; value: unknown } | { found: false; at: string } {
    let current: unknown = root
    for (const [index, segment] of segments.entries()) {
        const at = pathPrefix(segments, index)
        if (typeof segment === 'number') {
            if (!Array.isArray(current)) return { found: false, at: `${at}（父级不是数组，是 ${jsonTypeOf(current)}）` }
            if (segment >= current.length) return { found: false, at: `${at}（数组只有 ${current.length} 个元素）` }
            current = current[segment]
            continue
        }
        if (!isRecord(current)) return { found: false, at: `${at}（父级不是对象，是 ${jsonTypeOf(current)}）` }
        if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, at }
        current = current[segment]
    }
    return { found: true, value: current }
}

/** The JSON type of a parsed value. */
export function jsonTypeOf(value: unknown): JsonType {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    if (typeof value === 'object') return 'object'
    // `typeof undefined` is not a JSON type; a resolved `undefined` can only come
    // from a non-JSON source, so it reports as the closest honest answer.
    if (typeof value === 'number') return 'number'
    if (typeof value === 'string') return 'string'
    if (typeof value === 'boolean') return 'boolean'
    return 'null'
}

/** Deep equality for parsed JSON values (key order independent). */
export function jsonEquals(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => jsonEquals(entry, right[index]))
    }
    if (isRecord(left) && isRecord(right)) {
        const leftKeys = Object.keys(left)
        const rightKeys = Object.keys(right)
        return leftKeys.length === rightKeys.length && leftKeys.every((key) => jsonEquals(left[key], right[key]))
    }
    return false
}

/** `JSON.stringify` that never throws on a cyclic/hostile value. */
function display(value: unknown): string {
    try {
        const text = JSON.stringify(value)
        return text === undefined ? String(value) : text
    } catch {
        return String(value)
    }
}

/**
 * Parse one configured contract.
 *
 * Like budgets, a malformed entry is KEPT with its problems attached rather than
 * dropped: {@link preflightContracts} then refuses the run. A contract that
 * silently disappears is a check that silently stopped happening.
 * @param input - the untrusted config entry.
 * @param index - position, used to build a fallback id.
 */
export function parseContract(input: unknown, index: number): { contract: ContractConfig; problems: string[] } {
    if (!isRecord(input)) {
        return {
            contract: { id: `contract-${index + 1}`, name: `contract-${index + 1}`, kind: 'command', command: '' },
            problems: [`contracts[${index}]: 必须是对象（收到 ${JSON.stringify(input)}）`],
        }
    }
    const problems: string[] = []
    const id = optionalText(input['id']) ?? `contract-${index + 1}`
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) problems.push(`contracts[${index}].id "${id}" 不合法（只能字母数字与 - _，以字母数字开头）`)
    const label = `contracts[${index}] (${id})`
    for (const key of Object.keys(input)) {
        if (!CONTRACT_KEYS.includes(key)) {
            problems.push(`${label}: 不认识的键 "${key}"（支持：${CONTRACT_KEYS.join(' / ')}）——写了不执行的期望比没写更危险`)
        }
    }
    const rawKind = input['kind']
    const kindKnown = KINDS.includes(rawKind as ContractKind)
    if (!kindKnown) {
        problems.push(`${label}.kind 必须是 ${KINDS.join(' / ')} 之一（收到 ${JSON.stringify(rawKind)}）`)
    }
    const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
    if (command === '') {
        problems.push(`${label}.command 不能为空：契约门禁只跑宿主声明的命令，空命令等于没检查`)
    }

    let expect: ContractExpect | undefined
    if (input['expect'] !== undefined) {
        if (!isRecord(input['expect'])) {
            problems.push(`${label}.expect 必须是对象（支持：${EXPECT_KEYS.join(' / ')}）`)
        } else {
            const raw = input['expect']
            expect = {}
            for (const key of Object.keys(raw)) {
                if (!EXPECT_KEYS.includes(key)) {
                    problems.push(`${label}.expect 里不认识的键 "${key}"（支持：${EXPECT_KEYS.join(' / ')}）——写错的期望不会执行，只会让人以为检查过了`)
                }
            }
            if (raw['exitCode'] !== undefined) {
                if (typeof raw['exitCode'] === 'number' && Number.isFinite(raw['exitCode'])) expect.exitCode = raw['exitCode']
                else problems.push(`${label}.expect.exitCode 必须是数字（收到 ${JSON.stringify(raw['exitCode'])}）`)
            }
            for (const key of ['stdoutContains', 'stdoutNotContains'] as const) {
                if (raw[key] === undefined) continue
                const value = raw[key]
                if (!Array.isArray(value)) {
                    problems.push(`${label}.expect.${key} 必须是字符串数组（每一条单独判定）`)
                    continue
                }
                const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
                if (entries.length !== value.length) problems.push(`${label}.expect.${key} 里有空值或非字符串项，已忽略这些项`)
                if (entries.length > 0) expect[key] = entries
            }
            if (raw['jsonPaths'] !== undefined) {
                const value = raw['jsonPaths']
                if (!Array.isArray(value)) {
                    problems.push(`${label}.expect.jsonPaths 必须是数组（每项 { path, equals?, type? }）`)
                } else {
                    const paths: JsonPathExpectation[] = []
                    for (const [position, entry] of value.entries()) {
                        if (!isRecord(entry)) {
                            problems.push(`${label}.expect.jsonPaths[${position}] 必须是对象 { path, equals?, type? }`)
                            continue
                        }
                        const path = optionalText(entry['path'])
                        if (path === undefined) {
                            problems.push(`${label}.expect.jsonPaths[${position}] 缺少 path`)
                            continue
                        }
                        const parsed = parseJsonPath(path)
                        if ('problem' in parsed) {
                            problems.push(`${label}.expect.jsonPaths[${position}].path 无法解析：${parsed.problem}`)
                            continue
                        }
                        const expectation: JsonPathExpectation = { path }
                        if (Object.prototype.hasOwnProperty.call(entry, 'equals')) expectation.equals = entry['equals']
                        if (entry['type'] !== undefined) {
                            if (TYPES.includes(entry['type'] as JsonType)) expectation.type = entry['type'] as JsonType
                            else problems.push(`${label}.expect.jsonPaths[${position}].type 必须是 ${TYPES.join(' / ')} 之一（收到 ${JSON.stringify(entry['type'])}）`)
                        }
                        // An entry with neither `equals` nor `type` is still an
                        // assertion: the path must EXIST (see evaluateContract).
                        paths.push(expectation)
                    }
                    if (paths.length > 0) expect.jsonPaths = paths
                }
            }
            const declared = (expect.stdoutContains?.length ?? 0) + (expect.stdoutNotContains?.length ?? 0) + (expect.jsonPaths?.length ?? 0)
            if (expect.exitCode === undefined && declared === 0) {
                problems.push(
                    `${label}.expect 没有声明任何可判定的期望（exitCode 未给，stdoutContains / stdoutNotContains / jsonPaths 都是空的）：` +
                        '空契约什么都证明不了',
                )
            }
        }
    } else {
        problems.push(`${label} 没有声明 expect：契约门禁必须有可判定的期望（exitCode / stdoutContains / stdoutNotContains / jsonPaths）`)
    }

    return {
        contract: {
            id,
            name: optionalText(input['name']) ?? id,
            kind: kindKnown ? (rawKind as ContractKind) : 'command',
            command,
            ...(expect === undefined ? {} : { expect }),
            // Attached so `preflightContracts` (and any consumer holding only the
            // parsed entry) can see why this contract must not run.
            ...(problems.length === 0 ? {} : { problems }),
        },
        problems,
    }
}

/** Validate every contract before anything runs (all problems at once). */
export function preflightContracts(contracts: readonly ContractConfig[]): string[] {
    return contracts.flatMap((contract) => contract.problems ?? [])
}

/** Judge one command outcome against one contract's expectations. */
export function evaluateContract(contract: ContractConfig, outcome: RunOutcome, options: { outputBytes?: number } = {}): ContractEvaluation {
    const expect = contract.expect ?? {}
    const checks: ContractCheck[] = []
    const unasserted: string[] = []
    const stdout = outcome.stdout

    // 1. The command itself must have run: a contract that could not be executed
    //    proves nothing, whatever the other rows say.
    const ranCleanly = outcome.spawnError === undefined && outcome.timedOut !== true && outcome.aborted !== true
    checks.push({
        name: '命令可执行',
        state: ranCleanly ? 'PASS' : 'FAIL',
        detail:
            outcome.spawnError !== undefined
                ? `命令无法启动：${outcome.spawnError}`
                : outcome.aborted === true
                  ? '运行已取消（signal 已 abort）'
                  : outcome.timedOut
                    ? `命令超时，未在期限内结束`
                    : `exit=${outcome.exitCode ?? 'null'}，耗时 ${outcome.durationMs}ms`,
    })

    // 2. Exit code (only when declared; the report says so either way).
    if (expect.exitCode !== undefined) {
        checks.push({
            name: `退出码 = ${expect.exitCode}`,
            state: outcome.exitCode === expect.exitCode ? 'PASS' : 'FAIL',
            detail: outcome.exitCode === expect.exitCode ? `实际退出码 ${outcome.exitCode}` : `实际退出码 ${outcome.exitCode ?? 'null'}`,
        })
    } else {
        unasserted.push(`exitCode：未声明 → 本次不判定退出码（实际 exit=${outcome.exitCode ?? 'null'}）`)
    }

    // 3. stdout contains / not contains.
    for (const needle of expect.stdoutContains ?? []) {
        checks.push({
            name: `stdout 含 ${JSON.stringify(needle)}`,
            state: stdout.includes(needle) ? 'PASS' : 'FAIL',
            detail: stdout.includes(needle) ? '已找到' : `stdout 里没有这段文本；输出尾部：${tail(stdout.trim(), options.outputBytes ?? 400) || '(空)'}`,
        })
    }
    for (const needle of expect.stdoutNotContains ?? []) {
        checks.push({
            name: `stdout 不含 ${JSON.stringify(needle)}`,
            state: stdout.includes(needle) ? 'FAIL' : 'PASS',
            detail: stdout.includes(needle) ? `stdout 里出现了不该出现的这段文本（这是契约破坏的信号）` : '未出现',
        })
    }

    // 4. JSON paths: every declared path is its own row, and a path that cannot
    //    be resolved fails NAMING itself — never "skipped".
    const expectations = expect.jsonPaths ?? []
    if (expectations.length > 0) {
        let document: unknown
        let parsed = false
        try {
            document = JSON.parse(stdout)
            parsed = true
        } catch {
            parsed = false
        }
        if (!parsed) {
            checks.push({
                name: 'stdout 是合法 JSON',
                state: 'FAIL',
                detail: `jsonPaths 需要把 stdout 当 JSON 解析，但它不是合法 JSON；输出尾部：${tail(stdout.trim(), options.outputBytes ?? 400) || '(空)'}`,
            })
        }
        for (const expectation of expectations) {
            const label = `JSON 路径 ${expectation.path}`
            if (!parsed) {
                checks.push({ name: label, state: 'FAIL', detail: 'stdout 不是合法 JSON，无法解析这条路径（按失败处理，不是跳过）' })
                continue
            }
            const parsedPath = parseJsonPath(expectation.path)
            if ('problem' in parsedPath) {
                checks.push({ name: label, state: 'FAIL', detail: `路径无法解析：${parsedPath.problem}` })
                continue
            }
            const resolved = resolveJsonPath(document, parsedPath.segments)
            if (!resolved.found) {
                checks.push({ name: label, state: 'FAIL', detail: `路径不存在（在 ${resolved.at} 处断开）——对象形状变了正是契约破坏` })
                continue
            }
            const hasEquals = Object.prototype.hasOwnProperty.call(expectation, 'equals') && expectation.equals !== undefined
            if (hasEquals) {
                checks.push({
                    name: `${label} = ${display(expectation.equals)}`,
                    state: jsonEquals(resolved.value, expectation.equals) ? 'PASS' : 'FAIL',
                    detail: jsonEquals(resolved.value, expectation.equals)
                        ? `实际 ${display(resolved.value)}`
                        : `实际 ${display(resolved.value)}，与期望的 ${display(expectation.equals)} 不一致`,
                })
            }
            if (expectation.type !== undefined) {
                const actual = jsonTypeOf(resolved.value)
                checks.push({
                    name: `${label} 的类型是 ${expectation.type}`,
                    state: actual === expectation.type ? 'PASS' : 'FAIL',
                    detail: actual === expectation.type ? `实际类型 ${actual}` : `实际类型 ${actual}`,
                })
            }
            if (expectation.type === undefined && !hasEquals) {
                checks.push({ name: `${label} 存在`, state: 'PASS', detail: `实际值 ${display(resolved.value)}` })
            }
        }
    }

    const failed = checks.filter((check) => check.state === 'FAIL')
    return {
        id: contract.id,
        name: contract.name,
        kind: contract.kind,
        command: contract.command,
        state: failed.length === 0 ? 'PASS' : 'BLOCK',
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        checks,
        reason:
            failed.length === 0
                ? `${checks.length} 项期望全部满足`
                : `${failed.length} 项期望未满足：${failed.map((check) => check.name).join('；')}`,
        unasserted,
    }
}

/**
 * Run every configured contract and build the gate rows.
 *
 * A contract that cannot be evaluated refuses the whole call (all problems at
 * once) and nothing is recorded: "I only checked the contracts that happened to
 * be well-formed" is not a contract gate.
 * @param options - workspace, configuration and transport.
 */
export async function runContracts(options: ContractRunOptions): Promise<ContractRun> {
    const config = options.config
    // The structural signature keeps the injected runner substitutable in tests
    // without leaking `dsh-eng-core`'s concrete service type into this module.
    const runner: (spec: RunSpec, service?: unknown) => Promise<RunOutcome> = options.runner ?? (runCommand as never)
    const contracts = [...config.contracts]
    if (contracts.length === 0) {
        return {
            ok: false,
            problem:
                '没有配置任何契约（config.contracts 为空）：契约门禁无法证明任何东西。' +
                '下一步：在 quality-gate 的 config.contracts 里声明至少一条，例如 ' +
                '{"id":"api-smoke","name":"接口冒烟","kind":"http","command":"node scripts/smoke.mjs",' +
                '"expect":{"exitCode":0,"stdoutContains":["ok"],"jsonPaths":[{"path":"data.items[0].id","type":"number"}]}}。',
        }
    }
    const problems = preflightContracts(contracts)
    if (problems.length > 0) {
        return {
            ok: false,
            problem: [`契约配置有 ${problems.length} 处无法执行（没有跑任何命令，也没有记录门禁）：`, ...problems.map((problem) => `- ${problem}`)].join('\n'),
        }
    }

    const evaluations: ContractEvaluation[] = []
    for (const contract of contracts) {
        const outcome = await runner(
            {
                argv: splitCommand(contract.command),
                cwd: options.cwd,
                timeoutMs: config.defaultTimeoutMs,
                maxOutputBytes: config.maxOutputBytes,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            options.service,
        )
        if (outcome.aborted === true) {
            return {
                ok: false,
                problem: `契约 "${contract.id}" 的运行已取消（signal 已 abort）：取消不是裁决，本次没有记录门禁。下一步：在未被取消的轮次重跑 contract_check。`,
            }
        }
        evaluations.push(evaluateContract(contract, outcome))
    }

    const blocked = evaluations.filter((evaluation) => evaluation.state === 'BLOCK')
    return {
        ok: true,
        evaluations,
        state: blocked.length === 0 ? 'PASS' : 'BLOCK',
        reason:
            blocked.length === 0
                ? `契约裁决：${evaluations.length} 条契约的 ${evaluations.reduce((total, evaluation) => total + evaluation.checks.length, 0)} 项期望全部满足`
                : `契约裁决：${blocked.map((evaluation) => evaluation.id).join(', ')} 有期望未满足`,
        results: evaluations.map((evaluation) => contractResult(evaluation)),
        scope: {
            selected: contracts.map((contract) => contract.id),
            total: config.contracts.length,
            // Same doctrine as budgets: a contract run is not the host's gate
            // command set and must never authorise a delivery.
            full: false,
        },
    }
}

/** One contract as a `GateCommandResult` row. */
export function contractResult(evaluation: ContractEvaluation): GateCommandResult {
    const output = [
        `契约：${evaluation.name}（${evaluation.id}）— kind=${evaluation.kind}`,
        ...evaluation.checks.map((check) => `[${check.state}] ${check.name}：${check.detail}`),
        ...evaluation.unasserted.map((line) => `[未断言] ${line}`),
    ].join('\n')
    return {
        id: evaluation.id,
        name: `契约：${evaluation.name}`,
        command: evaluation.command,
        required: true,
        exitCode: evaluation.state === 'PASS' ? 0 : 1,
        signal: null,
        durationMs: evaluation.durationMs,
        timedOut: evaluation.timedOut,
        output: tail(output, 4_000),
        outputDigest: outputDigestOf(output, evaluation.command),
    }
}

/** Render the `contract_check` report (Chinese, exact, ends with 下一步). */
export function renderContracts(run: Extract<ContractRun, { ok: true }>, options: { problems?: number } = {}): string {
    const lines: string[] = []
    lines.push(`${run.state === 'PASS' ? '✅' : '⛔'} 契约门禁：${run.state}`)
    lines.push(`原因：${run.reason}`)
    lines.push(
        `范围：${run.scope.selected.length}/${run.scope.total} 条契约（${run.scope.selected.join('、')}）；` +
            '契约裁决的 `scope.full` 恒为 false —— 它执行的不是宿主的门禁命令集，因此**不构成交付依据**。',
    )
    if ((options.problems ?? 0) > 0) {
        lines.push(`⚠️ 配置另有 ${options.problems} 条问题（见插件日志）：没有被执行的契约看起来和通过一模一样。`)
    }
    for (const evaluation of run.evaluations) {
        lines.push('')
        lines.push(`[${evaluation.state === 'PASS' ? 'PASS' : 'BLOCK'}] ${evaluation.id}（${evaluation.name}，kind=${evaluation.kind}）— exit=${evaluation.exitCode ?? 'null'}，${evaluation.durationMs}ms`)
        lines.push(`  $ ${evaluation.command}`)
        for (const check of evaluation.checks) lines.push(`  - [${check.state}] ${check.name}：${check.detail}`)
        for (const line of evaluation.unasserted) lines.push(`  - [未断言] ${line}`)
    }
    lines.push('')
    lines.push(
        '说明：这是冒烟契约门禁——它证明的是"声明的接口仍然按声明的方式行为"，不是"接口是正确的"；' +
            '正确与否由规格与评审回答，这里只回答"有没有坏掉"。',
    )
    lines.push(
        run.state === 'PASS'
            ? '下一步：契约没有破坏 ≠ 门禁通过——交付前仍需不带 only/phase 跑一次完整的 quality_gate_run，再 evidence_record → mission_complete。'
            : '下一步：按失败的那几项期望定位破坏点：是接口真坏了（修代码），还是期望写错了（改 config.contracts，属于规范变更）。改完重跑 contract_check。',
    )
    return lines.join('\n')
}

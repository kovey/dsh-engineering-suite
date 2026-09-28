/**
 * dsh-deploy-gate tests.
 *
 * Four groups:
 *  - CONFIG (profile ceiling, project overlay, environment validation);
 *  - the PURE helpers (command tokenisation, the go/no-go checklist, the ledger);
 *  - the five tools against a fake host, a real temp git repository and real
 *    child processes — with an injected clock and sleep, so retries and canary
 *    waits are exercised without waiting;
 *  - the recording contract (gate + ledger row with revision/approver/messageId).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
    MissionStoreRegistry,
    silentLogger,
    formatTime,
    gitFingerprint,
    resolveLayout,
    type EvidenceRecord,
    type GateState,
} from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, environmentByName, evaluateGoNoGo, inject, name, resolveConfig, resolveEffectiveConfig, sectionText, verifyNeedsApproval } from '../dist/index.js'
import { resolveCommands, tokenizeTemplate } from '../dist/command.js'
import {
    appendLedgerRow,
    liveDeployment,
    readLedger,
    rollbackTargetOf,
    summarize,
    type LedgerRow,
} from '../dist/ledger.js'
import { compareRevision, newestEvidenceAt, newestReceipt, type GoNoGoInput, type MissionLike } from '../dist/plan.js'
import { normalizeInteractionReply, pendingAsksOf, registerTools, type ToolDeps } from '../dist/tools.js'
import { describeSource } from '../dist/config.js'

// --- fixtures ---------------------------------------------------------------

type CtxLike = { get: (name: string) => unknown; tools: unknown }

/** The deploy command set every fixture repo ships (one script each). */
function repoScripts(calls: string): Record<string, string> {
    const record = (label: string): string => `import fs from 'node:fs'\nfs.mkdirSync(${JSON.stringify(path.dirname(calls))}, { recursive: true })\nfs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(label)} + '\\n')\n`
    return {
        'scripts/deploy.mjs': record('deploy'),
        'scripts/deploy2.mjs': record('deploy2'),
        'scripts/verify.mjs': record('verify'),
        'scripts/rollback.mjs': record('rollback'),
        'scripts/canary1.mjs': record('canary1'),
        'scripts/canary2.mjs': record('canary2'),
    }
}

/**
 * A temp git repository whose markers live under `.dsh/`.
 *
 * The markers are deliberately inside the engineering trail: the fingerprint
 * excludes it, so running commands does not make the workspace look dirty (the
 * same rule the plugin applies to its own bookkeeping).
 */
function scriptRepo(extra: Record<string, string> = {}): { cwd: string; calls: string } {
    const cwd = tempWorkspace('deploy-gate-')
    const calls = path.join(cwd, '.dsh', 'calls.txt')
    const files = { ...repoScripts(calls), ...extra }
    for (const [file, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
        fs.writeFileSync(path.join(cwd, file), body)
    }
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
    }
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'deploy-gate test')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    return { cwd, calls }
}

/** Read the marker file (ordered command labels). */
function callsOf(calls: string): string[] {
    if (!fs.existsSync(calls)) return []
    return fs
        .readFileSync(calls, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
}

/** A staging environment that needs no approval (explicitly declared). */
function stagingEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'staging',
        kind: 'staging',
        deployCommands: ['node scripts/deploy.mjs'],
        verifyCommands: ['node scripts/verify.mjs'],
        rollbackCommands: ['node scripts/rollback.mjs'],
        ...overrides,
    }
}

/** A production environment (approval required by the kind default). */
function productionEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...stagingEnvironment(), name: 'production', kind: 'production', ...overrides }
}

/** Raw profile config used by most tests. */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ledgerFile: '.dsh/deployments.jsonl',
        verifyRetries: 3,
        verifyBackoffMs: 5000,
        commandTimeoutMs: 30000,
        goNoGo: {},
        environments: [stagingEnvironment()],
        ...overrides,
    }
}

interface HarnessOptions {
    config?: Record<string, unknown>
    withApproval?: boolean
    approvalOutcome?: 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled'
    services?: Record<string, unknown>
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /**
     * Resolve the effective configuration through the workspace's own
     * `.dsh/deploy-gate.json` (the profile-ceiling overlay) instead of using the
     * profile row verbatim — needed by the tests that exercise the overlay.
     */
    resolveProject?: boolean
}

interface Harness {
    host: FakeHost
    stores: MissionStoreRegistry
    config: ReturnType<typeof resolveConfig>
    deps: ToolDeps
    run: (toolName: string, args?: unknown) => Promise<{ isError: boolean; content: unknown }>
    text: (toolName: string, args?: unknown) => Promise<string>
}

/**
 * The interaction facts of a HEALTHY workspace: the service is mounted AND it
 * has read this workspace's ledger, so "no pending asks" is a verified fact
 * rather than "this process could not look".
 *
 * It is the default service set because the go/no-go policy is fail-closed
 * (`goNoGo.pendingAsksUnverifiable` defaults to `'block'`): with no observable
 * ledger every verdict would be `no-go` for a reason unrelated to what the test
 * is about. Tests that need the unobservable case pass their own `services`.
 */
function healthyInteraction(): Record<string, unknown> {
    return { pending: () => [], ledgers: () => ['/repo/.dsh/interaction/decisions.jsonl'] }
}

function harnessFor(cwd: string, options: HarnessOptions = {}): Harness {
    const stores = new MissionStoreRegistry()
    const host = createFakeHost({
        cwd,
        ...(options.withApproval === undefined ? {} : { withApproval: options.withApproval }),
        ...(options.approvalOutcome === undefined ? {} : { approvalOutcome: options.approvalOutcome }),
        services: options.services ?? { interaction: healthyInteraction() },
    })
    const config = resolveConfig({ ...rawConfig(), ...(options.config ?? {}) })
    const deps: ToolDeps = {
        config,
        configFor:
            options.resolveProject === true
                ? () => resolveEffectiveConfig(config, stores.for(cwd).layout, silentLogger)
                : () => ({ config, source: 'profile', file: '', problems: [] }),
        stores,
        approval: () => (host.ctx as CtxLike).get('approval') as never,
        interaction: () => (host.ctx as CtxLike).get('interaction') as never,
        subprocess: () => undefined,
        logger: silentLogger,
        sleep: options.sleep ?? (async () => undefined),
        now: options.now ?? (() => Date.now()),
    }
    const registered = registerTools(host.ctx as never, deps)
    assert.deepEqual(registered.failed, [], 'every tool must register')
    const run = async (toolName: string, args: unknown = {}) => {
        const result = await host.runTool(toolName, args)
        return { isError: result.isError, content: result.content }
    }
    // One call per assertion: a tool call has side effects (ledger rows, gates),
    // so a helper that re-ran it would make every count assertion meaningless.
    const text = async (toolName: string, args: unknown = {}): Promise<string> => {
        const result = await host.runTool(toolName, args)
        return result.isError ? String(result.content) : runText(result)
    }
    return { host, stores, config, deps, run, text }
}

/** Create a delivered mission with a quality gate and (by default) a receipt. */
function deliveredMission(
    stores: MissionStoreRegistry,
    cwd: string,
    options: { receipt?: boolean; gateState?: GateState; gate?: boolean; fingerprint?: ReturnType<typeof gitFingerprint> } = {},
): { store: ReturnType<MissionStoreRegistry['for']>; missionId: string; fingerprint: ReturnType<typeof gitFingerprint> } {
    const store = stores.for(cwd)
    const mission = store.create({ title: 'deploy fixture', cwd })
    const fingerprint = options.fingerprint ?? gitFingerprint(cwd, { excludePaths: [store.layout.rootDir] })
    let gateId = '(no-gate)'
    if (options.gate !== false) {
        const gate = store.recordGate(mission.id, {
            source: 'dsh-quality-gate',
            state: options.gateState ?? 'PASS',
            reason: 'fixture gate',
            results: [
                { id: 'tests', name: 'node --test', command: 'node --test', required: true, exitCode: 0, signal: null, durationMs: 1, timedOut: false, output: 'ok', outputDigest: 'x' },
            ],
            scope: { selected: ['tests'], total: 1, full: true },
            fingerprint,
        })
        gateId = gate.id
    }
    if (options.receipt !== false) {
        store.issueReceipt(mission.id, { issuedBy: 'dsh-evidence-gate', gateId, evidenceIds: [], git: fingerprint })
    }
    store.setStatus(mission.id, 'delivered')
    // The tools resolve the mission through the session binding, which is the
    // only durable answer (`resolveForAgent` never guesses "the newest mission").
    store.bindSession('session-1', mission.id)
    return { store, missionId: mission.id, fingerprint }
}

/** Build a valid `GoNoGoInput`, with overrides. */
function goNoGoInput(overrides: Partial<GoNoGoInput> = {}): GoNoGoInput {
    const cwd = '/tmp/workspace'
    const fingerprint = { isRepo: true, head: 'a'.repeat(40), branch: 'main', dirty: false, changedFiles: 0, diffDigest: 'd'.repeat(64) }
    const mission: MissionLike = { id: 'm-1', status: 'delivered' }
    const receipt = {
        id: 'RCP-1',
        missionId: 'm-1',
        issuedAt: 1_000,
        issuedBy: 'dsh-evidence-gate',
        digest: 'x',
        gateId: 'GATE-1',
        evidenceIds: [],
        git: fingerprint,
    }
    const gate = {
        id: 'GATE-1',
        missionId: 'm-1',
        source: 'dsh-quality-gate',
        state: 'PASS' as GateState,
        checkedAt: 2_000,
        reason: 'all green',
        results: [],
        fingerprint,
        scope: { selected: ['tests'], total: 1, full: true },
    }
    const config = resolveConfig({ environments: [stagingEnvironment()], goNoGo: {} })
    return {
        mission,
        receipt,
        newestGate: gate,
        newestEvidenceAt: 1_500,
        pendingAsks: [],
        pendingAsksQueryable: true,
        fingerprint,
        config,
        environment: config.environments[0] as never,
        now: 3_000,
        ...overrides,
        ...(overrides.config ?? config) === config ? {} : {},
    }
}

const failing = (input: GoNoGoInput): string[] => evaluateGoNoGo(input).failures.map((check) => check.id)

// --- the plugin surface -----------------------------------------------------

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-deploy-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the five tools and the prompt section, and disposes cleanly', () => {
    const host = createFakeHost({ cwd: tempWorkspace('deploy-gate-apply-') })
    apply(host.ctx as never, rawConfig())
    assert.deepEqual(
        [...host.tools.keys()].sort(),
        ['deploy_plan', 'deploy_rollback', 'deploy_run', 'deploy_status', 'deploy_verify'],
    )
    assert.equal(host.sections.length, 1)
    const section = host.sectionText('eng:deploy-gate')
    assert.match(section, /部署是一个\*\*门禁阶段\*\*/)
    assert.match(section, /回滚必须已声明/)
    assert.match(section, /诚实的边界/)
    assert.match(section, /staging/)
    host.dispose()
    assert.equal(host.tools.size, 0)
    assert.equal(host.sections.length, 0)
})

test('apply() with no environment declared still registers, and the prompt says so', () => {
    const host = createFakeHost({ cwd: tempWorkspace('deploy-gate-none-') })
    apply(host.ctx as never, { environments: [] })
    assert.equal(host.tools.size, 5)
    assert.match(host.sectionText('eng:deploy-gate'), /当前声明的环境（0 个）：\(无——每个工具都会拒绝\)/)
})

// --- config -----------------------------------------------------------------

test('config: an unusable value is reported and the profile value is kept', () => {
    const problems: string[] = []
    const config = resolveConfig(
        {
            verifyRetries: 'many',
            verifyBackoffMs: -5,
            commandTimeoutMs: 10,
            ledgerFile: '   ',
            goNoGo: { requireReceipt: 'yes', maxGateAgeMinutes: -1, unknownKey: true },
            environments: 'production',
        },
        (message) => problems.push(message),
    )
    assert.equal(config.verifyRetries, 3)
    assert.equal(config.verifyBackoffMs, 0)
    assert.equal(config.commandTimeoutMs, 1_000)
    assert.equal(config.ledgerFile, '.dsh/deployments.jsonl')
    assert.equal(config.goNoGo.requireReceipt, true, 'an unusable boolean keeps the strict default')
    assert.equal(config.goNoGo.maxGateAgeMinutes, 0)
    assert.deepEqual(config.environments, [])
    assert.ok(problems.some((problem) => problem.includes('verifyRetries')))
    assert.ok(problems.some((problem) => problem.includes('goNoGo.unknownKey')))
    assert.ok(problems.some((problem) => problem.includes('environments 必须是数组')))
})

test('config: verifyRetries is capped — verification must not become a wait loop', () => {
    const problems: string[] = []
    const config = resolveConfig({ verifyRetries: 99, environments: [stagingEnvironment()] }, (message) => problems.push(message))
    assert.equal(config.verifyRetries, 10)
    assert.ok(problems.some((problem) => problem.includes('超过上限')))
})

test('config: approval defaults are fail-closed (only an explicit local/staging skips the human)', () => {
    const config = resolveConfig({
        environments: [
            stagingEnvironment({ name: 'staging' }),
            stagingEnvironment({ name: 'local', kind: 'local' }),
            productionEnvironment({ name: 'production' }),
            stagingEnvironment({ name: 'prod-eu', kind: 'production' }),
            { name: 'mystery', deployCommands: ['node scripts/deploy.mjs'] },
            stagingEnvironment({ name: 'opt-out', requiresApproval: false }),
        ],
    })
    const approval = Object.fromEntries(config.environments.map((environment) => [environment.name, environment.requiresApproval]))
    assert.deepEqual(approval, {
        staging: false,
        local: false,
        production: true,
        'prod-eu': true,
        mystery: true,
        'opt-out': false,
    })
})

test('config: an environment without deploy commands is kept and refused at use time', () => {
    const problems: string[] = []
    const config = resolveConfig({ environments: [{ name: 'empty', kind: 'staging' }] }, (message) => problems.push(message))
    assert.equal(config.environments.length, 1)
    assert.deepEqual(config.environments[0]?.deployCommands, [])
    const found = environmentByName(config, 'empty')
    assert.ok('environment' in found)
    const missing = environmentByName(config, 'nope')
    assert.ok('error' in missing && missing.error.includes('未知环境 "nope"'))
    assert.ok(missing.error.includes('empty'), 'the refusal names what IS declared')
})

test('config: a malformed environment entry is dropped with a reason, never half-used', () => {
    const problems: string[] = []
    const config = resolveConfig(
        {
            environments: [
                { kind: 'production' },
                stagingEnvironment(),
                stagingEnvironment(),
                { name: 'canary', kind: 'staging', deployCommands: ['node scripts/deploy.mjs'], canary: { steps: [{ percent: 0, command: 'x' }, { percent: 10, command: 'y', waitMs: -1 }] } },
            ],
        },
        (message) => problems.push(message),
    )
    assert.deepEqual(config.environments.map((environment) => environment.name), ['staging', 'canary'])
    assert.ok(problems.some((problem) => problem.includes('缺少 name')))
    assert.ok(problems.some((problem) => problem.includes('重复声明')))
    assert.equal(config.environments[1]?.canary?.steps.length, 1)
    assert.equal(config.environments[1]?.canary?.steps[0]?.waitMs, 0)
})

test('project overlay: environments are replaced by name and the approval ceiling is monotone', () => {
    const { cwd } = scriptRepo()
    const host = resolveConfig(rawConfig({ environments: [stagingEnvironment(), productionEnvironment()] }))
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'deploy-gate.json'),
        `${JSON.stringify(
            {
                environments: [
                    { name: 'staging', kind: 'staging', deployCommands: ['node scripts/deploy2.mjs'], verifyCommands: ['node scripts/verify.mjs'], rollbackCommands: ['node scripts/rollback.mjs'] },
                    { name: 'production', kind: 'local', deployCommands: ['node scripts/deploy.mjs'], requiresApproval: false },
                    { name: 'extra', kind: 'staging', deployCommands: ['node scripts/deploy.mjs'] },
                ],
                verifyRetries: 5,
                enabled: false,
                goNoGo: { requireReceipt: false },
                ledgerFile: 'elsewhere.jsonl',
            },
            undefined,
            2,
        )}\n`,
    )
    const effective = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(effective.source, 'project')
    assert.equal(describeSource(effective), `项目级配置 ${effective.file}`)
    assert.equal(effective.config.verifyRetries, 5)
    assert.equal(effective.config.enabled, true, 'a repository cannot disable the gate')
    assert.equal(effective.config.goNoGo.requireReceipt, true, 'a repository cannot lower the go/no-go ceiling')
    assert.equal(effective.config.ledgerFile, '.dsh/deployments.jsonl')
    const byName = Object.fromEntries(effective.config.environments.map((environment) => [environment.name, environment]))
    assert.deepEqual(byName['staging']?.deployCommands, ['node scripts/deploy2.mjs'])
    assert.equal(byName['production']?.requiresApproval, true, 'the profile demanded a human; the repository cannot opt out')
    assert.equal(byName['extra']?.name, 'extra', 'a repository may declare an environment the profile does not mention')
    assert.ok(effective.problems.some((problem) => problem.includes('requiresApproval 不能由项目级配置关闭')))
    assert.ok(effective.problems.some((problem) => problem.includes('不允许在项目级配置里覆盖')))
})

test('project overlay: a malformed file falls back to the profile, and null does not clear environments', () => {
    const { cwd } = scriptRepo()
    const host = resolveConfig(rawConfig())
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'deploy-gate.json'), '{ not json')
    const broken = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(broken.source, 'profile')
    assert.ok(broken.problems.some((problem) => problem.includes('不是合法 JSON')))

    fs.writeFileSync(path.join(cwd, '.dsh', 'deploy-gate.json'), JSON.stringify({ environments: null }))
    const cleared = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(cleared.source, 'profile')
    assert.equal(cleared.config.environments.length, 1)
    assert.ok(cleared.problems.some((problem) => problem.includes('environments=null 不被接受')))
})

// --- command tokenisation ---------------------------------------------------

test('command templates: no shell, no unknown placeholders', () => {
    assert.deepEqual(tokenizeTemplate('node scripts/deploy.mjs --env {environment}', { environment: 'staging' }), {
        argv: ['node', 'scripts/deploy.mjs', '--env', 'staging'],
    })
    for (const template of ['node a.mjs; rm -rf /', 'node a.mjs | tee log', 'node a.mjs > out.txt', 'node a.mjs && echo done', 'a `b`', 'a $(b)', 'a\nb']) {
        const result = tokenizeTemplate(template, {})
        assert.ok('error' in result, `${template} must be refused`)
        assert.match(result.error, /shell 元字符|换行/)
    }
    const unknown = tokenizeTemplate('deploy {typo}', {})
    assert.ok('error' in unknown && unknown.error.includes('未知占位符'))
    const missing = tokenizeTemplate('deploy {revision}', {})
    assert.ok('error' in missing && missing.error.includes('没有该值'))
    const smuggled = tokenizeTemplate('deploy {revision}', { revision: 'main; rm -rf /' })
    assert.ok('error' in smuggled && smuggled.error.includes('渲染后包含 shell 元字符'))
    assert.deepEqual(resolveCommands(['node a.mjs', 'node b.mjs; x'], {})[1], {
        template: 'node b.mjs; x',
        error: resolveCommands(['node b.mjs; x'], {})[0]?.error ?? '',
    })
})

// --- the pure go/no-go ------------------------------------------------------

test('go/no-go: a satisfied checklist is a go, and every check is rendered', () => {
    const result = evaluateGoNoGo(goNoGoInput())
    assert.equal(result.ok, true, JSON.stringify(result.failures))
    assert.deepEqual(result.failures, [])
    assert.deepEqual(
        result.checks.map((check) => check.id),
        [
            'mission',
            'mission-delivered',
            'receipt',
            'receipt-revision',
            'gate',
            'gate-state',
            'gate-newer-than-evidence',
            'asks',
            'clean-tree',
            'environment-deploy-commands',
            'environment-verify-commands',
            'environment-rollback-commands',
        ],
    )
    for (const check of result.checks) {
        assert.equal(typeof check.label, 'string')
        assert.ok(check.detail.length > 0)
    }
})

test('go/no-go: a missing or non-delivered mission blocks the deploy', () => {
    assert.deepEqual(failing(goNoGoInput({ mission: undefined })).slice(0, 2), ['mission', 'mission-delivered'])
    assert.deepEqual(failing(goNoGoInput({ mission: { id: 'm-1', status: 'verified' } })).slice(0, 2), ['mission-delivered'])
    assert.deepEqual(failing(goNoGoInput({ mission: { id: 'm-1', status: 'blocked' } })).slice(0, 2), ['mission', 'mission-delivered'])
})

test('go/no-go: a missing receipt blocks, and requireReceipt=false is an explicit unverified opt-out', () => {
    assert.ok(failing(goNoGoInput({ receipt: undefined })).includes('receipt'))
    const optedOut = goNoGoInput({ receipt: undefined, config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { requireReceipt: false } }) })
    const result = evaluateGoNoGo(optedOut)
    const check = result.checks.find((entry) => entry.id === 'receipt')
    assert.equal(check?.ok, true)
    assert.equal(check?.unverified, true, 'an opt-out must be visible, not silent')
    assert.equal(result.ok, true)
})

test('go/no-go: the receipt must bind THIS revision (or the host opted out)', () => {
    assert.ok(failing(goNoGoInput({ receipt: { ...(goNoGoInput().receipt as never), git: undefined } })).includes('receipt-revision'))
    const otherDiff = { ...goNoGoInput().fingerprint, diffDigest: 'e'.repeat(64) }
    assert.ok(failing(goNoGoInput({ receipt: { ...(goNoGoInput().receipt as never), git: otherDiff } })).includes('receipt-revision'))
    const movedHead = { ...goNoGoInput().fingerprint, head: 'b'.repeat(40) }
    assert.ok(failing(goNoGoInput({ receipt: { ...(goNoGoInput().receipt as never), git: movedHead } })).includes('receipt-revision'))
    const notRepo = { isRepo: false, dirty: false, changedFiles: 0, diffDigest: 'd'.repeat(64) }
    const unverified = evaluateGoNoGo(
        goNoGoInput({ receipt: { ...(goNoGoInput().receipt as never), git: notRepo }, fingerprint: notRepo }),
    )
    assert.equal(unverified.checks.find((check) => check.id === 'receipt-revision')?.unverified, true)
    // A drifted workspace with requireReceipt=false does not block, but says so.
    const drifted = evaluateGoNoGo(
        goNoGoInput({
            receipt: { ...(goNoGoInput().receipt as never), git: otherDiff },
            config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { requireReceipt: false } }),
        }),
    )
    const check = drifted.checks.find((entry) => entry.id === 'receipt-revision')
    assert.equal(check?.ok, true)
    assert.equal(check?.unverified, true)
    assert.match(String(check?.detail), /未阻断/)
})

test('go/no-go: a missing, non-PASS, stale or too-old quality gate blocks', () => {
    assert.ok(failing(goNoGoInput({ newestGate: undefined })).includes('gate'))
    const blocked = goNoGoInput({ newestGate: { ...(goNoGoInput().newestGate as never), state: 'BLOCK' } })
    assert.deepEqual(failing(blocked), ['gate-state'])
    const warn = goNoGoInput({ newestGate: { ...(goNoGoInput().newestGate as never), state: 'WARN' } })
    assert.deepEqual(failing(warn), ['gate-state'])

    const stale = goNoGoInput({ newestEvidenceAt: 9_000 })
    assert.deepEqual(failing(stale), ['gate-newer-than-evidence'])
    const tie = goNoGoInput({ newestEvidenceAt: 2_000 })
    const tieCheck = evaluateGoNoGo(tie).checks.find((check) => check.id === 'gate-newer-than-evidence')
    assert.equal(tieCheck?.ok, false, 'a same-millisecond tie counts as stale (fail closed)')
    assert.match(String(tieCheck?.detail), /同一毫秒/)

    const fresh = evaluateGoNoGo(goNoGoInput({ newestEvidenceAt: undefined }))
    assert.equal(fresh.ok, true, 'no proof at all is not "stale"')

    const ageOff = evaluateGoNoGo(goNoGoInput({ now: 10_000_000 }))
    assert.equal(ageOff.checks.some((check) => check.id === 'gate-age'), false, 'maxGateAgeMinutes=0 means off')
    const ageOn = evaluateGoNoGo(
        goNoGoInput({ now: 10_000_000, config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { maxGateAgeMinutes: 30 } }) }),
    )
    assert.deepEqual(ageOn.failures.map((check) => check.id), ['gate-age'])
    const young = evaluateGoNoGo(
        goNoGoInput({ now: 2_000 + 60_000, config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { maxGateAgeMinutes: 30 } }) }),
    )
    assert.equal(young.ok, true)
})

test('go/no-go: pending asks block, and an unverifiable channel blocks by default', () => {
    assert.deepEqual(failing(goNoGoInput({ pendingAsks: [{ title: '确认回滚窗口', ageMs: 600_000 }] })), ['asks'])
    const off = evaluateGoNoGo(
        goNoGoInput({ pendingAsks: [{ title: 'x' }], config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { requireNoPendingAsks: false } }) }),
    )
    assert.equal(off.ok, true)
    assert.equal(off.checks.some((check) => check.id === 'asks'), false)
    // An unreadable pending-ask fact is a FAILED check, not a ⚠️ pass: two
    // different messages for two different situations ("there ARE pending asks"
    // vs "we could not look"), both BLOCK.
    const noChannel = evaluateGoNoGo(
        goNoGoInput({ pendingAsks: [], pendingAsksQueryable: false, pendingAsksProblem: '宿主没有装配 interaction 服务' }),
    )
    const check = noChannel.checks.find((entry) => entry.id === 'asks')
    assert.equal(noChannel.ok, false)
    assert.equal(check?.ok, false)
    assert.notEqual(check?.unverified, true, 'a failed check is not an "unverified pass"')
    assert.match(String(check?.detail), /无法确认有没有人在等回答/)
    assert.match(String(check?.detail), /宿主没有装配 interaction 服务/)
    assert.match(String(check?.fix), /interaction\.ledgerFile|交互工具/)
    // ...and the host may deliberately opt back into the old ⚠️ behaviour.
    const warn = evaluateGoNoGo(
        goNoGoInput({
            pendingAsks: [],
            pendingAsksQueryable: false,
            config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { pendingAsksUnverifiable: 'warn' } }),
        }),
    )
    const warned = warn.checks.find((entry) => entry.id === 'asks')
    assert.equal(warn.ok, true)
    assert.equal(warned?.ok, true)
    assert.equal(warned?.unverified, true)
    assert.match(String(warned?.detail), /无法核对/)
    // A genuinely observed-and-empty ledger still passes.
    const observed = evaluateGoNoGo(goNoGoInput({ pendingAsks: [], pendingAsksQueryable: true }))
    assert.equal(observed.ok, true)
    assert.equal(observed.checks.find((entry) => entry.id === 'asks')?.unverified, undefined)
})

test('go/no-go: an uncommitted tree blocks, a non-git workspace is unverified', () => {
    assert.deepEqual(failing(goNoGoInput({ fingerprint: { ...goNoGoInput().fingerprint, changedFiles: 2 } })), ['clean-tree'])
    const notRepo = { isRepo: false, dirty: false, changedFiles: 0, diffDigest: 'd'.repeat(64) }
    const result = evaluateGoNoGo(goNoGoInput({ fingerprint: notRepo, receipt: { ...(goNoGoInput().receipt as never), git: notRepo } }))
    assert.equal(result.ok, true)
    assert.equal(result.checks.find((check) => check.id === 'clean-tree')?.unverified, true)
    const off = evaluateGoNoGo(
        goNoGoInput({ fingerprint: { ...goNoGoInput().fingerprint, changedFiles: 3 }, config: resolveConfig({ environments: [stagingEnvironment()], goNoGo: { requireCleanTree: false } }) }),
    )
    assert.equal(off.ok, true)
})

test('go/no-go: an environment that does not describe a release blocks it', () => {
    const bare = resolveConfig({ environments: [{ name: 'bare', kind: 'staging' }] })
    const result = evaluateGoNoGo(goNoGoInput({ config: bare, environment: bare.environments[0] as never }))
    assert.deepEqual(result.failures.map((check) => check.id), [
        'environment-deploy-commands',
        'environment-verify-commands',
        'environment-rollback-commands',
    ])
    const noRollback = resolveConfig({ environments: [stagingEnvironment({ rollbackCommands: undefined })] })
    assert.deepEqual(
        evaluateGoNoGo(goNoGoInput({ config: noRollback, environment: noRollback.environments[0] as never })).failures.map((check) => check.id),
        ['environment-rollback-commands'],
    )
})

test('pure helpers: newest receipt, newest proof time and the revision comparison', () => {
    const old = { id: 'RCP-1', missionId: 'm', issuedAt: 1, issuedBy: 'x', digest: 'd', gateId: 'g', evidenceIds: [] }
    const recent = { ...old, id: 'RCP-2', issuedAt: 9 }
    assert.equal(newestReceipt([old, recent])?.id, 'RCP-2')
    assert.equal(newestReceipt([]), undefined)
    const evidence = [
        { kind: 'gate', recordedAt: 500 },
        { kind: 'command', recordedAt: 100 },
        { kind: 'test', recordedAt: 300 },
    ] as unknown as EvidenceRecord[]
    assert.equal(newestEvidenceAt(evidence), 300, 'gate ledger rows are not "proof"')
    assert.equal(newestEvidenceAt([]), undefined)
    const current = goNoGoInput().fingerprint
    assert.equal(compareRevision(undefined, current).ok, false)
    assert.equal(compareRevision({ ...current, changedFiles: 4 }, current).ok, true, 'content is what the receipt binds')
})

// --- the ledger -------------------------------------------------------------

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
    return {
        at: 1_000,
        id: 'DPL-1',
        environment: 'staging',
        revision: 'main@abc',
        deployer: 'session-1',
        state: 'deployed',
        ...overrides,
    }
}

test('ledger: a truncated last line is tolerated and reported', () => {
    const dir = tempWorkspace('deploy-gate-ledger-')
    const file = path.join(dir, 'deployments.jsonl')
    appendLedgerRow(file, row())
    appendLedgerRow(file, row({ id: 'DPL-2', at: 2_000, revision: 'main@def' }))
    fs.appendFileSync(file, '{"at":3000,"id":"DPL-3","environment":"stag')
    const read = readLedger(file)
    assert.deepEqual(read.rows.map((entry) => entry.id), ['DPL-1', 'DPL-2'])
    assert.equal(read.problems.length, 1)
    assert.match(read.problems[0] ?? '', /截断末行/)
    const summary = summarize(read.rows)
    assert.equal(summary.rows, 2)
    const staging = summary.environments.find((entry) => entry.environment === 'staging')
    assert.equal(staging?.count, 2)
    assert.equal(staging?.state, 'deployed')
    assert.equal(staging?.revision, 'main@def')
    assert.equal(staging?.lastAt, 2_000)
    assert.equal(staging?.rollbackTarget?.id, 'DPL-2')
    assert.equal(readLedger(path.join(dir, 'missing.jsonl')).rows.length, 0)
})

test('ledger: the rollback target follows the state machine (live / failed / rolled back)', () => {
    const rows = [row({ id: 'A', at: 1, state: 'deployed' }), row({ id: 'B', at: 2, state: 'verify-failed' })]
    assert.equal(liveDeployment(rows, 'staging')?.id, 'A', 'a failing verification keeps the live deployment as the rollback target')
    const failed = [...rows, row({ id: 'C', at: 3, state: 'failed' })]
    assert.equal(liveDeployment(failed, 'staging'), undefined, 'a partial rollout leaves the live revision unknown')
    assert.equal(rollbackTargetOf(failed, 'staging')?.id, 'C', 'the failed attempt is still what a rollback undoes')
    const rolled = [...failed, row({ id: 'D', at: 4, state: 'rolled-back', rollbackOf: 'C' })]
    assert.equal(liveDeployment(rolled, 'staging'), undefined)
    assert.equal(rollbackTargetOf(rolled, 'staging')?.id, 'D')
    const refused = [...rows, row({ id: 'E', at: 5, state: 'refused' })]
    assert.equal(liveDeployment(refused, 'staging')?.id, 'A', 'a refused attempt changes nothing')
    assert.equal(summarize(refused).environments[0]?.states.refused, 1)
})

test('ledger: a foreign line is reported, not counted', () => {
    const dir = tempWorkspace('deploy-gate-ledger2-')
    const file = path.join(dir, 'deployments.jsonl')
    appendLedgerRow(file, row())
    fs.appendFileSync(file, `${JSON.stringify({ hello: 'world' })}\n`)
    const read = readLedger(file)
    assert.equal(read.rows.length, 1)
    assert.match(read.problems[0] ?? '', /不是一条部署记录/)
})

// --- the tools --------------------------------------------------------------

test('deploy_plan: writes the plan artifact, executes nothing, and shows commands + rollback', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const { missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_plan', { environment: 'staging' })
    assert.match(text, /## 部署计划：staging（kind=staging/)
    assert.match(text, /✅ 裁决：可以部署/)
    assert.match(text, /node scripts\/deploy\.mjs/)
    assert.match(text, /回滚路径（deploy_rollback）/)
    assert.match(text, /下一步：deploy_run/)
    assert.deepEqual(callsOf(calls), [], 'deploy_plan is read-only with respect to the environment')

    const artifactDir = path.join(cwd, '.dsh', 'missions', missionId, 'deploy')
    const files = fs.readdirSync(artifactDir)
    assert.equal(files.length, 1)
    assert.match(files[0] ?? '', /-plan\.json$/)
    const artifact = JSON.parse(fs.readFileSync(path.join(artifactDir, files[0] as string), 'utf8')) as Record<string, unknown>
    assert.equal(artifact['verdict'], 'go')
    assert.equal(artifact['environment'], 'staging')
    assert.deepEqual(artifact['rollbackCommands'], ['node scripts/rollback.mjs'])
    assert.equal(artifact['requiresApproval'], false)
    assert.equal(artifact['verifyRequiresApproval'], false, 'the plan records the verification-approval rule too')
    assert.ok(Array.isArray(artifact['checks']))
})

test('deploy_plan: an unknown environment is refused, naming what is declared', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    const result = await h.run('deploy_plan', { environment: 'nowhere' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /未知环境 "nowhere"/)
    assert.match(String(result.content), /staging/)
})

test('deploy_run refused without a receipt: nothing runs, and the refusal is recorded', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, { withApproval: true, approvalOutcome: 'allowed-once' })
    const { missionId } = deliveredMission(h.stores, cwd, { receipt: false })
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /部署 go\/no-go 未通过/)
    assert.match(String(result.content), /存在交付回执/)
    assert.deepEqual(callsOf(calls), [], 'not a single command may run')

    const store = h.stores.for(cwd)
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.match(gate?.reason ?? '', /go\/no-go/)
    assert.ok((gate?.results.length ?? 0) >= 1, 'the BLOCK names the failing checks')
    assert.equal(gate?.results[0]?.id, 'check:receipt')
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'refused')
    assert.equal(rows[0]?.gateId, gate?.id)
})

test('deploy_run refused when the quality gate is older than the newest evidence', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const { store, missionId } = deliveredMission(h.stores, cwd)
    store.appendEvidence(missionId, { kind: 'command', summary: '跑了一遍测试', recordedBy: 'test', command: 'node --test', exitCode: 0 })
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /门禁不早于最新 command\/test 证据/)
    assert.deepEqual(callsOf(calls), [])
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
})

test('deploy_run refused while a human question is pending', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, {
        withApproval: true,
        approvalOutcome: 'allowed-once',
        services: { interaction: { ask: async () => 'yes', pendingAsks: () => [{ title: '确认回滚窗口', ageMs: 600_000 }] } },
    })
    deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /有 1 个提问还在等人回答/)
    assert.deepEqual(callsOf(calls), [])
})

test('production requires approval: approved runs, refused does not, no channel refuses', async () => {
    const config = { environments: [productionEnvironment()] }

    const approved = scriptRepo()
    const h1 = harnessFor(approved.cwd, {
        config,
        withApproval: false,
        services: { interaction: { ask: async () => ({ answer: 'yes', by: 'feishu:ou_1', messageId: 'om_card_1', source: 'im' }), ...healthyInteraction() } },
    })
    deliveredMission(h1.stores, approved.cwd)
    const runTextApproved = await h1.text('deploy_run', { environment: 'production' })
    assert.match(runTextApproved, /### 部署执行：成功/)
    assert.deepEqual(callsOf(approved.calls), ['deploy', 'verify'].filter((label) => label === 'deploy'))
    assert.match(runTextApproved, /审批：feishu:ou_1 via im，消息 om_card_1/)

    const denied = scriptRepo()
    const h2 = harnessFor(denied.cwd, { config, approvalOutcome: 'rejected' })
    deliveredMission(h2.stores, denied.cwd)
    const runTextDenied = await h2.text('deploy_run', { environment: 'production' })
    assert.match(runTextDenied, /### 未执行部署/)
    assert.match(runTextDenied, /人工审批被拒绝/)
    assert.deepEqual(callsOf(denied.calls), [], 'a refused approval must not run anything')
    const deniedRows = readLedger(path.join(denied.cwd, '.dsh', 'deployments.jsonl')).rows
    assert.equal(deniedRows.at(-1)?.state, 'refused')

    const noChannel = scriptRepo()
    const h3 = harnessFor(noChannel.cwd, { config, withApproval: false })
    deliveredMission(h3.stores, noChannel.cwd)
    const refused = await h3.run('deploy_run', { environment: 'production' })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /既没有装配可用的 interaction 服务，也没有审批通道/)
    assert.deepEqual(callsOf(noChannel.calls), [])
})

test('approversFile: an unlisted approver is refused even after a yes', async () => {
    const { cwd, calls } = scriptRepo()
    fs.writeFileSync(path.join(cwd, 'APPROVERS'), '# who may approve\nzhangyong\n')
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'approvers'], { cwd })
    const config = {
        environments: [productionEnvironment({ approversFile: 'APPROVERS' })],
    }
    const h = harnessFor(cwd, {
        config,
        withApproval: false,
        services: { interaction: { ask: async () => ({ answer: 'yes', by: 'feishu:ou_stranger', messageId: 'om_9' }), ...healthyInteraction() } },
    })
    deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'production' })
    assert.match(text, /审批人 "feishu:ou_stranger" 不在名单/)
    assert.deepEqual(callsOf(calls), [])
})

test('commands run as argv: a shell metacharacter is refused before anything executes', async () => {
    const { cwd, calls } = scriptRepo()
    const config = { environments: [stagingEnvironment({ deployCommands: ['node scripts/deploy.mjs; rm -rf /'] })] }
    const h = harnessFor(cwd, { config })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /shell 元字符/)
    assert.deepEqual(callsOf(calls), [])
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
})

test('a failing command stops the sequence and reports its output tail', async () => {
    const { cwd, calls } = scriptRepo({
        'scripts/boom.mjs': `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(path.join('/tmp', 'unused'))}, 'x')\nconsole.error('BOOM: migration failed')\nprocess.exit(3)\n`,
    })
    // Rewrite the failing script so the marker is ordered with the others.
    fs.writeFileSync(
        path.join(cwd, 'scripts', 'boom.mjs'),
        `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(path.join(cwd, '.dsh', 'calls.txt'))}, 'boom\\n')\nconsole.error('BOOM: migration failed')\nprocess.exit(3)\n`,
    )
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'boom'], { cwd })
    const config = { environments: [stagingEnvironment({ deployCommands: ['node scripts/deploy.mjs', 'node scripts/boom.mjs', 'node scripts/deploy2.mjs'] })] }
    const h = harnessFor(cwd, { config })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'staging' })
    assert.match(text, /### 部署执行：失败/)
    assert.match(text, /BOOM: migration failed/)
    assert.match(text, /退出码 3/)
    assert.deepEqual(callsOf(calls), ['deploy', 'boom'], 'the third command must not run')
    assert.match(text, /后续命令未执行/)
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.scope?.full, false)
})

test('the ledger row carries revision + approver + approval message id', async () => {
    const { cwd } = scriptRepo()
    const config = { environments: [productionEnvironment()] }
    const h = harnessFor(cwd, {
        config,
        withApproval: false,
        services: { interaction: { ask: async () => ({ decision: 'allowed-once', by: 'ou_zhangyong', messageId: 'om_card_42', source: 'im' }), ...healthyInteraction() } },
    })
    const { missionId } = deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'production' })
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    const last = rows.at(-1)
    assert.equal(last?.state, 'deployed')
    assert.equal(last?.environment, 'production')
    assert.equal(last?.approvedBy, 'ou_zhangyong')
    assert.equal(last?.approvalMessageId, 'om_card_42')
    assert.match(last?.revision ?? '', /^main@[0-9a-f]{8}/)
    assert.ok((last?.revision ?? '').includes('diff'))
    assert.ok(last?.gateId !== undefined)
    assert.equal(last?.plan?.checks, 15, '12 checklist rules + 3 command-usability rules')
    assert.ok((last?.deployer ?? '').length > 0)
    assert.ok(rows.every((entry) => entry.environment === 'production'))
    assert.equal(h.stores.for(cwd).lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')
})

test('dryRun prints exactly what would happen and writes nothing', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, { withApproval: true, approvalOutcome: 'allowed-once' })
    deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'staging', dryRun: true })
    assert.match(text, /### 预演（dryRun）/)
    assert.match(text, /未执行任何命令，未写任何文件，未请求任何审批/)
    assert.deepEqual(callsOf(calls), [])
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'deployments.jsonl')), false)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions')), true, 'the mission store exists, but no deploy artifact was written')
    const artifacts = fs.readdirSync(path.join(cwd, '.dsh', 'missions'))
    for (const mission of artifacts) {
        assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'missions', mission, 'deploy')), false)
    }
})

test('deploy_verify retries, then BLOCKs — and the report carries the rollback commands', async () => {
    const { cwd, calls } = scriptRepo()
    const sleeps: number[] = []
    fs.writeFileSync(path.join(cwd, 'scripts', 'badverify.mjs'), `console.error('healthcheck failed')\nprocess.exit(1)\n`)
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'badverify'], { cwd })
    const config = { environments: [stagingEnvironment({ verifyCommands: ['node scripts/badverify.mjs'] })], verifyRetries: 3, verifyBackoffMs: 25 }
    const h = harnessFor(cwd, { config, sleep: async (ms) => void sleeps.push(ms) })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    // A verification verifies a DEPLOYMENT: without one the tool refuses (the PASS
    // gate is what an orchestrator reads as "deployed and verified").
    await h.text('deploy_run', { environment: 'staging' })
    const text = await h.text('deploy_verify', { environment: 'staging' })
    assert.match(text, /⛔ 裁决：BLOCK/)
    assert.match(text, /实际尝试 3 次/)
    assert.match(text, /回滚路径（环境声明的原话，未执行）/)
    assert.match(text, /node scripts\/rollback\.mjs/)
    assert.match(text, /下一步：deploy_rollback/)
    assert.deepEqual(sleeps, [25, 25], 'backoff between attempts only, never after the last one')
    assert.deepEqual(callsOf(calls), ['deploy'], 'the verification commands write nothing here')
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    const row = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    assert.equal(row?.state, 'verify-failed')
    assert.deepEqual(row?.verify, { attempts: 3, ok: false })
})

test('deploy_verify passes on a later attempt (injected sleep, no waiting)', async () => {
    const { cwd } = scriptRepo()
    const counter = path.join(cwd, '.dsh', 'attempts.txt')
    fs.writeFileSync(
        path.join(cwd, 'scripts', 'flakyverify.mjs'),
        [
            "import fs from 'node:fs'",
            `const file = ${JSON.stringify(counter)}`,
            "const seen = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0",
            'const attempt = seen + 1',
            'fs.mkdirSync(' + JSON.stringify(path.dirname(counter)) + ', { recursive: true })',
            'fs.writeFileSync(file, String(attempt))',
            "console.error('attempt ' + attempt)",
            'process.exit(attempt >= 2 ? 0 : 1)',
            '',
        ].join('\n'),
    )
    // The counter lives in the trail, so the workspace stays clean for the next call.
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'flakyverify'], { cwd })
    const sleeps: number[] = []
    const config = { environments: [stagingEnvironment({ verifyCommands: ['node scripts/flakyverify.mjs'] })], verifyRetries: 3, verifyBackoffMs: 10 }
    const h = harnessFor(cwd, { config, sleep: async (ms) => void sleeps.push(ms) })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const text = await h.text('deploy_verify', { environment: 'staging' })
    assert.match(text, /✅ 裁决：PASS/)
    assert.match(text, /实际尝试 2 次/)
    assert.deepEqual(sleeps, [10])
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')
    assert.deepEqual(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)?.verify, { attempts: 2, ok: true })
})

test('deploy_verify refuses an environment with no verification commands', async () => {
    const { cwd } = scriptRepo()
    const config = { environments: [stagingEnvironment({ verifyCommands: undefined })] }
    const h = harnessFor(cwd, { config })
    deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_verify', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /没有声明 verifyCommands/)
})

test('deploy_rollback refuses without declared commands, and records rollbackOf when it runs', async () => {
    const noRollback = scriptRepo()
    const bare = harnessFor(noRollback.cwd, { config: { environments: [stagingEnvironment({ rollbackCommands: undefined })] } })
    deliveredMission(bare.stores, noRollback.cwd)
    const refused = await bare.run('deploy_rollback', { environment: 'staging' })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /没有声明 rollbackCommands/)
    assert.match(String(refused.content), /未演练的回滚不是回滚|不是回滚/)
    assert.deepEqual(callsOf(noRollback.calls), [])

    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const { missionId } = deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const deployed = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    const text = await h.text('deploy_rollback', { environment: 'staging', note: '线上 500' })
    assert.match(text, /### 回滚执行：成功/)
    assert.match(text, /rollbackOf=/)
    const row = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    assert.equal(row?.state, 'rolled-back')
    assert.equal(row?.rollbackOf, deployed?.id, 'the rollback points at the deployment it undoes')
    assert.equal(row?.note, '线上 500')
    assert.deepEqual(callsOf(calls), ['deploy', 'rollback'])
    assert.equal(h.stores.for(cwd).lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')
    // and the environment is no longer "live" as far as the ledger knows
    assert.equal(liveDeployment(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows, 'staging'), undefined)
})

test('deploy_rollback to an explicit ledger id records that target', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const first = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    const text = await h.text('deploy_rollback', { environment: 'staging', to: first?.id })
    assert.match(text, new RegExp(`将撤销：${first?.id}`))
    assert.equal(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)?.rollbackOf, first?.id)
})

test('canary steps execute in order, with their waits, and a failing step stops the rollout', async () => {
    const { cwd, calls } = scriptRepo()
    const sleeps: number[] = []
    const config = {
        environments: [
            stagingEnvironment({
                canary: {
                    steps: [
                        { percent: 10, command: 'node scripts/canary1.mjs', waitMs: 1_000, verifyCommands: ['node scripts/verify.mjs'] },
                        { percent: 50, command: 'node scripts/canary2.mjs', waitMs: 2_000 },
                    ],
                },
            }),
        ],
    }
    const h = harnessFor(cwd, { config, sleep: async (ms) => void sleeps.push(ms) })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'staging' })
    assert.match(text, /canary 放量（2 步）/)
    assert.deepEqual(callsOf(calls), ['deploy', 'canary1', 'verify', 'canary2'])
    assert.deepEqual(sleeps, [1_000, 2_000], 'each step waits its own waitMs, in order')
    const row = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    assert.deepEqual(row?.canary, { steps: 2 })
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')

    const broken = scriptRepo()
    fs.writeFileSync(path.join(broken.cwd, 'scripts', 'canary2.mjs'), `console.error('canary exploded')\nprocess.exit(7)\n`)
    execFileSync('git', ['add', '-A'], { cwd: broken.cwd })
    execFileSync('git', ['commit', '-qm', 'broken canary'], { cwd: broken.cwd })
    const h2 = harnessFor(broken.cwd, { config })
    deliveredMission(h2.stores, broken.cwd)
    const failed = await h2.text('deploy_run', { environment: 'staging' })
    assert.match(failed, /### 部署执行：失败/)
    assert.match(failed, /canary exploded/)
    assert.match(failed, /退出码 7/)
    assert.deepEqual(callsOf(broken.calls), ['deploy', 'canary1', 'verify'], 'the failing step wrote no marker of its own, and nothing after it ran')
})

test('autoRollbackOnFailure runs the declared rollback after a failed deploy', async () => {
    const { cwd, calls } = scriptRepo()
    fs.writeFileSync(path.join(cwd, 'scripts', 'deploy.mjs'), `console.error('deploy broke')\nprocess.exit(4)\n`)
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'broken deploy'], { cwd })
    const h = harnessFor(cwd, { config: { autoRollbackOnFailure: true } })
    const { missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'staging' })
    assert.match(text, /### 自动回滚：已执行/)
    assert.deepEqual(callsOf(calls), ['rollback'])
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.deepEqual(rows.map((entry) => entry.state), ['failed', 'rolled-back'])
    assert.equal(rows[1]?.rollbackOf, rows[0]?.id)
    assert.equal(h.stores.for(cwd).lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'WARN')
})

test('deploy_status summarises a ledger whose last line is truncated', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    const { missionId } = deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const ledgerFile = path.join(cwd, '.dsh', 'deployments.jsonl')
    fs.appendFileSync(ledgerFile, '{"at":9999999,"id":"DPL-trunc","environment":"stag')
    const text = await h.text('deploy_status', {})
    assert.match(text, /## 部署状态/)
    // The environment line now also names the verification-approval rule.
    assert.match(text, /staging（kind=staging；无需批准；验证无需人工批准）/)
    assert.match(text, /部署 1 条，验证 1 条，回滚 1 条/)
    assert.match(text, /1 行无法解析/)
    assert.match(text, /截断末行/)
    assert.match(text, /回滚目标：DPL-/)
    assert.match(text, /最近一条部署门禁（source=dsh-deploy-gate，编排器读的就是这一条）：GATE-.* PASS/)
    assert.match(text, new RegExp(missionId))
    assert.match(text, /挂起的提问：0 个/)
    assert.match(text, /下一步：deploy_plan/)
    assert.match(text, /revision：main@/)
})

test('deploy_status with no environment declared says so instead of pretending', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd, { config: { environments: [] } })
    const text = await h.text('deploy_status', {})
    assert.match(text, /⛔ 没有声明任何环境/)
    assert.match(text, /先在 profile 或 \.dsh\/deploy-gate\.json 里声明至少一个环境/)
})

test('no mission: commands still run, only the ledger is written, and the report says so', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const text = await h.text('deploy_verify', { environment: 'staging' })
    assert.match(text, /无 mission：仅记台账，未写门禁记录/)
    assert.match(text, /门禁记录：\(未记录\)/)
    assert.deepEqual(callsOf(calls), ['verify'])
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.gateId, undefined, 'no gate id is fabricated')
    assert.equal(rows[0]?.state, 'verified')
    assert.equal(h.stores.for(cwd).list().length, 0, 'no mission is fabricated either')
})

test('no mission: deploy_run refuses (nothing to deploy for) and records no fabricated gate', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /本会话没有绑定任何 mission/)
    assert.match(String(result.content), /无 mission：仅记台账，未写门禁记录/)
    assert.deepEqual(callsOf(calls), [])
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.equal(rows.at(-1)?.state, 'refused')
    assert.equal(rows.at(-1)?.gateId, undefined)
})

test('an unknown explicit missionId is refused rather than silently ignored', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_plan', { environment: 'staging', missionId: 'nope-123' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /未知 mission "nope-123"/)
})

test('interaction replies are normalised fail-closed, and pending asks degrade safely', () => {
    assert.equal(normalizeInteractionReply('yes').allowed, true)
    assert.equal(normalizeInteractionReply('no').decision, 'rejected')
    assert.equal(normalizeInteractionReply('maybe').decision, 'unavailable')
    assert.equal(normalizeInteractionReply({ answer: 'approve', by: 'u', messageId: 'm' }).messageId, 'm')
    assert.equal(normalizeInteractionReply({ answer: 'approve' }).source, 'im')
    assert.equal(normalizeInteractionReply(undefined).decision, 'unavailable')
    assert.equal(normalizeInteractionReply({ random: true }).decision, 'unavailable')

    assert.deepEqual(pendingAsksOf(undefined), {
        asks: [],
        queryable: false,
        problem: '宿主没有装配 interaction 服务（ctx.get("interaction") 为空），本进程无法查询任何交互台账',
        fix:
            '让宿主装配一个可查询的 interaction 服务/通道插件（例如 dsh-interaction-gate）后重启会话；' +
            '如果服务已经装配、只是本进程还没读到台账，就在这个工作区里跑一次任何一个交互工具（interaction_status / interaction_ask），' +
            '或把 interaction.ledgerFile 配成一个绝对路径；然后重新 deploy_plan/deploy_run',
    })
    const askOnly = pendingAsksOf({ ask: async () => 'yes' })
    assert.deepEqual(askOnly.asks, [])
    assert.equal(askOnly.queryable, false)
    assert.match(String(askOnly.problem), /没有暴露任何待回答提问的访问器/)
    assert.deepEqual(pendingAsksOf({ pendingAsks: () => [{ title: 'x', ageMs: 5 }] }), { asks: [{ title: 'x', ageMs: 5 }], queryable: true })
    assert.deepEqual(pendingAsksOf({ pendingAsks: () => ({ asks: ['y'] }) }), { asks: [{ title: 'y' }], queryable: true })
    // A bare count is ONE synthetic ask naming the count — never `new Array(n)`.
    assert.deepEqual(pendingAsksOf({ pendingAsks: () => 2 }).asks, [{ title: '通道只报告了数量：2 个提问在等人回答（通道没有给出标题）' }])
    assert.equal(pendingAsksOf({ pendingAsks: () => 0 }).queryable, true)
    const thrown = pendingAsksOf({
        pendingAsks: () => {
            throw new Error('hub down')
        },
    })
    assert.deepEqual(thrown.asks, [])
    assert.equal(thrown.queryable, false)
    assert.match(String(thrown.problem), /hub down/, 'the reason it could not be read must survive')
    // A non-array answer is UNREADABLE, not a verified empty list — and the
    // shape it actually returned is part of the report.
    const weird = pendingAsksOf({ pending: () => 'weird' })
    assert.deepEqual([weird.asks, weird.queryable], [[], false])
    assert.match(String(weird.problem), /不是一个提问数组（收到 string）/)
    const emptyObject = pendingAsksOf({ pending: () => ({}) })
    assert.deepEqual([emptyObject.asks, emptyObject.queryable], [[], false])
    assert.match(String(emptyObject.problem), /不是一个提问数组（收到 对象（键：\(无\)））/)
    assert.deepEqual(pendingAsksOf({ pending: () => undefined }).asks, [])
    // ...but a service that HAS observed a ledger can say "nobody is waiting".
    assert.deepEqual(pendingAsksOf({ pending: () => [], ledgers: () => ['/repo/.dsh/interaction/decisions.jsonl'] }), { asks: [], queryable: true })
    const unobserved = pendingAsksOf({ pending: () => [], ledgers: () => [] })
    assert.deepEqual([unobserved.asks, unobserved.queryable], [[], false])
    assert.match(String(unobserved.problem), /还没有观察到任何交互台账/)
    assert.match(String(unobserved.fix), /interaction\.ledgerFile|交互工具/)
})

test('the prompt section reports the effective environments and the honest limits', () => {
    const config = resolveConfig({ environments: [productionEnvironment()] })
    const text = sectionText(config)
    assert.match(text, /deploy_plan.*deploy_run.*deploy_verify.*deploy_rollback/s)
    // The environment line now also names the verification-approval rule.
    assert.match(text, /production（kind=production，需要人工批准，验证需要人工批准）/)
    assert.match(text, /requireReceipt=true/)
    assert.match(text, /pendingAsksUnverifiable='block'/)
    assert.match(text, /verifyApproval='environment'/)
    assert.match(text, /不要把凭据写进命令行/)
    assert.match(text, /无法证明环境实际发生了什么/)
    assert.match(sectionText(config, '/repo/.dsh/deploy-gate.json'), /可能被本仓库的 `\/repo\/\.dsh\/deploy-gate\.json` 细化/)
})

test('the recorded gate is the newest of its source, so an orchestrator reads the truth', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    const { store, missionId } = deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const afterRun = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(afterRun?.state, 'PASS')
    assert.ok(afterRun?.checkedAt !== undefined)
    await h.text('deploy_verify', { environment: 'staging' })
    const afterVerify = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(afterVerify?.state, 'PASS')
    assert.ok((afterVerify?.checkedAt ?? 0) >= (afterRun?.checkedAt ?? 0))
    assert.ok((afterVerify?.id ?? '') !== (afterRun?.id ?? ''))
    // The quality gate is a different source and stays untouched.
    assert.equal(store.lastGate(missionId, { source: 'dsh-quality-gate' })?.state, 'PASS')
})

test('every report ends with a next step, including the refusals', async () => {
    const ending = (text: string): string => text.split('\n').filter((line) => line.trim() !== '').at(-1) ?? ''
    const ok = scriptRepo()
    const h = harnessFor(ok.cwd)
    deliveredMission(h.stores, ok.cwd)
    assert.match(ending(await h.text('deploy_plan', { environment: 'staging' })), /^下一步：/)
    assert.match(ending(await h.text('deploy_run', { environment: 'staging' })), /^下一步：/)
    assert.match(ending(await h.text('deploy_verify', { environment: 'staging' })), /^下一步：/)
    assert.match(ending(await h.text('deploy_rollback', { environment: 'staging' })), /^下一步：/)
    assert.match(ending(await h.text('deploy_status', {})), /^下一步：/)

    const refused = scriptRepo()
    const h2 = harnessFor(refused.cwd)
    deliveredMission(h2.stores, refused.cwd, { receipt: false })
    const refusal = await h2.run('deploy_run', { environment: 'staging' })
    assert.equal(refusal.isError, true)
    assert.match(ending(String(refusal.content)), /^下一步：/) // a refusal also closes with a next step

    const denied = scriptRepo()
    const h3 = harnessFor(denied.cwd, { config: { environments: [productionEnvironment()] }, approvalOutcome: 'rejected' })
    deliveredMission(h3.stores, denied.cwd)
    assert.match(ending(await h3.text('deploy_run', { environment: 'production' })), /^下一步：/)
})

test('placeholders are substituted per token, so a spaced value stays one argv element', async () => {
    const { cwd, calls } = scriptRepo()
    const args = path.join(cwd, '.dsh', 'args.txt')
    fs.writeFileSync(
        path.join(cwd, 'scripts', 'args.mjs'),
        `import fs from 'node:fs'\nfs.mkdirSync(${JSON.stringify(path.dirname(args))}, { recursive: true })\nfs.appendFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
    )
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'args'], { cwd })
    const config = { environments: [stagingEnvironment({ deployCommands: ['node scripts/args.mjs --env {environment} --rev {revision} --dir {workspace}'] })] }
    const h = harnessFor(cwd, { config })
    deliveredMission(h.stores, cwd)
    await h.text('deploy_run', { environment: 'staging' })
    const argv = JSON.parse(fs.readFileSync(args, 'utf8').trim()) as string[]
    assert.deepEqual(argv.slice(0, 4), ['--env', 'staging', '--rev', cwd === '' ? '' : argv[3] as string])
    assert.match(argv[3] ?? '', /^[0-9a-f]{40}$/, 'the revision placeholder is the git HEAD')
    assert.equal(argv[5], cwd, 'the workspace placeholder is the absolute repository root')
})

test('the report never invents a command: only configured templates are shown', async () => {
    const { cwd } = scriptRepo()
    const h = harnessFor(cwd)
    deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_plan', { environment: 'staging' })
    const configured = ['node scripts/deploy.mjs', 'node scripts/verify.mjs', 'node scripts/rollback.mjs']
    for (const command of configured) assert.ok(text.includes(command), `${command} must appear verbatim`)
    assert.match(text, /来自配置，未经模型改写/)
})

// --- adversarial-audit regressions ------------------------------------------
//
// One test per finding of the adversarial audit (each finding was reproduced
// against the built `dist/` first; the repro is named in the test).

test('a project environment entry inherits the profile keys it does not declare (approversFile survives)', async () => {
    // Repro a3.mjs: the project file re-declares `production` without
    // `approversFile`, and an approval by a stranger was accepted.
    const { cwd, calls } = scriptRepo()
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'deploy-approvers.txt'), 'alice\n')
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'deploy-gate.json'),
        JSON.stringify({
            environments: [
                {
                    name: 'production',
                    kind: 'production',
                    deployCommands: ['node scripts/deploy.mjs'],
                    verifyCommands: ['node scripts/verify.mjs'],
                    rollbackCommands: ['node scripts/rollback.mjs'],
                },
            ],
        }),
    )
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'project config'], { cwd })
    const h = harnessFor(cwd, {
        config: { environments: [productionEnvironment({ approversFile: '.dsh/deploy-approvers.txt' })] },
        resolveProject: true,
        withApproval: false,
        services: { interaction: { ask: async () => ({ decision: 'allowed-once', by: 'stranger', messageId: 'msg-1' }), ...healthyInteraction() } },
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const effective = resolveEffectiveConfig(h.config, h.stores.for(cwd).layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.environments[0]?.approversFile, '.dsh/deploy-approvers.txt', 'the profile key is inherited, not dropped')
    assert.equal(effective.config.environments[0]?.requiresApproval, true)

    const text = await h.text('deploy_run', { environment: 'production' })
    assert.match(text, /审批人 "stranger" 不在名单/)
    assert.deepEqual(callsOf(calls), [], 'an unlisted approver must not run anything')
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
})

test('a project entry may ADD an approver list but never replace the host one (monotone)', () => {
    const cwd = tempWorkspace('deploy-gate-approvers-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const host = resolveConfig({ environments: [productionEnvironment({ approversFile: '.dsh/host-approvers.txt' })] })

    fs.writeFileSync(path.join(cwd, '.dsh', 'deploy-gate.json'), JSON.stringify({ environments: [{ name: 'production', approversFile: 'mine.txt' }] }))
    const replaced = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(replaced.config.environments[0]?.approversFile, '.dsh/host-approvers.txt', 'the host list stays authoritative')
    assert.ok(replaced.problems.some((problem) => /不能替换 profile 声明的名单/.test(problem)), JSON.stringify(replaced.problems))

    fs.writeFileSync(path.join(cwd, '.dsh', 'deploy-gate.json'), JSON.stringify({ environments: [{ name: 'staging', approversFile: 'mine.txt' }] }))
    const added = resolveEffectiveConfig(host, resolveLayout(cwd))
    const staging = added.config.environments.find((environment) => environment.name === 'staging')
    assert.equal(staging?.approversFile, 'mine.txt', 'an environment the profile does not declare may bring its own list')
})

test('an unobservable interaction ledger BLOCKS by default, and only warn makes it a ⚠️ pass', async () => {
    // Repro a16.mjs + follow-up: the service's `pending()` reads only the ledgers
    // THIS process has observed, so `[]` cannot be read as "nobody is waiting" —
    // and since "we could not look" must not authorise a deploy, the default is
    // now a FAILED check naming exactly what could not be observed.
    const unobserved = scriptRepo()
    const h = harnessFor(unobserved.cwd, { services: { interaction: { pending: () => [], ledgers: () => [] } } })
    deliveredMission(h.stores, unobserved.cwd)
    const text = await h.text('deploy_plan', { environment: 'staging' })
    assert.match(text, /⛔ 没有等待人工回答的提问/)
    assert.match(text, /⛔ 裁决：不可部署/)
    assert.match(text, /无法区分"没有等待"与"还没读到台账"/)
    assert.match(text, /interaction\.ledgerFile/)
    assert.doesNotMatch(text, /本项未实际核对/)

    // The host may deliberately keep the old ⚠️ behaviour — and then the pass is
    // still visibly "unverified" rather than silently green.
    const warned = scriptRepo()
    const h1 = harnessFor(warned.cwd, {
        config: { goNoGo: { pendingAsksUnverifiable: 'warn' } },
        services: { interaction: { pending: () => [], ledgers: () => [] } },
    })
    deliveredMission(h1.stores, warned.cwd)
    const text1 = await h1.text('deploy_plan', { environment: 'staging' })
    assert.match(text1, /⚠️ 没有等待人工回答的提问/)
    assert.match(text1, /本项未实际核对，不计为已验证/)
    assert.match(text1, /✅ 裁决：可以部署/)
    assert.doesNotMatch(text1, /⛔ 没有等待人工回答的提问/)

    const observed = scriptRepo()
    const h2 = harnessFor(observed.cwd, { services: { interaction: { pending: () => [], ledgers: () => ['/repo/.dsh/interaction/decisions.jsonl'] } } })
    deliveredMission(h2.stores, observed.cwd)
    const empty = await h2.text('deploy_plan', { environment: 'staging' })
    assert.match(empty, /✅ 没有等待人工回答的提问/, 'a service that HAS read a ledger may report a verified empty list')

    const waiting = scriptRepo()
    const h3 = harnessFor(waiting.cwd, {
        services: { interaction: { pending: () => [{ title: '确认回滚窗口', ageMs: 600_000 }], ledgers: () => ['/repo/.dsh/interaction/decisions.jsonl'] } },
    })
    deliveredMission(h3.stores, waiting.cwd)
    const blocked = await h3.text('deploy_plan', { environment: 'staging' })
    // Two different situations, two different messages — both BLOCK.
    assert.match(blocked, /⛔ 没有等待人工回答的提问/)
    assert.match(blocked, /有 1 个提问还在等人回答/)
    assert.doesNotMatch(blocked, /无法确认有没有人在等回答/)
    assert.match(blocked, /⛔ 裁决：不可部署/)
})

test('a workspace with NO interaction service cannot reach a go verdict (fail closed, with the fix)', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, { services: {} })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    const message = String(result.content)
    assert.match(message, /无法确认有没有人在等回答/)
    assert.match(message, /宿主没有装配 interaction 服务/)
    assert.match(message, /ctx\.get\("interaction"\)/)
    assert.deepEqual(callsOf(calls), [], 'nothing may run while the pending-ask fact is unobservable')
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.results[0]?.id, 'check:asks')
})

test('goNoGo.pendingAsksUnverifiable is host-only: a project file cannot loosen it', () => {
    const cwd = tempWorkspace('deploy-gate-gonogo-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'deploy-gate.json'),
        JSON.stringify({ goNoGo: { pendingAsksUnverifiable: 'warn', requireReceipt: false } }),
    )
    const host = resolveConfig({ environments: [stagingEnvironment()] })
    const effective = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(effective.config.goNoGo.pendingAsksUnverifiable, 'block', 'the profile value is kept')
    assert.equal(effective.config.goNoGo.requireReceipt, true)
    assert.equal(effective.source, 'profile')
    assert.ok(effective.problems.some((problem) => /goNoGo/.test(problem)), JSON.stringify(effective.problems))
    // ...while the host itself may choose it, and the invalid value falls back to block.
    assert.equal(resolveConfig({ goNoGo: { pendingAsksUnverifiable: 'warn' } }).goNoGo.pendingAsksUnverifiable, 'warn')
    const problems: string[] = []
    assert.equal(resolveConfig({ goNoGo: { pendingAsksUnverifiable: 'nope' } }, (message) => problems.push(message)).goNoGo.pendingAsksUnverifiable, 'block')
    assert.ok(problems.some((problem) => /pendingAsksUnverifiable/.test(problem)), JSON.stringify(problems))
})

test('a numeric pending() return is a count, never an allocation', () => {
    // Repro a2.mjs: `new Array(20_000_000)` killed the process (heap OOM).
    const started = Date.now()
    const huge = pendingAsksOf({ pending: () => 20_000_000 })
    assert.equal(huge.queryable, true)
    assert.equal(huge.asks.length, 1, 'a count is ONE synthetic ask, never N entries')
    assert.match(huge.asks[0]?.title ?? '', /超过 1000 个提问在等人回答/)
    assert.ok(Date.now() - started < 500, 'a count must not be materialised')
    assert.equal(pendingAsksOf({ pending: () => 3 }).asks[0]?.title, '通道只报告了数量：3 个提问在等人回答（通道没有给出标题）')
    assert.deepEqual(pendingAsksOf({ pending: () => 0 }), { asks: [], queryable: true })
    assert.equal(pendingAsksOf({ pending: () => Number.NaN }).queryable, false)
})

test('an unwritable ledger refuses BEFORE anything runs, and leaves no PASS', async () => {
    // Repro a6.mjs: the commands ran, the ledger row threw, and the newest
    // `dsh-deploy-gate` record stayed a PASS with no row behind it.
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const { store, missionId } = deliveredMission(h.stores, cwd)
    fs.mkdirSync(path.join(cwd, '.dsh', 'deployments.jsonl'), { recursive: true }) // the ledger path is a DIRECTORY
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /部署台账不可写/)
    assert.match(String(result.content), /未被触碰/)
    assert.deepEqual(callsOf(calls), [], 'nothing may run while its outcome cannot be recorded')
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'BLOCK')
    assert.equal(gate?.results[0]?.id, 'check:ledger-writable')
})

test('a ledger that breaks WHILE the commands run still never leaves a PASS without its row', async () => {
    // The pre-flight cannot cover a race, so the row write is guarded: the PASS
    // is immediately covered by a BLOCK naming what happened.
    const { cwd } = scriptRepo()
    const ledger = path.join(cwd, '.dsh', 'deployments.jsonl')
    fs.writeFileSync(
        path.join(cwd, 'scripts', 'sabotage.mjs'),
        `import fs from 'node:fs'\nfs.rmSync(${JSON.stringify(ledger)}, { recursive: true, force: true })\nfs.mkdirSync(${JSON.stringify(ledger)}, { recursive: true })\n`,
    )
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'sabotage'], { cwd })
    const h = harnessFor(cwd, { config: { environments: [stagingEnvironment({ deployCommands: ['node scripts/sabotage.mjs'] })] } })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'staging' })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /已经执行完了/)
    assert.match(String(result.content), /台账行写不进去/)
    const gates = store.readGates(missionId).filter((entry) => entry.source === 'dsh-deploy-gate')
    assert.equal(gates.at(-1)?.state, 'BLOCK', 'the newest record must be the BLOCK, never the rowless PASS')
    assert.match(gates.at(-1)?.reason ?? '', /台账行写不进去/)
})

test('deploy_verify refuses unless a successful deployment of THIS revision is live', async () => {
    // Repro a11.mjs(1): a verify-only PASS satisfied the orchestrator's
    // "部署已执行且通过" predicate.
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd)
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const refused = await h.run('deploy_verify', { environment: 'staging' })
    assert.equal(refused.isError, true)
    assert.match(String(refused.content), /没有环境 "staging" 的任何记录/)
    assert.match(String(refused.content), /deploy_verify 只能验证真的发生过的部署/)
    assert.deepEqual(callsOf(calls), [], 'a verification without a deployment must not run commands')
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    assert.deepEqual(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.map((row) => row.state), ['refused'])

    // Once something IS deployed, verification runs — and its retries carry
    // unique result ids. (A fresh repo: the flaky script must exist BEFORE the
    // delivery, or the receipt would bind a different revision.)
    const retries = scriptRepo({
        'scripts/flaky.mjs': `import fs from 'node:fs'\nconst marker = ${JSON.stringify(path.join('.dsh', 'v.txt'))}\nconst seen = fs.existsSync(marker) ? 1 : 0\nfs.writeFileSync(marker, 'x')\nprocess.exit(seen === 0 ? 1 : 0)\n`,
    })
    const after = harnessFor(retries.cwd, {
        config: { environments: [stagingEnvironment({ verifyCommands: ['node scripts/flaky.mjs'] })], verifyRetries: 2, verifyBackoffMs: 1 },
    })
    deliveredMission(after.stores, retries.cwd)
    const deployed = await after.text('deploy_run', { environment: 'staging' })
    assert.match(deployed, /### 部署执行：成功/)
    const verified = await after.text('deploy_verify', { environment: 'staging' })
    assert.match(verified, /✅ 裁决：PASS/)
    assert.match(verified, /实际尝试 2 次/)
    const verifiedGate = after.stores.for(retries.cwd).list()[0]
    const gate = verifiedGate === undefined ? undefined : after.stores.for(retries.cwd).lastGate(verifiedGate.id, { source: 'dsh-deploy-gate' })
    const ids = (gate?.results ?? []).map((entry) => entry.id)
    assert.equal(ids.length, 2)
    assert.equal(new Set(ids).size, ids.length, `result ids must be unique, got ${JSON.stringify(ids)}`)

    // A deployment the ledger no longer believes is live cannot be verified.
    const stale = scriptRepo()
    const h3 = harnessFor(stale.cwd)
    const fixture = deliveredMission(h3.stores, stale.cwd)
    await h3.text('deploy_run', { environment: 'staging' })
    await h3.text('deploy_rollback', { environment: 'staging' })
    const afterRollback = await h3.run('deploy_verify', { environment: 'staging' })
    assert.equal(afterRollback.isError, true)
    assert.match(String(afterRollback.content), /deploy_verify 只能验证真的发生过的部署/)
    assert.equal(fixture.missionId.length > 0, true)
})

test('a successful canary rollout records scope.full=true and unique result ids', async () => {
    // Repro a5.mjs: the canary `total` ignored the steps' verifyCommands (so
    // `full` was unreachable) and every sequence restarted its id counter.
    const { cwd, calls } = scriptRepo()
    const config = {
        environments: [
            stagingEnvironment({
                canary: {
                    steps: [
                        { percent: 10, command: 'node scripts/canary1.mjs', waitMs: 0, verifyCommands: ['node scripts/verify.mjs'] },
                        { percent: 50, command: 'node scripts/canary2.mjs', waitMs: 0 },
                    ],
                },
            }),
        ],
    }
    const h = harnessFor(cwd, { config })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'staging' })
    assert.match(text, /### 部署执行：成功/)
    assert.deepEqual(callsOf(calls), ['deploy', 'canary1', 'verify', 'canary2'])
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.equal(gate?.scope?.full, true, 'a fully successful rollout is a full rollout')
    assert.equal(gate?.scope?.total, 4, 'deploy + step1 + step1 verify + step2')
    assert.deepEqual(gate?.scope?.selected, ['deploy-1', 'canary-1-1', 'canary-1-verify-1', 'canary-2-1'])
    const ids = (gate?.results ?? []).map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length, `result ids must be unique, got ${JSON.stringify(ids)}`)
})

test('a workspace that moves while the approval card is open is refused, naming both observations', async () => {
    // Repro a4.mjs: the go/no-go verdict and the fingerprint were captured before
    // the approval, so the rewritten script ran under the old revision.
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, {
        config: { environments: [productionEnvironment({ deployCommands: ['node scripts/deploy.mjs {revision}'] })] },
        withApproval: false,
        services: {
            interaction: {
                ask: async () => {
                    fs.writeFileSync(path.join(cwd, 'late-change.txt'), 'someone kept working\n')
                    return { decision: 'allowed-once', by: 'alice', messageId: 'om_1' }
                },
                ...healthyInteraction(),
            },
        },
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'production' })
    assert.equal(result.isError, true)
    const message = String(result.content)
    assert.match(message, /审批已经通过，但批准之后工作区\/检查变了/)
    assert.match(message, /审批期间 revision 没有变化/)
    assert.match(message, /审批期间未提交改动数没有变化/)
    assert.deepEqual(callsOf(calls), [], 'the revision that was approved is the only one that may run')
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    assert.deepEqual(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.map((row) => row.state), ['refused'])
})

test('approval is driven through a mounted interaction channel registry (not just ask())', async () => {
    // Repro a10.mjs: the suite's own interaction layer provides register/send/
    // arm/awaitAnswer, NOT ask(), so production deploys refused while a working
    // IM channel was mounted.
    const { cwd, calls } = scriptRepo()
    const cards: Record<string, unknown>[] = []
    const armed: string[] = []
    const channel = { name: 'im', send: async () => ({ ok: true, messageId: 'card-1' }), wait: async () => null, describe: () => ({ canAsk: true, canNotify: true }) }
    const registry = {
        list: () => [{ name: 'im', canAsk: true, canNotify: true, reason: '', order: 0 }],
        get: (name: string) => (name === 'im' ? channel : undefined),
        arm: (questionId: string) => {
            armed.push(questionId)
            return true
        },
        retire: () => undefined,
        send: async (_name: string, message: Record<string, unknown>) => {
            cards.push(message)
            return { ok: true, messageId: 'card-1' }
        },
        awaitAnswer: async () => ({ outcome: 'answered', answer: { value: 'yes', by: 'alice', messageId: 'card-1' } }),
        pending: () => [],
        ledgers: () => ['/repo/.dsh/interaction/decisions.jsonl'],
    }
    const h = harnessFor(cwd, { config: { environments: [productionEnvironment()] }, withApproval: false, services: { interaction: registry } })
    const { missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'production' })
    assert.match(text, /### 部署执行：成功/)
    assert.match(text, /审批：alice/)
    assert.deepEqual(callsOf(calls), ['deploy'])
    assert.equal(cards.length, 1, 'the card must reach the channel')
    assert.equal(cards[0]?.['questionId'], armed[0])
    assert.match(String(cards[0]?.['body']), /部署审批/)
    const row = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)
    assert.equal(row?.approvedBy, 'alice')
    assert.equal(row?.approvalMessageId, 'card-1')
    assert.equal(h.stores.for(cwd).lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')
})

test('a mounted interaction service with no usable channel refuses loudly, naming what it tried', async () => {
    const { cwd, calls } = scriptRepo()
    const registry = {
        list: () => [{ name: 'im', canAsk: false, canNotify: true, reason: '未实现 wait()，只能推送不能收答案', order: 0 }],
        arm: () => true,
        send: async () => ({ ok: true }),
        awaitAnswer: async () => ({ outcome: 'timeout', answer: null }),
        // The go/no-go check must be able to READ the pending-ask fact, or it
        // refuses before the approval path this test is about is reached.
        ...healthyInteraction(),
    }
    const h = harnessFor(cwd, { config: { environments: [productionEnvironment()] }, withApproval: false, services: { interaction: registry } })
    deliveredMission(h.stores, cwd)
    const result = await h.run('deploy_run', { environment: 'production' })
    assert.equal(result.isError, true)
    const message = String(result.content)
    assert.match(message, /interaction 服务注册了 1 个通道，但没有一个能提问/)
    assert.match(message, /canAsk=false/)
    assert.match(message, /未实现 wait\(\)/)
    assert.match(message, /下一步（任选其一）：让该通道实现 wait\(\)/)
    assert.deepEqual(callsOf(calls), [], 'no usable channel means no command may run')
})

test('an approval timeout through the channel registry is a REFUSAL, never a consent', async () => {
    const { cwd, calls } = scriptRepo()
    const registry = {
        list: () => [{ name: 'im', canAsk: true, canNotify: true, reason: '', order: 0 }],
        get: () => undefined,
        arm: () => true,
        send: async () => ({ ok: true, messageId: 'card-7' }),
        awaitAnswer: async () => ({ outcome: 'timeout', answer: null }),
        ...healthyInteraction(),
    }
    const h = harnessFor(cwd, { config: { environments: [productionEnvironment()] }, withApproval: false, services: { interaction: registry } })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const text = await h.text('deploy_run', { environment: 'production' })
    assert.match(text, /### 未执行部署/)
    assert.match(text, /超时\*\*不是\*\*拒绝、也\*\*不是\*\*同意/)
    assert.deepEqual(callsOf(calls), [])
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    assert.deepEqual(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.map((row) => row.state), ['refused'])
})

// --- verification approval (follow-up audit: deploy_verify ran host commands
// --- with no approval at all, in the same environment deploy_run guards) ----

test('config: verifyRequiresApproval defaults to the environment rule, never to "skip the human"', () => {
    const host = resolveConfig({ environments: [stagingEnvironment(), productionEnvironment()] })
    const staging = host.environments.find((environment) => environment.name === 'staging') as never
    const production = host.environments.find((environment) => environment.name === 'production') as never
    assert.equal(verifyNeedsApproval(host, staging), false, 'an explicitly declared staging environment needs nobody for a deploy or a verify')
    assert.equal(verifyNeedsApproval(host, production), true, 'production needs a person for BOTH')
    assert.equal(verifyNeedsApproval({ ...host, verifyApproval: 'always' }, staging), true)
    assert.equal(verifyNeedsApproval({ ...host, verifyApproval: 'never' }, production), false, 'only the host may switch it off')

    // An unusable value falls back to "follow requiresApproval" — NOT to false.
    const problems: string[] = []
    const explicit = resolveConfig(
        { environments: [stagingEnvironment({ verifyRequiresApproval: true }), productionEnvironment({ verifyRequiresApproval: 'yes' })] },
        (message) => problems.push(message),
    )
    assert.equal(explicit.environments[0]?.verifyRequiresApproval, true)
    assert.equal(explicit.environments[1]?.verifyRequiresApproval, undefined)
    assert.equal(verifyNeedsApproval(explicit, explicit.environments[1] as never), true)
    assert.ok(problems.some((problem) => /verifyRequiresApproval/.test(problem)), JSON.stringify(problems))

    // An unknown host rule is reported and falls back to the default.
    const bad: string[] = []
    assert.equal(resolveConfig({ verifyApproval: 'sometimes' }, (message) => bad.push(message)).verifyApproval, 'environment')
    assert.ok(bad.some((problem) => /verifyApproval/.test(problem)), JSON.stringify(bad))
})

test('config: the verification rule is monotone — a project may add it, never remove it', () => {
    const cwd = tempWorkspace('deploy-gate-verify-approval-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const file = path.join(cwd, '.dsh', 'deploy-gate.json')
    const host = resolveConfig({ environments: [stagingEnvironment(), productionEnvironment()] })

    // A project entry may TIGHTEN staging's verification…
    fs.writeFileSync(file, JSON.stringify({ environments: [{ name: 'staging', verifyRequiresApproval: true }] }))
    const tightened = resolveEffectiveConfig(host, resolveLayout(cwd))
    const staging = tightened.config.environments.find((environment) => environment.name === 'staging') as never
    assert.equal(verifyNeedsApproval(tightened.config, staging), true)

    // …but it may not switch production's verification approval off.
    fs.writeFileSync(file, JSON.stringify({ environments: [{ name: 'production', verifyRequiresApproval: false }] }))
    const loosened = resolveEffectiveConfig(host, resolveLayout(cwd))
    const production = loosened.config.environments.find((environment) => environment.name === 'production') as never
    assert.equal(production.verifyRequiresApproval, true, 'the profile requirement stays authoritative')
    assert.equal(verifyNeedsApproval(loosened.config, production), true)
    assert.ok(
        loosened.problems.some((problem) => /verifyRequiresApproval 不能由项目级配置关闭/.test(problem)),
        JSON.stringify(loosened.problems),
    )
})

test('config: verifyApproval tightens from a project file, and "never" is refused there', () => {
    const cwd = tempWorkspace('deploy-gate-verify-approval2-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    const file = path.join(cwd, '.dsh', 'deploy-gate.json')
    const host = resolveConfig({ environments: [stagingEnvironment(), productionEnvironment()] })

    fs.writeFileSync(file, JSON.stringify({ verifyApproval: 'always' }))
    const always = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(always.config.verifyApproval, 'always')
    assert.equal(verifyNeedsApproval(always.config, always.config.environments[0] as never), true, 'always forces a human everywhere')

    // The loosening value is host-only: a project writing it is refused and the
    // profile value is kept (the same discipline as approversFile).
    fs.writeFileSync(file, JSON.stringify({ verifyApproval: 'never' }))
    const refused = resolveEffectiveConfig(host, resolveLayout(cwd))
    assert.equal(refused.config.verifyApproval, 'environment')
    assert.equal(refused.source, 'profile')
    assert.ok(refused.problems.some((problem) => /verifyApproval 不能设为 'never'/.test(problem)), JSON.stringify(refused.problems))
    assert.ok(refused.problems.some((problem) => /宿主专属/.test(problem)), JSON.stringify(refused.problems))

    // 'environment' would also relax a host that chose 'always'.
    const strictHost = resolveConfig({ verifyApproval: 'always', environments: [stagingEnvironment()] })
    fs.writeFileSync(file, JSON.stringify({ verifyApproval: 'environment' }))
    const relaxed = resolveEffectiveConfig(strictHost, resolveLayout(cwd))
    assert.equal(relaxed.config.verifyApproval, 'always')
    assert.ok(relaxed.problems.some((problem) => /只接受收紧值 'always'/.test(problem)), JSON.stringify(relaxed.problems))
})

test('deploy_verify asks the SAME human as deploy_run, and records the approver', async () => {
    const { cwd, calls } = scriptRepo()
    const cards: Record<string, unknown>[] = []
    const registry = {
        list: () => [{ name: 'im', canAsk: true, canNotify: true, reason: '', order: 0 }],
        get: () => undefined,
        arm: () => true,
        send: async (_name: string, message: Record<string, unknown>) => {
            cards.push(message)
            return { ok: true, messageId: `card-${cards.length}` }
        },
        awaitAnswer: async () => ({ outcome: 'answered', answer: { value: 'yes', by: 'alice', messageId: 'card-1' } }),
        ...healthyInteraction(),
    }
    const h = harnessFor(cwd, { config: { environments: [productionEnvironment()] }, withApproval: false, services: { interaction: registry } })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const deployed = await h.text('deploy_run', { environment: 'production' })
    assert.match(deployed, /### 部署执行：成功/)
    const verified = await h.text('deploy_verify', { environment: 'production' })
    assert.match(verified, /✅ 裁决：PASS/)
    assert.equal(cards.length, 2, 'one card for the deploy, one for the verification')
    assert.match(String(cards[1]?.['body']), /部署后验证审批/)
    assert.match(JSON.stringify(cards[1]?.['buttons']), /批准验证/)
    assert.deepEqual(callsOf(calls), ['deploy', 'verify'])

    // The approver is recorded where an audit reads it: the ledger row AND the
    // gate reason of the verification (not only the deploy).
    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.deepEqual(rows.map((row) => row.state), ['deployed', 'verified'])
    assert.equal(rows[1]?.approvedBy, 'alice')
    assert.equal(rows[1]?.approvalMessageId, 'card-1')
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'PASS')
    assert.match(gate?.reason ?? '', /审批 alice/)
})

test('a verification nobody approved is NOT run: refused row + BLOCK naming it', async () => {
    const { cwd, calls } = scriptRepo()
    let answer = 'yes'
    const h = harnessFor(cwd, {
        config: { environments: [productionEnvironment()] },
        withApproval: false,
        services: {
            interaction: {
                ask: async () => ({ answer, by: 'alice', messageId: 'om_1' }),
                ...healthyInteraction(),
            },
        },
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    const deployed = await h.text('deploy_run', { environment: 'production' })
    assert.match(deployed, /### 部署执行：成功/)

    answer = 'no'
    const refused = await h.text('deploy_verify', { environment: 'production' })
    assert.match(refused, /### 未执行部署后验证/)
    assert.match(refused, /人工审批被拒绝/)
    assert.deepEqual(callsOf(calls), ['deploy'], 'a refused verification must not run its commands')

    const rows = readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows
    assert.deepEqual(rows.map((row) => row.state), ['deployed', 'refused'])
    assert.match(rows[1]?.note ?? '', /验证未执行/)
    const gate = store.lastGate(missionId, { source: 'dsh-deploy-gate' })
    assert.equal(gate?.state, 'BLOCK', 'the newest record must never stay the deploy PASS')
    assert.equal(gate?.results[0]?.id, 'check:verify-not-approved')
    assert.match(gate?.reason ?? '', /没有人批准/)
    assert.match(gate?.reason ?? '', /验证未执行/)
    assert.match(gate?.results[0]?.output ?? '', /需要人工批准/)
})

test('verifyApproval=always forces a human for a staging verification; no channel is a loud refusal', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, {
        config: { environments: [stagingEnvironment()], verifyApproval: 'always' },
        approvalOutcome: 'allowed-once',
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    assert.match(await h.text('deploy_run', { environment: 'staging' }), /### 部署执行：成功/)
    assert.equal(h.host.approvalRequests.length, 0, 'staging itself needs no approval to deploy')
    const verified = await h.text('deploy_verify', { environment: 'staging' })
    assert.match(verified, /✅ 裁决：PASS/)
    assert.equal(h.host.approvalRequests.length, 1, 'verifyApproval=always must ask even where a deploy would not')
    assert.equal((h.host.approvalRequests[0] as { toolName?: string }).toolName, 'deploy_verify')
    assert.match(String((h.host.approvalRequests[0] as { reason?: string }).reason), /部署后验证审批/)
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')

    // No approval channel at all: refuse loudly, run nothing, leave a BLOCK.
    const forced = scriptRepo()
    const h2 = harnessFor(forced.cwd, {
        config: { environments: [stagingEnvironment()], verifyApproval: 'always' },
        withApproval: false,
        services: {},
    })
    const fixture = deliveredMission(h2.stores, forced.cwd)
    // The go/no-go check needs an observable pending-ask fact before the
    // verification path is reached: assert that FIRST, then the approval refusal.
    const blockedByAsks = await h2.run('deploy_run', { environment: 'staging' })
    assert.equal(blockedByAsks.isError, true)
    assert.match(String(blockedByAsks.content), /无法确认有没有人在等回答/)

    const noChannel = scriptRepo()
    const h3 = harnessFor(noChannel.cwd, {
        config: { environments: [stagingEnvironment()], verifyApproval: 'always' },
        withApproval: false,
    })
    const live = deliveredMission(h3.stores, noChannel.cwd)
    // A live deployment must exist first (deploy_run itself is gated by the
    // forced verification approval, so use the ledger directly).
    appendLedgerRow(path.join(noChannel.cwd, '.dsh', 'deployments.jsonl'), {
        at: Date.now(),
        id: 'DPL-fixture-1',
        environment: 'staging',
        revision: live.fingerprint.isRepo ? `main@${(live.fingerprint.head ?? '').slice(0, 8)} +0 changed (diff ${(live.fingerprint.diffDigest ?? '').slice(0, 8)})` : '',
        deployer: 'session-1',
        state: 'deployed',
    })
    const result = await h3.run('deploy_verify', { environment: 'staging' })
    assert.equal(result.isError, true)
    const message = String(result.content)
    assert.match(message, /需要人工批准才能验证/)
    assert.match(message, /ctx\.approval/)
    assert.match(message, /verifyRequiresApproval/, 'the refusal must name the key that decides it')
    assert.deepEqual(callsOf(noChannel.calls), [], 'no approval channel means no command may run')
    assert.equal(h3.stores.for(noChannel.cwd).lastGate(live.missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    assert.equal(readLedger(path.join(noChannel.cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)?.state, 'refused')
    assert.equal(fixture.missionId.length > 0, true)
})

test('verifyApproval=never is a HOST decision: production verifies without asking', async () => {
    const { cwd, calls } = scriptRepo()
    const h = harnessFor(cwd, {
        config: { environments: [productionEnvironment()], verifyApproval: 'never' },
        approvalOutcome: 'allowed-once',
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    assert.match(await h.text('deploy_run', { environment: 'production' }), /### 部署执行：成功/)
    assert.equal(h.host.approvalRequests.length, 1, 'the DEPLOY still needs a human')
    const verified = await h.text('deploy_verify', { environment: 'production' })
    assert.match(verified, /✅ 裁决：PASS/)
    assert.match(verified, /审批：验证无需人工批准（verifyApproval='never'/)
    assert.equal(h.host.approvalRequests.length, 1, 'the host switched verification approval off')
    assert.deepEqual(callsOf(calls), ['deploy', 'verify'])
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'PASS')
})

test('deploy_verify enforces the SAME approver allowlist as deploy_run', async () => {
    const { cwd, calls } = scriptRepo()
    fs.writeFileSync(path.join(cwd, 'APPROVERS'), '# who may approve\nzhangyong\n')
    execFileSync('git', ['add', '-A'], { cwd })
    execFileSync('git', ['commit', '-qm', 'approvers'], { cwd })
    let by = 'zhangyong'
    const h = harnessFor(cwd, {
        config: { environments: [productionEnvironment({ approversFile: 'APPROVERS' })] },
        withApproval: false,
        services: { interaction: { ask: async () => ({ answer: 'yes', by, messageId: 'om_1' }), ...healthyInteraction() } },
    })
    const { store, missionId } = deliveredMission(h.stores, cwd)
    assert.match(await h.text('deploy_run', { environment: 'production' }), /### 部署执行：成功/)
    by = 'feishu:ou_stranger'
    const refused = await h.text('deploy_verify', { environment: 'production' })
    assert.match(refused, /### 未执行部署后验证/)
    assert.match(refused, /不在名单/)
    assert.deepEqual(callsOf(calls), ['deploy'], 'an unlisted approver must not run the verification either')
    assert.equal(store.lastGate(missionId, { source: 'dsh-deploy-gate' })?.state, 'BLOCK')
    assert.equal(readLedger(path.join(cwd, '.dsh', 'deployments.jsonl')).rows.at(-1)?.state, 'refused')
})

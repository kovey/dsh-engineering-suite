/**
 * Tests for `/suite`'s report presentation (`render-report.ts`), following the
 * accepted test design TC-1610 … TC-1615.
 *
 * TC-1616 is the VERIFICATION-level case (`bash scripts/verify.sh --quiet`
 * twice, both exit 0). Per the team's iteration rule this package run does not
 * execute the full verify suite; the delivery gate still runs the full command.
 *
 * The invariants pinned here are the ones that make the float safe to add:
 *
 *  - **one report, two surfaces** — the float body and the text fallback come
 *    from the same `layoutReport`, so they cannot drift apart;
 *  - **the command never depends on the UI** — no service, headless, a service
 *    without `ui.float`, and a rejected `float()` all still return success;
 *  - **hard readability bounds** — every line ≤100 chars, key numbers in the
 *    first line, blank lines between groups, ≤24 lines before the fold note;
 *  - **the feed keeps a record** — a one-line summary on the float path (plus
 *    the full text when it was folded, so `（完整文本见 feed）` is true);
 *  - **`help` stays text** — the usage must never disappear into a float.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { clearProjectConfigCache, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { runSuiteHealth, renderSuiteHealth } from '../dist/health.js'
import { layoutReport, showReport } from '../dist/render-report.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

/** A log file outside the workspace: these tests never write into the repo. */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-render-log-'), 'suite-doctor.log')
}

/** A throwaway repository. */
function repo(files: Record<string, string> = {}): string {
    const cwd = tempWorkspace('suite-render-')
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
    return cwd
}

type FloatCall = { title?: string; lines: string[]; width?: number; height?: number }

/** A structural fake of nvim-tui's OPTIONAL surface, recording every call. */
function floatRecorder(options: { headless?: boolean; fail?: boolean } = {}): {
    tui: { capabilities: () => Record<string, boolean>; ui: { float: (call: FloatCall) => Promise<unknown>; floatClose: (id: string) => Promise<void> } }
    calls: FloatCall[]
    closed: string[]
} {
    const calls: FloatCall[] = []
    const closed: string[] = []
    let sequence = 0
    return {
        calls,
        closed,
        tui: {
            capabilities: () => ({ headless: options.headless === true, float: true }),
            ui: {
                float: async (call: FloatCall) => {
                    calls.push(call)
                    if (options.fail === true) throw new Error('nvim 通道中断')
                    sequence += 1
                    return { id: `f${sequence}`, win: sequence, buf: sequence }
                },
                floatClose: async (id: string) => {
                    closed.push(id)
                },
            },
        },
    }
}

type CommandResult = { kind: 'success' | 'error'; text: string }

interface CommandHarness {
    run: (rawInput: string) => Promise<CommandResult>
}

/** A structural fake of `ctx.get('commands')`, recording the definition. */
function registryOf(): { service: { register: (definition: { name: string; handler: (invocation: unknown) => unknown }) => () => void }; definitions: { name: string; handler: (invocation: unknown) => unknown }[] } {
    const definitions: { name: string; handler: (invocation: unknown) => unknown }[] = []
    return {
        definitions,
        service: {
            register(definition) {
                definitions.push(definition)
                return () => undefined
            },
        },
    }
}

/** Assemble the plugin with a command registry and optional host services. */
function commandHost(cwd: string, services: Record<string, unknown> = {}): CommandHarness {
    const registry = registryOf()
    const fake = createFakeHost({ cwd, services: { commands: registry.service, ...services } })
    hosts.push(fake)
    clearProjectConfigCache()
    apply(fake.ctx as never, { logFile: logFileFor() })
    const definition = registry.definitions[0]
    assert.ok(definition, '/suite must be registered when the registry is mounted')
    return { run: async (rawInput: string) => (await definition.handler({ agent: fake.agent, rawInput })) as CommandResult }
}

/** The width bound is in code points, so emoji count as one character. */
function widthOf(line: string): number {
    return Array.from(line).length
}

test('TC-1610: layoutReport bounds every line to 100 chars and puts the numbers on line one', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const report = renderSuiteHealth(runSuiteHealth({ cwd, layout: resolveLayout(cwd) }))
    const layout = layoutReport(report)

    assert.equal(layout.title, 'suite · doctor')
    assert.ok(layout.lines.length > 1, 'the doctor report must not collapse into one line')
    for (const line of layout.lines) assert.ok(widthOf(line) <= 100, `line wider than 100: ${JSON.stringify(line)}`)
    assert.match(layout.lines[0] ?? '', /^suite · doctor · 汇总：/, 'line one is the summary')
    assert.match(layout.lines[0] ?? '', /ok \d+/, 'the summary carries the ok count')
    assert.match(layout.lines[0] ?? '', /missing \d+/, 'the summary carries the missing count')
    assert.equal(layout.lines[1], '', 'the summary is followed by a blank line')
    assert.ok(layout.lines.includes(''), 'groups are separated by blank lines')

    // A single very long line is wrapped (never returned wider than the bound).
    const long = `/suite show —— 门禁配置（只读）\n${'明细'.repeat(120)}\n`
    const wrapped = layoutReport(long)
    assert.ok(wrapped.lines.length > 2, 'the long line was wrapped')
    for (const line of wrapped.lines) assert.ok(widthOf(line) <= 100, `wrapped line too wide: ${JSON.stringify(line)}`)
    assert.ok(wrapped.lines.slice(1).some((line) => line.length > 0), 'the long line came through')
})

test('TC-1610: layoutReport derives the sub-command title from the report head', () => {
    assert.equal(layoutReport('suite_init —— 套件配置脚手架\n').title, 'suite · init')
    assert.equal(layoutReport('suite_config —— 门禁配置（只读）\n').title, 'suite · show')
    assert.equal(layoutReport('/suite set quality-gate defaultTimeoutMs\n').title, 'suite · set')
    assert.equal(layoutReport('/suite edit quality-gate —— 已打开\n').title, 'suite · edit')
})

test('TC-1611: with nvim-tui, /suite doctor opens a float with the right title and bounds', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { tui, calls, closed } = floatRecorder()
    const { run } = commandHost(cwd, { 'nvim-tui': tui })

    const first = await run(' doctor')
    assert.equal(first.kind, 'success')
    assert.equal(calls.length, 1, 'exactly one float opened')
    const call = calls[0] as FloatCall
    assert.equal(call.title, 'suite · doctor')
    assert.equal(call.width, 88)
    assert.equal(call.height, Math.min(call.lines.length + 2, 24))
    assert.ok(call.lines.length <= 24, 'the float body is bounded')
    assert.ok(call.lines.includes(''), 'the float body keeps the blank-line groups')
    assert.match(call.lines[0] ?? '', /^suite · doctor · /)
    assert.equal(first.text.split('\n')[0], call.lines[0], 'the feed keeps the same summary line')
    assert.match(call.lines[call.lines.length - 1] ?? '', /^…另有 \d+ 行（完整文本见 feed）$/)
    assert.match(first.text, /\/suite doctor —— 套件配置体检/, 'the folded full text follows in the feed')
    assert.ok(call.lines.some((line) => /config\.quality-gate/.test(line)), 'the body carries the checks')

    // A second invocation replaces the previous report float (never stacks).
    const second = await run(' doctor')
    assert.equal(second.kind, 'success')
    assert.equal(calls.length, 2)
    assert.deepEqual(closed, ['f1'], 'the previous float is closed before the new one')
})

test('TC-1612: /suite show keeps the summary as the first feed line, from the same report as the float', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { tui, calls } = floatRecorder()
    const { run } = commandHost(cwd, { 'nvim-tui': tui })

    const result = await run(' show')
    assert.equal(result.kind, 'success')
    const call = calls[0] as FloatCall
    const feed = result.text.split('\n')
    assert.equal(feed[0], call.lines[0], 'feed summary and float body share the report')
    assert.equal(result.text.split('\n')[1] !== undefined, true, 'the folded full text follows the summary')
    assert.match(feed[0] ?? '', /\d+ 份/, 'the summary carries the plugin/file count')
    assert.match(feed[0] ?? '', /问题 \d+ 条/, 'the summary carries the problem count')
    assert.match(result.text, /suite_config —— 门禁配置（只读）/, 'the complete report is still in the feed')

    // A short report (no fold) is a one-line feed record — the float carries it.
    const short = await run(' edit quality-gate')
    assert.equal(short.kind, 'success')
    assert.equal(short.text.split('\n').length, 1, 'a short report stays a single feed line')
})

test('TC-1611: every sub-command reports under its own float title', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { tui, calls } = floatRecorder()
    const { run } = commandHost(cwd, { 'nvim-tui': tui })

    const invocations = [' init', ' show', ' doctor', ' init --apply --only quality', ' set quality-gate defaultTimeoutMs 60000 --dry-run', ' unset quality-gate defaultTimeoutMs --dry-run', ' edit quality-gate']
    for (const input of invocations) {
        const result = await run(input)
        assert.equal(result.kind, 'success', `/suite${input} must succeed`)
    }
    assert.deepEqual(
        calls.map((call) => call.title),
        ['suite · init', 'suite · show', 'suite · doctor', 'suite · init', 'suite · set', 'suite · unset', 'suite · edit'],
    )
})

test('TC-1613: without nvim-tui the same report falls back to multi-line text', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { run } = commandHost(cwd)
    const result = await run(' doctor')
    assert.equal(result.kind, 'success')
    assert.ok(result.text.split('\n').length > 3, 'the fallback keeps the multi-line report')
    assert.match(result.text, /汇总：/)
    assert.match(result.text, /config\.quality-gate/)

    // A service WITHOUT ui.float/floatClose is not a float surface either.
    const legacy = commandHost(repo({ 'tsconfig.json': '{}' }), { 'nvim-tui': { nvim: { lua: async () => true } } })
    const legacyResult = await legacy.run(' show')
    assert.equal(legacyResult.kind, 'success')
    assert.match(legacyResult.text, /^suite_config —— 门禁配置（只读）/, 'the original report text, unchanged')
})

test('TC-1614: a rejected ui.float falls back to text and the command still succeeds', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { tui, calls } = floatRecorder({ fail: true })
    const { run } = commandHost(cwd, { 'nvim-tui': tui })

    const result = await run(' show')
    assert.equal(result.kind, 'success')
    assert.equal(calls.length, 1, 'the float was attempted')
    assert.match(result.text, /^suite_config —— 门禁配置（只读）/, 'the full text came back')
    assert.ok(result.text.split('\n').length > 3)

    // The service accessor itself refusing is also a fallback, not a command failure.
    const direct = await showReport({ get: () => { throw new Error('host 崩了') } }, 'suite · doctor', '第一行\n第二行\n')
    assert.deepEqual(direct, { kind: 'success', text: '第一行\n第二行\n' })
})

test('TC-1613: a headless host falls back to text and never opens a float', async () => {
    const { tui, calls } = floatRecorder({ headless: true })
    const cwd = repo({ 'tsconfig.json': '{}' })
    const report = renderSuiteHealth(runSuiteHealth({ cwd, layout: resolveLayout(cwd) }))
    const result = await showReport({ get: () => tui }, 'suite · doctor', report)
    assert.equal(result.kind, 'success')
    assert.equal(calls.length, 0, 'headless must not open a float')
    assert.equal(result.text, report, 'headless gets the very same report text')
})

test('TC-1615: a 200-line report folds to 24 lines, names the count, and keeps the full text in the feed', async () => {
    const body = Array.from({ length: 200 }, (_, index) => `✅ check ${String(index).padStart(3, '0')}：这一行是明细`)
    const text = ['/suite doctor —— 套件配置体检', ...body, ''].join('\n')
    const layout = layoutReport(text)

    assert.ok(layout.folded > 0, 'the report was folded')
    assert.ok(layout.lines.length <= 24, 'the float body is bounded by 24 lines')
    const last = layout.lines[layout.lines.length - 1] ?? ''
    assert.match(last, /^…另有 \d+ 行（完整文本见 feed）$/)
    const named = Number(/^…另有 (\d+) 行/.exec(last)?.[1])
    assert.equal(named, layout.folded, 'the note names the folded line count')

    const { tui, calls } = floatRecorder()
    const result = await showReport({ get: () => tui }, 'suite · doctor', text)
    assert.equal(calls.length, 1)
    assert.equal((calls[0] as FloatCall).lines.length, layout.lines.length)
    const feed = result.text.split('\n')
    assert.equal(feed[0], layout.summary, 'the feed starts with the one-line summary')
    assert.ok(result.text.split('\n').length > 100, 'the folded lines are still readable in the feed')
    assert.match(result.text, /check 199/, 'the last folded line is in the feed')
})

test('help stays plain multi-line text and never opens a float', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { tui, calls } = floatRecorder()
    const { run } = commandHost(cwd, { 'nvim-tui': tui })

    for (const input of [' help', '']) {
        const result = await run(input)
        assert.equal(result.kind, 'success')
        assert.match(result.text, /用法：/)
        assert.match(result.text, /\n {2}\/suite init/)
    }
    assert.equal(calls.length, 0, 'the usage text is not a float report')
})

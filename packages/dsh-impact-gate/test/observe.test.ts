/**
 * Shadow mode (`observe`) is NOT APPLICABLE to `dsh-impact-gate` — the decision
 * record, as an executable statement.
 *
 * The suite's other gates own a RULE LIST that produces a `PASS`/`WARN`/`BLOCK`
 * verdict, so a rule may be marked `observe` and its would-be verdict recorded
 * instead of enforced. This plugin has no such list:
 *
 *  1. its output is a RISK CLASSIFICATION (`low` / `medium` / `high` /
 *     `unknown`) plus a selected-test command; it records an `artifact` evidence
 *     row, never a gate record;
 *  2. its thresholds (`RISK_RULES`) are a frozen constant in `dsh-eng-core`, not
 *     a per-host or per-repository rule entry — there is no rule object a `mode`
 *     could attach to, and inventing one would be inventing the feature;
 *  3. no gate consumes `risk`, so a shadow classification would change nobody's
 *     verdict — it would be a measurement with no ratchet and no veto to switch.
 *
 * Tests hold that decision in place: if a future change gives this plugin a
 * verdict (a gate record with a `state`), these assertions fail, and the shadow
 * wiring has to be reconsidered deliberately instead of appearing by accident.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, RISK_RULES } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { PROJECT_OVERRIDABLE_KEYS, resolveConfig } from '../dist/config.js'

const hosts: FakeHost[] = []

/** Log files live outside the workspace so they never look like a change. */
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-gate-observe-logs-'))

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

function host(cwd: string): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(LOG_DIR, `${hosts.length}.log`) })
    return fake
}

/** A workspace with one file and one test that covers it (no git needed: `paths` mode). */
function fixture(): string {
    const cwd = tempWorkspace('impact-observe-')
    fs.mkdirSync(path.join(cwd, 'src', 'store'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'store', 'store.ts'), 'export function save(): number {\n    return 1\n}\n')
    fs.writeFileSync(
        path.join(cwd, 'src', 'store', 'store.test.ts'),
        "import { save } from './store.ts'\n\ntest('save', () => {\n    save()\n})\n",
    )
    return cwd
}

function bindMission(cwd: string): ReturnType<MissionStoreRegistry['for']> {
    const store = new MissionStoreRegistry().for(cwd)
    store.create({ id: 'm1', title: '影响分析', cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm1')
    return store
}

test('impact-gate records no gate verdict, so there is no rule mode to wire (decision record)', async () => {
    const cwd = fixture()
    const store = bindMission(cwd)
    const fake = host(cwd)

    const text = runText(await fake.runTool('impact_analyze', { paths: 'src/store/store.ts' }))
    // The output is a RISK CLASSIFICATION, not a verdict.
    assert.match(text, /风险：(高|中|低)（(high|medium|low)）/)
    assert.doesNotMatch(text, /\bBLOCK\b|\bPASS\b|\bWARN\b/, 'no pass/block token is produced at all')

    // Nothing to enforce and nothing to observe: no gate record exists, and the
    // only durable trace is the artifact evidence row.
    assert.deepEqual(store.readGates('m1'), [], 'impact-gate never records a gate')
    const evidence = store.readEvidence('m1')
    assert.ok(evidence.length > 0)
    assert.deepEqual([...new Set(evidence.map((row) => row.kind))], ['artifact'])
    // …and the mission ledger holds no `observations` field to read either.
    assert.equal(
        evidence.some((row) => 'observations' in (row.data as Record<string, unknown>)),
        false,
    )

    // The thresholds are a CODE constant, not a rule entry a `mode` could attach to.
    assert.equal(RISK_RULES.highFanIn > 0, true)
    const resolved = resolveConfig({ riskRules: { highFanIn: 1 }, mode: 'observe' }) as unknown as Record<string, unknown>
    assert.equal('riskRules' in resolved, false, 'a threshold override is not a configuration key')
    assert.equal('mode' in resolved, false, 'there is no top-level mode either')
    assert.equal(
        PROJECT_OVERRIDABLE_KEYS.some((key) => key === 'mode' || key === 'rules' || key === 'riskRules'),
        false,
        'a project may not hand itself a shadow form of anything here',
    )
})

test('the only decision this plugin makes is a REFUSAL, which is not a verdict either', async () => {
    const cwd = fixture()
    const store = bindMission(cwd)
    const fake = host(cwd)

    // No `testCommandTemplate` configured → refuse, loudly, instead of guessing a
    // runner. A refusal is not a PASS/WARN/BLOCK, so it is not a rule mode either.
    const refused = await fake.runTool('impact_tests', {})
    assert.equal(refused.isError, true)
    assert.match(runText(refused), /testCommandTemplate/)
    assert.deepEqual(store.readGates('m1'), [])
})

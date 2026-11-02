/**
 * The writer discipline, checked: `ledger.writers`.
 *
 * Every state kind under `.dsh/` has exactly ONE writer (see `writers.ts`). A
 * read-only scan can catch a foreign writer, a missing field, a duplicated fact
 * and an unexpected file — and it must say what it CANNOT catch (a well-formed
 * lie), which is why the tests below assert the wording of that boundary too.
 *
 * The fixtures are hand-written mission artifacts on purpose: a check that only
 * ever sees records the real writers produced can never be shown to FIRE.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkWorkspace, renderWriterTable, WRITERS, KNOWN_GATE_IDS, type DoctorCheck, type WriterFinding } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

const POLICY = 'a'.repeat(64)

/** One documented mission record (the shape `MissionStore` writes). */
function mission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'M-1',
        title: '自检任务',
        status: 'spec-approved',
        cwd: '/tmp/workspace',
        createdAt: 1_000,
        updatedAt: 2_000,
        mandate: {
            version: 1,
            strength: 'explicit',
            basis: 'spec-approved',
            scope: { phases: [], paths: [] },
            policyVersion: POLICY,
            approvedBy: 'alice',
            at: 2_000,
        },
        ...overrides,
    }
}

/** The write-once approval-time fingerprint snapshot. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { version: POLICY, files: [], ...overrides }
}

/** One gate record as a gate plugin writes it. */
function gate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'GATE-1', missionId: 'M-1', source: 'dsh-quality-gate', state: 'PASS', checkedAt: 3_000, reason: '全部通过', results: [], ...overrides }
}

/** One receipt as the evidence gate issues it. */
function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'RCP-1', missionId: 'M-1', issuedAt: 4_000, issuedBy: 'dsh-evidence-gate', digest: 'd', gateId: 'GATE-1', evidenceIds: [], ...overrides }
}

/** One evidence row as a plugin appends it. */
function evidenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'EV-1', missionId: 'M-1', kind: 'test', summary: 'go test ./...', recordedAt: 3_500, recordedBy: 'dsh-quality-gate', ...overrides }
}

/** Write one JSON file, creating its directory. */
function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Write a JSONL file from rows (a row that is already a string is written verbatim). */
function writeJsonl(file: string, rows: unknown[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
}

/**
 * A trail whose every artifact was written by its documented writer: the
 * baseline every rule is compared against.
 */
function cleanTrail(): string {
    const cwd = tempWorkspace('writers-clean-')
    const missionDir = path.join(cwd, '.dsh', 'missions', 'M-1')
    writeJson(path.join(missionDir, 'mission.json'), mission())
    writeJson(path.join(missionDir, 'policy-fingerprint.json'), snapshot())
    writeJson(path.join(missionDir, 'gates', 'GATE-1.json'), gate())
    writeJson(path.join(missionDir, 'receipts', 'RCP-1.json'), receipt())
    writeJsonl(path.join(missionDir, 'evidence.jsonl'), [evidenceRow()])
    return cwd
}

/** The `ledger.writers` check of one workspace. */
function writers(cwd: string): DoctorCheck {
    const check = checkWorkspace({ cwd, now: 0 }).checks.find((entry) => entry.id === 'ledger.writers')
    assert.ok(check !== undefined, 'the ledger.writers check must exist')
    return check
}

/** The findings of one check (what every assertion reads). */
function findingsOf(check: DoctorCheck): WriterFinding[] {
    return check.findings ?? []
}

/** All findings for one rule. */
function byRule(check: DoctorCheck, rule: string): WriterFinding[] {
    return findingsOf(check).filter((finding) => finding.rule === rule)
}

test('a trail written only by its documented writers is ok, and the check says what it cannot prove', () => {
    const check = writers(cleanTrail())
    assert.equal(check.state, 'ok', `unexpected findings: ${JSON.stringify(findingsOf(check), undefined, 2)}`)
    assert.equal(check.severity, 'recommended')
    assert.equal(findingsOf(check).length, 0)
    assert.equal(check.area, 'deliver')
    assert.match(check.detail, /只读扫描/)
    assert.match(check.detail, /不能证明/, 'the honest boundary is part of the answer, not a footnote in the docs')
    assert.match(check.detail, /mission 1 个/)
    assert.match(check.detail, /门禁记录 1 条/)
})

test('a foreign `source` on a gate record is a REQUIRED finding naming path, expected and found', () => {
    const cwd = cleanTrail()
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'gates', 'GATE-2.json'), gate({ id: 'GATE-2', source: 'dsh-mystery-gate' }))
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((entry) => entry.id === 'ledger.writers') as DoctorCheck
    assert.equal(check.state, 'missing')
    assert.equal(check.severity, 'required')
    const [finding] = byRule(check, 'gate-source')
    assert.ok(finding !== undefined)
    assert.equal(finding.kind, 'violation')
    assert.equal(finding.state, 'missing')
    assert.equal(finding.path, '.dsh/missions/M-1/gates/GATE-2.json')
    assert.match(finding.expected, /已知的门禁 id/)
    assert.match(finding.found, /dsh-mystery-gate/)
    assert.match(finding.fix, /只应由/)
    // The check is a blocker, and the known gate ids are listed in the detail.
    assert.ok(report.blockers.some((entry) => entry.id === 'ledger.writers'))
    for (const id of KNOWN_GATE_IDS) assert.match(finding.expected, new RegExp(id))
})

test('a gate record with no `source` at all is the same required violation (never "legacy")', () => {
    const cwd = cleanTrail()
    const bare = gate()
    delete bare['source']
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'gates', 'GATE-3.json'), bare)
    const check = writers(cwd)
    assert.equal(check.state, 'missing')
    const [finding] = byRule(check, 'gate-source')
    assert.equal(finding?.kind, 'violation', 'source existed since the first commit: its absence cannot be an old record')
    assert.match(finding?.found ?? '', /没有 source/)
})

test('a receipt issued by anybody but the evidence gate is REQUIRED', () => {
    const cwd = cleanTrail()
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'receipts', 'RCP-2.json'), receipt({ id: 'RCP-2', issuedBy: 'dsh-quality-gate' }))
    const check = writers(cwd)
    assert.equal(check.state, 'missing')
    const [finding] = byRule(check, 'receipt-issuer')
    assert.equal(finding?.path, '.dsh/missions/M-1/receipts/RCP-2.json')
    assert.match(finding?.expected ?? '', /issuedBy = dsh-evidence-gate/)
    assert.match(finding?.found ?? '', /dsh-quality-gate/)
    assert.match(finding?.fix ?? '', /dsh-evidence-gate/)
    // An empty issuedBy is the same violation, not "unknown".
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'receipts', 'RCP-3.json'), receipt({ id: 'RCP-3', issuedBy: '' }))
    assert.equal(byRule(writers(cwd), 'receipt-issuer').length, 2)
})

test('an evidence row without `recordedBy` is REQUIRED; agent identities are a documented second value', () => {
    const cwd = cleanTrail()
    const { recordedBy: _dropped, ...anonymous } = evidenceRow()
    writeJsonl(path.join(cwd, '.dsh', 'missions', 'M-1', 'evidence.jsonl'), [evidenceRow(), anonymous, evidenceRow({ id: 'EV-3', recordedBy: 'unknown-agent' })])
    const check = writers(cwd)
    assert.equal(check.state, 'missing')
    assert.equal(check.severity, 'required')
    const missing = byRule(check, 'evidence-recorder')
    assert.equal(missing.length, 1, 'only the row without recordedBy is a violation')
    assert.match(missing[0]?.found ?? '', /第 2 行/)
    assert.match(missing[0]?.expected ?? '', /recordedBy/)

    // A plugin-shaped value that names nobody is a foreign writer; an agent id
    // is a fact about a session (`evidence_record` records who ran it).
    writeJsonl(path.join(cwd, '.dsh', 'missions', 'M-1', 'evidence.jsonl'), [
        evidenceRow({ id: 'EV-4', recordedBy: 'dsh-made-up-gate' }),
        evidenceRow({ id: 'EV-5', recordedBy: 'agent-1' }),
        evidenceRow({ id: 'EV-6', recordedBy: 'dsh-impact-gate' }),
    ])
    const second = byRule(writers(cwd), 'evidence-recorder')
    assert.equal(second.length, 1, 'agent identities and known plugins are accepted')
    assert.match(second[0]?.found ?? '', /dsh-made-up-gate/)

    // A `gate` row has exactly one writer (`recordGate` stamps
    // `recordedBy = source`), so an agent identity there is a foreign writer.
    writeJsonl(path.join(cwd, '.dsh', 'missions', 'M-1', 'evidence.jsonl'), [evidenceRow({ id: 'EV-7', kind: 'gate', recordedBy: 'agent-1' })])
    const third = byRule(writers(cwd), 'evidence-recorder')
    assert.equal(third.length, 1)
    assert.match(third[0]?.expected ?? '', /kind=gate 的行只由 MissionStore\.recordGate 写/)
})

test('a mission.json key outside the documented shape is RECOMMENDED, never a blocker', () => {
    const cwd = cleanTrail()
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'mission.json'), mission({ gates: [{ source: 'dsh-quality-gate' }], budget: 3 }))
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((entry) => entry.id === 'ledger.writers') as DoctorCheck
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    assert.equal(report.blockers.some((entry) => entry.id === 'ledger.writers'), false, 'a suspicious shape is advice, not a blocker')
    const found = byRule(check, 'mission-schema')
    assert.deepEqual(found.map((finding) => JSON.parse((finding.found.match(/(".*")/) ?? ['""'])[0] as string)).sort(), ['budget', 'gates'])
    for (const finding of found) {
        assert.equal(finding.severity, 'recommended')
        assert.match(finding.expected, /顶层键都在文档化的 mission 形状里/)
        assert.match(finding.fix, /MissionStore/)
    }
})

test('a mandate duplicated into a gate file is REQUIRED (mission state in gates/ is a foreign writer)', () => {
    const cwd = cleanTrail()
    const withMandate = gate({ id: 'GATE-4' })
    withMandate['mandate'] = mission()['mandate']
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'gates', 'GATE-4.json'), withMandate)
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((entry) => entry.id === 'ledger.writers') as DoctorCheck
    assert.equal(check.state, 'missing')
    const [finding] = byRule(check, 'mandate-location')
    assert.equal(finding?.path, '.dsh/missions/M-1/gates/GATE-4.json')
    assert.equal(finding?.severity, 'required')
    assert.match(finding?.expected ?? '', /mandate 只出现在 mission\.json/)
    assert.match(finding?.found ?? '', /gates\//)
    assert.match(finding?.fix ?? '', /MissionStore/)
    assert.ok(report.blockers.some((entry) => entry.id === 'ledger.writers'))
})

test('a policy-fingerprint.json newer than the mandate is RECOMMENDED (write-once was violated)', () => {
    const cwd = cleanTrail()
    const file = path.join(cwd, '.dsh', 'missions', 'M-1', 'policy-fingerprint.json')
    // A recorded `at` later than the mandate's: the file was written twice.
    writeJson(file, snapshot({ at: 5_000 }))
    const check = writers(cwd)
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    const [finding] = byRule(check, 'fingerprint-rewrite')
    assert.equal(finding?.severity, 'recommended')
    assert.match(finding?.found ?? '', /at=5000 比 mandate\.at=2000 新/)
    assert.match(finding?.path ?? '', /policy-fingerprint\.json/)

    // Without a recorded `at` (today's shape) the digest is the evidence: a
    // snapshot computed against a different trust root was written again.
    writeJson(file, snapshot({ version: 'b'.repeat(64) }))
    const second = writers(cwd)
    const [digest] = byRule(second, 'fingerprint-rewrite')
    assert.match(digest?.found ?? '', /policyVersion/)
    assert.equal(second.severity, 'recommended')
    assert.match(second.detail, /没有记录的 at/, 'the digest-only fallback is stated, not hidden')
})

test('an unknown directory under .dsh/ is an OBSERVATION (recommended), and known runtime dirs are not', () => {
    const cwd = cleanTrail()
    fs.mkdirSync(path.join(cwd, '.dsh', 'mystery-state'), { recursive: true })
    const report = checkWorkspace({ cwd, now: 0 })
    const check = report.checks.find((entry) => entry.id === 'ledger.writers') as DoctorCheck
    assert.equal(check.state, 'partial')
    assert.equal(check.severity, 'recommended')
    assert.equal(report.blockers.some((entry) => entry.id === 'ledger.writers'), false, 'rule 6 never blocks')
    const [finding] = byRule(check, 'unknown-state')
    assert.equal(finding?.path, '.dsh/mystery-state/')
    assert.match(finding?.found ?? '', /既不在写入者表里/)
    assert.match(finding?.fix ?? '', /KNOWN_STATE_DIRS|WRITERS/)

    // The directories this suite (and its host) really writes are not reported.
    for (const name of ['kb', 'memory', 'archive', 'specs', 'roles', 'audit', 'state', 'media', 'interaction', 'deploy', 'releases', 'adr']) {
        fs.mkdirSync(path.join(cwd, '.dsh', name), { recursive: true })
    }
    assert.equal(byRule(writers(cwd), 'unknown-state').length, 1, 'only the unexplained directory is reported')
})

test('nothing to judge is unknown WITH the reason (never ok)', () => {
    const empty = tempWorkspace('writers-empty-')
    fs.mkdirSync(path.join(empty, '.dsh'), { recursive: true })
    const check = writers(empty)
    assert.equal(check.state, 'unknown')
    assert.match(check.detail, /没有可判断的写入/)
    assert.match(check.detail, /不是"写入纪律成立"/)
    assert.equal(findingsOf(check).length, 0)

    // No .dsh at all: the same honesty, with the other reason.
    const absent = tempWorkspace('writers-absent-')
    const second = writers(absent)
    assert.equal(second.state, 'unknown')
    assert.match(second.detail, /没有 \.dsh\//)
    assert.equal(checkWorkspace({ cwd: absent, now: 0 }).blockers.some((entry) => entry.id === 'ledger.writers'), false)
})

test('legacy records are reported as legacy facts, not as violations', () => {
    // (a) A legacy approval: a specification was approved before mandates and
    // the snapshot existed, so there is no policyVersion to compare against.
    const cwd = tempWorkspace('writers-legacy-')
    const missionDir = path.join(cwd, '.dsh', 'missions', 'M-1')
    const { mandate: _noMandate, ...legacyRecord } = mission()
    writeJson(path.join(missionDir, 'mission.json'), legacyRecord)
    writeJson(path.join(missionDir, 'policy-fingerprint.json'), snapshot())
    writeJsonl(path.join(missionDir, 'evidence.jsonl'), [evidenceRow()])
    const first = writers(cwd)
    assert.equal(first.state, 'ok')
    const legacy = byRule(first, 'fingerprint-rewrite')
    assert.equal(legacy.length, 1)
    assert.equal(legacy[0]?.kind, 'legacy')
    assert.equal(legacy[0]?.state, 'ok')
    assert.match(legacy[0]?.found ?? '', /legacy 审批/)
    assert.match(legacy[0]?.found ?? '', /不是违规/)
    assert.equal(checkWorkspace({ cwd, now: 0 }).blockers.some((entry) => entry.id === 'ledger.writers'), false)

    // (b) A mandate with no snapshot at all: nothing to compare (the mandate
    // predates the snapshot), also a fact.
    fs.rmSync(path.join(missionDir, 'policy-fingerprint.json'))
    writeJson(path.join(missionDir, 'mission.json'), mission())
    const second = writers(cwd)
    assert.equal(second.state, 'ok')
    const missing = byRule(second, 'fingerprint-rewrite')
    assert.equal(missing[0]?.kind, 'legacy')
    assert.match(missing[0]?.found ?? '', /没有可读的审批时快照/)
    assert.equal(checkWorkspace({ cwd, now: 0 }).blockers.some((entry) => entry.id === 'ledger.writers'), false)
})

test('two scans of the same tree produce identical findings in identical order', () => {
    const cwd = cleanTrail()
    // Every rule at once, so the ordering has something to sort.
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'gates', 'GATE-2.json'), gate({ id: 'GATE-2', source: 'dsh-nope' }))
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'receipts', 'RCP-2.json'), receipt({ id: 'RCP-2', issuedBy: 'someone' }))
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'mission.json'), mission({ extra: true }))
    writeJsonl(path.join(cwd, '.dsh', 'missions', 'M-1', 'evidence.jsonl'), [evidenceRow(), evidenceRow({ id: 'EV-2', recordedBy: '' })])
    fs.mkdirSync(path.join(cwd, '.dsh', 'zzz-unknown'), { recursive: true })
    fs.mkdirSync(path.join(cwd, '.dsh', 'aaa-unknown'), { recursive: true })
    const first = writers(cwd)
    const second = writers(cwd)
    assert.deepEqual(first, second, 'the check must be a pure function of the tree')
    assert.deepEqual(
        findingsOf(first).map((finding) => `${finding.state} ${finding.path}`),
        [...findingsOf(first).map((finding) => `${finding.state} ${finding.path}`)].sort((left, right) => {
            const rank: Record<string, number> = { missing: 0, partial: 1, unknown: 2, ok: 3 }
            const [leftState, leftPath] = [left.split(' ')[0] ?? '', left.split(' ').slice(1).join(' ')]
            const [rightState, rightPath] = [right.split(' ')[0] ?? '', right.split(' ').slice(1).join(' ')]
            return (rank[leftState] ?? 9) - (rank[rightState] ?? 9) || (leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0)
        }),
        'findings are sorted by state then path',
    )
    assert.equal(findingsOf(first).filter((finding) => finding.state === 'missing').length, 3)
    const unknownDirs = byRule(first, 'unknown-state').map((finding) => finding.path)
    assert.deepEqual(unknownDirs, ['.dsh/aaa-unknown/', '.dsh/zzz-unknown/'], 'directories are sorted by path')
})

test('the check is read-only: a byte snapshot of .dsh is identical before and after', () => {
    const cwd = cleanTrail()
    writeJson(path.join(cwd, '.dsh', 'missions', 'M-1', 'gates', 'GATE-2.json'), gate({ id: 'GATE-2', source: 'dsh-nope' }))
    const bytes = (): Record<string, string> => {
        const out: Record<string, string> = {}
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    out[`${full}/`] = 'dir'
                    walk(full)
                    continue
                }
                out[full] = fs.readFileSync(full).toString('base64')
            }
        }
        walk(path.join(cwd, '.dsh'))
        return out
    }
    const before = bytes()
    checkWorkspace({ cwd, now: 0 })
    writers(cwd)
    assert.deepEqual(bytes(), before, 'the doctor must never write to the trail it inspects')
})

test('the README table is the same table as writers.ts (the doc cannot drift from the code)', () => {
    // Resolved from this file, not from cwd: the suite runs tests from both the
    // package directory and the repo root.
    const readme = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
    for (const row of WRITERS) {
        assert.match(readme, new RegExp(`\\\`${row.state}\\\``), `the README must list the state "${row.state}"`)
        assert.ok(readme.includes(row.pattern), `the README must carry the pattern "${row.pattern}"`)
        assert.ok(readme.includes(row.writer), `the README must name the writer of "${row.state}"`)
    }
    // And the rendered table is exactly what the README section carries, row
    // for row: same function, same bytes.
    const table = renderWriterTable()
    for (const line of table.split('\n').slice(2)) assert.ok(readme.includes(line), `the README must carry the rendered row: ${line}`)
})

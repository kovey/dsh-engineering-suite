/**
 * `ledger.writers` — the doctor check for the writer table.
 *
 * The discipline ({@link module:dsh-eng-core/writers}) says every kind of state
 * under `.dsh/` has exactly ONE writer. This module checks the part a
 * **read-only scan** can see, and states what it cannot:
 *
 *  1. `gates/*.json` → `source` is non-empty and names a known gate;
 *  2. `receipts/*.json` → `issuedBy === 'dsh-evidence-gate'`;
 *  3. `evidence.jsonl` rows → `recordedBy` is present, and a `dsh-*` value names
 *     a known writer;
 *  4. `mission.json` → no top-level key outside the documented schema;
 *  5. `mandate` lives only in `mission.json`, and
 *     `policy-fingerprint.json` is not rewritten after the mandate
 *     (its recorded `at`/digest must not be newer than the mandate's `at`);
 *  6. an unknown directory under `.dsh/` is an OBSERVATION, never a blocker.
 *
 * Severity follows the same split the design states: (1)-(3) are `required`
 * (a foreign writer invented a decision the suite treats as evidence), (4)-(6)
 * are `recommended` (a suspicious shape, not a proven foreign write). The one
 * deliberate sharpening: a `mandate` duplicated into `gates/` is `required` —
 * mission-owned state appearing in a gate file IS a foreign writer on `gates/`,
 * which is exactly rule (1)'s family.
 *
 * ## Legacy vs violation (how the two are told apart)
 *
 * Not by age, and not by guessing: by **whether the field belongs to the
 * record's shape at all**.
 *
 *  - `source`, `issuedBy` and `recordedBy` have been written by every writer
 *    since this suite's first commit (`git log -S` over `types.ts` shows them
 *    in `6f19aed`), so their absence cannot be an old record: it is a foreign
 *    or hand-edited write → violation;
 *  - `policy-fingerprint.json` never carried an `at` field (`PolicyFingerprint`
 *    is `{ version, files }`), so "no `at`" is a **legacy shape**, not a defect:
 *    the check falls back to the digest and says so;
 *  - an evidence row whose `recordedBy` is not `dsh-*` is the documented
 *    second value (the agent/session that ran `evidence_record`), not legacy
 *    and not a violation;
 *  - a mission with a mandate but no snapshot, or a snapshot with no mandate
 *    (a legacy approval), has nothing to compare: reported as a `legacy` FACT,
 *    never as a violation.
 *
 * Deterministic and read-only: no clock, no git, no writes; findings are sorted
 * by state then path, so two scans of the same tree are byte-identical.
 *
 * @module dsh-eng-core/writer-check
 */

import fs from 'node:fs'
import path from 'node:path'
import type { CheckState, DoctorCheck } from './doctor.js'
import { readJson, readText } from './io.js'
import type { Layout } from './paths.js'
import { KNOWN_EVIDENCE_WRITERS, KNOWN_GATE_IDS, MISSION_KEYS, POLICY_SNAPSHOT_FILE, RECEIPT_ISSUER, isKnownEvidenceWriter, isKnownStateDir } from './writers.js'

/** Which rule produced a finding (stable ids; the doc quotes them). */
export type WriterRule = 'gate-source' | 'receipt-issuer' | 'evidence-recorder' | 'mission-schema' | 'mandate-location' | 'fingerprint-rewrite' | 'unknown-state'

/**
 * How a finding reads:
 * `violation` — something was written by somebody who should not have (or a
 * field that must exist is missing); `legacy` — a record whose shape predates
 * the field, stated as a fact; `unknown` — the record exists but cannot be
 * judged (corrupt JSON, unusable values).
 */
export type WriterFindingKind = 'violation' | 'legacy' | 'unknown'

/** One finding: the path, what was expected, what was found, and the fix. */
export interface WriterFinding {
    rule: WriterRule
    kind: WriterFindingKind
    /** Derived: violation+required → `missing`, violation+recommended → `partial`, legacy → `ok`, unknown → `unknown`. */
    state: CheckState
    severity: 'required' | 'recommended'
    /** Workspace-relative POSIX path the finding is about. */
    path: string
    /** What the discipline expects. */
    expected: string
    /** What the artifact actually says. */
    found: string
    /** The exact next step, in Chinese, naming the only legitimate writer. */
    fix: string
}

/** What one read-only scan of the trail saw. */
export interface WriterScan {
    /** Missions whose `mission.json` could be read. */
    missions: number
    /** Gate records inspected (readable or not). */
    gates: number
    /** Receipts inspected. */
    receipts: number
    /** Evidence rows inspected (blank lines are not rows). */
    evidenceRows: number
    /** First-level directories under `.dsh/`. */
    stateDirs: number
    /** Snapshots that could only be compared by digest (no recorded `at`). */
    digestOnlySnapshots: number
    /** Findings, sorted by state then path (see {@link sortFindings}). */
    findings: WriterFinding[]
    /** Why nothing could be judged, when nothing could. */
    nothingToJudge?: string
}

/** How many findings the check's detail line spells out. */
export const MAX_DETAIL_FINDINGS = 8

/** How many fixes the check's `fix` line quotes. */
export const MAX_FIX_LINES = 3

/** Sort rank: violations first, facts last. */
const STATE_RANK: Record<CheckState, number> = { missing: 0, partial: 1, unknown: 2, ok: 3 }

/** Sort findings by state, then path, then rule (fully deterministic). */
export function sortFindings(findings: readonly WriterFinding[]): WriterFinding[] {
    return [...findings].sort(
        (left, right) =>
            STATE_RANK[left.state] - STATE_RANK[right.state] || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0),
    )
}

/** A JSON object (`{}`) — not an array, not `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Workspace-relative POSIX path (the form every finding uses). */
function relativeOf(layout: Layout, file: string): string {
    return path.relative(layout.cwd, file).split(path.sep).join('/')
}

/** Entries of one directory, name-sorted; empty when absent/unreadable. */
function entriesOf(dir: string, kind: 'file' | 'dir'): string[] {
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
    return entries
        .filter((entry) => (kind === 'file' ? entry.isFile() : entry.isDirectory()))
        .map((entry) => entry.name)
        .sort()
}

/** The `*.json` files of one directory, name-sorted (absolute paths). */
function jsonFilesIn(dir: string): string[] {
    return entriesOf(dir, 'file')
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name))
}

/** A non-empty trimmed string, or `''`. */
function textOf(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

/** The fix line for a foreign writer on a mission artifact (Chinese, actionable). */
function writerFix(writer: string, artifact: string): string {
    return `这类文件只应由${writer}写；请确认${artifact}不是手工编辑，或用对应工具重写（先 git diff 看改动，再重跑产生它的工具）`
}

/** Scan one mission's `gates/` directory. */
function scanGates(layout: Layout, missionDir: string, scan: WriterScan): void {
    for (const file of jsonFilesIn(path.join(missionDir, 'gates'))) {
        scan.gates += 1
        const relative = relativeOf(layout, file)
        const record = readJson<Record<string, unknown>>(file)
        if (record === undefined || !isRecord(record)) {
            scan.findings.push({
                rule: 'gate-source',
                kind: 'unknown',
                state: 'unknown',
                severity: 'recommended',
                path: relative,
                expected: `一条门禁记录（JSON 对象，带 source）`,
                found: '不是合法的 JSON 对象：无法判断是谁写的',
                fix: '用 git diff 看这个文件是否被手工改坏；确认后重跑产生它的门禁（quality_gate_run / standards_check / coverage_check 等）',
            })
            continue
        }
        const source = textOf(record['source'])
        if (source === '') {
            scan.findings.push({
                rule: 'gate-source',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: `非空的 source（产生这条记录的门禁 id：${KNOWN_GATE_IDS.join(' / ')}）`,
                found: '没有 source（或为空）：这条记录没有可追溯的写入者',
                fix: writerFix('产生这条门禁的门禁插件（MissionStore.recordGate）', relative),
            })
        } else if (!KNOWN_GATE_IDS.includes(source)) {
            scan.findings.push({
                rule: 'gate-source',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: `source 是本套件已知的门禁 id（${KNOWN_GATE_IDS.join(' / ')}）`,
                found: `source = ${JSON.stringify(source)}：不是任何一个已知门禁`,
                fix: writerFix('产生这条门禁的门禁插件（MissionStore.recordGate）', relative),
            })
        }
        if (Object.hasOwn(record, 'mandate')) {
            scan.findings.push({
                rule: 'mandate-location',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: 'mandate 只出现在 mission.json 里（它是 mission 的身份/授权，不是门禁结论）',
                found: '这个门禁记录里有一份 mission 的 mandate：mission 状态被复制进了 gates/',
                fix: `${writerFix('MissionStore（spec_approve 写 mandate）', relative)}；删除 gates/ 里的那份副本，授权只认 mission.json`,
            })
        }
    }
}

/** Scan one mission's `receipts/` directory (only `dsh-evidence-gate` issues them). */
function scanReceipts(layout: Layout, missionDir: string, scan: WriterScan): void {
    for (const file of jsonFilesIn(path.join(missionDir, 'receipts'))) {
        scan.receipts += 1
        const relative = relativeOf(layout, file)
        const record = readJson<Record<string, unknown>>(file)
        if (record === undefined || !isRecord(record)) {
            scan.findings.push({
                rule: 'receipt-issuer',
                kind: 'unknown',
                state: 'unknown',
                severity: 'recommended',
                path: relative,
                expected: '一张回执（JSON 对象，带 issuedBy）',
                found: '不是合法的 JSON 对象：无法判断是谁签发的',
                fix: '用 git diff 看这个文件是否被手工改坏；确认后由证据门禁重新签发（delivery 流程）',
            })
            continue
        }
        const issuedBy = textOf(record['issuedBy'])
        if (issuedBy !== RECEIPT_ISSUER) {
            scan.findings.push({
                rule: 'receipt-issuer',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: `issuedBy = ${RECEIPT_ISSUER}（回执只有它能签发）`,
                found: issuedBy === '' ? '没有 issuedBy（或为空）：回执没有签发者' : `issuedBy = ${JSON.stringify(issuedBy)}`,
                fix: writerFix(RECEIPT_ISSUER, relative),
            })
        }
    }
}

/** Scan one mission's `evidence.jsonl` ledger, row by row. */
function scanEvidence(layout: Layout, missionDir: string, scan: WriterScan): void {
    const file = path.join(missionDir, 'evidence.jsonl')
    const text = readText(file)
    if (text === undefined) return
    const relative = relativeOf(layout, file)
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').trim()
        if (line === '') continue
        scan.evidenceRows += 1
        const rowNumber = index + 1
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            scan.findings.push({
                rule: 'evidence-recorder',
                kind: 'unknown',
                state: 'unknown',
                severity: 'recommended',
                path: relative,
                expected: '一行一条证据记录（JSON 对象，带 recordedBy）',
                found: `第 ${rowNumber} 行不是合法 JSON：无法判断写入者`,
                fix: '用 git diff 看这一行是否被手工改坏（账本只追加，不改写）；确认后由记录证据的工具重新记录',
            })
            continue
        }
        if (!isRecord(parsed)) {
            scan.findings.push({
                rule: 'evidence-recorder',
                kind: 'unknown',
                state: 'unknown',
                severity: 'recommended',
                path: relative,
                expected: '一行一条证据记录（JSON 对象，带 recordedBy）',
                found: `第 ${rowNumber} 行不是 JSON 对象：无法判断写入者`,
                fix: '账本只追加、不改写：确认这一行不是手工插入的；证据由记录它的插件重新写入',
            })
            continue
        }
        const recordedBy = textOf(parsed['recordedBy'])
        if (recordedBy === '') {
            scan.findings.push({
                rule: 'evidence-recorder',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: `每一行都有 recordedBy（记录它的插件 id——${KNOWN_EVIDENCE_WRITERS.join(' / ')}——或运行 evidence_record 的 agent/session 身份）`,
                found: `第 ${rowNumber} 行没有 recordedBy：这行证据没有记录者`,
                fix: writerFix('记录这条证据的插件（MissionStore.appendEvidence 的 recordedBy）', `${relative} 第 ${rowNumber} 行`),
            })
        } else if (textOf(parsed['kind']) === 'gate' && !KNOWN_GATE_IDS.includes(recordedBy)) {
            // A `gate` row has exactly one writer — `MissionStore.recordGate`,
            // which stamps `recordedBy = source`. So this row must name a gate id,
            // not an agent identity: an agent cannot have written it.
            scan.findings.push({
                rule: 'evidence-recorder',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: `kind=gate 的行只由 MissionStore.recordGate 写，recordedBy 必须是已知门禁 id（${KNOWN_GATE_IDS.join(' / ')}）`,
                found: `第 ${rowNumber} 行是 gate 证据，但 recordedBy = ${JSON.stringify(recordedBy)}：不是任何一个已知门禁`,
                fix: writerFix('产生这条门禁的门禁插件（MissionStore.recordGate）', `${relative} 第 ${rowNumber} 行`),
            })
        } else if (!isKnownEvidenceWriter(recordedBy)) {
            scan.findings.push({
                rule: 'evidence-recorder',
                kind: 'violation',
                state: 'missing',
                severity: 'required',
                path: relative,
                expected: 'dsh-* 形状的 recordedBy 必须是本套件已知的写入插件（其它形状是 agent/session 身份）',
                found: `第 ${rowNumber} 行的 recordedBy = ${JSON.stringify(recordedBy)}：不是任何一个已知插件`,
                fix: writerFix('记录这条证据的插件（MissionStore.appendEvidence 的 recordedBy）', `${relative} 第 ${rowNumber} 行`),
            })
        }
    }
}

/** Rule 4: `mission.json` carries no top-level key outside the documented schema. */
function scanMissionKeys(layout: Layout, missionFile: string, record: Record<string, unknown>, scan: WriterScan): void {
    const relative = relativeOf(layout, missionFile)
    const unknown = Object.keys(record)
        .filter((key) => !MISSION_KEYS.includes(key))
        .sort()
    for (const key of unknown) {
        scan.findings.push({
            rule: 'mission-schema',
            kind: 'violation',
            state: 'partial',
            severity: 'recommended',
            path: relative,
            expected: `顶层键都在文档化的 mission 形状里（${MISSION_KEYS.join(', ')}）`,
            found: `多了一个未记录的顶层键 ${JSON.stringify(key)}：有人在这里写了 mission 之外的状态`,
            fix: writerFix('MissionStore（mission.ts 的 update/save）', relative) + '；如果这个键应该存在，先改 MissionRecord 与这里的关键字清单，再写',
        })
    }
}

/** Rule 5b: `policy-fingerprint.json` is write-once, before the mandate. */
function scanFingerprint(layout: Layout, missionDir: string, record: Record<string, unknown>, scan: WriterScan): void {
    const snapshotFile = path.join(missionDir, POLICY_SNAPSHOT_FILE)
    const snapshot = readJson<Record<string, unknown>>(snapshotFile)
    const recordIsObject = isRecord(snapshot)
    const mandate = isRecord(record['mandate']) ? record['mandate'] : undefined
    const relative = relativeOf(layout, snapshotFile)
    const expected = 'policy-fingerprint.json 只由 dsh-spec-gate 在 mandate 之前写一次（记录的 at/version 必须与 mandate 一致）'
    if (mandate === undefined) {
        // Legacy approval (no mandate at all): nothing to compare against.
        if (recordIsObject) {
            scan.findings.push({
                rule: 'fingerprint-rewrite',
                kind: 'legacy',
                state: 'ok',
                severity: 'recommended',
                path: relative,
                expected,
                found: '这个 mission 是 legacy 审批（没有 mandate 记录）：没有 policyVersion 可比，无法判断快照写过几次——这是事实，不是违规',
                fix: '无需处理（legacy 记录按兼容读取）；新 mission 会带 mandate 与一次性的指纹快照',
            })
        }
        return
    }
    if (!recordIsObject) {
        scan.findings.push({
            rule: 'fingerprint-rewrite',
            kind: 'legacy',
            state: 'ok',
            severity: 'recommended',
            path: relative,
            expected,
            found: 'mandate 存在但没有可读的审批时快照（policy-fingerprint.json 缺失或损坏）：没有可比的记录——这是事实，不是违规',
            fix: '无需处理；要恢复"能点名改动文件"的能力，请为新 mission 重新审批（mandate 不可改写）',
        })
        return
    }
    const mandateAt = typeof mandate['at'] === 'number' ? mandate['at'] : undefined
    const mandateVersion = textOf(mandate['policyVersion'])
    const recordedAt = typeof snapshot['at'] === 'number' ? snapshot['at'] : undefined
    const version = textOf(snapshot['version'])
    if (recordedAt !== undefined && mandateAt !== undefined) {
        if (recordedAt > mandateAt) {
            scan.findings.push({
                rule: 'fingerprint-rewrite',
                kind: 'violation',
                state: 'partial',
                severity: 'recommended',
                path: relative,
                expected,
                found: `快照记录的 at=${recordedAt} 比 mandate.at=${mandateAt} 新：这个"写一次"的文件在授权之后被写过第二次`,
                fix: writerFix('dsh-spec-gate（spec_approve 写一次快照）', relative) + '；如果这是手工重算的，请撤销它——授权时的策略快照不能刷新',
            })
            return
        }
    } else {
        // The shape that exists today: no recorded `at`. The digest is the only
        // content-level evidence of a second write.
        scan.digestOnlySnapshots += 1
    }
    if (mandateVersion !== '' && version !== '' && version !== mandateVersion) {
        scan.findings.push({
            rule: 'fingerprint-rewrite',
            kind: 'violation',
            state: 'partial',
            severity: 'recommended',
            path: relative,
            expected: `${expected}；快照的 version 必须等于 mandate.policyVersion`,
            found: `快照 version=${version.slice(0, 12)}… ≠ mandate policyVersion=${mandateVersion.slice(0, 12)}…：快照是在另一次策略指纹下重算的（写了第二次）`,
            fix: writerFix('dsh-spec-gate（spec_approve 写一次快照）', relative) + '；重算过的快照会让"策略变了要重新授权"静默失效',
        })
    }
}

/** Rule 6: an unknown directory under `.dsh/` is an observation. */
function scanStateDirs(layout: Layout, scan: WriterScan): void {
    const names = entriesOf(layout.rootDir, 'dir')
    scan.stateDirs = names.length
    for (const name of names) {
        if (isKnownStateDir(name)) continue
        const relative = relativeOf(layout, path.join(layout.rootDir, name))
        scan.findings.push({
            rule: 'unknown-state',
            kind: 'violation',
            state: 'partial',
            severity: 'recommended',
            path: `${relative}/`,
            expected: '.dsh/ 下的每个目录都在写入者表里（有唯一写入者），或在已知的运行时目录清单里',
            found: `${relative}/ 既不在写入者表里，也不在已知运行时目录清单里：没有人认领这份状态`,
            fix:
                `确认这个目录是谁写的：是运行时产物就登记进 packages/dsh-eng-core/src/writers.ts 的 KNOWN_STATE_DIRS（并写明写入者），` +
                `是有唯一写入者的状态就登记进同一文件的 WRITERS 表；不属于本套件的请移出 ${path.relative(layout.cwd, layout.rootDir) || '.dsh'}/`,
        })
    }
}

/**
 * Walk the trail and collect writer findings (read-only, deterministic).
 * @param layout - the resolved trail layout.
 */
export function scanTrailWriters(layout: Layout): WriterScan {
    const scan: WriterScan = { missions: 0, gates: 0, receipts: 0, evidenceRows: 0, stateDirs: 0, digestOnlySnapshots: 0, findings: [] }
    const missionNames = entriesOf(layout.missionsDir, 'dir')
    for (const name of missionNames) {
        const missionDir = path.join(layout.missionsDir, name)
        const missionFile = path.join(missionDir, 'mission.json')
        const record = readJson<Record<string, unknown>>(missionFile)
        if (record === undefined || !isRecord(record)) {
            scan.findings.push({
                rule: 'mission-schema',
                kind: 'unknown',
                state: 'unknown',
                severity: 'recommended',
                path: relativeOf(layout, missionFile),
                expected: '一个 mission 目录里有可读的 mission.json（JSON 对象）',
                found: 'mission.json 缺失或不是合法的 JSON 对象：这个 mission 的状态无法判断',
                fix: writerFix('MissionStore（mission.ts 的 update/save）', relativeOf(layout, missionFile)) + '；无法恢复时用 git 找回上一次提交的 mission.json',
            })
        } else {
            scan.missions += 1
            scanMissionKeys(layout, missionFile, record, scan)
            scanFingerprint(layout, missionDir, record, scan)
        }
        scanGates(layout, missionDir, scan)
        scanReceipts(layout, missionDir, scan)
        scanEvidence(layout, missionDir, scan)
    }
    scanStateDirs(layout, scan)
    scan.findings = sortFindings(scan.findings)
    if (scan.missions === 0 && scan.gates === 0 && scan.receipts === 0 && scan.evidenceRows === 0) {
        scan.nothingToJudge = fs.existsSync(layout.rootDir)
            ? '没有可判断的写入：本工作区还没有 mission / 门禁记录 / 回执 / 证据行——"还没有台账"不是"写入纪律成立"'
            : `本工作区没有 ${path.basename(layout.rootDir)}/：没有可判断的写入（"没有台账"不是"写入纪律成立"）`
    }
    return scan
}

/**
 * One Chinese line per finding, naming the path, what was expected and what was
 * found — the form the rendered report uses (one finding = one line).
 * @param finding - the finding to describe.
 */
export function describeFinding(finding: WriterFinding): string {
    return `${finding.path}（${finding.rule}）：期望 ${finding.expected}；实际 ${finding.found}`
}

/**
 * Build the `ledger.writers` doctor check from a read-only scan.
 *
 * `required` + `missing` when a foreign writer touched gates/receipts/evidence
 * (or mission state leaked into `gates/`); `partial` + `recommended` for the
 * shape-level suspicions (unknown mission key, rewritten fingerprint, unknown
 * `.dsh/` directory); `unknown` when there is nothing to judge — with the
 * reason, because "no ledger yet" is not a pass. `legacy` facts are stated in
 * the detail and never land in `blockers`.
 * @param layout - the resolved trail layout.
 */
export function writersCheck(layout: Layout): DoctorCheck {
    const scan = scanTrailWriters(layout)
    const base = {
        id: 'ledger.writers',
        area: 'deliver' as const,
        label: '写入者纪律（每个状态只有一个写入者）',
    }
    const scope =
        `只读扫描：mission ${scan.missions} 个、门禁记录 ${scan.gates} 条、回执 ${scan.receipts} 个、证据 ${scan.evidenceRows} 行、` +
        `.dsh/ 一级目录 ${scan.stateDirs} 个`
    const digestNote =
        scan.digestOnlySnapshots === 0
            ? ''
            : `；${scan.digestOnlySnapshots} 个指纹快照没有记录的 at（legacy 形状：PolicyFingerprint 只有 version/files），按 version 与 mandate 比对`
    if (scan.nothingToJudge !== undefined && scan.findings.length === 0) {
        return {
            ...base,
            state: 'unknown',
            severity: 'recommended',
            detail: `${scope}；${scan.nothingToJudge}`,
        }
    }
    const required = scan.findings.filter((finding) => finding.kind === 'violation' && finding.severity === 'required')
    const recommended = scan.findings.filter((finding) => finding.kind === 'violation' && finding.severity === 'recommended')
    const facts = scan.findings.filter((finding) => finding.kind !== 'violation')
    const violations = [...required, ...recommended]
    // The findings themselves are rendered one per line by `renderDoctor`, and
    // carried in `findings` for JSON consumers: the detail line is the aggregate,
    // so a long list cannot turn one diagnosis into an unreadable paragraph.
    const counts =
        violations.length === 0
            ? '没有写入者违规'
            : `${required.length} 条必须处理的写入者违规` + (recommended.length === 0 ? '' : ` + ${recommended.length} 条建议性违规`)
    const factCount = facts.length === 0 ? '' : `；另有 ${facts.length} 条 legacy/无法判断的事实（不是违规，见下）`
    const fixes = [...new Set(violations.map((finding) => finding.fix))]
    if (required.length > 0) {
        return {
            ...base,
            state: 'missing',
            severity: 'required',
            detail:
                `${scope}${digestNote}；${counts}${factCount}。必需项：门禁记录/回执/证据行是本套件的证据，` +
                '外来写入会让"这条门禁 PASS 过"失去意义',
            fix: fixes.slice(0, MAX_FIX_LINES).join('；'),
            findings: scan.findings,
        }
    }
    if (recommended.length > 0) {
        return {
            ...base,
            state: 'partial',
            severity: 'recommended',
            detail: `${scope}${digestNote}；${counts}${factCount}`,
            fix: fixes.slice(0, MAX_FIX_LINES).join('；'),
            findings: scan.findings,
        }
    }
    return {
        ...base,
        state: 'ok',
        severity: 'recommended',
        detail:
            facts.length === 0
                ? `${scope}${digestNote}；没有发现外来写入（门禁 source / 回执 issuedBy / 证据 recordedBy / mission 形状 / mandate 位置 / 指纹快照均符合表）` +
                  '。注意：只读扫描只能证明"没有明显的第二个写入者"，不能证明"写的人就是声称的人"'
                : `${scope}${digestNote}；没有写入者违规${factCount}`,
        ...(facts.length === 0 ? {} : { findings: scan.findings }),
    }
}

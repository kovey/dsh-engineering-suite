/**
 * The **writer table**: every kind of state under `.dsh/`, and the ONE thing
 * allowed to write it.
 *
 * The suite's whole audit story rests on an implicit rule nobody had written
 * down: a mission's identity belongs to `MissionStore`, a receipt belongs to
 * `dsh-evidence-gate`, a gate record belongs to the gate that produced it, and
 * an evidence row belongs to the plugin that recorded it. Everybody else
 * READS, or asks the writer through its tool. That is why a gate record can
 * stand as evidence at all — if any plugin (or a hand edit) could append to
 * `gates/`, "this gate PASSed" would mean nothing.
 *
 * This module states the table as code, so three things can read the same
 * source of truth instead of three prose copies:
 *
 *  1. the doctor check `ledger.writers` ({@link module:dsh-eng-core/writer-check}),
 *     which verifies the part a read-only scan can see;
 *  2. the package README, whose table is rendered by {@link renderWriterTable}
 *     (a test pins the two together, so the doc cannot drift from the code);
 *  3. a human reading the report.
 *
 * ## The honest boundary (do not soften this)
 *
 * A read-only scan can catch a foreign writer, a missing field, a duplicated
 * fact and an unexpected file. It **cannot** prove who wrote a file: a
 * well-formed lie — a record that carries a legal writer field but was written
 * by somebody else — is out of reach. That is exactly why the fields
 * (`source`, `issuedBy`, `recordedBy`) exist, and why closing the last gap is
 * the writer's job (it records its own provenance), not the scan's.
 *
 * @module dsh-eng-core/writers
 */

/**
 * One row of the writer table.
 *
 * `checkable` says whether **this suite's read-only scan** can decide the row
 * from the artifacts alone (it is not a claim that the rule is impossible to
 * check in principle — a row can carry a usable writer field and still be left
 * out of `ledger.writers`, which is stated in `why`).
 */
export interface WriterEntry {
    /** Stable state id (the first column of the table). */
    state: string
    /** Path pattern, relative to the trail root (POSIX; `*` = one segment). */
    pattern: string
    /** The one writer. */
    writer: string
    /** Whether `ledger.writers` checks this row with a read-only scan. */
    checkable: boolean
    /** What is checked, when it is (Chinese: the report and the doc quote it). */
    check?: string
    /** Why it is not checked — mandatory when `checkable` is false. */
    why?: string
}

/**
 * The table. Frozen on purpose: it is a statement of the design, not a
 * configuration knob. Adding a row is a design decision and belongs in review.
 */
export const WRITERS: readonly WriterEntry[] = Object.freeze([
    {
        state: 'mission',
        pattern: 'missions/*/mission.json',
        writer: 'MissionStore（dsh-eng-core，经 spec-gate / orchestrator / evidence-gate 的工具）',
        checkable: true,
        check: '顶层键必须都在文档化的 mission 形状里；mandate 只允许出现在这里',
    },
    {
        state: 'stages',
        pattern: 'missions/*/stages/*.json',
        writer: 'dsh-orchestrator（stage 进入与结算）',
        checkable: false,
        why: 'StageResult 里没有任何写入者字段（stageId/attempt/state/route），只读扫描没有任何可以比对的 provenance：多写一次与正常结算在字节上无法区分',
    },
    {
        state: 'gates',
        pattern: 'missions/*/gates/*.json',
        writer: '产生这条记录的门禁本身（source 必须是该门禁的 id）',
        checkable: true,
        check: 'source 必须非空，且必须是本套件真实存在的门禁 id',
    },
    {
        state: 'receipts',
        pattern: 'missions/*/receipts/*.json',
        writer: '只有 dsh-evidence-gate（issuedBy）',
        checkable: true,
        check: 'issuedBy 必须等于 dsh-evidence-gate',
    },
    {
        state: 'evidence',
        pattern: 'missions/*/evidence.jsonl',
        writer: '记录这条证据的插件（recordedBy），只追加',
        checkable: true,
        check: '每行都有 recordedBy；dsh-* 形状的值必须是已知写入者（agent 身份是文档化的第二种值）',
    },
    {
        state: 'impact',
        pattern: 'missions/*/impact/*.json',
        writer: 'dsh-impact-gate',
        checkable: false,
        why: '本轮检查不覆盖——产物里其实带 plugin 字段，但约定的六条规则只覆盖 gates/receipts/evidence，检查不假装查了它',
    },
    {
        state: 'policy-fingerprint',
        pattern: 'missions/*/policy-fingerprint.json',
        writer: 'dsh-spec-gate（写一次，在 mandate 之前）',
        checkable: true,
        check: '记录的 version/at 必须与 mandate 一致：比 mandate 新就是写了第二次',
    },
    {
        state: 'plan',
        pattern: 'plan.jsonl',
        writer: 'dsh-spec-gate',
        checkable: false,
        why: '计划行里没有写入者字段（by 是发起的人/会话，不是插件）：只读扫描分不出是谁追加的',
    },
    {
        state: 'releases',
        pattern: 'releases.jsonl',
        writer: 'dsh-evidence-gate',
        checkable: false,
        why: '发布行记录的是发布本身（版本/tag/mission），没有插件 id 字段：无法判定追加者',
    },
    {
        state: 'deployments',
        pattern: 'deployments.jsonl',
        writer: 'dsh-deploy-gate',
        checkable: false,
        why: '部署行没有写入者字段：无法判定追加者',
    },
    {
        state: 'interaction',
        pattern: 'interaction/*.jsonl',
        writer: 'dsh-interaction-gate',
        checkable: false,
        why: '提问/注意力行没有写入者字段：无法判定追加者',
    },
    {
        state: 'kb',
        pattern: 'kb/**',
        writer: 'dsh-knowledge-base',
        checkable: false,
        why: '索引是构建产物（chunks/postings/manifest），形状里没有写入者字段：重建一次与写坏一次无法区分',
    },
    {
        state: 'trust-root',
        pattern: '*.json（信任根配置）、roles/**',
        writer: '只有人（信任根；agent 的写工具一律拒绝）',
        checkable: false,
        why: '只读扫描无法区分"人评审后写的"与"代理偷偷写的"：没有第二个记录者可以比对——这一条只能靠写工具的拒绝（guard）来保证',
    },
])

/**
 * Gate ids that a package in this suite actually writes as `GateRecord.source`.
 *
 * Derived from the source, not invented (2026-10): `dsh-quality-gate`
 * (`tools.ts` + `hooks.ts`), `dsh-standards-gate` (`tools.ts`),
 * `dsh-coverage-gate` / `dsh-supply-chain-gate` / `dsh-deploy-gate` (their
 * exported `GATE_SOURCE`). The orchestrator and the evidence gate do not record
 * gate rows of their own — they read somebody else's.
 */
export const KNOWN_GATE_IDS: readonly string[] = Object.freeze([
    'dsh-quality-gate',
    'dsh-standards-gate',
    'dsh-coverage-gate',
    'dsh-supply-chain-gate',
    'dsh-deploy-gate',
])

/**
 * Plugin ids known to append a row to `mission.evidence.jsonl`.
 *
 * `MissionStore.recordGate` appends a `gate` row with `recordedBy = source`, so
 * every known gate id belongs here too; the rest are the plugins that call
 * `appendEvidence` with their own id.
 */
export const KNOWN_EVIDENCE_WRITERS: readonly string[] = Object.freeze([
    ...KNOWN_GATE_IDS,
    'dsh-evidence-gate',
    'dsh-impact-gate',
    'dsh-orchestrator',
    'dsh-test-design-gate',
])

/**
 * The documented fallback `recordedBy` when no agent context exists
 * (`dsh-evidence-gate` records it rather than inventing an identity).
 */
export const UNKNOWN_EVIDENCE_WRITER = 'unknown-agent'

/**
 * The documented top-level keys of `mission.json` (`MissionRecord`).
 *
 * Kept as a list, not derived with `keyof`, because the CHECK must catch a key
 * the type does not know: a hand-written `gates: []` inside `mission.json` is
 * invisible to the type system and entirely visible to this list.
 */
export const MISSION_KEYS: readonly string[] = Object.freeze([
    'id',
    'title',
    'status',
    'cwd',
    'createdAt',
    'updatedAt',
    'sessionId',
    'specPath',
    'specDigest',
    'spec',
    'testDesign',
    'stage',
    'roles',
    'approval',
    'mandate',
    'labels',
])

/**
 * Directories under `.dsh/` that this suite knows about, even when the table
 * gives no single writer (because the writer is outside these 16 packages, or
 * the directory is a config directory rather than a ledger).
 *
 * Used by the `unknown-state` rule: a directory that is neither in
 * {@link WRITERS} nor here is reported as an OBSERVATION, never as a blocker —
 * an unexplained directory is a question ("who writes this?"), not a proven
 * foreign write.
 */
export const KNOWN_STATE_DIRS: readonly string[] = Object.freeze([
    // 表里出现的状态目录（有唯一写入者，ledger.writers 会检查其内容）
    'missions',
    'kb',
    'interaction',
    'deploy',
    'roles',
    // 表外、但本套件的其它产物目录
    'specs', // 规格 markdown：MissionStore.writeSpec / dsh-spec-gate
    'audit', // 工具调用审计：dsh-audit-trail
    'state', // 会话 ↔ mission 绑定：MissionStore.bindSession
    'media', // 证据里引用的图片/附件：证据记录者
    'archive', // 归档后的旧 mission：scripts/archive-missions.sh（人工动作）
    'releases', // 发布说明渲染产物：dsh-evidence-gate
    'adr', // 架构决策记录：dsh-spec-gate
    'bootstrap', // 一次性脚手架快照：dsh-spec-gate
    // 宿主插件的运行时目录（不属于本套件的 16 个包）
    'memory', // dsh-memory 插件
])

/** The artifact holding the approval-time trust-root fingerprint (write-once). */
export const POLICY_SNAPSHOT_FILE = 'policy-fingerprint.json'

/** The only receipt issuer (`dsh-evidence-gate`). */
export const RECEIPT_ISSUER = 'dsh-evidence-gate'

/** Whether a directory name under `.dsh/` is a known state directory. */
export function isKnownStateDir(name: string): boolean {
    if (KNOWN_STATE_DIRS.includes(name)) return true
    // A table row may point at the directory itself (`kb/**` → `kb`).
    return WRITERS.some((row) => row.pattern.split('/')[0] === name)
}

/**
 * Whether a `recordedBy` value is a known evidence writer.
 *
 * Two shapes are documented, and the rule is stated so a reader can tell them
 * apart: a **plugin id** (`dsh-*`) must be one of {@link KNOWN_EVIDENCE_WRITERS}
 * — a plugin name nobody can point at is a foreign writer; anything else is an
 * **agent/session identity** (`dsh-evidence-gate` records who RAN
 * `evidence_record`), which is a fact about a person's session and cannot be
 * checked against a fixed list.
 * @param value - the recorded `recordedBy`.
 */
export function isKnownEvidenceWriter(value: string): boolean {
    if (value === UNKNOWN_EVIDENCE_WRITER) return true
    if (value.startsWith('dsh-')) return KNOWN_EVIDENCE_WRITERS.includes(value)
    return true
}

/**
 * Render the writer table as the markdown the README carries.
 *
 * One function, two consumers (the doc and the test that pins it): a table that
 * is typed twice drifts, and a drifted table is worse than no table.
 */
export function renderWriterTable(): string {
    const lines: string[] = []
    lines.push('| 状态 | 路径（相对 `.dsh/`） | 唯一写入者 | 只读可查 | 检查什么 |')
    lines.push('|---|---|---|---|---|')
    for (const row of WRITERS) {
        const checkable = row.checkable ? '✅' : '—'
        const what = row.checkable ? (row.check ?? '') : `不查：${row.why ?? ''}`
        lines.push(`| \`${row.state}\` | \`${row.pattern}\` | ${row.writer} | ${checkable} | ${what} |`)
    }
    return lines.join('\n')
}

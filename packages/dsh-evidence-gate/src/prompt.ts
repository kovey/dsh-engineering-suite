/**
 * System-prompt contribution: the evidence contract, stated where the model
 * can actually read it (docs.md §9: "显式声明一切").
 *
 * The section is rendered **per assembly** from the effective configuration of
 * the calling agent's workspace (profile overlaid with the repo's
 * `.dsh/evidence-gate.json`, see `resolveEffectiveConfig`): one dsh process
 * serves several repositories, and a prompt that still advertised the profile's
 * `command`+`test` while the workspace demanded `artifact` would be exactly the
 * kind of silent divergence this suite forbids. The profile is only the
 * default/ceiling.
 *
 * @module dsh-evidence-gate/prompt
 */

import type { EffectiveEvidenceGateConfig, EvidenceGateConfig } from './config.js'

/** Section name (unique across the suite's prompt contributions). */
export const PROMPT_SECTION = 'eng:evidence-gate'

/** `requiredEvidenceKinds` as one readable list. */
function kindsText(config: EvidenceGateConfig): string {
    return config.requiredEvidenceKinds.length === 0
        ? '（本工作区不要求任何证据类型）'
        : config.requiredEvidenceKinds.join('、')
}

/**
 * The "what is in force HERE" block.
 *
 * Carries the effective values only — never a second copy of the profile's,
 * which would double the section's size for no information — plus the one-line
 * reminder that the profile is just the default. `evidence_status` stays the
 * authority for the exact numbers (and prints where they came from).
 * @param config - the profile configuration (the ceiling).
 * @param effective - the calling workspace's effective configuration, when the
 *   workspace could be resolved at all.
 */
function effectiveLines(config: EvidenceGateConfig, effective?: EffectiveEvidenceGateConfig): string[] {
    const active = effective?.config ?? config
    const note =
        effective === undefined
            ? '本会话未声明工作区（session.header.cwd 缺失），无法解析本工作区的项目级配置，以下只能是 profile 默认值。'
            : effective.source === 'project'
              ? '本工作区生效的交付参数（来源：本工作区的项目级配置）。'
              : '本工作区生效的交付参数（本工作区没有生效的项目级配置，取值即 profile 默认）。'
    const cleanTree = active.requireCleanTree
        ? '交付前核对工作区指纹与门禁观测一致（比对双方都排除 `.dsh/` 台账目录）'
        : '交付前不核对工作区指纹'
    return [
        `${note}profile 只是默认值/上限，项目可用 \`.dsh/evidence-gate.json\` 细化；精确取值与来源以 \`evidence_status\` 为准。`,
        `- 必填证据类型：${kindsText(active)}——缺任何一类都会被拒绝。`,
        `- 门禁：来源 ${active.gateSource}；requireGate=${active.requireGate}；maxGateAgeMinutes=${active.maxGateAgeMinutes}。`,
        `- requireCleanTree=${active.requireCleanTree}——${cleanTree}。`,
        `- 发布台账：${active.releasesFile}；发布说明目录：${active.releasesDir}；版本格式校验：${
            active.requireTagFormat === undefined ? '未启用（requireTagFormat 关闭）' : active.requireTagFormat
        }；notesIncludeCriteria=${active.notesIncludeCriteria}。`,
    ]
}

/**
 * Build the section text.
 * @param config - the profile-resolved configuration (the ceiling, and the
 *   fallback when the workspace cannot be resolved).
 * @param effective - the effective configuration of the workspace this
 *   assembly belongs to; omitted when it could not be resolved (unknown
 *   workspace, broken project file), in which case the profile text is
 *   rendered instead.
 * @returns the prompt text; empty when the plugin or the section is disabled
 *   (an empty section is dropped by the harness).
 */
export function sectionText(config: EvidenceGateConfig, effective?: EffectiveEvidenceGateConfig): string {
    if (!config.enabled || !config.prompt.enabled) return ''
    return [
        '## 证据与交付门禁（evidence-gate）',
        '',
        '**"完成"必须由可验证的证据支撑**：证据缺失或不确定时 `mission_complete` 一律阻断（fail closed），不会静默放行。',
        '',
        '什么算证据：',
        '- **质量门禁输出**：`quality_gate_run` 的 `PASS`/`WARN`/`BLOCK` 裁决与命令回显（门禁由宿主配置，不由模型编造）。',
        '- **Git diff 指纹**：`evidence_record(kind="diff")` 记录 `git diff --stat` 与工作区指纹（`branch@head` + 变更文件数 + diff 摘要 sha256）。',
        '- **测试报告**：`evidence_record(kind="test")` 记录测试命令、退出码与输出摘要（sha256 + 尾部截断），与当时的 Git 指纹绑定。',
        '',
        '交付序列（按顺序调用）：`evidence_record → quality_gate_run → mission_complete`（先登记验证输出，再让门禁覆盖它，最后交付）。',
        '',
        ...effectiveLines(config, effective),
        '',
        '什么算"满足必填类型"（presence ≠ success）：`command`/`test` 行必须 `exitCode=0`、有 `command`、且捕获到真实输出；失败的运行照旧会被记录（有参考价值），但**不会**计入交付检查表，`manual` 声明永远不能顶替必填类型。',
        '',
        '门禁必须同时满足四条（`requireGate=true` 时生效），缺一条即拒绝：',
        '1. `gate.scope.full=true`（没有 `scope` 字段的旧记录不算完整覆盖）；',
        '2. `gate.results.length > 0`（没验证任何命令的 PASS 不是证据）；',
        '3. 台账里有对应的 `kind=gate` 行（`data.gateId` 匹配）——手工写 `gates/*.json` 会被判为伪造；',
        '4. 门禁**严格晚于**最新一条 `command`/`test` 证据（同一毫秒也算陈旧，需重跑 `quality_gate_run`）。',
        '',
        '- 只有确定性的 `PASS` 才能签发回执；`WARN`/`BLOCK`/未跑门禁/规格未审批/`mission.status=blocked` 都会写进拒绝报告，并给出下一步工具调用。',
        '- 交付前核对工作区指纹（`requireCleanTree=true` 时）：receipt 绑定门禁观测到的工作区状态（比对时排除 `.dsh/` 台账目录）；非 git 工作区只标注"无法核对（非 git 工作区）"，不阻断交付，但报告不会声称核对过。',
        '- 回执（receipt）是不可变工件（write-once）：重复调用 `mission_complete` 不会覆盖它，也不会重复签发。',
        '- mission 解析顺序：显式 `missionId` → 本会话绑定的 mission → 委派父会话的 mission；**不会**回退到"工作区里最新的 mission"，解析不到时请显式传 `missionId` 或用 `orchestrate start` / `spec_create` 建立绑定。',
        '',
        '`force=true` 只放松"必填证据类型"检查，并且会强制写入一条 `manual` 证据留痕；它**绝不**能绕过质量门禁（含伪造/部分覆盖）、未审批的规格、`blocked` 状态或证据陈旧。',
        '',
        '### 交付之后：把回执绑到版本上（release_record / release_notes / release_status）',
        '',
        '回执回答"这个 mission 交付了"，**不回答"哪个版本包含它"**：不记录版本，事后就只能翻 git 历史猜。',
        '- `release_record({ version, tag?, missionIds?, note? })`：把一个版本记进发布台账（`<root>/releases.jsonl`，append-only），行里带 tag、当前 revision（git 指纹）、mission 与回执 id，并写出发布说明 `<root>/releases/<version>.md`。',
        '- **什么时候记**：交付回执**已经存在之后**、打 tag 之前或同时——记录这一步本身就是把"回执"和"版本/tag"绑起来的动作；只打 tag 不记录，台账里仍然查不到"v1.2.0 里有什么"。',
        '- 省略 `missionIds` 时默认取"上一条发布记录之后签发的回执"对应的 mission（没有上一条时=全部已交付 mission）；一条都没有时拒绝记录空版本。列出的 mission 必须**已存在且有回执**，否则拒绝并点名。同一版本只能记录一次（重复即拒绝，并给出已有记录的日期）；非 git 工作区直接拒绝。',
        '- `release_notes({ version?, missionIds?, json? })`：按已登记工件（规格需求/验收标准、每个来源最新门禁裁决与 scope、回执绑定的证据类型、交付审批人、证据指到的文件）**生成**发布说明，只读返回；`release_record` 才落盘，不要手写 CHANGELOG。门禁没有 `scope`、证据没有记录文件路径时照实写"未记录"，不推断。',
        '- `release_status({ version?, json? })`：台账最新在前的已记录发布、**交付但未发布**的 mission（"我准备发什么"）、每个 mission 的最新回执；台账末尾被截断的行会被忽略并报出，不影响其余记录。',
        '- 发布说明是**投影**：它只包含已记录的工件，不会声称记录里没有的东西；没有 tag 的发布允许记录，但会被标注"未记录 tag"。',
    ].join('\n')
}

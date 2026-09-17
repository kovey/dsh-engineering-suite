/**
 * System-prompt contribution: the gate's contract, stated where the model can
 * actually read it (docs.md §9: "显式声明一切").
 * @module dsh-spec-gate/prompt
 */

import { SPEC_FORMAT_HINT } from 'dsh-eng-core'
import type { SpecGateConfig } from './config.js'

/** Section name (unique across the suite's prompt contributions). */
export const PROMPT_SECTION = 'eng:spec-gate'

/**
 * Build the section text.
 * @param config - resolved configuration.
 * @returns the prompt text (empty when the gate is disabled, which drops the section).
 */
export function sectionText(config: SpecGateConfig, projectFile?: string): string {
    if (!config.enabled) return ''
    const enforcement = config.enforce
        ? `任何写类工具（${config.writeTools.join(', ')}）在没有**已审批规格**时会被直接拒绝（不可绕过）。` +
          (config.enforceBoundaries
              ? '写操作的**目标路径**还会与规格的「文件边界」逐条比对：边界外的文件（含 `../`、绝对路径逃逸）同样会被拒绝。'
              : '')
        : '当前 enforce=false：写操作不会被拦截，但仍应遵循下面的规格流程。'
    const provenance =
        projectFile === undefined
            ? []
            : [
                  `本仓库使用项目级配置 \`${projectFile}\`：enforce=${config.enforce}、文件边界=${config.enforceBoundaries}、shell 策略=${config.shellPolicy}、审批模式=${config.approval}。`,
                  '（同一进程里的其它仓库各有自己的生效值；下面的规则以本仓库为准。）',
                  '',
              ]
    return [
        '## 规格门禁（spec-gate）',
        '',
        '本仓库要求先有**结构化规格**，再动代码。' + enforcement,
        '',
        ...provenance,
        '流程：',
        '1. `spec_create` — 提交规格：验收标准、文件边界、负面约束、测试设计章节。规格落盘到 `.dsh/specs/<mission-id>.md`。',
        '2. `test_design_review` — 评审测试设计（覆盖度 / 场景完整性 / 可执行性）；未通过不得进入审批。',
        '3. `spec_approve` — 取得人工审批；审批通过后 mission 状态变为 `spec-approved`，写操作放行。',
        '4. 实现 → `evidence_record`（登记验证输出）→ `quality_gate_run`（门禁必须覆盖最新证据）→ `mission_complete`。',
        '',
        '规格未审批时不要尝试"先写代码再补规格"：门禁是确定的，不会因为任务紧急而放行。',
        '**文件边界要写全**：把预计会改动的所有文件/目录都列进去（含测试文件，例如 `src/**`、`tests/**`）；',
        '边界外写入会被拒绝（`write`/`edit` 的目标路径，以及 `bash`/`pwsh` 命令里能识别出的写入目标都会检查），',
        '正确做法是 spec_create 更新边界并重新 spec_approve，而不是绕过。',
        '',
        '**负面约束的可执行子集**（加了前缀就会被门禁强制，不加前缀只有提示作用）：',
        '- `path:<glob>`：禁止改动匹配的路径（例如 `path:src/core/**`）；',
        '- `tool:<name>`：禁止调用某个工具（例如 `tool:web_search`）；',
        '- `cmd:<文本>`：禁止 shell 命令里出现该文本（例如 `cmd:rm -rf`）；',
        '- `argv:<正则>`：禁止任意工具的参数字符串匹配该正则（例如 `argv:"deploy"\\s*:\\s*true`）。',
        '把真正不可协商的约束写成这四类，其余用散文写清楚即可（spec_status 会列出哪些是强制、哪些是提示）。',
        '规格有变更（需求/验收标准/边界任何一项）时重新调用 `spec_create`，旧审批同时失效，需要重新 `spec_approve`。',
        '',
        SPEC_FORMAT_HINT,
    ].join('\n')
}

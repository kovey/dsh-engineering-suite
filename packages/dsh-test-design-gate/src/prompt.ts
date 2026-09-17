/**
 * System-prompt contribution: the test-design contract, stated where the model
 * can actually read it (docs.md §6, §9: "显式声明一切").
 *
 * The section is rendered per assembly, so the review policy it quotes is the
 * one that applies to **that agent's workspace** (`.dsh/test-design-gate.json`
 * may have refined it) — a model that reads a stale policy designs against the
 * wrong bar.
 *
 * @module dsh-test-design-gate/prompt
 */

import type { EffectiveTestDesignGateConfig, TestDesignGateConfig } from './config.js'

/** Section name (unique across the suite's prompt contributions). */
export const PROMPT_SECTION = 'eng:test-design-gate'

/**
 * Build the section text.
 * @param config - the profile configuration (the ceiling).
 * @param effective - the configuration of the assembling agent's workspace;
 * omitted when the workspace is unknown, in which case the profile values are
 * quoted.
 * @returns the prompt text (empty when the section is disabled, which drops it).
 */
export function sectionText(config: TestDesignGateConfig, effective?: EffectiveTestDesignGateConfig): string {
    if (!config.enabled || !config.prompt.enabled) return ''
    const active = effective?.config ?? config
    const origin = effective?.source === 'project' ? '项目级 `.dsh/test-design-gate.json`' : 'profile'
    const lines: string[] = [
        '## 测试设计门禁（test-design-gate）',
        '',
        '**测试用例就是规格的可执行形式**：规格（`.dsh/specs/<mission-id>.md`）里的 `## 测试设计` 章节不是可选项，' +
            '它是「需求 → 实现 → 验收」之间可自动运行的契约。',
        '',
        '规格必须满足：',
        '1. 同时包含 `### 正向场景` / `### 异常场景` / `### 边界场景` 三个表格（表头：用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准）；',
        '2. 每条验收标准（`AC-00n`）至少被一条用例的「覆盖验收标准」列引用；',
        '3. 用例可执行：具体的前置条件与操作步骤 + 可断言的预期结果，不要写 `...` / `TBD` / `待补充` 之类的占位符；',
        '4. 用例ID 形如 `TC-001` 且全局唯一，每条用例都必须声明它覆盖的编号（不得悬挂）。',
        '',
        `本工作区生效的评审参数（来源：${origin}）：minTextLength=${active.minTextLength}；strict=${active.strict}；allowDanglingCase=${active.allowDanglingCase}；requireAllScenarios=${active.requireAllScenarios}。`,
    ]
    if (active.strict) lines.push('当前 `strict=true`：每条验收标准还必须至少有一条异常或边界用例覆盖。')
    lines.push(
        '',
        '流程：`spec_create`（写规格 + 测试设计）→ `test_design_review`（自动评审：覆盖度 / 场景完整性 / 可执行性）→ `spec_approve`。',
        '`test_design_review` 未通过时 `spec_approve` 会直接拒绝审批（这不是建议而是门禁），评审结果落盘为 ' +
            '`.dsh/missions/<mission-id>/test-design-review.json` 与 `test-design-review.md`。',
        '评审未通过时按意见修改规格（重新调用 `spec_create`）后再次运行 `test_design_review`，不要尝试跳过。需要表格模板时调用 `test_design_template`。',
    )
    return lines.join('\n')
}

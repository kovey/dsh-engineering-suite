/**
 * System-prompt contribution: the pipeline contract, stated where the model can
 * actually read it (docs.md §9: 显式声明一切).
 * @module dsh-orchestrator/prompt
 */

import { describeGate, roleInstruction } from './pipeline.js'
import type { OrchestratorConfig } from './config.js'

/** Section name (unique across the suite's prompt contributions). */
export const PROMPT_SECTION = 'eng:orchestrator'

/**
 * Build the section text.
 * @param config - resolved configuration.
 * @returns the prompt text (empty when disabled, which drops the section).
 */
export function sectionText(config: OrchestratorConfig): string {
    if (!config.enabled) return ''
    const lines = [
        '## 流程编排（orchestrator）',
        '',
        '本仓库的工程流程被编排成一条**确定的阶段流水线**。阶段之间的推进只能通过 `orchestrate` 工具进行，不要凭自己的判断跳到后面的阶段。',
        '',
        '默认流水线（阶段 → 需要的插件）：',
    ]
    config.stages.forEach((stage, index) => {
        const role = roleInstruction(stage)
        // The number that actually applies: a built-in stage has no
        // `maxAttempts` of its own and takes `defaultMaxAttempts`.
        const budget = stage.maxAttempts ?? config.defaultMaxAttempts
        lines.push(`${index + 1}. \`${stage.id}\` — ${stage.prompt}`)
        lines.push(
            `   - 需要插件：${stage.requiredPlugins.length === 0 ? '无' : stage.requiredPlugins.join(', ')}；门禁：${describeGate(stage.gate)}；上限 ${budget} 次；角色：${role === undefined ? '无' : `${stage.role}（${role}）`}`,
        )
        if (stage.autoAdvance === true) {
            lines.push(`   - \`autoAdvance: true\`（宿主声明）：本阶段门禁通过时，宿主会在本轮结束时自动结算并进入下一阶段，模型不需要也无法触发/阻止它。`)
        }
    })
    lines.push(
        '',
        '规则：',
        '- `orchestrate({ action: "stages" })` 查看流水线与每个插件的挂载状态；`"status"` 查看当前 mission 走到哪一步。',
        '- `orchestrate({ action: "start" })` 创建/绑定 mission 并进入第一阶段；`"advance"` 结算当前阶段并进入下一阶段。',
        '- **插件未挂载时阶段不能进入**：所需插件不在 profile 里时，`orchestrate` 会拒绝并给出缺失的插件名、探测的 tool/service 与修复办法，不会"先推进再补"。',
        '- **角色绑定只是声明**：阶段声明 `role` 时，用文本里给出的 `team_delegate({ role: "…" })` 派发；角色的人设与工具白名单由 `dsh-role-guard` 执行，编排插件不授予任何权限。',
        '- **自动推进是宿主行为**：只有配置里写了 `autoAdvance: true` 的阶段才可能被宿主自动结算（且门禁必须已通过）；不要因为"上一步可能被自动推进"就假设阶段变了——始终以 `orchestrate({ action: "status" })` 的当前阶段为准。',
        '- **门禁失败是回退，不是跳过**：退出型门禁（质量验证、交付）不通过时，流程回退到该阶段的 `onFail` 阶段，并把失败记录落盘，绝不放行到下一阶段。',
        '- 同一阶段反复失败会触发**迭代熔断**：达到 `maxAttempts` 后 mission 被置为 `blocked`，需要人工介入（查看 `stages/`、`gates/`、`evidence.jsonl`）后用 `orchestrate({ action: "rerun" })` 重开。',
        '- 中途中断（会话重启/上下文丢失）用 `orchestrate({ action: "resume" })` 从 `mission.stage` 的断点继续。',
        '',
        '所有阶段的裁决只由确定性事实决定（`mission.spec.approvedAt`、`mission.testDesign`、`store.lastGate`、`store.readReceipts`），模型自述不算证据。',
    )
    return lines.join('\n')
}

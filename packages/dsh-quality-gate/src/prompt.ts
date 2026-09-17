/**
 * System-prompt contribution: what the gate will run and what it means.
 * @module dsh-quality-gate/prompt
 */

import { EXAMPLE_COMMANDS, type QualityGateConfig } from './config.js'

/** Prompt section name. */
export const PROMPT_SECTION = 'eng:quality-gate'

/**
 * Build the section text.
 * @param config - resolved configuration.
 */
export function sectionText(config: QualityGateConfig, projectFile?: string): string {
    if (!config.enabled) return ''
    const lines = ['## 质量门禁（quality-gate）', '']
    if (config.commands.length === 0) {
        lines.push(
            '⚠️ 当前没有配置门禁命令，验收标准无法被确定性验证。宿主需要在 quality-gate 的 config 中声明命令，例如：',
            '',
            '```yaml',
            EXAMPLE_COMMANDS,
            '```',
        )
        return lines.join('\n')
    }
    lines.push('门禁命令由**宿主配置**，你无法替换或跳过：', '')
    lines.push('| id | 命令 | 阶段 | 必需 |')
    lines.push('|----|------|------|------|')
    for (const command of config.commands) {
        lines.push(`| ${command.id} | \`${command.command}\` | ${command.phase} | ${command.required ? '是' : '否'} |`)
    }
    lines.push('')
    if (projectFile !== undefined) {
        lines.push(`（命令来自项目级配置 \`${projectFile}\`；同一进程里的其它仓库各有自己的命令集。）`, '')
    }
    lines.push('规则：')
    lines.push('- 必需命令失败 = `BLOCK`：本轮不允许收尾，门禁会把失败输出直接推回给你修复。')
    lines.push('- 只有非必需命令失败 = `WARN`：可以带风险交付，但要在汇报里说明。')
    lines.push('- 全部通过 = `PASS`：才能进入交付。交付顺序是 `evidence_record`（登记验证输出）→ `quality_gate_run`（让门禁覆盖最新证据）→ `mission_complete`；门禁之后再补登记命令/测试证据会让门禁变成"陈旧"，需要重跑一次门禁。')
    lines.push('- 不要通过删除测试、跳过用例、放宽断言来让门禁变绿——那是在破坏规格契约。')
    lines.push(
        '- **只有跑完整命令集的裁决才能放行**：`quality_gate_run` 带 `only`/`phase` 时属于部分运行，记录里会标记 `scope.full=false`，它不会清掉"待验证写"计数，也不构成交付依据；交付前必须不带 `only`/`phase` 跑一次。',
    )
    lines.push(
        '- 收尾门禁在两种情况下自动运行：本轮有过写类工具调用；或工作区相对最近一次门禁记录发生了变化（diff 指纹不同，可捕获 `bash`/`sed -i`、外部编辑器、`git checkout` 等改动）。工作区不是 git 仓库时第二种触发不生效。',
    )
    lines.push(
        '- 会话没有声明工作目录（`header.cwd`）时，自动门禁一律不跑（绝不在未知目录里执行宿主命令）；此时只能显式调用 `quality_gate_run`，报告里会说明用的是进程 cwd。',
    )
    if (config.afterWrite.enabled) {
        lines.push('- 每次成功写文件后会自动运行 `lint` 阶段的命令，失败会在工具结果里直接反馈。')
    }
    if (config.limits.maxChangedFiles > 0) {
        lines.push(
            `- 改动预算：一次任务的改动文件数不得超过 ${config.limits.maxChangedFiles}（\`.dsh/\` 台账不计入）。超限视为范围失控，门禁会阻断。`,
        )
    }
    return lines.join('\n')
}

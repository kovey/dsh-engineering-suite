/**
 * System-prompt contribution: what the gate will run and what it means.
 * @module dsh-quality-gate/prompt
 */

import { EXAMPLE_BUDGETS, EXAMPLE_COMMANDS, EXAMPLE_CONTRACTS, type QualityGateConfig } from './config.js'

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

    // --- budgets -----------------------------------------------------------
    lines.push('')
    lines.push('### 回归预算（`budget_check`）')
    if (config.budgets.length === 0) {
        lines.push(
            '"测试通过了"回答不了团队真正会回归的东西：命令慢了三倍、包体积翻倍、迁移不可逆。这类事实需要一个**数字**的界限，',
            '宿主还没配置任何预算（`config.budgets`）。示例：',
            '',
            '```yaml',
            EXAMPLE_BUDGETS,
            '```',
        )
    } else {
        lines.push('| id | 指标 | 命令 | 界限 |', '|----|------|------|------|')
        for (const budget of config.budgets) {
            const bounds = [
                budget.max === undefined ? undefined : `max=${budget.max}`,
                budget.min === undefined ? undefined : `min=${budget.min}`,
                budget.maxRegressionPercent === undefined ? undefined : `回归≤${budget.maxRegressionPercent}%`,
            ].filter((part): part is string => part !== undefined)
            lines.push(
                `| ${budget.id} | ${budget.metric} | \`${budget.command ?? `commandId=${budget.commandId ?? '?'}`}\` | ${bounds.join('，') || '(无界限)'} |`,
            )
        }
    }
    lines.push(
        '- 预算是**防回归**的，不是"达标"的：`maxRegressionPercent` 比的是**历史最佳值**（`<rootDir>/budgets.json`，只增不改），',
        '  所以一次变慢不会被下一次更慢的记录冲淡。第一次测量只记录基线并明说"还没有可比的历史值"——那不是通过，是"暂无数据"。',
        '- 测不到数字就是拒绝：正则匹配不到、捕获内容不是数字、命令没有正常退出时，`budget_check` 会**拒绝执行**（不写基线、不记门禁），',
        '  绝不会静默算作通过，也不会把"解析失败"退化成 0。',
        '- 预算不达标时，先分清"真实回归"（改代码）和"口径该改"（改 `config.budgets`——那是宿主/人的决定）。**不要为了让它变绿而放宽界限**。',
    )

    // --- contracts ---------------------------------------------------------
    lines.push('')
    lines.push('### 契约冒烟（`contract_check`）')
    if (config.contracts.length === 0) {
        lines.push(
            '宿主还没配置任何契约（`config.contracts`）：接口"还能不能用"目前没有被确定性检查。示例：',
            '',
            '```yaml',
            EXAMPLE_CONTRACTS,
            '```',
        )
    } else {
        lines.push('| id | kind | 命令 | 期望 |', '|----|------|------|------|')
        for (const contract of config.contracts) {
            const expect = contract.expect ?? {}
            const items = [
                expect.exitCode === undefined ? undefined : `exit=${expect.exitCode}`,
                ...(expect.stdoutContains ?? []).map((needle) => `含「${needle}」`),
                ...(expect.stdoutNotContains ?? []).map((needle) => `不含「${needle}」`),
                ...(expect.jsonPaths ?? []).map((entry) => `path:${entry.path}`),
            ].filter((item): item is string => item !== undefined)
            lines.push(`| ${contract.id} | ${contract.kind} | \`${contract.command}\` | ${items.join('、') || '(无)'} |`)
        }
    }
    lines.push(
        '- 契约检查证明的是"**声明的接口仍然按声明的方式行为**"，不是"接口是正确的"：正确与否由规格与评审回答，这里只回答"有没有坏掉"。',
        '- 每一条期望单独判定（列表，不是一个布尔）：JSON 路径不存在 = **失败**并点名该路径，绝不是"跳过"；stdout 不是合法 JSON 时每条路径判定都失败。',
        '- 没声明 `expect.exitCode` 时退出码**不判定**（报告会写明"未断言"）——契约只对它写下的东西负责，别把没写的东西当成已验证。',
        '- 这是冒烟门禁，不是 mock 框架：它跑的是宿主配置的真实命令，不拦截、不替身、不重写被测系统。',
    )
    return lines.join('\n')
}

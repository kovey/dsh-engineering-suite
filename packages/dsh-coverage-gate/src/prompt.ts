/**
 * The prompt contract for the test-effectiveness gate.
 *
 * Kept short on purpose: the model needs to know that coverage and flakiness are
 * GATES (not metrics to mention in the summary), how they are configured, and —
 * most importantly — what they do NOT prove. Everything else lives in the tool
 * descriptions.
 *
 * @module dsh-coverage-gate/prompt
 */

import { describeMutation, describeThresholds, type CoverageGateConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:coverage-gate'

/**
 * Render the section.
 * @param config - the resolved profile configuration.
 * @param projectFile - the repository's own config file, when it has one.
 */
export function sectionText(config: CoverageGateConfig, projectFile?: string): string {
    const lines: string[] = ['## 测试有效性门禁（coverage-gate）', '']
    lines.push(
        '其它门禁问"测试过不过"，这个门禁问**"测试到底测没测到"**：总覆盖率、**本次改动新增行**的覆盖率、有没有 flaky 用例，以及（可选）**变异测试**——把代码改坏，看看有没有断言会喊。它们都是门禁，不是汇报里的形容词。',
        '',
    )
    lines.push('工具：')
    lines.push(
        '- `coverage_check`：运行宿主配置的覆盖率命令，或读取它产出的报告（lcov / cobertura / go-cover / istanbul-json），与阈值比较后写一条 `PASS`/`BLOCK` 门禁记录。没有任何阈值时它**直接拒绝**——没有阈值就没有门禁。',
    )
    lines.push(
        '- `flaky_check`：把同一条命令重复运行 N 次（默认 3，上限 10），一旦同时看到通过与失败就提前结束，按 `flakyPolicy` 记 `BLOCK`/`WARN` 或只报告。',
    )
    lines.push(
        '- `mutation_check`：**覆盖率说"这行跑到了"，变异测试说"改坏它有没有断言会喊"**。它按配置的源文件 glob 生成小的文本变异（比较/布尔/算术/等值翻转、整数字面量 ±1），每个变异体写回源码、跑一次测试命令、再按字节还原，然后给出变异得分 = killed ÷ (killed + survived)，并列出**存活**的变异体——每一条都是"被执行却没有被断言"的代码。',
    )
    lines.push('- `coverage_status`：只读，看当前阈值、报告来源、mutation 配置、最近一条门禁和它的数字。')
    lines.push('')
    lines.push(`当前阈值：${describeThresholds(config.thresholds)}`)
    lines.push(
        `覆盖率来源：${config.coverageCommand === undefined ? '（未配置覆盖率命令）' : `命令 \`${config.coverageCommand}\``}${
            config.reportFile === undefined ? '，报告文件未配置' : `，报告文件 \`${config.reportFile}\`（格式 ${config.reportFormat}）`
        }`,
    )
    lines.push(
        `flaky：策略 ${config.flakyPolicy}，重复 ${config.flakyRepeats} 次${
            config.flakyCommand === undefined ? '，未配置 flaky 命令' : `，命令 \`${config.flakyCommand}\``
        }`,
    )
    lines.push(`mutation：${describeMutation(config.mutation)}`)
    if (projectFile !== undefined) {
        lines.push('', `（阈值/命令可能被本仓库的 \`${projectFile}\` 细化：以 \`coverage_status\` 的输出为准。）`)
    }
    lines.push('')
    lines.push('规则与边界：')
    lines.push(
        '- **覆盖率数字不是正确性**：行被执行过不等于行为正确。100% 覆盖的代码一样可以是错的——本门禁只回答"这些行有没有被测到"，正确性由质量门禁与评审负责。',
    )
    lines.push(
        '- **变异测试是可选且限时的**：默认关闭（`mutation.enabled=false`），因为它每个变异体都要跑一遍完整测试；`maxMutants`（默认 20）与 `timeBudgetMs`（默认 10 分钟）是上限，预算用尽就报**部分结果**，只覆盖真正跑过的变异体，**绝不外推**。',
    )
    lines.push(
        '- **`run-error` 不是 kill**：命令起不来、超时、被取消 = 这个变异体**未知**，既不算杀死也不算存活，单独报告、不计入得分。把跑不起来当成"测试发现了问题"就是自欺。',
    )
    lines.push(
        '- **变异操作符是词法的，不是解析器**：按行扫描并跳过字符串与注释（`// "true"` 不会被改），但它不理解语法——等价变异体（改完语义不变）不会被发现，改坏语法的变异体会因构建失败算作 killed。所以得分是套件弱点的**下界**，不是质量分；存活变异体要补断言，不要用调低阈值的方式让它变绿。',
    )
    lines.push(
        '- **没被插桩的行不能判定**：报告里没有的文件、只有汇总数字没有逐行明细的文件、以及新增的注释/文档行，都会被标成"无法判定"，既不算 0% 也不算 100%。',
    )
    lines.push(
        '- **flaky 是测试套件的缺陷**，不是产品的：不要靠重跑到达标、不要删掉或跳过不稳定的用例；要修它（隔离共享状态、注入时钟、固定随机种子、显式等待）。全部失败是"稳定失败"，那是真 bug，不是 flaky。',
    )
    lines.push(
        '- 不要通过调低阈值、换一个更好看的报告文件或自己写一份报告让门禁变绿：调用参数提供的阈值/报告会让门禁记录的 `scope.full=false`，而交付只认 `full=true` 的门禁。要改阈值必须由人改配置（`.dsh/**` 在信任根里，你写不了）。',
    )
    lines.push(
        '- 门禁之间不重叠：覆盖率命令失败（退出码非 0）本身就是 `BLOCK`，先修测试再谈覆盖率。',
    )
    return lines.join('\n')
}

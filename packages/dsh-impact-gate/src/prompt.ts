/**
 * The prompt contract for change impact.
 *
 * Kept short on purpose: the model needs to know that the analysis EXISTS, what
 * each of the three tools is for, and where its honesty ends. The details live in
 * the tool descriptions.
 *
 * @module dsh-impact-gate/prompt
 */

import type { ImpactGateConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:impact-gate'

/**
 * Render the section.
 * @param config - the resolved configuration (for the template state).
 * @param projectFile - the repository's own override file, when it has one.
 * @returns the prompt text.
 */
export function sectionText(config: ImpactGateConfig, projectFile?: string): string {
    return [
        '改动的影响面不用猜，用事实问：',
        '- 动手前用 `impact_tests` 取这次改动的**最小回归命令**：改动集来自 git diff（或显式 paths），测试来自三类证据',
        '  （import 了改动文件 / 与改动文件同目录 / 与改动文件同名）。',
        config.changeSource === 'auto'
            ? '- 改动集的来源：宿主挂载 `workspaceChanges` 时优先用它（宿主记录的**某一轮**改动），否则回退 git diff；两份报告都会写明这次是哪个来源、回退原因是什么。'
            : `- 改动集的来源被宿主固定为 \`${config.changeSource}\`：报告里写明来源；固定来源不可用时**拒绝执行**，不会静默换成另一个。`,
        '- 动手后用 `impact_analyze` 出一份评审者会读的报告：风险等级 + 判定理由、改动文件与新增行区间、按导入距离分组的影响面、',
        '  选中的测试与选中理由、以及这次选择**看不见什么**。有 mission 时它把 JSON 产物与一条 `artifact` 证据写进',
        '  `.dsh/missions/<id>/impact/`；`impact_status` 只读回看配置、阈值与最近一次分析。',
        config.testCommandTemplate === ''
            ? '- ⚠️ 宿主尚未配置 `testCommandTemplate`：`impact_tests` 会**拒绝**执行——它不猜 runner（猜错会渲染出一条看起来合理、实际什么都没跑的命令）。'
            : `- 测试命令模板来自宿主配置（${projectFile ?? '.dsh/impact-gate.json'} 可覆盖）：\`${config.testCommandTemplate}\``,
        '- 诚实边界：这是**文件级导入可达性**，不是调用图。接口分派、依赖注入、反射、字符串查表、动态 import、跨进程边界都',
        '  **不产生 import 边**，所以选中的测试是**必要**集合（"先跑这些"），不是"其余可以跳过"的证明；跳过其余只能是宿主用',
        '  `fullTestCommand` 显式对照之后的决定。',
        '- 风险等级由 `RISK_RULES` 阈值判定，不是判断；没有任何测试覆盖一律 high。改阈值等于改口径，是代码改动，需要 review。',
        '',
        '不稳定用例（flaky）不当成"重跑一次就绿了"：',
        '- `flaky_plan` 把不稳定数据变成**计划**：每个用例恰好落一类——稳定 / 隔离 / 查根因 / 疑似仪器；',
        '  "疑似仪器"是失败输出匹配了 `flaky.signatures`（超时、端口被占用、时钟、网络、资源）——先修环境，别急着隔离一条健康的用例。',
        '- **隔离是向未来借的债，不是修复**：每条隔离必须有 `owner` 与到期时间（`flaky.quarantineMaxDays`，默认 14 天）。',
        config.flaky.owner === undefined
            ? '  ⚠️ 当前没有配置 `flaky.owner`：`flaky_plan` 会**拒绝**给出隔离命令（没有负责人的隔离等于没人管）。请由人指定负责人。'
            : `  当前 owner=${config.flaky.owner}。`,
        '- **过期的隔离是升级项**："要么修，要么删，不能继续挂着"。本插件只渲染"写入隔离台账"的命令，**绝不自己执行**：让一条用例闭嘴是人的决定。',
        '- `flaky_status` 只读：当前隔离清单、已过期的、以及**被隔离后最近 N 次运行再没出现过**的用例——隔离后被删除/改名，等于覆盖静默消失。',
    ].join('\n')
}

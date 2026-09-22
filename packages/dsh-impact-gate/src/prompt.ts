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
    ].join('\n')
}

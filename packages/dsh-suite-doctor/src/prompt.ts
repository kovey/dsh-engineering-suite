/**
 * The prompt contract for the self-check.
 *
 * Two things the model must know and would otherwise learn the hard way:
 * `suite_status` is the map of everything else, and `unknown` is not a pass.
 * The state vocabulary is quoted verbatim from `dsh-eng-core`'s doctor, so the
 * prompt, the tool output and the offline script all speak one language.
 *
 * @module dsh-suite-doctor/prompt
 */

import type { SuiteDoctorConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:suite-doctor'

/**
 * Render the section.
 * @param config - the resolved configuration (for the expected plugin set).
 * @returns the prompt text.
 */
export function sectionText(config: SuiteDoctorConfig): string {
    return [
        '套件自检（`suite_status`）是一个入口回答"我们在哪 / 配了什么 / 缺什么"：',
        '- **会话开始时**先跑一次（`suite_status({ json: true })` 给机器读）；**声称"可以交付"之前**再跑一次，',
        '  不要凭记忆断言门禁齐全、插件在线或证据已备。',
        '- 四种状态：✅ `ok` 已就绪；⚠️ `partial` 存在但不完整（例如插件已挂载却没注册签名工具）；',
        '  ❌ `missing` 必需项缺失；❔ `unknown` **无法判断**（读不到，或该事实只存在于运行时）。',
        '- **`unknown` 不是通过**：它表示"没读到"，不是"没问题"。把 `unknown` 当作尚未完成处理，',
        '  并照报告里的"下一步"补齐；报告里的插件名、配置键与命令都是字面值。',
        '- 它**只读**：不写门禁记录、不落盘、不改 mission，也**不授予任何权限**——它只描述现状。',
        `- 本部署期望的插件（${config.expectedPlugins.length} 个）：${config.expectedPlugins.join('、')}。`,
    ].join('\n')
}

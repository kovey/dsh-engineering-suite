/**
 * The prompt contract for the standards gate.
 *
 * Kept short on purpose: the model needs to know that structural quality is a
 * GATE (not a suggestion), that the thresholds belong to the repository, and
 * that loosening the ratchet requires a person. The details live in the tool
 * descriptions.
 *
 * @module dsh-standards-gate/prompt
 */

import type { StandardsGateConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:standards-gate'

/**
 * Render the section.
 * @param config - the resolved configuration (for the enforce mode).
 * @param projectFile - the repository's own standards file, when it has one.
 * @returns the prompt text.
 */
export function sectionText(config: StandardsGateConfig, projectFile?: string): string {
    return [
        '结构规范是门禁，不是建议：',
        `- 目标仓库的规范/thresholds 由仓库自己拥有（${projectFile ?? config.standardsFile}），你**不能**修改它——`,
        '  `.dsh/**` 在信任根内，写工具会被拒绝；要改阈值或豁免必须由人来改。',
        '- 交付前跑 `standards_check`：**新增**违规会让门禁失败（基线里已接受的存量违规不算）。',
        '- 出现新增违规时的正确顺序：改代码（拆文件/拆函数、早返回代替深层嵌套、抽掉超长 if 分支、收敛导出面、修正依赖方向）',
        '  → 确有理由的路径写进 `exempt` / 按目录放宽阈值（人来做） → 存量债务才用 `standards_check({ accept: true, note: "原因" })`，',
        '  而那一步**需要人工批准**。',
        '- 规范只覆盖可机械判定的部分（行数、嵌套、分支大小、参数、导出面、依赖方向、循环依赖）；',
        '  "高内聚、命名、抽象是否多余"这类判断**不要假装被门禁覆盖**：用 `standards_review` 派只读评审者按 rubric 看，',
        '  它的结论是**意见**（可复核但要人拍板），不构成门禁裁决。',
        config.enforce === 'warn'
            ? '（宿主当前设 enforce=warn：违规只报告、不阻断交付。）'
            : config.enforce === 'off'
              ? '（宿主当前设 enforce=off：standards_check 只度量报告，不写门禁记录。）'
              : '',
    ]
        .filter((line) => line !== '')
        .join('\n')
}

/**
 * The prompt contract for the supply-chain gate.
 *
 * Kept short on purpose: the model needs to know that secrets and dependency
 * changes are GATED, that a new dependency needs a person, and — most
 * importantly — what the gate does NOT prove. The details live in the tool
 * descriptions.
 *
 * @module dsh-supply-chain-gate/prompt
 */

import type { SupplyChainGateConfig } from './config.js'
import { SECRET_RULES } from './secrets.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:supply-chain-gate'

/**
 * Render the section.
 * @param config - the resolved configuration (for the switches it reports).
 * @param projectFile - the repository's own config file, when it has one.
 * @returns the prompt text.
 */
export function sectionText(config: SupplyChainGateConfig, projectFile?: string): string {
    const lines = [
        '供应链与密钥是门禁，不是建议：',
        `- 交付前跑 \`secret_scan\`（默认只看本次**新增行**，${SECRET_RULES.length} 条规则 + 熵检测）：命中即 BLOCK。`,
        '- **绝不**把密钥写进代码、提交信息、工具参数或报告里；发现已提交的密钥要当作已泄露——先删、再去平台轮换。',
        '  报告与 artifact 里的摘要都是脱敏的（前 4 + 后 2 位 + 长度）——不要试图让工具把原值打出来。',
        config.deps.requireApprovalForNewDeps
            ? '- 新增依赖需要**人工批准**（`dependency_audit` 一次列出全部新增依赖）：审批被拒或通道不可用都是 BLOCK。'
            : '- ⚠️ 宿主关闭了新依赖审批：新增依赖只报告、不阻断（这是宿主决定）。',
        '- 锁文件变了而它的声明文件没变（孤儿变更）也是 BLOCK：那正是"悄悄钉一个版本"的形状。',
        `- 诚实边界：规则 + 熵是**网**，不是证明。一次干净的扫描只说明"没有匹配到模式"，**不等于**"仓库里没有密钥"；`,
        '  同理 `dependency_audit` 只回答"依赖变化有没有人看过 / 配置的审计命令有没有报已知漏洞"，',
        '  **不回答**"这个依赖是否可信"；`govulncheck` / `pip-audit` 的报告里没有 severity，未分类条目只报告不阻断（要阻断就把它加进 block）。',
        projectFile === undefined ? '' : `- 本仓库的密钥豁免在 \`${config.secretScan.allowlistFile}\`（由人维护，模型改不了 .dsh/**）：过期条目不算豁免。`,
    ]
    return lines.filter((line) => line !== '').join('\n')
}

/**
 * The prompt contract for the interaction layer.
 *
 * Kept short on purpose. The model needs three things and nothing more: which
 * tool answers which question, that "no channel" is a refusal rather than a
 * default, and that a ledger row records what happened without granting
 * anything. The mechanics (tokens, timeouts, the approver list) live in the
 * tool descriptions and the README.
 *
 * @module dsh-interaction-gate/prompt
 */

import type { EffectiveConfig } from './config.js'
import { describeSource } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:interaction-gate'

/**
 * Render the section.
 * @param effective - the resolved configuration plus its provenance.
 * @param channels - the channel capability report, when the registry has one.
 * @param problems - configuration problems worth naming in the prompt.
 * @returns the prompt text.
 */
export function sectionText(
    effective: EffectiveConfig,
    channels: readonly { name: string; canAsk: boolean; canNotify: boolean; reason: string }[] = [],
    problems: readonly string[] = [],
): string {
    const askable = channels.filter((channel) => channel.canAsk)
    const notifiable = channels.filter((channel) => channel.canNotify)
    return [
        '需要人拍板的时刻走本套件自己的交互层（不是宿主的 approval 弹窗，手机/无头会话同样能回答）：',
        '- `interaction_ask`：**真的需要人决定**时才用（规格/交付/放宽门禁/新增依赖这类）。每个提问带一个一次性令牌，',
        '  答案必须对得上声明选项；没有可用通道、超时、回答者不在项目审批人名单、答非所问 → 一律**拒绝**，绝不由你替人猜一个"是"。',
        '- `interaction_notify`：状态变化（门禁 BLOCK、阶段完成、环境变更）。**通知不是许可**：推送失败不会让门禁通过，也不会让它失败。',
        '- `interaction_progress`：长阶段报"还在跑"。它**不是日志**——同样的内容会在窗口内被去重抑制，别拿它当调试输出。',
        '- `interaction_status`：只读的体检（通道能力、生效配置、审批人名单、台账里**未决定**的提问）。',
        `- 生效配置来源：${describeSource(effective)}${problems.length === 0 ? '' : `（${problems.length} 条配置问题，见插件日志）`}；` +
            `提问超时上限 ${effective.config.askTimeoutMs}ms（只能缩短）；审批人名单${effective.config.requireApproverList ? '**必须**' : '不强制'}。`,
        channels.length === 0
            ? '- ⚠️ 当前**没有注册任何通道**：`interaction_ask` 会直接拒绝，`interaction_notify` 会报告推送失败——需要人决定的事就该停下来找宿主装通道，而不是自己决定。'
            : `- 通道：可问 ${askable.length} 个（${askable.map((channel) => channel.name).join(', ') || '无'}）、可推送 ${notifiable.length} 个（${notifiable.map((channel) => channel.name).join(', ') || '无'}）` +
              `${askable.length === 0 && channels.length > 0 ? '——只能推送、收不到答案的通道问不了人，`interaction_ask` 会如实拒绝。' : '。'}`,
    ].join('\n')
}

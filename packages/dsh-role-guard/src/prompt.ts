/**
 * System-prompt contribution: the role model and the delegation contract.
 * @module dsh-role-guard/prompt
 */

import type { RoleGuardConfig } from './config.js'
import type { RoleRegistry } from './roles.js'

/** Prompt section name. */
export const PROMPT_SECTION = 'eng:role-guard'

/**
 * Build the section text.
 * @param config - resolved configuration.
 * @param registry - roles of the current workspace (may be empty).
 */
export function sectionText(config: RoleGuardConfig, registry: RoleRegistry | undefined): string {
    if (!config.enabled) return ''
    const roles = registry?.list() ?? []
    const lines = [
        '## 角色与最小权限（role-guard）',
        '',
        '不要用通用 subagent 派活：需要分工时使用 `team_delegate`，它按角色文件分配 persona、模型和**工具白名单**。',
        '白名单由宿主强制执行——白名单外的工具在子 Agent 的工具列表里根本不存在，调用只会失败，无法绕过。',
        '',
        '角色的**技能白名单**（`skills`）同样由宿主强制，但发生在**调用时**：子 Agent 加载白名单外的技能会被宿主拒绝。',
        '技能目录是全局的、只增不减（分层注册表无法按子 Agent 裁剪），所以目录里列出某个技能 ≠ 你有权加载它。',
        '`skills` 为空的角色没有技能限制。',
        '',
    ]
    if (roles.length > 0) {
        lines.push('可用角色：')
        for (const role of roles) {
            const tools = role.tools.length > 0 ? role.tools.join('/') : `全部（deny: ${role.deny.join('/') || '无'}）`
            const skills = role.skills.length > 0 ? role.skills.join('/') : '不限'
            lines.push(
                `- \`${role.id}\`（${role.name}，${role.mode === 'read' ? '只读' : '可写'}）：${role.description || '（未填写说明）'}；工具：${tools}；技能：${skills}`,
            )
        }
        lines.push('')
    } else {
        lines.push('（当前工作区没有可用角色文件：把角色 .md 放到 `.dsh/roles/` 下。）')
        lines.push('')
    }
    lines.push(
        `职责分离是硬约束：设计、实现、审批不由同一个 Agent 完成；审查/验证类角色必须使用 ${roles
            .filter((role) => role.mode === 'read')
            .map((role) => `\`${role.id}\``)
            .join('、') || '只读角色'}，不要用可写角色做审查。`,
    )
    return lines.join('\n')
}

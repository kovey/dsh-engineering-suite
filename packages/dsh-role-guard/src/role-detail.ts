/**
 * The full view of one role (`role_list { role }`).
 *
 * Split out of `tools.ts` so the tool registry stays readable: the detail is a
 * rendering concern (and the structural ratchet measures both files).
 *
 * The model line names both directions of a `model: @class` reference: a WRONG
 * class name must look unusable here before someone tries to dispatch it, and an
 * unconfigured class must look like what it is — a fallback to the host default.
 *
 * @module dsh-role-guard/role-detail
 */

import type { Role } from './roles.js'

/**
 * The full view of one role.
 * @param role - the resolved role.
 */
export function renderRoleDetail(role: Role): string {
    const model =
        role.provider === undefined && role.model === undefined
            ? '(继承父 Agent)'
            : `${role.provider ?? ''}${role.model === undefined ? '' : `/${role.model}`}`
    return [
        `id: ${role.id}`,
        `name: ${role.name}`,
        `mode: ${role.mode}`,
        `tools: ${role.tools.join(', ') || '(继承全部，deny: ' + role.deny.join(', ') + ')'}`,
        `skills: ${role.skills.length > 0 ? `${role.skills.join(', ')}（宿主在调用时强制）` : '(未声明 = 不限制)'}`,
        `model: ${model}`,
        ...(role.modelProblems === undefined || role.modelProblems.length === 0
            ? []
            : ['model 问题（类名写错，不会被当成"未配置"放过）：', ...role.modelProblems.map((problem) => `- ${problem}`)]),
        ...(role.modelNote === undefined ? [] : [`model note: ${role.modelNote}`]),
        `source: ${role.source}`,
        '',
        '--- persona ---',
        role.persona,
    ].join('\n')
}

/**
 * The prompt contract for the deployment gate.
 *
 * Kept short on purpose: the model needs to know that deployment is a GATED
 * phase (not a shell command it composes), which tool belongs to which step, and
 * — most importantly — what this plugin does NOT prove. Everything else lives in
 * the tool descriptions and the reports.
 *
 * @module dsh-deploy-gate/prompt
 */

import { describeCommands, verifyNeedsApproval, type DeployGateConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:deploy-gate'

/**
 * Render the section.
 * @param config - the resolved profile configuration.
 * @param projectFile - the repository's own config file, when it has one.
 */
export function sectionText(config: DeployGateConfig, projectFile?: string): string {
    const lines: string[] = ['## 部署门禁（deploy-gate）', '']
    lines.push(
        '部署是一个**门禁阶段**，不是"把命令敲一遍"：`deploy_plan`（算清楚能不能上）→ go/no-go 裁决 → 人工批准 → `deploy_run`（执行宿主声明的命令）→ `deploy_verify`（部署后验证）→ 出事时 `deploy_rollback`（执行已声明的回滚）。每一步都留证据。',
        '',
    )
    lines.push('工具：')
    lines.push(
        '- `deploy_plan`：对某个已声明环境做 go/no-go（mission 已交付 + 回执绑定当前 revision + 质量门禁 PASS 且不早于最新证据 + 无挂起提问 + 可选门禁年龄/工作区干净 + 环境声明了部署/验证/回滚命令）。只读，环境不被触碰；列出**将要执行的确切命令**与回滚路径。',
    )
    lines.push(
        '- `deploy_run`：再算一次 go/no-go（不通过就直接拒绝并列出未通过项），需要审批的环境先问人（`interaction` 服务——它的 `ask()` 接缝或通道注册表，或宿主审批通道；**没有可用通道就拒绝**，等人有 `approvalTimeoutMs` 截止时间，超时不是同意），批准之后**重新观察**工作区与检查（revision/脏工作区在等卡片期间变了 → 拒绝），然后按配置顺序以 argv 执行部署命令（不经 shell）；命令非零退出立即停止并带出输出尾部。台账不可写时**一条命令都不执行**（没有台账行就没有这次上线的记录）。记录一条门禁 + 一行台账（revision / 审批人 / 审批消息 id）。`dryRun` 只打印会发生什么，不写任何东西。',
    )
    lines.push(
        '- `deploy_verify`：执行环境的验证命令，带有限次重试与退避；**审批与 `deploy_run` 走完全相同的路径**（默认跟随该环境的 `requiresApproval`，宿主可用 `verifyApproval` 收紧，只有宿主可以关掉）——**没人批准的验证不执行**：写一行 `refused` 与一条 BLOCK，说明"验证未执行，因为没有人批准"。尝试用尽 → BLOCK，并且报告里**原样列出该环境声明的回滚命令**。有 mission 时它只验证台账里**成功且仍然上线、revision 与当前工作区一致**的那次部署——"只验证"的 PASS 不许被当成"部署已执行且通过"。',
    )
    lines.push('- `deploy_rollback`：与 `deploy_run` 相同的审批规则；环境没有声明回滚命令 → 拒绝（未演练的回滚不是回滚）。')
    lines.push('- `deploy_status`：只读：已声明环境（是否需要审批、回滚是否已声明）、台账摘要、回滚目标、最近的门禁、挂起的提问。')
    lines.push('')
    const names = config.environments.map((environment) => environment.name)
    lines.push(`当前声明的环境（${names.length} 个）：${names.join(', ') || '(无——每个工具都会拒绝)'}`)
    for (const environment of config.environments) {
        lines.push(
            `- ${environment.name}（kind=${environment.kind}，${environment.requiresApproval ? '需要人工批准' : '无需批准'}，验证${verifyNeedsApproval(config, environment) ? '需要人工批准' : '无需人工批准'}）：部署 ${describeCommands(environment.deployCommands)}；验证 ${describeCommands(environment.verifyCommands)}；回滚 ${describeCommands(environment.rollbackCommands)}`,
        )
    }
    lines.push(
        `go/no-go 上限：requireReceipt=${config.goNoGo.requireReceipt}、requireGateNewerThanEvidence=${config.goNoGo.requireGateNewerThanEvidence}、requireNoPendingAsks=${config.goNoGo.requireNoPendingAsks}、pendingAsksUnverifiable='${config.goNoGo.pendingAsksUnverifiable}'（查不到挂起提问时默认按不通过处理）、maxGateAgeMinutes=${config.goNoGo.maxGateAgeMinutes}、requireCleanTree=${config.goNoGo.requireCleanTree}；验证最多 ${config.verifyRetries} 次，间隔 ${config.verifyBackoffMs}ms；审批等待上限 ${config.approvalTimeoutMs}ms（超时 = 拒绝）；验证审批规则 verifyApproval='${config.verifyApproval}'。`,
    )
    if (projectFile !== undefined) {
        lines.push('', `（环境与超时可能被本仓库的 \`${projectFile}\` 细化：以 \`deploy_status\` 的输出为准。它不能关闭 profile 要求的人工审批。）`)
    }
    lines.push('')
    lines.push('规则与边界：')
    lines.push(
        '- **不要自己拼部署命令**：本插件只执行宿主配置里声明的命令（argv 直传，shell 元字符一律拒绝）。你选的是**环境名**，不是命令行。要加一步，就请人改配置（`.dsh/**` 与 profile 都不在你的可写范围内）。',
    )
    lines.push(
        '- **生产需要人**：kind=production（以及任何未声明 kind 的环境）默认必须人工批准；审批被拒绝/取消/无通道 → 不执行任何命令。不要为了让流程走通而把 `requiresApproval` 关掉——那是宿主的决定。',
    )
    lines.push(
        '- **回滚必须已声明**：没有声明 rollbackCommands 的环境，`deploy_rollback` 拒绝执行，`deploy_plan` 也不会判"可以上"。未演练的回滚不是回滚。',
    )
    lines.push(
        '- **拒答也要留痕**：go/no-go 不通过、审批被拒、或**验证没有人批准**时，本插件会写一行 `refused` 台账（有 mission 时再写一条 BLOCK 门禁），所以"试过但被拦下"是可见的。',
    )
    lines.push(
        '- **诚实的边界**：本插件执行**已声明的步骤并记录证据**——它无法证明环境实际发生了什么，超出命令自身的输出之外（健康检查过了不等于线上没问题，回滚命令退出码 0 不等于流量真的切回去了）。它也不知道有人在插件之外手动部署过：台账只记录经过本插件的动作。',
    )
    lines.push(
        '- **不要把凭据写进命令行**：配置里的命令会原样进入门禁记录与报告（与质量门禁同一规则）。口令/token 请用环境变量或凭据文件，让被调用的脚本自己去读。',
    )
    return lines.join('\n')
}

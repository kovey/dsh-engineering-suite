/**
 * Optional system-prompt contribution (docs.md §9: "显式声明一切").
 *
 * Disabled by default (`prompt.enabled: false`) — the audit trail is a bypass
 * observer, so it only tells the model about itself when the host asks for it.
 *
 * @module dsh-audit-trail/prompt
 */

import type { AuditTrailConfig } from './config.js'

/** Section name (unique across the suite's prompt contributions). */
export const PROMPT_SECTION = 'eng:audit-trail'

/**
 * Build the section text.
 * @param config - resolved configuration.
 * @returns the prompt text (empty when disabled, which drops the section).
 */
export function sectionText(config: AuditTrailConfig): string {
    if (!config.enabled || !config.prompt.enabled) return ''
    const snapshot = config.snapshot.enabled
        ? `写类工具（${config.writeTools.join(', ')}）在运行前会把目标文件的**当前内容**快照到 \`.dsh/audit/snapshots/\`，因此按轮次回滚是可行的。`
        : '当前 `snapshot.enabled=false`：只记录调用链，**没有**写前快照，`audit_rewind` 无法恢复内容。'
    return [
        '## 审计与追溯（audit-trail）',
        '',
        '每一次工具调用都会被旁路记录到 `.dsh/audit/<sessionId>.jsonl`（digest + 摘要，不存文件正文）。' + snapshot,
        '',
        '- `audit_report` — 查看当前会话的调用总数、按工具计数、失败调用、写调用快照可用性与最近若干行。',
        '- `audit_rewind` — 回滚到某一轮次之前：默认 dry-run，只有 `dryRun:false` 且 `confirm:true` 才真正写盘。',
        '',
        '`audit_rewind` 是**工作区文件回滚**，只依据本插件记录的写前快照：它不修改 git 历史，也不回滚快照覆盖不到的改动（如 bash 的副作用）。回滚前先用 dry-run 确认清单。',
    ].join('\n')
}

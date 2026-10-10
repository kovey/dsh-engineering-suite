/**
 * The prompt contract for the knowledge base.
 *
 * Short, because the details live in the tool descriptions. What matters here
 * is the behaviour a model gets wrong by default: answering a project question
 * from memory instead of from the index, and then presenting the answer without
 * a citation. The section therefore states the three rules in the order they
 * are usually broken — search first, cite everything, say "the index has
 * nothing" instead of guessing — plus the two things the index is NOT (a gate
 * record's authority, and a semantic search).
 *
 * @module dsh-knowledge-base/prompt
 */

import type { KnowledgeBaseConfig } from './config.js'

/** Section name registered with `ctx.systemPrompt`. */
export const PROMPT_SECTION = 'eng:knowledge-base'

/**
 * Render the section.
 * @param config - the resolved configuration (for the index location).
 * @param projectFile - the repository's own override file, when it has one.
 * @returns the prompt text.
 */
export function sectionText(config: KnowledgeBaseConfig, projectFile?: string): string {
    return [
        '项目知识库：关于"这个仓库"的问题，先查索引再回答：',
        `- 问题涉及规格/需求/决策/交付台账/文档/代码（"AC-003 是什么"、"为什么选 A 不选 B"、"谁改的"、"在哪里实现"）时，先 \`kb_search\`，`,
        '  **不要凭记忆回答**。索引在 `' + config.indexDir + '`（词法索引：BM25 + 字段加权 + id 精确命中，没有向量、没有网络、没有模型）。',
        '- **每条结论都要带引用**：用命中给出的 `path:from-to`（形如 `.dsh/specs/x.md:24-30`）。引用不到就不要写这句话——',
        '  宁可说"索引里没有"，也不要给一段没有出处的结论。',
        '- 索引里没有 → 明确说"**索引里没有**"+ 你查了什么（关键词/来源过滤），再给出下一步（`kb_index` 重建、换关键词、用 id 再搜）。',
        '  不要用"一般来说…"把缺口补上：那正是知识库要防的事。',
        '- `kb_status` / `kb_search` 报告索引**过期**（相对当前 git 指纹）时必须转述：最近改动可能没进索引，先 `kb_index` 重建再引用。',
        '- 索引不是权威：门禁记录、回执、规格文件才是裁决依据；`trail`/`plan` 命中的是**摘要**（`path` 指向台账文件，`from-to` 是摘要行号），',
        '  引用前用摘要里的 id（`GATE-…`/`RCP-…`/`R-…`）复核原文。',
        '- 这是**词法**索引：换个说法可能召回不到（"登录"搜不到只写"鉴权"的段落）。搜不到时先换关键词、再试 id、再看 `kb_status` 的来源覆盖，',
        '  **搜不到不等于不存在**。',
        ...(projectFile === undefined ? [] : [`- 本仓库有自己的知识库配置（${projectFile}）：它只能收窄索引范围（停用来源、删减模式、降低上限），不能放宽。`]),
    ].join('\n')
}

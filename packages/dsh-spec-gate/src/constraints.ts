/**
 * Machine-checkable negative constraints (docs.md §1.2「负面约束（明确禁止的操作）」).
 *
 * A specification's constraints are written in prose, and prose cannot be
 * enforced. This module defines a small **declarative subset** that a gate can
 * check deterministically, while every other constraint stays advisory (the
 * model is still told about it, and the human still reviews it):
 *
 * ```markdown
 * ## 负面约束（禁止）
 * - path:src/core/**          # 不允许写这些路径
 * - tool:web_search            # 不允许调用这个工具
 * - cmd:rm -rf                 # shell 命令里不允许出现这个字符串
 * - argv:"deploy"\s*:\s*true   # 任意工具参数 JSON 不允许匹配这个正则
 * - 不得修改 dsh 核心代码       # 散文 → 提示级
 * ```
 *
 * The prefix is the whole contract: `path:` / `tool:` / `cmd:` / `argv:`. A line
 * without a recognised prefix is reported to the model and the human as
 * advisory instead of being silently treated as enforced.
 *
 * @module dsh-spec-gate/constraints
 */

import { pathMatchesPattern } from 'dsh-eng-core'
import type { AgentLike, MissionRecord } from 'dsh-eng-core'
import path from 'node:path'

/** The kinds a constraint can be written as. */
export type ConstraintKind = 'path' | 'tool' | 'cmd' | 'argv'

/** One parsed constraint. */
export interface ParsedConstraint {
    kind: ConstraintKind
    value: string
    /** The original line, for reports. */
    raw: string
}

/** The parse of a specification's constraint list. */
export interface ConstraintSet {
    /** Constraints the guard can enforce. */
    enforced: ParsedConstraint[]
    /** Constraints that remain prose (reported, never silently enforced). */
    advisory: string[]
}

const KINDS: readonly ConstraintKind[] = ['path', 'tool', 'cmd', 'argv']

/**
 * Parse the `negativeConstraints` of a specification.
 * @param lines - the constraint lines (leading `-` already stripped).
 * @returns the enforced subset plus the advisory remainder.
 */
export function parseConstraints(lines: readonly string[]): ConstraintSet {
    const enforced: ParsedConstraint[] = []
    const advisory: string[] = []
    for (const raw of lines) {
        const line = raw.trim().replace(/^[-*+]\s*/, '')
        if (line === '') continue
        const match = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(line)
        const kind = match?.[1]?.toLowerCase()
        const value = (match?.[2] ?? '').trim()
        if (match === null || !KINDS.includes(kind as ConstraintKind) || value === '') {
            advisory.push(line)
            continue
        }
        if (kind === 'argv') {
            try {
                new RegExp(value)
            } catch {
                advisory.push(`${line}（argv 正则无法编译）`)
                continue
            }
        }
        enforced.push({ kind: kind as ConstraintKind, value, raw: line })
    }
    return { enforced, advisory }
}

/** The tool call a constraint is evaluated against. */
export interface ConstraintCall {
    /** Tool name as registered. */
    tool: string
    /** Parsed arguments (the shape the tool receives). */
    args: unknown
    /** Workspace root used to resolve relative write targets. */
    cwd: string
    /** Shell command text, when the tool is a shell tool. */
    command?: string
    /** Paths the call would write (already extracted by the caller). */
    writeTargets: readonly string[]
}

/** A violated constraint, with the reason to show the model. */
export interface ConstraintViolation {
    constraint: ParsedConstraint
    reason: string
}

function relativeOf(cwd: string, target: string): string {
    return path.relative(cwd, path.resolve(cwd, target))
}

/**
 * Evaluate every enforced constraint of a mission against one tool call.
 * @param mission - the mission whose specification carries the constraints.
 * @param call - the pending call.
 * @returns the first violation, or `undefined` when the call is allowed.
 */
export function evaluateConstraints(mission: MissionRecord, call: ConstraintCall): ConstraintViolation | undefined {
    const { enforced } = parseConstraints(mission.spec?.negativeConstraints ?? [])
    for (const constraint of enforced) {
        if (constraint.kind === 'tool') {
            if (constraint.value === call.tool) {
                return {
                    constraint,
                    reason: `规格的负面约束禁止调用工具 \`${constraint.value}\`（mission ${mission.id}）。`,
                }
            }
            continue
        }
        if (constraint.kind === 'cmd') {
            if (call.command !== undefined && call.command.includes(constraint.value)) {
                return {
                    constraint,
                    reason: `规格的负面约束禁止命令中出现 \`${constraint.value}\`（mission ${mission.id}）。`,
                }
            }
            continue
        }
        if (constraint.kind === 'path') {
            for (const target of call.writeTargets) {
                const relative = relativeOf(call.cwd, target)
                if (pathMatchesPattern(constraint.value, relative) || pathMatchesPattern(constraint.value, target)) {
                    return {
                        constraint,
                        reason: `规格的负面约束禁止改动 \`${relative}\`（匹配 \`${constraint.value}\`，mission ${mission.id}）。`,
                    }
                }
            }
            continue
        }
        // argv: a regex over the serialized arguments (any tool).
        let serialized: string
        try {
            serialized = JSON.stringify(call.args ?? null)
        } catch {
            serialized = String(call.args)
        }
        if (new RegExp(constraint.value).test(serialized)) {
            return {
                constraint,
                reason: `规格的负面约束禁止这样的参数（匹配 /${constraint.value}/，mission ${mission.id}）。`,
            }
        }
    }
    return undefined
}

/** Render the constraint contract for prompts and reports. */
export function describeConstraints(lines: readonly string[]): string {
    const { enforced, advisory } = parseConstraints(lines)
    if (enforced.length === 0 && advisory.length === 0) return '(规格未声明负面约束)'
    const parts: string[] = []
    parts.push(`可机器校验 ${enforced.length} 条${enforced.length === 0 ? '' : `（${enforced.map((entry) => entry.raw).join('；')}）`}`)
    if (advisory.length > 0) {
        parts.push(`仅提示级 ${advisory.length} 条（加 \`path:\`/\`tool:\`/\`cmd:\`/\`argv:\` 前缀即可被门禁强制）`)
    }
    return parts.join('；')
}

/** Structural alias so callers do not need the harness type. */
export type { AgentLike }

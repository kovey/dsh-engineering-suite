/**
 * Which conversation an approval belongs to, decided by WORKSPACE (stage P3.2).
 *
 * Before this module there was exactly one approval conversation per host
 * (`im.approvalChatId`) and exactly one approver list per host. That is the right
 * default, and it is wrong the moment one host serves several repositories: a
 * card raised for repository A would land in the conversation configured for
 * repository B, and the people who answer B's approvals would be asked to
 * approve A's. Neither is a security hole by itself, but both make "who decided
 * this" untrue — and this suite would rather refuse than be untrue.
 *
 * The mapping is a HOST key (`im.approvals`), for the same reason the approver
 * list is: it decides WHERE a permission question goes and WHO may answer it. A
 * repository that could name its own approval conversation would be choosing
 * the room it is judged in, and one that could name its own approvers would be
 * whitelisting itself — the hole P3.1 closed. So the project file cannot express
 * any of this (a project `im` block is reported and ignored, as before), and the
 * one lever left to a repository is still `denyApprovers` (subtraction only).
 *
 * ## Resolution, in four steps (all four are testable without a host)
 *
 *  1. **Resolve the CALLING workspace with `realpath`.** A session may be
 *     started through a symlink (`~/work/app` → `/Volumes/src/app`), and the
 *     mapping is written in real paths. Comparing the raw strings would produce
 *     two names for one repository and match neither entry — the failure mode
 *     this step exists to prevent. A workspace that cannot be resolved matches
 *     nothing (an unresolved string is not evidence of anything), and the
 *     routing says so instead of silently pretending it was unmatched.
 *  2. **Match every entry**: a plain absolute path matches on a path boundary
 *     (`/a` matches `/a` and `/a/b`, never `/ab`); a pattern may use `*` (exactly
 *     one segment) and `**` (zero or more segments). Everything else is literal.
 *  3. **Pick the most specific**: the longest literal prefix wins, then the
 *     fewest wildcards, where a `**` counts twice (it is strictly more permissive
 *     than a `*`). `/a/b` therefore beats `/a/**`, and `/a/*` beats `/a/**`.
 *  4. **A tie is a REFUSAL**, naming both entries. Two entries of equal
 *     specificity both claim the workspace, so "which conversation is this
 *     approval about" has no answer — and picking one at random would be
 *     inventing a decision nobody made. The refusal is the honest outcome.
 *
 * ## What the mapping does NOT do
 *
 *  - it cannot express "these two branches of ONE repository use different
 *    conversations": the resolution is per workspace directory, and a branch is
 *    not a directory. That would need project-side configuration, which is
 *    exactly what this design refuses (see `docs/KNOWN-LIMITS.md`);
 *  - it does not touch the approver list unless an entry says `approvers`. An
 *    entry that omits it falls back to the host list, and every report says
 *    "fell back" rather than letting the reader assume the entry decided it;
 *  - it never reads a file inside a workspace. The mapping is profile
 *    configuration and nothing else.
 *
 * @module dsh-interaction-gate/workspace-mapping
 */

import fs from 'node:fs'
import path from 'node:path'

/** What happens to a workspace no entry matches. */
export type UnmappedWorkspacePolicy = 'refuse' | 'host-default' | 'local'

/** Every accepted value of `im.unmappedWorkspace`. */
export const UNMAPPED_WORKSPACE_POLICIES: readonly UnmappedWorkspacePolicy[] = [
    'refuse',
    'host-default',
    'local',
]

/**
 * `local` — an unmapped workspace does not use IM at all: the approval goes back
 * to the host's own approval seam (the terminal), and `interaction_ask` skips the
 * IM channel and uses whatever local channel can answer.
 *
 * Why this is not a hole: it never sends a card anywhere (the refusal to pick a
 * conversation is preserved), it can only LOSE the remote convenience. The one
 * case it must not silently do is `approvalVia=only`, which promises "IM or
 * nobody decides" — that combination is reported as a contradiction.
 */
/**
 * Default for `im.unmappedWorkspace`: an unmapped workspace is REFUSED.
 *
 * `host-default` is a deliberate, named decision an operator writes down; it must
 * never be the thing that happens when a mapping was forgotten. With `refuse`,
 * forgetting to add an entry costs a refusal that names itself, which is
 * recoverable — a card sent to the wrong repository's conversation is not.
 */
export const DEFAULT_UNMAPPED_WORKSPACE_POLICY: UnmappedWorkspacePolicy = 'refuse'

/** One `im.approvals` entry: a workspace key plus the routing it decides. */
export interface WorkspaceApprovalEntry {
    /** The host-declared workspace key: an absolute path, or a pattern with `*`/`**`. */
    workspace: string
    /** The conversation an ask in that workspace goes to (replaces `im.approvalChatId`). */
    chatId: string
    /**
     * The approvers for that workspace, when the entry overrides them.
     *
     * Absent = fall back to the host list (`im.approvers` / `im.approversFile`,
     * still minus `denyApprovers`). Present-but-empty is a real state: nobody may
     * approve there, and the approval path then refuses with
     * `refused:approvers-missing` instead of quietly using the host list.
     */
    approvers?: string[]
}

/** The `im`-block fields this stage adds (kept out of `config.ts` to avoid a cycle). */
export interface ImWorkspaceApprovalConfig {
    /** Usable entries, in declaration order (indices in reports are the DECLARED ones). */
    approvals: WorkspaceApprovalEntry[]
    /**
     * How many entries the host declared, invalid ones included.
     *
     * The difference between "no mapping was declared" (feature off, today's
     * behaviour) and "a mapping was declared but every entry is unusable" is the
     * difference between a default and a typo: the first must not refuse
     * anything, the second must refuse everything. `declared` is what tells them
     * apart — an empty usable list alone cannot.
     */
    approvalsDeclared: number
    /** Why single entries were ignored, in order (reported, never silent). */
    approvalsProblems: string[]
    /** What to do with a workspace no entry matches. */
    unmappedWorkspace: UnmappedWorkspacePolicy
}

/** The usable entries of `im.approvals`, plus what was ignored and why. */
export interface WorkspaceApprovalDeclaration {
    entries: WorkspaceApprovalEntry[]
    /** Declared count, invalid entries included (see {@link ImWorkspaceApprovalConfig.approvalsDeclared}). */
    declared: number
    problems: string[]
}

/** Options of {@link resolveWorkspaceApprovals}. */
export interface WorkspaceApprovalValidationOptions {
    /** Upper bound for a chat id (the same bound `im.approvalChatId` uses). */
    maxChatIdLength?: number
}

/** Default upper bound for a chat id (a platform chat id is short). */
const DEFAULT_MAX_CHAT_ID_LENGTH = 512

/** One line an operator can act on: which entry, and what is wrong with it. */
function entryLabel(index: number): string {
    return `im.approvals[${index}]`
}

function textOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate `im.approvals`.
 *
 * Every rule here fails CLOSED in the sense that matters: an entry that cannot be
 * applied contributes nothing (no chat id, no approvers), and the operator is
 * told which entry and why. Nothing is coerced — "a chat id I cannot parse" must
 * never become "the host's default chat" by accident, because that is exactly the
 * cross-repository misrouting this stage exists to stop.
 * @param raw - the untrusted `im.approvals` value.
 * @param warn - optional sink for the same problems (the plugin log).
 * @param options - the chat-id bound to apply.
 * @returns the usable entries, how many were declared, and every problem.
 */
export function resolveWorkspaceApprovals(
    raw: unknown,
    warn?: (message: string) => void,
    options: WorkspaceApprovalValidationOptions = {},
): WorkspaceApprovalDeclaration {
    if (raw === undefined) return { entries: [], declared: 0, problems: [] }
    const maxChatIdLength = options.maxChatIdLength ?? DEFAULT_MAX_CHAT_ID_LENGTH
    const problems: string[] = []
    const report = (message: string): void => {
        problems.push(message)
        warn?.(message)
    }
    if (!Array.isArray(raw)) {
        report(`im.approvals 必须是数组（收到 ${JSON.stringify(raw)}），已按"未配置映射"处理`)
        return { entries: [], declared: 0, problems }
    }
    const entries: WorkspaceApprovalEntry[] = []
    raw.forEach((value: unknown, index: number) => {
        const label = entryLabel(index)
        if (!isRecord(value)) {
            report(`${label} 必须是对象 { workspace, chatId, approvers? }（收到 ${JSON.stringify(value)}），已忽略该项（它不提供任何会话或审批人）`)
            return
        }
        const workspace = textOf(value['workspace'])
        if (workspace === undefined) {
            report(`${label}.workspace 必须是非空字符串（工作区绝对路径或含 * / ** 的模式），收到 ${JSON.stringify(value['workspace'])}，已忽略该项`)
            return
        }
        if (!path.isAbsolute(workspace)) {
            report(
                `${label}.workspace=${JSON.stringify(workspace)} 不是绝对路径：工作区键必须写成绝对路径（例如 "$HOME/work/app" 的展开形式），` +
                    '已忽略该项（相对路径只能按某个仓库解析，那会让映射随仓库移动）',
            )
            return
        }
        const chatId = textOf(value['chatId'])
        if (chatId === undefined) {
            report(`${label}.chatId 必须是非空字符串（平台会话 id，如 "oc_..."），收到 ${JSON.stringify(value['chatId'])}，已忽略该项`)
            return
        }
        if (chatId.length > maxChatIdLength) {
            report(`${label}.chatId 长度 ${chatId.length} 超过上限 ${maxChatIdLength}，已忽略该项（不像是一个会话 id）`)
            return
        }
        if (/\s|[\u0000-\u001f\u007f]/.test(chatId)) {
            report(`${label}.chatId 含空白或控制字符（多半是从别处粘进来的多余内容），已忽略该项（这样的 id 匹配不到任何会话）`)
            return
        }
        let approvers: string[] | undefined
        if (value['approvers'] !== undefined) {
            const declared = value['approvers']
            if (!Array.isArray(declared)) {
                report(`${label}.approvers 必须是平台用户 id 的字符串数组（收到 ${JSON.stringify(declared)}），已忽略该项（名单不可用时不能退回宿主名单）`)
                return
            }
            const ids: string[] = []
            for (const id of declared) {
                const trimmed = textOf(id)
                if (trimmed === undefined) {
                    report(`${label}.approvers 里有非字符串或空项（收到 ${JSON.stringify(id)}），已忽略该项（一条坏 id 会让"谁能审批"不确定）`)
                    return
                }
                if (!ids.some((known) => known.toLowerCase() === trimmed.toLowerCase())) ids.push(trimmed)
            }
            approvers = ids
        }
        entries.push({
            workspace: stripTrailingSlashes(workspace),
            chatId,
            ...(approvers === undefined ? {} : { approvers }),
        })
    })
    return { entries, declared: raw.length, problems }
}

/** `/a/b/` → `/a/b`; `/` stays `/` (a trailing slash must never change a match). */
function stripTrailingSlashes(value: string): string {
    const trimmed = value.replace(/\/+$/, '')
    return trimmed === '' ? '/' : trimmed
}

function hasWildcard(value: string): boolean {
    return value.includes('*')
}

/** A chat id shown whole only when it is too short to be an identity leak. */
export function maskChatId(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

/**
 * How specific one workspace key is.
 *
 * `literalPrefix` is the literal text before the first wildcard (a trailing `/`
 * dropped, so `/a/**` and `/a` compare at the same depth instead of the pattern
 * winning by one character). `wildcardCount` counts `*` characters, which makes
 * `**` cost two: a `**` matches any depth, a `*` exactly one segment, so the `*`
 * is the more specific of the two.
 */
export interface ApprovalSpecificity {
    /** The literal part before the first wildcard, trailing slashes removed. */
    literalPrefix: string
    /** How many `*` characters the key contains (`**` counts as two). */
    wildcardCount: number
}

/** Compute the specificity of one workspace key. */
export function specificityOf(pattern: string): ApprovalSpecificity {
    const normalized = stripTrailingSlashes(pattern)
    const wildcardAt = normalized.indexOf('*')
    const literal = wildcardAt === -1 ? normalized : normalized.slice(0, wildcardAt)
    let wildcardCount = 0
    for (const char of normalized) if (char === '*') wildcardCount += 1
    return { literalPrefix: stripTrailingSlashes(literal), wildcardCount }
}

/**
 * Translate one pattern into a regular expression over absolute paths.
 *
 * `*` = exactly one segment, `**` = zero or more segments (so `/a/**` also
 * matches `/a` itself), everything else literal. Nothing else is a wildcard:
 * `?`, `[`, `{` are ordinary characters here, because a path may legitimately
 * contain them and "silently treated as a character class" is a worse surprise
 * than "matched literally".
 */
function patternToRegExp(pattern: string): RegExp {
    const normalized = stripTrailingSlashes(pattern)
    // The leading `/` is part of every absolute path and handled by the segment
    // join below, so it is dropped before splitting (an empty first segment would
    // otherwise emit a doubled slash).
    const segments = normalized.replace(/^\//, '').split('/')
    return new RegExp(`^${segmentsSource(segments, 0)}$`)
}

function segmentsSource(segments: readonly string[], index: number): string {
    if (index >= segments.length) return ''
    const segment = segments[index] as string
    if (segment === '**') {
        const rest = segmentsSource(segments, index + 1)
        // Zero or more segments. At the end it swallows everything below; in the
        // middle each stretched segment still carries its own slash, which is why
        // the tail is appended AFTER the repetition.
        return rest === '' ? '(?:/[^/]+)*' : `(?:/[^/]+)*${rest}`
    }
    return `/${segmentSource(segment)}${segmentsSource(segments, index + 1)}`
}

function segmentSource(segment: string): string {
    let out = ''
    for (const char of segment) {
        if (char === '*') out += '[^/]*'
        else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return out
}

/**
 * Whether one workspace key claims an (already resolved) workspace path.
 * @param pattern - a plain absolute path or a pattern with `*`/`**`.
 * @param workspace - the resolved workspace path to test.
 */
export function workspaceMatches(pattern: string, workspace: string): boolean {
    const key = stripTrailingSlashes(pattern)
    const target = stripTrailingSlashes(workspace)
    if (!hasWildcard(key)) return target === key || target.startsWith(`${key}/`)
    return patternToRegExp(key).test(target)
}

/** One entry that claims the calling workspace, with the specificity it won on. */
export interface MatchedApprovalEntry {
    entry: WorkspaceApprovalEntry
    /** Index in the host's DECLARED array (rendered as `im.approvals[N]`). */
    index: number
    specificity: ApprovalSpecificity
    /** The string that was actually compared (a plain path is realpath-resolved). */
    target: string
}

/** The result of asking "which entry, if any, decides this workspace". */
export interface ApprovalRouting {
    /** The calling workspace exactly as the session declared it. */
    workspace: string
    /** The realpath compared against the mapping; `''` when it could not be resolved. */
    resolved: string
    /** Why `resolved` is empty (an unresolvable workspace matches nothing). */
    realpathProblem?: string
    /** `im.unmappedWorkspace` in force. */
    policy: UnmappedWorkspacePolicy
    /** Declared entries (invalid ones included). */
    declared: number
    /** Usable entries. */
    usable: number
    /** `declared > 0`: the mapping is in force (a typo must not read as "no mapping"). */
    configured: boolean
    /** The entry that won, when exactly one did. */
    matched?: MatchedApprovalEntry
    /** Entries of equal specificity: the routing REFUSES instead of picking one. */
    conflict?: { candidates: MatchedApprovalEntry[] }
    /** The conversation an ask in this workspace goes to; `''` = none. */
    chatId: string
    /** Where `chatId` came from (a mapped entry, the host default, or nothing). */
    chatIdSource: 'mapping' | 'host-default' | 'none'
    /** The approver list the matched entry declares (a REPLACEMENT for the host list). */
    approvers?: { ids: string[]; source: string }
    /** True when the matched entry omitted `approvers`: the host list applies. */
    approversFallback: boolean
    /** Mapping problems (invalid entries) that a report must state, never swallow. */
    problems: string[]
}

/** Input of {@link resolveApprovalRouting}. */
export interface ApprovalRoutingInput {
    /** The workspace the session declared (raw, possibly a symlink). */
    workspace: string
    entries: WorkspaceApprovalEntry[]
    /** Declared count, invalid entries included. */
    declared: number
    policy: UnmappedWorkspacePolicy
    /** `im.approvalChatId`: used only by the `host-default` policy and when no mapping exists. */
    hostChatId: string
    /** Configuration problems to carry into the routing report. */
    problems?: string[]
    /** `realpath` override (tests compare invented paths without touching disk). */
    realpath?: (candidate: string) => string | undefined
}

/** `realpath` by default: an unresolvable path returns `undefined` instead of throwing. */
function defaultRealpath(candidate: string): string | undefined {
    try {
        return fs.realpathSync(candidate)
    } catch {
        return undefined
    }
}

/**
 * Resolve one workspace against the host's mapping.
 *
 * Pure except for `realpath` (injectable), so the specificity and ambiguity rules
 * are testable without a host, a channel, or a real directory tree.
 * @param input - the workspace, the entries and the policy.
 * @returns the routing, including the refusal state (a conflict) when two entries tie.
 */
export function resolveApprovalRouting(input: ApprovalRoutingInput): ApprovalRouting {
    const realpath = input.realpath ?? defaultRealpath
    const declared = Number.isFinite(input.declared) ? Math.max(0, Math.floor(input.declared)) : 0
    const configured = declared > 0
    const problems = [...(input.problems ?? [])]
    const empty = { declared, usable: input.entries.length, configured, problems, approversFallback: false } as const

    // ① The CALLING workspace is compared as a real path. A symlinked session and
    // its target are one repository, and the mapping is written in real paths; an
    // unresolvable workspace is not silently "unmatched" — it is stated.
    let resolved = ''
    let realpathProblem: string | undefined
    if (input.workspace === '') {
        realpathProblem = '调用方没有声明工作区（session.header.cwd 为空）：没有可比较的路径'
    } else {
        const real = realpath(input.workspace)
        if (real === undefined) {
            realpathProblem =
                `无法解析工作区 ${input.workspace} 的真实路径（realpath 失败：路径不存在或不可达）：` +
                '未解析的原始路径不参与匹配（否则同一个仓库的符号链接写法会与映射键对不上）'
        } else {
            resolved = stripTrailingSlashes(real)
        }
    }

    const base = {
        workspace: input.workspace,
        resolved,
        ...(realpathProblem === undefined ? {} : { realpathProblem }),
        policy: input.policy,
        ...empty,
    }

    if (!configured) {
        // No mapping declared: today's behaviour, exactly. `host-default`'s
        // vocabulary would be a lie here (there is nothing to fall back FROM), so
        // the source says "host-default" only when a host chat id exists at all.
        return { ...base, chatId: input.hostChatId, chatIdSource: input.hostChatId === '' ? 'none' : 'host-default' }
    }

    const candidates: MatchedApprovalEntry[] = []
    if (resolved !== '') {
        input.entries.forEach((entry, index) => {
            const declaredKey = stripTrailingSlashes(entry.workspace)
            // A plain path is resolved too: a host may declare the symlink while
            // the session uses the target (or the other way round). A PATTERN has
            // no real path, so it is matched literally against the resolved
            // workspace (stated in `docs/KNOWN-LIMITS.md`).
            const target = hasWildcard(declaredKey) ? declaredKey : stripTrailingSlashes(realpath(declaredKey) ?? declaredKey)
            if (!workspaceMatches(target, resolved)) return
            candidates.push({ entry, index, specificity: specificityOf(target), target })
        })
    }

    if (candidates.length === 0) {
        if (input.policy === 'refuse') return { ...base, chatId: '', chatIdSource: 'none' }
        return { ...base, chatId: input.hostChatId, chatIdSource: input.hostChatId === '' ? 'none' : 'host-default' }
    }

    // ③ Most specific first: the longest literal prefix, then the fewest
    // wildcards. ④ A tie is a refusal, never a coin flip.
    const sorted = [...candidates].sort((left, right) => {
        const byPrefix = right.specificity.literalPrefix.length - left.specificity.literalPrefix.length
        if (byPrefix !== 0) return byPrefix
        return left.specificity.wildcardCount - right.specificity.wildcardCount
    })
    const best = sorted[0] as MatchedApprovalEntry
    const tied = sorted.filter(
        (candidate) =>
            candidate.specificity.literalPrefix.length === best.specificity.literalPrefix.length &&
            candidate.specificity.wildcardCount === best.specificity.wildcardCount,
    )
    if (tied.length > 1) return { ...base, conflict: { candidates: tied }, chatId: '', chatIdSource: 'none' }

    const approvers =
        best.entry.approvers === undefined ? undefined : { ids: [...best.entry.approvers], source: `im.approvals[${best.index}].approvers` }
    return {
        ...base,
        matched: best,
        chatId: best.entry.chatId,
        chatIdSource: 'mapping',
        ...(approvers === undefined ? {} : { approvers }),
        approversFallback: best.entry.approvers === undefined,
    }
}

/**
 * Resolve the routing of one workspace from the host configuration.
 * @param workspace - the calling workspace (raw).
 * @param im - the `im` block (host-owned keys only).
 */
export function approvalRoutingOf(workspace: string, im: ImWorkspaceApprovalConfig & { approvalChatId: string }): ApprovalRouting {
    return resolveApprovalRouting({
        workspace,
        entries: im.approvals,
        declared: im.approvalsDeclared,
        policy: im.unmappedWorkspace,
        hostChatId: im.approvalChatId,
        problems: im.approvalsProblems,
    })
}

/**
 * The projection of one workspace's routing that leaves the process, on the
 * `im()` report the suite's self-check reads.
 *
 * It exists because the mapping is per WORKSPACE while `im()` is process-wide:
 * the doctor asks "does the workspace I am reporting on have an approval
 * conversation?" and that question needs an answer, not a config dump. Chat ids
 * are masked here for the same reason they are masked in the status line.
 */
export interface WorkspaceMappingReport {
    /** `declared > 0`: a mapping is in force (an empty one is not a policy). */
    configured: boolean
    declared: number
    usable: number
    policy: UnmappedWorkspacePolicy
    /** The workspace as the caller declared it. */
    workspace: string
    /** The realpath compared against the entries; `''` when unresolvable. */
    resolved: string
    realpathProblem?: string
    /** The entry that claimed the workspace, when exactly one did. */
    matched?: { index: number; workspace: string; chatId: string; approvers: number; approversFallback: boolean }
    /** Entries of equal specificity (the routing refuses). */
    conflict?: { candidates: { index: number; workspace: string; chatId: string }[] }
    problems: string[]
}

/**
 * Build the out-of-process projection of a routing.
 * @param routing - the resolved routing.
 */
export function mappingReportOf(routing: ApprovalRouting): WorkspaceMappingReport {
    return {
        configured: routing.configured,
        declared: routing.declared,
        usable: routing.usable,
        policy: routing.policy,
        workspace: routing.workspace,
        resolved: routing.resolved,
        ...(routing.realpathProblem === undefined ? {} : { realpathProblem: routing.realpathProblem }),
        ...(routing.matched === undefined
            ? {}
            : {
                  matched: {
                      index: routing.matched.index,
                      workspace: routing.matched.entry.workspace,
                      chatId: maskChatId(routing.matched.entry.chatId),
                      approvers: routing.matched.entry.approvers?.length ?? 0,
                      approversFallback: routing.approversFallback,
                  },
              }),
        ...(routing.conflict === undefined
            ? {}
            : {
                  conflict: {
                      candidates: routing.conflict.candidates.map((candidate) => ({
                          index: candidate.index,
                          workspace: candidate.entry.workspace,
                          chatId: maskChatId(candidate.entry.chatId),
                      })),
                  },
              }),
        problems: [...routing.problems],
    }
}

/** How a mapped entry is named in a refusal or a status line. */
export function describeEntry(candidate: MatchedApprovalEntry): string {
    return `im.approvals[${candidate.index}] ${candidate.entry.workspace}（会话 ${maskChatId(candidate.entry.chatId)}）`
}

/** The sentence a refusal about an unmapped workspace says. */
export interface MappingRefusalText {
    detail: string
    extraLines: string[]
    next: string
}

/**
 * What an unmapped workspace means, in the words an operator can act on.
 *
 * The workspace is named in BOTH forms when they differ: the raw one (what the
 * session prints) and the resolved one (what a mapping entry must contain). An
 * operator who copies the wrong one would write an entry that never matches, and
 * the next refusal would look identical.
 * @param routing - the resolution (its `matched` is absent by definition).
 */
export function describeUnmappedWorkspace(routing: ApprovalRouting): MappingRefusalText {
    const where =
        routing.resolved === '' || routing.resolved === routing.workspace
            ? routing.workspace
            : `${routing.workspace} → realpath ${routing.resolved}`
    const declaredKeys =
        routing.usable === 0
            ? `（${routing.declared} 条声明，0 条可用）`
            : `（${routing.usable} 条可用）`
    return {
        detail:
            `调用工作区 ${where} 不在宿主 im.approvals 的任何映射项里${declaredKeys}，而 im.unmappedWorkspace=refuse：` +
            '这次提问该发到哪个会话、该由谁回答没有答案。回落宿主默认会把一个工作区的卡片送进为另一个工作区配置的会话，' +
            '所以这里一张卡片都不发——拒绝是可恢复的，发错人的审批不是。',
        extraLines: [
            `- 工作区：${routing.workspace}${routing.resolved === '' || routing.resolved === routing.workspace ? '' : `（realpath ${routing.resolved}）`}`,
            ...(routing.realpathProblem === undefined ? [] : [`- ⚠️ ${routing.realpathProblem}`]),
            ...(routing.problems.length === 0 ? [] : ['- ⚠️ 映射配置问题：', ...routing.problems.map((problem) => `  ${problem}`)]),
            '- 宿主配置：im.approvals（工作区 → 会话 + 审批人）、im.unmappedWorkspace（refuse | host-default）——两者都是宿主键，仓库改不了',
        ],
        next:
            `由宿主在 profile 的 im.approvals 里加一条 { "workspace": ${JSON.stringify(routing.resolved === '' ? routing.workspace : routing.resolved)}, ` +
            '"chatId": "<你与 bot 私聊的会话 id>", "approvers": ["<平台用户 id>"] }（approvers 省略则回落到宿主 im.approvers / im.approversFile）；' +
            '或用 im.unmappedWorkspace: "host-default" 明确表示"未映射的工作区就用 im.approvalChatId + 宿主名单"；' +
            '不要为了让流程走通去关掉它——那正是把审批卡发错人的那条路。',
    }
}

/**
 * What an ambiguous workspace means (two entries of equal specificity).
 *
 * Both entries are named, and no option to "just pick one" is offered: the whole
 * point of the refusal is that the system does not know which conversation the
 * question belongs to.
 * @param routing - the resolution (its `conflict` is present by definition).
 */
export function describeAmbiguousWorkspace(routing: ApprovalRouting): MappingRefusalText {
    const candidates = routing.conflict?.candidates ?? []
    return {
        detail:
            `调用工作区 ${routing.resolved === '' ? routing.workspace : routing.resolved} 同时命中 ${candidates.length} 条具体度相同的映射项` +
            `（${candidates.map(describeEntry).join(' / ')}）：具体度相同就无法判断哪一条才是这个工作区的决定，所以这里一张卡片都不发——` +
            '随机挑一条等于把卡片发到别人的会话里。',
        extraLines: [
            ...(routing.realpathProblem === undefined ? [] : [`- ⚠️ ${routing.realpathProblem}`]),
            '- 判定规则：先比字面前缀（越长越具体），再比通配符个数（越少越具体；`**` 算两个）',
            '- 裁决：同分不裁决（不替人挑一条），由宿主改配置',
        ],
        next:
            '由宿主把其中一条改得更具体（更长的路径前缀，例如把 /a 改成 /a/b），或删掉重复的那条；' +
            '改完用 interaction_status 的「工作区映射」一行核对命中项——两行映射指向同一个工作区时，谁也说不清审批卡该去哪儿。',
    }
}

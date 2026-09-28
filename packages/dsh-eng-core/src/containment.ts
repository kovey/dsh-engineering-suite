/**
 * Containment of a configured path inside one workspace.
 *
 * Several plugins let a repository relocate a record it owns — `dsh-spec-gate`'s
 * `planFile` / `adrDir` / `adrIndexFile`, `dsh-impact-gate`'s
 * `flaky.quarantineFile`, `dsh-quality-gate`'s `budgets[].baselineFile` — from
 * the project file `<repo>/.dsh/<plugin>.json`. Those records are reviewable
 * artifacts OF the repository they describe, so a project may move them *within*
 * the workspace and never outside it: a `../../` value (or an absolute path, or
 * a symlink that resolves outside) would hide the trail from the people
 * reviewing it and would write into a directory the workspace does not own.
 *
 * This module is the single rule every such key goes through, so the four call
 * sites cannot drift apart. It is deliberately a *decision*, not a message
 * formatter: each caller keeps its own default (the profile value stays in
 * force) and reports the problem in its own words, while the sentence this
 * helper returns always carries what was observed.
 *
 * The profile itself is NOT constrained by this helper — the host owns the
 * layout — so callers only apply it to values a project (or a model-written
 * specification) supplied.
 *
 * @module dsh-eng-core/containment
 */

import path from 'node:path'
import { isReallyInside, realTargetOf, resolvePath } from './paths.js'

/** What {@link containedPath} concluded. */
export interface ContainedPath {
    /** `true` when the value lands inside the workspace. */
    ok: boolean
    /** Absolute path the value resolves to (present on both outcomes). */
    path: string
    /** Workspace-relative form of {@link path} (present on both outcomes). */
    relative: string
    /** Set when refused: one sentence naming the cause, ready to be reported. */
    problem?: string
}

/**
 * Resolve a configured path and decide whether it stays inside the workspace.
 *
 * Containment is judged on the REAL path (`realpathSync` of the deepest
 * existing ancestor, then the unresolved tail), so `linked -> ../../elsewhere`
 * is refused even though its lexical form sits inside the workspace. `~` is
 * expanded like everywhere else in the suite, which means a `~/…` value is
 * contained only when the home directory happens to be inside the workspace.
 * @param root - the workspace root (`scope.session.header.cwd`).
 * @param candidate - the configured value (relative to `root`, or absolute).
 * @param label - what the value configures, used in the refusal sentence.
 * @returns the resolved path plus `ok`; `problem` is set when it is refused.
 */
export function containedPath(root: string, candidate: string, label = '路径'): ContainedPath {
    const resolved = resolvePath(candidate, root)
    const relative = path.relative(root, resolved) || '.'
    if (isReallyInside(root, resolved)) return { ok: true, path: resolved, relative }
    return {
        ok: false,
        path: resolved,
        relative,
        problem:
            `${label} 必须指向工作区内的路径（收到 ${JSON.stringify(candidate)}，解析为 ${resolved}，真实路径 ${realTargetOf(resolved)}）：` +
            `这类记录是关于本仓库的工件，项目可以把它们挪到工作区里的别处，不能挪到工作区外（符号链接按真实路径判定），已忽略这个取值`,
    }
}

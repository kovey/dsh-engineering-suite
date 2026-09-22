/**
 * Change impact: what a diff touches, and which tests therefore matter.
 *
 * Two questions the suite used to leave to the model's own reading of the code,
 * both of which are actually decidable:
 *
 *  1. "if I change this file, what else is affected?" — answerable from the import
 *     graph the metrics walker already builds;
 *  2. "which tests should run?" — the impacted test files, plus the ones that
 *     live in the same package/directory and the ones named after the change.
 *
 * What this is NOT (see `docs/KNOWN-LIMITS.md`): a call graph. Interface
 * dispatch, dependency injection, reflection and string-based lookups are not
 * derivable by parsing imports, so the module reports FILE-level reachability and
 * says so — a selection that pretends to be complete is worse than a selection
 * that names its blind spots.
 *
 * @module dsh-eng-core/impact
 */

import path from 'node:path'
import fs from 'node:fs'
import { runCommand } from './run.js'
import { measureWorkspace, type FileMetrics, type MetricsResult } from './metrics.js'
import type { Logger } from './log.js'

/** One file the diff touched, with the line ranges that were ADDED. */
export interface ChangedFile {
    /** Workspace-relative path. */
    path: string
    /** Added line ranges, 1-based inclusive; `[1, N]` for a brand-new file. */
    added: [number, number][]
    /** Lines the diff removed (0 for a new file). */
    removed: number
    /** `A`dded / `M`odified / `D`eleted / `R`enamed / untracked. */
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
    /** For a rename: where it came from — everything importing that path still needs updating. */
    previousPath?: string
}

/** Result of {@link changedRanges}. */
export interface ChangedRanges {
    cwd: string
    /** Whether the workspace is a git repository (no repository → no diff). */
    isRepo: boolean
    /** What the diff was taken against (`HEAD`, `origin/main`, …). */
    base: string
    files: ChangedFile[]
    /** Set when the diff could not be read; `files` is then empty. */
    problem?: string
}

/** Bounds of {@link changedRanges}. */
export interface ChangedRangesOptions {
    cwd: string
    /** Commit/ref to diff against. Default `HEAD` (i.e. the working tree). */
    base?: string
    /** Include untracked files as fully-new (default true). */
    includeUntracked?: boolean
    logger?: Logger
}

/** Parse one `@@ -a,b +c,d @@` hunk header into an added range. */
function hunkRange(line: string): { start: number; count: number } | undefined {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match === null) return undefined
    const start = Number.parseInt(match[1] as string, 10)
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2] as string, 10)
    return { start, count }
}

/** Normalise a git path to a workspace-relative POSIX path. */
function normalise(raw: string, cwd: string): string | undefined {
    const trimmed = raw.replace(/^"|"$/g, '').trim()
    if (trimmed === '' || trimmed === '/dev/null') return undefined
    const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed)
    const relative = path.relative(cwd, absolute)
    if (relative === '' || relative.startsWith('..')) return undefined
    return relative.split(path.sep).join('/')
}

/**
 * Read the line ranges this change added, per file.
 *
 * `-U0` keeps the hunks minimal, which is what incremental coverage and
 * changed-lines-only secret scanning need. Deleted files are reported (their
 * removal is an impact too) but carry no added lines.
 * @param options - workspace, base ref and untracked handling.
 */
export async function changedRanges(options: ChangedRangesOptions): Promise<ChangedRanges> {
    const cwd = options.cwd
    const base = options.base ?? 'HEAD'
    const empty = { cwd, base, files: [] as ChangedFile[] }
    const diff = await runCommand({
        argv: ['git', 'diff', '--no-color', '--no-ext-diff', '-U0', '--find-renames', base, '--'],
        cwd,
        timeoutMs: 30_000,
    })
    if (diff.exitCode !== 0) {
        return {
            ...empty,
            isRepo: false,
            problem: `无法读取 git diff（git diff ${base} 退出码 ${diff.exitCode}）：${`${diff.stdout}${diff.stderr}`.trim().split('\n').slice(-2).join(' ')}`,
        }
    }

    const files: ChangedFile[] = []
    let current: ChangedFile | undefined
    for (const line of diff.stdout.split('\n')) {
        if (line.startsWith('diff --git ')) {
            // A pure rename has NO `+++` line, so the entry has to be created
            // here from the two paths git prints. Missing this dropped renames
            // from the report entirely (their importers still need updating).
            const body = line.slice('diff --git '.length)
            const parts = /^(?:"a\/(.+)"|a\/(\S+)) (?:"b\/(.+)"|b\/(\S+))$/.exec(body)
            const from = normalise((parts?.[1] ?? parts?.[2] ?? '').trim(), cwd)
            const to = normalise((parts?.[3] ?? parts?.[4] ?? '').trim(), cwd)
            current =
                to === undefined
                    ? undefined
                    : {
                          path: to,
                          added: [],
                          removed: 0,
                          status: from !== undefined && from !== to ? 'renamed' : 'modified',
                          ...(from === undefined || from === to ? {} : { previousPath: from }),
                      }
            if (current !== undefined) files.push(current)
            continue
        }
        if (line.startsWith('+++ ')) {
            // `git diff` writes `b/<path>`; keeping that prefix would produce
            // `b/src/...` and every lookup would miss.
            const target = normalise(line.slice(4).replace(/^[ab]\//, ''), cwd)
            if (current !== undefined) {
                // The entry already exists (created from `diff --git`): refine its
                // path instead of pushing a duplicate.
                if (target !== undefined && target !== current.path && current.previousPath === undefined) current.path = target
                continue
            }
            current = target === undefined ? undefined : { path: target, added: [], removed: 0, status: 'modified' }
            if (current !== undefined) files.push(current)
            continue
        }
        if (line.startsWith('new file mode') && current !== undefined) {
            current.status = 'added'
            continue
        }
        if (line.startsWith('deleted file mode') && current !== undefined) {
            current.status = 'deleted'
            continue
        }
        if (line.startsWith('rename from') && current !== undefined) {
            current.status = 'renamed'
            const from = normalise(line.slice('rename from'.length).replace(/^[ab]\//, ''), cwd)
            if (from !== undefined) current.previousPath = from
            continue
        }
        if (line.startsWith('@@') && current !== undefined) {
            const range = hunkRange(line)
            if (range !== undefined && range.count > 0) current.added.push([range.start, range.start + range.count - 1])
            continue
        }
        if (line.startsWith('-') && !line.startsWith('---') && current !== undefined) current.removed += 1
    }

    if (options.includeUntracked !== false) {
        const untracked = await runCommand({
            argv: ['git', 'ls-files', '--others', '--exclude-standard'],
            cwd,
            timeoutMs: 15_000,
        })
        for (const raw of untracked.stdout.split('\n')) {
            const target = normalise(raw, cwd)
            if (target === undefined) continue
            if (files.some((file) => file.path === target)) continue
            const lines = countLines(path.join(cwd, target))
            files.push({ path: target, added: lines === 0 ? [] : [[1, lines]], removed: 0, status: 'untracked' })
        }
    }

    files.sort((left, right) => left.path.localeCompare(right.path))
    for (const file of files) file.added.sort((left, right) => left[0] - right[0])
    return { isRepo: true, cwd, base, files }
}

/** Line count of a file, 0 when unreadable. */
function countLines(file: string): number {
    try {
        const text = fs.readFileSync(file, 'utf8')
        if (text === '') return 0
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {
        return 0
    }
}

/** Whether a path looks like a test file (mirrors the scan heuristics). */
export function isTestPath(file: string): boolean {
    const base = path.basename(file)
    return (
        /(^|\/)(tests?|spec|__tests__)\//.test(file) ||
        /_test\.go$/.test(base) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
        /^test_.*\.py$/.test(base) ||
        /_test\.py$/.test(base) ||
        /Tests?\.(cs|java|kt)$/.test(base)
    )
}

/** One file the change reaches, with how it was reached. */
export interface ImpactedFile {
    path: string
    /** 1 = directly imports a changed file. */
    distance: number
    /** The path that pulled it in. */
    via: string
}

/** Why a test file was selected. */
export interface SelectedTest {
    path: string
    reason: 'changed' | 'imports-changed' | 'same-package' | 'name-match'
    /** Import distance for `imports-changed`. */
    distance?: number
}

/** The report {@link analyzeImpact} returns. */
export interface ImpactReport {
    cwd: string
    base: string
    changed: ChangedFile[]
    /** Transitive dependents of the changed files, nearest first. */
    impacted: ImpactedFile[]
    tests: SelectedTest[]
    /**
     * Whether the analysis actually ran.
     *
     * `ok` (a change set was read), `empty` (the diff worked, nothing changed),
     * `not-a-repo` / `error` (no diff could be read — the numbers below mean
     * nothing and `risk` is `unknown`). Reported instead of turning an
     * unreadable workspace into "high risk because no test covers it".
     */
    analysis: 'ok' | 'empty' | 'not-a-repo' | 'error'
    problem?: string
    risk: 'low' | 'medium' | 'high' | 'unknown'
    /** Deterministic reasons for the risk level, in Chinese. */
    reasons: string[]
    /** Changed files nothing else imports and no test reaches. */
    unreached: string[]
    stats: { filesScanned: number; graphEdges: number; truncated: boolean }
}

/** Inputs of {@link analyzeImpact}. */
export interface ImpactOptions {
    cwd: string
    base?: string
    /** Explicit paths instead of a diff (e.g. a planned change). */
    paths?: readonly string[]
    /** Stop the reverse walk after this distance (default 6). */
    maxDistance?: number
    maxFiles?: number
    maxFileBytes?: number
    logger?: Logger
}

/** Thresholds that decide the risk level (documented in the README). */
export const RISK_RULES = {
    /** A changed file imported by at least this many files is high risk. */
    highFanIn: 8,
    /** …or reached by at least this many files in total. */
    highImpacted: 25,
    /** …or exporting at least this many symbols (wide public surface). */
    wideSurface: 15,
    /** Medium: reached by at least this many files. */
    mediumImpacted: 5,
    /** Medium: exporting at least this many symbols. */
    mediumSurface: 6,
} as const

/**
 * Analyse what a change touches and which tests to run.
 *
 * The graph is FILE-level import reachability, computed from the same walk the
 * standards gate uses (bounded, deterministic, no network).
 * @param options - workspace, diff base or explicit paths, walk bounds.
 */
export async function analyzeImpact(options: ImpactOptions): Promise<ImpactReport> {
    const cwd = options.cwd
    const maxDistance = options.maxDistance ?? 6
    const diff =
        options.paths === undefined
            ? await changedRanges({
                  cwd,
                  ...(options.base === undefined ? {} : { base: options.base }),
                  ...(options.logger === undefined ? {} : { logger: options.logger }),
              })
            : undefined
    const explicit =
        options.paths === undefined
            ? []
            : options.paths.map((entry) => {
                  const absolute = path.isAbsolute(entry) ? entry : path.join(cwd, entry)
                  return path.relative(cwd, absolute).split(path.sep).join('/')
              })
    const changed: ChangedFile[] =
        explicit.length > 0
            ? explicit.map((entry) => ({ path: entry, added: [], removed: 0, status: 'modified' as const }))
            : (diff?.files ?? [])

    const metrics: MetricsResult = measureWorkspace({
        cwd,
        // No thresholds: the walk is wanted for its graph, not its verdict.
        standards: { languages: {} },
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
        ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
    })

    const byPath = new Map<string, FileMetrics>(metrics.files.map((file) => [file.path, file]))
    // Go (and Python packages) import a DIRECTORY, not a file: `internal/config`
    // is a package whose files are all dependencies of the importer. Ignoring
    // that made the graph empty on a real Go repository — 0 edges for 113 files —
    // so an import that names a directory expands to the files directly in it.
    const byDir = new Map<string, string[]>()
    for (const file of metrics.files) {
        const dir = path.posix.dirname(file.path)
        const list = byDir.get(dir) ?? []
        list.push(file.path)
        byDir.set(dir, list)
    }
    for (const list of byDir.values()) list.sort()
    // Reverse edges: depended-on → dependents.
    const dependents = new Map<string, string[]>()
    let edges = 0
    const addEdge = (depended: string, dependent: string): void => {
        edges += 1
        const list = dependents.get(depended) ?? []
        if (!list.includes(dependent)) list.push(dependent)
        dependents.set(depended, list)
    }
    for (const file of metrics.files) {
        for (const imported of file.imports) {
            if (byPath.has(imported)) {
                addEdge(imported, file.path)
                continue
            }
            for (const member of byDir.get(imported.replace(/\/+$/, '')) ?? []) addEdge(member, file.path)
        }
    }
    for (const list of dependents.values()) list.sort()

    const changedPaths = changed.filter((file) => file.status !== 'deleted').map((file) => file.path)
    // A rename is an impact on everyone importing the OLD path: follow both.
    const seeded = [
        ...changedPaths,
        ...changed.map((file) => file.previousPath).filter((entry): entry is string => entry !== undefined && entry !== ''),
    ]
    const impacted = new Map<string, ImpactedFile>()
    const frontier: ImpactedFile[] = seeded
        .filter((entry) => byPath.has(entry))
        .map((entry) => ({ path: entry, distance: 0, via: entry }))
    const seen = new Set(frontier.map((entry) => entry.path))
    for (let index = 0; index < frontier.length; index += 1) {
        const current = frontier[index] as ImpactedFile
        if (current.distance >= maxDistance) continue
        for (const dependent of dependents.get(current.path) ?? []) {
            if (seen.has(dependent)) continue
            seen.add(dependent)
            const next: ImpactedFile = { path: dependent, distance: current.distance + 1, via: current.path }
            frontier.push(next)
            impacted.set(dependent, next)
        }
    }

    const tests: SelectedTest[] = []
    const addTest = (entry: SelectedTest): void => {
        if (!tests.some((candidate) => candidate.path === entry.path)) tests.push(entry)
    }
    const testMetrics = metrics.files.filter((file) => isTestPath(file.path))
    for (const file of changedPaths) {
        if (isTestPath(file)) addTest({ path: file, reason: 'changed' })
    }
    for (const file of testMetrics) {
        const reach = impacted.get(file.path)
        if (reach !== undefined) addTest({ path: file.path, reason: 'imports-changed', distance: reach.distance })
    }
    // Same directory (Go tests live beside their package; Python tests often do).
    const directories = new Set(changedPaths.map((entry) => path.posix.dirname(entry)))
    for (const file of testMetrics) {
        if (directories.has(path.posix.dirname(file.path))) addTest({ path: file.path, reason: 'same-package' })
    }
    // Named after the change: `store.go` ↔ `store_test.go`, `store.ts` ↔ `store.spec.ts`.
    const stems = new Set(
        changedPaths.map((entry) => path.posix.basename(entry).replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/, '')),
    )
    for (const file of testMetrics) {
        const stem = path.posix.basename(file.path).replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/, '')
        if (stems.has(stem)) addTest({ path: file.path, reason: 'name-match' })
    }
    const order: Record<SelectedTest['reason'], number> = { changed: 0, 'imports-changed': 1, 'same-package': 2, 'name-match': 3 }
    tests.sort((left, right) => order[left.reason] - order[right.reason] || (left.distance ?? 0) - (right.distance ?? 0) || left.path.localeCompare(right.path))

    const reasons: string[] = []
    const analysis: ImpactReport['analysis'] =
        diff !== undefined && diff.problem !== undefined ? 'error' : changed.length === 0 ? 'empty' : 'ok'
    if (analysis === 'error') {
        return {
            cwd,
            base: diff?.base ?? 'HEAD',
            changed,
            impacted: [],
            tests: [],
            analysis,
            ...(diff?.problem === undefined ? {} : { problem: diff.problem }),
            risk: 'unknown',
            reasons: [`无法判定：${diff?.problem ?? '未读到 diff'}`],
            unreached: [],
            stats: { filesScanned: metrics.stats.filesScanned, graphEdges: edges, truncated: metrics.stats.truncated },
        }
    }
    if (analysis === 'empty') {
        return {
            cwd,
            base: diff?.base ?? 'HEAD',
            changed,
            impacted: [],
            tests: [],
            analysis,
            risk: 'low',
            reasons: ['本次没有改动（工作区与基准一致）'],
            unreached: [],
            stats: { filesScanned: metrics.stats.filesScanned, graphEdges: edges, truncated: metrics.stats.truncated },
        }
    }
    let risk: ImpactReport['risk'] = 'low'
    const fanIn = (entry: string): number => (dependents.get(entry) ?? []).length
    const widest = changedPaths.reduce((best, entry) => Math.max(best, byPath.get(entry)?.exports ?? 0), 0)
    const highestFanIn = changedPaths.reduce((best, entry) => Math.max(best, fanIn(entry)), 0)
    if (highestFanIn >= RISK_RULES.highFanIn) {
        risk = 'high'
        reasons.push(`被依赖最多 ${highestFanIn} 处（阈值 ${RISK_RULES.highFanIn}）`)
    }
    if (impacted.size >= RISK_RULES.highImpacted) {
        risk = 'high'
        reasons.push(`影响面 ${impacted.size} 个文件（阈值 ${RISK_RULES.highImpacted}）`)
    }
    if (widest >= RISK_RULES.wideSurface) {
        risk = 'high'
        reasons.push(`导出面 ${widest} 个符号（阈值 ${RISK_RULES.wideSurface}）`)
    }
    if (risk !== 'high') {
        if (impacted.size >= RISK_RULES.mediumImpacted) {
            risk = 'medium'
            reasons.push(`影响面 ${impacted.size} 个文件（阈值 ${RISK_RULES.mediumImpacted}）`)
        }
        if (widest >= RISK_RULES.mediumSurface) {
            risk = 'medium'
            reasons.push(`导出面 ${widest} 个符号（阈值 ${RISK_RULES.mediumSurface}）`)
        }
    }
    if (tests.length === 0) {
        risk = 'high'
        reasons.push('没有任何测试文件覆盖这些改动（按目录/命名/导入关系都找不到）')
    }
    const unreached = changedPaths.filter((entry) => fanIn(entry) === 0 && !tests.some((test) => test.path === entry))
    if (unreached.length > 0) reasons.push(`${unreached.length} 个改动文件既没有依赖者也没有测试触及`)
    if (reasons.length === 0) reasons.push(`影响面 ${impacted.size} 个文件、${tests.length} 个测试文件，均在阈值内`)

    return {
        cwd,
        base: diff?.base ?? (options.paths === undefined ? 'HEAD' : '(explicit paths)'),
        changed,
        analysis,
        impacted: [...impacted.values()].sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path)),
        tests,
        risk,
        reasons,
        unreached,
        stats: { filesScanned: metrics.stats.filesScanned, graphEdges: edges, truncated: metrics.stats.truncated },
    }
}

/**
 * The command a host template renders into, for running only the selected tests.
 *
 * `{files}` is replaced with the space-joined selection; when the template has no
 * placeholder the selection is appended, which is what `go test` and `vitest run`
 * both accept.
 * @param template - host-configured command template.
 * @param tests - the selected test files.
 */
export function renderTestCommand(template: string, tests: readonly SelectedTest[]): string {
    const files = tests.map((test) => test.path)
    const trimmed = template.trim()
    // An empty selection renders the template WITHOUT the placeholder, i.e. the
    // full suite. Under-testing is the failure mode this suite refuses, so a
    // placeholder that cannot be filled must not produce `go test ` (which reads
    // as "run nothing in particular" and may run the wrong thing entirely).
    if (files.length === 0) return trimmed.replace(/\{files\}/g, '').replace(/\s+/g, ' ').trim()
    if (trimmed.includes('{files}')) return trimmed.replace(/\{files\}/g, files.join(' '))
    return `${trimmed} ${files.join(' ')}`
}

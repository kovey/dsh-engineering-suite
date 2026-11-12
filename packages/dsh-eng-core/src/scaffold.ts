/**
 * Where a scaffold should CREATE the suite's configuration files.
 *
 * Reading and creating are not the same question, and treating them as one is
 * the defect this module exists to fix:
 *
 *  - **Reading** asks "where is the configuration of THIS repository?" — that is
 *    {@link resolveLayout}: the namespace `<repo>/.dsh/engineering-suite/` when
 *    it exists, else the legacy `<repo>/.dsh/` (and a migrated repository still
 *    reads hand-written legacy files, see `loadProjectConfig`).
 *  - **Creating** asks "where should NEW configuration live?" — and the answer
 *    for a repository with no configuration at all is the namespace, never the
 *    legacy root. `resolveLayout().configDir` is a READ path: on an empty
 *    repository it falls back to `.dsh/`, so using it as the write target put
 *    ten config files in the wrong place (they were then read only by a reader
 *    that also fell back, which is why no test noticed).
 *
 * The decision, in order:
 *
 *  1. an explicit `layout.rootDir` (host decision) wins — reported as `explicit`
 *     because it is neither the namespace nor the legacy default;
 *  2. `<repo>/.dsh/engineering-suite/` exists → `namespace` (migrated repository);
 *  3. the legacy root already holds suite config files → `legacy`: writing the
 *     namespace there would SPLIT the configuration in two (old files at `.dsh/`,
 *     new ones in the namespace) and the reader would silently use one of them;
 *  4. otherwise (empty repository) → `namespace`, creating it on write.
 *
 * The decision is pure: it creates nothing. A dry run of `suite_init` must leave
 * the workspace byte-identical, so creation belongs to the writer
 * (`planSuiteInit` mkdirs the parent before writing).
 *
 * @module dsh-eng-core/scaffold
 */

import fs from 'node:fs'
import path from 'node:path'
import { LEGACY_TRAIL_DIR, SUITE_NAMESPACE, resolvePath } from './paths.js'

/** How {@link scaffoldConfigDir} decided where configuration is created. */
export type ScaffoldLayout = 'explicit' | 'namespace' | 'legacy'

/** The decided directory plus the reason a report prints verbatim. */
export interface ScaffoldConfigDirResult {
    /** Absolute directory the caller should write into (NOT created here). */
    dir: string
    /** Which branch decided it. */
    layout: ScaffoldLayout
    /** Human-readable reason (Chinese; `suite_init` prints it as-is). */
    reason: string
}

/**
 * Files that make a legacy `.dsh/` root look "already configured".
 *
 * The ten scaffolded configuration files plus this suite's own project config
 * and the standards baseline (a repository-owned artifact, but still evidence
 * that the legacy root is in use). A caller whose catalog is authoritative (for
 * example `dsh-suite-doctor`) passes its own list through
 * {@link ScaffoldConfigOptions.legacyFiles}; the `*-gate.json` shape is checked
 * as well so a plugin's config is never missed because a list went stale.
 */
export const SUITE_CONFIG_FILES: readonly string[] = [
    'spec-gate.json',
    'test-design-gate.json',
    'quality-gate.json',
    'standards.json',
    'standards-baseline.json',
    'evidence-gate.json',
    'coverage-gate.json',
    'impact-gate.json',
    'supply-chain-gate.json',
    'interaction-gate.json',
    'deploy-gate.json',
    'suite-doctor.json',
]

/** Inputs of {@link scaffoldConfigDir}. */
export interface ScaffoldConfigOptions {
    /** Explicit layout root (host `layout.rootDir`); `~` is expanded. Empty = absent. */
    rootDir?: string
    /** Extra legacy file names to treat as "already configured" (the caller's catalog). */
    legacyFiles?: readonly string[]
}

/** Whether a path is an existing directory (resolution must never throw). */
function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory()
    } catch {
        return false
    }
}

/** Suite config files already sitting directly in the legacy root. */
function legacyConfigFiles(legacyRootDir: string, candidates: readonly string[]): string[] {
    let names: string[]
    try {
        names = fs.readdirSync(legacyRootDir)
    } catch {
        return []
    }
    const wanted = new Set(candidates)
    return names.filter((name) => wanted.has(name) || name.endsWith('-gate.json')).sort()
}

/** The namespace directory of one repository. */
function namespacePath(legacyRootDir: string): string {
    return path.join(legacyRootDir, SUITE_NAMESPACE)
}

/** The three explicit branches; `undefined` means "empty repository" (namespace). */
function decidedBranch(cwd: string, options: ScaffoldConfigOptions): ScaffoldConfigDirResult | undefined {
    const explicit = options.rootDir?.trim() ?? ''
    if (explicit !== '') {
        return { dir: resolvePath(explicit, cwd), layout: 'explicit', reason: `显式 layout.rootDir（${explicit}）：按宿主配置写，不做自动迁移` }
    }
    const legacyRootDir = resolvePath(LEGACY_TRAIL_DIR, cwd)
    const namespaceDir = namespacePath(legacyRootDir)
    if (isDirectory(namespaceDir)) {
        return { dir: namespaceDir, layout: 'namespace', reason: `已迁移：${LEGACY_TRAIL_DIR}/${SUITE_NAMESPACE}/ 已存在，继续写命名空间` }
    }
    const legacy = legacyConfigFiles(legacyRootDir, [...SUITE_CONFIG_FILES, ...(options.legacyFiles ?? [])])
    if (legacy.length > 0) {
        return { dir: legacyRootDir, layout: 'legacy', reason: `检测到遗留配置（${legacy.join('、')}）：沿用遗留位置，避免数据分裂` }
    }
    return undefined
}

/**
 * Decide where suite configuration should be CREATED for one workspace.
 *
 * Reading keeps using `resolveLayout().configDir`; only the write path calls
 * this, so "the reader looks in A while the scaffold wrote to B" cannot happen:
 * the namespace branch is exactly the directory `resolveLayout` prefers.
 * @param cwd - workspace root (a session's `header.cwd`).
 * @param options - explicit layout root and the caller's legacy file catalog.
 * @returns the absolute directory, the branch name and a reason for the report.
 */
export function scaffoldConfigDir(cwd: string, options: ScaffoldConfigOptions = {}): ScaffoldConfigDirResult {
    const decided = decidedBranch(cwd, options)
    if (decided !== undefined) return decided
    const legacyRootDir = resolvePath(LEGACY_TRAIL_DIR, cwd)
    const namespaceDir = namespacePath(legacyRootDir)
    return {
        dir: namespaceDir,
        layout: 'namespace',
        reason: `空仓库：还没有任何套件配置——默认创建命名空间 ${LEGACY_TRAIL_DIR}/${SUITE_NAMESPACE}/（配置住这里，读取方按该目录解析）`,
    }
}

/**
 * Project-level plugin configuration.
 *
 * A dsh profile is one process serving many projects (one Neovim, several
 * repositories), so a profile-global setting such as "the test command" cannot
 * be right for every workspace. Each plugin may therefore read a small JSON
 * file from the *session's* workspace:
 *
 * ```
 * <workspace>/.dsh/<plugin-id>.json
 * ```
 *
 * Two rules make this safe:
 *
 *  1. **The host profile is the ceiling.** A project file may refine the host's
 *     configuration (typically: which commands to run here) but never weaken a
 *     gate the host turned on. Callers pass the allowed and forbidden key sets;
 *     a forbidden key is ignored with a logged problem instead of being
 *     honoured.
 *  2. **The file is part of the trust root.** `.dsh/**` is already closed to
 *     the write tools by `dsh-spec-gate`'s guard (only the derived
 *     `specs/*.md` is writable), so the model cannot silently neuter a gate by
 *     rewriting a project config.
 *
 * Reads are cached by mtime+size, because gates evaluate on hot paths (every
 * turn stop, every `quality_gate_run`).
 *
 * @module dsh-eng-core/project-config
 */

import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './io.js'
import type { Layout } from './paths.js'

/** One project configuration file. */
export interface ProjectConfigFile<T> {
    /** Absolute path of the file that was consulted. */
    file: string
    /** `true` when the file exists and parsed. */
    present: boolean
    /** The parsed value, when present and an object. */
    value?: T
    /** Recoverable problems (malformed JSON, wrong shape) — never silent. */
    problems: string[]
}

interface CacheEntry {
    signature: string
    result: unknown
}

const cache = new Map<string, CacheEntry>()

/** `<rootDir>/<pluginId>.json` — the project's override file. */
export function projectConfigFile(layout: Layout, pluginId: string): string {
    // `configDir` is newer than the layout shape most callers build by hand
    // (tests, plugins that only need `cwd`/`rootDir`), so fall back to
    // `rootDir` rather than producing `path.join(undefined, …)`.
    return path.join(layout.configDir ?? layout.rootDir, `${pluginId}.json`)
}

/**
 * The legacy location of one plugin's project config (`<cwd>/.dsh/<id>.json`).
 *
 * Only meaningful for a MIGRATED repository (`rootDir` is the namespace
 * directory): its hand-written config may still sit at the old path, and reading
 * it is better than silently falling back to profile defaults.
 * @param layout - the resolved layout.
 * @param pluginId - plugin id (the file name without `.json`).
 * @returns the legacy path.
 */
export function legacyProjectConfigFile(layout: Layout, pluginId: string): string {
    const root = layout.legacyRootDir ?? path.join(layout.cwd, '.dsh')
    return path.join(root, `${pluginId}.json`)
}

function signatureOf(file: string): string {
    try {
        const stat = fs.statSync(file)
        return `${stat.mtimeMs}:${stat.size}`
    } catch {
        return 'missing'
    }
}

/** Forget cached project configs (tests, and role/config hot-editing). */
export function clearProjectConfigCache(): void {
    cache.clear()
}

/**
 * Read one plugin's project configuration.
 * @param layout - the session workspace layout.
 * @param pluginId - the plugin id (also the file name).
 * @param options - `cache` (default true) and `expectObject` (default true).
 * @returns the file path, presence, parsed value and any problems.
 */
export function loadProjectConfig<T extends Record<string, unknown>>(
    layout: Layout,
    pluginId: string,
    options: { cache?: boolean } = {},
): ProjectConfigFile<T> {
    // New location first; a migrated repository whose file was not moved yet
    // still reads its config from the legacy path instead of losing it.
    const preferred = projectConfigFile(layout, pluginId)
    const legacy = legacyProjectConfigFile(layout, pluginId)
    const file = preferred === legacy || signatureOf(preferred) !== 'missing' ? preferred : signatureOf(legacy) !== 'missing' ? legacy : preferred
    const useCache = options.cache !== false
    const signature = signatureOf(file)
    if (useCache) {
        const hit = cache.get(file)
        if (hit !== undefined && hit.signature === signature) return hit.result as ProjectConfigFile<T>
    }
    const result = readUncached<T>(file)
    if (useCache) cache.set(file, { signature, result })
    return result
}

function readUncached<T>(file: string): ProjectConfigFile<T> {
    if (signatureOf(file) === 'missing') return { file, present: false, problems: [] }
    const parsed = readJson<unknown>(file)
    if (parsed === undefined) {
        return { file, present: true, problems: [`${file}: 不是合法 JSON，已忽略项目级配置（继续使用 profile 配置）`] }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { file, present: true, problems: [`${file}: 顶层必须是对象，已忽略项目级配置`] }
    }
    return { file, present: true, value: parsed as T, problems: [] }
}

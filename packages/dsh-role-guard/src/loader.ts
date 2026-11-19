/**
 * Role loading: builtin roles from this package, workspace roles from
 * `<root>/roles/*.md`, and inline roles from configuration — in ascending
 * precedence order.
 * @module dsh-role-guard/loader
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDir, readText, resolvePath, type Logger } from 'dsh-eng-core'
import type { Layout } from 'dsh-eng-core'
import type { RoleGuardConfig } from './config.js'
import { resolveModelClassRoles } from './model-class.js'
import { isRoleError, parseRole, roleFromConfig, RoleRegistry } from './roles.js'

/** Absolute path of the `roles/` directory shipped inside this package. */
export function builtinRolesDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // dist/loader.js → <package>/roles
    return path.resolve(here, '..', 'roles')
}

function loadDir(registry: RoleRegistry, dir: string, logger: Logger, source: string): void {
    for (const entry of listDir(dir)) {
        if (!entry.endsWith('.md')) continue
        const file = path.join(dir, entry)
        const text = readText(file)
        if (text === undefined) {
            registry.fail(`${file}: unreadable`)
            continue
        }
        const fallbackId = entry.replace(/\.md$/, '')
        const role = parseRole(text, source === 'builtin' ? `builtin:${entry}` : file, fallbackId)
        if (isRoleError(role)) {
            registry.fail(role.error)
            registry.markBroken(fallbackId)
            logger.warn(role.error)
            continue
        }
        registry.add(role)
    }
}

/**
 * Build a role registry for one workspace.
 * @param config - resolved plugin configuration.
 * @param layout - the workspace layout (supplies `rolesDir` and the cwd base).
 * @param logger - diagnostics sink.
 */
export function loadRoles(config: RoleGuardConfig, layout: Layout, logger: Logger): RoleRegistry {
    const registry = new RoleRegistry()
    if (config.includeBuiltin) loadDir(registry, builtinRolesDir(), logger, 'builtin')
    loadDir(registry, layout.rolesDir, logger, 'workspace')
    for (const dir of config.roleDirs) {
        loadDir(registry, resolvePath(dir, layout.cwd), logger, 'workspace')
    }
    for (const [index, entry] of config.roles.entries()) {
        const role = roleFromConfig(entry, index)
        if (isRoleError(role)) {
            registry.fail(role.error)
            logger.warn(role.error)
            continue
        }
        registry.add(role)
    }
    // LAST, after every layer: `model: @planner` is resolved against the
    // workspace's `models.json`, and a workspace role override must be able to
    // use the syntax exactly like a builtin one.
    resolveModelClassRoles(registry, layout, logger)
    return registry
}

/** A directory signature: cheap enough to recompute, exact enough to notice an edit. */
function directorySignature(dirs: readonly string[]): string {
    const parts: string[] = []
    for (const dir of dirs) {
        let entries: string[]
        try {
            entries = fs.readdirSync(dir).filter((entry) => entry.endsWith('.md')).sort()
        } catch {
            parts.push(`${dir}:missing`)
            continue
        }
        // A pathological directory is not worth stat-ing on every assembly.
        if (entries.length > 200) {
            parts.push(`${dir}:many:${entries.length}`)
            continue
        }
        for (const entry of entries) {
            try {
                const stat = fs.statSync(path.join(dir, entry))
                parts.push(`${dir}/${entry}:${stat.mtimeMs}:${stat.size}`)
            } catch {
                parts.push(`${dir}/${entry}:gone`)
            }
        }
    }
    return parts.join('|')
}

/**
 * A file's cheap signature (`mtime:size`), or `missing`.
 *
 * `models.json` participates in the role cache key because `model: @planner` is
 * resolved AT LOAD TIME: editing the project's model table must re-resolve the
 * roles, otherwise a session keeps running on a class that no longer exists.
 * Both candidate locations are covered (the namespace dir and the legacy one),
 * exactly like `loadProjectConfig` reads them.
 */
function fileSignature(file: string): string {
    try {
        const stat = fs.statSync(file)
        return `${stat.mtimeMs}:${stat.size}`
    } catch {
        return 'missing'
    }
}

/** The `models.json` halves of the role cache signature. */
function modelsSignature(layout: Layout): string {
    return [path.join(layout.configDir ?? layout.rootDir, 'models.json'), path.join(layout.legacyRootDir, 'models.json')]
        .map((file) => `${file}:${fileSignature(file)}`)
        .join('|')
}

/**
 * Per-workspace role registries, cached by the resolved roles directory.
 *
 * The cache revalidates cheaply (directory listing + mtimes) so an operator who
 * fixes a role file mid-session sees the change on the next prompt assembly,
 * instead of having to restart the session.
 */
export class RoleRegistryCache {
    private readonly caches = new Map<string, { registry: RoleRegistry; signature: string }>()

    constructor(
        private readonly config: RoleGuardConfig,
        private readonly logger: Logger,
    ) {}

    /** The directories that make up one workspace's role set. */
    private dirsFor(layout: Layout): string[] {
        return [
            ...(this.config.includeBuiltin ? [builtinRolesDir()] : []),
            layout.rolesDir,
            ...this.config.roleDirs.map((dir) => resolvePath(dir, layout.cwd)),
        ]
    }

    /** Resolve (and cache) the registry for one workspace. */
    for(layout: Layout): RoleRegistry {
        const key = `${layout.rolesDir}|${layout.rootDir}`
        const signature = `${directorySignature(this.dirsFor(layout))}|${modelsSignature(layout)}`
        const cached = this.caches.get(key)
        if (cached !== undefined && cached.signature === signature) return cached.registry
        const registry = loadRoles(this.config, layout, this.logger)
        if (cached !== undefined) this.logger.info('role files changed on disk — reloaded the role registry')
        this.caches.set(key, { registry, signature })
        return registry
    }

    /** Drop every cached registry (tests, and role hot-editing). */
    clear(): void {
        this.caches.clear()
    }

    /** Whether a directory of role files exists (diagnostics). */
    static hasDir(dir: string): boolean {
        try {
            return fs.statSync(dir).isDirectory()
        } catch {
            return false
        }
    }
}

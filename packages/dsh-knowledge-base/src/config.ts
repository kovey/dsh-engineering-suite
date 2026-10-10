/**
 * Plugin configuration.
 *
 * The knowledge base has one unusual property among the suite's plugins: it
 * indexes the repository it runs in, so "how much of this project may be read
 * into an artifact" is a boundary decision, not a preference. The profile row
 * is the CEILING — where the index lives, how large a file or a chunk may be,
 * which sources exist, how retrieval is bounded — and a repository's own
 * `.dsh/knowledge-base.json` may only NARROW it: disable a source, drop
 * patterns, lower a bound, raise `minTokenLength`, turn CJK bigrams off. A
 * project may never point the index at a wider set of files than the host
 * allowed, because every widened pattern is a file whose content leaves the
 * repository's own reading path and lands in `.dsh/kb/`.
 *
 * Everything here is validated before use: an unusable value keeps the host's
 * value and is reported, never silently coerced.
 *
 * @module dsh-knowledge-base/config
 */

import { loadProjectConfig, type Layout, type LayoutOptions } from 'dsh-eng-core'

/** The six kinds of document the index knows. */
export type KbKind = 'spec' | 'adr' | 'trail' | 'plan' | 'docs' | 'code'

/** Every kind, in the order the default sources declare them. */
export const KB_KINDS: readonly KbKind[] = ['spec', 'adr', 'trail', 'plan', 'docs', 'code']

/** One collector: what it covers and whether it runs. */
export interface KbSourceConfig {
    /** Stable id (`spec`, `adr`, `trail`, `plan`, `docs`, `code`). */
    id: string
    kind: KbKind
    /**
     * Workspace-relative patterns the collector covers. A pattern starting
     * with `.dsh/` follows the resolved layout root instead of the literal
     * directory, so a host that relocates the engineering trail keeps its
     * index pointed at the right files.
     */
    globs: string[]
    enabled: boolean
}

/** Per-field weights of one query term. */
export interface KbFieldBoosts {
    /** Weight of a hit in the document title (default 3). */
    title: number
    /** Weight of a hit in an extracted symbol name (default 2). */
    symbols: number
    /** Weight of a hit in the chunk body (default 1). */
    body: number
}

/** Resolved plugin configuration. */
export interface KnowledgeBaseConfig {
    enabled: boolean
    /** Log file; `~` is expanded. */
    logFile: string
    /** Per-workspace log template (host-only). */
    logFileTemplate?: string
    layout: LayoutOptions
    prompt: {
        enabled: boolean
        order: number
    }
    /** Index directory, workspace-relative (default `.dsh/kb`). */
    indexDir: string
    /** Files larger than this are skipped by `stat`, never read (default 256 KiB). */
    maxFileBytes: number
    /** Line bound of one chunk (default 60). */
    maxChunkLines: number
    /** The collectors, in build order. */
    sources: KbSourceConfig[]
    tokenizer: {
        /**
         * Index and query CJK text as bigrams (default true). Off means a CJK
         * run is one token, so only an identical run matches.
         */
        cjkBigrams: boolean
        /** Tokens shorter than this are dropped (default 2). */
        minTokenLength: number
    }
    search: {
        /** Hits returned when the caller does not ask for a number (default 10). */
        limit: number
        /** Hard ceiling of `limit` (default 50). */
        maxLimit: number
        fieldBoosts: KbFieldBoosts
    }
}

/** Untrusted configuration input. */
type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

/** A positive integer, or the fallback when the value is not one. */
function positive(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * The six default collectors.
 *
 * Each row is the answer to "which files may this index quote". `.dsh/**` is
 * never walked as a tree: the sources that live there name their own directory,
 * so the index cannot grow a chunk of its own artifact, of a log, or of the
 * audit trail by accident.
 */
export const DEFAULT_SOURCES: readonly KbSourceConfig[] = [
    { id: 'spec', kind: 'spec', globs: ['.dsh/specs/*.md'], enabled: true },
    { id: 'adr', kind: 'adr', globs: ['.dsh/adr/*.md', '.dsh/adr/index.jsonl'], enabled: true },
    { id: 'trail', kind: 'trail', globs: ['.dsh/missions/**', '.dsh/releases.jsonl'], enabled: true },
    { id: 'plan', kind: 'plan', globs: ['.dsh/plan.jsonl'], enabled: true },
    { id: 'docs', kind: 'docs', globs: ['*.md', 'docs/**/*.md'], enabled: true },
    {
        id: 'code',
        kind: 'code',
        globs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.go', '**/*.py'],
        enabled: true,
    },
]

/** Resolve one declared source row onto its default (id and kind are fixed). */
function sourceOf(value: unknown, fallback: KbSourceConfig): KbSourceConfig {
    if (!isRecord(value) || value['id'] !== fallback.id) return { ...fallback, globs: [...fallback.globs] }
    const globs = Array.isArray(value['globs'])
        ? value['globs'].filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
        : fallback.globs
    return {
        id: fallback.id,
        kind: fallback.kind,
        globs: globs.length > 0 ? globs : [...fallback.globs],
        enabled: bool(value['enabled'], fallback.enabled),
    }
}

/**
 * Resolve the plugin configuration.
 * @param input - the loader row's `config` value (untrusted).
 * @returns the resolved configuration with every default applied.
 */
export function resolveConfig(input: unknown): KnowledgeBaseConfig {
    const raw = isRecord(input) ? input : {}
    const prompt = isRecord(raw['prompt']) ? raw['prompt'] : {}
    const layout = isRecord(raw['layout']) ? raw['layout'] : {}
    const tokenizer = isRecord(raw['tokenizer']) ? raw['tokenizer'] : {}
    const search = isRecord(raw['search']) ? raw['search'] : {}
    const boosts = isRecord(search['fieldBoosts']) ? search['fieldBoosts'] : {}

    const declared = Array.isArray(raw['sources']) ? raw['sources'] : []
    const sources = DEFAULT_SOURCES.map((fallback) => sourceOf(declared.find((entry) => isRecord(entry) && entry['id'] === fallback.id), fallback))

    const limit = Math.max(1, positive(search['limit'], 10))
    // `maxLimit` is the hard ceiling: when a host asks for a default above it,
    // the CEILING wins (a `limit` that ignores `maxLimit` would be a cap in name
    // only). The report states the value actually in force.
    const maxLimit = Math.max(1, Math.min(200, positive(search['maxLimit'], 50)))
    return {
        enabled: bool(raw['enabled'], true),
        logFile: str(raw['logFile'], '~/.dsh/knowledge-base.log'),
        ...(typeof raw['logFileTemplate'] === 'string' && raw['logFileTemplate'] !== ''
            ? { logFileTemplate: raw['logFileTemplate'] }
            : {}),
        layout: {
            ...(typeof layout['rootDir'] === 'string' ? { rootDir: layout['rootDir'] } : {}),
            ...(typeof layout['missionsDir'] === 'string' ? { missionsDir: layout['missionsDir'] } : {}),
            ...(typeof layout['specsDir'] === 'string' ? { specsDir: layout['specsDir'] } : {}),
        },
        prompt: {
            enabled: bool(prompt['enabled'], true),
            order: num(prompt['order'], 675),
        },
        indexDir: str(raw['indexDir'], '.dsh/kb'),
        // The floor is 1 KiB: a bound below that turns ordinary README files into
        // "skipped", which is a knowledge base that indexes nothing and says it
        // is working. The ceiling is 4 MiB for the same reason in reverse.
        maxFileBytes: Math.min(4 * 1024 * 1024, Math.max(1024, positive(raw['maxFileBytes'], 256 * 1024))),
        maxChunkLines: Math.min(1_000, Math.max(1, positive(raw['maxChunkLines'], 60))),
        sources,
        tokenizer: {
            cjkBigrams: bool(tokenizer['cjkBigrams'], true),
            minTokenLength: Math.max(1, Math.min(32, positive(tokenizer['minTokenLength'], 2))),
        },
        search: {
            limit: Math.min(limit, maxLimit),
            maxLimit,
            fieldBoosts: {
                title: Math.max(0, num(boosts['title'], 3)),
                symbols: Math.max(0, num(boosts['symbols'], 2)),
                body: Math.max(0.0001, num(boosts['body'], 1)),
            },
        },
    }
}

/** Keys a target repository may override in `<repo>/.dsh/knowledge-base.json`. */
export const PROJECT_OVERRIDABLE: readonly string[] = [
    'enabled',
    'indexDir',
    'maxFileBytes',
    'maxChunkLines',
    'sources',
    'tokenizer',
    'search',
]

/** One resolved configuration plus where it came from. */
export interface EffectiveConfig {
    config: KnowledgeBaseConfig
    source: 'profile' | 'project'
    file: string
    problems: string[]
}

/** Whether a workspace-relative index directory is usable. */
function usableIndexDir(value: string): boolean {
    if (value.trim() === '') return false
    if (value.startsWith('~') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
    const segments = value.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.')
    if (segments.length === 0) return false
    return !segments.includes('..')
}

/**
 * Overlay a workspace's own `<repo>/.dsh/knowledge-base.json` on the profile row.
 *
 * The rule is the suite's two-layer model, applied to a plugin that reads the
 * repository: the profile is the ceiling and a workspace may only narrow it.
 * Every refused widening is reported with its reason — a project file that
 * asked for a wider pattern than the host allowed must not look like it
 * succeeded.
 * @param host - the profile-resolved configuration.
 * @param layout - the workspace layout (for the file path and problem text).
 * @param logger - optional diagnostic sink.
 * @returns the effective configuration and its provenance.
 */
export function resolveEffectiveConfig(
    host: KnowledgeBaseConfig,
    layout: Layout,
    logger?: { warn: (message: string) => void },
): EffectiveConfig {
    const declared = loadProjectConfig<Raw>(layout, 'knowledge-base')
    const file = declared.file
    const problems = [...declared.problems]
    for (const problem of problems) logger?.warn(problem)
    const raw = declared.value
    if (raw === undefined) return { config: host, source: 'profile', file, problems }

    const report = (message: string): void => {
        problems.push(message)
        logger?.warn(message)
    }
    for (const key of Object.keys(raw)) {
        if (!PROJECT_OVERRIDABLE.includes(key)) report(`${file}: 键 "${key}" 不允许在项目级配置里覆盖（profile 是上限），已忽略`)
    }

    const next: KnowledgeBaseConfig = {
        ...host,
        sources: host.sources.map((source) => ({ ...source, globs: [...source.globs] })),
        tokenizer: { ...host.tokenizer },
        search: { ...host.search, fieldBoosts: { ...host.search.fieldBoosts } },
        prompt: { ...host.prompt },
        layout: { ...host.layout },
    }
    let applied = 0

    if (raw['enabled'] !== undefined) {
        if (raw['enabled'] === false) {
            next.enabled = false
            applied += 1
        } else if (raw['enabled'] !== true) {
            report(`${file}: enabled 必须是布尔值，已忽略（继续使用 profile 的值）`)
        } else if (host.enabled === false) {
            report(`${file}: 项目级配置不能把知识库从禁用改为启用（profile 是上限），已忽略`)
        }
    }

    if (raw['indexDir'] !== undefined) {
        const value = raw['indexDir']
        if (typeof value === 'string' && usableIndexDir(value)) {
            next.indexDir = value.trim().replace(/\/+$/, '')
            applied += 1
        } else {
            report(`${file}: indexDir 必须是不越出工作区的相对路径（不能是绝对路径、不能含 ".."），已忽略（继续使用 ${host.indexDir}）`)
        }
    }

    // Bound keys: the project may LOWER a ceiling, never raise it.
    const narrowBound = (key: 'maxFileBytes' | 'maxChunkLines'): void => {
        const value = raw[key]
        if (value === undefined) return
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            report(`${file}: ${key} 必须是正数，已忽略（继续使用 profile 的 ${host[key]}）`)
            return
        }
        const wanted = Math.floor(value)
        if (wanted > host[key]) {
            report(`${file}: ${key}=${wanted} 超过 profile 上限 ${host[key]}，已忽略（项目级只能收紧，不能放宽）`)
            return
        }
        next[key] = wanted
        applied += 1
    }
    narrowBound('maxFileBytes')
    narrowBound('maxChunkLines')

    const tokenizer = isRecord(raw['tokenizer']) ? raw['tokenizer'] : {}
    if (tokenizer['cjkBigrams'] !== undefined) {
        if (tokenizer['cjkBigrams'] === false) {
            if (host.tokenizer.cjkBigrams) {
                next.tokenizer.cjkBigrams = false
                applied += 1
            }
        } else if (tokenizer['cjkBigrams'] !== true) {
            report(`${file}: tokenizer.cjkBigrams 必须是布尔值，已忽略`)
        } else if (!host.tokenizer.cjkBigrams) {
            report(`${file}: 项目级配置不能打开 profile 关闭的 CJK bigram（那会扩大召回），已忽略`)
        }
    }
    if (tokenizer['minTokenLength'] !== undefined) {
        const value = tokenizer['minTokenLength']
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
            const wanted = Math.floor(value)
            if (wanted < host.tokenizer.minTokenLength) {
                report(
                    `${file}: tokenizer.minTokenLength=${wanted} 低于 profile 的 ${host.tokenizer.minTokenLength}（会更宽地召回），已忽略`,
                )
            } else {
                next.tokenizer.minTokenLength = wanted
                applied += 1
            }
        } else {
            report(`${file}: tokenizer.minTokenLength 必须是不小于 1 的数，已忽略`)
        }
    }

    const search = isRecord(raw['search']) ? raw['search'] : {}
    if (search['limit'] !== undefined) {
        const value = search['limit']
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
            const wanted = Math.floor(value)
            if (wanted > host.search.limit) {
                report(`${file}: search.limit=${wanted} 超过 profile 的 ${host.search.limit}，已忽略（项目级只能收紧）`)
            } else {
                next.search.limit = wanted
                applied += 1
            }
        } else {
            report(`${file}: search.limit 必须是不小于 1 的数，已忽略`)
        }
    }
    if (search['maxLimit'] !== undefined) {
        const value = search['maxLimit']
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
            const wanted = Math.floor(value)
            if (wanted > host.search.maxLimit) {
                report(`${file}: search.maxLimit=${wanted} 超过 profile 上限 ${host.search.maxLimit}，已忽略（项目级只能收紧）`)
            } else {
                next.search.maxLimit = wanted
                if (next.search.limit > wanted) next.search.limit = wanted
                applied += 1
            }
        } else {
            report(`${file}: search.maxLimit 必须是不小于 1 的数，已忽略`)
        }
    }

    const sources = Array.isArray(raw['sources']) ? raw['sources'] : []
    for (const entry of sources) {
        if (!isRecord(entry)) {
            report(`${file}: sources 的每一项都必须是对象，已忽略该项`)
            continue
        }
        const id = typeof entry['id'] === 'string' ? entry['id'] : ''
        const target = next.sources.find((source) => source.id === id)
        if (target === undefined) {
            report(`${file}: sources 里出现了未定义来源 ${JSON.stringify(id === '' ? entry['id'] : id)}，已忽略（项目级不能新增来源）`)
            continue
        }
        if (entry['kind'] !== undefined && entry['kind'] !== target.kind) {
            report(`${file}: sources[${id}].kind 不允许修改（${target.kind} → ${String(entry['kind'])}），已忽略`)
        }
        if (entry['enabled'] !== undefined) {
            if (entry['enabled'] === false) {
                target.enabled = false
                applied += 1
            } else if (entry['enabled'] !== true) {
                report(`${file}: sources[${id}].enabled 必须是布尔值，已忽略`)
            } else if (host.sources.find((source) => source.id === id)?.enabled === false) {
                report(`${file}: 项目级配置不能启用 profile 关闭的来源 ${id}，已忽略`)
            }
        }
        if (entry['globs'] !== undefined) {
            if (!Array.isArray(entry['globs'])) {
                report(`${file}: sources[${id}].globs 必须是字符串数组，已忽略`)
                continue
            }
            const hostPatterns = host.sources.find((source) => source.id === id)?.globs ?? []
            const wanted = entry['globs'].filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')
            const widened = wanted.filter((pattern) => !hostPatterns.includes(pattern))
            if (widened.length > 0) {
                report(
                    `${file}: sources[${id}].globs 新增了 profile 未授权的模式 ${widened.map((pattern) => JSON.stringify(pattern)).join(', ')}，已忽略（项目级只能删减模式）`,
                )
                continue
            }
            if (wanted.length === 0) {
                report(`${file}: sources[${id}].globs 为空，已忽略（要停用请写 enabled: false）`)
                continue
            }
            target.globs = wanted
            applied += 1
        }
    }

    if (applied === 0) return { config: host, source: 'profile', file, problems }
    return { config: next, source: 'project', file, problems }
}

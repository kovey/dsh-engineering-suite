/**
 * Dependency manifests and audit reports: PURE parsing, no I/O, deterministic.
 *
 * Two questions, both answerable without guessing:
 *
 *  1. **"Did this change add a dependency?"** — a manifest diff. Only DECLARED
 *     manifests are diffed (a lockfile's delta is a flood of transitive pins, not
 *     a decision anyone can approve); lockfiles are used for the orphan check
 *     instead: a lockfile that changed while its declaring manifest did not.
 *  2. **"Does the auditor say something is wrong?"** — {@link parseAuditOutput}
 *     understands the shapes the common auditors actually print
 *     (`govulncheck`, `npm audit --json`, `pip-audit --format json`,
 *     `composer audit --format=json`, `cargo audit --json`, `bundler-audit`'s
 *     JSON and `dotnet list package --vulnerable --format json`) plus a bounded
 *     generic JSON walker. An output it does NOT understand is a `problem` — the
 *     one thing it may never be is "no vulnerabilities found".
 *
 * The parsers are line/JSON oriented on purpose (no TOML or YAML dependency):
 * they cover the manifest constructs that declare dependencies, and the README
 * says so. A parser that silently reads half a file would be worse than one that
 * names its bounds.
 *
 * @module dsh-supply-chain-gate/deps
 */

import { globToRegExp } from 'dsh-eng-core'

/** One declared dependency. */
export interface DependencyEntry {
    name: string
    /** Version or version constraint as written (`v1.2.3`, `^1.0.0`, `>=2`). */
    version: string
    /** Where it was declared (`dependencies`, `require-indirect`, …). */
    kind: string
}

/** One dependency whose declared version changed. */
export interface DependencyChange {
    name: string
    from: string
    to: string
    kind: string
}

/** Supported manifest formats. */
export type ManifestFormat =
    | 'go.mod'
    | 'package.json'
    | 'requirements.txt'
    | 'pyproject.toml'
    | 'Cargo.toml'
    | 'composer.json'
    | 'composer.lock'
    | 'Gemfile'

/** The result of diffing one manifest against its base revision. */
export interface ManifestDiff {
    path: string
    /** Newly declared dependencies (sorted by name, then kind). */
    added: DependencyEntry[]
    /** Removed dependencies (informational: a removal is not a supply-chain risk). */
    removed: DependencyEntry[]
    /** Same name and kind, different version constraint. */
    changed: DependencyChange[]
    /** How many entries were parsed on each side (the report shows them). */
    counts: { before: number; after: number }
    /** Parsing / support problem; set = this manifest was NOT judged. */
    problem?: string
    /** Whether the text differs at all. */
    textChanged: boolean
    /** How this manifest is treated (`watch-only` = changed-but-unparseable). */
    treatment: 'declared' | 'lockfile' | 'watch-only'
    /** The file name relative to the workspace. */
    format?: ManifestFormat
}

/** Formats this module can parse. */
const MANIFESTS = new Map<string, ManifestFormat>([
    ['go.mod', 'go.mod'],
    ['package.json', 'package.json'],
    ['pyproject.toml', 'pyproject.toml'],
    ['Cargo.toml', 'Cargo.toml'],
    ['composer.json', 'composer.json'],
    ['composer.lock', 'composer.lock'],
    ['Gemfile', 'Gemfile'],
])

/**
 * Lockfiles: never diffed for new dependencies, only checked for orphan changes.
 *
 * The value is the DECLARING manifest the orphan check compares against. A glob
 * is allowed when the declaring manifest's name varies (a .NET lockfile belongs
 * to whichever `*.csproj` sits beside it) — the tool layer resolves it against
 * the workspace, so "lock changed, manifest did not" stays checkable.
 */
const LOCKFILES: ReadonlyMap<string, string> = new Map([
    ['go.sum', 'go.mod'],
    ['package-lock.json', 'package.json'],
    ['pnpm-lock.yaml', 'package.json'],
    ['yarn.lock', 'package.json'],
    ['Cargo.lock', 'Cargo.toml'],
    ['composer.lock', 'composer.json'],
    ['Gemfile.lock', 'Gemfile'],
    ['packages.lock.json', '*.csproj'],
])

/**
 * Watched but unparseable manifests: a change to one of these is REPORTED as a
 * change we could not interpret (WARN), never silently approved.
 */
const WATCH_ONLY: readonly string[] = ['pom.xml', 'build.gradle']

/** The declaring manifest a lockfile belongs to, when it is a known lockfile. */
export function lockfileManifestOf(path: string): string | undefined {
    return LOCKFILES.get(basename(path))
}

/** Whether a configured manifest name is a lockfile. */
export function isLockfile(path: string): boolean {
    return LOCKFILES.has(basename(path))
}

/** Whether a configured manifest name is watched but not parseable. */
export function isWatchOnly(path: string): boolean {
    return WATCH_ONLY.includes(basename(path))
}

function basename(path: string): string {
    const parts = path.split('/')
    return parts[parts.length - 1] ?? path
}

/** How a configured manifest will be treated. */
export function treatmentOf(path: string): ManifestDiff['treatment'] {
    if (isLockfile(path)) return 'lockfile'
    if (isWatchOnly(path)) return 'watch-only'
    return 'declared'
}

/** The format for a path, when a parser exists for it. */
export function formatOf(path: string): ManifestFormat | undefined {
    const name = basename(path)
    const direct = MANIFESTS.get(name)
    if (direct !== undefined) return direct
    if (/^requirements.*\.txt$/.test(name)) return 'requirements.txt'
    return undefined
}

/** Parse one manifest into declared dependencies. */
export interface ParsedManifest {
    format?: ManifestFormat
    entries: DependencyEntry[]
    problem?: string
}

/**
 * Parse one manifest text.
 * @param path - workspace-relative path (its basename selects the parser).
 * @param text - the file body.
 */
export function parseManifest(path: string, text: string): ParsedManifest {
    const format = formatOf(path)
    if (format === undefined) {
        return {
            entries: [],
            problem: `不支持的清单格式（${basename(path)}）：支持 go.mod / package.json / requirements*.txt / pyproject.toml / Cargo.toml / composer.json / composer.lock / Gemfile`,
        }
    }
    switch (format) {
        case 'go.mod':
            return { format, entries: parseGoMod(text) }
        case 'package.json':
            return parsePackageJson(text)
        case 'requirements.txt':
            return { format, entries: parseRequirements(text) }
        case 'pyproject.toml':
            return { format, entries: parsePyproject(text) }
        case 'Cargo.toml':
            return { format, entries: parseCargo(text) }
        case 'composer.json':
            return parseComposerJson(text)
        case 'composer.lock':
            return parseComposerLock(text)
        case 'Gemfile':
            return { format, entries: parseGemfile(text) }
    }
}

/**
 * Diff one manifest against its base revision.
 *
 * `before` is `undefined` when the file did not exist at the base (a brand-new
 * manifest: every dependency in it is new), which the caller must only conclude
 * from a valid base revision — an unresolvable `base` is NOT "everything is new".
 * @param input - path, base text (optional) and current text.
 */
export function diffManifests(input: { path: string; before?: string; after: string }): ManifestDiff {
    const treatment = treatmentOf(input.path)
    const before = input.before ?? ''
    const textChanged = before !== input.after
    const format = formatOf(input.path)
    const base: Omit<ManifestDiff, 'added' | 'removed' | 'changed' | 'counts'> = {
        path: input.path,
        textChanged,
        treatment,
        ...(format === undefined ? {} : { format }),
    }
    if (treatment !== 'declared') {
        // A lockfile or a watch-only manifest has no declared-dependency diff.
        return { ...base, added: [], removed: [], changed: [], counts: { before: 0, after: 0 } }
    }
    const parsedBefore = parseManifest(input.path, before)
    const parsedAfter = parseManifest(input.path, input.after)
    const problem = parsedAfter.problem ?? parsedBefore.problem
    if (problem !== undefined) {
        return { ...base, added: [], removed: [], changed: [], counts: { before: 0, after: 0 }, problem }
    }

    const key = (entry: DependencyEntry): string => `${entry.name}\u0000${entry.kind}`
    const beforeIndex = new Map(parsedBefore.entries.map((entry) => [key(entry), entry]))
    const afterIndex = new Map(parsedAfter.entries.map((entry) => [key(entry), entry]))
    const added: DependencyEntry[] = []
    const removed: DependencyEntry[] = []
    const changed: DependencyChange[] = []
    for (const [id, entry] of afterIndex) {
        const previous = beforeIndex.get(id)
        if (previous === undefined) {
            added.push(entry)
            continue
        }
        if (previous.version !== entry.version) {
            changed.push({ name: entry.name, from: previous.version, to: entry.version, kind: entry.kind })
        }
    }
    for (const [id, entry] of beforeIndex) {
        if (!afterIndex.has(id)) removed.push(entry)
    }
    const byName = (left: DependencyEntry, right: DependencyEntry): number =>
        left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind) || left.version.localeCompare(right.version)
    added.sort(byName)
    removed.sort(byName)
    changed.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind))
    return {
        ...base,
        added,
        removed,
        changed,
        counts: { before: parsedBefore.entries.length, after: parsedAfter.entries.length },
    }
}

// --- go.mod -----------------------------------------------------------------

/** `require` lines, single-line and block form, with the `// indirect` marker. */
function parseGoMod(text: string): DependencyEntry[] {
    const entries: DependencyEntry[] = []
    let inBlock = false
    for (const raw of text.split('\n')) {
        const comment = raw.indexOf('//')
        const code = (comment >= 0 ? raw.slice(0, comment) : raw).trim()
        const indirect = comment >= 0 && /\/\/\s*indirect/.test(raw)
        if (code === '') continue
        if (!inBlock && /^require\s*\($/.test(code)) {
            inBlock = true
            continue
        }
        if (inBlock && code === ')') {
            inBlock = false
            continue
        }
        const line = inBlock ? code : code.replace(/^require\s+/, '')
        if (!inBlock && !/^require\s+/.test(code)) continue
        const [name, version] = line.split(/\s+/)
        if (name === undefined || version === undefined) continue
        entries.push({ name, version, kind: indirect ? 'require-indirect' : 'require' })
    }
    return entries
}

// --- package.json -----------------------------------------------------------

/** `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`. */
function parsePackageJson(text: string): ParsedManifest {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        return {
            format: 'package.json',
            entries: [],
            problem: `package.json 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）：无法判定依赖变化`,
        }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { format: 'package.json', entries: [], problem: 'package.json 顶层不是对象' }
    }
    const entries: DependencyEntry[] = []
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const value = (parsed as Record<string, unknown>)[section]
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
            if (typeof version !== 'string') continue
            entries.push({ name, version, kind: section })
        }
    }
    return { format: 'package.json', entries }
}

// --- requirements.txt -------------------------------------------------------

/** `name[extras] <=> version` lines; `-r`/`-c`/`-e`/options are skipped. */
function parseRequirements(text: string): DependencyEntry[] {
    const entries: DependencyEntry[] = []
    for (const raw of text.split('\n')) {
        const withoutComment = raw.replace(/\s+#.*$/, '').trim()
        if (withoutComment === '') continue
        if (withoutComment.startsWith('-')) continue
        const [specifier] = withoutComment.split(';')
        const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec((specifier ?? '').trim())
        if (match === null) continue
        const name = (match[1] ?? '').toLowerCase().replace(/[._]+/g, '-')
        if (name === '') continue
        entries.push({ name, version: (match[3] ?? '').trim() === '' ? '*' : (match[3] ?? '').trim(), kind: 'requirement' })
    }
    return entries
}

// --- pyproject.toml ---------------------------------------------------------

/** PEP 621 (`[project]`) and poetry (`[tool.poetry…]`) declarations. */
function parsePyproject(text: string): DependencyEntry[] {
    const entries: DependencyEntry[] = []
    for (const { section, key, value } of tomlEntries(text)) {
        if (section === 'project' && key === 'dependencies') {
            for (const requirement of quotedStrings(value)) entries.push(requirementEntry(requirement, 'project.dependencies'))
            continue
        }
        if (section === 'project.optional-dependencies') {
            const kind = `project.optional-dependencies.${key}`
            for (const requirement of quotedStrings(value)) entries.push(requirementEntry(requirement, kind))
            continue
        }
        if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
            // `python` in [tool.poetry.dependencies] is the interpreter constraint,
            // not a dependency: counting it would report a phantom addition on
            // every Python upgrade.
            if (key === 'python') continue
            const version = inlineString(value, 'version') ?? (value.trim().startsWith('"') ? value.trim().replace(/^"|"$/g, '') : '')
            const provenance = /path\s*=/.test(value) ? '(path)' : /git\s*=/.test(value) ? '(git)' : version
            entries.push({ name: key.toLowerCase().replace(/[._]+/g, '-'), version: provenance === '' ? '*' : provenance, kind: section })
        }
    }
    return entries
}

/** One PEP 508 requirement string (`name[extra]>=1.0`) → entry. */
function requirementEntry(requirement: string, kind: string): DependencyEntry {
    const [specifier] = requirement.split(';')
    const text = (specifier ?? '').trim()
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(text)
    const name = (match?.[1] ?? text).toLowerCase().replace(/[._]+/g, '-')
    const rest = (match?.[3] ?? '').trim()
    return { name, version: rest === '' ? '*' : rest, kind }
}

// --- Cargo.toml -------------------------------------------------------------

/** `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, `[target…]`. */
function parseCargo(text: string): DependencyEntry[] {
    const entries: DependencyEntry[] = []
    for (const { section, key, value } of tomlEntries(text)) {
        if (!/(^|\.)(dev-|build-)?dependencies$/.test(section)) continue
        const version = inlineString(value, 'version')
        const text = value.trim()
        const direct = /^"(.*)"$/.exec(text)?.[1]
        const provenance = /path\s*=/.test(text) ? '(path)' : /git\s*=/.test(text) ? '(git)' : (version ?? direct ?? '*')
        entries.push({ name: key, version: provenance, kind: section })
    }
    return entries
}

// --- composer.json ----------------------------------------------------------

/**
 * `require` / `require-dev`.
 *
 * Composer's PLATFORM packages are skipped: `php`, `ext-*`, `lib-*` and the
 * `composer-plugin-api` / `composer-runtime-api` constraints are requirements on
 * the runtime, not installable dependencies. Counting them would report a
 * phantom "new dependency" on every PHP upgrade — the same reason pyproject
 * skips `python`.
 */
function parseComposerJson(text: string): ParsedManifest {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        return {
            format: 'composer.json',
            entries: [],
            problem: `composer.json 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）：无法判定依赖变化`,
        }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { format: 'composer.json', entries: [], problem: 'composer.json 顶层不是对象' }
    }
    const entries: DependencyEntry[] = []
    for (const section of ['require', 'require-dev']) {
        const value = (parsed as Record<string, unknown>)[section]
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
            if (typeof version !== 'string') continue
            if (isComposerPlatformPackage(name)) continue
            entries.push({ name, version, kind: section })
        }
    }
    return { format: 'composer.json', entries }
}

/** Whether a `require` key names a Composer platform package, not a library. */
function isComposerPlatformPackage(name: string): boolean {
    return name === 'php' || /^ext-/.test(name) || /^lib-/.test(name) || name === 'composer-plugin-api' || name === 'composer-runtime-api'
}

// --- composer.lock ----------------------------------------------------------

/**
 * `packages[]` / `packages-dev[]`, each an object with `name` and `version`.
 *
 * A lockfile is never diffed for new dependencies (its delta is a flood of
 * transitive pins), so this parser serves `parseManifest` callers and the
 * artifact's format label; the orphan check is the table lookup above.
 */
function parseComposerLock(text: string): ParsedManifest {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        return {
            format: 'composer.lock',
            entries: [],
            problem: `composer.lock 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）：无法判定锁文件内容`,
        }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { format: 'composer.lock', entries: [], problem: 'composer.lock 顶层不是对象' }
    }
    const entries: DependencyEntry[] = []
    for (const section of ['packages', 'packages-dev']) {
        const value = (parsed as Record<string, unknown>)[section]
        if (!Array.isArray(value)) continue
        for (const raw of value) {
            if (typeof raw !== 'object' || raw === null) continue
            const record = raw as Record<string, unknown>
            const name = typeof record['name'] === 'string' ? record['name'] : undefined
            if (name === undefined || name === '') continue
            entries.push({ name, version: typeof record['version'] === 'string' ? record['version'] : '*', kind: section })
        }
    }
    return { format: 'composer.lock', entries }
}

// --- Gemfile ----------------------------------------------------------------

/**
 * `gem 'name', '~> 1.0'` declarations, grouped by the surrounding `group … do`
 * block (one level: a nested group is recorded under the inner one).
 *
 * Bounded on purpose — this is not a Ruby parser. `gemspec` (dependencies come
 * from a gemspec) and `eval_gemfile` are NOT followed, only the FIRST version
 * constraint after the name is read, and a `gem` line inside an `if` is still
 * read: being wrong about scope is better than dropping a declaration the
 * repository actually has.
 */
function parseGemfile(text: string): DependencyEntry[] {
    const entries: DependencyEntry[] = []
    let kind = 'gem'
    for (const raw of text.split('\n')) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim()
        if (line === '') continue
        const group = /^group\s+(.+?)\s+do\b/.exec(line)
        if (group !== null) {
            const names = (group[1] ?? '')
                .replace(/:/g, '')
                .replace(/\s*,\s*/g, ',')
                .trim()
            kind = `group ${names}`
            continue
        }
        if (line === 'end') {
            kind = 'gem'
            continue
        }
        const declared = /^gem\s+(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]*)\3)?/.exec(line)
        const name = declared?.[2]
        if (name === undefined || name === '') continue
        const version = (declared?.[4] ?? '').trim()
        entries.push({ name, version: version === '' ? '*' : version, kind })
    }
    return entries
}

// --- a bounded TOML-lite reader --------------------------------------------

/** One `key = value` line with the section path it lives under. */
interface TomlEntry {
    /** Dotted section path (`tool.poetry.dependencies`). */
    section: string
    /** Unquoted key. */
    key: string
    /** Raw value text, with multi-line arrays/inline tables joined. */
    value: string
}

/**
 * Read `key = value` pairs out of a TOML file.
 *
 * Bounded on purpose: comments and blank lines are skipped, quoted keys are
 * unquoted, and a value whose brackets/quotes do not close on its own line keeps
 * accumulating (bounded to 200 lines) so `dependencies = [\n "a",\n]` is read as
 * one value. It is not a TOML implementation and does not pretend to be.
 */
function tomlEntries(text: string): TomlEntry[] {
    const entries: TomlEntry[] = []
    const lines = text.split('\n')
    let section = ''
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').replace(/(^|\s)#.*$/, '').trim()
        if (line === '') continue
        const header = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line)
        if (header !== null) {
            section = unquoteKey((header[1] ?? '').trim())
            continue
        }
        const pair = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line)
        if (pair === null) continue
        const key = unquoteKey((pair[1] ?? '').trim())
        let value = pair[2] ?? ''
        let guard = 0
        while (!balanced(value) && index + 1 < lines.length && guard < 200) {
            index += 1
            guard += 1
            value += `\n${(lines[index] ?? '').replace(/(^|\s)#.*$/, '')}`
        }
        entries.push({ section, key, value })
    }
    return entries
}

/** Whether brackets/quotes in a value are balanced (i.e. the value is complete). */
function balanced(value: string): boolean {
    let square = 0
    let curly = 0
    let inString = false
    for (const character of value) {
        if (character === '"') inString = !inString
        else if (!inString && character === '[') square += 1
        else if (!inString && character === ']') square -= 1
        else if (!inString && character === '{') curly += 1
        else if (!inString && character === '}') curly -= 1
    }
    return !inString && square <= 0 && curly <= 0
}

function unquoteKey(key: string): string {
    return key.replace(/^["']|["']$/g, '')
}

/** Every double-quoted string inside a value (arrays of requirements). */
function quotedStrings(value: string): string[] {
    const out: string[] = []
    for (const match of value.matchAll(/"([^"]*)"/g)) {
        const text = match[1]
        if (text !== undefined && text.trim() !== '') out.push(text)
    }
    return out
}

/** `version = "1.0"` inside an inline table. */
function inlineString(value: string, key: string): string | undefined {
    return new RegExp(`(?:^|[,{\\s])${key}\\s*=\\s*"([^"]*)"`).exec(value)?.[1]
}

// --- audit reports ----------------------------------------------------------

/** The report shapes this module recognises. */
export type AuditShape =
    | 'govulncheck-json'
    | 'govulncheck-text'
    | 'npm-audit-json'
    | 'pip-audit-json'
    | 'composer-audit-json'
    | 'cargo-audit-json'
    | 'bundler-audit-json'
    | 'dotnet-vulnerable-json'
    | 'generic-json'
    | 'text-clean'
    | 'unknown'

/** What kind of entry a finding is (a CVE-less entry is still an entry). */
export type AuditFindingKind = 'vulnerability' | 'abandoned' | 'unpatched'

/** One vulnerability an auditor reported. */
export interface AuditFinding {
    /** Package / module the finding is about, when the shape says. */
    package?: string
    /** Advisory id (`GO-2022-0969`, `GHSA-…`, `CVE-…`, `RUSTSEC-…`). */
    id?: string
    /** Lower-case severity, or `unknown` when the report carries none. */
    severity: string
    title?: string
    url?: string
    /** Version the auditor says fixes it, when reported. */
    fixedIn?: string
    /**
     * Entry class. Defaults to `vulnerability`; `abandoned` (composer) and
     * `unpatched` (bundler-audit) are NOT CVEs and are reported as their own
     * class instead of being dropped or disguised as one.
     */
    kind?: AuditFindingKind
}

/** The result of parsing one audit command's output. */
export interface AuditParseResult {
    shape: AuditShape
    findings: AuditFinding[]
    /**
     * Set when the output could NOT be interpreted (or the command failed
     * without a readable report). A problem is never "clean" — the gate treats
     * it as BLOCK.
     */
    problem?: string
    /** How many entries were dropped by the finding cap (never silent). */
    dropped?: number
}

/** Severity tokens the block/warn lists are compared against. */
export function normalizeSeverity(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // A CVSS score is a severity in disguise (documented mapping).
        if (value >= 9) return 'critical'
        if (value >= 7) return 'high'
        if (value >= 4) return 'medium'
        return 'low'
    }
    if (typeof value !== 'string') return 'unknown'
    const text = value.trim().toLowerCase()
    if (text === '') return 'unknown'
    return text
}

/** Bound on findings kept from one report (the tail is counted, not listed). */
const MAX_AUDIT_FINDINGS = 500

/** Bound on JSON nodes the generic walker visits. */
const MAX_JSON_NODES = 50_000

/**
 * Parse one audit command's output.
 *
 * Recognises `govulncheck` (JSONL stream or text), `npm audit --json`,
 * `pip-audit --format json`, a bounded generic JSON walk, and the short
 * "no vulnerabilities found" report. Anything else is a `problem`.
 * @param input - the command line, its streams and exit code.
 */
export function parseAuditOutput(input: {
    command: string
    stdout: string
    stderr: string
    exitCode: number | null
}): AuditParseResult {
    const stdout = input.stdout.trim()
    const body = stdout !== '' ? input.stdout : input.stderr
    const text = body.trim()
    if (text === '') {
        return {
            shape: 'unknown',
            findings: [],
            // Empty output cannot be told apart from "the command did nothing".
            problem: `审计命令没有任何输出（exit=${input.exitCode === null ? 'null' : input.exitCode}）：空输出不等于没有漏洞，无法判定`,
        }
    }

    const asJson = tryJson(text)
    if (asJson !== undefined) {
        const shaped = shapeJson(asJson)
        return withExitGuard(shaped, input.exitCode)
    }
    const jsonl = tryJsonl(text)
    if (jsonl !== undefined) {
        const shaped = shapeJsonl(jsonl)
        return withExitGuard(shaped, input.exitCode)
    }

    if (/^Vulnerability #\d+:/m.test(text)) {
        return withExitGuard({ shape: 'govulncheck-text', findings: parseGovulncheckText(text) }, input.exitCode)
    }
    if (looksClean(text)) {
        return { shape: 'text-clean', findings: [] }
    }
    return {
        shape: 'unknown',
        findings: [],
        problem:
            `无法识别审计输出格式（${text.length} 字节、${text.split('\n').length} 行）：` +
            '既不是 govulncheck / npm audit --json / pip-audit --format json / composer audit --format=json / cargo audit --json / ' +
            'bundler-audit json / dotnet list package --vulnerable json，也不是"没有漏洞"的结论。' +
            '按 fail-closed 处理为 BLOCK —— 未识别的报告不等于干净的仓库。',
    }
}

/** A failed command must not hand back an empty (i.e. "clean") report. */
function withExitGuard(result: AuditParseResult, exitCode: number | null): AuditParseResult {
    if (result.problem !== undefined) return result
    if (exitCode !== null && exitCode !== 0 && result.findings.length === 0) {
        return {
            shape: result.shape,
            findings: [],
            problem: `审计命令退出码 ${exitCode} 但报告里没有任何条目：无法确认它真的跑完了（网络/锁文件/工具错误都会长这样）`,
        }
    }
    return result
}

/** Parse a whole-body JSON document. */
function tryJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}

/** Parse a JSONL stream (govulncheck `-json` prints one object per line). */
function tryJsonl(text: string): unknown[] | undefined {
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) return undefined
    const out: unknown[] = []
    for (const line of lines) {
        try {
            out.push(JSON.parse(line) as unknown)
        } catch {
            return undefined
        }
    }
    return out
}

/** Whether a value is a JSON object (not null, and not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recognise a parsed JSON document. */
function shapeJson(document: unknown): AuditParseResult {
    if (typeof document !== 'object' || document === null) {
        return { shape: 'unknown', findings: [], problem: '审计输出是合法 JSON 但不是对象（无法判定）' }
    }
    const record = document as Record<string, unknown>
    // Order matters: cargo audit's `vulnerabilities` is ONE object
    // (found/count/list) while npm's is a map keyed by package name, so the
    // stricter shape is tested first. Composer's `advisories` is likewise a map
    // of ARRAYS and cannot be confused with npm's (objects keyed by id).
    if (isComposerAudit(record)) {
        return { shape: 'composer-audit-json', findings: parseComposerAudit(record) }
    }
    if (isCargoAudit(record)) {
        return { shape: 'cargo-audit-json', findings: parseCargoAudit(record) }
    }
    if (isPlainObject(record['vulnerabilities'])) {
        return { shape: 'npm-audit-json', findings: parseNpmAudit(record['vulnerabilities']) }
    }
    if (Array.isArray(record['dependencies'])) {
        return { shape: 'pip-audit-json', findings: parsePipAudit(record['dependencies']) }
    }
    if (isBundlerAudit(record)) {
        return { shape: 'bundler-audit-json', findings: parseBundlerAudit(record) }
    }
    if (isDotnetVulnerable(record)) {
        return { shape: 'dotnet-vulnerable-json', findings: parseDotnetVulnerable(record) }
    }
    if (record['finding'] !== undefined || Array.isArray(record['findings'])) {
        return { shape: 'govulncheck-json', findings: parseGovulncheckJson([record]) }
    }
    if (record['error'] !== undefined) {
        // Never echo the message: a registry URL can carry credentials.
        const code = (record['error'] as Record<string, unknown> | undefined)?.['code']
        return {
            shape: 'unknown',
            findings: [],
            problem: `审计命令返回了错误对象${typeof code === 'string' ? `（code=${code}）` : ''}：没有可判定的报告`,
        }
    }
    return genericWalk(document)
}

/** Recognise a parsed JSONL stream. */
function shapeJsonl(documents: readonly unknown[]): AuditParseResult {
    const objects = documents.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    if (objects.some((entry) => entry['finding'] !== undefined)) {
        return { shape: 'govulncheck-json', findings: parseGovulncheckJson(objects) }
    }
    return genericWalk(objects)
}

/** `npm audit --json`: `vulnerabilities.<pkg>.severity`. */
function parseNpmAudit(vulnerabilities: Record<string, unknown>): AuditFinding[] {
    const findings: AuditFinding[] = []
    for (const [name, raw] of Object.entries(vulnerabilities)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as Record<string, unknown>
        const via = Array.isArray(entry['via']) ? entry['via'] : []
        const advisories = via.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        const title = advisories.map((item) => (typeof item['title'] === 'string' ? item['title'] : undefined)).find((value) => value !== undefined)
        const url = advisories.map((item) => (typeof item['url'] === 'string' ? item['url'] : undefined)).find((value) => value !== undefined)
        const id = advisories.map((item) => (typeof item['source'] === 'string' || typeof item['source'] === 'number' ? `npm:${String(item['source'])}` : undefined)).find((value) => value !== undefined)
        findings.push({
            package: name,
            severity: normalizeSeverity(entry['severity']),
            ...(id === undefined ? {} : { id }),
            ...(title === undefined ? {} : { title }),
            ...(url === undefined ? {} : { url }),
            ...(typeof entry['range'] === 'string' ? { fixedIn: `range ${entry['range']}` } : {}),
        })
    }
    return sortFindings(findings)
}

/** `pip-audit --format json`: `dependencies[].vulns[]` (no severity field). */
function parsePipAudit(dependencies: readonly unknown[]): AuditFinding[] {
    const findings: AuditFinding[] = []
    for (const raw of dependencies) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as Record<string, unknown>
        const name = typeof entry['name'] === 'string' ? entry['name'] : undefined
        const version = typeof entry['version'] === 'string' ? entry['version'] : undefined
        const vulns = Array.isArray(entry['vulns']) ? entry['vulns'] : []
        for (const vuln of vulns) {
            if (typeof vuln !== 'object' || vuln === null) continue
            const record = vuln as Record<string, unknown>
            const fixVersions = Array.isArray(record['fix_versions']) ? record['fix_versions'].filter((item): item is string => typeof item === 'string') : []
            const description = typeof record['description'] === 'string' ? firstLine(record['description']) : undefined
            findings.push({
                ...(name === undefined ? {} : { package: name }),
                ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
                // pip-audit's JSON carries NO severity: reporting `unknown` is the
                // honest label (see the README's honest limits).
                severity: normalizeSeverity(record['severity'] ?? record['severity_level']),
                ...(description === undefined
                    ? name === undefined || version === undefined
                        ? {}
                        : { title: `${name}@${version}` }
                    : { title: description }),
                ...(fixVersions.length === 0 ? {} : { fixedIn: fixVersions.join(', ') }),
            })
        }
    }
    return sortFindings(findings)
}

// --- composer audit ---------------------------------------------------------

/**
 * `composer audit --format=json`:
 * `{ "advisories": { "vendor/pkg": [ { advisoryId, packageName,
 * affectedVersions, title, cve?, link?, reportedAt?, severity? } ] },
 * "abandoned": { "vendor/pkg": "no replacement" | true | null } }`.
 *
 * The recogniser requires the per-package ARRAY (composer groups advisories that
 * way). npm v6's `advisories` map holds OBJECTS keyed by advisory id, so it is
 * not mistaken for composer's report.
 *
 * A CLEAN composer report is `{"advisories": [], "abandoned": [], "filter": []}`:
 * Composer encodes PHP arrays with `JsonFile::encode` (no `JSON_FORCE_OBJECT`),
 * so "nothing found" is `[]`, not `{}` — verified against Composer 2.10's
 * `AuditCommand` source. Both spellings are accepted, but only when BOTH keys are
 * present: `{"advisories":[]}` alone is not evidence of a clean PHP project.
 */
function isComposerAudit(record: Record<string, unknown>): boolean {
    const advisories = record['advisories']
    const abandoned = record['abandoned']
    const abandonedIsReport = isPlainObject(abandoned) || (Array.isArray(abandoned) && abandoned.length === 0)
    if (isPlainObject(advisories)) {
        if (Object.values(advisories).some(Array.isArray)) return true
        if (Object.keys(advisories).length === 0 && abandonedIsReport) return true
    }
    if (Array.isArray(advisories) && advisories.length === 0) return abandonedIsReport
    return advisories === undefined && isPlainObject(abandoned) && Object.keys(abandoned).length > 0
}

/** One finding per advisory, plus one per abandoned package (its own class). */
function parseComposerAudit(record: Record<string, unknown>): AuditFinding[] {
    const findings: AuditFinding[] = []
    const advisories = isPlainObject(record['advisories']) ? record['advisories'] : {}
    for (const [pkg, raw] of Object.entries(advisories)) {
        if (!Array.isArray(raw)) continue
        for (const item of raw) {
            if (!isPlainObject(item)) continue
            const affected = typeof item['affectedVersions'] === 'string' && item['affectedVersions'] !== '' ? item['affectedVersions'] : undefined
            const title = typeof item['title'] === 'string' && item['title'] !== '' ? item['title'] : undefined
            const id =
                typeof item['advisoryId'] === 'string' && item['advisoryId'] !== ''
                    ? item['advisoryId']
                    : typeof item['cve'] === 'string' && item['cve'] !== ''
                      ? item['cve']
                      : undefined
            findings.push({
                package: typeof item['packageName'] === 'string' && item['packageName'] !== '' ? item['packageName'] : pkg,
                ...(id === undefined ? {} : { id }),
                // Composer reports a severity for many (not all) advisories; the
                // affected range is NOT a fix version, so it goes into the title.
                severity: normalizeSeverity(item['severity']),
                ...(title === undefined ? {} : { title: affected === undefined ? title : `${title}（受影响版本 ${affected}）` }),
                ...(typeof item['link'] === 'string' && item['link'] !== '' ? { url: item['link'] } : {}),
            })
        }
    }
    const abandoned = isPlainObject(record['abandoned']) ? record['abandoned'] : {}
    for (const [pkg, raw] of Object.entries(abandoned)) {
        // `getReplacementPackage()` is `?string` (null = no suggestion); older
        // Composer wrote `true` for the same state.
        const replacement = typeof raw === 'string' ? raw : raw === true || raw === null ? 'no replacement' : undefined
        findings.push({
            package: pkg,
            kind: 'abandoned',
            severity: 'unknown',
            title: `包已废弃（abandoned）${replacement === undefined ? '' : `：${replacement}`}`,
        })
    }
    return sortFindings(findings)
}

// --- cargo audit ------------------------------------------------------------

/**
 * `cargo audit --json`:
 * `{ "vulnerabilities": { "found": bool, "count": n, "list": [ { "advisory":
 * { id, package, title, cvss?, aliases? }, "package": { name, version },
 * "versions": { "patched": [ … ] } } ] } }`.
 */
function isCargoAudit(record: Record<string, unknown>): boolean {
    const vulnerabilities = record['vulnerabilities']
    if (!isPlainObject(vulnerabilities)) return false
    return typeof vulnerabilities['found'] === 'boolean' || Array.isArray(vulnerabilities['list'])
}

/** `cvss` is a number (or numeric string) on current cargo-audit, a vector on old ones. */
function parseCargoAudit(record: Record<string, unknown>): AuditFinding[] {
    const findings: AuditFinding[] = []
    const vulnerabilities = isPlainObject(record['vulnerabilities']) ? record['vulnerabilities'] : {}
    const list = Array.isArray(vulnerabilities['list']) ? vulnerabilities['list'] : []
    for (const raw of list) {
        if (!isPlainObject(raw)) continue
        const advisory = isPlainObject(raw['advisory']) ? raw['advisory'] : {}
        const pkg = isPlainObject(raw['package']) ? raw['package'] : {}
        const aliases = Array.isArray(advisory['aliases']) ? advisory['aliases'].filter((entry): entry is string => typeof entry === 'string') : []
        const id =
            typeof advisory['id'] === 'string' && advisory['id'] !== ''
                ? advisory['id']
                : (aliases.find((entry) => /^CVE-/i.test(entry)) ?? aliases[0])
        const cvss = advisory['cvss']
        // A CVSS SCORE is a severity in disguise (normalizeSeverity's documented
        // mapping); a vector string (`CVSS:3.1/AV:N/…`) carries no level we can
        // read here, so it falls through to the advisory's own severity field
        // and finally to `unknown` — never silently to "low".
        const score =
            typeof cvss === 'number'
                ? cvss
                : typeof cvss === 'string' && cvss.trim() !== '' && Number.isFinite(Number(cvss))
                  ? Number(cvss)
                  : undefined
        const patched =
            isPlainObject(raw['versions']) && Array.isArray(raw['versions']['patched'])
                ? raw['versions']['patched'].filter((entry): entry is string => typeof entry === 'string')
                : []
        const name = typeof pkg['name'] === 'string' ? pkg['name'] : typeof advisory['package'] === 'string' ? advisory['package'] : undefined
        findings.push({
            ...(name === undefined ? {} : { package: name }),
            ...(id === undefined ? {} : { id }),
            severity: normalizeSeverity(score ?? advisory['severity']),
            ...(typeof advisory['title'] === 'string' && advisory['title'] !== '' ? { title: advisory['title'] } : {}),
            ...(typeof advisory['url'] === 'string' && advisory['url'] !== '' ? { url: advisory['url'] } : {}),
            ...(patched.length === 0 ? {} : { fixedIn: patched.join(', ') }),
        })
    }
    return sortFindings(findings)
}

// --- bundler-audit ----------------------------------------------------------

/**
 * `bundle audit check --format json`:
 * `{ "results": [ { "gem": { name, version }, "advisory": { cve?, ghsa?, title,
 * criticality?, patched_versions? } } ], "unpatched_gems"?: [ { name, version } ] }`.
 */
function isBundlerAudit(record: Record<string, unknown>): boolean {
    const results = record['results']
    if (!Array.isArray(results)) return false
    if (results.some((item) => isPlainObject(item) && isPlainObject(item['gem']) && isPlainObject(item['advisory']))) return true
    // A CLEAN bundler-audit report is `results: []` plus `unpatched_gems: []`. A
    // bare `{"results":[]}` from some other tool is NOT assumed clean.
    return Array.isArray(record['unpatched_gems'])
}

/** Gems with a patched version, then gems the auditor says are unpatched. */
function parseBundlerAudit(record: Record<string, unknown>): AuditFinding[] {
    const findings: AuditFinding[] = []
    const results = Array.isArray(record['results']) ? record['results'] : []
    for (const raw of results) {
        if (!isPlainObject(raw)) continue
        const gem = isPlainObject(raw['gem']) ? raw['gem'] : {}
        const advisory = isPlainObject(raw['advisory']) ? raw['advisory'] : {}
        const id =
            typeof advisory['cve'] === 'string' && advisory['cve'] !== ''
                ? advisory['cve']
                : typeof advisory['ghsa'] === 'string' && advisory['ghsa'] !== ''
                  ? advisory['ghsa']
                  : undefined
        const patched = Array.isArray(advisory['patched_versions'])
            ? advisory['patched_versions'].filter((entry): entry is string => typeof entry === 'string')
            : []
        findings.push({
            ...(typeof gem['name'] === 'string' ? { package: gem['name'] } : {}),
            ...(id === undefined ? {} : { id }),
            severity: normalizeSeverity(advisory['criticality']),
            ...(typeof advisory['title'] === 'string' && advisory['title'] !== '' ? { title: advisory['title'] } : {}),
            ...(patched.length === 0 ? {} : { fixedIn: patched.join(', ') }),
        })
    }
    const unpatched = Array.isArray(record['unpatched_gems']) ? record['unpatched_gems'] : []
    for (const raw of unpatched) {
        if (!isPlainObject(raw)) continue
        const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : undefined
        if (name === undefined) continue
        const version = typeof raw['version'] === 'string' && raw['version'] !== '' ? raw['version'] : undefined
        findings.push({
            package: name,
            kind: 'unpatched',
            severity: 'unknown',
            title: `${name}${version === undefined ? '' : `@${version}`} 没有可用的修复版本（unpatched）`,
        })
    }
    return sortFindings(findings)
}

// --- dotnet list package --vulnerable ---------------------------------------

/**
 * `dotnet list package --vulnerable --format json`:
 * `{ "projects": [ { "frameworks": [ { "topLevelPackages": [ { id,
 * resolvedVersion, vulnerabilities: [ { severity, advisoryurl } ] } ],
 * "transitivePackages": [ … ] } ] } ] }`.
 *
 * The SDK's JSON spells the field `advisoryurl` (lower case); `advisoryUrl` is
 * accepted too. An older SDK shape puts the package lists directly on the
 * project (no `frameworks`), which is also read — a project with neither is NOT
 * this shape, so an unrelated `{"projects": […]}` still fails closed.
 */
function isDotnetVulnerable(record: Record<string, unknown>): boolean {
    const projects = record['projects']
    if (!Array.isArray(projects)) return false
    return projects.some(
        (project) =>
            isPlainObject(project) &&
            (Array.isArray(project['frameworks']) || Array.isArray(project['topLevelPackages']) || Array.isArray(project['transitivePackages'])),
    )
}

/** One finding per (package, vulnerability) pair; packages without one are quiet. */
function parseDotnetVulnerable(record: Record<string, unknown>): AuditFinding[] {
    const findings: AuditFinding[] = []
    const projects = Array.isArray(record['projects']) ? record['projects'] : []
    for (const project of projects) {
        if (!isPlainObject(project)) continue
        const scopes: Record<string, unknown>[] = Array.isArray(project['frameworks']) ? project['frameworks'].filter(isPlainObject) : [project]
        for (const scope of scopes) {
            for (const section of ['topLevelPackages', 'transitivePackages']) {
                const packages = Array.isArray(scope[section]) ? scope[section] : []
                for (const raw of packages) {
                    if (!isPlainObject(raw)) continue
                    const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : undefined
                    if (id === undefined) continue
                    const version = typeof raw['resolvedVersion'] === 'string' && raw['resolvedVersion'] !== '' ? raw['resolvedVersion'] : undefined
                    const advisories = Array.isArray(raw['vulnerabilities']) ? raw['vulnerabilities'].filter(isPlainObject) : []
                    for (const advisory of advisories) {
                        const url =
                            typeof advisory['advisoryurl'] === 'string'
                                ? advisory['advisoryurl']
                                : typeof advisory['advisoryUrl'] === 'string'
                                  ? advisory['advisoryUrl']
                                  : undefined
                        const advisoryId = advisoryIdFromUrl(url)
                        findings.push({
                            package: id,
                            ...(advisoryId === undefined ? {} : { id: advisoryId }),
                            severity: normalizeSeverity(advisory['severity']),
                            title: `${id}${version === undefined ? '' : `@${version}`} 存在已知漏洞（${
                                section === 'transitivePackages' ? '传递依赖' : '直接依赖'
                            }）`,
                            ...(url === undefined || url === '' ? {} : { url }),
                        })
                    }
                }
            }
        }
    }
    return sortFindings(findings)
}

/** The advisory id embedded in a dotnet advisory URL (`…/advisories/GHSA-…`). */
function advisoryIdFromUrl(url: string | undefined): string | undefined {
    if (url === undefined || url === '') return undefined
    const withoutQuery = url.split(/[?#]/)[0] ?? ''
    const last = withoutQuery
        .split('/')
        .filter((segment) => segment !== '')
        .at(-1)
    return last !== undefined && /^(?:GHSA|CVE|RUSTSEC|GO)-[A-Za-z0-9-]{4,}$/i.test(last) ? last : undefined
}

/** govulncheck JSON/JSONL: `finding.trace[].vulnerability` + `finding.osv`. */
function parseGovulncheckJson(documents: readonly unknown[]): AuditFinding[] {
    const findings: AuditFinding[] = []
    for (const document of documents) {
        if (typeof document !== 'object' || document === null) continue
        const record = document as Record<string, unknown>
        const items = Array.isArray(record['findings']) ? record['findings'] : record['finding'] === undefined ? [] : [record['finding']]
        for (const item of items) {
            if (typeof item !== 'object' || item === null) continue
            const finding = item as Record<string, unknown>
            const trace = Array.isArray(finding['trace']) ? finding['trace'] : []
            const first = trace.find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            const vulnerability = first?.['vulnerability']
            const vuln = typeof vulnerability === 'object' && vulnerability !== null ? (vulnerability as Record<string, unknown>) : {}
            const osv = typeof finding['osv'] === 'object' && finding['osv'] !== null ? (finding['osv'] as Record<string, unknown>) : {}
            const module = first?.['module'] ?? osv['module']
            const moduleName = typeof module === 'string' ? module : typeof module === 'object' && module !== null ? (module as Record<string, unknown>)['path'] : undefined
            findings.push({
                ...(typeof moduleName === 'string' ? { package: moduleName } : {}),
                ...(typeof vuln['id'] === 'string' ? { id: vuln['id'] } : typeof osv['id'] === 'string' ? { id: osv['id'] } : {}),
                // govulncheck reports no severity either (Go's vuln DB has none).
                severity: normalizeSeverity(vuln['severity'] ?? osv['severity']),
                ...(typeof osv['summary'] === 'string' ? { title: osv['summary'] } : {}),
                ...(typeof finding['fixed_version'] === 'string' ? { fixedIn: finding['fixed_version'] } : {}),
            })
        }
    }
    return sortFindings(findings)
}

/** govulncheck text: `Vulnerability #1:` blocks with id/module/fixed-in lines. */
function parseGovulncheckText(text: string): AuditFinding[] {
    const findings: AuditFinding[] = []
    const lines = text.split('\n')
    let current: AuditFinding | undefined
    for (const line of lines) {
        const header = /^\s*Vulnerability #\d+:\s*(\S+)/.exec(line)
        if (header !== null) {
            if (current !== undefined) findings.push(current)
            current = { id: header[1] ?? '', severity: 'unknown' }
            continue
        }
        if (current === undefined) continue
        const module = /^\s*Module:\s*(\S+)/.exec(line)
        if (module !== null) current.package = module[1]
        const found = /^\s*Found in:\s*(\S+)/.exec(line)
        if (found !== null && current.package === undefined) current.package = (found[1] ?? '').split('@')[0]
        const fixed = /^\s*Fixed in:\s*(\S+)/.exec(line)
        if (fixed !== null) current.fixedIn = fixed[1]
        const info = /^\s*More info:\s*(\S+)/.exec(line)
        if (info !== null) current.url = info[1]
        const summary = /^\s{4}(\S.*)$/.exec(line)
        if (summary !== null && current.title === undefined && !/^(Module|Found in|Fixed in|More info):/.test((summary[1] ?? '').trim())) {
            current.title = (summary[1] ?? '').trim()
        }
    }
    if (current !== undefined) findings.push(current)
    return sortFindings(findings)
}

/** A short "nothing found" report — accepted only when nothing contradicts it. */
function looksClean(text: string): boolean {
    if (text.length > 4_000) return false
    const clean = /no (?:known )?vulnerabilit(?:y|ies)|0 vulnerabilities|found 0 vulnerabilities|no issues found/i.test(text)
    if (!clean) return false
    // A per-package "no vulnerabilities found" line inside a report that also
    // lists vulnerabilities must not turn the whole report clean.
    return !/(Vulnerability #|CVE-\d{4}-\d{4,}|GHSA-[a-z0-9-]{4,}|GO-\d{4}-\d{4,}|"severity"\s*:)/i.test(text)
}

/** Bounded, deterministic generic JSON walker for severity-ish fields. */
function genericWalk(document: unknown): AuditParseResult {
    const findings: AuditFinding[] = []
    let severityFields = 0
    let nodes = 0
    let dropped = 0
    const stack: { value: unknown; context: { package?: string; url?: string; id?: string; title?: string }; inFindingArray: boolean }[] = [
        { value: document, context: {}, inFindingArray: false },
    ]
    const seen = new Set<string>()
    while (stack.length > 0 && nodes < MAX_JSON_NODES) {
        const item = stack.pop()
        if (item === undefined) break
        nodes += 1
        const { value, context, inFindingArray } = item
        if (Array.isArray(value)) {
            for (const entry of value) stack.push({ value: entry, context, inFindingArray: true })
            continue
        }
        if (typeof value !== 'object' || value === null) continue
        const record = value as Record<string, unknown>
        const next = { ...context }
        for (const key of ['name', 'package', 'pkg', 'module', 'dependency', 'dependency_name', 'id', 'advisory']) {
            const candidate = record[key]
            if (typeof candidate === 'string' && candidate.trim() !== '' && next.package === undefined) next.package = candidate.trim()
        }
        for (const key of ['url', 'more_info', 'link', 'href', 'advisory_url']) {
            const candidate = record[key]
            if (typeof candidate === 'string' && candidate.trim() !== '' && next.url === undefined) next.url = candidate.trim()
        }
        for (const key of ['title', 'summary', 'description']) {
            const candidate = record[key]
            if (typeof candidate === 'string' && candidate.trim() !== '' && next.title === undefined) next.title = firstLine(candidate)
        }
        const severityKey = Object.keys(record).find((key) => /^(severity|severity_level|severitylevel|level|risk|risk_level|impact|cvss)$/i.test(key))
        const severity = severityKey === undefined ? undefined : normalizeSeverity(record[severityKey])
        if (severity !== undefined && severity !== 'unknown') {
            severityFields += 1
            push(severity)
        } else if (severityKey !== undefined) {
            severityFields += 1
            push('unknown')
        } else if (inFindingArray && (next.id !== undefined || next.package !== undefined) && looksFindingish(record)) {
            // An item of a finding-ish array without any severity field still is a
            // finding; it is labelled `unknown` rather than dropped.
            push('unknown')
        }
        for (const [key, entry] of Object.entries(record)) {
            if (typeof entry !== 'object' || entry === null) continue
            stack.push({ value: entry, context: next, inFindingArray: /vulns|vulnerabilit|findings|issues|alerts|advisories|results/i.test(key) })
        }

        function push(value: string): void {
            const finding: AuditFinding = {
                severity: value,
                ...(next.package === undefined ? {} : { package: next.package }),
                ...(next.id === undefined ? {} : { id: next.id }),
                ...(next.title === undefined ? {} : { title: next.title }),
                ...(next.url === undefined ? {} : { url: next.url }),
            }
            const key = `${finding.package ?? ''}|${finding.id ?? ''}|${finding.severity}|${finding.title ?? ''}`
            if (seen.has(key)) return
            seen.add(key)
            if (findings.length < MAX_AUDIT_FINDINGS) findings.push(finding)
            else dropped += 1
        }
    }
    if (severityFields === 0 && findings.length === 0) {
        return {
            shape: 'unknown',
            findings: [],
            problem: 'JSON 解析成功但找不到任何 severity/漏洞条目：无法判定（未识别的报告不等于干净的仓库）',
        }
    }
    return { shape: 'generic-json', findings: sortFindings(findings), ...(dropped === 0 ? {} : { dropped }) }
}

/** Whether an object looks like a vulnerability item (has an id-ish field). */
function looksFindingish(record: Record<string, unknown>): boolean {
    return Object.keys(record).some((key) => /^(id|title|summary|advisory|vuln|vulnerability|cve|ghsa)$/i.test(key))
}

function firstLine(text: string): string {
    const line = text.split('\n')[0] ?? text
    return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

/** Fixed severity rank for deterministic ordering. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3, unknown: 4, info: 5 }

/** Sorted by severity, then package, then id. */
function sortFindings(findings: readonly AuditFinding[]): AuditFinding[] {
    return [...findings].sort(
        (left, right) =>
            (SEVERITY_RANK[left.severity] ?? 4) - (SEVERITY_RANK[right.severity] ?? 4) ||
            (left.package ?? '').localeCompare(right.package ?? '') ||
            (left.id ?? '').localeCompare(right.id ?? ''),
    )
}

/** How the configured severity policy classifies a set of findings. */
export interface AuditClassification {
    /** Severities in `auditSeverities.block` → the gate BLOCKs. */
    blocking: AuditFinding[]
    /** Severities in `auditSeverities.warn` → the gate WARNs. */
    warning: AuditFinding[]
    /**
     * Severities in NEITHER list (including `unknown`, which is what
     * govulncheck and pip-audit reports carry). Reported and never silently
     * dropped; the report tells the host how to make them block.
     */
    unclassified: AuditFinding[]
}

/** Classify findings against the configured block/warn severity lists. */
export function classifyFindings(findings: readonly AuditFinding[], severities: { block: readonly string[]; warn: readonly string[] }): AuditClassification {
    const block = new Set(severities.block.map((entry) => entry.toLowerCase()))
    const warn = new Set(severities.warn.map((entry) => entry.toLowerCase()))
    const blocking: AuditFinding[] = []
    const warning: AuditFinding[] = []
    const unclassified: AuditFinding[] = []
    for (const finding of findings) {
        const severity = normalizeSeverity(finding.severity)
        if (block.has(severity)) blocking.push(finding)
        else if (warn.has(severity)) warning.push(finding)
        else unclassified.push(finding)
    }
    return { blocking, warning, unclassified }
}

/**
 * Whether a configured manifest name is inside the supported watch list.
 * (Kept here so the tool layer and `supply_chain_status` agree on one answer.)
 */
export function isSupportedManifest(path: string): boolean {
    return formatOf(path) !== undefined || isLockfile(path) || isWatchOnly(path)
}

/** Globs are supported in `manifests` entries for path-qualified manifests. */
export function manifestMatches(pattern: string, path: string): boolean {
    if (pattern === path) return true
    if (!pattern.includes('*') && !pattern.includes('?')) return false
    try {
        return globToRegExp(pattern).test(path)
    } catch {
        return false
    }
}

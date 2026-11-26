/**
 * Ecosystem detection for `suite_init`: ONE rule table, TWO answers.
 *
 * A repository can carry several ecosystems at once, and the scaffold has two
 * different questions to ask about it:
 *
 *  - **Which ecosystem's defaults should the single-ecosystem documents use?**
 *    (`quality-gate` commands, `standards` thresholds, `coverage-gate` source).
 *    Answered by the FIRST hit in {@link DETECTION_ORDER} — the order is the
 *    specification, not an accident: `tsconfig.json` next to `go.mod` must
 *    resolve to TS no matter what a directory listing returns, and
 *    `build.gradle.kts` is Kotlin's while `build.gradle` (Groovy) is Java's.
 *  - **Which ecosystems are actually present?** The supply-chain gate watches
 *    MANIFESTS, so a Go repository that also carries `requirements.txt` needs
 *    both `go.mod`/`go.sum` and `requirements.txt`/`pyproject.toml`. Answered by
 *    EVERY hit, in that same order, deduplicated.
 *
 * Both answers come from the same table and the same matcher
 * ({@link matchesRule}): a second copy of "what counts as a hit" would drift
 * from the first, and the report would then name evidence the generated content
 * did not use.
 *
 * The module lives apart from `scaffold-catalog.ts` (which documents the KEYS)
 * and `scaffold-languages.ts` (which holds the per-ecosystem defaults) so each
 * can be read and reviewed on its own.
 *
 * @module dsh-suite-doctor/scaffold-detect
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SuiteLanguage } from './scaffold-languages.js'

export type { SuiteLanguage }

/** One detection rule: a language plus the manifests that name it. */
export interface DetectionRule {
    language: SuiteLanguage
    /** Root files matched by exact name. */
    manifests?: readonly string[]
    /** Root files matched by extension (`*.sln`, `*.gemspec`). */
    suffixes?: readonly string[]
}

/** What one rule matched: the root file, and the extension when it matched by suffix. */
export interface RuleMatch {
    /** The root entry that hit (a file name, never a directory). */
    manifest: string
    /** The extension that matched (`*.csproj`), only when the rule matched by suffix. */
    suffix?: string
}

/** One detected ecosystem plus the root file that evidenced it. */
export interface LanguageMatch extends RuleMatch {
    language: SuiteLanguage
}

/** What detection observed: the primary ecosystem, every hit, and the evidence. */
export interface LanguageDetection {
    /**
     * The ecosystem the single-ecosystem documents are generated for: the first
     * hit in {@link DETECTION_ORDER}, or `ts` when nothing matched. Unchanged
     * from before multi-ecosystem detection existed.
     */
    language: SuiteLanguage
    /**
     * Every ecosystem hit, in {@link DETECTION_ORDER}, deduplicated. EMPTY when
     * nothing matched — the default is a default, not a detection, and saying
     * `['ts']` here would let a report claim it found evidence it did not.
     */
    languages: SuiteLanguage[]
    /** The evidence for every hit (one per matching rule, in that same order). */
    matches: LanguageMatch[]
    /** The manifest that decided {@link language}; absent when the default applied. */
    manifest?: string
    /** One line a person can check against the directory. */
    reason: string
}

/**
 * The ONE detection order: highest priority first, and the PRIMARY answer is
 * decided by the first hit.
 *
 * `build.gradle` (Groovy) is Java's while `build.gradle.kts` is Kotlin's, which
 * is why Java is `pom.xml`/`build.gradle` and Kotlin follows it — a Kotlin file
 * alone still resolves to Kotlin, and a repository with both resolves to Java,
 * in the documented order.
 */
const DETECTION_ORDER: readonly DetectionRule[] = [
    { language: 'ts', manifests: ['tsconfig.json', 'tsconfig.base.json'] },
    { language: 'go', manifests: ['go.mod'] },
    { language: 'rust', manifests: ['Cargo.toml'] },
    { language: 'java', manifests: ['pom.xml', 'build.gradle'] },
    { language: 'kotlin', manifests: ['build.gradle.kts'] },
    { language: 'csharp', suffixes: ['.sln', '.csproj'] },
    { language: 'php', manifests: ['composer.json'] },
    { language: 'ruby', manifests: ['Gemfile'], suffixes: ['.gemspec'] },
    { language: 'swift', manifests: ['Package.swift'] },
    { language: 'py', manifests: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
    { language: 'js', manifests: ['package.json'] },
]

/** The default applied when nothing matched; a DEFAULT, never a detection. */
const DEFAULT_LANGUAGE: SuiteLanguage = 'ts'

/** The sentence the plan prints when the default applied (verbatim, tests pin it). */
const DEFAULT_REASON = `检测依据：没有找到任何已知 manifest，按约定默认 ${DEFAULT_LANGUAGE}`

/** Whether a root entry of that exact name is a file. */
function hasFile(cwd: string, name: string): boolean {
    try {
        return fs.statSync(path.join(cwd, name)).isFile()
    } catch {
        return false
    }
}

/** First root file whose name ends with `suffix` (sorted, so two runs agree). */
function rootFileWithSuffix(cwd: string, suffix: string): string | undefined {
    try {
        return fs
            .readdirSync(cwd, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
            .map((entry) => entry.name)
            .sort()[0]
    } catch {
        return undefined
    }
}

/**
 * Whether `rule` matches this directory, naming the root file that hit.
 *
 * Shared by {@link detectLanguageInfo}'s two answers on purpose: "the primary
 * ecosystem" and "every ecosystem present" must never disagree about what
 * counts as evidence.
 * @param cwd - the workspace root.
 * @param rule - one entry of {@link DETECTION_ORDER}.
 * @returns the matched root file (and the suffix pattern), or `undefined`.
 */
export function matchesRule(cwd: string, rule: DetectionRule): RuleMatch | undefined {
    for (const name of rule.manifests ?? []) {
        if (hasFile(cwd, name)) return { manifest: name }
    }
    for (const suffix of rule.suffixes ?? []) {
        const name = rootFileWithSuffix(cwd, suffix)
        if (name !== undefined) return { manifest: name, suffix }
    }
    return undefined
}

/** `检测依据：…` — the one sentence the plan prints, built from a match. */
function reasonOf(match: LanguageMatch): string {
    return `检测依据：命中 ${match.manifest}${match.suffix === undefined ? '' : `（*${match.suffix}）`}`
}

/**
 * Detect every ecosystem present, naming the evidence.
 *
 * `suite_init` prints `reason`, because "detected rust" without "because of
 * Cargo.toml" is a claim a person cannot check — and a repository that carries
 * several ecosystems is exactly where a silent pick goes wrong.
 * @param cwd - the workspace root.
 * @returns the primary ecosystem, every hit, and the evidence for each.
 */
export function detectLanguageInfo(cwd: string): LanguageDetection {
    const matches: LanguageMatch[] = []
    for (const rule of DETECTION_ORDER) {
        const hit = matchesRule(cwd, rule)
        if (hit !== undefined) matches.push({ language: rule.language, ...hit })
    }
    const first = matches[0]
    if (first === undefined) return { language: DEFAULT_LANGUAGE, languages: [], matches: [], reason: DEFAULT_REASON }
    const languages: SuiteLanguage[] = []
    for (const match of matches) if (!languages.includes(match.language)) languages.push(match.language)
    return { language: first.language, languages, matches, manifest: first.manifest, reason: reasonOf(first) }
}

/** Detect the repository's primary ecosystem from its manifests. */
export function detectLanguage(cwd: string): SuiteLanguage {
    return detectLanguageInfo(cwd).language
}

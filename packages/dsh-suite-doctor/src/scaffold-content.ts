/**
 * Default document bodies for `suite_init`, per ecosystem.
 *
 * Kept apart from the catalog (which documents the KEYS) so the two can be read
 * independently: the catalog says what each plugin accepts, this file says what a
 * fresh repository is scaffolded with. Every default here is a starting point a
 * person is expected to review — in particular the commands, which name the
 * ecosystem's conventional runner rather than inventing a project-specific one.
 *
 * The per-language DATA (commands, manifests, thresholds, the reason three
 * ecosystems have no coverage command) lives in `scaffold-languages.ts`; this
 * module only renders it into the JSON documents.
 *
 * ONE document is not single-ecosystem: `supply-chain-gate.json` watches
 * manifests and audits dependencies, so it is generated for EVERY detected
 * ecosystem — the manifests are the union and the audit commands come from
 * `scaffold-audit.ts`'s table. The other nine documents stay keyed to the
 * PRIMARY ecosystem (the first detection hit): a repository has one way it runs
 * its tests and one structural threshold set, and inventing a merge of them
 * would describe a repository nobody has.
 *
 * @module dsh-suite-doctor/scaffold-content
 */

import { auditCommandsFor, skippedAuditors, type SkippedAuditor } from './scaffold-audit.js'
import { defaultsOf, manifestsFor, STANDARDS_LANGUAGES, THRESHOLDS, type SuiteLanguage } from './scaffold-languages.js'

export type { SuiteLanguage }

/** Every placeholder a coverage command may need, resolved by the coverage gate. */
const COVERAGE_THRESHOLD = { total: 70 }

/** The repository-owned structural standard (`standards.json`). */
export function standardsContent(language: SuiteLanguage): Record<string, unknown> {
    const languages: Record<string, unknown> = {}
    for (const code of STANDARDS_LANGUAGES[language]) languages[code] = { ...THRESHOLDS[language] }
    return {
        languages,
        forbidCycles: true,
        exempt: ['**/*.test.ts', '**/*.test.js', '**/*_test.go', '**/test_*.py', '**/*_test.rb', '**/*_spec.rb', '**/dist/**', '**/build/**', '**/vendor/**', '**/node_modules/**'],
    }
}

/** The gate command list: a required test command plus a non-blocking lint. */
export function qualityGateContent(language: SuiteLanguage): Record<string, unknown> {
    const defaults = defaultsOf(language)
    return {
        commands: [
            { id: 'test', name: '测试', command: defaults.test, required: true, phase: 'gate' },
            { id: 'lint', name: 'lint', command: defaults.lint, required: false, phase: 'lint' },
        ],
    }
}

/**
 * Coverage source + threshold, so the gate is not refused for "no threshold".
 *
 * For Java/Kotlin/PHP `coverageCommand` and `reportFile` are EMPTY strings: the
 * coverage gate reads an empty value as "not configured" and refuses to run,
 * which is the honest outcome while the report format (jacoco/clover) is not one
 * this suite parses. `thresholds` is still written — the intended 70% belongs in
 * the file — and the reason is printed by `suite_init` and documented in
 * `docs/ARCHITECTURE.md`.
 */
export function coverageGateContent(language: SuiteLanguage): Record<string, unknown> {
    const defaults = defaultsOf(language)
    return {
        coverageCommand: defaults.coverageCommand,
        reportFile: defaults.reportFile,
        ...(defaults.reportFormat === undefined ? {} : { reportFormat: defaults.reportFormat }),
        thresholds: { ...COVERAGE_THRESHOLD },
    }
}

/** The minimal-regression template; `{files}` is replaced with the selection. */
export function impactGateContent(language: SuiteLanguage): Record<string, unknown> {
    return { testCommandTemplate: defaultsOf(language).impactTemplate, defaultBase: 'HEAD' }
}

/**
 * The ecosystems a scaffold run generates for.
 *
 * Every detected one, or the PRIMARY alone when detection found nothing: on an
 * empty repository the documents still need a language, and the documented `ts`
 * default fills that role. Returning a copy (not the caller's array) keeps the
 * plan's field from aliasing detection's.
 * @param language - the primary ecosystem (the first detection hit).
 * @param languages - every detected ecosystem (empty when the default applied).
 * @returns the list the generated documents are keyed to.
 */
export function generatedLanguages(language: SuiteLanguage, languages: readonly SuiteLanguage[]): SuiteLanguage[] {
    return languages.length === 0 ? [language] : [...languages]
}

/** The dependency section the supply-chain gate is stocked with for one scaffold run. */
export interface SupplyChainDeps {
    /** Union of every generated ecosystem's manifests, deduplicated, detection order. */
    manifests: string[]
    /** Standard audit commands of those ecosystems, deduplicated, detection order. */
    auditCommands: string[]
    /** Ecosystems left without a command, with the reason the report prints. */
    skipped: SkippedAuditor[]
}

/**
 * Build the supply-chain dependency section for the generated ecosystems.
 *
 * This is the ONE place the section is computed: the file written by
 * `suite_init` and the `语言与供应链` block of its report are both projections of
 * this function's result, so the report cannot describe a watch list the file
 * does not have.
 * @param language - the primary ecosystem (used when nothing was detected).
 * @param languages - every detected ecosystem.
 * @returns the manifests union, the audit commands and the skipped ecosystems.
 */
export function supplyChainDeps(language: SuiteLanguage, languages: readonly SuiteLanguage[]): SupplyChainDeps {
    const generated = generatedLanguages(language, languages)
    return { manifests: manifestsFor(generated), auditCommands: auditCommandsFor(generated), skipped: skippedAuditors(generated) }
}

/**
 * Manifests + audit commands of EVERY generated ecosystem.
 *
 * Multi-ecosystem is the point: a Go repository that also carries
 * `requirements.txt` gets `go.mod`/`go.sum` AND `requirements.txt`/
 * `pyproject.toml`, plus `govulncheck ./...` and `pip-audit -f json`.
 * Ecosystems with no standard auditor (java/kotlin/swift) contribute no command —
 * the caller's report names them via {@link SupplyChainDeps.skipped}; nothing is
 * invented.
 * @param language - the primary ecosystem.
 * @param languages - every detected ecosystem (default: just the primary).
 * @returns the `supply-chain-gate.json` document body.
 */
export function supplyChainGateContent(language: SuiteLanguage, languages: readonly SuiteLanguage[] = [language]): Record<string, unknown> {
    const deps = supplyChainDeps(language, languages)
    return {
        deps: { manifests: deps.manifests, auditCommands: deps.auditCommands },
        secretScan: { scanWholeTree: false },
    }
}

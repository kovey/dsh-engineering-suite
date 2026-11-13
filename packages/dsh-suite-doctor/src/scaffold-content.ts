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
 * @module dsh-suite-doctor/scaffold-content
 */

import { defaultsOf, STANDARDS_LANGUAGES, THRESHOLDS, type SuiteLanguage } from './scaffold-languages.js'

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

/** Manifests for the declared ecosystem; audit commands stay empty (no invented auditor). */
export function supplyChainGateContent(language: SuiteLanguage): Record<string, unknown> {
    return {
        deps: { manifests: [...defaultsOf(language).manifests], auditCommands: [] },
        secretScan: { scanWholeTree: false },
    }
}

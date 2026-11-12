/**
 * Default document bodies for `suite_init`, per ecosystem.
 *
 * Kept apart from the catalog (which documents the KEYS) so the two can be read
 * independently: the catalog says what each plugin accepts, this file says what a
 * fresh repository is scaffolded with. Every default here is a starting point a
 * person is expected to review — in particular the commands, which name the
 * ecosystem's conventional runner rather than inventing a project-specific one.
 *
 * @module dsh-suite-doctor/scaffold-content
 */

/** The ecosystems `suite_init` knows default commands for. */
export type SuiteLanguage = 'ts' | 'js' | 'go' | 'py'

interface LanguageDefaults {
    test: string
    lint: string
    coverageCommand: string
    reportFile: string
    reportFormat?: string
    impactTemplate: string
    manifests: readonly string[]
}

const LANGUAGE_DEFAULTS: Record<SuiteLanguage, LanguageDefaults> = {
    ts: {
        test: 'node --test',
        lint: 'npx tsc --noEmit',
        coverageCommand: 'npx c8 --reporter=lcov npm test',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'node --test {files}',
        manifests: ['package.json', 'pnpm-lock.yaml'],
    },
    js: {
        test: 'npm test',
        lint: 'npm run lint',
        coverageCommand: 'npx c8 --reporter=lcov npm test',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'node --test {files}',
        manifests: ['package.json', 'pnpm-lock.yaml'],
    },
    go: {
        test: 'go test ./...',
        lint: 'go vet ./...',
        coverageCommand: 'go test ./... -coverprofile=coverage/cover.out',
        reportFile: 'coverage/cover.out',
        reportFormat: 'go-cover',
        impactTemplate: 'go test {files}',
        manifests: ['go.mod', 'go.sum'],
    },
    py: {
        test: 'python -m pytest -q',
        lint: 'python -m ruff check .',
        coverageCommand: 'python -m pytest -q --cov --cov-report=lcov:coverage/lcov.info',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'python -m pytest {files}',
        manifests: ['requirements.txt', 'pyproject.toml'],
    },
}

/** Which language keys the standards file declares, per detected ecosystem. */
const STANDARDS_LANGUAGES: Record<SuiteLanguage, readonly string[]> = {
    ts: ['ts', 'js'],
    js: ['js'],
    go: ['go'],
    py: ['py'],
}

const THRESHOLDS: Record<SuiteLanguage, Record<string, number>> = {
    ts: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    js: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    go: { maxFileLines: 400, maxFunctionLines: 80, maxDepth: 4, maxIfBlockLines: 25, maxParams: 6, maxExports: 20 },
    py: { maxFileLines: 400, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 6, maxExports: 20 },
}

function defaultsOf(language: SuiteLanguage): LanguageDefaults {
    return LANGUAGE_DEFAULTS[language]
}

/** The repository-owned structural standard (`standards.json`). */
export function standardsContent(language: SuiteLanguage): Record<string, unknown> {
    const languages: Record<string, unknown> = {}
    for (const code of STANDARDS_LANGUAGES[language]) languages[code] = { ...THRESHOLDS[language] }
    return {
        languages,
        forbidCycles: true,
        exempt: ['**/*.test.ts', '**/*.test.js', '**/*_test.go', '**/test_*.py', '**/dist/**', '**/build/**', '**/vendor/**', '**/node_modules/**'],
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

/** Coverage source + threshold, so the gate is not refused for "no threshold". */
export function coverageGateContent(language: SuiteLanguage): Record<string, unknown> {
    const defaults = defaultsOf(language)
    return {
        coverageCommand: defaults.coverageCommand,
        reportFile: defaults.reportFile,
        ...(defaults.reportFormat === undefined ? {} : { reportFormat: defaults.reportFormat }),
        thresholds: { total: 70 },
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

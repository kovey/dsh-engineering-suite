/**
 * What `suite_init` writes for each ecosystem: commands, manifests, standards
 * thresholds — and, for the three ecosystems whose coverage format is NOT
 * supported, the reason the coverage command is left empty.
 *
 * The data lives apart from the document renderers (`scaffold-content.ts`) and
 * from the catalog (which lists the KEYS) so the three can be read and reviewed
 * independently: this file answers "what does a fresh repository of language X
 * get", the catalog answers "which keys do the plugins read", and the renderer
 * turns the first into JSON.
 *
 * Two rules every entry obeys:
 *
 *  1. **No command that the parser would misread.** A coverage command is given
 *     ONLY when its report format is one the coverage gate actually parses
 *     (lcov, cobertura, go-cover, istanbul-json). Java/Kotlin (jacoco) and PHP
 *     (clover) are left empty WITH an explanation — a path to a report nobody can
 *     read is worse than no path, because it makes the gate look configured.
 *  2. **No invented project-specific command.** Every default names the
 *     ecosystem's conventional runner (`cargo test`, `mvn -q test`, `swift test`,
 *     …) — a starting point a person reviews, not a guess about this repository.
 *
 * @module dsh-suite-doctor/scaffold-languages
 */

/** The ecosystems `suite_init` knows default commands for. */
export type SuiteLanguage = 'ts' | 'js' | 'go' | 'py' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'php' | 'ruby' | 'swift'

/** The default commands and manifests of one ecosystem. */
export interface LanguageDefaults {
    /** Required test command (the quality gate's `test`). */
    test: string
    /** Non-blocking lint command. */
    lint: string
    /**
     * Coverage command, or `''` when the ecosystem's report format is not
     * supported. Empty means "not configured" — the coverage gate then refuses
     * instead of reading a report it cannot parse.
     */
    coverageCommand: string
    /** Where the coverage command writes its report (`''` when unsupported). */
    reportFile: string
    /** Report format, only when the coverage gate must be told (`go-cover`, `cobertura`). */
    reportFormat?: string
    /** Minimal-regression template; `{files}` is replaced with the selection. */
    impactTemplate: string
    /** Manifests the supply-chain gate watches. */
    manifests: readonly string[]
    /** Why coverage is left empty (only for the unsupported ecosystems). */
    coverageNote?: string
}

/** The one sentence each unsupported ecosystem gets, naming its real format and the way out. */
const UNSUPPORTED_COVERAGE = (ecosystem: string, format: string): string =>
    `${ecosystem} 的覆盖率报告（${format}）不在受支持格式列表（lcov / cobertura / go-cover / istanbul-json）里：` +
    '请先接入能产出 lcov 或 cobertura 的工具，再把 coverageCommand 与 reportFile 填上；' +
    '在此之前留空——指向一份解析器读不懂的报告，只会让门禁看起来"已配置"。'

/** Defaults per ecosystem, in the order the language type declares them. */
export const LANGUAGE_DEFAULTS: Record<SuiteLanguage, LanguageDefaults> = {
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
    rust: {
        test: 'cargo test',
        lint: 'cargo clippy -- -D warnings',
        coverageCommand: 'cargo llvm-cov --lcov --output-path coverage/lcov.info',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'cargo test {files}',
        manifests: ['Cargo.toml', 'Cargo.lock'],
    },
    java: {
        test: 'mvn -q test',
        lint: 'mvn -q -DskipTests verify',
        coverageCommand: '',
        reportFile: '',
        impactTemplate: 'mvn -q -Dtest={files} test',
        manifests: ['pom.xml'],
        coverageNote: UNSUPPORTED_COVERAGE('Java（jacoco）', 'jacoco 的 XML/CSV'),
    },
    kotlin: {
        test: 'gradle test',
        lint: 'gradle detekt',
        coverageCommand: '',
        reportFile: '',
        impactTemplate: 'gradle test --tests {files}',
        manifests: ['build.gradle.kts', 'settings.gradle.kts'],
        coverageNote: UNSUPPORTED_COVERAGE('Kotlin（jacoco/kover）', 'jacoco/kover'),
    },
    csharp: {
        test: 'dotnet test',
        lint: 'dotnet format --verify-no-changes',
        coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
        reportFile: 'coverage/coverage.cobertura.xml',
        reportFormat: 'cobertura',
        impactTemplate: 'dotnet test --filter {files}',
        manifests: ['*.sln', '*.csproj'],
    },
    php: {
        test: 'vendor/bin/phpunit',
        lint: 'vendor/bin/phpcs',
        coverageCommand: '',
        reportFile: '',
        impactTemplate: 'vendor/bin/phpunit {files}',
        manifests: ['composer.json'],
        coverageNote: UNSUPPORTED_COVERAGE('PHP（PHPUnit clover）', 'clover'),
    },
    ruby: {
        test: 'bundle exec rspec',
        lint: 'bundle exec rubocop',
        // simplecov-lcov must be enabled in spec_helper: the command itself is
        // still "run the tests".
        coverageCommand: 'bundle exec rspec',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'bundle exec rspec {files}',
        manifests: ['Gemfile', 'Gemfile.lock'],
    },
    swift: {
        test: 'swift test',
        lint: 'swiftlint',
        // `--enable-code-coverage` writes a profdata bundle; the lcov file comes
        // from `llvm-cov export` (see docs/ARCHITECTURE.md).
        coverageCommand: 'swift test --enable-code-coverage',
        reportFile: 'coverage/lcov.info',
        impactTemplate: 'swift test --filter {files}',
        manifests: ['Package.swift'],
    },
}

/**
 * Which `standards.json` language keys a detected ecosystem declares.
 *
 * The codes MUST be the ones `dsh-eng-core` reports in `FileMetrics.language`
 * (`python`, not `py`; `csharp`, not `c#`): a key the measurement never uses
 * would write thresholds that gate nothing.
 */
export const STANDARDS_LANGUAGES: Record<SuiteLanguage, readonly string[]> = {
    ts: ['ts', 'js'],
    js: ['js'],
    go: ['go'],
    py: ['python'],
    rust: ['rust'],
    java: ['java'],
    kotlin: ['kotlin'],
    csharp: ['csharp'],
    php: ['php'],
    ruby: ['ruby'],
    swift: ['swift'],
}

/** Structural thresholds per ecosystem: braces-shaped ones use the TS values, ruby/python the py ones. */
export const THRESHOLDS: Record<SuiteLanguage, Record<string, number>> = {
    ts: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    js: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    go: { maxFileLines: 400, maxFunctionLines: 80, maxDepth: 4, maxIfBlockLines: 25, maxParams: 6, maxExports: 20 },
    py: { maxFileLines: 400, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 6, maxExports: 20 },
    rust: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    java: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    kotlin: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    csharp: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    php: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
    ruby: { maxFileLines: 400, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 6, maxExports: 20 },
    swift: { maxFileLines: 300, maxFunctionLines: 60, maxDepth: 4, maxIfBlockLines: 20, maxParams: 5, maxExports: 15 },
}

/** The defaults of one ecosystem. */
export function defaultsOf(language: SuiteLanguage): LanguageDefaults {
    return LANGUAGE_DEFAULTS[language]
}

/** Why an ecosystem's coverage command is empty, or `undefined` when it is not. */
export function coverageNoteOf(language: SuiteLanguage): string | undefined {
    return LANGUAGE_DEFAULTS[language].coverageNote
}

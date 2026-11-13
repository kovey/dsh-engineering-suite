/**
 * `suite_init` across the eleven ecosystems the suite supports.
 *
 * Two promises are pinned here, and both are about what a fresh repository gets:
 *
 *  1. **Detection is the documented order, with the evidence named.** A
 *     repository can carry several ecosystems; a silent pick is a defect nobody
 *     can see. The plan therefore prints the manifest that decided it, and the
 *     priority table is exercised with the combinations that actually collide
 *     (`tsconfig.json` + `go.mod`, `Cargo.toml` + `package.json`, …).
 *  2. **No coverage command whose report the parser cannot read.** Java/Kotlin
 *     (jacoco) and PHP (clover) get an EMPTY command and an explanation, because
 *     a path to a report the coverage gate cannot parse would make the gate look
 *     configured while it gates nothing.
 *
 * The expected commands are the specification's table, written out literally:
 * a test that read them back from the implementation would prove nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout } from 'dsh-eng-core'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { planSuiteInit, renderInitPlan } from '../dist/scaffold.js'

/** A throwaway repository containing `files`. */
function repo(files: Record<string, string>): string {
    const cwd = tempWorkspace('suite-init-languages-')
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
        fs.writeFileSync(path.join(cwd, name), content)
    }
    return cwd
}

function readJson(cwd: string, name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(resolveLayout(cwd).rootDir, name), 'utf8')) as Record<string, unknown>
}

/** The defaults one ecosystem must get (the specification's command table). */
interface Expected {
    file: string
    language: string
    test: string
    lint: string
    impact: string
    coverage: string
    reportFile: string
    reportFormat?: string
    /** Language keys the generated `standards.json` must declare. */
    standards: string[]
    /** Why coverage is empty (only for the three unsupported ecosystems). */
    unsupported?: RegExp
}

const ECOSYSTEMS: readonly Expected[] = [
    {
        file: 'tsconfig.json',
        language: 'ts',
        test: 'node --test',
        lint: 'npx tsc --noEmit',
        impact: 'node --test {files}',
        coverage: 'npx c8 --reporter=lcov npm test',
        reportFile: 'coverage/lcov.info',
        standards: ['ts', 'js'],
    },
    {
        file: 'package.json',
        language: 'js',
        test: 'npm test',
        lint: 'npm run lint',
        impact: 'node --test {files}',
        coverage: 'npx c8 --reporter=lcov npm test',
        reportFile: 'coverage/lcov.info',
        standards: ['js'],
    },
    {
        file: 'go.mod',
        language: 'go',
        test: 'go test ./...',
        lint: 'go vet ./...',
        impact: 'go test {files}',
        coverage: 'go test ./... -coverprofile=coverage/cover.out',
        reportFile: 'coverage/cover.out',
        reportFormat: 'go-cover',
        standards: ['go'],
    },
    {
        file: 'pyproject.toml',
        language: 'py',
        test: 'python -m pytest -q',
        lint: 'python -m ruff check .',
        impact: 'python -m pytest {files}',
        coverage: 'python -m pytest -q --cov --cov-report=lcov:coverage/lcov.info',
        reportFile: 'coverage/lcov.info',
        standards: ['python'],
    },
    {
        file: 'Cargo.toml',
        language: 'rust',
        test: 'cargo test',
        lint: 'cargo clippy -- -D warnings',
        impact: 'cargo test {files}',
        coverage: 'cargo llvm-cov --lcov --output-path coverage/lcov.info',
        reportFile: 'coverage/lcov.info',
        standards: ['rust'],
    },
    {
        file: 'pom.xml',
        language: 'java',
        test: 'mvn -q test',
        lint: 'mvn -q -DskipTests verify',
        impact: 'mvn -q -Dtest={files} test',
        coverage: '',
        reportFile: '',
        standards: ['java'],
        unsupported: /jacoco/,
    },
    {
        file: 'build.gradle.kts',
        language: 'kotlin',
        test: 'gradle test',
        lint: 'gradle detekt',
        impact: 'gradle test --tests {files}',
        coverage: '',
        reportFile: '',
        standards: ['kotlin'],
        unsupported: /jacoco|kover/,
    },
    {
        file: 'Crawler.csproj',
        language: 'csharp',
        test: 'dotnet test',
        lint: 'dotnet format --verify-no-changes',
        impact: 'dotnet test --filter {files}',
        coverage: 'dotnet test --collect:"XPlat Code Coverage"',
        reportFile: 'coverage/coverage.cobertura.xml',
        reportFormat: 'cobertura',
        standards: ['csharp'],
    },
    {
        file: 'composer.json',
        language: 'php',
        test: 'vendor/bin/phpunit',
        lint: 'vendor/bin/phpcs',
        impact: 'vendor/bin/phpunit {files}',
        coverage: '',
        reportFile: '',
        standards: ['php'],
        unsupported: /clover/,
    },
    {
        file: 'Gemfile',
        language: 'ruby',
        test: 'bundle exec rspec',
        lint: 'bundle exec rubocop',
        impact: 'bundle exec rspec {files}',
        coverage: 'bundle exec rspec',
        reportFile: 'coverage/lcov.info',
        standards: ['ruby'],
    },
    {
        file: 'Package.swift',
        language: 'swift',
        test: 'swift test',
        lint: 'swiftlint',
        impact: 'swift test --filter {files}',
        coverage: 'swift test --enable-code-coverage',
        reportFile: 'coverage/lcov.info',
        standards: ['swift'],
    },
]

test('TC-001..011: every ecosystem is detected from its manifest and gets the documented defaults', () => {
    for (const expected of ECOSYSTEMS) {
        const cwd = repo({ [expected.file]: 'x\n' })
        const plan = planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir })
        assert.equal(plan.language, expected.language, `${expected.file} must detect ${expected.language}`)
        // An extension match also names the pattern it matched (`*.csproj`), so a
        // person can see why that file counted.
        const escaped = expected.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(plan.languageReason, new RegExp(`^检测依据：命中 ${escaped}`))
        // The plan a person reads names the evidence, not just the conclusion.
        const rendered = renderInitPlan(plan)
        assert.match(rendered, new RegExp(`检测语言：${expected.language}`))
        assert.match(rendered, new RegExp(`语言判定：检测依据：命中 ${expected.file.replace(/\./g, '\\.')}`))

        planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir, apply: true })
        const quality = readJson(cwd, 'quality-gate.json') as { commands: { id: string; command: string; required: boolean }[] }
        const [testCommand, lintCommand] = quality.commands
        assert.equal(testCommand?.command, expected.test, `${expected.file}: test command`)
        assert.equal(testCommand?.required, true)
        assert.equal(lintCommand?.command, expected.lint, `${expected.file}: lint command`)
        assert.equal(lintCommand?.required, false, 'lint is never required')

        const impact = readJson(cwd, 'impact-gate.json') as { testCommandTemplate: string; defaultBase: string }
        assert.equal(impact.testCommandTemplate, expected.impact, `${expected.file}: impact template`)
        assert.equal(impact.defaultBase, 'HEAD')

        const coverage = readJson(cwd, 'coverage-gate.json') as { coverageCommand: string; reportFile: string; reportFormat?: string; thresholds: { total: number } }
        assert.equal(coverage.coverageCommand, expected.coverage, `${expected.file}: coverage command`)
        assert.equal(coverage.reportFile, expected.reportFile, `${expected.file}: report file`)
        assert.equal(coverage.reportFormat, expected.reportFormat, `${expected.file}: report format`)
        assert.equal(coverage.thresholds.total, 70)

        const standards = readJson(cwd, 'standards.json') as { languages: Record<string, unknown> }
        assert.deepEqual(Object.keys(standards.languages), expected.standards, `${expected.file}: standards language keys`)
    }
})

test('the three unsupported coverage formats are left EMPTY with the reason in the plan and the file', () => {
    for (const expected of ECOSYSTEMS) {
        const cwd = repo({ [expected.file]: 'x\n' })
        const rendered = renderInitPlan(planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir }))
        if (expected.unsupported === undefined) {
            assert.doesNotMatch(rendered, /覆盖率：.*的命令留空/, `${expected.file} has a supported coverage format`)
            continue
        }
        // The reason reaches the person running the scaffold …
        assert.match(rendered, new RegExp(`覆盖率：${expected.language} 的命令留空`))
        assert.match(rendered, expected.unsupported)
        // … and no misleading report path is written next to the empty command.
        planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir, apply: true })
        const coverage = readJson(cwd, 'coverage-gate.json') as { coverageCommand: string; reportFile: string }
        assert.equal(coverage.coverageCommand, '', `${expected.file}: a command the parser cannot read must not be written`)
        assert.equal(coverage.reportFile, '', `${expected.file}: a report path the parser cannot read must not be written`)
    }
})

test('detection priority is fixed: the manifest listed first wins, whatever else is present', () => {
    const cases: { files: Record<string, string>; language: string; evidence: RegExp }[] = [
        { files: { 'tsconfig.json': '{}', 'go.mod': 'module x\n', 'Cargo.toml': 'x' }, language: 'ts', evidence: /tsconfig\.json/ },
        { files: { 'go.mod': 'module x\n', 'Cargo.toml': 'x' }, language: 'go', evidence: /go\.mod/ },
        { files: { 'Cargo.toml': 'x', 'package.json': '{}' }, language: 'rust', evidence: /Cargo\.toml/ },
        { files: { 'build.gradle': 'x' }, language: 'java', evidence: /build\.gradle$/ },
        // Java is listed before Kotlin: a repository carrying both is Java's.
        { files: { 'pom.xml': 'x', 'build.gradle.kts': 'x' }, language: 'java', evidence: /pom\.xml/ },
        { files: { 'build.gradle.kts': 'x', 'package.json': '{}' }, language: 'kotlin', evidence: /build\.gradle\.kts/ },
        { files: { 'App.sln': 'x', 'Cargo.toml': 'x' }, language: 'rust', evidence: /Cargo\.toml/ },
        { files: { 'App.sln': 'x' }, language: 'csharp', evidence: /App\.sln（\*\.sln）/ },
        { files: { 'composer.json': '{}', 'pyproject.toml': 'x' }, language: 'php', evidence: /composer\.json/ },
        { files: { 'Gemfile': 'x' }, language: 'ruby', evidence: /Gemfile/ },
        { files: { 'mygem.gemspec': 'x' }, language: 'ruby', evidence: /mygem\.gemspec（\*\.gemspec）/ },
        { files: { 'Package.swift': 'x', 'requirements.txt': 'x' }, language: 'swift', evidence: /Package\.swift/ },
        { files: { 'requirements.txt': 'x', 'package.json': '{}' }, language: 'py', evidence: /requirements\.txt/ },
        { files: { 'package.json': '{}' }, language: 'js', evidence: /package\.json/ },
    ]
    for (const entry of cases) {
        const cwd = repo(entry.files)
        const plan = planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir })
        assert.equal(plan.language, entry.language, `${Object.keys(entry.files).join(' + ')} → ${entry.language}`)
        assert.match(plan.languageReason, entry.evidence)
    }
})

test('an empty repository defaults to ts and says that it is a default, not a detection', () => {
    const cwd = repo({ 'README.md': '# x\n' })
    const plan = planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir })
    assert.equal(plan.language, 'ts')
    assert.match(plan.languageReason, /没有找到任何已知 manifest/)
    assert.match(renderInitPlan(plan), /语言判定：检测依据：没有找到任何已知 manifest/)
})

test('a manifest that is a DIRECTORY does not count as detection evidence', () => {
    const cwd = repo({ 'go.mod/placeholder': 'x\n' })
    assert.equal(planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir }).language, 'ts')
})

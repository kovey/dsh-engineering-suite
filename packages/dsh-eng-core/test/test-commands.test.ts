import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEST_COMMAND_TABLE, recognizeTestCommand, testCommandLabel } from '../dist/test-commands.js'
import { scanWorkspace } from '../dist/index.js'
import { tempWorkspace } from 'dsh-eng-core/testing'

/**
 * The scaffold is the second copy of the detection list, and the only thing
 * that keeps it honest is running it here: one fixture per ecosystem, the
 * printed command must be one the recogniser knows. (The package's own tests
 * resolve sibling modules through `dist/`, like the other suites.)
 */
const SCAFFOLD = fileURLToPath(new URL('../../../scripts/project-config.sh', import.meta.url))

/** The ecosystems the table must keep, in table order (determinism). */
const ECOSYSTEM_ORDER = [
    'JavaScript/TypeScript',
    'Python',
    'Go',
    'Rust',
    'JVM',
    '.NET',
    'C/C++',
    'PHP',
    'Ruby',
    'Elixir/Erlang',
    'Swift/Apple',
    'Zig',
    'Nim',
    'Haskell',
    'Lua',
    'Perl',
    'Shell',
    '通用包装器',
]

/** Every command the feedback asked the table to cover, at minimum. */
const REQUIRED_COMMANDS = [
    // JS/TS
    'npm test', 'npm run test', 'pnpm test', 'yarn test', 'bun test',
    'vitest', 'jest', 'mocha', 'ava', 'tap', 'playwright test', 'cypress run', 'node --test',
    // Python
    'pytest', 'python -m pytest', 'tox', 'nox', 'python -m unittest',
    // Go
    'go test', 'go test ./...', 'gotestsum',
    // Rust
    'cargo test', 'cargo nextest run',
    // JVM
    'mvn test', 'mvn verify', 'gradle test', 'gradle check', './gradlew test', './gradlew check', 'sbt test', 'lein test',
    // .NET
    'dotnet test', 'vstest',
    // C/C++
    'ctest', 'meson test', 'make check',
    // PHP
    'phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit', 'pest', 'vendor/bin/pest',
    'php artisan test', 'composer test', 'composer run test',
    // Ruby
    'rspec', 'bundle exec rspec', 'rake test', 'rails test', 'ruby -Itest',
    // Elixir/Erlang
    'mix test', 'rebar3 eunit',
    // Swift/Apple
    'swift test', 'xcodebuild test',
    // Others
    'deno test', 'zig build test', 'nimble test', 'stack test', 'cabal test', 'busted', 'prove', 'bats',
    // Existing wrappers
    'make test', 'make check', 'make verify', 'bash scripts/test.sh', 'sh test.sh',
]

test('the table is frozen, complete and deterministic', () => {
    assert.ok(Array.isArray(TEST_COMMAND_TABLE), 'the table is an ordered array, not a map')
    assert.ok(Object.isFrozen(TEST_COMMAND_TABLE), 'the table must not be extended at runtime')
    assert.deepEqual([...new Set(TEST_COMMAND_TABLE.map((row) => row.ecosystem))], ECOSYSTEM_ORDER)

    const keys = new Set<string>()
    for (const row of TEST_COMMAND_TABLE) {
        assert.ok(row.ecosystem !== '', 'every row names its ecosystem')
        assert.ok(row.tool !== '', 'every row names its tool')
        assert.ok(row.examples.length > 0, `${row.ecosystem}/${row.tool} needs examples`)
        assert.ok(row.notExample !== '', `${row.ecosystem}/${row.tool} needs a notExample`)
        assert.ok(Object.isFrozen(row), `${row.ecosystem}/${row.tool} must be frozen`)
        assert.ok(Object.isFrozen(row.examples), `${row.ecosystem}/${row.tool}'s examples must be frozen`)
        const key = `${row.ecosystem}/${row.tool}`
        assert.equal(keys.has(key), false, `duplicate row for ${key}: a later row could never match`)
        keys.add(key)
        assert.doesNotThrow(() => new RegExp(`^(?:${row.pattern})(?=\\s|$)`, 'i'), `${key} pattern must compile`)
    }

    // Same table order and same answers on every pass: recognition reads the
    // table only, never a Set/Map iteration or the current time.
    const snapshot = (): string =>
        JSON.stringify(
            TEST_COMMAND_TABLE.map((row) => ({
                row: [row.ecosystem, row.tool, row.pattern],
                results: [...row.examples, row.notExample].map((command) => {
                    const recognition = recognizeTestCommand(command)
                    return [command, recognition.matched, recognition.ecosystem ?? null, recognition.tool ?? null]
                }),
            })),
        )
    assert.equal(snapshot(), snapshot())

    // The coverage floor from the feedback: at least these commands are read as
    // tests, and the lookalikes stay out.
    for (const command of REQUIRED_COMMANDS) {
        assert.equal(recognizeTestCommand(command).matched, true, `required command not recognised: ${command}`)
    }
    for (const command of ['php -l', 'make build', 'go vet ./...', 'composer install']) {
        assert.equal(recognizeTestCommand(command).matched, false, `lookalike recognised: ${command}`)
    }
})

test('every table entry matches its examples and rejects its notExample', () => {
    for (const row of TEST_COMMAND_TABLE) {
        for (const command of row.examples) {
            const recognition = recognizeTestCommand(command)
            assert.equal(recognition.matched, true, `${row.ecosystem}/${row.tool} example not matched: ${command}`)
            assert.equal(recognition.ecosystem, row.ecosystem, `wrong ecosystem for ${command}`)
            assert.equal(recognition.tool, row.tool, `wrong tool for ${command}`)
            assert.equal(testCommandLabel(recognition), `${row.ecosystem} / ${row.tool}`)
        }
        assert.equal(
            recognizeTestCommand(row.notExample).matched,
            false,
            `${row.ecosystem}/${row.tool} lookalike must not match: ${row.notExample}`,
        )
    }
})

test('PHP is recognised, including vendor/bin, artisan, pest and composer (feedback)', () => {
    // The user's example: a healthy PHP repository whose only commands were
    // phpunit/pest/artisan was reported as having no test command at all.
    for (const command of ['phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit', './vendor/bin/phpunit --testsuite unit', 'pest', 'vendor/bin/pest', 'php artisan test', 'composer test', 'composer run test']) {
        const recognition = recognizeTestCommand(command)
        assert.equal(recognition.matched, true, `PHP command not recognised: ${command}`)
        assert.equal(recognition.ecosystem, 'PHP', `wrong ecosystem for ${command}`)
    }
    // …and the lookalikes stay out.
    for (const command of ['php -l', 'php artisan migrate', 'composer install', 'composer require pestphp/pest']) {
        assert.equal(recognizeTestCommand(command).matched, false, `PHP lookalike recognised: ${command}`)
    }
})

test('matching is anchored, case-insensitive and skips env/wrappers/paths (rules)', () => {
    // Word boundary: a longer name that merely starts with a tool is not the tool.
    assert.equal(recognizeTestCommand('mypytest').matched, false)
    assert.equal(recognizeTestCommand('pytest-cov --version').matched, false)
    assert.equal(recognizeTestCommand('taproot --list').matched, false)
    assert.equal(recognizeTestCommand('npm-test run').matched, false)
    // A command that merely CONTAINS the word is not a test invocation.
    assert.equal(recognizeTestCommand('echo pytest').matched, false)
    assert.equal(recognizeTestCommand('grep phpunit').matched, false)
    assert.equal(recognizeTestCommand('cat jest.config.js').matched, false)
    assert.equal(recognizeTestCommand('./ci/run.sh --all').matched, false)
    // Case-insensitive tool name; the label still comes from the table.
    assert.equal(testCommandLabel(recognizeTestCommand('PHPUNIT --version')), 'PHP / phpunit')
    assert.equal(testCommandLabel(recognizeTestCommand('MAKE TEST')), '通用包装器 / make')
    // Environment prefixes and transparent wrappers.
    assert.equal(testCommandLabel(recognizeTestCommand('env CI=1 python3 -m pytest tests/')), 'Python / pytest')
    assert.equal(testCommandLabel(recognizeTestCommand('FOO=bar cargo test')), 'Rust / cargo')
    assert.equal(testCommandLabel(recognizeTestCommand('sudo -E make test')), '通用包装器 / make')
    assert.equal(testCommandLabel(recognizeTestCommand('npx -y vitest run')), 'JavaScript/TypeScript / vitest')
    assert.equal(testCommandLabel(recognizeTestCommand('pnpm exec playwright test')), 'JavaScript/TypeScript / playwright')
    assert.equal(testCommandLabel(recognizeTestCommand('bundle exec rake test')), 'Ruby / rake')
    // A leading path is reduced to its basename; arguments are ignored.
    assert.equal(testCommandLabel(recognizeTestCommand('./vendor/bin/pest --parallel')), 'PHP / pest')
    assert.equal(testCommandLabel(recognizeTestCommand('bin/rspec spec/')), 'Ruby / rspec')
    assert.equal(testCommandLabel(recognizeTestCommand('node_modules/.bin/jest --ci')), 'JavaScript/TypeScript / jest')
    // A wrapper it cannot read past loses the match instead of inventing one.
    assert.equal(recognizeTestCommand('sudo -u deploy phpunit').matched, false)
    // Nothing configured is never a test.
    assert.equal(recognizeTestCommand('').matched, false)
    assert.equal(recognizeTestCommand('   ').matched, false)
})

/** Run the scaffold in its read-only mode and parse the three printed lines. */
function detectWithScaffold(cwd: string, extra: readonly string[] = []): { kind: string; test: string; lint: string; output: string } {
    const output = execFileSync('bash', [SCAFFOLD, '--workspace', cwd, '--print', ...extra], { encoding: 'utf8' })
    const values = new Map<string, string>()
    for (const line of output.split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) values.set(line.slice(0, at), line.slice(at + 1))
    }
    return { kind: values.get('kind') ?? '', test: values.get('test') ?? '', lint: values.get('lint') ?? '', output }
}

/** One manifest per ecosystem the scaffold promises to detect. */
const SCAFFOLD_FIXTURES: readonly { file: string; body: string; kind: string; command: string; label: string }[] = [
    { file: 'composer.json', body: '{}\n', kind: 'php', command: 'vendor/bin/phpunit', label: 'PHP / phpunit' },
    { file: 'Gemfile', body: 'source "https://rubygems.org"\n', kind: 'ruby', command: 'bundle exec rspec', label: 'Ruby / rspec' },
    { file: 'mix.exs', body: 'defmodule Demo.MixProject do\nend\n', kind: 'elixir', command: 'mix test', label: 'Elixir/Erlang / mix' },
    { file: 'Package.swift', body: '// swift-tools-version:5.9\n', kind: 'swift', command: 'swift test', label: 'Swift/Apple / swift' },
    { file: 'build.gradle.kts', body: 'plugins {}\n', kind: 'jvm', command: './gradlew test', label: 'JVM / gradlew' },
    { file: 'pom.xml', body: '<project/>\n', kind: 'jvm', command: 'mvn test', label: 'JVM / mvn' },
    { file: 'Cargo.toml', body: '[package]\nname = "demo"\n', kind: 'rust', command: 'cargo test', label: 'Rust / cargo' },
    { file: 'go.mod', body: 'module demo\n', kind: 'go', command: 'go test ./...', label: 'Go / go' },
    { file: 'pyproject.toml', body: '[project]\nname = "demo"\n', kind: 'python', command: 'pytest -q', label: 'Python / pytest' },
    { file: 'tox.ini', body: '[tox]\n', kind: 'python', command: 'pytest -q', label: 'Python / pytest' },
    { file: 'package.json', body: '{"name":"demo"}\n', kind: 'node', command: 'npm test', label: 'JavaScript/TypeScript / npm' },
    { file: 'pnpm-lock.yaml', body: 'lockfileVersion: 9\n', kind: 'node', command: 'pnpm test', label: 'JavaScript/TypeScript / pnpm' },
    { file: 'yarn.lock', body: '# yarn\n', kind: 'node', command: 'yarn test', label: 'JavaScript/TypeScript / yarn' },
    { file: 'CMakeLists.txt', body: 'project(demo)\n', kind: 'cpp', command: 'ctest', label: 'C/C++ / ctest' },
    { file: 'app.csproj', body: '<Project/>\n', kind: 'dotnet', command: 'dotnet test', label: '.NET / dotnet' },
    { file: 'Makefile', body: 'build:\n\ttrue\n\ntest:\n\ttrue\n', kind: 'make', command: 'make test', label: '通用包装器 / make' },
]

test('the scaffold and the recogniser agree on one fixture per ecosystem (drift guard)', () => {
    for (const fixture of SCAFFOLD_FIXTURES) {
        const cwd = tempWorkspace('scaffold-')
        fs.writeFileSync(path.join(cwd, fixture.file), fixture.body)

        const detected = detectWithScaffold(cwd)
        assert.equal(detected.kind, fixture.kind, `${fixture.file}: wrong project kind`)
        assert.equal(detected.test, fixture.command, `${fixture.file}: wrong suggested command`)
        assert.equal(detected.output.trim().split('\n').length, 3, `${fixture.file}: --print must emit exactly kind/test/lint`)
        assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false, `${fixture.file}: --print must not write`)

        // The pin between the two sides: a command the scaffold suggests MUST be
        // one doctor recognises, and the ecosystem must be the expected one.
        const recognition = recognizeTestCommand(detected.test)
        assert.equal(recognition.matched, true, `${fixture.file}: scaffold suggested an unrecognised command: ${detected.test}`)
        assert.equal(testCommandLabel(recognition), fixture.label, `${fixture.file}: scaffold and recogniser disagree`)

        // Detection is a pure function of the manifest: same bytes, same output.
        assert.equal(detectWithScaffold(cwd).output, detected.output, `${fixture.file}: detection is not deterministic`)
    }
})

test('the scaffold keeps --test/--lint winning over detection, and --print writes nothing', () => {
    const cwd = tempWorkspace('scaffold-override-')
    fs.writeFileSync(path.join(cwd, 'composer.json'), '{}\n')
    const detected = detectWithScaffold(cwd, ['--test', 'make check', '--lint', 'vendor/bin/phpcs'])
    assert.equal(detected.kind, 'php', 'the explicit command must not hide what the repository is')
    assert.equal(detected.test, 'make check', '--test must win over the detected command')
    assert.equal(detected.lint, 'vendor/bin/phpcs', '--lint must win over the detected lint')
    assert.equal(recognizeTestCommand(detected.test).matched, true)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh')), false)
})

/**
 * Run the scaffold read-only and parse its three printed lines.
 *
 * Unlike {@link detectWithScaffold} this tolerates exit 3 ("nothing
 * recognised") instead of throwing: "both sides see no ecosystem" is a
 * legitimate agreement, and a test that cannot observe it would have to skip
 * exactly the manifest (`tsconfig.json`) the acceptance criteria names.
 */
function runScaffold(cwd: string): { kind: string; test: string; lint: string; status: number } {
    const result = spawnSync('bash', [SCAFFOLD, '--workspace', cwd, '--print'], { encoding: 'utf8' })
    const values = new Map<string, string>()
    for (const line of (result.stdout ?? '').split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) values.set(line.slice(0, at), line.slice(at + 1))
    }
    return {
        kind: values.get('kind') ?? '',
        test: values.get('test') ?? '',
        lint: values.get('lint') ?? '',
        status: result.status ?? -1,
    }
}

/**
 * One fixture per manifest `detect()` actually branches on, with the answers
 * both sides must give. `tsconfig.json` is deliberately absent (see the
 * `detect()` body: the shell has no tsconfig branch), `mix.exs`/`CMakeLists.txt`
 * are here because `suggestCommands` gained them, and `*.gemspec`/`*.sln` are
 * covered as suffix variants at the end of the test.
 */
const AGREEMENT_FIXTURES: readonly { file: string; body: string; kind: string; command: string; lint: string }[] = [
    { file: 'composer.json', body: '{}\n', kind: 'php', command: 'vendor/bin/phpunit', lint: 'vendor/bin/phpcs' },
    { file: 'Gemfile', body: 'source "https://rubygems.org"\n', kind: 'ruby', command: 'bundle exec rspec', lint: 'bundle exec rubocop' },
    { file: 'mix.exs', body: 'defmodule Demo.MixProject do\nend\n', kind: 'elixir', command: 'mix test', lint: 'mix format --check-formatted' },
    { file: 'Package.swift', body: '// swift-tools-version:5.9\n', kind: 'swift', command: 'swift test', lint: 'swiftlint' },
    { file: 'build.gradle.kts', body: 'plugins {}\n', kind: 'jvm', command: './gradlew test', lint: './gradlew detekt' },
    { file: 'pom.xml', body: '<project/>\n', kind: 'jvm', command: 'mvn -q test', lint: 'mvn -q -DskipTests verify' },
    { file: 'Cargo.toml', body: '[package]\nname = "demo"\n', kind: 'rust', command: 'cargo test', lint: 'cargo clippy -- -D warnings' },
    { file: 'go.mod', body: 'module demo\n', kind: 'go', command: 'go test ./...', lint: 'go vet ./...' },
    { file: 'pyproject.toml', body: '[project]\nname = "demo"\n', kind: 'python', command: 'pytest -q', lint: '' },
    { file: 'pnpm-lock.yaml', body: 'lockfileVersion: 9\n', kind: 'node', command: 'pnpm test', lint: 'pnpm run lint' },
    { file: 'yarn.lock', body: '# yarn\n', kind: 'node', command: 'yarn test', lint: '' },
    { file: 'package.json', body: '{"name":"demo"}\n', kind: 'node', command: 'npm test', lint: 'npm run lint' },
    { file: 'CMakeLists.txt', body: 'project(demo)\n', kind: 'cpp', command: 'ctest', lint: '' },
    { file: 'app.csproj', body: '<Project/>\n', kind: 'dotnet', command: 'dotnet test', lint: 'dotnet format --verify-no-changes' },
    { file: 'Makefile', body: 'build:\n\ttrue\n\ntest:\n\ttrue\n', kind: 'make', command: 'make test', lint: '' },
]

/** The recogniser ecosystem each detected kind must land in (table names, not shell names). */
const KIND_ECOSYSTEM: Readonly<Record<string, string>> = {
    php: 'PHP',
    ruby: 'Ruby',
    elixir: 'Elixir/Erlang',
    swift: 'Swift/Apple',
    jvm: 'JVM',
    rust: 'Rust',
    go: 'Go',
    python: 'Python',
    node: 'JavaScript/TypeScript',
    dotnet: '.NET',
    cpp: 'C/C++',
    make: '通用包装器',
}

test('the scaffold and suggestCommands agree on every manifest either side detects (drift guard)', () => {
    for (const fixture of AGREEMENT_FIXTURES) {
        const cwd = tempWorkspace('agreement-')
        fs.writeFileSync(path.join(cwd, fixture.file), fixture.body)

        const shell = runScaffold(cwd)
        assert.equal(shell.status, 0, `${fixture.file}: the scaffold did not recognise the manifest`)
        assert.equal(shell.kind, fixture.kind, `${fixture.file}: the scaffold detected a different kind`)

        const suggested = scanWorkspace({ cwd }).suggestedCommands
        const testCommand = suggested.find((entry) => entry.id === 'test')
        const lintCommand = suggested.find((entry) => entry.id === 'lint')
        assert.equal(testCommand?.command, fixture.command, `${fixture.file}: suggestCommands picked a different test command`)
        assert.equal(lintCommand?.command ?? '', fixture.lint, `${fixture.file}: suggestCommands picked a different lint command`)
        // One table, two languages: the lint default is literally the same text.
        assert.equal(shell.lint, fixture.lint, `${fixture.file}: the scaffold's lint default drifted from suggestCommands`)
        // "Same ecosystem": the recogniser reads both sides' test command as the
        // same runner, and that runner is the one the detected kind names.
        const shellLabel = testCommandLabel(recognizeTestCommand(shell.test))
        const scanLabel = testCommandLabel(recognizeTestCommand(fixture.command))
        assert.equal(shellLabel, scanLabel, `${fixture.file}: the two sides name different runners (${shellLabel} vs ${scanLabel})`)
        assert.equal(shellLabel?.split(' / ')[0], KIND_ECOSYSTEM[fixture.kind], `${fixture.file}: recogniser ecosystem disagrees with the detected kind`)
        // No lint entry for an ecosystem without a conventional linter — the
        // absence is the assertion (cpp/make must not grow an invented linter).
        assert.equal(suggested.some((entry) => entry.id === 'lint'), fixture.lint !== '', `${fixture.file}: lint presence must follow the convention, not invent one`)
        assert.deepEqual(
            suggested.map((entry) => [entry.id, entry.required, entry.phase]),
            fixture.lint === '' ? [['test', true, 'gate']] : [['test', true, 'gate'], ['lint', false, 'lint']],
            `${fixture.file}: required/phase invariants changed`,
        )
    }

    // `detect()` has no tsconfig branch, so a tsconfig-only workspace is "no
    // ecosystem" on BOTH sides. The acceptance criteria named tsconfig; this
    // pins the behaviour that actually exists instead of pretending the shell
    // recognises it.
    const tsconfig = tempWorkspace('agreement-')
    fs.writeFileSync(path.join(tsconfig, 'tsconfig.json'), '{}\n')
    const shell = runScaffold(tsconfig)
    assert.equal(shell.status, 3, 'tsconfig.json: the scaffold must report "nothing recognised", not invent a language')
    assert.equal(shell.kind, 'unknown', 'tsconfig.json: wrong kind')
    assert.equal(shell.test, '', 'tsconfig.json: no test command may be invented')
    assert.equal(shell.lint, '', 'tsconfig.json: no lint command may be invented')
    assert.deepEqual(scanWorkspace({ cwd: tsconfig }).suggestedCommands, [], 'tsconfig.json: suggestCommands must not invent a test command either')

    // Suffix manifests: the scan side reads `*.gemspec`/`*.sln` as the same
    // ecosystems the shell reaches through `Gemfile`/`*.csproj`.
    const gem = tempWorkspace('agreement-')
    fs.writeFileSync(path.join(gem, 'demo.gemspec'), 'Gem::Specification.new\n')
    assert.deepEqual(
        scanWorkspace({ cwd: gem }).suggestedCommands.map((entry) => entry.command),
        ['bundle exec rspec', 'bundle exec rubocop'],
        '*.gemspec: must be ruby',
    )
    const sln = tempWorkspace('agreement-')
    fs.writeFileSync(path.join(sln, 'App.sln'), 'Microsoft Visual Studio Solution File\n')
    assert.deepEqual(
        scanWorkspace({ cwd: sln }).suggestedCommands.map((entry) => entry.command),
        ['dotnet test', 'dotnet format --verify-no-changes'],
        '*.sln: must be dotnet',
    )
    assert.equal(runScaffold(sln).kind, 'dotnet', '*.sln: the scaffold reads the same manifest')

    // A DIRECTORY whose name ends in a manifest extension is not a manifest: the
    // shell's `[ -f ]` ignores it, so the scan side must ignore it too.
    const directoryOnly = tempWorkspace('agreement-')
    fs.mkdirSync(path.join(directoryOnly, 'x.csproj'))
    fs.mkdirSync(path.join(directoryOnly, 'y.gemspec'))
    assert.deepEqual(scanWorkspace({ cwd: directoryOnly }).suggestedCommands, [], 'a directory named *.csproj/*.gemspec is not a manifest')
    assert.equal(runScaffold(directoryOnly).status, 3, 'a directory named *.csproj/*.gemspec is "nothing recognised" for the scaffold too')
})

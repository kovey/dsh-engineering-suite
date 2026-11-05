/**
 * "Is this configured command a test command?" — one frozen table for the
 * ecosystems people actually build repositories in.
 *
 * The first version of doctor's `test.command` check was a single hand-written
 * regex. It knew the Go/Node/Python/Cargo runners and nothing else, so a healthy
 * PHP repository (`vendor/bin/phpunit`, `php artisan test`, `pest`) was reported
 * as "有 N 条命令但没有一条能认出是测试" — a false alarm on the one check whose
 * whole job is telling the operator whether the gate tests anything. A table
 * (one row per tool, with an example and a lookalike) is data an operator can
 * audit and a test can iterate; a regex nobody can read is neither.
 *
 * ## Matching rules
 *
 * A command matches an entry when the **head** of the command — not the whole
 * string — matches `pattern`:
 *
 * 1. **Anchored at the start, bounded at the end.** The compiled pattern is
 *    `^(?:pattern)(?=\s|$)`, so `mytool` never matches `tool` and `taproot`
 *    never matches `tap`. Arguments after the tool are ignored (`jest --ci`
 *    matches, `jest` matches).
 * 2. **Case-insensitive**, so `PHPUNIT` and `Make Test` match. The recognised
 *    ecosystem/tool reported back always comes from the table, never from the
 *    command text, so the detail string is deterministic.
 * 3. **Transparent prefixes are skipped**: leading `NAME=value` assignments and
 *    the wrappers `env`, `sudo`, `time`, `command`, `exec`, `nohup`, `npx`,
 *    `pnpx`, `bunx`, plus the two-word forms `pnpm|yarn exec|dlx`, `bun x`,
 *    `bundle exec`, `poetry run`, `pipenv run`. A wrapper's flags (`sudo -E`,
 *    `npx -y`) are dropped too. A wrapper this function cannot read past can
 *    only lose a match (`sudo -u deploy phpunit`), never invent one.
 * 4. **A leading path is reduced to its basename**, so `./gradlew`,
 *    `vendor/bin/phpunit`, `./vendor/bin/phpunit`, `bin/rails` and
 *    `node_modules/.bin/jest` match the same rows as `gradlew`, `phpunit`,
 *    `rails` and `jest`. Patterns are therefore written path-free.
 * 5. **A command that merely CONTAINS a tool word does not match**: `echo
 *    pytest`, `grep phpunit`, `cat jest.config.js`, `pip install pytest` and
 *    `composer require pestphp/pest` all fail rule 1. Entries also carry a
 *    `notExample` that must stay unmatched — the tests iterate every row.
 * 6. **First row wins in table order**, which is grouped by ecosystem and
 *    stable by construction; no row overlaps another, and the tests pin both
 *    the order and the row count. The table and every `examples` array are
 *    frozen, so runtime code cannot quietly extend the recogniser.
 *
 * `doctor` uses this module for the `test.command` check;
 * `scripts/project-config.sh` suggests the commands it recognises. A test
 * drives the scaffold's output through {@link recognizeTestCommand} for one
 * fixture per ecosystem, which is what keeps the two lists from drifting.
 *
 * @module dsh-eng-core/test-commands
 */

/** One row of {@link TEST_COMMAND_TABLE}. */
export interface TestCommandEntry {
    /** The ecosystem the tool belongs to, e.g. `PHP` (shown to the operator). */
    readonly ecosystem: string
    /** The runner, e.g. `phpunit` (shown to the operator). */
    readonly tool: string
    /**
     * Regex matched against the normalised command head (see the module
     * comment). Written without a leading path and without anchors: the
     * recogniser anchors it and requires a word boundary at the end.
     */
    readonly pattern: string
    /** Commands that MUST match — the table's own positive fixtures. */
    readonly examples: readonly string[]
    /** A lookalike that MUST NOT match — the table's own negative fixture. */
    readonly notExample: string
}

/** What {@link recognizeTestCommand} answers. */
export interface TestCommandRecognition {
    /** Whether the command starts with a known test runner. */
    readonly matched: boolean
    /** The matching row's ecosystem (present only when `matched`). */
    readonly ecosystem?: string
    /** The matching row's tool (present only when `matched`). */
    readonly tool?: string
}

/** Shorthand for a frozen table row. */
function entry(ecosystem: string, tool: string, pattern: string, examples: readonly string[], notExample: string): TestCommandEntry {
    return Object.freeze({ ecosystem, tool, pattern, examples: Object.freeze([...examples]), notExample })
}

/**
 * Every runner this suite recognises, grouped by ecosystem.
 *
 * Order is the matching priority AND the order the tests iterate; the rows are
 * disjoint, so order only matters for reproducibility. Adding an ecosystem means
 * adding rows here and a manifest to `detect()` in `scripts/project-config.sh`
 * (the cross-side test fails until both sides agree).
 */
export const TEST_COMMAND_TABLE: readonly TestCommandEntry[] = Object.freeze([
    // --- JavaScript / TypeScript -------------------------------------------
    entry('JavaScript/TypeScript', 'npm', 'npm (?:-\\S+ )*(?:run )?test', ['npm test', 'npm run test', 'npm test -- --coverage', 'npm --silent test'], 'npm run build'),
    entry('JavaScript/TypeScript', 'pnpm', 'pnpm (?:-\\S+ )*(?:run )?test', ['pnpm test', 'pnpm run test', 'pnpm -r test'], 'pnpm install'),
    entry('JavaScript/TypeScript', 'yarn', 'yarn (?:-\\S+ )*(?:run )?test', ['yarn test', 'yarn run test'], 'yarn add jest'),
    entry('JavaScript/TypeScript', 'bun', 'bun (?:-\\S+ )*(?:run )?test', ['bun test', 'bun run test'], 'bun run build'),
    entry('JavaScript/TypeScript', 'vitest', 'vitest', ['vitest', 'vitest run', 'npx vitest run', 'pnpm exec vitest run'], 'cat vitest.config.ts'),
    entry('JavaScript/TypeScript', 'jest', 'jest', ['jest', 'jest --ci', 'npx jest --watchAll'], 'node jest-setup.js'),
    entry('JavaScript/TypeScript', 'mocha', 'mocha', ['mocha', 'mocha test/**/*.js', 'npx mocha'], 'cat .mocharc.json'),
    entry('JavaScript/TypeScript', 'ava', 'ava', ['ava', 'npx ava --serial'], 'cat ava.config.js'),
    entry('JavaScript/TypeScript', 'tap', 'tap', ['tap', 'tap test/*.js'], 'taproot --list'),
    entry('JavaScript/TypeScript', 'playwright', 'playwright test', ['playwright test', 'npx playwright test --project=chromium'], 'playwright install'),
    entry('JavaScript/TypeScript', 'cypress', 'cypress run', ['cypress run', 'npx cypress run --headless'], 'cypress open'),
    entry('JavaScript/TypeScript', 'node', 'node --test', ['node --test', 'node --test test/unit/'], 'node --version'),
    entry('JavaScript/TypeScript', 'deno', 'deno test', ['deno test', 'deno test --allow-read'], 'deno run main.ts'),

    // --- Python -------------------------------------------------------------
    entry('Python', 'pytest', '(?:python3? -m )?pytest', ['pytest', 'pytest -q', 'python -m pytest', 'python3 -m pytest tests/'], 'pip install pytest'),
    entry('Python', 'tox', 'tox', ['tox', 'tox -e py312'], 'cat tox.ini'),
    entry('Python', 'nox', 'nox', ['nox', 'nox -s tests'], 'cat noxfile.py'),
    entry('Python', 'unittest', 'python3? -m unittest', ['python -m unittest', 'python3 -m unittest discover'], 'python -m venv .venv'),

    // --- Go -----------------------------------------------------------------
    entry('Go', 'go', 'go test', ['go test', 'go test ./...', 'go test -race ./pkg/...'], 'go vet ./...'),
    entry('Go', 'gotestsum', 'gotestsum', ['gotestsum', 'gotestsum --format testname -- ./...'], 'go run gotestsum/main.go'),

    // --- Rust ---------------------------------------------------------------
    entry('Rust', 'cargo', 'cargo test', ['cargo test', 'cargo test --all-features'], 'cargo build'),
    entry('Rust', 'cargo nextest', 'cargo nextest run', ['cargo nextest run', 'cargo nextest run --all-features'], 'cargo nextest list'),

    // --- JVM ----------------------------------------------------------------
    entry('JVM', 'mvn', 'mvn (?:-\\S+ )*(?:test|verify)', ['mvn test', 'mvn verify', 'mvn -B -q verify'], 'mvn install'),
    entry('JVM', 'mvnw', 'mvnw (?:-\\S+ )*(?:test|verify)', ['./mvnw test', 'mvnw verify'], './mvnw package'),
    entry('JVM', 'gradle', 'gradle (?:-\\S+ )*(?:test|check)', ['gradle test', 'gradle check'], 'gradle build'),
    entry('JVM', 'gradlew', 'gradlew (?:-\\S+ )*(?:test|check)', ['./gradlew test', 'gradlew check', './gradlew test --no-daemon'], './gradlew build'),
    entry('JVM', 'sbt', 'sbt (?:-\\S+ )*test', ['sbt test', 'sbt -batch test'], 'sbt compile'),
    entry('JVM', 'lein', 'lein test', ['lein test', 'lein test :only foo.core-test'], 'lein run'),

    // --- .NET ---------------------------------------------------------------
    entry('.NET', 'dotnet', 'dotnet test', ['dotnet test', 'dotnet test ./src/App.sln'], 'dotnet build'),
    entry('.NET', 'vstest', 'vstest(?:\\.console(?:\\.exe)?)?', ['vstest', 'vstest.console.exe App.Tests.dll'], 'cat vstest.runtimeconfig.json'),

    // --- C / C++ ------------------------------------------------------------
    entry('C/C++', 'ctest', 'ctest', ['ctest', 'ctest --output-on-failure', 'ctest -j4'], 'cmake --build build'),
    entry('C/C++', 'meson', 'meson test', ['meson test', 'meson test -C builddir'], 'meson setup build'),

    // --- PHP ----------------------------------------------------------------
    entry('PHP', 'phpunit', 'phpunit', ['phpunit', 'vendor/bin/phpunit', './vendor/bin/phpunit --testsuite unit', 'phpunit --coverage-text'], 'php -l'),
    entry('PHP', 'pest', 'pest', ['pest', 'vendor/bin/pest', './vendor/bin/pest --parallel'], 'composer require pestphp/pest'),
    entry('PHP', 'artisan', 'php artisan test', ['php artisan test', 'php artisan test --parallel'], 'php artisan migrate'),
    entry('PHP', 'composer', 'composer (?:run(?:-script)? )?test', ['composer test', 'composer run test', 'composer run-script test'], 'composer install'),

    // --- Ruby ---------------------------------------------------------------
    entry('Ruby', 'rspec', 'rspec', ['rspec', 'rspec spec/models', 'bundle exec rspec', 'bin/rspec'], 'bundle install'),
    entry('Ruby', 'rake', 'rake test', ['rake test', 'bundle exec rake test'], 'rake db:migrate'),
    entry('Ruby', 'rails', 'rails test', ['rails test', 'bin/rails test test/models'], 'rails server'),
    entry('Ruby', 'ruby', 'ruby -Itest', ['ruby -Itest', 'ruby -Itest test/user_test.rb'], 'ruby -v'),

    // --- Elixir / Erlang ----------------------------------------------------
    entry('Elixir/Erlang', 'mix', 'mix test', ['mix test', 'mix test --warnings-as-errors'], 'mix compile'),
    entry('Elixir/Erlang', 'rebar3', 'rebar3 (?:eunit|ct)', ['rebar3 eunit', 'rebar3 ct'], 'rebar3 compile'),

    // --- Swift / Apple ------------------------------------------------------
    entry('Swift/Apple', 'swift', 'swift test', ['swift test', 'swift test --parallel'], 'swift build'),
    entry('Swift/Apple', 'xcodebuild', 'xcodebuild (?:-\\S+ \\S+ )*test', ['xcodebuild test', 'xcodebuild -scheme App test'], 'xcodebuild build'),

    // --- Single-runner ecosystems ------------------------------------------
    entry('Zig', 'zig', 'zig build test', ['zig build test', 'zig build test -Doptimize=ReleaseSafe'], 'zig build'),
    entry('Nim', 'nimble', 'nimble test', ['nimble test', 'nimble test -d:release'], 'nimble install'),
    entry('Haskell', 'stack', 'stack test', ['stack test', 'stack test --coverage'], 'stack build'),
    entry('Haskell', 'cabal', 'cabal test', ['cabal test', 'cabal test all'], 'cabal build'),
    entry('Lua', 'busted', 'busted', ['busted', 'busted spec/'], 'luarocks install busted'),
    entry('Perl', 'prove', 'prove', ['prove', 'prove -l t/'], 'perl -Mprove -e 1'),
    entry('Shell', 'bats', 'bats', ['bats', 'bats test/', 'bats -r tests/'], 'npm install bats'),

    // --- Generic wrappers (the last resort, not a toolchain of their own) ---
    entry('通用包装器', 'make', 'make (?:-\\S+ )*(?:test|check|verify)', ['make test', 'make check', 'make verify', 'make -j4 test'], 'make build'),
    entry('通用包装器', 'shell', '(?:bash|sh) \\S*test\\S*\\.sh', ['bash scripts/test.sh', 'sh test.sh', 'bash ./test/unit.sh'], 'bash scripts/build.sh'),
])

/**
 * Wrappers whose own name is not the tool being run: dropping them (and their
 * flags) lets `npx vitest run` / `sudo make test` match the row underneath.
 */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(['env', 'sudo', 'time', 'command', 'exec', 'nohup', 'npx', 'pnpx', 'bunx'])

/** Two-word wrappers (`bundle exec rspec`, `poetry run pytest`, …). */
const TWO_WORD_WRAPPERS: readonly (readonly [string, string])[] = [
    ['pnpm', 'exec'],
    ['pnpm', 'dlx'],
    ['yarn', 'exec'],
    ['yarn', 'dlx'],
    ['bun', 'x'],
    ['bundle', 'exec'],
    ['poetry', 'run'],
    ['pipenv', 'run'],
]

/** `NAME=value` — an environment assignment in front of the real command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Drop leading environment assignments and transparent wrappers. */
function stripWrappers(tokens: readonly string[]): string[] {
    let rest = [...tokens]
    for (;;) {
        const first = rest[0]
        if (first === undefined) return rest
        if (ASSIGNMENT.test(first) || TRANSPARENT_WRAPPERS.has(first)) {
            rest = rest.slice(1)
            // A wrapper's own flags (`sudo -E`, `npx -y`) are not the tool.
            while (rest[0] !== undefined && rest[0].startsWith('-')) rest = rest.slice(1)
            continue
        }
        const pair = TWO_WORD_WRAPPERS.find(([head, second]) => head === first && second === rest[1])
        if (pair !== undefined) {
            rest = rest.slice(2)
            continue
        }
        return rest
    }
}

/** Reduce a leading path to its basename (`./vendor/bin/phpunit` → `phpunit`). */
function stripLeadingPath(tokens: readonly string[]): string[] {
    const first = tokens[0]
    if (first === undefined || !first.includes('/')) return [...tokens]
    const parts = first.split('/').filter((part) => part !== '' && part !== '.')
    const name = parts[parts.length - 1]
    if (name === undefined || name === '') return [...tokens]
    return [name, ...tokens.slice(1)]
}

/**
 * Normalise a command to the words that identify the runner: whitespace runs
 * collapse, wrapper prefixes and a leading path are removed.
 */
function normalize(command: string): string {
    let tokens = command.trim().split(/\s+/).filter((token) => token !== '')
    for (;;) {
        const next = stripLeadingPath(stripWrappers(tokens))
        if (next.join(' ') === tokens.join(' ')) return next.join(' ')
        tokens = next
    }
}

/** The compiled rows: `pattern` anchored, bounded, case-insensitive. */
const MATCHERS: readonly { entry: TestCommandEntry; regex: RegExp }[] = TEST_COMMAND_TABLE.map((row) => ({
    entry: row,
    regex: new RegExp(`^(?:${row.pattern})(?=\\s|$)`, 'i'),
}))

/**
 * Decide whether `command` starts with a recognised test runner.
 *
 * @param command - a configured gate command, e.g. `vendor/bin/phpunit -q`.
 * @returns `{ matched: false }`, or the matching row's ecosystem and tool.
 */
export function recognizeTestCommand(command: string): TestCommandRecognition {
    const head = normalize(command)
    if (head === '') return { matched: false }
    for (const matcher of MATCHERS) {
        if (matcher.regex.test(head)) {
            return { matched: true, ecosystem: matcher.entry.ecosystem, tool: matcher.entry.tool }
        }
    }
    return { matched: false }
}

/**
 * The operator-facing label for a recognition, e.g. `PHP / phpunit`; `undefined`
 * when nothing matched. Reads the table only, so the text never depends on how
 * the command was written (`./vendor/bin/PHPUnit` still says `PHP / phpunit`).
 */
export function testCommandLabel(recognition: TestCommandRecognition): string | undefined {
    return recognition.matched && recognition.ecosystem !== undefined && recognition.tool !== undefined
        ? `${recognition.ecosystem} / ${recognition.tool}`
        : undefined
}

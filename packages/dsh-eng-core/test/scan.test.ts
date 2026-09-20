/**
 * dsh-eng-core scan tests.
 *
 * Every fixture is built in a fresh temp directory (nothing is committed to the
 * repository), so the suite stays honest on machines that do not have the
 * sample repositories the scanner was sanity-checked against.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanGaps, scanWorkspace } from '../dist/index.js'
import type { CodeSymbol, ScanResult, SpecRecord, TestDesign } from '../dist/index.js'

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-scan-'))
}

function write(root: string, rel: string, text: string): string {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
}

function symbolNamed(symbols: readonly CodeSymbol[], name: string, kind?: CodeSymbol['kind']): CodeSymbol | undefined {
    return symbols.find((symbol) => symbol.name === name && (kind === undefined || symbol.kind === kind))
}

const GO_SERVICE = [
    'package main',
    '',
    'import "net/http"',
    '',
    'type Server struct{}',
    '',
    'type Runner interface { Run() error }',
    '',
    'func main() {',
    '    mux := http.NewServeMux()',
    '    mux.HandleFunc("/healthz", handleHealth)',
    '    http.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {})',
    '    r := mux',
    '    r.Get("/items", handleItems)',
    '}',
    '',
    'func handleHealth(w http.ResponseWriter, r *http.Request) {}',
    '',
    'func handleItems(w http.ResponseWriter, r *http.Request) {}',
    '',
    'func (s *Server) Start(port int) error { return nil }',
    '',
    'func (s Server) stop() {}',
    '',
    'func unexported() {}',
    '',
].join('\n')

const TS_API = [
    "import express from 'express'",
    '',
    "export const VERSION = '1.0.0'",
    '',
    'export interface Options { port: number }',
    '',
    "export type Mode = 'dev' | 'prod'",
    '',
    'export class Api {',
    '    listen(port: number): void {}',
    '}',
    '',
    'export function createApi(options: Options): Api { return new Api() }',
    '',
    'export async function warmup(): Promise<void> {}',
    '',
    'const app = express()',
    'const router = express.Router()',
    "app.get('/api/items', listItems)",
    "router.post('/api/items', createItem)",
    '',
].join('\n')

const JS_UTIL = [
    'export function helper(value) { return value }',
    '',
    'export const LIMIT = 10',
    '',
].join('\n')

const PY_APP = [
    'from flask import Flask',
    '',
    'app = Flask(__name__)',
    'router = Blueprint("api", __name__)',
    '',
    "@app.route('/health')",
    'def health():',
    "    return 'ok'",
    '',
    "@router.get('/items')",
    'async def list_items():',
    '    return []',
    '',
    'class Store:',
    '    pass',
    '',
    'def compute(value):',
    '    return value',
    '',
    'async def fetch(url):',
    '    return url',
    '',
].join('\n')

test('scanWorkspace detects symbols in Go, TypeScript, JavaScript and Python', () => {
    const cwd = workspace()
    write(cwd, 'cmd/server/main.go', GO_SERVICE)
    write(cwd, 'src/api.ts', TS_API)
    write(cwd, 'lib/util.js', JS_UTIL)
    write(cwd, 'service/app.py', PY_APP)
    write(cwd, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'tsc -p .' } }, undefined, 2))
    write(cwd, 'go.mod', 'module demo\n')

    const result = scanWorkspace({ cwd })
    const symbols = result.symbols

    // Go: functions, methods, receivers, exported-ness, main and types.
    assert.deepEqual(symbolNamed(symbols, 'handleHealth', 'func'), {
        path: 'cmd/server/main.go',
        line: 17,
        kind: 'func',
        name: 'handleHealth',
        detail: 'unexported',
    })
    assert.equal(symbolNamed(symbols, 'unexported')?.detail, 'unexported')
    assert.deepEqual(symbolNamed(symbols, 'Start'), {
        path: 'cmd/server/main.go',
        line: 21,
        kind: 'method',
        name: 'Start',
        detail: 'Server',
    })
    assert.equal(symbolNamed(symbols, 'stop')?.kind, 'method')
    assert.equal(symbolNamed(symbols, 'main')?.kind, 'main')
    assert.equal(symbolNamed(symbols, 'Server')?.kind, 'type')
    assert.equal(symbolNamed(symbols, 'Server')?.detail, 'struct')
    assert.equal(symbolNamed(symbols, 'Runner')?.detail, 'interface')

    // TypeScript: function, class, interface, type and value exports.
    assert.equal(symbolNamed(symbols, 'createApi')?.kind, 'func')
    assert.equal(symbolNamed(symbols, 'Api')?.detail, 'class')
    assert.equal(symbolNamed(symbols, 'Options')?.detail, 'interface')
    assert.equal(symbolNamed(symbols, 'Mode')?.detail, 'type')
    assert.equal(symbolNamed(symbols, 'VERSION')?.kind, 'export')

    // JavaScript.
    assert.equal(symbolNamed(symbols, 'helper')?.kind, 'func')
    assert.equal(symbolNamed(symbols, 'LIMIT')?.kind, 'export')

    // Python: top-level def/async def/class only.
    assert.equal(symbolNamed(symbols, 'compute')?.kind, 'func')
    assert.equal(symbolNamed(symbols, 'fetch')?.kind, 'func')
    assert.equal(symbolNamed(symbols, 'Store')?.detail, 'class')

    // package.json scripts become `cli` symbols named after the script.
    assert.deepEqual(symbolNamed(symbols, 'test'), {
        path: 'package.json',
        line: 4,
        kind: 'cli',
        name: 'test',
        detail: 'node --test',
    })
    assert.equal(symbolNamed(symbols, 'build')?.kind, 'cli')

    // Languages are counted by extension.
    assert.deepEqual(result.stats.languages, { go: 1, js: 1, python: 1, ts: 1 })
    assert.equal(result.stats.truncated, false)
    assert.deepEqual(result.buildFiles, ['go.mod', 'package.json'])
})

test('scanWorkspace detects routes in Go, TypeScript/JavaScript and Python', () => {
    const cwd = workspace()
    write(cwd, 'main.go', GO_SERVICE)
    write(cwd, 'src/api.ts', TS_API)
    write(cwd, 'service/app.py', PY_APP)

    const routes = scanWorkspace({ cwd }).symbols.filter((symbol) => symbol.kind === 'route')

    assert.deepEqual(
        routes.map((route) => `${route.path}:${route.line} route ${route.name} -> ${route.detail}`),
        [
            'main.go:11 route handleHealth -> /healthz',
            'main.go:12 route http.HandleFunc -> /ready',
            'main.go:14 route handleItems -> /items',
            'service/app.py:6 route health -> /health',
            'service/app.py:10 route list_items -> /items',
            'src/api.ts:19 route listItems -> /api/items',
            'src/api.ts:20 route createItem -> /api/items',
        ],
    )
})

test('Go test files contribute table-driven and t.Run cases instead of symbols', () => {
    const cwd = workspace()
    write(
        cwd,
        'internal/report/service_test.go',
        [
            'package report',
            '',
            'import "testing"',
            '',
            'func TestService(t *testing.T) {',
            '\tt.Run("creates a record", func(t *testing.T) {})',
            '\tt.Run("", func(t *testing.T) {})',
            '\tt.Run("creates a record", func(t *testing.T) {})',
            '}',
            '',
            'func TestTable(t *testing.T) {',
            '\tcases := []struct {',
            '\t\tname string',
            '\t\twant int',
            '\t}{',
            '\t\t{name: "rejects a negative value", want: 0},',
            '\t\t{',
            '\t\t\tname: "accepts zero",',
            '\t\t\twant: 1,',
            '\t\t},',
            '\t}',
            '\tfor _, tc := range cases {',
            '\t\tt.Run(tc.name, func(t *testing.T) {})',
            '\t}',
            '}',
            '',
        ].join('\n'),
    )
    write(cwd, 'internal/report/service.go', 'package report\n\nfunc Build() string { return "x" }\n')

    const result = scanWorkspace({ cwd })

    assert.deepEqual(result.tests, [
        {
            path: 'internal/report/service_test.go',
            cases: [
                { name: 'creates a record', line: 6 },
                { name: 'rejects a negative value', line: 16 },
                { name: 'accepts zero', line: 18 },
            ],
        },
    ])
    // The test file is evidence, not API surface.
    assert.equal(symbolNamed(result.symbols, 'TestService'), undefined)
    assert.equal(symbolNamed(result.symbols, 'Build')?.path, 'internal/report/service.go')
})

test('TS/JS and Python test files contribute their named cases', () => {
    const cwd = workspace()
    write(
        cwd,
        'test/api.test.ts',
        [
            "import { test, it, describe } from 'node:test'",
            '',
            "describe('api', () => {",
            "    test('returns a list', () => {})",
            "    it('rejects a bad token', () => {})",
            "    test('', () => {})",
            "    test('returns a list', () => {})",
            '})',
            '',
        ].join('\n'),
    )
    write(
        cwd,
        'tests/test_api.py',
        [
            'def test_health():',
            '    assert True',
            '',
            'async def test_items():',
            '    assert True',
            '',
            'def helper():',
            '    return 1',
            '',
        ].join('\n'),
    )

    const result = scanWorkspace({ cwd })

    assert.deepEqual(result.tests, [
        { path: 'test/api.test.ts', cases: [{ name: 'api', line: 3 }, { name: 'returns a list', line: 4 }, { name: 'rejects a bad token', line: 5 }] },
        { path: 'tests/test_api.py', cases: [{ name: 'test_health', line: 1 }, { name: 'test_items', line: 4 }] },
    ])
})

test('requirement docs are found, classified and mined for candidate statements', () => {
    const cwd = workspace()
    write(
        cwd,
        'README.md',
        [
            '# Demo Service',
            '',
            'A short introduction that is long enough to read as a paragraph.',
            '',
            '## 需求',
            '',
            '- 支持多租户的数据隔离',
            '- 支持多租户的数据隔离',
            '- 支持多租户隔离',
            '1. 提供 HTTP 接口与健康检查',
            '',
            '```go',
            '# 这不是标题',
            '```',
            '',
            '## 目标与验收',
            '',
            '验收时必须能在离线环境完成，且不依赖外网。',
            '',
        ].join('\n'),
    )
    write(cwd, 'docs/design.md', ['# Design', '', '- 使用 SQLite 作为默认存储', '- 纯函数式核心，便于测试', ''].join('\n'))
    write(cwd, 'docs/features/auth.md', ['## 功能', '', '### 认证', '', '- 支持邮箱与密码登录', ''].join('\n'))
    write(cwd, 'CHANGELOG.md', '# Changelog\n\n## 需求\n\n- 这一条来自其他文档\n')
    write(cwd, '.dsh/specs/mission-1.md', '# 已渲染的规格\n\n## 需求\n\n- 复用已有规格里的需求条目\n')

    const result = scanWorkspace({ cwd })
    const byPath = new Map(result.requirements.map((doc) => [doc.path, doc]))

    assert.deepEqual(result.requirements.map((doc) => doc.path), [
        '.dsh/specs/mission-1.md',
        'CHANGELOG.md',
        'README.md',
        'docs/design.md',
        'docs/features/auth.md',
    ])
    assert.equal(byPath.get('README.md')?.kind, 'readme')
    assert.equal(byPath.get('docs/design.md')?.kind, 'docs')
    assert.equal(byPath.get('docs/features/auth.md')?.kind, 'docs')
    assert.equal(byPath.get('CHANGELOG.md')?.kind, 'other')
    assert.equal(byPath.get('.dsh/specs/mission-1.md')?.kind, 'spec')

    const readme = byPath.get('README.md')
    assert.equal(readme?.title, 'Demo Service')
    assert.deepEqual(readme?.headings, [
        { level: 1, text: 'Demo Service', line: 1 },
        { level: 2, text: '需求', line: 5 },
        { level: 2, text: '目标与验收', line: 16 },
    ])
    // Duplicates collapse, a 7-character item falls below the 8-character
    // floor, and the fenced `# 这不是标题` never becomes a heading.
    assert.deepEqual(readme?.candidates, [
        { text: '支持多租户的数据隔离', line: 7, heading: '需求' },
        { text: '提供 HTTP 接口与健康检查', line: 10, heading: '需求' },
        { text: '验收时必须能在离线环境完成，且不依赖外网。', line: 18, heading: '目标与验收' },
    ])

    // A document with no requirement-ish heading falls back to its list items.
    assert.deepEqual(byPath.get('docs/design.md')?.candidates, [
        { text: '使用 SQLite 作为默认存储', line: 3, heading: 'Design' },
        { text: '纯函数式核心，便于测试', line: 4, heading: 'Design' },
    ])
    // A requirement-ish ancestor heading covers its subsections.
    assert.deepEqual(byPath.get('docs/features/auth.md')?.candidates, [
        { text: '支持邮箱与密码登录', line: 5, heading: '认证' },
    ])
})

test('candidate statements are capped at 200 per document', () => {
    const cwd = workspace()
    const items = Array.from({ length: 260 }, (_, index) => `- 需求条目编号 ${index} 需要覆盖的场景`).join('\n')
    write(cwd, 'README.md', `# Big\n\n## 需求\n\n${items}\n`)

    const readme = scanWorkspace({ cwd }).requirements[0]
    assert.equal(readme?.candidates.length, 200)
    assert.equal(readme?.candidates[0]?.text, '需求条目编号 0 需要覆盖的场景')
    assert.equal(readme?.candidates[199]?.text, '需求条目编号 199 需要覆盖的场景')
})

test('suggestedCommands mirrors scripts/project-config.sh per build file', () => {
    const cases: { files: string[]; commands: string[] }[] = [
        { files: ['go.mod'], commands: ['go test ./...', 'go vet ./...'] },
        { files: ['pyproject.toml'], commands: ['pytest -q'] },
        { files: ['pytest.ini'], commands: ['pytest -q'] },
        { files: ['tests/keep.txt'], commands: ['pytest -q'] },
        { files: ['pnpm-lock.yaml'], commands: ['pnpm test', 'pnpm run lint'] },
        { files: ['yarn.lock'], commands: ['yarn test'] },
        { files: ['package.json'], commands: ['npm test', 'npm run lint'] },
        { files: ['Makefile'], commands: ['make test'] },
        { files: ['Cargo.toml'], commands: ['cargo test', 'cargo clippy -- -D warnings'] },
        { files: ['notes.txt'], commands: [] },
    ]
    for (const fixture of cases) {
        const cwd = workspace()
        for (const file of fixture.files) {
            if (file === 'Makefile') write(cwd, file, 'build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n')
            else if (file === 'package.json') write(cwd, file, '{ "name": "demo", "scripts": { "test": "node --test" } }\n')
            else if (file === 'pyproject.toml') write(cwd, file, '[project]\nname = "demo"\n')
            else write(cwd, file, '# fixture\n')
        }
        assert.deepEqual(
            scanWorkspace({ cwd }).suggestedCommands.map((command) => command.command),
            fixture.commands,
            `files: ${fixture.files.join(', ')}`,
        )
    }
})

test('suggestedCommands honours precedence and the required/lint invariants', () => {
    const cwd = workspace()
    write(cwd, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
    write(cwd, 'package.json', '{ "name": "demo", "scripts": { "test": "vitest run" } }\n')
    write(cwd, 'go.mod', 'module demo\n')
    write(cwd, 'Makefile', 'test:\n\tgo test ./...\n')

    const commands = scanWorkspace({ cwd }).suggestedCommands
    assert.deepEqual(commands.map((command) => command.command), ['go test ./...', 'go vet ./...'])
    assert.deepEqual(commands.map((command) => command.id), ['test', 'lint'])
    assert.deepEqual(commands.map((command) => command.required), [true, false])
    assert.deepEqual(commands.map((command) => command.phase), ['gate', 'lint'])
    assert.equal(commands[0]?.name, '单元测试')
    assert.equal(commands[1]?.name, 'lint')

    // ruff in pyproject.toml adds the lint command the shell script detects.
    const ruff = workspace()
    write(ruff, 'pyproject.toml', '[project]\nname = "demo"\n\n[tool.ruff]\nline-length = 120\n')
    assert.deepEqual(
        scanWorkspace({ cwd: ruff }).suggestedCommands.map((command) => command.command),
        ['pytest -q', 'ruff check .'],
    )
})

test('an unknown project suggests nothing', () => {
    const cwd = workspace()
    write(cwd, 'main.c', 'int main(void) { return 0; }\n')
    const result = scanWorkspace({ cwd })
    assert.deepEqual(result.suggestedCommands, [])
    assert.deepEqual(result.buildFiles, [])
    assert.equal(result.stats.filesScanned, 1)
    assert.deepEqual(result.stats.languages, {})
})

test('a missing workspace root still returns a result', () => {
    const result = scanWorkspace({ cwd: path.join(os.tmpdir(), 'eng-scan-missing-9f8a7b') })

    assert.equal(result.stats.filesScanned, 0)
    assert.equal(result.stats.truncated, false)
    assert.deepEqual(result.requirements, [])
    assert.deepEqual(result.symbols, [])
    assert.deepEqual(result.tests, [])
    assert.deepEqual(result.suggestedCommands, [])
})

test('default and configured ignore directories are never walked', () => {
    const cwd = workspace()
    write(cwd, 'src/app.go', 'package src\n\nfunc Keep() {}\n')
    write(cwd, 'node_modules/dep/index.js', 'export function Dependency() {}\n')
    write(cwd, 'dist/bundle.js', 'export function Bundled() {}\n')
    write(cwd, 'vendor/dep/dep.go', 'package dep\n\nfunc Vendored() {}\n')
    write(cwd, 'custom/generated.go', 'package custom\n\nfunc Generated() {}\n')

    const defaults = scanWorkspace({ cwd })
    assert.ok(symbolNamed(defaults.symbols, 'Keep'))
    assert.equal(symbolNamed(defaults.symbols, 'Dependency'), undefined)
    assert.equal(symbolNamed(defaults.symbols, 'Bundled'), undefined)
    assert.equal(symbolNamed(defaults.symbols, 'Vendored'), undefined)
    assert.ok(symbolNamed(defaults.symbols, 'Generated'))

    const extras = scanWorkspace({ cwd, ignoreDirs: ['custom'] })
    assert.equal(symbolNamed(extras.symbols, 'Generated'), undefined)
    assert.ok(symbolNamed(extras.symbols, 'Keep'))
})

test('maxFiles truncates the walk and sets stats.truncated', () => {
    const cwd = workspace()
    for (let index = 0; index < 6; index += 1) {
        write(cwd, `pkg/file${index}.go`, `package pkg\n\nfunc Fn${index}() {}\n`)
    }

    const capped = scanWorkspace({ cwd, maxFiles: 3 })
    assert.equal(capped.stats.filesScanned, 3)
    assert.equal(capped.stats.truncated, true)
    assert.equal(capped.symbols.length, 3)

    const full = scanWorkspace({ cwd, maxFiles: 100 })
    assert.equal(full.stats.filesScanned, 6)
    assert.equal(full.stats.truncated, false)
    assert.equal(full.symbols.length, 6)
})

test('a symlink loop cannot hang the scan and a broken symlink is skipped', () => {
    const cwd = workspace()
    write(cwd, 'pkg/service.go', 'package pkg\n\nfunc Serve() {}\n')
    fs.mkdirSync(path.join(cwd, 'pkg', 'nested'), { recursive: true })
    // pkg/nested/loop -> pkg  (a directory cycle) and a self-referential link.
    fs.symlinkSync(path.join(cwd, 'pkg'), path.join(cwd, 'pkg', 'nested', 'loop'), 'dir')
    fs.symlinkSync(cwd, path.join(cwd, 'pkg', 'nested', 'self'), 'dir')
    // A symlink to a file is fine; a broken one is skipped without throwing.
    fs.symlinkSync(path.join(cwd, 'pkg', 'service.go'), path.join(cwd, 'linked.go'))
    fs.symlinkSync(path.join(cwd, 'missing.go'), path.join(cwd, 'broken.go'))

    const started = Date.now()
    const result = scanWorkspace({ cwd })

    assert.ok(Date.now() - started < 10_000, 'a symlink loop must not hang the scan')
    assert.deepEqual(
        result.symbols.map((symbol) => [symbol.path, symbol.name]),
        [
            ['linked.go', 'Serve'],
            ['pkg/service.go', 'Serve'],
        ],
    )
    // The directory links are skipped, so no path repeats forever.
    assert.equal(result.stats.filesScanned, 3)
})

test('oversized, unreadable and malformed files are skipped, never fatal', () => {
    const cwd = workspace()
    write(cwd, 'ok.go', 'package main\n\nfunc Fine() {}\n')
    write(cwd, 'big.go', `package main\n\nfunc Huge() {}\n\n${'// padding\n'.repeat(40)}`)
    write(cwd, 'denied.go', 'package main\n\nfunc Denied() {}\n')
    // Genuinely invalid UTF-8: `func Broken(` never reaches column 0 once the
    // replacement characters are decoded, and nothing may throw.
    fs.writeFileSync(
        path.join(cwd, 'broken.go'),
        Buffer.concat([Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('func Broken(\n')]),
    )

    const denied = path.join(cwd, 'denied.go')
    fs.chmodSync(denied, 0o000)
    let unreadable = false
    try {
        fs.readFileSync(denied, 'utf8')
    } catch {
        unreadable = true
    }

    const result = scanWorkspace({ cwd, maxFileBytes: 64 })

    assert.ok(symbolNamed(result.symbols, 'Fine'))
    // `big.go` is skipped by stat, before it is ever read into memory.
    assert.equal(symbolNamed(result.symbols, 'Huge'), undefined)
    assert.equal(symbolNamed(result.symbols, 'Broken'), undefined)
    if (unreadable) assert.equal(symbolNamed(result.symbols, 'Denied'), undefined)
    assert.equal(result.stats.truncated, false)

    fs.chmodSync(denied, 0o600)
    assert.ok(scanWorkspace({ cwd, maxFileBytes: 64 }).stats.filesScanned >= 3)
})

test('results are deterministic and sorted by path then line', () => {
    const cwd = workspace()
    write(cwd, 'b/second.go', 'package b\n\nfunc Beta() {}\n\nfunc BetaTwo() {}\n')
    write(cwd, 'a/first.go', 'package a\n\nfunc Alpha() {}\n')
    write(cwd, 'a/readme.md', '# A\n\n## 需求\n\n- 一条足够长的需求描述\n')
    write(cwd, 'a/first_test.go', 'package a\n\nimport "testing"\n\nfunc TestAlpha(t *testing.T) {\n\tt.Run("alpha works", func(t *testing.T) {})\n}\n')

    const first = scanWorkspace({ cwd })
    const second = scanWorkspace({ cwd })
    assert.deepEqual(first, second)

    assert.deepEqual(
        first.symbols.map((symbol) => `${symbol.path}:${symbol.line}`),
        ['a/first.go:3', 'b/second.go:3', 'b/second.go:5'],
    )
    assert.deepEqual(first.tests.map((evidence) => evidence.path), ['a/first_test.go'])
    assert.deepEqual(first.requirements.map((doc) => doc.path), ['a/readme.md'])
})

// --- scanGaps ---------------------------------------------------------------

const GAP_FILES = {
    'internal/report/report.go': [
        'package report',
        '',
        'func buildReport() string { return "" }',
        '',
        'func orphanSymbol() {}',
        '',
        'func mentionedSymbol() {}',
        '',
    ].join('\n'),
    'internal/report/report_test.go': [
        'package report',
        '',
        'import "testing"',
        '',
        'func TestBuildReport(t *testing.T) {',
        '\tt.Run("buildReport handles empty input", func(t *testing.T) {})',
        '}',
        '',
    ].join('\n'),
    'README.md': ['# Report', '', '## 需求', '', '- 报告中的 mentionedSymbol 必须支持自定义格式', ''].join('\n'),
    'go.mod': 'module report\n',
}

function gapFixture(): { scan: ScanResult; spec: SpecRecord; testDesign: TestDesign } {
    const cwd = workspace()
    for (const [rel, text] of Object.entries(GAP_FILES)) write(cwd, rel, text)
    const scan = scanWorkspace({ cwd })
    const spec: SpecRecord = {
        title: 'Report',
        background: '',
        requirements: ['报告可导出'],
        acceptanceCriteria: [
            { id: 'AC-001', text: '导出报告成功' },
            { id: 'AC-002', text: '空输入时给出提示' },
        ],
        fileBoundaries: [],
        negativeConstraints: [],
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
    }
    const testDesign: TestDesign = {
        cases: [
            {
                id: 'TC-001',
                kind: 'positive',
                precondition: '服务已启动',
                steps: '请求 GET /report 并检查响应',
                expected: '返回 200 与报告体',
                covers: ['AC-001'],
            },
            {
                id: 'TC-002',
                kind: 'negative',
                precondition: '服务已启动',
                steps: '',
                expected: '返回 400',
                covers: ['AC-001'],
            },
            {
                id: 'TC-003',
                kind: 'boundary',
                precondition: '空输入',
                steps: 'ab',
                expected: '返回 400',
                covers: ['AC-999'],
            },
        ],
        covered: ['AC-001'],
        uncovered: ['AC-002'],
    }
    return { scan, spec, testDesign }
}

test('scanGaps finds criteria without cases and cases that cover nothing', () => {
    const { scan, spec, testDesign } = gapFixture()
    const report = scanGaps({ scan, spec, testDesign })

    assert.deepEqual(report.criteriaWithoutCases, [{ id: 'AC-002', text: '空输入时给出提示' }])
    assert.deepEqual(report.testsWithoutCriteria, [{ id: 'TC-003', covers: ['AC-999'] }])
    assert.deepEqual(report.missingArtifacts, [])
})

test('scanGaps names the reason a case is too thin to implement', () => {
    const { scan, spec, testDesign } = gapFixture()
    const report = scanGaps({ scan, spec, testDesign })

    assert.deepEqual(report.casesWithThinSteps, [
        { id: 'TC-002', reason: 'steps 为空' },
        { id: 'TC-003', reason: 'steps 仅 2 字符（<4）' },
    ])
    // Both fields are named when both are too thin.
    assert.deepEqual(
        scanGaps({
            scan,
            spec,
            testDesign: {
                cases: [{ id: 'TC-004', kind: 'boundary', precondition: 'p', steps: 'ab', expected: 'no', covers: ['AC-001'] }],
                covered: [],
                uncovered: [],
            },
        }).casesWithThinSteps,
        [{ id: 'TC-004', reason: 'steps 仅 2 字符（<4）；expected 仅 2 字符（<4）' }],
    )

    // A four-character step is enough; only shorter or empty ones are reported.
    const padded: TestDesign = {
        cases: [
            { id: 'TC-010', kind: 'positive', precondition: 'p', steps: '输入配置', expected: '输出配置', covers: ['AC-001'] },
        ],
        covered: [],
        uncovered: [],
    }
    assert.deepEqual(scanGaps({ scan, spec, testDesign: padded }).casesWithThinSteps, [])
})

test('scanGaps reports symbols no test case and no requirement statement mentions', () => {
    const { scan, spec, testDesign } = gapFixture()
    const report = scanGaps({ scan, spec, testDesign })

    // `buildReport` is named by a test case, `mentionedSymbol` by a requirement
    // candidate; `type`/`main` symbols are never reported.
    assert.deepEqual(report.uncoveredSymbols, [
        { name: 'orphanSymbol', path: 'internal/report/report.go', line: 5, kind: 'func' },
    ])
})

test('scanGaps caps uncoveredSymbols at 100 and ignores type/main kinds', () => {
    const { scan } = gapFixture()
    const symbols: CodeSymbol[] = [
        { path: 'gen.go', line: 1, kind: 'main', name: 'main', detail: 'entrypoint' },
        { path: 'gen.go', line: 2, kind: 'type', name: 'Report', detail: 'struct' },
        ...Array.from({ length: 150 }, (_, index) => ({
            path: 'gen.go',
            line: index + 3,
            kind: 'func' as const,
            name: `symbol${index}`,
            detail: 'unexported',
        })),
    ]
    const report = scanGaps({ scan: { ...scan, symbols } })

    assert.equal(report.uncoveredSymbols.length, 100)
    assert.equal(report.uncoveredSymbols[0]?.name, 'symbol0')
    assert.equal(report.uncoveredSymbols[99]?.name, 'symbol99')
    assert.equal(report.uncoveredSymbols.some((symbol) => symbol.kind === 'type'), false)
    assert.equal(report.uncoveredSymbols.some((symbol) => symbol.kind === 'main'), false)
})

test('scanGaps survives malformed mission artifacts', () => {
    const { scan, spec, testDesign } = gapFixture()
    const report = scanGaps({
        scan,
        spec: { ...spec, acceptanceCriteria: undefined } as unknown as SpecRecord,
        testDesign: { ...testDesign, cases: 'nope' } as unknown as TestDesign,
    })

    assert.deepEqual(report.criteriaWithoutCases, [])
    assert.deepEqual(report.casesWithThinSteps, [])
    assert.deepEqual(report.testsWithoutCriteria, [])
    assert.deepEqual(report.missingArtifacts, ['testDesign'])
})

test('scanGaps reports the missing artifacts it can prove', () => {
    const { scan, spec, testDesign } = gapFixture()

    // Nothing is missing when the scan found gate commands and both artifacts exist.
    assert.deepEqual(scanGaps({ scan, spec, testDesign }).missingArtifacts, [])

    const noSpec = scanGaps({ scan, testDesign })
    assert.deepEqual(noSpec.missingArtifacts, ['spec'])
    assert.deepEqual(
        noSpec.criteriaWithoutCases,
        [],
        'without a specification no criterion can be compared',
    )
    assert.deepEqual(
        noSpec.testsWithoutCriteria,
        [],
        'with no specification there is nothing to be "uncovered" — the missing spec is reported on its own, and listing every legacy case would bury the real gaps',
    )

    const noDesign = scanGaps({ scan, spec })
    assert.deepEqual(noDesign.missingArtifacts, ['testDesign'])
    assert.deepEqual(noDesign.criteriaWithoutCases.map((entry) => entry.id), ['AC-001', 'AC-002'])
    assert.deepEqual(scanGaps({ scan, spec, testDesign: { cases: [], covered: [], uncovered: [] } }).missingArtifacts, ['testDesign'])

    const commandless: ScanResult = { ...scan, suggestedCommands: [] }
    assert.deepEqual(scanGaps({ scan: commandless, spec, testDesign }).missingArtifacts, ['gateCommands'])

    // A configured quality gate satisfies the gateCommands requirement.
    const cwd = workspace()
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'quality-gate.json'), '{ "commands": [] }\n')
    const configured: ScanResult = { ...commandless, cwd }
    assert.deepEqual(scanGaps({ scan: configured, spec, testDesign }).missingArtifacts, [])
})

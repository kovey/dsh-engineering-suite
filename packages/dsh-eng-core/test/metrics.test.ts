/**
 * dsh-eng-core metrics tests.
 *
 * Every fixture is built in a fresh temp directory (nothing is committed to the
 * repository), and every number asserted here is derived from the fixture text
 * by hand — the point of a metrics module is the exact number, so a test that
 * reads the expectation back out of the implementation would prove nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compareToBaseline, measureWorkspace, parseBaseline } from '../dist/index.js'
import type { FileMetrics, MetricsResult, StandardsConfig, Violation } from '../dist/index.js'

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-metrics-'))
}

function write(root: string, rel: string, text: string): string {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
}

function fileNamed(result: MetricsResult, rel: string): FileMetrics {
    const found = result.files.find((file) => file.path === rel)
    assert.ok(found !== undefined, `expected ${rel} in ${result.files.map((file) => file.path).join(', ')}`)
    return found
}

function violationWith(result: MetricsResult, rule: Violation['rule'], label: string): Violation | undefined {
    return result.violations.find((violation) => violation.rule === rule && violation.key.endsWith(`|${label}`))
}

/** The Go fixture of the size-and-nesting test, padded to exactly `total` lines. */
function goFixture(total: number): string {
    const body = [
        'package sample',
        '',
        'import "fmt"',
        '',
        '// Crawl walks a sample.',
        'func (s *Sample) Crawl(a int, b string, c bool, d float64, e []byte) {',
        '\tif a > 0 {',
        '\t\tfor i := 0; i < a; i++ {',
        '\t\t\tif b != "" {',
        '\t\t\t\tfmt.Println(b)',
        '\t\t\t}',
        '\t\t}',
        '\t} else {',
        '\t\tfmt.Println("none")',
        '\t}',
        '\tif a > 1 {',
        '\t\tfmt.Println(a)',
        '\t\tfmt.Println(a)',
        '\t\tfmt.Println(a)',
        '\t}',
        '}',
        '',
        'type Sample struct {',
        '\tName string',
        '}',
        '',
        'func small(x int) int {',
        '\treturn x',
        '}',
    ]
    const lines = [...body]
    while (lines.length < total) lines.push('// filler')
    return `${lines.slice(0, total).join('\n')}\n`
}

const GO_STANDARDS: StandardsConfig = {
    languages: {
        go: { maxFileLines: 400, maxFunctionLines: 15, maxDepth: 3, maxIfBlockLines: 4, maxParams: 4, maxExports: 1 },
    },
}

test('Go: file, function, nesting, if-block, parameter and export violations carry exact numbers', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n\ngo 1.22\n')
    write(root, 'internal/sample/crawler.go', goFixture(420))
    const result = measureWorkspace({ cwd: root, standards: GO_STANDARDS })

    const file = fileNamed(result, 'internal/sample/crawler.go')
    assert.equal(file.language, 'go')
    assert.equal(file.lines, 420)
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.depth, fn.params]),
        [
            ['Sample.Crawl', 6, 16, 4, 5],
            ['small', 27, 3, 1, 1],
        ],
    )
    assert.equal(file.maxDepth, 4)
    assert.deepEqual(file.ifBlocks, [
        { line: 7, lines: 7, kind: 'if' },
        { line: 9, lines: 3, kind: 'if' },
        { line: 13, lines: 3, kind: 'else' },
        { line: 16, lines: 5, kind: 'if' },
    ])
    assert.equal(file.exports, 2)
    assert.deepEqual(file.imports, [])

    const byRule = (rule: Violation['rule']): Violation[] => result.violations.filter((violation) => violation.rule === rule)
    const fileLines = byRule('maxFileLines')
    assert.equal(fileLines.length, 1)
    assert.equal(fileLines[0]?.actual, 420)
    assert.equal(fileLines[0]?.limit, 400)
    assert.equal(fileLines[0]?.key, 'maxFileLines|internal/sample/crawler.go|(file)')
    assert.match(fileLines[0]?.detail ?? '', /420 行（上限 400）/)

    const functionLines = byRule('maxFunctionLines')
    assert.equal(functionLines.length, 1)
    assert.equal(functionLines[0]?.actual, 16)
    assert.equal(functionLines[0]?.line, 6)
    assert.equal(functionLines[0]?.key, 'maxFunctionLines|internal/sample/crawler.go|Sample.Crawl')

    const depth = byRule('maxDepth')
    assert.equal(depth.length, 1)
    assert.equal(depth[0]?.actual, 4)
    assert.equal(depth[0]?.line, 9)
    assert.equal(depth[0]?.key, 'maxDepth|internal/sample/crawler.go|Sample.Crawl')
    assert.match(depth[0]?.detail ?? '', /嵌套深度 4（上限 3，位于函数 Sample.Crawl）/)

    const blocks = byRule('maxIfBlockLines')
    assert.deepEqual(blocks.map((violation) => [violation.line, violation.actual, violation.key]), [
        [7, 7, 'maxIfBlockLines|internal/sample/crawler.go|Sample.Crawl'],
        // Two over-long blocks in ONE function: the second key carries its line,
        // so the baseline ratchet can never accept a block it never saw.
        [16, 5, 'maxIfBlockLines|internal/sample/crawler.go|Sample.Crawl#L16'],
    ])

    const params = byRule('maxParams')
    assert.equal(params.length, 1)
    assert.equal(params[0]?.actual, 5)
    assert.equal(params[0]?.line, 6)

    const exports = byRule('maxExports')
    assert.equal(exports.length, 1)
    assert.equal(exports[0]?.actual, 2)
    assert.equal(exports[0]?.key, 'maxExports|internal/sample/crawler.go|(file)')

    // Violations are sorted by key, and every key is distinct.
    const keys = result.violations.map((violation) => violation.key)
    assert.deepEqual(keys, [...keys].sort())
    assert.equal(new Set(keys).size, keys.length)
})

test('Go: comments and strings never contribute structure or symbols', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(
        root,
        'a.go',
        [
            'package demo',
            '',
            '// func Commented() { if x { } }',
            '/*',
            'func AlsoCommented() {}',
            '*/',
            'const banner = "func InString() {"',
            '',
            'func real() {}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {} } } })
    const file = fileNamed(result, 'a.go')
    assert.deepEqual(file.functions.map((fn) => fn.name), ['real'])
    assert.deepEqual(file.ifBlocks, [])
    assert.equal(file.maxDepth, 1)
    assert.equal(file.exports, 0)
})

test('TS: arrow functions, class methods and named exports', () => {
    const root = workspace()
    write(root, 'src/helper.ts', 'export const helper = 1\n')
    write(
        root,
        'src/store.ts',
        [
            "import { helper } from './helper'",
            '',
            '/** doc */',
            'export const makeAdder = (base: number, step: number): (x: number) => number => {',
            '    return (x: number) => base + step + x',
            '}',
            '',
            'export const double = (value: number) => value * 2',
            '',
            'export function twice(value: number): number {',
            '    if (value > 0) {',
            '        return value * 2',
            '    } else {',
            '        return 0',
            '    }',
            '}',
            '',
            'class Store {',
            '    constructor(private readonly name: string) {}',
            '    get label(): string { return this.name }',
            '    reset = (): void => { this.name }',
            '}',
            '',
            'export { makeAdder as mk }',
            'export default Store',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    const file = fileNamed(result, 'src/store.ts')
    assert.equal(file.language, 'ts')
    assert.deepEqual(file.functions, [
        { name: 'makeAdder', line: 4, lines: 3, depth: 1, params: 2 },
        { name: 'double', line: 8, lines: 1, depth: 1, params: 1 },
        { name: 'twice', line: 10, lines: 7, depth: 2, params: 1 },
        { name: 'Store.constructor', line: 19, lines: 1, depth: 1, params: 1 },
        { name: 'Store.label', line: 20, lines: 1, depth: 1, params: 0 },
        { name: 'Store.reset', line: 21, lines: 1, depth: 1, params: 0 },
    ])
    assert.deepEqual(file.ifBlocks, [
        { line: 11, lines: 3, kind: 'if' },
        { line: 13, lines: 3, kind: 'else' },
    ])
    // `export const` ×2, `export function`, `export { … }`, `export default` = 5.
    assert.equal(file.exports, 5)
    assert.deepEqual(file.imports, ['src/helper.ts'])

    const limits: StandardsConfig = { languages: { ts: { maxFunctionLines: 1, maxParams: 1, maxExports: 4 } } }
    const checked = measureWorkspace({ cwd: root, standards: limits })
    assert.deepEqual(
        checked.violations.map((violation) => violation.key),
        [
            'maxExports|src/store.ts|(file)',
            'maxFunctionLines|src/store.ts|makeAdder',
            'maxFunctionLines|src/store.ts|twice',
            'maxParams|src/store.ts|makeAdder',
        ].sort(),
    )
})

test('TS: a regex literal containing quotes does not swallow the rest of the file', () => {
    const root = workspace()
    // `/['"]/` used to open a "string" that ran to the next quote in the file,
    // which silently blanked every symbol after it.
    write(
        root,
        'src/quote.ts',
        [
            'const QUOTED = /[\'"]/',
            'const SLASH = 4 / 2',
            '',
            'export function afterRegex(value: string): boolean {',
            '    if (QUOTED.test(value)) {',
            '        return true',
            '    }',
            '    return SLASH > 1',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    const file = fileNamed(result, 'src/quote.ts')
    assert.deepEqual(file.functions, [{ name: 'afterRegex', line: 4, lines: 6, depth: 2, params: 1 }])
    assert.deepEqual(file.ifBlocks, [{ line: 5, lines: 3, kind: 'if' }])
    assert.equal(file.exports, 1)
})

test('Python: indentation-based functions, nesting and if/else blocks', () => {
    const root = workspace()
    write(root, 'pkg/__init__.py', '')
    write(root, 'pkg/util.py', 'def helper():\n    pass\n')
    write(
        root,
        'pkg/service.py',
        [
            '"""Docstring with if x: inside."""',
            'from .util import helper',
            '',
            '__all__ = ["Service"]',
            '',
            'class Service:',
            '    def handle(self, event, retries=3):',
            '        if event:',
            '            if retries:',
            '                return 1',
            '        else:',
            '            return 0',
            '',
            'def run():',
            '    if True:',
            '        return 1',
            '',
            'def _hidden():',
            '    pass',
            '',
        ].join('\n'),
    )
    const standards: StandardsConfig = { languages: { python: { maxDepth: 2, maxIfBlockLines: 2, maxParams: 2 } } }
    const result = measureWorkspace({ cwd: root, standards })
    const file = fileNamed(result, 'pkg/service.py')
    assert.equal(file.language, 'python')
    assert.deepEqual(file.functions, [
        { name: 'Service.handle', line: 7, lines: 6, depth: 3, params: 3 },
        { name: 'run', line: 14, lines: 3, depth: 2, params: 0 },
        { name: '_hidden', line: 18, lines: 2, depth: 1, params: 0 },
    ])
    assert.deepEqual(file.ifBlocks, [
        { line: 8, lines: 3, kind: 'if' },
        { line: 9, lines: 2, kind: 'if' },
        { line: 11, lines: 2, kind: 'else' },
        { line: 15, lines: 2, kind: 'if' },
    ])
    // `__all__` (1 entry) + the public top-level class and function = 3.
    assert.equal(file.exports, 3)
    assert.deepEqual(file.imports, ['pkg/util.py'])
    assert.equal(file.maxDepth, 4)

    assert.equal(violationWith(result, 'maxDepth', 'Service.handle')?.actual, 4)
    assert.equal(violationWith(result, 'maxDepth', 'Service.handle')?.line, 10)
    assert.equal(violationWith(result, 'maxIfBlockLines', 'Service.handle')?.actual, 3)
    assert.equal(violationWith(result, 'maxParams', 'Service.handle')?.actual, 3)
    // A one-line `if x: return 1` has no block and is therefore not measured.
    assert.match(fileNamed(result, 'pkg/__init__.py').path, /__init__/)
})

test('exempt patterns skip test files and testdata, and produce no violations', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(root, 'internal/a/a.go', 'package a\n\nfunc A() {}\n')
    write(root, 'internal/a/a_test.go', 'package a\n\nfunc TestA(t *testing.T) {\n\tif true {\n\t}\n}\n')
    write(root, 'internal/a/testdata/gen/data.go', 'package gen\n\nfunc Generated() {}\n')
    write(root, 'src/tool.gen.ts', 'export const generated = () => 1\n')
    write(root, 'root.gen.go', 'package demo\n\nfunc Root() {}\n')
    const standards: StandardsConfig = {
        languages: { default: { maxFileLines: 2, maxFunctionLines: 1, maxDepth: 0, maxExports: 0 } },
        exempt: ['**/*_test.go', '**/testdata/**', '**/*.gen.ts', '*.gen.go'],
    }
    const result = measureWorkspace({ cwd: root, standards })

    assert.equal(result.stats.exempted, 4)
    const exempted = result.files.filter((file) => file.functions.length === 0 && file.ifBlocks.length === 0)
    assert.deepEqual(
        exempted.map((file) => file.path).sort(),
        ['internal/a/a_test.go', 'internal/a/testdata/gen/data.go', 'root.gen.go', 'src/tool.gen.ts'],
    )
    // The exempt files keep their line count (a report should still show the
    // size) but contribute no functions, no imports and no violations.
    assert.ok(result.files.every((file) => file.lines > 0))
    assert.ok(result.violations.every((violation) => !violation.path.includes('_test.go')))
    assert.ok(result.violations.every((violation) => !violation.path.includes('testdata')))
    assert.ok(result.violations.every((violation) => !violation.path.endsWith('.gen.ts') && !violation.path.endsWith('.gen.go')))
    assert.deepEqual(
        result.violations.map((violation) => [violation.path, violation.rule]),
        [
            ['internal/a/a.go', 'maxDepth'],
            ['internal/a/a.go', 'maxExports'],
            ['internal/a/a.go', 'maxFileLines'],
        ],
    )

    // A pattern without `**` must match the WHOLE path: `*.gen.ts` covers a
    // root-level file, not `src/tool.gen.ts`.
    const narrow: StandardsConfig = { languages: { default: {} }, exempt: ['*.gen.ts'] }
    const narrowResult = measureWorkspace({ cwd: root, standards: narrow })
    assert.equal(narrowResult.stats.exempted, 0)
})

test('layers: an offending import is reported, an allowed one is not', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(root, 'internal/domain/value.go', 'package domain\n\nimport (\n\t"example.com/demo/internal/domain"\n)\n')
    write(root, 'internal/infra/db.go', 'package infra\n')
    write(root, 'internal/domain/bad.go', 'package domain\n\nimport (\n\t"example.com/demo/internal/infra"\n)\n')
    write(
        root,
        'internal/app/app.go',
        'package app\n\nimport (\n\t"example.com/demo/internal/domain"\n\t"example.com/demo/internal/infra"\n)\n',
    )
    const standards: StandardsConfig = {
        languages: { go: {} },
        layers: [
            { path: 'internal/domain', mayImport: [] },
            { path: 'internal/app', mayImport: ['internal/domain', 'internal/app'] },
        ],
    }
    const result = measureWorkspace({ cwd: root, standards })
    // `internal/domain/value.go` imports its own layer: allowed.
    assert.deepEqual(fileNamed(result, 'internal/domain/value.go').imports, ['internal/domain'])
    // `internal/app` may import `internal/domain` (allowed) but not `internal/infra`.
    assert.deepEqual(fileNamed(result, 'internal/app/app.go').imports, ['internal/domain', 'internal/infra'])
    const layers = result.violations.filter((violation) => violation.rule === 'layer')
    assert.deepEqual(
        layers.map((violation) => [violation.key, violation.line, violation.actual, violation.limit]),
        [
            ['layer|internal/app/app.go|internal/infra', 5, 1, 0],
            ['layer|internal/domain/bad.go|internal/infra', 4, 1, 0],
        ],
    )
    assert.ok(!layers.some((violation) => violation.key.endsWith('|internal/domain')), 'an allowed import is not a violation')
    assert.match(layers[1]?.detail ?? '', /从层级 internal\/domain 越界导入 internal\/infra/)
})

test('cycles: a two-file cycle is normalised, deduplicated and switchable', () => {
    const root = workspace()
    write(root, 'src/b.ts', "import { a } from './a'\nexport const b = a\n")
    write(root, 'src/a.ts', "import { b } from './b'\nexport const a = b\n")
    write(root, 'src/solo.ts', "import { a } from './a'\nexport const solo = a\n")
    const on: StandardsConfig = { languages: { ts: {} }, forbidCycles: true }
    const result = measureWorkspace({ cwd: root, standards: on })
    // Normalised: the lexicographically smallest path first, one entry per cycle.
    assert.deepEqual(result.cycles, [['src/a.ts', 'src/b.ts']])
    const cycles = result.violations.filter((violation) => violation.rule === 'cycle')
    assert.equal(cycles.length, 1)
    assert.equal(cycles[0]?.path, 'src/a.ts')
    assert.equal(cycles[0]?.key, 'cycle|src/a.ts|src/a.ts -> src/b.ts')
    assert.equal(cycles[0]?.actual, 2)
    assert.equal(cycles[0]?.limit, 0)
    assert.equal(cycles[0]?.line, 1)

    const off = measureWorkspace({ cwd: root, standards: { languages: { ts: {} }, forbidCycles: false } })
    assert.deepEqual(off.cycles, [])
    assert.equal(off.violations.filter((violation) => violation.rule === 'cycle').length, 0)
})

test('rules resolve per language, with `default` as the fallback only', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(root, 'a.go', 'package demo\n\nfunc A() {\n\tif true {\n\t}\n}\n')
    write(root, 'b.py', 'def b():\n    if True:\n        pass\n    return None\n')

    const fallback: StandardsConfig = { languages: { default: { maxFileLines: 3, maxDepth: 1 } } }
    const both = measureWorkspace({ cwd: root, standards: fallback })
    assert.deepEqual(
        both.violations.map((violation) => violation.key).sort(),
        [
            'maxDepth|a.go|A',
            'maxDepth|b.py|b',
            'maxFileLines|a.go|(file)',
            'maxFileLines|b.py|(file)',
        ],
    )

    // A language entry replaces `default` wholesale: nothing is merged in, so
    // the generous Go rule leaves the file alone while Python still fails.
    const perLanguage: StandardsConfig = {
        languages: { default: { maxFileLines: 3, maxDepth: 1 }, go: { maxFileLines: 100, maxDepth: 10 } },
    }
    const mixed = measureWorkspace({ cwd: root, standards: perLanguage })
    assert.deepEqual(
        mixed.violations.map((violation) => violation.key).sort(),
        ['maxDepth|b.py|b', 'maxFileLines|b.py|(file)'],
    )

    // No rule set for a language and no `default`: the file is measured but gated by nothing.
    const none = measureWorkspace({ cwd: root, standards: { languages: {} } })
    assert.deepEqual(none.violations, [])
    assert.equal(none.files.length, 2)
})

test('measurement is deterministic and bounded by maxFiles', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    for (let index = 0; index < 6; index += 1) {
        write(root, `pkg${index}/file.go`, `package pkg${index}\n\nfunc F${index}(a, b int) int {\n\tif a > b {\n\t\treturn a\n\t}\n\treturn b\n}\n`)
    }
    const standards: StandardsConfig = { languages: { go: { maxParams: 1 } } }
    const first = measureWorkspace({ cwd: root, standards })
    const second = measureWorkspace({ cwd: root, standards })
    assert.deepEqual(first, second)
    assert.equal(first.stats.filesScanned, 7)
    assert.equal(first.stats.truncated, false)
    assert.deepEqual(first.stats.languages, { go: 6 })

    const bounded = measureWorkspace({ cwd: root, standards, maxFiles: 3 })
    assert.equal(bounded.stats.filesScanned, 3)
    assert.equal(bounded.stats.truncated, true)
    assert.ok(bounded.files.length <= 3)
})

test('malformed and oversized files are skipped, never thrown', () => {
    const root = workspace()
    write(root, 'broken.go', 'package demo\n\nfunc broken( {{{ \n\tif x {\n')
    write(root, 'unbalanced.py', 'def f(:\n    if True\n        pass\n')
    write(root, 'ok.go', 'package demo\n\nfunc Ok() {}\n')
    const bomb = `package demo\n\n// ${'x'.repeat(5000)}\nfunc Bomb() {}\n`
    write(root, 'bomb.go', bomb)

    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {}, python: {} } }, maxFileBytes: 1024 })
    assert.equal(result.stats.filesScanned, 4)
    const paths = result.files.map((file) => file.path)
    assert.ok(!paths.includes('bomb.go'), 'the oversized file must not be measured')
    assert.deepEqual(paths, ['broken.go', 'ok.go', 'unbalanced.py'])
    // The malformed Go file still reports what it could read, without a body.
    assert.deepEqual(fileNamed(result, 'broken.go').functions, [])
    // The malformed Python file degrades to no functions rather than throwing.
    assert.deepEqual(fileNamed(result, 'unbalanced.py').functions, [])
    assert.deepEqual(fileNamed(result, 'ok.go').functions.map((fn) => fn.name), ['Ok'])
})

test('parseBaseline accepts a frozen baseline and rejects a malformed one', () => {
    const parsed = parseBaseline(
        JSON.stringify({
            version: 1,
            frozenAt: '2026-01-01T00:00:00.000Z',
            note: '接入时接受的历史违规',
            accepted: ['maxFileLines|a.go|(file)', 'maxFileLines|a.go|(file)', 'maxDepth|b.go|B'],
        }),
    )
    assert.deepEqual(parsed, {
        version: 1,
        frozenAt: '2026-01-01T00:00:00.000Z',
        note: '接入时接受的历史违规',
        accepted: ['maxFileLines|a.go|(file)', 'maxDepth|b.go|B'],
    })
    assert.equal(parseBaseline('not json'), undefined)
    assert.equal(parseBaseline('{"version":2,"frozenAt":"x","accepted":[]}'), undefined)
    assert.equal(parseBaseline('{"version":1,"accepted":[]}'), undefined)
    assert.equal(parseBaseline('[]'), undefined)
})

test('compareToBaseline splits added, known and fixed', () => {
    const violations: Violation[] = [
        { rule: 'maxFileLines', path: 'a.go', line: 1, key: 'maxFileLines|a.go|(file)', actual: 500, limit: 400, detail: 'a.go 有 500 行（上限 400）' },
        { rule: 'maxParams', path: 'b.go', line: 9, key: 'maxParams|b.go|F', actual: 6, limit: 4, detail: 'b.go:9 函数 F 有 6 个参数（上限 4）' },
    ]
    const baseline = { version: 1 as const, frozenAt: '2026-01-01T00:00:00.000Z', accepted: ['maxParams|b.go|F', 'maxDepth|gone.go|G'] }
    const compared = compareToBaseline(violations, baseline)
    assert.deepEqual(compared.added.map((violation) => violation.key), ['maxFileLines|a.go|(file)'])
    assert.deepEqual(compared.known.map((violation) => violation.key), ['maxParams|b.go|F'])
    assert.deepEqual(compared.fixed, ['maxDepth|gone.go|G'])

    const noBaseline = compareToBaseline(violations, undefined)
    assert.equal(noBaseline.added.length, 2)
    assert.deepEqual(noBaseline.known, [])
    assert.deepEqual(noBaseline.fixed, [])
})

test('a workspace without go.mod resolves no Go import, and non-code files are not measured', () => {
    const root = workspace()
    write(root, 'docs/readme.md', '# hi\n')
    write(root, 'main.go', 'package main\n\nimport "example.com/demo/internal/x"\n\nfunc main() {}\n')
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {} } } })
    assert.deepEqual(result.files.map((file) => file.path), ['main.go'])
    assert.deepEqual(fileNamed(result, 'main.go').imports, [])
    assert.equal(result.stats.filesScanned, 2)
})

// --- regressions: the adversarial audit of this module ----------------------
//
// Every test below FAILS on the code as it was merged, and each fixture states
// the exact number its text implies — no expectation is read back out of the
// implementation.

test('if blocks: a brace-less one-liner never adopts the next unrelated block', () => {
    const root = workspace()
    write(
        root,
        'src/check.ts',
        [
            'export function check(resolved: { enabled: boolean }, items: number[]): number {',
            '    if (!resolved.enabled) return 0',
            '    const total = items.length',
            '    if (total > 0) {',
            '        for (const item of items) {',
            '            if (item > 10) {',
            '                return item',
            '            }',
            '        }',
            '    }',
            '    return total',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: { maxIfBlockLines: 5 } } } })
    const file = fileNamed(result, 'src/check.ts')
    // `if (!resolved.enabled) return 0` is a one-liner with no block at all: the
    // only blocks in the file are the two below it. (It used to adopt the `{` of
    // `if (total > 0)` and report a 9-line block for a one-liner.)
    assert.deepEqual(file.ifBlocks, [
        { line: 4, lines: 7, kind: 'if' },
        { line: 6, lines: 3, kind: 'if' },
    ])
    assert.deepEqual(
        result.violations.map((violation) => [violation.rule, violation.line, violation.actual, violation.limit]),
        [['maxIfBlockLines', 4, 7, 5]],
    )
})

test('if blocks: object keys and labels named `if` are not statements', () => {
    const root = workspace()
    write(
        root,
        'src/rules.ts',
        [
            'export const rules = {',
            '    if: { then: 1 },',
            '    else: 2,',
            '}',
            '',
            'export const when = rules.if',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: { maxIfBlockLines: 0 } } } })
    // `if: { then: 1 }` is a property whose value is an object, not a block: a
    // scanner that only looked for the next `{` would report one.
    assert.deepEqual(fileNamed(result, 'src/rules.ts').ifBlocks, [])
    assert.deepEqual(result.violations, [])
})

test('if blocks: a Go header may start with any character and the `{` may sit far away', () => {
    const padding = 'p'.repeat(400)
    const longHeader = `\tif err := apply(names, "${padding}"); err != nil {`
    // The old scanner gave up 300 characters after the `if` and only accepted a
    // condition starting with a name/`(`/`[`/`!`, so `*flag`, `&x`, `1 < 2` and
    // any header with a long call in it were invisible.
    assert.ok(longHeader.indexOf('{') > 300, 'the fixture must place the block opener beyond the old window')
    const root = workspace()
    write(
        root,
        'run.go',
        [
            'package demo',
            '',
            'func run(verbose *bool, limit int, count int, names []string) int {',
            '\tif *verbose {',
            '\t\treturn 1',
            '\t}',
            '\tif &limit != nil {',
            '\t\treturn 2',
            '\t}',
            '\tif 1 < 2 {',
            '\t\treturn 3',
            '\t}',
            longHeader,
            '\t\treturn 4',
            '\t}',
            '\treturn 0',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {} } } })
    assert.deepEqual(fileNamed(result, 'run.go').ifBlocks, [
        { line: 4, lines: 3, kind: 'if' },
        { line: 7, lines: 3, kind: 'if' },
        { line: 10, lines: 3, kind: 'if' },
        { line: 13, lines: 3, kind: 'if' },
    ])
})

test('if blocks: a Go composite literal in the init is not the block, a wrapped condition is', () => {
    const root = workspace()
    write(
        root,
        'check.go',
        [
            'package demo',
            '',
            'func check(args []any, sleeps []int, want []int) bool {',
            '\tif got := []any{"a", 1}; !reflect.DeepEqual(args, got) {',
            '\t\treturn false',
            '\t}',
            '\tif len(sleeps) != len(want) && sleeps[0] > 0 &&',
            '\t\twant[0] > 0 {',
            '\t\treturn true',
            '\t}',
            '\treturn false',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {} } } })
    // `[]any{"a", 1}` is a literal in the init statement: the block starts at
    // the `{` after the `;`, and the wrapped condition counts its own line.
    assert.deepEqual(fileNamed(result, 'check.go').ifBlocks, [
        { line: 4, lines: 3, kind: 'if' },
        { line: 7, lines: 4, kind: 'if' },
    ])
})

test('Go exports: names separated from their type, several names per spec, grouped declarations', () => {
    const root = workspace()
    write(
        root,
        'exports.go',
        [
            'package demo',
            '',
            'var FS embed.FS',
            'var local, Exported = 1, 2',
            'const Typed uint64 = 1',
            'const private = 2',
            '',
            'var (',
            '\t// Grouped values: the comment and a continuation line are not specs.',
            '\tAlpha, Beta = 1, 2',
            '\tGamma string',
            '\thidden = 3',
            '\tDelta = map[string]int{',
            '\t\t"Key": 1,',
            '\t}',
            '\tEta = compute(',
            '\t\tValue,',
            '\t)',
            ')',
            '',
            'const (',
            '\tEpsilon = 1',
            '\tZeta    = 2',
            ')',
            '',
            'type Widget struct {',
            '\tName string',
            '}',
            '',
            'type hiddenType int',
            '',
            'func Exported() {}',
            'func hidden() {}',
            'func (w Widget) Method() {}',
            'func (w Widget) method() {}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {} } } })
    // FS + Exported + Typed (3), Alpha/Beta/Gamma/Delta/Eta (5), Epsilon/Zeta (2),
    // Widget (1), Exported (1), Method (1). `Value,` is an argument of `compute`,
    // not a declaration, and the comment is not a line to count.
    assert.equal(fileNamed(result, 'exports.go').exports, 13)
})

test('TS: generic functions are counted, with their type parameters left out of `params`', () => {
    const root = workspace()
    write(
        root,
        'src/generic.ts',
        [
            'export function identity<T>(value: T): T {',
            '    return value',
            '}',
            '',
            'export const pick = <T,>(items: T[], index: number): T | undefined => items[index]',
            '',
            'export const tuple = <A, B>(first: A, second: B): [A, B] => [first, second]',
            '',
            'class Box {',
            '    map<U>(fn: (value: number) => U): U {',
            '        return fn(1)',
            '    }',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    assert.deepEqual(fileNamed(result, 'src/generic.ts').functions, [
        // Type parameters are not value parameters: `identity` takes one, `pick` two.
        { name: 'identity', line: 1, lines: 3, depth: 1, params: 1 },
        { name: 'pick', line: 5, lines: 1, depth: 1, params: 2 },
        { name: 'tuple', line: 7, lines: 1, depth: 1, params: 2 },
        { name: 'Box.map', line: 10, lines: 3, depth: 1, params: 1 },
    ])
})

test('TS: a parenthesised arrow behind a cast keeps its own parameters and span', () => {
    const root = workspace()
    write(
        root,
        'src/logger.ts',
        [
            'type Logger = (level: string, ...args: unknown[]) => void',
            '',
            'export function make(): Logger {',
            '    const logger = ((level: string, ...args: unknown[]) => write(level, args)) as Logger',
            '    const handler = (event: string) => event',
            '    const listener = (handlers[0] ?? []) as unknown as (a: unknown, b: unknown) => void',
            '    return logger',
            '}',
            '',
            'function write(level: string, args: unknown[]): void {}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    const functions = fileNamed(result, 'src/logger.ts').functions
    assert.deepEqual(
        functions.map((fn) => [fn.name, fn.line, fn.lines, fn.params]),
        [
            // Two declared parameters and ONE line: the arrow is on line 4, and
            // line 5 is an unrelated statement (it used to be the span's end).
            ['make', 3, 6, 0],
            ['logger', 4, 1, 2],
            ['handler', 5, 1, 1],
            ['write', 10, 1, 2],
        ],
    )
    // `listener` is a call result cast to a function type, not a function: no record.
    assert.ok(!functions.some((fn) => fn.name === 'listener'))
})

test('TS exports: `export {}` counts zero, every other form counts its own names', () => {
    const root = workspace()
    write(root, 'src/other.ts', 'export const three = 3\nexport const four = 4\nexport const five = 5\n')
    write(
        root,
        'src/api.ts',
        [
            "import { three } from './other'",
            '',
            'export const one = 1, two = 2',
            'export { three, four }',
            'export {}',
            "export * from './other'",
            "export { five as alias } from './other'",
            'export default function main(): void {}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    // `one`+`two`, `three`+`four`, nothing for `export {}`, `export *`, the
    // re-exported alias and the default function = 7.
    assert.equal(fileNamed(result, 'src/api.ts').exports, 7)
})

test('TS: a division is not a regex literal, even when a `/` follows later on the line', () => {
    const root = workspace()
    write(
        root,
        'src/rate.ts',
        [
            'export const rate = bytes / seconds; const unit = "km/h"',
            '',
            'export function keep(value: number): number {',
            '    return value',
            '}',
            '',
        ].join('\n'),
    )
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    const file = fileNamed(result, 'src/rate.ts')
    // With "every `/` is a regex" the `/` after `bytes` would close on the `/`
    // inside "km/h", blank the rest of the line and swallow the whole file.
    assert.deepEqual(file.functions, [{ name: 'keep', line: 3, lines: 3, depth: 1, params: 1 }])
    assert.equal(file.exports, 2)
})

test('parameters: a trailing comma is not an extra parameter (Go and TS)', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(
        root,
        'wide.go',
        ['package demo', '', 'func Wide(', '\ta int,', '\tb string,', ') {', '}', ''].join('\n'),
    )
    write(root, 'src/wide.ts', ['export const pair = (first: number, second: number,) => first + second', ''].join('\n'))
    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {}, ts: {} } } })
    assert.deepEqual(fileNamed(result, 'wide.go').functions, [{ name: 'Wide', line: 3, lines: 5, depth: 1, params: 2 }])
    assert.deepEqual(fileNamed(result, 'src/wide.ts').functions, [{ name: 'pair', line: 1, lines: 1, depth: 1, params: 2 }])
})

test('Python: nesting follows the file own indent step (2 spaces, and tabs)', () => {
    const root = workspace()
    write(root, 'two.py', ['def outer():', '  if a:', '    if b:', '      return 1', '  return 0', ''].join('\n'))
    write(root, 'tabs.py', ['def outer():', '\tif a:', '\t\treturn 1', '\treturn 0', ''].join('\n'))
    const result = measureWorkspace({ cwd: root, standards: { languages: { python: {} } } })
    // A step of 2: depths 0/1/2/3, so the deepest line is 3 levels in and the
    // function's own body holds 3 — a hard-coded step of 4 would say 1.
    assert.deepEqual(fileNamed(result, 'two.py').functions, [{ name: 'outer', line: 1, lines: 5, depth: 3, params: 0 }])
    assert.deepEqual(fileNamed(result, 'two.py').ifBlocks, [
        { line: 2, lines: 3, kind: 'if' },
        { line: 3, lines: 2, kind: 'if' },
    ])
    assert.equal(fileNamed(result, 'two.py').maxDepth, 3)
    // Tabs count as one step of 4 each: depths 0/1/2.
    assert.deepEqual(fileNamed(result, 'tabs.py').functions, [{ name: 'outer', line: 1, lines: 4, depth: 2, params: 0 }])
    assert.equal(fileNamed(result, 'tabs.py').maxDepth, 2)
})

test('scan: build-output names are ignored at the workspace root only', () => {
    const root = workspace()
    const go = (name: string): string => `package ${name}\n\nfunc ${name}() {}\n`
    // Root build trees: ignored.
    write(root, 'build/root.go', go('buildroot'))
    write(root, 'dist/root.js', 'export const distRoot = 1\n')
    write(root, 'coverage/root.go', go('coverageroot'))
    write(root, 'target/root.go', go('targetroot'))
    write(root, 'vendor/dep/dep.go', go('vendored'))
    // The same names deeper down are ordinary source layout: measured.
    write(root, 'src/build/nested.go', go('srcbuild'))
    write(root, 'pkg/coverage/nested.go', go('pkgcoverage'))
    write(root, 'deep/target/nested.go', go('deeptarget'))
    write(root, 'src/vendor/nested.go', go('srcvendor'))
    write(root, 'src/dist/nested.js', 'export const nestedDist = 1\n')
    // Toolchain and VCS directories are ignored at ANY depth.
    write(root, 'deep/node_modules/dep/index.js', 'export const dependency = 1\n')
    write(root, 'src/.gocache/mod/cached.go', go('cached'))
    write(root, 'pkg/.venv/lib.py', 'value = 1\n')
    write(root, 'src/__pycache__/cached.py', 'value = 1\n')

    const result = measureWorkspace({ cwd: root, standards: { languages: { go: {}, js: {}, python: {} } } })
    assert.deepEqual(result.files.map((file) => file.path).sort(), [
        'deep/target/nested.go',
        'pkg/coverage/nested.go',
        'src/build/nested.go',
        'src/dist/nested.js',
        'src/vendor/nested.go',
    ])
    // The nested module cache must NOT come back: it holds generated code.
    assert.equal(result.stats.languages.go, 4)
})

test('layers: every `mayImport` prefix counts, not only the first', () => {
    const root = workspace()
    write(root, 'go.mod', 'module example.com/demo\n')
    write(root, 'internal/domain/value.go', 'package domain\n')
    write(root, 'internal/infra/db.go', 'package infra\n')
    write(root, 'internal/util/log.go', 'package util\n')
    write(root, 'internal/app/ok.go', 'package app\n\nimport (\n\t"example.com/demo/internal/infra"\n)\n')
    write(root, 'internal/app/bad.go', 'package app\n\nimport (\n\t"example.com/demo/internal/util"\n)\n')
    const standards: StandardsConfig = {
        languages: { go: {} },
        layers: [{ path: 'internal/app', mayImport: ['internal/domain', 'internal/infra'] }],
    }
    const result = measureWorkspace({ cwd: root, standards })
    const layers = result.violations.filter((violation) => violation.rule === 'layer')
    // `internal/infra` is the SECOND prefix: allowed. `internal/util` is in none.
    assert.deepEqual(
        layers.map((violation) => [violation.key, violation.line]),
        [['layer|internal/app/bad.go|internal/util', 4]],
    )
})

test('imports: a `./x.js` specifier resolves to the `x.ts` source beside it', () => {
    const root = workspace()
    write(root, 'src/helper.ts', 'export const helper = 1\n')
    write(root, 'src/store.ts', "import { helper } from './helper.js'\nexport const store = helper\n")
    const result = measureWorkspace({ cwd: root, standards: { languages: { ts: {} } } })
    assert.deepEqual(fileNamed(result, 'src/store.ts').imports, ['src/helper.ts'])
})

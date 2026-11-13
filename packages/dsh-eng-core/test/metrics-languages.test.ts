/**
 * Metrics for the languages added when the suite grew from four ecosystems to
 * eleven: Rust, Java, Kotlin, C#, PHP, Swift (brace-delimited) and Ruby (whose
 * blocks end with a keyword).
 *
 * Every expectation here is derived from the fixture text by hand. The one
 * failure mode this file exists for is a function whose span is "the rest of the
 * file": that number is never wrong in a way anyone notices — it is simply
 * accepted, and the `maxFunctionLines` threshold then either fires on everything
 * or (behind a baseline) on nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { measureWorkspace } from '../dist/index.js'
import type { FileMetrics, MetricsResult, StandardsConfig } from '../dist/index.js'

function workspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-metrics-languages-'))
}

function write(root: string, rel: string, text: string): void {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}

function fileNamed(result: MetricsResult, rel: string): FileMetrics {
    const found = result.files.find((file) => file.path === rel)
    assert.ok(found !== undefined, `expected ${rel} in ${result.files.map((file) => file.path).join(', ')}`)
    return found
}

/** Measure one fixture file and return its metrics. */
function measure(rel: string, source: string, language: string, rules: StandardsConfig['languages'][string] = {}): FileMetrics {
    const root = workspace()
    write(root, rel, source)
    return fileNamed(measureWorkspace({ cwd: root, standards: { languages: { [language]: rules } } }), rel)
}

const RUST = [
    'use std::fmt;',
    '',
    "pub struct Holder<'a> {",
    "    value: &'a str,",
    '}',
    '',
    "impl<'a> Holder<'a> {",
    "    pub fn find<'b>(&self, items: &'b [&'b str]) -> Option<&'b str> {",
    '        for item in items {',
    '            if item.len() > 3 {',
    '                return Some(item);',
    '            }',
    '        }',
    '        None',
    '    }',
    '',
    '    fn small(&self) -> usize {',
    '        1',
    '    }',
    '}',
    '',
    'fn main() {',
    '    println!("{}", \'x\');',
    '}',
].join('\n')

test('Rust: lifetimes in a signature do not swallow the function (pub fn, impl method, main)', () => {
    const file = measure('src/lib.rs', RUST, 'rust')
    assert.equal(file.language, 'rust')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.depth, fn.params]),
        [
            ['find', 8, 8, 3, 2],
            ['small', 17, 3, 1, 1],
            ['main', 22, 3, 1, 0],
        ],
    )
    // `pub struct` + `pub fn` — the declared public surface, not a brace count.
    assert.equal(file.exports, 2)
    assert.equal(file.maxDepth, 4)
})

const RUBY = [
    'class Crawler',
    '  def run(options = {}, retries: 2)',
    '    if options[:deep]',
    '      items.each do |item|',
    '        handle(item) if item.valid?',
    '      end',
    '    end',
    '    return self',
    '  end',
    '',
    '  def handle(item)',
    '    puts item',
    '  end',
    '',
    '  def answer = 42',
    'end',
].join('\n')

test('Ruby: `end` matching keeps each function inside its own block (modifiers, do-block, endless def)', () => {
    const file = measure('lib/crawler.rb', RUBY, 'ruby')
    assert.equal(file.language, 'ruby')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.depth, fn.params]),
        [
            ['run', 2, 8, 3, 2],
            ['handle', 11, 3, 1, 1],
            ['answer', 15, 1, 1, 0],
        ],
    )
    // `class Crawler` is the only top-level declaration; the methods are members.
    assert.equal(file.exports, 1)
    assert.deepEqual(file.ifBlocks, [{ line: 3, lines: 5, kind: 'if' }])
})

test('Ruby: a keyword used as a modifier opens nothing and an endless def closes nothing', () => {
    const root = workspace()
    write(
        root,
        'lib/modifiers.rb',
        [
            'def first(items)',
            '  items.each { |item| puts item } if items.any?',
            '  value = 1 while value < 10',
            '  value += 1 unless value.zero?',
            '  true',
            'end',
            '',
            'def second',
            '  false',
            'end',
        ].join('\n'),
    )
    const file = fileNamed(measureWorkspace({ cwd: root, standards: { languages: { ruby: { maxFunctionLines: 4 } } } }), 'lib/modifiers.rb')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines]),
        [
            ['first', 1, 6],
            ['second', 8, 3],
        ],
    )
    // 6 > 4 lines is the violation a "span runs to end of file" bug would hide.
    assert.deepEqual(
        file.functions.length,
        2,
    )
    const violations = measureWorkspace({ cwd: root, standards: { languages: { ruby: { maxFunctionLines: 4 } } } }).violations
    assert.deepEqual(
        violations.map((violation) => [violation.rule, violation.key.split('|')[2]]),
        [['maxFunctionLines', 'first']],
    )
})

const JAVA = [
    'package demo;',
    '',
    'public class Crawler {',
    '    public int run(String[] args) throws Exception {',
    '        if (args.length > 0) {',
    '            return args.length;',
    '        }',
    '        return 0;',
    '    }',
    '',
    '    private void small() {',
    '        System.out.println("x");',
    '    }',
    '}',
].join('\n')

test('Java: a `throws` clause before the body is not mistaken for the body', () => {
    const file = measure('src/main/java/demo/Crawler.java', JAVA, 'java')
    assert.equal(file.language, 'java')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.depth, fn.params]),
        [
            ['run', 4, 6, 2, 1],
            ['small', 11, 3, 1, 0],
        ],
    )
    assert.deepEqual(file.ifBlocks, [{ line: 5, lines: 3, kind: 'if' }])
    assert.equal(file.exports, 2)
})

const KOTLIN = [
    'class Crawler {',
    '    fun run(items: List<String>): Int {',
    '        var count = 0',
    '        items.forEach { item ->',
    '            if (item.isNotEmpty()) {',
    '                count += 1',
    '            }',
    '        }',
    '        return count',
    '    }',
    '',
    '    private fun small() = 1',
    '}',
].join('\n')

test('Kotlin: generic parameter types do not split the parameter list, lambda braces still nest', () => {
    const file = measure('src/main/kotlin/Crawler.kt', KOTLIN, 'kotlin')
    assert.equal(file.language, 'kotlin')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.params]),
        [['run', 2, 9, 1]],
    )
    assert.equal(file.exports, 2)
})

const CSHARP = [
    'namespace Demo;',
    '',
    'public class Crawler',
    '{',
    '    public int Run(string[] args)',
    '    {',
    '        if (args.Length > 0)',
    '        {',
    '            return args.Length;',
    '        }',
    '        return 0;',
    '    }',
    '}',
].join('\n')

test('C#: an Allman-style body brace on the next line still belongs to the method', () => {
    const file = measure('src/Crawler.cs', CSHARP, 'csharp')
    assert.equal(file.language, 'csharp')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.params]),
        [['Run', 5, 8, 1]],
    )
    assert.equal(file.exports, 2)
})

const PHP = [
    '<?php',
    '',
    'class Crawler',
    '{',
    '    public function run(array $items): int',
    '    {',
    '        if (count($items) > 0) {',
    '            return count($items);',
    '        }',
    '        return 0;',
    '    }',
    '}',
].join('\n')

test('PHP: `#` starts an attribute, not a comment here; the method span stops at its own `}`', () => {
    const file = measure('src/Crawler.php', PHP, 'php')
    assert.equal(file.language, 'php')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.params]),
        [['run', 5, 7, 1]],
    )
    assert.equal(file.exports, 2)
})

const PHP_ATTRIBUTE = [
    '<?php',
    '',
    'class Tagged',
    '{',
    '    #[Pure]',
    '    public function tag(): string',
    '    {',
    '        return "x";',
    '    }',
    '}',
].join('\n')

test('PHP: an attribute line (`#[…]`) is code, so the declaration after it still measures', () => {
    const file = measure('src/Tagged.php', PHP_ATTRIBUTE, 'php')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines]),
        [['tag', 6, 4]],
    )
})

const SWIFT = [
    'import Foundation',
    '',
    'struct Crawler {',
    '    func run(items: [String]) -> Int {',
    '        if !items.isEmpty {',
    '            return items.count',
    '        }',
    '        return 0',
    '    }',
    '',
    '    func small() {',
    '        return',
    '    }',
    '}',
].join('\n')

test('Swift: parentheses-free `if` blocks and `-> T` return types are measured', () => {
    const file = measure('Sources/Crawler.swift', SWIFT, 'swift')
    assert.equal(file.language, 'swift')
    assert.deepEqual(
        file.functions.map((fn) => [fn.name, fn.line, fn.lines, fn.depth, fn.params]),
        [
            ['run', 4, 6, 2, 1],
            ['small', 11, 3, 1, 0],
        ],
    )
    assert.deepEqual(file.ifBlocks, [{ line: 5, lines: 3, kind: 'if' }])
})

test('every new extension is reported under its own language and counted in stats', () => {
    const root = workspace()
    write(root, 'src/a.rs', 'fn a() {\n}\n')
    write(root, 'src/b.java', 'class B {\n}\n')
    write(root, 'src/c.kt', 'class C\n')
    write(root, 'src/d.kts', 'val d = 1\n')
    write(root, 'src/e.cs', 'class E {\n}\n')
    write(root, 'src/f.php', '<?php\n')
    write(root, 'src/g.rb', "class G\nend\n")
    write(root, 'src/h.swift', 'struct H {\n}\n')
    const result = measureWorkspace({ cwd: root, standards: { languages: {} } })
    assert.deepEqual(result.stats.languages, { csharp: 1, java: 1, kotlin: 2, php: 1, ruby: 1, rust: 1, swift: 1 })
    assert.deepEqual(
        result.files.map((file) => [file.path, file.language]),
        [
            ['src/a.rs', 'rust'],
            ['src/b.java', 'java'],
            ['src/c.kt', 'kotlin'],
            ['src/d.kts', 'kotlin'],
            ['src/e.cs', 'csharp'],
            ['src/f.php', 'php'],
            ['src/g.rb', 'ruby'],
            ['src/h.swift', 'swift'],
        ],
    )
})

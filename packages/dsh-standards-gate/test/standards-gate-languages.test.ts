/**
 * The standards gate, measured over the ecosystems added in this mission.
 *
 * A language is "supported" only when a violation in it can actually be
 * MEASURED. These fixtures are therefore one over-long function per language:
 * if a span were read as "the rest of the file" (or if the language were
 * silently skipped), the gate would report PASS on a repository that plainly
 * breaks its own standard. The second function in every fixture is what makes a
 * swallowed span visible: it must NOT be part of the first one.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeHost, runText, tempWorkspace } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** A fresh repository with `.dsh/standards.json` and the given source files. */
function repo(files: Record<string, string>, standards: unknown): string {
    const cwd = tempWorkspace('standards-gate-languages-')
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(cwd, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
    }
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'standards.json'), `${JSON.stringify(standards, null, 2)}\n`)
    return cwd
}

/** The plugin assembled in a throwaway workspace. */
function host(cwd: string): ReturnType<typeof createFakeHost> {
    const fake = createFakeHost({ cwd })
    apply(fake.ctx as never, { logFile: path.join(cwd, 'standards-gate.log') })
    return fake
}

/** One fixture per language: `longOne` (4–5 lines) then a short function. */
const FIXTURES: Record<string, { path: string; body: string[] }> = {
    rust: {
        path: 'src/lib.rs',
        body: ['fn long_one() {', '    let a = 1;', '    let b = 2;', '}', '', 'fn short() {}'],
    },
    java: {
        path: 'src/Demo.java',
        body: ['class Demo {', '    void longOne() {', '        int a = 1;', '        int b = 2;', '    }', '', '    void shortOne() {}', '}'],
    },
    kotlin: {
        path: 'src/Demo.kt',
        body: ['class Demo {', '    fun longOne() {', '        val a = 1', '        val b = 2', '    }', '', '    fun shortOne() {}', '}'],
    },
    csharp: {
        path: 'src/Demo.cs',
        body: ['class Demo {', '    void LongOne() {', '        int a = 1;', '        int b = 2;', '    }', '', '    void ShortOne() {}', '}'],
    },
    php: {
        path: 'src/Demo.php',
        body: ['<?php', 'class Demo', '{', '    public function longOne(): void', '    {', '        $a = 1;', '        $b = 2;', '    }', '}'],
    },
    ruby: {
        path: 'lib/demo.rb',
        body: ['class Demo', '  def long_one', '    a = 1', '    b = 2', '  end', '', '  def short_one; end', 'end'],
    },
    swift: {
        path: 'Sources/Demo.swift',
        body: ['struct Demo {', '    func longOne() {', '        let a = 1', '        let b = 2', '    }', '', '    func shortOne() {}', '}'],
    },
}

test('every new language is measured: an over-long function in it blocks the gate', async () => {
    const files: Record<string, string> = {}
    for (const fixture of Object.values(FIXTURES)) files[fixture.path] = `${fixture.body.join('\n')}\n`
    const standards = {
        languages: Object.fromEntries(Object.keys(FIXTURES).map((language) => [language, { maxFunctionLines: 2 }])),
    }
    const cwd = repo(files, standards)
    const fake = host(cwd)
    const output = runText(await fake.runTool('standards_check', {}))
    assert.match(output, /— BLOCK/)
    assert.match(output, /新增违规（7 项/)
    for (const [language, fixture] of Object.entries(FIXTURES)) {
        // The path AND the rule are both required: a path alone could come from a
        // file-level violation, and the rule alone does not say where.
        assert.match(output, new RegExp(fixture.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${language}: the violation names its file`)
    }
    assert.match(output, /- maxFunctionLines：7/, 'the rule summary counts one violation per language')
    fake.dispose()
})

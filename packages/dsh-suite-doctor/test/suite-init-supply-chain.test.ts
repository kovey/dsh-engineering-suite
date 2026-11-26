/**
 * `suite_init` reads EVERY ecosystem in the repository, not just the first one.
 *
 * Two promises are pinned here, both about what a multi-ecosystem repository
 * gets and what the person running the scaffold is told:
 *
 *  1. **The supply chain covers every ecosystem.** `quality-gate`/`coverage-gate`/
 *     `standards` stay keyed to the primary (first) detection hit — a repository
 *     has one way it runs its tests — but `supply-chain-gate.json` watches the
 *     UNION of the detected manifests and audits each ecosystem with its
 *     established CLI. A Go repository that also carries `requirements.txt` must
 *     not stop watching `go.mod` (TC-3401/TC-3402/TC-3406).
 *  2. **Nothing is invented and nothing is silent.** Java/Kotlin/Swift have no
 *     standard vulnerability-audit CLI, so they get NO command and the report
 *     names them with the reason (TC-3404); the manifests of one ecosystem are
 *     byte-for-byte what they were before multi-ecosystem detection existed.
 *
 * The expected manifests/commands are the specification's table, written out
 * literally: a test that read them back from the implementation would prove
 * nothing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveLayout } from 'dsh-eng-core'
import { tempWorkspace } from 'dsh-eng-core/testing'
import { AUDIT_COMMAND_BY_LANGUAGE, NO_STANDARD_AUDITOR } from '../dist/scaffold-audit.js'
import { supplyChainGateContent } from '../dist/scaffold-content.js'
import { detectLanguage, detectLanguageInfo } from '../dist/scaffold-detect.js'
import { planSuiteInit, renderInitPlan, type InitPlan } from '../dist/scaffold.js'

/** A throwaway repository containing `files`. */
function repo(files: Record<string, string>): string {
    const cwd = tempWorkspace('suite-init-supply-')
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
        fs.writeFileSync(path.join(cwd, name), content)
    }
    return cwd
}

/** Plan (dry run by default) against the layout the tests read back. */
function planOf(cwd: string, apply = false): InitPlan {
    return planSuiteInit({ cwd, rootDir: resolveLayout(cwd).configDir, apply })
}

/** The scaffolded `supply-chain-gate.json`, as the gate will read it. */
function readSupplyChain(rootDir: string): { deps: { manifests: string[]; auditCommands: string[] }; secretScan: { scanWholeTree: boolean } } {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'supply-chain-gate.json'), 'utf8')) as {
        deps: { manifests: string[]; auditCommands: string[] }
        secretScan: { scanWholeTree: boolean }
    }
}

/** Escape a literal for a RegExp (manifest names carry dots). */
function esc(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The defaults one ecosystem must get on its own (the specification's table). */
interface Expected {
    /** The root file that evidences the ecosystem. */
    file: string
    language: string
    /** The supply-chain watch list — unchanged from before multi-ecosystem detection. */
    manifests: string[]
    /** The standard audit command, or `[]` when no CLI exists. */
    auditCommands: string[]
    /** Whether the report must name this ecosystem as skipped (no standard auditor). */
    skipped: boolean
}

/** The eleven ecosystems, in DETECTION_ORDER (the order the type declares them). */
const ECOSYSTEMS: readonly Expected[] = [
    { file: 'tsconfig.json', language: 'ts', manifests: ['package.json', 'pnpm-lock.yaml'], auditCommands: ['npm audit --json'], skipped: false },
    { file: 'go.mod', language: 'go', manifests: ['go.mod', 'go.sum'], auditCommands: ['govulncheck ./...'], skipped: false },
    { file: 'Cargo.toml', language: 'rust', manifests: ['Cargo.toml', 'Cargo.lock'], auditCommands: ['cargo audit --json'], skipped: false },
    { file: 'pom.xml', language: 'java', manifests: ['pom.xml'], auditCommands: [], skipped: true },
    { file: 'build.gradle.kts', language: 'kotlin', manifests: ['build.gradle.kts', 'settings.gradle.kts'], auditCommands: [], skipped: true },
    {
        file: 'App.csproj',
        language: 'csharp',
        manifests: ['*.sln', '*.csproj'],
        auditCommands: ['dotnet list package --vulnerable --include-transitive'],
        skipped: false,
    },
    { file: 'composer.json', language: 'php', manifests: ['composer.json'], auditCommands: ['composer audit --format=json'], skipped: false },
    { file: 'Gemfile', language: 'ruby', manifests: ['Gemfile', 'Gemfile.lock'], auditCommands: ['bundler-audit check'], skipped: false },
    { file: 'Package.swift', language: 'swift', manifests: ['Package.swift'], auditCommands: [], skipped: true },
    { file: 'pyproject.toml', language: 'py', manifests: ['requirements.txt', 'pyproject.toml'], auditCommands: ['pip-audit -f json'], skipped: false },
    { file: 'package.json', language: 'js', manifests: ['package.json', 'pnpm-lock.yaml'], auditCommands: ['npm audit --json'], skipped: false },
]

test('TC-3406: every ecosystem gets its manifests and its real audit command alone', () => {
    for (const expected of ECOSYSTEMS) {
        const cwd = repo({ [expected.file]: 'x\n' })
        const plan = planOf(cwd)
        assert.equal(plan.language, expected.language, `${expected.file} must detect ${expected.language}`)
        assert.deepEqual(plan.languages, [expected.language], `${expected.file}: one ecosystem detected`)
        // AC-002: a single-ecosystem repository keeps exactly the manifests it had.
        assert.deepEqual(plan.supplyChain.manifests, expected.manifests, `${expected.file}: manifests`)
        // AC-003: the standard CLI when one exists, nothing when it does not.
        assert.deepEqual(plan.supplyChain.auditCommands, expected.auditCommands, `${expected.file}: audit commands`)

        const rendered = renderInitPlan(plan)
        assert.match(rendered, /语言与供应链：/, `${expected.file}: the section is always printed`)
        assert.match(
            rendered,
            new RegExp(`检测到的生态（1）：${expected.language}（命中 ${esc(expected.file)}；manifests ${expected.manifests.map(esc).join('、')}）`),
            `${expected.file}: the report names the ecosystem, its evidence and its manifests`,
        )
        assert.match(rendered, new RegExp(`manifests 并集（${expected.manifests.length}）：${expected.manifests.map(esc).join('、')}`))
        const commandCell =
            expected.auditCommands.length === 0
                ? /审计命令（0）：无/
                : new RegExp(`审计命令（1）：${expected.auditCommands.map(esc).join('、')}（${expected.language}）`)
        assert.match(rendered, commandCell, `${expected.file}: the report lists the generated commands`)
        // AC-004: a skipped ecosystem is named WITH the reason, never silently dropped.
        if (expected.skipped) {
            assert.match(rendered, new RegExp(`跳过（1）：${expected.language} —— 该生态无标准审计器，需人工补充`))
            assert.deepEqual(plan.supplyChain.skipped.map((entry) => entry.language), [expected.language])
            assert.match(plan.supplyChain.skipped[0]?.note ?? '', /无标准审计器，需人工补充/)
        } else {
            assert.match(rendered, /跳过：无（生成所用的生态都有标准审计器）/)
            assert.deepEqual(plan.supplyChain.skipped, [])
        }

        // AC-002: the file is the projection the report just described.
        const applied = planOf(cwd, true)
        const doc = readSupplyChain(applied.rootDir)
        assert.deepEqual(doc.deps.manifests, expected.manifests, `${expected.file}: written manifests`)
        assert.deepEqual(doc.deps.auditCommands, expected.auditCommands, `${expected.file}: written audit commands`)
        assert.deepEqual(Object.keys(doc.deps).sort(), ['auditCommands', 'manifests'], 'the report-only "skipped" list is not written')
        assert.equal(doc.secretScan.scanWholeTree, false)
    }
})

test('TC-3402: go + py pool the manifests union and both audit commands', () => {
    const cwd = repo({ 'go.mod': 'module example\n', 'requirements.txt': 'requests\n' })
    const plan = planOf(cwd)
    assert.equal(plan.language, 'go', 'the primary answer is still the first hit')
    assert.deepEqual(plan.languages, ['go', 'py'], 'detection order, not filesystem order')
    assert.deepEqual(plan.supplyChain.manifests, ['go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml'])
    assert.deepEqual(plan.supplyChain.auditCommands, ['govulncheck ./...', 'pip-audit -f json'])

    const rendered = renderInitPlan(plan)
    assert.match(rendered, /检测到的生态（2）：go（命中 go\.mod；manifests go\.mod、go\.sum）、py（命中 requirements\.txt；manifests requirements\.txt、pyproject\.toml）/)
    assert.match(rendered, /manifests 并集（4）：go\.mod、go\.sum、requirements\.txt、pyproject\.toml/)
    assert.match(rendered, /审计命令（2）：govulncheck \.\/\.\.\.（go）、pip-audit -f json（py）/)
    assert.match(rendered, /跳过：无（生成所用的生态都有标准审计器）/)

    // The dry run wrote nothing; the apply writes exactly what was promised.
    assert.equal(fs.existsSync(plan.rootDir), false, 'dry run must not create the layout root')
    const applied = planOf(cwd, true)
    assert.match(renderInitPlan(applied), /语言与供应链：/, 'the apply output carries the same section')
    const doc = readSupplyChain(applied.rootDir)
    assert.deepEqual(doc.deps.manifests, plan.supplyChain.manifests)
    assert.deepEqual(doc.deps.auditCommands, plan.supplyChain.auditCommands)
})

test('ts + rust: two ecosystems with different audits, union in detection order', () => {
    const cwd = repo({ 'tsconfig.json': '{}', 'Cargo.toml': '[package]\nname = "x"\n' })
    const plan = planOf(cwd)
    assert.equal(plan.language, 'ts', 'tsconfig.json is first in the detection order')
    assert.deepEqual(plan.languages, ['ts', 'rust'])
    assert.deepEqual(plan.supplyChain.manifests, ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'Cargo.lock'])
    assert.deepEqual(plan.supplyChain.auditCommands, ['npm audit --json', 'cargo audit --json'])
    assert.match(renderInitPlan(plan), /审计命令（2）：npm audit --json（ts）、cargo audit --json（rust）/)
})

test('ts + js share package.json: the manifest and the command are named ONCE', () => {
    const cwd = repo({ 'tsconfig.json': '{}', 'package.json': '{"name":"x"}' })
    const plan = planOf(cwd)
    assert.deepEqual(plan.languages, ['ts', 'js'])
    assert.deepEqual(plan.supplyChain.manifests, ['package.json', 'pnpm-lock.yaml'], 'deduplicated by manifest name')
    assert.deepEqual(plan.supplyChain.auditCommands, ['npm audit --json'], 'the same command is not written twice')
    assert.match(renderInitPlan(plan), /审计命令（1）：npm audit --json（ts、js）/)
})

test('TC-3404: java/kotlin/swift get NO command and the report names the reason', () => {
    const cwd = repo({ 'pom.xml': 'x\n', 'build.gradle.kts': 'x\n', 'Package.swift': 'x\n' })
    const plan = planOf(cwd)
    assert.equal(plan.language, 'java')
    assert.deepEqual(plan.languages, ['java', 'kotlin', 'swift'])
    assert.deepEqual(plan.supplyChain.auditCommands, [], 'no command is invented for an ecosystem without a CLI')
    assert.deepEqual(plan.supplyChain.skipped.map((entry) => entry.language), ['java', 'kotlin', 'swift'])

    const rendered = renderInitPlan(plan)
    assert.match(rendered, /审计命令（0）：无（检测到的生态都没有标准审计器/)
    assert.match(rendered, /跳过（3）：java —— 该生态无标准审计器，需人工补充/)
    assert.match(rendered, /kotlin —— 该生态无标准审计器，需人工补充/)
    assert.match(rendered, /swift —— 该生态无标准审计器，需人工补充/)
    // Three ecosystems, three reasons — counted, not just "present".
    assert.equal((rendered.match(/无标准审计器，需人工补充/g) ?? []).length, 3)

    const doc = readSupplyChain(planOf(cwd, true).rootDir)
    assert.deepEqual(doc.deps.auditCommands, [])
    assert.deepEqual(doc.deps.manifests, ['pom.xml', 'build.gradle.kts', 'settings.gradle.kts', 'Package.swift'])
})

test('TC-3405: an empty repository gets the ts defaults and says it is a default, not a detection', () => {
    const cwd = repo({ 'README.md': '# x\n' })
    const detection = detectLanguageInfo(cwd)
    assert.equal(detection.language, 'ts')
    assert.deepEqual(detection.languages, [], 'nothing was detected — a default is not evidence')
    assert.deepEqual(detection.matches, [])

    const plan = planOf(cwd)
    assert.equal(plan.language, 'ts')
    assert.deepEqual(plan.languages, ['ts'], 'the documents are still generated for the default')
    assert.deepEqual(plan.supplyChain.manifests, ['package.json', 'pnpm-lock.yaml'])
    assert.deepEqual(plan.supplyChain.auditCommands, ['npm audit --json'])
    const rendered = renderInitPlan(plan)
    assert.match(rendered, /检测到的生态（0）：无（没有找到任何已知 manifest，按约定默认 ts）/)
    assert.match(rendered, /审计命令（1）：npm audit --json（ts）/)
    assert.match(rendered, /- 跳过：无（生成所用的生态都有标准审计器）/)

    const doc = readSupplyChain(planOf(cwd, true).rootDir)
    assert.deepEqual(doc.deps.manifests, ['package.json', 'pnpm-lock.yaml'])
    assert.deepEqual(doc.deps.auditCommands, ['npm audit --json'])
})

test('detectLanguageInfo: primary unchanged, every hit added in the documented order', () => {
    const cwd = repo({ 'tsconfig.json': '{}', 'go.mod': 'module x\n', 'Cargo.toml': 'x', 'requirements.txt': 'x', 'package.json': '{}' })
    const detection = detectLanguageInfo(cwd)
    assert.equal(detection.language, 'ts')
    assert.equal(detectLanguage(cwd), 'ts')
    assert.equal(detection.reason, '检测依据：命中 tsconfig.json')
    assert.deepEqual(detection.languages, ['ts', 'go', 'rust', 'py', 'js'])
    assert.deepEqual(detection.matches.map((match) => match.language), ['ts', 'go', 'rust', 'py', 'js'])
    assert.deepEqual(detection.matches.map((match) => match.manifest), ['tsconfig.json', 'go.mod', 'Cargo.toml', 'requirements.txt', 'package.json'])

    // The two answers come from the SAME matcher: the suffix rule that names the
    // extension for the primary also evidences the multi-ecosystem list.
    const dotnet = detectLanguageInfo(repo({ 'App.sln': 'x\n' }))
    assert.equal(dotnet.language, 'csharp')
    assert.deepEqual(dotnet.matches, [{ language: 'csharp', manifest: 'App.sln', suffix: '.sln' }])
    assert.match(dotnet.reason, /^检测依据：命中 App\.sln（\*\.sln）$/)

    // A DIRECTORY named like a manifest is not evidence — for either answer.
    const directory = detectLanguageInfo(repo({ 'go.mod/placeholder': 'x\n' }))
    assert.equal(directory.language, 'ts')
    assert.deepEqual(directory.languages, [])
    assert.deepEqual(directory.matches, [])
})

test('the auditor table has one command per eligible ecosystem and a reason for the rest', () => {
    const languages = Object.keys(AUDIT_COMMAND_BY_LANGUAGE).sort()
    assert.deepEqual(languages, ['csharp', 'go', 'js', 'php', 'py', 'ruby', 'rust', 'ts'])
    for (const language of languages) {
        assert.equal(typeof AUDIT_COMMAND_BY_LANGUAGE[language as keyof typeof AUDIT_COMMAND_BY_LANGUAGE], 'string')
    }
    // The three ecosystems the suite deliberately leaves alone.
    assert.deepEqual(Object.keys(NO_STANDARD_AUDITOR).sort(), ['java', 'kotlin', 'swift'])
    for (const note of Object.values(NO_STANDARD_AUDITOR)) assert.match(note, /无标准审计器，需人工补充/)
})

test('supplyChainGateContent: a single ecosystem keeps its exact manifests, the list adds unions', () => {
    assert.deepEqual(supplyChainGateContent('go'), {
        deps: { manifests: ['go.mod', 'go.sum'], auditCommands: ['govulncheck ./...'] },
        secretScan: { scanWholeTree: false },
    })
    // The default parameter and an explicit empty list mean the same thing:
    // only the primary ecosystem (what a direct caller without detection wants).
    assert.deepEqual(supplyChainGateContent('py', []), supplyChainGateContent('py'))
    const pooled = supplyChainGateContent('ts', ['ts', 'rust']) as { deps: { manifests: string[]; auditCommands: string[] } }
    assert.deepEqual(pooled.deps.manifests, ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'Cargo.lock'])
    assert.deepEqual(pooled.deps.auditCommands, ['npm audit --json', 'cargo audit --json'])
})

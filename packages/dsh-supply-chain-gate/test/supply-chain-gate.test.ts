import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MissionStoreRegistry } from 'dsh-eng-core'
import { createFakeHost, fakeAgent, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply, inject, name } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig, allowlistFileOf } from '../dist/config.js'
import {
    ENTROPY_RULE_ID,
    SECRET_RULES,
    fingerprintOf,
    parseAllowlist,
    redactSecret,
    scanText,
    shannonEntropy,
    isCredentialPath,
    looksLikeWordList,
} from '../dist/secrets.js'
import { classifyFindings, diffManifests, formatOf, isLockfile, lockfileManifestOf, parseAuditOutput, parseManifest } from '../dist/deps.js'
import { loadAllowlist, splitAuditCommand } from '../dist/tools.js'

// Fixtures are OBVIOUSLY fake on purpose: the AWS pair is the documented example
// from AWS's own docs, the rest are patterned strings. A test that needed a real
// secret to be meaningful would itself be the leak.
/**
 * Fixtures are ASSEMBLED AT RUNTIME, never written as literals.
 *
 * Writing a realistic key into a test file trips GitHub's push protection — it
 * blocked this very commit (`DeepSeek API Key` at line 30 of this file) — and a
 * scanner's fixtures should not look like credentials in the first place: they
 * pollute secret-scanning dashboards and train everyone to click "allow". The
 * test at the bottom of this file scans this file with these very rules and
 * fails if a literal ever comes back.
 */
const fake = (...parts: string[]): string => parts.join('')

const AWS_KEY_ID = fake('AKIA', 'IOSFODNN7EXAMPLE')
const AWS_SECRET = fake('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY')
const GITHUB_TOKEN = fake('ghp_', '0123456789abcdefghijABCDEF')
const SLACK_TOKEN = fake('xoxb-', '1234567890-abcdefghijkl')
const DEEPSEEK_KEY = fake('sk-', '0123456789abcdef0123456789abcdef')
const OPENAI_KEY = fake('sk-proj-', 'abcdefghijklmnopqrstuvwxyz01')
const GOOGLE_KEY = fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')
const JWT_TOKEN = fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.')
const HIGH_ENTROPY = fake('Zx9Qm2Lp7', 'Rt4Wv1Yb8Nc3Kd6')

const hosts: FakeHost[] = []

/** Run a git command in a workspace. */
function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A temp git workspace with an initial commit and `.dsh/` ignored. */
function gitRepo(prefix: string): string {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.dsh/\n*.log\n')
    git(cwd, ['init', '-q'])
    git(cwd, ['config', 'user.email', 'gate@example.com'])
    git(cwd, ['config', 'user.name', 'Gate Test'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-q', '-m', 'init'])
    return cwd
}

/** Commit everything in a workspace. */
function commitAll(cwd: string, message: string): void {
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-q', '-m', message])
}

/** Write a file (creating directories). */
function write(cwd: string, relative: string, text: string): void {
    const file = path.join(cwd, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}

/** A shell-free audit command: a node script the host configured. */
function auditScript(cwd: string, body: string, argv = 'scripts/audit.js'): string {
    write(cwd, argv, body)
    return `node ${argv}`
}

/**
 * Assemble the plugin in a throwaway workspace with a scripted approval seam.
 * Returns the fake host plus the approval prompts the seam received.
 */
function host(
    cwd: string,
    config: Record<string, unknown> = {},
    services: Record<string, unknown> = {},
): FakeHost & { approvals: string[] } {
    const fake = createFakeHost({ cwd, withSubprocess: services['withSubprocess'] !== false })
    hosts.push(fake)
    const approvals: string[] = []
    const original = (fake.ctx as unknown as { get: (name: string) => unknown }).get.bind(fake.ctx)
    const seam = {
        request: async (request: { reason: string }) => {
            approvals.push(request.reason)
            return (services['approvalDecision'] as string | undefined) ?? 'allowed-once'
        },
    }
    ;(fake.ctx as unknown as { get: (name: string) => unknown }).get = ((service: string) =>
        service === 'approval' ? (services['withApproval'] === false ? undefined : seam) : original(service)) as never
    apply(fake.ctx as never, { logFile: path.join(cwd, '.dsh', 'supply-chain-gate.log'), ...config })
    return Object.assign(fake, { approvals })
}

/** Bind a mission to the fake host's session so gates are recorded. */
function bindMission(cwd: string, sessionId = 'session-1'): string {
    const store = new MissionStoreRegistry().for(cwd)
    const mission = store.create({ title: '供应链门禁', cwd, sessionId })
    store.bindSession(sessionId, mission.id, 'implement')
    return mission.id
}

/** Every recorded gate of one mission. */
function gates(cwd: string, missionId: string) {
    return new MissionStoreRegistry().for(cwd).readGates(missionId).filter((gate) => gate.source === 'dsh-supply-chain-gate')
}

/** All artifact text of one mission (for "the raw secret appears nowhere" checks). */
function artifactText(cwd: string, missionId: string): string {
    const dir = path.join(cwd, '.dsh', 'missions', missionId, 'supply-chain')
    return fs
        .readdirSync(dir)
        .map((entry) => fs.readFileSync(path.join(dir, entry), 'utf8'))
        .join('\n')
}

/** The rule ids that fired on one text. */
function rulesOn(text: string, entropyThreshold?: number): string[] {
    return [...new Set(scanText({ path: 'fixture.txt', text, ...(entropyThreshold === undefined ? {} : { entropyThreshold }) }).map((finding) => finding.rule))]
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-supply-chain-gate')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

// --- the detector -----------------------------------------------------------

test('every rule fires on its positive fixture and stays quiet on a near miss', () => {
    const cases: { rule: string; positive: string; nearMiss: string }[] = [
        { rule: 'aws-access-key-id', positive: `aws_access_key_id = "${AWS_KEY_ID}"`, nearMiss: 'aws_access_key_id = "AKIAIOSFODNN7EXAMPL"' },
        { rule: 'aws-secret-access-key', positive: `aws_secret_access_key = "${AWS_SECRET}"`, nearMiss: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE"' },
        { rule: 'github-token', positive: `const t = "${GITHUB_TOKEN}"`, nearMiss: 'const t = "ghp_short"' },
        { rule: 'slack-token', positive: `slack = "${SLACK_TOKEN}"`, nearMiss: 'slack = "xoxz-1234567890-abcdef"' },
        { rule: 'deepseek-api-key', positive: `key = "${DEEPSEEK_KEY}"`, nearMiss: `key = "${fake('sk-Z', '123456789abcdef0123456789abcdef')}"` },
        { rule: 'openai-api-key', positive: `key = "${OPENAI_KEY}"`, nearMiss: 'key = "sk-short"' },
        { rule: 'google-api-key', positive: `key = "${GOOGLE_KEY}"`, nearMiss: 'key = "AIzaSyA1234567890abcdefghijklmnopqrstu"' },
        { rule: 'private-key-block', positive: fake('-----BEGIN ', 'RSA PRIVATE KEY-----'), nearMiss: fake('-----BEGIN ', 'PUBLIC KEY-----') },
        { rule: 'jwt', positive: `bearer ${JWT_TOKEN}`, nearMiss: `bearer ${fake('eyJhbGciOiJIUzI1NiJ9', '.abc.')}` },
        { rule: 'generic-secret-assignment', positive: 'password = "hunter2hunter2"', nearMiss: 'password = "short"' },
        { rule: ENTROPY_RULE_ID, positive: `const value = "${HIGH_ENTROPY}"`, nearMiss: 'const value = "abcabcabcabcabcabcabcabcabc"' },
    ]
    assert.equal(cases.length, SECRET_RULES.length, 'every shipped rule has a fixture pair')
    for (const entry of cases) {
        assert.ok(rulesOn(entry.positive).includes(entry.rule), `${entry.rule} should fire on its positive fixture`)
        assert.equal(
            rulesOn(entry.nearMiss).includes(entry.rule),
            false,
            `${entry.rule} should stay quiet on its near miss: ${entry.nearMiss}`,
        )
    }
})

test('documented placeholders are not findings for the low-confidence rules', () => {
    assert.deepEqual(rulesOn('password = "changeme"'), [])
    assert.deepEqual(rulesOn('api_key = "${API_KEY}"'), [])
    assert.deepEqual(rulesOn('token = "xxxxxxxxxx"'), [])
    // …but a high-confidence shape is never exempted by the placeholder list.
    assert.ok(rulesOn(`id = "${AWS_KEY_ID}"`).includes('aws-access-key-id'))
})

test('the entropy rule honours the configured threshold and never fires on low entropy', () => {
    assert.ok(shannonEntropy(HIGH_ENTROPY) > 4)
    assert.ok(rulesOn(`const value = "${HIGH_ENTROPY}"`).includes(ENTROPY_RULE_ID))
    assert.equal(rulesOn(`const value = "${HIGH_ENTROPY}"`, 6).includes(ENTROPY_RULE_ID), false, 'a higher threshold stays quiet')
    assert.equal(rulesOn('const value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"').length, 0, 'one repeated character has no entropy')
    assert.equal(rulesOn('const value = "abababababababababababababababab"').length, 0, 'a repeating pair has no entropy')
    assert.equal(rulesOn('const value = "implementthethingcarefullyok"').length, 0, 'ordinary text is below the default 4.0')
})

test('redaction shows the first 4, the last 2 and the length — never the value', () => {
    const excerpt = redactSecret(AWS_KEY_ID)
    assert.equal(excerpt, 'AKIA…LE（长度 20）')
    assert.equal(excerpt.includes(AWS_KEY_ID), false)
    assert.match(redactSecret('abcdefg'), /^abcd…fg/)
    assert.match(redactSecret('abc'), /^\*\*\*/)
})

test('findings carry a fingerprint of the value and no raw value anywhere', () => {
    const findings = scanText({ path: 'x.env', text: `AWS_ACCESS_KEY_ID=${AWS_KEY_ID}\n` })
    assert.equal(findings.length, 1)
    const finding = findings[0]!
    assert.equal(finding.rule, 'aws-access-key-id')
    assert.equal(finding.hash, fingerprintOf(AWS_KEY_ID))
    assert.equal(JSON.stringify(findings).includes(AWS_KEY_ID), false)
})

test('a value matched by two rules is ONE finding that names both', () => {
    const [finding] = scanText({ path: 'x.env', text: `token = "${AWS_KEY_ID}"\n` })
    assert.equal(finding?.rule, 'aws-access-key-id', 'the specific rule names the finding')
    assert.deepEqual(finding?.alsoMatched, ['generic-secret-assignment'])
})

test('added ranges limit the scan to the lines the change introduced', () => {
    const text = [
        `const stale = "${AWS_KEY_ID}"`, // line 1 — pre-existing
        'const untouched = 1', // line 2
        `const fresh = "${GITHUB_TOKEN}"`, // line 3 — added
    ].join('\n')
    const diffOnly = scanText({ path: 'x.ts', text, addedRanges: [[3, 3]] })
    assert.deepEqual(diffOnly.map((finding) => finding.rule), ['github-token'])
    const whole = scanText({ path: 'x.ts', text })
    assert.deepEqual(
        whole.map((finding) => finding.rule).sort(),
        ['aws-access-key-id', 'github-token'],
    )
})

// --- allowlist --------------------------------------------------------------

test('allowlist: a rule entry suppresses that rule only, a path entry its paths, a hash its value', () => {
    const text = [`const a = "${AWS_KEY_ID}"`, `const b = "${GITHUB_TOKEN}"`].join('\n')
    const findings = scanText({ path: 'src/config.ts', text })

    const byRule = parseAllowlist({ entries: [{ rules: ['aws-access-key-id'], note: 'aws 是占位示例' }] })
    assert.deepEqual(byRule.problems, [])
    assert.equal(byRule.entries.length, 1)

    const byPath = parseAllowlist({ entries: [{ paths: ['src/'] }] })
    assert.equal(byPath.entries.length, 1)

    const byHash = parseAllowlist({ entries: [{ values: [fingerprintOf(GITHUB_TOKEN)] }] })
    assert.equal(byHash.entries.length, 1)

    const wrongHash = parseAllowlist({ entries: [{ values: [fingerprintOf('something-else-entirely')] }] })
    assert.equal(wrongHash.entries.length, 1)

    const covered = (entries: ReturnType<typeof parseAllowlist>['entries']): string[] =>
        findings.filter((finding) => entries.some((entry) => entryCoversForTest(entry, finding))).map((finding) => finding.rule)

    assert.deepEqual(covered(byRule.entries), ['aws-access-key-id'])
    assert.deepEqual(covered(byPath.entries), ['aws-access-key-id', 'github-token'])
    assert.deepEqual(covered(byHash.entries), ['github-token'])
    assert.deepEqual(covered(wrongHash.entries), [], 'a hash that does not match suppresses nothing')
})

/** `entryCovers` through the public surface (kept here so the test reads declaratively). */
function entryCoversForTest(entry: { rules?: string[]; paths?: string[]; values?: string[] }, finding: { rule: string; path: string; hash: string }): boolean {
    if (entry.rules !== undefined && !entry.rules.includes(finding.rule)) return false
    if (entry.paths !== undefined && !entry.paths.some((pattern) => finding.path === pattern || finding.path.startsWith(pattern.replace(/\/+$/, '') + '/'))) return false
    if (entry.values !== undefined && !entry.values.some((value) => value === finding.hash)) return false
    return true
}

test('an EXPIRED allowlist entry does not apply (and an unparseable one is refused)', () => {
    const entry = { entries: [{ rules: ['aws-access-key-id'], until: '2000-01-01', note: '临时豁免' }] }
    const expired = parseAllowlist(entry)
    assert.equal(expired.entries.length, 0)
    assert.match(expired.problems.join('\n'), /过期/)

    const alive = parseAllowlist(entry, Date.parse('1999-12-31T00:00:00Z'))
    assert.equal(alive.entries.length, 1, 'before the deadline the entry applies')

    assert.equal(parseAllowlist({ entries: [{ rules: ['x'], until: 'not-a-date' }] }).entries.length, 0)
    assert.equal(parseAllowlist({ entries: [{ note: '无条件' }] }).entries.length, 0, 'an unconditional entry is refused')
    assert.equal(parseAllowlist({ entries: [{ rules: [] }] }).entries.length, 0)
    assert.equal(parseAllowlist({ entries: 'nope' }).entries.length, 0)
})

test('an unreadable allowlist suppresses nothing (fail-closed)', () => {
    const cwd = tempWorkspace('scg-allow-')
    write(cwd, '.dsh/secret-allow.json', '{ this is not json')
    const loaded = loadAllowlist(cwd, '.dsh/secret-allow.json')
    assert.equal(loaded.entries.length, 0)
    assert.match(loaded.problems.join('\n'), /不是合法 JSON/)
})

// --- manifest diffing -------------------------------------------------------

test('go.mod: added, removed and changed requirements (block form and indirect)', () => {
    const before = [
        'module example.com/demo',
        '',
        'go 1.26',
        '',
        'require github.com/old/dep v1.0.0',
        '',
        'require (',
        '\tgithub.com/keep/me v1.2.0',
        '\tgithub.com/bump/me v1.0.0 // indirect',
        ')',
    ].join('\n')
    const after = [
        'module example.com/demo',
        '',
        'go 1.26',
        '',
        'require (',
        '\tgithub.com/keep/me v1.2.0',
        '\tgithub.com/bump/me v2.0.0 // indirect',
        '\tgithub.com/brand/new v0.3.1',
        ')',
    ].join('\n')
    const diff = diffManifests({ path: 'go.mod', before, after })
    assert.equal(diff.problem, undefined)
    assert.equal(diff.textChanged, true)
    assert.deepEqual(diff.added, [{ name: 'github.com/brand/new', version: 'v0.3.1', kind: 'require' }])
    assert.deepEqual(diff.removed, [{ name: 'github.com/old/dep', version: 'v1.0.0', kind: 'require' }])
    assert.deepEqual(diff.changed, [{ name: 'github.com/bump/me', from: 'v1.0.0', to: 'v2.0.0', kind: 'require-indirect' }])
    // A brand-new file (absent at base) makes every entry new; an unchanged file
    // produces nothing at all.
    const fresh = diffManifests({ path: 'go.mod', after })
    assert.equal(fresh.added.length, 3)
    assert.deepEqual(diffManifests({ path: 'go.mod', before: after, after }).added, [])
})

test('package.json: dependencies/devDependencies are diffed per section', () => {
    const before = JSON.stringify({ dependencies: { lodash: '^4.17.20', gone: '^1.0.0' }, devDependencies: { vitest: '^1.0.0' } })
    const after = JSON.stringify({ dependencies: { lodash: '^4.17.21', added: '^2.0.0' }, devDependencies: { vitest: '^2.0.0' } })
    const diff = diffManifests({ path: 'package.json', before, after })
    assert.deepEqual(diff.added, [{ name: 'added', version: '^2.0.0', kind: 'dependencies' }])
    assert.deepEqual(diff.removed, [{ name: 'gone', version: '^1.0.0', kind: 'dependencies' }])
    assert.deepEqual(diff.changed, [
        { name: 'lodash', from: '^4.17.20', to: '^4.17.21', kind: 'dependencies' },
        { name: 'vitest', from: '^1.0.0', to: '^2.0.0', kind: 'devDependencies' },
    ])
    const broken = diffManifests({ path: 'package.json', before: '{ not json', after: '{}' })
    assert.match(broken.problem ?? '', /不是合法 JSON/)
})

test('requirements.txt, pyproject.toml and Cargo.toml declare dependencies', () => {
    const requirements = diffManifests({ path: 'requirements.txt', before: 'django==3.0\n# comment\n', after: 'django==4.0\nrequests>=2.31\n-r other.txt\n' })
    assert.deepEqual(requirements.added, [{ name: 'requests', version: '>=2.31', kind: 'requirement' }])
    assert.deepEqual(requirements.changed, [{ name: 'django', from: '==3.0', to: '==4.0', kind: 'requirement' }])

    const pyproject = [
        '[project]',
        'dependencies = [',
        '  "httpx>=0.27",',
        ']',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest>=8"]',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'rich = "^13.0"',
    ].join('\n')
    const parsed = diffManifests({ path: 'pyproject.toml', after: pyproject })
    assert.deepEqual(
        parsed.added.map((entry) => `${entry.name}${entry.version}`).sort(),
        ['httpx>=0.27', 'pytest>=8', 'rich^13.0'],
        'poetry\'s interpreter constraint (`python`) is not a dependency',
    )

    const cargo = diffManifests({ path: 'Cargo.toml', after: '[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nlocal = { path = "../local" }\n' })
    assert.deepEqual(
        cargo.added.map((entry) => `${entry.name}=${entry.version}`).sort(),
        ['local=(path)', 'serde=1.0'],
    )
})

// --- audit parsing ----------------------------------------------------------

const NPM_AUDIT = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
        lodash: { name: 'lodash', severity: 'high', range: '<4.17.21', via: [{ title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-xxxx' }] },
        minimist: { name: 'minimist', severity: 'moderate', via: [{ title: 'Prototype Pollution', url: 'https://example.test' }] },
    },
})

const PIP_AUDIT = JSON.stringify({
    dependencies: [{ name: 'django', version: '2.0', vulns: [{ id: 'GHSA-1234-5678-9012', fix_versions: ['3.0'], description: 'SQL injection\nmore' }] }],
})

const GOVULNCHECK_TEXT = [
    'Scanning your code and 42 packages across 3 dependent modules for known vulnerabilities...',
    '',
    'Vulnerability #1: GO-2022-0969',
    '    HTTP/2 server connections can hang forever',
    '  More info: https://pkg.go.dev/vuln/GO-2022-0969',
    '  Module: golang.org/x/net',
    '    Found in: golang.org/x/net@v0.0.0-2022',
    '    Fixed in: golang.org/x/net@v0.7.0',
    '',
    'Your code is affected by 1 vulnerability.',
].join('\n')

const GOVULNCHECK_JSONL = [
    JSON.stringify({ config: { protocol_version: 'v1.0.0' } }),
    JSON.stringify({
        finding: {
            osv: { id: 'GO-2022-0969', summary: 'HTTP/2 server connections can hang' },
            trace: [{ module: 'golang.org/x/net', vulnerability: 'GO-2022-0969' }],
            fixed_version: 'v0.7.0',
        },
    }),
    '',
].join('\n')

test('parseAuditOutput understands npm audit, pip-audit and both govulncheck shapes', () => {
    const npm = parseAuditOutput({ command: 'npm audit --json', stdout: NPM_AUDIT, stderr: '', exitCode: 1 })
    assert.equal(npm.shape, 'npm-audit-json')
    assert.equal(npm.problem, undefined)
    assert.deepEqual(npm.findings.map((finding) => `${finding.package}:${finding.severity}`), ['lodash:high', 'minimist:moderate'])
    assert.match(npm.findings[0]?.title ?? '', /Prototype Pollution/)

    const pip = parseAuditOutput({ command: 'pip-audit -f json', stdout: PIP_AUDIT, stderr: '', exitCode: 1 })
    assert.equal(pip.shape, 'pip-audit-json')
    assert.deepEqual(pip.findings.map((finding) => `${finding.package}:${finding.id}:${finding.severity}`), ['django:GHSA-1234-5678-9012:unknown'])
    assert.equal(pip.findings[0]?.fixedIn, '3.0')

    const text = parseAuditOutput({ command: 'govulncheck ./...', stdout: GOVULNCHECK_TEXT, stderr: '', exitCode: 3 })
    assert.equal(text.shape, 'govulncheck-text')
    assert.equal(text.findings.length, 1)
    assert.equal(text.findings[0]?.id, 'GO-2022-0969')
    assert.equal(text.findings[0]?.package, 'golang.org/x/net')
    assert.equal(text.findings[0]?.fixedIn, 'golang.org/x/net@v0.7.0')
    assert.equal(text.findings[0]?.severity, 'unknown')

    const jsonl = parseAuditOutput({ command: 'govulncheck -json ./...', stdout: GOVULNCHECK_JSONL, stderr: '', exitCode: 3 })
    assert.equal(jsonl.shape, 'govulncheck-json')
    assert.deepEqual(jsonl.findings.map((finding) => finding.id), ['GO-2022-0969'])

    const generic = parseAuditOutput({
        command: 'custom-audit --json',
        stdout: JSON.stringify({ issues: [{ name: 'foo', severity: 'critical', title: 'bad', url: 'https://example.test/1' }] }),
        stderr: '',
        exitCode: 1,
    })
    assert.equal(generic.shape, 'generic-json')
    assert.deepEqual(generic.findings.map((finding) => `${finding.package}:${finding.severity}`), ['foo:critical'])
})

test('an unknown or unusable audit report is a problem, never "no vulnerabilities"', () => {
    const unknown = parseAuditOutput({ command: 'mystery-audit', stdout: 'everything looks great, trust me', stderr: '', exitCode: 0 })
    assert.equal(unknown.shape, 'unknown')
    assert.equal(unknown.findings.length, 0)
    assert.match(unknown.problem ?? '', /无法识别审计输出格式/)

    const empty = parseAuditOutput({ command: 'mystery-audit', stdout: '', stderr: '', exitCode: 0 })
    assert.match(empty.problem ?? '', /没有任何输出/)

    const failed = parseAuditOutput({ command: 'npm audit --json', stdout: JSON.stringify({ vulnerabilities: {} }), stderr: '', exitCode: 1 })
    assert.match(failed.problem ?? '', /退出码 1 但报告里没有任何条目/)

    const errorObject = parseAuditOutput({ command: 'npm audit --json', stdout: JSON.stringify({ error: { code: 'ENOLOCK', message: 'no lockfile https://user:token@registry' } }), stderr: '', exitCode: 1 })
    assert.match(errorObject.problem ?? '', /ENOLOCK/)
    assert.equal((errorObject.problem ?? '').includes('token'), false, 'the auditor message is never echoed (it can carry credentials)')

    const clean = parseAuditOutput({ command: 'npm audit --json', stdout: 'found 0 vulnerabilities', stderr: '', exitCode: 0 })
    assert.equal(clean.shape, 'text-clean')
    assert.equal(clean.problem, undefined)

    const contaminated = parseAuditOutput({
        command: 'mixed',
        stdout: `${GOVULNCHECK_TEXT}\nNo vulnerabilities found in package foo`,
        stderr: '',
        exitCode: 3,
    })
    assert.equal(contaminated.shape, 'govulncheck-text', 'a "clean" line inside a report that lists findings must not win')
    assert.equal(contaminated.findings.length, 1)
})

test('severity classification: block, warn, and the honest "unknown" bucket', () => {
    const findings = [
        { package: 'a', severity: 'high' },
        { package: 'b', severity: 'moderate' },
        { package: 'c', severity: 'unknown' },
    ]
    const defaults = classifyFindings(findings, { block: ['high', 'critical'], warn: ['moderate', 'medium', 'low'] })
    assert.deepEqual(defaults.blocking.map((finding) => finding.package), ['a'])
    assert.deepEqual(defaults.warning.map((finding) => finding.package), ['b'])
    assert.deepEqual(defaults.unclassified.map((finding) => finding.package), ['c'])

    const strict = classifyFindings(findings, { block: ['high', 'unknown'], warn: [] })
    assert.deepEqual(strict.blocking.map((finding) => finding.package), ['a', 'c'], '"unknown" can be made blocking by config')
})

// --- multi-ecosystem manifests and audit reports (TC-1001 … TC-1008) --------

// Fixtures follow the documented shapes of each auditor. They are inline strings
// on purpose: every value below is obvious test data, and no fixture needs a real
// advisory database to be meaningful.
const COMPOSER_AUDIT = JSON.stringify({
    advisories: {
        'monolog/monolog': [
            {
                advisoryId: 'PKSA-1234',
                packageName: 'monolog/monolog',
                affectedVersions: '>=2.0,<2.9.1',
                title: 'Header injection',
                cve: 'CVE-2024-12345',
                link: 'https://example.test/monolog',
                reportedAt: '2024-01-02T03:04:05+00:00',
                severity: 'High',
            },
        ],
        'guzzlehttp/guzzle': [
            {
                advisoryId: 'PKSA-5678',
                packageName: 'guzzlehttp/guzzle',
                affectedVersions: '>=7.0,<7.8.1',
                title: 'Cookie leak',
                severity: 'low',
            },
        ],
    },
    abandoned: {},
})

const CARGO_AUDIT = JSON.stringify({
    vulnerabilities: {
        found: true,
        count: 2,
        list: [
            {
                advisory: {
                    id: 'RUSTSEC-2021-0079',
                    package: 'hyper',
                    title: 'Integer overflow in parsing',
                    cvss: 7.5,
                    aliases: ['CVE-2021-32714'],
                    url: 'https://rustsec.org/advisories/RUSTSEC-2021-0079',
                },
                versions: { patched: ['>=0.14.10'] },
                package: { name: 'hyper', version: '0.14.9' },
            },
            {
                advisory: { id: 'RUSTSEC-2020-0001', package: 'time', title: 'Segfault in time', aliases: ['CVE-2020-26235'] },
                package: { name: 'time', version: '0.1.0' },
            },
        ],
    },
    warnings: {},
})

const BUNDLER_AUDIT = JSON.stringify({
    results: [
        {
            gem: { name: 'rack', version: '2.0.0' },
            advisory: {
                cve: 'CVE-2022-30123',
                ghsa: 'GHSA-xxxx-yyyy-zzzz',
                title: 'Shell escape sequence',
                criticality: 'high',
                patched_versions: ['~> 2.0.9'],
            },
        },
    ],
    unpatched_gems: [{ name: 'oldgem', version: '1.0.0' }],
})

const DOTNET_AUDIT = JSON.stringify({
    version: 1,
    parameters: '--vulnerable --format json',
    projects: [
        {
            path: 'src/Demo.csproj',
            frameworks: [
                {
                    framework: 'net8.0',
                    topLevelPackages: [
                        {
                            id: 'Newtonsoft.Json',
                            resolvedVersion: '12.0.1',
                            vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr' }],
                        },
                        { id: 'Serilog', resolvedVersion: '3.0.0', vulnerabilities: [] },
                    ],
                    transitivePackages: [
                        {
                            id: 'System.Text.Json',
                            resolvedVersion: '6.0.0',
                            vulnerabilities: [{ severity: 'Moderate', advisoryurl: 'https://github.com/advisories/GHSA-8g4q-xg66-9fp4' }],
                        },
                    ],
                },
            ],
        },
    ],
})

test('composer.json / composer.lock are PHP declarations and a lockfile (TC-1001, TC-1007)', () => {
    const before = JSON.stringify({
        require: { php: '>=8.2', 'ext-json': '*', 'monolog/monolog': '^2.0' },
        'require-dev': { 'phpunit/phpunit': '^10.0' },
    })
    const after = JSON.stringify({
        require: { php: '>=8.3', 'ext-json': '*', 'lib-icu': '*', 'monolog/monolog': '^3.0', 'guzzlehttp/guzzle': '^7.8' },
        'require-dev': { 'phpunit/phpunit': '^10.0' },
    })
    const diff = diffManifests({ path: 'composer.json', before, after })
    assert.equal(diff.problem, undefined)
    assert.equal(diff.format, 'composer.json')
    assert.deepEqual(diff.added, [{ name: 'guzzlehttp/guzzle', version: '^7.8', kind: 'require' }])
    assert.deepEqual(diff.changed, [{ name: 'monolog/monolog', from: '^2.0', to: '^3.0', kind: 'require' }])
    assert.deepEqual(diff.counts, { before: 2, after: 3 }, 'php / ext-* / lib-* are platform packages, not dependencies')
    // A composer.json WITHOUT a lockfile is a normal declaration, not "unable to judge".
    const withoutLock = diffManifests({ path: 'composer.json', before: JSON.stringify({ require: {} }), after })
    assert.equal(withoutLock.problem, undefined)
    assert.equal(withoutLock.added.length, 3)
    assert.match(diffManifests({ path: 'composer.json', before: '{not json', after }).problem ?? '', /不是合法 JSON/)

    // composer.lock is recognised as composer.json's lockfile and parses both sections.
    assert.equal(formatOf('composer.lock'), 'composer.lock')
    assert.equal(isLockfile('composer.lock'), true)
    assert.equal(lockfileManifestOf('composer.lock'), 'composer.json')
    const lock = parseManifest(
        'composer.lock',
        JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '3.0.0' }], 'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }] }),
    )
    assert.equal(lock.problem, undefined)
    assert.deepEqual(lock.entries, [
        { name: 'monolog/monolog', version: '3.0.0', kind: 'packages' },
        { name: 'phpunit/phpunit', version: '10.5.0', kind: 'packages-dev' },
    ])
})

test('Gemfile declares gem lines (groups as kind) and Gemfile.lock is its lockfile (TC-1006)', () => {
    const gemfile = [
        "source 'https://rubygems.org'",
        '',
        "gem 'rails', '~> 7.1'",
        'gem "pg", ">= 1.1", "< 2.0"',
        '',
        'group :development, :test do',
        "  gem 'rspec', '~> 3.13'",
        'end',
        '',
        'gem "local", path: "../local"',
    ].join('\n')
    const diff = diffManifests({ path: 'Gemfile', before: "gem 'rails', '~> 7.0'\n", after: gemfile })
    assert.equal(diff.problem, undefined)
    assert.equal(diff.format, 'Gemfile')
    assert.deepEqual(
        diff.added.map((entry) => `${entry.name}=${entry.version}（${entry.kind}）`),
        ['local=*（gem）', 'pg=>= 1.1（gem）', 'rspec=~> 3.13（group development,test）'],
    )
    assert.deepEqual(diff.changed, [{ name: 'rails', from: '~> 7.0', to: '~> 7.1', kind: 'gem' }])
    assert.equal(isLockfile('Gemfile.lock'), true)
    assert.equal(lockfileManifestOf('Gemfile.lock'), 'Gemfile')
})

test('composer audit JSON becomes findings even on a NON-ZERO exit (TC-1001, TC-1005)', () => {
    const parsed = parseAuditOutput({ command: 'composer audit --format=json', stdout: COMPOSER_AUDIT, stderr: '', exitCode: 1 })
    assert.equal(parsed.shape, 'composer-audit-json')
    assert.equal(parsed.problem, undefined, 'composer exits non-zero when it FINDS advisories: findings win over the exit code')
    assert.deepEqual(
        parsed.findings.map((finding) => `${finding.package}:${finding.severity}:${finding.id}`),
        ['monolog/monolog:high:PKSA-1234', 'guzzlehttp/guzzle:low:PKSA-5678'],
    )
    assert.match(parsed.findings[0]?.title ?? '', /受影响版本 >=2\.0,<2\.9\.1/)
    assert.equal(parsed.findings[0]?.url, 'https://example.test/monolog')

    // Composer 2.x writes a CLEAN report with PHP empty arrays (`[]`, not `{}`):
    // that must be a clean parse, never a false BLOCK.
    const clean = parseAuditOutput({
        command: 'composer audit --format=json',
        stdout: JSON.stringify({ advisories: [], abandoned: [], filter: [] }),
        stderr: '',
        exitCode: 0,
    })
    assert.equal(clean.shape, 'composer-audit-json')
    assert.equal(clean.findings.length, 0)
    assert.equal(clean.problem, undefined)

    // A non-zero exit with NO findings is still "cannot judge" — the guard is unmoved.
    const failed = parseAuditOutput({
        command: 'composer audit --format=json',
        stdout: JSON.stringify({ advisories: [], abandoned: [] }),
        stderr: '',
        exitCode: 1,
    })
    assert.equal(failed.shape, 'composer-audit-json')
    assert.equal(failed.findings.length, 0)
    assert.match(failed.problem ?? '', /退出码 1 但报告里没有任何条目/)
})

test('composer `abandoned` entries are their own finding class, never dropped (TC-1002)', () => {
    const parsed = parseAuditOutput({
        command: 'composer audit --format=json',
        // The real shape when there are no advisories: `advisories` is `[]`, and
        // Composer 2.10 writes `null` for "no replacement was suggested".
        stdout: JSON.stringify({ advisories: [], abandoned: { 'old/pkg': 'no replacement', 'gone/pkg': null } }),
        stderr: '',
        exitCode: 0,
    })
    assert.equal(parsed.shape, 'composer-audit-json')
    assert.equal(parsed.problem, undefined)
    assert.deepEqual(
        parsed.findings.map((finding) => `${finding.package}:${finding.kind}:${finding.severity}`),
        ['gone/pkg:abandoned:info', 'old/pkg:abandoned:info'],
        'an abandoned package is not a CVE: its own kind, and `info` — NOT `unknown`, which would make a block list containing "unknown" (meant for unparseable vulnerabilities) block every deprecation',
    )
    assert.match(parsed.findings[1]?.title ?? '', /包已废弃.*no replacement/)
})

test('cargo audit, bundler-audit and dotnet vulnerable JSON are recognised (TC-1003)', () => {
    const cargo = parseAuditOutput({ command: 'cargo audit --json', stdout: CARGO_AUDIT, stderr: '', exitCode: 1 })
    assert.equal(cargo.shape, 'cargo-audit-json')
    assert.equal(cargo.problem, undefined)
    assert.deepEqual(
        cargo.findings.map((finding) => `${finding.package}:${finding.severity}:${finding.id}`),
        ['hyper:high:RUSTSEC-2021-0079', 'time:unknown:RUSTSEC-2020-0001'],
    )
    assert.equal(cargo.findings[0]?.fixedIn, '>=0.14.10', 'the CVSS score maps onto the severity vocabulary')
    const cleanCargo = parseAuditOutput({
        command: 'cargo audit --json',
        stdout: JSON.stringify({ vulnerabilities: { found: false, count: 0, list: [] } }),
        stderr: '',
        exitCode: 0,
    })
    assert.equal(cleanCargo.shape, 'cargo-audit-json')
    assert.equal(cleanCargo.findings.length, 0)
    assert.equal(cleanCargo.problem, undefined)

    const bundler = parseAuditOutput({ command: 'bundle audit check --format json', stdout: BUNDLER_AUDIT, stderr: '', exitCode: 1 })
    assert.equal(bundler.shape, 'bundler-audit-json')
    assert.deepEqual(
        bundler.findings.map((finding) => `${finding.package}:${finding.severity}:${finding.id ?? finding.kind}`),
        ['rack:high:CVE-2022-30123', 'oldgem:unknown:unpatched'],
    )
    assert.equal(bundler.findings[0]?.fixedIn, '~> 2.0.9')
    const cleanBundler = parseAuditOutput({
        command: 'bundle audit check --format json',
        stdout: JSON.stringify({ results: [], unpatched_gems: [] }),
        stderr: '',
        exitCode: 0,
    })
    assert.equal(cleanBundler.shape, 'bundler-audit-json')
    assert.equal(cleanBundler.problem, undefined)

    const dotnet = parseAuditOutput({ command: 'dotnet list package --vulnerable --format json', stdout: DOTNET_AUDIT, stderr: '', exitCode: 0 })
    assert.equal(dotnet.shape, 'dotnet-vulnerable-json')
    assert.equal(dotnet.problem, undefined)
    assert.deepEqual(
        dotnet.findings.map((finding) => `${finding.package}:${finding.severity}:${finding.id}`),
        ['Newtonsoft.Json:high:GHSA-5crp-9r3c-p9vr', 'System.Text.Json:moderate:GHSA-8g4q-xg66-9fp4'],
    )
    assert.equal(dotnet.findings[0]?.url, 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr')
    // The older SDK shape puts the package lists directly on the project.
    const flat = parseAuditOutput({
        command: 'dotnet list package --vulnerable --format json',
        stdout: JSON.stringify({
            projects: [
                {
                    path: 'src/demo.csproj',
                    topLevelPackages: [
                        { id: 'A', resolvedVersion: '1.0.0', vulnerabilities: [{ severity: 'Low', advisoryurl: 'https://example.test/advisories/GHSA-aaaa-bbbb-cccc' }] },
                    ],
                },
            ],
        }),
        stderr: '',
        exitCode: 0,
    })
    assert.equal(flat.shape, 'dotnet-vulnerable-json')
    assert.deepEqual(flat.findings.map((finding) => `${finding.package}:${finding.severity}:${finding.id}`), ['A:low:GHSA-aaaa-bbbb-cccc'])
})

test('a document that only LOOKS like one of the new shapes still fails closed (TC-1004)', () => {
    for (const [name, stdout] of [
        ['composer', JSON.stringify({ advisories: [] })],
        ['composer', JSON.stringify({ advisories: {} })],
        ['dotnet', JSON.stringify({ projects: [] })],
        ['bundler', JSON.stringify({ results: [] })],
    ] as const) {
        const parsed = parseAuditOutput({ command: `${name} audit`, stdout, stderr: '', exitCode: 0 })
        assert.equal(parsed.shape, 'unknown', `${name}: an empty/ambiguous document is not evidence of a clean repository`)
        assert.match(parsed.problem ?? '', /找不到任何 severity/)
    }
})

// --- shell-free command tokenising ------------------------------------------

test('audit commands are tokenised without a shell and shell metacharacters are refused', () => {
    assert.deepEqual(splitAuditCommand('govulncheck ./...'), { argv: ['govulncheck', './...'] })
    assert.deepEqual(splitAuditCommand('npm  audit   --json'), { argv: ['npm', 'audit', '--json'] })
    for (const command of ['npm audit | tee out.txt', 'npm audit > out.txt', 'npm audit && echo done', 'npm audit $(whoami)', 'npm audit `id`', 'npm audit --json # note', 'npm audit &']) {
        const result = splitAuditCommand(command)
        assert.ok('error' in result, `${command} must be refused`)
        assert.match((result as { error: string }).error, /shell 元字符/)
    }
})

// --- tool surface: secret_scan ---------------------------------------------

test('secret_scan records a BLOCK gate, writes a redacted artifact, and quotes the coverage', async () => {
    const cwd = tempWorkspace('scg-scan-')
    write(cwd, 'src/config.ts', `export const awsKey = "${AWS_KEY_ID}"\nexport const fine = 1\n`)
    const missionId = bindMission(cwd)
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('secret_scan', { wholeTree: true }))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /aws-access-key-id/)
    assert.match(out, /AKIA…LE（长度 20）/)
    assert.match(out, /扫描：1\/1 个文件/)
    assert.match(out, /下一步：/)

    const recorded = gates(cwd, missionId)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.state, 'BLOCK')
    assert.equal(recorded[0]?.source, 'dsh-supply-chain-gate')
    assert.equal(recorded[0]?.scope?.selected.join(','), 'secret-scan')
    assert.equal(recorded[0]?.scope?.full, true)
    assert.ok(recorded[0]?.fingerprint !== undefined)

    const artifacts = artifactText(cwd, missionId)
    assert.equal(artifacts.includes(AWS_KEY_ID), false, 'the artifact must never contain the raw secret')
    assert.equal(out.includes(AWS_KEY_ID), false, 'the report must never contain the raw secret')
    assert.match(artifacts, /"hash"/)

    const status = runText(await fake.runTool('supply_chain_status', {}))
    assert.match(status, /规则：11 条/)
    assert.match(status, /最新门禁：BLOCK/)
    assert.match(status, /未豁免的匹配：1 条/)
})

test('secret_scan: a secret on an UNCHANGED line is invisible to the diff scan, visible to wholeTree', async () => {
    const cwd = gitRepo('scg-diff-')
    write(cwd, 'src/legacy.ts', ['export const a = 1', `export const leaked = "${AWS_KEY_ID}"`, 'export const b = 2'].join('\n'))
    commitAll(cwd, 'legacy file with an old secret')

    // A change that does NOT touch line 2.
    write(cwd, 'src/legacy.ts', ['export const a = 1', `export const leaked = "${AWS_KEY_ID}"`, 'export const b = 2', 'export const c = 3'].join('\n'))
    const fake = host(cwd, {})
    const diffScan = runText(await fake.runTool('secret_scan', {}))
    assert.match(diffScan, /范围：改动新增行/)
    assert.match(diffScan, /裁决：(WARN|PASS)/)
    assert.equal(diffScan.includes('aws-access-key-id'), false, 'the unchanged line is not reported')

    const treeScan = runText(await fake.runTool('secret_scan', { wholeTree: true }))
    assert.match(treeScan, /裁决：BLOCK/)
    assert.match(treeScan, /src\/legacy\.ts:2/)
})

test('secret_scan: explicit paths are scanned whole-file, and escapes are refused', async () => {
    const cwd = tempWorkspace('scg-paths-')
    write(cwd, 'config/dev.env', `TOKEN=${GITHUB_TOKEN}\n`)
    const outside = path.join(cwd, '..', `outside-${path.basename(cwd)}.env`)
    fs.writeFileSync(outside, `TOKEN=${SLACK_TOKEN}\n`)
    try {
        const fake = host(cwd, {})
        const out = runText(await fake.runTool('secret_scan', { paths: ['config/dev.env', '../outside.env', 'missing.env', 'config'] }))
        assert.match(out, /范围：显式 paths（整文件）/)
        assert.match(out, /裁决：BLOCK/)
        assert.match(out, /github-token/)
        assert.match(out, /路径在工作区之外（已拒绝）（1）：\.\.\/outside\.env/)
        assert.match(out, /不存在（1）：missing\.env/)
        assert.match(out, /不是普通文件（1）：config/)
        assert.equal(out.includes(SLACK_TOKEN), false, 'the refused path was never read')
    } finally {
        fs.rmSync(outside, { force: true })
    }
})

test('secret_scan: binary files are skipped and reported; an empty scan is WARN, never PASS', async () => {
    const cwd = tempWorkspace('scg-binary-')
    fs.writeFileSync(path.join(cwd, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))
    const fake = host(cwd, {})
    const skipped = runText(await fake.runTool('secret_scan', { paths: ['logo.png'] }))
    assert.match(skipped, /二进制（不参与匹配）（1）：logo\.png/)
    assert.match(skipped, /裁决：WARN/, 'a scan that read nothing is not a pass')
    assert.match(skipped, /"没扫到"不等于"干净"/)

    const empty = runText(await fake.runTool('secret_scan', { paths: [] }))
    assert.match(empty, /裁决：WARN/)
})

test('secret_scan: an oversized file is skipped, downgrades coverage and says so', async () => {
    const cwd = tempWorkspace('scg-large-')
    write(cwd, 'big.txt', `x\n`.repeat(2_000))
    const fake = host(cwd, { secretScan: { maxFileBytes: 1_024 } })
    const out = runText(await fake.runTool('secret_scan', { paths: ['big.txt'] }))
    assert.match(out, /超过 maxFileBytes（未扫描）（1）：big\.txt/)
    assert.match(out, /裁决：WARN/)
})

test('secret_scan honours the repository allowlist and reports the entry that suppressed', async () => {
    const cwd = tempWorkspace('scg-allow-scan-')
    write(cwd, 'src/keys.ts', `export const aws = "${AWS_KEY_ID}"\nexport const gh = "${GITHUB_TOKEN}"\n`)
    write(
        cwd,
        '.dsh/secret-allow.json',
        `${JSON.stringify({ entries: [{ rules: ['aws-access-key-id'], note: 'AWS 文档示例值' }] }, undefined, 2)}\n`,
    )
    const missionId = bindMission(cwd)
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('secret_scan', { wholeTree: true }))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /github-token/)
    assert.equal(out.includes('aws-access-key-id |'), false, 'the allowlisted rule is not listed as a finding')
    assert.match(out, /另有 1 处匹配被 allowlist 豁免/)
    assert.match(out, /AWS 文档示例值/)
    const artifact = artifactText(cwd, missionId)
    assert.match(artifact, /"allowlisted"/)
    assert.equal(artifact.includes(GITHUB_TOKEN), false, 'an allowlisted secret is still never written raw')
})

test('TC-1315 a migrated repository reads its secret allowlist from the NAMESPACE root', async () => {
    // `.dsh/` is shared with other tooling; the suite moved into
    // `.dsh/engineering-suite/`. A literal legacy default meant a migrated
    // repository's exemptions were never read — every accepted value blocked again.
    const cwd = tempWorkspace('scg-allow-namespace-')
    fs.mkdirSync(path.join(cwd, '.dsh', 'engineering-suite'), { recursive: true })
    write(cwd, 'src/keys.ts', `export const aws = "${AWS_KEY_ID}"\n`)
    write(
        cwd,
        '.dsh/engineering-suite/secret-allow.json',
        `${JSON.stringify({ entries: [{ rules: ['aws-access-key-id'], note: 'AWS 文档示例值' }] }, undefined, 2)}\n`,
    )
    bindMission(cwd)
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('secret_scan', { wholeTree: true }))
    assert.match(out, /另有 1 处匹配被 allowlist 豁免/, out)
    assert.match(out, /engineering-suite\/secret-allow\.json/, 'the report names the file the scan read')
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'secret-allow.json')), false, 'the legacy allowlist is not what was read')
})

test('secret_scan is honest when the workspace is not a git repository', async () => {
    const cwd = tempWorkspace('scg-nogit-')
    write(cwd, 'a.txt', 'nothing to see')
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('secret_scan', {}))
    assert.match(out, /裁决：WARN/)
    assert.match(out, /无法确定改动范围（base="HEAD"）/)
    assert.match(out, /下一步：/)
})

test('secret_scan refuses to run when the host disabled it, and records nothing', async () => {
    const cwd = tempWorkspace('scg-off-')
    const missionId = bindMission(cwd)
    const fake = host(cwd, { secretScan: { enabled: false } })
    const out = runText(await fake.runTool('secret_scan', { wholeTree: true }))
    assert.match(out, /已被宿主禁用/)
    assert.equal(gates(cwd, missionId).length, 0, 'a disabled gate writes no verdict')
})

// --- tool surface: dependency_audit ----------------------------------------

test('dependency_audit asks approval ONCE for every new dependency and records PASS when the audit is clean', async () => {
    const cwd = gitRepo('scg-deps-')
    write(cwd, 'package.json', `${JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.20' } }, undefined, 2)}\n`)
    commitAll(cwd, 'base manifest')
    write(
        cwd,
        'package.json',
        `${JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.21', leftpad: '^1.0.0' }, devDependencies: { vitest: '^2.0.0' } }, undefined, 2)}\n`,
    )
    const command = auditScript(cwd, "process.stdout.write('found 0 vulnerabilities\\n')\n")
    const missionId = bindMission(cwd)
    const fake = host(cwd, { deps: { auditCommands: [command] } })

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.equal(fake.approvals.length, 1, 'all new dependencies ride in ONE prompt')
    assert.match(fake.approvals[0] ?? '', /leftpad \^1\.0\.0（dependencies）/)
    assert.match(fake.approvals[0] ?? '', /vitest \^2\.0\.0（devDependencies）/)
    assert.match(out, /新增 2/)
    assert.match(out, /版本变更 1/)
    assert.match(out, /→ allowed-once/)
    assert.match(out, /shape=text-clean/)
    assert.match(out, /裁决：PASS/)
    const recorded = gates(cwd, missionId)
    assert.equal(recorded.at(-1)?.state, 'PASS')
    assert.equal(recorded.at(-1)?.scope?.full, true)
    assert.deepEqual(recorded.at(-1)?.results.map((result) => result.id), ['manifest-diff', 'new-deps-approval', 'audit-1'])
    assert.match(artifactText(cwd, missionId), /"newDependencies"/)
})

test('dependency_audit: a refused (or unavailable) approval is a BLOCK', async () => {
    const cwd = gitRepo('scg-refused-')
    write(cwd, 'package.json', `${JSON.stringify({ dependencies: {} }, undefined, 2)}\n`)
    commitAll(cwd, 'base')
    write(cwd, 'package.json', `${JSON.stringify({ dependencies: { leftpad: '^1.0.0' } }, undefined, 2)}\n`)
    const refused = host(cwd, {}, { approvalDecision: 'rejected' })
    const out = runText(await refused.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /新增依赖未获批（rejected）/)
    assert.match(out, /下一步：/)

    const unavailable = host(cwd, {}, { withApproval: false })
    const out2 = runText(await unavailable.runTool('dependency_audit', {}))
    assert.match(out2, /裁决：BLOCK/)
    assert.match(out2, /unavailable/)
    assert.match(out2, /ctx.get\("approval"\) 为空/)
})

test('dependency_audit: no manifest change and no audit command is a WARN that explains what to configure', async () => {
    const cwd = gitRepo('scg-nothing-')
    write(cwd, 'package.json', `${JSON.stringify({ dependencies: {} })}\n`)
    commitAll(cwd, 'base')
    const missionId = bindMission(cwd)
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /裁决：WARN/)
    assert.match(out, /没有可判定的对象/)
    assert.match(out, /配置 deps\.auditCommands/)
    assert.equal(gates(cwd, missionId).at(-1)?.state, 'WARN', 'never a silent PASS')
})

test('dependency_audit: an orphan lockfile change is a BLOCK (the manifest did not change)', async () => {
    const cwd = gitRepo('scg-orphan-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n\nrequire github.com/keep/me v1.2.0\n')
    write(cwd, 'go.sum', 'github.com/keep/me v1.2.0 h1:aaaa\n')
    commitAll(cwd, 'base')
    write(cwd, 'go.sum', 'github.com/keep/me v1.2.0 h1:aaaa\ngithub.com/sneaky/dep v0.0.1 h1:bbbb\n')
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /孤儿变更 1 个（go\.sum 变了但 go\.mod 没变）/)
    assert.match(out, /下一步：锁文件出现了没有声明依据的变更/)

    // …and when the declaring manifest changes too, the same lockfile is normal.
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n\nrequire github.com/keep/me v1.3.0\n')
    const together = runText(await fake.runTool('dependency_audit', {}))
    assert.match(together, /与声明文件一起变更 1 个（正常）/)
    assert.equal(/裁决：BLOCK/.test(together), false)
})

test('dependency_audit: a blocking severity BLOCKs, unknown severities warn and can be promoted by config', async () => {
    const cwd = gitRepo('scg-audit-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    commitAll(cwd, 'base')
    const npmish = auditScript(cwd, `process.stdout.write(${JSON.stringify(JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', via: [{ title: 'Prototype Pollution' }] } } }))})\n`)
    const blocking = host(cwd, { deps: { auditCommands: [npmish] } })
    const out = runText(await blocking.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /block=1/)

    const govuln = auditScript(cwd, `process.stdout.write(${JSON.stringify(GOVULNCHECK_TEXT)})\n`, 'scripts/vuln.js')
    const warned = host(cwd, { deps: { auditCommands: [govuln] } })
    const out2 = runText(await warned.runTool('dependency_audit', {}))
    assert.match(out2, /裁决：WARN/, 'govulncheck carries no severity, so it cannot block by default')
    assert.match(out2, /未分类 1/)
    assert.match(out2, /把 "unknown"（或报告里的真实 severity）加进 deps\.auditSeverities\.block/)

    const strict = host(cwd, { deps: { auditCommands: [govuln], auditSeverities: { block: ['high', 'critical', 'unknown'], warn: [] } } })
    const out3 = runText(await strict.runTool('dependency_audit', {}))
    assert.match(out3, /裁决：BLOCK/)
    assert.match(out3, /block=1/)
})

test('dependency_audit: an unrecognised report, a refused command and a timeout all BLOCK', async () => {
    const cwd = gitRepo('scg-problem-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    commitAll(cwd, 'base')

    const garbage = auditScript(cwd, "process.stdout.write('all good, promise\\n')\n")
    const unknown = host(cwd, { deps: { auditCommands: [garbage] } })
    const out = runText(await unknown.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /无法识别审计输出格式/)

    const piped = host(cwd, { deps: { auditCommands: ['npm audit --json | tee out.json'] } })
    const out2 = runText(await piped.runTool('dependency_audit', {}))
    assert.match(out2, /裁决：BLOCK/)
    assert.match(out2, /配置被拒绝/)
    assert.match(out2, /shell 元字符/)

    const broken = host(cwd, { deps: { auditCommands: ['definitely-not-an-auditor --json'] } }, { withSubprocess: false })
    const out3 = runText(await broken.runTool('dependency_audit', {}))
    assert.match(out3, /裁决：BLOCK/)
    assert.match(out3, /无法启动审计命令/)
})

test('dependency_audit: an aborted turn records no verdict', async () => {
    const cwd = gitRepo('scg-abort-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    commitAll(cwd, 'base')
    const missionId = bindMission(cwd)
    const fake = host(cwd, {})
    const controller = new AbortController()
    controller.abort()
    const out = runText(await fake.runTool('dependency_audit', {}, { signal: controller.signal }))
    assert.match(out, /被取消/)
    assert.equal(gates(cwd, missionId).length, 0)
})

test('dependency_audit: an unresolvable base is not "everything is new" (regression)', async () => {
    // `diffManifests` treats a missing "before" as an empty file. Without the
    // guard, a typo in `base` would make every lockfile look like an orphan
    // change and BLOCK the delivery for a reason that does not exist.
    const cwd = gitRepo('scg-badbase-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    write(cwd, 'go.sum', 'github.com/keep/me v1.2.0 h1:aaaa\n')
    commitAll(cwd, 'base')
    write(cwd, 'go.sum', 'github.com/keep/me v1.2.0 h1:aaaa\ngithub.com/other/dep v0.0.1 h1:bbbb\n')
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('dependency_audit', { base: 'no-such-ref' }))
    assert.match(out, /裁决：WARN/)
    assert.equal(out.includes('孤儿变更 1'), false, 'an unreadable base must not manufacture an orphan lockfile')
    assert.match(out, /无法解析 base "no-such-ref"/)
})

test('dependency_audit: a audit command that times out BLOCKs (fail-closed)', async () => {
    const cwd = gitRepo('scg-timeout-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    commitAll(cwd, 'base')
    const slow = auditScript(cwd, 'setTimeout(() => process.stdout.write("found 0 vulnerabilities\\n"), 60000)\n')
    // The child-process transport honours `timeoutMs` (the fake subprocess seam
    // does not model deadlines), so this case uses the fallback transport.
    const fake = host(cwd, { deps: { auditCommands: [slow] }, auditTimeoutMs: 5_000 }, { withSubprocess: false })
    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /审计命令超时（5000ms）后被杀/)
})

test('dependency_audit: composer advisories on a NON-ZERO exit are judged, not "无法判定" (TC-1001)', async () => {
    const cwd = gitRepo('scg-composer-')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^2.0' } }, undefined, 2)}\n`)
    write(cwd, 'composer.lock', `${JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '2.0.0' }] }, undefined, 2)}\n`)
    commitAll(cwd, 'base')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^3.0', 'guzzlehttp/guzzle': '^7.8' } }, undefined, 2)}\n`)
    write(
        cwd,
        'composer.lock',
        `${JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '3.0.0' }, { name: 'guzzlehttp/guzzle', version: '7.8.0' }] }, undefined, 2)}\n`,
    )
    // composer exits 1 when it FINDS advisories — the exact shape that used to
    // come back as "unable to judge".
    const command = auditScript(cwd, `process.stdout.write(${JSON.stringify(COMPOSER_AUDIT)}); process.exitCode = 1\n`)
    const missionId = bindMission(cwd)
    const fake = host(cwd, { deps: { auditCommands: [command] }, auditTimeoutMs: 8_000 })

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.equal(fake.approvals.length, 1)
    assert.match(fake.approvals[0] ?? '', /guzzlehttp\/guzzle \^7\.8（require）/)
    assert.match(out, /新增 1/)
    assert.match(out, /shape=composer-audit-json/)
    assert.match(out, /findings=2/)
    assert.match(out, /exit=1/)
    assert.equal(/无法识别审计输出格式/.test(out), false, 'the exit code must not hide a report it understood')
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /block=1/)
    assert.equal(gates(cwd, missionId).at(-1)?.state, 'BLOCK')
    assert.match(artifactText(cwd, missionId), /composer-audit-json/)

    // …and a CLEAN composer report (`[]` for the empty PHP arrays) is a PASS: the
    // gate must not turn "nothing found" into "unable to judge".
    const clean = JSON.stringify({ advisories: [], abandoned: [], filter: [] })
    const cleanCommand = auditScript(cwd, `process.stdout.write(${JSON.stringify(clean)})\n`, 'scripts/clean-audit.js')
    const cleanHost = host(cwd, { deps: { auditCommands: [cleanCommand] }, auditTimeoutMs: 8_000 })
    const cleanOut = runText(await cleanHost.runTool('dependency_audit', {}))
    assert.match(cleanOut, /shape=composer-audit-json/)
    assert.match(cleanOut, /findings=0/)
    assert.match(cleanOut, /裁决：PASS/)
})

test('dependency_audit: composer abandoned packages are their own class (TC-1002)', async () => {
    const cwd = gitRepo('scg-abandoned-')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'old/pkg': '^1.0' } }, undefined, 2)}\n`)
    commitAll(cwd, 'base')
    const abandoned = JSON.stringify({ advisories: {}, abandoned: { 'old/pkg': 'no replacement' } })
    const command = auditScript(cwd, `process.stdout.write(${JSON.stringify(abandoned)})\n`)
    const missionId = bindMission(cwd)
    const fake = host(cwd, { deps: { auditCommands: [command] }, auditTimeoutMs: 8_000 })

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /shape=composer-audit-json/)
    assert.match(out, /findings=1/)
    assert.match(out, /advisory=1/)
    assert.equal(out.includes('未分类 1'), false, 'deprecations are a KNOWN class, not an unparseable severity')
    // Abandoned carries no severity: reported + WARN, never silently dropped and
    // never a BLOCK unless a host puts "unknown" in the block list.
    assert.match(out, /裁决：WARN/)
    assert.match(artifactText(cwd, missionId), /"kind": "abandoned"/)
})

test('dependency_audit: composer.lock / Gemfile.lock / packages.lock.json are orphan-checked (TC-1006)', async () => {
    const cwd = gitRepo('scg-orphans-')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^2.0' } })}\n`)
    write(cwd, 'composer.lock', `${JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '2.0.0' }] })}\n`)
    write(cwd, 'Gemfile', "source 'https://rubygems.org'\n\ngem 'rack', '~> 2.0'\n")
    write(cwd, 'Gemfile.lock', 'GEM\n  specs:\n    rack (2.0.0)\n')
    write(cwd, 'Demo.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>\n')
    write(cwd, 'packages.lock.json', `${JSON.stringify({ version: 1, dependencies: {} })}\n`)
    commitAll(cwd, 'base')
    // Every lockfile changes; none of the declaring manifests does.
    write(cwd, 'composer.lock', `${JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '2.1.0' }] })}\n`)
    write(cwd, 'Gemfile.lock', 'GEM\n  specs:\n    rack (2.0.1)\n')
    write(cwd, 'packages.lock.json', `${JSON.stringify({ version: 1, dependencies: { 'Newtonsoft.Json': {} } })}\n`)
    const fake = host(cwd, {})

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /裁决：BLOCK/)
    assert.match(out, /composer\.lock 变了但 composer\.json 没变/)
    assert.match(out, /Gemfile\.lock 变了但 Gemfile 没变/)
    assert.match(out, /packages\.lock\.json 变了但 \*\.csproj 没变/, 'a .NET lockfile belongs to whichever .csproj sits beside it')

    // Now the declarations change too: the same lockfiles are no longer orphans.
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^2.1' } })}\n`)
    write(cwd, 'Gemfile', "source 'https://rubygems.org'\n\ngem 'rack', '~> 2.0.1'\n")
    write(cwd, 'Demo.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>2.0.0</Version></PropertyGroup></Project>\n')
    const together = runText(await fake.runTool('dependency_audit', {}))
    assert.match(together, /与声明文件一起变更 3 个（正常）/)
    assert.equal(/裁决：BLOCK/.test(together), false)
})

test('dependency_audit: a composer.json without a lockfile parses, and the advice names the PHP command (TC-1007)', async () => {
    const cwd = gitRepo('scg-composer-only-')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^2.0' } })}\n`)
    commitAll(cwd, 'base')
    write(cwd, 'composer.json', `${JSON.stringify({ require: { 'monolog/monolog': '^3.0', 'guzzlehttp/guzzle': '^7.8' } })}\n`)
    const fake = host(cwd, {})

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /新增 1/)
    assert.match(out, /版本变更 1/)
    assert.match(out, /孤儿变更 0 个/, 'a missing lockfile is not a problem')
    assert.match(out, /裁决：WARN/, 'no audit command configured: it can only be a WARN, never a PASS')
    assert.match(out, /composer audit --format=json/)
})

test('the "no audit command" advice names a command for each detected ecosystem (TC-1008 / AC-004)', async () => {
    const cwd = gitRepo('scg-advice-')
    write(cwd, 'go.mod', 'module example.com/demo\n\ngo 1.26\n')
    write(cwd, 'package.json', `${JSON.stringify({ dependencies: {} })}\n`)
    write(cwd, 'requirements.txt', 'django==5.0\n')
    write(cwd, 'Cargo.toml', '[dependencies]\nserde = "1.0"\n')
    write(cwd, 'composer.json', `${JSON.stringify({ require: {} })}\n`)
    write(cwd, 'Gemfile', "source 'https://rubygems.org'\n")
    write(cwd, 'packages.lock.json', `${JSON.stringify({ version: 1, dependencies: {} })}\n`)
    commitAll(cwd, 'base')
    const fake = host(cwd, {})

    const out = runText(await fake.runTool('dependency_audit', {}))
    assert.match(out, /裁决：WARN/)
    assert.match(out, /配置 deps\.auditCommands/)
    // The existing suggestions stay, and every detected ecosystem adds its own.
    assert.match(out, /govulncheck \.\/\.\.\./)
    assert.match(out, /npm audit --json/)
    assert.match(out, /pip-audit --format json/)
    assert.match(out, /cargo audit --json/)
    assert.match(out, /composer audit --format=json/)
    assert.match(out, /bundle audit check --format json/)
    assert.match(out, /dotnet list package --vulnerable --format json/)

    const status = runText(await fake.runTool('supply_chain_status', {}))
    assert.match(status, /审计命令（0）：\*\*未配置\*\*/)
    assert.match(status, /composer audit --format=json/)
})

test('secret_scan never scans the engineering trail, and says so in the design notes', async () => {
    const cwd = gitRepo('scg-trail-')
    write(cwd, '.dsh/notes.md', `note: ${GITHUB_TOKEN}\n`)
    git(cwd, ['add', '-f', '.dsh/notes.md'])
    git(cwd, ['commit', '-q', '-m', 'track a trail note'])
    write(cwd, '.dsh/notes.md', `note: ${GITHUB_TOKEN}\nmore: ${SLACK_TOKEN}\n`)
    const fake = host(cwd, {})
    const out = runText(await fake.runTool('secret_scan', {}))
    assert.equal(out.includes(GITHUB_TOKEN), false)
    assert.match(out, /裁决：WARN/, 'nothing outside the trail changed, so nothing was scanned')
})

test('an unknown mission id is refused instead of silently recording nothing', async () => {
    const cwd = tempWorkspace('scg-mission-')
    const fake = host(cwd, {})
    const run = await fake.runTool('secret_scan', { wholeTree: true, missionId: 'does-not-exist' })
    assert.equal(run.isError, true)
    assert.match(runText(run), /未知 mission/)
})

// --- configuration ----------------------------------------------------------

test('a project override refines the allowed keys and never resets the others (regression)', () => {
    const cwd = tempWorkspace('scg-overlay-')
    write(
        cwd,
        '.dsh/supply-chain-gate.json',
        `${JSON.stringify(
            {
                secretScan: { entropyThreshold: 5.5, scanWholeTree: true, allowlistFile: '.dsh/allow.json' },
                deps: { auditCommands: ['govulncheck ./...'], manifests: ['go.mod', 'go.sum'] },
                maxFiles: 99,
            },
            undefined,
            2,
        )}\n`,
    )
    const hostConfig = resolveConfig({
        secretScan: { maxFileBytes: 4_096, entropyThreshold: 4.0 },
        deps: { auditCommands: ['npm audit --json'], requireApprovalForNewDeps: true },
        maxManifestBytes: 111_111,
    })
    const layout = new MissionStoreRegistry().for(cwd).layout
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.equal(effective.config.secretScan.entropyThreshold, 5.5, 'the named key applies')
    assert.equal(effective.config.secretScan.scanWholeTree, true)
    assert.equal(effective.config.secretScan.allowlistFile, '.dsh/allow.json')
    assert.equal(effective.config.secretScan.maxFileBytes, 4_096, 'unnamed keys keep the profile value')
    assert.equal(effective.config.deps.requireApprovalForNewDeps, true)
    assert.deepEqual(effective.config.deps.auditCommands, ['govulncheck ./...'])
    assert.equal(effective.config.maxFiles, 99)
    assert.equal(effective.config.maxManifestBytes, 111_111, 'the overlay never resets a field it does not name')
    assert.equal(effective.config.prompt.order, 645)
})

test('a project config cannot switch a gate off or excuse itself from approving new dependencies', () => {
    const cwd = tempWorkspace('scg-overlay-forbidden-')
    write(
        cwd,
        '.dsh/supply-chain-gate.json',
        `${JSON.stringify(
            { enabled: false, secretScan: { enabled: false }, deps: { enabled: false, requireApprovalForNewDeps: false }, logFile: '/tmp/x.log' },
            undefined,
            2,
        )}\n`,
    )
    const hostConfig = resolveConfig({})
    const layout = new MissionStoreRegistry().for(cwd).layout
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'profile', 'nothing valid applied → the profile stays in force')
    assert.equal(effective.config.enabled, true)
    assert.equal(effective.config.secretScan.enabled, true)
    assert.equal(effective.config.deps.enabled, true)
    assert.equal(effective.config.deps.requireApprovalForNewDeps, true)
    assert.equal(effective.config.logFile, hostConfig.logFile)
    const problems = effective.problems.join('\n')
    assert.match(problems, /键 "enabled" 不允许/)
    assert.match(problems, /secretScan\.enabled 不允许/)
    assert.match(problems, /deps\.enabled 不允许/)
    assert.match(problems, /deps\.requireApprovalForNewDeps 不允许/)
    assert.match(problems, /键 "logFile" 不允许/)
})

test('the profile defaults are the ones the suite documents', () => {
    const config = resolveConfig({})
    assert.equal(config.secretScan.enabled, true)
    assert.equal(config.secretScan.entropyThreshold, 4.0)
    assert.equal(config.secretScan.allowlistFile, '', 'the default is "follow the layout root", not a literal path')
    // …which is `<rootDir>/secret-allow.json`: `.dsh/` before the migration, the
    // namespace directory after it.
    const legacy = tempWorkspace('scg-allowlist-legacy-')
    assert.equal(allowlistFileOf(legacy, config), '.dsh/secret-allow.json')
    const migrated = tempWorkspace('scg-allowlist-namespace-')
    fs.mkdirSync(path.join(migrated, '.dsh', 'engineering-suite'), { recursive: true })
    assert.equal(allowlistFileOf(migrated, config), '.dsh/engineering-suite/secret-allow.json')
    assert.equal(allowlistFileOf(migrated, resolveConfig({ secretScan: { allowlistFile: 'ops/allow.json' } })), 'ops/allow.json')
    assert.equal(config.secretScan.scanWholeTree, false)
    assert.equal(config.deps.enabled, true)
    assert.equal(config.deps.requireApprovalForNewDeps, true)
    assert.deepEqual(config.deps.manifests.slice(0, 3), ['go.mod', 'go.sum', 'package.json'])
    assert.deepEqual(config.deps.auditCommands, [])
    assert.deepEqual(config.deps.auditSeverities, { block: ['critical', 'high'], warn: ['low', 'medium', 'moderate'] })

    const clamped = resolveConfig({ secretScan: { entropyThreshold: 99, maxFileBytes: 1 } })
    assert.equal(clamped.secretScan.entropyThreshold, 8, 'an impossible threshold is clamped, not honoured')
    assert.equal(clamped.secretScan.maxFileBytes, 1_024)
})

test('supply_chain_status reports the configuration in force, the newest gate and the artifact', async () => {
    const cwd = tempWorkspace('scg-status-')
    write(cwd, 'note.txt', 'no secrets here')
    const missionId = bindMission(cwd)
    const fake = host(cwd, { deps: { auditCommands: ['govulncheck ./...'] } })
    await fake.runTool('secret_scan', { wholeTree: true })
    const status = runText(await fake.runTool('supply_chain_status', { missionId }))
    assert.match(status, /配置来源：profile 配置/)
    assert.match(status, /规则：11 条/)
    assert.match(status, /\$?allowlist|allowlist：/)
    assert.match(status, /审计命令（1）：`govulncheck \.\/\.\.\.`/)
    assert.match(status, /阻断 severity：critical、high/)
    assert.match(status, /最新门禁：PASS/)
    assert.match(status, /### 最新明细工件/)
    assert.match(status, /工具：secret_scan/)
    assert.match(status, /下一步：/)
})

test('the plugin registers exactly three tools and prompts a section', () => {
    const cwd = tempWorkspace('scg-tools-')
    const fake = host(cwd, {})
    assert.deepEqual([...fake.tools.keys()].sort(), ['dependency_audit', 'secret_scan', 'supply_chain_status'])
    const section = fake.sectionText('eng:supply-chain-gate')
    assert.match(section, /供应链与密钥是门禁/)
    assert.match(section, /人工批准/)
    assert.match(section, /不等于.*没有密钥|不是证明/)
    hosts.push(fake)
})

test('every plugin host is torn down cleanly', () => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

test('entropy noise is advisory, not blocking (regression: 461 hits on a real repo)', () => {
    // Measured on `golang/im`: 120 files produced 461 unqualified entropy hits,
    // almost all base64 blobs in README/markdown. A gate that blocks on those is
    // switched off within a day, which protects nothing — so the severity now
    // depends on CONTEXT, and only known credential SHAPES block by default.
    const readme = '# 部署\n\n![img](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==)\n'
    const doc = scanText({ path: 'README.md', text: readme })
    const entropyHit = doc.find((finding) => finding.rule === 'high-entropy-string')
    assert.ok(entropyHit !== undefined, 'the literal is still reported')
    assert.equal(entropyHit?.severity, 'info', 'without a secret-ish context it is advisory')

    // On an ASSIGNMENT line the generic rule fires first and dedupe keeps the
    // stronger finding (medium) — the entropy rule is for literals whose context
    // is secret-ish but which no assignment rule claims.
    const assigned = scanText({ path: 'config.ts', text: 'const jwtSecret = "d8f3a91c77b2e4f60a5c1d9e3b7f2a48c6e0d1b9"\n' })
    assert.equal(assigned.find((finding) => finding.rule === 'generic-secret-assignment')?.severity, 'medium')

    const header = scanText({
        path: 'client.ts',
        text: 'headers.set("Authorization", "Bearer dGhpcy1pcy1hLXRlc3QtdG9rZW4tZm9yLWNvbnRleHQ=")\n',
    })
    const contextual = header.find((finding) => finding.rule === 'high-entropy-string')
    assert.equal(contextual?.severity, 'low', 'a credential-ish context → worth a look, still advisory')

    const env = scanText({ path: '.env.production', text: 'SESSION_KEY=d8f3a91c77b2e4f60a5c1d9e3b7f2a48c6e0d1b9\n', credentialFile: true })
    assert.equal(env.find((finding) => finding.rule === 'high-entropy-string')?.severity, 'low')

    // A real credential SHAPE is never downgraded.
    const aws = scanText({ path: 'main.go', text: `key := "${AWS_KEY_ID}"\n` })
    assert.equal(aws.find((finding) => finding.rule === 'aws-access-key-id')?.severity, 'critical')
})

test('placeholder assignments in test fixtures stop firing (regression)', () => {
    // `password = "wrong-1"` is a test fixture, not a leaked credential.
    const fixture = scanText({ path: 'auth_test.go', text: '\tpassword := "wrong-1"\n' })
    assert.deepEqual(fixture, [], 'a 7-character placeholder is not a secret')

    const placeholder = scanText({ path: 'config.go', text: '\tapiKey := "changeme-changeme"\n' })
    assert.equal(placeholder.some((finding) => finding.rule === 'generic-secret-assignment'), false)

    // A long, real-looking value in an assignment is still reported (medium).
    // A value that looks like a credential still fires — and the ASSIGNMENT rule
    // keeps its own severity even when the entropy net also matches it.
    const real = scanText({ path: 'config.go', text: '\tapiKey := "Xk9f3ac1b7d2e84a06b5c7d1e9f0a2b3c4"\n' })
    assert.equal(real.find((finding) => finding.rule === 'generic-secret-assignment')?.severity, 'medium', JSON.stringify(real.map((f) => [f.rule, f.severity])))
})

test('the credential-path helper classifies real filenames (regression)', () => {
    for (const file of ['.env', '.env.local', 'certs/server.pem', 'deploy/id_rsa', 'credentials.json', 'prod.tfvars', 'secrets.yaml']) {
        assert.equal(isCredentialPath(file), true, `${file} is a credential path`)
    }
    for (const file of ['README.md', 'main.go', 'src/env.ts', 'docs/keyboard.md']) {
        assert.equal(isCredentialPath(file), false, `${file} is not`)
    }
})

test('this test file contains no literal that looks like a credential (regression)', () => {
    // GitHub's push protection rejected the first version of this commit with
    // "DeepSeek API Key … test/supply-chain-gate.test.ts:30". A scanner's own
    // fixtures must not look like secrets: they trip real scanners, pollute
    // secret-scanning dashboards and train people to click "allow". Assembling
    // them at runtime keeps the rules exercised AND the file clean — this test is
    // the guard that keeps it that way.
    const file = fileURLToPath(import.meta.url)
    const source = fs.readFileSync(file, 'utf8')
    // Provider SHAPES are what push protection blocks (`AKIA…`, `ghp_…`, `sk-…`,
    // PEM headers): the assembled fixtures must leave none of them in the text.
    // Advisory entropy hits from the split PARTS are expected in this file — that
    // is exactly what splitting them is for.
    const blocking = scanText({ path: path.basename(file), text: source }).filter(
        (finding) => finding.severity === 'critical' || finding.severity === 'high' || finding.rule === 'private-key-block',
    )
    assert.deepEqual(
        blocking.map((finding) => `${finding.rule} ${finding.path}:${finding.line}`),
        [],
        'the fixture file must not contain a credential-shaped literal',
    )
    const providerShapes = [
        /AKIA[0-9A-Z]{16}/,
        /gh[pousr]_[A-Za-z0-9]{20,}/,
        /xox[baprs]-[A-Za-z0-9-]{10,}/,
        /sk-[a-f0-9]{32}/,
        /AIza[0-9A-Za-z_-]{35}/,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ]
    for (const pattern of providerShapes) {
        assert.doesNotMatch(source, pattern, `a literal matching ${pattern} would block the push`)
    }
    // …and the same sweep over the README, which documents the rules.
    const readme = scanText({ path: 'README.md', text: fs.readFileSync(path.join(path.dirname(file), '..', 'README.md'), 'utf8') })
    assert.deepEqual(readme.map((finding) => `${finding.rule} ${finding.path}:${finding.line}`), [])
})

test('entropy does not flag a slash-joined word list (regression)', () => {
    // Measured: this prose scores 4.16 bits/char — ABOVE a real base64 image
    // fragment (4.15) and below an English sentence (4.39). Entropy is not a
    // discriminator on its own, so the shape check carries the weight.
    const prose = '只有已知凭据形状阻断（AWS/GitHub/Slack/OpenAI/DeepSeek/Google、PEM 私钥块、JWT）'
    assert.deepEqual(scanText({ path: 'README.md', text: `${prose}\n` }), [])
    assert.equal(looksLikeWordList('AWS/GitHub/Slack/OpenAI/DeepSeek/Google'), true)
    assert.equal(looksLikeWordList('dGhpcy1pcy1hLXRlc3QtdG9rZW4tZm9yLWNvbnRleHQ'), false)
    assert.equal(looksLikeWordList('Zx9Qm2Lp7Rt4Wv1Yb8Nc3Kd6'), false)
})

// --- 大文件与废弃包：两个真实误报（2026-11-10，PHP 项目 che_mega_rip_php） ---------

test('a lockfile LARGER than the output cap is not an orphan when the tree is clean', async () => {
    // The bug: `git show base:composer.lock` was truncated at the command output
    // cap, so a 397KB lockfile "differed" from its own unchanged working copy and
    // the gate reported an orphan change on a clean tree. Change detection now
    // compares git object ids, which have no size.
    const cwd = tempWorkspace('supply-large-lock-')
    const filler = 'x'.repeat(400 * 1024)
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({ require: { 'vendor/pkg': '^1.0' } }, null, 2))
    fs.writeFileSync(path.join(cwd, 'composer.lock'), JSON.stringify({ _pad: filler, packages: [] }, null, 2))
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'base'])

    const fake = host(cwd, {
        deps: {
            manifests: ['composer.json', 'composer.lock'],
            auditCommands: [auditScript(cwd, `process.stdout.write(${JSON.stringify(JSON.stringify({ advisories: [], abandoned: [], filter: [] }))})`)],
        },
    })
    const text = runText(await fake.runTool('dependency_audit', {}))
    assert.match(text, /孤儿变更 0 个/, text)
    assert.equal(text.includes('孤儿变更 1 个'), false, text)
})

test('the same oversized lockfile IS an orphan once it really changes', async () => {
    const cwd = tempWorkspace('supply-large-lock-changed-')
    const filler = 'x'.repeat(400 * 1024)
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({ require: { 'vendor/pkg': '^1.0' } }, null, 2))
    fs.writeFileSync(path.join(cwd, 'composer.lock'), JSON.stringify({ _pad: filler, packages: [] }, null, 2))
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'base'])
    fs.appendFileSync(path.join(cwd, 'composer.lock'), '\n')

    const fake = host(cwd, {
        deps: {
            manifests: ['composer.json', 'composer.lock'],
            auditCommands: [auditScript(cwd, `process.stdout.write(${JSON.stringify(JSON.stringify({ advisories: [], abandoned: [], filter: [] }))})`)],
        },
    })
    const text = runText(await fake.runTool('dependency_audit', {}))
    assert.match(text, /孤儿变更 1 个/, text)
})

test('an ABANDONED package is info: a block list containing unknown does not block it', async () => {
    const cwd = tempWorkspace('supply-abandoned-')
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({ require: { 'doctrine/annotations': '^2.0' } }, null, 2))
    fs.writeFileSync(path.join(cwd, 'composer.lock'), JSON.stringify({ packages: [] }, null, 2))
    git(cwd, ['init', '-q'])
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'base'])
    const report = JSON.stringify({ advisories: {}, abandoned: { 'doctrine/annotations': 'no replacement' }, filter: [] })
    const fake = host(cwd, {
        deps: {
            manifests: ['composer.json', 'composer.lock'],
            auditCommands: [auditScript(cwd, `process.stdout.write(${JSON.stringify(report)})`)],
            auditSeverities: { block: ['high', 'critical', 'unknown'], warn: ['low', 'moderate'] },
        },
    })
    const text = runText(await fake.runTool('dependency_audit', {}))
    assert.match(text, /advisory=1/, text)
    assert.match(text, /findings=1/, text)
    assert.equal(/发现\s*\d+\s*条阻断/.test(text), false, text)
})

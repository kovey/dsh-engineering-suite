/**
 * Tests for `/suite set | unset | edit`, following the accepted test design
 * TC-1511 … TC-1515.
 *
 * TC-1516 is a VERIFICATION-level case (`bash scripts/verify.sh --quiet` twice,
 * both exit 0). Per the team's iteration rule this package run does not execute
 * the full verify suite; the package tests, tsc and standards-check are the
 * evidence here, and the full run remains the delivery gate's job.
 *
 * The invariants these tests pin are the ones that make a human edit safe:
 *
 *  - **the plugin's contract decides the key** — an unknown top-level key is
 *    refused (and `--allow-unknown` is the only way past that), a host-only key
 *    is refused either way;
 *  - **a preview never writes** — `--dry-run` prints the same diff and leaves
 *    the layout root byte-identical (not even a `.tmp-*` file);
 *  - **an atomic write or nothing** — a failing rename leaves the original bytes
 *    untouched and removes the temporary file;
 *  - **the UI route is best-effort** — without nvim-tui the command still
 *    succeeds with the absolute path; with it, the TUI's own `open_file_tab`
 *    entry is used (never hand-built RPC);
 *  - **the model-facing tools never gain this power** — the read-only tools do
 *    not even import the write modules.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { clearProjectConfigCache, resolveLayout } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { applyConfigEdit, writeFileAtomic } from '../dist/config-edit.js'

const hosts: FakeHost[] = []

after(() => {
    for (const fake of hosts) fake.dispose()
})

/** A log file outside the workspace: byte-identical tests hash the repository. */
function logFileFor(): string {
    return path.join(tempWorkspace('suite-edit-log-'), 'suite-doctor.log')
}

/** A throwaway repository with optional marker files. */
function repo(files: Record<string, string> = {}): string {
    const cwd = tempWorkspace('suite-edit-')
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
    return cwd
}

function layoutOf(cwd: string): ReturnType<typeof resolveLayout> {
    return resolveLayout(cwd)
}

function fileOf(cwd: string, name: string): string {
    return path.join(layoutOf(cwd).configDir, name)
}

/** Create one config file and return its absolute path. */
function writeConfig(cwd: string, name: string, value: unknown): string {
    const file = fileOf(cwd, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    return file
}

function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Every file under `dir`, content-hashed (the "byte-identical" assertion). */
function snapshot(dir: string): Record<string, string> {
    const files: Record<string, string> = {}
    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (entry.isFile()) files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
    }
    if (fs.existsSync(dir)) walk(dir)
    return files
}

function tempFilesIn(dir: string): string[] {
    return fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
}

type CommandResult = { kind: 'success' | 'error'; text: string }

interface CommandHarness {
    fake: FakeHost
    run: (rawInput: string) => Promise<CommandResult>
}

/** A structural fake of `ctx.get('commands')`, recording what was registered. */
function registryOf(): {
    service: { register: (definition: { name: string; handler: (invocation: unknown) => unknown }) => () => void }
    definitions: { name: string; handler: (invocation: unknown) => unknown }[]
} {
    const definitions: { name: string; handler: (invocation: unknown) => unknown }[] = []
    return {
        service: {
            register(definition) {
                definitions.push(definition)
                return () => undefined
            },
        },
        definitions,
    }
}

/** Assemble the plugin with a command registry so `/suite` can be invoked. */
function commandHost(cwd: string, services: Record<string, unknown> = {}): CommandHarness {
    const registry = registryOf()
    const fake = createFakeHost({ cwd, services: { commands: registry.service, ...services } })
    hosts.push(fake)
    clearProjectConfigCache()
    apply(fake.ctx as never, { logFile: logFileFor() })
    const definition = registry.definitions[0]
    assert.ok(definition, '/suite must be registered when the registry is mounted')
    return {
        fake,
        run: async (rawInput: string) => (await definition.handler({ agent: fake.agent, rawInput })) as CommandResult,
    }
}

test('TC-1511: /suite set 新键打印逐键 diff，原子写入，其余键原样保留', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const commands = [{ id: 'test', command: 'node --test', required: true }]
    const file = writeConfig(cwd, 'quality-gate.json', { commands })
    const { run } = commandHost(cwd)
    const result = await run(' set quality-gate defaultTimeoutMs 120000')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /\/suite set quality-gate defaultTimeoutMs/)
    assert.match(result.text, /文件：\.dsh\/quality-gate\.json/)
    assert.match(result.text, /diff（旧值 → 新值，逐键）：/)
    assert.match(result.text, /^- defaultTimeoutMs: （不存在）$/m)
    assert.match(result.text, /^\+ defaultTimeoutMs: 120000$/m)
    assert.match(result.text, /已原子写入 \.dsh\/quality-gate\.json/)
    const parsed = readJson(file)
    assert.equal(parsed['defaultTimeoutMs'], 120_000)
    assert.deepEqual(parsed['commands'], commands, 'unrelated keys must survive the write')
    assert.deepEqual(tempFilesIn(path.dirname(file)), [], 'the temporary file must not survive a successful rename')
})

test('TC-1511: /suite set 改既有键（数组 JSON 值）打印旧值 → 新值', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { commands: [{ id: 'test', command: 'node --test', required: true }] })
    const { run } = commandHost(cwd)
    const next = '[{"id": "test", "command": "node --test --experimental-strip-types", "required": true}, {"id": "lint", "command": "bash scripts/lint.sh", "required": false}]'
    const result = await run(` set quality commands ${next}`)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^- commands: \[\{"id":"test","command":"node --test","required":true\}\]$/m)
    assert.match(result.text, /^\+ commands: \[\{"id":"test","command":"node --test --experimental-strip-types","required":true\}/m)
    const parsed = readJson(file) as { commands: { id: string; required: boolean }[] }
    assert.equal(parsed.commands.length, 2)
    assert.equal(parsed.commands[1]?.id, 'lint')
})

test('set 保留 JSON 值内部的空格：值不是从 tokens 重新拼出来的', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'impact-gate.json', { fullTestCommand: 'npm test' })
    const { run } = commandHost(cwd)
    const result = await run(' set impact fullTestCommand "npm  test --silent"')
    assert.equal(result.kind, 'success')
    assert.equal(readJson(file)['fullTestCommand'], 'npm  test --silent')
})

test('/suite unset 删键并打印 diff，其它键保留', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { commands: [{ id: 'test', command: 'node --test', required: true }], defaultTimeoutMs: 120_000 })
    const { run } = commandHost(cwd)
    const result = await run(' unset quality-gate defaultTimeoutMs')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^- defaultTimeoutMs: 120000$/m)
    assert.match(result.text, /^\+ defaultTimeoutMs: （删除）$/m)
    const parsed = readJson(file)
    assert.equal('defaultTimeoutMs' in parsed, false)
    assert.ok(Array.isArray(parsed['commands']))
})

test('unset 一个文件里没有的键：成功、说明无变化、不写盘', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 1 })
    const before = fs.readFileSync(file)
    const { run } = commandHost(cwd)
    const result = await run(' unset quality-gate maxOutputBytes')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /文件里没有键 "maxOutputBytes"/)
    assert.match(result.text, /未写盘/)
    assert.deepEqual(fs.readFileSync(file), before)
})

test('TC-1513: 未知顶层键被拒绝，文件字节不变；--allow-unknown 才写入', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = fs.readFileSync(file)
    const { run } = commandHost(cwd)
    const refused = await run(' set quality-gate nonsense 1')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /未知顶层键 "nonsense"/)
    assert.match(refused.text, /--allow-unknown/)
    assert.deepEqual(fs.readFileSync(file), before, 'a refused key must not touch the file')

    const allowed = await run(' set quality-gate nonsense 1 --allow-unknown')
    assert.equal(allowed.kind, 'success')
    assert.match(allowed.text, /⚠ --allow-unknown：键 "nonsense" 不在 quality-gate 的契约里/)
    assert.equal(readJson(file)['nonsense'], 1)
})

test('被禁止在项目级覆盖的键一律拒绝（enabled / askTimeoutMs），--allow-unknown 不能放行', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const quality = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const interaction = writeConfig(cwd, 'interaction-gate.json', { preferredChannels: [] })
    const { run } = commandHost(cwd)
    for (const input of [' set quality-gate enabled false --allow-unknown', ' set interaction askTimeoutMs 1000']) {
        const result = await run(input)
        assert.equal(result.kind, 'error')
        assert.match(result.text, /不能在项目级覆盖/)
        assert.match(result.text, /--allow-unknown 只放行未知键/)
    }
    assert.deepEqual(readJson(quality), { defaultTimeoutMs: 5 })
    assert.deepEqual(readJson(interaction), { preferredChannels: [] })
})

test('非法 JSON 值被拒绝（解析失败直接拒绝，不猜）', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = fs.readFileSync(file)
    const { run } = commandHost(cwd)
    for (const input of [' set quality-gate defaultTimeoutMs not-json', ' set quality-gate commands [1,]']) {
        const result = await run(input)
        assert.equal(result.kind, 'error')
        assert.match(result.text, /值必须是合法的 JSON 片段/)
    }
    assert.deepEqual(fs.readFileSync(file), before)
})

test('TC-1514: --dry-run 只预览，不写盘、不留临时文件', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = snapshot(layoutOf(cwd).rootDir)
    const { run } = commandHost(cwd)
    const result = await run(' set quality-gate defaultTimeoutMs 999 --dry-run')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /dry-run：只预览，不写盘/)
    assert.match(result.text, /^\+ defaultTimeoutMs: 999$/m)
    assert.match(result.text, /dry-run：以上 diff 没有写盘/)
    assert.deepEqual(snapshot(layoutOf(cwd).rootDir), before, '--dry-run must leave the layout root byte-identical')
    assert.deepEqual(fs.readdirSync(layoutOf(cwd).rootDir), ['quality-gate.json'])
})

test('set 一个已经是该值的键：报告无变化，不写盘', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = fs.readFileSync(file)
    const { run } = commandHost(cwd)
    const result = await run(' set quality-gate defaultTimeoutMs 5')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /"defaultTimeoutMs" 的值没有变化/)
    assert.deepEqual(fs.readFileSync(file), before)
})

test('TC-1515: rename 失败时原文件字节不变，临时文件被删除', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = fs.readFileSync(file)
    assert.throws(
        () =>
            applyConfigEdit({
                cwd,
                layout: layoutOf(cwd),
                plugin: 'quality',
                action: 'set',
                key: 'defaultTimeoutMs',
                value: 999,
                io: {
                    renameSync: () => {
                        throw new Error('EXDEV: simulated cross-device rename')
                    },
                },
            }),
        /写入 .* 失败：EXDEV: simulated cross-device rename；原文件未改动（临时文件已删除）/,
    )
    assert.deepEqual(fs.readFileSync(file), before, 'a failed write must keep the original bytes')
    assert.deepEqual(tempFilesIn(path.dirname(file)), [], 'the temporary file must be cleaned up')
})

test('TC-1515: writeFileAtomic 自身在 rename 失败时保持原文件并清理临时文件', () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const target = path.join(cwd, 'gate.json')
    fs.writeFileSync(target, '{"a":1}\n')
    assert.throws(
        () =>
            writeFileAtomic(target, '{"a":2}\n', {
                renameSync: () => {
                    throw new Error('EACCES: simulated')
                },
            }),
        /原文件未改动/,
    )
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n')
    assert.deepEqual(tempFilesIn(cwd), [])
})

test('坏文件不静默改写：拒绝并说明先修正它', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = fileOf(cwd, 'quality-gate.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ "commands": [')
    const { run } = commandHost(cwd)
    const result = await run(' set quality-gate defaultTimeoutMs 1')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /不能改写/)
    assert.match(result.text, /不是合法 JSON/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "commands": [')
})

test('/suite help 列出 set / unset / edit 与两条写命令的约束', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { run } = commandHost(cwd)
    const help = await run(' help')
    assert.equal(help.kind, 'success')
    assert.match(help.text, /\/suite set <plugin> <key> <json-value>/)
    assert.match(help.text, /\/suite unset <plugin> <key>/)
    assert.match(help.text, /\/suite edit \[plugin\]/)
    assert.match(help.text, /--allow-unknown 只放行未知键/)
})

test('未知 plugin / 未知键名语法错误都给出可用清单或用法', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { run } = commandHost(cwd)
    const unknown = await run(' set nope anything 1')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /不认识的配置名 "nope"/)
    assert.match(unknown.text, /quality-gate/)

    const badFlag = await run(' set quality-gate --dry-run defaultTimeoutMs 1')
    assert.equal(badFlag.kind, 'error')
    assert.match(badFlag.text, /只能放在参数开头或结尾/)
})

/* ------------------------------------------------------------------ edit --- */

test('TC-1512: 没有 nvim-tui 时 /suite edit 回落为打印绝对路径，命令成功', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const before = fs.readFileSync(file)
    const { run } = commandHost(cwd)
    const result = await run(' edit quality-gate')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前界面没有可用的标签页入口/)
    assert.match(result.text, new RegExp(`文件（绝对路径）：${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(result.text, /在你的编辑器里打开它/)
    assert.deepEqual(fs.readFileSync(file), before, 'edit must not change the file')
})

test('/suite edit 在有 nvim-tui 时经 open_file_tab 公开入口开标签页', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const calls: { code: string; args: unknown[] }[] = []
    const tui = {
        nvim: {
            lua: async (code: string, args?: unknown[]) => {
                calls.push({ code, args: args ?? [] })
                return true
            },
        },
    }
    const { run } = commandHost(cwd, { 'nvim-tui': tui })
    const result = await run(' edit quality')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已在当前界面（nvim-tui）新标签页打开/)
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.code ?? '', /require\("dsh_tui"\)\.open_file_tab/)
    assert.equal(calls[0]?.args[0], file, 'the ABSOLUTE path is what nvim opens')
})

test('/suite edit 在只有 luaExt.call 的宿主上同样可用', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const calls: unknown[][] = []
    const tui = {
        luaExt: {
            call: async (...args: unknown[]) => {
                calls.push(args)
                return true
            },
        },
    }
    const { run } = commandHost(cwd, { 'nvim-tui': tui })
    const result = await run(' edit quality')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /新标签页打开/)
    assert.deepEqual(calls[0]?.slice(0, 3), ['dsh_tui', 'open_file_tab', [file]])
})

test('nvim-tui 打不开时仍回落为路径，不报错', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const tui = {
        nvim: {
            lua: async () => {
                throw new Error('nvim RPC 断开')
            },
        },
    }
    const { run } = commandHost(cwd, { 'nvim-tui': tui })
    const result = await run(' edit quality')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前界面没有可用的标签页入口/)
    assert.match(result.text, /nvim RPC 断开/)
    assert.match(result.text, /在你的编辑器里打开它/)
})

test('/suite edit 文件不存在时提示先 /suite init --apply', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const { run } = commandHost(cwd)
    const result = await run(' edit quality-gate')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /还没有这个配置文件或目录/)
    assert.match(result.text, /先运行 \/suite init --apply --only quality-gate/)
})

test('/suite edit 不带 plugin 时打开配置目录；未知 plugin 被拒绝', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    writeConfig(cwd, 'quality-gate.json', {})
    const { run } = commandHost(cwd)
    const dir = await run(' edit')
    assert.equal(dir.kind, 'success')
    assert.match(dir.text, /配置目录/)
    assert.match(dir.text, new RegExp(layoutOf(cwd).configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const unknown = await run(' edit nope')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /不认识的配置名 "nope"/)
})

/* --------------------------------------------------- tool layer (AC-002) --- */

test('AC-002: suite_init / suite_config 的工具层不引用任何写路径', () => {
    const dist = new URL('../dist/', import.meta.url)
    for (const name of ['tools.js', 'tools-scaffold.js']) {
        const source = fs.readFileSync(new URL(name, dist), 'utf8')
        for (const forbidden of ['config-edit', 'open-config', 'applyConfigEdit', 'writeFileAtomic', 'writeFileSync']) {
            assert.equal(source.includes(forbidden), false, `${name} must not reference ${forbidden}`)
        }
    }
})

test('AC-002: /suite set 之后 suite_config 仍然只是读，且能看到新值', async () => {
    const cwd = repo({ 'tsconfig.json': '{}' })
    const file = writeConfig(cwd, 'quality-gate.json', { defaultTimeoutMs: 5 })
    const { fake, run } = commandHost(cwd)
    const before = snapshot(layoutOf(cwd).rootDir)
    const inspectRun = await fake.runTool('suite_config', { plugin: 'quality' })
    assert.equal(inspectRun.isError, false)
    assert.deepEqual(snapshot(layoutOf(cwd).rootDir), before, 'suite_config must not change any file')
    await run(' set quality-gate defaultTimeoutMs 60000')
    const after = await fake.runTool('suite_config', { plugin: 'quality' })
    assert.equal(after.isError, false)
    assert.match(runText(after), /60000/)
    assert.deepEqual(readJson(file), { defaultTimeoutMs: 60_000 })
})

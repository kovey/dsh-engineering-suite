/**
 * The optional surfaces of the knowledge base: the `knowledge-base` SERVICE a
 * sibling plugin reaches through `ctx.get`, and the `/kb` IM command.
 *
 * What these tests pin down (and why each one matters):
 *
 *  - the service is the SAME pipeline as the tools (a real index is built and
 *    searched through it, with `path:from-to` citations), and it is optional —
 *    a host without `ctx.provide` loses the service, not the plugin;
 *  - the IM command is OFF unless a chat allow list is configured AND the host
 *    mounted `chatInteraction`; the handler re-checks the chat id, answers an
 *    unauthorised chat with a readable refusal (and logs it), truncates long
 *    answers with a pointer to the TUI, and turns a throwing search into
 *    `搜索失败：…` instead of an exception;
 *  - a project file can narrow the IM settings (fewer chats, tighter budgets)
 *    and never widen them — the profile stays the ceiling.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, createLogger } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import { narrowImConfig, resolveImConfig } from '../dist/im-config.js'
import {
    IM_TRUNCATED_SUFFIX,
    imUsageText,
    registerImCommand,
    runImQuery,
    truncateReply,
    type ImCommandInvocationLike,
} from '../dist/im.js'
import { provideKnowledgeBaseService, type KnowledgeBaseService } from '../dist/service.js'

const hosts: FakeHost[] = []

/** A workspace with a few markdown documents that share searchable words. */
function workspace(prefix = 'kb-surface-'): string {
    const cwd = tempWorkspace(prefix)
    fs.writeFileSync(path.join(cwd, 'README.md'), '# 示例项目\n\n发布流程写在 docs/guide.md，登录失败时的处理见下文。\n')
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# 部署指南\n\n发布流程：先跑 node --test，再 release_record；登录失败要返回 401。\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'login.md'), '# 登录失败\n\n登录失败时返回 401，并把原因写进日志。\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'release.md'), '# 发布流程\n\n发布流程包括构建、验证与记录发布台账。\n')
    return cwd
}

/** Mount the plugin in a throwaway workspace (the log file lives outside it). */
function host(cwd: string, config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): FakeHost {
    const fake = createFakeHost({ cwd, services })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(tempWorkspace('kb-surface-log-'), 'knowledge-base.log'), ...config })
    return fake
}

/** Read a service off the fake host's context. */
function serviceOf(fake: FakeHost, name = 'knowledge-base'): unknown {
    return (fake.ctx as { get: (service: string) => unknown }).get(name)
}

/** What the fake upstream records for a command registration. */
interface FakeCommandSpec {
    name: string
    description?: string
    usage?: string
    handler: (invocation: ImCommandInvocationLike) => unknown
}

/** A fake `chatInteraction` layer that records `registerCommand` calls. */
function fakeChat(): {
    layer: Record<string, unknown>
    registrations: FakeCommandSpec[]
    disposed: () => number
    api: { apiVersion: number; registerCommand: (spec: FakeCommandSpec) => { dispose: () => void } }
} {
    const registrations: FakeCommandSpec[] = []
    let disposals = 0
    const api = {
        apiVersion: 1,
        registerCommand(spec: FakeCommandSpec): { dispose: () => void } {
            registrations.push(spec)
            return {
                dispose: () => {
                    disposals += 1
                },
            }
        },
    }
    return { layer: { api }, registrations, disposed: () => disposals, api }
}

/** The deps a handler/registration test needs (a real store layout, a memory logger). */
function imDeps(config: Record<string, unknown>): {
    config: ReturnType<typeof resolveConfig>
    stores: MissionStoreRegistry
    logger: ReturnType<typeof createLogger>
} {
    return { config: resolveConfig(config), stores: new MissionStoreRegistry(), logger: createLogger({ tag: 'kb-im-test' }) }
}

test('TC-1830 the service is provided with reindex and search, backed by the real pipeline', async () => {
    const cwd = workspace()
    const fake = host(cwd)
    const service = serviceOf(fake) as KnowledgeBaseService | undefined
    assert.equal(typeof service, 'object')
    assert.equal(typeof service?.reindex, 'function')
    assert.equal(typeof service?.search, 'function')

    const built = await (service as KnowledgeBaseService).reindex(cwd)
    assert.equal(built.changeKind, 'created')
    assert.ok(built.chunks > 0, `expected chunks > 0, got ${built.chunks}`)
    assert.ok(built.documents >= 3)

    const outcome = (service as KnowledgeBaseService).search({ cwd, query: '发布流程', limit: 3 })
    assert.ok(outcome.hits.length > 0, 'the service must return the same ranked hits the tool renders')
    const hit = outcome.hits[0]
    assert.ok(hit !== undefined)
    assert.match(`${hit.chunk.path}:${hit.chunk.from}-${hit.chunk.to}`, /^.+:\d+-\d+$/)
    assert.ok(hit.snippet.length > 0)

    // A second build over the untouched workspace is honestly reported as unchanged.
    const again = await (service as KnowledgeBaseService).reindex(cwd)
    assert.equal(again.changeKind, 'unchanged')

    // Withdrawing the plugin withdraws the service (it stays optional, not sticky).
    fake.dispose()
    assert.equal(serviceOf(fake), undefined)
})

test('the service is optional: a host without ctx.provide gets a logged problem, never a crash', () => {
    const deps = { config: resolveConfig({}), stores: new MissionStoreRegistry(), logger: createLogger({ tag: 'kb-noprovide-test' }) }
    const registration = provideKnowledgeBaseService({}, deps)
    assert.equal(typeof registration.service.reindex, 'function')
    assert.equal(registration.dispose, undefined)
    assert.match(registration.problem ?? '', /ctx\.provide/)
})

test('a workspace that disabled the index reports "disabled", never a failed rebuild', async () => {
    const cwd = workspace('kb-surface-disabled-')
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh', 'knowledge-base.json'), '{"enabled": false}\n')
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const result = await service.reindex(cwd)
    assert.equal(result.changeKind, 'disabled')
    assert.equal(result.changed, false)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh', 'kb')), false, 'a disabled workspace writes no index')
})

test('TC-1834 the IM command is not registered without the IM service, nor without an allow list', () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService

    // (a) no chatInteraction service at all — even with an allow list configured.
    const withoutService = registerImCommand({ get: () => undefined }, imDeps({ im: { chatIds: ['oc_x'], workspace: cwd } }), service)
    assert.equal(withoutService.registered, false)
    assert.match(withoutService.problem ?? '', /IM 服务未装配/)

    // (b) the service exists, but the host configured no chat ids: default off.
    const chat = fakeChat()
    const withoutList = registerImCommand({ get: (name) => (name === 'chatInteraction' ? chat.layer : undefined) }, imDeps({}), service)
    assert.equal(withoutList.registered, false)
    assert.equal(withoutList.problem, undefined, 'the default (off) is not a problem worth warning about')
    assert.equal(chat.registrations.length, 0, 'nothing may be registered without an allow list')
})

test('TC-1832 apply registers the IM command once for an allow list, and a query returns citations', async () => {
    const cwd = workspace()
    const chat = fakeChat()
    const fake = host(cwd, { im: { chatIds: ['oc_x'], workspace: cwd } }, { chatInteraction: chat.layer })
    const service = serviceOf(fake) as KnowledgeBaseService
    await service.reindex(cwd)

    assert.equal(chat.registrations.length, 1, 'exactly one command per apply')
    const spec = chat.registrations[0]
    assert.ok(spec !== undefined)
    assert.equal(spec.name, 'kb')
    assert.match(spec.description ?? '', /path:from-to/)
    assert.match(spec.usage ?? '', /kb_search/)

    const reply = (await spec.handler({ chatId: 'oc_x', args: ['发布流程'], log: () => undefined })) as { text: string }
    assert.match(reply.text, /docs\/.+:\d+-\d+/, `expected a path:from-to citation, got: ${reply.text.slice(0, 200)}`)
    assert.match(reply.text, /摘要：/)

    // Disposing the plugin unregisters the command it registered.
    fake.dispose()
    assert.equal(chat.disposed(), 1)
})

test('TC-1835 a chat outside the allow list is refused and logged, without any result', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const logged: string[] = []
    const deps = imDeps({ im: { chatIds: ['oc_x'], workspace: cwd } })
    const reply = await runImQuery(
        { chatId: 'oc_other', args: ['发布流程'], log: (level, ...message) => logged.push(`${level}:${message.join(' ')}`) },
        { deps, service },
    )
    assert.match(reply.text, /未授权搜索知识库/)
    assert.doesNotMatch(reply.text, /:\d+-\d+/, 'an unauthorised chat must not receive a citation')
    assert.ok(logged.some((line) => line.startsWith('warn:') && line.includes('oc_other') && line.includes('已拒绝')), logged.join('\n'))
})

test('TC-1836 a long answer is truncated at the configured budget and points at the TUI', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    await service.reindex(cwd)
    const long = await runImQuery({ chatId: 'oc_x', args: ['发布流程'] }, { deps: imDeps({ im: { chatIds: ['oc_x'], workspace: cwd, maxChars: 120 } }), service })
    assert.ok(long.text.length <= 120, `reply must respect maxChars=120, got ${long.text.length}`)
    assert.ok(long.text.endsWith(IM_TRUNCATED_SUFFIX), `expected the truncation suffix, got: ${long.text}`)
    assert.match(long.text, /更多结果请在 TUI 用 kb_search/)

    // A short answer is never decorated with the suffix; a cut one always is.
    assert.equal(truncateReply('知识库：索引未变', 1800), '知识库：索引未变')
    const cut = truncateReply('x'.repeat(80), 40)
    assert.ok(cut.length <= 40)
    assert.ok(cut.endsWith(IM_TRUNCATED_SUFFIX))
})

test('a throwing search becomes a readable error instead of an exception', async () => {
    const cwd = workspace()
    const failing: KnowledgeBaseService = {
        reindex: async () => ({ changeKind: 'created', changed: true, dir: cwd, documents: 0, chunks: 0, skipped: 0 }),
        search: () => {
            throw new Error('索引不存在或不可用（.dsh/kb）：先跑 kb_index')
        },
    }
    const reply = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'] },
        { deps: imDeps({ im: { chatIds: ['oc_x'], workspace: cwd } }), service: failing },
    )
    assert.ok(reply.text.startsWith('搜索失败：'), reply.text)
    assert.match(reply.text, /索引不存在或不可用/)
})

test('an empty argument list answers with the usage, and a group chat is refused when p2pOnly', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const usage = await runImQuery({ chatId: 'oc_x', args: [] }, { deps: imDeps({ im: { chatIds: ['oc_x'], workspace: cwd } }), service })
    assert.equal(usage.text, imUsageText('kb'))

    const logged: string[] = []
    const group = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'], message: { chatType: 'group' }, log: (level, ...message) => logged.push(`${level}:${message.join(' ')}`) },
        { deps: imDeps({ im: { chatIds: ['oc_x'], workspace: cwd, p2pOnly: true } }), service },
    )
    assert.match(group.text, /未授权搜索知识库/)
    assert.ok(logged.some((line) => line.includes('p2p')), logged.join('\n'))
})

test('a missing im.workspace is refused with the configuration it needs', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const reply = await runImQuery({ chatId: 'oc_x', args: ['发布流程'] }, { deps: imDeps({ im: { chatIds: ['oc_x'] } }), service })
    assert.match(reply.text, /没有配置工作区/)
    assert.match(reply.text, /im\.workspace/)
})

test('the command name is configurable, and an illegal name is refused instead of guessed', () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const chat = fakeChat()
    const custom = registerImCommand({ get: () => chat.layer }, imDeps({ im: { command: 'kbase', chatIds: ['oc_x'], workspace: cwd } }), service)
    assert.equal(custom.registered, true)
    assert.equal(custom.name, 'kbase')
    assert.equal(chat.registrations[0]?.name, 'kbase')

    const illegal = registerImCommand({ get: () => chat.layer }, imDeps({ im: { command: 'KB!', chatIds: ['oc_x'], workspace: cwd } }), service)
    assert.equal(illegal.registered, false)
    assert.match(illegal.problem ?? '', /不是合法命令名/)
})

test('a project file may narrow the IM settings but never widen them', () => {
    const cwd = workspace()
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'knowledge-base.json'),
        `${JSON.stringify({
            im: {
                chatIds: ['oc_a', 'oc_c'],
                maxResults: 2,
                maxChars: 300,
                p2pOnly: true,
                command: 'other',
                workspace: '/tmp/elsewhere',
            },
        })}\n`,
    )
    const layout = new MissionStoreRegistry().for(cwd).layout
    const hostConfig = resolveConfig({ im: { chatIds: ['oc_a', 'oc_b'], workspace: cwd, maxResults: 5 } })
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.deepEqual(effective.config.im.chatIds, ['oc_a'], 'a project may remove an allowed chat, never add one')
    assert.equal(effective.config.im.maxResults, 2)
    assert.equal(effective.config.im.maxChars, 300)
    assert.equal(effective.config.im.p2pOnly, true)
    assert.equal(effective.config.im.command, 'kb', 'the command name is a host decision')
    assert.equal(effective.config.im.workspace, cwd, 'the searched workspace is a host decision')
    const problems = effective.problems.join('\n')
    assert.match(problems, /im\.chatIds 新增了 profile 未授权的会话/)
    assert.match(problems, /im\.command 不允许在项目级配置里覆盖/)
    assert.match(problems, /im\.workspace 不允许在项目级配置里覆盖/)

    // Widening a bound is refused (and reported), not silently applied.
    const reports: string[] = []
    const narrowed = narrowImConfig(
        resolveImConfig({ maxResults: 2, maxChars: 300 }),
        { maxResults: 9, maxChars: 9000 },
        'x.json',
        (message) => reports.push(message),
    )
    assert.equal(narrowed, undefined, 'nothing was applied, so the host values stay in force')
    assert.equal(reports.length, 2)
    assert.match(reports.join('\n'), /im\.maxResults=9 超过 profile/)
    assert.match(reports.join('\n'), /im\.maxChars=9000 超过 profile/)

    // Unusable values keep the defaults; the command is off unless configured.
    assert.equal(resolveImConfig({ im: { maxResults: 0 } }).maxResults, 5)
    assert.equal(resolveConfig({}).im.chatIds.length, 0)
    assert.equal(resolveConfig({}).im.command, 'kb')
})

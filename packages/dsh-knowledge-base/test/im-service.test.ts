/**
 * The optional surfaces of the knowledge base: the `knowledge-base` SERVICE a
 * sibling plugin reaches through `ctx.get`, and the `/kb` IM command.
 *
 * What these tests pin down (and why each one matters):
 *
 *  - the service is the SAME pipeline as the tools (a real index is built and
 *    searched through it, with `path:from-to` citations), and it is optional —
 *    a host without `ctx.provide` loses the service, not the plugin;
 *  - the IM command has ONE source for "which conversation may ask":
 *    `dsh-interaction-gate`'s `im.approvalChatId` / `im.p2pOnly`, read through
 *    `ctx.get('interaction').imTarget()`. No target = no command (default off
 *    is the absence of a target, not a permissive fallback), and the handler
 *    re-reads the target on every call: a grant that is not the configured
 *    conversation is refused with a message naming the interaction-gate key,
 *    never a second allow list kept here;
 *  - the duplicated keys (`im.chatIds` / `im.p2pOnly`) are GONE from the
 *    configuration surface: parsing ignores them, a project file that still
 *    writes them is reported, and only `command` / `maxResults` / `maxChars` /
 *    `workspace` remain;
 *  - the handler stays readable: truncation points at the TUI, a missing
 *    workspace names `im.workspace`, a throwing search becomes `搜索失败：…`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, createLogger } from 'dsh-eng-core'
import { createFakeHost, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'
import { resolveConfig, resolveEffectiveConfig } from '../dist/config.js'
import { defaultImConfig, narrowImConfig, removedImKeys, resolveImConfig } from '../dist/im-config.js'
import { IM_NOT_P2P, IM_NOT_TARGET, type ImTargetLike } from '../dist/im-target.js'
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

/** A target as `dsh-interaction-gate` publishes it (`registry.imTarget()`). */
function target(chatId: string, p2pOnly = false): ImTargetLike {
    return { channel: 'auto', chatId, p2pOnly }
}

/** A fake `interaction` service: `imTarget()` is the ONE method the KB reads. */
function fakeInteraction(value: ImTargetLike | undefined): Record<string, unknown> {
    return { imTarget: () => value }
}

/** What the host context looks like to these tests: `ctx.get` over a fixed service map. */
function contextOf(services: Record<string, unknown>): { get: (name: string) => unknown } {
    return { get: (name) => services[name] }
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

test('TC-1843/TC-1846 no interaction service, or no target published, means the command is not registered', () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const chat = fakeChat()

    // (a) no `interaction` service at all: the knowledge base has no chat list of
    // its own any more, so there is nothing to authorise a command with.
    const withoutInteraction = registerImCommand(contextOf({ chatInteraction: chat.layer }), imDeps({ im: { workspace: cwd } }), service)
    assert.equal(withoutInteraction.registered, false)
    assert.match(withoutInteraction.problem ?? '', /im\.approvalChatId/)
    assert.doesNotMatch(withoutInteraction.problem ?? '', /im\.chatIds/, 'the removed key must not be suggested')
    assert.equal(chat.registrations.length, 0, 'nothing may be registered without a target')

    // (b) interaction is mounted but publishes no target (`imTarget()` is undefined).
    const withoutTarget = registerImCommand(
        contextOf({ chatInteraction: chat.layer, interaction: fakeInteraction(undefined) }),
        imDeps({ im: { workspace: cwd } }),
        service,
    )
    assert.equal(withoutTarget.registered, false)
    assert.match(withoutTarget.problem ?? '', /im\.approvalChatId/)
    assert.equal(chat.registrations.length, 0)

    // (c) no IM intent at all: off is the default and is not a problem worth logging.
    const silent = registerImCommand(contextOf({}), imDeps({}), service)
    assert.equal(silent.registered, false)
    assert.equal(silent.problem, undefined)

    // (d) a target exists but the IM plugin's command api does not: refused with
    // the reason, and the message says the target was there.
    const withoutApi = registerImCommand(contextOf({ interaction: fakeInteraction(target('oc_x')) }), imDeps({ im: { workspace: cwd } }), service)
    assert.equal(withoutApi.registered, false)
    assert.match(withoutApi.problem ?? '', /IM 服务未装配/)
    assert.match(withoutApi.problem ?? '', /interaction-gate 已配置 IM 目标/)
})

test('TC-1842 apply registers one command for the target from interaction, and a query from it returns citations', async () => {
    const cwd = workspace()
    const chat = fakeChat()
    const fake = host(cwd, { im: { workspace: cwd } }, { chatInteraction: chat.layer, interaction: fakeInteraction(target('oc_x')) })
    const service = serviceOf(fake) as KnowledgeBaseService
    await service.reindex(cwd)

    assert.equal(chat.registrations.length, 1, 'exactly one command per apply')
    const spec = chat.registrations[0]
    assert.ok(spec !== undefined)
    assert.equal(spec.name, 'kb')
    assert.match(spec.description ?? '', /path:from-to/)
    assert.match(spec.usage ?? '', /kb_search/)

    // The configured target is answered — `p2pOnly: false` places no requirement
    // on the chat type, so a group conversation is fine here.
    const reply = (await spec.handler({ chatId: 'oc_x', args: ['发布流程'], message: { chatType: 'group' }, log: () => undefined })) as { text: string }
    assert.match(reply.text, /docs\/.+:\d+-\d+/, `expected a path:from-to citation, got: ${reply.text.slice(0, 200)}`)
    assert.match(reply.text, /摘要：/)

    // Disposing the plugin unregisters the command it registered.
    fake.dispose()
    assert.equal(chat.disposed(), 1)
})

test('TC-1844 a chat that is not the configured target is refused, and the refusal names im.approvalChatId', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const logged: string[] = []
    const reply = await runImQuery(
        { chatId: 'oc_other', args: ['发布流程'], log: (level, ...message) => logged.push(`${level}:${message.join(' ')}`) },
        { deps: imDeps({ im: { workspace: cwd } }), service, imTarget: () => target('oc_x') },
    )
    assert.match(reply.text, /该会话不是 interaction-gate 配置的审批会话/)
    assert.match(reply.text, /interaction-gate/)
    assert.match(reply.text, /im\.approvalChatId/)
    assert.doesNotMatch(reply.text, /im\.chatIds/, 'the refusal must name the key that actually exists')
    assert.doesNotMatch(reply.text, /:\d+-\d+/, 'an unauthorised chat must not receive a citation')
    assert.ok(logged.some((line) => line.startsWith('warn:') && line.includes('oc_other') && line.includes('已拒绝')), logged.join('\n'))

    // A registration cannot be trusted forever: the handler re-reads the target,
    // and "no target any more" refuses instead of answering (fail closed).
    const stale = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'] },
        { deps: imDeps({ im: { workspace: cwd } }), service, imTarget: () => undefined },
    )
    assert.match(stale.text, /没有可用的 IM 目标/)
    assert.match(stale.text, /im\.approvalChatId/)
    assert.doesNotMatch(stale.text, /:\d+-\d+/)
})

test('TC-1845 a group chat is refused when the target requires p2p, and the refusal names im.p2pOnly', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    await service.reindex(cwd)
    const logged: string[] = []
    const p2pOnly = () => target('oc_x', true)

    const group = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'], message: { chatType: 'group' }, log: (level, ...message) => logged.push(`${level}:${message.join(' ')}`) },
        { deps: imDeps({ im: { workspace: cwd } }), service, imTarget: p2pOnly },
    )
    assert.match(group.text, /群聊/)
    assert.match(group.text, /im\.p2pOnly/)
    assert.doesNotMatch(group.text, /:\d+-\d+/, 'a refused chat must not receive a citation')
    assert.ok(logged.some((line) => line.includes('im.p2pOnly')), logged.join('\n'))

    // The SAME target answers a p2p conversation.
    const direct = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'], message: { chatType: 'p2p' } },
        { deps: imDeps({ im: { workspace: cwd } }), service, imTarget: p2pOnly },
    )
    assert.match(direct.text, /docs\/.+:\d+-\d+/)
})

test('TC-1836 a long answer is truncated at the configured budget and points at the TUI', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    await service.reindex(cwd)
    const long = await runImQuery(
        { chatId: 'oc_x', args: ['发布流程'] },
        { deps: imDeps({ im: { workspace: cwd, maxChars: 120 } }), service, imTarget: () => target('oc_x') },
    )
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
        { deps: imDeps({ im: { workspace: cwd } }), service: failing, imTarget: () => target('oc_x') },
    )
    assert.ok(reply.text.startsWith('搜索失败：'), reply.text)
    assert.match(reply.text, /索引不存在或不可用/)
})

test('an empty argument list answers with the usage', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const usage = await runImQuery({ chatId: 'oc_x', args: [] }, { deps: imDeps({ im: { workspace: cwd } }), service, imTarget: () => target('oc_x') })
    assert.equal(usage.text, imUsageText('kb'))
})

test('a missing im.workspace is refused with the configuration it needs', async () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const reply = await runImQuery({ chatId: 'oc_x', args: ['发布流程'] }, { deps: imDeps({}), service, imTarget: () => target('oc_x') })
    assert.match(reply.text, /没有配置工作区/)
    assert.match(reply.text, /im\.workspace/)
})

test('the command name is configurable, and an illegal name is refused instead of guessed', () => {
    const cwd = workspace()
    const service = serviceOf(host(cwd)) as KnowledgeBaseService
    const chat = fakeChat()
    const services = contextOf({ chatInteraction: chat.layer, interaction: fakeInteraction(target('oc_x')) })
    const custom = registerImCommand(services, imDeps({ im: { command: 'kbase', workspace: cwd } }), service)
    assert.equal(custom.registered, true)
    assert.equal(custom.name, 'kbase')
    assert.equal(chat.registrations[0]?.name, 'kbase')

    const illegal = registerImCommand(services, imDeps({ im: { command: 'KB!', workspace: cwd } }), service)
    assert.equal(illegal.registered, false)
    assert.match(illegal.problem ?? '', /不是合法命令名/)
})

test('im.chatIds / im.p2pOnly are gone: parsing ignores them and a stale project file is reported', () => {
    // The duplicated keys are not part of the configuration surface any more.
    const resolved = resolveConfig({ im: { chatIds: ['oc_x'], p2pOnly: true, maxResults: 3, workspace: '/tmp/x' } })
    assert.equal('chatIds' in resolved.im, false)
    assert.equal('p2pOnly' in resolved.im, false)
    assert.equal(resolved.im.maxResults, 3, 'the keys that remain are still read')
    assert.deepEqual(Object.keys(resolved.im).sort(), ['command', 'maxChars', 'maxResults', 'workspace'])
    assert.deepEqual(Object.keys(defaultImConfig()).sort(), ['command', 'maxChars', 'maxResults', 'workspace'])
    // The removed keys are NAMED when a file still declares them, so a stale
    // allow list is not mistaken for one that is in force.
    assert.deepEqual(removedImKeys({ chatIds: ['oc_x'], p2pOnly: true }), ['chatIds', 'p2pOnly'])
    assert.deepEqual(removedImKeys({ maxResults: 2 }), [])

    const cwd = workspace()
    fs.mkdirSync(path.join(cwd, '.dsh'), { recursive: true })
    fs.writeFileSync(
        path.join(cwd, '.dsh', 'knowledge-base.json'),
        `${JSON.stringify({
            im: {
                chatIds: ['oc_a'],
                p2pOnly: true,
                maxResults: 2,
                maxChars: 300,
                command: 'other',
                workspace: '/tmp/elsewhere',
            },
        })}\n`,
    )
    const layout = new MissionStoreRegistry().for(cwd).layout
    const hostConfig = resolveConfig({ im: { workspace: cwd, maxResults: 5 } })
    const effective = resolveEffectiveConfig(hostConfig, layout)
    assert.equal(effective.source, 'project')
    assert.deepEqual(effective.config.im, { command: 'kb', maxResults: 2, maxChars: 300, workspace: cwd })
    const problems = effective.problems.join('\n')
    assert.match(problems, /im\.chatIds 已不再是知识库的配置/, problems)
    assert.match(problems, /im\.p2pOnly 已不再是知识库的配置/, problems)
    assert.match(problems, /interaction-gate 的 im\.approvalChatId/, problems)
    assert.match(problems, /im\.command 不允许在项目级配置里覆盖/, problems)
    assert.match(problems, /im\.workspace 不允许在项目级配置里覆盖/, problems)

    // A project file may still tighten the reply budgets — and may never widen them.
    assert.equal(narrowImConfig(resolveImConfig({ maxResults: 5, maxChars: 1800 }), { maxResults: 2, maxChars: 300 }, 'x.json', () => undefined)?.maxResults, 2)
    const reports: string[] = []
    const widened = narrowImConfig(
        resolveImConfig({ maxResults: 2, maxChars: 300 }),
        { maxResults: 9, maxChars: 9000 },
        'x.json',
        (message) => reports.push(message),
    )
    assert.equal(widened, undefined, 'nothing was applied, so the host values stay in force')
    assert.equal(reports.length, 2)
    assert.match(reports.join('\n'), /im\.maxResults=9 超过 profile/)
    assert.match(reports.join('\n'), /im\.maxChars=9000 超过 profile/)

    // Unusable values keep the defaults.
    assert.equal(resolveImConfig({ maxResults: 0 }).maxResults, 5)
    assert.equal(resolveConfig({}).im.command, 'kb')
    assert.match(IM_NOT_TARGET, /im\.approvalChatId/)
    assert.match(IM_NOT_P2P, /im\.p2pOnly/)
})

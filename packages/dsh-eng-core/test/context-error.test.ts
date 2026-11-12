/**
 * `dsh-eng-core/context-error`: the two shapes a "missing context" refusal can
 * take, and the promise that a gate never has to know which harness version it
 * runs on (TC-1631…TC-1634).
 *
 * The rc.2 class is exercised through the loader seam: the host installed here
 * is 0.2.2-rc.1, which has no such export, and a test may not upgrade the user's
 * harness. The probe is also exercised against the REAL installed package,
 * asserting it reports exactly what that package exports — true on rc.1
 * (nothing) and on rc.2 (the class), so the assertion cannot rot into a
 * version-specific expectation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    TOOL_CONTEXT_UNAVAILABLE,
    probeToolContextUnavailableErrorHost,
    toolContextUnavailableError,
} from '../dist/context-error.js'

/** Stand-in for the rc.2 class: same name/code contract, distinct identity. */
class FakeHostToolContextUnavailableError extends Error {
    readonly code = TOOL_CONTEXT_UNAVAILABLE

    constructor(message: string) {
        super(message)
        this.name = 'ToolContextUnavailableError'
    }
}

test('TC-1631 the refusal keeps the name, the code and the message on this host', () => {
    // Routing must not depend on which constructor won: the name/code pair is the
    // contract, and the message is the human's next step (verbatim).
    const error = toolContextUnavailableError('无法确定本会话的工作区（session.header.cwd 缺失）')
    assert.ok(error instanceof Error, '必须是 Error 实例（tool body 抛它，宿主按失败记录）')
    assert.equal(error.name, 'ToolContextUnavailableError', '宿主按 name/code 归类，不按消息文本')
    assert.equal((error as { code?: unknown }).code, TOOL_CONTEXT_UNAVAILABLE)
    assert.equal(error.message, '无法确定本会话的工作区（session.header.cwd 缺失）')
})

test('TC-1632 rc.1 fallback: forced "no host class" still yields the same name/code', () => {
    // `hostClass: null` is the rc.1 shape: the harness exports no such class.
    const error = toolContextUnavailableError('缺少调用方（agent 缺失）', { hostClass: null })
    assert.equal(error.name, 'ToolContextUnavailableError')
    assert.equal((error as { code?: unknown }).code, TOOL_CONTEXT_UNAVAILABLE)
    assert.equal(error.message, '缺少调用方（agent 缺失）')
})

test('TC-1633 rc.2: a probed host class is really used (instanceof, not a look-alike)', async () => {
    const found = await probeToolContextUnavailableErrorHost(async () => ({
        ToolContextUnavailableError: FakeHostToolContextUnavailableError,
    }))
    assert.equal(found, FakeHostToolContextUnavailableError, '探针必须取到宿主导出的构造函数')
    const error = toolContextUnavailableError('缺少服务：ctx.approval 未装配')
    assert.ok(error instanceof FakeHostToolContextUnavailableError, '探针成功后，工具抛出的必须是宿主类本身')
    assert.equal(error.message, '缺少服务：ctx.approval 未装配')
})

test('TC-1634 a failing probe neither throws nor erases a resolved class', async () => {
    await probeToolContextUnavailableErrorHost(async () => ({
        ToolContextUnavailableError: FakeHostToolContextUnavailableError,
    }))
    const unresolvable = await probeToolContextUnavailableErrorHost(async () => {
        throw new Error('Cannot find module @deepseek-ai/dsh-tools')
    })
    assert.equal(unresolvable, undefined, '本次探测没找到 → 报告"没找到"，而不是抛错')
    const error = toolContextUnavailableError('宿主包无法解析')
    assert.ok(
        error instanceof FakeHostToolContextUnavailableError,
        '失败的探测不得把已解析到的类清掉（否则同一进程里分类会漂移）',
    )

    const noExport = await probeToolContextUnavailableErrorHost(async () => ({ Toolbox: 1 }))
    assert.equal(noExport, undefined, '没有该导出 → 没找到')
    const notAFunction = await probeToolContextUnavailableErrorHost(async () => ({ ToolContextUnavailableError: 'nope' }))
    assert.equal(notAFunction, undefined, '非函数导出不得被当成构造函数')
})

test('TC-1635 the probe reports exactly what the INSTALLED harness exports', async () => {
    const host = (await import('@deepseek-ai/dsh-tools')) as { ToolContextUnavailableError?: unknown }
    const probed = await probeToolContextUnavailableErrorHost()
    assert.equal(probed, host.ToolContextUnavailableError, '探针结果必须与宿主包的实际导出一致（rc.1=无，rc.2=类）')
})

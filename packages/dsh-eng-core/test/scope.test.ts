/**
 * The scope plugin (`dsh-eng-core/scope`): the single place a child scope gets
 * its tool restriction and its persona injected.
 *
 * The plugin lives in eng-core because two plugins mount it — `dsh-role-guard`
 * for `role:<roleId>` presets and `dsh-orchestrator` for `orchestrator:<role>`
 * presets. These tests are the ones that used to live in role-guard, moved with
 * the code: a unit test that names `dsh-role-guard/scope` while the row mounts
 * `dsh-eng-core/scope` is exactly how a stale specifier survives a move.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, name, PERSONA_ORDER, PERSONA_SECTION, resolveScopeConfig } from '../dist/scope.js'

/** A child scope that records what the plugin did, and in which order. */
function childScope(options: { withTools?: boolean; withPrompt?: boolean; rejectRestrict?: Error } = {}) {
    const calls: string[] = []
    const filters: unknown[] = []
    const sections: { name: string; order: number; text: string | (() => string) }[] = []
    const effects: (() => void)[] = []
    let released = 0
    const services: Record<string, unknown> = {}
    /**
     * A cordis-shaped context: reading a service it did not `inject` THROWS
     * ("cannot get property \"tools\" without inject"), and `get(name)` is the only
     * way to read an optional one. The previous fake exposed plain properties,
     * which is exactly why the plugin's `ctx.tools?.restrict` shipped broken:
     * `team_delegate` failed with that very error at runtime and no test noticed.
     */
    const ctx = new Proxy<Record<string, unknown>>(
        {
            effect: (execute: () => (() => void) | void) => {
                const disposer = execute()
                if (typeof disposer === 'function') effects.push(disposer)
            },
            get: (name: string) => services[name],
        },
        {
            get: (target, key: string | symbol) => {
                if (typeof key === 'string' && key in services) {
                    throw new Error(`cannot get property "${key}" without inject`)
                }
                return target[key as string]
            },
        },
    )
    if (options.withTools !== false) {
        services['tools'] = {
            restrict: (filter: unknown) => {
                calls.push('restrict')
                if (options.rejectRestrict !== undefined) throw options.rejectRestrict
                filters.push(filter)
                return () => {
                    released += 1
                }
            },
        }
    }
    if (options.withPrompt !== false) {
        services['systemPrompt'] = {
            section: (section: { name: string; order: number; text: string | (() => string) }) => {
                calls.push('section')
                sections.push(section)
                return () => {
                    released += 1
                }
            },
        }
    }
    return {
        ctx,
        calls,
        filters,
        sections,
        effects,
        releases: () => released,
        teardown: () => {
            for (const dispose of effects.splice(0)) dispose()
        },
    }
}

test('the scope plugin is shared from eng-core under its own name (TC-902)', () => {
    // The host resolves a preset row by this exact string; both mounting plugins
    // must name it, and neither may keep a copy.
    assert.equal(name, 'dsh-eng-core/scope')
    assert.equal(PERSONA_SECTION, 'role-guard:persona', 'the section identity is stable: it decides what shadows what in a child scope')
    assert.equal(PERSONA_ORDER, 0)
})

test('the scope plugin enforces the filter and installs the persona in the child scope (TC-803)', () => {
    const fake = childScope()
    apply(fake.ctx, { persona: '你是审查者，只读。', allow: ['read', 'grep'] })

    assert.deepEqual(fake.filters, [{ allow: ['read', 'grep'] }], 'the host-enforced restriction is applied exactly once')
    assert.equal(fake.sections.length, 1)
    assert.equal(fake.sections[0]?.name, PERSONA_SECTION)
    assert.equal(fake.sections[0]?.order, PERSONA_ORDER)
    assert.equal(typeof fake.sections[0]?.text, 'function')
    assert.equal((fake.sections[0]?.text as () => string)(), '你是审查者，只读。')
    // Enforcement order: the restriction is applied BEFORE the persona, so a
    // rejected restriction can never leave the persona behind as a half-mount.
    assert.deepEqual(fake.calls, ['restrict', 'section'])

    // Teardown releases both registrations (the scope's effect owns them).
    fake.teardown()
    assert.equal(fake.releases(), 2)
})

test('the scope plugin never throws on an absent capability, and never half-enforces silently (TC-803)', () => {
    // Nothing to enforce and nothing to crash: a bare composition is legal.
    assert.doesNotThrow(() => apply({}, { persona: '只读角色', allow: ['read'] }))
    assert.doesNotThrow(() => apply({ get: (name: string) => (name === 'tools' ? {} : name === 'systemPrompt' ? {} : undefined) }, { persona: '只读角色', allow: ['read'] }))
    assert.doesNotThrow(() => apply({}, 'not even an object'))

    // No filter, no section when nothing is declared.
    const bare = childScope()
    apply(bare.ctx, { persona: '   ', deny: [] })
    assert.deepEqual(bare.filters, [])
    assert.deepEqual(bare.sections, [])

    // A declared-but-EMPTY whitelist is not "no whitelist": the child must not
    // mount at all rather than run with everything the role excluded.
    assert.throws(() => apply({ get: () => ({ restrict: () => () => undefined }) }, { allow: [] }), /empty tool whitelist/)

    // A deny-only role leans on the deny half (read-only roles do exactly this).
    const denyOnly = childScope()
    apply(denyOnly.ctx, { deny: ['write', 'edit'] })
    assert.deepEqual(denyOnly.filters, [{ deny: ['write', 'edit'] }])

    // A filter the host REJECTS must fail the child's start: swallowing it would
    // hand the child every tool the role excluded.
    assert.throws(
        () => apply({ get: () => ({ restrict: () => { throw new Error('unknown tool "nope"') } }) }, { allow: ['nope'] }),
        /unknown tool "nope"/,
    )
    // …and a persona that fails to install only costs the persona (it cannot
    // widen authority), so the child still starts.
    // `get()`-shaped on purpose: a property-shaped fake would make this pass
    // trivially (the plugin never sees a prompt service at all), which is how the
    // real "cannot get property without inject" failure stayed invisible.
    assert.doesNotThrow(() =>
        apply(
            {
                get: (name: string) =>
                    name === 'tools'
                        ? { restrict: () => () => undefined }
                        : name === 'systemPrompt'
                          ? {
                                section: () => {
                                    throw new Error('duplicate section')
                                },
                            }
                          : undefined,
            },
            { persona: '只读', allow: ['read'] },
        ),
    )
})

test('resolveScopeConfig reads an untrusted row without inventing a restriction (TC-803)', () => {
    assert.deepEqual(resolveScopeConfig(undefined), { persona: '', filter: undefined, emptyAllow: false })
    assert.deepEqual(resolveScopeConfig('nope'), { persona: '', filter: undefined, emptyAllow: false })
    assert.deepEqual(resolveScopeConfig({ persona: ' 只读 ', allow: ['read', 42, ''], deny: [] }), {
        persona: '只读',
        filter: { allow: ['read'] },
        emptyAllow: false,
    })
    // Declared-but-empty is reported, not silently treated as "no restriction".
    assert.equal(resolveScopeConfig({ allow: [] }).emptyAllow, true)
    assert.equal(resolveScopeConfig({ allow: 'read' }).emptyAllow, false, 'a non-array allow is not a declaration')
    // A mirror of the guard the two mounting plugins rely on: the plugin's row
    // config only ever carries `persona`, `allow` and `deny`.
    assert.deepEqual(resolveScopeConfig({ persona: '', allow: ['read'], deny: ['write'] }).filter, { allow: ['read'], deny: ['write'] })
})

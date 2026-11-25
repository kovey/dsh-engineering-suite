/**
 * The project-level split switch (项目级单一来源): the project's `models.json`
 * decides, the profile only supplies a default, and BOTH the pipeline and the
 * `orchestrator` service report the same effective value (AC-001/AC-002/AC-003).
 *
 * Every case builds a real workspace with (or without) a project `models.json`
 * and reads the pipeline through `orchestrate({ action: 'stages' })` — the same
 * surface a person uses — plus `orchestrator.effectiveSplit(cwd)` for the
 * provenance (`source`).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MissionStoreRegistry, type Layout, type MissionStore } from 'dsh-eng-core'
import { createFakeHost, runText, tempWorkspace, type FakeHost } from 'dsh-eng-core/testing'
import { apply } from '../dist/index.js'

/** The sibling tools the default pipeline probes (stubbed as mounted). */
const PLUGIN_TOOLS = ['spec_create', 'test_design_review', 'team_delegate', 'quality_gate_run', 'mission_complete', 'audit_report']

/** The two pipelines a repository can have (AC-001). */
const WITH_SPLIT = ['spec-clarify', 'test-design-review', 'spec-approve', 'split', 'split-review', 'implement', 'quality-verify', 'delivery']
const WITHOUT_SPLIT = ['spec-clarify', 'test-design-review', 'spec-approve', 'implement', 'quality-verify', 'delivery']

const hosts: FakeHost[] = []

test.after(() => {
    for (const fake of hosts.splice(0)) fake.dispose()
})

/** The project config directory of one temp workspace (`<布局根>/`). */
function configDirOf(cwd: string): string {
    return path.join(cwd, '.dsh', 'engineering-suite')
}

/** Write the PROJECT's `models.json` (no file = the project declared nothing). */
function projectModels(cwd: string, models: unknown): void {
    fs.mkdirSync(configDirOf(cwd), { recursive: true })
    fs.writeFileSync(path.join(configDirOf(cwd), 'models.json'), JSON.stringify(models))
}

/** Assemble the orchestrator with one profile `config.split` value. */
function host(cwd: string, split?: Record<string, unknown>): FakeHost {
    const fake = createFakeHost({ cwd })
    hosts.push(fake)
    apply(fake.ctx as never, { logFile: path.join(cwd, 'orchestrator.log'), ...(split === undefined ? {} : { split }) })
    for (const tool of PLUGIN_TOOLS) {
        fake.tools.set(tool, { name: tool, description: 'stub', parameters: {}, execute: async () => 'ok' } as never)
    }
    return fake
}

async function orchestrate(fake: FakeHost, args: Record<string, unknown>): Promise<string> {
    const run = await fake.runTool('orchestrate', args)
    assert.equal(run.isError, false, `orchestrate failed: ${String(run.content)}`)
    return runText(run)
}

/** The stage ids the `stages` action lists, in order. */
function pipelineIds(text: string): string[] {
    return [...text.matchAll(/^\d+\. ([\w-]+) — /gm)].map((match) => match[1] as string)
}

/** A mission parked on `stage` with an approved spec + passed test design. */
function missionAt(fake: FakeHost, stage: string): { store: MissionStore; layout: Layout } {
    const store = new MissionStoreRegistry().for(fake.cwd)
    store.create({ id: 'm-effective', title: '项目级开关', cwd: fake.cwd, sessionId: 'session-1' })
    store.bindSession('session-1', 'm-effective', stage)
    store.update('m-effective', () => ({
        stage,
        status: 'spec-approved',
        spec: {
            title: '项目级开关',
            background: '',
            requirements: [],
            acceptanceCriteria: [{ id: 'AC-001', text: 'criterion' }],
            fileBoundaries: ['packages/**'],
            negativeConstraints: [],
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            approvedAt: Date.now(),
            approvedBy: 'test',
        },
        testDesign: { cases: [], covered: [], uncovered: [], passed: true, reviewedAt: Date.now() },
    }))
    return { store, layout: new MissionStoreRegistry().for(fake.cwd).layout }
}

/** The provided `orchestrator` service, as `dsh-role-guard` reads it. */
function serviceOf(fake: FakeHost): {
    effectiveSplit: (cwd?: string) => {
        enabled: boolean
        source: string
        settingsSource: string
        settings: Record<string, unknown>
        file: string
        problems: readonly string[]
    }
} {
    const service = (fake.ctx as { get: (name: string) => unknown }).get('orchestrator') as
        | { effectiveSplit?: (cwd?: string) => never }
        | undefined
    assert.equal(typeof service?.effectiveSplit, 'function', 'the orchestrator service exposes effectiveSplit')
    return service as never
}

// --- the three precedence combinations --------------------------------------

test('TC-3101: 项目 models.json 开启、profile 未配 → 流水线含 split 与 split-review', async () => {
    const cwd = tempWorkspace('effective-split-project-on-')
    projectModels(cwd, { split: { enabled: true } })
    const fake = host(cwd)
    assert.deepEqual(pipelineIds(await orchestrate(fake, { action: 'stages' })), WITH_SPLIT)
})

test('项目未配、profile 开启 → profile 只作为缺省，流水线同样含 split', async () => {
    const cwd = tempWorkspace('effective-split-profile-default-')
    const fake = host(cwd, { enabled: true })
    assert.deepEqual(pipelineIds(await orchestrate(fake, { action: 'stages' })), WITH_SPLIT)
    assert.equal(serviceOf(fake).effectiveSplit(cwd).source, 'profile')
})

test('TC-3102: 项目显式 false、profile true → 该项目不走拆分（项目文件优先）', async () => {
    const cwd = tempWorkspace('effective-split-project-off-')
    projectModels(cwd, { split: { enabled: false } })
    const fake = host(cwd, { enabled: true })
    assert.deepEqual(pipelineIds(await orchestrate(fake, { action: 'stages' })), WITHOUT_SPLIT)
    const resolved = serviceOf(fake).effectiveSplit(cwd)
    assert.equal(resolved.enabled, false, 'a project `false` beats a profile `true`')
    assert.equal(resolved.source, 'project')
})

test('TC-3106: 项目与 profile 都没开 → 六阶段流水线（现状不变）', async () => {
    const cwd = tempWorkspace('effective-split-both-off-')
    const fake = host(cwd)
    assert.deepEqual(pipelineIds(await orchestrate(fake, { action: 'stages' })), WITHOUT_SPLIT)
})

// --- the pipeline really follows the effective value ------------------------

test('TC-3101: 项目开启时 advance 从 spec-approve 进入 split（不是 implement）', async () => {
    const cwd = tempWorkspace('effective-split-advance-on-')
    projectModels(cwd, { split: { enabled: true } })
    const fake = host(cwd)
    const { store } = missionAt(fake, 'spec-approve')
    await orchestrate(fake, { action: 'advance', verdict: 'PASS', summary: '按项目配置走拆分' })
    assert.equal(store.read('m-effective')?.stage, 'split')
})

test('TC-3102: 项目关闭时 advance 从 spec-approve 直接进入 implement（profile 开着也一样）', async () => {
    const cwd = tempWorkspace('effective-split-advance-off-')
    projectModels(cwd, { split: { enabled: false } })
    const fake = host(cwd, { enabled: true })
    const { store } = missionAt(fake, 'spec-approve')
    await orchestrate(fake, { action: 'advance', verdict: 'PASS', summary: '本项目不走拆分' })
    assert.equal(store.read('m-effective')?.stage, 'implement')
})

// --- effectiveSplit: the shape role-guard reads ----------------------------

test('TC-3103: effectiveSplit() 暴露 enabled、各阈值与来源', () => {
    const cwd = tempWorkspace('effective-split-service-')
    projectModels(cwd, { split: { enabled: true, maxTasks: 4, maxAcceptancePerTask: 2, maxAttempts: 2 }, quality: { maxReworkRatio: 0.5 } })
    const fake = host(cwd, { enabled: false, models: { split: { maxParallel: 2 } } })
    const resolved = serviceOf(fake).effectiveSplit(cwd)
    assert.equal(resolved.enabled, true)
    assert.equal(resolved.source, 'project', 'the project file decides; the profile is only the default')
    assert.equal(resolved.settingsSource, 'project')
    assert.equal(resolved.settings['enabled'], true)
    assert.equal(resolved.settings['maxTasks'], 4)
    assert.equal(resolved.settings['maxAcceptancePerTask'], 2)
    assert.equal(resolved.settings['maxAttempts'], 2)
    assert.equal(resolved.settings['maxReworkRatio'], 0.5)
    // The profile layer fills only what the project left out.
    assert.equal(resolved.settings['maxParallel'], 2)
    assert.equal(resolved.settings['reviewRequired'], true)
    assert.equal(resolved.file, path.join(configDirOf(cwd), 'models.json'))
})

test('TC-3103: 没有项目文件时来源是 default，各阈值是宿主默认', () => {
    const cwd = tempWorkspace('effective-split-defaults-')
    const fake = host(cwd)
    const resolved = serviceOf(fake).effectiveSplit(cwd)
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.source, 'default')
    assert.equal(resolved.settingsSource, 'default')
    assert.equal(resolved.settings['maxTasks'], 8)
    assert.equal(resolved.settings['maxAcceptancePerTask'], 3)
    assert.equal(resolved.settings['maxReworkRatio'], 0.3)
})

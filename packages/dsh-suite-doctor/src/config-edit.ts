/**
 * `/suite set` and `/suite unset`: the HUMAN write path for gate configuration.
 *
 * The two model-facing tools stay read-only on purpose (`tools-scaffold.ts` is
 * the only tool writer, and it only scaffolds): a person reviewing a repository
 * may change a threshold, an agent may not do it on its own behalf. Four
 * properties make this path trustworthy:
 *
 *  - **The plugin's own contract decides the key.** Validation delegates to
 *    `inspect.ts`'s {@link classifyKey} — the same verdict `suite_config`
 *    reports — so "may this key live here" has exactly one answer. An unknown
 *    top-level key is refused unless the person writes `--allow-unknown`; a
 *    host-only key (`enabled`, `askTimeoutMs`, …) is refused either way,
 *    because widening the project ceiling is not a typo to override.
 *  - **The diff is computed before the bytes move**, key by key, from the same
 *    document the write will serialize. A preview produced by a second code
 *    path is a preview that can disagree with the write.
 *  - **Atomic replace, or nothing.** The new document goes to
 *    `<file>.tmp-<random>` first and is renamed over the target. A failure at
 *    any step removes the temporary file and leaves the original bytes alone —
 *    a half-written gate config is worse than no edit at all.
 *  - **Dry run writes nothing.** `--dry-run` returns exactly the diff the real
 *    run would print, and creates nothing (not even a temporary file).
 *
 * The read is uncached (`loadProjectConfig({ cache: false })`), so an edit is
 * always computed against the file on disk rather than against what this
 * process happened to read a minute ago.
 *
 * @module dsh-suite-doctor/config-edit
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig, type Layout } from 'dsh-eng-core'
import { classifyKey } from './inspect.js'
import { SUITE_CONFIGS, descriptorForName, type SuiteConfigDescriptor } from './scaffold-catalog.js'

/** Which write the person asked for. */
export type ConfigEditAction = 'set' | 'unset'

/** The filesystem operations the atomic writer needs (injectable for tests). */
export interface AtomicWriteIo {
    mkdirSync: (dir: string) => void
    writeFileSync: (file: string, text: string) => void
    renameSync: (from: string, to: string) => void
    rmSync: (file: string) => void
}

/** Real filesystem, with the write flags the atomic path depends on. */
const NODE_IO: AtomicWriteIo = {
    mkdirSync: (dir) => fs.mkdirSync(dir, { recursive: true }),
    writeFileSync: (file, text) => fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' }),
    renameSync: (from, to) => fs.renameSync(from, to),
    rmSync: (file) => fs.rmSync(file, { force: true }),
}

/** One requested change, already parsed (the value is a JSON fragment). */
export interface ConfigEditInput {
    /** Workspace root, for the relative path the report prints. */
    cwd: string
    layout: Layout
    /** A scaffolded id / alias / file name (`quality`, `spec-gate`, …). */
    plugin: string
    action: ConfigEditAction
    /** Top-level key. */
    key: string
    /** The parsed value; required for `set`, ignored by `unset`. */
    value?: unknown
    /** Preview only: no file and no temporary file is created. */
    dryRun?: boolean
    /** Allow a top-level key the plugin does not read (never a host-only key). */
    allowUnknown?: boolean
    /** Injected filesystem seams (tests make rename fail here). */
    io?: Partial<AtomicWriteIo>
}

/** What the edit did (or would do). */
export interface ConfigEditResult {
    action: ConfigEditAction
    /** The owning plugin's stable id. */
    pluginId: string
    /** Absolute path of the file that was (or would be) written. */
    file: string
    /** Workspace-relative path (POSIX separators), for the report. */
    relative: string
    key: string
    dryRun: boolean
    /** The document differs from the file on disk. */
    changed: boolean
    /** The bytes were really replaced. */
    written: boolean
    /** Unified per-key lines (`- key: old`, `+ key: new`); empty when unchanged. */
    diff: string[]
    /** Non-fatal notes (an `--allow-unknown` key, an idempotent unset). */
    notes: string[]
    /** The document the edit produced (written, or only previewed). */
    next: Record<string, unknown>
}

function relativeTo(cwd: string, target: string): string {
    const relative = path.relative(cwd, target)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
}

function hasOwn(document: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(document, key)
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Replace a file atomically: write a sibling temporary file, then rename.
 *
 * `flag: 'wx'` guarantees the temporary name cannot clobber anything; the
 * rename is the only moment the target changes, so an error before it leaves
 * the original untouched. A failed rename also removes the temporary file —
 * leaving `.tmp-*` litter next to a trust-root config is its own defect.
 * @param target - absolute path to replace.
 * @param text - the complete new content.
 * @param overrides - filesystem seams (tests simulate a failing rename).
 * @throws when creating, writing or renaming fails (original bytes unchanged).
 */
export function writeFileAtomic(target: string, text: string, overrides: Partial<AtomicWriteIo> = {}): void {
    const io: AtomicWriteIo = { ...NODE_IO, ...overrides }
    const temporary = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`
    try {
        io.mkdirSync(path.dirname(target))
        io.writeFileSync(temporary, text)
        io.renameSync(temporary, target)
    } catch (error) {
        try {
            io.rmSync(temporary)
        } catch {
            // The original file is what must survive; failing to clean up must
            // not replace the real error with a cleanup error.
        }
        throw new Error(`写入 ${target} 失败：${describeError(error)}；原文件未改动（临时文件已删除）`)
    }
}

/** The catalog entry for one spelling, refusing an unknown one with the list. */
function resolveDescriptor(plugin: string): SuiteConfigDescriptor {
    const descriptor = descriptorForName(plugin)
    if (descriptor !== undefined) return descriptor
    throw new Error(
        `不认识的配置名 ${JSON.stringify(plugin)}；可用：${SUITE_CONFIGS.map((entry) => entry.id).join('、')}` +
            '（suite-doctor 自身的项目级配置不在这里改）',
    )
}

/**
 * Read the document a write would merge into.
 *
 * A malformed file is REFUSED, never rewritten: silently replacing it would
 * throw away whatever the person hand-wrote, and "I parsed what I could" is not
 * a merge. The path is the one `loadProjectConfig` actually consults, so a
 * repository still on the legacy `.dsh/<id>.json` location is edited in place
 * instead of behind a new file that would shadow it.
 */
function readDocument(layout: Layout, descriptor: SuiteConfigDescriptor): { file: string; value: Record<string, unknown> } {
    const loaded = loadProjectConfig<Record<string, unknown>>(layout, descriptor.id, { cache: false })
    if (loaded.problems.length > 0) {
        throw new Error(
            `${loaded.file}: 不能改写（${loaded.problems.join('；')}）。` +
                '先修正这份 JSON（或 /suite init --apply --force 重新生成），再重试。',
        )
    }
    return { file: loaded.file, value: loaded.value ?? {} }
}

/**
 * Refuse or annotate the key, using the inspector's own verdict.
 * @returns the notes to print alongside the diff.
 */
function validateKey(descriptor: SuiteConfigDescriptor, key: string, allowUnknown: boolean): string[] {
    if (key === '__proto__') throw new Error('键名 "__proto__" 不允许（原型链键，写进 JSON 只会得到一份读不懂的配置）')
    const verdict = classifyKey(descriptor, key)
    if (verdict.kind === 'forbidden') {
        throw new Error(
            `键 "${key}" 不能在项目级覆盖：${verdict.reason}；未写入` +
                '（--allow-unknown 只放行未知键，不能放行被禁止的项目级键）',
        )
    }
    if (verdict.kind === 'unknown') {
        if (!allowUnknown) {
            const nested = key.includes('.') ? `；它看起来是嵌套字段：请设置顶层键 "${key.split('.')[0]}" 的完整 JSON 值` : ''
            throw new Error(
                `未知顶层键 "${key}"（${descriptor.id} 不读这个键：检查拼写，或写进拥有它的插件配置）${nested}；` +
                    '未写入（确知是字面键名时用 --allow-unknown）',
            )
        }
        return [`--allow-unknown：键 "${key}" 不在 ${descriptor.id} 的契约里，已按字面键名写入（插件会忽略它）`]
    }
    return []
}

/** One value as a diff sees it (bounded: a huge array must not flood the UI). */
function showValue(value: unknown): string {
    if (value === undefined) return '（不存在）'
    const text = JSON.stringify(value) ?? String(value)
    return text.length <= 400 ? text : `${text.slice(0, 400)}…（已截断，共 ${text.length} 字符）`
}

/** The per-key diff between two documents (old on `-`, new on `+`). */
function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
    const lines: string[] = []
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
        const inBefore = hasOwn(before, key)
        const inAfter = hasOwn(after, key)
        if (inBefore === inAfter && (!inBefore || JSON.stringify(before[key]) === JSON.stringify(after[key]))) continue
        lines.push(`- ${key}: ${inBefore ? showValue(before[key]) : '（不存在）'}`)
        lines.push(`+ ${key}: ${inAfter ? showValue(after[key]) : '（删除）'}`)
    }
    return lines
}

/**
 * Plan and (unless `dryRun`) perform one `set` / `unset`.
 *
 * Refusals are thrown BEFORE anything touches the filesystem, so a typo never
 * produces a half-applied change.
 * @param input - workspace, layout, target key and flags.
 * @returns the diff that was (or would be) applied.
 * @throws on an unknown plugin, a refused key, an unreadable file or a failed write.
 */
export function applyConfigEdit(input: ConfigEditInput): ConfigEditResult {
    const descriptor = resolveDescriptor(input.plugin)
    if (input.key.trim() === '') throw new Error('缺少键名：用法 /suite set <plugin> <key> <json-value> 或 /suite unset <plugin> <key>')
    // `undefined` is not a JSON value: a programmatic caller that forgot the
    // value would otherwise write a key that JSON.stringify silently drops.
    if (input.action === 'set' && input.value === undefined) throw new Error('set 缺少值：值必须是一个合法的 JSON 片段')
    const notes = validateKey(descriptor, input.key, input.allowUnknown === true)
    const current = readDocument(input.layout, descriptor)
    const before = current.value
    const next: Record<string, unknown> = { ...before }
    if (input.action === 'set') next[input.key] = input.value
    else delete next[input.key]
    const changed =
        input.action === 'set' ? !hasOwn(before, input.key) || JSON.stringify(before[input.key]) !== JSON.stringify(input.value) : hasOwn(before, input.key)
    if (!changed && input.action === 'unset') notes.push(`文件里没有键 "${input.key}"（unset 无变化）`)
    const dryRun = input.dryRun === true
    const diff = changed ? diffOf(before, next) : []
    if (changed && !dryRun) writeFileAtomic(current.file, `${JSON.stringify(next, null, 2)}\n`, input.io)
    return {
        action: input.action,
        pluginId: descriptor.id,
        file: current.file,
        relative: relativeTo(input.cwd, current.file),
        key: input.key,
        dryRun,
        changed,
        written: changed && !dryRun,
        diff,
        notes,
        next,
    }
}

/**
 * Render one edit for a person: what changed, where, and whether it hit disk.
 * @param result - the outcome of {@link applyConfigEdit}.
 * @returns Chinese text, one diff line per key plus the write verdict.
 */
export function renderConfigEdit(result: ConfigEditResult): string {
    const lines = [
        `/suite ${result.action} ${result.pluginId} ${result.key}${result.dryRun ? '（dry-run：只预览，不写盘）' : ''}`,
        `文件：${result.relative}（${result.file}）`,
        result.diff.length === 0 ? 'diff（旧值 → 新值，逐键）：没有变化' : 'diff（旧值 → 新值，逐键）：',
        ...result.diff,
    ]
    if (result.written) lines.push(`已原子写入 ${result.relative}（先写 .tmp-* 再 rename）；变更 ${result.diff.length / 2} 个键。`)
    else if (result.changed) lines.push(`dry-run：以上 diff 没有写盘；去掉 --dry-run 才会写入 ${result.relative}。`)
    else if (result.action === 'set') lines.push(`未写盘："${result.key}" 的值没有变化。`)
    else lines.push('未写盘：文件保持原样（上面已说明原因）。')
    for (const note of result.notes) lines.push(`⚠ ${note}`)
    return `${lines.join('\n')}\n`
}

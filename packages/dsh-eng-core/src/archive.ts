/**
 * Archiving old missions.
 *
 * The trail only ever grew: every mission keeps its spec, stage results, gate
 * records, evidence and receipts under `.dsh/missions/<id>/`, and nothing ever
 * removed or moved them. That is the right default for auditability and the
 * wrong default for a repository that has been governed for a year — and it also
 * makes "which release contains this work" harder, because the interesting
 * missions are buried under hundreds of finished ones.
 *
 * The rules here are deliberately conservative, because archiving is the one
 * operation in this suite that moves evidence:
 *
 *  1. **Undelivered work is never archived by default.** A mission without a
 *     receipt may still be in progress; its artifacts must stay where the tools
 *     look for them.
 *  2. **The newest `keep` missions always stay**, whatever else is eligible:
 *     recent context is what a human actually reads.
 *  3. **Nothing is deleted.** A mission moves to `<trail>/archive/<yyyy-mm>/<id>`
 *     and an index row records where it went, so `findArchivedMission` can still
 *     answer "where did M-42 go" after the directory disappeared from
 *     `missions/`.
 *  4. **The move is a rename when possible** (same filesystem, atomic) and a
 *     copy-then-remove otherwise, so an archive directory on another volume
 *     still works.
 *
 * Archiving is a human/CI action (`scripts/archive-missions.sh`), not something
 * a model triggers mid-mission: it is not exposed as a tool.
 *
 * @module dsh-eng-core/archive
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, readJson, readJsonl } from './io.js'
import type { Layout } from './paths.js'

/** One mission considered for archiving. */
export interface ArchiveCandidate {
    missionId: string
    title: string
    createdAt: number
    bytes: number
    /** Whether a delivery receipt exists (undelivered missions are kept by default). */
    delivered: boolean
    /** Why this mission is (or is not) eligible. */
    reason: string
}

/** What an archive run did, or would do. */
export interface ArchivePlan {
    candidates: ArchiveCandidate[]
    /** Missions explicitly kept, with the reason. */
    kept: { missionId: string; reason: string }[]
}

/** Options for {@link planArchive}. */
export interface ArchiveOptions {
    layout: Layout
    /** How many of the newest missions always stay (default 20). */
    keep?: number
    /** Only missions older than this many days are eligible (0 = no age rule). */
    olderThanDays?: number
    /** Include missions that were never delivered (default false). */
    includeUndelivered?: boolean
    now?: number
}

/** Result of one archive run. */
export interface ArchiveResult {
    plan: ArchivePlan
    moved: { missionId: string; movedTo: string; bytes: number }[]
    /** Dry runs report the same plan and move nothing. */
    dryRun: boolean
    archiveDir: string
}

/** One row of the archive index. */
export interface ArchiveIndexRow {
    at: number
    missionId: string
    title: string
    createdAt: number
    movedTo: string
    bytes: number
    delivered: boolean
}

function receiptsOf(layout: Layout, missionId: string): number {
    try {
        return fs.readdirSync(path.join(layout.missionsDir, missionId, 'receipts')).filter((name) => name.endsWith('.json')).length
    } catch {
        return 0
    }
}

/** Directory size in bytes, bounded so a huge trail cannot stall planning. */
function sizeOf(dir: string, budgetMs = 1_000): number {
    const started = Date.now()
    let total = 0
    const walk = (current: string): void => {
        if (Date.now() - started > budgetMs) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (!entry.isFile()) continue
            try {
                total += fs.statSync(full).size
            } catch {
                // vanished mid-walk: contributes nothing
            }
        }
    }
    walk(dir)
    return total
}

function readMissionMeta(layout: Layout, missionId: string): { title: string; createdAt: number } | undefined {
    const file = path.join(layout.missionsDir, missionId, 'mission.json')
    const meta = readJson<{ title?: unknown; createdAt?: unknown }>(file)
    if (meta === undefined) return undefined
    return {
        title: typeof meta.title === 'string' ? meta.title : '(无标题)',
        createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    }
}

/**
 * Decide what would be archived, without touching anything.
 * @param options - layout, keep/age/undelivered rules, clock.
 */
export function planArchive(options: ArchiveOptions): ArchivePlan {
    const keep = Math.max(0, options.keep ?? 20)
    const now = options.now ?? Date.now()
    const cutoff = (options.olderThanDays ?? 0) > 0 ? now - (options.olderThanDays ?? 0) * 86_400_000 : undefined
    let ids: string[] = []
    try {
        ids = fs
            .readdirSync(options.layout.missionsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
    } catch {
        ids = []
    }
    const metas = ids
        .map((missionId) => ({ missionId, meta: readMissionMeta(options.layout, missionId) }))
        .filter((entry): entry is { missionId: string; meta: { title: string; createdAt: number } } => entry.meta !== undefined)
        .sort((left, right) => right.meta.createdAt - left.meta.createdAt)

    const protectedIds = new Set(metas.slice(0, keep).map((entry) => entry.missionId))
    const candidates: ArchiveCandidate[] = []
    const kept: { missionId: string; reason: string }[] = []

    for (const [index, entry] of metas.entries()) {
        const delivered = receiptsOf(options.layout, entry.missionId) > 0
        const age = now - entry.meta.createdAt
        if (protectedIds.has(entry.missionId)) {
            kept.push({ missionId: entry.missionId, reason: `最新 ${keep} 个 mission（第 ${index + 1} 个）` })
            continue
        }
        if (!delivered && options.includeUndelivered !== true) {
            kept.push({ missionId: entry.missionId, reason: '尚未交付（没有回执）：可能在途，不动它的证据' })
            continue
        }
        if (cutoff !== undefined && entry.meta.createdAt > cutoff) {
            kept.push({ missionId: entry.missionId, reason: `未超过 ${options.olderThanDays} 天（${Math.floor(age / 86_400_000)} 天）` })
            continue
        }
        candidates.push({
            missionId: entry.missionId,
            title: entry.meta.title,
            createdAt: entry.meta.createdAt,
            bytes: sizeOf(path.join(options.layout.missionsDir, entry.missionId)),
            delivered,
            reason: delivered ? '已交付且不在最新窗口内' : '未交付（按 includeUndelivered 显式纳入）',
        })
    }
    return { candidates, kept }
}

/** Move a directory, falling back to copy+remove across devices. */
function moveDirectory(from: string, to: string): void {
    try {
        fs.renameSync(from, to)
        return
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EXDEV') throw error
        // Another filesystem (an archive on a different volume): copy, then
        // remove the source — never the other way round, so a failure leaves
        // the evidence in place.
        fs.cpSync(from, to, { recursive: true })
        fs.rmSync(from, { recursive: true, force: true })
    }
}

/** The archive directory for a layout (created by {@link archiveMissions}). */
export function archiveDirOf(layout: Layout): string {
    return path.join(layout.rootDir, 'archive')
}

/** Index file of the archive. */
export function archiveIndexFile(layout: Layout): string {
    return path.join(archiveDirOf(layout), 'index.jsonl')
}

/**
 * Archive the missions {@link planArchive} selected.
 * @param options - same rules as the plan, plus `dryRun`.
 */
export function archiveMissions(options: ArchiveOptions & { dryRun?: boolean }): ArchiveResult {
    const plan = planArchive(options)
    const archiveDir = archiveDirOf(options.layout)
    const dryRun = options.dryRun === true
    const moved: { missionId: string; movedTo: string; bytes: number }[] = []
    const now = options.now ?? Date.now()

    if (dryRun || plan.candidates.length === 0) {
        return {
            plan,
            moved: plan.candidates.map((candidate) => ({ missionId: candidate.missionId, movedTo: path.join(archiveDir, '(dry-run)', candidate.missionId), bytes: candidate.bytes })),
            dryRun,
            archiveDir,
        }
    }

    fs.mkdirSync(archiveDir, { recursive: true })
    for (const candidate of plan.candidates) {
        const stamp = new Date(candidate.createdAt === 0 ? now : candidate.createdAt)
        const bucket = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}`
        const targetDir = path.join(archiveDir, bucket)
        fs.mkdirSync(targetDir, { recursive: true })
        const from = path.join(options.layout.missionsDir, candidate.missionId)
        const to = path.join(targetDir, candidate.missionId)
        if (fs.existsSync(to)) {
            // Never merge into an existing directory: an id collision means a
            // human has to look, and silently overwriting loses evidence.
            throw new Error(`归档目标已存在：${to}（mission ${candidate.missionId} 无法归档，请人工处理）`)
        }
        moveDirectory(from, to)
        const row: ArchiveIndexRow = {
            at: now,
            missionId: candidate.missionId,
            title: candidate.title,
            createdAt: candidate.createdAt,
            movedTo: path.relative(options.layout.cwd, to),
            bytes: candidate.bytes,
            delivered: candidate.delivered,
        }
        appendJsonl(archiveIndexFile(options.layout), row)
        moved.push({ missionId: candidate.missionId, movedTo: row.movedTo, bytes: candidate.bytes })
    }
    return { plan, moved, dryRun, archiveDir }
}

/** Read the archive index, tolerating a truncated last line. */
export function readArchiveIndex(layout: Layout): ArchiveIndexRow[] {
    return readJsonl<ArchiveIndexRow>(archiveIndexFile(layout))
}

/** Where an archived mission went, or `undefined` when it was never archived. */
export function findArchivedMission(layout: Layout, missionId: string): ArchiveIndexRow | undefined {
    const rows = readArchiveIndex(layout).filter((row) => row.missionId === missionId)
    return rows.length === 0 ? undefined : rows[rows.length - 1]
}

/** Total archived missions and bytes (for the doctor's footprint). */
export function archiveFootprint(layout: Layout): { missions: number; bytes: number } {
    const rows = readArchiveIndex(layout)
    const archived = archiveDirOf(layout)
    let bytes = 0
    try {
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    walk(full)
                    continue
                }
                if (!entry.isFile()) continue
                try {
                    bytes += fs.statSync(full).size
                } catch {
                    // ignore
                }
            }
        }
        walk(archived)
    } catch {
        bytes = 0
    }
    return { missions: rows.length, bytes }
}

/** Whether `git` reports the archive index as tracked (it should not be: it is runtime). */
export function archiveIndexIgnored(cwd: string, layout: Layout): boolean | undefined {
    const relative = path.relative(cwd, archiveIndexFile(layout))
    const result = spawnSync('git', ['check-ignore', '-q', relative], { cwd, timeout: 10_000 })
    if (result.status === 0) return true
    if (result.status === 1) return false
    return undefined
}

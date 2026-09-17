/**
 * Durable file I/O: atomic JSON/text writes and append-only JSONL.
 *
 * Artifacts the suite writes are evidence, so a half-written file is worse
 * than no file: every whole-file write goes to a temporary sibling and is
 * renamed into place, and every append is a single `appendFileSync` line.
 * Reads never throw — a missing or corrupt artifact reads as `undefined`,
 * letting each caller decide whether that blocks (fail closed) or not.
 *
 * @module dsh-eng-core/io
 */

import fs from 'node:fs'
import path from 'node:path'

/** Create `dir` (and parents) if missing. */
export function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true })
}

/** Read UTF-8 text; `undefined` when absent or unreadable. */
export function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
}

/** Read and parse JSON; `undefined` when absent or unparseable. */
export function readJson<T>(file: string): T | undefined {
    const text = readText(file)
    if (text === undefined) return undefined
    try {
        return JSON.parse(text) as T
    } catch {
        return undefined
    }
}

/** Atomically replace `file` with `text` (temp file + rename). */
export function writeTextAtomic(file: string, text: string): void {
    ensureDir(path.dirname(file))
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporary, text)
    fs.renameSync(temporary, file)
}

/** Atomically replace `file` with pretty-printed JSON. */
export function writeJsonAtomic(file: string, value: unknown): void {
    writeTextAtomic(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Append one JSON object as a single JSONL line. */
export function appendJsonl(file: string, value: unknown): void {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

/** Read a JSONL file into an array; malformed lines are skipped. */
export function readJsonl<T>(file: string): T[] {
    const text = readText(file)
    if (text === undefined) return []
    const rows: T[] = []
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
            rows.push(JSON.parse(trimmed) as T)
        } catch {
            // A truncated tail line is expected after a crash; skip it.
        }
    }
    return rows
}

/** Write `text` to a file only when it does not exist yet (write-once). */
export function writeOnce(file: string, text: string): boolean {
    if (fs.existsSync(file)) return false
    writeTextAtomic(file, text)
    return true
}

/** Whether a path exists. */
export function exists(target: string): boolean {
    try {
        fs.statSync(target)
        return true
    } catch {
        return false
    }
}

/** List entries of a directory (names only); empty when absent. */
export function listDir(dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}

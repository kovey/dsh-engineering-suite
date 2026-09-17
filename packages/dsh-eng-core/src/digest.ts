/**
 * Small pure helpers: digests, ids, and text shaping.
 * @module dsh-eng-core/digest
 */

import { createHash } from 'node:crypto'

/** SHA-256 of a string or buffer, hex encoded. */
export function sha256(input: string | Buffer): string {
    return createHash('sha256').update(input).digest('hex')
}

/** Short form (first `length` hex chars) used in ids and log lines. */
export function shortDigest(input: string | Buffer, length = 12): string {
    return sha256(input).slice(0, length)
}

/** ISO-8601 UTC timestamp for durable records. */
export function nowIso(at: number = Date.now()): string {
    return new Date(at).toISOString()
}

/**
 * Slugify a title into an id fragment: lowercase ASCII letters and digits,
 * everything else collapsed to `-`. CJK characters are dropped so ids stay
 * portable across shells and file systems; an empty result means "no slug".
 */
export function slugify(input: string, maxLength = 32): string {
    const ascii = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return ascii.slice(0, maxLength).replace(/-+$/g, '')
}

/** Compact local timestamp usable inside a file/id (`20260917-145230`). */
export function stamp(at: number = Date.now()): string {
    const date = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Build a mission id from a title: `<slug>-<stamp>` (or `mission-<stamp>`). */
export function missionId(title: string, at: number = Date.now()): string {
    const slug = slugify(title)
    return `${slug === '' ? 'mission' : slug}-${stamp(at)}`
}

/** Truncate text to `max` characters, keeping the tail (logs are tail-shaped). */
export function tail(text: string, max: number): string {
    if (text.length <= max) return text
    return `…[${text.length - max} chars dropped]\n${text.slice(text.length - max)}`
}

/** Truncate text to `max` characters, keeping the head. */
export function head(text: string, max: number): string {
    if (text.length <= max) return text
    return `${text.slice(0, max)}\n…[${text.length - max} chars dropped]`
}

/** Escape a value for a single Markdown table cell. */
export function cell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** Format epoch milliseconds for humans (`2026-09-17 14:52:30Z`). */
export function formatTime(at: number): string {
    return nowIso(at).replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

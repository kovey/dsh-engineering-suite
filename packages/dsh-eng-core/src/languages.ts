/**
 * The languages the suite measures, and the extension map that decides one.
 *
 * The scanner, the metrics and the knowledge base all answer "which language is
 * this file" the same way — by extension, through THIS map. It lives in its own
 * module because the answer is now shared by eleven languages and a second
 * mapping (a regex per caller, a switch per plugin) is the classic way for a
 * `.rb` to be measured as Ruby by one consumer and ignored by another.
 *
 * Two deliberate limits:
 *
 *  - **Extension only.** No shebang sniffing, no content heuristics: a file with
 *    no extension has no language, and an unknown extension stays unknown
 *    (`undefined`). `FileMetrics.language` keeps `'other'` as its bucket for a
 *    file that is not a known language — `languageOf` never returns it, because
 *    "no analyser" and "a language called other" are different facts.
 *  - **Only what has an analyser.** A language is listed here when `metrics.ts`
 *    really measures it (tokens, functions, spans). Adding an extension without
 *    an analyser would report braces-free numbers for a language nobody read.
 *
 * @module dsh-eng-core/languages
 */

import path from 'node:path'

/** Languages the suite understands (detected by extension). */
export type Language =
    | 'go'
    | 'ts'
    | 'js'
    | 'python'
    | 'rust'
    | 'java'
    | 'kotlin'
    | 'csharp'
    | 'php'
    | 'ruby'
    | 'swift'

/** The one extension → language table (lower-case, with the dot). */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
    '.go': 'go',
    '.ts': 'ts',
    '.tsx': 'ts',
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.py': 'python',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
}

/**
 * The language of a workspace-relative path, or `undefined` when nothing analyzes it.
 * @param rel - workspace-relative (or absolute) path; only the basename is read.
 */
export function languageOf(rel: string): Language | undefined {
    const base = path.posix.basename(rel).toLowerCase()
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return undefined
    return LANGUAGE_BY_EXTENSION[base.slice(dot)]
}

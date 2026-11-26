/**
 * The supply-chain gate's standard audit commands, per ecosystem.
 *
 * `suite_init` writes `deps.auditCommands` into `supply-chain-gate.json`. An
 * empty list is not neutral: dependency vulnerabilities are then checked by
 * nobody, and the gate can only WARN. So the scaffold fills in the ecosystem's
 * ESTABLISHED auditor where one exists — and leaves the ecosystems that have no
 * such CLI EMPTY, with the reason printed by the report, instead of inventing a
 * command that will fail on its first run (the same rule `coverageNote` follows
 * for the three unsupported coverage formats).
 *
 * Every entry names the conventional invocation of a real, separately
 * installable tool. None of them is a guess about this repository: the report
 * asks a person to review them, and the file is a starting point.
 *
 * Kept apart from `scaffold-content.ts` (which renders the documents) so the
 * table can be read and reviewed on its own, and so "which ecosystems have an
 * auditor" has exactly ONE source.
 *
 * @module dsh-suite-doctor/scaffold-audit
 */

import type { SuiteLanguage } from './scaffold-languages.js'

/**
 * The established vulnerability-audit CLI of each ecosystem.
 *
 * Absent entries are the ecosystems where no standard CLI exists — `java`,
 * `kotlin`, `swift`; see {@link NO_STANDARD_AUDITOR}. `ts` and `js` share
 * `npm audit --json`: the command is deduplicated by value, so a repository with
 * both ecosystems names it once.
 */
export const AUDIT_COMMAND_BY_LANGUAGE: Partial<Record<SuiteLanguage, string>> = {
    ts: 'npm audit --json',
    js: 'npm audit --json',
    go: 'govulncheck ./...',
    py: 'pip-audit -f json',
    rust: 'cargo audit --json',
    ruby: 'bundler-audit check',
    php: 'composer audit --format=json',
    csharp: 'dotnet list package --vulnerable --include-transitive',
}

/** The one sentence every ecosystem without a standard auditor gets (the report prints it). */
const NO_AUDITOR = '该生态无标准审计器，需人工补充（不编造命令：请按仓库实际工具在 deps.auditCommands 里填写）'

/**
 * Ecosystems that get NO generated command, mapped to the reason — the counter
 * part of {@link AUDIT_COMMAND_BY_LANGUAGE}, so "skipped" is never silent.
 *
 * The reason is a mapping rather than a boolean because the report has to print
 * WHY: a user reading "java: no command" without the way out would reasonably
 * assume the scaffold forgot it.
 */
export const NO_STANDARD_AUDITOR: Partial<Record<SuiteLanguage, string>> = {
    java: NO_AUDITOR,
    kotlin: NO_AUDITOR,
    swift: NO_AUDITOR,
}

/** Standard audit commands for the given ecosystems, deduplicated, order preserved. */
export function auditCommandsFor(languages: readonly SuiteLanguage[]): string[] {
    const commands: string[] = []
    for (const language of languages) {
        const command = AUDIT_COMMAND_BY_LANGUAGE[language]
        if (command !== undefined && !commands.includes(command)) commands.push(command)
    }
    return commands
}

/** One detected ecosystem left without a command, with the reason the report prints. */
export interface SkippedAuditor {
    language: SuiteLanguage
    note: string
}

/** The ecosystems among `languages` that have no standard auditor, in the order given. */
export function skippedAuditors(languages: readonly SuiteLanguage[]): SkippedAuditor[] {
    const skipped: SkippedAuditor[] = []
    for (const language of languages) {
        const note = NO_STANDARD_AUDITOR[language]
        if (note !== undefined) skipped.push({ language, note })
    }
    return skipped
}

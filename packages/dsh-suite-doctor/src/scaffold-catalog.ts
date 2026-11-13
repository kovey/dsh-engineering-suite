/**
 * The ten configuration files `suite_init` scaffolds, with the keys each plugin
 * actually reads.
 *
 * The catalog exists so `suite_init` (writing), `suite_config` (validating) and
 * `/suite doctor` (health) all agree on ONE list: a scaffold that writes a file
 * the inspector does not know about, or an inspector that accepts a key the
 * plugin silently ignores, is the same class of defect — the operator sees a
 * "configured" repository and the gate sees defaults.
 *
 * `knownKeys` is the union of the keys each owning plugin reads from a config row
 * (host-only ones included) and `overridableKeys` is the subset a repository file
 * may really override. The gap between the two is what `suite_config` reports as
 * "被禁止的项目级覆盖键", and keeping them per descriptor (rather than as one
 * global allowlist) is what lets the report name the exact key.
 *
 * `standards.json` is included on purpose even though it is not a plugin config:
 * without it `standards_check` refuses to run (the plugin does not guess
 * thresholds), so a scaffold that skipped it would produce a suite that cannot
 * gate anything.
 *
 * @module dsh-suite-doctor/scaffold-catalog
 */

import fs from 'node:fs'
import path from 'node:path'
import {
    coverageGateContent,
    impactGateContent,
    qualityGateContent,
    standardsContent,
    supplyChainGateContent,
    type SuiteLanguage,
} from './scaffold-content.js'

export type { SuiteLanguage }

/** One scaffoldable configuration file. */
export interface SuiteConfigDescriptor {
    /** Stable id used by `only`, `/suite show <id>` and the doctor checks. */
    id: string
    /** File name under the layout root. */
    file: string
    /** Human label. */
    title: string
    /** Extra accepted spellings (besides the id and the file name). */
    aliases?: readonly string[]
    /** Every top-level key the owning plugin reads (host-only ones included). */
    knownKeys: readonly string[]
    /** Keys a project file may override; empty for repository-owned artifacts. */
    overridableKeys: readonly string[]
    /** `true` when the file is repository-owned (no host ceiling). */
    projectOwned?: boolean
    /** The default document, by ecosystem. */
    content: (language: SuiteLanguage) => Record<string, unknown>
}

/**
 * The ten files, in the order the suite lists them (plan → build → test →
 * interact → deliver → deploy), so a report reads like the pipeline.
 */
export const SUITE_CONFIGS: readonly SuiteConfigDescriptor[] = [
    {
        id: 'spec-gate',
        file: 'spec-gate.json',
        title: '规格门禁',
        knownKeys: ['enforce', 'enforceBoundaries', 'writeTools', 'shellTools', 'shellPolicy', 'boundaryExemptPaths', 'exemptTools', 'requireTestDesign', 'approval', 'reviewChannel', 'reviewTimeoutMs', 'bootstrap', 'planFile', 'adrDir', 'adrIndexFile', 'milestoneRequired', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'rootDir', 'specsDir', 'missionsDir', 'prompt'],
        overridableKeys: ['enforce', 'enforceBoundaries', 'writeTools', 'shellTools', 'shellPolicy', 'boundaryExemptPaths', 'requireTestDesign', 'approval', 'reviewChannel', 'reviewTimeoutMs', 'bootstrap', 'planFile', 'adrDir', 'adrIndexFile', 'milestoneRequired'],
        content: () => ({ enforce: true, enforceBoundaries: true, approval: 'seam' }),
    },
    {
        id: 'test-design-gate',
        file: 'test-design-gate.json',
        title: '测试设计门禁',
        knownKeys: ['minTextLength', 'strict', 'allowDanglingCase', 'requireAllScenarios', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['minTextLength', 'strict', 'allowDanglingCase', 'requireAllScenarios'],
        content: () => ({ strict: false, minTextLength: 4, allowDanglingCase: false, requireAllScenarios: true }),
    },
    {
        id: 'quality-gate',
        file: 'quality-gate.json',
        title: '质量门禁命令',
        knownKeys: ['commands', 'budgets', 'contracts', 'limits', 'defaultTimeoutMs', 'maxOutputBytes', 'writeTools', 'turnStop', 'afterWrite', 'trigger', 'requireSpecBudgets', 'baselineLockRetryMs', 'baselineLockStaleMs', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'rootDir', 'missionsDir', 'specsDir', 'prompt'],
        overridableKeys: ['commands', 'budgets', 'contracts', 'limits', 'defaultTimeoutMs', 'maxOutputBytes', 'writeTools', 'turnStop', 'afterWrite'],
        content: qualityGateContent,
    },
    {
        id: 'standards',
        file: 'standards.json',
        title: '仓库结构规范（仓库自有，不是插件配置）',
        aliases: ['standards-gate'],
        knownKeys: ['languages', 'layers', 'forbidCycles', 'exempt', 'rules'],
        overridableKeys: ['languages', 'layers', 'forbidCycles', 'exempt', 'rules'],
        projectOwned: true,
        content: standardsContent,
    },
    {
        id: 'evidence-gate',
        file: 'evidence-gate.json',
        title: '交付证据门禁',
        knownKeys: ['requiredEvidenceKinds', 'requireCleanTree', 'requireDeliveryApproval', 'requireGate', 'requireStandardsGate', 'standardsGateSource', 'gateSource', 'maxGateAgeMinutes', 'maxOutputTail', 'releasesFile', 'releasesDir', 'requireTagFormat', 'notesIncludeCriteria', 'allowForceOverride', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['requiredEvidenceKinds', 'requireCleanTree', 'requireDeliveryApproval', 'requireGate', 'requireStandardsGate', 'standardsGateSource', 'gateSource', 'maxGateAgeMinutes', 'maxOutputTail', 'releasesFile', 'releasesDir', 'requireTagFormat', 'notesIncludeCriteria'],
        content: () => ({ requireGate: true, gateSource: 'dsh-quality-gate', requiredEvidenceKinds: ['command', 'test'], requireCleanTree: true }),
    },
    {
        id: 'coverage-gate',
        file: 'coverage-gate.json',
        title: '覆盖率门禁',
        knownKeys: ['thresholds', 'coverageCommand', 'reportFile', 'reportFormat', 'flakyPolicy', 'flakyRepeats', 'flakyCommand', 'commandTimeoutMs', 'maxOutputBytes', 'mutation', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['thresholds', 'coverageCommand', 'reportFile', 'reportFormat', 'flakyRepeats', 'flakyCommand', 'commandTimeoutMs', 'maxOutputBytes', 'mutation'],
        content: coverageGateContent,
    },
    {
        id: 'impact-gate',
        file: 'impact-gate.json',
        title: '变更影响分析',
        knownKeys: ['testCommandTemplate', 'fullTestCommand', 'defaultBase', 'maxDistance', 'maxFiles', 'maxFileBytes', 'flaky', 'flakySignatures', 'changeSource', 'reviewDispatch', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['testCommandTemplate', 'fullTestCommand', 'defaultBase', 'maxDistance', 'maxFiles', 'maxFileBytes', 'flaky'],
        content: impactGateContent,
    },
    {
        id: 'supply-chain-gate',
        file: 'supply-chain-gate.json',
        title: '供应链与密钥门禁',
        knownKeys: ['secretScan', 'deps', 'maxFiles', 'maxManifestBytes', 'auditTimeoutMs', 'maxOutputBytes', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['secretScan', 'deps', 'maxFiles', 'maxManifestBytes', 'auditTimeoutMs', 'maxOutputBytes'],
        content: supplyChainGateContent,
    },
    {
        id: 'interaction-gate',
        file: 'interaction-gate.json',
        title: '人工审批/提问接缝',
        knownKeys: ['denyApprovers', 'ledgerFile', 'preferredChannels', 'notifyLevels', 'redactPatterns', 'askTimeoutMs', 'requireApproverList', 'maxPayloadChars', 'outboxFile', 'attentionFile', 'attentionMaxAgeMs', 'im', 'approversFile', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['denyApprovers', 'ledgerFile', 'preferredChannels', 'notifyLevels', 'redactPatterns'],
        content: () => ({ preferredChannels: [] }),
    },
    {
        id: 'deploy-gate',
        file: 'deploy-gate.json',
        title: '部署门禁',
        knownKeys: ['environments', 'verifyRetries', 'verifyBackoffMs', 'commandTimeoutMs', 'verifyApproval', 'ledgerFile', 'goNoGo', 'autoRollbackOnFailure', 'enabled', 'logFile', 'logFileTemplate', 'layout', 'prompt'],
        overridableKeys: ['environments', 'verifyRetries', 'verifyBackoffMs', 'commandTimeoutMs', 'verifyApproval'],
        content: () => ({ environments: [] }),
    },
]

/** The id of this plugin's own project config row (shown by `suite_config`). */
export const SUITE_DOCTOR_ID = 'suite-doctor'

/** One detection rule: a language plus the manifests that name it. */
interface DetectionRule {
    language: SuiteLanguage
    /** Root files matched by exact name. */
    manifests?: readonly string[]
    /** Root files matched by extension (`*.sln`, `*.gemspec`). */
    suffixes?: readonly string[]
}

/**
 * The ONE detection order: highest priority first, and the answer is decided by
 * the first hit.
 *
 * The order is the specification, not an accident: a repository can carry
 * several ecosystems at once, and `tsconfig.json` next to `go.mod` must resolve
 * to TS no matter what a directory listing returns. `build.gradle` (Groovy) is
 * Java's while `build.gradle.kts` is Kotlin's, which is why Java is
 * `pom.xml`/`build.gradle` and Kotlin follows it — a Kotlin file alone still
 * resolves to Kotlin, and a repository with both resolves to Java, in the
 * documented order.
 */
const DETECTION_ORDER: readonly DetectionRule[] = [
    { language: 'ts', manifests: ['tsconfig.json', 'tsconfig.base.json'] },
    { language: 'go', manifests: ['go.mod'] },
    { language: 'rust', manifests: ['Cargo.toml'] },
    { language: 'java', manifests: ['pom.xml', 'build.gradle'] },
    { language: 'kotlin', manifests: ['build.gradle.kts'] },
    { language: 'csharp', suffixes: ['.sln', '.csproj'] },
    { language: 'php', manifests: ['composer.json'] },
    { language: 'ruby', manifests: ['Gemfile'], suffixes: ['.gemspec'] },
    { language: 'swift', manifests: ['Package.swift'] },
    { language: 'py', manifests: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
    { language: 'js', manifests: ['package.json'] },
]

/** What detection observed: the ecosystem, and the file that decided it. */
export interface LanguageDetection {
    language: SuiteLanguage
    /** The manifest that decided it; absent when nothing matched and the default applied. */
    manifest?: string
    /** One line a person can check against the directory. */
    reason: string
}

/** Whether a root entry of that exact name is a file. */
function hasFile(cwd: string, name: string): boolean {
    try {
        return fs.statSync(path.join(cwd, name)).isFile()
    } catch {
        return false
    }
}

/** First root file whose name ends with `suffix` (sorted, so two runs agree). */
function rootFileWithSuffix(cwd: string, suffix: string): string | undefined {
    try {
        return fs
            .readdirSync(cwd, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
            .map((entry) => entry.name)
            .sort()[0]
    } catch {
        return undefined
    }
}

/**
 * Detect the repository's primary ecosystem, naming the evidence.
 *
 * `suite_init` prints `reason`, because "detected rust" without "because of
 * Cargo.toml" is a claim a person cannot check — and a repository that carries
 * several ecosystems is exactly where a silent pick goes wrong.
 * @param cwd - the workspace root.
 */
export function detectLanguageInfo(cwd: string): LanguageDetection {
    for (const rule of DETECTION_ORDER) {
        for (const name of rule.manifests ?? []) {
            if (hasFile(cwd, name)) return { language: rule.language, manifest: name, reason: `检测依据：命中 ${name}` }
        }
        for (const suffix of rule.suffixes ?? []) {
            const name = rootFileWithSuffix(cwd, suffix)
            if (name !== undefined) return { language: rule.language, manifest: name, reason: `检测依据：命中 ${name}（*${suffix}）` }
        }
    }
    return { language: 'ts', reason: '检测依据：没有找到任何已知 manifest，按约定默认 ts' }
}

/** Detect the repository's primary ecosystem from its manifests. */
export function detectLanguage(cwd: string): SuiteLanguage {
    return detectLanguageInfo(cwd).language
}

/** Normalise a spelling to the id form (`quality-gate.json` → `quality-gate`). */
function normalise(name: string): string {
    const base = path.basename(name.trim()).toLowerCase()
    return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base
}

/**
 * Resolve a config spelling (id, short alias, file name) to its descriptor.
 *
 * The short alias is the id without its `-gate` suffix (`quality`, `spec`,
 * `test-design`, …): it is the spelling a person types first, and refusing it
 * while the usage text advertises it would be a grammar trap.
 */
export function descriptorForName(name: string): SuiteConfigDescriptor | undefined {
    const wanted = normalise(name)
    return SUITE_CONFIGS.find((descriptor) => {
        const short = descriptor.id.endsWith('-gate') ? descriptor.id.slice(0, -'-gate'.length) : descriptor.id
        return descriptor.id === wanted || short === wanted || normalise(descriptor.file) === wanted || (descriptor.aliases ?? []).includes(wanted)
    })
}

/**
 * Select the files one invocation covers.
 *
 * An unknown or empty `only` is REFUSED with the available ids: "scaffold
 * nothing" and "I misspelled the name" must not look the same, and a filter
 * that silently dropped a name would leave the operator believing the missing
 * file was already handled.
 */
export function selectDescriptors(only?: readonly string[]): SuiteConfigDescriptor[] {
    if (only === undefined) return [...SUITE_CONFIGS]
    if (only.length === 0) throw new Error(`suite_init: only 是空数组（没有选中任何配置文件）；可用：${SUITE_CONFIGS.map((entry) => entry.id).join('、')}`)
    const wanted = new Set<SuiteConfigDescriptor>()
    const unknown: string[] = []
    for (const name of only) {
        const descriptor = descriptorForName(name)
        if (descriptor === undefined) unknown.push(name)
        else wanted.add(descriptor)
    }
    if (unknown.length > 0) {
        throw new Error(`suite_init: 不认识的配置名 ${unknown.map((name) => JSON.stringify(name)).join('、')}；可用：${SUITE_CONFIGS.map((entry) => entry.id).join('、')}`)
    }
    return SUITE_CONFIGS.filter((descriptor) => wanted.has(descriptor))
}

/**
 * The exact bytes a scaffold writes for one file.
 *
 * Deterministic (two-space JSON, trailing newline) so "apply twice" can be
 * compared byte for byte.
 */
export function configText(descriptor: SuiteConfigDescriptor, language: SuiteLanguage): string {
    return `${JSON.stringify(descriptor.content(language), null, 2)}\n`
}

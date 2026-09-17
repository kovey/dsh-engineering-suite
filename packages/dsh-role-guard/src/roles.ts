/**
 * Role definitions: one Markdown file per role, with a small YAML frontmatter
 * block (docs.md §3.1: "一个 `.md` 文件定义一个角色（persona + 模型 + 工具白名单 +
 * 技能白名单）").
 *
 * The parser intentionally supports only the subset of YAML the format needs —
 * `key: value`, indented `- item` lists, and `key: |` literal blocks — so the
 * plugin has no parser dependency and a malformed role file produces a precise
 * error instead of a surprising parse.
 *
 * @module dsh-role-guard/roles
 */

/** Whether a role may write to the workspace. */
export type RoleMode = 'write' | 'read'

/** One resolved role. */
export interface Role {
    id: string
    name: string
    description: string
    mode: RoleMode
    /** Tool allow-list; empty means "inherit everything except `deny`". */
    tools: readonly string[]
    /** Tool deny-list, applied after the allow-list. */
    deny: readonly string[]
    /**
     * Skill ids this role may use. Empty means "no restriction"; a non-empty
     * list is enforced at invocation time by the skill gate (see README).
     */
    skills: readonly string[]
    /** LLM route overrides for the child agent. */
    provider?: string
    model?: string
    reasoningEffort?: string
    maxTokens?: number
    /** The role's persona, registered as the child's shadowing persona section. */
    persona: string
    /** Where the role came from (`builtin`, a file path, or `config`). */
    source: string
}

/** Parsed frontmatter plus body. */
interface Frontmatter {
    fields: Map<string, string | string[]>
    body: string
}

function unquote(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1)
    }
    return trimmed
}

/**
 * Parse the frontmatter block and body of a role file.
 * @param markdown - the complete file.
 * @returns the fields and body, or `undefined` when there is no frontmatter.
 */
export function parseFrontmatter(markdown: string): Frontmatter | undefined {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    if ((lines[0] ?? '').trim() !== '---') return undefined
    let end = -1
    for (let index = 1; index < lines.length; index += 1) {
        if ((lines[index] ?? '').trim() === '---') {
            end = index
            break
        }
    }
    if (end < 0) return undefined
    const fields = new Map<string, string | string[]>()
    let currentKey: string | undefined
    let literal: string[] | undefined
    for (const line of lines.slice(1, end)) {
        if (literal !== undefined) {
            // A literal block continues while the line is indented.
            if (/^\s+\S/.test(line) || line.trim() === '') {
                literal.push(line.replace(/^ {2}/, ''))
                continue
            }
            fields.set(currentKey ?? '', literal.join('\n').trim())
            literal = undefined
            currentKey = undefined
        }
        const keyMatch = /^([A-Za-z][\w-]*):(.*)$/.exec(line)
        if (keyMatch !== null) {
            const key = keyMatch[1] ?? ''
            const rest = (keyMatch[2] ?? '').trim()
            if (rest === '|' || rest === '>') {
                currentKey = key
                literal = []
                continue
            }
            fields.set(key, unquote(rest))
            currentKey = key
            continue
        }
        const itemMatch = /^\s*-\s+(.*)$/.exec(line)
        if (itemMatch !== null && currentKey !== undefined) {
            const existing = fields.get(currentKey)
            const item = unquote(itemMatch[1] ?? '')
            if (Array.isArray(existing)) existing.push(item)
            else fields.set(currentKey, [item])
            continue
        }
        if (line.trim() === '') continue
    }
    if (literal !== undefined) fields.set(currentKey ?? '', literal.join('\n').trim())
    return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

function asList(value: string | string[] | undefined): string[] {
    if (value === undefined) return []
    // `key: []` is the YAML flow sequence for "empty list" and is what the role
    // files (and this package's README) use for "no restriction". Reading it as
    // the literal string "[]" would turn an explicitly unrestricted role into
    // one whose whitelist holds a single impossible name — which the tool
    // planner then refuses to delegate, and the skill gate would deny every
    // skill for.
    const raw = Array.isArray(value) ? value : value === '' || value === '[]' ? [] : value.split(',')
    return raw.map((entry) => entry.trim()).filter((entry) => entry !== '')
}

function asText(value: string | string[] | undefined): string {
    if (value === undefined) return ''
    return Array.isArray(value) ? value.join('\n') : value
}

/**
 * Turn a role file into a role, allocating a stable id from the file name when
 * the frontmatter omits one.
 * @param markdown - the role file content.
 * @param source - provenance label recorded on the role.
 * @param fallbackId - id used when the frontmatter has no `id`.
 * @returns the role, or an error message describing what is missing.
 */
export function parseRole(markdown: string, source: string, fallbackId = 'role'): Role | { error: string } {
    const parsed = parseFrontmatter(markdown)
    if (parsed === undefined) return { error: `${source}: missing YAML frontmatter (--- … ---)` }
    const { fields, body } = parsed
    const id = asText(fields.get('id')) || fallbackId
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return { error: `${source}: id "${id}" must be lowercase kebab-case` }
    }
    const modeRaw = asText(fields.get('mode')) || 'read'
    if (modeRaw !== 'write' && modeRaw !== 'read') {
        return { error: `${source}: mode must be "write" or "read" (got "${modeRaw}")` }
    }
    const route = asText(fields.get('model'))
    const [provider, model] = route.includes('/') ? route.split('/', 2) : ['', route]
    const persona = [asText(fields.get('persona')), body].filter((part) => part !== '').join('\n\n')
    if (persona.trim() === '') return { error: `${source}: persona must not be empty` }
    const maxTokens = Number(asText(fields.get('maxTokens')))
    return {
        id,
        name: asText(fields.get('name')) || id,
        description: asText(fields.get('description')) || '',
        mode: modeRaw,
        tools: asList(fields.get('tools')),
        deny: asList(fields.get('deny')),
        skills: asList(fields.get('skills')),
        ...(provider === undefined || provider === '' ? {} : { provider }),
        ...(model === undefined || model === '' ? {} : { model }),
        ...(asText(fields.get('reasoningEffort')) === '' ? {} : { reasoningEffort: asText(fields.get('reasoningEffort')) }),
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
        persona,
        source,
    }
}

/** Whether a parsed role is a failure. */
export function isRoleError(value: Role | { error: string }): value is { error: string } {
    return 'error' in value
}

/**
 * Build a role from an inline config object (highest precedence, useful for
 * per-profile roles that must not live in the repository).
 * @param input - the untrusted config value.
 * @param index - position, used for error messages.
 * @returns the role, or `undefined` when the entry is unusable.
 */
export function roleFromConfig(input: unknown, index: number): Role | { error: string } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { error: `roles[${index}]: must be an object` }
    }
    const raw = input as Record<string, unknown>
    const id = typeof raw['id'] === 'string' ? raw['id'] : ''
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return { error: `roles[${index}]: id must be lowercase kebab-case` }
    const mode = raw['mode'] === 'write' ? 'write' : 'read'
    const persona = typeof raw['persona'] === 'string' ? raw['persona'] : ''
    if (persona.trim() === '') return { error: `roles[${index}] (${id}): persona must not be empty` }
    const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    // `model` accepts the same `provider/model` shorthand as a role file, and
    // the route overrides are honoured, so an inline role is not a second-class
    // citizen.
    const route = typeof raw['model'] === 'string' ? raw['model'] : ''
    const [routeProvider, routeModel] = route.includes('/') ? route.split('/', 2) : ['', route]
    const provider = typeof raw['provider'] === 'string' && raw['provider'] !== '' ? raw['provider'] : routeProvider
    const model = typeof raw['model'] === 'string' && raw['model'] !== '' && !route.includes('/') ? routeModel : route.includes('/') ? routeModel : ''
    const maxTokens = typeof raw['maxTokens'] === 'number' && Number.isFinite(raw['maxTokens']) && raw['maxTokens'] > 0 ? raw['maxTokens'] : undefined
    return {
        id,
        name: typeof raw['name'] === 'string' ? raw['name'] : id,
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        mode,
        tools: list(raw['tools']),
        deny: list(raw['deny']),
        skills: list(raw['skills']),
        ...(provider === undefined || provider === '' ? {} : { provider }),
        ...(model === undefined || model === '' ? {} : { model }),
        ...(typeof raw['reasoningEffort'] === 'string' && raw['reasoningEffort'] !== '' ? { reasoningEffort: raw['reasoningEffort'] } : {}),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        persona,
        source: 'config',
    }
}

/** A role registry: id → role, with precedence config > workspace > builtin. */
export class RoleRegistry {
    private readonly roles = new Map<string, Role>()
    private readonly errors: string[] = []
    private readonly broken = new Set<string>()

    /** Register (or replace) a role. */
    add(role: Role): void {
        this.roles.set(role.id, role)
    }

    /** Record a load error (surfaced through `role_list`). */
    fail(message: string): void {
        this.errors.push(message)
        for (const match of message.matchAll(/([a-z][a-z0-9-]*)["'\s:]/g)) {
            const id = match[1]
            if (id !== undefined && id !== 'builtin' && id !== 'roles') this.broken.add(id)
        }
    }

    /** Mark one role id as unusable (its definition failed to parse). */
    markBroken(id: string): void {
        this.broken.add(id)
    }

    /** Role ids whose definition exists but cannot be trusted. */
    brokenIds(): string[] {
        return [...this.broken]
    }

    /** Look up a role. */
    get(id: string): Role | undefined {
        return this.roles.get(id)
    }

    /** All roles, id-sorted. */
    list(): Role[] {
        return [...this.roles.values()].sort((left, right) => left.id.localeCompare(right.id))
    }

    /** Load errors observed while assembling the registry. */
    problems(): readonly string[] {
        return this.errors
    }
}

import yaml from 'js-yaml'

/**
 * YAML frontmatter for the ReadMe repository format.
 *
 * ReadMe pages carry nested frontmatter (`metadata.title`, `next.pages`,
 * `api.file`, `link.url`, ...). Bread only interprets a few keys, but every
 * key is parsed and kept so a page edited in Bread is written back with the
 * rest of its frontmatter intact.
 *
 * The core schema is used on purpose: it has no timestamp type, so
 * `date: 2025-01-15` stays the string the author wrote instead of becoming a
 * Date that would be re-serialized with a time and zone.
 */

export type ReadmeFrontmatter = Record<string, unknown>

export interface ParsedReadmeFile {
  frontmatter: ReadmeFrontmatter
  /** The frontmatter exactly as written, without the `---` lines. */
  rawFrontmatter: string | null
  body: string
  hasFrontmatter: boolean
  /** Set when a frontmatter block is present but is not a YAML mapping. */
  error: string | null
}

const FRONTMATTER_PATTERN = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseReadmeFile(raw: string): ParsedReadmeFile {
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const match = FRONTMATTER_PATTERN.exec(normalized)
  if (!match) {
    return {
      frontmatter: {},
      rawFrontmatter: null,
      body: normalized,
      hasFrontmatter: false,
      error: null,
    }
  }
  const body = normalized.slice(match[0].length)
  const rawFrontmatter = match[1] ?? ''
  let loaded: unknown
  try {
    loaded = yaml.load(match[1] ?? '', { schema: yaml.CORE_SCHEMA })
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML'
    return {
      frontmatter: {},
      rawFrontmatter,
      body,
      hasFrontmatter: true,
      error: `frontmatter is not valid YAML (${reason})`,
    }
  }
  if (loaded === null || loaded === undefined) {
    return { frontmatter: {}, rawFrontmatter, body, hasFrontmatter: true, error: null }
  }
  if (!isRecord(loaded)) {
    return {
      frontmatter: {},
      rawFrontmatter,
      body,
      hasFrontmatter: true,
      error: 'frontmatter must be a YAML mapping',
    }
  }
  return { frontmatter: loaded, rawFrontmatter, body, hasFrontmatter: true, error: null }
}

/**
 * Write a page. When `rawFrontmatter` is given it is used verbatim: the caller
 * passes it when the frontmatter is unchanged, so the author's own YAML
 * spelling (quotes, folding, comments) survives an edit to the body.
 */
export function serializeReadmeFile(
  frontmatter: ReadmeFrontmatter,
  body: string,
  rawFrontmatter?: string | null,
): string {
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '')
  const keys = Object.keys(frontmatter)
  const head =
    typeof rawFrontmatter === 'string'
      ? `---\n${rawFrontmatter ? `${rawFrontmatter}\n` : ''}---\n`
      : keys.length === 0
      ? ''
      : `---\n${yaml
          .dump(frontmatter, {
            schema: yaml.CORE_SCHEMA,
            // Same folding width ReadMe uses, so long values wrap alike.
            lineWidth: 80,
            noRefs: true,
            // ReadMe writes single-quoted strings; matching it keeps the
            // frontmatter of an edited page byte-identical where unchanged.
            quotingType: "'",
          })
          .replace(/\s+$/, '')}\n---\n`
  if (!trimmedBody) return head || '\n'
  return `${head}${trimmedBody}\n`
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function frontmatterTitle(frontmatter: ReadmeFrontmatter): string {
  return text(frontmatter.title)
}

/** `hidden: true` keeps a page out of the published site. */
export function frontmatterHidden(frontmatter: ReadmeFrontmatter): boolean {
  return frontmatter.hidden === true || frontmatter.hidden === 'true'
}

/** A `slug:` override, when it is usable as one URL segment. */
export function frontmatterSlug(frontmatter: ReadmeFrontmatter): string | null {
  const value = text(frontmatter.slug).replace(/^\/+|\/+$/g, '')
  return value && !value.includes('/') ? value : null
}

/**
 * An API reference stub: a page whose content is generated from an operation
 * (or webhook) in an OpenAPI file. Bread generates these pages from the spec
 * itself, so stubs are left alone in the repository and not imported.
 */
export function isApiReferenceStub(frontmatter: ReadmeFrontmatter): boolean {
  const api = frontmatter.api
  if (!isRecord(api)) return false
  return Boolean(text(api.file) || text(api.operationId) || text(api.webhook))
}

/**
 * ReadMe keeps a few API reference settings as pages (`api_config:
 * authentication`, `getting-started`, `my-requests`). They configure ReadMe's
 * own reference UI and have no content to show.
 */
export function isReadmeConfigPage(frontmatter: ReadmeFrontmatter): boolean {
  return text(frontmatter.api_config) !== ''
}

/** `date` (changelog) normalized to ISO, or null when absent or unparseable. */
export function frontmatterDate(frontmatter: ReadmeFrontmatter): string | null {
  const value = text(frontmatter.date)
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * The frontmatter to write for a page edited in Bread. Everything the author
 * had is kept; only the fields Bread owns (title, hidden, changelog date) are
 * replaced, and each only when its value actually differs.
 */
export function mergeReadmeFrontmatter(input: {
  previous: ReadmeFrontmatter | null
  title: string
  hidden: boolean
  /** ISO publication date; only written for changelog entries. */
  date?: string | null
}): ReadmeFrontmatter {
  const previous = input.previous ?? {}
  const next: ReadmeFrontmatter = {}
  // Title first for a new file; an existing file keeps its own key order.
  if (!('title' in previous)) next.title = input.title
  for (const [key, value] of Object.entries(previous)) next[key] = value
  next.title = input.title

  if ('hidden' in previous || input.hidden || input.previous === null) {
    next.hidden = input.hidden
  }

  if (input.date) {
    const existing = frontmatterDate(previous)
    if (existing !== new Date(input.date).toISOString()) {
      // ReadMe writes changelog dates as a plain day.
      next.date = new Date(input.date).toISOString().slice(0, 10)
    }
  }
  return next
}

/** Parse an `_order.yaml`: a flat list of slugs, in sidebar order. */
export function parseOrderFile(raw: string): string[] | null {
  let loaded: unknown
  try {
    loaded = yaml.load(raw.replace(/^﻿/, ''), { schema: yaml.CORE_SCHEMA })
  } catch {
    return null
  }
  if (loaded === null || loaded === undefined) return []
  if (!Array.isArray(loaded)) return null
  const entries: string[] = []
  const seen = new Set<string>()
  for (const item of loaded) {
    const entry = text(item).replace(/\.(?:md|mdx)$/i, '')
    if (!entry || entry.includes('/') || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }
  return entries
}

export function serializeOrderFile(entries: string[]): string {
  if (entries.length === 0) return '[]\n'
  return yaml.dump(entries, { schema: yaml.CORE_SCHEMA, lineWidth: -1 })
}

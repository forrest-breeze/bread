#!/usr/bin/env -S npx tsx
import { normalizeDocumentTabs } from "../src/lib/document-tabs"
// =============================================================================
// import-llms-docs.ts — mirror an external docs site into a Breezify workspace.
//
// Reads a site's `llms.txt` index (the convention ReadMe, Mintlify and others
// publish) and the raw Markdown each entry links to, converts it into the
// Markdown the public portal renders, and writes it as a folder tree:
//
//   <Brand> Docs/             one folder per `## Guides: …` section, nested by
//     <Section>/…             the index's link-less group labels
//   <Brand> API Reference/    one folder per endpoint group; each OpenAPI page
//     <Group>/…               becomes a `## METHOD /path` reference document
//
// Then it seeds a DRAFT docs portal project scoped to the guides (sections
// promoted to top level) with an "API Reference" page over the reference tree.
// Nothing is public until someone publishes the draft in the portal builder.
//
// Idempotent: folders resolve on (workspace_id, kind, name), documents on
// (workspace_id, public_slug), the project on its slug. It never deletes.
//
// USAGE
//   npx tsx scripts/import-llms-docs.ts --site https://docs.breeze.com \
//     --brand Breeze --dry-run --out /tmp/breeze
//       Fetch + convert only; writes the converted Markdown to --out. No DB.
//
//   npx tsx scripts/import-llms-docs.ts --site https://docs.breeze.com \
//     --brand Breeze --workspace-id <uuid> | --workspace-slug <slug>
//     [--project-slug breeze] [--skip-index]
//       Import into an existing workspace (needs NEXT_PUBLIC_SUPABASE_URL and
//       SUPABASE_SECRET_KEY; .env.local is loaded automatically).
//       --skip-index skips RAG chunking + embeddings (search still works; the
//       AI assistant needs the index).
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// llms.txt parsing
// ---------------------------------------------------------------------------

export interface IndexEntry {
  url: string
  title: string
  kind: "guide" | "reference"
  /** Folder labels from the section down to the entry's group. */
  route: string[]
  /** Position in the index — used as the in-folder sort order. */
  order: number
}

const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)/

export function parseLlmsTxt(text: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  let section: string | null = null
  let kind: IndexEntry["kind"] = "guide"
  // Group labels by list depth; a linked page never opens a folder, so its
  // children land in the same folder right after it.
  let groups: Array<{ depth: number; label: string }> = []

  for (const raw of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw)
    if (heading) {
      const label = heading[1]
      const reference = /^API Reference\b/i.test(label)
      kind = reference ? "reference" : "guide"
      section = reference ? null : label.replace(/^Guides:\s*/i, "")
      groups = []
      continue
    }
    const item = /^(\s*)-\s+(.*)$/.exec(raw)
    if (!item) continue
    const depth = Math.floor(item[1].length / 2)
    const body = item[2].trim()
    groups = groups.filter((group) => group.depth < depth)
    const link = LINK_RE.exec(body)
    if (!link) {
      groups.push({ depth, label: body })
      continue
    }
    if (!/\.md$/.test(link[2])) continue
    entries.push({
      url: link[2],
      title: link[1].trim(),
      kind,
      route: [...(section ? [section] : []), ...groups.map((group) => group.label)],
      order: entries.length,
    })
  }
  return entries
}

export function slugFromUrl(url: string): string {
  return path.posix.basename(new URL(url).pathname, ".md").toLowerCase()
}

// ---------------------------------------------------------------------------
// Markdown conversion
//
// The portal renders a document as raw HTML as soon as it contains ANY known
// HTML tag outside code (lib/html-detection), so every MDX component and HTML
// fragment is rewritten into plain Markdown here.
// ---------------------------------------------------------------------------

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function dedent(block: string): string {
  const lines = block.replace(/^\n+|\s+$/g, "").split("\n")
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^ */.exec(line)![0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(min, /^ */.exec(line)![0].length))).join("\n")
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|\\{"([^"]*)"\\})`).exec(attrs)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

function cellText(html: string): string {
  return inlineHtmlToMarkdown(html)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim()
}

function htmlTableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cellText(cell[2])),
  )
  if (rows.length === 0) return ""
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")]
  const [head, ...rest] = rows
  return [
    `| ${pad(head).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rest.map((row) => `| ${pad(row).join(" | ")} |`),
  ].join("\n")
}

function inlineHtmlToMarkdown(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<code>([\s\S]*?)<\/code>/gi, (_m, code: string) => `\`${code.trim()}\``)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "_$2_")
    .replace(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, label: string) => {
      const href = attr(attrs, "href")
      return href ? `[${label.trim()}](${href})` : label
    })
}

/** Rewrite MDX components into Markdown. Code fences are left untouched. */
/**
 * Swap fenced code blocks for single-line placeholders so tag rewriting never
 * touches code. Each fence is stored without its own indentation and restored
 * at the placeholder's (possibly dedented) indentation.
 */
function protectFences(text: string): { text: string; restore: (out: string) => string } {
  const fences: string[] = []
  const lines = text.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(```|~~~)/.exec(lines[i])
    if (!open) {
      out.push(lines[i])
      continue
    }
    const indent = open[1].length
    const block = [lines[i]]
    let j = i + 1
    while (j < lines.length && !new RegExp(`^\\s*${open[2]}\\s*$`).test(lines[j])) block.push(lines[j++])
    if (j < lines.length) block.push(lines[j])
    i = j
    fences.push(block.map((line) => line.slice(Math.min(indent, /^ */.exec(line)![0].length))).join("\n"))
    out.push(`${" ".repeat(indent)}\u0000FENCE${fences.length - 1}\u0000`)
  }
  return {
    text: out.join("\n"),
    restore: (converted) =>
      converted.replace(/^([ >]*)\u0000FENCE(\d+)\u0000/gm, (_m, lead: string, n: string) =>
        fences[Number(n)].split("\n").map((line) => `${lead}${line}`).join("\n"),
      ),
  }
}

function convertComponents(source: string): string {
  const fenced = protectFences(normalizeDocumentTabs(source))
  let out = fenced.text
    .replace(/<style>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<table[\s\S]*?<\/table>/gi, (table) => `\n${htmlTableToMarkdown(table)}\n`)
    .replace(/<Anchor\s([^>]*)>([\s\S]*?)<\/Anchor>/g, (_m, attrs: string, label: string) => {
      const href = attr(attrs, "href")
      return href ? `[${label.trim()}](${href})` : label
    })
    .replace(/<Image\s([^>]*?)\/?>/g, (_m, attrs: string) => {
      const src = attr(attrs, "src")
      return src ? `\n![${attr(attrs, "alt") ?? ""}](${src})\n` : ""
    })
    .replace(/<img\s([^>]*?)\/?>/gi, (_m, attrs: string) => {
      const src = attr(attrs, "src")
      return src ? `![${attr(attrs, "alt") ?? ""}](${src})` : ""
    })
    // Video/link embeds become a plain link to the embedded resource.
    .replace(/<Embed\s([^>]*?)\/?>/g, (_m, attrs: string) => {
      const url = attr(attrs, "url") ?? attr(attrs, "href")
      if (!url) return ""
      const label = attr(attrs, "title") || (attr(attrs, "providerName") ? `Watch on ${attr(attrs, "providerName")}` : url)
      return `\n[${label}](${url})\n`
    })

  // Innermost-first: callouts and accordions can sit inside tabs.
  for (let pass = 0; pass < 3; pass += 1) {
    out = out
      .replace(/<Callout([^>]*)>([\s\S]*?)<\/Callout>/g, (_m, attrs: string, body: string) => {
        const icon = attr(attrs, "icon")
        const lines = dedent(body).split("\n")
        if (icon && lines.length) lines[0] = `${icon} ${lines[0]}`
        return `\n${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n`
      })
      .replace(/<Accordion([^>]*)>([\s\S]*?)<\/Accordion>/g, (_m, attrs: string, body: string) => {
        const title = attr(attrs, "title")
        return `\n${title ? `#### ${title}\n\n` : ""}${dedent(body)}\n`
      })
      .replace(/<Tab([^s>][^>]*|)>([\s\S]*?)<\/Tab>/g, (_m, attrs: string, body: string) => {
        const title = attr(attrs, "title")
        return `\n${title ? `#### ${title}\n\n` : ""}${dedent(body)}\n`
      })
  }
  return fenced.restore(out.replace(/<\/?(Tabs|AccordionGroup|Cards|Columns)[^>]*>/g, ""))
}

/** Strip leftover tags outside code (fence- and backtick-aware). */
function stripTagsOutsideCode(text: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of text.split("\n")) {
    const fence = /^\s*(```|~~~)/.test(line)
    if (fence) inFence = !inFence
    if (inFence || fence) {
      out.push(line)
      continue
    }
    if (/^\s*(import|export)\s/.test(line)) continue
    // A line break inside a Markdown table row would split the row.
    const source = line.trimStart().startsWith("|") ? line.replace(/<br\s*\/?>/gi, " ") : line
    out.push(
      source
        .split(/(`+[^`]*`+)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : inlineHtmlToMarkdown(part).replace(/<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/g, ""),
        )
        .join(""),
    )
  }
  return out.join("\n")
}

/** Maps a link in the source docs to its portal URL, or null to leave it. */
export type LinkResolver = (href: string) => string | null

/** Rewrite Markdown link targets outside code fences. */
function rewriteLinks(text: string, resolve: LinkResolver): string {
  let inFence = false
  return text
    .split("\n")
    .map((line) => {
      const fence = /^\s*(```|~~~)/.test(line)
      if (fence) inFence = !inFence
      if (inFence || fence) return line
      return line.replace(/\]\(([^)\s]+)\)/g, (match, href: string) => {
        const next = resolve(href)
        return next ? `](${next})` : match
      })
    })
    .join("\n")
}

/**
 * Resolver for links between pages of the imported site: absolute links on the
 * site's hosts and relative `slug` / `/docs/slug` / `/reference/slug` links.
 */
export function siteLinkResolver(input: {
  hosts: string[]
  guideSlugs: Set<string>
  referenceSlugs: Set<string>
  guideHref: (slug: string) => string
  referenceHref: (slug: string) => string
}): LinkResolver {
  return (href) => {
    if (href.startsWith("#") || href.startsWith("mailto:")) return null
    let pathname: string
    let hash = ""
    try {
      const url = new URL(href, `https://${input.hosts[0]}/docs/`)
      if (!input.hosts.includes(url.hostname)) return null
      pathname = url.pathname
      hash = url.hash && url.hash !== "#/" && !url.hash.startsWith("#/") ? url.hash : ""
    } catch {
      return null
    }
    const match = /^\/(docs|reference)\/([^/]+?)\/?$/.exec(pathname)
    if (!match) return null
    const slug = match[2].toLowerCase()
    if (match[1] === "reference" && input.referenceSlugs.has(slug)) {
      return `${input.referenceHref(slug)}${hash}`
    }
    if (input.guideSlugs.has(slug)) return `${input.guideHref(slug)}${hash}`
    if (input.referenceSlugs.has(slug)) return `${input.referenceHref(slug)}${hash}`
    // A page the index doesn't list: keep pointing at the live site rather
    // than at a portal URL that would 404.
    return `https://${input.hosts[0]}/${match[1]}/${slug}${hash}`
  }
}

export function convertGuide(raw: string, title: string): string {
  let text = stripFrontmatter(raw)
  // The portal renders the title as the page heading.
  text = text.replace(/^\s*#\s+(.+?)\s*\n/, (line, heading: string) =>
    heading.trim() === title.trim() ? "" : line,
  )
  text = stripTagsOutsideCode(convertComponents(text))
  return `${text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}\n`
}

// ---------------------------------------------------------------------------
// OpenAPI reference pages
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const

function asObj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

function resolveRef(spec: Json, node: unknown, seen = new Set<string>()): Json {
  const obj = asObj(node)
  const ref = typeof obj.$ref === "string" ? obj.$ref : null
  if (!ref || seen.has(ref) || !ref.startsWith("#/")) return obj
  seen.add(ref)
  const target = ref
    .slice(2)
    .split("/")
    .reduce<unknown>((acc, key) => asObj(acc)[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec)
  return resolveRef(spec, target, seen)
}

function schemaType(spec: Json, schema: unknown): string {
  const s = resolveRef(spec, schema)
  if (Array.isArray(s.enum)) return `enum: ${s.enum.map((v) => `\`${String(v)}\``).join(", ")}`
  if (s.type === "array") return `array of ${schemaType(spec, s.items)}`
  const variants = (s.oneOf ?? s.anyOf) as unknown[] | undefined
  if (Array.isArray(variants)) return variants.map((v) => schemaType(spec, v)).join(" \\| ")
  if (typeof s.type === "string") return s.format ? `${s.type} (${s.format})` : s.type
  if (Array.isArray(s.type)) return s.type.join(" \\| ")
  return s.properties ? "object" : "any"
}

function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim() : ""
}

/** Flatten object properties into table rows, nesting with dotted names. */
/** Every schema whose properties apply: the schema, its allOf, and oneOf/anyOf variants. */
function schemaParts(spec: Json, schema: Json, seen: Set<unknown>): Json[] {
  if (seen.has(schema)) return []
  seen.add(schema)
  const nested = ["allOf", "oneOf", "anyOf"].flatMap((key) =>
    ((schema[key] as unknown[] | undefined) ?? []).flatMap((part) => schemaParts(spec, resolveRef(spec, part), seen)),
  )
  return [schema, ...nested]
}

function propertyRows(
  spec: Json,
  schema: unknown,
  prefix = "",
  rows: string[] = [],
  path: Set<unknown> = new Set(),
): string[] {
  const s = resolveRef(spec, schema)
  if (path.has(s) || path.size > 8) return rows
  const nextPath = new Set(path).add(s)
  const parts = schemaParts(spec, s, new Set())
  const required = new Set(parts.flatMap((p) => (Array.isArray(p.required) ? (p.required as string[]) : [])))
  const emitted = new Set<string>()
  for (const part of parts) {
    for (const [name, prop] of Object.entries(asObj(part.properties))) {
      if (emitted.has(name)) continue
      emitted.add(name)
      const resolved = resolveRef(spec, prop)
      const field = `${prefix}${name}`
      const notes = [
        oneLine(resolved.description),
        resolved.default !== undefined ? `Default: \`${JSON.stringify(resolved.default)}\`.` : "",
        resolved.example !== undefined ? `Example: \`${JSON.stringify(resolved.example)}\`.` : "",
      ].filter(Boolean)
      rows.push(
        `| \`${field}\` | ${schemaType(spec, prop)} | ${required.has(name) ? "Yes" : ""} | ${notes.join(" ").replace(/\|/g, "\\|")} |`,
      )
      const child = resolved.type === "array" ? resolveRef(spec, resolved.items) : resolved
      if (schemaParts(spec, child, new Set()).some((p) => p.properties)) {
        propertyRows(spec, child, `${field}${resolved.type === "array" ? "[]" : ""}.`, rows, nextPath)
      }
    }
  }
  return rows
}

function fieldTable(rows: string[]): string {
  return rows.length
    ? ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows].join("\n")
    : ""
}

export function renderOperation(spec: Json, method: string, route: string, op: Json, isWebhook: boolean): string {
  const lines: string[] = [isWebhook ? `## POST ${route} (webhook)` : `## ${method.toUpperCase()} ${route}`]
  const description = typeof op.description === "string" ? op.description : op.summary
  if (typeof description === "string" && description.trim()) lines.push("", description.trim())

  const params = ((op.parameters as unknown[] | undefined) ?? []).map((p) => resolveRef(spec, p))
  for (const location of ["path", "query", "header"]) {
    const rows = params
      .filter((p) => p.in === location)
      .map(
        (p) =>
          `| \`${String(p.name)}\` | ${schemaType(spec, p.schema)} | ${p.required ? "Yes" : ""} | ${oneLine(p.description)} |`,
      )
    if (rows.length) {
      lines.push("", `### ${location[0].toUpperCase()}${location.slice(1)} parameters`, "", fieldTable(rows))
    }
  }

  const body = resolveRef(spec, op.requestBody)
  for (const [contentType, media] of Object.entries(asObj(body.content))) {
    const rows = propertyRows(spec, asObj(media).schema)
    lines.push("", isWebhook ? "### Payload" : `### Request body (\`${contentType}\`)`)
    if (rows.length) lines.push("", fieldTable(rows))
    const example = asObj(media).example ?? Object.values(asObj(asObj(media).examples)).map((e) => asObj(e).value)[0]
    if (example !== undefined) lines.push("", "```json", JSON.stringify(example, null, 2), "```")
    break
  }

  const responses = Object.entries(asObj(op.responses))
  if (responses.length) {
    lines.push("", "### Responses")
    for (const [status, response] of responses) {
      const resolved = resolveRef(spec, response)
      lines.push("", `#### ${status}${resolved.description ? ` — ${oneLine(resolved.description)}` : ""}`)
      const media = Object.values(asObj(resolved.content))[0]
      if (!media) continue
      const rows = propertyRows(spec, asObj(media).schema)
      if (rows.length) lines.push("", fieldTable(rows))
      const example =
        asObj(media).example ?? Object.values(asObj(asObj(media).examples)).map((e) => asObj(e).value)[0]
      if (example !== undefined) lines.push("", "```json", JSON.stringify(example, null, 2), "```")
    }
  }
  return lines.join("\n")
}

/** The spec trimmed to what this page's operations reference. */
export function prunedSpec(spec: Json): Json {
  const components = asObj(spec.components)
  const used = new Map<string, Set<string>>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    const obj = asObj(node)
    const ref = typeof obj.$ref === "string" ? /^#\/components\/([^/]+)\/(.+)$/.exec(obj.$ref) : null
    if (ref) {
      const names = used.get(ref[1]) ?? new Set<string>()
      if (!names.has(ref[2])) {
        names.add(ref[2])
        used.set(ref[1], names)
        visit(asObj(components[ref[1]])[ref[2]])
      }
    }
    Object.values(obj).forEach(visit)
  }
  visit(spec.paths)
  visit(spec.webhooks)
  const operations = [...Object.values(asObj(spec.paths)), ...Object.values(asObj(spec.webhooks))]
    .flatMap((item) => HTTP_METHODS.map((method) => asObj(asObj(item)[method])))
  const tagNames = new Set(operations.flatMap((op) => (op.tags as string[] | undefined) ?? []))
  const prunedComponents: Json = {}
  for (const [kind, names] of used) {
    prunedComponents[kind] = Object.fromEntries([...names].map((name) => [name, asObj(components[kind])[name]]))
  }
  if (components.securitySchemes) prunedComponents.securitySchemes = components.securitySchemes
  return {
    openapi: spec.openapi,
    ...(spec.servers ? { servers: spec.servers } : {}),
    ...(spec.security ? { security: spec.security } : {}),
    ...(Array.isArray(spec.tags)
      ? { tags: (spec.tags as Json[]).filter((tag) => tagNames.has(String(tag.name))) }
      : {}),
    ...(spec.paths ? { paths: spec.paths } : {}),
    ...(spec.webhooks ? { webhooks: spec.webhooks } : {}),
    components: prunedComponents,
  }
}

export function convertReference(raw: string, title: string): string {
  const text = stripFrontmatter(raw)
  const specMatch = /#\s*OpenAPI definition\s*```json\n([\s\S]*?)\n```/.exec(text)
  // Without a spec it is an ordinary prose page.
  if (!specMatch) return convertGuide(raw, title)
  const intro = convertGuide(text.slice(0, specMatch.index), title).trim()
  const spec = JSON.parse(specMatch[1]) as Json
  const sections: string[] = []
  for (const [route, item] of Object.entries(asObj(spec.paths))) {
    for (const method of HTTP_METHODS) {
      const op = asObj(asObj(item)[method])
      if (Object.keys(op).length) sections.push(renderOperation(spec, method, route, op, false))
    }
  }
  for (const [name, item] of Object.entries(asObj(spec.webhooks))) {
    for (const method of HTTP_METHODS) {
      const op = asObj(asObj(item)[method])
      if (Object.keys(op).length) sections.push(renderOperation(spec, method, name, op, true))
    }
  }
  // The operation heading leads so the API-reference view picks up the method.
  const description = intro && !sections.join("").includes(intro) ? `\n\n${intro}` : ""
  const [first, ...rest] = sections
  const definition = ["### OpenAPI definition", "", "```json", JSON.stringify(prunedSpec(spec), null, 2), "```"].join("\n")
  return `${[first ? first.replace(/^(## .+)$/m, `$1${description}`) : intro, ...rest, definition].join("\n\n").trim()}\n`
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/markdown, text/plain" } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.text()
    } catch (err) {
      if (attempt >= 3) throw new Error(`fetch ${url}: ${err instanceof Error ? err.message : String(err)}`)
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

interface ConvertedDoc extends IndexEntry {
  slug: string
  content: string
}

async function loadSite(site: string, portalBase: string): Promise<ConvertedDoc[]> {
  const index = parseLlmsTxt(await fetchText(new URL("/llms.txt", site).toString()))
  const docs: ConvertedDoc[] = []
  const seen = new Set<string>()
  for (const [i, entry] of index.entries()) {
    let slug = slugFromUrl(entry.url)
    if (seen.has(slug)) slug = `${entry.kind === "reference" ? "api" : "guide"}-${slug}`
    seen.add(slug)
    const raw = await fetchText(entry.url)
    const content =
      entry.kind === "reference" ? convertReference(raw, entry.title) : convertGuide(raw, entry.title)
    docs.push({ ...entry, slug, content })
    if (i % 20 === 19 || i === index.length - 1) console.log(`Fetched ${i + 1}/${index.length}`)
  }
  const host = new URL(site).hostname
  const resolve = siteLinkResolver({
    // ReadMe sites often keep serving their previous domain in old links.
    hosts: [host, host.replace(/\.com$/, ".cash"), host.replace(/\.cash$/, ".com")],
    guideSlugs: new Set(docs.filter((doc) => doc.kind === "guide").map((doc) => doc.slug)),
    referenceSlugs: new Set(docs.filter((doc) => doc.kind === "reference").map((doc) => doc.slug)),
    guideHref: (slug) => `${portalBase}/doc/${slug}`,
    referenceHref: (slug) => `${portalBase}/page/api-reference/${slug}`,
  })
  return docs.map((doc) => ({ ...doc, content: rewriteLinks(doc.content, resolve) }))
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function loadLocalEnv(): Promise<void> {
  try {
    const raw = await readFile(path.join(SCRIPT_DIR, "../.env.local"), "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
      }
    }
  } catch {
    // Env may come from the shell instead.
  }
}

function makeAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function keyFor(...parts: string[]): string {
  return parts
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .join("/")
}

async function ensureFolder(
  admin: SupabaseClient,
  workspaceId: string,
  input: { name: string; displayName: string; parentId: string | null; sortOrder: number },
): Promise<string> {
  const { data: existing, error } = await admin
    .from("folders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "user")
    .eq("name", input.name)
    .maybeSingle()
  if (error) throw new Error(`folder lookup ${input.name}: ${error.message}`)
  const row = {
    display_name: input.displayName,
    parent_folder_id: input.parentId,
    sort_order: input.sortOrder,
    visibility: "workspace",
  }
  if (existing) {
    const { error: updateError } = await admin.from("folders").update(row).eq("id", existing.id)
    if (updateError) throw new Error(`folder update ${input.name}: ${updateError.message}`)
    return existing.id as string
  }
  const { data: created, error: createError } = await admin
    .from("folders")
    .insert({ workspace_id: workspaceId, kind: "user", name: input.name, ...row })
    .select("id")
    .single()
  if (createError || !created) throw new Error(`folder create ${input.name}: ${createError?.message}`)
  return created.id as string
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const site = flag("site")
  const brand = flag("brand")
  if (!site || !brand) throw new Error("--site and --brand are required")
  const dryRun = args.includes("--dry-run")
  const projectSlug = flag("project-slug") ?? keyFor(brand)

  let admin: SupabaseClient | null = null
  let workspace: { id: string; slug: string } | null = null
  let workspaceId = flag("workspace-id")
  const workspaceSlug = flag("workspace-slug")
  if (!dryRun) {
    await loadLocalEnv()
    if (!workspaceId && !workspaceSlug) {
      throw new Error("--workspace-id or --workspace-slug is required (or pass --dry-run)")
    }
    admin = makeAdminClient()
    const { data, error } = await admin
      .from("workspaces")
      .select("id, slug")
      .eq(workspaceId ? "id" : "slug", workspaceId ?? workspaceSlug!)
      .maybeSingle()
    if (error || !data) throw new Error(`workspace ${workspaceId ?? workspaceSlug} not found`)
    workspace = data as { id: string; slug: string }
    workspaceId = workspace.id
  }
  // The default project (slug = workspace slug) lives at /p/<workspace>; named
  // projects at /p/<workspace>/<project>.
  const wsSlug = workspace?.slug ?? "<workspace>"
  const portalBase = projectSlug === wsSlug ? `/p/${wsSlug}` : `/p/${wsSlug}/${projectSlug}`

  const docs = await loadSite(site, portalBase)
  const guides = docs.filter((doc) => doc.kind === "guide")
  const references = docs.filter((doc) => doc.kind === "reference")
  console.log(`${guides.length} guides, ${references.length} API reference pages`)

  if (dryRun || !admin || !workspace || !workspaceId) {
    const out = flag("out")
    if (out) {
      for (const doc of docs) {
        const dir = path.join(out, doc.kind, ...doc.route.map((part) => keyFor(part)))
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, `${doc.slug}.md`), `# ${doc.title}\n\n${doc.content}`)
      }
      console.log(`Wrote converted Markdown to ${out}`)
    }
    return
  }

  const prefix = keyFor(brand)

  // Folder tree.
  const guidesRoot = await ensureFolder(admin, workspaceId, {
    name: `${prefix}-docs`,
    displayName: `${brand} Docs`,
    parentId: null,
    sortOrder: 0,
  })
  const referenceRoot = await ensureFolder(admin, workspaceId, {
    name: `${prefix}-api-reference`,
    displayName: `${brand} API Reference`,
    parentId: null,
    sortOrder: 1,
  })
  const folderIds = new Map<string, string>()
  const childCount = new Map<string, number>()
  async function folderFor(doc: ConvertedDoc): Promise<string> {
    let parentId = doc.kind === "guide" ? guidesRoot : referenceRoot
    let key: string = doc.kind
    for (const label of doc.route) {
      key = `${key}/${keyFor(label)}`
      const known = folderIds.get(key)
      if (known) {
        parentId = known
        continue
      }
      const order = childCount.get(parentId) ?? 0
      childCount.set(parentId, order + 1)
      parentId = await ensureFolder(admin!, workspaceId!, {
        name: `${prefix}-${key.replace(/\//g, "--")}`,
        displayName: label,
        parentId,
        sortOrder: order,
      })
      folderIds.set(key, parentId)
    }
    return parentId
  }

  // Documents.
  const changed: Array<{ id: string; content: string; title: string }> = []
  let created = 0
  let updated = 0
  for (const doc of docs) {
    const folderId = await folderFor(doc)
    const { data: existing, error } = await admin
      .from("documents")
      .select("id, title, content, folder_id, deleted_at")
      .eq("workspace_id", workspaceId)
      .eq("public_slug", doc.slug)
      .maybeSingle()
    if (error) throw new Error(`document lookup ${doc.slug}: ${error.message}`)
    const row = {
      workspace_id: workspaceId,
      title: doc.title,
      content: doc.content,
      document_type: "page",
      public_slug: doc.slug,
      folder_id: folderId,
      sort_order: doc.order,
      source: "docs",
      author: brand,
      status: "Published",
      source_metadata: { synced_by: "import-llms-docs", source_url: doc.url },
      deleted_at: null,
      updated_at: new Date().toISOString(),
    }
    let id: string
    if (existing) {
      const { error: updateError } = await admin.from("documents").update(row).eq("id", existing.id)
      if (updateError) throw new Error(`document update ${doc.slug}: ${updateError.message}`)
      id = existing.id as string
      updated += 1
      if (existing.content === doc.content && existing.title === doc.title && !existing.deleted_at) continue
    } else {
      const { data: inserted, error: insertError } = await admin
        .from("documents")
        .insert(row)
        .select("id")
        .single()
      if (insertError || !inserted) throw new Error(`document create ${doc.slug}: ${insertError?.message}`)
      id = inserted.id as string
      created += 1
    }
    changed.push({ id, content: doc.content, title: doc.title })
  }
  console.log(`Documents: ${created} created, ${updated} updated`)

  // Draft portal project: guides on Home (sections promoted), reference as a page.
  const scope = [{ id: guidesRoot, promote: true }]
  const spec = {
    schemaVersion: 1,
    theme: {
      brandName: `${brand} Docs`,
      tagline: `Guides and API reference for ${brand}.`,
      logoUrl: "",
      accentColor: "#2f5520",
      icon: "📚",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
      assistant: { enabled: true, placement: "corner", label: "Ask AI" },
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: `Search ${brand} docs…` },
    },
    sidebarEnabled: true,
    pages: [
      {
        id: "page-api-reference",
        title: "API Reference",
        slug: "api-reference",
        scope: [referenceRoot],
        presentation: "api_reference",
      },
    ],
    body: [
      {
        id: "hero",
        type: "hero",
        placement: "full",
        heading: "Documentation",
        subtitle: `Guides and API reference for integrating with ${brand}.`,
      },
    ],
  }
  const { data: rows, error: projectError } = await admin
    .from("workspace_experiences")
    .select("id, status, version")
    .eq("workspace_id", workspaceId)
    .eq("kind", "kb")
    .eq("audience", "public")
    .eq("slug", projectSlug)
    .order("version", { ascending: false })
  if (projectError) throw new Error(`project lookup: ${projectError.message}`)
  const draft = rows?.find((row) => row.status === "draft")
  if (draft) {
    const { error } = await admin
      .from("workspace_experiences")
      .update({ scope, spec, updated_at: new Date().toISOString() })
      .eq("id", draft.id)
    if (error) throw new Error(`project draft update: ${error.message}`)
  } else {
    const version = Math.max(0, ...(rows ?? []).map((row) => Number(row.version))) + 1
    const { error } = await admin.from("workspace_experiences").insert({
      workspace_id: workspaceId,
      kind: "kb",
      audience: "public",
      name: `${brand} Docs`,
      slug: projectSlug,
      status: "draft",
      version,
      scope,
      spec,
      visibility: "public",
    })
    if (error) throw new Error(`project draft create: ${error.message}`)
  }
  console.log(
    `Draft project "${brand} Docs" (slug ${projectSlug}) ready in workspace ${workspace.slug}. ` +
      "Open the portal builder to review and publish it.",
  )

  if (!args.includes("--skip-index")) {
    // Index changed docs plus any imported doc still missing an embedding, so a
    // rerun resumes an index that an earlier run could not finish.
    const { data: unindexed, error } = await admin
      .from("documents")
      .select("id, title, content")
      .eq("workspace_id", workspaceId)
      .in("public_slug", docs.map((doc) => doc.slug))
      .is("embedding", null)
    if (error) throw new Error(`index lookup: ${error.message}`)
    const queue = new Map(changed.map((doc) => [doc.id, doc]))
    for (const doc of (unindexed ?? []) as Array<{ id: string; title: string; content: string }>) {
      queue.set(doc.id, doc)
    }
    await indexDocuments(admin, [...queue.values()])
  }
}

async function indexDocuments(
  admin: SupabaseClient,
  docs: Array<{ id: string; title: string; content: string }>,
): Promise<void> {
  const { ingestDocument, textToProseMirrorDoc } = await import("../src/rag/ingest")
  const { generateEmbedding } = await import("../src/lib/embeddings")
  for (const [i, doc] of docs.entries()) {
    console.log(`Indexing ${i + 1}/${docs.length}: ${doc.title}`)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ingestDocument(doc.id, textToProseMirrorDoc(doc.content), { supabase: admin })
        const embedding = await generateEmbedding(doc.content, "RETRIEVAL_DOCUMENT")
        const { error } = await admin.from("documents").update({ embedding }).eq("id", doc.id)
        if (error) throw new Error(`embedding update ${doc.title}: ${error.message}`)
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Embedding providers rate-limit per minute; wait out the window.
        if (attempt >= 6 || !/quota|rate|429|exhausted/i.test(message)) throw err
        console.log(`  rate limited; waiting 65s (attempt ${attempt})`)
        await new Promise((resolve) => setTimeout(resolve, 65_000))
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

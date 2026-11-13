#!/usr/bin/env node
// =============================================================================
// import-docs.mjs — sync Breezify's canonical product docs into a workspace.
//
// Dogfood pipeline for the public KB portal: reads the MDX docs under
// docs/product/**, converts each to portal-renderable Markdown, and
// upserts one or more `documents` rows per file with document_type='page' and
// stable human-readable `public_slug` values. Portal-specific mirror rows share
// the same canonical file so separate docs/help URLs cannot drift. The tree is
// mapped beneath one "Breezify Docs" KB folder (kind='user',
// visibility='workspace'). Existing portal category folders are reused by their
// stable internal names, so their ids, public scopes, and document URLs survive
// consolidation. Internal engineering docs live elsewhere under docs/** and are
// intentionally not imported into the public knowledge base.
//
// This is a one-shot CLI run BY A HUMAN against a real database — it is NOT part
// of CI or the Next build. It uses the service-role admin client, so it needs
// NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in the environment (the
// same vars apps/web/app already reads; load them however you normally do, e.g.
// `set -a; source apps/web/app/.env.local; set +a`).
//
// Idempotent: documents upsert on (workspace_id, public_slug); folders resolve on
// (workspace_id, kind, name). Re-running updates titles/content/folder in place
// rather than duplicating. This script never deletes documents or folders.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node apps/web/app/scripts/import-docs.mjs --dry-run
//       Parse + convert every doc and print what WOULD be imported. No DB access
//       and no credentials required. Use this to sanity-check the conversion.
//
//   node apps/web/app/scripts/import-docs.mjs --workspace "Docs"
//       Create-or-find a workspace named "Docs" (public KB enabled) and import
//       into it. Prints the workspace slug/id and a created/updated summary.
//
//   node apps/web/app/scripts/import-docs.mjs --workspace-id <uuid>
//       Import into an existing workspace by id (does not touch its settings).
//
//   node apps/web/app/scripts/import-docs.mjs --help
//
// SEED A BREEZIFY "Docs" WORKSPACE (the dogfood target):
//   set -a; source apps/web/app/.env.local; set +a
//   node apps/web/app/scripts/import-docs.mjs --workspace "Docs"
//   # then visit /p/docs (the script prints the exact slug).
//
// ---------------------------------------------------------------------------
// CONVERSION LIMITATIONS (pragmatic, lossy by design)
// ---------------------------------------------------------------------------
//   - MDX `import`/`export` statements are stripped.
//   - JSX components are unwrapped: structural tags (<div>, <svg>, self-closing
//     components) are dropped; inline text inside <a>/<strong>/<span>/<code> is
//     kept as plain text. We do NOT execute or render any component.
//   - Docusaurus `_`-prefixed partials are skipped (they are not standalone
//     pages; they get <import>ed into other docs).
//   - Internal `/docs/...` links are preserved as authored.
//   - Markdown is stored verbatim and rendered by renderPublicHtml at read time
//     (so tables, code fences, and headings all survive). Output that "looks
//     like HTML" is avoided so renderPublicHtml treats it as Markdown.
// =============================================================================

import { readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../..")
const DOCS_ROOT = path.join(REPO_ROOT, "docs/product")

const FOLDER_VISIBILITY = "workspace"
const DOC_TYPE = "page"
const DEFAULT_WORKSPACE_NAME = "Docs"
const DOCS_FOLDER_NAME = "breezify-docs"
const DOCS_FOLDER_DISPLAY_NAME = "Breezify Docs"

// These names already exist in the Breezify workspace and are referenced by the
// published docs/help portal scopes. Reusing and reparenting them preserves the
// stable folder ids while removing the category sprawl from the workspace root.
const FOLDER_ALIASES = {
  "product-overview": {
    key: "product-overview",
    name: "website-docs-product-overview",
    displayName: "Product Overview",
  },
  "getting-started": {
    key: "getting-started",
    name: "website-docs-getting-started",
    displayName: "Getting Started",
  },
  integrations: {
    key: "integrations",
    name: "website-docs-integrations",
    displayName: "Integrations",
  },
  "developer-docs": {
    key: "developer-docs",
    name: "Developer Docs",
    displayName: "Developer Docs",
  },
  developer: {
    key: "developer",
    name: "website-help-api-and-developer-tools",
    displayName: "API and Developer Tools",
  },
  "help-center": {
    key: "help-center",
    name: "Help Center",
    displayName: "Help Center",
  },
  "help-center/setup": {
    key: "help-center/setup",
    name: "setup",
    displayName: "Setup",
  },
  "help-center/account-and-billing": {
    key: "help-center/account-and-billing",
    name: "website-help-account-and-billing",
    displayName: "Account and Billing",
  },
  "help-center/capturing-knowledge": {
    key: "help-center/capturing-knowledge",
    name: "website-help-capturing-knowledge",
    displayName: "Capturing Knowledge",
  },
  "help-center/search-and-retrieval": {
    key: "help-center/search-and-retrieval",
    name: "website-help-search-and-retrieval",
    displayName: "Search and Retrieval",
  },
  "help-center/security-and-administration": {
    key: "help-center/security-and-administration",
    name: "website-help-security-and-administration",
    displayName: "Security and Administration",
  },
  "developer/mcp": {
    key: "developer/mcp",
    name: "mcp",
    displayName: "MCP",
  },
}

const CANONICAL_ROOT_FOLDER_KEYS = [
  "product-overview",
  "getting-started",
  "integrations",
  "developer-docs",
  "developer",
  "help-center",
]

// Some public docs/help URLs intentionally point at separate rows because each
// portal has its own folder scope. They still share one canonical GitHub file.
// Syncing these mirrors keeps every existing URL and folder placement while
// eliminating divergent content sources.
const DOC_MIRRORS = {
  "developer/api/authentication.mdx": [
    {
      slug: "docs-api-authentication",
      title: "API Authentication",
      folderKeys: ["developer"],
    },
  ],
  "developer/api/overview.mdx": [
    {
      slug: "help-public-rest-api-v1",
      title: "Public REST API (v1)",
      folderKeys: ["developer"],
    },
  ],
  "developer/mcp/clients.mdx": [
    {
      slug: "docs-mcp-server-setup-and-configuration",
      title: "MCP Server Setup and Configuration",
      folderKeys: ["getting-started"],
    },
    {
      slug: "docs-connecting-ai-tools-via-mcp",
      title: "Connecting AI Tools via MCP",
      folderKeys: ["integrations"],
    },
    {
      slug: "help-using-breezify-with-claude-mcp",
      title: "Using Breezify with Claude (MCP)",
      folderKeys: ["integrations"],
    },
  ],
  "developer/mcp/overview.mdx": [
    {
      slug: "docs-mcp-transport-comparison-hosted-vs-local",
      title: "MCP Transport Comparison: Hosted vs. Local",
      folderKeys: ["product-overview"],
    },
  ],
  "developer/mcp/tools.mdx": [
    {
      slug: "docs-mcp-tools-reference",
      title: "MCP Tools Reference",
      folderKeys: ["developer", "developer/mcp"],
    },
  ],
  "setup/github.mdx": [
    {
      slug: "docs-github-integration",
      title: "GitHub Integration",
      folderKeys: ["integrations"],
    },
  ],
  "setup/linear.mdx": [
    {
      slug: "docs-linear-integration",
      title: "Linear Integration",
      folderKeys: ["integrations"],
    },
  ],
  "setup/overview.mdx": [
    {
      slug: "docs-ingestion-sources-overview",
      title: "Ingestion Sources Overview",
      folderKeys: ["integrations"],
    },
  ],
  "setup/slack.mdx": [
    {
      slug: "docs-slack-integration",
      title: "Slack Integration",
      folderKeys: ["integrations"],
    },
  ],
  "intro.mdx": [
    {
      slug: "help-what-is-breezify",
      title: "What is Breezify?",
      folderKeys: ["help-center"],
    },
  ],
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
/** @returns {{ help: boolean, dryRun: boolean, workspaceName: string | null, workspaceId: string | null }} */
function parseArgs(argv) {
  const args = { help: false, dryRun: false, workspaceName: null, workspaceId: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--dry-run" || arg === "--dry") args.dryRun = true
    else if (arg === "--workspace") args.workspaceName = argv[++i] ?? null
    else if (arg === "--workspace-id") args.workspaceId = argv[++i] ?? null
    else if (arg.startsWith("--workspace=")) args.workspaceName = arg.slice("--workspace=".length)
    else if (arg.startsWith("--workspace-id=")) args.workspaceId = arg.slice("--workspace-id=".length)
  }
  return args
}

const HELP = `import-docs.mjs — seed a Breezify workspace from the bundled docs tree

Usage:
  node apps/web/app/scripts/import-docs.mjs --dry-run
  node apps/web/app/scripts/import-docs.mjs --workspace "Docs"
  node apps/web/app/scripts/import-docs.mjs --workspace-id <uuid>

Options:
  --dry-run            Parse + convert + print; no DB access, no credentials.
  --workspace <name>   Create-or-find a public KB workspace by name, then import.
  --workspace-id <id>  Import into an existing workspace id (settings untouched).
  -h, --help           Show this help.

Requires (unless --dry-run): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.`

// ---------------------------------------------------------------------------
// frontmatter (tiny YAML — only flat scalar key: value pairs are supported)
// ---------------------------------------------------------------------------
/**
 * @param {string} raw
 * @returns {{ data: Record<string, string>, body: string }}
 */
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let value = kv[2].trim()
    // strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[kv[1]] = value
  }
  return { data, body: raw.slice(match[0].length) }
}

// ---------------------------------------------------------------------------
// MDX -> Markdown (lossy, see header)
// ---------------------------------------------------------------------------
/**
 * Strip JSX/HTML tags from a single line of prose while protecting inline code
 * spans (backtick-delimited) — so a placeholder like `q=<query>` inside code is
 * never mistaken for a tag. Operates only on the text BETWEEN backtick spans.
 * @param {string} line
 * @returns {string}
 */
function stripJsxOutsideCode(line) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(/<\/?[A-Za-z][^>]*?>/g, ""),
    )
    .join("")
}

/**
 * @param {string} body
 * @returns {string}
 */
function mdxToMarkdown(body) {
  // First pass: drop multi-line <svg>…</svg> blocks (icons, no readable text)
  // before line-splitting; they never appear inside a code fence in our docs.
  const noSvg = body.replace(/<svg[\s\S]*?<\/svg>/gi, "")

  const lines = noSvg.split(/\r?\n/)
  const out = []
  let inFence = false
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line)
    if (fence) inFence = !inFence
    // Inside a fenced code block, preserve the line verbatim — never strip
    // tags (code may legitimately contain `<placeholder>` syntax).
    if (inFence || fence) {
      out.push(line)
      continue
    }
    // Drop MDX import/export statements (only outside code fences).
    if (/^\s*(import|export)\s/.test(line)) continue
    out.push(stripJsxOutsideCode(line))
  }
  let text = out.join("\n")

  // Drop the leading H1 — the portal renders the document title as the page
  // heading, so a duplicated `# Title` at the top is noise.
  text = text.replace(/^\s*#\s+.+?(\r?\n)/, "")

  // Collapse 3+ blank lines to a single blank line.
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim() + "\n"
}

// ---------------------------------------------------------------------------
// path -> slug / folder helpers
// ---------------------------------------------------------------------------
/** `developer/api/search.mdx` -> `developer-api-search` */
function slugFromRelPath(relPath) {
  return relPath
    .replace(/\.(mdx|md)$/i, "")
    .split(path.sep)
    .map((seg) => seg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
}

/** Directory segments of a file, e.g. `developer/api/search.mdx` -> ["developer","api"]. */
function folderSegments(relPath) {
  const dir = path.dirname(relPath)
  if (dir === "." || dir === "") return []
  return dir.split(path.sep).filter(Boolean)
}

function titleCase(segment) {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function generatedFolderSpec(key, segment) {
  return {
    key,
    name: `breezify-docs-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    displayName: segment.toLowerCase() === "api" ? "API" : titleCase(segment),
  }
}

function generatedFolderSpecs(prefix, segments) {
  const specs = []
  let key = prefix
  for (const segment of segments) {
    key = `${key}/${segment}`
    specs.push(generatedFolderSpec(key, segment))
  }
  return specs
}

/**
 * Map repository paths onto the stable live portal taxonomy.
 *
 * Root product pages belong to Product Overview. Setup guides remain under the
 * Help Center's Setup category because that folder is part of the published
 * help project. Developer docs live under API and Developer Tools. The mapping
 * keeps a single GitHub tree without invalidating either public portal's scope.
 */
function folderRouteForDoc(folderSegs) {
  if (folderSegs.length === 0) return [FOLDER_ALIASES["product-overview"]]

  const [top, ...rest] = folderSegs
  if (top === "getting-started") {
    return [
      FOLDER_ALIASES["getting-started"],
      ...generatedFolderSpecs("getting-started", rest),
    ]
  }
  if (top === "product-overview") {
    return [
      FOLDER_ALIASES["product-overview"],
      ...generatedFolderSpecs("product-overview", rest),
    ]
  }
  if (top === "integrations") {
    return [
      FOLDER_ALIASES.integrations,
      ...generatedFolderSpecs("integrations", rest),
    ]
  }
  if (top === "setup") {
    return [
      FOLDER_ALIASES["help-center"],
      FOLDER_ALIASES["help-center/setup"],
      ...generatedFolderSpecs("help-center/setup", rest),
    ]
  }
  if (top === "developer") {
    const [section, ...tail] = rest
    if (!section) return [FOLDER_ALIASES.developer]
    if (section === "mcp") {
      return [
        FOLDER_ALIASES.developer,
        FOLDER_ALIASES["developer/mcp"],
        ...generatedFolderSpecs("developer/mcp", tail),
      ]
    }
    return [
      FOLDER_ALIASES.developer,
      generatedFolderSpec(`developer/${section}`, section),
      ...generatedFolderSpecs(`developer/${section}`, tail),
    ]
  }
  if (top === "help-center") {
    const [section, ...tail] = rest
    if (!section) return [FOLDER_ALIASES["help-center"]]
    const sectionKey = `help-center/${section}`
    const sectionSpec = FOLDER_ALIASES[sectionKey] ?? generatedFolderSpec(sectionKey, section)
    return [
      FOLDER_ALIASES["help-center"],
      sectionSpec,
      ...generatedFolderSpecs(sectionKey, tail),
    ]
  }

  throw new Error(
    `Unsupported product-doc directory "${top}". Add an explicit folder route before importing it.`,
  )
}

// ---------------------------------------------------------------------------
// fs walk
// ---------------------------------------------------------------------------
/** @returns {Promise<string[]>} absolute paths of importable doc files */
async function collectDocFiles(root) {
  /** @type {string[]} */
  const files = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(mdx|md)$/i.test(entry.name)) continue
      // Skip Docusaurus partials (`_foo.mdx`) — not standalone pages.
      if (entry.name.startsWith("_")) continue
      files.push(full)
    }
  }
  await walk(root)
  files.sort()
  return files
}

/**
 * @typedef {Object} ParsedDoc
 * @property {string} relPath
 * @property {string} slug
 * @property {string} title
 * @property {number | null} sidebarPosition
 * @property {string[]} folderSegs
 * @property {Array<{ key: string, name: string, displayName: string }>} folderRoute
 * @property {string} markdown
 */

/** @returns {Promise<ParsedDoc[]>} */
async function parseAll(root) {
  const files = await collectDocFiles(root)
  /** @type {ParsedDoc[]} */
  const docs = []
  for (const file of files) {
    const relPath = path.relative(root, file)
    const raw = await readFile(file, "utf8")
    const { data, body } = parseFrontmatter(raw)
    // `slug` belongs to the retired Docusaurus router and may be values such as
    // `/` or `/setup`. Only the Breezify-specific override is safe to reuse here.
    const slug = (data.public_slug || slugFromRelPath(relPath)).trim()
    const fallbackTitle = titleCase(path.basename(relPath).replace(/\.(mdx|md)$/i, ""))
    const title = (data.title || data.sidebar_label || fallbackTitle).trim()
    const posRaw = data.sidebar_position
    const sidebarPosition = posRaw != null && posRaw !== "" && !Number.isNaN(Number(posRaw))
      ? Number(posRaw)
      : null
    const normalizedRelPath = relPath.split(path.sep).join("/")
    const parsed = {
      relPath,
      slug,
      title,
      sidebarPosition,
      folderSegs: folderSegments(relPath),
      folderRoute: folderRouteForDoc(folderSegments(relPath)),
      markdown: mdxToMarkdown(body),
    }
    docs.push(parsed)
    for (const mirror of DOC_MIRRORS[normalizedRelPath] ?? []) {
      docs.push({
        ...parsed,
        slug: mirror.slug,
        title: mirror.title,
        folderRoute: mirror.folderKeys.map((key) => {
          const spec = FOLDER_ALIASES[key]
          if (!spec) throw new Error(`Unknown mirror folder alias: ${key}`)
          return spec
        }),
      })
    }
  }
  const seenSlugs = new Map()
  for (const doc of docs) {
    const previous = seenSlugs.get(doc.slug)
    if (previous) {
      throw new Error(`Duplicate public slug "${doc.slug}" in ${previous} and ${doc.relPath}`)
    }
    seenSlugs.set(doc.slug, doc.relPath)
  }
  return docs
}

// ---------------------------------------------------------------------------
// DB: workspace + folders + documents
// ---------------------------------------------------------------------------
function makeAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      "Missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (or pass --dry-run).",
    )
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function workspaceSlugFromName(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return base || "docs"
}

/** @returns {Promise<{ id: string, slug: string }>} */
async function findOrCreateWorkspace(admin, name) {
  const wsSlug = workspaceSlugFromName(name)
  // Prefer matching by the deterministic slug; fall back to name.
  const bySlug = await admin
    .from("workspaces")
    .select("id, slug")
    .eq("slug", wsSlug)
    .maybeSingle()
  if (bySlug.error) throw new Error(`workspace lookup failed: ${bySlug.error.message}`)
  if (bySlug.data) return { id: bySlug.data.id, slug: bySlug.data.slug }

  const byName = await admin
    .from("workspaces")
    .select("id, slug")
    .eq("name", name)
    .limit(1)
    .maybeSingle()
  if (byName.error) throw new Error(`workspace lookup failed: ${byName.error.message}`)
  if (byName.data) return { id: byName.data.id, slug: byName.data.slug }

  const created = await admin
    .from("workspaces")
    .insert({ name, slug: wsSlug, settings: { kb_public: true } })
    .select("id, slug")
    .single()
  if (created.error) throw new Error(`workspace create failed: ${created.error.message}`)
  return { id: created.data.id, slug: created.data.slug }
}

/** @returns {Promise<{ id: string, slug: string } | null>} */
async function loadWorkspaceById(admin, id) {
  const res = await admin.from("workspaces").select("id, slug").eq("id", id).maybeSingle()
  if (res.error) throw new Error(`workspace lookup failed: ${res.error.message}`)
  return res.data ? { id: res.data.id, slug: res.data.slug } : null
}

/**
 * Find-or-create a single user folder by its stable workspace-scoped internal
 * name, then reconcile its display name and parent.
 * @returns {Promise<string>} folder id
 */
async function findOrCreateFolder(admin, workspaceId, name, displayName, parentId) {
  const existing = await admin
    .from("folders")
    .select("id, display_name, parent_folder_id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "user")
    .eq("name", name)
    .maybeSingle()
  if (existing.error) throw new Error(`folder lookup failed (${name}): ${existing.error.message}`)
  if (existing.data) {
    if (
      existing.data.display_name !== displayName ||
      existing.data.parent_folder_id !== parentId
    ) {
      const updated = await admin
        .from("folders")
        .update({ display_name: displayName, parent_folder_id: parentId })
        .eq("id", existing.data.id)
        .eq("workspace_id", workspaceId)
      if (updated.error) {
        throw new Error(`folder update failed (${name}): ${updated.error.message}`)
      }
    }
    return existing.data.id
  }

  const created = await admin
    .from("folders")
    .insert({
      workspace_id: workspaceId,
      kind: "user",
      name,
      display_name: displayName,
      visibility: FOLDER_VISIBILITY,
      parent_folder_id: parentId,
    })
    .select("id")
    .single()
  if (created.error) throw new Error(`folder create failed (${name}): ${created.error.message}`)
  return created.data.id
}

/**
 * Resolve a canonical folder route beneath Breezify Docs, returning the leaf id.
 * Stable aliases reuse existing portal folder ids; generated descendants use a
 * Breezify-specific internal name so unrelated workspace folders never collide.
 * @returns {Promise<string>}
 */
async function ensureFolderRoute(admin, workspaceId, route, cache, rootFolderId) {
  let parentId = rootFolderId
  for (const spec of route) {
    if (cache.has(spec.key)) {
      parentId = cache.get(spec.key)
      continue
    }
    const id = await findOrCreateFolder(
      admin,
      workspaceId,
      spec.name,
      spec.displayName,
      parentId,
    )
    cache.set(spec.key, id)
    parentId = id
  }
  return parentId
}

async function ensureCanonicalRootFolders(
  admin,
  workspaceId,
  cache,
  rootFolderId,
) {
  for (const key of CANONICAL_ROOT_FOLDER_KEYS) {
    await ensureFolderRoute(
      admin,
      workspaceId,
      [FOLDER_ALIASES[key]],
      cache,
      rootFolderId,
    )
  }
}

/**
 * Upsert one document by (workspace_id, public_slug).
 * @returns {Promise<"created" | "updated" | "restored">}
 */
async function upsertDocument(admin, workspaceId, doc, folderId) {
  const existing = await admin
    .from("documents")
    .select("id, source_metadata, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("public_slug", doc.slug)
    .maybeSingle()
  if (existing.error) throw new Error(`doc lookup failed (${doc.slug}): ${existing.error.message}`)

  const existingMetadata =
    existing.data?.source_metadata &&
    typeof existing.data.source_metadata === "object" &&
    !Array.isArray(existing.data.source_metadata)
      ? existing.data.source_metadata
      : {}
  const canonicalRepoPath = path.posix.join(
    "docs/product",
    doc.relPath.split(path.sep).join("/"),
  )
  const row = {
    workspace_id: workspaceId,
    title: doc.title,
    content: doc.markdown,
    document_type: DOC_TYPE,
    public_slug: doc.slug,
    folder_id: folderId,
    source: "docs",
    source_metadata: {
      ...existingMetadata,
      canonical_repo_path: canonicalRepoPath,
      synced_by: "import-docs",
    },
    // A canonical file present in GitHub is active by definition. If an older
    // import of the same stable slug was moved to trash, restore that row so its
    // id and public URL remain intact instead of inserting a duplicate.
    deleted_at: null,
    updated_at: new Date().toISOString(),
  }

  if (existing.data) {
    const upd = await admin.from("documents").update(row).eq("id", existing.data.id)
    if (upd.error) throw new Error(`doc update failed (${doc.slug}): ${upd.error.message}`)
    return existing.data.deleted_at ? "restored" : "updated"
  }
  const ins = await admin.from("documents").insert(row)
  if (ins.error) throw new Error(`doc insert failed (${doc.slug}): ${ins.error.message}`)
  return "created"
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  if (!existsSync(DOCS_ROOT)) {
    console.error(`[import-docs] docs root not found: ${DOCS_ROOT}`)
    process.exitCode = 1
    return
  }

  const docs = await parseAll(DOCS_ROOT)
  const sourceFileCount = new Set(docs.map((doc) => doc.relPath)).size
  console.log(
    `[import-docs] parsed ${sourceFileCount} file(s) into ${docs.length} live target(s) from ${DOCS_ROOT}`,
  )

  if (args.dryRun) {
    console.log("[import-docs] --dry-run: no DB writes. Would import:")
    for (const doc of docs) {
      const folder = [
        DOCS_FOLDER_DISPLAY_NAME,
        ...doc.folderRoute.map((spec) => spec.displayName),
      ].join("/") + "/"
      console.log(
        `  ${folder}${doc.slug}  ←  ${doc.relPath}  (${doc.title}, ${doc.markdown.length} chars)`,
      )
    }
    return
  }

  const admin = makeAdminClient()

  let workspace
  if (args.workspaceId) {
    workspace = await loadWorkspaceById(admin, args.workspaceId)
    if (!workspace) {
      console.error(`[import-docs] workspace id not found: ${args.workspaceId}`)
      process.exitCode = 1
      return
    }
  } else {
    workspace = await findOrCreateWorkspace(admin, args.workspaceName || DEFAULT_WORKSPACE_NAME)
  }
  console.log(`[import-docs] target workspace: ${workspace.slug} (${workspace.id})`)

  const folderCache = new Map()
  const docsRootFolderId = await findOrCreateFolder(
    admin,
    workspace.id,
    DOCS_FOLDER_NAME,
    DOCS_FOLDER_DISPLAY_NAME,
    null,
  )
  await ensureCanonicalRootFolders(
    admin,
    workspace.id,
    folderCache,
    docsRootFolderId,
  )
  let created = 0
  let updated = 0
  let restored = 0
  for (const doc of docs) {
    const folderId = await ensureFolderRoute(
      admin,
      workspace.id,
      doc.folderRoute,
      folderCache,
      docsRootFolderId,
    )
    const result = await upsertDocument(admin, workspace.id, doc, folderId)
    if (result === "created") created += 1
    else if (result === "restored") restored += 1
    else updated += 1
    const marker = result === "created" ? "+" : result === "restored" ? "↻" : "~"
    console.log(`  ${marker} ${doc.slug}`)
  }

  console.log(
    `[import-docs] done: ${created} created, ${updated} updated, ${restored} restored, ${folderCache.size} folder(s). Visit /p/${workspace.slug}`,
  )
}

main().catch((err) => {
  console.error("[import-docs] failed:", err instanceof Error ? err.message : err)
  process.exitCode = 1
})

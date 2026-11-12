#!/usr/bin/env -S npx tsx

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { generateEmbedding } from "../src/lib/embeddings"
import { buildBreadDocsHomeTree } from "./bread-docs-home"
import { ingestDocument, textToProseMirrorDoc } from "../src/rag/ingest"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..")
const DOCS_ROOT = path.join(REPO_ROOT, "docs/kb-docs")
const CANONICAL_PREFIX = "docs/kb-docs/"
const LEGACY_PREFIXES = ["docs/bread-docs/", "docs/product/"]
const PROJECT_SLUG = "docs"

async function loadLocalEnv(): Promise<void> {
  const envPath = path.join(REPO_ROOT, "apps/web/app/.env.local")
  const raw = await readFile(envPath, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

interface SectionConfig {
  displayName: string
  icon: string
  sortOrder: number
  preferredName: string
  aliases?: string[]
}

const SECTIONS: Record<string, SectionConfig> = {
  "getting-started": {
    displayName: "Getting Started",
    icon: "graduation-cap",
    sortOrder: 0,
    preferredName: "website-docs-getting-started",
  },
  "using-bread": {
    displayName: "Using Bread",
    icon: "book-open",
    sortOrder: 1,
    preferredName: "bread-docs-using-bread",
  },
  integrations: {
    displayName: "Integrations",
    icon: "puzzle",
    sortOrder: 2,
    preferredName: "website-docs-integrations",
  },
  publishing: {
    displayName: "Publishing",
    icon: "send",
    sortOrder: 3,
    preferredName: "bread-docs-publishing",
  },
  developers: {
    displayName: "Developers & AI",
    icon: "terminal",
    sortOrder: 4,
    preferredName: "website-help-api-and-developer-tools",
  },
  administration: {
    displayName: "Administration",
    icon: "shield-check",
    sortOrder: 5,
    preferredName: "bread-docs-administration",
  },
}

// Nested folders, created after their parent. `api-reference` is the scope of
// the docs project's API Reference page, so its sort orders are chosen to make
// the reference read top-down: the folder itself (Introduction, Authentication)
// sorts ahead of its per-resource children, which the API-reference renderer
// turns into section groups in the same order.
const CHILD_ALIASES: Record<string, SectionConfig> = {
  "developers/api": {
    displayName: "API",
    icon: "file-text",
    sortOrder: 0,
    preferredName: "bread-docs-developer-api",
  },
  "developers/api-reference": {
    displayName: "API Reference",
    icon: "code",
    sortOrder: 1,
    preferredName: "bread-docs-api-reference",
  },
  "developers/mcp": {
    displayName: "MCP",
    icon: "sparkles",
    sortOrder: 2,
    preferredName: "mcp",
  },
  "developers/api-reference/documents": {
    displayName: "Documents",
    icon: "file-text",
    sortOrder: 3,
    preferredName: "bread-docs-api-reference-documents",
  },
  "developers/api-reference/search": {
    displayName: "Search",
    icon: "search",
    sortOrder: 4,
    preferredName: "bread-docs-api-reference-search",
  },
  "developers/api-reference/captures": {
    displayName: "Captures",
    icon: "inbox",
    sortOrder: 5,
    preferredName: "bread-docs-api-reference-captures",
  },
  "developers/api-reference/github-documents": {
    displayName: "GitHub documents",
    icon: "github",
    sortOrder: 6,
    preferredName: "bread-docs-api-reference-github-documents",
  },
}

// The home page's section visuals are served from the app's own `public/`
// directory: a reverse-proxied sub-folder mount would resolve a root-relative
// src against the PROXY host and 404. Required; no fallback.
const HOME_ASSET_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? ""
// GitHub repo ("owner/name") the Bread docs are synced from. Required.
const BREAD_DOCS_REPO = process.env.BREAD_DOCS_REPO ?? ""
const HOME_ASSET_DIR = path.join(SCRIPT_DIR, "../public/portal/docs")

/** Image files actually shipped for the home page, so none is published dead. */
async function homePageAssets(): Promise<Set<string>> {
  try {
    return new Set(await readdir(HOME_ASSET_DIR))
  } catch {
    return new Set()
  }
}

/** Folder whose subtree backs the docs project's API Reference page. */
const API_REFERENCE_FOLDER_KEY = "developers/api-reference"

// The changelog is a section of the docs project rather than a project of its
// own. Its folder is the CHANGELOG PAGE's scope, not the project's: a page
// renders its own scope, and everything the portal addresses (the entries'
// /doc/<slug> URLs, portal search) resolves against the project scope widened
// by every page scope. Keeping it out of the project scope is what keeps a
// release feed off the home grid and out of the docs rail, while the page still
// serves all of it. The sidebar override remains for the folder page's own rail.
const CHANGELOG_FOLDER_KEY = "changelog"
const CHANGELOG_SECTION: SectionConfig = {
  displayName: "Changelog",
  icon: "megaphone",
  sortOrder: 6,
  preferredName: "bread-docs-changelog",
}

const DOC_ORDER = [
  "getting-started/introduction.md",
  "getting-started/quickstart.md",
  "getting-started/core-concepts.md",
  "using-bread/create-and-edit-documents.md",
  "using-bread/organize-your-knowledge-base.md",
  "using-bread/capture-knowledge.md",
  "using-bread/review-librarian-proposals.md",
  "using-bread/search-and-ask-ai.md",
  "integrations/overview.md",
  "integrations/import-existing-content.md",
  "integrations/github.md",
  "integrations/slack.md",
  "integrations/google-drive.md",
  "integrations/linear.md",
  "integrations/granola.md",
  "publishing/create-a-docs-project.md",
  "publishing/customize-and-publish.md",
  "publishing/custom-domains-and-paths.md",
  "developers/mcp/connect-ai-tools.md",
  "developers/mcp/overview.md",
  "developers/mcp/tools.md",
  "developers/api/overview.md",
  "developers/api/authentication.md",
  "developers/api/search.md",
  "developers/api/documents.md",
  "developers/api-reference/rest-api-introduction.md",
  "developers/api-reference/rest-api-authentication.md",
  "developers/api-reference/documents/list-documents.md",
  "developers/api-reference/documents/get-document.md",
  "developers/api-reference/search/semantic-search.md",
  "developers/api-reference/search/grep-search.md",
  "developers/api-reference/captures/list-captures.md",
  "developers/api-reference/captures/create-capture.md",
  "developers/api-reference/github-documents/get-github-document.md",
  "developers/api-reference/github-documents/save-github-draft.md",
  "developers/api-reference/github-documents/publish-github-document.md",
  "administration/workspaces-members-and-roles.md",
  "administration/security-and-data-handling.md",
  "administration/manage-your-subscription.md",
] as const

const NEW_DOC_SLUGS: Record<string, string> = {
  "c166439b-56a8-4169-8bc7-7a173103b56e": "create-and-edit-documents",
  "a94d6e2e-02b2-4618-9e12-225a283ba87b": "organize-your-knowledge-base",
  "f846fcc2-0df8-4233-8dff-ddc7d2ae4420": "review-librarian-proposals",
  "0ab7372e-6136-447a-a5e8-f944697123e3": "create-a-docs-project",
  "2ef74e69-daa4-4ac3-ada4-fad327bb765c": "customize-and-publish",
  "103cf0c4-9706-44c8-a163-30b68b86565c": "custom-domains-and-paths",
}

interface ParsedDoc {
  id: string
  title: string
  content: string
  relPath: string
  canonicalPath: string
  sectionKey: string
  folderRoute: string[]
  sortOrder: number
  /**
   * Changelog entries carry their release date in frontmatter and are stored
   * with it as `updated_at` — the dated feed groups by that column, so stamping
   * "now" on every seed run would collapse the whole history into one month.
   */
  date?: string
}

function parseDoc(raw: string, relPath: string, sortOrder: number): ParsedDoc {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw.replace(/\r\n?/g, "\n"))
  if (!match) throw new Error(`${relPath}: missing frontmatter`)
  const fields = Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const index = line.indexOf(":")
      const key = line.slice(0, index).trim()
      const rawValue = line.slice(index + 1).trim()
      return [key, JSON.parse(rawValue)]
    }),
  ) as Record<string, string>
  const body = raw.replace(/\r\n?/g, "\n").slice(match[0].length).trim()
  const authoredHeading = `# ${fields.title}`
  const content = body === authoredHeading
    ? ""
    : body.startsWith(`${authoredHeading}\n`)
      ? body.slice(authoredHeading.length).trimStart()
      : body
  const sectionKey = relPath.split("/")[0]!
  if (!SECTIONS[sectionKey] && sectionKey !== CHANGELOG_FOLDER_KEY) {
    throw new Error(`${relPath}: unknown section`)
  }
  if (sectionKey === CHANGELOG_FOLDER_KEY && !fields.date) {
    throw new Error(`${relPath}: changelog entries require a "date" field`)
  }
  return {
    id: fields.bread_document_id!,
    title: fields.title!,
    content,
    relPath,
    canonicalPath: `${CANONICAL_PREFIX}${relPath}`,
    sectionKey,
    folderRoute: relPath.split("/").slice(0, -1),
    sortOrder,
    ...(fields.date ? { date: new Date(fields.date).toISOString() } : {}),
  }
}

async function loadDocs(): Promise<ParsedDoc[]> {
  return Promise.all(
    DOC_ORDER.map(async (relPath, index) =>
      parseDoc(await readFile(path.join(DOCS_ROOT, relPath), "utf8"), relPath, index),
    ),
  )
}

/**
 * Changelog entries are discovered rather than listed: the directory is a feed
 * that only grows, and every file is dated in its own frontmatter. Newest first,
 * so the folder's stored order matches the feed's.
 */
async function loadChangelogEntries(): Promise<ParsedDoc[]> {
  const dir = path.join(DOCS_ROOT, CHANGELOG_FOLDER_KEY)
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse()
  const entries = await Promise.all(
    names.map(async (name, index) =>
      parseDoc(
        await readFile(path.join(dir, name), "utf8"),
        `${CHANGELOG_FOLDER_KEY}/${name}`,
        index,
      ),
    ),
  )
  return entries.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
}

function makeAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required")
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function findRootFolder(admin: SupabaseClient, workspaceId: string): Promise<string> {
  const { data: source } = await admin
    .from("github_hosted_docs_sources")
    .select("root_folder_id")
    .eq("workspace_id", workspaceId)
    .eq("repo_full_name", BREAD_DOCS_REPO)
    .maybeSingle()
  if (source?.root_folder_id) return source.root_folder_id as string

  const { data, error } = await admin
    .from("folders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "user")
    .eq("display_name", "Bread Docs")
    .is("parent_folder_id", null)
    .maybeSingle()
  if (error || !data) throw new Error(`Bread Docs root not found: ${error?.message ?? "missing"}`)
  return data.id as string
}

async function ensureFolder(
  admin: SupabaseClient,
  workspaceId: string,
  parentId: string,
  config: SectionConfig,
): Promise<string> {
  const names = [config.preferredName, ...(config.aliases ?? [])]
  let existing: { id: string } | null = null
  for (const name of names) {
    const result = await admin
      .from("folders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "user")
      .eq("name", name)
      .maybeSingle()
    if (result.error) throw new Error(`folder lookup ${name}: ${result.error.message}`)
    if (result.data) { existing = result.data as { id: string }; break }
  }

  const patch = {
    display_name: config.displayName,
    parent_folder_id: parentId,
    visibility: "workspace",
    required_role: null,
    sort_order: config.sortOrder,
    icon: config.icon,
    updated_at: new Date().toISOString(),
  }
  if (existing) {
    const { error } = await admin.from("folders").update(patch).eq("id", existing.id)
    if (error) throw new Error(`folder update ${config.displayName}: ${error.message}`)
    return existing.id
  }

  const { data, error } = await admin
    .from("folders")
    .insert({
      workspace_id: workspaceId,
      kind: "user",
      name: config.preferredName,
      ...patch,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`folder create ${config.displayName}: ${error?.message ?? "missing"}`)
  return data.id as string
}

async function ensureFolderTree(
  admin: SupabaseClient,
  workspaceId: string,
  rootFolderId: string,
): Promise<Map<string, string>> {
  const folders = new Map<string, string>()
  for (const [key, config] of Object.entries(SECTIONS).sort((a, b) => a[1].sortOrder - b[1].sortOrder)) {
    folders.set(key, await ensureFolder(admin, workspaceId, rootFolderId, config))
  }
  for (const [key, config] of Object.entries(CHILD_ALIASES)) {
    const parentKey = key.split("/").slice(0, -1).join("/")
    folders.set(key, await ensureFolder(admin, workspaceId, folders.get(parentKey)!, config))
  }
  folders.set(
    CHANGELOG_FOLDER_KEY,
    await ensureFolder(admin, workspaceId, rootFolderId, CHANGELOG_SECTION),
  )
  return folders
}

async function upsertDocs(
  admin: SupabaseClient,
  workspaceId: string,
  docs: ParsedDoc[],
  folders: Map<string, string>,
): Promise<{
  changed: ParsedDoc[]
  created: number
  updated: number
  /** Published public slug, keyed by path relative to docs/kb-docs. */
  slugs: Map<string, string>
}> {
  const changed: ParsedDoc[] = []
  const slugs = new Map<string, string>()
  let created = 0
  let updated = 0
  const perFolderOrder = new Map<string, number>()

  for (const doc of docs) {
    const folderKey = doc.folderRoute.join("/")
    const folderId = folders.get(folderKey) ?? folders.get(doc.sectionKey)!
    const sortOrder = perFolderOrder.get(folderId) ?? 0
    perFolderOrder.set(folderId, sortOrder + 1)
    const { data: existing, error: lookupError } = await admin
      .from("documents")
      .select("id, title, content, public_slug, folder_id, source_metadata, deleted_at")
      .eq("workspace_id", workspaceId)
      .eq("id", doc.id)
      .maybeSingle()
    if (lookupError) throw new Error(`document lookup ${doc.relPath}: ${lookupError.message}`)

    const metadata = {
      ...((existing?.source_metadata as Record<string, unknown> | null) ?? {}),
      canonical_repo_path: doc.canonicalPath,
      synced_by: "seed-bread-docs",
      github_hosted_sync: true,
    }
    const publicSlug =
      (existing?.public_slug as string | null) ??
      NEW_DOC_SLUGS[doc.id] ??
      path.basename(doc.relPath, ".md")
    slugs.set(doc.relPath, publicSlug)
    const row = {
      workspace_id: workspaceId,
      title: doc.title,
      content: doc.content,
      document_type: "page",
      public_slug: publicSlug,
      folder_id: folderId,
      sort_order: sortOrder,
      source: "docs",
      author: "Bread",
      status: "Published",
      source_metadata: metadata,
      deleted_at: null,
      // Dated entries pin their own timestamp; everything else stamps the run.
      updated_at: doc.date ?? new Date().toISOString(),
    }
    const isChanged =
      !existing ||
      existing.title !== doc.title ||
      existing.content !== doc.content ||
      existing.folder_id !== folderId ||
      existing.deleted_at !== null

    if (existing) {
      const { error } = await admin.from("documents").update(row).eq("id", doc.id).eq("workspace_id", workspaceId)
      if (error) throw new Error(`document update ${doc.relPath}: ${error.message}`)
      updated += 1
    } else {
      const { error } = await admin.from("documents").insert({ id: doc.id, ...row })
      if (error) throw new Error(`document create ${doc.relPath}: ${error.message}`)
      created += 1
    }
    if (isChanged) changed.push(doc)
  }
  return { changed, created, updated, slugs }
}

async function removeStaleDocs(
  admin: SupabaseClient,
  workspaceId: string,
  activeIds: Set<string>,
): Promise<number> {
  const { data, error } = await admin
    .from("documents")
    .select("id, source_metadata")
    .eq("workspace_id", workspaceId)
    .eq("source", "docs")
    .is("deleted_at", null)
  if (error) throw new Error(`stale document lookup: ${error.message}`)
  const staleIds = (data ?? []).flatMap((row) => {
    const metadata = row.source_metadata as Record<string, unknown> | null
    const canonical = typeof metadata?.canonical_repo_path === "string" ? metadata.canonical_repo_path : ""
    return !activeIds.has(row.id as string) &&
      (canonical.startsWith(CANONICAL_PREFIX) ||
        LEGACY_PREFIXES.some((prefix) => canonical.startsWith(prefix)))
      ? [row.id as string]
      : []
  })
  if (staleIds.length === 0) return 0
  const now = new Date().toISOString()
  const { error: deleteError } = await admin
    .from("documents")
    .update({ deleted_at: now, updated_at: now })
    .eq("workspace_id", workspaceId)
    .in("id", staleIds)
  if (deleteError) throw new Error(`stale document cleanup: ${deleteError.message}`)
  return staleIds.length
}

async function setGitHubSourceRoot(admin: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await admin
    .from("github_hosted_docs_sources")
    .update({ paths: ["docs"], updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("repo_full_name", BREAD_DOCS_REPO)
  if (error) throw new Error(`GitHub docs source update: ${error.message}`)
}

/**
 * Publish the docs project. `--skip-changelog-page` publishes it without the
 * Changelog page (a plain landing page scoped to the changelog folder).
 */
async function publishDocsProject(
  admin: SupabaseClient,
  workspaceId: string,
  folders: Map<string, string>,
  docSlugs: Map<string, string>,
  includeChangelogPage: boolean,
): Promise<number> {
  const { data: versions, error } = await admin
    .from("workspace_experiences")
    .select("id, status, version, spec")
    .eq("workspace_id", workspaceId)
    .eq("kind", "kb")
    .eq("audience", "public")
    .eq("slug", PROJECT_SLUG)
    .order("version", { ascending: false })
  if (error) throw new Error(`docs project lookup: ${error.message}`)
  const current = versions?.find((row) => row.status === "published")
  const draft = versions?.find((row) => row.status === "draft")
  if (!current) throw new Error("published docs project not found")

  const currentSpec = current.spec as Record<string, unknown>
  const theme = (currentSpec.theme ?? {}) as Record<string, unknown>
  const footer = currentSpec.footer as Record<string, unknown> | undefined
  const rootSections = Object.entries(SECTIONS).sort((a, b) => a[1].sortOrder - b[1].sortOrder)
  const changelogFolderId = folders.get(CHANGELOG_FOLDER_KEY)!
  // Documentation sections only. The changelog folder belongs to the changelog
  // PAGE (see CHANGELOG_FOLDER_KEY above), so it stays out of the home surface.
  const scope = rootSections.map(([key]) => folders.get(key)!)
  const categoryItems = rootSections.map(([key, config]) => ({
    id: folders.get(key)!,
    title: config.displayName,
    description: {
      "getting-started": "Set up your workspace and learn the core workflow.",
      "using-bread": "Write, organize, capture, review, and find knowledge.",
      integrations: "Connect the tools where your team's context already lives.",
      publishing: "Turn selected knowledge into a polished public docs site.",
      developers: "Connect AI agents and build with the API.",
      administration: "Manage members, permissions, security, and billing.",
    }[key],
    icon: config.icon,
    href: `/p/${PROJECT_SLUG}/folder/${folders.get(key)!}`,
  }))
  const spec = {
    ...currentSpec,
    schemaVersion: 1,
    theme: {
      ...theme,
      brandName: "Bread Docs",
      logoText: "Docs",
      tagline: "Learn how to capture, organize, retrieve, and publish your team's knowledge with Bread.",
      icon: "📚",
      navLinks: [],
      cta: HOME_ASSET_ORIGIN ? { label: "Open Bread", href: HOME_ASSET_ORIGIN } : null,
      assistant: { enabled: true, placement: "header", label: "Ask AI" },
    },
    chrome: { headerMode: "workspace", footerMode: "workspace" },
    sidebarEnabled: true,
    sidebarOverrides: Object.fromEntries(
      [...rootSections, [CHANGELOG_FOLDER_KEY, CHANGELOG_SECTION] as const].map(
        ([key, config]) => [folders.get(key)!, { label: config.displayName, icon: config.icon }],
      ),
    ),
    // The API Reference nav page renders the whole api-reference subtree as one
    // endpoint reference. Rewritten on every run so the page always points at
    // the folder this script seeds — the previously published page was pinned to
    // a single document that later moved. The Changelog page does the same for
    // the changelog folder, as a plain landing page.
    pages: [
      {
        id: "page-api-reference",
        title: "API Reference",
        slug: "api-reference",
        scope: [folders.get(API_REFERENCE_FOLDER_KEY)!],
        presentation: "api_reference",
      },
      ...(includeChangelogPage
        ? [
            {
              id: "page-changelog",
              title: "Changelog",
              slug: "changelog",
              scope: [changelogFolderId],
            },
          ]
        : []),
    ],
    body: [
      {
        id: "bread-docs-hero",
        type: "hero",
        placement: "full",
        eyebrow: "Bread Documentation",
        heading: "Use Bread with confidence",
        subtitle: "Start with the quickstart, then learn how to capture knowledge, connect agents, and publish documentation.",
      },
      { id: "categories", type: "category-grid", placement: "main", items: categoryItems },
    ],
    ...(footer ? { footer } : {}),
  }
  // The renderer prefers a v2 DSL tree over `body`, so the home page IS the
  // tree built here: an illustrated landing page instead of a hero over six
  // section links. `body` above stays as the fallback any build without tree
  // support still renders, and the stale component/pack registries from the old
  // developer-docs tree are dropped.
  ;(spec as Record<string, unknown>).tree = buildBreadDocsHomeTree({
    base: `/p/${PROJECT_SLUG}`,
    assetOrigin: HOME_ASSET_ORIGIN,
    folderIds: folders,
    docSlugs,
    sections: rootSections.map(([key, config]) => ({
      key,
      title: config.displayName,
      icon: config.icon,
    })),
    includeChangelogPage,
    assets: await homePageAssets(),
  })
  delete (spec as Record<string, unknown>).components
  delete (spec as Record<string, unknown>).enabledPacks

  let draftId = draft?.id as string | undefined
  let version = Number(draft?.version ?? 0)
  if (draftId) {
    const { error: updateError } = await admin
      .from("workspace_experiences")
      .update({ name: "Bread Docs", template: "docs", scope, spec, visibility: "public", updated_at: new Date().toISOString() })
      .eq("id", draftId)
    if (updateError) throw new Error(`docs draft update: ${updateError.message}`)
  } else {
    version = Math.max(...(versions ?? []).map((row) => Number(row.version)), 0) + 1
    const { data: inserted, error: insertError } = await admin
      .from("workspace_experiences")
      .insert({
        workspace_id: workspaceId,
        kind: "kb",
        audience: "public",
        name: "Bread Docs",
        slug: PROJECT_SLUG,
        template: "docs",
        status: "draft",
        version,
        scope,
        spec,
        visibility: "public",
      })
      .select("id")
      .single()
    if (insertError || !inserted) throw new Error(`docs draft create: ${insertError?.message ?? "missing"}`)
    draftId = inserted.id as string
  }

  const archivedAt = new Date().toISOString()
  const { error: archiveError } = await admin
    .from("workspace_experiences")
    .update({ status: "archived", updated_at: archivedAt })
    .eq("id", current.id)
  if (archiveError) throw new Error(`docs project archive: ${archiveError.message}`)
  const { error: publishError } = await admin
    .from("workspace_experiences")
    .update({ status: "published", published_at: archivedAt, updated_at: archivedAt })
    .eq("id", draftId)
  if (publishError) throw new Error(`docs project publish: ${publishError.message}`)
  return version
}

async function indexChangedDocs(
  admin: SupabaseClient,
  workspaceId: string,
  docs: ParsedDoc[],
): Promise<void> {
  for (const [index, doc] of docs.entries()) {
    console.log(`Indexing ${index + 1}/${docs.length}: ${doc.title}`)
    const pmDoc = textToProseMirrorDoc(doc.content)
    await ingestDocument(doc.id, pmDoc, { supabase: admin })
    const embedding = await generateEmbedding(doc.content, "RETRIEVAL_DOCUMENT")
    const { error } = await admin
      .from("documents")
      .update({ embedding })
      .eq("workspace_id", workspaceId)
      .eq("id", doc.id)
    if (error) throw new Error(`embedding update ${doc.relPath}: ${error.message}`)
  }
}

async function main(): Promise<void> {
  await loadLocalEnv()
  const dryRun = process.argv.includes("--dry-run")
  const skipIndex = process.argv.includes("--skip-index")
  const includeChangelogPage = !process.argv.includes("--skip-changelog-page")
  const changelog = await loadChangelogEntries()
  const docs = [...(await loadDocs()), ...changelog]
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          docs: docs.length,
          sections: Object.keys(SECTIONS),
          paths: DOC_ORDER,
          changelog: changelog.map((entry) => ({
            date: entry.date,
            title: entry.title,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  const workspaceId = process.env.NEXT_PUBLIC_BREAD_WORKSPACE_ID
  if (!workspaceId) throw new Error("NEXT_PUBLIC_BREAD_WORKSPACE_ID is required")
  const admin = makeAdminClient()
  const rootFolderId = await findRootFolder(admin, workspaceId)
  const folders = await ensureFolderTree(admin, workspaceId, rootFolderId)
  const result = await upsertDocs(admin, workspaceId, docs, folders)
  const removed = await removeStaleDocs(admin, workspaceId, new Set(docs.map((doc) => doc.id)))
  await setGitHubSourceRoot(admin, workspaceId)
  const projectVersion = await publishDocsProject(
    admin,
    workspaceId,
    folders,
    result.slugs,
    includeChangelogPage,
  )
  if (!skipIndex) await indexChangedDocs(admin, workspaceId, result.changed)

  console.log(
    JSON.stringify(
      {
        workspaceId,
        rootFolderId,
        documents: docs.length,
        changelogEntries: changelog.length,
        created: result.created,
        updated: result.updated,
        reindexed: skipIndex ? 0 : result.changed.length,
        removed,
        projectVersion,
        changelogPagePublished: includeChangelogPage,
        sourcePath: "docs",
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})

import { portalUrl } from "@breezify/core"
import { resolveFeedDate } from "@/lib/documents/published-date"
import { uniqueIconsForCategoryEntries } from "@/lib/portal/category-icons"
import {
  isKnowledgeContentHref,
  parsePortalContentHref,
  transformKnowledgeHtmlLinks,
  transformTreeContentLinks,
  type KnowledgeHrefResolver,
} from "@/lib/portal/dsl/scope-filter"
import type { DslNode } from "@/lib/portal/dsl/node"
import type {
  PublicDocSummary,
  PublicTaxonomy,
  PublicWorkspace,
} from "@/lib/public-kb"
import type { PortalChromeScope } from "@/lib/workspace-settings"
import {
  DEFAULT_PORTAL_HEADER_ITEM_ORDER,
  DEFAULT_PORTAL_LANGUAGE_PLACEMENT,
  PORTAL_SCHEMA_VERSION,
  footerHasContent,
  validatePortalLayout,
  type ArticleItem,
  type CategoryItem,
  type FooterBlock,
  type HeaderBlock,
  type NavLink,
  type PortalChromeMode,
  type PortalBlock,
  type PortalLayout,
  type PortalTheme,
  type SidebarGroup,
  type StoredFooter,
  type StoredHeader,
} from "./schema"

// ---------------------------------------------------------------------------
// Default portal layout.
//
// Produces the Phase-1 portal design (the target mockup) from existing portal
// data: branding → theme, folders → sidebar + category grid, public docs
// → document list. This is the single source of the default design;
// the route renders whatever this returns through the same PortalRenderer that
// a persisted/agent-authored layout will use later.
// ---------------------------------------------------------------------------

const MAX_HOME_DOCUMENTS = 60
// Hero heading for new docs portals. Deliberately NOT in
// OLD_DEFAULT_HERO_HEADINGS so the normalize pass leaves it untouched.
const DOCS_HERO_HEADING = "Documentation"
// Normalize fallback applied to legacy heroes that get rewritten to the
// generic default.
const DEFAULT_HERO_HEADING = "How can we help 👋"
const DEFAULT_HERO_SUBTITLE =
  "We're here to help! Browse our help center for answers to your questions."
const OLD_DEFAULT_HERO_HEADINGS = new Set(["How can we help?", "How can we help 👋"])
const OLD_DEFAULT_SEARCH_PLACEHOLDERS = new Set([
  "Search or ask AI",
  "Ask, search, or explain…",
  "Ask, search, or explain...",
])

/**
 * Header nav links + CTA derived from the workspace's own landing page, when one
 * was captured during onboarding (`workspaces.settings.landing_page_url`). This
 * lets a generated portal link "Home" at the customer's real site instead of the
 * Breezify marketing placeholders the header otherwise falls back to. Both the nav
 * link and the CTA point at the exact URL the admin entered — we only ever link
 * pages we know exist. A guessed `<origin>/pricing` was dropped: onboarding never
 * captures a pricing URL, so the convention 404s for any site without one.
 * Returns empty nav + null CTA when no site is on file, preserving the prior
 * blank-chrome behavior for unconfigured portals.
 */
export function buildLandingPageNav(websiteUrl: string | null | undefined): {
  navLinks: NavLink[]
  cta: NavLink | null
} {
  if (!websiteUrl) return { navLinks: [], cta: null }
  let home: string
  try {
    home = new URL(websiteUrl).toString()
  } catch {
    return { navLinks: [], cta: null }
  }
  return {
    navLinks: [{ label: "Home", href: home }],
    cta: { label: "Visit website", href: home },
  }
}

export interface WorkspaceHeaderDefaults {
  header: HeaderBlock
  navLinks: NavLink[]
  cta: NavLink | null
}

export function buildWorkspaceHeaderDefaults(input: {
  websiteUrl?: string | null
  header?: StoredHeader | null
}): WorkspaceHeaderDefaults {
  const { navLinks, cta } = buildLandingPageNav(input.websiteUrl)
  return {
    header: {
      ...buildDefaultHeader(),
      ...(input.header?.search ? { search: input.header.search } : {}),
      ...(input.header?.itemOrder ? { itemOrder: input.header.itemOrder } : {}),
      ...(input.header?.languagePlacement
        ? { languagePlacement: input.header.languagePlacement }
        : {}),
    },
    navLinks: input.header?.navLinks ?? navLinks,
    cta: input.header && "cta" in input.header ? input.header.cta ?? null : cta,
  }
}

/** Theme is derived from brand settings plus the workspace's landing page. */
export function buildPortalTheme(workspace: PublicWorkspace): PortalTheme {
  const { branding } = workspace
  // When the workspace recorded its own website during onboarding, point the
  // header nav/CTA at it; otherwise leave them empty (the header then renders
  // blank chrome for customer portals — see PortalHeader / PRD §17 Q1).
  const { navLinks, cta } = buildLandingPageNav(workspace.websiteUrl)
  return {
    brandName: branding.name,
    tagline: branding.tagline,
    // Default to the workspace logo (brand logo, else the workspace icon) so a
    // project shows it without manual setup; blank means "use the workspace logo".
    logoUrl: branding.logoUrl || workspace.iconUrl || "",
    accentColor: branding.accentColor,
    navLinks,
    cta,
    // On by default so a freshly initialized portal's AI surface actually
    // works out of the box. Rendering is still gated by the workspace's
    // portal-AI entitlement (askAiEnabled), so this never over-promises on
    // plans without the feature.
    assistant: { enabled: true, placement: "corner", label: "Ask AI" },
    font: "sans",
    appearance: "auto",
  }
}

export function buildDefaultHeader(): HeaderBlock {
  return {
    id: "header",
    type: "portal-header",
    search: { enabled: true, placeholder: "Search or ask AI" },
    itemOrder: [...DEFAULT_PORTAL_HEADER_ITEM_ORDER],
  }
}

export function buildDefaultFooter(workspace?: PublicWorkspace): FooterBlock {
  const stored = workspace?.footer
  return {
    id: "footer",
    type: "footer",
    showPoweredBy: true,
    ...(stored?.columns?.length ? { columns: stored.columns } : {}),
    ...(stored?.social?.length ? { social: stored.social } : {}),
    ...(stored?.note ? { note: stored.note } : {}),
  }
}

export function portalChromeModeForScope(
  scope: PortalChromeScope | null | undefined,
): PortalChromeMode | undefined {
  if (!scope) return undefined
  return scope === "workspace" ? "workspace" : "custom"
}

export function withWorkspaceFooterFallback(
  footer: FooterBlock | null | undefined,
  workspaceFooter: StoredFooter | null | undefined,
  mode: PortalChromeMode = "workspace",
): FooterBlock | undefined {
  if (mode === "custom") {
    return footer ?? undefined
  }

  const base = footer
    ? {
        id: footer.id,
        type: footer.type,
        showPoweredBy: footer.showPoweredBy,
      }
    : {
        id: "footer",
        type: "footer" as const,
        showPoweredBy: true,
      }

  return {
    ...base,
    ...(workspaceFooter?.columns?.length ? { columns: workspaceFooter.columns } : {}),
    ...(workspaceFooter?.social?.length ? { social: workspaceFooter.social } : {}),
    ...(workspaceFooter?.note ? { note: workspaceFooter.note } : {}),
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function footerContentMatchesWorkspace(
  footer: FooterBlock | null | undefined,
  workspaceFooter: StoredFooter | null | undefined,
): boolean {
  if (!workspaceFooter || !footerHasContent(workspaceFooter)) return !footerHasContent(footer)
  return (
    !footer?.links?.length &&
    jsonEqual(footer?.columns ?? [], workspaceFooter.columns ?? []) &&
    jsonEqual(footer?.social ?? [], workspaceFooter.social ?? []) &&
    (footer?.note ?? "") === (workspaceFooter.note ?? "")
  )
}

function inferFooterMode(
  layout: PortalLayout,
  workspaceFooter: StoredFooter | null | undefined,
): PortalChromeMode {
  if (layout.chrome?.footerMode) return layout.chrome.footerMode
  return footerContentMatchesWorkspace(layout.footer, workspaceFooter) ? "workspace" : "custom"
}

export function footerForLayoutChrome(
  layout: PortalLayout | null | undefined,
  workspaceFooter: StoredFooter | null | undefined,
  workspaceChromeScope?: PortalChromeScope | null,
): FooterBlock | undefined {
  const forcedMode = portalChromeModeForScope(workspaceChromeScope)
  if (!layout) {
    return withWorkspaceFooterFallback(undefined, workspaceFooter, forcedMode ?? "workspace")
  }
  return withWorkspaceFooterFallback(
    layout.footer,
    workspaceFooter,
    forcedMode ?? inferFooterMode(layout, workspaceFooter),
  )
}

function headerContentMatchesWorkspace(
  layout: PortalLayout,
  workspaceHeader: WorkspaceHeaderDefaults | null | undefined,
): boolean {
  if (!workspaceHeader) return false
  return (
    jsonEqual(layout.header.search, workspaceHeader.header.search) &&
    jsonEqual(
      layout.header.itemOrder ?? DEFAULT_PORTAL_HEADER_ITEM_ORDER,
      workspaceHeader.header.itemOrder ?? DEFAULT_PORTAL_HEADER_ITEM_ORDER,
    ) &&
    (layout.header.languagePlacement ?? DEFAULT_PORTAL_LANGUAGE_PLACEMENT) ===
      (workspaceHeader.header.languagePlacement ??
        DEFAULT_PORTAL_LANGUAGE_PLACEMENT) &&
    jsonEqual(layout.theme.navLinks, workspaceHeader.navLinks) &&
    jsonEqual(layout.theme.cta, workspaceHeader.cta)
  )
}

function inferHeaderMode(
  layout: PortalLayout,
  workspaceHeader: WorkspaceHeaderDefaults | null | undefined,
): PortalChromeMode {
  if (layout.chrome?.headerMode) return layout.chrome.headerMode
  return headerContentMatchesWorkspace(layout, workspaceHeader) ? "workspace" : "custom"
}

export function withWorkspaceHeaderDefaults(
  layout: PortalLayout,
  workspaceHeader: WorkspaceHeaderDefaults | null | undefined,
  mode?: PortalChromeMode,
): PortalLayout {
  const headerMode = mode ?? inferHeaderMode(layout, workspaceHeader)
  if (headerMode === "custom" || !workspaceHeader) {
    return {
      ...layout,
      chrome: { ...layout.chrome, headerMode },
    }
  }

  return {
    ...layout,
    header: workspaceHeader.header,
    theme: {
      ...layout.theme,
      navLinks: workspaceHeader.navLinks,
      cta: workspaceHeader.cta,
    },
    chrome: { ...layout.chrome, headerMode },
  }
}

// A generated "N documents" card description (the shape older builds baked into
// stored layouts). Stripped at render time — counts proved unreliable across
// nesting/doc-type variations, so cards no longer show them at all.
const GENERATED_COUNT_RE = /^\d+ documents?$/
const FOLDER_HREF_RE = /\/folder\/([^/?#]+)/

function defaultHeroSubtitle(
  theme: PortalTheme,
  documents: PublicDocSummary[],
  isEmpty: boolean,
  fallback: string = DEFAULT_HERO_SUBTITLE,
): string {
  if (isEmpty) {
    return "Your knowledge base is ready. Publish your first docs from Breezify to share them here."
  }
  if (theme.tagline) return theme.tagline
  return fallback
}

function docHref(slug: string, doc: PublicDocSummary): string {
  return portalUrl(slug, { subpath: `doc/${doc.slug ?? doc.id}` })
}

function folderHref(slug: string, id: string): string {
  return portalUrl(slug, { subpath: `folder/${id}` })
}

/**
 * Portal-level presentation override for a folder, keyed by folder id. Stored
 * as `layout.sidebarOverrides` for historical reasons — it began as a nav-rail-
 * only override — but it applies to every surface that renders a folder, the
 * home category cards included.
 */
type FolderOverrides = Record<string, { icon?: string; label?: string }> | undefined

/**
 * Category-grid items for a set of root folders (folder title, folder icon,
 * folder href). Shared by buildDefaultPortalLayout and
 * the normalize pass that repopulates an empty seeded grid from live data. The
 * editor is authoritative: a folder without a custom icon uses the same generic
 * folder glyph here instead of inventing a semantic icon from its name — unless
 * this portal overrides the folder's icon/label, which wins over both.
 */
function categoryItemsForFolders(
  slug: string,
  rootFolders: PublicTaxonomy["rootFolders"],
  overrides?: FolderOverrides,
): CategoryItem[] {
  return rootFolders.map<CategoryItem>((f) => ({
    id: f.id,
    title: overrides?.[f.id]?.label ?? f.display_name,
    icon: overrides?.[f.id]?.icon ?? f.icon ?? "folder",
    href: folderHref(slug, f.id),
  }))
}

/**
 * Keep the generated home-page quick links aligned with the live root folders.
 * Existing cards may have publisher-authored titles or descriptions, so retain
 * those fields while taking the icon and href from the folder editor. Append
 * only folders that have no card yet. When the generated grid still contains
 * its document-only empty-state fallback, replace that fallback with the first
 * real folder links.
 *
 * A portal-level folder override (see FolderOverrides) is the one thing that
 * beats the card's own title: it is a deliberate, newer instruction about this
 * folder, whereas the stored title may be a stale label baked in at publish.
 * `generatedItems` already carries the overridden icon.
 *
 * This intentionally applies only to the generated `categories` surface (and
 * its `n-categories` DSL counterpart below). Other category grids are curated
 * content and must not grow just because a folder was added.
 */
function syncGeneratedFolderCategoryItems(
  existingItems: CategoryItem[],
  generatedItems: CategoryItem[],
  overrides?: FolderOverrides,
): CategoryItem[] {
  const linkedFolderIds = new Set<string>()
  for (const item of existingItems) {
    const folderId = FOLDER_HREF_RE.exec(item.href)?.[1]
    if (folderId) linkedFolderIds.add(folderId)
  }

  if (linkedFolderIds.size === 0) return generatedItems

  const generatedById = new Map(generatedItems.map((item) => [item.id, item]))
  const syncedExisting = existingItems.map((item) => {
    const folderId = FOLDER_HREF_RE.exec(item.href)?.[1]
    const generated = folderId ? generatedById.get(folderId) : undefined
    if (!generated) return item
    const label = folderId ? overrides?.[folderId]?.label : undefined
    return {
      ...item,
      ...(label ? { title: label } : {}),
      icon: generated.icon,
      href: generated.href,
    }
  })

  return [
    ...syncedExisting,
    ...generatedItems.filter((item) => !linkedFolderIds.has(item.id)),
  ].slice(0, 60)
}

function articleItemsForDocuments(
  slug: string,
  documents: PublicDocSummary[],
  options: { hrefForDocument?: (document: PublicDocSummary) => string } = {},
): ArticleItem[] {
  return documents
    .slice(0, MAX_HOME_DOCUMENTS)
    .map((d) => ({
      id: d.id,
      title: d.title || "Untitled",
      href: options.hrefForDocument?.(d) ?? docHref(slug, d),
      ...(d.description ? { description: d.description } : {}),
      source: d.source,
      ...(d.readTimeMinutes ? { readTimeMinutes: d.readTimeMinutes } : {}),
      ...(resolveFeedDate({ publishedAt: d.published_at, updatedAt: d.updated_at })
        ? {
            date: resolveFeedDate({
              publishedAt: d.published_at,
              updatedAt: d.updated_at,
            })!,
          }
        : {}),
    }))
}

// Explicitly ordered docs (dragged in the KB sidebar) come first, by their
// sort_order; docs without one keep the data layer's recency order. The sort
// must be stable for the null/null case, which Array.prototype.sort is.
function comparePortalDocuments(
  a: PublicDocSummary,
  b: PublicDocSummary,
): number {
  const aSort = a.sort_order ?? null
  const bSort = b.sort_order ?? null
  if (aSort !== null && bSort !== null) return aSort - bSort
  if (aSort !== null) return -1
  if (bSort !== null) return 1
  return 0
}

function comparePortalFolders(
  a: PublicTaxonomy["rootFolders"][number],
  b: PublicTaxonomy["rootFolders"][number],
): number {
  if (a.sort_order !== null && b.sort_order !== null && a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order
  }
  if (a.sort_order !== null && b.sort_order === null) return -1
  if (a.sort_order === null && b.sort_order !== null) return 1
  return a.display_name.localeCompare(b.display_name)
}

/** The entry document follows the same reading order as the sidebar and pager. */
export function firstPortalDocument(
  taxonomy: PublicTaxonomy,
  documents: PublicDocSummary[],
): PublicDocSummary | undefined {
  const groups = sidebarGroupsForDocuments({
    slug: "", taxonomy, documents, folderLabelFallback: "Section",
  })
  const firstId = (groups: SidebarGroup[]): string | undefined => {
    for (const group of groups) {
      const id = firstId(group.children ?? []) ?? group.items[0]?.id
      if (id) return id
    }
  }
  const id = firstId(groups)
  return documents.find((document) => document.id === id)
}

function sidebarGroupsForDocuments(input: {
  slug: string
  taxonomy: PublicTaxonomy
  documents: PublicDocSummary[]
  folderLabelFallback: string
  overrides?: Record<string, { icon?: string; label?: string }>
}): SidebarGroup[] {
  const { slug, taxonomy, documents, folderLabelFallback, overrides } = input
  if (taxonomy.rootFolders.length === 0) {
    const articleItems = articleItemsForDocuments(
      slug,
      [...documents].sort(comparePortalDocuments),
    )
    const docsOverride = overrides?.["documents"]
    return articleItems.length > 0
      ? [
          {
            id: "documents",
            label: docsOverride?.label || "Documents",
            icon: docsOverride?.icon ?? "file-text",
            items: articleItems.map((doc) => ({
              id: doc.id,
              label: doc.title,
              href: doc.href,
            })),
          },
        ]
      : []
  }

  const allFolders = taxonomy.allFolders ?? taxonomy.rootFolders
  const foldersByParent = new Map<string | null, PublicTaxonomy["rootFolders"]>()
  for (const folder of allFolders) {
    const siblings = foldersByParent.get(folder.parent_folder_id) ?? []
    siblings.push(folder)
    foldersByParent.set(folder.parent_folder_id, siblings)
  }
  for (const siblings of foldersByParent.values()) siblings.sort(comparePortalFolders)

  const docsByFolder = new Map<string, PublicDocSummary[]>()
  for (const doc of documents) {
    if (!doc.folder_id) continue
    const list = docsByFolder.get(doc.folder_id)
    if (list) list.push(doc)
    else docsByFolder.set(doc.folder_id, [doc])
  }
  for (const list of docsByFolder.values()) list.sort(comparePortalDocuments)

  // Root rails render the same icon shown in the editor. A portal-specific
  // override still wins; otherwise use the folder's stored icon or the generic
  // folder glyph. Repeated folder glyphs are intentional because they reflect
  // the actual editor state rather than an inferred icon from the label.
  const rootIcons = new Map(
    taxonomy.rootFolders.map((folder) => [
      folder.id,
      overrides?.[folder.id]?.icon ?? folder.icon ?? "folder",
    ]),
  )

  const buildFolderGroup = (
    folder: PublicTaxonomy["rootFolders"][number],
    visited: Set<string>,
  ): SidebarGroup => {
    const nextVisited = new Set(visited)
    nextVisited.add(folder.id)
    const children = (foldersByParent.get(folder.id) ?? [])
      .filter((child) => !nextVisited.has(child.id))
      .map((child) => buildFolderGroup(child, nextVisited))
    const items = articleItemsForDocuments(slug, docsByFolder.get(folder.id) ?? [])
      .map((doc) => ({
        id: doc.id,
        label: doc.title,
        href: doc.href,
      }))

    const override = overrides?.[folder.id]
    return {
      id: folder.id,
      label: override?.label || folder.display_name || folderLabelFallback,
      // Root folders take the editor-matched assignment above. Nested groups
      // do not render icons, but retain the legacy fallback in their data.
      icon:
        rootIcons.get(folder.id) ??
        override?.icon ??
        folder.icon ??
        "folder",
      items,
      ...(children.length > 0 ? { children } : {}),
    }
  }

  const folderGroups = taxonomy.rootFolders.map((folder) =>
    buildFolderGroup(folder, new Set()),
  )
  const promotedRootIds = new Set(taxonomy.promotedRootIds ?? [])
  const topLevelDocuments = documents
    .filter((doc) => !doc.folder_id || promotedRootIds.has(doc.folder_id))
    .sort(comparePortalDocuments)
  if (topLevelDocuments.length === 0) return folderGroups

  const docsOverride = overrides?.["documents"]
  const documentsGroup: SidebarGroup = {
    id: "documents",
    label: docsOverride?.label || "Documents",
    icon: docsOverride?.icon ?? "file-text",
    items: articleItemsForDocuments(slug, topLevelDocuments).map((doc) => ({
      id: doc.id,
      label: doc.title,
      href: doc.href,
    })),
  }
  return [...folderGroups, documentsGroup]
}

function isOldDefaultHero(block: PortalBlock): boolean {
  return block.type === "hero" && OLD_DEFAULT_HERO_HEADINGS.has(block.heading)
}

function isGeneratedDefaultHero(block: PortalBlock, brandName: string): boolean {
  return (
    block.type === "hero" &&
    (OLD_DEFAULT_HERO_HEADINGS.has(block.heading) ||
      block.heading === `Welcome to ${brandName}`)
  )
}

function isOldDefaultSearchPlaceholder(value: string): boolean {
  return OLD_DEFAULT_SEARCH_PLACEHOLDERS.has(value)
}

function isDefaultAllDocumentsList(block: Extract<PortalBlock, { type: "article-list" }>): boolean {
  return (
    block.id === "trending" ||
    block.id === "all-documents" ||
    block.title === "Trending Articles" ||
    block.title === "All documents"
  )
}

/**
 * Synchronize the generated CategoryGrid in a v2 DSL tree with scoped root
 * folders, and repopulate other grids only when they are empty. This is the
 * tree counterpart of the body pass: `n-categories` is generated navigation,
 * while every other non-empty CategoryGrid is publisher-curated content.
 */
function syncTreeCategoryGrids(
  node: DslNode,
  items: CategoryItem[],
  overrides?: FolderOverrides,
): DslNode {
  if (items.length === 0) return node
  let next = node
  if (node.type === "CategoryGrid") {
    const existing = node.props?.items
    if (node.id === "n-categories") {
      next = {
        ...node,
        props: {
          ...node.props,
          items: syncGeneratedFolderCategoryItems(
            Array.isArray(existing) ? (existing as CategoryItem[]) : [],
            items,
            overrides,
          ),
        },
      }
    } else if (!Array.isArray(existing) || existing.length === 0) {
      next = { ...node, props: { ...node.props, items } }
    }
  }
  if (!next.children?.length) return next
  return {
    ...next,
    children: next.children.map((child) =>
      syncTreeCategoryGrids(child, items, overrides),
    ),
  }
}

export function normalizePortalLayoutForPublicData(input: {
  slug: string
  layout: PortalLayout
  taxonomy: PublicTaxonomy
  documents: PublicDocSummary[]
  /**
   * Workspace-level footer (settings.kb_footer). Layouts published before a
   * workspace footer existed carry an empty footer block; when provided, this
   * fills that block at render time so configuring the footer once lights up
   * every already-published portal. Explicit custom footer mode keeps the
   * block's own content.
   */
  workspaceFooter?: StoredFooter | null
  /** Workspace-level header defaults (search, nav links, CTA). */
  workspaceHeader?: WorkspaceHeaderDefaults | null
  /**
   * Workspace setting that forces all portal projects to either shared
   * workspace chrome or project-specific chrome. When omitted, legacy per-layout
   * chrome inference is preserved.
   */
  workspaceChromeScope?: PortalChromeScope | null
}): PortalLayout {
  const { slug, taxonomy, documents } = input
  const forcedChromeMode = portalChromeModeForScope(input.workspaceChromeScope)
  const layout = withWorkspaceHeaderDefaults(
    input.layout,
    input.workspaceHeader,
    forcedChromeMode,
  )
  const articleItems = articleItemsForDocuments(slug, documents)
  const hasDocuments = articleItems.length > 0
  const hasFolders = taxonomy.rootFolders.length > 0
  const defaultSubtitle = defaultHeroSubtitle(
    layout.theme,
    documents,
    !hasFolders && !hasDocuments,
  )

  // Content-link scoping at render time. Stored layouts accumulate doc/folder
  // hrefs from several producers that baked different URL bases (project slug,
  // workspace slug, `<ws>/<project>`), and the project scope can narrow after a
  // layout was authored — so visibility is decided by the CONTENT REF (folder
  // id, doc slug/id) against the live scoped data, never by string-matching the
  // current base. In-scope hrefs are rehomed onto this render's base so stale
  // links navigate correctly; out-of-scope ones resolve to null (dropped).
  const scopedFolderIds = new Set(
    (taxonomy.allFolders ?? taxonomy.rootFolders).map((folder) => folder.id),
  )
  const scopedDocRefs = new Set(
    documents.flatMap((doc) => (doc.slug ? [doc.id, doc.slug] : [doc.id])),
  )
  const resolveContentHref: KnowledgeHrefResolver = (href) => {
    const content = parsePortalContentHref(href)
    // Unparseable knowledge hrefs (e.g. private-app /knowledge/… links) are
    // never valid portal content.
    if (!content) return null
    const visible =
      content.kind === "folder"
        ? scopedFolderIds.has(content.ref)
        : scopedDocRefs.has(content.ref)
    return visible ? portalUrl(slug, { subpath: `${content.kind}/${content.ref}` }) : null
  }
  const resolveItemHref = (href: string): string | null =>
    isKnowledgeContentHref(href) ? resolveContentHref(href) : href

  const resolveItems = <T extends { href: string; icon?: string }>(
    items: T[],
  ): T[] =>
    items.flatMap((item) => {
      if (item.icon === "hash") return []
      const resolved = resolveItemHref(item.href)
      if (resolved === null) return []
      return [resolved === item.href ? item : { ...item, href: resolved }]
    })

  // Header nav / CTA / footer links can also carry doc/folder hrefs; they get
  // the same treatment (external links pass through untouched).
  const resolveNavLinks = (links: NavLink[]): NavLink[] =>
    links.flatMap((link) => {
      const resolved = resolveItemHref(link.href)
      if (resolved === null) return []
      return [resolved === link.href ? link : { ...link, href: resolved }]
    })
  const resolvedCta = layout.theme.cta
    ? (resolveNavLinks([layout.theme.cta])[0] ?? null)
    : null
  const resolvedFooter = layout.footer
    ? {
        ...layout.footer,
        ...(layout.footer.links ? { links: resolveNavLinks(layout.footer.links) } : {}),
        ...(layout.footer.columns
          ? {
              columns: layout.footer.columns
                .map((column) => ({ ...column, links: resolveNavLinks(column.links) }))
                .filter((column) => column.links.length > 0),
            }
          : {}),
      }
    : layout.footer

  // An empty footer block (no columns/social/note/links) inherits the
  // workspace-level footer, preserving the block's own showPoweredBy choice.
  const footerMode = forcedChromeMode ?? inferFooterMode(layout, input.workspaceFooter)
  const footerWithFallback = withWorkspaceFooterFallback(
    resolvedFooter,
    input.workspaceFooter,
    footerMode,
  )

  const body: PortalBlock[] = []
  let sawArticleList = false

  for (const block of layout.body) {
    if (block.type === "hero") {
      body.push(
        isGeneratedDefaultHero(block, layout.theme.brandName)
          ? {
              ...block,
              eyebrow: undefined,
              heading: DEFAULT_HERO_HEADING,
              subtitle: defaultSubtitle,
            }
          : block,
      )
      continue
    }

    if (block.type === "ask-ai-search") {
      // Older published layouts can still carry a page-level search block.
      // Keep accepting it in the schema, but consolidate the live experience
      // onto the global search in the portal header.
      continue
    }

    if (block.type === "category-grid") {
      // Keep curated, still-visible items (rehomed onto this base). When a grid
      // resolves to no visible items — e.g. a stored spec that ships an EMPTY
      // grid meant to fill at render time — repopulate it from the (scoped)
      // root folders so a topic grid renders instead of the block being
      // dropped.
      //
      // Stored layouts from older builds baked "N documents" descriptions at
      // publish time; those go stale as docs move, so drop them at render.
      // Curated copy (anything not matching the generated shape) is left alone.
      const stripFolderCount = (item: CategoryItem): CategoryItem => {
        if (!GENERATED_COUNT_RE.test(item.description ?? "")) return item
        if (!FOLDER_HREF_RE.test(item.href)) return item
        const { description: _dropped, ...rest } = item
        return rest
      }
      const resolvedItems = resolveItems(block.items).map(stripFolderCount)
      // `categories` is the generated homepage quick-link surface. Keep it in
      // lockstep with root folders even after it has its first item; the prior
      // empty-only refill made every subsequently-created folder disappear.
      // This also replaces the initial document-card fallback once folders
      // exist, matching buildDefaultPortalLayout's folder-first behavior.
      const items =
        block.id === "categories" && hasFolders
          ? syncGeneratedFolderCategoryItems(
              resolvedItems,
              categoryItemsForFolders(
                slug,
                taxonomy.rootFolders,
                layout.sidebarOverrides,
              ),
              layout.sidebarOverrides,
            )
          : resolvedItems
      if (items.length > 0) {
        // Curated grids retain their distinct-icon normalization. The generated
        // `categories` grid instead mirrors the folder editor exactly, including
        // repeated generic folder glyphs.
        //
        // A folder-linked card takes the folder's icon, so a per-card edit here
        // could never stick — the next normalize overwrote it. This portal's
        // folder override is the escape hatch and wins over the stored folder
        // icon.
        const folderIconById = new Map(
          (taxonomy.allFolders ?? taxonomy.rootFolders).map((folder) => [
            folder.id,
            layout.sidebarOverrides?.[folder.id]?.icon ?? folder.icon ?? "folder",
          ]),
        )
        const iconForItem = (item: CategoryItem): string | undefined => {
          const folderId = FOLDER_HREF_RE.exec(item.href)?.[1]
          return (folderId && folderIconById.get(folderId)) || item.icon
        }
        const icons =
          block.id === "categories"
            ? items.map(iconForItem)
            : uniqueIconsForCategoryEntries(
                items.map((item) => ({ label: item.title, icon: iconForItem(item) })),
                "folder",
              )
        body.push({
          ...block,
          items: items.map((item, index) =>
            item.icon === icons[index] ? item : { ...item, icon: icons[index] },
          ),
        })
      } else if (hasFolders) {
        body.push({
          ...block,
          items: categoryItemsForFolders(
            slug,
            taxonomy.rootFolders,
            layout.sidebarOverrides,
          ),
        })
      }
      continue
    }

    if (block.type === "article-list") {
      sawArticleList = true
      // Docs portals should feel like developer documentation: when categories
      // exist, keep the landing page focused on sections instead of dumping the
      // full document set. Preserve explicit/curated lists and use flat
      // documents only as a no-category fallback.
      if (hasFolders && isDefaultAllDocumentsList(block)) {
        continue
      }
      if (hasDocuments) {
        body.push({
          ...block,
          title:
            block.id === "trending" || block.title === "Trending Articles"
              ? "All documents"
              : block.title || "All documents",
          items: articleItems,
        })
      }
      continue
    }

    // HTML blocks can embed doc/folder links; strip out-of-scope ones and
    // rehome the rest, mirroring the item handling above.
    if (block.type === "rich-text") {
      body.push({ ...block, html: transformKnowledgeHtmlLinks(block.html, resolveContentHref) })
      continue
    }
    if (block.type === "callout") {
      body.push({ ...block, body: transformKnowledgeHtmlLinks(block.body, resolveContentHref) })
      continue
    }

    body.push(block)
  }

  let hasCategoryGrid = body.some(
    (block) => block.type === "category-grid" && block.items.length > 0,
  )
  if (hasFolders && !hasCategoryGrid) {
    body.push({
      id: "categories",
      type: "category-grid",
      placement: "main",
      items: categoryItemsForFolders(
        slug,
        taxonomy.rootFolders,
        layout.sidebarOverrides,
      ),
    })
    hasCategoryGrid = true
  }
  if (!sawArticleList && hasDocuments && !hasCategoryGrid) {
    body.push({
      id: "all-documents",
      type: "article-list",
      placement: "main",
      title: "All documents",
      items: articleItems,
    })
  }

  const sidebarGroups = sidebarGroupsForDocuments({
    slug,
    taxonomy,
    documents,
    folderLabelFallback: "Section",
    overrides: layout.sidebarOverrides,
  })
  const hasOldDefaultHero = layout.body.some((block) =>
    isGeneratedDefaultHero(block, layout.theme.brandName),
  )
  const components = layout.components?.map((component) => ({
    ...component,
    // Static hrefs inside component definitions need the same render-time
    // filtering as the main tree. Placeholder hrefs are handled on each
    // composite instance by transformTreeContentLinks below.
    tree: transformTreeContentLinks(component.tree, resolveContentHref),
  }))
  return {
    ...layout,
    // v2 layouts render from the DSL tree (PortalRenderer prefers it over
    // `body`), so it needs the same scope filtering + rehoming — without this a
    // scope narrowed after authoring still renders its old content links.
    ...(layout.tree
      ? {
          tree: syncTreeCategoryGrids(
            transformTreeContentLinks(layout.tree, resolveContentHref, components),
            hasFolders
              ? categoryItemsForFolders(
                  slug,
                  taxonomy.rootFolders,
                  layout.sidebarOverrides,
                )
              : [],
            layout.sidebarOverrides,
          ),
        }
      : {}),
    ...(components ? { components } : {}),
    theme: {
      ...layout.theme,
      navLinks: resolveNavLinks(layout.theme.navLinks),
      cta: resolvedCta,
      font: hasOldDefaultHero ? "sans" : layout.theme.font,
    },
    footer: footerWithFallback,
    chrome: {
      ...layout.chrome,
      headerMode: layout.chrome?.headerMode ?? forcedChromeMode ?? "custom",
      footerMode,
    },
    header: {
      ...layout.header,
      search: {
        ...layout.header.search,
        placeholder: isOldDefaultSearchPlaceholder(layout.header.search.placeholder)
          ? "Search or ask AI"
          : layout.header.search.placeholder,
      },
    },
    sidebar:
      sidebarGroups.length > 0
        ? {
            id: layout.sidebar?.id ?? "sidebar",
            type: "sidebar-nav",
            groups: sidebarGroups,
            // Presentation flags survive the folder-driven regeneration, like
            // sidebarOverrides. When the flag is unset but the publisher gave
            // a root section an explicit icon (folder icon or override), that
            // choice implies the rail should render icons — otherwise the
            // text-only default would silently swallow it.
            ...(layout.sidebar?.showIcons !== undefined
              ? { showIcons: layout.sidebar.showIcons }
              : taxonomy.rootFolders.some(
                    (folder) =>
                      folder.icon || layout.sidebarOverrides?.[folder.id]?.icon,
                  )
                ? { showIcons: true }
                : {}),
          }
        : undefined,
    body,
  }
}

export function buildDefaultPortalLayout(input: {
  slug: string
  workspace: PublicWorkspace
  taxonomy: PublicTaxonomy
  rootDocs: PublicDocSummary[]
}): PortalLayout {
  const { slug, workspace, taxonomy, rootDocs } = input
  const { rootFolders } = taxonomy
  const theme = buildPortalTheme(workspace)

  const groups = sidebarGroupsForDocuments({
    slug,
    taxonomy,
    documents: rootDocs,
    folderLabelFallback: "Section",
  })

  // ----- category grid: prefer folders; fall back to root docs --------------
  const categoryItems: CategoryItem[] = categoryItemsForFolders(slug, rootFolders)
  if (categoryItems.length === 0) {
    categoryItems.push(
      ...rootDocs.map<CategoryItem>((d) => ({
        id: d.id,
        title: d.title || "Untitled",
        icon: "file-text",
        href: docHref(slug, d),
      })),
    )
  }

  const isEmpty = rootFolders.length === 0 && rootDocs.length === 0

  const subtitle = defaultHeroSubtitle(
    theme,
    rootDocs,
    isEmpty,
    `Guides, references, and answers for working with ${theme.brandName}.`,
  )

  const body: PortalBlock[] = [
    {
      id: "hero",
      type: "hero",
      placement: "full",
      heading: DOCS_HERO_HEADING,
      subtitle,
    },
  ]

  if (categoryItems.length > 0) {
    body.push({
      id: "categories",
      type: "category-grid",
      placement: "main",
      items: categoryItems,
    })
  }
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme,
    header: buildDefaultHeader(),
    sidebar: groups.length > 0 ? { id: "sidebar", type: "sidebar-nav", groups } : undefined,
    body,
    footer: buildDefaultFooter(workspace),
  }
}

// ---------------------------------------------------------------------------
// changelog page.
//
// A "what's new" release feed for a project page with the "changelog"
// presentation: a compact hero and a single dated entry list (article-list with
// the "changelog" variant, which renders month headers and per-entry dates from
// `date`). Sidebar-less — the month-grouped feed IS the navigation.
// ---------------------------------------------------------------------------

const CHANGELOG_HERO_SUBTITLE =
  "New features, improvements, and fixes — most recent first."

export function buildChangelogLayout(input: {
  slug: string
  workspace: PublicWorkspace
  taxonomy: PublicTaxonomy
  rootDocs: PublicDocSummary[]
  /** Keeps entry navigation inside the page route. */
  entryHref?: (document: PublicDocSummary) => string
  /** The page's navigation label; also the feed's heading. */
  heading?: string
  subtitle?: string
}): PortalLayout {
  const { slug, workspace, rootDocs } = input
  const theme = buildPortalTheme(workspace)
  const articleItems = articleItemsForDocuments(slug, rootDocs, {
    hrefForDocument: input.entryHref,
  })

  const body: PortalBlock[] = [
    {
      id: "hero",
      type: "hero",
      placement: "full",
      heading: input.heading || `What's new in ${theme.brandName}`,
      subtitle: input.subtitle || CHANGELOG_HERO_SUBTITLE,
    },
  ]

  if (articleItems.length > 0) {
    body.push({
      id: "changelog-entries",
      type: "article-list",
      placement: "main",
      title: "Updates",
      variant: "changelog",
      items: articleItems,
    })
  }

  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme,
    header: buildDefaultHeader(),
    body,
    footer: buildDefaultFooter(workspace),
  }
}

/**
 * Resolve the live portal layout for a page render: build the docs default
 * from scoped data, fall through validation, then normalize against the actual
 * taxonomy + documents. Both the home and folder routes render the same resolved
 * layout — and therefore the same sidebar nav — so navigation is consistent.
 */
export function resolvePortalLayout(input: {
  slug: string
  workspace: PublicWorkspace
  taxonomy: PublicTaxonomy
  rootDocs: PublicDocSummary[]
  publishedLayout: PortalLayout | null
}): PortalLayout {
  const { slug, workspace, taxonomy, rootDocs, publishedLayout } = input
  const built = buildDefaultPortalLayout({
    slug,
    workspace,
    taxonomy,
    rootDocs,
  })
  const validated = validatePortalLayout(built)
  if (!validated.ok) {
    // Built layout is valid by construction; this guards future drift and is the
    // single render path stored/agent-authored layouts also flow through.
    console.error("[Breezify] default portal layout failed validation:", validated.error)
  }
  return normalizePortalLayoutForPublicData({
    slug,
    layout: publishedLayout ?? (validated.ok ? validated.data : built),
    taxonomy,
    documents: rootDocs,
    workspaceFooter: workspace.footer,
    workspaceHeader: buildWorkspaceHeaderDefaults(workspace),
    workspaceChromeScope: workspace.portalChromeScope,
  })
}

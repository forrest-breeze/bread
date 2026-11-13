import { notFound } from "next/navigation"
import {
  getPublicDocument,
  getPublicDocumentLinks,
  getPublicFolderDetail,
  getPublicTaxonomy,
  getRootPublicDocuments,
  isDocInScope,
  type PublicWorkspace,
  type PublicTaxonomy,
  type PublicDocSummary,
  type PortalScopeEntry,
} from "@/lib/public-kb"
import {
  renderPublicHtmlCached,
  renderPublicHtmlWithCodeGroupsCached,
} from "@/lib/public-kb-render-cache"
import { parseApiOperation } from "@/lib/portal/api-reference-model"
import { PublicKbDocument } from "@/components/public-kb/public-kb-document"
import { PortalViewBeacon } from "@/components/public-kb/portal/portal-view-beacon"
import { resolvePortalLayout, buildDefaultFooter } from "@/lib/portal/build-default"
import type { PortalLayout, SidebarGroup } from "@/lib/portal/schema"
import type { KbBreadcrumbItem } from "@/components/kb/kb-breadcrumbs"
import type { DocPagerLinks } from "@/components/public-kb/portal/portal-doc-pager"
import { PortalFooter } from "@/components/public-kb/portal/portal-footer"
import {
  withPublicPortalHtml,
  withPublicPortalBase,
} from "@/lib/portal/public-base-path"

// The doc ref accepts either a raw document UUID (back-compat) or a
// human-readable public_slug. getPublicDocument resolves both and 404s on a
// miss; this guard only rejects obviously malformed values before the DB hit.
export const DOC_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,199}$/

function formatDate(value: string | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

// Flatten the sidebar's nested folder groups into the linear reading order of
// document links (depth-first: a group's nested children, then its own docs).
// Sidebar item ids are document ids (see build-default), so the current doc's
// neighbors in this list are its previous/next pages.
function flattenSidebarDocs(
  groups: SidebarGroup[],
): Array<{ id: string; label: string; href: string }> {
  const out: Array<{ id: string; label: string; href: string }> = []
  const visit = (group: SidebarGroup): void => {
    for (const child of group.children ?? []) visit(child)
    for (const item of group.items) {
      out.push({ id: item.id, label: item.label, href: item.href })
    }
  }
  for (const group of groups) visit(group)
  return out
}

function docPagerFor(
  sidebar: PortalLayout["sidebar"],
  currentDocId: string,
): DocPagerLinks | undefined {
  if (!sidebar) return undefined
  const ordered = flattenSidebarDocs(sidebar.groups)
  const index = ordered.findIndex((entry) => entry.id === currentDocId)
  if (index === -1) return undefined
  const prev = index > 0 ? ordered[index - 1] : null
  const next = index < ordered.length - 1 ? ordered[index + 1] : null
  if (!prev && !next) return undefined
  return {
    prev: prev ? { label: prev.label, href: prev.href } : null,
    next: next ? { label: next.label, href: next.href } : null,
  }
}

interface PortalDocViewProps {
  workspace: PublicWorkspace
  /** In-portal link prefix: `<workspace>` or `<workspace>/<project>`. */
  base: string
  hrefBase: string
  /**
   * Reachability scope: the project scope widened by every page's scope. Gates
   * whether this document is served at all.
   */
  scope: PortalScopeEntry[] | null
  /**
   * Scope the navigation rail is built from — the project's own (Home) scope.
   * Kept separate from `scope` so page-owned content (reference endpoints)
   * stays reachable by URL without leaking into the
   * documentation rail. Omit to build the rail from `scope`.
   */
  navScope?: PortalScopeEntry[] | null
  publishedLayout: PortalLayout | null
  /** Document ref from the URL — a public_slug or UUID. */
  refId: string
  canRemoveBreezifyBranding: boolean
  preview?: boolean
  previewData?: { taxonomy: PublicTaxonomy; documents: PublicDocSummary[] }
}

export async function PortalDocView({
  workspace,
  base,
  hrefBase,
  scope,
  navScope,
  publishedLayout,
  refId,
  canRemoveBreezifyBranding,
  preview = false,
  previewData,
}: PortalDocViewProps): Promise<React.ReactElement> {
  if (!DOC_REF_RE.test(refId)) notFound()

  const doc = await getPublicDocument(workspace.id, refId)
  if (!doc) notFound()

  // A scoped (non-default) project must not expose docs outside its scope —
  // including unpicked docs inside an explicitDocs folder.
  if (!(await isDocInScope(workspace.id, { id: doc.id, folder_id: doc.folder_id }, scope))) {
    notFound()
  }

  // The rail is built from the project's own scope so a document page shows the
  // same navigation as Home. `scope` is widened by every page's scope purely so
  // page-owned documents resolve by URL; building the layout from it drags that
  // content (reference endpoints) into the sidebar. A
  // document that lives ONLY in a page's scope has no place in the Home rail,
  // so it keeps rendering against the widened scope.
  const railScope =
    !navScope || navScope === scope
      ? scope
      : (await isDocInScope(
            workspace.id,
            { id: doc.id, folder_id: doc.folder_id },
            navScope,
          ))
        ? navScope
        : scope

  // `refId` may be a slug; link lookups key on the resolved document UUID. Scope
  // the related-doc panel so a scoped project never relates out beyond its
  // folders.
  const links = await getPublicDocumentLinks(workspace.id, doc.id, scope)


  // Endpoint docs ("GET /v1/...") get a language picker on their request
  // samples; ordinary guides keep adjacent code blocks as separate steps.
  // Rendered once per body (content-addressed cache), not once per view.
  const renderOptions = { memoryOnly: preview }
  const bodyHtml = parseApiOperation(doc.title, doc.content).method
    ? await renderPublicHtmlWithCodeGroupsCached(doc.content, renderOptions)
    : await renderPublicHtmlCached(doc.content, renderOptions)
  const html = withPublicPortalHtml(bodyHtml, base, hrefBase)
  // The reading rail resolves from the same taxonomy as folder pages.
  const [taxonomy, rootDocs] = previewData
    ? [previewData.taxonomy, previewData.documents]
    : await Promise.all([
    getPublicTaxonomy(workspace.id, railScope),
    getRootPublicDocuments(workspace.id, railScope),
  ])
  // Match navigation: omit portal containers and ancestors outside its scope.
  const hiddenRoots = new Set(taxonomy.promotedRootIds ?? [])
  const visibleFolderIds = new Set(
    (taxonomy.allFolders ?? taxonomy.rootFolders)
      .filter((folder) => !hiddenRoots.has(folder.id))
      .map((folder) => folder.id),
  )
  const breadcrumbs: KbBreadcrumbItem[] = []
  if (doc.folder_id) {
    const detail = await getPublicFolderDetail(workspace.id, doc.folder_id)
    if (detail) {
      for (const ancestor of detail.ancestors) {
        if (!visibleFolderIds.has(ancestor.id)) continue
        breadcrumbs.push({
          label: ancestor.display_name,
        })
      }
      if (visibleFolderIds.has(detail.folder.id)) {
        breadcrumbs.push({
          label: detail.folder.display_name,
        })
      }
    }
  }
  breadcrumbs.push({ label: doc.title || "Untitled" })


  const resolvedLayout = withPublicPortalBase(
    resolvePortalLayout({
      slug: base,
      workspace,
      taxonomy,
      rootDocs,
      publishedLayout,
    }),
    base,
    hrefBase,
  )
  const sidebar = resolvedLayout.sidebar

  const pager = docPagerFor(sidebar, doc.id)
  const theme = resolvedLayout.theme
  const footer = resolvedLayout.footer ?? buildDefaultFooter(workspace)
  return (
    <>
      {preview ? null : <PortalViewBeacon slug={base} type="doc_view" documentId={doc.id} />}
      <div className="flex min-h-[calc(100vh-4rem)] w-full flex-col justify-between">
        <div className="flex-1">
          <PublicKbDocument
            slug={base}
            hrefBase={hrefBase}
            documentId={doc.id}
            title={doc.title}
            html={html}
            source={doc.source}
            author={doc.author}
            updated={theme.showLastUpdated === false ? "" : formatDate(doc.updated_at)}
            breadcrumbs={breadcrumbs}
            outbound={links.outbound}
            inbound={links.inbound}
            sidebar={sidebar}
            pager={pager}
            footer={sidebar ? footer : undefined}
            editable={preview}
            copyPageEnabled
            allowPoweredByRemoval={canRemoveBreezifyBranding}
            brandName={theme.brandName}
            brandLogoUrl={theme.logoUrl || null}
            brandDarkLogoUrl={theme.darkLogoUrl || null}
            brandAccentColor={theme.accentColor}
          />
        </div>
        {!sidebar ? (
          <PortalFooter
            footer={footer}
            allowPoweredByRemoval={canRemoveBreezifyBranding}
            brandName={theme.brandName}
            brandLogoUrl={theme.logoUrl || null}
            brandDarkLogoUrl={theme.darkLogoUrl || null}
            brandAccentColor={theme.accentColor}
            variant="global"
          />
        ) : null}
      </div>
    </>
  )
}

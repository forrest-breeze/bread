import { notFound } from "next/navigation"
import { cookies } from "next/headers"
import "@/styles/portal-docs.css"
import { createClient } from "@/lib/supabase/server"
import { getAuthUser } from "@/lib/auth/get-auth-user"
import { getActiveWorkspace } from "@/lib/db/workspace"
import {
  getPortalWorkspaceById,
  getPublicDocumentsFresh,
  getPublicDocumentsWithContent,
  getPublicTaxonomyFresh,
  type PublicDocWithContent,
} from "@/lib/public-kb"
import {
  getOrCreateDraft,
  getPortalVersionRow,
} from "@/lib/portal/experiences-write"
import {
  portalPagePresentation,
  validatePortalLayout,
} from "@/lib/portal/schema"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { PortalShell } from "@/components/public-kb/portal/portal-shell"
import { firstPortalDocument } from "@/lib/portal/build-default"
import { PortalDocView } from "@/components/public-kb/portal/portal-doc-view"
import { publicPortalBasePath } from "@/lib/portal/public-base-path"
import { slugSchema } from "@/lib/validation"
import { withWorkspaceLogo } from "@/lib/public-kb-route"
import { portalLanguageCookieName } from "@/lib/portal/language-preference"
import { PortalApiReferenceView } from "@/components/public-kb/portal/portal-api-reference-view"
import { PortalChangelogView } from "@/components/public-kb/portal/portal-changelog-view"
import { PortalPreviewPageReporter } from "@/components/public-kb/portal/portal-preview-page-reporter"

// ---------------------------------------------------------------------------
// /portal-preview — authenticated server render of the active project's draft,
// or (with ?version=N) of a historical published version, so the builder's
// version selector can show what restoring would put live.
//
// The preview deliberately composes the SAME PortalShell and page presentation
// as `/p/[...path]`. The only preview-specific inputs are fresh draft data,
// editor-owned theme state, draft translation authorization, and disabled
// analytics. Keeping those differences at the data/side-effect boundary means
// production markup cannot drift from a second preview implementation.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic"

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

interface PageProps {
  searchParams: Promise<{
    theme?: string
    slug?: string
    project?: string
    page?: string
    /** Document selected inside an API-reference or changelog page. */
    doc?: string
    /** Render this published/archived version instead of the draft. */
    version?: string
  }>
}

export default async function PortalPreviewPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { theme, slug, project, page, doc, version } = await searchParams
  const appearance = theme === "dark" ? "dark" : "light"
  // The builder passes `<workspace>` or `<workspace>/<project>` for links.
  const previewBase =
    slug && /^[a-z0-9-]{1,64}(\/[a-z0-9-]{1,64})?$/i.test(slug)
      ? slug
      : "preview"
  const projectSlug = slugSchema.safeParse(project).data
  const pageSlug = slugSchema.safeParse(page).data
  if (page && !pageSlug) notFound()
  // A historical version is addressed by number; anything else is a bad link.
  const previewVersion =
    version !== undefined && /^[0-9]{1,9}$/.test(version)
      ? Number.parseInt(version, 10)
      : null
  if (version !== undefined && (previewVersion === null || previewVersion < 1)) {
    notFound()
  }

  const user = await getAuthUser()
  if (!user) notFound()

  const supabase = await createClient()
  const membership = await getActiveWorkspace(supabase, user.id)
  if (!membership || !canManage(membership.role)) notFound()

  // `draft` is the layout under preview: the working draft by default, or the
  // named historical version when the builder is browsing history.
  const [workspaceResolution, entitlements, draft] = await Promise.all([
    getPortalWorkspaceById(membership.workspace_id),
    getPortalEntitlementsForWorkspace(membership.workspace_id),
    previewVersion !== null
      ? getPortalVersionRow(membership.workspace_id, previewVersion, projectSlug)
      : getOrCreateDraft(membership.workspace_id, user.id, projectSlug),
  ])
  if (workspaceResolution.kind !== "workspace") notFound()
  if (!draft) notFound()

  const validation = validatePortalLayout(draft.spec)
  if (!validation.ok) notFound()

  // Admin preview reads bypass the public 60s cache so saved content appears
  // immediately. The document renderer owns normalization and rendering.
  const [taxonomy, documents] = await Promise.all([
    getPublicTaxonomyFresh(membership.workspace_id, draft.scope),
    getPublicDocumentsFresh(membership.workspace_id, draft.scope),
  ])
  const workspace = workspaceResolution.workspace
  const draftLayout = withWorkspaceLogo(validation.data, workspace)
  if (!draftLayout) notFound()
  const navigationPages = draftLayout.pages ?? []
  const selectedPage = pageSlug
    ? navigationPages.find((candidate) => candidate.slug === pageSlug)
    : null
  if (pageSlug && !selectedPage) notFound()
  const selectedPresentation = selectedPage
    ? portalPagePresentation(selectedPage)
    : null
  const selectedPageScope = selectedPage
    ? selectedPage.scope ?? draft.scope
    : draft.scope
  let pageData = { taxonomy, documents }
  let apiReferenceData: Awaited<
    ReturnType<typeof getPublicDocumentsWithContent>
  > | null = null
  let changelogDocument: PublicDocWithContent | null = null
  if (selectedPage) {
    const [pageTaxonomy, pageDocuments] = await Promise.all([
      getPublicTaxonomyFresh(membership.workspace_id, selectedPageScope),
      selectedPresentation === "api_reference" ||
      (selectedPresentation === "changelog" && Boolean(doc))
        ? getPublicDocumentsWithContent(
            membership.workspace_id,
            selectedPageScope,
          )
        : getPublicDocumentsFresh(membership.workspace_id, selectedPageScope),
    ])
    // A custom page scope is independent from Home; null follows Home.
    pageData = { taxonomy: pageTaxonomy, documents: pageDocuments }
    if (selectedPresentation === "api_reference") {
      apiReferenceData = pageDocuments as Awaited<
        ReturnType<typeof getPublicDocumentsWithContent>
      >
    } else if (selectedPresentation === "changelog" && doc) {
      changelogDocument =
        (pageDocuments.find(
          (document) => document.id === doc || document.slug === doc,
        ) as PublicDocWithContent | undefined) ?? null
      if (!changelogDocument) notFound()
    }
  }
  const hrefBase = publicPortalBasePath(previewBase)
  const requestCookies = await cookies()

  // Page documents are separate paths publicly; inside the preview the same
  // navigation has to stay on /portal-preview, so links carry the selected
  // document as a query parameter instead of a path segment.
  const pageDocumentPreviewHref = (docSlug: string | null): string => {
    const params = new URLSearchParams({ theme: appearance, slug: previewBase })
    if (projectSlug) params.set("project", projectSlug)
    if (pageSlug) params.set("page", pageSlug)
    if (docSlug) params.set("doc", docSlug)
    if (previewVersion !== null) params.set("version", String(previewVersion))
    return `/portal-preview?${params.toString()}`
  }

  const firstDocument = firstPortalDocument(pageData.taxonomy, pageData.documents)
  const content =
    selectedPage && selectedPresentation === "api_reference" ? (
      <PortalApiReferenceView
        workspace={workspace}
        base={previewBase}
        hrefBase={hrefBase}
        page={selectedPage}
        publishedLayout={draftLayout}
        taxonomy={pageData.taxonomy}
        documents={apiReferenceData ?? []}
        activeDocRef={doc ?? null}
        endpointHref={pageDocumentPreviewHref}
        canRemoveBreadBranding={entitlements.portalBrandingRemoval}
        preview
      />
    ) : selectedPage && selectedPresentation === "changelog" ? (
      <PortalChangelogView
        workspace={workspace}
        base={previewBase}
        hrefBase={hrefBase}
        page={selectedPage}
        publishedLayout={draftLayout}
        taxonomy={pageData.taxonomy}
        documents={pageData.documents}
        activeDocument={changelogDocument ?? undefined}
        entryHref={pageDocumentPreviewHref}
        canRemoveBreadBranding={entitlements.portalBrandingRemoval}
        preview
      />
    ) : firstDocument ? (
      <PortalDocView
        workspace={workspace}
        base={previewBase}
        hrefBase={hrefBase}
        scope={selectedPageScope}
        publishedLayout={draftLayout}
        refId={doc ?? firstDocument.slug ?? firstDocument.id}
        previewData={pageData}
        canRemoveBreadBranding={entitlements.portalBrandingRemoval}
        preview
      />
    ) : (
      <p className="p-8 text-muted-foreground">No published documents yet.</p>
    )

  return (
    <PortalShell
      workspace={workspace}
      published={draftLayout}
      base={previewBase}
      hrefBase={hrefBase}
      askAiEnabled={entitlements.portalAiBuilder}
      canRemoveBreadBranding={entitlements.portalBrandingRemoval}
      translationsEnabled={entitlements.portalTranslations}
      navigationPages={navigationPages}
      preferredLanguage={
        requestCookies.get(portalLanguageCookieName(previewBase, true))?.value ??
        null
      }
      preview={{
        themeMode: appearance,
        projectSlug: projectSlug ?? null,
        activePageSlug: selectedPage?.slug ?? null,
        activePageDocRef:
          selectedPresentation === "changelog" ? (doc ?? null) : null,
      }}
    >
      {/* Keeps the builder's page switcher in sync when the visitor navigates
          the preview's own page nav instead of the editor's controls. */}
      <PortalPreviewPageReporter pageSlug={selectedPage?.slug ?? null} />
      {content}
    </PortalShell>
  )
}

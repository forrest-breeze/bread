import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import {
  getPublicDocument,
  getPublicDocuments,
  getPublicDocumentsWithContent,
  getPublicTaxonomy,
  isDocInScope,
  type PublicDocument,
} from "@/lib/public-kb"
import { requirePortal } from "@/lib/public-kb-route"
import {
  getPortalEntitlementsForWorkspace,
} from "@/lib/db/subscription"
import { portalPublicNextPath } from "@/lib/portal/login-return"
import { parsePortalPath } from "@/lib/portal/portal-path"
import { PortalDocView, DOC_REF_RE } from "@/components/public-kb/portal/portal-doc-view"
import { publicPortalBasePath, publicPortalHref } from "@/lib/portal/public-base-path"
import { makeDocumentPreview } from "@/lib/document-preview"
import { portalLlmsFilename } from "@/lib/portal/llms-txt-request"
import { portalCanonicalPageUrl } from "@/lib/portal/canonical-url"
import { resolvePortalCanonicalBaseUrl } from "@/lib/portal/canonical-url.server"
import { firstPortalDocument } from "@/lib/portal/build-default"
import { portalPagePresentation } from "@/lib/portal/schema"
import { sortApiReferenceDocuments } from "@/lib/portal/api-reference-model"
import { PortalChangelogView } from "@/components/public-kb/portal/portal-changelog-view"
import { PortalApiReferenceView } from "@/components/public-kb/portal/portal-api-reference-view"

// Reads search params + request headers and rate-limits search — never static.
export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ path: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function baseFromParsed(workspaceSlug: string, projectSlug: string | null): string {
  return projectSlug ? `${workspaceSlug}/${projectSlug}` : workspaceSlug
}

function metadataImageUrl(
  value: string | null | undefined,
  websiteUrl: string | null | undefined,
  canonicalBase: string,
): string | null {
  if (!value) return null
  try {
    return new URL(value, websiteUrl || `${canonicalBase}/`).toString()
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { path } = await params
  const parsed = parsePortalPath(path)
  if (!parsed) return {}

  const portal = await requirePortal(
    parsed.workspaceSlug,
    parsed.projectSlug,
    await portalPublicNextPath(
      parsed.workspaceSlug,
      parsed.projectSlug,
      `/p/${path.join("/")}`,
    ),
  )
  const requestHeaders = await headers()
  const canonicalBase = portal.workspace.isPublic
    ? await resolvePortalCanonicalBaseUrl({
        headers: requestHeaders,
        workspace: portal.workspace,
        internalBase: portal.base,
        projectSlug: portal.addressProjectSlug,
      })
    : ""
  const canonical = portalCanonicalPageUrl(
    canonicalBase,
    parsed.view,
    parsed.refId,
  )
  const alternates = {
    canonical,
    types: {
      "text/plain": [
        {
          url: `${canonicalBase}/${portalLlmsFilename("index")}`,
          title: "llms.txt",
        },
      ],
    },
  }

  if (parsed.view === "page") {
    const page = portal.layout?.pages?.find(
      (candidate) => candidate.slug === parsed.refId,
    )
    if (!page) return {}
    if (!parsed.pageDocRef) return {
      title: { absolute: page.title },
      ...(portal.workspace.isPublic ? { alternates } : {}),
    }

    // One endpoint of a reference page. The PAGE's scope decides what that page
    // serves — the same rule the renderer applies — so a reference page works
    // whether or not the project's home scope covers its folders.
    const doc = await getPublicDocument(portal.workspace.id, parsed.pageDocRef)
    if (!doc) return {}
    const docRef = { id: doc.id, folder_id: doc.folder_id }
    const inPage = await isDocInScope(
      portal.workspace.id,
      docRef,
      page.scope ?? portal.scope ?? null,
    )
    if (!inPage) return {}
    const title = { absolute: doc.title || page.title }
    if (!portal.workspace.isPublic) return { title }
    const description = makeDocumentPreview(doc.content, 180)
    return {
      title,
      ...(description ? { description } : {}),
      alternates: {
        ...alternates,
        canonical: portalCanonicalPageUrl(
          canonicalBase,
          "page",
          `${page.slug}/${doc.slug}`,
        ),
      },
    }
  }

  // Home titles and descriptions come from the portal layout; the page adds
  // its stable public canonical while preserving the llms.txt alternate.
  if (parsed.view === "home") return portal.workspace.isPublic ? { alternates } : {}

  const refId = parsed.refId ?? ""

  if (parsed.view === "doc") {
    if (!DOC_REF_RE.test(refId)) return {}
    const doc = await getPublicDocument(portal.workspace.id, refId)
    if (!doc) return {}
    const docRef = { id: doc.id, folder_id: doc.folder_id }
    if (
      !(await isDocInScope(
        portal.workspace.id,
        docRef,
        portal.contentScope ?? null,
      ))
    ) {
      return {}
    }
    const title = doc.title || "Untitled"
    if (!portal.workspace.isPublic) return { title: { absolute: title } }
    const description =
      makeDocumentPreview(doc.content, 180) ||
      `${title} from ${portal.workspace.branding.name}`
    // Always canonicalize UUID aliases to the stored public slug.
    const documentCanonical = portalCanonicalPageUrl(
      canonicalBase,
      "doc",
      doc.slug,
    )
    const coverUrl = metadataImageUrl(
      doc.cover?.url,
      portal.workspace.websiteUrl,
      canonicalBase,
    )
    const images = coverUrl
      ? [{ url: coverUrl, alt: doc.cover?.alt || title }]
      : undefined

    return {
      title: { absolute: title },
      description,
      alternates: { ...alternates, canonical: documentCanonical },
      openGraph: {
        type: "article",
        title,
        description,
        url: documentCanonical,
        modifiedTime: doc.updated_at,
        ...(doc.author ? { authors: [doc.author] } : {}),
        ...(images ? { images } : {}),
      },
      twitter: {
        card: coverUrl ? "summary_large_image" : "summary",
        title,
        description,
        ...(coverUrl ? { images: [coverUrl] } : {}),
      },
    }
  }

  return {}
}

export default async function PortalCatchAllPage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { path } = await params
  const parsed = parsePortalPath(path)
  if (!parsed) notFound()

  const sp = await searchParams
  const rawQuery = typeof sp.q === "string" ? sp.q : ""
  const query = rawQuery.trim()
  const requestHeaders = await headers()
  const parsedBase = baseFromParsed(parsed.workspaceSlug, parsed.projectSlug)
  const requestedHrefBase = publicPortalBasePath(
    parsedBase,
    requestHeaders.get("x-bread-base-path"),
  )

  // Login-return target: the clean public URL on a validated custom-domain
  // mount, else the internal path — so a private portal's sign-in round-trip
  // lands back where the visitor actually was.
  const publicNext = await portalPublicNextPath(
    parsed.workspaceSlug,
    parsed.projectSlug,
    `/p/${path.join("/")}`,
  )
  const nextPath =
    parsed.view === "home" && query
      ? `${publicNext}?q=${encodeURIComponent(query)}`
      : publicNext

  const {
    workspace,
    base,
    scope,
    contentScope,
    layout,
    rootRedirectSlug,
  } = await requirePortal(parsed.workspaceSlug, parsed.projectSlug, nextPath)

  // The bare workspace root hosts no project of its own — send visitors to the
  // configured primary project's canonical URL instead of rendering it inline.
  // Scoped to the home view so deep links (doc/folder) still resolve at the root.
  if (parsed.view === "home" && rootRedirectSlug) {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : ""
    redirect(
      requestHeaders.get("x-bread-base-path")
        ? publicPortalHref(requestedHrefBase, suffix)
        : `/p/${parsed.workspaceSlug}/${rootRedirectSlug}${suffix}`,
    )
  }
  const hrefBase = publicPortalBasePath(
    base,
    requestHeaders.get("x-bread-base-path"),
  )
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.id)

  if (parsed.view === "doc") {
    return (
      <PortalDocView
        workspace={workspace}
        base={base}
        hrefBase={hrefBase}
        scope={contentScope}
        navScope={scope}
        publishedLayout={layout}
        refId={parsed.refId ?? ""}
        canRemoveBreadBranding={entitlements.portalBrandingRemoval}
      />
    )
  }
  if (parsed.view === "page") {
    const portalPage = layout?.pages?.find(
      (candidate) => candidate.slug === parsed.refId,
    )
    if (!portalPage) notFound()
    const presentation = portalPagePresentation(portalPage)
    // A custom page scope is independent of Home; null deliberately inherits
    // Home so existing pages continue to follow project-level content changes.
    const pageScope = portalPage.scope ?? scope
    const pageTaxonomy = await getPublicTaxonomy(workspace.id, pageScope)
    if (presentation === "api_reference") {
      const pageData = {
        taxonomy: pageTaxonomy,
        documents: await getPublicDocumentsWithContent(
          workspace.id,
          pageScope,
        ),
      }
      // Each endpoint has exactly one URL: the first one is the reference root,
      // the rest hang off it. A request for the first endpoint's sub-path is
      // redirected up so the two never serve the same content.
      if (parsed.pageDocRef) {
        const ordered = sortApiReferenceDocuments(
          pageData.documents,
          pageData.taxonomy,
        )
        const target = ordered.find(
          (doc) =>
            doc.slug === parsed.pageDocRef || doc.id === parsed.pageDocRef,
        )
        if (!target) notFound()
        if (ordered[0]?.id === target.id) {
          redirect(publicPortalHref(hrefBase, `/page/${portalPage.slug}`))
        }
      }
      return (
        <PortalApiReferenceView
          workspace={workspace}
          base={base}
          hrefBase={hrefBase}
          page={portalPage}
          publishedLayout={layout}
          taxonomy={pageData.taxonomy}
          documents={pageData.documents}
          activeDocRef={parsed.pageDocRef}
          canRemoveBreadBranding={entitlements.portalBrandingRemoval}
        />
      )
    }
    if (presentation === "changelog") {
      const pageDocuments = await getPublicDocuments(
        workspace.id,
        pageScope,
      )
      let activeDocument: PublicDocument | undefined
      if (parsed.pageDocRef) {
        if (!DOC_REF_RE.test(parsed.pageDocRef)) notFound()
        const resolvedDocument = await getPublicDocument(
          workspace.id,
          parsed.pageDocRef,
        )
        if (
          !resolvedDocument ||
          !(await isDocInScope(
            workspace.id,
            {
              id: resolvedDocument.id,
              folder_id: resolvedDocument.folder_id,
            },
            pageScope,
          ))
        ) {
          notFound()
        }
        activeDocument = resolvedDocument
      }
      return (
        <PortalChangelogView
          workspace={workspace}
          base={base}
          hrefBase={hrefBase}
          page={portalPage}
          publishedLayout={layout}
          taxonomy={pageTaxonomy}
          documents={pageDocuments}
          activeDocument={activeDocument}
          canRemoveBreadBranding={entitlements.portalBrandingRemoval}
        />
      )
    }
    if (parsed.pageDocRef) notFound()
    const documents = await getPublicDocuments(workspace.id, pageScope)
    const first = firstPortalDocument(pageTaxonomy, documents)
    if (!first) return <p className="p-8 text-muted-foreground">No published documents yet.</p>
    redirect(publicPortalHref(hrefBase, `/doc/${first.slug || first.id}`))
  }
  const documents = await getPublicDocuments(workspace.id, scope)
  const taxonomy = await getPublicTaxonomy(workspace.id, scope)
  const first = firstPortalDocument(taxonomy, documents)
  if (!first) return <p className="p-8 text-muted-foreground">No published documents yet.</p>
  redirect(publicPortalHref(hrefBase, `/doc/${first.slug || first.id}`))
}

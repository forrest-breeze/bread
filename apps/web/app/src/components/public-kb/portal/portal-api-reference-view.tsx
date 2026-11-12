import type {
  PublicDocWithContent,
  PublicTaxonomy,
  PublicWorkspace,
} from "@/lib/public-kb"
import { renderApiReferenceHtmlCached } from "@/lib/public-kb-render-cache"
import {
  buildDefaultFooter,
  buildPortalTheme,
  footerForLayoutChrome,
  resolvePortalLayout,
} from "@/lib/portal/build-default"
import {
  buildApiReferenceSections,
  findApiReferenceSection,
} from "@/lib/portal/api-reference-model"
import type { PortalLayout, PortalPage } from "@/lib/portal/schema"
import {
  publicPortalHref,
  withPublicPortalBase,
} from "@/lib/portal/public-base-path"
import { PortalViewBeacon } from "./portal-view-beacon"
import { PortalApiReferenceContent } from "./portal-api-reference-content"

interface PortalApiReferenceViewProps {
  workspace: PublicWorkspace
  base: string
  hrefBase: string
  page: PortalPage
  publishedLayout: PortalLayout | null
  taxonomy: PublicTaxonomy
  documents: PublicDocWithContent[]
  canRemoveBreadBranding: boolean
  /**
   * Endpoint addressed by the URL (public slug or id). null renders the first
   * endpoint — what the reference's own root URL serves. Callers resolve
   * unknown refs to a 404 before rendering.
   */
  activeDocRef?: string | null
  /**
   * Link builder for one endpoint; `null` means the reference's root URL, which
   * is where the first endpoint lives. Defaults to the public page sub-path —
   * the builder preview passes its own preview-route builder instead.
   */
  endpointHref?: (docSlug: string | null) => string
  preview?: boolean
}

export async function PortalApiReferenceView({
  workspace,
  base,
  hrefBase,
  page,
  publishedLayout,
  taxonomy,
  documents,
  canRemoveBreadBranding,
  activeDocRef = null,
  endpointHref,
  preview = false,
}: PortalApiReferenceViewProps): Promise<React.ReactElement> {
  const resolvedLayout = withPublicPortalBase(
    resolvePortalLayout({
      slug: base,
      workspace,
      taxonomy,
      rootDocs: documents,
      publishedLayout,
    }),
    base,
    hrefBase,
  )
  const theme =
    resolvedLayout.theme ??
    publishedLayout?.theme ??
    buildPortalTheme(workspace)
  const footer =
    resolvedLayout.footer ??
    footerForLayoutChrome(
      publishedLayout,
      workspace.footer,
      workspace.portalChromeScope,
    ) ??
    buildDefaultFooter(workspace)
  // Only the active endpoint's body is shown, so only it is rendered: the
  // navigation needs titles/methods, and highlighting every endpoint's code on
  // each request made large references slow.
  const sections = buildApiReferenceSections(documents, taxonomy, () => "")
  // The first endpoint IS the reference root, so it links to the page itself
  // rather than to a second URL for the same content.
  const hrefFor = (docSlug: string | null): string =>
    endpointHref
      ? endpointHref(docSlug)
      : publicPortalHref(
          hrefBase,
          docSlug
            ? `/page/${page.slug}/${docSlug}`
            : `/page/${page.slug}`,
        )
  const items = sections.map((section, index) => ({
    id: section.id,
    slug: section.slug,
    title: section.title,
    groupLabel: section.groupLabel,
    method: section.method,
    path: section.path,
    href: hrefFor(index === 0 ? null : section.slug),
  }))
  const activeMeta = findApiReferenceSection(sections, activeDocRef)
  const activeDocument = documents.find((document) => document.id === activeMeta?.id)
  const updatedAt = activeDocument?.updated_at
  const updated = theme.showLastUpdated !== false && updatedAt && !Number.isNaN(new Date(updatedAt).getTime())
    ? new Date(updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : ""
  const activeContent = activeMeta
    ? documents.find((document) => document.id === activeMeta.id)?.content
    : undefined
  const activeSection = activeMeta
    ? {
        ...activeMeta,
        ...(await renderApiReferenceHtmlCached(activeContent ?? "", {
          memoryOnly: preview,
        })),
      }
    : null

  return (
    <>
      {preview ? null : <PortalViewBeacon slug={base} type="pageview" />}
      <PortalApiReferenceContent
        title={page.title}
        brandName={theme.brandName}
        items={items}
        active={activeSection}
        disablePrefetch={preview}
        editable={preview}
        updated={updated}
        footer={footer}
        allowPoweredByRemoval={canRemoveBreadBranding}
        brandLogoUrl={theme.logoUrl || null}
        brandDarkLogoUrl={theme.darkLogoUrl || null}
        brandAccentColor={theme.accentColor}
      />
    </>
  )
}

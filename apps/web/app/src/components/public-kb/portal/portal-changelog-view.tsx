import type {
  PublicDocSummary,
  PublicTaxonomy,
  PublicWorkspace,
} from "@/lib/public-kb"
import { renderPublicHtmlCached } from "@/lib/public-kb-render-cache"
import {
  buildChangelogLayout,
  buildDefaultFooter,
  buildPortalTheme,
  footerForLayoutChrome,
  resolvePortalLayout,
} from "@/lib/portal/build-default"
import type { PortalLayout, PortalPage } from "@/lib/portal/schema"
import { portalDefaultPage } from "@/lib/portal/schema"
import {
  publicPortalHref,
  withPublicPortalBase,
  withPublicPortalHtml,
} from "@/lib/portal/public-base-path"
import { changelogNeighbors } from "@/lib/portal/changelog-entry"
import { PortalFooter } from "./portal-footer"
import { PortalRenderer } from "./portal-renderer"
import { PortalViewBeacon } from "./portal-view-beacon"
import { PortalChangelogEntry } from "./portal-changelog-entry"

// A project page rendered as a dated release feed (the "changelog" page
// presentation), scoped to the page's included docs. The project's stored body
// is deliberately ignored (as with the API-reference presentation); only its
// chrome — theme and footer — carries over so the page still reads as part of
// the same portal. Rail-less: the month-grouped feed is the navigation.
interface PortalChangelogViewProps {
  workspace: PublicWorkspace
  base: string
  hrefBase: string
  page: PortalPage
  publishedLayout: PortalLayout | null
  taxonomy: PublicTaxonomy
  documents: PublicDocSummary[]
  /** The selected release, when rendering `/page/<slug>/<document>`. */
  activeDocument?: PublicDocSummary & { content: string }
  /**
   * Preview routes encode the selected release in a query parameter. Public
   * routes omit this and use the canonical page-local path.
   */
  entryHref?: (documentSlug: string | null) => string
  canRemoveBreezifyBranding: boolean
  preview?: boolean
}

export async function PortalChangelogView({
  workspace,
  base,
  hrefBase,
  page,
  publishedLayout,
  taxonomy,
  documents,
  activeDocument,
  entryHref,
  canRemoveBreezifyBranding,
  preview = false,
}: PortalChangelogViewProps): Promise<React.ReactElement> {
  const hrefForEntry =
    entryHref ??
    ((documentSlug: string | null): string =>
      // The default page's feed lives at the portal root.
      !documentSlug && portalDefaultPage(publishedLayout)?.id === page.id
        ? hrefBase
        : publicPortalHref(
            hrefBase,
            `/page/${page.slug}${documentSlug ? `/${documentSlug}` : ""}`,
          ))
  const projectLayout = resolvePortalLayout({
    slug: base,
    workspace,
    taxonomy,
    rootDocs: documents,
    publishedLayout,
  })
  const theme =
    projectLayout.theme ?? publishedLayout?.theme ?? buildPortalTheme(workspace)
  const footer =
    projectLayout.footer ??
    footerForLayoutChrome(
      publishedLayout,
      workspace.footer,
      workspace.portalChromeScope,
    ) ??
    buildDefaultFooter(workspace)
  const layout = withPublicPortalBase(
    {
      ...buildChangelogLayout({
        slug: base,
        workspace,
        taxonomy,
        rootDocs: documents,
        entryHref: (document) =>
          hrefForEntry(document.slug ?? document.id),
        heading: page.title,
      }),
      theme,
      footer,
    },
    base,
    hrefBase,
  )

  return (
    <div className="flex min-h-[calc(100vh-4rem)] w-full flex-col justify-between">
      <div className="flex-1">
        {preview ? null : activeDocument ? (
          <PortalViewBeacon
            slug={base}
            type="doc_view"
            documentId={activeDocument.id}
          />
        ) : (
          <PortalViewBeacon slug={base} type="pageview" />
        )}
        {activeDocument ? (
          <PortalChangelogEntry
            documentId={activeDocument.id}
            title={activeDocument.title}
            html={withPublicPortalHtml(
              await renderPublicHtmlCached(activeDocument.content, {
                memoryOnly: preview,
              }),
              base,
              hrefBase,
            )}
            date={activeDocument.updated_at}
            feedHref={hrefForEntry(null)}
            feedLabel={page.title}
            neighbors={changelogNeighbors(
              documents,
              activeDocument.id,
              (document) => hrefForEntry(document.slug ?? document.id),
            )}
          />
        ) : (
          <div className="min-w-0 px-6 py-14 sm:px-10 lg:px-16 lg:py-24">
            <div className="mx-auto max-w-[1180px]">
              <PortalRenderer
                slug={base}
                hrefBase={hrefBase}
                layout={layout}
                variant="default"
              />
            </div>
          </div>
        )}
      </div>
      <PortalFooter
        footer={layout.footer ?? buildDefaultFooter(workspace)}
        allowPoweredByRemoval={canRemoveBreezifyBranding}
        brandName={layout.theme.brandName}
        brandLogoUrl={layout.theme.logoUrl || null}
        brandDarkLogoUrl={layout.theme.darkLogoUrl || null}
        brandAccentColor={layout.theme.accentColor}
        variant="global"
      />
    </div>
  )
}

"use client"

import { useRef } from "react"
import { useDocumentHeadings } from "@/hooks/use-document-headings"
import { KbBreadcrumbs, type KbBreadcrumbItem } from "@/components/kb/kb-breadcrumbs"
import { KbReadingToc } from "@/components/kb/kb-reading-toc"
import { KbCrossLinks } from "@/components/kb/kb-cross-links"
import { PublicProse } from "@/components/public-kb/public-prose"
import { SidebarNav } from "@/components/public-kb/portal/sidebar-nav"
import { PortalSidebarRail } from "@/components/public-kb/portal/portal-sidebar-rail"
import { PortalPageFeedback } from "@/components/public-kb/portal/portal-page-feedback"
import { PortalCopyPageButton } from "@/components/public-kb/portal/portal-copy-page-button"
import { PortalEditDocumentButton } from "@/components/public-kb/portal/portal-edit-document-button"
import { PortalDocPager, type DocPagerLinks } from "@/components/public-kb/portal/portal-doc-pager"
import { PortalDocumentScrollReset } from "@/components/public-kb/portal/portal-document-scroll-reset"
import { PortalFooter } from "@/components/public-kb/portal/portal-footer"
import type { FooterBlock, SidebarBlock } from "@/lib/portal/schema"
import type { DocumentLinkEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { publicPortalHref } from "@/lib/portal/public-base-path"

interface PublicKbDocumentProps {
  slug: string
  hrefBase?: string
  /** The document's id — used to attribute "was this helpful?" feedback. */
  documentId: string
  title: string
  /** Pre-sanitized HTML body (server-rendered via renderPublicHtml). */
  html: string
  source: string | null
  author: string | null
  /** Pre-formatted "updated" date string ("" to hide). */
  updated: string
  breadcrumbs: KbBreadcrumbItem[]
  outbound: DocumentLinkEntry[]
  inbound: DocumentLinkEntry[]
  sidebar?: SidebarBlock
  /** Previous/next reading order (docs template only); omit to hide the pager. */
  pager?: DocPagerLinks
  /** Sidebar layouts render this footer inside the main grid column. */
  footer?: FooterBlock
  /**
   * Shows the "Copy page" action beside the title. Off by default so surfaces
   * that opt in (docs and help-center articles) decide, not this component.
   */
  editable?: boolean
  copyPageEnabled?: boolean
  allowPoweredByRemoval?: boolean
  brandName?: string
  brandLogoUrl?: string | null
  brandDarkLogoUrl?: string | null
  brandAccentColor?: string
}

/**
 * Public document reader. Receives fully-resolved, pre-sanitized data as props
 * (fetched + sanitized in the server page) and adds only the client reading
 * affordances: a synced table-of-contents and KaTeX math.
 */
export function PublicKbDocument({
  slug,
  hrefBase,
  documentId,
  title,
  html,
  updated,
  breadcrumbs,
  outbound,
  inbound,
  sidebar,
  pager,
  footer,
  editable = false,
  copyPageEnabled = false,
  allowPoweredByRemoval = false,
  brandName,
  brandLogoUrl,
  brandDarkLogoUrl,
  brandAccentColor,
}: PublicKbDocumentProps): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null)
  const { headings, activeId } = useDocumentHeadings(contentRef, html)
  const hasConnections = outbound.length > 0 || inbound.length > 0
  const publicBase = hrefBase ?? `/p/${slug}`

  // KbCrossLinks hands us the linked document's id; map it back to the
  // human-readable public_slug (falling back to the id) so cross-links use
  // readable URLs too.
  const slugById = new Map<string, string>()
  for (const entry of [...outbound, ...inbound]) {
    slugById.set(entry.id, entry.slug ?? entry.id)
  }

  const article = (
    <article
      className={cn(
        // Widths are the reading measure — `.portal-docs-prose` sets no cap of
        // its own. The rail layout's value is inclusive of the article padding;
        // the rail-less one sits inside the padded grid below.
        sidebar
          ? "mx-auto w-full max-w-[880px] px-6 py-12 sm:px-10 lg:px-10 lg:py-14"
          : "mx-auto w-full min-w-0 max-w-[52rem]",
      )}
    >
      <PortalDocumentScrollReset documentId={documentId} />
      <KbBreadcrumbs items={breadcrumbs} className="mb-5" />

      <header className="mb-8 border-b border-border/70 pb-6">
        <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
          <div className="min-w-0">
            <h1
              className={cn(
                "break-words font-semibold tracking-normal text-foreground",
                sidebar ? "text-[34px] leading-[1.1]" : "text-3xl tracking-tight",
              )}
            >
              {title || "Untitled"}
            </h1>
            {updated && (
              <p className="mt-3 text-xs text-muted-foreground">
                Updated {updated}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editable ? <PortalEditDocumentButton documentRef={documentId} /> : null}
            {/* The title lives outside the prose container, so it is passed
                separately — a copied page should start with its own name. */}
            {copyPageEnabled && (
              <PortalCopyPageButton targetRef={contentRef} heading={title} />
            )}
          </div>
        </div>
      </header>

      <PublicProse ref={contentRef} html={html} />

      {hasConnections && (
        <section className="mt-12 border-t border-border/70 pt-6">
          <KbCrossLinks
            outbound={outbound}
            inbound={inbound}
            hrefForDoc={(id) =>
              publicPortalHref(publicBase, `/doc/${slugById.get(id) ?? id}`)
            }
          />
        </section>
      )}

      <div className="mt-14 space-y-10 border-t border-border/70 pt-8">
        <PortalPageFeedback slug={slug} documentId={documentId} />
        {pager && <PortalDocPager prev={pager.prev} next={pager.next} />}
      </div>

      {sidebar && (
        <details className="mt-10 overflow-hidden rounded-lg border border-border bg-card lg:hidden">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
            Browse all sections
          </summary>
          <div className="border-t border-border/70 px-4 py-4">
            <SidebarNav block={sidebar} variant="docs" activeDocumentId={documentId} />
          </div>
        </details>
      )}
    </article>
  )

  if (sidebar) {
    return (
      <div className="min-h-[calc(100vh-4rem)] w-full lg:grid lg:grid-cols-[272px_minmax(0,1fr)] lg:grid-rows-[1fr_auto] xl:grid-cols-[272px_minmax(0,1fr)_232px]">
        <PortalSidebarRail>
          <SidebarNav block={sidebar} variant="docs" activeDocumentId={documentId} />
        </PortalSidebarRail>

        {article}

        <PortalSidebarRail variant="toc">
          <KbReadingToc
            headings={headings}
            activeId={activeId}
            containerRef={contentRef}
            variant="docs"
          />
        </PortalSidebarRail>

        {footer ? (
          <div className="lg:col-start-2">
            <PortalFooter
              footer={footer}
              allowPoweredByRemoval={allowPoweredByRemoval}
              brandName={brandName}
              brandLogoUrl={brandLogoUrl}
              brandDarkLogoUrl={brandDarkLogoUrl}
              brandAccentColor={brandAccentColor}
              variant="global"
            />
          </div>
        ) : null}
      </div>
    )
  }

  // Symmetric side columns keep the article visually centered whether or not
  // the reading ToC has anything to show (short docs render an empty aside).
  return (
    <div className="mx-auto w-full max-w-[84rem] px-6 py-10 sm:px-8 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,52rem)_minmax(0,1fr)] xl:gap-12">
      <div aria-hidden className="hidden xl:block" />

      {article}

      <PortalSidebarRail variant="toc" className="border-l-0 px-0 py-0 xl:row-span-1">
        <KbReadingToc headings={headings} activeId={activeId} containerRef={contentRef} />
      </PortalSidebarRail>
    </div>
  )
}

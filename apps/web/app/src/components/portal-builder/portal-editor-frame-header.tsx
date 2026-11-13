"use client"

import { PortalHeader } from "@/components/public-kb/portal/portal-header"
import { SidebarNav } from "@/components/public-kb/portal/sidebar-nav"
import { portalThemeCssVars } from "@/lib/portal/theme-vars"
import {
  resolvePortalNavRoute,
  type PortalLayout,
} from "@/lib/portal/schema"
import { cn } from "@/lib/utils"
import {
  portalDocRefFromHref,
  type PreviewAppearance,
} from "./portal-live-preview"

// ---------------------------------------------------------------------------
// The draft portal's chrome (header + nav rail), drawn around a document
// editor inside the builder's preview frame so editing happens *in* the
// portal. Everything in it is live, but portal URLs never take the builder
// to the public portal: they map onto the builder's own views instead.
// ---------------------------------------------------------------------------

export interface FrameNavigation {
  /** Open a document (by public slug or id) in the editor. */
  onOpenDocument: (ref: string) => void
  /** Show a portal page in the live preview; null is the portal home. */
  onOpenPage: (pageSlug: string | null) => void
}

/**
 * Where a portal URL clicked inside the frame goes: a doc opens in the
 * editor, a page (or home) opens in the preview, and anything off-site opens
 * in a new tab.
 */
export function navigateFromFrame(
  href: string,
  nav: FrameNavigation,
  /** Resolves the root and /page/home against the portal's page order. */
  layout?: Pick<PortalLayout, "pages" | "homePosition">,
): void {
  const origin = window.location.origin
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return
  }
  if (url.origin !== origin) {
    window.open(url.toString(), "_blank", "noopener,noreferrer")
    return
  }
  const docRef = portalDocRefFromHref(url.toString(), origin)
  if (docRef) {
    nav.onOpenDocument(docRef)
    return
  }
  if (url.pathname === "/portal-preview") {
    nav.onOpenPage(url.searchParams.get("page"))
    return
  }
  const page = /\/page\/([^/]+)\/?$/.exec(url.pathname)
  const route = page
    ? resolvePortalNavRoute(layout, "page", decodeURIComponent(page[1]))
    : resolvePortalNavRoute(layout, "home")
  nav.onOpenPage(
    route?.kind === "page"
      ? route.page.slug
      : route?.kind === "home"
        ? null
        : // Unknown page: keep the old behavior and let the preview decide.
          page
          ? decodeURIComponent(page[1])
          : null,
  )
}

/** Click-capture handler shared by the frame's header and nav rail. */
function interceptPortalLinks(
  nav: FrameNavigation,
  layout: Pick<PortalLayout, "pages" | "homePosition">,
): React.MouseEventHandler<HTMLElement> {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return
    const anchor = (event.target as Element).closest?.("a[href]")
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    navigateFromFrame(anchor.getAttribute("href") ?? "", nav, layout)
  }
}

export function PortalEditorFrameHeader({
  layout,
  previewSlug,
  appearance,
  onAppearanceChange,
  onOpenDocument,
  onOpenPage,
}: {
  layout: PortalLayout
  previewSlug: string
  appearance: PreviewAppearance
  onAppearanceChange: (appearance: PreviewAppearance) => void
} & FrameNavigation): React.ReactElement {
  const nav = { onOpenDocument, onOpenPage }
  return (
    <div
      data-testid="portal-editor-frame-header"
      onClickCapture={interceptPortalLinks(nav, layout)}
      className={cn("shrink-0 bg-background text-foreground", appearance)}
      style={portalThemeCssVars(layout.theme)}
    >
      <PortalHeader
        slug={previewSlug}
        theme={layout.theme}
        header={layout.header}
        pages={layout.pages ?? []}
        homePosition={layout.homePosition}
        themeControl={{ mode: appearance, onChange: onAppearanceChange }}
        onNavigate={(href) => navigateFromFrame(href, nav)}
      />
    </div>
  )
}

/** The portal's nav rail beside the editor; null when the portal has none. */
export function PortalEditorFrameSidebar({
  layout,
  appearance,
  activeDocumentId,
  onHoverDocument,
  onOpenDocument,
  onOpenPage,
}: {
  layout: PortalLayout
  appearance: PreviewAppearance
  /** The document open in the editor; its rail entry is highlighted. */
  activeDocumentId?: string
  /** A document link (public slug or id) is under the pointer: warm it. */
  onHoverDocument?: (ref: string) => void
} & FrameNavigation): React.ReactElement | null {
  if (!layout.sidebar) return null
  return (
    <nav
      aria-label="Portal navigation"
      data-testid="portal-editor-frame-sidebar"
      onClickCapture={interceptPortalLinks({ onOpenDocument, onOpenPage }, layout)}
      onMouseOver={
        onHoverDocument
          ? (event) => {
              const anchor = (event.target as Element).closest?.("a[href]")
              const ref = anchor
                ? portalDocRefFromHref(
                    anchor.getAttribute("href") ?? "",
                    window.location.origin,
                  )
                : null
              if (ref) onHoverDocument(ref)
            }
          : undefined
      }
      className={cn(
        "hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-background px-4 py-6 text-foreground md:block",
        appearance,
      )}
      style={portalThemeCssVars(layout.theme)}
    >
      <SidebarNav
        block={layout.sidebar}
        variant="docs"
        activeDocumentId={activeDocumentId}
        prefetch={false}
      />
    </nav>
  )
}

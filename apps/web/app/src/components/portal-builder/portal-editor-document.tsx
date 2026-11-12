"use client"

import { useRef } from "react"
import { KbReadingToc } from "@/components/kb/kb-reading-toc"
import { PortalFooter } from "@/components/public-kb/portal/portal-footer"
import { useDocumentHeadings } from "@/hooks/use-document-headings"
import type { PortalLayout } from "@/lib/portal/schema"
import { portalThemeCssVars } from "@/lib/portal/theme-vars"
import { cn } from "@/lib/utils"

/** Reading chrome retained when a preview document opens for editing. */
export function PortalEditorDocument({
  children,
  layout,
  appearance,
  mobile,
  allowPoweredByRemoval,
}: {
  children: React.ReactNode
  layout: PortalLayout
  appearance: "light" | "dark"
  mobile: boolean
  allowPoweredByRemoval: boolean
}): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null)
  const { headings, activeId } = useDocumentHeadings(contentRef, "")

  return (
    <div
      className={cn("flex min-h-full bg-background text-foreground", appearance)}
      style={portalThemeCssVars(layout.theme)}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Let the document and footer share the preview's scroll container. */}
        <div ref={contentRef} className="flex-1 [&>div]:h-auto">
          {children}
        </div>
        <PortalFooter
          footer={layout.footer ?? { id: "footer", type: "footer", showPoweredBy: true }}
          allowPoweredByRemoval={allowPoweredByRemoval}
          brandName={layout.theme.brandName}
          brandLogoUrl={layout.theme.logoUrl}
          brandDarkLogoUrl={layout.theme.darkLogoUrl}
          brandAccentColor={layout.theme.accentColor}
        />
      </div>
      {!mobile && headings.length > 0 ? (
        <aside className="w-44 shrink-0 border-l border-border/70 px-4 py-10">
          <div className="sticky top-6 max-h-[70vh] overflow-y-auto">
            <KbReadingToc
              headings={headings}
              activeId={activeId}
              containerRef={contentRef}
              variant="docs"
            />
          </div>
        </aside>
      ) : null}
    </div>
  )
}

import { renderPublicHtml } from "@/lib/public-kb-render"
import { cn } from "@/lib/utils"
import type { RichTextBlock } from "@/lib/portal/schema"

// Free-form prose block. The stored HTML is re-sanitized server-side through the
// shared public-kb-render denylist before it reaches the DOM. Rendered with the
// docs reading scale (`portal-docs-prose`). Not used by the default layout
// (Phase 1) but part of the registry for authored layouts.
export function RichText({
  block,
  className,
}: {
  block: RichTextBlock
  className?: string
}): React.ReactElement {
  const html = renderPublicHtml(block.html)
  return (
    <div
      className={cn("portal-docs-prose", className)}
      // Sanitized above via renderPublicHtml (jsdom + shared denylist).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

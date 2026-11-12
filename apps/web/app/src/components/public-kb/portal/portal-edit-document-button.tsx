import { Pencil } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Preview-only "Edit document" action shown beside "Copy page". It is a plain
 * link carrying `data-portal-document-ref`; the portal builder's live preview
 * intercepts the click and opens the document in its editor.
 */
export function PortalEditDocumentButton({
  documentRef,
  href,
  className,
}: {
  documentRef: string
  href?: string
  className?: string
}): React.ReactElement {
  return (
    <a
      href={href ?? `/knowledge/${encodeURIComponent(documentRef)}`}
      data-portal-document-ref={documentRef}
      aria-label="Edit document"
      title="Edit document"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <Pencil className="size-4" />
    </a>
  )
}

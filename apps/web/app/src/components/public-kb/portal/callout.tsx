import { renderPublicHtml } from "@/lib/public-kb-render"
import { cn } from "@/lib/utils"
import type { CalloutBlock, CalloutTone, PortalIconName } from "@/lib/portal/schema"
import { PortalIcon } from "./portal-icon"

// Admonition block (info / warn / success / danger). Server component: the HTML
// body is re-sanitized through the shared public-kb-render denylist before it
// reaches the DOM (same contract as the rich-text block). Tone selects the
// accent color + leading icon; everything is data-driven from the validated
// layout, so there is no untrusted className/icon path.

const TONE: Record<
  CalloutTone,
  {
    icon: PortalIconName
    container: string
    iconColor: string
    titleColor: string
  }
> = {
  info: {
    icon: "info",
    container: "border-sky-500/30 bg-sky-500/5",
    iconColor: "text-sky-600 dark:text-sky-400",
    titleColor: "text-sky-900 dark:text-sky-200",
  },
  warn: {
    icon: "triangle-alert",
    container: "border-amber-500/30 bg-amber-500/5",
    iconColor: "text-amber-600 dark:text-amber-400",
    titleColor: "text-amber-900 dark:text-amber-200",
  },
  success: {
    icon: "circle-check",
    container: "border-emerald-500/30 bg-emerald-500/5",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    titleColor: "text-emerald-900 dark:text-emerald-200",
  },
  danger: {
    icon: "octagon-alert",
    container: "border-red-500/30 bg-red-500/5",
    iconColor: "text-red-600 dark:text-red-400",
    titleColor: "text-red-900 dark:text-red-200",
  },
}

export function Callout({
  block,
  className,
}: {
  block: CalloutBlock
  className?: string
}): React.ReactElement {
  const tone = TONE[block.tone]
  const html = renderPublicHtml(block.body)

  return (
    <aside
      className={cn(
        "flex gap-3 rounded-lg border border-l-[3px] px-4 py-3.5",
        tone.container,
        className,
      )}
    >
      <PortalIcon name={tone.icon} className={cn("mt-0.5 size-5 shrink-0", tone.iconColor)} />
      <div className="min-w-0 flex-1">
        {block.title && (
          <p className={cn("mb-1 text-sm font-semibold", tone.titleColor)}>{block.title}</p>
        )}
        <div
          className="portal-docs-prose portal-docs-prose--tight text-sm"
          // Sanitized above via renderPublicHtml (jsdom + shared denylist).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </aside>
  )
}

import { cn } from "@/lib/utils"
import type { HeroBlock, PortalTheme } from "@/lib/portal/schema"

// Page hero: optional accent eyebrow, large heading, one-line subtitle. Accent
// reads the --portal-accent CSS variable set on the portal root.
//
// `variant="docs"` uses the compact reading scale of the documentation
// surface (the sidebar layout); unset is the roomier sidebar-less scale.
export function Hero({
  block,
  font,
  variant,
}: {
  block: HeroBlock
  font: PortalTheme["font"]
  variant?: "docs"
}): React.ReactElement {
  return (
    <section className="max-w-3xl">
      {block.eyebrow && (
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "var(--portal-accent)" }}
        >
          {block.eyebrow}
        </p>
      )}
      <h1
        className={cn(
          block.eyebrow ? "mt-3" : "mt-0",
          variant === "docs"
            ? "break-words text-[34px] font-bold leading-[1.1] tracking-normal text-foreground"
            : "text-3xl font-semibold leading-tight tracking-normal text-foreground sm:text-4xl",
          font === "serif" && "font-serif",
        )}
      >
        {block.heading}
      </h1>
      {block.subtitle && (
        <p
          className={cn(
            "mt-3 max-w-2xl text-base text-muted-foreground",
            variant === "docs" ? "leading-7" : "leading-7 sm:text-lg",
          )}
        >
          {block.subtitle}
        </p>
      )}
    </section>
  )
}

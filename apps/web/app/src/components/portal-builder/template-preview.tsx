import type { ReactElement } from "react"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Lightweight CSS mockup of the docs portal layout — a stylized miniature (no
// real render, no iframe) so the New Project card conveys what the layout looks
// like. Mirrors src/lib/portal/build-default.ts in spirit: sidebar rail + hero +
// body lines + category grid.
// ---------------------------------------------------------------------------

const line = "rounded-full bg-foreground/10"

export function DocsPreviewThumb({
  className,
}: {
  className?: string
}): ReactElement {
  return (
    <div
      className={cn(
        "aspect-[16/10] w-full overflow-hidden rounded-md border border-border bg-background p-1.5",
        className,
      )}
      aria-hidden
    >
      <div className="flex h-full gap-1.5">
        <div className="flex w-1/4 flex-col gap-1 rounded-sm bg-muted/60 p-1">
          <div className={cn(line, "h-1 w-3/4")} />
          <div className={cn(line, "h-1 w-full")} />
          <div className={cn(line, "h-1 w-2/3")} />
          <div className={cn(line, "h-1 w-3/4")} />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="h-1/3 rounded-sm bg-primary/15" />
          <div className={cn(line, "h-1 w-1/2")} />
          <div className={cn(line, "h-1 w-full")} />
          <div className={cn(line, "h-1 w-5/6")} />
          <div className="mt-auto grid grid-cols-3 gap-1">
            <div className="h-3 rounded-sm bg-muted" />
            <div className="h-3 rounded-sm bg-muted" />
            <div className="h-3 rounded-sm bg-muted" />
          </div>
        </div>
      </div>
    </div>
  )
}

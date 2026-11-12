import { cn } from "@/lib/utils"

// `skeleton-pulse` (index.css) keeps the placeholder invisible for its first
// 200ms, so loads that finish quickly never flash a skeleton.

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      aria-hidden
      className={cn("skeleton-pulse rounded-md bg-muted/60", className)}
      {...props}
    />
  )
}

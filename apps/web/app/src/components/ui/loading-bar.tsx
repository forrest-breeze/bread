import { cn } from "@/lib/utils"

interface LoadingBarProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string
  value?: number | null
}

export function LoadingBar({
  className,
  label,
  value = null,
  ...props
}: LoadingBarProps): React.JSX.Element {
  const normalizedValue =
    value === null ? null : Math.min(100, Math.max(0, value))

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalizedValue ?? undefined}
      className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300",
          normalizedValue === null && "loading-bar-indeterminate w-2/3",
        )}
        style={normalizedValue === null ? undefined : { width: `${normalizedValue}%` }}
      />
    </div>
  )
}

import { Skeleton } from "@/components/ui/skeleton"

export default function DocumentLoading(): React.ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-background/95">
        <div className="flex items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="size-8 rounded-full" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10 space-y-4">
          <Skeleton className="h-10 w-3/4" />
          <div className="pt-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-9/12" />
            <Skeleton className="h-4 w-11/12" />
          </div>
        </div>
      </div>
    </div>
  )
}

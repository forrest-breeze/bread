import { Skeleton } from "@/components/ui/skeleton"

// Fallback for the Knowledge content area only. The navigation around it (app
// sidebar, document tree, builder rail) lives in layouts that stay mounted
// across navigations, so it is never redrawn as a placeholder here.
export default function KnowledgeLoading(): React.ReactElement {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <article className="mx-auto w-full max-w-3xl space-y-4 px-10 py-10">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-3/4" />
        <div className="space-y-3 pt-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-9/12" />
        </div>
      </article>
    </section>
  )
}

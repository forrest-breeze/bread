import { Skeleton } from "@/components/ui/skeleton"

export default function KnowledgeLoading(): React.ReactElement {
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/60 bg-muted/10">
        <div className="flex items-center gap-2 px-4 py-3">
          <Skeleton className="size-3.5" />
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="h-px w-full bg-border/60" />
        <div className="flex flex-col gap-1 p-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex flex-col gap-1.5 px-1 py-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-28" />
            </div>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <article className="mx-auto w-full max-w-3xl px-10 py-10 space-y-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-3/4" />
          <div className="pt-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-9/12" />
          </div>
        </article>
      </section>
    </div>
  )
}

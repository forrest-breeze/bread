import { Skeleton } from "@/components/ui/skeleton";

// Immediate fallback for navigation between top-level app sections. It renders
// inside the persistent sidebar shell, so clicks always get visual feedback
// while the destination route streams in.
export default function AppLoading(): React.ReactElement {
  return (
    <div
      aria-label="Loading page"
      aria-busy="true"
      className="mx-auto w-full max-w-6xl space-y-6 p-6 pt-16 lg:p-8 lg:pt-20"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72 max-w-[70vw]" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="space-y-3 rounded-xl border border-border bg-card p-5"
          >
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}

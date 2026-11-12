import { Skeleton } from "@/components/ui/skeleton"

export default function PortalEditorLoading(): React.ReactElement {
  return (
    <div className="flex h-full min-h-[calc(100svh-3.5rem)] flex-col lg:min-h-screen">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="w-full shrink-0 border-b border-border p-4 lg:w-[380px] lg:border-b-0 lg:border-r">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="mt-4 h-64 w-full rounded-xl" />
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-full min-h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}

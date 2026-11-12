import { Skeleton } from "@/components/ui/skeleton";

// Settings pages share the same form/card language, so keep this fallback
// stable while moving between profile, workspace, billing, and integrations.
export default function SettingsLoading(): React.ReactElement {
  return (
    <div
      aria-label="Loading settings"
      aria-busy="true"
      className="space-y-6 p-6 lg:p-8"
    >
      <div className="space-y-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-4 w-64 max-w-[70vw]" />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="space-y-2 border-b border-border p-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="space-y-6 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((field) => (
              <div key={field} className="space-y-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
    </div>
  );
}

import { Skeleton } from "@/components/ui/skeleton"

// PortalShell resolves the active page presentation before
// this route segment streams. Every scaffold is present, and the shell's stable
// data-portal-surface attribute selects the one matching the requested view.
const NAV_GROUPS = [
  { label: "w-24", items: ["w-40", "w-32", "w-36", "w-28"] },
  { label: "w-20", items: ["w-36", "w-40", "w-24"] },
]
const LEAD_LINES = ["h-4 w-full", "h-4 w-full", "h-4 w-11/12", "h-4 w-full", "h-4 w-4/5"]
const BODY_LINES = ["h-4 w-full", "h-4 w-10/12", "h-4 w-full", "h-4 w-3/4"]
const CHANGELOG_ENTRY_LINES = [
  "h-4 w-full",
  "h-4 w-full",
  "h-4 w-11/12",
  "h-4 w-4/5",
]

export default function PublicKbLoading(): React.ReactElement {
  return (
    <>
      <style>{`
        .portal-changelog-feed-loading,
        .portal-changelog-entry-loading { display: none; }
        [data-portal-surface="changelog-feed"] .portal-default-loading,
        [data-portal-surface="changelog-entry"] .portal-default-loading { display: none; }
        [data-portal-surface="changelog-feed"] .portal-changelog-feed-loading,
        [data-portal-surface="changelog-entry"] .portal-changelog-entry-loading { display: block; }
      `}</style>
      <div className="portal-default-loading min-h-[calc(100vh-4rem)] w-full lg:grid lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border/70 bg-muted/15 px-6 py-8 lg:sticky lg:top-16 lg:block lg:h-[calc(100dvh-4rem)] lg:self-start lg:overflow-hidden">
          <div className="space-y-7">
            {NAV_GROUPS.map((group, g) => (
              <div key={`grp-${g}`} className="space-y-3">
                <Skeleton className={`h-3 ${group.label}`} />
                <div className="space-y-2.5 pl-1">
                  {group.items.map((w, i) => (
                    <Skeleton key={`it-${g}-${i}`} className={`h-3.5 ${w}`} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <div className="w-full px-6 py-12 sm:px-10 lg:px-12 lg:py-14">
          <div className="mx-auto w-full max-w-[680px]">
            {/* eyebrow → title → subtitle, matching a docs page header */}
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-4 h-9 w-3/4" />
            <Skeleton className="mt-3 h-4 w-full max-w-[540px]" />

            <div className="mt-10 space-y-3">
              {LEAD_LINES.map((c, i) => (
                <Skeleton key={`lead-${i}`} className={c} />
              ))}
            </div>

            {/* a code/callout block, then a second paragraph */}
            <Skeleton className="mt-9 h-40 w-full rounded-xl" />
            <div className="mt-9 space-y-3">
              {BODY_LINES.map((c, i) => (
                <Skeleton key={`body-${i}`} className={c} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="portal-changelog-feed-loading min-h-[calc(100vh-4rem)] w-full">
        <div className="mx-auto w-full max-w-[1180px] px-6 py-14 sm:px-10 lg:px-16 lg:py-24">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-11 w-full max-w-[430px]" />
          <div className="mt-5 space-y-2">
            <Skeleton className="h-4 w-full max-w-[600px]" />
            <Skeleton className="h-4 w-full max-w-[460px]" />
          </div>

          <div className="mt-16 border-t border-border/70">
            {[0, 1, 2].map((group) => (
              <div
                key={group}
                className="grid gap-5 border-b border-border/70 py-9 md:grid-cols-[8rem_minmax(0,1fr)] md:gap-10"
              >
                <Skeleton className="h-3 w-20" />
                <div className="space-y-8">
                  {[0, 1].map((entry) => (
                    <div
                      key={entry}
                      className="grid gap-3 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-6"
                    >
                      <Skeleton className="h-3 w-14" />
                      <div>
                        <Skeleton className="h-6 w-full max-w-[520px]" />
                        <Skeleton className="mt-3 h-3.5 w-full max-w-[640px]" />
                        <Skeleton className="mt-2 h-3.5 w-4/5 max-w-[520px]" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="portal-changelog-entry-loading min-h-[calc(100vh-4rem)] w-full">
        <article className="mx-auto w-full max-w-[62rem] px-6 py-12 sm:px-8 lg:py-16">
          <div className="flex items-center gap-2">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3.5 w-28" />
          </div>

          <div className="mt-8 lg:grid lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:gap-12">
            <Skeleton className="h-3 w-28" />
            <div className="mt-5 min-w-0 lg:mt-0">
              <Skeleton className="h-9 w-full max-w-[580px]" />
              <div className="mt-9 space-y-3">
                {CHANGELOG_ENTRY_LINES.map((className, index) => (
                  <Skeleton key={index} className={className} />
                ))}
              </div>
              <Skeleton className="mt-9 h-36 w-full rounded-xl" />
              <div className="mt-9 space-y-3">
                {BODY_LINES.map((className, index) => (
                  <Skeleton key={index} className={className} />
                ))}
              </div>

              <div className="mt-16 grid gap-3 border-t border-border/70 pt-6 sm:grid-cols-2">
                {[0, 1].map((index) => (
                  <div
                    key={index}
                    className="space-y-2 rounded-xl border border-border px-4 py-3"
                  >
                    <Skeleton className="h-2.5 w-14" />
                    <Skeleton className="h-3.5 w-4/5" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </article>
      </div>
    </>
  )
}

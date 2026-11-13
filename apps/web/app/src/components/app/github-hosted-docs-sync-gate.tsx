"use client"

import { GitMerge } from "lucide-react"
import { useGithubHostedDocs } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { LoadingBar } from "@/components/ui/loading-bar"

interface GithubHostedDocsSyncGateProps {
  children: React.ReactNode
}

/**
 * Keep both workspace editors unmounted while GitHub is changing their shared
 * document tree. Unmounting is intentional: it prevents autosave and portal
 * draft mutations from racing the repository reconciliation.
 *
 * The lock engages only on a *known* in-flight sync (`pending` / `syncing`).
 * The status check itself runs in the background: SWR revalidates on every
 * mount, and the layouts that host this gate remount on each route switch, so
 * blocking on `isLoading` / `isValidating` would replace the page with a
 * "checking" card every time the user moves between Knowledge and the portal
 * editor. The cached status (persisted by the SWR provider) is trusted until
 * the refresh lands; the gate closes on the next render if it reports a sync.
 *
 * The status is applied post-hydration only. The server never has SWR data, so
 * branching on cached data before hydration would mismatch the server tree.
 */
export function GithubHostedDocsSyncGate({
  children,
}: GithubHostedDocsSyncGateProps): React.ReactElement {
  const hydrated = useHasHydrated()
  const { data, error } = useGithubHostedDocs()
  const source = data?.source ?? null
  const syncing =
    source?.sync_status === "pending" || source?.sync_status === "syncing"

  if (hydrated && !error && syncing) {
    // "." is how a ReadMe-format link records the repository root.
    const storedRoot = source?.paths?.[0]
    const root = storedRoot === "." ? "" : storedRoot

    return (
      <div
        className="flex h-full min-h-[calc(100svh-3.5rem)] items-center justify-center bg-background px-6 lg:min-h-screen"
        role="status"
        aria-live="polite"
      >
        <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <GitMerge className="size-5 text-muted-foreground" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">
            Syncing Breezify docs from GitHub
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Knowledge and portal editing are temporarily locked so local edits
            cannot race the repository reconciliation.
          </p>
          {source && storedRoot ? (
            <p className="mt-4 truncate rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground">
              {source.repo_full_name}
              {root ? `/${root}` : ""}
            </p>
          ) : null}
          <LoadingBar
            label="GitHub docs reconciliation progress"
            className="mt-4"
          />
          <p className="mt-3 text-xs text-muted-foreground">
            This screen unlocks automatically when the sync completes.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

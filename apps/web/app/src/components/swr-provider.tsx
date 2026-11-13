"use client"

import { useEffect, useState, useCallback } from "react"
import { type State, SWRConfig } from "swr"
import { clearAllDrafts } from "@/lib/document-draft"
import { clearStoredOpenFolderIds } from "@/lib/document-nav-preferences"

// Bumping the suffix invalidates cached entries from previous app versions
// (e.g. when payload shapes change). Keep in sync when breaking cache-shape
// changes land.
const CACHE_KEY = "breezify-swr-cache:v3"

// The user id the persisted cache belongs to. The cache keys (e.g. "/api/profile")
// are not user-scoped, so without this stamp a different user logging into the
// same browser would restore the previous user's data. On mount we compare this
// to the authenticated user and purge if they differ. See cross-user-cache-leak.
const CACHE_OWNER_KEY = "breezify-swr-cache-owner"

// Keys containing ephemeral session data that shouldn't be persisted across
// browser sessions. Everything else — including documents, folders, topics,
// dashboard stats, and ingestion logs — is persisted so returning users see
// instant paints and real-time Supabase subscriptions refresh the cache in
// the background (stale-while-revalidate).
//
// Integration-status keys are deliberately excluded. Connecting an integration
// is a top-level OAuth redirect that returns via a full page reload, so the
// persisted "not connected" entry ({ integration: null }) would be restored as
// an instant paint. Because cached data exists, isLoading is false, so the
// sidebar badge and detail page render "not connected" until the background
// revalidation lands ~2s later. Excluding these keys means a post-connect load
// starts with isLoading=true (skeleton) and fetches fresh — no stale flash.
// This also fixes a stale "on" badge lingering after a disconnect on another
// device, since connection state is no longer mirrored to localStorage.
const EXCLUDED_CACHE_PREFIXES = [
  "/api/conversations",
  "/api/auth",
  "/api/github/integrations",
]

function shouldPersistKey(key: string): boolean {
  if (typeof key !== "string") return false
  return !EXCLUDED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
}

// Whether an SWR cache entry is worth persisting as an instant paint on the
// next load. A transient empty/error result must never be mirrored to
// localStorage: it would be restored on every subsequent load and replayed as
// real state. This is exactly how the workspace switcher got stuck on "No
// workspaces" — a single empty /api/workspaces response (RLS returning 0 rows
// during a Supabase token refresh) was persisted and shown indefinitely. Only
// successful, non-empty data is durable.
function shouldPersistEntry(entry: State<unknown, unknown>): boolean {
  if (entry.error !== undefined) return false
  if (entry.data === undefined) return false
  if (Array.isArray(entry.data) && entry.data.length === 0) return false
  return true
}

type SWRCacheMap = Map<string, State<unknown, unknown>>
type SWRCacheProvider = () => SWRCacheMap

// Module-level ref so flush() can access the map without reading a React ref during render.
let activeMap: SWRCacheMap | null = null

/**
 * Wipe every piece of user-scoped client state that outlives a session: the
 * SWR cache (in-memory + localStorage mirror), the cache-owner stamp, the
 * active-workspace cookie, locally-stored document drafts, and the open-folder
 * set. None of these are keyed by user id, so any of them surviving into a
 * different user's session on the same browser is a cross-user data leak.
 *
 * `broadcast` controls the cross-tab signal. The same-tab caller (logout, or
 * the owner-mismatch check on mount) broadcasts so sibling tabs holding the
 * previous user's state clear too. Tabs reacting to that signal pass `false`
 * to avoid a re-broadcast ping-pong.
 */
function purgeUserScopedClientState(broadcast: boolean): void {
  if (activeMap) {
    activeMap.clear()
  }
  try {
    localStorage.removeItem(CACHE_KEY)
    localStorage.removeItem(CACHE_OWNER_KEY)
  } catch {
    // Storage unavailable — in-memory clear still applies.
  }
  clearAllDrafts()
  clearStoredOpenFolderIds()
  if (typeof document !== "undefined") {
    // Drop the active-workspace cookie so the next user falls back to their own
    // first membership instead of a workspace id they may not belong to.
    document.cookie = "breezify-workspace=; path=/; max-age=0; samesite=lax"
  }
  if (broadcast) {
    try {
      // Storage events only fire in *other* tabs, so this wakes up any sibling
      // tabs that might be holding the previous user's cache.
      localStorage.setItem("breezify-signout", String(Date.now()))
      localStorage.removeItem("breezify-signout")
    } catch {
      // Storage unavailable.
    }
  }
}

/**
 * Clear the previous user's cached state. Call this during logout (in the same
 * tab that initiates sign-out) so the next user does not see cached data from
 * the previous session. Sibling tabs are cleared via the broadcast signal.
 */
export function clearBreezifySwrCache(): void {
  purgeUserScopedClientState(true)
}

/**
 * Drop only THIS tab's in-memory SWR cache. Used on the cross-tab sign-out
 * signal: the tab that initiated the purge has already cleared the shared
 * localStorage cache, owner stamp, drafts, and the active-workspace cookie. A
 * sibling tab must NOT re-clear those origin-wide values — in a multi-tab
 * account switch the newly logged-in tab has already written a fresh
 * `breezify-workspace` cookie, and deleting it here would silently drop the
 * sibling's subsequent requests back to the user's first-membership workspace.
 */
function clearInMemorySwrCache(): void {
  if (activeMap) activeMap.clear()
}

/**
 * Restore the persisted SWR cache for `userId`. Client-only (returns an empty
 * list during SSR) and strictly read-only — localStorage *writes* (the owner
 * stamp, the cross-user purge) stay in the mount effect. A cache owned by a
 * different (or unknown) user is never restored; the effect purges it.
 */
function restoreCacheEntries(
  userId: string
): [string, State<unknown, unknown>][] {
  if (typeof window === "undefined") return []
  try {
    const owner = localStorage.getItem(CACHE_OWNER_KEY)
    if (owner !== userId) return []
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "[]") as [
      string,
      State<unknown, unknown>,
    ][]
  } catch {
    // Corrupt cache or storage unavailable — start fresh
    return []
  }
}

export function SWRProvider({
  children,
  userId,
}: {
  children: React.ReactNode
  /** The authenticated user this session belongs to, from the server layout. */
  userId: string
}) {
  // ONE cache instance for the lifetime of the provider, created before any
  // hook runs so every revalidation writes into THIS map.
  //
  // Do NOT re-introduce a deferred provider swap (useState(undefined) +
  // setProvider in an effect). Hooks mount first and start fetching into
  // SWR's default cache; the later swap pins a NEW cache (SWR initializes its
  // cache provider exactly once and ignores subsequent changes), and the
  // in-flight results land in the orphaned default map. Any key without a
  // persisted localStorage entry is then stuck with data=undefined and a
  // derived isLoading=true that no revalidation will ever resolve — the
  // sidebar workspace skeleton hung forever exactly this way.
  //
  // CAUTION: synchronous seeding is NOT hydration-safe on its own. Restored
  // entries are visible to hooks on the first client render, so any component
  // that branches its markup on data presence (skeleton vs content) renders a
  // different tree than the server (which had no localStorage) and throws a
  // hydration mismatch. Components with such branches must hold the
  // server-shaped render until useHasHydrated() flips true.
  const [provider] = useState<SWRCacheProvider>(() => {
    const map: SWRCacheMap = new Map(restoreCacheEntries(userId))
    activeMap = map
    return () => map
  })

  const flush = useCallback(() => {
    if (!activeMap) return
    try {
      const entries = Array.from(activeMap.entries()).filter(
        ([key, entry]) => shouldPersistKey(key) && shouldPersistEntry(entry)
      )
      localStorage.setItem(CACHE_KEY, JSON.stringify(entries))
    } catch {
      // Storage full or unavailable — silent fail
    }
  }, [])

  useEffect(() => {
    // Cross-user safety: stamp ownership and purge any state a different user
    // left behind. `restoreCacheEntries` already refused to restore a
    // mismatched user's entries (it is read-only); the writes happen here,
    // after hydration. Covers every path that bypasses the logout buttons:
    // session expiry, direct re-login at /login, or swapping accounts without
    // signing out.
    try {
      const owner = localStorage.getItem(CACHE_OWNER_KEY)
      if (owner !== userId) {
        purgeUserScopedClientState(true)
      }
      localStorage.setItem(CACHE_OWNER_KEY, userId)
    } catch {
      // Storage unavailable — nothing to purge or stamp.
    }

    // Cross-tab sign-out: if another tab purges (logout or user switch), drop
    // this tab's in-memory cache so it stops serving the prior user's data. The
    // initiating tab already cleared the shared localStorage + cookie, so we do
    // NOT touch those here — re-deleting the workspace cookie would clobber a
    // workspace the newly logged-in tab just selected.
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === "breezify-signout") {
        clearInMemorySwrCache()
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") flush()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", flush)
    window.addEventListener("storage", handleStorage)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", flush)
      window.removeEventListener("storage", handleStorage)
    }
  }, [flush, userId])

  return (
    <SWRConfig
      value={{
        provider,
        keepPreviousData: true,
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        revalidateIfStale: true,
        dedupingInterval: 2_000,
      }}
    >
      {children}
    </SWRConfig>
  )
}

import { useSyncExternalStore } from "react"

function subscribeToHydrationStore(): () => void {
  return () => undefined
}

function getHydratedSnapshot(): boolean {
  return true
}

function getServerHydrationSnapshot(): boolean {
  return false
}

/**
 * Returns `false` during SSR and the first client render, then `true` for every
 * render after hydration completes — without a setState-in-effect, so the first
 * client render is byte-identical to the server's.
 *
 * Use this to gate DOM-shape branches that depend on client-only state. The SWR
 * cache is seeded synchronously from localStorage (see swr-provider), so hooks
 * like useProfile()/useWorkspace() can return data on the first client render
 * while the server (no localStorage) rendered a skeleton. Branching the markup
 * (skeleton <div> vs trigger <button>) on that mismatch throws a hydration
 * error. Holding the server-shaped render until `useHasHydrated()` flips to true
 * keeps the trees aligned, then reveals live state on the next render.
 */
export function useHasHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToHydrationStore,
    getHydratedSnapshot,
    getServerHydrationSnapshot,
  )
}

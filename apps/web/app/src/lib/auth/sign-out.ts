import { createClient } from "@/lib/supabase/client";
import { clearBreezifySwrCache } from "@/components/swr-provider";

/**
 * Sign the current browser out and land on /login.
 *
 * Uses `scope: "local"`, which clears the local session + auth cookies
 * synchronously with NO network call. The supabase-js default
 * (`scope: "global"`) instead POSTs a revoke to GoTrue's `/logout` endpoint —
 * which on this project is the known saturation point (see get-auth-user.ts).
 * When that revoke stalls or errors, supabase-js can skip removing the local
 * cookies, and because every auth gate verifies the access-token JWT *locally*
 * via `getClaims()` (no server-side revocation check), the user stays
 * effectively logged in until the token expires (~1h). Clearing locally makes
 * logout deterministic regardless of auth-server health.
 *
 * The local clear above covers the common case instantly, but a token refresh
 * already in flight (a Next prefetch / SWR revalidation the proxy services with
 * a fresh `Set-Cookie`) can resurrect the auth cookie right after we delete it.
 * So the final navigation goes to the server signout route, whose response
 * deletes the cookie authoritatively for this request — immune to that race.
 * It is a full-page navigation (not `router.push`) so the cleared cookies
 * actually reach the next request.
 */
export async function signOutAndRedirect(): Promise<void> {
  const supabase = createClient();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Local sign-out must not hinge on the network — clear and leave regardless.
  }
  clearBreezifySwrCache();
  window.location.href = "/api/auth/signout";
}

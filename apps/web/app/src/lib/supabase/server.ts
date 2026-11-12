import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions } from "./cookie-options";
import { fetchWithTimeout } from "./fetch-with-timeout";
import { createSessionRefreshLock, sessionLockKey } from "./process-lock";
import { supabasePublishableKey, supabaseUrl } from "./env";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    supabaseUrl()!,
    supabasePublishableKey()!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method is called from a Server Component.
            // This can be ignored if you have a proxy refreshing sessions.
          }
        },
      },
      // Serialize token refreshes per session within this process. Without it,
      // parallel API requests against an expired access token each refresh the
      // same refresh token concurrently and GoTrue 409s the lot, surfacing as
      // 401s. See process-lock.ts.
      auth: {
        lock: createSessionRefreshLock(sessionLockKey(cookieStore.getAll())),
      },
      // Abort any auth/REST call at the socket after 15s so a black-holed
      // request can never hold the session lock forever. See
      // fetch-with-timeout.ts for the full failure mode.
      global: {
        fetch: fetchWithTimeout,
      },
      ...authCookieOptions(),
    }
  );
}

import { NextResponse } from "next/server";
import { isTransientAuthFailure } from "./transient-failure";
import { DOMAIN_NOT_ALLOWED_MESSAGE, isAllowedEmail } from "./allowed-email";
import type { createClient } from "@/lib/supabase/server";
import { TimeoutError, withTimeout } from "@/lib/utils";

/**
 * Most ES256 claim checks are local and finish in milliseconds. The first JWKS
 * lookup in a cold function, or a token refresh near expiry, can take longer.
 *
 * Keep the original 3s fast-path budget, then give the SAME in-flight promise
 * another 5s to settle. Starting a second `getClaims()` here is actively
 * harmful: it can start a duplicate refresh or queue behind the first call's
 * session lock. The 8s total budget remains bounded and fail-closed.
 */
const AUTH_FAST_TIMEOUT_MS = 3000;
const AUTH_GRACE_TIMEOUT_MS = 5000;

async function getClaimsWithGrace(
  supabase: Awaited<ReturnType<typeof createClient>>
): ReturnType<typeof supabase.auth.getClaims> {
  const pendingClaims = supabase.auth.getClaims();

  try {
    return await withTimeout(pendingClaims, AUTH_FAST_TIMEOUT_MS);
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;

    // Reuse the original request. Supabase's auth lock may still be refreshing
    // this session, and a second call would only add contention.
    return await withTimeout(pendingClaims, AUTH_GRACE_TIMEOUT_MS);
  }
}

/**
 * The authenticated caller of an API route, decoded from verified JWT claims.
 * Only the fields routes actually consume — this is intentionally NOT the full
 * GoTrue `User` object, because producing that requires a network round-trip
 * to `/user` on every request.
 */
export interface RouteUser {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
}

export type RouteAuthResult =
  | { user: RouteUser; response: null }
  // Typed to the `{ error }` body shape so `return authResponse` stays
  // assignable in routes that declare a narrowed NextResponse<...> union.
  | { user: null; response: NextResponse<{ error: string }> };

/**
 * Authenticates an API route request by verifying the session JWT locally via
 * `supabase.auth.getClaims()` — no `/user` round-trip to the auth server.
 *
 * Replaces the previous per-route `supabase.auth.getUser()` gate, which made
 * every API request a network call to GoTrue. Under load that endpoint
 * saturates and stalls, and because the routes awaited it without a timeout,
 * a single stall hung the route (and every client loader waiting on it)
 * indefinitely.
 *
 * Usage:
 * ```ts
 * const { user, response } = await requireRouteUser(supabase);
 * if (!user) return response;
 * ```
 *
 * - No / invalid session → 401 (definitive answer).
 * - Valid session for a non-Breeze email → 403.
 * - Timeout or transient auth-server failure → 503 (retryable, NOT "logged out").
 */
export async function requireRouteUser(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<RouteAuthResult> {
  try {
    const { data, error } = await getClaimsWithGrace(supabase);

    if (error && isTransientAuthFailure(error)) {
      throw error;
    }

    const claims = data?.claims;
    if (error || !claims?.sub) {
      return {
        user: null,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }

    // Breeze internal tool: a valid session is not enough, the account must
    // also be a Breeze one. See allowed-email.ts.
    if (!isAllowedEmail(claims.email)) {
      return {
        user: null,
        response: NextResponse.json({ error: DOMAIN_NOT_ALLOWED_MESSAGE }, { status: 403 }),
      };
    }

    return {
      user: {
        id: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        user_metadata:
          (claims.user_metadata as Record<string, unknown> | undefined) ?? {},
      },
      response: null,
    };
  } catch (err) {
    console.warn("[Breezify] route auth check failed transiently:", err);
    return {
      user: null,
      response: NextResponse.json(
        { error: "Auth check unavailable, please retry" },
        { status: 503, headers: { "Retry-After": "2", "Cache-Control": "no-store" } }
      ),
    };
  }
}

import { cache } from "react";
import { isTransientAuthFailure } from "./transient-failure";
import { isAllowedEmail } from "./allowed-email";
import { createClient } from "@/lib/supabase/server";
import { TimeoutError, withTimeout } from "@/lib/utils";

/**
 * The authenticated user for a server render, decoded from locally-verified
 * JWT claims. Deliberately NOT the full GoTrue `User`: producing that requires
 * a network round-trip to the auth server's `/user` endpoint, which is the
 * saturation point this module exists to protect against. All current
 * consumers only read `id`.
 */
export interface AuthUser {
  id: string;
  email?: string;
}

/**
 * Max time to wait for the auth server during a server render. Kept well under
 * the hosting platform's function execution limit so a stalled auth call fails
 * fast as a *catchable* throw (→ `error.tsx`) instead of hanging until the
 * platform kills the function and serves its own uncatchable crash page.
 */
const AUTH_TIMEOUT_MS = 3000;

/**
 * Retry a settled transient failure once. A slow check gets a second 3s wait
 * on the same promise; an exhausted timeout never starts a duplicate refresh.
 * Worst case is two 6s attempts plus backoff when the first settles in grace.
 */
const AUTH_MAX_ATTEMPTS = 2;
const AUTH_RETRY_DELAY_MS = 150;

/**
 * Raised when the auth check fails for a *transient* reason (timeout, dropped
 * connection, 5xx from GoTrue). Callers must let this propagate to an error
 * boundary — never treat it as "logged out", or a momentary backend blip would
 * bounce a signed-in user to `/login`.
 */
export class AuthCheckError extends Error {
  constructor(cause: unknown) {
    super("Auth check failed transiently");
    this.name = "AuthCheckError";
    this.cause = cause;
  }
}

/**
 * Request-scoped, memoized auth check for SERVER RENDERS (layouts, pages,
 * server components). A single page navigation renders the layout chain + page
 * in one request, and each previously validated the session independently.
 * `cache()` collapses those into ONE check for the duration of that single
 * request.
 *
 * SECURITY: this is safe specifically because the memoization is request-scoped.
 * `react`'s `cache()` is isolated per server request (never shared across
 * requests/users), and the Supabase client is constructed per-request from the
 * incoming cookies — so the validated user is always the one who owns *this*
 * request's token. The result is still a real cryptographic JWT validation
 * (`getClaims` verifies the signature against the project's JWKS — not a bare
 * `getSession` cookie read), just not repeated within the same render.
 *
 * DO NOT replace `cache()` with a module-level variable, a global Map, or
 * Next's `unstable_cache` — any cross-request store would risk serving one
 * user's identity to another user's request. API routes have their own
 * equivalent gate: `requireRouteUser` in `@/lib/auth/route-auth`.
 */
/** One validation attempt: returns the user/null, or throws on failure. */
async function attemptGetUser(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<AuthUser | null> {
  try {
    // getClaims() verifies the session JWT locally against the project's
    // asymmetric signing key (cached JWKS) — no /user round-trip. The network
    // only appears on the rare slow paths (first JWKS fetch per process, or a
    // token refresh), which is exactly what this timeout + retry shell guards.
    const pendingClaims = supabase.auth.getClaims();
    let result;
    try {
      result = await withTimeout(pendingClaims, AUTH_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      // Wait for the same refresh; starting another check adds lock contention.
      result = await withTimeout(pendingClaims, AUTH_TIMEOUT_MS);
    }
    const { data, error } = result;
    // A returned `error` that is transient (5xx/network) must not read as
    // "logged out"; a definitive 4xx / session-missing means no valid session.
    if (error) {
      if (isTransientAuthFailure(error)) throw new AuthCheckError(error);
      return null;
    }
    const claims = data?.claims;
    if (!claims?.sub) return null;
    // Breeze internal tool: non-Breeze sessions count as signed out. The proxy
    // clears them and sends the visitor to /login?error=domain.
    if (!isAllowedEmail(claims.email)) return null;
    return {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
    };
  } catch (err) {
    if (err instanceof AuthCheckError) throw err;
    if (isTransientAuthFailure(err)) throw new AuthCheckError(err);
    // A non-transient, non-Auth throw is genuinely unexpected — let it bubble.
    throw err;
  }
}

export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptGetUser(supabase);
    } catch (err) {
      // Only transient failures are worth retrying; anything else bubbles now.
      if (!(err instanceof AuthCheckError)) throw err;
      // A timed-out promise is still running. Never enqueue a second refresh.
      if (err.cause instanceof TimeoutError) throw err;
      lastErr = err;
      if (attempt < AUTH_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, AUTH_RETRY_DELAY_MS)
        );
      }
    }
  }
  throw lastErr;
});
